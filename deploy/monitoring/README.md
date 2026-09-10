# Monitoring — SRS §27

Checklist row **7.11**. This is a runbook, not a system: SRS §27 lists *Monitoring* and then states
that no deployment technology beyond its list is introduced, so there is no Prometheus, no Grafana,
no Sentry, no agent of any kind here. Everything below is built from four things that already exist:

| Piece | Where it comes from |
|---|---|
| `GET /api/v1/health`, `/health/ready`, `/meta` | `backend/src/modules/system/system.routes.js:22-24` |
| PM2's own facilities | §27 "PM2" — row 7.6, `deploy/pm2/ecosystem.config.js` |
| The log files | `backend/storage/logs/` — winston, `backend/src/config/logger.js:27-41` |
| Cron | §27 "Cron Jobs" — `npm run cron`, `backend/src/jobs/cron.js` |

**The application emits no metrics.** There is no `/metrics`, no counter, no gauge, no histogram
anywhere in the source. The only numbers either health endpoint returns are `uptime` (whole seconds)
and the literal string `"up"` or `"down"` for the database. Anything below that looks like a metric
is produced by the operator's own shell — `grep -c`, `stat -c %s`, `df` — not by the API.

**Read §0 before installing anything.** Every shell fragment here is written for a GNU/Linux host and
none of it has been executed against a real deployment; §0 says exactly what was and was not checked.

---

## 0. What has been verified, and what has not

Stated first rather than buried, because a runbook that overstates its own testing is worse than one
that admits a gap: the operator stops checking.

**Verified by reading the source**, at the file and line cited at every claim below: endpoint paths
and handlers, status codes, log messages and their levels, cron schedules, env-var names and
defaults, and the two rate-limit numbers. Where this document states a number, that number came from
a named line, not from an estimate.

**Every citation was re-checked on 2026-09-10, and 24 of them had gone stale.** This runbook was
written on 2026-09-04; four of the files it cites changed afterwards, and a line number does not move
when the code under it does. `config/env.js` had a 24-line block inserted between lines 131 and 181,
so every citation below that point was off by exactly 24 — the runbook sent an operator looking for
backup retention to a line reading `'wallet'`. `server.js` had the §29 schema guard added mid-file at
boot, which shifted most of its fifteen citations by differing amounts; one claimed the SIGTERM
handler was the `app.listen` call. Each was re-pointed **by content** — the setting, the log message,
the handler — rather than by adding the offset, and the `.env.example`, `app.js`, `cache.js` and
`jobs/cron.js` citations were confirmed still correct. **Re-check them against the source before
trusting one, and re-check them all whenever `env.js` or `server.js` changes.** This is the failure
mode `IMPLEMENTATION_PROGRESS.md` §8 records for cited line numbers: they are as perishable as counts.

**Verified by running it on the authoring machine** (Windows + Git Bash, against this repository's
own `backend/storage/logs`): the multi-line shell checks in §5 and their one-line forms in §6 parse
under both `sh -n` and `bash -n`; the heartbeat check finds the real `notification-dispatch` line
and stays silent; the error-delta check reports a delta on its first run and is silent on its second;
the backup-freshness check fires `BACKUP MISSING` when no matching file exists; `openssl x509` on
this machine supports `-checkend`.

**Not verified, and cannot be here:**

- **Nothing has run under cron, on Linux, or against a live deployment.** `nginx`, `pm2`, `mysql`,
  `mysqldump` and `logrotate` are all absent from the authoring machine. No line of the §6 crontab
  has ever been installed; no probe here has ever hit a running production API.
- **`zcat`, `zgrep`, `stat -c`, `date -d` and `df -P` are assumed to be the GNU versions.** They are
  on any mainstream Linux distribution. On BusyBox or a BSD they are not, and `stat -c` in
  particular needs `stat -f` instead.
- **The degraded `/health/ready` body in §2 is derived from the controller, not observed.** No
  database outage was staged.
- **Every threshold in this document — 1800 s, 93600 s, 85%, 14 days — is a choice, not a
  measurement.** The reasoning for each is given where it appears so you can overrule it.

---

## 1. `GET /api/v1/health` — liveness

```
$ curl -sS -m 5 http://127.0.0.1:4000/api/v1/health
{"success":true,"data":{"status":"ok","uptime":86412}}
```

Handler: `system.controller.js:37-42`. `uptime` is `Math.floor(process.uptime())`
(`system.controller.js:28-30`).

### What a 200 here actually proves

More than a TCP check, and this is worth knowing because it is the one thing this endpoint is
genuinely good for:

- **The whole module graph loaded.** `server.js:116` builds the app — which requires every route
  module, model and middleware — *before* `listen`. A route file with a syntax error or a bad
  require never reaches the point of binding a port.
- **`assertRuntimeConfig()` passed and the database answered once, at boot.** Both run before
  `listen` (`server.js:87` and `:106`; `listen` is `:117`). A process with a short `JWT_ACCESS_SECRET`
  or an unreachable database exits 1 without binding (`server.js:159-167`).
- **The event loop is not wedged.** The handler touches nothing, so a slow answer here is the
  process being blocked, not a dependency being slow. That is why the probe timeout is 5 s: at this
  endpoint, slow *is* the fault.

### What a 200 here does not prove — the classic failure

It deliberately touches nothing (`system.controller.js:35`). So:

- **Every database-backed request can be returning 5xx while this returns 200.** Liveness cannot
  see that. `/health/ready` is the endpoint for it, and even that only proves one trivial query.
- It says nothing about the connection pool being exhausted, the disk being full, the uploads
  directory being unwritable, mail failing, the AI provider being down, or the cron process being
  dead.
- It says nothing about *correctness*. A deploy that serves 200s from a build with a broken
  authorisation check is indistinguishable from a healthy one here.
- `uptime` is process age, not service quality. It is only useful **differentially**: if the value
  falls between two consecutive polls, the process restarted in between — which is how a crash loop
  becomes visible without reading PM2 at all (see §5). It cannot tell you *why* it restarted.

---

## 2. `GET /api/v1/health/ready` — readiness

```
$ curl -sS -m 35 -o - -w ' [%{http_code}]\n' http://127.0.0.1:4000/api/v1/health/ready
{"success":true,"data":{"status":"ready","uptime":86412,"checks":{"database":"up"}}} [200]
```

Degraded — derived from `system.controller.js:51-75`, **not** observed (see §0):

```
{"success":true,"data":{"status":"degraded","uptime":86412,"checks":{"database":"down"}}} [503]
```

### Three traps in that response, in order of how badly they bite

1. **`success` is `true` in the failure case.** `ApiResponse.ok()` sets `body.success = true`
   unconditionally and takes the status from its options (`utils/ApiResponse.js:19-23`); the
   controller passes `503` alongside it (`system.controller.js:73`). A probe that keys on
   `.success` will report a dead database as healthy for as long as the outage lasts. **Key on the
   HTTP status code, or on `data.status` / `data.checks.database` — never on `success`.**
2. **Do not use `curl -f` here.** `-f` suppresses the body on an HTTP error, and the body is the
   entire diagnostic: it is what distinguishes "the database is down" from "nginx returned its own
   503" from "the process is gone". Capture the status with `-w '%{http_code}'` instead.
