'use strict';

/**
 * Teacher schemas — SRS §15.3, FR-TEACHER-001 / FR-TEACHER-002.
 *
 * §15.3 names Teacher Profile, Qualification, Joining Date, Subjects, Classes and Teacher Dashboard.
 * Every one of those except the dashboard is a column on `teachers` or a row in `teacher_subjects`,
 * so nothing here is invented — the field set is the §29 table minus the columns a body may never
 * carry.
 *
 * `user_id` is accepted but never fabricated. FR-TEACHER-002's precondition is "Teacher account
 * exists"; it does not say this module creates it, and FR-TEACHER-001 names only profile fields. So
 * a caller may link an existing `users` row (checked against the same school in the service) and
 * may leave it null — inventing an account-creation step here would be a behaviour §15.3 does not
 * list. `parents/` is different: `parents.user_id` is NOT NULL, so FR-PARENT-001's "System creates a
 * Parent Account" is a real instruction there and not here.
 *
 * `date_of_birth` and `joining_date` are `DATEONLY`. They are validated as dates and normalised in
 * the service through `dates.toDateOnly()` — see the header of `teachers.service.js` and Known
 * Issues #20.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { GENDERS } = require('../../config/constants');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

const fields = {
  school_id: Joi.number().integer().min(1),
  user_id: Joi.number().integer().min(1).allow(null),
  employee_id: Joi.string().trim().min(1).max(60),
  first_name: Joi.string().trim().min(1).max(90),
  last_name: Joi.string().trim().max(90).empty('').allow(null),
  gender: Joi.string().valid(...Object.values(GENDERS)),
  date_of_birth: Joi.date().iso().allow(null),
  email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(180).empty('').allow(null),
  phone: Joi.string().trim().max(40).empty('').allow(null),
  address: Joi.string().trim().max(255).empty('').allow(null),
  /*
   * Known Issues #26. A stored filesystem path never comes from a request body — the doctrine
   * `finance`, `fees`, `homework`, `assignments`, `library` and `documents` all enforce.
   *
   * Unlike `students.photo_path`, this column gets **no writer**: SRS §15.3 names no photo and no image
   * for a teacher, so an upload route here would be inventing a requirement rather than implementing one.
   * The column therefore stays permanently null, which is why this module needs no `present()` — there
   * is no stored path to suppress. A later session that gives it a writer must add one in the same
   * change.
   */
  photo_path: Joi.any()
    .forbidden()
    .messages({
      'any.unknown':
        '"photo_path" is not a request-body field; SRS §15.3 names no photo for a teacher',
    }),
  qualification: Joi.string().trim().max(255).empty('').allow(null),
  specialization: Joi.string().trim().max(160).empty('').allow(null),
  experience_years: Joi.number().min(0).max(80).allow(null),
  joining_date: Joi.date().iso(),
  salary: Joi.number().min(0).max(999999999999.99).allow(null),
  designation: Joi.string().trim().max(120).empty('').allow(null),
  is_active: Joi.boolean(),
  left_at: Joi.date().iso().allow(null),
  notes: Joi.string().trim().max(2000).empty('').allow(null),
  metadata: Joi.object().unknown(true).allow(null),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const owned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
};

const profile = {
  user_id: fields.user_id,
  last_name: fields.last_name,
  gender: fields.gender,
  date_of_birth: fields.date_of_birth,
  email: fields.email,
  phone: fields.phone,
  address: fields.address,
  photo_path: fields.photo_path,
  qualification: fields.qualification,
  specialization: fields.specialization,
  experience_years: fields.experience_years,
  salary: fields.salary,
  designation: fields.designation,
  notes: fields.notes,
  metadata: fields.metadata,
  reason: fields.reason,
};

const create = Joi.object({
  school_id: fields.school_id,
  employee_id: fields.employee_id.required(),
  first_name: fields.first_name.required(),
  joining_date: fields.joining_date.required(),
  is_active: fields.is_active,
  ...profile,
  ...owned,
});

/**
 * `is_active` and `left_at` are editable here rather than through a dedicated route.
 *
 * §15.3 names no teacher deletion and no "leaving" operation — FR-STUDENT-002 defines leaving for
 * *students* only, and inventing the mirror for teachers would be a behaviour the source does not
 * list. FR-TEACHER-001 does name editing the profile, and both columns are part of it, so a teacher
 * who leaves is deactivated by an edit. That also keeps the headcount honest: `teacher_limit` counts
 * `is_active: true`, so the deactivation is what frees an allowance.
 */
const update = Joi.object({
  school_id: fields.school_id,
  employee_id: fields.employee_id,
  first_name: fields.first_name,
  joining_date: fields.joining_date,
  is_active: fields.is_active,
  left_at: fields.left_at,
  ...profile,
  ...owned,
}).min(1);

const list = listQuery(
  Joi.object({
    school_id: fields.school_id,
    is_active: Joi.boolean(),
    designation: Joi.string().trim().max(120),
    q: Joi.string().trim().max(120),
  })
);

const showQuery = Joi.object({
  school_id: fields.school_id,
});

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
