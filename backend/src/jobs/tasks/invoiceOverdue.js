'use strict';

const invoicesService = require('../../modules/invoices/invoices.service');

/**
 * SRS §13.1 — an invoice past its due date becomes overdue.
 *
 * Daily, because `due_date` is a DATE and nothing finer than a day can change the answer. Runs after
 * the lifecycle sweep on the hour it shares with it, so an invoice settled by a renewal minutes
 * earlier is not flagged overdue on its way out.
 */
module.exports = {
  name: 'invoice-overdue',
  schedule: '20 2 * * *',
  description: 'Flag unpaid invoices past their due date (SRS §13.1)',
  run: (options = {}) => invoicesService.markOverdue(options),
};
