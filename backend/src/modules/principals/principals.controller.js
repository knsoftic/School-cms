'use strict';

/**
 * Principal controllers — SRS §9.3, FR-SADMIN-009.
 */

const service = require('./principals.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

/** GET / — the candidate list FR-SADMIN-007's assignment screen selects from. */
async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req.tenant, req.query, pagination, req);

  return ApiResponse.paginated(
    res,
    { rows: result.rows.map(service.present), count: result.count },
    pagination
  );
}

/** GET /:id — one Principal. */
async function show(req, res) {
  const user = await service.findById(req.tenant, req.params.id);
  return ApiResponse.ok(res, { principal: service.present(user) });
}

/** POST / — FR-SADMIN-009. */
async function create(req, res) {
  const { user, verificationEmailSent } = await service.create(req, req.body);

  describeActivity(req, {
    entityType: 'user',
    entityId: user.id,
    description: `Created Principal ${user.name} (${user.email}) for school ${req.body.school_id}`,
    /* No password, and no token — the metadata of a creation row is read by administrators. */
    metadata: {
      schoolId: user.school_id,
      status: user.status,
      verificationEmailSent,
    },
  });

  return ApiResponse.created(
    res,
    { principal: service.present(user), verificationEmailSent },
    { message: 'Principal created' }
  );
}

module.exports = { list, show, create };
