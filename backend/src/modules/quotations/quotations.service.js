'use strict';

/**
 * Quotations — SRS §29's `quotations` table (SRS:1445), and that table is the **only** warrant.
 *
 * §33's SaaS Engine list does **not** name Quotations. Its twenty-one items (SRS:1617-1637) are
 * Trial, Subscription, Renewal, Upgrade, Downgrade, Proration, Grace Period, Expiry, Suspension,
 * Add-ons, Usage Tracking, Overage, Coupons, Discounts, Taxes, Invoices, Payments, Refunds, Custom
 * Pricing, Custom Limits and Feature Overrides — and `grep -i quotation` over the whole 1,698-line
 * document returns exactly one hit: the table name at :1445. This header, the validation and
 * controller headers, and all seven rows of the route table cited §33 for this module; the citation
 * was invented. The same sentence in the same form is already written at `roles.validation.js:12`
 * for the Roles screen, which §33 likewise does not list.
 *
 * Whether a bare table name warrants the five-state lifecycle below — with automatic invoice
 * issuance on accept — is a §35:1668 "Additional workflows" question the SRS does not answer.
 * Correcting the citation does not settle it, and is not an argument for either answer.
 *
 * ## No FR, so every rule here is derived from the columns and stated as such
 *
 * §13 gives quotations no functional requirement and no field list; the behaviour below is read off the
 * schema — the `QUOTATION_STATUS` enum (`draft, sent, accepted, rejected, expired`), the `sent_at` /
 * `accepted_at` / `rejected_at` stamps, `valid_until`, and `converted_invoice_id` whose own comment is
 * *"Invoice created when the quotation is accepted."* Nothing is invented beyond making those columns do
 * what they name.
 *
 * A quotation is the **pre-sales** document: it may precede the school existing, which is why
 * `organization_id` and `school_id` are both nullable and `prospect_name` / `prospect_email` /
 * `prospect_phone` exist to name a lead who is not yet a tenant.
 *
 * ## The money model — subtotal and total are derived, discount and tax are quoted
 *
 * `subtotal` is the sum of the line amounts and `total` is `subtotal − discount + tax`; both are computed
 * here and refused as inputs, the same discipline `invoices.service` applies. `discount_amount` and
 * `tax_amount`, however, are **operator-quoted flat figures**, not references: the `quotations` table has
 * no `coupon_id` and no `tax_id`, so a quote's discount and tax are estimates a salesperson names, not the
 * live `coupons` / `taxes` rows an invoice must cite. That distinction is the whole reason conversion
 * (below) recomputes rather than copies.
 *
 * ## Lifecycle — one writer per edge, mirroring `invoices.service`
 *
 *  - **`create()`** → `draft`. The only state in which a quotation is editable.
 *  - **`update()`** — `draft` only. Re-derives the totals when lines, discount or tax change.
 *  - **`send()`** — `draft → sent`, stamps `sent_at`. Marks the quote as offered.
 *  - **`accept()`** — `draft|sent → accepted`, stamps `accepted_at`, and (by default) converts to an
 *    invoice. Accepting a `draft` without a prior `send()` is allowed: the enum fixes no ordering, an
 *    operator may record a quote accepted the moment it is drawn up, and the only real precondition is
 *    that the quote is still open.
 *  - **`reject()`** — `draft|sent → rejected`, stamps `rejected_at`.
 *  - **`expireLapsed()`** — `sent → expired` for quotes past `valid_until`. The clock is the actor, so —
 *    like `invoices.markOverdue()` and `subscriptions.runLifecycleSweep()` — it has **no route**; it is
 *    called daily by `jobs/tasks/quotationExpiry.js` and directly by `scripts/verify-billing.js`. Only `sent` quotes
 *    expire: a `draft` is an unsent working document, not an offer that can lapse.
 *
 * `accepted`, `rejected` and `expired` are terminal.
 *
 * ## Conversion — the one place `invoices.service.issue()` is called from outside its own module
 *
 * `invoices.service`'s header states plainly that `issue()` *"is exported for `quotations.service` to
 * call, because `quotations.converted_invoice_id` is a column and something has to fill it."* This is that
 * caller. Conversion runs **inside the accept transaction** so a rolled-back acceptance cannot leave an
 * orphan invoice and a failed invoice cannot leave a quote marked accepted — `issue()` is handed the
 * transaction, and its `withRetry` becomes this function's to own (its header says as much).
 *
 * The converted invoice is built from the quotation's **line items**, not its quoted totals: the quote's
 * `discount_amount` / `tax_amount` are the non-binding estimates described above, and an invoice's
 * discount has to decrement a real coupon's usage and its tax has to record a `tax_rate_percent`. So the
 * operator may pass a real `tax_id` and/or `coupon_code` at acceptance and the invoice computes its own
 * §13.1 figures from them; absent those, the invoice total is the line subtotal. Stated rather than
 * hidden: a quote that estimated tax and is accepted without a `tax_id` produces an invoice with no tax,
 * which is correct — a real tax row is the only thing that can carry the rate.
 *
 * Conversion requires `school_id`: an invoice (and every `invoice_item`) needs a school to belong to, so
 * accepting a quote for a pure prospect with `convert: true` (the default) is **refused** with
 * `QUOTATION_NOT_CONVERTIBLE`. The operator either names the school on the quotation first, or accepts
 * with `convert: false`, which accepts without invoicing in every case. There is no later conversion:
 * accepting is only possible while the quotation is open, so one accepted without an invoice keeps a
 * null `converted_invoice_id` for good.
 *
 * ## Scope
 *
 * `config/permissions.js` seeds `quotations.view` and `quotations.manage` to `super_admin` alone —
 * quotations are a platform sales activity. `tenantWhere()` is still used on every read, so a future
 * re-grant to an organization admin would confine them to their own rows rather than exposing the lot.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const money = require('../../utils/money');
const dates = require('../../utils/dates');
const documentNumber = require('../../utils/documentNumber');
const invoicesService = require('../invoices/invoices.service');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { tenantWhere } = require('../../models');
const { QUOTATION_STATUS } = require('../../config/constants');

const SORTABLE = Object.freeze([
  'created_at',
  'quotation_number',
  'valid_until',
  'total',
  'status',
  'sent_at',
  'accepted_at',
]);
const DEFAULT_SORT = Object.freeze(['created_at', 'DESC']);

/** The non-terminal states — the ones an accept/reject may still move. */
const OPEN_STATUSES = Object.freeze([QUOTATION_STATUS.DRAFT, QUOTATION_STATUS.SENT]);

