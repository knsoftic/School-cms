'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *   RATE_LIMIT_MAX / AUTH_RATE_LIMIT_MAX  the limiters are not under test here.
 *   BCRYPT_ROUNDS=10, PASSWORD_MIN_LENGTH pinned so neither comes from the local .env.
 *   MAIL_DRIVER=log                       no mail is sent; a stray SMTP attempt would hang the run.
 *   CACHE_TTL=600                         so no entitlement assertion can pass by TTL expiry.
 */
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.BCRYPT_ROUNDS = '10';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';
process.env.CACHE_TTL = '600';

/**
 * Verification of Phase 3.K attendance — `src/modules/attendance/*` — SRS §16,
 * FR-ATT-001 (mark students), FR-ATT-002 (reports) and FR-ATT-003 (teacher attendance).
 *
 * Four things this suite does that the §15 suites had to be *corrected* to do, carried in from the
 * start because their audits found each one passing while proving nothing:
 *
 *  - **Rows exist outside school A.** `verify-staff.js`'s tenant-scoping assertion iterated an array
 *    that could not contain a counter-example, so deleting `tenantWhere` left it green. Here school D
 *    has its own register and both directions are asserted.
 *  - **An organization-scoped caller exists.** Every §15 suite gave each fixture both an organization
 *    and a school, so `tenantWhere`'s `organization_id` branch never ran.
 *  - **Every `DATEONLY` column is round-tripped at a flipped `process.env.TZ`**, not just one.
 *  - **The percentage is asserted against a hand-computed figure**, not against whatever the code
 *    returned — §16 defines no formula, so the module chose one, and a test that echoes the choice
 *    would prove nothing about it.
 *
 * Part 1 — request schemas, directly (no database).
 * Part 2 — the declared route table and the router-level guard.
 * Part 3 — over real HTTP against the real database.
 *
 * Run: node scripts/verify-attendance.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const { settle, quiesce } = require('./lib/settle');

const attendanceRoutes = require('../src/modules/attendance/attendance.routes');
const { schemas } = require('../src/modules/attendance/attendance.validation');
const attendanceService = require('../src/modules/attendance/attendance.service');

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
  ATTENDANCE_STATUS,
  ATTENDANCE_STATUS_LIST,
  STUDENT_STATUS,
  ACADEMIC_SESSION_STATUS,
} = require('../src/config/constants');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-attendance.local';
const PASSWORD = 'Verify@Attend123';
const CODE_PREFIX = 'VAT-';

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
  return { ok: !error, value: cleaned };
}

/**
 * Does this router actually MOUNT an entitlement limit, ignoring what its prose says about one?
 *
 * Comments are stripped first. Every one of these routers explains in its header *why* it carries no
 * `enforceLimit`, so a bare substring search finds the explanation and reports the opposite of the
 * truth. The name-based check this replaced had the mirror problem: `enforceLimit()` returns an
 * `asyncHandler`-wrapped function called `wrappedAsyncHandler`, never `limitGuard`, so comparing
 * against `'limitGuard'` compared against a name nothing in this codebase has and could not fail.
 */
