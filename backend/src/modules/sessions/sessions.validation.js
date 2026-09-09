'use strict';

/**
 * Academic session schemas — SRS §14.2, FR-SCHOOL-002.
 *
 * Create / Activate / Close are the three operations the source names. Status, `is_current`,
 * `activated_at` and `closed_at` are therefore refused on create and patch: they are the product of
 * the activate and close routes, not fields a caller may set. Inventing a fourth status or a
 * delete-session route would be a 65th behaviour the SRS does not list — close is the operation.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { ACADEMIC_SESSION_STATUS } = require('../../config/constants');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

const fields = {
  school_id: Joi.number().integer().min(1),
  name: Joi.string().trim().min(1).max(90),
  start_date: Joi.date().iso(),
  end_date: Joi.date().iso(),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const systemOwned = {
  status: forbiddenField('"status" is set by activate / close, not by this request'),
  is_current: forbiddenField('"is_current" is set by activate / close, not by this request'),
  activated_at: forbiddenField('"activated_at" is stamped on activate'),
  closed_at: forbiddenField('"closed_at" is stamped on close'),
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
};

const create = Joi.object({
  school_id: fields.school_id,
  name: fields.name.required(),
  start_date: fields.start_date.required(),
  end_date: fields.end_date.required(),
  reason: fields.reason,
  ...systemOwned,
});

const update = Joi.object({
  school_id: fields.school_id,
  name: fields.name,
  start_date: fields.start_date,
  end_date: fields.end_date,
  reason: fields.reason,
  ...systemOwned,
}).min(1);

const action = Joi.object({
  school_id: fields.school_id,
  reason: fields.reason,
});

const list = listQuery(
  Joi.object({
    school_id: fields.school_id,
    status: Joi.string().valid(...Object.values(ACADEMIC_SESSION_STATUS)),
    is_current: Joi.boolean(),
  })
);

const showQuery = Joi.object({
  school_id: fields.school_id,
});

module.exports = {
  schemas: {
    create,
    update,
    action,
    list,
    showQuery,
    idParam: commonSchemas.idParam,
  },
  fields,
};
