'use strict';

/**
 * Invoice controllers — SRS §13.1, FR-BILL-001. Thin: the arithmetic is in `invoices.service.js` and
 * the accepted fields in `invoices.validation.js`.
 */

const service = require('./invoices.service');
const paymentPresenter = require('../payments/payments.controller');
const ApiResponse = require('../../utils/ApiResponse');
const money = require('../../utils/money');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');
const { INVOICE_STATUS } = require('../../config/constants');

/**
 * An invoice plus the two things a §13.1 screen needs that no column holds.
 *
 * `is_overdue` is derived rather than read from `status`, because `markOverdue()` is a scheduled sweep
 * that runs once a day (the `invoice-overdue` job, `src/jobs/tasks/invoiceOverdue.js`): between runs an
 * invoice can be past its due date while still labelled `unpaid`. Deriving it means the screen is right
 * at every moment — the status column remains the record, this is the read-time answer.
 *
 * `tax_is_inclusive` is on the joined tax row, and without it a total that does not equal
 * `subtotal − discount + tax` looks like an arithmetic error rather than an inclusive tax.
 *
 * A school caller is shown the coupon as it appears on its bill — code, name and what it takes off —
 * and not the platform's configuration of it. The whole `coupons` row was joined in, so any holder of
 * `invoices.self.view` read which other schools a coupon is restricted to, its plan restrictions and
 * how many times it has been used; coupon reads are otherwise `coupons.view`, which is platform-only.
 *
 * @param {object} invoice
 * @param {object} [tenant]  `req.tenant`; anything short of platform scope is treated as a school
 * @returns {object}
 */
const SCHOOL_COUPON_FIELDS = Object.freeze(['id', 'code', 'name', 'discount_type', 'discount_value', 'currency']);

function present(invoice, tenant) {
  const json = invoice.toJSON();
  const platform = Boolean(tenant && tenant.isPlatform);

  const outstanding = service.OUTSTANDING_STATUSES.includes(json.status);
  const dueDate = json.due_date ? new Date(`${json.due_date}T23:59:59.999Z`) : null;

  return {
    ...json,
    ...(json.coupon && !platform
      ? { coupon: Object.fromEntries(SCHOOL_COUPON_FIELDS.map((key) => [key, json.coupon[key]])) }
      : {}),
    /*
     * The joined payments go out under the rules `payments.controller.present()` applies to a payment
     * on its own: Known Issues #26 — `screenshot_path` is suppressed and replaced by `has_screenshot` —
     * and the reviewer's `review_note` reaches the platform only.
     */
    ...(Array.isArray(json.payments)
      ? { payments: json.payments.map((payment) => paymentPresenter.withoutInternals(payment, tenant)) }
      : {}),
    is_overdue: Boolean(outstanding && dueDate && dueDate.getTime() < Date.now()),
    tax_is_inclusive: json.tax ? Boolean(json.tax.is_inclusive) : false,
  };
}

/** GET / — one page of invoices, confined to the caller's tenant. */
async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req.tenant, req.query, pagination, req);

  return ApiResponse.paginated(
    res,
    { count: result.count, rows: result.rows.map((row) => present(row, req.tenant)) },
    pagination
  );
}

/** GET /:id */
async function show(req, res) {
  const invoice = await service.findById(req.tenant, req.params.id);
  return ApiResponse.ok(res, { invoice: present(invoice, req.tenant) });
}

/** GET /summary — what the caller's scope owes, in one query rather than a summed page. */
async function summary(req, res) {
  const result = await service.outstandingSummary(req.tenant, req.query);
  return ApiResponse.ok(res, { summary: result });
}

/** POST /generate — FR-BILL-001. */
async function generate(req, res) {
  const { subscription_id: subscriptionId, ...payload } = req.body;
  const invoice = await service.generateForSubscription(req, subscriptionId, payload);

  describeActivity(req, {
    entityId: invoice.id,
    description: `Generated invoice ${invoice.invoice_number} for school ${invoice.school_id}`,
    metadata: {
      invoice_number: invoice.invoice_number,
      subscription_id: invoice.subscription_id,
      total: invoice.total,
      currency: invoice.currency,
      status: invoice.status,
      lines: invoice.items ? invoice.items.length : 0,
    },
  });

  return ApiResponse.created(
    res,
    { invoice: present(invoice, req.tenant) },
    {
      message: `Invoice ${invoice.invoice_number} issued for ${money.format(invoice.total, invoice.currency)}`,
    }
  );
}

/** POST /:id/finalise — `draft → unpaid`. */
async function finalise(req, res) {
  const invoice = await service.finalise(req, req.params.id, req.body.reason);

  describeActivity(req, {
    entityId: invoice.id,
    description: `Finalised invoice ${invoice.invoice_number}`,
    metadata: { invoice_number: invoice.invoice_number, status: invoice.status },
  });

  return ApiResponse.ok(
    res,
    { invoice: present(invoice, req.tenant) },
    { message: `Invoice ${invoice.invoice_number} is now ${INVOICE_STATUS.UNPAID}` }
  );
}

/** POST /:id/cancel — not a delete; the service says why. */
async function cancel(req, res) {
  const invoice = await service.cancel(req, req.params.id, req.body.reason);

  describeActivity(req, {
    entityId: invoice.id,
    description: `Cancelled invoice ${invoice.invoice_number}`,
    metadata: { invoice_number: invoice.invoice_number, reason: req.body.reason || null },
  });

  return ApiResponse.ok(
    res,
    { invoice: present(invoice, req.tenant) },
    { message: `Invoice ${invoice.invoice_number} cancelled` }
  );
}

/** POST /:id/coupon — FR-BILL-005's *"School applies a valid coupon to an invoice"*. */
async function applyCoupon(req, res) {
  const invoice = await service.applyCoupon(req, req.params.id, req.body);

  describeActivity(req, {
    entityId: invoice.id,
    description: `Applied coupon ${invoice.coupon_code} to invoice ${invoice.invoice_number}`,
    metadata: {
      invoice_number: invoice.invoice_number,
      coupon_code: invoice.coupon_code,
      discount_amount: invoice.discount_amount,
      total: invoice.total,
    },
  });

  return ApiResponse.ok(
    res,
    { invoice: present(invoice, req.tenant) },
    {
      message: `Coupon ${invoice.coupon_code} applied — ${money.format(invoice.discount_amount, invoice.currency)} off, total now ${money.format(invoice.total, invoice.currency)}`,
    }
  );
}

/** DELETE /:id/coupon — the redemption is unwound too, so *Maximum Uses* stays honest. */
async function removeCoupon(req, res) {
  const invoice = await service.removeCoupon(req, req.params.id, req.body.reason);

  describeActivity(req, {
    entityId: invoice.id,
    description: `Removed the coupon from invoice ${invoice.invoice_number}`,
    metadata: { invoice_number: invoice.invoice_number, total: invoice.total },
  });

  return ApiResponse.ok(
    res,
    { invoice: present(invoice, req.tenant) },
    {
      message: `Coupon removed — total now ${money.format(invoice.total, invoice.currency)}`,
    }
  );
}

module.exports = {
  list,
  show,
  summary,
  generate,
  finalise,
  cancel,
  applyCoupon,
  removeCoupon,
  present,
};
