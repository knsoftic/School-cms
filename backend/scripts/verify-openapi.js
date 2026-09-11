'use strict';

/**
 * Verification of FR-APIDOC-001 — the §28 OpenAPI document.
 *
 * ## What this suite has to prove, and why it is unusual
 *
 * Every other suite in this directory verifies behaviour: a request goes in, a row or a status comes
 * out. This one verifies a **description of** behaviour, which fails differently. A generated
 * document is always internally consistent — it renders, it validates, every `$ref` resolves — and
 * can still be confidently wrong about the API it claims to describe. Three of the defects found
 * while building it were exactly that shape:
 *
 *   - every path carried the API prefix *and* the server URL did, so a generated client would have
 *     requested `/api/v1/api/v1/students`. The document was valid. Swagger UI rendered it happily.
 *   - three different refusals share status 403, and OpenAPI keys responses by status, so writing
 *     them in sequence silently kept only the last. Routes guarded by both a permission and a limit
 *     documented the limit and lost the permission.
 *   - `requireModule()` is mounted with `router.use()` in eighteen routers, so it is a *sibling* of
 *     the routes it guards rather than a member of their stacks. Reading only `route.stack`
 *     documented 78 paths as reachable without the module their plan must include.
 *
 * None of those would fail a schema validator. So the assertions here are mostly of the form "the
 * document agrees with the application", checked against the mounted app rather than against
 * expectations written down beside them.
 *
 * ## The three parts
 *
 *   1. the Joi → OpenAPI conversion, in isolation, including what it deliberately refuses to say
 *   2. the document built from the real mounted application
 *   3. real HTTP — the JSON, the UI, and the assets the UI needs under this app's CSP
 */

const http = require('http');
const Joi = require('joi');

const { createApp } = require('../src/app');
const { buildDocument, walk, collectMeta, stripPrefix, tagFor, toOpenApiPath } = require('../src/docs/openapi');
const { fromJoi } = require('../src/docs/joiSchema');
const { annotate, metaOf } = require('../src/utils/routeMeta');
const ApiResponse = require('../src/utils/ApiResponse');
const config = require('../src/config/env');

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

/** Run a thunk that may throw, so a regression fails by name instead of aborting the suite. */
function attempt(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return typeof fallback === 'function' ? fallback(err) : fallback;
  }
}

/**
 * One operation, or a safe empty stand-in.
 *
 * Three of the regressions this suite exists to catch change the *shape* of `doc.paths` — leaving
 * the prefix on, keeping a trailing slash, losing the auth boundary — so a direct
 * `doc.paths['/students'].post` throws a TypeError and aborts the run before the assertion that
 * names the defect ever prints. §5a's rule: a crash is a detection, but a poor one.
 */
function op(doc, path, method) {
  const methods = doc.paths[path];
  const operation = methods && methods[method];
  return operation || { description: '', responses: {}, parameters: [], tags: [], __missing: true };
}

/** Every operation in the document, flattened. */
/** A response's description, or '' when the response is absent. */
function desc(operation, status) {
  const response = operation.responses[status];
  return (response && response.description) || '';
}

function operations(doc) {
  const out = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(methods)) out.push({ path, method, operation });
  }
  return out;
}

/* ═══════════════════════ part 1 — the Joi conversion, in isolation ═══════════════════════ */

