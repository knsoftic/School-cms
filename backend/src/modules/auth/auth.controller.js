'use strict';

/**
 * Auth HTTP layer — SRS §7.
 *
 * Thin on purpose. Every handler here reads the request, calls one service function, and shapes a
 * response; no rule about who may do what lives in this file. What *is* here is everything that is
 * genuinely about HTTP rather than about authentication:
 *
 *   - the refresh-token cookie, which is the only reason these handlers touch `res` at all
 *   - the CSRF token, re-issued whenever a session begins or is renewed
 *   - the activity description, which `activityAudit()` writes on `res.finish`
 *
 * ## The refresh token lives in an httpOnly cookie, not in the response body
 *
 * A refresh token is a long-lived credential — seven days by default — so putting it anywhere
 * JavaScript can read it means one cross-site scripting bug is a week of someone else's session. The
 * cookie is `httpOnly`, `sameSite: 'lax'`, `secure` in production, and scoped by `path` to the auth
 * routes so it is not attached to the other few hundred endpoints that have no use for it.
 *
 * `sameSite: 'lax'` rather than `'strict'`: the frontend is a separate origin in development
 * (`localhost:3000` calling `localhost:4000`), and `strict` would withhold the cookie from an
 * ordinary top-level navigation back into the app. The gap `lax` leaves — a cross-site POST — is
 * closed by `requireCsrfToken()` on the two routes that read the cookie.
 *
 * A non-browser client — a mobile app, an integration — sends `returnRefreshToken: true` at login and
 * gets the token in the body instead. It has no cookie jar, so the alternative would be no refresh at
 * all. The cookie is still set; a client that ignores cookies is unaffected by it.
 *
 * ## `forgot-password` always answers 202
 *
 * Whatever the service found. The response cannot depend on whether the address exists, or the
 * endpoint becomes a way to test a list of email addresses against this system. See the service.
 */

const config = require('../../config/env');
const ApiResponse = require('../../utils/ApiResponse');
const authService = require('./auth.service');
const { describeActivity } = require('../../middlewares/activityLog');
const { issueCsrfToken, clearCsrfToken } = require('../../middlewares/csrf');
const { ACTIVITY_ACTIONS } = require('../../config/constants');

/**
 * Where the refresh cookie is valid.
 *
 * The prefix is included because `path` is matched against the full request path, and the routes that
 * read the cookie live under `${apiPrefix}/auth`. Narrowing it this far means the credential is not
 * sent with every unrelated request, which is the cheapest available reduction in exposure.
 */
function refreshCookiePath() {
  return `${config.app.apiPrefix}/auth`;
}

/**
 * Cookie attributes for the refresh token.
 *
 * `maxAge` comes from the token's own expiry rather than from re-reading `JWT_REFRESH_EXPIRES_IN`, so
 * the cookie cannot outlive the token it carries or vanish while the token is still good.
 *
 * @param {Date} expiresAt
 */
function refreshCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: refreshCookiePath(),
    maxAge: Math.max(0, new Date(expiresAt).getTime() - Date.now()),
  };
}

/** Attributes for clearing it. `clearCookie` matches on name + path + sameSite, so they must agree. */
function clearRefreshCookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: refreshCookiePath(),
  };
}

/**
 * Publish a session: refresh cookie, fresh CSRF token, and the body a client needs.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} session  from `authService.login` / `refresh` / `changePassword`
 * @param {{includeRefreshToken?: boolean}} [options]
 * @returns {object} the response body's `data`
 */
