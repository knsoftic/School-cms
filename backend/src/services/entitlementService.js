'use strict';

/**
 * Entitlement resolution — SRS §11 (Modules, Features, Limits & Add-ons), §12 (Lifecycle),
 * §30 Rule 1 (No Hard-Coded Subscription Logic).
 *
 * Rule 1, verbatim: "Subscription plans, modules, limits and prices must be database-driven. Plan
 * names must not be hard-coded. Incorrect concept: if plan == premium. Correct concept: Check
 * database feature/limit configuration."
 *
 * This service is the only place that answers "is this school entitled to X?", and it answers it by
 * reading rows. Nothing here compares a plan name, a plan code, or a `tier_rank`. The plan's
 * identity appears in the returned snapshot for display and audit only — no branch reads it.
 *
 * ## The chain, highest precedence first
 *
 *   1. `subscription_overrides`  SRS §33 "Custom Limits" / "Feature Overrides". A per-subscription
 *                               decision that wins over everything, in both directions: it can turn
 *                               a module on that the plan omits, and off that the plan includes.
 *   2. `subscription_addons`     SRS §11.3. Adds units to a limit (`limit_increase`) or turns on a
 *                               feature (`feature_unlock`). Additive — never subtractive.
 *   3. `plan_modules` /          SRS §11.1, §11.2, FR-SUB-007. The base entitlement.
 *      `plan_features` /
 *      `plan_limits`
 *   4. deny                      Anything the chain never mentions is not entitled: a module is off,
 *                               a feature is off, and a limit is Fixed at zero.
 *
 * Step 4 is the important one. A plan that forgets to configure `file_upload_limit` blocks uploads
 * rather than allowing unbounded ones, and a module absent from `plan_modules` is absent from the
 * subscription. Inventing a permissive default would mean guessing a number the SRS never states,
 * and guessing it in the direction that costs the platform money.
 *
 * ## Add-ons are applied after overrides are read but before they are imposed
 *
 * A limit override is a *replacement* of the plan's configured value, not of the add-on units bought
 * on top of it: a school that paid for "Extra Students" keeps those units when the Super Admin sets a
 * custom base limit. So the resolution order inside a limit is
 * `base = override ?? plan` then `total = base + addonUnits`, and `unlimited` short-circuits both.
 *
 * ## Why the snapshot is cached, and what invalidates it
 *
 * Resolving one school reads six tables. Doing that on every module-gated request would put six
 * queries in front of every list endpoint, which SRS §25's response-time targets do not leave room
 * for. The snapshot is cached per school under the `entitlement` namespace with the shared cache TTL.
 *
 * Whatever writes `subscriptions`, `subscription_addons`, `subscription_overrides`, `plan_modules`,
 * `plan_features` or `plan_limits` must call the matching `invalidate…`. This mirrors
 * `tenantService`'s contract, and for the same reason: a plan change or a suspension has to take
 * effect on the next request, not when a TTL lapses.
 *
 * Plan-level writes affect every school on that plan, so `invalidatePlan` exists and is deliberately
 * a whole-namespace flush — the alternative is an index from plan to school that would itself need
 * invalidating.
 *
 * ## Lifecycle state is read, never recomputed
 *
 * `subscription.state` is the authority on whether a subscription is usable (SRS §12 FR-SUB-010:
 * "System transitions state based on billing and administrative events"). This service does not
 * re-derive the state from `current_period_end` or `grace_period_ends_at`, because two components
 * deriving the same state from dates is how they come to disagree. The lifecycle service owns the
 * transitions; this one reads the result.
 */

const { Op } = require('sequelize');

const db = require('../models');
const { cache } = require('../config/cache');
const config = require('../config/env');
const logger = require('../config/logger');
const money = require('../utils/money');
const {
  MODULE_LIST,
  LIMIT_LIST,
  USAGE_LIMIT_KEYS,
  LIMIT_TYPES,
  LIMIT_UNITS,
  SUBSCRIPTION_USABLE_STATES,
  OVERRIDE_TYPES,
} = require('../config/constants');

const CACHE_NAMESPACE = 'entitlement';

/** Where a resolved value came from, for diagnostics and for the §33 admin screens. */
const SOURCES = Object.freeze({
  OVERRIDE: 'override',
  ADDON: 'addon',
  PLAN: 'plan',
  /** Nothing in the chain mentioned it — step 4, deny. */
  DEFAULT: 'default',
});

