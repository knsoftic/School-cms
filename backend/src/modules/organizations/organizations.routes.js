'use strict';

/**
 * Organization routes — mounted at `/api/v1/organizations`, below the authentication and tenant
 * boundary in `buildApiRouter()`.
 *
 * ## Guard order
 *
 * The order is the one the middleware barrel records: authorization, then `validate`, then
 * `logActivity`, then the handler. It is not cosmetic — validating before authorizing would let an
 * unauthorised caller learn the shape of a schema they may not use, and declaring the activity row
 * before validation would file a row for a request that never reached the handler.
 *
 * ## Why writes also carry `requirePlatformScope()`
 *
 * Only `super_admin` holds `organizations.manage` in `DEFAULT_ROLE_PERMISSIONS` today, so the scope
 * guard is currently redundant with the permission guard. It is here for the day it is not: roles are
 * database rows and an administrator can grant that key to an organization-level role, at which point
 * the permission check alone would let an organization admin create sibling organizations. Two
 * independent conditions, one of them structural.
 *
 * ## Why reads are not logged
 *
 * `activityLog.js` argues the case in its header: FR-LOG-001 asks for *actions*, and a row per read
 * would bury a day's real events under dashboard polls. Creates and updates are declared; list and
 * show are not. A refused cross-tenant read is still recorded, because `enforceTenant` sets
 * `req.tenantViolation` and `activityAudit` files that row whether or not the route asked.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requirePlatformScope,
} = require('../../middlewares');

const controller = require('./organizations.controller');
const { schemas } = require('./organizations.validation');

const router = createRouter();

router.get(
  '/',
  requirePermission('organizations.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

router.post(
  '/',
  requirePlatformScope(),
  requirePermission('organizations.manage'),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'organization', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id',
  requirePermission('organizations.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  requirePlatformScope(),
  requirePermission('organizations.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'organization', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

module.exports = router;
