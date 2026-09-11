'use strict';

/**
 * Invoice routes — mounted at `/api/v1/invoices`, below the authentication and tenant boundary.
 *
 * ## Route → FR → permission
 *
 * | SRS   | FR          | Route                    | Guard                                          |
 * |-------|-------------|--------------------------|------------------------------------------------|
 * | §13.1 | FR-BILL-001 | `GET /`                  | `invoices.view` **or** `invoices.self.view`     |
 * | §13.1 | FR-BILL-001 | `GET /summary`           | `invoices.view` **or** `invoices.self.view`     |
 * | §13.1 | FR-BILL-001 | `GET /:id`               | `invoices.view` **or** `invoices.self.view`     |
 * | §13.1 | FR-BILL-001 | `POST /generate`         | platform + `invoices.manage`                    |
 * | §13.1 | FR-BILL-001 | `POST /:id/finalise`     | platform + `invoices.manage`                    |
 * | §13.1 | FR-BILL-001 | `POST /:id/cancel`       | platform + `invoices.manage`                    |
 * | §13.4 | FR-BILL-005 | `POST /:id/coupon`       | `coupons.redeem` **or** `invoices.manage`       |
 * | §13.4 | —           | `DELETE /:id/coupon`     | platform + `invoices.manage`                    |
 *
 * ## Why the reads name two keys
 *
 * `config/permissions.js` seeds three `invoices.*` keys, and the split is not arbitrary:
 *
 *     invoices.view       → super_admin, organization_admin
 *     invoices.manage     → super_admin
 *     invoices.self.view  → super_admin, organization_admin, principal, school_admin, accountant
 *
 * `invoices.self.view` exists precisely so a school can read **its own** invoices, and the four
 * school-side roles that hold it hold nothing else here. `requireAnyPermission()` is therefore the
 * correct shape — the same one used wherever an SRS actor line names both a platform and a school role —
 * and the *confinement* is the tenant layer's: `service.list()` and `findById()` both start from
 * `tenantWhere(req.tenant, …)`, so a principal holding `invoices.self.view` sees exactly their school's
 * rows and a request for another school's invoice 404s.
 *
 * Two keys, one handler, and no `if (isSchool)` branch. A second code path for the school case would be
 * a second chance to get the isolation wrong.
 *
 * ## Why the writes carry `requirePlatformScope()`
 *
 * FR-BILL-001's actor is *System* and `invoices.manage` is seeded to `super_admin` alone. But
 * `role_permissions` is a database table a Super Admin may re-grant under FR-AUTH-009, and an invoice is
 * the record of what a school owes — a school that could issue or cancel its own invoices could write
 * off its own debt. The scope guard is the condition no grant can satisfy.
 *
 * ## `POST /:id/coupon` is the one write a school may make, and that is FR-BILL-005
 *
 * *"School applies a valid coupon to an invoice/subscription."* — so this route must be reachable by a
 * school, and `coupons.redeem` (`super_admin`, `principal`, `school_admin`) is the key whose name
 * describes it. No scope guard, deliberately: the tenant layer confines *which* invoice, and
 * `invoices.service.applyCoupon()` confines *when* — `draft` or `unpaid` only, and refused once
 * `amount_paid > 0`, because a discount applied to a total the school has already settled would need a
 * refund to resolve and §13 gives refunds their own document.
 *
 * `invoices.manage` is accepted alongside it so a Super Admin applying a coupon on a school's behalf
 * does not need a key named for redemption.
 *
 * **`DELETE /:id/coupon` is platform-only.** Removal appears in no FR — it is the correction of a
 * management action, and it decrements `coupons.used_count`, so a school able to call it could cycle a
 * limited coupon's usage count back down. Guarded as management.
 *
 * ## Route ordering
 *
 * `GET /summary` is declared **before** `GET /:id`. This one matters: `commonSchemas.idParam` would
 * reject `summary` as a non-numeric id, so with the order reversed the summary endpoint would answer 422
 * instead of 200 — the same hazard `subscriptions.routes.js` records for `/catalogue`.
 *
 * `POST /generate` cannot collide with anything, since no `POST /:id` exists — only `POST /:id/…`.
 *
 * ## What has no route, and why
 *
 *  - **`markOverdue()`** — the clock is the actor: the daily `invoice-overdue` job
 *    (`src/jobs/tasks/invoiceOverdue.js`), which also moves the subscriptions of newly-overdue invoices to
 *    `past_due`. The same argument keeps `subscriptions.runLifecycleSweep()` off its router.
 *  - **`reminderCandidates()` / `markReminderSent()`** — the selection and the marker for
 *    `reminder_sent_at`, whose column comment names *"the fee/subscription reminder cron"*. Delivery is
 *    the notification sweep's `invoiceReminders` pass (the owner's decision D28), run by the
 *    `notification-dispatch` job.
 *  - **`applyPayment()` / `applyRefund()`** — called by `payments` and `refunds` inside their
 *    transactions. An endpoint that set `amount_paid` directly would make it a claim rather than the sum
 *    of approved payments, which is the whole of FR-BILL-004.
 *  - **No `POST /` and no `PATCH /:id`.** FR-BILL-001's precondition is *"Subscription exists and a
 *    billing event occurs"*, so generation is `POST /generate` against a subscription. There is no
 *    requirement for free-form invoice authoring or for editing an issued one, and §13.1's figures are
 *    all derived — an editable `total` would make every one of them optional.
 *  - **No `DELETE /:id`.** `invoices` is not `paranoid`, so a delete is real: it would take the document
 *    out of the school's billing history and leave `payments.invoice_id` pointing at nothing.
 *    `cancel()` is the operation, and `cancelled` is an `INVOICE_STATUS` value for exactly this reason.
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

const controller = require('./invoices.controller');
const { schemas } = require('./invoices.validation');

const router = createRouter();

/** A school reads its own; a platform or organization caller reads across. See the header. */
const canRead = () => requireAnyPermission('invoices.view', 'invoices.self.view');

