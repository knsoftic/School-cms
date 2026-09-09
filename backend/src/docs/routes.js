/**
 * The §28 documentation surface — `GET /docs` and `GET /docs/openapi.json`.
 *
 * Two endpoints, because the two audiences are different: a person opens the Swagger UI and reads
 * it, and a tool fetches the JSON and generates a client from it. §28 names Swagger *and* OpenAPI,
 * and these are the two halves of that.
 *
 * ## Built once, on first request, not at boot
 *
 * `buildDocument()` reads the mounted Express stack — so it cannot run while that stack is still
 * being assembled, and this router is mounted partway through `buildApiRouter()`. Deferring to the
 * first request is not laziness for its own sake: at that point the application is completely
 * mounted by definition, because it is serving.
 *
 * The result is cached for the life of the process. Routes cannot change after boot, so a second
 * walk would produce a byte-identical document; `?refresh=1` forces a rebuild anyway, which is what
 * makes the cache observable rather than something to be taken on trust.
 *
 * ## Why this is public
 *
 * §28 asks for documentation that is "available", and names no audience or restriction. What the
 * document contains is the API's own shape — paths, methods, field names, permission keys — all of
 * which any authorised client already holds, and none of which is tenant data: the generator reads
 * routes and Joi schemas, and never touches the database. Putting it behind `authenticate` would
 * also make it unreadable by the tools that consume OpenAPI, which is most of the point of emitting
 * it.
 *
 * The one thing it does reveal to an anonymous reader is the permission and module vocabulary. That
 * is a deliberate, stated trade, not an oversight — a deployment that would rather not publish it
 * can stop mounting this router without touching anything else, since nothing else imports it.
 */

const express = require('express');
const swaggerUi = require('swagger-ui-express');

const { buildDocument } = require('./openapi');

const router = express.Router();

let cached = null;

/**
 * The document for this process, built on first use.
 *
 * @param {import('express').Express} app
 * @param {boolean} refresh  rebuild even if cached
 * @returns {object}
 */
function documentFor(app, refresh) {
  if (!cached || refresh) cached = buildDocument(app);
  return cached;
}

/** Discard the cached document. Exists for the suites, which mount more than one app per process. */
function resetCache() {
  cached = null;
}

/*
 * The machine-readable half. Served as JSON with no envelope: `ApiResponse`'s `{ success, data }`
 * wrapper is this API's own convention, and an OpenAPI document wrapped in it would not be an
 * OpenAPI document any more — every generator reads the root object.
 */
router.get('/openapi.json', (req, res) => {
  res.json(documentFor(req.app, req.query.refresh === '1'));
});

/*
 * The human half. `swaggerUi.serve` is static asset middleware; `setup` renders the page. The
 * document is resolved per request rather than captured here, for the mounting-order reason above.
 */
router.use(
  '/',
  swaggerUi.serve,
  (req, res, next) => {
    swaggerUi.setup(documentFor(req.app, false), {
      customSiteTitle: 'School Management System API',
      swaggerOptions: { docExpansion: 'none', filter: true, persistAuthorization: true },
    })(req, res, next);
  }
);

module.exports = { router, documentFor, resetCache };
