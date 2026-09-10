'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *   RATE_LIMIT_MAX / AUTH_RATE_LIMIT_MAX  the limiters are not under test here.
 *   BCRYPT_ROUNDS=10, PASSWORD_MIN_LENGTH pinned so neither comes from the local .env.
 *   MAIL_DRIVER=log                       this module SENDS mail — the log driver is what makes the
 *                                         verification email observable without an SMTP server.
 *   CACHE_TTL=600                         so no entitlement assertion can pass by TTL expiry.
 */
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.BCRYPT_ROUNDS = '10';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';
process.env.CACHE_TTL = '600';

/**
 * Verification of Phase 3.J parents — `src/modules/parents/*` — SRS §15.2,
 * FR-PARENT-001 (parent account & multiple-children linking) and FR-PARENT-002 (parent dashboard).
 *
 * What makes this module different from its two siblings, and therefore what this suite concentrates
 * on:
 *
 *  - **It creates a `users` row.** `parents.user_id` is NOT NULL, so FR-PARENT-001's "System creates
 *    a Parent Account" is a real instruction rather than an optional link. The account, the profile
 *    and any children named at creation are written in **one transaction**, and the verification
 *    email is issued afterwards and is deliberately non-fatal. All of that is asserted, including
 *    that a failed create leaves no orphan user behind.
 *  - **`parent_students` carries `school_id` and no `organization_id`.** `tenantWhere()` would write
 *    `organization_id` for an organization-scoped caller and MariaDB would answer with a 500 — the
 *    defect that shipped twice already (§5a defect 16). The module scopes the join table by its
 *    parent instead, and that branch is asserted against the service directly, because no seeded role
 *    both resolves to an organization-without-school tenant and holds `parents.view`.
 *  - **`user_id` is `forbidden()` in the body**, unlike teachers and students where linking an
 *    existing account is legitimate.
 *
 * Part 1 — request schemas, directly (no database).
 * Part 2 — the declared route table and the router-level guard.
 * Part 3 — over real HTTP against the real database.
 *
 * Run: node scripts/verify-parents.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const { sweepResidue, removeFailedSignIns } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const { settleDistinct } = require('./lib/settle');

const parentRoutes = require('../src/modules/parents/parents.routes');
const { schemas } = require('../src/modules/parents/parents.validation');
const parentsService = require('../src/modules/parents/parents.service');

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
} = require('../src/config/constants');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-parents.local';
const PASSWORD = 'Verify@Parents123';
const CODE_PREFIX = 'VPA-';

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

/* ═══════════════════════════ part 1 — request schemas ═══════════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas ──\n');

  const minimal = run(schemas.create, {
    name: 'Yusuf Bello',
    email: 'yusuf@example.com',
    username: 'yusuf.bello',
    password: 'Str0ng!Passphrase',
  });
  check('name, email, username and password are enough', minimal.ok, true);

  /* ── Known Issues #26 — photo_path is no longer a caller-supplied string ── */

  check(
    'a body-supplied photo_path is REFUSED on create, not stripped',
    (() => {
      const r = schemas.create.validate(
        {
          name: 'Yusuf Bello',
          email: 'yusuf@example.com',
          username: 'yusuf.bello',
          password: 'Str0ng!Passphrase',
          photo_path: '../../etc/passwd',
        },
        VALIDATE_OPTIONS
      );
      return [Boolean(r.error), r.error ? r.error.details.map((d) => d.path.join('.')) : []];
    })(),
    [true, ['photo_path']]
  );
  /* `name` co-submitted: `schemas.update` ends in `.min(1)` — see verify-students.js. */
  check(
    '  and on patch, where only forbidden() can produce the refusal',
    run(schemas.update, { name: 'Yusuf Bello', photo_path: 'x.png' }).ok,
    false
  );
  check(
    '  because SRS §15.2 names no photo for a parent, so the column has no writer at all',
    parentsService.EDITABLE.includes('photo_path'),
    false
  );

  for (const missing of ['name', 'email', 'username']) {
    const body = { name: 'A', email: 'a@example.com', username: 'a.parent', password: 'Str0ng!Passphrase' };
    delete body[missing];
    check(`${missing} is required`, run(schemas.create, body).ok, false);
  }

  /*
   * `user_id` is forbidden here and accepted by the two sibling modules, which is the whole point:
   * a parent's account is created by this endpoint, so naming one would be a second route to a NOT
   * NULL column with different guarantees behind it.
   */
  check(
    'user_id is refused — this endpoint creates the account',
    run(schemas.create, {
      name: 'A',
      email: 'a@example.com',
      username: 'a.parent',
      password: 'Str0ng!Passphrase',
      user_id: 7,
    }).ok,
    false
  );
  check(
    'organization_id is refused',
    run(schemas.create, {
      name: 'A',
      email: 'a@example.com',
      username: 'a.parent',
      password: 'Str0ng!Passphrase',
      organization_id: 3,
    }).ok,
    false
  );

  /* The password rule is auth's, not a second copy — a short one must fail here too. */
  check(
    'the shared password policy applies',
    run(schemas.create, { name: 'A', email: 'a@example.com', username: 'a.parent', password: 'short' }).ok,
    false
  );
  check(
    'username is lower-cased on the way in',
    run(schemas.create, {
      name: 'A',
      email: 'a@example.com',
      username: 'A.Parent',
      password: 'Str0ng!Passphrase',
    }).value.username,
    'a.parent'
  );

  /* Children may be named at creation — FR-PARENT-001's second half in one request. */
  const withKids = run(schemas.create, {
    name: 'Ada',
    email: 'a@example.com',
    username: 'a.parent',
    password: 'Str0ng!Passphrase',
    children: [{ student_id: 3, relation: 'Father', is_primary_guardian: true }],
  });
  check('children may be named at creation', withKids.ok, true);
  check(
    'and a child needs a student_id',
    run(schemas.create, {
      name: 'Ada',
      email: 'a@example.com',
      username: 'a.parent',
      password: 'Str0ng!Passphrase',
      children: [{ relation: 'Father' }],
    }).ok,
    false
  );

  /*
   * The account's fields are not editable through the profile. `users` is owned by §33's screen, and
   * a second write path to the sign-in identifier would be a second place uniqueness and
   * lower-casing have to hold. Each check co-submits a legitimate field, so `.min(1)` cannot be what
   * produces the refusal — the trap §5a records for the students suite.
   */
  for (const field of ['email', 'username', 'password', 'user_id', 'organization_id']) {
    check(
      `${field} is refused on patch`,
      run(schemas.update, { name: 'Renamed', [field]: 'x' }).ok,
      false
    );
  }
  check('the profile itself is editable', run(schemas.update, { occupation: 'Engineer' }).ok, true);
  check('update requires at least one field', run(schemas.update, {}).ok, false);

  /* Widths from the model, not chosen (§5a defect 24). */
  check('name is bounded at 160', run(schemas.update, { name: 'x'.repeat(161) }).ok, false);
  check('and 160 is accepted', run(schemas.update, { name: 'x'.repeat(160) }).ok, true);
  check('occupation is bounded at 120', run(schemas.update, { occupation: 'x'.repeat(121) }).ok, false);
  check('national_id is bounded at 60', run(schemas.update, { national_id: 'x'.repeat(61) }).ok, false);
  check('relation is bounded at 60', run(schemas.update, { relation: 'x'.repeat(61) }).ok, false);

  check('linking a child requires a student_id', run(schemas.linkChild, {}).ok, false);
  check('linking accepts a student_id', run(schemas.linkChild, { student_id: 4 }).ok, true);
}

