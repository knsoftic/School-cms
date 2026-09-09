'use strict';

/**
 * Teacher routes — mounted at `/api/v1/teachers`.
 *
 * | SRS   | FR              | Route                  | Guards                                            |
 * |-------|-----------------|------------------------|---------------------------------------------------|
 * | §15.3 | FR-TEACHER-001  | `GET /`                | `teachers` module · `teachers.view`               |
 * | §15.3 | FR-TEACHER-002  | `GET /dashboard`       | `teachers` module · `teachers.dashboard.view`     |
 * | §15.3 | FR-TEACHER-001  | `POST /`               | `teachers` module · `teachers.manage` · limit     |
 * | §15.3 | FR-TEACHER-001  | `GET /:id`             | `teachers` module · `teachers.view`               |
 * | §15.3 | FR-TEACHER-001  | `PATCH /:id`           | `teachers` module · `teachers.manage`             |
 * | §15.3 | FR-TEACHER-001  | `GET /:id/assignments` | `teachers` module · `teachers.view`               |
 *
 * **`requireModule('teachers')` is mounted here, and this is the first module in the project to
 * mount an entitlement guard at all.** The four §9 platform modules and the two catalogue modules
 * govern the platform rather than consuming a school's allowances; `subscriptions/` sells them;
 * §14's school-setup keys carry `module: null` because no §11.2 limit or `MODULES` entry covers
 * classes or subjects. The `teachers.*` keys are the first that carry a `module` binding
 * (`MODULES.TEACHERS`, `src/config/permissions.js:93-95`) — but that binding is **metadata**, read
 * by nothing in the request path, so the guard has to be mounted explicitly or a school on a plan
 * without the Teachers module would still reach these routes. That closes the gap
 * `docs/IMPLEMENTATION_CHECKLIST.md` row FR-SUB-008 has recorded since session 4.
 *
 * `POST /` additionally carries `enforceLimit('teacher_limit')` — §11.2's ceiling, counted live from
 * the `teachers` table rather than from `usage_records`. It is a *route* guard, so it only sees the
 * create path; `teacher_limit` counts `is_active: true`, which means a `PATCH` flipping that flag
 * back is also a limit event and is asserted in `teachers.service.update()` instead. The
 * `syncHeadcount` call after each write maintains the reporting mirror, not the ceiling.
 *
 * `GET /dashboard` is declared **before** `GET /:id` so Express cannot read the literal as an id —
 * the same ordering `GET /sessions/current` and `GET /invoices/summary` document. It is the one
 * route here whose actor is the teacher rather than the office, and it resolves the record from
 * `req.user.id` rather than from the path.
 *
 * No DELETE: §15.3 names none. A teacher who leaves is deactivated through `PATCH`.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireModule,
  enforceLimit,
} = require('../../middlewares');
const { MODULES, LIMITS } = require('../../config/constants');

const controller = require('./teachers.controller');
const { schemas } = require('./teachers.validation');

const router = createRouter();

router.use(requireModule(MODULES.TEACHERS));

router.get(
  '/',
  requirePermission('teachers.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

router.get(
  '/dashboard',
  requirePermission('teachers.dashboard.view'),
  validate({ query: schemas.showQuery }),
  asyncHandler(controller.dashboard)
);

router.post(
  '/',
  requirePermission('teachers.manage'),
  validate({ body: schemas.create }),
  /*
   * The increment follows the flag the headcount counts, not the fact of a row existing.
   *
   * `teachers_limit` counts `is_active: true` (`usageService.js`), and the module already asserts the
   * ceiling on the *re-activation* transition for that reason — but `POST` charged a flat 1 whatever
   * the body said. A record created **inactive** therefore consumed an allowance it was not counted
   * in, and a school at its ceiling could not enter someone who had already left. It failed closed,
   * so there was no bypass; the cost was a record that could not be entered until an active one was
   * deactivated.
   *
   * Known Issue #22's recorded action said to change all three headcount modules together. Two:
   * `students` refuses `status` on create outright (`students.validation.js:80`, "set by promote /
   * transfer / leave, not by this request"), so a student cannot be created inactive and its flat 1
   * is already correct. Branching there would be dead code on a field the schema rejects.
   */
  enforceLimit(LIMITS.TEACHER_LIMIT, {
    increment: (req) => (req.body && req.body.is_active === false ? 0 : 1),
  }),
  logActivity({ action: 'create', entityType: 'teacher', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id/assignments',
  requirePermission('teachers.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.assignments)
);

router.get(
  '/:id',
  requirePermission('teachers.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  requirePermission('teachers.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'teacher', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

module.exports = router;
