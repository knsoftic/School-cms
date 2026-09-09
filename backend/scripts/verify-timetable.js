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
 * Verification of Phase 3.O timetables — `src/modules/timetable/*` — SRS §20.1,
 * FR-TT-001 (creation) and FR-TT-002 (conflict detection).
 *
 * ## What this suite is mostly about
 *
 * FR-TT-002 is the module, and every one of its three named conflicts needs a **counter-example that
 * must be refused and a near-miss that must be allowed** — otherwise an assertion proves only that
 * the happy path works. So each rule is tested twice:
 *
 *   - **Teacher**: the same teacher twice in one slot is refused; the same teacher in a *different*
 *     period is allowed; and two entries that both name **no** teacher are allowed, because a break
 *     double-books nobody.
 *   - **Room**: the same room twice in one slot is refused; a different room in the same slot is
 *     allowed; and two entries with **no** room are allowed.
 *   - **Period**: a section twice in one slot is refused — by the unique index when the section is
 *     named, and by the service when it is not.
 *
 * The last of those is the one that matters most. `timetables_section_day_period_unique` is UNIQUE on
 * `(section_id, day_of_week, period_number)` and `section_id` is **nullable**, so MySQL's NULL-is-
 * distinct rule means the index does not constrain class-wide rows at all — §5a defect 19's exact
 * shape. Three assertions cover the hole: two class-wide rows in one slot, a class-wide row followed
 * by a section row, and a section row followed by a class-wide row. All three are the service's work,
 * and the suite proves the index alone would let every one of them through.
 *
 * ## Two facts about the columns, measured rather than assumed
 *
 *  - A `TIME` column does **not** round-trip: `'09:30'` comes back `'09:30'` from the create response
 *    and `'09:30:00'` on re-read. The module normalises on write, and the suite asserts the response
 *    and the stored row are the same string.
 *  - MySQL's `TIME` is a duration type with a ±838-hour range, so the **column accepts `24:00`**. The
 *    Joi pattern is the only guard, and the suite asserts it refuses one.
 *
 * Part 1 — request schemas and the pure helpers (no database).
 * Part 2 — the declared route table and the router-level guard.
 * Part 3 — over real HTTP against the real database.
 *
 * Run: node scripts/verify-timetable.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');

const timetableRoutes = require('../src/modules/timetable/timetable.routes');
const { schemas } = require('../src/modules/timetable/timetable.validation');
const timetableService = require('../src/modules/timetable/timetable.service');
const { settle } = require('./lib/settle');

const {
  ROLES, USER_STATUS, MODULES, MODULE_LIST, LIMITS, LIMIT_TYPES,
  PLAN_STATUS, SUBSCRIPTION_STATES, BILLING_CYCLES, WEEKDAYS, ACADEMIC_SESSION_STATUS,
} = require('../src/config/constants');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-timetable.local';
const PASSWORD = 'Verify@Timetable123';
const CODE_PREFIX = 'VTT-';

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

/** Does this router MOUNT an entitlement limit? Comments stripped — see §5a session 18. */
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

function named(router, method, path_, fnName) {
  const layer = router.stack.find((l) => l.route && l.route.path === path_ && l.route.methods[method]);
  return layer ? layer.route.stack.some((s) => s.handle.name === fnName) : null;
}

/** A valid entry, so a rejection can only be about the field under test. */
const ENTRY = {
  class_id: 1,
  day_of_week: WEEKDAYS.MONDAY,
  period_number: 1,
  start_time: '09:00',
  end_time: '09:45',
};