function verifyConversion() {
  console.log('');
  console.log('── Part 1 — Joi → OpenAPI ──');
  console.log('');

  const schema = Joi.object({
    name: Joi.string().trim().min(2).max(100).required(),
    age: Joi.number().integer().min(0).max(120),
    kind: Joi.string().valid('active', 'inactive').default('active'),
    note: Joi.string().allow(null, '').max(50),
    due: Joi.date().iso(),
    tags: Joi.array().items(Joi.string()).unique().max(5),
    refused: Joi.any().forbidden(),
    amount: Joi.number().precision(2).greater(0),
    conditional: Joi.string().when('kind', { is: 'active', then: Joi.required() }),
    code: Joi.string().pattern(/^[A-Z]{3}$/),
    email: Joi.string().email(),
    flag: Joi.boolean(),
  });

  const out = fromJoi(schema);
  const props = out.properties;

  check('an object becomes an object', out.type, 'object');
  check('  and only the required keys are listed as required', out.required, ['name']);
  check('a trimmed, bounded string carries its bounds',
    [props.name.type, props.name.minLength, props.name.maxLength], ['string', 2, 100]);
  check('an integer is `integer`, not `number` with a note',
    [props.age.type, props.age.minimum, props.age.maximum], ['integer', 0, 120]);
  check('`.valid()` becomes a closed enum', props.kind.enum, ['active', 'inactive']);
  check('  and the default travels with it', props.kind.default, 'active');
  check('`.allow(null)` becomes nullable', props.note.nullable, true);
  check('a date crosses the wire as a date-time string, not a `date` type',
    [props.due.type, props.due.format], ['string', 'date-time']);
  check('an array carries its item schema and its bounds',
    [props.tags.type, props.tags.items.type, props.tags.maxItems, props.tags.uniqueItems],
    ['array', 'string', 5, true]);
  check('`.greater(0)` is exclusive, which `minimum: 0` alone would not say',
    [props.amount.minimum, props.amount.exclusiveMinimum], [0, true]);
  check('a regex is emitted without its delimiters, which OpenAPI does not accept',
    props.code.pattern, '^[A-Z]{3}$');
  check('`.email()` becomes a format a generator understands', props.email.format, 'email');
  check('a boolean stays a boolean', props.flag.type, 'boolean');

  /*
   * The two deliberate silences. Both are cases where saying something plausible would be worse than
   * saying nothing, and both were chosen rather than fallen into.
   */
  check('a forbidden key is omitted entirely — it is not part of the contract',
    Object.prototype.hasOwnProperty.call(props, 'refused'), false);
  check('  and it is omitted, not merely unrequired',
    Object.keys(props).includes('refused'), false);
  check('a conditional is described in words, because OpenAPI cannot express it',
    /conditional on `kind`/.test(props.conditional.description || ''), true);
  check('  and is NOT rendered as oneOf, which would mean something else entirely',
    props.conditional.oneOf, undefined);
  check('  nor silently promoted to required, which the API does not impose',
    (out.required || []).includes('conditional'), false);
  check('a precision constraint is described, not approximated into multipleOf',
    [/2 decimal places/.test(props.amount.description || ''), props.amount.multipleOf],
    [true, undefined]);

  /*
   * `validate()` strips unknown keys rather than accepting them, so a body documented as open would
   * describe a permissiveness this API does not have.
   */
  check('unknown keys are refused, matching what validate() actually does',
    out.additionalProperties, false);
  check('  unless the schema opted into them',
    fromJoi(Joi.object({ a: Joi.string() }).unknown(true)).additionalProperties, undefined);

  check('a non-schema converts to an empty schema rather than throwing',
    [fromJoi(null), fromJoi(undefined), fromJoi({})], [{}, {}, {}]);
}

/* ═══════════════════ part 2 — the document, built from the mounted app ═══════════════════ */

