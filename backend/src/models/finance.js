'use strict';

/**
 * Finance tables — SRS §29 "Finance", §17–§18:
 *   fee_structures · student_fees · fee_payments · expenses · incomes
 *
 * SRS §17 names the fee components (Monthly, Admission, Exam, Transport) plus Fine,
 * Discount, Pending Fee, Partial Payment and Payment Receipt.
 * SRS §18 names Income, Expenses, Salaries, Other Expenses, and the dashboard
 * calculation "Income − Expense = Net Balance" (computed at query time, never stored).
 */

const {
  DataTypes,
  id,
  fk,
  organizationId,
  schoolId,
  academicSessionId,
  money,
  enumOf,
  json,
  modelOptions,
} = require('./columns');

const {
  FEE_COMPONENTS,
  STUDENT_FEE_STATUS,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  PAYMENT_METHODS,
} = require('../config/constants');

module.exports = (sequelize) => {
  /* ─────────────────────────────── fee_structures ─────────────────────────────── */

  /**
   * SRS §17 / FR-FEE-001 — one row per fee component per class (per session).
   * Fine and Discount are configured here and carried onto the student's fee record.
   */
  const FeeStructure = sequelize.define(
    'FeeStructure',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      academic_session_id: academicSessionId(),
      class_id: fk({
        allowNull: true,
        references: { model: 'classes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
        comment: 'Null = applies school-wide',
      }),
      name: { type: DataTypes.STRING(160), allowNull: false },
      /** SRS §17 — Monthly Fee | Admission Fee | Exam Fee | Transport Fee. */
      component: enumOf(FEE_COMPONENTS),
      amount: money(),
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      /** Monthly components recur; admission is charged once. */
      is_recurring: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      /** Day of month a recurring component falls due. */
      due_day: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, validate: { min: 1, max: 31 } },

      /** SRS §17 — Fine. */
      fine_amount: money({ defaultValue: 0 }),
      fine_type: enumOf(['none', 'fixed', 'per_day', 'percentage'], { defaultValue: 'none' }),
      fine_grace_days: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },

      /** SRS §17 — Discount. */
      discount_amount: money({ defaultValue: 0 }),
      discount_type: enumOf(['none', 'fixed', 'percentage'], { defaultValue: 'none' }),

      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      description: { type: DataTypes.STRING(255), allowNull: true },
    },
    modelOptions('fee_structures', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['class_id'] },
        { fields: ['academic_session_id'] },
        { fields: ['component'] },
      ],
      validate: {
        fineTypeNeedsAmount() {
          if (this.fine_type && this.fine_type !== 'none' && Number(this.fine_amount) <= 0) {
            throw new Error('fine_amount must be greater than zero when fine_type is set');
          }
        },
        discountTypeNeedsAmount() {
          if (this.discount_type && this.discount_type !== 'none' && Number(this.discount_amount) <= 0) {
            throw new Error('discount_amount must be greater than zero when discount_type is set');
          }
        },
      },
    })
  );

  /* ─────────────────────────────── student_fees ─────────────────────────────── */

  /**
   * SRS §17 — a fee assigned to a student. `pending_amount` is the "Pending Fee"
   * balance, maintained transactionally alongside `fee_payments`.
   */
  const StudentFee = sequelize.define(
    'StudentFee',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      academic_session_id: academicSessionId(),
      student_id: fk({ references: { model: 'students', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      fee_structure_id: fk({
        allowNull: true,
        references: { model: 'fee_structures', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      class_id: fk({
        allowNull: true,
        references: { model: 'classes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      component: enumOf(FEE_COMPONENTS),
      title: { type: DataTypes.STRING(160), allowNull: false },
      /** Period a recurring fee covers, e.g. 2026-04-01 for April's monthly fee. */
      period_month: { type: DataTypes.DATEONLY, allowNull: true },
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },

      amount: money({ comment: 'Base amount from the fee structure' }),
      discount_amount: money({ defaultValue: 0 }),
      fine_amount: money({ defaultValue: 0 }),
      /** amount − discount + fine. */
      net_amount: money(),
      paid_amount: money({ defaultValue: 0 }),
      /** SRS §17 — Pending Fee. */
      pending_amount: money(),

      due_date: { type: DataTypes.DATEONLY, allowNull: false },
      /** SRS §17 — Partial Payment produces `partially_paid`. */
      status: enumOf(STUDENT_FEE_STATUS, { defaultValue: STUDENT_FEE_STATUS.UNPAID }),
      paid_at: { type: DataTypes.DATE, allowNull: true },
      waived_at: { type: DataTypes.DATE, allowNull: true },
      waiver_reason: { type: DataTypes.STRING(255), allowNull: true },
      /** Set by the fee-reminder job so a reminder is sent once per cycle (SRS §23). */
      reminder_sent_at: { type: DataTypes.DATE, allowNull: true },
      remarks: { type: DataTypes.STRING(255), allowNull: true },
      created_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
    },
    modelOptions('student_fees', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['student_id'] },
        { fields: ['status'] },
        { fields: ['due_date'] },
        { fields: ['school_id', 'status'] },
        { fields: ['student_id', 'component', 'period_month'] },
      ],
    })
  );

  /* ─────────────────────────────── fee_payments ─────────────────────────────── */

  /** SRS §17 / FR-FEE-002 — each collection event, including partial ones. */
  const FeePayment = sequelize.define(
    'FeePayment',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      student_fee_id: fk({
        references: { model: 'student_fees', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      student_id: fk({ references: { model: 'students', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      /** SRS §17 — Payment Receipt number. */
      receipt_number: { type: DataTypes.STRING(60), allowNull: false },
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      amount: money(),
      /** Portion of this payment that settled the fine. */
      fine_paid: money({ defaultValue: 0 }),
      discount_given: money({ defaultValue: 0 }),
      method: enumOf(PAYMENT_METHODS, { defaultValue: PAYMENT_METHODS.CASH }),
      reference: { type: DataTypes.STRING(160), allowNull: true },
      paid_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      /** Accountant/Receptionist who took the payment. */
      collected_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      /** Generated receipt PDF, when one has been produced (SRS §20.5 Fee Receipt). */
      receipt_path: { type: DataTypes.STRING(255), allowNull: true },
      remarks: { type: DataTypes.STRING(255), allowNull: true },
      /** Set when this collection has been posted to `incomes`, so it posts once. */
      income_id: fk({
        allowNull: true,
        references: { model: 'incomes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
    },
    modelOptions('fee_payments', {
      indexes: [
        { unique: true, fields: ['school_id', 'receipt_number'], name: 'fee_payments_school_receipt_unique' },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['student_fee_id'] },
        { fields: ['student_id'] },
        { fields: ['paid_at'] },
      ],
    })
  );

  /* ─────────────────────────────── expenses ─────────────────────────────── */

  /** SRS §18 — Expenses, comprising Salaries and Other Expenses (FR-FIN-001). */
  const Expense = sequelize.define(
    'Expense',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      academic_session_id: academicSessionId(),
      /** SRS §18 — salaries | other_expenses. */
      category: enumOf(EXPENSE_CATEGORIES, { defaultValue: EXPENSE_CATEGORIES.OTHER_EXPENSES }),
      /** Free-text sub-category, e.g. "Utilities" under other_expenses. */
      subcategory: { type: DataTypes.STRING(120), allowNull: true },
      title: { type: DataTypes.STRING(180), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      amount: money(),
      expense_date: { type: DataTypes.DATEONLY, allowNull: false },
      payment_method: enumOf(PAYMENT_METHODS, { allowNull: true, defaultValue: null }),
      reference: { type: DataTypes.STRING(160), allowNull: true },
      /** Salary expenses point at the teacher or staff member being paid. */
      teacher_id: fk({
        allowNull: true,
        references: { model: 'teachers', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      staff_id: fk({
        allowNull: true,
        references: { model: 'staff', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      /** Month a salary payment covers. */
      salary_month: { type: DataTypes.DATEONLY, allowNull: true },
      paid_to: { type: DataTypes.STRING(180), allowNull: true },
      attachment_path: { type: DataTypes.STRING(255), allowNull: true },
      recorded_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      metadata: json(),
    },
    modelOptions('expenses', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['category'] },
        { fields: ['expense_date'] },
        { fields: ['school_id', 'expense_date'] },
        { fields: ['teacher_id'] },
        { fields: ['staff_id'] },
      ],
      validate: {
        salaryNeedsRecipient() {
          if (this.category === EXPENSE_CATEGORIES.SALARIES && !this.teacher_id && !this.staff_id && !this.paid_to) {
            throw new Error('A salary expense must identify a teacher, a staff member, or a paid_to name');
          }
        },
      },
    })
  );

  /* ─────────────────────────────── incomes ─────────────────────────────── */

  /** SRS §18 — Income (FR-FIN-001). Fee collections post here as category `fees`. */
  const Income = sequelize.define(
    'Income',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      academic_session_id: academicSessionId(),
      category: enumOf(INCOME_CATEGORIES, { defaultValue: INCOME_CATEGORIES.OTHER_INCOME }),
      subcategory: { type: DataTypes.STRING(120), allowNull: true },
      title: { type: DataTypes.STRING(180), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      amount: money(),
      income_date: { type: DataTypes.DATEONLY, allowNull: false },
      payment_method: enumOf(PAYMENT_METHODS, { allowNull: true, defaultValue: null }),
      reference: { type: DataTypes.STRING(160), allowNull: true },
      received_from: { type: DataTypes.STRING(180), allowNull: true },
      /** Set when this income row was created from a fee collection. */
      student_id: fk({
        allowNull: true,
        references: { model: 'students', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      attachment_path: { type: DataTypes.STRING(255), allowNull: true },
      recorded_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      metadata: json(),
    },
    modelOptions('incomes', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['category'] },
        { fields: ['income_date'] },
        { fields: ['school_id', 'income_date'] },
        { fields: ['student_id'] },
      ],
    })
  );

  return { FeeStructure, StudentFee, FeePayment, Expense, Income };
};
