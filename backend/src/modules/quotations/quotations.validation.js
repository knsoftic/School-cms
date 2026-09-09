'use strict';

/**
 * Quotation schemas — SRS §29 `quotations` (SRS:1445). No FR fixes these fields; they are the
 * table's own columns, with the derived ones refused as inputs.
 *
 * This header used to cite §33 *Quotations* as well. §33's SaaS Engine list does not name Quotations;
 * see `quotations.service.js` for the twenty-one items it does name.
 *
 * ## What the system owns and refuses
 *
 * `subtotal` and `total` are computed from the line items (see `quotations.service`), so they are refused
 * with a 422 that names the owning operation — the pattern `invoices.validation` and `payments.validation`
 * established. `discount_amount` and `tax_amount` are **accepted**, because on a quotation they are the
 * figures a salesperson quotes rather than derivations of a coupon or tax row (the table has no
 * `coupon_id` or `tax_id`). The number, the status, the lifecycle stamps and `converted_invoice_id` are
 * all the flow's to write.
 *
 * ## `accept` carries the invoice's references, not the quote's estimates
 *
 * Converting an accepted quote issues a real invoice, and an invoice's discount must cite a real coupon
 * and its tax a real tax row. So `accept` accepts an optional `tax_id` / `coupon_code` (or `coupon_id`)
 * that the invoice computes from; the quote's own `discount_amount` / `tax_amount` do not carry over.
 * `convert: false` accepts without issuing an invoice at all.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { amount } = require('../plans/plans.validation');
const { QUOTATION_STATUS, INVOICE_STATUS } = require('../../config/constants');

/** `invoice_items.item_type` — mirrored from the model enum (`models/billing.js`). */
const LINE_ITEM_TYPES = Object.freeze(['plan', 'addon', 'setup_fee', 'overage', 'credit', 'custom']);

/**
 * A field the system owns and will not accept — named so `stripUnknown` turns it into a 422 rather than
 * dropping it silently.
 *
 * @param {string} because
 * @returns {import('joi').AnySchema}
 */
const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

/**
 * One quoted line. `amount` (the line total) is required — the service sums it into the subtotal, and
 * `issue()` sums it again on conversion. `unit_amount` is optional and defaults to `amount / quantity`.
 */
const lineItem = Joi.object({
  description: Joi.string().trim().max(255).required(),
  amount: amount().required(),
  quantity: Joi.number().positive().max(100000).default(1),
  unit_amount: amount(),
  item_type: Joi.string()
    .valid(...LINE_ITEM_TYPES)
    .default('custom'),
  metadata: Joi.object().unknown(true).allow(null),
});

const fields = {
  organization_id: Joi.number().integer().min(1).allow(null),
  school_id: Joi.number().integer().min(1).allow(null),
  plan_id: Joi.number().integer().min(1).allow(null),
  plan_price_id: Joi.number().integer().min(1).allow(null),

  prospect_name: Joi.string().trim().max(180).empty('').allow(null),
  prospect_email: Joi.string().trim().max(180).email().empty('').allow(null),
  prospect_phone: Joi.string().trim().max(40).empty('').allow(null),

  currency: Joi.string().trim().uppercase().length(3),
  line_items: Joi.array().items(lineItem),
  discount_amount: amount(),
  tax_amount: amount(),

  valid_until: Joi.date().iso().allow(null),
  notes: Joi.string().trim().max(2000).empty('').allow(null),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

/** Fields the flow writes, refused on create and update. */
const systemOwned = {
  quotation_number: forbiddenField(
    '"quotation_number" is allocated by the system (utils/documentNumber.js) and cannot be set'
  ),
  status: forbiddenField(
    '"status" follows from the flow — a quotation starts as draft, and send/accept/reject move it'
  ),
  subtotal: forbiddenField('"subtotal" is the sum of the line items and cannot be set'),
  total: forbiddenField('"total" is subtotal − discount + tax and cannot be set'),
  sent_at: forbiddenField('"sent_at" is stamped when the quotation is sent'),
  accepted_at: forbiddenField('"accepted_at" is stamped when the quotation is accepted'),
  rejected_at: forbiddenField('"rejected_at" is stamped when the quotation is rejected'),
  converted_invoice_id: forbiddenField(
    '"converted_invoice_id" is the invoice created when the quotation is accepted, not an input'
  ),
  created_by: forbiddenField('"created_by" is the authenticated actor and cannot be set'),
};

/* ─────────────────────────────── Create ─────────────────────────────── */

const create = Joi.object({
  organization_id: fields.organization_id,
  school_id: fields.school_id,
  plan_id: fields.plan_id,
  plan_price_id: fields.plan_price_id,

  prospect_name: fields.prospect_name,
  prospect_email: fields.prospect_email,
  prospect_phone: fields.prospect_phone,

  currency: fields.currency,
  line_items: fields.line_items.min(1).required(),
  discount_amount: fields.discount_amount,
  tax_amount: fields.tax_amount,

  valid_until: fields.valid_until,
  notes: fields.notes,
  reason: fields.reason,

  ...systemOwned,
});

/* ─────────────────────────────── Update (draft only) ─────────────────────────────── */

/** Every field optional, but the body must change *something* — an empty patch is a 422. */
const update = Joi.object({
  organization_id: fields.organization_id,
  school_id: fields.school_id,
  plan_id: fields.plan_id,
  plan_price_id: fields.plan_price_id,

  prospect_name: fields.prospect_name,
  prospect_email: fields.prospect_email,
  prospect_phone: fields.prospect_phone,

  currency: fields.currency,
  line_items: fields.line_items.min(1),
  discount_amount: fields.discount_amount,
  tax_amount: fields.tax_amount,

  valid_until: fields.valid_until,
  notes: fields.notes,
  reason: fields.reason,

  ...systemOwned,
}).min(1);

/* ─────────────────────────────── Lifecycle ─────────────────────────────── */

/** `POST /:id/send` and `POST /:id/reject` — a reason, nothing more. */
const reasonOnly = Joi.object({ reason: fields.reason });

/**
 * `POST /:id/accept`. `convert` defaults to true; the rest are the invoice's references, applied only
 * when a conversion happens.
 */
const accept = Joi.object({
  convert: Joi.boolean().default(true),
  tax_id: Joi.number().integer().min(1),
  coupon_code: Joi.string().trim().max(60),
  coupon_id: Joi.number().integer().min(1),
  issue_date: Joi.date().iso(),
  due_date: Joi.date().iso(),
  due_days: Joi.number().integer().min(0).max(365),
  invoice_status: Joi.string().valid(INVOICE_STATUS.DRAFT, INVOICE_STATUS.UNPAID),
  reason: fields.reason,
});

/* ───────────────────────────────── Queries ───────────────────────────────── */

const list = listQuery(
  Joi.object({
    school_id: Joi.number().integer().min(1),
    organization_id: Joi.number().integer().min(1),
    plan_id: Joi.number().integer().min(1),
    status: Joi.string().valid(...Object.values(QUOTATION_STATUS)),
    currency: fields.currency,
    number: Joi.string().trim().max(40),
    from: Joi.date().iso(),
    to: Joi.date().iso(),
    valid_from: Joi.date().iso(),
    valid_to: Joi.date().iso(),
  })
);

module.exports = {
  schemas: {
    create,
    update,
    accept,
    send: reasonOnly,
    reject: reasonOnly,
    list,
    idParam: commonSchemas.idParam,
  },
  fields,
  systemOwned,
  LINE_ITEM_TYPES,
};
