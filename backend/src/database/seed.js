'use strict';

/**
 * Seed runner — the reference data the SRS fixes by name: 11 roles, 109 permissions, 353 grants
 * and the 7 add-ons of §11.3.
 *
 * This line previously read `SRS §28 "Seed initial data"`. That phrase is not in the SRS, and
 * neither is the word "seed" — zero occurrences in 1,698 lines; §28 is about API documentation.
 * Seeding is not a step the source names. It is how the reference data the source *does*
 * specify gets into the database, which is what this file should have claimed all along.
 *
 * Only data the SRS itself fixes is seeded here: the eleven roles of §5, the permission
 * catalogue behind §4/§7, their default grants, the bootstrap Super Admin that §6's hierarchy
 * starts from, and the seven add-ons of §11.3. Everything else a running school has —
 * plans, prices, taxes, grade scales, classes, students — is created through the application
 * by a Super Admin or a school, and the source document names no specific instances of any of
 * it. SRS §34 requires that nothing be "replaced with an invented requirement", so illustrative
 * sample data lives in `seeders/demo/` behind an explicit `db:seed:demo` command instead of
 * being smuggled into the mandatory seed.
 *
 * Every seeder is idempotent: running `db:seed` against an already-seeded database repairs
 * drift in system-defined fields and reports what it found, without touching data an
 * administrator has since edited.
 *
 * Seeders receive `(db, transaction)` and pass the transaction explicitly on every query.
 * Unlike migrations — where MySQL's non-transactional DDL forces a best-effort cleanup path —
 * seeding is pure DML, so a failure half way through rolls back properly and leaves the
 * database exactly as it was.
 */

const path = require('path');
const fs = require('fs');
const logger = require('../config/logger');

const SEEDERS_DIR = path.join(__dirname, 'seeders');
const DEMO_DIR = path.join(SEEDERS_DIR, 'demo');

/** Load and validate the seeders in a directory. Numeric filename prefixes are the order. */
function loadSeeders(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((file) => /^\d+-.+\.js$/.test(file))
    .sort()
    .map((file) => {
      const seeder = require(path.join(dir, file));
      if (typeof seeder.up !== 'function' || typeof seeder.down !== 'function') {
        throw new Error(`Seeder ${file} must export up(db, transaction) and down(db, transaction).`);
      }
      return { file, ...seeder, name: seeder.name || file.replace(/\.js$/, '') };
    });
}

/** Core seeders, in dependency order: permissions need roles, grants need both, the user needs its role. */
const coreSeeders = () => loadSeeders(SEEDERS_DIR);

/** Optional illustrative data — never run by `db:seed`. */
const demoSeeders = () => loadSeeders(DEMO_DIR);

/** Format a seeder's result object for its log line. */
function summarise(result) {
  if (!result || typeof result !== 'object') return '';
  const parts = Object.entries(result)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => `${key}=${value}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** Apply `seeders` in one transaction, calling `direction` on each. */
async function apply(sequelize, seeders, direction, label) {
  const db = require('../models');
  logger.info(`${label} (${seeders.length} seeder(s)).`);

  const transaction = await sequelize.transaction();
  try {
    for (const seeder of seeders) {
      const result = await seeder[direction](db, transaction);
      logger.info(`  ${seeder.name}${summarise(result)}`);
    }
    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    logger.error(`${label} failed and was rolled back: ${err.message}`);
    throw err;
  }
}

async function run(sequelize) {
  await apply(sequelize, coreSeeders(), 'up', 'Seeding core data');
  logger.info('Core seed complete.');
}

/**
 * Undo the core seeders in reverse order.
 *
 * `roles` is RESTRICT-referenced by `users`, so this only succeeds on a database whose users
 * have already been removed — which is the point: reverting the seed must not be able to
 * orphan real accounts.
 */
async function revert(sequelize) {
  await apply(sequelize, coreSeeders().reverse(), 'down', 'Reverting core seed');
  logger.info('Core seed reverted.');
}

async function runDemo(sequelize) {
  const seeders = demoSeeders();
  if (!seeders.length) {
    logger.warn(`No demo seeders found in ${DEMO_DIR}.`);
    return;
  }
  await apply(sequelize, seeders, 'up', 'Seeding demo data');
  logger.info('Demo seed complete.');
}

async function revertDemo(sequelize) {
  const seeders = demoSeeders().reverse();
  if (!seeders.length) {
    logger.warn(`No demo seeders found in ${DEMO_DIR}.`);
    return;
  }
  await apply(sequelize, seeders, 'down', 'Reverting demo seed');
  logger.info('Demo seed reverted.');
}

module.exports = {
  run,
  revert,
  runDemo,
  revertDemo,
  coreSeeders,
  demoSeeders,
  SEEDERS_DIR,
  DEMO_DIR,
};
