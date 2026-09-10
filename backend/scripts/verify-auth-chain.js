'use strict';

/**
 * End-to-end verification of the authentication and isolation chain, over real HTTP, with real
 * JWTs, against the real database.
 *
 *   requestContext → sanitizeRequest → authenticate → resolveTenant → enforceTenant
 *                  → requireRole / requirePermission → route → errorHandler
 *
 * The case that matters most is SRS §8's critical test scenario: a Principal at School A calling a
 * School B endpoint must get 403 and no data. It is checked here in every shape the id can arrive
 * in — route parameter, query string, JSON body, and nested inside an array in a bulk payload.
 *
 * Fixtures are created with a `VERIFY-` code prefix and a `@verify.invalid` email domain, and are
 * removed in a `finally` block. Nothing outside those prefixes is touched.
 *
 * Run: node scripts/verify-auth-chain.js
 */

const express = require('express');

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const { cache } = require('../src/config/cache');
const { requestContext } = require('../src/middlewares/requestContext');
const { sanitizeRequest } = require('../src/middlewares/sanitize');
const { authenticate, enforcePasswordChange } = require('../src/middlewares/authenticate');
const { resolveTenant } = require('../src/middlewares/resolveTenant');
const { enforceTenant } = require('../src/middlewares/enforceTenant');
const {
  requireRole,
  requirePermission,
  requireAnyPermission,
  requirePlatformScope,
} = require('../src/middlewares/authorize');
const { errorHandler, notFoundHandler } = require('../src/middlewares/errorHandler');
const { validate, commonSchemas } = require('../src/middlewares/validate');
const { createRouter } = require('../src/utils/createRouter');
const { ROLES, USER_STATUS, SCHOOL_STATUS, ORGANIZATION_STATUS } = require('../src/config/constants');
const { hashPassword, signAccessToken, signRefreshToken, accessTokenPayload } = require('../src/utils/tokens');

const CODE_PREFIX = 'VERIFY-';
const EMAIL_DOMAIN = '@verify.invalid';

