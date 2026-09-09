'use strict';

/**
 * Platform routes — mounted at `/api/v1/platform`. SRS §9.1, FR-SADMIN-001.
 *
 * ## No validation module
 *
 * The other three §9 modules have a `*.validation.js`; this one does not, and that is a decision rather
 * than an omission. The endpoint takes no body, no path parameter and no query string — the reporting
 * period is derived from the clock, not from the caller, so that two operators looking at "Monthly
 * Revenue" are looking at the same month. There is nothing to validate, and `validate()` with no schema
 * throws by design.
 *
 * ## No `requirePlatformScope()`
 *
 * `DEFAULT_ROLE_PERMISSIONS` grants `platform.dashboard.view` to `organization_admin` as well as
 * `super_admin`. A scope guard here would contradict the seeded catalogue, so the confinement is done in
 * the service instead: the same eleven aggregates, scoped by `req.tenant`. A platform caller gets
 * FR-SADMIN-001's platform-wide figures; an organization admin gets their own organization's.
 *
 * ## Not logged
 *
 * A dashboard is polled. `activityLog.js`'s header makes the argument: a row per read would bury the
 * day's real events, and FR-LOG-001 asks for actions.
 */

const { createRouter } = require('../../utils/createRouter');
const { asyncHandler, requirePermission } = require('../../middlewares');

const controller = require('./platform.controller');

const router = createRouter();

router.get('/dashboard', requirePermission('platform.dashboard.view'), asyncHandler(controller.dashboard));

module.exports = router;
