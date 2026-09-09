'use strict';

/**
 * Queue job handlers — SRS §25 (Background jobs, Queue system), FR-PERF-001.
 *
 * `src/config/queue.js` has existed since August with `registerHandler()` and **no caller**, and its
 * own header names this file as where registration happens. `JOB_NAMES` has likewise had no consumer.
 * This is both.
 *
 * ## Four of the eight are registered, and the other four are not an oversight
 *
 * A handler must be able to **finish**. A job whose result nobody can collect has not been processed
 * in any sense a requirement would recognise, so registering one would be pretending.
 *
 * | Job | Registered | Why |
 * |---|---|---|
 * | `send_email` | ✅ | `mailService.send()` takes a plain message and completes |
 * | `send_notification` | ✅ | `notificationsService.notify()` takes a plain event and writes rows |
 * | `sync_usage` | ✅ | `usageService.syncAllSchoolHeadcounts()` reconciles §11.2's headcount limits |
 * | `database_backup` | ✅ | the §26 task, which writes a file and returns its path |
 * | `generate_report` | ❌ | produces a **Buffer with nowhere to go**. §22 streams it in the response; there is no storage profile and no file-serving route, so an async render completes into nothing |
 * | `generate_document` | ❌ | the same, for §20.5 |
 * | `ai_generate_questions` | ❌ | §21's workflow is a stage machine (`extract → analyze → generate → …`) driven by a request that advances one stage and returns the new state. There is no fire-and-forget step in it |
 * | `recalculate_results` | ❌ | `exams.recalculate()` refuses to run outside a caller transaction, by design — it is part of §19's publish orchestration, not a standalone unit |
 *
 * The queue already fails loudly for an unregistered name (`config/queue.js` logs
 * *"Queue job has no registered handler"* and counts it failed), so the four above are refused
 * visibly rather than silently swallowed.
 *
 * The three blocked on a **file-serving route** would become registrable the moment one exists —
 * that is the same missing piece `homework.attachment_path`, `documents.file_path` and
 * `results.result_card_path` are all waiting on.
 *
 * ## Handlers own their own failure
 *
 * A handler throws to tell the queue to retry: `config/queue.js` gives three attempts with
 * exponential backoff and then logs permanently. So nothing here catches its own errors — swallowing
 * one would consume the retry and report success.
 */

const { registerHandler } = require('../../config/queue');
const { JOB_NAMES } = require('../../config/constants');

const mailService = require('../../services/mailService');
const usageService = require('../../services/usageService');
const notificationsService = require('../../modules/notifications/notifications.service');
const databaseBackup = require('../tasks/databaseBackup');

/**
 * The registered handlers, as data.
 *
 * A map rather than eight `registerHandler()` calls so the set can be **asserted** — the failure
 * worth catching is a name registered under a string that is not one of `JOB_NAMES`, which no
 * individual call site would show.
 */
const HANDLERS = Object.freeze({
  /**
   * §7's password-reset and verification mails, handed off so a slow SMTP server does not hold a
   * user's request open. `mailService.send()` throws on an incomplete message — a defect in the
   * enqueuing code rather than a delivery failure — and that throw reaches the queue's retry, where
   * it is logged three times and then permanently. Loud, which is right for a caller-side defect.
   */
  [JOB_NAMES.SEND_EMAIL]: (payload) => mailService.send(payload),

  /**
   * §23's engine, for a caller that wants a notification raised without waiting. The sweeps do not
   * use this — they run in the scheduler, where blocking is the point — but `notify()` takes a
   * plain event object precisely because it has no request context, which is what makes it
   * enqueueable at all.
   */
  [JOB_NAMES.SEND_NOTIFICATION]: (payload) => notificationsService.notify(payload),

  /**
   * §11.2's headcount limits, reconciled against the rows they count. This is the one job that is
   * genuinely periodic rather than request-driven, and it is exactly what §25 means by a background
   * job: nobody is waiting for it and it touches every school.
   *
   * It used to call `syncAllHeadcounts()` — **with no argument**. That function's parameter is a
   * `schoolId` and its "All" means all limit *keys*, so the job passed `undefined` and would have
   * counted rows for no school at all. Unreachable, because nothing enqueues `sync_usage`, which is
   * why nothing noticed; the docblock above has always described the every-school behaviour the
   * registration did not have. `syncAllSchoolHeadcounts()` is that behaviour, and it reports which
   * schools failed rather than abandoning the rest at the first error.
   */
  [JOB_NAMES.SYNC_USAGE]: () => usageService.syncAllSchoolHeadcounts(),

  /** §26 / FR-BKP-001. Also scheduled by `cron.js`; this lets an operator trigger one off-schedule. */
  [JOB_NAMES.DATABASE_BACKUP]: (payload) => databaseBackup.run(payload || {}),
});

/** Job names deliberately left unregistered, with the reason. See the header table. */
const UNREGISTERED = Object.freeze({
  [JOB_NAMES.GENERATE_REPORT]: 'renders a Buffer with no storage or serving route to complete into',
  [JOB_NAMES.GENERATE_DOCUMENT]: 'renders a Buffer with no storage or serving route to complete into',
  [JOB_NAMES.AI_GENERATE_QUESTIONS]: '§21 is a request-driven stage machine with no fire-and-forget step',
  [JOB_NAMES.RECALCULATE_RESULTS]: 'exams.recalculate() requires the caller transaction it is part of',
});

let registered = false;

/**
 * Register every handler. Idempotent, because both the app and the worker call it and a process may
 * be both.
 *
 * @returns {Array<string>} the names now registered
 */
function registerAll() {
  if (!registered) {
    for (const [name, handler] of Object.entries(HANDLERS)) registerHandler(name, handler);
    registered = true;
  }
  return Object.keys(HANDLERS);
}

module.exports = { registerAll, HANDLERS, UNREGISTERED };
