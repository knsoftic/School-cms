'use strict';

/**
 * Reports — SRS §22, FR-REPORT-001 (generate) and FR-REPORT-002 (export).
 *
 * §22 is the first section in this project with **no table of its own**. Nothing in §29 is called
 * `reports`, so a report is a read across tables other modules own, and this module writes nothing at
 * all — the first read-only module in the application.
 *
 * ## The rule that shapes everything here: never become a second source of truth
 *
 * Two of §22's seven reports already exist as computations elsewhere, and both are **delegated to**
 * rather than reimplemented:
 *
 * - **Attendance Report** → `attendanceService.report()`. §16 already answers "how many present, absent,
 *   late, excused in this period, and what percentage". That percentage is a judgement §16's own header
 *   records as undefined by the SRS — `(present + late) / marked`, and `null` rather than `0` when
 *   nothing was marked, because a school with no register has an *unknown* rate, not a zero one. A §22
 *   report that recomputed it would give a school two attendance percentages both claiming to be
 *   authoritative.
 * - **Expense Report** → `financeService.report()`. §18 already answers Income − Expense = Net Balance,
 *   and refuses a window holding more than one currency because there is no conversion table anywhere
 *   in the schema. Both properties are inherited rather than re-decided.
 *
 * The delegation goes further than calling the function: both routes validate against the **owning
 * module's own query schema** (see the validation header), so the two endpoints cannot drift apart in
 * what they will answer for the same question.
 *
 * The other five have no existing computation — the exams module ranks individual students but returns
 * no cohort statistic, the fees module's ledger is a paginated list, and nothing anywhere counts
 * students or teachers by status. Those five are built here, and each reads **stored** values wherever
 * §19 has already computed one.
 *
 * ## The Exam Report reads §19's stored numbers and never recomputes them
 *
 * `results.percentage`, `results.grade_name`, `results.outcome` and `results.position` are calculated
 * and persisted when an exam is generated, and `position` is set only for students who sat every
 * counted paper. A report that re-derived a rank at read time would rank a different population and
 * disagree with result cards already published to parents. So this report aggregates the stored columns
 * and computes nothing per-student.
 *
 * ## Money, currency, and why a total can be refused
 *
 * Every amount-bearing table stores its own `currency` and there is no conversion table, so a sum
 * across two currencies is a number that means nothing. §18's report refuses that outright; the Fee
 * Report here does the same rather than quietly picking one. Amounts are summed in SQL and folded with
 * `utils/money.js` integer-minor-unit arithmetic, never by adding floats.
 *
 * ## What FR-REPORT-002 delivers, and what it does not
 *
 * §22 names PDF, Excel and Print. **Excel is built.** `exceljs` has been in `package.json` since it was
 * written and required by nothing; `workbook.xlsx.writeBuffer()` returns a Buffer, so an export needs
 * no file on disk, no seventh upload profile, and none of the file-serving infrastructure the other
 * four deferred requirements are waiting on. It needed one thing this codebase did not have — a
 * non-JSON response — and that is a Content-Type and a Buffer, not a renderer.
 *
 * **PDF now ships too, and it is the same rows.** This entry used to read *"PDF is deferred to Phase
 * 5.4 — `pdfkit` is installed and also unused, but it draws primitives: a report PDF needs a table
 * engine, column widths, headers and pagination written from nothing."* That was accurate, and that
 * engine is now `src/utils/pdf.js`. What makes it cheap here is that `toPdf()` consumes **the same
 * `toRows()` output `toExcel()` does**, so all seven reports gained PDF at once and the two exports
 * cannot disagree about what a report contains — the suite asserts exactly that.
 *
 * **Print is a client concern and is not a server format.** §22 says only *"User prints the report."*
 * There is no view engine anywhere in this application — no `res.render`, no template directory — so
 * `REPORT_FORMATS`'s comment describing print as returning "print-ready payload/HTML" promises a shape
 * nothing here can produce. The JSON report is what a client prints.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const money = require('../../utils/money');
const dates = require('../../utils/dates');
const { resolveSchool, schoolBrand } = require('../../utils/schoolScope');
const { renderTable } = require('../../utils/pdf');
const attendanceService = require('../attendance/attendance.service');
const financeService = require('../finance/finance.service');
const {
  REPORT_TYPES,
  STUDENT_STATUS,
  GENDERS,
  SUBSCRIPTION_STATES,
} = require('../../config/constants');

const { fn, col } = db.Sequelize;

/** A COUNT(*) grouped by one column, returned as a plain `{ value: count }` map with zeros filled. */
async function countBy(model, where, column, vocabulary) {
  const rows = await model.findAll({
    where,
    attributes: [column, [fn('COUNT', col('id')), 'count']],
    group: [column],
    raw: true,
  });
  const out = {};
  if (vocabulary) for (const v of vocabulary) out[v] = 0;
  for (const row of rows) {
    const key = row[column] === null ? 'unspecified' : String(row[column]);
    out[key] = Number(row.count);
  }
  return out;
}

