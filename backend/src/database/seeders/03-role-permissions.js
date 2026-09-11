'use strict';

/**
 * Role → permission defaults, seeded into `role_permissions`.
 *
 * Two different rules apply here, for a reason worth stating plainly.
 *
 * SRS §29 gives role grants their own table rather than fixing them in the role row, and FR-AUTH-009
 * requires middleware that reads it on every request — so grants are editable data, not configuration,
 * and `PUT /roles/:id/permissions` edits them. A seeder that hard-synced every role back to
 * `DEFAULT_ROLE_PERMISSIONS` would silently undo those edits on the next deploy. And because
 * SRS §29 fixes the schema at 64 tables, there is nowhere to record "the admin deliberately
 * revoked this" — so a missing grant is indistinguishable from a grant that was never made.
 *
 * Therefore:
 *   • A role with no grants at all is bootstrapped from the defaults (first run, or a role
 *     added to SRS §5's list later).
 *   • A role that already has grants is left untouched; drift is logged, not corrected.
 *   • `super_admin` is the one exception and is always hard-synced to the full catalogue.
 *     It is the only role that can edit grants at all, so a revoked `roles.manage` would lock the
 *     platform out of its own recovery path. Keeping it complete is a safety property, and
 *     matches SRS §5's definition of the role as platform-level owner. `roles.service` refuses to
 *     edit that role for the same reason.
 */

const { ROLES } = require('../../config/constants');
const { DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS, PREVIOUS_DEFAULTS } = require('../../config/permissions');
const logger = require('../../config/logger');

module.exports = {
  name: 'role-permissions',

  async up(db, transaction) {
    const roles = await db.Role.findAll({ transaction });
    const roleBySlug = new Map(roles.map((row) => [row.slug, row]));

    const permissions = await db.Permission.findAll({ transaction });
    const permissionIdByKey = new Map(permissions.map((row) => [row.key, row.id]));

    const existing = await db.RolePermission.findAll({ transaction });
    const grantsByRole = new Map();
    for (const grant of existing) {
      if (!grantsByRole.has(grant.role_id)) grantsByRole.set(grant.role_id, new Set());
      grantsByRole.get(grant.role_id).add(grant.permission_id);
    }

    let granted = 0;
    let revoked = 0;
    let bootstrapped = 0;
    let preserved = 0;

    for (const [slug, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      const role = roleBySlug.get(slug);
      if (!role) {
        logger.warn(`Role "${slug}" is missing; skipping its permission defaults.`);
        continue;
      }

      const wantedIds = new Set();
      for (const key of keys) {
        const permissionId = permissionIdByKey.get(key);
        if (permissionId === undefined) {
          logger.warn(`Permission "${key}" is missing; cannot grant it to "${slug}".`);
          continue;
        }
        wantedIds.add(permissionId);
      }

      const currentIds = grantsByRole.get(role.id) || new Set();
      const isSuperAdmin = slug === ROLES.SUPER_ADMIN;

      /*
       * A role that still holds exactly an earlier version's defaults was never customised, so it is
       * brought up to the current ones (`PREVIOUS_DEFAULTS` — the owner's decision D27 is the first
       * change to a default). Any other difference is the Super Admin's configuration and is kept.
       */
      const onEarlierDefaults = (PREVIOUS_DEFAULTS[slug] || []).some((keys) => {
        const ids = keys.map((key) => permissionIdByKey.get(key)).filter((id) => id !== undefined);
        return ids.length === currentIds.size && ids.every((id) => currentIds.has(id));
      });

      if (currentIds.size && !isSuperAdmin && !onEarlierDefaults) {
        /* Existing grants are the Super Admin's business; only report the difference. */
        const missing = [...wantedIds].filter((id) => !currentIds.has(id)).length;
        const extra = [...currentIds].filter((id) => !wantedIds.has(id)).length;
        if (missing || extra) {
          logger.info(
            `Role "${slug}" differs from defaults (${missing} not granted, ${extra} beyond ` +
              'defaults) — left as configured; change it with PUT /roles/:id/permissions.'
          );
        }
        preserved += 1;
        continue;
      }

      const toAdd = [...wantedIds].filter((id) => !currentIds.has(id));
      if (toAdd.length) {
        await db.RolePermission.bulkCreate(
          toAdd.map((permission_id) => ({ role_id: role.id, permission_id })),
          { transaction }
        );
        granted += toAdd.length;
      }

      if (isSuperAdmin) {
        /* Hard sync: nothing outside the catalogue should be attached either. */
        const toRemove = [...currentIds].filter((id) => !wantedIds.has(id));
        if (toRemove.length) {
          await db.RolePermission.destroy({
            where: { role_id: role.id, permission_id: toRemove },
            transaction,
          });
          revoked += toRemove.length;
        }
      }

      if (!currentIds.size) bootstrapped += 1;
    }

    /* The catalogue is the upper bound; super_admin must hold all of it. */
    const superAdmin = roleBySlug.get(ROLES.SUPER_ADMIN);
    if (superAdmin) {
      const count = await db.RolePermission.count({
        where: { role_id: superAdmin.id },
        transaction,
      });
      if (count !== PERMISSION_KEYS.length) {
        logger.warn(
          `super_admin holds ${count} of ${PERMISSION_KEYS.length} permissions after seeding.`
        );
      }
    }

    const total = await db.RolePermission.count({ transaction });
    return { bootstrapped, preserved, granted, revoked, total };
  },

  async down(db, transaction) {
    const roles = await db.Role.findAll({
      where: { slug: Object.keys(DEFAULT_ROLE_PERMISSIONS) },
      attributes: ['id'],
      transaction,
    });
    if (!roles.length) return { removed: 0 };
    const removed = await db.RolePermission.destroy({
      where: { role_id: roles.map((row) => row.id) },
      transaction,
    });
    return { removed };
  },
};
