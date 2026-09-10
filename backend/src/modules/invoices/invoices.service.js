'use strict';

/**
 * Invoices — SRS §13.1, FR-BILL-001. Also §33's SaaS Engine entries *Invoices*, *Discounts* and
 * *Overage*, which have no field lists of their own and are therefore derived from columns.
 *
 * `/subscriptions` puts a school on a plan and computes what a cycle costs. This module turns that
 * into a document with a number on it, and it is the only file that writes `invoices` totals.
 *
 * ## §13.1's eleven fields, and the column each one is
 *
 * | §13.1 field    | Column(s)                                             |
 * |----------------|-------------------------------------------------------|
 * | Invoice Number | `invoice_number` — `utils/documentNumber.js`           |
 * | School         | `school_id`, `organization_id`                         |
 * | Plan           | `plan_id`, `plan_name` (*"Snapshot at issue time"*)    |
 * | Add-ons        | `addons_summary` json, plus `invoice_items` rows       |
 * | Billing Period | `billing_period_start`, `billing_period_end`           |
 * | Subtotal       | `subtotal`                                            |
 * | Discount       | `discount_amount`, `coupon_id`, `coupon_code`          |
 * | Tax            | `tax_amount`, `tax_id`, `tax_rate_percent`             |
 * | Total          | `total`                                               |
 * | Due Date       | `due_date`                                            |
 * | Status         | `status`                                              |
 *
 * All eleven are written by `issue()`. `amount_paid`, `amount_due`, `credit_applied`, `paid_at`,
 * `cancelled_at` and `reminder_sent_at` are not §13.1 fields — they are the columns that let the
 * document have a *life* after issue, and each is written by exactly one function below.
 *
 * ## The order of operations is §13.1's own field order
 *
 * Subtotal → Discount → Tax → Total. So tax is charged on the **discounted** amount, not the subtotal.
 * The document lists the four in that sequence and gives no formula; a list in that order with Total
 * last is the only reading under which Total is the sum of what precedes it.
 *
 * Credit is applied *after* Total, and is therefore **not** a line item even though
 * `invoice_items.item_type` offers `credit`. Two reasons, and the second is the decisive one:
 * a negative line inside `subtotal` would shrink the tax base, and
 * `subscriptions.service.prorate()` already returns `amountDue = prorationDue − creditApplied` —
 * credit applied last. A second convention here would make the same credit worth a different amount
 * depending on which file computed it. `credit_applied` is the column of record; `item_type: 'credit'`
 * stays unused, available for a credit note the SRS does not currently describe.
 *
 * ## Inclusive tax is why `total` is not always `subtotal − discount + tax_amount`
 *
 * `taxes.quoteFor()` returns `addedAmount: 0` for an inclusive tax and reports the contained portion
 * separately, because `taxes.is_inclusive`'s own column comment is *"true = the listed price already
 * contains this tax"*. So an inclusive tax leaves `total` equal to the discounted subtotal and records
 * the contained figure in `tax_amount` for the printed breakdown. The invariant that always holds is
 * `total = subtotal − discount_amount + (inclusive ? 0 : tax_amount)`, and `computeTotals()` is the
 * only place it is evaluated.
 *
 * ## Which subscription items land on which invoice
 *
 * `subscription_items.is_recurring` is the discriminator, and it already carries the right answer:
 * `subscriptions.service.create()` writes the plan line with
 * `is_recurring: price.billing_cycle !== ONE_TIME` and the setup-fee line with `is_recurring: false`
 * and the comment *"One-off by definition"*. So a school's **first** invoice takes every item and a
 * **renewal** invoice takes only the recurring ones — which is what makes a setup fee charged once.
 * Nothing here re-derives that from the item type.
 *
 * ## Overage — §33's entry, billed from `usage_records`
 *
 * `usageService` already computes and stores it: `plan_limits.overage_unit_amount` × the excess, landing
 * in `usage_records.overage_value` and `overage_amount` on every `recordUsage()` and `syncHeadcount()`.
 * So overage billing is not a calculation this module performs — it is a **read**, turned into one
 * `item_type: 'overage'` line per limit key with a non-zero amount.
 *
 * `usage_records` has no `invoiced_at` column and SRS §35 forbids adding one, so nothing marks a usage
 * row as billed. The double-billing guard is therefore the invoice itself: `alreadyBilled()` refuses a
 * second live invoice for the same subscription and billing period, and each overage line records its
 * `usage_record_id` in `invoice_items.metadata` so the trail from row to line is readable. This is a
 * real constraint of the fixed schema and is stated rather than papered over: an operator who cancels an
 * invoice and re-issues it for the same period gets the same overage again, which is correct, and an
 * operator who issues two invoices for one period is refused with `INVOICE_PERIOD_ALREADY_BILLED`.
 *
 * ## Due date
 *
 * §13.1 names *Due Date* and nothing anywhere fixes the payment term. It is taken as
 * `issue_date + subscription.grace_period_days`. There is **no default**: `issue()` refuses a spec
 * carrying neither `dueDate` nor a numeric `dueDays`, because §13.1 states no billing term and a
 * fallback would be an invented business rule. This paragraph previously said the fallback was
 * `GRACE_PERIOD_DAYS`, which was both wrong and undetectable — that constant is §12.2's preset
 * *list* `[1, 3, 7, 15]`, so the arithmetic produced an `Invalid Date` and `toDateOnly()` quietly
 * substituted today, making the invoice due the moment it was raised. That number is on the subscription row already (§12.7) and governs when an unpaid
 * school is suspended, so tying the two together means the invoice falls overdue exactly when the
 * tolerance for it running unpaid ends. An `INVOICE_DUE_DAYS` setting would be inventing configuration;
 * a caller may still pass an explicit `due_date`, which is what a negotiated term looks like.
 *
 * ## Status, and who moves it
 *
 * `INVOICE_STATUS` is `draft, unpaid, partially_paid, paid, overdue, cancelled, refunded`. Every edge
 * has exactly one writer:
 *
 *  - `draft → unpaid` — `finalise()`. Requests, `invoices.manage`.
 *  - `unpaid → cancelled` (and from `partially_paid`/`overdue`/`draft`) — `cancel()`.
 *  - `unpaid → partially_paid → paid` — `applyPayment()`, called **only** by `payments.service` on
 *    approval. Never by a request of its own: a status that could be typed in would make
 *    `amount_paid` a claim rather than a sum of approved payments.
 *  - `unpaid|partially_paid → overdue` — `markOverdue()`. The clock's, so no route.
 *  - `paid → refunded` — `applyRefund()`, called only by `refunds`.
 *
 * `draft` exists so an invoice can be assembled and checked before a school sees it, which is also why
 * `applyCoupon()` accepts `draft` and `unpaid` and nothing later.
 *
 * ## FR-BILL-005's last bullet is a route in *this* module
 *
 * *"School applies a valid coupon to an invoice/subscription."* — so applying a coupon to an existing
 * invoice is required behaviour, not an extra. `applyCoupon()` is the only caller of
 * `coupons.service.redeem()` besides `issue()`, and both write `coupon_usages` with the `invoice_id`
 * filled in, which is what makes `coupons.redeem`'s usage count auditable.
 *
 * A coupon may not be applied once money has arrived (`amount_paid > 0`): the discount would change a
 * total a school has already paid against, and §13 describes no mechanism for handing the difference
 * back other than a refund, which has its own document.
 *
 * ## What has no route, and why
 *
 *  - **`markOverdue()`** — a fact about `due_date` and the clock. Same scheduler argument as
 *    `subscriptions.runLifecycleSweep()`; `src/jobs/` is Phase 5.
 *  - **`reminderCandidates()` / `markReminderSent()`** — `reminder_sent_at`'s comment is *"Marker used
 *    by the fee/subscription reminder cron"*. The selection and the marker are implemented here because
 *    they are invoice facts; *sending* is §26's notification module, and inventing an email template
 *    would be inventing a requirement. The two halves meet at these two functions.
 *  - **No free-form `POST /invoices`.** FR-BILL-001's actor is *System* and its precondition is
 *    *"Subscription exists and a billing event occurs"*. `generateForSubscription()` is that sentence;
 *    an endpoint that let an operator type any lines onto any school would be a different requirement.
 *    `issue()` is exported for `quotations.service` to call, because `quotations.converted_invoice_id`
 *    is a column and something has to fill it.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const money = require('../../utils/money');
const dates = require('../../utils/dates');
const documentNumber = require('../../utils/documentNumber');
const couponsService = require('../coupons/coupons.service');
const taxesService = require('../taxes/taxes.service');
const { activeWindow } = require('../../services/entitlementService');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { tenantWhere } = require('../../models');
const {
  INVOICE_STATUS: STATUS,
  PAYMENT_STATUS,
  REFUND_STATUS,
  BILLING_CYCLES,
  OVERRIDE_TYPES,
  PRICE_OVERRIDE_TARGETS,
  SUBSCRIPTION_STATES,
} = require('../../config/constants');

const SORTABLE = Object.freeze([
  'id',
  'invoice_number',
  'issue_date',
  'due_date',
  'status',
  'total',
  'amount_due',
  'created_at',
  'updated_at',
]);

const DEFAULT_SORT = Object.freeze(['issue_date', 'DESC']);

/**
 * Statuses in which the invoice still represents money the school owes.
 *
 * `draft` is excluded deliberately: it is not yet a demand, so it must not count toward a school's
 * outstanding balance or attract an overdue flag.
 */
