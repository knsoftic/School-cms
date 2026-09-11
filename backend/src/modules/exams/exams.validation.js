'use strict';

/**
 * Exam schemas — SRS §19, FR-EXAM-001 through FR-EXAM-005.
 *
 * Every numeric field is bounded at its column's own precision **and scale**, read off
 * `models/exams.js`: marks are `DECIMAL(7,2)`, percentages and weightage `DECIMAL(6,3)`, grade points
 * `DECIMAL(5,2)`. The scale matters as much as the ceiling — §5a defect 37 was a money field that
 * accepted `10.999`, stored `11.00`, and echoed back the number that was never stored.
 *
 * `exam_date`, `start_date` and `end_date` are `DATEONLY`, normalised in the service through
 * `dates.toDateOnly()` (Known Issues #20).
 *
 * ## Two columns that exist and are deliberately refused
 *
 * **`weightage`** (`exam_subjects`, `DECIMAL(6,3)` NOT NULL default 1, commented *"Weight used when
 * aggregating into the exam total"*) is `forbidden()`. §19 describes Total, Percentage, Grade and
 * Pass/Fail and **never mentions weighting**, so applying it would be a formula the source does not
 * define. Refusing it rather than merely omitting it is the point: a stripped key answers 200 having
 * changed nothing, which a caller cannot distinguish from success. Because no route can set it, the
 * column holds its documented default of 1 for every exam this system can create — at which the
 * weighted and unweighted totals are the same number, so nothing is lost and nothing is invented.
 *
 * **`result_card_path`** is refused for the reason `finance` refuses `attachment_path`: a stored path
 * never comes from a request body. Nothing writes it today — see the service header on FR-EXAM-005.
 *
 * ## The practical columns, which are NOT refused
 *
 * `practical_full_marks` / `practical_passing_marks` / `practical_marks_obtained` are accepted and
 * aggregated. The line between them and `weightage` is deliberate: weighting would **change** the
 * arithmetic §19 states, whereas a practical paper is simply *more marks* — §19.1 names "Marks" and
 * "Passing Marks" without saying a subject has only one paper. Excluding them would leave three
 * symmetric columns permanently dead and their marks stored but absent from every output §19 names.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { EXAM_STATUS, MARK_STATUS, REPORT_FORMATS } = require('../../config/constants');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

/** `DECIMAL(7,2)` — a mark. Bounded at the scale so the row and the response cannot disagree. */
const markField = Joi.number().min(0).max(99999.99).precision(2);
/** `DECIMAL(6,3)` — a percentage band. */
const percentField = Joi.number().min(0).max(100).precision(3);
/** `HH:MM` or `HH:MM:SS`, the shape a `TIME` column takes. */
const timeField = Joi.string()
  .trim()
  .pattern(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/)
  .messages({ 'string.pattern.base': 'must be HH:MM or HH:MM:SS' });

const shared = {
  school_id: Joi.number().integer().min(1),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const owned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
  /*
   * Declared, not merely absent. The service header says this column is refused in every schema, and
   * until §5a session 19 that sentence was false - nothing declared it, so it was silently stripped
   * rather than refused, and a caller could not tell the difference from success.
   */
  result_card_path: forbiddenField(
    '"result_card_path" is written by a document generator, never by a request body - see the service header on FR-EXAM-005'
  ),
};

/* ── §19.1 the Grade System ── */

const gradeFields = {
  scale_name: Joi.string().trim().max(90),
  name: Joi.string().trim().min(1).max(20),
  min_percentage: percentField,
  max_percentage: percentField,
  grade_point: Joi.number().min(0).max(999.99).precision(2).allow(null),
  is_failing: Joi.boolean(),
  remarks: Joi.string().trim().max(120).empty('').allow(null),
  is_active: Joi.boolean(),
};

