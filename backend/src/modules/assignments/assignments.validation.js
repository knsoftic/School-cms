'use strict';

/**
 * Assignment schemas — SRS §20.3, FR-ASG-001.
 *
 * §20.3 names three steps — Create, Submit, Review — and §29 lists **no submissions table**, so both
 * shapes live in `assignments` and `record_type` tells them apart. The schemas here are per *step*
 * rather than per table, because a caller never chooses a `record_type`: creating gives an
 * `assignment` row, submitting gives a `submission` row, and the service sets the discriminator.
 *
 * `record_type`, `parent_assignment_id` and `student_id` are therefore all `forbidden()` — a caller
 * who could set them could write a submission through the create route and bypass every rule the
 * submit route enforces.
 *
 * `assigned_date` and `due_date` are `DATEONLY`, normalised in the service through `dates.toDateOnly()`
 * (Known Issues #20). `total_marks` and `marks_obtained` are `DECIMAL(7,2)` and use the same
 * `.precision(2)` `markField` as §19's `exams.validation.js`, for the reason `finance` and `plans` both
 * record: under `convert: true` it **rounds to what the column will hold** rather than rejecting, and
 * `validate.js` reassigns the converted body, so the response, the row and every later report are the
 * same figure by construction. Rejecting `10.999` would fail a request over a difference the database
 * is about to erase anyway.
 *
 * ## The file belongs to the submission, not to the assignment
 *
 * FR-ASG-001 names no upload for the teacher's assignment — only §20.2's homework says "Upload File".
 * And the six upload profiles include a `submission` one whose rules table cites *"§20.3 / FR-ASG-001 —
 * student “Submit” (format not specified)"* by name, with no assignment profile beside it. Both readings agree, so
 * `attachment_path` and `attachment_name` are refused on the assignment routes and written from
 * `req.file` on the submit route.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { ASSIGNMENT_STATUS, SUBMISSION_STATUS } = require('../../config/constants');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

/**
 * `DECIMAL(7,2)` — a mark. The same field §19 uses for the same column type: `.precision(2)` rounds
 * under `convert: true`, so the value that reaches the service is the value the column will store.
 */
const markField = Joi.number().min(0).max(99999.99).precision(2);

const fields = {
  school_id: Joi.number().integer().min(1),
  class_id: Joi.number().integer().min(1),
  section_id: Joi.number().integer().min(1).allow(null),
  subject_id: Joi.number().integer().min(1).allow(null),
  teacher_id: Joi.number().integer().min(1).allow(null),
  academic_session_id: Joi.number().integer().min(1).allow(null),
  title: Joi.string().trim().min(1).max(180),
  description: Joi.string().trim().max(5000).empty('').allow(null),
  assigned_date: Joi.date().iso(),
  /*
   * Nullable, as the column is (`models/other.js`, `allowNull: true`): an assignment may have no due
   * date, and clearing one on edit has to be sayable. Without `null` the edit form's cleared field
   * was refused as "must be a valid date". Lateness reads a null due date as never late.
   */
  due_date: Joi.date().iso().allow(null),
  total_marks: markField.allow(null),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

/**
 * The columns no caller may write, on any route.
 *
 * The three discriminator columns are the important ones. `record_type` decides which half of the
 * model's `shapeMatchesRecordType` validator applies, and `parent_assignment_id` + `student_id` are
 * what make a row a submission — a body that could set them could mint a submission for another
 * student through the create route, which carries none of the submit route's checks.
 */
const owned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
  created_by: forbiddenField('"created_by" is taken from the authenticated user'),
  record_type: forbiddenField('"record_type" is decided by the route, not by the body'),
  parent_assignment_id: forbiddenField('"parent_assignment_id" is taken from the route being submitted to'),
  student_id: forbiddenField('"student_id" is taken from the submitting student'),
  attachment_path: forbiddenField('"attachment_path" is written from the uploaded file, never from a request body'),
  attachment_name: forbiddenField('"attachment_name" is taken from the uploaded file, never from a request body'),
  submitted_at: forbiddenField('"submitted_at" is stamped when the assignment is submitted'),
  submission_status: forbiddenField('"submission_status" moves through the submit and review routes'),
  is_late: forbiddenField('"is_late" is derived from the due date and the moment of submission'),
  marks_obtained: forbiddenField('"marks_obtained" is recorded by the review route'),
  feedback: forbiddenField('"feedback" is recorded by the review route'),
  reviewed_by: forbiddenField('"reviewed_by" is taken from the reviewing user'),
  reviewed_at: forbiddenField('"reviewed_at" is stamped when the submission is reviewed'),
};

/* ── FR-ASG-001, step one: the teacher creates ── */