/* ─────────────────────────────── Reads ─────────────────────────────── */

function detailInclude() {
  return [
    { model: db.SubscriptionPlan, as: 'plan' },
    { model: db.PlanPrice, as: 'planPrice' },
    { model: db.Invoice, as: 'convertedInvoice' },
  ];
}

/** `req.user.id`, or `null` when a sweep is the actor. Mirrors the sibling billing services. */
function performerOf(req) {
  return req && req.user && req.user.id ? req.user.id : null;
}

/**
 * One page of quotations, confined to the caller's tenant.
 *
 * @param {object} tenant
 * @param {object} query
 * @param {{page: number, limit: number, offset: number}} pagination
 * @param {import('express').Request} req
 * @returns {Promise<{rows: object[], count: number}>}
 */
async function list(tenant, query, pagination, req) {
  const where = tenantWhere(tenant, {});

  if (query.school_id) where.school_id = query.school_id;
  if (query.organization_id) where.organization_id = query.organization_id;
  if (query.plan_id) where.plan_id = query.plan_id;
  if (query.status) where.status = query.status;
  if (query.currency) where.currency = query.currency;

  if (query.number) {
    where.quotation_number = { [Op.like]: `%${String(query.number).trim().toUpperCase()}%` };
  }

  if (query.from || query.to) {
    where.created_at = {
      ...(query.from ? { [Op.gte]: query.from } : {}),
      ...(query.to ? { [Op.lte]: query.to } : {}),
    };
  }

  /* `valid_until` is DATEONLY, so both bounds compare as dates rather than instants. */
  if (query.valid_from || query.valid_to) {
    where.valid_until = {
      ...(query.valid_from ? { [Op.gte]: dates.toDateOnly(query.valid_from) } : {}),
      ...(query.valid_to ? { [Op.lte]: dates.toDateOnly(query.valid_to) } : {}),
    };
  }

  return paginateQuery(
    db.Quotation,
    { where, order: getSort(req, SORTABLE, DEFAULT_SORT), include: detailInclude() },
    pagination
  );
}

/**
 * One quotation, or a 404. The tenant scope is folded into the `where`.
 *
 * @param {object} tenant
 * @param {number|string} id
 * @param {{detail?: boolean, transaction?: object, lock?: boolean}} [options]
 * @returns {Promise<object>}
 */
async function findById(tenant, id, options = {}) {
  const quotation = await db.Quotation.findOne({
    where: tenantWhere(tenant, { id }),
    include: options.detail === false ? undefined : detailInclude(),
    transaction: options.transaction,
    ...(options.lock && options.transaction ? { lock: options.transaction.LOCK.UPDATE } : {}),
  });

  if (!quotation) throw ApiError.notFound('Quotation not found', { code: 'QUOTATION_NOT_FOUND' });
  return quotation;
}