3. **The probe timeout must be generous, and 35 s is a guess with a reason.** The check is
   `sequelize.authenticate()` (`config/database.js:79-81`), which needs a pooled connection. The
   pool waits up to `acquire: 30000` ms (`config/database.js:48`), the driver's own
   `connectTimeout` is `20000` ms (`config/database.js:60`), and `retry: { max: 2 }`
   (`config/database.js:75`) can multiply the attempt. There is no single derivable worst case, so
   `-m 35` clears the one documented 30 s wait and nothing more. A curl timeout at this endpoint is
   itself actionable — it means the database is not answering promptly — but the endpoint's own 503
   body is strictly more informative, so prefer to let it answer.

### The trap on the *capture* side: `curl -o` does not truncate on failure

**Measured on this machine, not assumed.** Seed `ready.json` with a healthy body, then point curl at
a dead port:

```
$ curl -sS -m 3 -o ready.json -w '%{http_code}' http://127.0.0.1:65533/api/v1/health/ready
curl: (7) Failed to connect ...                 # exit 7, http_code 000
$ cat ready.json
{"success":true,"data":{"status":"ready"}}      # unchanged — the PREVIOUS run's body
```

So an alert written as `curl -o "$STATE/ready.json" …; … || cat "$STATE/ready.json"` prints
`READINESS 000` followed by a body saying the database is up — on exactly the refused / timed-out /
process-gone cases where trap 2 above says the body is the whole diagnostic. **Truncate the file
before the request (`: > "$STATE/ready.json"`) and print it only if it is non-empty (`[ -s … ]`).**
Both are in the §6 crontab line.

### What a 200 here proves

One connection came out of the pool and ran a trivial query against the configured database on
`127.0.0.1:3306` (`config/env.js:122-125`). That is all.

### What it does not prove

- **Not that the schema is right.** Migrations may be unapplied, half-applied, or from the wrong
  branch. `authenticate()` runs a trivial query; it never looks at a table. Nothing in the
  monitoring path checks `sequelize_meta` — the migration ledger is only visible via
  `npm run db:migrate:status`, which is a deploy step, not a probe.
- **Not that the pool is healthy.** A pool at `DB_POOL_MAX=15` (`config/env.js:128`) with all
  fifteen connections held by slow queries will still hand a readiness probe a connection once one
  frees — the probe waits, then reports `ready`. Saturation shows up as latency here, and this
  runbook has nowhere to record latency.
- **Not that anything else is up.** Mail, the AI provider, the uploads filesystem and the cache are
  all unchecked. The cache is the sharpest of these: `initCache()` resolves rather than rejects when
  Redis is unreachable and falls back to the in-memory driver with a `warn`
  (`config/cache.js:117-130`). A deployment running `CACHE_DRIVER=redis` against a dead Redis looks
  identical to a healthy one from every endpoint here. (Redis is off §27's list anyway — the default
  `CACHE_DRIVER=memory` is what §27 supports.)
- **Not that the last outage is over for callers.** The 503 is per-request; there is no hysteresis
  and no state.

### Probing readiness has a cost, and it is asymmetric

Each failed check writes an error line — `"Readiness check failed: database unreachable"`,
`system.controller.js:64` — into `error-%DATE%.log`. At one probe a minute, an eight-hour database
outage adds 480 lines there, on top of the 5xx lines every real request is producing at the same
time. That is not a reason to probe less; it is a reason not to be surprised by the shape of the
error log after an incident, and a reason not to probe readiness every second.

---

## 3. `GET /api/v1/meta` — deploy verification, not health

```
$ curl -sS -m 5 http://127.0.0.1:4000/api/v1/meta
{"success":true,"data":{"name":"Multi-School Management System","version":"1.0.0","apiPrefix":"/api/v1","environment":"production"}}
```

Handler `system.controller.js:82-89`; `version` is read from `package.json`
(`system.controller.js:25`, currently `1.0.0` at `package.json:3`).

Two things this is good for and nothing else is:

- **`environment` is the only externally visible proof that `NODE_ENV=production` reached the
  process.** That single value decides whether cookies are `secure`, whether stack traces are
  attached to 5xx bodies (`middlewares/errorHandler.js:276`), and whether the console log transport
  exists (`config/logger.js:44`). Check it after every deploy. If it says `development`, the deploy
  is wrong even though every health probe is green.
- **`version` tells you which build is serving** — but only if someone bumps `package.json`. It has
  been `1.0.0` for the life of the project, so today it distinguishes nothing. Treat it as a hook
  for a future release process, not as a signal.

---

## 4. The probe set

All probes hit `127.0.0.1:4000` (`config/env.js:105`) under the prefix `/api/v1`
(`config/env.js:106`).

| # | What | Command | Green | Not green means |
|---|---|---|---|---|
| P1 | Liveness, direct | `curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/api/v1/health` | `200` | The process is gone, restarting, mid-shutdown, or the event loop is blocked |
| P2 | Readiness, direct | `curl -sS -m 35 -o "$STATE/ready.json" -w '%{http_code}' http://127.0.0.1:4000/api/v1/health/ready` | `200` + `"database":"up"` | `503` → database unreachable. Timeout → database not answering promptly |
| P3 | Liveness, public | `curl -sS -m 10 -o /dev/null -w '%{http_code}' https://$DOMAIN/api/v1/health` | `200` | See the decision table below |
| P4 | Environment | `curl -sS -m 5 https://$DOMAIN/api/v1/meta` | `"environment":"production"` | The unit is running with the wrong `NODE_ENV` |

P1, P2 and P3 are on the §6 schedule. **P4 is a deploy step, not a cron job** — `environment` only
changes when someone changes it, so checking it every five minutes buys nothing that checking it
after each deploy does not.

**P1 and P3 together are the point.** Either one alone is ambiguous:

| P1 (direct) | P3 (public) | Conclusion |
|---|---|---|
| 200 | 200 | The chain is up |
| 200 | 502 / 504 | nginx cannot reach the upstream — proxy_pass target, port, or SELinux/firewall. The app is fine |
| 200 | connection refused / TLS error | nginx is down, or the certificate has expired |
| refused | 502 | The Node process is down. Go to PM2 |
| 200 | 429 | See the rate-limit note below — this is probably a `TRUST_PROXY` misconfiguration, not an attack |

### Correlating a probe with its log line — this only works when the probe fails

`requestContext` honours an inbound `X-Request-Id` if it matches `/^[A-Za-z0-9._~-]{8,64}$/`, sets
`req.id` from it and echoes it back in the response header (`middlewares/requestContext.js:22-27`).
So a probe can name itself:

```sh
curl -sS -m 5 -D - -o /dev/null \
     -H "X-Request-Id: monitor-$(date -u +%Y%m%dT%H%M%S)" \
     http://127.0.0.1:4000/api/v1/health
```

**But `req.id` never reaches the log line of a successful request.** The morgan format string is
`':method :url :status :res[content-length] - :response-time ms'` (`app.js:216`) and the stream
writes that bare string through winston (`app.js:218`), so a healthy request logs exactly this — no
`requestId` key anywhere in it:

