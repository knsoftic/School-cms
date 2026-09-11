'use strict';

/**
 * Student routes — mounted at `/api/v1/students`.
 *
 * | SRS   | FR              | Route                 | Guards                                          |
 * |-------|-----------------|-----------------------|-------------------------------------------------|
 * | §15.1 | FR-STUDENT-001  | `GET /`               | `students` module · `students.view`             |
 * | §15.1 | FR-STUDENT-001  | `POST /`              | `students` module · `students.manage` · limit   |
 * | §15.1 | FR-STUDENT-001  | `GET /:id`            | `students` module · `students.view`             |
 * | §15.1 | FR-STUDENT-001  | `PATCH /:id`          | `students` module · `students.manage`           |
 * | §15.1 | FR-STUDENT-001  | `POST /:id/photo`     | `students` module · `students.manage`           |
 * | §15.1 | FR-STUDENT-001  | `GET /:id/photo`      | `students` module · `students.view`             |
 * | §15.1 | FR-STUDENT-002  | `POST /:id/promote`   | `students` module · `students.progression`      |
 * | §15.1 | FR-STUDENT-002  | `POST /:id/transfer`  | `students` module · `students.progression`      |
 * | §15.1 | FR-STUDENT-002  | `POST /:id/leave`     | `students` module · `students.progression`      |
 *
 * **The permission split is the SRS's own, not a choice made here.** FR-STUDENT-001 names the actor
 * as "Principal / School Admin / **Receptionist**"; FR-STUDENT-002 names only "Principal / School
 * Admin". The seeded catalogue already encodes that: `receptionist` holds `students.manage` but not
 * `students.progression` (`src/config/permissions.js`). So admission and profile edits take
 * `students.manage` while the three lifecycle routes take `students.progression`, and a receptionist
 * can admit a child but cannot mark one as having left. That is asserted over HTTP rather than
 * assumed, because the two keys would otherwise look interchangeable.
 *
 * `requireModule(MODULES.STUDENTS)` is mounted router-level, as in `teachers/` — the `module` field
 * on a permission is metadata that nothing in the request path reads, so the guard has to be
 * explicit or a school on a plan without the Students module would still reach every route.
 *
 * `POST /` carries `enforceLimit('student_limit')`. The three lifecycle routes do not: none of them
 * moves a student *into* `active` (see the transition table in the service), so none can raise the
 * count. Transfer and leaving lower it, and promotion leaves it alone.
 *
 * The three lifecycle paths have an extra segment, so they cannot collide with `GET /:id`. No
 * DELETE: §15.1 names Leaving, which is the operation, and `students` is paranoid besides.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireModule,
  enforceLimit,
  uploadSingle,
  uploadArray,
} = require('../../middlewares');
const { MODULES, LIMITS, UPLOAD_PROFILES, UPLOAD_RULES } = require('../../config/constants');
const { respondsWithFile } = require('../../utils/routeMeta');

const controller = require('./students.controller');
const { schemas } = require('./students.validation');

const router = createRouter();

router.use(requireModule(MODULES.STUDENTS));

router.get(
  '/',
  requirePermission('students.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

/*
 * The owner's decision D17 — a student's own record, or each linked child's for a parent, on
 * `students.self.view`: the key the catalogue granted both and nothing mounted until now. Declared
 * above `GET /:id` so the literal segment can never be read as an id.
 */
router.get(
  '/mine',
  requirePermission('students.self.view'),
  validate({ query: schemas.mineQuery }),
  asyncHandler(controller.mine)
);