/** Every management write: platform scope, then the one manage key. */
const canManage = () => [requirePlatformScope(), requirePermission('invoices.manage')];

/* ───────────────────────────── Reads — SRS §13.1 ───────────────────────────── */

router.get('/', canRead(), validate({ query: schemas.list }), asyncHandler(controller.list));

/* Before `/:id` — `idParam` would reject the literal `summary`. */
router.get(
  '/summary',
  canRead(),
  validate({ query: schemas.summary }),
  asyncHandler(controller.summary)
);

/* ─────────────────── FR-BILL-001 — invoice generation ─────────────────── */

router.post(
  '/generate',
  canManage(),
  validate({ body: schemas.generate }),
  logActivity({ action: 'create', entityType: 'invoice', onlyOnSuccess: true }),
  asyncHandler(controller.generate)
);

router.get(
  '/:id',
  canRead(),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

/* ───────────────────────── Status operations ───────────────────────── */

router.post(
  '/:id/finalise',
  canManage(),
  validate({ params: schemas.idParam, body: schemas.reasonOnly }),
  logActivity({ action: 'update', entityType: 'invoice', onlyOnSuccess: true }),
  asyncHandler(controller.finalise)
);

router.post(
  '/:id/cancel',
  canManage(),
  validate({ params: schemas.idParam, body: schemas.reasonOnly }),
  logActivity({ action: 'update', entityType: 'invoice', onlyOnSuccess: true }),
  asyncHandler(controller.cancel)
);

/* ───────── FR-BILL-005 — *"School applies a valid coupon to an invoice"* ───────── */

router.post(
  '/:id/coupon',
  requireAnyPermission('coupons.redeem', 'invoices.manage'),
  validate({ params: schemas.idParam, body: schemas.applyCoupon }),
  logActivity({ action: 'update', entityType: 'invoice', onlyOnSuccess: true }),
  asyncHandler(controller.applyCoupon)
);

/* Platform-only — it decrements `coupons.used_count`. The header explains. */
router.delete(
  '/:id/coupon',
  canManage(),
  validate({ params: schemas.idParam, body: schemas.reasonOnly }),
  logActivity({ action: 'update', entityType: 'invoice', onlyOnSuccess: true }),
  asyncHandler(controller.removeCoupon)
);

module.exports = router;
