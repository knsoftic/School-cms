'use strict';

/**
 * Subscription gating — SRS §11 (Modules, Features, Limits), §12 (Lifecycle), FR-SUB-008,
 * §30 Rule 1 (No Hard-Coded Subscription Logic).
 *
 * Declarative guards, listed on the route beside the permission guards:
 *
 *   router.get('/',
 *     requireModule(MODULES.STUDENTS),
 *     requirePermission('students.view'),
 *     listStudents);
 *
 *   router.post('/',
 *     requireModule(MODULES.STUDENTS),
 *     requirePermission('students.manage'),
 *     enforceLimit(LIMITS.STUDENT_LIMIT),
 *     createStudent);
 *
 * Every answer comes from `entitlementService`, which reads rows. No guard here compares a plan name
 * or code — Rule 1's "Incorrect concept: if plan == premium" is impossible to write against this API,
 * because a plan's identity is not exposed to it.
 *
 * ## Two refusals, not one
 *
 * "Your plan does not include Online Exams" and "your subscription expired" are different problems
 * with different remedies, so they get different statuses and codes:
 *
 *   402 SUBSCRIPTION_INACTIVE   the subscription is not in a usable state (SRS §12) — pay/renew
 *   403 MODULE_NOT_SUBSCRIBED   the plan does not include the module (SRS §11.1) — upgrade
 *   403 FEATURE_NOT_SUBSCRIBED  the plan does not include the feature (SRS §11)
 *   403 PLAN_LIMIT_EXCEEDED     a Fixed limit is reached (SRS §11.2, FR-SUB-008) — add-on or upgrade
 *
 * Collapsing them into one status would send a school with an unpaid invoice to the plan-comparison
 * page and a school that outgrew its plan to the billing page.
 *
 * ## Why the Super Admin is exempt
 *
 * A platform-scoped caller passes every gate. The Super Admin is not a subscriber — they own the
 * plans (FR-SUB-001…009) and the subscriptions (FR-SUB-010), and gating them on a school's plan would
 * lock them out of exactly the school whose lapsed subscription needs fixing. The same reasoning
 * exempts them in `resolveTenant` for suspended tenants.
 *
 * ## Which school is being gated
 *
 * Entitlement is per school — `subscriptions.school_id` — so a guard needs a school. A school-scoped
 * caller supplies it implicitly. An organization-scoped caller (Organization Admin, no school of
 * their own) supplies it in the request, and by the time these guards run `enforceTenant` has already
 * proved that school is inside their organization, so the reference can be trusted here. Naming two
 * different schools in one request is refused rather than resolved to the first, because the two may
 * be on different plans and gating on one of them would be arbitrary.
 *
 * ## Ordering on the route
 *
 * `requireModule` before `requirePermission`: a school whose plan omits Library should be told the
 * module is not subscribed, not that their librarian lacks permission for a feature they do not have.
 * `enforceLimit` last, because it is the only one of the three that queries usage — no reason to count
 * students for a caller who was going to be refused anyway.
 */

const { annotate } = require('../utils/routeMeta');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('./asyncHandler');
const logger = require('../config/logger');
const entitlementService = require('../services/entitlementService');
const usageService = require('../services/usageService');
const { collect, collectFromPath } = require('./enforceTenant');
const { MODULE_LABELS, LIMIT_LABELS } = require('../config/constants');

/** Shared precondition: these guards compare against `req.tenant`, so layer 2 must have run. */
function assertTenantResolved(req, guard) {
  if (!req.tenant) {
    logger.error(`${guard} ran without a resolved tenant`, {
      requestId: req.id,
      path: req.originalUrl,
    });
    throw ApiError.internal();
  }
}

/**
 * Which school this request's entitlement should be resolved against.
 *
 * @param {import('express').Request} req
 * @returns {number} the school id
 * @throws {ApiError} 400 when an organization-scoped caller names no school, or names two
 */
function resolveGatedSchoolId(req) {
  if (req.tenant.schoolId) return Number(req.tenant.schoolId);

  /** @type {Array<{kind: string, value: any}>} */
  const references = [];
  collect(req.params, 'params', '', 0, references);
  collectFromPath(req.originalUrl, references);
  collect(req.query, 'query', '', 0, references);
  collect(req.body, 'body', '', 0, references);

  const schoolIds = new Set(
    references
      .filter((reference) => reference.kind === 'school' && typeof reference.value !== 'object')
      .map((reference) => String(reference.value))
  );

  if (schoolIds.size === 0) {
    throw ApiError.badRequest(
      'This endpoint is scoped to a single school. Include the school it applies to.',
      { code: 'SCHOOL_CONTEXT_REQUIRED' }
    );
  }

  if (schoolIds.size > 1) {
    /*
     * Two schools in one request can be on two different plans, so there is no single entitlement to
     * check. Refusing is the only answer that cannot be wrong.
     */
    throw ApiError.badRequest(
      'This endpoint applies to one school at a time. Send a separate request for each school.',
      { code: 'MULTIPLE_SCHOOL_CONTEXT' }
    );
  }

  return Number([...schoolIds][0]);
}