```json
{"env":"development","level":"info","message":"GET /api/v1/health 200 50 - 6.292 ms","service":"msms-api","timestamp":"2026-09-03T20:10:32.055Z"}
```

`req.id` is written to a log line only on the paths that add it explicitly: the error handler
(`errorHandler.js:235`, feeding both the 5xx `error` branch at `:251` and the 4xx `warn` branch
at `:258`), the rate-limit refusal (`rateLimit.js:144`) and the readiness failure
(`system.controller.js:65`).

So: **grep the logs for a probe's id only when that probe returned 4xx or 5xx.** For a healthy probe,
read the id back off the response header (`-D -`) and stop there — there is nothing to match it
against. Making the healthy path greppable would mean adding `:req[x-request-id]` to the morgan
format at `app.js:216`; that is an application change, and it has not been made.

Anything that does not match the id pattern is silently replaced with a generated `nanoid(16)`
(`requestContext.js:24`) — that is deliberate (log forging), not a bug to work around.

### The probes are rate limited. This matters.

`apiLimiter` is mounted app-wide, before the router, with **no skip for the health routes**
(`app.js:283`; limiter at `middlewares/rateLimit.js:206-210`). Defaults: 1000 requests per 15
minutes per key (`config/env.js:205-206`).

The §6 schedule costs **33 requests per 15-minute window**: P1 and P2 every minute (30) plus P3 every
five minutes (3). Against a 1000-request budget that is 3.3%. Fine. P1 and P2 come from the loopback
and key as `ip:127.0.0.1` (`clientKey`, `rateLimit.js:116-117`, via `clientAddress`,
`rateLimit.js:83-99`); P3 arrives through nginx, so which bucket it lands in depends on
`TRUST_PROXY` — which is the next paragraph.

What is not fine: **if `TRUST_PROXY` is left unset behind nginx it defaults to `false`**
(`config/env.js:83-84`, `.env.example:66`), so `req.ip` is nginx's own address for *every* request
and every real client in every school collapses into one shared `ip:127.0.0.1` bucket. That is not a
monitoring artifact. `apiLimiter` is app-wide with no skip, so the whole deployment is then capped at
**1000 requests per 15 minutes in total — about 1.1 requests per second for every school combined**,
and the probes are competing for that same budget. The 429s the monitoring reports are real refusals
of real users; the misconfiguration *is* the outage, and the monitoring is only telling you about it.
A 429 is logged at `warn` with the offending key (`rateLimit.js:143-150`) — if that key is
`ip:127.0.0.1` under real traffic, this is the cause. Set `TRUST_PROXY=1` for one nginx hop.

---

## 5. What no HTTP probe can see

### 5.1 The process — PM2

The API exits **1** on an unhandled rejection or an uncaught exception, after closing the pool
(`server.js:143-154`), and PM2 restarts it. Between the exit and the restart, probes get connection
refused and nginx returns 502. A graceful `SIGTERM` behaves the same way for up to
`SHUTDOWN_TIMEOUT_MS = 15000` ms (`server.js:34`) while in-flight requests drain.

So the signal is **the restart counter, not the probe**. A process that crashes and recovers between
two 60-second probes leaves no trace in the probe history at all.

```sh
pm2 list                       # status + restart count, at a glance
pm2 jlist                      # machine-readable; the restart counter lives here
pm2 describe msms-api          # exit codes, uptime, script path, env
pm2 logs msms-api --lines 100  # stdout/stderr — see the warning below
```

**A non-zero exit code after a deliberate reload is not by itself evidence of a crash.** If the drain
overruns `SHUTDOWN_TIMEOUT_MS`, `server.js:52-54` logs `Graceful shutdown exceeded 15000ms; exiting
now` at **error** level and calls `process.exit(code || 1)`. SIGTERM passes `code = 0`
(`server.js:134-136`), and `0 || 1` is **1** — so a slow-but-correct stop reports exit 1 to PM2 *and*
writes an error line that the §5.4 error-delta will count. Look for that message before treating a
`pm2 reload` as a fault.

**In production `pm2 logs` for the API is nearly empty, and that is correct, not broken.** The
console transport is only added when the process is neither production nor test
(`config/logger.js:44`), so the real log is `storage/logs/`. PM2's captured streams go to
`storage/logs/pm2-api-out.log` and `pm2-api-error.log` (the `out_file` / `error_file` settings in
`deploy/pm2/ecosystem.config.js`), and what reaches them is only what is written outside winston:

- **boot failure** — `server.js:165` writes `Failed to start: …` to stderr as well as the log,
  because a configuration error can be thrown before the log directory is usable. This is the one
  API failure that is reliably visible in `pm2 logs`;
- **the cron process's refusal** (§5.2), which is a `console.error` (`jobs/cron.js:250-254`).

