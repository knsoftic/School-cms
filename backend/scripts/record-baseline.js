'use strict';

/**
 * Record the per-suite assertion baseline that `npm test` checks against.
 *
 * Run deliberately, never automatically:
 *
 *     node scripts/record-baseline.js
 *
 * ## Why a recorded baseline exists at all
 *
 * Because a suite can lose most of its assertions and still exit 0. Nineteen of the thirty-eight
 * catch a database-connect failure, skip their whole HTTP half, print "All pure … checks passed" and
 * exit **0**. Measured against a database that does not exist: **3,143 of 5,112 assertions vanished
 * and 19 suites stayed green.** Nothing in the loop noticed, because nothing knew how many
 * assertions a suite was supposed to run.
 *
 * A baseline is the missing knowledge. `tests/verify.test.js` asserts each suite produced *exactly*
 * its recorded count — not "at least", because a suite that grows and later silently shrinks back
 * would slip through a floor, and not a global total, because one suite gaining ten assertions would
 * mask another losing ten.
 *
 * ## Why regenerating is deliberate
 *
 * Re-recording from a broken run bakes the breakage in. That risk cannot be designed away — it can
 * only be made visible, so this file is never run by `npm test`, it prints the delta against the
 * existing baseline before writing, and it refuses to record a run in which any suite failed,
 * degraded or crashed. The totals are also written into IMPLEMENTATION_PROGRESS.md, where a drop
 * would have to survive review.
 */

const fs = require('fs');
const path = require('path');

const {
  discoverSuites,
  runAllSuites,
  acquireRunLock,
  releaseRunLock,
  SUITE_ENV,
  EXPECTED_DATABASE,
} = require('../tests/helpers/suiteRunner');

const BASELINE_PATH = path.join(__dirname, '..', 'tests', 'baseline.json');

/**
 * Prove the target database before running anything.
 *
 * `SUITE_ENV` sets `DB_NAME`, but an environment variable is a statement of intent, not evidence.
 * `SELECT DATABASE()` is evidence. Recording a baseline against the development database would
 * poison it with whatever that database happens to contain, and the numbers would look plausible.
 */
async function assertTargetDatabase() {
  /*
   * Set before `src/models` is required, because `config/env.js` reads the environment once at
   * module load. Not restored afterwards: every suite is spawned with `SUITE_ENV` applied
   * explicitly, so nothing downstream depends on this process's own environment, and reassigning
   * `process.env` wholesale is a sharp edge with no upside here.
   */
  Object.assign(process.env, SUITE_ENV);

  // eslint-disable-next-line global-require
  const db = require('../src/models');
  try {
    const [rows] = await db.sequelize.query('SELECT DATABASE() AS name');
    const actual = rows[0] && rows[0].name;
    if (actual !== EXPECTED_DATABASE) {
      throw new Error(
        `refusing to record: connected to "${actual}", expected "${EXPECTED_DATABASE}"`
      );
    }
    console.log(`database: ${actual}`);
  } finally {
    await db.sequelize.close();
  }
}

