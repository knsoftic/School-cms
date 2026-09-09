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
 * Verification of Phase 3.L fees — `src/modules/fees/*` — SRS §17, FR-FEE-001 (fee structure
 * definition) and FR-FEE-002 (collection and partial payment).
 *
 * This is the first **school-side** module that moves money, so the assertions that matter most are
 * arithmetic ones, and every one of them is against a **hand-computed** figure rather than against
 * whatever the code returned. A test that re-derives the answer the same way the implementation does
 * cannot fail when the implementation is wrong — the lesson `verify-attendance.js` was written around
 * for the §16 percentage, and it applies twice over to a ledger.
 *
 * Carried in from the four §15/§16 audits:
 *
 *  - **Rows exist outside school A.** School D keeps its own structures, fees and payments, so every
 *    tenant-scoping assertion has a counter-example to exclude and deleting `tenantWhere` fails it.
 *  - **An organization-scoped caller exists** (`organization_id` set, `school_id` NULL), so
 *    `tenantWhere`'s second branch actually runs.
 *  - **Enums are asserted schema-against-model**, never constant-against-itself: the accepted lists are
 *    compared to `db.FeeStructure.rawAttributes.component.values` and friends, read off the model.
 *  - **Both `DATEONLY` columns are round-tripped at a flipped `process.env.TZ`** — `due_date` and
 *    `period_month`, not one of the two.
 *
 * Two assertions exist specifically to pin decisions a reader would otherwise have to take on trust:
 * the receipt series restarts per school (the `scope` added to `documentNumber.nextNumber`), and
 * `isDuplicateNumber()` matches the **index** name but not the column name — which is why the service
 * hands `withRetry` the index. Both would be silently wrong without a test.
 *
 * Part 1 — request schemas and the pure ledger arithmetic (no database).
 * Part 2 — the declared route table and the router-level guard.
 * Part 3 — over real HTTP against the real database.
 *
 * Run: node scripts/verify-fees.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const documentNumber = require('../src/utils/documentNumber');
const { settle, settleDistinct } = require('./lib/settle');

const feeRoutes = require('../src/modules/fees/fees.routes');
const { schemas } = require('../src/modules/fees/fees.validation');
const feesService = require('../src/modules/fees/fees.service');

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
  FEE_COMPONENTS,
  FEE_COMPONENT_LIST,
  STUDENT_FEE_STATUS,
  PAYMENT_METHODS,
  STUDENT_STATUS,
  ACADEMIC_SESSION_STATUS,
} = require('../src/config/constants');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-fees.local';
const PASSWORD = 'Verify@Fees123';
const CODE_PREFIX = 'VFE-';

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

/** A structure body that is valid, so a rejection can only be about the field under test. */
const STRUCTURE = {
  name: 'Monthly Tuition',
  component: FEE_COMPONENTS.MONTHLY_FEE,
  amount: 1000,
};

/** Likewise for an assignment and a payment. */
const ASSIGN = { fee_structure_id: 1, student_ids: [1], due_date: '2025-05-10' };
const PAY = { student_fee_id: 1, amount: 100, method: PAYMENT_METHODS.CASH };

