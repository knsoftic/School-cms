'use strict';

/**
 * Notification routes — mounted at `/api/v1/notifications`. SRS §23, FR-NOTIF-001.
 *
 * | Route | Permission | What it is |
 * |---|---|---|
 * | `GET /` | `notifications.view` | the caller's own inbox, with the unread count beside it |
 * | `GET /:id` | `notifications.view` | one of the caller's own |
 * | `POST /:id/read` | `notifications.view` | mark it read |
 * | `POST /read-all` | `notifications.view` | mark the caller's unread inbox read |
 * | `POST /:id/retry` | `notifications.send` | re-send a failed e-mail delivery |
 *
 * **There is no route that sends a notification**, and that is the section's central fact rather than
 * an omission. FR-NOTIF-001's Actor is `System`; its nine types are dispatched by
 * `runNotificationSweep()`, which — like `subscriptions.runLifecycleSweep()`, `invoices.markOverdue()`
 * and the coupon expiry pass — is called by a scheduler and reachable from no URL. `src/jobs/` is
 * Phase 5.
 *
 * ## Two guards this router does *not* mount, both measured rather than assumed
 *
 * **No `requireModule()`.** There is no `MODULES.NOTIFICATIONS`: §11's twenty module keys do not
 * include one, and both notification permissions are declared with `module: null`. Notifications are
 * core rather than subscribable, so a school on the smallest plan still receives them. That leaves
 * the count of entitlement-aware routers where §22 found it — **fifteen**, fourteen of them mounting
 * a router-level guard and `/reports` mounting none for its own reason. This router is not one of the
 * fifteen at all: it has nothing to mount, rather than choosing not to.
 *
 * **No limit metering.** §11.2 fixes eight limit keys and none of them counts notifications. There is
 * no SMS channel to meter either — `NOTIFICATION_CHANNELS` holds `in_app` and `email` alone, its own
 * comment recording that §35 marks additional channels unspecified.
 *
 * ## The permission split, and the mismatch behind it
 *
 * `notifications.view` is granted to **all eleven roles**, which is the first key in the catalogue
 * that is, and it matches FR-NOTIF-001 exactly: the outcome names *"school, parent, student, teacher,
 * or Super Admin as applicable"*, which between them is everyone.
 *
 * `notifications.send` is granted to Super Admin, Principal and School Admin — and §23 gives it **no
 * human actor at all**, because nothing in the section is sent by a person. That is this section's
 * catalogue mismatch, and it is in the *"a key exists for something the SRS never asks a human to
 * do"* direction, as `question_bank.manage` was in §21.
 *
 * It guards the retry rather than nothing, on a narrow reading. FR-NOTIF-001's Expected Outcome is
 * that the relevant users *receive* the notification; a row sitting at `failed` with the transport's
 * message in `error_message` is one where that has not happened, and §29 would not have given the
 * table a `failed` status and an `error_message` column if the state were meant to be terminal. The
 * retry composes nothing — same recipient, same title, same message, chosen by the engine — so the
 * actor of the *content* is still `System`. A caller cannot author a notification through this
 * router, only ask that one already authored be tried again.
 *
 * ## `POST /:id/read`, not `PATCH`
 *
 * Marking read takes no body. `PATCH` with an empty body invites a client to send one, and the point
 * of these three routes is that a caller supplies nothing but an id — the forbidden map in
 * `notifications.validation.js` refuses every column by name so that attempting otherwise is a
 * refusal rather than a silently ignored payload.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
} = require('../../middlewares');

const controller = require('./notifications.controller');
const { schemas } = require('./notifications.validation');

const router = createRouter();

router.get(
  '/',
  requirePermission('notifications.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

/*
 * Before `/:id`, or `read-all` is read as an id and refused by the param guard with a message about
 * a malformed identifier — the same ordering `payments` needs for `/refunds`.
 */
router.post(
  '/read-all',
  requirePermission('notifications.view'),
  validate({ body: schemas.readAll }),
  asyncHandler(controller.markAllRead)
);

router.get(
  '/:id',
  requirePermission('notifications.view'),
  validate({ params: schemas.idParam }),
  asyncHandler(controller.show)
);

router.post(
  '/:id/read',
  requirePermission('notifications.view'),
  validate({ params: schemas.idParam, body: schemas.empty }),
  asyncHandler(controller.markRead)
);

router.post(
  '/:id/retry',
  requirePermission('notifications.send'),
  validate({ params: schemas.idParam, body: schemas.empty }),
  /*
   * `update`, not a `retry` action: `ACTIVITY_ACTIONS` is an ENUM of eleven verbs and refuses an
   * invented twelfth at boot. A retry does update the row — `status`, `sent_at`, `error_message` —
   * so `update` is the accurate one rather than the nearest available.
   */
  logActivity({ action: 'update', entityType: 'notification', onlyOnSuccess: true }),
  asyncHandler(controller.retry)
);

module.exports = router;
