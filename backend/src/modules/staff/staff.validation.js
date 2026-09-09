'use strict';

/**
 * Staff schemas — SRS §15.4, FR-STAFF-001.
 *
 * §15.4 names four categories and nothing else: Receptionist, Accountant, Librarian, Other Staff.
 * They already exist as the `staff.category` enum and as `STAFF_CATEGORIES` in `config/constants.js`,
 * so the valid list comes from there rather than being restated — a fifth category invented here
 * would be a §35 violation and a value the column would reject anyway.
 *
 * FR-STAFF-001 says only "creates/manages staff records", which is why this module is the smallest of
 * the four §15 modules: no dashboard (§15.4 names none, unlike §15.3 and §15.2), no assignments, no
 * lifecycle operations. A member of staff who leaves is deactivated through `PATCH`.
 *
 * Every string width is taken from the model rather than chosen — the mistake §5a defect 24 records,
 * which cost two wrong widths in `teachers/` and two more in `students/`.
 *
 * `date_of_birth` and `joining_date` are `DATEONLY`, normalised in the service through
 * `dates.toDateOnly()` (Known Issues #20).
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { GENDERS, STAFF_CATEGORIES } = require('../../config/constants');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

const fields = {
  school_id: Joi.number().integer().min(1),
  user_id: Joi.number().integer().min(1).allow(null),
  employee_id: Joi.string().trim().min(1).max(60),
  category: Joi.string().valid(...Object.values(STAFF_CATEGORIES)),
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
   * Unlike `students.photo_path`, this column gets **no writer**: SRS §15.4 names no photo and no image
   * for a staff member, so an upload route here would be inventing a requirement rather than implementing one.
   * The column therefore stays permanently null, which is why this module needs no `present()` — there
   * is no stored path to suppress. A later session that gives it a writer must add one in the same
   * change.
   */
  photo_path: Joi.any()
    .forbidden()
    .messages({
      'any.unknown':
        '"photo_path" is not a request-body field; SRS §15.4 names no photo for a staff member',
    }),
  qualification: Joi.string().trim().max(255).empty('').allow(null),
  designation: Joi.string().trim().max(120).empty('').allow(null),
  joining_date: Joi.date().iso(),
  salary: Joi.number().min(0).max(999999999999.99).allow(null),
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
  designation: fields.designation,
  salary: fields.salary,
  notes: fields.notes,
  metadata: fields.metadata,
  reason: fields.reason,
};

/** `category` is required because the column is NOT NULL and §15.4 makes it the defining field. */
const create = Joi.object({
  school_id: fields.school_id,
  employee_id: fields.employee_id.required(),
  category: fields.category.required(),
  first_name: fields.first_name.required(),
  joining_date: fields.joining_date.required(),
  is_active: fields.is_active,
  ...profile,
  ...owned,
});

/**
 * `is_active` and `left_at` are editable here rather than through a dedicated route, on the same
 * reasoning `teachers/` records: §15.4 names no staff deletion and no leaving operation, but it does
 * name "manages staff records", and both columns are part of that. It also keeps the headcount
 * honest — `staff_limit` counts `is_active: true`, so the deactivation is what frees an allowance.
 */
const update = Joi.object({
  school_id: fields.school_id,
  employee_id: fields.employee_id,
  category: fields.category,
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
    category: fields.category,
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