/* ═══════════════════════════ part 2 — the route table ═══════════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — declared routes ──\n');

  const routes = routesOf(parentRoutes);
  check('the eight §15.2 routes are declared', routes, [
    'GET /',
    'GET /dashboard',
    'POST /',
    'GET /:id/children',
    'POST /:id/children',
    'DELETE /:id/children/:linkId',
    'GET /:id',
    'PATCH /:id',
  ]);

  check(
    'GET /dashboard is declared before GET /:id',
    routes.indexOf('GET /dashboard') < routes.indexOf('GET /:id'),
    true
  );
  check(
    'there is no DELETE on a parent, only on a child link',
    routes.filter((r) => r.startsWith('DELETE')),
    ['DELETE /:id/children/:linkId']
  );

  const writes = parentRoutes.stack
    .filter((l) => l.route && !l.route.methods.get)
    .map((l) => [Object.keys(l.route.methods)[0], l.route.path]);
  check('there are four write routes', writes.length, 4);
  check(
    'no write carries requirePlatformScope()',
    writes.every(([m, p]) => named(parentRoutes, m, p, 'platformGuard') === false),
    true
  );
  check(
    'every write carries validate()',
    writes.every(([m, p]) => named(parentRoutes, m, p, 'validateRequest')),
    true
  );
  check(
    'every write declares its activity',
    writes.every(([m, p]) => named(parentRoutes, m, p, 'activityDeclaration')),
    true
  );
  check(
    'one router-level guard, mounted ahead of every route',
    [parentRoutes.stack.filter((l) => !l.route).length, parentRoutes.stack.findIndex((l) => !l.route)],
    [1, 0]
  );

  /*
   * No `enforceLimit` anywhere, and that is correct rather than forgotten: SRS §11.2's eight limits
   * contain no parent limit, and a parent account is not in `SCHOOL_ADMIN_ROLES`, so it consumes no
   * `admin_limit` either.
   *
   * The first version of this checked `Object.values(LIMITS).some(k => k.includes('parent'))` — a
   * fact about `config/constants.js` that no routing change can falsify, under a label claiming
   * something about the router. It could not catch the one edit it existed to catch. Both halves are
   * asserted separately now, each against the thing its label names.
   */
  check(
    'no route carries an entitlement limit',
    /*
     * Read off the router's SOURCE, not off a handler name. `enforceLimit()` returns an
     * `asyncHandler`-wrapped function called `wrappedAsyncHandler`, so the obvious
     * `h.handle.name !== 'limitGuard'` check compared against a name nothing in this codebase ever
     * has — it could not fail, and it sat here green while proving nothing (§5a session 18).
     */
    mountsLimit('parents'),
    false
  );
  check(
    '  and the probe would find one — the students router does mount a limit',
    mountsLimit('students'),
    true
  );
  check(
    'and §11.2 defines no parent limit to carry',
    Object.values(LIMITS).some((k) => k.includes('parent')),
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

  const created = {
    users: [],
    schools: [],
    organizations: [],
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
    /* A failed sign-in carries no user or tenant for the clauses above to match — see the helper. */
    await removeFailedSignIns(db, { afterId: baseline.activityLog, domains: [DOMAIN] });
    if (created.subscriptions.length) {
      await db.UsageRecord.destroy({ where: { subscription_id: created.subscriptions } });
      await db.Subscription.destroy({ where: { id: created.subscriptions }, force: true });
    }
    if (created.schools.length) {
      /* parent_students first — it references both sides. */
      await db.ParentStudent.destroy({ where: { school_id: created.schools } });
      await db.Parent.destroy({ where: { school_id: created.schools }, force: true });
      await db.Student.destroy({ where: { school_id: created.schools }, force: true });
    }
    /* Every user of these schools, including the parent accounts the module created itself. */
    if (created.schools.length) {
      await db.User.destroy({ where: { school_id: created.schools }, force: true });
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
    for (const slug of [ROLES.SUPER_ADMIN, ROLES.PRINCIPAL, ROLES.PARENT, ROLES.TEACHER]) {
      // eslint-disable-next-line no-await-in-loop
      const role = await db.Role.findOne({ where: { slug } });
      if (!role) throw new Error(`seeded role missing: ${slug}`);
      roles[slug] = role;
    }

    /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
    const residueCleared = await sweepResidue(db, { codes: ['VPA-'], domains: ['verify-parents.local'] });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({ name: 'Verify Parents Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Parents A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Parents B');
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify Parents C');
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Parents D');

    const mkPlan = async (code, portalEnabled) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify Parents ${code}`,
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
          is_enabled: key === MODULES.PARENT_PORTAL ? portalEnabled : true,
        });
      }
      await db.PlanLimit.create({
        plan_id: plan.id,
        limit_key: LIMITS.STUDENT_LIMIT,
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: 50,
      });
      return plan;
    };

    const withPortal = await mkPlan('WITH', true);
    const withoutPortal = await mkPlan('WITHOUT', false);

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

    await subscribe(schoolA, withPortal);
    await subscribe(schoolB, withoutPortal);
    await subscribe(schoolD, withPortal);
    /* schoolC is deliberately left unsubscribed. */

    /* Children to link. Created directly — §15.1's own suite covers the students endpoints. */
    const mkStudent = async (school, code, first) =>
      db.Student.create({
        school_id: school.id,
        organization_id: org.id,
        student_id: code,
        first_name: first,
        admission_date: '2025-04-01',
        status: STUDENT_STATUS.ACTIVE,
      });
    const kidOne = await mkStudent(schoolA, `${CODE_PREFIX}S1`, 'Amina');
    const kidTwo = await mkStudent(schoolA, `${CODE_PREFIX}S2`, 'Bilal');
    const foreignKid = await mkStudent(schoolD, `${CODE_PREFIX}S9`, 'Elsewhere');

    const password_hash = await hashPassword(PASSWORD);
    const people = [
      ['platform', ROLES.SUPER_ADMIN, 'Verify P Platform', 'vpa_platform', null, null],
      ['principal-a', ROLES.PRINCIPAL, 'Verify P Principal A', 'vpa_principal_a', org.id, schoolA.id],
      ['principal-b', ROLES.PRINCIPAL, 'Verify P Principal B', 'vpa_principal_b', org.id, schoolB.id],
      ['principal-c', ROLES.PRINCIPAL, 'Verify P Principal C', 'vpa_principal_c', org.id, schoolC.id],
      ['principal-d', ROLES.PRINCIPAL, 'Verify P Principal D', 'vpa_principal_d', org.id, schoolD.id],
      ['loose-parent', ROLES.PARENT, 'Verify P Loose', 'vpa_loose', org.id, schoolA.id],
      ['teacher', ROLES.TEACHER, 'Verify P Teacher', 'vpa_teacher', org.id, schoolA.id],
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
    const looseParent = await signIn(`loose-parent@${DOMAIN}`);
    const teacher = await signIn(`teacher@${DOMAIN}`);
    check('all seven fixtures sign in', [platform, principalA, principalB, principalC, principalD, looseParent, teacher]
      .every((t) => typeof t === 'string'), true);

    /* ── the entitlement guard ── */

    const moduleDenied = await call('/parents', { token: principalB });
    check('a plan without the Parent Portal refuses', moduleDenied.status, 403);
    check('and names the module', codeOf(moduleDenied), 'MODULE_NOT_SUBSCRIBED');
    check('naming which one', moduleDenied.body.error.details.missing, [MODULES.PARENT_PORTAL]);

    const noSub = await call('/parents', { token: principalC });
    check('a school with no subscription is refused differently', noSub.status, 402);
    check('state is checked before module', codeOf(noSub), 'SUBSCRIPTION_INACTIVE');

    /* ── FR-PARENT-001 — the account, the profile and the children in one request ── */

    const usersBefore = await db.User.count({ where: { school_id: schoolA.id } });

    const createdRes = await expectOk(
      '/parents',
      {
        method: 'POST',
        token: principalA,
        body: {
          name: 'Yusuf Bello',
          email: `yusuf@${DOMAIN}`,
          username: 'vpa_yusuf',
          password: 'Str0ng!Passphrase',
          relation: 'Father',
          occupation: 'Engineer',
          contact_email: `yusuf.home@${DOMAIN}`,
          children: [
            { student_id: kidOne.id, is_primary_guardian: true },
            { student_id: kidTwo.id },
          ],
        },
      },
      201
    );
    const parent = dataOf(createdRes).parent;
    check('a parent is created', parent.name, 'Yusuf Bello');
    check('the profile carries its own contact email, not the account one', parent.email, `yusuf.home@${DOMAIN}`);
    check('is_active defaults to true', parent.is_active, true);
    check('the school comes from the tenant', Number(parent.school_id), schoolA.id);
    check('a verification email was issued', dataOf(createdRes).verificationEmailSent, true);

    /* The account itself. */
    const account = await db.User.findByPk(parent.user_id);
    check('an account was created with the parent role', Number(account.role_id), roles[ROLES.PARENT].id);
    check('and it belongs to the same school', Number(account.school_id), schoolA.id);
    check('and it must change its seeded password', Boolean(account.must_change_password), true);
    check('exactly one user was added', await db.User.count({ where: { school_id: schoolA.id } }), usersBefore + 1);

    const links = await expectOk(`/parents/${parent.id}/children`, { token: principalA }, 200);
    check('both children were linked in the same request', dataOf(links).children.length, 2);
    check(
      'the primary guardian flag is stored',
      dataOf(links).children.filter((c) => c.is_primary_guardian).length,
      1
    );
    check(
      'and the child rows carry the student through the include',
      dataOf(links).children.every((c) => c.student && c.student.id),
      true
    );

    /*
     * A failed create must leave no orphan account. The duplicate username is rejected by the
     * `users` unique index *inside* the transaction, so the parent row and the user row roll back
     * together — asserted by counting users rather than by trusting the status code.
     */
    const dupUsername = await call('/parents', {
      method: 'POST',
      token: principalA,
      body: {
        name: 'Clash',
        email: `clash@${DOMAIN}`,
        username: 'vpa_yusuf',
        password: 'Str0ng!Passphrase',
      },
    });
    check('a duplicate username is refused', dupUsername.status, 409);
    check('and named', codeOf(dupUsername), 'USERNAME_TAKEN');
    check(
      'and the rolled-back attempt left no orphan account',
      await db.User.count({ where: { school_id: schoolA.id } }),
      usersBefore + 1
    );

    const dupEmail = await call('/parents', {
      method: 'POST',
      token: principalA,
      body: {
        name: 'Clash',
        email: `yusuf@${DOMAIN}`,
        username: 'vpa_other',
        password: 'Str0ng!Passphrase',
      },
    });
    check('a duplicate account email is refused', dupEmail.status, 409);
    check('and named', codeOf(dupEmail), 'EMAIL_TAKEN');

    /*
     * The only negative that fails *inside* the transaction, after the account is written.
     *
     * The three below it all fail at or before the first statement — the two duplicate-account cases
     * throw on `db.User.create` itself, and the cross-school child is rejected before the
     * transaction opens. So none of them can prove the transaction spans the later writes: remove
     * `{ transaction: t }` from the parent insert and the child loop and they all still pass.
     *
     * A duplicate `student_id` in `children` is the reachable case that does reach step three: both
     * entries pass the pre-check (the same student is found twice), the user and the parent commit,
     * and the second link violates `parent_students_unique`. Counting **both** tables afterwards is
     * what proves the rollback covered all three writes.
     */
    const dupChild = await call('/parents', {
      method: 'POST',
      token: principalA,
      body: {
        name: 'Twice Linked',
        email: `twice@${DOMAIN}`,
        username: 'vpa_twice',
        password: 'Str0ng!Passphrase',
        children: [{ student_id: kidOne.id }, { student_id: kidOne.id }],
      },
    });
    check('naming the same child twice is refused', dupChild.status, 409);
    check('and named', codeOf(dupChild), 'PARENT_CHILD_LINKED');
    check(
      'the account written before the failure was rolled back',
      await db.User.count({ where: { school_id: schoolA.id } }),
      usersBefore + 1
    );
    check(
      'and so was the parent row',
      await db.Parent.count({ where: { school_id: schoolA.id } }),
      1
    );

    const foreignChild = await call('/parents', {
      method: 'POST',
      token: principalA,
      body: {
        name: 'Foreign',
        email: `foreign@${DOMAIN}`,
        username: 'vpa_foreign',
        password: 'Str0ng!Passphrase',
        children: [{ student_id: foreignKid.id }],
      },
    });
    check("a child from another school is refused", foreignChild.status, 422);
    check(
      'and it is refused before the account is made, so nothing is orphaned',
      await db.User.count({ where: { school_id: schoolA.id } }),
      usersBefore + 1
    );

    /* ── linking and unlinking after creation ── */

    const soloRes = await expectOk(
      '/parents',
      {
        method: 'POST',
        token: principalA,
        body: {
          name: 'Amina Mother',
          email: `mother@${DOMAIN}`,
          username: 'vpa_mother',
          password: 'Str0ng!Passphrase',
          relation: 'Mother',
        },
      },
      201
    );
    const solo = dataOf(soloRes).parent;

    const linked = await expectOk(
      `/parents/${solo.id}/children`,
      { method: 'POST', token: principalA, body: { student_id: kidOne.id } },
      201
    );
    check('a child links to an existing parent', Number(dataOf(linked).link.student_id), kidOne.id);
    check("and inherits the parent's relation when none is named", dataOf(linked).link.relation, 'Mother');

    const dupLink = await call(`/parents/${solo.id}/children`, {
      method: 'POST',
      token: principalA,
      body: { student_id: kidOne.id },
    });
    check('the same child cannot be linked twice', dupLink.status, 409);
    check('and named', codeOf(dupLink), 'PARENT_CHILD_LINKED');

    const crossLink = await call(`/parents/${solo.id}/children`, {
      method: 'POST',
      token: principalA,
      body: { student_id: foreignKid.id },
    });
    check("a child of another school cannot be linked", crossLink.status, 422);

    /* A child may have two parents — that is the point of the join table. */
    const bothParents = await expectOk(`/parents?student_id=${kidOne.id}`, { token: principalA }, 200);
    check('a child can be reached from both its parents', dataOf(bothParents).length, 2);

    const soloLinks = await expectOk(`/parents/${solo.id}/children`, { token: principalA }, 200);
    const linkId = dataOf(soloLinks).children[0].id;
    await expectOk(`/parents/${solo.id}/children/${linkId}`, { method: 'DELETE', token: principalA }, 204);
    const afterUnlink = await expectOk(`/parents/${solo.id}/children`, { token: principalA }, 200);
    check('a child can be unlinked', dataOf(afterUnlink).children.length, 0);

    const goneLink = await call(`/parents/${solo.id}/children/${linkId}`, {
      method: 'DELETE',
      token: principalA,
    });
    check('and unlinking it again is a 404', goneLink.status, 404);

    /*
     * The organization-scoped read of `parent_students`.
     *
     * That table has `school_id` and no `organization_id`, so `tenantWhere()` on it is a 500 for a
     * caller with an organization but no school. Asserted against the service rather than over HTTP,
     * because no seeded role both resolves to that tenant shape and holds `parents.view` — which is
     * exactly why the same defect reached production twice before (§5a defect 16).
     */
    const orgScopedReq = {
      tenant: { organizationId: org.id, schoolId: null, isPlatform: false },
      query: {},
      body: {},
      user: null,
    };
    let orgError = null;
    let orgChildren = null;
    try {
      orgChildren = await parentsService.listChildren(orgScopedReq, parent.id);
    } catch (err) {
      orgError = err.name === 'SequelizeDatabaseError' ? err.parent.sqlMessage : err.message;
    }
    check('an organization-scoped read of parent_students does not raise', orgError, null);
    check(
      'and returns the school rows',
      orgChildren ? orgChildren.rows.length : null,
      2
    );

    /*
     * PATCH — one of the four write routes, and until this block existed the whole update path had
     * no runtime coverage: the service, the `contact_email` remap, the empty-body refusal, the
     * audit row and the forbidden account fields were all proven only against the Joi object.
     */
    const patched = await expectOk(
      `/parents/${parent.id}`,
      { method: 'PATCH', token: principalA, body: { occupation: 'Surveyor', contact_email: `yusuf.new@${DOMAIN}` } },
      200
    );
    check('PATCH updates the profile', dataOf(patched).parent.occupation, 'Surveyor');
    check(
      'and contact_email lands on the profile, not the account',
      dataOf(patched).parent.email,
      `yusuf.new@${DOMAIN}`
    );
    check(
      'while the account email is untouched',
      (await db.User.findByPk(parent.user_id)).email,
      `yusuf@${DOMAIN}`
    );

    const emptyPatch = await call(`/parents/${parent.id}`, {
      method: 'PATCH',
      token: principalA,
      body: { school_id: schoolA.id },
    });
    check('a PATCH with no editable field is refused', emptyPatch.status, 422);

    for (const [field, value] of [
      ['email', `other@${DOMAIN}`],
      ['username', 'vpa_renamed'],
      ['password', 'An0ther!Passphrase'],
    ]) {
      /* eslint-disable-next-line no-await-in-loop */
      const refused = await call(`/parents/${parent.id}`, {
        method: 'PATCH',
        token: principalA,
        body: { name: 'Still Yusuf', [field]: value },
      });
      check(`PATCH refuses the account field ${field}`, refused.status, 422);
    }

    const crossPatch = await call(`/parents/${parent.id}`, {
      method: 'PATCH',
      token: principalD,
      body: { occupation: 'Hijacked' },
    });
    check('a principal of another school cannot patch this parent', crossPatch.status, 404);

    /* ── FR-PARENT-002, the dashboard ── */

    const parentToken = await (async () => {
      /* The created account must change its password before it can reach anything else (§9.3). */
      const login = await call('/auth/login', {
        method: 'POST',
        body: { identifier: `yusuf@${DOMAIN}`, password: 'Str0ng!Passphrase' },
      });
      const first = login.body.data.accessToken;
      check('the new parent can sign in', typeof first, 'string');
      check('and is told to change its password first', login.body.data.user.must_change_password, true);
      const changed = await call('/auth/change-password', {
        method: 'POST',
        token: first,
        body: { currentPassword: 'Str0ng!Passphrase', password: 'An0ther!Passphrase' },
      });
      check('the forced change succeeds', changed.status, 200);
      return changed.body.data.accessToken;
    })();

    const dash = await expectOk('/parents/dashboard', { token: parentToken }, 200);
    check('the parent gets their own dashboard', Number(dataOf(dash).parent.id), Number(parent.id));
    check('with both children', dataOf(dash).counts.children, 2);
    check('and an active count', dataOf(dash).counts.activeChildren, 2);

    const looseDash = await call('/parents/dashboard', { token: looseParent });
    check('a parent-role user with no profile is 404, not 403', looseDash.status, 404);
    check('and the code says why', codeOf(looseDash), 'PARENT_PROFILE_MISSING');

    const principalDash = await call('/parents/dashboard', { token: principalA });
    check(
      'a principal does not hold parents.dashboard.view — the dashboard is the parent’s own',
      principalDash.status,
      403
    );

    /*
     * The module's central authorization claim: `parents.dashboard.view` is a key every parent
     * holds, so the path-id routes must be closed to the parent role. Both header comments rest on
     * it and nothing asserted it — a parent token had only ever been sent to /dashboard.
     */
    for (const [label, path] of [
      ['the parents list', '/parents'],
      ["another parent's record", `/parents/${solo.id}`],
      ["another parent's children", `/parents/${solo.id}/children`],
    ]) {
      /* eslint-disable-next-line no-await-in-loop */
      const refused = await call(path, { token: parentToken });
      check(`a parent cannot read ${label}`, refused.status, 403);
      check(`and it is the permission refusing for ${label}`, codeOf(refused), 'INSUFFICIENT_PERMISSION');
    }

    const teacherRead = await expectOk('/parents', { token: teacher }, 200);
    check('a teacher may read parents', Array.isArray(dataOf(teacherRead)), true);

    /*
     * Deactivation has to reach the account, not just the profile. This is the one module that
     * created the login, so a profile flag that left `users.status` at `active` would be a
     * revocation in name only — the parent would keep signing in and keep reading their children.
     */
    await expectOk(
      `/parents/${parent.id}`,
      { method: 'PATCH', token: principalA, body: { is_active: false } },
      200
    );
    const disabled = await db.User.findByPk(parent.user_id);
    check('deactivating a parent disables the account it created', disabled.status, USER_STATUS.INACTIVE);

    const staleToken = await call('/parents/dashboard', { token: parentToken });
    check('and the dashboard stops answering', staleToken.status === 401 || staleToken.status === 403, true);

    const refusedLogin = await call('/auth/login', {
      method: 'POST',
      body: { identifier: `yusuf@${DOMAIN}`, password: 'An0ther!Passphrase' },
    });
    check('and the parent can no longer sign in at all', refusedLogin.status >= 400, true);

    /* Reactivation puts it back, so the flag is a switch rather than a one-way door. */
    await expectOk(
      `/parents/${parent.id}`,
      { method: 'PATCH', token: principalA, body: { is_active: true } },
      200
    );
    check('reactivating restores the account', (await db.User.findByPk(parent.user_id)).status, USER_STATUS.ACTIVE);

    /* ── reads, isolation, permissions ── */

    const listA = await expectOk('/parents', { token: principalA }, 200);
    check(
      'the list is confined to the caller school',
      dataOf(listA).every((r) => Number(r.school_id) === schoolA.id),
      true
    );
    const searched = await expectOk('/parents?q=Yusuf', { token: principalA }, 200);
    check('the q filter searches names', dataOf(searched).length, 1);

    const dReadsA = await call(`/parents/${parent.id}`, { token: principalD });
    check('a principal of another school cannot read this parent', dReadsA.status, 404);
    check('and it is isolation refusing, not entitlement', codeOf(dReadsA), 'PARENT_NOT_FOUND');

    const teacherWrite = await call('/parents', {
      method: 'POST',
      token: teacher,
      body: {
        name: 'Nope',
        email: `nope@${DOMAIN}`,
        username: 'vpa_nope',
        password: 'Str0ng!Passphrase',
      },
    });
    check('a teacher may read parents but not create one', teacherWrite.status, 403);
    check('and it is the permission refusing', codeOf(teacherWrite), 'INSUFFICIENT_PERMISSION');

    const platformRead = await call(`/parents/${parent.id}`, { token: platform });
    check('the platform admin reads any school', platformRead.status, 200);

    /* ── the audit trail ── */

    const audits = await settleDistinct(
      () => db.AuditLog.findAll({
        where: { id: { [db.Op.gt]: baseline.auditLog } },
        order: [['id', 'ASC']],
      }),
      'table_name',
      3
    );
    const tables = [...new Set(audits.map((r) => r.table_name))].sort();
    check(
      'the account, the profile and the links are all audited',
      ['parent_students', 'parents', 'users'].every((t) => tables.includes(t)),
      true
    );
    const userAudit = audits.find((r) => r.table_name === 'users' && r.event === 'create');
    check('the created account is audited', Boolean(userAudit), true);
    check(
      'and the audit never carries the password hash',
      Boolean(userAudit && userAudit.new_values && userAudit.new_values.password_hash),
      false
    );
    const unlinkAudit = audits.find((r) => r.table_name === 'parent_students' && r.event === 'delete');
    check('an unlink is audited', Boolean(unlinkAudit), true);
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-parents Part 3 teardown failed:', err);
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
    console.error('\nverify-parents crashed:', err);
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
          ? 'All pure parent checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All parent checks passed (Parts 1–3).'
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
