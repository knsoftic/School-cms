'use strict';

/**
 * Subscription lifecycle — SRS §12; FR-SUB-010 … FR-SUB-015. Also §11.3 add-on purchase and §33
 * Feature Overrides / Custom Limits / Custom Pricing.
 *
 * This is the module that makes the plan catalogue sellable. `/plans` and `/addons` build the
 * offer; nothing before this file could put a school on one.
 *
 * ## Four obligations this module carries and no other file can
 *
 *  1. **`entitlementService.invalidateSchool()` after every write.** This module writes
 *     `subscriptions`, `subscription_addons` and `subscription_overrides` — the three tables
 *     `entitlementService.resolve()` reads. `addons/` deliberately invalidates nothing, because
 *     resolution never joins `addons`; that same fact makes invalidation mandatory here. A missed
 *     call leaves a suspended school fully entitled until a TTL lapses.
 *
 *  2. **`schools.subscription_state` is this module's column.** `models/core.js` describes it as
 *     *"Cached from the school's active subscription so dashboards avoid a join"* and
 *     `schools.validation.js` refuses it from clients because *"a client-supplied value would be a
 *     lie the dashboards then read"*. Every state change here writes it, through
 *     `syncSchoolState()`.
 *
 *  3. **`tenantService.invalidateSchool()` whenever that column changes.**
 *     `tenantService.getSchool()` caches `['id','organization_id','status','subscription_state']`,
 *     so writing the column without dropping that entry leaves the cached copy disagreeing with the
 *     row. Two caches, two invalidation calls, both in `afterWrite()`.
 *
 *  4. **The add-on purchase copy.** `subscription_addons` stores `effect_type`, `effect_target` and
 *     `units_granted` as they were *at purchase*, so a later catalogue edit cannot change what a
 *     school bought. `entitlementService.js` is explicit that `units_granted` is already
 *     `quantity × units_per_quantity` and *"is not multiplied again here"* — so the multiplication
 *     happens in `purchaseAddon()` and nowhere else. A null there resolves to `0`, and a zero grant
 *     is skipped entirely: the add-on would appear purchased and grant nothing.
 *
 * ## Lifecycle state is written here and read everywhere else
 *
 * `entitlementService`'s header states the division: *"Lifecycle state is read, never recomputed …
 * The lifecycle service owns the transitions; this one reads the result."* So no other file derives
 * a state from `current_period_end` or `grace_period_ends_at`, and this file is the only one that
 * may. That is why the date-driven transitions live in `runLifecycleSweep()` rather than being
 * inferred at read time by whoever needs them.
 *
 * ## `runLifecycleSweep()` has no route, on purpose
 *
 * FR-SUB-010's actor is *"System / Super Admin"* and FR-SUB-015's Automatic Renewal is
 * *"initiated by the system at cycle end"* — a scheduler, not a request. `package.json` already
 * declares `"cron": "node src/jobs/cron.js"` and `src/jobs/` does not exist yet, so the trigger is
 * genuinely Phase 5 work. What is *not* deferred is the behaviour: the sweep is a plain exported
 * function, fully implemented, and `scripts/verify-subscriptions.js` calls it directly. Adding a
 * `POST /subscriptions/run-renewals` endpoint to make it reachable today would be inventing a
 * requirement, which SRS §35 forbids.
 *
 * ## The state machine, and where each edge comes from
 *
 * Six transitions are operator actions and each has a matching `SUBSCRIPTION_EVENTS` entry, which
 * is the schema's own evidence for which edges were anticipated: `activated`, `suspended`,
 * `reactivated`, `paused`, `resumed`, `cancelled`. The remaining events — `trial_ended`,
 * `past_due`, `grace_period_started`, `expired`, `renewed` — are the sweep's, and they are exactly
 * the ones FR-SUB-010 calls *"billing"* events as opposed to *"administrative"* ones. The
 * constant divides cleanly along the sentence, so that is the division used.
 *
 * Two edges are interpretation rather than quotation, and are marked as such where they are
 * implemented: what happens when a trial ends without payment (§12 has no Payments yet — §13 is
 * Phase 3.H), and what "Paused" means that "Suspended" does not.
 *
 * ## What is deliberately absent
 *
 *  - **No `DELETE /:id`.** A subscription is the school's billing history. `Cancelled` and
 *    `Expired` are the source's terminal states, `subscription_items` and (from §13) `invoices`
 *    point at the row, and §12 names no removal operation.
 *  - **No payment.** Activation is an administrative act here because §13 does not exist yet. When
 *    it does, the payment approval path calls `transition(…, 'activate', …)` — the transition table
 *    is the seam, which is why it is data rather than six functions.
 *  - **No second usable subscription per school.** `entitlementService.findGoverningSubscription()`
 *    picks *one*: a usable row if there is one, else the most recent. Letting a school hold two
 *    open subscriptions would make entitlement depend on insert order, so `create()` refuses it.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const entitlementService = require('../../services/entitlementService');
const tenantService = require('../../services/tenantService');
/* For the prorated invoice an immediate plan change owes — see `changePlan()`. No require cycle: invoices reads subscriptions through the models only. */
const invoicesService = require('../invoices/invoices.service');
const money = require('../../utils/money');
const dates = require('../../utils/dates');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { tenantWhere } = require('../../models');
const {
  SUBSCRIPTION_STATES: STATES,
  SUBSCRIPTION_STATE_LIST,
  SUBSCRIPTION_USABLE_STATES,
  SUBSCRIPTION_EVENTS: EVENTS,
  TRIAL_DURATION_DAYS,
  GRACE_PERIOD_DAYS,
  DOWNGRADE_TIMING,
  RENEWAL_MODES,
  OVERRIDE_TYPES,
  BILLING_CYCLES,
  PRICING_MODELS,
  PLAN_STATUS,
  LIMIT_TYPES,
  LIMIT_UNITS,
  LIMIT_LABELS,
  USAGE_LIMIT_KEYS,
  PRICE_OVERRIDE_TARGETS,
} = require('../../config/constants');

const SORTABLE = Object.freeze([
  'id',
  'state',
  'starts_at',
  'current_period_end',
  'next_renewal_at',
  'cycle_amount',
  'created_at',
  'updated_at',
]);

const DEFAULT_SORT = Object.freeze(['created_at', 'DESC']);

/**
 * States in which a school still holds a subscription, whether or not it may use it.
 *
 * The usable five plus the three that are live-but-not-usable. `Expired` and `Cancelled` are the
 * two terminal states in §12, so they are the complement: a school in either may be subscribed
 * again, and a school in any of these eight may not. Derived from the two source constants rather
 * than written out, so a change to `SUBSCRIPTION_USABLE_STATES` cannot leave this list behind.
 */
const OPEN_STATES = Object.freeze([
  ...SUBSCRIPTION_USABLE_STATES,
  STATES.PENDING,
  STATES.PAUSED,
  STATES.SUSPENDED,
]);

/**
 * How many days before `current_period_end` a subscription is reported as `Expiring`.
 *
 * SRS §12 names the state and FR-SUB-015's precondition is *"approaching or at the end of its
 * billing cycle"*, but neither fixes the window — so this is an implementation default in the same
 * sense as `plans.validation.dayCount()`'s ten-year ceiling, not a business rule, and
 * `runLifecycleSweep()` takes it as a parameter. `Expiring` is one of
 * `SUBSCRIPTION_USABLE_STATES`, so entering it changes nothing about what the school may do; it is
 * a signal for the renewal notice and nothing more.
 */
const EXPIRING_WINDOW_DAYS = 7;

/* ─────────────────────────────── reads ─────────────────────────────── */

/**
 * The associations a subscription is read with.
 *
 * `separate: true` on the three `hasMany` includes, for the reason `pagination.paginateQuery()`
 * forces `distinct`: a joined `hasMany` multiplies the parent row, and `list()` would then have to
 * de-duplicate a page it had already counted. Separate queries also let each collection carry its
 * own `order` and its own nested includes.
 *
 * `overrides` is **not** filtered to the ones in force. A screen that offers "revoke" has to be able
 * to show what was already revoked, and `isEffective()` marks which are live — so the caller reads
 * the same window `entitlementService.activeWindow()` applies rather than deriving a second one.
 *
 * `history` is deliberately absent: a long-lived subscription accumulates a row per renewal, so it
 * has its own paginated route rather than being truncated to an arbitrary N inside every read.
 *
 * @returns {object[]}
 */
function detailInclude() {
  return [
    { model: db.SubscriptionPlan, as: 'plan' },
    { model: db.PlanPrice, as: 'planPrice' },
    { model: db.SubscriptionPlan, as: 'scheduledPlan' },
    { model: db.PlanPrice, as: 'scheduledPlanPrice' },
    { model: db.SubscriptionItem, as: 'items', separate: true, order: [['id', 'ASC']] },
    {
      model: db.SubscriptionAddon,
      as: 'addons',
      separate: true,
      order: [['id', 'ASC']],
      include: [
        { model: db.Addon, as: 'addon' },
        { model: db.AddonPrice, as: 'addonPrice' },
      ],
    },
    {
      model: db.SubscriptionOverride,
      as: 'overrides',
      separate: true,
      order: [
        ['override_type', 'ASC'],
        ['target_key', 'ASC'],
      ],
    },
  ];
}

/**
 * One page of subscriptions, confined to the caller's tenant.
 *
 * `tenantWhere()` does the confinement rather than a hand-written `scopeFor()`, because unlike
 * `subscription_plans` this table *has* both tenant columns: a subscription belongs to exactly one
 * school. That makes it the ordinary case the innermost isolation layer was written for — school
 * scope wins over organization scope, and a platform caller reads across tenants.
 *
 * @param {object} tenant
 * @param {object} query   validated `req.query`
 * @param {{page: number, limit: number, offset: number}} pagination
 * @param {import('express').Request} req
 * @returns {Promise<{rows: object[], count: number}>}
 */
async function list(tenant, query, pagination, req) {
  const where = tenantWhere(tenant, {});

  /*
   * Filters, not scopes. `enforceTenant` has already refused a `school_id` outside the caller's
   * scope, so by the time this runs the only thing left to do is narrow.
   */
  if (query.school_id) where.school_id = query.school_id;
  if (query.plan_id) where.plan_id = query.plan_id;
  if (query.state) where.state = query.state;
  if (query.renewal_mode) where.renewal_mode = query.renewal_mode;

  if (query.expiring_within_days !== undefined) {
    where.current_period_end = {
      [Op.ne]: null,
      [Op.lte]: dates.addDays(new Date(), query.expiring_within_days),
    };
  }

  return paginateQuery(
    db.Subscription,
    {
      where,
      order: getSort(req, SORTABLE, DEFAULT_SORT),
      include: detailInclude(),
    },
    pagination
  );
}

/**
 * One subscription, or a 404.
 *
 * The tenant scope is folded into the `where`, so a school asking for another school's
 * subscription is told "not found" rather than being handed a row it may not see — the same
 * treatment `plans.service.findById()` gives a private plan.
 *
 * @param {object} tenant
 * @param {number|string} id
 * @param {{detail?: boolean, transaction?: object, lock?: boolean}} [options]
 * @returns {Promise<object>}
 */
async function findById(tenant, id, options = {}) {
  const subscription = await db.Subscription.findOne({
    where: tenantWhere(tenant, { id }),
    include: options.detail === false ? undefined : detailInclude(),
    transaction: options.transaction,
  });
  if (!subscription) {
    throw ApiError.notFound('Subscription not found', { code: 'SUBSCRIPTION_NOT_FOUND' });
  }
  return subscription;
}

/**
 * FR-SUB-010's audit trail — one page of `subscription_history`.
 *
 * `subscription_history` is an SRS §29 table this module writes on every transition. Without a read
 * route it would be write-only, which is not a table anyone can be asked to trust. The scope comes
 * from the parent subscription, so the history of a subscription the caller cannot see 404s before
 * any history row is read.
 *
 * @param {object} tenant
 * @param {number|string} id
 * @param {object} query
 * @param {object} pagination
 * @param {import('express').Request} req
 * @returns {Promise<{rows: object[], count: number}>}
 */
async function history(tenant, id, query, pagination, req) {
  const subscription = await findById(tenant, id, { detail: false });

  const where = { subscription_id: subscription.id };
  if (query.event) where.event = query.event;

  return paginateQuery(
    db.SubscriptionHistory,
    {
      where,
      order: getSort(req, ['id', 'event', 'effective_at', 'created_at'], ['id', 'DESC']),
      include: [
        { model: db.SubscriptionPlan, as: 'fromPlan' },
        { model: db.SubscriptionPlan, as: 'toPlan' },
      ],
    },
    pagination
  );
}

/**
 * The vocabulary the subscription screens choose from — SRS §12.
 *
 * Served rather than duplicated in the frontend, for the reason `plans.service.catalogue()` gives.
 * The state list and the transition table are the parts that matter: a screen that hard-coded the
 * ten states, or which of them each action is legal from, would drift from the machine that
 * actually refuses the call.
 *
 * @returns {object}
 */
