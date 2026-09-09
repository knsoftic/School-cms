'use strict';

/**
 * Cross-tenant request rejection — SRS §8 FR-TENANT-003, §24 FR-SEC-002, §30 Rule 2. Layer 3 of
 * the four isolation layers in ARCHITECTURE §3.
 *
 * FR-TENANT-003, verbatim: "System validates that the school_id referenced in a request matches the
 * authenticated user's assigned school on every request, including when the school_id is supplied
 * in a URL." The SRS names the failing case as its critical test scenario: a Principal at School A
 * calling a School B endpoint must receive 403 and no data.
 *
 * ## Mounted globally, not per route
 *
 * "on every request" is taken literally — this is mounted once on the `/api/v1` router rather than
 * listed on individual routes, so a new route cannot be added without the check. A per-route guard
 * protects the routes someone remembered to annotate.
 *
 * ## It runs before `validate`
 *
 * `validate` strips unknown keys, so a hostile `school_id` in a body whose schema omits it would
 * simply vanish — no 403, no log, no evidence. FR-TENANT-003 requires a refusal, and a refused
 * request is also the only version of this event that shows up in the §26 activity log. Global
 * mounting puts this ahead of every route-level validator naturally.
 *
 * ## The whole payload is searched, at any depth
 *
 * Checking `req.params.schoolId` alone would miss `?school_id=9`, `{ "school_id": 9 }`, and
 * `{ "students": [{ "school_id": 9 }] }`. A bulk-create endpoint receiving that last shape is the
 * realistic version of this attack, so params, query and body are all walked recursively.
 *
 * ## Route parameters need their own mechanism
 *
 * A middleware installed with `router.use()` runs before any route layer has matched, so
 * `req.params` is still empty at that point — it is populated only when Express dispatches to the
 * matching route. Relying on `req.params` here therefore checks nothing, which is exactly the gap
 * FR-TENANT-003 calls out ("including when the school_id is supplied in a URL"). Two mechanisms
 * close it, and both are in place because each covers what the other cannot:
 *
 *   1. `collectFromPath` reads the URL itself, so `/api/v1/schools/8/students` is refused from the
 *      global mount without knowing anything about how the route was declared. This is the layer
 *      that cannot be forgotten.
 *   2. `installTenantParamGuards` registers `router.param()` handlers, which fire at dispatch when
 *      `req.params` does exist. This catches URL shapes the path scan cannot recognise — a school
 *      id that is not preceded by a `schools` segment, or one that is not purely numeric. Express 4
 *      does not inherit `param()` callbacks into nested routers, so this is applied by the
 *      `createRouter()` factory every module router is built with, not by remembering to add it.
 */

const ApiError = require('../utils/ApiError');
const asyncHandler = require('./asyncHandler');
const logger = require('../config/logger');
const tenantService = require('../services/tenantService');

/**
 * Keys that carry tenant scope, normalised to lower-case with separators removed. Matching this way
 * catches `school_id`, `schoolId`, `SchoolID` and `school-id` with one entry each.
 */
const TENANT_KEYS = {
  schoolid: 'school',
  organizationid: 'organization',
  orgid: 'organization',
};

/** Same cap as the input sanitiser: deep enough for any real payload, shallow enough to be cheap. */
const MAX_DEPTH = 12;

/**
 * URL collection segments whose following segment identifies a tenant, so `/schools/8/students` is
 * recognised from the path alone.
 */
const PATH_COLLECTIONS = {
  schools: 'school',
  organizations: 'organization',
  orgs: 'organization',
};

/** Tenant ids are BIGINT columns; only a digit string can be one. */
const NUMERIC_ID = /^\d+$/;

/**
 * Route parameter names the `param()` guards are registered for. Spelled out rather than derived,
 * because `router.param()` matches the literal name used in the route pattern.
 */
const TENANT_PARAM_NAMES = [
  'schoolId',
  'school_id',
  'schoolID',
  'organizationId',
  'organization_id',
  'orgId',
  'org_id',
];

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[-_\s]/g, '');
}

/** A value that names no tenant — a client clearing an optional field, not an attempt to cross one. */
function isEmpty(value) {
  return value === null || value === undefined || value === '';
}

