'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *
 *   RATE_LIMIT_MAX       raised past what this script sends. `apiLimiter` is mounted globally and this
 *   AUTH_RATE_LIMIT_MAX  run makes several hundred calls; the limiter's own behaviour is verified in
 *                        scripts/verify-middlewares.js and is not what is under test here.
 *   BCRYPT_ROUNDS=10     five fixture hashes. 10 keeps the run short; the shipped default is 12.
 *   PASSWORD_MIN_LENGTH  pinned so nothing here depends on the local .env.
 *   MAIL_DRIVER=log      PATCH /users/:id re-issues FR-AUTH-006 verification when the address changes.
 *                        Pinned so nothing escapes to a real SMTP server and `verificationEmailSent`
 *                        is deterministic.
 *   CACHE_TTL=600        the point of the invalidation assertions is that a revocation bites *before*
 *                        the TTL expires. A short TTL would let them pass for the wrong reason.
 */
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.BCRYPT_ROUNDS = '10';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';
process.env.CACHE_TTL = '600';

/**
 * Verification of the accounts-and-access module group.
 *
 *   src/modules/users/*   SRS §33 "Users", FR-AUTH-006, FR-AUTH-007, FR-AUTH-009
 *   src/modules/roles/*   SRS §29 (`roles` / `permissions` / `role_permissions`), FR-AUTH-008/009
 *
 * ## What is asserted, and why each part exists
 *
 *  - **Part 1 — the schemas, directly.** The decisions no HTTP response can show: that `role_id` and
 *    `password` are stripped rather than refused (so a caller cannot promote an account through the
 *    edit route), that a username is lowercased before it reaches a column every lookup lowercases,
 *    and that `permissions: []` validates — a replacement API that rejected the empty case could not
 *    revoke a role's last permission.
 *
 *  - **Part 2 — the route tables, by name.** `validateRequest`, `activityDeclaration` and
 *    `platformGuard` are plain named functions, so their presence on a route is checkable without
 *    sending a request. This is where the guard *split* is pinned: no route in the users module carries
 *    `platformGuard`, every write in the roles module does. The permission guard itself is
 *    `asyncHandler`-wrapped and anonymous, so it is asserted in part 3 from its own 403 body.
 *
 *  - **Part 3 — over real HTTP, against the real database.** Tenant isolation, the three safety
 *    refusals, the two cache-invalidation properties, and the audit trail.
 *
 *  - **Part 4 — the service, directly.** One rule HTTP cannot reach, because `enforceTenant` answers
 *    first: `users.service.list()` refusing to let `?school_id=` widen an already-pinned scope. Layer 3
 *    and layer 4 are independent by design, and a test that only exercises layer 3 would not notice
 *    layer 4 disappearing.
 *
 * ## The three assertions worth reading before changing anything
 *
 *  - **A role edit bites on the next request.** The Principal signs in, reads `GET /users`, a *different*
 *    caller strips `users.view` from the `principal` role, and the Principal's existing token is then
 *    refused. That only passes if `roles.service.setPermissions` awaited
 *    `permissionService.invalidateRole` after committing — with `CACHE_TTL=600` a missed invalidation
 *    leaves the revoked permission working for ten minutes.
 *
 *  - **A per-user override bites with no invalidation at all.** The same shape, via
 *    `PUT /users/:id/permissions`, and deliberately *without* a cache call in the service: the override
 *    columns are read off the `users` row `authenticate` has already loaded. If someone later adds
 *    caching there without an invalidation, this assertion fails.
 *
 *  - **`users.manage` is not a route to privilege escalation.** A Principal is refused when granting a
 *    permission they do not hold themselves (`PERMISSION_GRANT_EXCEEDS_OWN`) and allowed when *denying*
 *    the same key — the asymmetry is the property, since revocation cannot escalate anything.
 *
 * ## Fixtures
 *
 * Five users under `@verify-users.local` (a platform Super Admin, an Organization Admin, two Principals
 * in different organizations, and a Teacher), two organizations and two schools. Everything is
 * hard-deleted at the end along with the `activity_logs` and `audit_logs` rows the run generated.
 *
 * Two *seeded* rows are mutated and restored: the `principal` role's grant set and the `librarian`
 * role's labels. Both are captured before the run and written back in `removeFixtures()` unconditionally,
 * so an abort mid-run still leaves the roles as it found them. The restore is asserted, not assumed.
 * The seeded Super Admin account is never touched.
 *
 * `logger.warn` and `logger.error` lines during the run are expected: every cross-tenant refusal and
 * every deliberate 403 logs.
 *
 * Run: node scripts/verify-users-roles.js
 */

const db = require('../src/models');
const {
  sweepResidue,
  removeFailedSignIns,
  readJournal,
  writeJournal,
  clearJournal,
} = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const permissionService = require('../src/services/permissionService');
const usersService = require('../src/modules/users/users.service');
const { metaOf } = require('../src/utils/routeMeta');
const {
  ROLES,
  USER_STATUS,
  PAGINATION,
  LIMITS,
  LIMIT_TYPES,
  STAFF_CATEGORIES,
  SUBSCRIPTION_STATES,
} = require('../src/config/constants');
const entitlementService = require('../src/services/entitlementService');
const { DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS } = require('../src/config/permissions');

const userRoutes = require('../src/modules/users/users.routes');
const roleRoutes = require('../src/modules/roles/roles.routes');

const userSchemas = require('../src/modules/users/users.validation').schemas;
const roleSchemas = require('../src/modules/roles/roles.validation').schemas;

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-users.local';
/** The journal this suite writes its seeded-row capture to — see scripts/lib/residue.js. */
const JOURNAL = 'verify-users-roles';
const PASSWORD = 'Verify@Users123';

/**
 * A key no fixture's role grants, used for the escalation assertions.
 *
 * `SCHOOL_LEADERSHIP` holds `subscriptions.self.manage`, deliberately not `subscriptions.manage`, so a
 * Principal offering this key is asking for something above their own ceiling.
 */
const BEYOND_PRINCIPAL = 'subscriptions.manage';

/** A key the Principal *does* hold, so the grant path can be shown to work at all. */
const WITHIN_PRINCIPAL = 'students.view';

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

function verifyUserSchemas() {
  console.log('\n--- validation: users.update ---');

  const empty = run(userSchemas.update, {});
  check('an empty PATCH is refused rather than absorbed as a no-op', empty.types, ['object.min']);
  check('with an actionable message', empty.messages[0], 'Provide at least one field to update');

  const stripped = run(userSchemas.update, {
    name: '  Ann Lee  ',
    role_id: 26,
    password: 'Whatever@123',
    school_id: 9,
    organization_id: 3,
    avatar_path: '../../etc/passwd',
    must_change_password: true,
    email_verified_at: '2020-01-01',
    extra_permissions: ['roles.manage'],
  });
  check('name is trimmed', stripped.value.name, 'Ann Lee');
  check(
    'the eight columns this screen must not touch are stripped, not refused — a refusal would tell a caller which field to try next',
    Object.keys(stripped.value),
    ['name']
  );
  check(
    'role_id above all: with it, users.manage would be a one-PATCH promotion to super_admin',
    stripped.value.role_id,
    undefined
  );
  check(
    'and extra_permissions is not editable here either — it has its own route, with its own ceiling',
    stripped.value.extra_permissions,
    undefined
  );

  check(
    'username is lowercased — findByIdentifier lowercases what a caller types, so a stored capital never matches',
    run(userSchemas.update, { username: '  Ann.Lee  ' }).value.username,
    'ann.lee'
  );
  const badUsername = run(userSchemas.update, { username: '-ann' });
  check('a username may not start with punctuation', badUsername.types, ['string.pattern.base']);
  check(
    'and the message says what is allowed',
    badUsername.messages[0],
    '"username" must start with a letter or digit and may contain only letters, digits, dots, hyphens and underscores'
  );

  check(
    'an address with no public TLD validates — the shared rule from auth.validation.js',
    run(userSchemas.update, { email: 'Ops@MSMS.Local' }).value.email,
    'ops@msms.local'
  );
  check(
    'an unknown status is refused (FR-AUTH-007)',
    run(userSchemas.update, { status: 'dormant' }).types,
    ['any.only']
  );
  check(
    'null clears the phone',
    run(userSchemas.update, { phone: null }).value.phone,
    null
  );
  check(
    'but an empty string does not — `.empty("")` drops the key, and the object.min rule then refuses the now-empty body',
    run(userSchemas.update, { phone: '' }).types,
    ['object.min']
  );

  console.log('\n--- validation: users.list ---');

  check(
    'the role filter takes a §5 slug, not a role_id — an id would make the query depend on seeding order',
    run(userSchemas.list, { role: 'teacher', rogue: 1 }).value,
    { role: 'teacher', page: PAGINATION.DEFAULT_PAGE, limit: PAGINATION.DEFAULT_LIMIT }
  );
  check(
    'and refuses a slug outside the eleven rather than matching nobody',
    run(userSchemas.list, { role: 'wizard' }).types,
    ['any.only']
  );
  check(
    'limit is capped, and an over-limit request is refused rather than silently reduced',
    run(userSchemas.list, { limit: PAGINATION.MAX_LIMIT + 1 }).types,
    ['number.max']
  );

  console.log('\n--- validation: users.setPermissions ---');

  const neither = run(userSchemas.setPermissions, {});
  check('a body with neither array is refused', neither.types, ['object.min']);
  check(
    'naming both options',
    neither.messages[0],
    'Provide extra_permissions, denied_permissions, or both'
  );
  check(
    'an empty array is legal — it is how a caller clears one side',
    run(userSchemas.setPermissions, { extra_permissions: [] }).ok,
    true
  );

  const shape = run(userSchemas.setPermissions, { extra_permissions: ['Students.View'] });
  check('a key is shape-checked here, not enumerated', shape.types, ['string.pattern.base']);
  check(
    'and the label is not double-quoted — Joi renders {#label} already quoted',
    shape.messages[0],
    '"extra_permissions[0]" must be a permission key in the form module.action'
  );
  check(
    'a key with no dot is refused',
    run(userSchemas.setPermissions, { denied_permissions: ['nodot'] }).types,
    ['string.pattern.base']
  );
  check(
    'a repeated key is refused rather than silently deduplicated',
    run(userSchemas.setPermissions, { extra_permissions: ['students.view', 'students.view'] })
      .messages,
    ['The same permission key was listed twice']
  );
}

