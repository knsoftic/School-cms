'use strict';

/**
 * Payments and refunds — SRS §13.2 / §13.3, FR-BILL-002/003/004, and §33's *Payments* and *Refunds*
 * screens.
 *
 * `/invoices` decides what a school owes. This module records what a school *pays* against that, and it
 * is the only writer of the `payments`, `payment_transactions` and `refunds` tables. Every figure on an
 * invoice that follows from money arriving — `amount_paid`, `amount_due`, the `partially_paid`/`paid`
 * status — is written by `invoices.service.applyPayment()`, called from here inside this module's
 * transaction. Nothing here sets those columns directly; that is the whole of FR-BILL-004.
 *
 * ## Three ways a payment comes into being, and only three
 *
 * §13 describes two actors and this module adds no third:
 *
 *  - **`submit()`** — FR-BILL-003, the *School*. *"School submits payment / enters a transaction ID /
 *    uploads a payment screenshot / System sets the payment status to Pending."* Every school-submitted
 *    payment is `pending`, without exception — the requirement's last clause is not a default, it is the
 *    outcome. A school cannot approve its own money, so `submit()` never touches an invoice's totals.
 *
 *  - **`record()`** — FR-BILL-002, the *Super Admin* recording a payment the platform received. A
 *    non-gateway method (cash counted, a transfer reconciled, a wallet drawn down) is recorded as
 *    `approved` and applied at once, because the Super Admin recording it *is* the assertion that the
 *    money arrived. An `online_gateway` method is charged live through the plugin registry instead —
 *    see below — and its status follows the gateway's answer.
 *
 *  - **`review()`** — FR-BILL-004, the *Super Admin* deciding a pending payment. *"Super Admin selects
 *    Approve or Reject … Payment status is updated to reflect the Super Admin's decision, and the
 *    related invoice/subscription status is updated accordingly."* Approve applies the money and, when
 *    it settles the invoice, moves the subscription's lifecycle; reject records the reason and leaves
 *    the invoice untouched.
 *
 * ## The gateway is the plugin registry, and nothing here knows a provider's name
 *
 * §13.2's *"The payment gateway system must be plugin-based."* is honoured by never naming a provider:
 * `online_gateway` payments dispatch through `services/paymentGatewayService`, which ships with zero
 * adapters. With none registered, an online charge is refused with a 422 that names what is missing —
 * `PAYMENT_GATEWAY_NOT_CONFIGURED` — and, because the refusal is raised inside the transaction *after*
 * the `payments` row would have been written, nothing is persisted. A registered adapter that declines
 * is different: the decline is an outcome, so the `payments` row lands as `failed` and a
 * `payment_transactions` row records the attempt. *"An attempt that vanished is worse than an attempt
 * that failed, since only the second one can be investigated."*
 *
 * ## `subscription/invoice status is updated accordingly` — the transition table is the seam
 *
 * When an approved payment settles its invoice (`invoices.applyPayment()` returns `paid`), the
 * subscription is moved by `subscriptions.service.transition()` and never by a hand-written `state`
 * update here — the transition table owns the columns a lifecycle edge rewrites (`current_period_*`,
 * `next_renewal_at`, `grace_period_ends_at`), and duplicating even one of them would let the two files
 * disagree. The edge is chosen from the subscription's current state:
 *
 *  - `pending` or `trial`            → `activate`    (the first payment brings a new school online)
 *  - `past_due` or `grace_period`    → `settleArrears()` — back to Active once nothing is overdue and the
 *                                      period is still running (the owner's decision D23)
 *  - `expired`                       → `reactivate` (paying off arrears revives a lapsed subscription)
 *  - anything else                   → left alone    (already usable, `paused`, or `suspended`/`cancelled`:
 *                                                     D23 decided paying old debts never revives a
 *                                                     subscription an administrator stopped)
 *
 * `transition()` runs its **own** transaction, so it is called only *after* the payment transaction has
 * committed. The money is recorded whether or not the lifecycle edge is valid: a race that makes the
 * edge a no-op is logged, not allowed to unwind a real payment.
 *
 * ## Refunds — §33's *Refunds* screen, a child of a payment
 *
 * `refunds.payment_id` is `NOT NULL`, so a refund cannot exist without the payment it reverses:
 * `requestRefund()` is reached at `POST /payments/:id/refunds`, the same child-resource shape
 * `/subscriptions/:id/addons` uses. A refund is created already `completed` — both `refunds.manage` and
 * the approval are the Super Admin's, so a two-step request/approve within one actor would be ceremony —
 * and it writes back through `invoices.applyRefund()`. When the original payment used a gateway, the
 * refund is dispatched through the same adapter and a `payment_transactions` row with
 * `direction: 'refund'` records it; a gateway that cannot refund aborts the whole thing with a 422 so no
 * half-made refund row is left behind. A refund to the **wallet** — or of a wallet payment — is credited
 * to the subscription's `wallet_balance` instead and touches no gateway; see the wallet section below. `REFUND_STATUS.pending` and `.rejected` stay unused, available
 * for a school-*requested* refund flow the SRS does not currently describe — the same way
 * `invoice_items.item_type: 'credit'` is a defined value with no current writer.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const money = require('../../utils/money');
const documentNumber = require('../../utils/documentNumber');
const invoicesService = require('../invoices/invoices.service');
const subscriptionsService = require('../subscriptions/subscriptions.service');
const paymentGateway = require('../../services/paymentGatewayService');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { cleanupUploads, relativeUploadPath: uploadRelativePath } = require('../../middlewares/upload');
const { tenantWhere } = require('../../models');
const {
  INVOICE_STATUS,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  PAYMENT_TRANSACTION_STATUS,
  REFUND_STATUS,
  SUBSCRIPTION_STATES,
} = require('../../config/constants');

const SORTABLE = Object.freeze([
  'id',
  'payment_number',
  'amount',
  'status',
  'method',
  'paid_at',
  'reviewed_at',
  'created_at',
  'updated_at',
]);

const DEFAULT_SORT = Object.freeze(['created_at', 'DESC']);

/** Statuses in which a payment's money counts as received — the set `applyPayment()` also sums over. */
const RECEIVED_STATUSES = Object.freeze([
  PAYMENT_STATUS.APPROVED,
  PAYMENT_STATUS.PARTIALLY_REFUNDED,
  PAYMENT_STATUS.REFUNDED,
]);

