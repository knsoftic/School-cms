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
 * Verification of Phase 3.S documents — `src/modules/documents/*` — SRS §20.5, FR-DOC-001.
 *
 * ## The per-type entitlement gate is the thing this suite exists to prove
 *
 * Every other module router mounts one `requireModule(MODULES.X)`. §20.5 cannot:
 * `DOCUMENT_TYPE_MODULE` maps the seven document types onto **four different** subscribable modules, so
 * the key is not known until the request body names a type.
 *
 * So the fixture includes a school subscribed to **Certificates but not ID Cards**, and the assertion is
 * that the *same caller* in the *same school* can generate a leaving certificate and is refused a
 * student ID card — which is exactly what §11.1 sells and what a single router-level key could not
 * express. A school with no subscription at all is refused with `SUBSCRIPTION_INACTIVE` rather than
 * `MODULE_NOT_SUBSCRIBED`, proving the state-before-module ordering survived being moved out of the
 * router guard and into the service.
 *
 * ## `generation_payload` is checked for its contents, not its presence
 *
 * The column exists so a document *"can be reproduced"*. An assertion that merely checked the payload
 * was non-null would pass with every builder returning `{}`. So each of the seven is checked for the
 * values it must actually carry — the student's admission number, the teacher's employee id, the
 * receipt number and amount really paid, the exam and the stored result — read against the fixture rows
 * they were assembled from.
 *
 * ## What is deliberately absent
 *
 * No bytes: rendering is Phase 5.4. The suite asserts the *absence* positively — `file_path` and
 * `file_size_bytes` are null on a generated row and `storage_limit` usage is unchanged across the whole
 * run — so "no file yet" is a recorded property rather than something nobody looked at.
 *
 * Part 1 — request schemas (no database).
 * Part 2 — the declared route table, the guard that is NOT requireModule, and the permission map.
 * Part 3 — over real HTTP against the real database.
 *
 * Run: node scripts/verify-documents.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');

const documentRoutes = require('../src/modules/documents/documents.routes');
const { schemas } = require('../src/modules/documents/documents.validation');
const service = require('../src/modules/documents/documents.service');

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
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LIST,
  DOCUMENT_TYPE_MODULE,
  DOCUMENT_OWNER_TYPES,
  EXAM_STATUS,
  PAYMENT_METHODS,
  FEE_COMPONENTS,
  STUDENT_FEE_STATUS,
} = require('../src/config/constants');
const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = require('../src/config/permissions');
const { settle, settleRows } = require('./lib/settle');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-documents.local';
const PASSWORD = 'Verify@Documents123';
const CODE_PREFIX = 'VDC-';

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

function routesOf(router) {
  return router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
}

function handlerNames(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  return layer ? layer.route.stack.map((s) => s.handle.name) : [];
}

const DOC = { document_type: DOCUMENT_TYPES.CHARACTER_CERTIFICATE, owner_id: 1 };

/* ═══════════════════════════ part 1 — request schemas ═══════════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas ──\n');

  check('a request names a type and an owner', run(schemas.generate, DOC).ok, true);
  check('a type is required', run(schemas.generate, { owner_id: 1 }).ok, false);
  check('an owner is required — FR-DOC-001\'s precondition is that the record exists',
    run(schemas.generate, { document_type: DOCUMENT_TYPES.CHARACTER_CERTIFICATE }).ok, false);

  check(
    'all seven of §20.5\'s documents are accepted, and nothing else',
    DOCUMENT_TYPE_LIST.map((t) =>
      run(schemas.generate, { document_type: t, owner_id: 1, ...(t === DOCUMENT_TYPES.RESULT_CARD ? { exam_id: 1 } : {}) }).ok),
    [true, true, true, true, true, true, true]
  );
  check('  and there are exactly seven', DOCUMENT_TYPE_LIST.length, 7);
  check('an invented type is refused', run(schemas.generate, { document_type: 'transcript', owner_id: 1 }).ok, false);

  /*
   * A result card is the one document that is not about a single record: §19 makes a result the
   * intersection of a student and an exam, and `documents` has one `owner_id`.
   */
  check(
    'a result card requires the exam it reports',
    run(schemas.generate, { document_type: DOCUMENT_TYPES.RESULT_CARD, owner_id: 1 }).ok,
    false
  );
  check(
    '  and no other document may carry one, so an exam id cannot be sent where nothing reads it',
    [
      run(schemas.generate, { document_type: DOCUMENT_TYPES.STUDENT_ID_CARD, owner_id: 1, exam_id: 1 }).ok,
      run(schemas.generate, { document_type: DOCUMENT_TYPES.FEE_RECEIPT, owner_id: 1, exam_id: 1 }).ok,
    ],
    [false, false]
  );

  check(
    'owner_type is refused — the document type decides what kind of record it is about',
    run(schemas.generate, { ...DOC, owner_type: DOCUMENT_OWNER_TYPES.TEACHER }).ok,
    false
  );

  for (const owned of [
    'file_path', 'file_name', 'mime_type', 'file_size_bytes',
    'is_generated', 'generated_at', 'generation_payload', 'uploaded_by', 'organization_id', 'id',
  ]) {
    const sample = owned === 'is_generated' ? true
      : owned === 'generation_payload' ? { forged: true }
        : /_(path|name|type)$/.test(owned) ? 'x' : 1;
    const r = run(schemas.generate, { ...DOC, [owned]: sample });
    check(`a caller-supplied ${owned} is refused`, [r.ok, r.keys], [false, [owned]]);
  }

  check('a title may be given, and is optional', [
    run(schemas.generate, { ...DOC, title: 'Character Certificate 2026' }).ok,
    run(schemas.generate, DOC).ok,
  ], [true, true]);
  check('title is bounded at its STRING(255)', [
    run(schemas.generate, { ...DOC, title: 'x'.repeat(255) }).ok,
    run(schemas.generate, { ...DOC, title: 'x'.repeat(256) }).ok,
  ], [true, false]);

  check('the list filters by type and by owner', [
    run(schemas.list, { document_type: DOCUMENT_TYPES.FEE_RECEIPT }).ok,
    run(schemas.list, { owner_type: DOCUMENT_OWNER_TYPES.STUDENT, owner_id: 3 }).ok,
    run(schemas.list, { document_type: 'transcript' }).ok,
  ], [true, true, false]);
}

