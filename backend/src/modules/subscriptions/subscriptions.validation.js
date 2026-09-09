'use strict';

/**
 * Subscription request schemas — SRS §12 (the lifecycle), §11.3 (purchased add-ons), §33 (Feature
 * Overrides / Custom Limits / Custom Pricing); FR-SUB-010 … FR-SUB-015.
 *
 * ## The subscription row is mostly derived, so most of it is refused
 *
 * `subscriptions` has fifty-odd columns and this module accepts about ten of them. Everything else is
 * either copied from the `plan_prices` row the caller chose (`billing_cycle`, `cycle_days`,
 * `pricing_model`, `currency`, `cycle_amount`), computed by a lifecycle operation
 * (`current_period_*`, `next_renewal_at`, `renewal_count`, `credit_balance`, the seven `*_at`
 * stamps), or owned by a dedicated endpoint (`state`, the `scheduled_*` group).
 *
 * Those are **forbidden** rather than left to `stripUnknown`, for the reason
 * `addons.validation.js` gives: a stripped key answers 200 having changed nothing, which from the
 * client's side is indistinguishable from success. `state` is the one that matters most — a client
 * that could set it directly would bypass the transition table in `subscriptions.service.js`, and
 * with it the `subscription_history` row, the `schools.subscription_state` cache and both
 * invalidation calls. Every refusal below names where the value actually comes from.
 *
 * ## `school_id` is accepted on create and refused everywhere after
 *
 * FR-SUB-010's actor is *"System / Super Admin"*, so a subscription is created **for** a school by
 * the platform, and the body has to be able to say which school. `enforceTenant` has already refused
 * the request if a school-scoped caller named a school other than its own, so the field needs no
 * scope check of its own here (see `middlewares/enforceTenant.js` — body keys are walked
 * recursively).
 *
 * On every other route it is forbidden: moving a live subscription between schools would move its
 * invoices, its usage records and its add-on purchases with it, and `subscriptions.school_id` has no
 * operation in the source that changes it.
 *
 * ## Trial and grace durations: the presets are a UI list, not a validator
 *
 * SRS §12.1 offers 3 / 7 / 14 / 30 / **Custom** days and §12.2 offers 1 / 3 / 7 / 15 / **Custom**.
 * Because both lists end in Custom, any non-negative day count is legal and a `valid(...)` over the
 * four presets would contradict the source. The presets are served by `GET /subscriptions/catalogue`
 * so the screen can offer them as buttons; the ceiling of 3650 days is an implementation sanity
 * bound, matching `plans.validation.dayCount()`, not a source constraint.
 *
 * `trial_days: 0` is how "no trial" is said. It is not the same as omitting the field on create —
 * omitting it inherits the plan's `trial_days`, which is what FR-SUB-011's *"New subscriptions on
 * the plan begin in Trial state for the configured duration"* asks for. `0` overrides that
 * inheritance with an explicit refusal of the trial, which a Super Admin negotiating a paid start
 * needs to be able to say.
 *
 * ## Choosing a price
 *
 * `plan_price_id` names the exact `plan_prices` row to bill from. It is optional: a caller may
 * instead give `billing_cycle` and let the service pick that cycle's default price, or give neither
 * and take the plan's default. The selection rule and its refusals live in
 * `subscriptions.service.selectPrice()` — it needs the database, so it cannot be a Joi rule.
 *
 * Both may be given together, and then they must agree: the service checks that the named price
 * really is on the named cycle rather than silently preferring one of the two.
 *
 * ## Overrides — SRS §33
 *
 * `subscription_overrides` is one table serving four different shapes, so the cross-field rules are
 * the whole of this section's value. `entitlementService.resolve()` **logs and ignores** a module or
 * limit override naming a key it does not recognise, and ignores a limit override with no
 * `limit_type`; a feature override with a null `is_enabled` is skipped as saying nothing. Every one
 * of those is a row an operator created, saw accepted, and which then does nothing — so each is
 * refused here instead:
 *
 *  - **`module`** — `target_key` must be one of the twenty SRS §11.1 modules, `is_enabled` required.
 *  - **`feature`** — `target_key` is a free key (`plan_features.feature_key` is a `STRING(80)` with
 *    no enumeration in the source), `is_enabled` required.
 *  - **`limit`** — `target_key` must be one of `USAGE_LIMIT_KEYS`, which is the eight §11.2 plan
 *    limits **plus** `sms_limit`. The add-on-only key is included deliberately: `ADDON_ONLY_LIMITS`
 *    exists because §11.3 sells SMS Credits while §11.2 defines no SMS limit, and a negotiated SMS
 *    allowance is exactly what §33's "Custom Limits" is for. `limit_type` is required;
 *    `limit_value` is required when it is `fixed` and must be absent when it is `unlimited`.
 *  - **`price`** — `amount` required, and `target_key` is restricted to `cycle_amount`. That is the
 *    only price component a subscription row holds, and `entitlementService` skips price overrides
 *    on purpose (*"it belongs to invoice generation rather than here"*), so a row naming anything
 *    else would have no consumer at all. **§13 is now built and still reads no override** —
 *    `grep -rn "SubscriptionOverride" backend/src/modules/invoices/` returns nothing — so a `price`
 *    row is accepted, stored, echoed back on the subscription detail, and read by nothing. That is
 *    triage finding 39, and it is the one exception to this header’s own principle above: every
 *    other override an operator could create and watch do nothing is refused here instead.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
/* `DECIMAL(14, 2)` and its rounding are defined once, in the module that first needed them. */
const { amount, jsonObject } = require('../plans/plans.validation');
const {
  BILLING_CYCLE_LIST,
  SUBSCRIPTION_STATE_LIST,
  SUBSCRIPTION_EVENTS,
  DOWNGRADE_TIMING,
  RENEWAL_MODES,
  OVERRIDE_TYPES,
  MODULE_LIST,
  USAGE_LIMIT_KEYS,
  LIMIT_TYPES,
  PRICE_OVERRIDE_TARGETS,
} = require('../../config/constants');

