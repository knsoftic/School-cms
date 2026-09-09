'use strict';

/**
 * Payment controllers — SRS §13.2 / §13.3, FR-BILL-002/003/004. Thin: the state machine and the money
 * are in `payments.service.js`, the accepted fields in `payments.validation.js`.
 */

const service = require('./payments.service');
const ApiResponse = require('../../utils/ApiResponse');
const money = require('../../utils/money');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');
const ApiError = require('../../utils/ApiError');
const { sendStoredFile } = require('../../utils/fileResponse');

/**
 * A payment plus the one thing a §33 refund screen needs that no column holds: how much of it is still
 * refundable. Derived rather than stored, because it is `amount − refunded_amount` and a stored copy
 * could fall out of step with the refunds that decide it.
 *
 * @param {object} payment
 * @returns {object}
 */
function present(payment) {
  const json = payment.toJSON();
  const received = service.RECEIVED_STATUSES.includes(json.status);
  const refundable = received ? service.refundableAmount(json) : 0;

  /*
   * `screenshot_path` is suppressed, and replaced by the one bit a caller needs.
   *
   * This is the doctrine Known Issues #26 settled and every other module with a stored file already
   * follows — `homework.present()` deletes `attachment_path` and returns `has_attachment` in its
   * place. This module was the exception: it spread the row whole, so the on-disk layout
   * (`school-<id>/payment_proof/<32 hex>.png`) went out with every payment response, telling a caller
   * the directory naming and their own file's exact stored name.
   *
   * Nothing could exploit it — `GET /:id/screenshot` names a *record*, never a path — but a path in a
   * payload is a thing to be tempted by, and the point of the doctrine is that no caller should ever
   * hold one. Found by an adversarial review of this route's design.
   */
  const { screenshot_path: screenshotPath, ...rest } = json;

  return {
    ...rest,
    has_screenshot: Boolean(screenshotPath),
    refundable_amount: refundable,
    is_refundable: money.toMinor(refundable) > 0,
  };
}

/** GET / — one page of payments, confined to the caller's tenant. */
async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req.tenant, req.query, pagination, req);

  return ApiResponse.paginated(
    res,
    { count: result.count, rows: result.rows.map(present) },
    pagination
  );
}

/** GET /:id */
async function show(req, res) {
  const payment = await service.findById(req.tenant, req.params.id);
  return ApiResponse.ok(res, { payment: present(payment) });
}

/**
 * FR-BILL-004's screenshot — the most explicit justification any of these routes has.
 *
 * *"Super Admin reviews the submitted transaction ID **and screenshot**."* Reviewing a screenshot
 * nobody can open is not reviewing it, and until now nothing in this application could open one:
 * `payments.screenshot_path` has been written by every manual payment since §13 and read by nothing.
 *
 * `findById(req.tenant, ...)` is the same load `show` uses, so the tenant boundary that decides which
 * payments a caller may see decides which screenshots they may see, with no second rule to maintain.
 *
 * Served `inline`: a reviewer wants to look at it beside the transaction ID, not save it and open it
 * from a downloads folder.
 */
async function screenshot(req, res) {
  const payment = await service.findById(req.tenant, req.params.id);
  if (!payment.screenshot_path) throw ApiError.notFound('This payment has no screenshot');

  describeActivity(req, {
    entityId: payment.id,
    description: `Viewed the payment proof for ${payment.payment_number}`,
    metadata: { school_id: payment.school_id, payment_number: payment.payment_number },
  });
  return sendStoredFile(res, payment.screenshot_path, {
    filename: `payment-proof-${payment.payment_number}`,
    inline: true,
    schoolId: payment.school_id,
  });
}

/** POST / — FR-BILL-003, a school submits a payment (multipart; screenshot in field `screenshot`). */
async function submit(req, res) {
  const payment = await service.submit(req, req.body);

  describeActivity(req, {
    entityId: payment.id,
    description: `Submitted ${payment.method} payment ${payment.payment_number} for invoice ${payment.invoice_id}`,
    metadata: {
      payment_number: payment.payment_number,
      method: payment.method,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      has_screenshot: Boolean(payment.screenshot_path),
    },
  });

  return ApiResponse.created(
    res,
    { payment: present(payment) },
    {
      message: `Payment ${payment.payment_number} submitted for ${money.format(payment.amount, payment.currency)} — pending review`,
    }
  );
}

/** POST /record — FR-BILL-002, the Super Admin records or charges a payment. */
async function record(req, res) {
  const { payment, settlement, gatewayFailed } = await service.record(req, req.body);

  describeActivity(req, {
    entityId: payment.id,
    description: `Recorded ${payment.method} payment ${payment.payment_number}`,
    metadata: {
      payment_number: payment.payment_number,
      method: payment.method,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      gateway_failed: gatewayFailed,
    },
  });

  const message = gatewayFailed
    ? `Gateway charge for ${payment.payment_number} failed — ${payment.review_note || 'declined'}`
    : `Payment ${payment.payment_number} recorded${settlement ? ` — invoice now ${settlement.status}` : ''}`;

  return ApiResponse.created(
    res,
    { payment: present(payment), settlement: settlement || null, gateway_failed: gatewayFailed },
    { message }
  );
}

/** POST /:id/approve — FR-BILL-004. */
async function approve(req, res) {
  const { payment, settlement } = await service.review(req, req.params.id, 'approve', req.body);

  describeActivity(req, {
    entityId: payment.id,
    description: `Approved payment ${payment.payment_number}`,
    metadata: {
      payment_number: payment.payment_number,
      amount: payment.amount,
      currency: payment.currency,
      invoice_status: settlement ? settlement.status : null,
    },
  });

  return ApiResponse.ok(
    res,
    { payment: present(payment), settlement: settlement || null },
    {
      message: `Payment ${payment.payment_number} approved${settlement ? ` — invoice now ${settlement.status}` : ''}`,
    }
  );
}

/** POST /:id/reject — FR-BILL-004. */
async function reject(req, res) {
  const { payment } = await service.review(req, req.params.id, 'reject', req.body);

  describeActivity(req, {
    entityId: payment.id,
    description: `Rejected payment ${payment.payment_number}`,
    metadata: {
      payment_number: payment.payment_number,
      rejection_reason: payment.rejection_reason || null,
    },
  });

  return ApiResponse.ok(
    res,
    { payment: present(payment) },
    { message: `Payment ${payment.payment_number} rejected` }
  );
}

/** POST /:id/refunds — §33 Refunds, a child of the payment. */
async function createRefund(req, res) {
  const refund = await service.requestRefund(req, req.params.id, req.body);

  describeActivity(req, {
    entityId: refund.id,
    description: `Refund ${refund.refund_number} of ${money.format(refund.amount, refund.currency)} against payment ${refund.payment_id}`,
    metadata: {
      refund_number: refund.refund_number,
      payment_id: refund.payment_id,
      amount: refund.amount,
      currency: refund.currency,
      status: refund.status,
      destination: refund.destination,
    },
  });

  return ApiResponse.created(
    res,
    { refund: refund.toJSON() },
    {
      message: `Refund ${refund.refund_number} completed for ${money.format(refund.amount, refund.currency)}`,
    }
  );
}

/** GET /:id/refunds — the refunds against one payment. */
async function listRefunds(req, res) {
  const refunds = await service.listRefunds(req.tenant, req.params.id);
  return ApiResponse.ok(res, { refunds: refunds.map((refund) => refund.toJSON()) });
}

module.exports = {
  screenshot,
  list,
  show,
  submit,
  record,
  approve,
  reject,
  createRefund,
  listRefunds,
  present,
};