**`EADDRINUSE` is not on that list, and the reason is worth knowing.** `server.js:123-131` handles it
with `logger.error(...)` and then `process.exit(1)`; there is no stderr write on that path. The only
`process.stderr.write` in the API (`server.js:165`) sits inside `start().catch(...)`, which a port
clash never reaches — the `error` event is emitted on the server object asynchronously, *after*
`start()` has already resolved. With no console transport in production, the message goes only to
`storage/logs/error-*.log`, and even that is not guaranteed: `process.exit(1)` fires immediately
after an asynchronous transport write that may not have flushed. **The dependable signature of a port
clash is behavioural — PM2's restart counter climbing, an immediate exit 1, and no `listening on
port` line (`server.js:117-121`) in `combined-*.log` for that restart.**

### 5.2 The cron process — two distinct failures

**Failure A: it never started.** Resident mode refuses to run unless `ENABLE_CRON=true`
(`config/env.js:281`, `.env.example:116`) and exits 1 with an explanation
(`jobs/cron.js:249-255`). Under PM2 that is a restart loop: the restart counter climbs, the process
never reaches `online` for long, and the message repeats in `pm2 logs` — for the cron app, in
`storage/logs/pm2-cron-error.log`. It is the most likely way this deployment ends up with no sweeps
at all, because the flag defaults to false.

**Failure B: it is running and not sweeping.** Nothing external can see this — the scheduler
publishes no port and no status file. The only evidence is the log, and the heartbeat to use is
`notification-dispatch`, because at `*/15 * * * *` (`jobs/tasks/notificationDispatch.js:23`) it is
the most frequent task by a wide margin:

| Task | Schedule | Source |
|---|---|---|
| `subscription-lifecycle` | `5 * * * *` (hourly) | `jobs/tasks/subscriptionLifecycle.js:22` |
| `invoice-issue` | `10 * * * *` (hourly) | `jobs/tasks/invoiceIssue.js:21` |
| `notification-dispatch` | `*/15 * * * *` | `jobs/tasks/notificationDispatch.js:23` |
| `invoice-overdue` | `20 2 * * *` | `jobs/tasks/invoiceOverdue.js:14` |
| `coupon-expiry` | `25 2 * * *` | `jobs/tasks/couponExpiry.js:14` |
| `quotation-expiry` | `30 2 * * *` | `jobs/tasks/quotationExpiry.js:15` |
| `database-backup` | `0 3 * * *` | `jobs/tasks/databaseBackup.js:193` |

A successful run logs `cron: task finished` with `task` and `ms` at **info** level
(`jobs/cron.js:170`); startup logs `cron: scheduler started` (`jobs/cron.js:206`). Real lines, from
this repository's own logs:

```json
{"env":"development","level":"info","message":"cron: task finished","ms":1,"service":"msms-api","task":"invoice-overdue","timestamp":"2026-09-04T12:08:04.932Z"}
{"env":"development","error":"deliberate backup failure","level":"error","message":"cron: task failed","service":"msms-api","task":"database-backup","timestamp":"2026-09-04T12:08:04.934Z"}
```

So: **no `notification-dispatch` finish line in the last 30 minutes ⇒ the scheduler is dead or
wedged.** Thirty minutes is two missed ticks, which is one more than a restart or a slow sweep can
account for.

Three complications, all real:

- **A failed run is logged at `error` (`jobs/cron.js:169`) and therefore lands in
  `error-%DATE%.log`.** That is the file to grep after a heartbeat alert — the `error` field on that
  line is the only place the actual cause appears.
- **`cron: task still running, skipped` (`jobs/cron.js:152`) is not an error and not harmless.** A
  task whose previous tick has not finished is skipped, and if it never finishes, every subsequent
  tick of that task is skipped for the life of the process. `TASK_TIMEOUT_MS` of ten minutes
  (`jobs/cron.js:101`) is what breaks that cycle. Repeated skip lines for one task name mean the
  bound is being hit.
- **A `cron: task failed` line for `database-backup` does not prove there is no backup.** The
  timeout bounds the *scheduler's* wait, not the work — nothing here can cancel a half-written
  `mysqldump` (`jobs/cron.js:106-108`) — so a dump that overruns ten minutes is reported failed and
  then finishes anyway. Always check the file (§5.3) before acting on that line.

#### Which clock names the log file — get this right, or the check is a daily false alarm

**Winston names these files from the host's LOCAL date, not UTC.** Both transports pass
`datePattern: 'YYYY-MM-DD'` and no `utc` option (`config/logger.js:27-41`);
`winston-daily-rotate-file/daily-rotate-file.js:93` defaults it — `utc: options.utc ? options.utc :
false` — and `file-stream-rotator/FileStreamRotator.js:177` then rolls and names on
`moment().local()`. Nothing in `backend/.env`, `.env.example` or `config/env.js` pins `TZ`;
`config.db.timezone` (`config/env.js:131`) is Sequelize's session timezone, not the operating
system's.

The file *contents* use a different clock: `timestamp()` writes ISO-8601 UTC (`…Z`), as the sample
lines above show. So:

- **filenames → `date +%F` (local).** Using `date -u +%F` on a UTC+5 host names yesterday's file from
  00:00 to 05:00 local *every day*: the heartbeat then reports `= none` on a perfectly healthy
  scheduler for five hours, and the error-delta silently reads a file that stopped growing.
- **timestamp arithmetic → no `-u` needed at all.** `date +%s` and `date -d "<ISO Z>" +%s` both
  produce epoch seconds, which are the same number in every timezone.

The alternative fix is to add `utc: true` to both transports in `config/logger.js` and keep
`date -u`. **That change has not been made** — this is a deployment artifact, not an application one
— so every command below uses the local date. If someone does make it, every `date +%F` here becomes
wrong and must be changed back to `date -u +%F` in the same commit.

#### The heartbeat check

GNU `date`, `zcat` and `sed`; Linux target.

```sh
D="$BACKEND/storage/logs"
T=$(date +%F); Y=$(date -d yesterday +%F)

# Both days, plain and gzipped. `sort | tail -1` takes the LATEST timestamp rather than the last
# line read, because these four files are not in chronological order (note 2 in §5.4) — and because
# ISO-8601 UTC sorts lexicographically, `sort` here is chronological.
last=$(zcat -f "$D/combined-$Y.log" "$D/combined-$Y.log.gz" \
              "$D/combined-$T.log" "$D/combined-$T.log.gz" 2>/dev/null \
       | grep '"task":"notification-dispatch"' | grep '"cron: task finished"' \
       | sed -n 's/.*"timestamp":"\([^"]*\)".*/\1/p' \
       | sort | tail -1)

if [ -z "$last" ] || [ $(( $(date +%s) - $(date -d "$last" +%s) )) -ge 1800 ]; then
  echo "CRON HEARTBEAT STALE: last notification-dispatch = ${last:-none}"
fi
```

Two greps rather than one composed pattern, because that is robust to key order — although in
practice winston's `json()` output is key-sorted alphabetically, which the sample lines above
confirm.

Yesterday's files are searched as well so the check does not false-alarm in the first quarter hour
after **local** midnight, when the rotator has opened a new file that the `*/15` task has not yet
written to. The cost is that each run reads both days in full: about 38 MB on this dev box
(`combined-2026-09-03.log` 15 123 298 B + `combined-2026-09-04.log` 22 648 684 B, plus two small
`.gz`). If that is too much I/O for your disk, drop the two `$Y` arguments and accept one possible
false positive in the ten minutes after midnight.

**Only one cron process may ever run.** The skip-if-running set is in-process memory
(`jobs/cron.js:85`), so two instances do not coordinate: they double-notify and race the renewals,
which is precisely what `ENABLE_CRON` exists to prevent (`jobs/cron.js:56-60`). Never start the cron
app in PM2 cluster mode or with `-i` > 1. `pm2 list` showing two cron entries is itself an incident.

### 5.3 Backups

Written to `backend/storage/backups` (`config/env.js:273-275`, `.env.example:111`), daily at 03:00
(`jobs/tasks/databaseBackup.js:193`), retained 30 days (`config/env.js:276`, `.env.example:112`).

**The filename prefix is the configured database name, not the literal string `msms`.**
`databaseBackup.js:39-42` builds it as `` `${config.db.name}-${stamp}.sql` ``, where `stamp` is the
ISO timestamp with the milliseconds stripped and the colons replaced by hyphens — so
`msms-2026-06-15T09-00-00.sql` *on a deployment whose `DB_NAME` is `msms`*, and something else on one
whose is not. `config.db.name` comes from `DB_NAME` (`config/env.js:125`), and the retention prune
keys on the same value (`databaseBackup.js:132`). This is why `$DBNAME` is a variable in the §6
crontab block: a hardcoded `msms-` glob produces a permanent false `BACKUP MISSING` on any other
deployment while backups are being written perfectly well.

**Do not write an "is the backup non-empty" check as if the task might produce an empty one.** It
cannot leave one behind: a `mysqldump` failure deletes the part-written file
(`databaseBackup.js:156-158`), and a zero-byte result is deleted and raised as an error
(`databaseBackup.js:173-176`). The failures that *can* happen are therefore:

1. **No new file at all** — the cron process is dead, or `MYSQLDUMP_PATH` still points at a Windows
   binary. That is not hypothetical: this repository's own `backend/.env:97` reads
   `MYSQLDUMP_PATH=C:/xampp/mysql/bin/mysqldump.exe`. The key itself is defined with a Linux-safe
   default (`config/env.js:277`, `str('MYSQLDUMP_PATH', 'mysqldump')`; `.env.example:113` matches),
   so the way this breaks is a production `.env` copied from the dev box. **Check that one line
   before the first 03:00 after go-live.**
2. **A file that is much smaller than yesterday's** — a dump that succeeded against the wrong or a
   partly-migrated database. Nothing in the task can catch this; only a baseline can.

```sh
newest=$(ls -t "$BACKEND/storage/backups/$DBNAME-"*.sql 2>/dev/null | head -1)
if [ -z "$newest" ]; then
  echo "BACKUP MISSING: no $DBNAME-*.sql in $BACKEND/storage/backups"
