'use strict';

/**
 * Discover, run and parse the `scripts/verify-*.js` suites.
 *
 * Shared by `scripts/record-baseline.js` (which writes the manifest) and `tests/globalSetup.js`
 * (which checks against it), so the two can never disagree about what a suite's output means.
 *
 * Lives under `tests/helpers/` because `package.json` already lists that directory in
 * `testPathIgnorePatterns` — jest must never try to collect this file as a test.
 *
 * ## Why the suites are spawned rather than required
 *
 * All 39 scripts call `process.exit()` when they finish, and none guards on `require.main`. A
 * harness that `require()`d them would be killed by the first one, and would exit with *that
 * suite's* code — a green run that executed one thirty-eighth of the safety net. Spawning is not a
 * stylistic preference here; it is the only correct option.
 *
 * ## The three signals, and why all three are needed
 *
 * A suite reports what happened in three independent ways, and this project has a measured example
 * of each disagreeing with the others:
 *
 *   1. **Exit code.** Reliable for a suite that ran, but 19 of the 39 catch a database-connect
 *      failure, skip the whole HTTP half, print "All pure … checks passed" and exit **0**.
 *   2. **FAIL lines.** Zero of them is not evidence of success — a suite that crashed before its
 *      first assertion also prints zero.
 *   3. **Assertion count.** The only signal that catches a *silent* degradation, and the one nothing
 *      previously checked.
 *
 * Measured on 2026-09-05 by pointing every suite at a database that does not exist: **3,143 of the
 * 5,112 assertions vanished, and 19 suites still exited 0.** That is the failure this parser exists
 * to make impossible, so `parseOutput()` returns all three signals and the caller must agree them
 * against a recorded baseline rather than picking whichever one it trusts.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(BACKEND_ROOT, 'scripts');

/** A suite gets ten minutes. `verify-jobs.js` shells out to a real `mysqldump` over all 64 tables. */
const SUITE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The environment every suite is run under, and the reason it is not `NODE_ENV=test`.
 *
 * `src/config/env.js` derives `isTest` from `NODE_ENV` and uses it to reconfigure the application:
 * `rateLimit.enabled` becomes false (:185, with no environment override at all), `csrfEnabled`
 * defaults to false (:168), `bcryptRounds` drops to 4 (:145), and `logging.level` becomes `error`
 * (:241). Under `NODE_ENV=test` the suites therefore exercise a **different application** than the
 * one that ships — measured: `verify-app.js` fails 11 assertions there, all of them about the
 * middleware chain and the access log that `isTest` switches off.
 *
 * So the composition is the shipped one and only the *database* is redirected. `.env` already sets
 * `MAIL_DRIVER=log` and `AI_DRIVER=mock`, so this sends no mail and makes no API calls.
 */
const SUITE_ENV = Object.freeze({
  NODE_ENV: 'development',
  DB_NAME: 'msms_test',
  /*
   * The uploads directory is redirected too, and this is a data-loss fix rather than tidiness.
   *
   * `verify-ai.js:705`, `verify-homework.js:370` and `verify-students.js:430` each end with
   *
   *     fs.rmSync(path.join(config.uploads.dir, `school-${schoolId}`), { recursive: true, force: true })
   *
   * `.env` sets `UPLOAD_DIR=storage/uploads` — one directory, shared with the running application.
   * Redirecting only `DB_NAME` moves the *rows* to `msms_test` while leaving those recursive deletes
   * pointed at the directory the dev server writes real uploads into, keyed by a school id that came
   * from a different database. Nothing prevents `msms_test`'s ids from colliding with `msms`'s, and
   * the delete is `force: true`, so a collision is silent.
   *
   * Both databases are seeded by the same seeder from the same starting point, which makes collision
   * the expected case rather than the unlucky one. Nothing is lost today only because the directory
   * happens to be empty.
   */
  UPLOAD_DIR: 'storage/uploads-test',
});

/** The database the harness is allowed to touch. Asserted, never assumed. */
const EXPECTED_DATABASE = 'msms_test';

/**
 * Every suite on disk, discovered rather than listed.
 *
 * Checklist row 6.17 records why this must be a glob: `verify-school-setup.js` — 111 assertions at
 * the time — once sat on disk for an entire session with nothing announcing it, the same way
 * `verify-addons.js` sat broken between two sessions. A hardcoded list reproduces that failure by
 * construction. The count is asserted against the manifest by the caller, so a file appearing or
 * disappearing is a red test rather than a quiet change in coverage.
 */
