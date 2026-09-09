'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *
 *   RATE_LIMIT_MAX       raised past what this script sends. `apiLimiter` is mounted globally and this
 *   AUTH_RATE_LIMIT_MAX  run makes several hundred calls; the limiter's own behaviour is verified in
 *                        scripts/verify-middlewares.js and is not what is under test here.
 *   BCRYPT_ROUNDS=10     a handful of hashes (three fixtures plus every Principal created through
 *                        FR-SADMIN-009). 10 keeps the run short; the shipped default is 12.
 *   PASSWORD_MIN_LENGTH  pinned so the assertions about the floor do not depend on the local .env.
 *   MAIL_DRIVER=log      FR-SADMIN-009 sends a verification email. Pinned so nothing can escape to a
 *                        real SMTP server, and so `verificationEmailSent` is deterministic.
 *   CSRF_ENABLED         left at its default: none of the routes under test is cookie
 *                        authorised, so the guard has nothing to say about them.
 */
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.BCRYPT_ROUNDS = '10';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';

/**
 * Verification of the four SRS §9 platform modules — FR-SADMIN-001 … FR-SADMIN-009.
 *
 *   src/modules/platform/*        §9.1  the eleven dashboard metrics
 *   src/modules/organizations/*   §5    the rows FR-SADMIN-002's precondition needs
 *   src/modules/schools/*         §9.2  the nine School Management operations
 *   src/modules/principals/*      §9.3  Principal creation, and the list §9.2 selects from
 *
 * ## What is asserted, and why each part exists
 *
 *  - **Part 1 — the schemas, directly.** Cheap, and it pins the decisions the three validation modules
 *    make that no HTTP response can show: that `code` is upper-cased before it reaches a
 *    case-insensitive unique index, that `website` must carry a scheme (the `javascript:` href vector
 *    `sanitizeRequest` does not catch), and — the important one — that `schools.update` cannot carry
 *    `status`, so the generic edit route cannot perform an FR-SADMIN-005 transition behind the
 *    `schools.status` permission's back.
 *
 *  - **Part 2 — the route tables, by function identity.** `validateRequest`, `activityDeclaration` and
 *    `platformGuard` are plain named functions, so their presence on a given route is checkable
 *    without sending a request. The permission guard is not: `requirePermission` returns an
 *    `asyncHandler`-wrapped anonymous arrow, which erases both its name and its identity. It is
 *    therefore asserted in part 3 instead, over HTTP, from its own 403 body.
 *
 *  - **Part 3 — over real HTTP, against the real database.** Everything that is a rule rather than a
 *    shape: the two 409s, the three status transitions, the three conditions on assigning a Principal,
 *    the cache invalidation FR-SADMIN-005 depends on, the soft delete, and tenant isolation.
 *
 * ## The two assertions worth reading before changing anything
 *
 *  - **FR-SADMIN-005 is proved end-to-end with a live token.** A Principal signs in while their school
 *    is active, suspending the school is done by a *different* caller, and the Principal's existing
 *    token is then refused with `SCHOOL_SUSPENDED`. That only passes if `setStatus` awaited
 *    `tenantService.invalidateSchool` — a cached tenant record would let the suspended school keep
 *    working until the entry expired, which is the failure this requirement exists to prevent.
 *
 *  - **The permission key of every route is pinned by its own refusal.** A `super_admin` fixture with
 *    all eleven keys in `denied_permissions` gets `INSUFFICIENT_PERMISSION` from each route, and the
 *    403 names `details.required`. Because the fixture is still platform-scoped, `platformGuard`
 *    passes and the permission guard is what answers — so the map of route → key is asserted rather
 *    than assumed. The org-admin fixture proves the ordering: lacking both the scope and the key, it
 *    gets `PLATFORM_SCOPE_REQUIRED`, so the scope guard runs first.
 *
 * ## Fixtures
 *
 * Three users under the `@verify-platform.local` domain (a platform Super Admin, a Super Admin with
 * every relevant permission denied, and an Organization Admin), two organizations, three schools and
 * three Principals — the last three created through FR-SADMIN-009's own endpoint, because a fixture
 * built with `User.create` would not exercise it. Everything is hard-deleted at the end along with the
 * `activity_logs` and `audit_logs` rows the run generated. The seeded Super Admin is never touched.
 *
 * `logger.warn` and `logger.error` lines during the run are expected: every cross-tenant refusal and
 * every deliberate 403 logs.
 *
 * Run: node scripts/verify-platform-modules.js
 */

const db = require('../src/models');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const { periodRange } = require('../src/utils/dates');
const {
  ROLES,
  USER_STATUS,
  SCHOOL_STATUS,
  ORGANIZATION_STATUS,
  USAGE_LIMIT_KEYS,
  HEADCOUNT_LIMITS,
} = require('../src/config/constants');

const platformRoutes = require('../src/modules/platform/platform.routes');
const organizationRoutes = require('../src/modules/organizations/organizations.routes');
const schoolRoutes = require('../src/modules/schools/schools.routes');
const principalRoutes = require('../src/modules/principals/principals.routes');

const orgSchemas = require('../src/modules/organizations/organizations.validation').schemas;
const schoolSchemas = require('../src/modules/schools/schools.validation').schemas;
const principalSchemas = require('../src/modules/principals/principals.validation').schemas;

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-platform.local';
const PASSWORD = 'Verify@Platform123';

/**
 * Every permission key the routes under test require — eleven of them, which is also what
 * `denied_permissions` is built from at :589.
 *
 * The count of *routes* used to be stated here as fourteen and is now left unstated: the four modules
 * involved define twenty route handlers between them and this suite does not exercise all of them,
 * so any single figure would need counting properly before it could be written down. An unverified
 * number is what produced the wrong one.
 */
const ROUTE_KEYS = Object.freeze([
  'platform.dashboard.view',
  'organizations.view',
  'organizations.manage',
  'schools.view',
  'schools.manage',
  'schools.status',
  'schools.archive',
  'schools.assign_principal',
  'schools.usage.view',
  'users.view',
  'users.manage',
]);

let failures = 0;

/*
 * This run's request tag — module scope, because BOTH the request helper and `teardown()` need
 * it and they live in different functions. Declared inside `verifyHttp()` first, which made the
 * teardown throw a ReferenceError, skip entirely, and leave every row behind: the residue this
 * change exists to remove got larger, and a later assertion failed on the rows left over.
 */
