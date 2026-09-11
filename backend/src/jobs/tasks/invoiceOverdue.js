'use strict';

const invoicesService = require('../../modules/invoices/invoices.service');
const subscriptionsService = require('../../modules/subscriptions/subscriptions.service');

/**
 * SRS §13.1 — an invoice past its due date becomes overdue, and its subscription Past Due.
 *
 * Daily, because `due_date` is a DATE and nothing finer than a day can change the answer. Runs after
 * the lifecycle sweep on the hour it shares with it, so an invoice settled by a renewal minutes
 * earlier is not flagged overdue on its way out.
 *
 * The second step is the owner's decision D23: billing events drive the subscription's state (SRS:577).
 * An overdue invoice used to change nothing — the subscription stayed Active and, on automatic renewal,
 * kept renewing. The subscriptions whose invoices were just flagged now take the Past Due edge, and the
 * next sweep carries them on through grace to Expired unless the arrears are paid.
 */
module.exports = {
  name: 'invoice-overdue',
  schedule: '20 2 * * *',
  description: 'Flag unpaid invoices past their due date, and their subscriptions past due (SRS §13.1, D23)',
  run: async (options = {}) => {
    const flagged = await invoicesService.markOverdue(options);
    const subscriptions = await subscriptionsService.pastDueForOverdueInvoices(flagged.subscriptionIds, options);
    return { ...flagged, subscriptions };
  },
};
