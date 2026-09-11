'use strict';

/**
 * Payment routes — mounted at `/api/v1/payments`, below the authentication and tenant boundary.
 *
 * ## Route → FR → permission
 *
 * | SRS   | FR          | Route                 | Guard                                     |
 * |-------|-------------|-----------------------|-------------------------------------------|
 * | §13.2 | —           | `GET /`               | `payments.view`                           |
 * | §13.2 | —           | `GET /:id`            | `payments.view`                           |
 * | §13.3 | FR-BILL-003 | `POST /`              | `payments.submit` (+ multipart screenshot)|
 * | §13.2 | FR-BILL-002 | `POST /record`        | platform + `payments.record`              |
 * | §13.2 | FR-BILL-004 | `POST /:id/approve`   | platform + `payments.approve`             |
 * | §13.2 | FR-BILL-004 | `POST /:id/reject`    | platform + `payments.approve`             |
 * | §33   | —           | `POST /:id/refunds`   | platform + `refunds.manage`               |
 * | §33   | —           | `GET /:id/refunds`    | `refunds.view`                            |
 *
 * ## Why the reads name one key, not two
 *
 * `invoices.routes.js` guards its reads with `requireAnyPermission('invoices.view', 'invoices.self.view')`
 * because the seed grants schools an `invoices.self.view` key for reading *their own* invoices. There is
 * **no equivalent `payments.self.view`** — `config/permissions.js` seeds exactly four payment keys
 * (`view`, `record`, `submit`, `approve`). So the read is a single `requirePermission('payments.view')`,
 * and its confinement is the tenant layer's: `service.list()` and `findById()` start from
 * `tenantWhere(req.tenant, …)`, so an organization admin sees their organization's payments and a school
 * its own, and nothing wider — `list()` also refuses a `school_id` filter naming another school.
 *
 * `payments.view` was granted only to `super_admin` and `organization_admin`, so a school could submit a
 * payment and never see what became of it. The owner's decision D27 — the school billing screen — gave
 * Principal and School Admin the key, in the seed, which is where that decision belonged; no fifth key.
 *
 * ## `POST /` is the one write a school may make — FR-BILL-003
 *
 * FR-BILL-003 is *"School submits a manual payment for review."* (SRS:679), and its behaviour is two
 * separate bullets — *"- School enters a transaction ID."* (:684) and *"- School uploads a payment
 * screenshot."* (:685). This header used to compress them into one sentence and present it in the
 * file’s verbatim-quotation style; **that sentence is not in the SRS** (`grep -c "with a screenshot"`
 * over the source returns 0), and compressing two bullets into one also implied both were required,
 * which neither is. So this route must be
 * reachable by a school, and `payments.submit` (`super_admin`, `organization_admin`, `principal`,
 * `school_admin`, `accountant`) is the key that names it. **No `requirePlatformScope()`**, deliberately:
 * a submitted payment is created `pending` and settles nothing until a Super Admin reviews it under
 * FR-BILL-004, so a school cannot move its own money. The service confines *which* invoice — the
 * `invoice_id` is loaded through `invoicesService.findById()` under the same tenant filter — and refuses
 * the `online_gateway` method, which is the platform's to drive, not a school's to submit.
 *
 * The upload runs with **`allowInactiveSubscription: true`**, and that is not incidental: the school that
 * most needs to pay is the one whose subscription has gone `pending` or lapsed, and the ordinary upload
 * gate would refuse it (see the long note in `middlewares/upload.js`). Only the *subscription-state*
 * precondition is lifted — the file-type allowlist and size ceiling still apply.
 *
 * The pipeline order is the barrel's: permission → `uploadSingle` (so `req.file` exists) → `validate`
 * (which then sees the multipart text fields, coerced from strings) → `logActivity`.
 *
 * ## Why every other write carries `requirePlatformScope()`
 *
 * `record`, `approve`, `reject` and the refund are all seeded to `super_admin` alone, but
 * `role_permissions` is a table a Super Admin may re-grant under FR-AUTH-009. A payment is the record of
 * money received and a refund of money returned; a school that could record, approve or refund its own
 * payments could settle its own debt or pay itself back. The scope guard is the condition no grant can
 * satisfy — the same reasoning `invoices.routes.js` applies to `invoices.manage`.
 *
 * The refund *read* (`GET /:id/refunds`, `refunds.view`) needs no scope guard: it is seeded to
 * `super_admin` only, and exposing a read is not the risk a re-grantable write is.
 *
 * ## Route ordering
 *
 * `POST /record` is a single literal segment and there is **no bare `POST /:id`** — every id-bound write
 * is `POST /:id/{approve,reject,refunds}`, two segments — so nothing collides with it and no ordering
 * hazard exists here (unlike `invoices`' `/summary`, which had to precede `/:id`). The routes are grouped
 * reads-then-writes for reading, not for correctness.
 *
 * ## What has no route, and why
 *
 *  - **No `PATCH`/`DELETE /:id`.** A payment is immutable once written: its lifecycle is `pending →
 *    approved/rejected` (FR-BILL-004) and its reversal is a refund (§33), which is its own document.
 *    Editing an approved payment would desynchronise `invoices.amount_paid`, which is the sum of them.
 *  - **No gateway webhook/callback route.** A school-initiated online charge is a redirect/webhook flow
 *    §13 does not specify; `submit` refuses `online_gateway`, and the Super-Admin `record` path dispatches
 *    a *synchronous* charge through the plugin registry instead. When an async gateway is added, its
 *    callback belongs on its own webhook router, not here.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requirePlatformScope,
  uploadSingle,
} = require('../../middlewares');
const { UPLOAD_PROFILES, UPLOAD_RULES } = require('../../config/constants');
const { respondsWithFile } = require('../../utils/routeMeta');

const controller = require('./payments.controller');
const { schemas } = require('./payments.validation');

const router = createRouter();

/** Every platform-only write: platform scope, then the one key that names it. */
const platformOnly = (permission) => [requirePlatformScope(), requirePermission(permission)];

