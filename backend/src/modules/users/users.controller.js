'use strict';

/**
 * User controllers — SRS §33 "Users", FR-AUTH-006, FR-AUTH-007, FR-AUTH-009.
 */

const service = require('./users.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

/** GET / — the §33 Users list. */
async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req.tenant, req.query, pagination, req);

  return ApiResponse.paginated(
    res,
    { rows: result.rows.map(service.present), count: result.count },
    pagination
  );
}

/** GET /:id — one account, with the permission picture behind it. */
async function show(req, res) {
  const user = await service.findById(req.tenant, req.params.id);
  return ApiResponse.ok(res, { user: await service.presentWithPermissions(user) });
}

/** PATCH /:id — edit an account. */
async function update(req, res) {
  const { user, verificationEmailSent } = await service.update(req, req.params.id, req.body);

  describeActivity(req, {
    entityType: 'user',
    entityId: user.id,
    /* The submitted field *names*, never their values: an activity description is read by
     * administrators, and an email or phone number in it outlives the row it came from. */
    description: `Updated user ${user.username} (${Object.keys(req.body).sort().join(', ')})`,
    metadata: {
      fields: Object.keys(req.body).sort(),
      status: user.status,
      ...(verificationEmailSent === null ? {} : { verificationEmailSent }),
    },
  });

  return ApiResponse.ok(
    res,
    {
      user: await service.presentWithPermissions(user),
      ...(verificationEmailSent === null ? {} : { verificationEmailSent }),
    },
    { message: 'User updated' }
  );
}

/** PUT /:id/permissions — replace the per-user overrides (FR-AUTH-009). */
async function setPermissions(req, res) {
  const user = await service.setPermissions(req, req.params.id, req.body);
  const payload = await service.presentWithPermissions(user);

  describeActivity(req, {
    entityType: 'user',
    entityId: user.id,
    description: `Replaced permission overrides for ${user.username}`,
    /* Counts, not keys. The keys are already in `audit_logs.old_values`/`new_values`, and an
     * activity row is the summary an administrator scrolls, not the diff. */
    metadata: {
      extraCount: payload.permissions.extra.length,
      deniedCount: payload.permissions.denied.length,
      effectiveCount: payload.permissions.effective.length,
    },
  });

  return ApiResponse.ok(res, { user: payload }, { message: 'Permissions updated' });
}

/** GET /permissions — the assignable vocabulary, grouped. */
async function catalogue(req, res) {
  const groups = service.permissionCatalogue();

  return ApiResponse.ok(res, {
    groups,
    total: groups.reduce((sum, group) => sum + group.permissions.length, 0),
  });
}

module.exports = { list, show, update, setPermissions, catalogue };
