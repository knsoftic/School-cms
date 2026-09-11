'use strict';

/**
 * Fee schemas — SRS §17, FR-FEE-001 (structure) / FR-FEE-002 (collection & partial payment).
 *
 * §17 names exactly four fee components — Monthly, Admission, Exam, Transport — and they already
 * exist as `FEE_COMPONENTS`, which is what the column's enum is built from. The valid list comes from
 * the constant, and the suite asserts the *schema's* list against the *model's* so the two cannot
 * drift: the shape `verify-staff.js` had to be rewritten to make meaningful.
 *
 * §17 also names "Fine" and "Discount" as things the user **may configure** — so `fine_type` and
 * `discount_type` are structure fields, and their enums come from the model too.
 *
 * `due_date` and `period_month` are `DATEONLY`, normalised in the service through
 * `dates.toDateOnly()` (Known Issues #20).
 *
 * Every money field is a `DECIMAL(14,2)` on its column, so each is bounded here at that precision
 * rather than left open — the width-versus-column discipline of §5a defect 24 applied to numbers.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const {
  FEE_COMPONENT_LIST,
  STUDENT_FEE_STATUS,
  PAYMENT_METHOD_LIST,
} = require('../../config/constants');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

/** `DECIMAL(14,2)` — twelve digits before the point. */
const moneyField = Joi.number().min(0).max(999999999999.99);

const fields = {
  school_id: Joi.number().integer().min(1),
  academic_session_id: Joi.number().integer().min(1).allow(null),
  class_id: Joi.number().integer().min(1).allow(null),
  student_id: Joi.number().integer().min(1),
  fee_structure_id: Joi.number().integer().min(1),
  student_fee_id: Joi.number().integer().min(1),

  name: Joi.string().trim().min(1).max(160),
  title: Joi.string().trim().min(1).max(160),
  component: Joi.string().valid(...FEE_COMPONENT_LIST),
  amount: moneyField,
  currency: Joi.string().trim().uppercase().max(10),
  is_recurring: Joi.boolean(),
  due_day: Joi.number().integer().min(1).max(31).allow(null),

  fine_amount: moneyField,
  fine_type: Joi.string().valid('none', 'fixed', 'per_day', 'percentage'),
  fine_grace_days: Joi.number().integer().min(0).max(365),
  discount_amount: moneyField,
  discount_type: Joi.string().valid('none', 'fixed', 'percentage'),

  is_active: Joi.boolean(),
  description: Joi.string().trim().max(255).empty('').allow(null),
  remarks: Joi.string().trim().max(255).empty('').allow(null),

  due_date: Joi.date().iso(),
  period_month: Joi.date().iso().allow(null),

  method: Joi.string().valid(...PAYMENT_METHOD_LIST),
  reference: Joi.string().trim().max(160).empty('').allow(null),
  paid_at: Joi.date().iso(),

  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const owned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
};

/**
 * FR-FEE-001 — the structure.
 *
 * `component` and `amount` are what make a structure a structure; the fine and discount are the
 * "may configure" half and default at the column.
 */
const createStructure = Joi.object({
  school_id: fields.school_id,
  name: fields.name.required(),
  component: fields.component.required(),
  amount: fields.amount.required(),
  academic_session_id: fields.academic_session_id,
  class_id: fields.class_id,
  currency: fields.currency,
  is_recurring: fields.is_recurring,
  due_day: fields.due_day,
  fine_amount: fields.fine_amount,
  fine_type: fields.fine_type,
  fine_grace_days: fields.fine_grace_days,
  discount_amount: fields.discount_amount,
  discount_type: fields.discount_type,
  is_active: fields.is_active,
  description: fields.description,
  reason: fields.reason,
  ...owned,
});