/* ───────────────────────────── Reads — SRS §13.2 ───────────────────────────── */

router.get(
  '/',
  requirePermission('payments.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

/* ─────────── FR-BILL-002 — Super Admin records or charges a payment ─────────── */
/* Declared before `/:id/*` for reading; a single literal segment collides with nothing. */
router.post(
  '/record',
  platformOnly('payments.record'),
  validate({ body: schemas.record }),
  logActivity({ action: 'create', entityType: 'payment', onlyOnSuccess: true }),
  asyncHandler(controller.record)
);

/* ─────────── FR-BILL-003 — School submits a manual payment (multipart) ─────────── */
router.post(
  '/',
  requirePermission('payments.submit'),
  uploadSingle(UPLOAD_PROFILES.PAYMENT_PROOF, 'screenshot', { allowInactiveSubscription: true }),
  validate({ body: schemas.submit }),
  logActivity({ action: 'create', entityType: 'payment', onlyOnSuccess: true }),
  asyncHandler(controller.submit)
);

/*
 * FR-BILL-004's screenshot. `payments.view` — the same key that governs the record, because the
 * screenshot IS part of the record the FR asks a reviewer to review, not a separate resource with a
 * separate audience.
 */
router.get(
  '/:id/screenshot',
  requirePermission('payments.view'),
  validate({ params: schemas.idParam }),
  logActivity({ action: 'view', entityType: 'payment', onlyOnSuccess: true }),
  respondsWithFile(asyncHandler(controller.screenshot), {
    types: UPLOAD_RULES[UPLOAD_PROFILES.PAYMENT_PROOF].mimeTypes,
  })
);

router.get(
  '/:id',
  requirePermission('payments.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

/* ─────────────────── FR-BILL-004 — Super Admin approves / rejects ─────────────────── */

router.post(
  '/:id/approve',
  platformOnly('payments.approve'),
  validate({ params: schemas.idParam, body: schemas.approve }),
  logActivity({ action: 'update', entityType: 'payment', onlyOnSuccess: true }),
  asyncHandler(controller.approve)
);

router.post(
  '/:id/reject',
  platformOnly('payments.approve'),
  validate({ params: schemas.idParam, body: schemas.reject }),
  logActivity({ action: 'update', entityType: 'payment', onlyOnSuccess: true }),
  asyncHandler(controller.reject)
);

/* ─────────────────────────────── Refunds (§33) ─────────────────────────────── */

router.get(
  '/:id/refunds',
  requirePermission('refunds.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.listRefunds)
);

router.post(
  '/:id/refunds',
  platformOnly('refunds.manage'),
  validate({ params: schemas.idParam, body: schemas.createRefund }),
  logActivity({ action: 'create', entityType: 'refund', onlyOnSuccess: true }),
  asyncHandler(controller.createRefund)
);

module.exports = router;
