'use strict';

/**
 * Subject schemas — SRS §14.4, FR-SCHOOL-004.
 *
 * `code` is unique per school. `type` is the model's own enum (`theory|practical|both`), not an
 * invented vocabulary. Nested `/classes` and `/teachers` assignments are the two association
 * tables the schema already has (`class_subjects`, `teacher_subjects`). `section_id` is optional
 * on both — null means the assignment applies to every section of the class — and MySQL unique
 * indexes treat those nulls as distinct, so the service has to look up `section_id IS NULL`
 * before insert rather than relying on the unique name.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

const SUBJECT_TYPES = ['theory', 'practical', 'both'];

const fields = {
  school_id: Joi.number().integer().min(1),
  name: Joi.string().trim().min(1).max(120),
  code: Joi.string().trim().uppercase().min(1).max(40),
  type: Joi.string().valid(...SUBJECT_TYPES),
  is_elective: Joi.boolean(),
  is_active: Joi.boolean(),
  description: Joi.string().trim().max(255).empty('').allow(null),
  class_id: Joi.number().integer().min(1),
  section_id: Joi.number().integer().min(1).allow(null),
  teacher_id: Joi.number().integer().min(1).allow(null),
  full_marks: Joi.number().min(0).max(99999.99).precision(2).allow(null),
  passing_marks: Joi.number().min(0).max(99999.99).precision(2).allow(null),
  weekly_periods: Joi.number().integer().min(0).allow(null),
  is_primary: Joi.boolean(),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const owned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
};

const create = Joi.object({
  school_id: fields.school_id,
  name: fields.name.required(),
  code: fields.code.required(),
  type: fields.type,
  is_elective: fields.is_elective,
  is_active: fields.is_active,
  description: fields.description,
  reason: fields.reason,
  ...owned,
});

const update = Joi.object({
  school_id: fields.school_id,
  name: fields.name,
  code: fields.code,
  type: fields.type,
  is_elective: fields.is_elective,
  is_active: fields.is_active,
  description: fields.description,
  reason: fields.reason,
  ...owned,
}).min(1);

const assignClass = Joi.object({
  school_id: fields.school_id,
  class_id: fields.class_id.required(),
  section_id: fields.section_id,
  teacher_id: fields.teacher_id,
  full_marks: fields.full_marks,
  passing_marks: fields.passing_marks,
  weekly_periods: fields.weekly_periods,
  is_active: fields.is_active,
  reason: fields.reason,
  ...owned,
  subject_id: forbiddenField('"subject_id" is the path parameter'),
});

const assignTeacher = Joi.object({
  school_id: fields.school_id,
  teacher_id: fields.teacher_id.required(),
  class_id: fields.class_id.allow(null),
  section_id: fields.section_id,
  is_primary: fields.is_primary,
  is_active: fields.is_active,
  reason: fields.reason,
  ...owned,
  subject_id: forbiddenField('"subject_id" is the path parameter'),
});

const list = listQuery(
  Joi.object({
    school_id: fields.school_id,
    type: fields.type,
    is_active: Joi.boolean(),
    is_elective: Joi.boolean(),
  })
);

const showQuery = Joi.object({
  school_id: fields.school_id,
});

const assignmentParams = Joi.object({
  id: commonSchemas.id.required(),
  assignmentId: commonSchemas.id.required(),
});

module.exports = {
  schemas: {
    create,
    update,
    assignClass,
    assignTeacher,
    list,
    showQuery,
    idParam: commonSchemas.idParam,
    assignmentParams,
  },
  fields,
  SUBJECT_TYPES,
};
