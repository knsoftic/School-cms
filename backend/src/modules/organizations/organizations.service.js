'use strict';

/**
 * Organization data access — SRS §5 hierarchy, §33 "Organizations", FR-SADMIN-002's precondition.
 *
 * ## Why `tenantWhere()` is not used in this file
 *
 * `tenantWhere()` is the query-layer scope helper (isolation layer 4) and every other module should
 * reach for it. It is wrong *here*, and the reason is worth stating so nobody "fixes" this back:
 *
 *   - It writes `where.school_id` first when the caller has one, then `where.organization_id`. The
 *     `organizations` table has **neither column** — an organization's own identity is its primary key.
 *   - So `tenantWhere(tenant, {})` against this model would either add a column that does not exist
 *     (a SQL error, which is the good case) or, if someone passed `{column: 'id'}` to work around that,
 *     silently compare a caller's *school* id against an *organization* id. Two different id spaces
 *     that happen to both be integers is exactly the shape of a cross-tenant read that returns a row.
 *
 * The scope is therefore written out explicitly below, where it can be read and checked. The same
 * argument applies to `schools` — see `schools.service.js`.
 *
 * ## Cache invalidation
 *
 * `tenantService` caches organizations, and `resolveTenant` refuses a suspended or archived one on the
 * strength of that cache. An organization suspended by the Super Admin therefore has to lose access on
 * the *next* request, not when a TTL lapses, so every write here ends with `invalidateOrganization()`.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const tenantService = require('../../services/tenantService');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');

/** Columns a client may sort on. Anything else falls back — see `getSort`. */
const SORTABLE = Object.freeze(['id', 'name', 'code', 'status', 'created_at', 'updated_at']);

/**
 * Which organizations this caller may see.
 *
 * @param {{isPlatform: boolean, organizationId: number|null}} tenant  `req.tenant`
 * @returns {object} a Sequelize `where` fragment
 */
function scopeFor(tenant) {
  if (!tenant) throw new Error('organizations.service: req.tenant is missing — resolveTenant did not run');

  /* Super Admin — FR-SADMIN-001's platform-wide view needs every organization. */
  if (tenant.isPlatform) return {};

  /* An organization-scoped caller sees exactly one row: their own. */
  if (tenant.organizationId) return { id: tenant.organizationId };

  /*
   * A school-scoped caller with `organizations.view` would land here. No role holds that combination
   * today (`DEFAULT_ROLE_PERMISSIONS` gives school leadership neither key), but refusing is the only
   * safe answer if one ever does: returning `{}` would be an unscoped read.
   */
  throw ApiError.forbidden('This account is not scoped to an organization', {
    code: 'TENANT_SCOPE_REQUIRED',
  });
}

/**
 * A unique-index collision reported as a 409 instead of a 500.
 *
 * `organizations.code` is the only unique index on the table, so the message can name it directly.
 *
 * @param {Error} err
 * @param {object} payload  what the caller sent, so the response can quote the offending value
 */
function rethrow(err, payload) {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    throw ApiError.conflict('An organization with this code already exists', {
      code: 'ORGANIZATION_CODE_TAKEN',
      details: { code: payload.code },
    });
  }
  throw err;
}

/**
 * One page of organizations.
 *
 * @param {object} tenant  `req.tenant`
 * @param {object} query   validated `req.query`
 * @param {{page: number, limit: number, offset: number}} pagination
 * @param {import('express').Request} req  for `getSort`
 * @returns {Promise<{rows: object[], count: number}>}
 */
async function list(tenant, query, pagination, req) {
  const where = scopeFor(tenant);

  if (query.status) where.status = query.status;

  if (query.q) {
    /* Name or code — the two things an administrator has in hand when looking for an organization. */
    where[Op.or] = [{ name: { [Op.like]: `%${query.q}%` } }, { code: { [Op.like]: `%${query.q}%` } }];
  }

  return paginateQuery(db.Organization, { where, order: getSort(req, SORTABLE) }, pagination);
}

/**
 * One organization, or a 404.
 *
 * The scope is applied in the `where`, not checked after the read, so a caller outside the
 * organization gets "not found" rather than a row they may not have. `enforceTenant` already refuses
 * `/organizations/:id` for a mismatched id from the global mount; this is the second of the two.
 *
 * @param {object} tenant
 * @param {number|string} id
 * @returns {Promise<object>}
 */
async function findById(tenant, id) {
  const organization = await db.Organization.findOne({ where: { ...scopeFor(tenant), id } });
  if (!organization) throw ApiError.notFound('Organization not found', { code: 'ORGANIZATION_NOT_FOUND' });
  return organization;
}

/**
 * Create an organization — the row FR-SADMIN-002's precondition requires to exist.
 *
 * @param {import('express').Request} req  for the audit row's actor and request context
 * @param {object} payload  validated body
 * @returns {Promise<object>}
 */
async function create(req, payload) {
  let organization;
  try {
    organization = await db.Organization.create(payload);
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'organizations',
    recordId: organization.id,
    event: 'create',
    after: snapshot(organization),
  });

  /*
   * Nothing can be cached for an id that did not exist a moment ago, so this is not correcting a stale
   * entry — it is keeping the rule "every write invalidates" true without exceptions to remember.
   */
  await tenantService.invalidateOrganization(organization.id);

  return organization;
}

/**
 * Update an organization, recording which columns moved.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} payload  validated body, at least one key
 * @returns {Promise<object>}
 */
async function update(req, id, payload) {
  const organization = await findById(req.tenant, id);
  const before = snapshot(organization);

  try {
    await organization.update(payload);
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'organizations',
    recordId: organization.id,
    event: 'update',
    before,
    after: snapshot(organization),
  });

  await tenantService.invalidateOrganization(organization.id);

  return organization;
}

module.exports = { list, findById, create, update, scopeFor, SORTABLE };