const OUTSTANDING_STATUSES = Object.freeze([STATUS.UNPAID, STATUS.PARTIALLY_PAID, STATUS.OVERDUE]);

/** Statuses a payment may be recorded against — FR-BILL-002's precondition, *"Invoice exists"*. */
const PAYABLE_STATUSES = OUTSTANDING_STATUSES;

/** Statuses whose totals may still be rewritten. Once money has arrived, the figures are history. */
const MUTABLE_STATUSES = Object.freeze([STATUS.DRAFT, STATUS.UNPAID]);

/**
 * Statuses that count as "this period has been billed".
 *
 * A cancelled invoice does not, which is what lets an operator cancel a wrong invoice and re-issue for
 * the same period. Everything else does, including `draft` — a draft for the period is exactly the
 * thing a second generation attempt would duplicate.
 */
const LIVE_STATUSES = Object.freeze([
  STATUS.DRAFT,
  STATUS.UNPAID,
  STATUS.PARTIALLY_PAID,
  STATUS.PAID,
  STATUS.OVERDUE,
  STATUS.REFUNDED,
]);

/* ─────────────────────────────── Reads ─────────────────────────────── */

/** Everything a §13.1 invoice screen renders, in one query. */
function detailInclude() {
  return [
    { model: db.InvoiceItem, as: 'items', separate: true, order: [['id', 'ASC']] },
    { model: db.SubscriptionPlan, as: 'plan' },
    { model: db.Coupon, as: 'coupon' },
    { model: db.Tax, as: 'tax' },
    {
      model: db.Payment,
      as: 'payments',
      separate: true,
      order: [['id', 'ASC']],
    },
  ];
}

/**
 * One page of invoices, confined to the caller's tenant.
 *
 * `invoices` carries both `school_id` and `organization_id`, so `tenantWhere()` does the confinement —
 * the ordinary case, as in `/subscriptions`. `invoices.self.view` is the permission a school holds and
 * it reaches the same handler: the isolation is the tenant layer's job, not a second code path's.
 *
 * @param {object} tenant
 * @param {object} query
 * @param {{page: number, limit: number, offset: number}} pagination
 * @param {import('express').Request} req
 * @returns {Promise<{rows: object[], count: number}>}
 */
async function list(tenant, query, pagination, req) {
  const where = tenantWhere(tenant, {});

  if (query.school_id) where.school_id = query.school_id;
  if (query.subscription_id) where.subscription_id = query.subscription_id;
  if (query.plan_id) where.plan_id = query.plan_id;
  if (query.status) where.status = query.status;
  if (query.coupon_id) where.coupon_id = query.coupon_id;
  if (query.currency) where.currency = query.currency;

  if (query.outstanding) where.status = { [Op.in]: OUTSTANDING_STATUSES };

  /* `due_date` is DATEONLY, so both bounds are compared as dates rather than instants. */
  if (query.due_from || query.due_to) {
    where.due_date = {
      ...(query.due_from ? { [Op.gte]: dates.toDateOnly(query.due_from) } : {}),
      ...(query.due_to ? { [Op.lte]: dates.toDateOnly(query.due_to) } : {}),
    };
  }

  if (query.issued_from || query.issued_to) {
    where.issue_date = {
      ...(query.issued_from ? { [Op.gte]: dates.toDateOnly(query.issued_from) } : {}),
      ...(query.issued_to ? { [Op.lte]: dates.toDateOnly(query.issued_to) } : {}),
    };
  }

  if (query.number) {
    where.invoice_number = { [Op.like]: `%${String(query.number).trim().toUpperCase()}%` };
  }

  return paginateQuery(
    db.Invoice,
    { where, order: getSort(req, SORTABLE, DEFAULT_SORT), include: detailInclude() },
    pagination
  );
}

/**
 * One invoice, or a 404.
 *
 * The tenant scope is folded into the `where`, so a school asking for another school's invoice is told
 * "not found" rather than "forbidden" — the treatment every other tenant-scoped read in the project
 * gives, because the alternative confirms the row exists.
 *
 * @param {object} tenant
 * @param {number|string} id
 * @param {{detail?: boolean, transaction?: object, lock?: boolean}} [options]
 * @returns {Promise<object>}
 */
async function findById(tenant, id, options = {}) {
  const invoice = await db.Invoice.findOne({
    where: tenantWhere(tenant, { id }),
    include: options.detail === false ? undefined : detailInclude(),
    transaction: options.transaction,
    ...(options.lock ? { lock: options.transaction.LOCK.UPDATE } : {}),
  });

  if (!invoice) throw ApiError.notFound('Invoice not found', { code: 'INVOICE_NOT_FOUND' });
  return invoice;
}

/**
 * The same read without a tenant, for the modules that already hold a scoped parent.
 *
 * `payments.service` has confined the request to a school before it needs the invoice, and
 * `applyPayment()` runs inside its transaction; re-deriving the scope here would either duplicate that
 * work or, worse, silently disagree with it.
 *
 * @param {number|string} id
 * @param {{transaction?: object, lock?: boolean}} [options]
 * @returns {Promise<object>}
 */
async function loadForWrite(id, options = {}) {
  const invoice = await db.Invoice.findByPk(id, {
    transaction: options.transaction,
    ...(options.lock && options.transaction ? { lock: options.transaction.LOCK.UPDATE } : {}),
  });

  if (!invoice) throw ApiError.notFound('Invoice not found', { code: 'INVOICE_NOT_FOUND' });
  return invoice;
}

/** `req.user.id`, or `null` when a sweep is the actor. Mirrors `subscriptions.service.performerOf()`. */
function performerOf(req) {
  return req && req.user && req.user.id ? req.user.id : null;
}

/* ─────────────────────────────── Money ─────────────────────────────── */

