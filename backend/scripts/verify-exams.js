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
 * Verification of Phase 3.N examinations & results — `src/modules/exams/*` — SRS §19,
 * FR-EXAM-001 … FR-EXAM-005.
 *
 * ## The fixture ledger, hand-computed
 *
 * Two papers: Maths (full 100, passing 40) and Science (theory full 70 passing 28, practical full 30
 * passing 12). Every student's denominator is therefore 100 + (70 + 30) = **200**. Bands on the
 * `default` scale: A 80–100 (4.0), B 60–79.999 (3.0), C 50–59.999 (2.0), F 0–49.999 (0, `is_failing`).
 *
 *   student  maths  science(th/pr)  obtained  percentage  band  failed  outcome  position
 *   Amina    90     60 / 25         175       87.500      A     0       pass     1
 *   Bilal    70     50 / 20         140       70.000      B     0       pass     2
 *   Dara     70     50 / 20         140       70.000      B     0       pass     2
 *   Elif     40     28 / 12          80       40.000      F     0       FAIL     4
 *   Chidi    30     absent           30       15.000      F     2       fail     5
 *
 * Four branches of the calculation that only a fixture like this reaches:
 *
 *  - **Bilal and Dara tie**, so they share position 2 and position 3 is skipped — which is what a merit
 *    list means, and what `position_out_of` has to be read beside.
 *  - **Elif scores exactly at every bar** (40 ≥ 40, 28 ≥ 28, 12 ≥ 12), so the comparisons must be
 *    inclusive, and she still **fails** — she passed every paper but landed in a band the school marked
 *    `is_failing`. That is the one case §19 leaves open, and it is asserted rather than assumed.
 *  - **Chidi is absent** for Science: the paper still counts 100 toward his denominator, contributes 0
 *    to his total, and counts as a failed subject.
 *  - Every figure is **hand-computed above**, never re-derived the way the implementation derives it.
 *
 * Carried in from the §15–§18 audits: rows exist outside school A so every scoping assertion has a
 * counter-example; an organization-scoped caller reaches the service (and exercises `childScope` on
 * `exam_subjects`, which has no `organization_id` at all); enums are asserted schema-against-**model**;
 * every `DATEONLY` column is round-tripped at a flipped `process.env.TZ`; and the entitlement-limit
 * check reads the router's source rather than a handler name that does not exist.
 *
 * Part 1 — request schemas and the pure calculation helpers (no database).
 * Part 2 — the declared route table and the router-level guard.
 * Part 3 — over real HTTP against the real database.
 *
 * Run: node scripts/verify-exams.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const { settleDistinct, quiesce } = require('./lib/settle');

const examRoutes = require('../src/modules/exams/exams.routes');
const { schemas } = require('../src/modules/exams/exams.validation');
const examsService = require('../src/modules/exams/exams.service');

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
  EXAM_STATUS,
  MARK_STATUS,
  RESULT_OUTCOME,
  STUDENT_STATUS,
  ACADEMIC_SESSION_STATUS,
} = require('../src/config/constants');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-exams.local';
const PASSWORD = 'Verify@Exams123';
const CODE_PREFIX = 'VEX-';

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

/**
 * Does this router actually MOUNT an entitlement limit, ignoring what its prose says about one?
 *
 * Comments are stripped first: the router explains in its header *why* it carries no `enforceLimit`,
 * so a bare substring search finds the explanation and reports the opposite of the truth. The
 * name-based check this replaced had the mirror problem — `enforceLimit()` returns a function called
 * `wrappedAsyncHandler`, never `limitGuard` (§5a session 18).
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

function named(router, method, path_, fnName) {
  const layer = router.stack.find((l) => l.route && l.route.path === path_ && l.route.methods[method]);
  return layer ? layer.route.stack.some((s) => s.handle.name === fnName) : null;
}

/** Valid bodies, so a rejection can only be about the field under test. */
const GRADE = { name: 'A', min_percentage: 80, max_percentage: 100 };
const EXAM = { name: 'Midterm', exam_type: 'Midterm', class_id: 1 };
const PAPER = { subject_id: 1, full_marks: 100, passing_marks: 40 };

/* ═══════════════════════ part 1 — schemas and the pure calculation ═══════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas and the calculation helpers ──\n');

  /* ── §19.1 the Grade System ── */

  check('a complete grade band validates', run(schemas.createGrade, GRADE).ok, true);
  check('a band needs a name', run(schemas.createGrade, { min_percentage: 80, max_percentage: 100 }).ok, false);
  check('and both ends', run(schemas.createGrade, { name: 'A', min_percentage: 80 }).ok, false);
  check('a band cannot exceed 100', run(schemas.createGrade, { ...GRADE, max_percentage: 101 }).ok, false);
  check('nor sit below 0', run(schemas.createGrade, { ...GRADE, min_percentage: -1 }).ok, false);
  check('a band is bounded at DECIMAL(6,3) — three decimals survive', run(schemas.createGrade, { ...GRADE, min_percentage: 79.999 }).value.min_percentage, 79.999);
  {
    const r = run(schemas.createGrade, { ...GRADE, is_system: true });
    check('a school may not mint a platform-owned band', r.ok, false);
    check('  and is_system is named as the reason', r.keys, ['is_system']);
  }

  /* ── §19.1 the examination ── */

  check('a complete exam validates', run(schemas.createExam, EXAM).ok, true);
  {
    /*
     * The service header says this column is refused in every schema. Until §5a session 19 that
     * sentence was false - no schema declared it, so it was silently stripped rather than refused.
     */
    const r = run(schemas.createExam, { ...EXAM, result_card_path: '/etc/passwd' });
    check('a caller-supplied result_card_path is refused, as the header claims', r.ok, false);
    check('  and it is named as the reason', r.keys, ['result_card_path']);
  }
  check('an exam needs a class — §19.1\'s precondition is that one exists', run(schemas.createExam, { name: 'x', exam_type: 'y' }).ok, false);
  check('and an exam type', run(schemas.createExam, { name: 'x', class_id: 1 }).ok, false);
  for (const owned of ['status', 'published_at', 'announced_at', 'created_by']) {
    const r = run(schemas.createExam, { ...EXAM, [owned]: owned === 'status' ? EXAM_STATUS.PUBLISHED : 1 });
    check(`an exam refuses a caller-supplied ${owned}`, r.ok, false);
    check(`  naming ${owned} as the reason`, r.keys, [owned]);
  }
  const examStatusColumn = db.Exam.rawAttributes.status.values;
  check('the exam status column carries the seven §19 lifecycle values', examStatusColumn.length, 7);
  check(
    'and the list filter accepts every one of them',
    examStatusColumn.every((v) => run(schemas.listExams, { status: v }).ok),
    true
  );
  check('an invented status is refused', run(schemas.listExams, { status: 'marked' }).ok, false);

  /* ── §19.1 Subjects, Marks, Passing Marks ── */

  check('a complete paper validates', run(schemas.addExamSubject, PAPER).ok, true);
  check('a paper out of zero marks is not a paper', run(schemas.addExamSubject, { ...PAPER, full_marks: 0 }).ok, false);
  check('a paper needs passing marks — §19.1 names them', run(schemas.addExamSubject, { subject_id: 1, full_marks: 100 }).ok, false);
  check('a mark is bounded at its DECIMAL(7,2) scale', run(schemas.addExamSubject, { ...PAPER, full_marks: 100.999 }).value.full_marks, 101);
  {
    /*
     * The decision this assertion exists for. `weightage` is a real column with a real default, and
     * §19 never mentions weighting — so it is refused rather than silently stripped, because a stripped
     * key answers 200 having changed nothing.
     */
    const r = run(schemas.addExamSubject, { ...PAPER, weightage: 2 });
    check('weightage is refused on create — §19 describes no weighted aggregation', r.ok, false);
    check('  naming weightage as the reason', r.keys, ['weightage']);
    const u = run(schemas.updateExamSubject, { weightage: 2 });
    check('and refused on update too, so the column can only ever hold its default', u.ok, false);
  }
  check(
    'a paper cannot be moved to another subject — that would orphan every mark on it',
    run(schemas.updateExamSubject, { subject_id: 2 }).ok,
    false
  );
  check('a time is HH:MM or HH:MM:SS', [
    run(schemas.addExamSubject, { ...PAPER, start_time: '09:30' }).ok,
    run(schemas.addExamSubject, { ...PAPER, start_time: '09:30:00' }).ok,
    run(schemas.addExamSubject, { ...PAPER, start_time: '9:30' }).ok,
    run(schemas.addExamSubject, { ...PAPER, start_time: '24:00' }).ok,
  ], [true, true, false, false]);

  /* ── §19.2 Marks ── */

  const ENTRY = { exam_subject_id: 1, entries: [{ student_id: 1, marks_obtained: 50 }] };
  check('a marks batch validates', run(schemas.enterMarks, ENTRY).ok, true);
  check('a batch needs at least one entry', run(schemas.enterMarks, { exam_subject_id: 1, entries: [] }).ok, false);
  check('and is bounded at 500', run(schemas.enterMarks, {
    exam_subject_id: 1,
    entries: Array.from({ length: 501 }, (_, i) => ({ student_id: i + 1, marks_obtained: 1 })),
  }).ok, false);
  for (const derived of ['grade_name', 'outcome', 'status']) {
    const r = run(schemas.enterMarks, {
      exam_subject_id: 1,
      entries: [{ student_id: 1, marks_obtained: 50, [derived]: 'x' }],
    });
    check(`a caller-supplied ${derived} is refused — it is derived from the marks`, r.ok, false);
  }
  const markStatusColumn = db.Mark.rawAttributes.status.values;
  check('the mark status column is exactly draft and submitted', markStatusColumn, ['draft', 'submitted']);
  check(
    'and the list filter accepts both',
    markStatusColumn.every((v) => run(schemas.listMarks, { status: v }).ok),
    true
  );

  /* ── the pure calculation ── */

  check('round3 keeps three decimals', [examsService.round3(87.4999), examsService.round3(1 / 3)], [87.5, 0.333]);

  const bands = [
    { name: 'A', min_percentage: 80, max_percentage: 100, grade_point: 4, is_failing: false },
    { name: 'B', min_percentage: 60, max_percentage: 79.999, grade_point: 3, is_failing: false },
    { name: 'C', min_percentage: 50, max_percentage: 59.999, grade_point: 2, is_failing: false },
    { name: 'F', min_percentage: 0, max_percentage: 49.999, grade_point: 0, is_failing: true },
  ];
  check('a percentage matches its band', examsService.matchBand(bands, 87.5).name, 'A');
  check('a band is inclusive at its floor', examsService.matchBand(bands, 80).name, 'A');
  check('and at its ceiling — 100 must land somewhere', examsService.matchBand(bands, 100).name, 'A');
  check('the band below is inclusive too', examsService.matchBand(bands, 79.999).name, 'B');
  check('zero lands in the bottom band', examsService.matchBand(bands, 0).name, 'F');
  check(
    'a percentage in no band returns null rather than guessing',
    examsService.matchBand([{ name: 'A', min_percentage: 90, max_percentage: 100 }], 50),
    null
  );

  const maths = { passing_marks: 40, practical_passing_marks: null };
  const science = { passing_marks: 28, practical_passing_marks: 12 };
  check('a mark at the bar passes — the comparison is inclusive', examsService.subjectOutcome(maths, { marks_obtained: 40 }), RESULT_OUTCOME.PASS);
  check('one below it fails', examsService.subjectOutcome(maths, { marks_obtained: 39.99 }), RESULT_OUTCOME.FAIL);
  check('an absent student fails the paper', examsService.subjectOutcome(maths, { is_absent: true }), RESULT_OUTCOME.FAIL);
  check(
    'a practical bar is a second, independent gate — theory alone cannot carry it',
    examsService.subjectOutcome(science, { marks_obtained: 70, practical_marks_obtained: 11 }),
    RESULT_OUTCOME.FAIL
  );
  check(
    'and both bars exactly met is a pass',
    examsService.subjectOutcome(science, { marks_obtained: 28, practical_marks_obtained: 12 }),
    RESULT_OUTCOME.PASS
  );
  check(
    'a paper with no practical bar ignores the practical mark',
    examsService.subjectOutcome(maths, { marks_obtained: 50, practical_marks_obtained: 0 }),
    RESULT_OUTCOME.PASS
  );

  const ranked = examsService.rankResults([
    { id: 1, percentage: 87.5 },
    { id: 2, percentage: 70 },
    { id: 3, percentage: 70 },
    { id: 4, percentage: 40 },
    { id: 5, percentage: 15 },
  ]);
  check(
    'a tie shares a position and the next one skips — 1, 2, 2, 4, 5',
    ranked.map((r) => [r.row.id, r.position]),
    [[1, 1], [2, 2], [3, 2], [4, 4], [5, 5]]
  );
  check('and every row is ranked out of the same cohort size', [...new Set(ranked.map((r) => r.outOf))], [5]);
  check(
    'ties are detected in integer thousandths, so two cards printing the same percentage share a place',
    examsService.rankResults([{ id: 1, percentage: 87.5001 }, { id: 2, percentage: 87.5004 }]).map((r) => r.position),
    [1, 1]
  );
}

