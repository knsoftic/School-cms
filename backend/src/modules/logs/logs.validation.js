'use strict';

/**
 * Query schemas for the two log reads — SRS §26 "Errors and activity are auditable via logs" (SRS:1344).
 *
 * Filters only: the logs are written by `middlewares/activityLog.js` and nothing here writes them.
 */

const Joi = require('joi');
const { listQuery } = require('../../middlewares/validate');
const { ACTIVITY_ACTIONS } = require('../../config/constants');

/*
 * `to` is compared with `from` only when there is a `from`: an unconditional `min(Joi.ref('from'))`
 * cannot resolve an absent reference and errors, so "everything up to a date" was a 422 — the mistake
 * `commonSchemas.dateRange` records and fixes, repeated here until the logs screen's review found it.
 */
const shared = {
  school_id: Joi.number().integer().min(1),
  user_id: Joi.number().integer().min(1),
  from: Joi.date().iso(),
  to: Joi.date().iso().when('from', { is: Joi.exist(), then: Joi.date().iso().min(Joi.ref('from')) }),
};

const activity = listQuery(
  Joi.object({
    ...shared,
    action: Joi.string().valid(...Object.values(ACTIVITY_ACTIONS)),
    entity_type: Joi.string().trim().max(60),
    q: Joi.string().trim().max(100).empty(''),
  })
);

const audit = listQuery(
  Joi.object({
    ...shared,
    table_name: Joi.string().trim().max(60),
    record_id: Joi.number().integer().min(1),
    event: Joi.string().valid('create', 'update', 'delete', 'restore'),
  })
);

module.exports = { schemas: { activity, audit } };
