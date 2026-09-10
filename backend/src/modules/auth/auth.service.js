'use strict';

/**
 * Authentication domain logic — SRS §7 (FR-AUTH-001 … FR-AUTH-007).
 *
 * The controller above this file does HTTP: it reads `req`, calls one function here, and hands the
 * result to `ApiResponse`. Everything that decides *what happens* lives here, so the rules are
 * readable in one place and testable without a request.
 *
 * ## What the failure messages deliberately do not say
 *
 * Four endpoints in this module can be probed for whether an account exists, and each one answers in
 * a way that gives nothing away:
 *
 *   login             One code, `INVALID_CREDENTIALS`, for an unknown identifier and for a wrong
 *                     password alike — and a bcrypt comparison against a fixed dummy hash in the
 *                     unknown case, because at 12 rounds the difference between "returned in 2 ms"
 *                     and "returned in 250 ms" is a perfectly readable existence oracle without it.
 *   forgot-password   Always 202, whether or not the address is on file. This is the endpoint an
 *                     attacker would point a list of addresses at, so it is the one that matters
 *                     most.
 *   reset-password    One code for an unknown token, a used token and an expired one.
 *   verify-email      The same.
 *
 * Account *status* is the exception, and only after the password has been proven: FR-AUTH-007 wants
 * an account that is suspended or awaiting activation to be told so, and by that point the caller
 * has demonstrated they hold the credential, so there is nothing left to conceal from them.
 *
 * ## Lockout is checked before the password, and that is a considered trade-off
 *
 * `authLimiter` bounds attempts per IP; `security.maxLoginAttempts` bounds them per account, which
 * is the axis a distributed attempt does not touch. Refusing a locked account before comparing the
 * password does mean `ACCOUNT_LOCKED` confirms the account exists — the alternative, comparing first
 * so a wrong guess and a locked account are indistinguishable, would let an attacker keep testing
 * passwords and learn which one is right from the change in response. Stopping the guessing is worth
 * more than hiding existence on this endpoint, especially as `forgot-password` — the endpoint built
 * for bulk enumeration — gives nothing.
 *
 * ## Every password change ends every other session
 *
 * Setting `password_changed_at` makes `authenticate.tokenPredatesPasswordChange()` refuse access
 * tokens minted earlier, and clearing `refresh_token_hash` kills the stored session. Both are
 * necessary: the access token check covers the ≤15 minutes an existing token has left, and clearing
 * the hash stops a refresh from minting a new one. A user who changes their password because a
 * device was stolen has done something real.
 *
 * The session doing the change is kept, by handing back a fresh pair in the same response. Signing a
 * new token in the same second as the change is exactly the case `tokenPredatesPasswordChange` is
 * written to allow.
 */

