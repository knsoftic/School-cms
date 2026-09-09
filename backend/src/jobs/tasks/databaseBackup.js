'use strict';

/**
 * Database backup and retention — SRS §26, FR-BKP-001.
 *
 *   node src/jobs/tasks/databaseBackup.js      (also `npm run db:backup`)
 *
 * §26 asks for two things and no more: *"System performs Database Backup"* and *"System retains
 * backups per the Backup Retention policy"*, with the outcome that the database can be restored
 * within the retention window. It names no format, no destination and no schedule, and §25 declines
 * to invent numeric targets — so the window comes from `BACKUP_RETENTION_DAYS` (30 by default) and
 * the destination from `BACKUP_DIR`, both of which `config/env.js` has declared since it was written
 * and nothing has used until now.
 *
 * ## Why `mysqldump` rather than something written here
 *
 * A restorable backup of a 64-table schema with foreign keys is `mysqldump`'s job. Writing one from
 * Sequelize would mean reimplementing dependency ordering, escaping and DDL, and getting any of it
 * wrong produces a file that looks like a backup and is not — which is worse than no backup at all.
 * `MYSQLDUMP_PATH` is configurable because it is not on PATH under XAMPP.
 *
 * ## What this refuses to do
 *
 * It does not delete a backup it did not just verify the age of, it never prunes the file it has
 * only part-written, and it fails loudly. A backup task that swallows its errors is the one failure
 * mode that matters here: nobody looks at a backup until they need it.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('../../config/env');
const logger = require('../../config/logger');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `msms-2026-09-04T06-12-33.sql` — sortable, and legal on Windows (no colons). */
function filenameFor(at) {
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
  return `${config.db.name}-${stamp}.sql`;
}

/**
 * Run `mysqldump` into `target`.
 *
 * The password is passed through the environment (`MYSQL_PWD`) rather than on the command line,
 * because an argv is readable by any other process on the machine. Empty passwords — XAMPP's
 * default — are omitted entirely rather than passed as `""`.
 */
function dump(target) {
  return new Promise((resolve, reject) => {
    const args = [
      `--host=${config.db.host}`,
      `--port=${config.db.port}`,
      `--user=${config.db.user}`,
      '--single-transaction',
      '--routines',
      '--triggers',
      '--default-character-set=utf8mb4',
      config.db.name,
    ];

    const env = { ...process.env };
    if (config.db.password) env.MYSQL_PWD = config.db.password;
    else delete env.MYSQL_PWD;

    const out = fs.createWriteStream(target);
    const child = spawn(config.backup.mysqldumpPath, args, { env });
    let stderr = '';

    /*
     * Both completions are tracked independently and the promise settles when BOTH have happened.
     *
     * The obvious shape — waiting for `out`'s `close` from inside the child's `close` — does not
     * work, and fails in the worst possible way. `child.stdout.pipe(out)` ends the write stream by
     * itself when the child's stdout ends, so `close` has usually already fired by the time the
     * child's own `close` arrives; a listener attached then never runs, the promise never settles,
     * and Node exits **0** with an empty event loop. Measured before this was fixed: a complete
     * 222 KB dump on disk, no error, no report, and a task that had silently not finished.
     *
     * A backup that reports success without completing is the one failure this file cannot have.
     */
    let exitCode = null;
    let streamClosed = false;
    let settled = false;

    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };

    const finishIfBothDone = () => {
      if (exitCode === null || !streamClosed) return;
      if (exitCode === 0) settle(null, stderr.trim());
      else settle(new Error(`mysqldump exited ${exitCode}: ${stderr.trim() || 'no output'}`));
    };

    out.on('close', () => { streamClosed = true; finishIfBothDone(); });
    out.on('error', (err) => settle(new Error(`could not write ${target}: ${err.message}`)));

    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      out.destroy();
      settle(new Error(
        `could not run mysqldump at "${config.backup.mysqldumpPath}": ${err.message}. `
        + 'Set MYSQLDUMP_PATH to its full path.'
      ));
    });

    child.on('close', (code) => { exitCode = code; finishIfBothDone(); });

    child.stdout.pipe(out);
  });
}

/**
 * Delete backups older than the retention window.
 *
 * Only files this task's own naming produces are considered, so nothing else that happens to live in
 * the directory is ever removed. Age is read from the filesystem's mtime rather than parsed out of
 * the name, because a renamed file should still be judged by when it was written.
 */
function prune(at) {
  const cutoff = at.getTime() - config.backup.retentionDays * MS_PER_DAY;
  const removed = [];

  for (const name of fs.readdirSync(config.backup.dir)) {
    if (!name.startsWith(`${config.db.name}-`) || !name.endsWith('.sql')) continue;
    const full = path.join(config.backup.dir, name);
    if (fs.statSync(full).mtimeMs >= cutoff) continue;
    fs.unlinkSync(full);
    removed.push(name);
  }
  return removed;
}

/**
 * @param {object} [options]
 * @param {Date} [options.at]  the moment to evaluate retention against; injectable so a suite can
 *                             test the window without waiting a month
 * @returns {Promise<{file:string,bytes:number,pruned:string[],retentionDays:number}>}
 */
async function run(options = {}) {
  const at = options.at || new Date();

  fs.mkdirSync(config.backup.dir, { recursive: true });
  const target = path.join(config.backup.dir, filenameFor(at));

  try {
    await dump(target);
  } catch (err) {
    /* A part-written file is not a backup, and leaving it would let retention "keep" a broken one. */
    if (fs.existsSync(target)) fs.unlinkSync(target);
    throw err;
  }

  const { size } = fs.statSync(target);
  /*
   * Defensive, and measured to be so rather than assumed. `mysqldump` writes a comment header before
   * anything else, so a run that exits 0 is never zero bytes — not even for a database with no
   * tables. A deliberate regression removing this check therefore changed nothing any fixture could
   * see, which is the §22 `pass_rate` situation: a guard that is real but unobservable.
   *
   * It stays because the case it covers is not a mysqldump failure but a filesystem one — a full
   * disk, a quota, a write that reported success and stored nothing — and shipping a zero-byte file
   * as a backup is the single worst outcome this task has. Said here rather than left to read as
   * coverage the suite does not have.
   */
  if (size === 0) {
    fs.unlinkSync(target);
    throw new Error('mysqldump produced an empty file');
  }

  const pruned = prune(at);
  logger.info('Database backup written', {
    file: path.basename(target), bytes: size, pruned: pruned.length,
  });

  return {
    file: target,
    bytes: size,
    pruned,
    retentionDays: config.backup.retentionDays,
  };
}

module.exports = {
  name: 'database-backup',
  schedule: '0 3 * * *',
  description: 'mysqldump plus retention pruning (SRS §26, FR-BKP-001)',
  run,
  filenameFor,
  prune,
};

/* `npm run db:backup` — run directly, as `package.json` has declared since it was written. */
if (require.main === module) {
  run()
    .then((result) => {
      console.log(`backup: ${result.file} (${result.bytes} bytes)`);
      if (result.pruned.length) console.log(`pruned ${result.pruned.length} beyond ${result.retentionDays} days`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`backup failed: ${err.message}`);
      process.exit(1);
    });
}
