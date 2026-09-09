'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *   BACKUP_DIR         a directory of this suite's own, so a real mysqldump never touches the
 *                      operator's backups and retention pruning has nothing of theirs to delete.
 *   MAIL_DRIVER=log    the notification task really dispatches; smtp would open connections.
 *   ENABLE_CRON        left alone on purpose — Part 2 asserts the gate's default.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-jobs-'));
process.env.BACKUP_DIR = SANDBOX;
process.env.MAIL_DRIVER = 'log';
process.env.RATE_LIMIT_MAX = '100000';

/**
 * Verification of Phase 5 — the scheduler — `src/jobs/*` — SRS §25 (Background jobs), §26
 * (FR-BKP-001) and §27 (Cron Jobs), FR-PERF-001 / FR-DEPLOY-001.
 *
 * ## What this section is, and why it could not be tested before it existed
 *
 * `package.json` has declared `"cron": "node src/jobs/cron.js"` since it was written. Four sweeps
 * were waiting on that file, each deliberately routeless because each has `System` for an actor:
 * `runLifecycleSweep()`, `markOverdue()`, `expireLapsed()` and — since §23 — `runNotificationSweep()`.
 * Every one of them is already verified in its own suite. What was never verified is that anything
 * *calls* them, in the right order, and survives one of them failing.
 *
 * ## The assertion that matters most is the ordering one
 *
 * `notification-dispatch` must run after `subscription-lifecycle`, because §23's Subscription Expiry
 * pass notifies subscriptions in state `expiring` and that state is written by the lifecycle sweep.
 * Asserting the two names' positions in an array would be weak — and would fall for the trap §5a has
 * caught twice, where `indexOf(a) < indexOf(b)` is satisfied by *deleting* `a`. So Part 3 proves it
 * **end to end instead**: a subscription is planted that is not yet `expiring`, one ordered run is
 * made, and the notification must exist afterwards. That can only pass if the lifecycle sweep ran
 * first, in the same pass.
 *
 * ## The backup is exercised for real
 *
 * `mysqldump` really runs, into a sandbox directory this suite creates and removes. A dump is
 * asserted to be restorable in the only way a suite can cheaply check — every table the models
 * declare appears as a `CREATE TABLE`, plus `sequelize_meta`, which is not a model but is exactly
 * what a restore needs to know which migrations the dump already contains.
 *
 * Retention is driven by backdating files' mtimes rather than waiting a month, and the negative is
 * asserted beside the positive: a file the task did not write is left alone even when it is older
 * than the window.
 *
 * Part 1 — the task contract (no database).
 * Part 2 — the entry point's arguments and the ENABLE_CRON gate.
 * Part 3 — every task run for real, including a real mysqldump.
 *
 * Run: node scripts/verify-jobs.js
 */

const { execFileSync } = require('child_process');

const db = require('../src/models');
const config = require('../src/config/env');
const cronModule = require('../src/jobs/cron');
const backupTask = require('../src/jobs/tasks/databaseBackup');
const dates = require('../src/utils/dates');
const {
  SUBSCRIPTION_STATES, NOTIFICATION_TYPES, NOTIFICATION_CHANNELS,
  PLAN_STATUS, MODULE_LIST, ROLES, USER_STATUS, JOB_NAMES,
} = require('../src/config/constants');
const { hashPassword } = require('../src/utils/tokens');

