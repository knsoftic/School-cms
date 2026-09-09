'use strict';

/**
 * Money helpers.
 *
 * All monetary columns are DECIMAL(14,2). Arithmetic runs in integer minor units so
 * proration, discount and tax maths (SRS §12.3, §13.1) never accumulates float drift.
 */

const SCALE = 100;

/** Parse anything DB/JSON-ish into a safe number of major units. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

/** Major units → integer minor units (cents). */
function toMinor(value) {
  return Math.round(toNumber(value) * SCALE);
}

/** Integer minor units → major units, rounded to 2 dp. */
function toMajor(minor) {
  return Math.round(minor) / SCALE;
}

/** Round a major-unit amount to 2 dp. */
function round(value) {
  return toMajor(toMinor(value));
}

/** Sum any number of major-unit amounts without float drift. */
function sum(...values) {
  return toMajor(values.flat().reduce((acc, v) => acc + toMinor(v), 0));
}

function subtract(a, b) {
  return toMajor(toMinor(a) - toMinor(b));
}

/** Multiply a money amount by a plain quantity/factor. */
function multiply(amount, factor) {
  return toMajor(toMinor(amount) * toNumber(factor));
}

/** Percentage of an amount, e.g. percentageOf(1000, 15) === 150. */
function percentageOf(amount, percent) {
  return toMajor((toMinor(amount) * toNumber(percent)) / 100);
}

/** Never let a computed amount go below zero (discounts, remaining credit). */
function clampNonNegative(value) {
  const n = round(value);
  return n < 0 ? 0 : n;
}

/** Format for receipts/invoices/PDFs. */
function format(amount, currency = 'USD') {
  const n = round(amount);
  return `${currency} ${n.toFixed(2)}`;
}

/** DECIMAL columns come back as strings on some drivers; normalise for JSON output. */
function decimal(value) {
  return round(toNumber(value));
}

module.exports = {
  toNumber,
  toMinor,
  toMajor,
  round,
  sum,
  subtract,
  multiply,
  percentageOf,
  clampNonNegative,
  format,
  decimal,
};