const MODULE_KEY_SET = new Set(MODULE_LIST);
const LIMIT_KEY_SET = new Set(LIMIT_LIST);
const USAGE_LIMIT_KEY_SET = new Set(USAGE_LIMIT_KEYS);

/**
 * A subscription row reduced to the fields entitlement and billing gating need.
 *
 * @typedef {object} SubscriptionSummary
 * @property {number} id
 * @property {number} planId
 * @property {string} state
 * @property {boolean} isUsable
 * @property {string} billingCycle
 * @property {string|null} currentPeriodStart  ISO — the snapshot survives a JSON round-trip
 * @property {string|null} currentPeriodEnd
 * @property {string|null} startsAt
 * @property {string|null} trialEndsAt
 * @property {string|null} gracePeriodEndsAt
 * @property {string} renewalMode
 */

/**
 * @typedef {object} ResolvedLimit
 * @property {string} key
 * @property {'fixed'|'unlimited'} type
 * @property {number|null} value        total allowance; null when unlimited
 * @property {number|null} baseValue    before add-on units; null when unlimited
 * @property {number} addonUnits
 * @property {string|null} unit
 * @property {boolean} allowOverage
 * @property {number|null} overageUnitAmount
 * @property {string} source
 */

/**
 * @typedef {object} EntitlementSnapshot
 * @property {number} schoolId
 * @property {number|null} organizationId
 * @property {SubscriptionSummary|null} subscription  null when the school has never subscribed
 * @property {{id: number, code: string, name: string, tierRank: number}|null} plan
 * @property {Record<string, boolean>} modules        every SRS §11.1 module key, present either way
 * @property {Record<string, {enabled: boolean, value: string|null, source: string}>} features
 * @property {Record<string, ResolvedLimit>} limits   every key in USAGE_LIMIT_KEYS
 * @property {string} resolvedAt
 */

function schoolKey(schoolId) {
  return cache.key(CACHE_NAMESPACE, 'school', schoolId);
}

/** Dates survive the cache's JSON round-trip as ISO strings; normalise on the way in. */
function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * BIGINT arrives from mysql2 as a string. Anything that reaches arithmetic goes through here, so a
 * limit of "500" cannot become the string concatenation "5001".
 */
function toCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** DECIMAL also arrives as a string. */
function toAmount(value) {
  return value === null || value === undefined ? null : money.toNumber(value);
}

/**
 * SQL fragment for "this row's effective window contains now".
 *
 * A null bound is open-ended in that direction. The upper bound is exclusive so a row that ends at
 * the instant of the request has already ended.
 */
function activeWindow(fromColumn, untilColumn, at) {
  return {
    [Op.and]: [
      { [Op.or]: [{ [fromColumn]: null }, { [fromColumn]: { [Op.lte]: at } }] },
      { [Op.or]: [{ [untilColumn]: null }, { [untilColumn]: { [Op.gt]: at } }] },
    ],
  };
}

/**
 * Pick the subscription that governs a school.
 *
 * A school accumulates subscription rows over its life — cancelled, expired, then a new one — so
 * "the subscription" has to be chosen rather than assumed. A usable one wins; failing that the most
 * recent row of any state is returned so the refusal can name the real state ("expired", "suspended")
 * instead of a generic "not subscribed". Only when there is no row at all is the answer null.
 *
 * @param {number} schoolId
 * @returns {Promise<object|null>} a raw subscription row
 */
async function findGoverningSubscription(schoolId) {
  const attributes = [
    'id',
    'school_id',
    'organization_id',
    'plan_id',
    'state',
    'billing_cycle',
    'cycle_days',
    'starts_at',
    'current_period_start',
    'current_period_end',
    'trial_ends_at',
    'grace_period_ends_at',
    'renewal_mode',
  ];
  const order = [
    ['created_at', 'DESC'],
    ['id', 'DESC'],
  ];

  const usable = await db.Subscription.findOne({
    where: { school_id: schoolId, state: { [Op.in]: SUBSCRIPTION_USABLE_STATES } },
    attributes,
    order,
    raw: true,
  });
  if (usable) return usable;

  /* Second query only in the uncommon case, and the result is cached either way. */
  return db.Subscription.findOne({
    where: { school_id: schoolId },
    attributes,
    order,
    raw: true,
  });
}

