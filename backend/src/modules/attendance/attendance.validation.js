'use strict';

/**
 * Attendance schemas — SRS §16, FR-ATT-001 / FR-ATT-002 / FR-ATT-003.
 *
 * §16 fixes the four statuses — Present, Absent, Leave, Late — and they already exist as
 * `ATTENDANCE_STATUS`, which is what the column's enum is built from. The valid list is taken from
 * the constant rather than restated, and the suite asserts the *schema's* list against the *model's*
 * so the two cannot drift — the assertion `verify-staff.js` had to be rewritten to make meaningful.
 *
 * **Marking is bulk by shape, not by convenience.** FR-ATT-001 is "Teacher records daily student
 * attendance": a teacher marks a section for a date, not one child at a time. So the request carries
 * the date and the placement once and an `entries` array of per-student rows, and the service upserts
 * against `student_attendance_student_date_unique (student_id, attendance_date)` — both columns NOT
 * NULL, so the index really does enforce one row per student per day and re-marking is idempotent
 * rather than duplicating.
 *
 * `attendance_date` is `DATEONLY` on both tables — normalised in the service through
 * `dates.toDateOnly()` (Known Issues #20).
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { ATTENDANCE_STATUS, ATTENDANCE_STATUS_LIST } = require('../../config/constants');

const fields = {
  school_id: Joi.number().integer().min(1),
  academic_session_id: Joi.number().integer().min(1).allow(null),
  class_id: Joi.number().integer().min(1),
  section_id: Joi.number().integer().min(1).allow(null),
  student_id: Joi.number().integer().min(1),
  teacher_id: Joi.number().integer().min(1),
  attendance_date: Joi.date().iso(),
  status: Joi.string().valid(...ATTENDANCE_STATUS_LIST),
  late_minutes: Joi.number().integer().min(0).max(1440).allow(null),
  remarks: Joi.string().trim().max(255).empty('').allow(null),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

/**
 * One student's mark. `late_minutes` is accepted for any status rather than only `late`: the column
 * is nullable and the source says nothing about the pairing, so refusing it would be a rule §16 does
 * not state. The service records what it is given.
 */
const studentEntry = Joi.object({
  student_id: fields.student_id.required(),
  status: fields.status.required(),
  late_minutes: fields.late_minutes,
  remarks: fields.remarks,
});

/** FR-ATT-001. The class is named once; `entries` carries the section's children. */
const markStudents = Joi.object({
  school_id: fields.school_id,
  class_id: fields.class_id.required(),
  section_id: fields.section_id,
  academic_session_id: fields.academic_session_id,
  attendance_date: fields.attendance_date.required(),
  entries: Joi.array().items(studentEntry).min(1).max(500).required(),
  reason: fields.reason,
});

/** FR-ATT-003. Same shape, so one mental model covers both registers. */
const teacherEntry = Joi.object({
  teacher_id: fields.teacher_id.required(),
  status: fields.status.required(),
  check_in_at: Joi.date().iso().allow(null),
  check_out_at: Joi.date().iso().allow(null),
  late_minutes: fields.late_minutes,
  remarks: fields.remarks,
});

const markTeachers = Joi.object({
  school_id: fields.school_id,
  academic_session_id: fields.academic_session_id,
  attendance_date: fields.attendance_date.required(),
  entries: Joi.array().items(teacherEntry).min(1).max(500).required(),
  reason: fields.reason,
});

const listStudents = listQuery(
  Joi.object({
    school_id: fields.school_id,
    class_id: fields.class_id,
    section_id: fields.section_id,
    student_id: fields.student_id,
    academic_session_id: fields.academic_session_id,
    status: fields.status,
    attendance_date: fields.attendance_date,
    from: fields.attendance_date,
    to: fields.attendance_date,
  })
);

const listTeachers = listQuery(
  Joi.object({
    school_id: fields.school_id,
    teacher_id: fields.teacher_id,
    academic_session_id: fields.academic_session_id,
    status: fields.status,
    attendance_date: fields.attendance_date,
    from: fields.attendance_date,
    to: fields.attendance_date,
  })
);

/**
 * FR-ATT-002 — "Daily, Monthly, and Yearly attendance reports" plus a percentage.
 *
 * `period` is exactly those three words and nothing else: a fourth grouping would be a report §16
 * does not name. `date` anchors the period — the day for `daily`, any day in the month for
 * `monthly`, any day in the year for `yearly` — so the caller never has to compute boundaries the
 * server can derive.
 */
const report = Joi.object({
  school_id: fields.school_id,
  period: Joi.string().valid('daily', 'monthly', 'yearly').required(),
  date: fields.attendance_date.required(),
  class_id: fields.class_id,
  section_id: fields.section_id,
  student_id: fields.student_id,
  academic_session_id: fields.academic_session_id,
});

/**
 * `GET /mine` — the report's own period and date, and at most a student to narrow to. No class, section
 * or school: whose records these are is the caller's identity (`services/selfScope`).
 */
const mine = Joi.object({
  period: Joi.string().valid('daily', 'monthly', 'yearly').default('monthly'),
  date: fields.attendance_date.default(() => new Date().toISOString().slice(0, 10)),
  student_id: fields.student_id,
});

module.exports = {
  schemas: {
    mine,
    markStudents,
    markTeachers,
    listStudents,
    listTeachers,
    report,
    idParam: commonSchemas.idParam,
  },
  fields,
  ATTENDANCE_STATUS,
};
