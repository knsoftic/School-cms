/**
 * Route metadata — what a middleware knows about itself.
 *
 * SRS §28 requires the API to document, for every endpoint, its Endpoint, Method, Authentication,
 * Parameters, Request Body, Response and Error Response. Five of those seven are decided by the
 * middleware a route mounts: `validate()` holds the parameters and the request body, the permission
 * guards and `authenticate` hold the authentication, and `requireModule()`/`enforceLimit()` decide
 * two of the error responses that are otherwise invisible.
 *
 * All of that is already written down — in the route files, as arguments to middleware factories.
 * The problem is that a factory returns a closure, and a closure's arguments are unreachable from
 * outside it. So each factory hangs its arguments on the function it returns, and the OpenAPI
 * generator reads them back off the mounted Express stack.
 *
 * **Why not JSDoc annotations, which is what `swagger-jsdoc` is for.** 252 routes times seven fields
 * is a second copy of the routing table maintained by hand, and §28's expected outcome is "complete,
 * *accurate*" documentation. A hand-written annotation is accurate on the day it is written and
 * silently wrong after the first change nobody mirrored. Metadata read off the mounted application
 * cannot drift from the mounted application: if a route gains a permission, the document gains it in
 * the same commit, because they are the same fact read twice.
 *
 * The property is non-enumerable so that nothing which inspects, copies, spreads or serialises a
 * middleware — Express itself included — sees it. It is documentation, not behaviour.
 */

const KEY = 'openapi';

/**
 * Record what a middleware was built from, and return the middleware unchanged.
 *
 * Merges rather than replaces: `asyncHandler` wrappers and guards that annotate in two places would
 * otherwise silently drop whichever tag ran first.
 *
 * @param {Function} fn    the middleware to annotate
 * @param {object}   meta  facts about the route this middleware imposes
 * @returns {Function} `fn`
 */
function annotate(fn, meta) {
  if (typeof fn !== 'function') {
    throw new TypeError('annotate() requires a middleware function');
  }

  const existing = Object.prototype.hasOwnProperty.call(fn, KEY) ? fn[KEY] : null;

  Object.defineProperty(fn, KEY, {
    value: Object.freeze({ ...(existing || {}), ...meta }),
    enumerable: false,
    configurable: true,
    writable: false,
  });

  return fn;
}

/**
 * Mark a route's final handler as answering with a file rather than the JSON envelope — §28's
 * "Response" for the endpoints that stream bytes.
 *
 * The one fact here a guard cannot supply. Every other annotation hangs on a middleware built from the
 * very arguments it records; a controller that sends a PDF was built from nothing, so the route file
 * states it beside the handler — from the same constants the handler sends by (`UPLOAD_RULES` for a
 * stored file, the reports export table for an export), so the MIME types cannot disagree with it.
 * That it is stated at all is the part that could drift, and `verify-openapi.js` lists every file
 * endpoint to hold it in place.
 *
 * @param {Function} handler  the route's final handler, as mounted (already `asyncHandler`-wrapped)
 * @param {object} spec
 * @param {string[]} spec.types  the Content-Types the file can arrive as
 * @param {string} [spec.when]   the query condition that selects the file; when given, the JSON
 *                               envelope is the answer otherwise
 * @returns {Function} `handler`
 */
function respondsWithFile(handler, spec) {
  if (!spec || !Array.isArray(spec.types) || !spec.types.length) {
    throw new TypeError('respondsWithFile() requires at least one Content-Type');
  }
  return annotate(handler, { file: { types: [...spec.types], when: spec.when || null } });
}

/**
 * Read a middleware's metadata, or `null` for the many middleware that carry none.
 *
 * @param {Function} fn
 * @returns {object|null}
 */
function metaOf(fn) {
  if (typeof fn !== 'function') return null;
  const meta = fn[KEY];
  return meta && typeof meta === 'object' ? meta : null;
}

module.exports = { annotate, respondsWithFile, metaOf, KEY };
