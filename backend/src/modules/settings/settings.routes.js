'use strict';

/**
 * School settings routes — mounted at `/api/v1/school-settings`.
 *
 * | SRS   | FR            | Route     | Guard                     |
 * |-------|---------------|-----------|---------------------------|
 * | §14.1 | FR-SCHOOL-001 | `GET /`   | `school.settings.view`    |
 * | §14.1 | FR-SCHOOL-001 | `PATCH /` | `school.settings.manage`  |
 *
 * Actor is **Principal / School Admin**, so there is no `requirePlatformScope()`. Isolation is
 * `resolveSchool()` plus the unique `school_id` on the row. Super Admin reaches this with
 * `school_id` in the query/body because they hold every key and have no school in tenant scope.
 */

const { createRouter } = require('../../utils/createRouter');
const { asyncHandler, validate, logActivity, requirePermission } = require('../../middlewares');

const controller = require('./settings.controller');
const { schemas } = require('./settings.validation');

const router = createRouter();

router.get('/', requirePermission('school.settings.view'), validate({ query: schemas.showQuery }), asyncHandler(controller.show));

router.patch(
  '/',
  requirePermission('school.settings.manage'),
  validate({ body: schemas.update }),
  logActivity({ action: 'update', entityType: 'school_setting', onlyOnSuccess: true }),
  asyncHandler(controller.update)
);

module.exports = router;
