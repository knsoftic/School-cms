'use strict';

/**
 * Assignment controllers — SRS §20.3, FR-ASG-001.
 *
 * Every handler returns `service.present()`, so the stored attachment path cannot leak through a
 * response by somebody forgetting it on one route out of seven.
 *
 * The activity descriptions never carry a stored path either — only whether a file was attached. §20.2
 * set that precedent; a metadata blob is a response too.
 */

const service = require('./assignments.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');
const ApiError = require('../../utils/ApiError');
const { sendStoredFile } = require('../../utils/fileResponse');

async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function show(req, res) {
  const row = await service.findById(req, req.params.id);
  return ApiResponse.ok(res, { assignment: service.present(row) });
}

/** FR-ASG-001, step one — the teacher creates. */
async function create(req, res) {
  const row = await service.create(req, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: `Created assignment "${row.title}"${row.due_date ? ` due ${row.due_date}` : ''}`,
    metadata: {
      school_id: row.school_id,
      class_id: row.class_id,
      section_id: row.section_id,
      subject_id: row.subject_id,
      due_date: row.due_date,
      status: row.status,
    },
  });
  return ApiResponse.created(res, { assignment: service.present(row) }, { message: 'Assignment created' });
}

async function update(req, res) {
  const row = await service.update(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: `Updated assignment "${row.title}"`,
    metadata: { school_id: row.school_id, status: row.status, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { assignment: service.present(row) }, { message: 'Assignment updated' });
}

async function listSubmissions(req, res) {
  const pagination = getPagination(req);
  const result = await service.listSubmissions(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

async function showSubmission(req, res) {
  const row = await service.findSubmissionById(req, req.params.id);
  return ApiResponse.ok(res, { submission: service.present(row) });
}

/**
 * The file on an assignment or on a submission — FR-ASG-001's *"Teacher reviews the submission."*
 *
 * **Only submissions carry a file.** The SUBMISSION upload profile is wired to `POST /:id/submissions`
 * alone, and the write stamps `record_type: SUBMISSION` — so a teacher's assignment row can never
 * have an `attachment_path`. A `GET /:id/attachment` beside this one was written and then removed for
 * exactly that reason: it would have been a route for a file that cannot exist, 404ing for ever while
 * looking like a feature.
 *
 * `findSubmissionById` filters on `record_type` and applies `selfScope()`, so a student fetches their
 * own submission and a teacher fetches the ones on their own classes' assignments — neither can fetch
 * anyone else's, because that rule already exists and this route does not restate it.
 *
 * Attaching the file to `/submissions/:id` rather than to a shared `/files/:id` is what makes that
 * true. A generic route would need its own rule, and there is no file permission in §29's fixed
 * catalogue to build one from.
 */
async function submissionAttachment(req, res) {
  const row = await service.findSubmissionById(req, req.params.id);
  if (!row.attachment_path) throw ApiError.notFound('This submission has no attachment');

  describeActivity(req, {
    entityId: row.id,
    description: 'Downloaded a submission attachment',
    metadata: { school_id: row.school_id, record_type: row.record_type },
  });
  return sendStoredFile(res, row.attachment_path, {
    filename: row.attachment_name, schoolId: row.school_id,
  });
}

/**
 * FR-ASG-001, step two — the student submits.
 *
 * 201 on a first submission, 200 when a returned one is replaced in place. The unique index permits a
 * single row per student per assignment, so the second attempt is not a creation and should not claim
 * to be one.
 */
async function submit(req, res) {
  const { row, isNew } = await service.submit(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: isNew
      ? `Submitted assignment ${row.parent_assignment_id}`
      : `Resubmitted assignment ${row.parent_assignment_id} after it was returned`,
    metadata: {
      school_id: row.school_id,
      assignment_id: row.parent_assignment_id,
      student_id: row.student_id,
      is_late: row.is_late,
      /* Whether a file came with it, never where it was put. */
      has_attachment: Boolean(row.attachment_path),
    },
  });
  const body = { submission: service.present(row) };
  return isNew
    ? ApiResponse.created(res, body, { message: 'Assignment submitted' })
    : ApiResponse.ok(res, body, { message: 'Assignment resubmitted' });
}

/** FR-ASG-001, step three — the teacher reviews. */
async function review(req, res) {
  const row = await service.review(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: `Reviewed submission ${row.id} as "${row.submission_status}"`,
    metadata: {
      school_id: row.school_id,
      assignment_id: row.parent_assignment_id,
      student_id: row.student_id,
      submission_status: row.submission_status,
      marks_obtained: row.marks_obtained,
    },
  });
  return ApiResponse.ok(res, { submission: service.present(row) }, { message: 'Submission reviewed' });
}

module.exports = {
  submissionAttachment, list, show, create, update, listSubmissions, showSubmission, submit, review };
