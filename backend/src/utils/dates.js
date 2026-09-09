'use strict';

/**
 * Date helpers for billing cycles, trials, grace periods and attendance periods
 * (SRS §10.3, §12.1, §12.2, §16).
 *
 * All computation is done in UTC. Schools carry a Timezone setting (SRS §14.1) used for
 * presentation; storage and comparison stay in UTC so cross-tenant reporting is consistent.
 */

const { BILLING_CYCLES, BILLING_CYCLE_DAYS } = require('../config/constants');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Coerce to a Date; returns null for unparseable input. */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function now() {
  return new Date();
}

/** Midnight UTC of the given date. */
function startOfDay(value = new Date()) {
  const d = toDate(value) || new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** 23:59:59.999 UTC of the given date. */
function endOfDay(value = new Date()) {
  const d = startOfDay(value);
  return new Date(d.getTime() + MS_PER_DAY - 1);
}

function addDays(value, days) {
  const d = toDate(value) || new Date();
  return new Date(d.getTime() + days * MS_PER_DAY);
}

/** Calendar-aware month arithmetic; clamps to the last valid day (31 Jan +1m → 28/29 Feb). */
function addMonths(value, months) {
  const d = toDate(value) || new Date();
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())
  );
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/** Whole days between two dates (b − a), truncated. */
function daysBetween(a, b) {
  const from = toDate(a);
  const to = toDate(b);
  if (!from || !to) return 0;
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** Days from now until `value`; negative when already past. */
function daysUntil(value) {
  return daysBetween(new Date(), value);
}

function isPast(value) {
  const d = toDate(value);
  return d ? d.getTime() < Date.now() : false;
}

/** `YYYY-MM-DD` — the format used by DATEONLY columns and report filters. */
function toDateOnly(value = new Date()) {
  const d = toDate(value) || new Date();
  return d.toISOString().slice(0, 10);
}

function startOfMonth(value = new Date()) {
  const d = toDate(value) || new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfMonth(value = new Date()) {
  const d = toDate(value) || new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

function startOfYear(value = new Date()) {
  const d = toDate(value) || new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

function endOfYear(value = new Date()) {
  const d = toDate(value) || new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
}

/**
 * Advance a period start by one billing cycle (SRS §10.3).
 * Calendar cycles use month arithmetic so a monthly subscription always bills on the
 * same day-of-month rather than drifting by the 30-day approximation.
 *
 * @param {Date|string} start
 * @param {string} cycle           one of BILLING_CYCLES
 * @param {number|null} customDays required when cycle === 'custom_days'
 * @returns {Date|null}            null for 'one_time' (no next period)
 */
function addBillingCycle(start, cycle, customDays = null) {
  const from = toDate(start) || new Date();
  switch (cycle) {
    case BILLING_CYCLES.WEEKLY:
      return addDays(from, 7);
    case BILLING_CYCLES.MONTHLY:
      return addMonths(from, 1);
    case BILLING_CYCLES.QUARTERLY:
      return addMonths(from, 3);
    case BILLING_CYCLES.SIX_MONTHS:
      return addMonths(from, 6);
    case BILLING_CYCLES.YEARLY:
      return addMonths(from, 12);
    case BILLING_CYCLES.CUSTOM_DAYS: {
      const days = Number(customDays);
      if (!Number.isInteger(days) || days < 1) {
        throw new Error('custom_days billing cycle requires a positive cycle_days value');
      }
      return addDays(from, days);
    }
    case BILLING_CYCLES.ONE_TIME:
      return null;
    default:
      throw new Error(`Unknown billing cycle "${cycle}"`);
  }
}

/**
 * Nominal length of a cycle in days — used as the denominator for proration (SRS §12.3).
 * Calendar cycles report their actual length for the specific period being prorated.
 */
function billingCycleDays(cycle, customDays = null, periodStart = new Date()) {
  if (cycle === BILLING_CYCLES.CUSTOM_DAYS) {
    const days = Number(customDays);
    return Number.isInteger(days) && days > 0 ? days : 0;
  }
  if (cycle === BILLING_CYCLES.ONE_TIME) return 0;

  const end = addBillingCycle(periodStart, cycle, customDays);
  if (!end) return BILLING_CYCLE_DAYS[cycle] || 0;
  const actual = daysBetween(periodStart, end);
  return actual > 0 ? actual : BILLING_CYCLE_DAYS[cycle] || 0;
}

/** Weekday key for a date, matching WEEKDAYS in constants. */
function weekdayOf(value = new Date()) {
  const d = toDate(value) || new Date();
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d.getUTCDay()];
}

/**
 * Resolve a report period into an inclusive [from, to] range.
 * @param {'daily'|'monthly'|'yearly'} period
 * @param {Date|string} reference
 */
function periodRange(period, reference = new Date()) {
  switch (period) {
    case 'daily':
      return { from: startOfDay(reference), to: endOfDay(reference) };
    case 'monthly':
      return { from: startOfMonth(reference), to: endOfMonth(reference) };
    case 'yearly':
      return { from: startOfYear(reference), to: endOfYear(reference) };
    default:
      throw new Error(`Unknown period "${period}"`);
  }
}

module.exports = {
  MS_PER_DAY,
  toDate,
  now,
  startOfDay,
  endOfDay,
  addDays,
  addMonths,
  daysBetween,
  daysUntil,
  isPast,
  toDateOnly,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear,
  addBillingCycle,
  billingCycleDays,
  weekdayOf,
  periodRange,
};