/** The one method that talks to a third party; every other method is recorded, not processed. */
const GATEWAY_METHOD = PAYMENT_METHODS.ONLINE_GATEWAY;

/**
 * Subscription states from which an approved, invoice-settling payment moves the subscription — see the
 * header. `reactivate` is for a subscription that lapsed; one an administrator suspended or cancelled
 * stays stopped whatever is paid (D23), because paying a debt is not a decision to resume service.
 */
const ACTIVATE_FROM = Object.freeze([SUBSCRIPTION_STATES.PENDING, SUBSCRIPTION_STATES.TRIAL]);
const SETTLE_FROM = Object.freeze([SUBSCRIPTION_STATES.PAST_DUE, SUBSCRIPTION_STATES.GRACE_PERIOD]);
const REACTIVATE_FROM = Object.freeze([SUBSCRIPTION_STATES.EXPIRED]);

/* ─────────────────────────────── Reads ─────────────────────────────── */

/**
 * Everything a §33 payment screen renders: the invoice it settles, its attempts and its refunds.
 *
 * The reviewer and submitter are **not** joined, only their ids (`reviewed_by`, `submitted_by`) carried
 * on the row — `invoices.detailInclude()` omits its actor joins for the same reason, and `users` is not
 * associated to `payments` by an alias. Who did what is the activity log's record, not this read's.
 */
function detailInclude() {
  return [
    { model: db.Invoice, as: 'invoice' },
    { model: db.Subscription, as: 'subscription' },
    { model: db.PaymentTransaction, as: 'transactions', separate: true, order: [['id', 'ASC']] },
    { model: db.Refund, as: 'refunds', separate: true, order: [['id', 'ASC']] },
  ];
}

/**
 * One page of payments, confined to the caller's tenant.
 *
 * `payments` carries `school_id` and `organization_id`, so `tenantWhere()` does the confinement exactly
 * as it does for invoices: a school holding `payments.submit` reaches this same handler and sees only
 * its own rows.
 *
 * @param {object} tenant
 * @param {object} query
 * @param {{page: number, limit: number, offset: number}} pagination
 * @param {import('express').Request} req
 * @returns {Promise<{rows: object[], count: number}>}
 */
async function list(tenant, query, pagination, req) {
  const where = tenantWhere(tenant, {});

  /*
   * A `school_id` filter narrows; it never widens a scope already pinned to a school. Assigning it over
   * `tenantWhere()`'s result let the query name any school, with only the tenant middleware's own check
   * standing between a school caller and another school's payments — and since the owner's decision D27
   * school leadership holds `payments.view`. The service refuses it too, as `users.service.list()` does.
   */
  if (query.school_id) {
    if (tenant && tenant.schoolId && Number(query.school_id) !== Number(tenant.schoolId)) {
      throw ApiError.forbidden('That school is not yours', { code: 'CROSS_TENANT_ACCESS_DENIED' });
    }
    where.school_id = query.school_id;
  }
  if (query.invoice_id) where.invoice_id = query.invoice_id;
  if (query.subscription_id) where.subscription_id = query.subscription_id;
  if (query.status) where.status = query.status;
  if (query.method) where.method = query.method;
  if (query.currency) where.currency = query.currency;
  if (query.pending) where.status = PAYMENT_STATUS.PENDING;

  if (query.number) {
    where.payment_number = { [Op.like]: `%${String(query.number).trim().toUpperCase()}%` };
  }

  if (query.from || query.to) {
    where.created_at = {
      ...(query.from ? { [Op.gte]: new Date(query.from) } : {}),
      ...(query.to ? { [Op.lte]: new Date(query.to) } : {}),
    };
  }

  return paginateQuery(
    db.Payment,
    { where, order: getSort(req, SORTABLE, DEFAULT_SORT), include: detailInclude() },
    pagination
  );
}