function publishSession(req, res, session, options = {}) {
  res.cookie(
    config.security.refreshCookieName,
    session.refreshToken,
    refreshCookieOptions(session.refreshTokenExpiresAt)
  );

  const body = {
    user: session.user,
    permissions: session.permissions,
    accessToken: session.accessToken,
    tokenType: 'Bearer',
    /*
     * So a client knows when to refresh without having to decode the token. The value is the
     * configured string (`15m`), not a computed timestamp — the token itself carries the authoritative
     * `exp`, and publishing a second deadline that could drift from it would be worse than useless.
     */
    accessTokenExpiresIn: config.jwt.accessExpiresIn,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
  };

  /* Rotated with the session, so a client that just signed in can immediately POST. */
  const csrfToken = config.security.csrfEnabled ? issueCsrfToken(res) : null;
  if (csrfToken) body.csrfToken = csrfToken;

  if (options.includeRefreshToken) body.refreshToken = session.refreshToken;

  return body;
}

/**
 * POST /auth/login — FR-AUTH-001.
 *
 * A failure is recorded here rather than in the service because `login_failed` is an activity row and
 * activity rows are a property of the request. The service throws; this handler labels the request
 * before letting the error travel on to `errorHandler`.
 */
async function login(req, res) {
  const { identifier, password, returnRefreshToken } = req.body;

  try {
    const session = await authService.login({ identifier, password }, { ip: req.ip });

    describeActivity(req, {
      action: ACTIVITY_ACTIONS.LOGIN,
      entityType: 'user',
      entityId: session.user.id,
      description: `${session.user.name} signed in`,
      /*
       * Login is public, so `activityAudit` has no `req.user` to derive attribution from and the row
       * would name nobody. See `authService.activityActor`.
       */
      actor: authService.activityActor(session.user),
    });

    const body = publishSession(req, res, session, { includeRefreshToken: returnRefreshToken });

    return ApiResponse.ok(res, body, {
      message: session.user.must_change_password
        ? 'You must change your password before continuing.'
        : 'Signed in.',
    });
  } catch (err) {
    describeActivity(req, {
      action: ACTIVITY_ACTIONS.LOGIN_FAILED,
      entityType: 'user',
      /*
       * The identifier that was tried, and nothing else. Never the password — `activity_logs.metadata`
       * is a readable column, and a mistyped password is very often a real password.
       *
       * No `actor` either, deliberately. The service throws without saying whether the identifier
       * matched anything, so the only honest attribution is the identifier itself, in the metadata; a
       * `user_id` here would turn the trail into a record of which guessed addresses exist.
       */
      description: 'Failed sign-in attempt',
      metadata: { identifier: String(identifier || '').slice(0, 180), reason: err.code || null },
    });
    throw err;
  }
}

/**
 * POST /auth/refresh — FR-AUTH-003.
 *
 * Reads the cookie first and the body second. A browser has the cookie and sends an empty body; a
 * native client sends the body and has no cookie. Preferring the cookie means a browser cannot be
 * tricked into refreshing someone else's session by a body a script planted, since the cookie it
 * actually holds wins.
 */
async function refresh(req, res) {
  const fromCookie = req.cookies ? req.cookies[config.security.refreshCookieName] : null;
  const token = fromCookie || req.body.refreshToken;

  const session = await authService.refresh(token);

  /* A client that refreshed from the body gets the new token the same way. */
  const body = publishSession(req, res, session, { includeRefreshToken: !fromCookie });

  return ApiResponse.ok(res, body, { message: 'Session renewed.' });
}

/**
 * POST /auth/logout — FR-AUTH-002.
 *
 * Authenticated, so the account whose session ends is the one that asked. The cookies are cleared
 * whatever the service found, because the client's copy is exactly what logout is for.
 */
async function logout(req, res) {
  await authService.logout(req.user.id);

  res.clearCookie(config.security.refreshCookieName, clearRefreshCookieOptions());
  clearCsrfToken(res);

  describeActivity(req, {
    action: ACTIVITY_ACTIONS.LOGOUT,
    entityType: 'user',
    entityId: req.user.id,
    description: `${req.user.name} signed out`,
  });

  return ApiResponse.ok(res, null, { message: 'Signed out.' });
}

/**
 * POST /auth/forgot-password — FR-AUTH-005, step one.
 *
 * 202 and the same message every time. The service's return value is not consulted; it exists for the
 * log. See the header.
 */
