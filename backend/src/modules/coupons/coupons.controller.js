'use strict';

/**
 * Coupon controllers — SRS §13.4, FR-BILL-005. Thin: the rules are in `coupons.service.js` and the
 * accepted fields in `coupons.validation.js`.
 */

const service = require('./coupons.service');
const ApiResponse = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const money = require('../../utils/money');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');
const { COUPON_TYPES } = require('../../config/constants');

/**
 * A coupon plus what §13.4's *Maximum Uses* leaves.
 *
 * `remaining_uses` is derived rather than stored, on the same reasoning `addons.controller.present()`
 * gives for `readiness`: the screen needs the number, and a second column holding it could disagree
 * with `max_uses − used_count`. `null` means unlimited, matching the column's own convention.
 *
 * @param {object} coupon
 * @returns {object}
 */
function present(coupon) {
  const maxUses = coupon.max_uses === null ? null : Number(coupon.max_uses);
  const used = Number(coupon.used_count) || 0;

  return {
    ...coupon.toJSON(),
    remaining_uses: maxUses === null ? null : Math.max(0, maxUses - used),
  };
}

/** GET / — one page of coupons. */
async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req.query, pagination, req);

  return ApiResponse.paginated(
    res,
    { count: result.count, rows: result.rows.map(present) },
    pagination
  );
}

/** GET /:id */
async function show(req, res) {
  const coupon = await service.findById(req.params.id);
  return ApiResponse.ok(res, { coupon: present(coupon) });
}

/** GET /:id/usages — §13.4's *Maximum Uses*, made auditable. */
async function usages(req, res) {
  const pagination = getPagination(req);
  const result = await service.usages(req.params.id, req.query, pagination, req);

  return ApiResponse.paginated(res, result, pagination);
}

/** POST / — FR-BILL-005's management half. */
async function create(req, res) {
  const coupon = await service.create(req, req.body);

  describeActivity(req, {
    entityId: coupon.id,
    description: `Created coupon ${coupon.code}`,
    metadata: {
      code: coupon.code,
      discount_type: coupon.discount_type,
      discount_value: coupon.discount_value,
      max_uses: coupon.max_uses,
    },
  });

  return ApiResponse.created(res, { coupon: present(coupon) }, { message: 'Coupon created' });
}

/** PATCH /:id */
async function update(req, res) {
  const coupon = await service.update(req, req.params.id, req.body);

  describeActivity(req, {
    entityId: coupon.id,
    description: `Updated coupon ${coupon.code}`,
    metadata: { code: coupon.code, fields: Object.keys(req.body) },
  });

  return ApiResponse.ok(res, { coupon: present(coupon) }, { message: 'Coupon updated' });
}

/** DELETE /:id — refused once the coupon has been redeemed; the service says why. */
async function destroy(req, res) {
  const coupon = await service.destroy(req, req.params.id);

  describeActivity(req, {
    entityId: coupon.id,
    description: `Deleted coupon ${coupon.code}`,
    metadata: { code: coupon.code },
  });

  return ApiResponse.ok(res, { coupon }, { message: 'Coupon deleted' });
}

/**
 * POST /validate — FR-BILL-005's redemption half, as a read.
 *
 * **Writes nothing**, so a school may check a code as often as it likes without consuming a use. The
 * discount is only *recorded* when an invoice is issued against it.
 *
 * The school is the caller's own unless a platform caller names another. A non-platform caller
 * supplying someone else's `school_id` is refused here rather than silently corrected: the answer for
 * another school could differ (`restricted_school_ids`, `max_uses_per_school`), so quietly swapping the
 * id would answer a question the caller did not ask.
 */
async function validateCode(req, res) {
  const requested = req.body.school_id ? Number(req.body.school_id) : null;
  const own = req.tenant.schoolId ? Number(req.tenant.schoolId) : null;

  if (requested && !req.tenant.isPlatform && requested !== own) {
    throw ApiError.forbidden('A coupon may only be checked against your own school.', {
      code: 'CROSS_SCHOOL_ACCESS',
      details: { requested, allowed: own },
    });
  }

  const schoolId = requested || own;

  if (!schoolId) {
    throw ApiError.validation('"school_id" is required when the caller has no school in scope', [
      { field: 'school_id', message: 'Name the school the coupon would be used by' },
    ]);
  }

  const result = await service.validateForOrder({
    code: req.body.code,
    schoolId,
    planId: req.body.plan_id,
    amount: req.body.amount,
    currency: req.body.currency,
  });

  const currency = result.currency || 'USD';

  return ApiResponse.ok(
    res,
    {
      valid: true,
      coupon: {
        id: result.coupon.id,
        code: result.coupon.code,
        name: result.coupon.name,
        discount_type: result.coupon.discount_type,
        discount_value: result.coupon.discount_value,
        currency: result.coupon.currency,
        expires_at: result.coupon.expires_at,
      },
      amount: result.amount,
      discount_amount: result.discountAmount,
      /* What the order would come to. The invoice is still the authority — tax is applied after. */
      net_amount: money.subtract(result.amount, result.discountAmount),
      currency,
    },
    {
      message:
        result.coupon.discount_type === COUPON_TYPES.PERCENTAGE
          ? `Coupon ${result.coupon.code} applies: ${result.coupon.discount_value}% off, ${money.format(result.discountAmount, currency)}`
          : `Coupon ${result.coupon.code} applies: ${money.format(result.discountAmount, currency)} off`,
    }
  );
}

module.exports = {
  list,
  show,
  usages,
  create,
  update,
  destroy,
  validateCode,
  present,
};