/**
 * One payment, or a 404. Tenant scope is folded into the `where`, so another school's payment reads as
 * "not found" rather than "forbidden".
 *
 * @param {object} tenant
 * @param {number|string} id
 * @param {{detail?: boolean, transaction?: object, lock?: boolean}} [options]
 * @returns {Promise<object>}
 */
async function findById(tenant, id, options = {}) {
  const payment = await db.Payment.findOne({
    where: tenantWhere(tenant, { id }),
    include: options.detail === false ? undefined : detailInclude(),
    transaction: options.transaction,
    ...(options.lock && options.transaction ? { lock: options.transaction.LOCK.UPDATE } : {}),
  });

  if (!payment) throw ApiError.notFound('Payment not found', { code: 'PAYMENT_NOT_FOUND' });
  return payment;
}

/* ─────────────────────────────── Helpers ─────────────────────────────── */

/** `req.user.id`, or `null` when there is no authenticated actor. */
function performerOf(req) {
  return req && req.user && req.user.id ? req.user.id : null;
}

/**
 * The path stored in `payments.screenshot_path`, relative to the uploads root and slash-normalised.
 *
 * The absolute disk path (`file.path`) is never stored: it leaks the server's directory layout and
 * breaks the moment the uploads root moves. `upload.js` already namespaces the file under
 * `school-<id>/payment_proof/<random>`, so the relative path is both portable and tenant-scoped.
 *
 * @param {object|undefined} file  `req.file` from `uploadSingle`
 * @returns {string|null}
 */
/* Moved to `middlewares/upload.js` when §20.2 became its second caller; re-exported here so every
   existing importer keeps working. */
const relativeUploadPath = uploadRelativePath;

/**
 * Load the invoice a payment settles, under the caller's tenant scope and locked for update.
 *
 * A payment is always against an invoice: `invoices.applyPayment()` is the only settlement path and it
 * recomputes `amount_paid` from the invoice's payments, so there has to be an invoice to recompute
 * against. `payments.invoice_id` is nullable in the schema for a future non-invoice payment (an advance,
 * a wallet top-up) the SRS does not currently describe; this module does not create one.
 *
 * @param {object} tenant
 * @param {number} invoiceId
 * @param {object} transaction
 * @returns {Promise<object>}
 */
async function loadInvoiceForPayment(tenant, invoiceId, transaction) {
  const invoice = await invoicesService.findById(tenant, invoiceId, {
    detail: false,
    transaction,
    lock: true,
  });

  if (!invoicesService.PAYABLE_STATUSES.includes(invoice.status)) {
    throw new ApiError(409, `Invoice ${invoice.invoice_number} is ${invoice.status} and cannot take a payment`, {
      code: 'INVOICE_NOT_PAYABLE',
      details: { invoiceId: invoice.id, status: invoice.status, payable: invoicesService.PAYABLE_STATUSES },
    });
  }

  return invoice;
}

/**
 * Write the `payment_transactions` attempt row for a gateway operation.
 *
 * Called for every charge and every refund, whatever the outcome — a `payment_transactions` row is the
 * record that an attempt happened, and `paymentGatewayService.normaliseResult()` guarantees the status
 * is one the enum holds.
 *
 * @param {object} params
 * @param {object} params.payment
 * @param {'charge'|'refund'} params.direction
 * @param {object} params.result  a normalised gateway result
 * @param {number} params.amount
 * @param {string} params.currency
 * @param {string} params.gatewayKey
 * @param {object} [params.request]  the context sent to the adapter, for reconciliation
 * @param {object} transaction
 * @returns {Promise<object>}
 */
async function writeTransactionRow(
  { payment, direction, result, amount, currency, gatewayKey, request = null },
  transaction
) {
  return db.PaymentTransaction.create(
    {
      payment_id: payment.id,
      school_id: payment.school_id,
      gateway_key: gatewayKey,
      gateway_transaction_id: result.gatewayTransactionId,
      status: result.status,
      direction,
      currency,
      amount,
      error_code: result.errorCode,
      error_message: result.errorMessage,
      request_payload: request,
      response_payload: result.raw,
      processed_at: new Date(),
    },
    { transaction }
  );
}

/**
 * Allocate a `payment_number` and create the `payments` row. Shared by `submit()` and `record()`.
 *
 * @param {object} spec  already-resolved column values
 * @param {object} transaction
 * @returns {Promise<object>}
 */
async function createPaymentRow(spec, transaction) {
  const paymentNumber = await documentNumber.nextNumber(db.Payment, {
    column: 'payment_number',
    prefix: documentNumber.PREFIXES.PAYMENT,
    transaction,
  });

  return db.Payment.create({ ...spec, payment_number: paymentNumber }, { transaction });
}

/* ─────────────── The wallet — §13.2's fifth method, the owner's decision D5 ─────────────── */

