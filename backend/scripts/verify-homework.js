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
 * Verification of Phase 3.P homework — `src/modules/homework/*` — SRS §20.2, FR-HW-001.
 *
 * ## The first suite that uploads a real file
 *
 * `middlewares/upload.js` has carried a `homework` profile since it was written, citing FR-HW-001 by
 * name, and until this module nothing called it — the payment screenshot was the only upload in the
 * application. So this suite posts an actual multipart body with real bytes, then checks three things
 * that only a real upload can show: the file exists on disk under the tenant-scoped path the middleware
 * chooses, the row records its original name, and **the stored path never appears in the response**.
 *
 * It also asserts the negative that matters more: `attachment_path` in a JSON body is **refused**, not
 * stripped. Known Issues #26 records five columns elsewhere that still accept a caller-supplied path,
 * and §20 is the section that will finally need a route that reads one back off disk.
 *
 * ## The self-scoping half, which is where the real risk is
 *
 * The seeded catalogue gives `homework.view` to staff **and** to students and parents, with no separate
 * `homework.self.view` to tell them apart. So a student holding the same permission as a teacher would,
 * without service-level narrowing, list every class's homework in the school.
 *
 * Every self-scope assertion here has a **counter-example that must be excluded** — a second class in
 * the same school with its own homework, and an unpublished draft for the student's own class. A test
 * that only checked "the student sees their homework" would pass with the narrowing deleted.
 *
 * Part 1 — request schemas (no database).
 * Part 2 — the declared route table, the router-level guard and the upload chain.
 * Part 3 — over real HTTP against the real database, including a real file.
 *
 * Run: node scripts/verify-homework.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const { settleRows } = require('./lib/settle');

const homeworkRoutes = require('../src/modules/homework/homework.routes');
const { schemas } = require('../src/modules/homework/homework.validation');

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
  UPLOAD_PROFILES,
} = require('../src/config/constants');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-homework.local';
const PASSWORD = 'Verify@Homework123';
const CODE_PREFIX = 'VHW-';

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

function handlerNames(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  return layer ? layer.route.stack.map((s) => s.handle.name) : [];
}

/** A valid body, so a rejection can only be about the field under test. */
const HW = { class_id: 1, title: 'Read chapter 4', due_date: '2025-09-20' };

/* ═══════════════════════════ part 1 — request schemas ═══════════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas ──\n');

  check('a complete homework validates', run(schemas.create, HW).ok, true);
  check('a class is required — §20.2 makes it available to "the relevant class"',
    run(schemas.create, { title: 'x', due_date: '2025-09-20' }).ok, false);
  check('a title is required', run(schemas.create, { class_id: 1, due_date: '2025-09-20' }).ok, false);
  check('a due date is required — §20.2 names setting one as one of the three things a teacher does',
    run(schemas.create, { class_id: 1, title: 'x' }).ok, false);

  /* Widths read off models/other.js, not guessed. */
  const width = (field, n) => run(schemas.create, { ...HW, [field]: 'x'.repeat(n) }).ok;
  check('title is bounded at its STRING(180)', [width('title', 180), width('title', 181)], [true, false]);
  check('description at 5000', [width('description', 5000), width('description', 5001)], [true, false]);

  for (const owned of ['attachment_path', 'attachment_name', 'created_by', 'notified_at', 'organization_id']) {
    const r = run(schemas.create, { ...HW, [owned]: owned.endsWith('_path') || owned.endsWith('_name') ? 'x' : 1 });
    check(`a caller-supplied ${owned} is refused`, r.ok, false);
    /* The rest of the body is valid, so the failing path can only be the forbidden key. */
    check(`  and names ${owned} as the reason`, r.keys, [owned]);
  }
  check('the same two are refused on update too', [
    run(schemas.update, { attachment_path: '/etc/passwd' }).ok,
    run(schemas.update, { attachment_name: 'x' }).ok,
  ], [false, false]);
  check('an update needs at least one field', run(schemas.update, {}).ok, false);

  /* A transposed window is refused rather than answered with a confident empty list. */
  check('a due window must be ordered', run(schemas.list, { due_from: '2025-12-31', due_to: '2025-01-01' }).ok, false);
  check('an ordered one is accepted', run(schemas.list, { due_from: '2025-01-01', due_to: '2025-12-31' }).ok, true);
  check('and either bound alone is legal', [
    run(schemas.list, { due_from: '2025-01-01' }).ok,
    run(schemas.list, { due_to: '2025-12-31' }).ok,
  ], [true, true]);

  /*
   * Multipart text fields arrive as strings, so `convert: true` is doing real work on this schema in a
   * way it is not on a JSON-only one. Asserted because the create route is the only multipart route in
   * the module and a string that failed to coerce would surface as a confusing 422.
   */
  const asStrings = run(schemas.create, { class_id: '7', title: 'x', due_date: '2025-09-20', is_published: 'false' });
  check('a multipart body of strings coerces', asStrings.ok, true);
  check('  class_id becomes a number', typeof asStrings.value.class_id, 'number');
  check('  and is_published a boolean', asStrings.value.is_published, false);
}