const create = Joi.object({
  school_id: fields.school_id,
  /* Both required by the model's own validator for an `assignment` row; required here so the
     refusal is a 422 naming the field rather than a validator message about a shape. */
  class_id: fields.class_id.required(),
  title: fields.title.required(),
  section_id: fields.section_id,
  subject_id: fields.subject_id,
  teacher_id: fields.teacher_id,
  academic_session_id: fields.academic_session_id,
  description: fields.description,
  assigned_date: fields.assigned_date,
  due_date: fields.due_date,
  total_marks: fields.total_marks,
  /* `draft` or `published` on create; `closed` is reached by editing, never by creating. */
  status: Joi.string().valid(ASSIGNMENT_STATUS.DRAFT, ASSIGNMENT_STATUS.PUBLISHED),
  reason: fields.reason,
  ...owned,
});

const update = Joi.object({
  school_id: fields.school_id,
  class_id: fields.class_id,
  title: fields.title,
  section_id: fields.section_id,
  subject_id: fields.subject_id,
  teacher_id: fields.teacher_id,
  academic_session_id: fields.academic_session_id,
  description: fields.description,
  assigned_date: fields.assigned_date,
  due_date: fields.due_date,
  total_marks: fields.total_marks,
  status: Joi.string().valid(...Object.values(ASSIGNMENT_STATUS)),
  reason: fields.reason,
  ...owned,
}).min(1);

/* ── FR-ASG-001, step two: the student submits ── */

const submit = Joi.object({
  school_id: fields.school_id,
  /* §20.3 names no fields for a submission beyond the act; the text is the answer when there is no file. */
  submission_text: Joi.string().trim().max(20000).empty('').allow(null),
  reason: fields.reason,
  /* An assignment's own fields are meaningless on a submission and would be silently ignored. */
  title: forbiddenField('a submission carries no title of its own'),
  class_id: forbiddenField('a submission takes its class from the assignment'),
  due_date: forbiddenField('a submission takes its due date from the assignment'),
  total_marks: forbiddenField('a submission takes its total marks from the assignment'),
  status: forbiddenField('"status" belongs to the assignment; a submission has submission_status'),
  ...owned,
});

/* ── FR-ASG-001, step three: the teacher reviews ── */

/**
 * `marks_obtained` and `feedback` are the two columns the review route exists to write, so they are
 * lifted out of `owned` rather than left to be shadowed by the order of a spread. Spreading `owned`
 * last silently overwrote both with their `forbidden()` versions, which made the review route reject
 * every review — caught by the suite, and worth removing the possibility of rather than fixing by
 * reordering keys, since a later edit could reintroduce it without anyone noticing the mechanism.
 */
const ownedExceptReview = Object.fromEntries(
  Object.entries(owned).filter(([key]) => key !== 'marks_obtained' && key !== 'feedback')
);

const review = Joi.object({
  school_id: fields.school_id,
  /* Bounded against the assignment's own `total_marks` in the service, which the schema cannot see. */
  marks_obtained: markField.allow(null),
  feedback: Joi.string().trim().max(5000).empty('').allow(null),
  /*
   * §20.3's third step is "Review". `SUBMISSION_STATUS` offers `reviewed` and `returned`, and the
   * difference is real — a returned submission is handed back for another attempt. `submitted` is not
   * offered, because reviewing cannot un-review.
   */
  outcome: Joi.string().valid(SUBMISSION_STATUS.REVIEWED, SUBMISSION_STATUS.RETURNED),
  reason: fields.reason,
  ...ownedExceptReview,
}).min(1);

/* ── the two lists ── */

const list = listQuery(
  Joi.object({
    school_id: fields.school_id,
    class_id: fields.class_id,
    section_id: fields.section_id,
    subject_id: fields.subject_id,
    teacher_id: fields.teacher_id,
    academic_session_id: fields.academic_session_id,
    status: Joi.string().valid(...Object.values(ASSIGNMENT_STATUS)),
    due_from: fields.due_date,
    due_to: fields.due_date.when('due_from', {
      is: Joi.exist(),
      then: fields.due_date.min(Joi.ref('due_from')),
    }),
  })
);

const listSubmissions = listQuery(
  Joi.object({
    school_id: fields.school_id,
    assignment_id: Joi.number().integer().min(1),
    student_id: Joi.number().integer().min(1),
    submission_status: Joi.string().valid(...Object.values(SUBMISSION_STATUS)),
    is_late: Joi.boolean(),
  })
);

const showQuery = Joi.object({ school_id: fields.school_id });

module.exports = {
  schemas: {
    create,
    update,
    submit,
    review,
    list,
    listSubmissions,
    showQuery,
    idParam: commonSchemas.idParam,
  },
  fields,
  markField,
};