function dateOnly(value) {
  return value === undefined || value === null || value === '' ? value : dates.toDateOnly(value);
}

/** A closed `from`/`to` window on one column, or `{}` when neither bound was named. */
function windowOn(column, query) {
  const from = dateOnly(query.from);
  const to = dateOnly(query.to);
  if (!from && !to) return {};
  return {
    [column]: {
      ...(from ? { [Op.gte]: from } : {}),
      ...(to ? { [Op.lte]: to } : {}),
    },
  };
}

/**
 * The school every school-side report is about.
 *
 * Resolved unconditionally, exactly as `financeService.report()` does and for the same reason it
 * records: without it, `tenantWhere` would hand a platform caller every school's rows added together
 * and label the result as one school's report.
 *
 * Headed with the name the school uses — its `school_settings` display name when it has set one — as
 * the owner's decision D35 has the school's name appear on its documents, and a report export is one.
 * The reports read nothing else off the row.
 */
async function schoolOf(req, query) {
  const school = await resolveSchool(req, query.school_id);
  const brand = await schoolBrand(school.id);
  return { id: school.id, name: brand ? brand.name : school.name };
}

/* ══════════════════════ 1. Student Report ══════════════════════ */

async function students(req, query) {
  const school = await schoolOf(req, query);
  const where = { school_id: school.id };
  if (query.class_id) where.class_id = query.class_id;
  if (query.section_id) where.section_id = query.section_id;
  if (query.academic_session_id) where.academic_session_id = query.academic_session_id;
  if (query.status) where.status = query.status;
  Object.assign(where, windowOn('admission_date', query));

  const [byStatus, byGender, total, classRows] = await Promise.all([
    countBy(db.Student, where, 'status', Object.values(STUDENT_STATUS)),
    countBy(db.Student, where, 'gender', Object.values(GENDERS)),
    db.Student.count({ where }),
    db.Student.findAll({
      where,
      attributes: ['class_id', [fn('COUNT', col('Student.id')), 'count']],
      /*
       * The class's session as well as its name: every year has a Grade 1, so a school with two sessions
       * open had two rows both called "Grade 1", and only the principal, who can read the session list,
       * could tell them apart.
       */
      include: [{
        model: db.Class,
        as: 'class',
        attributes: ['name'],
        include: [{ model: db.AcademicSession, as: 'academicSession', attributes: ['id', 'name'] }],
      }],
      group: ['class_id', 'class.id', 'class.name', 'class->academicSession.id', 'class->academicSession.name'],
      raw: true,
      nest: true,
    }),
  ]);

  return {
    type: REPORT_TYPES.STUDENT,
    school: { id: school.id, name: school.name },
    window: { from: dateOnly(query.from) || null, to: dateOnly(query.to) || null },
    total,
    by_status: byStatus,
    by_gender: byGender,
    by_class: classRows.map((r) => ({
      class_id: r.class_id,
      class_name: r.class ? r.class.name : null,
      academic_session_id: r.class && r.class.academicSession ? r.class.academicSession.id : null,
      session_name: r.class && r.class.academicSession ? r.class.academicSession.name : null,
      count: Number(r.count),
    })),
  };
}