/** The smaller of two major-unit amounts, compared in minor units so 0.1 + 0.2 cannot decide it. */
function minAmount(a, b) {
  return money.toMinor(a) <= money.toMinor(b) ? money.round(a) : money.round(b);
}

/**
 * §13.1's four figures, in §13.1's order.
 *
 * Pure: no database, no `req`. Everything that decides a total is an argument, which is what makes the
 * inclusive-vs-exclusive tax branch and the credit cap directly assertable by
 * `scripts/verify-billing.js` without a fixture.
 *
 * @param {object} input
 * @param {Array<{amount: number}>} input.lines
 * @param {object|null} [input.coupon]
 * @param {object|null} [input.tax]
 * @param {number} [input.creditAvailable] `subscriptions.credit_balance`, at most.
 * @param {number} [input.amountPaid] Already-received money, for a recompute on a live invoice.
 * @returns {{subtotal: number, discountAmount: number, taxAmount: number, total: number,
 *            creditApplied: number, amountDue: number, taxQuote: object}}
 */
function computeTotals({ lines = [], coupon = null, tax = null, creditAvailable = 0, amountPaid = 0 }) {
  const subtotal = money.clampNonNegative(money.sum(lines.map((line) => line.amount)));

  const discountAmount = coupon ? couponsService.discountOn(coupon, subtotal) : 0;
  const taxable = money.clampNonNegative(money.subtract(subtotal, discountAmount));

  const taxQuote = taxesService.quoteFor(tax, taxable);

  /*
   * An inclusive tax is already inside `taxable`, so adding it would charge it twice. `quoteFor()`
   * returns `addedAmount: 0` in that case and reports the contained portion instead — which is the
   * figure printed as "Tax" on an inclusive invoice, so it is what `tax_amount` stores.
   */
  const taxAmount = taxQuote.isInclusive ? taxQuote.containedAmount : taxQuote.addedAmount;
  const total = money.clampNonNegative(money.sum(taxable, taxQuote.addedAmount));

  const outstanding = money.clampNonNegative(money.subtract(total, amountPaid));
  const creditApplied = minAmount(money.clampNonNegative(creditAvailable), outstanding);
  const amountDue = money.clampNonNegative(money.subtract(outstanding, creditApplied));

  return { subtotal, discountAmount, taxAmount, total, creditApplied, amountDue, taxQuote };
}

/**
 * Copy a `subscription_items` row into an `invoice_items` shape.
 *
 * A copy, not a join: `invoice_items` holds `description`, `quantity`, `unit_amount` and `amount` of
 * its own, on the same reasoning `subscriptions.pricingColumns()` gives for the subscription's price
 * columns — a later catalogue or quantity edit must not rewrite an issued invoice.
 * `subscription_item_id` is kept so the provenance is still readable.
 *
 * @param {object} item
 * @param {{periodStart?: Date, periodEnd?: Date}} [period]
 * @returns {object}
 */
function lineFromSubscriptionItem(item, period = {}) {
  return {
    item_type: item.item_type,
    subscription_item_id: item.id,
    addon_id: item.addon_id || null,
    description: String(item.description || '').slice(0, 255),
    quantity: Number(item.quantity) || 1,
    unit_amount: money.round(item.unit_amount),
    amount: money.round(item.amount),
    /* The item's own period when it has one — a setup fee does not — else the invoice's. */
    period_start: item.period_start || period.periodStart || null,
    period_end: item.period_end || period.periodEnd || null,
    metadata: null,
  };
}

/**
 * §33's *Overage*, read off `usage_records` for a billing period.
 *
 * Overlap rather than equality on the period: `usageService.periodFor()` derives a headcount limit's
 * window differently from a periodic one, so two usage rows covering the same invoice can carry
 * different `period_start` values. An overlapping row with a non-zero `overage_amount` is usage the
 * school incurred during the period being billed, which is the question the invoice is asking.
 *
 * @param {number} schoolId
 * @param {number|null} subscriptionId
 * @param {Date} periodStart
 * @param {Date} periodEnd
 * @param {object} [transaction]
 * @returns {Promise<object[]>} `invoice_items` shapes
 */
async function overageLinesFor(schoolId, subscriptionId, periodStart, periodEnd, transaction) {
  if (!periodStart || !periodEnd) return [];

  const rows = await db.UsageRecord.findAll({
    where: {
      school_id: schoolId,
      ...(subscriptionId ? { subscription_id: subscriptionId } : {}),
      overage_amount: { [Op.gt]: 0 },
      period_start: { [Op.lt]: periodEnd },
      period_end: { [Op.gt]: periodStart },
    },
    order: [['limit_key', 'ASC']],
    transaction,
  });

  return rows.map((row) => {
    const units = Number(row.overage_value) || 0;
    const amount = money.round(row.overage_amount);

    return {
      item_type: 'overage',
      subscription_item_id: null,
      addon_id: null,
      description: `Overage — ${row.limit_key}${row.unit ? ` (${units} ${row.unit})` : ` (${units})`}`.slice(
        0,
        255
      ),
      quantity: units || 1,
      /* Derived so the printed line reconciles; `plan_limits.overage_unit_amount` is the source. */
      unit_amount: units > 0 ? money.round(amount / units) : amount,
      amount,
      period_start: row.period_start,
      period_end: row.period_end,
      /* The only trail from usage row to invoice line — `usage_records` has no `invoiced_at`. */
      metadata: { usage_record_id: row.id, limit_key: row.limit_key, overage_value: units },
    };
  });
}

/**
 * §13.1's *Add-ons* field, as the compact json the column is for.
 *
 * `addons_summary` duplicates what the `item_type: 'addon'` lines already say, which is the point: the
 * column exists so a list view can render "Extra Storage ×2" without joining `invoice_items`.
 *
 * @param {object[]} lines
 * @returns {object[]|null}
 */
function addonsSummaryFrom(lines) {
  const addonLines = lines.filter((line) => line.item_type === 'addon');
  if (!addonLines.length) return null;

  return addonLines.map((line) => ({
    addon_id: line.addon_id,
    description: line.description,
    quantity: line.quantity,
    amount: line.amount,
  }));
}

/* ─────────────────────────────── Issue ─────────────────────────────── */

/**
 * Is this subscription period already on a live invoice?
 *
 * The double-billing guard the fixed schema forces this module to carry — see the header on overage.
 * Matched on the period *start*, not an overlap: a renewal's period starts where the previous one ends,
 * so an overlap test would refuse every renewal invoice.
 *
 * @param {number} subscriptionId
 * @param {Date} periodStart
 * @param {object} [transaction]
 * @returns {Promise<object|null>}
 */
async function alreadyBilled(subscriptionId, periodStart, transaction) {
  if (!subscriptionId || !periodStart) return null;

  return db.Invoice.findOne({
    where: {
      subscription_id: subscriptionId,
      billing_period_start: periodStart,
      status: { [Op.in]: LIVE_STATUSES },
    },
    order: [['id', 'ASC']],
    transaction,
  });
}

/**
 * Resolve the coupon an issuance names, by id or by code, and check it against the order.
 *
 * `coupons.service.validateForOrder()` does every §13.4 check and refuses with the code naming which
 * one failed; nothing is re-checked here. Returns `null` when no coupon was named, which is the normal
 * case — an invoice without a discount is not a degenerate invoice.
 *
 * @param {object} spec
 * @param {number} subtotal
 * @param {object} transaction
 * @returns {Promise<{coupon: object, discountAmount: number}|null>}
 */
