'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *
 *   JSON_BODY_LIMIT=1kb  so an oversize body can be a few kilobytes rather than a hundred. The value
 *                        under test is the configured one whatever it is; pinning it small only keeps
 *                        the probe small. The shipped default is Express's own 100kb.
 *   LOG_LEVEL=info       the default, pinned so the assertion about which winston levels are emitted
 *                        is deterministic rather than dependent on the developer's .env.
 *   CORS_ORIGINS         a two-entry allow-list, so "allowed" and "refused" are both exercised and
 *                        neither depends on what the local .env happens to permit.
 *   CSRF_ENABLED=true    so /csrf-token issues a real token whatever NODE_ENV the run has.
 */
process.env.JSON_BODY_LIMIT = '1kb';
process.env.LOG_LEVEL = 'info';
process.env.CORS_ORIGINS = 'http://localhost:3000,https://app.example.test';
process.env.CSRF_ENABLED = 'true';

/**
 * Verification of Phase 3.E — the application wiring, over real HTTP against the real database.
 *
 *   src/app.js                      the pipeline: what is mounted, in what order, and the
 *                                   public/authenticated boundary inside /api/v1
 *   src/modules/system/*            liveness, readiness, the API descriptor, the CSRF bootstrap
 *   src/server.js                   boot ordering, the port, and shutdown
 *
 * Three things here are worth stating plainly, because each is a behaviour that could otherwise be
 * mistaken for a defect:
 *
 *  - An unknown path *under* `/api/v1` answers 401, not 404, for an unauthenticated caller. The
 *    authentication chain is mounted on the router with no path, so it runs before Express can decide
 *    that nothing matched. That is the better answer — it declines to enumerate which routes exist —
 *    and it is asserted deliberately rather than discovered later.
 *  - Morgan is piped into winston at `info`, not at winston's own `http`. npm's levels put `http` (3)
 *    below `info` (2), so at the default LOG_LEVEL every access line would be silently dropped. Both
 *    halves of that are asserted, so the trap cannot be reintroduced.
 *  - On win32, `process.kill(pid, 'SIGTERM')` terminates a process abruptly instead of delivering a
 *    signal, so the shutdown path is exercised by having the child emit the signal on itself. That
 *    runs the real handler; what it does not prove is the operating system's delivery of it, and the
 *    output says so.
 *
 * Fixtures: none are created. The one authenticated request reuses the seeded Super Admin read-only,
 * and no row is written by this script. Two `logger.error` lines are expected near the end — they are
 * the deliberate bad-configuration boot, proving it refuses to listen.
 *
 * Run: node scripts/verify-app.js
 */

const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const db = require('../src/models');
const config = require('../src/config/env');
const logger = require('../src/config/logger');
const { createApp, corsOptions } = require('../src/app');
const { router: docsRoutes } = require('../src/docs/routes');
const {
  authenticate,
  enforcePasswordChange,
  resolveTenant,
  enforceTenant,
} = require('../src/middlewares');
const authRoutes = require('../src/modules/auth/auth.routes');
const platformRoutes = require('../src/modules/platform/platform.routes');
const organizationRoutes = require('../src/modules/organizations/organizations.routes');
const schoolRoutes = require('../src/modules/schools/schools.routes');
const principalRoutes = require('../src/modules/principals/principals.routes');
const userRoutes = require('../src/modules/users/users.routes');
const roleRoutes = require('../src/modules/roles/roles.routes');
const planRoutes = require('../src/modules/plans/plans.routes');
const addonRoutes = require('../src/modules/addons/addons.routes');
const subscriptionRoutes = require('../src/modules/subscriptions/subscriptions.routes');
const taxRoutes = require('../src/modules/taxes/taxes.routes');
const couponRoutes = require('../src/modules/coupons/coupons.routes');
const invoiceRoutes = require('../src/modules/invoices/invoices.routes');
const paymentRoutes = require('../src/modules/payments/payments.routes');
const quotationRoutes = require('../src/modules/quotations/quotations.routes');
const settingsRoutes = require('../src/modules/settings/settings.routes');
const sessionRoutes = require('../src/modules/sessions/sessions.routes');
const classRoutes = require('../src/modules/classes/classes.routes');
const subjectRoutes = require('../src/modules/subjects/subjects.routes');
const teacherRoutes = require('../src/modules/teachers/teachers.routes');
const studentRoutes = require('../src/modules/students/students.routes');
const parentRoutes = require('../src/modules/parents/parents.routes');
const staffRoutes = require('../src/modules/staff/staff.routes');
const attendanceRoutes = require('../src/modules/attendance/attendance.routes');
const feeRoutes = require('../src/modules/fees/fees.routes');
const financeRoutes = require('../src/modules/finance/finance.routes');
const examRoutes = require('../src/modules/exams/exams.routes');
const timetableRoutes = require('../src/modules/timetable/timetable.routes');
const homeworkRoutes = require('../src/modules/homework/homework.routes');
const assignmentRoutes = require('../src/modules/assignments/assignments.routes');
const libraryRoutes = require('../src/modules/library/library.routes');
const documentRoutes = require('../src/modules/documents/documents.routes');
const aiRoutes = require('../src/modules/ai/ai.routes');
const reportRoutes = require('../src/modules/reports/reports.routes');
const notificationRoutes = require('../src/modules/notifications/notifications.routes');
const { version: packageVersion } = require('../package.json');
const { signAccessToken, accessTokenPayload } = require('../src/utils/tokens');

