/**
 * The OpenAPI document — SRS §28, FR-APIDOC-001.
 *
 * §28 requires the API to be documented via Swagger / OpenAPI, and fixes exactly what each endpoint
 * must state: **Endpoint, Method, Authentication, Parameters, Request Body, Response and Error
 * Response.** Nothing else is asked for, and nothing else is invented here.
 *
 * ## Why this is generated rather than written
 *
 * `swagger-jsdoc` — a dependency of this project since `package.json` was first written, and used by
 * nothing until now — expects those seven fields as JSDoc comments above each route. That is 252
 * endpoints times seven fields: a second copy of the routing table, maintained by hand, whose only
 * relationship to the first copy is that somebody remembered. §28's expected outcome is "complete,
 * **accurate** API documentation", and a hand-written annotation is accurate on the day it is
 * written and quietly wrong after the first change nobody mirrored.
 *
 * So the document is read off the mounted application instead. Six of the seven fields are already
 * stated somewhere the code enforces them:
 *
 * | §28 field | Where it comes from | Can it drift? |
 * |---|---|---|
 * | Endpoint | the Express route path | no |
 * | Method | the Express route method | no |
 * | Authentication | position relative to the annotated `authenticate` layer, plus the permission guard's own keys | no |
 * | Parameters | `validate()`'s `params` and `query` schemas, plus path placeholders | no |
 * | Request Body | `validate()`'s `body` schema, or the upload middleware | no |
 * | Error Response | the guards actually mounted, plus the envelope `errorHandler` guarantees | no |
 * | Response | **the one field with no machine-readable source** | see below |
 *
 * ## The seventh field, stated honestly
 *
 * A controller's success payload is built by hand and returned through `ApiResponse`; there is no
 * schema for it anywhere, because nothing validates responses on the way out. So the response
 * documented here is the **envelope** — `{ success: true, data, meta? }` — which is guaranteed for
 * every endpoint by `ApiResponse`, together with the status code the route actually sets.
 *
 * The shape of `data` is *not* described, and that is a real limitation rather than an oversight.
 * Describing it would mean writing 252 payload schemas by hand — reintroducing exactly the drift
 * this design exists to avoid, and in the one place nothing would catch it, since no test compares a
 * response against a schema. An honest `data: {}` with a note beats 252 confident fictions. Closing
 * it properly means response schemas the application validates against, which is a change to how
 * controllers return data, not to how they are documented.
 */

const { metaOf } = require('../utils/routeMeta');
const { fromJoi } = require('./joiSchema');
const config = require('../config/env');
const { version } = require('../../package.json');

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/* ═══════════════════════════ the pieces every endpoint shares ═══════════════════════════ */

/**
 * The failure envelope, guaranteed by `errorHandler` for every route in the application.
 *
 * `errorHandler` is the single exit for every failure — an untranslated driver error becomes a flat
 * 500 there rather than reaching a client — so this shape is not a convention that a route might
 * depart from. It is the only thing a caller can receive when something goes wrong.
 */
const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean', enum: [false] },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Stable machine-readable failure code' },
        message: { type: 'string' },
        details: {
          type: 'array',
          description: 'Present on 422: one entry per field that failed validation',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              location: { type: 'string', enum: ['body', 'query', 'params', 'headers'] },
              message: { type: 'string' },
              type: { type: 'string' },
            },
          },
        },
      },
      required: ['code', 'message'],
    },
    requestId: {
      type: 'string',
      description: 'Echoed so a user reporting an error gives a token that locates the log line',
    },
  },
  required: ['success', 'error'],
};

/**
 * The success envelope. `data` is intentionally unconstrained — see this file's header.
 */
const SUCCESS_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean', enum: [true] },
    data: {
      description:
        'The payload. Its shape is specific to the endpoint and is not described here: no ' +
        'machine-readable source for it exists, because responses are built by hand and nothing ' +
        'validates them on the way out. See the note in src/docs/openapi.js.',
    },
    /*
     * Transcribed from `ApiResponse.paginated()` rather than from memory, because it was wrong here
     * in a way that would propagate.
     *
     * This block used to describe `meta` as a FLAT object of four keys. The application has never
     * emitted that: `ApiResponse.paginated()` nests everything one level deeper under
     * `meta.pagination` and emits SIX keys, adding `hasNextPage` and `hasPreviousPage`.
     *
     * The error mattered more than a typo would. A client reading this document would look for
     * `meta.totalPages`, find `undefined`, and compute its way to a broken pager — which is exactly
     * what happened to this project's own frontend before the shape was checked against the code:
     * the footer rendered, "Next" produced `NaN`, and it went unnoticed because every collection then
     * fitted on one page. FR-APIDOC-001 asks for documentation that is *accurate*, and an envelope
     * described one level too shallow fails that in the most expensive direction.
     */
    meta: {
      type: 'object',
      description: 'Present on paginated collections.',
      properties: {
        pagination: {
          type: 'object',
          description: 'Emitted by ApiResponse.paginated(). Note the nesting: these keys are NOT on `meta` itself.',
          properties: {
            total: { type: 'integer', description: 'Rows matching the query, not rows on this page.' },
            page: { type: 'integer' },
            limit: { type: 'integer' },
            totalPages: { type: 'integer' },
            hasNextPage: { type: 'boolean' },
            hasPreviousPage: { type: 'boolean' },
          },
        },
      },
    },
    message: { type: 'string' },
  },
  required: ['success'],
};

