'use strict';

const couponsService = require('../../modules/coupons/coupons.service');

/**
 * SRS §13.2 — a coupon past `expires_at` stops being usable.
 *
 * Daily. A coupon that expires at midnight and is still `active` at 02:25 can only be redeemed by
 * someone the redemption path would refuse anyway — `expires_at` is checked at redemption too — so
 * this sweep keeps the *catalogue* honest rather than guarding the money.
 */
module.exports = {
  name: 'coupon-expiry',
  schedule: '25 2 * * *',
  description: 'Move lapsed coupons to expired (SRS §13.2)',
  run: (options = {}) => couponsService.expireLapsed(options),
};
