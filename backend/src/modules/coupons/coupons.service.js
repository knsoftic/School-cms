'use strict';

/**
 * Coupons — SRS §13.4 and FR-BILL-005 *"Coupon Management & Redemption"*.
 *
 * ## §13.4 is a list of six attributes, and all six are enforced here
 *
 * The section names *Percentage*, *Fixed Amount*, *Expiry*, *Maximum Uses*, *Plan Restrictions* and
 * *School Restrictions* — no more. Each maps to a column and to one refusal in
 * `validateForOrder()`, which is the single gate every discount passes through:
 *
 * | §13.4 attribute      | Column(s)                                  | Refusal code                    |
 * |----------------------|--------------------------------------------|---------------------------------|
 * | Percentage           | `discount_type`, `discount_value`          | — (a shape, not a rule)         |
 * | Fixed Amount         | `discount_type`, `discount_value`, `currency` | `COUPON_CURRENCY_MISMATCH`   |
 * | Expiry               | `starts_at`, `expires_at`                  | `COUPON_NOT_YET_VALID`, `COUPON_EXPIRED` |
 * | Maximum Uses         | `max_uses`, `max_uses_per_school`, `used_count` | `COUPON_EXHAUSTED`, `COUPON_SCHOOL_LIMIT_REACHED` |
 * | Plan Restrictions    | `restricted_plan_ids`                      | `COUPON_PLAN_NOT_ELIGIBLE`      |
 * | School Restrictions  | `restricted_school_ids`                    | `COUPON_SCHOOL_NOT_ELIGIBLE`    |
 *
 * `max_discount_amount` and `min_order_amount` are **not** in §13.4. They are columns
 * `models/billing.js` defines with stated reasons — *"Cap on a percentage discount, so 50% off does
 * not become unbounded"* — so enforcing them is reading the schema, not adding a requirement. They are
 * both nullable and null means "no cap" / "no floor", so a coupon written to §13.4's six attributes
 * alone behaves exactly as §13.4 describes.
 *
 * ## FR-BILL-005's preconditions are literally *"Not Specified in Source Requirements"*
 *
 * So the eligibility rules above are the *columns'* preconditions, not the requirement's, and that
 * distinction is why nothing beyond them is checked. In particular: a coupon is **not** refused
 * because the school already has a discount, because the subscription is in trial, or because the
 * invoice is a renewal rather than a first purchase. Each of those is a plausible product rule and
 * none is in the source.
 *
 * ## Two operations, because "Management & Redemption" is two things
 *
 *  - **`validateForOrder()`** answers *"would this code apply, and for how much"* and **writes
 *    nothing**. It is what `POST /coupons/validate` exposes to a school holding a code, and what
 *    `invoices.service.js` calls before it computes a discount. Being read-only is the point: a school
 *    checking a code five times has not consumed five uses.
 *
 *  - **`redeem()`** writes the `coupon_usages` row and increments `used_count`, and is called **only**
 *    from inside invoice issuance, in that transaction. `coupon_usages.discount_amount` is
 *    `allowNull: false`, so a redemption that is not attached to a computed discount has no honest
 *    value to record — which is the schema's own argument against a standalone "redeem this code"
 *    endpoint.
 *
 * ## `max_uses` is the one rule a race can break, so it is the one place that locks
 *
 * Every other check reads a column that a concurrent request cannot move. `used_count` is different:
 * two invoices issued in the same instant against a coupon with one use left would both read
 * `used_count = 0` and both redeem. `redeem()` therefore re-reads the coupon `FOR UPDATE` and
 * re-checks the ceiling inside the transaction, rather than trusting the check `validateForOrder()`
 * already did. The duplicate check is deliberate: the first one produces the good error message on the
 * common path, the second one is what makes *"Maximum Uses"* true.
 *
 * ## `expired` is a state the system sets, not the operator
 *
 * `COUPON_STATUS` has `active`, `inactive` and `expired`. The first two are an operator's switch; the
 * third is a fact about `expires_at` and the clock, so `coupons.validation.js` refuses it on `PATCH`
 * and `expireLapsed()` writes it. That function has **no route** for the same reason
 * `subscriptions.runLifecycleSweep()` has none — its actor is a scheduler, `package.json` declares
 * `"cron": "node src/jobs/cron.js"`, and `src/jobs/` is Phase 5 work. `validateForOrder()` does not
 * depend on the sweep having run: it checks `expires_at` against the clock directly, so a lapsed
 * coupon is refused whether or not its `status` column has caught up.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const money = require('../../utils/money');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { COUPON_TYPES, COUPON_STATUS } = require('../../config/constants');

const SORTABLE = Object.freeze([
  'id',
  'code',
  'name',
  'discount_type',
  'discount_value',
  'status',
  'used_count',
  'expires_at',
  'created_at',
  'updated_at',
]);

const DEFAULT_SORT = Object.freeze(['created_at', 'DESC']);

/**
 * Read a JSON restriction list as an array of numeric ids.
 *
 * `restricted_plan_ids` and `restricted_school_ids` are JSON columns, and `models/columns.js`
 * installs a getter that parses MariaDB's string form — but the *contents* are whatever was written,
 * so this coerces and drops anything that is not a positive integer. A malformed entry that silently
 * became `NaN` would make `includes()` false and quietly widen the restriction to nobody.
 *
 * Null and `[]` both mean unrestricted, which is the model's own comment.
 *
 * @param {any} value
 * @returns {number[]}
 */
