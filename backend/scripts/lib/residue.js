'use strict';

/**
 * Clearing what a KILLED earlier run left behind, so that one killed run cannot turn the next loop red.
 *
 * ## The failure this exists for, measured rather than supposed
 *
 * Every suite that builds fixtures tears them down in a `finally`, by the ids it created in the current
 * run. That is right for a run that finishes and useless for one that does not: a process killed
 * partway — a session restart, a closed terminal, a CI timeout — runs no `finally` at all, and nothing
 * will ever remove what it built. On 2026-09-10 a session restart did exactly that inside
 * `verify-finance.js`; the next run crashed on `code must be unique` and `verify-seed.js` failed two
 * assertions because it counts users and found the dead run's.
 *
 * Measured across the loop by hard-killing each suite at 85% of its recorded assertions — fixtures
 * built, teardown not reached — and running it again: **28 of the 40 suites could not recover.** Their
 * second run either crashed on a unique code or email, or passed while leaving the dead run's rows
 * behind for a later suite to trip over. `verify-jobs.js`' rerun created 68 `usage_records` because its
 * headcount sync swept up other suites' abandoned schools. Residue does not stay in its own lane.
 *
 * ## What this does
 *
 * Finds the dead run's **roots** by the suite's own markers — school, organization and plan codes by
 * prefix, users by email domain — widens them to the whole tree (a school inside a leftover
 * organization, a user inside a leftover school), and removes everything underneath.
 *
 * **It does not simply delete the roots and let the cascade run, and it was first written that way.**
 * `schools` does cascade to 49 tables and `organizations` to 39, but deleting a school measured
 * error 1452: the cascade reaches `classes` by two paths, one of which is an UPDATE that InnoDB checks
 * against the school it is already deleting. So every table carrying the leftover `school_id` or
 * `organization_id` is cleared **first**, while the roots are still alive, and the roots go last —
 * `clearByColumn()` has the detail. Only three foreign keys in the schema are RESTRICT, and the order
 * below is also what they require:
 *
 *  - `subscriptions.plan_id → subscription_plans` — so subscriptions go before plans;
 *  - `users.role_id → roles` — so users go before any custom role a suite created;
 *  - `subscription_addons.addon_id → addons` — seeded, never deleted here.
 *
 * Log rows are removed by user **before** the users, because `activity_logs.user_id` and
 * `audit_logs.user_id` are SET NULL: afterwards there would be nothing left to find them by.
 *
 * Raw SQL, deliberately: most root tables are paranoid, and a soft-deleted row still holds its unique
 * code. `destroy({ force: true })` on each would be the model-layer equivalent; one DELETE per table is
 * the same effect with no hooks to reason about.
 *
 * ## What it must never do
 *
 * **Touch a row it cannot prove is this suite's.** Every clause is keyed on the caller's markers, and a
 * suite with no markers gets nothing deleted. Suites run serially under `tests/.suite-run.lock`, so
 * anything carrying a suite's markers at that suite's start is residue by construction — but the
 * scoping still matters, because a prefix shared between two suites would let one delete the other's
 * live fixtures if the lock were ever bypassed (Known Issues #25).
 *
 * Seeded rows a suite mutates in place — the seven add-ons, a role's grants — carry no marker, so this
 * cannot restore them. `openJournal()` below is for those.
 */

const fs = require('fs');
const path = require('path');

/** Build `(col LIKE :a OR col LIKE :b)` and its replacements, or null when there is nothing to match. */
function likeClause(column, patterns, key) {
  if (!patterns.length) return null;
  const replacements = {};
  const parts = patterns.map((pattern, i) => {
    replacements[`${key}${i}`] = pattern;
    return `${column} LIKE :${key}${i}`;
  });
  return { sql: `(${parts.join(' OR ')})`, replacements };
}

async function idsWhere(db, table, clause) {
  if (!clause) return [];
  const rows = await db.sequelize.query(`SELECT id FROM \`${table}\` WHERE ${clause.sql}`, {
    replacements: clause.replacements,
    type: db.sequelize.QueryTypes.SELECT,
  });
  return rows.map((row) => row.id);
}

async function deleteIn(db, table, column, ids) {
  if (!ids.length) return 0;
  const [result] = await db.sequelize.query(`DELETE FROM \`${table}\` WHERE \`${column}\` IN (:ids)`, {
    replacements: { ids },
  });
  return result && typeof result.affectedRows === 'number' ? result.affectedRows : 0;
}

/** 1451 / 1452 — a row is still referenced, or an update would point at a row being deleted. */
function isForeignKeyError(err) {
  const code = err && ((err.original && err.original.code) || (err.parent && err.parent.code));
  return code === 'ER_ROW_IS_REFERENCED_2' || code === 'ER_NO_REFERENCED_ROW_2';
}

