'use strict';

/**
 * Principal routes — mounted at `/api/v1/principals`.
 *
 * ## Scope of this module
 *
 * SRS §9.3 and FR-SADMIN-009 specify Principal **creation** and nothing else, and §33 lists
 * "Principals" as a Super Admin MVP screen. So this module carries three routes:
 *
 *  - `POST /` — FR-SADMIN-009 verbatim.
 *  - `GET /` — the list. Not decorative: FR-SADMIN-007 says *"Super Admin selects a Principal for the
 *    school"*, which cannot be performed without seeing which Principals exist, and `?school_id=`
 *    narrows it to the candidates the assignment screen may actually choose from.
 *  - `GET /:id` — one record, for the detail view behind that list.
 *
 * There is deliberately **no PATCH and no DELETE here.** §33 lists "Users" as a separate screen, and
 * editing, deactivating or deleting an account is that module's operation on any user, not a second
 * implementation of it for one role. Duplicating it would leave two places that decide what may change
 * on a `users` row — and they would diverge.
 *
 * ## Guards
 *
 * The permission is `users.manage` / `users.view` rather than a Principal-specific key, because
 * `src/config/permissions.js` has no such key and SRS §35/§36 forbid inventing one. `organization_admin`
 * holds `users.view`, which is why the reads carry no `requirePlatformScope()`; the list is confined to
 * the caller's organization by `tenantWhere()` in the service instead. Creation is Super Admin's
 * (FR-SADMIN-009's actor) and carries both guards.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requirePlatformScope,
} = require('../../middlewares');

const controller = require('./principals.controller');
const { schemas } = require('./principals.validation');

const router = createRouter();

router.get(
  '/',
  requirePermission('users.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

router.post(
  '/',
  requirePlatformScope(),
  requirePermission('users.manage'),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'user', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id',
  requirePermission('users.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

module.exports = router;
