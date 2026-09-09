'use strict';

/**
 * School routes — mounted at `/api/v1/schools`, below the authentication and tenant boundary.
 *
 * ## One permission per operation, because SRS §9.2 lists them separately
 *
 * The source enumerates nine School Management operations, and `src/config/permissions.js` already
 * carries a key for each governed one. The mapping is deliberate and is the reason `status` is not an
 * editable field on PATCH:
 *
 * | SRS §9.2 operation          | FR            | Route                        | Permission                 |
 * |-----------------------------|---------------|------------------------------|----------------------------|
 * | Create School               | FR-SADMIN-002 | `POST /`                     | `schools.manage`           |
 * | Edit School                 | FR-SADMIN-003 | `PATCH /:id`                 | `schools.manage`           |
 * | View School                 | FR-SADMIN-004 | `GET /:id`, `GET /`          | `schools.view`             |
 * | Activate / Suspend School   | FR-SADMIN-005 | `POST /:id/activate`, `/suspend` | `schools.status`       |
 * | Delete / Archive School     | FR-SADMIN-006 | `DELETE /:id`, `POST /:id/archive` | `schools.archive`    |
 * | Assign / Change Principal   | FR-SADMIN-007 | `PUT /:id/principal`         | `schools.assign_principal` |
 * | View School Usage           | FR-SADMIN-008 | `GET /:id/usage`             | `schools.usage.view`       |
 *
 * An account holding `schools.manage` can therefore correct an address without being able to cut a
 * school's access off, which is the separation the permission catalogue was written for.
 *
 * ## Which routes require platform scope
 *
 * All nine operations in SRS §9.2 are actored **Super Admin**, so every *write* route carries
 * `requirePlatformScope()` in addition to its permission. The two conditions are independent on
 * purpose: permissions are database rows an administrator can grant, and a school's status, archival
 * and Principal are platform decisions that should not become grantable by adding a key to a role.
 *
 * The three *reads* deliberately do not carry it. `DEFAULT_ROLE_PERMISSIONS` gives
 * `organization_admin` both `schools.view` and `schools.usage.view`, so the seeded catalogue already
 * states that an organization admin may see its own schools and their usage; a scope guard here would
 * contradict the seed. Their confinement comes from `scopeFor()` instead, which narrows the query to
 * the caller's organization.
 *
 * ## Why the status changes are POST and the principal is PUT
 *
 * Activate, Suspend and Archive are *operations* with side effects beyond the row they touch (a cache
 * invalidation, and in the suspended case the end of every session's usefulness), so they are POSTs to
 * named sub-resources rather than a PATCH on a field. The principal assignment is a PUT because it is
 * idempotent — assigning the same Principal twice leaves the same single value in
 * `schools.principal_id` — and FR-SADMIN-007 treats assign and change as one operation.
 *
 * ## Route ordering
 *
 * The literal sub-paths are declared after `/:id`'s siblings but their own patterns (`/:id/activate`,
 * `/:id/usage`) cannot collide with `/:id`, because Express matches on the full path and `/:id` has one
 * segment. No ordering hazard here — noted so nobody reorders in search of one.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requirePlatformScope,
} = require('../../middlewares');

const controller = require('./schools.controller');
const { schemas } = require('./schools.validation');

const router = createRouter();

/* ─────────────────────────── FR-SADMIN-004 — View ─────────────────────────── */

router.get(
  '/',
  requirePermission('schools.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

/* ─────────────────────────── FR-SADMIN-002 — Create ────────────────────────── */

router.post(
  '/',
  requirePlatformScope(),
  requirePermission('schools.manage'),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'school', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id',
  requirePermission('schools.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

/* ─────────────────────────── FR-SADMIN-003 — Edit ──────────────────────────── */

router.patch(
  '/:id',
  requirePlatformScope(),
  requirePermission('schools.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'school', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

/* ──────────────────── FR-SADMIN-005 — Activate / Suspend ───────────────────── */

router.post(
  '/:id/activate',
  requirePlatformScope(),
  requirePermission('schools.status'),
  validate({ params: schemas.idParam, body: schemas.activate }),
  logActivity({ action: 'update', entityType: 'school', onlyOnSuccess: true }),
  asyncHandler(controller.activate)
);

router.post(
  '/:id/suspend',
  requirePlatformScope(),
  requirePermission('schools.status'),
  validate({ params: schemas.idParam, body: schemas.suspend }),
  logActivity({ action: 'update', entityType: 'school', onlyOnSuccess: true }),
  asyncHandler(controller.suspend)
);

/* ───────────────────── FR-SADMIN-006 — Delete / Archive ────────────────────── */

router.post(
  '/:id/archive',
  requirePlatformScope(),
  requirePermission('schools.archive'),
  validate({ params: schemas.idParam, body: schemas.archive }),
  logActivity({ action: 'update', entityType: 'school', onlyOnSuccess: true }),
  asyncHandler(controller.archive)
);

router.delete(
  '/:id',
  requirePlatformScope(),
  requirePermission('schools.archive'),
  validate({ params: schemas.idParam }),
  logActivity({ action: 'delete', entityType: 'school', onlyOnSuccess: true }),
  asyncHandler(controller.destroy)
);

/* ────────────────── FR-SADMIN-007 — Assign / Change Principal ──────────────── */

router.put(
  '/:id/principal',
  requirePlatformScope(),
  requirePermission('schools.assign_principal'),
  validate({ params: schemas.idParam, body: schemas.assignPrincipal }),
  logActivity({ action: 'update', entityType: 'school', onlyOnSuccess: true }),
  asyncHandler(controller.assignPrincipal)
);

/* ───────────────────────── FR-SADMIN-008 — Usage ──────────────────────────── */

router.get(
  '/:id/usage',
  requirePermission('schools.usage.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.usage)
);

module.exports = router;
