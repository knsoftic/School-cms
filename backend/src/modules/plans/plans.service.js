'use strict';

/**
 * Plan data access — SRS §10.2, §10.3, §10.4, §11.1, §11.2; FR-SUB-001 … FR-SUB-007.
 *
 * ## `subscription_plans` is a platform table, so `tenantWhere()` has nothing to write
 *
 * A plan carries neither `school_id` nor `organization_id`: the same row is offered to every school on
 * the platform, which is what makes it a catalogue. `tenantWhere()`'s school-first precedence would have
 * no column to narrow, so — as in `roles.service.js` — the confinement is stated explicitly in
 * `scopeFor()` instead, and the routes carry `requirePlatformScope()` on every write.
 *
 * `scopeFor()` is not a no-op for non-platform callers, though. SRS §10.2 gives a plan a
 * **Public / Private** field and FR-SUB-004 makes `status` control *"whether it is available for new
 * subscriptions"*. Neither term is defined further, and the narrowest honest reading of both is that a
 * caller who is not the Super Admin may see the active, public plans and nothing else. That is what
 * makes it safe to grant `plans.view` to a school role later — a Principal comparing upgrade targets
 * under §12.3 — without exposing a private, bespoke plan negotiated with another school.
 *
 * ## Invalidation is not optional
 *
 * `entitlementService` caches a resolved snapshot per school and reads plan `id`, `code`, `name` and
 * `tier_rank` into it alongside the plan's modules, features and limits. Every write in this file
 * therefore ends with `entitlementService.invalidatePlan()`. A missed call would leave every school on
 * the plan resolving against the previous configuration until a TTL lapsed, which for a limit change is
 * the difference between a ceiling that is enforced and one that is merely recorded.
 *
 * ## What is deliberately absent: `DELETE /plans/:id`
 *
 * FR-SUB-005 is the source's removal operation, and it is explicit about the semantics — an archived
 * plan is *"retained for historical reference but not offered for new subscriptions"*. A delete would
 * contradict the first half. It would also fail: `subscriptions.plan_id` is `RESTRICT`, so the row
 * cannot leave while any school has ever subscribed to it, and a soft delete would hide the plan from
 * `Subscription.include(plan)` and leave live subscriptions describing a plan nothing can read.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const entitlementService = require('../../services/entitlementService');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const {
  PLAN_STATUS,
  PLAN_VISIBILITY,
  BILLING_CYCLE_LIST,
  BILLING_CYCLE_DAYS,
  PRICING_MODEL_LIST,
  MODULE_LIST,
  MODULE_LABELS,
  LIMIT_LIST,
  LIMIT_LABELS,
  LIMIT_TYPES,
  LIMIT_UNITS,
  ADDON_LIST,
  ADDON_EFFECTS,
  RENEWAL_MODES,
  TRIAL_DURATION_DAYS,
  GRACE_PERIOD_DAYS,
} = require('../../config/constants');

const SORTABLE = Object.freeze([
  'id',
  'name',
  'code',
  'status',
  'visibility',
  'display_order',
  'tier_rank',
  'created_at',
  'updated_at',
]);

/** A catalogue is read in the order its author arranged it — SRS §10.2's "Display Order" field. */
const DEFAULT_SORT = Object.freeze(['display_order', 'ASC']);

/**
 * The four configuration collections, in the order the Plan Builder presents them.
 *
 * Ordered inside each include as well, so two reads of the same plan return the same JSON and a
 * client diffing them sees no change where there is none.
 */
const DETAIL_INCLUDE = Object.freeze([
  {
    model: db.PlanPrice,
    as: 'prices',
    separate: true,
    order: [
      ['display_order', 'ASC'],
      ['id', 'ASC'],
    ],
  },
  {
    model: db.PlanModule,
    as: 'modules',
    separate: true,
    order: [['module_key', 'ASC']],
  },
  {
    model: db.PlanFeature,
    as: 'features',
    separate: true,
    order: [
      ['display_order', 'ASC'],
      ['feature_key', 'ASC'],
    ],
  },
  {
    model: db.PlanLimit,
    as: 'limits',
    separate: true,
    order: [['limit_key', 'ASC']],
  },
]);

/**
 * The columns copied by FR-SUB-003.
 *
 * Written as explicit lists rather than by spreading `row.get()` and deleting keys: a column added to
 * one of these tables later would otherwise be copied silently, including the ones that must not be
 * (`id`, the timestamps). Naming them makes "copying the source plan's configuration" reviewable.
 */
