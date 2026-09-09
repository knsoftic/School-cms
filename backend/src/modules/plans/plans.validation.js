'use strict';

/**
 * Plan request schemas — SRS §10.2 (Plan Builder), §10.3 (Billing Cycles), §10.4 (Pricing Models),
 * §11.1 (Modules), §11.2 (Limits), covering FR-SUB-001 … FR-SUB-007.
 *
 * SRS §10.2 fixes the plan fields — *"Name, Code, Description, Status, Public/Private, Recommended,
 * Display Order"* — and §29 leaves column-level schema unspecified beyond the tenancy columns, so the
 * accepted field set is those seven plus the `subscription_plans` columns the lifecycle sections need
 * (`trial_days` for §12.1, `grace_period_days` for §12.2, `default_renewal_mode` for §12.5, `tier_rank`
 * for the §12.3 / §12.4 upgrade-versus-downgrade classification).
 *
 * ## What the body may not contain, and why
 *
 *  - **`status`, anywhere.** FR-SUB-004 (Activate / Deactivate) and FR-SUB-005 (Archive) are separate
 *    operations, and archiving stamps `archived_at` while activating clears it. A raw `status` write in
 *    the general edit would leave the column and the timestamp disagreeing — an `active` plan carrying
 *    an `archived_at` reads as archived to every query that filters on the timestamp. The service keeps
 *    the two in step through one transition table, exactly as `schools.service.js` does, and that is
 *    only true if `status` has no second way in.
 *
 *    On **create** it is neither accepted nor refused: `status` is simply absent from the `create`
 *    schema below, and `validate.js` applies `stripUnknown: true` to bodies, so a create naming it
 *    answers **201 having silently discarded it**. This paragraph used to claim it was "refused on
 *    create as well", which is the shape this codebase argues against everywhere else —
 *    `coupons.validation.js:60-62`, "a stripped key answers 200 having changed nothing, which a
 *    caller cannot distinguish from success". The service still overrides the column
 *    (`subscription_plans.status` defaults to `active`), so the BEHAVIOUR is right and only the
 *    disclosure was wrong; making it a `forbiddenField` is triage finding 11 and is a separate change. A plan created active would be
 *    *"available for new subscriptions"* — FR-SUB-004's own words — while carrying no `plan_prices` row
 *    to bill against and no `plan_limits` rows, which resolve to zero and forbid the school everything.
 *    The Plan Builder sequence in §10.2 is create, then configure (FR-SUB-006, FR-SUB-007), then
 *    activate; a new plan is therefore `inactive` and FR-SUB-004 is the only way it becomes available.
 *    The source does not specify a starting status, and this is the safest reading of the three
 *    requirements together.
 *  - **`archived_at`** — derived by FR-SUB-005.
 *  - **`duplicated_from_id`** — written by FR-SUB-003 and by nothing else. A client-supplied value
 *    would assert a lineage that never happened.
 *  - **`plan_limits.unit`** — derived from `LIMIT_UNITS[limit_key]` in the service. The unit is a
 *    property of the limit, not a choice: `usageService` measures `storage_limit` in megabytes and
 *    `api_limit` in requests, so a plan row claiming a different unit would make the usage figures and
 *    the allowance incomparable while both looked valid.
 *
 * ## Why `PUT /:id/limits` demands all eight keys
 *
 * `entitlementService.emptyLimits()` seeds every limit at `{ type: fixed, value: 0 }`, so a limit with
 * no `plan_limits` row resolves to **zero**, not to "unconfigured" and not to unlimited. A partial
 * replacement that omitted `teacher_limit` would therefore silently forbid every school on the plan
 * from adding a teacher. SRS §11.2 says *"Each limit may be configured as: Fixed | Unlimited"* — two
 * states, with no third "unset" — so requiring the caller to name all eight is closer to the source
 * than accepting a partial set that resolves the omissions to a number nobody chose.
 *
 * Modules and features are the opposite case and are accepted partially: an absent `plan_modules` row
 * means the module is not in the plan, which is what `hasModule()` already reports and what §11.1's
 * enable/disable per plan means.
 *
 * ## Feature keys are lower-case, even though the source never says so
 *
 * SRS §11 requires plan features to be configurable but never enumerates them, and
 * `plan_features.feature_key` is a free string — `entitlementService.assertValidFeatureKeys()` checks
 * only shape for that reason. One coherence constraint is still real: `ADDON_EFFECTS` unlocks features
 * by name (`custom_domain`, `premium_reports`), and those targets are lower-case snake case. A plan
 * feature keyed `Custom Domain` could never be matched by the add-on that claims to unlock it. The
 * pattern below draws both from the same vocabulary rather than inventing a list of features.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const {
  PLAN_STATUS,
  PLAN_VISIBILITY,
  BILLING_CYCLES,
  BILLING_CYCLE_LIST,
  PRICING_MODELS,
  PRICING_MODEL_LIST,
  MODULE_LIST,
  LIMIT_LIST,
  LIMIT_TYPES,
  RENEWAL_MODES,
} = require('../../config/constants');
const { CODE_PATTERN } = require('../organizations/organizations.validation');

/**
 * The largest value a `money()` column can hold — `DECIMAL(14, 2)` leaves twelve integer digits.
 * Bounded here so an out-of-range amount is a 422 naming the field rather than a driver error.
 */
