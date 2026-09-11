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
 * Verification of Phase 3.Q assignments — `src/modules/assignments/*` — SRS §20.3, FR-ASG-001.
 *
 * FR-ASG-001 is a three-step lifecycle with two actors — *"Teacher creates an assignment. Student
 * submits the assignment. Teacher reviews the submission."* — and §29 lists **no submissions table**, so
 * one table holds both shapes and `record_type` tells them apart. That single-table design is the source
 * of most of what is checked here.
 *
 * ## The three things that would break silently
 *
 * **1. The two record types must not leak into each other's lists.** `GET /` filters to
 * `record_type = 'assignment'` and `GET /submissions` to `'submission'`. Delete either filter and every
 * ordinary assertion still passes — the teacher still sees the assignment they made — while the
 * assignment list quietly grows a row per student answer. So both lists are asserted for what they must
 * **exclude**, not only for what they contain.
 *
 * **2. A student must not see a classmate's answer.** `assignments.view` reaches students and parents
 * with no `assignments.self.view` to tell them apart — the same catalogue shape §20.2 had. But the
 * narrowing here is by **student**, not by class: two students in the *same* class both submit, and the
 * assertion is that each sees only their own. A class-based narrowing would pass every §20.2-shaped test
 * and still show one child every classmate's work, so the fixture makes that specific mistake visible.
 *
 * **3. `returned` must actually re-open the submit route.** The unique index permits one submission row
 * per student per assignment, so a second attempt has to replace the first. Both halves are asserted:
 * a returned submission accepts a replacement (and loses its stale mark), and a `submitted` or
 * `reviewed` one does not.
 *
 * ## The unique index is doing its job here, unlike the previous three sightings
 *
 * `assignments_submission_unique (parent_assignment_id, student_id)` is the fourth appearance of this
 * index shape in the schema. In `class_subjects`, `timetables` and `fee_structures` a nullable column
 * made MySQL's NULL-distinct rule swallow the duplicates the index was written to reject — three
 * separate defects. Here both columns are non-null on every submission row, because the model validator
 * refuses one without them, so the database really does refuse a second submission. The suite asserts
 * that positively: many assignment rows coexist (both columns NULL, which is wanted), and a second
 * submission by the same student does not.
 *
 * Part 1 — request schemas (no database).
 * Part 2 — the declared route table, its order, the router-level guard and the upload chain.
 * Part 3 — over real HTTP against the real database, including real uploaded bytes.
 *
 * Run: node scripts/verify-assignments.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const { settle, settleDistinct } = require('./lib/settle');

const assignmentRoutes = require('../src/modules/assignments/assignments.routes');
const { schemas } = require('../src/modules/assignments/assignments.validation');

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
  ASSIGNMENT_RECORD_TYPES,
  ASSIGNMENT_STATUS,
  SUBMISSION_STATUS,
  UPLOAD_PROFILES,
} = require('../src/config/constants');
const { DEFAULT_ROLE_PERMISSIONS } = require('../src/config/permissions');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-assignments.local';
const PASSWORD = 'Verify@Assign123';
const CODE_PREFIX = 'VAS-';

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

