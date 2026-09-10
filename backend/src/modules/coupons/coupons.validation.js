'use strict';

/**
 * Coupon request schemas — SRS §13.4, FR-BILL-005.
 *
 * ## The six §13.4 attributes, and the two columns that are not among them
 *
 * §13.4 names *Percentage*, *Fixed Amount*, *Expiry*, *Maximum Uses*, *Plan Restrictions* and *School
 * Restrictions*. Every one is settable here. `max_discount_amount` and `min_order_amount` are also
 * settable, and both are nullable columns `models/billing.js` defines with its own reasons — a coupon
 * that omits them behaves exactly as §13.4 describes, so accepting them adds an option rather than a
 * requirement.
 *
 * ## `discount_value` means two different things, so it is validated two different ways
 *
 * The column comment is explicit: *"Percent when percentage, currency amount when fixed_amount"*. The
 * model carries a `percentageInRange` validator for the first case, which would surface as a 500-shaped
 * database validation error rather than a 422 naming the field — so the same bound is expressed here,
 * where it produces the right status and a message that says which of the two meanings applies.
 *
 * `min(0)` is not enough for a percentage: a 0% coupon discounts nothing while appearing to work, and
 * the model's validator already refuses `<= 0`. The floor here is therefore `0.01` for percentages.
 * For a fixed amount, `0` is refused on the same grounds — a coupon that takes nothing off is a
 * support ticket, not a configuration.
 *
 * ## `currency` is required for a fixed amount and forbidden for a percentage
 *
 * The column's comment is *"Required for fixed_amount"*. The other half — forbidding it on a
 * percentage — is this schema's: a percentage coupon is currency-agnostic by construction, and a
 * stored `currency` on one would be read by `validateForOrder()`'s mismatch check as a restriction the
 * operator never meant to set.
 *
 * ## Three columns the caller may never write
 *
 *  - **`used_count`** — the redemption ledger's. `coupons.service.redeem()` increments it in SQL and
 *    `coupon_usages` is the audit trail behind it. A caller-supplied value would make §13.4's *Maximum
 *    Uses* mean whatever the last request said.
 *  - **`status: 'expired'`** — a fact about `expires_at` and the clock, written by
 *    `coupons.service.expireLapsed()`. Setting it by hand on a coupon that has not lapsed produces a
 *    row whose two columns disagree; `inactive` is the switch for "stop honouring this now".
 *  - **`created_by`** — taken from the authenticated user, like every other actor column in the
 *    project.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { amount } = require('../plans/plans.validation');
const { COUPON_TYPES, COUPON_STATUS } = require('../../config/constants');

/** Coupon codes are typed by people off a printed page, so the character set is deliberately narrow. */
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;

/** The two statuses an operator may set. `expired` is the sweep's — see the header. */
const SETTABLE_STATUSES = Object.freeze([COUPON_STATUS.ACTIVE, COUPON_STATUS.INACTIVE]);

/**
 * A column this module refuses to write, with the reason in the message.
 *
 * `stripUnknown` would drop these silently and answer 200, which is indistinguishable from having
 * worked. Naming the key makes it *known*, and `forbidden()` turns it into a 422 that says where the
 * value comes from — the pattern `addons.validation.js` established.
 *
 * @param {string} because
 * @returns {import('joi').AnySchema}
 */
const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

const refused = {
  used_count: forbiddenField(
    '"used_count" is maintained by coupon redemption (SRS §13.4 "Maximum Uses") and cannot be set directly'
  ),
  created_by: forbiddenField('"created_by" is taken from the authenticated user'),
};

/** A list of positive integer ids. `null` and `[]` both mean unrestricted, per the model's comment. */
const idArray = (label) =>
  Joi.array()
    .items(Joi.number().integer().min(1))
    .max(500)
    .unique()
    .allow(null)
    .messages({
      'array.unique': `"${label}" lists the same id twice`,
      'array.max': `"${label}" may not name more than 500 ids`,
    });