function idList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/* ─────────────────────────────── reads ─────────────────────────────── */

/**
 * One page of coupons.
 *
 * No tenant scope: `coupons` has no `school_id` — a coupon belongs to the platform and reaches a
 * school through `restricted_school_ids`. `coupons.view` is seeded to `super_admin` alone.
 *
 * @param {object} query
 * @param {object} pagination
 * @param {import('express').Request} req
 * @returns {Promise<{rows: object[], count: number}>}
 */
async function list(query, pagination, req) {
  const where = {};

  if (query.status) where.status = query.status;
  if (query.discount_type) where.discount_type = query.discount_type;

  if (query.q) {
    where[Op.or] = [
      { code: { [Op.like]: `%${query.q}%` } },
      { name: { [Op.like]: `%${query.q}%` } },
    ];
  }

  /*
   * `valid_now` is a convenience filter over the four columns that decide validity, not a fifth
   * source of truth: the same conditions `validateForOrder()` applies, expressed as SQL.
   */
  if (query.valid_now === true) {
    const at = new Date();
    where.status = COUPON_STATUS.ACTIVE;
    where[Op.and] = [
      { [Op.or]: [{ starts_at: null }, { starts_at: { [Op.lte]: at } }] },
      { [Op.or]: [{ expires_at: null }, { expires_at: { [Op.gt]: at } }] },
    ];
  }

  return paginateQuery(
    db.Coupon,
    {
      where,
      order: getSort(req, SORTABLE, DEFAULT_SORT),
      include: [{ model: db.User, as: 'createdBy', attributes: ['id', 'name', 'email'] }],
    },
    pagination
  );
}

/**
 * One coupon, or a 404.
 *
 * @param {number|string} id
 * @param {{transaction?: object, lock?: boolean}} [options]
 * @returns {Promise<object>}
 */
async function findById(id, options = {}) {
  const coupon = await db.Coupon.findByPk(id, {
    transaction: options.transaction,
    lock: options.lock ? options.transaction.LOCK.UPDATE : undefined,
  });
  if (!coupon) throw ApiError.notFound('Coupon not found', { code: 'COUPON_NOT_FOUND' });
  return coupon;
}

/**
 * One coupon by code, or a 404 — the lookup `POST /coupons/validate` starts from.
 *
 * The 404 says "no such code" rather than naming the coupon table, because the caller here may be a
 * school typing a code it was given.
 *
 * @param {string} code
 * @param {{transaction?: object, lock?: boolean}} [options]
 * @returns {Promise<object>}
 */
