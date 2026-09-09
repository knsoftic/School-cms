'use strict';

/**
 * Waiting for writes that land *after* the response — the shared fix for Known Issues #25.
 *
 * `logActivity` registers its insert as `res.on('finish', …)` and does not await it. The middleware
 * says so outright (`src/middlewares/activityLog.js:246`, and the comment at :278 — *"Not awaited.
 * `finish` has already fired, so there is nobody left to wait for the insert"*). That is a deliberate
 * product decision: a logging insert that threw would otherwise turn a successful save into a 500.
 *
 * The consequence for a verification suite is that `await fetch(...)` resolving does **not** mean the
 * `activity_logs` / `audit_logs` rows exist yet. A suite that queries those tables on the next line is
 * racing the middleware. Serially the race is almost always won; under concurrent load it is not, and
 * that is the mechanism behind Known Issues #25's *"a parallel run reports false failures"*.
 *
 * Five suites already solved this locally — `verify-auth-module`, `verify-middlewares`,
 * `verify-platform-modules`, `verify-users-roles` and `verify-notifications` — with sleeps or private
 * pollers. This module is that fix, made shared and uniform, so the twenty that had no wait get the
 * same semantics rather than twenty slightly different ones.
 *
 * ## Why these poll rather than sleep
 *
 * A fixed `sleep(400)` costs 400ms on every run and is still a guess. These return the moment the
 * expected state is reached — normally on the first read, so the common case costs nothing — and only
 * spend time when the alternative was a false failure.
 *
 * ## Which reads actually race — measured, because only one of the two tables does
 *
 * `activity_logs` races. `audit_logs` does **not**: `recordAudit()` awaits `AuditLog.create()`, and
 * all 122 call sites across the modules use `await recordAudit(` — zero exceptions — so the row is
 * committed inside the request, before the response is sent. Only `recordActivity()` is fired
 * unawaited from `res.on('finish')`.
 *
 * Several suites nonetheless wrap their `AuditLog` reads too. Those wraps are **defensive, not
 * load-bearing**, and cost nothing (the poll returns on its first read when the rows are already
 * there). Said plainly here rather than left to look like coverage, which is the standing rule: a
 * guard that is defensive and one that is load-bearing are different claims.
 *
 * ## What this does NOT fix, and nothing here can
 *
 * Running suites **concurrently** still fails, for an unrelated reason: every suite tears down with
 * `destroy({ where: { id: { [Op.gt]: baseline } } })` on both tables — an unbounded delete of
 * everything above *its own* baseline. Two suites at once, and whichever finishes first deletes the
 * other's rows. Measured directly by sampling the table during a five-way concurrent run:
 * `activity_logs` went 39 rows -> 10 -> 1 while all five suites were still working.
 *
 * That is the real mechanism behind Known Issues #25's *"a parallel run reports false failures"*, and
 * polling cannot repair it — the rows are deleted, not late. Making the suites concurrency-safe means
 * scoping each teardown to the rows that suite actually produced, and is the prerequisite for
 * checklist row 6.17 (folding these into a jest suite, which would run them in parallel by default).
 *
 * ## Why they cannot hide a real defect
 *
 * Each returns **whatever it last saw** when the deadline passes; none throws and none substitutes a
 * value. So a guard that genuinely never writes still produces the wrong value and still fails its
 * assertion, one second later. A poll that could not fail would be worse than no assertion at all —
 * which is the standing rule in §5a.
 */

const DEFAULT_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 20;

/** Absence needs a grace period instead: there is no value to poll toward. */
const QUIESCE_MS = 400;

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-run `read` until `done(value)` holds, or the deadline passes.
 *
 * @param {() => Promise<any>} read   the query to repeat
 * @param {(value:any) => boolean} done  what "settled" means for this assertion
 * @param {number} [timeoutMs]
 * @returns {Promise<any>} the last value read, settled or not
 */
async function settle(read, done, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await pause(POLL_INTERVAL_MS);
    value = await read();
  }
  return value;
}

/** Rows, settled once at least `count` of them exist. The common case for a trail read. */
function settleRows(read, count = 1, timeoutMs) {
  return settle(read, (rows) => Array.isArray(rows) && rows.length >= count, timeoutMs);
}

/** Rows, settled once `field` shows at least `n` distinct values — for "both events are exercised". */
function settleDistinct(read, field, n, timeoutMs) {
  return settle(
    read,
    (rows) => Array.isArray(rows) && new Set(rows.map((r) => r[field])).size >= n,
    timeoutMs
  );
}

/** A count, settled once it reaches `want`. */
function settleCount(read, want, timeoutMs) {
  return settle(read, (value) => value >= want, timeoutMs);
}

/**
 * For asserting that something was **not** written.
 *
 * There is no value to poll toward, so a grace period is waited out first — the same shape
 * `verify-middlewares.js` uses as `noActivityFor()`. Without it the assertion passes trivially,
 * because nothing has had time to arrive whether or not the code writes.
 */
async function quiesce(ms = QUIESCE_MS) {
  await pause(ms);
}

module.exports = {
  settle,
  settleRows,
  settleDistinct,
  settleCount,
  quiesce,
  DEFAULT_TIMEOUT_MS,
  QUIESCE_MS,
};