async function forgotPassword(req, res) {
  await authService.forgotPassword(req.body.email);

  return ApiResponse.ok(res, null, {
    status: 202,
    message: 'If that address belongs to an account, a reset link is on its way.',
  });
}

/**
 * POST /auth/reset-password — FR-AUTH-005, step two.
 *
 * No session is issued. The caller arrived from an email client holding only a token, so signing them
 * in would mean treating possession of a link as possession of the account — and the point of ending
 * every session here is that a stolen link cannot become a live session. They sign in normally.
 */
async function resetPassword(req, res) {
  const result = await authService.resetPassword(req.body, req);

  describeActivity(req, {
    /*
     * `update`, not a dedicated `password_reset`. `activity_logs.action` is an ENUM fixed by the
     * migration, and `ACTIVITY_ACTIONS` has no password action — inventing one here would insert a
     * value the column cannot hold. The description carries what happened.
     */
    action: ACTIVITY_ACTIONS.UPDATE,
    entityType: 'user',
    entityId: result.userId,
    description: 'Password reset from an emailed link',
    /* Public route — the service hands back who the token turned out to belong to. */
    actor: result.actor,
  });

  /* Any session on this browser is dead now; clear its cookie so the client does not retry with it. */
  res.clearCookie(config.security.refreshCookieName, clearRefreshCookieOptions());

  return ApiResponse.ok(res, null, {
    message: 'Your password has been changed. Please sign in.',
  });
}

/**
 * POST /auth/change-password.
 *
 * Returns a new session, so the caller stays signed in — see the service on why the old token cannot
 * survive. This is also the endpoint that clears `must_change_password`, which is why `app.js`
 * allow-lists its path in `enforcePasswordChange`.
 */
async function changePassword(req, res) {
  const session = await authService.changePassword(req.user, req.body, req);

  describeActivity(req, {
    /* See the note in `resetPassword` — the ENUM has no password action. */
    action: ACTIVITY_ACTIONS.UPDATE,
    entityType: 'user',
    entityId: req.user.id,
    description: `${req.user.name} changed their password`,
  });

  const body = publishSession(req, res, session);

  return ApiResponse.ok(res, body, { message: 'Your password has been changed.' });
}

/**
 * POST /auth/verify-email — FR-AUTH-006.
 *
 * Public: the link is opened from a mail client with no token. It carries its own proof.
 */
async function verifyEmail(req, res) {
  const result = await authService.verifyEmail(req.body.token, req);

  describeActivity(req, {
    action: ACTIVITY_ACTIONS.UPDATE,
    entityType: 'user',
    entityId: result.userId,
    description: 'Email address verified',
    /* Public route, as above. */
    actor: result.actor,
  });

  return ApiResponse.ok(res, { email: result.email }, {
    message: 'Your email address has been confirmed.',
  });
}

/**
 * POST /auth/resend-verification — FR-AUTH-006.
 *
 * Authenticated, and it mails the caller's own address; the body is empty by schema. An account that
 * is already verified gets a 200 saying so rather than an error — asking to confirm something already
 * confirmed is not a client mistake.
 */
async function resendVerification(req, res) {
  const result = await authService.resendVerification(req.user);

  return ApiResponse.ok(res, { alreadyVerified: Boolean(result.alreadyVerified) }, {
    message: result.alreadyVerified
      ? 'This address is already confirmed.'
      : 'A confirmation link is on its way.',
  });
}

/**
 * GET /auth/me — FR-AUTH-009's client half.
 *
 * The one call the frontend makes on load. Permissions come from the database, not from the access
 * token's claim, so a role edited two minutes ago is reflected without waiting for the token to
 * expire.
 */
async function me(req, res) {
  const profile = await authService.profile(req);
  return ApiResponse.ok(res, profile);
}

module.exports = {
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  verifyEmail,
  resendVerification,
  me,

  /* Exported for the verification suite, which asserts the cookie's attributes directly. */
  refreshCookieOptions,
  clearRefreshCookieOptions,
  refreshCookiePath,
};
