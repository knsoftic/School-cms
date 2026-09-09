'use strict';

/**
 * Router factory — the single way an API router is created in this codebase.
 *
 * Its reason for existing is SRS §8 FR-TENANT-003. `enforceTenant` is mounted once on `/api/v1` and
 * inspects the URL, query string and body, but Express does not populate `req.params` until a route
 * layer matches, and it does not propagate `router.param()` callbacks into nested routers. So a
 * route parameter can only be checked by a guard registered on the router that declares it.
 *
 * Asking every module to remember that would make the isolation boundary depend on discipline. This
 * factory removes the choice: a router obtained from `createRouter()` already carries the tenant
 * param guards, and using `express.Router()` directly for a module is the mistake, not the default.
 *
 *   const router = createRouter();
 *   router.get('/:schoolId/students', requirePermission('students.view'), listStudents);
 *
 * `mergeParams` defaults to true so a nested router still sees the parent's `:schoolId` — without it
 * a child router's handlers would read an empty `req.params` and any ownership check written against
 * it would silently pass.
 */

const express = require('express');

const { installTenantParamGuards } = require('../middlewares/enforceTenant');

/**
 * @param {import('express').RouterOptions} [options]
 * @returns {import('express').Router} a router with tenant param guards installed
 */
function createRouter(options = {}) {
  const router = express.Router({ mergeParams: true, ...options });
  return installTenantParamGuards(router);
}

module.exports = { createRouter };
