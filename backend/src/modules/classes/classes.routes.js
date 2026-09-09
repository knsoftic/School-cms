'use strict';

/**
 * Class and section routes — mounted at `/api/v1/classes`.
 *
 * | SRS   | FR            | Route                              | Guard               |
 * |-------|---------------|------------------------------------|---------------------|
 * | §14.3 | FR-SCHOOL-003 | `GET /`, `GET /:id`                | `classes.view`      |
 * | §14.3 | FR-SCHOOL-003 | `POST /`, `PATCH /:id`, `DELETE /:id` | `classes.manage` |
 * | §14.3 | FR-SCHOOL-003 | `GET /:id/sections`                | `classes.view`      |
 * | §14.3 | FR-SCHOOL-003 | `POST /:id/sections`               | `classes.manage`    |
 * | §14.3 | FR-SCHOOL-003 | `PATCH /:id/sections/:sectionId`   | `classes.manage`    |
 * | §14.3 | FR-SCHOOL-003 | `DELETE /:id/sections/:sectionId`  | `classes.manage`    |
 *
 * Nested section paths are declared before `/:id` would matter for a colliding literal; they
 * cannot collide with `GET /:id` because they have an extra segment. No `requirePlatformScope()`:
 * the actor is Principal / School Admin (teachers hold `classes.view` only).
 */

const { createRouter } = require('../../utils/createRouter');
const { asyncHandler, validate, logActivity, requirePermission } = require('../../middlewares');

const controller = require('./classes.controller');
const { schemas } = require('./classes.validation');

const router = createRouter();

router.get(
  '/',
  requirePermission('classes.view'),
  validate({ query: schemas.list }),
  asyncHandler(controller.list)
);

router.post(
  '/',
  requirePermission('classes.manage'),
  validate({ body: schemas.create }),
  logActivity({ action: 'create', entityType: 'class', onlyOnSuccess: true }),
  asyncHandler(controller.create)
);

router.get(
  '/:id/sections',
  requirePermission('classes.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.listSections)
);

router.post(
  '/:id/sections',
  requirePermission('classes.manage'),
  validate({ params: schemas.idParam, body: schemas.createSection }),
  logActivity({ action: 'create', entityType: 'section', onlyOnSuccess: true }),
  asyncHandler(controller.createSection)
);

router.patch(
  '/:id/sections/:sectionId',
  requirePermission('classes.manage'),
  validate({ params: schemas.sectionParams, body: schemas.updateSection }),
  logActivity({ action: 'update', entityType: 'section', onlyOnSuccess: true }),
  asyncHandler(controller.updateSection)
);

router.delete(
  '/:id/sections/:sectionId',
  requirePermission('classes.manage'),
  validate({ params: schemas.sectionParams }),
  logActivity({ action: 'delete', entityType: 'section', onlyOnSuccess: true }),
  asyncHandler(controller.destroySection)
);

router.get(
  '/:id',
  requirePermission('classes.view'),
  validate({ params: schemas.idParam, query: schemas.showQuery }),
  asyncHandler(controller.show)
);

router.patch(
  '/:id',
  requirePermission('classes.manage'),
  validate({ params: schemas.idParam, body: schemas.update }),
  logActivity({ action: 'update', entityType: 'class', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

router.delete(
  '/:id',
  requirePermission('classes.manage'),
  validate({ params: schemas.idParam }),
  logActivity({ action: 'delete', entityType: 'class', onlyOnSuccess: true }),
  asyncHandler(controller.destroy)
);

module.exports = router;
