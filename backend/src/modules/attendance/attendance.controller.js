'use strict';

const service = require('./attendance.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');

async function markStudents(req, res) {
  const { register, date, rows } = await service.markStudents(req, req.body);
  /*
   * The batch is the event, and this is the only trail it gets — see the service header for why a
   * per-row audit_logs entry would duplicate `marked_by`/`marked_at` at two hundred times the volume.
   */
  describeActivity(req, {
    entityId: register.classId,
    description: `Marked attendance for ${rows.length} student(s) on ${date}`,
    metadata: {
      class_id: register.classId,
      section_id: register.sectionId,
      attendance_date: date,
      count: rows.length,
      /*
       * The validator accepts a `reason` and the mark screen asks for one when correcting a register;
       * this row is the batch's only trail, so a reason not written here was taken and then dropped.
       */
      ...(req.body.reason ? { reason: req.body.reason } : {}),
    },
  });
  return ApiResponse.ok(res, { attendance: rows }, { message: 'Attendance recorded' });
}

async function listStudents(req, res) {
  const pagination = getPagination(req);
  const result = await service.listStudents(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function markTeachers(req, res) {
  const { date, rows } = await service.markTeachers(req, req.body);
  describeActivity(req, {
    entityId: rows.length ? rows[0].id : null,
    description: `Recorded attendance for ${rows.length} teacher(s) on ${date}`,
    metadata: {
      attendance_date: date,
      count: rows.length,
      ...(req.body.reason ? { reason: req.body.reason } : {}),
    },
  });
  return ApiResponse.ok(res, { attendance: rows }, { message: 'Teacher attendance recorded' });
}

async function listTeachers(req, res) {
  const pagination = getPagination(req);
  const result = await service.listTeachers(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function report(req, res) {
  const data = await service.report(req, req.query);
  return ApiResponse.ok(res, { report: data });
}

/** GET /mine — D17: the caller's own attendance, or each linked child's, for one period. */
async function mine(req, res) {
  const data = await service.mine(req, req.query);
  return ApiResponse.ok(res, { attendance: data });
}

module.exports = { markStudents, listStudents, markTeachers, listTeachers, report, mine };
