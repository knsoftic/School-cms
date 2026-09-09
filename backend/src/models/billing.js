'use strict';

/**
 * Billing tables — SRS §29 "Billing", §13:
 *   invoices · invoice_items · payments · payment_transactions · refunds ·
 *   coupons · coupon_usages · taxes · quotations
 */

const {
  DataTypes,
  id,
  fk,
  organizationId,
  schoolId,
  money,
  enumOf,
  json,
  modelOptions,
} = require('./columns');

const {
  INVOICE_STATUS,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  PAYMENT_TRANSACTION_STATUS,
  REFUND_STATUS,
  COUPON_TYPES,
  COUPON_STATUS,
  QUOTATION_STATUS,
} = require('../config/constants');

module.exports = (sequelize) => {
  /* ─────────────────────── taxes (SRS §33 "Taxes") ─────────────────────── */

  const Tax = sequelize.define(
    'Tax',
    {
      id: id(),
      name: { type: DataTypes.STRING(120), allowNull: false },
      code: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      /** Percentage rate applied to the invoice subtotal after discount. */
      rate_percent: { type: DataTypes.DECIMAL(7, 4), allowNull: false, defaultValue: 0 },
      is_inclusive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'true = the listed price already contains this tax',
      },
      country: { type: DataTypes.STRING(90), allowNull: true },
      state: { type: DataTypes.STRING(90), allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      description: { type: DataTypes.STRING(255), allowNull: true },
    },
    modelOptions('taxes', { indexes: [{ fields: ['is_active'] }, { fields: ['is_default'] }] })
  );

  /* ─────────────────────── coupons (SRS §13.4) ─────────────────────── */

  const Coupon = sequelize.define(
    'Coupon',
    {
      id: id(),
      code: { type: DataTypes.STRING(60), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(160), allowNull: true },
      description: { type: DataTypes.STRING(255), allowNull: true },
      /** SRS §13.4 — Percentage | Fixed Amount. */
      discount_type: enumOf(COUPON_TYPES, { defaultValue: COUPON_TYPES.PERCENTAGE }),
      discount_value: money({ comment: 'Percent when percentage, currency amount when fixed_amount' }),
      currency: { type: DataTypes.STRING(10), allowNull: true, comment: 'Required for fixed_amount' },
      /** Cap on a percentage discount, so 50% off does not become unbounded. */
      max_discount_amount: money({ allowNull: true, defaultValue: null }),
      min_order_amount: money({ allowNull: true, defaultValue: null }),

      /** SRS §13.4 — Expiry. */
      starts_at: { type: DataTypes.DATE, allowNull: true },
      expires_at: { type: DataTypes.DATE, allowNull: true },

      /** SRS §13.4 — Maximum Uses. */
      max_uses: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, comment: 'Null = unlimited' },
      max_uses_per_school: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      used_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },

      /**
       * SRS §13.4 — Plan Restrictions / School Restrictions.
       * Empty or null array = unrestricted.
       */
      restricted_plan_ids: json({ comment: 'Array of subscription_plans.id the coupon may be used on' }),
      restricted_school_ids: json({ comment: 'Array of schools.id the coupon may be used by' }),

      status: enumOf(COUPON_STATUS, { defaultValue: COUPON_STATUS.ACTIVE }),
      created_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
    },
    modelOptions('coupons', {
      indexes: [{ fields: ['status'] }, { fields: ['expires_at'] }],
      validate: {
        percentageInRange() {
          if (this.discount_type === COUPON_TYPES.PERCENTAGE) {
            const v = Number(this.discount_value);
            if (v <= 0 || v > 100) throw new Error('Percentage discount_value must be between 0 and 100');
          }
        },
        windowOrdered() {
          if (this.starts_at && this.expires_at && new Date(this.expires_at) <= new Date(this.starts_at)) {
            throw new Error('Coupon expires_at must be after starts_at');
          }
        },
      },
    })
  );

  /* ─────────────────────── invoices (SRS §13.1) ─────────────────────── */

  const Invoice = sequelize.define(
    'Invoice',
    {
      id: id(),
      /** SRS §13.1 — Invoice Number. */
      invoice_number: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      /** SRS §13.1 — School. */
      school_id: schoolId(),
      organization_id: organizationId(),
      subscription_id: fk({
        allowNull: true,
        references: { model: 'subscriptions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      /** SRS §13.1 — Plan. */
      plan_id: fk({
        allowNull: true,
        references: { model: 'subscription_plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      plan_name: { type: DataTypes.STRING(160), allowNull: true, comment: 'Snapshot at issue time' },

      /** SRS §13.1 — Billing Period. */
      billing_period_start: { type: DataTypes.DATE, allowNull: true },
      billing_period_end: { type: DataTypes.DATE, allowNull: true },
      billing_cycle: { type: DataTypes.STRING(20), allowNull: true },

      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      /** SRS §13.1 — Subtotal, Discount, Tax, Total. */
      subtotal: money(),
      discount_amount: money({ defaultValue: 0 }),
      tax_amount: money({ defaultValue: 0 }),
      total: money(),
      amount_paid: money({ defaultValue: 0 }),
      amount_due: money({ defaultValue: 0 }),
      /** Credit from proration applied to this invoice (SRS §12.3 "Remaining Credit"). */
      credit_applied: money({ defaultValue: 0 }),

      coupon_id: fk({
        allowNull: true,
        references: { model: 'coupons', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      coupon_code: { type: DataTypes.STRING(60), allowNull: true },
      tax_id: fk({
        allowNull: true,
        references: { model: 'taxes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      tax_rate_percent: { type: DataTypes.DECIMAL(7, 4), allowNull: true },

      /** SRS §13.1 — Due Date, Status. */
      issue_date: { type: DataTypes.DATEONLY, allowNull: false },
      due_date: { type: DataTypes.DATEONLY, allowNull: false },
      status: enumOf(INVOICE_STATUS, { defaultValue: INVOICE_STATUS.UNPAID }),

      paid_at: { type: DataTypes.DATE, allowNull: true },
      cancelled_at: { type: DataTypes.DATE, allowNull: true },
      /** Marker used by the fee/subscription reminder cron. */
      reminder_sent_at: { type: DataTypes.DATE, allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      /** SRS §13.1 — Add-ons summary retained for the printed invoice. */
      addons_summary: json({ comment: 'Snapshot of add-on lines included in this invoice' }),
      metadata: json(),
    },
    modelOptions('invoices', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['subscription_id'] },
        { fields: ['status'] },
        { fields: ['due_date'] },
        { fields: ['school_id', 'status'] },
      ],
    })
  );

  /* ─────────────────────── invoice_items ─────────────────────── */

  const InvoiceItem = sequelize.define(
    'InvoiceItem',
    {
      id: id(),
      invoice_id: fk({ references: { model: 'invoices', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      school_id: schoolId(),
      item_type: enumOf(['plan', 'addon', 'setup_fee', 'overage', 'credit', 'custom'], { defaultValue: 'plan' }),
      subscription_item_id: fk({
        allowNull: true,
        references: { model: 'subscription_items', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      addon_id: fk({
        allowNull: true,
        references: { model: 'addons', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      description: { type: DataTypes.STRING(255), allowNull: false },
      quantity: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 1 },
      unit_amount: money(),
      amount: money(),
      period_start: { type: DataTypes.DATE, allowNull: true },
      period_end: { type: DataTypes.DATE, allowNull: true },
      metadata: json(),
    },
    modelOptions('invoice_items', {
      indexes: [{ fields: ['invoice_id'] }, { fields: ['school_id'] }],
    })
  );

  /* ─────────────────────── payments (SRS §13.2, §13.3) ─────────────────────── */

  const Payment = sequelize.define(
    'Payment',
    {
      id: id(),
      payment_number: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      school_id: schoolId(),
      organization_id: organizationId(),
      invoice_id: fk({
        allowNull: true,
        references: { model: 'invoices', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      subscription_id: fk({
        allowNull: true,
        references: { model: 'subscriptions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),

      /** SRS §13.2 — Cash | Bank Transfer | Manual Payment | Online Gateway | Wallet. */
      method: enumOf(PAYMENT_METHODS),
      /** Gateway plugin key that handled this payment (SRS §13.2 "plugin-based"). */
      gateway_key: { type: DataTypes.STRING(60), allowNull: true },

      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      amount: money(),
      /** SRS §13.3 — a manual payment starts as Pending. */
      status: enumOf(PAYMENT_STATUS, { defaultValue: PAYMENT_STATUS.PENDING }),

      /** SRS §13.3 — School enters transaction ID and uploads a screenshot. */
      transaction_id: { type: DataTypes.STRING(160), allowNull: true },
      screenshot_path: { type: DataTypes.STRING(255), allowNull: true },
      reference: { type: DataTypes.STRING(160), allowNull: true },
      payer_note: { type: DataTypes.STRING(500), allowNull: true },
      paid_at: { type: DataTypes.DATE, allowNull: true },

      /** SRS §13.3 — Super Admin Approve / Reject. */
      reviewed_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      reviewed_at: { type: DataTypes.DATE, allowNull: true },
      review_note: { type: DataTypes.STRING(500), allowNull: true },
      rejection_reason: { type: DataTypes.STRING(255), allowNull: true },

      refunded_amount: money({ defaultValue: 0 }),
      submitted_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      metadata: json(),
    },
    modelOptions('payments', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['invoice_id'] },
        { fields: ['status'] },
        { fields: ['method'] },
        { fields: ['status', 'method'] },
      ],
    })
  );

  /* ─────────────────────── payment_transactions ─────────────────────── */

  /** Gateway-level attempt log; a payment may have several attempts. */
  const PaymentTransaction = sequelize.define(
    'PaymentTransaction',
    {
      id: id(),
      payment_id: fk({ references: { model: 'payments', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      school_id: schoolId(),
      gateway_key: { type: DataTypes.STRING(60), allowNull: false },
      /** Provider-side identifier. */
      gateway_transaction_id: { type: DataTypes.STRING(191), allowNull: true },
      status: enumOf(PAYMENT_TRANSACTION_STATUS, { defaultValue: PAYMENT_TRANSACTION_STATUS.INITIATED }),
      direction: enumOf(['charge', 'refund'], { defaultValue: 'charge' }),
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      amount: money(),
      error_code: { type: DataTypes.STRING(80), allowNull: true },
      error_message: { type: DataTypes.STRING(500), allowNull: true },
      /** Raw provider request/response, useful for reconciliation. */
      request_payload: json(),
      response_payload: json(),
      processed_at: { type: DataTypes.DATE, allowNull: true },
    },
    modelOptions('payment_transactions', {
      indexes: [
        { fields: ['payment_id'] },
        { fields: ['school_id'] },
        { fields: ['gateway_key'] },
        { fields: ['gateway_transaction_id'] },
        { fields: ['status'] },
      ],
    })
  );

  /* ─────────────────────── refunds (SRS §33 "Refunds") ─────────────────────── */

  const Refund = sequelize.define(
    'Refund',
    {
      id: id(),
      refund_number: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      payment_id: fk({ references: { model: 'payments', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      invoice_id: fk({
        allowNull: true,
        references: { model: 'invoices', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      school_id: schoolId(),
      organization_id: organizationId(),
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      amount: money(),
      reason: { type: DataTypes.STRING(255), allowNull: true },
      status: enumOf(REFUND_STATUS, { defaultValue: REFUND_STATUS.PENDING }),
      /** Where the money went: back through the gateway, or onto the wallet balance. */
      destination: enumOf(['original_method', 'wallet'], { defaultValue: 'original_method' }),
      gateway_key: { type: DataTypes.STRING(60), allowNull: true },
      gateway_refund_id: { type: DataTypes.STRING(191), allowNull: true },
      processed_at: { type: DataTypes.DATE, allowNull: true },
      requested_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      approved_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      metadata: json(),
    },
    modelOptions('refunds', {
      indexes: [
        { fields: ['payment_id'] },
        { fields: ['invoice_id'] },
        { fields: ['school_id'] },
        { fields: ['status'] },
      ],
    })
  );

  /* ─────────────────────── coupon_usages (SRS §13.4 Maximum Uses) ─────────────────────── */

  const CouponUsage = sequelize.define(
    'CouponUsage',
    {
      id: id(),
      coupon_id: fk({ references: { model: 'coupons', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      school_id: schoolId(),
      subscription_id: fk({
        allowNull: true,
        references: { model: 'subscriptions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      invoice_id: fk({
        allowNull: true,
        references: { model: 'invoices', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      discount_amount: money(),
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      redeemed_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      redeemed_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    modelOptions('coupon_usages', {
      indexes: [
        { fields: ['coupon_id'] },
        { fields: ['school_id'] },
        { fields: ['invoice_id'] },
        { fields: ['coupon_id', 'school_id'] },
      ],
    })
  );

  /* ─────────────────────── quotations (SRS §29 Billing) ─────────────────────── */

  const Quotation = sequelize.define(
    'Quotation',
    {
      id: id(),
      quotation_number: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      /** A quotation may precede the school existing, so both scopes are nullable. */
      organization_id: organizationId({ allowNull: true, onDelete: 'SET NULL' }),
      school_id: schoolId({ allowNull: true, onDelete: 'SET NULL' }),
      prospect_name: { type: DataTypes.STRING(180), allowNull: true },
      prospect_email: { type: DataTypes.STRING(180), allowNull: true, validate: { isEmail: true } },
      prospect_phone: { type: DataTypes.STRING(40), allowNull: true },
      plan_id: fk({
        allowNull: true,
        references: { model: 'subscription_plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      plan_price_id: fk({
        allowNull: true,
        references: { model: 'plan_prices', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      subtotal: money(),
      discount_amount: money({ defaultValue: 0 }),
      tax_amount: money({ defaultValue: 0 }),
      total: money(),
      /** Line items and any add-ons quoted. */
      line_items: json(),
      status: enumOf(QUOTATION_STATUS, { defaultValue: QUOTATION_STATUS.DRAFT }),
      valid_until: { type: DataTypes.DATEONLY, allowNull: true },
      sent_at: { type: DataTypes.DATE, allowNull: true },
      accepted_at: { type: DataTypes.DATE, allowNull: true },
      rejected_at: { type: DataTypes.DATE, allowNull: true },
      /** Invoice created when the quotation is accepted. */
      converted_invoice_id: fk({
        allowNull: true,
        references: { model: 'invoices', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      notes: { type: DataTypes.TEXT, allowNull: true },
      created_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
    },
    modelOptions('quotations', {
      indexes: [{ fields: ['school_id'] }, { fields: ['organization_id'] }, { fields: ['status'] }],
    })
  );

  return {
    Tax,
    Coupon,
    Invoice,
    InvoiceItem,
    Payment,
    PaymentTransaction,
    Refund,
    CouponUsage,
    Quotation,
  };
};
