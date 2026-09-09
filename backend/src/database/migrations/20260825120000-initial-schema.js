'use strict';

/**
 * Initial schema — the 64 tables of SRS §29.
 *
 * Three passes, in this order, because two foreign keys make any single-pass ordering
 * impossible (see src/database/schema.js for the detail):
 *
 *   1. Create all 64 tables with no REFERENCES clauses.
 *   2. Add every declared index.
 *   3. Add all 254 foreign keys.
 *
 * Column definitions come from src/models rather than being repeated here, so the models
 * and the baseline schema cannot drift. Subsequent schema changes get ordinary
 * hand-written migrations.
 */

const schema = require('../schema');
const logger = require('../../config/logger');

module.exports = {
  async up(queryInterface) {
    const tables = schema.tables();
    const indexes = schema.indexes();
    const foreignKeys = schema.foreignKeys();

    /* ── Pass 1: tables ── */
    logger.info(`Creating ${tables.length} tables…`);
    for (const table of tables) {
      await queryInterface.createTable(table.name, table.columns, table.options);
    }

    /* ── Pass 2: indexes ── */
    logger.info(`Creating ${indexes.length} indexes…`);
    for (const index of indexes) {
      await queryInterface.addIndex(index.table, {
        name: index.name,
        fields: index.fields,
        unique: index.unique,
      });
    }

    /* ── Pass 3: foreign keys ── */
    logger.info(`Adding ${foreignKeys.length} foreign keys…`);
    for (const key of foreignKeys) {
      await queryInterface.addConstraint(key.table, {
        type: 'foreign key',
        name: key.name,
        fields: key.fields,
        references: key.references,
        onDelete: key.onDelete,
        onUpdate: key.onUpdate,
      });
    }

    logger.info(
      `Initial schema created: ${tables.length} tables, ${indexes.length} indexes, ` +
        `${foreignKeys.length} foreign keys.`
    );
  },

  async down(queryInterface) {
    /*
     * Drop foreign keys before tables so the drop order cannot matter, and tolerate
     * missing objects: `down()` doubles as the cleanup path when `up()` fails partway,
     * where only some of them exist.
     */
    const foreignKeys = schema.foreignKeys();
    const tables = schema.tables();

    for (const key of foreignKeys) {
      try {
        await queryInterface.removeConstraint(key.table, key.name);
      } catch {
        /* Constraint or table absent — nothing to undo. */
      }
    }

    /* Belt and braces: MySQL refuses to drop a referenced table, and a constraint we
     * failed to name correctly would block every drop below. */
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
      for (const table of tables) {
        await queryInterface.dropTable(table.name).catch(() => {});
      }
    } finally {
      await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
    }
  },
};