/** Router source with comments stripped, so a probe cannot match explanatory prose — §5a session 18. */
function routerSource(moduleName) {
  return fs
    .readFileSync(path.join(__dirname, `../src/modules/${moduleName}/${moduleName}.routes.js`), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Does this router MOUNT an entitlement limit? */
function mountsLimit(moduleName) {
  return /enforceLimit/.test(routerSource(moduleName));
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

/** A valid assignment body, so a rejection can only be about the field under test. */
const ASG = { class_id: 1, title: 'Essay on the water cycle' };

/* ═══════════════════════════ part 1 — request schemas ═══════════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas ──\n');

  /* ── step one: create ── */

  check('a complete assignment validates', run(schemas.create, ASG).ok, true);
  check(
    'a class is required — the model validator refuses an assignment row without one',
    run(schemas.create, { title: 'x' }).ok,
    false
  );
  check(
    'a title is required — likewise',
    run(schemas.create, { class_id: 1 }).ok,
    false
  );
  check('a due date is optional — FR-ASG-001 names no due date', run(schemas.create, ASG).ok, true);

  /* Widths read off models/other.js, not guessed. */
  const width = (field, n) => run(schemas.create, { ...ASG, [field]: 'x'.repeat(n) }).ok;
  check('title is bounded at its STRING(180)', [width('title', 180), width('title', 181)], [true, false]);
  check('description at 5000', [width('description', 5000), width('description', 5001)], [true, false]);

  /*
   * `.precision(2)` ROUNDS under `convert: true`; it does not reject. That is the settled doctrine
   * (`finance`, `plans`, and §19's identically-typed `markField`): `validate.js` reassigns the converted
   * body, so the value the service stores is the value the caller is answered with, and rejecting
   * `10.999` would fail a request over a difference `DECIMAL(7,2)` is about to erase anyway. Asserted on
   * the converted VALUE rather than on `.ok`, because asserting `.ok` here would pass either way.
   */
  check(
    'total_marks is rounded to the DECIMAL(7,2) scale, so the row and the response cannot disagree',
    [
      run(schemas.create, { ...ASG, total_marks: 10.5 }).value.total_marks,
      run(schemas.create, { ...ASG, total_marks: 10.999 }).value.total_marks,
      run(schemas.create, { ...ASG, total_marks: 7.257 }).value.total_marks,
    ],
    [10.5, 11, 7.26]
  );
  check(
    'and a negative total is refused outright, rounding being no answer to that',
    run(schemas.create, { ...ASG, total_marks: -1 }).ok,
    false
  );

  check(
    'creating starts the lifecycle at draft or published, never at closed',
    [
      run(schemas.create, { ...ASG, status: ASSIGNMENT_STATUS.DRAFT }).ok,
      run(schemas.create, { ...ASG, status: ASSIGNMENT_STATUS.PUBLISHED }).ok,
      run(schemas.create, { ...ASG, status: ASSIGNMENT_STATUS.CLOSED }).ok,
    ],
    [true, true, false]
  );
  check(
    'but an update may close one',
    run(schemas.update, { status: ASSIGNMENT_STATUS.CLOSED }).ok,
    true
  );
  check('an update must carry something', run(schemas.update, {}).ok, false);

  /*
   * The three discriminator columns are the important refusals: a body that could set them could mint a
   * submission for another student through the create route, which carries none of the submit checks.
   */
  for (const owned of [
    'record_type',
    'parent_assignment_id',
    'student_id',
    'attachment_path',
    'attachment_name',
    'created_by',
    'organization_id',
    'id',
    'submitted_at',
    'submission_status',
    'is_late',
    'marks_obtained',
    'feedback',
    'reviewed_by',
    'reviewed_at',
  ]) {
    const sample = owned === 'record_type' ? ASSIGNMENT_RECORD_TYPES.SUBMISSION
      : owned === 'submission_status' ? SUBMISSION_STATUS.REVIEWED
        : owned === 'is_late' ? true
          : /_(path|name)$/.test(owned) || owned === 'feedback' ? 'x'
            : 1;
    const r = run(schemas.create, { ...ASG, [owned]: sample });
    check(`create refuses a caller-supplied ${owned}`, [r.ok, r.keys], [false, [owned]]);
  }
  check(
    'and the update schema refuses the same set',
    [
      run(schemas.update, { title: 'x', record_type: ASSIGNMENT_RECORD_TYPES.SUBMISSION }).ok,
      run(schemas.update, { title: 'x', student_id: 1 }).ok,
      run(schemas.update, { title: 'x', attachment_path: '/etc/passwd' }).ok,
      run(schemas.update, { title: 'x', marks_obtained: 5 }).ok,
    ],
    [false, false, false, false]
  );

  /* ── step two: submit ── */

  check('a submission with nothing but the act validates', run(schemas.submit, {}).ok, true);
  check(
    '  and so does one with text — §20.3 names no fields for a submission, so neither is required',
    run(schemas.submit, { submission_text: 'My answer' }).ok,
    true
  );
  check(
    'submission_text is bounded',
    [
      run(schemas.submit, { submission_text: 'x'.repeat(20000) }).ok,
      run(schemas.submit, { submission_text: 'x'.repeat(20001) }).ok,
    ],
    [true, false]
  );
  for (const notMine of ['title', 'class_id', 'due_date', 'total_marks', 'status']) {
    const r = run(schemas.submit, { [notMine]: notMine === 'title' || notMine === 'status' ? 'x' : 1 });
    check(`submit refuses ${notMine} — it belongs to the assignment, and would be silently ignored`, r.ok, false);
  }
  check(
    'submit refuses a caller-named student — the submitter comes from the token',
    run(schemas.submit, { student_id: 7 }).ok,
    false
  );
  check(
    'and refuses a caller-supplied attachment path',
    run(schemas.submit, { attachment_path: '../../etc/passwd' }).ok,
    false
  );

  /* ── step three: review ── */

  /*
   * The first version of this schema spread the shared `owned` map last, which silently overwrote
   * `marks_obtained` and `feedback` with their `forbidden()` versions and made the review route reject
   * every review. These two assertions are what found it, so they check the fields the route exists to
   * write, not merely that some review validates.
   */
  check('a review carrying a mark validates', run(schemas.review, { marks_obtained: 8 }).ok, true);
  check('  and one carrying feedback', run(schemas.review, { feedback: 'Well argued' }).ok, true);
  check('  the two fields this route exists to write are not forbidden by the shared owned map',
    run(schemas.review, { marks_obtained: 8, feedback: 'Well argued' }).keys, []);
  check('a review must carry something', run(schemas.review, {}).ok, false);
  check(
    'the outcome is one of the two the enum offers for a reviewed submission',
    [
      run(schemas.review, { outcome: SUBMISSION_STATUS.REVIEWED }).ok,
      run(schemas.review, { outcome: SUBMISSION_STATUS.RETURNED }).ok,
      run(schemas.review, { outcome: SUBMISSION_STATUS.SUBMITTED }).ok,
    ],
    [true, true, false]
  );
  check(
    'the mark is rounded to the same DECIMAL(7,2) scale as the total it is compared against',
    [
      run(schemas.review, { marks_obtained: 7.25 }).value.marks_obtained,
      run(schemas.review, { marks_obtained: 7.257 }).value.marks_obtained,
    ],
    [7.25, 7.26]
  );
  check('a negative mark is refused', run(schemas.review, { marks_obtained: -1 }).ok, false);
  check(
    'a review may not stamp its own reviewer or moment',
    [
      run(schemas.review, { marks_obtained: 5, reviewed_by: 1 }).ok,
      run(schemas.review, { marks_obtained: 5, reviewed_at: '2026-01-01' }).ok,
    ],
    [false, false]
  );

  /* ── the two lists ── */

  check(
    'a transposed due window is refused rather than answered with an empty list',
    [
      run(schemas.list, { due_from: '2026-01-01', due_to: '2026-02-01' }).ok,
      run(schemas.list, { due_from: '2026-02-01', due_to: '2026-01-01' }).ok,
    ],
    [true, false]
  );
  check(
    'the assignment list filters by the assignment lifecycle',
    [
      run(schemas.list, { status: ASSIGNMENT_STATUS.PUBLISHED }).ok,
      run(schemas.list, { status: SUBMISSION_STATUS.SUBMITTED }).ok,
    ],
    [true, false]
  );
  check(
    'and the submission list by the submission lifecycle',
    [
      run(schemas.listSubmissions, { submission_status: SUBMISSION_STATUS.SUBMITTED }).ok,
      run(schemas.listSubmissions, { submission_status: ASSIGNMENT_STATUS.PUBLISHED }).ok,
    ],
    [true, false]
  );
  check('the submission list can single out the late ones', run(schemas.listSubmissions, { is_late: true }).ok, true);
}

/* ═══════════════════════ part 2 — the declared route table ═══════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — the router as declared ──\n');

  /*
   * Declaration order is asserted, not just membership. `GET /:id` above `GET /submissions` would
   * swallow the literal path and hand "submissions" to `idParam`, which answers 422 for a route that
   * exists — a break that no functional test of `/submissions` would explain.
   */
  check('the nine routes, in the order they are declared', routesOf(assignmentRoutes), [
    'GET /submissions',
    'GET /submissions/:id/attachment',
    'GET /submissions/:id',
    'PATCH /submissions/:id/review',
    'GET /',
    'POST /',
    'GET /:id',
    'PATCH /:id',
    'POST /:id/submissions',
  ]);
  check(
    'every literal /submissions path is declared before the /:id that would swallow it',
    routesOf(assignmentRoutes).findIndex((r) => r === 'GET /:id') >
      routesOf(assignmentRoutes).findIndex((r) => r === 'GET /submissions'),
    true
  );

  check(
    'one router-level guard, mounted ahead of every route',
    [
      assignmentRoutes.stack.filter((l) => !l.route).length,
      assignmentRoutes.stack.findIndex((l) => !l.route),
    ],
    [1, 0]
  );

  check('every write carries validate()', [
    handlerNames(assignmentRoutes, 'post', '/').includes('validateRequest'),
    handlerNames(assignmentRoutes, 'patch', '/:id').includes('validateRequest'),
    handlerNames(assignmentRoutes, 'post', '/:id/submissions').includes('validateRequest'),
    handlerNames(assignmentRoutes, 'patch', '/submissions/:id/review').includes('validateRequest'),
  ], [true, true, true, true]);
  check('and every write declares its activity', [
    handlerNames(assignmentRoutes, 'post', '/').includes('activityDeclaration'),
    handlerNames(assignmentRoutes, 'patch', '/:id').includes('activityDeclaration'),
    handlerNames(assignmentRoutes, 'post', '/:id/submissions').includes('activityDeclaration'),
    handlerNames(assignmentRoutes, 'patch', '/submissions/:id/review').includes('activityDeclaration'),
  ], [true, true, true, true]);

  /* ── the three permissions, one per step of FR-ASG-001 ── */

  const src = routerSource('assignments');
  for (const key of ['assignments.view', 'assignments.manage', 'assignments.submit', 'assignments.review']) {
    check(`the router uses ${key}`, src.includes(`requirePermission('${key}')`), true);
  }
  check(
    'the submit route is the only one guarded by assignments.submit',
    (src.match(/requirePermission\('assignments\.submit'\)/g) || []).length,
    1
  );
  check(
    'and the review route the only one guarded by assignments.review',
    (src.match(/requirePermission\('assignments\.review'\)/g) || []).length,
    1
  );

  /* The catalogue is fixed by §29/§35, so these are assertions about it, not about this module. */
  const grants = (role) => (DEFAULT_ROLE_PERMISSIONS[role] || []).filter((k) => k.startsWith('assignments.')).sort();
  check('FR-ASG-001 names a Student as an actor, and the catalogue lets one submit',
    grants(ROLES.STUDENT), ['assignments.submit', 'assignments.view']);
  check('a Teacher creates and reviews but cannot submit',
    grants(ROLES.TEACHER), ['assignments.manage', 'assignments.review', 'assignments.view']);
  check('a Parent may only look on', grants(ROLES.PARENT), ['assignments.view']);
  check('and an Organization Admin holds no assignment key at all — as with §20.2',
    grants(ROLES.ORGANIZATION_ADMIN), []);

  /* ── limits ── */

  check('no route carries an entitlement limit', mountsLimit('assignments'), false);
  check('  and the probe would find one — the students router does mount a limit', mountsLimit('students'), true);
  check('and §11.2 defines no assignment limit to carry',
    Object.values(LIMITS).some((k) => k.includes('assignment')), false);

  /* ── the upload, which belongs to the submit and to nothing else ── */

  check('the upload profile used is the one §20.3 reserved', UPLOAD_PROFILES.SUBMISSION, 'submission');
  check('  and the router names it rather than a seventh', /UPLOAD_PROFILES\.SUBMISSION/.test(src), true);
  check('  citing FR-ASG-001 by name in its own rules table',
    require('../src/config/constants').UPLOAD_RULES[UPLOAD_PROFILES.SUBMISSION].srs.includes('FR-ASG-001'), true);
  check(
    'the multer chain runs before validate, so the multipart text fields are visible to it',
    (() => {
      const names = handlerNames(assignmentRoutes, 'post', '/:id/submissions');
      return names.indexOf('multerRunner') > -1 && names.indexOf('multerRunner') < names.indexOf('validateRequest');
    })(),
    true
  );
  check(
    'and no other route mounts an upload — FR-ASG-001 names a file only for the student Submit',
    (src.match(/uploadSingle\(/g) || []).length,
    1
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
  const uploaded = [];
  const baseline = {
    activityLog: (await db.ActivityLog.max('id')) || 0,
    auditLog: (await db.AuditLog.max('id')) || 0,
  };

  async function call(pathname, { method = 'GET', body, token, form } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (form) {
      payload = form; /* fetch sets the multipart boundary itself */
    } else if (body !== undefined) {
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
  const idsOf = (res) => (dataOf(res) || []).map((r) => r.id).sort((a, b) => a - b);

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
      /* Submissions first: they carry the self-FK back to the assignment they answer. */
      await db.Assignment.destroy({
        where: { school_id: created.schools, record_type: ASSIGNMENT_RECORD_TYPES.SUBMISSION },
      });
      await db.Assignment.destroy({ where: { school_id: created.schools } });
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
    /*
     * Users and plans are cleared by their fixture *marker* rather than only by the ids this run
     * collected. A crash before the id is pushed — or one that kills the process mid-teardown, which is
     * what piping this script into `head` does — would otherwise leave a row whose unique code makes
     * every later run fail at fixture setup with a duplicate that has nothing to do with the code under
     * test. The organization delete has always worked this way; the other two now match it.
     */
    await db.User.destroy({ where: { email: { [db.Op.like]: `%@${DOMAIN}` } }, force: true });
    const planWhere = {
      [db.Op.or]: [
        { code: { [db.Op.like]: `${CODE_PREFIX}%` } },
        ...(created.plans.length ? [{ id: created.plans }] : []),
      ],
    };
    const stalePlans = (await db.SubscriptionPlan.findAll({ where: planWhere, attributes: ['id'] })).map((p) => p.id);
    if (stalePlans.length) {
      await db.PlanModule.destroy({ where: { plan_id: stalePlans } });
      await db.PlanLimit.destroy({ where: { plan_id: stalePlans } });
      await db.SubscriptionPlan.destroy({ where: { id: stalePlans }, force: true });
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
    for (const slug of [
      ROLES.SUPER_ADMIN,
      ROLES.PRINCIPAL,
      ROLES.TEACHER,
      ROLES.STUDENT,
      ROLES.PARENT,
      ROLES.ORGANIZATION_ADMIN,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const role = await db.Role.findOne({ where: { slug } });
      if (!role) throw new Error(`seeded role missing: ${slug}`);
      roles[slug] = role;
    }

    /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
    const residueCleared = await sweepResidue(db, { codes: ['VAS-'], domains: ['verify-assignments.local'], uploadsDir: config.uploads.dir });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({ name: 'Verify Assignments Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Assignments A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Assignments B');
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify Assignments C');
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Assignments D');

    const mkPlan = async (code, assignmentsEnabled) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify Assignments ${code}`, code: `${CODE_PREFIX}${code}`, status: PLAN_STATUS.ACTIVE,
        tier_rank: 1, trial_days: 0, grace_period_days: 7,
      });
      created.plans.push(plan.id);
      for (const key of MODULE_LIST) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanModule.create({
          plan_id: plan.id,
          module_key: key,
          is_enabled: key === MODULES.ASSIGNMENTS ? assignmentsEnabled : true,
        });
      }
      for (const k of [LIMITS.STUDENT_LIMIT, LIMITS.TEACHER_LIMIT, LIMITS.FILE_UPLOAD_LIMIT, LIMITS.STORAGE_LIMIT]) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanLimit.create({ plan_id: plan.id, limit_key: k, limit_type: LIMIT_TYPES.FIXED, limit_value: 100 });
      }
      return plan;
    };
    const withAssignments = await mkPlan('WITH', true);
    const withoutAssignments = await mkPlan('WITHOUT', false);

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
    await subscribe(schoolA, withAssignments);
    await subscribe(schoolB, withoutAssignments);
    await subscribe(schoolD, withAssignments);
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
      const section = await db.Section.create({
        school_id: school.id, organization_id: org.id, class_id: klass.id, name: 'A',
      });
      const otherSection = await db.Section.create({
        school_id: school.id, organization_id: org.id, class_id: klass.id, name: 'B',
      });
      const subject = await db.Subject.create({
        school_id: school.id, organization_id: org.id, name: `${tag} Maths`, code: `${CODE_PREFIX}${tag}M`,
      });
      /* On Grade 1's curriculum only — D30 lets an assignment name a subject the class is taught. */
      await db.ClassSubject.create({ school_id: school.id, class_id: klass.id, subject_id: subject.id });
      return { session, klass, other, section, otherSection, subject };
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
        role_id: roles[slug].id, organization_id, school_id, name: `Verify ASG ${key}`,
        email: `${key}@${DOMAIN}`, username: `vas_${key.replace(/-/g, '_')}`,
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
    /* Super Admin holds `assignments.submit` by the catalogue's construction and has no student row. */
    await mkUser('super', ROLES.SUPER_ADMIN, null, null);
    const aminaUser = await mkUser('student-amina', ROLES.STUDENT, org.id, schoolA.id);
    const carimUser = await mkUser('student-carim', ROLES.STUDENT, org.id, schoolA.id);
    const bilalUser = await mkUser('student-bilal', ROLES.STUDENT, org.id, schoolA.id);
    const parentUser = await mkUser('parent', ROLES.PARENT, org.id, schoolA.id);

    const mkStudent = async (key, first, klass, section, user) =>
      db.Student.create({
        school_id: schoolA.id, organization_id: org.id, student_id: `${CODE_PREFIX}${key}`, first_name: first,
        admission_date: '2025-04-01', status: STUDENT_STATUS.ACTIVE,
        class_id: klass.id, section_id: section ? section.id : null,
        academic_session_id: A.session.id, user_id: user ? user.id : null,
      });

    /*
     * Amina and Carim are in the SAME class and section — that is the point. A narrowing written by
     * class instead of by student would show each of them the other's answer, and every §20.2-shaped
     * assertion would still pass. Bilal is in Grade 2 and is the parent's child.
     */
    const amina = await mkStudent('S1', 'Amina', A.klass, A.section, aminaUser);
    const carim = await mkStudent('S2', 'Carim', A.klass, A.section, carimUser);
    const bilal = await mkStudent('S3', 'Bilal', A.other, null, bilalUser);

    const parent = await db.Parent.create({
      school_id: schoolA.id, organization_id: org.id, user_id: parentUser.id,
      name: 'Yusuf Parent', first_name: 'Yusuf', last_name: 'Parent', is_active: true,
    });
    /* The parent's child is in Grade 2, so the parent and the two students see DIFFERENT classes. */
    await db.ParentStudent.create({
      school_id: schoolA.id, parent_id: parent.id, student_id: bilal.id, relation: 'father',
    });

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
    const superAdmin = await signIn(`super@${DOMAIN}`);
    const aminaToken = await signIn(`student-amina@${DOMAIN}`);
    const carimToken = await signIn(`student-carim@${DOMAIN}`);
    const bilalToken = await signIn(`student-bilal@${DOMAIN}`);
    const parentToken = await signIn(`parent@${DOMAIN}`);

    /* ── the entitlement guard ── */

    const moduleDenied = await call('/assignments', { token: principalB });
    check('a plan without the Assignments module refuses', moduleDenied.status, 403);
    check('and names the module', codeOf(moduleDenied), 'MODULE_NOT_SUBSCRIBED');
    check('naming which one', moduleDenied.body.error.details.missing, [MODULES.ASSIGNMENTS]);
    const noSub = await call('/assignments', { token: principalC });
    check('a school with no subscription is refused differently', noSub.status, 402);
    check('state is checked before module', codeOf(noSub), 'SUBSCRIPTION_INACTIVE');

    /* ── FR-ASG-001, step one — the Teacher creates ── */

    const mk = async (body, token = teacher) =>
      dataOf(await expectOk('/assignments', { method: 'POST', token, body }, 201)).assignment;

    const draft = await mk({
      class_id: A.klass.id, section_id: A.section.id, subject_id: A.subject.id, teacher_id: teacherA.id,
      title: 'Essay on the water cycle', description: 'Two pages',
      assigned_date: '2030-09-15', due_date: '2030-09-20', total_marks: 10,
    });
    check('a Teacher creates an assignment — FR-ASG-001 names them as the actor', Boolean(draft.id), true);
    check('the row is an assignment, not a submission', draft.record_type, ASSIGNMENT_RECORD_TYPES.ASSIGNMENT);
    check('the school is taken from the caller, never the body', draft.school_id, schoolA.id);
    check('and so is the organization', draft.organization_id, org.id);
    check('the creator is stamped on the row', Boolean(draft.created_by), true);
    check('both dates are stored as plain dates', [draft.assigned_date, draft.due_date], ['2030-09-15', '2030-09-20']);
    check('total_marks crosses the wire as a number', draft.total_marks, 10);
    check('with no file, the row says so', draft.has_attachment, false);
    check(
      'the lifecycle starts at draft, never at the column default of null',
      draft.status,
      ASSIGNMENT_STATUS.DRAFT
    );
    check('and it carries neither of the submission discriminators', [draft.parent_assignment_id, draft.student_id], [null, null]);

    const noDate = await mk({ class_id: A.klass.id, title: 'No assigned date' });
    check('an omitted assigned_date defaults to today rather than to null', Boolean(noDate.assigned_date), true);
    /*
     * A `create()` response omits a nullable column the insert never named — the Sequelize instance
     * simply has no key for it. Read back, the row shows the null it actually holds.
     */
    check('  and an assignment need not have a due date at all', 'due_date' in noDate, false);
    check(
      '  which is a null on the stored row, not a missing column',
      dataOf(await expectOk(`/assignments/${noDate.id}`, { token: teacher }, 200)).assignment.due_date,
      null
    );

    /*
     * Several assignment rows now exist with `parent_assignment_id` and `student_id` both NULL. The
     * unique index tolerates them precisely because MySQL treats NULL as distinct — the permissiveness
     * that was a defect in the other three tables carrying this index shape is what makes the
     * single-table design work here.
     */
    check('many assignment rows coexist under the (parent_assignment_id, student_id) index', draft.id !== noDate.id, true);

    /* ── what a create may not do ── */

    const bodyPath = await call('/assignments', {
      method: 'POST', token: teacher, body: { ...ASG, class_id: A.klass.id, attachment_path: '/etc/passwd' },
    });
    check('a body-supplied attachment_path is refused, not stripped', bodyPath.status, 422);

    const asSubmission = await call('/assignments', {
      method: 'POST', token: teacher,
      body: { class_id: A.klass.id, title: 'x', record_type: ASSIGNMENT_RECORD_TYPES.SUBMISSION, student_id: amina.id },
    });
    check('a create cannot mint a submission by naming record_type', asSubmission.status, 422);

    const backwards = await call('/assignments', {
      method: 'POST', token: teacher,
      body: { class_id: A.klass.id, title: 'Backwards', assigned_date: '2030-09-20', due_date: '2030-09-15' },
    });
    check('a due date before the assigned date is refused', backwards.status, 422);
    check('  naming the field', backwards.body.error.details[0].field, 'due_date');

    const foreignClass = await call('/assignments', {
      method: 'POST', token: teacher, body: { class_id: D.klass.id, title: 'x' },
    });
    check("an assignment cannot be set for another school's class", foreignClass.status, 422);
    const foreignSubject = await call('/assignments', {
      method: 'POST', token: teacher, body: { class_id: A.klass.id, subject_id: D.subject.id, title: 'x' },
    });
    check("nor name another school's subject", foreignSubject.status, 422);
    /* D30 — FR-ASG-001's "Class/subject assignment exists" (SRS:1108): the pair, not only the school. */
    const offCurriculum = await call('/assignments', {
      method: 'POST', token: teacher, body: { class_id: A.other.id, subject_id: A.subject.id, title: 'x' },
    });
    check("D30 — nor a subject of this school that the class is not taught, naming the field",
      [offCurriculum.status, ((offCurriculum.body.error || {}).details || []).map((d) => d.field)], [422, ['subject_id']]);
    const foreignTeacherAsg = await call('/assignments', {
      method: 'POST', token: teacher, body: { class_id: A.klass.id, teacher_id: foreignTeacher.id, title: 'x' },
    });
    check("nor another school's teacher", foreignTeacherAsg.status, 422);
    const foreignSection = await call('/assignments', {
      method: 'POST', token: teacher, body: { class_id: A.other.id, section_id: A.section.id, title: 'x' },
    });
    check('nor a section belonging to a different class in the same school', foreignSection.status, 422);

    const studentCreate = await call('/assignments', {
      method: 'POST', token: aminaToken, body: { class_id: A.klass.id, title: 'By a student' },
    });
    check('a Student cannot create an assignment', studentCreate.status, 403);
    check('  refused on the permission, not on the data', codeOf(studentCreate), 'INSUFFICIENT_PERMISSION');
    const parentCreate = await call('/assignments', {
      method: 'POST', token: parentToken, body: { class_id: A.klass.id, title: 'By a parent' },
    });
    check('nor can a Parent', parentCreate.status, 403);
    const orgAdminList = await call(`/assignments?school_id=${schoolA.id}`, { token: orgAdmin });
    check('an Organization Admin holds no assignment key, so cannot even list', orgAdminList.status, 403);
    check('  again on the permission', codeOf(orgAdminList), 'INSUFFICIENT_PERMISSION');

    /* ── FR-ASG-001, step two — the Student submits ── */

    const tooEarly = await call(`/assignments/${draft.id}/submissions`, {
      method: 'POST', token: aminaToken, body: { submission_text: 'Answer' },
    });
    check('a draft assignment does not accept submissions', tooEarly.status, 409);
    check('  saying which status refused it', codeOf(tooEarly), 'ASSIGNMENT_NOT_OPEN');

    const published = dataOf(
      await expectOk(`/assignments/${draft.id}`, {
        method: 'PATCH', token: teacher, body: { status: ASSIGNMENT_STATUS.PUBLISHED },
      }, 200)
    ).assignment;
    check('publishing moves the lifecycle on', published.status, ASSIGNMENT_STATUS.PUBLISHED);

    /* Real multipart bytes, as §20.2 established. */
    const form = new FormData();
    form.set('submission_text', 'The water cycle has four stages.');
    form.set(
      'attachment',
      new Blob([Buffer.from('%PDF-1.4\nverify-assignments\n')], { type: 'application/pdf' }),
      'water-cycle.pdf'
    );
    const submitted = dataOf(
      await expectOk(`/assignments/${draft.id}/submissions`, { method: 'POST', token: aminaToken, form }, 201)
    ).submission;

    check('a Student submits — FR-ASG-001 names them as the second actor', Boolean(submitted.id), true);
    check('the row is a submission', submitted.record_type, ASSIGNMENT_RECORD_TYPES.SUBMISSION);
    check('pointing at the assignment it answers', submitted.parent_assignment_id, draft.id);
    check('and at the student who wrote it, taken from the token', submitted.student_id, amina.id);
    check('the lifecycle starts at submitted', submitted.submission_status, SUBMISSION_STATUS.SUBMITTED);
    check('the moment is stamped', Boolean(submitted.submitted_at), true);
    check('a submission before the due date is not late', submitted.is_late, false);
    check('the text is kept', submitted.submission_text, 'The water cycle has four stages.');
    check('the file came with it', submitted.has_attachment, true);
    check('  under the name the student gave it', submitted.attachment_name, 'water-cycle.pdf');
    check('  and the stored path never reaches the caller', 'attachment_path' in submitted, false);
    check('nothing is reviewed yet', [submitted.marks_obtained, submitted.reviewed_by], [null, null]);
    check('the class is copied so the row can be scoped without a join', submitted.class_id, A.klass.id);

    const storedRow = await db.Assignment.findByPk(submitted.id);
    check('the path really is stored on the row', Boolean(storedRow.attachment_path), true);
    check(
      '  and tenant-scoped under the school and the profile',
      new RegExp(`^school-${schoolA.id}/submission/`).test(storedRow.attachment_path),
      true
    );
    const abs = path.join(config.uploads.dir, storedRow.attachment_path);
    uploaded.push(abs);
    check('  and the bytes are really on disk', fs.existsSync(abs), true);

    const twice = await call(`/assignments/${draft.id}/submissions`, {
      method: 'POST', token: aminaToken, body: { submission_text: 'Again' },
    });
    check('a second submission by the same student is refused', twice.status, 409);
    check('  by the rule the unique index exists for', codeOf(twice), 'SUBMISSION_ALREADY_EXISTS');

    const teacherSubmit = await call(`/assignments/${draft.id}/submissions`, {
      method: 'POST', token: teacher, body: { submission_text: 'By the teacher' },
    });
    check('a Teacher cannot submit — they create and review', teacherSubmit.status, 403);
    check('  on the permission', codeOf(teacherSubmit), 'INSUFFICIENT_PERMISSION');

    const superSubmit = await call(`/assignments/${draft.id}/submissions`, {
      method: 'POST', token: superAdmin, body: { submission_text: 'By the platform' },
    });
    check('a Super Admin holds assignments.submit but has no student row, so is refused', superSubmit.status, 403);
    check('  on the profile, not on the permission', codeOf(superSubmit), 'NOT_A_STUDENT');

    const wrongClass = await call(`/assignments/${draft.id}/submissions`, {
      method: 'POST', token: bilalToken, body: { submission_text: 'From Grade 2' },
    });
    check('a student of another class cannot submit', wrongClass.status, 403);
    check('  saying so', codeOf(wrongClass), 'ASSIGNMENT_NOT_FOR_STUDENT');

    /* Carim is in the same class AND the same section, so this one must succeed. */
    const carimSubmission = dataOf(
      await expectOk(`/assignments/${draft.id}/submissions`, {
        method: 'POST', token: carimToken, body: { submission_text: 'Carim answer' },
      }, 201)
    ).submission;
    check('a classmate submits their own answer to the same assignment', carimSubmission.student_id, carim.id);
    check('  which the unique index permits, being a different student', carimSubmission.id !== submitted.id, true);

    /* A sectioned assignment reaches one section, not the whole class. */
    const sectioned = await mk({
      class_id: A.klass.id, section_id: A.otherSection.id, title: 'Section B only',
      status: ASSIGNMENT_STATUS.PUBLISHED,
    });
    const wrongSection = await call(`/assignments/${sectioned.id}/submissions`, {
      method: 'POST', token: aminaToken, body: {},
    });
    check('a sectioned assignment refuses a student of another section', wrongSection.status, 403);
    /*
     * And it is not shown to them either. The list and the read by id narrowed by class alone, so Amina
     * was shown section B's assignment and a Submit button, and then refused by the check above.
     */
    check('  and a student of another section is not shown it — not in their list, not by id',
      [dataOf(await expectOk('/assignments?limit=100', { token: aminaToken }, 200))
        .map((a) => a.id).includes(sectioned.id),
      (await call(`/assignments/${sectioned.id}`, { token: aminaToken })).status],
      [false, 404]);
    check('  while their own section\'s assignment still is',
      dataOf(await expectOk('/assignments?limit=100', { token: aminaToken }, 200)).map((a) => a.id).includes(draft.id),
      true);

    /* Late: assigned and due both in the past, which the ordering check still allows. */
    const overdue = await mk({
      class_id: A.other.id, title: 'Overdue', assigned_date: '2025-01-01', due_date: '2025-01-15',
      status: ASSIGNMENT_STATUS.PUBLISHED, total_marks: 20,
    });
    /*
     * The wrong-class check, on its own. The refusal above cannot prove it: Bilal carries no section
     * and `draft` has one, so the *section* guard would answer that request identically — same status,
     * same code — with the class check deleted. A deliberate regression showed exactly that. `overdue`
     * has no section, so here the class is the only guard that can refuse.
     */
    const wrongClassUnsectioned = await call(`/assignments/${overdue.id}/submissions`, {
      method: 'POST', token: aminaToken, body: {},
    });
    check('a student of another class is refused even when no section narrows the assignment',
      wrongClassUnsectioned.status, 403);
    check('  by the class check, the only guard left to do it', codeOf(wrongClassUnsectioned), 'ASSIGNMENT_NOT_FOR_STUDENT');

    const lateSubmission = dataOf(
      await expectOk(`/assignments/${overdue.id}/submissions`, {
        method: 'POST', token: bilalToken, body: { submission_text: 'Sorry it is late' },
      }, 201)
    ).submission;
    check('a submission after the due date is marked late', lateSubmission.is_late, true);

    /* ── FR-ASG-001, step three — the Teacher reviews ── */

    const overMax = await call(`/assignments/submissions/${submitted.id}/review`, {
      method: 'PATCH', token: teacher, body: { marks_obtained: 11 },
    });
    check('a mark above the assignment total is refused', overMax.status, 422);
    check('  naming the field', overMax.body.error.details[0].field, 'marks_obtained');

    const reviewed = dataOf(
      await expectOk(`/assignments/submissions/${submitted.id}/review`, {
        method: 'PATCH', token: teacher, body: { marks_obtained: 8.5, feedback: 'Well argued' },
      }, 200)
    ).submission;
    check('a Teacher reviews the submission — FR-ASG-001 step three', reviewed.submission_status, SUBMISSION_STATUS.REVIEWED);
    check('the mark is recorded', reviewed.marks_obtained, 8.5);
    check('with the feedback', reviewed.feedback, 'Well argued');
    check('the reviewer is stamped', Boolean(reviewed.reviewed_by), true);
    check('and the moment', Boolean(reviewed.reviewed_at), true);
    check('the lifecycle from creation to review is complete — §20.3\'s expected outcome',
      [published.status, submitted.submission_status, reviewed.submission_status],
      [ASSIGNMENT_STATUS.PUBLISHED, SUBMISSION_STATUS.SUBMITTED, SUBMISSION_STATUS.REVIEWED]);

    const studentReview = await call(`/assignments/submissions/${carimSubmission.id}/review`, {
      method: 'PATCH', token: aminaToken, body: { marks_obtained: 10 },
    });
    check('a Student cannot review — not even their own classmate', studentReview.status, 403);
    const parentReview = await call(`/assignments/submissions/${submitted.id}/review`, {
      method: 'PATCH', token: parentToken, body: { marks_obtained: 10 },
    });
    check('nor can a Parent', parentReview.status, 403);

    /* ── `returned` is what re-opens the submit route ── */

    const reviewedTwice = await call(`/assignments/${draft.id}/submissions`, {
      method: 'POST', token: aminaToken, body: { submission_text: 'Take two' },
    });
    check('a reviewed submission does not accept a replacement', reviewedTwice.status, 409);

    const returned = dataOf(
      await expectOk(`/assignments/submissions/${carimSubmission.id}/review`, {
        method: 'PATCH', token: teacher,
        body: { marks_obtained: 3, feedback: 'Try again', outcome: SUBMISSION_STATUS.RETURNED },
      }, 200)
    ).submission;
    check('a teacher may hand a submission back instead', returned.submission_status, SUBMISSION_STATUS.RETURNED);

    const resubmitRes = await expectOk(`/assignments/${draft.id}/submissions`, {
      method: 'POST', token: carimToken, body: { submission_text: 'Second attempt' },
    }, 200);
    const resubmitted = dataOf(resubmitRes).submission;
    check('a returned submission accepts a replacement — 200, because the index permits one row',
      resubmitRes.status, 200);
    check('  the same row, replaced in place', resubmitted.id, carimSubmission.id);
    check('  carrying the new answer', resubmitted.submission_text, 'Second attempt');
    check('  back at submitted', resubmitted.submission_status, SUBMISSION_STATUS.SUBMITTED);
    check(
      '  and the stale mark is cleared, because it was given for work nobody can read any more',
      [resubmitted.marks_obtained, resubmitted.feedback, resubmitted.reviewed_by, resubmitted.reviewed_at],
      [null, null, null, null]
    );

    /* ── the two lists must not leak into each other ── */

    const asgList = await expectOk(`/assignments?limit=100`, { token: teacher }, 200);
    check(
      'the assignment list contains only assignment rows',
      dataOf(asgList).every((r) => r.record_type === ASSIGNMENT_RECORD_TYPES.ASSIGNMENT),
      true
    );
    check(
      '  so no submission appears in it',
      idsOf(asgList).includes(submitted.id) || idsOf(asgList).includes(carimSubmission.id),
      false
    );
    const subList = await expectOk(`/assignments/submissions?limit=100`, { token: teacher }, 200);
    check(
      'the submission list contains only submission rows',
      dataOf(subList).every((r) => r.record_type === ASSIGNMENT_RECORD_TYPES.SUBMISSION),
      true
    );
    check('  and no assignment appears in it', idsOf(subList).includes(draft.id), false);
    check('  a teacher sees every student\'s submission',
      [idsOf(subList).includes(submitted.id), idsOf(subList).includes(carimSubmission.id)], [true, true]);
    /* The reviewer's list names the student — it carried the admission and roll numbers only. */
    const listedStudent = dataOf(subList).find((r) => r.id === submitted.id).student;
    check(
      '  and each row names its student, not only their numbers',
      [listedStudent.first_name, listedStudent.last_name],
      ['Amina', null]
    );

    /* ── self-scoping: the assignment half ── */

    const aminaAsg = await expectOk('/assignments?limit=100', { token: aminaToken }, 200);
    const aminaIds = idsOf(aminaAsg);
    check('a student sees their own class\'s published assignment', aminaIds.includes(draft.id), true);
    check('  but not another class\'s', aminaIds.includes(overdue.id), false);
    check('  and not a draft for their own class', aminaIds.includes(noDate.id), false);
    check(
      '  every row they do see is one of the two visible statuses',
      dataOf(aminaAsg).every((r) => [ASSIGNMENT_STATUS.PUBLISHED, ASSIGNMENT_STATUS.CLOSED].includes(r.status)),
      true
    );
    const aminaDrafts = await expectOk(`/assignments?status=${ASSIGNMENT_STATUS.DRAFT}&limit=100`, { token: aminaToken }, 200);
    check('asking for drafts answers nothing rather than the school\'s drafts', dataOf(aminaDrafts).length, 0);

    const parentAsg = await expectOk('/assignments?limit=100', { token: parentToken }, 200);
    const parentIds = idsOf(parentAsg);
    check('a parent sees their child\'s class', parentIds.includes(overdue.id), true);
    check('  and not the class their child is not in', parentIds.includes(draft.id), false);

    const teacherIds = idsOf(asgList);
    check('a teacher sees both classes, so the narrowing is the students\' and not the query\'s',
      [teacherIds.includes(draft.id), teacherIds.includes(overdue.id)], [true, true]);

    const foreignRead = await call(`/assignments/${overdue.id}`, { token: aminaToken });
    check('a student reading another class\'s assignment by id is refused', foreignRead.status, 404);
    const draftRead = await call(`/assignments/${noDate.id}`, { token: aminaToken });
    check('  and so is a draft for their own class — the narrowing is not list-only', draftRead.status, 404);
    check('  while the teacher reads both', (await call(`/assignments/${noDate.id}`, { token: teacher })).status, 200);

    /* ── self-scoping: the submission half, narrowed by student and not by class ── */

    const aminaSubs = await expectOk('/assignments/submissions?limit=100', { token: aminaToken }, 200);
    check('a student sees their own submission', idsOf(aminaSubs).includes(submitted.id), true);
    check(
      '  and NOT a classmate\'s, though they share a class and a section',
      idsOf(aminaSubs).includes(carimSubmission.id),
      false
    );
    check('  every row is theirs', dataOf(aminaSubs).every((r) => r.student_id === amina.id), true);

    const aminaAsksForCarim = await expectOk(
      `/assignments/submissions?student_id=${carim.id}&limit=100`, { token: aminaToken }, 200
    );
    check('naming a classmate in the filter intersects to nothing rather than overriding the narrowing',
      dataOf(aminaAsksForCarim).length, 0);

    const classmateById = await call(`/assignments/submissions/${carimSubmission.id}`, { token: aminaToken });
    check('and a classmate\'s submission cannot be read by guessing its id', classmateById.status, 404);
    check('  while their own can be', (await call(`/assignments/submissions/${submitted.id}`, { token: aminaToken })).status, 200);

    const parentSubs = await expectOk('/assignments/submissions?limit=100', { token: parentToken }, 200);
    check('a parent sees their child\'s submission', idsOf(parentSubs).includes(lateSubmission.id), true);
    check('  and not another family\'s', idsOf(parentSubs).includes(submitted.id), false);

    /* ── editing an assignment ── */

    const renamed = dataOf(
      await expectOk(`/assignments/${draft.id}`, {
        method: 'PATCH', token: teacher, body: { title: 'Essay on the water cycle (revised)', reason: 'Clarified the task' },
      }, 200)
    ).assignment;
    check('a teacher may edit an assignment', renamed.title, 'Essay on the water cycle (revised)');

    /*
     * `draft` is sectioned, so a bare class change is refused first by the §5a session-19 check: the
     * section it kept would point at the class it used to belong to. That refusal is asserted here on
     * its own, so the 409 below cannot pass by accident on the wrong guard.
     */
    const staleSection = await call(`/assignments/${draft.id}`, {
      method: 'PATCH', token: teacher, body: { class_id: A.other.id },
    });
    check('changing the class while keeping a section of the old one is refused', staleSection.status, 422);

    /*
     * The section and the subject both cleared, so the only guard left is the one under test: `draft`
     * names a subject Grade 2 is not taught, which D30 now refuses first — clearing it keeps this about
     * the submissions.
     */
    const moved = await call(`/assignments/${draft.id}`, {
      method: 'PATCH', token: teacher, body: { class_id: A.other.id, section_id: null, subject_id: null },
    });
    check('and even with the section cleared, an answered assignment does not move class', moved.status, 409);
    check('  saying why', codeOf(moved), 'ASSIGNMENT_HAS_SUBMISSIONS');
    const movedUnanswered = await call(`/assignments/${noDate.id}`, {
      method: 'PATCH', token: teacher, body: { class_id: A.other.id },
    });
    check('  while an unanswered one moves freely, so the guard is about the submissions', movedUnanswered.status, 200);

    /* A due date is optional on create, so clearing one on edit has to be accepted too. */
    const dated = await call(`/assignments/${noDate.id}`, {
      method: 'PATCH', token: teacher, body: { due_date: '2030-01-15' },
    });
    const undated = await call(`/assignments/${noDate.id}`, {
      method: 'PATCH', token: teacher, body: { due_date: null },
    });
    check(
      'a due date can be set and then cleared again on edit',
      [dated.status, undated.status, (await db.Assignment.findByPk(noDate.id)).due_date],
      [200, 200, null]
    );

    /*
     * A fresh unsectioned assignment for Carim's own class, so the close is the ONLY thing that can
     * refuse the submission. Reusing the sectioned one would have been answered by the section check
     * instead, and the assertion would have passed on a guard it was not written for.
     */
    const closable = await mk({
      class_id: A.klass.id, title: 'Will be closed', status: ASSIGNMENT_STATUS.PUBLISHED,
    });
    const closed = dataOf(
      await expectOk(`/assignments/${closable.id}`, {
        method: 'PATCH', token: teacher, body: { status: ASSIGNMENT_STATUS.CLOSED },
      }, 200)
    ).assignment;
    check('an assignment is withdrawn by closing it, there being no DELETE', closed.status, ASSIGNMENT_STATUS.CLOSED);
    const afterClose = await call(`/assignments/${closable.id}/submissions`, {
      method: 'POST', token: carimToken, body: {},
    });
    check('  and a closed assignment takes no more work', afterClose.status, 409);
    check('  for the same reason a draft does not', codeOf(afterClose), 'ASSIGNMENT_NOT_OPEN');

    /* ── tenant isolation ── */

    const crossRead = await call(`/assignments/${draft.id}`, { token: principalD });
    check('a principal of another school cannot read this assignment', crossRead.status, 404);
    const crossNamed = await call(`/assignments?school_id=${schoolD.id}`, { token: principalA });
    check('and naming another school is refused by the tenant chain', crossNamed.status, 403);
    check('  before the record is ever looked for', codeOf(crossNamed), 'CROSS_TENANT_ACCESS_DENIED');

    /* ── the upload allowlist ── */

    const badForm = new FormData();
    badForm.set('attachment', new Blob([Buffer.from('MZ ')], { type: 'application/x-msdownload' }), 'answer.exe');
    const badType = await call(`/assignments/${overdue.id}/submissions`, {
      method: 'POST', token: bilalToken, form: badForm,
    });
    check('a file type outside the profile allowlist is refused', badType.status, 415);

    /* ── the trail ── */

    const activity = await settle(() => db.ActivityLog.findAll({
      where: { id: { [db.Op.gt]: baseline.activityLog } }, order: [['id', 'ASC']],
    }), (rows) => rows.some((r) => r.entity_type === 'assignments'));
    const mine = activity.filter((r) => r.entity_type === 'assignments');
    check('every assignment write is in the activity trail', mine.length > 0, true);
    check(
      '  and none of them records the stored path',
      mine.every((r) => !JSON.stringify(r.metadata || {}).includes('school-')),
      true
    );

    const audits = await settleDistinct(() => db.AuditLog.findAll({
      where: { id: { [db.Op.gt]: baseline.auditLog }, table_name: 'assignments' },
    }), 'event', 2);
    check('assignments are audited per row', audits.length > 0, true);
    check('  a submission is audited as a create of its own row',
      audits.some((r) => r.event === 'create' && Number(r.record_id) === submitted.id), true);
    check('  a resubmission as an update of the row it replaced',
      audits.some((r) => r.event === 'update' && Number(r.record_id) === carimSubmission.id), true);
    const correction = audits.find((r) => r.event === 'update' && r.reason === 'Clarified the task');
    check('  and an edit carries the reason it was given', Boolean(correction), true);
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-assignments Part 3 teardown failed:', err);
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
    console.error('\nverify-assignments crashed:', err);
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
          ? 'All pure assignment checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All assignment checks passed (Parts 1–3).'
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