function verifyRoleSchemas() {
  console.log('\n--- validation: roles ---');

  check('an empty PATCH is refused', run(roleSchemas.update, {}).types, ['object.min']);

  const structural = run(roleSchemas.update, {
    name: 'Head Teacher',
    description: 'edited',
    slug: 'wizard',
    is_platform_role: true,
    is_school_role: false,
    is_system: false,
  });
  check(
    'only the two label columns survive — slug and the three booleans are structural facts about §5 eleven, not settings',
    Object.keys(structural.value).sort(),
    ['description', 'name']
  );

  const missing = run(roleSchemas.setPermissions, {});
  check('the grant set is required, not optional', missing.types, ['any.required']);
  check(
    'and the message says the empty array is the way to revoke everything',
    missing.messages[0],
    'Send the complete permission set for this role, including an empty array to revoke all'
  );
  check(
    'an empty array validates — a replacement API that rejected it could not revoke the last permission',
    run(roleSchemas.setPermissions, { permissions: [] }).ok,
    true
  );
  check(
    'a malformed key is refused',
    run(roleSchemas.setPermissions, { permissions: ['Students.View'] }).messages[0],
    '"permissions[0]" must be a permission key in the form module.action'
  );
  check(
    'a repeated key is refused',
    run(roleSchemas.setPermissions, { permissions: ['students.view', 'students.view'] }).types,
    ['array.unique']
  );

  check(
    'there is no create schema — SRS §5 defines exactly eleven roles and §35 names "Additional roles" first among the things not to invent',
    roleSchemas.create,
    undefined
  );
}

/* ═══════════════════════════ part 2 — the route tables ═══════════════════════════ */

/** The handler chain declared for one route, or null when the route does not exist. */
function stackOf(router, method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer ? layer.route.stack.map((s) => s.handle) : null;
}

/** The permission keys a route's guard publishes through `routeMeta` — `null` when it has no guard. */
function permissionsOf(router, method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) return null;
  for (const handler of layer.route.stack) {
    const meta = metaOf(handler.handle);
    if (meta && meta.permissions) return meta.permissions;
  }
  return null;
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

  check('the users module declares six routes', routesOf(userRoutes), [
    'GET /',
    'GET /permissions',
    'POST /',
    'GET /:id',
    'PATCH /:id',
    'PUT /:id/permissions',
  ]);
  check(
    'and /permissions is declared before /:id, so the literal path wins — reversed, it would be refused as a non-numeric id',
    routesOf(userRoutes).indexOf('GET /permissions') < routesOf(userRoutes).indexOf('GET /:id'),
    true
  );
  /*
   * This assertion used to be "no POST", on the premise that §15 creates school people's accounts. §15
   * creates their profiles; only a Parent's comes with an account, so no teacher, staff member or
   * student could sign in. The owner's decision D1 made `POST /` that path, on the permission the
   * catalogue already calls "Create / edit users".
   */
  check(
    'one POST — a school login, on users.manage (owner decision D1)',
    [routesOf(userRoutes).filter((r) => r.startsWith('POST')), permissionsOf(userRoutes, 'post', '/')],
    [['POST /'], ['users.manage']]
  );
  check(
    'no DELETE — FR-SADMIN-006 archives a *school*; nothing in the source deletes a person',
    routesOf(userRoutes).some((r) => r.startsWith('DELETE')),
    false
  );

  check('the roles module declares four', routesOf(roleRoutes), [
    'GET /',
    'GET /:id',
    'PATCH /:id',
    'PUT /:id/permissions',
  ]);
  check(
    'with neither POST nor DELETE — SRS §5 fixes the list at eleven and roles.slug validates against ROLE_LIST',
    routesOf(roleRoutes).filter((r) => r.startsWith('POST') || r.startsWith('DELETE')),
    []
  );

  console.log('\n--- routing: every write validates and is logged ---');

  const writes = [
    [userRoutes, 'patch', '/:id'],
    [userRoutes, 'put', '/:id/permissions'],
    [roleRoutes, 'patch', '/:id'],
    [roleRoutes, 'put', '/:id/permissions'],
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
  }

  console.log('\n--- routing: the guard split, which is the whole point of two modules ---');

  for (const [method, path] of [
    ['get', '/'],
    ['get', '/permissions'],
    ['get', '/:id'],
    ['patch', '/:id'],
    ['put', '/:id/permissions'],
  ]) {
    check(
      `users ${method.toUpperCase()} ${path} carries no platform guard — users.view is granted to organization_admin and users.manage to school leadership`,
      named(userRoutes, method, path, 'platformGuard'),
      false
    );
  }

  for (const [method, path] of [
    ['patch', '/:id'],
    ['put', '/:id/permissions'],
  ]) {
    check(
      `roles ${method.toUpperCase()} ${path} is platform-only — role_permissions has no school_id, so one edit changes every school`,
      named(roleRoutes, method, path, 'platformGuard'),
      true
    );
  }
  for (const [method, path] of [
    ['get', '/'],
    ['get', '/:id'],
  ]) {
    check(
      `but roles ${method.toUpperCase()} ${path} does not — a Principal filtering /users by role has to know which roles exist`,
      named(roleRoutes, method, path, 'platformGuard'),
      false
    );
  }

  console.log('\n--- routing: reads write no activity row ---');

  for (const [router, label, method, path] of [
    [userRoutes, 'users', 'get', '/'],
    [userRoutes, 'users', 'get', '/permissions'],
    [userRoutes, 'users', 'get', '/:id'],
    [roleRoutes, 'roles', 'get', '/'],
    [roleRoutes, 'roles', 'get', '/:id'],
  ]) {
    check(
      `${label} GET ${path} declares none — a list and a catalogue are polled`,
      named(router, method, path, 'activityDeclaration'),
      false
    );
  }
  check(
    'GET /permissions has no validation layer either — it takes no body, no param and no query',
    named(userRoutes, 'get', '/permissions', 'validateRequest'),
    false
  );
}

/* ═══════════════════════════ fixtures ═══════════════════════════ */

const fixtures = {};
const created = { organizations: [], schools: [], users: [], plans: [] };
const baseline = { activityLog: 0, auditLog: 0 };

/** The seeded rows this run mutates, so `removeFixtures` can put them back. */
const seeded = { principalGrants: null, librarianLabels: null };

async function captureBaseline() {
  baseline.activityLog = (await db.ActivityLog.max('id')) || 0;
  baseline.auditLog = (await db.AuditLog.max('id')) || 0;
  return true;
}

