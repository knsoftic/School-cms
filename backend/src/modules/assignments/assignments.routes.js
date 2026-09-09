'use strict';

/**
 * Assignment routes — mounted at `/api/v1/assignments`.
 *
 * | SRS  | FR         | Route                          | Permission           |
 * |------|------------|--------------------------------|----------------------|
 * | 20.3 | FR-ASG-001 | `GET /submissions`             | `assignments.view`   |
 * | 20.3 | FR-ASG-001 | `GET /submissions/:id`         | `assignments.view`   |
 * | 20.3 | FR-ASG-001 | `PATCH /submissions/:id/review`| `assignments.review` |
 * | 20.3 | FR-ASG-001 | `GET /`                        | `assignments.view`   |
 * | 20.3 | FR-ASG-001 | `POST /`                       | `assignments.manage` |
 * | 20.3 | FR-ASG-001 | `GET /:id`                     | `assignments.view`   |
 * | 20.3 | FR-ASG-001 | `PATCH /:id`                   | `assignments.manage` |
 * | 20.3 | FR-ASG-001 | `POST /:id/submissions`        | `assignments.submit` |
 *
 * `requireModule(MODULES.ASSIGNMENTS)` router-level. **No `enforceLimit`** — §11.2's eight limits
 * contain nothing assignment-shaped, and neither an assignment nor a submission is a headcount.
 * Asserted by reading the router's source with comments stripped, not by a handler name.
 *
 * ## The `/submissions` routes are declared first, and that ordering is load-bearing
 *
 * Express matches in declaration order, so `GET /:id` declared above `GET /submissions` would swallow
 * the literal path and hand `"submissions"` to `idParam`, which answers 422 for a route that exists.
 * The three literal-prefixed routes therefore come first. This is the one thing in the file that would
 * break silently if it were reordered for tidiness, so it is stated rather than left to be noticed.
 *
 * ## Three permissions for three steps, and the catalogue matches the FR
 *
 * FR-ASG-001 names **Teacher / Student** and three verbs, and the fixed catalogue has a key for each:
 *
 * - `assignments.manage` — Teacher, Principal, School Admin, Super Admin. Step one, *create*.
 * - `assignments.submit` — **Student** and Super Admin. Step two, *submit*.
 * - `assignments.review` — Teacher, Principal, School Admin, Super Admin. Step three, *review*.
 * - `assignments.view` — all of the above plus Parent.
 *
 * `assignments.submit` reaching Super Admin is the catalogue's construction, not a second actor: the
 * route resolves the submitting student from the authenticated user, and a Super Admin has no student
 * profile, so they are refused in the service with `NOT_A_STUDENT`. Asserted, so the refusal reads as a
 * decision rather than a gap.
 *
 * A **student is an actor here, not just an audience** — the first module in the application where the
 * student's own request writes a row. §20.2's student could only read.
 *
 * ## The upload is on the submit, not on the create
 *
 * FR-ASG-001 names no file for the teacher's assignment; only §20.2's FR-HW-001 says "Upload File". And
 * `middlewares/upload.js` carries a `submission` profile whose rules table cites *"§20.3 / FR-ASG-001 —
 * student “Submit” (format not specified)"* by name, with no assignment profile beside it. Both readings agree, so the multer
 * chain is on `POST /:id/submissions` alone and `attachment_path`/`attachment_name` are `forbidden()`
 * in every schema in this module.
 *
 * The middleware order is the one `payments.record` established and §20.2 repeated: permission →
 * `uploadSingle` (so `req.file` exists and the multipart text fields are parsed) → `validate` (which
 * then sees those fields) → `logActivity`.
 *
 * ## No DELETE
 *
 * §20.3 names none. An assignment is withdrawn with `status: closed`, which also stops it accepting
 * submissions; deleting one would cascade its students' submissions away with it, and §20.3 never asks
 * for that.
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

const controller = require('./assignments.controller');
const { schemas } = require('./assignments.validation');

const router = createRouter();

router.use(requireModule(MODULES.ASSIGNMENTS));

/* ── the literal paths first; see the header ── */

router.get(
  '/submissions',
  requirePermission('assignments.view'),
  validate({ query: schemas.listSubmissions }),
  asyncHandler(controller.listSubmissions)
);

/*
 * Declared before `/submissions/:id`, or `/submissions/:id/attachment` would still match it and the
 * suffix would be ignored. Same `assignments.view` as the record.
 */
router.get(
  '/submissions/:id/attachment',
  requirePermission('assignments.view'),
  validate({ params: schemas.idParam }),
  logActivity({ action: 'view', entityType: 'assignments', onlyOnSuccess: true }),
  asyncHandler(controller.submissionAttachment)
);

router.get(
  '/submissions/:id',
  requirePermission('assignments.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.showSubmission)
);

/* FR-ASG-001, step three — the teacher reviews. */
router.patch(
  '/submissions/:id/review',
  requirePermission('assignments.review'),
  validate({ params: schemas.idParam, body: schemas.review }),
  logActivity({ action: 'update', entityType: 'assignments', onlyOnSuccess: true }),
  asyncHandler(controller.review)
);

/* ── the assignment itself ── */

router.get(
  '/',
  requirePermission('assignments.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

/* FR-ASG-001, step one — the teacher creates. */
router.post(
  '/',
  requirePermission('assignments.manage'),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'assignments', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id',
  requirePermission('assignments.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  requirePermission('assignments.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'assignments', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

/* FR-ASG-001, step two — the student submits, with the file. */
router.post(
  '/:id/submissions',
  requirePermission('assignments.submit'),
  uploadSingle(UPLOAD_PROFILES.SUBMISSION, 'attachment'),
  validate({ params: schemas.idParam, body: schemas.submit }),
  logActivity({ action: 'create', entityType: 'assignments', onlyOnSuccess: true }),
  asyncHandler(controller.submit)
);

module.exports = router;
