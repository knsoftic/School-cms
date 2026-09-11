'use strict';

const service = require('./staff.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

function label(member) {
  return [member.first_name, member.last_name].filter(Boolean).join(' ');
}

async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function show(req, res) {
  const member = await service.findForView(req, req.params.id);
  return ApiResponse.ok(res, { staff: member });
}

async function create(req, res) {
  const member = await service.create(req, req.body);
  describeActivity(req, {
    entityId: member.id,
    description: `Created ${member.category} ${label(member)}`,
    metadata: { school_id: member.school_id, employee_id: member.employee_id, category: member.category },
  });
  return ApiResponse.created(res, { staff: member }, { message: 'Staff member created' });
}

async function update(req, res) {
  const member = await service.update(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: member.id,
    description: `Updated staff member ${label(member)}`,
    metadata: { school_id: member.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { staff: member }, { message: 'Staff member updated' });
}

module.exports = { list, show, create, update };
