'use strict';

const service = require('./homework.service');
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
  return ApiResponse.ok(res, { homework: service.present(row) });
}

async function create(req, res) {
  const row = await service.create(req, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: `Set homework "${row.title}" due ${row.due_date}`,
    metadata: {
      school_id: row.school_id,
      class_id: row.class_id,
      section_id: row.section_id,
      subject_id: row.subject_id,
      due_date: row.due_date,
      /* Whether a file came with it, never where it was put. */
      has_attachment: Boolean(row.attachment_path),
    },
  });
  return ApiResponse.created(res, { homework: service.present(row) }, { message: 'Homework created' });
}

async function update(req, res) {
  const row = await service.update(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: `Updated homework "${row.title}"`,
    metadata: { school_id: row.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { homework: service.present(row) }, { message: 'Homework updated' });
}

/**
 * FR-HW-001's attachment — the file half of *"Homework is available to the relevant class/students."*
 *
 * The row is loaded through `findById()`, which already applies the router's permission and tenant
 * guards and `selfScopePlacements()` — so a student gets their own class's (and section's) published
 * homework and nothing else, and the file inherits every one of those rules without restating any of them.
 *
 * `attachment_name` is the name the teacher's browser sent; the stored name is random hex and would
 * mean nothing to whoever downloads it.
 */
async function attachment(req, res) {
  const row = await service.findById(req, req.params.id);
  if (!row.attachment_path) throw ApiError.notFound('This homework has no attachment');

  describeActivity(req, {
    entityId: row.id,
    description: `Downloaded the attachment for "${row.title}"`,
    /* What was fetched, never where it lives on disk. */
    metadata: { school_id: row.school_id, class_id: row.class_id },
  });
  return sendStoredFile(res, row.attachment_path, {
    filename: row.attachment_name, schoolId: row.school_id,
  });
}

module.exports = { list, show, create, update, attachment };