/* ═══════════════════════ part 1 — schemas and the pure arithmetic ═══════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas and ledger arithmetic ──\n');

  /* ── FR-FEE-001: what makes a structure a structure ── */

  check('a complete structure validates', run(schemas.createStructure, STRUCTURE).ok, true);
  check(
    'name is required',
    run(schemas.createStructure, { component: STRUCTURE.component, amount: 1000 }).ok,
    false
  );
  check(
    'component is required — §17 defines the fee by its component',
    run(schemas.createStructure, { name: 'x', amount: 1000 }).ok,
    false
  );
  check('amount is required', run(schemas.createStructure, { name: 'x', component: STRUCTURE.component }).ok, false);

  /*
   * Schema against **model**, not against the constant the schema was built from. `enumOf(FEE_COMPONENTS)`
   * derives the column's values from the same object the schema imports, so comparing the two constants
   * would compare a thing to itself — the mistake `verify-staff.js` had to be rewritten for. These read
   * the values off the initialised model instead.
   */
  const componentColumn = db.FeeStructure.rawAttributes.component.values;
  check(
    'every component the column accepts is accepted by the schema',
    componentColumn.every((v) => run(schemas.createStructure, { ...STRUCTURE, component: v }).ok),
    true
  );
  check(
    'and the schema accepts nothing the column would reject',
    FEE_COMPONENT_LIST.filter((v) => !componentColumn.includes(v)),
    []
  );
  check('§17 names exactly four components', componentColumn.length, 4);
  check(
    'an invented fifth component is refused',
    run(schemas.createStructure, { ...STRUCTURE, component: 'library_fee' }).ok,
    false
  );

  const fineColumn = db.FeeStructure.rawAttributes.fine_type.values;
  const discountColumn = db.FeeStructure.rawAttributes.discount_type.values;
  check(
    'every fine_type the column accepts is accepted by the schema',
    fineColumn.every((v) => run(schemas.createStructure, { ...STRUCTURE, fine_type: v, fine_amount: 5 }).ok),
    true
  );
  check(
    'every discount_type the column accepts is accepted by the schema',
    discountColumn.every((v) => run(schemas.createStructure, { ...STRUCTURE, discount_type: v, discount_amount: 5 }).ok),
    true
  );
  check(
    'an off-list fine_type is refused',
    run(schemas.createStructure, { ...STRUCTURE, fine_type: 'per_hour', fine_amount: 5 }).ok,
    false
  );

  /* The columns are DECIMAL(14,2), so the schema is bounded at the column, not left open. */
  check('a money field at the column ceiling validates', run(schemas.createStructure, { ...STRUCTURE, amount: 999999999999.99 }).ok, true);
  check('one cent past it does not', run(schemas.createStructure, { ...STRUCTURE, amount: 1000000000000 }).ok, false);
  check('a negative amount is refused', run(schemas.createStructure, { ...STRUCTURE, amount: -1 }).ok, false);

  check('an update needs at least one field', run(schemas.updateStructure, {}).ok, false);
  check('one field is enough', run(schemas.updateStructure, { is_active: false }).ok, true);

  /* ── the ledger's own figures are the system's, not a caller's ── */

  for (const owned of ['net_amount', 'paid_amount', 'pending_amount', 'status']) {
    const result = run(schemas.assign, { ...ASSIGN, [owned]: 1 });
    check(`assign refuses a caller-supplied ${owned}`, result.ok, false);
    /*
     * And refuses it *for that reason*: the rest of the body is valid, so the failing path can only be
     * the forbidden key. A `.min(1)`-shaped test would go green here no matter what was rejected.
     */
    check(`  and names ${owned} as the reason`, result.keys, [owned]);
  }
  const receipt = run(schemas.pay, { ...PAY, receipt_number: 'RCP-202505-00001' });
  check('pay refuses a caller-supplied receipt_number', receipt.ok, false);
  check('  and names receipt_number as the reason', receipt.keys, ['receipt_number']);

  check('a complete assignment validates', run(schemas.assign, ASSIGN).ok, true);
  check('an assignment needs a due date — FR-FEE-002 tracks a balance against one', run(schemas.assign, { fee_structure_id: 1, student_ids: [1] }).ok, false);
  check('an assignment needs at least one student', run(schemas.assign, { ...ASSIGN, student_ids: [] }).ok, false);

  check('a complete payment validates', run(schemas.pay, PAY).ok, true);
  check('a payment needs an amount', run(schemas.pay, { student_fee_id: 1, method: PAYMENT_METHODS.CASH }).ok, false);
  check('a payment needs a method', run(schemas.pay, { student_fee_id: 1, amount: 100 }).ok, false);

  const methodColumn = db.FeePayment.rawAttributes.method.values;
  check(
    'every payment method the column accepts is accepted by the schema',
    methodColumn.every((v) => run(schemas.pay, { ...PAY, method: v }).ok),
    true
  );
  check('an off-list method is refused', run(schemas.pay, { ...PAY, method: 'cheque' }).ok, false);

  const statusColumn = db.StudentFee.rawAttributes.status.values;
  check(
    'the ledger filter offers exactly the statuses the column has',
    statusColumn.every((v) => run(schemas.listLedger, { status: v }).ok),
    true
  );

  /* ── the arithmetic, against hand-computed figures ── */

  check('net = amount − discount + fine', feesService.netOf(1000, 50, 25), 975);
  check('with no discount or fine, net is the amount', feesService.netOf(1000, 0, 0), 1000);
  check('a discount larger than the fee cannot make net negative', feesService.netOf(100, 500, 0), 0);
  /*
   * The reason `utils/money.js` exists: 0.1 + 0.2 is 0.30000000000000004 in float, and a ledger that
   * stores that has already lost. This is the assertion that fails if someone replaces the helpers
   * with `+` and `-`.
   */
  check('and it runs in minor units, not floats', feesService.netOf(0.1, 0, 0.2), 0.3);
  check('0.07 × 3 worth of components still lands on the cent', feesService.netOf(0.07, 0, 0.14), 0.21);

  check(
    'a percentage discount is of the fee',
    feesService.discountFor({ discount_type: 'percentage', discount_amount: 5 }, 1000),
    50
  );
  check(
    'a fixed discount is the amount itself',
    feesService.discountFor({ discount_type: 'fixed', discount_amount: 150 }, 1000),
    150
  );
  check(
    'none leaves the fee whole, whatever the amount column says',
    feesService.discountFor({ discount_type: 'none', discount_amount: 150 }, 1000),
    0
  );
  check(
    'a structure with no discount_type set is treated as none',
    feesService.discountFor({ discount_amount: 150 }, 1000),
    0
  );
  check(
    'a discount is clamped to the fee it discounts',
    feesService.discountFor({ discount_type: 'fixed', discount_amount: 5000 }, 1000),
    1000
  );
  check(
    'a percentage over 100 is clamped the same way',
    feesService.discountFor({ discount_type: 'percentage', discount_amount: 150 }, 1000),
    1000
  );
  check(
    'a DECIMAL read back as a string still divides correctly',
    feesService.discountFor({ discount_type: 'percentage', discount_amount: '12.50' }, '800.00'),
    100
  );

  /* ── the receipt series ── */

  check('§17 receipts carry their own prefix', documentNumber.PREFIXES.FEE_RECEIPT, 'RCP');
  check(
    'and the four billing prefixes are untouched by adding it',
    [
      documentNumber.PREFIXES.INVOICE,
      documentNumber.PREFIXES.PAYMENT,
      documentNumber.PREFIXES.REFUND,
      documentNumber.PREFIXES.QUOTATION,
    ],
    ['INV', 'PAY', 'REF', 'QTN']
  );
  check('a receipt number parses back', documentNumber.parse('RCP-202505-00001'), {
    prefix: 'RCP',
    period: '202505',
    counter: 1,
  });

  /*
   * Why `fees.service.pay()` hands `withRetry` the **index** name rather than the column.
   * `isDuplicateNumber()` substring-matches what MySQL reports, and MySQL reports the index. Billing's
   * indexes are auto-named after their column so `'invoice_number'` matches; this one is not, and
   * passing the column would silently disable the retry.
   */
  const collision = Object.assign(new Error("Duplicate entry '7-RCP-202505-00001' for key 'fee_payments_school_receipt_unique'"), {
    name: 'SequelizeUniqueConstraintError',
    fields: { fee_payments_school_receipt_unique: 'RCP-202505-00001' },
  });
  check(
    'a receipt collision is recognised by the index name the service passes',
    documentNumber.isDuplicateNumber(collision, 'fee_payments_school_receipt_unique'),
    true
  );
  check(
    'and would NOT be recognised by the column name — hence the index',
    documentNumber.isDuplicateNumber(collision, 'receipt_number'),
    false
  );
  check(
    'the index the assertion names is the one the table actually carries',
    Object.values(db.FeePayment.options.indexes || {}).some(
      (i) => i.name === 'fee_payments_school_receipt_unique' && i.unique
    ),
    true
  );
}

