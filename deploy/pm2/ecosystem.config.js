'use strict';

/**
 * PM2 ecosystem — SRS §27 "PM2", "Cron Jobs", "Queue Workers"; FR-DEPLOY-001.
 *
 * Three supervised processes, and a fourth that is deliberately absent:
 *
 *   msms-api    node src/server.js       one instance, fork mode, never clustered
 *   msms-cron   node src/jobs/cron.js    exactly one instance, and it can never become two
 *   msms-web    next start               the dashboard (frontend/), on loopback behind nginx
 *   (no app)    node src/jobs/worker.js  runs one job and exits. PM2 *can* supervise that shape;
 *                                        the reason there is no app for it is the queue, not PM2 —
 *                                        see WHY THERE IS NO WORKER APP below
 *
 * PM2 loads this as a CommonJS module, so `path`, `fs` and `__dirname` work here. The application
 * root is resolved from where this file lives rather than written as `/var/www/...`, because the one
 * thing that reliably breaks a copied ecosystem file is a `cwd` that was true on the machine it was
 * written on.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT WAS NOT VERIFIED — read this before trusting anything below
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **This file has never been run through PM2.** pm2 is not installed on the machine it was written
 * on and is not a dependency of `backend/package.json`, so there is no `pm2 start`, no `pm2 describe`
 * and no `pm2 prettylist` behind any statement here. What *was* checked is that the file parses and
 * loads: `node -e "require('deploy/pm2/ecosystem.config.js')"`. That is the whole of the verification.
 *
 * The consequence, stated once so it is not re-derived from each setting: every value describing the
 * *application* is cited to a file and a line and can be checked against the source; every value
 * describing *PM2's own runtime behaviour* is a documented option whose effect is unverified here.
 * Three places where that distinction changes what is written:
 *
 *   - `min_uptime` is an integer of milliseconds rather than `'30s'`, because whether a given PM2
 *     version unit-parses the string could not be checked from this repository.
 *   - `exp_backoff_restart_delay` is stated as a setting and an intent. No total duration is claimed
 *     for twenty attempts, because the growth factor and the ceiling are PM2 internals.
 *   - `max_memory_restart: '512M'` is a bound argued from what the request path allocates, not a
 *     measurement of this application under load.
 *
 * ## Where this file sits, and what the docs say now
 *
 * `docs/ARCHITECTURE.md:215-218` lists what `deploy/` contains without pinning a sub-path, and
 * `:220-242` already records the three corrections this file would otherwise have had to argue for:
 * nginx must not serve uploads statically, the API cannot run as a cluster, and there is no resident
 * queue worker. That section and this file agree, so what follows is the reasoning behind the
 * settings rather than a disagreement with a document.
 *
 * One contradiction between artifacts is live and belongs on the record: `deploy/logrotate/msms:120`
 * describes msms-api as "long-running, clustered". It is not, and must not become so — `instances: 1,
 * exec_mode: 'fork'` below, for the reasons in the next section. An operator reading both files needs
 * to know which one the running system obeys: this one. The logrotate stanza itself is unaffected;
 * it globs a directory, not a process count.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE API IS FORK MODE WITH ONE INSTANCE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Cluster mode is PM2's headline feature and it is the wrong answer here. Four pieces of this
 * application hold state in the memory of the process that serves the request. Three of them were
 * checked and two of those forbid a second instance outright.
 *
 * ### 1. The entitlement cache — this is the one that decides it
 *
 * `entitlementService.getSnapshot()` reads through `cache.remember()` with the shared TTL
 * (`entitlementService.js:549`, `env.js:198` → `CACHE_TTL_SECONDS=300`). With the default driver the
 * cache is a plain `Map` in one process (`cache.js:32`, and `cache.js:114` instantiates it as the
 * module-level default because `CACHE_DRIVER` defaults to `memory` — `env.js:196`).
 *
 * `invalidateSchool()` is `cache.del()` (`entitlementService.js:687-688`) and `invalidatePlan()` is a
 * namespace flush (`entitlementService.js:701-703`). Both act on **the process that handled the
 * write**. Under N cluster workers, a Super Admin who suspends a school or downgrades a plan clears
 * one worker's Map; the other N−1 keep serving the old snapshot until the TTL lapses — up to five
 * minutes of a suspended school passing `assertSubscriptionUsable()` and a downgraded plan still
 * granting modules it no longer includes.
 *
 * The service states the contract it would break, in its own header (`entitlementService.js:47-49`):
 * *"a plan change or a suspension has to take effect on the next request, not when a TTL lapses."*
 * Clustering makes that statement false. This is an entitlement bypass with a stopwatch on it, not a
 * performance trade-off, so it settles the question by itself.
 *
 * ### 2. The rate limiter — the code already documented this
 *
 * `express-rate-limit` is used with its default in-memory store (`rateLimit.js:193-202` sets no
 * `store`). `rateLimit.js:29-32` says so and names the consequence: *"A single-process deployment
 * (what SRS §3 describes) is exactly counted; behind N workers the effective ceiling is N × the
 * configured limit."* With `AUTH_RATE_LIMIT_MAX=20` (`env.js:183`), four workers give a credential
 * guesser 80 attempts per window instead of 20. The same header records why it was not fixed: a
 * shared store needs `rate-limit-redis`, which is not a dependency — and Redis is not on §27's list.
 *
 * ### 3. node-cron — checked, and NOT a reason either way
 *
 * `require('node-cron')` appears exactly once in `src/`, in `jobs/cron.js:63`. The API process
 * schedules nothing. So the usual clustering hazard — every worker firing the same schedule — does
 * not apply to `server.js`. Worth stating, because it is the objection people expect and it is not
 * the one that matters here.
 *
 * ### 4. The in-process queue — a caveat, not a blocker
 *
 * `config/queue.js:107` constructs one `MemoryQueue` per process and `app.js:242` calls the handler
 * registration inside `createApp()` (required at `app.js:164`), so an `enqueue()` from a request path
 * (`auth.service.js:549`, the password-reset mail, and `:736`, email verification — the only two call
 * sites in `src/`) is drained by the same process that accepted it. Clustered, that still works:
 * each worker drains its own queue. It is listed because it is a reason a restart is not free, not a
 * reason clustering is unsafe.
 *
 * ### What would make clustering safe
 *
 * A cache shared between processes and a rate-limit store shared between processes. `cache.js`
 * already has a Redis driver (`cache.js:118-129`) and `rateLimit.js` names `rate-limit-redis` for
 * the other half — but SRS §27 lists no such component and states that no deployment technology
 * beyond its list is introduced. So this is recorded as the condition, not built. Until then the
 * API scales vertically, behind nginx, as one process.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO WORKER APP
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `src/jobs/worker.js` takes a job name as `process.argv[2]`, calls `runNow()`, prints the result
 * and calls `process.exit()` (`worker.js:58`, `:101-110`). Started with no argument it prints the
 * handler list and exits 0 (`worker.js:68-72`).
 *
 * **The reason there is no app for it is not that PM2 cannot supervise a run-once process.** It can:
 * `autorestart: false` — a key this file sets explicitly on both apps below, so it is plainly
 * per-app and settable — leaves an exited process alone, and `cron_restart` starts one on a
 * schedule. Modelled that way with `autorestart` left at its default, the failure would be about
 * twenty rapid starts and then a permanently `errored` app that never ran a job, because the shared
 * block below sets `min_uptime: 30000` and `max_restarts: 20` and a worker with no argument exits in
 * well under thirty seconds. That is a bad app, but it is not the reason.
 *
 * **The reason is durability, and it is the one `worker.js` itself gives** (`worker.js:17-22`): the
 * queue is a `MemoryQueue` in the API process's memory (`queue.js:107`), a second process gets its
 * own empty instance and cannot see a job the API enqueued, and there is nowhere durable to put a
 * pending job because §29 fixes the schema at 64 tables and §35 forbids a 65th. A supervised worker
 * would sit `online` in `pm2 list`, consuming nothing, looking healthy. Adding it would make the
 * deployment look more complete and do less.
 *
 * **So §27's "Queue Workers" line item is only partly met by this file, and saying so is the point.**
 * What exists is the on-demand path —
 *
 *     cd <backend> && NODE_ENV=production npm run worker -- database_backup
 *
 * — plus the cron sweeps for everything that must survive a restart. `cron.js:37-50` sets that out:
 * the sweeps are the reconciliation that replaces queue durability, re-deriving missed work from
 * `notified_at`, `announced_at`, `alert_sent_at`, `reminder_sent_at` and `expiry_notified_at`.
 * `docs/IMPLEMENTATION_CHECKLIST.md:705` tracks FR-DEPLOY-001 as In Progress, and nothing in this
 * file closes the worker half of it. Note what the sweeps do NOT cover: a queued `send_email` has no
 * marker column and no sweep — see `max_memory_restart` below.
 *
 * One further gap this file cannot close: `sync_usage` has a registered handler
 * (`jobs/handlers/index.js:78`) and **nothing schedules it** — it is not among the eight tasks in
 * `cron.js:74-84`. Its own comment calls it "the one job that is genuinely periodic". Making it
 * periodic belongs in `cron.js`'s `ORDER`, where the skip-if-running and sequencing rules already
 * live — not in a PM2 `cron_restart` that would invent a schedule the codebase never states.
 */