/**
 * The entitlement snapshot for this request, resolved once and reused.
 *
 * Several guards can appear on one route (`requireModule` + `enforceLimit`), and each would otherwise
 * repeat the lookup. The snapshot is already cached in `entitlementService`, so this saves a cache
 * round-trip rather than six queries — but it also guarantees every guard on a route judges the same
 * snapshot, which matters if a TTL lapses mid-request.
 *
 * @param {import('express').Request} req
 * @returns {Promise<import('../services/entitlementService').EntitlementSnapshot>}
 */
async function loadSnapshot(req) {
  if (req.entitlement) return req.entitlement;
  const schoolId = resolveGatedSchoolId(req);
  req.entitlement = await entitlementService.getSnapshot(schoolId);

  /*
   * The school the gate judged becomes the school the request is about.
   *
   * Without this line the entitlement gate and the data scope read the *same request* through two
   * different parsers and can disagree. `resolveGatedSchoolId` above reads the raw request through
   * `collect()`, whose `normalizeKey` lowercases and strips separators — so `?schoolId=`, `?school-id=`
   * and `?SCHOOL_ID=` all name a school. A module's own list query reads `req.query.school_id` *after*
   * `validate()` has run with `stripUnknown: true`, and every list schema declares only the snake_case
   * key — so every other spelling is silently deleted before the service sees it.
   *
   * For a caller who has no school of their own — an Organization Admin — `tenantWhere()` then
   * contributes only `organization_id`, and the query answers across the whole organization while the
   * gate had approved exactly one school. Measured against the live database, `?schoolId=<A>` returned
   * school B's rows on **all six** module-gated routes an Organization Admin can reach — teachers,
   * students, staff, attendance, fees and finance — including from a school whose plan excludes the
   * module outright and would have answered 403 to the canonical spelling. That is an entitlement
   * bypass, not merely a wide read: §30 Rule 1 requires the plan to decide, and here it did not.
   *
   * Narrowing `req.tenant` is the fix that cannot be forgotten by the next module. `tenantWhere()`
   * gives an explicit school precedence over an organization, so this narrows the request to the one
   * school already approved and can never widen it — the same mechanism, and the same reasoning,
   * `resolveTenant` documents where it honours a school on an organization-scoped account.
   *
   * Who this actually affects, precisely — because the three scopes reach here differently:
   *
   *  - **Organization-scoped callers**: the case the bypass was found on, and the only one this line
   *    changes. `enforceTenant` has already checked the named school against their organization, reading
   *    the request through that same liberal `collect()` and so seeing the aliases too, which is why
   *    narrowing to it is always inside the scope they already had.
   *  - **School-scoped callers**: unaffected. `resolveGatedSchoolId` returns their own school at its
   *    first line, and the assignment below is a no-op because `req.tenant.schoolId` is already set.
   *  - **Platform callers**: never arrive. Every guard in this file short-circuits on
   *    `req.tenant.isPlatform` before calling this function, so no snapshot is loaded and no narrowing
   *    happens. A Super Admin's named school is honoured further down instead, by `resolveSchool()` in
   *    the module's own service — which is exactly why the matching `!isPlatform` exclusion in those
   *    services had to be removed at the same time (§5a session 18, the second half of the same defect).
   */
  if (!req.tenant.schoolId) req.tenant.schoolId = schoolId;

  return req.entitlement;
}

/** Human label for a module key, for the refusal message. */
function moduleLabel(key) {
  return MODULE_LABELS[key] || key;
}

/**
 * Refuse when the subscription is not in a usable state — SRS §12.
 *
 * Exported alongside the guards because `upload.js` is an entitlement gate of its own and has to make
 * the same judgement before it will accept a byte.
 *
 * @param {import('express').Request} req
 * @param {import('../services/entitlementService').EntitlementSnapshot} snapshot
 */
