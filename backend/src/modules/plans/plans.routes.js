'use strict';

/**
 * Plan routes — mounted at `/api/v1/plans`, below the authentication and tenant boundary.
 *
 * ## One permission per SRS §10 / §11 operation
 *
 * `config/permissions.js` already carries five `plans.*` keys, granted to `super_admin` alone. The
 * split is not decorative: configuring a plan's *limits* changes what every school on that plan may do
 * tomorrow, while editing its *description* changes a sentence, and the catalogue separates them so a
 * future delegated role can be given one without the other.
 *
 * | SRS         | FR         | Route                                        | Permission             |
 * |-------------|------------|----------------------------------------------|------------------------|
 * | §10.2, §11  | —          | `GET /catalogue`                             | `plans.view`           |
 * | §10.2       | FR-SUB-002 | `GET /`, `GET /:id`                          | `plans.view`           |
 * | §10.2       | FR-SUB-001 | `POST /`                                     | `plans.manage`         |
 * | §10.2       | FR-SUB-002 | `PATCH /:id`                                 | `plans.manage`         |
 * | §10.2       | FR-SUB-003 | `POST /:id/duplicate`                        | `plans.manage`         |
 * | §10.2       | FR-SUB-004 | `POST /:id/activate`, `POST /:id/deactivate` | `plans.manage`         |
 * | §10.2       | FR-SUB-005 | `POST /:id/archive`                          | `plans.manage`         |
 * | §10.3, §10.4| FR-SUB-006 | `PUT /:id/prices`                            | `plans.pricing.manage` |
 * | §11.1       | FR-SUB-007 | `PUT /:id/modules`, `PUT /:id/features`      | `plans.modules.manage` |
 * | §11.2       | FR-SUB-007 | `PUT /:id/limits`                            | `plans.limits.manage`  |
 *
 * FR-SUB-004 and FR-SUB-005 share `plans.manage` rather than getting a `plans.status` key of their own,
 * unlike `/schools`. The reason is the blast radius, which is the opposite way round: suspending a
 * school cuts one tenant off immediately, so it was worth separating from routine edits; deactivating a
 * plan changes only what appears in the catalogue for *new* subscriptions and interrupts nobody. Adding
 * a key not present in `config/permissions.js` would also mean inventing one, which SRS §33's fixed
 * catalogue does not invite.
 *
 * ## Every write requires platform scope
 *
 * SRS §10 and §11 are inside the Super Admin panel and actor every operation to the Super Admin, and
 * `subscription_plans` has no `school_id` — a plan row is offered to the whole platform, so editing one
 * is a cross-tenant write of the same kind `roles.service.js` describes. Two independent conditions
 * therefore guard each write: `requirePlatformScope()`, which no role grant can satisfy, and the
 * permission key, which is a database row. Neither alone is enough.
 *
 * The reads carry no scope guard, deliberately. `plans.view` is granted to `super_admin` only today, so
 * nothing changes in practice — but SRS §12.3 has a school choosing an upgrade target, which needs a
 * readable catalogue, and `plans.service.scopeFor()` already confines a non-platform caller to the
 * active public plans. Putting the confinement there rather than in a scope guard means granting
 * `plans.view` to a Principal later is a seed change, not a routing change.
 *
 * ## Why there is no `DELETE /:id`
 *
 * FR-SUB-005 Archive is the source's removal operation and is explicit that an archived plan is
 * *"retained for historical reference"*. `subscriptions.plan_id` is `RESTRICT` besides, so the row
 * cannot leave once any school has subscribed. `plans.service.js` records the full reasoning.
 *
 * ## Route ordering
 *
 * `GET /catalogue` is declared **before** `GET /:id`. Both are one-segment GETs, so Express would match
 * `/catalogue` against `/:id` first if the order were reversed and the request would fail validation as
 * a non-numeric id. This is the one ordering hazard in the file.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requirePlatformScope,
} = require('../../middlewares');

const controller = require('./plans.controller');
const { schemas } = require('./plans.validation');

const router = createRouter();

/* ────────────────────── Reads — SRS §10.2, §11 (the Plan Builder) ───────────────────── */

