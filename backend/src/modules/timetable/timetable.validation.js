'use strict';

/**
 * Timetable schemas — SRS §20.1, FR-TT-001 (creation) and FR-TT-002 (conflict detection).
 *
 * ## Times are normalised, because a `TIME` column does not round-trip
 *
 * Measured against this database: setting `start_time: '09:30'` returns `'09:30'` from the create
 * response and `'09:30:00'` on every later read. The API would state one value and the row hold
 * another — the same response-versus-row divergence that §5a defect 37 was, in a different column
 * type. So a time is normalised to `HH:MM:SS` on the way in and the two agree by construction.
 *
 * The two-digit hour in the pattern is load-bearing twice over. MySQL's `TIME` is a **duration**
 * type with a range of ±838:59:59, so it accepts `24:00` quite happily — verified — and this pattern
 * is the only thing that refuses an out-of-clock time. And the model's own `timeOrdered` validator
 * compares the two values as **strings**, which is only correct while both are zero-padded.
 *
 * `period_number` is what the schema keys its conflict indexes on, so it is required; the clock times
 * are descriptive. See the service header for why that matters.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { WEEKDAYS } = require('../../config/constants');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

/**
 * `HH:MM` or `HH:MM:SS`, with a two-digit hour bounded at 23 — see the header for both reasons.
 */
const timeField = Joi.string()
  .trim()
  .pattern(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/)
  .messages({ 'string.pattern.base': 'must be HH:MM or HH:MM:SS, with a two-digit hour from 00 to 23' });

const fields = {
  school_id: Joi.number().integer().min(1),
  class_id: Joi.number().integer().min(1),
  /*
   * Nullable, and deliberately so — see the service header. A null section means the whole class sits
   * this period, the meaning `exams.section_id` carries for the identical column shape.
   */
  section_id: Joi.number().integer().min(1).allow(null),
  subject_id: Joi.number().integer().min(1).allow(null),
  teacher_id: Joi.number().integer().min(1).allow(null),
  academic_session_id: Joi.number().integer().min(1).allow(null),
  day_of_week: Joi.string().valid(...Object.values(WEEKDAYS)),
  period_number: Joi.number().integer().min(1).max(50),
  period_label: Joi.string().trim().max(60).empty('').allow(null),
  start_time: timeField,
  end_time: timeField,
  room: Joi.string().trim().max(60).empty('').allow(null),
  is_break: Joi.boolean(),
  is_active: Joi.boolean(),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const owned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
  created_by: forbiddenField('"created_by" is taken from the authenticated user'),
};

/**
 * FR-TT-001 — "the user creates timetable entries specifying Period, Room, Subject, and Teacher".
 *
 * `subject_id` is **not** required here, and the omission is the model's rule rather than a relaxation:
 * `teachingSlotNeedsSubject` refuses a row that is not a break and names no subject, so a teaching
 * period must have one and a break must not need one. Requiring it in the schema would make a break
 * impossible to record.
 */
const create = Joi.object({
  school_id: fields.school_id,
  class_id: fields.class_id.required(),
  day_of_week: fields.day_of_week.required(),
  period_number: fields.period_number.required(),
  start_time: fields.start_time.required(),
  end_time: fields.end_time.required(),
  section_id: fields.section_id,
  subject_id: fields.subject_id,
  teacher_id: fields.teacher_id,
  academic_session_id: fields.academic_session_id,
  period_label: fields.period_label,
  room: fields.room,
  is_break: fields.is_break,
  is_active: fields.is_active,
  reason: fields.reason,
  ...owned,
});

const update = Joi.object({
  school_id: fields.school_id,
  class_id: fields.class_id,
  day_of_week: fields.day_of_week,
  period_number: fields.period_number,
  start_time: fields.start_time,
  end_time: fields.end_time,
  section_id: fields.section_id,
  subject_id: fields.subject_id,
  teacher_id: fields.teacher_id,
  academic_session_id: fields.academic_session_id,
  period_label: fields.period_label,
  room: fields.room,
  is_break: fields.is_break,
  is_active: fields.is_active,
  reason: fields.reason,
  ...owned,
}).min(1);

const list = listQuery(
  Joi.object({
    school_id: fields.school_id,
    class_id: fields.class_id,
    section_id: fields.section_id,
    subject_id: fields.subject_id,
    teacher_id: fields.teacher_id,
    academic_session_id: fields.academic_session_id,
    day_of_week: fields.day_of_week,
    period_number: fields.period_number,
    room: Joi.string().trim().max(60),
    is_active: Joi.boolean(),
  })
);

/**
 * The two named views of §20.1 — "Class Timetable" and "Teacher Timetable".
 *
 * A plain `Joi.object`, not `listQuery`: a week is a bounded thing (seven days by a handful of
 * periods) and paginating a grid produces half a timetable, which is worse than none. The attendance
 * report is shaped the same way for the same reason.
 */
const classView = Joi.object({
  school_id: fields.school_id,
  section_id: fields.section_id,
  academic_session_id: fields.academic_session_id,
  day_of_week: fields.day_of_week,
  is_active: Joi.boolean(),
});

const teacherView = Joi.object({
  school_id: fields.school_id,
  academic_session_id: fields.academic_session_id,
  day_of_week: fields.day_of_week,
  is_active: Joi.boolean(),
});

const showQuery = Joi.object({ school_id: fields.school_id });

const classParam = Joi.object({ classId: Joi.number().integer().min(1).required() });
const teacherParam = Joi.object({ teacherId: Joi.number().integer().min(1).required() });

module.exports = {
  schemas: {
    create,
    update,
    list,
    classView,
    teacherView,
    showQuery,
    classParam,
    teacherParam,
    idParam: commonSchemas.idParam,
  },
  timeField,
  fields,
};
