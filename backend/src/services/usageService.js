'use strict';

/**
 * Usage tracking and limit enforcement — SRS §11.2, FR-SUB-008, §21 (AI usage display),
 * §33 SaaS Engine ("Usage Tracking", "Overage").
 *
 * FR-SUB-008, verbatim: "System tracks usage against each configured limit. System blocks or
 * restricts actions that would exceed a Fixed limit."
 *
 * `entitlementService` answers what a school is *allowed*. This service answers what it has *used*,
 * and puts the two together into a decision.
 *
 * ## Four kinds of limit, measured four ways
 *
 * SRS §11.2 lists eight limits as one flat list, but they are not one kind of thing, and treating
 * them alike would produce wrong answers:
 *
 *   headcount    student_limit · teacher_limit · staff_limit · admin_limit
 *                A live count of rows in the source table. The decision counts them for real rather
 *                than trusting a stored counter, because a counter that has drifted either blocks a
 *                legitimate admission or admits a student past a paid-for cap — and both are silent.
 *                `usage_records` still carries a mirror row so the §9.1 and §21 dashboards can show
 *                "used / allowed" without counting four tables per page load.
 *
 *   cumulative   storage_limit · sms_limit
 *                A running total that does not reset. Deleting a file returns storage; a sent SMS is
 *                spent for good. Tracked against the subscription's own start date so there is one
 *                row per school per limit for the life of the subscription.
 *
 *   periodic     ai_limit · api_limit
 *                Resets at the start of each billing period — SRS §21's "Plan: 1000 AI Requests /
 *                Usage: 750" is a per-cycle allowance, not a lifetime one. Tracked against
 *                `subscriptions.current_period_start`, so a renewal starts a fresh row by
 *                construction rather than by a reset job that could fail to run.
 *
 *   per-request  file_upload_limit
 *                A ceiling on one file, not a quota. Nothing accumulates, so nothing is stored: the
 *                upload middleware asks `checkPerRequestLimit` and the answer depends only on the
 *                size of the file in hand. Writing this to `usage_records` would produce a number
 *                that means nothing — the sum of every file ever uploaded, compared against a
 *                per-file cap.
 *
 * ## Overage
 *
 * SRS §33 lists "Overage" as part of the SaaS engine, and `plan_limits` carries `allow_overage` plus
 * `overage_unit_amount` to configure it. A Fixed limit with overage allowed does not block: the
 * excess is recorded on the usage row and priced, and billing turns it into a `subscription_items`
 * line of type `overage`. A Fixed limit without overage blocks. Nothing here decides *policy* — it
 * reads `allow_overage` off the resolved limit, which came from the database.
 *
 * ## What this service does not do
 *
 * It does not invalidate the entitlement snapshot. Usage changes constantly and entitlement does not,
 * so they are cached separately: usage is read from the database on every check, entitlement from the
 * snapshot. That is the right way round — an allowance is worth caching, a counter is not.
 */

const { Op } = require('sequelize');

const db = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../config/logger');
const money = require('../utils/money');
const entitlementService = require('./entitlementService');
const {
  LIMITS,
  LIMIT_TYPES,
  LIMIT_UNITS,
  LIMIT_LABELS,
  USAGE_LIMIT_KEYS,
  HEADCOUNT_LIMITS,
  PERIODIC_LIMITS,
  STUDENT_STATUS,
  USER_STATUS,
  SCHOOL_ADMIN_ROLES,
} = require('../config/constants');

/** How a limit's usage is measured. See the header for why these differ. */
const MEASUREMENT = Object.freeze({
  HEADCOUNT: 'headcount',
  CUMULATIVE: 'cumulative',
  PERIODIC: 'periodic',
  PER_REQUEST: 'per_request',
});

/**
 * Limits that cap a single request rather than accumulating.
 *
 * Only `file_upload_limit` — SRS §11.2 names it "File Upload Limit", a per-file ceiling, and
 * `storage_limit` is the cumulative counterpart that already exists for total consumption. This is
 * kept here rather than in `constants.js` because it describes how this service measures a limit, not
 * anything the SRS enumerates.
 */
const PER_REQUEST_LIMITS = Object.freeze([LIMITS.FILE_UPLOAD_LIMIT]);

