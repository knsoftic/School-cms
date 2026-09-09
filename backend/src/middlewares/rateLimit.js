'use strict';

/**
 * Rate limiting — SRS §24, FR-SEC-005 "API Security & Rate Limiting".
 *
 * The SRS states the requirement without numbers: "System applies Rate Limiting to API requests",
 * outcome "API endpoints are protected from abuse and unauthorized use." The thresholds are therefore
 * configuration, not code — `RATE_LIMIT_*` in .env — so a deployment can tune them without a release.
 *
 * ## What a request is counted against
 *
 * An authenticated request counts against its user, an anonymous one against its client address. This
 * matters in a school: a computer lab behind one NAT address is dozens of pupils sharing one public
 * IP, and keying purely on address would have the first user exhaust the window for everyone else.
 * Once a request carries a token there is a better identity available, so it is used.
 *
 * IPv6 addresses are collapsed to their /64 routing prefix. A single host is routinely given a whole
 * /64, so keying on the full address would let one client walk through 18 quintillion fresh quotas.
 *
 * ## Trust proxy
 *
 * `req.ip` is only meaningful if Express's `trust proxy` matches the deployment — see `TRUST_PROXY` in
 * .env.example. Set too permissively, a caller forges `X-Forwarded-For` and mints a new quota per
 * request; left unset behind a real proxy, every client collapses onto the proxy's address. The first
 * request through a limiter warns if the setting is the wholly permissive `true`.
 *
 * ## Known limitation
 *
 * The store is `express-rate-limit`'s in-memory one, so counters are per process. A single-process
 * deployment (what SRS §3 describes) is exactly counted; behind N workers the effective ceiling is
 * N × the configured limit. A shared store would need `rate-limit-redis`, which is not a dependency of
 * this project, so this is recorded rather than implied to be handled.
 */

const { isIP } = require('net');
const { rateLimit } = require('express-rate-limit');

const ApiError = require('../utils/ApiError');
const config = require('../config/env');
const logger = require('../config/logger');

const MINUTE = 60 * 1000;

/** Warned at most once per process — a repeated warning on a hot path is just noise. */
let trustProxyWarned = false;

/**
 * Expand an IPv6 address to its eight groups, in one canonical spelling.
 *
 * `2001:db8::1` has to become eight groups before a prefix can be taken from it; slicing the
 * compressed form would read `db8` as the second group of a `/64` that is really `2001:db8:0:0`.
 * Leading zeros are dropped and the zone index removed for the same reason: behind a trusted proxy
 * the address is client-supplied text, and `2001:db8::1` and `2001:0db8:0000:0000::1` must not count
 * as two different clients.
 *
 * @param {string} address
 * @returns {string[]}
 */
function expandIpv6(address) {
  /* A scope such as %eth0 identifies an interface, not a client. */
  const lowered = address.toLowerCase().split('%')[0];

  const groups = (() => {
    if (!lowered.includes('::')) return lowered.split(':');

    const [head, tail] = lowered.split('::');
    const headGroups = head ? head.split(':') : [];
    const tailGroups = tail ? tail.split(':') : [];
    const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);

    return [...headGroups, ...Array(missing).fill('0'), ...tailGroups];
  })();

  return groups.map((group) => (group === '' ? '0' : group.replace(/^0+(?=.)/, '')));
}

/**
 * The client address, normalised into something worth counting against.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function clientAddress(req) {
  const raw = String(req.ip || (req.socket && req.socket.remoteAddress) || '').trim();
  if (!raw) return 'unknown';

  /* Node reports IPv4 clients on a dual-stack socket as ::ffff:203.0.113.4. */
  const address = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;

  if (isIP(address) === 4) return address;

  /*
   * Anything unparseable is keyed verbatim rather than dropped. Counting an odd address coarsely is
   * better than handing every such request an unlimited quota.
   */
  if (isIP(address) !== 6) return address;

  return `${expandIpv6(address).slice(0, 4).join(':')}::/64`;
}