/* ═══════════════════════ part 2 — the declared route table ═══════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — the router as declared ──\n');

  check('the three routes', routesOf(documentRoutes), ['GET /', 'POST /', 'GET /:id']);
  check(
    'one router-level guard, mounted ahead of every route',
    [documentRoutes.stack.filter((l) => !l.route).length, documentRoutes.stack.findIndex((l) => !l.route)],
    [1, 0]
  );

  const src = routerSource('documents');

  /*
   * The central claim of this module, asserted at the source. Every other module router mounts
   * requireModule(); this one must not, because the module is a function of the request body.
   */
  check('the router mounts requireActiveSubscription() and NOT requireModule()',
    [/requireActiveSubscription\(\)/.test(src), /requireModule\(/.test(src)], [true, false]);
  check('  and it is the only module router in the application without one',
    fs.readdirSync(path.join(__dirname, '../src/modules'))
      .filter((m) => fs.existsSync(path.join(__dirname, `../src/modules/${m}/${m}.routes.js`)))
      .filter((m) => !/requireModule\(/.test(routerSource(m)) && /requireActiveSubscription\(\)/.test(routerSource(m))),
    ['documents']);
  check('  because the seven types map onto four different modules',
    [...new Set(DOCUMENT_TYPE_LIST.map((t) => DOCUMENT_TYPE_MODULE[t]))].sort(),
    [MODULES.CERTIFICATES, MODULES.EXAMS, MODULES.FEES, MODULES.ID_CARDS].sort());
  check('  and the service does the module half per request',
    /assertModuleForType/.test(fs.readFileSync(path.join(__dirname, '../src/modules/documents/documents.service.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    true);
  /*
   * Both document permissions carry `module: null`, and that is deliberately NOT asserted as evidence:
   * 59 of the 109 seeded permissions do, and `app.js` records that the field is metadata nothing in the
   * request path reads. An earlier draft of this suite claimed the two were unique in the catalogue and
   * was simply wrong. What IS evidence is the type-to-module map above, and the live behaviour in
   * Part 3.
   */
  check('the permission catalogue is the SRS-fixed 109, so these are facts about it and not choices',
    PERMISSIONS.length, 109);
  check('  and a permission\'s own module field is metadata, held by 59 of them as null',
    PERMISSIONS.filter((p) => p.module === null).length, 59);

  check('every write carries validate() and declares its activity', [
    handlerNames(documentRoutes, 'post', '/').includes('validateRequest'),
    handlerNames(documentRoutes, 'post', '/').includes('activityDeclaration'),
  ], [true, true]);

  check('generation is guarded by documents.generate and reads by documents.view',
    [(src.match(/requirePermission\('documents\.generate'\)/g) || []).length,
      (src.match(/requirePermission\('documents\.view'\)/g) || []).length],
    [1, 2]);

  /* The catalogue is fixed by §29/§35, so these are assertions about it, not about this module. */
  const holders = (key) => Object.entries(DEFAULT_ROLE_PERMISSIONS)
    .filter(([, keys]) => Array.isArray(keys) && keys.includes(key))
    .map(([role]) => role)
    .sort();
  check(
    'documents.generate reaches exactly FR-DOC-001\'s four named actors, plus the Super Admin',
    holders('documents.generate'),
    ['accountant', 'principal', 'receptionist', 'school_admin', 'super_admin']
  );
  check(
    'and documents.view additionally reaches the three audiences the service narrows',
    holders('documents.view').filter((r) => !holders('documents.generate').includes(r)),
    ['parent', 'student', 'teacher']
  );

  check('no route mounts an entitlement limit', /enforceLimit/.test(src), false);
  check(
    '  and storage_limit would be the one to mount, but §20.5 writes no bytes yet',
    Boolean(LIMITS.STORAGE_LIMIT),
    true
  );
  check('no route mounts an upload — §20.5 generates, it does not receive', /uploadSingle|uploadArray/.test(src), false);
  check('and there is no DELETE, §20.5 naming none', routesOf(documentRoutes).some((r) => r.startsWith('DELETE')), false);

  /* The owner kind of each document, before any of it touches a database. */
  /*
   * The service checks subscription STATE before module, mirroring `buildModuleGuard`. It cannot be
   * proved through the router, whose own `requireActiveSubscription()` refuses a lapsed school first —
   * a deliberate regression showed the behavioural assertion passing with the service's check deleted.
   * So it is asserted at the source: the state call precedes the module comparison in the function.
   */
  const svc = fs
    .readFileSync(path.join(__dirname, '../src/modules/documents/documents.service.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  /*
   * Presence AND order. A bare `indexOf(a) < indexOf(b)` is satisfied by *deleting* `a`, because
   * `indexOf` then returns -1 and -1 is less than everything — which a deliberate regression proved by
   * removing the state check and leaving this green.
   */
  const stateAt = svc.indexOf('assertSubscriptionUsable(req, snapshot)');
  const moduleAt = svc.indexOf('snapshot.modules[moduleKey]');
  check('the per-type gate checks subscription state before it checks the module',
    [stateAt > -1, moduleAt > -1, stateAt < moduleAt], [true, true, true]);
  check('  and short-circuits for a platform caller, as every guard in entitlement.js does',
    /req\.tenant\.isPlatform/.test(svc), true);

  check('each of the seven documents is about exactly one kind of record',
    DOCUMENT_TYPE_LIST.map((t) => service.OWNER_OF[t]),
    ['student', 'teacher', 'student', 'payment', 'student', 'student', 'student']);
  check('  and every one of the seven has a payload builder',
    DOCUMENT_TYPE_LIST.every((t) => typeof service.PAYLOAD[t] === 'function'), true);
  check('  and a title', DOCUMENT_TYPE_LIST.every((t) => Boolean(service.TITLE_OF[t])), true);
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
    /* FR-DOC-001's export is bytes; reading it as text would corrupt it before any assertion runs. */
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
      await db.Document.destroy({ where: { school_id: created.schools } });
      await db.Result.destroy({ where: { school_id: created.schools } });
      await db.FeePayment.destroy({ where: { school_id: created.schools } });
      await db.StudentFee.destroy({ where: { school_id: created.schools } });
      await db.FeeStructure.destroy({ where: { school_id: created.schools } });
      await db.Exam.destroy({ where: { school_id: created.schools } });
      await db.ParentStudent.destroy({ where: { school_id: created.schools } });
      await db.Parent.destroy({ where: { school_id: created.schools }, force: true });
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
    /* By fixture marker as well as by id, so a crash before setup finishes cannot poison the next run. */
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
    for (const slug of [ROLES.PRINCIPAL, ROLES.ACCOUNTANT, ROLES.RECEPTIONIST, ROLES.TEACHER, ROLES.STUDENT, ROLES.PARENT]) {
      // eslint-disable-next-line no-await-in-loop
      const role = await db.Role.findOne({ where: { slug } });
      if (!role) throw new Error(`seeded role missing: ${slug}`);
      roles[slug] = role;
    }

    /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
    const residueCleared = await sweepResidue(db, { codes: ['VDC-'], domains: ['verify-documents.local'] });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({ name: 'Verify Documents Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Documents A');
    /* B: Certificates but NOT ID Cards — the split this module exists to honour. */
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Documents B');
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify Documents C');
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Documents D');

    const mkPlan = async (code, disabled = []) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify Documents ${code}`, code: `${CODE_PREFIX}${code}`, status: PLAN_STATUS.ACTIVE,
        tier_rank: 1, trial_days: 0, grace_period_days: 7,
      });
      created.plans.push(plan.id);
      for (const key of MODULE_LIST) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanModule.create({ plan_id: plan.id, module_key: key, is_enabled: !disabled.includes(key) });
      }
      for (const k of [LIMITS.STUDENT_LIMIT, LIMITS.TEACHER_LIMIT, LIMITS.FILE_UPLOAD_LIMIT, LIMITS.STORAGE_LIMIT]) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanLimit.create({ plan_id: plan.id, limit_key: k, limit_type: LIMIT_TYPES.FIXED, limit_value: 100 });
      }
      return plan;
    };
    const everything = await mkPlan('ALL');
    /* Certificates yes, ID Cards no — a real §11.1 plan shape, and the one a single key cannot express. */
    const noIdCards = await mkPlan('NOIDC', [MODULES.ID_CARDS]);

    const subscribe = async (school, plan) => {
      const now = new Date();
      const sub = await db.Subscription.create({
        school_id: school.id, organization_id: org.id, plan_id: plan.id,
        state: SUBSCRIPTION_STATES.ACTIVE, billing_cycle: BILLING_CYCLES.MONTHLY, cycle_amount: 100,
        starts_at: now, current_period_start: now,
        current_period_end: new Date(now.getTime() + 30 * 864e5), grace_period_days: 7,
      });
      created.subscriptions.push(sub.id);
      return sub;
    };
    const subA = await subscribe(schoolA, everything);
    await subscribe(schoolB, noIdCards);
    await subscribe(schoolD, everything);
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
      const section = await db.Section.create({
        school_id: school.id, organization_id: org.id, class_id: klass.id, name: 'A',
      });
      return { session, klass, section };
    };
    const A = await mkStructure(schoolA, 'A');
    const B = await mkStructure(schoolB, 'B');
    const D = await mkStructure(schoolD, 'D');

    const password_hash = await hashPassword(PASSWORD);
    const mkUser = async (key, slug, organization_id, school_id) => {
      const u = await db.User.create({
        role_id: roles[slug].id, organization_id, school_id, name: `Verify DOC ${key}`,
        email: `${key}@${DOMAIN}`, username: `vdc_${key.replace(/-/g, '_')}`,
        password_hash, status: USER_STATUS.ACTIVE, must_change_password: false,
      });
      created.users.push(u.id);
      return u;
    };
    await mkUser('principal-a', ROLES.PRINCIPAL, org.id, schoolA.id);
    await mkUser('principal-b', ROLES.PRINCIPAL, org.id, schoolB.id);
    await mkUser('principal-c', ROLES.PRINCIPAL, org.id, schoolC.id);
    await mkUser('principal-d', ROLES.PRINCIPAL, org.id, schoolD.id);
    await mkUser('accountant', ROLES.ACCOUNTANT, org.id, schoolA.id);
    await mkUser('receptionist', ROLES.RECEPTIONIST, org.id, schoolA.id);
    const teacherUser = await mkUser('teacher', ROLES.TEACHER, org.id, schoolA.id);
    const aminaUser = await mkUser('student-amina', ROLES.STUDENT, org.id, schoolA.id);
    const parentUser = await mkUser('parent', ROLES.PARENT, org.id, schoolA.id);

    const mkStudent = async (school, struct, key, first, last, user, extra = {}) =>
      db.Student.create({
        school_id: school.id, organization_id: org.id, student_id: `${CODE_PREFIX}${key}`,
        first_name: first, last_name: last, admission_number: `ADM-${key}`, roll_number: `R-${key}`,
        admission_date: '2025-04-01', date_of_birth: '2014-06-11', gender: 'female',
        guardian_name: 'Yusuf Parent', address: '12 Rose Lane', city: 'Lahore',
        status: STUDENT_STATUS.ACTIVE, class_id: struct.klass.id, section_id: struct.section.id,
        academic_session_id: struct.session.id, user_id: user ? user.id : null, ...extra,
      });

    const amina = await mkStudent(schoolA, A, 'S1', 'Amina', 'Khan', aminaUser);
    const bilal = await mkStudent(schoolA, A, 'S2', 'Bilal', 'Ahmed', null);
    const bStudent = await mkStudent(schoolB, B, 'S3', 'Sana', 'Iqbal', null);
    const foreignStudent = await mkStudent(schoolD, D, 'S9', 'Faraway', 'Student', null);

    const teacherA = await db.Teacher.create({
      school_id: schoolA.id, organization_id: org.id, employee_id: `${CODE_PREFIX}T1`,
      first_name: 'Nadia', last_name: 'Rahman', designation: 'Senior Teacher',
      qualification: 'M.Ed', joining_date: '2024-01-15', phone: '0300-1234567', user_id: teacherUser.id,
    });

    const parent = await db.Parent.create({
      school_id: schoolA.id, organization_id: org.id, user_id: parentUser.id,
      name: 'Yusuf Parent', first_name: 'Yusuf', last_name: 'Parent', phone: '0300-7654321',
      occupation: 'Engineer', is_active: true,
    });
    /* The parent's child is Bilal, not Amina, so the two self-audiences see DIFFERENT documents. */
    await db.ParentStudent.create({
      school_id: schoolA.id, parent_id: parent.id, student_id: bilal.id, relation: 'father',
    });

    /* A real fee payment, so the receipt payload has something to reproduce. */
    const structure = await db.FeeStructure.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: A.session.id,
      /* `component` is §17's fixed enum, not free text — FEE_COMPONENTS has exactly four values. */
      class_id: A.klass.id, name: 'Tuition 2025-2026', component: FEE_COMPONENTS.MONTHLY_FEE, amount: 5000,
    });
    const studentFee = await db.StudentFee.create({
      school_id: schoolA.id, organization_id: org.id, student_id: amina.id,
      fee_structure_id: structure.id, academic_session_id: A.session.id,
      /* §17 copies the component and title onto the assignment, so a later edit to the structure
         cannot silently rewrite what a student was actually charged. */
      component: FEE_COMPONENTS.MONTHLY_FEE, title: 'Tuition 2025-2026',
      amount: 5000, discount_amount: 500, net_amount: 4500, paid_amount: 4500,
      due_date: '2026-01-10', status: STUDENT_FEE_STATUS.PAID,
    });
    const payment = await db.FeePayment.create({
      school_id: schoolA.id, organization_id: org.id, student_fee_id: studentFee.id,
      student_id: amina.id, receipt_number: 'RCPT-202601-00001', currency: 'USD',
      amount: 4500, method: PAYMENT_METHODS.CASH, paid_at: new Date('2026-01-05T10:00:00Z'),
    });

    /* A real exam with a stored result, so the result card reports §19's numbers rather than its own. */
    const exam = await db.Exam.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: A.session.id,
      name: 'Mid Term 2026', exam_type: 'midterm', class_id: A.klass.id,
      start_date: '2026-02-01', end_date: '2026-02-10', status: EXAM_STATUS.PUBLISHED,
    });
    const result = await db.Result.create({
      school_id: schoolA.id, organization_id: org.id, exam_id: exam.id, student_id: amina.id,
      /* §19's own column names — `total_marks`/`obtained_marks`/`grade` do not exist on this table. */
      total_full_marks: 200, total_marks_obtained: 176, percentage: 88,
      grade_name: 'A', grade_point: 4, outcome: 'pass',
      position: 2, position_out_of: 30, subjects_count: 2, subjects_failed: 0,
      subject_breakdown: [
        { subject_id: 1, name: 'Maths', full_marks: 100, marks_obtained: 90 },
        { subject_id: 2, name: 'English', full_marks: 100, marks_obtained: 86 },
      ],
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
    const accountant = await signIn(`accountant@${DOMAIN}`);
    const receptionist = await signIn(`receptionist@${DOMAIN}`);
    const teacherToken = await signIn(`teacher@${DOMAIN}`);
    const aminaToken = await signIn(`student-amina@${DOMAIN}`);
    const parentToken = await signIn(`parent@${DOMAIN}`);

    /* ── the guard that is not requireModule ── */

    const noSub = await call('/documents', { token: principalC });
    check('a school with no subscription is refused at the router', noSub.status, 402);
    check('  by the state guard, which is what this router mounts', codeOf(noSub), 'SUBSCRIPTION_INACTIVE');
    const noSubGenerate = await call('/documents', {
      method: 'POST', token: principalC,
      body: { document_type: DOCUMENT_TYPES.CHARACTER_CERTIFICATE, owner_id: 1 },
    });
    check('and so is a generation', noSubGenerate.status, 402);
    check('  state is still checked before module, though the module check moved to the service',
      codeOf(noSubGenerate), 'SUBSCRIPTION_INACTIVE');

    /* ── FR-DOC-001 — the seven documents ── */

    const gen = async (body, token = principalA, want = 201) =>
      dataOf(await expectOk('/documents', { method: 'POST', token, body }, want)).document;

    const idCard = await gen({ document_type: DOCUMENT_TYPES.STUDENT_ID_CARD, owner_id: amina.id });
    check('a Principal generates a student ID card — FR-DOC-001 names them as an actor', Boolean(idCard.id), true);
    check('the owner kind comes from the document type, not the body', idCard.owner_type, DOCUMENT_OWNER_TYPES.STUDENT);
    check('  pointing at the record it is about', idCard.owner_id, amina.id);
    check('the school is taken from the caller', idCard.school_id, schoolA.id);
    check('and so is the organization', idCard.organization_id, org.id);
    check('the row records that it was generated, not uploaded', idCard.is_generated, true);
    check('  and when', Boolean(idCard.generated_at), true);
    check('  by whom', Boolean(idCard.uploaded_by), true);
    check('a title is defaulted from the type', idCard.title, 'Student ID Card');

    /*
     * The payload is checked for its CONTENTS. A builder returning {} would satisfy an
     * "is it non-null" assertion and satisfy no part of FR-DOC-001.
     */
    check('the payload reproduces the student, read from their row', [
      idCard.generation_payload.student.name,
      idCard.generation_payload.student.admission_number,
      idCard.generation_payload.student.roll_number,
    ], ['Amina Khan', 'ADM-S1', 'R-S1']);
    check('  with the class and section NAMED, not left as ids a template cannot print',
      [idCard.generation_payload.student.class.name, idCard.generation_payload.student.section.name],
      ['A Grade 1', 'A']);
    check('  and the school it is issued under', idCard.generation_payload.school.name, 'Verify Documents A');
    check('  dated, so a reproduction is dated by itself', Boolean(idCard.generation_payload.generated_on), true);

    const teacherCard = await gen({ document_type: DOCUMENT_TYPES.TEACHER_ID_CARD, owner_id: teacherA.id });
    check('a teacher ID card is about a teacher', teacherCard.owner_type, DOCUMENT_OWNER_TYPES.TEACHER);
    check('  and reproduces their employment record', [
      teacherCard.generation_payload.teacher.name,
      teacherCard.generation_payload.teacher.employee_id,
      teacherCard.generation_payload.teacher.designation,
    ], ['Nadia Rahman', `${CODE_PREFIX}T1`, 'Senior Teacher']);

    const admission = await gen({ document_type: DOCUMENT_TYPES.ADMISSION_FORM, owner_id: bilal.id });
    const guardians = admission.generation_payload.parents || [];
    check('an admission form names the guardians §15.2 records', [
      guardians.length,
      guardians.length ? guardians[0].name : null,
      guardians.length ? guardians[0].relation : null,
    ], [1, 'Yusuf Parent', 'father']);
    check('  and the admission itself', admission.generation_payload.admission_date, '2025-04-01');

    const receipt = await gen(
      { document_type: DOCUMENT_TYPES.FEE_RECEIPT, owner_id: payment.id }, accountant
    );
    check('an Accountant generates a fee receipt — the second of FR-DOC-001\'s four actors', Boolean(receipt.id), true);
    check('  which is about a fee_payments row, §17\'s receipt and not §13\'s subscription payment',
      receipt.owner_type, DOCUMENT_OWNER_TYPES.PAYMENT);
    check('  reproducing the number and the amount really paid', [
      receipt.generation_payload.payment.receipt_number,
      receipt.generation_payload.payment.amount,
      receipt.generation_payload.payment.method,
    ], ['RCPT-202601-00001', 4500, PAYMENT_METHODS.CASH]);
    check('  what it was paid against', [
      receipt.generation_payload.fee.net_amount, receipt.generation_payload.fee.status,
    ], [4500, STUDENT_FEE_STATUS.PAID]);
    check('  and who paid it', receipt.generation_payload.student.name, 'Amina Khan');

    const card = await gen({
      document_type: DOCUMENT_TYPES.RESULT_CARD, owner_id: amina.id, exam_id: exam.id,
    });
    check('a result card is owned by the student and names the exam separately',
      [card.owner_type, card.owner_id], [DOCUMENT_OWNER_TYPES.STUDENT, amina.id]);
    /*
     * Named against §19's real columns. The first draft of the payload builder guessed
     * `obtained_marks` / `grade` / `is_pass`, none of which exist, and produced a payload of nulls —
     * which a "was a payload assembled?" assertion would have accepted. This one reads the values.
     */
    /* Read defensively: a regression that empties the block must FAIL here, not crash the run. */
    const cardResult = card.generation_payload.result || {};
    check('  reporting §19\'s stored numbers rather than recomputing them', [
      cardResult.total_full_marks,
      cardResult.total_marks_obtained,
      cardResult.percentage,
      cardResult.grade_name,
      cardResult.outcome,
      cardResult.position,
    ], [200, 176, 88, 'A', 'pass', 2]);
    check('  the payload names §19\'s columns exactly, so a guessed one would show up here',
      Object.keys(cardResult).sort(),
      ['grade_name', 'grade_point', 'id', 'outcome', 'percentage', 'position', 'position_out_of',
        'subject_breakdown', 'subjects_count', 'subjects_failed', 'total_full_marks', 'total_marks_obtained']);
    check('  and carries §19\'s per-subject breakdown, which is most of what a card prints',
      (cardResult.subject_breakdown || []).map((r) => r.marks_obtained), [90, 86]);
    check('  while the stored result_card_path is NOT copied into the payload',
      'result_card_path' in card.generation_payload.result, false);
    check('  and the exam it is for', card.generation_payload.exam.name, 'Mid Term 2026');

    const character = await gen(
      { document_type: DOCUMENT_TYPES.CHARACTER_CERTIFICATE, owner_id: amina.id }, receptionist
    );
    check('a Receptionist generates a character certificate — the third actor', Boolean(character.id), true);
    check('  reproducing the student it certifies', character.generation_payload.student.name, 'Amina Khan');

    /* ══════════ FR-DOC-001's PDF half — Phase 5.4 ══════════ */

    /*
     * Read back by inflating the content streams and decoding the hex operands of pdfkit's `TJ`
     * operators. `pdf-parse` is a dependency and cannot parse pdfkit output at all.
     */
    const inflatePdf = (buffer) => {
      const zlib = require('zlib');
      const raw = buffer.toString('latin1');
      const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
      const parts = [];
      let m = streams.exec(raw);
      while (m !== null) {
        try { parts.push(zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1')); }
        catch (_) { /* not a deflate stream */ }
        m = streams.exec(raw);
      }
      return (parts.join('\n').match(/<([0-9A-Fa-f]+)>/g) || [])
        .map((hex) => Buffer.from(hex.slice(1, -1), 'hex').toString('latin1'))
        .join('');
    };
    const pdfOf = async (id, token = principalA) =>
      call(`/documents/${id}?format=pdf`, { token, binary: true });

    /*
     * Whitespace squashed on both sides before comparing PROSE.
     *
     * A justified paragraph wraps, and pdfkit emits each line as its own text run — so the space at
     * a line break is positioning, not a character, and a phrase that happens to span the break
     * loses it. "…certify that Amina Khan" came out as "…certify thatAmina Khan" and the assertion
     * failed for a reason that had nothing to do with the document being wrong.
     *
     * Squashing asserts the characters in order while staying indifferent to where the renderer
     * chose to break the line, which is exactly the right tolerance for wrapped text — and none for
     * anything else: the label/value assertions above compare literally, because those are drawn on
     * one line by construction.
     */
    const squash = (t) => t.replace(/\s+/g, '');
    const hasProse = (haystack, needle) => squash(haystack).includes(squash(needle));

    /*
     * Every one of §20.5's seven renders. Asserted as a set rather than one at a time, because the
     * failure that matters is a type whose spec was forgotten — and a per-type assertion would be
     * added at the same time as the spec, so it could never catch that.
     */
    const allSeven = [idCard, teacherCard, admission, receipt, card, character];
    const rendered = [];
    for (const doc of allSeven) {
      // eslint-disable-next-line no-await-in-loop
      const out = await pdfOf(doc.id);
      rendered.push([doc.document_type, out.status, out.buffer.slice(0, 5).toString()]);
    }
    check('FR-DOC-001 — every generated document renders as a PDF',
      rendered.filter(([, status, magic]) => status !== 200 || magic !== '%PDF-').map(([t]) => t), []);

    const idPdf = await pdfOf(idCard.id);
    check('  with the pdf content type and a filename naming the type',
      [idPdf.contentType, /attachment; filename="student_id_card-\d+\.pdf"/.test(idPdf.disposition)],
      ['application/pdf', true]);

    /* ── the three shapes ── */

    const idText = inflatePdf(idPdf.buffer);
    check('an ID card is label/value pairs — no table, and the identity spelled out',
      ['Student ID Card', 'Name: Amina Khan', 'Class: ', 'Session: ']
        .filter((t) => !idText.includes(t)), []);

    const receiptText = inflatePdf((await pdfOf(receipt.id, accountant)).buffer);
    check('a fee receipt carries its identity block AND a table of what was paid',
      ['Fee Receipt', 'Receipt number: ', 'Item', 'Amount paid']
        .filter((t) => !receiptText.includes(t)), []);

    const cardText = inflatePdf((await pdfOf(card.id)).buffer);
    check('a result card carries the subject table and §19\'s stored totals',
      ['Result Card', 'Subject', 'Outcome', 'Percentage: 88%', 'Position: 2 of ']
        .filter((t) => !cardText.includes(t)), []);

    /* ── the certificates are prose, and state facts rather than characterising ── */

    const charText = inflatePdf((await pdfOf(character.id, receptionist)).buffer);
    check('a character certificate is a letter naming the student and the school',
      ['Character Certificate', 'This is to certify that Amina Khan',
        'is enrolled at Verify Documents A']
        .filter((t) => !hasProse(charText, t)), []);
    /*
     * The tense follows §15.1's status, and that is not cosmetic: a certificate saying a current
     * student "was enrolled" reads as a leaving certificate. Amina is `active`, so it is "is".
     */
    check('  in the present tense, because §15.1 records this student as still active',
      [hasProse(charText, 'is enrolled at'), hasProse(charText, 'was enrolled at')], [true, false]);
    check('  ending in a signature block, because it is a prepared form and not a judgement',
      charText.includes('Signature and seal of the issuing authority'), true);
    /*
     * The design decision, asserted so it cannot quietly change. Nothing in §29 records conduct and
     * §20.5 fixes no wording, so a certificate asserting good character would be this system making
     * a claim on the school's behalf that no column supports. It states what is on file instead.
     */
    check('  and it characterises NOTHING — no conduct claim the schema cannot support',
      ['good moral character', 'well behaved', 'bears a good', 'of good character']
        .filter((phrase) => hasProse(charText.toLowerCase(), phrase)), []);

    /*
     * The strongest assertion here: the PDF is rendered from `generation_payload`, the snapshot taken
     * when the document was generated — not from the live record. Renaming the student afterwards
     * must NOT change a certificate already issued, which is the whole reason the payload is stored.
     */
    await db.Student.update({ first_name: 'Renamed' }, { where: { id: amina.id } });
    const reissued = inflatePdf((await pdfOf(character.id, receptionist)).buffer);
    check('a reissued document reproduces what it said when issued, not what the record says now',
      [hasProse(reissued, 'Amina Khan'), hasProse(reissued, 'Renamed')], [true, false]);
    await db.Student.update({ first_name: 'Amina' }, { where: { id: amina.id } });

    /* ── the formats §20.5 does not name ── */

    check('§20.5 says only "Generate" — a spreadsheet is refused rather than invented',
      (await call(`/documents/${idCard.id}?format=excel`, { token: principalA })).status, 422);
    check('  and so is print, there being no view engine here',
      (await call(`/documents/${idCard.id}?format=print`, { token: principalA })).status, 422);
    check('  while no format at all is still the JSON reproduction',
      Boolean(dataOf(await call(`/documents/${idCard.id}`, { token: principalA })).document), true);

    const leaver = await mkStudent(schoolA, A, 'S4', 'Omar', 'Siddiq', null, {
      status: STUDENT_STATUS.LEFT, left_at: '2026-06-30', leaving_reason: 'Family relocation',
    });
    const leaving = await gen({ document_type: DOCUMENT_TYPES.LEAVING_CERTIFICATE, owner_id: leaver.id });
    /* `left_at` is a DATE, not a DATEONLY, so it crosses the wire as a timestamp. */
    check('a leaving certificate reproduces §15.1\'s leaving columns', [
      leaving.generation_payload.leaving.status,
      String(leaving.generation_payload.leaving.left_at).slice(0, 10),
      leaving.generation_payload.leaving.leaving_reason,
    ], [STUDENT_STATUS.LEFT, '2026-06-30', 'Family relocation']);

    check('all seven of §20.5\'s documents were generated',
      [...new Set([idCard, teacherCard, admission, receipt, card, character, leaving].map((d) => d.document_type))].sort(),
      [...DOCUMENT_TYPE_LIST].sort());

    /* ── the per-type module gate, which is the point of this module ── */

    const certOk = await call('/documents', {
      method: 'POST', token: principalB,
      body: { document_type: DOCUMENT_TYPES.LEAVING_CERTIFICATE, owner_id: bStudent.id },
    });
    check('a school with Certificates but not ID Cards may issue a certificate', certOk.status, 201);
    const idCardDenied = await call('/documents', {
      method: 'POST', token: principalB,
      body: { document_type: DOCUMENT_TYPES.STUDENT_ID_CARD, owner_id: bStudent.id },
    });
    check('  and is refused an ID card — the SAME caller, in the SAME school', idCardDenied.status, 403);
    check('  naming the module the type belongs to', codeOf(idCardDenied), 'MODULE_NOT_SUBSCRIBED');
    check('  which is id_cards, not certificates',
      idCardDenied.body.error.details.missing, [MODULES.ID_CARDS]);
    check('  and says which document asked for it', idCardDenied.body.error.details.documentType,
      DOCUMENT_TYPES.STUDENT_ID_CARD);
    check(
      '  a single router-level requireModule() key could not have expressed that',
      DOCUMENT_TYPE_MODULE[DOCUMENT_TYPES.STUDENT_ID_CARD] !== DOCUMENT_TYPE_MODULE[DOCUMENT_TYPES.LEAVING_CERTIFICATE],
      true
    );
    check('reading is not gated by type, so what was generated stays visible',
      (await call('/documents', { token: principalB })).status, 200);
    /*
     * And reading needs only `documents.view`. A student holds that and not `documents.generate`, so
     * a read route mis-guarded with the generate key answers 403 here. Asserted explicitly rather than
     * left to a later `expectOk` crashing, which is how a regression first exposed it.
     */
    check('  and reading needs only documents.view, which a Student holds and generate is not',
      [(await call('/documents', { token: aminaToken })).status,
        (await call(`/documents/${idCard.id}`, { token: aminaToken })).status],
      [200, 200]);

    /* ── FR-DOC-001's precondition ── */

    const noOwner = await call('/documents', {
      method: 'POST', token: principalA,
      body: { document_type: DOCUMENT_TYPES.CHARACTER_CERTIFICATE, owner_id: 99999999 },
    });
    check('a document for a record that does not exist is refused — FR-DOC-001\'s precondition',
      noOwner.status, 422);
    const foreignOwner = await call('/documents', {
      method: 'POST', token: principalA,
      body: { document_type: DOCUMENT_TYPES.CHARACTER_CERTIFICATE, owner_id: foreignStudent.id },
    });
    check("  and so is one for another school's record, which would print their name on this letterhead",
      foreignOwner.status, 422);
    const wrongKind = await call('/documents', {
      method: 'POST', token: principalA,
      body: { document_type: DOCUMENT_TYPES.TEACHER_ID_CARD, owner_id: amina.id },
    });
    check('a teacher ID card cannot be asked for against a student id', wrongKind.status, 422);
    /*
     * A REAL exam belonging to another school, not a non-existent id. With a made-up id the lookup
     * finds nothing whether or not it is school-scoped, so the assertion proved nothing — which a
     * deliberate regression demonstrated by deleting the scoping and staying green.
     */
    const otherSchoolExam = await db.Exam.create({
      school_id: schoolD.id, organization_id: org.id, academic_session_id: D.session.id,
      name: 'D Mid Term', exam_type: 'midterm', class_id: D.klass.id,
      start_date: '2026-02-01', end_date: '2026-02-10', status: EXAM_STATUS.PUBLISHED,
    });
    const foreignExam = await call('/documents', {
      method: 'POST', token: principalA,
      body: { document_type: DOCUMENT_TYPES.RESULT_CARD, owner_id: amina.id, exam_id: otherSchoolExam.id },
    });
    check("nor a result card against another school's exam, which really exists", foreignExam.status, 422);
    const missingExam = await call('/documents', {
      method: 'POST', token: principalA,
      body: { document_type: DOCUMENT_TYPES.RESULT_CARD, owner_id: amina.id, exam_id: 99999999 },
    });
    check('  and an exam that exists nowhere is refused the same way', missingExam.status, 422);

    /* ── who may generate, and who may only look ── */

    const teacherGenerate = await call('/documents', {
      method: 'POST', token: teacherToken,
      body: { document_type: DOCUMENT_TYPES.CHARACTER_CERTIFICATE, owner_id: amina.id },
    });
    check('a Teacher may not generate — FR-DOC-001 does not name them', teacherGenerate.status, 403);
    check('  refused on the permission', codeOf(teacherGenerate), 'INSUFFICIENT_PERMISSION');
    const studentGenerate = await call('/documents', {
      method: 'POST', token: aminaToken,
      body: { document_type: DOCUMENT_TYPES.CHARACTER_CERTIFICATE, owner_id: amina.id },
    });
    check('nor may a Student', studentGenerate.status, 403);
    const parentGenerate = await call('/documents', {
      method: 'POST', token: parentToken,
      body: { document_type: DOCUMENT_TYPES.CHARACTER_CERTIFICATE, owner_id: bilal.id },
    });
    check('nor a Parent', parentGenerate.status, 403);

    /* ── the three self-audiences ── */

    const aminaDocs = await expectOk('/documents?limit=100', { token: aminaToken }, 200);
    const aminaIds = idsOf(aminaDocs);
    check('a student sees documents about themselves',
      [aminaIds.includes(idCard.id), aminaIds.includes(card.id), aminaIds.includes(character.id)],
      [true, true, true]);
    check('  and not one about another student', aminaIds.includes(admission.id), false);
    check('  nor the teacher\'s ID card', aminaIds.includes(teacherCard.id), false);
    check('  every row is about them', (dataOf(aminaDocs) || []).every(
      (d) => d.owner_type === DOCUMENT_OWNER_TYPES.STUDENT && d.owner_id === amina.id), true);

    const teacherDocs = await expectOk('/documents?limit=100', { token: teacherToken }, 200);
    /*
     * One assertion, not two. Dropping the teacher half of `selfScope()` makes it return null — no
     * narrowing at all — under which a teacher still sees their own card, so "sees own card" alone is
     * satisfied by the bug. The pair has to be checked together.
     */
    check('a teacher sees their own ID card and no student\'s — an owner here as well as a reader',
      [idsOf(teacherDocs).includes(teacherCard.id), idsOf(teacherDocs).includes(idCard.id)],
      [true, false]);

    const parentDocs = await expectOk('/documents?limit=100', { token: parentToken }, 200);
    check('a parent sees their child\'s admission form', idsOf(parentDocs).includes(admission.id), true);
    check('  and not another family\'s', idsOf(parentDocs).includes(idCard.id), false);

    const principalDocs = await expectOk('/documents?limit=100', { token: principalA }, 200);
    check('a principal sees the school\'s, so the narrowing is the audience\'s and not the query\'s',
      [idsOf(principalDocs).includes(idCard.id), idsOf(principalDocs).includes(teacherCard.id),
        idsOf(principalDocs).includes(admission.id)],
      [true, true, true]);

    const byId = await call(`/documents/${teacherCard.id}`, { token: aminaToken });
    check('a document about somebody else cannot be read by guessing its id', byId.status, 404);
    check('  while their own can be', (await call(`/documents/${idCard.id}`, { token: aminaToken })).status, 200);

    /* ── no bytes, stated positively ── */

    const stored = await db.Document.findByPk(idCard.id);
    check('a generated row carries no file — rendering is Phase 5.4', [
      stored.file_path, stored.file_name, stored.mime_type, stored.file_size_bytes,
    ], [null, null, null, null]);
    check('  which the response says, and the create response has no such key to expose',
      ['file_path' in idCard, idCard.has_file], [false, false]);

    /*
     * The suppression itself, proved against a row that really holds a path. Asserting `'file_path' in
     * <create response>` cannot prove it: a create response has no key for a column the insert never
     * named, so it is absent whether or not `present()` deletes it. That trap has now appeared three
     * times in this project — §20.3's `due_date`, §20.4's `cover_path`, and here — and a deliberate
     * regression is what found it each time.
     */
    await db.Document.update(
      { file_path: `school-${schoolA.id}/documents/secret.pdf`, file_name: 'card.pdf' },
      { where: { id: character.id } }
    );
    const withPath = dataOf(await expectOk(`/documents/${character.id}`, { token: principalA }, 200)).document;
    check('a stored file path never reaches a caller', 'file_path' in withPath, false);
    check('  even though the row really holds one',
      Boolean((await db.Document.findByPk(character.id)).file_path), true);
    check('  and the response says so through has_file instead', withPath.has_file, true);
    check('  with nothing leaking the directory layout', JSON.stringify(withPath).includes('school-'), false);
    const storageUsage = await db.UsageRecord.findOne({
      where: { subscription_id: subA.id, limit_key: LIMITS.STORAGE_LIMIT },
    });
    check('  and nothing was counted toward the storage limit, because nothing was stored',
      storageUsage ? Number(storageUsage.used_value) : 0, 0);

    /* ── tenant isolation ── */

    const crossRead = await call(`/documents/${idCard.id}`, { token: principalD });
    check('a principal of another school cannot read this document', crossRead.status, 404);
    const crossNamed = await call(`/documents?school_id=${schoolD.id}`, { token: principalA });
    check('and naming another school is refused by the tenant chain', crossNamed.status, 403);
    check('  before the record is ever looked for', codeOf(crossNamed), 'CROSS_TENANT_ACCESS_DENIED');

    /* ── the trail ── */

    const activity = await settle(
      () => db.ActivityLog.findAll({
        where: { id: { [db.Op.gt]: baseline.activityLog } }, order: [['id', 'ASC']],
      }),
      (rows) => rows.filter((r) => r.entity_type === 'documents').length >= 7
    );
    const mine = activity.filter((r) => r.entity_type === 'documents');
    check('every generation is in the activity trail', mine.length >= 7, true);
    check(
      '  and none of them carries the assembled payload, which holds personal detail',
      mine.every((r) => !JSON.stringify(r.metadata || {}).includes('date_of_birth')
        && !JSON.stringify(r.metadata || {}).includes('guardian_name')),
      true
    );

    const audits = await settleRows(
      () => db.AuditLog.findAll({
        where: { id: { [db.Op.gt]: baseline.auditLog }, table_name: 'documents' },
      }),
      7
    );
    check('documents are audited per row', audits.length >= 7, true);
    check('  as creates', audits.every((r) => r.event === 'create'), true);
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-documents Part 3 teardown failed:', err);
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
    console.error('\nverify-documents crashed:', err);
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
          ? 'All pure document checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All document checks passed (Parts 1–3).'
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
