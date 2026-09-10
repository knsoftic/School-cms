'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *
 *   RATE_LIMIT_MAX       raised past what this script needs; the limiter is not under test here and
 *   AUTH_RATE_LIMIT_MAX  a stray refusal must not colour a run that is almost entirely pure.
 *   BCRYPT_ROUNDS=10     nothing here hashes, but pinned so the value never comes from the local .env.
 *   PASSWORD_MIN_LENGTH  pinned for the same reason.
 *   MAIL_DRIVER=log      no mail is sent, but a stray SMTP attempt would hang the run.
 *   CACHE_TTL=600        pinned in every verification suite so a short TTL cannot make an assertion
 *                        pass for the wrong reason. This suite reads no cache, but the pin is house style.
 */
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.BCRYPT_ROUNDS = '10';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';
process.env.CACHE_TTL = '600';

/**
 * Verification of the billing module — `src/modules/{taxes,coupons,invoices,payments,quotations}/*`,
 * `src/utils/documentNumber.js`, `src/services/paymentGatewayService.js`, and the payment-proof upload
 * wiring in `src/middlewares/upload.js`.
 *
 * Covers SRS §13 (§13.1 invoices, §13.2 payments, §13.3 manual submission, §13.4 coupons), §33 (taxes,
 * refunds, quotations) and FR-BILL-001 … FR-BILL-005, plus SRS §30 Rule 1 — the money is computed from
 * the database rows, never hard-coded.
 *
 * ## What is asserted, and why each part exists
 *
 *  - **Part 1 — the money and the registry, directly.** Everything the SRS fixes as a *calculation* is a
 *    pure function, so it is asserted without a fixture and without HTTP:
 *      · `taxes.quoteFor()` — exclusive adds, inclusive is carved out of the base, no-tax is all zero.
 *      · `invoices.computeTotals()` — the §13.1 order *discount THEN tax* (a 10% coupon and a 10% tax on
 *        1000 bill 990, not 1000), the inclusive invariant `total = subtotal − discount + (inclusive ? 0
 *        : tax)`, wallet credit, and a fixed coupon larger than the bill clamping to the bill.
 *      · `coupons.discountOn()` — percentage, fixed, the `max_discount_amount` cap, and the clamp to base.
 *      · `quotations.computeTotals()` / `normaliseLine()` — the salesperson's figures, and `unit_amount`
 *        defaulting to `amount / quantity`.
 *      · `payments.refundableAmount()` — what arrived minus what has gone back, clamped at zero.
 *      · `documentNumber` — the `PREFIX-YYYYMM-NNNNN` format, `parse()`'s round-trip and its rejections,
 *        and `periodOf()`'s month boundary (which is why the counter restarts each month).
 *      · `paymentGatewayService` — the plugin registry that ships zero adapters: `get()` refuses with
 *        `PAYMENT_GATEWAY_NOT_CONFIGURED`, `dispatch()` lets that refusal propagate (its `get()` is
 *        outside the try/catch, which is what makes a `record` transaction abort cleanly), a registered
 *        stub round-trips, and `normaliseResult()` turns an unusable adapter reply into a recordable
 *        `failed` with `ADAPTER_CONTRACT`.
 *      · `upload` — `CEILING_SOURCES` shape and `uploadSingle()`'s missing-field guard.
 *
 *  - **Part 2 — the route tables, by name.** Every router's declared surface (method, path, order) is
 *    pinned, and the security property the module headers argue is checked directly: `requirePlatformScope()`
 *    resolves to a plain named function `platformGuard`, so its presence is visible without a request.
 *    Every management write carries it; the three school-reachable writes (`POST /coupons/validate`,
 *    `POST /invoices/:id/coupon`, `POST /payments`) deliberately do not; no read carries it. `GET
 *    /invoices/summary` is pinned *before* `GET /invoices/:id`, and `POST /payments` is shown to inject
 *    the upload chain the plain writes lack.
 *
 *  - **Part 3 — the request schemas, directly.** The decisions no HTTP response can show: the
 *    system-owned fields each module refuses (a 422, not a silent strip), the required inputs, the
 *    tax-rate and percentage-coupon ceilings, the fixed-coupon currency rule, and that a submitted
 *    payment may not name `online_gateway` while a recorded one may.
 *
 *  - **Part 4 — the scheduled sweeps, against the database.** `coupons.expireLapsed()`,
 *    `invoices.markOverdue()` and `quotations.expireLapsed()` have no route (their actor is the Phase-5
 *    cron) and are asserted here by direct call, the same way `verify-subscriptions.js` asserts
 *    `runLifecycleSweep()`. They are called with a reference date in the year 2000 so nothing matches —
 *    the assertion is that each executes against a live schema and returns its documented shape
 *    (`{expired}` / `{scanned, flagged}`) without needing any fixture rows.
 *
 *  - **Part 5 — over real HTTP, against the real database.** The money path FR-BILL-001 … 005 name:
 *    generate an invoice from a live subscription (with a tax), apply a coupon, submit a school
 *    payment, approve it, refund it. Figures are asserted as numbers so a DECIMAL serialised as
 *    `"990.00"` still has to equal 990. Fixture helpers throw on a non-2xx so a 422 in setup cannot
 *    look like an invoice-arithmetic defect (session 13, `makePlan()`).
 *
 * ## Part 4 requires a live database
 *
 * Parts 1–3 touch no database — the services are required (which does not connect) and only pure
 * functions and route tables are read. Part 4 calls `db.sequelize.authenticate()` first; if MySQL/MariaDB
 * is unreachable it prints a `SKIP` notice and the sweep assertions do not run, so the pure suite still
 * completes. Part 5 is skipped in the same breath — it needs the same connection.
 *
 * Run: node scripts/verify-billing.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');

const taxesService = require('../src/modules/taxes/taxes.service');
const couponsService = require('../src/modules/coupons/coupons.service');
const invoicesService = require('../src/modules/invoices/invoices.service');
const paymentsService = require('../src/modules/payments/payments.service');
const quotationsService = require('../src/modules/quotations/quotations.service');

const gateway = require('../src/services/paymentGatewayService');
const documentNumber = require('../src/utils/documentNumber');
const upload = require('../src/middlewares/upload');

const taxRoutes = require('../src/modules/taxes/taxes.routes');
const couponRoutes = require('../src/modules/coupons/coupons.routes');
const invoiceRoutes = require('../src/modules/invoices/invoices.routes');
const paymentRoutes = require('../src/modules/payments/payments.routes');
const quotationRoutes = require('../src/modules/quotations/quotations.routes');

const { schemas: taxSchemas } = require('../src/modules/taxes/taxes.validation');
const { schemas: couponSchemas } = require('../src/modules/coupons/coupons.validation');
const {
  schemas: paymentSchemas,
  SUBMITTABLE_METHODS,
} = require('../src/modules/payments/payments.validation');
const { schemas: quotationSchemas } = require('../src/modules/quotations/quotations.validation');

const {
  COUPON_TYPES,
  COUPON_STATUS,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  PAYMENT_TRANSACTION_STATUS,
  REFUND_STATUS,
  INVOICE_STATUS,
  UPLOAD_PROFILES,
  ROLES,
  USER_STATUS,
  BILLING_CYCLES,
  PRICING_MODELS,
  PLAN_VISIBILITY,
  LIMIT_LIST,
  LIMIT_TYPES,
} = require('../src/config/constants');

const { settle } = require('./lib/settle');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-billing.local';
const PASSWORD = 'Verify@Billing123';

/* A valid 1×1 PNG: the smallest screenshot the upload chain will accept as an image. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

let failures = 0;
let dbSkipped = false;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${
      ok ? '' : `  (expected ${JSON.stringify(expected)})`
    }`
  );
}

/** DECIMAL columns round-trip as strings over JSON; the assertion is about the amount. */
function num(value) {
  return Number(value);
}

/* ═══════════════════════════ part 1 — the money and the registry ═══════════════════════════ */

/** SRS §33 Tax / §13.1 invoice Tax field — `taxes.service.quoteFor()`, a pure function. */
function verifyTaxMath() {
  console.log('\n--- part 1a — taxes.quoteFor() ---');

  const none = taxesService.quoteFor(null, 1000);
  check('quoteFor(no tax).taxId', none.taxId, null);
  check('quoteFor(no tax).ratePercent', none.ratePercent, 0);
  check('quoteFor(no tax).isInclusive', none.isInclusive, false);
  check('quoteFor(no tax).addedAmount', none.addedAmount, 0);
  check('quoteFor(no tax).containedAmount', none.containedAmount, 0);

  /* Exclusive 15% on 1000 is added on top: 150, and nothing is "contained". */
  const excl = taxesService.quoteFor({ id: 7, code: 'VAT15', rate_percent: 15, is_inclusive: false }, 1000);
  check('quoteFor(exclusive 15%).taxId', excl.taxId, 7);
  check('quoteFor(exclusive 15%).code', excl.code, 'VAT15');
  check('quoteFor(exclusive 15%).ratePercent', excl.ratePercent, 15);
  check('quoteFor(exclusive 15%).isInclusive', excl.isInclusive, false);
  check('quoteFor(exclusive 15%).addedAmount', excl.addedAmount, 150);
  check('quoteFor(exclusive 15%).containedAmount', excl.containedAmount, 0);

  /* Inclusive 20% on 100 is carved out of the 100, not added: contained 16.67, added 0. */
  const incl = taxesService.quoteFor({ id: 3, code: 'GST20', rate_percent: 20, is_inclusive: true }, 100);
  check('quoteFor(inclusive 20%).isInclusive', incl.isInclusive, true);
  check('quoteFor(inclusive 20%).addedAmount', incl.addedAmount, 0);
  check('quoteFor(inclusive 20%).containedAmount', incl.containedAmount, 16.67);
}

