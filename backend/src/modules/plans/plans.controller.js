'use strict';

/**
 * Plan controllers — SRS §10, §11; FR-SUB-001 … FR-SUB-007. Thin: every rule is in
 * `plans.service.js`, and every accepted field in `plans.validation.js`.
 */

const service = require('./plans.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');
const { PLAN_STATUS, LIMIT_TYPES } = require('../../config/constants');

/**
 * A plan plus its derived readiness block.
 *
 * `toJSON()` is called explicitly rather than left to `res.json()`, because `readiness` has to be a
 * sibling of the plan's own columns and Sequelize instances do not accept added properties.
 *
 * @param {object} plan  a plan loaded with `DETAIL_INCLUDE`
 * @returns {object}
 */
function present(plan) {
  return { ...plan.toJSON(), readiness: service.readiness(plan) };
}

/** GET /catalogue — the vocabulary the §16 Plan Builder chooses from. */
async function catalogue(req, res) {
  return ApiResponse.ok(res, service.catalogue());
}

/** GET / — one page of plans, scoped to the caller. */
async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req.tenant, req.query, pagination, req);

  return ApiResponse.paginated(
    res,
    { count: result.count, rows: result.rows.map(present) },
    pagination
  );
}

/** GET /:id */
async function show(req, res) {
  const plan = await service.findById(req.tenant, req.params.id);
  return ApiResponse.ok(res, { plan: present(plan) });
}

/** POST / — FR-SUB-001. */
async function create(req, res) {
  const plan = await service.create(req, req.body);

  describeActivity(req, {
    entityId: plan.id,
    description: `Created plan ${plan.name} (${plan.code})`,
    metadata: { code: plan.code, status: plan.status, visibility: plan.visibility },
  });

  return ApiResponse.created(
    res,
    { plan: present(plan) },
    { message: 'Plan created. Configure pricing, modules and limits, then activate it.' }
  );
}

/** PATCH /:id — FR-SUB-002. */
async function update(req, res) {
  const plan = await service.update(req, req.params.id, req.body);

  describeActivity(req, {
    entityId: plan.id,
    description: `Updated plan ${plan.name} (${plan.code})`,
    metadata: { fields: Object.keys(req.body) },
  });

  return ApiResponse.ok(res, { plan: present(plan) }, { message: 'Plan updated' });
}

/**
 * One handler for all three status transitions — FR-SUB-004 and FR-SUB-005.
 *
 * Curried on the same reasoning as `schools.controller.transitionTo()`: the activity row, the message
 * and the metadata cannot drift apart between three endpoints if there is only one of each. The route
 * names the target status, which is what the permission it carries is enforced against.
 *
 * @param {string} status  one of `PLAN_STATUS`
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<any>}
 */
function transitionTo(status) {
  return async function transition(req, res) {
    const reason = req.body && req.body.reason;
    const { plan, previousStatus, verb } = await service.setStatus(
      req,
      req.params.id,
      status,
      reason
    );

    describeActivity(req, {
      entityId: plan.id,
      description: `${verb} plan ${plan.name} (${plan.code})`,
      metadata: {
        from: previousStatus,
        to: plan.status,
        ...(reason ? { reason } : {}),
      },
    });

    return ApiResponse.ok(res, { plan: present(plan) }, { message: `Plan ${verb.toLowerCase()}` });
  };
}

/** POST /:id/duplicate — FR-SUB-003. */
async function duplicate(req, res) {
  const { plan, source, copied } = await service.duplicate(req, req.params.id, req.body);

  describeActivity(req, {
    entityId: plan.id,
    description: `Duplicated plan ${source.name} (${source.code}) as ${plan.name} (${plan.code})`,
    metadata: { sourcePlanId: source.id, sourceCode: source.code, copied },
  });

  return ApiResponse.created(
    res,
    { plan: present(plan), copied },
    { message: 'Plan duplicated. The copy is inactive until you activate it.' }
  );
}

/**
 * PUT /:id/prices — FR-SUB-006.
 *
 * `retired` is surfaced in the message as well as the body: a price row still referenced by a
 * subscription or a quotation is deactivated instead of deleted, and an operator who asked for two
 * prices and received three rows needs to be told why without reading the API docs.
 */
async function setPrices(req, res) {
  const { plan, created: createdCount, deleted, retired } = await service.setPrices(
    req,
    req.params.id,
    req.body.prices
  );

  describeActivity(req, {
    entityId: plan.id,
    description: `Configured pricing for plan ${plan.name} (${plan.code}): ${createdCount} price(s)`,
    metadata: { created: createdCount, deleted, retired },
  });

  return ApiResponse.ok(
    res,
    { plan: present(plan), created: createdCount, deleted, retired },
    {
      message: retired
        ? `Plan pricing updated. ${retired} price(s) in use by an existing subscription or quotation were deactivated rather than removed.`
        : 'Plan pricing updated',
    }
  );
}

/** PUT /:id/modules — FR-SUB-007. */
async function setModules(req, res) {
  const plan = await service.setModules(req, req.params.id, req.body.modules);
  const enabled = (plan.modules || []).filter((row) => row.is_enabled).map((row) => row.module_key);

  describeActivity(req, {
    entityId: plan.id,
    description: `Configured modules for plan ${plan.name} (${plan.code}): ${enabled.length} enabled`,
    metadata: { total: (plan.modules || []).length, enabled },
  });

  return ApiResponse.ok(res, { plan: present(plan) }, { message: 'Plan modules updated' });
}

/** PUT /:id/features — FR-SUB-007. */
async function setFeatures(req, res) {
  const plan = await service.setFeatures(req, req.params.id, req.body.features);
  const rows = plan.features || [];

  describeActivity(req, {
    entityId: plan.id,
    description: `Configured features for plan ${plan.name} (${plan.code}): ${rows.length} feature(s)`,
    metadata: {
      total: rows.length,
      enabled: rows.filter((row) => row.is_enabled).map((row) => row.feature_key),
    },
  });

  return ApiResponse.ok(res, { plan: present(plan) }, { message: 'Plan features updated' });
}

/** PUT /:id/limits — FR-SUB-007, SRS §11.2. */
async function setLimits(req, res) {
  const plan = await service.setLimits(req, req.params.id, req.body.limits);

  describeActivity(req, {
    entityId: plan.id,
    description: `Configured limits for plan ${plan.name} (${plan.code})`,
    metadata: {
      limits: (plan.limits || []).reduce(
        (acc, row) => ({
          ...acc,
          [row.limit_key]:
            row.limit_type === LIMIT_TYPES.UNLIMITED ? LIMIT_TYPES.UNLIMITED : row.limit_value,
        }),
        {}
      ),
    },
  });

  return ApiResponse.ok(res, { plan: present(plan) }, { message: 'Plan limits updated' });
}

module.exports = {
  catalogue,
  list,
  show,
  create,
  update,
  activate: transitionTo(PLAN_STATUS.ACTIVE),
  deactivate: transitionTo(PLAN_STATUS.INACTIVE),
  archive: transitionTo(PLAN_STATUS.ARCHIVED),
  duplicate,
  setPrices,
  setModules,
  setFeatures,
  setLimits,
  present,
  transitionTo,
};
