'use strict';

/**
 * Tax rates — SRS §33 (the SaaS Engine's *"Taxes"* capability) and §13.1's invoice **Tax** field.
 *
 * ## What the source actually gives, and what it does not
 *
 * This is the thinnest module in Phase 3.H, and deliberately so. `taxes` is one of the nine §29
 * Billing tables, `config/permissions.js` carries `taxes.view` and `taxes.manage`, and §33 lists
 * *"Taxes"* among the SaaS Engine's capabilities. That is the whole of the source: **there is no
 * field list and no FR-BILL requirement for taxes.** §13.1 names `Tax` as one of the eleven invoice
 * fields and §13 says nothing else about how a rate is chosen.
 *
 * So every behaviour here is derived from a column that already exists in `models/billing.js`, and
 * where a column's meaning had to be settled, the reasoning is written beside it. Nothing is invented
 * on top: no tax groups, no compound taxes, no per-line-item tax, no jurisdiction lookup.
 *
 * ## Three column meanings that had to be settled
 *
 *  1. **`is_default`** — the model indexes it, so it is meant to be queried. The only coherent
 *     meaning for a default rate is *"the one an invoice uses when the caller names none"*, which is
 *     what `resolveForInvoice()` reads it as. It follows that at most one row may hold it: two
 *     defaults would make the rate on an invoice depend on which row the database returned first.
 *     `setDefault()` therefore clears the others inside the same transaction.
 *
 *  2. **`is_inclusive`** — the column's own comment is *"true = the listed price already contains
 *     this tax"*. An inclusive rate must therefore **not** be added to the invoice total; it is
 *     reported so a printed invoice can show the tax contained in the price. `quoteFor()` returns
 *     both figures and marks which one the total moves by, and `invoices.service.js` is the only
 *     caller. Getting this backwards would overcharge every school by the tax rate, so it is
 *     asserted directly in `scripts/verify-billing.js` rather than trusted to this comment.
 *
 *  3. **`country` / `state`** — nullable, and nothing in the source says how they select a rate. They
 *     are stored, filterable and shown; they are **not** used to resolve a rate automatically.
 *     Guessing a jurisdiction rule — nearest match? state overrides country? — would be inventing
 *     tax law, and `schools` has no country column to match against in any case. An operator names
 *     the `tax_id`, or the default applies. Recorded as a stated gap, not as an oversight.
 *
 * ## Why deletion is guarded rather than offered freely
 *
 * `invoices.tax_id` is `ON DELETE SET NULL`, so the database would happily delete a rate and quietly
 * null the pointer on every historical invoice that used it. The rate itself survives — `invoices`
 * copies `tax_rate_percent` at issue time, on the same "denormalised copy so a later edit cannot
 * rewrite history" reasoning `subscriptions.pricingColumns()` follows — but the link to the named
 * rate would be gone from the audit trail. So `destroy()` refuses when any invoice or quotation
 * points at the row and tells the operator to deactivate it instead, which is the same choice
 * `/plans` and `/addons` make for a price row a purchase still references.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const money = require('../../utils/money');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');

const SORTABLE = Object.freeze([
  'id',
  'name',
  'code',
  'rate_percent',
  'is_active',
  'is_default',
  'created_at',
  'updated_at',
]);

const DEFAULT_SORT = Object.freeze(['name', 'ASC']);

/* ─────────────────────────────── reads ─────────────────────────────── */

/**
 * One page of tax rates.
 *
 * No tenant scope: `taxes` has no `school_id`. It is a platform table, like `subscription_plans` and
 * `addons`, and `taxes.view` is seeded to `super_admin` alone — so there is no non-platform caller to
 * confine. `taxes.routes.js` states the guard reasoning.
 *
 * @param {object} query
 * @param {object} pagination
 * @param {import('express').Request} req
 * @returns {Promise<{rows: object[], count: number}>}
 */
async function list(query, pagination, req) {
  const where = {};

  if (query.is_active !== undefined) where.is_active = query.is_active;
  if (query.is_inclusive !== undefined) where.is_inclusive = query.is_inclusive;
  if (query.is_default !== undefined) where.is_default = query.is_default;
  if (query.country) where.country = query.country;
  if (query.state) where.state = query.state;

  if (query.q) {
    where[Op.or] = [
      { name: { [Op.like]: `%${query.q}%` } },
      { code: { [Op.like]: `%${query.q}%` } },
    ];
  }

  return paginateQuery(db.Tax, { where, order: getSort(req, SORTABLE, DEFAULT_SORT) }, pagination);
}

/**
 * One tax rate, or a 404.
 *
 * @param {number|string} id
 * @param {{transaction?: object}} [options]
 * @returns {Promise<object>}
 */
async function findById(id, options = {}) {
  const tax = await db.Tax.findByPk(id, { transaction: options.transaction });
  if (!tax) throw ApiError.notFound('Tax not found', { code: 'TAX_NOT_FOUND' });
  return tax;
}