function assertSubscriptionUsable(req, snapshot) {
  if (!snapshot.subscription) {
    throw ApiError.subscriptionInactive('This school does not have an active subscription.', {
      state: null,
      schoolId: snapshot.schoolId,
    });
  }

  if (!snapshot.subscription.isUsable) {
    /*
     * The state is named. SRS §12 makes the ten states meaningful to the school — "grace_period" and
     * "cancelled" call for different actions — and hiding which one applies would leave the frontend
     * unable to say anything useful.
     */
    throw ApiError.subscriptionInactive(
      'This school’s subscription is not active. Renew it to continue.',
      { state: snapshot.subscription.state, schoolId: snapshot.schoolId }
    );
  }
}

/**
 * Require an active subscription, with no module or feature condition.
 *
 * For routes that need a subscription but are not part of any one module — a billing screen, a usage
 * report, the school's own subscription page.
 *
 * @returns {import('express').RequestHandler}
 */
function requireActiveSubscription() {
  return asyncHandler(async (req, res, next) => {
    assertTenantResolved(req, 'requireActiveSubscription');
    if (req.tenant.isPlatform) return next();

    const snapshot = await loadSnapshot(req);
    assertSubscriptionUsable(req, snapshot);
    return next();
  });
}

/**
 * Build a module guard.
 *
 * @param {string[]} keys
 * @param {'all'|'any'} mode
 * @param {string} guardName
 */
function buildModuleGuard(keys, mode, guardName) {
  const required = keys.flat();

  if (!required.length) {
    throw new Error(`${guardName}() requires at least one module key`);
  }

  /* Boot-time, on the same reasoning as `requirePermission` — a typo would deny everyone forever. */
  entitlementService.assertKnownModuleKeys(required, guardName);

  const documented = asyncHandler(async (req, res, next) => {
    assertTenantResolved(req, guardName);
    if (req.tenant.isPlatform) return next();

    const snapshot = await loadSnapshot(req);

    /* State first: an expired subscription is a different problem from an unsubscribed module. */
    assertSubscriptionUsable(req, snapshot);

    const missing = required.filter((key) => snapshot.modules[key] !== true);
    const satisfied = mode === 'all' ? missing.length === 0 : missing.length < required.length;

    if (!satisfied) {
      const named = (mode === 'all' ? missing : required).map(moduleLabel);
      throw ApiError.moduleNotSubscribed(
        `Your subscription does not include ${named.join(', ')}.`,
        mode === 'all'
          ? { required, missing, planId: snapshot.plan ? snapshot.plan.id : null }
          : { requiredAnyOf: required, planId: snapshot.plan ? snapshot.plan.id : null }
      );
    }

    return next();
  });

  /* The module keys this guard was built from. See utils/routeMeta.js. */
  return annotate(documented, { modules: required, moduleMode: mode });
}

/**
 * Require every listed module — SRS §11.1.
 *
 * @param {...string} keys  module keys from `constants.MODULES`
 * @returns {import('express').RequestHandler}
 */
function requireModule(...keys) {
  return buildModuleGuard(keys, 'all', 'requireModule');
}

/**
 * Require at least one of the listed modules.
 *
 * The case this exists for: a route that serves two modules and should stay reachable if either is
 * subscribed — a combined timetable/homework calendar, for instance.
 *
 * @param {...string} keys
 * @returns {import('express').RequestHandler}
 */
function requireAnyModule(...keys) {
  return buildModuleGuard(keys, 'any', 'requireAnyModule');
}

/**
 * Require a plan feature — SRS §11, FR-SUB-007.
 *
 * Feature keys are validated for shape only, not against a list. SRS §11 requires features to be
 * configurable per plan but never enumerates them, so no authoritative list exists to check against —
 * see `entitlementService.assertValidFeatureKeys`.
 *
 * @param {...string} keys  `plan_features.feature_key` values
 * @returns {import('express').RequestHandler}
 */
function requireFeature(...keys) {
  const required = keys.flat();

  if (!required.length) {
    throw new Error('requireFeature() requires at least one feature key');
  }

  entitlementService.assertValidFeatureKeys(required, 'requireFeature');

  return asyncHandler(async (req, res, next) => {
    assertTenantResolved(req, 'requireFeature');
    if (req.tenant.isPlatform) return next();

    const snapshot = await loadSnapshot(req);
    assertSubscriptionUsable(req, snapshot);

    const missing = required.filter((key) => {
      const feature = snapshot.features[key];
      return !feature || !feature.enabled;
    });

    if (missing.length) {
      throw new ApiError(403, 'Your subscription does not include this feature.', {
        code: 'FEATURE_NOT_SUBSCRIBED',
        details: { required, missing, planId: snapshot.plan ? snapshot.plan.id : null },
      });
    }

    return next();
  });
}