const ROOT = path.resolve(__dirname, '..');
const PREFIX = config.app.apiPrefix;

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${ok ? '' : `  (expected ${JSON.stringify(expected)})`}`
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A port nothing is listening on, asked of the operating system rather than guessed. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/* ───────────────────────────── the pipeline ───────────────────────────── */

/**
 * The order the app mounts things in, as `app.js`'s header documents it.
 *
 * `query` and `expressInit` are Express's own, always first. Layer 12 is `apiLimiter` — the function
 * express-rate-limit returns is anonymous, so it is identified by position and by the headers it sets
 * rather than by name.
 */
const EXPECTED_STACK = [
  'query',
  'expressInit',
  'requestContext',
  'logger', // morgan
  'helmetMiddleware',
  'corsMiddleware',
  'compression',
  'jsonParser',
  'urlencodedParser',
  'cookieParser',
  'hpp',
  'sanitizeRequest',
  '<anonymous>', // apiLimiter
  'activityAuditHook',
  'router', // the /api/v1 router
  'notFoundHandler',
  'errorHandler',
];

function verifyStack() {
  console.log('\n--- app: the mount order is the contract ---');

  const app = createApp();
  const stack = app._router.stack;

  check('every documented layer is mounted and nothing else is', stack.length, EXPECTED_STACK.length);
  check(
    'in the documented order',
    stack.map((layer) => layer.name || '<anonymous>'),
    EXPECTED_STACK
  );

  /* The two that must be last, because both are terminal. */
  check('notFoundHandler is second from last', stack[stack.length - 2].name, 'notFoundHandler');
  check('errorHandler is last', stack[stack.length - 1].name, 'errorHandler');
  check(
    'and Express will recognise it as one, by its arity',
    stack[stack.length - 1].handle.length,
    4
  );

  /* Body parsing before anything that reads the body. */
  const at = (name) => stack.findIndex((layer) => layer.name === name);
  check('the request id is established before the access log', at('requestContext') < at('logger'), true);
  check('cookies are parsed before the router that needs them', at('cookieParser') < at('router'), true);
  check('hpp runs after the parsers it works on', at('hpp') > at('urlencodedParser'), true);
  check('sanitising runs before the limiter that records the caller', at('sanitizeRequest') < 12, true);
  check('the audit hook is installed before any route can describe a write', at('activityAuditHook') < at('router'), true);

  /* The router is mounted on the configured prefix, not a hard-coded one. */
  const routerLayer = stack[at('router')];
  check('the API router is mounted on the configured prefix', routerLayer.regexp.test(PREFIX), true);
  check('and not at the root', routerLayer.regexp.test('/health'), false);

  check('trust proxy comes from configuration', app.get('trust proxy'), config.app.trustProxy);
  check('and Express does not advertise itself', app.get('x-powered-by'), false);

  /* A factory, so a test can build one without inheriting another's state. */
  check('createApp returns a new instance each call', createApp() !== app, true);

  console.log('\n--- app: the public / authenticated boundary ---');

  const api = routerLayer.handle.stack;
  const systemLayer = api[0];

  /*
   * Twenty-five layers, in three groups: what is reachable without a token, the four-step chain that
   * draws the boundary, and what is reachable only past it. The count is asserted rather than left
   * implicit because a feature router mounted above the chain by accident is invisible — it works, it
   * just is not authenticated. A new module belongs after index 5, and this number moving is the
   * reminder.
   *
   * Indices 6–29 are the authenticated half of §7, the four SRS §9 platform modules, `/users` and
   * `/roles`, then `/plans`, `/addons` and `/subscriptions`, then the five Phase 3.H billing modules
   * `/taxes`, `/coupons`, `/invoices`, `/payments` and `/quotations`, then the four Phase 3.I school
   * setup modules `/school-settings`, `/sessions`, `/classes` and `/subjects`, then Phase 3.J's
   * `/teachers` at index 25, `/students` at 26, `/parents` at 27 and `/staff` at 28 — the whole of §15 — then Phase 3.K's `/attendance` at 29
   * Phase 3.L's `/fees` at 30
   * Phase 3.M's `/finance` at 31
   * Phase 3.N's `/exams` at 32
   * and Phase 3.O's `/timetable` at 33. `/users` and `/roles`
   * were the first mounts below the boundary that are *not* platform-only; the 3.I routers are the
   * same kind: Principal / School Admin is the actor, so they rely on `resolveTenant`/`enforceTenant`
   * above and `resolveSchool()` / `tenantWhere()` inside rather than on a scope guard.
   */
  check('the whole /api/v1 stack is accounted for', api.length, 42);
  check('the system routes are mounted first', systemLayer.name, 'router');

  /*
   * §28's documentation surface, at index 1 — the second of the layers mounted above the boundary,
   * and the only one of them that is a deliberate exception rather than a necessity.
   *
   * Everything else up here has to be: `/health` answers before a token exists, and the five public
   * `/auth` endpoints are how a token is obtained at all. `/docs` is here because the tools that
   * consume an OpenAPI document do not carry credentials, and because a document explaining how to
   * authenticate is useless to a caller who must already be authenticated to read it.
   *
   * What that trades away is stated rather than assumed: an anonymous reader learns the API's shape
   * and its permission vocabulary. It learns nothing about any tenant — the generator reads the
   * route table and the Joi schemas, and never touches the database. A deployment that would rather
   * not publish the vocabulary removes this one line; nothing else imports the router.
   */
  check('the OpenAPI surface is mounted above the boundary, which is why it needs no token',
    api[1].handle === docsRoutes, true);
  check(
    'then the public half of /auth — these five endpoints are how a caller gets a token at all',
    api[2].handle === authRoutes.publicRoutes,
    true
  );

  /*
   * The chain is identified by function identity, not by name.
   *
   * Three of the four arrive already wrapped in `asyncHandler`, whose wrapper is called
   * `wrappedAsyncHandler` and takes `...args`, so both the name and the arity of the original are
   * erased — by design, since Express identifies error handlers by `length === 4`. Identity is what
   * survives that, and it is the stronger assertion anyway: it proves the layer *is* the middleware,
   * not merely something with the right name.
   *
   * This is not pedantry, and the second assertion below is the reason. `enforcePasswordChange` is a
   * factory. Mounting it uncalled type-checks, starts cleanly and reads correctly — Express then hands
   * it `(req, res, next)`, it takes `req` as its options object, returns a function instead of calling
   * `next()`, and every authenticated request hangs with no error logged anywhere. Comparing against
   * the factory is what catches that; a name check does not, because the factory's name is right.
   */
  check('authenticate is the first layer past the public routes', api[3].handle === authenticate, true);
  check('the password gate is the factory’s product, not the factory', api[4].handle === enforcePasswordChange, false);
  check('it is what enforcePasswordChange returns', api[4].handle.name, 'passwordChangeGate');
  check('and it is a real middleware', api[4].handle.length, 3);
  check('then tenant resolution', api[5].handle === resolveTenant, true);
  check('then tenant enforcement', api[6].handle === enforceTenant, true);

  /*
   * The authenticated half of §7 is first below the boundary, and it has to be: the two paths
   * `enforcePasswordChange` allows through are in this router, so an account with the forced-change
   * flag set can reach those and nothing else in the system.
   */
  check(
    'and the authenticated half of /auth is the first thing below it',
    api[7].handle === authRoutes.protectedRoutes,
    true
  );

  /*
   * The four SRS §9 platform modules, each asserted by identity and by index.
   *
   * The index is the point. A router mounted at index 1 — above `authenticate` — still answers requests
   * and still passes its own tests; it simply serves every school's data to anyone who asks. Nothing
   * about the module would look wrong, so the assertion has to live here, against the position.
   */
  const platformMounts = [
    ['/platform', platformRoutes],
    ['/organizations', organizationRoutes],
    ['/schools', schoolRoutes],
    ['/principals', principalRoutes],
  ];

  platformMounts.forEach(([path, router], offset) => {
    const index = 8 + offset;
    check(`${path} is mounted at index ${index}, below the boundary`, api[index].handle === router, true);
  });

  /*
   * `/users` and `/roles` — the same index assertion, and it matters more here than above.
   *
   * The four §9 modules each carry `requirePlatformScope()` on their routes, so a mounting mistake that
   * lifted one above `authenticate` would still be caught by its own guard failing on an absent
   * `req.tenant`. These two do not: `users.view` is granted to Organization Admin and `users.manage` to
   * school leadership, so the routes are *meant* to be reachable without platform scope, and the only
   * thing standing between them and an unauthenticated caller is their position in this list.
   */
  const accountMounts = [
    ['/users', userRoutes],
    ['/roles', roleRoutes],
  ];

  accountMounts.forEach(([path, router], offset) => {
    const index = 12 + offset;
    check(`${path} is mounted at index ${index}, below the boundary`, api[index].handle === router, true);
    check(`and ${path} therefore sits past authenticate`, index > 2, true);
  });

  /*
   * `/plans`, `/addons` and `/subscriptions` — SRS §10, §11, §12, §33: the Phase 3.D subscription
   * modules, in the order they depend on each other.
   *
   * Asserted by index for the same reason as the rest, and by one extra property: all three services
   * throw when `req.tenant` is absent rather than defaulting to an unscoped read, so all three have to
   * sit below `resolveTenant`. A mount above index 4 would leave `req.tenant` undefined, and that throw
   * is the behaviour that turns a mounting mistake into a 500 instead of a leak.
   *
   * `/plans` is also the first router whose writes invalidate the entitlement cache. `/addons` is the
   * first whose writes deliberately invalidate nothing — `subscription_addons` copies the effect at
   * purchase, so a catalogue edit cannot stale a resolved snapshot — and its service header says so, in
   * case the absence ever reads as an oversight. `/subscriptions` is the counterpart to that: it writes
   * the three tables resolution actually reads, so it invalidates on every write, and it is the only
   * module that writes `schools.subscription_state` and therefore the tenant cache too.
   */
  const subscriptionMounts = [
    ['/plans', planRoutes],
    ['/addons', addonRoutes],
    ['/subscriptions', subscriptionRoutes],
  ];

  subscriptionMounts.forEach(([path, router], offset) => {
    const index = 14 + offset;
    check(`${path} is mounted at index ${index}, below the boundary`, api[index].handle === router, true);
    check(
      `and ${path} sits past tenant resolution, which scopeFor() requires`,
      api.findIndex((layer) => layer.handle === router) > 4,
      true
    );
  });

  /*
   * `/taxes`, `/coupons`, `/invoices`, `/payments` and `/quotations` — SRS §13: the Phase 3.H billing
   * modules, in the order money flows through them (a tax and a coupon modify an invoice, an invoice is
   * settled by a payment, a payment carries refunds; a quotation converts into an invoice). Asserted by
   * index for the same reason as the rest, and it matters here for the same reason it did for `/users`
   * and `/roles`: two of these routes are *not* platform-only. `payments.view` (the `/payments` reads)
   * reaches Organization Admin, and `payments.submit` (`POST /payments`) reaches school leadership and
   * the accountant, so neither sits behind a scope guard — only the tenant chain above and
   * `tenantWhere()` inside. A mount lifted above index 4 would leave `req.tenant` undefined, and every
   * one of these services throws on that rather than defaulting to an unscoped read.
   */
  const billingMounts = [
    ['/taxes', taxRoutes],
    ['/coupons', couponRoutes],
    ['/invoices', invoiceRoutes],
    ['/payments', paymentRoutes],
    ['/quotations', quotationRoutes],
  ];

  billingMounts.forEach(([path, router], offset) => {
    const index = 17 + offset;
    check(`${path} is mounted at index ${index}, below the boundary`, api[index].handle === router, true);
    check(
      `and ${path} sits past tenant resolution, which tenantWhere() requires`,
      api.findIndex((layer) => layer.handle === router) > 4,
      true
    );
  });

  /*
   * `/school-settings`, `/sessions`, `/classes` and `/subjects` — SRS §14: the Phase 3.I school
   * setup modules. Asserted by index for the same reason as `/users` and `/payments`: none of these
   * writes carry `requirePlatformScope()`. `school.settings.manage`, `sessions.manage`,
   * `classes.manage` and `subjects.manage` are seeded to Principal / School Admin, so the only thing
   * standing between them and an unauthenticated caller is their position past index 5, and the only
   * thing standing between a Principal and another school's rows is `resolveSchool()` plus
   * `tenantWhere()`. A mount lifted above index 4 would leave `req.tenant` undefined, and
   * `resolveSchool()` throws on that rather than defaulting to an unscoped read.
   */
  const schoolSetupMounts = [
    ['/school-settings', settingsRoutes],
    ['/sessions', sessionRoutes],
    ['/classes', classRoutes],
    ['/subjects', subjectRoutes],
  ];

  schoolSetupMounts.forEach(([path, router], offset) => {
    const index = 22 + offset;
    check(`${path} is mounted at index ${index}, below the boundary`, api[index].handle === router, true);
    check(
      `and ${path} sits past tenant resolution, which resolveSchool() requires`,
      api.findIndex((layer) => layer.handle === router) > 4,
      true
    );
  });

  /*
   * `/teachers` — SRS §15.3, the first Phase 3.J module and the first route in the project behind an
   * entitlement guard. Everything before it either governs the platform or, in §14's case, is covered
   * by no `MODULES` key at all. The `teachers.*` permissions do carry `module: MODULES.TEACHERS`, but
   * that field is metadata — nothing in the request path reads it — so the guard is asserted here as
   * a *router-level* layer rather than assumed from the permission definition. If it were dropped, a
   * school on a plan without the Teachers module would still reach every one of these routes and no
   * other check in this suite would notice.
   */
  check('/teachers is mounted at index 25, below the boundary', api[26].handle === teacherRoutes, true);
  check(
    'and /teachers sits past tenant resolution',
    api.findIndex((layer) => layer.handle === teacherRoutes) > 4,
    true
  );
  /*
   * What this can and cannot prove. `requireModule()` returns an `asyncHandler`-wrapped closure, so
   * its layer is named `wrappedAsyncHandler` and a fresh one is built per call — it is identifiable
   * by neither name nor identity, exactly like `requirePermission` (§2e, session 8). So the check
   * here is structural only: `/teachers` carries exactly one router-level middleware layer, mounted
   * ahead of every route. That the layer is specifically the Teachers *module* guard is proven
   * behaviourally over HTTP in `verify-teachers.js`, by putting a school on a plan without that
   * module and asserting `MODULE_NOT_SUBSCRIBED`. Neither check is sufficient alone.
   */
  check(
    '/teachers carries exactly one router-level guard, ahead of its routes',
    teacherRoutes.stack.filter((layer) => !layer.route).length,
    1
  );

  /* `/students` — the second Phase 3.J module, gated the same way and for the same reason. */
  check('/students is mounted at index 26, below the boundary', api[27].handle === studentRoutes, true);
  check(
    'and /students sits past tenant resolution',
    api.findIndex((layer) => layer.handle === studentRoutes) > 4,
    true
  );
  check(
    '/students carries exactly one router-level guard, ahead of its routes',
    studentRoutes.stack.filter((layer) => !layer.route).length,
    1
  );

  /* `/parents` — the third Phase 3.J module, and the only one whose create path makes a user. */
  check('/parents is mounted at index 27, below the boundary', api[28].handle === parentRoutes, true);
  check(
    'and /parents sits past tenant resolution',
    api.findIndex((layer) => layer.handle === parentRoutes) > 4,
    true
  );
  check(
    '/parents carries exactly one router-level guard, ahead of its routes',
    parentRoutes.stack.filter((layer) => !layer.route).length,
    1
  );

  /* `/staff` — the fourth and last Phase 3.J module, which closes SRS §15. */
  check('/staff is mounted at index 28, below the boundary', api[29].handle === staffRoutes, true);
  check(
    'and /staff sits past tenant resolution',
    api.findIndex((layer) => layer.handle === staffRoutes) > 4,
    true
  );
  check(
    '/staff carries exactly one router-level guard, ahead of its routes',
    staffRoutes.stack.filter((layer) => !layer.route).length,
    1
  );

  /* `/attendance` — Phase 3.K, the first module that consumes students and teachers. */
  check('/attendance is mounted at index 29, below the boundary', api[30].handle === attendanceRoutes, true);
  check(
    'and /attendance sits past tenant resolution',
    api.findIndex((layer) => layer.handle === attendanceRoutes) > 4,
    true
  );
  check(
    '/attendance carries exactly one router-level guard, ahead of its routes',
    attendanceRoutes.stack.filter((layer) => !layer.route).length,
    1
  );

  /* `/fees` — Phase 3.L, the first school-side module that handles money. */
  check('/fees is mounted at index 30, below the boundary', api[31].handle === feeRoutes, true);
  check(
    'and /fees sits past tenant resolution',
    api.findIndex((layer) => layer.handle === feeRoutes) > 4,
    true
  );
  check(
    '/fees carries exactly one router-level guard, ahead of its routes',
    feeRoutes.stack.filter((layer) => !layer.route).length,
    1
  );

  /* `/finance` — Phase 3.M, income and expenses, and the net balance computed from them. */
  check('/finance is mounted at index 31, below the boundary', api[32].handle === financeRoutes, true);
  check(
    'and /finance sits past tenant resolution',
    api.findIndex((layer) => layer.handle === financeRoutes) > 4,
    true
  );
  check(
    '/finance carries exactly one router-level guard, ahead of its routes',
    financeRoutes.stack.filter((layer) => !layer.route).length,
    1
  );

  /* `/exams` — Phase 3.N, SRS §19: five tables behind one subscribable key. */
  check('/exams is mounted at index 32, below the boundary', api[33].handle === examRoutes, true);
  check(
    'and /exams sits past tenant resolution',
    api.findIndex((layer) => layer.handle === examRoutes) > 4,
    true
  );
  check(
    '/exams carries exactly one router-level guard, ahead of its routes',
    examRoutes.stack.filter((layer) => !layer.route).length,
    1
  );

  /* `/timetable` — Phase 3.O, SRS §20.1. */
  check('/timetable is mounted at index 33, below the boundary', api[34].handle === timetableRoutes, true);
  check(
    'and /timetable sits past tenant resolution',
    api.findIndex((layer) => layer.handle === timetableRoutes) > 4,
    true
  );
  check(
    '/timetable carries exactly one router-level guard, ahead of its routes',
    timetableRoutes.stack.filter((layer) => !layer.route).length,
    1
  );

  /* `/homework` — Phase 3.P, SRS §20.2: the first router in the application that mounts an upload. */
  check('/homework is mounted at index 34, below the boundary', api[35].handle === homeworkRoutes, true);
  check(
    'and /homework sits past tenant resolution',
    api.findIndex((layer) => layer.handle === homeworkRoutes) > 4,
    true
  );
  check(
    '/homework carries exactly one router-level guard, ahead of its routes',
    homeworkRoutes.stack.filter((layer) => !layer.route).length,
    1
  );

  /* `/assignments` — Phase 3.Q, SRS §20.3: the first router where a student's own request writes. */
  check('/assignments is mounted at index 35, below the boundary', api[36].handle === assignmentRoutes, true);
  check(
    'and /assignments sits past tenant resolution',
    api.findIndex((layer) => layer.handle === assignmentRoutes) > 4,
    true
  );
  check(
    '/assignments carries exactly one router-level guard, ahead of its routes',
    assignmentRoutes.stack.filter((layer) => !layer.route).length,
    1
  );
  /*
   * Declaration order is load-bearing on this router and on no other: `GET /:id` above
   * `GET /submissions` would swallow the literal path and hand "submissions" to `idParam`, which
   * answers 422 for a route that exists. Asserted as a list so a tidy-up reorder fails here.
   */
  check(
    'the /assignments routes are declared with the literal /submissions paths first',
    assignmentRoutes.stack
      .filter((layer) => layer.route)
      .map((layer) => `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`),
    [
      'GET /submissions',
      'GET /submissions/:id/attachment',
      'GET /submissions/:id',
      'PATCH /submissions/:id/review',
      'GET /',
      'POST /',
      'GET /:id',
      'PATCH /:id',
      'POST /:id/submissions',
    ]
  );

  /* `/library` — Phase 3.R, SRS §20.4: the first module with a counter two writers contend for. */
  check('/library is mounted at index 36, below the boundary', api[37].handle === libraryRoutes, true);
  check(
    'and /library sits past tenant resolution',
    api.findIndex((layer) => layer.handle === libraryRoutes) > 4,
    true
  );
  check(
    '/library carries exactly one router-level guard, ahead of its routes',
    libraryRoutes.stack.filter((layer) => !layer.route).length,
    1
  );

  /* `/documents` — Phase 3.S, SRS §20.5: the only module router that mounts no requireModule(). */
  check('/documents is mounted at index 37, below the boundary', api[38].handle === documentRoutes, true);
  check(
    'and /documents sits past tenant resolution',
    api.findIndex((layer) => layer.handle === documentRoutes) > 4,
    true
  );
  check(
    '/documents carries exactly one router-level guard, ahead of its routes',
    documentRoutes.stack.filter((layer) => !layer.route).length,
    1
  );

  /* `/ai` — Phase 3.T, SRS §21: the first module to meter a limit and record its own usage. */
  check('/ai is mounted at index 38, below the boundary', api[39].handle === aiRoutes, true);
  check(
    'and /ai sits past tenant resolution',
    api.findIndex((layer) => layer.handle === aiRoutes) > 4,
    true
  );
  check(
    '/ai carries exactly one router-level guard, ahead of its routes',
    aiRoutes.stack.filter((layer) => !layer.route).length,
    1
  );

  /*
   * `/reports` — Phase 3.U, SRS §22. The ONLY module router with no router-level guard, because the
   * Subscription Report answers to a permission declared with `module: null` and granted to the two
   * scopes that have no single school; a module gate resolves one school or refuses. The six school
   * reports carry `requireModule(REPORTS, <owning>)` per route instead.
   */
  check('/reports is mounted at index 39, below the boundary', api[40].handle === reportRoutes, true);
  check(
    'and /reports sits past tenant resolution',
    api.findIndex((layer) => layer.handle === reportRoutes) > 4,
    true
  );
  check(
    '/reports carries NO router-level guard',
    reportRoutes.stack.filter((layer) => !layer.route).length,
    0
  );
  /*
   * The precise claim, measured. An earlier draft asserted /reports was the only module router without
   * a router-level guard and this check refuted it on its first run: nineteen others have none either,
   * because they are not entitlement-aware at all. Among the fifteen routers that DO reference
   * requireModule() or requireActiveSubscription(), fourteen mount one and reports is the exception.
   */
  check(
    '  and among the entitlement-aware routers it is the only one, which is the claim worth making',
    (() => {
      const fsx = require('fs');
      const pathx = require('path');
      const dir = pathx.join(__dirname, '../src/modules');
      const none = [];
      let aware = 0;
      for (const m of fsx.readdirSync(dir)) {
        const f = pathx.join(dir, m, `${m}.routes.js`);
        if (!fsx.existsSync(f)) continue;
        const src = fsx.readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (!/requireModule\(|requireActiveSubscription\(/.test(src)) continue;
        aware += 1;
        // eslint-disable-next-line global-require
        if (require(f).stack.filter((l) => !l.route).length === 0) none.push(m);
      }
      return [aware, none];
    })(),
    [15, ['reports']]
  );

  /*
   * `/notifications` — Phase 3.V, SRS §23. Like `/reports` it mounts no router-level guard, but for
   * the opposite reason: `/reports` has a module key and declines to gate on it, while §23 has none
   * to gate on. There is no `MODULES.NOTIFICATIONS`, both its permissions carry `module: null`, and
   * notifications are core — a school on the smallest plan still receives them. So the count of
   * entitlement-aware routers asserted above stays at fifteen, which is itself the proof: had this
   * router referenced `requireModule()`, that assertion would name it as a second exception.
   */
  check('/notifications is mounted at index 40, below the boundary',
    api[41].handle === notificationRoutes, true);
  check(
    'and /notifications sits past tenant resolution',
    api.findIndex((layer) => layer.handle === notificationRoutes) > 4,
    true
  );
  check(
    '/notifications carries no router-level guard, having no module key to name',
    notificationRoutes.stack.filter((layer) => !layer.route).length,
    0
  );
  /*
   * §23's dispatch has NO route, which is the section's central fact. Asserted on the mounted router
   * rather than in the module's own suite, because this is where "what the application exposes" is
   * measured: five routes, none of which sends anything.
   */
  check(
    'and dispatch is reachable from no URL — five routes, all of them reading or repairing',
    notificationRoutes.stack.filter((l) => l.route).map(
      (l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`
    ),
    ['GET /', 'POST /read-all', 'GET /:id', 'POST /:id/read', 'POST /:id/retry']
  );

  check(
    'every §9 module is past the tenant chain, not merely present',
    platformMounts.every(([, router]) => api.findIndex((layer) => layer.handle === router) > 5),
    true
  );

  const publicRoutes = systemLayer.handle.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`);
  check('the four public routes, and only those', publicRoutes, [
    'GET /health',
    'GET /health/ready',
    'GET /meta',
    'GET /csrf-token',
  ]);

  return app;
}

/* ─────────────────────────── the CORS options ─────────────────────────── */

function verifyCorsOptions() {
  console.log('\n--- app: CORS is an allow-list, not a reflector ---');

  const options = corsOptions();
  const decide = (origin) =>
    new Promise((resolve) => {
      options.origin(origin, (err, allowed) =>
        resolve(err ? { refused: err.code, status: err.statusCode } : { allowed })
      );
    });

  check('credentials are allowed, because the refresh cookie needs them', options.credentials, true);
  check('the double-submit header is in the preflight allow-list', options.allowedHeaders.includes('X-CSRF-Token'), true);
  check(
    'the request id is readable by the client that made it, and so is a download\'s filename',
    options.exposedHeaders,
    ['X-Request-Id', 'Content-Disposition']
  );
  check('preflights are cacheable', options.maxAge, 600);

  return Promise.all([
    decide('http://localhost:3000'),
    decide('https://app.example.test'),
    decide('https://evil.example.test'),
    decide(undefined),
  ]).then(([first, second, hostile, none]) => {
    check('an allow-listed origin is allowed', first, { allowed: true });
    check('so is the second entry, so the list is read as a list', second, { allowed: true });
    check('anything else is refused', hostile, { refused: 'ORIGIN_NOT_ALLOWED', status: 403 });
    check('a request with no Origin is allowed — CORS does not govern those', none, { allowed: true });
  });
}

/* ───────────────────────── the logging pipeline ───────────────────────── */

/**
 * That morgan reaches winston *and* that winston will emit what it is handed.
 *
 * The second half is the one that matters: a level below the configured one is discarded in silence,
 * so a correctly wired access log can still record nothing at all.
 */
function verifyLogLevels() {
  console.log('\n--- app: the access log is at a level winston emits ---');

  check('the run is pinned to the default level', config.logging.level, 'info');
  check('info is emitted', logger.isLevelEnabled('info'), true);
  check('http is not — npm puts it below info, which is the whole trap', logger.isLevelEnabled('http'), false);
}

/* ───────────────────────────── over HTTP ───────────────────────────── */

/** Every morgan line the app produced, captured instead of printed. */
const accessLog = [];
const realInfo = logger.info.bind(logger);

async function verifyHttp(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  let counter = 0;
  const nextId = (label) => {
    counter += 1;
    return `verify-app-${label}-${String(counter).padStart(3, '0')}`;
  };

  /**
   * One request, reported as a flat object so an assertion can name a field rather than dig.
   *
   * `raw` sends a body string verbatim — malformed JSON cannot be produced by `JSON.stringify`.
   */
  async function call(url, { method = 'GET', headers = {}, body, raw, label = 'req' } = {}) {
    const requestId = nextId(label);
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) payload = JSON.stringify(body);

    const res = await fetch(base + url, {
      method,
      headers: {
        ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'X-Request-Id': requestId,
        ...headers,
      },
      body: payload,
    });

    let parsed = null;
    const text = await res.text();
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    return {
      status: res.status,
      contentType: (res.headers.get('content-type') || '').split(';')[0],
      header: (name) => res.headers.get(name),
      body: parsed,
      text,
      data: parsed && parsed.data,
      code: parsed && parsed.error && parsed.error.code,
      errorRequestId: parsed && parsed.error && parsed.error.requestId,
      sentRequestId: requestId,
    };
  }

  /* ---- liveness, readiness, meta -------------------------------------------------------- */

  console.log('\n--- system: liveness ---');
  {
    const r = await call(`${PREFIX}/health`, { label: 'health' });
    check('answers', r.status, 200);
    check('as JSON', r.contentType, 'application/json');
    check('in the success envelope', r.body.success, true);
    check('with the one signal it exists to give', r.data.status, 'ok');
    check('and an uptime in whole seconds', Number.isInteger(r.data.uptime) && r.data.uptime >= 0, true);
    check('nothing else — a health endpoint is not a configuration dump', Object.keys(r.data).sort(), [
      'status',
      'uptime',
    ]);
    check('the request id is echoed in the header', r.header('X-Request-Id'), r.sentRequestId);
    check('and Express does not name itself', r.header('X-Powered-By'), null);
  }

  console.log('\n--- system: readiness ---');
  {
    const r = await call(`${PREFIX}/health/ready`, { label: 'ready' });
    check('answers 200 while the database answers', r.status, 200);
    check('reporting ready', r.data.status, 'ready');
    check('and which dependency it checked', r.data.checks, { database: 'up' });
    check('without naming the host, the driver or the pool', Object.keys(r.data.checks), ['database']);
  }

  console.log('\n--- system: the API descriptor ---');
  {
    const r = await call(`${PREFIX}/meta`, { label: 'meta' });
    check('answers', r.status, 200);
    check('the application name from configuration', r.data.name, config.app.name);
    check('the version from package.json, not a literal', r.data.version, packageVersion);
    check('the prefix a client should be calling', r.data.apiPrefix, PREFIX);
    check('and the environment', r.data.environment, config.env);
    check('and nothing that is not a client’s business', Object.keys(r.data).sort(), [
      'apiPrefix',
      'environment',
      'name',
      'version',
    ]);
  }

  console.log('\n--- system: the CSRF bootstrap ---');
  {
    const r = await call(`${PREFIX}/csrf-token`, { label: 'csrf' });
    check('answers without a session, which is the point of it', r.status, 200);
    check('with a token', typeof r.data.token === 'string' && r.data.token.length >= 16, true);
    const cookie = r.header('set-cookie') || '';
    check('and the cookie half of the double submit', cookie.startsWith(`${config.security.csrfCookieName}=`), true);
    check('readable by the frontend script that must echo it', /HttpOnly/i.test(cookie), false);
    check('and not sent on a cross-site navigation', /SameSite=Lax/i.test(cookie), true);
  }

  /* ---- the two terminal handlers -------------------------------------------------------- */

  console.log('\n--- app: an unmatched path ---');
  {
    const r = await call('/nope', { label: 'notfound' });
    check('is refused', r.status, 404);
    check('as JSON, not as Express’s HTML page', r.contentType, 'application/json');
    check('there is no HTML in it at all', /<html|<pre>/i.test(r.text), false);
    check('in the failure envelope', r.body.success, false);
    check('with the one code for it', r.code, 'ROUTE_NOT_FOUND');
    check('naming the method and path', r.body.error.message, 'No route matches GET /nope');
    check('and carrying the id the caller can quote', r.errorRequestId, r.sentRequestId);
  }
  {
    const r = await call(`${PREFIX}/nope`, { label: 'under-prefix' });
    check('under the prefix, an unknown path is 401 rather than 404', r.status, 401);
    check('because the chain runs before Express decides nothing matched', r.code, 'TOKEN_MISSING');
    check('which declines to enumerate what exists', /nope/.test(r.body.error.message), false);
  }

  console.log('\n--- app: an error becomes the envelope ---');
  {
    const r = await call(`${PREFIX}/health`, { method: 'POST', raw: '{"broken": ', label: 'badjson' });
    check('malformed JSON is the client’s fault', r.status, 400);
    check('with a code that says which fault', r.code, 'MALFORMED_JSON');
    check('as JSON', r.contentType, 'application/json');
    check('with the request id', r.errorRequestId, r.sentRequestId);
    check('and no stack, because it is not a 5xx', r.body.error.stack, undefined);
  }
  {
    /* Over the pinned 1kb, so this proves the configured limit is the one in force. */
    const r = await call(`${PREFIX}/health`, {
      method: 'POST',
      raw: JSON.stringify({ pad: 'x'.repeat(4096) }),
      label: 'toolarge',
    });
    check('a body over JSON_BODY_LIMIT is refused', r.status, 413);
    check('by code', r.code, 'PAYLOAD_TOO_LARGE');
    check('and the limit in force is the configured one', config.app.jsonBodyLimit, '1kb');
  }

  /* ---- transport ----------------------------------------------------------------------- */

  console.log('\n--- app: transport headers ---');
  {
    const r = await call(`${PREFIX}/health`, { label: 'helmet' });
    check('helmet: content sniffing off', r.header('x-content-type-options'), 'nosniff');
    check('helmet: framing refused', r.header('x-frame-options'), 'SAMEORIGIN');
    check('helmet: the referrer is not leaked', r.header('referrer-policy'), 'no-referrer');
    check('helmet: HSTS is set', /max-age=\d+/.test(r.header('strict-transport-security') || ''), true);
    check('helmet: the resource policy we chose, not the default', r.header('cross-origin-resource-policy'), 'same-site');
    /*
     * Two middlewares contribute to `Vary`, and both must: `cors` adds `Origin` because the
     * allow-list makes the response origin-dependent, `compression` adds `Accept-Encoding`. A cache
     * that saw only one of them would serve one origin's response to another, or a gzipped body to a
     * client that cannot read it.
     */
    check(
      'cors and compression each declare what the response varies on',
      (r.header('vary') || '').split(', '),
      ['Origin', 'Accept-Encoding']
    );
    check('the limiter states its policy, so it is in the chain', r.header('ratelimit-policy'), `${config.rateLimit.max};w=${config.rateLimit.windowMinutes * 60}`);
    check('and what is left of it', /^limit=\d+, remaining=\d+, reset=\d+$/.test(r.header('ratelimit') || ''), true);
  }

  console.log('\n--- app: CORS over the wire ---');
  {
    const r = await call(`${PREFIX}/health`, {
      headers: { Origin: 'http://localhost:3000' },
      label: 'cors-ok',
    });
    check('an allow-listed origin is served', r.status, 200);
    check('echoed exactly, not as a wildcard', r.header('access-control-allow-origin'), 'http://localhost:3000');
    check('with credentials permitted', r.header('access-control-allow-credentials'), 'true');
    check(
      'and the request id and download filename readable',
      r.header('access-control-expose-headers'),
      'X-Request-Id,Content-Disposition'
    );
  }
  {
    const r = await call(`${PREFIX}/health`, {
      headers: { Origin: 'https://evil.example.test' },
      label: 'cors-no',
    });
    check('an unknown origin is refused', r.status, 403);
    check('by code', r.code, 'ORIGIN_NOT_ALLOWED');
    check('naming the origin, so the log is actionable', r.body.error.details, {
      origin: 'https://evil.example.test',
    });
    check('and no allow-origin header is granted', r.header('access-control-allow-origin'), null);
  }
  {
    const r = await call(`${PREFIX}/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-csrf-token',
      },
      label: 'preflight',
    });
    check('a preflight succeeds', r.status, 204);
    check('for the second allow-list entry', r.header('access-control-allow-origin'), 'https://app.example.test');
    check('permitting the double-submit header', /x-csrf-token/i.test(r.header('access-control-allow-headers') || ''), true);
    check('and cacheable for ten minutes', r.header('access-control-max-age'), '600');
  }

  /* ---- the access log ------------------------------------------------------------------ */

  console.log('\n--- app: morgan reaches winston ---');
  {
    /* Captured rather than printed, so the assertion output stays readable. */
    logger.info = (message, meta) => {
      if (typeof message === 'string') accessLog.push(message);
      return meta === undefined ? undefined : undefined;
    };
    await call(`${PREFIX}/meta`, { label: 'logged' });
    await sleep(60); // morgan writes on response finish
    logger.info = realInfo;

    const line = accessLog.find((entry) => entry.includes(`${PREFIX}/meta`));
    check('a request produces an access line', Boolean(line), true);
    check('in the configured format', /^GET \/api\/v1\/meta 200 \d+ - [\d.]+ ms$/.test(line || ''), true);
  }

  /* ---- past the boundary --------------------------------------------------------------- */

  console.log('\n--- app: past the boundary ---');
  {
    const admin = await db.User.findOne({
      where: { email: config.superAdmin.email },
      include: [{ model: db.Role, as: 'role' }],
    });
    check('the seeded Super Admin is present to authenticate as', Boolean(admin), true);

    if (admin) {
      const token = signAccessToken(accessTokenPayload({ ...admin.get(), role: admin.role }));

      /*
       * The seeder sets `must_change_password`, so this account is the one case where the gate is
       * exercised by real seeded state rather than by a fixture. Asserted rather than worked around:
       * The bootstrap account can do nothing until it changes its password. Not an SRS FR — see the
       * note in `authenticate.js` on why the column exists.
       */
      check('the bootstrap account is seeded needing a password change', admin.must_change_password, true);

      const blocked = await call(`${PREFIX}/nope`, {
        headers: { Authorization: `Bearer ${token}` },
        label: 'gate',
      });
      check('so an authenticated request is refused', blocked.status, 403);
      check('by the forced-change gate, not by the router', blocked.code, 'PASSWORD_CHANGE_REQUIRED');

      /*
       * An allow-listed path, which no module serves yet. It therefore passes the gate, then the two
       * tenant layers, and falls out of the router into the 404 — proving the exception list works and
       * that the whole chain calls `next()` rather than ending the response, in one request.
       */
      const through = await call(`${PREFIX}/auth/change-password`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        label: 'allowed',
      });
      check('an allow-listed path passes the gate', through.status, 404);
      check('through the tenant layers and out to the 404', through.code, 'ROUTE_NOT_FOUND');
      check('which is what Phase 3.D’s modules will be mounted in front of', through.body.success, false);
    }
  }

  await new Promise((resolve) => server.close(resolve));
}

