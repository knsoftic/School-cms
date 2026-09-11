'use strict';

const feesService = require('../../modules/fees/fees.service');

/**
 * SRS §17 — a fee structure's Fine, applied to the fees still unpaid once it is due — the owner's
 * decision D29.
 *
 * §17 lets a user configure a Fine and never says when one applies; D29 decided it. Daily, because a
 * fee's `due_date` is a DATE and a `per_day` fine grows by the day. Idempotent — `applyFines()` only
 * ever raises a fee's fine to what it owes today — so a missed or repeated run is harmless.
 */
module.exports = {
  name: 'fee-fines',
  schedule: '22 2 * * *',
  description: 'Apply configured fee fines to fees unpaid past their grace period (SRS §17, D29)',
  run: (options = {}) => feesService.applyFines(options),
};
