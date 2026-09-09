'use strict';

/**
 * Subscription tables — SRS §29 "Subscription", §10.1:
 *   subscription_plans · plan_prices · plan_modules · plan_features · plan_limits ·
 *   subscriptions · subscription_items · subscription_history · subscription_overrides ·
 *   addons · addon_prices · subscription_addons · usage_records
 *
 * SRS §30 Rule 1: plans, modules, limits and prices are database-driven. Nothing in the
 * application compares a plan *name* — entitlement is always resolved by reading these rows.
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
  softDeleteOptions,
} = require('./columns');

const {
  PLAN_STATUS,
  PLAN_VISIBILITY,
  BILLING_CYCLES,
  PRICING_MODELS,
  MODULE_LIST,
  LIMIT_LIST,
  USAGE_LIMIT_KEYS,
  LIMIT_TYPES,
  ADDON_LIST,
  SUBSCRIPTION_STATES,
  SUBSCRIPTION_EVENTS,
  DOWNGRADE_TIMING,
  RENEWAL_MODES,
  OVERRIDE_TYPES,
} = require('../config/constants');

module.exports = (sequelize) => {
  /* ─────────────────────── subscription_plans (SRS §10.2) ─────────────────────── */

  const SubscriptionPlan = sequelize.define(
    'SubscriptionPlan',
    {
      id: id(),
      /** SRS §10.2 Plan fields: Name, Code, Description, Status, Public/Private, Recommended, Display Order. */
      name: { type: DataTypes.STRING(160), allowNull: false },
      code: { type: DataTypes.STRING(60), allowNull: false, unique: true },
      description: { type: DataTypes.TEXT, allowNull: true },
      status: enumOf(PLAN_STATUS, { defaultValue: PLAN_STATUS.ACTIVE }),
      visibility: enumOf(PLAN_VISIBILITY, { defaultValue: PLAN_VISIBILITY.PUBLIC }),
      is_recommended: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

      /** SRS §12.1 Trial — 3/7/14/30 days, or a custom length. */
      trial_days: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: '0 = no trial; any positive value supports the Custom option',
      },
      /** SRS §12.2 Grace Period — 1/3/7/15 days, or a custom length. */
      grace_period_days: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      /** SRS §12.5 default renewal mode for new subscriptions on this plan. */
      default_renewal_mode: enumOf(RENEWAL_MODES, { defaultValue: RENEWAL_MODES.MANUAL }),
      /** Ranking used to decide whether a plan change is an upgrade or a downgrade (SRS §12.3/§12.4). */
      tier_rank: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Higher rank = higher tier; drives upgrade/downgrade classification',
      },
      archived_at: { type: DataTypes.DATE, allowNull: true },
      /** Set when a plan is produced by FR-SUB-003 Duplicate. */
      duplicated_from_id: fk({
        allowNull: true,
        references: { model: 'subscription_plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
    },
    softDeleteOptions('subscription_plans', {
      indexes: [
        { fields: ['status'] },
        { fields: ['visibility'] },
        { fields: ['display_order'] },
      ],
    })
  );

  /* ─────────────────────── plan_prices (SRS §10.3, §10.4) ─────────────────────── */

  const PlanPrice = sequelize.define(
    'PlanPrice',
    {
      id: id(),
      plan_id: fk({
        references: { model: 'subscription_plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      /** SRS §10.3 — one of the seven billing cycles. */
      billing_cycle: enumOf(BILLING_CYCLES),
      /** Length in days when billing_cycle = custom_days (SRS §10.3 "Custom Days"). */
      cycle_days: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      /** SRS §10.4 — one of the five pricing models. */
      pricing_model: enumOf(PRICING_MODELS, { defaultValue: PRICING_MODELS.FIXED }),
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },

      /** Fixed Price: the whole amount for the cycle. */
      base_amount: money({ comment: 'Fixed portion charged every cycle' }),
      /**
       * Student-Based / Seat-Based / Per-Student: the unit rate.
       *  student_based — rate applied to the school's student count band
       *  seat_based    — rate applied per purchased seat (included_units)
       *  per_student   — rate applied to each active student, every cycle
       */
      unit_amount: money({ comment: 'Per-unit rate for student/seat/per-student models' }),
      included_units: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: 'Units bundled into base_amount before unit_amount applies',
      },
      /** Student-Based pricing band, inclusive. Null upper bound = open-ended. */
      tier_min_units: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      tier_max_units: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      /** Per-unit charge applied to usage beyond a Fixed limit (SRS §33 "Overage"). */
      overage_unit_amount: money({ allowNull: true, defaultValue: null }),
      /** Custom Price: an agreed amount, optionally with a free-form basis note. */
      custom_amount: money({ allowNull: true, defaultValue: null }),
      custom_notes: { type: DataTypes.STRING(255), allowNull: true },

      setup_fee: money({ defaultValue: 0 }),
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      is_default: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Pre-selected option when subscribing to this plan',
      },
      display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    modelOptions('plan_prices', {
      indexes: [
        { fields: ['plan_id'] },
        { fields: ['plan_id', 'billing_cycle'] },
        { fields: ['is_active'] },
      ],
      validate: {
        customDaysRequiresLength() {
          if (this.billing_cycle === BILLING_CYCLES.CUSTOM_DAYS && !this.cycle_days) {
            throw new Error('cycle_days is required when billing_cycle is custom_days');
          }
        },
        tierBandOrdered() {
          if (
            this.tier_min_units !== null &&
            this.tier_max_units !== null &&
            this.tier_min_units !== undefined &&
            this.tier_max_units !== undefined &&
            Number(this.tier_max_units) < Number(this.tier_min_units)
          ) {
            throw new Error('tier_max_units must be greater than or equal to tier_min_units');
          }
        },
      },
    })
  );

  /* ─────────────────────── plan_modules (SRS §11.1) ─────────────────────── */

  const PlanModule = sequelize.define(
    'PlanModule',
    {
      id: id(),
      plan_id: fk({
        references: { model: 'subscription_plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      module_key: {
        type: DataTypes.STRING(40),
        allowNull: false,
        validate: { isIn: [MODULE_LIST] },
        comment: 'One of the twenty subscribable modules (SRS §11.1)',
      },
      is_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      settings: json({ comment: 'Optional per-module configuration for this plan' }),
    },
    modelOptions('plan_modules', {
      indexes: [
        { unique: true, fields: ['plan_id', 'module_key'], name: 'plan_modules_unique' },
        { fields: ['module_key'] },
      ],
    })
  );

  /* ─────────────────────── plan_features (SRS §11) ─────────────────────── */

  const PlanFeature = sequelize.define(
    'PlanFeature',
    {
      id: id(),
      plan_id: fk({
        references: { model: 'subscription_plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      feature_key: { type: DataTypes.STRING(80), allowNull: false },
      name: { type: DataTypes.STRING(160), allowNull: true },
      is_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      /** Feature value when a feature is more than a boolean (e.g. a retention window). */
      value: { type: DataTypes.STRING(120), allowNull: true },
      module_key: {
        type: DataTypes.STRING(40),
        allowNull: true,
        comment: 'Module this feature belongs to, when it belongs to one',
      },
      display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    modelOptions('plan_features', {
      indexes: [
        { unique: true, fields: ['plan_id', 'feature_key'], name: 'plan_features_unique' },
      ],
    })
  );

  /* ─────────────────────── plan_limits (SRS §11.2) ─────────────────────── */

  const PlanLimit = sequelize.define(
    'PlanLimit',
    {
      id: id(),
      plan_id: fk({
        references: { model: 'subscription_plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      limit_key: {
        type: DataTypes.STRING(40),
        allowNull: false,
        validate: { isIn: [LIMIT_LIST] },
        comment: 'One of the eight limits (SRS §11.2)',
      },
      /** SRS §11.2 — "Each limit may be configured as: Fixed | Unlimited". */
      limit_type: enumOf(LIMIT_TYPES, { defaultValue: LIMIT_TYPES.FIXED }),
      limit_value: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Required when limit_type = fixed; ignored when unlimited',
      },
      unit: { type: DataTypes.STRING(20), allowNull: true, comment: 'count | megabytes | requests' },
      /** SRS §33 "Overage" — allow exceeding a Fixed limit and bill for the excess. */
      allow_overage: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      overage_unit_amount: money({ allowNull: true, defaultValue: null }),
    },
    modelOptions('plan_limits', {
      indexes: [{ unique: true, fields: ['plan_id', 'limit_key'], name: 'plan_limits_unique' }],
      validate: {
        fixedNeedsValue() {
          if (this.limit_type === LIMIT_TYPES.FIXED && (this.limit_value === null || this.limit_value === undefined)) {
            throw new Error('limit_value is required when limit_type is fixed');
          }
        },
      },
    })
  );

  /* ─────────────────────── addons (SRS §11.3) ─────────────────────── */

  const Addon = sequelize.define(
    'Addon',
    {
      id: id(),
      key: {
        type: DataTypes.STRING(40),
        allowNull: false,
        unique: true,
        validate: { isIn: [ADDON_LIST] },
        comment: 'One of the seven add-ons (SRS §11.3)',
      },
      name: { type: DataTypes.STRING(160), allowNull: false },
      description: { type: DataTypes.STRING(255), allowNull: true },
      /** How the add-on changes entitlement: limit_increase | feature_unlock. */
      effect_type: enumOf(['limit_increase', 'feature_unlock'], { defaultValue: 'limit_increase' }),
      /** Limit key or feature key the effect applies to. */
      effect_target: { type: DataTypes.STRING(40), allowNull: false },
      units_per_quantity: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 1,
        comment: 'e.g. 50 extra students per purchased quantity',
      },
      unit: { type: DataTypes.STRING(20), allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      display_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    modelOptions('addons', { indexes: [{ fields: ['is_active'] }] })
  );

  /* ─────────────────────── addon_prices ─────────────────────── */

  const AddonPrice = sequelize.define(
    'AddonPrice',
    {
      id: id(),
      addon_id: fk({ references: { model: 'addons', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      /** An add-on may be priced per billing cycle or as a one-time purchase (SRS §10.3). */
      billing_cycle: enumOf(BILLING_CYCLES, { defaultValue: BILLING_CYCLES.MONTHLY }),
      cycle_days: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      unit_amount: money({ comment: 'Charge per purchased quantity' }),
      /** Restrict an add-on price to a specific plan; null = available on any plan. */
      plan_id: fk({
        allowNull: true,
        references: { model: 'subscription_plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    modelOptions('addon_prices', {
      indexes: [
        { fields: ['addon_id'] },
        { fields: ['plan_id'] },
        { fields: ['addon_id', 'billing_cycle'] },
      ],
    })
  );

  /* ─────────────────────── subscriptions (SRS §12) ─────────────────────── */

  const Subscription = sequelize.define(
    'Subscription',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      plan_id: fk({
        references: { model: 'subscription_plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      }),
      plan_price_id: fk({
        allowNull: true,
        references: { model: 'plan_prices', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),

      /** SRS §12 — one of the ten lifecycle states. */
      state: enumOf(SUBSCRIPTION_STATES, { defaultValue: SUBSCRIPTION_STATES.PENDING }),
      /** Denormalised copy of the price row so a later price edit cannot rewrite history. */
      billing_cycle: enumOf(BILLING_CYCLES, { defaultValue: BILLING_CYCLES.MONTHLY }),
      cycle_days: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      pricing_model: enumOf(PRICING_MODELS, { defaultValue: PRICING_MODELS.FIXED }),
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      /** Amount charged for the current cycle, after pricing-model evaluation. */
      cycle_amount: money(),
      quantity: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 1,
        comment: 'Seats/students used by the seat-based and per-student pricing models',
      },

      /** Period boundaries. */
      starts_at: { type: DataTypes.DATE, allowNull: false },
      current_period_start: { type: DataTypes.DATE, allowNull: false },
      current_period_end: { type: DataTypes.DATE, allowNull: true, comment: 'Null for one_time' },
      ends_at: { type: DataTypes.DATE, allowNull: true },

      /** SRS §12.1 Trial. */
      trial_days: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      trial_starts_at: { type: DataTypes.DATE, allowNull: true },
      trial_ends_at: { type: DataTypes.DATE, allowNull: true },

      /** SRS §12.2 Grace Period. */
      grace_period_days: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      grace_period_ends_at: { type: DataTypes.DATE, allowNull: true },

      /** SRS §12.5 Renewal. */
      renewal_mode: enumOf(RENEWAL_MODES, { defaultValue: RENEWAL_MODES.MANUAL }),
      next_renewal_at: { type: DataTypes.DATE, allowNull: true },
      last_renewed_at: { type: DataTypes.DATE, allowNull: true },
      renewal_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },

      /** SRS §12.4 Downgrade scheduled for the next billing cycle. */
      scheduled_plan_id: fk({
        allowNull: true,
        references: { model: 'subscription_plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      scheduled_plan_price_id: fk({
        allowNull: true,
        references: { model: 'plan_prices', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      scheduled_change_type: { type: DataTypes.STRING(20), allowNull: true, comment: 'upgrade | downgrade' },
      scheduled_change_timing: enumOf(DOWNGRADE_TIMING, { allowNull: true, defaultValue: null }),
      scheduled_change_at: { type: DataTypes.DATE, allowNull: true },

      /** SRS §12.3 Remaining Credit carried from a prior plan. */
      credit_balance: money({ defaultValue: 0, comment: 'Unapplied proration credit (SRS §12.3)' }),
      /** SRS §13.2 Wallet payment method balance. */
      wallet_balance: money({ defaultValue: 0 }),

      paused_at: { type: DataTypes.DATE, allowNull: true },
      cancelled_at: { type: DataTypes.DATE, allowNull: true },
      cancellation_reason: { type: DataTypes.STRING(255), allowNull: true },
      suspended_at: { type: DataTypes.DATE, allowNull: true },
      expired_at: { type: DataTypes.DATE, allowNull: true },
      /** Marker used by the expiry-notice cron so a school is warned exactly once per cycle. */
      expiry_notified_at: { type: DataTypes.DATE, allowNull: true },
      metadata: json(),
    },
    modelOptions('subscriptions', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['plan_id'] },
        { fields: ['state'] },
        { fields: ['current_period_end'] },
        { fields: ['next_renewal_at'] },
        { fields: ['school_id', 'state'] },
      ],
    })
  );

  /* ─────────────────────── subscription_items (SRS §10.1) ─────────────────────── */

  /** Priced lines that make up a subscription: the plan itself plus any add-on lines. */
  const SubscriptionItem = sequelize.define(
    'SubscriptionItem',
    {
      id: id(),
      subscription_id: fk({
        references: { model: 'subscriptions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      school_id: schoolId(),
      item_type: enumOf(['plan', 'addon', 'setup_fee', 'overage', 'custom'], { defaultValue: 'plan' }),
      plan_id: fk({
        allowNull: true,
        references: { model: 'subscription_plans', key: 'id' },
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
      quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      unit_amount: money(),
      amount: money(),
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      period_start: { type: DataTypes.DATE, allowNull: true },
      period_end: { type: DataTypes.DATE, allowNull: true },
      is_recurring: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      metadata: json(),
    },
    modelOptions('subscription_items', {
      indexes: [{ fields: ['subscription_id'] }, { fields: ['school_id'] }, { fields: ['item_type'] }],
    })
  );

  /* ─────────────────────── subscription_history (SRS §10.1) ─────────────────────── */

  const SubscriptionHistory = sequelize.define(
    'SubscriptionHistory',
    {
      id: id(),
      subscription_id: fk({
        references: { model: 'subscriptions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      school_id: schoolId(),
      event: enumOf(SUBSCRIPTION_EVENTS),
      from_state: { type: DataTypes.STRING(30), allowNull: true },
      to_state: { type: DataTypes.STRING(30), allowNull: true },
      from_plan_id: fk({
        allowNull: true,
        references: { model: 'subscription_plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      to_plan_id: fk({
        allowNull: true,
        references: { model: 'subscription_plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      /** SRS §12.3 — proration amount and remaining credit recorded for auditability. */
      proration_amount: money({ allowNull: true, defaultValue: null }),
      credit_applied: money({ allowNull: true, defaultValue: null }),
      new_amount: money({ allowNull: true, defaultValue: null }),
      effective_at: { type: DataTypes.DATE, allowNull: true },
      notes: { type: DataTypes.STRING(500), allowNull: true },
      performed_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      metadata: json(),
    },
    modelOptions('subscription_history', {
      indexes: [
        { fields: ['subscription_id'] },
        { fields: ['school_id'] },
        { fields: ['event'] },
        { fields: ['created_at'] },
      ],
    })
  );

  /* ─────────────── subscription_overrides (SRS §33 custom limits / feature overrides) ─────────────── */

  const SubscriptionOverride = sequelize.define(
    'SubscriptionOverride',
    {
      id: id(),
      subscription_id: fk({
        references: { model: 'subscriptions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      school_id: schoolId(),
      /** module | feature | limit | price */
      override_type: enumOf(OVERRIDE_TYPES),
      target_key: {
        type: DataTypes.STRING(60),
        allowNull: false,
        comment: 'module_key, feature_key, limit_key, or a price component',
      },
      /** For module/feature overrides. */
      is_enabled: { type: DataTypes.BOOLEAN, allowNull: true },
      /** For limit overrides (SRS §33 "Custom Limits"). */
      limit_type: enumOf(LIMIT_TYPES, { allowNull: true, defaultValue: null }),
      limit_value: { type: DataTypes.BIGINT, allowNull: true },
      /** For price overrides (SRS §33 "Custom Pricing"). */
      amount: money({ allowNull: true, defaultValue: null }),
      reason: { type: DataTypes.STRING(255), allowNull: true },
      effective_from: { type: DataTypes.DATE, allowNull: true },
      effective_until: { type: DataTypes.DATE, allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
    },
    modelOptions('subscription_overrides', {
      indexes: [
        {
          unique: true,
          fields: ['subscription_id', 'override_type', 'target_key'],
          name: 'subscription_overrides_unique',
        },
        { fields: ['school_id'] },
        { fields: ['is_active'] },
      ],
    })
  );

  /* ─────────────────────── subscription_addons (SRS §11.3) ─────────────────────── */

  const SubscriptionAddon = sequelize.define(
    'SubscriptionAddon',
    {
      id: id(),
      subscription_id: fk({
        references: { model: 'subscriptions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      school_id: schoolId(),
      addon_id: fk({ references: { model: 'addons', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' }),
      addon_price_id: fk({
        allowNull: true,
        references: { model: 'addon_prices', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      unit_amount: money(),
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      /** Resolved effect, copied at purchase so a later add-on edit cannot change entitlement. */
      effect_type: enumOf(['limit_increase', 'feature_unlock'], { defaultValue: 'limit_increase' }),
      effect_target: { type: DataTypes.STRING(40), allowNull: false },
      units_granted: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      status: enumOf(['active', 'cancelled', 'expired'], { defaultValue: 'active' }),
      starts_at: { type: DataTypes.DATE, allowNull: true },
      ends_at: { type: DataTypes.DATE, allowNull: true },
      is_recurring: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    modelOptions('subscription_addons', {
      indexes: [
        { fields: ['subscription_id'] },
        { fields: ['school_id'] },
        { fields: ['addon_id'] },
        { fields: ['status'] },
      ],
    })
  );

  /* ─────────────────────── usage_records (SRS §11.2, §21) ─────────────────────── */

  /**
   * One row per (school, limit, period). SRS §21 example: "Plan: 1000 AI Requests —
   * Usage: 750 / 1000" reads `used_value` for limit_key 'ai_limit' in the current period.
   */
  const UsageRecord = sequelize.define(
    'UsageRecord',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      subscription_id: fk({
        allowNull: true,
        references: { model: 'subscriptions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      limit_key: {
        type: DataTypes.STRING(40),
        allowNull: false,
        /* The eight SRS §11.2 plan limits plus the add-on-only SMS allowance. */
        validate: { isIn: [USAGE_LIMIT_KEYS] },
      },
      unit: { type: DataTypes.STRING(20), allowNull: true },
      used_value: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      /** Snapshot of the allowance at the time of the last update, for reporting. */
      allowed_value: { type: DataTypes.BIGINT, allowNull: true, comment: 'Null = unlimited' },
      /** Usage beyond a Fixed limit when overage is permitted (SRS §33 "Overage"). */
      overage_value: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      overage_amount: money({ defaultValue: 0 }),
      period_start: { type: DataTypes.DATE, allowNull: false },
      period_end: { type: DataTypes.DATE, allowNull: true },
      last_incremented_at: { type: DataTypes.DATE, allowNull: true },
      metadata: json(),
    },
    modelOptions('usage_records', {
      indexes: [
        {
          unique: true,
          fields: ['school_id', 'limit_key', 'period_start'],
          name: 'usage_records_school_limit_period_unique',
        },
        { fields: ['school_id'] },
        { fields: ['subscription_id'] },
        { fields: ['limit_key'] },
      ],
    })
  );

  return {
    SubscriptionPlan,
    PlanPrice,
    PlanModule,
    PlanFeature,
    PlanLimit,
    Addon,
    AddonPrice,
    Subscription,
    SubscriptionItem,
    SubscriptionHistory,
    SubscriptionOverride,
    SubscriptionAddon,
    UsageRecord,
  };
};