/* Declared first: see the route-ordering note in the header. */
router.get('/catalogue', requirePermission('plans.view'), asyncHandler(controller.catalogue));

router.get(
  '/',
  requirePermission('plans.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

/* ────────────────────────── FR-SUB-001 — Create Plan ────────────────────────── */

router.post(
  '/',
  requirePlatformScope(),
  requirePermission('plans.manage'),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'plan', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id',
  requirePermission('plans.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

/* ─────────────────────────── FR-SUB-002 — Edit Plan ─────────────────────────── */

router.patch(
  '/:id',
  requirePlatformScope(),
  requirePermission('plans.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'plan', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

/* ───────────────────────── FR-SUB-003 — Duplicate Plan ──────────────────────── */

router.post(
  '/:id/duplicate',
  requirePlatformScope(),
  requirePermission('plans.manage'),
  validate({ params: schemas.idParam, body: schemas.duplicate }),
  logActivity({ action: 'create', entityType: 'plan', onlyOnSuccess: true }),
  asyncHandler(controller.duplicate)
);

/* ──────────────────── FR-SUB-004 — Activate / Deactivate Plan ───────────────── */

router.post(
  '/:id/activate',
  requirePlatformScope(),
  requirePermission('plans.manage'),
  validate({ params: schemas.idParam, body: schemas.activate }),
  logActivity({ action: 'update', entityType: 'plan', onlyOnSuccess: true }),
  asyncHandler(controller.activate)
);

router.post(
  '/:id/deactivate',
  requirePlatformScope(),
  requirePermission('plans.manage'),
  validate({ params: schemas.idParam, body: schemas.deactivate }),
  logActivity({ action: 'update', entityType: 'plan', onlyOnSuccess: true }),
  asyncHandler(controller.deactivate)
);

/* ────────────────────────── FR-SUB-005 — Archive Plan ───────────────────────── */

router.post(
  '/:id/archive',
  requirePlatformScope(),
  requirePermission('plans.manage'),
  validate({ params: schemas.idParam, body: schemas.archive }),
  logActivity({ action: 'update', entityType: 'plan', onlyOnSuccess: true }),
  asyncHandler(controller.archive)
);

/* ───────── FR-SUB-006 — Configure Plan Pricing & Billing Cycle (§10.3, §10.4) ───────── */

/*
 * PUT, not POST: the body is the plan's complete price set, so sending it twice leaves the same set —
 * the definition of idempotent. `plans.validation.js` explains why it is a whole set rather than a
 * delta, and `plans.service.setPrices()` explains what happens to a price row still in use.
 */
router.put(
  '/:id/prices',
  requirePlatformScope(),
  requirePermission('plans.pricing.manage'),
  validate({ params: schemas.idParam, body: schemas.setPrices }),
  logActivity({ action: 'update', entityType: 'plan', onlyOnSuccess: true }),
  asyncHandler(controller.setPrices)
);

/* ───────── FR-SUB-007 — Assign Modules, Features & Limits (§11.1, §11.2) ───────── */

router.put(
  '/:id/modules',
  requirePlatformScope(),
  requirePermission('plans.modules.manage'),
  validate({ params: schemas.idParam, body: schemas.setModules }),
  logActivity({ action: 'update', entityType: 'plan', onlyOnSuccess: true }),
  asyncHandler(controller.setModules)
);

router.put(
  '/:id/features',
  requirePlatformScope(),
  requirePermission('plans.modules.manage'),
  validate({ params: schemas.idParam, body: schemas.setFeatures }),
  logActivity({ action: 'update', entityType: 'plan', onlyOnSuccess: true }),
  asyncHandler(controller.setFeatures)
);

router.put(
  '/:id/limits',
  requirePlatformScope(),
  requirePermission('plans.limits.manage'),
  validate({ params: schemas.idParam, body: schemas.setLimits }),
  logActivity({ action: 'update', entityType: 'plan', onlyOnSuccess: true }),
  asyncHandler(controller.setLimits)
);

module.exports = router;
