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
 * Verification of Phase 3.M finance — `src/modules/finance/*` — SRS §18, FR-FIN-001 (record income &
 * expenses), FR-FIN-002 (net balance) and FR-FIN-003 (financial reports).
 *
 * Every arithmetic expectation is **hand-computed**. The fixture ledger is chosen so the figures are
 * checkable by eye and are not round by accident: income 1000.00 + 250.50 + 500.25 = 1750.75, expense
 * 800.00 + 200.00 + 150.75 = 1150.75, net balance exactly 600.00.
 *
 * Four assertions exist to pin decisions that would otherwise be invisible, and each was written
 * because getting it wrong produces a **plausible number that is wrong** — the worst outcome for a
 * financial report:
 *
 *  - **`Model.sum(col, {group})` returns only the first group.** Asserted directly against the live
 *    database beside the service's own aggregate, so the reason the service uses `findAll` +
 *    `fn('SUM')` is on the record rather than in a comment.
 *  - **A fee collection does not move the net balance.** §17's payment path writes `fee_payments` and
 *    nothing else; `fee_payments.income_id` stays NULL. The suite collects a real fee and asserts the
 *    report is byte-identical before and after.
 *  - **The net balance is not clamped.** A school that overspent reports a negative number.
 *  - **A window holding two currencies is refused.** Adding pesos to dollars produces a figure that
 *    means nothing, so the report fails closed.
 *
 * Carried in from the §15/§16/§17 audits: rows exist outside school A so every scoping assertion has a
 * counter-example; an organization-scoped caller exists so `tenantWhere`'s second branch runs; enums
 * are asserted schema-against-**model**; and every `DATEONLY` column — `expense_date`, `salary_month`
 * and `income_date`, all three — is round-tripped at a flipped `process.env.TZ`.
 *
 * Part 1 — request schemas and the pure fold (no database).
 * Part 2 — the declared route table and the router-level guard.
 * Part 3 — over real HTTP against the real database.
 *
 * Run: node scripts/verify-finance.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const { settleDistinct } = require('./lib/settle');

const financeRoutes = require('../src/modules/finance/finance.routes');
const { schemas } = require('../src/modules/finance/finance.validation');
const financeService = require('../src/modules/finance/finance.service');

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
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  PAYMENT_METHODS,
  FEE_COMPONENTS,
  STUDENT_STATUS,
  ACADEMIC_SESSION_STATUS,
  STAFF_CATEGORIES,
} = require('../src/config/constants');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-finance.local';
const PASSWORD = 'Verify@Finance123';
const CODE_PREFIX = 'VFN-';

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

/** Valid bodies, so a rejection can only be about the field under test. */
const EXPENSE = { title: 'Electricity', amount: 150.75, expense_date: '2025-05-15' };
const INCOME = { title: 'Donation', amount: 1000, income_date: '2025-05-10' };

/* ═══════════════════════ part 1 — schemas and the pure fold ═══════════════════════ */