const COPY_FIELDS = Object.freeze({
  prices: Object.freeze([
    'billing_cycle',
    'cycle_days',
    'pricing_model',
    'currency',
    'base_amount',
    'unit_amount',
    'included_units',
    'tier_min_units',
    'tier_max_units',
    'overage_unit_amount',
    'custom_amount',
    'custom_notes',
    'setup_fee',
    'is_active',
    'is_default',
    'display_order',
  ]),
  modules: Object.freeze(['module_key', 'is_enabled', 'settings']),
  features: Object.freeze(['feature_key', 'name', 'is_enabled', 'value', 'module_key', 'display_order']),
  limits: Object.freeze([
    'limit_key',
    'limit_type',
    'limit_value',
    'unit',
    'allow_overage',
    'overage_unit_amount',
  ]),
});

/** @param {object} row @param {readonly string[]} keys @returns {object} */
function pick(row, keys) {
  const out = {};
  for (const key of keys) out[key] = row[key];
  return out;
}

/**
 * Which plans this caller may see — see the file header for the Public / Private reading.
 *
 * @param {{isPlatform: boolean}} tenant
 * @returns {object} a Sequelize `where` fragment
 */
function scopeFor(tenant) {
  if (!tenant) throw new Error('plans.service: req.tenant is missing — resolveTenant did not run');
  if (tenant.isPlatform) return {};
  return { status: PLAN_STATUS.ACTIVE, visibility: PLAN_VISIBILITY.PUBLIC };
}

/**
 * A unique-index collision on `subscription_plans.code`, reported as a 409.
 *
 * The index is global, not per-organization: a plan belongs to the platform, so a code is taken for
 * everyone once it is used. The message says so, because "already exists" without a scope invites the
 * caller to retry inside a scope that does not exist.
 *
 * @param {Error} err
 * @param {object} payload
 */
function rethrow(err, payload) {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    throw ApiError.conflict('A plan with this code already exists', {
      code: 'PLAN_CODE_TAKEN',
      details: { code: payload.code },
    });
  }
  throw err;
}

/**
 * What still stands between this plan and a school being able to subscribe to it.
 *
 * Derived, never stored. FR-SUB-004 makes `status` mean *"available for new subscriptions"*, and a plan
 * can satisfy `status = active` while being impossible to subscribe to — so the screen that offers the
 * Activate button needs to know which. `unconfiguredLimits` is the one worth reading twice: an absent
 * `plan_limits` row resolves to zero in `entitlementService`, not to unlimited, so a plan missing
 * `teacher_limit` forbids teachers rather than permitting any number of them.
 *
 * @param {object} plan  a plan loaded with `DETAIL_INCLUDE`
 * @returns {object}
 */
function readiness(plan) {
  const prices = plan.prices || [];
  const activePrices = prices.filter((price) => price.is_active);
  const limits = plan.limits || [];
  const configured = new Set(limits.map((limit) => limit.limit_key));

  return {
    priceCount: prices.length,
    activePriceCount: activePrices.length,
    hasDefaultPrice: activePrices.some((price) => price.is_default),
    enabledModuleCount: (plan.modules || []).filter((row) => row.is_enabled).length,
    configuredLimitCount: limits.length,
    unconfiguredLimits: LIMIT_LIST.filter((key) => !configured.has(key)),
    /* Both halves are required: an active plan with no priceable option cannot be sold. */
    subscribable: plan.status === PLAN_STATUS.ACTIVE && activePrices.length > 0,
  };
}

/**
 * The vocabulary the Plan Builder chooses from — SRS §11.1, §11.2, §11.3, §10.3, §10.4.
 *
 * A projection of `config/constants.js`, served rather than duplicated in the frontend. SRS §30 Rule 1
 * requires plan configuration to be database-driven; the *vocabulary* is not configuration — the twenty
 * modules, eight limits and seven add-ons are fixed by the source — and a screen that hard-coded them
 * would drift from the validator that rejects anything outside them.
 *
 * @returns {object}
 */
