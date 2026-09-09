'use strict';

/**
 * Add-on data access — SRS §11.3, FR-SUB-009.
 *
 * ## `addons` is a platform table with a fixed row set
 *
 * An add-on carries neither `school_id` nor `organization_id`: the same seven rows are offered to every
 * school, which is what makes them a catalogue. As in `plans.service.js`, `tenantWhere()` has no column
 * to narrow, so the confinement is stated in `scopeFor()` and the writes carry `requirePlatformScope()`.
 *
 * The row *set* is fixed by the source. `addons.key` is unique and validated against `ADDON_LIST`, so
 * this file has no `create` and no `destroy`: an eighth add-on cannot exist (§35 — nothing invented), and
 * removing one of the seven would fail anyway, because `subscription_addons.addon_id` is `RESTRICT`.
 * FR-SUB-009 is *"configure add-ons purchasable in addition to the base plan"* — configuration of a fixed
 * list, not authorship of a list.
 *
 * ## Why nothing here invalidates the entitlement cache
 *
 * This is the first write module in the subscription area that must **not** call
 * `entitlementService.invalidate*`, and the reason is worth stating rather than inferring from its
 * absence.
 *
 * `entitlementService.resolveSchool()` reads add-ons from `subscription_addons`, selecting
 * `effect_type`, `effect_target`, `units_granted` and `quantity` — and it never joins `addons`. Those
 * three effect columns are *copied onto the purchase row* when a school buys the add-on, exactly as a
 * subscription copies its billing terms from a `plan_prices` row. So editing `units_per_quantity` here
 * changes what the **next** purchase grants and cannot change what an existing one granted; there is no
 * cached value to stale. Deactivating an add-on likewise stops it being sold without touching a school
 * that already owns it, which is the same retention rule FR-SUB-004 applies to a plan.
 *
 * The obligation therefore lands on whatever writes `subscription_addons` — the purchase and cancel
 * endpoints of the subscriptions module — and `entitlementService`'s own header already names that table
 * as one of the three that must invalidate.
 *
 * ## Activation carries no precondition, unlike a plan's
 *
 * `plans.service.setStatus()` refuses to activate a plan with no active price, because a subscription
 * cannot exist without denormalising a `plan_prices` row. The add-on case is genuinely different:
 * `subscription_addons.addon_price_id` is **nullable**, so a granted add-on with no price row is a shape
 * the schema deliberately allows — a bundled or comped add-on. Refusing activation without a price would
 * forbid an arrangement the tables were built to hold. `readiness()` reports `purchasable` instead, so
 * the screen can say what an operator would otherwise have to infer.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { LIMIT_UNITS } = require('../../config/constants');
const entitlementService = require('../../services/entitlementService');

const SORTABLE = Object.freeze([
  'id',
  'key',
  'name',
  'display_order',
  'is_active',
  'effect_type',
  'created_at',
  'updated_at',
]);

/** SRS §11.3 lists the seven in an order the seeder preserved in `display_order`. */
const DEFAULT_SORT = Object.freeze(['display_order', 'ASC']);

/**
 * Which add-ons this caller may see.
 *
 * FR-SUB-009's **Description** is *"Super Admin and/or school configure add-ons"* (SRS:521) — its
 * Actor / Role line one line below (SRS:522) reads only *"Super Admin"*, and the source expects a
 * school to see what it
 * can buy — so the reads are not platform-only. A non-platform caller sees the active add-ons and
 * nothing else: an add-on deactivated by FR-SUB-009 is not on sale, and listing it would offer something
 * the purchase endpoint would refuse.
 *
 * @param {{isPlatform: boolean}} tenant
 * @returns {object} a Sequelize `where` fragment
 */
function scopeFor(tenant) {
  if (!tenant) throw new Error('addons.service: req.tenant is missing — resolveTenant did not run');
  if (tenant.isPlatform) return {};
  return { is_active: true };
}

/**
 * The price collection, scoped the same way the add-on is.
 *
 * `separate: true` keeps `count` equal to the number of add-ons on a list query — a joined `hasMany`
 * would multiply the rows and make `distinct: true` load-bearing on a page size.
 *
 * A school-scoped caller sees only active prices, for the same reason it sees only active add-ons: an
 * inactive price is a historical row kept because a purchase points at it (see `pricesInUse`), not an
 * offer — and, since Known Issues #17, only the prices its own plan can buy.
 *
 * @param {{isPlatform: boolean}} tenant
 * @param {number|null} [planId]  the school's plan; null means "unrestricted prices only"
 * @returns {object[]}
 */
