'use strict';

/**
 * Finance schemas — SRS §18, FR-FIN-001 (record income & expenses), FR-FIN-002 (net balance) and
 * FR-FIN-003 (financial reports).
 *
 * Both category lists are **closed enums fixed by §29/§35** — `salaries | other_expenses` and
 * `fees | other_income` — and the accepted values are asserted schema-against-**model** in the suite
 * (`db.Expense.rawAttributes.category.values`), not schema-against-constant, so the two cannot drift.
 *
 * `expense_date`, `income_date` and `salary_month` are `DATEONLY`, normalised in the service through
 * `dates.toDateOnly()` (Known Issues #20).
 *
 * Every money field is bounded at its column's `DECIMAL(14,2)`, and every string at its column width
 * read off `models/finance.js` — the width-versus-column discipline of §5a defect 24.
 *
 * ## Two columns deliberately refused
 *
 * `attachment_path` is **not** accepted from a request body. Every other stored path in this codebase
 * comes from multer via `relativeUploadPath(req.file)` (`payments.service.js`), never from a caller —
 * a body-supplied path is a caller writing a filesystem location into the database. §18 describes no
 * upload step, so the column stays unwritten rather than becoming an injection point.
 *
 * `recorded_by` is taken from the authenticated user, like every other actor column in the project.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  PAYMENT_METHOD_LIST,
} = require('../../config/constants');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

/**
 * `DECIMAL(14,2)` — twelve digits before the point and **two after**.
 *
 * `.precision(2)` is not decoration. Without it Joi accepted `10.999`, the column stored `11.00`, and
 * the `create` response echoed back the Sequelize instance still holding `10.999` — so the API told the
 * caller one number while every subsequent report used another, and the audit trail recorded the number
 * that was never stored. Under `convert: true` this rounds to what the column will hold, which makes the
 * response, the row and the report the same figure by construction.
 */
const moneyField = Joi.number().min(0).max(999999999999.99).precision(2);

const shared = {
  school_id: Joi.number().integer().min(1),
  academic_session_id: Joi.number().integer().min(1).allow(null),
  subcategory: Joi.string().trim().max(120).empty('').allow(null),
  title: Joi.string().trim().min(1).max(180),
  description: Joi.string().trim().max(5000).empty('').allow(null),
  currency: Joi.string().trim().uppercase().max(10),
  amount: moneyField,
  payment_method: Joi.string().valid(...PAYMENT_METHOD_LIST).allow(null),
  reference: Joi.string().trim().max(160).empty('').allow(null),
  metadata: Joi.object().unknown(true).allow(null),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

/**
 * An ordered `from`/`to` window, the shape `commonSchemas.dateRange` already defines.
 *
 * `to` is `.min(Joi.ref('from'))` for a reason the report makes sharp: a transposed window matches no
 * rows, so both totals fold to zero and the endpoint answers **200 with `net_balance: 0.00`** — a
 * confident, precise, wrong figure that looks exactly like a school with balanced books. Refusing the
 * window is the only answer that cannot be misread, and the codebase had already decided that at
 * `middlewares/validate.js:156`; this module simply failed to use it.
 *
 * The ordering is applied **only when `from` is actually present**. `commonSchemas.dateRange` writes it
 * as a bare `.min(Joi.ref('from'))`, which refuses a `to`-only window outright: Joi cannot resolve the
 * reference and errors rather than skipping the rule. Both bounds are optional here and either alone is
 * a meaningful window — "everything up to March" as much as "everything since March" — so the rule is
 * conditioned rather than copied verbatim. (`commonSchemas.dateRange` has the same wart; it is recorded
 * in Known Issues rather than changed underneath the modules already relying on it.)
 */
const orderedWindow = (isoField) => ({
  from: isoField,
  to: isoField.when('from', { is: Joi.exist(), then: isoField.min(Joi.ref('from')) }),
});

const owned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
  recorded_by: forbiddenField('"recorded_by" is taken from the authenticated user'),
  attachment_path: forbiddenField('"attachment_path" is written by an upload, never by a request body'),
};

/* ── FR-FIN-001, the expense half ── */

const expenseFields = {
  category: Joi.string().valid(...Object.values(EXPENSE_CATEGORIES)),
  expense_date: Joi.date().iso(),
  salary_month: Joi.date().iso().allow(null),
  teacher_id: Joi.number().integer().min(1).allow(null),
  staff_id: Joi.number().integer().min(1).allow(null),
  paid_to: Joi.string().trim().max(180).empty('').allow(null),
};

const createExpense = Joi.object({
  school_id: shared.school_id,
  title: shared.title.required(),
  amount: shared.amount.required(),
  expense_date: expenseFields.expense_date.required(),
  /*
   * `category` defaults to `other_expenses` at the column, so it is optional here — but a `salaries`
   * expense must identify who was paid, which the model's own `salaryNeedsRecipient` validator
   * enforces and the service surfaces as a 422 rather than a 500.
   */
  category: expenseFields.category,
  subcategory: shared.subcategory,
  description: shared.description,
  currency: shared.currency,
  academic_session_id: shared.academic_session_id,
  payment_method: shared.payment_method,
  reference: shared.reference,
  teacher_id: expenseFields.teacher_id,
  staff_id: expenseFields.staff_id,
  salary_month: expenseFields.salary_month,
  paid_to: expenseFields.paid_to,
  metadata: shared.metadata,
  reason: shared.reason,
  ...owned,
});