/*
 * §13.2 lists "Wallet" among the five payment methods and says nothing else, so for a long time this
 * module accepted the method and moved no money: `subscriptions.wallet_balance` was declared and read or
 * written by nothing (Known Issues #19). D5 in `docs/OWNER-DECISIONS.md` settled it — **refunds credit,
 * invoices spend**:
 *
 *  - a refund whose destination is the wallet adds its amount to the balance, and so does any refund of
 *    a payment that was itself drawn from the wallet, since that is where the money came from;
 *  - a wallet payment takes its amount from the balance at the moment it is approved, and is refused if
 *    the balance is short. Approval is the moment for the same reason it is the moment an invoice's
 *    totals move: a pending payment has not happened yet.
 *
 * The balance lives on the subscription because §29 put the column there; a payment names its
 * subscription through the invoice it settles. No new table: the `payments` row is the record of a
 * draw-down and the `refunds` row the record of a credit.
 */

/**
 * Load, locked, the subscription whose wallet a payment draws on or a refund credits.
 *
 * @param {number|null} subscriptionId
 * @param {object} transaction
 * @returns {Promise<object>}
 */
async function lockWallet(subscriptionId, transaction) {
  const subscription = subscriptionId
    ? await db.Subscription.findByPk(subscriptionId, { transaction, lock: true })
    : null;
  if (!subscription) {
    throw new ApiError(422, 'This payment is not against a subscription, so there is no wallet to use', {
      code: 'WALLET_NOT_AVAILABLE',
      details: { subscriptionId: subscriptionId || null },
    });
  }
  return subscription;
}

/**
 * Refuse a wallet payment the balance cannot cover.
 *
 * @param {object} subscription
 * @param {number} amount
 * @param {string} currency
 */
function assertWalletCovers(subscription, amount, currency) {
  const balance = money.round(subscription.wallet_balance || 0);
  if (money.toMinor(amount) > money.toMinor(balance)) {
    throw new ApiError(409, `The wallet holds ${balance} ${currency}, less than the ${money.round(amount)} this payment needs`, {
      code: 'WALLET_INSUFFICIENT',
      details: { balance, amount: money.round(amount) },
    });
  }
}

/**
 * Draw an approved wallet payment from the balance, under the subscription's row lock.
 *
 * @param {object} payment
 * @param {object} transaction
 */
async function debitWallet(payment, transaction) {
  const subscription = await lockWallet(payment.subscription_id, transaction);
  assertWalletCovers(subscription, payment.amount, payment.currency);
  await subscription.update(
    { wallet_balance: money.subtract(subscription.wallet_balance || 0, payment.amount) },
    { transaction }
  );
}

/**
 * Credit a refund to the wallet, under the subscription's row lock.
 *
 * @param {number|null} subscriptionId
 * @param {number} amount
 * @param {object} transaction
 */
async function creditWallet(subscriptionId, amount, transaction) {
  const subscription = await lockWallet(subscriptionId, transaction);
  await subscription.update(
    { wallet_balance: money.sum(subscription.wallet_balance || 0, amount) },
    { transaction }
  );
}

/**
 * Set a payment `approved`, stamp `paid_at`, and push the money onto its invoice.
 *
 * The invoice is recomputed by `invoices.applyPayment()`, never here — this function decides only that
 * the payment itself is approved. Returns the invoice settlement result so the caller can decide whether
 * a subscription lifecycle edge follows. It is also the one place a payment becomes approved — both
 * `record()` and `review()` arrive here — which makes it the one place a wallet payment is drawn down.
 *
 * @param {object} payment
 * @param {object} invoice
 * @param {number|null} reviewer  `users.id` of the approving Super Admin, or null when auto-approved
 * @param {object} transaction
 * @returns {Promise<{status: string, amountPaid: number, amountDue: number}>}
 */
async function applyApproved(payment, invoice, reviewer, transaction) {
  const now = new Date();

  if (payment.method === PAYMENT_METHODS.WALLET) await debitWallet(payment, transaction);

  payment.set({
    status: PAYMENT_STATUS.APPROVED,
    paid_at: payment.paid_at || now,
    reviewed_by: reviewer,
    reviewed_at: now,
  });
  await payment.save({ transaction });

  /* Reload under the same transaction so the SUM in applyPayment() sees this row as approved. */
  const settlement = await invoicesService.applyPayment(invoice, { transaction });

  return settlement;
}

/**
 * Move a subscription's lifecycle after an invoice is settled — the FR-BILL-004 clause *"the related
 * invoice/subscription status is updated accordingly"*.
 *
 * Runs after the payment transaction has committed, because `transition()` owns its own. A state that
 * offers no payment-driven edge is left untouched, and a transition conflict (a race with the sweep, an
 * already-active subscription) is logged rather than thrown: the payment is real regardless.
 *
 * @param {import('express').Request} req
 * @param {number} subscriptionId
 * @param {string} reason
 * @returns {Promise<string|null>}  the action taken, or null
 */
async function transitionAfterSettlement(req, subscriptionId, reason) {
  const subscription = await db.Subscription.findByPk(subscriptionId);
  if (!subscription) return null;

  if (SETTLE_FROM.includes(subscription.state)) {
    return subscriptionsService.settleArrears(req, subscriptionId);
  }

  let action = null;
  if (ACTIVATE_FROM.includes(subscription.state)) action = 'activate';
  else if (REACTIVATE_FROM.includes(subscription.state)) action = 'reactivate';

  if (!action) return null;

  try {
    await subscriptionsService.transition(req, subscriptionId, action, reason, {
      tenant: req ? req.tenant : undefined,
    });
    return action;
  } catch (error) {
    /* SUBSCRIPTION_STATE_UNCHANGED / _INVALID from a race — the money stands, the edge does not. */
    logger.warn('Payment settled but subscription lifecycle edge did not apply', {
      subscriptionId,
      action,
      code: error.code || null,
      message: error.message,
    });
    return null;
  }
}