/* ═══════════════════════════ part 2 — the route table ═══════════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — declared routes ──\n');

  const routes = routesOf(homeworkRoutes);
  /* Five: four for the record, and FR-HW-001's file, which is what makes homework "available". */
  check('the five §20.2 routes are declared', routes,
    ['GET /', 'POST /', 'GET /:id/attachment', 'GET /:id', 'PATCH /:id']);
  check('there is no DELETE — §20.2 names none, and is_published withdraws it',
    routes.some((r) => r.startsWith('DELETE')), false);

  const post = handlerNames(homeworkRoutes, 'post', '/');
  check('the create route mounts the upload chain', post.includes('multerRunner'), true);
  check('  and sanitises the parsed multipart body', post.includes('sanitizeParsedBody'), true);
  check('  with validate AFTER the upload, so it sees the text fields',
    post.indexOf('validateRequest') > post.indexOf('multerRunner'), true);
  check('  and the activity declared after that', post.indexOf('activityDeclaration') > post.indexOf('validateRequest'), true);

  const patch = handlerNames(homeworkRoutes, 'patch', '/:id');
  check('the update route does NOT accept a replacement file', patch.includes('multerRunner'), false);

  check('every write carries validate()', [
    handlerNames(homeworkRoutes, 'post', '/').includes('validateRequest'),
    handlerNames(homeworkRoutes, 'patch', '/:id').includes('validateRequest'),
  ], [true, true]);
  check(
    'one router-level guard, mounted ahead of every route',
    [homeworkRoutes.stack.filter((l) => !l.route).length, homeworkRoutes.stack.findIndex((l) => !l.route)],
    [1, 0]
  );

  check('no route carries an entitlement limit', mountsLimit('homework'), false);
  check('  and the probe would find one — the students router does mount a limit', mountsLimit('students'), true);
  check('and §11.2 defines no homework limit to carry',
    Object.values(LIMITS).some((k) => k.includes('homework')), false);

  /* The profile was reserved for this FR long before there was a caller. */
  check('the upload profile used is the one §20.2 reserved', UPLOAD_PROFILES.HOMEWORK, 'homework');
  const routerSource = fs
    .readFileSync(path.join(__dirname, '../src/modules/homework/homework.routes.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check('  and the router names it rather than a seventh', /UPLOAD_PROFILES\.HOMEWORK/.test(routerSource), true);
}

/* ═══════════════════════════ part 3 — over real HTTP ═══════════════════════════ */

async function verifyHttp() {
  console.log('\n── Part 3 — real HTTP against the real database ──\n');

  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  const created = { users: [], schools: [], organizations: [], plans: [], subscriptions: [] };
  const uploaded = [];
  const baseline = {
    activityLog: (await db.ActivityLog.max('id')) || 0,
    auditLog: (await db.AuditLog.max('id')) || 0,
  };

  /*
   * Every request this suite makes is tagged, so its rows can be told from another suite's.
   *
   * `requestContext.js:24` honours an inbound `X-Request-Id` when it matches
   * `/^[A-Za-z0-9._~-]{8,64}$/`, and stores it on `activity_logs.request_id` and
   * `audit_logs.request_id`. The counter is **zero-padded to four digits** because of that lower
   * bound: a short tag like `vfy-ai-1` is seven characters, silently rejected, and replaced with a
   * nanoid — the tagging would appear to work and quietly tag nothing.
   *
   * This is what Known Issues #25 said was impossible for want of a place to put a run id. There is
   * one, and it has been there since `requestContext.js` was written.
   */
  const REQUEST_TAG = 'vfy-homework';
  let requestSeq = 0;

  async function call(pathname, { method = 'GET', body, token, form, binary = false } = {}) {
    const headers = { 'X-Request-Id': `${REQUEST_TAG}-${String(++requestSeq).padStart(4, '0')}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (form) {
      payload = form; /* fetch sets the multipart boundary itself */
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + pathname, { method, headers, body: payload });
    /* FR-HW-001's attachment is bytes; reading it as text would corrupt it before any assertion. */
    if (binary) {
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        contentLength: res.headers.get('content-length'),
        disposition: res.headers.get('content-disposition'),
        cacheControl: res.headers.get('cache-control'),
        nosniff: res.headers.get('x-content-type-options'),
        buffer: Buffer.from(await res.arrayBuffer()),
      };
    }
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
    /*
     * The run's own rows, by tag — this is what makes the teardown safe to run concurrently. The
     * tenant clauses below cover rows written by directly-driven services with no request; this one
     * covers the platform-scope rows those clauses cannot reach, which is the residue #25 records.
     */
    const ownRequests = { request_id: { [db.Op.like]: `${REQUEST_TAG}-%` } };

    const ownTenant = [
      ownRequests,
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
      await db.Homework.destroy({ where: { school_id: created.schools } });
      await db.ParentStudent.destroy({ where: { school_id: created.schools } });
      await db.Parent.destroy({ where: { school_id: created.schools }, force: true });
      await db.Student.destroy({ where: { school_id: created.schools }, force: true });
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
    /* The school's upload tree, so no empty `school-<id>/` shell survives the run either. */
    for (const schoolId of created.schools) {
      try {
        fs.rmSync(path.join(config.uploads.dir, `school-${schoolId}`), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    /* Real bytes were written to disk; this suite is the only thing that will ever collect them. */
    for (const abs of uploaded) {
      try {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch {
        /* best effort */
      }
    }
  }

  try {
    const roles = {};
    for (const slug of [ROLES.SUPER_ADMIN, ROLES.PRINCIPAL, ROLES.TEACHER, ROLES.STUDENT, ROLES.PARENT, ROLES.ORGANIZATION_ADMIN]) {
      // eslint-disable-next-line no-await-in-loop
      const role = await db.Role.findOne({ where: { slug } });
      if (!role) throw new Error(`seeded role missing: ${slug}`);
      roles[slug] = role;
    }

    /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
    const residueCleared = await sweepResidue(db, { codes: ['VHW-'], domains: ['verify-homework.local'], uploadsDir: config.uploads.dir });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({ name: 'Verify Homework Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Homework A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Homework B');
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify Homework C');
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Homework D');

    const mkPlan = async (code, homeworkEnabled) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify Homework ${code}`, code: `${CODE_PREFIX}${code}`, status: PLAN_STATUS.ACTIVE,
        tier_rank: 1, trial_days: 0, grace_period_days: 7,
      });
      created.plans.push(plan.id);
      for (const key of MODULE_LIST) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanModule.create({ plan_id: plan.id, module_key: key, is_enabled: key === MODULES.HOMEWORK ? homeworkEnabled : true });
      }
      for (const k of [LIMITS.STUDENT_LIMIT, LIMITS.TEACHER_LIMIT, LIMITS.FILE_UPLOAD_LIMIT, LIMITS.STORAGE_LIMIT]) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanLimit.create({ plan_id: plan.id, limit_key: k, limit_type: LIMIT_TYPES.FIXED, limit_value: 100 });
      }
      return plan;
    };
    const withHomework = await mkPlan('WITH', true);
    const withoutHomework = await mkPlan('WITHOUT', false);

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
    await subscribe(schoolA, withHomework);
    await subscribe(schoolB, withoutHomework);
    await subscribe(schoolD, withHomework);
    /* schoolC is deliberately left unsubscribed. */

    const mkStructure = async (school, tag) => {
      const session = await db.AcademicSession.create({
        school_id: school.id, organization_id: org.id, name: `${tag} 2025-2026`,
        start_date: '2025-04-01', end_date: '2026-03-31', status: ACADEMIC_SESSION_STATUS.ACTIVE, is_current: true,
      });
      const klass = await db.Class.create({
        school_id: school.id, organization_id: org.id, academic_session_id: session.id, name: `${tag} Grade 1`, numeric_order: 1,
      });
      const other = await db.Class.create({
        school_id: school.id, organization_id: org.id, academic_session_id: session.id, name: `${tag} Grade 2`, numeric_order: 2,
      });
      const section = await db.Section.create({ school_id: school.id, organization_id: org.id, class_id: klass.id, name: 'A' });
      const subject = await db.Subject.create({ school_id: school.id, organization_id: org.id, name: `${tag} Maths`, code: `${CODE_PREFIX}${tag}M` });
      /* On Grade 1's curriculum only — D30 lets homework name a subject the class is taught. */
      await db.ClassSubject.create({ school_id: school.id, class_id: klass.id, subject_id: subject.id });
      return { session, klass, other, section, subject };
    };
    const A = await mkStructure(schoolA, 'A');
    const D = await mkStructure(schoolD, 'D');

    const teacherA = await db.Teacher.create({
      school_id: schoolA.id, organization_id: org.id, employee_id: `${CODE_PREFIX}T1`,
      first_name: 'Nadia', joining_date: '2024-01-15',
    });
    const foreignTeacher = await db.Teacher.create({
      school_id: schoolD.id, organization_id: org.id, employee_id: `${CODE_PREFIX}T9`,
      first_name: 'Faraway', joining_date: '2024-01-15',
    });

    const password_hash = await hashPassword(PASSWORD);
    const mkUser = async (key, slug, organization_id, school_id) => {
      const u = await db.User.create({
        role_id: roles[slug].id, organization_id, school_id, name: `Verify HW ${key}`,
        email: `${key}@${DOMAIN}`, username: `vhw_${key.replace(/-/g, '_')}`,
        password_hash, status: USER_STATUS.ACTIVE, must_change_password: false,
      });
      created.users.push(u.id);
      return u;
    };
    await mkUser('principal-a', ROLES.PRINCIPAL, org.id, schoolA.id);
    await mkUser('principal-b', ROLES.PRINCIPAL, org.id, schoolB.id);
    await mkUser('principal-c', ROLES.PRINCIPAL, org.id, schoolC.id);
    await mkUser('principal-d', ROLES.PRINCIPAL, org.id, schoolD.id);
    await mkUser('teacher', ROLES.TEACHER, org.id, schoolA.id);
    await mkUser('org-admin', ROLES.ORGANIZATION_ADMIN, org.id, null);
    const studentUser = await mkUser('student', ROLES.STUDENT, org.id, schoolA.id);
    const parentUser = await mkUser('parent', ROLES.PARENT, org.id, schoolA.id);

    /* Amina sits in Grade 1; Bilal sits in Grade 2 — Bilal is the counter-example. */
    await db.Student.create({
      school_id: schoolA.id, organization_id: org.id, student_id: `${CODE_PREFIX}S1`, first_name: 'Amina',
      admission_date: '2025-04-01', status: STUDENT_STATUS.ACTIVE,
      class_id: A.klass.id, section_id: A.section.id, academic_session_id: A.session.id, user_id: studentUser.id,
    });
    const bilal = await db.Student.create({
      school_id: schoolA.id, organization_id: org.id, student_id: `${CODE_PREFIX}S2`, first_name: 'Bilal',
      admission_date: '2025-04-01', status: STUDENT_STATUS.ACTIVE,
      class_id: A.other.id, academic_session_id: A.session.id,
    });
    const parent = await db.Parent.create({
      school_id: schoolA.id, organization_id: org.id, user_id: parentUser.id,
      name: 'Yusuf Parent', first_name: 'Yusuf', last_name: 'Parent', is_active: true,
    });
    /* The parent's child is in Grade 2, so the parent and the student see DIFFERENT classes. */
    await db.ParentStudent.create({ school_id: schoolA.id, parent_id: parent.id, student_id: bilal.id, relation: 'father' });

    async function signIn(identifier) {
      const res = await call('/auth/login', { method: 'POST', body: { identifier, password: PASSWORD } });
      const token = res.body && res.body.data ? res.body.data.accessToken : null;
      if (!token) throw new Error(`sign-in failed for ${identifier}: ${res.raw}`);
      return token;
    }
    const principalA = await signIn(`principal-a@${DOMAIN}`);
    const principalB = await signIn(`principal-b@${DOMAIN}`);
    const principalC = await signIn(`principal-c@${DOMAIN}`);
    const principalD = await signIn(`principal-d@${DOMAIN}`);
    const teacher = await signIn(`teacher@${DOMAIN}`);
    const orgAdmin = await signIn(`org-admin@${DOMAIN}`);
    const studentToken = await signIn(`student@${DOMAIN}`);
    const parentToken = await signIn(`parent@${DOMAIN}`);

    /* ── the entitlement guard ── */

    const moduleDenied = await call('/homework', { token: principalB });
    check('a plan without the Homework module refuses', moduleDenied.status, 403);
    check('and names the module', codeOf(moduleDenied), 'MODULE_NOT_SUBSCRIBED');
    check('naming which one', moduleDenied.body.error.details.missing, [MODULES.HOMEWORK]);
    const noSub = await call('/homework', { token: principalC });
    check('a school with no subscription is refused differently', noSub.status, 402);
    check('state is checked before module', codeOf(noSub), 'SUBSCRIPTION_INACTIVE');

    /* ── FR-HW-001 — the teacher creates homework ── */

    const mk = async (body, token = teacher) =>
      dataOf(await expectOk('/homework', { method: 'POST', token, body }, 201)).homework;

    const hw = await mk({
      class_id: A.klass.id, section_id: A.section.id, subject_id: A.subject.id, teacher_id: teacherA.id,
      title: 'Read chapter 4', description: 'Questions 1-10', due_date: '2025-09-20', assigned_date: '2025-09-15',
    });
    check('a Teacher creates homework — FR-HW-001 names them as the actor', Boolean(hw.id), true);
    check('the school is taken from the caller, never the body', hw.school_id, schoolA.id);
    check('and so is the organization', hw.organization_id, org.id);
    check('the creator is stamped on the row', Boolean(hw.created_by), true);
    check('both dates are stored as plain dates', [hw.assigned_date, hw.due_date], ['2025-09-15', '2025-09-20']);
    check('with no file, the row says so', hw.has_attachment, false);
    check('it is published by default — §20.2 makes it available to the class', hw.is_published, true);

    /* A due date safely after any plausible "today", so the defaulted assigned_date cannot overtake it. */
    const noDate = await mk({ class_id: A.klass.id, title: 'No assigned date', due_date: '2030-09-25' });
    check('an omitted assigned_date defaults to today rather than to null', Boolean(noDate.assigned_date), true);

    /* ── what a create may not do ── */

    const bodyPath = await call('/homework', {
      method: 'POST', token: teacher,
      body: { ...HW, class_id: A.klass.id, attachment_path: '/etc/passwd' },
    });
    check('a body-supplied attachment_path is refused, not stripped', bodyPath.status, 422);

    const backwards = await call('/homework', {
      method: 'POST', token: teacher,
      body: { class_id: A.klass.id, title: 'Backwards', assigned_date: '2025-09-20', due_date: '2025-09-15' },
    });
    check('a due date before the assigned date is refused by the model validator', backwards.status, 422);

    const foreignClass = await call('/homework', {
      method: 'POST', token: teacher, body: { class_id: D.klass.id, title: 'x', due_date: '2025-09-20' },
    });
    check("homework cannot be set for another school's class", foreignClass.status, 422);
    const foreignSubject = await call('/homework', {
      method: 'POST', token: teacher, body: { class_id: A.klass.id, subject_id: D.subject.id, title: 'x', due_date: '2025-09-20' },
    });
    check("nor name another school's subject", foreignSubject.status, 422);
    /*
     * D30 — FR-HW-001's "Class/subject assignment exists" (SRS:1099). The subject is the school's own
     * and on Grade 1's curriculum, but not Grade 2's; only the pair was ever unchecked.
     */
    const offCurriculum = await call('/homework', {
      method: 'POST', token: teacher, body: { class_id: A.other.id, subject_id: A.subject.id, title: 'x', due_date: '2030-09-20' },
    });
    check("D30 — nor a subject of this school that the class is not taught, naming the field",
      [offCurriculum.status, ((offCurriculum.body.error || {}).details || []).map((d) => d.field)], [422, ['subject_id']]);
    /*
     * A section's own curriculum counts for that section only: a subject taught only in section A may be
     * named on section A's homework, not on homework for the whole class.
     */
    const sectionOnlySubject = await db.Subject.create({
      school_id: schoolA.id, organization_id: org.id, name: 'A Section Art', code: `${CODE_PREFIX}AART`,
    });
    await db.ClassSubject.create({ school_id: schoolA.id, class_id: A.klass.id, section_id: A.section.id, subject_id: sectionOnlySubject.id });
    const wholeClassArt = await call('/homework', {
      method: 'POST', token: teacher, body: { class_id: A.klass.id, subject_id: sectionOnlySubject.id, title: 'x', due_date: '2030-09-20' },
    });
    const sectionArt = await call('/homework', {
      method: 'POST', token: teacher,
      body: { class_id: A.klass.id, section_id: A.section.id, subject_id: sectionOnlySubject.id, title: 'Section art', due_date: '2030-09-20' },
    });
    check('  a subject on one section\'s curriculum only is refused for the whole class, and accepted for that section',
      [wholeClassArt.status, sectionArt.status], [422, 201]);
    const foreignTeacherHw = await call('/homework', {
      method: 'POST', token: teacher, body: { class_id: A.klass.id, teacher_id: foreignTeacher.id, title: 'x', due_date: '2025-09-20' },
    });
    check("nor another school's teacher", foreignTeacherHw.status, 422);

    const studentCreate = await call('/homework', {
      method: 'POST', token: studentToken, body: { class_id: A.klass.id, title: 'x', due_date: '2025-09-20' },
    });
    check('a student cannot set homework — homework.view is not homework.manage', studentCreate.status, 403);
    check('  and it is the permission that is missing', codeOf(studentCreate), 'INSUFFICIENT_PERMISSION');

    /* ── the upload, with real bytes ── */

    const form = new FormData();
    form.set('class_id', String(A.klass.id));
    form.set('title', 'Worksheet');
    form.set('due_date', '2030-09-22');
    form.set('attachment', new Blob([Buffer.from('%PDF-1.4\nverify-homework\n')], { type: 'application/pdf' }), 'worksheet.pdf');
    const uploadedHw = dataOf(await expectOk('/homework', { method: 'POST', token: teacher, form }, 201)).homework;

    check('a real multipart upload is accepted', uploadedHw.has_attachment, true);
    check('  and the original filename is kept', uploadedHw.attachment_name, 'worksheet.pdf');
    /*
     * The path describes the server's directory layout. `payments` reduces its screenshot to a boolean
     * for the same reason, and there is nothing to fetch the file with yet.
     */
    check('  while the stored path never reaches the caller', 'attachment_path' in uploadedHw, false);

    const stored = await db.Homework.findByPk(uploadedHw.id);
    check('the row does hold a path', Boolean(stored.attachment_path), true);
    check('  which is relative, not the absolute disk path', path.isAbsolute(stored.attachment_path), false);
    check('  and tenant-scoped under the school and the profile',
      /^school-\d+\/homework\//.test(stored.attachment_path), true);
    const abs = path.join(config.uploads.dir, stored.attachment_path);
    uploaded.push(abs);
    check('  and the bytes are really on disk', fs.existsSync(abs), true);

    /* ══════════ FR-HW-001's file, fetched back ══════════ */

    /*
     * This is the first route in the application that serves a stored file — there was no
     * `res.download`, `res.sendFile`, `express.static` or streamed response anywhere before it.
     *
     * The assertion that matters is the **bytes**: not that a 200 came back, but that what came back
     * is the file that went in. A route that returned an empty body, the wrong file, or a JSON error
     * with a 200 would satisfy anything weaker.
     */
    const fetched = await call(`/homework/${uploadedHw.id}/attachment`, { token: teacher, binary: true });
    check('FR-HW-001 — the attachment is served back', fetched.status, 200);
    check('  as the exact bytes that were uploaded',
      fetched.buffer.toString(), '%PDF-1.4\nverify-homework\n');
    check('  with the type derived from the upload allowlist, not from the request',
      fetched.contentType, 'application/pdf');
    check('  named for the teacher\'s original file, not the random stored one',
      /filename="worksheet\.pdf"/.test(fetched.disposition), true);
    check('  and a Content-Length matching the body',
      Number(fetched.contentLength), fetched.buffer.length);
    /*
     * A stored file is one school's private data. Without `no-store` a shared proxy could hold it and
     * hand it to the next caller, whose own permission check would never run.
     */
    check('  marked private and no-store, because a proxy must not hold one',
      /no-store/.test(fetched.cacheControl || ''), true);
    check('  and nosniff, because the bytes are user-supplied',
      fetched.nosniff, 'nosniff');

    /* Homework with no file is a 404, not an empty 200 that looks like a broken download. */
    const noFile = await call(`/homework/${hw.id}/attachment`, { token: teacher });
    check('homework with no attachment is a 404, not an empty 200', noFile.status, 404);

    /*
     * The authorization assertion, and the reason the route takes a RECORD rather than a path: the
     * file inherits `selfScopePlacements()` from `findById()`. A student in another class cannot read
     * the homework, so they cannot read its file — with no second rule written anywhere to keep in
     * step with the first.
     */
    const outsiderFetch = await call(`/homework/${uploadedHw.id}/attachment`, { token: principalB });
    check('another school cannot fetch the file — refused by the tenant chain, before the record '
      + 'is even looked for',
      outsiderFetch.status, 403);

    /*
     * And the path is never accepted from a caller. There is no route that takes one — asserted by
     * the route table above — but this is the direct form: a traversal string handed to the resolver
     * is refused, so the day a migration or a fixture writes something odd into the column, the
     * filesystem is still not reachable through it.
     */
    const { resolveStored } = require('../src/utils/fileResponse');
    const refuses = (value) => {
      try { resolveStored(value); return false; } catch (_) { return true; }
    };
    check('the resolver refuses every shape of escape',
      ['../../etc/passwd', 'school-1/../../../etc/passwd', '/etc/passwd', 'C:/Windows/win.ini',
        'school-1/x\u0000.png', '', 'school-1/../../uploads-evil/x.png']
        .filter((attack) => !refuses(attack)), []);
    check('  while a legitimate stored path resolves',
      refuses(stored.attachment_path), false);

    const badType = new FormData();
    badType.set('class_id', String(A.klass.id));
    badType.set('title', 'Bad type');
    badType.set('due_date', '2030-09-22');
    badType.set('attachment', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'evil.exe');
    const refusedType = await call('/homework', { method: 'POST', token: teacher, form: badType });
    check('a file type outside the profile allowlist is refused', refusedType.status, 415);

    /* ── the self-scoping half ── */

    const otherClassHw = await mk({ class_id: A.other.id, title: 'Grade 2 homework', due_date: '2030-09-21' });
    const draft = await mk({ class_id: A.klass.id, title: 'Unpublished draft', due_date: '2030-09-23', is_published: false });

    const staffList = dataOf(await expectOk('/homework?limit=50', { token: principalA }, 200));
    check('a principal sees the whole school', staffList.map((h) => h.title).includes('Grade 2 homework'), true);
    check('  including an unpublished draft', staffList.map((h) => h.title).includes('Unpublished draft'), true);

    const studentList = dataOf(await expectOk('/homework?limit=50', { token: studentToken }, 200));
    const studentTitles = studentList.map((h) => h.title);
    check('a student sees their own class', studentTitles.includes('Read chapter 4'), true);
    check("  and NOT another class's — the counter-example exists", studentTitles.includes('Grade 2 homework'), false);
    check('  nor an unpublished draft for their own class', studentTitles.includes('Unpublished draft'), false);
    check('  every row they see is their class', studentList.every((h) => h.class_id === A.klass.id), true);

    /* The parent's child is in Grade 2, so the parent and the student must see different sets. */
    const parentTitles = dataOf(await expectOk('/homework?limit=50', { token: parentToken }, 200)).map((h) => h.title);
    check("a parent sees their child's class", parentTitles.includes('Grade 2 homework'), true);
    check('  and not the other class', parentTitles.includes('Read chapter 4'), false);

    /* The narrowing must hold on a read by id, or it is a courtesy anyone can step around. */
    const studentPeek = await call(`/homework/${otherClassHw.id}`, { token: studentToken });
    check("a student cannot read another class's homework by id", studentPeek.status, 404);
    check('  and is told it does not exist, not that it is forbidden', codeOf(studentPeek), 'HOMEWORK_NOT_FOUND');
    const draftPeek = await call(`/homework/${draft.id}`, { token: studentToken });
    check('nor an unpublished draft for their own class', draftPeek.status, 404);
    const ownPeek = await expectOk(`/homework/${hw.id}`, { token: studentToken }, 200);
    check('  while their own published homework reads fine', dataOf(ownPeek).homework.title, 'Read chapter 4');

    /*
     * The section half. Homework can be set for one section (§20.2's "the relevant class/students", and
     * the form's promise that naming a section confines it), and the narrowing used to check the class
     * alone — so every other section of Amina's class was shown section A's homework, and she theirs.
     */
    const sectionB = await db.Section.create({
      school_id: schoolA.id, organization_id: org.id, class_id: A.klass.id, name: 'B',
    });
    const forB = await mk({ class_id: A.klass.id, section_id: sectionB.id, title: 'Section B only', due_date: '2030-09-24' });
    const sectionedTitles = dataOf(await expectOk('/homework?limit=50', { token: studentToken }, 200)).map((h) => h.title);
    check("a student in section A sees section A's homework and the class-wide kind, and not section B's",
      [sectionedTitles.includes('Read chapter 4'), sectionedTitles.includes('No assigned date'),
        sectionedTitles.includes('Section B only')],
      [true, true, false]);
    check("  nor can they read section B's by id", (await call(`/homework/${forB.id}`, { token: studentToken })).status, 404);
    check('  and a class_id filter narrows inside the rule rather than replacing it',
      dataOf(await expectOk(`/homework?limit=50&class_id=${A.klass.id}`, { token: studentToken }, 200))
        .map((h) => h.title).includes('Section B only'),
      false);

    /* ── tenant scoping ── */

    const dHw = dataOf(await expectOk('/homework', {
      method: 'POST', token: principalD, body: { class_id: D.klass.id, title: 'D homework', due_date: '2030-09-20' },
    }, 201)).homework;
    const listA = dataOf(await expectOk('/homework?limit=50', { token: principalA }, 200));
    check("a school does not see another school's homework", listA.map((h) => h.title).includes('D homework'), false);
    check('  and every row belongs to the caller', listA.every((h) => h.school_id === schoolA.id), true);
    const foreignRead = await call(`/homework/${dHw.id}`, { token: principalA });
    check("another school's homework is not found, not merely forbidden", foreignRead.status, 404);

    /*
     * An Organization Admin holds NEITHER homework permission. The seeded catalogue gives that role
     * `timetable.view` but nothing homework-shaped at all, so it cannot read a school's homework even
     * by naming the school. Asserted because it is the opposite of what a reader would guess from every
     * other module — §17, §18 and §19 all let an org admin read — and because the catalogue is fixed by
     * §29/§30, so this is a decision to record rather than a gap to close.
     */
    const orgRead = await call(`/homework?school_id=${schoolA.id}`, { token: orgAdmin });
    check('an organization admin cannot read homework at all', orgRead.status, 403);
    check('  and it is the permission, not the module or the school', codeOf(orgRead), 'INSUFFICIENT_PERMISSION');
    check('  which the seeded catalogue confirms: the role holds no homework key',
      require('../src/config/permissions.js').DEFAULT_ROLE_PERMISSIONS.organization_admin.filter((k) => k.startsWith('homework')), []);

    /* ── correcting a row ── */

    const corrected = dataOf(await expectOk(`/homework/${hw.id}`, {
      method: 'PATCH', token: teacher, body: { due_date: '2025-09-27', reason: 'Extended a week' },
    }, 200)).homework;
    check('a due date can be corrected', corrected.due_date, '2025-09-27');
    const withdrawn = dataOf(await expectOk(`/homework/${otherClassHw.id}`, {
      method: 'PATCH', token: teacher, body: { is_published: false },
    }, 200)).homework;
    check('and homework is withdrawn by unpublishing, since §20.2 names no delete', withdrawn.is_published, false);
    check(
      '  which removes it from the class it was set for',
      dataOf(await expectOk('/homework?limit=50', { token: parentToken }, 200)).map((h) => h.title).includes('Grade 2 homework'),
      false
    );

    /*
     * Moving the homework to another class without naming a section would leave the section it kept
     * pointing at the class it used to belong to — a pairing the create path refuses outright. §5a
     * session 19 found exactly this shape on `PATCH /exams/:id`, so it is checked here rather than
     * rediscovered later.
     */
    const sectioned = await mk({
      class_id: A.klass.id, section_id: A.section.id, title: 'Sectioned', due_date: '2030-10-01',
    });
    const moved = await call(`/homework/${sectioned.id}`, {
      method: 'PATCH', token: teacher, body: { class_id: A.other.id },
    });
    check('moving to another class does not carry the old section with it', moved.status, 422);
    check(
      '  and the row is untouched by the attempt',
      Number((await db.Homework.findByPk(sectioned.id)).class_id),
      Number(A.klass.id)
    );
    const movedWithSection = await expectOk(`/homework/${sectioned.id}`, {
      method: 'PATCH', token: teacher, body: { class_id: A.other.id, section_id: null },
    }, 200);
    check('  while naming the section explicitly is accepted', dataOf(movedWithSection).homework.class_id, A.other.id);

    /* ── the DATEONLY trap, at a western offset (Known Issues #20) ── */

    const tzBefore = process.env.TZ;
    let west = null;
    try {
      process.env.TZ = 'America/New_York';
      west = await mk({ class_id: A.klass.id, title: 'TZ probe', assigned_date: '2025-07-01', due_date: '2025-07-05' });
    } finally {
      if (tzBefore === undefined) delete process.env.TZ;
      else process.env.TZ = tzBefore;
    }
    check('assigned_date survives a west-of-UTC server', west.assigned_date, '2025-07-01');
    check('and due_date — both DATEONLY columns, not just one', west.due_date, '2025-07-05');
    const [raw] = await db.sequelize.query(`SELECT assigned_date, due_date FROM homework WHERE id = ${Number(west.id)}`);
    check('and the row on disk holds the same days', [
      String(raw[0].assigned_date).slice(0, 10),
      String(raw[0].due_date).slice(0, 10),
    ], ['2025-07-01', '2025-07-05']);

    /* ── the trail ── */

    const hwActivity = await settleRows(async () => (
      await db.ActivityLog.findAll({ where: { id: { [db.Op.gt]: baseline.activityLog } }, order: [['id', 'ASC']] })
    ).filter((r) => r.entity_type === 'homework'));
    check('every homework write is in the activity trail', hwActivity.length > 0, true);
    check('  and none of them records the stored path',
      hwActivity.every((r) => !JSON.stringify(r.metadata || {}).includes('school-')), true);

    const audits = await db.AuditLog.findAll({
      where: { id: { [db.Op.gt]: baseline.auditLog }, table_name: 'homework' },
    });
    check('homework is audited per row', audits.length > 0, true);
    const correction = audits.find((r) => r.event === 'update');
    check('a correction is audited as an update', Boolean(correction), true);
    check('  carrying the reason it was given', correction.reason, 'Extended a week');
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-homework Part 3 teardown failed:', err);
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
    console.error('\nverify-homework crashed:', err);
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
          ? 'All pure homework checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All homework checks passed (Parts 1–3).'
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
