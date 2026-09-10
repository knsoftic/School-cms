'use strict';

const quotationsService = require('../../modules/quotations/quotations.service');

/**
 * SRS §29 `quotations` — a `sent` quotation past its `valid_until` becomes `expired`.
 *
 * `quotations.service.expireLapsed()` was written as a sweep whose actor is the clock, and until this
 * task nothing called it: a lapsed quote stayed `sent` in storage for ever, and only the derived
 * `is_expired` on the read path said otherwise. Daily, beside the coupon sweep it mirrors. `at` is the
 * run's reference instant, passed through as the sweep's `asOf` so a suite can drive the date.
 */
module.exports = {
  name: 'quotation-expiry',
  schedule: '30 2 * * *',
  description: 'Move lapsed sent quotations to expired',
  run: (options = {}) => quotationsService.expireLapsed({ asOf: options.at }),
};
