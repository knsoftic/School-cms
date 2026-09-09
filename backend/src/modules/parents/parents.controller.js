'use strict';

const service = require('./parents.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function show(req, res) {
  const parent = await service.findById(req, req.params.id);
  return ApiResponse.ok(res, { parent });
}

async function create(req, res) {
  const { parent, verificationEmailSent } = await service.create(req, req.body);
  describeActivity(req, {
    entityId: parent.id,
    description: `Created parent account for ${parent.name}`,
    metadata: { school_id: parent.school_id, user_id: parent.user_id },
  });
  return ApiResponse.created(
    res,
    { parent, verificationEmailSent },
    { message: 'Parent account created' }
  );
}

async function update(req, res) {
  const parent = await service.update(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: parent.id,
    description: `Updated parent ${parent.name}`,
    metadata: { school_id: parent.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { parent }, { message: 'Parent updated' });
}

async function listChildren(req, res) {
  const { rows } = await service.listChildren(req, req.params.id);
  return ApiResponse.ok(res, { children: rows });
}

async function linkChild(req, res) {
  const link = await service.linkChild(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: link.id,
    description: `Linked student ${link.student_id} to parent ${req.params.id}`,
    metadata: { parent_id: link.parent_id, student_id: link.student_id },
  });
  return ApiResponse.created(res, { link }, { message: 'Child linked' });
}

async function unlinkChild(req, res) {
  const link = await service.unlinkChild(req, req.params.id, req.params.linkId);
  describeActivity(req, {
    entityId: link.id,
    description: `Unlinked student ${link.student_id} from parent ${req.params.id}`,
    metadata: { parent_id: link.parent_id, student_id: link.student_id },
  });
  return ApiResponse.noContent(res);
}

async function dashboard(req, res) {
  const data = await service.dashboard(req);
  return ApiResponse.ok(res, data);
}

module.exports = { list, show, create, update, listChildren, linkChild, unlinkChild, dashboard };
