'use strict';

/**
 * Role routes — mounted at `/api/v1/roles`.
 *
 * ## Scope
 *
 * SRS §29 fixes `roles`, `permissions` and `role_permissions`; FR-AUTH-008 and FR-AUTH-009 require
 * middleware that checks a request against a role and its granted permissions. Data those two read has
 * to be settable, which is what this module is for. §33 lists no "Roles & Permissions" screen — see
 * `roles.validation.js` — so the surface is kept to what §29 and FR-AUTH-009 support:
 *
 *  - `GET /`                  §5's eleven, each with a permission count and a tenant-scoped user count.
 *  - `GET /:id`               one role and its grant set.
 *  - `PATCH /:id`             `name` and `description` only.
 *  - `PUT /:id/permissions`   replace the grant set.
 *
 * There is no `POST /` and no `DELETE /:id`: SRS §5 says the system defines *exactly* eleven roles,
 * `roles.slug` validates against `ROLE_LIST`, and §35 names "Additional roles" first among the things
 * not to invent.
 *
 * ## The reads and the writes are guarded differently, on purpose
 *
 * **Reads** take `requireAnyPermission('users.view', 'roles.view')`. Only `super_admin` holds
 * `roles.view`, but the users module accepts `?role=<slug>` as a filter and its detail view shows a
 * teacher's role grant beside their overrides — a Principal cannot use either without knowing which
 * roles exist and what each one grants. Nothing here is tenant data: §5's role list is a fixed property
 * of the product, and the one figure that *would* have been tenant data — `userCount` — is scoped by
 * `tenantWhere()` in the service.
 *
 * **Writes** take `requirePlatformScope()` *and* `roles.manage`. `role_permissions` has no `school_id`,
 * so editing the `teacher` role changes every teacher in every school; that is a cross-tenant write and
 * SRS §30 Rule 2 puts it above the school boundary. `config/permissions.js` grants `roles.manage` to
 * `super_admin` alone, so the scope guard is redundant today — deliberately, in the same way `/schools`
 * doubles up its checks: neither is load-bearing alone, and a future grant edit cannot quietly turn a
 * platform-wide write into something a Principal can reach.
 *
 * A Principal who needs one teacher to have one extra permission uses `PUT /users/:id/permissions`,
 * which writes a tenant-scoped `users` row and is bounded to permissions the caller holds themselves.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireAnyPermission,
  requirePlatformScope,
} = require('../../middlewares');

const controller = require('./roles.controller');
const { schemas } = require('./roles.validation');

const router = createRouter();

router.get('/', requireAnyPermission('users.view', 'roles.view'), asyncHandler(controller.list));

router.get(
  '/:id',
  requireAnyPermission('users.view', 'roles.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  requirePlatformScope(),
  requirePermission('roles.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'role', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

/* ─────────── FR-AUTH-009's data — platform-wide, hence platform-only ─────────── */

router.put(
  '/:id/permissions',
  requirePlatformScope(),
  requirePermission('roles.manage'),
  validate({ params: schemas.idParam, body: schemas.setPermissions }),
  logActivity({ action: 'update', entityType: 'role', onlyOnSuccess: true }),
  asyncHandler(controller.setPermissions)
);

module.exports = router;
