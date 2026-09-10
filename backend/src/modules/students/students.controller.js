'use strict';

const service = require('./students.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');
const { sendStoredFile } = require('../../utils/fileResponse');
const ApiError = require('../../utils/ApiError');

function label(student) {
  return [student.first_name, student.last_name].filter(Boolean).join(' ');
}

async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req, req.query, pagination);
  /* Known Issues #26 — the stored path is suppressed on every row, not only on a read by id. */
  return ApiResponse.paginated(res, { ...result, rows: result.rows.map(service.present) }, pagination);
}

async function show(req, res) {
  const student = await service.findById(req, req.params.id);
  return ApiResponse.ok(res, { student: service.present(student) });
}

async function create(req, res) {
  const student = await service.create(req, req.body);
  describeActivity(req, {
    entityId: student.id,
    description: `Admitted student ${label(student)}`,
    metadata: {
      school_id: student.school_id,
      student_id: student.student_id,
      class_id: student.class_id,
      section_id: student.section_id,
    },
  });
  return ApiResponse.created(res, { student: service.present(student) }, { message: 'Student admitted' });
}

async function update(req, res) {
  const student = await service.update(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: student.id,
    description: `Updated student ${label(student)}`,
    metadata: { school_id: student.school_id, fields: Object.keys(req.body) },
  });
  return ApiResponse.ok(res, { student: service.present(student) }, { message: 'Student updated' });
}

async function promote(req, res) {
  const student = await service.promote(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: student.id,
    description: `Promoted student ${label(student)}`,
    metadata: {
      school_id: student.school_id,
      previous_class_id: student.previous_class_id,
      class_id: student.class_id,
    },
  });
  return ApiResponse.ok(res, { student: service.present(student) }, { message: 'Student promoted' });
}

async function transfer(req, res) {
  const student = await service.transfer(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: student.id,
    description: `Transferred student ${label(student)}`,
    metadata: { school_id: student.school_id, transfer_to: student.transfer_to },
  });
  return ApiResponse.ok(res, { student: service.present(student) }, { message: 'Student transferred' });
}

async function leave(req, res) {
  const student = await service.leave(req, req.params.id, req.body);
  describeActivity(req, {
    entityId: student.id,
    description: `Marked student ${label(student)} as left`,
    metadata: { school_id: student.school_id, leaving_reason: student.leaving_reason },
  });
  return ApiResponse.ok(res, { student: service.present(student) }, { message: 'Student marked as left' });
}

/**
 * FR-STUDENT-001 — *"System captures Student Photo."*
 *
 * The metadata records that a photo was set and what the file was called, never where it was put.
 */
async function setPhoto(req, res) {
  const student = await service.setPhoto(req, req.params.id);
  describeActivity(req, {
    entityId: student.id,
    description: `Set the photo for student ${label(student)}`,
    metadata: {
      school_id: student.school_id,
      student_id: student.student_id,
      file_name: req.file ? req.file.originalname : null,
    },
  });
  return ApiResponse.ok(res, { student: service.present(student) }, { message: 'Student photo updated' });
}

/**
 * FR-STUDENT-001's photo, read back — Known Issues #32.
 *
 * The column had exactly one writer and no reader: `present()` deletes `photo_path` and returns
 * `has_photo`, `sendStoredFile` had three callers and students was not one, and the ID card builds its
 * payload from the record rather than from the file. So `POST /:id/photo` set a flag and wrote bytes to
 * disk that nothing in the application could display.
 *
 * `findById(req, ...)` is the same load `show` uses, so the tenant boundary that decides which students
 * a caller may see decides which photos they may see, with no second rule to maintain — the shape
 * `payments.screenshot` established for FR-BILL-004.
 *
 * Served `inline`: a photo belongs beside the record, not in a downloads folder. The filename carries
 * the school's own `student_id` rather than the primary key, because that is the number the school uses
 * and the primary key is not theirs to learn.
 *
 * A student with no photo is a **404 with a message**, not an empty 200: `has_photo` already tells a
 * caller whether to ask, so a request that arrives anyway is asking for something that is not there.
 */
async function photo(req, res) {
  const student = await service.findById(req, req.params.id, req.query && req.query.school_id);
  if (!student.photo_path) throw ApiError.notFound('This student has no photo');

  describeActivity(req, {
    entityId: student.id,
    description: `Viewed the photo for student ${label(student)}`,
    metadata: { school_id: student.school_id, student_id: student.student_id },
  });

  return sendStoredFile(res, student.photo_path, {
    filename: `student-photo-${student.student_id}`,
    inline: true,
    schoolId: student.school_id,
  });
}

/** FR-STUDENT-001 "Documents" — the owner's decision D13. */
async function addDocuments(req, res) {
  const { student, documents } = await service.addDocuments(req, req.params.id);
  describeActivity(req, {
    entityId: student.id,
    description: `Uploaded ${documents.length} document(s) to student ${label(student)}`,
    metadata: {
      school_id: student.school_id,
      student_id: student.student_id,
      document_ids: documents.map((doc) => doc.id),
    },
  });
  return ApiResponse.created(
    res,
    { documents },
    { message: `${documents.length} document(s) added to the student's record` }
  );
}

async function documents(req, res) {
  const result = await service.listDocuments(req, req.params.id, req.query && req.query.school_id);
  return ApiResponse.ok(res, { documents: result.documents });
}

/**
 * Served as an attachment under its own file name — a certificate is a thing to save, unlike the
 * photo, which belongs beside the record. A read, so it is described rather than logged as a change.
 */
async function documentFile(req, res) {
  const { student, document } = await service.findDocument(
    req,
    req.params.id,
    req.params.documentId,
    req.query && req.query.school_id
  );
  describeActivity(req, {
    entityId: student.id,
    description: `Viewed document "${document.title}" of student ${label(student)}`,
    metadata: { school_id: student.school_id, student_id: student.student_id, document_id: document.id },
  });
  return sendStoredFile(res, document.file_path, {
    filename: document.file_name || `student-document-${document.id}`,
    inline: false,
    schoolId: student.school_id,
  });
}

module.exports = {
  list,
  show,
  create,
  update,
  setPhoto,
  photo,
  addDocuments,
  documents,
  documentFile,
  promote,
  transfer,
  leave,
};
