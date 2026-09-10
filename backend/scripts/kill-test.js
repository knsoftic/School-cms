'use strict';

/**
 * Does a killed run of a suite poison the run after it? Known Issues #34, as a command.
 *
 *     node scripts/kill-test.js                      every suite — about twice as long as the loop
 *     node scripts/kill-test.js finance billing      named suites, with or without verify- / .js
 *     node scripts/kill-test.js --control jobs       the same, never killing: what a clean run leaves
 *
 * Every suite tears its fixtures down in a `finally`, and a killed process runs no `finally`. So each
 * suite also clears what a dead run of itself left, at its start — `scripts/lib/residue.js`. This is
 * how that was proved, kept so that §8's rule for a new suite can be followed rather than recited.
 *
 * For each suite: count the rows in every table; start the suite and SIGKILL it once it has printed
 * 85% of the assertions `tests/baseline.json` records for it — fixtures built, teardown not reached;
 * count again; run it again normally; count again. **SAFE** means the rerun is green *and* every
 * non-log table is back at its starting count. Green alone is not the bar: a leftover that does not
 * trip its own suite trips another — `verify-seed.js` counts users.
 *
 * The kill point is counted in assertions rather than seconds, so it lands in the same place on any
 * machine. A kill that leaves nothing behind is retried at 60% and then 95%, because a suite whose
 * early assertions are pure checks has not built anything yet.
 *
 * **Log tables are reported, not judged.** Six suites leave `activity_logs` / `audit_logs` rows on a
 * clean run too — rows with no user, school or organization on them: a failed sign-in, a job's audit
 * row, a row whose fixture user was deleted (`user_id` is SET NULL) — so a count there does not by
 * itself mean a kill leaked. Compare with `--control`. That is how
 * the two kill-specific cases were told apart from the rest: `verify-middlewares.js` (its rerun read
 * the dead run's audit rows as its own) and `verify-billing.js` (its own start-of-run teardown
 * orphaned the dead run's rows before the sweep could reach them).
 *
 * `verify-seed.js` prints its 22 assertions as one line when it finishes, so no kill counted this way
 * lands inside it and it is reported NOT KILLED. Its recovery was proved by planting the worst case
 * directly — IMPLEMENTATION_PROGRESS.md §7, step 418.
 *
 * Holds the same run lock as `npm test`, and refuses to touch any database but `msms_test`. Exit 1 if
 * any suite is UNSAFE.
 */

const { spawn } = require('child_process');
const path = require('path');

const {
  BACKEND_ROOT,
  SCRIPTS_DIR,
  SUITE_ENV,
  SUITE_TIMEOUT_MS,
  EXPECTED_DATABASE,
  acquireRunLock,
  releaseRunLock,
  discoverSuites,
  runSuite,
} = require('../tests/helpers/suiteRunner');

/* Before `src/models` is required: `config/env.js` reads the environment once, at load. */
Object.assign(process.env, SUITE_ENV);
const db = require('../src/models');
const baseline = require('../tests/baseline.json').suites;

const SHARES = [0.85, 0.6, 0.95];
const LOG_TABLES = new Set(['activity_logs', 'audit_logs']);
/* The line `parseOutput()` counts as one assertion. */
const ASSERTION = /^(PASS|FAIL) {2}.*? {2}-> {2}/;

const select = (sql) => db.sequelize.query(sql, { type: db.sequelize.QueryTypes.SELECT });

async function rowCounts() {
  const tables = await select(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'"
  );
  const counts = {};
  for (const { name } of tables) {
    // eslint-disable-next-line no-await-in-loop
    const [row] = await select(`SELECT COUNT(*) AS n FROM \`${name}\``);
    counts[name] = Number(row.n);
  }
  return counts;
}

/** Every table whose count moved, split into the ones judged and the log tables that are only shown. */
function delta(before, after) {
  const tables = {};
  const logs = {};
  for (const name of Object.keys(after)) {
    const change = after[name] - (before[name] || 0);
    if (change) (LOG_TABLES.has(name) ? logs : tables)[name] = change;
  }
  return { tables, logs };
}

