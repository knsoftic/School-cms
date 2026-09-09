'use strict';

/**
 * Platform controllers — SRS §9.1, FR-SADMIN-001.
 */

const service = require('./platform.service');
const ApiResponse = require('../../utils/ApiResponse');

/** GET /dashboard — the eleven §9.1 metrics. */
async function dashboard(req, res) {
  const metrics = await service.getDashboard(req.tenant);
  return ApiResponse.ok(res, { metrics });
}

module.exports = { dashboard };
