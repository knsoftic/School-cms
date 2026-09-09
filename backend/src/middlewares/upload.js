'use strict';

/**
 * File upload middleware — SRS §24 "File Upload security" (FR-SEC-004) and §11.2 `file_upload_limit`.
 *
 * ## What the SRS actually specifies
 *
 * Exactly one clause enumerates file types: §21 / FR-AI-001, "upload PDF / Image / Syllabus". Every
 * other upload surface names a shape without a format — §13.3's payment "screenshot", §15.1's student
 * "Photo" and "Documents", §20.2's homework "Upload File", §20.3's assignment "Submit" — and
 * FR-SEC-004 marks the specifics "Not Specified in Source Requirements" while still *requiring* that
 * file upload security exist. So the allowlist lives in `constants.UPLOAD_RULES`, is the narrowest set
 * that satisfies every named surface, and is per surface rather than global: a payment screenshot has
 * no reason to accept a PDF just because the AI module does. Each rule carries the clause it came from.
 *
 * ## The size ceiling is a plan limit, not a constant
 *
 * SRS §11.2 makes `file_upload_limit` one of the eight per-plan limits, in megabytes, and §30 Rule 1
 * forbids deciding it in code. The effective ceiling is therefore resolved per request from the
 * school's entitlement, and `env.uploads.maxMb` is only a server-side backstop for the case where a
 * plan grants Unlimited — a plan row must never be able to authorise an arbitrarily large body.
 *
 * Which of the two is binding changes the refusal, because it changes the remedy:
 *
 *   403 PLAN_LIMIT_EXCEEDED    the plan is binding — FR-SUB-008's "blocks or restricts", and §11.3
 *                              makes the answer an add-on or an upgrade, so the numbers are named
 *   413 FILE_TOO_LARGE         the server backstop is binding — nothing the school can buy will help
 *   415 UNSUPPORTED_MEDIA_TYPE the type is not on this surface's allowlist
 *
 * ## Order of operations
 *
 * The entitlement lookup happens *before* multer, because multer needs `limits.fileSize` up front and
 * a ceiling applied after the stream has been consumed is not a ceiling. The plan check then runs
 * again afterwards against the real byte count, through `usageService`, so the authoritative decision
 * is always the database-driven one and the handler receives the same `req.limitChecks` object that
 * `enforceLimit` leaves behind.
 *
 * Between the two, `sanitizeParsedBody` runs. A multipart request's text fields do not exist when the
 * app-level `sanitizeRequest` runs — multer parses them per route, much later — so without this step
 * the one body shape that skips sanitising entirely would be the one that also writes a file to disk.
 *
 * ## Known limitation
 *
 * `file.mimetype` is declared by the client. The cross-check against the extension the declared type
 * actually carries (`image/png` must arrive as `.png`) defeats the common `payload.php` renamed to
 * `.png` case, and stored names are random so nothing on disk is addressable by a caller-chosen path.
 * Content sniffing (magic bytes) is *not* done — it would need a dependency the project does not have,
 * and the SRS does not ask for it. Recorded as a limitation rather than implied to be covered.
 *
 * ## Ordering on the route
 *
 * After `requireModule` — a school without the Library module should be told the module is not
 * subscribed rather than have its file accepted and then discarded. Before validation, because the
 * validator needs `req.file`/`req.files` and the parsed text fields to exist.
 */

const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');
const multer = require('multer');

const { MulterError } = multer;

const ApiError = require('../utils/ApiError');
const asyncHandler = require('./asyncHandler');
const config = require('../config/env');
const logger = require('../config/logger');
const usageService = require('../services/usageService');
const { loadSnapshot, assertTenantResolved, assertSubscriptionUsable } = require('./entitlement');
const { sanitizeParsedBody } = require('./sanitize');
const {
  LIMITS,
  LIMIT_TYPES,
  UPLOAD_MIME_EXTENSIONS,
  UPLOAD_RULES,
  UPLOAD_PROFILE_LIST,
} = require('../config/constants');

const MEGABYTE = 1024 * 1024;
const LIMIT_KEY = LIMITS.FILE_UPLOAD_LIMIT;

/** Where the ceiling came from. Determines which refusal the caller gets. */
const CEILING_SOURCES = Object.freeze({ PLAN: 'plan', SERVER: 'server' });