function catalogue() {
  return {
    states: SUBSCRIPTION_STATE_LIST.slice(),
    usableStates: SUBSCRIPTION_USABLE_STATES.slice(),
    openStates: OPEN_STATES.slice(),
    events: Object.values(EVENTS),
    /* SRS §12.1 / §12.2 presets. Any other non-negative day count is the source's "Custom". */
    trialPresetDays: TRIAL_DURATION_DAYS.slice(),
    gracePresetDays: GRACE_PERIOD_DAYS.slice(),
    downgradeTimings: Object.values(DOWNGRADE_TIMING),
    renewalModes: Object.values(RENEWAL_MODES),
    overrideTypes: Object.values(OVERRIDE_TYPES),

    /*
     * What each override type may *target*, because `createOverride`'s schema restricts three of the
     * four and no endpoint published the lists it restricts them to.
     *
     * The limit list is the reason this exists: it is `USAGE_LIMIT_KEYS`, the eight §11.2 plan limits
     * **plus** the add-on-only `sms_limit`, and `GET /plans/catalogue` publishes only the eight —
     * `plan_limits.limit_key` is restricted to those. A screen that reused the plan catalogue here
     * would silently be unable to write the one override an SMS negotiation needs.
     *
     * `module` is absent deliberately: its targets are §11.1's twenty keys, which the frontend
     * already holds as a copy `verify-frontend.js` asserts against `MODULE_LABELS` in both
     * directions. Publishing them a second way would be a third copy to keep in step.
     *
     * `feature` is absent because it has no list. `plan_features` carries its own `name` and
     * `module_key` per row — a feature is self-describing and there is no fixed vocabulary anywhere
     * in §11 or §29 to offer. The schema does not restrict it either, and those two facts are the
     * same fact.
     */
    limitTargets: USAGE_LIMIT_KEYS.map((key) => ({
      key,
      label: LIMIT_LABELS[key] || key,
      unit: LIMIT_UNITS[key] || null,
    })),
    limitTypes: Object.values(LIMIT_TYPES),
    priceTargets: PRICE_OVERRIDE_TARGETS.slice(),
    /* What each operator action is legal from, so the screen can disable rather than guess. */
    transitions: Object.entries(TRANSITIONS).map(([action, spec]) => ({
      action,
      to: spec.to,
      from: spec.from.slice(),
      event: spec.event,
    })),
    expiringWindowDays: EXPIRING_WINDOW_DAYS,
  };
}

/* ─────────────────────────── pricing (SRS §10.3, §10.4) ─────────────────────────── */

/**
 * Which `plan_prices` row to bill from — the first of the three decisions this module had to settle.
 *
 * `plan_prices.is_default` exists and its comment reads *"Pre-selected option when subscribing to
 * this plan"*, which is a statement about exactly this moment. So the rule is:
 *
 *  1. An explicit `plan_price_id` always wins, and must belong to the plan. If `billing_cycle` was
 *     also given, the two must agree — preferring one silently would mean the caller's stated cycle
 *     had no effect on the subscription it created.
 *  2. Otherwise, among the plan's **active** prices (optionally narrowed to a requested cycle):
 *     the one marked `is_default`, else the lowest `display_order`, else the lowest id. The
 *     tiebreak chain is total, so two reads of the same plan pick the same price.
 *  3. No active price is a 409, not a 422: the request is well formed and it is the plan's state
 *     that forbids it. `plans.service.setStatus()` refuses to activate such a plan for the same
 *     reason, so this is the second gate on the same condition rather than the only one.
 *
 * An inactive price named explicitly is refused. `is_active = false` is how `/plans` retires a price
 * that a subscription still points at (a `SET NULL` pointer it declines to break), so honouring it
 * on a new subscription would resurrect a withdrawn offer.
 *
 * @param {number|string} planId
 * @param {{plan_price_id?: number, billing_cycle?: string}} payload
 * @param {object} [transaction]
 * @returns {Promise<object>} a `PlanPrice` instance
 */