/* ═══════════════════════════ part 2 — the route table ═══════════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — declared routes ──\n');

  const routes = routesOf(feeRoutes);
  check('the eight §17 routes are declared', routes, [
    'GET /structures',
    'POST /structures',
    'GET /structures/:id',
    'PATCH /structures/:id',
    'POST /assignments',
    'GET /ledger',
    'POST /payments',
    'GET /payments',
  ]);

  check(
    'there is no DELETE on any of the three tables — a receipt is not deletable',
    routes.some((r) => r.startsWith('DELETE')),
    false
  );
  check(
    'and no self-service view — §17 names none, so fees.self.view stays unmounted',
    routes.some((r) => r.includes('self') || r.includes('/me')),
    false
  );
  check(
    'the literal /structures is declared before the parameterised one',
    routes.indexOf('GET /structures') < routes.indexOf('GET /structures/:id'),
    true
  );

  const writes = feeRoutes.stack
    .filter((l) => l.route && !l.route.methods.get)
    .map((l) => [Object.keys(l.route.methods)[0], l.route.path]);
  check('there are four write routes', writes.length, 4);
  check(
    'no write carries requirePlatformScope() — §17 is school-side',
    writes.every(([m, p]) => named(feeRoutes, m, p, 'platformGuard') === false),
    true
  );
  check(
    'every write carries validate()',
    writes.every(([m, p]) => named(feeRoutes, m, p, 'validateRequest')),
    true
  );
  check(
    'every write declares its activity',
    writes.every(([m, p]) => named(feeRoutes, m, p, 'activityDeclaration')),
    true
  );
  check(
    'one router-level guard, mounted ahead of every route',
    [feeRoutes.stack.filter((l) => !l.route).length, feeRoutes.stack.findIndex((l) => !l.route)],
    [1, 0]
  );

  /* No entitlement limit, asserted against the **router** rather than against a constant. */
  check(
    'no route carries an entitlement limit',
    /*
     * Read off the router's SOURCE, not off a handler name. `enforceLimit()` returns an
     * `asyncHandler`-wrapped function called `wrappedAsyncHandler`, so the obvious
     * `h.handle.name !== 'limitGuard'` check compared against a name nothing in this codebase ever
     * has — it could not fail, and it sat here green while proving nothing (§5a session 18).
     */
    mountsLimit('fees'),
    false
  );
  check(
    '  and the probe would find one — the students router does mount a limit',
    mountsLimit('students'),
    true
  );
  check(
    'and §11.2 defines no fee limit to carry',
    Object.values(LIMITS).some((k) => k.includes('fee')),
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
    if (created.schools.length) {
      await db.FeePayment.destroy({ where: { school_id: created.schools } });
      await db.StudentFee.destroy({ where: { school_id: created.schools } });
      await db.FeeStructure.destroy({ where: { school_id: created.schools } });
      await db.Student.destroy({ where: { school_id: created.schools }, force: true });
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
    for (const slug of [
      ROLES.SUPER_ADMIN,
      ROLES.ORGANIZATION_ADMIN,
      ROLES.PRINCIPAL,
      ROLES.ACCOUNTANT,
      ROLES.RECEPTIONIST,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const role = await db.Role.findOne({ where: { slug } });
      if (!role) throw new Error(`seeded role missing: ${slug}`);
      roles[slug] = role;
    }

    const org = await db.Organization.create({ name: 'Verify Fees Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Fees A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Fees B');
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify Fees C');
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Fees D');

    const mkPlan = async (code, feesEnabled) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify Fees ${code}`,
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
          is_enabled: key === MODULES.FEES ? feesEnabled : true,
        });
      }
      await db.PlanLimit.create({
        plan_id: plan.id,
        limit_key: LIMITS.STUDENT_LIMIT,
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: 100,
      });
      return plan;
    };

    const withFees = await mkPlan('WITH', true);
    const withoutFees = await mkPlan('WITHOUT', false);

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

    await subscribe(schoolA, withFees);
    await subscribe(schoolB, withoutFees);
    await subscribe(schoolD, withFees);
    /* schoolC is deliberately left unsubscribed. */

    /* Academic structure and children, created directly — their own suites cover their endpoints. */
    const session = await db.AcademicSession.create({
      school_id: schoolA.id,
      organization_id: org.id,
      name: '2025-2026',
      start_date: '2025-04-01',
      end_date: '2026-03-31',
      status: ACADEMIC_SESSION_STATUS.ACTIVE,
      is_current: true,
    });
    const mkClass = async (school, name) =>
      db.Class.create({
        school_id: school.id,
        organization_id: org.id,
        academic_session_id: school.id === schoolA.id ? session.id : null,
        name,
        numeric_order: 1,
      });
    const grade1 = await mkClass(schoolA, 'Grade 1');
    const dClass = await mkClass(schoolD, 'D Grade 1');

    const mkStudent = async (school, code, first, klass) =>
      db.Student.create({
        school_id: school.id,
        organization_id: org.id,
        student_id: code,
        first_name: first,
        last_name: 'Payer',
        admission_date: '2025-04-01',
        status: STUDENT_STATUS.ACTIVE,
        class_id: klass ? klass.id : null,
        academic_session_id: school.id === schoolA.id ? session.id : null,
      });
    const kids = [];
    for (const [code, name] of [
      [`${CODE_PREFIX}S1`, 'Amina'],
      [`${CODE_PREFIX}S2`, 'Bilal'],
      [`${CODE_PREFIX}S3`, 'Chidi'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      kids.push(await mkStudent(schoolA, code, name, grade1));
    }
    /* A child outside school A, so every scoping assertion has something to exclude. */
    const dKid = await mkStudent(schoolD, `${CODE_PREFIX}D1`, 'Dee', dClass);

    const password_hash = await hashPassword(PASSWORD);
    const people = [
      ['platform', ROLES.SUPER_ADMIN, 'Verify FE Platform', 'vfe_platform', null, null],
      ['principal-a', ROLES.PRINCIPAL, 'Verify FE Principal A', 'vfe_principal_a', org.id, schoolA.id],
      ['principal-b', ROLES.PRINCIPAL, 'Verify FE Principal B', 'vfe_principal_b', org.id, schoolB.id],
      ['principal-c', ROLES.PRINCIPAL, 'Verify FE Principal C', 'vfe_principal_c', org.id, schoolC.id],
      ['principal-d', ROLES.PRINCIPAL, 'Verify FE Principal D', 'vfe_principal_d', org.id, schoolD.id],
      ['accountant', ROLES.ACCOUNTANT, 'Verify FE Accountant', 'vfe_accountant', org.id, schoolA.id],
      ['receptionist', ROLES.RECEPTIONIST, 'Verify FE Receptionist', 'vfe_reception', org.id, schoolA.id],
      /* organization_id set, school_id NULL — `tenantWhere`'s second branch. */
      ['org-admin', ROLES.ORGANIZATION_ADMIN, 'Verify FE Org Admin', 'vfe_org', org.id, null],
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
    const accountant = await signIn(`accountant@${DOMAIN}`);
    const receptionist = await signIn(`receptionist@${DOMAIN}`);
    const orgAdmin = await signIn(`org-admin@${DOMAIN}`);

    /* ── the entitlement guard ── */

    const moduleDenied = await call('/fees/structures', { token: principalB });
    check('a plan without the Fees module refuses', moduleDenied.status, 403);
    check('and names the module', codeOf(moduleDenied), 'MODULE_NOT_SUBSCRIBED');
    check('naming which one', moduleDenied.body.error.details.missing, [MODULES.FEES]);

    const noSub = await call('/fees/structures', { token: principalC });
    check('a school with no subscription is refused differently', noSub.status, 402);
    check('state is checked before module', codeOf(noSub), 'SUBSCRIPTION_INACTIVE');

    /* ── FR-FEE-001 — the school defines a structure ── */

    const monthlyRes = await expectOk(
      '/fees/structures',
      {
        method: 'POST',
        token: accountant,
        body: {
          name: 'Monthly Tuition',
          component: FEE_COMPONENTS.MONTHLY_FEE,
          amount: 1000,
          class_id: grade1.id,
          academic_session_id: session.id,
          is_recurring: true,
          due_day: 10,
          discount_type: 'percentage',
          discount_amount: 5,
        },
      },
      201
    );
    const monthly = dataOf(monthlyRes).structure;
    check('an Accountant may define a structure — FR-FEE-001 names them', Boolean(monthly.id), true);
    check('the component is stored as §17 names it', monthly.component, FEE_COMPONENTS.MONTHLY_FEE);
    /*
     * A DECIMAL column crosses the wire as a **number**, not the fixed-2 string mysql2 returns by
     * default: `config/database.js:59` sets `decimalNumbers: true` for the whole pool. Asserted here
     * because that is a project-wide contract a fee assertion depends on, and because the opposite is
     * what a reader coming from the raw driver would expect — the §5a note about DECIMAL under
     * `raw: true` is the same fact seen from the other side.
     */
    check('a money column crosses the wire as a number, not a fixed-2 string', typeof monthly.amount, 'number');
    check('carrying the amount it was given', monthly.amount, 1000);
    check('the school is taken from the caller, never the body', monthly.school_id, schoolA.id);
    check('and so is the organization', monthly.organization_id, org.id);

    const examRes = await expectOk(
      '/fees/structures',
      {
        method: 'POST',
        token: principalA,
        body: { name: 'Term Exam', component: FEE_COMPONENTS.EXAM_FEE, amount: 200 },
      },
      201
    );
    const exam = dataOf(examRes).structure;
    check('a Principal may define one too — FR-FEE-001 names them as well', Boolean(exam.id), true);
    /*
     * Read back rather than taken off the create response: a Sequelize instance returned straight from
     * `create()` has no value for a nullable column the caller never set, so the create response omits
     * the key entirely. The stored row is what "applies school-wide" is a claim about.
     */
    check(
      'a structure with no class applies school-wide',
      dataOf(await expectOk(`/fees/structures/${exam.id}`, { token: principalA }, 200)).structure.class_id,
      null
    );

    /*
     * ── `q` actually filters ──
     *
     * `listQuery()` concatenates `commonSchemas.search`, so `?q=` has always validated cleanly — and
     * `listStructures()` never read it. The screen's "Name or component…" box therefore returned
     * **every** structure with 200 OK: not an error, a *silent wrong answer*, which is the harder kind
     * to notice. Nothing here caught it because every existing list assertion either passes no `q` or
     * checks a different filter.
     *
     * The load-bearing one is the last: a term matching nothing must return **zero**. Under the old
     * code it returned everything, so an assertion that only checked "the right row is present" would
     * have passed against a completely unfiltered list.
     */
    const namesFor = async (q) => (
      dataOf(await expectOk(`/fees/structures?q=${encodeURIComponent(q)}`, { token: principalA }, 200)) || []
    ).map((row) => row.name).sort();

    check('q matches a structure by name', await namesFor('Tuition'), ['Monthly Tuition']);
    check('  and the other one by its own name', await namesFor('Term'), ['Term Exam']);
    check('  and by component, which the placeholder also offers',
      await namesFor('exam_fee'), ['Term Exam']);
    check('  and a term that matches nothing returns nothing, not everything',
      await namesFor('no-such-fee-anywhere'), []);

    const transportRes = await expectOk(
      '/fees/structures',
      {
        method: 'POST',
        token: accountant,
        body: { name: 'Bus Route 3', component: FEE_COMPONENTS.TRANSPORT_FEE, amount: 0.1 },
      },
      201
    );
    const transport = dataOf(transportRes).structure;

    /* The FR-FEE-001 / FR-FEE-002 actor split, which is the one place the two lists genuinely differ. */
    const receptionStructure = await call('/fees/structures', {
      method: 'POST',
      token: receptionist,
      body: { name: 'Not theirs', component: FEE_COMPONENTS.ADMISSION_FEE, amount: 50 },
    });
    check('a Receptionist may not define a structure — FR-FEE-001 does not name them', receptionStructure.status, 403);
    check('  and is told it is the permission that is missing', codeOf(receptionStructure), 'INSUFFICIENT_PERMISSION');

    /* The model's own validator: a discount type with nothing to discount. */
    const emptyDiscount = await call('/fees/structures', {
      method: 'POST',
      token: accountant,
      body: { name: 'Bad', component: FEE_COMPONENTS.ADMISSION_FEE, amount: 100, discount_type: 'percentage' },
    });
    check('a discount_type with a zero amount is refused', emptyDiscount.status, 422);

    /* A structure at school D, so the listing has something to exclude. */
    const dStructRes = await expectOk(
      '/fees/structures',
      {
        method: 'POST',
        token: principalD,
        body: { name: 'D Monthly', component: FEE_COMPONENTS.MONTHLY_FEE, amount: 700 },
      },
      201
    );
    const dStruct = dataOf(dStructRes).structure;

    const listA = await expectOk('/fees/structures', { token: principalA }, 200);
    const listAIds = dataOf(listA).map((s) => s.id);
    check('a school sees its own structures', listAIds.includes(monthly.id), true);
    check("and not another school's — the counter-example exists", listAIds.includes(dStruct.id), false);
    check(
      "and school D's principal sees the mirror image",
      (dataOf(await expectOk('/fees/structures', { token: principalD }, 200)) || []).map((s) => s.id),
      [dStruct.id]
    );

    const filtered = await expectOk(`/fees/structures?component=${FEE_COMPONENTS.EXAM_FEE}`, { token: principalA }, 200);
    check('the component filter narrows the list', dataOf(filtered).map((s) => s.id), [exam.id]);

    const shown = await expectOk(`/fees/structures/${monthly.id}`, { token: principalA }, 200);
    check('a structure can be read back by id', dataOf(shown).structure.name, 'Monthly Tuition');
    const foreignShow = await call(`/fees/structures/${dStruct.id}`, { token: principalA });
    check("another school's structure is not found, not merely forbidden", foreignShow.status, 404);
    check('  and says so', codeOf(foreignShow), 'FEE_STRUCTURE_NOT_FOUND');

    /* ── assignment — the bridge FR-FEE-001 and FR-FEE-002 both name ── */

    const assignedRes = await expectOk(
      '/fees/assignments',
      {
        method: 'POST',
        token: accountant,
        body: {
          fee_structure_id: monthly.id,
          student_ids: kids.map((k) => k.id),
          due_date: '2025-05-10',
          period_month: '2025-05-01',
        },
      },
      201
    );
    const assigned = dataOf(assignedRes).fees;
    check('one call assigns the structure to every named child', assigned.length, 3);
    check('each row carries an id the collector can pay against', assigned.every((f) => Number.isInteger(f.id)), true);
    /* 1000 − 5% = 950, hand-computed: the structure's percentage discount is applied at assignment. */
    check("the structure's percentage discount is carried onto the fee", Number(assigned[0].discount_amount), 50);
    check('net = 1000 − 50 + 0', Number(assigned[0].net_amount), 950);
    check('nothing is paid yet', Number(assigned[0].paid_amount), 0);
    check('so the whole net is pending — §17 "Pending Fee"', Number(assigned[0].pending_amount), 950);
    check('and the status says so', assigned[0].status, STUDENT_FEE_STATUS.UNPAID);
    check('the due date is stored as a plain date', assigned[0].due_date, '2025-05-10');
    check('and so is the period it covers', assigned[0].period_month, '2025-05-01');
    check('the title defaults to the structure it came from', assigned[0].title, 'Monthly Tuition');
    check('the creator is recorded on the row', Boolean(assigned[0].created_by), true);

    /* An override at assignment time, and the float-drift case in one. */
    const driftRes = await expectOk(
      '/fees/assignments',
      {
        method: 'POST',
        token: accountant,
        body: {
          fee_structure_id: transport.id,
          student_ids: [kids[0].id],
          due_date: '2025-05-20',
          fine_amount: 0.2,
        },
      },
      201
    );
    const drift = dataOf(driftRes).fees[0];
    check('a fine set on the assignment lands on the fee', Number(drift.fine_amount), 0.2);
    check('and 0.10 + 0.20 is 0.30 on the ledger, not 0.30000000000000004', drift.net_amount, 0.3);

    const overrideRes = await expectOk(
      '/fees/assignments',
      {
        method: 'POST',
        token: accountant,
        body: {
          fee_structure_id: exam.id,
          student_ids: [kids[0].id],
          due_date: '2025-06-01',
          discount_amount: 25,
        },
      },
      201
    );
    const examFee = dataOf(overrideRes).fees[0];
    check('an explicit discount overrides the structure', Number(examFee.discount_amount), 25);
    check('net = 200 − 25', Number(examFee.net_amount), 175);

    /* A receptionist may take money; they may not decide what is owed. */
    const receptionAssign = await call('/fees/assignments', {
      method: 'POST',
      token: receptionist,
      body: { fee_structure_id: exam.id, student_ids: [kids[1].id], due_date: '2025-06-01' },
    });
    check('a Receptionist may not assign a fee either — that is the FR-FEE-001 half', receptionAssign.status, 403);

    const foreignStudent = await call('/fees/assignments', {
      method: 'POST',
      token: accountant,
      body: { fee_structure_id: exam.id, student_ids: [kids[0].id, dKid.id], due_date: '2025-06-01' },
    });
    check("a child of another school cannot be assigned this school's fee", foreignStudent.status, 422);

    const twice = await call('/fees/assignments', {
      method: 'POST',
      token: accountant,
      body: { fee_structure_id: exam.id, student_ids: [kids[1].id, kids[1].id], due_date: '2025-06-01' },
    });
    check('the same child twice in one request is a mistake, not last-one-wins', twice.status, 422);

    /*
     * And the same child twice across two requests — the double-click. `student_fees` has no unique
     * index and §35 forbids adding one, so the only thing standing between a family and two May
     * tuitions is `alreadyAssigned()`. Deleting that guard makes these three assertions fail, which is
     * the point of writing them.
     */
    const again = await call('/fees/assignments', {
      method: 'POST',
      token: accountant,
      body: {
        fee_structure_id: monthly.id,
        student_ids: [kids[1].id],
        due_date: '2025-05-10',
        period_month: '2025-05-01',
      },
    });
    check('assigning the same fee for the same period again is refused', again.status, 409);
    check('  as a double-bill, named', codeOf(again), 'FEE_PERIOD_ALREADY_ASSIGNED');
    /* Read defensively: when this regresses the response is a 201 with no `error`, and an assertion
     * that throws on the way to failing tells a reader less than one that reports the wrong value. */
    check(
      '  naming the child it would have charged twice',
      ((again.body && again.body.error && again.body.error.details) || {}).student_ids,
      [kids[1].id]
    );
    check(
      'and the child still carries exactly one May tuition',
      await db.StudentFee.count({
        where: { student_id: kids[1].id, component: FEE_COMPONENTS.MONTHLY_FEE, period_month: '2025-05-01' },
      }),
      1
    );
    /* A different month is not a double-bill, so it goes through. */
    const june = await expectOk(
      '/fees/assignments',
      {
        method: 'POST',
        token: accountant,
        body: {
          fee_structure_id: monthly.id,
          student_ids: [kids[1].id],
          due_date: '2025-06-10',
          period_month: '2025-06-01',
        },
      },
      201
    );
    check('but the next month is a different fee, and is allowed', dataOf(june).fees[0].period_month, '2025-06-01');

    /*
     * ── The null-period consequence, pinned rather than left incidental — triage finding 20 ──
     *
     * `period_month` is optional and normalises to `null`, so `alreadyAssigned()` emits
     * `period_month IS NULL` and the guard's triple degenerates to `(student, component)`. A second
     * period-less fee of the same component is therefore refused **for the life of the record**, and
     * the refusal says "for this period" when the caller named none.
     *
     * This is asserted because it is a limitation, not because it is desirable. §17 states no
     * once-per-student rule and every available repair invents one — see the long note beside the
     * guard in `fees.service.js`. What an assertion buys is that the behaviour cannot change by
     * accident: whoever settles the open question will have to come here and say so.
     *
     * Deliberately on `exam_fee`, which the §17 component list names and which a school assigns per
     * examination rather than per month — the case where a null period is most natural.
     */
    const firstExam = await expectOk(
      '/fees/assignments',
      {
        method: 'POST',
        token: accountant,
        body: { fee_structure_id: exam.id, student_ids: [kids[2].id], due_date: '2025-07-01' },
      },
      201
    );
    check('a fee may be assigned with no period at all', dataOf(firstExam).fees[0].period_month, null);

    const secondExam = await call('/fees/assignments', {
      method: 'POST',
      token: accountant,
      body: { fee_structure_id: exam.id, student_ids: [kids[2].id], due_date: '2025-12-01' },
    });
    check(
      'and a SECOND period-less fee of the same component is then refused — the known limitation',
      [secondExam.status, codeOf(secondExam)],
      [409, 'FEE_PERIOD_ALREADY_ASSIGNED']
    );
    /*
     * The escape that does exist, asserted so the limitation is bounded rather than absolute: naming a
     * period sidesteps it, because the triple stops degenerating. No error message says so, which is
     * part of what finding 20 records.
     */
    const datedExam = await expectOk(
      '/fees/assignments',
      {
        method: 'POST',
        token: accountant,
        body: {
          fee_structure_id: exam.id,
          student_ids: [kids[2].id],
          due_date: '2025-12-01',
          period_month: '2025-12-01',
        },
      },
      201
    );
    check('  while the same fee WITH a period goes through, which is the only escape',
      dataOf(datedExam).fees[0].period_month, '2025-12-01');

    /*
     * The pairing a platform caller could otherwise break: the structure and the students coming from
     * different schools.
     *
     * This answers **404, not the 422** it did when the assertion was first written, and the change is
     * the point. `findStructure()` used to discard a platform caller's named school (`!isPlatform &&
     * named`), so the structure was found wherever it lived and only `assign()`'s own cross-school
     * check refused it. That exclusion was a defect in its own right — §5a session 18 — and removing it
     * moves the refusal one step earlier: the structure is simply not in the school the caller named.
     *
     * 404 is also the better answer. It matches how this suite already treats a cross-school read a few
     * assertions above ("another school's structure is not found, not merely forbidden") and it does not
     * confirm to the caller that the row exists somewhere else. `assign()`'s explicit 422 check is kept
     * as defence in depth but is no longer reachable through the API.
     */
    const crossSchool = await call('/fees/assignments', {
      method: 'POST',
      token: platform,
      body: {
        school_id: schoolA.id,
        fee_structure_id: dStruct.id,
        student_ids: [kids[0].id],
        due_date: '2025-06-01',
      },
    });
    check("a platform caller cannot assign another school's structure", crossSchool.status, 404);
    check('  because it is not in the school they named', codeOf(crossSchool), 'FEE_STRUCTURE_NOT_FOUND');

    /* ── FR-FEE-002 — collection, in full or in part ── */

    const first = await expectOk(
      '/fees/payments',
      {
        method: 'POST',
        token: receptionist,
        body: {
          student_fee_id: assigned[0].id,
          amount: 300,
          method: PAYMENT_METHODS.CASH,
          paid_at: '2025-05-15T10:00:00.000Z',
        },
      },
      201
    );
    const firstPayment = dataOf(first).payment;
    const afterFirst = dataOf(first).fee;
    check('a Receptionist may collect — FR-FEE-002 names them', Boolean(firstPayment.id), true);
    check('the system generates a Payment Receipt', firstPayment.receipt_number, 'RCP-202505-00001');
    check('the collector is recorded on it', Boolean(firstPayment.collected_by), true);
    check('a partial payment is recorded in full', Number(firstPayment.amount), 300);
    check('the ledger reflects what was paid', Number(afterFirst.paid_amount), 300);
    check('950 − 300 = 650 pending', Number(afterFirst.pending_amount), 650);
    check('and the status is partially_paid — §17 "Partial Payment"', afterFirst.status, STUDENT_FEE_STATUS.PARTIALLY_PAID);
    check('nothing is marked settled yet', afterFirst.paid_at, null);

    const second = await expectOk(
      '/fees/payments',
      {
        method: 'POST',
        token: accountant,
        body: {
          student_fee_id: assigned[0].id,
          amount: 650,
          method: PAYMENT_METHODS.BANK_TRANSFER,
          reference: 'TXN-88214',
          paid_at: '2025-05-20T10:00:00.000Z',
        },
      },
      201
    );
    const afterSecond = dataOf(second).fee;
    check('the second receipt continues the series', dataOf(second).payment.receipt_number, 'RCP-202505-00002');
    check('300 + 650 = 950 paid', Number(afterSecond.paid_amount), 950);
    check('nothing left pending', Number(afterSecond.pending_amount), 0);
    check('and the fee is settled', afterSecond.status, STUDENT_FEE_STATUS.PAID);
    check('with the moment it was settled recorded', Boolean(afterSecond.paid_at), true);

    /*
     * The balance is re-derived from the payments, not incremented — so a payment deleted behind the
     * API's back would change it. Proving that here rather than trusting the comment: delete one row
     * directly, re-post nothing, and pay a cent; the recompute must fall back to 650 + 1, not 951.
     */
    await db.FeePayment.destroy({ where: { id: firstPayment.id } });
    const recomputed = await expectOk(
      '/fees/payments',
      {
        method: 'POST',
        token: accountant,
        body: {
          student_fee_id: assigned[0].id,
          amount: 1,
          method: PAYMENT_METHODS.CASH,
          paid_at: '2025-05-21T10:00:00.000Z',
        },
      },
      201
    );
    check(
      'paid_amount is a SUM of the payments, not a running total that was incremented',
      Number(dataOf(recomputed).fee.paid_amount),
      651
    );
    check('so the pending balance follows the payments too', Number(dataOf(recomputed).fee.pending_amount), 299);
    check('and the status falls back with it', dataOf(recomputed).fee.status, STUDENT_FEE_STATUS.PARTIALLY_PAID);

    /* Overpayment: the fee settles, the balance does not go negative. */
    const over = await expectOk(
      '/fees/payments',
      {
        method: 'POST',
        token: accountant,
        body: {
          student_fee_id: examFee.id,
          amount: 200,
          method: PAYMENT_METHODS.CASH,
          paid_at: '2025-05-22T10:00:00.000Z',
        },
      },
      201
    );
    check('paying more than the net settles the fee', dataOf(over).fee.status, STUDENT_FEE_STATUS.PAID);
    check('and the balance clamps at zero rather than going negative', Number(dataOf(over).fee.pending_amount), 0);
    check('while the payment itself is recorded at what was handed over', Number(dataOf(over).payment.amount), 200);

    const zero = await call('/fees/payments', {
      method: 'POST',
      token: accountant,
      body: { student_fee_id: drift.id, amount: 0, method: PAYMENT_METHODS.CASH },
    });
    check('a zero payment is not a payment', zero.status, 422);

    /* `fine_paid` is documented as a portion of the payment, so it cannot exceed it. */
    const impossibleFine = await call('/fees/payments', {
      method: 'POST',
      token: accountant,
      body: { student_fee_id: assigned[1].id, amount: 100, method: PAYMENT_METHODS.CASH, fine_paid: 150 },
    });
    check('a fine larger than the payment it came out of is refused', impossibleFine.status, 422);

    /*
     * `discount_given` is recorded on the receipt and moves nothing. §17 puts the Discount on the
     * structure, so a collector knocking money off at the counter would be a second discount mechanism
     * the source does not describe. Asserted so the inertness is a decision on the record.
     */
    const annotated = await expectOk(
      '/fees/payments',
      {
        method: 'POST',
        token: accountant,
        body: {
          student_fee_id: assigned[1].id,
          amount: 100,
          method: PAYMENT_METHODS.CASH,
          discount_given: 40,
          paid_at: '2025-05-23T10:00:00.000Z',
        },
      },
      201
    );
    check('discount_given is recorded on the receipt', Number(dataOf(annotated).payment.discount_given), 40);
    check('but the balance moves only on the amount actually handed over', Number(dataOf(annotated).fee.paid_amount), 100);
    check('so 950 − 100 is still pending, not 950 − 140', Number(dataOf(annotated).fee.pending_amount), 850);

    /* ── two payments at once, against one fee (row 6.14) ── */

    /*
     * **The assertion this suite was missing.** `fees.service.js:513-517` reads the `student_fee`
     * row with `lock: transaction.LOCK.UPDATE` and its comment calls that "the whole of the
     * concurrency answer" — but the claim was argued from the SQL and never exercised. Two
     * simultaneous requests had never been sent.
     *
     * The failure it prevents is a lost update, and it is silent. `applyPayment` re-sums every
     * payment for the fee and writes the total back onto the row. Without the lock, two concurrent
     * payments both read a sum that excludes the other, both write their own figure, and the second
     * write wins: two receipts exist, the money is in the till, and the ledger shows one payment.
     * Nothing errors, and the discrepancy is found later by a human counting cash.
     *
     * So the assertion is arithmetic rather than status: `paid_amount` must equal **both** payments
     * added together. 120 + 180 = 300 is only reachable if the second transaction waited for the
     * first and then re-summed.
     */
    /*
     * `assigned[2]` — Chidi's row, the one fee this suite never touches elsewhere. Using it keeps the
     * race unpolluted by any earlier payment, without creating a second structure.
     */
    const raceFee = assigned[2];
    check('the concurrency probe starts from an unpaid fee',
      Number(raceFee.paid_amount), 0);

    /*
     * Issued without awaiting either, so both are in flight before either resolves. That is what
     * makes this a race rather than two sequential calls: `Promise.all` starts both `fetch` calls in
     * the same tick.
     */
    const [payA, payB] = await Promise.all([
      call('/fees/payments', {
        method: 'POST',
        token: accountant,
        body: { student_fee_id: raceFee.id, amount: 120, method: PAYMENT_METHODS.CASH },
      }),
      call('/fees/payments', {
        method: 'POST',
        token: accountant,
        body: { student_fee_id: raceFee.id, amount: 180, method: PAYMENT_METHODS.CASH },
      }),
    ]);

    check('both simultaneous payments are accepted',
      [payA.status, payB.status].sort(), [201, 201]);

    /*
     * Read back through the API rather than from either response, because each response reflects the
     * state its own transaction saw. Only a fresh read shows what was actually committed.
     */
    const afterRace = dataOf(await expectOk(`/fees/ledger?student_fee_id=${raceFee.id}`, { token: accountant }, 200));
    const raceRow = (Array.isArray(afterRace) ? afterRace : []).find((row) => row.id === raceFee.id);

    check('the ledger row is readable after the race', Boolean(raceRow), true);
    check('  and paid_amount is the sum of BOTH payments, not the last one to write',
      Number(raceRow ? raceRow.paid_amount : -1), 300);
    check('  so 950 − 300 is pending',
      Number(raceRow ? raceRow.pending_amount : -1), 650);
    check('  and the status follows the true total',
      raceRow ? raceRow.status : null, STUDENT_FEE_STATUS.PARTIALLY_PAID);

    /* Two receipts, because two payments were genuinely taken — the lock serialises, it does not drop. */
    const raceReceipts = await db.FeePayment.count({ where: { student_fee_id: raceFee.id } });
    check('  with two receipts on file, one per payment taken', raceReceipts, 2);

    /* ── tenant scoping on the money paths ── */

    const dAssignRes = await expectOk(
      '/fees/assignments',
      {
        method: 'POST',
        token: principalD,
        body: { fee_structure_id: dStruct.id, student_ids: [dKid.id], due_date: '2025-05-10' },
      },
      201
    );
    const dFee = dataOf(dAssignRes).fees[0];

    const foreignPay = await call('/fees/payments', {
      method: 'POST',
      token: accountant,
      body: { student_fee_id: dFee.id, amount: 10, method: PAYMENT_METHODS.CASH },
    });
    check("a school cannot take money against another school's fee", foreignPay.status, 404);
    check('  and is told the fee does not exist for them', codeOf(foreignPay), 'STUDENT_FEE_NOT_FOUND');

    const dPay = await expectOk(
      '/fees/payments',
      {
        method: 'POST',
        token: principalD,
        body: {
          student_fee_id: dFee.id,
          amount: 100,
          method: PAYMENT_METHODS.CASH,
          paid_at: '2025-05-16T10:00:00.000Z',
        },
      },
      201
    );
    /*
     * The reason `nextNumber` grew a `scope`: the unique index is `(school_id, receipt_number)`, so each
     * school's series is its own. Unscoped, this would have been RCP-202505-00004 and school D's books
     * would carry gaps counting school A's collections.
     */
    check("each school's receipt series starts at one", dataOf(dPay).payment.receipt_number, 'RCP-202505-00001');

    const ledgerA = await expectOk('/fees/ledger', { token: principalA }, 200);
    const ledgerAIds = dataOf(ledgerA).map((f) => f.id);
    check('the ledger shows this school its own fees', ledgerAIds.includes(assigned[0].id), true);
    check("and not another school's, which exists to be excluded", ledgerAIds.includes(dFee.id), false);
    check(
      'the ledger carries the child each fee belongs to — FR-FEE-002 is about a student ledger',
      dataOf(ledgerA)[0].student.student_id.startsWith(CODE_PREFIX),
      true
    );

    const paymentsA = await expectOk('/fees/payments', { token: principalA }, 200);
    const receiptsA = dataOf(paymentsA).map((p) => p.receipt_number);
    check('the payment list is scoped the same way', receiptsA.includes('RCP-202505-00002'), true);
    check("and excludes school D's identically-numbered receipt", dataOf(paymentsA).every((p) => p.school_id === schoolA.id), true);

    const byStudent = await expectOk(`/fees/ledger?student_id=${kids[0].id}`, { token: principalA }, 200);
    check('the ledger filters to one child', dataOf(byStudent).every((f) => f.student_id === kids[0].id), true);
    const unpaidOnly = await expectOk(`/fees/ledger?status=${STUDENT_FEE_STATUS.UNPAID}`, { token: principalA }, 200);
    check('and by status', dataOf(unpaidOnly).every((f) => f.status === STUDENT_FEE_STATUS.UNPAID), true);

    /*
     * An organization-scoped caller. `requireModule` refuses one without a school in scope by design —
     * two schools in an organization can be on two different plans, so there is no single entitlement
     * to check. Naming a school is how they get in.
     */
    const orgNoSchool = await call('/fees/ledger', { token: orgAdmin });
    check('an organization admin must name a school', orgNoSchool.status, 400);
    check('  because entitlement is per school', codeOf(orgNoSchool), 'SCHOOL_CONTEXT_REQUIRED');
    const orgScoped = await expectOk(`/fees/ledger?school_id=${schoolA.id}`, { token: orgAdmin }, 200);
    check('naming one lets them read it', dataOf(orgScoped).every((f) => f.school_id === schoolA.id), true);
    const orgOutside = await call(`/fees/ledger?school_id=${schoolA.id}`, { token: principalD });
    check("and a principal cannot borrow another school's id", orgOutside.status, 403);
    /*
     * `CROSS_TENANT_ACCESS_DENIED`, not the `CROSS_SCHOOL_ACCESS` that `resolveSchool()` raises: the
     * tenant middleware inspects `?school_id` against the caller's scope and refuses before the router
     * runs, so the service's own check is the second line, not the first. Worth pinning — it means the
     * guard survives a service that forgot to call `resolveSchool()`.
     */
    check('  refused by the tenant chain before the module sees it', codeOf(orgOutside), 'CROSS_TENANT_ACCESS_DENIED');

    /* ── editing the catalogue does not re-price a bill already issued ── */

    const repriced = await expectOk(
      `/fees/structures/${monthly.id}`,
      { method: 'PATCH', token: accountant, body: { amount: 1500 } },
      200
    );
    check('a structure can be re-priced', Number(dataOf(repriced).structure.amount), 1500);
    const unchanged = await expectOk(`/fees/ledger?student_id=${kids[1].id}`, { token: principalA }, 200);
    const monthlyFeeRow = dataOf(unchanged).find((f) => f.fee_structure_id === monthly.id);
    check('but a fee already assigned keeps the figure the family was told', Number(monthlyFeeRow.net_amount), 950);

    const retired = await expectOk(
      `/fees/structures/${exam.id}`,
      { method: 'PATCH', token: accountant, body: { is_active: false } },
      200
    );
    check('and a component no longer charged is retired, not deleted', dataOf(retired).structure.is_active, false);

    /* ── the DATEONLY trap, at a western offset (Known Issues #20) ── */

    const tzBefore = process.env.TZ;
    let westFee = null;
    try {
      process.env.TZ = 'America/New_York';
      const westRes = await expectOk(
        '/fees/assignments',
        {
          method: 'POST',
          token: accountant,
          body: {
            fee_structure_id: transport.id,
            student_ids: [kids[2].id],
            due_date: '2025-07-01',
            period_month: '2025-07-01',
          },
        },
        201
      );
      westFee = dataOf(westRes).fees[0];
    } finally {
      if (tzBefore === undefined) delete process.env.TZ;
      else process.env.TZ = tzBefore;
    }
    check('due_date survives a west-of-UTC server', westFee.due_date, '2025-07-01');
    check('and so does period_month — both DATEONLY columns, not just one', westFee.period_month, '2025-07-01');
    const [westRows] = await db.sequelize.query(
      `SELECT due_date, period_month FROM student_fees WHERE id = ${Number(westFee.id)}`
    );
    check('and the row on disk holds the same day', String(westRows[0].due_date).slice(0, 10), '2025-07-01');

    /* ── the trail ── */

    const activity = await settleDistinct(
      () => db.ActivityLog.findAll({
        where: {
          id: { [db.Op.gt]: baseline.activityLog },
          entity_type: { [db.Op.in]: ['fee_structure', 'student_fee', 'fee_payment'] },
        },
        order: [['id', 'ASC']],
      }),
      'entity_type',
      3
    );
    const feeActivity = activity.filter((r) =>
      ['fee_structure', 'student_fee', 'fee_payment'].includes(r.entity_type)
    );
    check('every fee operation is in the activity trail', feeActivity.length > 0, true);
    check(
      'all three entity types appear',
      [...new Set(feeActivity.map((r) => r.entity_type))].sort(),
      ['fee_payment', 'fee_structure', 'student_fee']
    );

    /*
     * Money gets a per-row audit, unlike attendance: a fee is a figure a family is billed for and a
     * receipt is money that changed hands, so "who created this exact row" has to be answerable.
     */
    const audits = await settle(
      () => db.AuditLog.findAll({
        where: {
          id: { [db.Op.gt]: baseline.auditLog },
          table_name: { [db.Op.in]: ['fee_structures', 'student_fees', 'fee_payments'] },
        },
      }),
      (rows) =>
        new Set(rows.map((r) => r.table_name)).size >= 3 &&
        rows.filter((r) => r.table_name === 'student_fees' && r.event === 'create').length >= 3 &&
        rows.some((r) => r.table_name === 'fee_payments') &&
        rows.some((r) => r.table_name === 'student_fees' && r.event === 'update')
    );
    const byTable = audits.reduce((acc, r) => ({ ...acc, [r.table_name]: (acc[r.table_name] || 0) + 1 }), {});
    check('every fee table is audited per row', Object.keys(byTable).sort(), [
      'fee_payments',
      'fee_structures',
      'student_fees',
    ]);
    check(
      'the three-child assignment produced three student_fees creates, not one batch row',
      audits.filter((r) => r.table_name === 'student_fees' && r.event === 'create').length >= 3,
      true
    );
    check(
      'and a payment audits the receipt and the balance it changed',
      audits.filter((r) => r.table_name === 'fee_payments').length > 0 &&
        audits.filter((r) => r.table_name === 'student_fees' && r.event === 'update').length > 0,
      true
    );
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-fees Part 3 teardown failed:', err);
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
    console.error('\nverify-fees crashed:', err);
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
          ? 'All pure fee checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All fee checks passed (Parts 1–3).'
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