/**
 * The rule for an upload surface, checked at boot.
 *
 * @param {string} profile  a value from `constants.UPLOAD_PROFILES`
 * @param {string} builder  for the error message
 */
function ruleFor(profile, builder) {
  const rule = UPLOAD_RULES[profile];
  if (!rule) {
    /*
     * Boot-time, on the same reasoning as `requireModule`: a typo'd profile would otherwise surface
     * as a runtime crash on the first upload, long after the route was written.
     */
    throw new Error(
      `${builder}(): unknown upload profile '${profile}'. Expected one of ${UPLOAD_PROFILE_LIST.join(', ')}`
    );
  }
  return rule;
}

/**
 * A client-supplied filename reduced to a bare name.
 *
 * `path.basename` alone is not enough: on POSIX it does not treat `\` as a separator, so a Windows
 * client's `C:\Users\x\evil.png` would survive intact.
 *
 * @param {string} name
 * @returns {string}
 */
function bareName(name) {
  const cleaned = String(name || '').replace(/\0/g, '');
  const last = cleaned.split(/[\\/]/).pop();
  return path.basename(last || '').trim();
}

/**
 * The 403 for a plan-bound refusal, phrased like `usageService.assertWithinLimit`'s.
 *
 * @param {object} ceiling  `req.upload`
 * @param {number|null} [actualMb]  the size that was refused, when it is known
 */
function planLimitError(ceiling, actualMb = null) {
  const allowed = ceiling.planMb === null ? ceiling.maxMb : ceiling.planMb;
  const message =
    allowed > 0
      ? `File Upload Limit reached. Your plan allows ${allowed} MB per file.`
      : 'Your plan does not include file uploads.';

  return ApiError.limitExceeded(message, {
    limitKey: LIMIT_KEY,
    limit: allowed,
    unit: 'megabytes',
    requested: actualMb === null ? null : Number(actualMb.toFixed(3)),
  });
}

/** The 413 for a refusal the school cannot buy its way out of. */
function serverLimitError(ceiling) {
  return new ApiError(413, `Uploads are limited to ${ceiling.maxMb} MB per file.`, {
    code: 'FILE_TOO_LARGE',
    details: { limit: ceiling.maxMb, unit: 'megabytes' },
  });
}

/**
 * Resolve this request's ceiling and allowlist, and hang them on `req.upload`.
 *
 * Runs before multer so `limits.fileSize` can be set from the plan.
 *
 * ## `allowInactiveSubscription` — for billing surfaces only
 *
 * Every ordinary upload surface (homework, submissions, student documents) belongs to a subscribed
 * module, so an unusable subscription must stop the upload — that is `assertSubscriptionUsable()` at
 * work, the same judgement `requireModule` makes. §13.3's payment screenshot is the exception the
 * gate cannot serve: FR-BILL-003 is *how a school pays*, and the school that most needs to pay is the
 * one whose subscription has gone `pending` (a brand-new school awaiting its first payment),
 * `past_due`, `suspended` or `expired` — none of which are in `SUBSCRIPTION_USABLE_STATES`. Gating the
 * screenshot on a usable subscription would be a deadlock: cannot pay because suspended, cannot be
 * un-suspended because cannot pay.
 *
 * So `PAYMENT_PROOF` alone passes `allowInactiveSubscription: true`, which (1) skips the usable-state
 * assertion and (2) falls the ceiling back to the server backstop when the billing state has zeroed the
 * plan allowance — the file-type allowlist, the size ceiling and `sanitizeParsedBody` all still apply,
 * so §24 file security is intact; only the *subscription-state* precondition is lifted.
 *
 * @param {string} profile
 * @param {object} rule
 * @param {{allowInactiveSubscription?: boolean}} [options]
 * @returns {import('express').RequestHandler}
 */