/**
 * The currency a payment against `invoice` is in: the invoice's, and a different one is refused.
 *
 * The schemas accept a `currency` and the payment row stored whatever was sent — while settling adds
 * approved amounts to the invoice's `amount_paid` as they are, with no conversion anywhere. An approved
 * 100 GBP payment therefore counted as 100 against a USD invoice, and only a reviewer who happened to
 * notice stood in the way. Refused rather than converted: there is no exchange rate in this system to
 * convert with, and a school paying in another currency is a conversation, not a row.
 *
 * @param {{currency?: string}} spec
 * @param {object} invoice
 * @returns {string}
 */
function currencyFor(spec, invoice) {
  if (spec.currency && spec.currency !== invoice.currency) {
    throw new ApiError(422, `This invoice is in ${invoice.currency}; a payment against it must be too`, {
      code: 'PAYMENT_CURRENCY_MISMATCH',
      details: { invoice_currency: invoice.currency, currency: spec.currency },
    });
  }
  return invoice.currency;
}

/* ────────────────── FR-BILL-003 — School submits a payment ────────────────── */

/**
 * *"School submits payment / enters a transaction ID / uploads a payment screenshot / System sets the
 * payment status to Pending."*
 *
 * Always `pending`, never applied to the invoice — a school does not approve its own money. The invoice
 * is loaded under the school's tenant scope, so a school can only pay an invoice that is its own and
 * still payable. `online_gateway` is refused here: a school-initiated online charge is a redirect/webhook
 * flow §13 does not specify, and the manual path (transaction id + screenshot → pending) is the one
 * FR-BILL-003 describes.
 *
 * @param {import('express').Request} req
 * @param {object} spec
 * @returns {Promise<object>}
 */
async function submit(req, spec) {
  const tenant = req.tenant;

  if (spec.method === GATEWAY_METHOD) {
    throw new ApiError(422, 'Online gateway payments are processed by the platform, not submitted manually', {
      code: 'PAYMENT_METHOD_NOT_SUBMITTABLE',
      details: { method: spec.method },
    });
  }

  paymentGateway.assertMethodEnabled(spec.method);

  /*
   * Something the reviewer can check — the owner's decision D8. FR-BILL-004's Super Admin "reviews the
   * submitted transaction ID and screenshot"; a submission carrying neither is a pending row with
   * nothing to review. Either one is enough, because a cash payment may have a receipt photo and no
   * reference. A wallet payment is exempt: what it is paid from is the balance itself (D5).
   */
  if (spec.method !== PAYMENT_METHODS.WALLET && !spec.transaction_id && !req.file) {
    throw new ApiError(422, 'Enter the transaction ID or attach a screenshot of the payment', {
      code: 'PAYMENT_EVIDENCE_REQUIRED',
      details: { transaction_id: 'Required when no screenshot is attached' },
    });
  }

  const screenshotPath = relativeUploadPath(req.file);

  try {
    const payment = await documentNumber.withRetry(
      () =>
        db.sequelize.transaction(async (transaction) => {
          const invoice = await loadInvoiceForPayment(tenant, spec.invoice_id, transaction);
          const currency = currencyFor(spec, invoice);

          /*
           * A wallet payment the balance cannot cover is refused now rather than left pending for a
           * review that could only reject it. Approval checks again under the lock and is what actually
           * draws the money (D5), since a pending payment reserves nothing.
           */
          if (spec.method === PAYMENT_METHODS.WALLET) {
            const wallet = await lockWallet(invoice.subscription_id, transaction);
            assertWalletCovers(wallet, spec.amount, currency);
          }

          return createPaymentRow(
            {
              school_id: invoice.school_id,
              organization_id: invoice.organization_id,
              invoice_id: invoice.id,
              subscription_id: invoice.subscription_id,
              method: spec.method,
              currency,
              amount: money.round(spec.amount),
              status: PAYMENT_STATUS.PENDING,
              transaction_id: spec.transaction_id || null,
              reference: spec.reference || null,
              payer_note: spec.payer_note || null,
              screenshot_path: screenshotPath,
              paid_at: spec.paid_at || null,
              submitted_by: performerOf(req),
              metadata: spec.metadata || null,
            },
            transaction
          );
        }),
      { column: 'payment_number' }
    );

    await recordAudit(req, {
      tableName: 'payments',
      recordId: payment.id,
      event: 'create',
      after: snapshot(payment),
      reason: spec.reason || null,
    });

    return findById(tenant, payment.id);
  } catch (error) {
    /* A stored screenshot orphaned by a failed insert is disk the school never got a payment for. */
    await cleanupUploads(req);
    throw error;
  }
}

/* ────────────────── FR-BILL-002 — Super Admin records a payment ────────────────── */

