'use strict';

const service = require('./settings.service');
const ApiResponse = require('../../utils/ApiResponse');
const { describeActivity } = require('../../middlewares/activityLog');

async function show(req, res) {
  const settings = await service.show(req);
  return ApiResponse.ok(res, { settings });
}

async function update(req, res) {
  const settings = await service.update(req, req.body);

  describeActivity(req, {
    entityId: settings.id,
    description: `Updated school settings for school ${settings.school_id}`,
    metadata: { school_id: settings.school_id, fields: Object.keys(req.body) },
  });

  return ApiResponse.ok(res, { settings }, { message: 'School settings saved' });
}

module.exports = { show, update };
