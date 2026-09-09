'use strict';

/**
 * Academic session routes — mounted at `/api/v1/sessions`.
 *
 * | SRS   | FR            | Route                 | Guard                |
 * |-------|---------------|-----------------------|----------------------|
 * | §14.2 | FR-SCHOOL-002 | `GET /`               | `sessions.view`      |
 * | §14.2 | FR-SCHOOL-002 | `GET /current`        | `sessions.view`      |
 * | §14.2 | FR-SCHOOL-002 | `GET /:id`            | `sessions.view`      |
 * | §14.2 | FR-SCHOOL-002 | `POST /`              | `sessions.manage`    |
 * | §14.2 | FR-SCHOOL-002 | `PATCH /:id`          | `sessions.manage`    |
 * | §14.2 | FR-SCHOOL-002 | `POST /:id/activate`  | `sessions.manage`    |
 * | §14.2 | FR-SCHOOL-002 | `POST /:id/close`     | `sessions.manage`    |
 *
 * `GET /current` is declared before `GET /:id` so Express does not treat the literal as an id
 * (the same trap `GET /invoices/summary` documents). There is no `requirePlatformScope()`: the
 * actor is Principal / School Admin. Isolation is `tenantWhere()` plus `resolveSchool()`.
 *
 * No DELETE — close is the operation FR-SCHOOL-002 names.
 */

const { createRouter } = require('../../utils/createRouter');
const { asyncHandler, validate, logActivity, requirePermission } = require('../../middlewares');

const controller = require('./sessions.controller');
const { schemas } = require('./sessions.validation');

const router = createRouter();

router.get(
  '/',
  requirePermission('sessions.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

router.get(
  '/current',
  requirePermission('sessions.view'),
  validate({ query: schemas.showQuery }),
  asyncHandler(controller.current)
);

router.post(
  '/',
  requirePermission('sessions.manage'),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'academic_session', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id',
  requirePermission('sessions.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  requirePermission('sessions.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'academic_session', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

router.post(
  '/:id/activate',
  requirePermission('sessions.manage'),
  validate({ params: schemas.idParam, body: schemas.action }),
  logActivity({ action: 'update', entityType: 'academic_session', onlyOnSuccess: true }),
  asyncHandler(controller.activate)
);

router.post(
  '/:id/close',
  requirePermission('sessions.manage'),
  validate({ params: schemas.idParam, body: schemas.action }),
  logActivity({ action: 'update', entityType: 'academic_session', onlyOnSuccess: true }),
  asyncHandler(controller.close)
);

module.exports = router;
