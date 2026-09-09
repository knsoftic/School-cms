'use strict';

/**
 * Tax controllers — SRS §33 *"Taxes"*. Thin: the rules are in `taxes.service.js` and the accepted
 * fields in `taxes.validation.js`.
 */

const service = require('./taxes.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

/** GET / — one page of tax rates. */
async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req.query, pagination, req);

  return ApiResponse.paginated(res, result, pagination);
}

/**
 * GET /:id
 *
 * Carries `references` so the screen can grey out Delete before the operator presses it, rather than
 * offering an action the service will refuse with `TAX_IN_USE`.
 */
async function show(req, res) {
  const tax = await service.findById(req.params.id);
  const references = await service.referenceCounts(tax.id);

  return ApiResponse.ok(res, { tax, references });
}

/** POST / */
async function create(req, res) {
  const tax = await service.create(req, req.body);

  describeActivity(req, {
    entityId: tax.id,
    description: `Created tax ${tax.name} (${tax.code}) at ${tax.rate_percent}%`,
    metadata: {
      code: tax.code,
      rate_percent: tax.rate_percent,
      is_inclusive: Boolean(tax.is_inclusive),
      is_default: Boolean(tax.is_default),
    },
  });

  return ApiResponse.created(res, { tax }, { message: 'Tax created' });
}

/** PATCH /:id */
async function update(req, res) {
  const tax = await service.update(req, req.params.id, req.body);

  describeActivity(req, {
    entityId: tax.id,
    description: `Updated tax ${tax.name} (${tax.code})`,
    metadata: { code: tax.code, fields: Object.keys(req.body) },
  });

  return ApiResponse.ok(res, { tax }, { message: 'Tax updated' });
}

/**
 * POST /:id/default — make this rate the one an invoice uses when none is named.
 *
 * `cleared` is reported because the call changes rows the operator did not name: they need to see
 * that a previous default was demoted.
 */
async function setDefault(req, res) {
  const { tax, cleared } = await service.setDefault(req, req.params.id);

  describeActivity(req, {
    entityId: tax.id,
    description: `Set tax ${tax.name} (${tax.code}) as the default rate`,
    metadata: { code: tax.code, demoted: cleared },
  });

  return ApiResponse.ok(
    res,
    { tax, demoted: cleared },
    {
      message: cleared
        ? `Default tax set to ${tax.code}. The previous default was cleared.`
        : `Default tax set to ${tax.code}`,
    }
  );
}

/** POST /default/clear — leave the platform with no default rate, so untaxed invoices are issued. */
async function clearDefault(req, res) {
  const { cleared } = await service.setDefault(req, null);

  describeActivity(req, {
    description: 'Cleared the default tax rate',
    metadata: { cleared },
  });

  return ApiResponse.ok(
    res,
    { cleared },
    {
      message: cleared
        ? 'Default tax cleared. New invoices carry no tax unless one is named.'
        : 'There was no default tax to clear',
    }
  );
}

/** DELETE /:id — refused when an invoice points at the row; the service says why. */
async function destroy(req, res) {
  const tax = await service.destroy(req, req.params.id);

  describeActivity(req, {
    entityId: tax.id,
    description: `Deleted tax ${tax.name} (${tax.code})`,
    metadata: { code: tax.code, rate_percent: tax.rate_percent },
  });

  return ApiResponse.ok(res, { tax }, { message: 'Tax deleted' });
}

module.exports = {
  list,
  show,
  create,
  update,
  setDefault,
  clearDefault,
  destroy,
};