async function selectPrice(planId, payload = {}, transaction) {
  const requestedCycle = payload.billing_cycle;

  if (payload.plan_price_id) {
    const price = await db.PlanPrice.findOne({
      where: { id: payload.plan_price_id, plan_id: planId },
      transaction,
    });
    if (!price) {
      throw ApiError.validation('The chosen price does not belong to this plan', [
        {
          field: 'plan_price_id',
          message: `plan_prices row ${payload.plan_price_id} is not a price of plan ${planId}`,
        },
      ]);
    }
    if (!price.is_active) {
      throw ApiError.conflict('That price has been withdrawn and cannot be subscribed to', {
        code: 'PLAN_PRICE_INACTIVE',
        details: { planPriceId: price.id, planId: Number(planId) },
      });
    }
    if (requestedCycle && price.billing_cycle !== requestedCycle) {
      throw ApiError.validation('"plan_price_id" and "billing_cycle" disagree', [
        {
          field: 'billing_cycle',
          message: `plan_prices row ${price.id} bills ${price.billing_cycle}, not ${requestedCycle}`,
        },
      ]);
    }
    return price;
  }

  const where = { plan_id: planId, is_active: true };
  if (requestedCycle) where.billing_cycle = requestedCycle;

  const price = await db.PlanPrice.findOne({
    where,
    order: [
      ['is_default', 'DESC'],
      ['display_order', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });

  if (!price) {
    throw ApiError.conflict(
      requestedCycle
        ? `This plan has no active ${requestedCycle} price. Configure pricing first (FR-SUB-006).`
        : 'This plan has no active price, so nothing can be subscribed to it. Configure pricing first (FR-SUB-006).',
      {
        code: 'PLAN_NOT_PRICEABLE',
        details: { planId: Number(planId), billingCycle: requestedCycle || null },
      }
    );
  }

  return price;
}

/**
 * What one cycle costs — SRS §10.4's five pricing models, evaluated from the price row's columns.
 *
 * The five models are the source's; the arithmetic is the only reading the columns permit:
 *
 *  - **Fixed** — `base_amount`. Nothing else applies.
 *  - **Student-Based / Seat-Based / Per-Student** — `base_amount` plus `unit_amount` for every unit
 *    beyond `included_units`. The three differ in *what* a unit counts (students, seats, students
 *    again) and not in how the total is formed, which is why `subscriptions.quantity` carries the
 *    comment *"Seats/students used by the seat-based and per-student pricing models"* for all of
 *    them. `tier_min_units` / `tier_max_units` describe the band the row applies to and are
 *    validated by the model's own `tierBandOrdered`; they are not a second multiplier.
 *  - **Custom** — `custom_amount`, which is what §10.4's Custom Price and the `custom_notes`
 *    column beside it are for.
 *
 * `overage_unit_amount` is deliberately not used here: it prices consumption *past a limit*, which
 * is `usage_records` and §13's overage line, not this cycle's subscription fee.
 *
 * All arithmetic goes through `utils/money`, so it runs in integer minor units.
 *
 * @param {object} price     a `PlanPrice` row or instance
 * @param {number} quantity
 * @returns {number} major units, rounded to 2dp
 */
function computeCycleAmount(price, quantity = 1) {
  const model = price.pricing_model;

  if (model === PRICING_MODELS.CUSTOM) {
    return money.round(price.custom_amount);
  }

  const base = money.round(price.base_amount);

  if (model === PRICING_MODELS.FIXED) return base;

  const included = Number(price.included_units || 0);
  const billable = Math.max(0, Number(quantity || 0) - included);
  return money.sum(base, money.multiply(price.unit_amount, billable));
}

/**
 * The columns a subscription copies from its price row.
 *
 * Copied rather than joined, because the model says so in the column comment: *"Denormalised copy
 * of the price row so a later price edit cannot rewrite history."* A school that agreed to £400 a
 * year keeps paying £400 a year when the plan's yearly price is raised.
 *
 * @param {object} price
 * @param {number} quantity
 * @returns {object}
 */
function pricingColumns(price, quantity) {
  return {
    plan_price_id: price.id,
    billing_cycle: price.billing_cycle,
    cycle_days: price.cycle_days === undefined ? null : price.cycle_days,
    pricing_model: price.pricing_model,
    currency: price.currency,
    cycle_amount: computeCycleAmount(price, quantity),
    quantity,
  };
}

/* ─────────────────────────── history, caches, audit ─────────────────────────── */

/**
 * Write one `subscription_history` row.
 *
 * Every state change and every plan change goes through here, inside the same transaction as the
 * change it describes. Unlike `activity_logs` — which `activityLog.js` is explicit is *"a log, not
 * a ledger"* and writes after the response — this is part of the transaction, because §12.3's
 * proration figures are the only record of what a school was credited and are not reconstructible
 * from the subscription row afterwards.
 *
 * @param {object} fields
 * @param {object} [transaction]
 * @returns {Promise<object>}
 */
function recordHistory(fields, transaction) {
  /*
   * `proration_amount`, `credit_applied` and `new_amount` are left to their column default of null
   * rather than being zero-filled. Null reads as "not applicable to this event" — an add-on removal
   * prorated nothing — and a stored 0 would read as "prorated, and the answer was nothing".
   */
  return db.SubscriptionHistory.create({ effective_at: new Date(), ...fields }, { transaction });
}

/** The actor for a history row: the authenticated user, or null when the sweep is running. */
function performerOf(req) {
  const id = req && req.user ? Number(req.user.id) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Which subscription governs a school, and therefore which state its cached column shows.
 *
 * **A deliberate mirror of `entitlementService.findGoverningSubscription()`** — usable first,
 * otherwise the most recent row of any state, ordered `created_at DESC, id DESC`. It is duplicated
 * rather than imported because that function is private to a service whose contract is "read the
 * state, never recompute it", and exporting it would invite the opposite. The duplication is the
 * risk, so `scripts/verify-subscriptions.js` asserts the two agree on the same school rather than
 * trusting this comment.
 *
 * @param {number} schoolId
 * @param {object} [transaction]
 * @returns {Promise<string|null>} the governing state, or null when the school has no subscription
 */
async function governingStateFor(schoolId, transaction) {
  const order = [
    ['created_at', 'DESC'],
    ['id', 'DESC'],
  ];

  const usable = await db.Subscription.findOne({
    where: { school_id: schoolId, state: { [Op.in]: SUBSCRIPTION_USABLE_STATES } },
    attributes: ['id', 'state'],
    order,
    transaction,
  });
  if (usable) return usable.state;

  const any = await db.Subscription.findOne({
    where: { school_id: schoolId },
    attributes: ['id', 'state'],
    order,
    transaction,
  });
  return any ? any.state : null;
}

/**
 * Refresh `schools.subscription_state` — obligation 2 in the header.
 *
 * Returns whether the column moved, so `afterWrite()` can skip the tenant-cache invalidation when
 * nothing changed. Runs inside the caller's transaction; the cache drops happen after it commits.
 *
 * @param {number} schoolId
 * @param {object} [transaction]
 * @returns {Promise<{changed: boolean, from: string|null, to: string|null}>}
 */
async function syncSchoolState(schoolId, transaction) {
  const school = await db.School.findByPk(schoolId, {
    attributes: ['id', 'subscription_state'],
    transaction,
  });

  if (!school) {
    /* `subscriptions.school_id` is a foreign key, so this cannot happen through the ORM. */
    logger.error('syncSchoolState: subscription references a missing school', { schoolId });
    return { changed: false, from: null, to: null };
  }

  const from = school.subscription_state;
  const to = await governingStateFor(schoolId, transaction);

  if (from === to) return { changed: false, from, to };

  await school.update({ subscription_state: to }, { transaction });
  return { changed: true, from, to };
}

/**
 * Drop both caches this module's writes invalidate — obligations 1 and 3.
 *
 * Called after the transaction commits, never inside it: a rolled-back transaction that had already
 * flushed the cache would leave the caches correct and the intent lost, but a *committed* one whose
 * flush ran too early can serve the pre-write snapshot to a request that arrives in between.
 *
 * @param {number} schoolId
 * @param {{tenant?: boolean}} [options]  `tenant: false` when `schools.subscription_state` did not move
 * @returns {Promise<void>}
 */
async function afterWrite(schoolId, options = {}) {
  await entitlementService.invalidateSchool(schoolId);
  if (options.tenant !== false) await tenantService.invalidateSchool(schoolId);
}

/* ─────────────────── FR-SUB-010 — put a school on a plan ─────────────────── */

/**
 * The plan a subscription may be created on.
 *
 * FR-SUB-004 makes `status` mean *"available for new subscriptions"*, so an inactive or archived
 * plan is refused here — that is the sentence's only enforceable consequence, and `/plans` cannot
 * enforce it because it is not the module that sells. An **archived** plan is refused by the same
 * check and for a stronger reason: FR-SUB-005 keeps it *"retained for historical reference but not
 * offered for new subscriptions"*.
 *
 * A private plan is *not* refused. SRS §10.2's Public/Private field governs who may see the
 * catalogue, and a bespoke plan negotiated for one school is precisely a private plan a Super Admin
 * then subscribes that school to. `plans.service.scopeFor()` hides it from the school; this route
 * requires platform scope, so the caller here is the one it was negotiated by.
 *
 * @param {number|string} planId
 * @param {object} [transaction]
 * @returns {Promise<object>}
 */
async function loadSubscribablePlan(planId, transaction) {
  const plan = await db.SubscriptionPlan.findByPk(planId, { transaction });
  if (!plan) throw ApiError.notFound('Plan not found', { code: 'PLAN_NOT_FOUND' });

  if (plan.status !== PLAN_STATUS.ACTIVE) {
    throw ApiError.conflict(
      `Plan "${plan.name}" is ${plan.status} and is not available for new subscriptions (FR-SUB-004).`,
      { code: 'PLAN_NOT_AVAILABLE', details: { planId: plan.id, status: plan.status } }
    );
  }

  return plan;
}

/**
 * FR-SUB-010 — create a subscription.
 *
 * ## Which state it is born in
 *
 * `trial_days > 0` → **Trial**, which is FR-SUB-011's *"New subscriptions on the plan begin in Trial
 * state for the configured duration"* said in code. Otherwise **Pending**, matching the column
 * default: §12 lists Pending among the ten states and a subscription that has been created but not
 * yet activated is the only thing it can mean while §13's Payments do not exist. `POST /:id/activate`
 * is the edge out of it, and when payment approval is built it will call the same transition.
 *
 * The trial length defaults to the plan's `trial_days` and the grace length to its
 * `grace_period_days`; either may be overridden per subscription, which is what FR-SUB-011's and
 * FR-SUB-012's *"Plan **or subscription** exists"* precondition allows for.
 *
 * ## What it writes besides the subscription
 *
 * One `subscription_items` row for the plan line, and a second `setup_fee` line when the price
 * carries one — `plan_prices.setup_fee` would otherwise be a column nothing ever bills. Items are
 * §13's invoice source, so they are created here rather than derived at invoice time.
 *
 * `usage_records` are **not** seeded: `usageService.recordUsage()` creates them with `findOrCreate`
 * on first consumption and `periodFor()` derives the window from this subscription's
 * `current_period_start`, so a fresh period opens by itself at every renewal.
 *
 * @param {import('express').Request} req
 * @param {object} payload  validated body
 * @returns {Promise<object>}
 */
async function create(req, payload) {
  const school = await db.School.findByPk(payload.school_id, {
    attributes: ['id', 'name', 'organization_id', 'subscription_state'],
  });
  if (!school) throw ApiError.notFound('School not found', { code: 'SCHOOL_NOT_FOUND' });

  const existing = await db.Subscription.findOne({
    where: { school_id: school.id, state: { [Op.in]: OPEN_STATES } },
    attributes: ['id', 'state'],
    order: [['id', 'DESC']],
  });
  if (existing) {
    throw ApiError.conflict(
      `This school already holds a ${existing.state} subscription. Upgrade, downgrade or cancel it instead of creating a second one.`,
      {
        code: 'SCHOOL_ALREADY_SUBSCRIBED',
        details: { subscriptionId: existing.id, state: existing.state },
      }
    );
  }

  const plan = await loadSubscribablePlan(payload.plan_id);
  const price = await selectPrice(plan.id, payload);

  const startsAt = payload.starts_at ? new Date(payload.starts_at) : new Date();
  const quantity = payload.quantity || 1;

  const trialDays = payload.trial_days !== undefined ? payload.trial_days : plan.trial_days;
  const graceDays =
    payload.grace_period_days !== undefined ? payload.grace_period_days : plan.grace_period_days;

  const trialEndsAt = trialDays > 0 ? dates.addDays(startsAt, trialDays) : null;
  const state = trialDays > 0 ? STATES.TRIAL : STATES.PENDING;

  /* Null for `one_time`, which has no next period — the column's own comment says so. */
  const periodEnd = dates.addBillingCycle(startsAt, price.billing_cycle, price.cycle_days);

  let subscription;
  const created = { items: 0 };

  await db.sequelize.transaction(async (transaction) => {
    subscription = await db.Subscription.create(
      {
        school_id: school.id,
        organization_id: school.organization_id,
        plan_id: plan.id,
        state,
        ...pricingColumns(price, quantity),
        starts_at: startsAt,
        current_period_start: startsAt,
        current_period_end: periodEnd,
        ends_at: null,
        trial_days: trialDays,
        trial_starts_at: trialDays > 0 ? startsAt : null,
        trial_ends_at: trialEndsAt,
        grace_period_days: graceDays,
        grace_period_ends_at: null,
        renewal_mode: payload.renewal_mode || plan.default_renewal_mode,
        next_renewal_at: periodEnd,
        renewal_count: 0,
        credit_balance: 0,
        metadata: payload.metadata || null,
      },
      { transaction }
    );

    const items = [
      {
        subscription_id: subscription.id,
        school_id: school.id,
        item_type: 'plan',
        plan_id: plan.id,
        addon_id: null,
        description: `${plan.name} — ${price.billing_cycle}`.slice(0, 255),
        quantity,
        unit_amount: money.round(price.base_amount),
        amount: subscription.cycle_amount,
        currency: price.currency,
        period_start: startsAt,
        period_end: periodEnd,
        is_recurring: price.billing_cycle !== BILLING_CYCLES.ONE_TIME,
      },
    ];

    const setupFee = money.round(price.setup_fee);
    if (setupFee > 0) {
      items.push({
        subscription_id: subscription.id,
        school_id: school.id,
        item_type: 'setup_fee',
        plan_id: plan.id,
        addon_id: null,
        description: `Setup fee — ${plan.name}`.slice(0, 255),
        quantity: 1,
        unit_amount: setupFee,
        amount: setupFee,
        currency: price.currency,
        period_start: startsAt,
        period_end: null,
        /* One-off by definition, whatever the plan's cycle is. */
        is_recurring: false,
      });
    }

    /* `validate: true` because bulkCreate skips model validators by default. */
    await db.SubscriptionItem.bulkCreate(items, { transaction, validate: true });
    created.items = items.length;

    await recordHistory(
      {
        subscription_id: subscription.id,
        school_id: school.id,
        event: EVENTS.CREATED,
        from_state: null,
        to_state: state,
        from_plan_id: null,
        to_plan_id: plan.id,
        new_amount: subscription.cycle_amount,
        effective_at: startsAt,
        notes: payload.reason || null,
        performed_by: performerOf(req),
      },
      transaction
    );

    if (state === STATES.TRIAL) {
      await recordHistory(
        {
          subscription_id: subscription.id,
          school_id: school.id,
          event: EVENTS.TRIAL_STARTED,
          from_state: null,
          to_state: STATES.TRIAL,
          to_plan_id: plan.id,
          new_amount: subscription.cycle_amount,
          effective_at: startsAt,
          notes: `${trialDays}-day trial (SRS §12.1)`,
          performed_by: performerOf(req),
        },
        transaction
      );
    }

    await syncSchoolState(school.id, transaction);
  });

  await recordAudit(req, {
    tableName: 'subscriptions',
    recordId: subscription.id,
    event: 'create',
    after: snapshot(subscription),
    reason: payload.reason || null,
  });

  await afterWrite(school.id);

  return findById(req.tenant, subscription.id);
}

/**
 * FR-SUB-011 / FR-SUB-012 — reconfigure trial, grace, renewal mode or quantity.
 *
 * `quantity` re-evaluates `cycle_amount` from the same price row, because on the §10.4 per-unit
 * models the amount *is* a function of the quantity — leaving it stale would make the seat count and
 * the price disagree with no way to tell which was meant. `plan_price_id` is untouched: this is not
 * a plan change.
 *
 * Changing `grace_period_days` does not move an already-running `grace_period_ends_at`. FR-SUB-012
 * configures the grace period *"applied after a subscription becomes past due or expires"*, which is
 * a future tense; retroactively shortening a grace period a school is currently inside would expire
 * it early on the strength of an administrative edit.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function update(req, id, payload) {
  const subscription = await findById(req.tenant, id, { detail: false });
  const before = snapshot(subscription);

  const columns = {};
  if (payload.trial_days !== undefined) columns.trial_days = payload.trial_days;
  if (payload.grace_period_days !== undefined) {
    columns.grace_period_days = payload.grace_period_days;
  }
  if (payload.renewal_mode !== undefined) columns.renewal_mode = payload.renewal_mode;
  if (payload.metadata !== undefined) columns.metadata = payload.metadata;

  if (payload.quantity !== undefined && payload.quantity !== subscription.quantity) {
    columns.quantity = payload.quantity;

    if (subscription.plan_price_id) {
      const price = await db.PlanPrice.findByPk(subscription.plan_price_id);
      if (price) columns.cycle_amount = computeCycleAmount(price, payload.quantity);
    }
    /*
     * A null `plan_price_id` means the price row was retired after this subscription was created
     * (the column is `SET NULL`). The denormalised copy on the subscription is then the only record
     * of what was agreed, so the quantity changes and the amount stands.
     */
  }

  /*
   * A trial length edited while the subscription is still in Trial moves the end date, because that
   * is the only reading under which FR-SUB-011 applied to a *subscription* does anything. Once the
   * trial is over the number is history and only affects nothing.
   */
  if (
    columns.trial_days !== undefined &&
    subscription.state === STATES.TRIAL &&
    subscription.trial_starts_at
  ) {
    columns.trial_ends_at =
      columns.trial_days > 0 ? dates.addDays(subscription.trial_starts_at, columns.trial_days) : null;
  }

  await db.sequelize.transaction(async (transaction) => {
    await subscription.update(columns, { transaction });
  });

  await recordAudit(req, {
    tableName: 'subscriptions',
    recordId: subscription.id,
    event: 'update',
    before,
    after: snapshot(subscription),
    reason: payload.reason || null,
  });

  /*
   * No state change, so `schools.subscription_state` cannot have moved — but the entitlement
   * snapshot carries `trialEndsAt` and the subscription's own fields, so it still has to go.
   */
  await afterWrite(subscription.school_id, { tenant: false });

  return findById(req.tenant, subscription.id);
}

/* ────────────────── FR-SUB-010 — the six operator transitions ────────────────── */

/**
 * The six administrative edges of the §12 state machine.
 *
 * Data rather than six near-identical functions, for the reason `plans.service.TRANSITIONS` gives:
 * the invariant is that `state` and its companion stamp can never disagree, and that is only
 * visible if they are written in one place. It is also the seam §13 will use — when payment
 * approval is built, it calls `transition(req, id, 'activate')` rather than growing its own copy of
 * this table.
 *
 * `from` is the legal set, and every entry has a matching `SUBSCRIPTION_EVENTS` value — see the file
 * header on why that mapping is the evidence for which edges the schema anticipated.
 *
 * `columns(subscription, at)` returns everything the edge writes. Each one clears the stamps that
 * no longer apply, so a reactivated subscription does not keep reporting when it was cancelled.
 */
const TRANSITIONS = Object.freeze({
  /**
   * Pending or Trial → Active.
   *
   * The paid period is re-based to the moment of activation rather than left at `starts_at`. A
   * subscription that sat Pending for a week, or a trial activated early, would otherwise be billed
   * for a period that had already partly elapsed. `trial_ends_at` is stamped with the activation
   * time when the edge comes from Trial, because that is when the trial actually ended; the
   * configured length stays on `trial_days`, so nothing is lost.
   */
  activate: {
    to: STATES.ACTIVE,
    from: [STATES.PENDING, STATES.TRIAL],
    event: EVENTS.ACTIVATED,
    verb: 'Activated',
    columns: (subscription, at) => {
      const periodEnd = dates.addBillingCycle(
        at,
        subscription.billing_cycle,
        subscription.cycle_days
      );
      return {
        state: STATES.ACTIVE,
        current_period_start: at,
        current_period_end: periodEnd,
        next_renewal_at: periodEnd,
        trial_ends_at: subscription.state === STATES.TRIAL ? at : subscription.trial_ends_at,
        grace_period_ends_at: null,
        expiry_notified_at: null,
        ends_at: null,
      };
    },
  },

  /**
   * → Suspended. An administrative stop: entitlement ends immediately (`suspended` is not one of
   * `SUBSCRIPTION_USABLE_STATES`) and the period boundaries are left exactly where they were, so
   * reactivation has something to return to.
   */
  suspend: {
    to: STATES.SUSPENDED,
    from: [
      STATES.PENDING,
      STATES.TRIAL,
      STATES.ACTIVE,
      STATES.EXPIRING,
      STATES.PAST_DUE,
      STATES.GRACE_PERIOD,
      STATES.PAUSED,
    ],
    event: EVENTS.SUSPENDED,
    verb: 'Suspended',
    columns: (subscription, at) => ({ state: STATES.SUSPENDED, suspended_at: at }),
  },

  /**
   * Suspended, Expired or Cancelled → Active, on a fresh cycle.
   *
   * The edge out of all three terminal-ish states, and the reason `SUBSCRIPTION_EVENTS` carries
   * `reactivated` distinctly from `activated`. A new period starts at the moment of reactivation —
   * resuming a period that expired months ago would hand the school a cycle it never paid for and
   * would put `current_period_end` in the past, which the sweep would immediately act on.
   */
  reactivate: {
    to: STATES.ACTIVE,
    from: [STATES.SUSPENDED, STATES.EXPIRED, STATES.CANCELLED],
    event: EVENTS.REACTIVATED,
    verb: 'Reactivated',
    columns: (subscription, at) => {
      const periodEnd = dates.addBillingCycle(
        at,
        subscription.billing_cycle,
        subscription.cycle_days
      );
      return {
        state: STATES.ACTIVE,
        current_period_start: at,
        current_period_end: periodEnd,
        next_renewal_at: periodEnd,
        suspended_at: null,
        cancelled_at: null,
        cancellation_reason: null,
        expired_at: null,
        expiry_notified_at: null,
        grace_period_ends_at: null,
        ends_at: null,
      };
    },
  },

  /**
   * → Paused.
   *
   * **Interpretation, flagged as such.** §12 lists Paused and Suspended as separate states and
   * defines neither, so the difference has to come from the words. The only reading under which
   * "paused" is not a synonym for "suspended" is that the clock stops: `resume` shifts every future
   * boundary forward by exactly how long the pause lasted, so a school that pauses for ten days gets
   * those ten days back rather than paying for them. Suspension, by contrast, leaves the boundaries
   * alone — the school loses the time.
   */
  pause: {
    to: STATES.PAUSED,
    from: [STATES.TRIAL, STATES.ACTIVE, STATES.EXPIRING],
    event: EVENTS.PAUSED,
    verb: 'Paused',
    columns: (subscription, at) => ({ state: STATES.PAUSED, paused_at: at }),
  },

  /**
   * Paused → Active, with every future boundary shifted by the paused duration.
   *
   * Shifted in milliseconds rather than whole days, so a pause of thirty hours moves the period end
   * by thirty hours and not by one day or two. `trial_ends_at` moves too when it is still ahead: a
   * trial paused on day two of fourteen resumes with twelve days left.
   */
  resume: {
    to: STATES.ACTIVE,
    from: [STATES.PAUSED],
    event: EVENTS.RESUMED,
    verb: 'Resumed',
    columns: (subscription, at) => {
      const pausedAt = subscription.paused_at ? new Date(subscription.paused_at) : at;
      const shiftMs = Math.max(0, at.getTime() - pausedAt.getTime());
      const shift = (value) => (value ? new Date(new Date(value).getTime() + shiftMs) : value);

      const periodEnd = shift(subscription.current_period_end);
      const trialEndsAt = shift(subscription.trial_ends_at);

      return {
        /* A trial that still has time left resumes as a trial, not as a paid subscription. */
        state: trialEndsAt && trialEndsAt.getTime() > at.getTime() ? STATES.TRIAL : STATES.ACTIVE,
        paused_at: null,
        current_period_end: periodEnd,
        next_renewal_at: periodEnd,
        trial_ends_at: trialEndsAt,
      };
    },
  },

  /**
   * → Cancelled, immediately.
   *
   * §12 names Cancelled as a state and §12.4 gives *"Next Billing Cycle"* timing to **downgrade**
   * only, so a cancellation that took effect at period end would be an operation the source does not
   * describe. `ends_at` is stamped, which is what tells §13's invoicing where the billable term
   * stopped. The row itself stays: it is the school's billing history, and `subscription_items` and
   * `invoices` point at it.
   */
  cancel: {
    to: STATES.CANCELLED,
    from: [
      STATES.PENDING,
      STATES.TRIAL,
      STATES.ACTIVE,
      STATES.EXPIRING,
      STATES.PAST_DUE,
      STATES.GRACE_PERIOD,
      STATES.PAUSED,
      STATES.SUSPENDED,
    ],
    event: EVENTS.CANCELLED,
    verb: 'Cancelled',
    columns: (subscription, at, reason) => ({
      state: STATES.CANCELLED,
      cancelled_at: at,
      cancellation_reason: reason || null,
      ends_at: at,
      next_renewal_at: null,
      scheduled_plan_id: null,
      scheduled_plan_price_id: null,
      scheduled_change_type: null,
      scheduled_change_timing: null,
      scheduled_change_at: null,
    }),
  },
});

/**
 * Apply one administrative transition — FR-SUB-010.
 *
 * A transition from an illegal state is a 409: the request is well formed, and it is the
 * subscription's standing that forbids it. The message names both the current state and the legal
 * set, because "cannot activate" without either is unactionable.
 *
 * A transition to the state the subscription is already in is refused rather than treated as a
 * no-op. Silently succeeding would write an audit row saying nothing changed and would let a double
 * click on "Suspend" overwrite `suspended_at` with a later timestamp.
 *
 * @param {import('express').Request|null} req  null when called by `runLifecycleSweep()`
 * @param {number|string} id
 * @param {string} action  a key of `TRANSITIONS`
 * @param {string} [reason]
 * @param {{tenant?: object}} [options]  scope when there is no request — the sweep passes platform
 * @returns {Promise<{subscription: object, previousState: string, verb: string, event: string}>}
 */
async function transition(req, id, action, reason, options = {}) {
  const spec = TRANSITIONS[action];
  if (!spec) {
    /* Boot-level mistake, not a client one — the routes pass literals. */
    throw new Error(`subscriptions.service.transition(): unsupported action '${action}'`);
  }

  const tenant = options.tenant || (req && req.tenant);
  const subscription = await findById(tenant, id, { detail: false });

  if (subscription.state === spec.to) {
    throw ApiError.conflict(`This subscription is already ${spec.to}.`, {
      code: 'SUBSCRIPTION_STATE_UNCHANGED',
      details: { subscriptionId: subscription.id, state: subscription.state },
    });
  }

  if (!spec.from.includes(subscription.state)) {
    throw ApiError.conflict(
      `A ${subscription.state} subscription cannot be ${spec.verb.toLowerCase()}.`,
      {
        code: 'SUBSCRIPTION_STATE_INVALID',
        details: {
          subscriptionId: subscription.id,
          state: subscription.state,
          action,
          allowedFrom: spec.from.slice(),
        },
      }
    );
  }

  const at = new Date();
  const previousState = subscription.state;
  const before = snapshot(subscription);
  let schoolState;

  await db.sequelize.transaction(async (transaction) => {
    await subscription.update(spec.columns(subscription, at, reason), { transaction });

    await recordHistory(
      {
        subscription_id: subscription.id,
        school_id: subscription.school_id,
        event: spec.event,
        from_state: previousState,
        to_state: subscription.state,
        from_plan_id: subscription.plan_id,
        to_plan_id: subscription.plan_id,
        new_amount: subscription.cycle_amount,
        effective_at: at,
        notes: reason || null,
        performed_by: performerOf(req),
      },
      transaction
    );

    schoolState = await syncSchoolState(subscription.school_id, transaction);
  });

  await recordAudit(req, {
    tableName: 'subscriptions',
    recordId: subscription.id,
    event: 'update',
    before,
    after: snapshot(subscription),
    reason: reason || null,
  });

  await afterWrite(subscription.school_id, { tenant: schoolState.changed });

  return {
    subscription: await findById(tenant, subscription.id),
    previousState,
    verb: spec.verb,
    event: spec.event,
  };
}

/* ────────── FR-SUB-013 / FR-SUB-014 — upgrade and downgrade (§12.3, §12.4) ────────── */

/**
 * Whether a price bills on the subscription's own cycle — the same `billing_cycle`, and for
 * `custom_days` the same number of days.
 *
 * @param {object} subscription
 * @param {object} price
 * @returns {boolean}
 */
function sameCycle(subscription, price) {
  if (price.billing_cycle !== subscription.billing_cycle) return false;
  return (
    price.billing_cycle !== BILLING_CYCLES.CUSTOM_DAYS ||
    Number(price.cycle_days) === Number(subscription.cycle_days)
  );
}

/**
 * SRS §12.3's four bullets, in one calculation.
 *
 * §12.3 names **Upgrade**, **Proration**, **Remaining Credit** and **New Price Calculation**, and
 * FR-SUB-013's behaviour lines are *"calculates proration"*, *"applies remaining credit from the
 * prior plan"* and *"calculates the new price"*. Read together they describe one arithmetic:
 *
 * ```
 *   periodDays    = billingCycleDays(cycle, cycle_days, current_period_start)   // the denominator
 *   remainingDays = periodDays − elapsedDays                                    // clamped to [0, periodDays]
 *   unusedCredit  = cycle_amount × remainingDays / periodDays        ← the part of the old plan not consumed
 *   prorationDue  = newCycleAmount × remainingDays / periodDays      ← the new plan, for the remainder only
 *   creditApplied = min(credit_balance + unusedCredit, prorationDue)  ← "applies remaining credit"
 *   amountDue     = prorationDue − creditApplied
 *   credit_balance = (credit_balance + unusedCredit) − creditApplied  ← what carries forward
 * ```
 *
 * `utils/dates.billingCycleDays()` is documented as *"the denominator for proration (SRS §12.3)"*,
 * which is why the period length comes from there rather than from a subtraction: for calendar
 * cycles it reports the actual length of the specific period being prorated.
 *
 * The same function serves both directions. A downgrade produces a smaller `prorationDue` than
 * `unusedCredit`, so `creditApplied` is capped by it and the difference stays in `credit_balance` —
 * which is exactly what "Remaining Credit" means on the way down. Nothing is refunded: §12 has no
 * refund operation (§13.4 does, and it is not this module).
 *
 * A `one_time` cycle has no period length — `billingCycleDays()` returns 0 — so there is nothing to
 * prorate and every figure is zero. Documented rather than special-cased away, because a
 * `one_time` subscription being upgraded is a real arrangement and it must not divide by zero.
 *
 * A new price on a **different** recurring cycle is the one refinement of the formula above. Its
 * `newCycleAmount` pays for a period of another length, so multiplying it by the old period's fraction
 * charged a yearly school moved halfway through onto a monthly price half of one month for six months.
 * There the remainder is priced at the new price's own daily rate instead:
 * `prorationDue = newCycleAmount × remainingDays / newPeriodDays`. On the same cycle `newPeriodDays`
 * is `periodDays` and the figure is the formula's, unchanged.
 *
 * @param {object} subscription
 * @param {number} newCycleAmount
 * @param {Date} at
 * @param {object} [newPrice]  the `plan_prices` row being moved onto, when its cycle may differ
 * @returns {{periodDays: number, elapsedDays: number, remainingDays: number, unusedCredit: number,
 *            prorationDue: number, creditApplied: number, amountDue: number, creditBalance: number}}
 */
function prorate(subscription, newCycleAmount, at, newPrice = null) {
  const periodDays = dates.billingCycleDays(
    subscription.billing_cycle,
    subscription.cycle_days,
    subscription.current_period_start
  );

  const openingCredit = money.round(subscription.credit_balance);

  if (!periodDays) {
    return {
      periodDays: 0,
      elapsedDays: 0,
      remainingDays: 0,
      unusedCredit: 0,
      prorationDue: 0,
      creditApplied: 0,
      amountDue: 0,
      creditBalance: openingCredit,
    };
  }

  const elapsedRaw = dates.daysBetween(subscription.current_period_start, at);
  const elapsedDays = Math.min(Math.max(elapsedRaw, 0), periodDays);
  const remainingDays = periodDays - elapsedDays;
  const fraction = remainingDays / periodDays;

  const unusedCredit = money.multiply(subscription.cycle_amount, fraction);
  const newPeriodDays =
    newPrice && !sameCycle(subscription, newPrice)
      ? dates.billingCycleDays(newPrice.billing_cycle, newPrice.cycle_days, at)
      : periodDays;
  const prorationDue = newPeriodDays ? money.multiply(newCycleAmount, remainingDays / newPeriodDays) : 0;

  const available = money.sum(openingCredit, unusedCredit);
  const creditApplied = Math.min(available, prorationDue);

  return {
    periodDays,
    elapsedDays,
    remainingDays,
    unusedCredit,
    prorationDue,
    creditApplied: money.round(creditApplied),
    amountDue: money.clampNonNegative(money.subtract(prorationDue, creditApplied)),
    creditBalance: money.clampNonNegative(money.subtract(available, creditApplied)),
  };
}

/**
 * Upgrade or downgrade — FR-SUB-013 and FR-SUB-014.
 *
 * ## Direction is a fact about the two plans, not a claim by the caller
 *
 * FR-SUB-013 is *"to a higher plan or tier"*, FR-SUB-014 *"to a lower plan or tier"*, and
 * `subscription_plans.tier_rank` carries the comment *"Higher rank = higher tier; drives
 * upgrade/downgrade classification"*. So the route the caller chose is checked against the ranks
 * rather than trusted. A same-rank change is neither, and is refused: it would have to pick one of
 * two different sets of rules with nothing to pick on.
 *
 * ## Immediate versus Next Billing Cycle — SRS §12.4
 *
 * An **immediate** change (all upgrades, and downgrades that ask for it) switches the plan now and
 * runs the §12.3 arithmetic. FR-SUB-013 gives upgrades no timing option at all, which is consistent:
 * an upgrade grants capability, and deferring it would mean the school paid for a tier it could not
 * use yet.
 *
 * A **next billing cycle** downgrade writes the `scheduled_*` group and changes nothing else —
 * settling the second of this module's three open decisions. `runLifecycleSweep()`'s renewal applies
 * it when the period turns over. The school keeps the higher tier until then, which is the point:
 * an immediate downgrade can drop a limit below what the school is already using, and the deferred
 * form is how §12.4 lets an operator avoid that.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} payload
 * @param {'upgrade'|'downgrade'} direction
 * @returns {Promise<{subscription: object, change: object}>}
 */
async function changePlan(req, id, payload, direction) {
  const subscription = await findById(req.tenant, id, { detail: false });

  if (!SUBSCRIPTION_USABLE_STATES.includes(subscription.state)) {
    /*
     * Both FRs' precondition is *"Active subscription exists"*. The remedy is named per state: this
     * said "Reactivate it first" to every one, and `reactivate` is only from suspended, expired or
     * cancelled — a pending subscription is activated and a paused one resumed.
     */
    const remedy =
      subscription.state === STATES.PENDING
        ? 'Activate it first'
        : subscription.state === STATES.PAUSED
          ? 'Resume it first'
          : 'Reactivate it first';
    throw ApiError.conflict(
      `A ${subscription.state} subscription cannot be ${direction}d. ${remedy}.`,
      {
        code: 'SUBSCRIPTION_NOT_CHANGEABLE',
        details: {
          subscriptionId: subscription.id,
          state: subscription.state,
          allowedFrom: SUBSCRIPTION_USABLE_STATES.slice(),
        },
      }
    );
  }

  const currentPlan = await db.SubscriptionPlan.findByPk(subscription.plan_id);
  const targetPlan = await loadSubscribablePlan(payload.plan_id);

  if (targetPlan.id === subscription.plan_id) {
    throw ApiError.conflict('This subscription is already on that plan.', {
      code: 'SUBSCRIPTION_PLAN_UNCHANGED',
      details: { subscriptionId: subscription.id, planId: targetPlan.id },
    });
  }

  const currentRank = Number(currentPlan ? currentPlan.tier_rank : 0);
  const targetRank = Number(targetPlan.tier_rank);

  if (targetRank === currentRank) {
    throw ApiError.conflict(
      `"${targetPlan.name}" is the same tier as the current plan, so this is neither an upgrade (FR-SUB-013) nor a downgrade (FR-SUB-014).`,
      {
        code: 'SUBSCRIPTION_SAME_TIER',
        details: { tierRank: targetRank, fromPlanId: subscription.plan_id, toPlanId: targetPlan.id },
      }
    );
  }

  const isUpgrade = targetRank > currentRank;
  if (isUpgrade !== (direction === 'upgrade')) {
    throw ApiError.conflict(
      isUpgrade
        ? `"${targetPlan.name}" is a higher tier than the current plan; use POST /subscriptions/:id/upgrade (FR-SUB-013).`
        : `"${targetPlan.name}" is a lower tier than the current plan; use POST /subscriptions/:id/downgrade (FR-SUB-014), which requires a timing choice.`,
      {
        code: 'SUBSCRIPTION_WRONG_DIRECTION',
        details: {
          requested: direction,
          actual: isUpgrade ? 'upgrade' : 'downgrade',
          fromTierRank: currentRank,
          toTierRank: targetRank,
        },
      }
    );
  }

  const deferred =
    direction === 'downgrade' && payload.timing === DOWNGRADE_TIMING.NEXT_BILLING_CYCLE;

  /*
   * A one-time subscription has no next billing cycle, so a change scheduled for it could never land:
   * `renew()` refuses a one-time subscription and the lifecycle sweep never renews one. Refused here
   * rather than recorded as a scheduled change nothing will ever apply — and before a price is chosen,
   * because no price would make it possible.
   */
  if (deferred && (subscription.billing_cycle === BILLING_CYCLES.ONE_TIME || !subscription.current_period_end)) {
    throw ApiError.conflict(
      'A one-time subscription has no next billing cycle, so a downgrade cannot be scheduled for one. Downgrade it immediately instead.',
      { code: 'SUBSCRIPTION_NO_NEXT_CYCLE', details: { subscriptionId: subscription.id } }
    );
  }

  /*
   * The subscription keeps its billing cycle unless the caller names another. Asked with neither a
   * price nor a cycle, `selectPrice()` picks the target plan's default price on *any* cycle — so a
   * school billed yearly could be moved onto a monthly price that nobody chose. Found by the audit of
   * the plan-change panel; a plan with no price on this cycle is now a refusal that says so, not a
   * silent switch. A cycle the caller does name is carried: see `prorate()` and the guards below.
   */
  const keepsCycle = !payload.plan_price_id && !payload.billing_cycle;
  let price;
  try {
    price = await selectPrice(
      targetPlan.id,
      keepsCycle ? { ...payload, billing_cycle: subscription.billing_cycle } : payload
    );
  } catch (err) {
    if (keepsCycle && err instanceof ApiError && err.code === 'PLAN_NOT_PRICEABLE') {
      throw ApiError.conflict(
        `"${targetPlan.name}" has no active ${subscription.billing_cycle} price, which is this subscription's billing cycle. Choose one of its prices to change the cycle as well.`,
        { code: 'PLAN_PRICE_CYCLE_UNAVAILABLE', details: { planId: targetPlan.id, billingCycle: subscription.billing_cycle } }
      );
    }
    throw err;
  }

  /*
   * What a plan change cannot carry across, on either timing:
   *
   *  - **another currency.** The credit carried forward and the prorated figures are amounts in the
   *    subscription's currency, and nothing in the platform converts one currency into another, so
   *    they would be relabelled rather than converted. The add-on purchase refuses the same thing.
   *  - **a one-time price on one side and a recurring one on the other.** A one-time period has no
   *    length to prorate against, so the move bills nothing; and a subscription moved onto a
   *    recurring price from one-time has no period that renewal will ever continue.
   *
   * Another recurring cycle *is* carried — `prorate()` prices the remainder at the new price's own
   * daily rate. Found by the review of the plan-change panel.
   */
  if (price.currency && subscription.currency && price.currency !== subscription.currency) {
    throw ApiError.conflict(
      `This subscription is billed in ${subscription.currency}, and that price is in ${price.currency}. A plan change keeps the subscription's currency — its credit and proration cannot be converted — so choose a ${subscription.currency} price.`,
      {
        code: 'PLAN_PRICE_CURRENCY_MISMATCH',
        details: { planPriceId: price.id, priceCurrency: price.currency, subscriptionCurrency: subscription.currency },
      }
    );
  }
  if ((price.billing_cycle === BILLING_CYCLES.ONE_TIME) !== (subscription.billing_cycle === BILLING_CYCLES.ONE_TIME)) {
    throw ApiError.conflict(
      price.billing_cycle === BILLING_CYCLES.ONE_TIME
        ? 'A plan change cannot move a recurring subscription onto a one-time price. Choose a recurring price.'
        : 'A plan change cannot move a one-time subscription onto a recurring price, because a one-time subscription is never renewed. Choose a one-time price.',
      {
        code: 'PLAN_PRICE_CYCLE_KIND_MISMATCH',
        details: { planPriceId: price.id, priceCycle: price.billing_cycle, subscriptionCycle: subscription.billing_cycle },
      }
    );
  }

  const quantity = payload.quantity || subscription.quantity;
  const newCycleAmount = computeCycleAmount(price, quantity);

  const at = new Date();
  const before = snapshot(subscription);

  /* ── The deferred form: record the intent, change nothing else. ── */
  if (deferred) {
    await db.sequelize.transaction(async (transaction) => {
      await subscription.update(
        {
          scheduled_plan_id: targetPlan.id,
          scheduled_plan_price_id: price.id,
          scheduled_change_type: 'downgrade',
          scheduled_change_timing: DOWNGRADE_TIMING.NEXT_BILLING_CYCLE,
          scheduled_change_at: subscription.current_period_end,
        },
        { transaction }
      );

      await recordHistory(
        {
          subscription_id: subscription.id,
          school_id: subscription.school_id,
          event: EVENTS.DOWNGRADE_SCHEDULED,
          from_state: subscription.state,
          to_state: subscription.state,
          from_plan_id: subscription.plan_id,
          to_plan_id: targetPlan.id,
          new_amount: newCycleAmount,
          effective_at: subscription.current_period_end || at,
          notes: payload.reason || `Scheduled for the next billing cycle (SRS §12.4)`,
          performed_by: performerOf(req),
        },
        transaction
      );
    });

    await recordAudit(req, {
      tableName: 'subscriptions',
      recordId: subscription.id,
      event: 'update',
      before,
      after: snapshot(subscription),
      reason: payload.reason || null,
    });

    /*
     * The scheduled columns are not in the entitlement snapshot and the state has not moved, so
     * strictly neither cache is stale. Invalidated anyway: the snapshot is what a screen reads to
     * show the school what it is on, and a pending change it cannot see is worse than a cache miss.
     */
    await afterWrite(subscription.school_id, { tenant: false });

    return {
      subscription: await findById(req.tenant, subscription.id),
      change: {
        direction: 'downgrade',
        timing: DOWNGRADE_TIMING.NEXT_BILLING_CYCLE,
        applied: false,
        effectiveAt: subscription.current_period_end,
        fromPlan: { id: subscription.plan_id, name: currentPlan ? currentPlan.name : null },
        toPlan: { id: targetPlan.id, name: targetPlan.name },
        newCycleAmount,
        currency: price.currency,
      },
    };
  }

  /* ── The immediate form: §12.3's arithmetic, then the switch. ── */
  const proration = prorate(subscription, newCycleAmount, at, price);
  let schoolState;
  let prorationInvoice = null;

  await db.sequelize.transaction(async (transaction) => {
    await subscription.update(
      {
        plan_id: targetPlan.id,
        ...pricingColumns(price, quantity),
        credit_balance: proration.creditBalance,
        /*
         * The remainder of the current period is what was prorated, so the period itself is
         * untouched: the school is now on the new plan until the same renewal date. Changing the
         * boundary as well would mean charging a prorated remainder *and* moving the end of it.
         */
        scheduled_plan_id: null,
        scheduled_plan_price_id: null,
        scheduled_change_type: null,
        scheduled_change_timing: null,
        scheduled_change_at: null,
      },
      { transaction }
    );

    /* The plan line follows the plan — it is §13's invoice source. */
    await db.SubscriptionItem.update(
      {
        plan_id: targetPlan.id,
        description: `${targetPlan.name} — ${price.billing_cycle}`.slice(0, 255),
        quantity,
        unit_amount: money.round(price.base_amount),
        amount: newCycleAmount,
        currency: price.currency,
        period_start: subscription.current_period_start,
        period_end: subscription.current_period_end,
        is_recurring: price.billing_cycle !== BILLING_CYCLES.ONE_TIME,
      },
      { where: { subscription_id: subscription.id, item_type: 'plan' }, transaction }
    );

    await recordHistory(
      {
        subscription_id: subscription.id,
        school_id: subscription.school_id,
        event: isUpgrade ? EVENTS.UPGRADED : EVENTS.DOWNGRADED,
        from_state: subscription.state,
        to_state: subscription.state,
        from_plan_id: before.plan_id,
        to_plan_id: targetPlan.id,
        /* The three §12.3 figures the column comment exists for. */
        proration_amount: proration.prorationDue,
        credit_applied: proration.creditApplied,
        new_amount: newCycleAmount,
        effective_at: at,
        notes: payload.reason || null,
        performed_by: performerOf(req),
        metadata: {
          direction: isUpgrade ? 'upgrade' : 'downgrade',
          timing: DOWNGRADE_TIMING.IMMEDIATE,
          periodDays: proration.periodDays,
          remainingDays: proration.remainingDays,
          unusedCredit: proration.unusedCredit,
          amountDue: proration.amountDue,
          creditBalance: proration.creditBalance,
        },
      },
      transaction
    );

    /* The plan changed, not the state — but the plan is what the cached column is resolved from. */
    schoolState = await syncSchoolState(subscription.school_id, transaction);

    /*
     * The prorated amount due, invoiced — FR-SUB-013's outcome is "upgraded with correctly prorated
     * billing". The panel showed "X due" and nothing ever billed X: the only invoice path,
     * `generateForSubscription()`, bills the items at full price and refuses a second invoice for a
     * period already billed. So a positive `amountDue` is issued here as its own invoice — one
     * `custom` line for the remainder of the period, from now to its end — in this transaction, so a
     * plan change and the money it owes land together or not at all. The credit was already applied
     * by the proration, so the invoice takes none; tax is the default, as on every issued invoice.
     */
    if (money.toMinor(proration.amountDue) > 0) {
      prorationInvoice = await invoicesService.issue(
        req,
        {
          schoolId: subscription.school_id,
          organizationId: subscription.organization_id,
          subscriptionId: subscription.id,
          planId: targetPlan.id,
          planName: targetPlan.name,
          billingPeriodStart: at,
          billingPeriodEnd: subscription.current_period_end,
          billingCycle: price.billing_cycle,
          currency: price.currency,
          lines: [
            {
              item_type: 'custom',
              description: `${isUpgrade ? 'Upgrade' : 'Change'} to ${targetPlan.name} — prorated for ${proration.remainingDays} day(s)`.slice(0, 255),
              quantity: 1,
              unit_amount: proration.amountDue,
              amount: proration.amountDue,
              period_start: at,
              period_end: subscription.current_period_end,
              metadata: { proration: true, fromPlanId: before.plan_id, toPlanId: targetPlan.id },
            },
          ],
          creditAvailable: 0,
          issueDate: at,
          dueDays: subscription.grace_period_days,
          reason: payload.reason || `Prorated ${isUpgrade ? 'upgrade' : 'change'} to ${targetPlan.name}`,
        },
        { transaction }
      );
    }
  });

  await recordAudit(req, {
    tableName: 'subscriptions',
    recordId: subscription.id,
    event: 'update',
    before,
    after: snapshot(subscription),
    reason: payload.reason || null,
  });

  await afterWrite(subscription.school_id, { tenant: schoolState.changed });

  return {
    subscription: await findById(req.tenant, subscription.id),
    change: {
      direction: isUpgrade ? 'upgrade' : 'downgrade',
      timing: DOWNGRADE_TIMING.IMMEDIATE,
      applied: true,
      effectiveAt: at,
      fromPlan: { id: before.plan_id, name: currentPlan ? currentPlan.name : null },
      toPlan: { id: targetPlan.id, name: targetPlan.name },
      newCycleAmount,
      currency: price.currency,
      proration,
      invoice: prorationInvoice
        ? {
            id: prorationInvoice.id,
            invoice_number: prorationInvoice.invoice_number,
            total: money.decimal(prorationInvoice.total),
            due_date: prorationInvoice.due_date,
          }
        : null,
    },
  };
}

/* ─────────────────────── FR-SUB-015 — renewal (§12.5) ─────────────────────── */

/**
 * Renew one subscription into its next billing cycle.
 *
 * One function for both §12.5 modes. **Manual Renewal** is *"initiated by an authorized user"* —
 * `POST /:id/renew`, which passes a request. **Automatic Renewal** is *"initiated by the system at
 * cycle end"* — `runLifecycleSweep()`, which passes none. The behaviour has to be identical or the
 * two modes would diverge in ways nobody tested, so the mode is a parameter and not a fork.
 *
 * ## The new period starts where the old one ended
 *
 * Not at `now`. A renewal processed a few hours late must not shorten the school's year, and one
 * processed early must not lengthen it. When the old period end is unknown (a subscription renewed
 * out of a state that has none) the current moment is the only available anchor and is used.
 *
 * ## A scheduled downgrade lands here
 *
 * This is the other half of FR-SUB-014's *"Next Billing Cycle"*: if `scheduled_change_at` has
 * arrived, the plan, price and amount switch as part of the renewal and the `scheduled_*` group is
 * cleared. Two history rows are written, `downgraded` and `renewed`, because they are two events
 * and collapsing them would lose which plan the new period is actually on.
 *
 * `one_time` has no next period — `addBillingCycle()` returns null — so renewal is refused rather
 * than producing a subscription with a null end date it would then try to renew again.
 *
 * @param {import('express').Request|null} req
 * @param {number|string} id
 * @param {{reason?: string, at?: Date, tenant?: object, mode?: string}} [options]
 * @returns {Promise<{subscription: object, renewal: object}>}
 */
async function renew(req, id, options = {}) {
  const tenant = options.tenant || (req && req.tenant);
  const subscription = await findById(tenant, id, { detail: false });
  const at = options.at || new Date();

  const renewableFrom = [
    STATES.ACTIVE,
    STATES.EXPIRING,
    STATES.PAST_DUE,
    STATES.GRACE_PERIOD,
    STATES.EXPIRED,
  ];
  if (!renewableFrom.includes(subscription.state)) {
    throw ApiError.conflict(`A ${subscription.state} subscription cannot be renewed.`, {
      code: 'SUBSCRIPTION_NOT_RENEWABLE',
      details: {
        subscriptionId: subscription.id,
        state: subscription.state,
        allowedFrom: renewableFrom,
      },
    });
  }

  if (subscription.billing_cycle === BILLING_CYCLES.ONE_TIME) {
    throw ApiError.conflict(
      'A one-time subscription has no next billing cycle, so it cannot be renewed (SRS §10.3).',
      { code: 'SUBSCRIPTION_NOT_RECURRING', details: { subscriptionId: subscription.id } }
    );
  }

  const before = snapshot(subscription);
  const previousState = subscription.state;

  /* A scheduled change is due when its date has arrived — or when it is the period we are leaving. */
  const scheduledDue =
    subscription.scheduled_plan_id &&
    (!subscription.scheduled_change_at || new Date(subscription.scheduled_change_at) <= at);

  let targetPlan = null;
  let price = null;
  let newCycleAmount = money.round(subscription.cycle_amount);

  if (scheduledDue) {
    targetPlan = await db.SubscriptionPlan.findByPk(subscription.scheduled_plan_id);
    price = subscription.scheduled_plan_price_id
      ? await db.PlanPrice.findByPk(subscription.scheduled_plan_price_id)
      : null;

    if (!targetPlan) {
      /*
       * `scheduled_plan_id` is `SET NULL`, so a plan hard-deleted between scheduling and renewal
       * leaves this null and never reaches here. A row that exists but cannot be loaded is a real
       * fault: renew on the current plan and say so, rather than failing the renewal outright.
       */
      logger.error('Scheduled plan change could not be loaded; renewing on the current plan', {
        subscriptionId: subscription.id,
        scheduledPlanId: subscription.scheduled_plan_id,
      });
    } else if (price) {
      newCycleAmount = computeCycleAmount(price, subscription.quantity);
    }
  }

  const periodStart = subscription.current_period_end
    ? new Date(subscription.current_period_end)
    : at;
  const cycle = price ? price.billing_cycle : subscription.billing_cycle;
  const cycleDays = price ? price.cycle_days : subscription.cycle_days;
  const periodEnd = dates.addBillingCycle(periodStart, cycle, cycleDays);

  let schoolState;

  await db.sequelize.transaction(async (transaction) => {
    const columns = {
      state: STATES.ACTIVE,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      next_renewal_at: periodEnd,
      last_renewed_at: at,
      renewal_count: Number(subscription.renewal_count) + 1,
      /* The reasons the previous period ended no longer apply to the new one. */
      grace_period_ends_at: null,
      expiry_notified_at: null,
      expired_at: null,
      ends_at: null,
    };

    if (targetPlan) {
      columns.plan_id = targetPlan.id;
      columns.scheduled_plan_id = null;
      columns.scheduled_plan_price_id = null;
      columns.scheduled_change_type = null;
      columns.scheduled_change_timing = null;
      columns.scheduled_change_at = null;

      if (price) {
        Object.assign(columns, pricingColumns(price, subscription.quantity));
        /* `pricingColumns` re-derives the period length, so the boundaries are re-stated after it. */
        columns.current_period_end = periodEnd;
        columns.next_renewal_at = periodEnd;
      }
    }

    await subscription.update(columns, { transaction });

    if (targetPlan) {
      await db.SubscriptionItem.update(
        {
          plan_id: targetPlan.id,
          description: `${targetPlan.name} — ${cycle}`.slice(0, 255),
          amount: newCycleAmount,
          period_start: periodStart,
          period_end: periodEnd,
        },
        { where: { subscription_id: subscription.id, item_type: 'plan' }, transaction }
      );

      await recordHistory(
        {
          subscription_id: subscription.id,
          school_id: subscription.school_id,
          event: EVENTS.DOWNGRADED,
          from_state: previousState,
          to_state: STATES.ACTIVE,
          from_plan_id: before.plan_id,
          to_plan_id: targetPlan.id,
          new_amount: newCycleAmount,
          effective_at: periodStart,
          notes: 'Scheduled downgrade applied at the start of the new billing cycle (SRS §12.4)',
          performed_by: performerOf(req),
        },
        transaction
      );
    } else {
      /* The plan line's period follows the subscription's even when the plan did not change. */
      await db.SubscriptionItem.update(
        { period_start: periodStart, period_end: periodEnd },
        { where: { subscription_id: subscription.id, item_type: 'plan' }, transaction }
      );
    }

    await recordHistory(
      {
        subscription_id: subscription.id,
        school_id: subscription.school_id,
        event: EVENTS.RENEWED,
        from_state: previousState,
        to_state: STATES.ACTIVE,
        from_plan_id: before.plan_id,
        to_plan_id: subscription.plan_id,
        new_amount: money.round(subscription.cycle_amount),
        effective_at: periodStart,
        notes: options.reason || null,
        performed_by: performerOf(req),
        metadata: {
          mode: options.mode || subscription.renewal_mode,
          renewalCount: Number(subscription.renewal_count),
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd ? periodEnd.toISOString() : null,
        },
      },
      transaction
    );

    schoolState = await syncSchoolState(subscription.school_id, transaction);
  });

  await recordAudit(req, {
    tableName: 'subscriptions',
    recordId: subscription.id,
    event: 'update',
    before,
    after: snapshot(subscription),
    reason: options.reason || null,
    /* Renewed by the sweep there is no request; the row still belongs to this school. */
    ...(req ? {} : { schoolId: subscription.school_id, organizationId: subscription.organization_id }),
  });

  await afterWrite(subscription.school_id, { tenant: schoolState.changed });

  return {
    subscription: await findById(tenant, subscription.id),
    renewal: {
      mode: options.mode || subscription.renewal_mode,
      previousState,
      periodStart,
      periodEnd,
      renewalCount: Number(subscription.renewal_count),
      appliedScheduledChange: Boolean(targetPlan),
      toPlan: targetPlan ? { id: targetPlan.id, name: targetPlan.name } : null,
    },
  };
}

/* ────────── §11.3 / FR-SUB-009 — add-ons purchased onto a subscription ────────── */

/**
 * Purchase an add-on — the third of this module's four obligations, and the one with no other
 * safety net.
 *
 * `subscription_addons` copies four things at purchase: `unit_amount` and `currency` from the price
 * row, and `effect_type` / `effect_target` / `units_granted` from the add-on. The model's own
 * comment on the middle pair reads *"Resolved effect, copied at purchase so a later add-on edit
 * cannot change entitlement"*, and `verify-addons.js` asserts exactly that — an add-on whose
 * `units_per_quantity` is edited from 1 to 50 leaves an existing purchase's grant untouched.
 *
 * **`units_granted = quantity × addons.units_per_quantity`, computed here and nowhere else.**
 * `entitlementService.js` is explicit: *"`quantity × units_per_quantity` is what produced it, and is
 * not multiplied again here"*. If this line were wrong or absent, `toCount(units_granted) || 0`
 * would be zero, `if (granted <= 0) continue` would skip the row, and the school would hold a
 * purchased add-on that grants nothing — with a 201, an audit row and an invoice line all saying it
 * worked. Nothing downstream would notice, which is why
 * `scripts/verify-subscriptions.js` asserts the copied numbers rather than the row's existence.
 *
 * A `feature_unlock` add-on grants no units; its `units_granted` is 0 and entitlement reads
 * `effect_target` as a feature key instead. `ADDON_EFFECTS` fixes which of the seven is which, so
 * the branch is on `effect_type` from the row and never on the key — SRS §30 Rule 1.
 *
 * ## The plan-restricted price
 *
 * `addon_prices.plan_id` means *"only offered on this plan"*. A purchase naming a price restricted
 * to a different plan is refused here, which is the enforcement point: `addons.service`'s catalogue
 * read filters prices by `is_active` alone, so a school browsing the catalogue can see a price it
 * may not buy. Refusing at purchase closes the hole that matters; the read remains a display
 * imprecision, recorded as such.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} payload
 * @returns {Promise<{subscription: object, purchase: object}>}
 */
async function purchaseAddon(req, id, payload) {
  const subscription = await findById(req.tenant, id, { detail: false });

  if (!SUBSCRIPTION_USABLE_STATES.includes(subscription.state)) {
    throw ApiError.conflict(
      `Add-ons cannot be purchased onto a ${subscription.state} subscription.`,
      {
        code: 'SUBSCRIPTION_NOT_PURCHASABLE',
        details: { subscriptionId: subscription.id, state: subscription.state },
      }
    );
  }

  const addon = await db.Addon.findByPk(payload.addon_id);
  if (!addon) throw ApiError.notFound('Add-on not found', { code: 'ADDON_NOT_FOUND' });

  if (!addon.is_active) {
    throw ApiError.conflict(`Add-on "${addon.name}" is not currently on sale (FR-SUB-009).`, {
      code: 'ADDON_NOT_AVAILABLE',
      details: { addonId: addon.id, key: addon.key },
    });
  }

  let price = null;
  if (payload.addon_price_id) {
    price = await db.AddonPrice.findOne({
      where: { id: payload.addon_price_id, addon_id: addon.id },
    });
    if (!price) {
      throw ApiError.validation('The chosen price does not belong to this add-on', [
        {
          field: 'addon_price_id',
          message: `addon_prices row ${payload.addon_price_id} is not a price of add-on ${addon.key}`,
        },
      ]);
    }
    if (!price.is_active) {
      throw ApiError.conflict('That add-on price has been withdrawn.', {
        code: 'ADDON_PRICE_INACTIVE',
        details: { addonPriceId: price.id },
      });
    }
    if (price.plan_id && Number(price.plan_id) !== Number(subscription.plan_id)) {
      throw ApiError.conflict(
        'That add-on price is restricted to a different plan (addon_prices.plan_id).',
        {
          code: 'ADDON_PRICE_PLAN_MISMATCH',
          details: {
            addonPriceId: price.id,
            restrictedToPlanId: Number(price.plan_id),
            subscriptionPlanId: Number(subscription.plan_id),
          },
        }
      );
    }
    /*
     * An add-on is billed once per subscription period, in the subscription's currency: its item's
     * amount goes onto an invoice `generateForSubscription()` stamps with the subscription's currency,
     * and nothing reads the price's own cycle. So a monthly price on a yearly subscription billed its
     * monthly figure once a year, a EUR price billed as USD, and a one-time price recurred. Refused
     * rather than mis-billed — found by the audit of the add-ons panel.
     */
    const cycleMismatch =
      price.billing_cycle !== subscription.billing_cycle ||
      (price.billing_cycle === BILLING_CYCLES.CUSTOM_DAYS &&
        Number(price.cycle_days) !== Number(subscription.cycle_days));
    const currencyMismatch = Boolean(price.currency && subscription.currency && price.currency !== subscription.currency);
    if (cycleMismatch || currencyMismatch) {
      throw ApiError.conflict(
        `That add-on price bills ${price.currency} ${price.billing_cycle}, and this subscription is billed ${subscription.currency} ${subscription.billing_cycle}. Choose a price on the subscription's own cycle and currency.`,
        {
          code: 'ADDON_PRICE_CYCLE_MISMATCH',
          details: {
            addonPriceId: price.id,
            price: { billingCycle: price.billing_cycle, cycleDays: price.cycle_days, currency: price.currency },
            subscription: {
              billingCycle: subscription.billing_cycle,
              cycleDays: subscription.cycle_days,
              currency: subscription.currency,
            },
          },
        }
      );
    }
  }

  const quantity = payload.quantity || 1;

  /*
   * The purchase copy. `units_per_quantity` is a BIGINT, so it arrives as a string on some drivers
   * — `Number()` before the multiplication, not after.
   */
  const unitsPerQuantity = Number(addon.units_per_quantity || 0);
  const unitsGranted =
    addon.effect_type === 'limit_increase' ? quantity * unitsPerQuantity : 0;

  const unitAmount = price ? money.round(price.unit_amount) : 0;
  const currency = price ? price.currency : subscription.currency;

  let purchase;
  let existingItem;

  await db.sequelize.transaction(async (transaction) => {
    purchase = await db.SubscriptionAddon.create(
      {
        subscription_id: subscription.id,
        school_id: subscription.school_id,
        addon_id: addon.id,
        addon_price_id: price ? price.id : null,
        quantity,
        unit_amount: unitAmount,
        currency,
        /* ── the four copied columns ── */
        effect_type: addon.effect_type,
        effect_target: addon.effect_target,
        units_granted: unitsGranted,
        status: 'active',
        starts_at: payload.starts_at ? new Date(payload.starts_at) : new Date(),
        ends_at: payload.ends_at ? new Date(payload.ends_at) : null,
        is_recurring: payload.is_recurring !== undefined ? payload.is_recurring : true,
      },
      { transaction }
    );

    existingItem = await db.SubscriptionItem.create(
      {
        subscription_id: subscription.id,
        school_id: subscription.school_id,
        item_type: 'addon',
        plan_id: null,
        addon_id: addon.id,
        description: `${addon.name} × ${quantity}`.slice(0, 255),
        quantity,
        unit_amount: unitAmount,
        amount: money.multiply(unitAmount, quantity),
        currency,
        period_start: purchase.starts_at,
        period_end: purchase.ends_at,
        is_recurring: purchase.is_recurring,
        /* Which purchase this line bills, so cancelling one purchase closes this line and no other. */
        metadata: { subscription_addon_id: purchase.id },
      },
      { transaction }
    );

    await recordHistory(
      {
        subscription_id: subscription.id,
        school_id: subscription.school_id,
        event: EVENTS.ADDON_ADDED,
        from_state: subscription.state,
        to_state: subscription.state,
        from_plan_id: subscription.plan_id,
        to_plan_id: subscription.plan_id,
        new_amount: money.multiply(unitAmount, quantity),
        effective_at: purchase.starts_at,
        notes: payload.reason || `${addon.name} × ${quantity}`,
        performed_by: performerOf(req),
        metadata: {
          addonKey: addon.key,
          quantity,
          effectType: addon.effect_type,
          effectTarget: addon.effect_target,
          unitsPerQuantity,
          unitsGranted,
        },
      },
      transaction
    );
  });

  await recordAudit(req, {
    tableName: 'subscription_addons',
    recordId: purchase.id,
    event: 'create',
    after: snapshot(purchase),
    reason: payload.reason || null,
  });

  /* `subscription_addons` is one of the three tables resolution reads — obligation 1. */
  await afterWrite(subscription.school_id, { tenant: false });

  return {
    subscription: await findById(req.tenant, subscription.id),
    purchase: {
      id: purchase.id,
      addon: { id: addon.id, key: addon.key, name: addon.name },
      quantity,
      effectType: addon.effect_type,
      effectTarget: addon.effect_target,
      unitsPerQuantity,
      unitsGranted,
      unitAmount,
      currency,
      itemId: existingItem.id,
    },
  };
}

/**
 * Withdraw a purchased add-on.
 *
 * `status = 'cancelled'`, not a delete. Two reasons, and either alone would be enough:
 * `subscription_addons.addon_id` is `ON DELETE RESTRICT` from the other side, and the row is what
 * §13's invoice line was raised against. `entitlementService` only reads `status = 'active'` rows,
 * so the grant stops at once without the record going anywhere.
 *
 * The matching `subscription_items` line stops recurring and its period is closed at the
 * cancellation date rather than being removed — the same reasoning, from the billing side.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {number|string} purchaseId  `subscription_addons.id`, not `addons.id`
 * @param {string} [reason]
 * @returns {Promise<{subscription: object, purchase: object}>}
 */
async function cancelAddon(req, id, purchaseId, reason) {
  const subscription = await findById(req.tenant, id, { detail: false });

  const purchase = await db.SubscriptionAddon.findOne({
    where: { id: purchaseId, subscription_id: subscription.id },
    include: [{ model: db.Addon, as: 'addon' }],
  });
  if (!purchase) {
    throw ApiError.notFound('This subscription has no such add-on purchase', {
      code: 'SUBSCRIPTION_ADDON_NOT_FOUND',
    });
  }

  if (purchase.status !== 'active') {
    throw ApiError.conflict(`This add-on purchase is already ${purchase.status}.`, {
      code: 'SUBSCRIPTION_ADDON_NOT_ACTIVE',
      details: { subscriptionAddonId: purchase.id, status: purchase.status },
    });
  }

  const at = new Date();
  const before = snapshot(purchase);

  await db.sequelize.transaction(async (transaction) => {
    await purchase.update({ status: 'cancelled', ends_at: at, is_recurring: false }, { transaction });

    /*
     * Close the line that bills **this** purchase, and only it. This used to close every add-on line
     * with the same `addon_id`, so a school holding two purchases of one add-on that cancelled one kept
     * the other's units and was never invoiced for them again. A line carries the purchase it bills in
     * `metadata.subscription_addon_id`; a line written before that tag existed is matched as the one
     * still-recurring line for the add-on with no tag, oldest first.
     */
    const lines = await db.SubscriptionItem.findAll({
      where: { subscription_id: subscription.id, item_type: 'addon', addon_id: purchase.addon_id, is_recurring: true },
      order: [['id', 'ASC']],
      transaction,
    });
    const tagged = lines.find((line) => line.metadata && Number(line.metadata.subscription_addon_id) === Number(purchase.id));
    const line = tagged || lines.find((row) => !row.metadata || row.metadata.subscription_addon_id === undefined);
    if (line) await line.update({ is_recurring: false, period_end: at }, { transaction });

    await recordHistory(
      {
        subscription_id: subscription.id,
        school_id: subscription.school_id,
        event: EVENTS.ADDON_REMOVED,
        from_state: subscription.state,
        to_state: subscription.state,
        from_plan_id: subscription.plan_id,
        to_plan_id: subscription.plan_id,
        effective_at: at,
        notes: reason || (purchase.addon ? purchase.addon.name : null),
        performed_by: performerOf(req),
        metadata: {
          addonKey: purchase.addon ? purchase.addon.key : null,
          quantity: purchase.quantity,
          unitsWithdrawn: Number(purchase.units_granted || 0),
        },
      },
      transaction
    );
  });

  await recordAudit(req, {
    tableName: 'subscription_addons',
    recordId: purchase.id,
    event: 'update',
    before,
    after: snapshot(purchase),
    reason: reason || null,
  });

  await afterWrite(subscription.school_id, { tenant: false });

  return {
    subscription: await findById(req.tenant, subscription.id),
    purchase: {
      id: purchase.id,
      status: purchase.status,
      addon: purchase.addon ? { id: purchase.addon.id, key: purchase.addon.key } : null,
      unitsWithdrawn: Number(purchase.units_granted || 0),
    },
  };
}

/* ────── §33 — Feature Overrides, Custom Limits, Custom Pricing ────── */

/**
 * Apply a per-subscription override — SRS §33's *"Custom Limits"*, *"Feature Overrides"* and
 * *"Custom Pricing"*.
 *
 * The highest-precedence source in `entitlementService`'s resolution chain, above add-ons and above
 * the plan. Its header states the interaction that is easy to get wrong: a limit override replaces
 * the *plan's* value, not the add-on units bought on top of it — `base = override ?? plan`, then
 * `total = base + addonUnits`. So an override does not silently confiscate something the school paid
 * for, and this function does not need to reconcile the two.
 *
 * `subscription_overrides_unique` is a unique index over
 * `[subscription_id, override_type, target_key]`, so re-applying an override to the same target
 * updates the existing row rather than colliding. That is the right behaviour for a negotiated
 * limit — an operator raising a custom ceiling twice means the second number — and it is why the
 * unique constraint is caught here instead of being reported as a 409 the caller cannot act on.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} payload
 * @returns {Promise<{subscription: object, override: object, created: boolean}>}
 */
async function createOverride(req, id, payload) {
  const subscription = await findById(req.tenant, id, { detail: false });

  const columns = {
    subscription_id: subscription.id,
    school_id: subscription.school_id,
    override_type: payload.override_type,
    target_key: payload.target_key,
    is_enabled: payload.is_enabled !== undefined ? payload.is_enabled : null,
    limit_type: payload.limit_type || null,
    limit_value:
      payload.limit_type === LIMIT_TYPES.FIXED && payload.limit_value !== undefined
        ? payload.limit_value
        : null,
    amount: payload.amount !== undefined ? money.round(payload.amount) : null,
    reason: payload.reason || null,
    effective_from: payload.effective_from ? new Date(payload.effective_from) : null,
    effective_until: payload.effective_until ? new Date(payload.effective_until) : null,
    is_active: true,
    created_by: performerOf(req),
  };

  const existing = await db.SubscriptionOverride.findOne({
    where: {
      subscription_id: subscription.id,
      override_type: columns.override_type,
      target_key: columns.target_key,
    },
  });

  const before = existing ? snapshot(existing) : null;
  let override;

  await db.sequelize.transaction(async (transaction) => {
    if (existing) {
      await existing.update(columns, { transaction });
      override = existing;
    } else {
      override = await db.SubscriptionOverride.create(columns, { transaction });
    }

    await recordHistory(
      {
        subscription_id: subscription.id,
        school_id: subscription.school_id,
        event: EVENTS.OVERRIDE_APPLIED,
        from_state: subscription.state,
        to_state: subscription.state,
        from_plan_id: subscription.plan_id,
        to_plan_id: subscription.plan_id,
        new_amount: columns.amount,
        effective_at: columns.effective_from || new Date(),
        notes: payload.reason || `${columns.override_type}:${columns.target_key}`,
        performed_by: performerOf(req),
        metadata: {
          overrideType: columns.override_type,
          targetKey: columns.target_key,
          isEnabled: columns.is_enabled,
          limitType: columns.limit_type,
          limitValue: columns.limit_value,
          replaced: Boolean(existing),
        },
      },
      transaction
    );
  });

  await recordAudit(req, {
    tableName: 'subscription_overrides',
    recordId: override.id,
    event: existing ? 'update' : 'create',
    before: before || undefined,
    after: snapshot(override),
    reason: payload.reason || null,
  });

  await afterWrite(subscription.school_id, { tenant: false });

  return {
    subscription: await findById(req.tenant, subscription.id),
    override,
    created: !existing,
  };
}

/**
 * Revoke an override.
 *
 * `is_active = false`, not a delete: the row is the record of a negotiated arrangement and the
 * column exists so revoking one leaves evidence it was ever in force.
 * `entitlementService.resolve()` reads `is_active: true` only, so the plan's own value takes over on
 * the next request.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {number|string} overrideId
 * @param {string} [reason]
 * @returns {Promise<{subscription: object, override: object}>}
 */
async function revokeOverride(req, id, overrideId, reason) {
  const subscription = await findById(req.tenant, id, { detail: false });

  const override = await db.SubscriptionOverride.findOne({
    where: { id: overrideId, subscription_id: subscription.id },
  });
  if (!override) {
    throw ApiError.notFound('This subscription has no such override', {
      code: 'SUBSCRIPTION_OVERRIDE_NOT_FOUND',
    });
  }

  if (!override.is_active) {
    throw ApiError.conflict('This override has already been revoked.', {
      code: 'SUBSCRIPTION_OVERRIDE_INACTIVE',
      details: { overrideId: override.id },
    });
  }

  const before = snapshot(override);

  await db.sequelize.transaction(async (transaction) => {
    await override.update({ is_active: false, effective_until: new Date() }, { transaction });
  });

  await recordAudit(req, {
    tableName: 'subscription_overrides',
    recordId: override.id,
    event: 'update',
    before,
    after: snapshot(override),
    reason: reason || null,
  });

  await afterWrite(subscription.school_id, { tenant: false });

  return { subscription: await findById(req.tenant, subscription.id), override };
}

/* ─────────── FR-SUB-010 / FR-SUB-015 — the date-driven transitions ─────────── */

/**
 * Move every subscription the calendar has moved — the "System" half of FR-SUB-010's actor line.
 *
 * **Has no route, by design.** See the file header: the trigger is the Phase 5 cron
 * (`package.json` already declares `"cron": "node src/jobs/cron.js"`), `src/jobs/` does not exist
 * yet, and inventing a `POST /run-renewals` to make it reachable would be inventing a requirement.
 * The behaviour is complete and `scripts/verify-subscriptions.js` drives it directly.
 *
 * ## The five passes, in the order they must run
 *
 *  1. **Trial ended** (`trial`, `trial_ends_at ≤ now`). FR-SUB-011 fixes the duration but not what
 *     happens at the end of it, and §13's Payments do not exist yet — so this is an
 *     **interpretation**, and the conservative one: an unpaid trial becomes **Past Due**, which
 *     pass 3 then takes into Grace Period. Past Due is a usable state, so the school is not cut off
 *     by the interpretation; it is flagged. When §13 lands, a paid trial will transition through
 *     `activate` instead and this pass will only catch the unpaid ones.
 *  2. **Automatic renewal** (`active`/`expiring`, period ended, `renewal_mode = automatic`) —
 *     FR-SUB-015's *"initiated by the system at cycle end"*. Runs **before** the past-due pass, so a
 *     subscription that renews is never briefly marked past due.
 *  3. **Period ended without renewal** (`active`/`expiring`/`trial`-derived past due) → **Past Due**
 *     with `grace_period_ends_at` set, then **Grace Period** if a grace period is configured. This
 *     is FR-SUB-012 read literally: the grace period is *"applied after a subscription becomes past
 *     due or expires"* and the subscription *"enters a Grace Period of the configured duration
 *     before further state transition"*. A `grace_period_days` of 0 means no grace was configured,
 *     so the subscription goes straight to Expired in pass 4.
 *  4. **Grace period ended** (`grace_period`, `grace_period_ends_at ≤ now`) → **Expired**, which is
 *     FR-SUB-012's own *"(e.g., to Expired/Suspended)"*.
 *  5. **Expiring notice** (`active`, period ends inside the window) → **Expiring**. Last, because it
 *     is the only pass that does not change what the school may do — `expiring` is one of
 *     `SUBSCRIPTION_USABLE_STATES` — and running it earlier would relabel rows the other passes
 *     were about to move.
 *
 * Every pass writes its `subscription_history` row, refreshes `schools.subscription_state` and
 * invalidates both caches, through the same helpers the request paths use. A subscription that
 * throws is logged and skipped rather than aborting the sweep: one bad row must not stop the
 * platform's renewals.
 *
 * @param {object} [options]
 * @param {Date} [options.at]  the moment to evaluate against; injectable so a suite can test dates
 * @param {number} [options.expiringWindowDays]
 * @param {number} [options.limit]  rows per pass, so one run cannot take unbounded time
 * @returns {Promise<object>} a per-pass report
 */
async function runLifecycleSweep(options = {}) {
  const at = options.at || new Date();
  const windowDays =
    options.expiringWindowDays !== undefined ? options.expiringWindowDays : EXPIRING_WINDOW_DAYS;
  const limit = options.limit || 500;

  /* The sweep is the platform acting, so it reads across tenants — there is no request to scope. */
  const platform = { isPlatform: true, schoolId: null, organizationId: null };

  const report = {
    at: at.toISOString(),
    trialEnded: 0,
    renewed: 0,
    pastDue: 0,
    graceStarted: 0,
    expired: 0,
    expiring: 0,
    failed: [],
  };

  /**
   * Apply a state change with the same history / cache discipline the request paths use.
   *
   * A local helper rather than `transition()`, because these edges are not in `TRANSITIONS` — that
   * table is the six *administrative* actions, and mixing the billing ones into it would let a
   * route reach them. The bookkeeping is shared; the edge list is not.
   */
  async function applyState(subscription, { state, columns, event, notes }) {
    const previousState = subscription.state;
    const before = snapshot(subscription);
    let schoolState;

    await db.sequelize.transaction(async (transaction) => {
      await subscription.update({ state, ...columns }, { transaction });

      await recordHistory(
        {
          subscription_id: subscription.id,
          school_id: subscription.school_id,
          event,
          from_state: previousState,
          to_state: state,
          from_plan_id: subscription.plan_id,
          to_plan_id: subscription.plan_id,
          new_amount: money.round(subscription.cycle_amount),
          effective_at: at,
          notes: notes || null,
          /* No request and no user: this is the system acting. */
          performed_by: null,
          metadata: { sweep: true, evaluatedAt: at.toISOString() },
        },
        transaction
      );

      schoolState = await syncSchoolState(subscription.school_id, transaction);
    });

    await recordAudit(null, {
      tableName: 'subscriptions',
      recordId: subscription.id,
      event: 'update',
      before,
      after: snapshot(subscription),
      reason: notes || null,
      /* No request to take the tenant from; the row still belongs to this school. */
      schoolId: subscription.school_id,
      organizationId: subscription.organization_id,
    });

    await afterWrite(subscription.school_id, { tenant: schoolState.changed });
  }

  /** Run one pass, isolating a failure to the row that caused it. */
  async function pass(name, rows, handler) {
    for (const row of rows) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await handler(row);
      } catch (err) {
        report.failed.push({ pass: name, subscriptionId: Number(row.id), error: err.message });
        logger.error('Lifecycle sweep could not process a subscription', {
          pass: name,
          subscriptionId: Number(row.id),
          error: err.message,
        });
      }
    }
  }

  /* ── 1. trials that have run out ── */
  const endedTrials = await db.Subscription.findAll({
    where: {
      state: STATES.TRIAL,
      trial_ends_at: { [Op.ne]: null, [Op.lte]: at },
    },
    order: [['id', 'ASC']],
    limit,
  });

  await pass('trialEnded', endedTrials, async (subscription) => {
    const graceDays = Number(subscription.grace_period_days);

    await applyState(subscription, {
      state: STATES.PAST_DUE,
      columns: {
        grace_period_ends_at: graceDays > 0 ? dates.addDays(at, graceDays) : null,
      },
      event: EVENTS.TRIAL_ENDED,
      notes: 'Trial ended without activation (SRS §12.1)',
    });
    report.trialEnded += 1;

    /*
     * FR-SUB-012 applies to **both** ways a subscription lapses, and this pass used to skip it.
     *
     * The requirement covers "after a subscription becomes past due **or expires**", and its Expected
     * Outcome is that the subscription *enters a Grace Period* before any further transition. Pass 3
     * (period lapsed) does exactly that — `applyState(PAST_DUE)` and then `applyState(GRACE_PERIOD)`.
     * This pass wrote `grace_period_ends_at` and stopped: the **date** was set and the **state** never
     * was, so a trial that ran out sat in `past_due` with a grace deadline nothing had entered.
     *
     * It hid because `past_due` and `grace_period` are both in `SUBSCRIPTION_USABLE_STATES`, so
     * access was unaffected either way; what differed was the state a report or a screen reads, and
     * the missing `GRACE_PERIOD_STARTED` row in the history §12 asks for.
     */
    if (graceDays > 0) {
      await applyState(subscription, {
        state: STATES.GRACE_PERIOD,
        columns: {},
        event: EVENTS.GRACE_PERIOD_STARTED,
        notes: `${graceDays}-day grace period after trial (SRS §12.2)`,
      });
      report.graceStarted += 1;
    }
  });

  /* ── 2. automatic renewal at cycle end — FR-SUB-015 ── */
  const dueForRenewal = await db.Subscription.findAll({
    where: {
      state: { [Op.in]: [STATES.ACTIVE, STATES.EXPIRING] },
      renewal_mode: RENEWAL_MODES.AUTOMATIC,
      billing_cycle: { [Op.ne]: BILLING_CYCLES.ONE_TIME },
      current_period_end: { [Op.ne]: null, [Op.lte]: at },
    },
    order: [['id', 'ASC']],
    limit,
  });

  await pass('renewed', dueForRenewal, async (subscription) => {
    await renew(null, subscription.id, {
      at,
      tenant: platform,
      mode: RENEWAL_MODES.AUTOMATIC,
      reason: 'Automatic renewal at cycle end (SRS §12.5, FR-SUB-015)',
    });
    report.renewed += 1;
  });

  /* ── 3. period ended and nothing renewed it ── */
  const lapsed = await db.Subscription.findAll({
    where: {
      state: { [Op.in]: [STATES.ACTIVE, STATES.EXPIRING] },
      current_period_end: { [Op.ne]: null, [Op.lte]: at },
    },
    order: [['id', 'ASC']],
    limit,
  });

  await pass('pastDue', lapsed, async (subscription) => {
    const graceDays = Number(subscription.grace_period_days);

    await applyState(subscription, {
      state: STATES.PAST_DUE,
      columns: {
        grace_period_ends_at: graceDays > 0 ? dates.addDays(at, graceDays) : null,
      },
      event: EVENTS.PAST_DUE,
      notes: 'Billing period ended without renewal (FR-SUB-015)',
    });
    report.pastDue += 1;

    /*
     * FR-SUB-012 — *"Subscription enters a Grace Period of the configured duration before further
     * state transition"*. Two history rows rather than one, because becoming past due and entering
     * grace are two events and §12 lists them as two states.
     */
    if (graceDays > 0) {
      await applyState(subscription, {
        state: STATES.GRACE_PERIOD,
        columns: {},
        event: EVENTS.GRACE_PERIOD_STARTED,
        notes: `${graceDays}-day grace period (SRS §12.2)`,
      });
      report.graceStarted += 1;
    }
  });

  /* ── 4. grace period over, and past-due rows that never had one ── */
  const expiring = await db.Subscription.findAll({
    where: {
      [Op.or]: [
        { state: STATES.GRACE_PERIOD, grace_period_ends_at: { [Op.ne]: null, [Op.lte]: at } },
        { state: STATES.PAST_DUE, grace_period_ends_at: null },
        { state: STATES.PAST_DUE, grace_period_ends_at: { [Op.lte]: at } },
      ],
    },
    order: [['id', 'ASC']],
    limit,
  });

  await pass('expired', expiring, async (subscription) => {
    await applyState(subscription, {
      state: STATES.EXPIRED,
      columns: { expired_at: at, ends_at: at, next_renewal_at: null },
      event: EVENTS.EXPIRED,
      notes:
        Number(subscription.grace_period_days) > 0
          ? 'Grace period ended (SRS §12.2, FR-SUB-012)'
          : 'Past due with no grace period configured (FR-SUB-012)',
    });
    report.expired += 1;
  });

  /* ── 5. the expiry notice — no change to entitlement ── */
  if (windowDays > 0) {
    const approaching = await db.Subscription.findAll({
      where: {
        state: STATES.ACTIVE,
        current_period_end: {
          [Op.ne]: null,
          [Op.gt]: at,
          [Op.lte]: dates.addDays(at, windowDays),
        },
      },
      order: [['id', 'ASC']],
      limit,
    });

    await pass('expiring', approaching, async (subscription) => {
      await applyState(subscription, {
        state: STATES.EXPIRING,
        /*
         * `expiry_notified_at` is deliberately NOT stamped here, and this pass used to stamp it.
         *
         * §29 says what the column is for: *"Marker used by the expiry-notice cron so a school is
         * warned exactly once per cycle."* It belongs to the cron that sends the notice, not to the
         * pass that decides a subscription is expiring. Stamping it here meant §23's Subscription
         * Expiry sweep — which selects `state = 'expiring' AND expiry_notified_at IS NULL` — could
         * never see a subscription this pass had just marked, so that notification never fired for
         * any subscription reaching `expiring` the normal way.
         *
         * "Once per cycle" still holds, and holds better: `renew()` clears this column at line ~1648
         * because *"the reasons the previous period ended no longer apply to the new one"*, so each
         * new cycle re-arms exactly one notice.
         *
         * Found by `scripts/verify-jobs.js`, which is the first thing to run both sweeps in one
         * ordered pass. Neither module's own suite could see it: §23's fixture planted
         * `expiring` + `expiry_notified_at: null` directly — a combination this pass never produces.
         */
        event: EVENTS.STATE_CHANGED,
        notes: `Billing period ends within ${windowDays} day(s)`,
      });
      report.expiring += 1;
    });
  }

  return report;
}