async function findByCode(code, options = {}) {
  const coupon = await db.Coupon.findOne({
    where: { code },
    transaction: options.transaction,
    lock: options.lock ? options.transaction.LOCK.UPDATE : undefined,
  });

  if (!coupon) {
    throw ApiError.notFound(`No coupon exists with the code ${code}.`, {
      code: 'COUPON_NOT_FOUND',
      details: { code },
    });
  }
  return coupon;
}

/**
 * One page of `coupon_usages` for a coupon — SRS §13.4 *"Maximum Uses"* made auditable.
 *
 * Without this the table would be write-only, which is the same argument
 * `subscriptions.service.history()` makes for `subscription_history`. It is also the only place an
 * operator can see *why* `used_count` is what it is.
 *
 * @param {number|string} id
 * @param {object} query
 * @param {object} pagination
 * @param {import('express').Request} req
 * @returns {Promise<{rows: object[], count: number}>}
 */
async function usages(id, query, pagination, req) {
  const coupon = await findById(id);

  const where = { coupon_id: coupon.id };
  if (query.school_id) where.school_id = query.school_id;

  return paginateQuery(
    db.CouponUsage,
    {
      where,
      order: getSort(req, ['id', 'discount_amount', 'redeemed_at'], ['id', 'DESC']),
      include: [
        { model: db.School, as: 'school', attributes: ['id', 'name', 'code'] },
        { model: db.Invoice, as: 'invoice', attributes: ['id', 'invoice_number', 'status'] },
        { model: db.User, as: 'redeemedBy', attributes: ['id', 'name', 'email'] },
      ],
    },
    pagination
  );
}

/* ──────────────── FR-BILL-005 — the redemption gate (§13.4) ──────────────── */

/**
 * The discount a coupon gives on an amount — §13.4's *Percentage* and *Fixed Amount*.
 *
 * Capped twice, and both caps matter:
 *
 *  - by `max_discount_amount` when set, which is what the column exists for;
 *  - by the order amount itself, always. A fixed 100 off a 40 order would otherwise produce a −60
 *    invoice, and §13 describes no negative invoice, no credit note and no carry-forward for one. The
 *    cap is stated here rather than left to `clampNonNegative()` downstream, because the *coupon
 *    usage row* has to record what was actually given.
 *
 * @param {object} coupon
 * @param {number} amount  the amount the discount applies to
 * @returns {number} major units, rounded to 2dp
 */
function discountOn(coupon, amount) {
  const base = money.clampNonNegative(amount);
  const value = Number(coupon.discount_value) || 0;

  let discount =
    coupon.discount_type === COUPON_TYPES.PERCENTAGE
      ? money.percentageOf(base, value)
      : money.round(value);

  if (coupon.max_discount_amount !== null && coupon.max_discount_amount !== undefined) {
    discount = Math.min(discount, money.round(coupon.max_discount_amount));
  }

  return money.clampNonNegative(Math.min(discount, base));
}

/**
 * How many times one school has already used a coupon — §13.4 *Maximum Uses*, per-school half.
 *
 * @param {number} couponId
 * @param {number} schoolId
 * @param {object} [transaction]
 * @returns {Promise<number>}
 */
function schoolUseCount(couponId, schoolId, transaction) {
  return db.CouponUsage.count({
    where: { coupon_id: couponId, school_id: schoolId },
    transaction,
  });
}

/**
 * Every §13.4 rule, applied in one place. Writes nothing.
 *
 * The order of the checks is the order an operator would want to hear about them: what is wrong with
 * the coupon itself, then what is wrong with who is using it, then what is wrong with the order. Each
 * refusal is a 409 with its own code and a message naming the number involved, because "coupon not
 * valid" tells a school nothing it can act on.
 *
 * @param {object} input
 * @param {string} input.code
 * @param {number} input.schoolId
 * @param {number} [input.planId]
 * @param {number} input.amount    the amount the discount would apply to
 * @param {string} [input.currency]
 * @param {Date}   [input.at]      the instant to judge validity at; defaults to now
 * @param {object} [options]
 * @param {object} [options.transaction]
 * @param {boolean} [options.lock]  take a row lock — `redeem()` passes true
 * @param {object} [options.coupon] an already-loaded coupon, to avoid a second lookup
 * @returns {Promise<{coupon: object, discountAmount: number, amount: number, currency: string|null}>}
 */
