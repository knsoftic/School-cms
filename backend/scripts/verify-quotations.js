'use strict';

/**
 * Quotations — Known Issues #31, the fabricated-citation class, made assertable.
 *
 * ## The failure this exists to catch
 *
 * This project's first rule is that the SRS is the sole source of truth, and its comments carry that
 * authority by quoting it: `*"…"*` beside a `§` or an `FR-` reference. A quotation that is not in the
 * source therefore reads as authority and cannot be checked without going and looking. Six have been
 * found so far — three in session 26 (`migrator.js`, `cli.js`, `seed.js`), a fourth in
 * `payments.routes.js`, and **two found by this suite on the run that wrote it**:
 * `verify-subscriptions.js` attributed *"temporarily inactive"* to §12's Paused and
 * *"resumes where it stopped"* to FR-SUB-010, and neither phrase is in the SRS at all — "Paused"
 * appears twice as a bare item in a list of states, and the word "resume" does not occur in the
 * document. The second was this application's own response message quoted back as though the source
 * had said it.
 *
 * ## Why the obvious check was rejected, and what changed
 *
 * The register recorded the obvious guard — every quoted phrase beside an SRS reference must appear in
 * the SRS — as **measured and rejected**: 45 of the then 207 such quotations were not verbatim, almost
 * all of them legitimately, because the same convention quotes model column comments, permission names
 * and the project's own maxims. A check that fails on 45 correct lines is worse than no check, and the
 * row concluded that a real fix needed a house-style convention adopted first.
 *
 * It does not. The distinction it wanted is already mechanical: **a quotation must be traceable to
 * something this repository can point at.** The haystack is therefore the SRS *plus the repository's
 * own real text* — every `.js` file under `src/`, `scripts/` and `tests/` — with every `*"…"*` and
 * `**"…"**` span **stripped out first**, so that no quotation can ever be its own evidence. A phrase
 * that survives that is a phrase quoting nothing.
 *
 * That took the untraceable set from 45 to 8 without exempting anything, and the eight are enumerated
 * below with what each actually quotes.
 *
 * ## Four rules that make a faithful quotation pass, and why each is not a loophole
 *
 *  - **An ellipsis is an omission.** `*"A … B"*` requires A and B both present, in that order.
 *  - **A quotation that joins adjacent bullets is still quoting each of them.** §20.3's three
 *    Functional Behavior lines are quoted as one sentence run in `assignments.service.js`, and
 *    FR-BILL-003's four are joined with `/` in `payments.service.js`. Fragments are split on sentence
 *    and slash boundaries and each must be present **in order**, so a joined quotation cannot smuggle
 *    in a clause the source does not have.
 *  - **Emphasis added inside a quotation is the quoter's.** `**as applicable**` is stripped before
 *    comparing; the words still have to be the source's.
 *  - **Quote marks fold to one character.** A quotation that re-quotes an inner phrase in the other
 *    kind is quoting the same words.
 *
 * Applying these found five more misquotations that were fixed rather than exempted: three upload-rule
 * citations that dropped the inner quotes and truncated `(format not specified)`, and two that elided
 * the middle of SRS:1224 with no ellipsis.
 *
 * ## What is deliberately NOT in the haystack
 *
 * The project's own markdown — `IMPLEMENTATION_PROGRESS.md` and `docs/*.md`. They restate claims rather
 * than sourcing them, so including them lets a fabrication that was copied into the log certify itself.
 * Measured: with the log in the corpus, *"resumes where it stopped"* passed. It is the one exemption
 * cost that buys the whole check its teeth, and `cron.js` is the single quotation it makes an exception
 * for.
 *
 * Run: node scripts/verify-quotations.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRS_PATH = path.join(ROOT, 'docs', 'SRS-extracted.md');
const SCANNED = ['backend/src', 'backend/scripts', 'backend/tests'];

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

/* ═══════════════════════════ the eight, and what each quotes ═══════════════════════════ */

/**
 * A quotation that quotes something real which is not in the haystack, with the reason.
 *
 * Keyed by file and by the opening of the quotation rather than by line, because a line number moves
 * whenever a comment above it grows — the failure mode §8 already records for cited line numbers.
 *
 * **Every entry here was read before it was written.** An exemption is a claim that a phrase quotes
 * something; adding one without checking is the same defect this suite exists to catch, in a different
 * place.
 */