const updateStructure = Joi.object({
  school_id: fields.school_id,
  name: fields.name,
  component: fields.component,
  amount: fields.amount,
  academic_session_id: fields.academic_session_id,
  class_id: fields.class_id,
  currency: fields.currency,
  is_recurring: fields.is_recurring,
  due_day: fields.due_day,
  fine_amount: fields.fine_amount,
  fine_type: fields.fine_type,
  fine_grace_days: fields.fine_grace_days,
  discount_amount: fields.discount_amount,
  discount_type: fields.discount_type,
  is_active: fields.is_active,
  description: fields.description,
  reason: fields.reason,
  ...owned,
}).min(1);

/**
 * The bridge between the two requirements: FR-FEE-001 ends "available for **assignment** to students"
 * and FR-FEE-002 begins "Fee Structure **is assigned** to the student". Assignment is named by the
 * source at both ends, so it is a required operation rather than an invented one.
 *
 * Bulk by shape for the same reason attendance is: a structure is assigned to a class's worth of
 * children at once.
 */
const assign = Joi.object({
  school_id: fields.school_id,
  fee_structure_id: fields.fee_structure_id.required(),
  student_ids: Joi.array().items(fields.student_id.required()).min(1).max(500).required(),
  due_date: fields.due_date.required(),
  period_month: fields.period_month,
  title: fields.title,
  /* An override of the structure's own figures for this assignment only. */
  amount: fields.amount,
  discount_amount: fields.discount_amount,
  fine_amount: fields.fine_amount,
  remarks: fields.remarks,
  reason: fields.reason,
  /* The ledger's own arithmetic is the system's, never a caller's. */
  net_amount: forbiddenField('"net_amount" is computed from amount, discount and fine'),
  paid_amount: forbiddenField('"paid_amount" is the sum of the payments recorded against this fee'),
  pending_amount: forbiddenField('"pending_amount" is computed from the payments recorded'),
  status: forbiddenField('"status" follows from what has been paid'),
  ...owned,
});

/** FR-FEE-002 — a payment, in full or partial. */
const pay = Joi.object({
  school_id: fields.school_id,
  student_fee_id: fields.student_fee_id.required(),
  amount: fields.amount.required(),
  method: fields.method.required(),
  fine_paid: fields.fine_amount,
  discount_given: fields.discount_amount,
  reference: fields.reference,
  paid_at: fields.paid_at,
  remarks: fields.remarks,
  reason: fields.reason,
  receipt_number: forbiddenField('"receipt_number" is issued by the system'),
  ...owned,
});

const listStructures = listQuery(
  Joi.object({
    school_id: fields.school_id,
    component: fields.component,
    class_id: fields.class_id,
    academic_session_id: fields.academic_session_id,
    is_active: Joi.boolean(),
  })
);

const listLedger = listQuery(
  Joi.object({
    school_id: fields.school_id,
    student_id: fields.student_id,
    class_id: fields.class_id,
    component: fields.component,
    academic_session_id: fields.academic_session_id,
    status: Joi.string().valid(...Object.values(STUDENT_FEE_STATUS)),
    due_from: fields.due_date,
    due_to: fields.due_date,
  })
);

const listPayments = listQuery(
  Joi.object({
    school_id: fields.school_id,
    student_id: fields.student_id,
    student_fee_id: fields.student_fee_id,
    method: fields.method,
    receipt_number: Joi.string().trim().max(60),
    from: fields.paid_at,
    to: fields.paid_at,
  })
);

const showQuery = Joi.object({ school_id: fields.school_id });

/** `GET /mine` — at most a student to narrow to, a session and a status; never a school or a class. */
const mine = Joi.object({
  student_id: fields.student_id,
  academic_session_id: Joi.number().integer().min(1),
  status: Joi.string().valid(...Object.values(STUDENT_FEE_STATUS)),
});

module.exports = {
  schemas: {
    mine,
    createStructure,
    updateStructure,
    assign,
    pay,
    listStructures,
    listLedger,
    listPayments,
    showQuery,
    idParam: commonSchemas.idParam,
  },
  fields,
};