/**
 * Which source table a headcount limit counts, and the condition that makes a row count.
 *
 * The conditions are the ones the SRS implies by what each limit is for: a limit on students is a
 * limit on students currently enrolled (SRS §15.1 makes Promoted/Transferred/Left/Graduated separate
 * statuses), and a limit on staff is a limit on staff still employed (`is_active`, with `left_at` set
 * when they go).
 */
const HEADCOUNT_SOURCES = Object.freeze({
  [LIMITS.STUDENT_LIMIT]: {
    model: 'Student',
    where: { status: STUDENT_STATUS.ACTIVE },
    label: 'active students',
  },
  [LIMITS.TEACHER_LIMIT]: {
    model: 'Teacher',
    where: { is_active: true },
    label: 'active teachers',
  },
  [LIMITS.STAFF_LIMIT]: {
    model: 'Staff',
    where: { is_active: true },
    label: 'active staff',
  },
  /*
   * "Admin" is the SRS hierarchy's "Principals/Admins" tier, which `SCHOOL_ADMIN_ROLES` already
   * names. Counted from `users` by role rather than from a table of its own, because there is no
   * admins table — the role is what makes a user an admin.
   */
  [LIMITS.ADMIN_LIMIT]: {
    model: 'User',
    where: { status: USER_STATUS.ACTIVE },
    roleSlugs: SCHOOL_ADMIN_ROLES,
    label: 'active school administrators',
  },
});

/**
 * How a limit is measured.
 *
 * @param {string} limitKey
 * @returns {'headcount'|'cumulative'|'periodic'|'per_request'}
 */
function measurementFor(limitKey) {
  if (HEADCOUNT_LIMITS.includes(limitKey)) return MEASUREMENT.HEADCOUNT;
  if (PERIODIC_LIMITS.includes(limitKey)) return MEASUREMENT.PERIODIC;
  if (PER_REQUEST_LIMITS.includes(limitKey)) return MEASUREMENT.PER_REQUEST;
  return MEASUREMENT.CUMULATIVE;
}

