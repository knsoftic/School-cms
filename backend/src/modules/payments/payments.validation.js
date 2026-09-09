'use strict';

/**
 * Payment, review and refund request schemas — SRS §13.2 / §13.3, FR-BILL-002/003/004.
 *
 * ## `amount` is accepted here, unlike on an invoice — and that is the difference between the two
 *
 * An invoice's `total` is refused at validation because the document *computes* it. A payment's `amount`
 * is the opposite: it is the fact the request is asserting — "this much money arrived" — so it is a
 * required input, not a derivation. Everything the *system* owns is still refused: the number
 * (`documentNumber.js`), the `status` (the flow decides it), `refunded_amount` (a sum of refunds), the
 * review columns, and `screenshot_path`, which is derived from the uploaded file rather than sent as
 * text. A request that puts one of those in the body gets a 422 that says which operation owns it, the
 * pattern `invoices.validation.js` established.
 *
 * ## Why `submit` and `record` accept different method sets
 *
 * FR-BILL-003 (a *school* submitting) does not allow `online_gateway`: a school-initiated online charge
 * is a redirect/webhook flow §13 does not specify, so `submit` accepts only the four methods that resolve
 * to a Super-Admin review — cash, bank transfer, manual payment, wallet. FR-BILL-002 (a *Super Admin*
 * recording) accepts all five, because on that path `online_gateway` dispatches a live charge through the
 * plugin registry rather than becoming a pending record.
 *
 * ## Approve and reject are two schemas, not one with a mode flag
 *
 * They take different fields — a rejection carries a `rejection_reason` the school will see, an approval
 * carries only an internal `note` — and a single schema with both optional would accept a rejection with
 * no reason and an approval carrying a rejection reason. Two schemas keep each route's body honest.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { amount } = require('../plans/plans.validation');
const {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LIST,
  PAYMENT_STATUS,
} = require('../../config/constants');

/** FR-BILL-003 — every method except the gateway, which a school does not drive. See the header. */
const SUBMITTABLE_METHODS = Object.freeze(
  PAYMENT_METHOD_LIST.filter((method) => method !== PAYMENT_METHODS.ONLINE_GATEWAY)
);

/**
 * A field the system owns and will not accept — named so `stripUnknown` turns it into a 422 rather than
 * dropping it silently.
 *
 * @param {string} because
 * @returns {import('joi').AnySchema}
 */
const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