const fs = require('fs');
const path = require('path');

/**
 * The application root — `backend/`, a sibling of `deploy/`.
 *
 * This must be the directory holding `package.json`, because `config/env.js:14` computes `ROOT` as
 * two levels up from `src/config` and then resolves `LOG_DIR`, `UPLOAD_DIR` and `BACKUP_DIR`
 * against it (`env.js:189-191`, `242-244`, `249-251`).
 *
 * The two `..` are this file's own nesting depth: it must live at `<project>/deploy/pm2/`. Move it
 * to `<project>/deploy/` and `BACKEND` silently becomes `<parent-of-project>/backend`.
 */
const BACKEND = path.resolve(__dirname, '..', '..', 'backend');

/**
 * The dashboard's root — `frontend/`, the other sibling. `next start` serves the build in `.next/` from
 * the directory it is started in, so this must be the directory holding the frontend's `package.json`.
 */
const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend');

/*
 * Checked rather than assumed, because the failure it prevents is a bad hour.
 *
 * With a wrong `BACKEND`, PM2 gets a `cwd` that does not exist or is not this project and reports
 * "Script not found" for `src/server.js` — a message that says nothing about the real cause. Thrown
 * here, the file names its own assumption at load, before PM2 spawns anything.
 */
if (!fs.existsSync(path.join(BACKEND, 'package.json'))) {
  throw new Error(
    'ecosystem.config.js: expected the backend at ' + BACKEND + ', and there is no package.json '
    + 'there. This file must stay at <project>/deploy/pm2/ecosystem.config.js — the two ".." in '
    + 'BACKEND are its nesting depth. Move the file back, or correct BACKEND.'
  );
}