/** SRS §13.1 — `invoices.service.computeTotals()`, directly assertable without a fixture. */
function verifyInvoiceMath() {
  console.log('\n--- part 1b — invoices.computeTotals() ---');

  /* A — exclusive tax, no coupon: 1000 + 15% = 1150. */
  const a = invoicesService.computeTotals({
    lines: [{ amount: 600 }, { amount: 400 }],
    tax: { rate_percent: 15, is_inclusive: false },
  });
  check('computeTotals(A).subtotal', a.subtotal, 1000);
  check('computeTotals(A).discountAmount', a.discountAmount, 0);
  check('computeTotals(A).taxAmount', a.taxAmount, 150);
  check('computeTotals(A).total', a.total, 1150);
  check('computeTotals(A).creditApplied', a.creditApplied, 0);
  check('computeTotals(A).amountDue', a.amountDue, 1150);

  /* B — inclusive tax: the tax is inside the 100, so the total stays 100 (the §13.1 invariant). */
  const b = invoicesService.computeTotals({
    lines: [{ amount: 100 }],
    tax: { rate_percent: 20, is_inclusive: true },
  });
  check('computeTotals(B).subtotal', b.subtotal, 100);
  check('computeTotals(B).taxAmount', b.taxAmount, 16.67);
  check('computeTotals(B).total (inclusive tax does not change it)', b.total, 100);
  check('computeTotals(B).amountDue', b.amountDue, 100);

  /* C — discount THEN tax: 10% off 1000 = 900, then 10% tax on 900 = 90 (not 100). Total 990. */
  const c = invoicesService.computeTotals({
    lines: [{ amount: 1000 }],
    coupon: { discount_type: COUPON_TYPES.PERCENTAGE, discount_value: 10 },
    tax: { rate_percent: 10, is_inclusive: false },
  });
  check('computeTotals(C).discountAmount', c.discountAmount, 100);
  check('computeTotals(C).taxAmount (on the discounted base)', c.taxAmount, 90);
  check('computeTotals(C).total', c.total, 990);

  /* D — wallet credit reduces what is due, not the total. */
  const d = invoicesService.computeTotals({ lines: [{ amount: 500 }], creditAvailable: 200 });
  check('computeTotals(D).total', d.total, 500);
  check('computeTotals(D).creditApplied', d.creditApplied, 200);
  check('computeTotals(D).amountDue', d.amountDue, 300);

  /* E — amountPaid is netted before credit is applied. */
  const e = invoicesService.computeTotals({
    lines: [{ amount: 500 }],
    amountPaid: 200,
    creditAvailable: 100,
  });
  check('computeTotals(E).creditApplied', e.creditApplied, 100);
  check('computeTotals(E).amountDue', e.amountDue, 200);

  /* F — a fixed coupon larger than the bill discounts the whole bill and no more. */
  const f = invoicesService.computeTotals({
    lines: [{ amount: 1000 }],
    coupon: { discount_type: COUPON_TYPES.FIXED_AMOUNT, discount_value: 5000 },
  });
  check('computeTotals(F).discountAmount (clamped to subtotal)', f.discountAmount, 1000);
  check('computeTotals(F).total', f.total, 0);
  check('computeTotals(F).amountDue', f.amountDue, 0);
}

/** SRS §13.4 — `coupons.service.discountOn()`, a pure function. */
function verifyCouponMath() {
  console.log('\n--- part 1c — coupons.discountOn() ---');

  check(
    'discountOn(10% of 250)',
    couponsService.discountOn({ discount_type: COUPON_TYPES.PERCENTAGE, discount_value: 10 }, 250),
    25
  );
  check(
    'discountOn(fixed 30 on 250)',
    couponsService.discountOn({ discount_type: COUPON_TYPES.FIXED_AMOUNT, discount_value: 30 }, 250),
    30
  );
  check(
    'discountOn(50% of 250, capped at 40)',
    couponsService.discountOn(
      { discount_type: COUPON_TYPES.PERCENTAGE, discount_value: 50, max_discount_amount: 40 },
      250
    ),
    40
  );
  check(
    'discountOn(fixed 999 on 100, clamped to base)',
    couponsService.discountOn({ discount_type: COUPON_TYPES.FIXED_AMOUNT, discount_value: 999 }, 100),
    100
  );
  check(
    'discountOn(10% of 250, null cap ignored)',
    couponsService.discountOn(
      { discount_type: COUPON_TYPES.PERCENTAGE, discount_value: 10, max_discount_amount: null },
      250
    ),
    25
  );
}

/** SRS §33 Quotations — `computeTotals()` and `normaliseLine()`, pure. */
function verifyQuotationMath() {
  console.log('\n--- part 1d — quotations.computeTotals() / normaliseLine() ---');

  const t0 = quotationsService.computeTotals([{ amount: 100 }, { amount: 50 }], 0, 0);
  check('quotation totals(150, no disc/tax).subtotal', t0.subtotal, 150);
  check('quotation totals(150, no disc/tax).total', t0.total, 150);

  const t1 = quotationsService.computeTotals([{ amount: 100 }, { amount: 50 }], 20, 10);
  check('quotation totals(150 − 20 + 10).discountAmount', t1.discountAmount, 20);
  check('quotation totals(150 − 20 + 10).taxAmount', t1.taxAmount, 10);
  check('quotation totals(150 − 20 + 10).total', t1.total, 140);

  const t2 = quotationsService.computeTotals([{ amount: 100 }, { amount: 50 }], 500, 0);
  check('quotation totals(disc > subtotal).discountAmount (clamped)', t2.discountAmount, 150);
  check('quotation totals(disc > subtotal).total', t2.total, 0);

  const l1 = quotationsService.normaliseLine({ description: 'Widget', amount: 100, quantity: 4 });
  check('normaliseLine(100 / 4).unit_amount', l1.unit_amount, 25);
  check('normaliseLine(100 / 4).quantity', l1.quantity, 4);
  check('normaliseLine(100 / 4).item_type (default)', l1.item_type, 'custom');

  const l2 = quotationsService.normaliseLine({ description: 'Service', amount: 100, quantity: 3 });
  check('normaliseLine(100 / 3).unit_amount (rounded)', l2.unit_amount, 33.33);

  const l3 = quotationsService.normaliseLine({
    description: 'Given',
    amount: 50,
    quantity: 2,
    unit_amount: 25,
    item_type: 'plan',
  });
  check('normaliseLine(given unit_amount).unit_amount', l3.unit_amount, 25);
  check('normaliseLine(given item_type).item_type', l3.item_type, 'plan');

  const l4 = quotationsService.normaliseLine({ description: 'NoQty', amount: 80 });
  check('normaliseLine(no quantity).quantity (defaults to 1)', l4.quantity, 1);
  check('normaliseLine(no quantity).unit_amount', l4.unit_amount, 80);
}

/** SRS §33 Refunds — `payments.service.refundableAmount()`, pure. */
function verifyRefundMath() {
  console.log('\n--- part 1e — payments.refundableAmount() ---');

  check('refundableAmount(100 paid, 30 back)', paymentsService.refundableAmount({ amount: 100, refunded_amount: 30 }), 70);
  check('refundableAmount(100 paid, 100 back)', paymentsService.refundableAmount({ amount: 100, refunded_amount: 100 }), 0);
  check('refundableAmount(100 paid, none back)', paymentsService.refundableAmount({ amount: 100 }), 100);
  check('refundableAmount(over-refunded, clamped)', paymentsService.refundableAmount({ amount: 50, refunded_amount: 80 }), 0);
}

/** `utils/documentNumber.js` — the `PREFIX-YYYYMM-NNNNN` allocation, pure. */
function verifyDocumentNumber() {
  console.log('\n--- part 1f — documentNumber format/parse/period ---');

  check('PREFIXES.INVOICE', documentNumber.PREFIXES.INVOICE, 'INV');
  check('PREFIXES.PAYMENT', documentNumber.PREFIXES.PAYMENT, 'PAY');
  check('PREFIXES.REFUND', documentNumber.PREFIXES.REFUND, 'REF');
  check('PREFIXES.QUOTATION', documentNumber.PREFIXES.QUOTATION, 'QTN');

  check('format(INV, 202608, 1)', documentNumber.format('INV', '202608', 1), 'INV-202608-00001');
  check('format(INV, 202608, 42)', documentNumber.format('INV', '202608', 42), 'INV-202608-00042');
  check('format(INV, 202608, 123456) (width is a floor)', documentNumber.format('INV', '202608', 123456), 'INV-202608-123456');

  const parsed = documentNumber.parse('INV-202608-00007');
  check('parse(INV-202608-00007).prefix', parsed.prefix, 'INV');
  check('parse(INV-202608-00007).period', parsed.period, '202608');
  check('parse(INV-202608-00007).counter', parsed.counter, 7);

  const messy = documentNumber.parse('  inv-202608-7 ');
  check('parse(trims and uppercases).prefix', messy.prefix, 'INV');
  check('parse(trims and uppercases).counter', messy.counter, 7);

  check('parse(prefix too long) → null', documentNumber.parse('INVOICE-202608-1'), null);
  check('parse(no counter) → null', documentNumber.parse('INV-202608'), null);
  check('parse(gibberish) → null', documentNumber.parse('not-a-number'), null);

  /*
   * `periodOf()` reads local getFullYear/getMonth, so these dates are built from local components to
   * avoid a timezone rolling the day across a month boundary. August and September land in different
   * periods, which is why the counter restarts each month.
   */
  check('periodOf(Aug 2026)', documentNumber.periodOf(new Date(2026, 7, 15)), '202608');
  check('periodOf(Sep 2026) (next month → new counter)', documentNumber.periodOf(new Date(2026, 8, 1)), '202609');
  check('periodOf(Jan 2026)', documentNumber.periodOf(new Date(2026, 0, 1)), '202601');
  check('periodOf(Dec 2026)', documentNumber.periodOf(new Date(2026, 11, 31)), '202612');
}

