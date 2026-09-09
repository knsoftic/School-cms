'use strict';

/**
 * Add-on request schemas — SRS §11.3 (the seven add-ons), FR-SUB-009 (Manage Add-ons).
 *
 * ## The seven add-ons are data, but not all of their columns are the operator's
 *
 * `addons.key` is `unique` and validated `isIn: [ADDON_LIST]`, so the table can hold exactly the seven
 * rows SRS §11.3 names and no others. `src/database/seeders/05-addons.js` writes them, and its `up()`
 * draws a line this module has to respect: on every run it **repairs** `name`, `effect_type` and
 * `effect_target` back to the values derived from `ADDON_EFFECTS`, and deliberately leaves
 * `units_per_quantity`, `unit`, `is_active` and `display_order` alone as *"the Super Admin's to
 * configure through FR-SUB-009"*.
 *
 * So the editable set here is not a matter of taste. A `name` edit accepted by this API would be
 * silently reverted by the next `npm run db:seed`, which is worse than refusing it: the operator would
 * see a 200, the screen would show the new name, and a deployment days later would undo it with no
 * record. The four fields below are therefore explicitly **forbidden** rather than stripped, each with a
 * message naming where the value actually comes from:
 *
 *  - **`key`** — SRS §11.3 fixes the seven, and the column's `isIn` validator enforces it. There is no
 *    create or delete endpoint for the same reason (see `addons.routes.js`).
 *  - **`name`** — SRS §11.3's own wording, repaired by the seeder.
 *  - **`effect_type` / `effect_target`** — `ADDON_EFFECTS`, repaired by the seeder. These two are what
 *    `entitlementService` resolves an add-on through; repointing "Extra Students" at `storage_limit`
 *    would make every future purchase of it grant the wrong allowance.
 *  - **`unit`** — derived in the service from `LIMIT_UNITS[effect_target]`, on the same reasoning that
 *    makes `plan_limits.unit` derived: the unit belongs to the limit being raised, and a row claiming
 *    `count` against a limit `usageService` measures in megabytes would make the allowance and the usage
 *    figure incomparable while both looked valid.
 *  - **`is_active`** — FR-SUB-009's availability switch has its own two endpoints, so that the change
 *    carries a reason and one audit event rather than hiding inside a general edit.
 *
 * `description` **is** editable: the seeder fills it only when blank (`if (!addon.description)`), so an
 * operator's wording survives. Clearing it to null hands the description back to the seeder, which is a
 * defensible way to ask for the generated text again — and `null` is the way to say so. An empty *string*
 * is `empty('')`-stripped, so `PATCH { description: '' }` reaches the object rule with nothing left and is
 * refused by `.min(1)` as an empty edit rather than silently clearing the column.
 *
 * ## `units_per_quantity` is the one number that matters
 *
 * It is the block size — *"50 extra students per purchased quantity"*, in the column's own comment — and
 * the seeder ships it at **1** precisely because the source names no block sizes. FR-SUB-009 makes it
 * configurable, so this is the field the add-ons screen exists to set. The minimum is 1, not 0: a block
 * size of zero would let a school buy a quantity of "Extra Students" and receive nothing, which no
 * screen would explain.
 *
 * ## Prices
 *
 * `addon_prices` is a smaller table than `plan_prices` — one amount per row, no pricing model and no
 * `is_default` column — because §11.3 add-ons are sold by quantity. `billing_cycle` is still the §10.3
 * vocabulary, including `one_time`, which is what an add-on like Custom Domain most naturally is.
 * `plan_id` is nullable and means *"only offered on this plan"*; null is "available on any plan".
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
/* The `DECIMAL(14, 2)` bound and its rounding behaviour are defined once, in the module that first
 * needed them. Duplicating the ceiling here would let the two drift. */
const { amount } = require('../plans/plans.validation');
const { BILLING_CYCLES, BILLING_CYCLE_LIST, ADDON_EFFECTS } = require('../../config/constants');

/**
 * The two effect kinds, read out of `ADDON_EFFECTS` rather than written as literals.
 *
 * `addons.effect_type` is an ENUM over the same two values, so a literal list here would be a third
 * copy of a fact that already exists in the constants and in the column. Deriving it means a filter can
 * never name a kind no add-on can have.
 */
const EFFECT_TYPES = Object.freeze([
  ...new Set(Object.values(ADDON_EFFECTS).map((effect) => effect.type)),
]);

/**
 * A column this module refuses to write, with the reason in the message.
 *
 * Declared in the schema rather than left to `stripUnknown`. A key a schema does not name is stripped
 * silently, so `PATCH { effect_target: 'storage_limit' }` would answer 200 having changed nothing —
 * indistinguishable, from the client's side, from having worked. Naming the key makes it *known*, and
 * `forbidden()` then turns it into a 422 that says where the value comes from.
 *
 * @param {string} because
 * @returns {import('joi').AnySchema}
 */
const forbiddenField = (because) =>
  Joi.any().forbidden().messages({ 'any.unknown': because });