/* ─────────────────────────────── derived views ─────────────────────────────── */

/**
 * Whether an override is in force right now.
 *
 * The same window `entitlementService.activeWindow()` applies, computed for presentation so a screen
 * showing a subscription's overrides does not have to re-derive it — and so the two cannot disagree
 * about a row the school is looking at.
 *
 * @param {object} override
 * @param {Date} [at]
 * @returns {boolean}
 */
function isEffective(override, at = new Date()) {
  if (!override.is_active) return false;
  if (override.effective_from && new Date(override.effective_from) > at) return false;
  if (override.effective_until && new Date(override.effective_until) < at) return false;
  return true;
}

/**
 * What a subscription's standing is, derived and never stored.
 *
 * Everything here is a function of columns the caller already has; it exists so that the several
 * screens which need "how many days left" all get the same answer. `state` is *not* recomputed —
 * `entitlementService`'s header explains why two components deriving the same state from dates is
 * how they come to disagree — so this reports what the stored state implies, not what the dates do.
 *
 * @param {object} subscription  loaded with `detailInclude()`
 * @returns {object}
 */
function standing(subscription) {
  const at = new Date();
  const addons = subscription.addons || [];
  const overrides = subscription.overrides || [];

  return {
    isUsable: SUBSCRIPTION_USABLE_STATES.includes(subscription.state),
    isOpen: OPEN_STATES.includes(subscription.state),
    inTrial: subscription.state === STATES.TRIAL,
    daysUntilPeriodEnd: subscription.current_period_end
      ? dates.daysBetween(at, subscription.current_period_end)
      : null,
    daysUntilTrialEnd: subscription.trial_ends_at
      ? dates.daysBetween(at, subscription.trial_ends_at)
      : null,
    daysUntilGraceEnd: subscription.grace_period_ends_at
      ? dates.daysBetween(at, subscription.grace_period_ends_at)
      : null,
    /* One-time subscriptions have no next period, so "renewable" is false rather than overdue. */
    isRecurring: subscription.billing_cycle !== BILLING_CYCLES.ONE_TIME,
    hasScheduledChange: Boolean(subscription.scheduled_plan_id),
    activeAddonCount: addons.filter((row) => row.status === 'active').length,
    effectiveOverrideCount: overrides.filter((row) => isEffective(row, at)).length,
    creditBalance: money.round(subscription.credit_balance),
    /* The unit each limit-increase add-on grants in, so a screen can label the numbers. */
    grantedUnits: addons
      .filter((row) => row.status === 'active' && row.effect_type === 'limit_increase')
      .reduce((totals, row) => {
        const key = row.effect_target;
        const units = Number(row.units_granted || 0);
        return {
          ...totals,
          [key]: {
            units: (totals[key] ? totals[key].units : 0) + units,
            unit: LIMIT_UNITS[key] || null,
          },
        };
      }, {}),
  };
}

module.exports = {
  /* reads */
  list,
  findById,
  history,
  catalogue,
  detailInclude,

  /* pricing */
  selectPrice,
  computeCycleAmount,
  pricingColumns,

  /* FR-SUB-010 … FR-SUB-015 */
  create,
  update,
  transition,
  changePlan,
  renew,
  prorate,

  /* §11.3 add-ons and §33 overrides */
  purchaseAddon,
  cancelAddon,
  createOverride,
  revokeOverride,

  /* the system half of FR-SUB-010 / FR-SUB-015 — no route, see the header */
  runLifecycleSweep,
  governingStateFor,
  syncSchoolState,

  /* derived */
  standing,
  isEffective,

  TRANSITIONS,
  OPEN_STATES,
  EXPIRING_WINDOW_DAYS,
  SORTABLE,
};