const CODE_PREFIX = 'VJB-';
const DOMAIN = 'verify-jobs.local';
const PASSWORD = 'Verify@Jobs123';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let failures = 0;
let dbSkipped = false;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${
      ok ? '' : `  (expected ${JSON.stringify(expected)})`
    }`
  );
}

/* ═══════════════════════════ part 1 — the task contract ═══════════════════════════ */

function verifyContract() {
  console.log('\n── Part 1 — the task contract ──\n');

  const names = cronModule.ORDER.map((t) => t.name);

  /*
   * The whole array, not an ordering comparison. `indexOf(a) < indexOf(b)` is satisfied by deleting
   * `a`, because indexOf returns -1 — the defect §5a recorded in session 22 and again in §21. An
   * array literal pins presence and order together and no deletion can satisfy it.
   */
  check('five tasks, in the order a --once run uses',
    names,
    ['subscription-lifecycle', 'notification-dispatch', 'invoice-overdue', 'coupon-expiry',
      'database-backup']);
  check('  and notification-dispatch follows subscription-lifecycle, which is a real dependency',
    names.slice(0, 2), ['subscription-lifecycle', 'notification-dispatch']);
  check('  every name is unique', new Set(names).size, names.length);

  check('every task declares the whole contract',
    cronModule.ORDER.filter((t) => !(t.name && t.schedule && t.description && typeof t.run === 'function')),
    []);

  const cron = require('node-cron');
  check('every schedule is a valid cron expression, checked by the library that will run them',
    cronModule.ORDER.filter((t) => !cron.validate(t.schedule)).map((t) => t.name), []);

  check('the lookup map holds exactly the ordered tasks',
    Object.keys(cronModule.TASKS).sort(), [...names].sort());

  const listing = cronModule.list();
  check('--list names every task, its schedule and what it is for',
    names.filter((n) => !listing.includes(n)), []);
  check('  and shows each schedule',
    cronModule.ORDER.filter((t) => !listing.includes(t.schedule)).map((t) => t.name), []);

  /*
   * `JOB_NAMES` is the QUEUE's vocabulary, not the scheduler's. `src/config/queue.js` already
   * implements an in-process FIFO and states the constraint these tasks exist to answer: §29 forbids
   * a jobs table, so *"durability across restarts is provided by the cron reconciliation tasks,
   * which re-derive any missed work from application state"*. These five tasks are those tasks — the
   * marker columns are what make re-derivation possible after a restart loses the queue.
   */
  check('the eight JOB_NAMES are the queue\'s vocabulary and none of them is a scheduled task',
    Object.values(JOB_NAMES).filter((j) => names.includes(j)), []);
  check('  and there is still nowhere to persist a pending job: the schema is exactly 64 tables',
    Object.keys(db).filter((k) => db[k] && db[k].tableName).length, 64);
  check('  the queue exists and is unconsumed, which is why these tasks carry the durability',
    Object.keys(require('../src/config/queue')).sort(),
    ['enqueue', 'queueStats', 'registerHandler', 'runNow', 'waitUntilIdle']);
}

/* ═══════════════════════ part 2 — the entry point and the gate ═══════════════════════ */

function verifyQueue() {
  console.log('');
  console.log('── Part 1b — the queue handlers and the worker ──');
  console.log('');

  const handlers = require('../src/jobs/handlers');
  const queue = require('../src/config/queue');
  const worker = require('../src/jobs/worker');

  const registered = handlers.registerAll();
  check('registerAll() registers the four job names that can complete',
    [...registered].sort(),
    ['database_backup', 'send_email', 'send_notification', 'sync_usage']);
  check('  and is idempotent, because the app and the worker both call it',
    [...handlers.registerAll()].sort(), [...registered].sort());

  /*
   * Every one of SRS 25's eight job names is accounted for -- registered, or refused with a reason.
   * A name in neither map is the failure worth catching: it would enqueue, find no handler, and be
   * counted failed with nothing saying why that was expected.
   */
  const accounted = [...Object.keys(handlers.HANDLERS), ...Object.keys(handlers.UNREGISTERED)];
  check('all eight JOB_NAMES are accounted for -- registered or refused with a reason',
    Object.values(JOB_NAMES).filter((n) => !accounted.includes(n)), []);
  check('  and nothing is registered under a name JOB_NAMES does not contain',
    Object.keys(handlers.HANDLERS).filter((n) => !Object.values(JOB_NAMES).includes(n)), []);
  check('  the four refused ones each carrying why',
    Object.values(handlers.UNREGISTERED).filter((why) => !why || why.length < 20), []);


  /*
   * The two refused for want of somewhere to put a rendered Buffer are blocked on the same missing
   * file-serving route that homework.attachment_path, documents.file_path and
   * results.result_card_path all wait on. Pinned, so that when that route is built this assertion is
   * what says these can now be registered.
   */
  check('  two of them blocked on the same missing thing: somewhere to put a rendered Buffer',
    [handlers.UNREGISTERED[JOB_NAMES.GENERATE_REPORT],
      handlers.UNREGISTERED[JOB_NAMES.GENERATE_DOCUMENT]]
      .filter((why) => !/no storage or serving route/.test(why || '')), []);

  check('the queue is the in-memory driver, which is what bounds what a worker can be',
    queue.queueStats().driver, 'memory');

  const listing = worker.list();
  check('the worker lists every job name, registered and refused alike',
    Object.values(JOB_NAMES).filter((n) => !listing.includes(n)), []);
  check('  marking the refused ones as such', /NOT registered/.test(listing), true);
}

function verifyEntryPoint() {
  console.log('\n── Part 2 — the entry point and the ENABLE_CRON gate ──\n');

  const node = process.execPath;
  const entry = path.join(__dirname, '..', 'src', 'jobs', 'cron.js');
  const run = (args, env = {}) => {
    try {
      /*
       * `timeout` is load-bearing, not caution. Every invocation here is expected to exit, but the
       * one being tested is the gate that stops resident mode from starting — and if that gate is
       * broken, the child schedules its tasks and stays alive for ever. Without a timeout the suite
       * hangs instead of failing, which a deliberate regression demonstrated: it ran for the full
       * ten minutes and took the rest of the regression pass down with it.
       */
      const stdout = execFileSync(node, [entry, ...args], {
        encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000, killSignal: 'SIGKILL',
      });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
  };

  const listed = run(['--list']);
  check('--list exits 0 and prints the schedule', [listed.code, listed.stdout.includes('database-backup')],
    [0, true]);

  /*
   * The gate, asserted from both sides. Two schedulers against one database would double-notify and
   * race the renewals, so resident mode is opt-in — and refusing must be visible, not silent.
   */
  const gated = run([], { ENABLE_CRON: 'false' });
  check('resident mode refuses without ENABLE_CRON, and says why',
    [gated.code, /ENABLE_CRON is not true/.test(gated.stderr)], [1, true]);
  check('  and the default is off, so a stray run cannot sweep a live database',
    config.cron.enabled, false);

  /* ── the worker process ── */

  const workerEntry = path.join(__dirname, '..', 'src', 'jobs', 'worker.js');
  const runWorker = (args) => {
    try {
      return { code: 0, stdout: execFileSync(node, [workerEntry, ...args], {
        encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
      }) };
    } catch (err) {
      return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
  };

  const workerList = runWorker(['--list']);
  check('the worker lists its handlers and exits 0',
    [workerList.code, workerList.stdout.includes('send_email')], [0, true]);

  /*
   * A known job name with no handler is refused *with its reason*, not treated as a typo. The two
   * failure modes need different answers from an operator: one is "you misspelled it", the other is
   * "this cannot be run yet, and here is what is missing".
   */
  const workerBlocked = runWorker(['generate_report']);
  check('a known but unregistered job is refused with the reason, not as a typo',
    [workerBlocked.code, /no storage or serving route/.test(workerBlocked.stderr)], [1, true]);
  const workerUnknown = runWorker(['not_a_job_at_all']);
  check('  while an unknown name is refused as unknown',
    [workerUnknown.code, /Unknown job/.test(workerUnknown.stderr)], [1, true]);
  const workerBadJson = runWorker(['send_email', '{not json']);
  check('  and a malformed payload is refused rather than run as an empty one',
    [workerBadJson.code, /not valid JSON/.test(workerBadJson.stderr)], [1, true]);

  const unknown = run(['--once', '--only=not-a-task']);
  check('an unknown task name is refused rather than silently running nothing',
    [unknown.code, /unknown task/.test(unknown.stderr)], [1, true]);
  check('  and the refusal lists what is available',
    /subscription-lifecycle/.test(unknown.stderr), true);
}

/* ═══════════════════════════ part 3 — every task, for real ═══════════════════════════ */

async function verifyExecution() {
  console.log('\n── Part 3 — every task run for real ──\n');

  const created = { schools: [], organizations: [], plans: [], subscriptions: [], users: [] };
  const baseline = {
    notification: (await db.Notification.max('id')) || 0,
    activityLog: (await db.ActivityLog.max('id')) || 0,
    auditLog: (await db.AuditLog.max('id')) || 0,
  };

  async function teardown() {
    await db.Notification.destroy({ where: { id: { [db.Op.gt]: baseline.notification } } });
    const ownTenant = [
      ...(created.schools.length ? [{ school_id: created.schools }] : []),
      ...(created.organizations.length ? [{ organization_id: created.organizations }] : []),
      ...(created.users.length ? [{ user_id: created.users }] : []),
    ];
    if (ownTenant.length) {
      await db.ActivityLog.destroy({
        where: { id: { [db.Op.gt]: baseline.activityLog }, [db.Op.or]: ownTenant },
      });
      await db.AuditLog.destroy({
        where: { id: { [db.Op.gt]: baseline.auditLog }, [db.Op.or]: ownTenant },
      });
    }
    if (created.subscriptions.length) {
      await db.SubscriptionHistory.destroy({ where: { subscription_id: created.subscriptions } });
      await db.UsageRecord.destroy({ where: { subscription_id: created.subscriptions } });
      await db.Subscription.destroy({ where: { id: created.subscriptions }, force: true });
    }
    await db.User.destroy({ where: { email: { [db.Op.like]: `%@${DOMAIN}` } }, force: true });
    if (created.plans.length) {
      await db.PlanModule.destroy({ where: { plan_id: created.plans } });
      await db.PlanLimit.destroy({ where: { plan_id: created.plans } });
      await db.SubscriptionPlan.destroy({ where: { id: created.plans }, force: true });
    }
    /*
     * By id AND by prefix. The ids cover the normal path; the prefix covers a run that crashed
     * before `created` was populated, which would otherwise leave a row whose unique `code` makes
     * every later run fail on insert. A previous regression pass did exactly that.
     */
    await db.School.destroy({
      where: { [db.Op.or]: [
        ...(created.schools.length ? [{ id: created.schools }] : []),
        { code: { [db.Op.like]: `${CODE_PREFIX}%` } },
      ] },
      force: true,
    });
    await db.SubscriptionPlan.destroy({
      where: { code: { [db.Op.like]: `${CODE_PREFIX}%` } }, force: true,
    });
    await db.Organization.destroy({
      where: { [db.Op.or]: [
        ...(created.organizations.length ? [{ id: created.organizations }] : []),
        { code: { [db.Op.like]: `${CODE_PREFIX}%` } },
      ] },
      force: true,
    });
  }

  /* Clear anything a previously crashed run left behind, before this one plants its own. */
  await teardown();

  try {
    /* ── the fixture: a subscription the lifecycle sweep will move to `expiring` ── */

    const at = new Date('2026-06-15T09:00:00Z');

    const org = await db.Organization.create({ name: 'Verify Jobs Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);
    const school = await db.School.create({
      organization_id: org.id, name: 'Verify Jobs School', code: `${CODE_PREFIX}S`,
    });
    created.schools.push(school.id);

    const plan = await db.SubscriptionPlan.create({
      name: 'Verify Jobs Plan', code: `${CODE_PREFIX}P`, status: PLAN_STATUS.ACTIVE,
      tier_rank: 1, trial_days: 0, grace_period_days: 7,
    });
    created.plans.push(plan.id);
    for (const key of MODULE_LIST) {
      // eslint-disable-next-line no-await-in-loop
      await db.PlanModule.create({ plan_id: plan.id, module_key: key, is_enabled: true });
    }

    const principalRole = await db.Role.findOne({ where: { slug: ROLES.PRINCIPAL } });
    const password_hash = await hashPassword(PASSWORD);
    const principal = await db.User.create({
      role_id: principalRole.id, organization_id: org.id, school_id: school.id,
      name: 'Verify Jobs Principal', email: `principal@${DOMAIN}`, username: 'vjb_principal',
      password_hash, status: USER_STATUS.ACTIVE, must_change_password: false,
    });
    created.users.push(principal.id);

    /*
     * `active`, with three days left. The lifecycle sweep's expiring window is seven days, so this
     * run is what moves it to `expiring` — and only then can §23's Subscription Expiry pass see it.
     * Planted as `active` on purpose: if the notification appears, the lifecycle sweep MUST have run
     * first, in the same pass. That is the ordering proof.
     */
    const subscription = await db.Subscription.create({
      school_id: school.id, organization_id: org.id, plan_id: plan.id,
      state: SUBSCRIPTION_STATES.ACTIVE, billing_cycle: 'monthly', cycle_days: 30,
      pricing_model: 'fixed', currency: 'USD', cycle_amount: 100, quantity: 1,
      starts_at: dates.addDays(at, -27), current_period_start: dates.addDays(at, -27),
      current_period_end: dates.addDays(at, 3), renewal_mode: 'manual',
    });
    created.subscriptions.push(subscription.id);

    check('the fixture starts ACTIVE, so nothing can notify about it yet',
      subscription.state, SUBSCRIPTION_STATES.ACTIVE);

    /* ── one ordered run ── */

    /*
     * A minute, not the ten-minute default. Every task here finishes in under a second, so the only
     * thing this bound can catch is a task that never settles — and when that happened for real, the
     * suite hung and Node exited 0 in silence. Bounding it turns that into a named failure a minute
     * later instead of a run nobody can interpret.
     */
    const SUITE_TASK_TIMEOUT_MS = 60000;
    const report = await cronModule.runOrdered({ at, taskTimeoutMs: SUITE_TASK_TIMEOUT_MS });

    check('every task ran and none failed',
      [report.ran.map((r) => r.task), report.failed, report.skipped],
      [['subscription-lifecycle', 'notification-dispatch', 'invoice-overdue', 'coupon-expiry',
        'database-backup'], [], []]);
    check('  and each carries the summary its own module returns',
      report.ran.every((r) => r.summary && typeof r.summary === 'object'), true);

    /*
     * The bug this assertion exists for: `database-backup` used to be ABSENT from `ran` — its
     * promise never settled, because `child.stdout.pipe(out)` ends the write stream by itself, so
     * `out`'s `close` had already fired before a listener was attached inside the child's `close`.
     * Node then exits 0 with an empty event loop: a complete dump on disk, no error, and a task that
     * silently had not finished. Asserting the report CONTAINS it is what catches that.
     */
    check('the backup is in the report, not merely on disk — a task that never settles exits 0',
      report.ran.some((r) => r.task === 'database-backup'), true);

    /* ── the ordering, proved end to end ── */

    await subscription.reload();
    check('the lifecycle sweep moved the subscription into `expiring`',
      subscription.state, SUBSCRIPTION_STATES.EXPIRING);

    const expiryNotices = await db.Notification.findAll({
      where: {
        id: { [db.Op.gt]: baseline.notification },
        type: NOTIFICATION_TYPES.SUBSCRIPTION_EXPIRY,
        reference_id: subscription.id,
        channel: NOTIFICATION_CHANNELS.IN_APP,
      },
    });
    check('and the SAME pass notified the school about it — which is only possible if '
      + 'subscription-lifecycle ran before notification-dispatch',
      expiryNotices.length > 0, true);
    check('  addressed to the principal, not to a student',
      [...new Set(expiryNotices.map((n) => n.user_id))], [principal.id]);

    /* ── running it again notifies nobody: both halves are idempotent ── */

    const countExpiryNotices = () => db.Notification.count({
      where: {
        id: { [db.Op.gt]: baseline.notification },
        type: NOTIFICATION_TYPES.SUBSCRIPTION_EXPIRY,
        reference_id: subscription.id,
        channel: NOTIFICATION_CHANNELS.IN_APP,
      },
    });
    const afterFirst = await countExpiryNotices();
    const second = await cronModule.runOrdered({
      at: dates.addDays(at, 1), only: ['subscription-lifecycle', 'notification-dispatch'],
      taskTimeoutMs: SUITE_TASK_TIMEOUT_MS,
    });
    check('a second ordered run notifies nobody again — `expiry_notified_at`, now written by §23 '
      + 'rather than pre-stamped by the lifecycle sweep, is what stops it',
      [second.failed, await countExpiryNotices()], [[], afterFirst]);
    check('  and the marker is set, which is the thing that stops it',
      (await subscription.reload()).expiry_notified_at !== null, true);

    /* ── one task failing must not stop the rest ── */

    const backup = cronModule.TASKS['database-backup'];
    const realRun = backup.run;
    backup.run = async () => { throw new Error('deliberate backup failure'); };
    /*
     * Read defensively. If `runOrdered` ever lets a task's exception escape — the very thing this
     * assertion exists to forbid — an unguarded `await` would abort the suite with a crash instead
     * of a named failure, and §5a records that a crash is a detection but a poor one. Catching it
     * here turns that regression into a FAIL that says which guard went.
     */
    let resilient;
    try {
      resilient = await cronModule.runOrdered({ at, taskTimeoutMs: SUITE_TASK_TIMEOUT_MS });
    } catch (err) {
      resilient = { ran: [], failed: [{ task: 'ESCAPED', error: err.message }], skipped: [] };
    } finally {
      backup.run = realRun;
    }
    check('a failing task is recorded and the others still ran — a broken backup must not stop '
      + 'the notifications',
      [resilient.failed.map((f) => f.task), resilient.ran.length], [['database-backup'], 4]);
    check('  and the failure carries the reason',
      resilient.failed[0].error, 'deliberate backup failure');

    /*
     * A task that never settles must be reported, not waited on for ever.
     *
     * This is the bound on the bug the backup task shipped with. Without it a hung task holds its
     * name in `running` for the life of the process, so every later tick of that task is skipped —
     * one wedged sweep silently stops all future runs of itself. It is also the only defect in this
     * section a suite CANNOT otherwise see: a deliberate regression that removed the backup's settle
     * listener produced no failure at all, because the whole run hung and Node exited 0 in silence.
     */
    const hung = cronModule.TASKS['coupon-expiry'];
    const realCoupon = hung.run;
    hung.run = () => new Promise(() => {});
    let bounded;
    try {
      bounded = await cronModule.runOrdered({ at, only: ['coupon-expiry'], taskTimeoutMs: 300 });
    } finally {
      hung.run = realCoupon;
    }
    check('a task that never settles is failed on a bound, not waited on for ever',
      [bounded.ran.length, bounded.failed.map((f) => f.task)], [0, ['coupon-expiry']]);
    check('  and the error says which task and how long it was given',
      /did not finish within 300ms/.test(bounded.failed[0].error), true);
    check('  the default bound being ten minutes, far above the slowest task here',
      cronModule.TASK_TIMEOUT_MS, 600000);

    /* ── --only really filters ── */

    const onlyOne = await cronModule.runOrdered({
      at, only: ['coupon-expiry'], taskTimeoutMs: SUITE_TASK_TIMEOUT_MS,
    });
    check('--only runs exactly what it names', onlyOne.ran.map((r) => r.task), ['coupon-expiry']);

    /* ── the backup itself ── */

    const written = fs.readdirSync(SANDBOX).filter((f) => f.endsWith('.sql'));
    check('the sandbox holds the dumps this run wrote, and nothing else', written.length > 0, true);

    /*
     * Read defensively from here down. If the backup produced nothing — which is what several
     * deliberate regressions cause — an unguarded `written[0]` throws and the harness sees a crash
     * instead of the named assertion that was supposed to catch it. §5a: a crash is a detection, but
     * a poor one.
     */
    const dump = written.length ? fs.readFileSync(path.join(SANDBOX, written[0]), 'utf8') : '';
    const inDump = new Set([...dump.matchAll(/^CREATE TABLE `([^`]+)`/gm)].map((m) => m[1]));
    const modelTables = Object.keys(db)
      .filter((k) => db[k] && db[k].tableName).map((k) => db[k].tableName);

    check('every one of the 64 tables the models declare is in the dump',
      modelTables.filter((t) => !inDump.has(t)), []);
    /*
     * Plus `sequelize_meta`, which is NOT a model and NOT one of §29's 64 tables — it is the
     * migration ledger. A restore without it would not know which migrations the dump already
     * contains, so its presence is part of "the database can be restored", not a 65th table.
     */
    check('  plus sequelize_meta, the migration ledger a restore needs', inDump.has('sequelize_meta'), true);
    check('  and nothing else, so the dump is exactly the schema plus its ledger',
      [...inDump].filter((t) => t !== 'sequelize_meta' && !modelTables.includes(t)), []);
    check('the dump ends with mysqldump\'s completion marker, so it is not truncated',
      /Dump completed on/.test(dump.slice(-200)), true);
    check('  and it carries the seeded rows, not just the schema',
      /INSERT INTO `roles`/.test(dump) && /INSERT INTO `permissions`/.test(dump), true);

    /* ── retention, driven by backdating rather than by waiting a month ── */

    const old = path.join(SANDBOX, backupTask.filenameFor(new Date('2020-01-01T00:00:00Z')));
    fs.writeFileSync(old, '-- old backup\n');
    const oldTime = Date.now() - (config.backup.retentionDays + 5) * MS_PER_DAY;
    fs.utimesSync(old, oldTime / 1000, oldTime / 1000);

    const foreign = path.join(SANDBOX, 'someone-elses-export.sql');
    fs.writeFileSync(foreign, '-- not ours\n');
    fs.utimesSync(foreign, oldTime / 1000, oldTime / 1000);

    const fresh = path.join(SANDBOX, backupTask.filenameFor(new Date('2026-06-14T00:00:00Z')));
    fs.writeFileSync(fresh, '-- recent backup\n');

    const pruned = backupTask.prune(new Date());
    check('a backup past the retention window is pruned',
      [pruned.includes(path.basename(old)), fs.existsSync(old)], [true, false]);
    check('  one inside the window is kept', fs.existsSync(fresh), true);
    check('  and a file this task did not write is left alone, however old',
      fs.existsSync(foreign), true);
    check('  retention comes from configuration, not from a number written here',
      config.backup.retentionDays, 30);

    await teardown();
    check('teardown leaves no notification behind',
      await db.Notification.count({ where: { id: { [db.Op.gt]: baseline.notification } } }), 0);
  } finally {
    try { await teardown(); } catch (_) { /* already torn down */ }
  }

  /*
   * A registered handler must actually be callable — `sync_usage` was not.
   *
   * It read `() => usageService.syncAllHeadcounts()`, with no argument, against a signature of
   * `syncAllHeadcounts(schoolId)`: "All" there means all limit *keys*, for one school. Called that
   * way it threw `entitlementService.getSnapshot() requires a school id; received undefined` —
   * measured. Nothing enqueues `sync_usage`, so the job sat registered and unreachable, and its own
   * docblock claimed it "touches every school" the whole time.
   *
   * Every registration above was checked for its *name*; none was ever invoked. This calls the one
   * that had no request context to need — the others send mail, write notifications or shell out to
   * `mysqldump`, so invoking them here would have side effects; `sync_usage` only reads and
   * reconciles, and on an empty tenant set that is a no-op that still exercises the whole call path.
   */
  let syncError = null;
  let syncResult = null;
  try {
    // eslint-disable-next-line global-require
    const { HANDLERS } = require('../src/jobs/handlers');
    syncResult = await HANDLERS[JOB_NAMES.SYNC_USAGE]();
  } catch (err) {
    syncError = err.message;
  }
  check('the registered sync_usage handler can actually be called', syncError, null);
  check('  and reports what it reconciled, per school',
    syncResult && typeof syncResult.schools === 'number' && typeof syncResult.synced === 'object',
    true);
}