async function createFixtures() {
  const roles = {};
  for (const slug of [
    ROLES.SUPER_ADMIN,
    ROLES.ORGANIZATION_ADMIN,
    ROLES.PRINCIPAL,
    ROLES.TEACHER,
    ROLES.LIBRARIAN,
  ]) {
    roles[slug] = await db.Role.findOne({ where: { slug } });
    if (!roles[slug]) throw new Error(`The ${slug} role is missing — run the seeders first.`);
  }
  fixtures.roles = roles;

  /* Captured before anything writes, and restored unconditionally at the end. */
  seeded.principalGrants = (
    await db.RolePermission.findAll({
      where: { role_id: roles[ROLES.PRINCIPAL].id },
      attributes: ['permission_id'],
      raw: true,
    })
  ).map((row) => row.permission_id);
  seeded.librarianLabels = {
    name: roles[ROLES.LIBRARIAN].name,
    description: roles[ROLES.LIBRARIAN].description,
  };

  const orgA = await db.Organization.create({ name: 'Verify Users Alpha', code: 'VUR-ALPHA' });
  const orgB = await db.Organization.create({ name: 'Verify Users Beta', code: 'VUR-BETA' });
  created.organizations.push(orgA.id, orgB.id);
  fixtures.orgA = orgA;
  fixtures.orgB = orgB;

  const schoolA = await db.School.create({
    organization_id: orgA.id,
    name: 'Verify Users A1 School',
    code: 'VUR-A1',
  });
  const schoolB = await db.School.create({
    organization_id: orgB.id,
    name: 'Verify Users B1 School',
    code: 'VUR-B1',
  });
  created.schools.push(schoolA.id, schoolB.id);
  fixtures.schoolA = schoolA;
  fixtures.schoolB = schoolB;

  const password_hash = await hashPassword(PASSWORD);

  const people = [
    ['platform', ROLES.SUPER_ADMIN, 'Verify Platform Admin', 'vur_platform', null, null],
    ['orgadmin', ROLES.ORGANIZATION_ADMIN, 'Verify Org Admin', 'vur_orgadmin', orgA.id, null],
    ['principal', ROLES.PRINCIPAL, 'Verify A1 Principal', 'vur_principal', orgA.id, schoolA.id],
    ['teacher', ROLES.TEACHER, 'Verify A1 Teacher', 'vur_teacher', orgA.id, schoolA.id],
    ['bprincipal', ROLES.PRINCIPAL, 'Verify B1 Principal', 'vur_bprincipal', orgB.id, schoolB.id],
  ];

  for (const [key, slug, name, username, organization_id, school_id] of people) {
    fixtures[key] = await db.User.create({
      role_id: roles[slug].id,
      organization_id,
      school_id,
      name,
      email: `${key}@${DOMAIN}`,
      username,
      password_hash,
      status: USER_STATUS.ACTIVE,
      must_change_password: false,
    });
    created.users.push(fixtures[key].id);
  }

  return created.users.length;
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
  /* A failed sign-in carries no user or tenant for the clauses above to match — see the helper. */
  await removeFailedSignIns(db, { afterId: baseline.activityLog, domains: [DOMAIN] });

  /* The two seeded rows this run mutates, put back whether or not the run reached the restore. */
  await restoreSeeded();

  if (created.users.length) await db.User.destroy({ where: { id: created.users }, force: true });
  if (created.schools.length) await db.School.destroy({ where: { id: created.schools }, force: true });
  if (created.organizations.length) {
    await db.Organization.destroy({ where: { id: created.organizations }, force: true });
  }
  /*
   * After the schools: their subscriptions went with them, and `subscriptions.plan_id` is RESTRICT, so
   * the plan the D2 case subscribes a school to can only go once nothing points at it.
   */
  if (created.plans.length) {
    await db.SubscriptionPlan.destroy({ where: { id: created.plans }, force: true });
  }
  /* Both seeded rows are back, so the journal that would have restored them is no longer owed. */
  clearJournal(JOURNAL);
}

/**
 * Put the principal's grants and the librarian's labels back exactly as captured. Shared by
 * `removeFixtures()` and the recovery below; both roles are looked up rather than read from `fixtures`,
 * which the recovery path has not built yet.
 */
async function restoreSeeded() {
  if (seeded.principalGrants) {
    const principal = await db.Role.findOne({ where: { slug: ROLES.PRINCIPAL } });
    await db.RolePermission.destroy({ where: { role_id: principal.id } });
    await db.RolePermission.bulkCreate(
      seeded.principalGrants.map((permission_id) => ({ role_id: principal.id, permission_id }))
    );
    await permissionService.invalidateRole(principal.id);
  }
  if (seeded.librarianLabels) {
    const librarian = await db.Role.findOne({ where: { slug: ROLES.LIBRARIAN } });
    await db.Role.update(seeded.librarianLabels, { where: { id: librarian.id } });
  }
}

/**
 * Recover from a run killed before its `finally`. Measured: a killed run left the principal **three
 * grants short**, and the rerun captured that as the seeded set and preserved the loss. The librarian's
 * labels are subject to the same capture and would not show up in any row count at all. The journal
 * predates both mutations — see `scripts/lib/residue.js`.
 */
async function recoverFromDeadRun() {
  const pending = readJournal(JOURNAL);
  if (pending) {
    Object.assign(seeded, pending);
    await restoreSeeded();
    clearJournal(JOURNAL);
    seeded.principalGrants = null;
    seeded.librarianLabels = null;
    console.log('(restored the principal grants and librarian labels a killed earlier run left mutated)');
  }
  const residueCleared = await sweepResidue(db, { codes: ['VUR-'], domains: [DOMAIN] });
  if (residueCleared) {
    console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
  }
}

/* ═══════════════════════════ part 3 — over HTTP ═══════════════════════════ */

