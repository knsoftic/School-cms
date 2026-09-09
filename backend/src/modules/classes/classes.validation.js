'use strict';

/**
 * Class and section schemas — SRS §14.3, FR-SCHOOL-003.
 *
 * Classes belong to an academic session (the unique key is school + session + name), so a new
 * session can restructure them. `class_teacher_id` is a `teachers.id` on both `classes` and
 * `sections`; there is no teachers API in this phase, so the service `findOne`s that row rather
 * than inventing an endpoint. Nested section routes live under `/:id/sections` so a section is
 * always named in the context of its class.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

const fields = {
  school_id: Joi.number().integer().min(1),
  academic_session_id: Joi.number().integer().min(1),
  name: Joi.string().trim().min(1).max(90),
  code: Joi.string().trim().max(40).empty('').allow(null),
  numeric_order: Joi.number().integer().min(0),
  class_teacher_id: Joi.number().integer().min(1).allow(null),
  capacity: Joi.number().integer().min(0).allow(null),
  is_active: Joi.boolean(),
  description: Joi.string().trim().max(255).empty('').allow(null),
  section_name: Joi.string().trim().min(1).max(60),
  room: Joi.string().trim().max(60).empty('').allow(null),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const owned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
};

const create = Joi.object({
  school_id: fields.school_id,
  academic_session_id: fields.academic_session_id.required(),
  name: fields.name.required(),
  code: fields.code,
  numeric_order: fields.numeric_order,
  class_teacher_id: fields.class_teacher_id,
  capacity: fields.capacity,
  is_active: fields.is_active,
  description: fields.description,
  reason: fields.reason,
  ...owned,
});

const update = Joi.object({
  school_id: fields.school_id,
  academic_session_id: fields.academic_session_id,
  name: fields.name,
  code: fields.code,
  numeric_order: fields.numeric_order,
  class_teacher_id: fields.class_teacher_id,
  capacity: fields.capacity,
  is_active: fields.is_active,
  description: fields.description,
  reason: fields.reason,
  ...owned,
}).min(1);

const createSection = Joi.object({
  school_id: fields.school_id,
  name: fields.section_name.required(),
  class_teacher_id: fields.class_teacher_id,
  capacity: fields.capacity,
  room: fields.room,
  is_active: fields.is_active,
  reason: fields.reason,
  ...owned,
  class_id: forbiddenField('"class_id" is the path parameter'),
});

const updateSection = Joi.object({
  school_id: fields.school_id,
  name: fields.section_name,
  class_teacher_id: fields.class_teacher_id,
  capacity: fields.capacity,
  room: fields.room,
  is_active: fields.is_active,
  reason: fields.reason,
  ...owned,
  class_id: forbiddenField('"class_id" is the path parameter'),
}).min(1);

const list = listQuery(
  Joi.object({
    school_id: fields.school_id,
    academic_session_id: fields.academic_session_id,
    is_active: Joi.boolean(),
  })
);

const showQuery = Joi.object({
  school_id: fields.school_id,
});

const sectionParams = Joi.object({
  id: commonSchemas.id.required(),
  sectionId: commonSchemas.id.required(),
});

module.exports = {
  schemas: {
    create,
    update,
    createSection,
    updateSection,
    list,
    showQuery,
    idParam: commonSchemas.idParam,
    sectionParams,
  },
  fields,
};
