'use strict';

/**
 * Serving a stored file — the one thing this application has never been able to do.
 *
 * There is no `res.download`, no `res.sendFile`, no `express.static` and no streamed response
 * anywhere else in it; four modules carry comments saying exactly that. This file is that capability,
 * and it is deliberately narrow: given a path **taken from a row the caller was already allowed to
 * read**, it streams the bytes back.
 *
 * ## The SRS never says "download", and that matters
 *
 * Not once — against ten mentions of "upload". Every file clause in the SRS is a *store* verb with
 * no matching *read* verb. So this is not a requirement anyone wrote down, and the honest split is:
 *
 * - **One clause mandates it.** FR-BILL-004: *"Super Admin reviews the submitted transaction ID
 *   **and screenshot**."* Reading the stored file is the literal precondition of a decision the SRS
 *   demands. That is the case that survives a §35 challenge outright.
 * - **Two more are engineering necessity, not SRS authority**, and are labelled as such rather than
 *   dressed up. FR-HW-001's outcome is that *"Homework is available to the relevant class/students"*
 *   and FR-ASG-001's is that a teacher *"reviews the submission"* — neither says the file is opened.
 *   Storing a file no one can retrieve is indefensible engineering, but it is not the SRS speaking,
 *   and the difference is worth keeping straight.
 *
 * That is the whole justification, and it is why only three routes use this. The other fifteen
 * `*_path` columns get nothing until a requirement asks — two of them (`school_settings.logo_path`
 * and `favicon_path`) hold absolute http(s) URLs and **must never be resolved against the
 * filesystem** at all.
 *
 * ## Authorization is not this file's job, and that is the design
 *
 * It never takes a path from a request. A caller names a **record**; the owning module loads it
 * through its own finder — which already applies `requirePermission`, the router's tenant guard, and
 * the module's self-scoping (a student sees their own class's published homework, their own
 * submission) — and only then is the stored path handed here. Every authorization rule that already
 * governs the record therefore governs its file, with nothing new to keep in step.
 *
 * That is also why there is no generic `/files/:id`. Such a route would need an authorization rule of
 * its own, and the 109-permission catalogue §29 fixes contains no file permission to build one from.
 *
 * ## What it refuses, and why it refuses things that "cannot happen"
 *
 * Stored paths are written by `middlewares/upload.js`, which generates random hex filenames under
 * `school-<id>/<profile>/` and lets nothing of the caller's choosing reach the filesystem. So none of
 * the refusals below should ever trigger.
 *
 * They are here because Known Issues #26 was exactly this assumption failing: six columns accepted a
 * caller-supplied path because nothing revalidated what was stored. A path read back out of a row is
 * **input**, whatever wrote it, and the day a migration, a fixture or a future writer puts something
 * else in that column, this is what stands between it and the filesystem.
 */

const fs = require('fs');
const path = require('path');

const config = require('../config/env');
const ApiError = require('./ApiError');
const { UPLOAD_MIME_EXTENSIONS } = require('../config/constants');

/**
 * Extension → MIME, reversed from the upload allowlist.
 *
 * Built from the same constant the uploader validates against, so the two cannot disagree about what
 * this application stores. An extension that is not in it is refused rather than guessed at or served
 * as `application/octet-stream`: this application accepts four types, so a stored file with a fifth
 * extension is a defect, not a download.
 */
const MIME_BY_EXTENSION = Object.freeze(
  Object.entries(UPLOAD_MIME_EXTENSIONS).reduce((map, [mime, extensions]) => {
    for (const extension of extensions) map[extension] = mime;
    return map;
  }, {})
);

/** The uploads root, resolved once so every comparison below is against the same real path. */
const ROOT = path.resolve(config.uploads.dir);

/**
 * Turn a stored relative path into an absolute one inside the uploads root, or refuse.
 *
 * `path.resolve` collapses `..` before the comparison, which is what makes the containment check
 * meaningful: `school-1/../../etc/passwd` resolves outside the root and is caught.
 *
 * Percent-encoded traversal is **not** a threat here and this function makes no claim to handle it.
 * The value comes out of a database column, not a URL — nothing has percent-decoded it and nothing
 * will. Saying otherwise would describe a threat model this design excludes by construction, which is
 * the kind of unearned claim the log exists to catch.
 *
 * @param {string} stored  the value of a `*_path` column
 * @returns {string} an absolute path known to be inside the uploads root
 * @throws {ApiError} 404 — never 403, and never the offending path
 */