const EVENT_LIST = Object.freeze(Object.values(SUBSCRIPTION_EVENTS));
const OVERRIDE_TYPE_LIST = Object.freeze(Object.values(OVERRIDE_TYPES));

/**
 * The only price component `subscriptions` carries — see the header.
 *
 * Moved to `config/constants.js` once `catalogue()` began publishing it: the schema that refuses
 * everything else and the endpoint that tells a screen what is accepted must read one list.
 */
const PRICE_TARGETS = PRICE_OVERRIDE_TARGETS;

/**
 * A column this module refuses to write, with the reason in the message.
 *
 * Same device as `addons.validation.js`: naming the key makes it *known*, so `stripUnknown` cannot
 * drop it silently and `forbidden()` turns it into a 422 that says where the value comes from.
 *
 * @param {string} because
 * @returns {import('joi').AnySchema}
 */
const forbiddenField = (because) =>
  Joi.any().forbidden().messages({ 'any.unknown': because });

/** SRS §12.1 / §12.2 both end in "Custom", so any non-negative count is legal — see the header. */
const dayCount = () => Joi.number().integer().min(0).max(3650);

const fields = {
  school_id: commonSchemas.id,
  plan_id: commonSchemas.id,
  plan_price_id: commonSchemas.id,
  addon_id: commonSchemas.id,
  addon_price_id: commonSchemas.id,

  billing_cycle: Joi.string().valid(...BILLING_CYCLE_LIST),

  /**
   * Seats or students, for the §10.4 models that price per unit.
   *
   * `subscriptions.quantity` is `INTEGER UNSIGNED NOT NULL DEFAULT 1` and its comment reads
   * *"Seats/students used by the seat-based and per-student pricing models"*. The minimum is 1: a
   * quantity of 0 on a per-student plan would bill nothing and permit nothing, and there is no
   * operation in §12 that means "subscribed for zero seats" — that is what Cancelled is for.
   */
  quantity: Joi.number().integer().min(1).max(1000000),

  /* Backdating is legitimate — a school that has been running on an agreed plan since term start. */
  starts_at: Joi.date().iso(),

  trial_days: dayCount(),
  grace_period_days: dayCount(),
  renewal_mode: Joi.string().valid(...Object.values(RENEWAL_MODES)),

  /* Lands in `audit_logs.reason`, and in `subscription_history.notes` for the lifecycle routes. */
  reason: Joi.string().trim().max(255).empty('').allow(null),

  metadata: jsonObject(),
};

/**
 * The columns no request may write, each naming its real source.
 *
 * Grouped rather than listed per schema so the set cannot drift between `create` and `update`: a
 * column that is derived on one route is derived on all of them.
 */