async function verifyHttp() {
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  async function call(path, { method = 'GET', body, token } = {}) {
    const headers = { 'Content-Type': 'application/json' };
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

    console.log('\n--- the boundary: both mounts sit below it ---');

    for (const path of ['/users', '/users/permissions', '/users/1', '/roles', '/roles/1']) {
      check(`${path} is 401 without a token`, (await call(path)).status, 401);
    }

    const tokens = {
      platform: await signIn(`platform@${DOMAIN}`),
      orgadmin: await signIn(`orgadmin@${DOMAIN}`),
      principal: await signIn(`principal@${DOMAIN}`),
      teacher: await signIn(`teacher@${DOMAIN}`),
      bprincipal: await signIn(`bprincipal@${DOMAIN}`),
    };
    for (const key of Object.keys(tokens)) {
      check(`the ${key} fixture signs in`, Boolean(tokens[key]), true);
    }

    /* ─────────────────────────── GET /users — tenant isolation ─────────────────────────── */

    console.log('\n--- GET /users: the tenant columns do the narrowing, with no role filter ---');

    const asPlatform = await call('/users?limit=100', { token: tokens.platform });
    check('a Super Admin gets 200', asPlatform.status, 200);
    const platformIds = dataOf(asPlatform).map((u) => u.id);
    check(
      'and sees every fixture plus the seeded Super Admin — no tenant column is pinned',
      created.users.every((id) => platformIds.includes(id)),
      true
    );
    check(
      'including platform accounts, which is the point of allowPlatformWide',
      platformIds.includes(fixtures.platform.id),
      true
    );

    const asPrincipal = await call('/users?limit=100', { token: tokens.principal });
    check('a Principal gets 200 — SCHOOL_LEADERSHIP holds users.view', asPrincipal.status, 200);
    const principalRows = dataOf(asPrincipal);
    check(
      'and sees only their own school',
      [...new Set(principalRows.map((u) => u.school_id))],
      [fixtures.schoolA.id]
    );
    check(
      'so the other organization Principal is absent',
      principalRows.some((u) => u.id === fixtures.bprincipal.id),
      false
    );
    check(
      'and every super_admin is invisible — a platform row carries both tenant columns null, so it matches no school-scoped WHERE',
      principalRows.some((u) => u.role && u.role.slug === ROLES.SUPER_ADMIN),
      false
    );
    check(
      'which includes the seeded bootstrap account, not just the fixture',
      principalRows.some((u) => u.email === 'superadmin@msms.local'),
      false
    );

    const asOrgAdmin = await call('/users?limit=100', { token: tokens.orgadmin });
    check('an Organization Admin gets 200 — DEFAULT_ROLE_PERMISSIONS grants users.view', asOrgAdmin.status, 200);
    const orgRows = dataOf(asOrgAdmin);
    check(
      'and sees their organization: the org admin, the A1 Principal and the A1 Teacher',
      orgRows.map((u) => u.id).sort((a, b) => a - b),
      [fixtures.orgadmin.id, fixtures.principal.id, fixtures.teacher.id].sort((a, b) => a - b)
    );
    check(
      'the other organization is absent — organization_id, one level wider than a school, is still a boundary',
      orgRows.some((u) => u.id === fixtures.bprincipal.id),
      false
    );

    console.log('\n--- GET /users: filters, and a filter that tries to widen the scope ---');

    const byRole = await call(`/users?role=${ROLES.TEACHER}&limit=100`, { token: tokens.platform });
    check('?role= filters by the §5 slug', dataOf(byRole).map((u) => u.id), [fixtures.teacher.id]);
    check(
      '?role= outside the eleven is a 422, not an empty list — the slug set is closed',
      [
        (await call('/users?role=wizard', { token: tokens.platform })).status,
        codeOf(await call('/users?role=wizard', { token: tokens.platform })),
      ],
      [422, 'VALIDATION_ERROR']
    );

    const bySearch = await call('/users?q=vur_bprincipal', { token: tokens.platform });
    check('?q= matches on username', dataOf(bySearch).map((u) => u.id), [fixtures.bprincipal.id]);

    const ownSchool = await call(`/users?school_id=${fixtures.schoolA.id}&limit=100`, {
      token: tokens.principal,
    });
    check('?school_id= naming the caller own school is allowed', ownSchool.status, 200);

    const otherSchool = await call(`/users?school_id=${fixtures.schoolB.id}`, {
      token: tokens.principal,
    });
    check(
      '?school_id= naming another school is refused by enforceTenant — layer 3 answers before the service',
      [otherSchool.status, codeOf(otherSchool)],
      [403, 'CROSS_TENANT_ACCESS_DENIED']
    );
    check(
      'and the refusal names the field without saying whether that school exists',
      otherSchool.body.error.details,
      { field: 'school_id', location: 'query' }
    );

    console.log('\n--- GET /users: pagination and sorting ---');

    const firstPage = await call('/users?limit=1&sortBy=id&sortOrder=ASC', { token: tokens.platform });
    check('?limit=1 returns one row', dataOf(firstPage).length, 1);
    check(
      'with a pagination envelope that describes the whole set',
      firstPage.body.meta.pagination.total >= created.users.length + 1,
      true
    );
    check('and says there is more', firstPage.body.meta.pagination.hasNextPage, true);
    check('and that this is the first page', firstPage.body.meta.pagination.hasPreviousPage, false);

    const ascending = dataOf(await call('/users?limit=100&sortBy=id&sortOrder=ASC', { token: tokens.platform })).map((u) => u.id);
    const descending = dataOf(await call('/users?limit=100&sortBy=id&sortOrder=DESC', { token: tokens.platform })).map((u) => u.id);
    check('sortOrder reverses the result', ascending.slice().reverse(), descending);

    const injected = await call('/users?limit=100&sortBy=password_hash', { token: tokens.platform });
    check(
      'a sortBy outside SORTABLE is ignored, not passed to ORDER BY — getSort allow-lists per call site (SRS §24)',
      injected.status,
      200
    );
    check(
      'and the fallback applies instead',
      dataOf(injected).length === dataOf(await call('/users?limit=100', { token: tokens.platform })).length,
      true
    );

    /* ─────────────────────────────── GET /users/:id ─────────────────────────────── */

    console.log('\n--- GET /users/:id: the permission picture behind FR-AUTH-009 ---');

    const detail = await call(`/users/${fixtures.teacher.id}`, { token: tokens.platform });
    check('a Super Admin reads one account', detail.status, 200);
    const teacherDetail = dataOf(detail).user;
    check(
      'the detail view publishes all four halves of the resolution',
      Object.keys(teacherDetail.permissions).sort(),
      ['denied', 'effective', 'extra', 'role']
    );
    check(
      'the role grants match DEFAULT_ROLE_PERMISSIONS for teacher',
      teacherDetail.permissions.role,
      DEFAULT_ROLE_PERMISSIONS[ROLES.TEACHER].slice().sort()
    );
    check('with no overrides yet', [teacherDetail.permissions.extra, teacherDetail.permissions.denied], [[], []]);
    check(
      'so effective equals the role grants exactly',
      teacherDetail.permissions.effective,
      DEFAULT_ROLE_PERMISSIONS[ROLES.TEACHER].slice().sort()
    );
    check(
      'and no secret column leaks into the payload',
      ['password_hash', 'refresh_token_hash', 'password_reset_token_hash', 'email_verification_token_hash'].filter(
        (f) => f in teacherDetail
      ),
      []
    );
    check(
      'nor do the lockout counters — publicUser publishes an explicit list',
      ['failed_login_attempts', 'locked_until', 'extra_permissions', 'denied_permissions'].filter(
        (f) => f in teacherDetail
      ),
      []
    );
    check('the school is named, not just its id', teacherDetail.school.code, 'VUR-A1');
    check('and so is the organization', teacherDetail.organization.code, 'VUR-ALPHA');

    const crossTenantRead = await call(`/users/${fixtures.bprincipal.id}`, { token: tokens.principal });
    check(
      'another school account is a 404, not a 403 — the scope makes it invisible rather than forbidden, so the id is not an enumeration oracle',
      [crossTenantRead.status, codeOf(crossTenantRead)],
      [404, 'USER_NOT_FOUND']
    );

    /* ─────────────────────────── GET /users/permissions ─────────────────────────── */

    console.log('\n--- GET /users/permissions: the assignable vocabulary ---');

    const catalogue = await call('/users/permissions', { token: tokens.platform });
    check('a Super Admin reads the catalogue', catalogue.status, 200);
    check(
      'which publishes every key in config/permissions.js — the file the seeder writes from, so the screen and the guard agree about what exists',
      dataOf(catalogue).total,
      PERMISSION_KEYS.length
    );
    check(
      'grouped, and every entry carries a key and a name',
      dataOf(catalogue).groups.every(
        (g) => typeof g.group === 'string' && g.permissions.every((p) => p.key && p.name)
      ),
      true
    );

    const principalCatalogue = await call('/users/permissions', { token: tokens.principal });
    check(
      'a Principal reads it too — they hold users.manage, so requiring roles.view would let them write an override while forbidding the list of keys to choose from',
      principalCatalogue.status,
      200
    );

    const orgCatalogue = await call('/users/permissions', { token: tokens.orgadmin });
    check(
      'an Organization Admin is refused — they hold users.view but neither users.manage nor roles.view',
      [orgCatalogue.status, codeOf(orgCatalogue)],
      [403, 'INSUFFICIENT_PERMISSION']
    );
    check(
      'and the refusal names both acceptable keys, so the route guard is pinned by its own 403',
      orgCatalogue.body.error.details,
      { requiredAnyOf: ['users.manage', 'roles.view'] }
    );

    /* ─────────────────────────────── PATCH /users/:id ─────────────────────────────── */

    console.log('\n--- PATCH /users/:id: the six editable columns ---');

    const renamed = await call(`/users/${fixtures.teacher.id}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: { name: 'Verify A1 Teacher Renamed', phone: '+1 555 0199', locale: 'en-GB' },
    });
    check('an edit is 200', renamed.status, 200);
    check('the message names the action', renamed.body.message, 'User updated');
    check('the new name comes back', dataOf(renamed).user.name, 'Verify A1 Teacher Renamed');
    check('and the phone', dataOf(renamed).user.phone, '+1 555 0199');
    check(
      'verificationEmailSent is absent when the address was not touched — null means "not applicable", and the controller omits it',
      'verificationEmailSent' in dataOf(renamed),
      false
    );

    const emptyPatch = await call(`/users/${fixtures.teacher.id}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: {},
    });
    check(
      'an empty body is a 422, not a 200 that writes nothing',
      [emptyPatch.status, codeOf(emptyPatch)],
      [422, 'VALIDATION_ERROR']
    );

    const stripAttempt = await call(`/users/${fixtures.teacher.id}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: { role_id: fixtures.roles[ROLES.SUPER_ADMIN].id },
    });
    check(
      'a body containing only role_id is a 422 — the field is stripped, and object.min then refuses the empty remainder',
      [stripAttempt.status, codeOf(stripAttempt)],
      [422, 'VALIDATION_ERROR']
    );
    const unchangedRole = await call(`/users/${fixtures.teacher.id}`, { token: tokens.platform });
    check(
      'so the teacher is still a teacher',
      dataOf(unchangedRole).user.role.slug,
      ROLES.TEACHER
    );

    const takenEmail = await call(`/users/${fixtures.teacher.id}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: { email: `principal@${DOMAIN}` },
    });
    check(
      'a duplicate email is a 409, not a 500',
      [takenEmail.status, codeOf(takenEmail)],
      [409, 'EMAIL_TAKEN']
    );
    check('naming the field that collided', takenEmail.body.error.details, {
      email: `principal@${DOMAIN}`,
    });

    const takenUsername = await call(`/users/${fixtures.teacher.id}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: { username: 'vur_principal' },
    });
    check(
      'a duplicate username is a 409 that names the *other* column — users carries two unique indexes, and an unqualified message leaves the operator changing the wrong field',
      [takenUsername.status, codeOf(takenUsername), takenUsername.body.error.details.username],
      [409, 'USERNAME_TAKEN', 'vur_principal']
    );

    console.log('\n--- PATCH /users/:id: FR-AUTH-006, an address change re-opens verification ---');

    await db.User.update(
      { email_verified_at: new Date() },
      { where: { id: fixtures.teacher.id } }
    );
    const verifiedBefore = await call(`/users/${fixtures.teacher.id}`, { token: tokens.platform });
    check('the teacher starts verified', Boolean(dataOf(verifiedBefore).user.email_verified_at), true);

    const newAddress = `teacher.moved@${DOMAIN}`;
    const emailChange = await call(`/users/${fixtures.teacher.id}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: { email: newAddress },
    });
    check('the change is 200', emailChange.status, 200);
    check('the new address comes back', dataOf(emailChange).user.email, newAddress);
    check(
      'email_verified_at is cleared — leaving it set would have the system assert it had confirmed an address nobody answered',
      dataOf(emailChange).user.email_verified_at,
      null
    );
    check(
      'and a fresh verification was issued, reported explicitly rather than silently',
      dataOf(emailChange).verificationEmailSent,
      true
    );
    /*
     * `withSecrets`, because the default scope on `User` excludes the four secret columns — a plain
     * `findByPk` returns them as `undefined`, and `undefined && …` is falsy, so this assertion would
     * fail even on a correct implementation. Asserted below in its own right.
     */
    const tokenColumn = await db.User.scope('withSecrets').findByPk(fixtures.teacher.id);
    check(
      'which wrote the token columns FR-AUTH-006 verifies against',
      Boolean(tokenColumn.email_verification_token_hash && tokenColumn.email_verification_expires_at),
      true
    );
    const scopedRead = await db.User.findByPk(fixtures.teacher.id);
    check(
      'and the default model scope hides that hash even from server-side code — publicUser is the second line of defence, not the first',
      [
        'email_verification_token_hash' in scopedRead.get(),
        'password_hash' in scopedRead.get(),
        'refresh_token_hash' in scopedRead.get(),
        'password_reset_token_hash' in scopedRead.get(),
      ],
      [false, false, false, false]
    );

    console.log('\n--- PATCH /users/:id: safety property 1, you may not change your own status ---');

    const selfSuspend = await call(`/users/${fixtures.platform.id}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: { status: USER_STATUS.SUSPENDED },
    });
    check(
      'a Super Admin cannot suspend themselves — the last one to do so would leave the platform with no way back in',
      [selfSuspend.status, codeOf(selfSuspend)],
      [403, 'SELF_MODIFICATION_DENIED']
    );
    check('and the refusal names the field', selfSuspend.body.error.details, {
      field: 'account status',
    });

    const selfSameStatus = await call(`/users/${fixtures.platform.id}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: { status: USER_STATUS.ACTIVE, name: 'Verify Platform Admin' },
    });
    check(
      'but submitting the status it already has is allowed — the rule is about *changing* it, so a form that round-trips every field still works',
      selfSameStatus.status,
      200
    );

    const selfRename = await call(`/users/${fixtures.platform.id}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: { locale: 'en-GB' },
    });
    check('and editing your own non-status fields is untouched by the rule', selfRename.status, 200);

    console.log('\n--- PATCH /users/:id: who may edit whom ---');

    const principalEdit = await call(`/users/${fixtures.teacher.id}`, {
      method: 'PATCH',
      token: tokens.principal,
      body: { phone: '+1 555 0200' },
    });
    check(
      'a Principal edits their own school account — this is why /users carries no platform guard',
      principalEdit.status,
      200
    );

    const orgEdit = await call(`/users/${fixtures.teacher.id}`, {
      method: 'PATCH',
      token: tokens.orgadmin,
      body: { phone: '+1 555 0201' },
    });
    check(
      'an Organization Admin cannot — they hold users.view, deliberately not users.manage',
      [orgEdit.status, codeOf(orgEdit)],
      [403, 'INSUFFICIENT_PERMISSION']
    );
    check('and the 403 pins the route key', orgEdit.body.error.details, {
      required: ['users.manage'],
      missing: ['users.manage'],
    });

    const crossTenantEdit = await call(`/users/${fixtures.bprincipal.id}`, {
      method: 'PATCH',
      token: tokens.principal,
      body: { phone: '+1 555 0202' },
    });
    check(
      'and another school account is a 404 on write too, for the same reason as the read',
      [crossTenantEdit.status, codeOf(crossTenantEdit)],
      [404, 'USER_NOT_FOUND']
    );

    console.log('\n--- FR-AUTH-007: a suspension bites on the next request, with no second mechanism ---');

    const teacherBefore = await call(`/users/${fixtures.teacher.id}`, { token: tokens.principal });
    check('the teacher reads fine while active', teacherBefore.status, 200);
    const teacherOwnCall = await call('/auth/me', { token: tokens.teacher });
    check('and can use their own token', teacherOwnCall.status, 200);

    const suspend = await call(`/users/${fixtures.teacher.id}`, {
      method: 'PATCH',
      token: tokens.principal,
      body: { status: USER_STATUS.SUSPENDED },
    });
    check('a Principal suspends a school account (FR-AUTH-007)', suspend.status, 200);
    check('and the new status comes back', dataOf(suspend).user.status, USER_STATUS.SUSPENDED);

    const afterSuspend = await call('/auth/me', { token: tokens.teacher });
    check(
      'the teacher existing token is now refused — authenticate checks LOGIN_ALLOWED_STATUSES on every request, so refresh_token_hash is deliberately left alone',
      [afterSuspend.status, codeOf(afterSuspend)],
      [403, 'ACCOUNT_SUSPENDED']
    );
    const suspendedLogin = await call('/auth/login', {
      method: 'POST',
      body: { identifier: newAddress, password: PASSWORD },
    });
    check(
      'and a fresh login is refused too — assertUsableAccount checks the same list',
      [suspendedLogin.status, codeOf(suspendedLogin)],
      [403, 'ACCOUNT_SUSPENDED']
    );
    const suspendedRow = await db.User.scope('withSecrets').findByPk(fixtures.teacher.id);
    check(
      'the session column was not cleared, because nothing needed it to be',
      suspendedRow.refresh_token_hash !== null,
      true
    );

    await call(`/users/${fixtures.teacher.id}`, {
      method: 'PATCH',
      token: tokens.principal,
      body: { status: USER_STATUS.ACTIVE },
    });
    check(
      'reactivating restores the same token, since it was never invalidated',
      (await call('/auth/me', { token: tokens.teacher })).status,
      200
    );

    /* ─────────────────────── PUT /users/:id/permissions ─────────────────────── */

    console.log('\n--- PUT /users/:id/permissions: FR-AUTH-009 per-user overrides ---');

    const granted = await call(`/users/${fixtures.teacher.id}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { extra_permissions: [WITHIN_PRINCIPAL, 'library.manage'] },
    });
    check('a grant is 200', granted.status, 200);
    check('the message names the action', granted.body.message, 'Permissions updated');
    check(
      'the extras come back sorted',
      dataOf(granted).user.permissions.extra,
      ['library.manage', WITHIN_PRINCIPAL].sort()
    );
    check(
      'and appear in the effective set',
      dataOf(granted).user.permissions.effective.includes('library.manage'),
      true
    );
    check(
      'while the role grants are untouched — an override is one account exception, not a role edit',
      dataOf(granted).user.permissions.role,
      DEFAULT_ROLE_PERMISSIONS[ROLES.TEACHER].slice().sort()
    );

    const denyOnly = await call(`/users/${fixtures.teacher.id}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { denied_permissions: ['attendance.mark'] },
    });
    check(
      'sending only one side leaves the other alone — absent means "leave it", which is why the current value is the fallback rather than []',
      dataOf(denyOnly).user.permissions.extra,
      ['library.manage', WITHIN_PRINCIPAL].sort()
    );
    check('the deny is stored', dataOf(denyOnly).user.permissions.denied, ['attendance.mark']);
    check(
      'and wins outright over the role grant — deny is applied last',
      dataOf(denyOnly).user.permissions.effective.includes('attendance.mark'),
      false
    );
    check(
      'even though the role still grants it, so the role and the effective set legitimately disagree',
      dataOf(denyOnly).user.permissions.role.includes('attendance.mark'),
      true
    );

    const bothArrays = await call(`/users/${fixtures.teacher.id}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { extra_permissions: ['exams.manage'], denied_permissions: ['exams.manage'] },
    });
    check(
      'a key in both arrays is a 422 — getEffectivePermissions would resolve it, but the screen would then show a granted permission that does not apply',
      [bothArrays.status, codeOf(bothArrays)],
      [422, 'VALIDATION_ERROR']
    );
    check(
      'and the message names the contradiction',
      bothArrays.body.error.details.extra_permissions,
      'Also listed in denied_permissions: exams.manage'
    );

    const unknownKey = await call(`/users/${fixtures.teacher.id}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { extra_permissions: ['students.view', 'students.teleport'] },
    });
    check(
      'a well-formed but non-existent key is a 422 — permissionService drops it on read, so storing it would look like access and be none',
      [unknownKey.status, codeOf(unknownKey)],
      [422, 'VALIDATION_ERROR']
    );
    check(
      'naming the unknown key, which is the difference between an actionable message and "validation failed"',
      unknownKey.body.error.details.extra_permissions,
      'Unknown permission key(s): students.teleport'
    );

    const selfPermissions = await call(`/users/${fixtures.platform.id}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { denied_permissions: ['users.manage'] },
    });
    check(
      'safety property 2: nobody edits their own overrides — the same lockout in the deny direction',
      [selfPermissions.status, codeOf(selfPermissions)],
      [403, 'SELF_MODIFICATION_DENIED']
    );
    check('and the field is named', selfPermissions.body.error.details, { field: 'permissions' });

    console.log('\n--- safety property 3: users.manage is not the highest privilege in the system ---');

    const escalate = await call(`/users/${fixtures.teacher.id}/permissions`, {
      method: 'PUT',
      token: tokens.principal,
      body: { extra_permissions: [BEYOND_PRINCIPAL] },
    });
    check(
      `a Principal cannot grant ${BEYOND_PRINCIPAL} — without this rule they could operate the platform through a teacher`,
      [escalate.status, codeOf(escalate)],
      [403, 'PERMISSION_GRANT_EXCEEDS_OWN']
    );
    check('and the refusal names exactly what was out of reach', escalate.body.error.details, {
      extra_permissions: [BEYOND_PRINCIPAL],
    });

    const withinReach = await call(`/users/${fixtures.teacher.id}/permissions`, {
      method: 'PUT',
      token: tokens.principal,
      body: { extra_permissions: [WITHIN_PRINCIPAL] },
    });
    check(
      `but ${WITHIN_PRINCIPAL} is within their own set, so the grant path works`,
      withinReach.status,
      200
    );

    const denyBeyond = await call(`/users/${fixtures.teacher.id}/permissions`, {
      method: 'PUT',
      token: tokens.principal,
      body: { denied_permissions: [BEYOND_PRINCIPAL] },
    });
    check(
      `and *denying* ${BEYOND_PRINCIPAL} is allowed even though granting it is not — revocation cannot escalate anything, so the ceiling is deliberately one-sided`,
      denyBeyond.status,
      200
    );

    const superAdminCanGrant = await call(`/users/${fixtures.teacher.id}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { extra_permissions: [BEYOND_PRINCIPAL], denied_permissions: [] },
    });
    check(
      'a Super Admin holds every key, so the same grant succeeds for them — the rule is a ceiling, not a blanket ban',
      [superAdminCanGrant.status, dataOf(superAdminCanGrant).user.permissions.extra],
      [200, [BEYOND_PRINCIPAL]]
    );

    console.log('\n--- an override bites on the next request, with no cache call at all ---');

    check(
      'the teacher token works before the deny',
      (await call('/auth/me', { token: tokens.teacher })).status,
      200
    );

    const denyPrincipalRead = await call(`/users/${fixtures.principal.id}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { denied_permissions: ['users.view'] },
    });
    check('users.view is denied on the Principal account', denyPrincipalRead.status, 200);
    const principalAfterDeny = await call('/users', { token: tokens.principal });
    check(
      'and their *existing* token is refused immediately — the override columns are read off the users row authenticate already loaded, so no invalidation exists to forget',
      [principalAfterDeny.status, codeOf(principalAfterDeny)],
      [403, 'INSUFFICIENT_PERMISSION']
    );

    const clearOverrides = await call(`/users/${fixtures.principal.id}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { extra_permissions: [], denied_permissions: [] },
    });
    check(
      'an empty array clears the side, as against omitting it',
      dataOf(clearOverrides).user.permissions.denied,
      []
    );
    check(
      'and the Principal reads /users again on the same token',
      (await call('/users', { token: tokens.principal })).status,
      200
    );

    /* ─────────────────────────────── /roles ─────────────────────────────── */

    console.log('\n--- GET /roles: §5 eleven, and the one figure that is tenant data ---');

    const rolesAsPlatform = await call('/roles', { token: tokens.platform });
    check('a Super Admin reads the list', rolesAsPlatform.status, 200);
    check(
      'which is unpaginated and exactly eleven long — SRS §5 fixes the list, so a pagination envelope could only describe one page',
      dataOf(rolesAsPlatform).total,
      11
    );
    check(
      'no meta.pagination is emitted',
      Boolean(rolesAsPlatform.body.meta && 'pagination' in rolesAsPlatform.body.meta),
      false
    );
    const platformRoleRows = dataOf(rolesAsPlatform).roles;
    check(
      'every row carries the three structural booleans a screen needs to know what is editable',
      platformRoleRows.every(
        (r) => 'isPlatformRole' in r && 'isSchoolRole' in r && 'isSystem' in r
      ),
      true
    );
    const superAdminRow = platformRoleRows.find((r) => r.slug === ROLES.SUPER_ADMIN);
    check(
      'super_admin permissionCount is the whole catalogue',
      superAdminRow.permissionCount,
      PERMISSION_KEYS.length
    );
    check(
      'and its userCount is platform-wide for a platform caller',
      superAdminRow.userCount >= 2,
      true
    );

    const rolesAsPrincipal = await call('/roles', { token: tokens.principal });
    check(
      'a Principal reads it too — they hold users.view, and §5 role list is a fixed property of the product, not tenant data',
      rolesAsPrincipal.status,
      200
    );
    const principalRoleRows = dataOf(rolesAsPrincipal).roles;
    check(
      'but userCount is scoped: no super_admin is inside their school, so the figure is zero',
      principalRoleRows.find((r) => r.slug === ROLES.SUPER_ADMIN).userCount,
      0
    );
    check(
      'while their own role counts the one account they can see',
      principalRoleRows.find((r) => r.slug === ROLES.PRINCIPAL).userCount,
      1
    );
    check(
      'and the B1 Principal is not in that figure — an unscoped COUNT GROUP BY would have leaked it',
      platformRoleRows.find((r) => r.slug === ROLES.PRINCIPAL).userCount >
        principalRoleRows.find((r) => r.slug === ROLES.PRINCIPAL).userCount,
      true
    );
    check(
      'permissionCount is identical for both callers, because role_permissions has no school_id to scope by',
      principalRoleRows.find((r) => r.slug === ROLES.PRINCIPAL).permissionCount,
      platformRoleRows.find((r) => r.slug === ROLES.PRINCIPAL).permissionCount
    );

    const principalRoleId = fixtures.roles[ROLES.PRINCIPAL].id;
    const librarianRoleId = fixtures.roles[ROLES.LIBRARIAN].id;
    const superAdminRoleId = fixtures.roles[ROLES.SUPER_ADMIN].id;

    const roleDetail = await call(`/roles/${principalRoleId}`, { token: tokens.platform });
    check('GET /roles/:id returns the grant set', roleDetail.status, 200);
    check(
      'matching the seeded defaults',
      dataOf(roleDetail).role.permissions,
      DEFAULT_ROLE_PERMISSIONS[ROLES.PRINCIPAL].slice().sort()
    );

    console.log('\n--- /roles writes: platform-only, because role_permissions has no school_id ---');

    const principalRoleWrite = await call(`/roles/${librarianRoleId}`, {
      method: 'PATCH',
      token: tokens.principal,
      body: { name: 'Hijacked' },
    });
    check(
      'a Principal is refused by the scope guard, which runs before the permission guard',
      [principalRoleWrite.status, codeOf(principalRoleWrite)],
      [403, 'PLATFORM_SCOPE_REQUIRED']
    );
    const orgRoleWrite = await call(`/roles/${librarianRoleId}/permissions`, {
      method: 'PUT',
      token: tokens.orgadmin,
      body: { permissions: [] },
    });
    check(
      'and so is an Organization Admin — one level wider is still below the platform',
      [orgRoleWrite.status, codeOf(orgRoleWrite)],
      [403, 'PLATFORM_SCOPE_REQUIRED']
    );

    const labelEdit = await call(`/roles/${librarianRoleId}`, {
      method: 'PATCH',
      token: tokens.platform,
      body: { name: 'Verify Librarian Label', description: 'edited by verify-users-roles.js' },
    });
    check('a Super Admin edits the labels', labelEdit.status, 200);
    check('and the new name comes back', dataOf(labelEdit).role.name, 'Verify Librarian Label');
    check(
      'the slug is unchanged — it is what ROLES matches against and principals.service resolves by',
      dataOf(labelEdit).role.slug,
      ROLES.LIBRARIAN
    );

    const superAdminEdit = await call(`/roles/${superAdminRoleId}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { permissions: [WITHIN_PRINCIPAL] },
    });
    check(
      'super_admin grants are read-only — the seeder hard-syncs them back, so accepting the edit would report a change the next db:seed silently undoes',
      [superAdminEdit.status, codeOf(superAdminEdit)],
      [403, 'ROLE_NOT_EDITABLE']
    );
    check('and the refusal names the role', superAdminEdit.body.error.details, {
      slug: ROLES.SUPER_ADMIN,
    });

    const roleUnknownKey = await call(`/roles/${librarianRoleId}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { permissions: ['library.view', 'library.teleport'] },
    });
    check(
      'a non-existent key is a 422 here too',
      [roleUnknownKey.status, codeOf(roleUnknownKey)],
      [422, 'VALIDATION_ERROR']
    );
    check(
      'naming it',
      roleUnknownKey.body.error.details.permissions,
      'Unknown permission key(s): library.teleport'
    );

    console.log('\n--- a role edit bites on the next request: permissionService.invalidateRole ---');

    check(
      'the Principal reads /users on their existing token',
      (await call('/users', { token: tokens.principal })).status,
      200
    );

    const withoutUsersView = DEFAULT_ROLE_PERMISSIONS[ROLES.PRINCIPAL].filter(
      (key) => key !== 'users.view'
    );
    const revoke = await call(`/roles/${principalRoleId}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { permissions: withoutUsersView },
    });
    check('a different caller strips users.view from the principal role', revoke.status, 200);
    check(
      'and the response reports the reduced set',
      dataOf(revoke).role.permissions.length,
      withoutUsersView.length
    );

    const afterRevoke = await call('/users', { token: tokens.principal });
    check(
      'the Principal is refused immediately, on the token they already held — with CACHE_TTL=600 a missed invalidateRole would have left it working for ten minutes',
      [afterRevoke.status, codeOf(afterRevoke)],
      [403, 'INSUFFICIENT_PERMISSION']
    );
    check(
      'and /roles is refused too, since users.view was the only key that route accepted from them',
      codeOf(await call('/roles', { token: tokens.principal })),
      'INSUFFICIENT_PERMISSION'
    );

    const restore = await call(`/roles/${principalRoleId}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { permissions: DEFAULT_ROLE_PERMISSIONS[ROLES.PRINCIPAL] },
    });
    check('restoring the set is 200', restore.status, 200);
    check(
      'and the same token works again — the invalidation cuts both ways, which is what makes it a cache rather than a second source of truth',
      (await call('/users', { token: tokens.principal })).status,
      200
    );
    check(
      'the grant set is byte-identical to the seeded defaults',
      dataOf(restore).role.permissions,
      DEFAULT_ROLE_PERMISSIONS[ROLES.PRINCIPAL].slice().sort()
    );

    const emptyGrantSet = await call(`/roles/${librarianRoleId}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { permissions: [] },
    });
    check(
      'a role can be stripped to nothing — the empty case has to be expressible or the last permission could never be revoked',
      [emptyGrantSet.status, dataOf(emptyGrantSet).role.permissions],
      [200, []]
    );
    check(
      'and the count in the list reflects it',
      dataOf(await call('/roles', { token: tokens.platform })).roles.find(
        (r) => r.slug === ROLES.LIBRARIAN
      ).permissionCount,
      0
    );
    await call(`/roles/${librarianRoleId}/permissions`, {
      method: 'PUT',
      token: tokens.platform,
      body: { permissions: DEFAULT_ROLE_PERMISSIONS[ROLES.LIBRARIAN] },
    });
    check(
      'the librarian defaults are put back',
      dataOf(await call(`/roles/${librarianRoleId}`, { token: tokens.platform })).role.permissions,
      DEFAULT_ROLE_PERMISSIONS[ROLES.LIBRARIAN].slice().sort()
    );

    const missingRole = await call('/roles/999999', { token: tokens.platform });
    check(
      'an unknown role id is a 404',
      [missingRole.status, codeOf(missingRole)],
      [404, 'ROLE_NOT_FOUND']
    );

    /* ─────────────────────────────── the trail ─────────────────────────────── */

    console.log('\n--- SRS §26 / §29: the trail the run left behind ---');

    /* `activityAudit` writes on `res.on('finish')`, so the last response may not be recorded yet. */
    await sleep(400);

    /*
     * Read as model instances, not `raw: true`. `new_values`, `old_values` and `metadata` are JSON
     * columns, which MariaDB stores as LONGTEXT — a raw read hands back the serialised string, and
     * `'password_hash' in <string>` throws rather than answering. The instance getter parses them.
     */
    const audits = await db.AuditLog.findAll({
      where: { id: { [db.Op.gt]: baseline.auditLog } },
      order: [['id', 'ASC']],
    });
    const activities = await db.ActivityLog.findAll({
      where: { id: { [db.Op.gt]: baseline.activityLog } },
      order: [['id', 'ASC']],
    });

    check('audit rows were written', audits.length > 0, true);
    check(
      'a plain edit is recorded against the users table',
      audits.some((r) => r.table_name === 'users' && r.reason === 'User updated'),
      true
    );
    check(
      'and an address change says why re-verification is needed',
      audits.some(
        (r) =>
          r.table_name === 'users' &&
          r.reason === 'User updated; email address changed and must be re-verified'
      ),
      true
    );
    check(
      'an override write has its own reason',
      audits.some((r) => r.reason === 'Per-user permission overrides replaced'),
      true
    );
    check(
      'a role grant edit is recorded against role_permissions, not roles — the table that changed is the table named',
      audits.some(
        (r) => r.table_name === 'role_permissions' && /^Permission set replaced for role /.test(r.reason || '')
      ),
      true
    );
    check(
      'while a label edit is recorded against roles',
      audits.some((r) => r.table_name === 'roles' && r.reason === 'Role label updated'),
      true
    );

    const overrideAudit = audits.find((r) => r.reason === 'Per-user permission overrides replaced');
    check(
      'an override audit row carries the two override columns and nothing else — `id` is in PERMISSION_AUDIT_FIELDS but never changes, and diff() records only what did',
      Object.keys(overrideAudit.new_values || {}).sort(),
      ['denied_permissions', 'extra_permissions']
    );
    const userAudit = audits.find((r) => r.table_name === 'users' && r.reason === 'User updated');
    check(
      'and a user audit row is held to its own allow-list',
      Object.keys(userAudit.new_values || {}).every((f) => usersService.AUDIT_FIELDS.includes(f)),
      true
    );
    check(
      'so no secret column reaches audit_logs, which has a longer retention than the row it came from',
      audits.some((r) =>
        ['password_hash', 'refresh_token_hash', 'email_verification_token_hash'].some(
          (f) => f in (r.new_values || {}) || f in (r.old_values || {})
        )
      ),
      false
    );

    const grantAudit = audits.find((r) => r.table_name === 'role_permissions');
    check(
      'a role grant audit records the before and after key sets, sorted, so the diff is readable',
      Array.isArray(grantAudit.old_values.permissions) && Array.isArray(grantAudit.new_values.permissions),
      true
    );

    check(
      'activity rows were written for both entity types',
      [...new Set(activities.map((r) => r.entity_type))].filter((t) => t === 'user' || t === 'role').sort(),
      ['role', 'user']
    );
    check(
      'a user edit activity logs the field *names*',
      activities.some((r) => r.entity_type === 'user' && /^Updated user \w+ \(/.test(r.description || '')),
      true
    );
    check(
      'and never a submitted value — an email address in a description outlives the row it came from',
      activities.some((r) => (r.description || '').includes(newAddress)),
      false
    );
    const overrideActivity = activities.find((r) =>
      /^Replaced permission overrides for /.test(r.description || '')
    );
    check(
      'an override activity row carries counts, not keys — the keys are already in audit_logs, and an activity row is the summary an administrator scrolls',
      ['extraCount', 'deniedCount', 'effectiveCount'].map((k) => k in (overrideActivity.metadata || {})),
      [true, true, true]
    );
    check(
      'and no permission key reaches the metadata — `durationMs` is added by the middleware, so the assertion is about what is absent, not an exact key list',
      Object.values(overrideActivity.metadata || {}).some(
        (v) => typeof v === 'string' && v.includes('.')
      ),
      false
    );
    const roleActivity = activities.find((r) =>
      /^Replaced the platform-wide permission set for role /.test(r.description || '')
    );
    check(
      'and a role activity row says platform-wide in as many words, because that is the fact to register',
      Boolean(roleActivity),
      true
    );
    check(
      'no *successful* read wrote an activity row — the list, so a regression names the route rather than just flipping a boolean',
      activities
        .filter((r) => r.method === 'GET' && r.action !== 'access_denied')
        .map((r) => `${r.action} ${r.path}`),
      []
    );
    check(
      'but the cross-tenant read did, without the route opting in — a reach into another school is the one event activityLog records unconditionally (SRS §31 isolation case)',
      activities.some(
        (r) => r.action === 'access_denied' && (r.path || '').includes(`school_id=${fixtures.schoolB.id}`)
      ),
      true
    );
    check(
      'every activity row carries the request id that produced it',
      activities.every((r) => Boolean(r.request_id)),
      true
    );

    /* ═══════ A school creates logins — the owner's decisions D1 and D2 (docs/OWNER-DECISIONS.md) ═══════ */

    /*
     * After the activity assertions above, deliberately: those pin the exact set of rows the run wrote,
     * and this block writes more.
     */
    console.log('\n--- D1 / D2: a login for someone on record, and the Admin Limit ---');

    /*
     * In a school of its own, in an organization of its own: `verifyServiceScope()` runs after this and
     * counts the accounts in A1 and in Alpha, and the logins made here would move every one of those.
     */
    const orgC = await db.Organization.create({ name: 'Verify Users Gamma', code: 'VUR-GAMMA' });
    created.organizations.push(orgC.id);
    const schoolA = await db.School.create({ organization_id: orgC.id, name: 'Verify Users C1 School', code: 'VUR-C1' });
    created.schools.push(schoolA.id);
    const principalRole = await db.Role.findOne({ where: { slug: ROLES.PRINCIPAL } });
    const principalC = await db.User.create({
      role_id: principalRole.id, organization_id: orgC.id, school_id: schoolA.id, name: 'Verify C1 Principal',
      email: `cprincipal@${DOMAIN}`, username: 'vur_cprincipal', password_hash: await hashPassword(PASSWORD),
      status: USER_STATUS.ACTIVE, must_change_password: false,
    });
    created.users.push(principalC.id);
    const cPrincipal = await signIn(`cprincipal@${DOMAIN}`);
    /*
     * An `admin_limit` of 2. `usageService` counts the "Principals/Admins" tier — Principals and School
     * Admins together — so the fixture Principal is one of the two and exactly one School Admin fits.
     */
    const plan = await db.SubscriptionPlan.create({
      name: 'Verify Users Plan', code: 'VUR-PLAN', status: 'active', tier_rank: 1, trial_days: 0, grace_period_days: 7,
    });
    created.plans.push(plan.id);
    await db.PlanLimit.create({
      plan_id: plan.id, limit_key: LIMITS.ADMIN_LIMIT, limit_type: LIMIT_TYPES.FIXED, limit_value: 2,
    });
    const now = new Date();
    await db.Subscription.create({
      school_id: schoolA.id, organization_id: schoolA.organization_id, plan_id: plan.id,
      state: SUBSCRIPTION_STATES.ACTIVE, billing_cycle: 'monthly', cycle_days: 30, pricing_model: 'fixed',
      currency: 'USD', cycle_amount: 100, quantity: 1, starts_at: now, current_period_start: now,
      current_period_end: new Date(now.getTime() + 30 * 86400000), renewal_mode: 'manual',
    });
    await entitlementService.invalidateSchool(schoolA.id);

    const onRecord = { school_id: schoolA.id, organization_id: schoolA.organization_id };
    const teacherRecord = await db.Teacher.create({
      ...onRecord, employee_id: 'VUR-T1', first_name: 'Tariq', last_name: 'Aziz', joining_date: '2025-01-06',
    });
    const librarianRecord = await db.Staff.create({
      ...onRecord, employee_id: 'VUR-L1', first_name: 'Lina', joining_date: '2025-01-06',
      category: STAFF_CATEGORIES.LIBRARIAN,
    });
    const studentRecord = await db.Student.create({
      ...onRecord, student_id: 'VUR-S1', first_name: 'Sana', last_name: 'Iqbal', admission_date: '2025-04-01',
    });

    const loginFor = (body, token = cPrincipal) =>
      call('/users', { method: 'POST', token, body: { password: 'Verify-Login-2025!', ...body } });
    const track = (res) => {
      if (res.status === 201) created.users.push(dataOf(res).user.id);
      return res;
    };

    const teacherLogin = track(await loginFor({
      role: ROLES.TEACHER, profile_id: teacherRecord.id, email: `t-login@${DOMAIN}`, username: 'vur_t_login',
    }));
    const teacherUser = teacherLogin.status === 201 ? dataOf(teacherLogin).user : {};
    check('D1 — a Principal creates a login for a teacher on record',
      [teacherLogin.status, teacherUser.role && teacherUser.role.slug, teacherUser.name],
      [201, ROLES.TEACHER, 'Tariq Aziz']);
    check('  in the school, with a password that must be changed at first sign-in, and linked to the profile',
      [Number(teacherUser.school_id), teacherUser.must_change_password,
        Number((await teacherRecord.reload()).user_id)],
      [schoolA.id, true, Number(teacherUser.id)]);
    check('  and the temporary password really signs in',
      Boolean(await signIn(`t-login@${DOMAIN}`, 'Verify-Login-2025!')), true);

    const secondForTeacher = await loginFor({
      role: ROLES.TEACHER, profile_id: teacherRecord.id, email: `t-login2@${DOMAIN}`, username: 'vur_t_login2',
    });
    check('  a profile that already has a login is refused a second one',
      [secondForTeacher.status, codeOf(secondForTeacher)], [409, 'PROFILE_ALREADY_HAS_LOGIN']);

    const wrongCategory = await loginFor({
      role: ROLES.ACCOUNTANT, profile_id: librarianRecord.id, email: `l-acc@${DOMAIN}`, username: 'vur_l_acc',
    });
    check('  a staff login takes the role of the staff member\'s category, not the caller\'s choice',
      [wrongCategory.status, ((wrongCategory.body && wrongCategory.body.error && wrongCategory.body.error.details) || [])
        .map((d) => d.field)],
      [422, ['role']]);
    const librarianLogin = track(await loginFor({
      role: ROLES.LIBRARIAN, profile_id: librarianRecord.id, email: `l-login@${DOMAIN}`, username: 'vur_l_login',
    }));
    const studentLogin = track(await loginFor({
      role: ROLES.STUDENT, profile_id: studentRecord.id, email: `s-login@${DOMAIN}`, username: 'vur_s_login',
    }));
    check('  and the librarian and the student each get theirs',
      [librarianLogin.status, studentLogin.status], [201, 201]);

    const principalByHere = await loginFor({
      role: ROLES.PRINCIPAL, name: 'Another Principal', email: `p2@${DOMAIN}`, username: 'vur_p2',
    });
    const parentByHere = await loginFor({
      role: ROLES.PARENT, profile_id: 1, email: `par@${DOMAIN}`, username: 'vur_par',
    });
    check('  a Principal or a Parent is refused — each keeps the one creation path the SRS gives it',
      [principalByHere.status, parentByHere.status], [422, 422]);

    const byTeacher = await loginFor({
      role: ROLES.SCHOOL_ADMIN, name: 'Not Allowed', email: `na@${DOMAIN}`, username: 'vur_na',
    }, tokens.teacher);
    check('  a teacher, who lacks users.manage, cannot create a login at all', byTeacher.status, 403);

    const foreignProfile = await loginFor({
      role: ROLES.TEACHER, profile_id: teacherRecord.id, email: `f@${DOMAIN}`, username: 'vur_f',
    }, tokens.principal);
    check('  nor can another school link one to this school\'s teacher',
      [foreignProfile.status, ((foreignProfile.body && foreignProfile.body.error && foreignProfile.body.error.details) || [])
        .map((d) => d.field)],
      [422, ['profile_id']]);

    /* D2 — the Principal is one of the two; one School Admin fits and the next does not. */
    const firstAdmin = track(await loginFor({
      role: ROLES.SCHOOL_ADMIN, name: 'First Admin', email: `adm1@${DOMAIN}`, username: 'vur_adm1',
    }));
    const secondAdmin = track(await loginFor({
      role: ROLES.SCHOOL_ADMIN, name: 'Second Admin', email: `adm2@${DOMAIN}`, username: 'vur_adm2',
    }));
    check('D2 — a School Admin login fits within the Admin Limit (the Principal is the other of two)',
      firstAdmin.status, 201);
    check('  and the next is refused by the limit, not by anything else',
      [secondAdmin.status, codeOf(secondAdmin)], [403, 'PLAN_LIMIT_EXCEEDED']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ═══════════════════════════ part 4 — the service, directly ═══════════════════════════ */

/**
 * The layer-4 rule `enforceTenant` hides.
 *
 * Over HTTP, `?school_id=<another school>` never reaches the service: layer 3 refuses it with
 * `CROSS_TENANT_ACCESS_DENIED`, which is asserted above. The service's own refusal to let a filter
 * widen an already-pinned scope is therefore only reachable from here — and it has to exist, because
 * the four layers are independent by design and a caller who reached the service another way would
 * otherwise widen their scope with a query parameter.
 */
async function verifyServiceScope() {
  console.log('\n--- the service own scope rule, below enforceTenant ---');

  const schoolTenant = { isPlatform: false, schoolId: fixtures.schoolA.id, organizationId: fixtures.orgA.id };
  const pagination = { page: 1, limit: 100, offset: 0 };
  const req = { query: {} };

  const own = await usersService.list(schoolTenant, {}, pagination, req);
  check(
    'a school-scoped call sees its own school',
    own.rows.every((u) => Number(u.school_id) === fixtures.schoolA.id),
    true
  );
  check('and finds both accounts there', own.count, 2);

  const widened = await usersService.list(
    schoolTenant,
    { school_id: fixtures.schoolB.id },
    pagination,
    req
  );
  check(
    'a filter naming another school returns nothing rather than replacing the pinned scope',
    [widened.count, widened.rows.length],
    [0, 0]
  );

  /*
   * A school-scoped caller has no `organization_id` in the built WHERE — `tenantWhere` returns on the
   * first pinned column — so this filter is ANDed onto `school_id` rather than compared against a
   * pinned value. The result is empty either way, but by intersection, not by the widening refusal.
   * The refusal itself is reachable one level up, where `organization_id` *is* what got pinned.
   */
  const widenedOrgFromSchool = await usersService.list(
    schoolTenant,
    { organization_id: fixtures.orgB.id },
    pagination,
    req
  );
  check(
    'a school-scoped caller naming another organization gets nothing — school_id AND organization_id cannot both match',
    widenedOrgFromSchool.count,
    0
  );

  const orgTenant = { isPlatform: false, schoolId: null, organizationId: fixtures.orgA.id };
  const widenedOrg = await usersService.list(
    orgTenant,
    { organization_id: fixtures.orgB.id },
    pagination,
    req
  );
  check(
    'and an organization-scoped caller naming another organization hits the same refusal as the school case',
    [widenedOrg.count, widenedOrg.rows.length],
    [0, 0]
  );
  check(
    'while naming their own is a no-op — the org admin, the A1 Principal and the A1 Teacher',
    (await usersService.list(orgTenant, { organization_id: fixtures.orgA.id }, pagination, req)).count,
    3
  );

  const narrowed = await usersService.list(
    schoolTenant,
    { school_id: fixtures.schoolA.id },
    pagination,
    req
  );
  check('while a filter naming the pinned school is a no-op, not a refusal', narrowed.count, 2);

  const platformTenant = { isPlatform: true, schoolId: null, organizationId: null };
  const platformFiltered = await usersService.list(
    platformTenant,
    { school_id: fixtures.schoolB.id },
    pagination,
    req
  );
  check(
    'a platform caller has no pinned scope, so the same filter narrows instead of being refused',
    platformFiltered.rows.map((u) => Number(u.school_id)),
    [fixtures.schoolB.id]
  );

  const unknownRole = await usersService.list(platformTenant, { role: 'nonexistent' }, pagination, req);
  check(
    'a role slug with no row matches nobody — the truthful answer, rather than a 404 claiming the endpoint was wrong',
    [unknownRole.count, unknownRole.rows.length],
    [0, 0]
  );
}

/* ═══════════════════════════ the run ═══════════════════════════ */

async function main() {
  verifyUserSchemas();
  verifyRoleSchemas();
  verifyRouting();

  console.log('\n--- fixtures ---');
  await recoverFromDeadRun();
  check('the log tables are baselined before anything is written', await captureBaseline(), true);
  check('five users, two organizations and two schools created', await createFixtures(), 5);
  /* Both seeded rows are captured and not yet mutated — the moment the journal is true. */
  writeJournal(JOURNAL, seeded);
  check(
    'and the seeded rows this run mutates were captured for restoration',
    [seeded.principalGrants.length, typeof seeded.librarianLabels.name],
    [DEFAULT_ROLE_PERMISSIONS[ROLES.PRINCIPAL].length, 'string']
  );

  await verifyHttp();
  await verifyServiceScope();
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nVerification aborted:', err);
  })
  .finally(async () => {
    try {
      await removeFixtures();
      console.log('\nFixtures removed, and the two seeded roles put back.');

      /* The restore is asserted, not assumed — an abort mid-run must still leave the roles as found. */
      const principalKeys = await permissionService.getRolePermissions(
        fixtures.roles[ROLES.PRINCIPAL].id
      );
      check(
        'the principal role holds its seeded grants again',
        principalKeys.slice().sort(),
        DEFAULT_ROLE_PERMISSIONS[ROLES.PRINCIPAL].slice().sort()
      );
      const librarian = await db.Role.findByPk(fixtures.roles[ROLES.LIBRARIAN].id);
      check('and the librarian labels are back', librarian.name, seeded.librarianLabels.name);
    } catch (err) {
      failures += 1;
      console.error('Fixture cleanup failed:', err.message);
    }
    console.log(
      failures === 0
        ? '\nAll users/roles module checks passed.'
        : `\n${failures} check(s) FAILED.`
    );
    await db.sequelize.close();
    process.exit(failures === 0 ? 0 : 1);
  });