async function resolveCoupon(spec, subtotal, transaction) {
  if (!spec.couponCode && !spec.couponId) return null;

  const coupon = spec.couponId
    ? await couponsService.findById(spec.couponId, { transaction })
    : await couponsService.findByCode(spec.couponCode, { transaction });

  const checked = await couponsService.validateForOrder(
    {
      code: coupon.code,
      schoolId: spec.schoolId,
      planId: spec.planId || null,
      amount: subtotal,
      currency: spec.currency,
    },
    { transaction }
  );

  return { coupon: checked.coupon, discountAmount: checked.discountAmount };
}

/**
 * Write an invoice and its lines. The primitive both FR-BILL-001 and quotation conversion go through.
 *
 * Owns a transaction unless given one. When it owns it, the whole body is wrapped in
 * `documentNumber.withRetry()` so a lost `invoice_number` race re-runs rather than surfacing as a 500;
 * when the caller supplies a transaction the retry is the **caller's** to provide, because a rollback
 * has to happen before a new number can be read. Stated here because a caller passing a transaction and
 * expecting the retry would get neither an error nor a retry.
 *
 * @param {import('express').Request|null} req Null when a sweep issues the invoice.
 * @param {object} spec
 * @param {{transaction?: object}} [options]
 * @returns {Promise<object>} the invoice, with `items` loaded
 */
async function issue(req, spec, options = {}) {
  const run = async (transaction) => {
    const lines = (spec.lines || []).filter((line) => line && line.description);

    if (!lines.length) {
      throw new ApiError(422, 'An invoice needs at least one line item', {
        code: 'INVOICE_NO_LINES',
      });
    }

    const subtotal = money.clampNonNegative(money.sum(lines.map((line) => line.amount)));

    const resolvedCoupon = await resolveCoupon(spec, subtotal, transaction);
    const tax = await taxesService.resolveForInvoice(spec.taxId, transaction);

    const totals = computeTotals({
      lines,
      coupon: resolvedCoupon ? resolvedCoupon.coupon : null,
      tax,
      creditAvailable: spec.creditAvailable || 0,
      amountPaid: 0,
    });

    const issueDate = dates.toDateOnly(spec.issueDate || new Date());

    /*
     * The due date must be given, not guessed — and the fallback that used to stand here was a bug
     * that could not announce itself.
     *
     * It read `: GRACE_PERIOD_DAYS`, which is §12.2's **preset list** `Object.freeze([1, 3, 7, 15])`
     * (`constants.js:318`), not a day count. `dates.addDays()` then evaluated
     * `d.getTime() + [1,3,7,15] * MS_PER_DAY`, and multiplying a four-element array yields `NaN`, so
     * the result was an `Invalid Date`. That is not where it stopped being visible: `toDateOnly()`
     * falls back to `new Date()` on an unparseable value (`utils/dates.js:38-41`), so the invoice
     * silently took **today** as its due date — born already due, with nothing thrown and nothing
     * logged.
     *
     * Unreachable today: `generateForSubscription()` is the only caller and always passes
     * `subscription.grace_period_days`, which is `allowNull: false, defaultValue: 0`. The next caller
     * that omits it would have inherited the landmine.
     *
     * §13.1 lists "Due Date" as an invoice field and states no default billing term, so inventing one
     * here would be inventing a business rule §35 does not permit. Refusing is the honest answer, and
     * it is safe because the sole caller always supplies the value.
     */
    const hasDueDays = Number.isFinite(Number(spec.dueDays));
    if (!spec.dueDate && !hasDueDays) {
      throw new Error(
        'invoices.issue() requires either spec.dueDate or a numeric spec.dueDays; ' +
          '§13.1 states no default billing term, so there is nothing to fall back to.'
      );
    }
    const dueDate = spec.dueDate
      ? dates.toDateOnly(spec.dueDate)
      : dates.toDateOnly(dates.addDays(spec.issueDate || new Date(), Number(spec.dueDays)));

    const invoiceNumber = await documentNumber.nextNumber(db.Invoice, {
      column: 'invoice_number',
      prefix: documentNumber.PREFIXES.INVOICE,
      at: spec.issueDate || new Date(),
      transaction,
    });

    const invoice = await db.Invoice.create(
      {
        invoice_number: invoiceNumber,
        school_id: spec.schoolId || null,
        organization_id: spec.organizationId || null,
        subscription_id: spec.subscriptionId || null,
        plan_id: spec.planId || null,
        /* §13.1's *Plan*, as the column comment requires: *"Snapshot at issue time"*. */
        plan_name: spec.planName ? String(spec.planName).slice(0, 160) : null,
        billing_period_start: spec.billingPeriodStart || null,
        billing_period_end: spec.billingPeriodEnd || null,
        billing_cycle: spec.billingCycle || null,
        currency: spec.currency || 'USD',
        subtotal: totals.subtotal,
        discount_amount: totals.discountAmount,
        tax_amount: totals.taxAmount,
        total: totals.total,
        amount_paid: 0,
        amount_due: totals.amountDue,
        credit_applied: totals.creditApplied,
        coupon_id: resolvedCoupon ? resolvedCoupon.coupon.id : null,
        /* Denormalised beside the id, so a later code edit cannot rewrite an issued invoice. */
        coupon_code: resolvedCoupon ? resolvedCoupon.coupon.code : null,
        tax_id: tax ? tax.id : null,
        tax_rate_percent: tax ? tax.rate_percent : null,
        issue_date: issueDate,
        due_date: dueDate,
        status: spec.status === STATUS.DRAFT ? STATUS.DRAFT : STATUS.UNPAID,
        notes: spec.notes || null,
        addons_summary: addonsSummaryFrom(lines),
        metadata: spec.metadata || null,
      },
      { transaction }
    );

    await db.InvoiceItem.bulkCreate(
      lines.map((line) => ({
        ...line,
        invoice_id: invoice.id,
        school_id: spec.schoolId || null,
      })),
      /* `validate: true` — bulkCreate skips model validators by default. */
      { transaction, validate: true }
    );

    /*
     * The coupon's use is consumed here and nowhere else on this path: `coupon_usages.discount_amount`
     * is `allowNull: false`, so a use can only be recorded once there is an invoice to record it
     * against. Inside the same transaction as the invoice, so a rolled-back issuance does not burn one.
     */
    if (resolvedCoupon && totals.discountAmount > 0) {
      await couponsService.redeem(
        {
          couponId: resolvedCoupon.coupon.id,
          schoolId: spec.schoolId,
          subscriptionId: spec.subscriptionId || null,
          invoiceId: invoice.id,
          planId: spec.planId || null,
          /*
           * The *order* amount, not the discount. `redeem()` falls back to `discountAmount` when this is
           * absent, which would make its `min_order_amount` re-check compare the wrong number.
           */
          amount: totals.subtotal,
          discountAmount: totals.discountAmount,
          currency: invoice.currency,
          redeemedBy: performerOf(req),
        },
        transaction
      );
    }

    /*
     * Credit consumed is credit spent. `subscriptions.credit_balance` is the subscription's column, but
     * this is the only place an invoice draws it down, so the decrement belongs to the same transaction
     * as the `credit_applied` that records it — the two must not be able to disagree.
     */
    if (totals.creditApplied > 0 && spec.subscriptionId) {
      await db.Subscription.decrement('credit_balance', {
        by: totals.creditApplied,
        where: { id: spec.subscriptionId },
        transaction,
      });
    }

    return invoice;
  };

  const invoice = options.transaction
    ? await run(options.transaction)
    : await documentNumber.withRetry(
        () => db.sequelize.transaction((transaction) => run(transaction)),
        { column: 'invoice_number' }
      );

  await recordAudit(req, {
    tableName: 'invoices',
    recordId: invoice.id,
    event: 'create',
    after: snapshot(invoice),
    reason: spec.reason || null,
  });

  /*
   * Threaded with `options.transaction` so the re-read sees the row it just wrote. CLS is not enabled, so
   * a findByPk with no transaction runs on another connection and — before commit — would not see an
   * invoice created inside a caller-supplied transaction (the quotation-conversion path). It is a no-op
   * when `issue()` owns the transaction, which has already committed by the time control reaches here.
   */
  return db.Invoice.findByPk(invoice.id, {
    include: detailInclude(),
    transaction: options.transaction,
  });
}

