'use strict';

/**
 * Roles and their permission grants — SRS §29 (`roles`, `permissions`, `role_permissions`) and
 * FR-AUTH-008 / FR-AUTH-009, which require middleware that checks a request against a role's granted
 * permissions. `roles.validation.js` records what is and is not editable, and why §33 is not cited.
 *
 * ## This table has no `school_id`, and that decides the guard
 *
 * `role_permissions` is one of the platform tables: a row is `(role_id, permission_id)` and nothing
 * else. So revoking `attendance.mark` from the `teacher` role revokes it from **every teacher in every
 * school on the platform**. That is not a tenant-scoped write dressed up as one — it is a cross-tenant
 * write, which SRS §30 Rule 2 forbids anyone below the platform from making. Hence `roles.manage` is
 * granted to `super_admin` alone in `config/permissions.js`, and the route carries
 * `requirePlatformScope()` on top of it: two independent checks, as `app.js` documents for `/schools`.
 *
 * Per-school customisation is the per-user override on `users.extra_permissions` /
 * `users.denied_permissions`, which a Principal can set through the users module because that row *is*
 * tenant-scoped. The two mechanisms are not alternatives for the same job — one is platform policy, the
 * other is one account's exception.
 *
 * ## Why `super_admin`'s grants are read-only
 *
 * `03-role-permissions.js` hard-syncs `super_admin` to the whole catalogue on every seed run, and its
 * header gives the reason: it is the only role that can edit grants at all, so a revoked `roles.manage`
 * would remove the platform's own way back in. An endpoint that accepted the edit would therefore report a
 * change that the next `db:seed` silently undoes — worse than refusing, because the operator would
 * believe it.
 */

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const permissionService = require('../../services/permissionService');
const { recordAudit } = require('../../middlewares/activityLog');
const { ROLES } = require('../../config/constants');
const { PERMISSION_KEY_SET } = require('../../config/permissions');

const { tenantWhere } = db;

/**
 * Every role, with the two counts a matrix screen needs beside each name.
 *
 * Unpaginated on purpose. SRS §5 fixes the list at eleven and `roles.slug` validates against
 * `ROLE_LIST`, so the result set has a known ceiling and cannot grow with use — paging it would add a
 * `meta.pagination` envelope that could only ever describe one page.
 *
 * ## `userCount` is tenant-scoped; `permissionCount` cannot be
 *
 * The route is readable by anyone holding `users.view`, which includes Principals and Organization
 * Admins, so an unscoped `COUNT(*) GROUP BY role_id` would tell a Principal how many accounts of each
 * role exist across the whole platform. That is cross-tenant information, and SRS §8 does not become
 * inapplicable because the number is an aggregate. `tenantWhere()` narrows it to what the caller may
 * already see through `GET /users`.
 *
 * `permissionCount` gets no such treatment because it cannot: `role_permissions` has no `school_id` and
 * the same grant applies platform-wide — that global-ness is precisely what makes the *write* below
 * platform-only.
 *
 * @param {object} tenant  `req.tenant`
 * @returns {Promise<object[]>}
 */
async function list(tenant) {
  const roles = await db.Role.findAll({ order: [['id', 'ASC']] });

  const [grantRows, userRows] = await Promise.all([
    db.RolePermission.count({ group: ['role_id'] }),
    db.User.count({ where: tenantWhere(tenant, {}, { allowPlatformWide: true }), group: ['role_id'] }),
  ]);

  /* `count({group})` returns `[{role_id, count}]`, and omits a role entirely when it has none — so the
   * map is read with a `|| 0` default rather than assumed complete. */
  const grants = new Map(grantRows.map((row) => [row.role_id, Number(row.count)]));
  const users = new Map(userRows.map((row) => [row.role_id, Number(row.count)]));

  return roles.map((role) => ({
    ...present(role),
    permissionCount: grants.get(role.id) || 0,
    userCount: users.get(role.id) || 0,
  }));
}

/**
 * The client-facing shape of a role.
 *
 * The three structural booleans are published because a matrix screen has to know them — a platform
 * role's row is not something a school-level administrator should be shown as editable — even though
 * `roles.validation.js` refuses to let them be written.
 *
 * @param {object} role
 * @returns {object}
 */