function catalogue() {
  return {
    modules: MODULE_LIST.map((key) => ({ key, label: MODULE_LABELS[key] })),
    limits: LIMIT_LIST.map((key) => ({
      key,
      label: LIMIT_LABELS[key],
      unit: LIMIT_UNITS[key],
      types: Object.values(LIMIT_TYPES),
    })),
    addons: ADDON_LIST.map((key) => ({
      key,
      effectType: ADDON_EFFECTS[key].type,
      effectTarget: ADDON_EFFECTS[key].target,
    })),
    billingCycles: BILLING_CYCLE_LIST.map((cycle) => ({
      cycle,
      /* Null for `custom_days` (the length is per price row) and for `one_time` (there is no next period). */
      days: BILLING_CYCLE_DAYS[cycle],
    })),
    pricingModels: PRICING_MODEL_LIST.slice(),
    planStatuses: Object.values(PLAN_STATUS),
    visibilities: Object.values(PLAN_VISIBILITY),
    renewalModes: Object.values(RENEWAL_MODES),
    /* SRS §12.1 / §12.2 preset durations. Any other non-negative value is the source's "Custom". */
    trialPresetDays: TRIAL_DURATION_DAYS.slice(),
    gracePresetDays: GRACE_PERIOD_DAYS.slice(),
  };
}

/**
 * One page of plans.
 *
 * The four configuration collections are loaded here too, with `separate: true`, so the list screen can
 * show a module count without a request per row. `separate` issues one extra query per association
 * rather than a join, which is what keeps `count` equal to the number of plans — a joined `hasMany`
 * would multiply rows and `distinct: true` would then be doing load-bearing work on a page size.
 *
 * @param {object} tenant
 * @param {object} query  validated `req.query`
 * @param {{page: number, limit: number, offset: number}} pagination
 * @param {import('express').Request} req
 * @returns {Promise<{rows: object[], count: number}>}
 */
async function list(tenant, query, pagination, req) {
  const where = scopeFor(tenant);

  /*
   * A filter, not a scope. A non-platform caller is already confined to active/public plans, so a
   * request for `status=archived` must return nothing rather than widen the scope it was given.
   */
  if (query.status) {
    if (where.status && where.status !== query.status) return { rows: [], count: 0 };
    where.status = query.status;
  }
  if (query.visibility) {
    if (where.visibility && where.visibility !== query.visibility) return { rows: [], count: 0 };
    where.visibility = query.visibility;
  }
  if (query.is_recommended !== undefined) where.is_recommended = query.is_recommended;

  if (query.q) {
    where[Op.or] = [
      { name: { [Op.like]: `%${query.q}%` } },
      { code: { [Op.like]: `%${query.q}%` } },
      { description: { [Op.like]: `%${query.q}%` } },
    ];
  }

  return paginateQuery(
    db.SubscriptionPlan,
    {
      where,
      order: getSort(req, SORTABLE, DEFAULT_SORT),
      include: DETAIL_INCLUDE,
    },
    pagination
  );
}

/**
 * One plan, or a 404.
 *
 * The scope is folded into the `where`, so a school-scoped caller asking for a private plan is told
 * "not found" rather than being handed a row they may not see.
 *
 * @param {object} tenant
 * @param {number|string} id
 * @param {{detail?: boolean}} [options]
 * @returns {Promise<object>}
 */
async function findById(tenant, id, options = {}) {
  const plan = await db.SubscriptionPlan.findOne({
    where: { ...scopeFor(tenant), id },
    include: options.detail === false ? undefined : DETAIL_INCLUDE,
  });
  if (!plan) throw ApiError.notFound('Plan not found', { code: 'PLAN_NOT_FOUND' });
  return plan;
}

/**
 * FR-SUB-001 — Create Plan.
 *
 * `status` is forced to `inactive` rather than left to the column default. `plans.validation.js`
 * refuses the field and its header gives the reason: a plan created active would be advertised as
 * available while holding no price to bill and no limits to permit anything.
 *
 * @param {import('express').Request} req
 * @param {object} payload  validated body
 * @returns {Promise<object>}
 */
async function create(req, payload) {
  let plan;
  try {
    plan = await db.SubscriptionPlan.create({
      ...payload,
      status: PLAN_STATUS.INACTIVE,
      archived_at: null,
    });
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'subscription_plans',
    recordId: plan.id,
    event: 'create',
    after: snapshot(plan),
  });

  await entitlementService.invalidatePlan(plan.id);

  return findById(req.tenant, plan.id);
}

