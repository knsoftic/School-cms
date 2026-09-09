'use strict';

/**
 * Super Admin dashboard metrics — SRS §9.1 and FR-SADMIN-001.
 *
 * The source names eleven figures and does not define any of them. Every reading below is therefore a
 * decision, and each one is recorded here so that a later disagreement is a disagreement about a stated
 * choice rather than an argument with unexplained SQL.
 *
 * | §9.1 metric            | Reading                                                                    |
 * |------------------------|----------------------------------------------------------------------------|
 * | Total Organizations    | `COUNT(organizations)` — soft-deleted rows excluded (the model is paranoid) |
 * | Total Schools          | `COUNT(schools)`, all three statuses                                        |
 * | Active Schools         | `COUNT(schools WHERE status='active')`                                      |
 * | Suspended Schools      | `COUNT(schools WHERE status='suspended')`                                   |
 * | Total Students         | `COUNT(students)`, every `STUDENT_STATUS`                                   |
 * | Total Teachers         | `COUNT(teachers)`, active and inactive                                      |
 * | Active Subscriptions   | `COUNT(subscriptions WHERE state='active')`                                 |
 * | Expired Subscriptions  | `COUNT(subscriptions WHERE state='expired')`                                |
 * | Monthly Revenue        | `SUM(payments.amount WHERE status='approved')` in the current calendar month |
 * | Yearly Revenue         | the same, current calendar year                                             |
 * | Pending Payments       | `COUNT(payments WHERE status='pending')`                                     |
 *
 * ## The three readings worth arguing about
 *
 *  - **Total Students / Total Teachers are not filtered by status.** "Total" is read as the total, and a
 *    dashboard line that silently means "active only" while a sibling line says "Active Schools"
 *    explicitly would be inconsistent with the source's own naming. `students.status` has six values and
 *    `teachers.is_active` is a boolean; a filter here would have to pick some of them, which the source
 *    does not do. Per-status figures belong to §22's reports, which specify them.
 *
 *  - **Active / Expired Subscriptions are the literal states, not the usable set.** SRS §12 defines
 *    `SUBSCRIPTION_USABLE_STATES` as trial, active, expiring, past_due and grace_period, and it would be
 *    defensible to call all five "active". It is not done, because §9.1 lists *"Active Subscriptions"* and
 *    *"Expired Subscriptions"* as two lines out of a ten-state model: reading them as anything but
 *    `state='active'` and `state='expired'` would make the two figures fail to add up to a number the
 *    operator can check against the subscriptions list.
 *
 *  - **Pending Payments is a count, not an amount.** The metric sits in a list of nine counts and two
 *    explicitly-named revenue figures ("Monthly Revenue", "Yearly Revenue"). A third amount would have
 *    been named like the other two. It is the number of payments awaiting the §13.3 approve/reject
 *    decision — the actionable reading, since the operator's next step is to go and review them. The
 *    total amount awaiting review is returned alongside it as `pendingPaymentsAmount`, so nothing is
 *    lost by the choice.
 *
 * ## Dating a payment
 *
 * Revenue is dated by `COALESCE(paid_at, created_at)`. `payments.paid_at` is nullable — a manual bank
 * transfer recorded by an accountant may be approved days after the money moved — so a period filter on
 * `paid_at` alone would drop every approved payment that never got one. Falling back to `created_at`
 * counts each approved payment in exactly one period and never drops one.
 *
 * ## Scope
 *
 * FR-SADMIN-001's actor is the Super Admin and its figures are platform-wide, which is what a platform
 * caller gets: `tenantWhere()` adds no condition and the two explicit scope helpers return `{}`.
 * `DEFAULT_ROLE_PERMISSIONS` also grants `organization_admin` the `platform.dashboard.view` key, and for
 * that caller the figures are narrowed by the same helpers. Same eleven metrics, same code path, scope
 * decided by `req.tenant` — no second implementation.
 *
 * "Narrowed to their own organization" is the usual case rather than the rule, and this comment used
 * to state it as the rule. `tenantWhere()` (`models/index.js:659-667`) checks `tenant.schoolId`
 * **first** and returns on it — "an explicit school scope always wins, including for a Super Admin who
 * selected a school" — so a caller carrying a school scope gets school-scoped figures whatever their
 * organization is. Organization scope applies only when no school scope is set.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const money = require('../../utils/money');
const organizationsService = require('../organizations/organizations.service');
const schoolsService = require('../schools/schools.service');
const { periodRange } = require('../../utils/dates');
const {
  SCHOOL_STATUS,
  SUBSCRIPTION_STATES,
  PAYMENT_STATUS,
} = require('../../config/constants');

const { tenantWhere } = db;

/**
 * `WHERE` for a payment that counts as revenue in `[from, to]`.
 *
 * @param {object} base  the tenant-scoped fragment to extend
 * @param {{from: Date, to: Date}} range
 * @returns {object}
 */
