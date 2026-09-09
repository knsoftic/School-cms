'use strict';

const service = require('./subjects.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function show(req, res) {
  const subject = await service.findSubject(req, req.params.id);
  return ApiResponse.ok(res, { subject });
}

async function create(req, res) {
  const subject = await service.create(req, req.body);
  describeActivity(req, {
    entityId: subject.id,
    description: `Created subject ${subject.code}`,
    metadata: { school_id: subject.school_id, code: subject.code },
  });
  return ApiResponse.created(res, { subject }, { message: 'Subject created' });
}

async function update(req, res) {
  const subject = await service.update(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: subject.id,
    description: `Updated subject ${subject.code}`,
    metadata: { school_id: subject.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { subject }, { message: 'Subject updated' });
}

async function destroy(req, res) {
  const subject = await service.destroy(req, req.params.id);
  describeActivity(req, {
    entityId: subject.id,
    description: `Deleted subject ${subject.code}`,
    metadata: { school_id: subject.school_id },
  });
  return ApiResponse.noContent(res);
}

async function listClasses(req, res) {
  const { rows } = await service.listClassAssignments(req, req.params.id);
  return ApiResponse.ok(res, { assignments: rows });
}

async function assignClass(req, res) {
  const assignment = await service.assignClass(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: assignment.id,
    description: `Assigned subject ${assignment.subject_id} to class ${assignment.class_id}`,
    metadata: { class_id: assignment.class_id, section_id: assignment.section_id },
  });
  return ApiResponse.created(res, { assignment }, { message: 'Subject assigned to class' });
}

async function unassignClass(req, res) {
  const assignment = await service.unassignClass(req, req.params.id, req.params.assignmentId);
  describeActivity(req, {
    entityId: assignment.id,
    description: `Unassigned subject ${assignment.subject_id} from class ${assignment.class_id}`,
    metadata: { class_id: assignment.class_id },
  });
  return ApiResponse.noContent(res);
}

async function listTeachers(req, res) {
  const { rows } = await service.listTeacherAssignments(req, req.params.id);
  return ApiResponse.ok(res, { assignments: rows });
}

async function assignTeacher(req, res) {
  const assignment = await service.assignTeacher(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: assignment.id,
    description: `Assigned teacher ${assignment.teacher_id} to subject ${assignment.subject_id}`,
    metadata: { teacher_id: assignment.teacher_id, class_id: assignment.class_id },
  });
  return ApiResponse.created(res, { assignment }, { message: 'Teacher assigned to subject' });
}

async function unassignTeacher(req, res) {
  const assignment = await service.unassignTeacher(req, req.params.id, req.params.assignmentId);
  describeActivity(req, {
    entityId: assignment.id,
    description: `Unassigned teacher ${assignment.teacher_id} from subject ${assignment.subject_id}`,
    metadata: { teacher_id: assignment.teacher_id },
  });
  return ApiResponse.noContent(res);
}

module.exports = {
  list,
  show,
  create,
  update,
  destroy,
  listClasses,
  assignClass,
  unassignClass,
  listTeachers,
  assignTeacher,
  unassignTeacher,
};
