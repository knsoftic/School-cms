'use strict';

/**
 * Middleware barrel.
 *
 * One import for route modules, and — more usefully — one place that records the order the pipeline
 * has to run in. The order is not stylistic: every step below depends on the ones above it.
 *
 * ```
 * app.js            requestContext        request id + timing, first so everything can be traced
 *                   helmet / cors / hpp   transport-level hardening
 *                   body parsers          req.body exists
 *                   cookieParser          req.cookies exists (csrf, refresh token)
 *                   sanitizeRequest       cleans body/query/params before anything reads them
 *                   apiLimiter            cheap refusal before any database work
 *                   activityAudit         registers the writer; fills itself in from later steps
 *
 * /api/v1 router    authenticate          req.user, req.auth
 *                   enforcePasswordChange must_change_password blocks everything but the change
 *                   resolveTenant         req.tenant — layer 2 of the isolation chain
 *                   enforceTenant         refuses cross-tenant references — layer 3
 *
 * per route         requireRole /         who may call this at all
 *                   requirePermission
 *                   requireModule         is the module in the plan (SRS §11.1)
 *                   requireFeature        is the feature in the plan
 *                   enforceLimit          would this exceed a plan limit (SRS §11.2)
 *                   uploadSingle/Array    multipart, gated by file_upload_limit
 *                   validate              Joi, last — after sanitising and after the file exists
 *                   logActivity           declares the row this request will write
 *
 * app.js (tail)     notFoundHandler       unmatched routes become a 404 envelope
 *                   errorHandler          every failure becomes the JSON envelope
 * ```
 *
 * `requireModule` sits before `requirePermission` on a route: a school whose plan omits Library should
 * be told the module is not subscribed, not that their librarian lacks a permission for a feature they
 * do not have.
 *
 * Internal helpers are deliberately not re-exported — `collect`, `normalize`, `secretsMatch` and the
 * refusal tables are reachable by direct require, which keeps them available to their tests without
 * suggesting a route should be reaching for them.
 */

const asyncHandler = require('./asyncHandler');
const { requestContext, elapsedMs } = require('./requestContext');
const { sanitizeRequest } = require('./sanitize');
const { authenticate, enforcePasswordChange } = require('./authenticate');
const { resolveTenant } = require('./resolveTenant');
const { enforceTenant, installTenantParamGuards } = require('./enforceTenant');
const {
  requireRole,
  requirePermission,
  requireAnyPermission,
  requireAllPermissions,
  requirePlatformScope,
} = require('./authorize');
const {
  requireActiveSubscription,
  requireModule,
  requireAnyModule,
  requireFeature,
  enforceLimit,
  attachEntitlement,
} = require('./entitlement');
const { uploadSingle, uploadArray, cleanupUploads, uploadedFiles, relativeUploadPath } = require('./upload');
const { createRateLimiter, apiLimiter, authLimiter, aiLimiter } = require('./rateLimit');
const { requireCsrfToken, attachCsrfToken, issueCsrfToken, clearCsrfToken } = require('./csrf');
const {
  activityAudit,
  logActivity,
  describeActivity,
  recordActivity,
  recordAudit,
  snapshot,
  diff,
} = require('./activityLog');
const { validate, commonSchemas, listQuery } = require('./validate');
const { errorHandler, notFoundHandler } = require('./errorHandler');

module.exports = {
  /* Plumbing */
  asyncHandler,
  requestContext,
  elapsedMs,
  sanitizeRequest,

  /* Authentication and the tenant isolation chain */
  authenticate,
  enforcePasswordChange,
  resolveTenant,
  enforceTenant,
  installTenantParamGuards,

  /* Authorization */
  requireRole,
  requirePermission,
  requireAnyPermission,
  requireAllPermissions,
  requirePlatformScope,

  /* Subscription entitlement */
  requireActiveSubscription,
  requireModule,
  requireAnyModule,
  requireFeature,
  enforceLimit,
  attachEntitlement,

  /* Uploads */
  uploadSingle,
  uploadArray,
  cleanupUploads,
  relativeUploadPath,
  uploadedFiles,

  /* Abuse protection */
  createRateLimiter,
  apiLimiter,
  authLimiter,
  aiLimiter,
  requireCsrfToken,
  attachCsrfToken,
  issueCsrfToken,
  clearCsrfToken,

  /* Logging */
  activityAudit,
  logActivity,
  describeActivity,
  recordActivity,
  recordAudit,
  snapshot,
  diff,

  /* Validation and failure */
  validate,
  commonSchemas,
  listQuery,
  notFoundHandler,
  errorHandler,
};