/** SRS §13.2 — the plugin payment-gateway registry, which ships zero adapters. */
async function verifyGateway() {
  console.log('\n--- part 1g — paymentGatewayService (zero adapters shipped) ---');

  check('list() is empty', gateway.list(), []);
  check('has(anything) is false', gateway.has('stripe'), false);
  check('isConfigured() is false (no credentials)', gateway.isConfigured(), false);

  /* get() refuses when nothing is registered — and names *why* it refused. */
  let getErr = null;
  try {
    gateway.get('stripe');
  } catch (err) {
    getErr = err;
  }
  check('get(unknown) throws', Boolean(getErr), true);
  check('get(unknown).statusCode', getErr && getErr.statusCode, 422);
  check('get(unknown).code', getErr && getErr.code, 'PAYMENT_GATEWAY_NOT_CONFIGURED');

  /*
   * dispatch() calls get() *outside* its try/catch, so the not-configured refusal propagates rather than
   * becoming a failed result. This is what lets `payments.record` abort its transaction cleanly.
   */
  let dispErr = null;
  try {
    await gateway.dispatch('stripe', 'charge', {});
  } catch (err) {
    dispErr = err;
  }
  check('dispatch(unknown) propagates the refusal', dispErr && dispErr.code, 'PAYMENT_GATEWAY_NOT_CONFIGURED');

  /* normaliseResult() turns an unusable adapter reply into a recordable `failed`. */
  const known = Object.values(PAYMENT_TRANSACTION_STATUS)[0];
  const bad = gateway.normaliseResult(undefined);
  check('normaliseResult(undefined).status', bad.status, PAYMENT_TRANSACTION_STATUS.FAILED);
  check('normaliseResult(undefined).errorCode', bad.errorCode, 'ADAPTER_CONTRACT');
  check('normaliseResult(undefined).gatewayTransactionId', bad.gatewayTransactionId, null);
  check(
    'normaliseResult(bogus status).errorCode',
    gateway.normaliseResult({ status: 'not-a-real-status' }).errorCode,
    'ADAPTER_CONTRACT'
  );
  check(
    'normaliseResult(known status).errorCode (no contract error)',
    gateway.normaliseResult({ status: known }).errorCode,
    null
  );

  /* A registered adapter round-trips: it can be found, dispatched to, then removed. */
  let regErr = null;
  try {
    gateway.register({ key: 'bad-adapter' });
  } catch (err) {
    regErr = err;
  }
  check('register(no charge/refund) throws', Boolean(regErr), true);

  gateway.register({
    key: 'verify-stub',
    label: 'Verify Stub',
    charge: async () => ({ status: known, gatewayTransactionId: 'tx_verify', raw: { ok: true } }),
    refund: async () => ({ status: known }),
  });
  check('has(verify-stub) after register', gateway.has('verify-stub'), true);
  check('list() has the one adapter', gateway.list().length, 1);
  check('get(verify-stub).key', gateway.get('verify-stub').key, 'verify-stub');

  const charged = await gateway.dispatch('verify-stub', 'charge', { amount: 100 });
  check('dispatch(stub, charge).status', charged.status, known);
  check('dispatch(stub, charge).gatewayTransactionId', charged.gatewayTransactionId, 'tx_verify');
  check('dispatch(stub, charge).errorCode', charged.errorCode, null);

  check('unregister(verify-stub)', gateway.unregister('verify-stub'), true);
  check('has(verify-stub) after unregister', gateway.has('verify-stub'), false);
  check('list() is empty again', gateway.list(), []);
}

/** SRS §13.3 — the payment-proof upload profile is wired for a lapsed school; the factory validates input. */
function verifyUploadWiring() {
  console.log('\n--- part 1h — upload wiring ---');

  check('CEILING_SOURCES', upload.CEILING_SOURCES, { PLAN: 'plan', SERVER: 'server' });

  let fieldErr = null;
  try {
    upload.uploadSingle(UPLOAD_PROFILES.PAYMENT_PROOF);
  } catch (err) {
    fieldErr = err;
  }
  check('uploadSingle(no field) throws', Boolean(fieldErr), true);
  check('uploadSingle(no field).message', fieldErr && fieldErr.message, 'uploadSingle() requires a field name');
}

/* ═══════════════════════════ part 2 — the declared route tables ═══════════════════════════ */

function stackOf(router, method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer ? layer.route.stack.map((s) => s.handle) : null;
}

/** Routes declared by a router, in declaration order. */
function routesOf(router) {
  return router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
}

/** Is a named guard on this route? Only works for guards that are not asyncHandler-wrapped. */
function named(router, method, path, fnName) {
  const stack = stackOf(router, method, path);
  return stack ? stack.some((fn) => fn.name === fnName) : null;
}

function verifyRouting() {
  console.log('\n--- part 2 — the declared surface ---');

  check('taxes route table', routesOf(taxRoutes), [
    'GET /',
    'POST /',
    'POST /default/clear',
    'GET /:id',
    'PATCH /:id',
    'POST /:id/default',
    'DELETE /:id',
  ]);
  check('coupons route table', routesOf(couponRoutes), [
    'GET /',
    'POST /validate',
    'POST /',
    'GET /:id',
    'GET /:id/usages',
    'PATCH /:id',
    'DELETE /:id',
  ]);
  check('invoices route table (summary before :id)', routesOf(invoiceRoutes), [
    'GET /',
    'GET /summary',
    'POST /generate',
    'GET /:id',
    'POST /:id/finalise',
    'POST /:id/cancel',
    'POST /:id/coupon',
    'DELETE /:id/coupon',
  ]);
  check('payments route table (refund sub-resource, no bare :id write)', routesOf(paymentRoutes), [
    'GET /',
    'POST /record',
    'POST /',
    'GET /:id/screenshot',
    'GET /:id',
    'POST /:id/approve',
    'POST /:id/reject',
    'GET /:id/refunds',
    'POST /:id/refunds',
  ]);
  check('quotations route table (7 routes, no DELETE)', routesOf(quotationRoutes), [
    'GET /',
    'POST /',
    'GET /:id',
    'PATCH /:id',
    'POST /:id/send',
    'POST /:id/accept',
    'POST /:id/reject',
  ]);

  /* Every management write carries the platform-scope guard — the condition no re-granted key satisfies. */
  const writesWithScope = [
    [taxRoutes, 'taxes', [['post', '/'], ['post', '/default/clear'], ['patch', '/:id'], ['post', '/:id/default'], ['delete', '/:id']]],
    [couponRoutes, 'coupons', [['post', '/'], ['patch', '/:id'], ['delete', '/:id']]],
    [invoiceRoutes, 'invoices', [['post', '/generate'], ['post', '/:id/finalise'], ['post', '/:id/cancel'], ['delete', '/:id/coupon']]],
    [paymentRoutes, 'payments', [['post', '/record'], ['post', '/:id/approve'], ['post', '/:id/reject'], ['post', '/:id/refunds']]],
    [quotationRoutes, 'quotations', [['post', '/'], ['patch', '/:id'], ['post', '/:id/send'], ['post', '/:id/accept'], ['post', '/:id/reject']]],
  ];
  for (const [router, name, routes] of writesWithScope) {
    for (const [m, p] of routes) {
      check(`${name}: platformGuard on ${m.toUpperCase()} ${p}`, named(router, m, p, 'platformGuard'), true);
    }
  }

  /* The three writes a school may make deliberately carry NO platform-scope guard. */
  const schoolReachable = [
    [couponRoutes, 'coupons', 'post', '/validate'],
    [invoiceRoutes, 'invoices', 'post', '/:id/coupon'],
    [paymentRoutes, 'payments', 'post', '/'],
  ];
  for (const [router, name, m, p] of schoolReachable) {
    check(`${name}: NO platformGuard on ${m.toUpperCase()} ${p} (school-reachable)`, named(router, m, p, 'platformGuard'), false);
  }

  /* No read carries the platform-scope guard — tenant confinement does that job. */
  const reads = [
    [taxRoutes, 'taxes', [['get', '/'], ['get', '/:id']]],
    [couponRoutes, 'coupons', [['get', '/'], ['get', '/:id'], ['get', '/:id/usages']]],
    [invoiceRoutes, 'invoices', [['get', '/'], ['get', '/summary'], ['get', '/:id']]],
    [paymentRoutes, 'payments', [['get', '/'], ['get', '/:id'], ['get', '/:id/refunds']]],
    [quotationRoutes, 'quotations', [['get', '/'], ['get', '/:id']]],
  ];
  for (const [router, name, routes] of reads) {
    for (const [m, p] of routes) {
      check(`${name}: no platformGuard on read ${m.toUpperCase()} ${p}`, named(router, m, p, 'platformGuard'), false);
    }
  }

  /* Validation is declared on the routes that take a body/query. */
  check('taxes POST / validates', named(taxRoutes, 'post', '/', 'validateRequest'), true);
  check('coupons POST /validate validates', named(couponRoutes, 'post', '/validate', 'validateRequest'), true);
  check('invoices POST /generate validates', named(invoiceRoutes, 'post', '/generate', 'validateRequest'), true);

  /* POST /payments injects the upload chain the plain writes lack (its stack is longer than /record's). */
  const submitStack = stackOf(paymentRoutes, 'post', '/');
  const recordStack = stackOf(paymentRoutes, 'post', '/record');
  check('payments POST / injects the upload chain (longer than /record)', submitStack.length > recordStack.length, true);
}

/* ═══════════════════════════ part 3 — the request schemas ═══════════════════════════ */

/** Mirror the `validate` middleware's body options: convert, no early abort, strip unknown keys. */
const VALIDATE_OPTIONS = { abortEarly: false, convert: true, stripUnknown: true };

/** Validate against one schema and report the outcome in a shape an assertion can name. */
function run(schema, value) {
  const { error, value: cleaned } = schema.validate(value, VALIDATE_OPTIONS);
  return { ok: !error, value: cleaned };
}