/* ─────────────────────────────── server.js ─────────────────────────────── */

/**
 * Run `src/server.js` as its own process.
 *
 * @param {object} env       extra environment for the child
 * @param {string} [emit]    a signal the child emits on itself once listening
 * @returns {{child: import('child_process').ChildProcess, done: Promise<{code:number, output:string}>}}
 */
function runServer(env, emit) {
  /*
   * `-e` rather than the file directly, so the child can emit a signal on itself. On win32
   * `process.kill(pid, 'SIGTERM')` terminates abruptly instead of delivering the signal, so this is
   * the only way to reach the handler in-process. What it exercises is the handler; the operating
   * system's delivery of a real SIGTERM is not verifiable here.
   */
  const entry = JSON.stringify(path.join(ROOT, 'src/server.js'));
  const script = emit
    ? `require(${entry}); setTimeout(() => process.emit(${JSON.stringify(emit)}), 1500);`
    : `require(${entry});`;

  const child = spawn(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const done = new Promise((resolve) => {
    /* A backstop, so a child that never exits fails the run rather than hanging it. */
    const guard = setTimeout(() => child.kill(), 25000);
    child.on('exit', (code) => {
      clearTimeout(guard);
      resolve({ code, output });
    });
  });

  return { child, done };
}

/** Poll a URL until it answers or the deadline passes — the child binds asynchronously. */
async function waitFor(url, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url); // eslint-disable-line no-await-in-loop
      return { status: res.status, body: await res.json() };
    } catch {
      await sleep(150); // eslint-disable-line no-await-in-loop
    }
  }
  return null;
}