/** Every limit key starts denied, so a key the chain never mentions is answered rather than absent. */
function emptyLimits() {
  /** @type {Record<string, ResolvedLimit>} */
  const limits = {};
  for (const key of USAGE_LIMIT_KEYS) {
    limits[key] = {
      key,
      type: LIMIT_TYPES.FIXED,
      value: 0,
      baseValue: 0,
      addonUnits: 0,
      unit: LIMIT_UNITS[key] || null,
      allowOverage: false,
      overageUnitAmount: null,
      source: SOURCES.DEFAULT,
    };
  }
  return limits;
}

function emptyModules() {
  /** @type {Record<string, boolean>} */
  const modules = {};
  for (const key of MODULE_LIST) modules[key] = false;
  return modules;
}

/**
 * The snapshot for a school with no subscription row at all.
 *
 * Everything is denied. A school exists before it is subscribed (FR-SADMIN-002 creates it, the
 * subscription comes after), and until then it is entitled to nothing that requires a plan. Core
 * routes — login, profile, school settings — carry no `requireModule`, so they stay reachable.
 */
function unsubscribedSnapshot(schoolId, organizationId) {
  return {
    schoolId,
    organizationId: organizationId === undefined ? null : organizationId,
    subscription: null,
    plan: null,
    modules: emptyModules(),
    features: {},
    limits: emptyLimits(),
    resolvedAt: new Date().toISOString(),
  };
}

/**
 * Resolve a school's entitlement from the database, ignoring the cache.
 *
 * @param {number} schoolId
 * @returns {Promise<EntitlementSnapshot>}
 */