function verifySchemas() {
  console.log('\n--- part 3 — the request schemas ---');

  /* Taxes — SRS §33. */
  check('tax.create({}) is refused (name/code/rate required)', run(taxSchemas.create, {}).ok, false);
  const taxOk = run(taxSchemas.create, { name: 'Value Added', code: 'vat', rate_percent: 15 });
  check('tax.create(valid).ok', taxOk.ok, true);
  check('tax.create uppercases code', taxOk.value.code, 'VAT');
  check('tax.create defaults is_inclusive', taxOk.value.is_inclusive, false);
  check('tax.create defaults is_active', taxOk.value.is_active, true);
  check('tax.create defaults is_default', taxOk.value.is_default, false);
  check('tax.create(rate > 100) is refused', run(taxSchemas.create, { name: 'Triple', code: 'TRIPLE', rate_percent: 200 }).ok, false);
  check('tax.update({}) is refused (min 1)', run(taxSchemas.update, {}).ok, false);

  /* Coupons — SRS §13.4. */
  check(
    'coupon.create(percentage 10%).ok',
    run(couponSchemas.create, { code: 'SAVE10', discount_type: COUPON_TYPES.PERCENTAGE, discount_value: 10 }).ok,
    true
  );
  check(
    'coupon.create(percentage > 100) is refused',
    run(couponSchemas.create, { code: 'SAVE10', discount_type: COUPON_TYPES.PERCENTAGE, discount_value: 150 }).ok,
    false
  );
  check(
    'coupon.create(fixed, no currency) is refused',
    run(couponSchemas.create, { code: 'FLAT5', discount_type: COUPON_TYPES.FIXED_AMOUNT, discount_value: 5 }).ok,
    false
  );
  check(
    'coupon.create(fixed, with currency).ok',
    run(couponSchemas.create, { code: 'FLAT5', discount_type: COUPON_TYPES.FIXED_AMOUNT, discount_value: 5, currency: 'USD' }).ok,
    true
  );
  check(
    'coupon.create(percentage + currency) is refused (currency-agnostic)',
    run(couponSchemas.create, { code: 'PCT10', discount_type: COUPON_TYPES.PERCENTAGE, discount_value: 10, currency: 'USD' }).ok,
    false
  );
  check(
    'coupon.create(used_count) is refused (system-owned)',
    run(couponSchemas.create, { code: 'SAVE20', discount_type: COUPON_TYPES.PERCENTAGE, discount_value: 10, used_count: 5 }).ok,
    false
  );
  check(
    'coupon.create(status: expired) is refused (sweep-owned)',
    run(couponSchemas.create, { code: 'SAVE30', discount_type: COUPON_TYPES.PERCENTAGE, discount_value: 10, status: COUPON_STATUS.EXPIRED }).ok,
    false
  );
  check('coupon.validate(code only) is refused (amount required)', run(couponSchemas.validateCode, { code: 'SAVE10' }).ok, false);
  check('coupon.validate(code + amount).ok', run(couponSchemas.validateCode, { code: 'SAVE10', amount: 100 }).ok, true);

  /* Payments — SRS §13.2 / §13.3. */
  const okMethod = SUBMITTABLE_METHODS[0];
  check('payment.submit(non-gateway method).ok', run(paymentSchemas.submit, { invoice_id: 1, amount: 100, method: okMethod }).ok, true);
  check(
    'payment.submit(online_gateway) is refused (not a school method)',
    run(paymentSchemas.submit, { invoice_id: 1, amount: 100, method: PAYMENT_METHODS.ONLINE_GATEWAY }).ok,
    false
  );
  check(
    'payment.submit(gateway_key) is refused',
    run(paymentSchemas.submit, { invoice_id: 1, amount: 100, method: okMethod, gateway_key: 'stripe' }).ok,
    false
  );
  check(
    'payment.submit(status) is refused (system-owned)',
    run(paymentSchemas.submit, { invoice_id: 1, amount: 100, method: okMethod, status: 'approved' }).ok,
    false
  );
  check(
    'payment.record(online_gateway).ok (platform may charge)',
    run(paymentSchemas.record, { invoice_id: 1, amount: 100, method: PAYMENT_METHODS.ONLINE_GATEWAY }).ok,
    true
  );
  check(
    'payment.record(screenshot_path) is refused (derived from upload)',
    run(paymentSchemas.record, { invoice_id: 1, amount: 100, method: okMethod, screenshot_path: 'x.png' }).ok,
    false
  );
  const refundOk = run(paymentSchemas.createRefund, {});
  check('refund.create({}).ok (amount optional = full balance)', refundOk.ok, true);
  check('refund.create defaults destination', refundOk.value.destination, 'original_method');
  check('refund.create(negative amount) is refused', run(paymentSchemas.createRefund, { amount: -5 }).ok, false);

  /* Quotations — SRS §33. */
  const line = { description: 'A', amount: 100 };
  check('quotation.create(one line).ok', run(quotationSchemas.create, { line_items: [line] }).ok, true);
  check('quotation.create({}) is refused (line_items required)', run(quotationSchemas.create, {}).ok, false);
  check(
    'quotation.create accepts quoted discount/tax figures',
    run(quotationSchemas.create, { line_items: [line], discount_amount: 10, tax_amount: 5 }).ok,
    true
  );
  for (const [field, value] of [
    ['quotation_number', 'X'],
    ['total', 500],
    ['status', 'sent'],
    ['converted_invoice_id', 5],
    ['created_by', 2],
  ]) {
    check(`quotation.create(${field}) is refused (system-owned)`, run(quotationSchemas.create, { line_items: [line], [field]: value }).ok, false);
  }
  const acceptDefault = run(quotationSchemas.accept, {});
  check('quotation.accept({}).ok', acceptDefault.ok, true);
  check('quotation.accept defaults convert=true', acceptDefault.value.convert, true);
  check('quotation.accept(convert:false).convert', run(quotationSchemas.accept, { convert: false }).value.convert, false);
}

/* ═══════════════════════════ part 4 — the scheduled sweeps (database) ═══════════════════════════ */

/**
 * The three sweeps that have no route. Called with a year-2000 reference date so nothing matches — the
 * assertion is that each runs against a live schema and returns its documented shape, fixture-free.
 * Skipped with a notice when the database is unreachable.
 */
async function verifyDatabase() {
  console.log('\n--- part 4 — the scheduled sweeps, against the database ---');

  try {
    await db.sequelize.authenticate();
  } catch (err) {
    dbSkipped = true;
    console.log(`SKIP  database unreachable — Part 4 not executed  ->  ${err.original ? err.original.code : err.code || err.name}`);
    console.log('      start MySQL/MariaDB and re-run to execute the sweep assertions');
    return;
  }

  const epoch = new Date('2000-01-01T00:00:00.000Z');

  const coupons = await couponsService.expireLapsed({ at: epoch });
  check('coupons.expireLapsed(epoch).expired', coupons.expired, 0);

  const invoices = await invoicesService.markOverdue({ at: epoch });
  check('invoices.markOverdue(epoch)', invoices, { scanned: 0, flagged: 0 });

  const quotations = await quotationsService.expireLapsed({ asOf: epoch });
  check('quotations.expireLapsed(epoch)', quotations, { expired: 0 });
}

/* ═══════════════════════════ part 5 — over HTTP ═══════════════════════════ */

/**
 * The money path the next-task paragraph named: issue → coupon → tax → pay → approve → refund.
 * Fixture helpers throw on a non-2xx so a setup 422 cannot look like an arithmetic defect.
 */
