'use strict';

/**
 * Parent routes — mounted at `/api/v1/parents`.
 *
 * | SRS   | FR             | Route                        | Permission              |
 * |-------|----------------|------------------------------|-------------------------|
 * | §15.2 | FR-PARENT-001  | `GET /`, `GET /:id`          | `parents.view`          |
 * | §15.2 | FR-PARENT-002  | `GET /dashboard`             | `parents.dashboard.view`|
 * | §15.2 | FR-PARENT-001  | `POST /`, `PATCH /:id`       | `parents.manage`        |
 * | §15.2 | FR-PARENT-001  | `GET /:id/children`          | `parents.view`          |
 * | §15.2 | FR-PARENT-001  | `POST /:id/children`         | `parents.manage`        |
 * | §15.2 | FR-PARENT-001  | `DELETE /:id/children/:linkId` | `parents.manage`      |
 *
 * `requireModule(MODULES.PARENT_PORTAL)` is mounted router-level. The `parents.*` keys carry that
 * module binding, but the field is metadata that nothing in the request path reads, so the guard has
 * to be explicit — the same reasoning as `teachers/` and `students/`.
 *
 * **No `enforceLimit`, and that is checked rather than assumed.** SRS §11.2 fixes eight plan limits
 * and none of them counts parents; `usageService.HEADCOUNT_SOURCES` has entries for students,
 * teachers, staff and admins only. `admin_limit` counts users whose role is in `SCHOOL_ADMIN_ROLES`
 * (`principal`, `school_admin`), and a parent account is neither — so creating one consumes no
 * allowance. Inventing a `parent_limit` would be a ninth limit the source does not define.
 *
 * `GET /dashboard` is declared **before** `GET /:id` so Express cannot read the literal as an id. It
 * is the one route whose actor is the parent rather than the office, and it resolves the record from
 * `req.user.id` rather than from the path — `parents.dashboard.view` is a key every parent holds, so
 * a path id would let one parent read another's children.
 *
 * No DELETE on a parent: §15.2 names none. A parent who leaves is deactivated through `PATCH`
 * (`is_active: false`) — and here that **also disables the account**, which is where this module
 * differs from the same-looking sentence in `teachers/`. That module never creates a login, so it has
 * none to revoke; this one does, and a profile flag that left `users.status` at `active` would have
 * been a revocation in name only: the parent would keep signing in and keep reading their children
 * through the dashboard. `parents.service.update()` moves both rows in one transaction.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireModule,
} = require('../../middlewares');
const { MODULES } = require('../../config/constants');

const controller = require('./parents.controller');
const { schemas } = require('./parents.validation');

const router = createRouter();

router.use(requireModule(MODULES.PARENT_PORTAL));

router.get(
  '/',
  requirePermission('parents.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

router.get(
  '/dashboard',
  requirePermission('parents.dashboard.view'),
  validate({ query: schemas.showQuery }),
  asyncHandler(controller.dashboard)
);

router.post(
  '/',
  requirePermission('parents.manage'),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'parent', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id/children',
  requirePermission('parents.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.listChildren)
);

router.post(
  '/:id/children',
  requirePermission('parents.manage'),
  validate({ params: schemas.idParam, body: schemas.linkChild }),
  logActivity({ action: 'create', entityType: 'parent_student', onlyOnSuccess: true }),
  asyncHandler(controller.linkChild)
);

router.delete(
  '/:id/children/:linkId',
  requirePermission('parents.manage'),
  validate({ params: schemas.linkParams }),
  logActivity({ action: 'delete', entityType: 'parent_student', onlyOnSuccess: true }),
  asyncHandler(controller.unlinkChild)
);

router.get(
  '/:id',
  requirePermission('parents.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  requirePermission('parents.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'parent', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

module.exports = router;
