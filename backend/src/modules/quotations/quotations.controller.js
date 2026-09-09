'use strict';

/**
 * Quotation controllers — SRS §29 `quotations` (SRS:1445); §33 does not list Quotations. Thin: the
 * lifecycle and the money are in
 * `quotations.service.js`, the accepted fields in `quotations.validation.js`.
 */

const service = require('./quotations.service');
const ApiResponse = require('../../utils/ApiResponse');
const money = require('../../utils/money');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');
const { QUOTATION_STATUS } = require('../../config/constants');

/**
 * A quotation plus `is_expired` — derived, not read from `status`, for the same reason
 * `invoices.present()` derives `is_overdue`: `expireLapsed()` is a scheduled sweep and `src/jobs/` does
 * not exist yet, so a `sent` quote can be past its `valid_until` while still labelled `sent`. Deriving it
 * keeps the screen right today and right once the cron lands.
 *
 * @param {object} quotation
 * @returns {object}
 */
function present(quotation) {
  const json = quotation.toJSON();
  const validUntil = json.valid_until ? new Date(`${json.valid_until}T23:59:59.999Z`) : null;

  return {
    ...json,
    is_expired: Boolean(
      json.status === QUOTATION_STATUS.SENT && validUntil && validUntil.getTime() < Date.now()
    ),
  };
}

/** GET / — one page of quotations, confined to the caller's tenant. */
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
  const quotation = await service.findById(req.tenant, req.params.id);
  return ApiResponse.ok(res, { quotation: present(quotation) });
}

/** POST / — create a draft quotation. */
async function create(req, res) {
  const quotation = await service.create(req, req.body);

  describeActivity(req, {
    entityId: quotation.id,
    description: `Created quotation ${quotation.quotation_number}`,
    metadata: {
      quotation_number: quotation.quotation_number,
      school_id: quotation.school_id,
      total: quotation.total,
      currency: quotation.currency,
      lines: quotation.line_items ? quotation.line_items.length : 0,
    },
  });

  return ApiResponse.created(
    res,
    { quotation: present(quotation) },
    {
      message: `Quotation ${quotation.quotation_number} drafted for ${money.format(quotation.total, quotation.currency)}`,
    }
  );
}

/** PATCH /:id — edit a draft. */
async function update(req, res) {
  const quotation = await service.update(req, req.params.id, req.body);

  describeActivity(req, {
    entityId: quotation.id,
    description: `Updated quotation ${quotation.quotation_number}`,
    metadata: {
      quotation_number: quotation.quotation_number,
      total: quotation.total,
      currency: quotation.currency,
    },
  });

  return ApiResponse.ok(
    res,
    { quotation: present(quotation) },
    { message: `Quotation ${quotation.quotation_number} updated` }
  );
}

/** POST /:id/send — draft → sent. */
async function send(req, res) {
  const quotation = await service.send(req, req.params.id, req.body.reason);

  describeActivity(req, {
    entityId: quotation.id,
    description: `Sent quotation ${quotation.quotation_number}`,
    metadata: { quotation_number: quotation.quotation_number, valid_until: quotation.valid_until },
  });

  return ApiResponse.ok(
    res,
    { quotation: present(quotation) },
    { message: `Quotation ${quotation.quotation_number} sent` }
  );
}

/** POST /:id/accept — draft|sent → accepted, converting to an invoice unless `convert: false`. */
async function accept(req, res) {
  const quotation = await service.accept(req, req.params.id, req.body);
  const invoice = quotation.convertedInvoice || null;

  describeActivity(req, {
    entityId: quotation.id,
    description: `Accepted quotation ${quotation.quotation_number}${invoice ? ` → invoice ${invoice.invoice_number}` : ''}`,
    metadata: {
      quotation_number: quotation.quotation_number,
      converted_invoice_id: quotation.converted_invoice_id,
      invoice_number: invoice ? invoice.invoice_number : null,
    },
  });

  return ApiResponse.ok(
    res,
    { quotation: present(quotation) },
    {
      message: `Quotation ${quotation.quotation_number} accepted${invoice ? ` — invoice ${invoice.invoice_number} issued` : ''}`,
    }
  );
}

/** POST /:id/reject — draft|sent → rejected. */
async function reject(req, res) {
  const quotation = await service.reject(req, req.params.id, req.body.reason);

  describeActivity(req, {
    entityId: quotation.id,
    description: `Rejected quotation ${quotation.quotation_number}`,
    metadata: { quotation_number: quotation.quotation_number, reason: req.body.reason || null },
  });

  return ApiResponse.ok(
    res,
    { quotation: present(quotation) },
    { message: `Quotation ${quotation.quotation_number} rejected` }
  );
}

module.exports = {
  list,
  show,
  create,
  update,
  send,
  accept,
  reject,
  present,
};