/**
 * Where PM2 puts its own capture of stdout/stderr. An absolute path outside the application tree,
 * and both halves of that are load-bearing.
 *
 * **It is pinned because `deploy/logrotate/msms` requires it to be.** That file's path contract
 * (`deploy/logrotate/msms:137-149`) states one direction: the ecosystem file MUST pin
 * `/var/log/msms/<app>-out.log` and `<app>-error.log`, because if it does not, PM2 falls back to
 * `$PM2_HOME/logs/`, the stanza's glob matches nothing, and logrotate does nothing — quietly, since
 * a glob matching no files is not an error. Rotation for these four files lives there, and *only*
 * there: PM2 never rotates or bounds them itself, so a crash-looping process with no rotation is how
 * a partition fills.
 *
 * **It is outside `backend/storage/logs` on purpose.** Same file, `:151-152`: keeping PM2's files out
 * of the application tree means no future glob can reach winston's directory, where a rename under an
 * open descriptor loses a day of lines and a rotation outside winston's audit ledger destroys its
 * retention (`deploy/logrotate/msms:58-88` sets out both failures).
 *
 * These files are not redundant with winston's, and in production they are close to empty in steady
 * state: `logger.js:44` drops the console transport when `NODE_ENV=production`, so nothing routine is
 * written here at all. What lands in them is exactly what winston cannot log — a syntax error or a
 * missing module that kills the process before `require('./config/logger')` returns, an `EADDRINUSE`
 * racing the logger, the cron process's refusal (`cron.js:250-254`, a `console.error`), and the
 * deliberate `process.stderr.write` on the boot-failure path (`server.js:147`), which exists because
 * a configuration error can be thrown before the log directory is usable. When a process will not
 * start, this is the file that says why — which is also why it must not be the file that was lost to
 * a full disk.
 */
const PM2_LOG_DIR = '/var/log/msms';

/*
 * PM2 opens `out_file` and `error_file` before either process starts, so this directory has to exist
 * *now* — earlier than anything in this codebase runs. `logger.js:17` creates winston's directory
 * from inside Node, which is too late to help here, and `.gitignore:13-16` keeps every `storage/`
 * directory out of the source tree anyway.
 *
 * Not created from here, deliberately. `/var/log` is root-owned, so a `mkdirSync` that happened to
 * succeed would have succeeded as root and left a directory the deploy user cannot write into —
 * which is the same outage one step later, with a confusing owner. The operator command below is the
 * one from `deploy/logrotate/msms:153`, and it sets ownership and mode as that file's `su` and
 * `create` directives require.
 */