/* ═══════════════════════ part 1 — schemas and the pure helpers ═══════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas and the pure helpers ──\n');

  check('a complete entry validates', run(schemas.create, ENTRY).ok, true);
  check('an entry needs a class — §20.1 names the Class Timetable', run(schemas.create, { ...ENTRY, class_id: undefined }).ok, false);
  check('and a day', run(schemas.create, { ...ENTRY, day_of_week: undefined }).ok, false);
  check('and a period number — it is what the conflict indexes key on', run(schemas.create, { ...ENTRY, period_number: undefined }).ok, false);
  check('and both clock times, which the column declares NOT NULL', [
    run(schemas.create, { ...ENTRY, start_time: undefined }).ok,
    run(schemas.create, { ...ENTRY, end_time: undefined }).ok,
  ], [false, false]);

  /*
   * `subject_id` is deliberately optional: the model's teachingSlotNeedsSubject validator requires it
   * for a teaching period and a break must be recordable without one. Requiring it here would make a
   * break impossible.
   */
  check('a subject is not required by the schema — a break has none', run(schemas.create, ENTRY).ok, true);

  const dayColumn = db.Timetable.rawAttributes.day_of_week.values;
  check('the day column carries all seven weekdays', dayColumn.length, 7);
  check(
    'and the schema accepts every one the column does',
    dayColumn.every((v) => run(schemas.create, { ...ENTRY, day_of_week: v }).ok),
    true
  );
  check('an invented day is refused', run(schemas.create, { ...ENTRY, day_of_week: 'caturday' }).ok, false);
  /*
   * The enum's DECLARATION order is Monday-first, and MySQL orders an ENUM by declaration rather than
   * alphabetically — which is what makes `ORDER BY day_of_week` a week rather than an alphabetical
   * jumble. Asserted because the module's week ordering depends on it.
   */
  check('and the column declares them Monday-first, which is what makes ORDER BY a week', dayColumn, [
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  ]);

  /* ── times ── */

  check('HH:MM is accepted', run(schemas.create, { ...ENTRY, start_time: '09:30' }).ok, true);
  check('so is HH:MM:SS', run(schemas.create, { ...ENTRY, start_time: '09:30:00' }).ok, true);
  check('a one-digit hour is refused — the model compares times as strings', run(schemas.create, { ...ENTRY, start_time: '9:30' }).ok, false);
  /*
   * The column will NOT catch this. MySQL's TIME is a duration type with a ±838:59:59 range, verified
   * against this database, so `24:00` is a legal value for it. This pattern is the only guard.
   */
  check('24:00 is refused by the schema, because the column would accept it', run(schemas.create, { ...ENTRY, start_time: '24:00' }).ok, false);
  check('and so is 12:60', run(schemas.create, { ...ENTRY, start_time: '12:60' }).ok, false);

  for (const owned of ['id', 'organization_id', 'created_by']) {
    const r = run(schemas.create, { ...ENTRY, [owned]: 1 });
    check(`a caller-supplied ${owned} is refused`, r.ok, false);
    check(`  naming ${owned} as the reason`, r.keys, [owned]);
  }
  check('an update needs at least one field', run(schemas.update, {}).ok, false);

  /*
   * The two named views take no page/limit: a week is bounded, and half a timetable is worse than
   * none. Asserted against a list endpoint, which by contrast does take them.
   */
  const viewed = run(schemas.classView, { page: 2, limit: 10, sortBy: 'id' });
  check('the class view is not a paginated list', ['page' in viewed.value, 'limit' in viewed.value], [false, false]);
  check('  while the generic list is', run(schemas.list, { page: 2 }).value.page, 2);

  /* ── the pure helpers ── */

  check('a bare HH:MM is normalised to what the column stores', timetableService.normaliseTime('09:30'), '09:30:00');
  check('an HH:MM:SS is left alone', timetableService.normaliseTime('09:30:00'), '09:30:00');
  check('and a null stays null', timetableService.normaliseTime(null), null);
  check('a room is trimmed', timetableService.normaliseRoom('  Hall A  '), 'Hall A');
  check('and a blank room is no room at all, so it cannot clash with another blank', timetableService.normaliseRoom('   '), null);
  check('a null room stays null', timetableService.normaliseRoom(null), null);
}