/* ══════════════════════ 2. Attendance Report — delegated ══════════════════════ */

/**
 * §16 owns this computation; this is a pass-through with a §22 envelope around it.
 *
 * The `delegated_to` field is not decoration — it is how a reader of the response learns that the
 * number came from `/attendance/students/report` and not from a second implementation.
 */
async function attendance(req, query) {
  const school = await schoolOf(req, query);
  const report = await attendanceService.report(req, query);
  return {
    type: REPORT_TYPES.ATTENDANCE,
    school: { id: school.id, name: school.name },
    delegated_to: 'attendance.report',
    ...report,
  };
}

/* ══════════════════════ 3. Fee Report ══════════════════════ */

/**
 * Billed, collected and outstanding — from `student_fees`, which is where §17 keeps the assignment.
 *
 * Grouped by currency and refused when the window spans more than one, the way §18 refuses it: there is
 * no conversion table in the schema, so one number across two currencies is meaningless. Naming a
 * currency narrows the window instead of guessing.
 *
 * `fee_payments` is deliberately **not** summed alongside `student_fees.paid_amount`. §17 keeps the
 * running total on the assignment and §18 records that a fee collection never reaches `incomes`; adding
 * the payment rows to the assignment totals would count the same money twice.
 */
async function fees(req, query) {
  const school = await schoolOf(req, query);
  const where = { school_id: school.id };
  if (query.class_id) where.class_id = query.class_id;
  if (query.academic_session_id) where.academic_session_id = query.academic_session_id;
  if (query.currency) where.currency = query.currency;
  Object.assign(where, windowOn('due_date', query));

  const rows = await db.StudentFee.findAll({
    where,
    attributes: [
      'currency',
      [fn('COUNT', col('id')), 'count'],
      [fn('SUM', col('net_amount')), 'billed'],
      [fn('SUM', col('paid_amount')), 'collected'],
    ],
    group: ['currency'],
    raw: true,
  });

  const currencies = rows.map((r) => r.currency).sort();
  if (!query.currency && currencies.length > 1) {
    throw ApiError.validation(
      'This window holds more than one currency, so a single fee total is undefined',
      [{ field: 'currency', message: `Name one of: ${currencies.join(', ')}` }]
    );
  }

  const row = rows[0] || null;
  const billed = row ? money.round(row.billed || 0) : 0;
  const collected = row ? money.round(row.collected || 0) : 0;

  return {
    type: REPORT_TYPES.FEE,
    school: { id: school.id, name: school.name },
    window: { from: dateOnly(query.from) || null, to: dateOnly(query.to) || null },
    currency: row ? row.currency : query.currency || null,
    assignments: row ? Number(row.count) : 0,
    billed,
    collected,
    /* Never clamped: an over-payment shows as a negative outstanding rather than a hidden zero. */
    outstanding: money.subtract(billed, collected),
    by_status: await countBy(db.StudentFee, where, 'status'),
  };
}

/* ══════════════════════ 4. Expense Report — delegated ══════════════════════ */

/** §18 owns this computation, including its multi-currency refusal. See the header. */
async function expenses(req, query) {
  const school = await schoolOf(req, query);
  const report = await financeService.report(req, query);
  return {
    type: REPORT_TYPES.EXPENSE,
    school: { id: school.id, name: school.name },
    delegated_to: 'finance.report',
    ...report,
  };
}

/* ══════════════════════ 5. Exam Report ══════════════════════ */

/**
 * A cohort statistic over §19's **stored** result columns.
 *
 * Nothing here is recomputed. `percentage`, `grade_name` and `outcome` are written when an exam is
 * generated, and `position` only for students who sat every counted paper — so a report that re-derived
 * any of them would describe a different population from the result cards already published.
 */
