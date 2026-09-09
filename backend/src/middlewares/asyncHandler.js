'use strict';

/**
 * Async route/middleware wrapper.
 *
 * Express 4 does not await handler return values, so a rejected promise inside an `async`
 * handler becomes an unhandled rejection and the client hangs until timeout. Every async
 * handler is wrapped so its rejection reaches `errorHandler` as a normal `next(err)`.
 *
 * Express 5 handles this natively; keeping the wrapper explicit means the upgrade is a
 * deletion rather than a behavioural change.
 *
 * Every argument is forwarded, not just the first three. Express calls a `router.param()` callback
 * with `(req, res, next, value, name)`, so a wrapper fixed at three parameters would hand the
 * callback `value === undefined` — and a tenant guard that reads an undefined id lets every request
 * through while looking like it ran. That failure is silent, which is the worst kind here.
 */

/**
 * @param {(...args: any[]) => any} fn  a handler, or a `router.param()` callback
 * @returns {import('express').RequestHandler}
 */
function asyncHandler(fn) {
  return function wrappedAsyncHandler(...args) {
    /*
     * `next` is the third argument for handlers and for param callbacks alike. Error-handling
     * middleware — `(err, req, res, next)` — is deliberately not wrapped: Express identifies it by
     * `fn.length === 4`, and a rest-parameter wrapper reports a length of 0.
     */
    const next = args[2];
    Promise.resolve(fn(...args)).catch(next);
  };
}

module.exports = asyncHandler;