elif [ $(( $(date +%s) - $(stat -c %Y "$newest") )) -ge 93600 ]; then
  echo "BACKUP STALE: newest is $newest ($(stat -c %s "$newest") bytes)"
fi
```

93600 s is 26 hours: the job runs at 03:00, so a healthy newest file is always under 24 h old, and
two hours of slack absorbs a late start or a slow dump without alerting every night.

#### There is deliberately no size threshold in that snippet

Because there is no honest number to put in one, and the measured data says so loudly. On 2026-09-04
this repository's dev database logged **68 successful dumps** — `"message":"Database backup written"`
(`databaseBackup.js:179`) in `backend/storage/logs/combined-2026-09-04.log` — whose `bytes` values
run from **148 168 to 459 765**, 66 distinct values, a 3.1× spread on one database on one day. A
comment in the task records a 222 KB dump from an earlier run (`databaseBackup.js:80`).

A floor set from any narrow slice of that would flag a legitimate 148 KB dump as a failure — and none
of it predicts a production dump with real schools in it anyway. **Record the sizes for the first
week after go-live, take the spread as well as the middle, and set the floor from those.** Until that
is done, size is checked by eye:

```sh
ls -lt "$BACKEND/storage/backups/" | head -5
```

And the only check that really proves a backup: restore the newest dump into a scratch database and
count the tables. That is a manual drill, not a probe — nothing on §27's list will do it for you.
Row 7.9's verification asserts that a dump contains all 64 model tables as `CREATE TABLE`, so a
restore drill has a known expected answer.

### 5.4 The logs

Two rotating files in `backend/storage/logs` (`config/env.js:266-268`, `.env.example:107`), retained
`LOG_RETENTION_DAYS=30` (`config/env.js:269`, `.env.example:108`), previous days gzipped
(`config/logger.js:27-41`):

- **`error-%DATE%.log`** — `level: 'error'` only (`config/logger.js:28`). What reaches it is narrow
  and therefore meaningful: **5xx responses with their stack** (`errorHandler.js:245-256`), readiness
  failures (`system.controller.js:64`), `cron: task failed` (`jobs/cron.js:169`), unhandled
  rejections and uncaught exceptions (`server.js:143-154`), the overrun-shutdown line
  (`server.js:53`), and explicit failures like `notifications: email delivery failed`.
- **`combined-%DATE%.log`** — everything at `LOG_LEVEL` and above, including one morgan line per
  request (`app.js:216-219`) and every 4xx at `warn` (`errorHandler.js:257-258`).

**Growth in `error-*.log` is the closest thing this deployment has to an error rate.** Count today's
lines and diff against the last count:

```sh
mkdir -p "$STATE"
ERR="$BACKEND/storage/logs/error-$(date +%F).log"      # LOCAL date — see §5.2

# `grep -c` prints 0 AND exits 1 when there are no matches, so the once-obvious
#     now=$(grep -c '"level":"error"' "$ERR" 2>/dev/null || echo 0)
# runs `echo 0` as well and sets $now to the two-line string "0\n0" on a HEALTHY day. Every later
# [ "$now" -ge … ] then dies with "integer expected", a corrupt count is written to $STATE/errcount
# and poisons the next comparison, no delta is ever reported, and the operator gets a shell error
# every ten minutes until they mute the mailbox — losing the one channel §7 depends on. Reproduced
# on the authoring machine; do not reintroduce the `|| echo 0`.
#
# Take the output, ignore the exit status, and default only when the substitution came back empty
# (which is what a missing file gives). An empty error-<date>.log is normal: the transport creates
# the file when it is constructed, so a day with zero errors still has a zero-byte file.
now=$(grep -c '"level":"error"' "$ERR" 2>/dev/null); now=${now:-0}
was=$(cat "$STATE/errcount" 2>/dev/null); was=${was:-0}
echo "$now" > "$STATE/errcount"

if [ "$now" -ge "$was" ]; then delta=$(( now - was )); else delta="$now"; fi  # file rolled at midnight
if [ "$delta" -gt 0 ]; then
  echo "ERRORS: +$delta since the last run (see $ERR)"
fi
```

Set the alerting threshold from a week of real traffic, not from this document — a busy school day
with one flaky integration produces a nonzero baseline, and an alert on `> 0` will be ignored within
a fortnight.

Five things that will trip you up here:

1. **A 4xx flood is invisible in the error log.** 401s, 403s, 404s and 429s are logged at `warn`
   (`errorHandler.js:258`), so a credential-stuffing run or a client stuck in a retry loop shows up
   only in `combined-*.log`. Search that file for `'"level":"warn"'` when the error log is quiet but
   something is clearly wrong.
2. **Rotated files are gzipped, both forms can coexist, and they are not in chronological order.** On
   this dev box on 2026-09-04 the directory held `combined-2026-09-04.log` (22 648 684 B) beside
   `combined-2026-09-04.log.gz` (63 038 B), and the same pair for 2026-09-03 — where the plain file's
   mtime (Sep 4, 06:36) is *later* than the `.gz`'s (Sep 3, 00:06). Two processes write these files:
   the API and the cron app both load `config/logger.js`, which hardcodes
   `defaultMeta: { service: 'msms-api' }` (`logger.js:54`) for both, and both build transports with
   identical options and therefore share one rotation audit file. So a coexisting pair may be a
   rotation on restart or two writers rotating concurrently — this document cannot tell which from
   the artifacts, and the practical consequence is the same either way: **never rely on file order,
   and never search `*.log` alone. Use `zcat -f` or `zgrep` across both forms and sort on the
   `timestamp` field, not on the file.**
3. **`.<hash>-audit.json` in that directory is the rotator's own bookkeeping.** Deleting those by
   hand breaks retention pruning. Leave them alone.
4. **`LOG_LEVEL=warn` breaks this runbook.** `app.js:210-211` offers it as the way to silence the
   request log when nginx's access log already covers it — but `cron: task finished`
   (`jobs/cron.js:166`), `cron: scheduler started` (`jobs/cron.js:202`) and `Database backup written`
   (`jobs/tasks/databaseBackup.js:179`) are all `info` too. Turning morgan down turns the cron
   heartbeat and the backup record off with it. **Keep `LOG_LEVEL=info` (`config/env.js:265`,
   `.env.example:106`), and control volume with disk checks instead.**
5. **Every path here assumes `LOG_DIR` and `BACKUP_DIR` are left at their relative defaults.** Both
   accept an absolute path and are then used verbatim (`config/env.js:242-244` and `249-251`:
   `path.isAbsolute(...) ? ... : path.join(ROOT, ...)`), and an absolute path such as
   `LOG_DIR=/var/log/msms` is a perfectly normal production choice. Every log and backup path in this
   file is written as `$BACKEND/storage/…`, so **if you override either variable you must change
   these paths too.** The heartbeat and backup checks would at least alert noisily; the error-delta
   above would fail *silently*, reporting nothing for ever, because `grep -c` on a missing file
   yields 0. To take the values from the application rather than trusting this document, run this
   once at install time and paste the results into the §6 block:

   ```sh
   node -e "const c=require('./src/config/env');console.log(c.logging.dir);console.log(c.backup.dir)"
   ```

### 5.5 Disk

Nothing in the application bounds a single day's log file. The transports set `maxFiles` by age but
no `maxSize` (`config/logger.js:27-41`), so one day's `combined-*.log` grows with traffic until the
day rolls over — on this dev box, driven by verification suites, it passed **22 MB in a single day**
(`combined-2026-09-04.log` measured at 22 648 684 bytes while still being appended to). Backups are
bounded by 30 days × dump size, and uploads by nothing at all.

```sh
df -P "$BACKEND/storage" | awk 'NR==2 && $5+0 > 85 { print "DISK: " $5 " used on " $6 }'
du -sh "$BACKEND/storage/logs" "$BACKEND/storage/backups" "$BACKEND/storage/uploads"
```

85% is a convention, not a derived number — it is chosen to leave room to take a backup *after* the
alert fires. Pick your own with the real partition size in front of you.

### 5.6 TLS expiry

§27 lists SSL. An expired certificate is a total outage that every probe in §4 reports as "P3 fails,
P1 fine", which is indistinguishable from nginx being down until someone looks.

**By hand — read the date:**

```sh
echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null \
  | openssl x509 -noout -enddate
