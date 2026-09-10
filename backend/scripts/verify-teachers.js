'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *
 *   RATE_LIMIT_MAX       raised past what this script needs; the limiter is not under test here.
 *   AUTH_RATE_LIMIT_MAX  a stray refusal must not colour a run that is almost entirely authenticated.
 *   BCRYPT_ROUNDS=10     fixtures hash one password; pinned so the value never comes from the local .env.
 *   PASSWORD_MIN_LENGTH  pinned for the same reason.
 *   MAIL_DRIVER=log      no mail is sent, but a stray SMTP attempt would hang the run.
 *   CACHE_TTL=600        pinned deliberately — see the note on the entitlement assertions below.
 */
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.BCRYPT_ROUNDS = '10';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';
process.env.CACHE_TTL = '600';

/**
 * Verification of Phase 3.J teachers — `src/modules/teachers/*` — SRS §15.3,
 * FR-TEACHER-001 and FR-TEACHER-002.
 *
 * This is the first module in the project behind an **entitlement guard**, so the assertions that
 * matter most are not the CRUD ones:
 *
 *   - `requireModule('teachers')` — a school on a plan without the Teachers module is refused, and a
 *     school with no subscription at all is refused differently (`SUBSCRIPTION_INACTIVE`, not
 *     `MODULE_NOT_SUBSCRIBED`). Both are asserted, because collapsing them would hide which of the
 *     two guards is actually running.
 *   - `enforceLimit('teacher_limit')` — §11.2's ceiling. For a headcount limit it counts **live**
 *     (`getUsage` → `countHeadcount`, `usageService.js:276-277`), so it does not read
 *     `usage_records`. It is mounted on `POST /` only, which is why the reactivation case below
 *     exists: `teacher_limit` counts `is_active: true`, so a `PATCH` that flips the flag back is a
 *     limit event the route guard cannot see, and the service has to assert it.
 *   - `usageService.syncHeadcount` — maintains the `usage_records` **mirror**, which is reporting
 *     data (§9.1 dashboard, §13 overage lines), not the enforcement path. Asserted by reading the
 *     row back and by proving the figure falls when a teacher is deactivated.
 *
 * `CACHE_TTL=600` is pinned so the entitlement snapshot cannot refresh by expiry between the write
 * and the read — an assertion that passes because a 60-second TTL lapsed would prove nothing.
 *
 * Part 1 — request schemas, directly (no database).
 * Part 2 — the declared route table and the router-level guard.
 * Part 3 — over real HTTP against the real database.
 *
 * Run: node scripts/verify-teachers.js
 */

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');

const teacherRoutes = require('../src/modules/teachers/teachers.routes');
const { schemas } = require('../src/modules/teachers/teachers.validation');
const { settleDistinct } = require('./lib/settle');

const {
  ROLES,
  USER_STATUS,
  MODULES,
  MODULE_LIST,
  LIMITS,
  LIMIT_TYPES,
  PLAN_STATUS,
  SUBSCRIPTION_STATES,
  BILLING_CYCLES,
} = require('../src/config/constants');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-teachers.local';
const PASSWORD = 'Verify@Teachers123';
const CODE_PREFIX = 'VTE-';

