'use strict';

/**
 * Log routes — mounted at `/api/v1/logs`. SRS §26: "Errors and activity are auditable via logs".
 *
 * | SRS | FR | Route          | Permission  |
 * |-----|----|----------------|-------------|
 * | §26 | —  | `GET /activity` | `logs.view` |
 * | §26 | —  | `GET /audit`    | `logs.view` |
 *
 * `logs.view` ("View activity & audit logs") has been in the catalogue and granted to school
 * leadership, the Organization Admin and the Super Admin since it was seeded, and no route used it:
 * the trails were written and readable only by someone with the database. Reads only — the logs are the
 * record of what happened, so nothing may edit or delete them through the API. No module gate: §26 is
 * operational, not something a plan sells.
 */

const { createRouter } = require('../../utils/createRouter');
const { asyncHandler, validate, requirePermission } = require('../../middlewares');

const controller = require('./logs.controller');
const { schemas } = require('./logs.validation');

const router = createRouter();

router.get(
  '/activity',
  requirePermission('logs.view'),
  validate({ query: schemas.activity }),
  asyncHandler(controller.activity)
);

router.get(
  '/audit',
  requirePermission('logs.view'),
  validate({ query: schemas.audit }),
  asyncHandler(controller.audit)
);

module.exports = router;
