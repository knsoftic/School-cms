'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *
 *   RATE_LIMIT_MAX       raised past what this script needs; the limiter is not under test here.
 *   AUTH_RATE_LIMIT_MAX  a stray refusal must not colour a run that is almost entirely authenticated.
 *   BCRYPT_ROUNDS=10     fixtures hash one password; pinned so the value never comes from the local .env.
 *   PASSWORD_MIN_LENGTH  pinned for the same reason.
 *   MAIL_DRIVER=log      no mail is sent, but a stray SMTP attempt would hang the run.
 *   CACHE_TTL=600        house style; this suite reads no entitlement cache.
 */
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.BCRYPT_ROUNDS = '10';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';
process.env.CACHE_TTL = '600';

/**
 * Verification of Phase 3.I school setup — `src/modules/{settings,sessions,classes,subjects}/*`
 * and `src/utils/schoolScope.js`.
 *
 * Covers SRS §14 and FR-SCHOOL-001 … FR-SCHOOL-004:
 *   settings (GET does not insert; PATCH upserts), sessions (create / activate / close, no DELETE),
 *   classes and sections (class teachers, refuse delete while students exist), subjects with
 *   class assignment and teacher assignment (MySQL NULL-unique trap handled in the service).
 *
 * Part 1 — request schemas, directly (no database).
 * Part 2 — the declared route tables: `GET /sessions/current` before `GET /:id`, and
 *          `requirePlatformScope()` / `platformGuard` absent on every write.
 * Part 3 — over real HTTP against the real database.
 *
 * Run: node scripts/verify-school-setup.js
 */

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');

const settingsRoutes = require('../src/modules/settings/settings.routes');
const sessionRoutes = require('../src/modules/sessions/sessions.routes');
const classRoutes = require('../src/modules/classes/classes.routes');
const subjectRoutes = require('../src/modules/subjects/subjects.routes');

const { schemas: settingsSchemas } = require('../src/modules/settings/settings.validation');
const { schemas: sessionSchemas } = require('../src/modules/sessions/sessions.validation');
const { schemas: classSchemas } = require('../src/modules/classes/classes.validation');
const { schemas: subjectSchemas } = require('../src/modules/subjects/subjects.validation');

/* Called directly, not over HTTP — see the organization-scope block in Part 3. */
const subjectsService = require('../src/modules/subjects/subjects.service');

const { ROLES, USER_STATUS, ACADEMIC_SESSION_STATUS } = require('../src/config/constants');

/* The activity trail lands after the response — see lib/settle.js and Known Issues #25. */
const { settleRows, settleDistinct } = require('./lib/settle');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-school-setup.local';
const PASSWORD = 'Verify@SchoolSetup123';

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

function stackOf(router, method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer ? layer.route.stack.map((s) => s.handle) : null;
}

function named(router, method, path, fnName) {
  const stack = stackOf(router, method, path);
  return stack ? stack.some((fn) => fn.name === fnName) : null;
}

function writeRoutes(router) {
  return router.stack
    .filter((l) => l.route && !l.route.methods.get)
    .map((l) => [Object.keys(l.route.methods)[0], l.route.path]);
}

/* ═══════════════════════════ part 1 — request schemas ═══════════════════════════ */

