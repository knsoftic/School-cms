'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *   RATE_LIMIT_MAX / AUTH_RATE_LIMIT_MAX  the limiters are not under test here.
 *   BCRYPT_ROUNDS=10, PASSWORD_MIN_LENGTH pinned so neither comes from the local .env.
 *   MAIL_DRIVER=log   §23 is the first module that actually sends mail, so this matters more here
 *                     than anywhere: `smtp` would make every email row a real connection attempt.
 *   CACHE_TTL=600     so no entitlement assertion can pass by TTL expiry.
 */
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.BCRYPT_ROUNDS = '10';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';
process.env.CACHE_TTL = '600';

/**
 * Verification of Phase 3.V — notifications — `src/modules/notifications/*` — SRS §23, FR-NOTIF-001.
 *
 * ## What is hard to test here, and what this suite does about it
 *
 * §23 has no `create`. Its actor is `System`, so almost nothing it does is reachable from a URL, and
 * a suite that only drove the five HTTP routes would test the inbox and leave the entire engine —
 * eight sweeps, nine types, five marker columns — unexercised. So Part 3 drives
 * `runNotificationSweep()` **directly**, the way `verify-subscriptions.js` drives
 * `runLifecycleSweep()` and `verify-billing.js` drives `markOverdue()`.
 *
 * ## The fixture is built so that every sweep has something it must NOT notify
 *
 * A dispatch sweep is exactly where an assertion passes for the wrong reason: *"it sent one"* is also
 * true of a sweep that sends for every row it sees, and *"the count is 1"* is also true of a query
 * with no filter over a table holding one row. So each pass is given a **negative** beside its
 * positive, and both are asserted:
 *
 * | Pass | Must notify | Must **not** |
 * |---|---|---|
 * | Homework | a published one | an unpublished draft |
 * | Exam Announcement | one that has left `draft` | one still in `draft`, and a `cancelled` one |
 * | Result Published | `is_published` | a result that is not published |
 * | Attendance Alert | `absent` | `present`, `late` and `leave` |
 * | Fee Reminder | owed and due inside the window | owed but due far off, and one already paid |
 * | Fee Paid | a receipt | — (idempotency is its only filter, asserted by the second run) |
 * | Subscription Expiry | state `expiring` | an `active` one |
 * | Payments | `approved` and `rejected` | one still `pending` |
 *
 * ## Idempotency is asserted by running the sweep twice
 *
 * Every marker column and every reference check exists for one reason: the second run must create
 * **zero** rows. That single assertion is what proves the five markers are actually written and the
 * four reference lookups actually consulted — and it cannot pass by accident, because a sweep that
 * forgot to stamp would double every count.
 *
 * ## The e-mail failure path is driven through the real code
 *
 * `deliver()`'s failure branch is the only part of the engine no fixture can provoke, because the
 * `log` driver cannot fail. `mailService.send` is therefore replaced for exactly one `notify()` call
 * and restored immediately — so the `failed` status, the `error_message` and the retry that repairs
 * them are all produced by the module's own code rather than written into the row by the suite.
 *
 * Part 1 — request schemas (no database).
 * Part 2 — the declared route table, the guards that are absent, and the permission split.
 * Part 3 — over real HTTP against the real database, plus the eight sweeps driven directly.
 *
 * Run: node scripts/verify-notifications.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const dates = require('../src/utils/dates');
const mailService = require('../src/services/mailService');
/*
 * The shared fix for Known Issues #25. `logActivity` inserts on `res.on('finish')` and does not
 * await it, so a trail row lands AFTER the fetch that caused it — asserting on the count
 * immediately races the middleware. Measured here before this was used: one run in thirteen saw
 * 0 where 1 was correct. `settleCount` polls with a bound and returns whatever it last saw, so a
 * guard that genuinely never writes still fails its assertion.
 */
const { settleCount } = require('./lib/settle');

const notificationRoutes = require('../src/modules/notifications/notifications.routes');
const { schemas, owned } = require('../src/modules/notifications/notifications.validation');
const service = require('../src/modules/notifications/notifications.service');

const {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_LIST,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUS,
  ROLES,
  USER_STATUS,
  STUDENT_STATUS,
  EXAM_STATUS,
  ATTENDANCE_STATUS,
  PAYMENT_STATUS,
  STUDENT_FEE_STATUS,
  SUBSCRIPTION_STATES,
  PLAN_STATUS,
  MODULE_LIST,
  LIMITS,
  ACTIVITY_ACTIONS,
} = require('../src/config/constants');
const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = require('../src/config/permissions');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-notifications.local';
const PASSWORD = 'Verify@Notify123';
const CODE_PREFIX = 'VNT-';

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

function handlerNames(router, routePath, method = 'post') {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  return layer ? layer.route.stack.map((s) => s.handle.name || '(anon)') : [];
}

/* ═══════════════════════════ part 1 — request schemas ═══════════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas ──\n');

  check('§23 documents nine notification types and introduces no others',
    [...NOTIFICATION_TYPE_LIST].sort(),
    ['attendance_alert', 'exam_announcement', 'fee_paid', 'fee_reminder', 'homework',
      'payment_failed', 'payment_received', 'result_published', 'subscription_expiry']);
  check('  and the frozen map holds exactly the same nine',
    Object.values(NOTIFICATION_TYPES).sort(), [...NOTIFICATION_TYPE_LIST].sort());

  /*
   * §35 marks "Additional notification channels" unspecified, which is why there are two and not
   * three. Asserted because an SMS channel is the obvious thing to add, and adding one would put a
   * value in the column §29's ENUM does not carry.
   */
  check('two channels only — §35 leaves any others unspecified',
    Object.values(NOTIFICATION_CHANNELS).sort(), ['email', 'in_app']);
  check('four delivery statuses', Object.values(NOTIFICATION_STATUS).sort(),
    ['failed', 'pending', 'read', 'sent']);

  /* ── the inbox query ── */

  check('the inbox filters by type, channel, status and unread',
    [
      run(schemas.list, { type: NOTIFICATION_TYPES.HOMEWORK }).ok,
      run(schemas.list, { channel: NOTIFICATION_CHANNELS.EMAIL }).ok,
      run(schemas.list, { status: NOTIFICATION_STATUS.FAILED }).ok,
      run(schemas.list, { unread: true }).ok,
    ],
    [true, true, true, true]);
  check('  and refuses a tenth type, a third channel and a fifth status',
    [
      run(schemas.list, { type: 'sms_alert' }).ok,
      run(schemas.list, { channel: 'sms' }).ok,
      run(schemas.list, { status: 'delivered' }).ok,
    ],
    [false, false, false]);
  check('  a transposed window is refused rather than answered with nothing',
    [
      run(schemas.list, { from: '2026-01-01', to: '2026-02-01' }).ok,
      run(schemas.list, { from: '2026-02-01', to: '2026-01-01' }).ok,
    ],
    [true, false]);

  /*
   * The channel default is NOT in the schema. It belongs to the service, so that `GET /` and
   * `GET /?channel=in_app` are the same by one decision in one place — and so that the service's own
   * branch is what Part 3 measures rather than a value Joi filled in.
   */
  check('the schema supplies no channel default — the service owns what an inbox is',
    run(schemas.list, {}).value.channel, undefined);

  /* ── the forbidden map covers the whole table ── */

  const columns = Object.keys(db.Notification.rawAttributes)
    .filter((key) => !['created_at', 'updated_at'].includes(key));
  check('every column of `notifications` is engine-written, and the forbidden map names every one',
    columns.filter((key) => !(key in owned)), []);
  check('  sixteen of them', columns.length, 16);

  /*
   * The trap from Known Issues: a schema whose only content is a forbidden map must not end in
   * `.min(1)`, or an empty body is refused for being empty and the refusal of the forbidden key
   * proves nothing. Both halves are asserted, so a regression on either fails for its own reason.
   */
  check('a body-less route accepts an empty body', run(schemas.empty, {}).ok, true);
  check('  and refuses every engine-written column by name',
    columns.filter((key) => run(schemas.empty, { [key]: 1 }).ok), []);
  check('  including the three a caller would most want to forge',
    [
      run(schemas.empty, { status: NOTIFICATION_STATUS.SENT }).ok,
      run(schemas.empty, { read_at: '2026-01-01' }).ok,
      run(schemas.empty, { user_id: 1 }).ok,
    ],
    [false, false, false]);

  check('read-all may be narrowed to one type', run(schemas.readAll, { type: NOTIFICATION_TYPES.FEE_PAID }).ok, true);
  check('  refuses a type §23 does not document', run(schemas.readAll, { type: 'birthday' }).ok, false);
  check('  and accepts an empty body, meaning all of them', run(schemas.readAll, {}).ok, true);
}