function verifyDocument(app, doc) {
  console.log('');
  console.log('── Part 2 — the document, against the application it describes ──');
  console.log('');

  const ops = operations(doc);
  const prefix = config.app.apiPrefix;

  check('the document declares the OpenAPI version tooling expects', doc.openapi, '3.0.3');
  check('it names itself and carries the package version',
    [typeof doc.info.title, doc.info.version === require('../package.json').version], ['string', true]);
  check('bearer auth is declared as a security scheme, since §28 requires Authentication',
    [doc.components.securitySchemes.bearerAuth.type, doc.components.securitySchemes.bearerAuth.scheme],
    ['http', 'bearer']);

  /* ── completeness: every mounted route, and nothing invented ── */

  const walked = walk(app._router, '', false, [], []);
  const mounted = new Set();
  for (const route of walked) {
    for (const method of route.methods) {
      if (method === 'head' || method === 'options') continue;
      mounted.add(`${method} ${stripPrefix(route.path, prefix)}`);
    }
  }
  const documented = new Set(ops.map((o) => `${o.method} ${o.path}`));

  check('every mounted route is documented — §28 asks for complete documentation',
    [...mounted].filter((r) => !documented.has(r)), []);
  check('  and nothing is documented that is not mounted',
    [...documented].filter((r) => !mounted.has(r)), []);
  check('the document is not trivially small', ops.length > 200, true);

  /* ── the prefix bug: a valid document that sends every client to the wrong address ── */

  check('the server URL carries the API prefix', doc.servers[0].url, prefix);
  check('  and no path repeats it, since OpenAPI resolves server + path',
    Object.keys(doc.paths).filter((p) => p.startsWith(`${prefix}/`) || p === prefix), []);
  check('  so a documented path resolves to the address the app actually serves',
    doc.servers[0].url + (Object.keys(doc.paths).find((p) => p === '/students') || '(absent)'),
    `${prefix}/students`);

  /* ── trailing slashes: served identically by Express, distinct paths in OpenAPI ── */

  check('no path carries a trailing slash',
    Object.keys(doc.paths).filter((p) => p.length > 1 && p.endsWith('/')), []);
  check('  the collection endpoint is documented at the address a client would write',
    Object.prototype.hasOwnProperty.call(doc.paths, '/students'), true);

  /* ── tags: the difference between a usable UI and one unusable group ── */

  const tags = new Set(ops.flatMap((o) => o.operation.tags));
  check('routes are filed under many tags, not collapsed under the mount prefix',
    [tags.size > 20, tags.has('api')], [true, false]);
  check('  a module tag is its path segment', [tagFor('/students'), tagFor('/library/books')],
    ['students', 'library']);

  /* ── §28's Authentication field, decided by position rather than guessed ── */

  const publicOps = ops.filter((o) => !o.operation.security);
  check('the public surface is exactly the routes mounted above the auth boundary',
    [...new Set(publicOps.map((o) => o.path))].sort(),
    ['/auth/forgot-password', '/auth/login', '/auth/refresh', '/auth/reset-password',
      '/auth/verify-email', '/csrf-token', '/docs/openapi.json', '/health', '/health/ready', '/meta']);
  check('  every public operation says so in words as well as by omitting security',
    publicOps.every((o) => /Public/.test(o.operation.description)), true);
  check('  and every other operation requires the bearer scheme',
    ops.filter((o) => o.operation.security)
      .every((o) => JSON.stringify(o.operation.security) === '[{"bearerAuth":[]}]'), true);
  check('login is public — a document that required a token to learn how to get one is useless',
    Boolean(op(doc, '/auth/login', 'post').security), false);

  /* ── the permission vocabulary reaches the document ── */

  const createStudent = op(doc, '/students', 'post');
  check('a permission guard names its key in the operation description',
    /students\.manage/.test(createStudent.description), true);
  check('  and a limit guard names the limit it counts against',
    /student_limit/.test(createStudent.description), true);

  /*
   * The router-level guard. `library.routes.js:72` is `router.use(requireModule(MODULES.LIBRARY))`,
   * a sibling of the routes rather than a member of their stacks — the defect that documented 78
   * paths as reachable without the module they require.
   */
  const listBooks = op(doc, '/library/books', 'get');
  check('a router-level requireModule() is inherited by the routes below it',
    /`library` module/.test(listBooks.description), true);
  check('  and it reaches every route in that router, not merely the first',
    Object.keys(doc.paths).filter((p) => p.startsWith('/library/'))
      .every((p) => Object.values(doc.paths[p]).every((o) => /module/.test(o.description))), true);
  check('  which is not a handful of routes but most of the module surface',
    ops.filter((o) => /Requires the .* module/.test(o.operation.description)).length > 100, true);

  /* ── §28's Error Response, per route rather than uniform ── */

  check('403 lists every cause that applies to the route, not just the last one written',
    [/INSUFFICIENT_PERMISSION/.test(desc(createStudent, 403)),
      /PLAN_LIMIT_EXCEEDED/.test(desc(createStudent, 403))], [true, true]);
  check('  a route with a module guard names MODULE_NOT_SUBSCRIBED too',
    /MODULE_NOT_SUBSCRIBED/.test(desc(listBooks, 403)), true);
  check('  and a route with only a permission does not claim limits it has none of',
    /PLAN_LIMIT_EXCEEDED/.test(desc(listBooks, 403)), false);
  check('a module-guarded route can also report an unusable subscription',
    Boolean(listBooks.responses[402]), true);
  check('  and one without a module guard does not',
    Boolean(op(doc, '/users', 'get').responses[402]), false);

  check('401 appears only below the authentication boundary',
    ops.filter((o) => Boolean(o.operation.responses[401]) !== Boolean(o.operation.security)).length, 0);
  check('404 appears exactly where a path parameter can miss',
    ops.filter((o) => Boolean(o.operation.responses[404]) !== /\{[A-Za-z0-9_]+\}/.test(o.path)).length, 0);
  check('422 appears only where something validates',
    op(doc, '/health', 'get').responses[422], undefined);
  check('every operation can report a rate limit and a server error',
    ops.filter((o) => !o.operation.responses[429] || !o.operation.responses[500]).length, 0);
  check('a POST documents 201 as well as 200',
    Boolean(createStudent.responses[201]), true);

  /* ── §28's Parameters ── */

  const oneStudent = op(doc, '/students/{id}', 'get');
  const pathParams = (oneStudent.parameters || []).filter((p) => p.in === 'path');
  check('a path placeholder is documented as a required path parameter',
    [pathParams.length, pathParams[0] && pathParams[0].name,
      pathParams[0] && pathParams[0].required], [1, 'id', true]);
  check('  typed from the params schema rather than defaulted to string',
    pathParams[0] && pathParams[0].schema.type, 'integer');
  check('query parameters come from the query schema',
    (op(doc, '/students', 'get').parameters || []).filter((p) => p.in === 'query').length > 0, true);
  check('  and are not marked required unless the schema requires them',
    (op(doc, '/students', 'get').parameters || [])
      .filter((p) => p.in === 'query' && p.required).length, 0);
  check('every path placeholder in every path is documented as a parameter',
    ops.filter((o) => {
      const placeholders = (o.path.match(/\{([A-Za-z0-9_]+)\}/g) || []).map((x) => x.slice(1, -1));
      const declared = (o.operation.parameters || []).filter((p) => p.in === 'path').map((p) => p.name);
      return placeholders.some((name) => !declared.includes(name));
    }).length, 0);

  /* ── §28's Request Body ── */

  const body = (createStudent.requestBody
    && createStudent.requestBody.content['application/json'].schema) || {};
  check('a POST body is documented from the Joi schema that enforces it',
    [Boolean(createStudent.requestBody && createStudent.requestBody.required), body.type],
    [true, 'object']);
  check('  with the schema\'s own required fields', (body.required || []).includes('first_name'), true);
  check('  and its own field count, not a hand-written subset',
    Object.keys(body.properties || {}).length > 20, true);
  check('a GET has no request body', Boolean(op(doc, '/students', 'get').requestBody), false);

  /* ── §28's Response, and the limit stated rather than papered over ── */

  check('every operation documents a success response',
    ops.filter((o) => !o.operation.responses[200]).length, 0);
  check('  as the envelope ApiResponse actually guarantees',
    doc.components.schemas.Success.properties.success.enum, [true]);
  check('the failure envelope matches what errorHandler emits',
    Object.keys(doc.components.schemas.Error.properties).sort(), ['error', 'requestId', 'success']);
  check('  including the details array a 422 carries',
    doc.components.schemas.Error.properties.error.properties.details.type, 'array');
  check('the unknown shape of `data` is stated in the document, not left to be assumed',
    /not described here/.test(doc.components.schemas.Success.properties.data.description), true);
  check('  and `data` is genuinely unconstrained rather than typed as an empty object',
    doc.components.schemas.Success.properties.data.type, undefined);

  /* ── every $ref resolves ── */

  const refs = JSON.stringify(doc).match(/"#\/components\/[^"]+"/g) || [];
  const unresolved = [...new Set(refs)].filter((ref) => {
    const parts = ref.replace(/"/g, '').split('/').slice(1);
    return parts.reduce((node, key) => (node ? node[key] : undefined), doc) === undefined;
  });
  check('every $ref in the document resolves', unresolved, []);
}

/* ═══════════════════ part 2b — metadata, and what carries it ═══════════════════ */

function verifyMetadata() {
  console.log('');
  console.log('── Part 2b — the middleware annotations the document is read from ──');
  console.log('');

  const { requirePermission, requireAnyPermission, requireRole } = require('../src/middlewares/authorize');
  const { requireModule, enforceLimit } = require('../src/middlewares/entitlement');
  const { authenticate } = require('../src/middlewares/authenticate');
  const validate = require('../src/middlewares/validate').validate || require('../src/middlewares/validate');

  check('a permission guard remembers the keys it was built from',
    (metaOf(requirePermission('users.view')) || {}).permissions, ['users.view']);
  check('  and whether all of them or any of them are needed',
    [metaOf(requirePermission('organizations.view', 'schools.view')).permissionMode,
      metaOf(requireAnyPermission('organizations.view', 'schools.view')).permissionMode],
    ['all', 'any']);
  check('a role guard remembers its slugs',
    (metaOf(requireRole('super_admin')) || {}).roles, ['super_admin']);
  check('a module guard remembers its keys',
    (metaOf(requireModule('library')) || {}).modules, ['library']);
  check('a limit guard remembers its key',
    (metaOf(enforceLimit('student_limit')) || {}).limit, 'student_limit');
  check('a validator remembers its containers',
    (metaOf(validate({ body: Joi.object({}), query: Joi.object({}) })) || {}).containers,
    ['query', 'body']);
  check('authenticate marks itself, since three asyncHandlers share one function name',
    (metaOf(authenticate) || {}).authenticates, true);
  check('middleware that carries nothing reports nothing', metaOf((req, res, next) => next()), null);
  check('  as does a non-function', [metaOf(null), metaOf('x')], [null, null]);

  /*
   * Non-enumerable on purpose: Express copies, inspects and spreads middleware, and documentation
   * must never become something behaviour can trip over.
   */
  const guard = requirePermission('users.view');
  check('the annotation is invisible to enumeration',
    [Object.keys(guard).length, JSON.stringify({ ...guard })], [0, '{}']);
  check('  and frozen, so one route cannot rewrite another route\'s documentation',
    Object.isFrozen(metaOf(guard)), true);
  check('annotating twice merges rather than replaces',
    attempt(() => {
      const fn = annotate(annotate(() => {}, { a: 1 }), { b: 2 });
      return metaOf(fn);
    }, null), { a: 1, b: 2 });
  check('annotate refuses a non-function rather than silently doing nothing',
    attempt(() => { annotate({}, {}); return 'accepted'; }, (err) => err.constructor.name), 'TypeError');

  check('collectMeta merges a route\'s guards in mount order',
    attempt(() => collectMeta([requireModule('library'), requirePermission('schools.view'),
      enforceLimit('student_limit')]), null),
    { permissions: ['schools.view'], permissionMode: 'all', roles: [], platformOnly: false,
      modules: ['library'], moduleMode: 'all', features: [], subscription: false,
      limit: 'student_limit', schemas: {}, upload: null, file: null, conditional: [] });

  check('an Express path becomes an OpenAPI path',
    [toOpenApiPath('/students/:id/marks'), toOpenApiPath('/:a/:b')],
    ['/students/{id}/marks', '/{a}/{b}']);
  check('  and a router index path loses its trailing slash',
    [toOpenApiPath('/students/'), toOpenApiPath('/')], ['/students', '/']);
  check('stripPrefix removes the mount prefix and nothing else',
    [stripPrefix('/api/v1/students', '/api/v1'), stripPrefix('/api/v1', '/api/v1'),
      stripPrefix('/other', '/api/v1')], ['/students', '/', '/other']);
}

/* ═════════════ part 2c — the guards with no arguments, uploads, and files ═════════════ */

/** Run a guard against a stand-in request and return the error it passes to `next`, or null. */
async function refusalOf(guard, req) {
  let passed = null;
  await new Promise((resolve) => {
    const next = (err) => { passed = err || null; resolve(); };
    Promise.resolve(guard(req, {}, next)).then(() => setTimeout(resolve, 10), resolve);
  });
  return passed;
}

async function verifyGuardsUploadsFiles(app, doc) {
  console.log('');
  console.log('── Part 2c — the guards with no arguments, upload bodies, and file responses ──');
  console.log('');

  const fs = require('fs');
  const path = require('path');
  const { requirePermission, requireRole, requirePlatformScope } = require('../src/middlewares/authorize');
  const { requireActiveSubscription, requireFeature } = require('../src/middlewares/entitlement');
  const { uploadSingle } = require('../src/middlewares/upload');
  const { UPLOAD_PROFILES, UPLOAD_RULES } = require('../src/config/constants');
  const prefix = config.app.apiPrefix;
  const ops = operations(doc);

  /* ── the 403 codes, taken from the guards themselves rather than from memory ── */

  const permissionCode = ((await refusalOf(requirePermission('users.view'), {
    user: { id: 1 }, getPermissions: async () => new Set(),
  })) || {}).code;
  const roleCode = ((await refusalOf(requireRole('super_admin'), {
    user: { id: 1, role: { slug: 'teacher' } }, getPermissions: async () => new Set(),
  })) || {}).code;
  const platformCode = ((await refusalOf(requirePlatformScope(), { tenant: { isPlatform: false } })) || {}).code;

  const createStudent = op(doc, '/students', 'post');
  check('a permission refusal is documented by the code requirePermission actually sends',
    [permissionCode, new RegExp(`\`${permissionCode}\``).test(desc(createStudent, 403))],
    ['INSUFFICIENT_PERMISSION', true]);
  check('  and no route documents the generic FORBIDDEN, which no guard sends',
    ops.filter((o) => /`FORBIDDEN`/.test(desc(o.operation, 403))).length, 0);
  const roleRoutes = ops.filter((o) => /Restricted to role/.test(o.operation.description));
  check('a role refusal is documented by the code requireRole sends, wherever a role guard is mounted',
    [roleCode, roleRoutes.every((o) => desc(o.operation, 403).includes(`\`${roleCode}\``))],
    ['INSUFFICIENT_ROLE', true]);

  /* ── requirePlatformScope, requireActiveSubscription, requireFeature: annotated, and read ── */

  check('requirePlatformScope() now says it is there — it takes no arguments, but it refuses',
    (metaOf(requirePlatformScope()) || {}).platformOnly, true);
  check('requireActiveSubscription() likewise', (metaOf(requireActiveSubscription()) || {}).subscription, true);
  check('requireFeature() remembers its keys', (metaOf(requireFeature('premium_reports')) || {}).features,
    ['premium_reports']);

  const platformOps = ops.filter((o) => desc(o.operation, 403).includes(`\`${platformCode}\``));
  check('platform-only routes document the refusal requirePlatformScope sends',
    [platformCode, platformOps.length > 20], ['PLATFORM_SCOPE_REQUIRED', true]);
  check('  and say so in their Authentication text',
    platformOps.every((o) => /platform scope/.test(o.operation.description)), true);
  check('  POST /schools is one of them', platformOps.some((o) => o.method === 'post' && o.path === '/schools'), true);

  const walked = walk(app._router, '', false, [], []);
  const guarded = (predicate) => walked
    .filter((route) => route.handlers.some((h) => predicate(metaOf(h) || {})))
    .flatMap((route) => route.methods.filter((m) => m !== 'head' && m !== 'options')
      .map((m) => `${m} ${stripPrefix(route.path, prefix)}`));

  const subscriptionRoutes = guarded((m) => m.subscription);
  check('every route mounting requireActiveSubscription() documents the 402 it can send',
    [subscriptionRoutes.length > 0,
      subscriptionRoutes.filter((r) => { const [m, p] = r.split(' '); return !op(doc, p, m).responses[402]; })],
    [true, []]);
  const limitRoutes = guarded((m) => m.limit);
  check('  as does every route mounting enforceLimit(), which asserts the subscription first',
    limitRoutes.filter((r) => { const [m, p] = r.split(' '); return !op(doc, p, m).responses[402]; }), []);

  const exportReport = op(doc, '/reports/students', 'get');
  check('an export-only permission is documented, and only for the export',
    /When format is not json, also requires permission `reports\.export`/.test(exportReport.description), true);
  check('  and the Premium Reports feature beside it (the owner\'s decision D9)',
    [/`premium_reports`/.test(exportReport.description), /FEATURE_NOT_SUBSCRIBED/.test(desc(exportReport, 403))],
    [true, true]);
  check('  which can also answer 402, since requireFeature() asserts the subscription',
    Boolean(exportReport.responses[402]), true);
  check('  while the Subscription Report, with no feature gate, states only the permission',
    [/`reports\.export`/.test(op(doc, '/reports/subscriptions', 'get').description),
      /premium_reports/.test(op(doc, '/reports/subscriptions', 'get').description)], [true, false]);

  /* ── §28's Request Body for the upload routes: multipart, from the chain's own arguments ── */

  check('the upload chain records its field, count and types for the document',
    attempt(() => metaOf(uploadSingle(UPLOAD_PROFILES.PERSON_PHOTO, 'photo')[0]).upload, null),
    { profile: 'person_photo', field: 'photo', maxCount: 1,
      mimeTypes: UPLOAD_RULES[UPLOAD_PROFILES.PERSON_PHOTO].mimeTypes, billingSurface: false });

  const uploadRoutes = walked.filter((route) => route.handlers.some((h) => (metaOf(h) || {}).upload));
  const uploadOps = uploadRoutes.flatMap((route) => route.methods
    .filter((m) => m !== 'head' && m !== 'options')
    .map((m) => ({ key: `${m} ${stripPrefix(route.path, prefix)}`,
      upload: route.handlers.map((h) => (metaOf(h) || {}).upload).find(Boolean),
      operation: op(doc, stripPrefix(route.path, prefix), m) })));
  check('every route that mounts the upload chain is found', uploadOps.length, 6);
  check('  each documents a multipart/form-data body, and only that',
    uploadOps.filter((u) => JSON.stringify(Object.keys((u.operation.requestBody || {}).content || {}))
      !== '["multipart/form-data"]').map((u) => u.key), []);
  check('  with its file field as binary, under the name the chain parses',
    uploadOps.filter((u) => {
      const schema = u.operation.requestBody.content['multipart/form-data'].schema;
      const prop = schema.properties[u.upload.field];
      const file = prop && (prop.type === 'array' ? prop.items : prop);
      return !file || file.format !== 'binary';
    }).map((u) => u.key), []);
  check('  and a many-file surface as an array bounded by the chain\'s own count',
    attempt(() => {
      const docs = op(doc, '/students/{id}/documents', 'post').requestBody.content['multipart/form-data'].schema;
      return [docs.properties.documents.type, docs.properties.documents.maxItems];
    }, null), ['array', UPLOAD_RULES[UPLOAD_PROFILES.STUDENT_DOCUMENT].maxFiles]);
  check('  beside the text fields validate() checks',
    attempt(() => Object.keys(op(doc, '/homework', 'post').requestBody.content['multipart/form-data']
      .schema.properties).includes('title'), false), true);
  check('every upload route documents the refusals the chain adds: 400, 413 and 415',
    uploadOps.filter((u) => !(u.operation.responses[400] && u.operation.responses[413]
      && u.operation.responses[415])).map((u) => u.key), []);
  check('  and the limits it charges against',
    uploadOps.filter((u) => !/file_upload_limit/.test(desc(u.operation, 403))).map((u) => u.key), []);
  check('the payment screenshot is the one billing surface: no 402, no storage charge',
    [Boolean(op(doc, '/payments', 'post').responses[402]), /storage_limit/.test(desc(op(doc, '/payments', 'post'), 403))],
    [false, false]);
  check('  while every other upload route can answer 402 and is charged against storage',
    uploadOps.filter((u) => u.key !== 'post /payments')
      .filter((u) => !u.operation.responses[402] || !/storage_limit/.test(desc(u.operation, 403))).map((u) => u.key), []);

  /* ── §28's Response for the routes that answer with a file ── */

  const STORED = [
    '/payments/{id}/screenshot', '/students/{id}/photo', '/students/{id}/documents/{documentId}',
    '/homework/{id}/attachment', '/assignments/submissions/{id}/attachment',
  ];
  const BY_FORMAT = [
    '/exams/results/{id}', '/exams/{id}/results', '/documents/{id}',
    '/reports/students', '/reports/attendance', '/reports/fees', '/reports/expenses', '/reports/exams',
    '/reports/teachers', '/reports/subscriptions',
  ];
  const contentOf = (p) => Object.keys((op(doc, p, 'get').responses[200] || {}).content || {});
  const binaryOnly = (p) => contentOf(p).length > 0 && !contentOf(p).includes('application/json')
    && contentOf(p).every((t) => op(doc, p, 'get').responses[200].content[t].schema.format === 'binary');

  check('a stored upload is documented as the file, not the JSON envelope', STORED.filter((p) => !binaryOnly(p)), []);
  check('  in the types its upload surface accepts',
    contentOf('/students/{id}/photo'), UPLOAD_RULES[UPLOAD_PROFILES.PERSON_PHOTO].mimeTypes);
  check('an export chosen by `format` offers both answers — the envelope, and the file',
    BY_FORMAT.filter((p) => !(contentOf(p).includes('application/json') && contentOf(p).includes('application/pdf'))), []);
  check('  with Excel beside PDF on the seven reports, read off the controller\'s own export table',
    contentOf('/reports/fees').includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), true);
  check('  and the query that selects the file named in the response',
    /when `format=pdf`/.test(op(doc, '/exams/results/{id}', 'get').responses[200].description), true);
  check('those fifteen are every file route the document has, and no JSON route claims a file',
    ops.filter((o) => contentOf(o.path).some((t) => t !== 'application/json') && o.method === 'get')
      .map((o) => o.path).sort(), [...STORED, ...BY_FORMAT].sort());

  /*
   * The drift guard for the one hand-stated fact. `respondsWithFile()` is written in the route file, so
   * a new controller that streams a file could be mounted without it and the document would call it
   * JSON. So the controllers are read for the two ways this application sends a file — `sendStoredFile(`
   * and a hand-set `Content-Type` — and every route that mounts such a handler must carry the mark.
   */
  const modulesDir = path.join(__dirname, '..', 'src', 'modules');
  const unmarked = [];
  let fileHandlers = 0;
  for (const moduleName of fs.readdirSync(modulesDir)) {
    const controllerFile = path.join(modulesDir, moduleName, `${moduleName}.controller.js`);
    const routesFile = path.join(modulesDir, moduleName, `${moduleName}.routes.js`);
    if (!fs.existsSync(controllerFile) || !fs.existsSync(routesFile)) continue;
    const source = fs.readFileSync(controllerFile, 'utf8');
    const routes = fs.readFileSync(routesFile, 'utf8');
    const blocks = source.split(/\n(?=(?:async )?function \w+\()/);
    for (const block of blocks) {
      const name = (block.match(/^(?:async )?function (\w+)\(/) || [])[1];
      if (!name || !/sendStoredFile\(|setHeader\('Content-Type'/.test(block)) continue;
      fileHandlers += 1;
      const mounted = new RegExp(`controller\\.${name}\\b`);
      const mounts = routes.split('\n').filter((line) => mounted.test(line));
      for (const line of mounts) if (!line.includes('respondsWithFile(')) unmarked.push(`${moduleName}.${name}`);
      if (!mounts.length) unmarked.push(`${moduleName}.${name} (not mounted?)`);
    }
  }
  check('every controller that sends a file is found by reading the controllers', fileHandlers, 9);
  check('  and every route mounting one carries respondsWithFile(), so none is documented as JSON', unmarked, []);
}

/* ═══════════════════════════ part 3 — real HTTP ═══════════════════════════ */

function request(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: (res.headers['content-type'] || '').split(';')[0],
        csp: res.headers['content-security-policy'] || '',
        body: Buffer.concat(chunks),
      }));
    }).on('error', reject);
  });
}

