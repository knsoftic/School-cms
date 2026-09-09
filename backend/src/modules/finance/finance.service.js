'use strict';

/**
 * Finance — SRS §18, FR-FIN-001 (record income & expenses), FR-FIN-002 (net balance) and
 * FR-FIN-003 (financial reports).
 *
 * Two tables, `incomes` and `expenses`, and one derived figure the source states outright:
 *
 *     Net Balance = Income − Expense
 *
 * `models/finance.js:10` says that figure is *"computed at query time, never stored"*, and there is no
 * `net_balance` column to store it in — §35 forbids adding one. So it is a field on a report, not a
 * row.
 *
 * ## The gap this module has, stated up front because it is the first thing a reader will notice
 *
 * **A fee collection does not appear in the Net Balance.** `POST /fees/payments` writes a `fee_payments`
 * row and recomputes the `student_fees` row it settles — and it touches **neither finance table**: it
 * creates no `incomes` row and leaves `fee_payments.income_id` NULL. This report reads `incomes` and
 * `expenses` and nothing else, so a school that has collected tuition and paid salaries will see the
 * salaries and not the tuition.
 *
 * That is deliberate, and it is the reading three independent reviews reached separately:
 *
 *  - §18's functional behaviour is *"User records Income entries"* and *"User records Expense
 *    entries"* — a manual action by the Accountant / Principal / School Admin it names. It never
 *    mentions fees, never describes a posting step, and closes with *"No other financial functionality
 *    is documented in the source."*
 *  - FR-FIN-003 says the reports are based on **recorded** Income and Expenses. Rows in these two
 *    tables are what "recorded" means.
 *  - A report that quietly read `fee_payments` would double-count the moment anyone records that money
 *    as an income row — neither table has a unique index to stop them — and it would couple `/finance`
 *    to `MODULES.FEES`, a separately subscribable key that `requireModule` never checks on this router.
 *  - It would also cross a permission boundary: `fees.collect` reaches a Receptionist, `finance.manage`
 *    does not.
 *
 * The schema clearly anticipated a posting step — `INCOME_CATEGORIES.FEES` exists, `incomes.student_id`
 * exists, and `fee_payments.income_id` carries the comment *"Set when this collection has been posted
 * to `incomes`, so it posts once."* That proves the schema anticipated it. It does not prove the
 * requirement asks for it, and the two are not the same thing. So the columns stay unwritten by any
 * automatic path, the consequence is recorded here and asserted in `verify-finance.js` (a fee
 * collection leaves `income_id` NULL and moves the Net Balance by exactly zero), and adding the posting
 * step later is a purely additive change. A report that secretly read `fee_payments` would not be.
 *
 * What a human *can* do is record that money themselves: `POST /finance/incomes` accepts
 * `category: 'fees'` and `student_id`, so the fee-shaped columns are filled by the actor FR-FIN-001
 * names rather than left dead.
 *
 * ## Why there is one report endpoint and no period enum
 *
 * §16 named Daily, Monthly and Yearly, so the attendance report offers exactly those three. §18 names
 * no period, no grouping and no export — and **SRS §22 is a separate "Reports" section** that names
 * *"Expense Reports"* and *"Fee Reports"* among seven report types, with PDF / Excel / Print export
 * (FR-REPORT-001, FR-REPORT-002). The rich reporting surface belongs to a module that has not been
 * built. Building a period taxonomy or a time series here would pre-empt it and grow a second pattern.
 *
 * What §18 *does* name is the breakdown: its own vocabulary list is Income · Expenses · **Salaries** ·
 * **Other Expenses**, and FR-FIN-001 repeats *"including Salaries and Other Expenses"*. So the expense
 * total is partitioned along `EXPENSE_CATEGORIES`, which is closed at exactly those two and therefore
 * sums back to the total with no residual. The income side is partitioned the same way for symmetry;
 * that axis comes from the fixed `INCOME_CATEGORIES` enum rather than from §18's text, and it is called
 * out here because it is the softer half. It also earns its place: zero-filling `fees: 0` puts the gap
 * described above on the screen instead of leaving it invisible.
 *
 * ## The aggregate, and the trap in it
 *
 * The grouped sum is `findAll` + `fn('SUM', col('amount'))` + `group` + `raw: true` — the shape
 * `attendance.report()` uses with COUNT swapped for SUM. It is **not** `Model.sum('amount', {group})`:
 * that call silently returns only the *first* group's number. Verified against this database — three
 * expenses (salaries 100, salaries 50, other_expenses 25) return `150` from `Model.sum` with a group
 * and the correct two-row breakdown from `findAll`. A plausible figure that is wrong is the worst
 * possible result for a financial report, so this is pinned by an assertion in the suite.
 *
 * `raw: true` is safe here only because the selection is `category`, `currency` and the SUM alias —
 * no JSON column. Both tables carry `metadata`, which under `raw: true` would come back a string
 * (§8's standing trap); it is never selected.
 *
 * ## Currency
 *
 * `school_settings.currency` (SRS §14.1) says a school has one currency, but every row here carries its
 * own `currency` column and `SUM(amount)` would happily add pesos to dollars. So the aggregate groups
 * by currency as well as category, and if a window contains more than one currency and the caller named
 * none, the report **refuses** with a 422 listing what it found. A single net balance across two
 * currencies is not a number that means anything, and this codebase fails closed rather than emit a
 * plausible wrong answer — the same instinct that makes `tenantWhere()` throw rather than build an
 * unscoped query.
 *
 * ## Two small decisions worth naming
 *
 * `net_balance` is **0** over an empty window, not `null`. Attendance returns `null` for its percentage
 * because a ratio over zero marks is *undefined*; a balance over zero transactions is defined, and it
 * is zero.
 *
 * `net_balance` is **never** `clampNonNegative`'d. A school that spent more than it took in has a
 * negative balance, and reporting that as 0.00 would hide a deficit.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const money = require('../../utils/money');
const dates = require('../../utils/dates');
const { resolveSchool, loadTeacherInSchool, loadSessionInSchool } = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { EXPENSE_CATEGORIES, INCOME_CATEGORIES } = require('../../config/constants');

const EXPENSE_CATEGORY_LIST = Object.freeze(Object.values(EXPENSE_CATEGORIES));
const INCOME_CATEGORY_LIST = Object.freeze(Object.values(INCOME_CATEGORIES));

const EXPENSE_SORTABLE = Object.freeze(['id', 'expense_date', 'amount', 'category', 'title', 'created_at']);
const INCOME_SORTABLE = Object.freeze(['id', 'income_date', 'amount', 'category', 'title', 'created_at']);

const EXPENSE_EDITABLE = Object.freeze([
  'category',
  'subcategory',
  'title',
  'description',
  'currency',
  'amount',
  'expense_date',
  'payment_method',
  'reference',
  'teacher_id',
  'staff_id',
  'salary_month',
  'paid_to',
  'academic_session_id',
  'metadata',
]);

const INCOME_EDITABLE = Object.freeze([
  'category',
  'subcategory',
  'title',
  'description',
  'currency',
  'amount',
  'income_date',
  'payment_method',
  'reference',
  'received_from',
  'student_id',
  'academic_session_id',
  'metadata',
]);

/** The two tables, described once so the CRUD below is written once rather than twice. */
const LEDGERS = Object.freeze({
  expense: {
    key: 'expense',
    model: 'Expense',
    table: 'expenses',
    dateColumn: 'expense_date',
    dateOnlyColumns: ['expense_date', 'salary_month'],
    editable: EXPENSE_EDITABLE,
    sortable: EXPENSE_SORTABLE,
    defaultSort: ['expense_date', 'DESC'],
    categories: EXPENSE_CATEGORY_LIST,
    notFound: { message: 'Expense not found', code: 'EXPENSE_NOT_FOUND' },
  },
  income: {
    key: 'income',
    model: 'Income',
    table: 'incomes',
    dateColumn: 'income_date',
    dateOnlyColumns: ['income_date'],
    editable: INCOME_EDITABLE,
    sortable: INCOME_SORTABLE,
    defaultSort: ['income_date', 'DESC'],
    categories: INCOME_CATEGORY_LIST,
    notFound: { message: 'Income not found', code: 'INCOME_NOT_FOUND' },
  },
});