/*
 * Scoped to POSIX hosts, and that scoping is load-bearing rather than a convenience.
 *
 * `/var/log/msms` is an absolute POSIX path that can never exist on the Windows box this project is
 * developed on, so an unconditional throw fires on every machine that is not the production host.
 * That costs more than it sounds: this file is the ONE artifact in `deploy/` that can be verified by
 * executing it — nginx, logrotate and MySQL are all absent here — and `scripts/verify-deploy.js`
 * checks `instances`, `exec_mode`, `kill_timeout` against `server.js`'s real shutdown budget, and
 * `ENABLE_CRON` by `require()`-ing it. A file that throws at module scope can be verified by nobody:
 * not this suite, not a linter, not CI, not an operator reading it before a deploy.
 *
 * On the Linux target the behaviour is unchanged — PM2 loads this file there, the check runs, and a
 * missing directory still stops the deploy loudly instead of becoming a restart loop.
 */
if (process.platform !== 'win32' && !fs.existsSync(PM2_LOG_DIR)) {
  throw new Error(
    'ecosystem.config.js: ' + PM2_LOG_DIR + ' does not exist, and PM2 opens its log files there '
    + 'before starting any process. Create it first (see deploy/logrotate/msms:153):\n'
    + '  mkdir -p /var/log/msms && chown msms:msms /var/log/msms && chmod 0750 /var/log/msms\n'
    + 'Not created from here on purpose: /var/log is root-owned, so a mkdir that succeeded would '
    + 'leave a root-owned directory the deploy user cannot write into.'
  );
}

/**
 * Settings that are identical for both processes, and identical for the same reason each time.
 */
const shared = {
  cwd: BACKEND,

  /*
   * `package.json:8` declares `"node": ">=18.0.0"`. Left as PM2's default interpreter rather than
   * pinned to a path, so the version nvm/the system package manager provides is the one that runs;
   * pinning it here is how a server ends up silently running the old Node after an upgrade.
   */
  interpreter: 'node',

  /*
   * PM2 scans for git metadata on start to show branch and revision. The project root is not a git
   * repository, so this only buys a filesystem walk that finds nothing, on every restart.
   */
  vizion: false,

  /*
   * Timestamps on PM2's own log lines. Winston already timestamps inside its JSON (`logger.js:55`),
   * but the lines that reach *these* files are raw stack traces from a process that died before
   * winston existed — undated, they cannot be lined up against anything else.
   */
  time: true,

  /*
   * `assertRuntimeConfig()` throws and `server.js:141-149` exits 1 on a bad configuration; `cron.js`
   * exits 1 when `ENABLE_CRON` is not set (`cron.js:255-261`). Neither is fixed by trying again, and
   * without a delay PM2 retries as fast as the process can boot — writing a stack trace to disk each
   * time and burying the first, real failure under thousands of identical ones.
   *
   * PM2 grows this delay with each consecutive failure and stops growing it at a ceiling. The factor
   * and the ceiling are PM2 internals and pm2 is not installed here, so no total is claimed: an
   * earlier draft of this file asserted "twenty attempts span roughly three minutes" and that number
   * was derived from nothing. The intent is what is settled — a delay small enough that a genuinely
   * transient fault still recovers quickly, large enough that a config error does not spin. If the
   * real window matters for your host (see `max_restarts`), measure it once with
   * `pm2 describe msms-api` after a forced failure and write the figure here.
   */
  exp_backoff_restart_delay: 100,

  /*
   * A process that has not stayed up this long counts as a failed start rather than a crash.
   * `server.js` validates configuration, connects the database and initialises the cache *before*
   * `listen` (`server.js:86-99`), so "started" is genuinely later than "spawned" here.
   *
   * Written as a plain integer of milliseconds, not `'30s'`. PM2 documents this as a number; whether
   * a given version also unit-parses a string could not be checked here (pm2 is in neither
   * `backend/package.json` nor a global install). If it does not, the comparison against a string is
   * NaN, `unstable_restarts` never increments, `max_restarts` never fires, and the app crash-loops
   * for ever — the exact outcome the cap below exists to prevent. An integer costs nothing and
   * removes the question.
   */
  min_uptime: 30000,

  /*
   * Give up after this many consecutive failed starts and leave the app `errored` in `pm2 list`.
   *
   * A cap rather than infinity, because §27's Monitoring is `pm2 list` and a process wedged in a
   * restart loop looks alive there while an `errored` one does not. Not too small, either: after a
   * host reboot MySQL may not accept connections before Node does, `assertConnection()` rejects
   * (`server.js:88`), and the API exits 1 through no fault of its own. Twenty attempts with the
   * backoff above is a window intended to outlast MySQL's start-up while still ending.
   *
   * **This is spread into msms-cron too, and it is argued above only in API terms.** If the
   * scheduler exhausts it, PM2 parks it `errored` and nothing else in this deployment notices:
   * readiness is API-only and database-only (`system.controller.js:51-74` reports `{ checks:
   * { database } }` and no scheduler signal), and `cron.js` has no endpoint and no heartbeat. What
   * stops, silently, is the eight tasks at `cron.js:74-84` — including `database-backup` at 0 3 * * *
   * (`databaseBackup.js:193`). `pm2 describe msms-cron` is therefore in the operator checklist at
   * the foot of this file, and it is a check a person has to actually perform.
   */
  max_restarts: 20,
};