/**
 * The rate an invoice should use — reason 1 in the header.
 *
 * Called by `invoices.service.js` and by nothing else. A named `taxId` wins; otherwise the active
 * default applies; otherwise there is no tax and the invoice carries `tax_amount: 0` with a null
 * `tax_id`, which is a legitimate configuration and not an error — a platform that has configured no
 * tax rates issues untaxed invoices.
 *
 * An **inactive** named rate is refused rather than ignored. `is_active: false` means "not to be
 * applied to new invoices", and silently issuing at 0% would leave the operator looking at an invoice
 * they believed carried tax.
 *
 * @param {number|string|null} taxId
 * @param {object} [transaction]
 * @returns {Promise<object|null>}
 */
async function resolveForInvoice(taxId, transaction) {
  if (taxId !== undefined && taxId !== null) {
    const tax = await findById(taxId, { transaction });

    if (!tax.is_active) {
      throw ApiError.conflict(`Tax ${tax.code} is inactive and cannot be applied to a new invoice.`, {
        code: 'TAX_INACTIVE',
        details: { taxId: tax.id, code: tax.code },
      });
    }
    return tax;
  }

  return db.Tax.findOne({
    where: { is_default: true, is_active: true },
    order: [['id', 'ASC']],
    transaction,
  });
}

/**
 * What a rate adds to — or is already contained in — a taxable amount. Reason 2 in the header.
 *
 * `taxableAmount` is the invoice subtotal **after** discount, which is the order §13.1 lists the four
 * money fields in: Subtotal, Discount, Tax, Total. Taxing before the discount would charge tax on
 * money the school is not paying.
 *
 * For an **exclusive** rate (the common case) the tax is added: `total = taxable + tax`, and
 * `addedAmount` carries it.
 *
 * For an **inclusive** rate the listed price already contains the tax, so nothing is added and the
 * figure is extracted for display: `contained = taxable − taxable / (1 + rate/100)`. `addedAmount` is
 * `0`, which is what keeps `invoices.service.js` from double-charging.
 *
 * @param {object|null} tax
 * @param {number} taxableAmount
 * @returns {{taxId: number|null, code: string|null, ratePercent: number, isInclusive: boolean,
 *            addedAmount: number, containedAmount: number}}
 */
function quoteFor(tax, taxableAmount) {
  const base = money.clampNonNegative(taxableAmount);

  if (!tax) {
    return {
      taxId: null,
      code: null,
      ratePercent: 0,
      isInclusive: false,
      addedAmount: 0,
      containedAmount: 0,
    };
  }

  const ratePercent = Number(tax.rate_percent) || 0;
  const isInclusive = Boolean(tax.is_inclusive);

  /*
   * Exclusive: percentageOf() works in minor units, so a 17.5% rate on 99.99 rounds once, here,
   * rather than accumulating a fraction of a cent per line item.
   */
  const exclusiveTax = money.percentageOf(base, ratePercent);

  /*
   * Inclusive: the divisor form, not `percentageOf`. 100 at an inclusive 20% contains 16.67 of tax,
   * not 20 — the rate is expressed against the pre-tax figure, which is what `base / 1.2` recovers.
   */
  const containedTax = ratePercent > 0 ? money.subtract(base, base / (1 + ratePercent / 100)) : 0;

  return {
    taxId: tax.id,
    code: tax.code,
    ratePercent,
    isInclusive,
    addedAmount: isInclusive ? 0 : exclusiveTax,
    containedAmount: isInclusive ? money.round(containedTax) : 0,
  };
}

/* ─────────────────────────────── writes ─────────────────────────────── */

/**
 * Clear `is_default` from every row but one — reason 1 in the header.
 *
 * Runs inside the caller's transaction, so a create or update that sets the flag cannot leave two
 * defaults behind if the second statement fails.
 *
 * @param {number|null} keepId  the row that keeps the flag, or null to clear every row
 * @param {object} transaction
 * @returns {Promise<number>} how many rows were cleared
 */
async function clearOtherDefaults(keepId, transaction) {
  const where = { is_default: true };
  if (keepId) where.id = { [Op.ne]: keepId };

  const [affected] = await db.Tax.update({ is_default: false }, { where, transaction });
  return affected;
}

