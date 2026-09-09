'use strict';

/**
 * The verification loop, as jest test cases. Checklist row 6.17.
 *
 * `tests/globalSetup.js` has already run all 39 suites serially and written `.last-run.json`. This
 * file turns that into named tests: one per suite for the suite-level signals, then **one per
 * assertion**, carrying the label the suite itself printed.
 *
 * ## What this file is actually defending against
 *
 * Not "does a suite fail" — the suites already answer that, and the bash loop already reads it. The
 * thing nothing checked before is whether a suite *ran what it was supposed to run*.
 *
 * Nineteen of the thirty-eight catch a database-connect failure, skip their entire HTTP half, print
 * "All pure … checks passed", and exit **0**. Measured on 2026-09-05 against a database that does
 * not exist: **3,143 of 5,112 assertions vanished and 19 suites still exited 0.** Exit code said
 * fine. FAIL count said fine. Only the assertion count knew.
 *
 * So each suite is judged on four independent signals, each asserted separately — exit code, FAIL
 * count, degradation markers, and assertion count against `baseline.json`. Any one of them alone has
 * a measured way of being green while the safety net is not running. (They are not compared to one
 * another; each is checked against its own expected value, so a disagreement surfaces as whichever
 * assertion is wrong. An earlier draft said they "must agree", which claimed a cross-check the code
 * does not perform.)
 *
 * ## Why the counts are exact
 *
 * `toBe(expected)`, not `toBeGreaterThanOrEqual`. A floor passes a suite that grew to 200 assertions
 * and silently fell back to its recorded 168. Exactness means adding an assertion turns the suite red
 * until `node scripts/record-baseline.js` is run deliberately — which is the point: the assertion
 * count becomes a tracked number, the way the 5,133 total already is in the two project documents.
 */

const fs = require('fs');
const path = require('path');

/* Imported, not restated — see 'the run used the environment the baseline was recorded under'. */
const { SUITE_ENV, EXPECTED_DATABASE } = require('./helpers/suiteRunner');

const RESULTS_PATH = path.join(__dirname, '.last-run.json');
const BASELINE_PATH = path.join(__dirname, 'baseline.json');

/*
 * Read synchronously at module scope. `jest-circus` builds the test tree by executing this module
 * body, so a `test()` registered from an async callback or a `beforeAll` is never collected — an
 * `await` here would produce a file with zero tests, which reads as "nothing to check" rather than
 * as an error. globalSetup is guaranteed to have completed before this line runs.
 */
const results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

const byScript = new Map(results.results.map((r) => [r.script, r]));

