'use strict';

/**
 * Queue + background jobs — SRS §25 "Background jobs", "Queue system"; §27 "Queue Workers".
 *
 * `enqueue(name, payload)` hands work off so the request thread returns immediately.
 * Handlers are registered by src/jobs/handlers/index.js and executed either in-process
 * (development) or by the dedicated worker (`npm run worker`, PM2 process in production).
 *
 * Driver `memory` keeps an in-process FIFO with bounded concurrency and retry/backoff.
 * SRS §29 forbids new tables, so there is no jobs table — durability across restarts is
 * provided by the cron reconciliation tasks, which re-derive any missed work from
 * application state (e.g. unsent notifications are re-picked from `notifications`).
 */

const config = require('./env');
const logger = require('./logger');
const { QUEUE_JOB_STATUS } = require('./constants');

/** @type {Map<string, (payload: any) => Promise<any>>} */
const handlers = new Map();

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

class MemoryQueue {
  constructor(concurrency) {
    this.concurrency = Math.max(1, concurrency);
    /** @type {Array<{id:string,name:string,payload:any,attempts:number}>} */
    this.pending = [];
    this.running = 0;
    this.seq = 0;
    this.stats = { enqueued: 0, completed: 0, failed: 0 };
    this.draining = null;
  }

  push(name, payload) {
    this.seq += 1;
    const job = { id: `job_${this.seq}`, name, payload, attempts: 0 };
    this.pending.push(job);
    this.stats.enqueued += 1;
    setImmediate(() => this.drain());
    return job.id;
  }

  async drain() {
    while (this.running < this.concurrency && this.pending.length) {
      const job = this.pending.shift();
      this.running += 1;
      // Deliberately not awaited: concurrency is governed by this.running.
      this.run(job).finally(() => {
        this.running -= 1;
        if (this.pending.length) setImmediate(() => this.drain());
      });
    }
  }

  async run(job) {
    const handler = handlers.get(job.name);
    if (!handler) {
      this.stats.failed += 1;
      logger.error('Queue job has no registered handler', { job: job.name });
      return;
    }
    job.attempts += 1;
    try {
      await handler(job.payload);
      this.stats.completed += 1;
      logger.debug('Queue job completed', { job: job.name, id: job.id });
    } catch (err) {
      if (job.attempts < MAX_ATTEMPTS) {
        const delay = BASE_BACKOFF_MS * 2 ** (job.attempts - 1);
        logger.warn('Queue job failed, retrying', {
          job: job.name,
          id: job.id,
          attempt: job.attempts,
          delay,
          error: err.message,
        });
        setTimeout(() => {
          this.pending.push(job);
          this.drain();
        }, delay).unref?.();
      } else {
        this.stats.failed += 1;
        logger.error('Queue job failed permanently', {
          job: job.name,
          id: job.id,
          attempts: job.attempts,
          error: err.message,
          stack: err.stack,
        });
      }
    }
  }

  /** Resolve once the queue is empty — used by tests. */
  async idle(timeoutMs = 15000) {
    const started = Date.now();
    while ((this.pending.length || this.running) && Date.now() - started < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

const queue = new MemoryQueue(config.queue.concurrency);

/** Register a job handler. Called once per job name at boot. */
function registerHandler(name, handler) {
  if (typeof handler !== 'function') {
    throw new Error(`Queue handler for "${name}" must be a function`);
  }
  handlers.set(name, handler);
}

/**
 * Hand a unit of work to the queue.
 * Never throws — a failing enqueue must not fail the user's request.
 * @returns {string|null} job id
 */
function enqueue(name, payload = {}) {
  try {
    return queue.push(name, payload);
  } catch (err) {
    logger.error('Failed to enqueue job', { job: name, error: err.message });
    return null;
  }
}

/**
 * Run a job inline, bypassing the queue. Used by the worker process and by tests
 * that need deterministic completion.
 */
async function runNow(name, payload = {}) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`No handler registered for job "${name}"`);
  return handler(payload);
}

function queueStats() {
  return {
    driver: config.queue.driver,
    concurrency: queue.concurrency,
    pending: queue.pending.length,
    running: queue.running,
    handlers: [...handlers.keys()],
    status: queue.pending.length || queue.running ? QUEUE_JOB_STATUS.PROCESSING : QUEUE_JOB_STATUS.PENDING,
    ...queue.stats,
  };
}

module.exports = {
  enqueue,
  runNow,
  registerHandler,
  queueStats,
  waitUntilIdle: (ms) => queue.idle(ms),
};
