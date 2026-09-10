'use strict';

/**
 * SRS §25 — indexes, pagination and caching, measured. Checklist row 6.15.
 *
 * ## The gap this closes
 *
 * Row 6.15 recorded its coverage precisely and named what was missing: the pagination *query
 * contract* is asserted in `verify-validate.js` and the entitlement cache in
 * `verify-entitlement.js`, but **"no performance measurement exists — no index-usage or query-time
 * assertion anywhere."**
 *
 * §25 states no numeric targets, and none is invented here. A suite asserting "this query runs in
 * under 50 ms" would be measuring this machine on this afternoon, and would fail on a slower one
 * for no reason anybody could act on. What *is* worth asserting is structural and stable:
 *
 *   1. **Every tenant-scoped table can be filtered by an index.** All fifty tables carrying
 *      `school_id` are queried by it on essentially every request, through `tenantWhere()`. A table
 *      without a `school_id`-leading index means a full scan per request, growing with the whole
 *      platform rather than with one school.
 *   2. **The list queries do not full-scan.** `EXPLAIN` reporting `type: 'ALL'` is the shape of the
 *      problem, whatever the clock says.
 *   3. **The cache actually caches.** Counting queries is a measurement that means the same thing on
 *      every machine, unlike a duration.
 *
 * ## Why `EXPLAIN` on an empty table still says something
 *
 * MySQL may choose a scan over an index when a table is small enough that the index is not worth
 * reading — so on a near-empty database `type: 'ALL'` can be the *optimiser being right*. The
 * assertions below therefore check that a usable index **exists and is offered** (`possible_keys`),
 * which is a property of the schema, rather than that the optimiser picked it, which is a property
 * of today's row counts.
 */

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const entitlementService = require('../src/services/entitlementService');
const { getSort } = require('../src/utils/pagination');
const { commonSchemas } = require('../src/middlewares/validate');

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${
      ok ? '' : `  (expected ${JSON.stringify(expected)})`
    }`
  );
}

const created = { schools: [], organizations: [] };

async function dropFixtures() {
  if (created.schools.length) {
    await db.School.destroy({ where: { id: created.schools }, force: true });
  }
  if (created.organizations.length) {
    await db.Organization.destroy({ where: { id: created.organizations }, force: true });
  }
  /* Prefix sweep, for the same reason `verify-security.js` has one: an id list cannot cover a crash. */
  await db.School.destroy({ where: { code: { [db.Sequelize.Op.like]: 'VPERF-%' } }, force: true });
  await db.Organization.destroy({ where: { code: { [db.Sequelize.Op.like]: 'VPERF-%' } }, force: true });
}

/** Every index on a table, as `{ name, columns[] }` ordered by position. */
async function indexesOf(tableName) {
  const [rows] = await db.sequelize.query(`SHOW INDEX FROM \`${tableName}\``);
  const byName = new Map();
  for (const row of rows) {
    if (!byName.has(row.Key_name)) byName.set(row.Key_name, []);
    byName.get(row.Key_name)[row.Seq_in_index - 1] = row.Column_name;
  }
  return [...byName].map(([name, columns]) => ({ name, columns }));
}

