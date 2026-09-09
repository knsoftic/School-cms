'use strict';

const service = require('./fees.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

async function listStructures(req, res) {
  const pagination = getPagination(req);
  const result = await service.listStructures(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function showStructure(req, res) {
  const structure = await service.findStructure(req, req.params.id);
  return ApiResponse.ok(res, { structure });
}

async function createStructure(req, res) {
  const structure = await service.createStructure(req, req.body);
  describeActivity(req, {
    entityId: structure.id,
    description: `Defined ${structure.component} fee structure "${structure.name}"`,
    metadata: {
      school_id: structure.school_id,
      component: structure.component,
      amount: structure.amount,
      class_id: structure.class_id,
    },
  });
  return ApiResponse.created(res, { structure }, { message: 'Fee structure created' });
}

async function updateStructure(req, res) {
  const structure = await service.updateStructure(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: structure.id,
    description: `Updated fee structure "${structure.name}"`,
    metadata: { school_id: structure.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { structure }, { message: 'Fee structure updated' });
}

async function assign(req, res) {
  const { structure, rows } = await service.assign(req, req.body);
  /*
   * The batch is the event for the activity trail; each `student_fees` row still gets its own
   * `audit_logs` entry from the service, because a fee is a thing a family is later billed for and
   * "who created this one" has to be answerable per row.
   */
  describeActivity(req, {
    entityId: structure.id,
    description: `Assigned "${structure.name}" to ${rows.length} student(s)`,
    metadata: {
      school_id: structure.school_id,
      fee_structure_id: structure.id,
      component: structure.component,
      count: rows.length,
    },
  });
  return ApiResponse.created(res, { fees: rows }, { message: 'Fee assigned' });
}

async function listLedger(req, res) {
  const pagination = getPagination(req);
  const result = await service.listLedger(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function pay(req, res) {
  const { payment, studentFee } = await service.pay(req, req.body);
  describeActivity(req, {
    entityId: payment.id,
    description: `Collected ${payment.currency} ${payment.amount} on receipt ${payment.receipt_number}`,
    metadata: {
      school_id: payment.school_id,
      student_fee_id: studentFee.id,
      receipt_number: payment.receipt_number,
      method: payment.method,
      pending_amount: studentFee.pending_amount,
      status: studentFee.status,
    },
  });
  /* The receipt and the balance it left behind, together — FR-FEE-002 asks for both. */
  return ApiResponse.created(res, { payment, fee: studentFee }, { message: 'Payment recorded' });
}

async function listPayments(req, res) {
  const pagination = getPagination(req);
  const result = await service.listPayments(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

module.exports = {
  listStructures,
  showStructure,
  createStructure,
  updateStructure,
  assign,
  listLedger,
  pay,
  listPayments,
};