certbot certificates     # if the certificate was obtained with certbot
```

**On the schedule — compare, do not print.** `-enddate` writes `notAfter=…` to stdout on *every*
success, so a weekly cron entry built on it mails an identical-looking message whether the
certificate has eighty days left or two, and the operator learns to skim past it. That also breaks
the invariant §6 depends on, that a passing check is silent. `-checkend N` exits non-zero if the
certificate expires within N seconds and is silent otherwise, which is the shape every other check
here has:

```sh
echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null \
  | openssl x509 -noout -checkend 1209600 >/dev/null \
  || echo "TLS: $DOMAIN certificate expires within 14 days, or the handshake failed"
```

1209600 s is 14 days — comfortably inside the 30-days-remaining mark at which certbot's own renewal
timer starts trying, so this fires only if renewal has actually stopped working. A failed handshake
trips it too, because `x509` then gets no input and exits non-zero; that is why the message names
both causes rather than claiming to know which. `>/dev/null` is required: `-checkend` prints
`Certificate will not expire` on success, and this check must be silent when it passes.

`openssl` is a base utility and `certbot` is the conventional means of obtaining the certificate §27
already names. Neither is a monitoring tool being introduced here.

---

## 6. Putting it on a schedule

§27 lists Cron Jobs, so the checks run from the operator's crontab. **This is also the ceiling on
detection speed: cron's finest granularity is one minute**, so worst-case detection latency is
roughly 60 s plus the probe's own timeout. Anything faster needs a resident agent, which is off
§27's list.

Every line below is the one-line form of a snippet from §5 — same logic, same thresholds, folded onto
one line with each `%` escaped. **Nothing here defers to a script that does not exist.** As shipped,
`deploy/monitoring/` contains this README and nothing else, so a crontab line calling
`cron-heartbeat.sh` would be a job that fails on every tick and mails a shell error each time — which
is worse than no check, because it trains the operator to ignore the monitoring mailbox. If you
prefer scripts, lift the multi-line snippets out of §5 into files of your own and change these lines
to call them by absolute path; you then own keeping the two copies in step.

Before installing, set the five variables at the top, and re-read §5.4 note 5 if this deployment
overrides `LOG_DIR` or `BACKUP_DIR`.

```crontab
# Monitoring — SRS §27 row 7.11. Runs as the deploy user.
# BACKEND, DOMAIN and DBNAME are placeholders: set them to this deployment's real values (see §10).
# DBNAME must equal DB_NAME in backend/.env — the dump filename is built from it
# (databaseBackup.js:39-42), so a wrong value here is a permanent false BACKUP MISSING.
# MAILTO only delivers if an MTA is installed on this host; read §7 before relying on it.
MAILTO=ops@example.test
BACKEND=/srv/msms/backend
DOMAIN=msms.example.test
DBNAME=msms
STATE=/var/tmp/msms-monitor

# Note the backslash before every %: an unescaped % in a crontab is a newline, and the command
# silently truncates at it. This is the single most common way a cron probe is written and never runs.
#
# `mkdir -p "$STATE"` is repeated on every line that uses $STATE. Cron forks each entry
# independently and does not serialise entries that share a minute, so the line that happens to run
# first after a reboot or a /var/tmp clean cannot be relied on to have created it for the others.
#
# Filenames use `date +\%F` (LOCAL), because winston names its files from the local clock (§5.2).
# Do not "fix" these to `date -u`.