module.exports = {
  apps: [
    /* ───────────────────────────────── the API ───────────────────────────────── */
    {
      name: 'msms-api',

      /* `package.json:6` and `:11` — `npm start` is `node src/server.js`. */
      script: 'src/server.js',
      ...shared,

      /*
       * ONE instance, fork mode. See the header — the entitlement cache and the rate-limit store are
       * both per-process, and clustering turns the first into a five-minute window where a suspended
       * school still passes its gates. Raising this number is a correctness change, not a capacity
       * change.
       */
      instances: 1,
      exec_mode: 'fork',

      /*
       * The only environment variable set here, and it is set here on purpose.
       *
       * `env.js:25` reads `NODE_ENV` at module load, and `dotenv.config()` (`env.js:22`) is called
       * without `override`, so it never replaces a value the process already has. PM2 sets these
       * before Node starts, so this wins over whatever the `.env` on the box says — which is what
       * makes it safe against the common accident of a `.env` copied from `.env.example`, where
       * line 7 reads `NODE_ENV=development`. Under that value winston keeps a console transport
       * (`logger.js:44`) and the production-only assertions are skipped (`env.js:279-289`), so a
       * placeholder JWT secret and a missing `ANTHROPIC_API_KEY` both pass unremarked.
       *
       * Nothing else is set here deliberately. `PORT`, `DB_*`, `CORS_ORIGINS`, `TRUST_PROXY` and the
       * rest belong in `backend/.env` (73 keys, all documented in `.env.example`) — and because
       * dotenv does not override, any key repeated here would silently outrank the `.env` an
       * operator is editing. One value in one place beats two values and a rule about which wins.
       */
      env: {
        NODE_ENV: 'production',
      },

      /*
       * Match the graceful shutdown `server.js` actually implements.
       *
       * PM2 sends SIGINT, waits `kill_timeout`, then SIGKILL. `server.js:116-118` listens for both
       * SIGINT and SIGTERM and runs `shutdown()`: stop accepting connections, let in-flight requests
       * finish, close the Sequelize pool, exit — with its own hard cap of `SHUTDOWN_TIMEOUT_MS`,
       * 15000 ms (`server.js:33`).
       *
       * PM2's default is 1600 ms. Left at the default, every deploy SIGKILLs the API 1.6 seconds in
       * — some 13 seconds before the shutdown it was going to complete — dropping in-flight requests
       * mid-response and leaving up to 15 pooled MySQL connections (`env.js:128`, `DB_POOL_MAX`) for
       * the server to time out.
       *
       * So this must exceed 15000. The extra 5000 ms is headroom over `server.js`'s own cap for
       * signal delivery and process teardown — not time that falls outside it. To be exact about
       * what that cap covers: the forced-exit timer is armed at the top of `shutdown()`
       * (`server.js:51-54`) and cleared only after `sequelize.close()` (`server.js:66`, cleared at
       * `:74`), so the whole shutdown, pool close included, is already bounded at 15 s from the
       * signal. The `unref()` at `server.js:57` does not weaken that while sockets are still open.
       */
      kill_timeout: 20000,

      /*
       * Explicitly false, so nobody adds it later on the assumption it makes deploys safer.
       * `wait_ready` makes PM2 hold until the app calls `process.send('ready')`. `server.js` never
       * calls it — the readiness signal this project has is HTTP: `GET /api/v1/health/ready`
       * (`system.routes.js:23`), which returns 503 while the database is unreachable (the status is
       * chosen at `system.controller.js:73`). Turning this on without adding the IPC call would make
       * every start hang until `listen_timeout` and then be reported as a failure.
       */
      wait_ready: false,

      autorestart: true,

      /*
       * A watchdog, not a heap limit — PM2 samples RSS and restarts the app when it crosses this.
       *
       * **What a restart costs, stated accurately.** `server.js` handles the resulting SIGINT
       * gracefully, so in-flight HTTP requests drain rather than being cut. What does NOT drain is
       * the in-process queue: `shutdown()` closes the HTTP server and the Sequelize pool and exits
       * (`server.js:45-76`) without waiting for it. The queue's real contents are the two
       * `enqueue()` call sites in `src/` — `auth.service.js:549` (password reset) and `:736` (email
       * verification), both `JOB_NAMES.SEND_EMAIL`.
       *
       * **Those are not re-derived by anything.** The cron sweeps reconcile from five marker columns
       * (`cron.js:47-48`) and none of them is a reset or verification token; there is no mail
       * re-send among the eight tasks at `cron.js:74-84`. And the user is told nothing:
       * `auth.service.js:542-543` returns `{ issued: true }` for any address by design, so a reset
       * requested in the second before a restart looks successful and no mail ever arrives. The only
       * remedy is for the user to request another link. Every deploy has this property too, not just
       * a memory restart — it is a property of an in-process queue with no durable store (§29/§35),
       * recorded here rather than left to be discovered from a support ticket.
       *
       * **Kept anyway, and this is the trade.** Without it, unbounded growth ends in an OOM kill,
       * which loses the same queue *plus* every in-flight request, ungracefully, at a moment nobody
       * chose either. A graceful restart at a known threshold is the better of the two bad outcomes.
       * (Contrast msms-cron below, where the setting is omitted, because there the automatic restart
       * can manufacture a broken backup.)
       *
       * The number is NOT derived from a measurement. What is known about this process's memory:
       * uploads stream to disk rather than buffering (`upload.js:361` uses `multer.diskStorage`),
       * and JSON bodies are capped at 100 kb (`env.js:118`), so neither inflates the heap. The one
       * unbounded allocation in the request path is the Excel export — `workbook.xlsx.writeBuffer()`
       * holds the whole file in memory by design (`reports.service.js:455`, `:474`) with no row cap.
       * Raise this if that report is used against large schools, and measure before choosing a value.
       */
      max_memory_restart: '512M',

      out_file: path.join(PM2_LOG_DIR, 'msms-api-out.log'),
      error_file: path.join(PM2_LOG_DIR, 'msms-api-error.log'),
    },

    /* ─────────────────────────── the scheduler ─────────────────────────── */
    {
      name: 'msms-cron',

      /* `package.json:14` — `npm run cron` is `node src/jobs/cron.js`. */
      script: 'src/jobs/cron.js',
      ...shared,

      /*
       * ══ THIS CAN NEVER BE MORE THAN ONE, AND NOT FOR A PERFORMANCE REASON ══
       *
       * `cron.js:58-60` states the hazard in the file's own words: *"Two processes sweeping one
       * database would double-notify and race the renewals."* Concretely, with two schedulers:
       *
       *  - `notification-dispatch` (the quarter-hourly schedule at `notificationDispatch.js:23` —
       *    written there rather than copied here, because a cron step expression closes a block
       *    comment and takes the rest of this file with it) reads rows whose marker is still null and
       *    writes it; two processes on the same tick both see null and both send. The marker is what
       *    makes the sweep idempotent across *time*, not across concurrent processes.
       *  - `subscription-lifecycle` (5 * * * *) transitions §12 states from dates. Two of them race
       *    a renewal against a grace-period expiry, and which wins is a coin toss.
       *  - `database-backup` (0 3 * * *) has both processes writing `msms-<timestamp>.sql`. The
       *    filename is second-resolution (`databaseBackup.js:39-42`), so two dumps starting in the
       *    same second write the same file — two mysqldump streams interleaved into one unrestorable
       *    `.sql`, which passes the non-empty check at `databaseBackup.js:173`.
       *
       * The in-process guard that makes overlap safe is a `Set` in one process (`cron.js:91`,
       * checked at `:154`). It cannot see another process. There is no lock table — §29 fixes the
       * schema at 64 tables — so nothing in the database would catch this either.
       *
       * `instances: 2` here does not make the sweeps faster. It makes them wrong.
       *
       * Fork mode is required, not preferred: cluster mode exists to share a listening socket, and
       * this process listens on nothing.
       */
      instances: 1,
      exec_mode: 'fork',

      /*
       * `ENABLE_CRON` lives here rather than in `.env`. Be precise about what that buys, because it
       * is narrower than "exactly one scheduler, guaranteed".
       *
       * `cron.js:255-261` refuses to start the resident scheduler unless the flag is set;
       * `env.js:257` defaults it to false and `env.js:49-53` accepts the string `'true'`. Put the
       * flag in `backend/.env` and the opt-in becomes machine-wide: every process on that box reads
       * the same file, so an operator who types `npm run cron` to "check something" starts a second
       * sweeper against the same database and gets no warning. Declared here, the flag belongs to
       * this supervised app, and that hand-typed second scheduler still refuses to start. That is
       * the protection, and it is real.
       *
       * **What it does not protect against: a second host.** This file is the artifact that travels
       * between machines, and it carries the opt-in with it. Two PM2 daemons — two OS users on one
       * box, or a second application host pointed at the same database — each running `pm2 start` on
       * this file get two `msms-cron` processes, and nothing refuses, with the consequences listed
       * above. The guarantee is enforced by the operator, not by this file: **any host that is not
       * the scheduler host must be started with `--only msms-api`.** That step is in the checklist
       * at the foot of this file, and it is the step that is skipped.
       *
       * `LOG_DIR` is the second exception to "nothing but NODE_ENV here", and it is a correctness
       * one. `logger.js:54` hard-codes `defaultMeta: { service: 'msms-api' }` for every process that
       * requires the logger, and `logger.js:27-41` pins both transports to `config.logging.dir`. Two
       * resident processes writing one `combined-%DATE%.log` is not merely confusing: at the daily
       * roll, whichever process renames and gzips first leaves the other appending to a renamed
       * inode, and those lines are lost with no error — the same failure `deploy/logrotate/msms:69-72`
       * describes for logrotate, arriving from the other direction. Both processes would also derive
       * the same `.<sha1>-audit.json` ledger from identical transport options and run two prune loops
       * over it. A separate directory (resolved against `backend/` by `env.js:242-244`, so this
       * becomes `backend/storage/logs/cron/`, created by `logger.js:17` at start) gives each process
       * its own files and its own ledger.
       *
       * The label is NOT fixed by this: every line in `storage/logs/cron/` still reads
       * `service: "msms-api"`, because `logger.js:54` is a constant. The directory is what tells the
       * two apart. Fixing the label properly means making `defaultMeta` configurable in `logger.js`,
       * which is an application change and does not belong in a deployment file.
       */
      env: {
        NODE_ENV: 'production',
        ENABLE_CRON: 'true',
        LOG_DIR: 'storage/logs/cron',
      },

      autorestart: true,

      /*
       * No `kill_timeout`, and no `max_memory_restart`, because of the same fact:
       *
       * `cron.js` installs no signal handler at all — `cron.js:264` says so outright ("SIGTERM is
       * left to the process manager"). Node's default action for SIGINT/SIGTERM terminates the
       * process immediately, so whatever PM2 waits for, this process is already gone. A
       * `kill_timeout` here would be a setting with no effect: it cannot make this shutdown graceful,
       * because there is no shutdown handler for it to give time to.
       *
       * The consequence is real and belongs on the record: a `pm2 restart msms-cron` during the 03:00
       * backup kills mysqldump mid-stream. The part-written `.sql` is deleted only by the JS catch at
       * `databaseBackup.js:155-159` (the unlink is `:157`), which a killed process never reaches — so
       * the file survives, and `prune()` will later treat it as a backup, because it matches on name
       * prefix and mtime only (`databaseBackup.js:132-134`). Restart this app outside the backup
       * window, or fix it properly by adding a signal handler to `cron.js`.
       *
       * `max_memory_restart` is omitted for that reason: an automatic restart is a restart the
       * operator did not choose the timing of, and here it can manufacture a file that looks like a
       * backup and is not. The scheduler holds no request state and each task is bounded at ten
       * minutes (`cron.js:107`), so a runaway shows up as a climbing figure in `pm2 list` — §27's
       * Monitoring — which is a slower signal, chosen deliberately over a kill that can corrupt.
       */

      out_file: path.join(PM2_LOG_DIR, 'msms-cron-out.log'),
      error_file: path.join(PM2_LOG_DIR, 'msms-cron-error.log'),
    },

    /* ─────────────────────────── the dashboard ─────────────────────────── */
    {
      name: 'msms-web',

      /*
       * `frontend/package.json` — `npm start` is `next start -p 3000`. Run through Next's own binary
       * rather than npm, so the process PM2 supervises is the server and not an npm wrapper around it;
       * the arguments add `-H 127.0.0.1`, because `next start` binds every interface by default
       * (`--hostname`, default 0.0.0.0) and this server is meant to be reachable only through nginx —
       * the hazard the API's upstream block records for :4000.
       *
       * **It serves a build; it does not make one.** `next build` must have run in `frontend/` first,
       * and `NEXT_PUBLIC_API_URL` must be set when it runs: Next inlines `NEXT_PUBLIC_*` values into
       * the browser bundle at build time (`frontend/src/lib/apiClient.ts` reads it, falling back to
       * `http://localhost:4000/api/v1`), so setting it here, at start, changes nothing the browser sees.
       * `frontend/.env.example` documents it; the operator steps at the foot of this file build first.
       */
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000 -H 127.0.0.1',
      ...shared,
      /* The shared restart and logging settings, run from the frontend's root instead. */
      cwd: FRONTEND,

      /*
       * One instance, fork mode — a capacity choice, not the correctness constraint msms-api carries.
       * This process holds none of the API's per-process state (entitlements, rate limits, the queue):
       * the browser calls the API directly with its own token. More instances have simply not been
       * needed or measured, and cluster mode is not claimed to work for it until someone has.
       */
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',
      },

      autorestart: true,

      out_file: path.join(PM2_LOG_DIR, 'msms-web-out.log'),
      error_file: path.join(PM2_LOG_DIR, 'msms-web-error.log'),
    },
  ],

  /*
   * No `deploy:` block.
   *
   * `pm2 deploy` drives a git checkout on the target host, and the project root is not a git
   * repository — there is no remote for it to clone or pull. Writing one would produce a section
   * that cannot run.
   *
   * ── Operator steps this file does not perform ──────────────────────────────────────────────
   *
   *   mkdir -p /var/log/msms && chown msms:msms /var/log/msms && chmod 0750 /var/log/msms
   *                                                must exist first; this file throws if it does not
   *   cd frontend && npm ci && NEXT_PUBLIC_API_URL=https://<api-domain>/api/v1 npm run build
   *                                                before the first start and after every frontend
   *                                                change — msms-web serves this build (see msms-web)
   *   pm2 start deploy/pm2/ecosystem.config.js     all three apps — the SCHEDULER host only
   *   pm2 start  ... --only msms-api,msms-web      EVERY other host, because this file carries
   *                                                ENABLE_CRON=true with it (see msms-cron above)
   *   pm2 save                                     persist the list PM2 resurrects
   *   pm2 startup                                  print the boot command for this init system
   *
   * `pm2 save` is the step that is skipped and then missed: without it the resurrect list is empty
   * and the host reboots into a running PM2 with no applications.
   *
   * The `backend/storage/` tree needs no `mkdir` here: `logger.js:17` creates the log directory,
   * `databaseBackup.js:150` the backup directory and `upload.js:347` each upload directory, all with
   * `recursive: true`. `/var/log/msms` is the one directory nothing in this project creates, because
   * PM2 opens those files before any of this project's code runs.
   *
   * ── The monitoring surface that exists (§27) — an operator checklist, not something this file
   *    builds ───────────────────────────────────────────────────────────────────────────────────
   *
   * Nothing in `apps` above configures monitoring. Every line below is either a command a person has
   * to type or an endpoint that predates this file (`system.routes.js:22-23`). It is listed so the
   * surface is in one place, not as a claim that §27's Monitoring item is delivered —
   * `docs/IMPLEMENTATION_CHECKLIST.md:724` records it as Pending and this file does not change that.
   *
   *   pm2 list / pm2 monit / pm2 describe msms-api    process state, restarts, RSS, uptime
   *   pm2 describe msms-cron                          status and restart count — the ONLY signal that
   *                                                   the scheduler is alive; nothing else covers it
   *   pm2 logs msms-api --err                         the boot-failure output described above
   *   GET /api/v1/health                              liveness, public
   *   GET /api/v1/health/ready                        readiness; 503 when the database is unreachable
   *   backend/storage/logs/error-<date>.log            winston's error stream, API process
   *   backend/storage/logs/cron/error-<date>.log       winston's error stream, scheduler process
   *
   * The two winston paths are separate for the reason given on msms-cron's `LOG_DIR`. Note that
   * `deploy/monitoring/README.md` (e.g. `:369`) greps only the first of them; a scheduler failure is
   * in the second. Both label their lines `service: "msms-api"` — `logger.js:54` is a constant — so
   * the directory, not the field, is what identifies the process.
   *
   * **No tool on §27's list provides alerting, and nothing here reacts on its own.** PM2 has no HTTP
   * health check, so nothing responds to `/health/ready` returning 503: PM2 sees a process that is
   * running, because it is. Equally, nothing responds to an app sitting `errored` after
   * `max_restarts` — for msms-api that is a total outage, for msms-cron it is silent: backups,
   * renewals and notification dispatch simply stop while every other signal stays green. Both are
   * noticed only by a person reading `pm2 list` or the endpoint. Acting on readiness is nginx's job
   * and the operator's.
   */
};
