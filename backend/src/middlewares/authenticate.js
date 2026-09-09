'use strict';

/**
 * JWT authentication — SRS §7 FR-AUTH-001 (login), FR-AUTH-007 (account status),
 * §24 FR-SEC-006 (JWT security).
 *
 * Establishes *who* is calling. It deliberately answers nothing about what they may do: role,
 * permission, tenant and subscription checks are separate middlewares, so a route's guards read
 * as a list of independent assertions rather than one function that has to be trusted about
 * everything.
 *
 * ## The token is read from the Authorization header only
 *
 * Never from a cookie. Per ARCHITECTURE §8 the access token lives in frontend memory and only the
 * *refresh* token is a cookie. Keeping it that way means a browser never attaches credentials to a
 * cross-site request automatically, which is what removes CSRF from every endpoint except the one
 * that reads the refresh cookie.
 *
 * ## The user row is re-read on every request
 *
 * A token is valid for `JWT_ACCESS_EXPIRES_IN` (15 minutes by default). Suspending an account,
 * locking it after failed logins, or changing its role must take effect on the next request rather
 * than a quarter of an hour later, and none of those facts are in the token. One primary-key read
 * with the role joined is the price of that, and it is the cheapest query in the application.
 *
 * The `defaultScope` on `User` excludes `password_hash`, `refresh_token_hash` and both single-use
 * token hashes, so nothing secret is loaded here or can leak through `req.user`.
 */

const { annotate } = require('../utils/routeMeta');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('./asyncHandler');
const db = require('../models');
const logger = require('../config/logger');
const permissionService = require('../services/permissionService');
const { verifyAccessToken } = require('../utils/tokens');
const { LOGIN_ALLOWED_STATUSES, USER_STATUS } = require('../config/constants');

/**
 * Why a non-active account was refused.
 *
 * A distinct code per status lets the frontend say something useful — "your account is awaiting
 * approval" rather than a bare 403 — without the API having to return prose the UI must parse.
 */
const STATUS_REFUSALS = {
  [USER_STATUS.INACTIVE]: {
    code: 'ACCOUNT_INACTIVE',
    message: 'This account is inactive. Contact your school administrator.',
  },
  [USER_STATUS.SUSPENDED]: {
    code: 'ACCOUNT_SUSPENDED',
    message: 'This account has been suspended. Contact your school administrator.',
  },
  [USER_STATUS.PENDING]: {
    code: 'ACCOUNT_PENDING',
    message: 'This account has not been activated yet.',
  },
};

/** Extract a bearer token, or null. */
function readBearerToken(req) {
  const header = req.get('Authorization');
  if (!header) return null;

  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;

  const token = rest.join('');
  return token || null;
}

/**
 * Reject a token minted before the account's password last changed — SRS §24 FR-SEC-006.
 *
 * Changing a password has to end existing sessions, otherwise a user who changes it *because* a
 * token was stolen has done nothing. `iat` has one-second resolution, so the comparison is strict:
 * a token issued in the same second as the change (the "change password, then sign in again" path)
 * is kept, while anything genuinely older is refused.
 */
function tokenPredatesPasswordChange(payload, user) {
  if (!user.password_changed_at || !payload.iat) return false;
  const changedAtSeconds = Math.floor(new Date(user.password_changed_at).getTime() / 1000);
  return payload.iat < changedAtSeconds;
}

/**
 * Populate `req.user`, `req.auth` and `req.getPermissions()`.
 *
 * @type {import('express').RequestHandler}
 */
