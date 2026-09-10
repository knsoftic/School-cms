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
 * Verification of Phase 3.J staff — `src/modules/staff/*` — SRS §15.4, FR-STAFF-001.
 * The last §15 module.
 *
 * It is the smallest of the four, so the assertions concentrate on the three things that are not
 * shared boilerplate:
 *
 *  - **The `staff_limit` ceiling, on BOTH paths.** `enforceLimit` is a route guard on `POST /` and
 *    `staff_limit` counts `is_active: true`, so a `PATCH` that flips the flag back is a limit event
 *    the guard cannot see. `teachers/` shipped without that second check and it became §5a defect 21.
 *    Here it is asserted as a cycle: create to the ceiling, refuse, deactivate, reuse the freed
 *    allowance, then **fail to re-activate**.
 *  - **The four §15.4 categories**, which come from the `staff.category` enum rather than from a list
 *    restated in the module. A fifth is refused.
 *  - **One staff record per account**, enforced in the service because `staff.user_id` has only a
 *    plain index — unlike `parents`, where the database enforces it.
 *
 * Part 1 — request schemas, directly (no database).
 * Part 2 — the declared route table and the router-level guard.
 * Part 3 — over real HTTP against the real database.
 *
 * Run: node scripts/verify-staff.js
 */

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');

const staffRoutes = require('../src/modules/staff/staff.routes');
const { schemas } = require('../src/modules/staff/staff.validation');

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
  STAFF_CATEGORIES,
} = require('../src/config/constants');

/* The activity trail lands after the response — see lib/settle.js and Known Issues #25. */
const { settleDistinct } = require('./lib/settle');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-staff.local';
const PASSWORD = 'Verify@Staff123';
const CODE_PREFIX = 'VSF-';

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

function routesOf(router) {
  return router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
}

function named(router, method, path, fnName) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer ? layer.route.stack.some((s) => s.handle.name === fnName) : null;
}

const MINIMAL = { employee_id: 'S-1', category: STAFF_CATEGORIES.RECEPTIONIST, first_name: 'Nadia', joining_date: '2024-01-15' };