/**
 * Create a tax rate.
 *
 * `code` is `unique` in the schema, so a duplicate is a 409 rather than a driver error. The check is
 * inside the transaction and the unique index is still the authority — two simultaneous creates of
 * the same code make one of them fail at the index, which the error handler maps to the same 409.
 *
 * @param {import('express').Request} req
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function create(req, payload) {
  let tax;

  await db.sequelize.transaction(async (transaction) => {
    const existing = await db.Tax.findOne({
      where: { code: payload.code },
      transaction,
    });

    if (existing) {
      throw ApiError.conflict(`A tax with code ${payload.code} already exists.`, {
        code: 'TAX_CODE_TAKEN',
        details: { code: payload.code, taxId: existing.id },
      });
    }

    tax = await db.Tax.create(payload, { transaction });

    if (tax.is_default) await clearOtherDefaults(tax.id, transaction);
  });

  await recordAudit(req, {
    tableName: 'taxes',
    recordId: tax.id,
    event: 'create',
    after: snapshot(tax),
  });

  return findById(tax.id);
}

/**
 * Edit a tax rate.
 *
 * **`rate_percent` is editable, and that is a decision worth stating.** An invoice copies
 * `tax_rate_percent` at issue time, so changing the rate here cannot alter a single invoice already
 * issued — the same protection `subscriptions` gets from copying its price columns. Without that copy
 * this field would have to be immutable; with it, an operator correcting a mistyped rate is an
 * ordinary edit.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function update(req, id, payload) {
  const tax = await findById(id);
  const before = snapshot(tax);

  await db.sequelize.transaction(async (transaction) => {
    if (payload.code && payload.code !== tax.code) {
      const clash = await db.Tax.findOne({
        where: { code: payload.code, id: { [Op.ne]: tax.id } },
        transaction,
      });

      if (clash) {
        throw ApiError.conflict(`A tax with code ${payload.code} already exists.`, {
          code: 'TAX_CODE_TAKEN',
          details: { code: payload.code, taxId: clash.id },
        });
      }
    }

    await tax.update(payload, { transaction });

    if (payload.is_default === true) await clearOtherDefaults(tax.id, transaction);

    /*
     * Deactivating the default rate clears the flag with it. A default that is not applicable is a
     * trap: `resolveForInvoice()` filters on `is_active`, so the flag would sit on a row that can
     * never be selected while the screen still showed it as the default.
     */
    if (payload.is_active === false && tax.is_default) {
      await tax.update({ is_default: false }, { transaction });
    }
  });

  await recordAudit(req, {
    tableName: 'taxes',
    recordId: tax.id,
    event: 'update',
    before,
    after: snapshot(tax),
  });

  return findById(tax.id);
}

/**
 * Make one rate the default, or clear the default entirely.
 *
 * Its own operation rather than a `PATCH` field, because it writes rows other than the one named:
 * `PATCH /taxes/7 { is_default: true }` silently demoting tax 3 is the kind of side effect an audit
 * trail should record against an explicit action. `PATCH` still accepts the field — an operator
 * creating a rate and marking it default in one call is reasonable — and both paths go through
 * `clearOtherDefaults()`.
 *
 * @param {import('express').Request} req
 * @param {number|string|null} id  null clears the default without setting another
 * @returns {Promise<{tax: object|null, cleared: number}>}
 */
async function setDefault(req, id) {
  if (id === null) {
    let cleared = 0;
    await db.sequelize.transaction(async (transaction) => {
      cleared = await clearOtherDefaults(null, transaction);
    });

    await recordAudit(req, {
      tableName: 'taxes',
      recordId: null,
      event: 'update',
      reason: 'Cleared the default tax rate',
    });

    return { tax: null, cleared };
  }

  const tax = await findById(id);
  const before = snapshot(tax);
  let cleared = 0;

  if (!tax.is_active) {
    throw ApiError.conflict(`Tax ${tax.code} is inactive and cannot be made the default.`, {
      code: 'TAX_INACTIVE',
      details: { taxId: tax.id, code: tax.code },
    });
  }

  await db.sequelize.transaction(async (transaction) => {
    cleared = await clearOtherDefaults(tax.id, transaction);
    if (!tax.is_default) await tax.update({ is_default: true }, { transaction });
  });

  await recordAudit(req, {
    tableName: 'taxes',
    recordId: tax.id,
    event: 'update',
    before,
    after: snapshot(tax),
    reason: 'Set as the default tax rate',
  });

  return { tax: await findById(tax.id), cleared };
}

/**
 * How many rows point at a tax — the deletion guard from the header.
 *
 * @param {number} taxId
 * @param {object} [transaction]
 * @returns {Promise<{invoices: number}>}
 */
async function referenceCounts(taxId, transaction) {
  const invoices = await db.Invoice.count({ where: { tax_id: taxId }, transaction });
  return { invoices };
}

/**
 * Delete a tax rate, unless an invoice points at it.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @returns {Promise<object>} the deleted row's snapshot
 */
async function destroy(req, id) {
  const tax = await findById(id);
  const before = snapshot(tax);

  await db.sequelize.transaction(async (transaction) => {
    const refs = await referenceCounts(tax.id, transaction);

    if (refs.invoices > 0) {
      throw ApiError.conflict(
        `Tax ${tax.code} is referenced by ${refs.invoices} invoice(s) and cannot be deleted. Deactivate it instead.`,
        { code: 'TAX_IN_USE', details: { taxId: tax.id, ...refs } }
      );
    }

    await tax.destroy({ transaction });
  });

  await recordAudit(req, {
    tableName: 'taxes',
    recordId: before.id,
    event: 'delete',
    before,
  });

  return before;
}

module.exports = {
  list,
  findById,
  resolveForInvoice,
  quoteFor,
  create,
  update,
  setDefault,
  destroy,
  referenceCounts,
  clearOtherDefaults,
  SORTABLE,
};