function detailInclude(tenant, planId = null) {
  const include = {
    model: db.AddonPrice,
    as: 'prices',
    separate: true,
    order: [
      ['billing_cycle', 'ASC'],
      ['id', 'ASC'],
    ],
  };
  if (!tenant || !tenant.isPlatform) {
    /*
     * Known Issues #17. This filtered on `is_active` alone, so a school-scoped read returned prices
     * whose `plan_id` names a **different plan** — figures it could see and could not act on. The
     * purchase path already refused them (`subscriptions.service.js`, `ADDON_PRICE_PLAN_MISMATCH`),
     * so nothing could be bought that should not be; what leaked was the catalogue.
     *
     * The predicate is the write path's, inverted from a refusal into a filter: it refuses when
     * `price.plan_id && price.plan_id !== subscription.plan_id`, so what a school may see is a null
     * `plan_id` — "available on any plan" — or its own. Written from that line rather than invented,
     * because a read filter stricter or looser than the write rule is a new rule, and §35 has none to
     * offer.
     *
     * `planId` null covers two cases that behave the same and for the same reason: a school with no
     * usable subscription, and a caller who did not resolve one. Neither can buy a plan-restricted
     * price, so neither is shown one.
     *
     * This compares plan **ids**. §30 Rule 1 forbids branching on a plan's code or name, and the ids
     * are what `addon_prices.plan_id` and `subscriptions.plan_id` already hold.
     */
    include.where = {
      is_active: true,
      plan_id: planId === null || planId === undefined ? null : { [Op.or]: [null, planId] },
    };
  }
  return [include];
}

/**
 * The plan id a school-scoped read should be filtered against, or null.
 *
 * Resolved here rather than inside `detailInclude()` so that helper stays synchronous — it has two
 * callers, both in this file, and both are already async, so the resolution costs one awaited call at
 * the top of each rather than a signature change that reaches everything.
 *
 * A platform caller gets null and is not filtered at all: the Super Admin's catalogue is the whole
 * catalogue, which is the same reason `scopeFor()` returns `{}` for them.
 *
 * @param {{isPlatform: boolean, schoolId?: number}} tenant
 * @returns {Promise<number|null>}
 */
async function planIdFor(tenant) {
  if (!tenant || tenant.isPlatform || !tenant.schoolId) return null;
  /* Named `entitlement`, not `snapshot`: `snapshot` is the audit helper this file already imports. */
  const entitlement = await entitlementService.getSnapshot(tenant.schoolId);
  return entitlement && entitlement.subscription ? entitlement.subscription.planId : null;
}

/**
 * What stands between this add-on and a school being able to buy it.
 *
 * Derived per response, never stored — the same rule `plans.service.readiness()` follows. A stored
 * "is this add-on purchasable" column would be a second source of truth that could disagree with the
 * price rows.
 *
 * @param {object} addon  an add-on loaded with `detailInclude()`
 * @returns {object}
 */
function readiness(addon) {
  const prices = addon.prices || [];
  const activePrices = prices.filter((price) => price.is_active);

  return {
    priceCount: prices.length,
    activePriceCount: activePrices.length,
    /* A price restricted to one plan is not on general sale; the screen needs both numbers. */
    planRestrictedPriceCount: activePrices.filter((price) => price.plan_id !== null).length,
    unrestrictedPriceCount: activePrices.filter((price) => price.plan_id === null).length,
    /* Both halves are required: an active add-on with nothing priced cannot be sold, and a priced
     * add-on that is switched off is not on offer. */
    purchasable: Boolean(addon.is_active) && activePrices.length > 0,
  };
}

/**
 * One page of add-ons.
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
   * A filter, not a scope — the rule `plans.service.list()` states. A school-scoped caller is already
   * confined to the active add-ons, so `?is_active=false` must return nothing rather than widen what it
   * was given.
   */
  if (query.is_active !== undefined) {
    if (where.is_active !== undefined && where.is_active !== query.is_active) {
      return { rows: [], count: 0 };
    }
    where.is_active = query.is_active;
  }
  if (query.effect_type) where.effect_type = query.effect_type;

  if (query.q) {
    where[Op.or] = [
      { key: { [Op.like]: `%${query.q}%` } },
      { name: { [Op.like]: `%${query.q}%` } },
      { description: { [Op.like]: `%${query.q}%` } },
    ];
  }

  return paginateQuery(
    db.Addon,
    {
      where,
      order: getSort(req, SORTABLE, DEFAULT_SORT),
      include: detailInclude(tenant, await planIdFor(tenant)),
    },
    pagination
  );
}

