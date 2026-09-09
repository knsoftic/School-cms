'use strict';

/**
 * Auth routes — SRS §7.
 *
 * ## Why this file exports two routers
 *
 * The endpoints in §7 divide cleanly by whether the caller already holds a token:
 *
 *   public     login, refresh, forgot-password, reset-password, verify-email
 *   protected  logout, change-password, resend-verification, me
 *
 * `buildApiRouter()` in `app.js` mounts `authenticate → enforcePasswordChange → resolveTenant →
 * enforceTenant` once, at the boundary, for everything below it. A public route cannot sit below that
 * chain — `authenticate` would reject it — and a protected route must not sit above it, because then
 * nothing would populate `req.user`. So the module hands `app.js` both halves and `app.js` mounts each
 * at the right point. The alternative, one router with `authenticate` sprinkled per route, is how a
 * route ends up unauthenticated because somebody forgot a line.
 *
 * `/auth/change-password` and `/auth/logout` in particular *must* be below the chain: `app.js` names
 * those two paths in `enforcePasswordChange({ allow: [...] })`, and a user with
 * `must_change_password` set — which the bootstrap Super Admin has — can reach nothing else. If they
 * were mounted above the chain, `req.user` would be undefined and the handlers would throw.
 *
 * ## What guards each route
 *
 *   authLimiter        On the five public routes only. They are the credential-guessing and
 *                      mail-triggering surfaces; 20 requests per 15 minutes per IP by default.
 *                      Not on the protected routes — the caller there already authenticated, and
 *                      `apiLimiter` covers them.
 *   requireCsrfToken   On refresh and logout: the two routes whose authority can come from a cookie
 *                      rather than from a header. Every other route needs an `Authorization` header,
 *                      which a cross-site form cannot set, so CSRF does not apply to them.
 *   validate           On every route with a body. `login` has no `params` or `query` schema because
 *                      it has neither.
 *
 * ## Not on refresh: `authenticate`
 *
 * Refresh exists precisely for the case where the access token has expired, so requiring a valid one
 * would make the endpoint unreachable exactly when it is needed. Its authority is the refresh token,
 * which the service verifies against the stored hash.
 */

const { createRouter } = require('../../utils/createRouter');
const asyncHandler = require('../../middlewares/asyncHandler');
const { validate } = require('../../middlewares/validate');
const { authLimiter } = require('../../middlewares/rateLimit');
const { requireCsrfToken } = require('../../middlewares/csrf');
const controller = require('./auth.controller');
const { schemas } = require('./auth.validation');

/* ─────────────────────────── public ─────────────────────────── */

const publicRoutes = createRouter();

/** FR-AUTH-001. */
publicRoutes.post(
  '/login',
  authLimiter,
  validate({ body: schemas.login }),
  asyncHandler(controller.login)
);

/**
 * FR-AUTH-003.
 *
 * Rate-limited like the others. A refresh token is a credential, so an endpoint that accepts one is a
 * surface worth bounding — and the reuse defence in the service ends a session on the first
 * mismatch, which a client retrying in a loop would otherwise trip repeatedly.
 */
publicRoutes.post(
  '/refresh',
  authLimiter,
  requireCsrfToken(),
  validate({ body: schemas.refresh }),
  asyncHandler(controller.refresh)
);

/** FR-AUTH-005, step one. Always answers 202 — see the controller. */
publicRoutes.post(
  '/forgot-password',
  authLimiter,
  validate({ body: schemas.forgotPassword }),
  asyncHandler(controller.forgotPassword)
);

/** FR-AUTH-005, step two. */
publicRoutes.post(
  '/reset-password',
  authLimiter,
  validate({ body: schemas.resetPassword }),
  asyncHandler(controller.resetPassword)
);

/**
 * FR-AUTH-006.
 *
 * POST rather than GET, even though the link in the email is a URL. The email link points at the
 * frontend, which reads the token from its query string and POSTs it here — so the token never
 * reaches this server in a URL, where it would be recorded verbatim in the access log and in any
 * proxy between the two. A GET would also be prefetchable by a mail client, which would consume the
 * token before the user clicked it.
 */
publicRoutes.post(
  '/verify-email',
  authLimiter,
  validate({ body: schemas.verifyEmail }),
  asyncHandler(controller.verifyEmail)
);

/* ───────────────────────── authenticated ───────────────────────── */

const protectedRoutes = createRouter();

/** FR-AUTH-002. Allow-listed in `enforcePasswordChange` — a user must be able to walk away. */
protectedRoutes.post('/logout', requireCsrfToken(), asyncHandler(controller.logout));

/** Allow-listed in `enforcePasswordChange`; this is the call that clears the flag. */
protectedRoutes.post(
  '/change-password',
  validate({ body: schemas.changePassword }),
  asyncHandler(controller.changePassword)
);

/** FR-AUTH-006 — a new link for the caller's own address. */
protectedRoutes.post(
  '/resend-verification',
  authLimiter,
  validate({ body: schemas.resendVerification }),
  asyncHandler(controller.resendVerification)
);

/** The frontend's first call after a page load. */
protectedRoutes.get('/me', asyncHandler(controller.me));

module.exports = { publicRoutes, protectedRoutes };