let failures = 0;
let dbSkipped = false;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${
      ok ? '' : `  (expected ${JSON.stringify(expected)})`
    }`
  );
}

const VALIDATE_OPTIONS = { abortEarly: false, convert: true, stripUnknown: true };

function run(schema, value) {
  const { error, value: cleaned } = schema.validate(value, VALIDATE_OPTIONS);
  return { ok: !error, value: cleaned, messages: error ? error.details.map((d) => d.message) : [] };
}

function routesOf(router) {
  return router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
}

function named(router, method, path, fnName) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer ? layer.route.stack.some((s) => s.handle.name === fnName) : null;
}

/* ═══════════════════════════ part 1 — request schemas ═══════════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas ──\n');

  const minimal = run(schemas.create, {
    employee_id: 'T-1',
    first_name: 'Asha',
    joining_date: '2024-01-15',
  });
  check('the three required fields are enough to create', minimal.ok, true);

  check(
    'employee_id is required',
    run(schemas.create, { first_name: 'Asha', joining_date: '2024-01-15' }).ok,
    false
  );
  /* ── Known Issues #26 — photo_path is no longer a caller-supplied string ── */

  check(
    'a body-supplied photo_path is REFUSED on create, not stripped',
    (() => {
      const r = schemas.create.validate(
        { employee_id: 'T-1', first_name: 'Asha', joining_date: '2024-01-15', photo_path: '../../etc/passwd' },
        VALIDATE_OPTIONS
      );
      return [Boolean(r.error), r.error ? r.error.details.map((d) => d.path.join('.')) : []];
    })(),
    [true, ['photo_path']]
  );
  /*
   * `first_name` is co-submitted because `schemas.update` ends in `.min(1)`: an object holding only a
   * forbidden key is rejected for being EMPTY after strip, so without a legitimate field this would
   * pass with the `forbidden()` deleted.
   */
  check(
    '  and on patch, where only forbidden() can produce the refusal',
    run(schemas.update, { first_name: 'Asha', photo_path: 'x.png' }).ok,
    false
  );
  check(
    '  because SRS §15.3 names no photo for a teacher, so the column has no writer at all',
    require('../src/modules/teachers/teachers.service').EDITABLE.includes('photo_path'),
    false
  );

  check(
    'first_name is required',
    run(schemas.create, { employee_id: 'T-1', joining_date: '2024-01-15' }).ok,
    false
  );
  check(
    'joining_date is required — the column is NOT NULL',
    run(schemas.create, { employee_id: 'T-1', first_name: 'Asha' }).ok,
    false
  );

  check(
    'organization_id is refused rather than stripped',
    run(schemas.create, {
      employee_id: 'T-1',
      first_name: 'Asha',
      joining_date: '2024-01-15',
      organization_id: 9,
    }).ok,
    false
  );
  check(
    'id is refused',
    run(schemas.create, { employee_id: 'T-1', first_name: 'Asha', joining_date: '2024-01-15', id: 9 }).ok,
    false
  );

  /* Mass-assignment: an unknown key is stripped, not an error — the house rule from validate.js. */
  const stripped = run(schemas.create, {
    employee_id: 'T-1',
    first_name: 'Asha',
    joining_date: '2024-01-15',
    is_superuser: true,
  });
  check('an unknown key is stripped', stripped.ok && stripped.value.is_superuser === undefined, true);

  check(
    'gender is held to the model enum',
    run(schemas.create, {
      employee_id: 'T-1',
      first_name: 'Asha',
      joining_date: '2024-01-15',
      gender: 'unspecified',
    }).ok,
    false
  );
  check(
    'gender accepts a model value',
    run(schemas.create, { employee_id: 'T-1', first_name: 'Asha', joining_date: '2024-01-15', gender: 'female' })
      .ok,
    true
  );

  const cased = run(schemas.create, {
    employee_id: 'T-1',
    first_name: 'Asha',
    joining_date: '2024-01-15',
    email: '  Asha.T@Example.COM ',
  });
  check('email is trimmed and lower-cased', cased.value.email, 'asha.t@example.com');

  check('update requires at least one field', run(schemas.update, {}).ok, false);
  check('update accepts a single field', run(schemas.update, { designation: 'Head of Science' }).ok, true);

  check(
    'experience_years is bounded',
    run(schemas.update, { experience_years: 200 }).ok,
    false
  );
  check('salary may not be negative', run(schemas.update, { salary: -1 }).ok, false);

  /*
   * Schema width against column width. `specialization` is `STRING(160)`; the schema said 180, so a
   * 161-character value passed validation and then hit MariaDB under STRICT_TRANS_TABLES, which
   * turns it into a `SequelizeDatabaseError` that `rethrow()` does not translate — a 500 on a body
   * the API had just accepted. Checked against the model rather than eyeballed: `qualification` is
   * 255, `designation` 120, `employee_id` 60, `salary` DECIMAL(14,2).
   */
  check(
    'specialization is bounded by the column, not a rounder number',
    run(schemas.update, { specialization: 'x'.repeat(161) }).ok,
    false
  );
  check(
    'and 160 is accepted',
    run(schemas.update, { specialization: 'x'.repeat(160) }).ok,
    true
  );
  check(
    'qualification matches its wider column',
    run(schemas.update, { qualification: 'x'.repeat(255) }).ok,
    true
  );
  check(
    'salary is bounded by DECIMAL(14,2)',
    run(schemas.update, { salary: 1e13 }).ok,
    false
  );

  /*
   * The coercion behind Known Issues #20, asserted at the schema layer so the service's
   * normalisation has something to be measured against: Joi hands the service a Date, not a string.
   */
  check(
    'joining_date reaches the service as a Date, which is why the service normalises it',
    minimal.value.joining_date instanceof Date,
    true
  );
}

/* ═══════════════════════════ part 2 — the route table ═══════════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — declared routes ──\n');

  const routes = routesOf(teacherRoutes);
  check('the six §15.3 routes are declared', routes, [
    'GET /',
    'GET /dashboard',
    'POST /',
    'GET /:id/assignments',
    'GET /:id',
    'PATCH /:id',
  ]);

  check(
    'GET /dashboard is declared before GET /:id, or Express reads the literal as an id',
    routes.indexOf('GET /dashboard') < routes.indexOf('GET /:id'),
    true
  );

  check('teachers has no DELETE — §15.3 names none', routes.some((r) => r.startsWith('DELETE')), false);

  /*
   * `requirePlatformScope` must be absent: the actor is Principal / School Admin, not the Super
   * Admin. Its guard is a plain named closure, so unlike `requirePermission` it *is* detectable.
   */
  const writes = teacherRoutes.stack
    .filter((l) => l.route && !l.route.methods.get)
    .map((l) => [Object.keys(l.route.methods)[0], l.route.path]);
  check('there are two write routes', writes.length, 2);
  check(
    'no write carries requirePlatformScope()',
    writes.every(([method, path]) => named(teacherRoutes, method, path, 'platformGuard') === false),
    true
  );
  check(
    'every write carries validate()',
    writes.every(([method, path]) => named(teacherRoutes, method, path, 'validateRequest')),
    true
  );
  check(
    'every write declares its activity',
    writes.every(([method, path]) => named(teacherRoutes, method, path, 'activityDeclaration')),
    true
  );

  /*
   * The entitlement guard is mounted on the router rather than per route, so it cannot be missed by
   * a new route added later. It is `asyncHandler`-wrapped and therefore identifiable by neither name
   * nor identity — the structural check is that exactly one router-level layer exists; that it is
   * specifically the Teachers module guard is proven over HTTP in Part 3.
   */
  check(
    'one router-level guard, ahead of every route',
    teacherRoutes.stack.filter((l) => !l.route).length,
    1
  );
  check(
    'and it is mounted first, so no route can be reached around it',
    teacherRoutes.stack.findIndex((l) => !l.route),
    0
  );
}

/* ═══════════════════════════ part 3 — over real HTTP ═══════════════════════════ */

async function verifyHttp() {
  console.log('\n── Part 3 — real HTTP against the real database ──\n');

  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  const created = {
    users: [],
    schools: [],
    organizations: [],
    teachers: [],
    plans: [],
    subscriptions: [],
  };
  const baseline = {
    activityLog: (await db.ActivityLog.max('id')) || 0,
    auditLog: (await db.AuditLog.max('id')) || 0,
  };

  async function call(path, { method = 'GET', body, token } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers, body: payload });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* left null */
    }
    return { status: res.status, body: parsed, raw: text };
  }

  const codeOf = (res) => (res.body && res.body.error ? res.body.error.code : `no-error:${res.status}`);
  const dataOf = (res) => (res.body && res.body.data !== undefined ? res.body.data : null);

  /** Throws on a non-2xx, so a broken fixture cannot manufacture a false defect downstream. */
  async function expectOk(path, options, wantStatus) {
    const res = await call(path, options);
    if (res.status !== wantStatus) {
      throw new Error(`${options.method || 'GET'} ${path} expected ${wantStatus}, got ${res.status}: ${res.raw}`);
    }
    return res;
  }

  async function teardown() {
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
    if (created.subscriptions.length) {
      await db.UsageRecord.destroy({ where: { subscription_id: created.subscriptions } });
      await db.Subscription.destroy({ where: { id: created.subscriptions }, force: true });
    }
    if (created.teachers.length) {
      await db.Teacher.destroy({ where: { id: created.teachers }, force: true });
    }
    await db.Teacher.destroy({ where: { school_id: created.schools }, force: true });
    if (created.users.length) await db.User.destroy({ where: { id: created.users }, force: true });
    if (created.plans.length) {
      await db.PlanModule.destroy({ where: { plan_id: created.plans } });
      await db.PlanLimit.destroy({ where: { plan_id: created.plans } });
      await db.SubscriptionPlan.destroy({ where: { id: created.plans }, force: true });
    }
    if (created.schools.length) {
      await db.School.destroy({ where: { id: created.schools }, force: true });
    }
    await db.Organization.destroy({
      where: {
        [db.Op.or]: [
          { code: { [db.Op.like]: `${CODE_PREFIX}%` } },
          ...(created.organizations.length ? [{ id: created.organizations }] : []),
        ],
      },
      force: true,
    });
  }

  try {
    const roles = {};
    for (const slug of [ROLES.SUPER_ADMIN, ROLES.PRINCIPAL, ROLES.TEACHER]) {
      const role = await db.Role.findOne({ where: { slug } });
      if (!role) throw new Error(`seeded role missing: ${slug}`);
      roles[slug] = role;
    }

    /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
    const residueCleared = await sweepResidue(db, { codes: ['VTE-'], domains: ['verify-teachers.local'] });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({ name: 'Verify Teachers Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Teachers A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Teachers B');
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify Teachers C');
    /* D exists to make a cross-school read *possible*: its principal passes the module guard, so a
       404 from school A's teacher is isolation rather than entitlement refusing first. */
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Teachers D');

    /*
     * Two plans that differ in exactly one thing: whether `teachers` is enabled. Every other module
     * is on in both, so a refusal can only be about the module under test — a plan that differed in
     * several ways would let a wrong guard produce a right-looking 403.
     */
    const mkPlan = async (code, teachersEnabled, teacherLimit) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify Teachers ${code}`,
        code: `${CODE_PREFIX}${code}`,
        status: PLAN_STATUS.ACTIVE,
        tier_rank: 1,
        trial_days: 0,
        grace_period_days: 7,
      });
      created.plans.push(plan.id);
      for (const key of MODULE_LIST) {
        const isEnabled = key === MODULES.TEACHERS ? teachersEnabled : true;
        // eslint-disable-next-line no-await-in-loop
        await db.PlanModule.create({ plan_id: plan.id, module_key: key, is_enabled: isEnabled });
      }
      await db.PlanLimit.create({
        plan_id: plan.id,
        limit_key: LIMITS.TEACHER_LIMIT,
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: teacherLimit,
      });
      return plan;
    };

    const withTeachers = await mkPlan('WITH', true, 2);
    const withoutTeachers = await mkPlan('WITHOUT', false, 50);

    const subscribe = async (school, plan) => {
      const now = new Date();
      const sub = await db.Subscription.create({
        school_id: school.id,
        organization_id: school.organization_id,
        plan_id: plan.id,
        state: SUBSCRIPTION_STATES.ACTIVE,
        billing_cycle: BILLING_CYCLES.MONTHLY,
        cycle_amount: 100,
        starts_at: now,
        current_period_start: now,
        current_period_end: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        grace_period_days: 7,
      });
      created.subscriptions.push(sub.id);
      return sub;
    };

    const subA = await subscribe(schoolA, withTeachers);
    await subscribe(schoolB, withoutTeachers);
    await subscribe(schoolD, withTeachers);
    /* schoolC is deliberately left unsubscribed. */

    const password_hash = await hashPassword(PASSWORD);
    const people = [
      ['platform', ROLES.SUPER_ADMIN, 'Verify T Platform', 'vte_platform', null, null],
      ['principal-a', ROLES.PRINCIPAL, 'Verify T Principal A', 'vte_principal_a', org.id, schoolA.id],
      ['principal-b', ROLES.PRINCIPAL, 'Verify T Principal B', 'vte_principal_b', org.id, schoolB.id],
      ['principal-c', ROLES.PRINCIPAL, 'Verify T Principal C', 'vte_principal_c', org.id, schoolC.id],
      ['principal-d', ROLES.PRINCIPAL, 'Verify T Principal D', 'vte_principal_d', org.id, schoolD.id],
      ['teacher-linked', ROLES.TEACHER, 'Verify T Linked', 'vte_linked', org.id, schoolA.id],
      ['teacher-loose', ROLES.TEACHER, 'Verify T Loose', 'vte_loose', org.id, schoolA.id],
    ];
    const userId = {};
    for (const [key, slug, name, username, organization_id, school_id] of people) {
      // eslint-disable-next-line no-await-in-loop
      const user = await db.User.create({
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
      created.users.push(user.id);
      userId[key] = user.id;
    }

    async function signIn(identifier) {
      const res = await call('/auth/login', { method: 'POST', body: { identifier, password: PASSWORD } });
      const token = res.body && res.body.data ? res.body.data.accessToken : null;
      if (!token) throw new Error(`sign-in failed for ${identifier}: ${res.raw}`);
      return token;
    }

    const platform = await signIn(`platform@${DOMAIN}`);
    const principalA = await signIn(`principal-a@${DOMAIN}`);
    const principalB = await signIn(`principal-b@${DOMAIN}`);
    const principalC = await signIn(`principal-c@${DOMAIN}`);
    const principalD = await signIn(`principal-d@${DOMAIN}`);
    const linked = await signIn(`teacher-linked@${DOMAIN}`);
    const loose = await signIn(`teacher-loose@${DOMAIN}`);
    check('all six fixtures sign in', [platform, principalA, principalB, principalC, linked, loose].every(
      (t) => typeof t === 'string'
    ), true);

    /* ── the entitlement guard, which is the point of this module ── */

    const moduleDenied = await call('/teachers', {
      method: 'POST',
      token: principalB,
      body: { employee_id: 'B-1', first_name: 'Blocked', joining_date: '2024-02-01' },
    });
    check('a plan without the Teachers module refuses the write', moduleDenied.status, 403);
    check('and names the module rather than the permission', codeOf(moduleDenied), 'MODULE_NOT_SUBSCRIBED');
    check(
      'the refusal names which module is missing',
      moduleDenied.body.error.details.missing,
      [MODULES.TEACHERS]
    );

    const moduleDeniedRead = await call('/teachers', { token: principalB });
    check('the guard is router-level, so reads are refused too', codeOf(moduleDeniedRead), 'MODULE_NOT_SUBSCRIBED');

    const noSub = await call('/teachers', { token: principalC });
    /* 402 Payment Required, not 403 — the codebase distinguishes 'you may not' from 'your subscription lapsed'. */
    check('a school with no subscription is refused', noSub.status, 402);
    check(
      'and it is a different refusal from the module one — state is checked first',
      codeOf(noSub),
      'SUBSCRIPTION_INACTIVE'
    );

    /* ── FR-TEACHER-001 ── */

    const createRes = await expectOk(
      '/teachers',
      {
        method: 'POST',
        token: principalA,
        body: {
          employee_id: 'VTE-T1',
          first_name: 'Asha',
          last_name: 'Rahman',
          gender: 'female',
          joining_date: '2024-01-15',
          qualification: 'M.Sc Physics',
          designation: 'Senior Teacher',
          experience_years: 8.5,
          user_id: userId['teacher-linked'],
        },
      },
      201
    );
    const teacherOne = dataOf(createRes).teacher;
    created.teachers.push(teacherOne.id);
    check('a teacher is created', teacherOne.employee_id, 'VTE-T1');
    check('the profile fields §15.3 names are stored', teacherOne.qualification, 'M.Sc Physics');
    check('joining_date is stored as a plain date', teacherOne.joining_date, '2024-01-15');
    check('is_active defaults to true', teacherOne.is_active, true);
    check('the school comes from the tenant, not the body', Number(teacherOne.school_id), schoolA.id);

    const dup = await call('/teachers', {
      method: 'POST',
      token: principalA,
      body: { employee_id: 'VTE-T1', first_name: 'Clash', joining_date: '2024-03-01' },
    });
    check('a duplicate employee_id at the same school is 409', dup.status, 409);
    check('duplicate employee_id code', codeOf(dup), 'TEACHER_EMPLOYEE_ID_TAKEN');

    const crossUser = await call('/teachers', {
      method: 'POST',
      token: principalA,
      body: {
        employee_id: 'VTE-T9',
        first_name: 'Cross',
        joining_date: '2024-03-01',
        user_id: userId['principal-b'],
      },
    });
    check('a user_id from another school is refused', crossUser.status, 422);

    /* ── the DATEONLY trap, at a western offset (Known Issues #20) ── */

    const tzBefore = process.env.TZ;
    let westTeacher = null;
    try {
      process.env.TZ = 'America/New_York';
      const westRes = await expectOk(
        '/teachers',
        {
          method: 'POST',
          token: principalA,
          body: { employee_id: 'VTE-TZ', first_name: 'Westward', joining_date: '2024-07-01' },
        },
        201
      );
      westTeacher = dataOf(westRes).teacher;
      created.teachers.push(westTeacher.id);
    } finally {
      if (tzBefore === undefined) delete process.env.TZ;
      else process.env.TZ = tzBefore;
    }
    check('joining_date survives a west-of-UTC server', westTeacher.joining_date, '2024-07-01');
    const [westRows] = await db.sequelize.query(
      `SELECT DATE_FORMAT(joining_date, '%Y-%m-%d') AS d FROM teachers WHERE id = ${Number(westTeacher.id)}`
    );
    check('and the column itself holds it', westRows[0].d, '2024-07-01');

    /* ── enforceLimit + syncHeadcount ── */

    const overLimit = await call('/teachers', {
      method: 'POST',
      token: principalA,
      body: { employee_id: 'VTE-T3', first_name: 'Third', joining_date: '2024-04-01' },
    });
    check('the third teacher exceeds a teacher_limit of 2', overLimit.status, 403);
    check('and it is the limit guard that refuses', codeOf(overLimit), 'PLAN_LIMIT_EXCEEDED');

    /*
     * … but an **inactive** third teacher is not a third teacher, and used to be refused anyway.
     *
     * `teacher_limit` counts `is_active: true`, and this suite already proves the ceiling is asserted
     * on the re-activation transition for exactly that reason. `POST` nonetheless charged a flat 1
     * whatever the body said, so a school at its ceiling could not enter someone who had already
     * left — a record that consumed an allowance it was never counted in. It failed *closed*, so
     * nothing could be smuggled past the limit; the cost was a record that could not be entered at
     * all. Known Issue #22.
     *
     * The second assertion is the one that keeps the fix honest: creating the inactive row must not
     * move the meter. A fix that let the row through *and* charged for it would pass the first
     * assertion alone.
     */
    const inactiveAtCeiling = await call('/teachers', {
      method: 'POST',
      token: principalA,
      body: {
        employee_id: 'VTE-T3I', first_name: 'Departed', joining_date: '2024-04-01', is_active: false,
      },
    });
    check('an inactive teacher is admitted at the ceiling, because the headcount does not count it',
      inactiveAtCeiling.status, 201);

    const usageAfterInactive = await db.UsageRecord.findOne({
      where: { subscription_id: subA.id, limit_key: LIMITS.TEACHER_LIMIT },
    });
    check('  and it did not consume an allowance it is not counted in',
      Number(usageAfterInactive ? usageAfterInactive.used_value : -1), 2);

    /*
     * Removed again immediately. Later assertions count school A's teachers, and a fixture that
     * outlives the assertion it was created for changes what every subsequent check is measuring —
     * which is how a suite starts asserting its own leftovers.
     */
    await db.Teacher.destroy({ where: { id: dataOf(inactiveAtCeiling).teacher.id }, force: true });

    const usageAfterTwo = await db.UsageRecord.findOne({
      where: { subscription_id: subA.id, limit_key: LIMITS.TEACHER_LIMIT },
    });
    check(
      'the headcount was recorded, not just checked',
      usageAfterTwo ? Number(usageAfterTwo.used_value) : null,
      2
    );

    /* Deactivating returns the allowance — this is why update() re-syncs on an is_active change. */
    await expectOk(
      `/teachers/${westTeacher.id}`,
      { method: 'PATCH', token: principalA, body: { is_active: false, left_at: '2024-12-31T00:00:00.000Z' } },
      200
    );
    const usageAfterLeave = await db.UsageRecord.findOne({
      where: { subscription_id: subA.id, limit_key: LIMITS.TEACHER_LIMIT },
    });
    check(
      'deactivating a teacher returns the allowance',
      usageAfterLeave ? Number(usageAfterLeave.used_value) : null,
      1
    );

    const afterFree = await expectOk(
      '/teachers',
      {
        method: 'POST',
        token: principalA,
        body: { employee_id: 'VTE-T4', first_name: 'Fourth', joining_date: '2024-05-01' },
      },
      201
    );
    created.teachers.push(dataOf(afterFree).teacher.id);
    check('and the freed allowance is usable', dataOf(afterFree).teacher.employee_id, 'VTE-T4');

    /*
     * Re-activating past the ceiling.
     *
     * `enforceLimit` is a route guard and it is mounted on `POST /` only, so for a while this was a
     * hole: the school is now at 2 of 2 active teachers, and flipping the deactivated one back to
     * `is_active: true` through `PATCH` would take it to 3 without any guard running. The ceiling
     * has to be enforced wherever the counted flag is *set*, not only where a row is created —
     * FR-SUB-008 enforces against actual usage, and a deactivate/reactivate pair is a way to reach
     * that usage without ever calling the guarded route.
     */
    const reactivate = await call(`/teachers/${westTeacher.id}`, {
      method: 'PATCH',
      token: principalA,
      body: { is_active: true },
    });
    check('re-activating a teacher past the ceiling is refused', reactivate.status, 403);
    check('and by the same limit guard as the create path', codeOf(reactivate), 'PLAN_LIMIT_EXCEEDED');

    const stillTwo = await db.UsageRecord.findOne({
      where: { subscription_id: subA.id, limit_key: LIMITS.TEACHER_LIMIT },
    });
    check(
      'the refused re-activation left the headcount alone',
      stillTwo ? Number(stillTwo.used_value) : null,
      2
    );

    /* A PATCH that does not touch is_active is unaffected by the limit, even at the ceiling. */
    const patchAtCeiling = await expectOk(
      `/teachers/${westTeacher.id}`,
      { method: 'PATCH', token: principalA, body: { designation: 'Retired' } },
      200
    );
    check('a non-activating edit still works at the ceiling', dataOf(patchAtCeiling).teacher.designation, 'Retired');

    /* ── reads, isolation, permissions ── */

    const listA = await expectOk('/teachers', { token: principalA }, 200);
    check(
      'the list is confined to the caller school',
      dataOf(listA).every((row) => Number(row.school_id) === schoolA.id),
      true
    );
    check('all three teachers of school A are listed', dataOf(listA).length, 3);

    const activeOnly = await expectOk('/teachers?is_active=true', { token: principalA }, 200);
    check('the is_active filter works', dataOf(activeOnly).length, 2);

    const search = await expectOk('/teachers?q=Rahman', { token: principalA }, 200);
    check('the q filter searches names', dataOf(search).length, 1);

    const showOne = await expectOk(`/teachers/${teacherOne.id}`, { token: principalA }, 200);
    check('a teacher is readable by id', dataOf(showOne).teacher.first_name, 'Asha');

    const crossRead = await call(`/teachers/${teacherOne.id}`, { token: platform });
    check('the platform admin reads any school', crossRead.status, 200);

    /*
     * A real cross-school read. Until school D existed this could not be tested at all: school B is
     * on a plan without the Teachers module and school C has no subscription, so both are refused by
     * entitlement *before* isolation is ever reached — a 403 that looks like a passing isolation
     * test while proving nothing about it. D is on the same plan as A, so it clears the guard and
     * the only thing left between its principal and A's teacher is `tenantWhere()`.
     */
    const dReadsA = await call(`/teachers/${teacherOne.id}`, { token: principalD });
    check('a principal of another school cannot read this teacher', dReadsA.status, 404);
    check('and it is isolation refusing, not entitlement', codeOf(dReadsA), 'TEACHER_NOT_FOUND');

    const dPatchesA = await call(`/teachers/${teacherOne.id}`, {
      method: 'PATCH',
      token: principalD,
      body: { designation: 'Hijacked' },
    });
    check('nor patch it', dPatchesA.status, 404);

    const dListsOwn = await expectOk('/teachers', { token: principalD }, 200);
    check('and school D sees none of school A', dListsOwn.length === 0 || dataOf(dListsOwn).length, 0);

    /*
     * One teacher per account. `teachers.user_id` carries a plain index, not a unique one, and
     * FR-TEACHER-002's dashboard resolves the teacher *by* user_id — so a second link would make the
     * dashboard answer with whichever row the optimiser happened to return.
     */
    /*
     * Asserted through PATCH rather than POST deliberately: by this point school A is at its
     * teacher_limit of 2, so a POST would be refused by `enforceLimit` before the link check ever
     * ran — a 403 that looks like a passing test of something it never reached. PATCH carries no
     * limit guard for a non-activating edit, so the link check is the only thing that can refuse.
     */
    const dupLink = await call(`/teachers/${dataOf(afterFree).teacher.id}`, {
      method: 'PATCH',
      token: principalA,
      body: { user_id: userId['teacher-linked'] },
    });
    check('an account already linked to a teacher is refused', dupLink.status, 409);
    check('and names why', codeOf(dupLink), 'TEACHER_USER_TAKEN');

    /* Re-saving the same teacher with its own link is not a duplicate. */
    const selfLink = await expectOk(
      `/teachers/${teacherOne.id}`,
      { method: 'PATCH', token: principalA, body: { user_id: userId['teacher-linked'] } },
      200
    );
    check('but a teacher may keep its own link', Number(dataOf(selfLink).teacher.user_id), userId['teacher-linked']);

    const patched = await expectOk(
      `/teachers/${teacherOne.id}`,
      { method: 'PATCH', token: principalA, body: { designation: 'Head of Science' } },
      200
    );
    check('PATCH updates the profile', dataOf(patched).teacher.designation, 'Head of Science');
    check('and leaves the rest alone', dataOf(patched).teacher.employee_id, 'VTE-T1');

    const teacherWrite = await call('/teachers', {
      method: 'POST',
      token: linked,
      body: { employee_id: 'VTE-X', first_name: 'Nope', joining_date: '2024-01-01' },
    });
    check('a teacher cannot create teachers', teacherWrite.status, 403);
    check('and it is the permission that refuses, not the module', codeOf(teacherWrite), 'INSUFFICIENT_PERMISSION');

    const teacherList = await call('/teachers', { token: linked });
    check('a teacher does not hold teachers.view either', teacherList.status, 403);

    /* ── FR-TEACHER-002, the dashboard ── */

    const dash = await expectOk('/teachers/dashboard', { token: linked }, 200);
    check('the linked teacher gets their own dashboard', Number(dataOf(dash).teacher.id), Number(teacherOne.id));
    check('the dashboard is resolved from the token, not a path id', dataOf(dash).teacher.employee_id, 'VTE-T1');
    check('it reports assignment counts', typeof dataOf(dash).counts.subjects, 'number');

    const looseDash = await call('/teachers/dashboard', { token: loose });
    check('a teacher-role user with no teacher row is 404, not 403', looseDash.status, 404);
    check('and the code says why', codeOf(looseDash), 'TEACHER_PROFILE_MISSING');

    const principalDash = await call('/teachers/dashboard', { token: principalA });
    check(
      'a principal does not hold teachers.dashboard.view — the dashboard is the teacher’s own',
      principalDash.status,
      403
    );

    const assigns = await expectOk(`/teachers/${teacherOne.id}/assignments`, { token: principalA }, 200);
    check('assignments returns the three collections §15.3 implies', Object.keys(dataOf(assigns)).sort(), [
      'classTeacherOf',
      'sectionTeacherOf',
      'subjects',
    ]);

    /* ── the audit trail ── */

    const audits = await settleDistinct(
      () => db.AuditLog.findAll({
        where: { id: { [db.Op.gt]: baseline.auditLog }, table_name: 'teachers' },
        order: [['id', 'ASC']],
      }),
      'event',
      2
    );
    check('teacher writes are audited', audits.length > 0, true);
    check(
      'both events are exercised',
      [...new Set(audits.map((r) => r.event))].sort(),
      ['create', 'update']
    );
    const deact = audits.find((r) => r.event === 'update' && r.changed_fields);
    check(
      'changed_fields is a real array, not JSON text',
      Array.isArray(deact && deact.changed_fields),
      true
    );
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-teachers Part 3 teardown failed:', err);
    }
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

/* ═══════════════════════════════════════ run ═══════════════════════════════════════ */

async function main() {
  verifySchemas();
  verifyRouting();

  try {
    await db.sequelize.authenticate();
  } catch (err) {
    dbSkipped = true;
    console.log(`\nSKIP  Part 3 (HTTP) — database unreachable: ${err.message}`);
    return;
  }

  await verifyHttp();
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nverify-teachers crashed:', err);
  })
  .finally(async () => {
    console.log('');
    if (dbSkipped) {
      console.log('⚠  Part 3 (HTTP) was SKIPPED — MySQL/MariaDB is not reachable.');
      console.log('   Parts 1–2 (pure) executed in full.');
    }
    if (failures === 0) {
      console.log(
        dbSkipped
          ? 'All pure teacher checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All teacher checks passed (Parts 1–3).'
      );
    } else {
      console.log(`${failures} check(s) FAILED.`);
    }
    try {
      await db.sequelize.close();
    } catch (_) {
      /* the pool may never have opened */
    }
    /*
     * A degraded run is a FAILED run — Known Issue 28.
     *
     * This suite answers an unreachable database by setting `dbSkipped`, returning early from its
     * database half and printing that it passed. Until session 26 it then **exited 0**, so a stopped
     * MySQL read as a green run to anything that looks at the exit code — which is `node
     * scripts/verify-*.js` run directly (the workflow this project's log documents throughout) and
     * `scripts/stress.sh:17`, whose entire scoring is `if ! wait "$pid"`. A stress run with the
     * database down would have reported a perfect determinism score for suites that never ran.
     *
     * `npm test` was never exposed: `tests/globalSetup.js` proves the database with `SELECT
     * DATABASE()` before any suite spawns, and `tests/verify.test.js` asserts both that `skipped` is
     * empty and that each suite produced its exact recorded count. This closes the direct-run path,
     * which is the one a person uses.
     *
     * `--allow-skip` is for running the pure checks deliberately, and mirrors `--allow-shrink` in
     * `record-baseline.js` rather than inventing a new convention. The jest harness passes no
     * arguments (`suiteRunner.js:220`), so it can never opt out by accident.
     */
    if (dbSkipped && !process.argv.includes('--allow-skip')) {
      console.log('');
      console.log('   Exiting 1: the database half did not run, so this is not a pass.');
      console.log('   Re-run with --allow-skip to execute the pure checks on purpose.');
      process.exit(1);
    }
    process.exit(failures === 0 ? 0 : 1);
  });