const refused = {
  state: forbiddenField(
    '"state" is set by the lifecycle routes (activate, suspend, pause, resume, cancel, reactivate, renew), each of which records a subscription_history row — FR-SUB-010'
  ),
  cycle_days: forbiddenField(
    '"cycle_days" is copied from the chosen plan_prices row, not supplied'
  ),
  pricing_model: forbiddenField(
    '"pricing_model" is copied from the chosen plan_prices row (SRS §10.4), not supplied'
  ),
  currency: forbiddenField(
    '"currency" is copied from the chosen plan_prices row, not supplied'
  ),
  cycle_amount: forbiddenField(
    '"cycle_amount" is calculated from the chosen plan_prices row and the quantity; a negotiated'
      + ' price is configured as the plan\'s own §10.4 Custom Price (FR-SUB-006), not here'
  ),
  current_period_start: forbiddenField(
    '"current_period_start" is set when the subscription starts and advanced by renewal (FR-SUB-015)'
  ),
  current_period_end: forbiddenField(
    '"current_period_end" is derived from the billing cycle, not supplied'
  ),
  ends_at: forbiddenField('"ends_at" is set by cancellation and expiry, not supplied'),
  trial_starts_at: forbiddenField('"trial_starts_at" is derived from "starts_at" and "trial_days"'),
  trial_ends_at: forbiddenField('"trial_ends_at" is derived from "starts_at" and "trial_days"'),
  grace_period_ends_at: forbiddenField(
    '"grace_period_ends_at" is derived from "grace_period_days" when the subscription becomes past due (FR-SUB-012)'
  ),
  next_renewal_at: forbiddenField('"next_renewal_at" is derived from the billing cycle'),
  last_renewed_at: forbiddenField('"last_renewed_at" is set by renewal (FR-SUB-015)'),
  renewal_count: forbiddenField('"renewal_count" is incremented by renewal (FR-SUB-015)'),
  scheduled_plan_id: forbiddenField(
    '"scheduled_plan_id" is written by POST /:id/downgrade with timing=next_billing_cycle (FR-SUB-014)'
  ),
  scheduled_plan_price_id: forbiddenField(
    '"scheduled_plan_price_id" is written by POST /:id/downgrade with timing=next_billing_cycle (FR-SUB-014)'
  ),
  scheduled_change_type: forbiddenField(
    '"scheduled_change_type" is written by POST /:id/downgrade (FR-SUB-014)'
  ),
  scheduled_change_timing: forbiddenField(
    '"scheduled_change_timing" is the "timing" field of POST /:id/downgrade (SRS §12.4)'
  ),
  scheduled_change_at: forbiddenField(
    '"scheduled_change_at" is the end of the current billing period, not supplied'
  ),
  credit_balance: forbiddenField(
    '"credit_balance" is the remaining credit calculated by an upgrade or downgrade (SRS §12.3)'
  ),
  wallet_balance: forbiddenField(
    '"wallet_balance" belongs to the §13.2 wallet payment method, not to this module'
  ),
  paused_at: forbiddenField('"paused_at" is set by POST /:id/pause'),
  cancelled_at: forbiddenField('"cancelled_at" is set by POST /:id/cancel'),
  cancellation_reason: forbiddenField('"cancellation_reason" is the "reason" field of POST /:id/cancel'),
  suspended_at: forbiddenField('"suspended_at" is set by POST /:id/suspend'),
  expired_at: forbiddenField('"expired_at" is set when the grace period ends (FR-SUB-012)'),
  expiry_notified_at: forbiddenField('"expiry_notified_at" is written by the expiry notice, not by a client'),
};

/** `school_id` is create-only — see the header. */
const refusedSchoolId = forbiddenField(
  '"school_id" is fixed when the subscription is created; a subscription cannot be moved between schools'
);

/** `plan_id` changes only through FR-SUB-013 and FR-SUB-014. */
const refusedPlanChange = {
  plan_id: forbiddenField(
    '"plan_id" changes only through POST /:id/upgrade (FR-SUB-013) or POST /:id/downgrade (FR-SUB-014)'
  ),
  plan_price_id: forbiddenField(
    '"plan_price_id" changes only through POST /:id/upgrade (FR-SUB-013) or POST /:id/downgrade (FR-SUB-014)'
  ),
};

/* ──────────────── FR-SUB-010 — put a school on a plan (§12, Pending / Trial) ─────────────── */

/**
 * `POST /subscriptions`.
 *
 * `plan_id` is required and `school_id` is required: this is the operation the whole subscription
 * catalogue exists to enable, and neither side of it can be inferred. Everything else has a
 * defensible default — the plan's trial and grace durations, its `default_renewal_mode`, its default
 * price, `starts_at` of now, `quantity` of 1.
 */
