'use strict';

/**
 * Shared column builders.
 *
 * Tenancy columns are defined once here so every school-scoped table gets an identical
 * `school_id` / `organization_id` shape (SRS §2.4, §8) — "School-related database tables must
 * contain a school_id column. Where required, an organization_id column must also be present."
 */

const { DataTypes } = require('sequelize');

/** Primary key used by every table. */
const id = () => ({
  type: DataTypes.BIGINT.UNSIGNED,
  primaryKey: true,
  autoIncrement: true,
});

/** Foreign-key column shape matching the primary key. */
const fk = (options = {}) => ({
  type: DataTypes.BIGINT.UNSIGNED,
  allowNull: options.allowNull !== undefined ? options.allowNull : false,
  ...options,
});

/**
 * `organization_id` — present on organization-scoped and school-scoped tables so an
 * organization-wide query never needs to join through `schools`.
 */
const organizationId = (options = {}) =>
  fk({
    allowNull: options.allowNull !== undefined ? options.allowNull : false,
    references: { model: 'organizations', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: options.onDelete || 'CASCADE',
    comment: 'Tenant scope: owning organization (SRS §2.4)',
  });

/** `school_id` — the primary tenant boundary. */
const schoolId = (options = {}) =>
  fk({
    allowNull: options.allowNull !== undefined ? options.allowNull : false,
    references: { model: 'schools', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: options.onDelete || 'CASCADE',
    comment: 'Tenant scope: owning school (SRS §2.4, §8)',
  });

/** Optional link to the academic session a record belongs to. */
const academicSessionId = (options = {}) =>
  fk({
    allowNull: options.allowNull !== undefined ? options.allowNull : true,
    references: { model: 'academic_sessions', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  });

/** Money column. All amounts share one precision so arithmetic is predictable. */
const money = (options = {}) => ({
  type: DataTypes.DECIMAL(14, 2),
  allowNull: options.allowNull !== undefined ? options.allowNull : false,
  defaultValue: options.defaultValue !== undefined ? options.defaultValue : 0,
  ...options,
});

/** ENUM built from a constants object or array. */
const enumOf = (values, options = {}) => ({
  type: DataTypes.ENUM(...(Array.isArray(values) ? values : Object.values(values))),
  allowNull: options.allowNull !== undefined ? options.allowNull : false,
  ...options,
});

/** Free-form JSON payload column (settings blobs, generated content, metadata). */
const json = (options = {}) => ({
  type: DataTypes.JSON,
  allowNull: options.allowNull !== undefined ? options.allowNull : true,
  ...options,
});

/** Parse a JSON column value that may arrive as an object (MySQL) or a string (MariaDB). */
function parseJsonValue(raw) {
  if (typeof raw !== 'string') return raw;
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* Return malformed content untouched rather than throwing, so a bad row stays readable. */
    return raw;
  }
}

/**
 * Make every JSON column on a model return a parsed value.
 *
 * MySQL 5.7+ has a native JSON type and mysql2 returns already-parsed objects for it, so
 * Sequelize's `mysql` dialect does no parsing of its own. MariaDB — which XAMPP ships, and
 * which is wire-compatible enough that SRS §3's "MySQL" runs on it unchanged — implements
 * `JSON` as an alias for `LONGTEXT` plus a `json_valid()` CHECK constraint. The driver
 * therefore hands back a raw string, and without this every one of the 35 JSON columns in
 * the schema would read back as text.
 *
 * Installing a per-attribute getter here, rather than switching Sequelize to the `mariadb`
 * dialect, keeps `dialect: 'mysql'` as SRS §3 specifies and behaves identically on either
 * engine: an object passes straight through, a string is parsed.
 *
 * `getDataValue()` still returns the raw stored value, which is what the audit-log
 * comparison in SRS §26 wants.
 */
function installJsonGetters(model) {
  const jsonAttributes = Object.entries(model.rawAttributes)
    .filter(([, attribute]) => attribute.type instanceof DataTypes.JSON)
    .map(([name]) => name);

  if (!jsonAttributes.length) return 0;

  for (const name of jsonAttributes) {
    /* Respect a getter the model defined for itself. */
    if (model.rawAttributes[name].get) continue;
    model.rawAttributes[name].get = function get() {
      return parseJsonValue(this.getDataValue(name));
    };
  }

  /* Rebuild the prototype accessors from the mutated attribute definitions. */
  model.refreshAttributes();
  return jsonAttributes.length;
}

/** Who created / last updated the row — used by audit and activity logging (SRS §26). */
const actorColumns = () => ({
  created_by: fk({
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  }),
  updated_by: fk({
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  }),
});

/** Default model options: snake_case columns, created_at/updated_at, fixed table name. */
const modelOptions = (tableName, extra = {}) => ({
  tableName,
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  freezeTableName: true,
  ...extra,
});

/** Model options plus a `deleted_at` soft-delete column (archive semantics, SRS §9.2). */
const softDeleteOptions = (tableName, extra = {}) =>
  modelOptions(tableName, {
    paranoid: true,
    deletedAt: 'deleted_at',
    ...extra,
  });

module.exports = {
  DataTypes,
  id,
  fk,
  organizationId,
  schoolId,
  academicSessionId,
  money,
  enumOf,
  json,
  actorColumns,
  modelOptions,
  softDeleteOptions,
  parseJsonValue,
  installJsonGetters,
};
