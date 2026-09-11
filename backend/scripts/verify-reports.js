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
 * Verification of Phase 3.U — reports — `src/modules/reports/*` — SRS §22, FR-REPORT-001 and
 * FR-REPORT-002.
 *
 * ## Every number in the fixture is chosen so it cannot be right by coincidence
 *
 * An aggregation is exactly where an assertion passes for the wrong reason: a sum over one row is also
 * that row, a count of one is also a boolean, and a percentage over two items is 50% whichever way the
 * formula is written. So the fixture uses **distinct, prime-ish, deliberately unequal** values — five
 * students across three statuses and two genders, fees of 1000/2500/700 against payments of 400/2500/0,
 * results at 91/64/38 — and every assertion states a number that only the right query produces.
 *
 * ## The two delegated reports are asserted to be IDENTICAL to their source
 *
 * §22's Attendance and Expense reports call §16's and §18's own computations. The strongest possible
 * assertion is not that they return something plausible, but that they return **exactly** what
 * `/attendance/students/report` and `/finance/report` return for the same query — so the suite calls
 * both endpoints and compares the payloads field by field. If §22 ever starts recomputing, that
 * assertion is what breaks.
 *
 * ## The permission composition is the security surface
 *
 * `reports.view` reaches Librarian and Teacher, who cannot read finance or fees directly. Each route
 * therefore requires two keys, and the suite proves the narrowing from both sides: a Librarian holding
 * `reports.view` is refused the Expense Report, and an Accountant holding both gets it.
 *
 * Part 1 — request schemas (no database).
 * Part 2 — the declared route table, the guards and the permission composition.
 * Part 3 — over real HTTP against the real database, including a real Excel export.
 *
 * Run: node scripts/verify-reports.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const entitlementService = require('../src/services/entitlementService');

const reportRoutes = require('../src/modules/reports/reports.routes');
const { schemas, SUPPORTED_FORMATS } = require('../src/modules/reports/reports.validation');
const service = require('../src/modules/reports/reports.service');
const controller = require('../src/modules/reports/reports.controller');

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
  STUDENT_STATUS,
  ACADEMIC_SESSION_STATUS,
  ATTENDANCE_STATUS,
  REPORT_TYPE_LIST,
  REPORT_FORMATS,
  FEE_COMPONENTS,
  STUDENT_FEE_STATUS,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  EXAM_STATUS,
} = require('../src/config/constants');
const { DEFAULT_ROLE_PERMISSIONS } = require('../src/config/permissions');
const { settle, quiesce } = require('./lib/settle');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-reports.local';
const PASSWORD = 'Verify@Reports123';
const CODE_PREFIX = 'VRP-';

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
  return { ok: !error, value: cleaned, keys: error ? error.details.map((d) => d.path.join('.')) : [] };
}

