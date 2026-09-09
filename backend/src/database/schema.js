'use strict';

/**
 * Schema derivation — turns the registered models into ordered DDL operations.
 *
 * The models in src/models are the single source of truth for the schema. Hand-writing
 * 64 `createTable` calls in the migration would duplicate ~4,000 lines of column
 * definitions and drift from the models the first time a column changed, so the initial
 * migration consumes this module instead. Later schema changes get their own hand-written
 * migrations in the normal way; this only builds the baseline.
 *
 * Two ordering problems make a naive "create each table with its foreign keys" approach
 * fail, and both are solved by emitting tables and constraints as separate passes:
 *
 *   1. `schools.principal_id → users.id` while `users.school_id → schools.id` — a true
 *      cycle, so no creation order exists that satisfies both.
 *   2. `fee_payments.income_id → incomes.id` — a forward reference, which would need a
 *      topological sort that the cycle above makes impossible anyway.
 *
 * So: create every table with no REFERENCES clause, then add every foreign key with
 * `addConstraint`. Order stops mattering entirely.
 */

const db = require('../models');

/** Attributes Sequelize manages that must still be created as real columns. */
const TIMESTAMP_COLUMNS = ['created_at', 'updated_at', 'deleted_at'];

/**
 * Strip the association metadata from a column definition so `createTable` emits a plain
 * column. `onDelete`/`onUpdate` are meaningless without `references` and MySQL rejects
 * them, so they go too.
 */
function plainColumn(attribute) {
  const { references, onDelete, onUpdate, ...rest } = attribute;
  /* `unique: true` inline would create an unnamed index; uniqueness is declared via
   * model `indexes` instead so the constraint names stay predictable. */
  return rest;
}

/** Column definitions for one model, keyed by real column name. */
function columnsFor(model) {
  const columns = {};
  for (const [attrName, attribute] of Object.entries(model.rawAttributes)) {
    const column = attribute.field || attrName;
    columns[column] = plainColumn(attribute);
  }
  return columns;
}

/** Every table in creation order (alphabetical — order is irrelevant without FKs). */
function tables() {
  return Object.values(db.models)
    .map((model) => ({
      name: model.getTableName(),
      modelName: model.name,
      columns: columnsFor(model),
      options: {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
        engine: 'InnoDB',
      },
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A deterministic, MySQL-safe (≤64 char) constraint name.
 * Long table/column pairs are truncated with a short stable digest so two truncated
 * names can never collide.
 */
function constraintName(prefix, table, columns) {
  const raw = `${prefix}_${table}_${columns.join('_')}`;
  if (raw.length <= 64) return raw;

  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) % 0xffffffff;
  }
  const suffix = `_${hash.toString(36)}`;
  return raw.slice(0, 64 - suffix.length) + suffix;
}

/** Every foreign key across every model, emitted as an `addConstraint` spec. */
function foreignKeys() {
  const keys = [];
  const seen = new Set();

  for (const model of Object.values(db.models)) {
    const table = model.getTableName();

    for (const [attrName, attribute] of Object.entries(model.rawAttributes)) {
      if (!attribute.references) continue;

      const column = attribute.field || attrName;
      const ref = attribute.references;
      const refTable = typeof ref === 'string' ? ref : ref.model;
      const refColumn = (typeof ref === 'object' && ref.key) || 'id';

      const name = constraintName('fk', table, [column]);
      if (seen.has(name)) {
        throw new Error(`Duplicate foreign-key constraint name ${name} on ${table}.${column}`);
      }
      seen.add(name);

      keys.push({
        table,
        name,
        fields: [column],
        references: { table: refTable, field: refColumn },
        /*
         * Defaults mirror the intent already encoded on the columns: a tenant column
         * cascades (deleting a school removes its data), an optional pointer nulls out.
         */
        onDelete: attribute.onDelete || (attribute.allowNull === false ? 'CASCADE' : 'SET NULL'),
        onUpdate: attribute.onUpdate || 'CASCADE',
      });
    }
  }

  return keys.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every index declared on a model.
 *
 * A foreign key needs a leading index for MySQL to accept the constraint. Sequelize's
 * `addConstraint` creates one implicitly when none exists, but relying on that produces
 * auto-named indexes, so any FK column not already covered by a declared index gets an
 * explicit one here.
 */
function indexes() {
  const result = [];
  const declared = new Set();

  for (const model of Object.values(db.models)) {
    const table = model.getTableName();

    for (const index of model.options.indexes || []) {
      const fields = index.fields.map((f) => (typeof f === 'string' ? f : f.name || f.attribute));
      const name = index.name || constraintName(index.unique ? 'uq' : 'idx', table, fields);
      result.push({ table, name, fields, unique: Boolean(index.unique) });
      declared.add(`${table}:${fields[0]}`);
    }
  }

  /* Cover any FK column whose table has no index starting with it. */
  for (const key of foreignKeys()) {
    const first = key.fields[0];
    if (declared.has(`${key.table}:${first}`)) continue;
    declared.add(`${key.table}:${first}`);
    result.push({
      table: key.table,
      name: constraintName('idx', key.table, key.fields),
      fields: key.fields,
      unique: false,
    });
  }

  return result;
}

/**
 * Columns that carry a soft-delete flag, so `paranoid` models get `deleted_at`.
 * Sequelize already adds it to rawAttributes; this is only used by the summary output.
 */
function softDeleteTables() {
  return Object.values(db.models)
    .filter((m) => m.options.paranoid)
    .map((m) => m.getTableName())
    .sort();
}

/** One-line description of the derived schema, printed by the CLI. */
function summary() {
  const t = tables();
  const fks = foreignKeys();
  const idx = indexes();
  return {
    tables: t.length,
    columns: t.reduce((sum, x) => sum + Object.keys(x.columns).length, 0),
    foreignKeys: fks.length,
    indexes: idx.length,
    softDeleteTables: softDeleteTables().length,
  };
}

module.exports = {
  TIMESTAMP_COLUMNS,
  tables,
  foreignKeys,
  indexes,
  softDeleteTables,
  constraintName,
  summary,
};
