'use strict';

/**
 * System routes — mounted on `/api/v1` *before* the authentication chain.
 *
 * The only public routes in the API. Everything else sits behind `authenticate`, and the boundary
 * between the two is drawn once, in `app.js`, rather than route by route.
 *
 * `/csrf-token` is here rather than in the auth module for a specific reason: it has to be callable
 * by a browser that holds a valid refresh cookie but has nothing in memory — no access token, no
 * CSRF token — which is exactly the state a page reload leaves it in. Requiring authentication to
 * obtain the token needed to refresh authentication would deadlock that case.
 */

const { createRouter } = require('../../utils/createRouter');
const { asyncHandler, attachCsrfToken } = require('../../middlewares');
const ApiResponse = require('../../utils/ApiResponse');
const controller = require('./system.controller');

const router = createRouter();

router.get('/health', controller.health);
router.get('/health/ready', asyncHandler(controller.ready));
router.get('/meta', controller.meta);

/**
 * Issue a CSRF token.
 *
 * `attachCsrfToken()` sets the cookie and leaves the value on `req.csrfToken`; it is returned in the
 * body as well so a client can hold it without having to read the cookie back. When
 * `security.csrfEnabled` is false the middleware is a no-op, so `token` is null and the client can
 * see that the protection is off rather than receive a token that means nothing.
 */
router.get('/csrf-token', attachCsrfToken(), (req, res) =>
  ApiResponse.ok(res, { token: req.csrfToken || null })
);

module.exports = router;