function mountsLimit(moduleName) {
  const src = fs.readFileSync(path.join(__dirname, `../src/modules/${moduleName}/${moduleName}.routes.js`), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return /enforceLimit/.test(code);
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

const MARK = {
  class_id: 1,
  attendance_date: '2025-04-10',
  entries: [{ student_id: 1, status: ATTENDANCE_STATUS.PRESENT }],
};

/* ═══════════════════════════ part 1 — request schemas ═══════════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas ──\n');

  const minimal = run(schemas.markStudents, { ...MARK });
  check('a class, a date and one entry are enough to mark', minimal.ok, true);

  for (const missing of ['class_id', 'attendance_date', 'entries']) {
    const body = { ...MARK };
    delete body[missing];
    check(`${missing} is required to mark`, run(schemas.markStudents, body).ok, false);
  }
  check('an empty register is refused', run(schemas.markStudents, { ...MARK, entries: [] }).ok, false);

  /* §16 fixes exactly four statuses. */
  check(
    'all four §16 statuses are accepted',
    ATTENDANCE_STATUS_LIST.every(
      (s) => run(schemas.markStudents, { ...MARK, entries: [{ student_id: 1, status: s }] }).ok
    ),
    true
  );
  check(
    'and a fifth is refused',
    run(schemas.markStudents, { ...MARK, entries: [{ student_id: 1, status: 'excused' }] }).ok,
    false
  );
  /*
   * The schema's own list against the model's — not the constant against itself, which is the
   * tautology `verify-staff.js` had to be rewritten to remove.
   */
  check(
    'the schema takes its status list from the model, not a restated copy',
    schemas.markStudents
      .describe()
      .keys.entries.items[0].keys.status.allow.slice()
      .sort(),
    db.StudentAttendance.rawAttributes.status.values.slice().sort()
  );

  check(
    'an entry needs a student and a status',
    run(schemas.markStudents, { ...MARK, entries: [{ student_id: 1 }] }).ok,
    false
  );
  check(
    'late_minutes is bounded to a day',
    run(schemas.markStudents, {
      ...MARK,
      entries: [{ student_id: 1, status: ATTENDANCE_STATUS.LATE, late_minutes: 1441 }],
    }).ok,
    false
  );
  check(
    'remarks are bounded by the column at 255',
    run(schemas.markStudents, {
      ...MARK,
      entries: [{ student_id: 1, status: ATTENDANCE_STATUS.PRESENT, remarks: 'x'.repeat(256) }],
    }).ok,
    false
  );

  /* FR-ATT-002 — exactly the three periods §16 names. */
  for (const period of ['daily', 'monthly', 'yearly']) {
    check(`the ${period} report period is accepted`, run(schemas.report, { period, date: '2025-04-10' }).ok, true);
  }
  check(
    'a fourth period is refused — §16 names three',
    run(schemas.report, { period: 'weekly', date: '2025-04-10' }).ok,
    false
  );
  check('a report needs an anchor date', run(schemas.report, { period: 'daily' }).ok, false);

  /* FR-ATT-003 — the same shape, so one mental model covers both registers. */
  check(
    'teacher attendance takes a teacher and a status',
    run(schemas.markTeachers, {
      attendance_date: '2025-04-10',
      entries: [{ teacher_id: 1, status: ATTENDANCE_STATUS.PRESENT }],
    }).ok,
    true
  );
  check(
    'and no class — a teacher register is school-wide',
    run(schemas.markTeachers, {
      attendance_date: '2025-04-10',
      class_id: 1,
      entries: [{ teacher_id: 1, status: ATTENDANCE_STATUS.PRESENT }],
    }).value.class_id,
    undefined
  );

  check(
    'attendance_date reaches the service as a Date, which is why the service normalises it',
    minimal.value.attendance_date instanceof Date,
    true
  );

  /* The period boundaries, including the one that is easy to get wrong. */
  check('a daily period is one day', attendanceService.periodRange('daily', '2025-04-10'), {
    from: '2025-04-10',
    to: '2025-04-10',
    label: '2025-04-10',
  });
  check('a monthly period ends on the real last day', attendanceService.periodRange('monthly', '2025-02-10'), {
    from: '2025-02-01',
    to: '2025-02-28',
    label: '2025-02',
  });
  check('including in a leap year', attendanceService.periodRange('monthly', '2024-02-05'), {
    from: '2024-02-01',
    to: '2024-02-29',
    label: '2024-02',
  });
  check('a yearly period is the whole year', attendanceService.periodRange('yearly', '2025-04-10'), {
    from: '2025-01-01',
    to: '2025-12-31',
    label: '2025',
  });
}

/* ═══════════════════════════ part 2 — the route table ═══════════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — declared routes ──\n');

  const routes = routesOf(attendanceRoutes);
  /* Six since the owner's decision D17 mounted the self-service view. */
  check('the five §16 routes and the D17 self-service view are declared', routes, [
    'GET /mine',
    'GET /students/report',
    'POST /students',
    'GET /students',
    'POST /teachers',
    'GET /teachers',
  ]);

  check(
    'there is no DELETE and no PATCH — re-posting a register corrects it',
    routes.some((r) => r.startsWith('DELETE') || r.startsWith('PATCH')),
    false
  );
  /* D17 — the self-service view is on the self-view key, and it is the only route that is. */
  const { metaOf } = require('../src/utils/routeMeta');
  const keysOf = (method, path) => {
    const layer = attendanceRoutes.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
    const guard = layer && layer.route.stack.map((s) => metaOf(s.handle)).find((m) => m && m.permissions);
    return guard ? guard.permissions : null;
  };
  check('D17 — GET /mine is guarded by attendance.self.view, the key the catalogue granted students and parents',
    keysOf('get', '/mine'), ['attendance.self.view']);

  const writes = attendanceRoutes.stack
    .filter((l) => l.route && !l.route.methods.get)
    .map((l) => [Object.keys(l.route.methods)[0], l.route.path]);
  check('there are two write routes', writes.length, 2);
  check(
    'no write carries requirePlatformScope()',
    writes.every(([m, p]) => named(attendanceRoutes, m, p, 'platformGuard') === false),
    true
  );
  check(
    'every write carries validate()',
    writes.every(([m, p]) => named(attendanceRoutes, m, p, 'validateRequest')),
    true
  );
  check(
    'every write declares its activity',
    writes.every(([m, p]) => named(attendanceRoutes, m, p, 'activityDeclaration')),
    true
  );
  check(
    'one router-level guard, mounted ahead of every route',
    [
      attendanceRoutes.stack.filter((l) => !l.route).length,
      attendanceRoutes.stack.findIndex((l) => !l.route),
    ],
    [1, 0]
  );

  /*
   * No entitlement limit, asserted against the **router** rather than against a constant — the
   * mistake `verify-parents.js` had to be rewritten for.
   */
  check(
    'no route carries an entitlement limit',
    /*
     * Read off the router's SOURCE, not off a handler name. `enforceLimit()` returns an
     * `asyncHandler`-wrapped function called `wrappedAsyncHandler`, so the obvious
     * `h.handle.name !== 'limitGuard'` check compared against a name nothing in this codebase ever
     * has — it could not fail, and it sat here green while proving nothing (§5a session 18).
     */
    mountsLimit('attendance'),
    false
  );
  check(
    '  and the probe would find one — the students router does mount a limit',
    mountsLimit('students'),
    true
  );
  check(
    'and §11.2 defines no attendance limit to carry',
    Object.values(LIMITS).some((k) => k.includes('attend')),
    false
  );
}