async function validateForOrder(input, options = {}) {
  const at = input.at ? new Date(input.at) : new Date();
  const coupon =
    options.coupon ||
    (await findByCode(input.code, { transaction: options.transaction, lock: options.lock }));

  /* ── the coupon itself ── */

  if (coupon.status !== COUPON_STATUS.ACTIVE) {
    throw ApiError.conflict(`Coupon ${coupon.code} is ${coupon.status}.`, {
      code: 'COUPON_INACTIVE',
      details: { couponId: coupon.id, code: coupon.code, status: coupon.status },
    });
  }

  if (coupon.starts_at && new Date(coupon.starts_at).getTime() > at.getTime()) {
    throw ApiError.conflict(`Coupon ${coupon.code} is not valid yet.`, {
      code: 'COUPON_NOT_YET_VALID',
      details: { couponId: coupon.id, code: coupon.code, startsAt: coupon.starts_at },
    });
  }

  if (coupon.expires_at && new Date(coupon.expires_at).getTime() <= at.getTime()) {
    throw ApiError.conflict(`Coupon ${coupon.code} expired.`, {
      code: 'COUPON_EXPIRED',
      details: { couponId: coupon.id, code: coupon.code, expiresAt: coupon.expires_at },
    });
  }

  if (coupon.max_uses !== null && Number(coupon.used_count) >= Number(coupon.max_uses)) {
    throw ApiError.conflict(
      `Coupon ${coupon.code} has reached its maximum of ${coupon.max_uses} use(s).`,
      {
        code: 'COUPON_EXHAUSTED',
        details: {
          couponId: coupon.id,
          code: coupon.code,
          maxUses: Number(coupon.max_uses),
          usedCount: Number(coupon.used_count),
        },
      }
    );
  }

  /* ── who is using it — §13.4 School Restrictions, and the per-school ceiling ── */

  const schoolIds = idList(coupon.restricted_school_ids);

  if (schoolIds.length && !schoolIds.includes(Number(input.schoolId))) {
    throw ApiError.conflict(`Coupon ${coupon.code} is not available to this school.`, {
      code: 'COUPON_SCHOOL_NOT_ELIGIBLE',
      details: { couponId: coupon.id, code: coupon.code, schoolId: Number(input.schoolId) },
    });
  }

  if (coupon.max_uses_per_school !== null) {
    const used = await schoolUseCount(coupon.id, input.schoolId, options.transaction);

    if (used >= Number(coupon.max_uses_per_school)) {
      throw ApiError.conflict(
        `This school has already used coupon ${coupon.code} ${used} time(s), which is its limit.`,
        {
          code: 'COUPON_SCHOOL_LIMIT_REACHED',
          details: {
            couponId: coupon.id,
            code: coupon.code,
            schoolId: Number(input.schoolId),
            maxUsesPerSchool: Number(coupon.max_uses_per_school),
            usedCount: used,
          },
        }
      );
    }
  }

  /* ── §13.4 Plan Restrictions ── */

  const planIds = idList(coupon.restricted_plan_ids);

  if (planIds.length) {
    /*
     * A restricted coupon on an order with no plan is refused rather than allowed. The restriction is
     * a statement about which plans the discount is for, and an order that names none cannot satisfy
     * it — treating "unknown" as "eligible" would let the restriction be bypassed by omission.
     */
    if (!input.planId || !planIds.includes(Number(input.planId))) {
      throw ApiError.conflict(
        `Coupon ${coupon.code} may only be used on specific plans, and this is not one of them.`,
        {
          code: 'COUPON_PLAN_NOT_ELIGIBLE',
          details: {
            couponId: coupon.id,
            code: coupon.code,
            planId: input.planId ? Number(input.planId) : null,
            allowedPlanIds: planIds,
          },
        }
      );
    }
  }

  /* ── the order — currency and the minimum ── */

  const amount = money.clampNonNegative(input.amount);

  /*
   * A fixed-amount coupon carries its own currency, and 50 GBP off a USD invoice is not a discount
   * anyone can compute — there is no FX rate in this system and none in the SRS. A percentage coupon
   * is currency-agnostic by construction, so it is not checked.
   */
  if (
    coupon.discount_type === COUPON_TYPES.FIXED_AMOUNT &&
    coupon.currency &&
    input.currency &&
    coupon.currency !== input.currency
  ) {
    throw ApiError.conflict(
      `Coupon ${coupon.code} is denominated in ${coupon.currency} and cannot be applied to a ${input.currency} amount.`,
      {
        code: 'COUPON_CURRENCY_MISMATCH',
        details: {
          couponId: coupon.id,
          code: coupon.code,
          couponCurrency: coupon.currency,
          orderCurrency: input.currency,
        },
      }
    );
  }

  if (coupon.min_order_amount !== null && amount < money.round(coupon.min_order_amount)) {
    throw ApiError.conflict(
      `Coupon ${coupon.code} requires an order of at least ${money.format(coupon.min_order_amount, input.currency || coupon.currency || 'USD')}.`,
      {
        code: 'COUPON_MIN_ORDER_NOT_MET',
        details: {
          couponId: coupon.id,
          code: coupon.code,
          minOrderAmount: money.round(coupon.min_order_amount),
          amount,
        },
      }
    );
  }

  return {
    coupon,
    discountAmount: discountOn(coupon, amount),
    amount,
    currency: input.currency || coupon.currency || null,
  };
}