function verifySchemas() {
  console.log('\n--- part 1 — the request schemas ---');

  const settingsOk = run(settingsSchemas.update, {
    name: 'Display',
    email: 'office@school.test',
    theme: 'navy',
    currency: 'usd',
  });
  check('settings.update(§14.1 fields).ok', settingsOk.ok, true);
  check('settings.update uppercases currency', settingsOk.value.currency, 'USD');
  check('settings.update({}) is refused (min 1)', run(settingsSchemas.update, {}).ok, false);
  check(
    'settings.update(organization_id) is refused',
    run(settingsSchemas.update, { name: 'X', organization_id: 1 }).ok,
    false
  );
  check('settings.update(id) is refused', run(settingsSchemas.update, { name: 'X', id: 9 }).ok, false);

  const sessionOk = run(sessionSchemas.create, {
    name: '2026-2027',
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  check('session.create(name+dates).ok', sessionOk.ok, true);
  check('session.create({}) is refused', run(sessionSchemas.create, {}).ok, false);
  check(
    'session.create(status) is refused (activate/close owned)',
    run(sessionSchemas.create, {
      name: '2026-2027',
      start_date: '2026-04-01',
      end_date: '2027-03-31',
      status: ACADEMIC_SESSION_STATUS.ACTIVE,
    }).ok,
    false
  );
  check(
    'session.create(is_current) is refused',
    run(sessionSchemas.create, {
      name: '2026-2027',
      start_date: '2026-04-01',
      end_date: '2027-03-31',
      is_current: true,
    }).ok,
    false
  );
  check(
    'session.update(status) is refused',
    run(sessionSchemas.update, { status: ACADEMIC_SESSION_STATUS.CLOSED }).ok,
    false
  );
  check('session.update({}) is refused (min 1)', run(sessionSchemas.update, {}).ok, false);

  check(
    'class.create(name+session).ok',
    run(classSchemas.create, { name: 'Grade 5', academic_session_id: 1 }).ok,
    true
  );
  check('class.create({}) is refused', run(classSchemas.create, {}).ok, false);
  check(
    'section.create(name).ok',
    run(classSchemas.createSection, { name: 'A' }).ok,
    true
  );
  check(
    'section.create(class_id in body) is refused (path-owned)',
    run(classSchemas.createSection, { name: 'A', class_id: 1 }).ok,
    false
  );

  const subjectOk = run(subjectSchemas.create, { name: 'Mathematics', code: 'math' });
  check('subject.create(name+code).ok', subjectOk.ok, true);
  check('subject.create uppercases code', subjectOk.value.code, 'MATH');
  check('subject.create(type: lab) is refused', run(subjectSchemas.create, { name: 'X', code: 'X', type: 'lab' }).ok, false);
  check(
    'class-assign(class_id).ok',
    run(subjectSchemas.assignClass, { class_id: 1, section_id: null }).ok,
    true
  );
  check('class-assign({}) is refused', run(subjectSchemas.assignClass, {}).ok, false);
  check(
    'teacher-assign(teacher_id).ok',
    run(subjectSchemas.assignTeacher, { teacher_id: 1 }).ok,
    true
  );
}

/* ═══════════════════════════ part 2 — the declared surface ═══════════════════════════ */

function verifyRouting() {
  console.log('\n--- part 2 — the declared surface ---');

  check('settings route table', routesOf(settingsRoutes), ['GET /', 'PATCH /']);

  const sessionTable = routesOf(sessionRoutes);
  check('sessions route table (current before :id, no DELETE)', sessionTable, [
    'GET /',
    'GET /current',
    'POST /',
    'GET /:id',
    'PATCH /:id',
    'POST /:id/activate',
    'POST /:id/close',
  ]);
  check(
    'GET /sessions/current is declared before GET /:id',
    sessionTable.indexOf('GET /current') < sessionTable.indexOf('GET /:id'),
    true
  );
  check('sessions has no DELETE', sessionTable.some((r) => r.startsWith('DELETE ')), false);

  check('classes route table', routesOf(classRoutes), [
    'GET /',
    'POST /',
    'GET /:id/sections',
    'POST /:id/sections',
    'PATCH /:id/sections/:sectionId',
    'DELETE /:id/sections/:sectionId',
    'GET /:id',
    'PATCH /:id',
    'DELETE /:id',
  ]);

  check('subjects route table', routesOf(subjectRoutes), [
    'GET /',
    'POST /',
    'GET /:id/classes',
    'POST /:id/classes',
    'DELETE /:id/classes/:assignmentId',
    'GET /:id/teachers',
    'POST /:id/teachers',
    'DELETE /:id/teachers/:assignmentId',
    'GET /:id',
    'PATCH /:id',
    'DELETE /:id',
  ]);

  const routers = [
    ['settings', settingsRoutes],
    ['sessions', sessionRoutes],
    ['classes', classRoutes],
    ['subjects', subjectRoutes],
  ];
  for (const [name, router] of routers) {
    for (const [method, path] of writeRoutes(router)) {
      check(
        `${name}: NO platformGuard on ${method.toUpperCase()} ${path}`,
        named(router, method, path, 'platformGuard'),
        false
      );
    }
  }
}

/* ═══════════════════════════ part 3 — over HTTP ═══════════════════════════ */

async function verifyHttp() {
  console.log('\n--- part 3 — school setup over HTTP ---');

  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  const created = {
    users: [],
    schools: [],
    organizations: [],
    teachers: [],
    students: [],
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

    const leftoverOrgs = await db.Organization.findAll({
      where: { code: { [db.Op.like]: 'VSS-%' } },
      attributes: ['id'],
      paranoid: false,
    });
    const leftoverSchools = await db.School.findAll({
      where: {
        [db.Op.or]: [
          { code: { [db.Op.like]: 'VSS-%' } },
          ...(leftoverOrgs.length ? [{ organization_id: leftoverOrgs.map((row) => row.id) }] : []),
        ],
      },
      attributes: ['id'],
      paranoid: false,
    });
    const schoolIds = [...new Set([...created.schools, ...leftoverSchools.map((row) => row.id)])];

    if (schoolIds.length) {
      await db.TeacherSubject.destroy({ where: { school_id: schoolIds } });
      await db.ClassSubject.destroy({ where: { school_id: schoolIds } });
      await db.Student.destroy({ where: { school_id: schoolIds }, force: true });
      await db.Section.destroy({ where: { school_id: schoolIds } });
      await db.Class.destroy({ where: { school_id: schoolIds } });
      await db.Subject.destroy({ where: { school_id: schoolIds } });
      await db.AcademicSession.destroy({ where: { school_id: schoolIds } });
      await db.SchoolSetting.destroy({ where: { school_id: schoolIds } });
      await db.Teacher.destroy({ where: { school_id: schoolIds }, force: true });
    }

    await db.User.destroy({
      where: {
        [db.Op.or]: [
          { email: { [db.Op.like]: `%@${DOMAIN}` } },
          ...(created.users.length ? [{ id: created.users }] : []),
        ],
      },
      force: true,
    });
    if (schoolIds.length) {
      await db.School.destroy({ where: { id: schoolIds }, force: true });
    }
    await db.Organization.destroy({
      where: {
        [db.Op.or]: [
          { code: { [db.Op.like]: 'VSS-%' } },
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
    const residueCleared = await sweepResidue(db, { codes: ['VSS-'], domains: ['verify-school-setup.local'] });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({
      name: 'Verify School Setup Org',
      code: 'VSS-ORG',
    });
    created.organizations.push(org.id);

    const schoolA = await db.School.create({
      organization_id: org.id,
      name: 'Verify School Setup A',
      code: 'VSS-A',
    });
    const schoolB = await db.School.create({
      organization_id: org.id,
      name: 'Verify School Setup B',
      code: 'VSS-B',
    });
    created.schools.push(schoolA.id, schoolB.id);

    const password_hash = await hashPassword(PASSWORD);
    const people = [
      ['platform', ROLES.SUPER_ADMIN, 'Verify SS Platform', 'vss_platform', null, null],
      ['principal-a', ROLES.PRINCIPAL, 'Verify SS Principal A', 'vss_principal_a', org.id, schoolA.id],
      ['principal-b', ROLES.PRINCIPAL, 'Verify SS Principal B', 'vss_principal_b', org.id, schoolB.id],
      ['teacher', ROLES.TEACHER, 'Verify SS Teacher', 'vss_teacher', org.id, schoolA.id],
    ];
    for (const [key, slug, name, username, organization_id, school_id] of people) {
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

    const teacherRow = await db.Teacher.create({
      school_id: schoolA.id,
      organization_id: org.id,
      employee_id: 'VSS-T1',
      first_name: 'Verify',
      last_name: 'Teacher',
      joining_date: '2024-01-15',
    });
    created.teachers.push(teacherRow.id);

    async function signIn(identifier) {
      const res = await call('/auth/login', { method: 'POST', body: { identifier, password: PASSWORD } });
      const token = res.body && res.body.data ? res.body.data.accessToken : null;
      if (!token) throw new Error(`sign-in failed for ${identifier}: ${res.raw}`);
      return token;
    }

    const platform = await signIn(`platform@${DOMAIN}`);
    const principalA = await signIn(`principal-a@${DOMAIN}`);
    const principalB = await signIn(`principal-b@${DOMAIN}`);
    const teacher = await signIn(`teacher@${DOMAIN}`);
    check('the platform admin signs in', typeof platform, 'string');
    check('principal A signs in', typeof principalA, 'string');
    check('principal B signs in', typeof principalB, 'string');
    check('the teacher signs in', typeof teacher, 'string');

    /* ── FR-SCHOOL-001 settings ── */
    const missingSchool = await call('/school-settings', { token: platform });
    check('platform GET settings without school_id is 422', missingSchool.status, 422);

    const virtual = await expectOk('/school-settings', { token: principalA }, 200);
    const virtualRow = dataOf(virtual).settings;
    check('GET settings before PATCH does not persist a row', virtualRow.id, null);
    check('GET settings virtual name is schools.name', virtualRow.name, 'Verify School Setup A');
    check('GET settings virtual theme default', virtualRow.theme, 'default');
    check('GET settings virtual currency default', virtualRow.currency, 'USD');

    const persistedCount = await db.SchoolSetting.count({ where: { school_id: schoolA.id } });
    check('GET did not insert school_settings', persistedCount, 0);

    const saved = await expectOk(
      '/school-settings',
      {
        method: 'PATCH',
        token: principalA,
        body: {
          name: 'Campus Display Name',
          email: 'office@verify-school-setup.local',
          theme: 'navy',
          currency: 'pkr',
          timezone: 'Asia/Karachi',
          /* An absolute http(s) URL — Known Issues #26 made a filesystem path unstorable here. */
          logo_path: 'https://cdn.verify-school-setup.local/vss-logo.png',
        },
      },
      200
    );
    const settings = dataOf(saved).settings;
    check('PATCH settings persists a row', typeof settings.id, 'number');

    check('PATCH settings display name', settings.name, 'Campus Display Name');
    check('PATCH settings theme is a free string (not an invented enum)', settings.theme, 'navy');
    check('PATCH settings uppercases currency', settings.currency, 'PKR');
    check('PATCH settings timezone', settings.timezone, 'Asia/Karachi');

    const schoolStill = await db.School.findByPk(schoolA.id);
    check('schools.name is not overwritten by settings.name', schoolStill.name, 'Verify School Setup A');

    /*
     * A second PATCH — the update half of the upsert.
     *
     * The first PATCH inserted the row, so until this was added the `row.set()/save()` branch of
     * `settings.update()` and its `event: 'update'` audit were both unreached: one PATCH exercises
     * only the create path.
     */
    const resaved = await expectOk(
      '/school-settings',
      { method: 'PATCH', token: principalA, body: { timezone: 'Asia/Dubai' } },
      200
    );
    check('the second PATCH updates rather than inserting', dataOf(resaved).settings.id, settings.id);
    check('PATCH settings applies the new timezone', dataOf(resaved).settings.timezone, 'Asia/Dubai');
    check(
      'a field the second PATCH omitted is left alone',
      dataOf(resaved).settings.name,
      'Campus Display Name'
    );

    /* ═══ Known Issues #26 — the branding fields are URLs, and are normalised ═══ */

    check('§14.1\'s Logo is stored as the absolute URL it was given',
      settings.logo_path, 'https://cdn.verify-school-setup.local/vss-logo.png');

    const traversal = await call('/school-settings', {
      method: 'PATCH', token: principalA, body: { logo_path: '../../../etc/passwd' },
    });
    check('a filesystem path is refused, not stored', traversal.status, 422);
    check('  naming the field', traversal.body.error.details[0].field, 'logo_path');
    const rooted = await call('/school-settings', {
      method: 'PATCH', token: principalA, body: { favicon_path: '/uploads/favicon.ico' },
    });
    check('  and so is an app-relative path, which nothing in this application could serve anyway',
      rooted.status, 422);
    /*
     * `ftp://`, not `javascript:`. A deliberate regression showed that deleting the schema's scheme
     * check left a `javascript:` assertion passing anyway — `sanitize.js:48` strips that scheme before
     * the schema ever sees it, so the assertion was proving the sanitiser rather than this rule. FTP is
     * a scheme the sanitiser does not touch, so only the scheme check can refuse it.
     */
    const scheme = await call('/school-settings', {
      method: 'PATCH', token: principalA, body: { logo_path: 'ftp://cdn.verify-school-setup.local/logo.png' },
    });
    check('  and a scheme other than http(s), which only this rule can refuse', scheme.status, 422);
    const scripted = await call('/school-settings', {
      method: 'PATCH', token: principalA, body: { logo_path: 'javascript:alert(1)' },
    });
    check('  with the XSS sanitiser refusing a javascript: URL independently, ahead of it',
      scripted.status, 422);

    /*
     * The important one: a URL that PARSES but whose path would escape the uploads root if anything
     * ever joined it. `Joi.uri({scheme})` accepts this — measured — so the rule normalises through
     * `new URL()` instead, and stores the collapsed href. A pattern guard would either miss the
     * percent-encoded form or reject a legitimate `logo..png`; both were measured before choosing.
     */
    const normalised = dataOf(
      await expectOk('/school-settings', {
        method: 'PATCH', token: principalA,
        body: { logo_path: 'https://cdn.verify-school-setup.local/../../../etc/passwd' },
      }, 200)
    ).settings;
    check('a URL whose path climbs out is stored collapsed, not as given',
      normalised.logo_path, 'https://cdn.verify-school-setup.local/etc/passwd');
    const encoded = dataOf(
      await expectOk('/school-settings', {
        method: 'PATCH', token: principalA,
        body: { favicon_path: 'https://cdn.verify-school-setup.local/%2e%2e/%2e%2e/favicon.ico' },
      }, 200)
    ).settings;
    check('  and a percent-encoded climb is decoded and collapsed the same way',
      encoded.favicon_path, 'https://cdn.verify-school-setup.local/favicon.ico');
    const dotted = dataOf(
      await expectOk('/school-settings', {
        method: 'PATCH', token: principalA,
        body: { logo_path: 'https://cdn.verify-school-setup.local/logo..png' },
      }, 200)
    ).settings;
    check('  while a filename that merely contains two dots is left alone — no false positive',
      dotted.logo_path, 'https://cdn.verify-school-setup.local/logo..png');
    const cleared = dataOf(
      await expectOk('/school-settings', {
        method: 'PATCH', token: principalA, body: { logo_path: null },
      }, 200)
    ).settings;
    check('  and a school may still clear its logo', cleared.logo_path, null);
    check(
      'still exactly one settings row for the school',
      await db.SchoolSetting.count({ where: { school_id: schoolA.id } }),
      1
    );

    const crossSettings = await call('/school-settings', {
      method: 'PATCH',
      token: principalA,
      body: { school_id: schoolB.id, name: 'Hijack' },
    });
    check('principal A cannot patch school B', crossSettings.status, 403);
    check('cross-school settings is refused by enforceTenant (layer 3)', codeOf(crossSettings), 'CROSS_TENANT_ACCESS_DENIED');

    const platformGet = await expectOk(`/school-settings?school_id=${schoolA.id}`, { token: platform }, 200);
    check('platform GET settings with school_id', dataOf(platformGet).settings.name, 'Campus Display Name');

    /* ── FR-SCHOOL-002 sessions ── */
    const noCurrent = await call('/sessions/current', { token: principalA });
    check('GET /current before activate is 404', noCurrent.status, 404);
    check('GET /current code', codeOf(noCurrent), 'SESSION_NOT_CURRENT');

    const sessionARes = await expectOk(
      '/sessions',
      {
        method: 'POST',
        token: principalA,
        body: { name: '2025-2026', start_date: '2025-04-01', end_date: '2026-03-31' },
      },
      201
    );
    const sessionA = dataOf(sessionARes).session;
    check('created session status is upcoming', sessionA.status, ACADEMIC_SESSION_STATUS.UPCOMING);
    check('created session is not current', sessionA.is_current, false);

    const dupSession = await call('/sessions', {
      method: 'POST',
      token: principalA,
      body: { name: '2025-2026', start_date: '2025-04-01', end_date: '2026-03-31' },
    });
    check('duplicate session name is 409', dupSession.status, 409);
    check('duplicate session code', codeOf(dupSession), 'SESSION_NAME_TAKEN');

    const refuseStatus = await call(`/sessions/${sessionA.id}`, {
      method: 'PATCH',
      token: principalA,
      body: { status: ACADEMIC_SESSION_STATUS.ACTIVE },
    });
    check('PATCH status is 422 (activate owns it)', refuseStatus.status, 422);

    await expectOk(`/sessions/${sessionA.id}/activate`, { method: 'POST', token: principalA, body: {} }, 200);
    const activatedA = await expectOk(`/sessions/${sessionA.id}`, { token: principalA }, 200);
    check('activated session status', dataOf(activatedA).session.status, ACADEMIC_SESSION_STATUS.ACTIVE);
    check('activated session is_current', dataOf(activatedA).session.is_current, true);

    const currentA = await expectOk('/sessions/current', { token: principalA }, 200);
    check('GET /current returns the activated session', dataOf(currentA).session.id, sessionA.id);

    const sessionBRes = await expectOk(
      '/sessions',
      {
        method: 'POST',
        token: principalA,
        body: { name: '2026-2027', start_date: '2026-04-01', end_date: '2027-03-31' },
      },
      201
    );
    const sessionB = dataOf(sessionBRes).session;
    await expectOk(`/sessions/${sessionB.id}/activate`, { method: 'POST', token: principalA, body: {} }, 200);

    const afterB = await expectOk(`/sessions/${sessionA.id}`, { token: principalA }, 200);
    check('activating B does not auto-close A', dataOf(afterB).session.status, ACADEMIC_SESSION_STATUS.ACTIVE);
    check('activating B clears is_current on A', dataOf(afterB).session.is_current, false);
    const currentB = await expectOk('/sessions/current', { token: principalA }, 200);
    check('GET /current now returns B', dataOf(currentB).session.id, sessionB.id);

    await expectOk(`/sessions/${sessionB.id}/close`, { method: 'POST', token: principalA, body: {} }, 200);
    const closedB = await expectOk(`/sessions/${sessionB.id}`, { token: principalA }, 200);
    check('closed session status', dataOf(closedB).session.status, ACADEMIC_SESSION_STATUS.CLOSED);
    check('closed session is not current', dataOf(closedB).session.is_current, false);

    const noneCurrent = await call('/sessions/current', { token: principalA });
    check('school may have no current session after close', noneCurrent.status, 404);

    const reactivateClosed = await call(`/sessions/${sessionB.id}/activate`, {
      method: 'POST',
      token: principalA,
      body: {},
    });
    check('activate of a closed session is 409', reactivateClosed.status, 409);
    check('activate closed code', codeOf(reactivateClosed), 'SESSION_CLOSED');

    const patchClosed = await call(`/sessions/${sessionB.id}`, {
      method: 'PATCH',
      token: principalA,
      body: { name: 'renamed' },
    });
    check('PATCH of a closed session is 409', patchClosed.status, 409);

    /*
     * D20 — and the closed year takes nothing new. A session's status used to change nothing outside
     * this module: a closed session still took new classes, admissions, exams and fee structures.
     * Checked on the class here, and on the other three creates, which call the same guard.
     */
    const classInClosed = await call('/classes', {
      method: 'POST', token: principalA, body: { academic_session_id: sessionB.id, name: 'Closed-year Grade 1' },
    });
    check('D20 — a new class cannot be added to a closed session',
      [classInClosed.status, codeOf(classInClosed), await db.Class.count({ where: { name: 'Closed-year Grade 1' } })],
      [409, 'SESSION_CLOSED', 0]);
    const classInOpen = await call('/classes', {
      method: 'POST', token: principalA, body: { academic_session_id: sessionA.id, name: 'Open-year Grade 9' },
    });
    check('  while the open session beside it still takes one', classInOpen.status, 201);
    if (classInOpen.status === 201) {
      /* Nor by the other door: made in the open year, then patched into the closed one. */
      const patchedIn = await call(`/classes/${dataOf(classInOpen).class.id}`, {
        method: 'PATCH', token: principalA, body: { academic_session_id: sessionB.id },
      });
      check('  and a class cannot be moved into a closed session by PATCH either',
        [patchedIn.status, codeOf(patchedIn)], [409, 'SESSION_CLOSED']);
      const renamed = await call(`/classes/${dataOf(classInOpen).class.id}`, {
        method: 'PATCH', token: principalA, body: { name: 'Open-year Grade 9 renamed', academic_session_id: sessionA.id },
      });
      check('  while a PATCH that leaves it in its own session still applies', renamed.status, 200);
      await db.Class.destroy({ where: { id: dataOf(classInOpen).class.id } });
    }

    const upcomingRes = await expectOk(
      '/sessions',
      {
        method: 'POST',
        token: principalA,
        body: { name: '2027-2028', start_date: '2027-04-01', end_date: '2028-03-31' },
      },
      201
    );
    const upcoming = dataOf(upcomingRes).session;
    check('a third session can be created as upcoming', upcoming.status, ACADEMIC_SESSION_STATUS.UPCOMING);

    const otherSchool = await call(`/sessions/${sessionA.id}`, { token: principalB });
    check('principal B cannot read school A session', otherSchool.status, 404);

    /* GET /sessions — the list route, which nothing above reaches. */
    const sessionList = await expectOk('/sessions', { token: principalA }, 200);
    check(
      'GET /sessions lists this school only',
      dataOf(sessionList).every((row) => Number(row.school_id) === schoolA.id),
      true
    );
    check(
      'GET /sessions returns the three sessions created',
      dataOf(sessionList).length,
      3
    );
    const filtered = await expectOk(
      `/sessions?status=${ACADEMIC_SESSION_STATUS.UPCOMING}`,
      { token: principalA },
      200
    );
    check(
      'GET /sessions honours the status filter',
      dataOf(filtered).every((row) => row.status === ACADEMIC_SESSION_STATUS.UPCOMING),
      true
    );
    const listFromB = await expectOk('/sessions', { token: principalB }, 200);
    check('principal B sees none of school A sessions', dataOf(listFromB).length, 0);

    /*
     * A DATEONLY column written from a server west of UTC.
     *
     * `validate()` runs Joi with `convert: true`, so `Joi.date().iso()` turns "2029-04-01" into a
     * Date at UTC midnight; Sequelize's DATEONLY._stringify then formats that instant with
     * `moment(date).format('YYYY-MM-DD')`, which is LOCAL. This machine runs at UTC+5, where the
     * correct and the buggy path agree — so an assertion that merely checked the stored value would
     * pass either way, which is the trap §8 keeps recording. Node applies a runtime
     * `process.env.TZ` change immediately, so the offset is flipped to America/New_York for exactly
     * this one request and restored in the `finally`. Under the pre-fix code this stored 2029-03-31.
     */
    const tzBefore = process.env.TZ;
    let westSession = null;
    try {
      process.env.TZ = 'America/New_York';
      const westRes = await expectOk(
        '/sessions',
        {
          method: 'POST',
          token: principalA,
          body: { name: '2029-2030', start_date: '2029-04-01', end_date: '2030-03-31' },
        },
        201
      );
      westSession = dataOf(westRes).session;
    } finally {
      if (tzBefore === undefined) delete process.env.TZ;
      else process.env.TZ = tzBefore;
    }

    check('a DATEONLY start_date survives a west-of-UTC server', westSession && westSession.start_date, '2029-04-01');
    check('a DATEONLY end_date survives a west-of-UTC server', westSession && westSession.end_date, '2030-03-31');

    /* Read it straight out of MariaDB too, rather than trusting the response the same process built. */
    const [westRows] = await db.sequelize.query(
      `SELECT DATE_FORMAT(start_date, '%Y-%m-%d') AS s, DATE_FORMAT(end_date, '%Y-%m-%d') AS e
         FROM academic_sessions WHERE id = ${Number(westSession.id)}`
    );
    check('the stored column itself holds the date that was sent', [westRows[0].s, westRows[0].e], [
      '2029-04-01',
      '2030-03-31',
    ]);

    /* ── FR-SCHOOL-003 classes / sections ── */
    const classOnUpcoming = await expectOk(
      '/classes',
      {
        method: 'POST',
        token: principalA,
        body: { name: 'Grade 6', academic_session_id: upcoming.id, numeric_order: 6 },
      },
      201
    );
    check('class may be created on an upcoming session', dataOf(classOnUpcoming).class.academic_session_id, upcoming.id);

    const classRes = await expectOk(
      '/classes',
      {
        method: 'POST',
        token: principalA,
        body: {
          name: 'Grade 5',
          academic_session_id: sessionA.id,
          numeric_order: 5,
          class_teacher_id: teacherRow.id,
        },
      },
      201
    );
    const klass = dataOf(classRes).class;
    check('class teacher is stored', klass.class_teacher_id, teacherRow.id);

    const dupClass = await call('/classes', {
      method: 'POST',
      token: principalA,
      body: { name: 'Grade 5', academic_session_id: sessionA.id },
    });
    check('duplicate class name in the same session is 409', dupClass.status, 409);
    check('duplicate class code', codeOf(dupClass), 'CLASS_NAME_TAKEN');

    const sectionRes = await expectOk(
      `/classes/${klass.id}/sections`,
      { method: 'POST', token: principalA, body: { name: 'A', class_teacher_id: teacherRow.id } },
      201
    );
    const section = dataOf(sectionRes).section;
    check('section name', section.name, 'A');
    check('section class_teacher_id', section.class_teacher_id, teacherRow.id);

    /* PATCH /classes/:id, GET /classes/:id/sections and PATCH a section — three declared routes
       that Part 2 asserts the shape of but nothing above ever requests. */
    const classPatch = await expectOk(
      `/classes/${klass.id}`,
      { method: 'PATCH', token: principalA, body: { numeric_order: 55, description: 'Renamed order' } },
      200
    );
    check('PATCH /classes/:id applies the change', dataOf(classPatch).class.numeric_order, 55);
    check('PATCH /classes/:id leaves the name alone', dataOf(classPatch).class.name, 'Grade 5');

    const sectionList = await expectOk(`/classes/${klass.id}/sections`, { token: principalA }, 200);
    check('GET /classes/:id/sections returns the section', dataOf(sectionList).sections.length, 1);
    check(
      'GET /classes/:id/sections is scoped to the class',
      dataOf(sectionList).sections.every((row) => Number(row.class_id) === klass.id),
      true
    );

    const sectionPatch = await expectOk(
      `/classes/${klass.id}/sections/${section.id}`,
      { method: 'PATCH', token: principalA, body: { room: 'Room 12', capacity: 30 } },
      200
    );
    check('PATCH section applies the change', dataOf(sectionPatch).section.room, 'Room 12');
    check('PATCH section keeps its class', Number(dataOf(sectionPatch).section.class_id), klass.id);

    const crossSectionPatch = await call(`/classes/${klass.id}/sections/${section.id}`, {
      method: 'PATCH',
      token: principalB,
      body: { room: 'Hijack' },
    });
    check('principal B cannot patch school A section', crossSectionPatch.status, 404);

    const teacherPost = await call('/classes', {
      method: 'POST',
      token: teacher,
      body: { name: 'Grade 7', academic_session_id: sessionA.id },
    });
    check('teacher cannot POST classes', teacherPost.status, 403);
    check('teacher POST code', codeOf(teacherPost), 'INSUFFICIENT_PERMISSION');

    const teacherGet = await expectOk('/classes', { token: teacher }, 200);
    check('teacher can GET classes', Array.isArray(dataOf(teacherGet)), true);
    check('teacher GET sees Grade 5', dataOf(teacherGet).some((row) => row.name === 'Grade 5'), true);

    /* ── FR-SCHOOL-004 subjects ── */
    const subjectRes = await expectOk(
      '/subjects',
      { method: 'POST', token: principalA, body: { name: 'Mathematics', code: 'math', type: 'theory' } },
      201
    );
    const subject = dataOf(subjectRes).subject;
    check('subject code is uppercased', subject.code, 'MATH');

    const dupSubject = await call('/subjects', {
      method: 'POST',
      token: principalA,
      body: { name: 'Maths', code: 'MATH' },
    });
    check('duplicate subject code is 409', dupSubject.status, 409);
    check('duplicate subject code name', codeOf(dupSubject), 'SUBJECT_CODE_TAKEN');

    const assignRes = await expectOk(
      `/subjects/${subject.id}/classes`,
      {
        method: 'POST',
        token: principalA,
        body: { class_id: klass.id, teacher_id: teacherRow.id, full_marks: 100, passing_marks: 40 },
      },
      201
    );
    const assignment = dataOf(assignRes).assignment;
    check('class-subject section_id is null (whole class)', assignment.section_id, null);
    check('class-subject teacher_id', assignment.teacher_id, teacherRow.id);

    /* GET /subjects/:id/classes and PATCH /subjects/:id — the last two declared routes that
       nothing above requests over HTTP. */
    const classAssignments = await expectOk(`/subjects/${subject.id}/classes`, { token: principalA }, 200);
    check('GET /subjects/:id/classes returns the assignment', dataOf(classAssignments).assignments.length, 1);
    check(
      'the assignment carries its class through the include',
      dataOf(classAssignments).assignments[0].class.id,
      klass.id
    );
    check(
      'a whole-class assignment reports no section',
      dataOf(classAssignments).assignments[0].section,
      null
    );

    /*
     * A class's curriculum in one read (D30's pickers): Mathematics for the whole class, Art for one
     * section only, and Music on no curriculum at all.
     */
    const art = dataOf(await expectOk('/subjects', { method: 'POST', token: principalA, body: { name: 'Art', code: 'ART' } }, 201)).subject;
    await expectOk('/subjects', { method: 'POST', token: principalA, body: { name: 'Music', code: 'MUSIC' } }, 201);
    const artAssignment = dataOf(await expectOk(`/subjects/${art.id}/classes`, {
      method: 'POST', token: principalA, body: { class_id: klass.id, section_id: section.id },
    }, 201)).assignment;
    const curriculumNames = async (qs) =>
      dataOf(await expectOk(`/subjects?${qs}&limit=100`, { token: teacher }, 200)).map((s) => s.code).sort();
    check('GET /subjects?class_id= reads the class\'s curriculum — the whole-class subjects only',
      await curriculumNames(`class_id=${klass.id}`), ['MATH']);
    check('  and with a section, that section\'s subjects beside them — never a subject on no curriculum',
      await curriculumNames(`class_id=${klass.id}&section_id=${section.id}`), ['ART', 'MATH']);
    check('  a section named without its class is refused',
      (await call(`/subjects?section_id=${section.id}`, { token: teacher })).status, 422);
    /* Removed again: the section is deleted further down, and a curriculum row would hold it. */
    await expectOk(`/subjects/${art.id}/classes/${artAssignment.id}`, { method: 'DELETE', token: principalA }, 204);

    const subjectPatch = await expectOk(
      `/subjects/${subject.id}`,
      { method: 'PATCH', token: principalA, body: { name: 'Mathematics (Core)', is_elective: true } },
      200
    );
    check('PATCH /subjects/:id applies the change', dataOf(subjectPatch).subject.name, 'Mathematics (Core)');
    check('PATCH /subjects/:id flips is_elective', dataOf(subjectPatch).subject.is_elective, true);
    check('PATCH /subjects/:id leaves the code alone', dataOf(subjectPatch).subject.code, 'MATH');

    const dupAssign = await call(`/subjects/${subject.id}/classes`, {
      method: 'POST',
      token: principalA,
      body: { class_id: klass.id },
    });
    check('duplicate whole-class assignment is 409 (NULL unique trap)', dupAssign.status, 409);
    check('duplicate assignment code', codeOf(dupAssign), 'CLASS_SUBJECT_TAKEN');

    const teachersList = await expectOk(`/subjects/${subject.id}/teachers`, { token: principalA }, 200);
    check(
      'assigning teacher_id on class-subject upserts teacher_subjects',
      dataOf(teachersList).assignments.some((row) => row.teacher_id === teacherRow.id && row.class_id === klass.id),
      true
    );

    const teacherAssign = await expectOk(
      `/subjects/${subject.id}/teachers`,
      { method: 'POST', token: principalA, body: { teacher_id: teacherRow.id } },
      201
    );
    check('qualification assignment (no class) is allowed', dataOf(teacherAssign).assignment.class_id, null);

    const teacherGetSubjects = await expectOk('/subjects', { token: teacher }, 200);
    check('teacher can GET subjects', dataOf(teacherGetSubjects).some((row) => row.code === 'MATH'), true);

    const teacherPostSubject = await call('/subjects', {
      method: 'POST',
      token: teacher,
      body: { name: 'Physics', code: 'PHY' },
    });
    check('teacher cannot POST subjects', teacherPostSubject.status, 403);

    /*
     * An organization-scoped caller reading the two assignment tables.
     *
     * `class_subjects` and `teacher_subjects` are the only tables this module touches that carry
     * `school_id` without `organization_id`. `tenantWhere()` is model-agnostic and writes
     * `organization_id` for a tenant that has an organization but no school, so these four queries
     * used to die with `Unknown column 'ClassSubject.organization_id' in 'where clause'` — a 500.
     *
     * It is asserted here against the service rather than over HTTP because no seeded role both
     * resolves to an organization-without-school tenant and holds `subjects.view`: the branch is
     * unreachable through the default grants, which is exactly why 111 green checks never touched
     * it. Role grants are database-driven and editable through `PUT /roles/:id/permissions`, so the
     * branch is one grant away from being live.
     */
    const orgScopedReq = {
      tenant: { organizationId: org.id, schoolId: null, isPlatform: false },
      query: {},
      body: {},
      user: null,
    };

    let orgClassAssignments = null;
    let orgScopeError = null;
    try {
      orgClassAssignments = await subjectsService.listClassAssignments(orgScopedReq, subject.id);
    } catch (err) {
      orgScopeError = err.name === 'SequelizeDatabaseError' ? err.parent.sqlMessage : err.message;
    }
    check('organization-scoped read of class_subjects does not raise', orgScopeError, null);
    check(
      'organization-scoped read of class_subjects returns the school row',
      orgClassAssignments ? orgClassAssignments.rows.length : null,
      1
    );

    let orgTeacherError = null;
    try {
      await subjectsService.listTeacherAssignments(orgScopedReq, subject.id);
    } catch (err) {
      orgTeacherError = err.name === 'SequelizeDatabaseError' ? err.parent.sqlMessage : err.message;
    }
    check('organization-scoped read of teacher_subjects does not raise', orgTeacherError, null);

    /* DELETE class while a student is enrolled */
    const student = await db.Student.create({
      school_id: schoolA.id,
      organization_id: org.id,
      student_id: 'VSS-STU-1',
      first_name: 'Verify',
      admission_date: '2025-04-01',
      admission_session_id: sessionA.id,
      academic_session_id: sessionA.id,
      class_id: klass.id,
      section_id: section.id,
    });
    created.students.push(student.id);

    const blockedClass = await call(`/classes/${klass.id}`, { method: 'DELETE', token: principalA });
    check('DELETE class with students is 409', blockedClass.status, 409);
    check('DELETE class code', codeOf(blockedClass), 'CLASS_HAS_STUDENTS');

    const blockedSection = await call(`/classes/${klass.id}/sections/${section.id}`, {
      method: 'DELETE',
      token: principalA,
    });
    check('DELETE section with students is 409', blockedSection.status, 409);
    check('DELETE section code', codeOf(blockedSection), 'SECTION_HAS_STUDENTS');

    await db.Student.destroy({ where: { id: student.id }, force: true });
    created.students = [];

    await expectOk(`/classes/${klass.id}/sections/${section.id}`, { method: 'DELETE', token: principalA }, 204);

    /*
     * DELETE a class whose CASCADE dependants still exist.
     *
     * Before the guard added in session 16, this returned 204 and MariaDB removed the
     * `class_subjects` row and the auto-upserted `teacher_subjects` row along with it — below the
     * application, so `audit_logs` recorded only the class. The module audits both of those rows
     * when they are removed through `unassignClass` / `unassignTeacher`, so the cascade was a
     * silent, unaudited loss of rows the module itself treats as audit-worthy. This fixture is what
     * exposed it: the assignments created earlier in the run were still attached.
     */
    const blockedByDeps = await call(`/classes/${klass.id}`, { method: 'DELETE', token: principalA });
    check('DELETE class with cascade dependants is 409', blockedByDeps.status, 409);
    check('DELETE class dependants code', codeOf(blockedByDeps), 'CLASS_IN_USE');
    check(
      'CLASS_IN_USE names the blocking tables',
      Object.keys(blockedByDeps.body.error.details.blocking).sort(),
      ['class_subjects', 'teacher_subjects']
    );

    /* Removing them explicitly is the supported path, and each of these IS audited. */
    await expectOk(
      `/subjects/${subject.id}/classes/${assignment.id}`,
      { method: 'DELETE', token: principalA },
      204
    );
    const linkedTeachers = await expectOk(`/subjects/${subject.id}/teachers`, { token: principalA }, 200);
    const classLink = dataOf(linkedTeachers).assignments.find((row) => row.class_id === klass.id);
    check('the teacher link upserted by the class assignment survives its removal', Boolean(classLink), true);
    await expectOk(
      `/subjects/${subject.id}/teachers/${classLink.id}`,
      { method: 'DELETE', token: principalA },
      204
    );

    await expectOk(`/classes/${klass.id}`, { method: 'DELETE', token: principalA }, 204);

    const gone = await call(`/classes/${klass.id}`, { token: principalA });
    check('deleted class is 404', gone.status, 404);

    const emptyClassId = dataOf(classOnUpcoming).class.id;
    await expectOk(`/classes/${emptyClassId}`, { method: 'DELETE', token: principalA }, 204);

    /*
     * DELETE a subject that is still assigned.
     *
     * `class_subjects.subject_id`, `teacher_subjects.subject_id` and `exam_subjects.subject_id` are
     * all `ON DELETE CASCADE`, and `marks.exam_subject_id` cascades in turn — so before the guard
     * added in session 16 this deleted every mark ever recorded against the subject, at the
     * database layer, with a 204 and a single `subjects` audit row. The exams module does not exist
     * yet, so only the assignment half is reachable today; the marks half is latent until §17.
     * The qualification assignment created earlier (class_id NULL) is what blocks it here.
     */
    const qualificationId = dataOf(teacherAssign).assignment.id;
    const blockedSubject = await call(`/subjects/${subject.id}`, { method: 'DELETE', token: principalA });
    check('DELETE subject with assignments is 409', blockedSubject.status, 409);
    check('DELETE subject code', codeOf(blockedSubject), 'SUBJECT_IN_USE');
    check(
      'SUBJECT_IN_USE names the blocking table',
      Object.keys(blockedSubject.body.error.details.blocking),
      ['teacher_subjects']
    );

    await expectOk(
      `/subjects/${subject.id}/teachers/${qualificationId}`,
      { method: 'DELETE', token: principalA },
      204
    );
    await expectOk(`/subjects/${subject.id}`, { method: 'DELETE', token: principalA }, 204);

    const subjectGone = await call(`/subjects/${subject.id}`, { token: principalA });
    check('deleted subject is 404', subjectGone.status, 404);

    /*
     * The audit and activity trail.
     *
     * Nothing above this block asserted it, so all nineteen `recordAudit()` calls and eighteen
     * `logActivity()` declarations in the four modules were unverified — the suite could not tell
     * a module that audits from one that does not. The rows are read back as **model instances**,
     * never `raw: true`: under `raw` MariaDB hands back `changed_fields` as a JSON *string*, and
     * `.includes('name')` on a string is a substring match that would also pass for `name_2`.
     */
    const audits = await settleDistinct(
      () =>
        db.AuditLog.findAll({
          where: { id: { [db.Op.gt]: baseline.auditLog } },
          order: [['id', 'ASC']],
        }),
      'table_name',
      7
    );

    check(
      'every school-setup table is audited',
      [...new Set(audits.map((r) => r.table_name))].sort(),
      [
        'academic_sessions',
        'class_subjects',
        'classes',
        'school_settings',
        'sections',
        'subjects',
        'teacher_subjects',
      ]
    );
    check('all three audit events are exercised', [...new Set(audits.map((r) => r.event))].sort(), [
      'create',
      'delete',
      'update',
    ]);

    /*
     * The update that changed the timezone, not merely the first settings update in the run. Known
     * Issues #26 added several branding updates ahead of it, and `find(first update)` then returned
     * one of those instead — the assertion was positionally fragile rather than wrong.
     */
    const settingsUpdates = audits.filter((r) => r.table_name === 'school_settings' && r.event === 'update');
    const settingsAudit = settingsUpdates.find(
      (r) => Array.isArray(r.changed_fields) && r.changed_fields.includes('timezone')
    );
    check('every settings write after the insert is audited as an update', settingsUpdates.length > 1, true);
    check('a settings update is audited', Boolean(settingsAudit), true);
    check(
      'changed_fields is a real array, not JSON text',
      Array.isArray(settingsAudit && settingsAudit.changed_fields),
      true
    );
    check(
      'the audited settings change names the column that changed',
      Boolean(settingsAudit && settingsAudit.changed_fields.includes('timezone')),
      true
    );
    check(
      'the audit row carries the acting user',
      Boolean(settingsAudit && settingsAudit.user_id),
      true
    );

    const sessionClose = audits.find(
      (r) => r.table_name === 'academic_sessions' && r.event === 'update' && r.new_values && r.new_values.status === 'closed'
    );
    check('closing a session is audited with before and after', Boolean(sessionClose), true);
    check(
      'the close audit shows the status transition',
      sessionClose ? [sessionClose.old_values.status, sessionClose.new_values.status] : null,
      ['active', 'closed']
    );

    const deleteAudits = audits.filter((r) => r.event === 'delete');
    check(
      'each explicit removal is audited rather than left to the FK cascade',
      [...new Set(deleteAudits.map((r) => r.table_name))].sort(),
      ['class_subjects', 'classes', 'sections', 'subjects', 'teacher_subjects']
    );

    const activity = await settleRows(() =>
      db.ActivityLog.findAll({
        where: { id: { [db.Op.gt]: baseline.activityLog } },
        order: [['id', 'ASC']],
      })
    );
    check('the activity trail is written too', activity.length > 0, true);
    check(
      'activity rows carry the school they happened in',
      activity.every((r) => r.school_id === null || Number(r.school_id) > 0),
      true
    );
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-school-setup Part 3 teardown failed:', err);
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
    console.error('\nverify-school-setup crashed:', err);
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
          ? 'All pure school-setup checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All school-setup checks passed (Parts 1–3).'
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