async function verifyHttp(app) {
  console.log('');
  console.log('── Part 3 — over HTTP, which is the only way the UI is actually used ──');
  console.log('');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = config.app.apiPrefix;

  try {
    const json = await request(port, `${base}/docs/openapi.json`);
    check('the OpenAPI document is served', [json.status, json.type], [200, 'application/json']);

    const doc = attempt(() => JSON.parse(json.body.toString('utf8')), null);
    check('  as parseable JSON', doc !== null, true);
    check('  at the document root, with no ApiResponse envelope around it',
      [doc.openapi, Object.prototype.hasOwnProperty.call(doc, 'success')], ['3.0.3', false]);
    check('  without a token, since the tools that consume OpenAPI do not carry one',
      doc.paths['/auth/login'] !== undefined, true);

    const ui = await request(port, `${base}/docs/`);
    check('the Swagger UI is served as HTML', [ui.status, ui.type], [200, 'text/html']);

    /*
     * The UI is the one HTML surface this JSON API has, and `app.js` keeps helmet's CSP on
     * specifically for it. `script-src 'self'` blocks inline scripts outright, so a 200 on the shell
     * proves nothing about whether the page runs — these assert the assets exist and that the page
     * needs no inline script to reach them.
     */
    const html = ui.body.toString('utf8');
    check('  under a CSP that allows only same-origin scripts', /script-src 'self'/.test(ui.csp), true);
    check('  and the page uses no inline script, which that CSP would block',
      /<script>\s*\S/.test(html), false);

    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    check('  the page references its assets relatively, so they stay same-origin',
      assets.every((a) => a.startsWith('./')), true);

    const fetched = [];
    for (const asset of assets) {
      const res = await request(port, `${base}/docs/${asset.replace(/^\.\//, '')}`);
      fetched.push([asset.replace(/^\.\//, ''), res.status]);
    }
    check('  and every one of them is served', fetched.filter(([, status]) => status !== 200), []);
    check('  including the bundle and the initialiser, without which the page is blank',
      ['swagger-ui-bundle.js', 'swagger-ui-init.js']
        .filter((name) => !fetched.some(([asset, status]) => asset === name && status === 200)), []);

    const init = await request(port, `${base}/docs/swagger-ui-init.js`);
    check('  the initialiser carries the document, not a placeholder',
      /"openapi"\s*:\s*"3\.0\.3"/.test(init.body.toString('utf8')), true);

    /* The document describes a live API: an endpoint it documents as public answers as public. */
    const health = await request(port, `${base}/health`);
    check('an endpoint documented as public answers without a token', health.status, 200);
    const students = await request(port, `${base}/students`);
    check('  and one documented as requiring a bearer token refuses without one', students.status, 401);
    check('    with the failure envelope the document describes',
      attempt(() => {
        const failure = JSON.parse(students.body.toString('utf8'));
        return [failure.success, typeof failure.error.code, typeof failure.error.message];
      }, null), [false, 'string', 'string']);

    /*
     * ── the documented `meta` shape, checked against the one the code emits ──
     *
     * The document described `meta` as a FLAT object of four keys for as long as it existed. The
     * application has never emitted that: `ApiResponse.paginated()` nests under `meta.pagination` and
     * emits six keys. Nothing noticed, because every other assertion in this suite checks that the
     * document is *well-formed* and that its guards match the routers — never that a shape it
     * describes is a shape the application produces.
     *
     * The cost of that gap is not hypothetical. This project's own frontend read pagination one level
     * too shallow, rendered a footer whose "Next" produced `NaN`, and got away with it because every
     * collection then fitted on one page. A client trusting the document would have made the same
     * mistake for the same reason.
     *
     * So this compares the two directly: the keys `paginated()` actually writes, against the keys the
     * document advertises. Neither side is a literal, so they cannot drift apart.
     */
    const envelope = attempt(() => {
      let captured = null;
      const fakeRes = { status: () => fakeRes, json: (body) => { captured = body; return fakeRes; } };
      ApiResponse.paginated(fakeRes, { count: 7, rows: [] }, { page: 1, limit: 5 });
      return captured;
    }, null);

    check('ApiResponse.paginated() nests its page fields under meta.pagination',
      Boolean(envelope && envelope.meta && envelope.meta.pagination), true);
    check('  and the document describes that nesting rather than a flat meta',
      Object.keys((doc.components.schemas.Success.properties.meta.properties) || {}),
      ['pagination']);
    check('  with exactly the keys the code emits, so the two cannot drift',
      Object.keys(envelope && envelope.meta ? envelope.meta.pagination : {}).sort(),
      Object.keys(
        /* Guarded: under a flat `meta` the previous assertion already failed, and this one must
         * report a difference rather than crash on an absent `pagination`. */
        ((doc.components.schemas.Success.properties.meta.properties.pagination || {}).properties) || {}
      ).sort());
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ═══════════════════════════════════════════════════════════════════════════ */

async function main() {
  verifyConversion();

  const app = createApp();
  const doc = buildDocument(app);
  verifyDocument(app, doc);
  verifyMetadata();
  await verifyGuardsUploadsFiles(app, doc);
  await verifyHttp(app);
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nverify-openapi crashed:', err);
  })
  .finally(() => {
    console.log('');
    console.log(failures === 0 ? 'All OpenAPI checks passed.' : `${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