const fields = {
  invoice_id: Joi.number().integer().min(1),
  subscription_id: Joi.number().integer().min(1),
  school_id: Joi.number().integer().min(1),

  currency: Joi.string().trim().uppercase().length(3),
  gateway_key: Joi.string().trim().max(60),

  /* §13.3 — *"enters a transaction ID"*. Free text: a bank reference, a gateway id, a cheque number. */
  transaction_id: Joi.string().trim().max(160).empty('').allow(null),
  reference: Joi.string().trim().max(160).empty('').allow(null),
  payer_note: Joi.string().trim().max(500).empty('').allow(null),

  /* When the school says the money actually moved. Distinct from when the row was created. */
  paid_at: Joi.date().iso(),

  /* Internal note the reviewer leaves; not shown to the school. */
  note: Joi.string().trim().max(500).empty('').allow(null),
  /* The reason a rejection gives, which the school does see. */
  rejection_reason: Joi.string().trim().max(255).empty('').allow(null),

  destination: Joi.string().valid('original_method', 'wallet'),

  metadata: Joi.object().unknown(true).allow(null),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

/** The system-owned fields refused on every create path. */
const systemOwned = {
  payment_number: forbiddenField(
    '"payment_number" is allocated by the system (utils/documentNumber.js) and cannot be set'
  ),
  status: forbiddenField(
    '"status" follows from the flow — a submission is always pending, and review decides the rest (FR-BILL-004)'
  ),
  refunded_amount: forbiddenField(
    '"refunded_amount" is the sum of completed refunds against this payment and cannot be set'
  ),
  reviewed_by: forbiddenField('"reviewed_by" is the reviewing Super Admin, recorded by the review operation'),
  reviewed_at: forbiddenField('"reviewed_at" is stamped by the review operation'),
  review_note: forbiddenField('"review_note" is written by the review operation'),
  rejection_reason: forbiddenField('"rejection_reason" is written when a payment is rejected (FR-BILL-004)'),
  screenshot_path: forbiddenField(
    '"screenshot_path" is derived from the uploaded file (field "screenshot"), not sent as text'
  ),
  submitted_by: forbiddenField('"submitted_by" is the authenticated actor and cannot be set'),
};

/* ────────────────── FR-BILL-003 — School submits a payment ────────────────── */

/**
 * `POST /payments` (multipart, the screenshot is field `screenshot`).
 *
 * `amount` and `method` are required; the coerced string values multipart delivers pass through Joi's
 * number/date conversion. `online_gateway` is refused by the method allow-list, not by a separate check.
 */
const submit = Joi.object({
  invoice_id: fields.invoice_id.required(),
  amount: amount().greater(0).required(),
  method: Joi.string()
    .valid(...SUBMITTABLE_METHODS)
    .required()
    .messages({
      'any.only': `"method" must be one of ${SUBMITTABLE_METHODS.join(', ')} — online gateway payments are processed by the platform, not submitted (FR-BILL-003)`,
    }),

  currency: fields.currency,
  transaction_id: fields.transaction_id,
  reference: fields.reference,
  payer_note: fields.payer_note,
  paid_at: fields.paid_at,
  metadata: fields.metadata,
  reason: fields.reason,

  ...systemOwned,
  gateway_key: forbiddenField(
    '"gateway_key" is not accepted on a submitted payment — online gateway payments are recorded by the platform (FR-BILL-003)'
  ),
});

/* ────────────────── FR-BILL-002 — Super Admin records a payment ────────────────── */

/**
 * `POST /payments/record`.
 *
 * Accepts all five methods. `gateway_key` is optional and only meaningful for `online_gateway`; when
 * omitted the service falls back to the registry's default. The service raises the 422 when a gateway
 * method is asked for and no adapter is registered.
 */
const record = Joi.object({
  invoice_id: fields.invoice_id.required(),
  amount: amount().greater(0).required(),
  method: Joi.string()
    .valid(...PAYMENT_METHOD_LIST)
    .required(),

  gateway_key: fields.gateway_key,
  currency: fields.currency,
  transaction_id: fields.transaction_id,
  reference: fields.reference,
  payer_note: fields.payer_note,
  paid_at: fields.paid_at,
  metadata: fields.metadata,
  reason: fields.reason,

  ...systemOwned,
});

/* ────────────────── FR-BILL-004 — Super Admin approves or rejects ────────────────── */

/** `POST /payments/:id/approve`. */
const approve = Joi.object({
  note: fields.note,
  reason: fields.reason,
});

/** `POST /payments/:id/reject`. */
const reject = Joi.object({
  rejection_reason: fields.rejection_reason,
  note: fields.note,
  reason: fields.reason,
});

/* ─────────────────────────── Refunds (§33) ─────────────────────────── */

/**
 * `POST /payments/:id/refunds`.
 *
 * `amount` is optional — omitted means the full refundable balance, which is the common case. The
 * service caps it at what is still refundable and refuses a zero or negative figure.
 */
const createRefund = Joi.object({
  amount: amount().greater(0),
  reason: fields.reason,
  destination: fields.destination.default('original_method'),
  metadata: fields.metadata,
});

/* ───────────────────────────── Queries ───────────────────────────── */

const list = listQuery(
  Joi.object({
    school_id: fields.school_id,
    invoice_id: fields.invoice_id,
    subscription_id: fields.subscription_id,
    status: Joi.string().valid(...Object.values(PAYMENT_STATUS)),
    method: Joi.string().valid(...PAYMENT_METHOD_LIST),
    currency: fields.currency,
    /** Shorthand for the pending queue a reviewer works from. */
    pending: Joi.boolean(),
    from: Joi.date().iso(),
    to: Joi.date().iso(),
    /** Partial match on `payment_number` — what a search box sends. */
    number: Joi.string().trim().max(40),
  })
);

module.exports = {
  schemas: {
    submit,
    record,
    approve,
    reject,
    createRefund,
    list,
    idParam: commonSchemas.idParam,
  },
  fields,
  systemOwned,
  SUBMITTABLE_METHODS,
};
