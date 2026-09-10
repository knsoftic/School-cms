'use strict';

/**
 * Student schemas — SRS §15.1, FR-STUDENT-001 / FR-STUDENT-002.
 *
 * §15.1 names: Admission, Student Profile, Student Photo, Documents, Class Assignment, Section
 * Assignment, Student ID, Roll Number, Promotion, Transfer, Leaving. Every one of those is a column
 * on `students` — the field set below is the §29 table minus the columns a body may never carry.
 *
 * **`status` is system-owned and refused on both create and patch.** It is written only by the three
 * FR-STUDENT-002 routes (`/promote`, `/transfer`, `/leave`), which is the same rule
 * `sessions.validation.js` applies to a session's status: the lifecycle columns are the product of
 * the lifecycle operations, not fields a caller may set. It matters more here than it did there,
 * because `student_limit` counts `status = 'active'` — letting a body set `status` would put the
 * §11.2 ceiling behind `students.manage` instead of behind `students.progression`, and would let a
 * caller move a student back into the active count with no limit check at all (§5a defect 21).
 * The same reasoning refuses `promoted_at`, `previous_class_id`, `transferred_at`, `transfer_to`,
 * `left_at` and `leaving_reason`.
 *
 * `admission_date` and `date_of_birth` are `DATEONLY` — normalised in the service through
 * `dates.toDateOnly()`, Known Issues #20.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { GENDERS, STUDENT_STATUS } = require('../../config/constants');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

const fields = {
  school_id: Joi.number().integer().min(1),
  user_id: Joi.number().integer().min(1).allow(null),
  student_id: Joi.string().trim().min(1).max(60),
  roll_number: Joi.string().trim().max(40).empty('').allow(null),
  admission_number: Joi.string().trim().max(60).empty('').allow(null),
  admission_date: Joi.date().iso(),
  admission_session_id: Joi.number().integer().min(1).allow(null),
  first_name: Joi.string().trim().min(1).max(90),
  last_name: Joi.string().trim().max(90).empty('').allow(null),
  gender: Joi.string().valid(...Object.values(GENDERS)),
  date_of_birth: Joi.date().iso().allow(null),
  blood_group: Joi.string().trim().max(10).empty('').allow(null),
  religion: Joi.string().trim().max(60).empty('').allow(null),
  nationality: Joi.string().trim().max(60).empty('').allow(null),
  email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(180).empty('').allow(null),
  phone: Joi.string().trim().max(40).empty('').allow(null),
  address: Joi.string().trim().max(255).empty('').allow(null),
  city: Joi.string().trim().max(90).empty('').allow(null),
  guardian_name: Joi.string().trim().max(160).empty('').allow(null),
  guardian_phone: Joi.string().trim().max(40).empty('').allow(null),
  guardian_relation: Joi.string().trim().max(60).empty('').allow(null),
  emergency_contact: Joi.string().trim().max(40).empty('').allow(null),
  /*
   * Known Issues #26. A stored filesystem path never comes from a request body — it comes from multer
   * via `relativeUploadPath(req.file)`, which is the doctrine `finance`, `fees`, `homework`,
   * `assignments`, `library` and `documents` all enforce. `photo_path` had been a plain 255-char string
   * a caller could set to anything, including a traversal string.
   *
   * SRS §15.1 names "Student Photo" and FR-STUDENT-001 says the system *captures* it, so refusing it
   * here is only half the fix: `POST /students/:id/photo` is the other half, and is what writes it.
   */
  photo_path: Joi.any()
    .forbidden()
    .messages({
      'any.unknown':
        '"photo_path" is written from an uploaded file — POST /students/:id/photo, never a request body',
    }),
  class_id: Joi.number().integer().min(1).allow(null),
  section_id: Joi.number().integer().min(1).allow(null),
  academic_session_id: Joi.number().integer().min(1).allow(null),
  uses_transport: Joi.boolean(),
  notes: Joi.string().trim().max(2000).empty('').allow(null),
  metadata: Joi.object().unknown(true).allow(null),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

/** Written by `/promote`, `/transfer` and `/leave` only — never by a body. */
const lifecycleOwned = {
  status: forbiddenField('"status" is set by promote / transfer / leave, not by this request'),
  promoted_at: forbiddenField('"promoted_at" is stamped on promotion'),
  previous_class_id: forbiddenField('"previous_class_id" is recorded by promotion'),
  transferred_at: forbiddenField('"transferred_at" is stamped on transfer'),
  transfer_to: forbiddenField('"transfer_to" is recorded by transfer'),
  left_at: forbiddenField('"left_at" is stamped on leaving'),
  leaving_reason: forbiddenField('"leaving_reason" is recorded by leaving'),
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
};

const profile = {
  user_id: fields.user_id,
  roll_number: fields.roll_number,
  admission_number: fields.admission_number,
  admission_session_id: fields.admission_session_id,
  last_name: fields.last_name,
  gender: fields.gender,
  date_of_birth: fields.date_of_birth,
  blood_group: fields.blood_group,
  religion: fields.religion,
  nationality: fields.nationality,
  email: fields.email,
  phone: fields.phone,
  address: fields.address,
  city: fields.city,
  guardian_name: fields.guardian_name,
  guardian_phone: fields.guardian_phone,
  guardian_relation: fields.guardian_relation,
  emergency_contact: fields.emergency_contact,
  photo_path: fields.photo_path,
  uses_transport: fields.uses_transport,
  notes: fields.notes,
  metadata: fields.metadata,
  reason: fields.reason,
};

