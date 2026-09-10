'use strict';

const invoicesService = require('../../modules/invoices/invoices.service');

/**
 * FR-BILL-001 — the System issues a subscription's invoice when its billing period starts.
 *
 * The SRS makes the actor **System** and the precondition *"a billing event occurs"*, and never says
 * what a billing event is; the owner's decision D6 (`docs/OWNER-DECISIONS.md`) does — a period
 * starting, at first activation and at every renewal. `issueForStartedPeriods()` finds each owed period
 * with no live invoice and issues it the way Generate would.
 *
 * Runs after `subscription-lifecycle` in `ORDER`, because a renewal is what opens the next period: the
 * other way round, a school renewed at 09:05 would wait a whole cycle for its invoice. Hourly at :10 —
 * five minutes behind the hourly lifecycle sweep — rather than the daily the decision's wording
 * suggested, for the same reason that sweep is hourly: a period starts at a moment, not on a day. It is
 * idempotent, so the extra runs issue nothing twice.
 */
module.exports = {
  name: 'invoice-issue',
  schedule: '10 * * * *',
  description: 'Issue the invoice for each billing period that has started (FR-BILL-001, owner decision D6)',
  run: (options = {}) => invoicesService.issueForStartedPeriods(options),
};