/**
 * Record a redemption — the write half of FR-BILL-005.
 *
 * **Must be called inside a transaction**, and only from invoice issuance. It re-validates under a row
 * lock rather than trusting the caller's earlier `validateForOrder()`: see the header on why
 * `max_uses` is the one rule a race can break.
 *
 * `used_count` is bumped with `increment()` so the statement is `used_count = used_count + 1` in SQL
 * rather than a read-modify-write from a value this process happened to hold.
 *
 * @param {object} input
 * @param {number} input.couponId
 * @param {number} input.schoolId
 * @param {number} input.discountAmount
 * @param {string} input.currency
 * @param {number} [input.invoiceId]
 * @param {number} [input.subscriptionId]
 * @param {number} [input.planId]         so the plan restriction is re-checked under the lock
 * @param {number} [input.amount]         the order amount, for the minimum re-check
 * @param {number|null} [input.redeemedBy]
 * @param {object} transaction
 * @returns {Promise<{usage: object, coupon: object}>}
 */
async function redeem(input, transaction) {
  if (!transaction) {
    throw new Error('coupons.service.redeem() must be called inside a transaction');
  }

  const coupon = await findById(input.couponId, { transaction, lock: true });

  /* The same gate, under the lock. `options.coupon` skips the second lookup. */
  await validateForOrder(
    {
      code: coupon.code,
      schoolId: input.schoolId,
      planId: input.planId,
      amount: input.amount === undefined ? input.discountAmount : input.amount,
      currency: input.currency,
    },
    { transaction, coupon }
  );

  const usage = await db.CouponUsage.create(
    {
      coupon_id: coupon.id,
      school_id: input.schoolId,
      subscription_id: input.subscriptionId || null,
      invoice_id: input.invoiceId || null,
      discount_amount: money.round(input.discountAmount),
      currency: input.currency,
      redeemed_by: input.redeemedBy || null,
      redeemed_at: new Date(),
    },
    { transaction }
  );

  await coupon.increment('used_count', { by: 1, transaction });

  return { usage, coupon };
}

/* ─────────────────────────────── writes ─────────────────────────────── */

