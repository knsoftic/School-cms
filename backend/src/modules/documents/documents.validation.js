'use strict';

/**
 * Document schemas — SRS §20.5, FR-DOC-001.
 *
 * FR-DOC-001 is one requirement covering **seven** documents: Student ID Card, Teacher ID Card,
 * Admission Form, Fee Receipt, Result Card, Character Certificate and Leaving Certificate. Its stated
 * precondition is that *"the relevant underlying record exists (e.g. student, fee payment, exam
 * result)"*, so a request names a **type** and an **owner id**, and everything else about the row is the
 * system's.
 *
 * ## `owner_type` is not a caller's choice
 *
 * Each of the seven documents is about exactly one kind of record — an ID card for a teacher is about a
 * teacher and nothing else — so `owner_type` is derived from `document_type` in the service and
 * `forbidden()` here. A caller who could set the pair independently could ask for a Teacher ID Card
 * against a student id and get a row that means nothing. This is the same doctrine §20.3 applies to
 * `record_type`.
 *
 * ## Every file column is refused
 *
 * `file_path`, `file_name`, `mime_type` and `file_size_bytes` are the system's, and §20.5 writes none of
 * them — a document is rendered on request and never stored. Refusing them rather than ignoring them keeps this module out of
 * Known Issues #26, which records five columns elsewhere that still accept a caller-supplied path.
 *
 * `is_generated`, `generated_at`, `generation_payload` and `uploaded_by` are refused for the same
 * reason: a caller who could write the payload could make the record claim it reproduces something it
 * never read.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const {
  DOCUMENT_TYPES, DOCUMENT_TYPE_LIST, DOCUMENT_OWNER_TYPES, REPORT_FORMATS,
} = require('../../config/constants');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

const fields = {
  school_id: Joi.number().integer().min(1),
  document_type: Joi.string().valid(...DOCUMENT_TYPE_LIST),
  owner_id: Joi.number().integer().min(1),
  title: Joi.string().trim().min(1).max(255),
  description: Joi.string().trim().max(255).empty('').allow(null),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const owned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
  owner_type: forbiddenField('"owner_type" is decided by the document type, not by the body'),
  file_path: forbiddenField('"file_path" is written by the generator, never from a request body'),
  file_name: forbiddenField('"file_name" is written by the generator, never from a request body'),
  mime_type: forbiddenField('"mime_type" is written by the generator, never from a request body'),
  file_size_bytes: forbiddenField('"file_size_bytes" is measured from the generated file'),
  is_generated: forbiddenField('"is_generated" records how the row was made'),
  generated_at: forbiddenField('"generated_at" is stamped when the document is generated'),
  generation_payload: forbiddenField(
    '"generation_payload" is assembled from the underlying record, so the document can be reproduced'
  ),
  uploaded_by: forbiddenField('"uploaded_by" is taken from the authenticated user'),
};

/**
 * FR-DOC-001 — generate.
 *
 * A **Result Card is the one document that is not about a record on its own**: §19 makes a result the
 * intersection of a student and an exam, and `documents` has one `owner_id`. The student is the owner
 * and the exam is named here, required for that type and refused for every other, so a request cannot
 * carry an exam id that nothing will read.
 */
const generate = Joi.object({
  school_id: fields.school_id,
  document_type: fields.document_type.required(),
  owner_id: fields.owner_id.required(),
  exam_id: Joi.number()
    .integer()
    .min(1)
    .when('document_type', {
      is: DOCUMENT_TYPES.RESULT_CARD,
      then: Joi.required(),
      otherwise: Joi.forbidden().messages({
        'any.unknown': '"exam_id" belongs to a result card; no other document reads it',
      }),
    }),
  /* Defaulted from the type and the owner when absent, so a caller never has to name one. */
  title: fields.title,
  description: fields.description,
  reason: fields.reason,
  ...owned,
});

const list = listQuery(
  Joi.object({
    school_id: fields.school_id,
    document_type: fields.document_type,
    owner_type: Joi.string().valid(...Object.values(DOCUMENT_OWNER_TYPES)),
    owner_id: fields.owner_id,
    /*
     * Only `true` is accepted: this module lists generated documents alone, and an upload is read on
     * its student's record (owner decision D13). `false` is refused rather than silently answered with
     * generated rows, so a caller asking for uploads learns where they are.
     */
    is_generated: Joi.boolean().valid(true).messages({
      'any.only': 'Uploaded documents are listed on their student\'s record (GET /students/:id/documents), not here',
    }),
  })
);

/**
 * FR-DOC-001's read, with the export Phase 5.4 added.
 *
 * **json and pdf only.** §20.5 says *"Generate"* and names no format at all, so the two offered
 * here are the JSON reproduction that already existed and the rendered document a generated
 * document is for. Excel is not offered: a certificate is not a spreadsheet, and §22's having one
 * is not a reason to invent one here. `print` is refused for the reason it is everywhere else —
 * there is no view engine in this application.
 */
const DOCUMENT_FORMATS = Object.freeze([REPORT_FORMATS.JSON, REPORT_FORMATS.PDF]);

const showQuery = Joi.object({
  school_id: fields.school_id,
  format: Joi.string().valid(...DOCUMENT_FORMATS).default(REPORT_FORMATS.JSON),
});

/** D34's pick-lists: a search term and a cap, never more than fifty. */
const pickerQuery = Joi.object({
  school_id: fields.school_id,
  q: Joi.string().trim().max(100).empty(''),
  limit: Joi.number().integer().min(1).max(50),
});

module.exports = {
  schemas: { generate, list, showQuery, pickerQuery, idParam: commonSchemas.idParam, DOCUMENT_FORMATS },
  fields,
};
