'use strict';

/**
 * Sequelize connection (SRS §3 — MySQL + Sequelize ORM).
 *
 * A single shared instance; models attach to it in src/models/index.js.
 */

const { Sequelize } = require('sequelize');
const config = require('./env');
const logger = require('./logger');

/**
 * The session SQL mode, set explicitly on every connection.
 *
 * XAMPP's MariaDB ships without `STRICT_TRANS_TABLES`, and without it the server *coerces* bad values
 * instead of refusing them: an invalid ENUM is stored as `''`, an over-long string is truncated, an
 * out-of-range number is clamped — each with a warning nobody reads and no error the application can
 * catch. Sequelize does not close the gap either; it validates `allowNull` and any explicit `validate`
 * rule, but not that a value is one of an ENUM's members.
 *
 * The schema leans on ENUMs for exactly the columns that must not be wrong — `subscriptions.state`
 * decides whether a school has access at all (SRS §12), `users.status` whether someone can sign in,
 * `activity_logs.action` what an audit trail says happened. A silent `''` in the first of those would
 * match none of the usable states and lock a paying school out, with nothing anywhere to explain it.
 *
 * So the mode is pinned rather than inherited, and pinned to MySQL 8's own default set minus
 * `ONLY_FULL_GROUP_BY` — that one changes which *queries* are legal rather than which data is, and is
 * not this setting's business.
 */
const SESSION_SQL_MODE = [
  'STRICT_TRANS_TABLES',
  'NO_ZERO_IN_DATE',
  'NO_ZERO_DATE',
  'ERROR_FOR_DIVISION_BY_ZERO',
  'NO_ENGINE_SUBSTITUTION',
].join(',');

const sequelize = new Sequelize(config.db.name, config.db.user, config.db.password, {
  host: config.db.host,
  port: config.db.port,
  dialect: 'mysql',
  timezone: config.db.timezone,
  logging: config.db.logging ? (msg) => logger.debug(msg) : false,
  pool: {
    max: config.db.poolMax,
    min: config.db.poolMin,
    acquire: 30000,
    idle: 10000,
  },
  define: {
    underscored: true,
    freezeTableName: true,
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci',
  },
  dialectOptions: {
    // Return DECIMAL as string-free numbers where safe; money is handled via the money util.
    decimalNumbers: true,
    connectTimeout: 20000,
  },
  hooks: {
    /*
     * Every connection, not just the first: the pool opens more on demand, and a mode set once on
     * connection #1 would leave the rest of the pool permissive. mysql2's connection here is the
     * callback-style one, so the query is wrapped rather than awaited directly.
     */
    afterConnect: (connection) =>
      new Promise((resolve, reject) => {
        connection.query(`SET SESSION sql_mode = '${SESSION_SQL_MODE}'`, (err) =>
          err ? reject(err) : resolve()
        );
      }),
  },
  retry: { max: 2 },
});

/** Verify connectivity; used at boot and by the health endpoint. */
async function assertConnection() {
  await sequelize.authenticate();
}

module.exports = { sequelize, Sequelize, assertConnection, SESSION_SQL_MODE };
