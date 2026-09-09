'use strict';

/**
 * Add-on routes — mounted at `/api/v1/addons`, below the authentication and tenant boundary.
 *
 * ## FR-SUB-009, and only FR-SUB-009
 *
 * `config/permissions.js` carries exactly two `addons.*` keys, both granted to `super_admin` alone:
 *
 * | SRS   | FR         | Route                                                     | Permission      |
 * |-------|------------|-----------------------------------------------------------|-----------------|
 * | §11.3 | FR-SUB-009 | `GET /`, `GET /:id`                                       | `addons.view`   |
 * | §11.3 | FR-SUB-009 | `PATCH /:id`                                              | `addons.manage` |
 * | §11.3 | FR-SUB-009 | `POST /:id/activate`, `POST /:id/deactivate`              | `addons.manage` |
 * | §11.3 | FR-SUB-009 | `PUT /:id/prices`                                         | `addons.manage` |
 *
 * The pricing route is **not** split onto `plans.pricing.manage`'s equivalent, because no such key
 * exists: the catalogue has two add-on keys and inventing an `addons.pricing.manage` would be inventing
 * a requirement (SRS §35). The whole of FR-SUB-009 is one operator's job in the source.
 *
 * ## No `POST /` and no `DELETE /:id`
 *
 * SRS §11.3 names seven add-ons; `addons.key` is unique and validated `isIn: [ADDON_LIST]`, so an eighth
 * row cannot exist and a create endpoint would have nothing to create. Removal is refused from the other
 * side: `subscription_addons.addon_id` is `ON DELETE RESTRICT`, so a purchased add-on cannot leave the
 * table, and `POST /:id/deactivate` is the source's own way of taking one off sale. `addons.service.js`
 * records the full reasoning.
 *
 * This is the same shape `/plans` has for a different reason — there, archival is retention; here, the
 * row set itself is fixed data.
 *
 * ## Writes require platform scope; reads do not
 *
 * `addons` has no `school_id`, so editing a row changes what every school is offered — a cross-tenant
 * write, guarded by `requirePlatformScope()` *and* the permission key, neither sufficient alone.
 *
 * The reads carry no scope guard, and here that is not merely forward-looking as it is on `/plans`:
 * FR-SUB-009's **Description** reads *"Super Admin and/or school configure add-ons"* (SRS:521) while
 * its Actor / Role line reads only *"Super Admin"* (SRS:522), so a school seeing what it can buy is
 * squarely in the source. `addons.service.scopeFor()` confines a non-platform caller to the active
 * add-ons and their active prices, which means granting `addons.view` to a Principal later is a seed
 * change rather than a routing change.
 *
 * There is no route-ordering hazard in this file: every one-segment route is `/:id`.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requirePlatformScope,
} = require('../../middlewares');

const controller = require('./addons.controller');
const { schemas } = require('./addons.validation');

const router = createRouter();

/* ────────────────────────── Reads — SRS §11.3 catalogue ───────────────────────── */

router.get(
  '/',
  requirePermission('addons.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

router.get(
  '/:id',
  requirePermission('addons.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

/* ───────────────────── FR-SUB-009 — configure an add-on ──────────────────── */

router.patch(
  '/:id',
  requirePlatformScope(),
  requirePermission('addons.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'addon', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

/* ─────────────── FR-SUB-009 — take an add-on on and off sale ─────────────── */

router.post(
  '/:id/activate',
  requirePlatformScope(),
  requirePermission('addons.manage'),
  validate({ params: schemas.idParam, body: schemas.activate }),
  logActivity({ action: 'update', entityType: 'addon', onlyOnSuccess: true }),
  asyncHandler(controller.activate)
);

router.post(
  '/:id/deactivate',
  requirePlatformScope(),
  requirePermission('addons.manage'),
  validate({ params: schemas.idParam, body: schemas.deactivate }),
  logActivity({ action: 'update', entityType: 'addon', onlyOnSuccess: true }),
  asyncHandler(controller.deactivate)
);

/* ──────────────────── FR-SUB-009 — what an add-on costs ─────────────────── */

/*
 * PUT, not POST, for the reason `PUT /plans/:id/prices` gives: the body is the add-on's complete price
 * set, so sending it twice leaves the same set. `addons.validation.js` explains why it is a whole set
 * rather than a delta, and `addons.service.setPrices()` explains what happens to a price row a purchase
 * still points at.
 */
router.put(
  '/:id/prices',
  requirePlatformScope(),
  requirePermission('addons.manage'),
  validate({ params: schemas.idParam, body: schemas.setPrices }),
  logActivity({ action: 'update', entityType: 'addon', onlyOnSuccess: true }),
  asyncHandler(controller.setPrices)
);

module.exports = router;