/**
 * FR-BILL-001 — *"System generates an invoice for a school's subscription billing period."*
 *
 * The precondition is *"Subscription exists and a billing event occurs"*. The subscription is looked up
 * under the caller's tenant scope; the billing event is the caller — a renewal, a plan change, or an
 * operator issuing the cycle's invoice from the §33 Invoices screen. The invoice's period defaults to
 * the subscription's **current** period, because that is the period the row says is being billed.
 *
 * The money is **read**, not recomputed: `subscription_items` already holds the per-line figures
 * `subscriptions.service` wrote from the plan price, and `credit_balance` already holds what
 * `prorate()` decided. Recomputing either here would produce a second answer to a question that has
 * one — and `dates.daysBetween()` floors, so a proration recomputed an hour later can land a day out.
 *
 * @param {import('express').Request|null} req
 * @param {number|string} subscriptionId
 * @param {object} [payload]
 * @returns {Promise<object>}
 */
async function generateForSubscription(req, subscriptionId, payload = {}) {
  const tenant = req ? req.tenant : { isPlatform: true, organizationId: null, schoolId: null };

  const subscription = await db.Subscription.findOne({
    where: tenantWhere(tenant, { id: subscriptionId }),
    include: [{ model: db.SubscriptionPlan, as: 'plan' }],
  });

  if (!subscription) {
    throw ApiError.notFound('Subscription not found', { code: 'SUBSCRIPTION_NOT_FOUND' });
  }

  const periodStart = payload.billing_period_start || subscription.current_period_start;
  const periodEnd = payload.billing_period_end || subscription.current_period_end;

  if (!periodStart) {
    throw new ApiError(422, 'The subscription has no billing period to invoice', {
      code: 'INVOICE_NO_PERIOD',
      details: { subscription_id: subscription.id, state: subscription.state },
    });
  }

  const existing = await alreadyBilled(subscription.id, periodStart);
  if (existing) {
    throw ApiError.conflict(
      `Invoice ${existing.invoice_number} already covers this billing period`,
      {
        code: 'INVOICE_PERIOD_ALREADY_BILLED',
        details: {
          invoice_id: existing.id,
          invoice_number: existing.invoice_number,
          status: existing.status,
        },
      }
    );
  }

  /*
   * `is_recurring` decides what a renewal charges for — see the header. `first_cycle` is inferred from
   * whether the subscription has ever been renewed rather than from whether an invoice exists, because
   * an operator may have cancelled the first invoice and the setup fee is still owed once.
   */
  const isFirstCycle =
    payload.first_cycle !== undefined
      ? Boolean(payload.first_cycle)
      : Number(subscription.renewal_count || 0) === 0;

  const items = await db.SubscriptionItem.findAll({
    where: {
      subscription_id: subscription.id,
      ...(isFirstCycle ? {} : { is_recurring: true }),
    },
    order: [['id', 'ASC']],
  });

  if (!items.length) {
    throw new ApiError(422, 'The subscription has no billable items', {
      code: 'INVOICE_NO_LINES',
      details: { subscription_id: subscription.id, first_cycle: isFirstCycle },
    });
  }

  const lines = items.map((item) => lineFromSubscriptionItem(item, { periodStart, periodEnd }));

  /*
   * A negotiated price replaces the plan's — the owner's decision D7 in `docs/OWNER-DECISIONS.md`,
   * settling triage finding 39. A `price` override on `cycle_amount` used to be accepted, stored and
   * billed by nothing: the school kept paying the plan price. Now the override in effect at the start
   * of the billed period sets the plan line's amount, whatever the plan price is. It touches only the
   * plan line — a setup fee and add-ons are priced by their own rows — and it is read per period, so an
   * override that ends stops applying to the invoices after it, which is also how a renewal honours it:
   * a renewed period is invoiced here like any other.
   *
   * The line collapses to one unit at the negotiated amount. A per-seat plan's quantity would otherwise
   * print beside a unit price that no longer multiplies out; the plan's own figures stay in `metadata`.
   */
  const priceOverride = await db.SubscriptionOverride.findOne({
    where: {
      subscription_id: subscription.id,
      override_type: OVERRIDE_TYPES.PRICE,
      target_key: PRICE_OVERRIDE_TARGETS,
      is_active: true,
      ...activeWindow('effective_from', 'effective_until', new Date(periodStart)),
    },
    order: [['id', 'DESC']],
  });
  if (priceOverride && priceOverride.amount !== null) {
    for (const line of lines) {
      if (line.item_type !== 'plan') continue;
      const negotiated = money.round(priceOverride.amount);
      line.metadata = {
        price_override_id: priceOverride.id,
        plan_quantity: line.quantity,
        plan_unit_amount: line.unit_amount,
        plan_amount: line.amount,
      };
      line.quantity = 1;
      line.unit_amount = negotiated;
      line.amount = negotiated;
    }
  }

  /*
   * Overage is skipped on a first cycle: the period has not been used yet, so any usage row overlapping
   * it belongs to a previous subscription of the same school and is not this invoice's to bill.
   */
  if (!isFirstCycle && payload.include_overage !== false) {
    lines.push(
      ...(await overageLinesFor(subscription.school_id, subscription.id, periodStart, periodEnd))
    );
  }

  /*
   * The automatic run (D6) leaves a period that costs nothing un-invoiced: an invoice for zero is born
   * `unpaid`, can never be paid into `paid` — `applyPayment()` settles only a positive total — and
   * would be flagged overdue by the next sweep. Generate by hand is unaffected; an operator may want the
   * record.
   */
  if (payload.skip_if_free && money.toMinor(money.sum(lines.map((line) => line.amount))) === 0) {
    return null;
  }

  return issue(req, {
    schoolId: subscription.school_id,
    organizationId: subscription.organization_id,
    subscriptionId: subscription.id,
    planId: subscription.plan_id,
    planName: subscription.plan ? subscription.plan.name : null,
    billingPeriodStart: periodStart,
    billingPeriodEnd: periodEnd,
    billingCycle: subscription.billing_cycle || BILLING_CYCLES.MONTHLY,
    currency: subscription.currency,
    lines,
    couponCode: payload.coupon_code || null,
    couponId: payload.coupon_id || null,
    taxId: payload.tax_id,
    creditAvailable: payload.apply_credit === false ? 0 : subscription.credit_balance,
    issueDate: payload.issue_date || new Date(),
    dueDate: payload.due_date || null,
    dueDays: subscription.grace_period_days,
    status: payload.status || STATUS.UNPAID,
    notes: payload.notes || null,
    metadata: payload.metadata || null,
    reason: payload.reason || null,
  });
}

/* ───────────────────────────── Recompute ───────────────────────────── */

/**
 * Re-derive the four §13.1 figures from the invoice's own lines, coupon and tax.
 *
 * Used by `applyCoupon()` and `removeCoupon()`, which change one input and must not have to know the
 * formula. Refuses outside `MUTABLE_STATUSES`, because a total that could move after a payment landed
 * would make `amount_paid` describe a different invoice than the one it was paid against.
 *
 * @param {object} invoice
 * @param {object} transaction
 * @returns {Promise<object>} the totals that were written
 */
