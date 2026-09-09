'use strict';

/**
 * Subject routes — mounted at `/api/v1/subjects`.
 *
 * | SRS   | FR            | Route                                   | Guard                |
 * |-------|---------------|-----------------------------------------|----------------------|
 * | §14.4 | FR-SCHOOL-004 | `GET /`, `GET /:id`                     | `subjects.view`      |
 * | §14.4 | FR-SCHOOL-004 | `POST /`, `PATCH /:id`, `DELETE /:id`   | `subjects.manage`    |
 * | §14.4 | FR-SCHOOL-004 | `GET /:id/classes`                      | `subjects.view`      |
 * | §14.4 | FR-SCHOOL-004 | `POST /:id/classes`                     | `subjects.manage`    |
 * | §14.4 | FR-SCHOOL-004 | `DELETE /:id/classes/:assignmentId`     | `subjects.manage`    |
 * | §14.4 | FR-SCHOOL-004 | `GET /:id/teachers`                     | `subjects.view`      |
 * | §14.4 | FR-SCHOOL-004 | `POST /:id/teachers`                    | `subjects.manage`    |
 * | §14.4 | FR-SCHOOL-004 | `DELETE /:id/teachers/:assignmentId`    | `subjects.manage`    |
 *
 * Nested `/classes` and `/teachers` are declared before `GET /:id` so a future literal cannot be
 * eaten as an id. No `requirePlatformScope()`: the actor is Principal / School Admin (teachers
 * hold `subjects.view` only).
 */

const { createRouter } = require('../../utils/createRouter');
const { asyncHandler, validate, logActivity, requirePermission } = require('../../middlewares');

const controller = require('./subjects.controller');
const { schemas } = require('./subjects.validation');

const router = createRouter();

router.get(
  '/',
  requirePermission('subjects.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

router.post(
  '/',
  requirePermission('subjects.manage'),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'subject', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id/classes',
  requirePermission('subjects.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.listClasses)
);

router.post(
  '/:id/classes',
  requirePermission('subjects.manage'),
  validate({ params: schemas.idParam, body: schemas.assignClass }),
  logActivity({ action: 'create', entityType: 'class_subject', onlyOnSuccess: true }),
  asyncHandler(controller.assignClass)
);

router.delete(
  '/:id/classes/:assignmentId',
  requirePermission('subjects.manage'),
  validate({ params: schemas.assignmentParams }),
  logActivity({ action: 'delete', entityType: 'class_subject', onlyOnSuccess: true }),
  asyncHandler(controller.unassignClass)
);

router.get(
  '/:id/teachers',
  requirePermission('subjects.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.listTeachers)
);

router.post(
  '/:id/teachers',
  requirePermission('subjects.manage'),
  validate({ params: schemas.idParam, body: schemas.assignTeacher }),
  logActivity({ action: 'create', entityType: 'teacher_subject', onlyOnSuccess: true }),
  asyncHandler(controller.assignTeacher)
);

router.delete(
  '/:id/teachers/:assignmentId',
  requirePermission('subjects.manage'),
  validate({ params: schemas.assignmentParams }),
  logActivity({ action: 'delete', entityType: 'teacher_subject', onlyOnSuccess: true }),
  asyncHandler(controller.unassignTeacher)
);

router.get(
  '/:id',
  requirePermission('subjects.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  requirePermission('subjects.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'subject', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

router.delete(
  '/:id',
  requirePermission('subjects.manage'),
  validate({ params: schemas.idParam }),
  logActivity({ action: 'delete', entityType: 'subject', onlyOnSuccess: true }),
  asyncHandler(controller.destroy)
);

module.exports = router;