/**
 * `student_id` is optional on admission even though the column is NOT NULL.
 *
 * FR-STUDENT-001 says "System assigns a Student ID and Roll Number", so leaving it out has to work —
 * the service allocates one. It is still *accepted*, because the SRS names no format and a school
 * that already has a numbering scheme must be able to keep it. The same applies to `roll_number`.
 *
 * **`class_id` is required** — the owner's decision D4 in `docs/OWNER-DECISIONS.md`, settling triage
 * finding 17. The SRS answered twice: FR-STUDENT-001 says "Student is assigned to a Class and Section"
 * with "Class and section exist" as its precondition, while §15.1 lists Admission and Class Assignment
 * as separate features. Optional, it admitted a student with no class and therefore **no roll number**
 * — the allocator is scoped by class — and nothing ever gave them one. Required, the roll-number half
 * of "assigns a Student ID and Roll Number" holds for every admission. `section_id` stays optional:
 * the allocator already numbers a section-less class, and nothing in the source makes a section
 * mandatory.
 */
const create = Joi.object({
  school_id: fields.school_id,
  student_id: fields.student_id,
  first_name: fields.first_name.required(),
  admission_date: fields.admission_date.required(),
  class_id: fields.class_id.required(),
  section_id: fields.section_id,
  academic_session_id: fields.academic_session_id,
  ...profile,
  ...lifecycleOwned,
});

const update = Joi.object({
  school_id: fields.school_id,
  student_id: fields.student_id,
  first_name: fields.first_name,
  admission_date: fields.admission_date,
  class_id: fields.class_id,
  section_id: fields.section_id,
  academic_session_id: fields.academic_session_id,
  ...profile,
  ...lifecycleOwned,
}).min(1);

/** FR-STUDENT-002 — promotion. The destination class is the operation; everything else follows it. */
const promote = Joi.object({
  school_id: fields.school_id,
  class_id: Joi.number().integer().min(1).required(),
  section_id: fields.section_id,
  academic_session_id: fields.academic_session_id,
  roll_number: fields.roll_number,
  reason: fields.reason,
});

/** FR-STUDENT-002 — transfer out. `transfer_to` is free text: §29 models it as a string, not an FK. */
const transfer = Joi.object({
  school_id: fields.school_id,
  transfer_to: Joi.string().trim().max(180).empty('').allow(null),
  reason: fields.reason,
});

/** FR-STUDENT-002 — leaving. */
const leave = Joi.object({
  school_id: fields.school_id,
  leaving_reason: Joi.string().trim().max(255).empty('').allow(null),
  reason: fields.reason,
});

const list = listQuery(
  Joi.object({
    school_id: fields.school_id,
    status: Joi.string().valid(...Object.values(STUDENT_STATUS)),
    class_id: fields.class_id,
    section_id: fields.section_id,
    academic_session_id: fields.academic_session_id,
    uses_transport: Joi.boolean(),
    q: Joi.string().trim().max(120),
  })
);

const showQuery = Joi.object({
  school_id: fields.school_id,
});

/**
 * The body of `POST /students/:id/photo` — FR-STUDENT-001's capture step.
 *
 * The photo itself is a file, not a body field, so the only things a caller may send here are the
 * school the record is in and a reason for the audit trail. `photo_path` is refused explicitly rather
 * than left to `stripUnknown`, so a caller who tries to name a path is told no instead of being
 * answered 200 having changed nothing.
 *
 * These arrive as multipart TEXT parts, which is why `validate` runs after `uploadSingle` — Joi's
 * `convert: true` then coerces `school_id` from the string multer produced.
 */
const setPhoto = Joi.object({
  school_id: fields.school_id,
  reason: fields.reason,
  photo_path: fields.photo_path,
});

/**
 * The body of `POST /students/:id/documents` — FR-STUDENT-001's "Documents", the owner's decision D13.
 *
 * The files arrive as the multipart field `documents`; these are the text fields beside them. `title`
 * is optional because every file already has a name: with one file it replaces that name, with several
 * it is put in front of each. Nothing here chooses a `document_type` — §20.5's seven are generated
 * artefacts, and an upload's type is null by the column's own design.
 */
const addDocuments = Joi.object({
  school_id: fields.school_id,
  title: Joi.string().trim().max(200).empty('').allow(null),
  description: Joi.string().trim().max(255).empty('').allow(null),
  reason: fields.reason,
});

const documentParam = Joi.object({
  id: Joi.number().integer().min(1).required(),
  documentId: Joi.number().integer().min(1).required(),
});

module.exports = {
  schemas: {
    create,
    update,
    setPhoto,
    addDocuments,
    documentParam,
    promote,
    transfer,
    leave,
    list,
    showQuery,
    idParam: commonSchemas.idParam,
  },
  fields,
};