/* ─────────────────────────────── Money ─────────────────────────────── */

/**
 * Normalise one quoted line to the invoice-item shape `issue()` consumes.
 *
 * `amount` (the line total) is authoritative — `issue()` sums it into the subtotal. `unit_amount`
 * defaults to `amount / quantity` when the caller sends only a lump figure, and `item_type` defaults to
 * `custom`, the enum member for a line that is neither a plan nor an add-on.
 *
 * @param {object} line
 * @returns {object}
 */
function normaliseLine(line) {
  const quantity = Number(line.quantity) > 0 ? Number(line.quantity) : 1;
  const amount = money.round(line.amount);
  const unitAmount =
    line.unit_amount !== undefined && line.unit_amount !== null
      ? money.round(line.unit_amount)
      : money.round(Number(amount) / quantity);

  return {
    item_type: line.item_type || 'custom',
    description: String(line.description).slice(0, 255),
    quantity,
    unit_amount: unitAmount,
    amount,
    metadata: line.metadata || null,
  };
}

/**
 * `subtotal`, `discount_amount`, `tax_amount`, `total` — subtotal and total derived, discount and tax
 * taken as quoted figures (see the header). Pure: directly assertable by `scripts/verify-billing.js`.
 *
 * @param {Array<{amount: number}>} lines already normalised
 * @param {number} [discountInput]
 * @param {number} [taxInput]
 * @returns {{subtotal: number, discountAmount: number, taxAmount: number, total: number}}
 */
function computeTotals(lines, discountInput = 0, taxInput = 0) {
  const subtotal = money.clampNonNegative(money.sum(lines.map((line) => line.amount)));

  let discount = money.clampNonNegative(discountInput || 0);
  /* A quoted discount cannot exceed what is being quoted. */
  if (money.toMinor(discount) > money.toMinor(subtotal)) discount = subtotal;

  const tax = money.clampNonNegative(taxInput || 0);
  const total = money.clampNonNegative(money.sum([money.subtract(subtotal, discount), tax]));

  return { subtotal, discountAmount: discount, taxAmount: tax, total };
}

/* ─────────────────────────────── Writes ─────────────────────────────── */

/**
 * Create a `draft` quotation. Allocates `quotation_number` (prefix `QTN`) under `withRetry`, the same
 * number-allocation discipline every billing document uses.
 *
 * @param {import('express').Request} req
 * @param {object} spec
 * @returns {Promise<object>}
 */
async function create(req, spec) {
  const lines = (spec.line_items || []).map(normaliseLine);
  if (!lines.length) {
    throw new ApiError(422, 'A quotation needs at least one line item', {
      code: 'QUOTATION_NO_LINES',
    });
  }

  const totals = computeTotals(lines, spec.discount_amount, spec.tax_amount);

  const quotation = await documentNumber.withRetry(
    () =>
      db.sequelize.transaction(async (transaction) => {
        const number = await documentNumber.nextNumber(db.Quotation, {
          column: 'quotation_number',
          prefix: documentNumber.PREFIXES.QUOTATION,
          transaction,
        });

        return db.Quotation.create(
          {
            quotation_number: number,
            organization_id: spec.organization_id || null,
            school_id: spec.school_id || null,
            prospect_name: spec.prospect_name || null,
            prospect_email: spec.prospect_email || null,
            prospect_phone: spec.prospect_phone || null,
            plan_id: spec.plan_id || null,
            plan_price_id: spec.plan_price_id || null,
            currency: spec.currency || 'USD',
            subtotal: totals.subtotal,
            discount_amount: totals.discountAmount,
            tax_amount: totals.taxAmount,
            total: totals.total,
            line_items: lines,
            status: QUOTATION_STATUS.DRAFT,
            valid_until: spec.valid_until ? dates.toDateOnly(spec.valid_until) : null,
            notes: spec.notes || null,
            created_by: performerOf(req),
          },
          { transaction }
        );
      }),
    { column: 'quotation_number' }
  );

  await recordAudit(req, {
    tableName: 'quotations',
    recordId: quotation.id,
    event: 'create',
    after: snapshot(quotation),
    reason: spec.reason || null,
  });

  return findById(req.tenant, quotation.id);
}

/**
 * Edit a `draft` quotation. Refused in any other state, because a sent or decided quote is a record of
 * what a prospect was offered.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} spec
 * @returns {Promise<object>}
 */
