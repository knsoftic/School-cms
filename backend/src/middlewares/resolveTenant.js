'use strict';

/**
 * Tenant resolution — SRS §8 FR-TENANT-001/002, §30 Rule 2. Layer 2 of the four isolation layers
 * described in ARCHITECTURE §3.
 *
 * Answers one question: which organization and which school is this request confined to? The scope
 * is derived from the authenticated user row and nothing else. No header, route parameter, query
 * string or body field contributes to it — that asymmetry is the whole point. Layer 3
 * (`enforceTenant`) compares client-supplied ids *against* this answer; if the client could
 * influence the answer itself, the comparison would be worthless.
 *
 * ## Three scopes
 *
 *   platform      Super Admin. No organization, no school. `tenantWhere` leaves queries unscoped.
 *   organization  Organization Admin. Confined to one `organization_id`.
 *   school        Every other role. Confined to one `school_id`.
 *
 * `PLATFORM_ROLES` contains only `super_admin`, while the `roles` table also has
 * `is_platform_role = 1` for `organization_admin`. Those two flags mean different things and are
 * deliberately not conflated: the column marks a role that operates *above a single school*, and
 * the constant marks a role that operates *above every organization*. Only the latter may read
 * across tenants, so the constant is what is checked here.
 *
 * ## Fail closed
 *
 * A school-level user whose `school_id` is null gets 403, not an unscoped session. The same
 * situation would make `tenantWhere` throw one layer deeper; refusing here turns a 500 into an
 * accurate 403 and keeps the reason in one place.
 *
 * ## Suspended and archived tenants
 *
 * FR-SADMIN-005 says "suspended schools' access is restricted", and FR-SADMIN-006 adds archiving.
 * Both are enforced for organization- and school-scoped callers. The Super Admin is exempt because
 * FR-SADMIN-005 makes them the actor who reverses a suspension — locking them out of a suspended
 * school would make the state unrecoverable.
 */

const ApiError = require('../utils/ApiError');
const asyncHandler = require('./asyncHandler');
const logger = require('../config/logger');
const tenantService = require('../services/tenantService');
const {
  PLATFORM_ROLES,
  ROLES,
  SCHOOL_STATUS,
  ORGANIZATION_STATUS,
} = require('../config/constants');

/** Roles confined to an organization rather than to a single school. */
const ORGANIZATION_SCOPED_ROLES = [ROLES.ORGANIZATION_ADMIN];

/** Why a tenant was refused, keyed by the tenant's own status. */
const TENANT_REFUSALS = {
  [SCHOOL_STATUS.SUSPENDED]: {
    code: 'SCHOOL_SUSPENDED',
    message: 'This school has been suspended. Contact the platform administrator.',
  },
  [SCHOOL_STATUS.ARCHIVED]: {
    code: 'SCHOOL_ARCHIVED',
    message: 'This school has been archived and is no longer accessible.',
  },
};

const ORGANIZATION_REFUSALS = {
  [ORGANIZATION_STATUS.SUSPENDED]: {
    code: 'ORGANIZATION_SUSPENDED',
    message: 'This organization has been suspended. Contact the platform administrator.',
  },
  [ORGANIZATION_STATUS.ARCHIVED]: {
    code: 'ORGANIZATION_ARCHIVED',
    message: 'This organization has been archived and is no longer accessible.',
  },
};

/**
 * @typedef {object} TenantScope
 * @property {boolean} isPlatform      may read across every tenant
 * @property {number|null} organizationId
 * @property {number|null} schoolId
 * @property {'platform'|'organization'|'school'} level
 * @property {string} roleSlug
 */

/**
 * Populate `req.tenant`.
 *
 * @type {import('express').RequestHandler}
 */
const resolveTenant = asyncHandler(async (req, res, next) => {
  if (!req.user || !req.user.role) {
    /*
     * Not a client error: it means `resolveTenant` was mounted before `authenticate`. Surfacing it
     * as a 500 with a log line is correct — a wiring mistake here would otherwise present as a
     * confusing 403 and could hide the fact that no authentication ran at all.
     */
    logger.error('resolveTenant ran without an authenticated user', {
      requestId: req.id,
      path: req.originalUrl,
    });
    throw ApiError.internal();
  }

  const roleSlug = req.user.role.slug;

  /* ---- Platform scope ---------------------------------------------------------------- */

  if (PLATFORM_ROLES.includes(roleSlug)) {
    req.tenant = {
      isPlatform: true,
      organizationId: null,
      schoolId: null,
      level: 'platform',
      roleSlug,
    };
    return next();
  }

  /* ---- Organization scope ------------------------------------------------------------ */

  if (ORGANIZATION_SCOPED_ROLES.includes(roleSlug)) {
    const organizationId = req.user.organization_id;
    if (!organizationId) {
      throw ApiError.forbidden('This account is not linked to an organization.', {
        code: 'TENANT_UNRESOLVED',
      });
    }

    const organization = await tenantService.getOrganization(organizationId);
    if (!organization) {
      logger.error('Organization-scoped user references a missing organization', {
        requestId: req.id,
        userId: req.user.id,
        organizationId,
      });
      throw ApiError.forbidden('This account is not linked to an organization.', {
        code: 'TENANT_UNRESOLVED',
      });
    }

    const refusal = ORGANIZATION_REFUSALS[organization.status];
    if (refusal) throw ApiError.forbidden(refusal.message, { code: refusal.code });

    /*
     * An organization-level user is not expected to carry `school_id`, but if the row has one it is
     * honoured. `tenantWhere` gives an explicit school precedence over an organization, so the
     * effect is to narrow this session to that school — never to widen it past the organization.
     */
    req.tenant = {
      isPlatform: false,
      organizationId,
      schoolId: req.user.school_id || null,
      level: 'organization',
      roleSlug,
    };
    return next();
  }

  /* ---- School scope ----------------------------------------------------------------- */

  const schoolId = req.user.school_id;
  if (!schoolId) {
    throw ApiError.forbidden('This account is not assigned to a school.', {
      code: 'TENANT_UNRESOLVED',
    });
  }

  const school = await tenantService.getSchool(schoolId);
  if (!school) {
    logger.error('School-scoped user references a missing school', {
      requestId: req.id,
      userId: req.user.id,
      schoolId,
    });
    throw ApiError.forbidden('This account is not assigned to a school.', {
      code: 'TENANT_UNRESOLVED',
    });
  }

  const refusal = TENANT_REFUSALS[school.status];
  if (refusal) throw ApiError.forbidden(refusal.message, { code: refusal.code });

  /*
   * The school's organization is checked too. A school inside a suspended organization is
   * unreachable even while the school's own status still reads "active" — otherwise suspending an
   * organization would leave every school in it running.
   */
  const organizationId = school.organization_id || req.user.organization_id || null;
  if (organizationId) {
    const organization = await tenantService.getOrganization(organizationId);
    const organizationRefusal = organization && ORGANIZATION_REFUSALS[organization.status];
    if (organizationRefusal) {
      throw ApiError.forbidden(organizationRefusal.message, { code: organizationRefusal.code });
    }
  }

  /*
   * `organization_id` is taken from the school rather than the user row. The school is the
   * authority on which organization it belongs to, and preferring it means a stale
   * `users.organization_id` cannot widen a session.
   */
  req.tenant = {
    isPlatform: false,
    organizationId,
    schoolId: Number(schoolId),
    level: 'school',
    roleSlug,
  };
  return next();
});

module.exports = {
  resolveTenant,
  ORGANIZATION_SCOPED_ROLES,
  TENANT_REFUSALS,
  ORGANIZATION_REFUSALS,
};
