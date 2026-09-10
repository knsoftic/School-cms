'use strict';

/**
 * Quotation routes — mounted at `/api/v1/quotations`, below the authentication and tenant boundary.
 *
 * ## Route → permission
 *
 * The SRS column reads §29 — the `quotations` table at SRS:1445 — on all seven rows. Every one of
 * them read §33 until session 26; §33's SaaS Engine list does not name Quotations, so the column was
 * pointing at a clause that does not exist. See `quotations.service.js`.
 *
 * | SRS | Route                | Guard                              |
 * |-----|----------------------|------------------------------------|
 * | §29 | `GET /`              | `quotations.view`                  |
 * | §29 | `GET /:id`           | `quotations.view`                  |
 * | §29 | `POST /`             | platform + `quotations.manage`     |
 * | §29 | `PATCH /:id`         | platform + `quotations.manage`     |
 * | §29 | `POST /:id/send`     | platform + `quotations.manage`     |
 * | §29 | `POST /:id/accept`   | platform + `quotations.manage`     |
 * | §29 | `POST /:id/reject`   | platform + `quotations.manage`     |
 *
 * ## The whole module is platform-only
 *
 * `config/permissions.js` seeds `quotations.view` and `quotations.manage` to `super_admin` alone — a
 * quotation is a pre-sales document the platform issues to win a school, not something a school operates.
 * The writes still carry `requirePlatformScope()` on top of the manage key, for the reason the rest of
 * billing does: `role_permissions` is a re-grantable table (FR-AUTH-009), and accepting a quotation
 * *issues an invoice* — the scope guard is the condition no grant can satisfy. The reads carry the view
 * key alone; `service.list()` and `findById()` confine by `tenantWhere()`, so even a re-granted
 * organization admin would see only their own rows.
 *
 * ## What has no route, and why
 *
 *  - **`expireLapsed()`** — `sent → expired` is a fact about `valid_until` and the clock, the same
 *    scheduler argument that keeps `invoices.markOverdue()` and `subscriptions.runLifecycleSweep()` off
 *    their routers. It runs daily from `jobs/tasks/quotationExpiry.js`, asserted in `verify-jobs.js`.
 *  - **No `DELETE /:id`.** `quotations` is not `paranoid`, so a delete would be real and would strand any
 *    `converted_invoice_id`. A quote that came to nothing is `rejected` or `expired`, both terminal
 *    `QUOTATION_STATUS` values, which is the audit trail a hard delete would destroy.
 *  - **No un-send / un-accept.** The lifecycle is forward-only by design; a mistaken quote is rejected
 *    and a fresh one drafted, so a sent or accepted quotation stays the record of what was offered.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requirePlatformScope,
} = require('../../middlewares');

const controller = require('./quotations.controller');
const { schemas } = require('./quotations.validation');

const router = createRouter();

/** Every write on this platform-only module: platform scope, then the manage key. */
const canManage = () => [requirePlatformScope(), requirePermission('quotations.manage')];

/* ───────────────────────────── Reads ───────────────────────────── */

router.get(
  '/',
  requirePermission('quotations.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

/* ───────────────────────────── Create ───────────────────────────── */

router.post(
  '/',
  canManage(),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'quotation', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id',
  requirePermission('quotations.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  canManage(),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'quotation', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

/* ───────────────────────────── Lifecycle ───────────────────────────── */

router.post(
  '/:id/send',
  canManage(),
  validate({ params: schemas.idParam, body: schemas.send }),
  logActivity({ action: 'update', entityType: 'quotation', onlyOnSuccess: true }),
  asyncHandler(controller.send)
);

router.post(
  '/:id/accept',
  canManage(),
  validate({ params: schemas.idParam, body: schemas.accept }),
  logActivity({ action: 'update', entityType: 'quotation', onlyOnSuccess: true }),
  asyncHandler(controller.accept)
);

router.post(
  '/:id/reject',
  canManage(),
  validate({ params: schemas.idParam, body: schemas.reject }),
  logActivity({ action: 'update', entityType: 'quotation', onlyOnSuccess: true }),
  asyncHandler(controller.reject)
);

module.exports = router;
