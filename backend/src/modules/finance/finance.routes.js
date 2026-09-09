'use strict';

/**
 * Finance routes — mounted at `/api/v1/finance`.
 *
 * | SRS | FR                     | Route                    | Permission       |
 * |-----|------------------------|--------------------------|------------------|
 * | §18 | FR-FIN-002 / FR-FIN-003 | `GET /report`            | `finance.view`   |
 * | §18 | FR-FIN-001             | `GET /incomes`           | `finance.view`   |
 * | §18 | FR-FIN-001             | `POST /incomes`          | `finance.manage` |
 * | §18 | FR-FIN-001             | `GET /incomes/:id`       | `finance.view`   |
 * | §18 | FR-FIN-001             | `PATCH /incomes/:id`     | `finance.manage` |
 * | §18 | FR-FIN-001             | `GET /expenses`          | `finance.view`   |
 * | §18 | FR-FIN-001             | `POST /expenses`         | `finance.manage` |
 * | §18 | FR-FIN-001             | `GET /expenses/:id`      | `finance.view`   |
 * | §18 | FR-FIN-001             | `PATCH /expenses/:id`    | `finance.manage` |
 *
 * ## The permission split is the seeded catalogue's, and it is wider than §18 on one route
 *
 * FR-FIN-001 names Accountant / Principal / School Admin, and `finance.manage` is granted to exactly
 * those three plus Super Admin — an exact match, and it is the key every write here carries.
 *
 * `finance.view` is **wider than FR-FIN-003's actor list**: it adds Organization Admin, who therefore
 * reads `GET /report` even though §18 names only Accountant / Principal / School Admin as the actors who
 * view financial reports. That widening is the seeded catalogue's, not this router's — the 109
 * permissions and their default grants are fixed by §29/§30 — and it is stated here rather than papered
 * over by the "may read but not record" summary, which describes the split accurately but quietly
 * concedes the mismatch. The useful half of that summary still holds: an Organization Admin can read
 * and cannot record, and the suite asserts both directions.
 *
 * ## Why the net balance has no route of its own
 *
 * FR-FIN-002's actor is literally **"System"**, not a human role: it is a computation the system
 * performs, and its outcome is that the figure *"is displayed on the finance dashboard"*. The seeded
 * permission agrees — `finance.view` is one key named **"View income, expenses & net balance"**,
 * bundling all three read surfaces, and §29/§30 fix that set so it could not be split even if it
 * should be. `net_balance` is therefore a field on `GET /report`, exactly as FR-ATT-002's percentage is
 * a field on the attendance report rather than an endpoint. Calling `/report` with no `from`/`to` is
 * the dashboard figure.
 *
 * ## Why there is one report and no periods
 *
 * §18 names no period, no grouping and no export. **SRS §22 is a separate "Reports" section** naming
 * *"Expense Reports"* and *"Fee Reports"* among seven report types with PDF / Excel / Print export
 * (FR-REPORT-001 / FR-REPORT-002), and no module implements it yet. A daily/monthly/yearly enum here
 * would transcribe §16's requirement into a section that named none, and would pre-empt §22. The report
 * takes an optional `from`/`to` range instead, which names no taxonomy and contains every period.
 *
 * ## No DELETE, and why PATCH is nonetheless here
 *
 * Neither table is `paranoid` — `models/finance.js` gives both `modelOptions`, not
 * `softDeleteOptions` — so there is no `deleted_at` and a DELETE would be a hard delete of a financial
 * record. §18 names no such operation and none is mounted.
 *
 * PATCH is a closer call and is recorded as such. §18's write verb is *"records"*, and `finance.manage`
 * is named "Record income & expenses"; an edit path is not something the source spells out. It is here
 * because the schema supports it and the alternative is worse: both tables carry `updated_at`, neither
 * carries a `status`, `posted_at` or `voided_at` column marking a row immutable, and with no DELETE
 * either, a single mistyped amount would permanently corrupt the one figure FR-FIN-002 defines — with
 * nothing able to correct it. Attendance needs no PATCH because re-posting a register *is* the
 * correction; `fee_payments` has none because a receipt is money that changed hands and was handed to a
 * parent. A finance entry is the school's own bookkeeping record, and every correction lands in
 * `audit_logs` with the before/after, so it is visible rather than silent.
 *
 * `requireModule(MODULES.FINANCE)` is mounted router-level. **No `enforceLimit`**: §11.2's eight limits
 * contain nothing finance-shaped, and a ledger row is not a headcount. Asserted against the router.
 *
 * `/report` sits at the router root, so no `:id` parameter can shadow it — by construction rather than
 * by declaration order. It is declared first anyway, so the file reads in FR order.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireModule,
} = require('../../middlewares');
const { MODULES } = require('../../config/constants');

const controller = require('./finance.controller');
const { schemas } = require('./finance.validation');

const router = createRouter();

router.use(requireModule(MODULES.FINANCE));

/* ── FR-FIN-002 + FR-FIN-003 ── */

router.get(
  '/report',
  requirePermission('finance.view'),
  validate({ query: schemas.report }),
  asyncHandler(controller.report)
);

/* ── FR-FIN-001, income ── */

router.get(
  '/incomes',
  requirePermission('finance.view'),
  validate({ query: schemas.listIncomes }),
  asyncHandler(controller.listIncomes)
);

router.post(
  '/incomes',
  requirePermission('finance.manage'),
  validate({ body: schemas.createIncome }),
  logActivity({ action: 'create', entityType: 'income', onlyOnSuccess: true }),
  asyncHandler(controller.createIncome)
);

router.get(
  '/incomes/:id',
  requirePermission('finance.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.showIncome)
);

router.patch(
  '/incomes/:id',
  requirePermission('finance.manage'),
  validate({ params: schemas.idParam, body: schemas.updateIncome }),
  logActivity({ action: 'update', entityType: 'income', onlyOnSuccess: true }),
  asyncHandler(controller.updateIncome)
);

/* ── FR-FIN-001, expenses — including Salaries and Other Expenses ── */

router.get(
  '/expenses',
  requirePermission('finance.view'),
  validate({ query: schemas.listExpenses }),
  asyncHandler(controller.listExpenses)
);

router.post(
  '/expenses',
  requirePermission('finance.manage'),
  validate({ body: schemas.createExpense }),
  logActivity({ action: 'create', entityType: 'expense', onlyOnSuccess: true }),
  asyncHandler(controller.createExpense)
);

router.get(
  '/expenses/:id',
  requirePermission('finance.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.showExpense)
);

router.patch(
  '/expenses/:id',
  requirePermission('finance.manage'),
  validate({ params: schemas.idParam, body: schemas.updateExpense }),
  logActivity({ action: 'update', entityType: 'expense', onlyOnSuccess: true }),
  asyncHandler(controller.updateExpense)
);

module.exports = router;