async function main() {
  /*
   * Leftovers from a killed earlier run are cleared here, before anything is created — and the leak
   * check that used to sit here now runs after teardown instead.
   *
   * `verify-security.js` once crashed mid-run and left a `VSEC-XSS2` organization behind, which then
   * broke `verify-platform-modules.js` four assertions deep — a list ordered by `code` returned an
   * extra row, and the failure pointed at sorting rather than at the suite that had leaked. The
   * fixtures here are named `VPERF-*`, which sorts into the same neighbourhood, so this suite owes the
   * same guard.
   *
   * It asserted *"no fixture is left over from a previous run"* at this point, and that punished the
   * wrong run: a leak from a buggy teardown and a leftover from a killed process look identical here,
   * and only the first is a defect. Measured — a run killed at 15 of 16 assertions made the next one
   * fail this check with nothing wrong in the code. So the sweep clears what a dead run left, and the
   * same count is asserted after `dropFixtures()` below, where it tests the teardown of the run that
   * actually executed and fails in the run that leaked rather than the one after it.
   */
  const residueCleared = await sweepResidue(db, { codes: ['VPERF-'] });
  if (residueCleared) {
    console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
  }

  console.log('');
  console.log('── every tenant-scoped table can be filtered by an index ──');
  console.log('');

  const tenantModels = Object.keys(db).filter(
    (name) => db[name] && db[name].rawAttributes && db[name].rawAttributes.school_id
  );

  check('the tenant-scoped tables are found', tenantModels.length >= 50, true);

  /*
   * A `school_id`-**leading** index, not merely one that mentions the column. A composite index on
   * `(status, school_id)` cannot serve a query filtering on `school_id` alone — MySQL reads a
   * composite left to right, so the leading column decides what the index is usable for. That
   * distinction is the whole assertion; checking for the column anywhere would pass on an index
   * that never helps.
   */
  const unindexed = [];
  for (const name of tenantModels) {
    const table = db[name].getTableName();
    // eslint-disable-next-line no-await-in-loop
    const indexes = await indexesOf(table);
    if (!indexes.some((index) => index.columns[0] === 'school_id')) unindexed.push(table);
  }

  check('every table carrying school_id has a school_id-leading index', unindexed, []);

  /*
   * The trail tables are the ones that grow fastest and are read least, so they are the likeliest to
   * be left unindexed. Named individually because a regression there would be invisible until a
   * school's audit view timed out.
   */
  for (const modelName of ['ActivityLog', 'AuditLog']) {
    if (!db[modelName]) continue;
    // eslint-disable-next-line no-await-in-loop
    const indexes = await indexesOf(db[modelName].getTableName());
    check(`  including ${db[modelName].getTableName()}, which grows fastest of all`,
      indexes.some((index) => index.columns[0] === 'school_id'), true);
  }

  /*
   * The column count, model side against database side.
   *
   * Known Issue #8 recorded an "unexplained 2-column discrepancy" for several sessions:
   * `npm run db:schema` counted **1,154** columns from the models and `information_schema` reported
   * **1,156** live. Diffed per table, the model and the database agree exactly — zero columns on
   * either side that the other lacks. The whole difference is `sequelize_meta`, which has two columns
   * (`name`, `applied_at`), and the two counts simply included different table sets: one counts the
   * 64 SRS tables, the other counts all 65 objects.
   *
   * Asserted rather than just written down, because "unexplained" is what it was for several
   * sessions. If a 65th table ever appears, or a column drifts on either side, this fails instead of
   * becoming a new mystery.
   */
  const modelColumns = tenantModels.length
    ? Object.values(db)
        .filter((m) => m && m.rawAttributes && typeof m.getTableName === 'function')
        .reduce((sum, m) => sum + Object.keys(m.rawAttributes).length, 0)
    : 0;
  const [liveAll] = await db.sequelize.query(
    'SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE()'
  );
  const [liveSrs] = await db.sequelize.query(
    "SELECT COUNT(*) AS c FROM information_schema.columns " +
      "WHERE table_schema = DATABASE() AND table_name <> 'sequelize_meta'"
  );

  check('the models and the database agree on the column count',
    Number(liveSrs[0].c), modelColumns);
  check("  and the only difference from the raw total is sequelize_meta's two bookkeeping columns",
    Number(liveAll[0].c) - Number(liveSrs[0].c), 2);

  console.log('');
  console.log('── the list queries have an index available to them ──');
  console.log('');

  /*
   * Every tenant table, not a hand-picked six.
   *
   * The first draft of this block listed six table names as string literals, and one of them —
   * `student_attendances` — does not exist; the table is `student_attendance`, singular. The suite
   * crashed on it. A typed name is a name that can be wrong, and a *near-miss* typed name is worse
   * than a wildly wrong one: had I written `students_attendance` the mistake would have been obvious,
   * whereas a plausible plural reads as correct forever. So the names come from `getTableName()` and
   * the set is the whole fifty. Nothing here can drift from the schema, because nothing here
   * restates it.
   *
   * ## What is asserted, and why not `possible_keys`
   *
   * The draft asserted that every plan offered a `possible_keys`, and `school_settings` failed it —
   * correctly, and for a reason worth keeping in the file. That table holds one row per school, so
   * its `school_id` index is **UNIQUE on that column alone**. MySQL therefore resolves `school_id = 1`
   * as a *const* lookup while optimising, finds no row, and reports `Impossible WHERE noticed after
   * reading const tables` with a null plan. `possible_keys` is null because no plan was needed — the
   * best possible outcome, indistinguishable in that one field from the worst.
   *
   * That is the same data-dependence this comment warns about two paragraphs up, wearing a different
   * hat: `key` depends on row counts, and `possible_keys` turns out to as well. So the assertion
   * targets the actual pathology instead — `type: 'ALL'` **with no index offered at all**, which is a
   * scan forced by an absent index rather than one the optimiser chose because the table is small.
   * A small-table scan still reports its `possible_keys`, so this cannot false-fail as the database
   * fills or empties.
   */
  const forcedScan = [];
  let constResolved = 0;
  for (const name of tenantModels) {
    const table = db[name].getTableName();
    // eslint-disable-next-line no-await-in-loop
    const [rows] = await db.sequelize.query(
      `EXPLAIN SELECT * FROM \`${table}\` WHERE school_id = 1 LIMIT 20`
    );
    const plan = rows[0] || {};
    if (plan.type === 'ALL' && !plan.possible_keys) forcedScan.push(table);
    if (plan.type === null && String(plan.Extra || '').includes('Impossible WHERE')) constResolved += 1;
  }
  check('no tenant-filtered list query is a full scan forced by a missing index', forcedScan, []);

  /*
   * Named rather than merely tolerated. A const-resolved table is the one-row-per-school shape, and
   * counting them keeps the exemption honest: if this number grew, it would mean a table that should
   * hold many rows per school had acquired a unique `school_id` index — a schema mistake this suite
   * would otherwise wave through as "not a forced scan".
   */
  check('  and the const-resolved tables are the one-row-per-school ones', constResolved <= 2, true);

  /*
   * And nothing plans a **dependent** subquery, which is the one plan shape that degrades per row
   * rather than per query — the difference between a slow page and a page that gets slower as the
   * school grows.
   */
  const [joinPlan] = await db.sequelize.query(
    'EXPLAIN SELECT u.id FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.school_id = 1 LIMIT 20'
  );
  check('a joined list plans no dependent subquery',
    joinPlan.filter((row) => String(row.select_type || '').includes('DEPENDENT')).length, 0);

  console.log('');
  console.log('── pagination is bounded, so no request can ask for everything ──');
  console.log('');

  /*
   * The contract is asserted in `verify-validate.js`; what matters here is the *consequence* — that
   * an unbounded read is impossible, which is what keeps a list query's cost independent of how much
   * data a school has accumulated.
   */
  const huge = commonSchemas.pagination.validate({ page: 1, limit: 100000 });
  check('a limit beyond the maximum is refused rather than clamped silently',
    Boolean(huge.error), true);

  const noLimit = commonSchemas.pagination.validate({});
  check('  and omitting the limit yields a default rather than "all rows"',
    typeof noLimit.value.limit === 'number' && noLimit.value.limit > 0, true);

  /*
   * The ORDER BY tiebreaker, restated here as a performance property rather than a correctness one:
   * without it a paged read is not reproducible, so a client walking pages re-fetches and re-renders
   * rows it already has.
   */
  check('every ordered page has a deterministic tail',
    getSort({ query: {} }, ['name']).length, 2);

  console.log('');
  console.log('── the cache actually caches ──');
  console.log('');

  const organization = await db.Organization.create({
    name: 'Verify Performance Org',
    code: 'VPERF-ORG',
    email: 'org@verify-performance.local',
  });
  created.organizations.push(organization.id);

  const school = await db.School.create({
    organization_id: organization.id,
    name: 'Verify Performance School',
    code: 'VPERF-SCH',
    email: 'school@verify-performance.local',
  });
  created.schools.push(school.id);

  /*
   * Counted queries, not elapsed milliseconds. A duration measures this machine on this afternoon
   * and would fail on a slower one for a reason nobody could act on; a query count means the same
   * thing everywhere, and "the second call issued none" is exactly what caching claims.
   */
  const realQuery = db.sequelize.query.bind(db.sequelize);
  let queries = 0;
  db.sequelize.query = (...args) => {
    queries += 1;
    return realQuery(...args);
  };

  let firstCall = 0;
  let secondCall = 0;
  try {
    /* `invalidateSchool` is async — an un-awaited call here would race the read it is meant to precede. */
    await entitlementService.invalidateSchool(school.id);
    queries = 0;
    await entitlementService.getSnapshot(school.id);
    firstCall = queries;

    queries = 0;
    await entitlementService.getSnapshot(school.id);
    secondCall = queries;
  } finally {
    db.sequelize.query = realQuery;
  }

  check('the first snapshot reads the database', firstCall > 0, true);
  check('  and the second reads none of it — the cache is real, not decorative', secondCall, 0);

  /*
   * Invalidation is the half that makes a cache safe rather than merely fast. A cache that never
   * expires is a correctness bug: a plan change would not reach a school until the process restarted.
   */
  await entitlementService.invalidateSchool(school.id);
  queries = 0;
  db.sequelize.query = (...args) => {
    queries += 1;
    return realQuery(...args);
  };
  try {
    await entitlementService.getSnapshot(school.id);
  } finally {
    db.sequelize.query = realQuery;
  }
  check('and invalidating it sends the next read back to the database', queries > 0, true);
}

main()
  .catch(async (err) => {
    failures += 1;
    console.error('\nverify-performance crashed:', err);
  })
  .finally(async () => {
    try {
      await dropFixtures();
      /* The leak check, where it tests this run's own teardown — see the note at the top of main(). */
      const left = await db.Organization.count({
        where: { code: { [db.Sequelize.Op.like]: 'VPERF-%' } },
        paranoid: false,
      });
      check('this run leaves no fixture behind for the next one', left, 0);
    } catch (cleanupError) {
      failures += 1;
      console.error('teardown failed:', cleanupError.message);
    }
    console.log('');
    console.log(failures === 0 ? 'All performance checks passed.' : `${failures} check(s) FAILED.`);
    await db.sequelize.close();
    process.exit(failures === 0 ? 0 : 1);
  });