/**
 * FR-SUB-002 — Edit Plan. Status is not reachable from here; FR-SUB-004 and FR-SUB-005 own it.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function update(req, id, payload) {
  const plan = await findById(req.tenant, id, { detail: false });
  const before = snapshot(plan);

  try {
    await plan.update(payload);
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'subscription_plans',
    recordId: plan.id,
    event: 'update',
    before,
    after: snapshot(plan),
  });

  /* `code`, `name` and `tier_rank` are all read into the cached entitlement snapshot. */
  await entitlementService.invalidatePlan(plan.id);

  return findById(req.tenant, plan.id);
}

/**
 * The columns each status transition owns — FR-SUB-004 and FR-SUB-005.
 *
 * Data rather than three near-identical functions, for the reason `schools.service.js` gives: the
 * invariant is that `status` and `archived_at` can never disagree, and that is only visible if they are
 * written in one place. Both live transitions clear `archived_at`, which is what makes FR-SUB-005
 * reversible — the source describes archiving as retention, not as a terminal state.
 */
const TRANSITIONS = Object.freeze({
  [PLAN_STATUS.ACTIVE]: {
    columns: () => ({ status: PLAN_STATUS.ACTIVE, archived_at: null }),
    verb: 'Activated',
  },
  [PLAN_STATUS.INACTIVE]: {
    columns: () => ({ status: PLAN_STATUS.INACTIVE, archived_at: null }),
    verb: 'Deactivated',
  },
  [PLAN_STATUS.ARCHIVED]: {
    columns: () => ({ status: PLAN_STATUS.ARCHIVED, archived_at: new Date() }),
    verb: 'Archived',
  },
});

/**
 * FR-SUB-004 (Activate / Deactivate) and FR-SUB-005 (Archive).
 *
 * ## Activation requires something to sell
 *
 * FR-SUB-004's outcome is that the plan becomes *"available for new subscriptions"*. A subscription
 * denormalises its billing cycle, pricing model, currency and amount from a `plan_prices` row, so a
 * plan with no active price is not available for any subscription at all — activating it would publish
 * an offer the system cannot fulfil. The refusal is a 409 rather than a 422 because the request is well
 * formed; it is the plan's state that forbids it. Every legitimate arrangement still passes: SRS §10.4's
 * Custom model is a price row, and a free plan is a price row with `base_amount = 0`.
 *
 * ## Deactivating and archiving leave existing subscriptions alone
 *
 * Deliberately. FR-SUB-004 governs availability *for new subscriptions* and FR-SUB-005 keeps the plan
 * *"retained for historical reference"*, so neither is a reason to interrupt a school that is already
 * paying. What changes for those schools is nothing; what changes for the catalogue is everything.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {string} status  one of `PLAN_STATUS`
 * @param {string} [reason]
 * @returns {Promise<{plan: object, previousStatus: string, verb: string}>}
 */
async function setStatus(req, id, status, reason) {
  const transition = TRANSITIONS[status];
  if (!transition) {
    /* Boot-level mistake, not a client one — the routes pass literals from `PLAN_STATUS`. */
    throw new Error(`plans.service.setStatus(): unsupported status '${status}'`);
  }

  const plan = await findById(req.tenant, id, { detail: false });

  if (status === PLAN_STATUS.ACTIVE) {
    const priceable = await db.PlanPrice.count({ where: { plan_id: plan.id, is_active: true } });
    if (!priceable) {
      throw ApiError.conflict(
        'This plan has no active price, so it cannot be offered for new subscriptions. Configure pricing first (FR-SUB-006).',
        { code: 'PLAN_NOT_PRICEABLE', details: { planId: plan.id, activePriceCount: 0 } }
      );
    }
  }

  const previousStatus = plan.status;
  const before = snapshot(plan);

  await plan.update(transition.columns());

  await recordAudit(req, {
    tableName: 'subscription_plans',
    recordId: plan.id,
    event: 'update',
    before,
    after: snapshot(plan),
    /* `audit_logs.reason` is where a deactivation or archive reason lives — §29 gives the table none. */
    reason: reason || null,
  });

  await entitlementService.invalidatePlan(plan.id);

  return { plan: await findById(req.tenant, plan.id), previousStatus, verb: transition.verb };
}

/**
 * FR-SUB-003 — Duplicate Plan.
 *
 * *"Creates a new plan record copying the source plan's configuration"*, which is read as all four
 * collections and not merely the plan row: a copy carrying no prices, modules or limits would be a new
 * plan rather than a duplicate of one. One transaction, so a failure part-way through cannot leave a
 * plan holding half a configuration.
 *
 * `duplicated_from_id` records the lineage the association `duplicatedFrom` reads. It is `SET NULL`, so
 * archiving or deleting the source later loses the pointer rather than the copy.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} payload
 * @returns {Promise<{plan: object, source: object, copied: object}>}
 */
