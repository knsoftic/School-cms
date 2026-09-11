'use strict';

/**
 * The scheduler — SRS §25 (Background jobs) and §27 (Cron Jobs), FR-PERF-001 and FR-DEPLOY-001.
 *
 *   npm run cron                        schedule everything and stay resident
 *   node src/jobs/cron.js --once        run every task once, print a report, exit
 *   node src/jobs/cron.js --once --only=notification-dispatch,invoice-overdue
 *   node src/jobs/cron.js --list        print the schedule and exit
 *
 * `package.json` has declared `"cron": "node src/jobs/cron.js"` since it was written, and until now
 * there was no such file. Four sweeps were waiting for it — each deliberately routeless, because
 * each has `System` for an actor:
 *
 * | Task | Waiting since | Why it has no route |
 * |---|---|---|
 * | `subscription-lifecycle` | §12.5 | FR-SUB-015's renewals are date-driven, not user-driven |
 * | `invoice-issue` | FR-BILL-001 | its actor is `System`; owner decision D6 made "a billing event" a period starting |
 * | `invoice-overdue` | §13.1 | an invoice goes overdue by the clock — and, since D23, its subscription past due |
 * | `fee-fines` | §17, D29 | a fee's fine applies by the clock once it is late |
 * | `coupon-expiry` | §13.2 | so does a coupon |
 * | `notification-dispatch` | §23 | FR-NOTIF-001's actor is `System`; §29 gave five tables a marker column whose comments name a *cron* |
 *
 * plus `database-backup` for §26 / FR-BKP-001.
 *
 * ## Order is a dependency, not a preference
 *
 * `ORDER` is not the schedule — it is the sequence a `--once` run uses, and it exists because
 * **`notification-dispatch` must follow `subscription-lifecycle`.** §23's Subscription Expiry pass
 * notifies subscriptions in state `expiring`, and that state is written by `runLifecycleSweep()`.
 * Reversed, a school is warned one whole cycle late.
 *
 * Cron expressions cannot express that: two entries that both fire on the hour run in whatever order
 * node-cron happens to hold them. So anything depending on order uses `--once`, and
 * `notification-dispatch` runs four times an hour rather than relying on winning a race.
 *
 * ## Why the tasks are run here and not enqueued
 *
 * §25 names a *Queue system* beside Background jobs, and `src/config/queue.js` already implements
 * one — an in-process FIFO with bounded concurrency, retry and backoff. It has no consumers yet, and
 * its own header explains the constraint and the answer to it:
 *
 *   > *"SRS §29 forbids new tables, so there is no jobs table — durability across restarts is
 *   > provided by the cron reconciliation tasks, which re-derive any missed work from application
 *   > state (e.g. unsent notifications are re-picked from `notifications`)."*
 *
 * **This file is those reconciliation tasks.** That is the whole reason the sweeps are idempotent and
 * driven by marker columns rather than by events: a restart loses whatever the in-memory queue held,
 * and the next sweep re-derives it from `notified_at`, `announced_at`, `alert_sent_at`,
 * `reminder_sent_at` and `expiry_notified_at`. So the durability of the queue is not a gap here — it
 * is delegated to these five tasks by design, and running them directly is the point rather than a
 * shortcut around the queue.
 *
 * What is still open is `src/jobs/handlers/` and `src/jobs/worker.js`, which `queue.js` and
 * `package.json` both name and neither of which exists. The eight `JOB_NAMES` are their vocabulary
 * and remain unconsumed.
 *
 * ## `ENABLE_CRON`
 *
 * Resident mode refuses to start unless `ENABLE_CRON=true`. Two processes sweeping one database
 * would double-notify and race the renewals, so opting in is per-deployment and explicit. `--once`
 * ignores the flag: running it is already the operator saying so.
 */

const cron = require('node-cron');

const config = require('../config/env');
const logger = require('../config/logger');

/**
 * The run order. See the header — this encodes a real dependency, and the array is the only place
 * it is stated.
 */
const ORDER = Object.freeze([
  require('./tasks/subscriptionLifecycle'),
  /* After the lifecycle sweep: a renewal is what opens the period this invoices. */
  require('./tasks/invoiceIssue'),
  require('./tasks/notificationDispatch'),
  require('./tasks/invoiceOverdue'),
  require('./tasks/feeFines'),
  require('./tasks/couponExpiry'),
  require('./tasks/quotationExpiry'),
  require('./tasks/databaseBackup'),
]);

const TASKS = Object.freeze(
  ORDER.reduce((map, task) => Object.assign(map, { [task.name]: task }), {})
);

/** Tasks currently executing, so a slow sweep is skipped rather than overlapped. */
const running = new Set();

/**
 * How long a single task may take before it is treated as failed.
 *
 * This exists because of a bug this file's own backup task shipped with: a promise that never
 * settled. `child.stdout.pipe(out)` ends the write stream by itself, so a listener attached later
 * never fired, and the task hung for ever — the dump complete on disk, no error, and the process
 * exiting **0** with an empty event loop.
 *
 * That bug is fixed, but its *class* is not survivable without a bound. A task that never settles
 * holds its name in `running` for the life of the process, so every later tick of that task is
 * skipped: one hung sweep silently stops all future runs of itself. Ten minutes is far longer than
 * any task here takes — the slowest, the backup, is under a second on this schema — and short
 * enough that a wedged scheduler recovers on the next tick rather than never.
 */