function discoverSuites() {
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((name) => /^verify-.+\.js$/.test(name))
    .sort();
}

/**
 * Split a suite's output into the three signals.
 *
 * The line format is stable across 38 of the 39 scripts — `PASS` or `FAIL`, two spaces, the label,
 * two spaces, `->`, two spaces, the JSON of the actual value. `verify-seed.js` is the exception and
 * is handled explicitly below rather than by a tolerant regex, because a tolerant regex is how the
 * count silently drifts.
 */
function parseOutput(script, stdout) {
  const lines = stdout.split(/\r?\n/);

  const assertions = [];
  let failures = 0;

  /*
   * `verify-seed.js` does not use the shared `check()`. It accumulates into two arrays and prints a
   * single `PASS (22)` header followed by 22 indented sub-bullets, so a parser anchored on ^PASS
   * reads **one** assertion where there are 22.
   *
   * This is the documented 21-line undercount between the 5,112 `PASS` lines a serial loop prints
   * and the 5,133 assertions it actually runs. It is handled here, at the one place that knows the
   * format, rather than by carrying a magic constant at the totals — a fudge factor would silently
   * absorb the next genuine 21-assertion regression.
   */
  if (script === 'verify-seed.js') {
    for (const line of lines) {
      const pass = /^PASS \((\d+)\)\s*$/.exec(line);
      if (pass) {
        for (let i = 0; i < Number(pass[1]); i += 1) {
          assertions.push({ status: 'PASS', label: `seed assertion ${i + 1}`, detail: '' });
        }
        continue;
      }
      const fail = /^FAIL \((\d+)\)\s*$/.exec(line);
      if (fail) {
        failures += Number(fail[1]);
        for (let i = 0; i < Number(fail[1]); i += 1) {
          assertions.push({ status: 'FAIL', label: `seed failure ${i + 1}`, detail: '' });
        }
      }
    }
  } else {
    for (const line of lines) {
      const m = /^(PASS|FAIL) {2}(.*?) {2}-> {2}(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === 'FAIL') failures += 1;
      assertions.push({ status: m[1], label: m[2], detail: m[3] });
    }
  }

  /*
   * A degraded run announces itself, in four different phrasings across the 19 suites that can
   * degrade. Catching all four matters more than catching them elegantly: a suite that reached this
   * branch ran a fraction of its assertions and exited 0, which is the exact shape of a false green.
   */
  const skipped = lines.filter(
    (line) => /^SKIP\b/.test(line) || /SKIPPED/.test(line) || /database unreachable/.test(line)
  );

  return { assertions, failures, skipped };
}

/**
 * A whole-loop lock, because two overlapping runs corrupt each other.
 *
 * The suites create fixtures under per-suite prefixes and sweep them by prefix in teardown, so a
 * second run does not merely race — it **hard-deletes the first run's rows mid-assertion**. Known
 * Issue #25 is the same hazard between two suites; this is it between two loops.
 *
 * Demonstrated rather than theorised: a 12-run determinism loop was left running while
 * `record-baseline.js` was started, and six suites broke — `verify-addons`, `verify-platform-modules`,
 * `verify-school-setup`, `verify-seed`, `verify-subscriptions`, `verify-users-roles`. Every one of
 * them passes alone. The broken-run gate refused to write the baseline, which is the only reason the
 * corruption did not become the recorded truth.
 *
 * The lock records a pid. A stale lock from a killed run is detected and taken over rather than
 * requiring manual cleanup, because the failure mode of a lock nobody can clear is that people delete
 * the lock file as a matter of habit and it stops meaning anything.
 */
const LOCK_PATH = path.join(__dirname, '..', '.suite-run.lock');

function acquireRunLock() {
  if (fs.existsSync(LOCK_PATH)) {
    const holder = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim());
    let alive = false;
    try {
      /* Signal 0 tests for existence without delivering anything. */
      process.kill(holder, 0);
      alive = true;
    } catch (err) {
      alive = err.code === 'EPERM';
    }
    if (alive) {
      throw new Error(
        `Another suite run is in progress (pid ${holder}). Two overlapping runs delete each other's ` +
          `fixtures by prefix and produce failures in suites that are fine. Wait for it, or stop it ` +
          `and delete ${LOCK_PATH}.`
      );
    }
    fs.unlinkSync(LOCK_PATH);
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
}