describe('harness integrity', () => {
  /*
   * These run first and exist because every other test in this file trusts the results file. If the
   * harness itself is broken, the per-suite tests below would be vacuously green — a file containing
   * zero suites passes every assertion about the suites it contains.
   */

  test('the run produced results', () => {
    expect(Array.isArray(results.results)).toBe(true);
    expect(results.results.length).toBeGreaterThan(0);
  });

  test('every suite on disk was discovered and run', () => {
    /*
     * Glob discovery, asserted against the manifest. Row 6.17 records why: `verify-school-setup.js`
     * — 111 assertions at the time — sat on disk for an entire session with nothing announcing it,
     * the same way `verify-addons.js` sat broken across two sessions. A hardcoded list rebuilds that
     * failure mode by construction, and a glob without an asserted count hides it just as well.
     */
    const discovered = [...results.discovered].sort();
    const recorded = Object.keys(baseline.suites).sort();
    expect(discovered).toEqual(recorded);
  });

  test('every suite that can skip its database half fails when it does', () => {
    /*
     * Known Issue 28. Nineteen suites answer an unreachable database by setting `dbSkipped`,
     * returning early from their database half and printing that they passed. Until session 26 they
     * then **exited 0**, so a stopped MySQL read as a green run to anything that scores by exit code:
     * `node scripts/verify-fees.js` run directly, and `scripts/stress.sh:17`, whose whole scoring is
     * `if ! wait "$pid"` — a determinism run with the database down would have reported a perfect
     * score for suites that never executed.
     *
     * `npm test` was never exposed and is not what this guards: `globalSetup.js` proves the database
     * before any suite spawns and the per-suite tests below assert both `skipped` and the exact
     * counts. This asserts the property at the SOURCE, so the nineteenth-and-a-half suite — the next
     * one written with a `dbSkipped` and copied from a sibling — cannot arrive without the guard.
     *
     * Measured with the port pointed at nothing: across the nineteen, **1,563 of 2,625 PASS lines**
     * (60%) disappear while every one of them used to exit 0. Now all nineteen exit 1, and 0 only
     * with `--allow-skip` — the opt-out that mirrors `record-baseline.js`'s `--allow-shrink`.
     */
    const missing = [];
    for (const script of Object.keys(baseline.suites)) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', script), 'utf8');
      if (!/\bdbSkipped\b/.test(source)) continue;
      /* The guard has to reach `process.exit`, not merely mention the flag in a message. */
      if (!/if \(dbSkipped && !process\.argv\.includes\('--allow-skip'\)\)/.test(source)) {
        missing.push(script);
      }
    }
    expect(missing).toEqual([]);
  });

  test('no verify script contains a stray control character', () => {
    /*
     * ## Why this is a harness-integrity test
     *
     * `verify-security.js` carried `/href=\{(?!`?\/)[^}]*\brow\./` — except the `\b` was a literal
     * **backspace character** (0x08), not a word boundary. A backspace never appears in source, so
     * `.test()` was always false, the filter rejected every file, and the check compared `[]` with
     * `[]` and reported **PASS whatever any screen did**. One of §24's XSS assertions had been
     * passing vacuously since it was written.
     *
     * A control character is invisible in every editor and in every diff, and inside a regex it
     * silently changes what the pattern means rather than raising an error — which is precisely the
     * shape of failure this file exists to catch. Nothing here reads the assertion's *intent*; it
     * only refuses the bytes that can quietly break one.
     *
     * The cause was mine and worth recording: a non-raw Python string in a code-generation step, so
     * `'\\b'` reached disk as a backspace. Author regexes with a real editor, or with raw strings.
     *
     * ## The one legitimate exception
     *
     * `verify-assignments.js` builds a deliberately-malicious upload fixture whose bytes are the
     * DOS/PE magic number — `Buffer.from('MZ\0')`. That NUL is the point of the fixture, so it is
     * allowed by name rather than by relaxing the rule.
     */
    const ALLOWED = { 'verify-assignments.js': [0] };

    const offenders = [];
    for (const script of Object.keys(baseline.suites)) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', script), 'utf8');
      const allowed = new Set(ALLOWED[script] || []);
      const found = new Set();
      for (const character of source) {
        const codePoint = character.codePointAt(0);
        /* Tab, newline and carriage return are ordinary whitespace here. */
        if (codePoint >= 32 || [9, 10, 13].includes(codePoint)) continue;
        if (allowed.has(codePoint)) continue;
        found.add(codePoint);
      }
      if (found.size > 0) offenders.push(`${script}: ${[...found].sort((a, b) => a - b).join(', ')}`);
    }

    expect(offenders.sort()).toEqual([]);
  });

  test('  and the harness itself never passes that opt-out', () => {
    /*
     * The escape hatch is for a person at a terminal. If `suiteRunner` ever spawned suites with
     * `--allow-skip`, the whole guard would be inert in the one place it is checked automatically —
     * and nothing else in this file would notice, because a skipped suite's assertion count is
     * already asserted separately and would simply be wrong rather than absent.
     */
    const runner = fs.readFileSync(path.join(__dirname, 'helpers', 'suiteRunner.js'), 'utf8');
    expect(runner.includes('--allow-skip')).toBe(false);
  });

  test('every suite figure the checklist quotes matches the baseline', () => {
    /*
     * `docs/IMPLEMENTATION_CHECKLIST.md` cites each suite's assertion count as evidence that a row is
     * done — "`verify-fees.js` → **170 / 170, exit 0**". Nine of those had drifted behind the suites
     * they describe, by as much as 46 (`verify-frontend.js` said 20 and runs 66), and nothing noticed,
     * because a figure in prose is not checked by anything that runs.
     *
     * Scoped to the CHECKLIST on purpose. `IMPLEMENTATION_PROGRESS.md` holds six figures that no
     * longer match and every one is historical narrative — "Wrote `verify-billing.js` (189
     * assertions)", "Re-ran it: 216 / 216" — true when written, in a day-by-day record. Asserting
     * against those would force the log to be rewritten every time a suite grows, which is the
     * opposite of what a history is for.
     *
     * Two shapes are recognised, both of which appear: `N / N` and `(N assertions`.
     */
    const checklist = fs.readFileSync(
      path.join(__dirname, '..', '..', 'docs', 'IMPLEMENTATION_CHECKLIST.md'),
      'utf8'
    );

    const stale = [];
    const record = (script, quoted) => {
      const actual = baseline.suites[script] && baseline.suites[script].assertions;
      if (actual !== undefined && quoted !== actual) {
        stale.push(`${script}: checklist says ${quoted}, baseline records ${actual}`);
      }
    };

    /* "`verify-fees.js` → **170 / 170" — only the N/N form, so a partial count is not mistaken for one. */
    for (const m of checklist.matchAll(/(verify-[a-z-]+\.js)`?[^0-9\n]{0,60}?\*{0,2}(\d{2,4})\s*\/\s*(\d{2,4})/g)) {
      if (m[2] === m[3]) record(m[1], Number(m[2]));
    }
    /* "`verify-deploy.js` (52 assertions" */
    for (const m of checklist.matchAll(/(verify-[a-z-]+\.js)`?[^.\n]{0,80}?\((\d{2,4}) assertions/g)) {
      record(m[1], Number(m[2]));
    }

    expect([...new Set(stale)].sort()).toEqual([]);
  });

  test('the suite count matches the baseline', () => {
    expect(results.results.length).toBe(baseline.suiteCount);
  });

  test('the total assertion count matches the baseline', () => {
    /*
     * The per-suite counts below would catch any individual drop, so this is belt to their braces —
     * but it is the number the project documents quote, so having it as its own named test means a
     * documented figure and an executed figure can never quietly diverge.
     */
    const total = results.results.reduce((sum, r) => sum + r.assertions.length, 0);
    expect(total).toBe(baseline.totalAssertions);
  });

  test('the baseline agrees with itself', () => {
    /*
     * Every other test here treats `baseline.json` as ground truth, which makes the file itself the
     * one thing nothing checks. Its per-suite numbers and its totals are written from the same run,
     * so they cannot disagree unless the file was hand-edited — and hand-editing it is precisely how
     * someone would "fix" a failing count without re-running anything. Then the totals would agree
     * with a fiction. Cheap to assert, and it makes the file self-describing.
     */
    const entries = Object.values(baseline.suites);
    expect(entries.length).toBe(baseline.suiteCount);
    expect(entries.reduce((sum, s) => sum + s.assertions, 0)).toBe(baseline.totalAssertions);
    expect(entries.reduce((sum, s) => sum + s.passLines, 0)).toBe(baseline.totalPassLines);
  });

  test('the run used the environment the baseline was recorded under', () => {
    /*
     * Three things must agree here, and the first draft only compared two: it checked
     * `baseline.recordedUnder` against literals typed into this file. Editing `SUITE_ENV` would then
     * change what all 39 suites actually ran under — a different database, a different application
     * composition — while this test kept passing, because the two constants it compared still
     * matched each other and neither described the run.
     *
     * So the live `SUITE_ENV` is imported, and `globalSetup` now records what it used into the
     * results. The chain is: the code the suites ran under === what the run recorded === what the
     * baseline was measured under. Breaking any link fails here.
     */
    expect(results.env).toEqual(SUITE_ENV);
    expect(results.env).toEqual(baseline.recordedUnder);
    expect(results.database).toBe(EXPECTED_DATABASE);
    expect(baseline.database).toBe(EXPECTED_DATABASE);
  });
});