/**
 * Who this request is counted against: the authenticated user if there is one, else the address.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function clientKey(req) {
  if (!trustProxyWarned && req.app && req.app.get('trust proxy') === true) {
    trustProxyWarned = true;
    logger.warn(
      'Express "trust proxy" is true, so X-Forwarded-For can be forged and IP rate limiting bypassed. ' +
        'Set TRUST_PROXY to a hop count (for example 1) instead.'
    );
  }

  if (req.user && req.user.id) return `user:${req.user.id}`;
  return `ip:${clientAddress(req)}`;
}

/** A limiter that has been switched off still has to be mountable. */
function passthrough(req, res, next) {
  next();
}

/**
 * Refuse with the project's error envelope rather than express-rate-limit's plain-text body.
 *
 * @param {string} scope     which limiter refused, for the log and the response details
 * @param {number} windowMs  fallback for `Retry-After` if the store gave no reset time
 * @returns {import('express').RequestHandler}
 */
function refuse(scope, windowMs) {
  return function rateLimitRefusal(req, res, next) {
    const reset = req.rateLimit && req.rateLimit.resetTime;
    const retryAfterSeconds = reset
      ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000))
      : Math.ceil(windowMs / 1000);

    /*
     * Logged at warn: a limiter firing is either an attack or a client bug, and both are worth
     * seeing. The key is included because it is the only way to tell those two apart afterwards.
     */
    logger.warn('Rate limit exceeded', {
      requestId: req.id,
      scope,
      method: req.method,
      path: req.originalUrl,
      key: clientKey(req),
      limit: req.rateLimit ? req.rateLimit.limit : null,
    });

    res.set('Retry-After', String(retryAfterSeconds));

    return next(
      new ApiError(429, 'Too many requests. Please wait a moment and try again.', {
        code: 'RATE_LIMIT_EXCEEDED',
        details: { scope, retryAfterSeconds },
      })
    );
  };
}

/**
 * Build a limiter.
 *
 * @param {object} options
 * @param {string} options.name                       identifies the limiter in logs and responses
 * @param {number} options.windowMs                   length of the window
 * @param {number} options.limit                      requests permitted per key per window
 * @param {boolean} [options.skipSuccessfulRequests]  count only failures — for credential endpoints
 * @param {(req: import('express').Request) => boolean} [options.skip]
 * @returns {import('express').RequestHandler}
 */
function createRateLimiter(options = {}) {
  const { name, windowMs, limit } = options;

  if (!name || typeof name !== 'string') {
    throw new Error('createRateLimiter() requires a name');
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`createRateLimiter('${name}'): windowMs must be a positive number`);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`createRateLimiter('${name}'): limit must be a positive integer`);
  }

  /*
   * Disabled wholesale under NODE_ENV=test. A suite that makes 30 assertions against one endpoint is
   * not abuse, and a limiter that leaks state between test cases makes failures depend on test order.
   */
  if (!config.rateLimit.enabled) return passthrough;

  return rateLimit({
    windowMs,
    limit,
    keyGenerator: clientKey,
    handler: refuse(name, windowMs),
    skip: options.skip,
    skipSuccessfulRequests: Boolean(options.skipSuccessfulRequests),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
}

/** Every API request. Mounted on the API root, before authentication. */
const apiLimiter = createRateLimiter({
  name: 'api',
  windowMs: config.rateLimit.windowMinutes * MINUTE,
  limit: config.rateLimit.max,
});

/**
 * Credential endpoints — login, refresh, forgot/reset password, email verification.
 *
 * Successful requests are not counted. The point is to slow guessing, and a member of staff who
 * signs in correctly on ten devices has done nothing that needs slowing down.
 */
const authLimiter = createRateLimiter({
  name: 'auth',
  windowMs: config.rateLimit.windowMinutes * MINUTE,
  limit: config.rateLimit.authMax,
  skipSuccessfulRequests: true,
});

/**
 * AI endpoints (SRS §21).
 *
 * Separate and tighter because each request is slow and costs money upstream. This is a request-rate
 * ceiling, not the plan's `ai_limit` quota — that is entitlement, enforced by `enforceLimit`.
 */
const aiLimiter = createRateLimiter({
  name: 'ai',
  windowMs: config.rateLimit.windowMinutes * MINUTE,
  limit: config.rateLimit.aiMax,
});

module.exports = {
  createRateLimiter,
  apiLimiter,
  authLimiter,
  aiLimiter,
  clientKey,
  clientAddress,
};