function verifySchemas() {
  console.log('\n── Part 1 — request schemas and the report fold ──\n');

  /* ── FR-FIN-001, both halves ── */

  check('a complete expense validates', run(schemas.createExpense, EXPENSE).ok, true);
  check('a complete income validates', run(schemas.createIncome, INCOME).ok, true);
  check('an expense needs a title', run(schemas.createExpense, { amount: 1, expense_date: '2025-05-15' }).ok, false);
  check('an expense needs an amount', run(schemas.createExpense, { title: 'x', expense_date: '2025-05-15' }).ok, false);
  check('an expense needs a date — it is what every report window filters on', run(schemas.createExpense, { title: 'x', amount: 1 }).ok, false);
  check('an income needs a date too', run(schemas.createIncome, { title: 'x', amount: 1 }).ok, false);
  check(
    'category is optional — the column defaults it',
    [run(schemas.createExpense, EXPENSE).value.category, run(schemas.createIncome, INCOME).value.category],
    [undefined, undefined]
  );

  /*
   * Schema against **model**, not against the constant the schema imports. `enumOf(EXPENSE_CATEGORIES)`
   * builds the column from the same object, so comparing the two constants compares a thing to itself.
   */
  const expenseColumn = db.Expense.rawAttributes.category.values;
  const incomeColumn = db.Income.rawAttributes.category.values;
  check('the expense column offers exactly the two §18 names', expenseColumn, ['salaries', 'other_expenses']);
  check('the income column offers exactly two categories', incomeColumn, ['fees', 'other_income']);
  check(
    'every expense category the column accepts is accepted by the schema',
    expenseColumn.every((v) => run(schemas.createExpense, { ...EXPENSE, category: v, paid_to: 'X' }).ok),
    true
  );
  check(
    'every income category the column accepts is accepted by the schema',
    incomeColumn.every((v) => run(schemas.createIncome, { ...INCOME, category: v }).ok),
    true
  );
  check(
    'an invented expense category is refused',
    run(schemas.createExpense, { ...EXPENSE, category: 'rent' }).ok,
    false
  );
  check(
    'and an invented income category too',
    run(schemas.createIncome, { ...INCOME, category: 'grants' }).ok,
    false
  );

  /* Widths read off models/finance.js, not guessed — §5a defect 24. */
  const width = (schema, base, field, n) => run(schema, { ...base, [field]: 'x'.repeat(n) }).ok;
  check('title is bounded at its STRING(180)', [width(schemas.createExpense, EXPENSE, 'title', 180), width(schemas.createExpense, EXPENSE, 'title', 181)], [true, false]);
  check('subcategory at STRING(120)', [width(schemas.createExpense, EXPENSE, 'subcategory', 120), width(schemas.createExpense, EXPENSE, 'subcategory', 121)], [true, false]);
  check('reference at STRING(160)', [width(schemas.createExpense, EXPENSE, 'reference', 160), width(schemas.createExpense, EXPENSE, 'reference', 161)], [true, false]);
  check('paid_to at STRING(180)', [width(schemas.createExpense, EXPENSE, 'paid_to', 180), width(schemas.createExpense, EXPENSE, 'paid_to', 181)], [true, false]);
  check('received_from at STRING(180)', [width(schemas.createIncome, INCOME, 'received_from', 180), width(schemas.createIncome, INCOME, 'received_from', 181)], [true, false]);
  check('currency at STRING(10)', [width(schemas.createIncome, INCOME, 'currency', 10), width(schemas.createIncome, INCOME, 'currency', 11)], [true, false]);

  check('a money field at the DECIMAL(14,2) ceiling validates', run(schemas.createExpense, { ...EXPENSE, amount: 999999999999.99 }).ok, true);
  check('one cent past it does not', run(schemas.createExpense, { ...EXPENSE, amount: 1000000000000 }).ok, false);
  check('a negative amount is refused', run(schemas.createExpense, { ...EXPENSE, amount: -1 }).ok, false);

  /* ── the columns a caller may not write ── */

  for (const [schema, base, field] of [
    [schemas.createExpense, EXPENSE, 'attachment_path'],
    [schemas.createExpense, EXPENSE, 'recorded_by'],
    [schemas.createExpense, EXPENSE, 'organization_id'],
    [schemas.createIncome, INCOME, 'attachment_path'],
    [schemas.createIncome, INCOME, 'recorded_by'],
  ]) {
    const result = run(schema, { ...base, [field]: field === 'attachment_path' ? '/etc/passwd' : 1 });
    check(`a caller-supplied ${field} is refused`, result.ok, false);
    /* The rest of the body is valid, so the failing path can only be the forbidden key. */
    check(`  and names ${field} as the reason`, result.keys, [field]);
  }

  check('an update needs at least one field', run(schemas.updateExpense, {}).ok, false);
  check('one field is enough', run(schemas.updateIncome, { amount: 5 }).ok, true);

  /* ── the report takes no page and no period ── */

  const reported = run(schemas.report, { page: 2, limit: 10, sortBy: 'amount', period: 'monthly', category: 'salaries' });
  check('the report is not a list — page/limit/sortBy are not part of it', [
    'page' in reported.value,
    'limit' in reported.value,
    'sortBy' in reported.value,
  ], [false, false, false]);
  check(
    'and a list endpoint by contrast does take them',
    run(schemas.listExpenses, { page: 2, limit: 10 }).value.page,
    2
  );
  check(
    'the report takes no period — §16 named three, §18 names none, and §22 owns the report surface',
    'period' in reported.value,
    false
  );
  check(
    'and no category filter — a net balance over one category is not a net balance',
    'category' in reported.value,
    false
  );
  check(
    'what it does take is a window and a currency',
    Object.keys(run(schemas.report, { from: '2025-05-01', to: '2025-05-31', currency: 'usd', school_id: 3 }).value).sort(),
    ['currency', 'from', 'school_id', 'to']
  );
  check('and the currency is upper-cased on the way in', run(schemas.report, { currency: 'usd' }).value.currency, 'USD');

  /* ── the fold, against hand-computed figures ── */

  const EX = financeService.EXPENSE_CATEGORY_LIST;
  const IN = financeService.INCOME_CATEGORY_LIST;

  check(
    'two rows in one category fold into one bucket',
    financeService.foldBuckets([{ category: 'salaries', total: 800 }, { category: 'salaries', total: 200 }], EX),
    { total: 1000, by_category: { salaries: 1000, other_expenses: 0 } }
  );
  check(
    'an absent category is zero-filled, not omitted',
    financeService.foldBuckets([{ category: 'fees', total: 500 }], IN),
    { total: 500, by_category: { fees: 500, other_income: 0 } }
  );
  check(
    'no rows at all folds to zeroes, not to null',
    financeService.foldBuckets([], EX),
    { total: 0, by_category: { salaries: 0, other_expenses: 0 } }
  );
  check(
    'the buckets sum back to the total with no residual',
    (() => {
      const f = financeService.foldBuckets(
        [{ category: 'salaries', total: 800 }, { category: 'other_expenses', total: 150.75 }],
        EX
      );
      return f.by_category.salaries + f.by_category.other_expenses === f.total;
    })(),
    true
  );
  /* The reason utils/money.js exists: 0.1 + 0.2 is 0.30000000000000004 in float. */
  check(
    'and the fold runs in minor units, not floats',
    financeService.foldBuckets([{ category: 'salaries', total: 0.1 }, { category: 'salaries', total: 0.2 }], EX).total,
    0.3
  );
  check(
    'a DECIMAL handed back as a string still folds correctly',
    financeService.foldBuckets([{ category: 'fees', total: '500.25' }, { category: 'other_income', total: '250.50' }], IN),
    { total: 750.75, by_category: { fees: 500.25, other_income: 250.5 } }
  );
  check(
    'a NULL total from an empty group cannot leak NaN into the response',
    financeService.foldBuckets([{ category: 'fees', total: null }], IN).total,
    0
  );
  /*
   * The total is summed from the ROWS, not from the known buckets — so a category the list does not
   * know about is still counted. Unreachable today (the column is a NOT NULL enum closed at two
   * values), and it stops being unreachable the moment that enum grows. Written as a test because the
   * failure mode is a total that is quietly too small while the buckets beside it look fine.
   */
  const stray = financeService.foldBuckets(
    [{ category: 'salaries', total: 10 }, { category: 'rent', total: 50 }],
    EX
  );
  check('an unrecognised category is still counted in the total', stray.total, 60);
  check('  and gets its own bucket rather than being merged into a known one', stray.by_category.rent, 50);
  check(
    '  so the buckets always sum to the total, by construction and not by coincidence',
    Object.values(stray.by_category).reduce((a, b) => a + b, 0),
    stray.total
  );
}