async function recompute(invoice, transaction) {
  const [items, coupon, tax] = await Promise.all([
    db.InvoiceItem.findAll({ where: { invoice_id: invoice.id }, transaction }),
    invoice.coupon_id ? db.Coupon.findByPk(invoice.coupon_id, { transaction }) : null,
    invoice.tax_id ? db.Tax.findByPk(invoice.tax_id, { transaction }) : null,
  ]);

  const totals = computeTotals({
    lines: items,
    coupon,
    tax,
    /* Already drawn down at issue; re-applying it would spend the same credit twice. */
    creditAvailable: invoice.credit_applied,
    amountPaid: invoice.amount_paid,
  });

  invoice.set({
    subtotal: totals.subtotal,
    discount_amount: totals.discountAmount,
    tax_amount: totals.taxAmount,
    total: totals.total,
    credit_applied: totals.creditApplied,
    amount_due: totals.amountDue,
  });

  await invoice.save({ transaction });
  return totals;
}

/* ──────────────────────── Status transitions ──────────────────────── */

/**
 * `draft → unpaid`. The moment an invoice becomes a demand.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {string} [reason]
 * @returns {Promise<object>}
 */
async function finalise(req, id, reason = null) {
  const invoice = await findById(req.tenant, id, { detail: false });

  if (invoice.status !== STATUS.DRAFT) {
    throw ApiError.conflict(`Invoice ${invoice.invoice_number} is not a draft`, {
      code: 'INVOICE_NOT_DRAFT',
      details: { status: invoice.status },
    });
  }

  const before = snapshot(invoice);
  invoice.set({ status: STATUS.UNPAID });
  await invoice.save();

  await recordAudit(req, {
    tableName: 'invoices',
    recordId: invoice.id,
    event: 'update',
    before,
    after: snapshot(invoice),
    reason,
  });

  return db.Invoice.findByPk(invoice.id, { include: detailInclude() });
}

/**
 * Cancel an invoice.
 *
 * Not a delete: `invoices` is not `paranoid`, so a `destroy()` would take the document out of the
 * school's billing history entirely, and `payment.invoice_id` would be left pointing at nothing. A paid
 * invoice cannot be cancelled — the way back from money received is a refund, which has its own
 * document and its own number.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {string} [reason]
 * @returns {Promise<object>}
 */
async function cancel(req, id, reason = null) {
  const invoice = await findById(req.tenant, id, { detail: false });

  if (invoice.status === STATUS.CANCELLED) {
    throw ApiError.conflict(`Invoice ${invoice.invoice_number} is already cancelled`, {
      code: 'INVOICE_ALREADY_CANCELLED',
    });
  }

  if ([STATUS.PAID, STATUS.REFUNDED].includes(invoice.status)) {
    throw ApiError.conflict(
      `Invoice ${invoice.invoice_number} has been paid — issue a refund rather than cancelling it`,
      { code: 'INVOICE_PAID', details: { status: invoice.status, amount_paid: invoice.amount_paid } }
    );
  }

  if (money.toMinor(invoice.amount_paid) > 0) {
    throw ApiError.conflict(
      `Invoice ${invoice.invoice_number} has payments against it — refund them before cancelling`,
      { code: 'INVOICE_HAS_PAYMENTS', details: { amount_paid: invoice.amount_paid } }
    );
  }

  const before = snapshot(invoice);

  return db.sequelize.transaction(async (transaction) => {
    /* Credit taken at issue goes back: the invoice it was spent on will never be paid. */
    if (money.toMinor(invoice.credit_applied) > 0 && invoice.subscription_id) {
      await db.Subscription.increment('credit_balance', {
        by: money.round(invoice.credit_applied),
        where: { id: invoice.subscription_id },
        transaction,
      });
    }

    invoice.set({
      status: STATUS.CANCELLED,
      cancelled_at: new Date(),
      credit_applied: 0,
      amount_due: 0,
      notes: reason ? String(reason).slice(0, 65535) : invoice.notes,
    });
    await invoice.save({ transaction });

    await recordAudit(req, {
      tableName: 'invoices',
      recordId: invoice.id,
      event: 'update',
      before,
      after: snapshot(invoice),
      reason,
    });

    return db.Invoice.findByPk(invoice.id, { include: detailInclude(), transaction });
  });
}

/**
 * FR-BILL-005's last bullet — *"School applies a valid coupon to an invoice/subscription."*
 *
 * The one use consumed is recorded against this invoice, so `GET /coupons/:id/usages` shows where the
 * discount went. Refused on an invoice that already carries a coupon: `invoices.coupon_id` is a single
 * column, and stacking two discounts is behaviour §13.4 does not describe.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {{code: string, reason?: string}} payload
 * @returns {Promise<object>}
 */
async function applyCoupon(req, id, payload) {
  const invoice = await findById(req.tenant, id, { detail: false });

  if (!MUTABLE_STATUSES.includes(invoice.status)) {
    throw ApiError.conflict(
      `A coupon cannot be applied to a ${invoice.status} invoice`,
      { code: 'INVOICE_NOT_MUTABLE', details: { status: invoice.status } }
    );
  }

  if (money.toMinor(invoice.amount_paid) > 0) {
    throw ApiError.conflict(
      `Invoice ${invoice.invoice_number} has already been paid against — a discount now would change a total the school has settled`,
      { code: 'INVOICE_HAS_PAYMENTS', details: { amount_paid: invoice.amount_paid } }
    );
  }

  if (invoice.coupon_id) {
    throw ApiError.conflict(
      `Invoice ${invoice.invoice_number} already carries coupon ${invoice.coupon_code}`,
      { code: 'INVOICE_COUPON_PRESENT', details: { coupon_code: invoice.coupon_code } }
    );
  }

  const before = snapshot(invoice);

  await db.sequelize.transaction(async (transaction) => {
    const checked = await couponsService.validateForOrder(
      {
        code: payload.code,
        schoolId: invoice.school_id,
        planId: invoice.plan_id,
        amount: invoice.subtotal,
        currency: invoice.currency,
      },
      { transaction }
    );

    invoice.set({ coupon_id: checked.coupon.id, coupon_code: checked.coupon.code });
    await recompute(invoice, transaction);

    if (money.toMinor(invoice.discount_amount) > 0) {
      await couponsService.redeem(
        {
          couponId: checked.coupon.id,
          schoolId: invoice.school_id,
          subscriptionId: invoice.subscription_id,
          invoiceId: invoice.id,
          planId: invoice.plan_id,
          amount: invoice.subtotal,
          discountAmount: invoice.discount_amount,
          currency: invoice.currency,
          redeemedBy: performerOf(req),
        },
        transaction
      );
    }

    await recordAudit(req, {
      tableName: 'invoices',
      recordId: invoice.id,
      event: 'update',
      before,
      after: snapshot(invoice),
      reason: payload.reason || `Applied coupon ${checked.coupon.code}`,
    });
  });

  return db.Invoice.findByPk(invoice.id, { include: detailInclude() });
}

/**
 * Take a coupon back off an invoice.
 *
 * The `coupon_usages` row is deleted and `used_count` decremented, because the use was never spent: the
 * invoice it was recorded against no longer carries the discount. Leaving the row would make §13.4's
 * *Maximum Uses* count applications that had no effect, which is the one thing that count must not do.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {string} [reason]
 * @returns {Promise<object>}
 */