/** Source with comments stripped, so a probe cannot match explanatory prose — §5a session 18. */
function stripped(relative) {
  return fs
    .readFileSync(path.join(__dirname, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function routesOf(router) {
  return router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
}

function handlerNames(router, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath);
  return layer ? layer.route.stack.map((s) => s.handle.name || '(anon)') : [];
}

/* ═══════════════════════════ part 1 — request schemas ═══════════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas ──\n');

  check('§22 names seven reports, and the constants hold exactly those',
    [...REPORT_TYPE_LIST].sort(),
    ['attendance', 'exam', 'expense', 'fee', 'student', 'subscription', 'teacher']);
  check('and there is a schema for each of the seven',
    Object.keys(schemas).sort(),
    ['attendance', 'exams', 'expenses', 'fees', 'students', 'subscriptions', 'teachers']);

  check('every report defaults to the un-exported form', [
    run(schemas.students, {}).value.format,
    run(schemas.exams, {}).value.format,
    run(schemas.subscriptions, {}).value.format,
  ], [REPORT_FORMATS.JSON, REPORT_FORMATS.JSON, REPORT_FORMATS.JSON]);

  /*
   * §22 names PDF, Excel and Print. Two of the three are produced; `print` is refused rather than
   * accepted and answered with JSON, because §22 says only *"User prints the report"* and there is no
   * view engine anywhere in this application to produce the HTML that would mean. A caller who asks
   * for it must be told no, not handed something else.
   */
  check('excel is accepted', run(schemas.students, { format: REPORT_FORMATS.EXCEL }).ok, true);
  check('  and so is pdf, since Phase 5.4 rendered it', run(schemas.students, { format: REPORT_FORMATS.PDF }).ok, true);
  check('  while `print` is still REFUSED, not silently downgraded to JSON',
    run(schemas.students, { format: REPORT_FORMATS.PRINT }).ok, false);
  check('  the supported set being exactly json, excel and pdf',
    [...SUPPORTED_FORMATS].sort(), ['excel', 'json', 'pdf']);
  check('an invented format is refused too', run(schemas.students, { format: 'csv' }).ok, false);

  check('a transposed window is refused rather than answered with nothing',
    [
      run(schemas.students, { from: '2026-01-01', to: '2026-02-01' }).ok,
      run(schemas.students, { from: '2026-02-01', to: '2026-01-01' }).ok,
    ],
    [true, false]);

  check('the student report filters by §15.1\'s own status vocabulary',
    [
      run(schemas.students, { status: STUDENT_STATUS.ACTIVE }).ok,
      run(schemas.students, { status: 'enrolled' }).ok,
    ],
    [true, false]);

  /*
   * The two delegated reports validate against the OWNING module's schema, not a copy. So §16's
   * requirements — period required, and its three-value vocabulary — reach §22 unchanged, and there is
   * no way for the two endpoints to disagree about what they will answer.
   */
  const attendanceOwn = require('../src/modules/attendance/attendance.validation').schemas.report;
  check('the attendance report reuses §16\'s own schema rather than copying it', [
    run(schemas.attendance, {}).ok,
    run(schemas.attendance, { period: 'monthly', date: '2026-03-01' }).ok,
    run(schemas.attendance, { period: 'fortnightly', date: '2026-03-01' }).ok,
  ], [false, true, false]);
  check('  proved by comparing what each accepts, on a query neither module wrote for the other',
    ['weekly', 'daily', 'yearly'].map((p) => {
      const q = { period: p, date: '2026-03-01' };
      return run(schemas.attendance, q).ok === run(attendanceOwn, q).ok;
    }),
    [true, true, true]);

  const financeOwn = require('../src/modules/finance/finance.validation').schemas.report;
  check('and the expense report reuses §18\'s',
    ['USD', 'PKR'].map((c) => {
      const q = { currency: c, from: '2026-01-01' };
      return run(schemas.expenses, q).ok === run(financeOwn, q).ok;
    }),
    [true, true]);
}

/* ═══════════════════════ part 2 — the declared route table ═══════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — the router as declared ──\n');

  check('the seven routes, one per §22 report', routesOf(reportRoutes), [
    'GET /students',
    'GET /attendance',
    'GET /fees',
    'GET /expenses',
    'GET /exams',
    'GET /teachers',
    'GET /subscriptions',
  ]);
  check('every one is a GET — §22 has no table of its own, so a report writes nothing',
    reportRoutes.stack.filter((l) => l.route).every((l) => l.route.methods.get), true);

  check('no router-level guard at all', reportRoutes.stack.filter((l) => !l.route).length, 0);

  const src = stripped('../src/modules/reports/reports.routes.js');

  /* ── the permission composition, which is the security surface ── */

  check('every school report carries reports.view AND the owning module\'s own read',
    (src.match(/requirePermission\('reports\.view'\)/g) || []).length, 1);
  check('  written once for six routes, so the six cannot drift apart',
    (src.match(/for \(const report of SCHOOL_REPORTS\)/g) || []).length, 1);
  check('  and the six second permissions are the owning modules\'',
    ['students.view', 'attendance.view', 'fees.view', 'exams.view', 'teachers.view', 'finance.view']
      .every((k) => src.includes(`'${k}'`)),
    true);
  check('the subscription report answers to its own key instead',
    /requirePermission\('reports\.subscription\.view'\)/.test(src), true);

  /* The catalogue is fixed by §29/§35, so this is an assertion about it. */
  const holders = (k) => Object.entries(DEFAULT_ROLE_PERMISSIONS)
    .filter(([, v]) => Array.isArray(v) && v.includes(k)).map(([r]) => r).sort();
  check('reports.view reaches roles the underlying modules do not — which is why two keys are required',
    holders('reports.view').filter((r) => !holders('finance.view').includes(r)),
    ['librarian', 'teacher']);
  check('  and reports.subscription.view reaches only the two scopes with no single school',
    holders('reports.subscription.view'), ['organization_admin', 'super_admin']);

  /* ── the module gates ── */

  check('the six school reports name BOTH modules — reporting, and the thing reported on',
    /requireModule\(MODULES\.REPORTS, report\.module\)/.test(src), true);
  check('  and the subscription report names none, because a module gate resolves one school',
    handlerNames(reportRoutes, '/subscriptions').length < handlerNames(reportRoutes, '/students').length,
    true);

  /* ── the export ── */

  check('the export permission is conditional on there being an export',
    /function requireExportPermission/.test(src), true);
  check('  and it runs after validate, so it sees the coerced format',
    (() => {
      const n = handlerNames(reportRoutes, '/students');
      return n.indexOf('validateRequest') < n.indexOf('requireExportPermission');
    })(),
    true);
  check('  wrapping the real permission middleware rather than reimplementing the check',
    /const guard = requirePermission\('reports\.export'\)/.test(src), true);
  /*
   * And that it actually DELEGATES to it. An earlier draft probed only the declaration, so neutering
   * the guard to `return next()` left both checks true — the guard existed and was simply never used.
   */
  check('  and delegates to it for a real export rather than waving one through',
    /return guard\(req, res, next\);/.test(src), true);

  /* ── no second source of truth ── */

  const svc = stripped('../src/modules/reports/reports.service.js');
  check('the attendance report delegates to §16 rather than querying attendance itself',
    [/attendanceService\.report\(req, query\)/.test(svc), /db\.StudentAttendance/.test(svc)],
    [true, false]);
  check('and the expense report delegates to §18 rather than summing expenses itself',
    [/financeService\.report\(req, query\)/.test(svc), /db\.Expense/.test(svc)],
    [true, false]);
  check('the exam report reads §19\'s STORED columns and recomputes no position',
    [/col\('percentage'\)/.test(svc), /position/.test(svc)], [true, false]);

  check('all seven builders are registered under §22\'s own names',
    Object.keys(service.BUILDERS).sort(), [...REPORT_TYPE_LIST].sort());
  check('and REPORT_TYPES now has a consumer, having had none',
    /REPORT_TYPES\./.test(svc), true);
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

  async function call(pathname, { method = 'GET', body, token, raw = false } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + pathname, { method, headers, body: payload });
    if (raw) {
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        disposition: res.headers.get('content-disposition'),
        buffer: Buffer.from(await res.arrayBuffer()),
      };
    }
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* left null */ }
    return { status: res.status, body: parsed, raw: text };
  }

  const codeOf = (r) => (r.body && r.body.error ? r.body.error.code : `no-error:${r.status}`);
  const dataOf = (r) => (r.body && r.body.data !== undefined ? r.body.data : null);

  async function expectOk(pathname, options, wantStatus) {
    const res = await call(pathname, options);
    if (res.status !== wantStatus) {
      throw new Error(`${options.method || 'GET'} ${pathname} expected ${wantStatus}, got ${res.status}: ${res.raw}`);
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
      await db.Result.destroy({ where: { school_id: created.schools } });
      await db.Exam.destroy({ where: { school_id: created.schools } });
      await db.StudentAttendance.destroy({ where: { school_id: created.schools } });
      await db.FeePayment.destroy({ where: { school_id: created.schools } });
      await db.StudentFee.destroy({ where: { school_id: created.schools } });
      await db.FeeStructure.destroy({ where: { school_id: created.schools } });
      await db.Expense.destroy({ where: { school_id: created.schools } });
      await db.Income.destroy({ where: { school_id: created.schools } });
      await db.Student.destroy({ where: { school_id: created.schools }, force: true });
      await db.Teacher.destroy({ where: { school_id: created.schools }, force: true });
      await db.Section.destroy({ where: { school_id: created.schools }, force: true });
      await db.Class.destroy({ where: { school_id: created.schools }, force: true });
      await db.AcademicSession.destroy({ where: { school_id: created.schools }, force: true });
      await db.SchoolSetting.destroy({ where: { school_id: created.schools } });
    }
    if (created.subscriptions.length) {
      await db.UsageRecord.destroy({ where: { subscription_id: created.subscriptions } });
      await db.Subscription.destroy({ where: { id: created.subscriptions }, force: true });
    }
    await db.User.destroy({ where: { email: { [db.Op.like]: `%@${DOMAIN}` } }, force: true });
    const planWhere = {
      [db.Op.or]: [
        { code: { [db.Op.like]: `${CODE_PREFIX}%` } },
        ...(created.plans.length ? [{ id: created.plans }] : []),
      ],
    };
    const stale = (await db.SubscriptionPlan.findAll({ where: planWhere, attributes: ['id'] })).map((p) => p.id);
    if (stale.length) {
      await db.PlanModule.destroy({ where: { plan_id: stale } });
      await db.PlanLimit.destroy({ where: { plan_id: stale } });
      await db.PlanFeature.destroy({ where: { plan_id: stale } });
      await db.SubscriptionPlan.destroy({ where: { id: stale }, force: true });
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
    for (const slug of [ROLES.PRINCIPAL, ROLES.TEACHER, ROLES.ACCOUNTANT, ROLES.LIBRARIAN,
      ROLES.ORGANIZATION_ADMIN, ROLES.SUPER_ADMIN]) {
      // eslint-disable-next-line no-await-in-loop
      const role = await db.Role.findOne({ where: { slug } });
      if (!role) throw new Error(`seeded role missing: ${slug}`);
      roles[slug] = role;
    }

    /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
    const residueCleared = await sweepResidue(db, { codes: ['VRP-'], domains: ['verify-reports.local'] });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({ name: 'Verify Reports Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Reports A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Reports B');   /* no REPORTS module */
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Reports D');   /* another school */

    const mkPlan = async (code, reportsEnabled) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify Reports ${code}`, code: `${CODE_PREFIX}${code}`, status: PLAN_STATUS.ACTIVE,
        tier_rank: 1, trial_days: 0, grace_period_days: 7,
      });
      created.plans.push(plan.id);
      for (const key of MODULE_LIST) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanModule.create({
          plan_id: plan.id, module_key: key, is_enabled: key === MODULES.REPORTS ? reportsEnabled : true,
        });
      }
      for (const k of [LIMITS.STUDENT_LIMIT, LIMITS.TEACHER_LIMIT]) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanLimit.create({ plan_id: plan.id, limit_key: k, limit_type: LIMIT_TYPES.FIXED, limit_value: 100 });
      }
      return plan;
    };
    const withReports = await mkPlan('WITH', true);
    const withoutReports = await mkPlan('WITHOUT', false);

    const subscribe = async (school, plan, state = SUBSCRIPTION_STATES.ACTIVE) => {
      const now = new Date();
      const sub = await db.Subscription.create({
        school_id: school.id, organization_id: org.id, plan_id: plan.id,
        state, billing_cycle: BILLING_CYCLES.MONTHLY, cycle_amount: 100,
        starts_at: now, current_period_start: now,
        current_period_end: new Date(now.getTime() + 30 * 864e5), grace_period_days: 7,
      });
      created.subscriptions.push(sub.id);
      return sub;
    };
    await subscribe(schoolA, withReports);
    await subscribe(schoolB, withoutReports);
    await subscribe(schoolD, withReports, SUBSCRIPTION_STATES.TRIAL);

    const session = await db.AcademicSession.create({
      school_id: schoolA.id, organization_id: org.id, name: 'A 2025-2026',
      start_date: '2025-04-01', end_date: '2026-03-31', status: ACADEMIC_SESSION_STATUS.ACTIVE, is_current: true,
    });
    const grade1 = await db.Class.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id, name: 'Grade 1', numeric_order: 1,
    });
    const grade2 = await db.Class.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id, name: 'Grade 2', numeric_order: 2,
    });

    /*
     * FIVE students, deliberately unequal across every axis: 3 active / 1 left / 1 transferred,
     * 2 female / 3 male, 3 in Grade 1 / 2 in Grade 2. No count here is 1, and no two counts are equal,
     * so an assertion cannot pass by a query returning the wrong grouping.
     */
    const mkStudent = async (key, first, klass, status, gender) =>
      db.Student.create({
        school_id: schoolA.id, organization_id: org.id, student_id: `${CODE_PREFIX}${key}`,
        first_name: first, admission_date: '2025-04-01', status, gender,
        class_id: klass.id, academic_session_id: session.id,
      });
    const s1 = await mkStudent('S1', 'Amina', grade1, STUDENT_STATUS.ACTIVE, 'female');
    const s2 = await mkStudent('S2', 'Bilal', grade1, STUDENT_STATUS.ACTIVE, 'male');
    const s3 = await mkStudent('S3', 'Carim', grade1, STUDENT_STATUS.ACTIVE, 'male');
    const s4 = await mkStudent('S4', 'Dina', grade2, STUDENT_STATUS.LEFT, 'female');
    const s5 = await mkStudent('S5', 'Emre', grade2, STUDENT_STATUS.TRANSFERRED, 'male');

    /* Four teachers: 3 active / 1 not, across two designations of 3 and 1. */
    const mkTeacher = async (key, first, active, designation) =>
      db.Teacher.create({
        school_id: schoolA.id, organization_id: org.id, employee_id: `${CODE_PREFIX}${key}`,
        first_name: first, joining_date: '2024-01-15', is_active: active, designation,
      });
    await mkTeacher('T1', 'Nadia', true, 'Senior Teacher');
    await mkTeacher('T2', 'Omar', true, 'Senior Teacher');
    await mkTeacher('T3', 'Priya', true, 'Senior Teacher');
    await mkTeacher('T4', 'Qasim', false, 'Lab Assistant');

    /* Attendance: 7 present, 2 absent, 1 late over one day — 10 marked, 8 attended, 80.00%. */
    const markDay = async (student, status) =>
      db.StudentAttendance.create({
        school_id: schoolA.id, organization_id: org.id, student_id: student.id,
        class_id: student.class_id, academic_session_id: session.id,
        attendance_date: '2026-03-02', status,
      });
    for (const s of [s1, s2, s3, s4, s5]) await markDay(s, ATTENDANCE_STATUS.PRESENT);
    await db.StudentAttendance.create({
      school_id: schoolA.id, organization_id: org.id, student_id: s1.id, class_id: s1.class_id,
      academic_session_id: session.id, attendance_date: '2026-03-03', status: ATTENDANCE_STATUS.PRESENT,
    });
    await db.StudentAttendance.create({
      school_id: schoolA.id, organization_id: org.id, student_id: s2.id, class_id: s2.class_id,
      academic_session_id: session.id, attendance_date: '2026-03-03', status: ATTENDANCE_STATUS.PRESENT,
    });
    await db.StudentAttendance.create({
      school_id: schoolA.id, organization_id: org.id, student_id: s3.id, class_id: s3.class_id,
      academic_session_id: session.id, attendance_date: '2026-03-03', status: ATTENDANCE_STATUS.ABSENT,
    });
    await db.StudentAttendance.create({
      school_id: schoolA.id, organization_id: org.id, student_id: s4.id, class_id: s4.class_id,
      academic_session_id: session.id, attendance_date: '2026-03-03', status: ATTENDANCE_STATUS.ABSENT,
    });
    await db.StudentAttendance.create({
      school_id: schoolA.id, organization_id: org.id, student_id: s5.id, class_id: s5.class_id,
      academic_session_id: session.id, attendance_date: '2026-03-03', status: ATTENDANCE_STATUS.LATE,
    });

    /* Fees: billed 1000 + 2500 + 700 = 4200; collected 400 + 2500 + 0 = 2900; outstanding 1300. */
    const structure = await db.FeeStructure.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      class_id: grade1.id, name: 'Tuition', component: FEE_COMPONENTS.MONTHLY_FEE, amount: 1000,
    });
    const mkFee = async (student, net, paid, status) =>
      db.StudentFee.create({
        school_id: schoolA.id, organization_id: org.id, student_id: student.id,
        fee_structure_id: structure.id, academic_session_id: session.id, class_id: grade1.id,
        component: FEE_COMPONENTS.MONTHLY_FEE, title: 'Tuition',
        amount: net, net_amount: net, paid_amount: paid, due_date: '2026-02-10', status, currency: 'USD',
      });
    await mkFee(s1, 1000, 400, STUDENT_FEE_STATUS.PARTIALLY_PAID);
    await mkFee(s2, 2500, 2500, STUDENT_FEE_STATUS.PAID);
    await mkFee(s3, 700, 0, STUDENT_FEE_STATUS.UNPAID);
    /*
     * A fee in a SECOND currency, so the multi-currency refusal has something to refuse. Without it
     * that guard could be deleted and every assertion here would still pass — a deliberate regression
     * proved exactly that.
     */
    await db.StudentFee.create({
      school_id: schoolA.id, organization_id: org.id, student_id: s4.id,
      fee_structure_id: structure.id, academic_session_id: session.id, class_id: grade2.id,
      component: FEE_COMPONENTS.MONTHLY_FEE, title: 'Tuition (PKR)',
      amount: 5000, net_amount: 5000, paid_amount: 0, due_date: '2026-02-10',
      status: STUDENT_FEE_STATUS.UNPAID, currency: 'PKR',
    });
    /*
     * And an OVER-payment, so `outstanding` has a negative to report. Clamping it to zero would hide
     * money a school owes back; nothing else in the fixture can show that.
     */
    await db.StudentFee.create({
      school_id: schoolA.id, organization_id: org.id, student_id: s5.id,
      fee_structure_id: structure.id, academic_session_id: session.id, class_id: grade2.id,
      component: FEE_COMPONENTS.MONTHLY_FEE, title: 'Overpaid',
      amount: 100, net_amount: 100, paid_amount: 250, due_date: '2026-02-10',
      status: STUDENT_FEE_STATUS.PAID, currency: 'USD',
    });

    /* Finance: expenses 300 + 150 = 450, income 900 → net balance 450. */
    await db.Expense.create({
      school_id: schoolA.id, organization_id: org.id, category: EXPENSE_CATEGORIES.OTHER_EXPENSES,
      title: 'Stationery', amount: 300, expense_date: '2026-02-05', currency: 'USD',
    });
    await db.Expense.create({
      school_id: schoolA.id, organization_id: org.id, category: EXPENSE_CATEGORIES.SALARIES,
      /* §18's model requires a salary expense to identify who it was paid to. */
      title: 'March salaries', amount: 150, expense_date: '2026-02-20', currency: 'USD',
      paid_to: 'Nadia (Senior Teacher)',
    });
    await db.Income.create({
      /* §18's income categories are a fixed enum of two — `fees` and `other_income`. */
      school_id: schoolA.id, organization_id: org.id, category: INCOME_CATEGORIES.OTHER_INCOME,
      title: 'Donation', amount: 900, income_date: '2026-02-10', currency: 'USD',
    });

    /* Exams: three stored results — 91 pass A, 64 pass B, 38 fail F. Average 64.33. */
    const exam = await db.Exam.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      name: 'Mid Term', exam_type: 'midterm', class_id: grade1.id,
      start_date: '2026-02-01', end_date: '2026-02-10', status: EXAM_STATUS.PUBLISHED,
    });
    const mkResult = async (student, pct, grade, outcome) =>
      db.Result.create({
        school_id: schoolA.id, organization_id: org.id, exam_id: exam.id, student_id: student.id,
        class_id: grade1.id, total_full_marks: 100, total_marks_obtained: pct,
        percentage: pct, grade_name: grade, outcome, subjects_count: 1, subjects_failed: outcome === 'fail' ? 1 : 0,
      });
    await mkResult(s1, 91, 'A', 'pass');
    await mkResult(s2, 64, 'B', 'pass');
    await mkResult(s3, 38, 'F', 'fail');

    /* An exam nobody sat, so the empty-set branch has something to report on. */
    const emptyExam = await db.Exam.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      name: 'Nobody Sat', exam_type: 'quiz', class_id: grade2.id,
      start_date: '2026-02-01', end_date: '2026-02-10', status: EXAM_STATUS.PUBLISHED,
    });

    const password_hash = await hashPassword(PASSWORD);
    const mkUser = async (key, slug, organization_id, school_id) => {
      const u = await db.User.create({
        role_id: roles[slug].id, organization_id, school_id, name: `Verify RP ${key}`,
        email: `${key}@${DOMAIN}`, username: `vrp_${key.replace(/-/g, '_')}`,
        password_hash, status: USER_STATUS.ACTIVE, must_change_password: false,
      });
      created.users.push(u.id);
      return u;
    };
    await mkUser('principal-a', ROLES.PRINCIPAL, org.id, schoolA.id);
    await mkUser('principal-b', ROLES.PRINCIPAL, org.id, schoolB.id);
    await mkUser('principal-d', ROLES.PRINCIPAL, org.id, schoolD.id);
    await mkUser('teacher', ROLES.TEACHER, org.id, schoolA.id);
    await mkUser('accountant', ROLES.ACCOUNTANT, org.id, schoolA.id);
    await mkUser('librarian', ROLES.LIBRARIAN, org.id, schoolA.id);
    await mkUser('org-admin', ROLES.ORGANIZATION_ADMIN, org.id, null);
    /*
     * A platform caller, with neither an organization nor a school. `resolveTenant.js:108-117`
     * gives any `PLATFORM_ROLES` slug `{ isPlatform: true, organizationId: null, schoolId: null }`
     * whatever the columns hold, so the nulls here are the honest shape rather than a workaround.
     */
    await mkUser('super-admin', ROLES.SUPER_ADMIN, null, null);

    async function signIn(identifier) {
      const res = await call('/auth/login', { method: 'POST', body: { identifier, password: PASSWORD } });
      const token = res.body && res.body.data ? res.body.data.accessToken : null;
      if (!token) throw new Error(`sign-in failed for ${identifier}: ${res.raw}`);
      return token;
    }
    const principalA = await signIn(`principal-a@${DOMAIN}`);
    const principalB = await signIn(`principal-b@${DOMAIN}`);
    const principalD = await signIn(`principal-d@${DOMAIN}`);
    const teacher = await signIn(`teacher@${DOMAIN}`);
    const accountant = await signIn(`accountant@${DOMAIN}`);
    const librarian = await signIn(`librarian@${DOMAIN}`);
    const orgAdmin = await signIn(`org-admin@${DOMAIN}`);
    const superAdmin = await signIn(`super-admin@${DOMAIN}`);

    /* ── the module gate ── */

    const moduleDenied = await call('/reports/students', { token: principalB });
    check('a plan without the Reports module refuses', moduleDenied.status, 403);
    check('  naming it', moduleDenied.body.error.details.missing.includes(MODULES.REPORTS), true);

    /* ── 1. Student Report ── */

    /*
     * `call` rather than `expectOk`: a regression that breaks the grouping should FAIL by name rather
     * than abort the run. §5a session 22's lesson — a crash is a detection, but a bad one.
     */
    const studentsRes = await call('/reports/students', { token: principalA });
    check('the Student Report is served', studentsRes.status, 200);
    const students = ((dataOf(studentsRes) || {}).report) || {};
    check('FR-REPORT-001 — the Student Report counts the school\'s students', students.total, 5);
    const byStatus = students.by_status || {};
    const byGender = students.by_gender || {};
    check('  by §15.1\'s status vocabulary, and the three statuses are not equal',
      [byStatus.active, byStatus.left, byStatus.transferred], [3, 1, 1]);
    check('  with the statuses nobody holds reported as zero rather than omitted',
      [byStatus.promoted, byStatus.graduated], [0, 0]);
    check('  by gender', [byGender.male, byGender.female], [3, 2]);
    check('  and by class, NAMED rather than left as ids',
      (students.by_class || []).map((c) => [c.class_name, c.count]).sort(),
      [['Grade 1', 3], ['Grade 2', 2]]);
    check('  each with its session, since every year has a Grade 1 and only a principal can read the list',
      (students.by_class || []).every((c) => c.academic_session_id && typeof c.session_name === 'string'), true);
    /* D35 — the report is headed with the name the school uses, which an export prints. */
    const displayName = await db.SchoolSetting.create({
      school_id: schoolA.id, organization_id: org.id, name: 'Verify Reports Display Name',
    });
    check('D35 — a report is headed with the school\'s display name once it has set one',
      dataOf(await expectOk('/reports/students', { token: principalA }, 200)).report.school.name,
      'Verify Reports Display Name');
    await displayName.destroy();
    check('a status filter narrows it',
      dataOf(await expectOk(`/reports/students?status=${STUDENT_STATUS.ACTIVE}`, { token: principalA }, 200)).report.total,
      3);
    check('  and a class filter narrows it differently, so neither passes by coincidence',
      dataOf(await expectOk(`/reports/students?class_id=${grade2.id}`, { token: principalA }, 200)).report.total,
      2);

    /* ── 2. Attendance Report — asserted IDENTICAL to §16's ── */

    const q = 'period=monthly&date=2026-03-02';
    const viaReports = dataOf(await expectOk(`/reports/attendance?${q}`, { token: principalA }, 200)).report;
    /* §16 wraps its payload in `{ report: … }`, so the comparison must unwrap it. */
    const viaAttendance = dataOf(await expectOk(`/attendance/students/report?${q}`, { token: principalA }, 200)).report;

    check('FR-REPORT-001 — the Attendance Report counts the register',
      [viaReports.marked, viaReports.attended], [10, 8]);
    check('  at §16\'s own percentage, (present + late) / marked', viaReports.percentage, 80);
    /* §16's vocabulary is present / absent / leave / late — there is no `excused`. */
    check('  with §16\'s four statuses broken out, including the one nobody was marked',
      [viaReports.counts.present, viaReports.counts.absent, viaReports.counts.late, viaReports.counts.leave],
      [7, 2, 1, 0]);
    /*
     * The strongest assertion in this suite: §22 returns EXACTLY what §16 returns. If §22 ever starts
     * computing its own attendance figures, this is what breaks — not a plausibility check.
     */
    check('and it is IDENTICAL to §16\'s own report, field for field — one source of truth',
      ['period', 'label', 'from', 'to', 'counts', 'marked', 'attended', 'percentage']
        .map((k) => JSON.stringify(viaReports[k]) === JSON.stringify(viaAttendance[k])),
      [true, true, true, true, true, true, true, true]);
    check('  the §22 envelope naming where the number came from', viaReports.delegated_to, 'attendance.report');

    /* ── 3. Fee Report ── */

    /*
     * A currency must be named: the fixture deliberately holds two, and §18's rule — inherited here —
     * is that one total across two currencies means nothing.
     */
    const mixed = await call('/reports/fees', { token: accountant });
    check('a window holding two currencies is refused rather than silently added together',
      mixed.status, 422);
    check('  naming the currencies to choose between',
      mixed.body.error.details[0].field, 'currency');

    const fees = dataOf(await expectOk('/reports/fees?currency=USD', { token: accountant }, 200)).report;
    check('FR-REPORT-001 — the Fee Report totals what was billed', fees.billed, 4300);
    check('  and what was collected', fees.collected, 3150);
    check('  the difference being outstanding', fees.outstanding, 1150);
    check('  over four USD assignments, the PKR one excluded by the currency filter',
      [fees.assignments, fees.by_status.paid, fees.by_status.partially_paid, fees.by_status.unpaid],
      [4, 2, 1, 1]);
    /*
     * The over-payment, which is the case a clamp would hide. Asked for on its own so the negative is
     * visible rather than absorbed into the school-wide total.
     */
    const overpaid = dataOf(
      await expectOk(`/reports/fees?currency=USD&class_id=${grade2.id}`, { token: accountant }, 200)
    ).report;
    check('an over-payment reports a NEGATIVE outstanding rather than a clamped zero',
      [overpaid.billed, overpaid.collected, overpaid.outstanding], [100, 250, -150]);
    check('  none of which is a coincidence — billed, collected and outstanding are all distinct',
      new Set([fees.billed, fees.collected, fees.outstanding]).size, 3);

    /* ── 4. Expense Report — asserted IDENTICAL to §18's ── */

    const expViaReports = dataOf(await expectOk('/reports/expenses', { token: accountant }, 200)).report;
    const expViaFinance = dataOf(await expectOk('/finance/report', { token: accountant }, 200)).report;
    check('FR-REPORT-001 — the Expense Report carries §18\'s net balance',
      expViaReports.net_balance, expViaFinance.net_balance);
    check('  which is Income − Expense, and not zero by accident',
      [expViaReports.income.total, expViaReports.expense.total, expViaReports.net_balance],
      [900, 450, 450]);
    check('and it is IDENTICAL to §18\'s own report — one source of truth',
      ['income', 'expense', 'net_balance', 'currency'].map(
        (k) => JSON.stringify(expViaReports[k]) === JSON.stringify(expViaFinance[k])),
      [true, true, true, true]);
    check('  naming where the number came from', expViaReports.delegated_to, 'finance.report');

    /* ── 5. Exam Report ── */

    const exams = dataOf(await expectOk('/reports/exams', { token: teacher }, 200)).report;
    check('FR-REPORT-001 — the Exam Report counts §19\'s stored results', exams.results, 3);
    check('  reporting pass and fail from the stored outcome',
      [exams.by_outcome.pass, exams.by_outcome.fail], [2, 1]);
    check('  a pass rate that is not 50% or 100%, so the formula is visible', exams.pass_rate, 66.67);
    check('  and the spread of stored percentages',
      [exams.average_percentage, exams.highest_percentage, exams.lowest_percentage], [64.33, 91, 38]);
    check('  with the grade distribution §19 stored',
      [exams.by_grade.A, exams.by_grade.B, exams.by_grade.F], [1, 1, 1]);

    /*
     * An exam nobody sat has an UNKNOWN pass rate, not a 0% one — §16's own convention for its
     * attendance percentage, followed here. Reporting 0% would read as every candidate failing.
     */
    const emptyReport = dataOf(
      await expectOk(`/reports/exams?exam_id=${emptyExam.id}`, { token: teacher }, 200)
    ).report;
    check('an exam nobody sat reports an unknown pass rate, not a catastrophic zero',
      [emptyReport.results, emptyReport.pass_rate, emptyReport.average_percentage],
      [0, null, null]);
    /*
     * Of the two guards behind that assertion, only `average_percentage`'s is observable — and it is
     * the one that matters. SQL `AVG` over zero rows returns NULL and `Number(null)` is 0, so without
     * it this would read as an average of 0%: a real number where there is no data. `pass_rate`'s
     * guard is defensive only, because `passed / 0` is NaN and NaN serialises to `null` in JSON and to
     * an empty cell in exceljs — both measured. Recorded rather than asserted, because an assertion
     * that cannot fail is worse than none.
     */
    check('  the average being null and not the 0 that SQL AVG over no rows would yield',
      emptyReport.average_percentage, null);

    /* ── 6. Teacher Report ── */

    const teachers = dataOf(await expectOk('/reports/teachers', { token: principalA }, 200)).report;
    check('FR-REPORT-001 — the Teacher Report counts the school\'s teachers',
      [teachers.total, teachers.active, teachers.inactive], [4, 3, 1]);
    check('  grouped by the only taxonomy §15.3 gives a teacher',
      [teachers.by_designation['Senior Teacher'], teachers.by_designation['Lab Assistant']], [3, 1]);
    /*
     * The `is_active` filter is respected by the active count, not overridden by it. "Inactive only"
     * used to count every active teacher as active and report a negative number inactive.
     */
    const inactiveOnly = dataOf(await expectOk('/reports/teachers?is_active=false', { token: principalA }, 200)).report;
    const activeOnly = dataOf(await expectOk('/reports/teachers?is_active=true', { token: principalA }, 200)).report;
    check('  and filtered to inactive teachers it counts the one inactive teacher, none active — never a negative',
      [[inactiveOnly.total, inactiveOnly.active, inactiveOnly.inactive], [activeOnly.total, activeOnly.active, activeOnly.inactive]],
      [[1, 0, 1], [3, 3, 0]]);

    /* ── 7. Subscription Report ── */

    const subsRes = await call('/reports/subscriptions', { token: orgAdmin });
    check('the Subscription Report is served to an organization admin with no school', subsRes.status, 200);
    const subs = ((dataOf(subsRes) || {}).report) || { by_state: {}, by_plan: [], scope: {} };
    check('FR-REPORT-001 — the Subscription Report counts the organization\'s subscriptions', subs.total, 3);
    check('  by state, with two states unequal', [subs.by_state.active, subs.by_state.trial], [2, 1]);
    check('  scoped to the caller\'s organization rather than the platform', subs.scope.organization_id, org.id);
    /*
     * Grouped by plan, so the two subscriptions sharing one plan are ONE row with a count of two —
     * which is also what makes this assertion meaningful: an ungrouped query would return three rows.
     */
    check('  and naming the plan through the subscription, since the plan catalogue has no tenancy',
      (subs.by_plan || []).map((entry) => [entry.plan_name, entry.count]).sort(),
      [['Verify Reports WITH', 2], ['Verify Reports WITHOUT', 1]]);

    /* ── the permission composition, from both sides ── */

    const librarianExpense = await call('/reports/expenses', { token: librarian });
    check('a Librarian holds reports.view but not finance.view, so the Expense Report is refused',
      librarianExpense.status, 403);
    check('  on the permission, not the module', codeOf(librarianExpense), 'INSUFFICIENT_PERMISSION');
    const teacherFees = await call('/reports/fees', { token: teacher });
    check('and a Teacher is refused the Fee Report for the same reason', teacherFees.status, 403);
    /* A currency is named, because the fixture holds two and the bare call is correctly a 422. */
    check('while the Accountant who holds both keys gets it',
      (await call('/reports/fees?currency=USD', { token: accountant })).status, 200);
    check('and the Teacher gets the reports their own permissions reach',
      [(await call('/reports/students', { token: teacher })).status,
        (await call('/reports/exams', { token: teacher })).status],
      [200, 200]);

    const teacherSubs = await call('/reports/subscriptions', { token: teacher });
    check('the Subscription Report is refused to a school-side caller', teacherSubs.status, 403);
    /*
     * Refused by the permission today — but nothing stops a Super Admin granting a school role the key,
     * and the query then applied only the organization, so a school read all three schools'
     * subscriptions. Called on the service with a school tenant, which is the caller that grant makes.
     */
    const schoolScoped = await service.subscriptions(
      { tenant: { isPlatform: false, level: 'school', organizationId: org.id, schoolId: schoolA.id } }, {}
    );
    check('  and were a school role ever granted it, a school-scoped caller counts its own school only — §30 Rule 2',
      schoolScoped.total, 1);

    /* ── FR-REPORT-001's first-named actor, on the six school reports ── */

    /*
     * §22's actor list opens with **Super Admin** (SRS:1190), and the Reports screen used to state as
     * fact that the six school reports were unreachable for one: "Six of the seven resolve a school
     * before they can count anything, so a platform caller cannot run them at all." That premise was
     * false, and it was load-bearing — the screen rendered the six as inert cards on the strength of
     * it. These assertions are the measurement, so the claim cannot quietly become false again in
     * either direction.
     *
     * The chain: `entitlement.js:256` returns `next()` for `req.tenant.isPlatform` before any snapshot
     * loads, so `requireModule` never refuses; `permissions.js:254` gives SUPER_ADMIN `ALL`; every
     * school schema accepts `school_id`; and `schoolScope.js:46-53` REQUIRES then HONOURS the id for a
     * caller with no school of their own.
     *
     * **Which assertion catches which link was measured, not guessed, and one guess was wrong.**
     * Deleting the `isPlatform` short-circuit leaves the six answering 200 — the school named here is
     * subscribed to Reports on its own merits, so the module gate passes anyway. What that
     * short-circuit actually governs is the refusal seen by a caller who names NO school, which is
     * why the three assertions below it are the ones that flip. Each of the four breaks was applied
     * to the source and every resulting FAIL came from this block and nowhere else in the 106
     * assertions that preceded it.
     */
    const PLATFORM_RUNNABLE = [
      ['/reports/students', ''],
      ['/reports/attendance', '&period=monthly&date=2026-03-02'],
      ['/reports/fees', '&currency=USD'],
      ['/reports/expenses', '&currency=USD'],
      ['/reports/exams', ''],
      ['/reports/teachers', ''],
    ];
    const platformStatuses = [];
    for (const [path, extra] of PLATFORM_RUNNABLE) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(`${path}?school_id=${schoolA.id}${extra}`, { token: superAdmin });
      platformStatuses.push([path, res.status]);
    }
    check('FR-REPORT-001 — a platform caller runs all six school reports by naming ?school_id',
      platformStatuses,
      PLATFORM_RUNNABLE.map(([path]) => [path, 200]));

    /*
     * Not merely 200: the same numbers the school's own principal sees. A platform-wide count that
     * happened to answer 200 would pass the assertion above and be a different report.
     */
    const platformStudents = dataOf(await call(`/reports/students?school_id=${schoolA.id}`, { token: superAdmin }));
    check('  and it is that school’s report, not a platform-wide one — same totals as its principal',
      [platformStudents.report.total, (platformStudents.report.by_class || []).length],
      [students.total, (students.by_class || []).length]);

    /*
     * The refusal for a missing id is a 422 from `validate`-shaped `ApiError.validation`, NOT
     * `SCHOOL_CONTEXT_REQUIRED`. That code is raised only inside `resolveGatedSchoolId`
     * (entitlement.js:100-105), which sits AFTER the `isPlatform` short-circuit and is therefore
     * unreachable for this caller — the frontend named it anyway.
     */
    const noSchool = await call('/reports/students', { token: superAdmin });
    check('a platform caller who names no school is refused 422, not 403', noSchool.status, 422);
    check('  as a validation error rather than SCHOOL_CONTEXT_REQUIRED, which this caller cannot reach',
      codeOf(noSchool), 'VALIDATION_ERROR');
    check('  naming the field that is missing',
      (noSchool.body.error.details || []).map((d) => d.field), ['school_id']);

    /*
     * And the contrast that makes a school SELECTOR the right control rather than a fixed scope: the
     * SAME school id, refused to a principal scoped elsewhere and answered for the platform caller.
     * Asserted as one pair, because either half alone could pass for the wrong reason — a 200 might
     * mean the id was ignored, and a 403 might mean the school does not exist.
     */
    check('the same school id is refused to a principal scoped elsewhere and answered for a platform caller',
      [(await call(`/reports/students?school_id=${schoolD.id}`, { token: principalA })).status,
        (await call(`/reports/students?school_id=${schoolD.id}`, { token: superAdmin })).status],
      [403, 200]);


    /* ── FR-REPORT-002 — the export ── */

    const printFormat = await call('/reports/students?format=print', { token: principalA });
    check('`print` is refused rather than silently answered with JSON — §22 names it, but there is '
      + 'no view engine here to produce what it would mean',
      printFormat.status, 422);

    /* ── FR-REPORT-002's PDF half, Phase 5.4 ── */

    /*
     * Read back, the way the workbook below is. `pdf-parse` is a dependency and CANNOT do it — it
     * fails on an untouched pdfkit document with "Illegal character", measured this session — so the
     * content streams are inflated directly and the hex-encoded `TJ` operands decoded. That is enough
     * to prove the bytes contain the report rather than merely being a well-formed empty PDF.
     */
    const inflatePdf = (buffer) => {
      const zlib = require('zlib');
      const raw = buffer.toString('latin1');
      const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
      const parts = [];
      let match = streams.exec(raw);
      while (match !== null) {
        try { parts.push(zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')); }
        catch (_) { /* an uncompressed stream is not text we need */ }
        match = streams.exec(raw);
      }
      const body = parts.join('\n');
      return (body.match(/<([0-9A-Fa-f]+)>/g) || [])
        .map((hex) => Buffer.from(hex.slice(1, -1), 'hex').toString('latin1'))
        .join('');
    };
    const pdfPageCount = (buffer) => {
      const m = buffer.toString('latin1').match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/);
      return m ? Number(m[1]) : null;
    };

    /*
     * ── Premium Reports unlocks exports — the owner's decision D9, settling triage finding 64 ──
     *
     * School A's plan has the Reports module and, until this block adds it, not the `premium_reports`
     * feature — the one the Premium Reports add-on unlocks. So the same school shows both halves: a
     * refusal before, the export after. Granted here as a plan feature rather than through the add-on,
     * which also proves a plan may include it outright.
     */
    const withoutPremium = await call('/reports/students?format=pdf', { token: principalA });
    check('D9 — without Premium Reports a school cannot export a report',
      [withoutPremium.status, codeOf(withoutPremium)], [403, 'FEATURE_NOT_SUBSCRIBED']);
    check('  nor as Excel', (await call('/reports/students?format=excel', { token: principalA })).status, 403);
    check('  but still reads the same report on screen', (await call('/reports/students', { token: principalA })).status, 200);
    await db.PlanFeature.create({ plan_id: withReports.id, feature_key: 'premium_reports', is_enabled: true });
    await entitlementService.invalidatePlan(withReports.id);

    const pdf = await call('/reports/students?format=pdf', { token: principalA, raw: true });
    check('FR-REPORT-002 — a PDF export is produced', pdf.status, 200);
    check('  with the pdf content type', pdf.contentType, controller.PDF_MIME);
    check('  offered as a download with a dated .pdf filename',
      /attachment; filename="report-student-\d{4}-\d{2}-\d{2}\.pdf"/.test(pdf.disposition), true);
    check('  and the bytes really are a PDF, not JSON wearing a header',
      [pdf.buffer.slice(0, 5).toString(), pdf.buffer.toString('latin1').trimEnd().endsWith('%%EOF')],
      ['%PDF-', true]);
    check('  of at least one page', pdfPageCount(pdf.buffer) >= 1, true);

    const pdfText = inflatePdf(pdf.buffer);
    check('  whose text carries the report title and the column headers',
      ['student report', 'Section', 'Key', 'Value'].filter((t) => !pdfText.includes(t)), []);
    check('  and the same figures the JSON reports, not a plausible-looking blank',
      ['by_status', 'active', 'by_gender'].filter((t) => !pdfText.includes(t)), []);

    /*
     * The strongest assertion available: both exporters are fed by the SAME `toRows()` walk, so a PDF
     * that disagreed with the workbook could only come from one of them re-deriving the report. Every
     * key the rows produce must appear in the rendered text.
     */
    const sourceRows = service.toRows(dataOf(studentsRes).report);
    check('  every row of the shared toRows() walk reaches the page',
      sourceRows.filter((r) => !pdfText.includes(String(r.key))).length, 0);

    const xlsx = await call('/reports/students?format=excel', { token: principalA, raw: true });
    check('FR-REPORT-002 — an Excel export is produced', xlsx.status, 200);
    check('  with the spreadsheet content type, which no route in this application had ever set',
      xlsx.contentType, controller.XLSX_MIME);
    check('  offered as a download with a dated filename',
      /attachment; filename="report-student-\d{4}-\d{2}-\d{2}\.xlsx"/.test(xlsx.disposition || ''), true);
    /* PK\x03\x04 — a .xlsx is a zip, so this proves a real workbook rather than JSON with a header. */
    check('  and the bytes really are a workbook, not JSON wearing a header',
      xlsx.buffer.slice(0, 4).toString('hex'), '504b0304');
    check('  of a plausible size', xlsx.buffer.length > 3000, true);

    /*
     * The export carries the same numbers as the JSON. Read back through exceljs rather than trusting
     * the writer — a workbook that opened empty would still be a valid zip of a plausible size.
     */
    // eslint-disable-next-line global-require
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.buffer);
    const sheet = wb.getWorksheet('student');
    check('the workbook has a sheet named for the report', Boolean(sheet), true);
    const cells = [];
    sheet.eachRow((row) => cells.push(row.values.slice(1).map((v) => (v === undefined ? '' : v))));
    check('  headed Section / Key / Value', cells[0], ['Section', 'Key', 'Value']);
    check('  and carrying the same total the JSON reported',
      cells.some((r) => r[1] === 'total' && Number(r[2]) === 5), true);
    check('  and the same per-status counts',
      cells.filter((r) => r[0] === 'by_status' && ['active', 'left'].includes(r[1])).map((r) => Number(r[2])).sort(),
      [1, 3]);

    /*
     * The export key's separation cannot be shown behaviourally, and saying so is more useful than an
     * assertion that looks like it does. EVERY seeded role holding `reports.view` also holds
     * `reports.export`, so no caller exists who can read a report and not export it — an earlier draft
     * asserted `[200, 200]` here under a label about separation, which proved nothing at all.
     *
     * What IS assertable: that fact about the fixed catalogue, and the conditional guard at the source
     * (Part 2). If a deployment ever edits a role to hold view without export, this is where the
     * behaviour becomes testable.
     */
    check('no seeded role holds reports.view without reports.export, so the split is not yet observable',
      Object.entries(DEFAULT_ROLE_PERMISSIONS)
        .filter(([, v]) => Array.isArray(v) && v.includes('reports.view') && !v.includes('reports.export'))
        .map(([r]) => r),
      []);
    check('  which is why a Librarian can both read and export, and that is not evidence of a split',
      [(await call('/reports/students', { token: librarian })).status,
        (await call('/reports/students?format=excel', { token: librarian })).status],
      [200, 200]);

    /* ── tenant isolation ── */

    const crossNamed = await call(`/reports/students?school_id=${schoolD.id}`, { token: principalA });
    check('naming another school is refused by the tenant chain', crossNamed.status, 403);
    check('  before any row is read', codeOf(crossNamed), 'CROSS_TENANT_ACCESS_DENIED');
    const dReport = dataOf(await expectOk('/reports/students', { token: principalD }, 200)).report;
    check('and another school sees its own emptiness, not school A\'s students', dReport.total, 0);

    /* ── the trail ── */

    const activity = await settle(
      () => db.ActivityLog.findAll({
        where: { id: { [db.Op.gt]: baseline.activityLog } }, order: [['id', 'ASC']],
      }),
      (rows) => rows.some((r) => r.entity_type === 'reports'
        && r.metadata && r.metadata.report === 'student' && r.metadata.format === 'excel')
    );
    const exports_ = activity.filter((r) => r.entity_type === 'reports');
    check('an export is recorded in the activity trail', exports_.length > 0, true);
    check('  naming which report and which format',
      exports_.some((r) => r.metadata && r.metadata.report === 'student' && r.metadata.format === 'excel'),
      true);
    /* An absence: there is no value to poll toward, so a grace period is waited out instead. */
    await quiesce();
    check('  and a report is never audited as a row change — §22 writes nothing',
      await db.AuditLog.count({ where: { id: { [db.Op.gt]: baseline.auditLog }, table_name: 'reports' } }),
      0);
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-reports Part 3 teardown failed:', err);
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
    console.error('\nverify-reports crashed:', err);
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
          ? 'All pure report checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All report checks passed (Parts 1–3).'
      );
    } else {
      console.log(`${failures} check(s) FAILED.`);
    }
    try {
      await db.sequelize.close();
    } catch (_) { /* the pool may never have opened */ }
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