async function exams(req, query) {
  const school = await schoolOf(req, query);
  const where = { school_id: school.id };
  if (query.exam_id) where.exam_id = query.exam_id;
  if (query.class_id) where.class_id = query.class_id;
  if (query.section_id) where.section_id = query.section_id;
  if (query.academic_session_id) where.academic_session_id = query.academic_session_id;

  const [totals] = await db.Result.findAll({
    where,
    attributes: [
      [fn('COUNT', col('id')), 'count'],
      [fn('AVG', col('percentage')), 'average_percentage'],
      [fn('MAX', col('percentage')), 'highest_percentage'],
      [fn('MIN', col('percentage')), 'lowest_percentage'],
    ],
    raw: true,
  });

  const count = Number(totals.count) || 0;
  const byOutcome = await countBy(db.Result, where, 'outcome', ['pass', 'fail']);
  const passed = byOutcome.pass || 0;

  return {
    type: REPORT_TYPES.EXAM,
    school: { id: school.id, name: school.name },
    results: count,
    by_outcome: byOutcome,
    /*
     * `null` rather than 0 for an empty set — an exam nobody sat has an *unknown* pass rate, not a 0%
     * one, which is §16's own convention for its attendance percentage.
     *
     * Measured, because the two guards below are not equally load-bearing and it is worth saying which
     * is which. `passed / 0` is NaN, and NaN serialises to `null` in JSON and to an empty cell in
     * exceljs — so the `pass_rate` guard is **defensive only**: removing it changes no output anyone
     * can see. The `average_percentage` guard is the real one: SQL `AVG` over zero rows returns NULL
     * and `Number(null)` is **0**, so without it an exam nobody sat would report an average of 0% —
     * a real number where there is no data.
     */
    pass_rate: count === 0 ? null : Math.round((passed / count) * 10000) / 100,
    average_percentage: count === 0 ? null : Math.round(Number(totals.average_percentage) * 100) / 100,
    highest_percentage: count === 0 ? null : Number(totals.highest_percentage),
    lowest_percentage: count === 0 ? null : Number(totals.lowest_percentage),
    by_grade: await countBy(db.Result, where, 'grade_name'),
  };
}

/* ══════════════════════ 6. Teacher Report ══════════════════════ */

/**
 * §15.3 gives a teacher no status enum — only `is_active` and `left_at` — so those are what this
 * groups by. A "teacher status" taxonomy would be an invention.
 */
async function teachers(req, query) {
  const school = await schoolOf(req, query);
  const where = { school_id: school.id };
  if (query.is_active !== undefined) where.is_active = query.is_active;
  Object.assign(where, windowOn('joining_date', query));

  /*
   * The active count respects an `is_active` filter rather than overriding it. `{ ...where,
   * is_active: true }` replaced a `false` filter, so "inactive only" reported every active teacher as
   * active and `inactive` came out negative — 3 inactive and 20 active read Active 20, Inactive −17.
   */
  const activeWhere = where.is_active === undefined ? { ...where, is_active: true } : where;
  const [total, active, byDesignation] = await Promise.all([
    db.Teacher.count({ where }),
    where.is_active === false ? 0 : db.Teacher.count({ where: activeWhere }),
    countBy(db.Teacher, where, 'designation'),
  ]);

  return {
    type: REPORT_TYPES.TEACHER,
    school: { id: school.id, name: school.name },
    window: { from: dateOnly(query.from) || null, to: dateOnly(query.to) || null },
    total,
    active,
    inactive: total - active,
    by_designation: byDesignation,
  };
}

/* ══════════════════════ 7. Subscription Report ══════════════════════ */

/**
 * The one report that is not about a school.
 *
 * It answers to `reports.subscription.view`, which the catalogue declares with **`module: null`** and
 * grants to Super Admin and Organization Admin only — the two scopes that have no single school. So it
 * carries no `requireModule` and no `requireActiveSubscription`: an organization-wide report is
 * structurally unreachable through a module gate, because that gate resolves one school or refuses.
 *
 * The plan is read through `subscriptions.plan_id`, never by querying `subscription_plans` directly:
 * the plan catalogue carries neither `school_id` nor `organization_id`, so `tenantWhere` is unusable on
 * it and a platform-scoped table has no business being tenant-filtered anyway.
 */