let failures = 0;
const created = { users: [], schools: [], organizations: [] };

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${ok ? '' : `  (expected ${JSON.stringify(expected)})`}`
  );
}

/* ─────────────────────────────── fixtures ─────────────────────────────── */

async function buildFixtures() {
  /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
  const residueCleared = await sweepResidue(db, { codes: ['VERIFY-ORG', 'VERIFY-SCH'], domains: ['verify.invalid'] });
  if (residueCleared) {
    console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
  }
  const roles = await db.Role.findAll({ attributes: ['id', 'slug'], raw: true });
  const roleId = Object.fromEntries(roles.map((r) => [r.slug, r.id]));

  /* Hashed once — bcrypt at the configured cost is slow enough to dominate this script otherwise. */
  const passwordHash = await hashPassword('Verify-Only-Never-Used-1!');

  const orgOne = await db.Organization.create({
    name: 'Verify Org One',
    code: `${CODE_PREFIX}ORG1`,
    status: ORGANIZATION_STATUS.ACTIVE,
  });
  const orgTwo = await db.Organization.create({
    name: 'Verify Org Two',
    code: `${CODE_PREFIX}ORG2`,
    status: ORGANIZATION_STATUS.ACTIVE,
  });
  const orgSuspended = await db.Organization.create({
    name: 'Verify Org Suspended',
    code: `${CODE_PREFIX}ORG3`,
    status: ORGANIZATION_STATUS.SUSPENDED,
  });
  created.organizations.push(orgOne.id, orgTwo.id, orgSuspended.id);

  const schoolA = await db.School.create({
    organization_id: orgOne.id,
    name: 'Verify School A',
    code: `${CODE_PREFIX}SCHA`,
    status: SCHOOL_STATUS.ACTIVE,
  });
  const schoolB = await db.School.create({
    organization_id: orgOne.id,
    name: 'Verify School B',
    code: `${CODE_PREFIX}SCHB`,
    status: SCHOOL_STATUS.ACTIVE,
  });
  const schoolC = await db.School.create({
    organization_id: orgTwo.id,
    name: 'Verify School C',
    code: `${CODE_PREFIX}SCHC`,
    status: SCHOOL_STATUS.ACTIVE,
  });
  const schoolSuspended = await db.School.create({
    organization_id: orgOne.id,
    name: 'Verify School Suspended',
    code: `${CODE_PREFIX}SCHS`,
    status: SCHOOL_STATUS.SUSPENDED,
  });
  const schoolInSuspendedOrg = await db.School.create({
    organization_id: orgSuspended.id,
    name: 'Verify School In Suspended Org',
    code: `${CODE_PREFIX}SCHO`,
    status: SCHOOL_STATUS.ACTIVE,
  });
  created.schools.push(
    schoolA.id,
    schoolB.id,
    schoolC.id,
    schoolSuspended.id,
    schoolInSuspendedOrg.id
  );

  async function makeUser(key, attrs) {
    const user = await db.User.create({
      name: `Verify ${key}`,
      email: `${key.toLowerCase()}${EMAIL_DOMAIN}`,
      username: `verify_${key.toLowerCase()}`,
      password_hash: passwordHash,
      status: USER_STATUS.ACTIVE,
      must_change_password: false,
      ...attrs,
    });
    created.users.push(user.id);
    return user;
  }

  const users = {
    superAdmin: await makeUser('superadmin', { role_id: roleId[ROLES.SUPER_ADMIN] }),
    orgAdmin: await makeUser('orgadmin', {
      role_id: roleId[ROLES.ORGANIZATION_ADMIN],
      organization_id: orgOne.id,
    }),
    principalA: await makeUser('principalA', {
      role_id: roleId[ROLES.PRINCIPAL],
      organization_id: orgOne.id,
      school_id: schoolA.id,
    }),
    principalB: await makeUser('principalB', {
      role_id: roleId[ROLES.PRINCIPAL],
      organization_id: orgOne.id,
      school_id: schoolB.id,
    }),
    teacherA: await makeUser('teacherA', {
      role_id: roleId[ROLES.TEACHER],
      organization_id: orgOne.id,
      school_id: schoolA.id,
    }),
    studentA: await makeUser('studentA', {
      role_id: roleId[ROLES.STUDENT],
      organization_id: orgOne.id,
      school_id: schoolA.id,
    }),
    /* Fail-closed case: a school-level role with no school. */
    orphan: await makeUser('orphan', { role_id: roleId[ROLES.PRINCIPAL] }),
    suspendedSchool: await makeUser('suspschool', {
      role_id: roleId[ROLES.PRINCIPAL],
      organization_id: orgOne.id,
      school_id: schoolSuspended.id,
    }),
    suspendedOrgSchool: await makeUser('susporg', {
      role_id: roleId[ROLES.PRINCIPAL],
      organization_id: orgSuspended.id,
      school_id: schoolInSuspendedOrg.id,
    }),
    inactive: await makeUser('inactive', {
      role_id: roleId[ROLES.PRINCIPAL],
      organization_id: orgOne.id,
      school_id: schoolA.id,
      status: USER_STATUS.INACTIVE,
    }),
    suspendedUser: await makeUser('suspuser', {
      role_id: roleId[ROLES.PRINCIPAL],
      organization_id: orgOne.id,
      school_id: schoolA.id,
      status: USER_STATUS.SUSPENDED,
    }),
    locked: await makeUser('locked', {
      role_id: roleId[ROLES.PRINCIPAL],
      organization_id: orgOne.id,
      school_id: schoolA.id,
      locked_until: new Date(Date.now() + 60 * 60 * 1000),
    }),
    mustChange: await makeUser('mustchange', {
      role_id: roleId[ROLES.PRINCIPAL],
      organization_id: orgOne.id,
      school_id: schoolA.id,
      must_change_password: true,
    }),
    /* FR-SEC-006: a token minted before this timestamp must be refused. */
    rotated: await makeUser('rotated', {
      role_id: roleId[ROLES.PRINCIPAL],
      organization_id: orgOne.id,
      school_id: schoolA.id,
      password_changed_at: new Date(Date.now() + 5 * 60 * 1000),
    }),
    deniedGrant: await makeUser('denied', {
      role_id: roleId[ROLES.PRINCIPAL],
      organization_id: orgOne.id,
      school_id: schoolA.id,
      denied_permissions: ['students.view'],
    }),
    extraGrant: await makeUser('extra', {
      role_id: roleId[ROLES.TEACHER],
      organization_id: orgOne.id,
      school_id: schoolA.id,
      extra_permissions: ['students.manage'],
    }),
  };

  return {
    roleId,
    orgs: { one: orgOne, two: orgTwo, suspended: orgSuspended },
    schools: {
      a: schoolA,
      b: schoolB,
      c: schoolC,
      suspended: schoolSuspended,
      inSuspendedOrg: schoolInSuspendedOrg,
    },
    users,
  };
}

async function dropFixtures() {
  /* Order matters: `schools.principal_id` and `users.school_id` reference each other. */
  if (created.schools.length) {
    await db.School.update({ principal_id: null }, { where: { id: created.schools } });
  }
  if (created.users.length) {
    await db.User.destroy({ where: { id: created.users }, force: true });
  }
  if (created.schools.length) {
    await db.School.destroy({ where: { id: created.schools }, force: true });
  }
  if (created.organizations.length) {
    await db.Organization.destroy({ where: { id: created.organizations }, force: true });
  }
  await cache.flush();
}

/* ─────────────────────────────── test app ─────────────────────────────── */

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use(sanitizeRequest);

  const api = createRouter();
  api.use(authenticate);
  api.use(resolveTenant);
  api.use(enforceTenant);

  /* Echoes the resolved scope, so a leak would be visible in the response rather than inferred. */
  api.get('/whoami', (req, res) =>
    res.json({ success: true, data: { userId: req.user.id, tenant: req.tenant } })
  );

  api.get('/schools/:schoolId/students', (req, res) =>
    res.json({ success: true, data: { schoolId: req.params.schoolId } })
  );
  /* A non-numeric segment after `schools` is a sub-route, not an id, and must stay reachable. */
  api.get('/schools/export', (req, res) => res.json({ success: true, data: 'export' }));
  /*
   * No `schools` segment, so the path scan cannot recognise the id by position. Only the
   * `router.param()` guard can refuse this one — which is what makes it worth testing separately.
   */
  api.get('/campus/:schoolId/report', (req, res) =>
    res.json({ success: true, data: { schoolId: req.params.schoolId } })
  );
  /* A nested router: proves the factory's guards are installed per router, not inherited. */
  const nested = createRouter();
  nested.get('/:schoolId/timetable', (req, res) =>
    res.json({ success: true, data: { schoolId: req.params.schoolId } })
  );
  api.use('/branch', nested);
  api.get('/students', (req, res) => res.json({ success: true, data: { query: req.query } }));
  api.post('/students', (req, res) => res.json({ success: true, data: { body: req.body } }));
  api.post('/students/bulk', (req, res) => res.json({ success: true, data: { count: (req.body.students || []).length } }));

  api.get('/principal-only', requireRole(ROLES.PRINCIPAL), (req, res) =>
    res.json({ success: true, data: 'ok' })
  );
  api.get('/students-view', requirePermission('students.view'), (req, res) =>
    res.json({ success: true, data: 'ok' })
  );
  api.post('/students-create', requirePermission('students.manage'), (req, res) =>
    res.json({ success: true, data: 'ok' })
  );
  api.get(
    '/students-any',
    requireAnyPermission('students.view', 'students.self.view'),
    (req, res) => res.json({ success: true, data: 'ok' })
  );
  api.get('/platform', requirePlatformScope(), (req, res) =>
    res.json({ success: true, data: 'ok' })
  );

  /* Ordered as production will be: the tenant check precedes route-level validation. */
  api.post(
    '/validated',
    validate({ body: commonSchemas.idParam }),
    (req, res) => res.json({ success: true, data: req.body })
  );

  /* Mounted on its own sub-router so the password gate does not block the whole suite. */
  const gated = express.Router();
  gated.use(authenticate);
  gated.use(enforcePasswordChange({ allow: ['/auth/change-password'] }));
  gated.get('/anything', (req, res) => res.json({ success: true, data: 'ok' }));
  gated.get('/auth/change-password', (req, res) => res.json({ success: true, data: 'allowed' }));

  app.use('/api/v1', api);
  app.use('/gated', gated);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/* ─────────────────────────────── driver ─────────────────────────────── */

async function main() {
  const fixtures = await buildFixtures();
  const app = buildApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Mint a genuine access token for a fixture user. */
  function tokenFor(user) {
    return signAccessToken(accessTokenPayload({ ...user.get(), role: user.role || null }));
  }

  /* Roles were not eager-loaded on create, so attach them for the payload builder. */
  for (const user of Object.values(fixtures.users)) {
    // eslint-disable-next-line no-await-in-loop
    user.role = await db.Role.findByPk(user.role_id);
  }

  async function call(path, { user, method = 'GET', body, token, headers } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(user ? { Authorization: `Bearer ${tokenFor(user)}` } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    return { status: res.status, body: payload, code: payload && payload.error && payload.error.code };
  }

  const { users, schools, orgs } = fixtures;

  console.log('\n--- authenticate ---');
  {
    const r = await call('/api/v1/whoami');
    check('no token -> 401', r.status, 401);
    check('no token code', r.code, 'TOKEN_MISSING');
  }
  check('garbage token -> 401', (await call('/api/v1/whoami', { token: 'not.a.jwt' })).status, 401);
  check(
    'wrong scheme -> 401',
    (await call('/api/v1/whoami', { headers: { Authorization: 'Basic abc' } })).code,
    'TOKEN_MISSING'
  );
  {
    /* A refresh token must never authenticate a request, even though it is a valid JWT. */
    const r = await call('/api/v1/whoami', { token: signRefreshToken(users.principalA.id) });
    check('refresh token -> 401', r.status, 401);
    check('refresh token code', r.code, 'TOKEN_INVALID');
  }
  {
    const r = await call('/api/v1/whoami', { user: users.principalA });
    check('valid token -> 200', r.status, 200);
    check('resolved school scope', r.body.data.tenant.schoolId, schools.a.id);
    check('resolved org from the school row', r.body.data.tenant.organizationId, orgs.one.id);
    check('level', r.body.data.tenant.level, 'school');
    check('not platform', r.body.data.tenant.isPlatform, false);
  }
  check('inactive account -> 403', (await call('/api/v1/whoami', { user: users.inactive })).code, 'ACCOUNT_INACTIVE');
  check('suspended account -> 403', (await call('/api/v1/whoami', { user: users.suspendedUser })).code, 'ACCOUNT_SUSPENDED');
  check('locked account -> 403', (await call('/api/v1/whoami', { user: users.locked })).code, 'ACCOUNT_LOCKED');
  check('token older than password change -> 401', (await call('/api/v1/whoami', { user: users.rotated })).code, 'TOKEN_STALE');
  {
    const deleted = await db.User.create({
      name: 'Verify Ghost',
      email: `ghost${EMAIL_DOMAIN}`,
      username: 'verify_ghost',
      password_hash: users.principalA.password_hash || 'x',
      role_id: users.principalA.role_id,
      school_id: schools.a.id,
      organization_id: orgs.one.id,
      status: USER_STATUS.ACTIVE,
    });
    deleted.role = users.principalA.role;
    const ghostToken = signAccessToken(accessTokenPayload({ ...deleted.get(), role: deleted.role }));
    await deleted.destroy({ force: true });
    check('token for a deleted user -> 401', (await call('/api/v1/whoami', { token: ghostToken })).code, 'ACCOUNT_NOT_FOUND');
  }

  console.log('\n--- resolveTenant ---');
  {
    const r = await call('/api/v1/whoami', { user: users.superAdmin });
    check('super admin is platform scope', r.body.data.tenant.isPlatform, true);
    check('super admin has no school', r.body.data.tenant.schoolId, null);
    check('super admin has no org', r.body.data.tenant.organizationId, null);
  }
  {
    const r = await call('/api/v1/whoami', { user: users.orgAdmin });
    check('org admin is not platform', r.body.data.tenant.isPlatform, false);
    check('org admin level', r.body.data.tenant.level, 'organization');
    check('org admin org', r.body.data.tenant.organizationId, orgs.one.id);
    check('org admin has no school', r.body.data.tenant.schoolId, null);
  }
  check('school-level user with no school -> 403', (await call('/api/v1/whoami', { user: users.orphan })).code, 'TENANT_UNRESOLVED');
  check('suspended school -> 403', (await call('/api/v1/whoami', { user: users.suspendedSchool })).code, 'SCHOOL_SUSPENDED');
  check('school in suspended org -> 403', (await call('/api/v1/whoami', { user: users.suspendedOrgSchool })).code, 'ORGANIZATION_SUSPENDED');

  console.log('\n--- enforceTenant: SRS §8 critical scenario ---');
  {
    const own = await call(`/api/v1/schools/${schools.a.id}/students`, { user: users.principalA });
    check('own school in the URL -> 200', own.status, 200);

    const other = await call(`/api/v1/schools/${schools.b.id}/students`, { user: users.principalA });
    check('School B in the URL -> 403', other.status, 403);
    check('code', other.code, 'CROSS_TENANT_ACCESS_DENIED');
    check('no data returned', other.body.data, undefined);
    check('refusal names the position, not the id', other.body.error.details.field, 'schools/:id');
    /*
     * `requestId` is a random token that can itself contain the id's digits, so it is excluded —
     * otherwise this assertion would fail at random.
     */
    const echoed = JSON.stringify({ ...other.body.error, requestId: undefined });
    check('response does not echo School B’s id', echoed.includes(String(schools.b.id)), false);
  }
  check(
    'School B in the query string -> 403',
    (await call(`/api/v1/students?school_id=${schools.b.id}`, { user: users.principalA })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );

  /* Both URL mechanisms, proven separately. */
  check(
    'zero-padded School B id in the URL -> 403',
    (await call(`/api/v1/schools/000${schools.b.id}/students`, { user: users.principalA })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );
  check(
    'URL-encoded School B id in the URL -> 403',
    (await call(`/api/v1/scho%6Fls/${schools.b.id}/students`, { user: users.principalA })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );
  check(
    'param guard catches an id the path scan cannot place -> 403',
    (await call(`/api/v1/campus/${schools.b.id}/report`, { user: users.principalA })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );
  check(
    'own school through the param guard -> 200',
    (await call(`/api/v1/campus/${schools.a.id}/report`, { user: users.principalA })).status,
    200
  );
  check(
    'nested router param guard -> 403',
    (await call(`/api/v1/branch/${schools.b.id}/timetable`, { user: users.principalA })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );
  check(
    'nested router, own school -> 200',
    (await call(`/api/v1/branch/${schools.a.id}/timetable`, { user: users.principalA })).status,
    200
  );
  check(
    'a non-numeric sub-route under /schools stays reachable',
    (await call('/api/v1/schools/export', { user: users.principalA })).status,
    200
  );

  check(
    'School B in the query string -> 403',
    (await call(`/api/v1/students?school_id=${schools.b.id}`, { user: users.principalA })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );
  check(
    'own school in the query string -> 200',
    (await call(`/api/v1/students?school_id=${schools.a.id}`, { user: users.principalA })).status,
    200
  );
  check(
    'camelCase schoolId -> 403',
    (await call(`/api/v1/students?schoolId=${schools.b.id}`, { user: users.principalA })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );
  check(
    'mixed-case School_ID -> 403',
    (await call(`/api/v1/students?School_ID=${schools.b.id}`, { user: users.principalA })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );
  check(
    'School B in the JSON body -> 403',
    (await call('/api/v1/students', { user: users.principalA, method: 'POST', body: { name: 'X', school_id: schools.b.id } })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );
  check(
    'School B nested in a bulk array -> 403',
    (await call('/api/v1/students/bulk', {
      user: users.principalA,
      method: 'POST',
      body: { students: [{ name: 'A', school_id: schools.a.id }, { name: 'B', school_id: schools.b.id }] },
    })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );
  check(
    'own school throughout a bulk array -> 200',
    (await call('/api/v1/students/bulk', {
      user: users.principalA,
      method: 'POST',
      body: { students: [{ name: 'A', school_id: schools.a.id }, { name: 'B', school_id: schools.a.id }] },
    })).status,
    200
  );
  check(
    'array of school ids, one foreign -> 403',
    (await call(`/api/v1/students?school_id[]=${schools.a.id}&school_id[]=${schools.b.id}`, { user: users.principalA })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );
  check(
    'another organization -> 403',
    (await call(`/api/v1/students?organization_id=${orgs.two.id}`, { user: users.principalA })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );
  check(
    'own organization -> 200',
    (await call(`/api/v1/students?organization_id=${orgs.one.id}`, { user: users.principalA })).status,
    200
  );
  check(
    'operator object on school_id -> 400',
    (await call(`/api/v1/students?school_id[gt]=1`, { user: users.principalA })).code,
    'INVALID_TENANT_REFERENCE'
  );
  check(
    'empty school_id ignored',
    (await call('/api/v1/students?school_id=', { user: users.principalA })).status,
    200
  );
  check(
    'a nonexistent school id is still 403, not 404',
    (await call('/api/v1/students?school_id=99999999', { user: users.principalA })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );
  check(
    'tenant check precedes validate()',
    (await call('/api/v1/validated', { user: users.principalA, method: 'POST', body: { id: 1, school_id: schools.b.id } })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );

  console.log('\n--- enforceTenant: organization scope ---');
  check(
    'org admin may name a school inside its org',
    (await call(`/api/v1/schools/${schools.a.id}/students`, { user: users.orgAdmin })).status,
    200
  );
  check(
    'org admin may name the other school in its org',
    (await call(`/api/v1/schools/${schools.b.id}/students`, { user: users.orgAdmin })).status,
    200
  );
  check(
    'org admin may not reach another org’s school',
    (await call(`/api/v1/schools/${schools.c.id}/students`, { user: users.orgAdmin })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );
  check(
    'org admin may not name another organization',
    (await call(`/api/v1/students?organization_id=${orgs.two.id}`, { user: users.orgAdmin })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );

  console.log('\n--- enforceTenant: platform scope ---');
  check(
    'super admin may read School A',
    (await call(`/api/v1/schools/${schools.a.id}/students`, { user: users.superAdmin })).status,
    200
  );
  check(
    'super admin may read School C in another org',
    (await call(`/api/v1/schools/${schools.c.id}/students`, { user: users.superAdmin })).status,
    200
  );
  check(
    'super admin may read a suspended school (FR-SADMIN-005 reversal)',
    (await call(`/api/v1/schools/${schools.suspended.id}/students`, { user: users.superAdmin })).status,
    200
  );

  console.log('\n--- authorize ---');
  check('principal passes requireRole', (await call('/api/v1/principal-only', { user: users.principalA })).status, 200);
  {
    const r = await call('/api/v1/principal-only', { user: users.teacherA });
    check('teacher fails requireRole', r.status, 403);
    check('code', r.code, 'INSUFFICIENT_ROLE');
    check('required roles named', r.body.error.details.requiredRoles, ['principal']);
  }
  check('principal has students.view', (await call('/api/v1/students-view', { user: users.principalA })).status, 200);
  {
    const r = await call('/api/v1/students-view', { user: users.studentA });
    check('student lacks students.view', r.status, 403);
    check('code', r.code, 'INSUFFICIENT_PERMISSION');
    check('missing key named', r.body.error.details.missing, ['students.view']);
  }
  check(
    'denied_permissions overrides the role grant',
    (await call('/api/v1/students-view', { user: users.deniedGrant })).code,
    'INSUFFICIENT_PERMISSION'
  );
  check(
    'extra_permissions grants beyond the role',
    (await call('/api/v1/students-create', { user: users.extraGrant, method: 'POST' })).status,
    200
  );
  check(
    'teacher without the grant is refused',
    (await call('/api/v1/students-create', { user: users.teacherA, method: 'POST' })).code,
    'INSUFFICIENT_PERMISSION'
  );
  check(
    'student satisfies requireAnyPermission via the self variant',
    (await call('/api/v1/students-any', { user: users.studentA })).status,
    200
  );
  check('super admin passes requirePlatformScope', (await call('/api/v1/platform', { user: users.superAdmin })).status, 200);
  check(
    'principal fails requirePlatformScope',
    (await call('/api/v1/platform', { user: users.principalA })).code,
    'PLATFORM_SCOPE_REQUIRED'
  );

  console.log('\n--- boot-time guards ---');
  {
    let message;
    try {
      requirePermission('studnets.view');
    } catch (err) {
      message = err.message;
    }
    check('mistyped permission key throws at definition', /unknown permission key\(s\) studnets\.view/.test(message || ''), true);

    let roleMessage;
    try {
      requireRole('principle');
    } catch (err) {
      roleMessage = err.message;
    }
    check('mistyped role slug throws at definition', /unknown role slug\(s\) principle/.test(roleMessage || ''), true);
  }

  console.log('\n--- enforcePasswordChange ---');
  check('forced change blocks normal routes', (await call('/gated/anything', { user: users.mustChange })).code, 'PASSWORD_CHANGE_REQUIRED');
  check('forced change allows the change route', (await call('/gated/auth/change-password', { user: users.mustChange })).status, 200);
  check('unaffected user passes', (await call('/gated/anything', { user: users.principalA })).status, 200);

  console.log('\n--- envelope and plumbing ---');
  {
    const res = await fetch(`${base}/api/v1/whoami`);
    check('X-Request-Id is echoed', /^[A-Za-z0-9._~-]{8,64}$/.test(res.headers.get('x-request-id') || ''), true);
    const body = await res.json();
    check('failure envelope shape', Object.keys(body).sort(), ['error', 'success']);
    check('requestId in the error body', typeof body.error.requestId, 'string');
  }
  check('unmatched route -> 404', (await call('/api/v1/nope', { user: users.principalA })).code, 'ROUTE_NOT_FOUND');

  await new Promise((resolve) => server.close(resolve));
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nVerification aborted:', err);
  })
  .finally(async () => {
    await dropFixtures();
    console.log(failures === 0 ? '\nAll auth-chain checks passed.' : `\n${failures} check(s) FAILED.`);
    await db.sequelize.close();
    process.exit(failures === 0 ? 0 : 1);
  });