const createGrade = Joi.object({
  school_id: shared.school_id,
  scale_name: gradeFields.scale_name,
  name: gradeFields.name.required(),
  min_percentage: gradeFields.min_percentage.required(),
  max_percentage: gradeFields.max_percentage.required(),
  grade_point: gradeFields.grade_point,
  is_failing: gradeFields.is_failing,
  remarks: gradeFields.remarks,
  is_active: gradeFields.is_active,
  reason: shared.reason,
  /* A school may not mint a platform-owned band; `is_system` marks the rows it cannot delete. */
  is_system: forbiddenField('"is_system" marks a platform-provided scale and is not settable'),
  ...owned,
});

const updateGrade = Joi.object({
  school_id: shared.school_id,
  scale_name: gradeFields.scale_name,
  name: gradeFields.name,
  min_percentage: gradeFields.min_percentage,
  max_percentage: gradeFields.max_percentage,
  grade_point: gradeFields.grade_point,
  is_failing: gradeFields.is_failing,
  remarks: gradeFields.remarks,
  is_active: gradeFields.is_active,
  reason: shared.reason,
  is_system: forbiddenField('"is_system" marks a platform-provided scale and is not settable'),
  ...owned,
}).min(1);

const listGrades = listQuery(
  Joi.object({
    school_id: shared.school_id,
    scale_name: gradeFields.scale_name,
    is_active: Joi.boolean(),
  })
);

/* ── §19.1 the examination ── */

const examFields = {
  name: Joi.string().trim().min(1).max(160),
  exam_type: Joi.string().trim().min(1).max(90),
  class_id: Joi.number().integer().min(1),
  section_id: Joi.number().integer().min(1).allow(null),
  academic_session_id: Joi.number().integer().min(1).allow(null),
  start_date: Joi.date().iso().allow(null),
  end_date: Joi.date().iso().allow(null),
  grade_scale: gradeFields.scale_name,
  description: Joi.string().trim().max(5000).empty('').allow(null),
};

const createExam = Joi.object({
  school_id: shared.school_id,
  name: examFields.name.required(),
  /*
   * `exam_type` is free text at the column, whose comment says "The source names the field but no
   * closed value list". §19.1 lists Exam Type as a field and never enumerates its values, so no enum
   * is invented here — the width is the only constraint the schema states.
   */
  exam_type: examFields.exam_type.required(),
  class_id: examFields.class_id.required(),
  section_id: examFields.section_id,
  academic_session_id: examFields.academic_session_id,
  start_date: examFields.start_date,
  end_date: examFields.end_date,
  grade_scale: examFields.grade_scale,
  description: examFields.description,
  reason: shared.reason,
  /*
   * The lifecycle columns. `status` moves only through its own edges, and the two stamps are written
   * by the edge that earns them — the "every edge has exactly one writer" rule `invoices` states.
   */
  status: forbiddenField('"status" moves through the exam lifecycle routes, not by assignment'),
  published_at: forbiddenField('"published_at" is stamped when results are published'),
  announced_at: forbiddenField('"announced_at" is stamped by the §23 notification job'),
  created_by: forbiddenField('"created_by" is taken from the authenticated user'),
  ...owned,
});

const updateExam = Joi.object({
  school_id: shared.school_id,
  name: examFields.name,
  exam_type: examFields.exam_type,
  class_id: examFields.class_id,
  section_id: examFields.section_id,
  academic_session_id: examFields.academic_session_id,
  start_date: examFields.start_date,
  end_date: examFields.end_date,
  grade_scale: examFields.grade_scale,
  description: examFields.description,
  reason: shared.reason,
  status: forbiddenField('"status" moves through the exam lifecycle routes, not by assignment'),
  published_at: forbiddenField('"published_at" is stamped when results are published'),
  announced_at: forbiddenField('"announced_at" is stamped by the §23 notification job'),
  created_by: forbiddenField('"created_by" is taken from the authenticated user'),
  ...owned,
}).min(1);