/** One reusable `$ref`-able error response per status this application can actually produce. */
const ERROR_RESPONSES = {
  BadRequest: [400, 'Malformed request — for example an unparseable JSON body.'],
  Unauthenticated: [401, 'No token, an expired or invalid token, or a session that has ended.'],
  Forbidden: [403, 'Authenticated, but the caller lacks the required permission.'],
  NotFound: [404, 'No such record, or one belonging to another tenant.'],
  Conflict: [409, 'The request contradicts the current state of the resource.'],
  ValidationFailed: [422, 'The request failed schema validation; `error.details` lists each field.'],
  TooManyRequests: [429, 'Rate limit exceeded.'],
  ServerError: [500, 'Unhandled failure. The detail is in the log, not the response.'],
  SubscriptionInactive: [402, "The school's subscription is not in a usable state."],
  ModuleNotSubscribed: [403, "The plan does not include the module this endpoint belongs to."],
  PlanLimitExceeded: [403, 'The action would exceed a plan limit.'],
};

function buildErrorResponses() {
  const responses = {};
  for (const [name, [status, description]] of Object.entries(ERROR_RESPONSES)) {
    responses[name] = {
      description: `${status} — ${description}`,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  return responses;
}

/* ═══════════════════════════════ walking the mounted stack ═══════════════════════════════ */

/**
 * Recover a mount path from the layer's regexp.
 *
 * Express does not keep the string a router was mounted at; it keeps the compiled regexp. For the
 * fixed prefixes this application uses (`/schools`, `/api/v1`) the source is mechanical enough to
 * reverse, and `layer.keys` covers the parameterised case.
 *
 * @param {object} layer
 * @returns {string} a path fragment, or '' for a layer mounted at the root
 */
function mountPathOf(layer) {
  if (!layer.regexp) return '';
  if (layer.regexp.fast_slash) return '';

  const source = layer.regexp.source;
  let path = source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, '{param}');

  /* Restore parameter names, in the order Express recorded them. */
  for (const key of layer.keys || []) {
    path = path.replace('{param}', `{${key.name}}`);
  }

  return path === '/' ? '' : path;
}

/**
 * `/students/:id/marks` → `/students/{id}/marks`.
 *
 * The trailing slash is stripped. A router's own index route has the Express path `/`, so a router
 * mounted at `/students` composes to `/students/` — which Express serves identically to `/students`
 * but which OpenAPI treats as a *different* path, so leaving it in would document a collection
 * endpoint at an address no client would think to write.
 */
function toOpenApiPath(expressPath) {
  const withBraces = String(expressPath).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return withBraces.length > 1 ? withBraces.replace(/\/+$/, '') : withBraces;
}

/**
 * Walk the mounted application, yielding one entry per route.
 *
 * The `authenticated` flag is decided by **position**, not by inspecting each route: the boundary is
 * a single `api.use(authenticate, …)` in `app.js`, and everything mounted after it in the same
 * router is authenticated whether or not it says so. Reading it any other way would report the five
 * public auth endpoints and the health checks as protected, or worse, the reverse.
 *
 * @param {object} router  an Express router (or app `_router`)
 * @param {string} prefix  path accumulated so far
 * @param {boolean} authenticated  whether an `authenticate` layer has already been passed
 * @param {Array} out
 * @returns {Array} `out`
 */
function walk(router, prefix, authenticated, inherited, out) {
  const stack = (router && (router.stack || (router.handle && router.handle.stack))) || [];
  let authed = authenticated;

  /*
   * Guards mounted with `router.use()` rather than on the route itself. Eighteen routers carry their
   * `requireModule()` this way — `library.routes.js:72` is `router.use(requireModule(MODULES.LIBRARY))`
   * — and those layers are siblings of the routes they protect, not members of their stacks. Reading
   * only `route.stack` documented every one of those endpoints as reachable without the module, which
   * is precisely backwards: the module guard is the first thing such a route enforces.
   *
   * Accumulated in mount order and copied on the way down, so a guard applies to the routes declared
   * after it and to nested routers, and not to a sibling router mounted earlier.
   */
  let carried = inherited;

  for (const layer of stack) {
    const meta = metaOf(layer.handle);

    if (meta && meta.authenticates) {
      authed = true;
      continue;
    }

    if (layer.route) {
      const routePath = toOpenApiPath(prefix + layer.route.path);
      const methods = METHODS.filter((m) => layer.route.methods && layer.route.methods[m]);
      out.push({
        path: routePath === '' ? '/' : routePath,
        methods,
        authenticated: authed,
        handlers: carried.concat(layer.route.stack.map((entry) => entry.handle)),
      });
      continue;
    }

    if (layer.handle && layer.handle.stack) {
      walk(layer.handle, prefix + mountPathOf(layer), authed, carried.slice(), out);
      continue;
    }

    /* A plain middleware. If it carries metadata, every later route in this router inherits it. */
    if (meta) carried = carried.concat([layer.handle]);
  }

  return out;
}

/* ═══════════════════════════════ one route → one operation ═══════════════════════════════ */

/**
 * Merge the metadata every handler on a route carries.
 *
 * A route's stack is the guards in mount order followed by the controller. Each guard that was built
 * from arguments hung them on itself (`utils/routeMeta.js`); the controller carries nothing.
 */
function collectMeta(handlers) {
  const collected = {
    permissions: [],
    permissionMode: null,
    roles: [],
    modules: [],
    moduleMode: null,
    limit: null,
    schemas: {},
    upload: null,
  };

  for (const handler of handlers) {
    const meta = metaOf(handler);
    if (!meta) continue;

    if (meta.permissions) {
      collected.permissions.push(...meta.permissions);
      collected.permissionMode = meta.permissionMode;
    }
    if (meta.roles) collected.roles.push(...meta.roles);
    if (meta.modules) {
      collected.modules.push(...meta.modules);
      collected.moduleMode = meta.moduleMode;
    }
    if (meta.limit) collected.limit = meta.limit;
    if (meta.schemas) Object.assign(collected.schemas, meta.schemas);
    if (meta.upload) collected.upload = meta.upload;
  }

  return collected;
}

/**
 * §28's "Parameters": path placeholders, plus every key of the `query` and `params` schemas.
 *
 * A path placeholder is always required — the route does not match without it — so a `:id` with no
 * `params` schema is still documented, typed as a string because nothing narrows it.
 */
function buildParameters(routePath, schemas) {
  const parameters = [];
  const placeholders = (routePath.match(/\{([A-Za-z0-9_]+)\}/g) || []).map((p) => p.slice(1, -1));
  const described = schemas.params ? fromJoi(schemas.params) : null;
  const properties = (described && described.properties) || {};

  for (const name of placeholders) {
    parameters.push({
      name,
      in: 'path',
      required: true,
      schema: properties[name] || { type: 'string' },
    });
  }

  if (schemas.query) {
    const query = fromJoi(schemas.query);
    const required = query.required || [];
    for (const [name, schema] of Object.entries(query.properties || {})) {
      parameters.push({ name, in: 'query', required: required.includes(name), schema });
    }
  }

  return parameters;
}

/**
 * §28's "Error Response": the failures this particular route can produce.
 *
 * Derived from what is mounted rather than listed uniformly, so the document distinguishes a route
 * that can return `MODULE_NOT_SUBSCRIBED` from one that cannot. 401 appears only below the
 * authentication boundary; 403 only where a guard exists to refuse; 422 only where something
 * validates.
 */
function buildResponses(route, meta) {
  const responses = {
    200: {
      description: 'Success',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
    },
  };

  if (route.methods.includes('post')) responses[201] = responses[200];

  const ref = (name) => {
    responses[ERROR_RESPONSES[name][0]] = { $ref: `#/components/responses/${name}` };
  };

  if (Object.keys(meta.schemas).length) ref('ValidationFailed');
  if (route.authenticated) ref('Unauthenticated');
  if (/\{[A-Za-z0-9_]+\}/.test(route.path)) ref('NotFound');
  if (meta.modules.length) ref('SubscriptionInactive');

  /*
   * Three distinct refusals share status 403 — a missing permission, an unsubscribed module and an
   * exhausted plan limit — and OpenAPI keys a response by its status code, so they cannot be three
   * entries. Writing them one after another silently kept only the last, which made a route guarded
   * by both a permission and a limit document the limit and lose the permission.
   *
   * They are composed into one response instead, listing the codes `error.code` can actually carry
   * on this particular route. A caller branching on the code needs the full set; a caller branching
   * on the status only needs to know it can happen.
   */
  const causes = [];
  if (meta.permissions.length || meta.roles.length) {
    causes.push('`FORBIDDEN` — the caller lacks the required permission or role');
  }
  if (meta.modules.length) {
    causes.push("`MODULE_NOT_SUBSCRIBED` — the plan does not include this endpoint's module");
  }
  if (meta.limit) {
    causes.push('`PLAN_LIMIT_EXCEEDED` — the action would exceed a plan limit');
  }
  if (causes.length) {
    responses[403] = {
      description: `403 — refused. ${causes.join('; ')}.`,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }

  ref('TooManyRequests');
  ref('ServerError');

  return responses;
}

/** §28's "Authentication", in words a reader can act on. */
function describeAuthentication(route, meta) {
  if (!route.authenticated) return 'Public — no token required.';

  const parts = ['Bearer token required.'];

  if (meta.permissions.length) {
    const joiner = meta.permissionMode === 'any' ? ' or ' : ' and ';
    parts.push(`Requires permission ${meta.permissions.map((p) => `\`${p}\``).join(joiner)}.`);
  }
  if (meta.roles.length) {
    parts.push(`Restricted to role(s) ${meta.roles.map((r) => `\`${r}\``).join(', ')}.`);
  }
  if (meta.modules.length) {
    const joiner = meta.moduleMode === 'any' ? ' or ' : ' and ';
    parts.push(`Requires the ${meta.modules.map((m) => `\`${m}\``).join(joiner)} module.`);
  }
  if (meta.limit) {
    parts.push(`Counts against the \`${meta.limit}\` plan limit.`);
  }

  return parts.join(' ');
}