function modelOf(ledger) {
  return db[ledger.model];
}

function dateOnly(value) {
  return value === undefined || value === null || value === '' ? value : dates.toDateOnly(value);
}

/** Normalise every `DATEONLY` column on a payload — all of them, not the obvious one. */
function normaliseDates(ledger, payload) {
  const next = { ...payload };
  for (const column of ledger.dateOnlyColumns) {
    if (Object.prototype.hasOwnProperty.call(next, column)) next[column] = dateOnly(next[column]);
  }
  return next;
}

function pick(ledger, payload) {
  const next = {};
  for (const key of ledger.editable) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) next[key] = payload[key];
  }
  return next;
}

function rethrow(err) {
  if (err instanceof db.Sequelize.ValidationError) {
    /*
     * `expenses` carries the model-level validator `salaryNeedsRecipient`: a `salaries` row must name a
     * teacher, a staff member or a `paid_to`. Surfaced as a 422 rather than escaping as a 500.
     */
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  if (err instanceof db.Sequelize.ForeignKeyConstraintError) {
    /*
     * The constraint's own name is deliberately not echoed. `err.index` is a database identifier like
     * `expenses_ibfk_3`, which tells a caller nothing they can act on and discloses internal schema
     * naming in a client-visible body. Every foreign key this module accepts is already checked
     * in-school by `assertReferencesInSchool()`, so reaching here at all means a row vanished between
     * that check and the write — a race, not a caller error they could correct from the message.
     */
    throw ApiError.validation('A referenced record does not exist', [
      { field: 'body', message: 'One of the records this entry refers to no longer exists' },
    ]);
  }
  throw err;
}

/** A staff member in this school. `schoolScope` has no loader for `staff`, so this is the local one. */
async function loadStaffInSchool(staffId, schoolId) {
  const row = await db.Staff.findOne({ where: { id: staffId, school_id: schoolId } });
  if (!row) {
    throw ApiError.validation('That staff member is not in this school', [
      { field: 'staff_id', message: 'Unknown staff member for this school' },
    ]);
  }
  return row;
}

async function loadStudentInSchool(studentId, schoolId) {
  const row = await db.Student.findOne({ where: { id: studentId, school_id: schoolId } });
  if (!row) {
    throw ApiError.validation('That student is not in this school', [
      { field: 'student_id', message: 'Unknown student for this school' },
    ]);
  }
  return row;
}

/**
 * Every optional foreign key on a finance row must point inside the same school.
 *
 * Unchecked cross-tenant FKs were §5a defects 29 and 30 in the students module; this is the same class
 * of hole, on four columns at once.
 */
async function assertReferencesInSchool(ledger, payload, schoolId) {
  if (payload.academic_session_id) await loadSessionInSchool(payload.academic_session_id, schoolId);
  if (ledger.key === 'expense') {
    if (payload.teacher_id) await loadTeacherInSchool(payload.teacher_id, schoolId);
    if (payload.staff_id) await loadStaffInSchool(payload.staff_id, schoolId);
  } else if (payload.student_id) {
    await loadStudentInSchool(payload.student_id, schoolId);
  }
}

/* ── FR-FIN-001 — recording ── */

async function findEntry(req, ledger, id, namedSchoolId = undefined) {
  const where = tenantWhere(req.tenant, { id });
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;
  /*
   * Keep the record and the entitlement guard on the same school — §5a defect 22.
   *
   * The platform caller is deliberately **not** excluded here. Excluding them bought nothing:
   * `resolveSchool()` already handles all three scopes, and `named` is only truthy when the caller
   * named a school themselves — so the exclusion did not relax a constraint, it discarded the one
   * scope declaration a Super Admin can make. `PATCH /finance/expenses/64` with `school_id: A` in the
   * body would edit row 64 wherever it lived, silently writing to another school's books instead of
   * answering 404.
   */
  if (named) {
    const school = await resolveSchool(req, named);
    where.school_id = school.id;
  }
  const row = await modelOf(ledger).findOne({ where });
  if (!row) throw ApiError.notFound(ledger.notFound.message, { code: ledger.notFound.code });
  return row;
}

async function listEntries(req, ledger, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  for (const field of ['category', 'academic_session_id', 'payment_method', 'currency', 'teacher_id', 'staff_id', 'student_id']) {
    if (query[field] !== undefined) where[field] = query[field];
  }
  if (query.from || query.to) {
    /* Inclusive on both ends — a report that drops the last day of the month is wrong by a day. */
    where[ledger.dateColumn] = {
      ...(query.from ? { [Op.gte]: dateOnly(query.from) } : {}),
      ...(query.to ? { [Op.lte]: dateOnly(query.to) } : {}),
    };
  }

  /*
   * `listQuery()` injects `q` into every list schema, so it arrives validated whether or not a module
   * uses it. Ignoring it is the silent kind of wrong: a caller searching for "electricity" would get
   * every row back and reasonably conclude everything matched. Four of the seven school-side modules —
   * students, teachers, staff and parents — already implement it over their free-text columns, so this
   * follows the house convention rather than inventing a search §18 does not name. The columns searched
   * are the three free-text ones both ledgers share.
   */
  if (query.q) {
    where[Op.or] = [
      { title: { [Op.like]: `%${query.q}%` } },
      { subcategory: { [Op.like]: `%${query.q}%` } },
      { reference: { [Op.like]: `%${query.q}%` } },
    ];
  }

  return paginateQuery(
    modelOf(ledger),
    { where, order: getSort({ query }, ledger.sortable, ledger.defaultSort) },
    pagination
  );
}

async function createEntry(req, ledger, payload) {
  const school = await resolveSchool(req, payload.school_id);
  await assertReferencesInSchool(ledger, payload, school.id);

  let row;
  try {
    row = await modelOf(ledger).create({
      school_id: school.id,
      organization_id: school.organization_id,
      recorded_by: req.user ? req.user.id : null,
      ...normaliseDates(ledger, pick(ledger, payload)),
    });
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: ledger.table,
    recordId: row.id,
    event: 'create',
    before: null,
    after: snapshot(row),
    reason: payload.reason || null,
  });
  return row;
}