async function removeCoupon(req, id, reason = null) {
  const invoice = await findById(req.tenant, id, { detail: false });

  if (!invoice.coupon_id) {
    throw ApiError.conflict(`Invoice ${invoice.invoice_number} carries no coupon`, {
      code: 'INVOICE_COUPON_ABSENT',
    });
  }

  if (!MUTABLE_STATUSES.includes(invoice.status) || money.toMinor(invoice.amount_paid) > 0) {
    throw ApiError.conflict(
      `A coupon cannot be removed from a ${invoice.status} invoice`,
      { code: 'INVOICE_NOT_MUTABLE', details: { status: invoice.status } }
    );
  }

  const before = snapshot(invoice);
  const couponId = invoice.coupon_id;

  await db.sequelize.transaction(async (transaction) => {
    const removed = await db.CouponUsage.destroy({
      where: { coupon_id: couponId, invoice_id: invoice.id },
      transaction,
    });

    if (removed > 0) {
      await db.Coupon.decrement('used_count', {
        by: removed,
        where: { id: couponId, used_count: { [Op.gte]: removed } },
        transaction,
      });
    }

    invoice.set({ coupon_id: null, coupon_code: null });
    await recompute(invoice, transaction);

    await recordAudit(req, {
      tableName: 'invoices',
      recordId: invoice.id,
      event: 'update',
      before,
      after: snapshot(invoice),
      reason,
    });
  });

  return db.Invoice.findByPk(invoice.id, { include: detailInclude() });
}

/* ─────────────────── Called by the payments module ─────────────────── */

/**
 * Record approved money against an invoice — FR-BILL-004's *"the related invoice … status is updated"*.
 *
 * Called only by `payments.service`, inside its transaction, and it is the only writer of `amount_paid`,
 * `amount_due`, `paid_at` and the `partially_paid`/`paid` statuses. A route that let a status be typed
 * in would make `amount_paid` a claim rather than the sum of approved payments.
 *
 * `amount_paid` is recomputed as `SUM(payments.amount)` over the approved rows rather than incremented,
 * so an approval applied twice cannot double the figure. That makes it idempotent in the only sense that
 * matters here.
 *
 * @param {object} invoice
 * @param {object} options
 * @param {object} options.transaction Required — this runs inside the payment's transaction.
 * @returns {Promise<{amountPaid: number, amountDue: number, status: string}>}
 */
async function applyPayment(invoice, options = {}) {
  const { transaction } = options;
  if (!transaction) throw new Error('applyPayment() must run inside the payment transaction');

  /*
   * One status set for both sums, and it is wider than `approved`. A payment that was approved and then
   * partly given back reads `partially_refunded`, and a fully-refunded one reads `refunded` — the money
   * still *arrived*, so its `amount` belongs in the received figure and its `refunded_amount` in the
   * returned one. Summing `amount` over `approved` alone while subtracting `refunded_amount` over a
   * wider set would charge the refund twice: once by omitting the payment, once by deducting it.
   */
  const received = [
    PAYMENT_STATUS.APPROVED,
    PAYMENT_STATUS.PARTIALLY_REFUNDED,
    PAYMENT_STATUS.REFUNDED,
  ];

  const [paid, refunded] = await Promise.all([
    db.Payment.sum('amount', {
      where: { invoice_id: invoice.id, status: { [Op.in]: received } },
      transaction,
    }),
    db.Payment.sum('refunded_amount', {
      where: { invoice_id: invoice.id, status: { [Op.in]: received } },
      transaction,
    }),
  ]);

  const amountPaid = money.clampNonNegative(money.subtract(paid || 0, refunded || 0));
  const settled = money.sum(amountPaid, invoice.credit_applied);
  const amountDue = money.clampNonNegative(money.subtract(invoice.total, settled));

  /*
   * `>=` rather than `===` on the total: an overpayment settles the invoice. §13 describes no mechanism
   * for refusing one at approval time, and an invoice left `partially_paid` while holding more money
   * than it asked for would be read by every outstanding-balance query as still owing.
   */
  let status = invoice.status;
  if (money.toMinor(settled) >= money.toMinor(invoice.total) && money.toMinor(invoice.total) > 0) {
    status = STATUS.PAID;
  } else if (money.toMinor(amountPaid) > 0) {
    status = STATUS.PARTIALLY_PAID;
  } else if (invoice.status === STATUS.PARTIALLY_PAID || invoice.status === STATUS.PAID) {
    /* Every payment was refunded away: back to a demand, and overdue if the date has passed. */
    status = STATUS.UNPAID;
  }

  if (
    status === STATUS.UNPAID &&
    invoice.due_date &&
    dates.isPast(dates.endOfDay(invoice.due_date))
  ) {
    status = STATUS.OVERDUE;
  }

  invoice.set({
    amount_paid: amountPaid,
    amount_due: amountDue,
    status,
    paid_at: status === STATUS.PAID ? invoice.paid_at || new Date() : null,
  });

  await invoice.save({ transaction });

  return { amountPaid, amountDue, status };
}

/**
 * Move a fully-refunded invoice to `refunded`.
 *
 * Called by `refunds` after `applyPayment()` has recomputed the money, so this only decides the label.
 * Kept separate because `refunded` is a statement about the *invoice's* outcome, and `applyPayment()`
 * cannot tell a refund that emptied it from a payment that was never made.
 *
 * @param {object} invoice
 * @param {{transaction: object}} options
 * @returns {Promise<object>}
 */
async function applyRefund(invoice, options = {}) {
  const { transaction } = options;
  if (!transaction) throw new Error('applyRefund() must run inside the refund transaction');

  await applyPayment(invoice, { transaction });

  const refundedTotal = await db.Refund.sum('amount', {
    where: { invoice_id: invoice.id, status: REFUND_STATUS.COMPLETED },
    transaction,
  });

  if (money.toMinor(refundedTotal || 0) > 0 && money.toMinor(invoice.amount_paid) === 0) {
    invoice.set({ status: STATUS.REFUNDED, paid_at: null });
    await invoice.save({ transaction });
  }

  return invoice;
}

/* ───────────────────────── Scheduler-facing ───────────────────────── */

/**
 * Flag every outstanding invoice whose due date has passed — no route, the clock is the actor.
 *
 * `endOfDay(due_date)` is the boundary: `due_date` is a DATEONLY, so an invoice due today is not
 * overdue until today is over. Comparing the bare date would flag it the moment the day started.
 *
 * @param {{at?: Date}} [options]
 * @returns {Promise<{scanned: number, flagged: number}>}
 */
async function markOverdue(options = {}) {
  const at = options.at || new Date();
  const cutoff = dates.toDateOnly(at);

  const candidates = await db.Invoice.findAll({
    where: {
      status: { [Op.in]: [STATUS.UNPAID, STATUS.PARTIALLY_PAID] },
      due_date: { [Op.ne]: null, [Op.lt]: cutoff },
    },
    order: [['id', 'ASC']],
  });

  let flagged = 0;

  for (const invoice of candidates) {
    /* eslint-disable-next-line no-await-in-loop */
    await invoice.update({ status: STATUS.OVERDUE });
    flagged += 1;
  }

  if (flagged > 0) {
    logger.info('Invoices marked overdue', { flagged, at: cutoff });
  }

  return { scanned: candidates.length, flagged };
}

/**
 * Subscription states whose running period is owed. A **trial** is not — it is free until it ends, and
 * the lifecycle sweep then moves it to `past_due`, which is. A pending subscription is: it becomes
 * active when its first invoice is paid (`payments.service` → `activate`), so that invoice has to exist
 * before activation can.
 */
const INVOICEABLE_STATES = Object.freeze([
  SUBSCRIPTION_STATES.PENDING,
  SUBSCRIPTION_STATES.ACTIVE,
  SUBSCRIPTION_STATES.EXPIRING,
  SUBSCRIPTION_STATES.PAST_DUE,
  SUBSCRIPTION_STATES.GRACE_PERIOD,
]);