async function resolve(schoolId) {
  const id = Number(schoolId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`entitlementService.resolve() requires a school id; received ${schoolId}`);
  }

  const subscription = await findGoverningSubscription(id);
  if (!subscription) return unsubscribedSnapshot(id, null);

  const at = new Date();

  const [plan, planModules, planFeatures, planLimits, addons, overrides] = await Promise.all([
    db.SubscriptionPlan.findByPk(subscription.plan_id, {
      attributes: ['id', 'code', 'name', 'tier_rank'],
      raw: true,
    }),
    db.PlanModule.findAll({
      where: { plan_id: subscription.plan_id },
      attributes: ['module_key', 'is_enabled'],
      raw: true,
    }),
    db.PlanFeature.findAll({
      where: { plan_id: subscription.plan_id },
      attributes: ['feature_key', 'is_enabled', 'value'],
      raw: true,
    }),
    db.PlanLimit.findAll({
      where: { plan_id: subscription.plan_id },
      attributes: [
        'limit_key',
        'limit_type',
        'limit_value',
        'unit',
        'allow_overage',
        'overage_unit_amount',
      ],
      raw: true,
    }),
    db.SubscriptionAddon.findAll({
      where: {
        subscription_id: subscription.id,
        status: 'active',
        ...activeWindow('starts_at', 'ends_at', at),
      },
      attributes: ['effect_type', 'effect_target', 'units_granted', 'quantity'],
      raw: true,
    }),
    db.SubscriptionOverride.findAll({
      where: {
        subscription_id: subscription.id,
        is_active: true,
        ...activeWindow('effective_from', 'effective_until', at),
      },
      attributes: ['override_type', 'target_key', 'is_enabled', 'limit_type', 'limit_value'],
      raw: true,
    }),
  ]);

  if (!plan) {
    /*
     * `subscriptions.plan_id` is ON DELETE RESTRICT, so this cannot happen through the ORM. If it
     * ever does — a manual delete, a restored partial backup — denying is the only safe answer, and
     * the log line is what makes the cause findable.
     */
    logger.error('Subscription references a missing plan; denying all entitlement', {
      schoolId: id,
      subscriptionId: subscription.id,
      planId: subscription.plan_id,
    });
    return unsubscribedSnapshot(id, toCount(subscription.organization_id));
  }

  /* ---- Step 3: the plan ------------------------------------------------------------------- */

  const modules = emptyModules();
  for (const row of planModules) {
    if (!MODULE_KEY_SET.has(row.module_key)) {
      /* The column validates against MODULE_LIST, so a stray key means the row predates a change. */
      logger.warn('plan_modules row names an unknown module key; ignoring', {
        planId: plan.id,
        moduleKey: row.module_key,
      });
      continue;
    }
    modules[row.module_key] = Boolean(row.is_enabled);
  }

  /** @type {Record<string, {enabled: boolean, value: string|null, source: string}>} */
  const features = {};
  for (const row of planFeatures) {
    features[row.feature_key] = {
      enabled: Boolean(row.is_enabled),
      value: row.value === undefined ? null : row.value,
      source: SOURCES.PLAN,
    };
  }

  const limits = emptyLimits();
  for (const row of planLimits) {
    if (!LIMIT_KEY_SET.has(row.limit_key)) {
      logger.warn('plan_limits row names an unknown limit key; ignoring', {
        planId: plan.id,
        limitKey: row.limit_key,
      });
      continue;
    }
    const unlimited = row.limit_type === LIMIT_TYPES.UNLIMITED;
    const baseValue = unlimited ? null : toCount(row.limit_value) || 0;
    limits[row.limit_key] = {
      key: row.limit_key,
      type: unlimited ? LIMIT_TYPES.UNLIMITED : LIMIT_TYPES.FIXED,
      value: baseValue,
      baseValue,
      addonUnits: 0,
      unit: row.unit || LIMIT_UNITS[row.limit_key] || null,
      allowOverage: Boolean(row.allow_overage),
      overageUnitAmount: toAmount(row.overage_unit_amount),
      source: SOURCES.PLAN,
    };
  }

  /* ---- Step 2: add-ons (additive only) ---------------------------------------------------- */

  for (const row of addons) {
    if (row.effect_type === 'feature_unlock') {
      const existing = features[row.effect_target];
      /*
       * A purchased unlock turns a feature on. It does not turn one off, so an add-on cannot undo a
       * plan feature — hence the one-way assignment.
       */
      features[row.effect_target] = {
        enabled: true,
        value: existing ? existing.value : null,
        source: SOURCES.ADDON,
      };
      continue;
    }

    /* effect_type === 'limit_increase' */
    if (!USAGE_LIMIT_KEY_SET.has(row.effect_target)) {
      logger.warn('subscription_addons row targets an unknown limit key; ignoring', {
        subscriptionId: subscription.id,
        effectTarget: row.effect_target,
      });
      continue;
    }

    /*
     * `units_granted` is the resolved grant copied at purchase time (see the model comment: a later
     * add-on edit must not change what was bought). `quantity × units_per_quantity` is what produced
     * it, and is not multiplied again here.
     */
    const granted = toCount(row.units_granted) || 0;
    if (granted <= 0) continue;

    const limit = limits[row.effect_target];
    limit.addonUnits += granted;
    if (limit.type === LIMIT_TYPES.FIXED) {
      limit.value = (limit.baseValue || 0) + limit.addonUnits;
      if (limit.source === SOURCES.DEFAULT) limit.source = SOURCES.ADDON;
    }
    /* An unlimited limit stays unlimited; the units are recorded but change nothing. */
  }

  /* ---- Step 1: overrides (win over both) -------------------------------------------------- */

  for (const row of overrides) {
    const target = row.target_key;

    if (row.override_type === OVERRIDE_TYPES.MODULE) {
      if (!MODULE_KEY_SET.has(target)) {
        logger.warn('subscription_overrides row names an unknown module key; ignoring', {
          subscriptionId: subscription.id,
          targetKey: target,
        });
        continue;
      }
      /* Null `is_enabled` on a module override says nothing; leave the plan's answer alone. */
      if (row.is_enabled === null || row.is_enabled === undefined) continue;
      modules[target] = Boolean(row.is_enabled);
      continue;
    }

    if (row.override_type === OVERRIDE_TYPES.FEATURE) {
      if (row.is_enabled === null || row.is_enabled === undefined) continue;
      const existing = features[target];
      features[target] = {
        enabled: Boolean(row.is_enabled),
        value: existing ? existing.value : null,
        source: SOURCES.OVERRIDE,
      };
      continue;
    }

    if (row.override_type === OVERRIDE_TYPES.LIMIT) {
      if (!USAGE_LIMIT_KEY_SET.has(target)) {
        logger.warn('subscription_overrides row names an unknown limit key; ignoring', {
          subscriptionId: subscription.id,
          targetKey: target,
        });
        continue;
      }
      if (!row.limit_type) continue;

      const limit = limits[target];
      if (row.limit_type === LIMIT_TYPES.UNLIMITED) {
        limit.type = LIMIT_TYPES.UNLIMITED;
        limit.value = null;
        limit.baseValue = null;
      } else {
        const baseValue = toCount(row.limit_value) || 0;
        limit.type = LIMIT_TYPES.FIXED;
        limit.baseValue = baseValue;
        /* Add-on units bought on top of the plan survive a custom base — see the header. */
        limit.value = baseValue + limit.addonUnits;
      }
      limit.source = SOURCES.OVERRIDE;
      continue;
    }

    /*
     * OVERRIDE_TYPES.PRICE is SRS §33 "Custom Pricing". Skipped deliberately, because it is not an
     * entitlement — it would change what the school is CHARGED rather than what it may do.
     *
     * This comment used to add "so it belongs to invoice generation", naming a consumer that does
     * not exist: `grep -rn "SubscriptionOverride" backend/src/modules/invoices/` returns nothing,
     * and `cycle_amount` is only ever `computeCycleAmount(price, quantity)`. A `price` override is
     * accepted with 201, stored, echoed back on the subscription detail, and read by NOTHING. That
     * is finding 39 and it is blocked on §33/§10.4 rather than on this line — but the forward
     * reference made an inert row look like a deferral with a known destination.
     */
  }

  return {
    schoolId: id,
    organizationId: toCount(subscription.organization_id),
    subscription: {
      id: toCount(subscription.id),
      planId: toCount(subscription.plan_id),
      state: subscription.state,
      isUsable: SUBSCRIPTION_USABLE_STATES.includes(subscription.state),
      billingCycle: subscription.billing_cycle,
      cycleDays: toCount(subscription.cycle_days),
      startsAt: isoOrNull(subscription.starts_at),
      currentPeriodStart: isoOrNull(subscription.current_period_start),
      currentPeriodEnd: isoOrNull(subscription.current_period_end),
      trialEndsAt: isoOrNull(subscription.trial_ends_at),
      gracePeriodEndsAt: isoOrNull(subscription.grace_period_ends_at),
      renewalMode: subscription.renewal_mode,
    },
    plan: {
      id: toCount(plan.id),
      code: plan.code,
      name: plan.name,
      tierRank: toCount(plan.tier_rank),
    },
    modules,
    features,
    limits,
    resolvedAt: new Date().toISOString(),
  };
}

