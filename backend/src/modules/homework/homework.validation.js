'use strict';

/**
 * Homework schemas — SRS §20.2, FR-HW-001.
 *
 * §20.2 names three things a teacher can do: Create Homework, Upload File, Set Due Date. All three are
 * one request here — the file arrives as multipart on the create, the way the one existing upload route
 * in the application (`payments.record`) does it.
 *
 * `assigned_date` and `due_date` are `DATEONLY`, normalised in the service through `dates.toDateOnly()`
 * (Known Issues #20). Every string is bounded at its column width, read off `models/other.js`.
 *
 * ## The two columns a caller may not write
 *
 * `attachment_path` and `attachment_name` are set from `req.file` by the upload middleware, never from
 * the body. This is the doctrine `finance` and `fees` already enforce for `attachment_path` and
 * `result_card_path`, and it is refused rather than stripped so a caller cannot mistake silence for
 * success. It also matters more here than anywhere yet: Known Issues #26 records five columns elsewhere
 * that *do* take a caller-supplied path, and §20 is the section that will finally need a route that
 * reads a path back off disk.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

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
  due_date: Joi.date().iso(),
  is_published: Joi.boolean(),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const owned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
  created_by: forbiddenField('"created_by" is taken from the authenticated user'),
  notified_at: forbiddenField('"notified_at" is stamped by the §23 notification job'),
  attachment_path: forbiddenField(
    '"attachment_path" is written from the uploaded file, never from a request body'
  ),
  attachment_name: forbiddenField(
    '"attachment_name" is taken from the uploaded file, never from a request body'
  ),
};

/**
 * FR-HW-001 — create.
 *
 * `class_id` is required because the column is NOT NULL and because §20.2's outcome is that the
 * homework is "available to the relevant class". `due_date` is required because §20.2 names setting one
 * as one of the three things a teacher does; the model's own `dueNotBeforeAssigned` validator then
 * refuses a due date before the assigned date, and the service surfaces that as a 422.
 *
 * Every field arrives as a multipart text part, so `convert: true` is doing real work here — a
 * multipart body is all strings.
 */
const create = Joi.object({
  school_id: fields.school_id,
  class_id: fields.class_id.required(),
  title: fields.title.required(),
  due_date: fields.due_date.required(),
  section_id: fields.section_id,
  subject_id: fields.subject_id,
  teacher_id: fields.teacher_id,
  academic_session_id: fields.academic_session_id,
  description: fields.description,
  /* Defaults to today in the service when the caller does not say. */
  assigned_date: fields.assigned_date,
  is_published: fields.is_published,
  reason: fields.reason,
  ...owned,
});

const update = Joi.object({
  school_id: fields.school_id,
  class_id: fields.class_id,
  title: fields.title,
  due_date: fields.due_date,
  section_id: fields.section_id,
  subject_id: fields.subject_id,
  teacher_id: fields.teacher_id,
  academic_session_id: fields.academic_session_id,
  description: fields.description,
  assigned_date: fields.assigned_date,
  is_published: fields.is_published,
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
    is_published: Joi.boolean(),
    due_from: fields.due_date,
    /* Ordered, so a transposed window is refused rather than answered with an empty list. */
    due_to: fields.due_date.when('due_from', {
      is: Joi.exist(),
      then: fields.due_date.min(Joi.ref('due_from')),
    }),
  })
);

const showQuery = Joi.object({ school_id: fields.school_id });

module.exports = {
  schemas: {
    create,
    update,
    list,
    showQuery,
    idParam: commonSchemas.idParam,
  },
  fields,
};
