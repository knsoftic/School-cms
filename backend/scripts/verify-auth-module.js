'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *
 *   AUTH_RATE_LIMIT_MAX  raised well past what this script sends. `authLimiter` allows 20 requests
 *   RATE_LIMIT_MAX       per 15 minutes per IP by default, and this script deliberately sends more
 *                        than that against /auth/login alone. The limiter's own behaviour is verified
 *                        in scripts/verify-middlewares.js; what is asserted *here* is that it is
 *                        mounted on the right routes, which is done by identity rather than by
 *                        provoking a 429.
 *   BCRYPT_ROUNDS=10     the script performs on the order of fifty bcrypt operations. 10 rounds keeps
 *                        the run to a sensible length while staying slow enough for the timing
 *                        assertion below to mean something. The shipped default is 12.
 *   CSRF_ENABLED=true    so the guard on /auth/refresh and /auth/logout is actually exercised.
 *   PASSWORD_MIN_LENGTH  pinned so the assertions about the floor do not depend on the local .env.
 *   MAIL_DRIVER=log      the default; pinned so no message can escape to a real SMTP server.
 */
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.RATE_LIMIT_MAX = '100000';
process.env.BCRYPT_ROUNDS = '10';
process.env.CSRF_ENABLED = 'true';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';

/**
 * Verification of the auth module — SRS §7, FR-AUTH-001 … FR-AUTH-009.
 *
 *   src/modules/auth/auth.validation.js   the schemas, exercised directly
 *   src/modules/auth/auth.service.js      the rules, exercised over real HTTP against the real
 *                                         database
 *   src/modules/auth/auth.controller.js   the refresh cookie, the CSRF rotation, the activity rows
 *   src/modules/auth/auth.routes.js       which guard is on which route, by function identity
 *   src/services/mailService.js           the transport, and that a reset link actually contains a
 *                                         usable token
 *   src/app.js                            that the public half is mounted above the authentication
 *                                         boundary and the protected half below it
 *
 * ## What is asserted that could otherwise look like a defect
 *
 *  - An unknown identifier and a wrong password produce **byte-identical** responses. That is the
 *    point: a difference of any kind — code, message, or measurable time — turns login into a way to
 *    test whether an address has an account here. The timing half is asserted too, loosely, because a
 *    tight bound on a wall clock is a flaky test and a loose one still catches the real regression
 *    (skipping bcrypt entirely when the user is not found).
 *  - A **locked** account is refused before its password is compared, so `ACCOUNT_LOCKED` does
 *    confirm the account exists. That is a deliberate trade, argued in the service's header, and it
 *    is asserted here so nobody "fixes" it without reading the argument.
 *  - A **suspended** account gets `ACCOUNT_SUSPENDED` when the password is right and
 *    `INVALID_CREDENTIALS` when it is wrong. Both are asserted, because the pair is the rule:
 *    FR-AUTH-007 wants the account holder told, and a guesser must learn nothing.
 *  - Presenting a rotated refresh token ends the whole session, including for the client holding the
 *    *current* token. When two parties hold one token there is no way to tell which is the owner, so
 *    both are signed out.
 *  - `change-password` returns a **new token pair**, and the old access token stops working
 *    immediately. Both halves are asserted: the change sets `password_changed_at`, which
 *    `authenticate` uses to reject earlier tokens, so without the new pair the caller would be
 *    signed out by their own successful request.
 *
 * ## Fixtures
 *
 * Five users are created under the `@verify-auth.local` domain and the `super_admin` role, then
 * deleted — hard-deleted, not soft — at the end, along with the `activity_logs` and `audit_logs` rows
 * they generated. The `super_admin` role is used because it resolves to platform scope with no
 * organization or school, and this database has none of either; the tenant chain is verified in
 * scripts/verify-auth-chain.js and is not what is under test here. The seeded Super Admin is never
 * touched.
 *
 * `logger.info` is intercepted while the mail driver is exercised. `logger.warn` and `logger.error`
 * lines during the run are expected: locked accounts, CSRF refusals and refresh reuse all log
 * deliberately.
 *
 * Run: node scripts/verify-auth-module.js
 */