/**
 * Create a coupon — FR-BILL-005's management half.
 *
 * `code` is `unique` in the schema; the pre-check turns a duplicate into a 409 naming the existing
 * coupon, and the index remains the authority under concurrency.
 *
 * @param {import('express').Request} req
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function create(req, payload) {
  let coupon;

  await db.sequelize.transaction(async (transaction) => {
    const existing = await db.Coupon.findOne({ where: { code: payload.code }, transaction });

    if (existing) {
      throw ApiError.conflict(`A coupon with code ${payload.code} already exists.`, {
        code: 'COUPON_CODE_TAKEN',
        details: { code: payload.code, couponId: existing.id },
      });
    }

    await assertRestrictionsExist(payload, transaction);

    coupon = await db.Coupon.create(
      {
        ...payload,
        /* `used_count` is the ledger's, never the caller's — `coupons.validation.js` forbids it too. */
        used_count: 0,
        created_by: req.user ? req.user.id : null,
      },
      { transaction }
    );
  });

  await recordAudit(req, {
    tableName: 'coupons',
    recordId: coupon.id,
    event: 'create',
    after: snapshot(coupon),
  });

  return findById(coupon.id);
}

/**
 * Refuse a restriction list naming a plan or school that does not exist.
 *
 * A typo in `restricted_plan_ids` is silent otherwise: the coupon saves, and every redemption is
 * refused with `COUPON_PLAN_NOT_ELIGIBLE` for a reason the operator cannot see. The check is a count,
 * not a join, so it costs one query per list and only when a list was supplied.
 *
 * @param {object} payload
 * @param {object} transaction
 * @returns {Promise<void>}
 */
async function assertRestrictionsExist(payload, transaction) {
  const planIds = idList(payload.restricted_plan_ids);
  const schoolIds = idList(payload.restricted_school_ids);

  if (planIds.length) {
    const found = await db.SubscriptionPlan.count({
      where: { id: { [Op.in]: planIds } },
      transaction,
    });

    if (found !== planIds.length) {
      throw new ApiError(422, '"restricted_plan_ids" names a plan that does not exist', {
        code: 'COUPON_RESTRICTION_UNKNOWN_PLAN',
        details: { planIds, found },
      });
    }
  }

  if (schoolIds.length) {
    const found = await db.School.count({
      where: { id: { [Op.in]: schoolIds } },
      transaction,
    });

    if (found !== schoolIds.length) {
      throw new ApiError(422, '"restricted_school_ids" names a school that does not exist', {
        code: 'COUPON_RESTRICTION_UNKNOWN_SCHOOL',
        details: { schoolIds, found },
      });
    }
  }
}

/**
 * Edit a coupon.
 *
 * **What an edit cannot reach, and why it matters.** `coupon_usages` records `discount_amount` as it
 * was at redemption, and `invoices` records `coupon_code` and `discount_amount` as they were at issue.
 * So editing `discount_value` here changes what the *next* redemption gives and cannot rewrite one
 * already granted — the same denormalised-copy protection `taxes.service.update()` relies on. That is
 * what makes the field editable at all.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function update(req, id, payload) {
  const coupon = await findById(id);
  const before = snapshot(coupon);

  await db.sequelize.transaction(async (transaction) => {
    if (payload.code && payload.code !== coupon.code) {
      const clash = await db.Coupon.findOne({
        where: { code: payload.code, id: { [Op.ne]: coupon.id } },
        transaction,
      });

      if (clash) {
        throw ApiError.conflict(`A coupon with code ${payload.code} already exists.`, {
          code: 'COUPON_CODE_TAKEN',
          details: { code: payload.code, couponId: clash.id },
        });
      }
    }

    await assertRestrictionsExist(payload, transaction);

    /*
     * Lowering `max_uses` below what has already been redeemed is refused. The alternative — accepting
     * it — leaves a coupon whose own columns say it has been used more times than it may be, which
     * every report reading them would have to special-case.
     */
    if (
      payload.max_uses !== undefined &&
      payload.max_uses !== null &&
      Number(payload.max_uses) < Number(coupon.used_count)
    ) {
      throw ApiError.conflict(
        `Coupon ${coupon.code} has already been used ${coupon.used_count} time(s); "max_uses" cannot be set below that.`,
        {
          code: 'COUPON_MAX_USES_BELOW_USED',
          details: {
            couponId: coupon.id,
            usedCount: Number(coupon.used_count),
            maxUses: Number(payload.max_uses),
          },
        }
      );
    }

    await coupon.update(payload, { transaction });
  });

  await recordAudit(req, {
    tableName: 'coupons',
    recordId: coupon.id,
    event: 'update',
    before,
    after: snapshot(coupon),
  });

  return findById(coupon.id);
}