/**
 * The Super Admin records a payment the platform received (cash, a transfer, a wallet draw-down) or
 * charges the online gateway.
 *
 * A non-gateway method is recorded as `approved` and applied immediately — recording it is the assertion
 * that the money arrived. A gateway method is charged through the plugin registry; with no adapter
 * registered the charge is refused (422 `PAYMENT_GATEWAY_NOT_CONFIGURED`) and, since that is raised
 * inside the transaction, nothing persists. A registered adapter that declines leaves a `failed`
 * payment and a `payment_transactions` row.
 *
 * @param {import('express').Request} req
 * @param {object} spec
 * @returns {Promise<{payment: object, settlement: object|null, gatewayFailed: boolean}>}
 */
async function record(req, spec) {
  const tenant = req.tenant;
  paymentGateway.assertMethodEnabled(spec.method);

  const isGateway = spec.method === GATEWAY_METHOD;
  const gatewayKey = isGateway ? spec.gateway_key || paymentGateway.defaultGatewayKey() : null;

  const outcome = await documentNumber.withRetry(
    () =>
      db.sequelize.transaction(async (transaction) => {
        const invoice = await loadInvoiceForPayment(tenant, spec.invoice_id, transaction);
        const amount = money.round(spec.amount);
        const currency = currencyFor(spec, invoice);

        const payment = await createPaymentRow(
          {
            school_id: invoice.school_id,
            organization_id: invoice.organization_id,
            invoice_id: invoice.id,
            subscription_id: invoice.subscription_id,
            method: spec.method,
            gateway_key: gatewayKey,
            currency,
            amount,
            status: PAYMENT_STATUS.PENDING,
            transaction_id: spec.transaction_id || null,
            reference: spec.reference || null,
            payer_note: spec.payer_note || null,
            paid_at: spec.paid_at || null,
            submitted_by: performerOf(req),
            metadata: spec.metadata || null,
          },
          transaction
        );

        if (!isGateway) {
          const settlement = await applyApproved(payment, invoice, performerOf(req), transaction);
          return { paymentId: payment.id, subscriptionId: invoice.subscription_id, settlement, gatewayFailed: false };
        }

        /*
         * The plugin seam. `dispatch()` calls `get(gatewayKey)`, which throws 422 when no adapter is
         * registered — inside this transaction, so the payment row rolls back and nothing is left. A
         * registered adapter always returns a normalised result, decline included.
         */
        const result = await paymentGateway.dispatch(gatewayKey, 'charge', {
          payment,
          invoice,
          amount,
          currency,
          metadata: spec.metadata || null,
        });

        await writeTransactionRow(
          { payment, direction: 'charge', result, amount, currency, gatewayKey, request: { invoiceId: invoice.id } },
          transaction
        );

        if (result.status === PAYMENT_TRANSACTION_STATUS.SUCCEEDED) {
          payment.set({ gateway_key: gatewayKey, transaction_id: result.gatewayTransactionId || spec.transaction_id || null });
          const settlement = await applyApproved(payment, invoice, performerOf(req), transaction);
          return { paymentId: payment.id, subscriptionId: invoice.subscription_id, settlement, gatewayFailed: false };
        }

        /*
         * The decline goes in both notes: `review_note` is the platform's and is withheld from schools
         * (`payments.controller.present()`), so the school is told why its charge failed through
         * `rejection_reason`, the one it is meant to read.
         */
        payment.set({
          status: PAYMENT_STATUS.FAILED,
          gateway_key: gatewayKey,
          review_note: result.errorMessage || 'Gateway charge failed',
          rejection_reason: result.errorMessage || 'Gateway charge failed',
        });
        await payment.save({ transaction });
        return { paymentId: payment.id, subscriptionId: null, settlement: null, gatewayFailed: true };
      }),
    { column: 'payment_number' }
  );

  const payment = await db.Payment.findByPk(outcome.paymentId);

  await recordAudit(req, {
    tableName: 'payments',
    recordId: payment.id,
    event: 'create',
    after: snapshot(payment),
    reason: spec.reason || null,
  });

  /* Lifecycle only follows a settled invoice, and only after the payment transaction has committed. */
  if (outcome.settlement && outcome.subscriptionId) {
    await maybeActivateOnPaid(req, outcome, payment);
  }

  return {
    payment: await findById(tenant, payment.id),
    settlement: outcome.settlement,
    gatewayFailed: outcome.gatewayFailed,
  };
}

/**
 * Fire the subscription lifecycle edge when a settlement moved the invoice to `paid`.
 *
 * Factored out because `record()` and `review()` share it verbatim. The invoice status comes from the
 * settlement `applyPayment()` returned, so a partial payment does not activate anything.
 *
 * @param {import('express').Request} req
 * @param {{subscriptionId: number, settlement: object}} outcome
 * @param {object} payment
 * @returns {Promise<string|null>}
 */
async function maybeActivateOnPaid(req, outcome, payment) {
  if (!outcome.subscriptionId) return null;
  if (!outcome.settlement || outcome.settlement.status !== INVOICE_STATUS.PAID) return null;

  return transitionAfterSettlement(
    req,
    outcome.subscriptionId,
    `Payment ${payment.payment_number} settled invoice`
  );
}

