'use strict';

/**
 * PDF rendering — Phase 5.4. SRS §19.3 (result cards), §20.5 (documents) and §22 (report export).
 *
 * `pdfkit` has been a dependency since `package.json` was written and required by nothing, and two
 * modules carry comments saying exactly that. The reason it stayed unused is recorded in
 * `reports.service.js`: *"it draws primitives: a report PDF needs a table engine, column widths,
 * headers and pagination written from nothing."* This file is that engine.
 *
 * ## What this is, and what it deliberately is not
 *
 * `renderDocument()` composes **four optional blocks** in a fixed order, and returns a **Buffer**:
 *
 * | Block | What it is for | Who needs it |
 * |---|---|---|
 * | `details` | label/value pairs, two to a line | ID cards, admission forms, a result card's identity |
 * | `body` | justified prose paragraphs | §20.5's two certificates, which are letters |
 * | `columns` + `rows` | a table with a repeating header | §22's reports, a result card's subjects |
 * | `summary` | label/value pairs again, below | totals a reader looks at afterwards |
 *
 * It grew that way rather than being designed that way, and each block was added when a real document
 * needed it: the table for §22, details and summary for §19.3's result card, prose for §20.5's
 * certificates. Nothing here is speculative.
 *
 * It is still **not a layout library**. There is no positioning, no multi-column flow, no images and
 * no template language, because no requirement has asked for one.
 *
 * `renderTable()` remains as the narrower entry point: it requires at least one column, so a caller
 * asking for a table and getting a blank page is refused rather than silently served.
 *
 * It is not a layout library. §22 proved the useful half of the pattern already: an export needs no
 * file on disk, no upload profile, no storage accounting and none of the file-serving infrastructure
 * this application still does not have — `exceljs` returns a Buffer and the controller sets a
 * Content-Type. A PDF works the same way, which is why this can ship before there is any route that
 * serves a stored file.
 *
 * ## Why a Buffer and not a stream to disk
 *
 * The same reason §22 gave: nothing here needs to persist. `results.result_card_path` and
 * `documents.file_path` exist for when something does, and both are still null — writing to them
 * means the upload/serving story, which is a separate job from rendering.
 *
 * ## The settle order is deliberate
 *
 * `doc.on('end')` is attached **before** `doc.end()` is called, and the promise is created before any
 * drawing happens. This file's sibling in `src/jobs/tasks/databaseBackup.js` shipped with the
 * opposite mistake — a listener attached after the event could already have fired — and the symptom
 * was the worst kind: a complete artefact produced, no error raised, and the process exiting 0
 * having reported nothing. Attaching first is what makes that impossible here.
 */

const DEFAULTS = Object.freeze({
  size: 'A4',
  margin: 44,
  titleSize: 16,
  subtitleSize: 9,
  headerSize: 9,
  bodySize: 9,
  rowPadding: 5,
  minRowHeight: 16,
});

/** Everything drawn uses a core font, so no file has to be found, read or licensed at runtime. */
const FONT = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';

const RULE = '#999999';
const HEADER_FILL = '#eeeeee';
const MUTED = '#555555';

/** Cells are text. A number, a date or a null becomes a string here rather than at forty call sites. */
function cell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Render a titled table to a PDF Buffer.
 *
 * @param {object} spec
 * @param {string} spec.title                    the document heading
 * @param {string} [spec.subtitle]               a line under it — school, window, generated-at
 * @param {Array<{key:string,header:string,width:number}>} spec.columns
 *        `width` is a share, not a measurement: the columns are scaled to the printable width, so a
 *        caller never has to know the page size or the margins.
 * @param {Array<object>} spec.rows              plain objects keyed by `columns[].key`
 * @param {Array<{label:string,value:*}>} [spec.details]
 *        A label/value block drawn **above** the table. A report does not need one; a result card
 *        does — school, exam, student and roll number are identity, not rows, and putting them in
 *        the table would make them sort and paginate alongside the subjects.
 * @param {Array<{label:string,value:*}>} [spec.summary]
 *        The same block drawn **below** the table, for totals a reader looks at after the detail —
 *        percentage, grade, position.
 * @param {string} [spec.footer]                 drawn on every page beside the page number
 * @param {object} [options]                     overrides for DEFAULTS; used by the suite
 * @returns {Promise<Buffer>}
 */