async function update(req, id, spec) {
  const quotation = await findById(req.tenant, id, { detail: false });

  if (quotation.status !== QUOTATION_STATUS.DRAFT) {
    throw ApiError.conflict('Only a draft quotation can be edited', {
      code: 'QUOTATION_NOT_EDITABLE',
      details: { status: quotation.status },
    });
  }

  const before = snapshot(quotation);
  const patch = {};

  ['prospect_name', 'prospect_email', 'prospect_phone', 'currency', 'notes'].forEach((key) => {
    if (spec[key] !== undefined) patch[key] = spec[key];
  });
  if (spec.organization_id !== undefined) patch.organization_id = spec.organization_id || null;
  if (spec.school_id !== undefined) patch.school_id = spec.school_id || null;
  if (spec.plan_id !== undefined) patch.plan_id = spec.plan_id || null;
  if (spec.plan_price_id !== undefined) patch.plan_price_id = spec.plan_price_id || null;
  if (spec.valid_until !== undefined) {
    patch.valid_until = spec.valid_until ? dates.toDateOnly(spec.valid_until) : null;
  }

  /* Re-derive the totals whenever any figure that feeds them is touched. */
  const linesTouched = spec.line_items !== undefined;
  const discountTouched = spec.discount_amount !== undefined;
  const taxTouched = spec.tax_amount !== undefined;

  if (linesTouched || discountTouched || taxTouched) {
    const lines = linesTouched
      ? (spec.line_items || []).map(normaliseLine)
      : quotation.line_items || [];

    if (!lines.length) {
      throw new ApiError(422, 'A quotation needs at least one line item', {
        code: 'QUOTATION_NO_LINES',
      });
    }

    const discount = discountTouched ? spec.discount_amount : quotation.discount_amount;
    const tax = taxTouched ? spec.tax_amount : quotation.tax_amount;
    const totals = computeTotals(lines, discount, tax);

    patch.line_items = lines;
    patch.subtotal = totals.subtotal;
    patch.discount_amount = totals.discountAmount;
    patch.tax_amount = totals.taxAmount;
    patch.total = totals.total;
  }

  await quotation.update(patch);

  await recordAudit(req, {
    tableName: 'quotations',
    recordId: quotation.id,
    event: 'update',
    before,
    after: snapshot(quotation),
    reason: spec.reason || null,
  });

  return findById(req.tenant, quotation.id);
}

/**
 * Move a plain status edge (`send` / `reject`) and stamp its column. Shared by the two transitions that
 * only touch the quotation row.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {{from: string[], to: string, stamp: string, event: string, code: string, message: string}} edge
 * @param {string|null} reason
 * @returns {Promise<object>}
 */
async function moveStatus(req, id, edge, reason) {
  const quotation = await findById(req.tenant, id, { detail: false });

  if (!edge.from.includes(quotation.status)) {
    throw ApiError.conflict(edge.message, {
      code: edge.code,
      details: { status: quotation.status },
    });
  }

  const before = snapshot(quotation);
  await quotation.update({ status: edge.to, [edge.stamp]: new Date() });

  /* `audit_logs.event` is only create|update|delete|restore — send/reject are updates. */
  await recordAudit(req, {
    tableName: 'quotations',
    recordId: quotation.id,
    event: edge.event,
    before,
    after: snapshot(quotation),
    reason: reason || null,
  });

  return findById(req.tenant, quotation.id);
}

/** `draft → sent`. */
function send(req, id, reason = null) {
  return moveStatus(
    req,
    id,
    {
      from: [QUOTATION_STATUS.DRAFT],
      to: QUOTATION_STATUS.SENT,
      stamp: 'sent_at',
      event: 'update',
      code: 'QUOTATION_NOT_SENDABLE',
      message: 'Only a draft quotation can be sent',
    },
    reason
  );
}

/** `draft|sent → rejected`. */
function reject(req, id, reason = null) {
  return moveStatus(
    req,
    id,
    {
      from: OPEN_STATUSES,
      to: QUOTATION_STATUS.REJECTED,
      stamp: 'rejected_at',
      event: 'update',
      code: 'QUOTATION_NOT_OPEN',
      message: 'Only an open quotation can be rejected',
    },
    reason
  );
}

/**
 * `draft|sent → accepted`, converting to an invoice unless `spec.convert === false` — the one caller of
 * `invoices.service.issue()` from outside its module. See the header for why conversion recomputes rather
 * than copies the quoted totals, and why it needs a `school_id`.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} [spec]
 * @returns {Promise<object>}
 */