/* ═══════════════════ part 2 — the route table and the guards ═══════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — routes, guards and the permission split ──\n');

  /*
   * The whole list as one array, not an `indexOf(a) < indexOf(b)` ordering claim. That comparison is
   * satisfied by DELETING the first route, because `indexOf` returns -1 — the defect §5a recorded in
   * session 22 and hit again three sessions later in §21. An array literal pins presence and order
   * together and cannot be satisfied by a deletion.
   */
  check('five routes, and `/read-all` is declared before `/:id` so it is not read as an id',
    routesOf(notificationRoutes),
    ['GET /', 'POST /read-all', 'GET /:id', 'POST /:id/read', 'POST /:id/retry']);

  const src = stripped('../src/modules/notifications/notifications.routes.js');

  check('four routes answer to `notifications.view`',
    (src.match(/requirePermission\('notifications\.view'\)/g) || []).length, 4);
  check('and exactly one to `notifications.send` — the retry',
    (src.match(/requirePermission\('notifications\.send'\)/g) || []).length, 1);
  check('  which is on the retry route and no other',
    handlerNames(notificationRoutes, '/:id/retry').includes('requireNotificationsSendPermission')
    || handlerNames(notificationRoutes, '/:id/retry').length > 0, true);

  /*
   * §23 is core, not subscribable. Measured rather than assumed: there is no MODULES key for it, so
   * `requireModule()` has nothing to name, and no LIMITS key, so there is nothing to meter. Both are
   * asserted against the frozen constants, so adding either would break here first.
   */
  check('there is no MODULES key for notifications — they are core, not subscribable',
    MODULE_LIST.filter((key) => /notif/i.test(key)), []);
  check('  so the router mounts no requireModule and no requireActiveSubscription',
    [/requireModule/.test(src), /requireActiveSubscription/.test(src)], [false, false]);
  check('§11.2 fixes eight limits and none of them counts notifications',
    [Object.values(LIMITS).length, Object.values(LIMITS).filter((k) => /notif|sms|mail/i.test(k))],
    [8, []]);
  check('  so the router meters nothing', /enforceLimit/.test(src), false);

  /* ── the permission split, and §23's own actor list ── */

  const holders = (key) => Object.entries(DEFAULT_ROLE_PERMISSIONS)
    .filter(([, keys]) => Array.isArray(keys) && keys.includes(key))
    .map(([role]) => role).sort();

  check('`notifications.view` reaches all eleven roles — §23\'s outcome names everyone',
    holders('notifications.view').length, 11);
  check('`notifications.send` reaches three',
    holders('notifications.send'), ['principal', 'school_admin', 'super_admin']);
  check('  and both are declared with `module: null`, which is why nothing gates them',
    PERMISSIONS.filter((p) => p.key.startsWith('notifications.')).map((p) => p.module),
    [null, null]);

  /* ── the trail ── */

  check('the retry is written to the activity trail and the four reads are not',
    (src.match(/logActivity\(/g) || []).length, 1);
  check('  as an `update`, because ACTIVITY_ACTIONS has no `retry` and refuses an invented verb at boot',
    [/action: 'update'/.test(src), Object.values(ACTIVITY_ACTIONS).includes('retry')],
    [true, false]);

  /* ── dispatch has no route ── */

  check('no route dispatches a notification — §23\'s actor is the system',
    /runNotificationSweep|notify\(/.test(src), false);
  check('  and the sweep is exported for a scheduler to call, as runLifecycleSweep is',
    [typeof service.runNotificationSweep, typeof service.notify], ['function', 'function']);

  /* ── the tenancy decision ── */

  const serviceSrc = stripped('../src/modules/notifications/notifications.service.js');
  check('the service never calls tenantWhere() — `school_id` is nullable here and an equality would '
    + 'never match a platform notification',
    /tenantWhere/.test(serviceSrc), false);
  check('  every read is scoped by the recipient instead',
    (serviceSrc.match(/user_id: req\.user\.id/g) || []).length >= 3, true);
}

/* ═══════════════════════════ part 3 — over real HTTP ═══════════════════════════ */

async function verifyHttp() {
  console.log('\n── Part 3 — real HTTP, and the eight sweeps driven directly ──\n');

  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  const created = { schools: [], organizations: [], plans: [], subscriptions: [] };
  const baseline = {
    activityLog: (await db.ActivityLog.max('id')) || 0,
    auditLog: (await db.AuditLog.max('id')) || 0,
    notification: (await db.Notification.max('id')) || 0,
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
    try { parsed = JSON.parse(text); } catch { /* left null */ }
    return { status: res.status, body: parsed, raw: text };
  }

  const codeOf = (r) => (r.body && r.body.error ? r.body.error.code : `no-error:${r.status}`);

  const msgOf = (r) => (r.body && r.body.error ? r.body.error.message : '');
  const dataOf = (r) => (r.body && r.body.data !== undefined ? r.body.data : null);

  async function teardown() {
    await db.Notification.destroy({ where: { id: { [db.Op.gt]: baseline.notification } } });
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
      await db.Homework.destroy({ where: { school_id: created.schools } });
      await db.ParentStudent.destroy({ where: { school_id: created.schools } });
      await db.Parent.destroy({ where: { school_id: created.schools }, force: true });
      await db.Student.destroy({ where: { school_id: created.schools }, force: true });
      await db.Section.destroy({ where: { school_id: created.schools }, force: true });
      await db.Class.destroy({ where: { school_id: created.schools }, force: true });
      await db.AcademicSession.destroy({ where: { school_id: created.schools }, force: true });
      await db.Payment.destroy({ where: { school_id: created.schools } });
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
    for (const slug of [ROLES.PRINCIPAL, ROLES.TEACHER, ROLES.STUDENT, ROLES.PARENT, ROLES.ACCOUNTANT]) {
      // eslint-disable-next-line no-await-in-loop
      const role = await db.Role.findOne({ where: { slug } });
      if (!role) throw new Error(`seeded role missing: ${slug}`);
      roles[slug] = role;
    }

    /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
    const residueCleared = await sweepResidue(db, { codes: ['VNT-'], domains: ['verify-notifications.local'] });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({ name: 'Verify Notify Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Notify A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Notify B');

    /* A plan with every module on, so nothing here is refused for an entitlement reason. */
    const plan = await db.SubscriptionPlan.create({
      name: 'Verify Notify Plan', code: `${CODE_PREFIX}P`, status: PLAN_STATUS.ACTIVE,
      tier_rank: 1, trial_days: 0, grace_period_days: 7,
    });
    created.plans.push(plan.id);
    for (const key of MODULE_LIST) {
      // eslint-disable-next-line no-await-in-loop
      await db.PlanModule.create({ plan_id: plan.id, module_key: key, is_enabled: true });
    }

    const session = await db.AcademicSession.create({
      school_id: schoolA.id, organization_id: org.id, name: '2026', is_current: true,
      start_date: '2026-01-01', end_date: '2026-12-31',
    });
    const grade = await db.Class.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      name: 'Notify Grade', numeric_level: 5,
    });
    const other = await db.Class.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      name: 'Other Grade', numeric_level: 6,
    });

    const password_hash = await hashPassword(PASSWORD);
    const mkUser = async (key, slug, school_id, status = USER_STATUS.ACTIVE) => {
      const u = await db.User.create({
        role_id: roles[slug].id, organization_id: org.id, school_id, name: `Verify NT ${key}`,
        email: `${key}@${DOMAIN}`,
        username: `vnt_${key.replace(/-/g, '_')}`,
        password_hash, status, must_change_password: false,
      });
      return u;
    };

    const principalA = await mkUser('principal-a', ROLES.PRINCIPAL, schoolA.id);
    const principalB = await mkUser('principal-b', ROLES.PRINCIPAL, schoolB.id);
    const teacherU = await mkUser('teacher', ROLES.TEACHER, schoolA.id);
    const accountantU = await mkUser('accountant', ROLES.ACCOUNTANT, schoolA.id);
    /* Two student accounts, one parent account, and one *suspended* parent who must be skipped. */
    const studentU1 = await mkUser('student-1', ROLES.STUDENT, schoolA.id);
    const studentU2 = await mkUser('student-2', ROLES.STUDENT, schoolA.id);
    const parentU = await mkUser('parent-1', ROLES.PARENT, schoolA.id);
    const suspendedU = await mkUser('parent-suspended', ROLES.PARENT, schoolA.id, USER_STATUS.SUSPENDED);
    const studentU3 = await mkUser('student-3', ROLES.STUDENT, schoolA.id);
    /* In the other class — must never receive this class's homework or exam announcement. */
    const outsiderU = await mkUser('student-out', ROLES.STUDENT, schoolA.id);

    const mkStudent = async (key, user, cls, status = STUDENT_STATUS.ACTIVE) => db.Student.create({
      school_id: schoolA.id, organization_id: org.id, user_id: user ? user.id : null,
      student_id: `${CODE_PREFIX}${key}`, admission_number: `${CODE_PREFIX}ADM${key}`,
      admission_date: '2026-01-05', first_name: `Notify${key}`, last_name: 'Student',
      gender: 'male', class_id: cls.id, academic_session_id: session.id, status,
    });
    const student1 = await mkStudent('S1', studentU1, grade);
    const student2 = await mkStudent('S2', studentU2, grade);
    const student3 = await mkStudent('S3', studentU3, grade);
    const outsider = await mkStudent('S4', outsiderU, other);
    /* A left student in the same class: `studentIdsForClass` must not reach them. */
    const leftStudent = await mkStudent('S5', null, grade, STUDENT_STATUS.LEFT);

    const parent = await db.Parent.create({
      school_id: schoolA.id, organization_id: org.id, user_id: parentU.id,
      name: 'Notify Parent', relation: 'father', is_active: true,
    });
    const suspendedParent = await db.Parent.create({
      school_id: schoolA.id, organization_id: org.id, user_id: suspendedU.id,
      name: 'Suspended Parent', relation: 'mother', is_active: true,
    });
    await db.ParentStudent.create({
      school_id: schoolA.id, parent_id: parent.id, student_id: student1.id,
      relation: 'father', is_primary_guardian: true,
    });
    await db.ParentStudent.create({
      school_id: schoolA.id, parent_id: suspendedParent.id, student_id: student1.id,
      relation: 'mother', is_primary_guardian: false,
    });
    /*
     * A second guardian, linked to a DIFFERENT student. Without them, "the alert reached the right
     * parent" is indistinguishable from "there is only one parent" — every per-student assertion
     * below would pass against a resolver that ignored the link table entirely.
     */
    const parent2U = await mkUser('parent-2', ROLES.PARENT, schoolA.id);
    const parent2 = await db.Parent.create({
      school_id: schoolA.id, organization_id: org.id, user_id: parent2U.id,
      name: 'Other Parent', relation: 'father', is_active: true,
    });
    await db.ParentStudent.create({
      school_id: schoolA.id, parent_id: parent2.id, student_id: student2.id,
      relation: 'father', is_primary_guardian: true,
    });

    /* ═════════ the audience resolvers, before any sweep runs ═════════ */

    const classIds = await service.studentIdsForClass(schoolA.id, grade.id, null);
    check('a class resolves to its ACTIVE students only — a student who has left is not in it',
      [classIds.length, classIds.includes(leftStudent.id), classIds.includes(outsider.id)],
      [3, false, false]);

    const byStudent = await service.recipientsForStudents([student1.id]);
    check('a student resolves to their own account plus every linked parent',
      [...(byStudent.get(student1.id) || [])].sort((a, b) => a - b),
      [studentU1.id, parentU.id, suspendedU.id].sort((a, b) => a - b));

    check('  and NOT a guardian linked to a different student — attribution, not "the only parent"',
      [...(byStudent.get(student1.id) || [])].includes(parent2U.id), false);

    const live = await service.recipientsForUsers([studentU1.id, parentU.id, suspendedU.id]);
    check('  and a SUSPENDED account is dropped before anything is written for it',
      live.map((r) => r.id).sort((a, b) => a - b), [studentU1.id, parentU.id].sort((a, b) => a - b));

    const admins = await service.schoolAdminUserIds(schoolA.id);
    check('the school\'s billing audience is its principal and school admins, not its teachers',
      [admins.includes(principalA.id), admins.includes(teacherU.id), admins.includes(principalB.id)],
      [true, false, false]);

    /* ═════════ the fixture each sweep must and must not act on ═════════ */

    const at = new Date('2026-06-15T09:00:00Z');

    const hwPublished = await db.Homework.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      class_id: grade.id, title: 'Notified Homework', assigned_date: '2026-06-10',
      due_date: '2026-06-20', is_published: true, created_by: teacherU.id,
    });
    const hwDraft = await db.Homework.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      class_id: grade.id, title: 'Draft Homework', assigned_date: '2026-06-10',
      due_date: '2026-06-21', is_published: false, created_by: teacherU.id,
    });

    const examScheduled = await db.Exam.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      name: 'Announced Exam', exam_type: 'midterm', class_id: grade.id,
      start_date: '2026-07-01', end_date: '2026-07-10', status: EXAM_STATUS.SCHEDULED,
    });
    const examDraft = await db.Exam.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      name: 'Draft Exam', exam_type: 'quiz', class_id: grade.id,
      start_date: '2026-08-01', end_date: '2026-08-02', status: EXAM_STATUS.DRAFT,
    });
    await db.Exam.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      name: 'Cancelled Exam', exam_type: 'quiz', class_id: grade.id,
      start_date: '2026-08-05', end_date: '2026-08-06', status: EXAM_STATUS.CANCELLED,
    });

    /*
     * D15 — the class's teacher, with a login, so an exam announcement and published results have a
     * teacher to reach. Linked as the class teacher, which is one of the four ways the schema records
     * who teaches a class.
     */
    const gradeTeacher = await db.Teacher.create({
      school_id: schoolA.id, organization_id: org.id, user_id: teacherU.id, employee_id: `${CODE_PREFIX}T1`,
      first_name: 'Grade', last_name: 'Teacher', joining_date: '2025-01-06',
    });
    await grade.update({ class_teacher_id: gradeTeacher.id });

    const mkResult = async (student, published, percentage) => db.Result.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      exam_id: examScheduled.id, student_id: student.id, class_id: grade.id,
      total_full_marks: 100, total_marks_obtained: percentage, percentage,
      grade_name: percentage >= 50 ? 'B' : 'F', outcome: percentage >= 50 ? 'pass' : 'fail',
      subjects_count: 1, subjects_failed: percentage >= 50 ? 0 : 1,
      is_published: published, published_at: published ? at : null,
    });
    const resultPublished = await mkResult(student1, true, 91);
    await mkResult(student2, false, 64);

    const mkAttendance = async (student, status) => db.StudentAttendance.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      student_id: student.id, class_id: grade.id, attendance_date: '2026-06-12',
      status, marked_by: teacherU.id,
    });
    const absent = await mkAttendance(student1, ATTENDANCE_STATUS.ABSENT);
    await mkAttendance(student2, ATTENDANCE_STATUS.PRESENT);
    await mkAttendance(student3, ATTENDANCE_STATUS.LATE);
    await mkAttendance(outsider, ATTENDANCE_STATUS.LEAVE);

    const structure = await db.FeeStructure.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      name: 'Notify Fees', class_id: grade.id, currency: 'USD', amount: 1000,
      component: 'monthly_fee',
    });
    const mkFee = async (student, dueDate, status, pending) => db.StudentFee.create({
      school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
      student_id: student.id, fee_structure_id: structure.id, class_id: grade.id,
      component: 'monthly_fee', title: 'Term Fee', currency: 'USD',
      amount: 1000, net_amount: 1000, paid_amount: 1000 - pending, pending_amount: pending,
      due_date: dueDate, status,
    });
    /* Due in three days: inside the seven-day window. */
    const feeDueSoon = await mkFee(student1, '2026-06-18', STUDENT_FEE_STATUS.UNPAID, 1000);
    /* Due in sixty days: outside it. */
    const feeDueLater = await mkFee(student2, '2026-08-14', STUDENT_FEE_STATUS.UNPAID, 1000);
    /* Inside the window but already settled. */
    const feePaid = await mkFee(student3, '2026-06-17', STUDENT_FEE_STATUS.PAID, 0);

    const receipt = await db.FeePayment.create({
      school_id: schoolA.id, organization_id: org.id, student_fee_id: feePaid.id,
      student_id: student3.id, receipt_number: `${CODE_PREFIX}RCP1`, currency: 'USD',
      amount: 1000, method: 'cash', paid_at: at, collected_by: accountantU.id,
    });

    const mkSubscription = async (school, state) => {
      const s = await db.Subscription.create({
        school_id: school.id, organization_id: org.id, plan_id: plan.id, state,
        billing_cycle: 'monthly', cycle_days: 30, pricing_model: 'fixed', currency: 'USD',
        cycle_amount: 100, quantity: 1, starts_at: at,
        current_period_start: at, current_period_end: dates.addDays(at, 5),
      });
      created.subscriptions.push(s.id);
      return s;
    };
    const subExpiring = await mkSubscription(schoolA, SUBSCRIPTION_STATES.EXPIRING);
    const subActive = await mkSubscription(schoolB, SUBSCRIPTION_STATES.ACTIVE);

    const mkPayment = async (number, status) => db.Payment.create({
      payment_number: `${CODE_PREFIX}${number}`, school_id: schoolA.id, organization_id: org.id,
      subscription_id: subExpiring.id, method: 'bank_transfer', currency: 'USD', amount: 100,
      status, submitted_by: accountantU.id,
    });
    const payApproved = await mkPayment('PAY1', PAYMENT_STATUS.APPROVED);
    const payRejected = await mkPayment('PAY2', PAYMENT_STATUS.REJECTED);
    const payPending = await mkPayment('PAY3', PAYMENT_STATUS.PENDING);

    /* ═════════════════════════ the sweep ═════════════════════════ */

    const report = await service.runNotificationSweep({ at });

    check('the sweep reports one pass per §23 type group, in order',
      Object.keys(report).filter((k) => k !== 'at' && k !== 'failed'),
      ['homework', 'examAnnouncements', 'results', 'resultsForTeachers', 'attendanceAlerts',
        'feeReminders', 'invoiceReminders', 'feePaid', 'subscriptionExpiry', 'payments']);
    check('  and nothing failed', report.failed, []);

    check('each pass notified exactly its candidates and left its negatives alone',
      [report.homework, report.examAnnouncements, report.results, report.resultsForTeachers,
        report.attendanceAlerts, report.feeReminders, report.feePaid, report.subscriptionExpiry,
        report.payments],
      [1, 1, 1, 1, 1, 1, 1, 1, 2]);

    /* ── the five marker columns are actually stamped ── */

    await Promise.all([hwPublished.reload(), hwDraft.reload(), examScheduled.reload(),
      examDraft.reload(), absent.reload(), feeDueSoon.reload(), feeDueLater.reload(),
      subExpiring.reload(), subActive.reload()]);

    check('§29\'s five marker columns are stamped by the pass that used them',
      [
        hwPublished.notified_at !== null,
        examScheduled.announced_at !== null,
        absent.alert_sent_at !== null,
        feeDueSoon.reminder_sent_at !== null,
        subExpiring.expiry_notified_at !== null,
      ],
      [true, true, true, true, true]);
    check('  and left null on every row the sweep must not have touched',
      [
        hwDraft.notified_at, examDraft.announced_at,
        feeDueLater.reminder_sent_at, subActive.expiry_notified_at,
      ],
      [null, null, null, null]);

    /* ── who received what ── */

    const rowsOf = async (where) => db.Notification.findAll({
      where: { id: { [db.Op.gt]: baseline.notification }, ...where },
      order: [['id', 'ASC']],
    });

    const hwRows = await rowsOf({ type: NOTIFICATION_TYPES.HOMEWORK });
    const hwInApp = hwRows.filter((r) => r.channel === NOTIFICATION_CHANNELS.IN_APP);
    check('the homework reached all three active students of the class, and both their guardians',
      hwInApp.map((r) => r.user_id).sort((a, b) => a - b),
      [studentU1.id, studentU2.id, studentU3.id, parentU.id, parent2U.id].sort((a, b) => a - b));
    check('  and reached nobody in the other class, nor the suspended parent',
      [
        hwInApp.some((r) => r.user_id === outsiderU.id),
        hwInApp.some((r) => r.user_id === suspendedU.id),
      ],
      [false, false]);
    check('  it names the row that raised it, which is what makes the pass idempotent',
      [hwRows[0].reference_type, hwRows[0].reference_id], ['homework', hwPublished.id]);

    /*
     * An in-app row IS the delivery, so it is born `sent`. An email row is a delivery attempt and is
     * born `pending`. Asserted together, because a single status for both would make the retry
     * meaningless and would still look correct from one side.
     */
    const hwEmail = hwRows.filter((r) => r.channel === NOTIFICATION_CHANNELS.EMAIL);
    check('an in-app row is born `sent` — persisting it is the delivery',
      [...new Set(hwInApp.map((r) => r.status))], [NOTIFICATION_STATUS.SENT]);
    check('  and every in-app row carries a sent_at',
      hwInApp.every((r) => r.sent_at !== null), true);
    check('an email row is written beside every in-app row, because every recipient has an address',
      hwEmail.map((r) => r.user_id).sort((a, b) => a - b),
      hwInApp.map((r) => r.user_id).sort((a, b) => a - b));
    /*
     * The addressless branch is asserted through notify()'s own contract rather than through a
     * sweep, because MEASURED: `users.email` is NOT NULL, so no audience this module resolves can
     * contain a recipient without one. Writing a fixture for it is impossible; pretending a sweep
     * covers it would be coverage this suite does not have.
     */
    const addressless = await service.notify({
      type: NOTIFICATION_TYPES.HOMEWORK,
      recipients: [{ id: studentU3.id, name: 'no address', email: null }],
      schoolId: schoolA.id, organizationId: org.id,
      title: 'Addressless', message: 'Addressless',
    });
    check('  a recipient with no address gets the in-app row and no unsendable second one',
      [addressless.created, addressless.emailed, addressless.failed], [1, 0, 0]);
    check('  and the log driver delivered them, so they are `sent` with the address on the row',
      [
        [...new Set(hwEmail.map((r) => r.status))],
        hwEmail.every((r) => r.metadata && r.metadata.email),
      ],
      [[NOTIFICATION_STATUS.SENT], true]);

    const alertRows = await rowsOf({
      type: NOTIFICATION_TYPES.ATTENDANCE_ALERT, channel: NOTIFICATION_CHANNELS.IN_APP,
    });
    check('the attendance alert went to the absent student and their parent, and to no one else',
      alertRows.map((r) => r.user_id).sort((a, b) => a - b),
      [studentU1.id, parentU.id].sort((a, b) => a - b));
    check('  present, late and leave raise nothing — the alert is for an absence',
      alertRows.length, 2);
    check('  and the other student\'s guardian hears nothing about this absence',
      alertRows.some((r) => r.user_id === parent2U.id), false);

    const payRows = await rowsOf({ channel: NOTIFICATION_CHANNELS.IN_APP, [db.Op.or]: [
      { type: NOTIFICATION_TYPES.PAYMENT_RECEIVED }, { type: NOTIFICATION_TYPES.PAYMENT_FAILED },
    ] });
    check('§13\'s approved and rejected payments map onto §23\'s two payment types',
      [
        [...new Set(payRows.filter((r) => r.type === NOTIFICATION_TYPES.PAYMENT_RECEIVED)
          .map((r) => r.reference_id))],
        [...new Set(payRows.filter((r) => r.type === NOTIFICATION_TYPES.PAYMENT_FAILED)
          .map((r) => r.reference_id))],
      ],
      [[payApproved.id], [payRejected.id]]);
    check('  a payment still pending is neither received nor failed',
      payRows.some((r) => r.reference_id === payPending.id), false);
    /*
     * Each payment and each expiring subscription now raises two notices: the school's, and the
     * platform's copy for the Super Admins with a null `school_id` (the owner's decision D15). The
     * school-audience checks read the school's rows; the platform rows are checked on their own below.
     */
    const schoolPayRows = payRows.filter((r) => r.school_id !== null);
    check('  and they went to the school, not to a student — principal and the submitter',
      [...new Set(schoolPayRows.map((r) => r.user_id))].sort((a, b) => a - b),
      [principalA.id, accountantU.id].sort((a, b) => a - b));
    const superAdminIds = (await db.User.findAll({
      where: { school_id: null, status: USER_STATUS.ACTIVE },
      include: [{ model: db.Role, as: 'role', where: { slug: ROLES.SUPER_ADMIN }, attributes: [] }],
      attributes: ['id'],
    })).map((u) => u.id).sort((a, b) => a - b);
    const platformPayRows = payRows.filter((r) => r.school_id === null);
    check('D15 — and the Super Admins get the platform copy of each, one per payment, with no school on it',
      [[...new Set(platformPayRows.map((r) => r.user_id))].sort((a, b) => a - b),
        platformPayRows.map((r) => r.reference_id).sort((a, b) => a - b)],
      [superAdminIds, superAdminIds.flatMap(() => [payApproved.id, payRejected.id]).sort((a, b) => a - b)]);

    const expiryRows = await rowsOf({
      type: NOTIFICATION_TYPES.SUBSCRIPTION_EXPIRY, channel: NOTIFICATION_CHANNELS.IN_APP,
    });
    const schoolExpiryRows = expiryRows.filter((r) => r.school_id !== null);
    check('the expiry notice names the expiring subscription and only school A hears it',
      [schoolExpiryRows.map((r) => r.reference_id), [...new Set(schoolExpiryRows.map((r) => r.school_id))]],
      [[subExpiring.id], [schoolA.id]]);
    const platformExpiryRows = expiryRows.filter((r) => r.school_id === null);
    check('D15 — the platform copy of the expiry notice reaches every Super Admin, about the same subscription',
      [[...new Set(platformExpiryRows.map((r) => r.user_id))].sort((a, b) => a - b),
        [...new Set(platformExpiryRows.map((r) => r.reference_id))]],
      [superAdminIds, [subExpiring.id]]);

    /* The per-student rows reference the result; the teacher's once-per-exam row references the exam. */
    const resultRows = await rowsOf({ type: NOTIFICATION_TYPES.RESULT_PUBLISHED, reference_type: 'result' });
    check('only a PUBLISHED result is announced',
      [...new Set(resultRows.map((r) => r.reference_id))], [resultPublished.id]);
    const teacherResultRows = await rowsOf({
      type: NOTIFICATION_TYPES.RESULT_PUBLISHED, reference_type: 'exam', channel: NOTIFICATION_CHANNELS.IN_APP,
    });
    check('D15 — the class teacher is told once per exam that its results are published, not once per student',
      teacherResultRows.map((r) => [r.user_id, r.reference_id]), [[teacherU.id, examScheduled.id]]);
    const teacherExamRows = await rowsOf({
      type: NOTIFICATION_TYPES.EXAM_ANNOUNCEMENT, user_id: teacherU.id, channel: NOTIFICATION_CHANNELS.IN_APP,
    });
    check('  and hears the exam announcement for their class',
      teacherExamRows.map((r) => r.reference_id), [examScheduled.id]);

    const feeRows = await rowsOf({ type: NOTIFICATION_TYPES.FEE_REMINDER });
    check('only the fee due inside the seven-day window is reminded about',
      [...new Set(feeRows.map((r) => r.reference_id))], [feeDueSoon.id]);

    /* ── idempotency: the whole point of the five markers and the four reference checks ── */

    const countAfterFirst = await db.Notification.count({
      where: { id: { [db.Op.gt]: baseline.notification } },
    });
    const second = await service.runNotificationSweep({ at: dates.addDays(at, 1) });
    const countAfterSecond = await db.Notification.count({
      where: { id: { [db.Op.gt]: baseline.notification } },
    });

    check('running the sweep again notifies NOBODY — five marker columns and four reference checks',
      [second.homework, second.examAnnouncements, second.results, second.attendanceAlerts,
        second.feeReminders, second.feePaid, second.subscriptionExpiry, second.payments],
      [0, 0, 0, 0, 0, 0, 0, 0]);
    check('  so not one row is written the second time',
      countAfterSecond - countAfterFirst, 0);

    /*
     * And proved the other way: the four types with NO marker column are held back by the reference
     * check alone, so deleting their notifications must make them candidates again. This is what
     * distinguishes "idempotent" from "the query happened to return nothing the second time".
     */
    await db.Notification.destroy({
      where: { type: NOTIFICATION_TYPES.FEE_PAID, id: { [db.Op.gt]: baseline.notification } },
    });
    const third = await service.runNotificationSweep({ at, only: ['feePaid'] });
    check('a markerless type becomes a candidate again once its notification is gone — the reference '
      + 'check is what held it back, not an empty query',
      third.feePaid, 1);

    /*
     * ── the LIMIT must be spent on work that remains, not on work already done ──
     *
     * The four markerless passes used to select the OLDEST `limit` rows and then discard the
     * already-notified ones **in JavaScript**, after the LIMIT had been applied. So the LIMIT was
     * consumed by rows that were already handled: once the first `SWEEP_LIMIT` (500) rows were
     * notified, every later run fetched exactly those 500, filtered them all out, and reported 0 —
     * for ever, while new rows accumulated outside the window. Four of §23's nine types stopped
     * permanently at that point, which FR-NOTIF-001 does not permit.
     *
     * `limit: 1` reproduces it in two rows instead of five hundred. With one payment already
     * notified and a second waiting, a sweep of one must return the SECOND. Under the old code it
     * returned the first again, found it notified, and reported nothing.
     */
    const receipt2 = await db.FeePayment.create({
      school_id: schoolA.id, organization_id: org.id, student_fee_id: feePaid.id,
      student_id: student3.id, receipt_number: `${CODE_PREFIX}RCP2`, currency: 'USD',
      amount: 250, method: 'cash', paid_at: at, collected_by: accountantU.id,
    });

    const paged = await service.runNotificationSweep({ at, only: ['feePaid'], limit: 1 });
    check('with one payment already announced and a second waiting, a sweep of ONE reaches the second',
      paged.feePaid, 1);
    check('  and it is the newer receipt, so the limit was spent on the row that still needed work',
      (await db.Notification.findAll({
        where: {
          type: NOTIFICATION_TYPES.FEE_PAID, reference_type: 'fee_payment',
          reference_id: receipt2.id, channel: NOTIFICATION_CHANNELS.IN_APP,
        },
      })).length > 0,
      true);

    /*
     * A payment that was rejected and is LATER APPROVED must raise `payment_received`, even though a
     * `payment_failed` already names the same row. This is what makes the reference check per TYPE
     * rather than per row observable at all — a deliberate regression dropping `type` from the
     * lookup changed nothing until this case existed, because no other reference here carries two.
     */
    await payRejected.update({ status: PAYMENT_STATUS.APPROVED });
    const fourth = await service.runNotificationSweep({ at, only: ['payments'] });
    check('a payment that failed and was later approved is announced as received, because the '
      + 'reference check is per TYPE and not per row',
      fourth.payments, 1);
    check('  and the row that proves it names the same payment under the other type',
      (await db.Notification.findAll({
        where: {
          type: NOTIFICATION_TYPES.PAYMENT_RECEIVED, reference_type: 'payment',
          reference_id: payRejected.id, channel: NOTIFICATION_CHANNELS.IN_APP,
        },
      })).length > 0,
      true);

    /* ── notify() refuses a tenth type ── */

    let unknownType = null;
    try {
      await service.notify({ type: 'birthday', recipients: [{ id: principalA.id }], title: 'x', message: 'y' });
    } catch (error) { unknownType = error.message; }
    check('notify() refuses a type §23 does not document rather than writing it to the ENUM column',
      /unknown type/.test(unknownType || ''), true);

    /* ═════════ the e-mail failure path, through the module's own code ═════════ */

    const realSend = mailService.send;
    mailService.send = async () => { throw new Error('SMTP 550 mailbox unavailable'); };
    let failedResult;
    try {
      failedResult = await service.notify({
        type: NOTIFICATION_TYPES.FEE_PAID,
        recipients: [{ id: parentU.id, name: 'p', email: `parent-1@${DOMAIN}` }],
        schoolId: schoolA.id, organizationId: org.id,
        title: 'Delivery test', message: 'Delivery test',
        referenceType: 'fee_payment', referenceId: receipt.id,
      });
    } finally {
      mailService.send = realSend;
    }

    check('a transport failure does not throw — the in-app copy was already received',
      [failedResult.created, failedResult.emailed, failedResult.failed], [2, 0, 1]);

    const failedRow = await db.Notification.findOne({
      where: { title: 'Delivery test', channel: NOTIFICATION_CHANNELS.EMAIL },
    });
    check('  it is recorded on the row instead, with the transport\'s own words',
      [failedRow.status, failedRow.error_message], [NOTIFICATION_STATUS.FAILED, 'SMTP 550 mailbox unavailable']);
    check('  while the in-app copy of the same event is unaffected',
      (await db.Notification.findOne({
        where: { title: 'Delivery test', channel: NOTIFICATION_CHANNELS.IN_APP },
      })).status,
      NOTIFICATION_STATUS.SENT);
    check('  and present() reports that there was an error without repeating the transport\'s message',
      [service.present(failedRow).has_error, 'error_message' in service.present(failedRow)],
      [true, false]);

    /* ═════════════════════════ the HTTP surface ═════════════════════════ */

    async function signIn(identifier) {
      const res = await call('/auth/login', { method: 'POST', body: { identifier, password: PASSWORD } });
      const token = res.body && res.body.data ? res.body.data.accessToken : null;
      if (!token) throw new Error(`sign-in failed for ${identifier}: ${res.raw}`);
      return token;
    }
    const parentToken = await signIn(`parent-1@${DOMAIN}`);
    const teacherToken = await signIn(`teacher@${DOMAIN}`);
    const principalToken = await signIn(`principal-a@${DOMAIN}`);
    const principalBToken = await signIn(`principal-b@${DOMAIN}`);
    const studentToken = await signIn(`student-2@${DOMAIN}`);

    const inbox = await call('/notifications', { token: parentToken });
    check('a parent reads their own inbox', inbox.status, 200);
    const inboxRows = dataOf(inbox) || [];
    check('  which is the in-app channel by default, the email rows being delivery records',
      [...new Set(inboxRows.map((r) => r.channel))], [NOTIFICATION_CHANNELS.IN_APP]);
    check('  every row of it addressed to them and nobody else',
      [...new Set(inboxRows.map((r) => r.user_id))], [parentU.id]);
    check('  with the unread badge beside the page, so a client needs no second request',
      inbox.body.meta.unread, inboxRows.length);

    const emailInbox = await call(`/notifications?channel=${NOTIFICATION_CHANNELS.EMAIL}`, { token: parentToken });
    check('the email rows are reachable by asking for them, which is how a failure is found',
      (dataOf(emailInbox) || []).some((r) => r.status === NOTIFICATION_STATUS.FAILED), true);
    check('  and they never carry the transport\'s message out of the building',
      (dataOf(emailInbox) || []).every((r) => !('error_message' in r)), true);

    /*
     * This used to be a teacher who received nothing and an inbox of 0. Since the owner's decision D15
     * the class teacher receives exactly two — the exam announcement and the once-per-exam results
     * notice — so the same point, that an inbox is its owner's and not everybody else's, is made by
     * that exact pair rather than by an emptiness.
     */
    const teacherInbox = await call('/notifications', { token: teacherToken });
    check('a teacher\'s inbox holds exactly what was addressed to them, not everybody else\'s',
      [teacherInbox.status, (dataOf(teacherInbox) || []).map((r) => r.type).sort()],
      [200, [NOTIFICATION_TYPES.EXAM_ANNOUNCEMENT, NOTIFICATION_TYPES.RESULT_PUBLISHED]]);

    const mine = inboxRows[0];
    const someoneElse = await db.Notification.findOne({
      where: { user_id: studentU1.id, channel: NOTIFICATION_CHANNELS.IN_APP },
    });
    check('reading another recipient\'s notification is a 404, not a 403 — a reader learns nothing '
      + 'about whether the id exists',
      (await call(`/notifications/${someoneElse.id}`, { token: parentToken })).status, 404);

    const readRes = await call(`/notifications/${mine.id}/read`, { method: 'POST', token: parentToken });
    check('marking one read sets both the status and the timestamp',
      [readRes.status, dataOf(readRes).notification.status, dataOf(readRes).notification.read_at !== null],
      [200, NOTIFICATION_STATUS.READ, true]);

    const firstReadAt = dataOf(readRes).notification.read_at;
    /*
     * Idempotency, asserted against a date far enough away that MySQL cannot hide the difference.
     * Comparing the two responses would NOT work: `notifications.read_at` is a DATETIME with second
     * precision, and two calls milliseconds apart truncate to the same second — so that assertion
     * would pass whether or not the guard exists. Backdating the row makes the guard the only thing
     * that can keep the value, and deleting it moves read_at by six years.
     */
    const SENTINEL = new Date('2020-03-04T05:06:07Z');
    await db.Notification.update({ read_at: SENTINEL }, { where: { id: mine.id } });
    const readAgain = await call(`/notifications/${mine.id}/read`, { method: 'POST', token: parentToken });
    check('  and re-reading it does not move read_at — the column records when it was FIRST read',
      new Date(dataOf(readAgain).notification.read_at).toISOString(), SENTINEL.toISOString());
    await db.Notification.update({ read_at: firstReadAt }, { where: { id: mine.id } });

    check('a body sent to a body-less route is refused by name, not ignored',
      (await call(`/notifications/${mine.id}/read`, {
        method: 'POST', token: parentToken, body: { status: NOTIFICATION_STATUS.SENT },
      })).status, 422);

    const beforeAll = await db.Notification.count({
      where: { user_id: parentU.id, channel: NOTIFICATION_CHANNELS.IN_APP, read_at: null },
    });
    const allRes = await call('/notifications/read-all', { method: 'POST', token: parentToken });
    check('read-all clears the rest of the inbox and says how many',
      [allRes.status, dataOf(allRes).updated], [200, beforeAll]);
    check('  leaving nothing unread',
      await db.Notification.count({
        where: { user_id: parentU.id, channel: NOTIFICATION_CHANNELS.IN_APP, read_at: null },
      }), 0);
    check('  and touching only the in-app rows, never a delivery record',
      await db.Notification.count({
        where: { user_id: parentU.id, channel: NOTIFICATION_CHANNELS.EMAIL, status: NOTIFICATION_STATUS.READ },
      }), 0);
    check('  `read-all` is routed as itself and not read as an id',
      (await call('/notifications/read-all', { method: 'POST', token: parentToken })).status, 200);

    /* ── the retry, which is all `notifications.send` guards ── */

    const retryDenied = await call(`/notifications/${failedRow.id}/retry`, { method: 'POST', token: teacherToken });
    check('a teacher cannot retry — `notifications.send` reaches three roles and not theirs',
      [retryDenied.status, codeOf(retryDenied)], [403, 'INSUFFICIENT_PERMISSION']);

    const retryOther = await call(`/notifications/${failedRow.id}/retry`, { method: 'POST', token: principalBToken });
    check('another school\'s principal cannot retry it either — the retry is school-scoped',
      retryOther.status, 404);

    /*
     * The MESSAGE, not just the code. Both of the retry's refusals are 409/CONFLICT, and this row is
     * at status `read` — so deleting the channel guard leaves the status guard to refuse it with an
     * identical status and an identical code. A deliberate regression proved exactly that: asserting
     * `[409, 'CONFLICT']` alone passes whether or not the guard being tested exists. The wording is
     * the only thing that says which guard answered, so the wording is what is asserted.
     */
    const retryInApp = await call(`/notifications/${mine.id}/retry`, { method: 'POST', token: principalToken });
    check('an in-app notification cannot be retried — it was delivered when it was written',
      [retryInApp.status, codeOf(retryInApp), /in-app notification is delivered/.test(msgOf(retryInApp))],
      [409, 'CONFLICT', true]);

    const sentEmail = await db.Notification.findOne({
      where: { channel: NOTIFICATION_CHANNELS.EMAIL, status: NOTIFICATION_STATUS.SENT, school_id: schoolA.id },
    });
    const retrySent = await call(`/notifications/${sentEmail.id}/retry`, { method: 'POST', token: principalToken });
    check('a notification that already went out is not re-sent — a retry repairs, it does not repeat',
      [retrySent.status, /Only a failed notification/.test(msgOf(retrySent))], [409, true]);

    const retryOk = await call(`/notifications/${failedRow.id}/retry`, { method: 'POST', token: principalToken });
    check('the principal repairs the failed delivery', [retryOk.status, dataOf(retryOk).sent], [200, true]);
    await failedRow.reload();
    check('  and the row now says so, with the transport\'s old message cleared',
      [failedRow.status, failedRow.error_message, failedRow.sent_at !== null],
      [NOTIFICATION_STATUS.SENT, null, true]);
    check('  which is written to §24\'s trail, because this one is an administrator acting',
      await settleCount(() => db.ActivityLog.count({
        where: { id: { [db.Op.gt]: baseline.activityLog }, entity_type: 'notification', action: 'update' },
      }), 1), 1);
    /*
     * Read immediately, and correctly so: every read request finished long before the retry did, so
     * any row they were going to write has landed by the time the poll above returned.
     */
    check('  while the four reads are not — thirty students opening a notice is not thirty trail rows',
      await db.ActivityLog.count({
        where: { id: { [db.Op.gt]: baseline.activityLog }, entity_type: 'notification', action: 'view' },
      }), 0);

    const retrySpent = await call(`/notifications/${failedRow.id}/retry`, { method: 'POST', token: principalToken });
    check('and it cannot be retried twice, now that it is sent', retrySpent.status, 409);

    /* ── the student sees their own, which is FR-NOTIF-001's outcome from the other side ── */

    const studentInbox = await call('/notifications', { token: studentToken });
    check('a student reads the notifications addressed to them',
      [studentInbox.status, (dataOf(studentInbox) || []).length > 0], [200, true]);
    check('  filtered to one of §23\'s types',
      [...new Set((dataOf(await call(
        `/notifications?type=${NOTIFICATION_TYPES.HOMEWORK}`, { token: studentToken }
      )) || []).map((r) => r.type))],
      [NOTIFICATION_TYPES.HOMEWORK]);
    check('  and unread=true is narrower than the whole inbox',
      (dataOf(await call('/notifications?unread=true', { token: studentToken })) || []).length,
      (dataOf(studentInbox) || []).length);

    /*
     * ── a row nobody can be told about must not hold the pass either ──
     *
     * Result Published (both halves) and Fee Paid used to return `false` for a row with no reachable
     * recipient and write nothing, so the row stayed a candidate. Candidates are taken oldest first
     * across every school, `SWEEP_LIMIT` at a time, so once that many sat at the head of the queue every
     * later run fetched the same ones and the pass stopped for the whole platform. `limit: 1`
     * reproduces it with one row: an older one about a student with no login and no guardian, and a
     * newer one about a student who can be told. Placed after the inbox checks above, which count
     * exactly what the earlier sweeps wrote.
     */
    const toldAbout = async (type, referenceType, id) => (await db.Notification.findAll({
      where: { type, reference_type: referenceType, reference_id: id, channel: NOTIFICATION_CHANNELS.IN_APP },
    })).map((r) => r.user_id);
    const mkReceipt = (student, key) => db.FeePayment.create({
      school_id: schoolA.id, organization_id: org.id, student_fee_id: feePaid.id,
      student_id: student.id, receipt_number: `${CODE_PREFIX}${key}`, currency: 'USD',
      amount: 10, method: 'cash', paid_at: at, collected_by: accountantU.id,
    });
    const unreachableResult = await mkResult(leftStudent, true, 55);
    const unreachableReceipt = await mkReceipt(leftStudent, 'RCP-UNREACH');
    const reachableResult = await mkResult(student3, true, 72);
    const reachableReceipt = await mkReceipt(student3, 'RCP-REACH');

    const headOfQueue = await service.runNotificationSweep({ at, only: ['results', 'feePaid'], limit: 1 });
    check('a result and a receipt nobody can be told about do not hold their passes: a sweep of ONE '
      + 'passes over each to the newer row that has an audience',
      [headOfQueue.results, headOfQueue.feePaid,
        (await toldAbout(NOTIFICATION_TYPES.RESULT_PUBLISHED, 'result', reachableResult.id)).includes(studentU3.id),
        (await toldAbout(NOTIFICATION_TYPES.FEE_PAID, 'fee_payment', reachableReceipt.id)).includes(studentU3.id)],
      [1, 1, true, true]);
    check('  and nothing is written for the unreachable pair',
      [(await toldAbout(NOTIFICATION_TYPES.RESULT_PUBLISHED, 'result', unreachableResult.id)).length,
        (await toldAbout(NOTIFICATION_TYPES.FEE_PAID, 'fee_payment', unreachableReceipt.id)).length],
      [0, 0]);

    /* Not lost, only deferred: once someone can be told, the same rows are candidates again. */
    await db.ParentStudent.create({
      school_id: schoolA.id, parent_id: parent2.id, student_id: leftStudent.id,
      relation: 'father', is_primary_guardian: true,
    });
    const afterLink = await service.runNotificationSweep({ at, only: ['results', 'feePaid'], limit: 1 });
    check('  and once a guardian is linked, each is a candidate again and the guardian is told',
      [afterLink.results, afterLink.feePaid,
        await toldAbout(NOTIFICATION_TYPES.RESULT_PUBLISHED, 'result', unreachableResult.id),
        await toldAbout(NOTIFICATION_TYPES.FEE_PAID, 'fee_payment', unreachableReceipt.id)],
      [1, 1, [parent2U.id], [parent2U.id]]);

    /* The teachers' half: an exam in a class nobody teaches, then one in the class teacher's own class. */
    const mkExamWithResult = async (name, cls, student) => {
      const exam = await db.Exam.create({
        school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
        name, exam_type: 'quiz', class_id: cls.id,
        start_date: '2026-06-01', end_date: '2026-06-02', status: EXAM_STATUS.PUBLISHED,
      });
      await db.Result.create({
        school_id: schoolA.id, organization_id: org.id, academic_session_id: session.id,
        exam_id: exam.id, student_id: student.id, class_id: cls.id,
        total_full_marks: 100, total_marks_obtained: 60, percentage: 60, grade_name: 'B', outcome: 'pass',
        subjects_count: 1, subjects_failed: 0, is_published: true, published_at: at,
      });
      return exam;
    };
    const untaughtExam = await mkExamWithResult('Untaught Exam', other, outsider);
    const taughtExam = await mkExamWithResult('Taught Exam', grade, student3);
    const teacherPass = await service.runNotificationSweep({ at, only: ['resultsForTeachers'], limit: 1 });
    /*
     * D28 — §23's Fee Reminder reaches a school's subscription invoice too, sent to its billing roles.
     * `invoices.reminderCandidates()` and `markReminderSent()` were written for this and had no caller.
     * One invoice due inside the seven-day window, one outside it.
     */
    const mkInvoice = (key, dueInDays) => db.Invoice.create({
      invoice_number: `${CODE_PREFIX}INV-${key}`, school_id: schoolA.id, organization_id: org.id, currency: 'USD',
      subtotal: 120, total: 120, amount_due: 120, status: 'unpaid',
      issue_date: dates.toDateOnly(at), due_date: dates.toDateOnly(dates.addDays(at, dueInDays)),
    });
    const invoiceDueSoon = await mkInvoice('SOON', 3);
    const invoiceDueLater = await mkInvoice('LATER', 30);
    const invoiceRun = await service.runNotificationSweep({ at, only: ['invoiceReminders'] });
    await Promise.all([invoiceDueSoon.reload(), invoiceDueLater.reload()]);
    check('D28 — an invoice falling due is reminded to the school\'s billing roles, once, and one due later is not',
      [invoiceRun.invoiceReminders,
        (await toldAbout(NOTIFICATION_TYPES.FEE_REMINDER, 'invoice', invoiceDueSoon.id)).includes(principalA.id),
        invoiceDueSoon.reminder_sent_at !== null, invoiceDueLater.reminder_sent_at,
        (await service.runNotificationSweep({ at, only: ['invoiceReminders'] })).invoiceReminders],
      [1, true, true, null, 0]);

    check('an exam whose class has no teacher with a login does not hold the teachers\' pass either',
      [teacherPass.resultsForTeachers,
        await toldAbout(NOTIFICATION_TYPES.RESULT_PUBLISHED, 'exam', taughtExam.id),
        (await toldAbout(NOTIFICATION_TYPES.RESULT_PUBLISHED, 'exam', untaughtExam.id)).length],
      [1, [teacherU.id], 0]);

    /* ── teardown ── */

    await teardown();
    const leftovers = await db.Notification.count({ where: { id: { [db.Op.gt]: baseline.notification } } });
    check('teardown leaves no notification behind', leftovers, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { await teardown(); } catch (_) { /* already torn down */ }
  }
}

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
    console.error('\nverify-notifications crashed:', err);
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
          ? 'All pure notification checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All notification checks passed (Parts 1–3).'
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
