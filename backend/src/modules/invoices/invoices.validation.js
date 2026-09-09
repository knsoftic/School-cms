'use strict';

/**
 * Invoice request schemas — SRS §13.1, FR-BILL-001.
 *
 * ## Almost nothing here is a money field, and that is the point
 *
 * §13.1's *Subtotal*, *Discount*, *Tax* and *Total* are all **computed** by
 * `invoices.service.computeTotals()` from the subscription's own line items, the coupon and the tax row.
 * None of the four is accepted from a caller, and each is named in `refused` so a request that sends one
 * gets a 422 saying where the figure comes from rather than a silent 200 that changed nothing.
 *
 * A schema that accepted `total` would make the invoice a claim about what a school owes rather than a
 * derivation from what it bought — and the two would diverge the first time a coupon was applied.
 *
 * ## What a caller does decide
 *
 * The *inputs* to the calculation, not its outputs: which coupon (`coupon_code` or `coupon_id`), which
 * tax (`tax_id`, defaulting to the active default), whether to draw down the subscription's credit
 * balance (`apply_credit`), and whether to sweep overage in (`include_overage`). Plus the two dates and
 * the free-text `notes` the printed document carries.
 *
 * ## `status` accepts two of the seven
 *
 * `INVOICE_STATUS` has seven values. Only `draft` and `unpaid` are settable at issue, because the other
 * five are consequences: `partially_paid` and `paid` are sums of approved payments, `overdue` is the
 * clock, `cancelled` and `refunded` each have their own operation and their own audit entry. A settable
 * `paid` would let an invoice be marked settled without a `payments` row behind it, which is the one
 * thing FR-BILL-004 is for.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { amount } = require('../plans/plans.validation');
const { INVOICE_STATUS } = require('../../config/constants');

/** The two statuses an issuance may ask for. See the header. */
const ISSUABLE_STATUSES = Object.freeze([INVOICE_STATUS.DRAFT, INVOICE_STATUS.UNPAID]);

/**
 * A field this module computes and will not accept.
 *
 * `stripUnknown` would drop it silently and answer 200; naming the key makes it *known*, so
 * `forbidden()` turns it into a 422 that says which function owns the figure. The pattern
 * `addons.validation.js` established.
 *
 * @param {string} because
 * @returns {import('joi').AnySchema}
 */
const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

const refused = {
  invoice_number: forbiddenField(
    '"invoice_number" is allocated by the system (utils/documentNumber.js) and cannot be set'
  ),
  subtotal: forbiddenField('"subtotal" is the sum of the invoice line items and cannot be set'),
  discount_amount: forbiddenField(
    '"discount_amount" is computed from the coupon (SRS §13.4) — send "coupon_code" instead'
  ),
  tax_amount: forbiddenField('"tax_amount" is computed from the tax rate — send "tax_id" instead'),
  total: forbiddenField('"total" is computed as subtotal − discount + tax (SRS §13.1)'),
  amount_paid: forbiddenField(
    '"amount_paid" is the sum of approved payments (FR-BILL-004) and cannot be set'
  ),
  amount_due: forbiddenField('"amount_due" is computed from the total and what has been paid'),
  credit_applied: forbiddenField(
    '"credit_applied" is drawn from the subscription\'s credit balance — send "apply_credit"'
  ),
  paid_at: forbiddenField('"paid_at" is written when the invoice is settled'),
  cancelled_at: forbiddenField('"cancelled_at" is written by the cancel operation'),
  reminder_sent_at: forbiddenField('"reminder_sent_at" is written by the reminder job'),
};

