'use strict';

const service = require('./timetable.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

/** §20.1 — the Class Timetable. */
async function classView(req, res) {
  const data = await service.classView(req, req.params.classId, req.query);
  return ApiResponse.ok(res, { timetable: data });
}

/** §20.1 — the Teacher Timetable. The same rows, asked a different question. */
async function teacherView(req, res) {
  const data = await service.teacherView(req, req.params.teacherId, req.query);
  return ApiResponse.ok(res, { timetable: data });
}

async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function show(req, res) {
  const entry = await service.findEntry(req, req.params.id);
  return ApiResponse.ok(res, { entry });
}

async function create(req, res) {
  const entry = await service.create(req, req.body);
  describeActivity(req, {
    entityId: entry.id,
    description: `Scheduled ${entry.day_of_week} period ${entry.period_number}${entry.room ? ` in ${entry.room}` : ''}`,
    metadata: {
      school_id: entry.school_id,
      class_id: entry.class_id,
      section_id: entry.section_id,
      day_of_week: entry.day_of_week,
      period_number: entry.period_number,
      teacher_id: entry.teacher_id,
    },
  });
  return ApiResponse.created(res, { entry }, { message: 'Timetable entry created' });
}

async function update(req, res) {
  const entry = await service.update(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: entry.id,
    description: `Rescheduled ${entry.day_of_week} period ${entry.period_number}`,
    metadata: { school_id: entry.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { entry }, { message: 'Timetable entry updated' });
}

module.exports = { classView, teacherView, list, show, create, update };