const TASK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Reject if `promise` has not settled within `ms`.
 *
 * The underlying work is not cancelled — nothing here can cancel a half-written `mysqldump` — so
 * this bounds the *scheduler's* wait, not the task. That is the useful half: the run continues, the
 * failure is reported, and the next tick is free to try again.
 */
function withTimeout(promise, ms, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`task "${name}" did not finish within ${ms}ms`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Run tasks in `ORDER`, one at a time.
 *
 * Sequential on purpose. Concurrently, `notification-dispatch` could read `expiring` before
 * `subscription-lifecycle` has written it — the dependency the header describes — and two sweeps
 * writing the same rows is the situation this section exists to avoid.
 *
 * A task that throws is logged and the run continues, which is `runLifecycleSweep()`'s own rule for
 * one bad subscription applied one level up: a failing backup must not stop the notifications.
 *
 * @param {object} [options]
 * @param {Array<string>} [options.only]  names to run; default all
 * @param {Date} [options.at]             passed to each task, so a suite can drive dates
 * @param {number} [options.taskTimeoutMs]  overrides TASK_TIMEOUT_MS, so a suite can prove the
 *                                          bound without waiting ten minutes
 * @returns {Promise<{at:string,ran:Array,failed:Array,skipped:Array}>}
 */
async function runOrdered(options = {}) {
  const at = options.at || new Date();
  const wanted = options.only && options.only.length ? new Set(options.only) : null;
  const report = { at: at.toISOString(), ran: [], failed: [], skipped: [] };

  for (const task of ORDER) {
    if (wanted && !wanted.has(task.name)) continue;

    if (running.has(task.name)) {
      /* Still going from the previous tick. Skipping is right: every task here is idempotent, so the
         next tick picks up whatever this one misses, and queueing would only deepen the backlog. */
      report.skipped.push(task.name);
      logger.warn('cron: task still running, skipped', { task: task.name });
      continue;
    }

    running.add(task.name);
    const started = Date.now();
    try {
      /* eslint-disable-next-line no-await-in-loop */
      const summary = await withTimeout(
        task.run({ at }),
        options.taskTimeoutMs || TASK_TIMEOUT_MS,
        task.name
      );
      report.ran.push({ task: task.name, ms: Date.now() - started, summary });
      logger.info('cron: task finished', { task: task.name, ms: Date.now() - started });
    } catch (err) {
      report.failed.push({ task: task.name, error: err.message });
      logger.error('cron: task failed', { task: task.name, error: err.message });
    } finally {
      running.delete(task.name);
    }
  }

  return report;
}

/**
 * Schedule everything and stay resident.
 *
 * Each task gets its own `node-cron` entry, but the callback runs it through `runOrdered` so the
 * skip-if-running rule and the logging are identical in both modes. Ordering between tasks that fire
 * on the same tick is not guaranteed by cron — which is why `--once` exists for anything depending
 * on it, and why `notification-dispatch` runs four times an hour rather than relying on winning a
 * race.
 */
function schedule() {
  const scheduled = [];

  for (const task of ORDER) {
    if (!cron.validate(task.schedule)) {
      throw new Error(`cron: task "${task.name}" has an invalid schedule "${task.schedule}"`);
    }
    const job = cron.schedule(task.schedule, () => {
      runOrdered({ only: [task.name] }).catch((err) => {
        logger.error('cron: unhandled task error', { task: task.name, error: err.message });
      });
    });
    scheduled.push({ name: task.name, schedule: task.schedule, job });
  }

  logger.info('cron: scheduler started', { tasks: scheduled.map((s) => `${s.name}@${s.schedule}`) });
  return scheduled;
}

function list() {
  const width = Math.max(...ORDER.map((t) => t.name.length));
  return ORDER.map((t) => `  ${t.name.padEnd(width)}  ${t.schedule.padEnd(14)}  ${t.description}`)
    .join('\n');
}

module.exports = { ORDER, TASKS, runOrdered, schedule, list, TASK_TIMEOUT_MS };

/* ─────────────────────────────── entry point ─────────────────────────────── */

if (require.main === module) {
  const argv = process.argv.slice(2);
  const has = (flag) => argv.includes(flag);
  const valueOf = (prefix) => {
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length).split(',').filter(Boolean) : null;
  };

  const finish = async (code) => {
    const models = require.cache[require.resolve('../models')];
    if (models) await models.exports.sequelize.close().catch(() => {});
    process.exit(code);
  };

  if (has('--list')) {
    console.log(`\nScheduled tasks (run order):\n${list()}\n`);
    process.exit(0);
  } else if (has('--once')) {
    const only = valueOf('--only=');
    const unknown = (only || []).filter((name) => !TASKS[name]);
    if (unknown.length) {
      console.error(`unknown task(s): ${unknown.join(', ')}\n\nAvailable:\n${list()}\n`);
      process.exit(1);
    }
    runOrdered({ only })
      .then(async (report) => {
        console.log(JSON.stringify(report, null, 2));
        await finish(report.failed.length ? 1 : 0);
      })
      .catch(async (err) => {
        console.error(`cron --once failed: ${err.message}`);
        await finish(1);
      });
  } else if (!config.cron.enabled) {
    console.error(
      '\nENABLE_CRON is not true, so the resident scheduler will not start.\n'
      + 'Two schedulers against one database would double-notify and race the renewals, so this is\n'
      + 'opt-in per deployment. Use --once to run the tasks now.\n'
    );
    process.exit(1);
  } else {
    schedule();
    /* Resident. node-cron holds the event loop; SIGTERM is left to the process manager (§27's PM2). */
  }
}