const authenticate = asyncHandler(async (req, res, next) => {
  const token = readBearerToken(req);
  if (!token) {
    throw ApiError.unauthenticated('Authentication required.', { code: 'TOKEN_MISSING' });
  }

  /* Signature, expiry, issuer, audience and algorithm are all checked here; a failure surfaces as
   * a jsonwebtoken error, which `errorHandler` maps to 401 TOKEN_EXPIRED / TOKEN_INVALID. */
  const payload = verifyAccessToken(token);

  /*
   * A refresh token is signed with a different secret so it cannot reach this point — but `typ` is
   * checked anyway. It is the assertion that keeps the two token classes distinct if the secrets
   * are ever misconfigured to the same value, which is an easy mistake in a hand-written `.env`.
   */
  if (payload.typ !== 'access') {
    throw ApiError.unauthenticated('This token cannot be used to authenticate requests.', {
      code: 'TOKEN_WRONG_TYPE',
    });
  }

  const userId = Number.parseInt(payload.sub, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw ApiError.unauthenticated('Invalid authentication token.', { code: 'TOKEN_INVALID' });
  }

  const user = await db.User.findByPk(userId, {
    include: [{ model: db.Role, as: 'role', attributes: ['id', 'slug', 'name', 'is_platform_role', 'is_school_role'] }],
  });

  /*
   * 401 rather than 404: the token refers to a user that no longer exists (deleted, or soft-deleted
   * by `paranoid`). From the caller's side that is an authentication failure, and it must not
   * confirm whether a given id was ever real.
   */
  if (!user) {
    throw ApiError.unauthenticated('This session is no longer valid.', {
      code: 'ACCOUNT_NOT_FOUND',
    });
  }

  if (!user.role) {
    /* `role_id` is a non-null foreign key, so this is a data-integrity fault, not a client error. */
    logger.error('Authenticated user has no role row', {
      requestId: req.id,
      userId: user.id,
      roleId: user.role_id,
    });
    throw ApiError.forbidden('This account has no role assigned.', { code: 'ROLE_MISSING' });
  }

  if (!LOGIN_ALLOWED_STATUSES.includes(user.status)) {
    const refusal = STATUS_REFUSALS[user.status] || {
      code: 'ACCOUNT_NOT_ACTIVE',
      message: 'This account cannot be used.',
    };
    throw ApiError.forbidden(refusal.message, { code: refusal.code });
  }

  /* Lockout from repeated failed logins (FR-AUTH-001) also blocks a token minted before it. */
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    throw ApiError.forbidden('This account is temporarily locked. Try again later.', {
      code: 'ACCOUNT_LOCKED',
      details: { lockedUntil: user.locked_until },
    });
  }

  if (tokenPredatesPasswordChange(payload, user)) {
    throw ApiError.unauthenticated('Your password changed. Please sign in again.', {
      code: 'TOKEN_STALE',
    });
  }

  req.user = user;
  req.auth = {
    tokenId: payload.jti,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    /*
     * The token's own claims, kept only for comparison and diagnostics. Authorization never reads
     * them: role comes from `req.user.role`, tenancy from `resolveTenant`, permissions from the
     * database. See permissionService for why.
     */
    claims: {
      role: payload.role,
      roleId: payload.roleId,
      organizationId: payload.organizationId,
      schoolId: payload.schoolId,
    },
  };

  /*
   * Lazily resolved and memoised, so a route with no permission guard performs no permission work,
   * and a route with three guards resolves once. The promise itself is cached, so concurrent
   * guards share a single resolution.
   */
  let permissionsPromise;
  req.getPermissions = () => {
    if (!permissionsPromise) permissionsPromise = permissionService.getEffectivePermissions(user);
    return permissionsPromise;
  };

  return next();
});

/**
 * Block normal work while a forced password change is outstanding.
 *
 * Not an SRS functional requirement — FR-AUTH-006 is email verification, and the SRS says nothing
 * about initial passwords. `must_change_password` is a column this implementation added because §9.3
 * has a Super Admin type a Principal's password into a form, which means somebody other than the
 * account holder knows it. This is the safest reading consistent with FR-AUTH-004.
 *
 * The bootstrap Super Admin is seeded with `must_change_password = true`. Until it clears, the only
 * requests allowed through are the ones needed to clear it (and to sign out).
 *
 * That seeder is the **only** writer that sets it. This paragraph used to add "and an administrator
 * who resets a user's password sets the same flag", which is not true of any code path: grepping the
 * column across `src/` finds the seeder setting `true` (`04-super-admin.js:89`), `auth.service.js:590`
 * setting `false` when the change succeeds, and the model default of `false` — nothing else. §9.3
 * lists Password among the fields principal creation captures and says nothing about forcing a
 * change afterwards, so no requirement is going unmet; the sentence was simply describing a path
 * that does not exist.
 *
 * The allowed paths are passed in rather than hard-coded so `app.js` states them in one visible
 * place; a reader can see the whole exception list without opening this file.
 *
 * @param {{allow?: string[]}} [options]  path suffixes exempt from the check, e.g. '/auth/change-password'
 */
function enforcePasswordChange(options = {}) {
  const allow = options.allow || [];

  return function passwordChangeGate(req, res, next) {
    if (!req.user || !req.user.must_change_password) return next();
    if (allow.some((suffix) => req.path === suffix || req.path.endsWith(suffix))) return next();

    return next(
      ApiError.forbidden('You must change your password before continuing.', {
        code: 'PASSWORD_CHANGE_REQUIRED',
      })
    );
  };
}

/*
 * Marked so the OpenAPI generator can find the authentication boundary in the mounted stack
 * rather than inferring it. `authenticate`, `resolveTenant` and `enforceTenant` are all
 * `asyncHandler` wrappers and share the name `wrappedAsyncHandler`, so position alone cannot
 * tell them apart — and §28 requires every endpoint to state whether it needs a token.
 */
annotate(authenticate, { authenticates: true });

module.exports = { authenticate, enforcePasswordChange, readBearerToken, STATUS_REFUSALS };