const db = require('../src/models');
const { sweepResidue, removeFailedSignIns } = require('./lib/residue');
const config = require('../src/config/env');
const logger = require('../src/config/logger');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');
const { authLimiter } = require('../src/middlewares/rateLimit');
const { requireCsrfToken } = require('../src/middlewares/csrf');
const mailService = require('../src/services/mailService');
const { waitUntilIdle, queueStats } = require('../src/config/queue');
const authService = require('../src/modules/auth/auth.service');
const authController = require('../src/modules/auth/auth.controller');
const authRoutes = require('../src/modules/auth/auth.routes');
const { schemas, PASSWORD_MAX_BYTES } = require('../src/modules/auth/auth.validation');
const { hashPassword, sha256, signAccessToken, accessTokenPayload } = require('../src/utils/tokens');
const { USER_STATUS } = require('../src/config/constants');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-auth.local';
const PASSWORD = 'Verify@Auth123';

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${
      ok ? '' : `  (expected ${JSON.stringify(expected)})`
    }`
  );
}

/* ═══════════════════════════ part 1 — the schemas ═══════════════════════════ */

/** Validate against one schema and report the outcome in a shape an assertion can name. */
function run(schema, value) {
  const { error, value: cleaned } = schema.validate(value, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });
  return {
    ok: !error,
    value: cleaned,
    types: error ? error.details.map((d) => d.type) : [],
    messages: error ? error.details.map((d) => d.message) : [],
    fields: error ? error.details.map((d) => d.path.join('.')) : [],
  };
}

function verifySchemas() {
  console.log('\n--- validation: login ---');

  const trimmed = run(schemas.login, { identifier: '  Super@MSMS.Local  ', password: 'x' });
  check('the identifier is trimmed', trimmed.value.identifier, 'Super@MSMS.Local');
  check(
    'but not lowercased by Joi — the service does it once, for both lookups',
    trimmed.value.identifier === trimmed.value.identifier.toLowerCase(),
    false
  );
  check('returnRefreshToken defaults to false', trimmed.value.returnRefreshToken, false);

  check(
    'an identifier under three characters is refused',
    run(schemas.login, { identifier: 'ab', password: 'x' }).types,
    ['string.min']
  );
  check(
    'a one-character password is accepted — no policy on the way in',
    run(schemas.login, { identifier: 'someone@example.test', password: 'x' }).ok,
    true
  );
  check(
    'an unknown field is stripped, not rejected',
    run(schemas.login, { identifier: 'someone@example.test', password: 'x', role: 'super_admin' })
      .value.role,
    undefined
  );

  console.log('\n--- validation: the new-password rule ---');

  const min = config.security.passwordMinLength;
  const short = run(schemas.resetPassword, { token: 'a'.repeat(43), password: 'a'.repeat(min - 1) });
  check(`a password of ${min - 1} characters is refused`, short.ok, false);
  check('and the message names the floor', short.messages[0], `Password must be at least ${min} characters long.`);
  check(
    `exactly ${min} characters is accepted`,
    run(schemas.resetPassword, { token: 'a'.repeat(43), password: 'a'.repeat(min) }).ok,
    true
  );
  check(
    `${PASSWORD_MAX_BYTES} ASCII characters is accepted`,
    run(schemas.resetPassword, { token: 'a'.repeat(43), password: 'a'.repeat(PASSWORD_MAX_BYTES) }).ok,
    true
  );
  check(
    `${PASSWORD_MAX_BYTES + 1} ASCII characters is refused`,
    run(schemas.resetPassword, {
      token: 'a'.repeat(43),
      password: 'a'.repeat(PASSWORD_MAX_BYTES + 1),
    }).types,
    /*
     * Both rules, not one. For ASCII a character is a byte, so 73 of them exceed Joi's `.max(72)` —
     * which counts UTF-16 code units — *and* the custom byte rule, and `abortEarly: false` collects
     * every failure rather than stopping at the first. The overlap is the point: the two rules
     * coincide for ASCII and diverge for anything wider, which is what the emoji case below covers.
     */
    ['string.max', 'password.bytes']
  );

  /*
   * The reason the byte rule exists. 25 four-byte emoji are 100 bytes but only 50 UTF-16 code units,
   * so Joi's `.max(72)` — which counts code units — lets them straight through. bcrypt would hash the
   * first 72 bytes and silently ignore the rest.
   */
  const emoji = '\u{1F512}'.repeat(25);
  check('a 25-emoji password is under Joi’s character limit', emoji.length <= PASSWORD_MAX_BYTES, true);
  check('but over the byte limit', Buffer.byteLength(emoji, 'utf8'), 100);
  const emojiResult = run(schemas.resetPassword, { token: 'a'.repeat(43), password: emoji });
  check('so the byte rule refuses it', emojiResult.types, ['password.bytes']);
  check(
    'with a message that says bytes',
    emojiResult.messages[0],
    `Password must be at most ${PASSWORD_MAX_BYTES} bytes long.`
  );

  console.log('\n--- validation: single-use tokens ---');

  check(
    'a base64url token is accepted',
    run(schemas.verifyEmail, { token: 'abcXYZ012_-abcXYZ012_-abcXYZ012_-abcXYZ012_' }).ok,
    true
  );
  /*
   * The offending character goes in the *middle*. `singleUseToken` is `.trim()`ed, so a trailing
   * space is removed before the pattern runs and the token would be accepted — correctly, but it
   * would not be testing the pattern.
   */
  for (const bad of ['+', '/', '=', '.', ' ']) {
    check(
      `a token containing ${JSON.stringify(bad)} is refused`,
      run(schemas.verifyEmail, { token: `abcXYZ012abcXYZ${bad}012abcXYZ012abc` }).ok,
      false
    );
  }
  check('a missing token is refused', run(schemas.verifyEmail, {}).types, ['any.required']);

  console.log('\n--- validation: change-password ---');

  const same = run(schemas.changePassword, { currentPassword: PASSWORD, password: PASSWORD });
  check('reusing the current password is refused', same.ok, false);
  check('with a message that explains why', same.messages[0], 'The new password must be different from the current one.');
  check(
    'a short *current* password is accepted — it predates the policy it must be replaced under',
    run(schemas.changePassword, { currentPassword: 'abc', password: 'LongEnough123' }).ok,
    true
  );

  console.log('\n--- validation: the two email-bearing schemas ---');

  check(
    'forgot-password lowercases and trims the address',
    run(schemas.forgotPassword, { email: '  Someone@Example.TEST ' }).value.email,
    'someone@example.test'
  );
  check(
    'a malformed address is refused',
    run(schemas.forgotPassword, { email: 'not-an-address' }).types,
    ['string.email']
  );

  /*
   * The regression guard for a defect this suite found. Joi's `.email()` checks the last label against
   * a built-in copy of the IANA registry unless told not to, and `.local` is not in it — so with the
   * default on, the seeded `superadmin@msms.local` could not use forgot-password at all.
   */
  for (const internal of ['superadmin@msms.local', 'head@school.internal', 'it@acme.corp']) {
    check(`${internal} is accepted — a private TLD is a real address`, run(schemas.forgotPassword, { email: internal }).ok, true);
  }
  check(
    'the syntax check is still on: a domain with no dot is refused',
    run(schemas.forgotPassword, { email: 'someone@localhost' }).ok,
    false
  );
  check(
    'resend-verification takes no address at all — the caller’s own is used',
    run(schemas.resendVerification, { email: 'victim@example.test' }).value,
    {}
  );
}

/* ═══════════════════════════ part 2 — the routing ═══════════════════════════ */

/**
 * The middleware stack of one route, as an array of the handler functions.
 *
 * `asyncHandler` erases both the name and the arity of what it wraps, so a layer can only be
 * identified by function identity — never by `fn.name` or `fn.length`.
 */
function stackOf(router, method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  return layer ? layer.route.stack.map((s) => s.handle) : null;
}

function verifyRouting() {
  console.log('\n--- routing: the public half ---');

  const publicPaths = authRoutes.publicRoutes.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);

  check('exactly the five endpoints that cannot require a token', publicPaths, [
    'POST /login',
    'POST /refresh',
    'POST /forgot-password',
    'POST /reset-password',
    'POST /verify-email',
  ]);

  for (const path of ['/login', '/refresh', '/forgot-password', '/reset-password', '/verify-email']) {
    check(
      `authLimiter is mounted on ${path}`,
      stackOf(authRoutes.publicRoutes, 'post', path).includes(authLimiter),
      true
    );
  }

  console.log('\n--- routing: the authenticated half ---');

  const protectedPaths = authRoutes.protectedRoutes.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);

  check('exactly the four endpoints that need a token', protectedPaths, [
    'POST /logout',
    'POST /change-password',
    'POST /resend-verification',
    'GET /me',
  ]);

  check(
    'the two paths app.js allow-lists in enforcePasswordChange are both in this router',
    ['/change-password', '/logout'].every((p) =>
      protectedPaths.some((entry) => entry.endsWith(` ${p}`))
    ),
    true
  );

  check(
    'authLimiter is not on /me — the caller already authenticated',
    stackOf(authRoutes.protectedRoutes, 'get', '/me').includes(authLimiter),
    false
  );

  console.log('\n--- routing: CSRF is on the two cookie-authorised routes only ---');

  /*
   * `requireCsrfToken()` returns a fresh closure per call, so identity cannot be compared against
   * the export. The guard is recognisable by name — it is not wrapped in `asyncHandler`, which is
   * what would erase it.
   */
  const hasCsrf = (router, method, path) =>
    stackOf(router, method, path).some((fn) => fn.name === 'csrfGuard');

  check('/refresh carries the CSRF guard', hasCsrf(authRoutes.publicRoutes, 'post', '/refresh'), true);
  check('/logout carries it', hasCsrf(authRoutes.protectedRoutes, 'post', '/logout'), true);
  check(
    '/login does not — its authority is a password in the body, which no cross-site form can supply',
    hasCsrf(authRoutes.publicRoutes, 'post', '/login'),
    false
  );
  check(
    '/change-password does not — its authority is the Authorization header',
    hasCsrf(authRoutes.protectedRoutes, 'post', '/change-password'),
    false
  );
  check('requireCsrfToken() is a factory, so each call is a distinct closure', requireCsrfToken() === requireCsrfToken(), false);

  console.log('\n--- routing: the refresh cookie’s attributes ---');

  const options = authController.refreshCookieOptions(new Date(Date.now() + 60_000));
  check('httpOnly, so no script can read a seven-day credential', options.httpOnly, true);
  check('sameSite lax, which the CSRF guard then closes for cross-site POSTs', options.sameSite, 'lax');
  check('secure follows NODE_ENV', options.secure, config.isProduction);
  check('scoped to the auth routes, not to the whole API', options.path, `${PREFIX}/auth`);
  check('maxAge tracks the token’s own expiry', options.maxAge > 0 && options.maxAge <= 60_000, true);
  check(
    'the clearing options match on the three attributes clearCookie compares',
    (() => {
      const c = authController.clearRefreshCookieOptions();
      return c.path === options.path && c.sameSite === options.sameSite && c.httpOnly === options.httpOnly;
    })(),
    true
  );

  console.log('\n--- routing: what publicUser may publish ---');

  const forbidden = [
    'password_hash',
    'refresh_token_hash',
    'password_reset_token_hash',
    'email_verification_token_hash',
    'refresh_token_expires_at',
    'password_reset_expires_at',
    'email_verification_expires_at',
    'failed_login_attempts',
    'locked_until',
    'extra_permissions',
    'denied_permissions',
    'last_login_ip',
  ];
  check(
    'none of the secret or internal columns is in the published field list',
    forbidden.filter((f) => authService.PUBLIC_USER_FIELDS.includes(f)),
    []
  );
  check(
    'the audit field list carries no password hash either',
    authService.PASSWORD_AUDIT_FIELDS.includes('password_hash'),
    false
  );
}

/* ═══════════════════════════ fixtures ═══════════════════════════ */

const fixtures = {};

/*
 * The highest log-table ids that existed before this script ran.
 *
 * Cleanup deletes above these rather than by `user_id`, because a `login_failed` row has no user —
 * `req.user` does not exist when a sign-in fails, so the row's `user_id` is null and the identifier
 * that was tried is in `metadata`. Bounding the delete by id means only rows this run created are
 * removed, and nothing that was already in the table can be.
 */
const baseline = { activityLog: 0, auditLog: 0 };

async function captureBaseline() {
  baseline.activityLog = (await db.ActivityLog.max('id')) || 0;
  baseline.auditLog = (await db.AuditLog.max('id')) || 0;
  return true;
}

async function createFixtures() {
  /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
  const residueCleared = await sweepResidue(db, { codes: [], domains: ['verify-auth.local'] });
  if (residueCleared) {
    console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
  }
  const role = await db.Role.findOne({ where: { slug: 'super_admin' } });
  if (!role) throw new Error('The super_admin role is missing — run the seeders first.');

  const hash = await hashPassword(PASSWORD);

  const definitions = [
    { key: 'main', username: 'verify_main', status: USER_STATUS.ACTIVE },
    { key: 'lockout', username: 'verify_lockout', status: USER_STATUS.ACTIVE },
    { key: 'suspended', username: 'verify_suspended', status: USER_STATUS.SUSPENDED },
    { key: 'reset', username: 'verify_reset', status: USER_STATUS.ACTIVE },
    { key: 'forced', username: 'verify_forced', status: USER_STATUS.ACTIVE, mustChange: true },
  ];

  for (const definition of definitions) {
    const user = await db.User.create({
      role_id: role.id,
      name: `Verify ${definition.key}`,
      email: `${definition.key}@${DOMAIN}`,
      username: definition.username,
      password_hash: hash,
      status: definition.status,
      must_change_password: Boolean(definition.mustChange),
    });
    fixtures[definition.key] = user;
  }

  return Object.keys(fixtures).length;
}

async function removeFixtures() {
  /* The rows the run generated, before the users themselves — no orphans left behind. */
  /*
   * Scoped to this run's own users — Known Issues #25. An unbounded delete above `baseline` also
   * removes rows belonging to any suite running concurrently, which is the mechanism behind
   * "a parallel run reports false failures".
   *
   * This suite scopes by `user_id`, not by tenant, because its fixtures are deliberately
   * platform-scope — no school and no organization — so the columns every other suite scopes by are
   * null here. The ids must be read BEFORE the users are deleted: both trail tables are ON DELETE
   * SET NULL from `users`, so afterwards there is nothing left to match on.
   */
  const ids = Object.values(fixtures).map((u) => u.id);
  if (!ids.length) return;

  await db.ActivityLog.destroy({
    where: { id: { [db.Op.gt]: baseline.activityLog }, user_id: ids },
  });
  await db.AuditLog.destroy({
    where: { id: { [db.Op.gt]: baseline.auditLog }, user_id: ids },
  });
  /* And the failed sign-ins, which carry no user at all — see `removeFailedSignIns()`. */
  await removeFailedSignIns(db, {
    afterId: baseline.activityLog,
    domains: [DOMAIN],
    usernames: Object.values(fixtures).map((u) => u.username),
  });

  /* `force` because `users` is paranoid — a soft delete would leave the addresses taken. */
  await db.User.destroy({ where: { id: ids }, force: true });
}

/** Re-read a fixture's row with the secret columns loaded. */
function reload(key) {
  return db.User.scope('withSecrets').findByPk(fixtures[key].id);
}

/* ═══════════════════════════ part 3 — over HTTP ═══════════════════════════ */

/** Pull one cookie's value out of a set-cookie list. */
function cookieValue(setCookies, name) {
  const entry = (setCookies || []).find((c) => c.startsWith(`${name}=`));
  if (!entry) return null;
  return decodeURIComponent(entry.slice(name.length + 1).split(';')[0]);
}

/** The attributes of one cookie, lowercased, as a set. */
function cookieAttributes(setCookies, name) {
  const entry = (setCookies || []).find((c) => c.startsWith(`${name}=`));
  if (!entry) return null;
  return entry
    .split(';')
    .slice(1)
    .map((part) => part.trim());
}

/**
 * An error body with its request id removed.
 *
 * `errorHandler` echoes `req.id` in every failure envelope, so two refusals that must be
 * indistinguishable are never literally byte-identical — and should not be. The id is per-request, not
 * per-account: it carries no information about which account was tried, and it is what lets a user
 * reporting "I got an error" hand over something that finds the log line. Comparing without it is the
 * comparison that actually means "these two refusals reveal the same thing".
 */
function withoutRequestId(raw) {
  const parsed = JSON.parse(raw);
  if (parsed.error) delete parsed.error.requestId;
  return JSON.stringify(parsed);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the wall clock has certainly moved into a later whole second.
 *
 * `authenticate.tokenPredatesPasswordChange()` compares a JWT's `iat` — whole seconds — against
 * `floor(password_changed_at)` with a strict `<`. That strictness is deliberate and load-bearing: it is
 * what lets `change-password` hand back a usable new pair in the same response that invalidated
 * everything else. The cost is that a token minted in the same second as the change survives.
 *
 * So a test that signs in and immediately changes the password is not testing the mechanism, it is
 * racing the second boundary — it passes or fails depending on where in the second it started. Sleeping
 * past the boundary first makes the assertion deterministic and makes it exercise the real case: a
 * token that genuinely predates the change.
 *
 * This is a property of the implementation, not a workaround for it. The ≤1-second window is recorded
 * as a known limitation rather than closed, because closing it would break the new pair.
 */
function sleepPastSecondBoundary() {
  const now = Date.now();
  /* To the next boundary, plus a margin for the round trip that follows. */
  return sleep(1000 - (now % 1000) + 150);
}

async function verifyHttp() {
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  /**
   * One request. Cookies are not managed by `fetch`, so they are passed and read explicitly — which
   * is better here, because the assertions are largely *about* the cookies.
   */
  async function call(path, { method = 'POST', body, token, cookies, csrf } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookies) {
      headers.Cookie = Object.entries(cookies)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('; ');
    }
    if (csrf) headers['X-CSRF-Token'] = csrf;

    const started = Date.now();
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* left null — an assertion on `body` will name the problem more clearly than a throw here */
    }

    return {
      status: res.status,
      body: parsed,
      raw: text,
      setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [],
      elapsed: Date.now() - started,
    };
  }

  /** Log in and return everything a later request might need. */
  async function signIn(key, password = PASSWORD, extra = {}) {
    const res = await call('/auth/login', {
      body: { identifier: `${key}@${DOMAIN}`, password, ...extra },
    });
    return {
      res,
      accessToken: res.body && res.body.data ? res.body.data.accessToken : null,
      csrf: cookieValue(res.setCookie, config.security.csrfCookieName),
      refreshCookie: cookieValue(res.setCookie, config.security.refreshCookieName),
    };
  }

  try {
    /* ─────────────── login: the failure paths give nothing away ─────────────── */

    console.log('\n--- login: an unknown identifier and a wrong password are indistinguishable ---');

    const unknown = await call('/auth/login', {
      body: { identifier: `nobody@${DOMAIN}`, password: PASSWORD },
    });
    const wrongPassword = await call('/auth/login', {
      body: { identifier: `main@${DOMAIN}`, password: 'DefinitelyNotIt123' },
    });

    check('an unknown identifier is 401', unknown.status, 401);
    check('a wrong password is 401', wrongPassword.status, 401);
    check(
      'identical bodies apart from the request id',
      withoutRequestId(unknown.raw) === withoutRequestId(wrongPassword.raw),
      true
    );
    check('under one code', unknown.body.error.code, 'INVALID_CREDENTIALS');
    check(
      'and the message names neither the field nor the account',
      unknown.body.error.message,
      'The credentials provided are not valid.'
    );

    /*
     * The timing half. A missing user must still cost a bcrypt comparison, or the response time is
     * the oracle the identical body was meant to remove. The bound is deliberately loose — a wall
     * clock on a shared machine is noisy, and the regression this catches (no dummy compare at all)
     * is an order of magnitude, not a few percent.
     */
    check(
      `the unknown-identifier path still spends bcrypt time (${unknown.elapsed}ms vs ${wrongPassword.elapsed}ms)`,
      unknown.elapsed >= wrongPassword.elapsed * 0.5,
      true
    );

    console.log('\n--- login: a validation failure is a 422, not a 401 ---');

    const badBody = await call('/auth/login', { body: { identifier: 'ab' } });
    check('a too-short identifier and a missing password', badBody.status, 422);
    check('reported as a validation error', badBody.body.error.code, 'VALIDATION_ERROR');
    check(
      'naming both fields',
      badBody.body.error.details.map((d) => d.field).sort(),
      ['identifier', 'password']
    );

    /* ─────────────── login: success ─────────────── */

    console.log('\n--- login: what a successful sign-in returns ---');

    const session = await signIn('main');
    check('200', session.res.status, 200);
    check('an access token', typeof session.accessToken, 'string');
    check('described as a bearer token', session.res.body.data.tokenType, 'Bearer');
    check('with the configured lifetime, not a computed one', session.res.body.data.accessTokenExpiresIn, config.jwt.accessExpiresIn);
    check('the permission set', Array.isArray(session.res.body.data.permissions), true);
    check('and a non-empty one for a Super Admin', session.res.body.data.permissions.length > 0, true);
    check('a fresh CSRF token', typeof session.res.body.data.csrfToken, 'string');
    check(
      'the refresh token is *not* in the body by default',
      session.res.body.data.refreshToken,
      undefined
    );
    check('it is in a cookie instead', typeof session.refreshCookie, 'string');

    const attributes = cookieAttributes(session.res.setCookie, config.security.refreshCookieName);
    check('the cookie is HttpOnly', attributes.includes('HttpOnly'), true);
    check('SameSite=Lax', attributes.includes('SameSite=Lax'), true);
    check(`scoped to ${PREFIX}/auth`, attributes.includes(`Path=${PREFIX}/auth`), true);
    check('and carries a Max-Age', attributes.some((a) => a.startsWith('Max-Age=')), true);
    check(
      'the CSRF cookie is readable by script, because the frontend must echo it',
      cookieAttributes(session.res.setCookie, config.security.csrfCookieName).includes('HttpOnly'),
      false
    );

    console.log('\n--- login: nothing secret or internal reaches the client ---');

    check('no bcrypt hash anywhere in the response', /\$2[aby]\$/.test(session.res.raw), false);
    for (const field of [
      'password_hash',
      'refresh_token_hash',
      'password_reset_token_hash',
      'email_verification_token_hash',
      'failed_login_attempts',
      'locked_until',
      'extra_permissions',
      'denied_permissions',
      'last_login_ip',
    ]) {
      check(`no ${field}`, session.res.raw.includes(field), false);
    }
    check(
      'the role is published as an object, not as a bare id',
      typeof session.res.body.data.user.role.slug,
      'string'
    );

    console.log('\n--- login: the access token carries only what the tenant chain reads ---');

    const claims = JSON.parse(
      Buffer.from(session.accessToken.split('.')[1], 'base64url').toString('utf8')
    );
    check('the claim set', Object.keys(claims).sort(), [
      'aud',
      'exp',
      'iat',
      'iss',
      'jti',
      'organizationId',
      'role',
      'roleId',
      'schoolId',
      'sub',
      'typ',
    ]);
    check(
      'no permission list — nothing server-side reads one, and it would be a stale copy',
      claims.permissions,
      undefined
    );
    check(
      `so the token stays small (${session.accessToken.length} chars; it was 3,093 with the claim)`,
      session.accessToken.length < 800,
      true
    );
    check('the tenant scope is in the token, not taken from the request', [claims.organizationId, claims.schoolId], [null, null]);

    console.log('\n--- login: the row records the sign-in ---');

    const afterLogin = await reload('main');
    check('last_login_at is set', Boolean(afterLogin.last_login_at), true);
    check('last_login_ip is recorded', Boolean(afterLogin.last_login_ip), true);
    check('the refresh hash stored is the digest, never the token', afterLogin.refresh_token_hash, sha256(session.refreshCookie));
    check('with an expiry alongside it', Boolean(afterLogin.refresh_token_expires_at), true);

    console.log('\n--- login: a non-browser client can opt out of the cookie ---');

    const native = await signIn('main', PASSWORD, { returnRefreshToken: true });
    check('the token is in the body', typeof native.res.body.data.refreshToken, 'string');
    check('and it is the same one the cookie carries', native.res.body.data.refreshToken, native.refreshCookie);

    /* ─────────────── the authenticated surface ─────────────── */

    console.log('\n--- /auth/me ---');

    const anonymous = await call('/auth/me', { method: 'GET' });
    check('without a token it is 401', anonymous.status, 401);

    const me = await call('/auth/me', { method: 'GET', token: native.accessToken });
    check('with one it is 200', me.status, 200);
    check('the caller is the fixture', me.body.data.user.email, `main@${DOMAIN}`);
    check('permissions come back sorted', me.body.data.permissions.join() === [...me.body.data.permissions].sort().join(), true);
    check('a platform role resolves to platform scope', me.body.data.tenant.level, 'platform');
    check('with no school', me.body.data.tenant.schoolId, null);
    check('and isPlatform set', me.body.data.tenant.isPlatform, true);

    /*
     * The `entitlements` field, which ARCHITECTURE.md §8 builds the whole navigation from and §30
     * Rule 1 requires to exist at all — without it a client has no database-driven way to know which
     * modules to show, and would be back to branching on a plan name.
     *
     * Only the null half is asserted here, and deliberately: this suite's fixture is a platform user
     * with no school, so the populated branch is unreachable from it. Adding a school, a plan and a
     * subscription just to reach it would rebuild `verify-entitlement.js` inside this file — that
     * suite already has all three, and asserts the populated shape there. What this proves is the
     * half that only the real HTTP chain can show: that the field survives the response.
     *
     * `null`, not absent and not `{}`. A missing key and an empty object are both readable as "no
     * modules are enabled", which for a Super Admin would hide a platform surface that subscriptions
     * never gate.
     */
    check('the response carries an entitlements field', 'entitlements' in me.body.data, true);
    check('  which is null for a platform caller, not an empty snapshot',
      me.body.data.entitlements, null);

    /* ─────────────── refresh and rotation ─────────────── */

    console.log('\n--- refresh: rotation ---');

    const noCsrf = await call('/auth/refresh', {
      cookies: { [config.security.refreshCookieName]: native.refreshCookie },
    });
    check('without the CSRF header it is 403', noCsrf.status, 403);
    check('under one code for all three CSRF failure modes', noCsrf.body.error.code, 'CSRF_TOKEN_INVALID');

    const rotated = await call('/auth/refresh', {
      cookies: {
        [config.security.refreshCookieName]: native.refreshCookie,
        [config.security.csrfCookieName]: native.csrf,
      },
      csrf: native.csrf,
    });
    const rotatedCookie = cookieValue(rotated.setCookie, config.security.refreshCookieName);
    check('with it, 200', rotated.status, 200);
    check('a new access token', typeof rotated.body.data.accessToken, 'string');
    check('a new refresh token', rotatedCookie !== native.refreshCookie, true);
    check(
      'and the stored hash is the new one',
      (await reload('main')).refresh_token_hash,
      sha256(rotatedCookie)
    );
    check(
      'the new access token works',
      (await call('/auth/me', { method: 'GET', token: rotated.body.data.accessToken })).status,
      200
    );

    console.log('\n--- refresh: presenting a rotated token ends the whole session ---');

    const reused = await call('/auth/refresh', {
      cookies: {
        [config.security.refreshCookieName]: native.refreshCookie,
        [config.security.csrfCookieName]: native.csrf,
      },
      csrf: native.csrf,
    });
    check('the old token is refused', reused.status, 401);
    check('as a reuse, not as an expiry', reused.body.error.code, 'REFRESH_TOKEN_REUSED');
    check('the stored hash is cleared', (await reload('main')).refresh_token_hash, null);

    const collateral = await call('/auth/refresh', {
      cookies: {
        [config.security.refreshCookieName]: rotatedCookie,
        [config.security.csrfCookieName]: native.csrf,
      },
      csrf: native.csrf,
    });
    check(
      'so the *current* token stops working too — both parties are signed out',
      collateral.body.error.code,
      'SESSION_ENDED'
    );

    console.log('\n--- refresh: the other ways it can fail ---');

    const live = await signIn('main');
    const withAccessToken = await call('/auth/refresh', {
      body: { refreshToken: live.accessToken },
      cookies: { [config.security.csrfCookieName]: live.csrf },
      csrf: live.csrf,
    });
    check('an access token cannot be used to refresh', withAccessToken.status, 401);
    check(
      'and it fails on the signature — the two token families are signed with different secrets',
      withAccessToken.body.error.code,
      'TOKEN_INVALID'
    );

    const garbage = await call('/auth/refresh', {
      body: { refreshToken: 'not.a.token.at.all.but.long.enough.to.pass.validation' },
      cookies: { [config.security.csrfCookieName]: live.csrf },
      csrf: live.csrf,
    });
    check('a malformed token is 401, not 500', garbage.status, 401);

    /*
     * The `typ` claim is checked as well as the signature. It cannot be reached with a real access
     * token, because the two token families are signed with different secrets and the signature fails
     * first — so the branch is exercised with a token that is validly signed for *this* endpoint and
     * merely claims to be the wrong kind. Without the claim check, a future change that unified the
     * secrets would silently make an access token a seven-day credential.
     */
    const wrongType = jwt.sign({ sub: String(fixtures.main.id), typ: 'access' }, config.jwt.refreshSecret, {
      algorithm: config.jwt.algorithm,
      expiresIn: config.jwt.refreshExpiresIn,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
    const typed = await call('/auth/refresh', {
      body: { refreshToken: wrongType },
      cookies: { [config.security.csrfCookieName]: live.csrf },
      csrf: live.csrf,
    });
    check('a correctly signed token claiming the wrong type is refused', typed.status, 401);
    check('by the claim, not by the signature', typed.body.error.code, 'TOKEN_WRONG_TYPE');

    const noToken = await call('/auth/refresh', {
      cookies: { [config.security.csrfCookieName]: live.csrf },
      csrf: live.csrf,
    });
    check('no token at all is 401', noToken.status, 401);
    check('and says so', noToken.body.error.code, 'REFRESH_TOKEN_MISSING');

    /* ─────────────── logout ─────────────── */

    console.log('\n--- logout ---');

    const loggedOut = await call('/auth/logout', {
      token: live.accessToken,
      cookies: {
        [config.security.refreshCookieName]: live.refreshCookie,
        [config.security.csrfCookieName]: live.csrf,
      },
      csrf: live.csrf,
    });
    check('200', loggedOut.status, 200);
    check('the stored hash is gone', (await reload('main')).refresh_token_hash, null);
    check(
      'the refresh cookie is cleared on the same path it was set on',
      cookieAttributes(loggedOut.setCookie, config.security.refreshCookieName).includes(`Path=${PREFIX}/auth`),
      true
    );
    check(
      'so the token that was in it no longer refreshes',
      (
        await call('/auth/refresh', {
          cookies: {
            [config.security.refreshCookieName]: live.refreshCookie,
            [config.security.csrfCookieName]: live.csrf,
          },
          csrf: live.csrf,
        })
      ).body.error.code,
      'SESSION_ENDED'
    );
    check(
      'the access token still works until it expires — a stateless JWT cannot be revoked',
      (await call('/auth/me', { method: 'GET', token: live.accessToken })).status,
      200
    );
    check(
      'logging out twice is not an error',
      (
        await call('/auth/logout', {
          token: live.accessToken,
          cookies: { [config.security.csrfCookieName]: live.csrf },
          csrf: live.csrf,
        })
      ).status,
      200
    );

    /* ─────────────── the lockout ─────────────── */

    console.log('\n--- lockout: repeated failures lock the account, temporarily ---');

    const max = config.security.maxLoginAttempts;
    const attempts = [];
    for (let i = 0; i < max; i += 1) {
      attempts.push(
        await call('/auth/login', {
          body: { identifier: `lockout@${DOMAIN}`, password: `wrong-${i}` },
        })
      );
    }

    check(
      `the first ${max - 1} attempts are plain credential failures`,
      attempts.slice(0, max - 1).map((a) => `${a.status}:${a.body.error.code}`),
      Array(max - 1).fill('401:INVALID_CREDENTIALS')
    );
    check(`attempt ${max} locks the account`, attempts[max - 1].status, 403);
    check('with a distinct code', attempts[max - 1].body.error.code, 'ACCOUNT_LOCKED');
    check('and the moment it lifts', Boolean(attempts[max - 1].body.error.details.lockedUntil), true);

    const locked = await reload('lockout');
    check('the row carries locked_until', Boolean(locked.locked_until), true);
    check('in the future', new Date(locked.locked_until).getTime() > Date.now(), true);
    check(
      'and the counter is reset, so a lapsed lock grants a full set of attempts again',
      locked.failed_login_attempts,
      0
    );

    const correctWhileLocked = await call('/auth/login', {
      body: { identifier: `lockout@${DOMAIN}`, password: PASSWORD },
    });
    check(
      'the correct password is refused while locked — the lock is checked first, by design',
      correctWhileLocked.body.error.code,
      'ACCOUNT_LOCKED'
    );

    const tokenWhileLocked = signAccessToken(
      accessTokenPayload({ ...fixtures.lockout.get(), role: { slug: 'super_admin' } })
    );
    check(
      'and a token minted before the lock is refused too',
      (await call('/auth/me', { method: 'GET', token: tokenWhileLocked })).status,
      403
    );

    await fixtures.lockout.update({ locked_until: null });
    check(
      'once the lock lifts the correct password works again',
      (await signIn('lockout')).res.status,
      200
    );
    check('and the counter stays at zero', (await reload('lockout')).failed_login_attempts, 0);

    /* ─────────────── account status ─────────────── */

    console.log('\n--- status: FR-AUTH-007, told to the holder and to nobody else ---');

    const suspendedRight = await call('/auth/login', {
      body: { identifier: `suspended@${DOMAIN}`, password: PASSWORD },
    });
    check('a suspended account with the right password is 403', suspendedRight.status, 403);
    check('and is told why', suspendedRight.body.error.code, 'ACCOUNT_SUSPENDED');

    const suspendedWrong = await call('/auth/login', {
      body: { identifier: `suspended@${DOMAIN}`, password: 'wrong' },
    });
    check(
      'with the wrong password it is an ordinary credential failure',
      suspendedWrong.body.error.code,
      'INVALID_CREDENTIALS'
    );
    check(
      'so a guesser never learns the account is suspended',
      withoutRequestId(suspendedWrong.raw) === withoutRequestId(unknown.raw),
      true
    );
    check('no session was opened', (await reload('suspended')).refresh_token_hash, null);

    /* ─────────────── password reset ─────────────── */

    console.log('\n--- forgot-password: the same answer every time ---');

    /* Wrap the transport so the mailed token can be read, and still send through the real driver. */
    const sent = [];
    const realSend = mailService.send;
    mailService.send = async (message) => {
      sent.push(message);
      return realSend(message);
    };

    const realInfo = logger.info;
    const logLines = [];
    logger.info = (...args) => {
      logLines.push(args);
      return realInfo.apply(logger, args);
    };

    const forgotReal = await call('/auth/forgot-password', { body: { email: `reset@${DOMAIN}` } });
    const forgotUnknown = await call('/auth/forgot-password', {
      body: { email: `nobody-at-all@${DOMAIN}` },
    });
    const forgotSuspended = await call('/auth/forgot-password', {
      body: { email: `suspended@${DOMAIN}` },
    });

    /*
     * Wait for the queue before restoring the interceptor.
     *
     * §7's two mails are no longer sent inline — `auth.service` hands them to the queue so a slow
     * SMTP server cannot hold a password-reset request open, which is SRS §25's whole point. The
     * message is therefore generated on a `setImmediate` tick *after* the response, and restoring
     * the interceptor first would stop capturing it.
     *
     * It passed without this, because three sequential `await call(...)` give the loop ample
     * opportunity to drain — which is precisely the kind of timing luck this session has spent its
     * regressions eliminating. `waitUntilIdle()` is the queue's own answer, and it makes the
     * assertion below about the mail rather than about the scheduler.
     */
    await waitUntilIdle();
    logger.info = realInfo;

    check('a real address gets 202', forgotReal.status, 202);
    check('so does an unknown one', forgotUnknown.status, 202);
    check('and a suspended one', forgotSuspended.status, 202);
    check('all three bodies are byte-identical', forgotReal.raw === forgotUnknown.raw && forgotReal.raw === forgotSuspended.raw, true);
    check(
      'and the message is conditional in its wording, not in its content',
      forgotReal.body.message,
      'If that address belongs to an account, a reset link is on its way.'
    );

    check('exactly one message was actually generated', sent.length, 1);

    /* ── SRS §25 — the mail went through the QUEUE, not inline ── */

    /*
     * The behaviour this replaced is worth stating: `await mailService.send()` used to sit in the
     * request path, so a failing SMTP server **failed the password-reset request**. It is now handed
     * to the queue, which retries three times with backoff, and the caller's 202 no longer depends on
     * a third party being up.
     *
     * `enqueued` rather than a spy on `enqueue()`: the counter is the queue's own record, so this
     * asserts the job actually reached it rather than that a function was called.
     */
    const queueAfter = queueStats();
    check('§25 — the reset mail was handed to the queue rather than sent inline',
      queueAfter.enqueued >= 1, true);
    check('  and it completed there, with nothing failed',
      [queueAfter.completed >= 1, queueAfter.failed], [true, 0]);
    check('  through the send_email handler, which is registered at boot',
      queueAfter.handlers.includes('send_email'), true);
    /*
     * The four §25 job names with no handler are refused visibly. A queue that silently drops an
     * unknown job is worse than one that has none, so this asserts the registered set is exactly the
     * four that can finish — the other four render Buffers with nowhere to go, or need a caller
     * transaction. `src/jobs/handlers/index.js` carries the reason for each.
     */
    check('  and exactly the four job names that can complete are registered',
      [...queueAfter.handlers].sort(),
      ['database_backup', 'send_email', 'send_notification', 'sync_usage']);
    check('to the address that has an account', sent[0].to, `reset@${DOMAIN}`);
    check(
      'a suspended account gets no link — resetting would not let it in anyway',
      (await reload('suspended')).password_reset_token_hash,
      null
    );
    check(
      'the log driver renders the body, which is how a developer reads the link',
      logLines.some(
        (line) =>
          line[0] === 'Email (MAIL_DRIVER=log, not actually sent)' &&
          typeof line[1].body === 'string' &&
          line[1].body.includes('/reset-password?token=')
      ),
      true
    );

    console.log('\n--- reset-password ---');

    const resetLink = sent[0].text.match(/reset-password\?token=([A-Za-z0-9_%-]+)/);
    const resetToken = decodeURIComponent(resetLink[1]);
    const beforeReset = await reload('reset');

    check('the mailed link carries a token', Boolean(resetToken), true);
    check('and the stored value is its digest, not the token', beforeReset.password_reset_token_hash, sha256(resetToken));
    check('with an expiry', Boolean(beforeReset.password_reset_expires_at), true);

    /* Open a session and lock the account first, so the reset can be shown to clear both. */
    const doomed = await signIn('reset');
    await fixtures.reset.update({ failed_login_attempts: 3, locked_until: null, must_change_password: true });

    /* So `doomed`'s `iat` is strictly before the reset's `password_changed_at`. See the helper. */
    await sleepPastSecondBoundary();

    const NEW_PASSWORD = 'Rotated@Auth456';
    const reset = await call('/auth/reset-password', {
      body: { token: resetToken, password: NEW_PASSWORD },
    });
    check('200', reset.status, 200);
    check('and the client is told to sign in — no session is handed out', reset.body.message, 'Your password has been changed. Please sign in.');
    check('no access token in the body', reset.body.data, null);

    const afterReset = await reload('reset');
    check('the reset token is cleared', afterReset.password_reset_token_hash, null);
    check('and its expiry with it', afterReset.password_reset_expires_at, null);
    check('password_changed_at is stamped', Boolean(afterReset.password_changed_at), true);
    check('every session is ended', afterReset.refresh_token_hash, null);
    check('the lockout counter is cleared', afterReset.failed_login_attempts, 0);
    check('and a forced change is satisfied', afterReset.must_change_password, false);

    check(
      'the old password no longer works',
      (await signIn('reset')).res.status,
      401
    );
    check(
      'the new one does',
      (await signIn('reset', NEW_PASSWORD)).res.status,
      200
    );
    check(
      'and the access token issued before the reset is refused, by password_changed_at',
      (await call('/auth/me', { method: 'GET', token: doomed.accessToken })).status,
      401
    );

    console.log('\n--- reset-password: the failure paths are one refusal ---');

    const replay = await call('/auth/reset-password', {
      body: { token: resetToken, password: 'Another@Pass789' },
    });
    check('the same token cannot be used twice', replay.status, 400);
    check('under one code', replay.body.error.code, 'RESET_TOKEN_INVALID');

    const unknownToken = await call('/auth/reset-password', {
      body: { token: 'A'.repeat(43), password: 'Another@Pass789' },
    });
    check('an unknown token gets the same refusal', unknownToken.body.error.code, 'RESET_TOKEN_INVALID');
    check(
      'and is indistinguishable from the replay',
      withoutRequestId(unknownToken.raw) === withoutRequestId(replay.raw),
      true
    );

    const expiredToken = 'ExpiredTokenForVerification_0123456789abcd';
    await fixtures.reset.update({
      password_reset_token_hash: sha256(expiredToken),
      password_reset_expires_at: new Date(Date.now() - 1000),
    });
    const expired = await call('/auth/reset-password', {
      body: { token: expiredToken, password: 'Another@Pass789' },
    });
    check('an expired token gets the same refusal', expired.body.error.code, 'RESET_TOKEN_INVALID');
    check('and is cleared from the row, so it cannot be probed again', (await reload('reset')).password_reset_token_hash, null);

    /* ─────────────── change-password ─────────────── */

    console.log('\n--- change-password ---');

    const changer = await signIn('reset', NEW_PASSWORD);
    const wrongCurrent = await call('/auth/change-password', {
      token: changer.accessToken,
      body: { currentPassword: 'not-the-one', password: 'Yet@Another999' },
    });
    check('a wrong current password is 400', wrongCurrent.status, 400);
    check('with its own code', wrongCurrent.body.error.code, 'CURRENT_PASSWORD_INVALID');
    check(
      'and it does not count towards the lockout — a typo is not an attack when you hold a token',
      (await reload('reset')).failed_login_attempts,
      0
    );

    const sameAsCurrent = await call('/auth/change-password', {
      token: changer.accessToken,
      body: { currentPassword: NEW_PASSWORD, password: NEW_PASSWORD },
    });
    check('reusing the current password is refused by validation', sameAsCurrent.status, 422);

    const FINAL_PASSWORD = 'Final@Auth789';
    /* `changer`'s token must predate the change by a whole second for the pair below to mean anything. */
    await sleepPastSecondBoundary();
    const changed = await call('/auth/change-password', {
      token: changer.accessToken,
      body: { currentPassword: NEW_PASSWORD, password: FINAL_PASSWORD },
    });
    check('a valid change is 200', changed.status, 200);
    check('and hands back a new access token', typeof changed.body.data.accessToken, 'string');
    check('a new refresh cookie', Boolean(cookieValue(changed.setCookie, config.security.refreshCookieName)), true);
    check('and a rotated CSRF token', typeof changed.body.data.csrfToken, 'string');

    check(
      'the token from the same response works immediately — the tokenPredatesPasswordChange trap',
      (await call('/auth/me', { method: 'GET', token: changed.body.data.accessToken })).status,
      200
    );
    check(
      'while the one the caller held a moment earlier does not',
      (await call('/auth/me', { method: 'GET', token: changer.accessToken })).status,
      401
    );
    check('the new password works', (await signIn('reset', FINAL_PASSWORD)).res.status, 200);

    console.log('\n--- change-password: the audit row carries no credential ---');

    const auditRow = await db.AuditLog.findOne({
      where: { table_name: 'users', record_id: fixtures.reset.id },
      order: [['id', 'DESC']],
    });
    check('a row was written', Boolean(auditRow), true);
    check('as an update', auditRow.event, 'update');
    check(
      'and neither side of it mentions a password hash',
      JSON.stringify([auditRow.old_values, auditRow.new_values]).includes('password_hash'),
      false
    );
    check(
      'the changed columns are drawn from the restricted list only',
      (auditRow.changed_fields || []).filter((f) => !authService.PASSWORD_AUDIT_FIELDS.includes(f)),
      []
    );

    /* ─────────────── the forced change ─────────────── */

    console.log('\n--- must_change_password: a seeded password cannot survive first login ---');

    const forced = await signIn('forced');
    check('the account can sign in', forced.res.status, 200);
    check('and is told what it must do', forced.res.body.message, 'You must change your password before continuing.');
    check('the flag is visible to the client', forced.res.body.data.user.must_change_password, true);

    const blocked = await call('/auth/me', { method: 'GET', token: forced.accessToken });
    check('but ordinary work is refused', blocked.status, 403);
    check('with the code that tells a client which screen to show', blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');

    const clearing = await call('/auth/change-password', {
      token: forced.accessToken,
      body: { currentPassword: PASSWORD, password: 'Cleared@Auth321' },
    });
    check('the allow-listed change endpoint is reachable', clearing.status, 200);
    check('the flag clears', (await reload('forced')).must_change_password, false);
    check(
      'and the new token can do ordinary work',
      (await call('/auth/me', { method: 'GET', token: clearing.body.data.accessToken })).status,
      200
    );

    /* ─────────────── email verification ─────────────── */

    console.log('\n--- verify-email: FR-AUTH-006 ---');

    const before = sent.length;
    const resend = await call('/auth/resend-verification', {
      token: (await signIn('main')).accessToken,
    });
    check('an unverified account gets a link', resend.status, 200);
    check('and is not told it was already verified', resend.body.data.alreadyVerified, false);
    /* Asserted as a delta, not an absolute — `sent` still holds the reset mail from earlier. */
    check('exactly one message was generated', sent.length - before, 1);
    check('to the caller’s own address', sent[sent.length - 1].to, `main@${DOMAIN}`);

    const verifyToken = decodeURIComponent(
      sent[sent.length - 1].text.match(/verify-email\?token=([A-Za-z0-9_%-]+)/)[1]
    );
    check(
      'the stored value is the digest',
      (await reload('main')).email_verification_token_hash,
      sha256(verifyToken)
    );

    const verified = await call('/auth/verify-email', { body: { token: verifyToken } });
    check('the link confirms the address', verified.status, 200);
    check('and echoes which one', verified.body.data.email, `main@${DOMAIN}`);

    const afterVerify = await reload('main');
    check('email_verified_at is stamped', Boolean(afterVerify.email_verified_at), true);
    check('the token is cleared', afterVerify.email_verification_token_hash, null);
    check('and its expiry', afterVerify.email_verification_expires_at, null);

    const replayVerify = await call('/auth/verify-email', { body: { token: verifyToken } });
    check('the same link cannot be used twice', replayVerify.status, 400);
    check('under one code', replayVerify.body.error.code, 'VERIFICATION_TOKEN_INVALID');

    const countBefore = sent.length;
    const already = await call('/auth/resend-verification', {
      token: (await signIn('main')).accessToken,
    });
    check('asking again once verified is a 200, not an error', already.status, 200);
    check('and says so', already.body.data.alreadyVerified, true);
    check('with no message generated', sent.length - countBefore, 0);
    check('and no new token written', (await reload('main')).email_verification_token_hash, null);

    check(
      'verify-email is public — the link is opened from a mail client with no token',
      (await call('/auth/verify-email', { body: { token: 'B'.repeat(43) } })).status,
      400
    );

    mailService.send = realSend;

    /* ─────────────── the activity trail ─────────────── */

    console.log('\n--- the activity trail ---');

    /* `activityAudit` writes on `res.finish`, which is after the response the client already read. */
    await sleep(400);

    const ids = Object.values(fixtures).map((u) => u.id);
    const loginRows = await db.ActivityLog.count({ where: { user_id: ids, action: 'login' } });
    check('successful sign-ins are recorded', loginRows > 0, true);

    const failedRow = await db.ActivityLog.findOne({
      where: { action: 'login_failed' },
      order: [['id', 'DESC']],
    });
    check('so are failures', Boolean(failedRow), true);
    if (failedRow) {
      check(
        'the identifier that was tried is recorded',
        Boolean(failedRow.metadata && failedRow.metadata.identifier),
        true
      );
      check(
        'but never the password that was tried',
        JSON.stringify(failedRow.metadata || {}).includes(PASSWORD),
        false
      );
    }

    const logoutRows = await db.ActivityLog.count({ where: { user_id: ids, action: 'logout' } });
    check('and sign-outs', logoutRows > 0, true);

    /* ─────────────── the boundary in app.js ─────────────── */

    console.log('\n--- app.js: the two halves are mounted on the right side of the boundary ---');

    check(
      'a public auth route is reachable without a token',
      (await call('/auth/forgot-password', { body: { email: `nobody@${DOMAIN}` } })).status,
      202
    );
    check(
      'a protected one is not',
      (await call('/auth/logout', {})).status,
      401
    );
    check(
      'an unknown path under /auth is 401 rather than 404 for an anonymous caller — it declines to enumerate',
      (await call('/auth/not-a-real-endpoint', {})).status,
      401
    );
    check(
      'and 404 once authenticated',
      (
        await call('/auth/not-a-real-endpoint', {
          token: (await signIn('main')).accessToken,
        })
      ).status,
      404
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ═══════════════════════════ part 4 — the transport ═══════════════════════════ */

async function verifyMailService() {
  console.log('\n--- mailService ---');

  const realInfo = logger.info;
  logger.info = () => {};
  const logged = await mailService.send({ to: 'a@b.test', subject: 's', text: 't' });
  logger.info = realInfo;

  check('the log driver reports success', logged, { sent: true, driver: 'log' });

  let threw = null;
  try {
    await mailService.send({ to: 'a@b.test', subject: 's' });
  } catch (err) {
    threw = err.message;
  }
  check(
    'an incomplete message throws — that is a defect in the caller, not a delivery failure',
    threw,
    'mailService.send() requires to, subject and text'
  );

  const realDriver = config.mail.driver;
  config.mail.driver = 'carrier-pigeon';
  const realError = logger.error;
  logger.error = () => {};
  const unknownDriver = await mailService.send({ to: 'a@b.test', subject: 's', text: 't' });
  logger.error = realError;
  config.mail.driver = realDriver;

  check('an unknown driver is reported, not silently treated as log', unknownDriver.sent, false);
  check('and names itself', unknownDriver.error, 'Unknown MAIL_DRIVER "carrier-pigeon". Expected "log" or "smtp".');

  await mailService.close();
  check('closing a transport that was never built is safe', true, true);
}

/* ═══════════════════════════ the run ═══════════════════════════ */

async function main() {
  verifySchemas();
  verifyRouting();
  await verifyMailService();

  console.log('\n--- fixtures ---');
  check('the log tables are baselined before anything is written', await captureBaseline(), true);
  check('five users created', await createFixtures(), 5);

  await verifyHttp();
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nVerification aborted:', err);
  })
  .finally(async () => {
    try {
      await removeFixtures();
      console.log('\nFixtures removed.');
    } catch (err) {
      failures += 1;
      console.error('Fixture cleanup failed:', err.message);
    }
    console.log(
      failures === 0 ? '\nAll auth-module checks passed.' : `\n${failures} check(s) FAILED.`
    );
    await db.sequelize.close();
    process.exit(failures === 0 ? 0 : 1);
  });
