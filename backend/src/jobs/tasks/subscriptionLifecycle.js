'use strict';

const subscriptionsService = require('../../modules/subscriptions/subscriptions.service');

/**
 * SRS §12.5 / FR-SUB-015 — the date-driven half of the subscription lifecycle.
 *
 * Cited §13 until the §36 pass. §13 is Invoice, Payment & Coupon (SRS:618); FR-SUB-015 — Subscription
 * Renewal — is at SRS:609, inside §12 Subscription Lifecycle, whose §12.5 is Renewal (SRS:566).
 * `invoice-overdue`'s §13.1 citation next door is correct and is what made this one look plausible.
 *
 * `runLifecycleSweep()` has no route on purpose: its actor is the system, not a user, and its own
 * header says so. This is the caller it was written for.
 *
 * Hourly rather than daily. Trials end, grace periods lapse and renewals fall due at a moment, not
 * on a day, and a school that renews at 09:00 should not spend the morning suspended. The SRS fixes
 * no cadence — §25 explicitly declines to invent numeric targets — so this is a choice, recorded as
 * one, and it is the only place to change it.
 */
module.exports = {
  name: 'subscription-lifecycle',
  schedule: '5 * * * *',
  description: 'Trial ends, renewals, past-due, grace, expiry (SRS §12.5, FR-SUB-015)',
  run: (options = {}) => subscriptionsService.runLifecycleSweep(options),
};
