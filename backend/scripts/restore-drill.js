'use strict';

/**
 * Restore drill — FR-BKP-001's backup, restored and compared rather than merely inspected.
 *
 * `databaseBackup.js` writes a `mysqldump`, and `verify-jobs.js` asserts the dump *contains* all 64
 * model tables as `CREATE TABLE`. That is evidence a file was written, not that it restores: a dump can
 * hold every `CREATE TABLE` and still fail half-way through its inserts, or restore a schema the
 * application's models no longer match. The only proof is to restore one, which this script does:
 *
 *   1. take a dump now (`--fresh`), or use the newest in `BACKUP_DIR`, or the one named by `--file`;
 *   2. restore it into a scratch database, `<DB_NAME>_restore_drill`, with the `mysql` client that sits
 *      beside `MYSQLDUMP_PATH`;
 *   3. compare the scratch database with the source: the same tables, every column with the same type
 *      and nullability, the same foreign keys, the same migration ledger (`sequelize_meta`) — and, for a
 *      fresh dump of a quiet database, the same row count in every table;
 *   4. drop the scratch database, whatever happened.
 *
 * Row counts are compared only for `--fresh`. Last night's dump of a live database is *supposed* to
 * differ from the database as it is now, so for an older file the counts are printed, not judged.
 *
 * Not part of `npm test`: it needs the MySQL/MariaDB client binaries and creates a database, and a
 * suite run must do neither. Run it by hand, and after any change to the backup task:
 *
 *   npm run db:restore-drill -- --fresh           dump now, restore, compare (row counts judged)
 *   npm run db:restore-drill                      the newest dump in BACKUP_DIR
 *   npm run db:restore-drill -- --file <path>     a named dump
 *
 * The password reaches both client programs through `MYSQL_PWD`, as `databaseBackup.js` passes it —
 * an argv is readable by every process on the machine.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = require('../src/config/env');
const db = require('../src/models');
const backup = require('../src/jobs/tasks/databaseBackup');

const SOURCE = config.db.name;
const SCRATCH = `${SOURCE}_restore_drill`;

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

/**
 * The `mysql` client beside `mysqldump`: `C:/xampp/mysql/bin/mysqldump.exe` → `.../mysql.exe`,
 * `mariadb-dump` → `mariadb`, a bare `mysqldump` on PATH → `mysql` on PATH.
 */
function clientPath() {
  const dumpPath = config.backup.mysqldumpPath;
  const client = path.basename(dumpPath).replace(/-?dump(\.exe)?$/i, '$1');
  const dir = path.dirname(dumpPath);
  return dir === '.' ? client : path.join(dir, client);
}

/** Run the `mysql` client with `args`, feeding it `stdinFile` when given. */
function mysql(args, stdinFile = null) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (config.db.password) env.MYSQL_PWD = config.db.password;
    else delete env.MYSQL_PWD;

    const child = spawn(clientPath(), [
      `--host=${config.db.host}`,
      `--port=${config.db.port}`,
      `--user=${config.db.user}`,
      '--default-character-set=utf8mb4',
      ...args,
    ], { env });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.resume();
    child.on('error', (err) => reject(new Error(`could not run ${clientPath()}: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mysql exited ${code}: ${stderr.trim()}`))));

    if (stdinFile) {
      const input = fs.createReadStream(stdinFile);
      input.on('error', (err) => reject(new Error(`could not read ${stdinFile}: ${err.message}`)));
      input.pipe(child.stdin);
    } else {
      child.stdin.end();
    }
  });
}

const query = (sql, replacements = {}) =>
  db.sequelize.query(sql, { replacements, type: db.sequelize.QueryTypes.SELECT });

/** Every base table of a schema, sorted. */
async function tablesOf(schema) {
  const rows = await query(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = :schema AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    { schema }
  );
  return rows.map((r) => r.t);
}

/** `table.column type null` for every column of a schema — the shape the models are read against. */
async function columnsOf(schema) {
  const rows = await query(
    'SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, IS_NULLABLE AS n FROM information_schema.COLUMNS '
      + 'WHERE TABLE_SCHEMA = :schema ORDER BY TABLE_NAME, ORDINAL_POSITION',
    { schema }
  );
  return rows.map((r) => `${r.t}.${r.c} ${r.type} ${r.n}`);
}

/** Every foreign key of a schema, as `table.column -> table.column`. */
async function foreignKeysOf(schema) {
  const rows = await query(
    'SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rc '
      + 'FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = :schema AND REFERENCED_TABLE_NAME IS NOT NULL '
      + 'ORDER BY TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME',
    { schema }
  );
  return rows.map((r) => `${r.t}.${r.c} -> ${r.rt}.${r.rc}`);
}

/** Exact row counts, table by table — `information_schema.TABLE_ROWS` is an estimate for InnoDB. */
async function rowCounts(schema, tables) {
  const counts = {};
  for (const table of tables) {
    // eslint-disable-next-line no-await-in-loop
    const [row] = await query(`SELECT COUNT(*) AS n FROM \`${schema}\`.\`${table}\``);
    counts[table] = Number(row.n);
  }
  return counts;
}

