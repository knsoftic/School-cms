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
} = require('../../middlewares');
const { MODULES, LIMITS, UPLOAD_PROFILES } = require('../../config/constants');

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
