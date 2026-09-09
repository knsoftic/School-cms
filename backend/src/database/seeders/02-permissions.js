'use strict';

/**
 * Permissions — SRS §4 "Permission-based access control" and §7 "Permission middleware".
 *
 * The catalogue itself lives in `src/config/permissions.js` so application code can reference
 * a key by constant; this seeder only projects it into the `permissions` table, which is what
 * the middleware reads at request time.
 *
 * Keys are stable identifiers. A permission that disappears from the catalogue is removed here
 * too, because leaving an orphan row would let the permission-matrix UI grant a capability no
 * route checks.
 */

const { PERMISSIONS, PERMISSION_KEYS } = require('../../config/permissions');
const logger = require('../../config/logger');

module.exports = {
  name: 'permissions',

  async up(db, transaction) {
    const existing = await db.Permission.findAll({ transaction });
    const byKey = new Map(existing.map((row) => [row.key, row]));

    let created = 0;
    let updated = 0;

    for (const definition of PERMISSIONS) {
      const row = byKey.get(definition.key);

      if (!row) {
        await db.Permission.create(
          {
            key: definition.key,
            name: definition.name,
            group: definition.group,
            module: definition.module,
          },
          { transaction }
        );
        created += 1;
        continue;
      }

      const changes = {};
      for (const field of ['name', 'group', 'module']) {
        const next = definition[field] === undefined ? null : definition[field];
        if (row[field] !== next) changes[field] = next;
      }
      if (Object.keys(changes).length) {
        await row.update(changes, { transaction });
        updated += 1;
      }
    }

    /*
     * Drop rows whose key is no longer in the catalogue. `role_permissions.permission_id`
     * cascades, so the grants go with them — which is the intent: an unchecked permission
     * must not remain grantable.
     */
    const stale = existing.filter((row) => !PERMISSION_KEYS.includes(row.key));
    if (stale.length) {
      await db.Permission.destroy({ where: { id: stale.map((row) => row.id) }, transaction });
      logger.warn(
        `Removed ${stale.length} permission(s) no longer in the catalogue: ` +
          stale.map((row) => row.key).join(', ')
      );
    }

    const total = await db.Permission.count({ transaction });
    return { created, updated, removed: stale.length, total };
  },

  async down(db, transaction) {
    const removed = await db.Permission.destroy({ where: { key: PERMISSION_KEYS }, transaction });
    return { removed };
  },
};