function newestDump() {
  if (!fs.existsSync(config.backup.dir)) return null;
  const dumps = fs.readdirSync(config.backup.dir)
    .filter((name) => name.startsWith(`${SOURCE}-`) && name.endsWith('.sql'))
    .map((name) => path.join(config.backup.dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dumps[0] || null;
}

async function main() {
  const argv = process.argv.slice(2);
  const fresh = argv.includes('--fresh');
  const fileArg = argv.includes('--file') ? argv[argv.indexOf('--file') + 1] : null;

  console.log(`\n=== Restore drill — ${SOURCE} into ${SCRATCH} ===\n`);

  let file = fileArg;
  if (fresh) {
    const written = await backup.run();
    file = written.file;
    console.log(`dumped ${path.basename(file)} (${written.bytes} bytes)`);
  } else if (!file) {
    file = newestDump();
  }
  if (!file || !fs.existsSync(file)) {
    throw new Error(`no dump to restore — pass --fresh, or --file <path>, or put one in ${config.backup.dir}`);
  }
  console.log(`restoring ${file}\n`);

  try {
    await mysql(['-e', `DROP DATABASE IF EXISTS \`${SCRATCH}\`; CREATE DATABASE \`${SCRATCH}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`]);
    const started = Date.now();
    let restoreError = null;
    try {
      await mysql([SCRATCH], file);
    } catch (err) {
      restoreError = err.message;
    }
    check('the dump restores into an empty database without an error', restoreError, null);
    console.log(`  (restore took ${Math.round((Date.now() - started) / 100) / 10} s)`);

    const [sourceTables, restoredTables] = await Promise.all([tablesOf(SOURCE), tablesOf(SCRATCH)]);
    const modelTables = Object.values(db.sequelize.models).map((model) => model.getTableName()).map(String).sort();
    check('every table of the source is back, and nothing else',
      [sourceTables.filter((t) => !restoredTables.includes(t)), restoredTables.filter((t) => !sourceTables.includes(t))],
      [[], []]);
    check('  including every table a model reads, and the migration ledger',
      [...modelTables, 'sequelize_meta'].filter((t) => !restoredTables.includes(t)), []);
    check('  which is the 64 model tables SRS §29 fixes, plus sequelize_meta', [modelTables.length, restoredTables.length], [64, 65]);

    const [sourceColumns, restoredColumns] = await Promise.all([columnsOf(SOURCE), columnsOf(SCRATCH)]);
    check('every column comes back with its type and nullability — the shape the models are read against',
      [sourceColumns.length > 0, sourceColumns.filter((c) => !restoredColumns.includes(c)).slice(0, 5),
        restoredColumns.filter((c) => !sourceColumns.includes(c)).slice(0, 5)],
      [true, [], []]);

    const [sourceKeys, restoredKeys] = await Promise.all([foreignKeysOf(SOURCE), foreignKeysOf(SCRATCH)]);
    check('every foreign key comes back', [sourceKeys.length > 0, sourceKeys.filter((k) => !restoredKeys.includes(k))], [true, []]);

    const ledger = async (schema) => (await query(`SELECT name FROM \`${schema}\`.sequelize_meta ORDER BY name`)).map((r) => r.name);
    const [sourceLedger, restoredLedger] = await Promise.all([ledger(SOURCE), ledger(SCRATCH)]);
    check('the migration ledger matches, so the application would boot on it at the same schema version',
      [restoredLedger.length > 0, restoredLedger], [true, sourceLedger]);

    const [sourceCounts, restoredCounts] = await Promise.all([rowCounts(SOURCE, sourceTables), rowCounts(SCRATCH, restoredTables)]);
    const differing = sourceTables.filter((t) => sourceCounts[t] !== restoredCounts[t]);
    const totalRows = Object.values(restoredCounts).reduce((sum, n) => sum + n, 0);
    if (fresh) {
      check(`every table holds the rows it held when dumped (${totalRows} rows in all)`,
        differing.map((t) => `${t}: ${sourceCounts[t]} vs ${restoredCounts[t]}`), []);
    } else {
      console.log(`INFO  ${totalRows} rows restored; ${differing.length} table(s) differ from the live source, `
        + 'which is expected for a dump older than now — counts are judged only with --fresh');
    }
  } finally {
    await mysql(['-e', `DROP DATABASE IF EXISTS \`${SCRATCH}\``]).catch((err) => {
      failures += 1;
      console.log(`FAIL  the scratch database could not be dropped: ${err.message}`);
    });
    const [left] = await query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = :s', { s: SCRATCH });
    check('the scratch database is dropped again', Number(left.n), 0);
  }
}

main()
  .catch((err) => {
    failures += 1;
    console.error(`\nrestore drill aborted: ${err.message}`);
  })
  .finally(async () => {
    await db.sequelize.close().catch(() => {});
    console.log('');
    console.log(failures === 0 ? 'Restore drill passed.' : `${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