async function verifyHttp() {
  console.log('\n--- part 5 — issue → coupon → tax → pay → approve → refund, over HTTP ---');

  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  const created = {
    users: [],
    schools: [],
    organizations: [],
    plans: [],
    subscriptions: [],
    taxes: [],
    coupons: [],
    invoices: [],
    payments: [],
    addonPrices: [],
  };
  const baseline = {
    activityLog: (await db.ActivityLog.max('id')) || 0,
    auditLog: (await db.AuditLog.max('id')) || 0,
  };

  async function call(path, { method = 'GET', body, token, form } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers, body: payload });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* left null */
    }
    return { status: res.status, body: parsed, raw: text };
  }

  const codeOf = (res) => (res.body && res.body.error ? res.body.error.code : `no-error:${res.status}`);
  const dataOf = (res) => (res.body && res.body.data !== undefined ? res.body.data : null);

  async function expectOk(path, options, wantStatus) {
    const res = await call(path, options);
    if (res.status !== wantStatus) {
      throw new Error(`${options.method || 'GET'} ${path} expected ${wantStatus}, got ${res.status}: ${res.raw}`);
    }
    return res;
  }

  /**
   * Id-based teardown plus a VBL-/VBL prefix sweep, so a crash mid-run that never captured an id
   * cannot leave a unique-code row for the next run to trip over.
   */
  async function teardown() {
    /*
     * Scoped to this run's own tenant — Known Issues #25. An unbounded delete above `baseline` also
     * removes rows belonging to any suite running concurrently, which is the mechanism behind
     * "a parallel run reports false failures": the victim then reads `[]`, not a partial set.
     *
     * Both tables are ON DELETE CASCADE from `schools` and `organizations`, so this run's rows would
     * be removed anyway when its schools and organization go. This stays explicit as belt-and-braces
     * and to keep the ordering obvious; what matters is that it can no longer reach another run.
     *
     * Rows with neither a school nor an organization — the seeded Super Admin's sign-ins — are left.
     * Every suite authenticates as that same user, so no run can claim them, and they sit below the
     * next run's baseline where no assertion can see them.
     */
    const ownTenant = [
      ...(Array.isArray(created.schools) && created.schools.length ? [{ school_id: created.schools }] : []),
      ...(Array.isArray(created.organizations) && created.organizations.length
        ? [{ organization_id: created.organizations }] : []),
      /*
       * The run's own users, which catches its PLATFORM-scope rows — sign-ins and super-admin
       * actions have no school and no organization, so the two clauses above never match them and
       * the cascade from `schools`/`organizations` never reaches them either. This clause only works
       * because it runs BEFORE `User.destroy` below: both trail tables are ON DELETE SET NULL from
       * `users`, so afterwards there is no `user_id` left to match.
       */
      ...(Array.isArray(created.users) && created.users.length ? [{ user_id: created.users }] : []),
    ];
    if (ownTenant.length) {
      await db.ActivityLog.destroy({
        where: { id: { [db.Op.gt]: baseline.activityLog }, [db.Op.or]: ownTenant },
      });
      await db.AuditLog.destroy({
        where: { id: { [db.Op.gt]: baseline.auditLog }, [db.Op.or]: ownTenant },
      });
    }

    const leftoverOrgs = await db.Organization.findAll({
      where: { code: { [db.Op.like]: 'VBL-%' } },
      attributes: ['id'],
    });
    const leftoverSchools = await db.School.findAll({
      where: {
        [db.Op.or]: [
          { code: { [db.Op.like]: 'VBL-%' } },
          ...(leftoverOrgs.length ? [{ organization_id: leftoverOrgs.map((row) => row.id) }] : []),
        ],
      },
      attributes: ['id'],
    });
    const schoolIds = [...new Set([...created.schools, ...leftoverSchools.map((row) => row.id)])];

    const leftoverInvoices = schoolIds.length
      ? await db.Invoice.findAll({ where: { school_id: schoolIds }, attributes: ['id'] })
      : [];
    const invoiceIds = [...new Set([...created.invoices, ...leftoverInvoices.map((row) => row.id)])];

    const leftoverPayments = invoiceIds.length
      ? await db.Payment.findAll({ where: { invoice_id: invoiceIds }, attributes: ['id'] })
      : [];
    const paymentIds = [...new Set([...created.payments, ...leftoverPayments.map((row) => row.id)])];

    if (paymentIds.length) {
      await db.Refund.destroy({ where: { payment_id: paymentIds } });
      await db.PaymentTransaction.destroy({ where: { payment_id: paymentIds } });
      await db.Payment.destroy({ where: { id: paymentIds } });
    }
    if (invoiceIds.length) {
      await db.InvoiceItem.destroy({ where: { invoice_id: invoiceIds } });
      await db.CouponUsage.destroy({ where: { invoice_id: invoiceIds } });
      await db.Invoice.destroy({ where: { id: invoiceIds } });
    }

    const leftoverCoupons = await db.Coupon.findAll({
      where: { code: { [db.Op.like]: 'VBL%' } },
      attributes: ['id'],
    });
    const couponIds = [...new Set([...created.coupons, ...leftoverCoupons.map((row) => row.id)])];
    if (couponIds.length) await db.CouponUsage.destroy({ where: { coupon_id: couponIds } });
    if (couponIds.length) await db.Coupon.destroy({ where: { id: couponIds } });
    await db.Tax.destroy({
      where: { [db.Op.or]: [{ code: { [db.Op.like]: 'VBL%' } }, ...(created.taxes.length ? [{ id: created.taxes }] : [])] },
    });

    const leftoverSubs = schoolIds.length
      ? await db.Subscription.findAll({ where: { school_id: schoolIds }, attributes: ['id'] })
      : [];
    const subscriptionIds = [
      ...new Set([...created.subscriptions, ...leftoverSubs.map((row) => row.id)]),
    ];
    /*
     * The one add-on price this run creates. `subscription_addons.addon_price_id` is SET NULL and
     * the purchases go with their subscriptions below, so only the row itself is left. Scoped to
     * ids this run captured rather than a max-id baseline: `addon_prices` ships empty, and a
     * blanket `id > baseline` would delete a row another suite is using.
     */
    if (created.addonPrices.length) {
      await db.AddonPrice.destroy({ where: { id: created.addonPrices } });
    }
    if (subscriptionIds.length) {
      await db.SubscriptionItem.destroy({ where: { subscription_id: subscriptionIds } });
      await db.SubscriptionHistory.destroy({ where: { subscription_id: subscriptionIds } });
      await db.SubscriptionAddon.destroy({ where: { subscription_id: subscriptionIds } });
      await db.SubscriptionOverride.destroy({ where: { subscription_id: subscriptionIds } });
      await db.UsageRecord.destroy({ where: { subscription_id: subscriptionIds } });
      await db.Subscription.destroy({ where: { id: subscriptionIds } });
    }

    await db.SubscriptionPlan.destroy({
      where: { code: { [db.Op.like]: 'VBL-%' } },
      force: true,
      paranoid: false,
    });

    await db.User.destroy({
      where: {
        [db.Op.or]: [
          { email: { [db.Op.like]: `%@${DOMAIN}` } },
          ...(created.users.length ? [{ id: created.users }] : []),
        ],
      },
      force: true,
    });
    if (schoolIds.length) await db.School.destroy({ where: { id: schoolIds }, force: true });
    const orgIds = [...new Set([...created.organizations, ...leftoverOrgs.map((row) => row.id)])];
    if (orgIds.length) await db.Organization.destroy({ where: { id: orgIds }, force: true });

    /* The receipt the D8 case uploads lands under the school's own upload directory. */
    for (const id of schoolIds) {
      fs.rmSync(path.join(config.uploads.dir, `school-${id}`), { recursive: true, force: true });
    }
  }

  try {
    /*
     * What a killed earlier run of this suite left behind — see scripts/lib/residue.js.
     *
     * Before `teardown()`, not after. At this point `created` is empty, so teardown's log clause
     * matches nothing and its prefix sweep deletes the dead run's users with their log rows still in
     * place — and `user_id` is SET NULL, so those rows lose the only key that pointed back at this
     * suite. Measured: every killed run left eleven activity and ten audit rows that no later run
     * could reach. The sweep deletes a user's log rows before the user.
     */
    const residueCleared = await sweepResidue(db, { codes: ['VBL'], domains: ['verify-billing.local'], also: [{ table: 'coupons', column: 'code', prefix: 'VBL' }, { table: 'taxes', column: 'code', prefix: 'VBL' }], uploadsDir: config.uploads.dir });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    /* Clear a previous crash's unique-code rows before this run writes its own. */
    await teardown();

    const roles = {};
    for (const slug of [ROLES.SUPER_ADMIN, ROLES.PRINCIPAL]) {
      roles[slug] = await db.Role.findOne({ where: { slug } });
      if (!roles[slug]) throw new Error(`The ${slug} role is missing — run the seeders first.`);
    }

    const org = await db.Organization.create({ name: 'Verify Billing Group', code: 'VBL-ORG' });
    created.organizations.push(org.id);
    const school = await db.School.create({
      organization_id: org.id,
      name: 'Verify Billing School',
      code: 'VBL-S1',
    });
    created.schools.push(school.id);

    const password_hash = await hashPassword(PASSWORD);
    const people = [
      ['platform', ROLES.SUPER_ADMIN, 'Verify Billing Platform', 'vbl_platform', null, null],
      ['principal', ROLES.PRINCIPAL, 'Verify Billing Principal', 'vbl_principal', org.id, school.id],
    ];
    for (const [key, slug, name, username, organization_id, school_id] of people) {
      const user = await db.User.create({
        role_id: roles[slug].id,
        organization_id,
        school_id,
        name,
        email: `${key}@${DOMAIN}`,
        username,
        password_hash,
        status: USER_STATUS.ACTIVE,
        must_change_password: false,
      });
      created.users.push(user.id);
    }

    async function signIn(identifier) {
      const res = await call('/auth/login', { method: 'POST', body: { identifier, password: PASSWORD } });
      const token = res.body && res.body.data ? res.body.data.accessToken : null;
      if (!token) throw new Error(`sign-in failed for ${identifier}: ${res.raw}`);
      return token;
    }

    const platform = await signIn(`platform@${DOMAIN}`);
    const principal = await signIn(`principal@${DOMAIN}`);
    check('the platform admin signs in', typeof platform, 'string');
    check('the principal signs in', typeof principal, 'string');

    const taxRes = await expectOk(
      '/taxes',
      {
        method: 'POST',
        token: platform,
        body: { name: 'Verify Billing VAT', code: 'VBLVAT', rate_percent: 10, is_inclusive: false },
      },
      201
    );
    const tax = dataOf(taxRes).tax;
    created.taxes.push(tax.id);
    check('tax created at 10% exclusive', num(tax.rate_percent), 10);

    const couponRes = await expectOk(
      '/coupons',
      {
        method: 'POST',
        token: platform,
        body: {
          code: 'VBL10',
          name: 'Verify Billing 10%',
          discount_type: COUPON_TYPES.PERCENTAGE,
          discount_value: 10,
        },
      },
      201
    );
    const coupon = dataOf(couponRes).coupon;
    created.coupons.push(coupon.id);
    check('percentage coupon created', coupon.code, 'VBL10');

    /*
     * **Reading the list, which nothing did until session 26.**
     *
     * This suite created coupons and never listed them, and `GET /coupons` was broken the whole time:
     * `coupons.service.js:155` included the `createdBy` user with `attributes: ['id', 'full_name',
     * 'email']`, and `users` has no `full_name` column — it has `name`. Every call returned 500 from
     * a SequelizeDatabaseError. `GET /coupons/:id/usages` carried the same mistake at :230.
     *
     * It survived because the coverage was shaped like the writing, not like the reading. A POST that
     * returns 201 says nothing about the SELECT that lists what it created, and the route table in
     * `verify-app.js` only proves the route is *mounted*. The defect was found by rendering the
     * screen: §33's Coupons page showed "Internal server error" against a live API.
     *
     * These two assertions are the ones that would have caught it. They are deliberately shallow —
     * a 200 and the created row coming back — because the failure mode is a query that cannot run at
     * all, not a subtle difference in the payload.
     */
    /*
     * `call()` rather than `expectOk()`, deliberately. `expectOk` throws on a status mismatch, so
     * reintroducing the bug aborted the whole suite instead of failing the assertion that names it —
     * a detection, but the poor kind. These read the status and let `check` report it.
     */
    const couponList = await call('/coupons', { token: platform });
    check('the coupon list is readable at all — the include names a real column',
      couponList.status, 200);
    const couponRows = Array.isArray(dataOf(couponList)) ? dataOf(couponList) : [];
    check('  and returns the coupon just created',
      couponRows.some((row) => row.code === 'VBL10'), true);
    check('  with the creating user joined, which is what the broken include was for',
      typeof (couponRows.find((row) => row.code === 'VBL10') || {}).createdBy?.name, 'string');

    const couponUsages = await call(`/coupons/${coupon.id}/usages`, { token: platform });
    check('the coupon usages list is readable too — the same include, the same mistake',
      couponUsages.status, 200);

    const planRes = await expectOk(
      '/plans',
      {
        method: 'POST',
        token: platform,
        body: {
          name: 'Verify Billing Plan',
          code: 'VBL-PLAN',
          trial_days: 0,
          grace_period_days: 7,
          visibility: PLAN_VISIBILITY.PUBLIC,
        },
      },
      201
    );
    const planId = dataOf(planRes).plan.id;
    created.plans.push(planId);

    const prices = await expectOk(
      `/plans/${planId}/prices`,
      {
        method: 'PUT',
        token: platform,
        body: {
          prices: [
            {
              billing_cycle: BILLING_CYCLES.CUSTOM_DAYS,
              cycle_days: 30,
              pricing_model: PRICING_MODELS.FIXED,
              currency: 'USD',
              base_amount: 1000,
              is_default: true,
            },
          ],
        },
      },
      200
    );
    void prices;

    await expectOk(
      `/plans/${planId}/limits`,
      {
        method: 'PUT',
        token: platform,
        body: {
          limits: LIMIT_LIST.map((limit_key) => ({
            limit_key,
            limit_type: LIMIT_TYPES.UNLIMITED,
            limit_value: null,
          })),
        },
      },
      200
    );
    await expectOk(
      `/plans/${planId}/modules`,
      {
        method: 'PUT',
        token: platform,
        body: { modules: [{ module_key: 'students', is_enabled: true }] },
      },
      200
    );
    await expectOk(`/plans/${planId}/activate`, { method: 'POST', token: platform, body: {} }, 200);

    const subRes = await expectOk(
      '/subscriptions',
      { method: 'POST', token: platform, body: { school_id: school.id, plan_id: planId } },
      201
    );
    const subscriptionId = dataOf(subRes).subscription.id;
    created.subscriptions.push(subscriptionId);
    await expectOk(`/subscriptions/${subscriptionId}/activate`, { method: 'POST', token: platform, body: {} }, 200);

    /*
     * The subscription's own row, read BEFORE anything is billed against it. §13.1's *Billing Period*
     * and *Due Date* are both derived from this row, so re-deriving them here from `new Date()` would
     * assert only that the suite and the service read the same clock. Read before rather than after,
     * deliberately: the claim is that the invoice bills the period the subscription said was current
     * when it was asked, so a regression that rolled the subscription forward and billed the new
     * period must fail rather than drag the expected value along with it.
     */
    /*
     * Back-dated by whole days before anything is billed, and this is load-bearing rather than
     * decorative. The fixture activates the subscription and invoices it **within the same second**,
     * so `current_period_start` and a fresh `new Date()` serialise identically — measured: replacing
     * the service's `subscription.current_period_start` with `new Date()` left the assertion below
     * green, because both read 09:16:06. An assertion that cannot tell the two apart is the exact
     * failure this project keeps a list of. Shifting by whole days makes them differ by five days
     * while leaving the span exactly `cycle_days`, so the span assertion is unaffected and the
     * period-start assertion becomes able to fail.
     */
    {
      const row = await db.Subscription.findByPk(subscriptionId);
      const shift = 5 * 86400000;
      await row.update({
        current_period_start: new Date(Date.parse(row.current_period_start) - shift),
        current_period_end: new Date(Date.parse(row.current_period_end) - shift),
      });
    }

    const subRow = dataOf(
      await expectOk(`/subscriptions/${subscriptionId}`, { token: platform }, 200)
    ).subscription;
    /*
     * Pinned, because the two assertions below are only as strong as these three numbers. A grace of
     * 0 would make "due = issue + grace" indistinguishable from an invoice due the day it was raised.
     * The fixture's plan sets 7 (:1047) and the subscription inherits it. If that ever drifts this
     * fails first and says so, instead of the due-date check quietly becoming an identity.
     */
    check(
      'the fixture subscription is a 30-day custom cycle with a 7-day grace period',
      [subRow.billing_cycle, Number(subRow.cycle_days), Number(subRow.grace_period_days)],
      [BILLING_CYCLES.CUSTOM_DAYS, 30, 7]
    );

    const refusedGenerate = await call('/invoices/generate', {
      method: 'POST',
      token: principal,
      body: { subscription_id: subscriptionId, tax_id: tax.id },
    });
    check('a principal cannot issue an invoice', refusedGenerate.status, 403);
    check('the refusal is platform scope, not a missing permission', codeOf(refusedGenerate), 'PLATFORM_SCOPE_REQUIRED');

    /*
     * §13.1 *Invoice Number*, bracketed around the request. `documentNumber.periodOf()` reads the
     * LOCAL clock and the number is stamped at issue time from `spec.issueDate || new Date()`, and
     * the body below sends no `issue_date`. Bracketing rather than hard-coding a month means the
     * suite is never red in a different month: the allocation happens strictly between these two
     * reads, so the period it used is one of them.
     */
    const periodBeforeIssue = documentNumber.periodOf();

    const issued = await expectOk(
      '/invoices/generate',
      {
        method: 'POST',
        token: platform,
        body: { subscription_id: subscriptionId, tax_id: tax.id },
      },
      201
    );
    const beforeCoupon = dataOf(issued).invoice;
    created.invoices.push(beforeCoupon.id);
    check('generated invoice is unpaid', beforeCoupon.status, INVOICE_STATUS.UNPAID);
    check('subtotal is the plan price', num(beforeCoupon.subtotal), 1000);
    check('exclusive 10% tax on 1000, before a coupon', num(beforeCoupon.tax_amount), 100);
    check('total before coupon', num(beforeCoupon.total), 1100);

    /* ── §13.1 Invoice Number — part 1f proves the utility; this proves the row was cut with it ── */
    const periodAfterIssue = documentNumber.periodOf();
    const issuedNumber = documentNumber.parse(beforeCoupon.invoice_number) || {
      prefix: null,
      period: null,
      counter: null,
    };
    check(
      'the generated row carries an INV document number',
      issuedNumber.prefix,
      documentNumber.PREFIXES.INVOICE
    );
    check(
      'stamped with the month it was issued in, not a fixed period',
      [periodBeforeIssue, periodAfterIssue].includes(issuedNumber.period),
      true
    );
    check(
      '  and a counter that is a positive integer',
      Number.isInteger(issuedNumber.counter) && issuedNumber.counter >= 1,
      true
    );
    check(
      '  and the stored string is exactly format() of its own parts, zero-padded on the row',
      beforeCoupon.invoice_number,
      documentNumber.format(issuedNumber.prefix, issuedNumber.period, issuedNumber.counter)
    );

    /* ── §13.1 School — FR-BILL-001's Expected Outcome, "associated with the school and subscription" ── */
    check(
      'the invoice is booked to the school the subscription is for',
      Number(beforeCoupon.school_id),
      Number(school.id)
    );
    check('  and to that school\'s organization', Number(beforeCoupon.organization_id), Number(org.id));
    check(
      '  and it names the subscription it was generated from',
      Number(beforeCoupon.subscription_id),
      Number(subscriptionId)
    );
    /* `call`, not `expectOk`: a wrong school_id must surface as a FAIL line rather than a thrown abort. */
    const asSchool = await call(`/invoices/${beforeCoupon.id}`, { token: principal });
    check(
      '  so the school reads it back under a tenant scope that resolves only its own school_id',
      asSchool.status,
      200
    );

    /* ── §13.1 Plan — plan_id, and plan_name as the snapshot the column comment requires ── */
    check('the invoice names the subscribed plan', Number(beforeCoupon.plan_id), Number(planId));
    check('  and copies the plan name as it stood at issue', beforeCoupon.plan_name, 'Verify Billing Plan');

    await expectOk(
      `/plans/${planId}`,
      { method: 'PATCH', token: platform, body: { name: 'Verify Billing Plan Renamed' } },
      200
    );
    /*
     * The detail read joins the plan, so ONE response carries both the live name and the snapshot.
     * The pair is the assertion: the join must move and the column must not. The first check is also
     * what stops the second passing vacuously if the rename never landed — without it, a `plan_name`
     * that merely never changed would look like a snapshot.
     */
    const reread = dataOf(await expectOk(`/invoices/${beforeCoupon.id}`, { token: platform }, 200)).invoice;
    check(
      'after the plan is renamed the joined plan shows the new name',
      reread.plan ? reread.plan.name : null,
      'Verify Billing Plan Renamed'
    );
    check(
      '  but plan_name still shows the name at issue — a snapshot, not the live join beside it',
      reread.plan_name,
      'Verify Billing Plan'
    );

    /*
     * §13.1 *Billing Period* — two DATE columns that nothing read back off a generated invoice until
     * now. `generateForSubscription()` takes them from the subscription's current period
     * (invoices.service.js:746-747), which is why the expected value is the subscription's own row
     * rather than two literal dates: the assertion has to hold on whatever day the suite runs.
     */
    check(
      'the invoice bills the subscription current period start, not a fresh clock read',
      beforeCoupon.billing_period_start,
      subRow.current_period_start
    );
    check(
      '  and the subscription current period end',
      beforeCoupon.billing_period_end,
      subRow.current_period_end
    );
    /*
     * The two above compare one stored instant against another, so a pair of nulls would satisfy
     * both. This one cannot be satisfied that way: `Date.parse(null)` is NaN, `check` stringifies NaN
     * to `"null"`, and the expected side is the subscription's own `cycle_days`. It pins the span as
     * well, so a period start or end silently shifted by a day is visible.
     */
    check(
      'the invoiced span is exactly the subscription billing cycle, in days',
      (Date.parse(beforeCoupon.billing_period_end) - Date.parse(beforeCoupon.billing_period_start)) /
        86400000,
      Number(subRow.cycle_days)
    );

    /*
     * §13.1 *Due Date*. The generate body sends no `due_date`, so `issue()` takes the `dueDays`
     * branch with `dueDays: subscription.grace_period_days` (invoices.service.js:825); the guard
     * above it refuses a spec carrying neither, so this is the only path here.
     *
     * `due_date` is DATEONLY and arrives as `YYYY-MM-DD`, so the expected value is built as a date
     * string too. Comparing a DATEONLY against an instant would never match, and comparing
     * `Date.parse()` of one against an instant would pass at any hour of the right day — the classic
     * false pass this avoids. Anchored on the invoice's own `issue_date` rather than the suite's
     * clock: both columns come from one `new Date()` inside the service, so there is no midnight race.
     */
    const expectedDue = new Date(
      Date.parse(`${beforeCoupon.issue_date}T00:00:00.000Z`) +
        Number(subRow.grace_period_days) * 86400000
    )
      .toISOString()
      .slice(0, 10);
    check(
      'due date is the issue date plus the subscription grace period, not the day it was raised',
      beforeCoupon.due_date,
      expectedDue
    );

    const withCoupon = await expectOk(
      `/invoices/${beforeCoupon.id}/coupon`,
      { method: 'POST', token: principal, body: { code: 'VBL10' } },
      200
    );
    const invoiced = dataOf(withCoupon).invoice;
    check('the school can apply the coupon', invoiced.coupon_code, 'VBL10');
    check('discount is 10% of subtotal', num(invoiced.discount_amount), 100);
    check('tax is recomputed on the discounted base (900 × 10%)', num(invoiced.tax_amount), 90);
    check('total after coupon is 990, not 1000', num(invoiced.total), 990);

    const refusedRecord = await call('/payments/record', {
      method: 'POST',
      token: principal,
      body: { invoice_id: invoiced.id, amount: 990, method: PAYMENT_METHODS.BANK_TRANSFER },
    });
    check('a principal cannot record a payment', refusedRecord.status, 403);
    check('recording is platform-scoped, not a missing permission', codeOf(refusedRecord), 'PLATFORM_SCOPE_REQUIRED');

    const form = new FormData();
    form.append('invoice_id', String(invoiced.id));
    form.append('amount', '990');
    form.append('method', PAYMENT_METHODS.BANK_TRANSFER);
    form.append('transaction_id', 'TXN-VBL-1');
    const submitted = await expectOk('/payments', { method: 'POST', token: principal, form }, 201);
    const pending = dataOf(submitted).payment;
    created.payments.push(pending.id);
    check('school submission is pending', pending.status, PAYMENT_STATUS.PENDING);
    check('submitted amount', num(pending.amount), 990);

    const stillUnpaid = await expectOk(`/invoices/${invoiced.id}`, { token: platform }, 200);
    check('a pending payment does not settle the invoice', dataOf(stillUnpaid).invoice.status, INVOICE_STATUS.UNPAID);

    const approved = await expectOk(
      `/payments/${pending.id}/approve`,
      { method: 'POST', token: platform, body: { note: 'Bank statement matches' } },
      200
    );
    check('approval marks the payment approved', dataOf(approved).payment.status, PAYMENT_STATUS.APPROVED);
    check('and the invoice is now paid', dataOf(approved).settlement.status, INVOICE_STATUS.PAID);

    const approvalAudit = await settle(
      () => db.AuditLog.findOne({
        where: {
          table_name: 'payments',
          record_id: pending.id,
          event: 'update',
          id: { [db.Op.gt]: baseline.auditLog },
        },
        order: [['id', 'DESC']],
      }),
      (row) => Boolean(row)
    );
    check('approval writes an audit_logs row', Boolean(approvalAudit), true);
    check(
      'the audit event is update — audit_logs.event has no approve value',
      approvalAudit ? approvalAudit.event : null,
      'update'
    );

    const paid = await expectOk(`/invoices/${invoiced.id}`, { token: platform }, 200);
    check('amount_due is zero after approval', num(dataOf(paid).invoice.amount_due), 0);

    const refunded = await expectOk(
      `/payments/${pending.id}/refunds`,
      { method: 'POST', token: platform, body: { reason: 'Verify billing refund' } },
      201
    );
    check('refund amount is the full payment', num(dataOf(refunded).refund.amount), 990);
    check('refund is completed immediately', dataOf(refunded).refund.status, REFUND_STATUS.COMPLETED);

    const afterRefund = await expectOk(`/invoices/${invoiced.id}`, { token: platform }, 200);
    check('invoice status after a full refund', dataOf(afterRefund).invoice.status, INVOICE_STATUS.REFUNDED);

    /*
     * §13.1's *Add-ons*, on a generated invoice — `addons_summary`, and the `item_type: 'addon'` rows
     * the service says it duplicates. Neither was read back off a generated invoice before this block.
     *
     * A SECOND invoice, deliberately, and the add-on bought only now. The subscription the first
     * invoice came from has no add-on, so its `addons_summary` is `null` — and `null` is exactly what
     * an unwritten column reads as, so an assertion against it alone could not fail. Buying the add-on
     * before the first generate would instead move subtotal/tax/total off 1000/100/1100 and the coupon
     * figures off 100/90/990, rewriting six expected values that are about the coupon rather than about
     * add-ons. So: buy it here, and bill it on a period the first invoice does not cover —
     * `alreadyBilled()` matches on the period *start*.
     */
    const extraStudents = await db.Addon.findOne({ where: { key: 'extra_students' } });
    if (!extraStudents) {
      throw new Error('The extra_students add-on is missing — run the seeders first.');
    }

    /*
     * `addon_prices` ships empty, and `purchaseAddon()` prices a priceless add-on at zero. A zero would
     * make `unit_amount` and `amount` both 0 and the two indistinguishable, so a price is created:
     * 25 a unit, bought twice, = 50. Every figure below is that arithmetic, not a literal.
     */
    await expectOk(
      `/addons/${extraStudents.id}/prices`,
      {
        method: 'PUT',
        token: platform,
        body: {
          prices: [{ billing_cycle: BILLING_CYCLES.MONTHLY, currency: 'USD', unit_amount: 25 }],
        },
      },
      200
    );
    /* Read back, not guessed: `setPrices()` destroys and recreates, so the id is its output. */
    const addonPrice = await db.AddonPrice.findOne({
      where: { addon_id: extraStudents.id, is_active: true },
      order: [['id', 'DESC']],
    });
    created.addonPrices.push(addonPrice.id);

    const bought = await expectOk(
      `/subscriptions/${subscriptionId}/addons`,
      {
        method: 'POST',
        token: platform,
        body: { addon_id: extraStudents.id, addon_price_id: addonPrice.id, quantity: 2 },
      },
      201
    );
    const addonItemId = dataOf(bought).purchase.itemId;

    const secondIssued = await expectOk(
      '/invoices/generate',
      {
        method: 'POST',
        token: platform,
        body: {
          subscription_id: subscriptionId,
          tax_id: tax.id,
          billing_period_start: '2031-01-01T00:00:00.000Z',
          billing_period_end: '2031-01-31T00:00:00.000Z',
        },
      },
      201
    );
    const withAddon = dataOf(secondIssued).invoice;
    created.invoices.push(withAddon.id);

    const addonSummary = Array.isArray(withAddon.addons_summary) ? withAddon.addons_summary : [];
    check(
      '§13.1 Add-ons — the generated invoice carries the purchased add-on in addons_summary',
      {
        entries: addonSummary.length,
        addon_id: Number((addonSummary[0] || {}).addon_id),
        description: (addonSummary[0] || {}).description,
        quantity: Number((addonSummary[0] || {}).quantity),
        amount: Number((addonSummary[0] || {}).amount),
      },
      {
        entries: 1,
        addon_id: Number(extraStudents.id),
        description: 'Extra Students × 2',
        quantity: 2,
        amount: 50,
      }
    );

    /*
     * The pair is what makes the summary meaningful rather than decorative: the column exists so a list
     * view need not join `invoice_items`, so it has to AGREE with those rows. `from_the_purchase` ties
     * the line back to the `subscription_items` row the purchase created, which is the link that says
     * this invoice billed that purchase rather than something that merely looks like it.
     */
    const addonItems = (withAddon.items || []).filter((row) => row.item_type === 'addon');
    check(
      '  and it agrees with the invoice_items addon line, traceable to the purchase',
      addonItems.map((row) => ({
        addon_id: Number(row.addon_id),
        from_the_purchase: Number(row.subscription_item_id) === Number(addonItemId),
        description: row.description,
        quantity: num(row.quantity),
        unit_amount: num(row.unit_amount),
        amount: num(row.amount),
      })),
      [
        {
          addon_id: Number(extraStudents.id),
          from_the_purchase: true,
          description: 'Extra Students × 2',
          quantity: 2,
          unit_amount: 25,
          amount: 50,
        },
      ]
    );

    /* ──────── The wallet (D5) and a submission's evidence (D8) — docs/OWNER-DECISIONS.md ──────── */

    /*
     * A third invoice, on a period neither earlier one bills, so no figure above moves. Its total is not
     * asserted here — the add-on bought above is on it — and every wallet figure below is arithmetic on
     * amounts this block itself moves, starting from a balance read, not assumed.
     */
    const thirdIssued = await expectOk(
      '/invoices/generate',
      {
        method: 'POST',
        token: platform,
        body: {
          subscription_id: subscriptionId,
          tax_id: tax.id,
          billing_period_start: '2032-01-01T00:00:00.000Z',
          billing_period_end: '2032-01-31T00:00:00.000Z',
        },
      },
      201
    );
    const walletInvoice = dataOf(thirdIssued).invoice;
    created.invoices.push(walletInvoice.id);

    const walletBalance = async () =>
      num((await db.Subscription.findByPk(subscriptionId, { attributes: ['wallet_balance'] })).wallet_balance);
    const submission = (amount, method, extra = {}) => {
      const body = new FormData();
      body.append('invoice_id', String(walletInvoice.id));
      body.append('amount', String(amount));
      body.append('method', method);
      /* A file is `[blob, filename]` — appended bare, a Blob is sent as "blob", with no extension. */
      for (const [key, value] of Object.entries(extra)) {
        if (Array.isArray(value)) body.append(key, value[0], value[1]);
        else body.append(key, value);
      }
      return body;
    };

    /* The first invoice's refund went to its original method, a bank transfer, so nothing reached here. */
    check('D5 — the subscription wallet starts empty', await walletBalance(), 0);

    const noEvidence = await call('/payments', {
      method: 'POST',
      token: principal,
      form: submission(100, PAYMENT_METHODS.BANK_TRANSFER),
    });
    check(
      'D8 — a submission with neither a transaction id nor a screenshot is refused',
      { status: noEvidence.status, code: codeOf(noEvidence) },
      { status: 422, code: 'PAYMENT_EVIDENCE_REQUIRED' }
    );

    /* Either is enough: a cash payment may have a receipt photo and no reference at all. */
    const receiptOnly = await call('/payments', {
      method: 'POST',
      token: principal,
      form: submission(100, PAYMENT_METHODS.CASH, {
        screenshot: [new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'receipt.png'],
      }),
    });
    check(
      '  but a screenshot alone is enough',
      { status: receiptOnly.status, state: receiptOnly.status === 201 ? dataOf(receiptOnly).payment.status : null },
      { status: 201, state: PAYMENT_STATUS.PENDING }
    );

    const fromEmpty = await call('/payments', {
      method: 'POST',
      token: principal,
      form: submission(100, PAYMENT_METHODS.WALLET),
    });
    check(
      'D5 — a wallet payment an empty wallet cannot cover is refused when it is submitted',
      { status: fromEmpty.status, code: codeOf(fromEmpty) },
      { status: 409, code: 'WALLET_INSUFFICIENT' }
    );

    /* Money in: a transfer the platform recorded, 200 of it refunded to the wallet. */
    const transfer = await expectOk(
      '/payments/record',
      {
        method: 'POST',
        token: platform,
        body: {
          invoice_id: walletInvoice.id,
          amount: 500,
          method: PAYMENT_METHODS.BANK_TRANSFER,
          transaction_id: 'TXN-VBL-W1',
        },
      },
      201
    );
    const transferPayment = dataOf(transfer).payment;
    created.payments.push(transferPayment.id);
    const creditRes = await expectOk(
      `/payments/${transferPayment.id}/refunds`,
      { method: 'POST', token: platform, body: { amount: 200, destination: 'wallet', reason: 'Verify wallet credit' } },
      201
    );
    check('  a refund to the wallet is recorded as one', dataOf(creditRes).refund.destination, 'wallet');
    check('  and credits the balance by exactly its amount', await walletBalance(), 200);

    const tooLarge = await call('/payments', {
      method: 'POST',
      token: principal,
      form: submission(300, PAYMENT_METHODS.WALLET),
    });
    check('  a wallet payment larger than the balance is still refused', codeOf(tooLarge), 'WALLET_INSUFFICIENT');

    /* Two payments of 150, each covered by 200 on its own — and together not. */
    const firstRes = await expectOk('/payments', { method: 'POST', token: principal, form: submission(150, PAYMENT_METHODS.WALLET) }, 201);
    const secondRes = await expectOk('/payments', { method: 'POST', token: principal, form: submission(150, PAYMENT_METHODS.WALLET) }, 201);
    const firstWallet = dataOf(firstRes).payment;
    const secondWallet = dataOf(secondRes).payment;
    created.payments.push(firstWallet.id, secondWallet.id);
    check(
      '  one the balance covers is accepted with no transaction id or screenshot — D8 exempts the wallet',
      firstWallet.status,
      PAYMENT_STATUS.PENDING
    );
    check('  and a pending payment has drawn nothing', await walletBalance(), 200);

    await expectOk(`/payments/${firstWallet.id}/approve`, { method: 'POST', token: platform, body: { note: 'Wallet' } }, 200);
    check('  approval is what draws it', await walletBalance(), 50);

    /* A pending payment reserves nothing, so the second one's approval meets the balance as it now is. */
    const lateApproval = await call(`/payments/${secondWallet.id}/approve`, {
      method: 'POST',
      token: platform,
      body: { note: 'Wallet' },
    });
    check(
      '  approving a second one the balance no longer covers is refused',
      { status: lateApproval.status, code: codeOf(lateApproval) },
      { status: 409, code: 'WALLET_INSUFFICIENT' }
    );
    const secondAfter = await db.Payment.findByPk(secondWallet.id, { attributes: ['status'] });
    check('  and that payment stays pending, to be rejected or approved once the money is there', secondAfter.status, PAYMENT_STATUS.PENDING);

    const overdraw = await call('/payments/record', {
      method: 'POST',
      token: platform,
      body: { invoice_id: walletInvoice.id, amount: 100, method: PAYMENT_METHODS.WALLET },
    });
    check(
      '  the Super Admin cannot record a wallet payment past the balance either',
      { status: overdraw.status, code: codeOf(overdraw), balance: await walletBalance() },
      { status: 409, code: 'WALLET_INSUFFICIENT', balance: 50 }
    );

    const walletRefund = await expectOk(
      `/payments/${firstWallet.id}/refunds`,
      { method: 'POST', token: platform, body: { reason: 'Verify wallet refund' } },
      201
    );
    check(
      '  a wallet payment refunded to its original method goes back into the wallet',
      { destination: dataOf(walletRefund).refund.destination, balance: await walletBalance() },
      { destination: 'wallet', balance: 200 }
    );

    /* ──────── A negotiated price is billed (D7) — triage finding 39 ──────── */

    /*
     * In effect for the first half of 2033 only, so one invoice inside the window and one after it show
     * both halves of the rule: the override sets the plan line while it is in effect, and stops with it.
     */
    await expectOk(
      `/subscriptions/${subscriptionId}/overrides`,
      {
        method: 'POST',
        token: platform,
        body: {
          override_type: 'price',
          target_key: 'cycle_amount',
          amount: 640,
          effective_from: '2033-01-01T00:00:00.000Z',
          effective_until: '2033-07-01T00:00:00.000Z',
          reason: 'Verify negotiated price',
        },
      },
      201
    );
    const billFor = async (start, end) => {
      const res = await expectOk(
        '/invoices/generate',
        {
          method: 'POST',
          token: platform,
          body: { subscription_id: subscriptionId, tax_id: tax.id, billing_period_start: start, billing_period_end: end },
        },
        201
      );
      const invoice = dataOf(res).invoice;
      created.invoices.push(invoice.id);
      const lineOf = (type) => (invoice.items || []).find((row) => row.item_type === type) || {};
      return { plan: lineOf('plan'), addon: lineOf('addon') };
    };

    const negotiated = await billFor('2033-02-01T00:00:00.000Z', '2033-02-28T00:00:00.000Z');
    check(
      'D7 — a period inside the override bills the plan line at the negotiated amount',
      { quantity: num(negotiated.plan.quantity), unit: num(negotiated.plan.unit_amount), amount: num(negotiated.plan.amount) },
      { quantity: 1, unit: 640, amount: 640 }
    );
    check(
      '  keeping the plan price it replaced on the line, so the invoice shows what was negotiated away',
      num((negotiated.plan.metadata || {}).plan_amount),
      1000
    );
    check('  and the add-on line is priced by its own row, untouched', num(negotiated.addon.amount), 50);

    const afterWindow = await billFor('2033-08-01T00:00:00.000Z', '2033-08-31T00:00:00.000Z');
    check(
      '  a period after the override ends is billed at the plan price again',
      num(afterWindow.plan.amount),
      1000
    );
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-billing Part 5 teardown failed:', err);
    }
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