/**
 * Correct a recorded entry.
 *
 * §18's write verb is *"records"* and `finance.manage` is named "Record income & expenses", so an edit
 * path is not something the source names outright. It is here because the alternative is worse and the
 * schema supports it: neither table is `paranoid` and neither carries a `status`, `posted_at` or
 * `voided_at` column that would mark a row immutable, both carry `updated_at`, and with no DELETE
 * either a single mistyped amount would permanently corrupt the one figure FR-FIN-002 defines. Nothing
 * else can correct it — unlike attendance, where re-posting a register is itself the correction.
 *
 * The contrast with §17 is the discriminator: `fee_payments` has no edit path because a receipt is
 * money that changed hands and was handed to a parent. An expense entry is a bookkeeping record of the
 * school's own, and correcting one's own books is what `updated_at` is for. The audit trail records
 * every field that moved, so a correction is visible rather than silent.
 */
async function updateEntry(req, ledger, id, payload) {
  const row = await findEntry(req, ledger, id, payload.school_id);
  await assertReferencesInSchool(ledger, payload, row.school_id);

  const before = snapshot(row);
  const next = normaliseDates(ledger, pick(ledger, payload));
  if (!Object.keys(next).length) {
    throw ApiError.validation(`No ${ledger.key} fields to update`, [
      { field: 'body', message: 'Send at least one field' },
    ]);
  }

  row.set(next);
  try {
    await row.save();
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: ledger.table,
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });
  return row;
}