function revenueWhere(base, range) {
  return {
    ...base,
    status: PAYMENT_STATUS.APPROVED,
    [Op.or]: [
      { paid_at: { [Op.between]: [range.from, range.to] } },
      /* Approved but never stamped — dated by when it was recorded. See the header. */
      { paid_at: null, created_at: { [Op.between]: [range.from, range.to] } },
    ],
  };
}

/**
 * `SUM(amount)` as a number.
 *
 * `Model.sum()` returns `null` for an empty set, and MariaDB hands DECIMAL back to mysql2 as a string,
 * so both are normalised here rather than at each of the two call sites. Rounded to the currency scale
 * `utils/money` works in, so a summed column cannot surface a floating-point tail.
 *
 * @param {object} where
 * @returns {Promise<number>}
 */
async function sumPayments(where) {
  const total = await db.Payment.sum('amount', { where });
  return money.round(money.toNumber(total));
}

/**
 * The eleven §9.1 figures, plus the two derived extras the metrics above make free.
 *
 * @param {object} tenant  `req.tenant`
 * @param {Date} [reference]  the instant the month and year are taken from; defaults to now.
 *        Injectable so a verification run can assert a known period instead of racing midnight on
 *        the 1st of January.
 * @returns {Promise<object>}
 */
async function getDashboard(tenant, reference) {
  const at = reference || new Date();

  const organizationScope = organizationsService.scopeFor(tenant);
  const schoolScope = schoolsService.scopeFor(tenant);
  const rowScope = tenantWhere(tenant, {}, { allowPlatformWide: true });

  const monthly = periodRange('monthly', at);
  const yearly = periodRange('yearly', at);

  /*
   * Issued together. Eleven independent aggregates against a pool that `config/database.js` sizes for
   * concurrency is the case a connection pool exists for, and running them in series would make the
   * dashboard's latency the sum of eleven round trips instead of the slowest one.
   */
  const [
    totalOrganizations,
    totalSchools,
    activeSchools,
    suspendedSchools,
    archivedSchools,
    totalStudents,
    totalTeachers,
    activeSubscriptions,
    expiredSubscriptions,
    monthlyRevenue,
    yearlyRevenue,
    pendingPayments,
    pendingPaymentsAmount,
  ] = await Promise.all([
    db.Organization.count({ where: organizationScope }),
    db.School.count({ where: schoolScope }),
    db.School.count({ where: { ...schoolScope, status: SCHOOL_STATUS.ACTIVE } }),
    db.School.count({ where: { ...schoolScope, status: SCHOOL_STATUS.SUSPENDED } }),
    /* Not a §9.1 line. Included because Total minus Active minus Suspended is otherwise an unexplained
     * remainder on the screen, and `schools.status` has exactly three values. */
    db.School.count({ where: { ...schoolScope, status: SCHOOL_STATUS.ARCHIVED } }),
    db.Student.count({ where: rowScope }),
    db.Teacher.count({ where: rowScope }),
    db.Subscription.count({ where: { ...rowScope, state: SUBSCRIPTION_STATES.ACTIVE } }),
    db.Subscription.count({ where: { ...rowScope, state: SUBSCRIPTION_STATES.EXPIRED } }),
    sumPayments(revenueWhere(rowScope, monthly)),
    sumPayments(revenueWhere(rowScope, yearly)),
    db.Payment.count({ where: { ...rowScope, status: PAYMENT_STATUS.PENDING } }),
    sumPayments({ ...rowScope, status: PAYMENT_STATUS.PENDING }),
  ]);

  return {
    /* The eleven, in the order SRS §9.1 lists them. */
    totalOrganizations,
    totalSchools,
    activeSchools,
    suspendedSchools,
    totalStudents,
    totalTeachers,
    activeSubscriptions,
    expiredSubscriptions,
    monthlyRevenue,
    yearlyRevenue,
    pendingPayments,

    /* Derived from the same queries; not part of §9.1's list. */
    archivedSchools,
    pendingPaymentsAmount,

    /*
     * The periods the two revenue figures cover, so the number on the screen is checkable and a client
     * never has to reconstruct which month "Monthly Revenue" meant.
     */
    period: {
      month: { from: monthly.from, to: monthly.to },
      year: { from: yearly.from, to: yearly.to },
    },
    scope: {
      level: tenant.level,
      organizationId: tenant.organizationId || null,
      schoolId: tenant.schoolId || null,
    },
  };
}

module.exports = { getDashboard, revenueWhere, sumPayments };