/**
 * The tag a route is filed under — its first path segment, which is its module.
 *
 * Called with the prefix already stripped. Called without, every one of the 195 paths begins `api`
 * and the whole API collapses into a single unusable group in the Swagger UI.
 */
function tagFor(routePath) {
  const segment = routePath.split('/').filter(Boolean)[0];
  return segment && !segment.startsWith('{') ? segment : 'system';
}

/**
 * Remove the mount prefix from a path.
 *
 * OpenAPI resolves a request as **server URL + path**, and the server URL here is the API prefix. A
 * path that also carried the prefix would document `/api/v1/api/v1/students` — a spec that is
 * internally consistent, renders perfectly, and sends every generated client to an address that does
 * not exist.
 *
 * @param {string} routePath
 * @param {string} prefix  `config.app.apiPrefix`
 * @returns {string}
 */
function stripPrefix(routePath, prefix) {
  if (!prefix || prefix === '/' || !routePath.startsWith(prefix)) return routePath;
  const trimmed = routePath.slice(prefix.length);
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function buildOperation(route, method, meta) {
  const operation = {
    tags: [tagFor(route.path)],
    summary: `${method.toUpperCase()} ${route.path}`,
    description: describeAuthentication(route, meta),
    responses: buildResponses(route, meta),
  };

  const parameters = buildParameters(route.path, meta.schemas);
  if (parameters.length) operation.parameters = parameters;

  if (meta.schemas.body) {
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: fromJoi(meta.schemas.body) } },
    };
  }

  if (route.authenticated) operation.security = [{ bearerAuth: [] }];

  return operation;
}