async function duplicate(req, id, payload) {
  const source = await findById(req.tenant, id);

  const fallbackName = `${source.name} (Copy)`;
  const attributes = {
    name: payload.name || fallbackName.slice(0, 160),
    code: payload.code,
    description: payload.description !== undefined ? payload.description : source.description,
    /* See `plans.validation.js` — a copy is never born active, whatever the source's status. */
    status: PLAN_STATUS.INACTIVE,
    visibility: payload.visibility !== undefined ? payload.visibility : source.visibility,
    is_recommended: payload.is_recommended !== undefined ? payload.is_recommended : false,
    display_order: payload.display_order !== undefined ? payload.display_order : source.display_order,
    trial_days: source.trial_days,
    grace_period_days: source.grace_period_days,
    default_renewal_mode: source.default_renewal_mode,
    tier_rank: payload.tier_rank !== undefined ? payload.tier_rank : source.tier_rank,
    duplicated_from_id: source.id,
    archived_at: null,
  };

  const copied = { prices: 0, modules: 0, features: 0, limits: 0 };
  let plan;

  try {
    await db.sequelize.transaction(async (transaction) => {
      plan = await db.SubscriptionPlan.create(attributes, { transaction });

      const collections = [
        { model: db.PlanPrice, rows: source.prices || [], fields: COPY_FIELDS.prices, key: 'prices' },
        { model: db.PlanModule, rows: source.modules || [], fields: COPY_FIELDS.modules, key: 'modules' },
        { model: db.PlanFeature, rows: source.features || [], fields: COPY_FIELDS.features, key: 'features' },
        { model: db.PlanLimit, rows: source.limits || [], fields: COPY_FIELDS.limits, key: 'limits' },
      ];

      for (const collection of collections) {
        if (!collection.rows.length) continue;
        await collection.model.bulkCreate(
          collection.rows.map((row) => ({ ...pick(row, collection.fields), plan_id: plan.id })),
          { transaction, validate: true }
        );
        copied[collection.key] = collection.rows.length;
      }
    });
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'subscription_plans',
    recordId: plan.id,
    event: 'create',
    after: snapshot(plan),
    reason: `Duplicated from plan ${source.id} (${source.code})`,
  });

  await entitlementService.invalidatePlan(plan.id);

  return { plan: await findById(req.tenant, plan.id), source, copied };
}

/**
 * Which of a plan's price rows are pointed at by something that has to keep resolving.
 *
 * `subscriptions.plan_price_id`, `subscriptions.scheduled_plan_price_id` (the §12.4 deferred downgrade)
 * and `quotations.plan_price_id` are all `SET NULL`, so deleting a referenced row would not fail — it
 * would quietly blank the pointer on a live subscription. The subscription keeps its denormalised
 * billing terms either way, but the trail from a school's bill back to the price it was quoted would be
 * gone, and SRS §13 needs that trail to survive.
 *
 * None of the three tables is paranoid, so a plain query sees every row that holds a reference.
 *
 * @param {number[]} ids
 * @returns {Promise<Set<number>>}
 */
async function pricesInUse(ids) {
  if (!ids.length) return new Set();

  const [current, scheduled, quoted] = await Promise.all([
    db.Subscription.findAll({
      attributes: ['plan_price_id'],
      where: { plan_price_id: { [Op.in]: ids } },
      raw: true,
    }),
    db.Subscription.findAll({
      attributes: ['scheduled_plan_price_id'],
      where: { scheduled_plan_price_id: { [Op.in]: ids } },
      raw: true,
    }),
    db.Quotation.findAll({
      attributes: ['plan_price_id'],
      where: { plan_price_id: { [Op.in]: ids } },
      raw: true,
    }),
  ]);

  const used = new Set();
  for (const row of current) used.add(Number(row.plan_price_id));
  for (const row of scheduled) used.add(Number(row.scheduled_plan_price_id));
  for (const row of quoted) used.add(Number(row.plan_price_id));
  return used;
}

