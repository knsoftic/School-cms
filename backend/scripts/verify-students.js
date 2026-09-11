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
 * Verification of Phase 3.J students — `src/modules/students/*` — SRS §15.1,
 * FR-STUDENT-001 (admission) and FR-STUDENT-002 (promotion / transfer / leaving).
 *
 * Four things here are worth stating plainly, because each could be mistaken for a defect:
 *
 *  - **Promotion leaves `status` at `active`.** The enum has a `promoted` value and this module never
 *    writes it. Setting it would drop the student out of the `student_limit` headcount, so a school
 *    that promoted its whole cohort would fall to zero used and its ceiling would stop meaning
 *    anything. Asserted in both directions: the status stays `active`, and the usage figure does not
 *    move across a promotion.
 *  - **A receptionist can admit a student but cannot promote, transfer or mark one as left.** That is
 *    the SRS's own split — FR-STUDENT-001 names "Principal / School Admin / Receptionist",
 *    FR-STUDENT-002 names only the first two — and the seeded catalogue already encodes it. Asserted
 *    over HTTP because `students.manage` and `students.progression` would otherwise look
 *    interchangeable.
 *  - **`status` is refused in a request body**, on create and on patch. If it were writable the §11.2
 *    ceiling would sit behind `students.manage` rather than behind `students.progression`.
 *  - **`student_id` is optional**, because FR-STUDENT-001 says the system assigns one. The prefix is
 *    not invented: `schools.code` is documented as "also used as the student-ID prefix"
 *    (src/models/core.js:145), so the generated form is `<school code>-<year>-<sequence>`. An earlier
 *    revision hardcoded `S-`, which made two schools in one organization both issue `S-2025-0001`.
 *
 * Part 1 — request schemas, directly (no database).
 * Part 2 — the declared route table and the router-level guard.
 * Part 3 — over real HTTP against the real database.
 *
 * Run: node scripts/verify-students.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const { settleDistinct } = require('./lib/settle');
const { metaOf } = require('../src/utils/routeMeta');

const studentRoutes = require('../src/modules/students/students.routes');
const { schemas } = require('../src/modules/students/students.validation');
const studentService = require('../src/modules/students/students.service');

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
  UPLOAD_RULES,
} = require('../src/config/constants');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-students.local';
const PASSWORD = 'Verify@Students123';
const CODE_PREFIX = 'VST-';

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

function handlerNames(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  return layer ? layer.route.stack.map((h) => h.handle.name) : [];
}

/**
 * The permission keys a route's guard was built from.
 *
 * Read from `routeMeta`'s annotation rather than from the source text: the guard already publishes
 * them there for the OpenAPI document, so this asserts the same fact the document is generated from,
 * and a route whose guard is missing entirely reads as `null` rather than as an empty list.
 */
function permissionsOf(router, method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) return null;
  for (const handler of layer.route.stack) {
    const meta = metaOf(handler.handle);
    if (meta && meta.permissions) return meta.permissions;
  }
  return null;
}

function named(router, method, path, fnName) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer ? layer.route.stack.some((s) => s.handle.name === fnName) : null;
}

/* ═══════════════════════════ part 1 — request schemas ═══════════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas ──\n');

  /*
   * `class_id` is in every create body below that is meant to be valid apart from one field. Since D4
   * made it required, a body without it is refused for the missing class — so an "X is refused"
   * assertion over such a body would pass whatever the schema did with X.
   */
  const minimal = run(schemas.create, { first_name: 'Amina', admission_date: '2025-04-01', class_id: 1 });
  check('first_name, admission_date and a class are enough to admit', minimal.ok, true);
  check(
    'student_id is optional — FR-STUDENT-001 says the system assigns it',
    minimal.value.student_id,
    undefined
  );

  check('first_name is required', run(schemas.create, { admission_date: '2025-04-01', class_id: 1 }).ok, false);
  check(
    'admission_date is required — the column is NOT NULL',
    run(schemas.create, { first_name: 'Amina', class_id: 1 }).ok,
    false
  );
  /* D4 — "Student is assigned to a Class and Section" (FR-STUDENT-001), so the roll number always has a scope. */
  const classless = schemas.create.validate({ first_name: 'Amina', admission_date: '2025-04-01' }, VALIDATE_OPTIONS);
  check(
    'a class is required — the owner\'s decision D4, and the only thing missing here',
    classless.error ? classless.error.details.map((d) => d.path.join('.')) : [],
    ['class_id']
  );

  /*
   * The lifecycle columns. If `status` were writable, a caller holding `students.manage` could move a
   * student into or out of the active headcount without ever touching `students.progression`, which
   * is where SRS §15's actor split puts that authority.
   */
  for (const field of [
    'status',
    'promoted_at',
    'previous_class_id',
    'transferred_at',
    'transfer_to',
    'left_at',
    'leaving_reason',
  ]) {
    check(
      `${field} is refused on create`,
      run(schemas.create, { first_name: 'A', admission_date: '2025-04-01', class_id: 1, [field]: 'x' }).ok,
      false
    );
    /*
     * The legitimate field is load-bearing. `schemas.update` ends in `.min(1)`, so an object
     * holding only a forbidden key is rejected for being EMPTY after strip — the assertion would
     * pass identically if `lifecycleOwned` were deleted from the update schema. Co-submitting
     * `first_name` keeps the object non-empty, so only `forbidden()` can produce the refusal.
     */
    check(
      `${field} is refused on patch`,
      run(schemas.update, { first_name: 'A', [field]: 'x' }).ok,
      false
    );
  }

  check(
    'organization_id is refused',
    run(schemas.create, { first_name: 'A', admission_date: '2025-04-01', class_id: 1, organization_id: 3 }).ok,
    false
  );

  const stripped = run(schemas.create, {
    first_name: 'A',
    admission_date: '2025-04-01',
    class_id: 1,
    is_superuser: true,
  });
  check('an unknown key is stripped', stripped.ok && stripped.value.is_superuser === undefined, true);

  check(
    'gender is held to the model enum',
    run(schemas.create, { first_name: 'A', admission_date: '2025-04-01', class_id: 1, gender: 'unknown' }).ok,
    false
  );

  /* Widths taken from the model, not chosen — the mistake §5a defect 24 records. */
  check(
    'emergency_contact is bounded at the column width of 40',
    run(schemas.update, { emergency_contact: 'x'.repeat(41) }).ok,
    false
  );
  check('and 40 is accepted', run(schemas.update, { emergency_contact: 'x'.repeat(40) }).ok, true);
  check(
    'guardian_name matches its wider column of 160',
    run(schemas.update, { guardian_name: 'x'.repeat(160) }).ok,
    true
  );
  check(
    'student_id is bounded at 60',
    run(schemas.update, { student_id: 'x'.repeat(61) }).ok,
    false
  );

  check('update requires at least one field', run(schemas.update, {}).ok, false);

  /* FR-STUDENT-002 payloads. */
  check('promote requires the destination class', run(schemas.promote, {}).ok, false);
  check('promote accepts a class', run(schemas.promote, { class_id: 3 }).ok, true);
  check('transfer needs nothing but accepts a destination', run(schemas.transfer, {}).ok, true);
  check('leave needs nothing but accepts a reason', run(schemas.leave, { leaving_reason: 'moved' }).ok, true);
  check(
    'the list filter accepts every model status',
    Object.values(STUDENT_STATUS).every((s) => run(schemas.list, { status: s }).ok),
    true
  );

  check(
    'admission_date reaches the service as a Date, which is why the service normalises it',
    minimal.value.admission_date instanceof Date,
    true
  );

  /* ── Known Issues #26 — photo_path is no longer a caller-supplied string ── */

  check(
    'a body-supplied photo_path is REFUSED, not stripped, on create',
    (() => {
      const r = schemas.create.validate(
        { first_name: 'A', admission_date: '2025-04-01', class_id: 1, photo_path: '../../../etc/passwd' },
        VALIDATE_OPTIONS
      );
      return [Boolean(r.error), r.error ? r.error.details.map((d) => d.path.join('.')) : []];
    })(),
    [true, ['photo_path']]
  );
  /*
   * `first_name` is co-submitted for the reason recorded above the lifecycle loop: `schemas.update`
   * ends in `.min(1)`, so an object holding only a forbidden key is rejected for being EMPTY after
   * strip, and the assertion would pass identically with the `forbidden()` deleted.
   */
  check(
    '  and on update, where only forbidden() can produce the refusal',
    run(schemas.update, { first_name: 'A', photo_path: '/etc/passwd' }).ok,
    false
  );
  check(
    '  including a value that looks harmless — the column is not a body field at all now',
    run(schemas.create, {
      first_name: 'A', admission_date: '2025-04-01', class_id: 1, photo_path: 'photo.png',
    }).ok,
    false
  );
  check(
    'the photo route body takes only the school and a reason — the image is a file, not a field',
    [
      run(schemas.setPhoto, {}).ok,
      run(schemas.setPhoto, { school_id: 1, reason: 'New intake photo' }).ok,
      run(schemas.setPhoto, { photo_path: 'x.png' }).ok,
    ],
    [true, true, false]
  );
  check(
    'and photo_path is gone from the service\'s writable-field list',
    studentService.EDITABLE.includes('photo_path'),
    false
  );
}

