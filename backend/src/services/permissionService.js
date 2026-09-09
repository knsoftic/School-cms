'use strict';

/**
 * Effective-permission resolution — SRS §7 FR-AUTH-009 ("Permission middleware"), over the §29
 * `permissions` / `role_permissions` tables and the two override columns on `users`.
 *
 * §33 is deliberately *not* cited. Its Super Admin list is Dashboard, Organizations, Schools,
 * Principals, Users, Plans, Modules, Features, Limits, Add-ons, Subscriptions, Invoices, Payments,
 * Coupons, Reports, Settings — there is no "Roles & Permissions" screen in it, and earlier revisions of
 * this header claimed one. The capability stands on §29 fixing three tables for it and FR-AUTH-009
 * requiring middleware that reads them; it does not need a screen the source never named.
 *
 * ## Why this reads the database and not the JWT
 *
 * The access token carries no permission claim at all — `utils/tokens.accessTokenPayload()` documents
 * why it was removed — but the argument would hold even if it did. An access token lives 15 minutes
 * (`JWT_ACCESS_EXPIRES_IN`), so an administrator who revokes a teacher's `exams.publish` grant would
 * watch that teacher keep publishing for up to a quarter of an hour. A revocation has to bite on the
 * next request, which means the server resolves permissions from `role_permissions` on every call.
 *
 * The frontend gets the list from the body of login, refresh and `/auth/me`, which is enough to build
 * its navigation and is fresh every time it asks.
 *
 * The cost of that is one query per role, which is why role grants are cached and invalidated
 * explicitly whenever they are edited. The per-user overrides cost nothing extra: they live on the
 * `users` row that `authenticate` has already loaded.
 *
 * ## Resolution order
 *
 *   role_permissions  ∪  users.extra_permissions  −  users.denied_permissions
 *
 * Deny is applied last and wins outright. Where the two override columns disagree the safe answer
 * is "no", and an administrator who explicitly revokes something expects it to stay revoked regardless
 * of what the role grants.
 *
 * ## The two halves are not interchangeable
 *
 * `role_permissions` has no `school_id`: editing it changes every holder of that role on the platform,
 * which is why `PUT /roles/:id/permissions` is platform-only. The override columns are on a `users` row
 * and are therefore tenant-scoped, which is why `PUT /users/:id/permissions` is reachable by a Principal
 * for their own school's accounts. Role grants are platform policy; overrides are one account's
 * exception.
 *
 * ## No role is special-cased
 *
 * There is deliberately no `if (role === 'super_admin') return true`. The permission seeder syncs
 * every one of the 109 keys onto that role, so reading the database gives the same answer without
 * a branch that could drift from the data — the same reasoning SRS §30 Rule 1 applies to plans.
 */

const { Op } = require('sequelize');

const db = require('../models');
const { cache } = require('../config/cache');
const config = require('../config/env');
const logger = require('../config/logger');
const { PERMISSION_KEY_SET } = require('../config/permissions');

const CACHE_NAMESPACE = 'perm';

/** Cache key for one role's grants. */
function roleCacheKey(roleId) {
  return cache.key(CACHE_NAMESPACE, 'role', roleId);
}

/**
 * Coerce a JSON override column into a clean array of known permission keys.
 *
 * Unknown keys are dropped rather than trusted. A key left behind by a removed feature cannot
 * grant or deny anything real, and silently carrying it forward makes the effective set
 * misleading when it is shown back to an administrator. The drop is logged because the only way
 * one gets there is a bug in whatever wrote the column.
 */
function normalizeOverrides(value, context) {
  if (!Array.isArray(value)) return [];

  const known = [];
  const unknown = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    if (PERMISSION_KEY_SET.has(entry)) known.push(entry);
    else unknown.push(entry);
  }

  if (unknown.length) {
    logger.warn('Discarded unrecognised permission keys', { ...context, keys: unknown });
  }
  return known;
}

/**
 * Permission keys granted to a role, from `role_permissions`.
 *
 * Returns an array rather than a Set because the value is cached, and a Set does not survive the
 * JSON round trip either cache driver performs.
 *
 * @param {number} roleId
 * @returns {Promise<string[]>}
 */