/* ═══════════════════════════ part 2 — the route table ═══════════════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — declared routes ──\n');

  const routes = routesOf(financeRoutes);
  check('the nine §18 routes are declared', routes, [
    'GET /report',
    'GET /incomes',
    'POST /incomes',
    'GET /incomes/:id',
    'PATCH /incomes/:id',
    'GET /expenses',
    'POST /expenses',
    'GET /expenses/:id',
    'PATCH /expenses/:id',
  ]);

  check(
    'there is no DELETE — neither table is paranoid, so it would hard-delete a financial record',
    routes.some((r) => r.startsWith('DELETE')),
    false
  );
  check(
    'the net balance has no route of its own — FR-FIN-002 is a field on the report',
    routes.some((r) => r.includes('balance') || r.includes('summary') || r.includes('dashboard')),
    false
  );
  check(
    'and there is exactly one report route',
    routes.filter((r) => r.includes('report')).length,
    1
  );
  check(
    '/report sits at the router root, so no :id can shadow it',
    routes.includes('GET /report'),
    true
  );

  const writes = financeRoutes.stack
    .filter((l) => l.route && !l.route.methods.get)
    .map((l) => [Object.keys(l.route.methods)[0], l.route.path]);
  check('there are four write routes — create and correct, on each ledger', writes.length, 4);
  check(
    'no write carries requirePlatformScope() — §18 is school-side',
    writes.every(([m, p]) => named(financeRoutes, m, p, 'platformGuard') === false),
    true
  );
  check(
    'every write carries validate()',
    writes.every(([m, p]) => named(financeRoutes, m, p, 'validateRequest')),
    true
  );
  check(
    'every write declares its activity',
    writes.every(([m, p]) => named(financeRoutes, m, p, 'activityDeclaration')),
    true
  );
  check(
    'one router-level guard, mounted ahead of every route',
    [financeRoutes.stack.filter((l) => !l.route).length, financeRoutes.stack.findIndex((l) => !l.route)],
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
    mountsLimit('finance'),
    false
  );
  check(
    '  and the probe would find one — the students router does mount a limit',
    mountsLimit('students'),
    true
  );
  check(
    'and §11.2 defines no finance limit to carry',
    Object.values(LIMITS).some((k) => k.includes('financ') || k.includes('expense') || k.includes('income')),
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
      await db.Income.destroy({ where: { school_id: created.schools } });
      await db.Expense.destroy({ where: { school_id: created.schools } });
      await db.FeePayment.destroy({ where: { school_id: created.schools } });
      await db.StudentFee.destroy({ where: { school_id: created.schools } });
      await db.FeeStructure.destroy({ where: { school_id: created.schools } });
      await db.Student.destroy({ where: { school_id: created.schools }, force: true });
      await db.Teacher.destroy({ where: { school_id: created.schools }, force: true });
      await db.Staff.destroy({ where: { school_id: created.schools }, force: true });
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

  /**
   * Clear what a KILLED earlier run left behind, before building anything.
   *
   * `teardown()` deletes by the ids **this** run created, which is right for a run that finishes and
   * useless for one that does not. When a session restart killed a loop partway through this suite,
   * the next run died on `SubscriptionPlan.create` with `code must be unique`: the previous run's
   * `VFN-WITH` and `VFN-WITHOUT` plans and its `verify-finance.local` user were still there, and
   * nothing would ever remove them. It also broke `verify-seed.js`, which counts users.
   *
   * So the leftovers are found by this suite's **own** markers — the `VFN-` code prefix and the
   * `verify-finance.local` domain — loaded into `created`, and handed to the same `teardown()`, which
   * already knows the deletion order. Scoped to those markers only, so it can never remove a row
   * belonging to another suite (Known Issues #25).
   */
  async function sweepResidue() {
    const byCode = { code: { [db.Op.like]: `${CODE_PREFIX}%` } };
    const [plans, users, schools, orgs] = await Promise.all([
      db.SubscriptionPlan.findAll({ where: byCode, attributes: ['id'], paranoid: false }),
      db.User.findAll({ where: { email: { [db.Op.like]: `%@${DOMAIN}` } }, attributes: ['id'], paranoid: false }),
      db.School.findAll({ where: byCode, attributes: ['id'], paranoid: false }),
      db.Organization.findAll({ where: byCode, attributes: ['id'], paranoid: false }),
    ]);
    const schoolIds = schools.map((row) => row.id);
    const subscriptions = schoolIds.length
      ? await db.Subscription.findAll({ where: { school_id: schoolIds }, attributes: ['id'], paranoid: false })
      : [];

    created.plans.push(...plans.map((row) => row.id));
    created.users.push(...users.map((row) => row.id));
    created.schools.push(...schoolIds);
    created.organizations.push(...orgs.map((row) => row.id));
    created.subscriptions.push(...subscriptions.map((row) => row.id));

    const found = plans.length + users.length + schools.length + orgs.length + subscriptions.length;
    if (found) await teardown();
    for (const key of Object.keys(created)) created[key].length = 0;
    return found;
  }

  try {
    const residue = await sweepResidue();
    if (residue) console.log(`(cleared ${residue} row(s) left behind by an earlier run that did not finish)`);

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

    const org = await db.Organization.create({ name: 'Verify Finance Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify Finance A');
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify Finance B');
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify Finance C');
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify Finance D');

    const mkPlan = async (code, financeEnabled) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify Finance ${code}`,
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
          is_enabled: key === MODULES.FINANCE ? financeEnabled : true,
        });
      }
      await db.PlanLimit.create({
        plan_id: plan.id,
        limit_key: LIMITS.STUDENT_LIMIT,
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: 100,
      });
      await db.PlanLimit.create({
        plan_id: plan.id,
        limit_key: LIMITS.STAFF_LIMIT,
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: 100,
      });
      return plan;
    };

    const withFinance = await mkPlan('WITH', true);
    const withoutFinance = await mkPlan('WITHOUT', false);

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

    await subscribe(schoolA, withFinance);
    await subscribe(schoolB, withoutFinance);
    await subscribe(schoolD, withFinance);
    /* schoolC is deliberately left unsubscribed. */

    /* People and structure, created directly — their own suites cover their endpoints. */
    const session = await db.AcademicSession.create({
      school_id: schoolA.id,
      organization_id: org.id,
      name: '2025-2026',
      start_date: '2025-04-01',
      end_date: '2026-03-31',
      status: ACADEMIC_SESSION_STATUS.ACTIVE,
      is_current: true,
    });
    const foreignSession = await db.AcademicSession.create({
      school_id: schoolD.id,
      organization_id: org.id,
      name: 'D 2025-2026',
      start_date: '2025-04-01',
      end_date: '2026-03-31',
      status: ACADEMIC_SESSION_STATUS.ACTIVE,
    });
    const gradeA = await db.Class.create({
      school_id: schoolA.id,
      organization_id: org.id,
      academic_session_id: session.id,
      name: 'Grade 1',
      numeric_order: 1,
    });
    const teacherA = await db.Teacher.create({
      school_id: schoolA.id,
      organization_id: org.id,
      employee_id: `${CODE_PREFIX}T1`,
      first_name: 'Nadia',
      joining_date: '2024-01-15',
    });
    const foreignTeacher = await db.Teacher.create({
      school_id: schoolD.id,
      organization_id: org.id,
      employee_id: `${CODE_PREFIX}T9`,
      first_name: 'Faraway',
      joining_date: '2024-01-15',
    });
    const staffA = await db.Staff.create({
      school_id: schoolA.id,
      organization_id: org.id,
      employee_id: `${CODE_PREFIX}S1`,
      category: STAFF_CATEGORIES.LIBRARIAN,
      first_name: 'Omar',
      joining_date: '2024-02-01',
    });
    const foreignStaff = await db.Staff.create({
      school_id: schoolD.id,
      organization_id: org.id,
      employee_id: `${CODE_PREFIX}S9`,
      category: STAFF_CATEGORIES.LIBRARIAN,
      first_name: 'Distant',
      joining_date: '2024-02-01',
    });
    const studentA = await db.Student.create({
      school_id: schoolA.id,
      organization_id: org.id,
      student_id: `${CODE_PREFIX}P1`,
      first_name: 'Amina',
      admission_date: '2025-04-01',
      status: STUDENT_STATUS.ACTIVE,
      class_id: gradeA.id,
      academic_session_id: session.id,
    });
    const foreignStudent = await db.Student.create({
      school_id: schoolD.id,
      organization_id: org.id,
      student_id: `${CODE_PREFIX}P9`,
      first_name: 'Dee',
      admission_date: '2025-04-01',
      status: STUDENT_STATUS.ACTIVE,
    });

    const password_hash = await hashPassword(PASSWORD);
    const people = [
      ['platform', ROLES.SUPER_ADMIN, 'Verify FN Platform', 'vfn_platform', null, null],
      ['principal-a', ROLES.PRINCIPAL, 'Verify FN Principal A', 'vfn_principal_a', org.id, schoolA.id],
      ['principal-b', ROLES.PRINCIPAL, 'Verify FN Principal B', 'vfn_principal_b', org.id, schoolB.id],
      ['principal-c', ROLES.PRINCIPAL, 'Verify FN Principal C', 'vfn_principal_c', org.id, schoolC.id],
      ['principal-d', ROLES.PRINCIPAL, 'Verify FN Principal D', 'vfn_principal_d', org.id, schoolD.id],
      ['accountant', ROLES.ACCOUNTANT, 'Verify FN Accountant', 'vfn_accountant', org.id, schoolA.id],
      ['receptionist', ROLES.RECEPTIONIST, 'Verify FN Receptionist', 'vfn_reception', org.id, schoolA.id],
      /* organization_id set, school_id NULL — holds finance.view but NOT finance.manage. */
      ['org-admin', ROLES.ORGANIZATION_ADMIN, 'Verify FN Org Admin', 'vfn_org', org.id, null],
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

    const moduleDenied = await call('/finance/report', { token: principalB });
    check('a plan without the Finance module refuses', moduleDenied.status, 403);
    check('and names the module', codeOf(moduleDenied), 'MODULE_NOT_SUBSCRIBED');
    check('naming which one', moduleDenied.body.error.details.missing, [MODULES.FINANCE]);

    const noSub = await call('/finance/report', { token: principalC });
    check('a school with no subscription is refused differently', noSub.status, 402);
    check('state is checked before module', codeOf(noSub), 'SUBSCRIPTION_INACTIVE');

    /* ── the two permissions are two different things ── */

    const orgWrite = await call('/finance/expenses', {
      method: 'POST',
      token: orgAdmin,
      body: { school_id: schoolA.id, ...EXPENSE },
    });
    check('finance.view does not carry finance.manage — an org admin may not record', orgWrite.status, 403);
    check('  and is told it is the permission that is missing', codeOf(orgWrite), 'INSUFFICIENT_PERMISSION');
    const orgRead = await expectOk(`/finance/report?school_id=${schoolA.id}`, { token: orgAdmin }, 200);
    check('  but may read the report', Boolean(dataOf(orgRead).report), true);

    /* The org admin's own scoping is asserted further down, once school D has rows to exclude. */

    const receptionRead = await call('/finance/report', { token: receptionist });
    check('a receptionist holds neither key — §18 names three actors and they are not one', receptionRead.status, 403);

    /* ── FR-FIN-001 — recording ── */

    const mkIncome = async (body, token = accountant) =>
      dataOf(await expectOk('/finance/incomes', { method: 'POST', token, body }, 201)).income;
    const mkExpense = async (body, token = accountant) =>
      dataOf(await expectOk('/finance/expenses', { method: 'POST', token, body }, 201)).expense;

    const donation = await mkIncome({
      title: 'Alumni donation',
      amount: 1000,
      income_date: '2025-05-10',
      received_from: 'Alumni Association',
      payment_method: PAYMENT_METHODS.BANK_TRANSFER,
      academic_session_id: session.id,
    });
    check('an Accountant may record income — FR-FIN-001 names them', Boolean(donation.id), true);
    check('the category defaults to other_income', donation.category, INCOME_CATEGORIES.OTHER_INCOME);
    check('the date is stored as a plain date', donation.income_date, '2025-05-10');
    check('the school is taken from the caller, never the body', donation.school_id, schoolA.id);
    check('and so is the organization', donation.organization_id, org.id);
    check('the recorder is stamped on the row', Boolean(donation.recorded_by), true);
    /* mysql2 is configured with decimalNumbers:true, so money crosses the wire as a number. */
    check('a money column crosses the wire as a number', typeof donation.amount, 'number');

    await mkIncome({ title: 'Hall hire', amount: 250.5, income_date: '2025-05-20' });
    /*
     * A `fees` income recorded BY A HUMAN. Nothing posts a fee collection automatically — see the
     * service header — so this is the only way a `fees` row comes into existence, and the column is
     * therefore live rather than dead.
     */
    const feeIncome = await mkIncome({
      title: 'Tuition received at the desk',
      amount: 500.25,
      income_date: '2025-07-01',
      category: INCOME_CATEGORIES.FEES,
      student_id: studentA.id,
    });
    check('a fees income can be recorded by the human actor FR-FIN-001 names', feeIncome.category, INCOME_CATEGORIES.FEES);
    check('  and it may name the child the money came from', feeIncome.student_id, studentA.id);

    const salaryStaff = await mkExpense({
      title: 'May salary — librarian',
      amount: 800,
      expense_date: '2025-05-15',
      category: EXPENSE_CATEGORIES.SALARIES,
      staff_id: staffA.id,
      salary_month: '2025-05-01',
    });
    check('a salaries expense may point at a staff member — §18 names Salaries', salaryStaff.category, EXPENSE_CATEGORIES.SALARIES);
    check('  and record the month it covers, as a plain date', salaryStaff.salary_month, '2025-05-01');
    await mkExpense({
      title: 'May salary — teacher',
      amount: 200,
      expense_date: '2025-05-25',
      category: EXPENSE_CATEGORIES.SALARIES,
      teacher_id: teacherA.id,
      salary_month: '2025-05-01',
    });
    const utilities = await mkExpense({
      title: 'Electricity',
      amount: 150.75,
      expense_date: '2025-07-05',
      subcategory: 'Utilities',
    });
    check('and an expense with no category is other_expenses — §18 names that too', utilities.category, EXPENSE_CATEGORIES.OTHER_EXPENSES);

    /* ── what a recording may not do ── */

    const noRecipient = await call('/finance/expenses', {
      method: 'POST',
      token: accountant,
      body: { title: 'Mystery salary', amount: 500, expense_date: '2025-05-15', category: EXPENSE_CATEGORIES.SALARIES },
    });
    check('a salary that names nobody is refused by the model validator', noRecipient.status, 422);

    const foreignTeacherExpense = await call('/finance/expenses', {
      method: 'POST',
      token: accountant,
      body: { ...EXPENSE, category: EXPENSE_CATEGORIES.SALARIES, teacher_id: foreignTeacher.id },
    });
    check("a salary cannot name another school's teacher", foreignTeacherExpense.status, 422);
    const foreignStaffExpense = await call('/finance/expenses', {
      method: 'POST',
      token: accountant,
      body: { ...EXPENSE, category: EXPENSE_CATEGORIES.SALARIES, staff_id: foreignStaff.id },
    });
    check("nor another school's staff member", foreignStaffExpense.status, 422);
    const foreignStudentIncome = await call('/finance/incomes', {
      method: 'POST',
      token: accountant,
      body: { ...INCOME, student_id: foreignStudent.id },
    });
    check("an income cannot name another school's student", foreignStudentIncome.status, 422);
    const foreignSessionIncome = await call('/finance/incomes', {
      method: 'POST',
      token: accountant,
      body: { ...INCOME, academic_session_id: foreignSession.id },
    });
    check("nor another school's academic session", foreignSessionIncome.status, 422);
    const pathWrite = await call('/finance/expenses', {
      method: 'POST',
      token: accountant,
      body: { ...EXPENSE, attachment_path: '/etc/passwd' },
    });
    check('and a body-supplied attachment_path is refused — paths come from an upload', pathWrite.status, 422);

    /* ── FR-FIN-002 + FR-FIN-003 — the report ── */

    const full = dataOf(await expectOk('/finance/report', { token: accountant }, 200)).report;
    check('income totals 1000.00 + 250.50 + 500.25', full.income.total, 1750.75);
    check('split across the two income categories', full.income.by_category, { fees: 500.25, other_income: 1250.5 });
    check('expenses total 800.00 + 200.00 + 150.75', full.expense.total, 1150.75);
    check('split across Salaries and Other Expenses, the two §18 names', full.expense.by_category, {
      salaries: 1000,
      other_expenses: 150.75,
    });
    check('and the buckets sum back to the total with no residual', [
      full.income.by_category.fees + full.income.by_category.other_income === full.income.total,
      full.expense.by_category.salaries + full.expense.by_category.other_expenses === full.expense.total,
    ], [true, true]);
    /* §18, stated outright: Income − Expense = Net Balance. 1750.75 − 1150.75 = 600.00. */
    check('Income − Expense = Net Balance', full.net_balance, 600);
    check('the report names the one school it is about', full.scope, { school_id: schoolA.id });
    /*
     * Asserted on the KEYS as well as the values. `JSON.stringify([undefined, undefined])` is
     * `"[null,null]"`, so comparing `[full.from, full.to]` to `[null, null]` passed identically whether
     * the report echoed an explicit null or omitted the key altogether — it could not fail.
     */
    check('an unbounded window echoes its bounds rather than omitting them', ['from' in full, 'to' in full], [true, true]);
    check('  and echoes them as null — that is the dashboard call', [full.from, full.to], [null, null]);
    check('and reports the currency the figures are in', full.currency, 'USD');

    /*
     * The window lands **exactly on two existing rows** — the 1000.00 income of 05-10 sits on `from`,
     * and the 200.00 salary of 05-25 sits on `to`. That tests inclusivity on both ends without adding a
     * row: the original 05-01..05-31 window put every fixture row strictly inside it, so swapping
     * `Op.gte`/`Op.lte` for `Op.gt`/`Op.lt` left the whole suite green. Under exclusive bounds the two
     * figures below become 250.50 and 800.00.
     */
    const may = dataOf(
      await expectOk('/finance/report?from=2025-05-10&to=2025-05-25', { token: principalA }, 200)
    ).report;
    check('a window narrows both sides of the ledger', [may.income.total, may.expense.total], [1250.5, 1000]);
    check('  the row sitting exactly on `from` is included — 1000.00 of 05-10', may.income.total - 250.5, 1000);
    check('  and the one sitting exactly on `to` — the 200.00 salary of 05-25', may.expense.total - 800, 200);
    check('and the net balance follows it — 1250.50 − 1000.00', may.net_balance, 250.5);
    check('a category with nothing in the window is zero, not absent', may.income.by_category.fees, 0);
    check('the window is echoed back so the figure is checkable', [may.from, may.to], ['2025-05-10', '2025-05-25']);

    /*
     * A transposed window is refused rather than answered. It matches no rows, so both totals fold to
     * zero and the endpoint would otherwise return a confident `net_balance: 0.00` that looks exactly
     * like a school with balanced books. The codebase had already decided this at
     * `middlewares/validate.js:156`; this module had simply not used it (§5a session 18).
     */
    const transposed = await call('/finance/report?from=2025-12-31&to=2025-01-01', { token: principalA });
    check('a transposed window is refused, not answered with a confident zero', transposed.status, 422);
    const transposedList = await call('/finance/expenses?from=2025-12-31&to=2025-01-01', { token: principalA });
    check('  and the lists refuse it too', transposedList.status, 422);
    const toOnly = await expectOk('/finance/report?to=2025-12-31', { token: principalA }, 200);
    check('  but a one-sided window is still legal', Boolean(dataOf(toOnly).report), true);

    /*
     * Why the service does not use `Model.sum(col, {group})`. Asserted against the live database rather
     * than argued in a comment: it returns one number — the first group's — where the aggregate the
     * service actually runs returns the breakdown. A plausible figure that is wrong is the worst
     * possible result for a financial report.
     */
    const trap = await db.Expense.sum('amount', { where: { school_id: schoolA.id }, group: ['category'] });
    check('Model.sum with a group silently returns one number, not a breakdown', typeof trap, 'number');
    /*
     * Asserted as "one of the groups, and not the total" rather than pinned to the salaries bucket:
     * which group comes back is whichever the engine returns first, and SQL guarantees no ordering
     * for an ungrouped-by-order aggregate. Pinning 1000 would have been a test of MariaDB, not of the
     * module — and a flake waiting for a plan change.
     */
    check('  and that number is a single bucket, not the 1150.75 total', [trap === 1000 || trap === 150.75, trap === 1150.75], [true, false]);
    const correct = await financeService.sumByCategory(financeService.LEDGERS.expense, { school_id: schoolA.id });
    check(
      '  while the aggregate the service runs returns every group',
      correct.map((r) => [r.category, Number(r.total)]).sort(),
      [['other_expenses', 150.75], ['salaries', 1000]].sort()
    );

    /* ── the recorded gap: a fee collection does not move the net balance ── */

    const structure = dataOf(
      await expectOk(
        '/fees/structures',
        {
          method: 'POST',
          token: accountant,
          body: { name: 'Monthly Tuition', component: FEE_COMPONENTS.MONTHLY_FEE, amount: 900 },
        },
        201
      )
    ).structure;
    const studentFee = dataOf(
      await expectOk(
        '/fees/assignments',
        {
          method: 'POST',
          token: accountant,
          body: { fee_structure_id: structure.id, student_ids: [studentA.id], due_date: '2025-08-10' },
        },
        201
      )
    ).fees[0];
    const collected = dataOf(
      await expectOk(
        '/fees/payments',
        {
          method: 'POST',
          token: accountant,
          body: {
            student_fee_id: studentFee.id,
            amount: 900,
            method: PAYMENT_METHODS.CASH,
            paid_at: '2025-08-15T10:00:00.000Z',
          },
        },
        201
      )
    ).payment;
    check('a fee of 900 is really collected', Number(collected.amount), 900);

    const afterFee = dataOf(await expectOk('/finance/report', { token: accountant }, 200)).report;
    check('but it does NOT appear in the income total', afterFee.income.total, 1750.75);
    check('so the net balance is unmoved — §18 reports what was RECORDED, not everything received', afterFee.net_balance, 600);
    const paymentRow = await db.FeePayment.findByPk(collected.id);
    check('and fee_payments.income_id is left NULL, as the module header records', paymentRow.income_id, null);
    check(
      'nothing posted an incomes row behind the API',
      await db.Income.count({ where: { school_id: schoolA.id } }),
      3
    );

    /* ── the net balance is not clamped ── */

    await mkIncome({ title: 'D small income', amount: 100, income_date: '2025-05-10' }, principalD);
    await mkExpense({ title: 'D large expense', amount: 400, expense_date: '2025-05-12' }, principalD);
    const deficit = dataOf(await expectOk('/finance/report', { token: principalD }, 200)).report;
    check('a school that overspent reports a negative balance, not a clamped zero', deficit.net_balance, -300);

    /* ── tenant scoping ── */

    check("and school D's ledger is its own", [deficit.income.total, deficit.expense.total], [100, 400]);
    const listA = await expectOk('/finance/expenses', { token: principalA }, 200);
    const titlesA = dataOf(listA).map((e) => e.title);
    check('a school sees its own expenses', titlesA.includes('Electricity'), true);
    check("and not another school's — the counter-example exists", titlesA.includes('D large expense'), false);
    check(
      'every row in the list belongs to the caller',
      dataOf(listA).every((e) => e.school_id === schoolA.id),
      true
    );
    const foreignShow = await call(`/finance/expenses/${dataOf(await expectOk('/finance/expenses', { token: principalD }, 200))[0].id}`, {
      token: principalA,
    });
    check("another school's expense is not found, not merely forbidden", foreignShow.status, 404);
    check('  and says so', codeOf(foreignShow), 'EXPENSE_NOT_FOUND');

    /*
     * `tenantWhere`'s **organization branch**, actually executed — school D now has an expense, so this
     * has a counter-example to exclude rather than passing over an empty list.
     *
     * Until §5a session 18 this suite's header claimed it exercised that branch while the org admin only
     * ever called `/report`, which never touches `tenantWhere` (it scopes by `school_id` directly). The
     * aliased spelling is the assertion that was failing before the fix: `?schoolId=` satisfied the
     * module gate on school A while the query answered across the whole organization, returning school
     * D's rows — and it did so on all six module-gated routers, not only this one.
     */
    const orgList = await expectOk(`/finance/expenses?school_id=${schoolA.id}`, { token: orgAdmin }, 200);
    const orgTitles = dataOf(orgList).map((e) => e.title);
    check('an organization admin naming a school sees that school', orgTitles.includes('Electricity'), true);
    check("  and not its sibling in the same organization", orgTitles.includes('D large expense'), false);
    const orgAliased = await expectOk(`/finance/expenses?schoolId=${schoolA.id}`, { token: orgAdmin }, 200);
    check(
      '  and the spelling the entitlement gate accepts scopes identically',
      dataOf(orgAliased).map((e) => e.id).sort(),
      dataOf(orgList).map((e) => e.id).sort()
    );
    const orgShowForeign = await call(`/finance/expenses/${dataOf(await expectOk('/finance/expenses', { token: principalD }, 200))[0].id}?schoolId=${schoolA.id}`, {
      token: orgAdmin,
    });
    check('  and a sibling school\'s row is not reachable by id either', orgShowForeign.status, 404);

    const filtered = await expectOk(`/finance/expenses?category=${EXPENSE_CATEGORIES.SALARIES}`, { token: principalA }, 200);
    check('the category filter narrows the list', dataOf(filtered).length, 2);
    /*
     * `listQuery()` injects `q` into every list schema whether or not a module reads it, so a module
     * that ignores it answers a search with every row and looks like it matched everything. Four of the
     * seven school-side modules already implement it; finance and attendance did not (Known Issues).
     */
    const searched = await expectOk('/finance/expenses?q=Electric', { token: principalA }, 200);
    check('a search narrows to what it matched', dataOf(searched).map((e) => e.title), ['Electricity']);
    const searchedMiss = await expectOk('/finance/expenses?q=nothing-matches-this', { token: principalA }, 200);
    check('  and a search that matches nothing returns nothing, not everything', dataOf(searchedMiss).length, 0);

    const windowed = await expectOk('/finance/incomes?from=2025-06-01', { token: principalA }, 200);
    check('and a one-sided window works too', dataOf(windowed).map((i) => i.income_date), ['2025-07-01']);

    /*
     * FR-FIN-002 and FR-FIN-003 both say "the school's" balance. A platform caller has no school, so
     * the report makes them name one rather than adding every school's money together.
     */
    const unscoped = await call('/finance/report', { token: platform });
    check('a platform caller must name the school the balance is about', unscoped.status, 422);
    const platformScoped = dataOf(await expectOk(`/finance/report?school_id=${schoolD.id}`, { token: platform }, 200)).report;
    check('  and naming one gives exactly that school', platformScoped.net_balance, -300);

    /* ── an empty window is zero, not null ── */

    const empty = dataOf(
      await expectOk('/finance/report?from=2030-01-01&to=2030-12-31', { token: accountant }, 200)
    ).report;
    check('an empty window totals zero on both sides', [empty.income.total, empty.expense.total], [0, 0]);
    check('a balance over no transactions is 0, not null — it is defined, and it is zero', empty.net_balance, 0);
    check('every category still appears', Object.keys(empty.expense.by_category).sort(), ['other_expenses', 'salaries']);

    /* ── two currencies do not add up ── */

    await mkIncome({ title: 'Euro grant', amount: 90, income_date: '2025-05-11', currency: 'EUR' });
    const mixed = await call('/finance/report', { token: accountant });
    check('a window holding two currencies refuses to produce one balance', mixed.status, 422);
    check('  and names what it found', mixed.body.error.details.some((d) => /EUR/.test(d.message) && /USD/.test(d.message)), true);
    const usdOnly = dataOf(await expectOk('/finance/report?currency=USD', { token: accountant }, 200)).report;
    check('naming a currency isolates it', usdOnly.income.total, 1750.75);
    check('  and the balance is the one it was before', usdOnly.net_balance, 600);
    const eurOnly = dataOf(await expectOk('/finance/report?currency=EUR', { token: accountant }, 200)).report;
    check('  while the other currency has its own', [eurOnly.income.total, eurOnly.net_balance], [90, 90]);

    /* ── correcting a recorded entry, and the balance following it ── */

    const corrected = dataOf(
      await expectOk(
        `/finance/expenses/${utilities.id}`,
        { method: 'PATCH', token: accountant, body: { amount: 200.75, reason: 'Meter re-read' } },
        200
      )
    ).expense;
    check('a mistyped amount can be corrected', corrected.amount, 200.75);

    /*
     * Both correction routes carry `finance.manage`, asserted rather than assumed. A PATCH that skipped
     * a guard its POST enforced is a defect this project has already shipped once, and neither PATCH was
     * covered here until §5a session 18. The org admin is the sharp case: they hold `finance.view` and
     * not `finance.manage`, and they reach the router at all only because the `school_id` in the body
     * satisfies `requireModule` — so a 403 here is the permission layer, not the entitlement one.
     */
    const orgPatchExpense = await call(`/finance/expenses/${utilities.id}`, {
      method: 'PATCH',
      token: orgAdmin,
      body: { school_id: schoolA.id, amount: 1 },
    });
    check('correcting an expense needs finance.manage, which finance.view does not carry', orgPatchExpense.status, 403);
    check('  and it is the permission that is missing, not the module', codeOf(orgPatchExpense), 'INSUFFICIENT_PERMISSION');
    const receptionPatch = await call(`/finance/expenses/${utilities.id}`, {
      method: 'PATCH',
      token: receptionist,
      body: { amount: 1 },
    });
    check('a receptionist cannot correct one either', receptionPatch.status, 403);
    check(
      '  and the row is untouched by either attempt',
      Number((await db.Expense.findByPk(utilities.id)).amount),
      200.75
    );

    /* The income ledger's own show and correct paths, so all nine endpoints are exercised. */
    const shownIncome = await expectOk(`/finance/incomes/${donation.id}`, { token: principalA }, 200);
    check('an income can be read back by id', dataOf(shownIncome).income.title, 'Alumni donation');
    const correctedIncome = dataOf(
      await expectOk(
        `/finance/incomes/${donation.id}`,
        { method: 'PATCH', token: accountant, body: { received_from: 'Alumni Association (2025)' } },
        200
      )
    ).income;
    check('and corrected', correctedIncome.received_from, 'Alumni Association (2025)');
    const orgPatchIncome = await call(`/finance/incomes/${donation.id}`, {
      method: 'PATCH',
      token: orgAdmin,
      body: { school_id: schoolA.id, amount: 1 },
    });
    check('correcting an income needs finance.manage too', orgPatchIncome.status, 403);
    const afterFix = dataOf(await expectOk('/finance/report?currency=USD', { token: accountant }, 200)).report;
    check('and the net balance moves by exactly the correction — 600.00 − 50.00', afterFix.net_balance, 550);
    check('  with the expense total following it', afterFix.expense.total, 1200.75);

    /* ── the DATEONLY trap, at a western offset (Known Issues #20) ── */

    const tzBefore = process.env.TZ;
    let westExpense = null;
    let westIncome = null;
    try {
      process.env.TZ = 'America/New_York';
      westExpense = await mkExpense({
        title: 'July salary',
        amount: 10,
        expense_date: '2025-07-01',
        category: EXPENSE_CATEGORIES.SALARIES,
        salary_month: '2025-07-01',
        paid_to: 'Someone',
      });
      westIncome = await mkIncome({ title: 'July income', amount: 10, income_date: '2025-07-01' });
    } finally {
      if (tzBefore === undefined) delete process.env.TZ;
      else process.env.TZ = tzBefore;
    }
    check('expense_date survives a west-of-UTC server', westExpense.expense_date, '2025-07-01');
    check('and salary_month does too — both DATEONLY columns on the row, not just one', westExpense.salary_month, '2025-07-01');
    check('and income_date on the other table', westIncome.income_date, '2025-07-01');
    const [rawRows] = await db.sequelize.query(
      `SELECT expense_date, salary_month FROM expenses WHERE id = ${Number(westExpense.id)}`
    );
    check('and the row on disk holds the same day', [
      String(rawRows[0].expense_date).slice(0, 10),
      String(rawRows[0].salary_month).slice(0, 10),
    ], ['2025-07-01', '2025-07-01']);

    /*
     * Money precision, asserted last so the row it writes cannot disturb the hand-computed ledger above.
     *
     * The response, the row and every later report must be the same figure. Without `.precision(2)` on
     * the money field Joi accepted 10.999, the column stored 11.00, and the create response echoed back
     * the instance still holding 10.999 — the API stating one number while the ledger held another, and
     * the audit trail recording the number that was never stored.
     */
    const subCent = await mkExpense({ title: 'Sub-cent', amount: 10.999, expense_date: '2025-09-01' });
    check('an amount finer than the column scale is rounded to what the ledger will hold', subCent.amount, 11);
    check(
      '  and the row on disk agrees with what the API returned',
      Number((await db.Expense.findByPk(subCent.id)).amount),
      subCent.amount
    );

    /* ── the trail ── */

    const financeActivity = await settleDistinct(
      async () => (await db.ActivityLog.findAll({
        where: { id: { [db.Op.gt]: baseline.activityLog } },
        order: [['id', 'ASC']],
      })).filter((r) => ['income', 'expense'].includes(r.entity_type)),
      'entity_type',
      2
    );
    check('every finance write is in the activity trail', financeActivity.length > 0, true);
    check(
      'both ledgers appear',
      [...new Set(financeActivity.map((r) => r.entity_type))].sort(),
      ['expense', 'income']
    );

    const audits = await db.AuditLog.findAll({
      where: {
        id: { [db.Op.gt]: baseline.auditLog },
        table_name: { [db.Op.in]: ['incomes', 'expenses'] },
      },
    });
    check(
      'both finance tables are audited per row',
      [...new Set(audits.map((r) => r.table_name))].sort(),
      ['expenses', 'incomes']
    );
    const correction = audits.find((r) => r.table_name === 'expenses' && r.event === 'update');
    check('a correction is audited as an update, not silently', Boolean(correction), true);
    check('  carrying the reason it was given', correction.reason, 'Meter re-read');
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-finance Part 3 teardown failed:', err);
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
    console.error('\nverify-finance crashed:', err);
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
          ? 'All pure finance checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All finance checks passed (Parts 1–3).'
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