const MONEY_MAX = 999999999999.99;

/**
 * A non-negative amount for a `DECIMAL(14, 2)` column.
 *
 * `precision(2)` rounds rather than rejects — with `convert: true` a client sending `19.999` gets
 * `20.00`, which is what the column would have stored anyway. Rejecting it would fail a request over a
 * difference the database is about to erase.
 */
const amount = () => Joi.number().min(0).max(MONEY_MAX).precision(2);

/**
 * A free-form JSON map, for the `settings` column.
 *
 * Written with `pattern()` rather than as a bare `Joi.object()` on purpose. `validate.js` runs body
 * schemas with `stripUnknown: true`, which strips every key a schema does not name — and it takes
 * precedence over `.unknown(true)`, so a bare object schema would arrive at the service as `{}` with no
 * error to show why. A pattern makes every key *known*, and `Joi.any()` leaves nested structure
 * untouched.
 */
const jsonObject = () => Joi.object().pattern(Joi.string().max(120), Joi.any()).max(50);

/** SRS §12.1 / §12.2 allow a Custom duration, so any non-negative day count is legal. The ceiling is
 *  an implementation sanity bound — ten years — not a source constraint. */
const dayCount = () => Joi.number().integer().min(0).max(3650);

const fields = {
  name: Joi.string().trim().min(2).max(160),

  code: Joi.string()
    .trim()
    .uppercase()
    .min(2)
    .max(60)
    .pattern(CODE_PATTERN)
    .messages({
      'string.pattern.base':
        '"code" must start with a letter or digit and may contain only letters, digits, hyphens and underscores',
    }),

  description: Joi.string().trim().max(5000).empty('').allow(null),

  /** Filters may name any of the three, including archived plans (FR-SUB-005 keeps them readable). */
  status: Joi.string().valid(...Object.values(PLAN_STATUS)),

  visibility: Joi.string().valid(...Object.values(PLAN_VISIBILITY)),
  is_recommended: Joi.boolean(),
  display_order: Joi.number().integer().min(0).max(100000),

  trial_days: dayCount(),
  grace_period_days: dayCount(),
  default_renewal_mode: Joi.string().valid(...Object.values(RENEWAL_MODES)),

  /** Higher rank = higher tier. Used by §12.3 / §12.4 to classify a plan change. */
  tier_rank: Joi.number().integer().min(0).max(10000),

  /** Lands in `audit_logs.reason`; `subscription_plans` has no column for it and none may be added. */
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

/* ─────────────────────── FR-SUB-001 / FR-SUB-002 — the plan record ─────────────────────── */

const create = Joi.object({
  name: fields.name.required(),
  code: fields.code.required(),
  description: fields.description,
  visibility: fields.visibility,
  is_recommended: fields.is_recommended,
  display_order: fields.display_order,
  trial_days: fields.trial_days,
  grace_period_days: fields.grace_period_days,
  default_renewal_mode: fields.default_renewal_mode,
  tier_rank: fields.tier_rank,
});

const update = Joi.object({
  name: fields.name,
  code: fields.code,
  description: fields.description,
  visibility: fields.visibility,
  is_recommended: fields.is_recommended,
  display_order: fields.display_order,
  trial_days: fields.trial_days,
  grace_period_days: fields.grace_period_days,
  default_renewal_mode: fields.default_renewal_mode,
  tier_rank: fields.tier_rank,
})
  .min(1)
  .messages({ 'object.min': 'Provide at least one field to update' });

/**
 * FR-SUB-003 — Duplicate.
 *
 * `code` is required because it is unique and cannot be copied. `name` is optional: the service falls
 * back to `"<source name> (Copy)"`, which keeps the endpoint usable from a one-click Duplicate button
 * while still allowing a considered name.
 *
 * The copy starts `inactive` for the same reason a new plan does — and here the reason is sharper.
 * FR-SUB-003's outcome is *"a new plan record copying the source plan's configuration"*; if the source
 * was active, an activated copy would appear in the catalogue beside it, unreviewed, the moment the
 * button was pressed. `is_recommended` is not inherited either: a recommendation is a position in the
 * catalogue rather than part of the plan's configuration, and two identical recommended plans is a
 * contradiction the screen cannot resolve. Both can be set explicitly here.
 */
const duplicate = Joi.object({
  code: fields.code.required(),
  name: fields.name,
  description: fields.description,
  visibility: fields.visibility,
  is_recommended: fields.is_recommended,
  display_order: fields.display_order,
  tier_rank: fields.tier_rank,
});

/* ───────────────── FR-SUB-004 / FR-SUB-005 — status transitions ───────────────── */

/* Activate takes nothing. Declared as an empty object rather than omitted so `stripUnknown` removes a
 * stray body instead of the route silently accepting fields it ignores. */
const activate = Joi.object({});
const deactivate = Joi.object({ reason: fields.reason });
const archive = Joi.object({ reason: fields.reason });

/* ─────────────── FR-SUB-006 — pricing and billing cycles (§10.3, §10.4) ─────────────── */

/**
 * One `plan_prices` row.
 *
 * `billing_cycle` and `pricing_model` are both required rather than defaulted, because FR-SUB-006 has
 * the Super Admin *choose* each of them and a defaulted pricing model would decide silently which
 * amount column matters.
 *
 * The three `when` clauses mirror SRS §10.4: a Fixed plan prices `base_amount`, the three unit models
 * price `unit_amount`, and Custom prices `custom_amount`. Without them a row could satisfy the schema
 * while pricing nothing, and FR-SUB-006's outcome — *"a price for each"* — would be reported as met by
 * a row that bills zero.
 */
const priceItem = Joi.object({
  billing_cycle: Joi.string()
    .valid(...BILLING_CYCLE_LIST)
    .required(),

  /* §10.3 "Custom Days" is the only cycle whose length is not implied by its name. */
  cycle_days: Joi.number()
    .integer()
    .min(1)
    .max(3650)
    .allow(null)
    .when('billing_cycle', {
      is: BILLING_CYCLES.CUSTOM_DAYS,
      then: Joi.number().integer().min(1).max(3650).required(),
    })
    .messages({ 'any.required': '"cycle_days" is required when the billing cycle is custom_days' }),

  pricing_model: Joi.string()
    .valid(...PRICING_MODEL_LIST)
    .required(),

  /* ISO 4217. `STRING(10)` in the column leaves room, but a three-letter code is the only thing a
   * money formatter can read, so the schema is the narrower of the two. */
  currency: Joi.string().trim().uppercase().length(3),

  base_amount: amount().when('pricing_model', {
    is: PRICING_MODELS.FIXED,
    then: amount().required(),
  }),

  unit_amount: amount().when('pricing_model', {
    is: Joi.valid(PRICING_MODELS.STUDENT_BASED, PRICING_MODELS.SEAT_BASED, PRICING_MODELS.PER_STUDENT),
    then: amount().required(),
  }),

  included_units: Joi.number().integer().min(0).max(4294967295),

  /* §10.4 Student-Based band, inclusive. A null upper bound is an open-ended top band. */
  tier_min_units: Joi.number().integer().min(0).max(4294967295).allow(null),
  tier_max_units: Joi.number()
    .integer()
    .min(0)
    .max(4294967295)
    .allow(null)
    .when('tier_min_units', {
      is: Joi.number().integer().min(0).required(),
      then: Joi.number().integer().min(Joi.ref('tier_min_units')).max(4294967295).allow(null),
    }),

  overage_unit_amount: amount().allow(null),

  custom_amount: amount()
    .allow(null)
    .when('pricing_model', {
      is: PRICING_MODELS.CUSTOM,
      then: amount().required(),
    }),
  custom_notes: Joi.string().trim().max(255).empty('').allow(null),

  setup_fee: amount(),
  is_active: Joi.boolean(),
  is_default: Joi.boolean(),
  display_order: fields.display_order,
});

/**
 * Two set-level rules `unique()` cannot express.
 *
 * A plan may legitimately carry several rows for one billing cycle — that is how §10.4's Student-Based
 * bands are stored — so the identity of a price is the whole tuple below, not the cycle alone. And
 * `is_default` is *"pre-selected option when subscribing"*, singular: two defaults leave the choice to
 * whichever row the database returns first.
 */
function checkPriceSet(prices, helpers) {
  const seen = new Set();

  for (let index = 0; index < prices.length; index += 1) {
    const price = prices[index];
    const key = [
      price.billing_cycle,
      price.cycle_days ?? '',
      price.pricing_model,
      price.tier_min_units ?? '',
      price.tier_max_units ?? '',
    ].join('|');

    if (seen.has(key)) {
      return helpers.message(
        `prices[${index}] repeats the billing cycle, pricing model and tier band of an earlier entry`
      );
    }
    seen.add(key);
  }

  const defaults = prices.filter((price) => price.is_default === true);
  if (defaults.length > 1) {
    return helpers.message('Only one price may be marked "is_default" for a plan');
  }

  return prices;
}

/**
 * FR-SUB-006 — the complete price set for the plan.
 *
 * A whole-set replacement, on the same reasoning as `PUT /roles/:id/permissions`: a delta needs the
 * client to say what changed, which lets two administrators each apply a change to a set neither was
 * looking at. An empty array is accepted — a plan is created with no prices, so zero is a state the
 * plan can legally be in and an operator has to be able to return to it.
 */
const setPrices = Joi.object({
  prices: Joi.array().items(priceItem).max(100).custom(checkPriceSet).default([]),
});

/* ─────────────────── FR-SUB-007 — modules, features and limits ─────────────────── */

const moduleItem = Joi.object({
  module_key: Joi.string()
    .valid(...MODULE_LIST)
    .required(),
  is_enabled: Joi.boolean(),
  /* Nothing in the entitlement chain reads this — `hasModule()` resolves from `is_enabled` alone. It
   * is stored for the §16 Plan Builder screen, which is what the column's comment describes. */
  settings: jsonObject().allow(null),
});

const setModules = Joi.object({
  modules: Joi.array()
    .items(moduleItem)
    .max(MODULE_LIST.length)
    .unique('module_key')
    .default([]),
});

const featureItem = Joi.object({
  feature_key: Joi.string()
    .trim()
    .lowercase()
    .min(2)
    .max(80)
    .pattern(/^[a-z0-9][a-z0-9_.-]*$/)
    .required()
    .messages({
      'string.pattern.base':
        '"feature_key" must start with a letter or digit and may contain only lower-case letters, digits, underscores, dots and hyphens',
    }),
  name: Joi.string().trim().max(160).empty('').allow(null),
  is_enabled: Joi.boolean(),
  /* §11 features are not all boolean — a retention window is a feature with a value. */
  value: Joi.string().trim().max(120).empty('').allow(null),
  /* Advisory grouping for the plan-builder UI. Not validated against `MODULE_LIST` as a hard rule
   * would be, because a feature may legitimately belong to no module. */
  module_key: Joi.string()
    .valid(...MODULE_LIST)
    .allow(null),
  display_order: fields.display_order,
});

const setFeatures = Joi.object({
  features: Joi.array().items(featureItem).max(200).unique('feature_key').default([]),
});

/**
 * One `plan_limits` row — SRS §11.2.
 *
 * `limit_value` is required for a Fixed limit and refused for an Unlimited one. The model's
 * `fixedNeedsValue` validator enforces the first half; refusing the second half here as well keeps a
 * row from carrying a number that nothing will ever read, which is the kind of stale value an operator
 * later mistakes for the effective ceiling.
 *
 * `overage_unit_amount` is required when `allow_overage` is set, and may be `0`. `usageService`
 * treats a null rate as free, so without this a Super Admin who ticked "allow overage" and left the
 * rate blank would be giving unlimited free excess while the screen showed a Fixed limit. Requiring
 * the field — even at zero — makes that a decision rather than an omission.
 */
const limitItem = Joi.object({
  limit_key: Joi.string()
    .valid(...LIMIT_LIST)
    .required(),

  limit_type: Joi.string()
    .valid(...Object.values(LIMIT_TYPES))
    .required(),

  limit_value: Joi.number()
    .integer()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .allow(null)
    .when('limit_type', {
      is: LIMIT_TYPES.FIXED,
      then: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).required(),
      otherwise: Joi.valid(null),
    })
    .messages({
      'any.required': '"limit_value" is required when the limit type is fixed',
      'any.only': '"limit_value" must be omitted or null when the limit type is unlimited',
    }),

  allow_overage: Joi.boolean(),

  overage_unit_amount: amount()
    .allow(null)
    .when('allow_overage', {
      is: true,
      then: amount().required(),
    })
    .messages({
      'any.required': '"overage_unit_amount" is required when overage is allowed; use 0 for free overage',
    }),
});

