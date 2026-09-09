'use strict';

/**
 * Database CLI — migrations per **§32 step 2** (*"Create database migration."*), and seeding of
 * the reference data the SRS fixes by name: 11 roles, 109 permissions, 353 grants, 7 add-ons.
 *
 * This line previously cited §28 and quoted "Run migrations" / "Seed initial data". Neither
 * phrase is in the SRS — "migration" occurs once, at §32 step 2, and "seed" occurs **not at
 * all**; §28 is about API documentation. Seeding is not an SRS-named step, it is how the
 * reference data the SRS *does* specify reaches the database — a different and honest claim.
 * See the note on `sequelize_meta` in `migrator.js`.
 *
 *   node src/database/cli.js create           create the database if it does not exist
 *   node src/database/cli.js drop             drop the database (refused in production)
 *   node src/database/cli.js migrate          run all pending migrations
 *   node src/database/cli.js migrate:undo     revert the last migration
 *   node src/database/cli.js migrate:undo:all revert every migration
 *   node src/database/cli.js migrate:status   show applied / pending migrations
 *   node src/database/cli.js seed             run all seeders (idempotent)
 *   node src/database/cli.js seed:undo        remove seeded data
 *   node src/database/cli.js seed:demo        insert illustrative sample data (optional)
 *   node src/database/cli.js seed:demo:undo   remove illustrative sample data
 *   node src/database/cli.js reset            drop + create + migrate + seed
 *   node src/database/cli.js schema           print the schema derived from the models
 */

const { Sequelize } = require('sequelize');
const config = require('../config/env');
const logger = require('../config/logger');
const migrator = require('./migrator');
const schema = require('./schema');

/** A connection with no database selected, for CREATE/DROP DATABASE. */
function serverConnection() {
  return new Sequelize('', config.db.user, config.db.password, {
    host: config.db.host,
    port: config.db.port,
    dialect: 'mysql',
    logging: false,
  });
}

/** The application connection, shared with the models. */
function appConnection() {
  return require('../models').sequelize;
}

function assertNotProduction(command) {
  if (config.isProduction) {
    throw new Error(`Refusing to run "${command}" with NODE_ENV=production.`);
  }
}

async function createDatabase() {
  const server = serverConnection();
  try {
    await server.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.db.name}\` ` +
        'CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
    );
    logger.info(`Database "${config.db.name}" is ready.`);
  } finally {
    await server.close();
  }
}

async function dropDatabase() {
  assertNotProduction('drop');
  const server = serverConnection();
  try {
    await server.query(`DROP DATABASE IF EXISTS \`${config.db.name}\``);
    logger.info(`Database "${config.db.name}" dropped.`);
  } finally {
    await server.close();
  }
}

async function migrate() {
  const sequelize = appConnection();
  await sequelize.authenticate();
  const ran = await migrator.up(sequelize);
  if (ran.length) logger.info(`Applied ${ran.length} migration(s).`);
}

async function migrateUndo({ all = false } = {}) {
  assertNotProduction(all ? 'migrate:undo:all' : 'migrate:undo');
  const sequelize = appConnection();
  await sequelize.authenticate();
  const reverted = await migrator.down(sequelize, { all, step: 1 });
  if (reverted.length) logger.info(`Reverted ${reverted.length} migration(s).`);
}

async function migrateStatus() {
  const sequelize = appConnection();
  await sequelize.authenticate();
  const state = await migrator.status(sequelize);

  console.log('\nMigrations');
  if (!state.applied.length && !state.pending.length) {
    console.log('  (none)');
  }
  state.applied.forEach((name) => console.log(`  [up]      ${name}`));
  state.pending.forEach((name) => console.log(`  [pending] ${name}`));
  state.orphaned.forEach((name) =>
    console.log(`  [ORPHAN]  ${name}  <- recorded as applied but the file is gone`)
  );
  console.log('');
}

async function seed() {
  const sequelize = appConnection();
  await sequelize.authenticate();
  const seeder = require('./seed');
  await seeder.run(sequelize);
}

async function seedUndo() {
  assertNotProduction('seed:undo');
  const sequelize = appConnection();
  await sequelize.authenticate();
  const seeder = require('./seed');
  await seeder.revert(sequelize);
}

/**
 * Illustrative sample data. Separate from `seed` on purpose: the SRS names no specific plans,
 * grade bands, taxes, classes or students, so none of that may enter the mandatory seed.
 */
async function seedDemo() {
  assertNotProduction('seed:demo');
  const sequelize = appConnection();
  await sequelize.authenticate();
  const seeder = require('./seed');
  await seeder.runDemo(sequelize);
}

async function seedDemoUndo() {
  assertNotProduction('seed:demo:undo');
  const sequelize = appConnection();
  await sequelize.authenticate();
  const seeder = require('./seed');
  await seeder.revertDemo(sequelize);
}

async function reset() {
  assertNotProduction('reset');
  await dropDatabase();
  await createDatabase();
  await migrate();
  await seed();
  logger.info('Database reset complete.');
}

function printSchema() {
  const s = schema.summary();
  console.log('\nSchema derived from src/models\n');
  console.log(`  tables ............ ${s.tables}`);
  console.log(`  columns ........... ${s.columns}`);
  console.log(`  indexes ........... ${s.indexes}`);
  console.log(`  foreign keys ...... ${s.foreignKeys}`);
  console.log(`  soft-delete tables  ${s.softDeleteTables}`);

  const db = require('../models');
  console.log('\n  SRS §29 groups:');
  for (const [group, tables] of Object.entries(db.EXPECTED_TABLES)) {
    console.log(`    ${group.padEnd(14)} ${String(tables.length).padStart(2)}  ${tables.join(', ')}`);
  }
  console.log('');
}

const COMMANDS = {
  create: createDatabase,
  drop: dropDatabase,
  migrate,
  'migrate:undo': () => migrateUndo({ all: false }),
  'migrate:undo:all': () => migrateUndo({ all: true }),
  'migrate:status': migrateStatus,
  seed,
  'seed:undo': seedUndo,
  'seed:demo': seedDemo,
  'seed:demo:undo': seedDemoUndo,
  reset,
  schema: printSchema,
};

async function main() {
  const command = process.argv[2];
  const handler = COMMANDS[command];

  if (!handler) {
    console.error(`\nUnknown command "${command || ''}".\n\nAvailable:\n  ${Object.keys(COMMANDS).join('\n  ')}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    await handler();
  } catch (err) {
    logger.error(err.message);
    if (err.original) logger.error(`  driver: ${err.original.message}`);
    if (process.env.DEBUG) logger.error(err.stack);
    process.exitCode = 1;
  } finally {
    /* Close the app connection if it was opened. */
    const models = require.cache[require.resolve('../models')];
    if (models) await models.exports.sequelize.close().catch(() => {});
  }
}

main();