/**
 * One add-on, or a 404.
 *
 * The scope is folded into the `where`, so a school-scoped caller asking for a deactivated add-on is
 * told "not found" rather than being handed a row that is not on sale.
 *
 * @param {object} tenant
 * @param {number|string} id
 * @param {{detail?: boolean}} [options]
 * @returns {Promise<object>}
 */
async function findById(tenant, id, options = {}) {
  const addon = await db.Addon.findOne({
    where: { ...scopeFor(tenant), id },
    include:
      options.detail === false ? undefined : detailInclude(tenant, await planIdFor(tenant)),
  });
  if (!addon) throw ApiError.notFound('Add-on not found', { code: 'ADDON_NOT_FOUND' });
  return addon;
}

/**
 * The unit an add-on's granted quantity is measured in.
 *
 * Derived, never accepted from the caller — see `addons.validation.js`. A `feature_unlock` add-on grants
 * no units at all, so its unit is null; a `limit_increase` inherits the unit of the limit it raises, and
 * `LIMIT_UNITS` covers all nine keys including the add-on-only `sms_limit`.
 *
 * The `'count'` fallback is not a guess of this module's: it is exactly what
 * `05-addons.js` writes on insert (`LIMIT_UNITS[effect.target] || 'count'`). Deriving it any other way —
 * `null`, or a throw — would mean an edit here silently disagreed with the seeder about a row neither of
 * them can change, since `effect_target` is uneditable and every one of the seven seeded targets is
 * mapped. This branch is therefore reachable only for a hand-written row, and for that row the seeder's
 * answer is the right one.
 *
 * @param {object} addon
 * @returns {string|null}
 */
function unitFor(addon) {
  if (addon.effect_type !== 'limit_increase') return null;
  /* `hasOwnProperty`, not a bare lookup: `effect_target` is a `STRING(40)` with no database-level
   * allowlist, so a row reading `constructor` would otherwise resolve to something off Object's
   * prototype instead of falling through to the default. */
  return Object.prototype.hasOwnProperty.call(LIMIT_UNITS, addon.effect_target)
    ? LIMIT_UNITS[addon.effect_target]
    : 'count';
}

/**
 * FR-SUB-009 — edit an add-on's configurable fields.
 *
 * `unit` is written here rather than left alone: it is derived from `effect_target`, and re-deriving it
 * on every edit means a row seeded before a unit mapping changed is corrected the next time an operator
 * touches it. For the seven seeded rows this is a no-op, because the seeder derived the same value.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} payload  validated body
 * @returns {Promise<object>}
 */
async function update(req, id, payload) {
  const addon = await findById(req.tenant, id, { detail: false });
  const before = snapshot(addon);

  await addon.update({ ...payload, unit: unitFor(addon) });

  await recordAudit(req, {
    tableName: 'addons',
    recordId: addon.id,
    event: 'update',
    before,
    after: snapshot(addon),
  });

  /* No entitlement invalidation — see the file header. `subscription_addons` holds the copy that
   * resolution reads, so this edit changes what the next purchase grants and nothing already granted. */

  return findById(req.tenant, addon.id);
}

/**
 * FR-SUB-009 — the availability switch.
 *
 * Deactivating stops the add-on being offered and leaves every school that already owns it untouched:
 * `entitlementService` resolves from `subscription_addons.status`, not from `addons.is_active`. That is
 * the same retention rule FR-SUB-004 applies to a plan, and for the same reason — withdrawing an offer
 * is not a reason to take something away from a school that has paid for it.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {boolean} isActive
 * @param {string} [reason]
 * @returns {Promise<{addon: object, previous: boolean, verb: string}>}
 */
async function setActive(req, id, isActive, reason) {
  const addon = await findById(req.tenant, id, { detail: false });
  const previous = Boolean(addon.is_active);
  const before = snapshot(addon);

  await addon.update({ is_active: isActive });

  await recordAudit(req, {
    tableName: 'addons',
    recordId: addon.id,
    event: 'update',
    before,
    after: snapshot(addon),
    /* `audit_logs.reason` is where a deactivation reason lives — §29 gives `addons` no column for it. */
    reason: reason || null,
  });

  return {
    addon: await findById(req.tenant, addon.id),
    previous,
    verb: isActive ? 'Activated' : 'Deactivated',
  };
}

/**
 * Which of an add-on's price rows are pointed at by a purchase.
 *
 * `subscription_addons.addon_price_id` is `ON DELETE SET NULL`, so deleting a referenced row would not
 * fail — it would quietly blank the pointer on a live purchase. The purchase keeps its denormalised
 * `unit_amount` either way, but the trail from a school's bill back to the price it was quoted would be
 * gone, and SRS §13 needs that trail to survive. It is the only column in the schema that references
 * `addon_prices`.
 *
 * @param {number[]} ids
 * @returns {Promise<Set<number>>}
 */