/* ═══════════════════════════ part 2 — the route table ═══════════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — declared routes ──\n');

  const routes = routesOf(timetableRoutes);
  check('the six §20.1 routes are declared, literals before the :id family', routes, [
    'GET /class/:classId',
    'GET /teacher/:teacherId',
    'GET /',
    'POST /',
    'GET /:id',
    'PATCH /:id',
  ]);

  /*
   * Load-bearing: `/class` matches `GET /:id` as an entry whose id is the word "class". If the
   * parameterised route were declared first, both named views would become entry lookups.
   */
  check(
    'both named views are declared before the parameterised route',
    ['GET /class/:classId', 'GET /teacher/:teacherId'].every((r) => routes.indexOf(r) < routes.indexOf('GET /:id')),
    true
  );

  check('§20.1 names both views, and both are mounted', [
    routes.includes('GET /class/:classId'),
    routes.includes('GET /teacher/:teacherId'),
  ], [true, true]);

  check('there is no DELETE — §20.1 names none, and is_active is the retirement', routes.some((r) => r.startsWith('DELETE')), false);
  /*
   * There is no `timetable.self.view` permission in the fixed catalogue at all, so unlike §19 there is
   * nothing narrower to mount — a student reads their class's week through the ordinary route.
   */
  check('and no self-service route, because no self-service permission exists', routes.some((r) => r.includes('self') || r.includes('/me')), false);

  const writes = timetableRoutes.stack
    .filter((l) => l.route && !l.route.methods.get)
    .map((l) => [Object.keys(l.route.methods)[0], l.route.path]);
  check('there are two write routes — create and edit, which is what FR-TT-002 covers', writes.length, 2);
  check(
    'no write carries requirePlatformScope() — §20.1 is school-side',
    writes.every(([m, p]) => named(timetableRoutes, m, p, 'platformGuard') === false),
    true
  );
  check('every write carries validate()', writes.every(([m, p]) => named(timetableRoutes, m, p, 'validateRequest')), true);
  check('every write declares its activity', writes.every(([m, p]) => named(timetableRoutes, m, p, 'activityDeclaration')), true);
  check(
    'one router-level guard, mounted ahead of every route',
    [timetableRoutes.stack.filter((l) => !l.route).length, timetableRoutes.stack.findIndex((l) => !l.route)],
    [1, 0]
  );

  /*
   * The NULL-permissive index means a check-then-insert here is only closed by a LOCKING read — the
   * remedy `subjects.service.js:112-120` states for the identical shape ("the only backstop available
   * while the key stays nullable"). This module originally copied the weaker, non-locking
   * `fees.alreadyAssigned()` posture instead.
   *
   * Asserted at the source, because a lock cannot be provoked from a single-threaded suite: two
   * concurrent writers are what it defends against, and this suite issues one request at a time.
   * Comments are stripped first, so the probe reads the code and not the paragraph explaining it.
   */
  const serviceCode = fs
    .readFileSync(path.join(__dirname, '../src/modules/timetable/timetable.service.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const guardBody = serviceCode.slice(
    serviceCode.indexOf('async function assertNoConflict'),
    serviceCode.indexOf('async function assertNoConflict') + 2600
  );
  check('the conflict guard runs at all', guardBody.length > 0, true);
  check(
    'and every one of its three queries takes a locking read',
    (guardBody.match(/lock: transaction\.LOCK\.UPDATE/g) || []).length,
    3
  );
  check(
    '  which the guard requires a transaction for, rather than silently skipping',
    /if \(!transaction\) throw new Error/.test(guardBody),
    true
  );

  check('no route carries an entitlement limit', mountsLimit('timetable'), false);
  check('  and the probe would find one — the students router does mount a limit', mountsLimit('students'), true);
  check(
    'and §11.2 defines no timetable limit to carry',
    Object.values(LIMITS).some((k) => /timetable|period|room/.test(k)),
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

  async function call(pathname, { method = 'GET', body, token } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + pathname, { method, headers, body: payload });
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
      await db.Timetable.destroy({ where: { school_id: created.schools } });
      await db.Teacher.destroy({ where: { school_id: created.schools }, force: true });
      await db.Subject.destroy({ where: { school_id: created.schools }, force: true });
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

    const org = await db.Organization.create({ name: 'Verify Timetable Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);
    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Timetable A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Timetable B');
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify Timetable C');
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Timetable D');

    const mkPlan = async (code, ttEnabled) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify TT ${code}`, code: `${CODE_PREFIX}${code}`, status: PLAN_STATUS.ACTIVE,
        tier_rank: 1, trial_days: 0, grace_period_days: 7,
      });
      created.plans.push(plan.id);
      for (const key of MODULE_LIST) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanModule.create({ plan_id: plan.id, module_key: key, is_enabled: key === MODULES.TIMETABLE ? ttEnabled : true });
      }
      await db.PlanLimit.create({ plan_id: plan.id, limit_key: LIMITS.TEACHER_LIMIT, limit_type: LIMIT_TYPES.FIXED, limit_value: 100 });
      return plan;
    };
    const withTT = await mkPlan('WITH', true);
    const withoutTT = await mkPlan('WITHOUT', false);

    const subscribe = async (school, plan) => {
      const now = new Date();
      const sub = await db.Subscription.create({
        school_id: school.id, organization_id: org.id, plan_id: plan.id,
        state: SUBSCRIPTION_STATES.ACTIVE, billing_cycle: BILLING_CYCLES.MONTHLY, cycle_amount: 100,
        starts_at: now, current_period_start: now,
        current_period_end: new Date(now.getTime() + 30 * 864e5), grace_period_days: 7,
      });
      created.subscriptions.push(sub.id);
    };
    await subscribe(schoolA, withTT);
    await subscribe(schoolB, withoutTT);
    await subscribe(schoolD, withTT);
    /* schoolC is deliberately left unsubscribed. */

    const mkStructure = async (school, tag) => {
      const session = await db.AcademicSession.create({
        school_id: school.id, organization_id: org.id, name: `${tag} 2025-2026`,
        start_date: '2025-04-01', end_date: '2026-03-31', status: ACADEMIC_SESSION_STATUS.ACTIVE, is_current: true,
      });
      const klass = await db.Class.create({
        school_id: school.id, organization_id: org.id, academic_session_id: session.id,
        name: `${tag} Grade 1`, numeric_order: 1,
      });
      const other = await db.Class.create({
        school_id: school.id, organization_id: org.id, academic_session_id: session.id,
        name: `${tag} Grade 2`, numeric_order: 2,
      });
      const secA = await db.Section.create({ school_id: school.id, organization_id: org.id, class_id: klass.id, name: 'A' });
      const secB = await db.Section.create({ school_id: school.id, organization_id: org.id, class_id: klass.id, name: 'B' });
      const maths = await db.Subject.create({ school_id: school.id, organization_id: org.id, name: `${tag} Maths`, code: `${CODE_PREFIX}${tag}M` });
      const science = await db.Subject.create({ school_id: school.id, organization_id: org.id, name: `${tag} Science`, code: `${CODE_PREFIX}${tag}S` });
      const teacher = await db.Teacher.create({
        school_id: school.id, organization_id: org.id, employee_id: `${CODE_PREFIX}${tag}T1`,
        first_name: `${tag}Nadia`, joining_date: '2024-01-15',
      });
      const teacher2 = await db.Teacher.create({
        school_id: school.id, organization_id: org.id, employee_id: `${CODE_PREFIX}${tag}T2`,
        first_name: `${tag}Omar`, joining_date: '2024-01-15',
      });
      return { session, klass, other, secA, secB, maths, science, teacher, teacher2 };
    };
    const A = await mkStructure(schoolA, 'A');
    const D = await mkStructure(schoolD, 'D');

    const password_hash = await hashPassword(PASSWORD);
    const mkUser = async (key, slug, organization_id, school_id) => {
      const u = await db.User.create({
        role_id: roles[slug].id, organization_id, school_id, name: `Verify TT ${key}`,
        email: `${key}@${DOMAIN}`, username: `vtt_${key.replace(/-/g, '_')}`,
        password_hash, status: USER_STATUS.ACTIVE, must_change_password: false,
      });
      created.users.push(u.id);
    };
    await mkUser('platform', ROLES.SUPER_ADMIN, null, null);
    await mkUser('principal-a', ROLES.PRINCIPAL, org.id, schoolA.id);
    await mkUser('principal-b', ROLES.PRINCIPAL, org.id, schoolB.id);
    await mkUser('principal-c', ROLES.PRINCIPAL, org.id, schoolC.id);
    await mkUser('principal-d', ROLES.PRINCIPAL, org.id, schoolD.id);
    await mkUser('teacher', ROLES.TEACHER, org.id, schoolA.id);
    await mkUser('org-admin', ROLES.ORGANIZATION_ADMIN, org.id, null);

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
    const teacherToken = await signIn(`teacher@${DOMAIN}`);
    const orgAdmin = await signIn(`org-admin@${DOMAIN}`);

    /* ── the entitlement guard ── */

    const moduleDenied = await call('/timetable', { token: principalB });
    check('a plan without the Timetable module refuses', moduleDenied.status, 403);
    check('and names the module', codeOf(moduleDenied), 'MODULE_NOT_SUBSCRIBED');
    check('naming which one', moduleDenied.body.error.details.missing, [MODULES.TIMETABLE]);
    const noSub = await call('/timetable', { token: principalC });
    check('a school with no subscription is refused differently', noSub.status, 402);
    check('state is checked before module', codeOf(noSub), 'SUBSCRIPTION_INACTIVE');

    /* ── FR-TT-001 — creation ── */

    const mk = async (body, token = principalA) =>
      dataOf(await expectOk('/timetable', { method: 'POST', token, body }, 201)).entry;

    const mon1 = await mk({
      class_id: A.klass.id, section_id: A.secA.id, subject_id: A.maths.id, teacher_id: A.teacher.id,
      academic_session_id: A.session.id, day_of_week: WEEKDAYS.MONDAY, period_number: 1,
      start_time: '09:00', end_time: '09:45', room: 'Room 1', period_label: 'First',
    });
    check('a Principal creates an entry — FR-TT-001 names them', Boolean(mon1.id), true);
    check('the school is taken from the caller, never the body', mon1.school_id, schoolA.id);
    check('and so is the organization', mon1.organization_id, org.id);
    check('the creator is stamped on the row', Boolean(mon1.created_by), true);
    /*
     * A TIME column does not round-trip: `'09:00'` would come back `'09:00'` from the create and
     * `'09:00:00'` on re-read. Normalising on write makes the response and the row the same string.
     */
    check('a bare HH:MM is stored as the column will hold it', mon1.start_time, '09:00:00');
    check(
      '  and the row on disk agrees with what the API returned',
      (await db.Timetable.findByPk(mon1.id)).start_time,
      mon1.start_time
    );

    const teacherCreate = await call('/timetable', {
      method: 'POST', token: teacherToken,
      body: { class_id: A.klass.id, day_of_week: WEEKDAYS.TUESDAY, period_number: 1, start_time: '09:00', end_time: '09:45', subject_id: A.maths.id },
    });
    check('a teacher may read a timetable but not build one', teacherCreate.status, 403);
    check('  and it is the permission that is missing', codeOf(teacherCreate), 'INSUFFICIENT_PERMISSION');

    const noSubject = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { class_id: A.klass.id, section_id: A.secB.id, day_of_week: WEEKDAYS.MONDAY, period_number: 1, start_time: '09:00', end_time: '09:45' },
    });
    check('a teaching period with no subject is refused by the model validator', noSubject.status, 422);
    const aBreak = await mk({
      class_id: A.klass.id, section_id: A.secB.id, day_of_week: WEEKDAYS.MONDAY, period_number: 1,
      start_time: '09:00', end_time: '09:45', is_break: true, period_label: 'Assembly',
    });
    check('  while a break needs none, which is what is_break is for', [aBreak.is_break, aBreak.subject_id], [true, null]);

    const backwards = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { class_id: A.klass.id, section_id: A.secB.id, subject_id: A.maths.id, day_of_week: WEEKDAYS.TUESDAY, period_number: 9, start_time: '10:00', end_time: '09:00' },
    });
    check('an entry that ends before it starts is refused', backwards.status, 422);

    /* ── cross-tenant references ── */

    const foreignClass = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { ...ENTRY, class_id: D.klass.id, subject_id: A.maths.id },
    });
    check("an entry cannot name another school's class", foreignClass.status, 422);
    const foreignTeacher = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { class_id: A.klass.id, section_id: A.secB.id, subject_id: A.maths.id, teacher_id: D.teacher.id, day_of_week: WEEKDAYS.TUESDAY, period_number: 8, start_time: '09:00', end_time: '09:45' },
    });
    check("nor another school's teacher", foreignTeacher.status, 422);
    const foreignSubject = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { class_id: A.klass.id, section_id: A.secB.id, subject_id: D.maths.id, day_of_week: WEEKDAYS.TUESDAY, period_number: 8, start_time: '09:00', end_time: '09:45' },
    });
    check("nor another school's subject", foreignSubject.status, 422);
    const foreignSection = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { class_id: A.klass.id, section_id: D.secA.id, subject_id: A.maths.id, day_of_week: WEEKDAYS.TUESDAY, period_number: 8, start_time: '09:00', end_time: '09:45' },
    });
    check("nor a section of another class", foreignSection.status, 422);

    /* ══ FR-TT-002 — the three conflicts, each with a refusal AND a near-miss ══ */

    /* PERIOD, with the section named: the unique index's own case. */
    const sameSlot = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { class_id: A.klass.id, section_id: A.secA.id, subject_id: A.science.id, day_of_week: WEEKDAYS.MONDAY, period_number: 1, start_time: '09:00', end_time: '09:45' },
    });
    check('a section cannot hold two entries in one period', sameSlot.status, 409);
    check('  and the refusal says which conflict it was', codeOf(sameSlot), 'TIMETABLE_PERIOD_CONFLICT');
    check('  naming the entry it collides with', sameSlot.body.error.details.with.id, mon1.id);

    /* TEACHER: refused in the same slot, allowed in the next. */
    const teacherClash = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { class_id: A.other.id, subject_id: A.science.id, teacher_id: A.teacher.id, day_of_week: WEEKDAYS.MONDAY, period_number: 1, start_time: '09:00', end_time: '09:45' },
    });
    check('a teacher cannot be in two classes in one period', teacherClash.status, 409);
    check('  named as a teacher conflict', codeOf(teacherClash), 'TIMETABLE_TEACHER_CONFLICT');
    const teacherLater = await mk({
      class_id: A.other.id, subject_id: A.science.id, teacher_id: A.teacher.id,
      day_of_week: WEEKDAYS.MONDAY, period_number: 2, start_time: '09:50', end_time: '10:35',
    });
    check('  but the same teacher in the next period is fine — the near-miss is allowed', Boolean(teacherLater.id), true);

    /* ROOM: refused in the same slot, allowed when the room differs. */
    const roomClash = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { class_id: A.other.id, subject_id: A.science.id, teacher_id: A.teacher2.id, day_of_week: WEEKDAYS.MONDAY, period_number: 1, start_time: '09:00', end_time: '09:45', room: 'Room 1' },
    });
    check('a room cannot host two classes in one period', roomClash.status, 409);
    check('  named as a room conflict', codeOf(roomClash), 'TIMETABLE_ROOM_CONFLICT');
    const otherRoom = await mk({
      class_id: A.other.id, subject_id: A.science.id, teacher_id: A.teacher2.id,
      day_of_week: WEEKDAYS.MONDAY, period_number: 1, start_time: '09:00', end_time: '09:45', room: 'Room 2',
    });
    check('  while a different room in the same period is fine', otherRoom.room, 'Room 2');

    /*
     * The NULL cases, which are the ones a naive implementation gets wrong: two entries that name no
     * teacher and no room double-book nobody and nothing, so they must be ALLOWED. A break is exactly
     * this shape, which is why is_break needs no special case in the conflict rules.
     */
    const nobody1 = await mk({
      class_id: A.other.id, subject_id: A.science.id,
      day_of_week: WEEKDAYS.FRIDAY, period_number: 1, start_time: '09:00', end_time: '09:45',
    });
    const nobody2 = await mk({
      class_id: A.klass.id, section_id: A.secA.id, subject_id: A.science.id,
      day_of_week: WEEKDAYS.FRIDAY, period_number: 1, start_time: '09:00', end_time: '09:45',
    });
    check('two entries naming no teacher and no room are allowed — they clash with nobody', [Boolean(nobody1.id), Boolean(nobody2.id)], [true, true]);

    /* ══ the NULL-permissive unique index — §5a defect 19's shape ══ */

    const wide1 = await mk({
      class_id: A.other.id, subject_id: A.maths.id,
      day_of_week: WEEKDAYS.WEDNESDAY, period_number: 1, start_time: '09:00', end_time: '09:45',
    });
    /*
     * Read back rather than taken off the create response: a Sequelize instance returned straight from
     * `create()` has no value for a nullable column the caller never set, so the response omits the key
     * entirely. The stored row is what "class-wide" is a claim about (§5a session 18).
     */
    check(
      'a class-wide entry is allowed — a null section means the whole class',
      (await db.Timetable.findByPk(wide1.id)).section_id,
      null
    );
    const wide2 = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { class_id: A.other.id, subject_id: A.science.id, day_of_week: WEEKDAYS.WEDNESDAY, period_number: 1, start_time: '09:00', end_time: '09:45' },
    });
    check('but a SECOND class-wide entry in the same slot is refused', wide2.status, 409);
    check(
      '  by the service, because the unique index cannot see it — MySQL treats NULL as distinct',
      codeOf(wide2),
      'TIMETABLE_PERIOD_CONFLICT'
    );
    check(
      '  and the database really does hold only one row for that slot',
      await db.Timetable.count({ where: { class_id: A.other.id, day_of_week: WEEKDAYS.WEDNESDAY, period_number: 1 } }),
      1
    );

    /* A class-wide row occupies every section of that class, so a section row in the slot collides. */
    const sectionUnderWide = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { class_id: A.klass.id, section_id: A.secA.id, subject_id: A.maths.id, day_of_week: WEEKDAYS.THURSDAY, period_number: 1, start_time: '09:00', end_time: '09:45' },
    });
    check('a section entry in a free slot is fine', sectionUnderWide.status, 201);
    const wideOverSection = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { class_id: A.klass.id, subject_id: A.science.id, day_of_week: WEEKDAYS.THURSDAY, period_number: 1, start_time: '09:00', end_time: '09:45' },
    });
    check('  but a class-wide entry over it is refused — it would double-book that section', wideOverSection.status, 409);
    /* And the mirror: class-wide first, then a section of that class. */
    const wideFirst = await mk({
      class_id: A.klass.id, subject_id: A.science.id,
      day_of_week: WEEKDAYS.SATURDAY, period_number: 1, start_time: '09:00', end_time: '09:45',
    });
    const sectionSecond = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { class_id: A.klass.id, section_id: A.secB.id, subject_id: A.maths.id, day_of_week: WEEKDAYS.SATURDAY, period_number: 1, start_time: '09:00', end_time: '09:45' },
    });
    check('and the mirror case too — a section under an existing class-wide entry', sectionSecond.status, 409);
    void wideFirst;

    /* ── FR-TT-002 covers editing ── */

    const moved = await call(`/timetable/${mon1.id}`, {
      method: 'PATCH', token: principalA, body: { room: 'Room 9', reason: 'Room reallocated' },
    });
    check('an entry can be edited', moved.status, 200);
    check('  the new room landing', dataOf(moved).entry.room, 'Room 9');
    /*
     * FR-TT-002 covers editing, so the conflict check has to exclude the row being edited - otherwise
     * every edit finds the row itself sitting in the slot. Asserted with a plain call rather than
     * `expectOk`, so that dropping the exclusion reports a named failure instead of a stack trace.
     */
    const selfEdit = await call(`/timetable/${mon1.id}`, {
      method: 'PATCH', token: principalA, body: { period_label: 'Period One' },
    });
    check('  and editing an entry does not make it conflict with itself', selfEdit.status, 200);
    check('    the edit landing as asked', dataOf(selfEdit).entry.period_label, 'Period One');
    const movedIntoClash = await call(`/timetable/${teacherLater.id}`, {
      method: 'PATCH', token: principalA, body: { period_number: 1 },
    });
    check('but moving an entry into an occupied slot is refused', movedIntoClash.status, 409);
    /*
     * That one is refused on PERIOD, because its own class already occupies the destination slot - the
     * period check runs first, by design. To prove the TEACHER rule also applies on an edit, the
     * destination has to be period-free for the row's own class and occupied only for its teacher.
     */
    check('  refused on the period, because its class already holds that slot', codeOf(movedIntoClash), 'TIMETABLE_PERIOD_CONFLICT');

    const sunHeld = await mk({
      class_id: A.other.id, subject_id: A.maths.id, teacher_id: A.teacher2.id,
      day_of_week: WEEKDAYS.SUNDAY, period_number: 1, start_time: '09:00', end_time: '09:45',
    });
    const sunMover = await mk({
      class_id: A.klass.id, section_id: A.secB.id, subject_id: A.science.id, teacher_id: A.teacher2.id,
      day_of_week: WEEKDAYS.SUNDAY, period_number: 2, start_time: '09:50', end_time: '10:35',
    });
    const movedIntoTeacherClash = await call(`/timetable/${sunMover.id}`, {
      method: 'PATCH', token: principalA, body: { period_number: 1 },
    });
    check('  and moving into a slot free for the class but taken by the teacher is refused too', movedIntoTeacherClash.status, 409);
    check('    on the teacher, which is the rule the edit path has to re-run', codeOf(movedIntoTeacherClash), 'TIMETABLE_TEACHER_CONFLICT');
    check('    naming the entry it collides with', movedIntoTeacherClash.body.error.details.with.id, sunHeld.id);

    /* `is_active: false` does NOT free the slot — the unique index counts inactive rows too. */
    await expectOk(`/timetable/${mon1.id}`, { method: 'PATCH', token: principalA, body: { is_active: false } }, 200);
    const intoDeactivated = await call('/timetable', {
      method: 'POST', token: principalA,
      body: { class_id: A.klass.id, section_id: A.secA.id, subject_id: A.science.id, day_of_week: WEEKDAYS.MONDAY, period_number: 1, start_time: '09:00', end_time: '09:45' },
    });
    check('deactivating an entry does NOT free its slot — the index counts inactive rows', intoDeactivated.status, 409);
    await expectOk(`/timetable/${mon1.id}`, { method: 'PATCH', token: principalA, body: { is_active: true } }, 200);

    /* ── §20.1's two named views ── */

    const classWeek = dataOf(await expectOk(`/timetable/class/${A.klass.id}`, { token: principalA }, 200)).timetable;
    check('the Class Timetable names its class', classWeek.class.id, A.klass.id);
    check('and returns rows, not a grid — §20.1 names no grid', Array.isArray(classWeek.entries), true);
    /*
     * `day_of_week` is an ENUM declared Monday-first and MySQL orders an ENUM by declaration order,
     * so the week arrives as a week. Alphabetical order would start on Friday.
     */
    const days = [...new Set(classWeek.entries.map((e) => e.day_of_week))];
    const weekOrder = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    check(
      'the week is in week order, not alphabetical',
      days.every((d, i) => i === 0 || weekOrder.indexOf(days[i - 1]) <= weekOrder.indexOf(d)),
      true
    );
    check('every row carries the class it belongs to', classWeek.entries.every((e) => e.class_id === A.klass.id), true);

    /* Narrowing to a section brings the class-wide rows with it — they are that section's periods too. */
    const sectionWeek = dataOf(await expectOk(`/timetable/class/${A.klass.id}?section_id=${A.secA.id}`, { token: principalA }, 200)).timetable;
    check('narrowing to a section keeps the class-wide entries', sectionWeek.entries.some((e) => e.section_id === null), true);
    check('  and drops the other section\'s', sectionWeek.entries.some((e) => e.section_id === A.secB.id), false);

    const teacherWeek = dataOf(await expectOk(`/timetable/teacher/${A.teacher.id}`, { token: principalA }, 200)).timetable;
    check('the Teacher Timetable names its teacher', teacherWeek.teacher.id, A.teacher.id);
    check('and every row is theirs', teacherWeek.entries.every((e) => e.teacher_id === A.teacher.id), true);
    check('  which is a different set from the class view — the same rows asked a different question',
      teacherWeek.entries.length !== classWeek.entries.length, true);

    const teacherOfOtherSchool = await call(`/timetable/teacher/${D.teacher.id}`, { token: principalA });
    check("another school's teacher has no timetable here", teacherOfOtherSchool.status, 422);
    const classOfOtherSchool = await call(`/timetable/class/${D.klass.id}`, { token: principalA });
    check("nor another school's class", classOfOtherSchool.status, 422);

    /* ── tenant scoping ── */

    await mk({
      class_id: D.klass.id, subject_id: D.maths.id,
      day_of_week: WEEKDAYS.MONDAY, period_number: 1, start_time: '09:00', end_time: '09:45',
    }, principalD);
    const listA = dataOf(await expectOk('/timetable?limit=50', { token: principalA }, 200));
    check('a school sees its own entries', listA.length > 0, true);
    check("and not another school's — the counter-example exists", listA.every((e) => e.school_id === schoolA.id), true);
    const foreignEntry = dataOf(await expectOk('/timetable?limit=50', { token: principalD }, 200))[0];
    const reachForeign = await call(`/timetable/${foreignEntry.id}`, { token: principalA });
    check("another school's entry is not found, not merely forbidden", reachForeign.status, 404);
    check('  and says so', codeOf(reachForeign), 'TIMETABLE_ENTRY_NOT_FOUND');

    /*
     * The organization branch. An org admin holds no timetable permission in the seeded catalogue, so
     * the refusal is the permission layer — asserted rather than assumed, because it is the one thing
     * that distinguishes "not subscribed" from "not allowed" for this caller.
     */
    const orgRead = await call(`/timetable?school_id=${schoolA.id}`, { token: orgAdmin });
    check('an organization admin holds no timetable permission at all', orgRead.status, 403);
    check('  which is the permission layer, not the module', codeOf(orgRead), 'INSUFFICIENT_PERMISSION');

    const platformList = dataOf(await expectOk('/timetable?limit=50', { token: platform }, 200));
    check('a platform caller sees across schools, which is what platform scope means',
      [...new Set(platformList.map((e) => e.school_id))].length > 1, true);

    /* ── the trail ── */

    const activity = await settle(
      () => db.ActivityLog.findAll({ where: { id: { [db.Op.gt]: baseline.activityLog } }, order: [['id', 'ASC']] }),
      (rows) => new Set(rows.filter((r) => r.entity_type === 'timetable').map((r) => r.action)).size >= 2
    );
    const ttActivity = activity.filter((r) => r.entity_type === 'timetable');
    check('every timetable write is in the activity trail', ttActivity.length > 0, true);
    check('both a create and an edit appear', [...new Set(ttActivity.map((r) => r.action))].sort(), ['create', 'update']);

    const audits = await settle(
      () => db.AuditLog.findAll({
        where: { id: { [db.Op.gt]: baseline.auditLog }, table_name: 'timetables' },
      }),
      (rows) => rows.some((r) => r.event === 'update' && r.reason === 'Room reallocated')
    );
    check('and each row is audited', audits.length > 0, true);
    const edited = audits.find((r) => r.event === 'update' && r.reason === 'Room reallocated');
    check('  carrying the reason it was given', Boolean(edited), true);
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-timetable Part 3 teardown failed:', err);
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
    console.error('\nverify-timetable crashed:', err);
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
          ? 'All pure timetable checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All timetable checks passed (Parts 1–3).'
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