/**
 * Issue the invoice for every billing period that has started and has none — the owner's decision D6.
 *
 * FR-BILL-001's actor is **System** and its precondition *"a billing event occurs"*, a phrase the SRS
 * never defines, so for a long time invoices were issued only by a Super Admin's Generate. D6 in
 * `docs/OWNER-DECISIONS.md` defined it: **a billing period starting** — a subscription's first period,
 * and each period a renewal opens. The daily run finds each subscription in an owed state whose current
 * period has begun and carries no live invoice, and issues one through `generateForSubscription()`, so
 * it is the same invoice Generate would produce: the plan and add-on lines, any price override (D7),
 * the default tax, and a due date `grace_period_days` after issue.
 *
 * Idempotent, like every task the scheduler runs: a period is matched by its start against live
 * invoices — the same test `alreadyBilled()` makes — so a second run the same day issues nothing, and a
 * cancelled invoice leaves its period open to be issued again. The exclusion is inside the query, so
 * `limit` bounds the work actually outstanding rather than being filled by periods already billed.
 *
 * A period that costs nothing — a free plan with no priced add-on — is counted as `free` and not
 * invoiced; see `skip_if_free` in `generateForSubscription()`.
 *
 * @param {{at?: Date, limit?: number}} [options]
 * @returns {Promise<{at: string, issued: number, free: number, failed: object[]}>}
 */
async function issueForStartedPeriods(options = {}) {
  const at = options.at || new Date();
  const limit = options.limit || 500;
  const live = LIVE_STATUSES.map((status) => db.sequelize.escape(status)).join(', ');

  const due = await db.Subscription.findAll({
    where: {
      state: { [Op.in]: INVOICEABLE_STATES },
      current_period_start: { [Op.ne]: null, [Op.lte]: at },
      [Op.and]: [
        db.sequelize.literal(
          'NOT EXISTS (SELECT 1 FROM `invoices` AS `billed` ' +
            'WHERE `billed`.`subscription_id` = `Subscription`.`id` ' +
            'AND `billed`.`billing_period_start` = `Subscription`.`current_period_start` ' +
            `AND \`billed\`.\`status\` IN (${live}))`
        ),
      ],
    },
    attributes: ['id'],
    order: [['id', 'ASC']],
    limit,
  });

  const report = { at: at.toISOString(), issued: 0, free: 0, failed: [] };
  for (const subscription of due) {
    try {
      /* eslint-disable-next-line no-await-in-loop */
      const invoice = await generateForSubscription(null, subscription.id, {
        issue_date: at,
        skip_if_free: true,
        reason: 'Issued automatically at the start of the billing period (owner decision D6)',
      });
      if (invoice) report.issued += 1;
      else report.free += 1;
    } catch (err) {
      /* One subscription with no billable lines must not stop the rest being invoiced. */
      report.failed.push({ subscriptionId: subscription.id, code: err.code || null, error: err.message });
    }
  }

  if (report.issued || report.failed.length) {
    logger.info('Invoices issued for started billing periods', {
      issued: report.issued,
      failed: report.failed.length,
    });
  }
  return report;
}

/**
 * The invoices a reminder cron would notify about, and nothing more.
 *
 * `reminder_sent_at`'s column comment is *"Marker used by the fee/subscription reminder cron"*. The
 * selection and the marker are invoice facts and live here; **delivery** is §26's notification module,
 * and writing an email template would be inventing a requirement. So this returns rows and
 * `markReminderSent()` records that something was sent — the two functions are the seam the cron sits
 * on, and neither pretends to send anything.
 *
 * @param {{withinDays?: number, at?: Date, resendAfterDays?: number|null}} [options]
 * @returns {Promise<object[]>}
 */
async function reminderCandidates(options = {}) {
  const at = options.at || new Date();
  const withinDays = Number.isFinite(Number(options.withinDays)) ? Number(options.withinDays) : 7;
  const horizon = dates.toDateOnly(dates.addDays(at, withinDays));

  const where = {
    status: { [Op.in]: OUTSTANDING_STATUSES },
    due_date: { [Op.ne]: null, [Op.lte]: horizon },
    amount_due: { [Op.gt]: 0 },
  };

  /*
   * `resendAfterDays: null` means "once only" — the default, because a marker column with no interval
   * beside it describes a single reminder. A caller may ask for a cadence explicitly.
   */
  if (options.resendAfterDays === null || options.resendAfterDays === undefined) {
    where.reminder_sent_at = null;
  } else {
    where[Op.or] = [
      { reminder_sent_at: null },
      { reminder_sent_at: { [Op.lt]: dates.addDays(at, -Number(options.resendAfterDays)) } },
    ];
  }

  return db.Invoice.findAll({
    where,
    order: [['due_date', 'ASC']],
    include: [{ model: db.InvoiceItem, as: 'items', separate: true, order: [['id', 'ASC']] }],
  });
}

/**
 * Stamp `reminder_sent_at`. Called by whatever actually sent the reminder.
 *
 * @param {Array<number|string>} invoiceIds
 * @param {{at?: Date, transaction?: object}} [options]
 * @returns {Promise<number>} rows stamped
 */
async function markReminderSent(invoiceIds, options = {}) {
  const ids = (Array.isArray(invoiceIds) ? invoiceIds : [invoiceIds])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (!ids.length) return 0;

  const [affected] = await db.Invoice.update(
    { reminder_sent_at: options.at || new Date() },
    { where: { id: { [Op.in]: ids } }, transaction: options.transaction }
  );

  return affected;
}

/**
 * What a school owes, across every outstanding invoice.
 *
 * Exists because `payments` needs it to answer *"is this payment larger than the debt"*, and because
 * §33's Invoices screen shows it above the list. One query rather than a page of rows summed in JS, so
 * the figure does not depend on the page size.
 *
 * @param {object} tenant
 * @param {{school_id?: number, currency?: string}} [query]
 * @returns {Promise<{count: number, total: number, amount_due: number, currency: string|null}>}
 */
async function outstandingSummary(tenant, query = {}) {
  const where = tenantWhere(tenant, { status: { [Op.in]: OUTSTANDING_STATUSES } });
  if (query.school_id) where.school_id = query.school_id;
  if (query.currency) where.currency = query.currency;

  const [count, total, amountDue] = await Promise.all([
    db.Invoice.count({ where }),
    db.Invoice.sum('total', { where }),
    db.Invoice.sum('amount_due', { where }),
  ]);

  return {
    count,
    total: money.round(total || 0),
    amount_due: money.round(amountDue || 0),
    currency: query.currency || null,
  };
}

module.exports = {
  /* reads */
  list,
  findById,
  loadForWrite,
  outstandingSummary,
  /* money — pure, and directly asserted by the verification suite */
  computeTotals,
  minAmount,
  lineFromSubscriptionItem,
  overageLinesFor,
  addonsSummaryFrom,
  /* issue */
  issue,
  generateForSubscription,
  alreadyBilled,
  /* transitions */
  finalise,
  cancel,
  applyCoupon,
  removeCoupon,
  recompute,
  /* called by payments / refunds */
  applyPayment,
  applyRefund,
  /* scheduler-facing, no routes */
  markOverdue,
  issueForStartedPeriods,
  INVOICEABLE_STATES,
  reminderCandidates,
  markReminderSent,
  /* shared vocabulary */
  SORTABLE,
  OUTSTANDING_STATUSES,
  PAYABLE_STATUSES,
  MUTABLE_STATUSES,
  LIVE_STATUSES,
};