const REQUEST_TAG = 'vfy-platform-modules';
let requestSeq = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${
      ok ? '' : `  (expected ${JSON.stringify(expected)})`
    }`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ═══════════════════════════ part 1 — the schemas ═══════════════════════════ */

/** Validate against one schema and report the outcome in a shape an assertion can name. */
function run(schema, value) {
  const { error, value: cleaned } = schema.validate(value, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });
  return {
    ok: !error,
    value: cleaned,
    types: error ? error.details.map((d) => d.type) : [],
    messages: error ? error.details.map((d) => d.message) : [],
    fields: error ? error.details.map((d) => d.path.join('.')) : [],
  };
}

function verifyOrganizationSchemas() {
  console.log('\n--- validation: organizations ---');

  const minimal = run(orgSchemas.create, { name: '  Alpha Group  ', code: '  alpha-1  ' });
  check('name is trimmed', minimal.value.name, 'Alpha Group');
  check(
    'code is trimmed and upper-cased — the unique index is case-insensitive under MariaDB’s default collation, so acme and ACME already collide',
    minimal.value.code,
    'ALPHA-1'
  );
  check('status is not defaulted by Joi — the column’s own default applies', minimal.value.status, undefined);

  check('name is required', run(orgSchemas.create, { code: 'ALPHA' }).fields, ['name']);
  check('code is required', run(orgSchemas.create, { name: 'Alpha' }).fields, ['code']);

  const badCode = run(orgSchemas.create, { name: 'Alpha', code: '-ALPHA' });
  check('a code may not start with punctuation', badCode.types, ['string.pattern.base']);
  check(
    'and the message says what is allowed',
    badCode.messages[0],
    '"code" must start with a letter or digit and may contain only letters, digits, hyphens and underscores'
  );
  check(
    'nor contain a space',
    run(orgSchemas.create, { name: 'Alpha', code: 'AL PHA' }).types,
    ['string.pattern.base']
  );

  const script = run(orgSchemas.create, {
    name: 'Alpha',
    code: 'ALPHA',
    website: 'javascript:alert(1)',
  });
  check('a javascript: website is refused — sanitizeRequest does not catch an href', script.ok, false);
  check(
    'by the scheme rule, which Joi raises as uriCustomScheme once a scheme list is given',
    script.types,
    ['string.uriCustomScheme']
  );
  check(
    'and the custom message actually reaches the caller',
    script.messages[0],
    '"website" must be a full http:// or https:// address'
  );
  check(
    'a bare hostname is refused too — a scheme is not optional',
    run(orgSchemas.create, { name: 'Alpha', code: 'ALPHA', website: 'alpha.example' }).types,
    ['string.uriCustomScheme']
  );
  check(
    'https is accepted',
    run(orgSchemas.create, { name: 'Alpha', code: 'ALPHA', website: 'https://alpha.example' }).ok,
    true
  );

  check(
    'a blank email is treated as absent, not as a validation error — the column is nullable',
    run(orgSchemas.create, { name: 'Alpha', code: 'ALPHA', email: '' }).value.email,
    undefined
  );
  check(
    'an address with no public TLD validates — the shared rule from auth.validation.js',
    run(orgSchemas.create, { name: 'Alpha', code: 'ALPHA', email: 'Ops@MSMS.Local' }).value.email,
    'ops@msms.local'
  );

  check(
    'an unknown status is refused',
    run(orgSchemas.create, { name: 'Alpha', code: 'ALPHA', status: 'dormant' }).types,
    ['any.only']
  );
  check(
    'logo_path is never accepted from a body — uploads have their own route',
    run(orgSchemas.create, { name: 'Alpha', code: 'ALPHA', logo_path: '../../etc/passwd' }).value
      .logo_path,
    undefined
  );

  const empty = run(orgSchemas.update, {});
  check('an empty PATCH is refused rather than absorbed as a no-op', empty.types, ['object.min']);
  check('with an actionable message', empty.messages[0], 'Provide at least one field to update');
  check('one field is enough', run(orgSchemas.update, { notes: 'x' }).ok, true);
  check(
    'status is editable on an organization — there is deliberately no organization DELETE',
    run(orgSchemas.update, { status: ORGANIZATION_STATUS.SUSPENDED }).ok,
    true
  );

  check(
    'the list filter accepts status and strips anything else',
    run(orgSchemas.list, { status: 'active', rogue: 1 }).value.rogue,
    undefined
  );
  check(
    'and refuses an unknown status rather than ignoring it',
    run(orgSchemas.list, { status: 'dormant' }).types,
    ['any.only']
  );
}

function verifySchoolSchemas() {
  console.log('\n--- validation: schools ---');

  check(
    'organization_id is required on create — a school cannot exist outside one',
    run(schoolSchemas.create, { name: 'Alpha High', code: 'AH' }).fields,
    ['organization_id']
  );
  const created = run(schoolSchemas.create, {
    organization_id: '7',
    name: 'Alpha High',
    code: 'ah-1',
    status: SCHOOL_STATUS.SUSPENDED,
  });
  check('organization_id is converted from a string', created.value.organization_id, 7);
  check('code is upper-cased, exactly as on an organization', created.value.code, 'AH-1');
  check('an initial status may be submitted on create', created.value.status, SCHOOL_STATUS.SUSPENDED);

  check(
    'principal_id is never accepted from a body — FR-SADMIN-007 owns that column',
    run(schoolSchemas.create, {
      organization_id: 7,
      name: 'Alpha High',
      code: 'AH',
      principal_id: 3,
    }).value.principal_id,
    undefined
  );
  for (const column of ['suspended_at', 'suspension_reason', 'archived_at', 'subscription_state']) {
    check(
      `${column} is stripped on create — it is derived, never submitted`,
      run(schoolSchemas.create, {
        organization_id: 7,
        name: 'Alpha High',
        code: 'AH',
        [column]: 'anything',
      }).value[column],
      undefined
    );
  }

  /*
   * The assertion this whole schema exists for. `status` is not in `update`, so `stripUnknown` removes
   * it and the object is left empty — which `.min(1)` then refuses. Without both halves, PATCH
   * /schools/:id would be a second, unpermissioned route to FR-SADMIN-005's transitions: it carries
   * `schools.manage`, not `schools.status`.
   */
  const statusOnly = run(schoolSchemas.update, { status: SCHOOL_STATUS.SUSPENDED });
  check('a status-only PATCH strips to nothing', statusOnly.value, {});
  check('and is therefore refused', statusOnly.types, ['object.min']);
  check(
    'organization_id cannot be edited either — moving a school between tenants is not a §9.2 operation',
    run(schoolSchemas.update, { name: 'Alpha High', organization_id: 9 }).value,
    { name: 'Alpha High' }
  );

  check(
    'suspend takes an optional reason, trimmed',
    run(schoolSchemas.suspend, { reason: '  unpaid invoice  ' }).value.reason,
    'unpaid invoice'
  );
  check('suspend with no reason is valid — the column is nullable', run(schoolSchemas.suspend, {}).ok, true);
  check('archive takes the same optional reason', run(schoolSchemas.archive, { reason: 'closed' }).ok, true);
  check(
    'activate takes nothing, and a stray body is stripped rather than silently ignored',
    run(schoolSchemas.activate, { reason: 'x', status: 'active' }).value,
    {}
  );

  check('assigning a Principal requires a user_id', run(schoolSchemas.assignPrincipal, {}).fields, ['user_id']);
  check(
    'which is converted from a string',
    run(schoolSchemas.assignPrincipal, { user_id: '12' }).value.user_id,
    12
  );
  check(
    'and nothing else is accepted alongside it',
    run(schoolSchemas.assignPrincipal, { user_id: 12, role_id: 4 }).value.role_id,
    undefined
  );

  check(
    'the list filter accepts status and organization_id',
    run(schoolSchemas.list, { status: 'active', organization_id: '3' }).value.organization_id,
    3
  );
}

function verifyPrincipalSchemas() {
  console.log('\n--- validation: principals ---');

  const full = run(principalSchemas.create, {
    name: '  Ada Lovelace  ',
    email: 'Ada@MSMS.Local',
    phone: '  +1 555 0111  ',
    username: '  Ada.Lovelace  ',
    password: 'Str0ng@Pass1',
    school_id: '4',
    status: USER_STATUS.ACTIVE,
    organization_id: 9,
    role_id: 2,
    must_change_password: false,
  });
  check(
    'FR-SADMIN-009’s seven fields, and only those',
    Object.keys(full.value).sort(),
    ['email', 'name', 'password', 'phone', 'school_id', 'status', 'username']
  );
  check('organization_id is stripped — it is derived from the school', full.value.organization_id, undefined);
  check('role_id is stripped — the role is always Principal', full.value.role_id, undefined);
  check('must_change_password is stripped — the service always sets it', full.value.must_change_password, undefined);
  check('the username is lowercased, so findByIdentifier can match it', full.value.username, 'ada.lovelace');
  check('the email is lowercased too', full.value.email, 'ada@msms.local');
  check('name and phone are trimmed', [full.value.name, full.value.phone], ['Ada Lovelace', '+1 555 0111']);

  const required = run(principalSchemas.create, {});
  check(
    'name, email, username, password and school_id are all required',
    required.fields.sort(),
    ['email', 'name', 'password', 'school_id', 'username']
  );
  check('but phone and status are not', required.fields.includes('phone') || required.fields.includes('status'), false);

  const badUsername = run(principalSchemas.create, {
    name: 'Ada',
    email: 'ada@msms.local',
    username: 'Ada Lovelace',
    password: 'Str0ng@Pass1',
    school_id: 4,
  });
  check('a username with a space is refused', badUsername.types, ['string.pattern.base']);
  check(
    'and the message says what is allowed',
    badUsername.messages[0],
    '"username" must start with a letter or digit and may contain only letters, digits, dots, hyphens and underscores'
  );

  const short = run(principalSchemas.create, {
    name: 'Ada',
    email: 'ada@msms.local',
    username: 'ada',
    password: 'a'.repeat(config.security.passwordMinLength - 1),
    school_id: 4,
  });
  check('a short password is refused by the shared newPassword rule', short.types, ['string.min']);
  check(
    'with the floor named',
    short.messages[0],
    `Password must be at least ${config.security.passwordMinLength} characters long.`
  );

  check(
    'the list filter accepts school_id — FR-SADMIN-007’s assignment screen queries by it',
    run(principalSchemas.list, { school_id: '4' }).value.school_id,
    4
  );
}

/* ═══════════════════════════ part 2 — the route tables ═══════════════════════════ */

/** The handler chain declared for one route, or null when the route does not exist. */
function stackOf(router, method, path) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  return layer ? layer.route.stack.map((s) => s.handle) : null;
}

/** Routes declared by a router, in declaration order. */
function routesOf(router) {
  return router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
}

/** Is a named guard on this route? Only works for guards that are not asyncHandler-wrapped. */
function named(router, method, path, fnName) {
  const stack = stackOf(router, method, path);
  return stack ? stack.some((fn) => fn.name === fnName) : null;
}

function verifyRouting() {
  console.log('\n--- routing: the declared surface ---');

  check('§9.1 declares one endpoint', routesOf(platformRoutes), ['GET /dashboard']);
  check('§5 organizations declares four', routesOf(organizationRoutes), [
    'GET /',
    'POST /',
    'GET /:id',
    'PATCH /:id',
  ]);
  check('§9.2 declares the ten routes the nine operations need', routesOf(schoolRoutes), [
    'GET /',
    'POST /',
    'GET /:id',
    'PATCH /:id',
    'POST /:id/activate',
    'POST /:id/suspend',
    'POST /:id/archive',
    'DELETE /:id',
    'PUT /:id/principal',
    'GET /:id/usage',
  ]);
  check('§9.3 declares three — no PATCH and no DELETE, which belong to the §33 Users module', routesOf(principalRoutes), [
    'GET /',
    'POST /',
    'GET /:id',
  ]);

  console.log('\n--- routing: every write validates ---');

  const writes = [
    [organizationRoutes, 'post', '/'],
    [organizationRoutes, 'patch', '/:id'],
    [schoolRoutes, 'post', '/'],
    [schoolRoutes, 'patch', '/:id'],
    [schoolRoutes, 'post', '/:id/activate'],
    [schoolRoutes, 'post', '/:id/suspend'],
    [schoolRoutes, 'post', '/:id/archive'],
    [schoolRoutes, 'delete', '/:id'],
    [schoolRoutes, 'put', '/:id/principal'],
    [principalRoutes, 'post', '/'],
  ];

  for (const [router, method, path] of writes) {
    check(
      `${method.toUpperCase()} ${path} validates its input`,
      named(router, method, path, 'validateRequest'),
      true
    );
    check(
      `${method.toUpperCase()} ${path} declares an activity row`,
      named(router, method, path, 'activityDeclaration'),
      true
    );
    check(
      `${method.toUpperCase()} ${path} is restricted to the platform scope — every §9.2 operation is actored Super Admin`,
      named(router, method, path, 'platformGuard'),
      true
    );
  }

  console.log('\n--- routing: reads are neither logged nor platform-only ---');

  const reads = [
    [platformRoutes, 'get', '/dashboard'],
    [organizationRoutes, 'get', '/'],
    [organizationRoutes, 'get', '/:id'],
    [schoolRoutes, 'get', '/'],
    [schoolRoutes, 'get', '/:id'],
    [schoolRoutes, 'get', '/:id/usage'],
    [principalRoutes, 'get', '/'],
    [principalRoutes, 'get', '/:id'],
  ];

  for (const [router, method, path] of reads) {
    check(
      `GET ${path} writes no activity row — a dashboard and a list are polled`,
      named(router, method, path, 'activityDeclaration'),
      false
    );
    check(
      `GET ${path} carries no platform guard — DEFAULT_ROLE_PERMISSIONS grants organization_admin the read keys`,
      named(router, method, path, 'platformGuard'),
      false
    );
  }

  check(
    'the dashboard has no validation layer — it takes no body, no param and no query',
    named(platformRoutes, 'get', '/dashboard', 'validateRequest'),
    false
  );
  check(
    'but every other read validates its :id or its filters',
    reads.slice(1).every(([r, m, p]) => named(r, m, p, 'validateRequest')),
    true
  );
}

/* ═══════════════════════════ fixtures ═══════════════════════════ */

const fixtures = {};
const created = { organizations: [], schools: [], principals: [] };
const baseline = { activityLog: 0, auditLog: 0 };

async function captureBaseline() {
  baseline.activityLog = (await db.ActivityLog.max('id')) || 0;
  baseline.auditLog = (await db.AuditLog.max('id')) || 0;
  return true;
}

async function createFixtures() {
  const roles = {};
  for (const slug of [ROLES.SUPER_ADMIN, ROLES.ORGANIZATION_ADMIN, ROLES.PRINCIPAL]) {
    roles[slug] = await db.Role.findOne({ where: { slug } });
    if (!roles[slug]) throw new Error(`The ${slug} role is missing — run the seeders first.`);
  }
  fixtures.roles = roles;

  const password_hash = await hashPassword(PASSWORD);

  fixtures.platform = await db.User.create({
    role_id: roles[ROLES.SUPER_ADMIN].id,
    name: 'Verify Platform Admin',
    email: `platform@${DOMAIN}`,
    username: 'vpm_platform',
    password_hash,
    status: USER_STATUS.ACTIVE,
    must_change_password: false,
  });

  /*
   * Platform-scoped, so `platformGuard` passes and the permission guard is the layer that answers.
   * `getEffectivePermissions` = role grants + extra − denied, so denying every key the
   * routes require turns each route's own 403 into a statement of which key it wanted.
   */
  fixtures.denied = await db.User.create({
    role_id: roles[ROLES.SUPER_ADMIN].id,
    name: 'Verify Denied Admin',
    email: `denied@${DOMAIN}`,
    username: 'vpm_denied',
    password_hash,
    status: USER_STATUS.ACTIVE,
    must_change_password: false,
    denied_permissions: [...ROUTE_KEYS],
  });

  return 2;
}

/** Created after the organizations exist, because its scope is one of them. */
async function createOrgAdmin(organizationId) {
  fixtures.orgadmin = await db.User.create({
    role_id: fixtures.roles[ROLES.ORGANIZATION_ADMIN].id,
    organization_id: organizationId,
    name: 'Verify Org Admin',
    email: `orgadmin@${DOMAIN}`,
    username: 'vpm_orgadmin',
    password_hash: await hashPassword(PASSWORD),
    status: USER_STATUS.ACTIVE,
    must_change_password: false,
  });
  return fixtures.orgadmin.id;
}

async function removeFixtures() {
  /* The rows the run generated, before the records they point at. */
  /*
   * Scoped to this run's own tenant — Known Issues #25. An unbounded delete above `baseline` also
   * removes rows belonging to any suite running concurrently, which is the mechanism behind
   * "a parallel run reports false failures": the victim then reads `[]`, not a partial set.
   *
   * Both tables are ON DELETE CASCADE from `schools` and `organizations`, so this run's rows would
   * be removed anyway when its schools and organization go. This stays explicit as belt-and-braces
   * and to keep the ordering obvious; what matters is that it can no longer reach another run.
   *
   * Rows with neither a school nor an organization — the seeded Super Admin's sign-ins — are left.
   * Every suite authenticates as that same user, so no run can claim them, and they sit below the
   * next run's baseline where no assertion can see them.
   */
  const ownTenant = [
      /* This run's own requests — what the tenant clauses below cannot reach. */
      { request_id: { [db.Op.like]: `${REQUEST_TAG}-%` } },
    ...(Array.isArray(created.schools) && created.schools.length ? [{ school_id: created.schools }] : []),
    ...(Array.isArray(created.organizations) && created.organizations.length
      ? [{ organization_id: created.organizations }] : []),
    /*
     * The run's own users, which catches its PLATFORM-scope rows — sign-ins and super-admin
     * actions have no school and no organization, so the two clauses above never match them and
     * the cascade from `schools`/`organizations` never reaches them either. This clause only works
     * because it runs BEFORE `User.destroy` below: both trail tables are ON DELETE SET NULL from
     * `users`, so afterwards there is no `user_id` left to match.
     */
    ...(Array.isArray(created.users) && created.users.length ? [{ user_id: created.users }] : []),
  ];
  if (ownTenant.length) {
    await db.ActivityLog.destroy({
      where: { id: { [db.Op.gt]: baseline.activityLog }, [db.Op.or]: ownTenant },
    });
    await db.AuditLog.destroy({
      where: { id: { [db.Op.gt]: baseline.auditLog }, [db.Op.or]: ownTenant },
    });
  }

  /*
   * Users first. `schools.principal_id` is ON DELETE SET NULL, so this cannot fail on a foreign key,
   * and removing them before the schools avoids relying on the cascade to do it.
   */
  const userIds = [
    ...['platform', 'denied', 'orgadmin'].map((key) => fixtures[key] && fixtures[key].id),
    ...created.principals,
  ].filter(Boolean);
  if (userIds.length) await db.User.destroy({ where: { id: userIds }, force: true });

  /* `force` on both: the tables are paranoid, and one school was deliberately soft-deleted. */
  if (created.schools.length) {
    await db.School.destroy({ where: { id: created.schools }, force: true });
  }
  if (created.organizations.length) {
    await db.Organization.destroy({ where: { id: created.organizations }, force: true });
  }
}

/* ═══════════════════════════ part 3 — over HTTP ═══════════════════════════ */

async function verifyHttp() {
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  /*
   * Every request is tagged so this run's trail rows can be told from another run's — the last half
   * of Known Issues #25, which recorded a run id as impossible for want of somewhere to put one.
   * `requestContext.js:24` honours an inbound `X-Request-Id` matching /^[A-Za-z0-9._~-]{8,64}$/ and
   * stores it on both trail tables. The counter is zero-padded to four digits because of that lower
   * bound: a shorter tag is silently replaced with a nanoid, and the tagging would appear to work
   * while tagging nothing.
   */
  async function call(path, { method = 'GET', body, token } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Request-Id': `${REQUEST_TAG}-${String(++requestSeq).padStart(4, '0')}`,
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* left null — an assertion on `body` names the problem more clearly than a throw here */
    }

    return { status: res.status, body: parsed, raw: text };
  }

  async function signIn(identifier, password = PASSWORD) {
    const res = await call('/auth/login', { method: 'POST', body: { identifier, password } });
    return res.body && res.body.data ? res.body.data.accessToken : null;
  }

  /** The error code an envelope carries, or the status when it is not an error envelope. */
  const codeOf = (res) => (res.body && res.body.error ? res.body.error.code : `no-error:${res.status}`);
  const dataOf = (res) => (res.body && res.body.data !== undefined ? res.body.data : null);

  try {
    /* ─────────────────────── nothing is reachable unauthenticated ─────────────────────── */

    console.log('\n--- the boundary: all four mounts are below it ---');

    for (const path of [
      '/platform/dashboard',
      '/organizations',
      '/schools',
      '/principals',
    ]) {
      const res = await call(path);
      check(`${path} is 401 without a token`, res.status, 401);
    }

    const tokens = {
      platform: await signIn(`platform@${DOMAIN}`),
      denied: await signIn(`denied@${DOMAIN}`),
    };
    check('the platform fixture signs in', Boolean(tokens.platform), true);
    check('the denied fixture signs in — it holds a role, just not the keys', Boolean(tokens.denied), true);

    /* ─────────────────────────────── organizations ─────────────────────────────── */

    console.log('\n--- organizations: create, collide, read, edit ---');

    const orgA = await call('/organizations', {
      method: 'POST',
      token: tokens.platform,
      body: {
        name: 'Verify Alpha Group',
        code: 'vpm-alpha',
        email: `ops@${DOMAIN}`,
        phone: '+1 555 0100',
        address: '1 Alpha Way',
        website: `https://alpha.${DOMAIN}`,
        notes: 'created by verify-platform-modules.js',
      },
    });
    check('POST /organizations is 201', orgA.status, 201);
    check('the code was upper-cased on the way in', dataOf(orgA).organization.code, 'VPM-ALPHA');
    check('and the status defaulted to active', dataOf(orgA).organization.status, ORGANIZATION_STATUS.ACTIVE);
    check('the message names the action', orgA.body.message, 'Organization created');
    if (dataOf(orgA)) created.organizations.push(dataOf(orgA).organization.id);

    const duplicate = await call('/organizations', {
      method: 'POST',
      token: tokens.platform,
      body: { name: 'Verify Alpha Again', code: 'VPM-ALPHA' },
    });
    check('a duplicate code is a 409, not a 500', duplicate.status, 409);
    check('and names itself', codeOf(duplicate), 'ORGANIZATION_CODE_TAKEN');
    check('quoting the offending value', duplicate.body.error.details, { code: 'VPM-ALPHA' });

    const lowercased = await call('/organizations', {
      method: 'POST',
      token: tokens.platform,
      body: { name: 'Verify Alpha Lower', code: 'vpm-alpha' },
    });
    check(
      'a lower-cased duplicate collides too — which is why the schema upper-cases',
      [lowercased.status, codeOf(lowercased)],
      [409, 'ORGANIZATION_CODE_TAKEN']
    );

    const orgB = await call('/organizations', {
      method: 'POST',
      token: tokens.platform,
      body: { name: 'Verify Beta Group', code: 'VPM-BETA' },
    });
    check('a second organization is created', orgB.status, 201);
    if (dataOf(orgB)) created.organizations.push(dataOf(orgB).organization.id);

    const orgAId = dataOf(orgA).organization.id;
    const orgBId = dataOf(orgB).organization.id;

    const orgList = await call('/organizations?limit=100', { token: tokens.platform });
    check('GET /organizations is 200', orgList.status, 200);
    check('the rows are the payload, not a nested object', Array.isArray(dataOf(orgList)), true);
    check(
      'both new organizations are in it',
      [orgAId, orgBId].every((id) => dataOf(orgList).some((row) => row.id === id)),
      true
    );
    check('with pagination metadata', Object.keys(orgList.body.meta.pagination).sort(), [
      'hasNextPage',
      'hasPreviousPage',
      'limit',
      'page',
      'total',
      'totalPages',
    ]);

    /*
     * §25's pagination and §24's "no user-supplied string reaches an ORDER BY", over a real endpoint.
     *
     * `getPagination`, `getSort` and `paginateQuery` back all three §9 list routes, and nothing
     * asserted their behaviour past the shape of the envelope above. The sort is pinned to `code`
     * rather than left on the default `created_at DESC`: both organizations are created inside the
     * same second and the column has no sub-second precision, so a default-ordered assertion would
     * be a coin flip rather than a check.
     */
    const paged = '/organizations?limit=1&sortBy=code&sortOrder=asc';
    const page1 = await call(`${paged}&page=1`, { token: tokens.platform });
    const page2 = await call(`${paged}&page=2`, { token: tokens.platform });
    check('?limit=1 returns one row', dataOf(page1).length, 1);
    check('while the total counts every match, not just the page', page1.body.meta.pagination.total, 2);
    check('over two pages of one', page1.body.meta.pagination.totalPages, 2);
    check(
      'page 1 offers a next and no previous',
      [page1.body.meta.pagination.hasNextPage, page1.body.meta.pagination.hasPreviousPage],
      [true, false]
    );
    check(
      'page 2 the reverse',
      [page2.body.meta.pagination.hasNextPage, page2.body.meta.pagination.hasPreviousPage],
      [false, true]
    );
    check(
      'and page 2 is a different row, so the offset is applied rather than the page echoed',
      dataOf(page1)[0].id !== dataOf(page2)[0].id,
      true
    );
    check('ascending by code puts ALPHA first', dataOf(page1)[0].code, 'VPM-ALPHA');
    check(
      'and descending flips it, so sortOrder reaches the query',
      dataOf(await call('/organizations?limit=1&sortBy=code&sortOrder=desc', { token: tokens.platform }))[0].code,
      'VPM-BETA'
    );

    const beyond = await call('/organizations?page=99&limit=1', { token: tokens.platform });
    check(
      'a page past the end is an empty list, not a 404 — there is no such thing as a missing page',
      [beyond.status, dataOf(beyond).length],
      [200, 0]
    );

    /*
     * `password_hash` is not a column on `organizations` at all, so if the allow-list in `getSort`
     * were bypassed this would reach ORDER BY and Sequelize would answer 500. A 200 is the proof
     * that an unlisted column is dropped and the default order stands.
     */
    const unlisted = await call('/organizations?limit=1&sortBy=password_hash', { token: tokens.platform });
    check('an unlisted sort column is ignored, not honoured', unlisted.status, 200);
    check('and not answered with a database error', codeOf(unlisted), 'no-error:200');

    const sqlShaped = await call('/organizations?sortBy=id%3B%20DROP%20TABLE%20users', {
      token: tokens.platform,
    });
    check(
      'a SQL-shaped sort column is refused on shape, before the allow-list is even consulted',
      [sqlShaped.status, codeOf(sqlShaped)],
      [422, 'VALIDATION_ERROR']
    );

    const overLimit = await call('/organizations?limit=500', { token: tokens.platform });
    check(
      'and a limit above MAX_LIMIT is refused with an explanation rather than silently clamped',
      [overLimit.status, codeOf(overLimit)],
      [422, 'VALIDATION_ERROR']
    );

    check(
      'GET /organizations/:id returns the row',
      dataOf(await call(`/organizations/${orgAId}`, { token: tokens.platform })).organization.code,
      'VPM-ALPHA'
    );

    const orgPatched = await call(`/organizations/${orgAId}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: { notes: 'edited by the verification run', phone: '+1 555 0101' },
    });
    check('PATCH /organizations/:id is 200', orgPatched.status, 200);
    check('and the change is returned', dataOf(orgPatched).organization.notes, 'edited by the verification run');

    const orgEmpty = await call(`/organizations/${orgAId}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: {},
    });
    check('an empty PATCH is 422 over HTTP too', orgEmpty.status, 422);
    check(
      'and the refusal is the .min(1) rule',
      orgEmpty.body.error.details.map((d) => d.type),
      ['object.min']
    );

    const orgMissing = await call('/organizations/99999999', { token: tokens.platform });
    check('an unknown organization is 404', [orgMissing.status, codeOf(orgMissing)], [
      404,
      'ORGANIZATION_NOT_FOUND',
    ]);

    /* ───────────────────────────── schools — §9.2 ───────────────────────────── */

    console.log('\n--- schools: FR-SADMIN-002 create ---');

    const bogusOrg = await call('/schools', {
      method: 'POST',
      token: tokens.platform,
      body: { organization_id: 99999999, name: 'Nowhere High', code: 'VPM-NOWHERE' },
    });
    check('a school in a non-existent organization is 422, not a foreign-key 500', bogusOrg.status, 422);
    check('and the field is named', bogusOrg.body.error.details, {
      organization_id: 'No organization was found with this id',
    });

    const schoolA = await call('/schools', {
      method: 'POST',
      token: tokens.platform,
      body: {
        organization_id: orgAId,
        name: 'Verify Alpha High',
        code: 'vpm-sch-1',
        email: `alpha.high@${DOMAIN}`,
        city: 'Springfield',
        country: 'Testland',
      },
    });
    check('POST /schools is 201', schoolA.status, 201);
    check('the code was upper-cased', dataOf(schoolA).school.code, 'VPM-SCH-1');
    check('the status defaulted to active', dataOf(schoolA).school.status, SCHOOL_STATUS.ACTIVE);
    check('and no Principal is assigned yet', dataOf(schoolA).school.principal_id, null);
    if (dataOf(schoolA)) created.schools.push(dataOf(schoolA).school.id);
    const schoolAId = dataOf(schoolA).school.id;

    const sameCodeSameOrg = await call('/schools', {
      method: 'POST',
      token: tokens.platform,
      body: { organization_id: orgAId, name: 'Verify Clash High', code: 'VPM-SCH-1' },
    });
    check('the same code twice in one organization is a 409', sameCodeSameOrg.status, 409);
    check('and names itself', codeOf(sameCodeSameOrg), 'SCHOOL_CODE_TAKEN');

    const schoolB = await call('/schools', {
      method: 'POST',
      token: tokens.platform,
      body: { organization_id: orgBId, name: 'Verify Beta High', code: 'VPM-SCH-1' },
    });
    check(
      'but the same code in a different organization is fine — the index is (organization_id, code)',
      schoolB.status,
      201
    );
    if (dataOf(schoolB)) created.schools.push(dataOf(schoolB).school.id);
    const schoolBId = dataOf(schoolB).school.id;

    console.log('\n--- schools: FR-SADMIN-003 edit, FR-SADMIN-004 view ---');

    const schoolPatched = await call(`/schools/${schoolAId}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: { city: 'Shelbyville', phone: '+1 555 0200' },
    });
    check('PATCH /schools/:id is 200', schoolPatched.status, 200);
    check('and the change is returned', dataOf(schoolPatched).school.city, 'Shelbyville');

    const statusPatch = await call(`/schools/${schoolAId}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: { status: SCHOOL_STATUS.SUSPENDED },
    });
    check(
      'a status-only PATCH is 422 — the generic edit cannot perform an FR-SADMIN-005 transition',
      statusPatch.status,
      422
    );
    check(
      'because the field was stripped and nothing was left',
      statusPatch.body.error.details.map((d) => d.type),
      ['object.min']
    );
    check(
      'and the row is untouched',
      (await db.School.findByPk(schoolAId)).status,
      SCHOOL_STATUS.ACTIVE
    );

    const schoolShow = await call(`/schools/${schoolAId}`, { token: tokens.platform });
    check('GET /schools/:id is 200', schoolShow.status, 200);
    check(
      'and includes the organization it belongs to',
      dataOf(schoolShow).school.organization.code,
      'VPM-ALPHA'
    );
    check('with a principal slot that is currently empty', dataOf(schoolShow).school.principal, null);

    check(
      'an unknown school is 404',
      codeOf(await call('/schools/99999999', { token: tokens.platform })),
      'SCHOOL_NOT_FOUND'
    );

    /* ─────────────────────── principals — §9.3, FR-SADMIN-009 ─────────────────────── */

    console.log('\n--- principals: FR-SADMIN-009 ---');

    async function createPrincipal(key, schoolId, extra = {}) {
      const res = await call('/principals', {
        method: 'POST',
        token: tokens.platform,
        body: {
          name: `Verify Principal ${key}`,
          email: `principal.${key}@${DOMAIN}`,
          username: `vpm_principal_${key}`,
          password: PASSWORD,
          school_id: schoolId,
          ...extra,
        },
      });
      if (res.body && res.body.data && res.body.data.principal) {
        created.principals.push(res.body.data.principal.id);
      }
      return res;
    }

    const p1 = await createPrincipal('one', schoolAId, { phone: '+1 555 0301' });
    check('POST /principals is 201', p1.status, 201);
    check(
      'must_change_password is set — a Super Admin typed this password (see authenticate.js:199)',
      dataOf(p1).principal.must_change_password,
      true
    );
    check(
      'organization_id is derived from the school, never submitted',
      dataOf(p1).principal.organization_id,
      orgAId
    );
    check('school_id is what was asked for', dataOf(p1).principal.school_id, schoolAId);
    check('the role is Principal', dataOf(p1).principal.role.slug, ROLES.PRINCIPAL);
    check('the status defaulted to active', dataOf(p1).principal.status, USER_STATUS.ACTIVE);
    check('the school is nested for the assignment screen', dataOf(p1).principal.school.id, schoolAId);
    check(
      'no secret is in the response',
      Object.keys(dataOf(p1).principal).filter((k) => /password|token|hash/.test(k)),
      ['must_change_password']
    );
    check('the verification email was issued', dataOf(p1).verificationEmailSent, true);

    const p1Id = dataOf(p1).principal.id;

    const ignoredOrg = await createPrincipal('two', schoolAId, { organization_id: orgBId });
    check('a second Principal for the same school is allowed', ignoredOrg.status, 201);
    check(
      'a submitted organization_id is ignored, not honoured — it is stripped by the schema',
      dataOf(ignoredOrg).principal.organization_id,
      orgAId
    );
    const p2Id = dataOf(ignoredOrg).principal.id;

    const p3 = await createPrincipal('three', schoolBId);
    check('a Principal for the other school is created', p3.status, 201);
    const p3Id = dataOf(p3).principal.id;

    const dupUsername = await call('/principals', {
      method: 'POST',
      token: tokens.platform,
      body: {
        name: 'Verify Clash',
        email: `clash@${DOMAIN}`,
        username: 'vpm_principal_one',
        password: PASSWORD,
        school_id: schoolAId,
      },
    });
    check('a duplicate username is a 409', dupUsername.status, 409);
    check('named as such', codeOf(dupUsername), 'USERNAME_TAKEN');

    const dupEmail = await call('/principals', {
      method: 'POST',
      token: tokens.platform,
      body: {
        name: 'Verify Clash',
        email: `principal.one@${DOMAIN}`,
        username: 'vpm_clash',
        password: PASSWORD,
        school_id: schoolAId,
      },
    });
    check('a duplicate email is a 409 too', dupEmail.status, 409);
    check('and is distinguished from the username collision', codeOf(dupEmail), 'EMAIL_TAKEN');

    const badSchool = await call('/principals', {
      method: 'POST',
      token: tokens.platform,
      body: {
        name: 'Verify Nowhere',
        email: `nowhere@${DOMAIN}`,
        username: 'vpm_nowhere',
        password: PASSWORD,
        school_id: 99999999,
      },
    });
    check('a Principal for a non-existent school is 422', badSchool.status, 422);

    const pList = await call(`/principals?school_id=${schoolAId}&limit=100`, { token: tokens.platform });
    check('GET /principals is 200', pList.status, 200);
    check(
      'the school_id filter narrows it to that school’s candidates',
      dataOf(pList).map((row) => row.id).sort((a, b) => a - b),
      [p1Id, p2Id].sort((a, b) => a - b)
    );
    check(
      'every row is a Principal — the list is scoped by role, not just by school',
      dataOf(pList).every((row) => row.role.slug === ROLES.PRINCIPAL),
      true
    );
    check(
      'GET /principals/:id returns one',
      dataOf(await call(`/principals/${p1Id}`, { token: tokens.platform })).principal.id,
      p1Id
    );

    /* ─────────────────── FR-SADMIN-007 — assign / change Principal ─────────────────── */

    console.log('\n--- schools: FR-SADMIN-007 assign and change Principal ---');

    const notAPrincipal = await call(`/schools/${schoolAId}/principal`, {
      method: 'PUT',
      token: tokens.platform,
      body: { user_id: fixtures.platform.id },
    });
    check('a user who is not a Principal is refused with 422', notAPrincipal.status, 422);
    check('and told why', notAPrincipal.body.error.details, {
      user_id: `Expected a user whose role is '${ROLES.PRINCIPAL}'`,
    });

    const wrongSchool = await call(`/schools/${schoolAId}/principal`, {
      method: 'PUT',
      token: tokens.platform,
      body: { user_id: p3Id },
    });
    check('a Principal belonging to another school is refused', wrongSchool.status, 422);
    check('with the fix named', wrongSchool.body.error.details, {
      user_id: "Change the user's school before assigning them here",
    });

    const missingUser = await call(`/schools/${schoolAId}/principal`, {
      method: 'PUT',
      token: tokens.platform,
      body: { user_id: 99999999 },
    });
    check('a non-existent user is refused', missingUser.status, 422);

    const assigned = await call(`/schools/${schoolAId}/principal`, {
      method: 'PUT',
      token: tokens.platform,
      body: { user_id: p1Id },
    });
    check('the first assignment is 200', assigned.status, 200);
    check('the column is set', dataOf(assigned).school.principal_id, p1Id);
    check('the nested principal is returned', dataOf(assigned).school.principal.id, p1Id);
    check('there was no prior holder', dataOf(assigned).previousPrincipal, null);
    check('and the message says so', assigned.body.message, 'Principal assigned');

    const reassigned = await call(`/schools/${schoolAId}/principal`, {
      method: 'PUT',
      token: tokens.platform,
      body: { user_id: p2Id },
    });
    check('a replacement is 200', reassigned.status, 200);
    check('the column moved', dataOf(reassigned).school.principal_id, p2Id);
    check(
      'and the replaced holder is named — FR-SADMIN-007’s "replacing any prior assignment" is only auditable if it is',
      dataOf(reassigned).previousPrincipal.id,
      p1Id
    );
    check('with a different message', reassigned.body.message, 'Principal changed');

    /* ─────────────────────────── FR-SADMIN-008 — usage ─────────────────────────── */

    console.log('\n--- schools: FR-SADMIN-008 usage ---');

    const usage = await call(`/schools/${schoolAId}/usage`, { token: tokens.platform });
    check('GET /schools/:id/usage is 200', usage.status, 200);
    check('it identifies the school', dataOf(usage).school.id, schoolAId);
    check(
      'a school with no subscription reports no state rather than failing',
      dataOf(usage).school.subscription_state,
      null
    );
    check('one row per tracked limit key', dataOf(usage).usage.length, USAGE_LIMIT_KEYS.length);
    check(
      'every row names its key',
      dataOf(usage).usage.every((row) => USAGE_LIMIT_KEYS.includes(row.limitKey)),
      true
    );
    check(
      'and carries the four figures an operator reads',
      ['limitKey', 'label', 'unlimited', 'allowed', 'used', 'remaining'].every(
        (key) => key in dataOf(usage).usage[0]
      ),
      true
    );
    /*
     * `admin_limit` is a headcount, and `HEADCOUNT_SOURCES` counts active users in the school whose
     * role is in `SCHOOL_ADMIN_ROLES` — which includes `principal`. Two were created above, so this
     * figure being 2 rather than 0 is the assertion worth making: the number is recomputed from
     * `users` on read, not served from the `usage_records` mirror, which nothing has written to.
     */
    const usageBy = Object.fromEntries(dataOf(usage).usage.map((row) => [row.limitKey, row]));
    check(
      'admin_limit counts the two Principals FR-SADMIN-009 created — the headcount is live, not mirrored',
      usageBy.admin_limit.used,
      2
    );
    check(
      'and every other allowance is still at zero',
      Object.values(usageBy)
        .filter((row) => row.limitKey !== 'admin_limit')
        .every((row) => row.used === 0),
      true
    );
    check(
      'a headcount limit is tracked even with no subscription — the number comes from the source table',
      HEADCOUNT_LIMITS.every((key) => usageBy[key].tracked === true),
      true
    );
    check(
      'the rest are not, because there is no billing period to accumulate against',
      USAGE_LIMIT_KEYS.filter((key) => !HEADCOUNT_LIMITS.includes(key)).every(
        (key) => usageBy[key].tracked === false
      ),
      true
    );
    check(
      'and an unsubscribed school is permitted nothing rather than treated as unlimited',
      dataOf(usage).usage.every((row) => row.unlimited === false && row.allowed === 0),
      true
    );

    /* ───────── FR-SADMIN-005 — suspend and activate, proved with a live token ───────── */

    console.log('\n--- schools: FR-SADMIN-005, end to end ---');

    /* The forced change is cleared directly: FR-AUTH-004's change-password flow is verified in
     * scripts/verify-auth-module.js, and what is under test here is the tenant refusal. */
    await db.User.update({ must_change_password: false }, { where: { id: p1Id } });
    const principalToken = await signIn(`principal.one@${DOMAIN}`);
    check('the Principal can sign in while the school is active', Boolean(principalToken), true);
    check(
      'and reach an authenticated route',
      (await call('/auth/me', { token: principalToken })).status,
      200
    );

    const suspended = await call(`/schools/${schoolAId}/suspend`, {
      method: 'POST',
      token: tokens.platform,
      body: { reason: 'unpaid invoice' },
    });
    check('POST /schools/:id/suspend is 200', suspended.status, 200);
    check('the status moved', dataOf(suspended).school.status, SCHOOL_STATUS.SUSPENDED);
    check('the reason is stored on the school', dataOf(suspended).school.suspension_reason, 'unpaid invoice');
    check('and the moment is stamped', Boolean(dataOf(suspended).school.suspended_at), true);
    check('the message names the verb', suspended.body.message, 'School suspended');

    const refused = await call('/auth/me', { token: principalToken });
    check(
      'the Principal’s existing token is now refused — proving invalidateSchool was awaited',
      [refused.status, codeOf(refused)],
      [403, 'SCHOOL_SUSPENDED']
    );
    check(
      'a fresh sign-in does not help either — the refusal is the school, not the session',
      codeOf(await call('/auth/me', { token: await signIn(`principal.one@${DOMAIN}`) })),
      'SCHOOL_SUSPENDED'
    );
    check(
      'but the Super Admin is unaffected, so FR-SADMIN-005 stays reversible',
      (await call(`/schools/${schoolAId}`, { token: tokens.platform })).status,
      200
    );

    const reactivated = await call(`/schools/${schoolAId}/activate`, {
      method: 'POST',
      token: tokens.platform,
      body: {},
    });
    check('POST /schools/:id/activate is 200', reactivated.status, 200);
    check('the status is back', dataOf(reactivated).school.status, SCHOOL_STATUS.ACTIVE);
    check(
      'and the suspension columns are cleared, not left behind',
      [dataOf(reactivated).school.suspended_at, dataOf(reactivated).school.suspension_reason],
      [null, null]
    );
    check(
      'the Principal is served again',
      (await call('/auth/me', { token: await signIn(`principal.one@${DOMAIN}`) })).status,
      200
    );

    /* ───────────────────── FR-SADMIN-006 — archive, then delete ───────────────────── */

    console.log('\n--- schools: FR-SADMIN-006 archive ---');

    const archived = await call(`/schools/${schoolAId}/archive`, {
      method: 'POST',
      token: tokens.platform,
      body: { reason: 'merged into Beta' },
    });
    check('POST /schools/:id/archive is 200', archived.status, 200);
    check('the status moved', dataOf(archived).school.status, SCHOOL_STATUS.ARCHIVED);
    check('and the moment is stamped', Boolean(dataOf(archived).school.archived_at), true);
    check(
      'the archive reason is not on the school — SRS §29 gives the table no column for it',
      'archive_reason' in dataOf(archived).school,
      false
    );

    const archiveAudit = await db.AuditLog.findOne({
      where: { table_name: 'schools', record_id: schoolAId, event: 'update' },
      order: [['id', 'DESC']],
    });
    check('it is in the audit row instead, which audit_logs.reason exists for', archiveAudit.reason, 'merged into Beta');
    check(
      'and the audit row names the columns that moved',
      archiveAudit.changed_fields.includes('status') && archiveAudit.changed_fields.includes('archived_at'),
      true
    );

    check(
      'an archived school refuses its own Principal',
      codeOf(await call('/auth/me', { token: await signIn(`principal.one@${DOMAIN}`) })),
      'SCHOOL_ARCHIVED'
    );

    await call(`/schools/${schoolAId}/activate`, { method: 'POST', token: tokens.platform, body: {} });
    check(
      'activating clears archived_at, so an archive is reversible',
      (await db.School.findByPk(schoolAId)).archived_at,
      null
    );

    console.log('\n--- schools: FR-SADMIN-006 delete ---');

    const schoolC = await call('/schools', {
      method: 'POST',
      token: tokens.platform,
      body: { organization_id: orgAId, name: 'Verify Gamma High', code: 'VPM-SCH-3' },
    });
    check('a third school is created to be deleted', schoolC.status, 201);
    if (dataOf(schoolC)) created.schools.push(dataOf(schoolC).school.id);
    const schoolCId = dataOf(schoolC).school.id;

    const deleted = await call(`/schools/${schoolCId}`, { method: 'DELETE', token: tokens.platform });
    check('DELETE /schools/:id is 200, with the identity to confirm in a toast', deleted.status, 200);
    check('and returns what was removed', dataOf(deleted).school.code, 'VPM-SCH-3');

    check(
      'the row is gone from the default scope',
      await db.School.findByPk(schoolCId),
      null
    );
    const softDeleted = await db.School.findByPk(schoolCId, { paranoid: false });
    check('but still there with paranoid: false — it is a soft delete', Boolean(softDeleted), true);
    check('with deleted_at stamped', Boolean(softDeleted.deleted_at), true);
    check(
      'and the API agrees it is gone',
      codeOf(await call(`/schools/${schoolCId}`, { token: tokens.platform })),
      'SCHOOL_NOT_FOUND'
    );
    check(
      'deleting it twice is a 404, not a second audit row',
      (await call(`/schools/${schoolCId}`, { method: 'DELETE', token: tokens.platform })).status,
      404
    );

    const deleteAudit = await db.AuditLog.findOne({
      where: { table_name: 'schools', record_id: schoolCId, event: 'delete' },
    });
    check('the deletion is audited', Boolean(deleteAudit), true);
    check('with the row as it was, and no new values', [
      Boolean(deleteAudit.old_values),
      deleteAudit.new_values,
    ], [true, null]);

    /* ───────────────────────── §9.1 — the dashboard ───────────────────────── */

    console.log('\n--- platform: FR-SADMIN-001, the eleven metrics ---');

    const dash = await call('/platform/dashboard', { token: tokens.platform });
    check('GET /platform/dashboard is 200', dash.status, 200);

    const metrics = dataOf(dash).metrics;
    check('the eleven §9.1 figures are present, in the order the source lists them', Object.keys(metrics).slice(0, 11), [
      'totalOrganizations',
      'totalSchools',
      'activeSchools',
      'suspendedSchools',
      'totalStudents',
      'totalTeachers',
      'activeSubscriptions',
      'expiredSubscriptions',
      'monthlyRevenue',
      'yearlyRevenue',
      'pendingPayments',
    ]);
    check('followed by the three derived extras', Object.keys(metrics).slice(11), [
      'archivedSchools',
      'pendingPaymentsAmount',
      'period',
      'scope',
    ]);
    check(
      'every count is a number, not a DECIMAL string from mysql2',
      Object.entries(metrics)
        .filter(([, v]) => typeof v !== 'object')
        .every(([, v]) => typeof v === 'number'),
      true
    );

    const orgCount = await db.Organization.count();
    const schoolCount = await db.School.count();
    check('totalOrganizations matches the table', metrics.totalOrganizations, orgCount);
    check('totalSchools matches the table, soft-deleted rows excluded', metrics.totalSchools, schoolCount);
    check(
      'and the three statuses add up to it — which is why archivedSchools is returned',
      metrics.activeSchools + metrics.suspendedSchools + metrics.archivedSchools,
      metrics.totalSchools
    );

    const monthly = periodRange('monthly', new Date());
    check(
      'the monthly period is the current calendar month, so the figure on screen is checkable',
      metrics.period.month.from,
      monthly.from.toISOString()
    );
    check('and the yearly period the current calendar year', metrics.period.year.from, periodRange('yearly', new Date()).from.toISOString());
    check('the scope is reported', metrics.scope, {
      level: 'platform',
      organizationId: null,
      schoolId: null,
    });
    check('with no payments in this database, revenue is zero rather than null', [
      metrics.monthlyRevenue,
      metrics.yearlyRevenue,
      metrics.pendingPaymentsAmount,
    ], [0, 0, 0]);

    /* ─────────────────────────── tenant isolation ─────────────────────────── */

    console.log('\n--- tenant isolation: an Organization Admin sees one organization ---');

    await createOrgAdmin(orgAId);
    const orgAdminToken = await signIn(`orgadmin@${DOMAIN}`);
    check('the org admin signs in', Boolean(orgAdminToken), true);

    const ownOrgs = await call('/organizations?limit=100', { token: orgAdminToken });
    check('GET /organizations returns exactly one row', dataOf(ownOrgs).length, 1);
    check('and it is their own', dataOf(ownOrgs)[0].id, orgAId);

    check(
      'their own organization is readable',
      (await call(`/organizations/${orgAId}`, { token: orgAdminToken })).status,
      200
    );
    const crossOrg = await call(`/organizations/${orgBId}`, { token: orgAdminToken });
    check('another organization is refused by layer 3, before the module runs', [
      crossOrg.status,
      codeOf(crossOrg),
    ], [403, 'CROSS_TENANT_ACCESS_DENIED']);

    const ownSchools = await call('/schools?limit=100', { token: orgAdminToken });
    check(
      'GET /schools is narrowed to their organization',
      dataOf(ownSchools).every((row) => row.organization_id === orgAId),
      true
    );
    check(
      'so the other organization’s school is not in the list',
      dataOf(ownSchools).some((row) => row.id === schoolBId),
      false
    );
    const crossSchool = await call(`/schools/${schoolBId}`, { token: orgAdminToken });
    check('and naming it directly is refused', [crossSchool.status, codeOf(crossSchool)], [
      403,
      'CROSS_TENANT_ACCESS_DENIED',
    ]);

    const ownDash = await call('/platform/dashboard', { token: orgAdminToken });
    check('the dashboard is served — organization_admin holds platform.dashboard.view', ownDash.status, 200);
    check('but counts only their organization', dataOf(ownDash).metrics.totalOrganizations, 1);
    check(
      'and only their schools',
      dataOf(ownDash).metrics.totalSchools,
      await db.School.count({ where: { organization_id: orgAId } })
    );
    check('with the scope reported honestly', dataOf(ownDash).metrics.scope, {
      level: 'organization',
      organizationId: orgAId,
      schoolId: null,
    });

    console.log('\n--- guard order: the scope guard runs before the permission guard ---');

    const scopeRefusals = [
      ['POST', '/schools', { organization_id: orgAId, name: 'X High', code: 'VPM-X' }],
      ['PATCH', `/schools/${schoolAId}`, { city: 'Nowhere' }],
      ['POST', `/schools/${schoolAId}/suspend`, {}],
      ['POST', `/schools/${schoolAId}/archive`, {}],
      ['DELETE', `/schools/${schoolAId}`, undefined],
      ['PUT', `/schools/${schoolAId}/principal`, { user_id: p2Id }],
      ['POST', '/organizations', { name: 'X Group', code: 'VPM-XG' }],
      ['POST', '/principals', {
        name: 'X',
        email: `x@${DOMAIN}`,
        username: 'vpm_x',
        password: PASSWORD,
        school_id: schoolAId,
      }],
    ];

    for (const [method, path, body] of scopeRefusals) {
      const res = await call(path, { method, token: orgAdminToken, body });
      check(
        `${method} ${path} refuses a non-platform caller with PLATFORM_SCOPE_REQUIRED, not INSUFFICIENT_PERMISSION`,
        [res.status, codeOf(res)],
        [403, 'PLATFORM_SCOPE_REQUIRED']
      );
    }

    check(
      'the school the org admin tried to edit is untouched',
      (await db.School.findByPk(schoolAId)).city,
      'Shelbyville'
    );

    /* ───────────────── every route’s permission key, from its own 403 ───────────────── */

    console.log('\n--- permissions: each route names the key it requires ---');

    const keyMap = [
      ['GET', '/platform/dashboard', undefined, 'platform.dashboard.view'],
      ['GET', '/organizations', undefined, 'organizations.view'],
      ['GET', `/organizations/${orgAId}`, undefined, 'organizations.view'],
      ['POST', '/organizations', {}, 'organizations.manage'],
      ['PATCH', `/organizations/${orgAId}`, {}, 'organizations.manage'],
      ['GET', '/schools', undefined, 'schools.view'],
      ['GET', `/schools/${schoolAId}`, undefined, 'schools.view'],
      ['POST', '/schools', {}, 'schools.manage'],
      ['PATCH', `/schools/${schoolAId}`, {}, 'schools.manage'],
      ['POST', `/schools/${schoolAId}/activate`, {}, 'schools.status'],
      ['POST', `/schools/${schoolAId}/suspend`, {}, 'schools.status'],
      ['POST', `/schools/${schoolAId}/archive`, {}, 'schools.archive'],
      ['DELETE', `/schools/${schoolAId}`, undefined, 'schools.archive'],
      ['PUT', `/schools/${schoolAId}/principal`, {}, 'schools.assign_principal'],
      ['GET', `/schools/${schoolAId}/usage`, undefined, 'schools.usage.view'],
      ['GET', '/principals', undefined, 'users.view'],
      ['GET', `/principals/${p1Id}`, undefined, 'users.view'],
      ['POST', '/principals', {}, 'users.manage'],
    ];

    for (const [method, path, body, key] of keyMap) {
      const res = await call(path, { method, token: tokens.denied, body });
      check(`${method} ${path} requires ${key}`, [res.status, codeOf(res), res.body.error.details], [
        403,
        'INSUFFICIENT_PERMISSION',
        { required: [key], missing: [key] },
      ]);
    }

    check(
      'the guard runs before validation — an empty body never reached a schema',
      (await db.School.findByPk(schoolAId)).status,
      SCHOOL_STATUS.ACTIVE
    );

    /* ─────────────────────────── the trail that was left ─────────────────────────── */

    console.log('\n--- the logs: what the run recorded ---');

    /* `activityAudit` writes on res.on('finish'), which is after fetch resolves. */
    await sleep(300);

    const activity = await db.ActivityLog.findAll({
      where: { id: { [db.Op.gt]: baseline.activityLog } },
      order: [['id', 'ASC']],
    });

    const createdSchoolRow = activity.find(
      (row) => row.action === 'create' && row.entity_type === 'school' && Number(row.entity_id) === schoolAId
    );
    check('creating a school wrote a create row', Boolean(createdSchoolRow), true);
    check('naming the school in a sentence a person can read', createdSchoolRow.description, 'Created school Verify Alpha High (VPM-SCH-1)');
    check('with the code and organization in metadata', createdSchoolRow.metadata.code, 'VPM-SCH-1');

    const updateRow = activity.find(
      (row) =>
        row.action === 'update' &&
        row.entity_type === 'school' &&
        row.metadata &&
        row.metadata.to === SCHOOL_STATUS.SUSPENDED
    );
    check('suspending wrote an update row', Boolean(updateRow), true);
    check('recording both ends of the transition', [updateRow.metadata.from, updateRow.metadata.to], [
      SCHOOL_STATUS.ACTIVE,
      SCHOOL_STATUS.SUSPENDED,
    ]);
    check('and the reason', updateRow.metadata.reason, 'unpaid invoice');

    const deleteRow = activity.find(
      (row) => row.action === 'delete' && row.entity_type === 'school' && Number(row.entity_id) === schoolCId
    );
    check('deleting wrote a delete row', Boolean(deleteRow), true);

    const principalRow = activity.find(
      (row) => row.action === 'create' && row.entity_type === 'user' && Number(row.entity_id) === p1Id
    );
    check('creating a Principal wrote a create row against user, not school', Boolean(principalRow), true);
    check(
      'and its metadata is exactly the three declared fields plus the latency the writer stamps on every row',
      Object.keys(principalRow.metadata).sort(),
      ['durationMs', 'schoolId', 'status', 'verificationEmailSent']
    );
    check(
      'so no password, token or hash reached the log — the row is built from a declaration, not from req.body',
      Object.keys(principalRow.metadata).filter((k) => /password|token|hash|secret/i.test(k)),
      []
    );

    const deniedRows = activity.filter((row) => row.action === 'access_denied');
    check('every cross-tenant refusal left an access_denied row', deniedRows.length >= 2, true);
    check(
      'attributed to the org admin who made the attempt',
      deniedRows.every((row) => Number(row.user_id) === fixtures.orgadmin.id),
      true
    );

    check(
      'no read wrote a row — the four GET-only paths appear nowhere as an action',
      activity.some((row) => row.action === 'view'),
      false
    );

    const audits = await db.AuditLog.findAll({
      where: { id: { [db.Op.gt]: baseline.auditLog } },
      order: [['id', 'ASC']],
    });
    check(
      'the audit trail covers all three tables the run wrote to',
      [...new Set(audits.map((row) => row.table_name))].sort(),
      ['organizations', 'schools', 'users']
    );
    check(
      'a Principal’s audit row carries no password hash',
      audits
        .filter((row) => row.table_name === 'users')
        .every((row) => !row.new_values || !('password_hash' in row.new_values)),
      true
    );
    check(
      'the assignment recorded why',
      audits.some((row) => row.table_name === 'schools' && row.reason === 'Principal assigned'),
      true
    );
    check(
      'and the change recorded who was replaced',
      audits.some((row) => row.table_name === 'schools' && /^Principal changed from user \d+$/.test(row.reason || '')),
      true
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ═══════════════════════════ the run ═══════════════════════════ */

async function main() {
  verifyOrganizationSchemas();
  verifySchoolSchemas();
  verifyPrincipalSchemas();
  verifyRouting();

  console.log('\n--- fixtures ---');
  check('the log tables are baselined before anything is written', await captureBaseline(), true);
  check('two platform users created', await createFixtures(), 2);

  await verifyHttp();
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nVerification aborted:', err);
  })
  .finally(async () => {
    try {
      await removeFixtures();
      console.log('\nFixtures removed.');
    } catch (err) {
      failures += 1;
      console.error('Fixture cleanup failed:', err.message);
    }
    console.log(
      failures === 0 ? '\nAll §9 platform-module checks passed.' : `\n${failures} check(s) FAILED.`
    );
    await db.sequelize.close();
    process.exit(failures === 0 ? 0 : 1);
  });