async function subscriptions(req, query) {
  const where = {};
  /*
   * A school scope narrows to the school, as `tenantWhere()` does, and it is applied beside the
   * organization rather than instead of it. Only the organization was applied, so a school-scoped
   * caller — reachable the moment a Super Admin grants a school role this key, which nothing prevents —
   * read every school's subscriptions in its organization (§30 Rule 2).
   */
  if (req.tenant && req.tenant.schoolId) where.school_id = req.tenant.schoolId;
  if (req.tenant && req.tenant.organizationId) where.organization_id = req.tenant.organizationId;
  if (query.organization_id) {
    if (where.organization_id && Number(where.organization_id) !== Number(query.organization_id)) {
      throw ApiError.forbidden('That organization is not yours', { code: 'CROSS_TENANT_ACCESS_DENIED' });
    }
    where.organization_id = query.organization_id;
  }
  if (query.state) where.state = query.state;
  Object.assign(where, windowOn('starts_at', query));

  const [total, byState, planRows] = await Promise.all([
    db.Subscription.count({ where }),
    countBy(db.Subscription, where, 'state', Object.values(SUBSCRIPTION_STATES)),
    db.Subscription.findAll({
      where,
      attributes: ['plan_id', [fn('COUNT', col('Subscription.id')), 'count']],
      include: [{ model: db.SubscriptionPlan, as: 'plan', attributes: ['name', 'code'] }],
      group: ['plan_id', 'plan.id', 'plan.name', 'plan.code'],
      raw: true,
      nest: true,
    }),
  ]);

  return {
    type: REPORT_TYPES.SUBSCRIPTION,
    /* The scope the figures were counted in — the school as well when the caller carries one. */
    scope: where.organization_id || where.school_id
      ? {
        ...(where.organization_id ? { organization_id: where.organization_id } : {}),
        ...(where.school_id ? { school_id: where.school_id } : {}),
      }
      : { platform: true },
    window: { from: dateOnly(query.from) || null, to: dateOnly(query.to) || null },
    total,
    by_state: byState,
    by_plan: planRows.map((r) => ({
      plan_id: r.plan_id,
      plan_name: r.plan ? r.plan.name : null,
      plan_code: r.plan ? r.plan.code : null,
      count: Number(r.count),
    })),
  };
}

/** The seven, by their §22 names. `REPORT_TYPES` has existed with no consumers until now. */
const BUILDERS = Object.freeze({
  [REPORT_TYPES.STUDENT]: students,
  [REPORT_TYPES.ATTENDANCE]: attendance,
  [REPORT_TYPES.FEE]: fees,
  [REPORT_TYPES.EXPENSE]: expenses,
  [REPORT_TYPES.EXAM]: exams,
  [REPORT_TYPES.TEACHER]: teachers,
  [REPORT_TYPES.SUBSCRIPTION]: subscriptions,
});

/* ══════════════════════ FR-REPORT-002 — the export ══════════════════════ */

/**
 * A report's tabular form, for Excel and PDF.
 *
 * Every report is a handful of named maps and a few scalars, so the generic shape is one sheet of
 * `{ section, key, value }` rows plus a header block. That is deliberately plain: §22 says nothing
 * about layout, and inventing a house style for seven reports would be inventing a requirement.
 *
 * ## It must recurse — the Expense report is two levels deep
 *
 * `finance.report()` answers `{ income: { total, by_category: { salaries, … } }, expense: { … },
 * net_balance }`. A one-level walk pushed `by_category` itself into a cell, where Excel and PDF
 * rendered `[object Object]` and the category breakdown — the point of the report — was lost. The
 * screen already walked recursively; the exporters share this function, so they must too. Nested
 * keys carry the path (`by_category.salaries`) so a reader can match the workbook to the screen.
 */