for (const script of [...results.discovered].sort()) {
  const result = byScript.get(script);
  const expected = baseline.suites[script];

  describe(script, () => {
    if (!result) {
      test('was run', () => {
        throw new Error(`${script} was discovered but produced no result`);
      });
      return;
    }

    /*
     * Prefixed to every failure in this suite when an earlier suite crashed.
     *
     * A suite that dies on SIGKILL or a hard crash never reaches its `finally`, so its fixtures
     * survive and the *next* suite fails on rows it did not create. That has cost real time here
     * twice: a crashed `verify-security.js` left a `VSEC-XSS2` organization that broke
     * `verify-platform-modules.js` four assertions deep, and a killed run left four `VST-*` schools
     * behind. The cascade cannot be stopped from here — teardown belongs to the child — but the
     * misattribution can, and the misattribution is what actually wastes the afternoon.
     */
    const cascade = result.precededByCrash
      ? ` (NOTE: ${result.precededByCrash} crashed earlier in this run and skipped its teardown; ` +
        'this failure may be its residue rather than a defect here)'
      : '';

    test('exited 0', () => {
      expect({
        exitCode: result.exitCode,
        spawnError: result.spawnError,
        upstreamCrash: result.precededByCrash || null,
      }).toEqual({ exitCode: 0, spawnError: null, upstreamCrash: null });
    });

    test('did not time out', () => {
      expect(result.timedOut).toBe(false);
    });

    test('printed no FAIL line', () => {
      expect(result.failures).toBe(0);
    });

    test('ran its database half rather than skipping it', () => {
      /*
       * The signal that exit code and FAIL count both miss. A suite reaching this state ran a
       * fraction of its assertions and reported success; `verify-billing.js` drops from 220 to 186,
       * `verify-exams.js` from 219 to 73, and both exit 0.
       */
      expect(result.skipped).toEqual([]);
    });

    if (expected) {
      test(`ran all ${expected.assertions} of its assertions`, () => {
        if (result.assertions.length !== expected.assertions && cascade) {
          throw new Error(
            `expected ${expected.assertions} assertions, got ${result.assertions.length}${cascade}`
          );
        }
        expect(result.assertions.length).toBe(expected.assertions);
      });
    } else {
      test('is present in the baseline', () => {
        throw new Error(
          `${script} has no baseline entry. Re-record with: node scripts/record-baseline.js`
        );
      });
    }

    if (result.assertions.length === 0) {
      /*
       * An empty assertion list must be a failure, never an empty test list. A `describe` block
       * containing no tests is reported as passing, so a suite that crashed before its first
       * assertion would otherwise be the quietest thing in the run.
       */
      test('produced at least one assertion', () => {
        throw new Error(
          `${script} produced no assertions.\n` +
            `exit=${result.exitCode} timedOut=${result.timedOut}\n` +
            `${(result.stderr || result.stdout || '').slice(-2000)}`
        );
      });
    } else {
      describe('assertions', () => {
        /*
         * A plain loop rather than `test.each`. `test.each` interprets `%s`, `%d` and `$prop` in the
         * name as format tokens, and these labels are free text written by 39 different suites —
         * several contain `%` and `$`. A mangled test name is a small problem; `test.each` silently
         * shifting its arguments is not.
         */
        result.assertions.forEach((assertion, index) => {
          test(`${String(index + 1).padStart(4, '0')}  ${assertion.label}`, () => {
            if (assertion.status !== 'PASS') {
              throw new Error(`${assertion.label}  ->  ${assertion.detail}`);
            }
          });
        });
      });
    }
  });
}
