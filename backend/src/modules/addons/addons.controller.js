'use strict';

/**
 * Add-on controllers — SRS §11.3, FR-SUB-009. Thin: every rule is in `addons.service.js`, and every
 * accepted field in `addons.validation.js`.
 */

const service = require('./addons.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

/**
 * An add-on plus its derived readiness block.
 *
 * `toJSON()` is called explicitly for the reason `plans.controller.present()` gives: `readiness` has to
 * sit beside the add-on's own columns, and a Sequelize instance does not accept added properties.
 *
 * @param {object} addon  an add-on loaded with `detailInclude()`
 * @returns {object}
 */
function present(addon) {
  return { ...addon.toJSON(), readiness: service.readiness(addon) };
}

/** GET / — one page of add-ons, scoped to the caller. */
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
  const addon = await service.findById(req.tenant, req.params.id);
  return ApiResponse.ok(res, { addon: present(addon) });
}

/** PATCH /:id — FR-SUB-009. */
async function update(req, res) {
  const addon = await service.update(req, req.params.id, req.body);

  describeActivity(req, {
    entityId: addon.id,
    description: `Updated add-on ${addon.name} (${addon.key})`,
    metadata: { key: addon.key, fields: Object.keys(req.body) },
  });

  return ApiResponse.ok(res, { addon: present(addon) }, { message: 'Add-on updated' });
}

/**
 * One handler for both availability transitions — FR-SUB-009.
 *
 * Curried on the same reasoning as `plans.controller.transitionTo()`: with one handler the activity row,
 * the message and the metadata cannot drift apart between the two endpoints.
 *
 * @param {boolean} isActive
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<any>}
 */
function transitionTo(isActive) {
  return async function transition(req, res) {
    const reason = req.body && req.body.reason;
    const { addon, previous, verb } = await service.setActive(
      req,
      req.params.id,
      isActive,
      reason
    );

    describeActivity(req, {
      entityId: addon.id,
      description: `${verb} add-on ${addon.name} (${addon.key})`,
      metadata: {
        key: addon.key,
        from: previous,
        to: Boolean(addon.is_active),
        ...(reason ? { reason } : {}),
      },
    });

    return ApiResponse.ok(
      res,
      { addon: present(addon) },
      {
        /* A deactivation is not a withdrawal from the schools that already own it, and the operator has
         * to be told so at the moment they do it — the service header explains why. */
        message: isActive
          ? 'Add-on activated'
          : 'Add-on deactivated. Schools that already purchased it keep what it granted.',
      }
    );
  };
}

/**
 * PUT /:id/prices — FR-SUB-009.
 *
 * `retired` is surfaced in the message as well as the body, as on `PUT /plans/:id/prices`: a price row a
 * purchase still points at is deactivated instead of deleted, and an operator who submitted two prices
 * and got back three rows needs to be told why without reading the API docs.
 */
async function setPrices(req, res) {
  const { addon, created: createdCount, deleted, retired } = await service.setPrices(
    req,
    req.params.id,
    req.body.prices
  );

  describeActivity(req, {
    entityId: addon.id,
    description: `Configured pricing for add-on ${addon.name} (${addon.key}): ${createdCount} price(s)`,
    metadata: { key: addon.key, created: createdCount, deleted, retired },
  });

  return ApiResponse.ok(
    res,
    { addon: present(addon), created: createdCount, deleted, retired },
    {
      message: retired
        ? `Add-on pricing updated. ${retired} price(s) referenced by an existing purchase were deactivated rather than removed.`
        : 'Add-on pricing updated',
    }
  );
}

module.exports = {
  list,
  show,
  update,
  activate: transitionTo(true),
  deactivate: transitionTo(false),
  setPrices,
  present,
  transitionTo,
};