function resolveStored(stored) {
  /*
   * Refused as 404 rather than 400 or 403, and with nothing quoted back.
   *
   * A caller cannot supply this path, so a failure here is a defect on our side, not theirs — and
   * telling them "that path escapes the uploads root" would confirm the root exists and describe the
   * layout. "Not found" is the whole truth from where they stand: there is no file they may have.
   */
  const refuse = () => { throw ApiError.notFound('File not found'); };

  if (typeof stored !== 'string' || stored.length === 0) refuse();
  /* A null byte truncates the path at the OS layer, so `a.pdf\0.png` opens `a.pdf`. */
  if (stored.includes('\0')) refuse();
  /* An absolute path or a Windows drive letter would ignore the root entirely. */
  if (path.isAbsolute(stored) || /^[a-zA-Z]:/.test(stored)) refuse();

  const absolute = path.resolve(ROOT, stored);
  /*
   * `ROOT + sep` rather than `startsWith(ROOT)`: a sibling directory named `uploads-evil` starts with
   * the same string as `uploads` and would otherwise pass.
   */
  if (absolute !== ROOT && !absolute.startsWith(ROOT + path.sep)) refuse();

  return absolute;
}

/**
 * Stream a stored file to the response.
 *
 * @param {import('express').Response} res
 * @param {string} stored              the `*_path` column's value, from a row the caller may read
 * @param {object} [options]
 * @param {string} [options.filename]  what the browser should call it — the ORIGINAL name, since the
 *                                     stored one is random hex and means nothing to a person
 * @param {boolean} [options.inline]   `inline` rather than `attachment`, for a screenshot a reviewer
 *                                     wants to look at rather than save
 * @param {number} [options.schoolId]  the owning row's school, checked against the path's own
 *                                     `school-<id>` segment — defence in depth, not the primary rule
 * @returns {Promise<void>}
 */
async function sendStoredFile(res, stored, options = {}) {
  const absolute = resolveStored(stored);

  /*
   * Defence in depth on tenancy. `upload.js` files everything under `school-<id>/` or `platform/`,
   * and the row was loaded through a tenant-scoped finder — so the two should already agree. This
   * catches the case where they do not: a row whose `*_path` names another school's directory, which
   * no writer produces but which a migration or a hand-edited fixture could.
   */
  if (options.schoolId) {
    const [segment] = stored.split('/');
    if (segment !== `school-${options.schoolId}`) throw ApiError.notFound('File not found');
  }

  const extension = path.extname(absolute).toLowerCase();
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) throw ApiError.notFound('File not found');

  /*
   * Resolved through symlinks, then re-checked against the root.
   *
   * `resolveStored` is purely lexical — it collapses `..` in the string — and `stat` and
   * `createReadStream` both **follow symlinks**. So a link inside the uploads root pointing at
   * anything this process can read would pass every check above and be served. Nothing writes such a
   * link today, which is exactly why it is worth refusing: the containment guarantee should hold
   * against the filesystem as it is, not against the filesystem as the uploader leaves it.
   *
   * `realpath` throws ENOENT for a missing file, which the same catch turns into the 404 a row
   * pointing at a deleted file deserves.
   *
   * **Not covered by an assertion**, and said so rather than implied: creating a symlink on the
   * Windows machine this is developed on needs privileges the process does not have (`EPERM`), so no
   * fixture here can build the attack. The containment re-check is the same expression proved against
   * eight lexical attacks a few lines up; what is unproved is only that `realpath` resolves a link,
   * which is its documented behaviour.
   */
  let real;
  let stat;
  try {
    real = await fs.promises.realpath(absolute);
    if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new Error('escapes root');
    stat = await fs.promises.stat(real);
  } catch (_) {
    /* A row pointing at a file that is gone, or at a link out of the root. Both are "not found". */
    throw ApiError.notFound('File not found');
  }
  /*
   * A directory would otherwise stream as an error mid-response, after the headers have gone — and a
   * partial 200 is worse than a clean 404.
   */
  if (!stat.isFile()) throw ApiError.notFound('File not found');

  /* The download name is sanitised: it reaches a header, and a quote or newline there is injection. */
  const safeName = String(options.filename || path.basename(absolute))
    .replace(/[\r\n"\\]/g, '')
    .slice(0, 120) || 'download';

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', stat.size);
  res.setHeader(
    'Content-Disposition',
    `${options.inline ? 'inline' : 'attachment'}; filename="${safeName}"`
  );
  /*
   * Stored files are private to a school. Without this a shared proxy could hold one and hand it to
   * the next caller, whose own permission check would never run.
   */
  res.setHeader('Cache-Control', 'private, no-store');
  /* The bytes are user-supplied; nothing should sniff them into something executable. */
  res.setHeader('X-Content-Type-Options', 'nosniff');

  await new Promise((resolve, reject) => {
    /* The REAL path, so the bytes streamed are the ones the containment check was made against. */
    const stream = fs.createReadStream(real);
    /*
     * Both ends are wired before the pipe starts. A listener attached afterwards can miss an event
     * that has already fired — the bug `databaseBackup.js` shipped with, whose symptom was a promise
     * that never settled and a process exiting 0 having done nothing.
     */
    stream.on('error', reject);
    res.on('finish', resolve);
    res.on('close', resolve);
    stream.pipe(res);
  });
}

module.exports = { sendStoredFile, resolveStored, MIME_BY_EXTENSION, ROOT };