/* ═══════════════════════════════════════ run ═══════════════════════════════════════ */

async function main() {
  /* Part 1 — pure money and the registry. */
  verifyTaxMath();
  verifyInvoiceMath();
  verifyCouponMath();
  verifyQuotationMath();
  verifyRefundMath();
  verifyDocumentNumber();
  await verifyGateway();
  verifyUploadWiring();

  /* Part 2 — the declared route tables. */
  verifyRouting();

  /* Part 3 — the request schemas. */
  verifySchemas();

  /* Part 4 — the database-backed sweeps (skips when the database is down). */
  await verifyDatabase();

  /* Part 5 — the HTTP money path. Needs the same live database as Part 4. */
  if (!dbSkipped) {
    await verifyHttp();
  }
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nverify-billing crashed:', err);
  })
  .finally(async () => {
    console.log('');
    if (dbSkipped) {
      console.log('⚠  Parts 4–5 (database) were SKIPPED — MySQL/MariaDB is not reachable.');
      console.log('   Parts 1–3 (pure) executed in full.');
    }
    if (failures === 0) {
      console.log(
        dbSkipped
          ? 'All pure billing checks passed (Parts 1–3). Parts 4–5 pending a live database.'
          : 'All billing checks passed (Parts 1–5).'
      );
    } else {
      console.log(`${failures} check(s) FAILED.`);
    }
    try {
      await db.sequelize.close();
    } catch (_) {
      /* the pool may never have opened — nothing to close */
    }
    /*
     * A degraded run is a FAILED run — Known Issue 28.
     *
     * This suite answers an unreachable database by setting `dbSkipped`, returning early from its
     * database half and printing that it passed. Until session 26 it then **exited 0**, so a stopped
     * MySQL read as a green run to anything that looks at the exit code — which is `node
     * scripts/verify-*.js` run directly (the workflow this project's log documents throughout) and
     * `scripts/stress.sh:17`, whose entire scoring is `if ! wait "$pid"`. A stress run with the
     * database down would have reported a perfect determinism score for suites that never ran.
     *
     * `npm test` was never exposed: `tests/globalSetup.js` proves the database with `SELECT
     * DATABASE()` before any suite spawns, and `tests/verify.test.js` asserts both that `skipped` is
     * empty and that each suite produced its exact recorded count. This closes the direct-run path,
     * which is the one a person uses.
     *
     * `--allow-skip` is for running the pure checks deliberately, and mirrors `--allow-shrink` in
     * `record-baseline.js` rather than inventing a new convention. The jest harness passes no
     * arguments (`suiteRunner.js:220`), so it can never opt out by accident.
     */
    if (dbSkipped && !process.argv.includes('--allow-skip')) {
      console.log('');
      console.log('   Exiting 1: the database half did not run, so this is not a pass.');
      console.log('   Re-run with --allow-skip to execute the pure checks on purpose.');
      process.exit(1);
    }
    process.exit(failures === 0 ? 0 : 1);
  });