const config = require('../../config/env');
const logger = require('../../config/logger');
const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const { enqueue } = require('../../config/queue');
const permissionService = require('../../services/permissionService');
const entitlementService = require('../../services/entitlementService');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { STATUS_REFUSALS } = require('../../middlewares/authenticate');
const { LOGIN_ALLOWED_STATUSES, JOB_NAMES } = require('../../config/constants');
const {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256,
  safeEqual,
  accessTokenPayload,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require('../../utils/tokens');

/**
 * A real bcrypt hash of a value nobody can supply, compared against when the identifier is unknown.
 *
 * Generated once at require time rather than being a hard-coded constant: a literal hash in source
 * would be a fixed target, and the cost here is one bcrypt call at boot. `TIMING_DUMMY_PASSWORD` is
 * never a valid credential because no user row is ever created from it.
 */
const TIMING_DUMMY_HASH_PROMISE = hashPassword(`timing-${randomToken(16)}`);

/** Columns a client is allowed to see about itself or about the account it just authenticated as. */
const PUBLIC_USER_FIELDS = [
  'id',
  'name',
  'email',
  'username',
  'phone',
  'avatar_path',
  'status',
  'locale',
  'organization_id',
  'school_id',
  'role_id',
  'email_verified_at',
  'last_login_at',
  'must_change_password',
];

/**
 * The client-facing shape of a user.
 *
 * An explicit field list rather than `toJSON()`. `toJSON` removes the four secret columns, which
 * makes it safe, but it still emits `failed_login_attempts`, `locked_until`,
 * `refresh_token_expires_at`, `password_reset_expires_at` and the two permission-override arrays —
 * internal bookkeeping that tells a caller how the lockout works and would become part of the API's
 * contract by accident. Adding a column to `users` must not silently add a field to this response.
 *
 * @param {object} user  a User instance
 * @returns {object}
 */
function publicUser(user) {
  const values = user.get ? user.get() : user;
  const out = {};
  for (const field of PUBLIC_USER_FIELDS) {
    if (values[field] !== undefined) out[field] = values[field];
  }
  if (user.role) {
    out.role = {
      id: user.role.id,
      slug: user.role.slug,
      name: user.role.name,
      isPlatformRole: Boolean(user.role.is_platform_role),
      isSchoolRole: Boolean(user.role.is_school_role),
    };
  }
  return out;
}

/**
 * Attribution for an `activity_logs` row, in the shape `activityLog.attributionFrom()` takes.
 *
 * Three of this module's endpoints — login, reset-password and verify-email — are mounted *above* the
 * authentication boundary, so `req.user` and `req.tenant` do not exist when the activity row is
 * written and the row would otherwise carry no user id, no address and no role. Those are the three
 * columns an administrator filters on when asking what happened to an account, and a sign-in is the
 * single most-read row in the trail (SRS §26), so the handler supplies them explicitly.
 *
 * Accepts either a User instance or a `publicUser()` result: the controller has the latter after a
 * login, the service has the former after a token exchange, and both carry these five values.
 *
 * @param {object|null} user
 * @returns {{id: any, email: string, roleSlug: string|null, schoolId: any, organizationId: any}|null}
 */
function activityActor(user) {
  if (!user) return null;
  const values = user.get ? user.get() : user;

  return {
    id: values.id,
    email: values.email,
    roleSlug: user.role ? user.role.slug : null,
    schoolId: values.school_id || null,
    organizationId: values.organization_id || null,
  };
}

/** The role attributes every lookup in this module needs, and no more. */
const ROLE_INCLUDE = {
  model: db.Role,
  as: 'role',
  attributes: ['id', 'slug', 'name', 'is_platform_role', 'is_school_role'],
};

/**
 * Find a user by email or username, with the secret columns loaded.
 *
 * `scope('withSecrets')` replaces the default scope's `exclude`, so `password_hash` and the token
 * hashes are present. This is the only module that does that, and every function below drops the
 * instance before returning.
 *
 * @param {string} identifier  email or username, any case
 * @returns {Promise<object|null>}
 */
async function findByIdentifier(identifier) {
  const value = String(identifier).trim().toLowerCase();
  if (!value) return null;

  return db.User.scope('withSecrets').findOne({
    where: { [db.Op.or]: [{ email: value }, { username: value }] },
    include: [ROLE_INCLUDE],
  });
}

/** Find by one of the single-use token hash columns. */
async function findByTokenHash(column, token) {
  return db.User.scope('withSecrets').findOne({
    where: { [column]: sha256(token) },
    include: [ROLE_INCLUDE],
  });
}

/** Is `date` in the past? A null expiry is treated as expired — a token with no deadline is a bug. */
function isExpired(date) {
  if (!date) return true;
  return new Date(date).getTime() <= Date.now();
}

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

/**
 * Refuse a user whose account status or lock forbids a session.
 *
 * Shared by login and refresh, because a suspension has to stop a refresh too — otherwise a user
 * suspended at 10:00 keeps renewing their own session until the refresh token's own expiry a week
 * later, and the suspension would mean nothing.
 *
 * @param {object} user
 * @throws {ApiError} 403
 */
function assertUsableAccount(user) {
  if (!user.role) {
    /* `role_id` is NOT NULL with a RESTRICT foreign key, so a missing role is our data problem. */
    logger.error('User row has no role', { userId: user.id, roleId: user.role_id });
    throw ApiError.forbidden('This account has no role assigned.', { code: 'ROLE_MISSING' });
  }

  if (!LOGIN_ALLOWED_STATUSES.includes(user.status)) {
    const refusal = STATUS_REFUSALS[user.status] || {
      code: 'ACCOUNT_NOT_ACTIVE',
      message: 'This account cannot be used.',
    };
    throw ApiError.forbidden(refusal.message, { code: refusal.code });
  }
}

/** True while a lockout from failed logins is still in force. */
function isLocked(user) {
  return Boolean(user.locked_until && new Date(user.locked_until).getTime() > Date.now());
}

/**
 * Record a failed attempt and lock the account if it has run out of them.
 *
 * The counter resets to zero at the moment of the lock rather than staying at the maximum, so that
 * when the lock lapses the account gets a full set of attempts again instead of being re-locked by
 * the first mistake after it.
 *
 * @param {object} user
 * @returns {Promise<{locked: boolean, lockedUntil: Date|null}>}
 */
async function registerFailedLogin(user) {
  const attempts = Number(user.failed_login_attempts || 0) + 1;

  if (attempts >= config.security.maxLoginAttempts) {
    const lockedUntil = minutesFromNow(config.security.lockoutMinutes);
    await user.update({ failed_login_attempts: 0, locked_until: lockedUntil });
    logger.warn('Account locked after repeated failed logins', {
      userId: user.id,
      attempts,
      lockedUntil,
    });
    return { locked: true, lockedUntil };
  }

  await user.update({ failed_login_attempts: attempts });
  return { locked: false, lockedUntil: null };
}

/**
 * Mint a refresh token and store its hash on the user row.
 *
 * Only the SHA-256 digest is stored, so a database dump cannot be turned into live sessions. The
 * expiry column is filled from the token's own `exp` rather than by re-parsing
 * `JWT_REFRESH_EXPIRES_IN`: one source for the deadline means the column and the token can never
 * disagree, and verifying the token we just signed costs one HMAC.
 *
 * @param {object} user
 * @returns {Promise<{token: string, expiresAt: Date}>}
 */
async function issueRefreshToken(user) {
  const token = signRefreshToken(user.id);
  const { exp } = verifyRefreshToken(token);
  const expiresAt = new Date(exp * 1000);

  await user.update({
    refresh_token_hash: sha256(token),
    refresh_token_expires_at: expiresAt,
  });

  return { token, expiresAt };
}

/**
 * Everything a client needs after a successful login or refresh.
 *
 * The permission list travels in the response body, not in the access token — see
 * `accessTokenPayload`'s docblock for the measurement that settled it. Either way it is for the
 * frontend's navigation only; `requirePermission` re-reads permissions from the database on every
 * request. See permissionService's header for why that distinction is not negotiable.
 *
 * @param {object} user
 * @returns {Promise<{user: object, accessToken: string, refreshToken: string, refreshTokenExpiresAt: Date, permissions: string[]}>}
 */
async function issueSession(user) {
  const permissions = [...(await permissionService.getEffectivePermissions(user))];
  const accessToken = signAccessToken(accessTokenPayload(user));
  const refresh = await issueRefreshToken(user);

  return {
    user: publicUser(user),
    accessToken,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt,
    permissions,
  };
}

/* ───────────────────────────── FR-AUTH-001: login ───────────────────────────── */

/**
 * Authenticate a set of credentials and open a session.
 *
 * @param {{identifier: string, password: string}} credentials
 * @param {{ip?: string}} [context]
 * @returns {Promise<{user: object, accessToken: string, refreshToken: string, refreshTokenExpiresAt: Date, permissions: string[]}>}
 * @throws {ApiError} 401 INVALID_CREDENTIALS, 403 ACCOUNT_LOCKED / ACCOUNT_SUSPENDED / …
 */
async function login(credentials, context = {}) {
  const { identifier, password } = credentials;
  const user = await findByIdentifier(identifier);

  if (!user) {
    /* Spend the same time as a real comparison — see the header. */
    await verifyPassword(password, await TIMING_DUMMY_HASH_PROMISE);
    throw ApiError.unauthenticated('The credentials provided are not valid.', {
      code: 'INVALID_CREDENTIALS',
    });
  }

  if (isLocked(user)) {
    throw ApiError.forbidden('This account is temporarily locked. Try again later.', {
      code: 'ACCOUNT_LOCKED',
      details: { lockedUntil: user.locked_until },
    });
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    const outcome = await registerFailedLogin(user);
    if (outcome.locked) {
      /*
       * The attempt that triggers the lock says so. It is the same information the next attempt
       * would give anyway, and telling the account holder immediately is the difference between
       * "wrong password" repeated five times and an explanation.
       */
      throw ApiError.forbidden('This account is temporarily locked. Try again later.', {
        code: 'ACCOUNT_LOCKED',
        details: { lockedUntil: outcome.lockedUntil },
      });
    }
    throw ApiError.unauthenticated('The credentials provided are not valid.', {
      code: 'INVALID_CREDENTIALS',
    });
  }

  /* Only now, with the credential proven — see the header on FR-AUTH-007. */
  assertUsableAccount(user);

  await user.update({
    failed_login_attempts: 0,
    locked_until: null,
    last_login_at: new Date(),
    last_login_ip: context.ip ? String(context.ip).slice(0, 60) : null,
  });

  return issueSession(user);
}

/* ───────────────────────────── FR-AUTH-003: refresh ───────────────────────────── */

/**
 * Exchange a refresh token for a new pair.
 *
 * The old token is invalidated by the rotation, and presenting a refresh token that does not match
 * the stored hash clears the stored hash outright. That second part is the reuse defence: if a token
 * was stolen and both the thief and the owner present it, the second presentation cannot match — so
 * rather than guess which caller is the legitimate one, the session ends and both must sign in
 * again. An unnecessary re-login is a much smaller cost than a session shared with an attacker.
 *
 * @param {string} token
 * @returns {Promise<object>} the same shape as `login`
 * @throws {ApiError} 401
 */
async function refresh(token) {
  if (!token) {
    throw ApiError.unauthenticated('No refresh token was provided.', {
      code: 'REFRESH_TOKEN_MISSING',
    });
  }

  /* Signature, expiry, issuer, audience and algorithm; a failure becomes 401 in `errorHandler`. */
  const payload = verifyRefreshToken(token);

  if (payload.typ !== 'refresh') {
    throw ApiError.unauthenticated('This token cannot be used to refresh a session.', {
      code: 'TOKEN_WRONG_TYPE',
    });
  }

  const userId = Number.parseInt(payload.sub, 10);
  const user = Number.isInteger(userId) && userId > 0
    ? await db.User.scope('withSecrets').findByPk(userId, { include: [ROLE_INCLUDE] })
    : null;

  if (!user) {
    throw ApiError.unauthenticated('This session is no longer valid.', {
      code: 'ACCOUNT_NOT_FOUND',
    });
  }

  if (!user.refresh_token_hash) {
    /* Logged out, password changed, or the session was already ended by a reuse. */
    throw ApiError.unauthenticated('This session has ended. Please sign in again.', {
      code: 'SESSION_ENDED',
    });
  }

  if (!safeEqual(sha256(token), user.refresh_token_hash)) {
    await user.update({ refresh_token_hash: null, refresh_token_expires_at: null });
    logger.warn('Refresh token reuse detected; session ended', { userId: user.id });
    throw ApiError.unauthenticated('This session has ended. Please sign in again.', {
      code: 'REFRESH_TOKEN_REUSED',
    });
  }

  /*
   * Checked as well as the JWT's own `exp`. The column is what a server-side revocation can shorten,
   * so it is the authority even when the token itself still looks fresh.
   */
  if (isExpired(user.refresh_token_expires_at)) {
    await user.update({ refresh_token_hash: null, refresh_token_expires_at: null });
    throw ApiError.unauthenticated('This session has expired. Please sign in again.', {
      code: 'SESSION_EXPIRED',
    });
  }

  if (isLocked(user)) {
    throw ApiError.forbidden('This account is temporarily locked. Try again later.', {
      code: 'ACCOUNT_LOCKED',
      details: { lockedUntil: user.locked_until },
    });
  }

  assertUsableAccount(user);

  return issueSession(user);
}

/* ───────────────────────────── FR-AUTH-002: logout ───────────────────────────── */

/**
 * End the session.
 *
 * Idempotent, and it does not care whether a stored hash was there to clear. A client calling logout
 * twice, or after its session already ended, has achieved what it asked for.
 *
 * The access token is not revoked, because a stateless JWT cannot be — it stays valid for at most
 * `JWT_ACCESS_EXPIRES_IN`. That is the cost of stateless authentication and the reason the access
 * token's lifetime is 15 minutes rather than a day. What logout does guarantee is that no *new*
 * access token can be minted, which is what "the session is ended" has to mean here (FR-AUTH-002).
 *
 * @param {number} userId
 * @returns {Promise<void>}
 */
async function logout(userId) {
  await db.User.update(
    { refresh_token_hash: null, refresh_token_expires_at: null },
    { where: { id: userId } }
  );
}

/* ───────────────────────────── FR-AUTH-005: password reset ───────────────────────────── */

/**
 * The email body for a reset link.
 *
 * Plain text only. An HTML mail would need a template layer and a renderer, and this message is one
 * sentence and a URL — §23's notification engine is where templating belongs, if anywhere.
 */
function resetEmail(user, token) {
  const url = `${config.app.frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    to: user.email,
    subject: `Reset your ${config.app.name} password`,
    text:
      `Hello ${user.name},\n\n` +
      'A password reset was requested for your account. Open the link below to choose a new ' +
      `password. It expires in ${config.security.passwordResetTtlMinutes} minutes.\n\n` +
      `${url}\n\n` +
      'If you did not request this, no action is needed — your current password still works.\n',
  };
}

/**
 * Start a password reset.
 *
 * Answers the same way whether or not the address is on file; the return value says what actually
 * happened, for the log and for tests, and the controller does not pass it to the client.
 *
 * @param {string} email
 * @returns {Promise<{issued: boolean, reason?: string}>}
 */
async function forgotPassword(email) {
  const normalised = String(email).trim().toLowerCase();
  const user = await db.User.scope('withSecrets').findOne({ where: { email: normalised } });

  if (!user) {
    logger.info('Password reset requested for an unknown address', { email: normalised });
    return { issued: false, reason: 'unknown address' };
  }

  if (!LOGIN_ALLOWED_STATUSES.includes(user.status)) {
    /*
     * A suspended account gets no link. Resetting the password would not let them in — `login`
     * checks status — so the mail would be an invitation to a door that stays shut.
     */
    logger.info('Password reset requested for an unusable account', {
      userId: user.id,
      status: user.status,
    });
    return { issued: false, reason: 'account not active' };
  }

  const token = randomToken();
  await user.update({
    password_reset_token_hash: sha256(token),
    password_reset_expires_at: minutesFromNow(config.security.passwordResetTtlMinutes),
  });

  /*
   * Enqueued, not awaited — SRS §25's *"hand work off so the request thread returns immediately"*.
   *
   * Three things make this safe rather than merely faster. The token is already persisted above, so
   * the link works whether or not the mail has gone. This function's answer does not depend on the
   * send: it returns `{ issued: true }` for an unknown address too, deliberately, so that a caller
   * cannot learn which addresses exist. And `enqueue()` never throws.
   *
   * It also fixes something: a failing SMTP server used to **fail the reset request**, because the
   * throw propagated. Now the request succeeds and the queue retries three times with backoff.
   */
  enqueue(JOB_NAMES.SEND_EMAIL, resetEmail(user, token));
  return { issued: true };
}

/**
 * Apply the new password from a reset link.
 *
 * @param {{token: string, password: string}} input
 * @param {import('express').Request} [req]  for the audit row's request context
 * @returns {Promise<{userId: number, actor: object}>}
 * @throws {ApiError} 400 RESET_TOKEN_INVALID
 */
async function resetPassword(input, req) {
  const user = await findByTokenHash('password_reset_token_hash', input.token);

  /*
   * One refusal for "no such token", "already used" and "expired". They are the same event from the
   * caller's side — the link does not work, ask for another — and distinguishing them would tell
   * someone holding a stolen link whether it was ever real.
   */
  if (!user || isExpired(user.password_reset_expires_at)) {
    if (user) {
      /* Expired: clear it, so a token that is past its deadline cannot be probed for again. */
      await user.update({ password_reset_token_hash: null, password_reset_expires_at: null });
    }
    throw ApiError.badRequest('This password reset link is not valid or has expired.', {
      code: 'RESET_TOKEN_INVALID',
    });
  }

  const before = auditSnapshot(user);

  await user.update({
    password_hash: await hashPassword(input.password),
    password_changed_at: new Date(),
    password_reset_token_hash: null,
    password_reset_expires_at: null,
    /* Ends every session, including the one that may have been stolen. See the header. */
    refresh_token_hash: null,
    refresh_token_expires_at: null,
    /* Whoever set this has been satisfied: the user has now chosen a password of their own. */
    must_change_password: false,
    failed_login_attempts: 0,
    locked_until: null,
  });

  await writePasswordAudit(req, user, before, 'password reset via emailed link');
  logger.info('Password reset completed', { userId: user.id });

  /* `actor` is for the activity row the controller writes — this route is public. See `activityActor`. */
  return { userId: user.id, actor: activityActor(user) };
}

/* ───────────────────────────── authenticated password change ───────────────────────────── */

/**
 * The fields a password-related audit row may record.
 *
 * `password_hash` is deliberately absent. `audit_logs.old_values` / `new_values` are readable by
 * anyone who can read the table, and writing a bcrypt hash into them would move the credential out
 * of the one column that is excluded from every default query and into one that is not.
 */
const PASSWORD_AUDIT_FIELDS = [
  'password_changed_at',
  'must_change_password',
  'failed_login_attempts',
  'locked_until',
  'email_verified_at',
];

function auditSnapshot(user) {
  return snapshot(user, PASSWORD_AUDIT_FIELDS);
}

/**
 * Record a password change in `audit_logs`.
 *
 * @param {import('express').Request|null} req
 * @param {object} user   the instance, already updated
 * @param {object} before `auditSnapshot()` taken before the update
 * @param {string} reason
 */
async function writePasswordAudit(req, user, before, reason) {
  await recordAudit(req || null, {
    tableName: 'users',
    recordId: user.id,
    event: 'update',
    before,
    after: auditSnapshot(user),
    reason,
    /*
     * An emailed-link request has no signed-in user and no tenant. The account holder is the one
     * acting — the link proves it — and the account belongs to its school and organization.
     */
    userId: user.id,
    schoolId: user.school_id,
    organizationId: user.organization_id,
  });
}

/**
 * Change the password of the authenticated caller.
 *
 * Returns a fresh session, because the change invalidates the caller's own access token along with
 * everyone else's — see the header.
 *
 * @param {object} authUser  `req.user`; carries no secret columns, so the row is re-read
 * @param {{currentPassword: string, password: string}} input
 * @param {import('express').Request} [req]
 * @returns {Promise<object>} the same shape as `login`
 * @throws {ApiError} 400 CURRENT_PASSWORD_INVALID
 */
async function changePassword(authUser, input, req) {
  const user = await db.User.scope('withSecrets').findByPk(authUser.id, { include: [ROLE_INCLUDE] });

  if (!user) {
    /* Authenticated a moment ago, so the row was deleted mid-request. */
    throw ApiError.unauthenticated('This session is no longer valid.', {
      code: 'ACCOUNT_NOT_FOUND',
    });
  }

  if (!(await verifyPassword(input.currentPassword, user.password_hash))) {
    /*
     * Not counted towards the lockout. The caller already holds a valid access token, so this is not
     * a guessing surface, and locking someone out of their own account for mistyping their current
     * password would turn a typo into fifteen minutes of downtime.
     */
    throw ApiError.badRequest('The current password is not correct.', {
      code: 'CURRENT_PASSWORD_INVALID',
    });
  }

  const before = auditSnapshot(user);

  await user.update({
    password_hash: await hashPassword(input.password),
    password_changed_at: new Date(),
    must_change_password: false,
    password_reset_token_hash: null,
    password_reset_expires_at: null,
    refresh_token_hash: null,
    refresh_token_expires_at: null,
  });

  await writePasswordAudit(req, user, before, 'password changed by the account holder');
  logger.info('Password changed', { userId: user.id });

  /* A new pair, minted after the change, so this session survives it. */
  return issueSession(user);
}

/* ───────────────────────────── FR-AUTH-006: email verification ───────────────────────────── */

function verificationEmail(user, token) {
  const url = `${config.app.frontendUrl}/verify-email?token=${encodeURIComponent(token)}`;
  return {
    to: user.email,
    subject: `Confirm your ${config.app.name} email address`,
    text:
      `Hello ${user.name},\n\n` +
      'Open the link below to confirm this email address. It expires in ' +
      `${config.security.emailVerificationTtlHours} hours.\n\n` +
      `${url}\n`,
  };
}

/**
 * Issue a verification link.
 *
 * Exported because it is not only the resend endpoint's: whatever creates a user — the Super Admin
 * creating a Principal (§9.3), a school creating staff (§15) — calls this so the new account can
 * confirm its address without an administrator having to trigger it.
 *
 * @param {object} user  a User instance; must not be a default-scoped one, as the hash is written
 * @returns {Promise<{issued: boolean, alreadyVerified?: boolean}>}
 */
async function sendVerificationEmail(user) {
  if (user.email_verified_at) return { issued: false, alreadyVerified: true };

  const token = randomToken();
  await user.update({
    email_verification_token_hash: sha256(token),
    email_verification_expires_at: hoursFromNow(config.security.emailVerificationTtlHours),
  });

  /* Enqueued for the reasons at `requestPasswordReset` — the token is already stored. */
  enqueue(JOB_NAMES.SEND_EMAIL, verificationEmail(user, token));
  return { issued: true };
}

/**
 * Issue a verification link for the authenticated caller's own address.
 *
 * The address is never taken from the request — an endpoint that mails a token to whatever address
 * the caller names is a way to make this system send mail on someone else's behalf.
 *
 * @param {object} authUser  `req.user`
 * @returns {Promise<{issued: boolean, alreadyVerified?: boolean}>}
 */
async function resendVerification(authUser) {
  const user = await db.User.scope('withSecrets').findByPk(authUser.id);
  if (!user) {
    throw ApiError.unauthenticated('This session is no longer valid.', {
      code: 'ACCOUNT_NOT_FOUND',
    });
  }
  return sendVerificationEmail(user);
}

/**
 * Confirm an address from a verification link.
 *
 * Public: the link is opened from an email client, which holds no access token. It carries its own
 * proof — a 32-byte random token that only the address's owner received.
 *
 * @param {string} token
 * @param {import('express').Request} [req]
 * @returns {Promise<{userId: number, email: string, actor: object}>}
 * @throws {ApiError} 400 VERIFICATION_TOKEN_INVALID
 */
async function verifyEmail(token, req) {
  const user = await findByTokenHash('email_verification_token_hash', token);

  if (!user || isExpired(user.email_verification_expires_at)) {
    if (user) {
      await user.update({
        email_verification_token_hash: null,
        email_verification_expires_at: null,
      });
    }
    throw ApiError.badRequest('This verification link is not valid or has expired.', {
      code: 'VERIFICATION_TOKEN_INVALID',
    });
  }

  const before = auditSnapshot(user);

  await user.update({
    email_verified_at: new Date(),
    email_verification_token_hash: null,
    email_verification_expires_at: null,
  });

  await writePasswordAudit(req, user, before, 'email address verified');
  logger.info('Email verified', { userId: user.id });

  return { userId: user.id, email: user.email, actor: activityActor(user) };
}

/* ───────────────────────────── the caller's own identity ───────────────────────────── */

/**
 * Who am I, what may I do, and what am I scoped to.
 *
 * One call the frontend makes on load to build its navigation, so it returns all three: the user,
 * the effective permission set from the database (not from the token — see permissionService), and
 * the tenant scope `resolveTenant` derived.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{user: object, permissions: string[], tenant: object}>}
 */
async function profile(req) {
  const permissions = await req.getPermissions();

  return {
    user: publicUser(req.user),
    permissions: [...permissions].sort(),
    tenant: {
      level: req.tenant.level,
      organizationId: req.tenant.organizationId,
      schoolId: req.tenant.schoolId,
      isPlatform: req.tenant.isPlatform,
    },
    entitlements: await callerEntitlements(req),
  };
}

/**
 * The caller's own school entitlements, or `null` for a caller who has no school.
 *
 * ## Why this rides on `/auth/me` rather than getting a route of its own
 *
 * §30 Rule 1 requires module gating to be database-driven with no plan name in the logic, and
 * `docs/ARCHITECTURE.md` §8 builds the whole navigation from this snapshot — so the frontend needs
 * it on every load, exactly when it needs the profile. Three things follow, and each of them argues
 * for the same place:
 *
 *   - **No new route.** A `GET /entitlements` would need a permission to guard it, and §29/§35 fix
 *     the catalogue at 109 with no entry for this. Riding on `/auth/me` needs none: the endpoint is
 *     already authenticated, and this is the caller's own school.
 *   - **No second round trip.** The navigation cannot render until both the permissions and the
 *     modules are known. Two calls would mean either a flash of the wrong menu or a spinner over the
 *     whole shell.
 *   - **They expire together.** A refresh re-reads permissions from the database; entitlements
 *     arriving from the same response cannot drift from them.
 *
 * The snapshot is served from `entitlementService`'s cache, so this adds a cache read rather than
 * the six queries `resolve()` runs.
 *
 * @param {import('express').Request} req
 * @returns {Promise<object|null>}
 */
async function callerEntitlements(req) {
  /*
   * A platform caller has no school, and that is not a degenerate case to paper over with an empty
   * object: Super Admin screens are gated by permission, never by subscription, and returning
   * `modules: {}` would read as "every module is off" to a client that checked it.
   */
  if (!req.tenant || req.tenant.isPlatform || !req.tenant.schoolId) return null;

  /*
   * Named `entitlements`, not `snapshot`. This module already imports a `snapshot` from
   * `activityLog` (line 59), and a local of that name would shadow it — legal, silent, and exactly
   * the kind of thing that turns into a bug the first time someone adds an audit call in here.
   */
  const entitlements = await entitlementService.getSnapshot(req.tenant.schoolId);

  /*
   * Passed through as the service computed it, minus nothing. Every field here is a fact about the
   * caller's own school that the caller is already entitled to act on, and trimming it would only
   * mean a screen later needing a field this function had decided to withhold.
   *
   * `plan.name` is included **for display**. §30 Rule 1 forbids branching on it, not showing it — a
   * user is entitled to know which plan they are on. The client-side guard against that rule is that
   * `EntitlementProvider` exposes `hasModule()` and `limitFor()` and does not expose the plan at all
   * to gating code.
   */
  return entitlements;
}

module.exports = {
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  sendVerificationEmail,
  resendVerification,
  verifyEmail,
  profile,

  /* Exported for the modules that create users and for the verification suite. */
  publicUser,
  activityActor,
  findByIdentifier,
  PUBLIC_USER_FIELDS,
  PASSWORD_AUDIT_FIELDS,
};