/**
 * FR-SUB-006 — Configure Plan Pricing & Billing Cycle.
 *
 * A whole-set replacement, for the reason `roles.service.setPermissions()` gives: a delta needs the
 * client to say what changed, so two administrators on the pricing screen at once would each apply a
 * change to a set neither of them was looking at.
 *
 * ## A price in use is kept — updated in place when the set still offers it, retired when it does not
 *
 * `plan_prices` has no unique key, but a price does have an identity: the tuple `checkPriceSet`
 * refuses to see twice — billing cycle, cycle days, pricing model and tier band. A row a subscription
 * or quotation points at cannot be deleted without blanking that pointer (see `pricesInUse`), so:
 *
 *   - a referenced row whose identity the submitted set **repeats** is updated in place with the
 *     submitted values, and kept active unless the set says otherwise;
 *   - a referenced row the set **omits** is set `is_active = false` and kept, with `is_default`
 *     cleared, since a retired price must not stay pre-selected on the subscribe screen;
 *   - everything unreferenced is replaced outright.
 *
 * The first rule is the fix for a loop the audit of the pricing screen found. Every referenced row
 * used to be retired and the whole set re-created, so saving the same prices on a plan any school had
 * bought left the old row retired *and* a new copy with the same identity — and the next save of that
 * set, retired row included, was refused as a duplicate. Updating in place changes no subscription:
 * each copies its pricing into its own columns when it is created.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object[]} prices  the complete price set the plan should offer
 * @returns {Promise<{plan: object, created: number, updated: number, deleted: number, retired: number}>}
 */
async function setPrices(req, id, prices) {
  const plan = await findById(req.tenant, id, { detail: false });

  const existing = await db.PlanPrice.findAll({
    where: { plan_id: plan.id },
    order: [['id', 'ASC']],
  });
  const before = existing.map((row) => snapshot(row));

  const inUse = await pricesInUse(existing.map((row) => Number(row.id)));
  const referenced = existing.filter((row) => inUse.has(Number(row.id)));
  const removable = existing.filter((row) => !inUse.has(Number(row.id)));

  /* A price's identity — the tuple `checkPriceSet` refuses to see twice. See the header. */
  const identityOf = (price) =>
    [
      price.billing_cycle,
      price.cycle_days ?? '',
      price.pricing_model,
      price.tier_min_units ?? '',
      price.tier_max_units ?? '',
    ].join('|');
  const referencedByIdentity = new Map(referenced.map((row) => [identityOf(row), row]));
  /* submitted index → the referenced row it updates in place */
  const reuse = new Map();
  prices.forEach((price, index) => {
    const row = referencedByIdentity.get(identityOf(price));
    if (row && ![...reuse.values()].includes(row)) reuse.set(index, row);
  });
  const retained = referenced.filter((row) => ![...reuse.values()].includes(row));
  const fresh = prices.filter((_, index) => !reuse.has(index));

  await db.sequelize.transaction(async (transaction) => {
    if (removable.length) {
      await db.PlanPrice.destroy({
        where: { id: { [Op.in]: removable.map((row) => row.id) } },
        transaction,
      });
    }

    if (retained.length) {
      await db.PlanPrice.update(
        { is_active: false, is_default: false },
        { where: { id: { [Op.in]: retained.map((row) => row.id) } }, transaction }
      );
    }

    for (const [index, row] of reuse) {
      const price = prices[index];
      // eslint-disable-next-line no-await-in-loop
      await row.update(
        {
          ...price,
          plan_id: plan.id,
          is_active: price.is_active !== undefined ? price.is_active : true,
          is_default: price.is_default !== undefined ? price.is_default : false,
        },
        { transaction }
      );
    }

    if (fresh.length) {
      /* `validate: true` runs the model-level `customDaysRequiresLength` and `tierBandOrdered`
       * validators, which `bulkCreate` skips by default. The Joi schema checks the same two rules, so
       * this is the second of two independent checks rather than the only one. */
      await db.PlanPrice.bulkCreate(
        fresh.map((price) => ({ ...price, plan_id: plan.id })),
        { transaction, validate: true }
      );
    }
  });

  const after = await db.PlanPrice.findAll({ where: { plan_id: plan.id }, order: [['id', 'ASC']] });

  await recordAudit(req, {
    tableName: 'plan_prices',
    recordId: plan.id,
    event: 'update',
    before: { plan_id: plan.id, prices: before },
    after: { plan_id: plan.id, prices: after.map((row) => snapshot(row)) },
    reason: `Price set replaced for plan ${plan.code}`,
  });

  await entitlementService.invalidatePlan(plan.id);

  return {
    plan: await findById(req.tenant, plan.id),
    created: fresh.length,
    updated: reuse.size,
    deleted: removable.length,
    retired: retained.length,
  };
}

