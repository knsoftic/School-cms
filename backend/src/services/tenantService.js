'use strict';

/**
 * Tenant lookups — SRS §8 (Multi-Tenant & School Isolation), §30 Rule 2.
 *
 * `resolveTenant` and `enforceTenant` both need the same two facts on nearly every request: the
 * status of the caller's school/organization, and which organization a given school belongs to.
 * Reading them straight from the models would put two extra queries on the hot path of every
 * authenticated call, so they are cached here behind a narrow interface.
 *
 * Only the columns the isolation layers actually use are selected and cached. That is deliberate:
 * a cached row is a copy that can go stale, and the fewer fields it carries the less can be wrong.
 * Anything that needs the full record reads the model directly.
 *
 * Whatever writes `schools` or `organizations` must call the matching `invalidate…`. A school
 * suspended by the Super Admin has to lose access on the next request, not when a TTL lapses —
 * that is what FR-SADMIN-005's "suspended schools' access is restricted" means in practice.
 */

const db = require('../models');
const { cache } = require('../config/cache');
const config = require('../config/env');

const CACHE_NAMESPACE = 'tenant';

/**
 * Cache misses and "row does not exist" have to be distinguishable, because `cache.remember` only
 * stores values that are not `undefined`. A missing row is cached as this sentinel so a request
 * carrying a nonexistent school id does not re-query on every attempt — which is exactly the shape
 * an enumeration probe takes.
 */
const MISSING = { missing: true };

function schoolKey(schoolId) {
  return cache.key(CACHE_NAMESPACE, 'school', schoolId);
}

function organizationKey(organizationId) {
  return cache.key(CACHE_NAMESPACE, 'organization', organizationId);
}

/**
 * Minimal school record for the isolation layers.
 *
 * @param {number} schoolId
 * @returns {Promise<{id: number, organization_id: number, status: string, subscription_state: string}|null>}
 */
async function getSchool(schoolId) {
  const id = Number(schoolId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const value = await cache.remember(schoolKey(id), config.cache.ttlSeconds, async () => {
    const school = await db.School.findByPk(id, {
      attributes: ['id', 'organization_id', 'status', 'subscription_state'],
      raw: true,
    });
    return school || MISSING;
  });

  return value && value.missing ? null : value;
}

/**
 * Minimal organization record for the isolation layers.
 *
 * @param {number} organizationId
 * @returns {Promise<{id: number, status: string}|null>}
 */
async function getOrganization(organizationId) {
  const id = Number(organizationId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const value = await cache.remember(organizationKey(id), config.cache.ttlSeconds, async () => {
    const organization = await db.Organization.findByPk(id, {
      attributes: ['id', 'status'],
      raw: true,
    });
    return organization || MISSING;
  });

  return value && value.missing ? null : value;
}

/**
 * Does `schoolId` sit inside `organizationId`?
 *
 * Used by `enforceTenant` to decide whether an organization-scoped caller may act on a school they
 * named. A school that does not exist answers `false` rather than throwing, so a probe for an
 * unknown id and a probe for another organization's id are indistinguishable from outside.
 */
async function schoolBelongsToOrganization(schoolId, organizationId) {
  const school = await getSchool(schoolId);
  if (!school) return false;
  return String(school.organization_id) === String(organizationId);
}

async function invalidateSchool(schoolId) {
  await cache.del(schoolKey(schoolId));
}

async function invalidateOrganization(organizationId) {
  await cache.del(organizationKey(organizationId));
}

/** Drop every cached tenant row — for a bulk import or a restored backup. */
async function invalidateAll() {
  await cache.invalidate(CACHE_NAMESPACE);
}

module.exports = {
  getSchool,
  getOrganization,
  schoolBelongsToOrganization,
  invalidateSchool,
  invalidateOrganization,
  invalidateAll,
};
