'use strict';

const service = require('./teachers.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

function label(teacher) {
  return [teacher.first_name, teacher.last_name].filter(Boolean).join(' ');
}

async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function show(req, res) {
  const teacher = await service.findById(req, req.params.id);
  return ApiResponse.ok(res, { teacher });
}

async function create(req, res) {
  const teacher = await service.create(req, req.body);
  describeActivity(req, {
    entityId: teacher.id,
    description: `Created teacher ${label(teacher)}`,
    metadata: { school_id: teacher.school_id, employee_id: teacher.employee_id },
  });
  return ApiResponse.created(res, { teacher }, { message: 'Teacher created' });
}

async function update(req, res) {
  const teacher = await service.update(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: teacher.id,
    description: `Updated teacher ${label(teacher)}`,
    metadata: { school_id: teacher.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { teacher }, { message: 'Teacher updated' });
}

async function assignments(req, res) {
  const { subjects, classTeacherOf, sectionTeacherOf } = await service.assignments(req, req.params.id);
  return ApiResponse.ok(res, { subjects, classTeacherOf, sectionTeacherOf });
}

async function dashboard(req, res) {
  const data = await service.dashboard(req);
  return ApiResponse.ok(res, data);
}

module.exports = { list, show, create, update, assignments, dashboard };