function toRows(report) {
  const rows = [];
  const push = (section, key, value) => {
    rows.push({
      section,
      key,
      value: value === null || value === undefined ? '' : value,
    });
  };

  const walk = (section, prefix, value) => {
    if (value === null || value === undefined) {
      push(section, prefix, '');
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry, i) => {
        if (entry && typeof entry === 'object') {
          for (const [k, v] of Object.entries(entry)) {
            walk(prefix, `${i + 1}.${k}`, v);
          }
        } else {
          walk(prefix, String(i + 1), entry);
        }
      });
      return;
    }

    if (typeof value === 'object') {
      /*
       * Dates are objects in JS. A report window sometimes carries a real Date; stringify it once
       * rather than walking its enumerable nothingness into empty rows.
       */
      if (value instanceof Date) {
        push(section, prefix, Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10));
        return;
      }

      for (const [k, v] of Object.entries(value)) {
        /* Top-level keys become sections; anything deeper extends the key path. */
        if (section === 'summary') walk(prefix, k, v);
        else walk(section, `${prefix}.${k}`, v);
      }
      return;
    }

    push(section, prefix, value);
  };

  for (const [key, value] of Object.entries(report)) walk('summary', key, value);
  return rows;
}

/**
 * FR-REPORT-002 — the Excel export.
 *
 * `exceljs` is required **lazily**, so a JSON report never loads a spreadsheet library, and
 * `writeBuffer()` keeps the whole thing in memory: nothing is written to disk, so this module does not
 * become the first writer of stored bytes and needs no upload profile, no storage accounting and no
 * file-serving route.
 */
async function toExcel(report) {
  // eslint-disable-next-line global-require
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'School Management System';

  const sheet = workbook.addWorksheet(String(report.type || 'report').slice(0, 31));
  sheet.columns = [
    { header: 'Section', key: 'section', width: 24 },
    { header: 'Key', key: 'key', width: 32 },
    { header: 'Value', key: 'value', width: 28 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const row of toRows(report)) sheet.addRow(row);

  return workbook.xlsx.writeBuffer();
}

/**
 * The date window a printed page should show, if the report carries one.
 *
 * Attendance and Expense put `from`/`to` at the top level (they reuse §16 / §18 payloads). Student,
 * Fee, Teacher and Subscription put the same facts under `window`. Reading only the top level left
 * most PDF subtitles blank even when the JSON named a window.
 */
function windowSubtitle(report) {
  const from = report.from ?? report.window?.from ?? null;
  const to = report.to ?? report.window?.to ?? null;
  if (from == null && to == null) return null;

  const day = (value) => {
    if (value == null || value === '') return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    }
    const text = String(value);
    return text.length >= 10 ? text.slice(0, 10) : text;
  };

  return `${day(from) || 'start'} to ${day(to) || 'today'}`;
}

/**
 * The same report, as a PDF — SRS §22, FR-REPORT-002; Phase 5.4.
 *
 * Deliberately fed by `toRows()`, the identical flattening `toExcel()` uses. Two exporters walking
 * the report separately is how the same figure comes out differently in two files, so they share the
 * walk and differ only in what they hand it to. Every one of §22's seven reports gained PDF the
 * moment this existed, for the same reason.
 *
 * The subtitle carries the provenance a printed page loses once it leaves the screen: which report,
 * which school if the report names one, and the window it covers.
 *
 * @param {object} report
 * @returns {Promise<Buffer>}
 */
function toPdf(report) {
  const scope = [
    report.school && report.school.name ? report.school.name : null,
    windowSubtitle(report),
  ].filter(Boolean).join('  |  ');

  return renderTable({
    title: `${String(report.type || 'report').replace(/_/g, ' ')} report`,
    subtitle: scope || null,
    columns: [
      { key: 'section', header: 'Section', width: 2 },
      { key: 'key', header: 'Key', width: 3 },
      { key: 'value', header: 'Value', width: 3 },
    ],
    rows: toRows(report),
    footer: 'School Management System',
  });
}

async function build(type, req, query) {
  const builder = BUILDERS[type];
  if (!builder) throw ApiError.notFound('Unknown report', { code: 'REPORT_UNKNOWN' });
  return builder(req, query);
}

module.exports = {
  build,
  students,
  attendance,
  fees,
  expenses,
  exams,
  teachers,
  subscriptions,
  toExcel,
  toPdf,
  toRows,
  countBy,
  BUILDERS,
};
