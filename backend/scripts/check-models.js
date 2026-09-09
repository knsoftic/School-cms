'use strict';

/**
 * Schema integrity check — run with `npm run check:models`.
 *
 * Three things can silently corrupt the schema that SRS §29 fixes at 64 tables:
 *
 *   1. A new `sequelize.define()` that isn't in the SRS list.
 *   2. A `belongsTo(..., { foreignKey: 'typo_id' })` — Sequelize *adds* a missing
 *      foreign key to the source model rather than throwing, so a typo becomes an
 *      extra column in the generated DDL with no error anywhere.
 *   3. A school-related table that forgets `school_id`, breaking SRS §2.4.
 *
 * This script catches all three by loading every model group twice: once bare on a
 * throwaway connection to snapshot the declared columns, then once through
 * src/models/index.js which applies the associations, and diffing the two.
 *
 * It never opens a database connection.
 */

const path = require('path');
const { Sequelize } = require('sequelize');

const MODEL_GROUPS = [
  'core',
  'subscription',
  'billing',
  'academic',
  'people',
  'attendance',
  'finance',
  'exams',
  'other',
];

/** Columns an association is legitimately allowed to introduce. There are none. */
const ALLOWED_ASSOCIATION_COLUMNS = Object.freeze([]);

function snapshotDeclaredColumns() {
  /* A second, unconnected instance so defining models here cannot disturb the real one. */
  const probe = new Sequelize('probe', 'probe', 'probe', {
    dialect: 'mysql',
    logging: false,
    define: { underscored: true, freezeTableName: true },
  });

  const declared = new Map();
  for (const group of MODEL_GROUPS) {
    const factory = require(path.join(__dirname, '..', 'src', 'models', group));
    const built = factory(probe);
    for (const [name, model] of Object.entries(built)) {
      declared.set(name, {
        group,
        table: model.getTableName(),
        columns: new Set(Object.keys(model.rawAttributes)),
      });
    }
  }
  return declared;
}

function main() {
  const declared = snapshotDeclaredColumns();
  const db = require('../src/models');

  const problems = [];
  const notes = [];

  /* ── 1 & 3: the SRS §29 table list and the §2.4 school_id rule ── */
  try {
    const { tableCount } = db.assertSchemaMatchesSrs();
    notes.push(`SRS §29 table list: ${tableCount}/64 tables match, no extras, no duplicates.`);
  } catch (err) {
    problems.push(err.message);
  }

  /* ── 2: columns invented by associations ── */
  let associationCount = 0;
  let checkedModels = 0;

  for (const [name, model] of Object.entries(db.models)) {
    const base = declared.get(name);
    if (!base) {
      problems.push(`${name} is registered in index.js but no model group declares it`);
      continue;
    }
    checkedModels += 1;
    associationCount += Object.keys(model.associations).length;

    const added = Object.keys(model.rawAttributes).filter(
      (col) => !base.columns.has(col) && !ALLOWED_ASSOCIATION_COLUMNS.includes(col)
    );
    if (added.length) {
      problems.push(
        `${name} (${base.table}) gained column(s) [${added.join(', ')}] from an association — ` +
          'the foreignKey almost certainly names a column that does not exist'
      );
    }

    const removed = [...base.columns].filter((col) => !model.rawAttributes[col]);
    if (removed.length) {
      problems.push(`${name} (${base.table}) lost declared column(s) [${removed.join(', ')}]`);
    }
  }

  for (const name of declared.keys()) {
    if (!db.models[name]) {
      problems.push(`${name} is declared in a model group but not registered in index.js`);
    }
  }

  notes.push(`Associations: ${associationCount} across ${checkedModels} models, none introduced a column.`);

  /* ── every association target resolves to a registered model, with real keys ── */
  for (const [name, model] of Object.entries(db.models)) {
    for (const [alias, assoc] of Object.entries(model.associations)) {
      if (!db.models[assoc.target.name]) {
        problems.push(`${name}.${alias} targets unregistered model ${assoc.target.name}`);
      }

      /*
       * Which model owns the key depends on the association type:
       *   BelongsTo      → the source holds the foreign key
       *   HasMany/HasOne → the target holds it
       *   BelongsToMany  → the join table holds both keys
       */
      const checks = [];
      if (assoc.associationType === 'BelongsToMany') {
        const through = assoc.through && assoc.through.model;
        if (!through) {
          problems.push(`${name}.${alias} (BelongsToMany) has no through model`);
        } else {
          checks.push([through, assoc.foreignKey], [through, assoc.otherKey]);
        }
      } else if (assoc.associationType === 'BelongsTo') {
        checks.push([model, assoc.foreignKey]);
      } else {
        checks.push([assoc.target, assoc.foreignKey]);
      }

      for (const [owner, key] of checks) {
        if (key && !owner.rawAttributes[key]) {
          problems.push(
            `${name}.${alias} (${assoc.associationType}) uses key "${key}" ` +
              `which is not a column on ${owner.name}`
          );
        }
      }
    }
  }

  /* ── every fk with a `references` clause points at a real table ── */
  const tables = new Set(Object.values(db.models).map((m) => m.getTableName()));
  for (const [name, model] of Object.entries(db.models)) {
    for (const [col, attr] of Object.entries(model.rawAttributes)) {
      const ref = attr.references;
      if (!ref) continue;
      const refTable = typeof ref === 'string' ? ref : ref.model;
      if (typeof refTable === 'string' && !tables.has(refTable)) {
        problems.push(`${name}.${col} references table "${refTable}" which is not in the schema`);
      }
    }
  }

  /* ── report ── */
  if (problems.length) {
    console.error('\nSchema check FAILED\n');
    problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}`));
    console.error('');
    process.exitCode = 1;
    return;
  }

  console.log('\nSchema check passed\n');
  notes.forEach((n) => console.log(`  · ${n}`));

  const byGroup = {};
  for (const info of declared.values()) {
    byGroup[info.group] = (byGroup[info.group] || 0) + 1;
  }
  console.log('\n  Tables per SRS §29 group:');
  for (const [group, count] of Object.entries(byGroup)) {
    console.log(`    ${group.padEnd(14)} ${count}`);
  }
  console.log('');
}

main();
