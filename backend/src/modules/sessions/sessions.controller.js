'use strict';

const service = require('./sessions.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function current(req, res) {
  const session = await service.current(req);
  return ApiResponse.ok(res, { session });
}

async function show(req, res) {
  const session = await service.findById(req, req.params.id);
  return ApiResponse.ok(res, { session });
}

async function create(req, res) {
  const session = await service.create(req, req.body);
  describeActivity(req, {
    entityId: session.id,
    description: `Created academic session ${session.name}`,
    metadata: { school_id: session.school_id, name: session.name },
  });
  return ApiResponse.created(res, { session }, { message: 'Academic session created' });
}

async function update(req, res) {
  const session = await service.update(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: session.id,
    description: `Updated academic session ${session.name}`,
    metadata: { school_id: session.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { session }, { message: 'Academic session updated' });
}

async function activate(req, res) {
  const session = await service.activate(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: session.id,
    description: `Activated academic session ${session.name}`,
    metadata: { school_id: session.school_id },
  });
  return ApiResponse.ok(res, { session }, { message: 'Academic session activated' });
}

async function close(req, res) {
  const session = await service.close(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: session.id,
    description: `Closed academic session ${session.name}`,
    metadata: { school_id: session.school_id },
  });
  return ApiResponse.ok(res, { session }, { message: 'Academic session closed' });
}

module.exports = { list, current, show, create, update, activate, close };