const TRACEABLE_ELSEWHERE = [
  {
    file: 'backend/src/jobs/cron.js',
    opens: 'SRS §29 forbids new tables',
    quotes: 'docs/ARCHITECTURE.md, verbatim — the only quotation of a project document, and the reason the docs are otherwise out of the haystack',
  },
  {
    file: 'backend/src/modules/auth/auth.service.js',
    opens: 'hand work off so the request thread',
    quotes: 'the module’s own statement of what a queue is for; no source is claimed',
  },
  {
    file: 'backend/src/modules/documents/documents.service.js',
    opens: 'bears a good moral character',
    quotes: 'nothing — it is a hypothetical the prose argues AGAINST, being wording a certificate must not carry because no column records conduct',
  },
  {
    file: 'backend/src/modules/invoices/invoices.service.js',
    opens: 'is this payment larger than the debt',
    quotes: 'the module’s own phrasing of the comparison it makes; no source is claimed',
  },
  {
    file: 'backend/src/modules/notifications/notifications.routes.js',
    opens: 'a key exists for something the SRS never asks',
    quotes: 'the project’s own recurring observation about the permission catalogue',
  },
  {
    file: 'backend/src/modules/notifications/notifications.service.js',
    opens: 'have I already sent',
    quotes: 'the module’s own phrasing of the idempotency question the marker columns answer',
  },
  {
    file: 'backend/src/modules/subscriptions/subscriptions.validation.js',
    opens: 'it belongs to invoice generation rather than here',
    quotes: 'a claim this codebase made and has since corrected, quoted in order to name it as wrong',
  },
  {
    file: 'backend/scripts/verify-subscriptions.js',
    opens: 'temporarily inactive',
    quotes: 'nothing — it is one of the two fabrications this suite found, quoted where the comment names it as fabricated',
  },
];

/* ═══════════════════════════ the scanner ═══════════════════════════ */