function present(role) {
  return {
    id: role.id,
    slug: role.slug,
    name: role.name,
    description: role.description,
    isPlatformRole: Boolean(role.is_platform_role),
    isSchoolRole: Boolean(role.is_school_role),
    isSystem: Boolean(role.is_system),
  };
}

/**
 * One role, or a 404.
 *
 * No tenant scoping, and none is possible: `roles` has no `school_id`. The route's
 * `requirePlatformScope()` is what confines the caller.
 *
 * @param {number|string} id
 * @returns {Promise<object>}
 */
async function findById(id) {
  const role = await db.Role.findByPk(id);
  if (!role) throw ApiError.notFound('Role not found', { code: 'ROLE_NOT_FOUND' });
  return role;
}

/**
 * One role plus its granted permission keys.
 *
 * Read through `permissionService.getRolePermissions()` rather than with a fresh query, so the screen
 * shows the same set the guard will enforce — including the cache. A screen reading past the cache
 * would display grants that `requirePermission` has not started honouring yet.
 *
 * @param {number|string} id
 * @returns {Promise<object>}
 */
async function findByIdWithPermissions(id) {
  const role = await findById(id);
  const keys = await permissionService.getRolePermissions(role.id);

  return { ...present(role), permissions: keys.slice().sort() };
}

/** Labels only. @returns {Promise<object>} */
async function update(req, id, payload) {
  const role = await findById(id);
  const before = { id: role.id, name: role.name, description: role.description };

  await role.update(payload);

  await recordAudit(req, {
    tableName: 'roles',
    recordId: role.id,
    event: 'update',
    before,
    after: { id: role.id, name: role.name, description: role.description },
    reason: 'Role label updated',
  });

  return findByIdWithPermissions(role.id);
}

/**
 * Replace a role's entire grant set — FR-AUTH-009's data.
 *
 * A whole-set replacement inside one transaction. The alternative, add-and-remove deltas, needs the
 * client to send what changed, which means the client's idea of the current set decides the outcome; two
 * administrators on the matrix screen at once would then each apply their delta to a set neither of them
 * was looking at.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {string[]} keys  the complete set of permission keys the role should hold
 * @returns {Promise<object>}
 */
async function setPermissions(req, id, keys) {
  const role = await findById(id);

  /* See the file header: the seeder would undo it on the next run, so accepting it would be a lie. */
  if (role.slug === ROLES.SUPER_ADMIN) {
    throw ApiError.forbidden(
      'The super_admin role always holds the complete permission catalogue and cannot be edited.',
      { code: 'ROLE_NOT_EDITABLE', details: { slug: role.slug } }
    );
  }

  const unknown = keys.filter((key) => !PERMISSION_KEY_SET.has(key));
  if (unknown.length) {
    throw ApiError.validation('One or more permission keys do not exist', {
      permissions: `Unknown permission key(s): ${unknown.join(', ')}`,
    });
  }

  const before = (await permissionService.getRolePermissions(role.id)).slice().sort();
  const rows = await permissionService.findPermissionsByKeys(keys);

  await db.sequelize.transaction(async (transaction) => {
    await db.RolePermission.destroy({ where: { role_id: role.id }, transaction });
    if (rows.length) {
      await db.RolePermission.bulkCreate(
        rows.map((row) => ({ role_id: role.id, permission_id: row.id })),
        { transaction }
      );
    }
  });

  /*
   * Mandatory, and it must come after the commit. `permissionService` caches a role's grants for
   * `config.cache.ttlSeconds`, and its own header explains what a missed invalidation costs: a
   * revocation that waits out the TTL while the permission it revoked keeps working.
   */
  await permissionService.invalidateRole(role.id);

  await recordAudit(req, {
    tableName: 'role_permissions',
    recordId: role.id,
    event: 'update',
    before: { role_id: role.id, permissions: before },
    after: { role_id: role.id, permissions: rows.map((row) => row.key).sort() },
    reason: `Permission set replaced for role ${role.slug}`,
  });

  return findByIdWithPermissions(role.id);
}

module.exports = {
  list,
  findById,
  findByIdWithPermissions,
  update,
  setPermissions,
  present,
};
