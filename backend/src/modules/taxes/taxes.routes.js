'use strict';

/**
 * Tax routes — mounted at `/api/v1/taxes`, below the authentication and tenant boundary.
 *
 * ## Route → source → permission
 *
 * | SRS  | Route                      | Guard                                  |
 * |------|----------------------------|----------------------------------------|
 * | §33  | `GET /`, `GET /:id`        | `taxes.view`                           |
 * | §33  | `POST /`                   | platform + `taxes.manage`              |
 * | §33  | `PATCH /:id`               | platform + `taxes.manage`              |
 * | §33  | `POST /:id/default`        | platform + `taxes.manage`              |
 * | §33  | `POST /default/clear`      | platform + `taxes.manage`              |
 * | §33  | `DELETE /:id`              | platform + `taxes.manage`              |
 *
 * `config/permissions.js` carries exactly two `taxes.*` keys and both are seeded to `super_admin`
 * alone. Adding a third would be inventing a permission, which SRS §35 forbids — so the split here is
 * the same one `/roles` and `/plans` use: `view` for the reads, `manage` for every write.
 *
 * ## Why the writes carry `requirePlatformScope()` when the permission is already platform-only
 *
 * Two independent conditions, on the reasoning `/plans` states: `taxes` has **no `school_id`**, so one
 * edit here changes the rate applied to every school's next invoice. `taxes.manage` being granted to
 * `super_admin` alone in the seeder is a *default* — `role_permissions` is a database table and
 * FR-AUTH-009 exists to let a Super Admin re-grant it. The scope guard is the condition no grant can
 * satisfy, and it is what keeps a re-granted key from becoming a platform-wide write.
 *
 * The reads do not carry it, and here that is nearly moot rather than load-bearing: `taxes.view` is
 * seeded to `super_admin` only, so today there is no non-platform caller to serve. It is left off
 * because a school reading the rate on its own invoice is a plausible future grant and the reads are
 * harmless — `taxes` holds no tenant data.
 *
 * ## Route ordering
 *
 * `POST /default/clear` cannot collide with `POST /:id/default`: both are two-segment POSTs, but the
 * second pattern requires the *second* segment to be the literal `default` and this path's second
 * segment is `clear`. It is declared first anyway, so the file reads in the order Express matches.
 *
 * ## What has no route, and why
 *
 * **Nothing is deferred here.** Unlike `/subscriptions`, this module has no system-actor operation:
 * `taxes.service.resolveForInvoice()` and `quoteFor()` are called by `invoices.service.js` inside
 * invoice issuance, not by a scheduler, so they need no endpoint of their own. A `GET /taxes/quote`
 * preview endpoint would be inventing a screen the SRS does not describe.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requirePlatformScope,
} = require('../../middlewares');

const controller = require('./taxes.controller');
const { schemas } = require('./taxes.validation');

const router = createRouter();

/** Every write in this module: platform scope, then the one manage key. */
const canManage = () => [requirePlatformScope(), requirePermission('taxes.manage')];

/* ───────────────────────────── Reads — SRS §33 ───────────────────────────── */

router.get(
  '/',
  requirePermission('taxes.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

/* ───────────────────────────── Writes — SRS §33 ───────────────────────────── */

router.post(
  '/',
  canManage(),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'tax', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

/* Declared before `/:id/default` — the header explains why they cannot collide either way. */
router.post(
  '/default/clear',
  canManage(),
  validate({ body: schemas.setDefault }),
  logActivity({ action: 'update', entityType: 'tax', onlyOnSuccess: true }),
  asyncHandler(controller.clearDefault)
);

router.get(
  '/:id',
  requirePermission('taxes.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  canManage(),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'tax', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

router.post(
  '/:id/default',
  canManage(),
  validate({ params: schemas.idParam, body: schemas.setDefault }),
  logActivity({ action: 'update', entityType: 'tax', onlyOnSuccess: true }),
  asyncHandler(controller.setDefault)
);

/*
 * A real DELETE — the billing models are not `paranoid`, so there is no soft-delete to fall back on.
 * `taxes.service.destroy()` refuses when an invoice points at the row and names the count in the
 * refusal, so the destructive case is the one that cannot happen silently.
 */
router.delete(
  '/:id',
  canManage(),
  validate({ params: schemas.idParam }),
  logActivity({ action: 'delete', entityType: 'tax', onlyOnSuccess: true }),
  asyncHandler(controller.destroy)
);

module.exports = router;
