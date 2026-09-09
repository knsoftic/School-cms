'use strict';

/**
 * Role- and permission-based access control — SRS §7 FR-AUTH-008 (role middleware) and
 * FR-AUTH-009 (permission middleware), over §29's `roles` / `permissions` / `role_permissions`.
 *
 * Two independent guards, both declarative on the route:
 *
 *   requireRole(ROLES.PRINCIPAL, ROLES.SCHOOL_ADMIN)   — who you are
 *   requirePermission('students.create')               — what you may do
 *
 * Permissions are the primary mechanism: §29 gives grants their own table rather than fixing them in
 * the role row, so a grant can be moved between roles at runtime (`PUT /roles/:id/permissions`) and a
 * route keyed to a role slug would ignore that. `requireRole` is for the cases where the *identity* of
 * the caller is the rule and no permission key expresses it — a platform-only endpoint, or a route that
 * must never be delegated regardless of what the grant table says.
 *
 * ## What these guards deliberately do not do
 *
 * They do not answer "is this record mine?". The catalogue has `students.self.view`,
 * `attendance.self.view`, `fees.self.view` and `results.self.view` (SRS §5: a student "has access
 * relevant to their own records within their school"), and holding one of those keys is necessary
 * but not sufficient — something still has to compare the record's student id to the caller's own
 * profile. That comparison depends on the route's data model, so it belongs to the module's service
 * layer. These middlewares gate the door; the service checks the name on the parcel.
 *
 * ## Typos fail at boot
 *
 * Every role slug and permission key named in a route is validated when the route is defined. A
 * mistyped guard would otherwise deny every caller forever and look exactly like a permissions-data
 * problem.
 */

const { annotate } = require('../utils/routeMeta');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('./asyncHandler');
const logger = require('../config/logger');
const permissionService = require('../services/permissionService');
const { ROLE_LIST } = require('../config/constants');

/** Shared precondition: these guards are meaningless without `authenticate` ahead of them. */
function assertAuthenticated(req, guard) {
  if (!req.user || typeof req.getPermissions !== 'function') {
    logger.error(`${guard} ran without an authenticated user`, {
      requestId: req.id,
      path: req.originalUrl,
    });
    throw ApiError.internal();
  }
}

/**
 * Restrict a route to specific roles — FR-AUTH-008.
 *
 * @param {...string} slugs  role slugs from `constants.ROLES`
 * @returns {import('express').RequestHandler}
 */
function requireRole(...slugs) {
  const allowed = slugs.flat();

  if (!allowed.length) {
    throw new Error('requireRole() requires at least one role slug');
  }

  const unknown = allowed.filter((slug) => !ROLE_LIST.includes(slug));
  if (unknown.length) {
    throw new Error(
      `requireRole(): unknown role slug(s) ${unknown.join(', ')}. ` +
        `Valid slugs are ${ROLE_LIST.join(', ')} (SRS §5).`
    );
  }

  const allowedSet = new Set(allowed);

  const documented = function roleGuard(req, res, next) {
    try {
      assertAuthenticated(req, 'requireRole');
    } catch (err) {
      return next(err);
    }

    /*
     * The role comes from the freshly loaded `users` row, not from the token's `role` claim. A role
     * reassignment has to take effect on the next request — see permissionService for the reasoning.
     */
    const roleSlug = req.user.role.slug;
    if (!allowedSet.has(roleSlug)) {
      return next(
        ApiError.forbidden('Your role does not have access to this resource.', {
          code: 'INSUFFICIENT_ROLE',
          details: { requiredRoles: allowed },
        })
      );
    }

    return next();
  };

  /* The role slugs this guard was built from. See utils/routeMeta.js. */
  return annotate(documented, { roles: allowed });
}

/**
 * Build a permission guard.
 *
 * @param {string[]} keys
 * @param {'all'|'any'} mode
 * @param {string} guardName  used in boot-time errors
 */
function buildPermissionGuard(keys, mode, guardName) {
  const required = keys.flat();

  if (!required.length) {
    throw new Error(`${guardName}() requires at least one permission key`);
  }

  permissionService.assertKnownPermissionKeys(required, guardName);

  const documented = asyncHandler(async (req, res, next) => {
    assertAuthenticated(req, guardName);

    const held = await req.getPermissions();
    const missing = required.filter((key) => !held.has(key));
    const satisfied = mode === 'all' ? missing.length === 0 : missing.length < required.length;

    if (!satisfied) {
      /*
       * The required keys are returned. They are not a secret — `GET /users/permissions` publishes the
       * whole catalogue to any caller who can manage users, and every caller can already read their own
       * effective set from `/auth/me` — and naming them lets the frontend explain the refusal instead of
       * showing a bare "Forbidden".
       */
      return next(
        ApiError.forbidden('You do not have permission to perform this action.', {
          code: 'INSUFFICIENT_PERMISSION',
          details: mode === 'all' ? { required, missing } : { requiredAnyOf: required },
        })
      );
    }

    return next();
  });

  /* The keys this guard was built from, for the OpenAPI document. See utils/routeMeta.js. */
  return annotate(documented, { permissions: required, permissionMode: mode });
}

/**
 * Require every listed permission — FR-AUTH-009.
 *
 * @param {...string} keys  permission keys from `config/permissions.js`
 * @returns {import('express').RequestHandler}
 */
function requirePermission(...keys) {
  return buildPermissionGuard(keys, 'all', 'requirePermission');
}

/**
 * Require at least one of the listed permissions.
 *
 * The case this exists for: an endpoint reachable either by someone with the full grant or by
 * someone with the self-scoped variant — `requireAnyPermission('students.view',
 * 'students.self.view')` — where the service then narrows the query for the second kind of caller.
 *
 * @param {...string} keys
 * @returns {import('express').RequestHandler}
 */
function requireAnyPermission(...keys) {
  return buildPermissionGuard(keys, 'any', 'requireAnyPermission');
}

/** Explicit alias for `requirePermission`, for routes where reading "all" aloud helps. */
function requireAllPermissions(...keys) {
  return buildPermissionGuard(keys, 'all', 'requireAllPermissions');
}

/**
 * Restrict a route to the platform scope.
 *
 * Equivalent to `requireRole(ROLES.SUPER_ADMIN)` but expressed against the tenant scope that
 * `resolveTenant` produced, so it stays correct if the SRS's single platform role ever becomes two.
 *
 * @returns {import('express').RequestHandler}
 */
function requirePlatformScope() {
  return function platformGuard(req, res, next) {
    if (!req.tenant) {
      logger.error('requirePlatformScope ran without a resolved tenant', {
        requestId: req.id,
        path: req.originalUrl,
      });
      return next(ApiError.internal());
    }

    if (!req.tenant.isPlatform) {
      return next(
        ApiError.forbidden('This endpoint is restricted to platform administrators.', {
          code: 'PLATFORM_SCOPE_REQUIRED',
        })
      );
    }

    return next();
  };
}

module.exports = {
  requireRole,
  requirePermission,
  requireAnyPermission,
  requireAllPermissions,
  requirePlatformScope,
};