/* ═══════════════════════════ part 3 — over real HTTP ═══════════════════════════ */

async function verifyHttp() {
  console.log('\n── Part 3 — real HTTP against the real database ──\n');

  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  const created = { users: [], schools: [], organizations: [], plans: [], subscriptions: [] };
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

  /** Throws on a non-2xx, so a broken fixture cannot manufacture a false defect (§5a session 13). */
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
    if (created.schools.length) {
      await db.StudentAttendance.destroy({ where: { school_id: created.schools } });
      await db.TeacherAttendance.destroy({ where: { school_id: created.schools } });
      await db.Student.destroy({ where: { school_id: created.schools }, force: true });
      await db.Teacher.destroy({ where: { school_id: created.schools }, force: true });
      await db.Section.destroy({ where: { school_id: created.schools }, force: true });
      await db.Class.destroy({ where: { school_id: created.schools }, force: true });
      await db.AcademicSession.destroy({ where: { school_id: created.schools }, force: true });
    }
    if (created.subscriptions.length) {
      await db.UsageRecord.destroy({ where: { subscription_id: created.subscriptions } });
      await db.Subscription.destroy({ where: { id: created.subscriptions }, force: true });
    }
    if (created.users.length) await db.User.destroy({ where: { id: created.users }, force: true });
    if (created.plans.length) {
      await db.PlanModule.destroy({ where: { plan_id: created.plans } });
      await db.PlanLimit.destroy({ where: { plan_id: created.plans } });
      await db.SubscriptionPlan.destroy({ where: { id: created.plans }, force: true });
    }
    if (created.schools.length) await db.School.destroy({ where: { id: created.schools }, force: true });
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
    for (const slug of [ROLES.SUPER_ADMIN, ROLES.ORGANIZATION_ADMIN, ROLES.PRINCIPAL, ROLES.TEACHER]) {
      // eslint-disable-next-line no-await-in-loop
      const role = await db.Role.findOne({ where: { slug } });
      if (!role) throw new Error(`seeded role missing: ${slug}`);
      roles[slug] = role;
    }

    /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
    const residueCleared = await sweepResidue(db, { codes: ['VAT-'], domains: ['verify-attendance.local'] });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({ name: 'Verify Attendance Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Attendance A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Attendance B');
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify Attendance C');
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Attendance D');

    const mkPlan = async (code, attendanceEnabled) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify Attendance ${code}`,
        code: `${CODE_PREFIX}${code}`,
        status: PLAN_STATUS.ACTIVE,
        tier_rank: 1,
        trial_days: 0,
        grace_period_days: 7,
      });
      created.plans.push(plan.id);
      for (const key of MODULE_LIST) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanModule.create({
          plan_id: plan.id,
          module_key: key,
          is_enabled: key === MODULES.ATTENDANCE ? attendanceEnabled : true,
        });
      }
      await db.PlanLimit.create({
        plan_id: plan.id,
        limit_key: LIMITS.STUDENT_LIMIT,
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: 100,
      });
      return plan;
    };

    const withAttendance = await mkPlan('WITH', true);
    const withoutAttendance = await mkPlan('WITHOUT', false);

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

    await subscribe(schoolA, withAttendance);
    await subscribe(schoolB, withoutAttendance);
    await subscribe(schoolD, withAttendance);
    /* schoolC is deliberately left unsubscribed. */

    /* Academic structure and people, created directly — their own suites cover their endpoints. */
    const session = await db.AcademicSession.create({
      school_id: schoolA.id,
      organization_id: org.id,
      name: '2025-2026',
      start_date: '2025-04-01',
      end_date: '2026-03-31',
      status: ACADEMIC_SESSION_STATUS.ACTIVE,
      is_current: true,
    });
    const mkClass = async (school, name, order) =>
      db.Class.create({
        school_id: school.id,
        organization_id: org.id,
        academic_session_id: school.id === schoolA.id ? session.id : null,
        name,
        numeric_order: order,
      });
    const grade1 = await mkClass(schoolA, 'Grade 1', 1);
    const grade2 = await mkClass(schoolA, 'Grade 2', 2);
    const sectionA = await db.Section.create({
      school_id: schoolA.id,
      organization_id: org.id,
      class_id: grade1.id,
      name: 'A',
    });

    const mkStudent = async (school, code, first, klass, section) =>
      db.Student.create({
        school_id: school.id,
        organization_id: org.id,
        student_id: code,
        first_name: first,
        admission_date: '2025-04-01',
        status: STUDENT_STATUS.ACTIVE,
        class_id: klass ? klass.id : null,
        section_id: section ? section.id : null,
        academic_session_id: school.id === schoolA.id ? session.id : null,
      });
    /* Four children in 1A — enough for a percentage that is not a round number by accident. */
    const kids = [];
    for (const [code, name] of [
      [`${CODE_PREFIX}S1`, 'Amina'],
      [`${CODE_PREFIX}S2`, 'Bilal'],
      [`${CODE_PREFIX}S3`, 'Chidi'],
      [`${CODE_PREFIX}S4`, 'Dara'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      kids.push(await mkStudent(schoolA, code, name, grade1, sectionA));
    }
    /* One in grade 2, so "belongs to the class being marked" has a counter-example. */
    const otherClassKid = await mkStudent(schoolA, `${CODE_PREFIX}S9`, 'Elsewhere', grade2, null);
    /* And a school D class + child, so tenant scoping has something to exclude. */
    const dClass = await mkClass(schoolD, 'D Grade 1', 1);
    const dKid = await mkStudent(schoolD, `${CODE_PREFIX}D1`, 'Dee', dClass, null);

    const mkTeacher = async (school, code, first) =>
      db.Teacher.create({
        school_id: school.id,
        organization_id: org.id,
        employee_id: code,
        first_name: first,
        joining_date: '2024-01-15',
      });
    const teacherOne = await mkTeacher(schoolA, `${CODE_PREFIX}T1`, 'Nadia');
    const foreignTeacher = await mkTeacher(schoolD, `${CODE_PREFIX}T9`, 'Faraway');

    const password_hash = await hashPassword(PASSWORD);
    const people = [
      ['platform', ROLES.SUPER_ADMIN, 'Verify AT Platform', 'vat_platform', null, null],
      ['principal-a', ROLES.PRINCIPAL, 'Verify AT Principal A', 'vat_principal_a', org.id, schoolA.id],
      ['principal-b', ROLES.PRINCIPAL, 'Verify AT Principal B', 'vat_principal_b', org.id, schoolB.id],
      ['principal-c', ROLES.PRINCIPAL, 'Verify AT Principal C', 'vat_principal_c', org.id, schoolC.id],
      ['principal-d', ROLES.PRINCIPAL, 'Verify AT Principal D', 'vat_principal_d', org.id, schoolD.id],
      ['teacher', ROLES.TEACHER, 'Verify AT Teacher', 'vat_teacher', org.id, schoolA.id],
      /* organization_id set, school_id NULL — the branch every §15 suite left unexecuted. */
      ['org-admin', ROLES.ORGANIZATION_ADMIN, 'Verify AT Org Admin', 'vat_org', org.id, null],
    ];
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
    const teacher = await signIn(`teacher@${DOMAIN}`);
    const orgAdmin = await signIn(`org-admin@${DOMAIN}`);

    /* ── the entitlement guard ── */

    const moduleDenied = await call('/attendance/students', { token: principalB });
    check('a plan without the Attendance module refuses', moduleDenied.status, 403);
    check('and names the module', codeOf(moduleDenied), 'MODULE_NOT_SUBSCRIBED');
    check('naming which one', moduleDenied.body.error.details.missing, [MODULES.ATTENDANCE]);

    const noSub = await call('/attendance/students', { token: principalC });
    check('a school with no subscription is refused differently', noSub.status, 402);
    check('state is checked before module', codeOf(noSub), 'SUBSCRIPTION_INACTIVE');

    /* ── FR-ATT-001 — the teacher marks the register ── */

    const marked = await expectOk(
      '/attendance/students',
      {
        method: 'POST',
        token: teacher,
        body: {
          class_id: grade1.id,
          section_id: sectionA.id,
          academic_session_id: session.id,
          attendance_date: '2025-04-10',
          entries: [
            { student_id: kids[0].id, status: ATTENDANCE_STATUS.PRESENT },
            { student_id: kids[1].id, status: ATTENDANCE_STATUS.LATE, late_minutes: 12 },
            { student_id: kids[2].id, status: ATTENDANCE_STATUS.ABSENT },
            { student_id: kids[3].id, status: ATTENDANCE_STATUS.LEAVE, remarks: 'Family event' },
          ],
        },
      },
      200
    );
    const rows = dataOf(marked).attendance;
    check('a teacher marks the register — FR-ATT-001 names them as the actor', rows.length, 4);
    check('the date is stored as a plain date', rows[0].attendance_date, '2025-04-10');
    check('the marker is recorded on the row', Boolean(rows[0].marked_by), true);
    check(
      'all four statuses land',
      rows.map((r) => r.status).sort(),
      [ATTENDANCE_STATUS.ABSENT, ATTENDANCE_STATUS.LATE, ATTENDANCE_STATUS.LEAVE, ATTENDANCE_STATUS.PRESENT].sort()
    );
    check('late_minutes is kept', rows.find((r) => r.status === ATTENDANCE_STATUS.LATE).late_minutes, 12);

    /*
     * `q` filters on `remarks`, the row's only free-text column — Known Issue #24's attendance half.
     *
     * The endpoint has always advertised `q` through `listQuery()` and always discarded it. No screen
     * sends one today, which is why nothing looked wrong; an endpoint that accepts a filter and
     * returns an unfiltered list is wrong whoever is asking. The decisive assertion is the second:
     * a term matching nothing must return nothing rather than the whole register.
     */
    const marksFor = async (q) => (
      dataOf(await expectOk(
        `/attendance/students?q=${encodeURIComponent(q)}&from=2025-04-10&to=2025-04-10`,
        { token: teacher },
        200
      )) || []
    ).length;

    check('q filters the register by its remarks', await marksFor('Family event'), 1);
    check('  and a term matching no remark returns nothing, not the whole register',
      await marksFor('no-such-remark-anywhere'), 0);

    /*
     * Re-marking corrects rather than duplicating. The unique index is (student_id, attendance_date)
     * over two NOT NULL columns, so there is no NULL-distinct hole (§5a defect 19) and the upsert is
     * the whole mechanism.
     */
    const corrected = await expectOk(
      '/attendance/students',
      {
        method: 'POST',
        token: teacher,
        body: {
          class_id: grade1.id,
          section_id: sectionA.id,
          attendance_date: '2025-04-10',
          entries: [{ student_id: kids[2].id, status: ATTENDANCE_STATUS.PRESENT }],
          /* Asserted in the activity trail below — the batch's only record of why it changed. */
          reason: 'Arrived after the register was taken',
        },
      },
      200
    );
    check('re-marking corrects the status', dataOf(corrected).attendance[0].status, ATTENDANCE_STATUS.PRESENT);
    check(
      'and does not duplicate the row',
      await db.StudentAttendance.count({
        where: { student_id: kids[2].id, attendance_date: '2025-04-10' },
      }),
      1
    );
    check(
      'the register still holds exactly four rows for the day',
      await db.StudentAttendance.count({ where: { school_id: schoolA.id, attendance_date: '2025-04-10' } }),
      4
    );

    /* ── what a register may not contain ── */

    const wrongClass = await call('/attendance/students', {
      method: 'POST',
      token: teacher,
      body: {
        class_id: grade1.id,
        section_id: sectionA.id,
        attendance_date: '2025-04-11',
        entries: [{ student_id: otherClassKid.id, status: ATTENDANCE_STATUS.PRESENT }],
      },
    });
    check('a child of another class cannot be marked in this register', wrongClass.status, 422);

    const foreignChild = await call('/attendance/students', {
      method: 'POST',
      token: teacher,
      body: {
        class_id: grade1.id,
        attendance_date: '2025-04-11',
        entries: [{ student_id: dKid.id, status: ATTENDANCE_STATUS.PRESENT }],
      },
    });
    check('nor a child of another school', foreignChild.status, 422);

    const foreignClass = await call('/attendance/students', {
      method: 'POST',
      token: teacher,
      body: {
        class_id: dClass.id,
        attendance_date: '2025-04-11',
        entries: [{ student_id: kids[0].id, status: ATTENDANCE_STATUS.PRESENT }],
      },
    });
    check('nor may another school’s class be named', foreignClass.status, 422);

    const twice = await call('/attendance/students', {
      method: 'POST',
      token: teacher,
      body: {
        class_id: grade1.id,
        attendance_date: '2025-04-11',
        entries: [
          { student_id: kids[0].id, status: ATTENDANCE_STATUS.PRESENT },
          { student_id: kids[0].id, status: ATTENDANCE_STATUS.ABSENT },
        ],
      },
    });
    check('the same child twice in one request is a mistake, not a last-one-wins', twice.status, 422);

    /* ── the DATEONLY trap, at a western offset (Known Issues #20) ── */

    const tzBefore = process.env.TZ;
    let westRow = null;
    try {
      process.env.TZ = 'America/New_York';
      const westRes = await expectOk(
        '/attendance/students',
        {
          method: 'POST',
          token: teacher,
          body: {
            class_id: grade1.id,
            attendance_date: '2025-07-01',
            entries: [{ student_id: kids[0].id, status: ATTENDANCE_STATUS.PRESENT }],
          },
        },
        200
      );
      westRow = dataOf(westRes).attendance[0];
    } finally {
      if (tzBefore === undefined) delete process.env.TZ;
      else process.env.TZ = tzBefore;
    }
    check('attendance_date survives a west-of-UTC server', westRow.attendance_date, '2025-07-01');
    const [westRows] = await db.sequelize.query(
      `SELECT DATE_FORMAT(attendance_date, '%Y-%m-%d') AS d FROM student_attendance WHERE id = ${Number(westRow.id)}`
    );
    check('and the column itself holds it', westRows[0].d, '2025-07-01');

    /* ── FR-ATT-002 — the reports ── */

    /*
     * The register for 2025-04-10 is now: 3 present (one of them the corrected absence), 1 leave.
     * Plus the 2025-07-01 row, which is in the same year but a different month — so the three periods
     * give three different answers, and the percentage is hand-computed rather than echoed back.
     */
    const daily = await expectOk(
      `/attendance/students/report?period=daily&date=2025-04-10&class_id=${grade1.id}`,
      { token: principalA },
      200
    );
    const d = dataOf(daily).report;
    /* kid0 present, kid1 late, kid2 absent-then-corrected-to-present, kid3 leave. */
    check('the daily report counts every status', d.counts, {
      present: 2,
      absent: 0,
      leave: 1,
      late: 1,
    });
    check('marked is every row of any status', d.marked, 4);
    check('attended is present + late', d.attended, 3);
    check('and the percentage is attended over marked', d.percentage, 75);
    check('the window is the single day', [d.from, d.to], ['2025-04-10', '2025-04-10']);

    const monthly = await expectOk(
      `/attendance/students/report?period=monthly&date=2025-04-25&class_id=${grade1.id}`,
      { token: principalA },
      200
    );
    check('a monthly report anchored anywhere in the month sees it', dataOf(monthly).report.marked, 4);
    check('and spans the whole month', [dataOf(monthly).report.from, dataOf(monthly).report.to], [
      '2025-04-01',
      '2025-04-30',
    ]);

    const yearly = await expectOk(
      `/attendance/students/report?period=yearly&date=2025-09-09&class_id=${grade1.id}`,
      { token: principalA },
      200
    );
    const y = dataOf(yearly).report;
    check('a yearly report picks up the July row too', y.marked, 5);
    check('so its percentage differs from the daily one', y.percentage, 80);

    const empty = await expectOk(
      `/attendance/students/report?period=daily&date=2020-01-01&class_id=${grade1.id}`,
      { token: principalA },
      200
    );
    check('a period with no register reports zero marked', dataOf(empty).report.marked, 0);
    check(
      'and a null percentage, not 0% — an unmarked period is unknown, not catastrophic',
      dataOf(empty).report.percentage,
      null
    );

    /* ── FR-ATT-003 — teacher attendance ── */

    const teacherMarked = await expectOk(
      '/attendance/teachers',
      {
        method: 'POST',
        token: principalA,
        body: {
          attendance_date: '2025-04-10',
          entries: [{ teacher_id: teacherOne.id, status: ATTENDANCE_STATUS.PRESENT }],
        },
      },
      200
    );
    check('a principal records teacher attendance', dataOf(teacherMarked).attendance.length, 1);

    const teacherMarksTeachers = await call('/attendance/teachers', {
      method: 'POST',
      token: teacher,
      body: {
        attendance_date: '2025-04-11',
        entries: [{ teacher_id: teacherOne.id, status: ATTENDANCE_STATUS.PRESENT }],
      },
    });
    check(
      'a teacher may not — the seeded grants are narrower than FR-ATT-003’s actor list, and that is recorded',
      teacherMarksTeachers.status,
      403
    );
    check('and it is the permission refusing', codeOf(teacherMarksTeachers), 'INSUFFICIENT_PERMISSION');

    const foreignTeacherMark = await call('/attendance/teachers', {
      method: 'POST',
      token: principalA,
      body: {
        attendance_date: '2025-04-11',
        entries: [{ teacher_id: foreignTeacher.id, status: ATTENDANCE_STATUS.PRESENT }],
      },
    });
    check('a teacher of another school cannot be marked', foreignTeacherMark.status, 422);

    /* ── isolation, including the branch every §15 suite left unexecuted ── */

    await db.StudentAttendance.create({
      school_id: schoolD.id,
      organization_id: org.id,
      student_id: dKid.id,
      class_id: dClass.id,
      attendance_date: '2025-04-10',
      status: ATTENDANCE_STATUS.PRESENT,
      marked_at: new Date(),
    });

    const listA = await expectOk('/attendance/students?attendance_date=2025-04-10', { token: principalA }, 200);
    check('school A sees only its own register', dataOf(listA).length, 4);
    check(
      'and school D is not in it',
      dataOf(listA).some((r) => Number(r.school_id) === schoolD.id),
      false
    );
    const listD = await expectOk('/attendance/students?attendance_date=2025-04-10', { token: principalD }, 200);
    check('while school D sees only its own', dataOf(listD).length, 1);

    /*
     * The organization-scoped branch of `tenantWhere` — the shape §5a defects 16 and 22 are about,
     * and the one no §15 suite executed until `verify-staff.js` was corrected.
     */
    /*
     * An organization admin must name a school, and that is `requireModule`'s doing rather than this
     * module's. Two schools in one organization can be on two different plans, so there is no single
     * entitlement to gate on — `resolveGatedSchoolId` refuses with 400 rather than guessing which
     * plan applies. Worth asserting because it is surprising: the caller *is* authorised, and the
     * refusal comes from the entitlement layer, not from permissions or isolation.
     */
    const orgAll = await call('/attendance/students?attendance_date=2025-04-10', { token: orgAdmin });
    check('an organization admin naming no school is refused', orgAll.status, 400);
    check('and told why', codeOf(orgAll), 'SCHOOL_CONTEXT_REQUIRED');

    const orgScoped = await expectOk(
      `/attendance/students?attendance_date=2025-04-10&school_id=${schoolD.id}`,
      { token: orgAdmin },
      200
    );
    check('naming one school works and scopes to it', dataOf(orgScoped).length, 1);
    const orgScopedA = await expectOk(
      `/attendance/students?attendance_date=2025-04-10&school_id=${schoolA.id}`,
      { token: orgAdmin },
      200
    );
    check('and naming the other gives the other', dataOf(orgScopedA).length, 4);

    const dReport = await expectOk(
      `/attendance/students/report?period=daily&date=2025-04-10`,
      { token: principalD },
      200
    );
    check('a report is tenant-scoped too', dataOf(dReport).report.marked, 1);

    const platformList = await call('/attendance/students?attendance_date=2025-04-10', { token: platform });
    check('the platform admin sees across schools', platformList.status, 200);

    /* ── the activity trail ── */

    const activity = await settle(
      () => db.ActivityLog.findAll({
        where: { id: { [db.Op.gt]: baseline.activityLog } },
        order: [['id', 'ASC']],
      }),
      (rows) => new Set(
        rows
          .filter((r) => r.entity_type === 'student_attendance' || r.entity_type === 'teacher_attendance')
          .map((r) => r.entity_type)
      ).size >= 2
    );
    const attendanceActivity = activity.filter(
      (r) => r.entity_type === 'student_attendance' || r.entity_type === 'teacher_attendance'
    );
    check('marking a register is recorded in the activity trail', attendanceActivity.length > 0, true);
    check(
      'both registers appear',
      [...new Set(attendanceActivity.map((r) => r.entity_type))].sort(),
      ['student_attendance', 'teacher_attendance']
    );
    /* Read as model instances: under `raw: true` MariaDB hands a JSON column back as a string. */
    check(
      'a correction\'s reason is kept on its activity row, and a mark sent without one records none',
      [
        attendanceActivity.filter((r) => r.metadata && r.metadata.reason === 'Arrived after the register was taken').length,
        attendanceActivity.filter((r) => r.metadata && 'reason' in r.metadata).length,
      ],
      [1, 1]
    );
    /*
     * And deliberately NOT in audit_logs: `marked_by` / `marked_at` on the row is this table's own
     * provenance, so a per-child audit row would duplicate it at ~200x the volume. Asserted so the
     * absence reads as the decision it is.
     */
    await quiesce();
    const attendanceAudits = await db.AuditLog.findAll({
      where: {
        id: { [db.Op.gt]: baseline.auditLog },
        table_name: { [db.Op.in]: ['student_attendance', 'teacher_attendance'] },
      },
    });
    check('and deliberately not in audit_logs — the row carries its own marker', attendanceAudits.length, 0);
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-attendance Part 3 teardown failed:', err);
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
    console.error('\nverify-attendance crashed:', err);
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
          ? 'All pure attendance checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All attendance checks passed (Parts 1–3).'
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
