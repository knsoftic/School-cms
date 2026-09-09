'use strict';

/**
 * Role controllers — SRS §29 (`roles`, `role_permissions`), FR-AUTH-008, FR-AUTH-009.
 */

const service = require('./roles.service');
const ApiResponse = require('../../utils/ApiResponse');
const { describeActivity } = require('../../middlewares/activityLog');

/** GET / — §5's eleven roles, with a permission count and a tenant-scoped user count. */
async function list(req, res) {
  const roles = await service.list(req.tenant);
  return ApiResponse.ok(res, { roles, total: roles.length });
}

/** GET /:id — one role and its granted permission keys. */
async function show(req, res) {
  return ApiResponse.ok(res, { role: await service.findByIdWithPermissions(req.params.id) });
}

/** PATCH /:id — the two label columns. */
async function update(req, res) {
  const role = await service.update(req, req.params.id, req.body);

  describeActivity(req, {
    entityType: 'role',
    entityId: role.id,
    description: `Updated role ${role.slug} (${Object.keys(req.body).sort().join(', ')})`,
    metadata: { slug: role.slug, fields: Object.keys(req.body).sort() },
  });

  return ApiResponse.ok(res, { role }, { message: 'Role updated' });
}

/** PUT /:id/permissions — replace the role's entire grant set. */
async function setPermissions(req, res) {
  const role = await service.setPermissions(req, req.params.id, req.body.permissions);

  describeActivity(req, {
    entityType: 'role',
    entityId: role.id,
    /* Platform-wide by construction — `role_permissions` has no `school_id` — and the description
     * says so, because that is the fact an administrator reading the trail needs to register. */
    description: `Replaced the platform-wide permission set for role ${role.slug}`,
    metadata: { slug: role.slug, permissionCount: role.permissions.length },
  });

  return ApiResponse.ok(res, { role }, { message: 'Role permissions updated' });
}

module.exports = { list, show, update, setPermissions };