/** Every base table that carries `column`, except `exclude`. */
async function tablesWith(db, column, exclude) {
  const rows = await db.sequelize.query(
    'SELECT c.TABLE_NAME AS t FROM information_schema.COLUMNS c ' +
      'JOIN information_schema.TABLES tb ON tb.TABLE_NAME = c.TABLE_NAME AND tb.TABLE_SCHEMA = c.TABLE_SCHEMA ' +
      "WHERE c.TABLE_SCHEMA = DATABASE() AND c.COLUMN_NAME = :column AND tb.TABLE_TYPE = 'BASE TABLE'",
    { replacements: { column }, type: db.sequelize.QueryTypes.SELECT }
  );
  return rows.map((row) => row.t).filter((t) => t !== exclude);
}

/**
 * Delete every row carrying one of `ids` in `column`, across the whole schema, **before** the root.
 *
 * Why not just delete the root and let the cascade run: measured, it fails. `schools` cascades to both
 * `academic_sessions` and `classes`, and deleting a session SET-NULLs `classes.academic_session_id` —
 * an UPDATE on a `classes` row whose `school_id` still names the school being deleted in the same
 * statement. InnoDB checks that key against a parent it has already marked deleted and refuses with
 * 1452. It is a diamond in the cascade graph, and the same shape recurs one level down between
 * `classes`, `sections` and `students`. Every suite's own teardown deletes children before the school
 * for exactly this reason.
 *
 * So the children go first, while every root is still alive — then no intermediate check can see a
 * dying parent. Order among the children is found rather than declared: a table a sibling still blocks
 * is retried on the next pass, and each pass clears at least the leaves, so it converges.
 */
async function clearByColumn(db, column, ids, exclude) {
  if (!ids.length) return;
  let pending = await tablesWith(db, column, exclude);
  for (let pass = 0; pending.length; pass += 1) {
    const blocked = [];
    for (const table of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await deleteIn(db, table, column, ids);
      } catch (err) {
        if (!isForeignKeyError(err)) throw err;
        blocked.push(table);
      }
    }
    if (blocked.length === pending.length) {
      throw new Error(`sweepResidue: could not clear ${column} from ${blocked.join(', ')}`);
    }
    pending = blocked;
  }
}

/**
 * Remove a dead run's leftovers.
 *
 * @param {object} db  the `src/models` export
 * @param {object} markers
 * @param {string[]} [markers.codes]    code prefixes: matched against schools, organizations, plans
 * @param {string[]} [markers.domains]  email domains, without the `@`: matched against users
 * @param {Array<{table: string, column: string, prefix: string}>} [markers.also]
 *        platform tables that hang off no school — coupons, taxes, custom roles — deleted last
 * @param {string} [markers.uploadsDir]  when given, each leftover school's `school-<id>` directory under
 *        it is removed too, the way the suites that upload remove their own
 * @returns {Promise<number>} how many root rows were found; 0 means a clean start
 */
async function sweepResidue(db, { codes = [], domains = [], also = [], uploadsDir = null } = {}) {
  const codePatterns = codes.map((prefix) => `${prefix}%`);
  const emailPatterns = domains.map((domain) => `%@${domain}`);

  const [schoolsByCode, organizations, plans, usersByEmail] = await Promise.all([
    idsWhere(db, 'schools', likeClause('code', codePatterns, 's')),
    idsWhere(db, 'organizations', likeClause('code', codePatterns, 'o')),
    idsWhere(db, 'subscription_plans', likeClause('code', codePatterns, 'p')),
    idsWhere(db, 'users', likeClause('email', emailPatterns, 'u')),
  ]);

  /*
   * A school inside a leftover organization is leftover too, whatever its own code, and so is a user
   * inside a leftover school or organization. Widened here, once, so every step below works on the
   * whole tree rather than on the rows that happened to carry a marker.
   */
  const schoolsInOrgs = organizations.length
    ? (await db.sequelize.query('SELECT id FROM schools WHERE organization_id IN (:ids)', {
      replacements: { ids: organizations }, type: db.sequelize.QueryTypes.SELECT,
    })).map((row) => row.id)
    : [];
  const schools = [...new Set([...schoolsByCode, ...schoolsInOrgs])];
  const usersInTenants = schools.length || organizations.length
    ? (await db.sequelize.query(
      'SELECT id FROM users WHERE ' +
        [schools.length ? 'school_id IN (:schools)' : null, organizations.length ? 'organization_id IN (:orgs)' : null]
          .filter(Boolean).join(' OR '),
      { replacements: { schools, orgs: organizations }, type: db.sequelize.QueryTypes.SELECT }
    )).map((row) => row.id)
    : [];
  const users = [...new Set([...usersByEmail, ...usersInTenants])];

  const extras = [];
  for (const entry of also) {
    // eslint-disable-next-line no-await-in-loop
    const ids = await idsWhere(db, entry.table, likeClause(`\`${entry.column}\``, [`${entry.prefix}%`], 'x'));
    extras.push({ ...entry, ids });
  }

  const found =
    schools.length + organizations.length + plans.length + users.length +
    extras.reduce((sum, entry) => sum + entry.ids.length, 0);
  if (!found) return 0;

  /* The dead run's own trail first, before anything SET-NULLs the `user_id` that would find it. */
  await deleteIn(db, 'activity_logs', 'user_id', users);
  await deleteIn(db, 'audit_logs', 'user_id', users);

  /* Everything under the leftover tenants, children first, roots still alive — see clearByColumn. */
  await clearByColumn(db, 'school_id', schools, 'schools');
  await clearByColumn(db, 'organization_id', organizations, 'organizations');
  await deleteIn(db, 'schools', 'id', schools);
  await deleteIn(db, 'organizations', 'id', organizations);

  /* A subscription on a leftover plan whose school was not leftover: RESTRICT, so it goes first. */
  await deleteIn(db, 'subscriptions', 'plan_id', plans);
  await deleteIn(db, 'subscription_plans', 'id', plans);
  await deleteIn(db, 'users', 'id', users);

  /* Platform tables last — a custom role cannot go while a user still holds it. */
  for (const entry of extras) {
    // eslint-disable-next-line no-await-in-loop
    await deleteIn(db, entry.table, 'id', entry.ids);
  }

  if (uploadsDir) {
    for (const id of schools) {
      fs.rmSync(path.join(uploadsDir, `school-${id}`), { recursive: true, force: true });
    }
  }

  return found;
}