/** Start a suite and SIGKILL it once it has printed `killAt` assertions. Resolves once it is gone. */
function runAndKill(script, killAt) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, script)], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, ...SUITE_ENV },
      windowsHide: true,
    });
    let printed = 0;
    let killed = false;
    let partial = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), SUITE_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop();
      for (const line of lines) {
        if (ASSERTION.test(line)) printed += 1;
        if (!killed && printed >= killAt) {
          killed = true;
          child.kill('SIGKILL');
        }
      }
    });
    child.stderr.resume();
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ printed, killed });
    });
  });
}

async function measure(script, control) {
  const expected = baseline[script] ? baseline[script].assertions : 0;
  const start = await rowCounts();

  let kill = { printed: 0, killed: false };
  let afterKill = { tables: {}, logs: {} };
  for (const share of control ? [Infinity] : SHARES) {
    // eslint-disable-next-line no-await-in-loop
    kill = await runAndKill(script, Math.max(1, Math.floor(expected * share)));
    // eslint-disable-next-line no-await-in-loop
    afterKill = delta(start, await rowCounts());
    /* Nothing printed means nothing to aim at; a smaller share would not land either. */
    if (!kill.killed || Object.keys(afterKill.tables).length) break;
  }

  const rerun = await runSuite(script);
  const left = delta(start, await rowCounts());
  const green =
    rerun.exitCode === 0 && rerun.failures === 0 && !rerun.skipped.length && !rerun.timedOut;

  let verdict = 'UNSAFE';
  if (control) verdict = 'CONTROL';
  else if (!kill.killed) verdict = 'NOT KILLED';
  else if (green && !Object.keys(left.tables).length) verdict = 'SAFE';

  return { script, expected, kill, afterKill, rerun, green, left, verdict };
}

function report(r) {
  const json = (value) => (Object.keys(value).length ? JSON.stringify(value) : 'none');
  const killedAt = r.kill.killed ? `killed at ${r.kill.printed}/${r.expected}` : `ran ${r.kill.printed}/${r.expected}`;
  console.log(
    `${r.verdict.padEnd(10)} ${r.script.padEnd(28)} ${killedAt.padEnd(18)}` +
      `  rerun: exit ${r.rerun.exitCode}, ${r.rerun.failures} FAIL` +
      `  left: ${json(r.left.tables)}  logs: ${json(r.afterKill.logs)} -> ${json(r.left.logs)}`
  );
  if (r.verdict === 'UNSAFE') {
    console.log(`           dead run left: ${json(r.afterKill.tables)}`);
    const fails = r.rerun.assertions.filter((a) => a.status === 'FAIL').slice(0, 10);
    for (const a of fails) console.log(`           FAIL  ${a.label}  ->  ${a.detail}`);
    /* A rerun that crashed prints no FAIL line; what it said on the way down is the evidence. */
    if (!fails.length) {
      const said = `${r.rerun.stderr}\n${r.rerun.stdout}`.split(/\r?\n/).filter((l) => /error/i.test(l));
      for (const line of said.slice(0, 3)) console.log(`           ${line.trim().slice(0, 200)}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const control = args.includes('--control');
  const onDisk = discoverSuites();
  const named = args
    .filter((arg) => arg !== '--control')
    .map((arg) => (arg.startsWith('verify-') ? arg : `verify-${arg}`))
    .map((arg) => (arg.endsWith('.js') ? arg : `${arg}.js`));
  const unknown = named.filter((script) => !onDisk.includes(script));
  if (unknown.length) throw new Error(`no such suite: ${unknown.join(', ')}`);

  const [{ name }] = await select('SELECT DATABASE() AS name');
  if (name !== EXPECTED_DATABASE) {
    throw new Error(`refusing to run: connected to "${name}", expected "${EXPECTED_DATABASE}"`);
  }

  acquireRunLock();
  const tally = {};
  try {
    for (const script of named.length ? named : onDisk) {
      // eslint-disable-next-line no-await-in-loop
      const result = await measure(script, control);
      tally[result.verdict] = (tally[result.verdict] || 0) + 1;
      report(result);
    }
  } finally {
    releaseRunLock();
  }
  console.log(`\n${Object.entries(tally).map(([verdict, n]) => `${n} ${verdict}`).join(', ')}`);
  if (tally.UNSAFE) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(`kill-test: ${err.message}`);
    process.exitCode = 2;
  })
  .finally(() => db.sequelize.close());
