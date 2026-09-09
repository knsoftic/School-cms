'use strict';

const notificationsService = require('../../modules/notifications/notifications.service');

/**
 * SRS §23 / FR-NOTIF-001 — dispatch all nine notification types.
 *
 * This is the caller §23 was built for. Its engine has no route because FR-NOTIF-001's actor is
 * `System`, and §29 gave five tables a marker column whose comments name a *cron*. This is that cron.
 *
 * Every fifteen minutes. A homework notice or an absence alert that arrives a day late has not been
 * delivered in any useful sense, and the sweep is idempotent by construction — five marker columns
 * and four reference checks — so running it often costs a handful of indexed reads when there is
 * nothing to do.
 *
 * **It must run after `subscription-lifecycle`.** §23's Subscription Expiry pass notifies
 * subscriptions in state `expiring`, and that state is set by `runLifecycleSweep()`. Ordering is
 * enforced by `ORDER` in `../cron.js`, not by these two schedules, because cron expressions cannot
 * express a dependency — at :05 and every :15 they would collide at the hour regardless.
 */
module.exports = {
  name: 'notification-dispatch',
  schedule: '*/15 * * * *',
  description: 'Dispatch SRS §23\'s nine notification types (FR-NOTIF-001)',
  run: (options = {}) => notificationsService.runNotificationSweep(options),
};
