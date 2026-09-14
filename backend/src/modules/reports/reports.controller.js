'use strict';

/**
 * Report controllers — SRS §22, FR-REPORT-001 and FR-REPORT-002.
 *
 * One handler factory rather than seven near-identical handlers: every report differs only in which
 * builder runs, and seven copies of the same format branch is seven places for an export bug.
 *
 * These are the first handlers in this application that can answer with something other than JSON.
 * `ApiResponse` has no non-JSON path — every response it has ever produced went through
 * `res.status().json()` — so the Excel branch sets its own Content-Type and sends a Buffer directly.
 * That is stated here because it is a deliberate departure from the envelope every other module uses,
 * and a reader should not have to infer it.
 */

const service = require('./reports.service');
const ApiResponse = require('../../utils/ApiResponse');
const { describeActivity } = require('../../middlewares/activityLog');
const { REPORT_FORMATS, ACTIVITY_ACTIONS } = require('../../config/constants');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_MIME = 'application/pdf';

/** `report-<type>-<yyyy-mm-dd>.xlsx`, dated from the response rather than from the caller. */
/** What each exportable format is sent as. JSON is not here: it is the un-exported form. */
const EXPORTS = Object.freeze({
  [REPORT_FORMATS.EXCEL]: { mime: XLSX_MIME, ext: 'xlsx', label: 'Excel', render: 'toExcel' },
  [REPORT_FORMATS.PDF]: { mime: PDF_MIME, ext: 'pdf', label: 'PDF', render: 'toPdf' },
});

function filenameFor(type, format = REPORT_FORMATS.EXCEL) {
  const stamp = new Date().toISOString().slice(0, 10);
  const spec = EXPORTS[format];
  return `report-${type}-${stamp}.${spec ? spec.ext : 'bin'}`;
}

/**
 * @param {string} type  one of `REPORT_TYPES`
 * @returns {import('express').RequestHandler}
 */
function handlerFor(type) {
  return async function reportHandler(req, res) {
    const report = await service.build(type, req, req.query);

    /*
     * One branch for both exportable formats, driven by `EXPORTS`. Excel and PDF differ only in a
     * MIME type, an extension and which service function renders the rows — and since both render
     * from the same `toRows()` walk, keeping the response path shared as well means there is no
     * place for the two to drift apart.
     */
    const spec = EXPORTS[req.query.format];
    if (!spec) {
      /*
       * A screen read is a **view**, and says so.
       *
       * `reports.routes.js` annotates every report route `action: 'export'`, which is right for the
       * file branch and wrong for this one: a request that rendered JSON into a screen was recorded as
       * an export, with no description, so the trail read "Export · No description" for someone who
       * had only looked. An audit trail that overstates what happened is worse than one that says
       * nothing — it accuses. The route's annotation cannot tell the two apart, because the format is
       * a query parameter it never reads; here, where the branch is taken, it is known.
       */
      describeActivity(req, {
        action: ACTIVITY_ACTIONS.VIEW,
        description: `Viewed the ${type} report`,
        metadata: { report: type },
      });
      return ApiResponse.ok(res, { report });
    }

    const buffer = await service[spec.render](report);
    /*
     * A report that leaves the building as a file is a different event from one a client rendered on
     * screen — FR-REPORT-002 is a requirement of its own, and this is where it is observable.
     */
    describeActivity(req, {
      description: `Exported the ${type} report as ${spec.label}`,
      metadata: { report: type, format: req.query.format, bytes: buffer.length },
    });
    res.setHeader('Content-Type', spec.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filenameFor(type, req.query.format)}"`);
    return res.status(200).send(Buffer.from(buffer));
  };
}

module.exports = { handlerFor, filenameFor, XLSX_MIME, PDF_MIME, EXPORTS };