function resolveUploadContext(profile, rule, options = {}) {
  const allowInactive = Boolean(options.allowInactiveSubscription);

  return asyncHandler(async (req, res, next) => {
    assertTenantResolved(req, 'upload');

    const hardMb = Number(config.uploads.maxMb) || 0;

    if (hardMb <= 0) {
      /* MAX_UPLOAD_MB is the server backstop; without it there is no ceiling to enforce at all. */
      logger.error('Upload ceiling resolved to zero from server configuration', {
        requestId: req.id,
        maxUploadMb: config.uploads.maxMb,
      });
      throw ApiError.internal();
    }

    if (req.tenant.isPlatform) {
      /*
       * No single school is in scope, so there is no plan limit to read — the server backstop is the
       * only ceiling. Consistent with every other guard, which platform scope also bypasses.
       */
      req.upload = {
        profile,
        schoolId: null,
        mimeTypes: rule.mimeTypes,
        maxFiles: rule.maxFiles,
        planMb: null,
        hardMb,
        maxMb: hardMb,
        maxBytes: Math.floor(hardMb * MEGABYTE),
        source: CEILING_SOURCES.SERVER,
      };
      return next();
    }

    const snapshot = await loadSnapshot(req);

    /* State before allowance: an expired subscription is a different problem from a small plan. */
    if (!allowInactive) {
      assertSubscriptionUsable(req, snapshot);
    }

    const limit = snapshot.limits[LIMIT_KEY];
    const unlimited = Boolean(limit) && limit.type === LIMIT_TYPES.UNLIMITED;

    /*
     * A Fixed limit with no value is a plan that never configured this limit. The entitlement chain
     * defaults to deny, and so does this: zero, not "unlimited by omission".
     */
    const planMb = unlimited ? null : Number((limit && limit.value) || 0);

    /* The plan is binding whenever it is at least as strict as the backstop. */
    const planBinding = planMb !== null && planMb <= hardMb;
    const maxMb = planMb === null ? hardMb : Math.min(planMb, hardMb);

    req.upload = {
      profile,
      schoolId: snapshot.schoolId,
      mimeTypes: rule.mimeTypes,
      maxFiles: rule.maxFiles,
      planMb,
      hardMb,
      maxMb,
      maxBytes: Math.floor(maxMb * MEGABYTE),
      source: planBinding ? CEILING_SOURCES.PLAN : CEILING_SOURCES.SERVER,
      limitSource: limit ? limit.source : null,
    };

    if (req.upload.maxBytes <= 0) {
      /*
       * On a billing surface (`allowInactiveSubscription`), a zeroed allowance is the billing state
       * itself — an unsubscribed or lapsed school whose plan grants no uploads. Refusing the payment
       * screenshot here would recreate the very deadlock the flag exists to avoid, so the ceiling falls
       * back to the server backstop, which is already known positive. Everywhere else, a zero ceiling is
       * a plan that does not include uploads and the refusal stands.
       */
      if (allowInactive) {
        req.upload.planMb = null;
        req.upload.maxMb = hardMb;
        req.upload.maxBytes = Math.floor(hardMb * MEGABYTE);
        req.upload.source = CEILING_SOURCES.SERVER;
        return next();
      }

      /*
       * Refused before a byte is read. Buffering a body only to discard all of it would let an
       * unsubscribed school spend the server's disk on an upload it was never entitled to make.
       * `hardMb` is already known to be positive, so only a plan can bring the ceiling to zero.
       */
      throw planLimitError(req.upload);
    }

    return next();
  });
}

/**
 * What to hand multer as `limits.fileSize`, which is one byte above the true allowance.
 *
 * busboy signals truncation the moment the bytes read *reach* its limit — `if (fileSize ===
 * fileSizeLimit)` in busboy/lib/types/multipart.js — so a limit of N accepts at most N-1 bytes and
 * refuses a file of exactly N. The plan's allowance is inclusive: SRS §11.2's "1 MB" means a 1 MB file
 * is allowed, and `usageService.checkPerRequestLimit` agrees, comparing `projected <= allowance`.
 *
 * Passing N+1 lines multer's boundary up with the service's, so a file sitting exactly on the ceiling
 * cannot be refused by one layer and permitted by the other.
 *
 * @param {object} ceiling  `req.upload`
 * @returns {number}
 */
function multerByteLimit(ceiling) {
  return ceiling.maxBytes + 1;
}

/**
 * Per-surface type allowlist. multer calls this before writing anything.
 *
 * @param {import('express').Request} req
 * @param {{mimetype: string, originalname: string}} file
 * @param {(err: any, accept?: boolean) => void} cb
 */
