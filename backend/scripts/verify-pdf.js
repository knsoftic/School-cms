'use strict';

/**
 * Verification of Phase 5.4's renderer — `src/utils/pdf.js`.
 *
 * ## Why this is its own suite rather than a section of `verify-reports.js`
 *
 * Two reasons, and the second is the one that matters.
 *
 * `renderTable()` is a **shared utility**, not part of §22. §19.3's result cards and §20.5's seven
 * documents are the other two things Phase 5.4 was blocking, and both will render through this file;
 * a suite that only ever exercised it through the reports module would leave its contract described
 * by one caller.
 *
 * And **§22 cannot exercise it.** A deliberate regression pass over the reports suite found four
 * guards it could not provoke at all — the footer's pagination fix, the repeated header, the page
 * break itself and the measured row height — for one reason: the student report's fixture produces a
 * table that fits on a single page. Every one of those guards is about what happens on the *second*
 * page. That is the "fixture cannot reach the branch" failure §5a has now recorded four times, and
 * the answer here is not a bigger report fixture but a suite that drives the renderer directly with
 * as many rows as it takes.
 *
 * ## Reading a PDF back
 *
 * `pdf-parse` is a declared dependency and **cannot do it**: it fails with "Illegal character" on an
 * untouched `pdfkit` document, measured this session, so the fault is the parser's rather than the
 * renderer's. The content streams are therefore inflated with `zlib` and the hex-encoded operands of
 * pdfkit's `TJ` operators decoded — which is enough to prove the page really carries the text, not
 * merely that the bytes are a well-formed empty document.
 *
 * Run: node scripts/verify-pdf.js
 */

const zlib = require('zlib');

