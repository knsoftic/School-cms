'use strict';

/**
 * Report schemas — SRS §22, FR-REPORT-001 and FR-REPORT-002.
 *
 * §22 names seven reports and three export formats and says nothing else about any of them. So these
 * schemas describe the window and the grouping each report's own data supports, and nothing more.
 *
 * ## Each report gets the window its data actually has
 *
 * There is no single report query, because the seven do not share one. The Attendance Report takes
 * §16's own `period`/`date` taxonomy, because it delegates to the computation that already ships and
 * that computation defines the period. The Fee and Expense Reports take a `from`/`to` window and a
 * `currency`, because money rows carry their own currency and adding two together produces a number
 * that means nothing — §18 already refuses that and this module inherits the refusal rather than
 * inventing a second answer.
 *
 * ## `format` and the fourth value §22 does not name
 *
 * `REPORT_FORMATS` has existed in `constants.js` with **no consumers** and carries four values —
 * `json`, `pdf`, `excel`, `print` — while §22 names only the last three. `json` is read here as the
 * *un-exported* form: the report itself, which is what the endpoint returns when nothing is exported.
 * That keeps the frozen constant honest without pretending §22 named a fourth format.
 *
 * Of the three §22 does name, only `excel` is accepted today. See the service header for why, stated
 * as a deferral rather than a silence.
 */

const Joi = require('joi');

const { listQuery } = require('../../middlewares/validate');
const attendanceSchemas = require('../attendance/attendance.validation').schemas;
const financeSchemas = require('../finance/finance.validation').schemas;
const { REPORT_FORMATS, STUDENT_STATUS } = require('../../config/constants');

/** The formats this module can actually produce. See the service header for the rest of §22's three. */
const SUPPORTED_FORMATS = Object.freeze([
  REPORT_FORMATS.JSON,
  REPORT_FORMATS.EXCEL,
  REPORT_FORMATS.PDF,
]);

const shared = {
  school_id: Joi.number().integer().min(1),
  /*
   * Defaults to `json` — the report itself. Anything else is an export and additionally requires
   * `reports.export`, which the router enforces rather than the schema, because a permission is not a
   * shape.
   */
  format: Joi.string().valid(...SUPPORTED_FORMATS).default(REPORT_FORMATS.JSON),
};

/** A closed date window. Ordered, so a transposed one is refused rather than answered with nothing. */
const window = {
  from: Joi.date().iso(),
  to: Joi.date().iso().when('from', { is: Joi.exist(), then: Joi.date().iso().min(Joi.ref('from')) }),
};

/* ── 1. Student Report ── */

const students = Joi.object({
  ...shared,
  ...window,
  class_id: Joi.number().integer().min(1),
  section_id: Joi.number().integer().min(1),
  academic_session_id: Joi.number().integer().min(1),
  status: Joi.string().valid(...Object.values(STUDENT_STATUS)),
});

/**
 * 2. Attendance Report — **§16's own schema**, extended with `format`.
 *
 * Not a copy of it. The service delegates to `attendanceService.report()`, so accepting anything §16's
 * schema would reject, or rejecting anything it would accept, is a way for the two endpoints to drift
 * apart in what they answer for the same question. Reusing the object makes that impossible: there is
 * one definition of an attendance report query and both routes validate against it.
 */
const attendance = attendanceSchemas.report.keys({ format: shared.format });

/* ── 3. Fee Report ── */

const fees = Joi.object({
  ...shared,
  ...window,
  class_id: Joi.number().integer().min(1),
  academic_session_id: Joi.number().integer().min(1),
  /* Money rows carry their own currency and there is no conversion table; see the service header. */
  currency: Joi.string().trim().uppercase().max(10),
});

/**
 * 4. Expense Report — **§18's own schema**, extended with `format`, for the same reason as §16's.
 *
 * §18's report refuses a window holding more than one currency, because adding two currencies produces
 * a number that means nothing and there is no conversion table anywhere in the schema. Reusing its
 * schema means this route inherits that refusal rather than inventing a second answer to it.
 */
const expenses = financeSchemas.report.keys({ format: shared.format });

/* ── 5. Exam Report ── */

const exams = Joi.object({
  ...shared,
  exam_id: Joi.number().integer().min(1),
  class_id: Joi.number().integer().min(1),
  section_id: Joi.number().integer().min(1),
  academic_session_id: Joi.number().integer().min(1),
});

/* ── 6. Teacher Report ── */

const teachers = Joi.object({
  ...shared,
  ...window,
  is_active: Joi.boolean(),
});

/* ── 7. Subscription Report — platform- and organization-scoped ── */

const subscriptions = Joi.object({
  ...shared,
  ...window,
  organization_id: Joi.number().integer().min(1),
  state: Joi.string().trim().max(40),
});

module.exports = {
  schemas: { students, attendance, fees, expenses, exams, teachers, subscriptions },
  SUPPORTED_FORMATS,
  listQuery,
};