/* ────────────────── FR-BILL-004 — Super Admin approves or rejects ────────────────── */

/**
 * *"Super Admin selects Approve or Reject … Payment status is updated to reflect the Super Admin's
 * decision, and the related invoice/subscription status is updated accordingly."*
 *
 * Only a `pending` payment can be decided — an approved or failed one is already settled, and deciding it
 * twice would apply its money twice. Approve applies the payment and, if the invoice is now paid, moves
 * the subscription; reject records the reason and leaves every invoice figure where it was.
 *
 * @param {import('express').Request} req
 * @param {number|string} id
 * @param {'approve'|'reject'} decision
 * @param {object} spec  `{ note?, rejection_reason?, reason? }`
 * @returns {Promise<{payment: object, settlement: object|null, action: string}>}
 */
async function review(req, id, decision, spec = {}) {
  const tenant = req.tenant;

  const outcome = await db.sequelize.transaction(async (transaction) => {
    const payment = await findById(tenant, id, { detail: false, transaction, lock: true });
    const before = snapshot(payment);

    if (payment.status !== PAYMENT_STATUS.PENDING) {
      throw new ApiError(409, `Payment ${payment.payment_number} is ${payment.status} and cannot be reviewed`, {
        code: 'PAYMENT_NOT_PENDING',
        details: { paymentId: payment.id, status: payment.status },
      });
    }

    if (decision === 'reject') {
      payment.set({
        status: PAYMENT_STATUS.REJECTED,
        reviewed_by: performerOf(req),
        reviewed_at: new Date(),
        review_note: spec.note || null,
        rejection_reason: spec.rejection_reason || spec.reason || null,
      });
      await payment.save({ transaction });
      return { paymentId: payment.id, subscriptionId: null, settlement: null, before };
    }

    /* Approve. The invoice must still be payable — a period cancelled while the payment sat pending. */
    if (!payment.invoice_id) {
      throw new ApiError(409, `Payment ${payment.payment_number} has no invoice to settle`, {
        code: 'PAYMENT_NO_INVOICE',
        details: { paymentId: payment.id },
      });
    }

    const invoice = await invoicesService.loadForWrite(payment.invoice_id, { transaction, lock: true });
    payment.set({ review_note: spec.note || null });
    const settlement = await applyApproved(payment, invoice, performerOf(req), transaction);

    return { paymentId: payment.id, subscriptionId: payment.subscription_id, settlement, before };
  });

  const payment = await db.Payment.findByPk(outcome.paymentId);

  /*
   * `audit_logs.event` is `create|update|delete|restore` (SRS §29). Approve/reject are updates to the
   * payment row — the decision lives in `changed_fields` / `reason`, not in a fifth enum value the
   * column cannot store. Writing `approve` truncated at MariaDB (`Data truncated for column 'event'`).
   */
  await recordAudit(req, {
    tableName: 'payments',
    recordId: payment.id,
    event: 'update',
    before: outcome.before,
    after: snapshot(payment),
    reason: spec.rejection_reason || spec.reason || spec.note || null,
  });

  if (decision === 'approve' && outcome.settlement && outcome.subscriptionId) {
    await maybeActivateOnPaid(req, outcome, payment);
  }

  return {
    payment: await findById(tenant, payment.id),
    settlement: outcome.settlement,
    action: decision === 'approve' ? PAYMENT_STATUS.APPROVED : PAYMENT_STATUS.REJECTED,
  };
}

/* ─────────────────────────── Refunds (§33) ─────────────────────────── */

/** What is left to refund on a payment: what arrived, minus what has already gone back. */
function refundableAmount(payment) {
  return money.clampNonNegative(money.subtract(payment.amount, payment.refunded_amount || 0));
}

/**
 * List a payment's refunds — `GET /payments/:id/refunds`. Confirms the payment is in the caller's tenant
 * first, so the refund list cannot be used to probe another school's payments.
 *
 * @param {object} tenant
 * @param {number|string} paymentId
 * @returns {Promise<object[]>}
 */
async function listRefunds(tenant, paymentId) {
  const payment = await findById(tenant, paymentId, { detail: false });
  return db.Refund.findAll({ where: { payment_id: payment.id }, order: [['id', 'ASC']] });
}

/**
 * Create a refund against a payment — `POST /payments/:id/refunds`.
 *
 * Created already `completed`: `refunds.manage` is the Super Admin's and so is the approval, so a
 * two-step request/approve within one actor buys nothing. The amount defaults to the full refundable
 * balance and may not exceed it. A gateway-backed original payment is refunded through the same adapter,
 * with a `payment_transactions` row for the attempt; a gateway that declines or is missing aborts the
 * whole transaction so no half-made refund is left. `invoices.applyRefund()` then rewrites the invoice.
 *
 * @param {import('express').Request} req
 * @param {number|string} paymentId
 * @param {object} spec
 * @returns {Promise<object>}
 */