async function accept(req, id, spec = {}) {
  /* Detailed read for the plan-name snapshot and to surface a clear state error before the transaction. */
  const existing = await findById(req.tenant, id);
  if (!OPEN_STATUSES.includes(existing.status)) {
    throw ApiError.conflict('Only an open quotation can be accepted', {
      code: 'QUOTATION_NOT_OPEN',
      details: { status: existing.status },
    });
  }

  const convert = spec.convert !== false;

  await documentNumber.withRetry(
    () =>
      db.sequelize.transaction(async (transaction) => {
        const quotation = await db.Quotation.findOne({
          where: tenantWhere(req.tenant, { id }),
          transaction,
          lock: transaction.LOCK.UPDATE,
        });

        if (!quotation) {
          throw ApiError.notFound('Quotation not found', { code: 'QUOTATION_NOT_FOUND' });
        }
        /* Re-check under the lock — a concurrent accept/reject may have closed it. */
        if (!OPEN_STATUSES.includes(quotation.status)) {
          throw ApiError.conflict('Only an open quotation can be accepted', {
            code: 'QUOTATION_NOT_OPEN',
            details: { status: quotation.status },
          });
        }

        if (convert && !quotation.converted_invoice_id) {
          if (!quotation.school_id) {
            throw new ApiError(
              422,
              'A quotation for a prospect with no school cannot be converted to an invoice',
              { code: 'QUOTATION_NOT_CONVERTIBLE' }
            );
          }

          const lines = (quotation.line_items || []).filter((line) => line && line.description);
          if (!lines.length) {
            throw new ApiError(422, 'This quotation has no line items to invoice', {
              code: 'QUOTATION_NO_LINES',
            });
          }

          const invoice = await invoicesService.issue(
            req,
            {
              schoolId: quotation.school_id,
              organizationId: quotation.organization_id,
              planId: quotation.plan_id,
              planName: existing.plan ? existing.plan.name : null,
              currency: quotation.currency,
              lines: lines.map((line) => ({
                item_type: line.item_type || 'custom',
                description: line.description,
                quantity: line.quantity,
                unit_amount: line.unit_amount,
                amount: line.amount,
                metadata: line.metadata || null,
              })),
              /* Real references, supplied at acceptance — the quote's own figures are estimates. */
              taxId: spec.tax_id,
              couponCode: spec.coupon_code,
              couponId: spec.coupon_id,
              issueDate: spec.issue_date,
              dueDate: spec.due_date,
              dueDays: spec.due_days,
              notes: quotation.notes,
              status: spec.invoice_status,
              metadata: {
                quotation_id: quotation.id,
                quotation_number: quotation.quotation_number,
              },
              reason: spec.reason || `Converted from quotation ${quotation.quotation_number}`,
            },
            { transaction }
          );

          quotation.converted_invoice_id = invoice.id;
        }

        quotation.status = QUOTATION_STATUS.ACCEPTED;
        quotation.accepted_at = new Date();
        await quotation.save({ transaction });
      }),
    /* The retryable number is the invoice's; `issue()` allocates it inside this transaction. */
    { column: 'invoice_number' }
  );

  const quotation = await findById(req.tenant, id);

  await recordAudit(req, {
    tableName: 'quotations',
    recordId: quotation.id,
    event: 'update',
    before: snapshot(existing),
    after: snapshot(quotation),
    reason: spec.reason || null,
  });

  return quotation;
}

/* ─────────────────────────── Scheduled sweep ─────────────────────────── */

/**
 * `sent → expired` for every quote whose `valid_until` is before the reference date. The clock's, so no
 * route — called daily by `jobs/tasks/quotationExpiry.js`, and by `scripts/verify-billing.js` and
 * `scripts/verify-jobs.js`. Bulk `update`, mirroring `invoices.markOverdue()`.
 *
 * @param {{asOf?: Date|string, transaction?: object}} [options]
 * @returns {Promise<{expired: number}>}
 */
async function expireLapsed(options = {}) {
  const asOf = dates.toDateOnly(options.asOf || new Date());

  /* `validate: false` — same Sequelize 6 skeleton-validator trap as `coupons.expireLapsed()`.
   * The payload is only `{ status }`; model-level validators would run against defaults, not
   * the matching rows. This sweep is a status flip. */
  const [expired] = await db.Quotation.update(
    { status: QUOTATION_STATUS.EXPIRED },
    {
      where: {
        status: QUOTATION_STATUS.SENT,
        valid_until: { [Op.lt]: asOf },
      },
      validate: false,
      ...(options.transaction ? { transaction: options.transaction } : {}),
    }
  );

  return { expired };
}

module.exports = {
  list,
  findById,
  create,
  update,
  send,
  accept,
  reject,
  expireLapsed,
  computeTotals,
  normaliseLine,
  SORTABLE,
  OPEN_STATUSES,
};