/**
 * FR-SUB-007 — the complete limit set for the plan.
 *
 * All eight SRS §11.2 keys, exactly once each. The header explains why a partial set is refused rather
 * than merged: an omitted limit resolves to zero, not to "leave it alone".
 */
const setLimits = Joi.object({
  limits: Joi.array()
    .items(limitItem)
    .length(LIMIT_LIST.length)
    .unique('limit_key')
    .required()
    .custom((limits, helpers) => {
      const given = new Set(limits.map((limit) => limit.limit_key));
      const missing = LIMIT_LIST.filter((key) => !given.has(key));
      if (missing.length) {
        return helpers.message(
          `Every plan limit must be configured. Missing: ${missing.join(', ')} (SRS §11.2).`
        );
      }
      return limits;
    })
    .messages({
      'array.length': `"limits" must contain all ${LIMIT_LIST.length} plan limits (SRS §11.2)`,
    }),
});

/* ───────────────────────────────── Queries ───────────────────────────────── */

const list = listQuery(
  Joi.object({
    status: fields.status,
    visibility: fields.visibility,
    is_recommended: Joi.boolean(),
  })
);

module.exports = {
  schemas: {
    create,
    update,
    duplicate,
    activate,
    deactivate,
    archive,
    setPrices,
    setModules,
    setFeatures,
    setLimits,
    list,
    idParam: commonSchemas.idParam,
  },
  MONEY_MAX,
  amount,
  jsonObject,
};