/* ═══════════════════════ seeded rows a suite mutates in place ═══════════════════════ */

/**
 * A journal for the suites that change **seeded** rows and put them back — the seven add-ons, a role's
 * grants — which `sweepResidue()` cannot reach, having no marker to find them by.
 *
 * Those suites capture the rows at the start and restore them in a `finally`. A killed run skips the
 * restore, and the danger is worse than a leftover: the **next** run captures the already-mutated rows
 * as its "original" and then faithfully restores the damage, for ever. Measured — a killed
 * `verify-addons.js` left five extra `addon_prices` and two extra grants, and its rerun preserved all
 * seven.
 *
 * So the capture is written to disk as well as memory, and deleted only once the restore has run. A
 * journal found at start is a capture from **before** a dead run mutated anything, which is exactly the
 * state to put back. By induction this holds across any number of consecutive killed runs: each one
 * either restores and clears the journal it found, or dies before it writes a new one.
 *
 * `backend/tests/.journal/` is gitignored.
 */
const JOURNAL_DIR = path.join(__dirname, '..', '..', 'tests', '.journal');

function journalFile(name) {
  return path.join(JOURNAL_DIR, `${name}.json`);
}

/** The capture a dead run left behind, or null when the last run finished. */
function readJournal(name) {
  try {
    return JSON.parse(fs.readFileSync(journalFile(name), 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeJournal(name, data) {
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });
  fs.writeFileSync(journalFile(name), JSON.stringify(data));
}

function clearJournal(name) {
  fs.rmSync(journalFile(name), { force: true });
}

/* ═══════════════════════ the seeded catalogue itself ═══════════════════════ */

/**
 * Put the seeded roles and permissions back to their definition.
 *
 * `verify-seed.js` is the one suite that damages the catalogue on purpose, to prove the seeders heal it:
 * it revokes and adds `teacher` grants, strips one from `super_admin`, empties `librarian`, plants a
 * `zz.orphan.test` permission, and **deletes the `parent` role outright** — then restores everything at
 * the end, inline. A kill anywhere in that window leaves every other suite running against a wrong
 * catalogue, and because `verify-seed.js` runs thirty-third, a heal inside it alone would still cost
 * one red loop for whichever earlier suite needs those roles. So this runs twice: at the start of that
 * suite, and once before the whole loop in `tests/globalSetup.js`.
 *
 * The seeder does most of it, being idempotent — it re-creates a missing role, hard-syncs `super_admin`
 * to the full catalogue, removes a permission the source does not define, and re-bootstraps a role that
 * has been **emptied**. What it deliberately leaves alone is a single revoked or added grant: an
 * administrator's choice is not the seeder's to reverse, which `verify-seed.js` asserts. So the two
 * roles that suite diverges are emptied first, which is exactly how its own final restore works.
 *
 * Log output is suppressed for the duration, as `verify-seed.js` does, because the seeder narrates at
 * info level and this runs in the middle of other output.
 */
async function restoreSeededCatalogue(db) {
  // eslint-disable-next-line global-require
  const seed = require('../../src/database/seed');
  // eslint-disable-next-line global-require
  const logger = require('../../src/config/logger');
  const saved = {};
  for (const level of ['info', 'warn', 'error']) {
    saved[level] = logger[level];
    logger[level] = () => {};
  }
  try {
    await db.sequelize.query("DELETE FROM permissions WHERE `key` = 'zz.orphan.test'");
    await db.sequelize.query(
      'DELETE rp FROM role_permissions rp JOIN roles r ON r.id = rp.role_id ' +
        "WHERE r.slug IN ('teacher', 'librarian')"
    );
    await seed.run(db.sequelize);
  } finally {
    for (const level of Object.keys(saved)) logger[level] = saved[level];
  }
}

module.exports = {
  sweepResidue,
  readJournal,
  writeJournal,
  clearJournal,
  restoreSeededCatalogue,
  JOURNAL_DIR,
};