/**
 * The shared body of the three FR-SUB-007 collection replacements.
 *
 * Destroy-then-insert inside one transaction. Nothing outside `subscription_plans` references
 * `plan_modules`, `plan_features` or `plan_limits` — `entitlementService` reads them by `plan_id` — so
 * unlike `plan_prices` there is no row here that has to survive its own removal.
 *
 * @param {import('express').Request} req
 * @param {object} plan
 * @param {{model: object, tableName: string, rows: object[], label: string}} spec
 * @returns {Promise<void>}
 */
async function replaceCollection(req, plan, spec) {
  const existing = await spec.model.findAll({ where: { plan_id: plan.id }, order: [['id', 'ASC']] });

  await db.sequelize.transaction(async (transaction) => {
    await spec.model.destroy({ where: { plan_id: plan.id }, transaction });
    if (spec.rows.length) {
      await spec.model.bulkCreate(
        spec.rows.map((row) => ({ ...row, plan_id: plan.id })),
        { transaction, validate: true }
      );
    }
  });

  const after = await spec.model.findAll({ where: { plan_id: plan.id }, order: [['id', 'ASC']] });

  await recordAudit(req, {
    tableName: spec.tableName,
    recordId: plan.id,
    event: 'update',
    before: { plan_id: plan.id, [spec.label]: existing.map((row) => snapshot(row)) },
    after: { plan_id: plan.id, [spec.label]: after.map((row) => snapshot(row)) },
    reason: `${spec.label} replaced for plan ${plan.code}`,
  });

  await entitlementService.invalidatePlan(plan.id);
}

/**
 * FR-SUB-007, the modules half — SRS §11.1.
 *
 * A module absent from the set is not in the plan, which is what `entitlementService.hasModule()`
 * already reports for a missing row. That is why a partial set is accepted here and refused for limits.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object[]} modules
 * @returns {Promise<object>}
 */
async function setModules(req, id, modules) {
  const plan = await findById(req.tenant, id, { detail: false });

  await replaceCollection(req, plan, {
    model: db.PlanModule,
    tableName: 'plan_modules',
    rows: modules,
    label: 'modules',
  });

  return findById(req.tenant, plan.id);
}

/**
 * FR-SUB-007, the features half — SRS §11.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object[]} features
 * @returns {Promise<object>}
 */
async function setFeatures(req, id, features) {
  const plan = await findById(req.tenant, id, { detail: false });

  await replaceCollection(req, plan, {
    model: db.PlanFeature,
    tableName: 'plan_features',
    rows: features,
    label: 'features',
  });

  return findById(req.tenant, plan.id);
}

/**
 * FR-SUB-007, the limits half — SRS §11.2.
 *
 * `unit` is derived from `LIMIT_UNITS`, not accepted from the caller: the unit is a property of the
 * limit, and `usageService` measures storage in megabytes and API calls in requests whatever a plan row
 * claims. A row asserting a different unit would make the allowance and the usage figure incomparable
 * while both looked valid.
 *
 * The validation schema requires all eight keys — see its header for why an omitted limit is not a
 * limit left alone.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object[]} limits
 * @returns {Promise<object>}
 */
async function setLimits(req, id, limits) {
  const plan = await findById(req.tenant, id, { detail: false });

  const rows = limits.map((limit) => ({
    ...limit,
    unit: LIMIT_UNITS[limit.limit_key] || null,
    /* An unlimited limit stores no number; the schema refuses one, and this makes it true of the row
     * even if a future caller reaches this function another way. */
    limit_value: limit.limit_type === LIMIT_TYPES.UNLIMITED ? null : limit.limit_value,
  }));

  await replaceCollection(req, plan, {
    model: db.PlanLimit,
    tableName: 'plan_limits',
    rows,
    label: 'limits',
  });

  return findById(req.tenant, plan.id);
}

module.exports = {
  list,
  findById,
  create,
  update,
  setStatus,
  duplicate,
  setPrices,
  setModules,
  setFeatures,
  setLimits,
  catalogue,
  readiness,
  scopeFor,
  pricesInUse,
  SORTABLE,
  DEFAULT_SORT,
  DETAIL_INCLUDE,
  COPY_FIELDS,
  TRANSITIONS,
};