/* ═══════════════════════════ part 1 — request schemas ═══════════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas ──\n');

  const minimal = run(schemas.create, { ...MINIMAL });
  check('the four required fields are enough to create', minimal.ok, true);

  for (const missing of ['employee_id', 'category', 'first_name', 'joining_date']) {
    const body = { ...MINIMAL };
    delete body[missing];
    check(`${missing} is required`, run(schemas.create, body).ok, false);
  }

  /* §15.4 names exactly four categories and the enum holds exactly those four. */
  check(
    'all four §15.4 categories are accepted',
    Object.values(STAFF_CATEGORIES).every((c) => run(schemas.create, { ...MINIMAL, category: c }).ok),
    true
  );
  /* ── Known Issues #26 — photo_path is no longer a caller-supplied string ── */

  check(
    'a body-supplied photo_path is REFUSED on create, not stripped',
    (() => {
      const r = schemas.create.validate({ ...MINIMAL, photo_path: '../../etc/passwd' }, VALIDATE_OPTIONS);
      return [Boolean(r.error), r.error ? r.error.details.map((d) => d.path.join('.')) : []];
    })(),
    [true, ['photo_path']]
  );
  /* `first_name` co-submitted: `schemas.update` ends in `.min(1)` — see verify-students.js. */
  check(
    '  and on patch, where only forbidden() can produce the refusal',
    run(schemas.update, { first_name: 'Rashid', photo_path: 'x.png' }).ok,
    false
  );
  check(
    '  because SRS §15.4 names no photo for a staff member, so the column has no writer at all',
    require('../src/modules/staff/staff.service').EDITABLE.includes('photo_path'),
    false
  );

  check(
    'and a fifth is refused',
    run(schemas.create, { ...MINIMAL, category: 'groundskeeper' }).ok,
    false
  );
  /*
   * The schema's own list against the model's, not the constant against itself.
   *
   * The first version compared `Object.values(STAFF_CATEGORIES)` to
   * `db.Staff.rawAttributes.category.values` — but the column is declared
   * `enumOf(STAFF_CATEGORIES, …)`, so the model's enum is *derived from* that constant and the two
   * sides were equal by construction. It could not fail under any edit, and its label was about the
   * validation schema, which it never touched. Reading the schema's `allow` list back through
   * `describe()` makes the model the single source: replace the schema's `valid(...)` with a
   * hand-written list and this goes red the moment the two disagree.
   */
  check(
    'the schema takes its category list from the model, not a restated copy',
    schemas.create.describe().keys.category.allow.slice().sort(),
    db.Staff.rawAttributes.category.values.slice().sort()
  );

  check('organization_id is refused', run(schemas.create, { ...MINIMAL, organization_id: 4 }).ok, false);
  check('id is refused', run(schemas.create, { ...MINIMAL, id: 4 }).ok, false);

  const stripped = run(schemas.create, { ...MINIMAL, is_superuser: true });
  check('an unknown key is stripped', stripped.ok && stripped.value.is_superuser === undefined, true);

  check('gender is held to the model enum', run(schemas.create, { ...MINIMAL, gender: 'unspecified' }).ok, false);
  check('gender accepts a model value', run(schemas.create, { ...MINIMAL, gender: 'female' }).ok, true);

  const cased = run(schemas.create, { ...MINIMAL, email: '  Nadia.K@Example.COM ' });
  check('email is trimmed and lower-cased', cased.value.email, 'nadia.k@example.com');

  /* Widths from the model, not chosen — §5a defect 24. */
  check('employee_id is bounded at 60', run(schemas.update, { employee_id: 'x'.repeat(61) }).ok, false);
  check('designation is bounded at 120', run(schemas.update, { designation: 'x'.repeat(121) }).ok, false);
  check('qualification matches its 255 column', run(schemas.update, { qualification: 'x'.repeat(255) }).ok, true);
  check('and 256 is refused', run(schemas.update, { qualification: 'x'.repeat(256) }).ok, false);
  check('salary is bounded by DECIMAL(14,2)', run(schemas.update, { salary: 1e13 }).ok, false);
  check('salary may not be negative', run(schemas.update, { salary: -1 }).ok, false);

  check('update requires at least one field', run(schemas.update, {}).ok, false);
  check('update accepts a single field', run(schemas.update, { designation: 'Head Librarian' }).ok, true);

  check(
    'joining_date reaches the service as a Date, which is why the service normalises it',
    minimal.value.joining_date instanceof Date,
    true
  );
}