async function pricesInUse(ids) {
  if (!ids.length) return new Set();

  const rows = await db.SubscriptionAddon.findAll({
    attributes: ['addon_price_id'],
    where: { addon_price_id: { [Op.in]: ids } },
    raw: true,
  });

  return new Set(rows.map((row) => Number(row.addon_price_id)));
}

/**
 * Every `plan_id` named by the incoming price set has to exist.
 *
 * `addon_prices.plan_id` is `ON DELETE CASCADE`, so a bad id would not be caught by the column — an
 * insert against a missing plan fails with a foreign-key error the client cannot act on, and a plan
 * deleted later takes its restricted prices with it, which is correct. A 422 naming the ids is the
 * actionable form of the same refusal.
 *
 * `SubscriptionPlan` is paranoid, so a soft-deleted plan is treated as missing here — restricting a
 * price to a plan nobody can subscribe to is not a state worth creating.
 *
 * @param {object[]} prices
 * @returns {Promise<void>}
 */
async function assertPlansExist(prices) {
  const ids = [...new Set(prices.map((price) => price.plan_id).filter((value) => value != null))];
  if (!ids.length) return;

  const found = await db.SubscriptionPlan.findAll({
    attributes: ['id'],
    where: { id: { [Op.in]: ids } },
    raw: true,
  });
  const known = new Set(found.map((row) => Number(row.id)));
  const missing = ids.filter((value) => !known.has(Number(value)));

  if (missing.length) {
    throw new ApiError(422, 'One or more prices are restricted to a plan that does not exist', {
      code: 'ADDON_PRICE_PLAN_NOT_FOUND',
      details: { planIds: missing },
    });
  }
}

/**
 * FR-SUB-009 — replace the add-on's price set.
 *
 * A whole-set replacement, and — as with `plan_prices` — a row that something still points at is
 * **retired** (`is_active = false`) rather than deleted. `addon_prices` has no natural key: two rows can
 * differ only by their plan restriction, so a replacement cannot match old rows to new ones and has to
 * remove what the caller omitted.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object[]} prices  the complete price set the add-on should offer
 * @returns {Promise<{addon: object, created: number, deleted: number, retired: number}>}
 */
async function setPrices(req, id, prices) {
  const addon = await findById(req.tenant, id, { detail: false });

  await assertPlansExist(prices);

  const existing = await db.AddonPrice.findAll({
    where: { addon_id: addon.id },
    order: [['id', 'ASC']],
  });
  const before = existing.map((row) => snapshot(row));

  const inUse = await pricesInUse(existing.map((row) => Number(row.id)));
  const retained = existing.filter((row) => inUse.has(Number(row.id)));
  const removable = existing.filter((row) => !inUse.has(Number(row.id)));

  await db.sequelize.transaction(async (transaction) => {
    if (removable.length) {
      await db.AddonPrice.destroy({
        where: { id: { [Op.in]: removable.map((row) => row.id) } },
        transaction,
      });
    }

    if (retained.length) {
      await db.AddonPrice.update(
        { is_active: false },
        { where: { id: { [Op.in]: retained.map((row) => row.id) } }, transaction }
      );
    }

    if (prices.length) {
      /* `validate: true` runs the model's own validators, which `bulkCreate` skips by default. The Joi
       * schema checks the same rules, so this is the second of two independent checks. */
      await db.AddonPrice.bulkCreate(
        prices.map((price) => ({ ...price, addon_id: addon.id })),
        { transaction, validate: true }
      );
    }
  });

  const after = await db.AddonPrice.findAll({
    where: { addon_id: addon.id },
    order: [['id', 'ASC']],
  });

  await recordAudit(req, {
    tableName: 'addon_prices',
    recordId: addon.id,
    event: 'update',
    before: { addon_id: addon.id, prices: before },
    after: { addon_id: addon.id, prices: after.map((row) => snapshot(row)) },
    reason: `Price set replaced for add-on ${addon.key}`,
  });

  return {
    addon: await findById(req.tenant, addon.id),
    created: prices.length,
    deleted: removable.length,
    retired: retained.length,
  };
}

module.exports = {
  list,
  findById,
  update,
  setActive,
  setPrices,
  readiness,
  scopeFor,
  detailInclude,
  unitFor,
  pricesInUse,
  assertPlansExist,
  SORTABLE,
  DEFAULT_SORT,
};
