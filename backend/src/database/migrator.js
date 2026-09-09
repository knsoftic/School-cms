'use strict';

/**
 * Migration runner.
 *
 * Sequelize ships `sequelize-cli`, but it insists on its own config format, its own
 * `models/index.js` conventions, and a global install. This runner is ~200 lines, uses the
 * project's existing env config, and adds the one thing that matters on MySQL:
 *
 *   MySQL and MariaDB do not support transactional DDL. A CREATE TABLE inside a
 *   transaction commits immediately, so a migration that fails halfway cannot be rolled
 *   back by the database. This runner therefore calls the failing migration's own `down()`
 *   as a best-effort cleanup, and reports clearly if that cleanup also fails.
 *
 * Applied migrations are recorded in `sequelize_meta`.
 *
 * On that table and SRS §29: §29 fixes the *application* schema at 64 tables ("No
 * additional tables are introduced"), and `assertSchemaMatchesSrs()` enforces exactly that.
 *
 * `sequelize_meta` is not application data - it is the ledger required by the migration tooling
 * that **§32 step 2** mandates: *"2. Create database migration."*
 *
 * That citation was wrong until the §36 final pass, and wrong in the way that matters most here. It
 * read "the migration tooling that SRS §3 and §28 themselves mandate ("Database Migrations", "Run
 * migrations")" - and **neither phrase occurs anywhere in the SRS**. Nor does "Seed initial data",
 * quoted in `cli.js`. The word "migration" appears exactly **once** in all 1,698 lines, at §32
 * step 2; the word "seed" appears **zero** times. §3 lists only the technology stack and §28 is
 * entirely about Swagger/OpenAPI.
 *
 * The exception itself was always defensible - §32 step 2 genuinely requires migrations, and a
 * migrator needs a ledger. What was not defensible was putting phrases in the source's mouth inside
 * quotation marks to justify the one table outside §29's sixty-four. On a project whose first rule is
 * that the SRS is the sole source of truth, a fabricated quotation is worse than a missing one: it
 * cannot be checked without going and looking, and it reads as authority.
 * Tracking applied migrations in a file instead would let the database and the ledger diverge,
 * which is strictly less safe. The table holds one varchar column
 * and is excluded from the 64-table count by name.
 */

const fs = require('fs');
const path = require('path');
const { Sequelize } = require('sequelize');
const logger = require('../config/logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const META_TABLE = 'sequelize_meta';

/** Migration files in lexical order — the timestamp prefix makes that chronological. */
function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js') && !f.startsWith('.'))
    .sort();
}

function loadMigration(file) {
  const migration = require(path.join(MIGRATIONS_DIR, file));
  if (typeof migration.up !== 'function' || typeof migration.down !== 'function') {
    throw new Error(`Migration ${file} must export both up() and down()`);
  }
  return migration;
}

async function ensureMetaTable(sequelize) {
  const qi = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  const normalised = tables.map((t) => (typeof t === 'string' ? t : t.tableName));
  if (normalised.includes(META_TABLE)) return;

  await qi.createTable(
    META_TABLE,
    {
      name: { type: Sequelize.STRING(255), allowNull: false, primaryKey: true },
      applied_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    },
    { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci', engine: 'InnoDB' }
  );
  logger.info(`Created migration ledger "${META_TABLE}"`);
}

async function appliedMigrations(sequelize) {
  await ensureMetaTable(sequelize);
  const [rows] = await sequelize.query(`SELECT name FROM \`${META_TABLE}\` ORDER BY name ASC`);
  return rows.map((r) => r.name);
}

async function recordApplied(sequelize, name) {
  await sequelize.query(`INSERT INTO \`${META_TABLE}\` (name, applied_at) VALUES (?, NOW())`, {
    replacements: [name],
  });
}

async function recordReverted(sequelize, name) {
  await sequelize.query(`DELETE FROM \`${META_TABLE}\` WHERE name = ?`, { replacements: [name] });
}

/** Which migrations exist but have not run. */
async function pending(sequelize) {
  const applied = new Set(await appliedMigrations(sequelize));
  return migrationFiles().filter((f) => !applied.has(f));
}

/** Applied + pending, for `db:migrate:status`. */
async function status(sequelize) {
  const applied = await appliedMigrations(sequelize);
  const appliedSet = new Set(applied);
  const files = migrationFiles();

  return {
    applied,
    pending: files.filter((f) => !appliedSet.has(f)),
    /* A ledger entry with no file means someone deleted a migration that had already run. */
    orphaned: applied.filter((name) => !files.includes(name)),
  };
}

/**
 * Run all pending migrations.
 * On failure, attempts the migration's own `down()` so a half-applied migration does not
 * block the next attempt — MySQL cannot do this for us.
 */
async function up(sequelize, { to } = {}) {
  const queue = await pending(sequelize);
  if (!queue.length) {
    logger.info('No pending migrations.');
    return [];
  }

  const limit = to ? queue.slice(0, queue.indexOf(to) + 1) : queue;
  if (to && !queue.includes(to)) {
    throw new Error(`Migration ${to} is not pending`);
  }

  const qi = sequelize.getQueryInterface();
  const ran = [];

  for (const file of limit) {
    const migration = loadMigration(file);
    const startedAt = Date.now();
    logger.info(`Migrating up: ${file}`);

    try {
      await migration.up(qi, Sequelize);
    } catch (err) {
      logger.error(`Migration ${file} failed: ${err.message}`);
      logger.warn('MySQL cannot roll back DDL — attempting the migration\'s own down() to clean up.');
      try {
        await migration.down(qi, Sequelize);
        logger.warn(`Cleanup succeeded; database is back to the state before ${file}.`);
      } catch (cleanupErr) {
        logger.error(
          `Cleanup ALSO failed (${cleanupErr.message}). The database is in a partial state — ` +
            'inspect it manually or run `npm run db:reset` if this is a development database.'
        );
      }
      throw err;
    }

    await recordApplied(sequelize, file);
    ran.push(file);
    logger.info(`Migrated up: ${file} (${Date.now() - startedAt}ms)`);
  }

  return ran;
}

/** Revert the most recent `step` migrations (default 1). */
async function down(sequelize, { step = 1, all = false } = {}) {
  const applied = await appliedMigrations(sequelize);
  if (!applied.length) {
    logger.info('Nothing to revert.');
    return [];
  }

  const targets = all ? [...applied].reverse() : [...applied].reverse().slice(0, step);
  const qi = sequelize.getQueryInterface();
  const reverted = [];

  for (const file of targets) {
    if (!migrationFiles().includes(file)) {
      throw new Error(`Cannot revert ${file}: its migration file no longer exists`);
    }
    const migration = loadMigration(file);
    logger.info(`Migrating down: ${file}`);
    await migration.down(qi, Sequelize);
    await recordReverted(sequelize, file);
    reverted.push(file);
    logger.info(`Migrated down: ${file}`);
  }

  return reverted;
}

module.exports = {
  META_TABLE,
  MIGRATIONS_DIR,
  migrationFiles,
  appliedMigrations,
  pending,
  status,
  up,
  down,
};
