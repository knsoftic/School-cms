'use strict';

/**
 * Run the whole verification loop once, before jest evaluates any test file.
 *
 * ## Why the work happens here and not in a test
 *
 * jest's own ordering forces it. In jest 29 the run goes: resolve config, **discover test files**,
 * hard-exit 1 if there are none, `await` globalSetup to completion, and only then evaluate the test
 * files. Two consequences follow, and between them they determine this whole design:
 *
 *   - Discovery happens *before* globalSetup, so globalSetup cannot generate test files. The test
 *     file has to already exist and read results that globalSetup left behind.
 *   - globalSetup finishes entirely before any test module body runs, so a file written here can be
 *     read **synchronously at module scope** there. That matters because `jest-circus` builds the
 *     test tree by executing the module body: a `test()` issued from an async callback or from
 *     inside `beforeAll` is never collected. A synchronous read is the only way to turn 5,000-odd
 *     assertions whose names are unknowable until they run into named jest test cases.
 *
 * globalSetup runs in the main jest process via a plain require. It gets no jest globals — there is
 * no `expect` here — so every check below throws instead.
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
} = require('./helpers/suiteRunner');

const RESULTS_PATH = path.join(__dirname, '.last-run.json');
const BASELINE_PATH = path.join(__dirname, 'baseline.json');

/**
 * Prove the database before touching it.
 *
 * `SUITE_ENV` names `msms_test`, but an environment variable states an intention; `SELECT DATABASE()`
 * states a fact. Running the loop against `msms` would rewrite development data, and — worse for a
 * test harness — it would very likely still be green, so nothing would ever reveal the mistake.
 */
async function assertTargetDatabase() {
  Object.assign(process.env, SUITE_ENV);

  // eslint-disable-next-line global-require
  const db = require('../src/models');
  try {
    const [rows] = await db.sequelize.query('SELECT DATABASE() AS name');
    const actual = rows[0] && rows[0].name;
    if (actual !== EXPECTED_DATABASE) {
      throw new Error(
        `Refusing to run: connected to database "${actual}", expected "${EXPECTED_DATABASE}". ` +
          'Create it with: NODE_ENV=test npm run db:create && npm run db:migrate && npm run db:seed'
      );
    }
  } finally {
    /*
     * Closed before the suites start. Each suite opens its own pool of up to 15 connections; a pool
     * left open here is one the loop cannot use, and connection exhaustion presents to a suite as
     * "database unreachable" — which 19 of them answer by skipping their HTTP half and exiting 0.
     * A leaked handle in the harness would therefore show up as a *quieter* test run, not a failing
     * one.
     */
    await db.sequelize.close();
  }
}

module.exports = async function globalSetup() {
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(
      `No baseline at ${BASELINE_PATH}. Record one with: node scripts/record-baseline.js`
    );
  }

  /*
   * Delete last run's results before doing anything that could fail.
   *
   * `verify.test.js` reads this file at module scope and trusts it completely. If a future edit ever
   * lets globalSetup finish without writing it, the whole suite would be reported green from a
   * *previous* run — the most dangerous shape of false green there is, because the numbers would all
   * look right. Removing it first means that failure mode surfaces as a missing file and a loud red,
   * which is the correct outcome and costs one syscall.
   */
  if (fs.existsSync(RESULTS_PATH)) fs.unlinkSync(RESULTS_PATH);

  /*
   * Refuse to start while another loop is running. Two overlapping runs sweep each other's fixtures
   * by prefix and produce failures in suites that are individually fine — measured, six of them.
   */
  acquireRunLock();

  await assertTargetDatabase();

  const scripts = discoverSuites();
  const started = Date.now();

  process.stdout.write(
    `\nRunning ${scripts.length} verification suites serially against ${EXPECTED_DATABASE} ` +
      '(this is the whole safety net; it takes a while)\n\n'
  );

  const results = await runAllSuites(scripts, (r, i, total) => {
    const flags = [];
    if (r.exitCode !== 0) flags.push(`exit=${r.exitCode}`);
    if (r.failures) flags.push(`FAIL=${r.failures}`);
    if (r.skipped.length) flags.push('DEGRADED');
    if (r.timedOut) flags.push('TIMEOUT');
    process.stdout.write(
      `  [${String(i).padStart(2)}/${total}] ${r.script.padEnd(30)} ` +
        `${String(r.assertions.length).padStart(4)} assertions  ` +
        `${String(Math.round(r.durationMs / 1000)).padStart(3)}s` +
        (flags.length ? `  <= ${flags.join(' ')}` : '') +
        '\n'
    );
  });

  /*
   * `stdout` and `stderr` are kept only for suites that went wrong. Carrying the full output of all
   * 38 would make this file tens of megabytes, and the test file reads it synchronously at module
   * scope; for a healthy suite the parsed assertions already say everything.
   */
  const payload = {
    discovered: scripts,
    /*
     * The environment the suites actually ran under, recorded rather than assumed.
     *
     * Without this the harness could only compare `baseline.json` against literals written in the
     * test file, which means editing `SUITE_ENV` would change what all 40 suites run under while
     * every test kept passing — the baseline untouched, the assertion comparing two constants that
     * still matched each other. Writing the live value here lets the test tie the code, the run and
     * the baseline together instead of checking two of them against a third that never moves.
     */
    env: { ...SUITE_ENV },
    database: EXPECTED_DATABASE,
    durationMs: Date.now() - started,
    results: results.map((r) => {
      const healthy =
        r.exitCode === 0 && r.failures === 0 && r.skipped.length === 0 && !r.timedOut && !r.spawnError;
      return {
        script: r.script,
        exitCode: r.exitCode,
        spawnError: r.spawnError,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        failures: r.failures,
        skipped: r.skipped,
        /* Which earlier suite crashed, if any — so a downstream failure is not misattributed. */
        precededByCrash: r.precededByCrash || null,
        assertions: r.assertions,
        stdout: healthy ? null : r.stdout,
        stderr: healthy ? null : r.stderr,
      };
    }),
  };

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(payload));
  releaseRunLock();

  const total = results.reduce((sum, r) => sum + r.assertions.length, 0);
  process.stdout.write(`\n  ${total} assertions in ${Math.round(payload.durationMs / 1000)}s\n\n`);
};

module.exports.RESULTS_PATH = RESULTS_PATH;
module.exports.BASELINE_PATH = BASELINE_PATH;
