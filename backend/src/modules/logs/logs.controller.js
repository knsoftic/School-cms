'use strict';

const service = require('./logs.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');

/** GET /activity — the activity trail, confined to the caller's tenant. */
async function activity(req, res) {
  const pagination = getPagination(req);
  const result = await service.listActivity(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

/** GET /audit — the audit trail, confined to the caller's tenant. */
async function audit(req, res) {
  const pagination = getPagination(req);
  const result = await service.listAudit(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

module.exports = { activity, audit };