const fields = {
  description: Joi.string().trim().max(5000).empty('').allow(null),

  /* BIGINT column. `MAX_SAFE_INTEGER` is the ceiling above which a JSON number stops being exact. */
  units_per_quantity: Joi.number().integer().min(1).max(Number.MAX_SAFE_INTEGER).messages({
    'number.min': '"units_per_quantity" must be at least 1 — a block size of 0 would grant nothing',
  }),

  display_order: Joi.number().integer().min(0).max(100000),

  /* Lands in `audit_logs.reason`; `addons` has no column for it and none may be added (SRS §35). */
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

/** The four SRS-fixed columns plus the two the service or a dedicated route owns. */
const refused = {
  key: forbiddenField(
    '"key" is fixed by SRS §11.3 — the seven add-ons cannot be renamed, created or removed'
  ),
  name: forbiddenField(
    '"name" is fixed by SRS §11.3 and is repaired by the add-on seeder, so an edit here would not survive the next seed run'
  ),
  effect_type: forbiddenField(
    '"effect_type" comes from ADDON_EFFECTS and is what entitlement resolves through; it cannot be edited'
  ),
  effect_target: forbiddenField(
    '"effect_target" comes from ADDON_EFFECTS and is what entitlement resolves through; it cannot be edited'
  ),
  unit: forbiddenField(
    '"unit" is derived from the limit this add-on raises (LIMIT_UNITS), not chosen'
  ),
  is_active: forbiddenField(
    '"is_active" is set by POST /addons/:id/activate and /deactivate, which record a reason (FR-SUB-009)'
  ),
};

/* ────────────────────────── FR-SUB-009 — edit an add-on ────────────────────────── */

const update = Joi.object({
  description: fields.description,
  units_per_quantity: fields.units_per_quantity,
  display_order: fields.display_order,
  ...refused,
})
  .min(1)
  .messages({ 'object.min': 'Provide at least one field to update' });

/* Activate takes nothing; both are declared so a stray body is stripped rather than ignored silently. */
const activate = Joi.object({});
const deactivate = Joi.object({ reason: fields.reason });

/* ─────────────────── FR-SUB-009 — what an add-on costs (§10.3 cycles) ─────────────────── */

/**
 * One `addon_prices` row.
 *
 * `unit_amount` is required, and may be `0`. A free add-on is a real arrangement — "Premium Reports
 * included in this negotiation" — and the column is `allowNull: false`, so the choice has to be made
 * explicitly rather than by omitting the field.
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
      otherwise: Joi.valid(null),
    })
    .messages({
      'any.required': '"cycle_days" is required when the billing cycle is custom_days',
      'any.only': '"cycle_days" may only be set when the billing cycle is custom_days',
    }),

  /* ISO 4217. `STRING(10)` in the column leaves room, but a three-letter code is the only thing a
   * money formatter can read, so the schema is the narrower of the two. */
  currency: Joi.string().trim().uppercase().length(3),

  unit_amount: amount().required(),

  /** Null = available on any plan. A value restricts the price to that plan (`addon_prices.plan_id`). */
  plan_id: Joi.number().integer().min(1).allow(null),

  is_active: Joi.boolean(),
});

/**
 * The one set-level rule `unique()` cannot express.
 *
 * A price is identified by the cycle it bills on *and* the plan it is restricted to: an add-on may
 * legitimately cost one amount monthly on any plan and another monthly on a bespoke plan. Two rows
 * sharing the whole tuple are ambiguous — the subscribe screen would price from whichever row the
 * database returned first.
 *
 * @param {object[]} prices
 * @param {object} helpers
 * @returns {object[]|any}
 */
function checkPriceSet(prices, helpers) {
  const seen = new Set();

  for (let index = 0; index < prices.length; index += 1) {
    const price = prices[index];
    const key = [price.billing_cycle, price.cycle_days ?? '', price.plan_id ?? ''].join('|');

    if (seen.has(key)) {
      return helpers.message(
        `prices[${index}] repeats the billing cycle and plan restriction of an earlier entry`
      );
    }
    seen.add(key);
  }

  return prices;
}

/**
 * FR-SUB-009 — the complete price set for the add-on.
 *
 * A whole-set replacement, on the same reasoning as `PUT /plans/:id/prices`: a delta needs the client to
 * say what changed, so two administrators on the pricing screen at once would each apply a change to a
 * set neither of them was looking at. An empty array is accepted — the seeded add-ons carry no prices,
 * so zero is a state an add-on can legally be in and an operator has to be able to return to it.
 */
const setPrices = Joi.object({
  prices: Joi.array().items(priceItem).max(100).custom(checkPriceSet).default([]),
});

/* ───────────────────────────────── Queries ───────────────────────────────── */

const list = listQuery(
  Joi.object({
    is_active: Joi.boolean(),
    effect_type: Joi.string().valid(...EFFECT_TYPES),
  })
);

module.exports = {
  schemas: {
    update,
    activate,
    deactivate,
    setPrices,
    list,
    idParam: commonSchemas.idParam,
  },
  EFFECT_TYPES,
  fields,
  refused,
  priceItem,
  checkPriceSet,
};
