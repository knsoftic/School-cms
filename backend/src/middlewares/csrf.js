'use strict';

/**
 * CSRF protection — SRS §24 "CSRF protection/testing".
 *
 * ## Why this is scoped, not global
 *
 * CSRF is only possible where a browser attaches credentials to a cross-site request by itself. This
 * API authenticates with a bearer token that the frontend holds in memory (see ARCHITECTURE §8), and no
 * cross-site page can make the browser send an `Authorization` header — so the overwhelming majority of
 * endpoints are not exposed. What *is* exposed is the one credential kept in a cookie: the refresh
 * token. `POST /auth/refresh` and `POST /auth/logout` are reachable with the victim's cookie attached
 * automatically, so those are what this guards.
 *
 * Mounting it globally instead would look stronger and be worse: every non-browser caller — a payment
 * gateway webhook, a cron job, an integration — would need a token it has no way to obtain, and the
 * usual way that gets resolved in a hurry is by turning the protection off.
 *
 * ## Double-submit
 *
 * A random token is set as a readable cookie and must be echoed in the `X-CSRF-Token` header. Two
 * things have to hold for a request to pass, and an attacker's page can do neither:
 *
 *  1. Send a custom header. That makes the request non-simple, so the browser preflights it, and the
 *     CORS allow-list refuses an origin that is not ours. This is the primary defence.
 *  2. Know the cookie's value. Same-origin policy keeps the attacker's script from reading it.
 *
 * No server-side state is involved, which matters because `/auth/refresh` runs before authentication —
 * there is no session yet to hang a token on.
 *
 * The comparison is constant-time. A byte-by-byte `===` on a secret leaks its prefix through timing,
 * and this token is a secret for as long as the cookie lives.
 */

const crypto = require('crypto');

const ApiError = require('../utils/ApiError');
const config = require('../config/env');
const logger = require('../config/logger');

/** Methods that must not change state, so they need no token — RFC 9110 §9.2.1. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const HEADER = 'x-csrf-token';
const TOKEN_BYTES = 32;

/**
 * The cookie the token is published in.
 *
 * Deliberately *not* `httpOnly`: the frontend has to read it to echo it back. That is safe — the token
 * is not a credential on its own, it only proves the request came from a page that could read our
 * cookie, and the refresh token it protects stays `httpOnly`.
 */
function cookieOptions() {
  return {
    httpOnly: false,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
  };
}

/**
 * Mint a token and publish it.
 *
 * Called from the auth module wherever a session begins or is renewed — login, refresh — so the
 * frontend always has a current one.
 *
 * @param {import('express').Response} res
 * @returns {string} the token, in case the caller also wants it in the response body
 */
function issueCsrfToken(res) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  res.cookie(config.security.csrfCookieName, token, cookieOptions());
  return token;
}

/**
 * Remove the token, for logout.
 *
 * @param {import('express').Response} res
 */
function clearCsrfToken(res) {
  res.clearCookie(config.security.csrfCookieName, cookieOptions());
}

/**
 * Constant-time equality for two secrets of unknown length.
 *
 * Both sides are hashed first because `timingSafeEqual` throws on a length mismatch, and throwing on
 * mismatched lengths would itself leak the length.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function secretsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

/**
 * Require a valid double-submit token on state-changing requests.
 *
 * Mount on the cookie-authenticated endpoints only — refresh and logout.
 *
 * @returns {import('express').RequestHandler}
 */
function requireCsrfToken() {
  return function csrfGuard(req, res, next) {
    /*
     * Off under NODE_ENV=test by default, because a suite drives these endpoints directly with no
     * browser to hold a cookie. `CSRF_ENABLED` can force it on to test the guard itself.
     */
    if (!config.security.csrfEnabled) return next();

    if (SAFE_METHODS.has(req.method)) return next();

    if (!req.cookies) {
      /*
       * `cookie-parser` is not mounted. Failing open here would silently disable the protection, and
       * a missing middleware is our defect, not the caller's.
       */
      logger.error('requireCsrfToken ran without cookie-parser mounted', {
        requestId: req.id,
        path: req.originalUrl,
      });
      throw ApiError.internal();
    }

    const cookieToken = req.cookies[config.security.csrfCookieName];
    const headerToken = req.get(HEADER);

    if (!cookieToken || !headerToken || !secretsMatch(cookieToken, headerToken)) {
      logger.warn('CSRF check failed', {
        requestId: req.id,
        method: req.method,
        path: req.originalUrl,
        hasCookie: Boolean(cookieToken),
        hasHeader: Boolean(headerToken),
      });

      /*
       * One message for all three cases — no cookie, no header, mismatch. Distinguishing them would
       * tell an attacker which half they are missing, and a legitimate client's remedy is the same
       * either way: sign in again to get a fresh token.
       */
      throw new ApiError(403, 'This request could not be verified. Please refresh and try again.', {
        code: 'CSRF_TOKEN_INVALID',
      });
    }

    return next();
  };
}

/**
 * Publish a token without requiring one.
 *
 * For a browser that has a valid refresh cookie from a previous visit but no token in memory — it
 * calls a GET endpoint carrying this, and gets a usable token back.
 *
 * @returns {import('express').RequestHandler}
 */
function attachCsrfToken() {
  return function csrfIssuer(req, res, next) {
    if (!config.security.csrfEnabled) return next();
    req.csrfToken = issueCsrfToken(res);
    return next();
  };
}

module.exports = {
  requireCsrfToken,
  attachCsrfToken,
  issueCsrfToken,
  clearCsrfToken,
  secretsMatch,
  SAFE_METHODS,
  HEADER,
};