const listExams = listQuery(
  Joi.object({
    school_id: shared.school_id,
    class_id: examFields.class_id,
    section_id: examFields.section_id,
    academic_session_id: examFields.academic_session_id,
    exam_type: examFields.exam_type,
    status: Joi.string().valid(...Object.values(EXAM_STATUS)),
  })
);

/* ── §19.1 Subjects, Marks, Passing Marks ── */

const subjectFields = {
  subject_id: Joi.number().integer().min(1),
  teacher_id: Joi.number().integer().min(1).allow(null),
  /* A paper out of zero marks is not a paper, so the floor is exclusive. */
  full_marks: markField.greater(0),
  passing_marks: markField,
  practical_full_marks: markField.greater(0).allow(null),
  practical_passing_marks: markField.allow(null),
  exam_date: Joi.date().iso().allow(null),
  start_time: timeField.allow(null),
  end_time: timeField.allow(null),
  room: Joi.string().trim().max(60).empty('').allow(null),
};

const weightageRefused = forbiddenField(
  '"weightage" is not accepted — SRS §19 describes no weighted aggregation, so every subject counts at face value'
);

const addExamSubject = Joi.object({
  school_id: shared.school_id,
  subject_id: subjectFields.subject_id.required(),
  full_marks: subjectFields.full_marks.required(),
  passing_marks: subjectFields.passing_marks.required(),
  teacher_id: subjectFields.teacher_id,
  practical_full_marks: subjectFields.practical_full_marks,
  practical_passing_marks: subjectFields.practical_passing_marks,
  exam_date: subjectFields.exam_date,
  start_time: subjectFields.start_time,
  end_time: subjectFields.end_time,
  room: subjectFields.room,
  reason: shared.reason,
  weightage: weightageRefused,
  marks_submitted_at: forbiddenField('"marks_submitted_at" is stamped when the subject\'s marks are submitted'),
  ...owned,
});

const updateExamSubject = Joi.object({
  school_id: shared.school_id,
  full_marks: subjectFields.full_marks,
  passing_marks: subjectFields.passing_marks,
  teacher_id: subjectFields.teacher_id,
  practical_full_marks: subjectFields.practical_full_marks,
  practical_passing_marks: subjectFields.practical_passing_marks,
  exam_date: subjectFields.exam_date,
  start_time: subjectFields.start_time,
  end_time: subjectFields.end_time,
  room: subjectFields.room,
  reason: shared.reason,
  /* Moving a paper to a different subject would silently rewrite every mark already entered. */
  subject_id: forbiddenField('"subject_id" cannot be changed — remove the paper and add the other subject'),
  weightage: weightageRefused,
  marks_submitted_at: forbiddenField('"marks_submitted_at" is stamped when the subject\'s marks are submitted'),
  ...owned,
}).min(1);

/* ── §19.2 Marks ── */

const markEntry = Joi.object({
  student_id: Joi.number().integer().min(1).required(),
  marks_obtained: markField.allow(null),
  practical_marks_obtained: markField.allow(null),
  is_absent: Joi.boolean(),
  remarks: Joi.string().trim().max(255).empty('').allow(null),
  /* Derived by the calculation from the paper's passing marks — never stated by the caller. */
  grade_name: forbiddenField('"grade_name" is derived from the marks, not supplied'),
  outcome: forbiddenField('"outcome" is derived from the marks, not supplied'),
  status: forbiddenField('"status" moves from draft to submitted through POST /exams/marks/submit'),
});

/**
 * FR-EXAM-002 — "Teacher enters marks per student."
 *
 * Bulk by shape, like attendance: a teacher marks a whole class's paper in one sitting. The unique
 * index `(exam_subject_id, student_id)` over two NOT NULL columns makes the write an upsert with no
 * NULL-distinct hole, so re-posting **corrects** an entry rather than duplicating it — which is what
 * "Teacher may edit entered marks prior to submission" asks for.
 */