function fileFilter(req, file, cb) {
  const { mimeTypes, profile } = req.upload;

  /* Normalised once, here, so the stored `documents.file_name` is never a caller-chosen path. */
  file.originalname = bareName(file.originalname);

  const declared = String(file.mimetype || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const carriedBy = UPLOAD_MIME_EXTENSIONS[declared];

  if (!carriedBy || !mimeTypes.includes(declared)) {
    return cb(
      new ApiError(415, 'That file type is not accepted here.', {
        details: { field: file.fieldname, received: declared || null, allowed: mimeTypes },
      })
    );
  }

  const ext = path.extname(file.originalname).toLowerCase();

  if (!carriedBy.includes(ext)) {
    /*
     * The declared type and the extension disagree. This is the `payload.php` renamed to `.png`
     * case — or, harmlessly, a client that mislabelled a real image. Either way the file is not what
     * it claims, and accepting it would put an extension we never allowed onto disk.
     */
    logger.warn('Upload rejected: declared type does not match extension', {
      requestId: req.id,
      schoolId: req.upload.schoolId,
      profile,
      declared,
      extension: ext || null,
    });
    return cb(
      new ApiError(415, 'The file’s extension does not match its type.', {
        code: 'FILE_EXTENSION_MISMATCH',
        details: { field: file.fieldname, declared, extension: ext || null, expected: carriedBy },
      })
    );
  }

  return cb(null, true);
}

/** One directory per school per surface, so tenancy holds on disk as well as in the schema. */
function destination(req, file, cb) {
  const tenantDir = req.upload.schoolId ? `school-${req.upload.schoolId}` : 'platform';
  const dir = path.join(config.uploads.dir, tenantDir, req.upload.profile);
  fsp.mkdir(dir, { recursive: true }).then(() => cb(null, dir), cb);
}

/**
 * Stored names are random.
 *
 * Nothing of the caller's choosing reaches the filesystem: no collisions, no traversal, no guessing
 * another school's file by name. The original is kept on `file.originalname` for display.
 */
function filename(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
}

const storage = multer.diskStorage({ destination, filename });

/**
 * Every file multer parsed, whichever shape it used.
 *
 * @param {import('express').Request} req
 * @returns {Array<object>}
 */
function uploadedFiles(req) {
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') {
    return Object.values(req.files).reduce((all, group) => all.concat(group), []);
  }
  return [];
}

/**
 * Delete whatever this request wrote to disk.
 *
 * multer removes its own files when it aborts, but not when something *after* it refuses — a plan
 * check, a validator, or a failed database write. Exported so handlers can do the same.
 *
 * @param {import('express').Request} req
 * @returns {Promise<void>}
 */
async function cleanupUploads(req) {
  const files = uploadedFiles(req).filter((file) => file && file.path);

  await Promise.all(
    files.map(async (file) => {
      try {
        await fsp.unlink(file.path);
      } catch (err) {
        if (err.code === 'ENOENT') return;
        /* Not worth failing the request over — the caller already has a real error to report. */
        logger.warn('Could not remove an uploaded file', {
          requestId: req.id,
          path: file.path,
          error: err.message,
        });
      }
    })
  );
}

/**
 * Run multer, translating its size refusal into the one the remedy fits.
 *
 * @param {(req: any, res: any, cb: (err?: any) => void) => void} handler
 * @returns {import('express').RequestHandler}
 */
function runMulter(handler) {
  return function multerRunner(req, res, next) {
    handler(req, res, (err) => {
      if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(
          req.upload.source === CEILING_SOURCES.PLAN
            ? planLimitError(req.upload)
            : serverLimitError(req.upload)
        );
      }
      return next(err);
    });
  };
}

/**
 * Re-check the real byte count against the plan, through `usageService`.
 *
 * multer has already bounded the size, so this normally confirms rather than refuses. It runs anyway
 * for two reasons: the authoritative answer must come from the database-driven service (SRS §30
 * Rule 1) rather than from a byte count a middleware computed, and the handler needs the resulting
 * `req.limitChecks[file_upload_limit]` — the same object `enforceLimit` leaves — to report usage.
 *
 * The largest file decides. A per-request ceiling applies to each file separately, so if the largest
 * fits, all of them do.
 *
 * @returns {import('express').RequestHandler}
 */