/* ═══════════════════════════ part 2 — the route table ═══════════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — declared routes ──\n');

  const routes = routesOf(studentRoutes);
  /*
   * Twelve since the owner's decision D13 gave §15.1's "Documents" its upload, list and download, and
   * thirteen since D17 mounted the self-service read — above `GET /:id`, so the literal is never an id.
   */
  check('the twelve §15.1 routes and the D17 self-service read are declared', routes, [
    'GET /',
    'GET /mine',
    'POST /',
    'POST /:id/photo',
    'GET /:id/photo',
    'POST /:id/documents',
    'GET /:id/documents',
    'GET /:id/documents/:documentId',
    'POST /:id/promote',
    'POST /:id/transfer',
    'POST /:id/leave',
    'GET /:id',
    'PATCH /:id',
  ]);
  check(
    'D13 — a document is uploaded on students.manage and read on students.view, like the photo',
    [
      permissionsOf(studentRoutes, 'post', '/:id/documents'),
      permissionsOf(studentRoutes, 'get', '/:id/documents'),
      permissionsOf(studentRoutes, 'get', '/:id/documents/:documentId'),
    ],
    [['students.manage'], ['students.view'], ['students.view']]
  );

  /*
   * `GET /:id/photo` closes Known Issues #32: `photo_path` had a writer and no reader, so a photo could
   * be stored and never looked at. The two assertions below are about the pair being consistent — the
   * reader takes the *view* permission where the writer takes manage, and the reader carries no upload
   * middleware, which is what would betray a copy-paste of the writer's chain.
   */
  check(
    'the photo reader takes students.view, where its writer takes students.manage',
    [
      permissionsOf(studentRoutes, 'get', '/:id/photo'),
      permissionsOf(studentRoutes, 'post', '/:id/photo'),
    ],
    [['students.view'], ['students.manage']]
  );
  check(
    '  and it is declared above GET /:id, so the literal segment can never be swallowed',
    routes.indexOf('GET /:id/photo') < routes.indexOf('GET /:id'),
    true
  );

  /*
   * `POST /:id/photo` is Known Issues #26's other half. Refusing `photo_path` from the body closes the
   * hole; this route is what keeps FR-STUDENT-001's "System captures Student Photo" implementable, and
   * it is the first caller `UPLOAD_PROFILES.PERSON_PHOTO` has ever had.
   */
  check(
    'the photo route mounts the profile that has cited §15.1 / FR-STUDENT-001 since upload.js was written',
    [
      UPLOAD_PROFILES.PERSON_PHOTO,
      UPLOAD_RULES[UPLOAD_PROFILES.PERSON_PHOTO].srs.includes('FR-STUDENT-001'),
    ],
    ['person_photo', true]
  );
  const studentSrc = fs
    .readFileSync(path.join(__dirname, '../src/modules/students/students.routes.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check('  named in the router rather than a seventh profile being invented',
    /UPLOAD_PROFILES\.PERSON_PHOTO/.test(studentSrc), true);
  check('  and it is the only route in the module that mounts an upload',
    (studentSrc.match(/uploadSingle\(/g) || []).length, 1);
  check(
    '  with the multer chain ahead of validate, so the multipart text fields are visible to it',
    (() => {
      const names = handlerNames(studentRoutes, 'post', '/:id/photo');
      return names.indexOf('multerRunner') > -1 && names.indexOf('multerRunner') < names.indexOf('validateRequest');
    })(),
    true
  );

  check('students has no DELETE — §15.1 names Leaving', routes.some((r) => r.startsWith('DELETE')), false);

  const writes = studentRoutes.stack
    .filter((l) => l.route && !l.route.methods.get)
    .map((l) => [Object.keys(l.route.methods)[0], l.route.path]);
  check('there are seven write routes — the document upload is the seventh (D13)', writes.length, 7);
  check(
    'no write carries requirePlatformScope() — the actor is the school, not the platform',
    writes.every(([m, p]) => named(studentRoutes, m, p, 'platformGuard') === false),
    true
  );
  check(
    'every write carries validate()',
    writes.every(([m, p]) => named(studentRoutes, m, p, 'validateRequest')),
    true
  );
  check(
    'every write declares its activity',
    writes.every(([m, p]) => named(studentRoutes, m, p, 'activityDeclaration')),
    true
  );

  check(
    'one router-level guard, mounted ahead of every route',
    [studentRoutes.stack.filter((l) => !l.route).length, studentRoutes.stack.findIndex((l) => !l.route)],
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

  /* Real bytes are written to disk by the photo assertions; this suite is what collects them. */
  const uploaded = [];

  const created = {
    users: [],
    schools: [],
    organizations: [],
    students: [],
    plans: [],
    subscriptions: [],
  };
  const baseline = {
    activityLog: (await db.ActivityLog.max('id')) || 0,
    auditLog: (await db.AuditLog.max('id')) || 0,
  };

  async function call(path, { method = 'GET', body, token, form } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (form) {
      payload = form; /* fetch sets the multipart boundary itself */
    } else if (body !== undefined) {
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
      where: { subscription_id: subscriptionId, limit_key: LIMITS.STUDENT_LIMIT },
    });
    return row ? Number(row.used_value) : null;
  };

  async function teardown() {
    /*
     * Remove the fixture schools' upload trees wholesale rather than only the paths this run recorded.
     * `uploaded` holds what the ROW ended up pointing at, which is not necessarily what multer wrote —
     * a deliberate regression that made `setPhoto` store a constant left the real file behind, because
     * the suite collected the constant. Removing the directory cannot miss, and it also clears the
     * empty `school-<id>/` shells that every upload-writing suite leaves behind.
     */
    for (const abs of uploaded) {
      try {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch {
        /* best effort */
      }
    }
    for (const schoolId of created.schools) {
      try {
        fs.rmSync(path.join(config.uploads.dir, `school-${schoolId}`), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
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
      await db.Student.destroy({ where: { school_id: created.schools }, force: true });
      await db.Section.destroy({ where: { school_id: created.schools }, force: true });
      await db.Class.destroy({ where: { school_id: created.schools }, force: true });
      await db.AcademicSession.destroy({ where: { school_id: created.schools }, force: true });
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
    for (const slug of [ROLES.SUPER_ADMIN, ROLES.PRINCIPAL, ROLES.RECEPTIONIST, ROLES.TEACHER]) {
      // eslint-disable-next-line no-await-in-loop
      const role = await db.Role.findOne({ where: { slug } });
      if (!role) throw new Error(`seeded role missing: ${slug}`);
      roles[slug] = role;
    }

    /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
    const residueCleared = await sweepResidue(db, { codes: ['VST-'], domains: ['verify-students.local'], uploadsDir: config.uploads.dir });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({ name: 'Verify Students Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Students A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Students B');
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify Students C');
    /* D clears the module guard, so a cross-school 404 is isolation rather than entitlement. */
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Students D');

    const mkPlan = async (code, studentsEnabled, studentLimit) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify Students ${code}`,
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
          is_enabled: key === MODULES.STUDENTS ? studentsEnabled : true,
        });
      }
      await db.PlanLimit.create({
        plan_id: plan.id,
        limit_key: LIMITS.STUDENT_LIMIT,
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: studentLimit,
      });
      /*
       * FR-STUDENT-001's photo needs an upload allowance. `upload.js` treats a Fixed limit with no
       * value as ZERO — "the entitlement chain defaults to deny, and so does this: zero, not
       * 'unlimited by omission'" — so without this row every photo upload would be refused before
       * multer ever ran, and the assertions below would be testing the fixture rather than the code.
       */
      await db.PlanLimit.create({
        plan_id: plan.id,
        limit_key: LIMITS.FILE_UPLOAD_LIMIT,
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: 5,
      });
      /* And storage, which every upload is charged against and which is zero when unconfigured too. */
      await db.PlanLimit.create({
        plan_id: plan.id,
        limit_key: LIMITS.STORAGE_LIMIT,
        limit_type: LIMIT_TYPES.UNLIMITED,
      });
      return plan;
    };

    const withStudents = await mkPlan('WITH', true, 2);
    const withoutStudents = await mkPlan('WITHOUT', false, 50);
    /* School D gets its own roomy plan: the ceiling belongs to school A, and the allocator edge
       cases below need headroom to admit into without tripping it. */
    const roomyStudents = await mkPlan('ROOMY', true, 50);

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

    const subA = await subscribe(schoolA, withStudents);
    await subscribe(schoolB, withoutStudents);
    await subscribe(schoolD, roomyStudents);
    /* schoolC is deliberately left unsubscribed. */

    /* Academic structure for school A — created directly; §14's own suite covers its endpoints. */
    const session = await db.AcademicSession.create({
      school_id: schoolA.id,
      organization_id: org.id,
      name: '2025-2026',
      start_date: '2025-04-01',
      end_date: '2026-03-31',
      status: ACADEMIC_SESSION_STATUS.ACTIVE,
      is_current: true,
    });
    const mkClass = async (name, order) =>
      db.Class.create({
        school_id: schoolA.id,
        organization_id: org.id,
        academic_session_id: session.id,
        name,
        numeric_order: order,
      });
    const grade1 = await mkClass('Grade 1', 1);
    const grade2 = await mkClass('Grade 2', 2);
    const sectionA = await db.Section.create({
      school_id: schoolA.id,
      organization_id: org.id,
      class_id: grade1.id,
      name: 'A',
    });
    /* A section of the *other* class, so "section does not belong to this class" is testable. */
    const sectionB2 = await db.Section.create({
      school_id: schoolA.id,
      organization_id: org.id,
      class_id: grade2.id,
      name: 'B',
    });
    /* School D gets a real little structure of its own: the promotion tests need somewhere to
       move a student TO, and school A is at its ceiling by the time they run. */
    const dClassOne = await db.Class.create({
      school_id: schoolD.id,
      organization_id: org.id,
      academic_session_id: null,
      name: 'D Grade 1',
      numeric_order: 1,
    });
    const dClassTwo = await db.Class.create({
      school_id: schoolD.id,
      organization_id: org.id,
      academic_session_id: null,
      name: 'D Grade 2',
      numeric_order: 2,
    });
    const dSectionOne = await db.Section.create({
      school_id: schoolD.id,
      organization_id: org.id,
      class_id: dClassOne.id,
      name: 'A',
    });

    /* And a class in another school, so a cross-school class_id is testable. */
    const foreignClass = await db.Class.create({
      school_id: schoolD.id,
      organization_id: org.id,
      academic_session_id: null,
      name: 'Foreign',
      numeric_order: 1,
    });

    const password_hash = await hashPassword(PASSWORD);
    const people = [
      ['platform', ROLES.SUPER_ADMIN, 'Verify S Platform', 'vst_platform', null, null],
      ['principal-a', ROLES.PRINCIPAL, 'Verify S Principal A', 'vst_principal_a', org.id, schoolA.id],
      ['principal-b', ROLES.PRINCIPAL, 'Verify S Principal B', 'vst_principal_b', org.id, schoolB.id],
      ['principal-c', ROLES.PRINCIPAL, 'Verify S Principal C', 'vst_principal_c', org.id, schoolC.id],
      ['principal-d', ROLES.PRINCIPAL, 'Verify S Principal D', 'vst_principal_d', org.id, schoolD.id],
      ['reception', ROLES.RECEPTIONIST, 'Verify S Reception', 'vst_reception', org.id, schoolA.id],
      ['teacher', ROLES.TEACHER, 'Verify S Teacher', 'vst_teacher', org.id, schoolA.id],
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
    const reception = await signIn(`reception@${DOMAIN}`);
    const teacher = await signIn(`teacher@${DOMAIN}`);
    check(
      'all seven fixtures sign in',
      [platform, principalA, principalB, principalC, principalD, reception, teacher].every(
        (t) => typeof t === 'string'
      ),
      true
    );

    /* ── the entitlement guard ── */

    const moduleDenied = await call('/students', { token: principalB });
    check('a plan without the Students module refuses', moduleDenied.status, 403);
    check('and names the module', codeOf(moduleDenied), 'MODULE_NOT_SUBSCRIBED');
    check('naming which one', moduleDenied.body.error.details.missing, [MODULES.STUDENTS]);

    const noSub = await call('/students', { token: principalC });
    check('a school with no subscription is refused differently', noSub.status, 402);
    check('state is checked before module', codeOf(noSub), 'SUBSCRIPTION_INACTIVE');

    /* ── FR-STUDENT-001, admission ── */

    const admitted = await expectOk(
      '/students',
      {
        method: 'POST',
        token: principalA,
        body: {
          first_name: 'Amina',
          last_name: 'Yusuf',
          gender: 'female',
          admission_date: '2025-04-10',
          class_id: grade1.id,
          section_id: sectionA.id,
          academic_session_id: session.id,
          guardian_name: 'Yusuf Bello',
        },
      },
      201
    );
    const first = dataOf(admitted).student;
    created.students.push(first.id);
    check('a student is admitted', first.first_name, 'Amina');
    check('status starts active', first.status, STUDENT_STATUS.ACTIVE);
    check(
      'the system assigned a student id, prefixed with the school code',
      first.student_id,
      `${schoolA.code}-2025-0001`
    );
    check('and a roll number', first.roll_number, '1');
    check('admission_date is stored as a plain date', first.admission_date, '2025-04-10');
    check('the school comes from the tenant', Number(first.school_id), schoolA.id);

    /*
     * The negative admissions run here, while school A still has capacity.
     *
     * `enforceLimit` sits after `validate()` but before the controller, so a refusal it raises
     * pre-empts every check the service makes. Run at the ceiling, all four of these came back 403
     * PLAN_LIMIT_EXCEEDED — passing-looking assertions that never reached the code they name. Order
     * matters in a suite whose fixture consumes a plan allowance.
     */
    const explicitId = await call('/students', {
      method: 'POST',
      token: principalA,
      body: { first_name: 'Clash', admission_date: '2025-04-12', class_id: grade1.id, student_id: first.student_id },
    });
    check('a duplicate student id is refused', explicitId.status, 409);
    check('duplicate student id code', codeOf(explicitId), 'STUDENT_ID_TAKEN');

    const statusInBody = await call('/students', {
      method: 'POST',
      token: principalA,
      body: { first_name: 'Sneaky', admission_date: '2025-04-12', class_id: grade1.id, status: STUDENT_STATUS.LEFT },
    });
    check('status may not be set through a body', statusInBody.status, 422);

    const foreign = await call('/students', {
      method: 'POST',
      token: principalA,
      body: { first_name: 'Elsewhere', admission_date: '2025-04-12', class_id: foreignClass.id },
    });
    check('a class from another school is refused', foreign.status, 422);

    const mismatched = await call('/students', {
      method: 'POST',
      token: principalA,
      body: {
        first_name: 'Mismatch',
        admission_date: '2025-04-12',
        class_id: grade1.id,
        section_id: sectionB2.id,
      },
    });
    check('a section of a different class is refused', mismatched.status, 422);

    const orphanSection = await call('/students', {
      method: 'POST',
      token: principalA,
      body: { first_name: 'Orphan', admission_date: '2025-04-12', section_id: sectionA.id },
    });
    /*
     * Refused one step earlier than it used to be: D4 made the class required, so the validator names
     * the missing class before the service's own "a section needs its class" check is reached.
     */
    check(
      'a section with no class is refused — at validation, for the missing class (D4)',
      [
        orphanSection.status,
        ((orphanSection.body && orphanSection.body.error && orphanSection.body.error.details) || []).map((d) => d.field),
      ],
      [422, ['class_id']]
    );

    /* ── the ceiling ── */

    const second = await expectOk(
      '/students',
      {
        method: 'POST',
        token: reception,
        body: {
          first_name: 'Bilal',
          admission_date: '2025-04-11',
          class_id: grade1.id,
          section_id: sectionA.id,
        },
      },
      201
    );
    created.students.push(dataOf(second).student.id);
    check('a receptionist may admit — FR-STUDENT-001 names them', dataOf(second).student.first_name, 'Bilal');
    check(
      'the assigned ids increment per school',
      dataOf(second).student.student_id,
      `${schoolA.code}-2025-0002`
    );
    check('and the roll number follows the class', dataOf(second).student.roll_number, '2');

    check('the headcount was recorded, not just checked', await usedNow(subA.id), 2);

    const third = await call('/students', {
      method: 'POST',
      token: principalA,
      body: { first_name: 'Third', admission_date: '2025-04-13', class_id: grade1.id },
    });
    check('the third admission exceeds a student_limit of 2', third.status, 403);
    check('and it is the limit guard refusing', codeOf(third), 'PLAN_LIMIT_EXCEEDED');

    /* ── FR-STUDENT-002 ── */

    const promoted = await expectOk(
      `/students/${first.id}/promote`,
      { method: 'POST', token: principalA, body: { class_id: grade2.id, section_id: sectionB2.id } },
      200
    );
    const afterPromote = dataOf(promoted).student;
    check('promotion moves the student to the new class', Number(afterPromote.class_id), grade2.id);
    check('and records where they came from', Number(afterPromote.previous_class_id), grade1.id);
    check('and stamps promoted_at', Boolean(afterPromote.promoted_at), true);
    check(
      'but leaves status active — a promoted student is still enrolled',
      afterPromote.status,
      STUDENT_STATUS.ACTIVE
    );
    check('so the headcount does not move across a promotion', await usedNow(subA.id), 2);

    const samePlace = await call(`/students/${first.id}/promote`, {
      method: 'POST',
      token: principalA,
      body: { class_id: grade2.id },
    });
    check('promoting into the class the student is already in is refused', samePlace.status, 422);

    const receptionPromote = await call(`/students/${first.id}/promote`, {
      method: 'POST',
      token: reception,
      body: { class_id: grade1.id },
    });
    check('a receptionist may NOT promote — FR-STUDENT-002 does not name them', receptionPromote.status, 403);
    check('and it is the progression key that is missing', codeOf(receptionPromote), 'INSUFFICIENT_PERMISSION');

    const transferred = await expectOk(
      `/students/${first.id}/transfer`,
      { method: 'POST', token: principalA, body: { transfer_to: 'Riverside Academy' } },
      200
    );
    check('transfer sets the status', dataOf(transferred).student.status, STUDENT_STATUS.TRANSFERRED);
    check('and records the destination', dataOf(transferred).student.transfer_to, 'Riverside Academy');
    check('a transferred student leaves the headcount', await usedNow(subA.id), 1);

    const promoteTransferred = await call(`/students/${first.id}/promote`, {
      method: 'POST',
      token: principalA,
      body: { class_id: grade1.id },
    });
    check('a transferred student cannot be promoted', promoteTransferred.status, 409);
    check('and the refusal names the status', codeOf(promoteTransferred), 'STUDENT_STATUS_INVALID');

    const left = await expectOk(
      `/students/${dataOf(second).student.id}/leave`,
      { method: 'POST', token: principalA, body: { leaving_reason: 'Family relocated' } },
      200
    );
    check('leaving sets the status', dataOf(left).student.status, STUDENT_STATUS.LEFT);
    check('and records the reason', dataOf(left).student.leaving_reason, 'Family relocated');
    check('a departed student leaves the headcount', await usedNow(subA.id), 0);

    /* The allowance really is returned — the freed capacity is usable. */
    const readmitted = await expectOk(
      '/students',
      { method: 'POST', token: principalA, body: { first_name: 'Fresh', admission_date: '2025-05-01', class_id: grade1.id } },
      201
    );
    created.students.push(dataOf(readmitted).student.id);
    check('and the freed allowance is usable', dataOf(readmitted).student.status, STUDENT_STATUS.ACTIVE);

    /* ── the DATEONLY trap, at a western offset (Known Issues #20) ── */

    const tzBefore = process.env.TZ;
    let westStudent = null;
    try {
      process.env.TZ = 'America/New_York';
      const westRes = await expectOk(
        `/students/${dataOf(readmitted).student.id}`,
        { method: 'PATCH', token: principalA, body: { date_of_birth: '2014-07-01' } },
        200
      );
      westStudent = dataOf(westRes).student;
    } finally {
      if (tzBefore === undefined) delete process.env.TZ;
      else process.env.TZ = tzBefore;
    }
    check('date_of_birth survives a west-of-UTC server', westStudent.date_of_birth, '2014-07-01');
    const [westRows] = await db.sequelize.query(
      `SELECT DATE_FORMAT(date_of_birth, '%Y-%m-%d') AS d FROM students WHERE id = ${Number(westStudent.id)}`
    );
    check('and the column itself holds it', westRows[0].d, '2014-07-01');

    /* ── reads, isolation, permissions ── */

    const listA = await expectOk('/students', { token: principalA }, 200);
    check(
      'the list is confined to the caller school',
      dataOf(listA).every((r) => Number(r.school_id) === schoolA.id),
      true
    );
    const activeOnly = await expectOk(`/students?status=${STUDENT_STATUS.ACTIVE}`, { token: principalA }, 200);
    check('the status filter works', dataOf(activeOnly).length, 1);
    const searched = await expectOk('/students?q=Amina', { token: principalA }, 200);
    check('the q filter searches names', dataOf(searched).length, 1);

    /*
     * The two ways a lexicographic `ORDER BY student_id DESC` allocator goes wrong. Both were
     * measured before they were fixed, not imagined — see the comment in `allocateStudentId`.
     * Run in school D, which is on a roomy plan: school A is at its ceiling by now, and at the
     * ceiling every one of these would come back 403 instead of the thing it claims to test.
     */
    /*
     * Every admission names a class (D4). These sequence cases take school D's first class with no
     * section unless they say otherwise: roll numbers are allocated per class *and* section, so they
     * cannot disturb the sectioned student's roll 1 or the second class's, asserted below.
     */
    const mkD = async (body) =>
      expectOk('/students', { method: 'POST', token: principalD, body: { class_id: dClassOne.id, ...body } }, 201);

    const dFirst = await mkD({ first_name: 'DeeOne', admission_date: '2025-04-01' });
    check(
      'school D starts its own sequence under its own code prefix',
      dataOf(dFirst).student.student_id,
      `${schoolD.code}-2025-0001`
    );

    /* A four-digit boundary: '…-9999' sorts ABOVE '…-10000' as a string. */
    await db.Student.update(
      { student_id: `${schoolD.code}-2025-9999` },
      { where: { id: dataOf(dFirst).student.id } }
    );
    const dNext = await mkD({ first_name: 'DeeTwo', admission_date: '2025-04-02' });
    check(
      'the allocator passes the four-digit boundary instead of wedging',
      dataOf(dNext).student.student_id,
      `${schoolD.code}-2025-10000`
    );

    /* And again from five digits, which the string sort would have put below '…-9999'. */
    const dThird = await mkD({ first_name: 'DeeThree', admission_date: '2025-04-03' });
    check(
      'and keeps counting past it',
      dataOf(dThird).student.student_id,
      `${schoolD.code}-2025-10001`
    );

    /* A caller-supplied id in the generated shape but non-numeric — 'A' outranks '9' in ASCII. */
    await mkD({ first_name: 'DeeFour', admission_date: '2025-04-04', student_id: `${schoolD.code}-2025-ABCD` });
    const dAfterJunk = await mkD({ first_name: 'DeeFive', admission_date: '2025-04-05' });
    check(
      'a non-numeric id of the same shape does not reset the sequence',
      dataOf(dAfterJunk).student.student_id,
      `${schoolD.code}-2025-10002`
    );

    /*
     * Promotion with only `class_id` — the body the promote schema declares as sufficient.
     *
     * `resolvePlacement` used to inherit the student's CURRENT section and then validate it against
     * the DESTINATION class. A section belongs to exactly one class, so that check could never pass:
     * every promotion of a sectioned student failed 422 naming `section_id`, a field the caller had
     * not sent. The suite missed it because its one successful promotion always named a section.
     */
    const dSectioned = await mkD({
      first_name: 'DeeSectioned',
      admission_date: '2025-04-06',
      class_id: dClassOne.id,
      section_id: dSectionOne.id,
    });
    check('a sectioned student is admitted with roll 1', dataOf(dSectioned).student.roll_number, '1');

    /* Someone already holding roll 1 in the destination, so a carried-forward number would collide. */
    const dSitting = await mkD({
      first_name: 'DeeSitting',
      admission_date: '2025-04-07',
      class_id: dClassTwo.id,
    });
    check('and the destination class has its own roll 1', dataOf(dSitting).student.roll_number, '1');

    const minimalPromote = await expectOk(
      `/students/${dataOf(dSectioned).student.id}/promote`,
      { method: 'POST', token: principalD, body: { class_id: dClassTwo.id } },
      200
    );
    const promotedMin = dataOf(minimalPromote).student;
    check('promotion works with class_id alone', Number(promotedMin.class_id), dClassTwo.id);
    check('the old section is left behind rather than validated against the new class', promotedMin.section_id, null);
    check(
      'and the roll number is reallocated for the destination, not carried across',
      promotedMin.roll_number,
      '2'
    );

    /*
     * The session follows the class, as the section does not.
     *
     * A class belongs to one academic session and §15.1's promotion is "to a new class/session"
     * (SRS:821). The promote dialog sends no session, and `resolvePlacement` used to keep the student's
     * old one — so a student promoted into next year's class carried last year's session, which fee
     * assignment then stamped on their fee rows and documents printed on their certificates.
     */
    const mkDSession = (name, start, end, current) => db.AcademicSession.create({
      school_id: schoolD.id, organization_id: org.id, name, start_date: start, end_date: end,
      status: ACADEMIC_SESSION_STATUS.ACTIVE, is_current: current,
    });
    const dYearOne = await mkDSession('D 2025-2026', '2025-04-01', '2026-03-31', true);
    const dYearTwo = await mkDSession('D 2026-2027', '2026-04-01', '2027-03-31', false);
    const mkDClass = (name, order, sessionRow) => db.Class.create({
      school_id: schoolD.id, organization_id: org.id, academic_session_id: sessionRow.id, name, numeric_order: order,
    });
    const dYearOneClass = await mkDClass('D Grade 3', 3, dYearOne);
    const dYearTwoClass = await mkDClass('D Grade 4', 4, dYearTwo);

    const dCohort = dataOf(await mkD({
      first_name: 'DeeCohort', admission_date: '2025-04-09', class_id: dYearOneClass.id,
    })).student;
    check('an admission that names no session takes its class\'s session',
      Number(dCohort.academic_session_id), dYearOne.id);
    const nextYear = dataOf(await expectOk(
      `/students/${dCohort.id}/promote`,
      { method: 'POST', token: principalD, body: { class_id: dYearTwoClass.id } },
      200
    )).student;
    check('a promotion into next year\'s class moves the student into next year\'s session',
      Number(nextYear.academic_session_id), dYearTwo.id);
    const namedSession = dataOf(await mkD({
      first_name: 'DeeNamed', admission_date: '2025-04-10', class_id: dYearOneClass.id,
    })).student;
    const keptNamed = dataOf(await expectOk(
      `/students/${namedSession.id}/promote`,
      { method: 'POST', token: principalD, body: { class_id: dYearTwoClass.id, academic_session_id: dYearOne.id } },
      200
    )).student;
    check('  while a session the caller names is the one written',
      Number(keptNamed.academic_session_id), dYearOne.id);

    /*
     * And `PATCH` moves the section and session with the class. It wrote only the keys the body
     * carried, so a student moved into another class kept a section of the old one.
     */
    const dPatched = dataOf(await mkD({
      first_name: 'DeePatched', admission_date: '2025-04-11', class_id: dClassOne.id, section_id: dSectionOne.id,
    })).student;
    const afterPatch = dataOf(await expectOk(
      `/students/${dPatched.id}`,
      { method: 'PATCH', token: principalD, body: { class_id: dYearOneClass.id } },
      200
    )).student;
    check('a PATCH that moves the class leaves the old class\'s section behind and takes the new class\'s session',
      [Number(afterPatch.class_id), afterPatch.section_id, Number(afterPatch.academic_session_id)],
      [dYearOneClass.id, null, dYearOne.id]);

    /* D20 — a closed session takes no new admission, including one whose session came with the class. */
    await dYearTwo.update({ status: ACADEMIC_SESSION_STATUS.CLOSED });
    const intoClosed = await call('/students', {
      method: 'POST', token: principalD,
      body: { first_name: 'DeeClosed', admission_date: '2025-04-12', class_id: dYearTwoClass.id },
    });
    check('D20 — an admission into a class of a closed session is refused',
      [intoClosed.status, codeOf(intoClosed)], [409, 'SESSION_CLOSED']);
    /*
     * Nor by the other doors: admitted to an open year and then moved by PATCH into the closed one, or
     * promoted into it. A rule a two-step walks around is not a rule.
     */
    const movedIn = await call(`/students/${dPatched.id}`, {
      method: 'PATCH', token: principalD, body: { class_id: dYearTwoClass.id },
    });
    const promotedIn = await call(`/students/${dPatched.id}/promote`, {
      method: 'POST', token: principalD, body: { class_id: dYearTwoClass.id },
    });
    check('  nor may a student be moved into it by PATCH, or promoted into it',
      [movedIn.status, codeOf(movedIn), promotedIn.status, codeOf(promotedIn)],
      [409, 'SESSION_CLOSED', 409, 'SESSION_CLOSED']);
    const unmoved = await db.Student.findByPk(dPatched.id);
    check('  and the student stays where they were', Number(unmoved.class_id), dYearOneClass.id);
    await dYearTwo.update({ status: ACADEMIC_SESSION_STATUS.ACTIVE });

    /*
     * The two cross-tenant FKs that were written straight from the body. `academic_session_id` was
     * checked; `admission_session_id` and `user_id` were not, so a school could pin its student to
     * another tenant's session or bind it to another tenant's login.
     */
    const foreignAdmissionSession = await call('/students', {
      method: 'POST',
      token: principalD,
      body: {
        first_name: 'DeeForeignSession',
        admission_date: '2025-04-08',
        class_id: dClassOne.id,
        admission_session_id: session.id,
      },
    });
    check('an admission_session_id from another school is refused', foreignAdmissionSession.status, 422);

    const foreignUser = await call('/students', {
      method: 'POST',
      token: principalD,
      body: { first_name: 'DeeForeignUser', admission_date: '2025-04-08', class_id: dClassOne.id, user_id: userIdOf['reception'] },
    });
    check('a user_id from another school is refused', foreignUser.status, 422);

    /* Link a school-D account to one student first — there is nothing to duplicate otherwise. */
    const linked = await expectOk(
      `/students/${dataOf(dSectioned).student.id}`,
      { method: 'PATCH', token: principalD, body: { user_id: userIdOf['principal-d'] } },
      200
    );
    check('a same-school account links cleanly', Number(dataOf(linked).student.user_id), userIdOf['principal-d']);

    const dupUser = await call(`/students/${dataOf(dSitting).student.id}`, {
      method: 'PATCH',
      token: principalD,
      body: { user_id: userIdOf['principal-d'] },
    });
    check('linking an account already held by another student is refused', dupUser.status, 409);
    check('and names why', codeOf(dupUser), 'STUDENT_USER_TAKEN');

    /* The holder may keep its own link on re-save. */
    const selfLink = await expectOk(
      `/students/${dataOf(dSectioned).student.id}`,
      { method: 'PATCH', token: principalD, body: { user_id: userIdOf['principal-d'] } },
      200
    );
    check(
      'but the student holding it may re-save it',
      Number(dataOf(selfLink).student.user_id),
      userIdOf['principal-d']
    );

    /* status is refused over HTTP on PATCH too, not only in the schema unit check. */
    const patchStatus = await call(`/students/${dataOf(dSitting).student.id}`, {
      method: 'PATCH',
      token: principalD,
      body: { first_name: 'Renamed', status: STUDENT_STATUS.LEFT },
    });
    check('status is refused on a PATCH body, not silently stripped', patchStatus.status, 422);

    const dReadsA = await call(`/students/${first.id}`, { token: principalD });
    check('a principal of another school cannot read this student', dReadsA.status, 404);
    check('and it is isolation refusing, not entitlement', codeOf(dReadsA), 'STUDENT_NOT_FOUND');

    const teacherRead = await expectOk('/students', { token: teacher }, 200);
    check('a teacher may read students', Array.isArray(dataOf(teacherRead)), true);
    const teacherWrite = await call('/students', {
      method: 'POST',
      token: teacher,
      body: { first_name: 'Nope', admission_date: '2025-04-14', class_id: grade1.id },
    });
    check('but may not admit one', teacherWrite.status, 403);

    const platformRead = await call(`/students/${first.id}`, { token: platform });
    check('the platform admin reads any school', platformRead.status, 200);

    /* ── the audit trail ── */

    /* ═══ Known Issues #26 — FR-STUDENT-001's photo, end to end ═══ */

    const photoTarget = dataOf(admitted).student;

    const bodyPath = await call(`/students/${photoTarget.id}`, {
      method: 'PATCH', token: principalA, body: { photo_path: '../../../etc/passwd' },
    });
    check('a body-supplied photo_path is refused over HTTP, not silently ignored', bodyPath.status, 422);
    check('  naming the field', bodyPath.body.error.details[0].field, 'photo_path');
    const bodyPathOnCreate = await call('/students', {
      method: 'POST', token: principalA,
      body: { first_name: 'Pathy', admission_date: '2025-04-10', class_id: grade1.id, photo_path: 'x.png' },
    });
    check('  and on the admission too', bodyPathOnCreate.status, 422);

    /* A real PNG: the 8-byte signature is enough for a stored file, and the profile is images only. */
    const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const form = new FormData();
    form.set('reason', 'Intake photo');
    form.set('photo', new Blob([PNG], { type: 'image/png' }), 'amina.png');
    /*
     * `call` rather than `expectOk` here: this is the marquee assertion, and a regression that breaks
     * the upload should FAIL by name rather than abort the run. §5a session 22 records why — a crash is
     * a detection, but it hides which assertion was meant to catch it.
     */
    const photoRes = await call(`/students/${photoTarget.id}/photo`, { method: 'POST', token: principalA, form });
    check('the photo upload is accepted', photoRes.status, 200);
    const withPhoto = (dataOf(photoRes) || {}).student || {};

    check('FR-STUDENT-001 — the system captures a Student Photo', withPhoto.has_photo, true);
    check('  and the stored path never reaches the caller', 'photo_path' in withPhoto, false);
    const storedRow = await db.Student.findByPk(photoTarget.id);
    check('  while the row really holds one', Boolean(storedRow.photo_path), true);
    check(
      '  tenant-scoped under the school and the profile that cited §15.1',
      new RegExp(`^school-${schoolA.id}/person_photo/`).test(storedRow.photo_path || ''),
      true
    );
    const abs = storedRow.photo_path ? path.join(config.uploads.dir, storedRow.photo_path) : null;
    if (abs) uploaded.push(abs);
    check('  and the bytes are really on disk', Boolean(abs) && fs.existsSync(abs), true);

    /* The suppression, proved against a row that really holds a path — §5a session 22's rule. */
    const rereadPhoto = dataOf(await expectOk(`/students/${photoTarget.id}`, { token: principalA }, 200)).student;
    check('a read by id suppresses the path too, not only the upload response',
      ['photo_path' in rereadPhoto, rereadPhoto.has_photo], [false, true]);
    const listWithPhoto = await expectOk('/students?limit=100', { token: principalA }, 200);
    check('  and so does every row of the list',
      (dataOf(listWithPhoto) || []).every((r) => !('photo_path' in r)), true);
    check('  which is not vacuous — one of those rows has a photo',
      (dataOf(listWithPhoto) || []).some((r) => r.has_photo === true), true);

    const badType = new FormData();
    badType.set('photo', new Blob([Buffer.from('%PDF-1.4\n')], { type: 'application/pdf' }), 'not-a-photo.pdf');
    const rejected = await call(`/students/${photoTarget.id}/photo`, {
      method: 'POST', token: principalA, form: badType,
    });
    check('a non-image is refused — PERSON_PHOTO is an image-only surface', rejected.status, 415);

    const noFile = await call(`/students/${photoTarget.id}/photo`, {
      method: 'POST', token: principalA, body: {},
    });
    check('a photo request with no file is refused', noFile.status, 422);

    const foreignPhoto = new FormData();
    foreignPhoto.set('photo', new Blob([PNG], { type: 'image/png' }), 'x.png');
    const crossSchoolPhoto = await call(`/students/${dataOf(dSitting).student.id}/photo`, {
      method: 'POST', token: principalA, form: foreignPhoto,
    });
    check("a photo cannot be set on another school's student", crossSchoolPhoto.status, 404);

    const studentPhoto = new FormData();
    studentPhoto.set('photo', new Blob([PNG], { type: 'image/png' }), 'x.png');
    const denied = await call(`/students/${photoTarget.id}/photo`, {
      method: 'POST', token: principalB, form: studentPhoto,
    });
    check('and the module gate still applies to it', denied.status, 403);

    /* ═══ Known Issues #32 — the photo can now be looked at ═══ */

    /*
     * Fetched with a bare `fetch` rather than through `call`, which reads the response as text: the
     * whole point of these assertions is the **bytes**, and comparing a decoded string would pass for
     * a body that is not the file. The upload above sent `PNG`; this reads the same eight-byte
     * signature back and compares buffers.
     */
    const photoUrl = `${base}/students/${photoTarget.id}/photo`;
    const served = await fetch(photoUrl, { headers: { Authorization: `Bearer ${principalA}` } });
    const servedBytes = Buffer.from(await served.arrayBuffer());
    check('FR-STUDENT-001 — a stored photo can be read back', served.status, 200);
    check('  and the bytes are the ones that were uploaded',
      servedBytes.equals(PNG), true);
    check('  served as the image it is, not as a download',
      [served.headers.get('content-type'), served.headers.get('content-disposition')],
      ['image/png', `inline; filename="student-photo-${photoTarget.student_id}"`]);
    /*
     * The filename carries the school's own `student_id`, not the primary key. Asserted because it is
     * the kind of detail a later edit would "simplify" to `:id`, which hands a caller a number that is
     * not theirs and means nothing to the school.
     */
    check('  named by the school’s student id rather than the primary key',
      (served.headers.get('content-disposition') || '').includes(String(photoTarget.id))
        && String(photoTarget.id) !== String(photoTarget.student_id),
      false);
    check('  and a stored file is never cacheable by a shared proxy',
      [served.headers.get('cache-control'), served.headers.get('x-content-type-options')],
      ['private, no-store', 'nosniff']);

    /*
     * The three refusals, each a different rule. Without them a route that returned somebody's photo
     * for any id would pass every assertion above.
     */
    const unphotographed = await expectOk(
      '/students',
      {
        method: 'POST',
        token: principalA,
        body: { first_name: 'Unphotographed', last_name: 'Probe', admission_date: '2025-04-11', class_id: grade1.id },
      },
      201
    );
    created.students.push(dataOf(unphotographed).student.id);
    const noPhotoYet = await call(`/students/${dataOf(unphotographed).student.id}/photo`, { token: principalA });
    check('a student with no photo is a 404, not an empty 200', noPhotoYet.status, 404);
    /*
     * The cross-school read needs a student in another school who **has** a photo.
     *
     * Written first against `dSitting`, who has none, and that assertion could not fail: the route
     * answers 404 for a student with no photo whatever the tenancy rule says, so replacing the
     * tenant-scoped finder with a bare `findByPk` left it green. Proved by exactly that regression.
     */
    const dPhotoForm = new FormData();
    dPhotoForm.set('photo', new Blob([PNG], { type: 'image/png' }), 'dee.png');
    await expectOk(`/students/${dataOf(dSitting).student.id}/photo`, {
      method: 'POST', token: principalD, form: dPhotoForm,
    }, 200);
    const crossSchoolRead = await call(`/students/${dataOf(dSitting).student.id}/photo`, { token: principalA });
    check("another school's student photo is not readable", crossSchoolRead.status, 404);
    const ownSchoolRead = await call(`/students/${dataOf(dSitting).student.id}/photo`, { token: principalD });
    check('  which is not vacuous — the same photo is readable by its own school', ownSchoolRead.status, 200);
    const deniedRead = await call(`/students/${photoTarget.id}/photo`, { token: principalB });
    check('and the module gate applies to the reader as well as the writer', deniedRead.status, 403);

    /* ═══ FR-STUDENT-001's "Documents" — the owner's decision D13, settling triage finding 16 ═══ */

    const docsUrl = `/students/${photoTarget.id}/documents`;
    const docForm = new FormData();
    docForm.set('title', 'Birth certificate');
    docForm.append('documents', new Blob([PNG], { type: 'image/png' }), 'front.png');
    docForm.append('documents', new Blob([PNG], { type: 'image/png' }), 'back.png');
    const docUpload = await call(docsUrl, { method: 'POST', token: principalA, form: docForm });
    const uploadedDocs = docUpload.status === 201 ? dataOf(docUpload).documents : [];
    check('D13 — documents can be attached to a student, several at once, titled from the one title',
      [docUpload.status, uploadedDocs.map((d) => d.title)],
      [201, ['Birth certificate — front.png', 'Birth certificate — back.png']]);
    check('  stored as uploads on this student, not as one of §20.5’s generated types',
      uploadedDocs.map((d) => [d.is_generated, d.document_type, d.owner_type, Number(d.owner_id)]),
      [[false, null, 'student', photoTarget.id], [false, null, 'student', photoTarget.id]]);
    check('  and the stored path never leaves the server', uploadedDocs.some((d) => 'file_path' in d), false);

    const emptyUpload = await call(docsUrl, { method: 'POST', token: principalA, form: new FormData() });
    check('  an upload with no file is refused, naming the field',
      [emptyUpload.status,
        ((emptyUpload.body && emptyUpload.body.error && emptyUpload.body.error.details) || []).map((d) => d.field)],
      [422, ['documents']]);

    const teacherForm = new FormData();
    teacherForm.append('documents', new Blob([PNG], { type: 'image/png' }), 'teacher.png');
    const teacherUpload = await call(docsUrl, { method: 'POST', token: teacher, form: teacherForm });
    check('  a teacher, who may read students but not manage them, cannot attach one', teacherUpload.status, 403);

    const listed = await call(docsUrl, { token: teacher });
    check('  but can list them — reading a student’s document is viewing the student, newest first',
      [listed.status, (listed.status === 200 ? dataOf(listed).documents : []).map((d) => d.file_name)],
      [200, ['back.png', 'front.png']]);

    const firstDoc = uploadedDocs[0] || { id: 0 };
    const docResponse = await fetch(`${base}${docsUrl}/${firstDoc.id}`, {
      headers: { Authorization: `Bearer ${teacher}` },
    });
    const docBytes = Buffer.from(await docResponse.arrayBuffer());
    check('  and download one — the uploaded bytes, as an attachment under its own name',
      [docResponse.status, docBytes.equals(PNG), docResponse.headers.get('content-disposition')],
      [200, true, 'attachment; filename="front.png"']);

    const underOtherStudent = await call(
      `/students/${dataOf(unphotographed).student.id}/documents/${firstDoc.id}`,
      { token: principalA }
    );
    check('  a document is found only under the student it belongs to', underOtherStudent.status, 404);
    const crossSchoolDocs = await call(docsUrl, { token: principalD });
    check('  and another school cannot list them', crossSchoolDocs.status, 404);

    const audits = await settleDistinct(
      () => db.AuditLog.findAll({
        where: { id: { [db.Op.gt]: baseline.auditLog }, table_name: 'students' },
        order: [['id', 'ASC']],
      }),
      'event',
      2
    );
    check('student writes are audited', audits.length > 0, true);
    check('both events are exercised', [...new Set(audits.map((r) => r.event))].sort(), ['create', 'update']);

    const transferAudit = audits.find(
      (r) => r.new_values && r.new_values.status === STUDENT_STATUS.TRANSFERRED
    );
    check('the transfer is audited with before and after', Boolean(transferAudit), true);
    check(
      'showing the status transition',
      transferAudit ? [transferAudit.old_values.status, transferAudit.new_values.status] : null,
      [STUDENT_STATUS.ACTIVE, STUDENT_STATUS.TRANSFERRED]
    );
    check(
      'changed_fields is a real array, not JSON text',
      Array.isArray(transferAudit && transferAudit.changed_fields),
      true
    );
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-students Part 3 teardown failed:', err);
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
    console.error('\nverify-students crashed:', err);
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
          ? 'All pure student checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All student checks passed (Parts 1–3).'
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