async function getRolePermissions(roleId) {
  if (!roleId) return [];

  return cache.remember(roleCacheKey(roleId), config.cache.ttlSeconds, async () => {
    const rows = await db.RolePermission.findAll({
      where: { role_id: roleId },
      include: [{ model: db.Permission, as: 'permission', attributes: ['key'], required: true }],
      attributes: ['permission_id'],
    });
    return rows.map((row) => row.permission.key);
  });
}

/**
 * The caller's full effective permission set.
 *
 * @param {{role_id: number, id?: number, extra_permissions?: string[], denied_permissions?: string[]}} user
 * @returns {Promise<Set<string>>}
 */
async function getEffectivePermissions(user) {
  if (!user || !user.role_id) return new Set();

  const granted = await getRolePermissions(user.role_id);
  const context = { userId: user.id, roleId: user.role_id };

  const effective = new Set(granted);
  for (const key of normalizeOverrides(user.extra_permissions, { ...context, column: 'extra_permissions' })) {
    effective.add(key);
  }
  for (const key of normalizeOverrides(user.denied_permissions, { ...context, column: 'denied_permissions' })) {
    effective.delete(key);
  }

  return effective;
}

/** @returns {Promise<boolean>} */
async function hasPermission(user, permissionKey) {
  const effective = await getEffectivePermissions(user);
  return effective.has(permissionKey);
}

/** True when the caller holds at least one of `permissionKeys`. */
async function hasAnyPermission(user, permissionKeys) {
  const effective = await getEffectivePermissions(user);
  return permissionKeys.some((key) => effective.has(key));
}

/** True when the caller holds every one of `permissionKeys`. */
async function hasAllPermissions(user, permissionKeys) {
  const effective = await getEffectivePermissions(user);
  return permissionKeys.every((key) => effective.has(key));
}

/**
 * Drop one role's cached grants.
 *
 * Must be called by anything that writes `role_permissions` — today that is
 * `roles.service.setPermissions()`, which calls it after the transaction commits. Without it a
 * revocation would wait out the cache TTL, which is the very delay this service exists to avoid.
 */
async function invalidateRole(roleId) {
  await cache.del(roleCacheKey(roleId));
}

/** Drop every role's cached grants — for a permission re-seed or a multi-role save. */
async function invalidateAllRoles() {
  await cache.invalidate(CACHE_NAMESPACE, 'role');
}

/**
 * Assert that permission keys named in code actually exist.
 *
 * Called by `requirePermission()` at route-definition time. A typo in a route guard is otherwise
 * invisible: `requirePermission('studnets.view')` would simply deny everyone forever, and it
 * would look like a permissions-data problem rather than a typo. Failing at boot turns a silent
 * production lockout into a stack trace on startup.
 *
 * @param {string[]} keys
 * @param {string} caller  name used in the error message
 */
function assertKnownPermissionKeys(keys, caller) {
  const unknown = keys.filter((key) => !PERMISSION_KEY_SET.has(key));
  if (unknown.length) {
    throw new Error(
      `${caller}: unknown permission key(s) ${unknown.join(', ')}. ` +
        'Permission keys must exist in src/config/permissions.js (SRS §9).'
    );
  }
}

/**
 * Resolve permission keys to `permissions` rows.
 *
 * Used by `roles.service.setPermissions()` when replacing a role's grant set, so the caller can turn
 * keys from the request body into `permission_id`s without every module writing the same lookup.
 *
 * The returned array is not padded: a key with no row is simply absent, which is what lets the caller
 * detect unknown keys by comparing lengths rather than by a second query.
 *
 * @param {string[]} keys
 * @returns {Promise<Array<{id: number, key: string}>>}
 */
async function findPermissionsByKeys(keys) {
  if (!keys.length) return [];
  return db.Permission.findAll({
    where: { key: { [Op.in]: keys } },
    attributes: ['id', 'key'],
    raw: true,
  });
}

module.exports = {
  getRolePermissions,
  getEffectivePermissions,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  invalidateRole,
  invalidateAllRoles,
  assertKnownPermissionKeys,
  findPermissionsByKeys,
};