const create = Joi.object({
  school_id: fields.school_id.required(),
  plan_id: fields.plan_id.required(),
  plan_price_id: fields.plan_price_id,
  billing_cycle: fields.billing_cycle,
  quantity: fields.quantity,
  starts_at: fields.starts_at,
  trial_days: fields.trial_days,
  grace_period_days: fields.grace_period_days,
  renewal_mode: fields.renewal_mode,
  reason: fields.reason,
  metadata: fields.metadata,
  ...refused,
});

/* ─────────── FR-SUB-011 / FR-SUB-012 — trial and grace configuration (§12.1, §12.2) ─────────── */

/**
 * `PATCH /subscriptions/:id`.
 *
 * The four fields a Super Admin may change on a live subscription without it being a plan change:
 * the trial length, the grace length, the renewal mode and the quantity. FR-SUB-011 and FR-SUB-012
 * both actor to *"Super Admin"* and both say *"or subscription"* in their preconditions
 * (*"Plan or subscription exists"*), which is what makes a per-subscription duration in scope at all
 * rather than a plan-only setting.
 *
 * `quantity` is here because the §10.4 per-unit models bill from it and a school's seat count changes
 * without the plan changing. Altering it re-evaluates `cycle_amount` from the same price row — see
 * `subscriptions.service.update()`.
 */
const update = Joi.object({
  trial_days: fields.trial_days,
  grace_period_days: fields.grace_period_days,
  renewal_mode: fields.renewal_mode,
  quantity: fields.quantity,
  metadata: fields.metadata,
  reason: fields.reason,
  school_id: refusedSchoolId,
  ...refusedPlanChange,
  ...refused,
})
  .min(1)
  .messages({ 'object.min': 'Provide at least one field to update' });

/* ──────────────────────── FR-SUB-010 — the six operator transitions ─────────────────────── */

/**
 * Every lifecycle route takes the same body: an optional reason.
 *
 * One schema rather than six identical ones, so a reason cannot become mandatory on one transition
 * and optional on the next by accident. `cancel` uses the same shape but its reason has a second
 * destination — `subscriptions.cancellation_reason`, which is a real column — so it is declared
 * separately to carry that in its own message.
 */
const transition = Joi.object({ reason: fields.reason, ...refused, school_id: refusedSchoolId });

const cancel = Joi.object({
  /** Stored in `subscriptions.cancellation_reason` as well as `audit_logs.reason`. */
  reason: fields.reason,
  ...refused,
  school_id: refusedSchoolId,
});

/* ───────────────── FR-SUB-013 / FR-SUB-014 — upgrade and downgrade (§12.3, §12.4) ──────────── */

/**
 * The plan change body, shared by both directions.
 *
 * `quantity` is optional and defaults to the subscription's current value, so an upgrade does not
 * silently reset a school's seat count to 1.
 *
 * Direction is **not** a field. FR-SUB-013 is *"upgrades … to a higher plan or tier"* and FR-SUB-014
 * is *"downgrades … to a lower plan or tier"*, so which one applies is a fact about the two plans'
 * `tier_rank`, not a claim the caller makes. `subscriptions.service.changePlan()` classifies it and
 * refuses a request that arrived on the wrong route — a caller who asks to "upgrade" to a cheaper
 * plan has either misread the catalogue or is trying to skip the §12.4 timing choice, and both
 * deserve an error rather than a silent reinterpretation.
 */
const planChange = {
  plan_id: fields.plan_id.required(),
  plan_price_id: fields.plan_price_id,
  billing_cycle: fields.billing_cycle,
  quantity: fields.quantity,
  reason: fields.reason,
  school_id: refusedSchoolId,
  ...refused,
};

const upgrade = Joi.object({ ...planChange });

/**
 * `POST /:id/downgrade`.
 *
 * `timing` is required with no default. SRS §12.4 lists exactly two options — Immediate and Next
 * Billing Cycle — and they differ in when the school loses capability: an immediate downgrade can
 * drop a limit below what the school is already using, while the deferred one cannot until the
 * period ends. Defaulting either way would make that consequence implicit, so the caller states it.
 */
const downgrade = Joi.object({
  ...planChange,
  timing: Joi.string()
    .valid(...Object.values(DOWNGRADE_TIMING))
    .required()
    .messages({
      'any.required':
        '"timing" is required: SRS §12.4 offers "immediate" or "next_billing_cycle" and the choice changes when the school loses capability',
    }),
});

