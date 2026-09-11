'use strict';

/**
 * Subscription routes — mounted at `/api/v1/subscriptions`, below the authentication and tenant
 * boundary.
 *
 * ## Route → FR → permission
 *
 * The permission column is not a design choice: `config/permissions.js` carries exactly six
 * `subscriptions.*` keys, and each route uses the one whose *name* describes it. Adding a seventh
 * would be inventing a permission, which SRS §35 forbids.
 *
 * | SRS   | FR         | Route                                       | Guard                                            |
 * |-------|------------|---------------------------------------------|--------------------------------------------------|
 * | §12   | —          | `GET /catalogue`                            | `view` \| `self.view`                            |
 * | §12   | FR-SUB-010 | `GET /`, `GET /:id`                         | `view` \| `self.view`                            |
 * | §12   | FR-SUB-010 | `GET /:id/history`                          | `view` \| `self.view`                            |
 * | §12   | FR-SUB-010 | `POST /`                                    | platform + `manage`                              |
 * | §12.1 | FR-SUB-011 | `PATCH /:id` (trial)                        | platform + `manage`                              |
 * | §12.2 | FR-SUB-012 | `PATCH /:id` (grace)                        | platform + `manage`                              |
 * | §12   | FR-SUB-010 | `POST /:id/activate` … `/cancel` (six)      | platform + `lifecycle`                           |
 * | §12.3 | FR-SUB-013 | `POST /:id/upgrade`                         | `lifecycle` \| `self.manage`                     |
 * | §12.4 | FR-SUB-014 | `POST /:id/downgrade`                       | `lifecycle` \| `self.manage`                     |
 * | §12.5 | FR-SUB-015 | `POST /:id/renew`                           | `lifecycle` \| `self.manage`                     |
 * | §11.3 | FR-SUB-009 | `POST /:id/addons`, `…/:addonId/cancel`     | `manage` \| `self.manage`                        |
 * | §33   | —          | `POST /:id/overrides`, `…/:overrideId/revoke`| platform + `overrides.manage`                    |
 *
 * ## Why three different guard shapes, and not one
 *
 * The shapes come from the SRS actor lines, read one requirement at a time.
 *
 * **`requirePlatformScope()` + a permission** is used wherever the actor line names the Super Admin
 * alone. FR-SUB-010 is *"System / Super Admin"*, FR-SUB-011 and FR-SUB-012 are *"Super Admin"*.
 * Creating a subscription is a cross-tenant write — the body names the `school_id` — and
 * `enforceTenant.checkReference()` returns early for a platform caller, which is exactly what makes
 * `POST /subscriptions { school_id }` legal for a Super Admin and impossible for anyone else. Two
 * independent conditions guard each of these: a scope no role grant can satisfy, and a permission
 * that is a database row.
 *
 * **`requireAnyPermission(a, b)`** is used wherever the actor line names *both*. FR-SUB-013,
 * FR-SUB-014 and FR-SUB-015 are *"Super Admin / School"* and FR-SUB-009's add-on purchase takes the same shape on the
 * strength of its **Description**, *"Super Admin and/or school configure add-ons"* (SRS:521) — NOT
 * its actor line, which one line below reads only *"Super Admin"* (SRS:522). That is triage finding
 * 53: the source contradicts itself one line apart, and this router follows the Description. The paired keys already exist for this: `subscriptions.self.manage` is
 * seeded to `principal` and `school_admin`, and if these routes required `subscriptions.lifecycle`
 * the key would be granted to two roles and reachable by none — a dead permission, which is a worse
 * outcome than either guard. The tenant boundary still holds, because `findById()` folds
 * `tenantWhere()` into its `where`: a school_admin calling `POST /subscriptions/99/upgrade` for
 * another school's subscription gets a 404, not a 403.
 *
 * **A permission alone, no scope guard**, for the reads. `subscriptions.self.view` is seeded to four
 * roles and the service confines every read by tenant, so the guard would refuse callers the source
 * intends to serve.
 *
 * ## Why cancel is platform-only when upgrade is not
 *
 * It looks inconsistent and it is deliberate. FR-SUB-013/014/015 name the School as an actor;
 * FR-SUB-010, which is where Cancel lives along with Activate, Suspend, Reactivate, Pause and
 * Resume, does not — its actor line is *"System / Super Admin"*. A school cancelling its own
 * subscription is a plausible product decision and it is not this document's. If self-service
 * cancellation is wanted later it is a one-word change to this file, made against a stated
 * requirement rather than against an inference.
 *
 * ## Why there is no `DELETE /:id` and no `POST /run-renewals`
 *
 * §12's terminal states are Cancelled and Expired, both of which keep the row: it is the school's
 * billing history, `subscription_items` point at it and §13's invoices will. `POST /:id/cancel` is
 * the source's removal operation.
 *
 * The date-driven half of FR-SUB-010 and FR-SUB-015's Automatic Renewal are implemented — as
 * `subscriptionsService.runLifecycleSweep()`, with no route. Their actor is the *system*: a
 * scheduler — the hourly `subscription-lifecycle` job in `src/jobs/` (`npm run cron`). Exposing the
 * sweep over HTTP as well would be inventing an endpoint the SRS does not describe.
 *
 * ## Route ordering
 *
 * `GET /catalogue` is declared **before** `GET /:id`. Both are one-segment GETs, so with the order
 * reversed Express would match `/catalogue` against `/:id` and the request would fail validation as
 * a non-numeric id. This is the one ordering hazard in the file — `/:id/history`, `/:id/addons` and
 * the rest are all longer paths and cannot collide.
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

const controller = require('./subscriptions.controller');
const { schemas } = require('./subscriptions.validation');

const router = createRouter();

/** The read guard, written once: see the header on why there is no scope guard beside it. */
const canRead = () => requireAnyPermission('subscriptions.view', 'subscriptions.self.view');