async function requestRefund(req, paymentId, spec = {}) {
  const tenant = req.tenant;

  const refundId = await documentNumber.withRetry(
    () =>
      db.sequelize.transaction(async (transaction) => {
        const payment = await findById(tenant, paymentId, { detail: false, transaction, lock: true });

        if (!RECEIVED_STATUSES.includes(payment.status)) {
          throw new ApiError(409, `Payment ${payment.payment_number} is ${payment.status}; only received money can be refunded`, {
            code: 'PAYMENT_NOT_REFUNDABLE',
            details: { paymentId: payment.id, status: payment.status },
          });
        }

        const available = refundableAmount(payment);
        const amount = spec.amount === undefined ? available : money.round(spec.amount);

        if (money.toMinor(amount) <= 0) {
          throw new ApiError(422, 'A refund amount must be greater than zero', {
            code: 'REFUND_AMOUNT_INVALID',
            details: { amount },
          });
        }

        if (money.toMinor(amount) > money.toMinor(available)) {
          throw new ApiError(422, `Refund of ${amount} exceeds the ${available} still refundable on this payment`, {
            code: 'REFUND_EXCEEDS_PAYMENT',
            details: { requested: amount, refundable: available, alreadyRefunded: payment.refunded_amount },
          });
        }

        const refundNumber = await documentNumber.nextNumber(db.Refund, {
          column: 'refund_number',
          prefix: documentNumber.PREFIXES.REFUND,
          transaction,
        });

        /*
         * Money refunded to the wallet stays on the platform as credit (D5): a refund whose destination is
         * the wallet, and a refund of a payment drawn from the wallet — whose "original method" is the
         * wallet. Neither goes back through a gateway, even for a card payment, because nothing leaves.
         */
        const toWallet = spec.destination === 'wallet' || payment.method === PAYMENT_METHODS.WALLET;

        /* Gateway refunds go back through the adapter that took the charge. */
        const usedGateway = !toWallet && payment.method === GATEWAY_METHOD && payment.gateway_key;
        let gatewayRefundId = null;

        if (usedGateway) {
          const result = await paymentGateway.dispatch(payment.gateway_key, 'refund', {
            payment,
            amount,
            currency: payment.currency,
            metadata: spec.metadata || null,
          });

          await writeTransactionRow(
            {
              payment,
              direction: 'refund',
              result,
              amount,
              currency: payment.currency,
              gatewayKey: payment.gateway_key,
              request: { refundNumber },
            },
            transaction
          );

          if (result.status !== PAYMENT_TRANSACTION_STATUS.SUCCEEDED) {
            throw new ApiError(422, `The gateway declined the refund: ${result.errorMessage || 'unknown error'}`, {
              code: 'REFUND_GATEWAY_DECLINED',
              details: { gatewayKey: payment.gateway_key, errorCode: result.errorCode },
            });
          }
          gatewayRefundId = result.gatewayTransactionId;
        }

        const refund = await db.Refund.create(
          {
            refund_number: refundNumber,
            payment_id: payment.id,
            invoice_id: payment.invoice_id,
            school_id: payment.school_id,
            organization_id: payment.organization_id,
            currency: payment.currency,
            amount,
            reason: spec.reason || null,
            status: REFUND_STATUS.COMPLETED,
            destination: toWallet ? 'wallet' : 'original_method',
            gateway_key: usedGateway ? payment.gateway_key : null,
            gateway_refund_id: gatewayRefundId,
            processed_at: new Date(),
            requested_by: performerOf(req),
            approved_by: performerOf(req),
            metadata: spec.metadata || null,
          },
          { transaction }
        );

        if (toWallet) await creditWallet(payment.subscription_id, amount, transaction);

        /* Roll the payment's own tally forward and re-label it from the refunded totals. */
        const refundedTotal = await db.Refund.sum('amount', {
          where: { payment_id: payment.id, status: REFUND_STATUS.COMPLETED },
          transaction,
        });
        const newRefunded = money.round(refundedTotal || 0);
        payment.set({
          refunded_amount: newRefunded,
          status:
            money.toMinor(newRefunded) >= money.toMinor(payment.amount)
              ? PAYMENT_STATUS.REFUNDED
              : PAYMENT_STATUS.PARTIALLY_REFUNDED,
        });
        await payment.save({ transaction });

        /* Rewrite the invoice: applyPayment() re-sums received money, applyRefund() re-labels it. */
        if (payment.invoice_id) {
          const invoice = await invoicesService.loadForWrite(payment.invoice_id, { transaction, lock: true });
          await invoicesService.applyRefund(invoice, { transaction });
        }

        return refund.id;
      }),
    { column: 'refund_number' }
  );

  const refund = await db.Refund.findByPk(refundId);

  await recordAudit(req, {
    tableName: 'refunds',
    recordId: refund.id,
    event: 'create',
    after: snapshot(refund),
    reason: spec.reason || null,
  });

  return refund;
}

module.exports = {
  list,
  findById,
  submit,
  record,
  review,
  requestRefund,
  listRefunds,
  refundableAmount,
  transitionAfterSettlement,
  relativeUploadPath,
  SORTABLE,
  RECEIVED_STATUSES,
  GATEWAY_METHOD,
  ACTIVATE_FROM,
  REACTIVATE_FROM,
};