/**
 * Collect every tenant reference in a payload.
 *
 * @param {any} node
 * @param {string} location  'params' | 'query' | 'body', used in the refusal details
 * @param {string} path      dotted path for diagnostics
 * @param {number} depth
 * @param {Array<{kind: string, value: any, location: string, path: string}>} found
 */
function collect(node, location, path, depth, found) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;

  if (Array.isArray(node)) {
    node.forEach((item, index) => collect(item, location, `${path}[${index}]`, depth + 1, found));
    return;
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    const childPath = path ? `${path}.${key}` : key;
    const kind = TENANT_KEYS[normalizeKey(key)];

    if (kind && !isEmpty(value)) {
      if (Array.isArray(value)) {
        /* `?school_id[]=1&school_id[]=2` — every element has to clear the same bar. */
        value.forEach((item, index) => {
          if (!isEmpty(item)) {
            found.push({ kind, value: item, location, path: `${childPath}[${index}]` });
          }
        });
      } else {
        found.push({ kind, value, location, path: childPath });
      }
      /* Fall through: a tenant key whose value is an object still gets walked below. */
    }

    if (value && typeof value === 'object') {
      collect(value, location, childPath, depth + 1, found);
    }
  }
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    /* A malformed escape is not a valid id either way; compare the raw text. */
    return segment;
  }
}

/**
 * Collect tenant references carried by the URL path.
 *
 * A segment following `schools`, `organizations` or `orgs` is treated as that tenant's id when it is
 * a digit string. Non-numeric segments are left alone deliberately: `/schools/export` and
 * `/schools/current` are sub-routes, not ids, and refusing them would break legitimate paths. Those
 * shapes are covered by the `param()` guards, which see the resolved parameter rather than guessing
 * from position.
 *
 * @param {string} url  `req.originalUrl` — the full path, independent of how deep the router is mounted
 * @param {Array<{kind: string, value: any, location: string, path: string}>} found
 */
function collectFromPath(url, found) {
  const pathname = String(url || '').split('?')[0];
  const segments = pathname.split('/').filter(Boolean);

  for (let index = 0; index < segments.length - 1; index += 1) {
    const kind = PATH_COLLECTIONS[decodeSegment(segments[index]).toLowerCase()];
    if (!kind) continue;

    const value = decodeSegment(segments[index + 1]);
    if (!NUMERIC_ID.test(value)) continue;

    found.push({
      kind,
      value,
      location: 'path',
      /* The position, not the value — `field` names where the id was, and the response echoes it. */
      path: `${segments[index]}/:id`,
    });
  }
}

/**
 * Refuse the request and leave a trail.
 *
 * Written to the security log here rather than only in the activity log, because an activity-log
 * insert can fail and this is the one event that must not be lost. `req.tenantViolation` is picked
 * up by `activityLog`, which records it as `access_denied` (SRS §26 activity actions).
 */
function refuse(req, reference, reason) {
  const detail = {
    requestId: req.id,
    userId: req.user ? req.user.id : null,
    roleSlug: req.tenant ? req.tenant.roleSlug : null,
    tenantSchoolId: req.tenant ? req.tenant.schoolId : null,
    tenantOrganizationId: req.tenant ? req.tenant.organizationId : null,
    method: req.method,
    path: req.originalUrl,
    attempted: { kind: reference.kind, value: reference.value },
    location: reference.location,
    field: reference.path,
    reason,
  };

  logger.warn('Cross-tenant access denied', detail);
  req.tenantViolation = detail;

  /*
   * The response says what was refused but not what exists. It does not reveal whether the school
   * id is real, whose it is, or how many there are — a 403 that distinguishes "not yours" from
   * "does not exist" is an enumeration oracle.
   */
  return ApiError.forbidden('You do not have access to the requested school or organization.', {
    code: 'CROSS_TENANT_ACCESS_DENIED',
    details: { field: reference.path, location: reference.location },
  });
}

/**
 * Compare one reference against the caller's scope.
 *
 * @returns {Promise<ApiError|null>} the refusal, or null when the reference is acceptable
 */