/* ═══════════════════════════ part 2 — the route table ═══════════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — declared routes ──\n');

  const routes = routesOf(examRoutes);
  check('the nineteen §19 routes are declared, literals before the :id family', routes, [
    'GET /grade-scales',
    'POST /grade-scales',
    'PATCH /grade-scales/:id',
    'GET /my-results',
    'GET /marks',
    'POST /marks',
    'POST /marks/submit',
    'GET /results',
    'GET /results/:id',
    'GET /',
    'POST /',
    'GET /:id',
    'PATCH /:id',
    'GET /:id/subjects',
    'POST /:id/subjects',
    'PATCH /:id/subjects/:examSubjectId',
    'GET /:id/results',
    'POST /:id/results',
    'POST /:id/publish',
  ]);

  /*
   * Load-bearing, not cosmetic: `/marks` and `/:id` both match the path `/marks`, and Express takes
   * the first declared. If `GET /:id` were declared first, every literal route below it would become
   * an exam lookup for an exam called "marks".
   */
  check(
    'every literal GET is declared before the parameterised one',
    ['GET /grade-scales', 'GET /my-results', 'GET /marks', 'GET /results'].every(
      (r) => routes.indexOf(r) < routes.indexOf('GET /:id')
    ),
    true
  );

  check('there is no DELETE — every table here cascades into the next', routes.some((r) => r.startsWith('DELETE')), false);
  check(
    'and the self-service view IS mounted, unlike §16 and §17 — §19.3 names Student Result outright',
    routes.includes('GET /my-results'),
    true
  );

  const writes = examRoutes.stack
    .filter((l) => l.route && !l.route.methods.get)
    .map((l) => [Object.keys(l.route.methods)[0], l.route.path]);
  check('there are ten write routes', writes.length, 10);
  check(
    'no write carries requirePlatformScope() — §19 is school-side',
    writes.every(([m, p]) => named(examRoutes, m, p, 'platformGuard') === false),
    true
  );
  check('every write carries validate()', writes.every(([m, p]) => named(examRoutes, m, p, 'validateRequest')), true);
  check('every write declares its activity', writes.every(([m, p]) => named(examRoutes, m, p, 'activityDeclaration')), true);
  check(
    'one router-level guard, mounted ahead of every route',
    [examRoutes.stack.filter((l) => !l.route).length, examRoutes.stack.findIndex((l) => !l.route)],
    [1, 0]
  );

  /*
   * §5a defect 16, asserted where it is now reachable: at the source.
   *
   * `exam_subjects` has no `organization_id`, so `tenantWhere()` on it is a 500 — and that mistake has
   * shipped twice. It can no longer be provoked at runtime on a gated route, because §5a session 18's
   * fix narrows `req.tenant.schoolId` to the gated school before any service runs, so `tenantWhere`
   * cannot emit the `organization_id` clause that breaks. Substituting `tenantWhere` into this
   * module's exam_subjects queries therefore fails NO HTTP assertion — which is exactly why the guard
   * has to be read off the code instead of waited for.
   */
  const serviceSource = fs.readFileSync(path.join(__dirname, '../src/modules/exams/exams.service.js'), 'utf8');
  /*
   * Comments are stripped before the probe, for the same reason `mountsLimit()` strips them: the
   * service explains beside each query that it uses `childScope` and *never* `tenantWhere`, so a bare
   * search finds the explanation and reports the opposite of the truth.
   */
  const serviceCode = serviceSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const examSubjectQueries = serviceCode.split('db.ExamSubject.').slice(1).map((chunk) => chunk.slice(0, 260));
  check('the module really does query exam_subjects', examSubjectQueries.length > 0, true);
  check(
    'and never through tenantWhere — the table has no organization_id to scope by',
    examSubjectQueries.some((q) => /tenantWhere/.test(q)),
    false
  );
  check(
    '  which the model confirms: the column genuinely is absent',
    'organization_id' in db.ExamSubject.rawAttributes,
    false
  );
  check(
    '  while its sibling marks does have one, so the difference is real and not a reading error',
    'organization_id' in db.Mark.rawAttributes,
    true
  );

  check('no route carries an entitlement limit', mountsLimit('exams'), false);
  check(
    '  and the probe would find one — the students router does mount a limit',
    mountsLimit('students'),
    true
  );
  check(
    'and §11.2 defines no exam limit to carry',
    Object.values(LIMITS).some((k) => k.includes('exam') || k.includes('mark') || k.includes('result')),
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

  async function call(pathname, { method = 'GET', body, token, binary = false } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + pathname, { method, headers, body: payload });
    /*
     * `binary` rather than `raw`, because this helper already uses `raw` for the response TEXT and
     * FR-EXAM-005's export is bytes. Reading a PDF as text would corrupt it before any assertion
     * could look at it.
     */
    if (binary) {
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        disposition: res.headers.get('content-disposition'),
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
      await db.Mark.destroy({ where: { school_id: created.schools } });
      await db.ExamSubject.destroy({ where: { school_id: created.schools } });
      await db.Exam.destroy({ where: { school_id: created.schools } });
      await db.Grade.destroy({ where: { school_id: created.schools } });
      await db.ParentStudent.destroy({ where: { school_id: created.schools } });
      await db.Parent.destroy({ where: { school_id: created.schools }, force: true });
      await db.Student.destroy({ where: { school_id: created.schools }, force: true });
      await db.Teacher.destroy({ where: { school_id: created.schools }, force: true });
      await db.Subject.destroy({ where: { school_id: created.schools }, force: true });
      await db.Section.destroy({ where: { school_id: created.schools }, force: true });
      await db.Class.destroy({ where: { school_id: created.schools }, force: true });
      await db.AcademicSession.destroy({ where: { school_id: created.schools }, force: true });
      await db.SchoolSetting.destroy({ where: { school_id: created.schools } });
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
    for (const slug of [
      ROLES.SUPER_ADMIN, ROLES.ORGANIZATION_ADMIN, ROLES.PRINCIPAL,
      ROLES.TEACHER, ROLES.STUDENT, ROLES.PARENT,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const role = await db.Role.findOne({ where: { slug } });
      if (!role) throw new Error(`seeded role missing: ${slug}`);
      roles[slug] = role;
    }

    /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
    const residueCleared = await sweepResidue(db, { codes: ['VEX-'], domains: ['verify-exams.local'] });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({ name: 'Verify Exams Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Exams A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Exams B');
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify Exams C');
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Exams D');

    const mkPlan = async (code, examsEnabled) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify Exams ${code}`, code: `${CODE_PREFIX}${code}`, status: PLAN_STATUS.ACTIVE,
        tier_rank: 1, trial_days: 0, grace_period_days: 7,
      });
      created.plans.push(plan.id);
      for (const key of MODULE_LIST) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanModule.create({ plan_id: plan.id, module_key: key, is_enabled: key === MODULES.EXAMS ? examsEnabled : true });
      }
      for (const k of [LIMITS.STUDENT_LIMIT, LIMITS.TEACHER_LIMIT, LIMITS.STAFF_LIMIT]) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanLimit.create({ plan_id: plan.id, limit_key: k, limit_type: LIMIT_TYPES.FIXED, limit_value: 100 });
      }
      return plan;
    };
    const withExams = await mkPlan('WITH', true);
    const withoutExams = await mkPlan('WITHOUT', false);

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
    await subscribe(schoolA, withExams);
    await subscribe(schoolB, withoutExams);
    await subscribe(schoolD, withExams);
    /* schoolC is deliberately left unsubscribed. */

    /* Academic structure, created directly — their own suites cover their endpoints. */
    const mkStructure = async (school, tag) => {
      const session = await db.AcademicSession.create({
        school_id: school.id, organization_id: org.id, name: `${tag} 2025-2026`,
        start_date: '2025-04-01', end_date: '2026-03-31', status: ACADEMIC_SESSION_STATUS.ACTIVE, is_current: true,
      });
      const klass = await db.Class.create({
        school_id: school.id, organization_id: org.id, academic_session_id: session.id,
        name: `${tag} Grade 1`, numeric_order: 1,
      });
      const section = await db.Section.create({
        school_id: school.id, organization_id: org.id, class_id: klass.id, name: 'A',
      });
      const maths = await db.Subject.create({
        school_id: school.id, organization_id: org.id, name: `${tag} Maths`, code: `${CODE_PREFIX}${tag}M`,
      });
      const science = await db.Subject.create({
        school_id: school.id, organization_id: org.id, name: `${tag} Science`, code: `${CODE_PREFIX}${tag}S`,
      });
      return { session, klass, section, maths, science };
    };
    const A = await mkStructure(schoolA, 'A');
    const D = await mkStructure(schoolD, 'D');

    const teacherA = await db.Teacher.create({
      school_id: schoolA.id, organization_id: org.id, employee_id: `${CODE_PREFIX}T1`,
      first_name: 'Nadia', joining_date: '2024-01-15',
    });
    await db.Teacher.create({
      school_id: schoolD.id, organization_id: org.id, employee_id: `${CODE_PREFIX}T9`,
      first_name: 'Faraway', joining_date: '2024-01-15',
    });

    const password_hash = await hashPassword(PASSWORD);
    const mkUser = async (key, slug, organization_id, school_id) => {
      const u = await db.User.create({
        role_id: roles[slug].id, organization_id, school_id, name: `Verify EX ${key}`,
        email: `${key}@${DOMAIN}`, username: `vex_${key.replace(/-/g, '_')}`,
        password_hash, status: USER_STATUS.ACTIVE, must_change_password: false,
      });
      created.users.push(u.id);
      return u;
    };
    await mkUser('platform', ROLES.SUPER_ADMIN, null, null);
    await mkUser('principal-a', ROLES.PRINCIPAL, org.id, schoolA.id);
    await mkUser('principal-b', ROLES.PRINCIPAL, org.id, schoolB.id);
    await mkUser('principal-c', ROLES.PRINCIPAL, org.id, schoolC.id);
    await mkUser('principal-d', ROLES.PRINCIPAL, org.id, schoolD.id);
    await mkUser('teacher', ROLES.TEACHER, org.id, schoolA.id);
    await mkUser('org-admin', ROLES.ORGANIZATION_ADMIN, org.id, null);
    const studentUser = await mkUser('student', ROLES.STUDENT, org.id, schoolA.id);
    const parentUser = await mkUser('parent', ROLES.PARENT, org.id, schoolA.id);

    /* Five children, in the order the fixture ledger names them. */
    const names = [['Amina', studentUser.id], ['Bilal', null], ['Dara', null], ['Elif', null], ['Chidi', null]];
    const kids = [];
    for (const [first, userId] of names) {
      // eslint-disable-next-line no-await-in-loop
      kids.push(await db.Student.create({
        school_id: schoolA.id, organization_id: org.id, student_id: `${CODE_PREFIX}${first}`,
        first_name: first, admission_date: '2025-04-01', status: STUDENT_STATUS.ACTIVE,
        class_id: A.klass.id, section_id: A.section.id, academic_session_id: A.session.id,
        user_id: userId,
      }));
    }
    const [amina, bilal, dara, elif, chidi] = kids;

    const parent = await db.Parent.create({
      school_id: schoolA.id, organization_id: org.id, user_id: parentUser.id,
      name: 'Yusuf Parent', first_name: 'Yusuf', last_name: 'Parent', is_active: true,
    });
    await db.ParentStudent.create({ school_id: schoolA.id, parent_id: parent.id, student_id: bilal.id, relation: 'father' });

    const dKid = await db.Student.create({
      school_id: schoolD.id, organization_id: org.id, student_id: `${CODE_PREFIX}D1`,
      first_name: 'Dee', admission_date: '2025-04-01', status: STUDENT_STATUS.ACTIVE,
      class_id: D.klass.id, section_id: D.section.id, academic_session_id: D.session.id,
    });

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
    const studentToken = await signIn(`student@${DOMAIN}`);
    const parentToken = await signIn(`parent@${DOMAIN}`);

    /* ── the entitlement guard ── */

    const moduleDenied = await call('/exams', { token: principalB });
    check('a plan without the Exams module refuses', moduleDenied.status, 403);
    check('and names the module', codeOf(moduleDenied), 'MODULE_NOT_SUBSCRIBED');
    check('naming which one', moduleDenied.body.error.details.missing, [MODULES.EXAMS]);
    const noSub = await call('/exams', { token: principalC });
    check('a school with no subscription is refused differently', noSub.status, 402);
    check('state is checked before module', codeOf(noSub), 'SUBSCRIPTION_INACTIVE');

    /* ── §19.1 the Grade System ── */

    const mkBand = async (body, token = principalA) =>
      dataOf(await expectOk('/exams/grade-scales', { method: 'POST', token, body }, 201)).grade;

    const bandA = await mkBand({ name: 'A', min_percentage: 80, max_percentage: 100, grade_point: 4 });
    await mkBand({ name: 'B', min_percentage: 60, max_percentage: 79.999, grade_point: 3 });
    await mkBand({ name: 'C', min_percentage: 50, max_percentage: 59.999, grade_point: 2 });
    await mkBand({ name: 'F', min_percentage: 0, max_percentage: 49.999, grade_point: 0, is_failing: true });
    check('a school defines its own grade scale — FR-EXAM-001 "selects/configures the Grade System"', Boolean(bandA.id), true);
    check('the scale name defaults', bandA.scale_name, 'default');

    /*
     * Overlap is refused at write time. A percentage sitting in two bands has no defensible answer
     * once a card has been printed from it, and `grades` carries no unique index to refuse it.
     */
    const overlap = await call('/exams/grade-scales', {
      method: 'POST', token: principalA,
      body: { name: 'A-', min_percentage: 75, max_percentage: 85 },
    });
    check('a band overlapping an existing one is refused', overlap.status, 409);
    check('  and says which it collides with', codeOf(overlap), 'GRADE_BAND_OVERLAP');
    /*
     * A band that only TOUCHES an existing one at a boundary is refused too, and it has to be: the
     * overlap test and `matchBand()` must agree. While the test was half-open, A(80..100) and
     * B(60..80) could both exist and a percentage of exactly 80 matched both - the case the service
     * header claimed could not arise (§5a session 19).
     */
    await expectOk('/exams/grade-scales', {
      method: 'POST', token: principalA,
      body: { name: 'Low', scale_name: 'boundary-probe', min_percentage: 0, max_percentage: 50 },
    }, 201);
    const touching = await call('/exams/grade-scales', {
      method: 'POST', token: principalA,
      body: { name: 'High', scale_name: 'boundary-probe', min_percentage: 50, max_percentage: 100 },
    });
    check('  a band that only TOUCHES another at a boundary is refused', touching.status, 409);
    check('    because matchBand is inclusive at both ends, so 50 would match both', codeOf(touching), 'GRADE_BAND_OVERLAP');
    check(
      '    and the message itself names the band and its range, for a screen that shows only the message',
      touching.body.error && touching.body.error.message,
      'That band overlaps "Low" (0–50%) on the boundary-probe grade scale'
    );

    /* On a scale with nothing to collide with, the model's own bandOrdered validator is what refuses. */
    const zeroWidth = await call('/exams/grade-scales', {
      method: 'POST', token: principalA,
      body: { name: 'X', scale_name: 'empty-scale', min_percentage: 100, max_percentage: 100 },
    });
    check('  a zero-width band is refused by the model — a max must exceed its min', zeroWidth.status, 422);
    const straddle = await call('/exams/grade-scales', {
      method: 'POST', token: principalA,
      body: { name: 'Y', min_percentage: 99, max_percentage: 100 },
    });
    check('  and a band inside an existing one collides with it', straddle.status, 409);

    const model = await mkBand({ name: 'A', min_percentage: 90, max_percentage: 100, scale_name: 'strict' });
    check('a second scale is independent — the same band name may exist on it', model.scale_name, 'strict');

    /* ── §19.1 the examination, and the Teacher actor mismatch ── */

    const teacherCreate = await call('/exams', {
      method: 'POST', token: teacher,
      body: { name: 'Teacher exam', exam_type: 'Midterm', class_id: A.klass.id },
    });
    check('a teacher cannot create an exam — the seeded catalogue withholds exams.manage', teacherCreate.status, 403);
    check('  and it is the permission, not the module', codeOf(teacherCreate), 'INSUFFICIENT_PERMISSION');

    const unknownScale = await call('/exams', {
      method: 'POST', token: principalA,
      body: { name: 'Bad', exam_type: 'Midterm', class_id: A.klass.id, grade_scale: 'nonexistent' },
    });
    check('an exam cannot name a grade scale with no bands — nothing would grade it', unknownScale.status, 422);

    const foreignClass = await call('/exams', {
      method: 'POST', token: principalA,
      body: { name: 'Bad', exam_type: 'Midterm', class_id: D.klass.id },
    });
    check("an exam cannot name another school's class", foreignClass.status, 422);

    /* D20 — a closed session takes no new exam. */
    const closedYear = await db.AcademicSession.create({
      school_id: schoolA.id, organization_id: org.id, name: 'A 2019-2020',
      start_date: '2019-04-01', end_date: '2020-03-31', status: ACADEMIC_SESSION_STATUS.CLOSED, is_current: false,
    });
    const examInClosed = await call('/exams', {
      method: 'POST', token: principalA,
      body: { name: 'Old', exam_type: 'Midterm', class_id: A.klass.id, academic_session_id: closedYear.id },
    });
    check('D20 — an exam cannot be added to a closed session', [examInClosed.status, codeOf(examInClosed)], [409, 'SESSION_CLOSED']);
    /* Nor to a closed year's class by naming no session — the class's own session counts too. */
    const closedYearClass = await db.Class.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: closedYear.id, name: 'A Grade 1 (2019)', numeric_order: 1,
    });
    const examInClosedClass = await call('/exams', {
      method: 'POST', token: principalA, body: { name: 'Old class', exam_type: 'Midterm', class_id: closedYearClass.id },
    });
    check('  nor to a class of a closed session when the body names no session at all',
      [examInClosedClass.status, codeOf(examInClosedClass)], [409, 'SESSION_CLOSED']);

    const exam = dataOf(await expectOk('/exams', {
      method: 'POST', token: principalA,
      body: {
        name: 'Midterm 2025', exam_type: 'Midterm', class_id: A.klass.id, section_id: A.section.id,
        academic_session_id: A.session.id, start_date: '2025-09-01', end_date: '2025-09-10',
      },
    }, 201)).exam;
    check('a Principal creates the exam — FR-EXAM-001 names them', Boolean(exam.id), true);
    check('it starts as a draft', exam.status, EXAM_STATUS.DRAFT);
    check('the dates are stored as plain dates', [exam.start_date, exam.end_date], ['2025-09-01', '2025-09-10']);
    check('and the grade scale defaults to the one the school defined', exam.grade_scale, 'default');

    /* ── §19.1 the papers ── */

    const mkPaper = async (body) =>
      dataOf(await expectOk(`/exams/${exam.id}/subjects`, { method: 'POST', token: principalA, body }, 201)).subject;

    const mathsPaper = await mkPaper({ subject_id: A.maths.id, full_marks: 100, passing_marks: 40, teacher_id: teacherA.id });
    const sciencePaper = await mkPaper({
      subject_id: A.science.id, full_marks: 70, passing_marks: 28,
      practical_full_marks: 30, practical_passing_marks: 12, exam_date: '2025-09-05',
    });
    check('a paper carries its Marks and Passing Marks — §19.1', [Number(mathsPaper.full_marks), Number(mathsPaper.passing_marks)], [100, 40]);
    check('the weightage column holds its documented default, because no route can set it', Number(mathsPaper.weightage), 1);
    check('a practical component is recorded on both sides', [Number(sciencePaper.practical_full_marks), Number(sciencePaper.practical_passing_marks)], [30, 12]);
    check('and the paper date is a plain date', sciencePaper.exam_date, '2025-09-05');

    const duplicate = await call(`/exams/${exam.id}/subjects`, {
      method: 'POST', token: principalA, body: { subject_id: A.maths.id, full_marks: 50, passing_marks: 20 },
    });
    check('the same subject cannot be added twice', duplicate.status, 409);
    check('  which is the unique index speaking', codeOf(duplicate), 'EXAM_SUBJECT_EXISTS');

    const passingAboveFull = await call(`/exams/${exam.id}/subjects`, {
      method: 'POST', token: principalA, body: { subject_id: A.science.id, full_marks: 10, passing_marks: 20 },
    });
    check('passing marks above full marks are refused by the model validator', passingAboveFull.status, 422);

    const barWithoutPaper = await call(`/exams/${exam.id}/subjects`, {
      method: 'POST', token: principalA,
      body: { subject_id: A.science.id, full_marks: 50, passing_marks: 20, practical_passing_marks: 5 },
    });
    check('a practical bar with no practical paper is a rule nothing can meet', barWithoutPaper.status, 422);

    const foreignSubject = await call(`/exams/${exam.id}/subjects`, {
      method: 'POST', token: principalA, body: { subject_id: D.maths.id, full_marks: 50, passing_marks: 20 },
    });
    check("a paper cannot name another school's subject", foreignSubject.status, 422);

    const weighted = await call(`/exams/${exam.id}/subjects`, {
      method: 'POST', token: principalA,
      body: { subject_id: A.science.id, full_marks: 50, passing_marks: 20, weightage: 2 },
    });
    check('weightage is refused over HTTP too — §19 describes no weighting', weighted.status, 422);

    /*
     * `exam_subjects` has NO organization_id, so this list is the assertion that `childScope` is used
     * rather than `tenantWhere` — the latter is a 500 on this table, and it has shipped twice.
     */
    const papers = dataOf(await expectOk(`/exams/${exam.id}/subjects`, { token: principalA }, 200)).subjects;
    check('both papers are listed through the parent exam, not through tenantWhere', papers.length, 2);
    const orgPapers = dataOf(await expectOk(`/exams/${exam.id}/subjects?school_id=${schoolA.id}`, { token: orgAdmin }, 200)).subjects;
    check('  and an organization-scoped caller reaches the same list', orgPapers.length, 2);

    /* ── §19.2 Marks ── */

    const enter = async (examSubjectId, entries, token = teacher) =>
      dataOf(await expectOk('/exams/marks', { method: 'POST', token, body: { exam_subject_id: examSubjectId, entries } }, 200)).marks;

    const mathsEntries = [
      { student_id: amina.id, marks_obtained: 90 },
      { student_id: bilal.id, marks_obtained: 70 },
      { student_id: dara.id, marks_obtained: 70 },
      { student_id: elif.id, marks_obtained: 40 },
    ];
    const entered = await enter(mathsPaper.id, mathsEntries);
    check('a teacher enters marks — FR-EXAM-002 names them as the actor', entered.length, 4);
    check('and they start as drafts', [...new Set(entered.map((m) => m.status))], [MARK_STATUS.DRAFT]);

    const examAfterEntry = dataOf(await expectOk(`/exams/${exam.id}`, { token: principalA }, 200)).exam;
    check('an exam being marked is no longer merely a draft', examAfterEntry.status, EXAM_STATUS.MARKS_ENTRY);

    /* "Teacher may edit entered marks prior to submission" — the upsert is the mechanism. */
    const corrected = await enter(mathsPaper.id, [{ student_id: amina.id, marks_obtained: 91 }]);
    check('re-entering a mark corrects it', Number(corrected[0].marks_obtained), 91);
    check(
      'and does not duplicate the row',
      await db.Mark.count({ where: { exam_subject_id: mathsPaper.id, student_id: amina.id } }),
      1
    );
    await enter(mathsPaper.id, [{ student_id: amina.id, marks_obtained: 90 }]);

    const tooHigh = await call('/exams/marks', {
      method: 'POST', token: teacher,
      body: { exam_subject_id: mathsPaper.id, entries: [{ student_id: amina.id, marks_obtained: 101 }] },
    });
    check('a mark above the paper it was scored on is refused', tooHigh.status, 422);

    const practicalOnPlainPaper = await call('/exams/marks', {
      method: 'POST', token: teacher,
      body: { exam_subject_id: mathsPaper.id, entries: [{ student_id: amina.id, practical_marks_obtained: 5 }] },
    });
    check('a practical mark on a paper with no practical component is refused', practicalOnPlainPaper.status, 422);

    const stranger = await call('/exams/marks', {
      method: 'POST', token: teacher,
      body: { exam_subject_id: mathsPaper.id, entries: [{ student_id: dKid.id, marks_obtained: 50 }] },
    });
    check('a child who is not sitting this exam cannot be marked', stranger.status, 422);

    /*
     * The completeness rule. Chidi has no Maths mark yet, and submitting now would let the calculation
     * treat "forgotten" and "absent" as the same thing.
     */
    const incomplete = await call('/exams/marks/submit', {
      method: 'POST', token: teacher, body: { exam_subject_id: mathsPaper.id },
    });
    check('a paper cannot be submitted while a child has no mark on it', incomplete.status, 422);
    check(
      '  and the refusal names the child',
      /Missing a mark/.test(JSON.stringify((incomplete.body && incomplete.body.error) || {})),
      true
    );

    await enter(mathsPaper.id, [{ student_id: chidi.id, marks_obtained: 30 }]);
    const submittedMaths = dataOf(await expectOk('/exams/marks/submit', {
      method: 'POST', token: teacher, body: { exam_subject_id: mathsPaper.id },
    }, 200)).calculation;
    check('with every child marked, the paper submits', submittedMaths.papersCounted, 1);
    check('  and one paper is still outstanding', submittedMaths.papersOutstanding, 1);
    check('  while a result row now exists for every child', submittedMaths.results, 5);

    const afterSubmit = await call('/exams/marks', {
      method: 'POST', token: teacher,
      body: { exam_subject_id: mathsPaper.id, entries: [{ student_id: amina.id, marks_obtained: 100 }] },
    });
    check('a submitted paper is closed to further editing', afterSubmit.status, 409);
    check('  which is what "prior to submission" means', codeOf(afterSubmit), 'MARKS_ALREADY_SUBMITTED');
    const resubmit = await call('/exams/marks/submit', { method: 'POST', token: teacher, body: { exam_subject_id: mathsPaper.id } });
    check('and it cannot be submitted twice', resubmit.status, 409);

    /*
     * A paper's figures freeze as soon as a mark exists on it, not merely once it is submitted. Asserted
     * on a paper that is still OPEN, so the refusal can only be the marks guard - on a submitted paper
     * the EXAM_SUBJECT_SUBMITTED 409 fires first and this would pass for the wrong reason.
     */
    const pricedExam = dataOf(await expectOk('/exams', {
      method: 'POST', token: principalA,
      body: { name: 'Repricing probe', exam_type: 'Final', class_id: A.klass.id },
    }, 201)).exam;
    const pricedPaper = dataOf(await expectOk(`/exams/${pricedExam.id}/subjects`, {
      method: 'POST', token: principalA, body: { subject_id: A.maths.id, full_marks: 100, passing_marks: 40 },
    }, 201)).subject;
    const widened = await expectOk(`/exams/${pricedExam.id}/subjects/${pricedPaper.id}`, {
      method: 'PATCH', token: principalA, body: { full_marks: 120 },
    }, 200);
    check('a paper with no marks yet can still be re-priced', Number(dataOf(widened).subject.full_marks), 120);
    await expectOk('/exams/marks', {
      method: 'POST', token: teacher,
      body: { exam_subject_id: pricedPaper.id, entries: [{ student_id: amina.id, marks_obtained: 90 }] },
    }, 200);
    const shrunk = await call(`/exams/${pricedExam.id}/subjects/${pricedPaper.id}`, {
      method: 'PATCH', token: principalA, body: { full_marks: 50 },
    });
    check('but once a mark exists the paper cannot be re-priced under it', shrunk.status, 409);
    check('  which would otherwise give 90 out of 50 — a numerator with no denominator', codeOf(shrunk), 'EXAM_SUBJECT_HAS_MARKS');
    const rescheduled = await expectOk(`/exams/${pricedExam.id}/subjects/${pricedPaper.id}`, {
      method: 'PATCH', token: principalA, body: { room: 'Hall B' },
    }, 200);
    check('  while scheduling fields stay editable, because they change no arithmetic', dataOf(rescheduled).subject.room, 'Hall B');

    const editSubmittedPaper = await call(`/exams/${exam.id}/subjects/${mathsPaper.id}`, {
      method: 'PATCH', token: principalA, body: { full_marks: 200 },
    });
    check('nor can the paper itself be re-marked once its marks are in', editSubmittedPaper.status, 409);
    check('  because every result was calculated from it', codeOf(editSubmittedPaper), 'EXAM_SUBJECT_SUBMITTED');

    /* ── FR-EXAM-004 refuses a partial exam ── */

    const early = await call(`/exams/${exam.id}/results`, { method: 'POST', token: principalA, body: {} });
    check('results cannot be generated while a paper is outstanding', early.status, 409);
    check('  naming the outstanding paper', codeOf(early), 'EXAM_MARKS_OUTSTANDING');

    /* ── the second paper, and the calculation ── */

    await enter(sciencePaper.id, [
      { student_id: amina.id, marks_obtained: 60, practical_marks_obtained: 25 },
      { student_id: bilal.id, marks_obtained: 50, practical_marks_obtained: 20 },
      { student_id: dara.id, marks_obtained: 50, practical_marks_obtained: 20 },
      { student_id: elif.id, marks_obtained: 28, practical_marks_obtained: 12 },
      { student_id: chidi.id, is_absent: true },
    ]);
    const submittedScience = dataOf(await expectOk('/exams/marks/submit', {
      method: 'POST', token: teacher, body: { exam_subject_id: sciencePaper.id },
    }, 200)).calculation;
    check('both papers are now counted', submittedScience.papersCounted, 2);
    check('and none is outstanding', submittedScience.papersOutstanding, 0);

    const resultOf = async (student) => {
      const rows = dataOf(await expectOk(`/exams/results?exam_id=${exam.id}&student_id=${student.id}`, { token: principalA }, 200));
      return rows[0];
    };

    const rAmina = await resultOf(amina);
    check('every denominator is 100 + (70 + 30) — the practical counts on both sides', Number(rAmina.total_full_marks), 200);
    check('Amina scored 90 + 60 + 25', Number(rAmina.total_marks_obtained), 175);
    check('  which is 87.500%', Number(rAmina.percentage), 87.5);
    check('  band A', rAmina.grade_name, 'A');
    check('  carrying the band\'s grade point', Number(rAmina.grade_point), 4);
    check('  no subject failed', rAmina.subjects_failed, 0);
    check('  and both papers counted', rAmina.subjects_count, 2);
    check('  so she passed', rAmina.outcome, RESULT_OUTCOME.PASS);

    const rBilal = await resultOf(bilal);
    check('Bilal scored 70 + 50 + 20 = 140, exactly 70%', [Number(rBilal.total_marks_obtained), Number(rBilal.percentage)], [140, 70]);
    check('  band B', rBilal.grade_name, 'B');

    /*
     * Elif is the case §19 leaves open: she cleared every bar exactly — 40 ≥ 40, 28 ≥ 28, 12 ≥ 12 —
     * and still lands in a band the school marked as failing.
     */
    const rElif = await resultOf(elif);
    check('Elif cleared every bar exactly, so no subject failed', rElif.subjects_failed, 0);
    check('  scoring 40 + 28 + 12 = 80, exactly 40%', [Number(rElif.total_marks_obtained), Number(rElif.percentage)], [80, 40]);
    check('  which is the failing band', rElif.grade_name, 'F');
    check('  and the band decides the exam — passing every paper is not enough', rElif.outcome, RESULT_OUTCOME.FAIL);

    const rChidi = await resultOf(chidi);
    check('Chidi was absent for Science, which still counts 100 against him', Number(rChidi.total_full_marks), 200);
    check('  contributing nothing — 30 of 200 is 15%', [Number(rChidi.total_marks_obtained), Number(rChidi.percentage)], [30, 15]);
    check('  and an absent paper is a failed paper, on top of the Maths he failed', rChidi.subjects_failed, 2);
    check('  so he failed', rChidi.outcome, RESULT_OUTCOME.FAIL);

    const chidiMarks = await db.Mark.findAll({ where: { exam_id: exam.id, student_id: chidi.id } });
    check('every mark carries its own grade and outcome', chidiMarks.every((m) => m.outcome !== null), true);
    check('and every mark on a submitted paper is locked', [...new Set(chidiMarks.map((m) => m.status))], [MARK_STATUS.SUBMITTED]);

    /* ── FR-EXAM-004 Position ── */

    const generated = dataOf(await expectOk(`/exams/${exam.id}/results`, { method: 'POST', token: principalA, body: {} }, 200)).summary;
    check('results are generated for the whole cohort', generated.ranked, 5);

    const ranking = dataOf(await expectOk(`/exams/${exam.id}/results?limit=50`, { token: principalA }, 200));
    const byName = Object.fromEntries(ranking.map((r) => [r.student.first_name, r]));
    check(
      'the merit list is 1, 2, 2, 4, 5 — a tie shares a place and the next one skips',
      ['Amina', 'Bilal', 'Dara', 'Elif', 'Chidi'].map((n) => byName[n].position),
      [1, 2, 2, 4, 5]
    );
    check('and every row is out of the same cohort', [...new Set(ranking.map((r) => r.position_out_of))], [5]);
    check('generating results completes the exam', dataOf(await expectOk(`/exams/${exam.id}`, { token: principalA }, 200)).exam.status, EXAM_STATUS.COMPLETED);

    /*
     * A child enrolled AFTER the exam was sat must not appear on its merit list.
     *
     * `cohortOf()` is "active students in the class", which is the right question at marks-entry time
     * and the wrong one at recalculation time: re-generating would otherwise mint a result row for a
     * newcomer with no marks, score them 0%, rank them last and inflate everyone's `position_out_of`.
     */
    const newcomer = await db.Student.create({
      school_id: schoolA.id, organization_id: org.id, student_id: `${CODE_PREFIX}Late`,
      first_name: 'Latecomer', admission_date: '2025-10-01', status: STUDENT_STATUS.ACTIVE,
      class_id: A.klass.id, section_id: A.section.id, academic_session_id: A.session.id,
    });
    await expectOk(`/exams/${exam.id}/results`, { method: 'POST', token: principalA, body: {} }, 200);
    check(
      'a child who joined after the exam gets no phantom result row',
      await db.Result.count({ where: { exam_id: exam.id, student_id: newcomer.id } }),
      0
    );
    const afterNewcomer = dataOf(await expectOk(`/exams/${exam.id}/results?limit=50`, { token: principalA }, 200));
    check('  so the cohort size is unchanged', [...new Set(afterNewcomer.map((r) => r.position_out_of))], [5]);
    check('  and the merit list is untouched', afterNewcomer.map((r) => r.position).sort((a, b) => a - b), [1, 2, 2, 4, 5]);

    /* ── the Result Card, and the half of FR-EXAM-005 this module delivers ── */

    const card = dataOf(await expectOk(`/exams/results/${byName.Amina.id}`, { token: principalA }, 200)).card;
    check('the card names the school without a second call', card.school.name, 'Verify Exams A');
    /* D35 — and names it as the school does, once the school has set a display name. */
    const displayName = await db.SchoolSetting.create({
      school_id: schoolA.id, organization_id: org.id, name: 'Verify Exams Display Name',
    });
    check('D35 — a result card carries the school\'s display name once it has set one',
      dataOf(await expectOk(`/exams/results/${byName.Amina.id}`, { token: principalA }, 200)).card.school.name,
      'Verify Exams Display Name');
    await displayName.destroy();
    check('the exam', [card.exam.name, card.exam.exam_type], ['Midterm 2025', 'Midterm']);
    check('the student', card.student.first_name, 'Amina');
    check('the totals', [card.totals.total_marks_obtained, card.totals.percentage, card.totals.grade_name], [175, 87.5, 'A']);
    check('the position', [card.position.position, card.position.out_of], [1, 5]);
    check('and one row per paper, snapshotted rather than joined', card.subjects.length, 2);
    check('  each carrying the paper it was scored on', card.subjects.map((s) => Number(s.full_marks)).sort((a, b) => a - b), [70, 100]);
    check('  and its own grade and outcome', card.subjects.every((s) => s.outcome !== undefined), true);
    /*
     * Still null, and now for a different reason worth stating. Phase 5.4 renders the card, but it
     * **streams the bytes** rather than storing them — §22's pattern, which needs no upload profile,
     * no storage accounting and none of the file-serving infrastructure this application still
     * lacks. Persisting a card is a separate decision from rendering one, and nothing has made it.
     */
    check('the PDF path is still null — Phase 5.4 streams the card rather than storing it',
      card.result_card_path, null);

    /* ── FR-EXAM-005 — the PDF export ── */

    /*
     * Read back by inflating the content streams and decoding the hex operands of pdfkit's `TJ`
     * operators. `pdf-parse` is a dependency and cannot do it — it fails on an untouched pdfkit
     * document — so this is how `verify-pdf.js` and `verify-reports.js` do it too.
     */
    const inflatePdf = (buffer) => {
      const zlib = require('zlib');
      const raw = buffer.toString('latin1');
      const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
      const parts = [];
      let match = streams.exec(raw);
      while (match !== null) {
        try { parts.push(zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')); }
        catch (_) { /* not a deflate stream */ }
        match = streams.exec(raw);
      }
      return (parts.join('\n').match(/<([0-9A-Fa-f]+)>/g) || [])
        .map((hex) => Buffer.from(hex.slice(1, -1), 'hex').toString('latin1'))
        .join('');
    };

    const cardPdf = await call(`/exams/results/${byName.Amina.id}?format=pdf`,
      { token: principalA, binary: true });
    check('FR-EXAM-005 — the result card is exported as a PDF', cardPdf.status, 200);
    check('  with the pdf content type', cardPdf.contentType, 'application/pdf');
    check('  offered as a download named for the result',
      new RegExp(`attachment; filename="result-card-${byName.Amina.id}-\\d{4}-\\d{2}-\\d{2}\\.pdf"`)
        .test(cardPdf.disposition), true);
    check('  and the bytes really are a PDF, not JSON wearing a header',
      [cardPdf.buffer.slice(0, 5).toString(),
        cardPdf.buffer.toString('latin1').trimEnd().endsWith('%%EOF')],
      ['%PDF-', true]);

    const cardText = inflatePdf(cardPdf.buffer);
    /*
     * Label AND value together, not the value alone. The fixture's `student_id` is `VEX-Amina`, so
     * asserting that the text merely contains "Amina" passes even when the student's NAME has been
     * dropped from the identity block — a deliberate regression proved exactly that. Pairs are
     * rendered as "Label: value", so requiring the pair is what pins the field.
     */
    check('  carrying the identity block — school, exam and the student it belongs to',
      ['Verify Exams A', 'Midterm 2025', 'Student: Amina'].filter((t) => !cardText.includes(t)), []);
    check('  a row per paper, with the column headers',
      ['Subject', 'Obtained', 'Grade', 'Outcome'].filter((t) => !cardText.includes(t)), []);
    /*
     * Pairs, matched at a word boundary — and the boundary is the point.
     *
     * `'NotPosition'.includes('Position')` is true, so asserting the bare label passes when the label
     * has been renamed. Asserting the whole pair is not enough either: `'NotPosition: 1 of 5'` still
     * contains `'Position: 1 of 5'`. Two deliberate regressions were needed to find that, one after
     * the other. Requiring a non-letter before the label is what finally pins it.
     */
    const hasPair = (label, value) => {
      const needle = `${label}: ${value}`;
      let at = cardText.indexOf(needle);
      while (at !== -1) {
        /* A letter immediately before means this is the tail of a longer label, not the label. */
        if (at === 0 || !/[A-Za-z]/.test(cardText[at - 1])) return true;
        at = cardText.indexOf(needle, at + 1);
      }
      return false;
    };
    check('  and the totals a reader actually wants',
      [['Percentage', '87.5%'], ['Position', '1 of 5'], ['Outcome', 'pass']]
        .filter(([label, value]) => !hasPair(label, value)).map(([label]) => label), []);

    /*
     * The card and the PDF are rendered from the SAME payload, so a figure cannot differ between the
     * screen and the print. Asserted by taking the numbers out of the JSON and requiring them on the
     * page rather than by restating them here — a literal would pass even if both drifted together.
     */
    check('  every subject on the JSON card reaches the page',
      card.subjects.map((paper) => paper.subject_name).filter((n) => n && !cardText.includes(n)), []);

    /*
     * FR-EXAM-004's Class Result, exported the way the card is. SRS:1030 makes results "available for
     * viewing, PDF export, and printing" and only the single card had an export; a principal printing a
     * class's results had one PDF per student to open.
     */
    const classPdf = await call(`/exams/${exam.id}/results?format=pdf`, { token: principalA, binary: true });
    check('FR-EXAM-004 — the class result is exported as a PDF too, named for the exam',
      [classPdf.status, classPdf.contentType,
        new RegExp(`attachment; filename="class-result-${exam.id}-\\d{4}-\\d{2}-\\d{2}\\.pdf"`).test(classPdf.disposition),
        classPdf.buffer.slice(0, 5).toString()],
      [200, 'application/pdf', true, '%PDF-']);
    const classText = inflatePdf(classPdf.buffer);
    check('  carrying the exam and every student with a result',
      ['Class Result', 'Midterm 2025', 'Amina', 'Bilal', 'Chidi', 'Dara', 'Elif'].filter((t) => !classText.includes(t)), []);
    check('  in merit order — first place before fourth, fourth before fifth',
      [classText.indexOf('Amina') < classText.indexOf('Elif'), classText.indexOf('Elif') < classText.indexOf('Chidi')],
      [true, true]);
    check('  and a format §19 does not name is refused, as it is on the card',
      (await call(`/exams/${exam.id}/results?format=xlsx`, { token: principalA })).status, 422);
    /*
     * It honours the list's `is_published` filter, so the PDF is the set the screen was filtered to.
     * Nothing is published yet at this point (the publish step is below), so "published only" is empty.
     */
    const publishedOnlyPdf = inflatePdf((await call(`/exams/${exam.id}/results?format=pdf&is_published=true`,
      { token: principalA, binary: true })).buffer);
    check('  and filtered to published results — none yet — the PDF carries none of the unpublished rows',
      ['Amina', 'Bilal', 'Chidi', 'Dara', 'Elif'].filter((name) => publishedOnlyPdf.includes(name)), []);

    /*
     * The absence rule, asserted where a fixture can reach it.
     *
     * §19 stores `null` for an absent paper and the card must print `absent`, never `0` — a zero
     * reports a mark the student never received, on a document a parent keeps. Chidi is the fixture's
     * absent student; the documents module's Result Card cannot reach this branch at all, which is
     * why `subjectRows()` is exported from here and shared rather than copied into both.
     */
    const chidiResult = await resultOf(chidi);
    const chidiPdf = await call(`/exams/results/${chidiResult.id}?format=pdf`,
      { token: principalA, binary: true });
    const chidiText = inflatePdf(chidiPdf.buffer);
    check('an absent paper prints "absent" on the card, not the 0 that would libel the student',
      [chidiPdf.status, chidiText.includes('absent')], [200, true]);
    check('  and `subjectRows()` is the single owner of that rule, shared with the §20.5 Result Card',
      typeof examsService.subjectRows, 'function');

    /* ── the formats §19.3 does NOT name ── */

    check('§19.3 names PDF and Print, not Excel — so a spreadsheet is refused rather than invented',
      (await call(`/exams/results/${byName.Amina.id}?format=excel`, { token: principalA })).status, 422);
    check('  and `print` is refused too, there being no view engine here to produce it',
      (await call(`/exams/results/${byName.Amina.id}?format=print`, { token: principalA })).status, 422);
    check('  while no format at all is still the JSON card, unchanged',
      Boolean(dataOf(await expectOk(`/exams/results/${byName.Amina.id}`, { token: principalA }, 200)).card),
      true);

    /* ── publication, and the self-service view ── */

    const beforePublish = await expectOk('/exams/my-results', { token: studentToken }, 200);
    check('an unpublished result is invisible to the student it is about', dataOf(beforePublish).length, 0);

    const published = dataOf(await expectOk(`/exams/${exam.id}/publish`, { method: 'POST', token: principalA, body: {} }, 200));
    check('publishing releases every result', published.published, 5);
    check('  and marks the exam published', published.exam.status, EXAM_STATUS.PUBLISHED);
    const republish = await call(`/exams/${exam.id}/publish`, { method: 'POST', token: principalA, body: {} });
    check('publishing twice is refused rather than silently re-stamped', republish.status, 409);

    const mine = dataOf(await expectOk('/exams/my-results', { token: studentToken }, 200));
    check('now the student sees their own result — §19.3 "Student Result"', mine.length, 1);
    check('  and it is theirs', mine[0].student.first_name, 'Amina');
    check('  without the column a stored card path would travel in — no path leaves the server (#26)',
      'result_card_path' in mine[0], false);

    const theirs = dataOf(await expectOk('/exams/my-results', { token: parentToken }, 200));
    check('a parent sees their own child, and only that child', theirs.map((r) => r.student.first_name), ['Bilal']);
    const otherChild = await call(`/exams/my-results?student_id=${amina.id}`, { token: parentToken });
    check('  and cannot ask for a child who is not theirs', otherChild.status, 403);
    check('  which is a link failure, not a missing row', codeOf(otherChild), 'STUDENT_NOT_LINKED');

    const studentReachingClass = await call(`/exams/${exam.id}/results`, { token: studentToken });
    check('a student cannot read the whole class result — results.self.view is not results.view', studentReachingClass.status, 403);

    /* ── tenant scoping ── */

    const dExam = dataOf(await expectOk('/exams', {
      method: 'POST', token: principalD,
      body: { name: 'D Midterm', exam_type: 'Midterm', class_id: D.klass.id, grade_scale: 'default' },
    }, 422));
    void dExam;
    const dBand = await expectOk('/exams/grade-scales', {
      method: 'POST', token: principalD, body: { name: 'P', min_percentage: 0, max_percentage: 100 },
    }, 201);
    const dExamOk = dataOf(await expectOk('/exams', {
      method: 'POST', token: principalD,
      body: { name: 'D Midterm', exam_type: 'Midterm', class_id: D.klass.id },
    }, 201)).exam;
    void dBand;

    const listA = dataOf(await expectOk('/exams', { token: principalA }, 200));
    check('a school sees its own exams', listA.map((e) => e.name).includes('Midterm 2025'), true);
    check("and not another school's — the counter-example exists", listA.map((e) => e.name).includes('D Midterm'), false);
    const foreignExam = await call(`/exams/${dExamOk.id}`, { token: principalA });
    check("another school's exam is not found, not merely forbidden", foreignExam.status, 404);
    check('  and says so', codeOf(foreignExam), 'EXAM_NOT_FOUND');
    const foreignPapers = await call(`/exams/${dExamOk.id}/subjects`, { token: principalA });
    check("nor are its papers reachable — the child is scoped by its parent", foreignPapers.status, 404);

    /*
     * A platform caller is NOT narrowed here, and the assertion says so rather than assuming the
     * finance-report shape: every guard in entitlement.js short-circuits on isPlatform before a
     * snapshot is loaded, and `tenantWhere` gives a Super Admin no scope — so a list answers across
     * schools by design. `/finance/report` differs only because it calls resolveSchool() itself.
     */
    const platformList = await expectOk('/exams?limit=50', { token: platform }, 200);
    const platformNames = dataOf(platformList).map((e) => e.name);
    check('a platform caller sees across schools, which is what platform scope means', platformNames.includes('Midterm 2025') && platformNames.includes('D Midterm'), true);

    /* ── the DATEONLY trap, at a western offset (Known Issues #20) ── */

    const tzBefore = process.env.TZ;
    let westExam = null;
    let westPaper = null;
    try {
      process.env.TZ = 'America/New_York';
      westExam = dataOf(await expectOk('/exams', {
        method: 'POST', token: principalA,
        body: { name: 'TZ probe', exam_type: 'Final', class_id: A.klass.id, start_date: '2025-07-01', end_date: '2025-07-05' },
      }, 201)).exam;
      westPaper = dataOf(await expectOk(`/exams/${westExam.id}/subjects`, {
        method: 'POST', token: principalA,
        body: { subject_id: A.maths.id, full_marks: 10, passing_marks: 4, exam_date: '2025-07-01' },
      }, 201)).subject;
    } finally {
      if (tzBefore === undefined) delete process.env.TZ;
      else process.env.TZ = tzBefore;
    }
    check('start_date survives a west-of-UTC server', westExam.start_date, '2025-07-01');
    check('and end_date — both DATEONLY columns on the row', westExam.end_date, '2025-07-05');
    check('and the paper date on the child table', westPaper.exam_date, '2025-07-01');
    const [rawExam] = await db.sequelize.query(`SELECT start_date, end_date FROM exams WHERE id = ${Number(westExam.id)}`);
    check('and the row on disk holds the same days', [
      String(rawExam[0].start_date).slice(0, 10),
      String(rawExam[0].end_date).slice(0, 10),
    ], ['2025-07-01', '2025-07-05']);

    /*
     * §5a session 19 - the departure case, which is the phantom row's more damaging twin.
     *
     * A child who sat only the first paper and then left keeps a result row scored over that one paper.
     * Before the fix that row was still ranked, could out-score everyone who sat the whole exam and take
     * first place, inflated everyone's `position_out_of`, and was published to their parent.
     */
    const leaver = await db.Student.findOne({ where: { student_id: `${CODE_PREFIX}Amina` } });
    void leaver;
    const halfSitter = await db.Student.create({
      school_id: schoolA.id, organization_id: org.id, student_id: `${CODE_PREFIX}Half`,
      first_name: 'Halfway', admission_date: '2025-04-01', status: STUDENT_STATUS.ACTIVE,
      class_id: A.klass.id, section_id: A.section.id, academic_session_id: A.session.id,
    });
    /* Give them a perfect mark on a fresh exam's first paper, then move them out of the cohort. */
    const drift = dataOf(await expectOk('/exams', {
      method: 'POST', token: principalA,
      body: { name: 'Drift probe', exam_type: 'Final', class_id: A.klass.id, section_id: A.section.id },
    }, 201)).exam;
    const driftP1 = dataOf(await expectOk(`/exams/${drift.id}/subjects`, {
      method: 'POST', token: principalA, body: { subject_id: A.maths.id, full_marks: 100, passing_marks: 40 },
    }, 201)).subject;
    const driftP2 = dataOf(await expectOk(`/exams/${drift.id}/subjects`, {
      method: 'POST', token: principalA, body: { subject_id: A.science.id, full_marks: 100, passing_marks: 40 },
    }, 201)).subject;
    /* The class also holds the latecomer created above, so the cohort is kids + newcomer + halfSitter. */
    const driftCohort = [...kids, newcomer, halfSitter];
    await expectOk('/exams/marks', {
      method: 'POST', token: teacher,
      body: { exam_subject_id: driftP1.id, entries: driftCohort.map((k) => ({ student_id: k.id, marks_obtained: k.id === halfSitter.id ? 100 : 50 })) },
    }, 200);
    await expectOk('/exams/marks/submit', { method: 'POST', token: teacher, body: { exam_subject_id: driftP1.id } }, 200);
    /* Out of the cohort — status untouched, exactly what students.promote() does. */
    await halfSitter.update({ class_id: null, section_id: null });
    await expectOk('/exams/marks', {
      method: 'POST', token: teacher,
      body: { exam_subject_id: driftP2.id, entries: [...kids, newcomer].map((k) => ({ student_id: k.id, marks_obtained: 50 })) },
    }, 200);
    await expectOk('/exams/marks/submit', { method: 'POST', token: teacher, body: { exam_subject_id: driftP2.id } }, 200);
    const driftSummary = dataOf(await expectOk(`/exams/${drift.id}/results`, { method: 'POST', token: principalA, body: {} }, 200)).summary;
    check('only the students who sat every paper are ranked', driftSummary.ranked, 6);
    check('  and the one who sat half is counted as unranked, not dropped silently', driftSummary.unranked, 1);
    const driftRows = dataOf(await expectOk(`/exams/${drift.id}/results?limit=50`, { token: principalA }, 200));
    const half = driftRows.find((r) => r.student_id === halfSitter.id);
    check('  the half-sitter keeps their record — it is what was marked', Boolean(half), true);
    check('  scored over the one paper they sat', [Number(half.total_full_marks), half.subjects_count], [100, 1]);
    check('  but carries no position, so they cannot out-rank a full sitter', [half.position, half.position_out_of], [null, null]);
    check('  and the merit list puts them at its foot, as the PDF does — not above first place',
      [driftRows[0].position, driftRows[driftRows.length - 1].student_id], [1, halfSitter.id]);
    check(
      '  and everyone else is ranked out of the six who actually sat it',
      [...new Set(driftRows.filter((r) => r.position !== null).map((r) => r.position_out_of))],
      [6]
    );
    const driftPublished = dataOf(await expectOk(`/exams/${drift.id}/publish`, { method: 'POST', token: principalA, body: {} }, 200));
    check('publication releases only the ranked results', driftPublished.published, 6);
    check(
      '  so the half-sitter is never shown a result for an exam they did not finish',
      Boolean((await db.Result.findOne({ where: { exam_id: drift.id, student_id: halfSitter.id } })).is_published),
      false
    );

    /* A published exam is finished: regenerating would rewrite a card a parent has read. */
    const regen = await call(`/exams/${drift.id}/results`, { method: 'POST', token: principalA, body: {} });
    check('a published exam cannot be re-graded', regen.status, 409);
    check('  and its status is not regressed', codeOf(regen), 'EXAM_ALREADY_PUBLISHED');
    check(
      '  the exam is still published',
      dataOf(await expectOk(`/exams/${drift.id}`, { token: principalA }, 200)).exam.status,
      EXAM_STATUS.PUBLISHED
    );

    /*
     * An entry has to say something: a mark, or an absence. Tested on a paper that is still open, so
     * the refusal can only be about the entry - on a submitted paper the 409 would fire first and the
     * assertion would pass for the wrong reason.
     */
    const openExam = dataOf(await expectOk('/exams', {
      method: 'POST', token: principalA,
      body: { name: 'Silent probe', exam_type: 'Final', class_id: A.klass.id },
    }, 201)).exam;
    const openPaper = dataOf(await expectOk(`/exams/${openExam.id}/subjects`, {
      method: 'POST', token: principalA, body: { subject_id: A.maths.id, full_marks: 10, passing_marks: 4 },
    }, 201)).subject;
    const silentEntry = await call('/exams/marks', {
      method: 'POST', token: teacher,
      body: { exam_subject_id: openPaper.id, entries: [{ student_id: amina.id }] },
    });
    check('an entry with neither a mark nor an absence is refused', silentEntry.status, 422);
    const absentEntry = await expectOk('/exams/marks', {
      method: 'POST', token: teacher,
      body: { exam_subject_id: openPaper.id, entries: [{ student_id: amina.id, is_absent: true }] },
    }, 200);
    check('  while a recorded absence is accepted — it is a positive statement', dataOf(absentEntry).marks[0].is_absent, true);

    /* ── the trail ── */

    const activity = await settleDistinct(
      () => db.ActivityLog.findAll({
        where: {
          id: { [db.Op.gt]: baseline.activityLog },
          entity_type: { [db.Op.in]: ['exam', 'exam_subject', 'grade', 'mark', 'result'] },
        },
        order: [['id', 'ASC']],
      }),
      'entity_type',
      5
    );
    const examActivity = activity.filter((r) => ['exam', 'exam_subject', 'grade', 'mark', 'result'].includes(r.entity_type));
    check('every exam operation is in the activity trail', examActivity.length > 0, true);
    check(
      'all five entity types appear',
      [...new Set(examActivity.map((r) => r.entity_type))].sort(),
      ['exam', 'exam_subject', 'grade', 'mark', 'result']
    );

    const audits = await settleDistinct(
      () => db.AuditLog.findAll({
        where: { id: { [db.Op.gt]: baseline.auditLog }, table_name: { [db.Op.in]: ['exams', 'exam_subjects', 'grades'] } },
      }),
      'table_name',
      3
    );
    check(
      'the definition tables are audited per row',
      [...new Set(audits.map((r) => r.table_name))].sort(),
      ['exam_subjects', 'exams', 'grades']
    );
    /*
     * `marks` deliberately has no per-row audit: a whole class's paper would duplicate `entered_by`
     * and `submitted_by`, which the row already carries, at two hundred times the volume — the reason
     * attendance gives for the same decision.
     */
    await quiesce();
    const markAudits = await db.AuditLog.findAll({
      where: { id: { [db.Op.gt]: baseline.auditLog }, table_name: 'marks' },
    });
    check('and marks are not — the row carries its own enterer and submitter', markAudits.length, 0);
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-exams Part 3 teardown failed:', err);
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
    console.error('\nverify-exams crashed:', err);
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
          ? 'All pure exam checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All exam checks passed (Parts 1–3).'
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