/* ═══════════════════════════════════ the document ═══════════════════════════════════ */

/**
 * Build the OpenAPI 3.0.3 document for a mounted application.
 *
 * @param {import('express').Express} app  an app built by `createApp()`
 * @returns {object} the OpenAPI document
 */
function buildDocument(app) {
  const prefix = config.app.apiPrefix;
  const routes = walk(app._router, '', false, [], []);
  const paths = {};

  for (const walked of routes) {
    const route = { ...walked, path: stripPrefix(walked.path, prefix) };
    const meta = collectMeta(route.handlers);
    for (const method of route.methods) {
      if (method === 'head' || method === 'options') continue;
      paths[route.path] = paths[route.path] || {};
      paths[route.path][method] = buildOperation(route, method, meta);
    }
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'School Management System API',
      version,
      description:
        'Generated from the mounted Express application: paths, methods, authentication, ' +
        'parameters, request bodies and error responses are read from the routes and Joi schemas ' +
        'that enforce them, so this document cannot drift from the API it describes. The one ' +
        'exception is the shape of a success payload — see src/docs/openapi.js for why it is not ' +
        'described and what closing that would take.',
    },
    servers: [{ url: config.app.apiPrefix, description: 'This deployment' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: { Success: SUCCESS_SCHEMA, Error: ERROR_SCHEMA },
      responses: buildErrorResponses(),
    },
    paths,
  };
}

module.exports = {
  buildDocument,
  walk,
  collectMeta,
  buildParameters,
  buildResponses,
  describeAuthentication,
  toOpenApiPath,
  mountPathOf,
  stripPrefix,
  tagFor,
  ERROR_RESPONSES,
};