router.post(
  '/',
  requirePermission('students.manage'),
  validate({ body: schemas.create }),
  enforceLimit(LIMITS.STUDENT_LIMIT),
  logActivity({ action: 'create', entityType: 'student', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

/*
 * FR-STUDENT-001 — "System captures Student Photo and Documents."
 *
 * The one writer `students.photo_path` has. Known Issues #26 made the column `forbidden()` in both
 * body schemas, so this route is the only way a photo reaches the row, and it takes it from multer
 * rather than from a caller-supplied string.
 *
 * The middleware order is the one `payments.record` established and §20.2/§20.3 repeated: permission →
 * `uploadSingle` (so `req.file` exists and the multipart text fields are parsed) → `validate` (which
 * then sees those fields, coerced from strings) → `logActivity`.
 *
 * The profile is `PERSON_PHOTO`, which has cited '§15.1 / FR-STUDENT-001 — "Photo"' in its own rules
 * table since `upload.js` was written and until now had no caller. It is images only, one file.
 *
 * `students.manage` rather than a new key: the catalogue is fixed by §29/§35 and has no photo
 * permission, and setting a photo is managing a student. It reaches the same roles `POST /` does,
 * which includes the Receptionist FR-STUDENT-001 names.
 */
router.post(
  '/:id/photo',
  requirePermission('students.manage'),
  uploadSingle(UPLOAD_PROFILES.PERSON_PHOTO, 'photo'),
  validate({ params: schemas.idParam, body: schemas.setPhoto }),
  logActivity({ action: 'update', entityType: 'student', onlyOnSuccess: true }),
  asyncHandler(controller.setPhoto)
);

/*
 * The reader for the writer above — Known Issues #32.
 *
 * `students.photo_path` had one writer and no reader at all, so a school could upload a photo and had
 * no way to look at it. This is `payments`' `GET /:id/screenshot` in every respect that matters: the
 * *view* permission rather than the manage one, because looking at a record's photo is looking at the
 * record; `validate` on the params and on `showQuery`, so a platform caller can name the school the
 * same way `GET /:id` lets them; and no `logActivity`, because the controller calls `describeActivity`
 * and a read is not a mutation.
 *
 * Declared above `GET /:id` for the same reason the three lifecycle routes are: an extra segment does
 * not collide with `:id`, but keeping the specific path first means it never can.
 */
router.get(
  '/:id/photo',
  requirePermission('students.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  respondsWithFile(asyncHandler(controller.photo), {
    types: UPLOAD_RULES[UPLOAD_PROFILES.PERSON_PHOTO].mimeTypes,
  })
);

/*
 * FR-STUDENT-001's other half — "System captures Student Photo **and Documents**" — the owner's
 * decision D13 in `docs/OWNER-DECISIONS.md`, settling triage finding 16.
 *
 * The `STUDENT_DOCUMENT` upload profile has cited '§15.1 / FR-STUDENT-001 — "Documents"' since
 * `upload.js` was written and had no caller: the finding was blocked because the only view key in the
 * fixed catalogue, `documents.view`, reads "View *generated* documents". D13 answers it with the
 * student's own permissions — a document on a student is part of the student's record, so uploading
 * one is managing the student (`students.manage`) and reading one is viewing them (`students.view`) —
 * which is the same reasoning the photo routes above already rest on. Rows go in the existing
 * `documents` table as uploads: `owner_type: 'student'`, `is_generated: false`, `document_type` null.
 *
 * Upload, list and download. Removing a document is not among what D13 decided.
 */
router.post(
  '/:id/documents',
  requirePermission('students.manage'),
  uploadArray(UPLOAD_PROFILES.STUDENT_DOCUMENT, 'documents'),
  validate({ params: schemas.idParam, body: schemas.addDocuments }),
  logActivity({ action: 'create', entityType: 'document', onlyOnSuccess: true }),
  asyncHandler(controller.addDocuments)
);

router.get(
  '/:id/documents',
  requirePermission('students.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.documents)
);

router.get(
  '/:id/documents/:documentId',
  requirePermission('students.view'),
  validate({ params: schemas.documentParam, query: schemas.showQuery }),
  respondsWithFile(asyncHandler(controller.documentFile), {
    types: UPLOAD_RULES[UPLOAD_PROFILES.STUDENT_DOCUMENT].mimeTypes,
  })
);

router.post(
  '/:id/promote',
  requirePermission('students.progression'),
  validate({ params: schemas.idParam, body: schemas.promote }),
  logActivity({ action: 'update', entityType: 'student', onlyOnSuccess: true }),
  asyncHandler(controller.promote)
);

router.post(
  '/:id/transfer',
  requirePermission('students.progression'),
  validate({ params: schemas.idParam, body: schemas.transfer }),
  logActivity({ action: 'update', entityType: 'student', onlyOnSuccess: true }),
  asyncHandler(controller.transfer)
);

router.post(
  '/:id/leave',
  requirePermission('students.progression'),
  validate({ params: schemas.idParam, body: schemas.leave }),
  logActivity({ action: 'update', entityType: 'student', onlyOnSuccess: true }),
  asyncHandler(controller.leave)
);

router.get(
  '/:id',
  requirePermission('students.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  requirePermission('students.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'student', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

module.exports = router;