/* ─────────────────────────── FR-SUB-015 — renewal (§12.5) ─────────────────────────── */

/**
 * `POST /:id/renew` — Manual Renewal, *"initiated by an authorized user"*.
 *
 * `renewal_mode` is deliberately not a field here: it is configuration, changed through
 * `PATCH /:id`, and a renewal that also flipped the mode would make the audit trail ambiguous about
 * which of the two the operator meant. Automatic Renewal is the same service function called by
 * `runLifecycleSweep()` with no request — see `subscriptions.service.js`.
 */
const renew = Joi.object({ reason: fields.reason, ...refused, school_id: refusedSchoolId });

/* ───────────────── §11.3 / FR-SUB-009 — purchase an add-on onto a subscription ──────────── */

/**
 * `POST /:id/addons`.
 *
 * `addon_price_id` is optional — an add-on may be granted at no charge as part of a negotiation, and
 * `subscription_addons.addon_price_id` is nullable and `SET NULL` precisely so the row survives the
 * price being retired. When it is given, the service checks it belongs to the named add-on and is not
 * restricted to a different plan.
 *
 * `unit_amount`, `effect_type`, `effect_target` and `units_granted` are all absent by design: they
 * are the **purchase copy**, resolved from the `addons` row and the quantity at purchase time so a
 * later catalogue edit cannot change what a school bought. `subscriptions.service.purchaseAddon()`
 * computes them; `entitlementService.js` explains why the multiplication happens there and nowhere
 * else.
 */
const purchaseAddon = Joi.object({
  addon_id: fields.addon_id.required(),
  addon_price_id: fields.addon_price_id,
  quantity: Joi.number().integer().min(1).max(1000000).default(1),

  /* Both nullable on the model: null `ends_at` is an add-on with no end date. */
  starts_at: Joi.date().iso().allow(null),
  ends_at: Joi.date().iso().allow(null),
  is_recurring: Joi.boolean(),
  reason: fields.reason,

  unit_amount: forbiddenField(
    '"unit_amount" is copied from the chosen addon_prices row at purchase time, not supplied'
  ),
  effect_type: forbiddenField(
    '"effect_type" is copied from the addons row at purchase time (ADDON_EFFECTS), not supplied'
  ),
  effect_target: forbiddenField(
    '"effect_target" is copied from the addons row at purchase time (ADDON_EFFECTS), not supplied'
  ),
  units_granted: forbiddenField(
    '"units_granted" is quantity × addons.units_per_quantity, computed at purchase time so a later add-on edit cannot change what was bought'
  ),
  status: forbiddenField(
    '"status" is set by POST /:id/addons/:addonId/cancel, which records why'
  ),
  currency: forbiddenField('"currency" is copied from the chosen addon_prices row, not supplied'),
  school_id: refusedSchoolId,
});

const cancelAddon = Joi.object({ reason: fields.reason, school_id: refusedSchoolId });

/* ──────────────── §33 — Feature Overrides, Custom Limits, Custom Pricing ─────────────── */

/**
 * One `subscription_overrides` row.
 *
 * The four `when` blocks are the whole point of this schema; the header explains what each one is
 * preventing. Written as `when` rather than as four separate schemas because `override_type` is a
 * single column on a single table and the shared fields — `reason`, the effective window,
 * `target_key` itself — would otherwise be declared four times.
 */