const fields = {
  code: Joi.string().trim().uppercase().min(3).max(60).pattern(CODE_PATTERN).messages({
    'string.pattern.base':
      '"code" may contain uppercase letters, digits, dashes and underscores only',
  }),

  name: Joi.string().trim().min(2).max(160).empty('').allow(null),
  description: Joi.string().trim().max(255).empty('').allow(null),

  discount_type: Joi.string().valid(...Object.values(COUPON_TYPES)),

  /*
   * The two meanings, expressed as one conditional. `when` reads `discount_type` from the same object,
   * so `PATCH { discount_value: 150 }` on a percentage coupon is refused by the branch that applies —
   * but only when `discount_type` is present in the same body. See `checkValueAgainstType()` for the
   * half a schema cannot see.
   */
  discount_value: Joi.number()
    .min(0.01)
    .when('discount_type', {
      is: COUPON_TYPES.PERCENTAGE,
      then: Joi.number().min(0.01).max(100).precision(2).messages({
        'number.max': '"discount_value" is a percentage here and may not exceed 100',
        'number.min': '"discount_value" must be greater than 0 — a 0% coupon discounts nothing',
      }),
      otherwise: amount().min(0.01).messages({
        'number.min': '"discount_value" must be greater than 0 — a coupon worth 0 discounts nothing',
      }),
    }),

  currency: Joi.string().trim().uppercase().length(3).allow(null),

  max_discount_amount: amount().allow(null),
  min_order_amount: amount().allow(null),

  starts_at: Joi.date().iso().allow(null),
  expires_at: Joi.date().iso().allow(null),

  /* `INTEGER UNSIGNED` columns. Null = unlimited, which is the model's own comment on `max_uses`. */
  max_uses: Joi.number().integer().min(1).max(4294967295).allow(null).messages({
    'number.min': '"max_uses" must be at least 1 — use null for unlimited',
  }),
  max_uses_per_school: Joi.number().integer().min(1).max(4294967295).allow(null).messages({
    'number.min': '"max_uses_per_school" must be at least 1 — use null for unlimited',
  }),

  restricted_plan_ids: idArray('restricted_plan_ids'),
  restricted_school_ids: idArray('restricted_school_ids'),

  status: Joi.string()
    .valid(...SETTABLE_STATUSES)
    .messages({
      'any.only': `"status" may be ${SETTABLE_STATUSES.join(' or ')} — "expired" is set from "expires_at" by the scheduled sweep`,
    }),

  /* Lands in `audit_logs.reason`; `coupons` has no column for it and none may be added (SRS §35). */
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

/**
 * The window rule, and the currency rule, checked at object level.
 *
 * `expires_at > starts_at` is also a model validator (`windowOrdered`), which would surface as a
 * database error rather than a 422 — the same argument the header makes for `percentageInRange`.
 *
 * The currency rule needs both fields at once, which is why it is here rather than a `when` on
 * `currency`: a `when` referencing `discount_type` cannot fire on a `PATCH` body that omits the type.
 *
 * @param {object} value
 * @param {object} helpers
 * @returns {object|any}
 */
function checkCoherence(value, helpers) {
  if (value.starts_at && value.expires_at) {
    if (new Date(value.expires_at).getTime() <= new Date(value.starts_at).getTime()) {
      return helpers.message('"expires_at" must be after "starts_at"');
    }
  }

  if (value.discount_type === COUPON_TYPES.PERCENTAGE && value.currency) {
    return helpers.message(
      '"currency" does not apply to a percentage coupon — a percentage discount is currency-agnostic'
    );
  }

  /*
   * `max_discount_amount` on a percentage coupon is deliberately *not* required to have a currency.
   * The cap is a currency amount and the coupon has none of its own, so it is compared against the
   * invoice's currency, whatever that is. Noted because it read like an omission twice while this file
   * was being written.
   */
  return value;
}

/* ─────────────────── FR-BILL-005 — management (Super Admin) ─────────────────── */

const create = Joi.object({
  code: fields.code.required(),
  name: fields.name,
  description: fields.description,

  discount_type: fields.discount_type.required(),
  discount_value: fields.discount_value.required(),

  /* The column comment: *"Required for fixed_amount"*. */
  currency: fields.currency.when('discount_type', {
    is: COUPON_TYPES.FIXED_AMOUNT,
    then: Joi.string().trim().uppercase().length(3).required().messages({
      'any.required': '"currency" is required for a fixed-amount coupon',
    }),
  }),

  max_discount_amount: fields.max_discount_amount,
  min_order_amount: fields.min_order_amount,

  starts_at: fields.starts_at,
  expires_at: fields.expires_at,

  max_uses: fields.max_uses,
  max_uses_per_school: fields.max_uses_per_school,

  restricted_plan_ids: fields.restricted_plan_ids,
  restricted_school_ids: fields.restricted_school_ids,

  status: fields.status.default(COUPON_STATUS.ACTIVE),

  ...refused,
}).custom(checkCoherence);

const update = Joi.object({
  code: fields.code,
  name: fields.name,
  description: fields.description,
  discount_type: fields.discount_type,
  discount_value: fields.discount_value,
  currency: fields.currency,
  max_discount_amount: fields.max_discount_amount,
  min_order_amount: fields.min_order_amount,
  starts_at: fields.starts_at,
  expires_at: fields.expires_at,
  max_uses: fields.max_uses,
  max_uses_per_school: fields.max_uses_per_school,
  restricted_plan_ids: fields.restricted_plan_ids,
  restricted_school_ids: fields.restricted_school_ids,
  status: fields.status,
  /*
   * Accepted here as it is on create. The edit screen offered a "Reason — recorded in the audit
   * trail" box and this schema had no key for it, so `stripUnknown` dropped it and the screen said
   * the reason had been recorded when nothing had.
   */
  reason: fields.reason,
  ...refused,
})
  .min(1)
  .messages({ 'object.min': 'Provide at least one field to update' })
  .custom(checkCoherence);

/* ─────────────────── FR-BILL-005 — redemption check (School) ─────────────────── */

/**
 * `POST /coupons/validate` — *"would this code apply, and for how much"*.
 *
 * `school_id` is optional and defaults to the caller's school in the controller. A platform caller
 * checking a code on a school's behalf names it; a school caller may not name another (the route's
 * scope handling refuses it), so omitting it is the normal case.
 *
 * `amount` is required. Every §13.4 rule that involves money — `min_order_amount`, the fixed-amount
 * cap, the percentage calculation — needs the figure the discount would apply to, and answering
 * "valid" without a discount figure would be answering a different question than the screen asked.
 */
const validateCode = Joi.object({
  code: fields.code.required(),
  school_id: Joi.number().integer().min(1),
  plan_id: Joi.number().integer().min(1),
  amount: amount().required(),
  currency: Joi.string().trim().uppercase().length(3),
});

/* ───────────────────────────────── Queries ───────────────────────────────── */

const list = listQuery(
  Joi.object({
    status: Joi.string().valid(...Object.values(COUPON_STATUS)),
    discount_type: Joi.string().valid(...Object.values(COUPON_TYPES)),
    /** Coupons usable right now, by the same four columns `validateForOrder()` reads. */
    valid_now: Joi.boolean(),
  })
);

const usages = listQuery(Joi.object({ school_id: Joi.number().integer().min(1) }));

module.exports = {
  schemas: {
    create,
    update,
    validateCode,
    list,
    usages,
    idParam: commonSchemas.idParam,
  },
  fields,
  refused,
  checkCoherence,
  SETTABLE_STATUSES,
  CODE_PATTERN,
};
