'use strict';

/**
 * The job runner — SRS §25 (Queue system) and §27 (Queue Workers), FR-PERF-001 / FR-DEPLOY-001.
 *
 *   node src/jobs/worker.js --list                    print the registered handlers and exit
 *   node src/jobs/worker.js <job> [json-payload]      run one job now, in this process
 *   npm run worker -- database_backup
 *   npm run worker -- send_email '{"to":"a@b.test","subject":"x","text":"y"}'
 *
 * ## What this cannot be, and why saying so matters
 *
 * `package.json` has named `"worker": "node src/jobs/worker.js"` since it was written, and
 * `config/queue.js`'s header describes handlers being executed *"either in-process (development) or
 * by the dedicated worker (`npm run worker`, PM2 process in production)"*.
 *
 * **That second half is not achievable with the queue as it stands, and this file will not pretend
 * otherwise.** The queue is a `MemoryQueue` instance living in one process's memory. A separate
 * worker process gets its own instance, empty, and cannot see a job the API process enqueued —
 * there is no shared store between them. Making it possible needs somewhere durable to put a pending
 * job, and **§29 fixes the schema at 64 tables while §35 forbids a 65th**, which is the same wall
 * `cron.js` documents.
 *
 * `queue.js` itself already resolved that tension for the work that matters: *"durability across
 * restarts is provided by the cron reconciliation tasks, which re-derive any missed work from
 * application state"*. §2ab built those. So the division is:
 *
 * - **In-process queueing** (`enqueue()`), for handing a request's slow I/O off the response path.
 *   `ENABLE_WORKER` governs it and the API process drains its own queue.
 * - **The cron sweeps**, for anything that must survive a restart.
 * - **This file**, for running one job on demand from a shell — an operator triggering a backup, or
 *   reproducing a handler's behaviour outside the API.
 *
 * A worker that consumed the API's queue would need a `jobs` table. Recording that is more useful
 * than shipping a process that starts, finds an empty queue, and idles for ever looking healthy.
 */

const { registerAll, HANDLERS, UNREGISTERED } = require('./handlers');
const { runNow, queueStats } = require('../config/queue');
const logger = require('../config/logger');

function list() {
  const width = Math.max(...Object.keys(HANDLERS).map((n) => n.length));
  const registered = Object.keys(HANDLERS)
    .map((n) => `  ${n.padEnd(width)}  registered`)
    .join('\n');
  const refused = Object.entries(UNREGISTERED)
    .map(([n, why]) => `  ${n.padEnd(width)}  NOT registered — ${why}`)
    .join('\n');
  return `${registered}\n${refused}`;
}

module.exports = { list };

/* ─────────────────────────────── entry point ─────────────────────────────── */

if (require.main === module) {
  const [name, rawPayload] = process.argv.slice(2);

  const finish = async (code) => {
    const models = require.cache[require.resolve('../models')];
    if (models) await models.exports.sequelize.close().catch(() => {});
    process.exit(code);
  };

  registerAll();

  if (!name || name === '--list') {
    console.log(`\nQueue handlers:\n${list()}\n`);
    console.log(`Queue: ${JSON.stringify(queueStats())}\n`);
    process.exit(0);
  }

  if (!HANDLERS[name]) {
    const why = UNREGISTERED[name];
    console.error(
      why
        ? `\n"${name}" is a known job name but has no handler: ${why}.\n`
        : `\nUnknown job "${name}".\n\nAvailable:\n${list()}\n`
    );
    process.exit(1);
  }

  let payload = {};
  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload);
    } catch (err) {
      /* Refused rather than run with `{}` — a mistyped payload silently becoming an empty one is how
         an operator ends up believing they ran something they did not. */
      console.error(`\nPayload is not valid JSON: ${err.message}\n`);
      process.exit(1);
    }
  }

  /*
   * `runNow` rather than `enqueue`: this process is the one that would drain the queue, so pushing
   * and then waiting for itself adds a scheduler between the operator and the answer. Running inline
   * means the exit code reports the job's own outcome.
   */
  runNow(name, payload)
    .then(async (result) => {
      console.log(JSON.stringify({ job: name, ok: true, result }, null, 2));
      await finish(0);
    })
    .catch(async (err) => {
      logger.error('worker: job failed', { job: name, error: err.message });
      console.error(`\n${name} failed: ${err.message}\n`);
      await finish(1);
    });
}