async function main() {
  /* Same lock the jest harness takes — a baseline recorded during another run records the collision. */
  acquireRunLock();
  await assertTargetDatabase();

  const scripts = discoverSuites();
  console.log(`suites discovered: ${scripts.length}`);
  console.log('');

  const existing = fs.existsSync(BASELINE_PATH)
    ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    : null;

  const results = await runAllSuites(scripts, (r, i, total) => {
    const flags = [];
    if (r.exitCode !== 0) flags.push(`exit=${r.exitCode}`);
    if (r.failures) flags.push(`FAIL=${r.failures}`);
    if (r.skipped.length) flags.push('DEGRADED');
    if (r.timedOut) flags.push('TIMEOUT');
    if (r.spawnError) flags.push(`spawn:${r.spawnError}`);

    const was = existing && existing.suites[r.script];
    const delta = was && was.assertions !== r.assertions.length
      ? `  (was ${was.assertions})`
      : '';

    console.log(
      `[${String(i).padStart(2)}/${total}] ${r.script.padEnd(30)} ` +
        `${String(r.assertions.length).padStart(4)} assertions  ` +
        `${String(Math.round(r.durationMs / 1000)).padStart(3)}s${delta}` +
        (flags.length ? `  <= ${flags.join(' ')}` : '')
    );
  });

  /*
   * `assertions.length === 0` counts as broken.
   *
   * Without it, a regression in `parseOutput()` produces 38 suites that all exit 0, print no FAIL and
   * parse to nothing — and this script would write a baseline of all zeros, against which every
   * future run passes. The shrink gate below catches that on a re-record, but not on a first one,
   * and "the parser stopped working" is exactly the failure that must not be the thing that
   * establishes what correct looks like. No suite legitimately runs zero assertions; the smallest is
   * `verify-performance.js` at 14.
   */
  const broken = results.filter(
    (r) =>
      r.exitCode !== 0 ||
      r.failures > 0 ||
      r.skipped.length > 0 ||
      r.timedOut ||
      r.spawnError ||
      r.assertions.length === 0
  );

  console.log('');
  if (broken.length) {
    console.error(
      `refusing to write a baseline from a run with ${broken.length} broken suite(s):\n` +
        broken.map((r) => `  ${r.script}`).join('\n')
    );
    console.error('\nA baseline recorded from a broken run makes the breakage permanent.');
    /* exitCode + return, not process.exit() — the latter skips the .finally() that releases the lock. */
    process.exitCode = 1;
    return;
  }

  const suites = {};
  for (const r of results) {
    suites[r.script] = {
      assertions: r.assertions.length,
      /*
       * Recorded separately because they differ for exactly one suite. `verify-seed.js` prints a
       * single `PASS (22)` header for 22 assertions, which is the whole of the documented 21-line
       * gap between the 5,112 `PASS` lines a loop prints and the 5,133 assertions it runs. Keeping
       * both numbers means the documents and the harness can be checked against each other.
       */
      passLines: (r.stdout.match(/^PASS/gm) || []).length,
    };
  }

  const totalAssertions = results.reduce((sum, r) => sum + r.assertions.length, 0);
  const totalPassLines = Object.values(suites).reduce((sum, s) => sum + s.passLines, 0);

  const baseline = {
    /*
     * No timestamp. This project has no git history, and a self-reported date is not provenance —
     * the file's own mtime is the honest record of when it was written.
     */
    recordedUnder: SUITE_ENV,
    database: EXPECTED_DATABASE,
    suiteCount: results.length,
    totalAssertions,
    totalPassLines,
    suites,
  };

  /*
   * A shrink is gated, and the delta is printed BEFORE the write rather than after.
   *
   * The broken-run refusal above catches a suite that failed, degraded or crashed. It does not catch
   * the quieter case: every suite green, but fewer assertions than last time -- a check deleted, a
   * branch that stopped being reached, a suite removed from disk. That is a *reduction in the safety
   * net* arriving as a clean run, and overwriting the baseline with it makes the loss permanent and
   * invisible, because from then on the smaller number is what "correct" means.
   *
   * So a shrink needs `--allow-shrink` said out loud. Growth writes freely: adding assertions is the
   * normal direction, and gating that too would train people to pass the flag every time, which
   * would cost the gate its meaning.
   */
  if (existing) {
    const dA = totalAssertions - existing.totalAssertions;
    const dS = results.length - existing.suiteCount;
    console.log('');
    console.log(
      `delta vs previous baseline: ${dA >= 0 ? '+' : ''}${dA} assertions, ${dS >= 0 ? '+' : ''}${dS} suites`
    );

    if ((dA < 0 || dS < 0) && !process.argv.includes('--allow-shrink')) {
      console.error('');
      console.error('REFUSING TO WRITE: this run has fewer assertions or suites than the recorded');
      console.error('baseline, and every suite passed. That is coverage disappearing quietly.');
      for (const k of Object.keys(existing.suites)) {
        const was = existing.suites[k].assertions;
        const now = suites[k] ? suites[k].assertions : 0;
        if (now < was) console.error(`  ${k.padEnd(30)} ${was} -> ${now}`);
      }
      console.error('');
      console.error('If it is intended, re-run with --allow-shrink.');
      /* exitCode + return, not process.exit() — the latter skips the .finally() that releases the lock. */
      process.exitCode = 1;
      return;
    }
  }

  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);

  console.log(`suites:          ${baseline.suiteCount}`);
  console.log(`assertions:      ${totalAssertions}`);
  console.log(`PASS lines:      ${totalPassLines}  (${totalAssertions - totalPassLines} fewer, all verify-seed.js)`);
  console.log('');
  console.log(`written: ${BASELINE_PATH}`);
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => {
    releaseRunLock();
  });