const fields = {
  subscription_id: Joi.number().integer().min(1),
  school_id: Joi.number().integer().min(1),
  plan_id: Joi.number().integer().min(1),

  billing_period_start: Joi.date().iso(),
  billing_period_end: Joi.date().iso(),

  issue_date: Joi.date().iso(),
  due_date: Joi.date().iso(),

  /* Either identifier for the coupon. `coupon_code` is what a school types; the id is the screen's. */
  coupon_code: Joi.string().trim().uppercase().min(3).max(60),
  coupon_id: Joi.number().integer().min(1),

  /* `null` is meaningful: "no tax on this invoice", as opposed to omitted, which takes the default. */
  tax_id: Joi.number().integer().min(1).allow(null),

  apply_credit: Joi.boolean(),
  include_overage: Joi.boolean(),
  first_cycle: Joi.boolean(),

  status: Joi.string()
    .valid(...ISSUABLE_STATUSES)
    .messages({
      'any.only': `"status" may be ${ISSUABLE_STATUSES.join(' or ')} at issue — the rest are consequences of payment, the clock, or an explicit operation`,
    }),

  notes: Joi.string().trim().max(5000).empty('').allow(null),
  metadata: Joi.object().unknown(true).allow(null),

  /* Lands in `audit_logs.reason`. */
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

/**
 * The period rule, checked at object level so both bounds are in hand at once.
 *
 * @param {object} value
 * @param {object} helpers
 * @returns {object|any}
 */
function checkPeriod(value, helpers) {
  if (value.billing_period_start && value.billing_period_end) {
    const start = new Date(value.billing_period_start).getTime();
    const end = new Date(value.billing_period_end).getTime();

    if (end <= start) {
      return helpers.message('"billing_period_end" must be after "billing_period_start"');
    }
  }

  if (value.coupon_code && value.coupon_id) {
    return helpers.message('Send either "coupon_code" or "coupon_id", not both');
  }

  return value;
}

/* ───────────────── FR-BILL-001 — invoice generation ───────────────── */

/**
 * `POST /invoices/generate`.
 *
 * `subscription_id` is required and is the whole of FR-BILL-001's precondition — *"Subscription exists
 * and a billing event occurs"*. The period defaults to the subscription's current one, so a caller that
 * sends nothing but the id gets the invoice the requirement describes.
 */
const generate = Joi.object({
  subscription_id: fields.subscription_id.required(),

  billing_period_start: fields.billing_period_start,
  billing_period_end: fields.billing_period_end,

  issue_date: fields.issue_date,
  due_date: fields.due_date,

  coupon_code: fields.coupon_code,
  coupon_id: fields.coupon_id,
  tax_id: fields.tax_id,

  apply_credit: fields.apply_credit.default(true),
  include_overage: fields.include_overage.default(true),
  /*
   * Overrides the `renewal_count === 0` inference. Present because re-issuing a cancelled first invoice
   * has to be able to say "this is still the first cycle, the setup fee is still owed".
   */
  first_cycle: fields.first_cycle,

  status: fields.status.default(INVOICE_STATUS.UNPAID),

  notes: fields.notes,
  metadata: fields.metadata,
  reason: fields.reason,

  ...refused,
}).custom(checkPeriod);

/* ───────────────────────── Status operations ───────────────────────── */

/** `POST /:id/finalise`, `POST /:id/cancel`, `DELETE /:id/coupon` — a reason and nothing else. */
const reasonOnly = Joi.object({ reason: fields.reason });

/** `POST /:id/coupon` — FR-BILL-005's *"School applies a valid coupon to an invoice"*. */
const applyCoupon = Joi.object({
  code: fields.coupon_code.required(),
  reason: fields.reason,
});

/* ───────────────────────────── Queries ───────────────────────────── */

const list = listQuery(
  Joi.object({
    school_id: fields.school_id,
    subscription_id: fields.subscription_id,
    plan_id: fields.plan_id,
    coupon_id: fields.coupon_id,
    status: Joi.string().valid(...Object.values(INVOICE_STATUS)),
    currency: Joi.string().trim().uppercase().length(3),
    /** Shorthand for the three statuses that still represent money owed. */
    outstanding: Joi.boolean(),
    due_from: Joi.date().iso(),
    due_to: Joi.date().iso(),
    issued_from: Joi.date().iso(),
    issued_to: Joi.date().iso(),
    /** Partial match on `invoice_number` — what a search box sends. */
    number: Joi.string().trim().max(40),
  })
);

const summary = Joi.object({
  school_id: fields.school_id,
  currency: Joi.string().trim().uppercase().length(3),
});

module.exports = {
  schemas: {
    generate,
    applyCoupon,
    reasonOnly,
    list,
    summary,
    idParam: commonSchemas.idParam,
  },
  fields,
  refused,
  checkPeriod,
  ISSUABLE_STATUSES,
  /* Re-exported so the payments module's schemas can share the money shape. */
  amount,
};