function releaseRunLock() {
  try {
    if (fs.existsSync(LOCK_PATH) && fs.readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch (err) {
    /* A lock we cannot remove is a nuisance, not a reason to fail a green run. */
  }
}

/** Run one suite to completion. Never throws for a failing suite — a failure is data, not an error. */
function runSuite(script) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, script)], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, ...SUITE_ENV },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    /*
     * `setEncoding` rather than concatenating Buffers, and this is a correctness fix rather than a
     * tidiness one. `stdout += chunk` coerces each Buffer independently, so a multi-byte character
     * straddling a chunk boundary is decoded as two invalid halves and becomes replacement
     * characters — verified: the four-character string `—→──` accumulated in two-byte chunks comes
     * back as ten U+FFFD. These suites print em-dashes and arrows in assertion labels constantly.
     *
     * The damage would not have been cosmetic. A mangled label is a wrong test name, but a mangled
     * *separator* drops the assertion from the parse entirely, which fails the exact-count check and
     * indicts a healthy suite. `setEncoding` routes the stream through a `StringDecoder`, which holds
     * a partial character back until its remaining bytes arrive.
     *
     * The output is also accumulated in full and read only after the child exits, so nothing
     * downstream can close the pipe early and cost the child its tail — and the tail is where a
     * suite's FAIL lines and its exit summary live.
     */
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      /* SIGKILL, not SIGTERM: a suite wedged on a database handle will ignore a polite signal. */
      child.kill('SIGKILL');
    }, SUITE_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        script,
        exitCode: null,
        spawnError: err.message,
        timedOut: false,
        durationMs: Number((process.hrtime.bigint() - started) / 1000000n),
        stdout,
        stderr,
        assertions: [],
        failures: 0,
        skipped: [],
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseOutput(script, stdout);
      resolve({
        script,
        exitCode: code,
        spawnError: null,
        timedOut,
        durationMs: Number((process.hrtime.bigint() - started) / 1000000n),
        stdout,
        stderr,
        ...parsed,
      });
    });
  });
}

/**
 * Run every suite, one at a time.
 *
 * Serial because Known Issue #25 is only *narrowed*, not closed. Session 25 scoped the teardowns, and
 * five suites went from 18 red in 30 concurrent runs to 0 in 30 — but `verify-plans.js` still asserts
 * the exact set of `table_name`s written to `audit_logs` above its own `max(id)` baseline, and
 * `verify-subscriptions.js` still asserts that every subscription in the database belongs to its run.
 * Neither can be scoped to a run without changing what it asserts, so both go red if anything else
 * writes while they read.
 */
async function runAllSuites(scripts, onProgress) {
  const results = [];
  /*
   * Once a suite has died hard, every later suite is suspect — and this is the project's most
   * expensive recurring failure, not a hypothetical.
   *
   * Each suite cleans up in a `finally`, which SIGKILL (the 10-minute timeout) and a hard crash both
   * skip entirely. The fixtures survive, and the *next* suite fails on rows it did not create. That
   * has genuinely happened here: a crashed `verify-security.js` left a `VSEC-XSS2` organization
   * behind and broke `verify-platform-modules.js` four assertions deep, pointing at sorting; and a
   * determinism run killed mid-flight this session left four `VST-*` schools in `msms_test`.
   *
   * The cascade cannot be prevented from here — teardown belongs to the child. What can be fixed is
   * the *misattribution*, which is what actually costs the time: flagging every suite that ran after
   * a crash means a downstream failure says "this may be residue from <script>" instead of accusing
   * an innocent suite of a defect it does not have.
   */
  let crashedBefore = null;
  for (const script of scripts) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runSuite(script);
    result.precededByCrash = crashedBefore;
    if (result.timedOut || result.spawnError || result.exitCode !== 0) {
      crashedBefore = crashedBefore || script;
    }
    results.push(result);
    if (onProgress) onProgress(result, results.length, scripts.length);
  }
  return results;
}

module.exports = {
  BACKEND_ROOT,
  LOCK_PATH,
  acquireRunLock,
  releaseRunLock,
  SCRIPTS_DIR,
  SUITE_ENV,
  SUITE_TIMEOUT_MS,
  EXPECTED_DATABASE,
  discoverSuites,
  parseOutput,
  runSuite,
  runAllSuites,
};