function verifyUploadedSize() {
  return asyncHandler(async (req, res, next) => {
    const files = uploadedFiles(req);

    /* No file is not an error here. Whether one was required is the validator's judgement. */
    if (!files.length || req.tenant.isPlatform) return next();

    const largest = files.reduce((max, file) => (file.size > max.size ? file : max), files[0]);
    const megabytes = largest.size / MEGABYTE;

    const result = await usageService.checkPerRequestLimit(req.upload.schoolId, LIMIT_KEY, megabytes);

    if (!req.limitChecks) req.limitChecks = {};
    req.limitChecks[LIMIT_KEY] = result;

    if (!result.allowed) {
      await cleanupUploads(req);
      throw planLimitError(req.upload, megabytes);
    }

    return next();
  });
}

/**
 * Accept one file on `field`.
 *
 * @param {string} profile  a value from `constants.UPLOAD_PROFILES`
 * @param {string} field    the multipart field name
 * @param {{allowInactiveSubscription?: boolean}} [options]  see `resolveUploadContext`
 * @returns {import('express').RequestHandler[]}
 */
function uploadSingle(profile, field, options = {}) {
  const rule = ruleFor(profile, 'uploadSingle');

  if (!field || typeof field !== 'string') {
    throw new Error('uploadSingle() requires a field name');
  }

  return [
    resolveUploadContext(profile, rule, options),
    runMulter((req, res, cb) => {
      multer({
        storage,
        fileFilter,
        limits: { fileSize: multerByteLimit(req.upload), files: 1 },
      }).single(field)(req, res, cb);
    }),
    sanitizeParsedBody,
    verifyUploadedSize(),
  ];
}

/**
 * Accept several files on one `field`.
 *
 * @param {string} profile
 * @param {string} field
 * @param {number} [maxCount]  defaults to the profile's `maxFiles`, and may not exceed it
 * @param {{allowInactiveSubscription?: boolean}} [options]  see `resolveUploadContext`
 * @returns {import('express').RequestHandler[]}
 */
function uploadArray(profile, field, maxCount, options = {}) {
  const rule = ruleFor(profile, 'uploadArray');

  if (!field || typeof field !== 'string') {
    throw new Error('uploadArray() requires a field name');
  }

  const count = maxCount === undefined ? rule.maxFiles : Number(maxCount);

  if (!Number.isInteger(count) || count < 1 || count > rule.maxFiles) {
    throw new Error(
      `uploadArray('${profile}'): maxCount must be an integer between 1 and ${rule.maxFiles}`
    );
  }

  return [
    resolveUploadContext(profile, rule, options),
    runMulter((req, res, cb) => {
      multer({
        storage,
        fileFilter,
        limits: { fileSize: multerByteLimit(req.upload), files: count },
      }).array(field, count)(req, res, cb);
    }),
    sanitizeParsedBody,
    verifyUploadedSize(),
  ];
}

/**
 * The path to store in a `*_path` column: relative to the uploads root, slash-normalised.
 *
 * The absolute disk path (`file.path`) is never stored — it leaks the server's directory layout and
 * breaks the moment the uploads root moves. This function already namespaces the file under
 * `school-<id>/<profile>/<random>`, so the relative path is both portable and tenant-scoped.
 *
 * It lived in `payments.service.js` while the payment screenshot was the only upload in the
 * application. §20.2's homework attachment is the second, and a school-side module importing a helper
 * out of a billing service would be the wrong dependency — so it moved here, next to `cleanupUploads`,
 * which every upload caller already needs for the same reason. `payments.service.js` re-exports it so
 * nothing that already imported it from there had to change.
 *
 * @param {object|undefined} file  `req.file` from `uploadSingle`
 * @returns {string|null}
 */
function relativeUploadPath(file) {
  if (!file || !file.path) return null;
  return path.relative(config.uploads.dir, file.path).split(path.sep).join('/');
}

module.exports = {
  uploadSingle,
  uploadArray,
  cleanupUploads,
  uploadedFiles,
  relativeUploadPath,
  CEILING_SOURCES,
};