/**
 * Resolve how many units this request is about to consume.
 *
 * @param {number|((req: import('express').Request) => number)} increment
 * @param {import('express').Request} req
 * @param {string} limitKey
 * @returns {number}
 */
function resolveIncrement(increment, req, limitKey) {
  const value = typeof increment === 'function' ? increment(req) : increment;
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    /*
     * A bad increment must not silently become 1 — that would let a bulk create of unknown size past
     * a limit one unit at a time. It is a programming error in the route, so it is a 500.
     */
    logger.error('enforceLimit received a non-numeric increment', {
      requestId: req.id,
      path: req.originalUrl,
      limitKey,
      increment: value,
    });
    throw ApiError.internal();
  }

  return number;
}

/**
 * Refuse a request that would exceed a Fixed limit — SRS §11.2, FR-SUB-008.
 *
 * Checked *before* the action, so a create that would breach the cap never happens rather than being
 * rolled back. The result of the check is left on `req.limitChecks[limitKey]` so the handler can act
 * on it — recording consumption after a successful write, or noting that the request was permitted as
 * billable overage (SRS §33).
 *
 * `enforceLimit` does not itself record usage. Consumption is recorded by the handler after the write
 * succeeds, because a limit check that incremented a counter would charge a school for an action that
 * failed validation two middlewares later.
 *
 * @param {string} limitKey  a key from `constants.LIMITS`, or an add-on-only allowance
 * @param {object} [options]
 * @param {number|((req: import('express').Request) => number)} [options.increment]
 *        units the request consumes; a number, or a function of the request for bulk endpoints
 *        (`{ increment: (req) => req.body.students.length }`). Defaults to 1.
 * @returns {import('express').RequestHandler}
 */
function enforceLimit(limitKey, options = {}) {
  entitlementService.assertKnownLimitKeys([limitKey], 'enforceLimit');

  const increment = options.increment === undefined ? 1 : options.increment;

  if (typeof increment !== 'function' && !Number.isFinite(Number(increment))) {
    throw new Error(
      `enforceLimit('${limitKey}'): options.increment must be a number or a function of the request`
    );
  }

  const documented = asyncHandler(async (req, res, next) => {
    assertTenantResolved(req, 'enforceLimit');
    if (req.tenant.isPlatform) return next();

    const snapshot = await loadSnapshot(req);
    assertSubscriptionUsable(req, snapshot);

    const units = resolveIncrement(increment, req, limitKey);
    const result = await usageService.assertWithinLimit(snapshot.schoolId, limitKey, units);

    if (!req.limitChecks) req.limitChecks = {};
    req.limitChecks[limitKey] = result;

    if (result.reason === 'overage') {
      /* Permitted and billable. Logged because it becomes an invoice line the school will query. */
      logger.info('Request permitted as billable overage', {
        requestId: req.id,
        schoolId: snapshot.schoolId,
        limitKey,
        label: LIMIT_LABELS[limitKey] || limitKey,
        used: result.used,
        limit: result.limit,
        requested: result.requested,
        overage: result.wouldOverage,
      });
    }

    return next();
  });

  /* The limit key this guard was built from. See utils/routeMeta.js. */
  return annotate(documented, { limit: limitKey });
}

/**
 * Attach `req.entitlement` without gating on anything.
 *
 * For routes that vary their *response* by entitlement rather than refusing — a dashboard that hides
 * unsubscribed modules, or the school's own subscription page. A platform-scoped caller gets no
 * snapshot attached, because no single school is in scope.
 *
 * @returns {import('express').RequestHandler}
 */
function attachEntitlement() {
  return asyncHandler(async (req, res, next) => {
    assertTenantResolved(req, 'attachEntitlement');
    if (req.tenant.isPlatform) return next();

    /*
     * A missing school context is not an error here — the route did not ask to be gated. It simply
     * gets no snapshot, and the handler decides what that means.
     */
    try {
      await loadSnapshot(req);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 400) return next();
      throw err;
    }

    return next();
  });
}

module.exports = {
  requireActiveSubscription,
  requireModule,
  requireAnyModule,
  requireFeature,
  enforceLimit,
  attachEntitlement,
  resolveGatedSchoolId,
  loadSnapshot,
  assertTenantResolved,
  assertSubscriptionUsable,
};