/** BIGINT arrives from mysql2 as a string; nothing reaches arithmetic without passing through here. */
function toCount(value) {
  if (value === null || value === undefined || value === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * The `usage_records` period a limit is tracked against.
 *
 * The unique index is `(school_id, limit_key, period_start)`, so `period_start` is what decides
 * whether a write lands on the existing row or starts a new one. Periodic limits therefore use the
 * billing period's start — a renewal moves it, which is exactly the reset SRS §21 implies — and
 * everything else uses the subscription's own start, which never moves.
 *
 * @param {import('./entitlementService').EntitlementSnapshot} snapshot
 * @param {string} limitKey
 * @returns {{start: Date, end: Date|null}|null} null when the school has no subscription to track against
 */
function periodFor(snapshot, limitKey) {
  const { subscription } = snapshot;
  if (!subscription) return null;

  if (measurementFor(limitKey) === MEASUREMENT.PERIODIC) {
    const start = subscription.currentPeriodStart || subscription.startsAt;
    if (!start) return null;
    return {
      start: new Date(start),
      end: subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null,
    };
  }

  const start = subscription.startsAt || subscription.currentPeriodStart;
  if (!start) return null;
  return { start: new Date(start), end: null };
}

/**
 * Count a headcount limit's usage from its source table.
 *
 * @param {number} schoolId
 * @param {string} limitKey
 * @param {object} [transaction]  counts inside the caller's transaction — see `reserveHeadcount()`
 * @returns {Promise<number>}
 */
async function countHeadcount(schoolId, limitKey, transaction) {
  const source = HEADCOUNT_SOURCES[limitKey];
  if (!source) {
    throw new Error(`usageService.countHeadcount(): ${limitKey} is not a headcount limit`);
  }

  const model = db[source.model];
  if (!model) {
    throw new Error(`usageService.countHeadcount(): model ${source.model} is not registered`);
  }

  const query = { where: { school_id: schoolId, ...source.where } };
  if (transaction) query.transaction = transaction;

  if (source.roleSlugs) {
    query.include = [
      {
        model: db.Role,
        as: 'role',
        attributes: [],
        required: true,
        where: { slug: { [Op.in]: source.roleSlugs } },
      },
    ];
  }

  return model.count(query);
}

/**
 * Read the stored usage row for a limit, if one exists.
 *
 * @returns {Promise<object|null>}
 */
async function findUsageRow(schoolId, limitKey, periodStart) {
  return db.UsageRecord.findOne({
    where: { school_id: schoolId, limit_key: limitKey, period_start: periodStart },
    raw: true,
  });
}

/**
 * Compute overage for a fixed limit.
 *
 * @returns {{value: number, amount: number}}
 */
function overageFor(limit, used) {
  if (limit.type === LIMIT_TYPES.UNLIMITED) return { value: 0, amount: 0 };
  const allowed = limit.value === null ? 0 : limit.value;
  const excess = used - allowed;
  if (excess <= 0) return { value: 0, amount: 0 };
  if (!limit.allowOverage) {
    /* Recorded so a report can show the shortfall, but not priced: it was never permitted. */
    return { value: excess, amount: 0 };
  }
  const rate = limit.overageUnitAmount === null ? 0 : limit.overageUnitAmount;
  return { value: excess, amount: money.round(excess * rate) };
}

/**
 * A limit's current standing: allowance, usage, and what is left.
 *
 * @param {number} schoolId
 * @param {string} limitKey
 * @returns {Promise<{
 *   limitKey: string, label: string, unit: string|null, measurement: string,
 *   unlimited: boolean, allowed: number|null, used: number, remaining: number|null,
 *   overage: number, overageAmount: number, allowOverage: boolean,
 *   source: string, periodStart: string|null, periodEnd: string|null, tracked: boolean
 * }>}
 */
async function getUsage(schoolId, limitKey, transaction) {
  entitlementService.assertKnownLimitKeys([limitKey], 'usageService.getUsage');

  const snapshot = await entitlementService.getSnapshot(schoolId);
  const limit = snapshot.limits[limitKey];
  const measurement = measurementFor(limitKey);
  const unlimited = limit.type === LIMIT_TYPES.UNLIMITED;
  const allowed = unlimited ? null : limit.value;
  const period = periodFor(snapshot, limitKey);

  let used = 0;
  let tracked = true;

  if (measurement === MEASUREMENT.PER_REQUEST) {
    /* Nothing accumulates — see the header. `used` stays 0 and `remaining` is the whole allowance. */
    tracked = false;
  } else if (measurement === MEASUREMENT.HEADCOUNT) {
    used = await countHeadcount(schoolId, limitKey, transaction);
  } else if (period) {
    const row = await findUsageRow(schoolId, limitKey, period.start);
    used = row ? toCount(row.used_value) : 0;
  } else {
    /*
     * No subscription, so no period to track against. Usage reads as zero — and every fixed limit
     * resolves to zero too, so nothing is permitted anyway.
     */
    tracked = false;
  }

  const overage = overageFor(limit, used);

  return {
    limitKey,
    label: LIMIT_LABELS[limitKey] || limitKey,
    unit: limit.unit || LIMIT_UNITS[limitKey] || null,
    measurement,
    unlimited,
    allowed,
    used,
    remaining: unlimited ? null : Math.max(0, (allowed || 0) - used),
    overage: overage.value,
    overageAmount: overage.amount,
    allowOverage: limit.allowOverage,
    source: limit.source,
    periodStart: period ? period.start.toISOString() : null,
    periodEnd: period && period.end ? period.end.toISOString() : null,
    tracked,
  };
}

/**
 * Every limit's standing, for the SRS §9.1 Super Admin dashboard and the §21 AI usage display.
 *
 * @param {number} schoolId
 * @returns {Promise<Array<object>>}
 */
async function getUsageSummary(schoolId) {
  const results = [];
  for (const limitKey of USAGE_LIMIT_KEYS) {
    /* Sequential: headcount limits each hit a different table, and a school dashboard is not a hot
     * path. Parallelising would open four connections per page view for no useful gain. */
    // eslint-disable-next-line no-await-in-loop
    results.push(await getUsage(schoolId, limitKey));
  }
  return results;
}

/**
 * Would `increment` more of `limitKey` be permitted?
 *
 * @param {number} schoolId
 * @param {string} limitKey
 * @param {number} [increment]  units the caller is about to consume
 * @returns {Promise<{
 *   allowed: boolean, reason: string|null, limitKey: string, label: string,
 *   unit: string|null, limit: number|null, used: number, requested: number,
 *   remaining: number|null, unlimited: boolean, wouldOverage: number, overageAllowed: boolean
 * }>}
 */
async function checkLimit(schoolId, limitKey, increment = 1, transaction) {
  const requested = Number(increment);
  if (!Number.isFinite(requested) || requested < 0) {
    throw new Error(
      `usageService.checkLimit(): increment must be a non-negative number; received ${increment}`
    );
  }

  const usage = await getUsage(schoolId, limitKey, transaction);

  const base = {
    limitKey,
    label: usage.label,
    unit: usage.unit,
    limit: usage.allowed,
    used: usage.used,
    requested,
    remaining: usage.remaining,
    unlimited: usage.unlimited,
    wouldOverage: 0,
    overageAllowed: usage.allowOverage,
  };

  if (usage.unlimited) return { ...base, allowed: true, reason: null };

  const allowance = usage.allowed || 0;

  /*
   * A per-request limit compares the request against the allowance directly — a 12 MB file against a
   * 10 MB cap — rather than adding it to a total. `used` is 0 for these by construction.
   */
  const projected = usage.used + requested;
  if (projected <= allowance) return { ...base, allowed: true, reason: null };

  const wouldOverage = projected - allowance;

  if (usage.allowOverage && usage.measurement !== MEASUREMENT.PER_REQUEST) {
    /*
     * Overage is a billing arrangement, not a bigger cap, so it cannot apply to a per-request
     * ceiling: there is no sensible way to bill for "this one file was too large".
     */
    return { ...base, allowed: true, reason: 'overage', wouldOverage };
  }

  return { ...base, allowed: false, reason: 'limit_exceeded', wouldOverage };
}

/**
 * Refuse the action when it would exceed a Fixed limit — FR-SUB-008's "blocks or restricts".
 *
 * @param {number} schoolId
 * @param {string} limitKey
 * @param {number} [increment]
 * @returns {Promise<object>} the same result `checkLimit` returns, when permitted
 * @throws {ApiError} 403 PLAN_LIMIT_EXCEEDED
 */
async function assertWithinLimit(schoolId, limitKey, increment = 1, transaction) {
  const result = await checkLimit(schoolId, limitKey, increment, transaction);
  if (result.allowed) return result;

  /*
   * The numbers are returned deliberately. The school owns this data, and "Student Limit reached
   * (500 of 500 used)" is the message that leads to an upgrade; a bare "Forbidden" leads to a
   * support ticket. SRS §11.3 makes add-ons the intended remedy, which the school can only choose if
   * it is told what ran out.
   */
  throw ApiError.limitExceeded(
    `${result.label} reached. Your plan allows ${result.limit} ${result.unit || 'units'} and ` +
      `${result.used} ${result.used === 1 ? 'is' : 'are'} in use.`,
    {
      limitKey,
      limit: result.limit,
      used: result.used,
      requested: result.requested,
      remaining: result.remaining,
    }
  );
}

/**
 * Check a per-request ceiling — currently only `file_upload_limit`.
 *
 * Separate from `checkLimit` because the unit is the request itself: the caller passes the size of
 * the thing in hand, and no state is read or written.
 *
 * @param {number} schoolId
 * @param {string} limitKey
 * @param {number} size  in the limit's unit (megabytes for file_upload_limit)
 */
async function checkPerRequestLimit(schoolId, limitKey, size) {
  if (measurementFor(limitKey) !== MEASUREMENT.PER_REQUEST) {
    throw new Error(`usageService.checkPerRequestLimit(): ${limitKey} is not a per-request limit`);
  }
  return checkLimit(schoolId, limitKey, size);
}

/**
 * Record consumption of a cumulative or periodic limit.
 *
 * The increment is applied with SQL arithmetic (`used_value = used_value + n`) rather than a
 * read-modify-write, so two concurrent AI requests cannot both read 749 and both write 750.
 *
 * Headcount limits are not incremented — they are counted from their source table, and
 * `syncHeadcount` refreshes the reporting mirror after a create or delete.
 *
 * @param {number} schoolId
 * @param {string} limitKey
 * @param {number} [delta]  units consumed; may be negative for storage returned by a deletion
 * @returns {Promise<{used: number, allowed: number|null, overage: number, overageAmount: number}|null>}
 *          null when there is nothing to track against (no subscription)
 */
async function recordUsage(schoolId, limitKey, delta = 1) {
  entitlementService.assertKnownLimitKeys([limitKey], 'usageService.recordUsage');

  const amount = Number(delta);
  if (!Number.isFinite(amount)) {
    throw new Error(`usageService.recordUsage(): delta must be a number; received ${delta}`);
  }

  const measurement = measurementFor(limitKey);
  if (measurement === MEASUREMENT.HEADCOUNT) {
    throw new Error(
      `usageService.recordUsage(): ${limitKey} is a headcount limit — use syncHeadcount() instead`
    );
  }
  if (measurement === MEASUREMENT.PER_REQUEST) {
    throw new Error(
      `usageService.recordUsage(): ${limitKey} is a per-request limit and is not accumulated`
    );
  }

  const snapshot = await entitlementService.getSnapshot(schoolId);
  const period = periodFor(snapshot, limitKey);
  if (!period) {
    /*
     * Consumption by a school with no subscription. Nothing gates it here — whatever produced the
     * usage should have been refused earlier — but losing the record silently would hide that, so it
     * is logged rather than dropped without trace.
     */
    logger.warn('Usage recorded for a school with no subscription; nothing to track against', {
      schoolId,
      limitKey,
      delta: amount,
    });
    return null;
  }

  const limit = snapshot.limits[limitKey];
  const allowed = limit.type === LIMIT_TYPES.UNLIMITED ? null : limit.value;

  const [row] = await db.UsageRecord.findOrCreate({
    where: { school_id: schoolId, limit_key: limitKey, period_start: period.start },
    defaults: {
      school_id: schoolId,
      organization_id: snapshot.organizationId,
      subscription_id: snapshot.subscription.id,
      limit_key: limitKey,
      unit: limit.unit || LIMIT_UNITS[limitKey] || null,
      used_value: 0,
      allowed_value: allowed,
      period_start: period.start,
      period_end: period.end,
    },
  });

  if (amount !== 0) {
    await row.increment('used_value', { by: amount });
    await row.reload();
  }

  /*
   * A negative delta (storage returned) must not drive the counter below zero — that would make a
   * later overage calculation nonsense.
   */
  let used = toCount(row.get('used_value'));
  if (used < 0) {
    used = 0;
    row.set('used_value', 0);
  }

  const overage = overageFor(limit, used);

  row.set('allowed_value', allowed);
  row.set('overage_value', overage.value);
  row.set('overage_amount', overage.amount);
  row.set('last_incremented_at', new Date());
  /* Keep the period end current: a renewal extends it for periodic limits. */
  row.set('period_end', period.end);
  await row.save();

  return { used, allowed, overage: overage.value, overageAmount: overage.amount };
}

/**
 * Refresh the reporting mirror for a headcount limit.
 *
 * Called after a create, delete or status change on the source table. The decision path never reads
 * this row — `checkLimit` counts live — so a missed call costs a stale dashboard number, not a wrong
 * enforcement answer. That asymmetry is deliberate: the expensive guarantee is bought only where it
 * matters.
 *
 * @param {number} schoolId
 * @param {string} limitKey
 * @returns {Promise<{used: number, allowed: number|null}|null>}
 */
async function syncHeadcount(schoolId, limitKey) {
  entitlementService.assertKnownLimitKeys([limitKey], 'usageService.syncHeadcount');

  if (measurementFor(limitKey) !== MEASUREMENT.HEADCOUNT) {
    throw new Error(`usageService.syncHeadcount(): ${limitKey} is not a headcount limit`);
  }

  const snapshot = await entitlementService.getSnapshot(schoolId);
  const period = periodFor(snapshot, limitKey);
  if (!period) return null;

  const limit = snapshot.limits[limitKey];
  const allowed = limit.type === LIMIT_TYPES.UNLIMITED ? null : limit.value;
  const used = await countHeadcount(schoolId, limitKey);
  const overage = overageFor(limit, used);

  const [row] = await db.UsageRecord.findOrCreate({
    where: { school_id: schoolId, limit_key: limitKey, period_start: period.start },
    defaults: {
      school_id: schoolId,
      organization_id: snapshot.organizationId,
      subscription_id: snapshot.subscription.id,
      limit_key: limitKey,
      unit: limit.unit || LIMIT_UNITS[limitKey] || null,
      used_value: used,
      allowed_value: allowed,
      period_start: period.start,
      period_end: period.end,
    },
  });

  row.set('used_value', used);
  row.set('allowed_value', allowed);
  row.set('overage_value', overage.value);
  row.set('overage_amount', overage.amount);
  row.set('period_end', period.end);
  row.set('last_incremented_at', new Date());
  await row.save();

  return { used, allowed };
}

/** Refresh every headcount mirror for a school — after a bulk import or a restored backup. */
async function syncAllHeadcounts(schoolId) {
  const results = {};
  for (const limitKey of HEADCOUNT_LIMITS) {
    // eslint-disable-next-line no-await-in-loop
    results[limitKey] = await syncHeadcount(schoolId, limitKey);
  }
  return results;
}

/**
 * Every headcount mirror for **every school** — the shape the `sync_usage` job actually needs.
 *
 * `syncAllHeadcounts(schoolId)` reconciles all the limit *keys* for one school; "All" was never about
 * schools. `handlers/index.js` registered the job as `() => syncAllHeadcounts()` with no argument, so
 * `schoolId` arrived `undefined` and the first `syncHeadcount()` would have counted rows for no
 * school. It never fired — nothing enqueues `sync_usage` — but the handler's own docblock says the job
 * "touches every school", and that is what this does.
 *
 * A school whose sync throws does not stop the others: a reconciliation pass that abandons the
 * remaining schools because one is broken is worse than one that reports which failed. The failures
 * are returned rather than swallowed.
 */
async function syncAllSchoolHeadcounts() {
  const schools = await db.School.findAll({ attributes: ['id'], order: [['id', 'ASC']], raw: true });
  const synced = {};
  const failed = {};

  for (const school of schools) {
    try {
      // eslint-disable-next-line no-await-in-loop
      synced[school.id] = await syncAllHeadcounts(school.id);
    } catch (err) {
      failed[school.id] = err.message;
    }
  }

  return { schools: schools.length, synced, failed };
}

/**
 * Check a **headcount** limit inside the caller's own transaction, holding a lock that makes the
 * check and the write that follows it one atomic step — Known Issues #21.
 *
 * ## The defect this closes, reproduced before it was written
 *
 * `enforceLimit` is express middleware: it counts, decides, and returns, and only then does the
 * handler open a transaction and write. Two requests can both pass a ceiling of N and leave the
 * school at N+1. Measured at the service layer against `msms_test` with `student_limit = 1` and
 * eight concurrent admissions: **eight admitted, eight rows written**, three runs out of three.
 *
 * ## Why the lock is on `schools` and not on the subscription
 *
 * A previous plan proposed locking the subscription row and justified it with "it is one row per
 * school", which is false — `subscriptions.school_id` is a **non-unique** index and a school
 * accumulates cancelled and expired rows beside its live one, so a lock without an `order` and a
 * state filter can lock a different row in each of two concurrent requests and serialise nothing.
 *
 * `schools.id` is the primary key. There is exactly one row, it always exists (the caller is already
 * scoped to it), and locking it serialises admissions **for that school only** — two schools admitting
 * at once are unaffected, which is the whole of what this needs to do.
 *
 * ## The order of the two statements is load-bearing
 *
 * The locking read comes first and the count second, and under InnoDB's REPEATABLE READ that is not
 * interchangeable. A locking read is a *current* read and does **not** establish the transaction's
 * consistent snapshot; the first plain `SELECT` does. So taking the lock first means the snapshot is
 * established after the lock is granted — that is, after any competing transaction has committed —
 * and the count therefore sees its row. Counting first would fix the snapshot before the lock and
 * the count would miss exactly the write this exists to see.
 *
 * That is also why this must be the **first** thing the caller's transaction does. A plain read
 * before it establishes the snapshot early and reintroduces the defect silently.
 *
 * ## What it does not cover
 *
 * `ai_limit` — the fourth racing key — is deliberately out of scope **for this function**, because its
 * window is an entire LLM provider round trip and holding a row lock across a call to a third party is
 * a worse failure than the one it fixes. It is closed instead by `reserveUsage()` / `releaseUsage()`
 * below, which take no lock at all.
 *
 * @param {number} schoolId
 * @param {string} limitKey   a HEADCOUNT limit; anything else is a programming error
 * @param {number} increment
 * @param {object} transaction  the caller's transaction, which must not have read anything yet
 * @returns {Promise<object>} the same shape `assertWithinLimit` returns
 */
async function reserveHeadcount(schoolId, limitKey, increment, transaction) {
  if (measurementFor(limitKey) !== MEASUREMENT.HEADCOUNT) {
    throw new Error(
      `usageService.reserveHeadcount(): ${limitKey} is not a headcount limit`
    );
  }
  if (!transaction) {
    throw new Error('usageService.reserveHeadcount(): a transaction is required');
  }

  /*
   * The serialisation point. `findByPk` with `lock` emits `SELECT … FOR UPDATE`; a school that has
   * vanished between the request's scoping and here is a 404 the caller already models, so the
   * absence is left to the write that follows rather than invented here.
   */
  await db.School.findByPk(schoolId, { transaction, lock: transaction.LOCK.UPDATE });

  return assertWithinLimit(schoolId, limitKey, increment, transaction);
}

/**
 * Consume an accumulating allowance **before** the work it pays for — the other half of Known
 * Issues #21, and the half `reserveHeadcount()` above cannot do.
 *
 * ## Why a lock is the wrong instrument here
 *
 * `ai_limit` is the fourth racing key, and its critical section is not a transaction — it is an entire
 * LLM provider round trip. `enforceLimit` reads the counter, the driver is called, and only then does
 * `recordUsage` increment: two requests at 999 of 1000 both pass, both generate, and the school lands
 * at 1001. Widening `reserveHeadcount()` to cover it would hold a `schools` row lock across a network
 * call to a third party, which blocks every other write for that school for as long as the provider
 * takes and turns a provider outage into a database pile-up. That is a worse failure than the one it
 * fixes, which is why this is a different function rather than another caller of that one.
 *
 * ## Reserve, then refund — and why it needs no new table
 *
 * A reservation is just the increment, moved to the front and made conditional. The whole of it is one
 * statement:
 *
 *     UPDATE usage_records SET used_value = used_value + :n
 *      WHERE id = :id AND used_value + :n <= :allowance
 *
 * MariaDB takes the row lock for the duration of that single statement and releases it at once, so two
 * concurrent requests are serialised against each other and neither waits on a provider. The statement
 * reports how many rows it changed; **zero means the allowance is gone**, and no read-then-write window
 * exists in which the answer could go stale. The counter is the reservation, which is why the design
 * needs no reservation table — §29 fixes the schema at 64 tables and §35 forbids inventing a 65th.
 *
 * `releaseUsage()` is the refund, for a provider that failed or a commit that did not happen, and it is
 * `recordUsage()` with a negative delta: that path already exists for storage returned by a deletion,
 * and already floors the counter at zero.
 *
 * ## Two cases where there is nothing to reserve, and both increment unconditionally
 *
 * **Unlimited**, because there is no ceiling to hold anything against; and **overage allowed**, because
 * §11.2 makes exceeding a soft limit a billing arrangement rather than a refusal — `checkLimit()`
 * returns `allowed: true, reason: 'overage'` for exactly this case, and a reservation that refused
 * would enforce a rule the plan does not have. The two are read from the resolved snapshot, not from
 * `usage_records.allowed_value`, which is a **denormalised copy** that a mid-period plan change leaves
 * stale.
 *
 * @param {number} schoolId
 * @param {string} limitKey  a CUMULATIVE or PERIODIC limit; anything else is a programming error
 * @param {number} [delta]   units to reserve, positive
 * @returns {Promise<object|null>} the same shape `recordUsage` returns; null when the school has no
 *                                 subscription to track against, exactly as `recordUsage` does
 * @throws {ApiError} 403 PLAN_LIMIT_EXCEEDED when the allowance is already spent
 */
async function reserveUsage(schoolId, limitKey, delta = 1) {
  entitlementService.assertKnownLimitKeys([limitKey], 'usageService.reserveUsage');

  const amount = Number(delta);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      `usageService.reserveUsage(): delta must be a positive number; received ${delta}`
    );
  }

  const measurement = measurementFor(limitKey);
  if (measurement === MEASUREMENT.HEADCOUNT) {
    throw new Error(
      `usageService.reserveUsage(): ${limitKey} is a headcount limit — use reserveHeadcount() instead`
    );
  }
  if (measurement === MEASUREMENT.PER_REQUEST) {
    throw new Error(
      `usageService.reserveUsage(): ${limitKey} is a per-request limit and is not accumulated`
    );
  }

  const snapshot = await entitlementService.getSnapshot(schoolId);
  const period = periodFor(snapshot, limitKey);
  /*
   * No subscription. `recordUsage` logs and returns null here rather than throwing, because whatever
   * produced the usage should have been refused earlier; the same answer is given for the same reason,
   * so a caller cannot tell the two apart and start relying on one of them.
   */
  if (!period) return recordUsage(schoolId, limitKey, amount);

  const limit = snapshot.limits[limitKey];
  const unlimited = limit.type === LIMIT_TYPES.UNLIMITED;
  if (unlimited || limit.allowOverage) return recordUsage(schoolId, limitKey, amount);

  const allowance = limit.value || 0;

  /*
   * The row has to exist before it can be updated conditionally. `findOrCreate` is the same call
   * `recordUsage` makes, and creating it with `used_value: 0` reserves nothing by itself — the
   * conditional UPDATE below is the only thing that moves the counter.
   */
  const [row] = await db.UsageRecord.findOrCreate({
    where: { school_id: schoolId, limit_key: limitKey, period_start: period.start },
    defaults: {
      school_id: schoolId,
      organization_id: snapshot.organizationId,
      subscription_id: snapshot.subscription.id,
      limit_key: limitKey,
      unit: limit.unit || LIMIT_UNITS[limitKey] || null,
      used_value: 0,
      allowed_value: allowance,
      period_start: period.start,
      period_end: period.end,
    },
  });

  const [, affected] = await db.sequelize.query(
    'UPDATE usage_records SET used_value = used_value + :amount, last_incremented_at = NOW() ' +
      'WHERE id = :id AND used_value + :amount <= :allowance',
    {
      replacements: { amount, id: row.id, allowance },
      type: db.sequelize.QueryTypes.UPDATE,
    }
  );

  /*
   * `affected` is 0 when the row no longer satisfies the predicate — which is the refusal, and the
   * only one this function makes. The numbers in the message are re-read rather than taken from the
   * snapshot above, so they describe the state that actually refused the request rather than the state
   * it was checked against.
   */
  if (!affected) return assertWithinLimit(schoolId, limitKey, amount);

  await row.reload();
  const used = toCount(row.get('used_value'));
  const overage = overageFor(limit, used);
  row.set('allowed_value', allowance);
  row.set('overage_value', overage.value);
  row.set('overage_amount', overage.amount);
  row.set('period_end', period.end);
  await row.save();

  return { used, allowed: allowance, overage: overage.value, overageAmount: overage.amount };
}

/**
 * Give a reservation back — the refund half of `reserveUsage()`.
 *
 * A thin, named wrapper rather than leaving callers to write `recordUsage(id, key, -n)`: the negative
 * delta reads as an accident at a call site, and a refund that is written by hand is a refund somebody
 * will eventually forget the sign on. `recordUsage` already floors the counter at zero.
 *
 * @param {number} schoolId
 * @param {string} limitKey
 * @param {number} [delta]  units to give back, positive
 * @returns {Promise<object|null>}
 */
async function releaseUsage(schoolId, limitKey, delta = 1) {
  const amount = Number(delta);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      `usageService.releaseUsage(): delta must be a positive number; received ${delta}`
    );
  }
  return recordUsage(schoolId, limitKey, -amount);
}

module.exports = {
  getUsage,
  getUsageSummary,
  checkLimit,
  assertWithinLimit,
  reserveHeadcount,
  reserveUsage,
  releaseUsage,
  checkPerRequestLimit,
  recordUsage,
  syncHeadcount,
  syncAllHeadcounts,
  syncAllSchoolHeadcounts,
  countHeadcount,
  measurementFor,
  periodFor,
  MEASUREMENT,
  PER_REQUEST_LIMITS,
  HEADCOUNT_SOURCES,
};