const enterMarks = Joi.object({
  school_id: shared.school_id,
  exam_subject_id: Joi.number().integer().min(1).required(),
  entries: Joi.array().items(markEntry).min(1).max(500).required(),
  reason: shared.reason,
  ...owned,
});

const submitMarks = Joi.object({
  school_id: shared.school_id,
  exam_subject_id: Joi.number().integer().min(1).required(),
  reason: shared.reason,
  ...owned,
});

const listMarks = listQuery(
  Joi.object({
    school_id: shared.school_id,
    exam_id: Joi.number().integer().min(1),
    exam_subject_id: Joi.number().integer().min(1),
    student_id: Joi.number().integer().min(1),
    status: Joi.string().valid(...Object.values(MARK_STATUS)),
  })
);

/* ── §19.3 Results ── */

const generateResults = Joi.object({
  school_id: shared.school_id,
  reason: shared.reason,
  ...owned,
});

const publishResults = Joi.object({
  school_id: shared.school_id,
  reason: shared.reason,
  ...owned,
});

const listResults = listQuery(
  Joi.object({
    school_id: shared.school_id,
    exam_id: Joi.number().integer().min(1),
    student_id: Joi.number().integer().min(1),
    class_id: examFields.class_id,
    section_id: examFields.section_id,
    is_published: Joi.boolean(),
  })
);

const myResults = listQuery(
  Joi.object({
    school_id: shared.school_id,
    exam_id: Joi.number().integer().min(1),
    student_id: Joi.number().integer().min(1),
  })
);

/**
 * The nested paper route declares two parameters, and BOTH have to be named here.
 *
 * `validate()` runs params with `stripUnknown: true`, so a parameter the schema does not declare is
 * silently deleted before the controller reads it — `commonSchemas.idParam` declares only `id`, and
 * using it on `/:id/subjects/:examSubjectId` erased the second half of the address and turned the
 * lookup into a 500.
 */
const examSubjectParam = Joi.object({
  id: Joi.number().integer().min(1).required(),
  examSubjectId: Joi.number().integer().min(1).required(),
});

const showQuery = Joi.object({ school_id: shared.school_id });

/**
 * The result card's own query — FR-EXAM-005.
 *
 * A copy of `showQuery` plus `format`, rather than `format` added to `showQuery` itself, because
 * that schema is shared by every show route in this module and none of the others exports
 * anything.
 *
 * **json and pdf only.** §19.3 names *"PDF support and Print support"* and no third format, which
 * is a real difference from §22 — that section names Excel as well, and this one does not. Adding
 * a spreadsheet here because §22 has one would be inventing a requirement. `print` is refused for
 * the same reason it is in §22: there is no view engine anywhere in this application to produce
 * what it would mean, and answering a print request with JSON would be handing back something
 * else rather than saying no.
 */
const RESULT_FORMATS = Object.freeze([REPORT_FORMATS.JSON, REPORT_FORMATS.PDF]);

const resultQuery = showQuery.keys({
  format: Joi.string().valid(...RESULT_FORMATS).default(REPORT_FORMATS.JSON),
});

/**
 * The class result's query — FR-EXAM-004's "Class Result", which SRS:1030 makes "available for
 * viewing, PDF export, and printing" like the card. `listResults` plus the same two formats, for the
 * reason `resultQuery` gives.
 */
const classResultQuery = listResults.keys({
  format: Joi.string().valid(...RESULT_FORMATS).default(REPORT_FORMATS.JSON),
});

module.exports = {
  schemas: {
    createGrade,
    updateGrade,
    listGrades,
    createExam,
    updateExam,
    listExams,
    addExamSubject,
    updateExamSubject,
    enterMarks,
    submitMarks,
    listMarks,
    generateResults,
    publishResults,
    listResults,
    myResults,
    showQuery,
    RESULT_FORMATS,
    resultQuery,
    classResultQuery,
    examSubjectParam,
    idParam: commonSchemas.idParam,
  },
  markField,
  percentField,
  timeField,
};