async function checkReference(req, reference) {
  const { tenant } = req;
  const { kind, value } = reference;

  /*
   * A tenant column must be a scalar. An object here means either a nested operator
   * (`?school_id[gt]=5`) or a malformed client — neither is something to silently accept on the
   * field that defines the isolation boundary.
   */
  if (typeof value === 'object') {
    return ApiError.badRequest('A school or organization reference must be a single value.', {
      code: 'INVALID_TENANT_REFERENCE',
      details: { field: reference.path, location: reference.location },
    });
  }

  /* Super Admin operates across tenants by role — FR-SADMIN-001's platform-wide metrics need it. */
  if (tenant.isPlatform) return null;

  if (kind === 'organization') {
    if (String(value) !== String(tenant.organizationId)) {
      return refuse(req, reference, 'organization_id does not match the caller scope');
    }
    return null;
  }

  /* kind === 'school' */

  if (tenant.schoolId) {
    if (String(value) !== String(tenant.schoolId)) {
      return refuse(req, reference, 'school_id does not match the caller scope');
    }
    return null;
  }

  /*
   * An organization-scoped caller with no school of their own may name any school inside their
   * organization. The membership question needs the database, which is why `tenantService` caches
   * it — an Organization Admin editing a class list would otherwise pay a query per reference.
   */
  if (tenant.organizationId) {
    const inside = await tenantService.schoolBelongsToOrganization(value, tenant.organizationId);
    if (!inside) {
      return refuse(req, reference, 'school_id is outside the caller organization');
    }
    return null;
  }

  /*
   * Neither platform, nor a school, nor an organization. `resolveTenant` refuses this case already;
   * repeating the refusal here means a future change that loosens layer 2 cannot silently open
   * layer 3.
   */
  return refuse(req, reference, 'caller has no resolved tenant scope');
}

/**
 * Reject any request whose payload names a school or organization outside the caller's scope.
 *
 * @type {import('express').RequestHandler}
 */
const enforceTenant = asyncHandler(async (req, res, next) => {
  if (!req.tenant) {
    logger.error('enforceTenant ran without a resolved tenant', {
      requestId: req.id,
      path: req.originalUrl,
    });
    throw ApiError.internal();
  }

  /** @type {Array<{kind: string, value: any, location: string, path: string}>} */
  const references = [];
  collectFromPath(req.originalUrl, references);
  collect(req.params, 'params', '', 0, references);
  collect(req.query, 'query', '', 0, references);
  collect(req.body, 'body', '', 0, references);

  if (!references.length) return next();

  for (const reference of references) {
    /* Sequential on purpose: the first refusal ends the request, so later lookups are wasted work
     * and, on a large hostile payload, a way to make one request issue many queries. */
    // eslint-disable-next-line no-await-in-loop
    const refusal = await checkReference(req, reference);
    if (refusal) throw refusal;
  }

  return next();
});

/**
 * Register `router.param()` tenant guards on a router.
 *
 * Fires at route dispatch, when `req.params` is populated — the point the global middleware cannot
 * reach. Called by `createRouter()` so every module router carries it by construction; Express 4
 * does not propagate `param()` callbacks into nested routers, so it has to be applied per router.
 *
 * @param {import('express').Router} router
 * @returns {import('express').Router} the same router, for chaining
 */
function installTenantParamGuards(router) {
  for (const name of TENANT_PARAM_NAMES) {
    const kind = TENANT_KEYS[normalizeKey(name)];
    if (!kind) continue;

    router.param(
      name,
      asyncHandler(async (req, res, next, value) => {
        if (isEmpty(value)) return next();

        if (!req.tenant) {
          logger.error('Tenant param guard ran without a resolved tenant', {
            requestId: req.id,
            path: req.originalUrl,
            param: name,
          });
          throw ApiError.internal();
        }

        const refusal = await checkReference(req, {
          kind,
          value,
          location: 'params',
          path: name,
        });
        if (refusal) throw refusal;

        return next();
      })
    );
  }

  return router;
}

module.exports = {
  enforceTenant,
  installTenantParamGuards,
  TENANT_KEYS,
  TENANT_PARAM_NAMES,
  PATH_COLLECTIONS,
  MAX_DEPTH,
  collect,
  collectFromPath,
};