# every minute — liveness + readiness, direct to the app, bypassing nginx
* * * * * mkdir -p "$STATE"; c=$(curl -sS -m 5 -o /dev/null -w '\%{http_code}' http://127.0.0.1:4000/api/v1/health); [ "$c" = 200 ] || echo "LIVENESS $c"
* * * * * mkdir -p "$STATE"; : > "$STATE/ready.json"; c=$(curl -sS -m 35 -o "$STATE/ready.json" -w '\%{http_code}' http://127.0.0.1:4000/api/v1/health/ready); if [ "$c" != 200 ]; then echo "READINESS $c"; if [ -s "$STATE/ready.json" ]; then cat "$STATE/ready.json"; else echo "(no response body: connection refused, timed out, or the process is gone)"; fi; fi

# every 5 minutes — the public chain: DNS, TLS, nginx, upstream
*/5 * * * * c=$(curl -sS -m 10 -o /dev/null -w '\%{http_code}' https://$DOMAIN/api/v1/health); [ "$c" = 200 ] || echo "PUBLIC $c"

# every 10 minutes — cron heartbeat (§5.2). Reads yesterday's files too so it does not false-alarm
# in the quarter hour after local midnight; `sort | tail -1` because the four files are not in
# chronological order (§5.4 note 2).
*/10 * * * * D="$BACKEND/storage/logs"; T=$(date +\%F); Y=$(date -d yesterday +\%F); last=$(zcat -f "$D/combined-$Y.log" "$D/combined-$Y.log.gz" "$D/combined-$T.log" "$D/combined-$T.log.gz" 2>/dev/null | grep '"task":"notification-dispatch"' | grep '"cron: task finished"' | sed -n 's/.*"timestamp":"\([^"]*\)".*/\1/p' | sort | tail -1); if [ -z "$last" ] || [ $(( $(date +\%s) - $(date -d "$last" +\%s) )) -ge 1800 ]; then echo "CRON HEARTBEAT STALE: last notification-dispatch = ${last:-none}"; fi

# every 10 minutes — the error-log delta (§5.4). The count is taken WITHOUT `|| echo 0`: grep -c
# prints 0 and exits 1 on no matches, and the `||` branch would then append a second 0.
*/10 * * * * mkdir -p "$STATE"; ERR="$BACKEND/storage/logs/error-$(date +\%F).log"; now=$(grep -c '"level":"error"' "$ERR" 2>/dev/null); now=${now:-0}; was=$(cat "$STATE/errcount" 2>/dev/null); was=${was:-0}; echo "$now" > "$STATE/errcount"; if [ "$now" -ge "$was" ]; then d=$(( now - was )); else d="$now"; fi; if [ "$d" -gt 0 ]; then echo "ERRORS: +$d since the last run (see $ERR)"; fi

# 04:00 — after the 03:00 backup has had an hour to finish (§5.3), plus disk (§5.5)
0 4 * * * newest=$(ls -t "$BACKEND/storage/backups/$DBNAME-"*.sql 2>/dev/null | head -1); if [ -z "$newest" ]; then echo "BACKUP MISSING: no $DBNAME-*.sql in $BACKEND/storage/backups"; elif [ $(( $(date +\%s) - $(stat -c \%Y "$newest") )) -ge 93600 ]; then echo "BACKUP STALE: newest is $newest ($(stat -c \%s "$newest") bytes)"; fi
0 4 * * * df -P "$BACKEND/storage" | awk 'NR==2 && $5+0 > 85 { print "DISK: " $5 " used" }'

# Mondays 09:00 — certificate expiry. Silent unless it is within 14 days (§5.6); a bare -enddate
# would print on every run and be filtered out of the mailbox within a month.
0 9 * * 1 echo | openssl s_client -connect $DOMAIN:443 -servername $DOMAIN 2>/dev/null | openssl x509 -noout -checkend 1209600 >/dev/null || echo "TLS: $DOMAIN certificate expires within 14 days, or the handshake failed"
```

Silence is the success condition: every line above prints nothing when it passes, so cron mails only
when something is wrong. That property is the whole reason for the `-checkend` form of the TLS check
and for the `if`-wrapped tails on the heartbeat, error-delta and backup lines — a check that prints
on success trains the operator to filter the entire mailbox, and then the real alerts go with it.

**After installing, prove the plumbing rather than assuming it.** Run the liveness line by hand with
the port changed to a dead one and confirm the mail arrives; then run the error-delta line twice by
hand and confirm the second run is silent. Those two take a minute and catch both of the failure
modes §7 is about.

---

## 7. Alerting — the honest gap

**Mail delivery is not a §27 technology.** §27's list is Node.js, MySQL, Nginx, SSL, Domain,
Environment Variables, PM2, Cron Jobs, Queue Workers, Database Backup, Logging and Monitoring, and it
states that no deployment technology beyond it is introduced. An MTA is not on that list, this
project does not install or configure one, and nothing in `backend/package.json` provides one. So the
delivery path is explicitly **outside this deliverable** — said here rather than quietly assumed,
because cron's `MAILTO` discards output silently when no `sendmail`-compatible binary exists, and
"no news" then looks exactly like "all healthy".

The application's own mail configuration (`MAIL_*`, `config/env.js:231-239`, `mail.driver` defaulting
to `log`) is **not** available for this: it belongs to the API process, is reachable only through the
notification service, and would be down in exactly the incidents worth alerting on.

So, in order of preference:

1. **On §27's list — a state file and a daily habit.** Append each check's output to a file
   (`>> "$STATE/alerts.log"` on each crontab line) and read it at a fixed time every morning. It
   needs nothing that is not already here, and a habit someone actually performs beats an alert path
   nobody has tested.
2. **Off the list, and an operator's decision — a relay MTA.** If your host provisioning already
   includes a mail relay, cron's `MAILTO` will use it and you get push instead of pull. Adding one
   *for this purpose* is a deployment choice beyond §27's scope: make it deliberately, and prove it
   before relying on it — `echo test | mail -s 'msms monitoring test' ops@example.test`, then confirm
   arrival.

Either way, put a **positive** heartbeat somewhere: a check that only speaks on failure is
indistinguishable from a check that is not running. The cheapest version, entirely on-list, is a
daily line that always prints — a `0 8 * * *` entry echoing the newest backup's name and size, say —
so that a silent morning is itself a signal.

---

## 8. Not monitored — and what it would take

Stated plainly rather than left to be discovered during an incident.

| Not monitored | Why not, and what it would need |
|---|---|
| Request latency, throughput, error rate as time series | The app emits no metrics and there is no `/metrics`. The morgan line carries a per-request duration (`app.js:216`) but nothing aggregates it. Needs a metrics endpoint plus a scraper — Prometheus-class tooling, off §27's list |
| Connection-pool saturation | Sequelize's pool exposes no counters here; `/health/ready` only waits (`config/database.js:45-50`). Would need instrumentation the code does not have |
| Queue depth and backlog | `queueStats()` exists (`config/queue.js:141-151`) but has no route and is per-process; the queue lives in the API process's memory. `npm run worker -- --list` prints a **different, empty** process's queue — never read it as the API's depth (`jobs/worker.js:68-72`). A shared view needs a jobs table, which §29/§35 forbid |
| Whether a sweep did the right work | The heartbeat proves a task *ran*; nothing proves it processed the rows it should have. `node src/jobs/cron.js --once --only=…` and reading the JSON report is the manual equivalent (`jobs/cron.js:233-248`) |
| Business-level anomalies (renewals not firing, notifications not sent) | Would be queries against `subscriptions`, `notifications` and the §26 log tables. Writing them is possible with what exists; none are written, and inventing thresholds without production data would produce alerts nobody trusts |
| Multi-process rate-limit accuracy | Counters are per process (`rateLimit.js:27-33`); behind N workers the effective ceiling is N × the limit. A shared store needs `rate-limit-redis`, which is not a dependency. `deploy/pm2/ecosystem.config.js` runs the API `instances: 1, exec_mode: 'fork'` for exactly this reason |
| Uptime from outside the host | Every probe here runs on the box. A host that is off the network reports nothing, and silence looks like health. External checking needs a third-party service — off §27's list, and worth raising with the customer as a deliberate gap rather than papering over |
| Log shipping / retention beyond 30 days | Files stay on the box, pruned at 30 days by winston (`config/logger.js:32`). Centralising them needs Loki/ELK-class tooling, off the list |
| Delivery of the alerts themselves | See §7. Cron's `MAILTO` needs an MTA, which is off §27's list and is not provided here |

---

## 9. Log-line quick reference

Lines are single-line JSON with keys sorted alphabetically (confirmed against the real files in
`backend/storage/logs`), always carrying `service`, `env`, `level`, `message`, `timestamp`.

| Grep for | Level | File | Source | Means |
|---|---|---|---|---|
| `"cron: scheduler started"` | info | combined | `jobs/cron.js:202` | The resident scheduler came up |
| `"cron: task finished"` | info | combined | `jobs/cron.js:166` | A sweep completed; `task` and `ms` alongside |
| `"cron: task failed"` | error | error | `jobs/cron.js:169` | A sweep threw or hit the 10-minute bound; the cause is in its `error` field |
| `"cron: task still running, skipped"` | warn | combined | `jobs/cron.js:152` | Previous tick had not finished |
| `"Database backup written"` | info | combined | `jobs/tasks/databaseBackup.js:179` | `file`, `bytes`, `pruned` |
| `"Readiness check failed: database unreachable"` | error | error | `system.controller.js:64` | Each failed readiness probe |
| `"Rate limit exceeded"` | warn | combined | `rateLimit.js:143` | Includes the `key` that was throttled |
| `"CORS origin refused"` | warn | combined | `app.js:185` | A caller from an origin not in `CORS_ORIGINS` |
| `"Unhandled promise rejection"` / `"Uncaught exception"` | error | error | `server.js:126,134` | The process is about to exit 1 |
| `"Graceful shutdown exceeded"` | error | error | `server.js:52` | A drain that ran past 15 s. Expected on a busy `pm2 reload`, not a fault — but it exits **1** and it counts toward the §5.4 delta |
| `"Shutting down ("` / `"HTTP server closed"` / `"Database pool closed"` | info | combined | `server.js:49,64,67` | A clean stop |
| `"listening on port"` | info | combined | `server.js:119` | A clean start. Its **absence** after a restart is the port-clash signature (§5.1) |
| `"Failed to start"` | error | error + **stderr** | `server.js:164-165` | Boot refused; the one API failure also visible in `pm2 logs` |
| `"statusCode":5` | error | error | `errorHandler.js:245-256` | Any 5xx, with `requestId`, `path`, stack. **Match on `5`, not on `500`** |
| `"statusCode":503` | error | error | mapped at `errorHandler.js:116-128`, logged at `:245-256` | The database-outage signature: Sequelize `ConnectionError` → `DATABASE_UNAVAILABLE`, `TimeoutError` → `DATABASE_TIMEOUT` |

**Do not grep for `"statusCode":500` when hunting a database outage.** `errorHandler.js:116-128` maps
`Sequelize.TimeoutError` and `Sequelize.ConnectionError` to **503**, not 500, and
`scripts/verify-error-handler.js:117-127` asserts exactly that. Since §2's whole incident model is a
database outage, a 500-only grep is the one that returns nothing at the moment you need it. Every
line in `error-*.log` also carries `"level":"error"`, so that string is the widest net when you do
not yet know the code.

To trace one user's report end to end: take the `requestId` from the error envelope they were shown
(`errorHandler.js:270`) and grep both files for it. That works because the *error* paths log
`requestId` explicitly (`errorHandler.js:235`); the morgan line for a successful request does not
carry it (§4).

---

## 10. Assumptions

Each of these is a value this document could not derive. Listed so that a wrong one is a five-minute
fix rather than an hour of confusion.

| Assumed | Where it appears | If it is wrong |
|---|---|---|
| `BACKEND=/srv/msms/backend` | §6 variable block, every path in §5 | Every log, backup and disk check reads nothing. The error-delta fails *silently* (§5.4 note 5) |
| `DOMAIN=msms.example.test` | §6, P3, P4, §5.6 | The public probe and the TLS check test someone else's host, or nothing |
| `DBNAME=msms` | §6, §5.3 | Permanent false `BACKUP MISSING` while backups are written normally. Must equal `DB_NAME` in `backend/.env` (`config/env.js:125`) |
| `STATE=/var/tmp/msms-monitor` | §6, §5.4 | Nothing, as long as it is writable by the deploy user and survives between runs. `/var/tmp` rather than `/tmp` because some distributions clear `/tmp` on boot |
| `MAILTO=ops@example.test` | §6, §7 | Nothing is delivered and every check is silent — the failure §7 is entirely about |
| PM2 app names `msms-api` and `msms-cron` | §5.1, §5.2 | Taken from `deploy/pm2/ecosystem.config.js`. If that file is changed, change the `pm2 describe` / `pm2 logs` arguments here to match |
| `LOG_DIR` and `BACKUP_DIR` at their relative defaults | every path in §5 | See §5.4 note 5 — one of the three checks goes silently wrong rather than loudly |
| The host runs GNU coreutils, `gzip` and GNU `date` | every snippet | `stat -c`, `date -d`, `zcat -f` and `df -P` all need substitutes on BusyBox or BSD |
| The clock cron sees is the clock winston names files with | §5.2, §6 | It is, by construction — both use OS local time. But if you set `TZ` for the PM2 apps and not for cron (or the reverse), the filenames and the checks part company and every log-reading check breaks |

---

## 11. Limitations

The honest list, so nobody discovers these mid-incident.

1. **None of this has been executed against a running deployment.** See §0. The shell has been
   syntax-checked and exercised against this repository's own log files; the crontab has never been
   installed, and no probe here has ever hit a production API.
2. **Detection latency is one minute at best** (§6), and for the cron heartbeat, backup and TLS
   checks it is ten minutes, a day and a week respectively. A backup that fails at 03:00 is reported
   at 04:00; a certificate problem that appears on a Tuesday is reported the following Monday unless
   something else catches it first.
3. **There is no history and no trend.** `$STATE/errcount` holds one integer. Nothing here can answer
   "was it like this yesterday?", which is the second question of most incidents.
4. **No latency, no throughput, no error *rate*.** §8 says why. The error-delta in §5.4 counts log
   lines, not errors per request: the same `+40` means something very different at 09:00 and at
   03:00, and this runbook cannot tell them apart.
5. **Everything runs on the monitored host.** If the box is off the network, every check goes quiet,
   and quiet looks healthy (§8).
6. **Alert delivery is unowned** (§7). Until the state-file habit or an MTA is actually in place,
   every check above is a check nobody reads.
7. **`mysqldump` has an unresolved privilege requirement that this document does not check for.**
   `databaseBackup.js:53-61` runs the dump with `--single-transaction --routines --triggers
   --default-character-set=utf8mb4` and no `--no-tablespaces`; on MySQL 8.0.21+ that combination
   requires the global `PROCESS` privilege, which cannot be granted database-scoped. If it bites, the
   §5.3 freshness check correctly reports `BACKUP MISSING` — but it will not tell you that privileges
   are the reason. The reason is in the `cron: task failed` line's `error` field, which is why §5.2
   says to grep `error-*.log` after a heartbeat or backup alert. Resolving the grant (or adding
   `--no-tablespaces`) is row 7.9's job, not this file's.
8. **The runbook assumes one API process and one cron process.** Both are what
   `deploy/pm2/ecosystem.config.js` configures (`instances: 1, exec_mode: 'fork'` for each). Under
   more than one, the rate-limit arithmetic in §4 is wrong by a factor of N (`rateLimit.js:29-32`)
   and the cron heartbeat becomes meaningless because two schedulers race (§5.2).