async function main() {
  verifyContract();
  verifyQueue();
  verifyEntryPoint();

  try {
    await db.sequelize.authenticate();
  } catch (err) {
    dbSkipped = true;
    console.log(`\nSKIP  Part 3 — database unreachable: ${err.message}`);
    return;
  }
  await verifyExecution();
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nverify-jobs crashed:', err);
  })
  .finally(async () => {
    console.log('');
    if (dbSkipped) {
      console.log('⚠  Part 3 was SKIPPED — MySQL/MariaDB is not reachable.');
    }
    console.log(failures === 0
      ? (dbSkipped ? 'All pure job checks passed (Parts 1–2).' : 'All job checks passed (Parts 1–3).')
      : `${failures} check(s) FAILED.`);
    try { await db.sequelize.close(); } catch (_) { /* the pool may never have opened */ }
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    /*
     * A degraded run is a FAILED run — Known Issue 28.
     *
     * This suite answers an unreachable database by setting `dbSkipped`, returning early from its
     * database half and printing that it passed. Until session 26 it then **exited 0**, so a stopped
     * MySQL read as a green run to anything that looks at the exit code — which is `node
     * scripts/verify-*.js` run directly (the workflow this project's log documents throughout) and
     * `scripts/stress.sh:17`, whose entire scoring is `if ! wait "$pid"`. A stress run with the
     * database down would have reported a perfect determinism score for suites that never ran.
     *
     * `npm test` was never exposed: `tests/globalSetup.js` proves the database with `SELECT
     * DATABASE()` before any suite spawns, and `tests/verify.test.js` asserts both that `skipped` is
     * empty and that each suite produced its exact recorded count. This closes the direct-run path,
     * which is the one a person uses.
     *
     * `--allow-skip` is for running the pure checks deliberately, and mirrors `--allow-shrink` in
     * `record-baseline.js` rather than inventing a new convention. The jest harness passes no
     * arguments (`suiteRunner.js:220`), so it can never opt out by accident.
     */
    if (dbSkipped && !process.argv.includes('--allow-skip')) {
      console.log('');
      console.log('   Exiting 1: the database half did not run, so this is not a pass.');
      console.log('   Re-run with --allow-skip to execute the pure checks on purpose.');
      process.exit(1);
    }
    process.exit(failures === 0 ? 0 : 1);
  });
