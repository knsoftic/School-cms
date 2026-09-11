'use strict';

/**
 * Document controllers — SRS §20.5, FR-DOC-001.
 *
 * Every handler returns `service.present()`, so `file_path` cannot leak through a response. It is null —
 * a document is rendered on request and never stored — and suppressed anyway, so no future writer of
 * the column could put a path in a response.
 *
 * The activity metadata records **which** document was generated and for whom, never the assembled
 * `generation_payload`: that payload carries a student's date of birth and guardian's name, and an
 * activity row is read by anyone who can read the trail.
 */

const service = require('./documents.service');
const ApiResponse = require('../../utils/ApiResponse');
const { getPagination } = require('../../utils/pagination');
const { describeActivity } = require('../../middlewares/activityLog');
const { schoolBrand } = require('../../utils/schoolScope');
const { REPORT_FORMATS } = require('../../config/constants');

async function list(req, res) {
  const pagination = getPagination(req);
  const result = await service.list(req, req.query, pagination);
  return ApiResponse.paginated(res, result, pagination);
}

const PDF_MIME = 'application/pdf';

async function show(req, res) {
  const row = await service.findById(req, req.params.id);

  /*
   * FR-DOC-001's PDF half — Phase 5.4.
   *
   * Rendered from `generation_payload`, the snapshot taken when the document was generated, so a
   * certificate reissued a year later says what it said when it was issued rather than what the
   * student's row holds now. That is what storing the payload was for.
   *
   * Streamed as a Buffer, so `documents.file_path` stays null: §22 established that an export needs
   * no file on disk, and persisting a document is a separate decision from rendering one.
   */
  if (req.query.format === REPORT_FORMATS.PDF) {
    /*
     * Headed with the name the payload snapshotted — the school's display name when it was issued
     * (D35) — rather than today's platform record, for the reason above. A document generated before
     * the snapshot carried one falls back to the school's current name.
     */
    const payload = row.generation_payload || {};
    const snapped = payload.school && payload.school.name;
    const brand = snapped ? null : await schoolBrand(row.school_id);
    const buffer = await service.toPdf(row, { schoolName: snapped || (brand ? brand.name : undefined) });
    describeActivity(req, {
      entityId: row.id,
      description: `Exported ${row.document_type} as PDF`,
      metadata: { document_type: row.document_type, bytes: buffer.length },
    });
    res.setHeader('Content-Type', PDF_MIME);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${row.document_type}-${row.id}.pdf"`
    );
    return res.status(200).send(buffer);
  }

  return ApiResponse.ok(res, { document: service.present(row) });
}

/** FR-DOC-001 — generate. */
async function generate(req, res) {
  const row = await service.generate(req, req.body);
  describeActivity(req, {
    entityId: row.id,
    description: `Generated a ${row.title} for ${row.owner_type} ${row.owner_id}`,
    metadata: {
      school_id: row.school_id,
      document_type: row.document_type,
      owner_type: row.owner_type,
      owner_id: row.owner_id,
      /* Whether a payload was assembled, never the payload — it holds personal detail. */
      has_payload: Boolean(row.generation_payload),
    },
  });
  return ApiResponse.created(res, { document: service.present(row) }, { message: 'Document generated' });
}

/** GET /pickers/teachers and /pickers/exams — D34's pick-lists for the generate dialog. */
async function pickTeachers(req, res) {
  return ApiResponse.ok(res, { teachers: await service.pickTeachers(req, req.query) });
}

async function pickExams(req, res) {
  return ApiResponse.ok(res, { exams: await service.pickExams(req, req.query) });
}

module.exports = { list, show, generate, pickTeachers, pickExams, PDF_MIME };