const updateExpense = Joi.object({
  school_id: shared.school_id,
  title: shared.title,
  amount: shared.amount,
  expense_date: expenseFields.expense_date,
  category: expenseFields.category,
  subcategory: shared.subcategory,
  description: shared.description,
  currency: shared.currency,
  academic_session_id: shared.academic_session_id,
  payment_method: shared.payment_method,
  reference: shared.reference,
  teacher_id: expenseFields.teacher_id,
  staff_id: expenseFields.staff_id,
  salary_month: expenseFields.salary_month,
  paid_to: expenseFields.paid_to,
  metadata: shared.metadata,
  reason: shared.reason,
  ...owned,
}).min(1);

/* ── FR-FIN-001, the income half ── */

const incomeFields = {
  category: Joi.string().valid(...Object.values(INCOME_CATEGORIES)),
  income_date: Joi.date().iso(),
  received_from: Joi.string().trim().max(180).empty('').allow(null),
  student_id: Joi.number().integer().min(1).allow(null),
};

const createIncome = Joi.object({
  school_id: shared.school_id,
  title: shared.title.required(),
  amount: shared.amount.required(),
  income_date: incomeFields.income_date.required(),
  /*
   * `category` accepts `fees` as well as `other_income`. Nothing posts a fee collection here
   * automatically — see the service header — so this is the one path by which a `fees` income row
   * comes into existence, recorded by the human actor FR-FIN-001 names. `student_id` is accepted for
   * the same reason: the column exists to say which child the money came from.
   */
  category: incomeFields.category,
  subcategory: shared.subcategory,
  description: shared.description,
  currency: shared.currency,
  academic_session_id: shared.academic_session_id,
  payment_method: shared.payment_method,
  reference: shared.reference,
  received_from: incomeFields.received_from,
  student_id: incomeFields.student_id,
  metadata: shared.metadata,
  reason: shared.reason,
  ...owned,
});

const updateIncome = Joi.object({
  school_id: shared.school_id,
  title: shared.title,
  amount: shared.amount,
  income_date: incomeFields.income_date,
  category: incomeFields.category,
  subcategory: shared.subcategory,
  description: shared.description,
  currency: shared.currency,
  academic_session_id: shared.academic_session_id,
  payment_method: shared.payment_method,
  reference: shared.reference,
  received_from: incomeFields.received_from,
  student_id: incomeFields.student_id,
  metadata: shared.metadata,
  reason: shared.reason,
  ...owned,
}).min(1);

/* ── the lists ── */

const listExpenses = listQuery(
  Joi.object({
    school_id: shared.school_id,
    category: expenseFields.category,
    academic_session_id: shared.academic_session_id,
    payment_method: shared.payment_method,
    currency: shared.currency,
    teacher_id: expenseFields.teacher_id,
    staff_id: expenseFields.staff_id,
    ...orderedWindow(expenseFields.expense_date),
  })
);

const listIncomes = listQuery(
  Joi.object({
    school_id: shared.school_id,
    category: incomeFields.category,
    academic_session_id: shared.academic_session_id,
    payment_method: shared.payment_method,
    currency: shared.currency,
    student_id: incomeFields.student_id,
    ...orderedWindow(incomeFields.income_date),
  })
);

/**
 * FR-FIN-002 + FR-FIN-003 — the one read that answers both.
 *
 * A **plain `Joi.object`, not `listQuery`**: a report is not a page of rows, so it takes no
 * `page`/`limit`/`sortBy`. The attendance report is shaped the same way for the same reason.
 *
 * There is deliberately **no `period` enum and no `interval`**. §16 named Daily / Monthly / Yearly and
 * so attendance offers exactly those three; §18 names no period at all, and §22 — a separate "Reports"
 * section with its own FR-REPORT-001/002 and PDF/Excel/Print export — is where "Expense Reports" and
 * "Fee Reports" actually live. A period taxonomy here would pre-empt a module that has not been built.
 *
 * There is also no `category` filter: a net balance computed over one category is not a net balance.
 * The breakdown is in the response instead, where it sums back to the total.
 */
const report = Joi.object({
  school_id: shared.school_id,
  ...orderedWindow(Joi.date().iso()),
  currency: shared.currency,
});

const showQuery = Joi.object({ school_id: shared.school_id });

module.exports = {
  schemas: {
    createExpense,
    updateExpense,
    createIncome,
    updateIncome,
    listExpenses,
    listIncomes,
    report,
    showQuery,
    idParam: commonSchemas.idParam,
  },
  shared,
  expenseFields,
  incomeFields,
};