const { renderTable, cell, DEFAULTS } = require('../src/utils/pdf');

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${
      ok ? '' : `  (expected ${JSON.stringify(expected)})`
    }`
  );
}

/** Every hex-encoded string pdfkit wrote into a content stream, concatenated. */
function pdfText(buffer) {
  const raw = buffer.toString('latin1');
  const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const parts = [];
  let match = streams.exec(raw);
  while (match !== null) {
    try { parts.push(zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')); }
    catch (_) { /* not a deflate stream; nothing we need is in one */ }
    match = streams.exec(raw);
  }
  const body = parts.join('\n');
  return (body.match(/<([0-9A-Fa-f]+)>/g) || [])
    .map((hex) => Buffer.from(hex.slice(1, -1), 'hex').toString('latin1'))
    .join('');
}

/**
 * The page count, read from the page tree rather than by counting `/Type /Page`.
 *
 * That naive count is wrong: it also matches the `/Pages` node, so it over-reports by one and a
 * one-page document looks like two. `/Type /Pages … /Count N` is the document's own answer.
 */
function pdfPages(buffer) {
  const m = buffer.toString('latin1').match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

const COLUMNS = [
  { key: 'section', header: 'Section', width: 2 },
  { key: 'key', header: 'Key', width: 3 },
  { key: 'value', header: 'Value', width: 3 },
];

const rowsOf = (n, value = (i) => i * 3) => Array.from({ length: n }, (_, i) => ({
  section: 'summary', key: `key_${i}`, value: value(i),
}));

const render = (rows, extra = {}) => renderTable({
  title: 'Student Report', subtitle: 'Verify School — 2026-01-01 to 2026-12-31',
  columns: COLUMNS, rows, footer: 'School Management System', ...extra,
});

async function main() {
  console.log('\n── Part 1 — the bytes are a PDF ──\n');

  const small = await render(rowsOf(5));
  check('renderTable returns a Buffer', Buffer.isBuffer(small), true);
  check('  beginning with the PDF magic', small.slice(0, 5).toString(), '%PDF-');
  check('  and ending with the EOF marker, so it is not truncated',
    small.toString('latin1').trimEnd().endsWith('%%EOF'), true);

  console.log('\n── Part 2 — pagination, which §22 alone cannot reach ──\n');

  /*
   * The exact page counts, not ">= 1". A regression restoring the footer's pagination bug adds one
   * page to EVERY document, and only an exact count can see that: the footer is drawn below the text
   * area, and without zeroing the bottom margin first pdfkit adds a page to hold it.
   */
  const [p5, p30, p40, p120] = await Promise.all([
    render(rowsOf(5)), render(rowsOf(30)), render(rowsOf(40)), render(rowsOf(120)),
  ]);
  check('a short table is exactly one page — a footer that paginates would make it two',
    [pdfPages(p5), pdfPages(p30)], [1, 1]);
  check('  and a long one breaks onto further pages rather than losing rows',
    [pdfPages(p40), pdfPages(p120)], [2, 4]);

  /*
   * The header is drawn once per page. A table whose header appears only on page one is unreadable
   * from page two on, and counting the occurrences is the only way to see it — the document is
   * otherwise identical.
   */
  const headerCount = (buf) => (pdfText(buf).match(/Section/g) || []).length;
  check('the column header is repeated on every page, not just the first',
    [headerCount(p5), headerCount(p40), headerCount(p120)], [1, 2, 4]);

  check('every page is numbered', ['Page 1', 'Page 2', 'Page 3', 'Page 4']
    .filter((n) => !pdfText(p120).includes(n)), []);

  /* No row may be dropped by a page break — the first and last of 120 must both be on a page. */
  const longText = pdfText(p120);
  check('no row is lost across four pages',
    [longText.includes('key_0'), longText.includes('key_119')], [true, true]);

  console.log('\n── Part 3 — row height is measured, not assumed ──\n');

  /*
   * Two tables of the same row COUNT, differing only in the length of one column's text. If the row
   * height were fixed, both would paginate identically and the long text would silently overlap the
   * row beneath. More pages for the same number of rows is the observable consequence of measuring.
   */
  const shortValues = await render(rowsOf(30, () => 'x'));
  const longValues = await render(rowsOf(30, () => 'a deliberately long value that has to wrap across '
    + 'several lines inside a narrow column instead of overlapping the row beneath it, which is what '
    + 'a fixed row height would do'));
  check('the same 30 rows take more pages when their values wrap',
    pdfPages(longValues) > pdfPages(shortValues), true);
  check('  and the wrapped text is still on the page in full',
    pdfText(longValues).includes('overlapping the row beneath it'), true);

  console.log('\n── Part 4 — the document itself ──\n');

  const text = pdfText(p5);
  check('the title, subtitle, headers and footer are all rendered',
    ['Student Report', 'Verify School', 'Section', 'Key', 'Value', 'School Management System']
      .filter((t) => !text.includes(t)), []);
  check('  along with the cell values', ['key_0', 'key_4'].filter((t) => !text.includes(t)), []);

  const noRows = await render([]);
  check('a report with no rows still renders a valid one-page document with its header',
    [noRows.slice(0, 5).toString(), pdfPages(noRows), pdfText(noRows).includes('Section')],
    ['%PDF-', 1, true]);

  let refused = null;
  try {
    await renderTable({ title: 'x', columns: [], rows: [] });
  } catch (err) { refused = err.message; }
  check('a table with no columns is refused rather than producing an empty page',
    /at least one column/.test(refused || ''), true);

  console.log('\n── Part 5 — cell coercion ──\n');

  check('null and undefined become empty rather than the word "null"',
    [cell(null), cell(undefined)], ['', '']);
  check('a Date becomes a date, not a timestamp with a timezone',
    cell(new Date('2026-09-04T11:22:33Z')), '2026-09-04');
  check('a number becomes its own text', cell(0), '0');
  check('  including zero, which must not vanish the way a falsy check would drop it',
    [cell(0), cell(false)], ['0', 'false']);
  check('an object is serialised rather than rendered as [object Object]',
    cell({ a: 1 }), '{"a":1}');

  check('the defaults are frozen, so a caller cannot mutate every future document',
    Object.isFrozen(DEFAULTS), true);
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nverify-pdf crashed:', err);
  })
  .finally(() => {
    console.log('');
    console.log(failures === 0 ? 'All PDF renderer checks passed.' : `${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