/**
 * A school's entitlement snapshot, cached.
 *
 * @param {number} schoolId
 * @returns {Promise<EntitlementSnapshot>}
 */
async function getSnapshot(schoolId) {
  const id = Number(schoolId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`entitlementService.getSnapshot() requires a school id; received ${schoolId}`);
  }

  return cache.remember(schoolKey(id), config.cache.ttlSeconds, () => resolve(id));
}

/** Is the school's subscription in a state that permits use of its modules? SRS §12. */
async function isSubscriptionUsable(schoolId) {
  const snapshot = await getSnapshot(schoolId);
  return Boolean(snapshot.subscription && snapshot.subscription.isUsable);
}

/**
 * Is a module included in the school's subscription?
 *
 * Entitlement only — the subscription's *state* is a separate question, asked separately, so a
 * refusal can distinguish "your plan does not include this" (403) from "your subscription has
 * lapsed" (402). Conflating them produces a message that sends the school to the wrong screen.
 *
 * @param {number} schoolId
 * @param {string} moduleKey
 * @returns {Promise<boolean>}
 */
async function hasModule(schoolId, moduleKey) {
  const snapshot = await getSnapshot(schoolId);
  return snapshot.modules[moduleKey] === true;
}

/**
 * Is a feature enabled for the school?
 *
 * @param {number} schoolId
 * @param {string} featureKey
 * @returns {Promise<boolean>}
 */
async function hasFeature(schoolId, featureKey) {
  const snapshot = await getSnapshot(schoolId);
  const feature = snapshot.features[featureKey];
  return Boolean(feature && feature.enabled);
}

/**
 * The resolved value of a feature, for features that carry one (`plan_features.value`).
 *
 * @returns {Promise<string|null>} null when the feature is absent or disabled
 */
async function getFeatureValue(schoolId, featureKey) {
  const snapshot = await getSnapshot(schoolId);
  const feature = snapshot.features[featureKey];
  return feature && feature.enabled ? feature.value : null;
}

/**
 * A school's resolved allowance for one limit.
 *
 * @param {number} schoolId
 * @param {string} limitKey
 * @returns {Promise<ResolvedLimit>}
 */