/* ── FR-FIN-002 + FR-FIN-003 — the report ── */

/**
 * One grouped sum over one table, keyed by category and currency.
 *
 * `findAll` + `fn('SUM')` + `group`, never `Model.sum(col, {group})` — see the header. Returns raw
 * rows; the caller folds them, because deciding what to do about multiple currencies is the caller's
 * job and not this function's.
 */
async function sumByCategory(ledger, where) {
  return modelOf(ledger).findAll({
    where,
    attributes: [
      'category',
      'currency',
      [db.sequelize.fn('SUM', db.sequelize.col('amount')), 'total'],
    ],
    group: ['category', 'currency'],
    /* Safe only because no JSON column is selected — `metadata` would come back a string (§8). */
    raw: true,
  });
}

/**
 * Fold the grouped rows into `{ total, by_category }`.
 *
 * Zero-filled from the category list, so a category with no rows still appears as `0` rather than
 * vanishing — a report a reader has to guess at is worse than a longer one (the reasoning
 * `attendance.report()` gives for seeding every status).
 *
 * **The total is summed from the rows, not from the known buckets.** Those are the same number today,
 * because `category` is a NOT NULL enum closed at two values and MariaDB rejects anything else. They
 * would stop being the same the moment the enum grew: a row in a category the list did not know about
 * would get its own bucket and be **left out of the total**, so the buckets would no longer sum to the
 * figure printed beside them and the net balance would quietly under-report. Summing the rows makes
 * "the buckets sum to the total" true by construction instead of true by coincidence, which for a
 * financial figure is the difference worth two lines.
 */