/* ═══════════════════════════ part 2 — the route table ═══════════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — declared routes ──\n');

  const routes = routesOf(staffRoutes);
  check('the four §15.4 routes are declared', routes, ['GET /', 'POST /', 'GET /:id', 'PATCH /:id']);

  check('staff has no DELETE — §15.4 names none', routes.some((r) => r.startsWith('DELETE')), false);
  check(
    'and no dashboard — §15.4 names one for teachers and parents, not for staff',
    routes.some((r) => r.includes('dashboard')),
    false
  );

  const writes = staffRoutes.stack
    .filter((l) => l.route && !l.route.methods.get)
    .map((l) => [Object.keys(l.route.methods)[0], l.route.path]);
  check('there are two write routes', writes.length, 2);
  check(
    'no write carries requirePlatformScope()',
    writes.every(([m, p]) => named(staffRoutes, m, p, 'platformGuard') === false),
    true
  );
  check(
    'every write carries validate()',
    writes.every(([m, p]) => named(staffRoutes, m, p, 'validateRequest')),
    true
  );
  check(
    'every write declares its activity',
    writes.every(([m, p]) => named(staffRoutes, m, p, 'activityDeclaration')),
    true
  );
  check(
    'one router-level guard, mounted ahead of every route',
    [staffRoutes.stack.filter((l) => !l.route).length, staffRoutes.stack.findIndex((l) => !l.route)],
    [1, 0]
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

  const usedNow = async (subscriptionId) => {
    const row = await db.UsageRecord.findOne({
      where: { subscription_id: subscriptionId, limit_key: LIMITS.STAFF_LIMIT },
    });
    return row ? Number(row.used_value) : null;
  };

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
    if (created.schools.length) {
      await db.Staff.destroy({ where: { school_id: created.schools }, force: true });
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
    const residueCleared = await sweepResidue(db, { codes: ['VSF-'], domains: ['verify-staff.local'] });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({ name: 'Verify Staff Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Staff A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Staff B');
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify Staff C');
    /* D clears the module guard, so a cross-school 404 is isolation rather than entitlement. */
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Staff D');

    const mkPlan = async (code, staffEnabled, staffLimit) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify Staff ${code}`,
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
          is_enabled: key === MODULES.STAFF ? staffEnabled : true,
        });
      }
      await db.PlanLimit.create({
        plan_id: plan.id,
        limit_key: LIMITS.STAFF_LIMIT,
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: staffLimit,
      });
      return plan;
    };

    const withStaff = await mkPlan('WITH', true, 2);
    const withoutStaff = await mkPlan('WITHOUT', false, 50);

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

    const subA = await subscribe(schoolA, withStaff);
    await subscribe(schoolB, withoutStaff);
    await subscribe(schoolD, withStaff);
    /* schoolC is deliberately left unsubscribed. */

    const password_hash = await hashPassword(PASSWORD);
    const people = [
      ['platform', ROLES.SUPER_ADMIN, 'Verify SF Platform', 'vsf_platform', null, null],
      ['principal-a', ROLES.PRINCIPAL, 'Verify SF Principal A', 'vsf_principal_a', org.id, schoolA.id],
      ['principal-b', ROLES.PRINCIPAL, 'Verify SF Principal B', 'vsf_principal_b', org.id, schoolB.id],
      ['principal-c', ROLES.PRINCIPAL, 'Verify SF Principal C', 'vsf_principal_c', org.id, schoolC.id],
      ['principal-d', ROLES.PRINCIPAL, 'Verify SF Principal D', 'vsf_principal_d', org.id, schoolD.id],
      ['linked', ROLES.TEACHER, 'Verify SF Linked', 'vsf_linked', org.id, schoolA.id],
      ['teacher', ROLES.TEACHER, 'Verify SF Teacher', 'vsf_teacher', org.id, schoolA.id],
      /*
       * An organization admin: `organization_id` set, `school_id` **null**. Without one, every
       * request in this suite takes `tenantWhere`'s `schoolId` branch and the `organization_id`
       * branch — the shape §5a defect 16 and defect 22 are both about — is never executed. All three
       * sibling §15 suites have the same blind spot; this is the first to close it.
       */
      ['org-admin', ROLES.ORGANIZATION_ADMIN, 'Verify SF Org Admin', 'vsf_org', org.id, null],
    ];
    const userIdOf = {};
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
      userIdOf[key] = user.id;
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
    /* No sign-in assertion: `signIn` throws when no token comes back, so by this line six strings
       are guaranteed and a check would be dead weight. */

    /* ── the entitlement guard ── */

    const moduleDenied = await call('/staff', { token: principalB });
    check('a plan without the Staff module refuses', moduleDenied.status, 403);
    check('and names the module', codeOf(moduleDenied), 'MODULE_NOT_SUBSCRIBED');
    check('naming which one', moduleDenied.body.error.details.missing, [MODULES.STAFF]);

    const noSub = await call('/staff', { token: principalC });
    check('a school with no subscription is refused differently', noSub.status, 402);
    check('state is checked before module', codeOf(noSub), 'SUBSCRIPTION_INACTIVE');

    /* ── FR-STAFF-001 ── */

    const createRes = await expectOk(
      '/staff',
      {
        method: 'POST',
        token: principalA,
        body: {
          employee_id: 'VSF-1',
          category: STAFF_CATEGORIES.LIBRARIAN,
          first_name: 'Nadia',
          last_name: 'Khan',
          gender: 'female',
          joining_date: '2024-01-15',
          designation: 'Head Librarian',
          user_id: userIdOf.linked,
        },
      },
      201
    );
    const first = dataOf(createRes).staff;
    check('a staff member is created', first.employee_id, 'VSF-1');
    check('under one of the four §15.4 categories', first.category, STAFF_CATEGORIES.LIBRARIAN);
    check('joining_date is stored as a plain date', first.joining_date, '2024-01-15');
    check('is_active defaults to true', first.is_active, true);
    check('the school comes from the tenant', Number(first.school_id), schoolA.id);

    const dup = await call('/staff', {
      method: 'POST',
      token: principalA,
      body: { employee_id: 'VSF-1', category: STAFF_CATEGORIES.ACCOUNTANT, first_name: 'Clash', joining_date: '2024-03-01' },
    });
    check('a duplicate employee_id at the same school is 409', dup.status, 409);
    check('duplicate employee_id code', codeOf(dup), 'STAFF_EMPLOYEE_ID_TAKEN');

    const crossUser = await call('/staff', {
      method: 'POST',
      token: principalA,
      body: {
        employee_id: 'VSF-9',
        category: STAFF_CATEGORIES.OTHER_STAFF,
        first_name: 'Cross',
        joining_date: '2024-03-01',
        user_id: userIdOf['principal-b'],
      },
    });
    check('a user_id from another school is refused', crossUser.status, 422);

    /* ── the DATEONLY trap, at a western offset (Known Issues #20) ── */

    const tzBefore = process.env.TZ;
    let westMember = null;
    try {
      process.env.TZ = 'America/New_York';
      const westRes = await expectOk(
        '/staff',
        {
          method: 'POST',
          token: principalA,
          /* BOTH DATEONLY columns. Testing only one would leave the other free to be dropped from
             DATE_ONLY_FIELDS with the suite still green. */
          body: {
            employee_id: 'VSF-TZ',
            category: STAFF_CATEGORIES.RECEPTIONIST,
            first_name: 'Westward',
            joining_date: '2024-07-01',
            date_of_birth: '1990-03-14',
          },
        },
        201
      );
      westMember = dataOf(westRes).staff;
    } finally {
      if (tzBefore === undefined) delete process.env.TZ;
      else process.env.TZ = tzBefore;
    }
    check('joining_date survives a west-of-UTC server', westMember.joining_date, '2024-07-01');
    check('date_of_birth survives it too', westMember.date_of_birth, '1990-03-14');
    const [westRows] = await db.sequelize.query(
      `SELECT DATE_FORMAT(joining_date, '%Y-%m-%d') AS j, DATE_FORMAT(date_of_birth, '%Y-%m-%d') AS d
         FROM staff WHERE id = ${Number(westMember.id)}`
    );
    check('and both columns themselves hold them', [westRows[0].j, westRows[0].d], ['2024-07-01', '1990-03-14']);

    /* ── the ceiling, on both paths ── */

    const overLimit = await call('/staff', {
      method: 'POST',
      token: principalA,
      body: { employee_id: 'VSF-3', category: STAFF_CATEGORIES.OTHER_STAFF, first_name: 'Third', joining_date: '2024-04-01' },
    });
    check('the third staff member exceeds a staff_limit of 2', overLimit.status, 403);
    check('and it is the limit guard that refuses', codeOf(overLimit), 'PLAN_LIMIT_EXCEEDED');
    check('the headcount was recorded, not just checked', await usedNow(subA.id), 2);

    await expectOk(
      `/staff/${westMember.id}`,
      { method: 'PATCH', token: principalA, body: { is_active: false, left_at: '2024-12-31T00:00:00.000Z' } },
      200
    );
    check('deactivating returns the allowance', await usedNow(subA.id), 1);

    const afterFree = await expectOk(
      '/staff',
      {
        method: 'POST',
        token: principalA,
        body: { employee_id: 'VSF-4', category: STAFF_CATEGORIES.ACCOUNTANT, first_name: 'Fourth', joining_date: '2024-05-01' },
      },
      201
    );
    check('and the freed allowance is usable', dataOf(afterFree).staff.employee_id, 'VSF-4');

    /*
     * Re-activation past the ceiling. `enforceLimit` is on `POST /` only, and `staff_limit` counts
     * `is_active: true` — so flipping the deactivated member back would take the school to 3 of 2
     * with no route guard involved. `teachers/` shipped exactly this hole (§5a defect 21); the check
     * is in `staff.service.update()` from the start here, and this is what proves it.
     */
    const reactivate = await call(`/staff/${westMember.id}`, {
      method: 'PATCH',
      token: principalA,
      body: { is_active: true },
    });
    check('re-activating past the ceiling is refused', reactivate.status, 403);
    check('and by the same limit guard as the create path', codeOf(reactivate), 'PLAN_LIMIT_EXCEEDED');
    check('the refused re-activation left the headcount alone', await usedNow(subA.id), 2);

    const patchAtCeiling = await expectOk(
      `/staff/${westMember.id}`,
      { method: 'PATCH', token: principalA, body: { designation: 'Retired' } },
      200
    );
    check('a non-activating edit still works at the ceiling', dataOf(patchAtCeiling).staff.designation, 'Retired');

    /* ── one staff record per account ── */

    const dupLink = await call(`/staff/${dataOf(afterFree).staff.id}`, {
      method: 'PATCH',
      token: principalA,
      body: { user_id: userIdOf.linked },
    });
    check('an account already linked to a staff member is refused', dupLink.status, 409);
    check('and names why', codeOf(dupLink), 'STAFF_USER_TAKEN');

    const selfLink = await expectOk(
      `/staff/${first.id}`,
      { method: 'PATCH', token: principalA, body: { user_id: userIdOf.linked } },
      200
    );
    check('but the holder may re-save its own link', Number(dataOf(selfLink).staff.user_id), userIdOf.linked);

    /* ── reads, isolation, permissions ── */

    const listA = await expectOk('/staff', { token: principalA }, 200);
    check(
      'the list is confined to the caller school',
      dataOf(listA).every((r) => Number(r.school_id) === schoolA.id),
      true
    );
    const byCategory = await expectOk(`/staff?category=${STAFF_CATEGORIES.LIBRARIAN}`, { token: principalA }, 200);
    check('the category filter works', dataOf(byCategory).length, 1);
    const activeOnly = await expectOk('/staff?is_active=true', { token: principalA }, 200);
    check('the is_active filter works', dataOf(activeOnly).length, 2);
    const searched = await expectOk('/staff?q=Khan', { token: principalA }, 200);
    check('the q filter searches names', dataOf(searched).length, 1);

    const patched = await expectOk(
      `/staff/${first.id}`,
      { method: 'PATCH', token: principalA, body: { category: STAFF_CATEGORIES.OTHER_STAFF } },
      200
    );
    check('the category is editable — §15.4 says "manages"', dataOf(patched).staff.category, STAFF_CATEGORIES.OTHER_STAFF);

    /*
     * A staff row at school D. Until one existed, `check(... .every(r => r.school_id === schoolA.id))`
     * iterated an array that could only ever hold school-A rows — so deleting `tenantWhere` from
     * `list()` altogether left the suite green. The assertion needed something it could catch.
     */
    const dMember = await db.Staff.create({
      school_id: schoolD.id,
      organization_id: org.id,
      employee_id: 'VSF-D1',
      category: STAFF_CATEGORIES.ACCOUNTANT,
      first_name: 'Dee',
      joining_date: '2024-02-01',
    });

    const listAgain = await expectOk('/staff', { token: principalA }, 200);
    check('school A still lists only its own', dataOf(listAgain).length, 3);
    check(
      'and school D is not among them',
      dataOf(listAgain).some((r) => Number(r.id) === Number(dMember.id)),
      false
    );
    const listD = await expectOk('/staff', { token: principalD }, 200);
    check('while school D lists only its own', dataOf(listD).map((r) => Number(r.id)), [Number(dMember.id)]);

    /* The ordinary path: FR-STAFF-001's own actor reading one of their rows by id. */
    const ownRead = await expectOk(`/staff/${first.id}`, { token: principalA }, 200);
    check('a principal reads their own staff member by id', dataOf(ownRead).staff.employee_id, 'VSF-1');

    /*
     * The organization-scoped branch of `tenantWhere`, and with it the §5a defect 22 fix. An
     * organization admin holds `staff.view` and no school of their own, so naming `?school_id=`
     * is how they reach a record — and the record must belong to the school they named, not merely
     * to their organization.
     */
    const orgReadsOwn = await expectOk(
      `/staff/${first.id}?school_id=${schoolA.id}`,
      { token: orgAdmin },
      200
    );
    check('an organization admin reads a record of the school it names', dataOf(orgReadsOwn).staff.employee_id, 'VSF-1');

    const orgCrossesSchools = await call(`/staff/${dMember.id}?school_id=${schoolA.id}`, { token: orgAdmin });
    check(
      'but naming one school and asking for another school\'s record is refused',
      orgCrossesSchools.status,
      404
    );
    check('and it is isolation refusing', codeOf(orgCrossesSchools), 'STAFF_NOT_FOUND');

    const orgList = await expectOk(`/staff?school_id=${schoolD.id}`, { token: orgAdmin }, 200);
    check('and a named school scopes the list', dataOf(orgList).map((r) => Number(r.id)), [Number(dMember.id)]);

    const dReadsA = await call(`/staff/${first.id}`, { token: principalD });
    check('a principal of another school cannot read this staff member', dReadsA.status, 404);
    check('and it is isolation refusing, not entitlement', codeOf(dReadsA), 'STAFF_NOT_FOUND');

    /* The mutating by-id route needs its own isolation test — `teachers/` has one and the copy
       dropped it. A GET being scoped says nothing about PATCH. */
    const dPatchesA = await call(`/staff/${first.id}`, {
      method: 'PATCH',
      token: principalD,
      body: { designation: 'Hijacked' },
    });
    check('nor patch it', dPatchesA.status, 404);

    const teacherRead = await call('/staff', { token: teacher });
    check('a teacher does not hold staff.view', teacherRead.status, 403);
    const teacherWrite = await call('/staff', {
      method: 'POST',
      token: teacher,
      body: { employee_id: 'VSF-X', category: STAFF_CATEGORIES.OTHER_STAFF, first_name: 'Nope', joining_date: '2024-01-01' },
    });
    check('nor staff.manage', teacherWrite.status, 403);
    check('and it is the permission refusing', codeOf(teacherWrite), 'INSUFFICIENT_PERMISSION');

    const platformRead = await call(`/staff/${first.id}`, { token: platform });
    check('the platform admin reads any school', platformRead.status, 200);

    /* ── the audit trail ── */

    const audits = await settleDistinct(
      () =>
        db.AuditLog.findAll({
          where: { id: { [db.Op.gt]: baseline.auditLog }, table_name: 'staff' },
          order: [['id', 'ASC']],
        }),
      'event',
      2
    );
    check('staff writes are audited', audits.length > 0, true);
    check('both events are exercised', [...new Set(audits.map((r) => r.event))].sort(), ['create', 'update']);
    const categoryChange = audits.find(
      (r) => r.event === 'update' && r.new_values && r.new_values.category === STAFF_CATEGORIES.OTHER_STAFF
    );
    check('a category change is audited with before and after', Boolean(categoryChange), true);
    check(
      'changed_fields is a real array, not JSON text',
      Array.isArray(categoryChange && categoryChange.changed_fields),
      true
    );
    /* The "before" half of the label was never read — only `new_values` was inspected. */
    check(
      'and the before half really is the prior category',
      categoryChange && categoryChange.old_values.category,
      STAFF_CATEGORIES.LIBRARIAN
    );

    /* `logActivity` is declared on both writes and Part 2 asserts the declaration exists; nothing
       asserted a row actually landed. */
    const activity = await settleDistinct(
      () =>
        db.ActivityLog.findAll({
          where: { id: { [db.Op.gt]: baseline.activityLog }, entity_type: 'staff' },
          order: [['id', 'ASC']],
        }),
      'action',
      2
    );
    check('the activity trail records staff writes', activity.length > 0, true);
    check(
      'with both actions',
      [...new Set(activity.map((r) => r.action))].sort(),
      ['create', 'update']
    );
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-staff Part 3 teardown failed:', err);
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
    console.error('\nverify-staff crashed:', err);
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
          ? 'All pure staff checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All staff checks passed (Parts 1–3).'
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