/** FR-SUB-013 / 014 / 015 — *"Super Admin / School"*. */
const canChangeOwn = () =>
  requireAnyPermission('subscriptions.lifecycle', 'subscriptions.self.manage');

/** FR-SUB-009 — *"Super Admin and/or school"*. */
const canBuyAddons = () =>
  requireAnyPermission('subscriptions.manage', 'subscriptions.self.manage');

/* ───────────────────────────── Reads — SRS §12 ───────────────────────────── */

/* Declared first: see the route-ordering note in the header. */
router.get('/catalogue', canRead(), asyncHandler(controller.catalogue));

router.get('/', canRead(), validate({ query: schemas.list }), asyncHandler(controller.list));

/* ────────────────── FR-SUB-010 — Create Subscription (§12) ────────────────── */

router.post(
  '/',
  requirePlatformScope(),
  requirePermission('subscriptions.manage'),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id',
  canRead(),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

/*
 * FR-SUB-010's audit trail. Declared beside the detail read rather than with the writes, because it
 * is one: `subscription_history` is written by the service inside each transaction and never by a
 * request of its own.
 */
router.get(
  '/:id/history',
  canRead(),
  validate({ params: schemas.idParam, query: schemas.history }),
  asyncHandler(controller.history)
);

/* ───────── FR-SUB-011 / FR-SUB-012 — Trial & Grace Period (§12.1, §12.2) ───────── */

/*
 * One PATCH for both requirements. They are two FRs because §12.1 and §12.2 are two settings, but
 * they are two columns on one row configured from one screen, and splitting them into
 * `PATCH /:id/trial` and `PATCH /:id/grace` would make an operator adjusting both send two requests
 * that could half-fail. `subscriptions.validation.js` accepts exactly the four configurable fields.
 */
router.patch(
  '/:id',
  requirePlatformScope(),
  requirePermission('subscriptions.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

/* ───────────── FR-SUB-010 — the six administrative transitions (§12) ───────────── */

router.post(
  '/:id/activate',
  requirePlatformScope(),
  requirePermission('subscriptions.lifecycle'),
  validate({ params: schemas.idParam, body: schemas.transition }),
  logActivity({ action: 'update', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.activate)
);

router.post(
  '/:id/suspend',
  requirePlatformScope(),
  requirePermission('subscriptions.lifecycle'),
  validate({ params: schemas.idParam, body: schemas.transition }),
  logActivity({ action: 'update', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.suspend)
);

router.post(
  '/:id/reactivate',
  requirePlatformScope(),
  requirePermission('subscriptions.lifecycle'),
  validate({ params: schemas.idParam, body: schemas.transition }),
  logActivity({ action: 'update', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.reactivate)
);

router.post(
  '/:id/pause',
  requirePlatformScope(),
  requirePermission('subscriptions.lifecycle'),
  validate({ params: schemas.idParam, body: schemas.transition }),
  logActivity({ action: 'update', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.pause)
);

router.post(
  '/:id/resume',
  requirePlatformScope(),
  requirePermission('subscriptions.lifecycle'),
  validate({ params: schemas.idParam, body: schemas.transition }),
  logActivity({ action: 'update', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.resume)
);

/* Platform-only, and the header says why that is not an oversight. */
router.post(
  '/:id/cancel',
  requirePlatformScope(),
  requirePermission('subscriptions.lifecycle'),
  validate({ params: schemas.idParam, body: schemas.cancel }),
  logActivity({ action: 'update', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.cancel)
);

/* ──────── FR-SUB-013 / FR-SUB-014 — Upgrade & Downgrade (§12.3, §12.4) ──────── */

router.post(
  '/:id/upgrade',
  canChangeOwn(),
  validate({ params: schemas.idParam, body: schemas.upgrade }),
  logActivity({ action: 'update', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.upgrade)
);

/*
 * The only one of the three whose body has a required field: §12.4 offers Immediate and Next Billing
 * Cycle and an immediate downgrade can drop a limit below what the school is already using, so the
 * choice is not defaulted. `subscriptions.validation.js` carries the message.
 */
router.post(
  '/:id/downgrade',
  canChangeOwn(),
  validate({ params: schemas.idParam, body: schemas.downgrade }),
  logActivity({ action: 'update', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.downgrade)
);

/* ──────────────── FR-SUB-015 — Manual Renewal (§12.5) ──────────────── */

router.post(
  '/:id/renew',
  canChangeOwn(),
  validate({ params: schemas.idParam, body: schemas.renew }),
  logActivity({ action: 'update', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.renew)
);

/* ────────────── §11.3 / FR-SUB-009 — Add-ons on a subscription ────────────── */

router.post(
  '/:id/addons',
  canBuyAddons(),
  validate({ params: schemas.idParam, body: schemas.purchaseAddon }),
  logActivity({ action: 'create', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.purchaseAddon)
);

/*
 * `:addonId` is a `subscription_addons.id`, not an `addons.id` — a school may hold two purchases of
 * the same add-on, and cancelling one must not cancel both. The service scopes the lookup by
 * `subscription_id`, so an id belonging to another subscription 404s.
 *
 * POST rather than DELETE: the row is not removed. It becomes `status = 'cancelled'`, because §13's
 * invoice line was raised against it.
 */
router.post(
  '/:id/addons/:addonId/cancel',
  canBuyAddons(),
  validate({ params: schemas.addonParam, body: schemas.cancelAddon }),
  logActivity({ action: 'update', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.cancelAddon)
);

/* ────── §33 — Feature Overrides, Custom Limits, Custom Pricing ────── */

/*
 * Platform-only and behind their own permission key. An override is the highest-precedence source in
 * `entitlementService`'s resolution chain — above add-ons and above the plan — so a school able to
 * write one could grant itself any module, any feature and any limit. `subscriptions.overrides.manage`
 * exists as a separate key for exactly this reason, and is seeded to `super_admin` alone.
 */
router.post(
  '/:id/overrides',
  requirePlatformScope(),
  requirePermission('subscriptions.overrides.manage'),
  validate({ params: schemas.idParam, body: schemas.createOverride }),
  logActivity({ action: 'create', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.createOverride)
);

router.post(
  '/:id/overrides/:overrideId/revoke',
  requirePlatformScope(),
  requirePermission('subscriptions.overrides.manage'),
  validate({ params: schemas.overrideParam, body: schemas.revokeOverride }),
  logActivity({ action: 'update', entityType: 'subscription', onlyOnSuccess: true }),
  asyncHandler(controller.revokeOverride)
);

module.exports = router;