function renderDocument(spec, options = {}) {
  /* eslint-disable-next-line global-require */
  const PDFDocument = require('pdfkit');

  const opts = { ...DEFAULTS, ...options };
  const columns = (spec.columns || []).filter((c) => c && c.key);
  const hasTable = columns.length > 0;

  const doc = new PDFDocument({
    size: opts.size,
    margin: opts.margin,
    info: { Title: spec.title || 'Report', Creator: 'School Management System' },
  });

  /*
   * Collected and settled BEFORE anything is drawn — see the header. `error` is wired at the same
   * time so a failure mid-render rejects rather than producing a truncated Buffer that looks fine.
   */
  const chunks = [];
  const finished = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = opts.margin;
  const right = doc.page.width - opts.margin;
  const bottom = doc.page.height - opts.margin;
  const printable = right - left;

  /* Shares scaled to the printable width, so `width: 1, 2, 1` means a quarter, a half, a quarter. */
  const totalShare = columns.reduce((sum, c) => sum + (Number(c.width) || 1), 0) || 1;
  const widths = columns.map((c) => ((Number(c.width) || 1) / totalShare) * printable);
  const xs = widths.reduce((acc, w, i) => {
    acc.push(i === 0 ? left : acc[i - 1] + widths[i - 1]);
    return acc;
  }, []);

  let page = 1;

  /**
   * The footer, drawn *below* the text area.
   *
   * `doc.page.margins.bottom` is zeroed for the duration and restored afterwards. Without that,
   * pdfkit's `text()` sees a y past the bottom margin and **adds a page** to hold it — so every
   * document came out with one extra, blank-but-for-the-footer page, and a five-row table reported
   * two pages. That is the documented way to draw a footer, and the bug it fixes is invisible in the
   * bytes: the PDF is perfectly valid, just wrong.
   */
  const drawPageFurniture = () => {
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = bottom + 10;
    doc.font(FONT).fontSize(8).fillColor(MUTED);
    if (spec.footer) doc.text(cell(spec.footer), left, y, { width: printable * 0.7, lineBreak: false });
    doc.text(`Page ${page}`, left, y, { width: printable, align: 'right', lineBreak: false });
    doc.fillColor('black');
    doc.page.margins.bottom = savedBottom;
  };

  const drawHeaderRow = (y) => {
    const height = opts.minRowHeight + opts.rowPadding;
    doc.rect(left, y, printable, height).fill(HEADER_FILL);
    doc.fillColor('black').font(FONT_BOLD).fontSize(opts.headerSize);
    columns.forEach((column, i) => {
      doc.text(cell(column.header || column.key), xs[i] + 4, y + opts.rowPadding, {
        width: widths[i] - 8,
        lineBreak: false,
        ellipsis: true,
      });
    });
    doc.moveTo(left, y + height).lineTo(right, y + height).strokeColor(RULE).stroke();
    return y + height;
  };

  /* ── the title block, once, on the first page only ── */

  let y = opts.margin;
  doc.font(FONT_BOLD).fontSize(opts.titleSize).fillColor('black')
    .text(cell(spec.title || 'Report'), left, y, { width: printable });
  y = doc.y + 2;

  if (spec.subtitle) {
    doc.font(FONT).fontSize(opts.subtitleSize).fillColor(MUTED)
      .text(cell(spec.subtitle), left, y, { width: printable });
    y = doc.y + 2;
    doc.fillColor('black');
  }

  /**
   * A label/value block, two pairs to a line.
   *
   * Not a table: these are identity and totals, and a reader scans them rather than comparing them
   * down a column. Drawn only on the page it starts on — a result card's header repeating on page
   * three would be noise, unlike the column header, which is what makes page three readable.
   */
  const drawPairs = (pairs, startY) => {
    let cursor = startY;
    const half = printable / 2;
    pairs.forEach((pair, i) => {
      const column = i % 2;
      const x = left + column * half;
      if (column === 0 && i > 0) cursor += opts.minRowHeight;
      doc.font(FONT_BOLD).fontSize(opts.bodySize).fillColor(MUTED)
        .text(`${cell(pair.label)}: `, x, cursor, { width: half - 8, continued: true });
      doc.font(FONT).fillColor('black').text(cell(pair.value));
    });
    return cursor + opts.minRowHeight + 4;
  };

  if (Array.isArray(spec.details) && spec.details.length) {
    y += 4;
    y = drawPairs(spec.details, y);
    doc.moveTo(left, y).lineTo(right, y).strokeColor(RULE).stroke();
    y += 6;
  }

  /*
   * Prose, for the documents that are not tables.
   *
   * §20.5's Character Certificate and Leaving Certificate are letters — sentences about a person,
   * not columns — and forcing them into a table would produce something nobody would sign. Each
   * paragraph wraps to the printable width and breaks to a new page when it no longer fits, because
   * a certificate cut in half is worse than one on two pages.
   */
  if (Array.isArray(spec.body) && spec.body.length) {
    doc.font(FONT).fontSize(opts.bodySize + 1).fillColor('black');
    for (const paragraph of spec.body) {
      const text = cell(paragraph);
      const height = doc.heightOfString(text, { width: printable, align: 'justify' });
      if (y + height > bottom) {
        drawPageFurniture();
        doc.addPage();
        page += 1;
        y = opts.margin;
      }
      doc.text(text, left, y, { width: printable, align: 'justify' });
      y = doc.y + 10;
    }
    doc.fontSize(opts.bodySize);
  }

  if (hasTable) {
    y += 6;
    y = drawHeaderRow(y);
  }

  /* ── the rows ── */

  doc.font(FONT).fontSize(opts.bodySize);

  for (const row of (hasTable ? spec.rows || [] : [])) {
    const texts = columns.map((column) => cell(row[column.key]));

    /*
     * Height is measured from the wrapped text, not assumed. A long value in a narrow column is the
     * case that makes a fixed row height overlap the next row, and reports contain free text.
     */
    const heights = texts.map((text, i) => doc.heightOfString(text, { width: widths[i] - 8 }));
    const rowHeight = Math.max(opts.minRowHeight, ...heights) + opts.rowPadding;

    if (y + rowHeight > bottom) {
      drawPageFurniture();
      doc.addPage();
      page += 1;
      y = opts.margin;
      /* Repeated on every page: a table whose header appears once is unreadable from page two on. */
      y = drawHeaderRow(y);
      doc.font(FONT).fontSize(opts.bodySize);
    }

    texts.forEach((text, i) => {
      doc.text(text, xs[i] + 4, y + opts.rowPadding / 2, { width: widths[i] - 8 });
    });

    y += rowHeight;
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#dddddd').stroke();
  }

  /*
   * The summary block, below the table. It breaks to a new page if it does not fit, rather than
   * being drawn over the footer — the totals are the part of a result card a reader most needs, so
   * silently overlapping them would be the worst place to save a page.
   */
  if (Array.isArray(spec.summary) && spec.summary.length) {
    const needed = Math.ceil(spec.summary.length / 2) * opts.minRowHeight + 20;
    if (y + needed > bottom) {
      drawPageFurniture();
      doc.addPage();
      page += 1;
      y = opts.margin;
    }
    y += 8;
    drawPairs(spec.summary, y);
  }

  drawPageFurniture();
  doc.end();

  return finished;
}

/**
 * A table, specifically. Keeps the original contract — at least one column — because a caller asking
 * for a table and getting a blank page instead is a defect the general form cannot detect for them.
 * `renderDocument()` is the one to reach for when the document may have no table at all.
 */
function renderTable(spec, options = {}) {
  if (!(spec.columns || []).filter((c) => c && c.key).length) {
    throw new Error('renderTable() requires at least one column');
  }
  return renderDocument(spec, options);
}

module.exports = { renderDocument, renderTable, cell, DEFAULTS };