async function getLimit(schoolId, limitKey) {
  assertKnownLimitKeys([limitKey], 'entitlementService.getLimit');
  const snapshot = await getSnapshot(schoolId);
  return snapshot.limits[limitKey];
}

/* ─────────────────────────────── Key validation ─────────────────────────────── */

/**
 * Assert that module keys named in code exist.
 *
 * Called at route-definition time by `requireModule`, on the same reasoning as
 * `permissionService.assertKnownPermissionKeys`: a mistyped key would deny every caller forever and
 * look like a subscription-data problem. SRS §11.1 fixes the list of twenty, so a typo is always a
 * typo and never a new module.
 *
 * @param {string[]} keys
 * @param {string} caller
 */
function assertKnownModuleKeys(keys, caller) {
  const unknown = keys.filter((key) => !MODULE_KEY_SET.has(key));
  if (unknown.length) {
    throw new Error(
      `${caller}: unknown module key(s) ${unknown.join(', ')}. ` +
        `Valid module keys are ${MODULE_LIST.join(', ')} (SRS §11.1).`
    );
  }
}

/**
 * Assert that limit keys named in code exist.
 *
 * Accepts the eight SRS §11.2 plan limits plus the add-on-only allowances, because a limit *check*
 * legitimately targets `sms_limit` even though no plan row can configure it.
 *
 * @param {string[]} keys
 * @param {string} caller
 */
function assertKnownLimitKeys(keys, caller) {
  const unknown = keys.filter((key) => !USAGE_LIMIT_KEY_SET.has(key));
  if (unknown.length) {
    throw new Error(
      `${caller}: unknown limit key(s) ${unknown.join(', ')}. ` +
        `Valid limit keys are ${USAGE_LIMIT_KEYS.join(', ')} (SRS §11.2 plus add-on-only allowances).`
    );
  }
}

/**
 * Assert that a feature key is well formed.
 *
 * Features get a weaker check than modules and limits, on purpose. SRS §11 requires plan features to
 * be configurable but — unlike the twenty modules and eight limits — never enumerates them, and
 * `plan_features.feature_key` is a free string a Super Admin fills in. There is therefore no
 * authoritative list to validate against, and inventing one would either reject legitimate keys or
 * pretend to a completeness it does not have. Shape is all that can honestly be checked here.
 *
 * @param {string[]} keys
 * @param {string} caller
 */
function assertValidFeatureKeys(keys, caller) {
  const invalid = keys.filter(
    (key) => typeof key !== 'string' || !key.trim() || key.length > 80
  );
  if (invalid.length) {
    throw new Error(
      `${caller}: invalid feature key(s) ${JSON.stringify(invalid)}. ` +
        'A feature key must be a non-empty string of at most 80 characters ' +
        '(plan_features.feature_key).'
    );
  }
}

/* ─────────────────────────────── Invalidation ─────────────────────────────── */

/**
 * Drop one school's cached snapshot.
 *
 * Must be called by anything that writes `subscriptions`, `subscription_addons` or
 * `subscription_overrides` for that school. A suspension or a purchased add-on has to be visible on
 * the next request.
 */
async function invalidateSchool(schoolId) {
  await cache.del(schoolKey(schoolId));
}

/**
 * Drop every snapshot resolved from a plan.
 *
 * A plan edit (FR-SUB-002, FR-SUB-007) changes entitlement for every school subscribed to it. The
 * mapping from plan to schools is not cached, so this flushes the namespace rather than maintaining
 * a reverse index that would itself need invalidating. Plan edits are rare; module-gated requests
 * are not, which is the right way round for this trade-off.
 *
 * @param {number} [planId] recorded in the log line; the flush is namespace-wide either way
 */
async function invalidatePlan(planId) {
  logger.info('Flushing entitlement cache after a plan change', { planId: planId || null });
  await cache.invalidate(CACHE_NAMESPACE);
}

/** Drop every cached snapshot — for a re-seed or a restored backup. */
async function invalidateAll() {
  await cache.invalidate(CACHE_NAMESPACE);
}

module.exports = {
  resolve,
  getSnapshot,
  isSubscriptionUsable,
  hasModule,
  hasFeature,
  getFeatureValue,
  getLimit,
  assertKnownModuleKeys,
  assertKnownLimitKeys,
  assertValidFeatureKeys,
  invalidateSchool,
  invalidatePlan,
  invalidateAll,
  SOURCES,
  CACHE_NAMESPACE,
};
