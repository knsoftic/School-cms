'use strict';

/**
 * Coupon routes — mounted at `/api/v1/coupons`, below the authentication and tenant boundary.
 *
 * ## Route → FR → permission
 *
 * | SRS   | FR         | Route                    | Guard                              |
 * |-------|------------|--------------------------|------------------------------------|
 * | §13.4 | FR-BILL-005| `GET /`, `GET /:id`      | `coupons.view`                     |
 * | §13.4 | FR-BILL-005| `GET /:id/usages`        | `coupons.view`                     |
 * | §13.4 | FR-BILL-005| `POST /`                 | platform + `coupons.manage`        |
 * | §13.4 | FR-BILL-005| `PATCH /:id`             | platform + `coupons.manage`        |
 * | §13.4 | FR-BILL-005| `DELETE /:id`            | platform + `coupons.manage`        |
 * | §13.4 | FR-BILL-005| `POST /validate`         | `coupons.redeem`                   |
 *
 * `config/permissions.js` carries exactly three `coupons.*` keys and each route uses the one whose
 * *name* describes it. Adding a fourth would be inventing a permission, which SRS §35 forbids.
 *
 * ## Why the split is `manage` versus `redeem`, and how it matches the actor line
 *
 * FR-BILL-005 is *"Coupon Management & Redemption"* with the actor **Super Admin / School** — one
 * requirement covering two activities by two different actors, and the seeded grants already draw the
 * line: `coupons.view` and `coupons.manage` go to `super_admin` alone, `coupons.redeem` goes to
 * `super_admin`, `principal` and `school_admin`. So the *management* half is platform-only and the
 * *redemption* half is reachable by a school, which is exactly the sentence.
 *
 * The writes carry `requirePlatformScope()` on top of `coupons.manage` for the reason `/plans` and
 * `/taxes` state: `coupons` has no `school_id`, so one row governs every school it is not restricted
 * from, and `role_permissions` is a database table a Super Admin may re-grant under FR-AUTH-009. The
 * scope guard is the condition no grant can satisfy.
 *
 * `POST /validate` carries **no scope guard**, deliberately: its whole purpose is to be reachable by a
 * school, and `coupons.controller.validateCode()` confines it instead — a non-platform caller naming
 * another school's `school_id` gets a 403 with `CROSS_SCHOOL_ACCESS`, and one naming nothing gets its
 * own school. `organization_admin` is not granted `coupons.redeem`, which is what keeps the one role
 * whose `req.tenant.schoolId` may be null from reaching a route that needs a school.
 *
 * ## `POST /validate` writes nothing, and that is the design
 *
 * §13.4's *Maximum Uses* is consumed by **redemption**, and redemption happens inside invoice issuance
 * where the discount is computed and `coupon_usages.invoice_id` can be filled in — the column is what
 * makes a use auditable. A `POST /coupons/:id/redeem` endpoint that consumed a use without an invoice
 * would have to write `discount_amount` (`allowNull: false`) against no order, so the schema is the
 * argument against it. A school checking a code five times has therefore used it zero times.
 *
 * ## Route ordering
 *
 * `POST /validate` cannot collide with anything: the only other POST in the file is at `/`, and there
 * is no `POST /:id`. It is declared before the `/:id` block regardless, so the file reads top-down in
 * specificity order.
 *
 * ## What has no route, and why
 *
 * `coupons.service.expireLapsed()` — the sweep that moves a lapsed coupon's `status` to `expired`. Its
 * actor is the system — the daily `coupon-expiry` job in `src/jobs/` runs it — and the same reasoning
 * keeps `subscriptions.runLifecycleSweep()` off the router. Nothing depends on it having run —
 * `validateForOrder()` compares `expires_at` to the clock directly — so a job that has not run yet
 * cannot let an expired coupon be redeemed.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requirePlatformScope,
} = require('../../middlewares');

const controller = require('./coupons.controller');
const { schemas } = require('./coupons.validation');

const router = createRouter();

/** FR-BILL-005's management half — *"Super Admin"*. */
const canManage = () => [requirePlatformScope(), requirePermission('coupons.manage')];

/* ───────────────────────────── Reads — SRS §13.4 ───────────────────────────── */

router.get(
  '/',
  requirePermission('coupons.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

/* ──────── FR-BILL-005 — redemption check, the half a school may reach ──────── */

/*
 * Not `logActivity` — this endpoint writes nothing, and an activity row per keystroke on a
 * "check code" field would bury the log. `activityAudit()` in `app.js` still records the request.
 */
router.post(
  '/validate',
  requirePermission('coupons.redeem'),
  validate({ body: schemas.validateCode }),
  asyncHandler(controller.validateCode)
);

/* ─────────────── FR-BILL-005 — management, platform-only ─────────────── */

router.post(
  '/',
  canManage(),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'coupon', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id',
  requirePermission('coupons.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

/*
 * §13.4's *Maximum Uses* made auditable. Declared beside the detail read rather than with the writes,
 * because it is one: `coupon_usages` is written by `coupons.service.redeem()` inside invoice issuance
 * and never by a request of its own.
 */
router.get(
  '/:id/usages',
  requirePermission('coupons.view'),
  validate({ params: schemas.idParam, query: schemas.usages }),
  asyncHandler(controller.usages)
);

router.patch(
  '/:id',
  canManage(),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'coupon', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

/*
 * A real DELETE — the billing models are not `paranoid`. `coupons.service.destroy()` refuses once the
 * coupon has been redeemed, because `coupon_usages.coupon_id` is `ON DELETE CASCADE` and the delete
 * would take the redemption history with it.
 */
router.delete(
  '/:id',
  canManage(),
  validate({ params: schemas.idParam }),
  logActivity({ action: 'delete', entityType: 'coupon', onlyOnSuccess: true }),
  asyncHandler(controller.destroy)
);

module.exports = router;