function foldBuckets(rows, categories) {
  const byCategory = {};
  for (const category of categories) byCategory[category] = 0;
  for (const row of rows) {
    const category = row.category === null || row.category === undefined ? 'unknown' : row.category;
    byCategory[category] = money.sum(byCategory[category] || 0, money.toNumber(row.total));
  }
  const total = money.sum(rows.map((row) => money.toNumber(row.total)));
  return { total, by_category: byCategory };
}

async function report(req, query) {
  /*
   * Resolved unconditionally, not only when `school_id` is named. FR-FIN-002 and FR-FIN-003 both say
   * *"the school's"* — one school. Without this, `tenantWhere` would hand a platform caller every
   * school's money added together and label it the same way.
   */
  const school = await resolveSchool(req, query.school_id);

  const from = dateOnly(query.from);
  const to = dateOnly(query.to);
  const currency = query.currency || null;

  const rangeOf = (column) =>
    from || to
      ? {
          [column]: {
            ...(from ? { [Op.gte]: from } : {}),
            ...(to ? { [Op.lte]: to } : {}),
          },
        }
      : {};

  const scoped = (ledger) => ({
    school_id: school.id,
    ...(currency ? { currency } : {}),
    ...rangeOf(ledger.dateColumn),
  });

  const [incomeRows, expenseRows] = await Promise.all([
    sumByCategory(LEDGERS.income, scoped(LEDGERS.income)),
    sumByCategory(LEDGERS.expense, scoped(LEDGERS.expense)),
  ]);

  /* Adding two currencies together produces a number that means nothing. Refuse instead. */
  const currencies = [...new Set([...incomeRows, ...expenseRows].map((r) => r.currency))].sort();
  if (!currency && currencies.length > 1) {
    throw ApiError.validation(
      'This window holds more than one currency, so a single net balance is undefined',
      [{ field: 'currency', message: `Name one of: ${currencies.join(', ')}` }]
    );
  }

  const income = foldBuckets(incomeRows, INCOME_CATEGORY_LIST);
  const expense = foldBuckets(expenseRows, EXPENSE_CATEGORY_LIST);

  return {
    scope: { school_id: school.id },
    from: from || null,
    to: to || null,
    /* The currency the figures are in: the filter if one was named, else the only one present. */
    currency: currency || currencies[0] || null,
    income,
    expense,
    /* §18, stated outright: Income − Expense = Net Balance. Never clamped — a deficit is real. */
    net_balance: money.subtract(income.total, expense.total),
  };
}

/* ── the two ledgers, exposed as named operations so the controller reads plainly ── */

const forLedger = (ledger) => ({
  list: (req, query, pagination) => listEntries(req, ledger, query, pagination),
  findById: (req, id, namedSchoolId) => findEntry(req, ledger, id, namedSchoolId),
  create: (req, payload) => createEntry(req, ledger, payload),
  update: (req, id, payload) => updateEntry(req, ledger, id, payload),
});

module.exports = {
  expenses: forLedger(LEDGERS.expense),
  incomes: forLedger(LEDGERS.income),
  report,
  foldBuckets,
  sumByCategory,
  LEDGERS,
  EXPENSE_CATEGORY_LIST,
  INCOME_CATEGORY_LIST,
};
