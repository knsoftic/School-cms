'use strict';

/**
 * Organization controllers — thin by design. Every rule lives in `organizations.service.js`; what is
 * here is the translation between an HTTP request and a service call, and the activity row's payload.
 */

const service = require('./organizations.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

/** GET / — one page of organizations, scoped to the caller. */
async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req.tenant, req.query, pagination, req);
  return ApiResponse.paginated(res, result, pagination);
}

/** GET /:id — FR-SADMIN-002's precondition, made checkable. */
async function show(req, res) {
  const organization = await service.findById(req.tenant, req.params.id);
  return ApiResponse.ok(res, { organization });
}

/** POST / — create the organization a school will belong to. */
async function create(req, res) {
  const organization = await service.create(req, req.body);

  describeActivity(req, {
    entityId: organization.id,
    description: `Created organization ${organization.name} (${organization.code})`,
    metadata: { code: organization.code, status: organization.status },
  });

  return ApiResponse.created(res, { organization }, { message: 'Organization created' });
}

/** PATCH /:id — partial update; the audit row records which columns actually moved. */
async function update(req, res) {
  const organization = await service.update(req, req.params.id, req.body);

  describeActivity(req, {
    entityId: organization.id,
    description: `Updated organization ${organization.name} (${organization.code})`,
    /* The keys, not the values — an activity row is read by people and must not become a data copy. */
    metadata: { fields: Object.keys(req.body) },
  });

  return ApiResponse.ok(res, { organization }, { message: 'Organization updated' });
}

module.exports = { list, show, create, update };