/**
 * Delete a coupon, unless it has been redeemed.
 *
 * `coupon_usages.coupon_id` is `ON DELETE CASCADE`, so a plain delete would take the redemption
 * history with it — and `invoices.coupon_id` is `ON DELETE SET NULL`, so the invoices would keep their
 * `coupon_code` string pointing at nothing. Both together mean a delete after any redemption destroys
 * the only record of a discount that was actually given. Deactivate instead, which is what the
 * refusal says.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @returns {Promise<object>} the deleted row's snapshot
 */
async function destroy(req, id) {
  const coupon = await findById(id);
  const before = snapshot(coupon);

  await db.sequelize.transaction(async (transaction) => {
    const redeemed = await db.CouponUsage.count({
      where: { coupon_id: coupon.id },
      transaction,
    });

    if (redeemed > 0) {
      throw ApiError.conflict(
        `Coupon ${coupon.code} has been redeemed ${redeemed} time(s) and cannot be deleted. Set its status to inactive instead.`,
        { code: 'COUPON_IN_USE', details: { couponId: coupon.id, redemptions: redeemed } }
      );
    }

    await coupon.destroy({ transaction });
  });

  await recordAudit(req, {
    tableName: 'coupons',
    recordId: before.id,
    event: 'delete',
    before,
  });

  return before;
}

/* ──────────────── the system's half — no route, see the header ──────────────── */

/**
 * Mark every active coupon whose `expires_at` has passed as `expired`.
 *
 * Housekeeping, not enforcement: `validateForOrder()` already refuses a lapsed coupon by comparing
 * `expires_at` to the clock, so nothing depends on this having run. What it buys is a coupon list an
 * operator can filter by `status` and trust, and it is the reason `COUPON_STATUS.EXPIRED` exists as a
 * third value rather than being folded into `inactive`.
 *
 * Called by the Phase 5 scheduler. Exported and asserted directly by
 * `scripts/verify-billing.js`, in the same shape as `subscriptions.runLifecycleSweep()`.
 *
 * @param {{at?: Date}} [options]
 * @returns {Promise<{expired: number, at: string}>}
 */
async function expireLapsed(options = {}) {
  const at = options.at ? new Date(options.at) : new Date();

  /* `validate: false` is load-bearing. Sequelize 6's Model.update defaults `validate: true` and
   * builds a *skeleton* from the payload only (`model.js:1926`) before running model-level
   * validators. The skeleton has `discount_type` at its column default (`percentage`) and
   * `discount_value` at its column default (`0`), so `percentageInRange` throws
   * "must be between 0 and 100" — even when zero rows match, and even though this call never
   * touches a discount column. Instance `.update()` does not have this trap because the row is
   * already loaded; invoices.markOverdue uses that shape. Here the sweep is a single-column
   * status flip, so the validators have nothing to say. */
  const [expired] = await db.Coupon.update(
    { status: COUPON_STATUS.EXPIRED },
    {
      where: {
        status: COUPON_STATUS.ACTIVE,
        expires_at: { [Op.ne]: null, [Op.lte]: at },
      },
      validate: false,
    }
  );

  if (expired > 0) logger.info('coupons.expireLapsed: coupons expired', { expired });

  return { expired, at: at.toISOString() };
}

module.exports = {
  list,
  findById,
  findByCode,
  usages,
  validateForOrder,
  discountOn,
  schoolUseCount,
  redeem,
  create,
  update,
  destroy,
  expireLapsed,
  assertRestrictionsExist,
  idList,
  SORTABLE,
};
