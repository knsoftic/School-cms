'use strict';

/**
 * Homework routes — mounted at `/api/v1/homework`.
 *
 * | SRS  | FR        | Route             | Permission        |
 * |------|-----------|-------------------|-------------------|
 * | 20.2 | FR-HW-001 | `GET /`           | `homework.view`   |
 * | 20.2 | FR-HW-001 | `POST /`          | `homework.manage` |
 * | 20.2 | FR-HW-001 | `GET /:id`        | `homework.view`   |
 * | 20.2 | FR-HW-001 | `PATCH /:id`      | `homework.manage` |
 *
 * `requireModule(MODULES.HOMEWORK)` router-level. **No `enforceLimit`** — §11.2's eight limits contain
 * nothing homework-shaped, and a homework row is not a headcount. Asserted by reading the router's
 * source, not a handler name.
 *
 * ## The permissions match FR-HW-001 exactly, for once
 *
 * FR-HW-001's actor is **Teacher**, and `homework.manage` is granted to Teacher, Principal, School Admin
 * and Super Admin — a superset that includes the named actor rather than excluding it. §19 and §16 both
 * had to record a mismatch where the catalogue withheld a permission from an actor the FR named; §20.2
 * has none, and that is worth stating so the absence is not mistaken for an oversight.
 *
 * `homework.view` additionally reaches Student and Parent. There is **no** `homework.self.view`, so the
 * two audiences share one permission and the service does the narrowing — see its header. A student's
 * list is confined to their own class and to published rows, and so is a read by id: a narrowing that
 * only applied to the list would be a courtesy any caller could step around by guessing an id.
 *
 * ## The upload is on the create, and the body may not name a path
 *
 * The middleware order is the barrel's, and it is the order `payments.record` established: permission →
 * `uploadSingle` (so `req.file` exists and multipart text fields are parsed) → `validate` (which then
 * sees those fields, coerced from strings) → `logActivity`. `uploadSingle` uses the `homework` profile,
 * which `middlewares/upload.js` has carried since it was written, citing FR-HW-001 by name, and which
 * until now had no caller.
 *
 * `attachment_path` and `attachment_name` are `forbidden()` in both schemas. A stored path comes from
 * the uploaded file, never from a request body — the doctrine `finance` and `fees` enforce, and the one
 * Known Issues #26 records five columns elsewhere still breaking.
 *
 * ## No DELETE, and no file replacement on PATCH
 *
 * §20.2 names neither. Homework is withdrawn with `is_published: false`, which also removes it from
 * every student's list, because the service serves students published rows only.
 *
 * `PATCH` edits fields and does **not** accept a replacement file. Swapping the attachment would orphan
 * the previous one on disk, and nothing in this application collects an orphaned file — `cleanupUploads`
 * only unwinds a failed request. Recorded rather than half-built.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireModule,
  uploadSingle,
} = require('../../middlewares');
const { MODULES, UPLOAD_PROFILES } = require('../../config/constants');

const controller = require('./homework.controller');
const { schemas } = require('./homework.validation');

const router = createRouter();

router.use(requireModule(MODULES.HOMEWORK));

router.get(
  '/',
  requirePermission('homework.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

router.post(
  '/',
  requirePermission('homework.manage'),
  uploadSingle(UPLOAD_PROFILES.HOMEWORK, 'attachment'),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'homework', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

/*
 * FR-HW-001's file. Below `/:id` is fine — `/:id/attachment` cannot be mistaken for an id — and it
 * carries the same `homework.view` the record does, because reading the file and reading the record
 * are the same act.
 */
router.get(
  '/:id/attachment',
  requirePermission('homework.view'),
  validate({ params: schemas.idParam }),
  logActivity({ action: 'view', entityType: 'homework', onlyOnSuccess: true }),
  asyncHandler(controller.attachment)
);

router.get(
  '/:id',
  requirePermission('homework.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  requirePermission('homework.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'homework', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

module.exports = router;