/** Squash the differences that are typography rather than content. */
function normalise(text) {
  return text
    /* A quotation that wraps carries its comment's continuation marker into the middle of it. */
    .replace(/[ \t]*[\r\n]+[ \t]*(?:\*|\/\/|>)[ \t]?/g, ' ')
    /* Emphasis added inside a quotation is the quoter's, not the source's. */
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`/g, '')
    .replace(/[‘’‛“”'"]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Italic `*"…"*`, not bold `**"…"**` — the second is how this codebase writes a name or a label. */
const QUOTATION = /(^|[^*])\*["“]([^"“”]{4,})["”]\*(?!\*)/g;
/** Any span that is a quotation, either weight — stripped from the haystack. */
const ANY_QUOTATION = /\*{1,2}["“][^"“”]{4,}["”]\*{1,2}/g;
/** A reference to the source, in the three forms this codebase uses. */
const SRS_REFERENCE = /(?:§\s*\d|SRS[:\s]|FR-[A-Z]+-\d)/;

function jsFilesUnder(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  })(dir);
  return out;
}

/**
 * This file is excluded from both the scan and the haystack, and that is load-bearing rather than
 * tidy.
 *
 * It names the fabricated phrases it found, states its own negative control in plain text, and lists
 * every exemption with the opening words of the quotation it exempts. Left in the corpus, every one of
 * those becomes evidence for itself: the negative control traced, the ellipsis-ordering control
 * traced, and seven of the eight exemptions stopped matching because their phrases were now findable
 * as ordinary prose. Measured — all five assertions inverted.
 */
const SELF = path.join(ROOT, 'backend', 'scripts', 'verify-quotations.js');

const files = SCANNED
  .reduce((all, dir) => all.concat(jsFilesUnder(path.join(ROOT, dir))), [])
  .filter((file) => path.resolve(file) !== SELF);

const HAYSTACK = normalise(
  files.reduce(
    (text, file) => text + '\n' + fs.readFileSync(file, 'utf8'),
    fs.readFileSync(SRS_PATH, 'utf8')
  ).replace(ANY_QUOTATION, ' ')
);

/**
 * Is this quotation traceable?
 *
 * Fragments split on ellipsis, sentence and slash boundaries must each appear, **in order** — the
 * ordering is what stops a joined quotation from asserting a sequence the source does not have.
 */
function traceable(quote) {
  const whole = normalise(quote).replace(/[.,;:]+$/, '');
  const parts = whole
    .split(/…|\.\.\.|\.\s|\s\/\s/)
    .map((part) => part.trim().replace(/[.,;:]+$/, ''))
    .filter((part) => part.length >= 10);
  /* A quotation shorter than one fragment is tested whole; splitting it would leave nothing. */
  if (!parts.length) return whole.length > 0 && HAYSTACK.indexOf(whole) !== -1;

  /*
   * The fragments must be close together, and this is what makes "in order" mean anything.
   *
   * Without a window the ordering claim is empty: the haystack is the SRS plus two hundred source
   * files, so almost any two phrases occur in both orders *somewhere*. Measured — the deliberately
   * reversed control passed. An ellipsis omits a clause or a parenthetical, not a codebase, so the
   * next fragment has to appear within this many characters of the end of the last one. Two thousand
   * is generous for an elision (the longest real one here spans four bullets) and far short of the
   * distance between two unrelated files.
   */
  const WINDOW = 2000;
  let from = 0;
  let first = true;
  for (const part of parts) {
    const at = HAYSTACK.indexOf(part, from);
    if (at === -1) return false;
    if (!first && at > from + WINDOW) return false;
    from = at + part.length;
    first = false;
  }
  return true;
}

function scan() {
  const found = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    QUOTATION.lastIndex = 0;
    let match;
    while ((match = QUOTATION.exec(text))) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      /*
       * "Beside a reference" is this line and its two neighbours. A comment wraps, so one line is too
       * narrow to see the `§` that introduced the quotation; a whole docblock is wide enough to sweep
       * in every quotation in a long header whether or not it cites anything.
       */
      const window = [lines[line - 2], lines[line - 1], lines[line]].filter(Boolean).join(' ');
      found.push({
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        line,
        quote: match[2],
        nearReference: SRS_REFERENCE.test(window),
      });
    }
  }
  return found;
}

/* ═══════════════════════════ part 1 — the scanner works ═══════════════════════════ */

console.log('=== Known Issues #31 — a quotation must quote something ===');
console.log('\n-- Part 1: the scanner itself --\n');

const all = scan();
const cited = all.filter((q) => q.nearReference);

/*
 * Non-vacuity first, and it is not ceremony. A regex that stopped matching would find zero
 * quotations, zero untraceable ones, and report a clean run — the exact shape of an assertion that
 * passes by having no input. Floors rather than exact counts: the corpus grows every session.
 */
check('the scanner finds this codebase’s quotations at all', all.length > 250, true);
check('  and most of them sit beside an SRS reference', cited.length > 200, true);
check('  over every .js file in src, scripts and tests', files.length > 200, true);

/* The positive and negative controls. Without these the check could be trivially true. */
check('a phrase that IS in the SRS is traceable',
  traceable('System captures Student Photo and Documents'), true);
check('a phrase that is NOT is not',
  traceable('the system shall reticulate every available spline'), false);
/*
 * Both fragments are over the ten-character floor on purpose: the first version used "Unlimited",
 * which the floor drops, so the reversed control passed by testing one fragment instead of two.
 */
check('an ellipsis stands for an omission, and the fragments must be in order',
  [traceable('System captures Student Photo … assigned to a Class and Section'),
    traceable('assigned to a Class and Section … System captures Student Photo')],
  [true, false]);

/*
 * The stripping is what stops a quotation certifying itself, so it is asserted directly rather than
 * trusted. "temporarily inactive" exists in this repository exactly once — inside a `*"…"*` span in
 * `verify-subscriptions.js`, where the comment names it as a fabrication — so if the haystack still
 * contained quotation spans, it would trace.
 */
check('a phrase that exists only INSIDE a quotation does not certify itself',
  HAYSTACK.indexOf('temporarily inactive') === -1, true);

/* ═══════════════════════════ part 2 — every quotation quotes something ═══════════════════════════ */

console.log('\n-- Part 2: the citations --\n');

const untraceable = cited.filter((q) => !traceable(q.quote));

/**
 * An exemption matches a quotation when they are in the same file and the quotation **opens with** the
 * recorded words. Prefix, not equality: `opens` is the first few words, deliberately, so that editing
 * the tail of a long quotation does not silently retire its exemption — and both directions below use
 * this one function, which they did not at first. Two of them compared a 40-character slice against a
 * 19-character one, so three exemptions read as stale while the same three read as matched.
 */
function matches(exemption, quotation) {
  return (
    quotation.file === exemption.file &&
    normalise(quotation.quote).startsWith(normalise(exemption.opens))
  );
}

const unexpected = untraceable
  .filter((q) => !TRACEABLE_ELSEWHERE.some((e) => matches(e, q)))
  .map((q) => `${q.file}:${q.line}  "${q.quote.replace(/\s+/g, ' ').slice(0, 90)}"`);

/*
 * The assertion the whole suite exists for. A new quotation that quotes nothing is named here by file,
 * line and text — the four fabrications found before this suite existed each took a manual re-read of
 * a module to find.
 */
check('every SRS-adjacent quotation quotes something, or is one of the recorded eight', unexpected, []);

/*
 * And the other direction: an exemption that no longer matches anything is a stale claim about the
 * code. Without this, a quotation could be corrected and its exemption would linger, hiding the next
 * untraceable quotation that happened to open the same way.
 */
const stale = TRACEABLE_ELSEWHERE
  .filter((e) => !untraceable.some((q) => matches(e, q)))
  .map((e) => e.file + ' :: ' + e.opens);
check('and every recorded exemption still matches a real quotation', stale, []);

check('the exemption list is the size it was measured at', TRACEABLE_ELSEWHERE.length, 8);
check('and every entry says what it quotes',
  TRACEABLE_ELSEWHERE.filter((e) => !e.quotes || e.quotes.length < 20).map((e) => e.file), []);

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('All quotation checks passed.');
process.exit(0);