async function verifyServer() {
  console.log('\n--- server: it boots, binds and serves ---');

  const port = await freePort();
  const running = runServer({ PORT: String(port) });

  const answer = await waitFor(`http://127.0.0.1:${port}${PREFIX}/health`);
  check('the process binds the configured port', Boolean(answer), true);
  if (answer) {
    check('and serves the app on it', answer.status, 200);
    check('through the same envelope', answer.body.data.status, 'ok');
  }

  /* Done with it. Killed rather than signalled, because the graceful path is asserted separately. */
  running.child.kill();
  await running.done;

  console.log('\n--- server: shutdown is graceful ---');
  const stopped = runServer({ PORT: String(await freePort()) }, 'SIGTERM');
  const { code, output } = await stopped.done;

  check('the shutdown handler exits cleanly', code, 0);
  /*
   * The §29 schema guard runs at boot — asserted on a real process, not on the source.
   *
   * `models/index.js` promised in two docblocks that `assertSchemaMatchesSrs()` "fails at boot", and
   * this file's own subject promised the same in its header, while the only caller was
   * `scripts/check-models.js`, an opt-in developer command. `npm start` bound its port with the guard
   * never run. Nothing here noticed, because every assertion about server.js was about shutdown,
   * ports and logging — none about what boot *verifies*.
   *
   * Matched without the section sign: this output is accumulated with `output += chunk` on a raw
   * stream, so a multi-byte character landing on a chunk boundary would decode to replacement
   * characters and flake. `§` is two bytes; "Schema matches SRS" is not.
   */
  check('the boot sequence runs the §29 schema guard before serving',
    /Schema matches SRS/.test(output), true);
  check('  and reports the table count the guard actually counted',
    /Schema matches SRS[^(]*\(64 tables\)/.test(output), true);

  check('after reporting it was asked', /Shutting down \(SIGTERM\)/.test(output), true);
  check('closing the HTTP server first', /HTTP server closed/.test(output), true);
  check('then the database pool', /Database pool closed/.test(output), true);
  check(
    'in that order, so in-flight requests still had a connection',
    output.indexOf('HTTP server closed') < output.indexOf('Database pool closed'),
    true
  );

  console.log('\n--- server: a bad configuration fails at boot, not on the first request ---');
  const badPort = await freePort();
  const bad = runServer({ PORT: String(badPort), DB_NAME: 'msms_definitely_not_a_database' });
  const badResult = await bad.done;

  check('it refuses to start', badResult.code, 1);
  check('saying so', /Failed to start/.test(badResult.output), true);
  check(
    'and nothing is listening on the port it would have used',
    await waitFor(`http://127.0.0.1:${badPort}${PREFIX}/health`, 1200),
    null
  );
}

/* ─────────────────────────────── the run ─────────────────────────────── */

async function main() {
  const app = verifyStack();
  await verifyCorsOptions();
  verifyLogLevels();
  await verifyHttp(app);
  await verifyServer();
}

main()
  .catch((err) => {
    failures += 1;
    logger.info = realInfo;
    console.error('\nVerification aborted:', err);
  })
  .finally(async () => {
    logger.info = realInfo;
    console.log(failures === 0 ? '\nAll app-wiring checks passed.' : `\n${failures} check(s) FAILED.`);
    await db.sequelize.close();
    process.exit(failures === 0 ? 0 : 1);
  });