const createOverride = Joi.object({
  override_type: Joi.string()
    .valid(...OVERRIDE_TYPE_LIST)
    .required(),

  target_key: Joi.string()
    .trim()
    .max(60)
    .required()
    .when('override_type', {
      is: OVERRIDE_TYPES.MODULE,
      then: Joi.string()
        .valid(...MODULE_LIST)
        .messages({
          'any.only':
            '"target_key" must name one of the twenty SRS §11.1 modules; entitlement resolution ignores an override naming anything else',
        }),
    })
    .when('override_type', {
      is: OVERRIDE_TYPES.LIMIT,
      then: Joi.string()
        .valid(...USAGE_LIMIT_KEYS)
        .messages({
          'any.only':
            '"target_key" must name one of the eight SRS §11.2 limits or the add-on-only sms_limit; entitlement resolution ignores an override naming anything else',
        }),
    })
    .when('override_type', {
      is: OVERRIDE_TYPES.PRICE,
      then: Joi.string()
        .valid(...PRICE_TARGETS)
        .messages({
          'any.only':
            '"target_key" must be "cycle_amount" — the only price component a subscription row carries',
        }),
    }),

  /* Required on module and feature overrides: a null says nothing, and entitlement skips it. */
  is_enabled: Joi.boolean()
    .when('override_type', {
      is: Joi.valid(OVERRIDE_TYPES.MODULE, OVERRIDE_TYPES.FEATURE),
      then: Joi.required(),
      otherwise: Joi.forbidden().messages({
        'any.unknown': '"is_enabled" applies only to a module or feature override',
      }),
    })
    .messages({
      'any.required':
        '"is_enabled" is required on a module or feature override; entitlement resolution ignores a null',
    }),

  limit_type: Joi.string()
    .valid(...Object.values(LIMIT_TYPES))
    .when('override_type', {
      is: OVERRIDE_TYPES.LIMIT,
      then: Joi.required(),
      otherwise: Joi.forbidden().messages({
        'any.unknown': '"limit_type" applies only to a limit override',
      }),
    })
    .messages({
      'any.required':
        '"limit_type" is required on a limit override; entitlement resolution ignores a limit override without one',
    }),

  /* BIGINT column. Required for `fixed`, refused for `unlimited` — where the value is meaningless. */
  limit_value: Joi.number()
    .integer()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .when('limit_type', {
      is: LIMIT_TYPES.FIXED,
      then: Joi.required(),
      otherwise: Joi.forbidden().messages({
        'any.unknown':
          '"limit_value" applies only when "limit_type" is fixed; an unlimited limit has no value',
      }),
    })
    .messages({
      'any.required': '"limit_value" is required when "limit_type" is fixed',
    }),

  amount: amount().when('override_type', {
    is: OVERRIDE_TYPES.PRICE,
    then: Joi.required(),
    otherwise: Joi.forbidden().messages({
      'any.unknown': '"amount" applies only to a price override (SRS §33 Custom Pricing)',
    }),
  }),

  /**
   * The effective window `entitlementService` reads through `activeWindow()`.
   *
   * Both nullable: an override with no `effective_from` applies immediately and one with no
   * `effective_until` applies until it is revoked, which is the ordinary case for a negotiated limit.
   */
  effective_from: Joi.date().iso().allow(null),
  effective_until: Joi.date().iso().allow(null),

  reason: Joi.string().trim().max(255).empty('').allow(null),

  is_active: forbiddenField(
    '"is_active" is set by POST /:id/overrides/:overrideId/revoke, which records why'
  ),
  school_id: refusedSchoolId,
})
  /* Cross-field, so it cannot live on either key. An inverted window silently matches nothing. */
  .custom((value, helpers) => {
    const { effective_from: from, effective_until: until } = value;
    if (from && until && new Date(until) < new Date(from)) {
      return helpers.message('"effective_until" must be on or after "effective_from"');
    }
    return value;
  });

const revokeOverride = Joi.object({ reason: fields.reason, school_id: refusedSchoolId });

/* ───────────────────────────────── Queries and params ───────────────────────────────── */

const list = listQuery(
  Joi.object({
    /* Platform callers filter by school; `enforceTenant` has already confined everyone else. */
    school_id: fields.school_id,
    plan_id: fields.plan_id,
    state: Joi.string().valid(...SUBSCRIPTION_STATE_LIST),
    renewal_mode: fields.renewal_mode,

    /**
     * `?expiring_within_days=7` — subscriptions whose current period ends inside the window.
     *
     * The renewal screen FR-SUB-015 implies has to be able to ask "what needs renewing this week",
     * and doing that client-side means paging the whole table. Zero is allowed and means "already
     * past its period end".
     */
    expiring_within_days: Joi.number().integer().min(0).max(3650),
  })
);

const history = listQuery(Joi.object({ event: Joi.string().valid(...EVENT_LIST) }));

const addonParam = Joi.object({
  id: commonSchemas.id.required(),
  addonId: commonSchemas.id.required(),
});

const overrideParam = Joi.object({
  id: commonSchemas.id.required(),
  overrideId: commonSchemas.id.required(),
});

module.exports = {
  schemas: {
    create,
    update,
    transition,
    cancel,
    upgrade,
    downgrade,
    renew,
    purchaseAddon,
    cancelAddon,
    createOverride,
    revokeOverride,
    list,
    history,
    idParam: commonSchemas.idParam,
    addonParam,
    overrideParam,
  },
  EVENT_LIST,
  OVERRIDE_TYPE_LIST,
  PRICE_TARGETS,
  fields,
  refused,
  dayCount,
};
