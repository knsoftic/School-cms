'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *
 *   RATE_LIMIT_MAX       raised past what this script sends. `apiLimiter` is mounted globally and this
 *   AUTH_RATE_LIMIT_MAX  run makes several hundred calls; the limiter's own behaviour is verified in
 *                        scripts/verify-middlewares.js and is not what is under test here.
 *   BCRYPT_ROUNDS=10     four fixture hashes. 10 keeps the run short; the shipped default is 12.
 *   PASSWORD_MIN_LENGTH  pinned so nothing here depends on the local .env.
 *   MAIL_DRIVER=log      nothing in this module sends mail, but a stray SMTP attempt would hang the run.
 *   CACHE_TTL=600        load-bearing, and in the same direction as verify-plans.js: every entitlement
 *                        snapshot read below is taken *after* a write, so a stale answer can only come
 *                        from a missing `invalidateSchool()`. A short TTL would let a forgotten
 *                        invalidation pass by expiry instead of by design. The same applies to
 *                        `tenantService.getSchool()`, which caches `schools.subscription_state` — the one
 *                        column this module owns and no other writes.
 */
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.BCRYPT_ROUNDS = '10';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';
process.env.CACHE_TTL = '600';

/**
 * Verification of the subscriptions module — `src/modules/subscriptions/*`.
 *
 * Covers SRS §12 (the lifecycle: states, trial, grace, upgrade, downgrade, renewal), §33 (feature
 * overrides, custom limits, custom pricing) and the purchase half of §11.3 — FR-SUB-009 through
 * FR-SUB-015 — plus §30 Rule 1, which is why every entitlement assertion below reads a resolved
 * snapshot rather than a plan code.
 *
 * ## What is asserted, and why each part exists
 *
 *  - **Part 1 — the schemas, directly.** The twenty-seven derived columns this module refuses to accept,
 *    each with the message naming where its value actually comes from. `stripUnknown: true` would have
 *    dropped all twenty-seven *silently*, and `state` is the one that matters most: a `POST /subscriptions
 *    { state: 'active' }` that returned 201 with a trial would look like it worked and would have written
 *    no `subscription_history` row for the activation that never happened. Also the four shapes of a §33
 *    override, and `downgrade.timing` being required rather than defaulted.
 *
 *  - **Part 2 — the route table, by name.** Nineteen routes in declaration order, `/catalogue` ahead of
 *    `/:id`, and the three guard shapes distributed exactly as the SRS actor lines require: ten routes
 *    carry `platformGuard`, nine do not. The permission guards are `asyncHandler`-wrapped and anonymous,
 *    so they are asserted in part 4 from their own 403 bodies.
 *
 *  - **Part 3 — the service and the arithmetic, directly.** `prorate()` is a pure function and §12.3's
 *    figures are the only record of what a school was credited, so the exact numbers are asserted here
 *    where every input is controlled, and part 4 asserts only that the wiring reaches them. Also the
 *    whole `TRANSITIONS` table (every `from` and `to` is a real state, every `event` a storable one, and
 *    no transition lists its own target as a legal origin), `computeCycleAmount()` across all five §10.4
 *    pricing models, and `standing()`'s aggregation.
 *
 *  - **Part 4 — over real HTTP, against the real database.** The whole §12 lifecycle end to end, both
 *    cache invalidations, the tenant boundary, the audit and history trails, and `runLifecycleSweep()`
 *    driven directly because it deliberately has no route.
 *
 * ## The assertions worth reading before changing anything
 *
 *  - **The purchase copy is asserted by value, not by existence.** `subscription_addons` receives
 *    `effect_type`, `effect_target` and `units_granted` at purchase time, and `units_granted` is
 *    `quantity × addons.units_per_quantity` — `entitlementService.js` reads it as already multiplied and
 *    says so. So the seeded `extra_students` add-on has its block size raised from 1 to 50, three are
 *    bought, and the row is asserted to carry exactly 150. A null or an unmultiplied 3 there would leave
 *    the purchase looking successful while granting nothing, because resolution does
 *    `if (granted <= 0) continue`. No other suite would catch it: the add-ons suite asserts the catalogue,
 *    not the sale.
 *
 *  - **An override replaces the plan's base; add-on units survive it.** The school's plan grants 100
 *    students, an add-on adds 150, and a §33 custom limit of 1000 is then applied. The resolved limit is
 *    **1150**, not 1000 and not 250: `baseValue` moves, `addonUnits` does not, and `source` becomes
 *    `override`. This is the one interaction in the entitlement chain with three inputs, and it is
 *    asserted in both directions — the revoke puts it back to 250.
 *
 *  - **`governingStateFor()` and the entitlement snapshot agree, on the same school, four times.**
 *    `subscriptions.service.js` duplicates `entitlementService`'s private
 *    `findGoverningSubscription()` rather than importing it, and its comment names this suite as the
 *    only guard on the duplication. So the two are compared after the create, after an activation, after
 *    a cancellation, and after a second subscription is opened on a cancelled school — that last case
 *    being the one where "most recent" and "usable" disagree.
 *
 *  - **Both caches, and only when they should move.** Every write invalidates the entitlement snapshot,
 *    and with `CACHE_TTL=600` in force every snapshot below is read *after* a write — so a stale answer
 *    can only come from a missing `invalidateSchool()`, never from an expiry that happened to save it.
 *    The deferred downgrade is the case that proves the other direction: it writes `scheduled_plan_id`
 *    and nothing else, and the school is asserted to still resolve to Pro, at 650 students, with
 *    `getSchool()` still reporting `active`. A scheduled change that leaked into entitlement would give
 *    away capability the school has already paid for until the end of the cycle.
 *
 *  - **A school can upgrade itself and cannot cancel itself.** FR-SUB-013/014/015 name the School as an
 *    actor and FR-SUB-010 does not, so `POST /:id/upgrade` accepts a Principal and `POST /:id/cancel`
 *    refuses one with `PLATFORM_SCOPE_REQUIRED`. Both halves are asserted, because the asymmetry reads
 *    like an oversight and is not.
 *
 *  - **`requireAnyPermission` reports `requiredAnyOf`, not `missing`.** The 403 bodies are read for the
 *    key they actually carry. An assertion written against `details.missing` would compare `undefined`
 *    to `undefined` and pass whatever the guard did — the same class of unfalsifiable check that
 *    `verify-addons.js` records against `details.errors`.
 *
 *  - **`runLifecycleSweep()` is driven directly, and its five passes are asserted in order.** Five
 *    subscriptions on five schools are positioned so that each pass claims exactly one: a lapsed trial,
 *    an automatic renewal, a manual lapse into grace, a grace period that has run out, and a period
 *    ending inside the notice window. The renewal is asserted *not* to be marked past due, which is the
 *    whole reason pass 2 runs before pass 3. The sweep's history rows are asserted to carry
 *    `performed_by: null` and `metadata.sweep`, read as model instances — under `raw: true` MariaDB
 *    returns JSON columns as strings and `metadata.sweep` would silently be `undefined`.
 *
 * ## Fixtures
 *
 * Four users under `@verify-subs.local` (a platform Super Admin, a Principal on the subject school, an
 * Organization Admin, and a second Principal on another school for the tenant check), one organization,
 * six schools, and four plans created through `/plans` rather than by hand so the fixture path is one the
 * plans suite already verifies. `VSB-DRAFT` is deliberately never activated, so `PLAN_NOT_AVAILABLE` is
 * asserted against a real inactive plan.
 *
 * Two *seeded* things are mutated and restored:
 *
 *   1. **`addons.units_per_quantity` on `extra_students`**, raised from 1 to 50 so that
 *      `quantity × units_per_quantity` is distinguishable from either factor alone. Restored by column.
 *   2. **`addon_prices`**, which the seeders leave empty — three rows are created here. Restored by
 *      deleting anything above the captured baseline rather than by emptying the table.
 *
 * No seeded *role* is mutated, and that absence is asserted rather than assumed: `principal` already
 * holds `subscriptions.self.view` and `subscriptions.self.manage`, which is the argument
 * `subscriptions.routes.js` makes for pairing them into `requireAnyPermission` — a key granted to two
 * roles and reachable by none would be a dead permission.
 *
 * All restores run unconditionally in a `finally`, so an abort mid-run still leaves the database as it
 * found it.
 *
 * `logger.warn` / `logger.error` lines during the run are expected: every deliberate 401, 403, 404, 409
 * and 422 logs, and so does each refusal the sweep is asked to survive.
 *
 * Run: node scripts/verify-subscriptions.js
 */

const db = require('../src/models');
const { sweepResidue, readJournal, writeJournal, clearJournal } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const entitlementService = require('../src/services/entitlementService');
const tenantService = require('../src/services/tenantService');
const subscriptionsService = require('../src/modules/subscriptions/subscriptions.service');
const money = require('../src/utils/money');
const { settle, settleDistinct } = require('./lib/settle');
const {
  ROLES,
  USER_STATUS,
  BILLING_CYCLES,
  PRICING_MODELS,
  PLAN_VISIBILITY,
  LIMIT_TYPES,
  LIMIT_UNITS,
  LIMIT_LABELS,
  LIMIT_LIST,
  USAGE_LIMIT_KEYS,
  SUBSCRIPTION_STATES,
  SUBSCRIPTION_STATE_LIST,
  SUBSCRIPTION_USABLE_STATES,
  SUBSCRIPTION_EVENTS,
  TRIAL_DURATION_DAYS,
  GRACE_PERIOD_DAYS,
  DOWNGRADE_TIMING,
  RENEWAL_MODES,
  OVERRIDE_TYPES,
  PRICE_OVERRIDE_TARGETS,
} = require('../src/config/constants');
const { DEFAULT_ROLE_PERMISSIONS } = require('../src/config/permissions');

const subscriptionRoutes = require('../src/modules/subscriptions/subscriptions.routes');
const {
  schemas,
  refused,
  EVENT_LIST,
  OVERRIDE_TYPE_LIST,
  PRICE_TARGETS,
} = require('../src/modules/subscriptions/subscriptions.validation');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-subs.local';
/** The journal this suite writes its seeded-row capture to — see scripts/lib/residue.js. */
const JOURNAL = 'verify-subscriptions';
const PASSWORD = 'Verify@Subs123';

const DAY = 24 * 3600 * 1000;

let failures = 0;

/*
 * This run's request tag — module scope, because BOTH the request helper and `teardown()` need
 * it and they live in different functions. Declared inside `verifyHttp()` first, which made the
 * teardown throw a ReferenceError, skip entirely, and leave every row behind: the residue this
 * change exists to remove got larger, and a later assertion failed on the rows left over.
 */
const REQUEST_TAG = 'vfy-subscriptions';
let requestSeq = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${
      ok ? '' : `  (expected ${JSON.stringify(expected)})`
    }`
  );
}

function run(schema, value) {
  const { error, value: cleaned } = schema.validate(value, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });
  return { ok: !error, value: cleaned, messages: error ? error.details.map((d) => d.message) : [] };
}

/** Whole minutes between two instants, so a millisecond of clock drift cannot fail an assertion. */
const minutesBetween = (from, to) =>
  Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000);

/* ═══════════════════════════ part 1 — the schemas ═══════════════════════════ */

function verifySchemas() {
  console.log('\n--- schemas: what a caller may and may not name ---');

  /*
   * The derived columns. Twenty-seven of them, and the count is asserted rather than left implicit: the
   * whole point of `forbiddenField()` over `stripUnknown` is that a key removed from this set becomes
   * silently writable, and nothing else in the suite would notice.
   */
  check(
    'the validation module refuses twenty-seven derived columns by name',
    Object.keys(refused).length,
    27
  );

  const stateRefusal = run(schemas.create, { school_id: 1, plan_id: 2, state: 'active' });
  check('POST / refuses "state" rather than stripping it', stateRefusal.ok, false);
  check(
    'and the message names the routes that do set it',
    stateRefusal.messages.length === 1 &&
      stateRefusal.messages[0].includes('lifecycle routes') &&
      stateRefusal.messages[0].includes('FR-SUB-010'),
    true
  );

  /*
   * A representative column from each group. All twenty-seven share one `forbiddenField()` shape, so
   * this is a sample of the mechanism rather than an enumeration — the count above covers the set.
   */
  check(
    'the pricing, period, scheduled-change, balance and stamp columns are all refused on create',
    [
      'cycle_amount',
      'current_period_end',
      'scheduled_plan_id',
      'credit_balance',
      'expiry_notified_at',
      'renewal_count',
    ].filter((field) => run(schemas.create, { school_id: 1, plan_id: 2, [field]: 1 }).ok),
    []
  );

  check('POST / requires both a school and a plan', run(schemas.create, {}).messages, [
    '"school_id" is required',
    '"plan_id" is required',
  ]);

  /*
   * `trial_days: 0` has to survive as a value. `create()` reads `payload.trial_days !== undefined` to
   * decide whether to inherit the plan's length, so a schema that dropped a zero would silently give a
   * subscription meant to start Pending a trial instead.
   */
  check(
    'trial_days: 0 is kept, not dropped — it is how a caller declines the plan’s trial',
    run(schemas.create, { school_id: 1, plan_id: 2, trial_days: 0 }).value.trial_days,
    0
  );

  check('PATCH /:id accepts the four configurable fields and metadata', [
    run(schemas.update, {
      trial_days: 7,
      grace_period_days: 3,
      renewal_mode: RENEWAL_MODES.AUTOMATIC,
      quantity: 4,
      metadata: { negotiated: true },
    }).ok,
    run(schemas.update, {}).messages[0],
  ], [true, 'Provide at least one field to update']);

  check(
    'PATCH /:id sends a plan change to the upgrade and downgrade routes',
    run(schemas.update, { plan_id: 3 }).messages,
    ['"plan_id" changes only through POST /:id/upgrade (FR-SUB-013) or POST /:id/downgrade (FR-SUB-014)']
  );
  check(
    'and refuses to move a subscription between schools',
    run(schemas.update, { school_id: 3 }).ok,
    false
  );

  /* §12.4's timing is required on a downgrade, and absent from upgrade entirely. */
  const noTiming = run(schemas.downgrade, { plan_id: 3 });
  check('POST /:id/downgrade requires a §12.4 timing', noTiming.ok, false);
  check(
    'and the message says why the choice is not defaulted',
    noTiming.messages[0].includes('SRS §12.4') &&
      noTiming.messages[0].includes('when the school loses capability'),
    true
  );
  check(
    'both §12.4 timings are accepted',
    [DOWNGRADE_TIMING.IMMEDIATE, DOWNGRADE_TIMING.NEXT_BILLING_CYCLE].filter(
      (timing) => !run(schemas.downgrade, { plan_id: 3, timing }).ok
    ),
    []
  );
  check(
    'POST /:id/upgrade has no timing at all — FR-SUB-013 offers none',
    run(schemas.upgrade, { plan_id: 3, timing: DOWNGRADE_TIMING.IMMEDIATE }).value,
    { plan_id: 3 }
  );

  /* The purchase copy: the four columns the service computes, refused with their sources named. */
  const purchaseRefusals = run(schemas.purchaseAddon, {
    addon_id: 15,
    effect_type: 'limit_increase',
    effect_target: 'student_limit',
    units_granted: 500,
    unit_amount: 1,
    status: 'active',
    currency: 'USD',
  });
  check('POST /:id/addons refuses all six copied columns', purchaseRefusals.messages.length, 6);
  check(
    'and "units_granted" says it is quantity × units_per_quantity',
    purchaseRefusals.messages.some(
      (message) =>
        message.includes('units_granted') && message.includes('quantity × addons.units_per_quantity')
    ),
    true
  );
  check(
    'quantity defaults to one',
    run(schemas.purchaseAddon, { addon_id: 15 }).value.quantity,
    1
  );

  /* §33 — the four override shapes. */
  check(
    'a module override must name one of the twenty §11.1 modules and carry is_enabled',
    [
      run(schemas.createOverride, { override_type: 'module', target_key: 'library', is_enabled: false }).ok,
      run(schemas.createOverride, { override_type: 'module', target_key: 'library' }).ok,
      run(schemas.createOverride, { override_type: 'module', target_key: 'nope', is_enabled: true }).ok,
    ],
    [true, false, false]
  );
  check(
    'a limit override needs a limit_type, and a value only when it is fixed',
    [
      run(schemas.createOverride, {
        override_type: 'limit',
        target_key: 'student_limit',
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: 1000,
      }).ok,
      run(schemas.createOverride, {
        override_type: 'limit',
        target_key: 'student_limit',
        limit_value: 1000,
      }).ok,
      run(schemas.createOverride, {
        override_type: 'limit',
        target_key: 'sms_limit',
        limit_type: LIMIT_TYPES.UNLIMITED,
      }).ok,
      run(schemas.createOverride, {
        override_type: 'limit',
        target_key: 'sms_limit',
        limit_type: LIMIT_TYPES.UNLIMITED,
        limit_value: 5,
      }).ok,
    ],
    [true, false, true, false]
  );
  /*
   * `sms_limit` above is deliberate: it is the add-on-only allowance, in `USAGE_LIMIT_KEYS` but not in
   * `LIMIT_LIST`, so an override schema validating against the narrower list would refuse a limit a
   * school can legitimately have negotiated.
   */
  check(
    'a limit override may name sms_limit — the add-on-only allowance is in USAGE_LIMIT_KEYS',
    USAGE_LIMIT_KEYS.includes('sms_limit'),
    true
  );
  check(
    'a price override must target cycle_amount and carry an amount',
    [
      run(schemas.createOverride, { override_type: 'price', target_key: 'cycle_amount', amount: 25 }).ok,
      run(schemas.createOverride, { override_type: 'price', target_key: 'cycle_amount' }).ok,
      run(schemas.createOverride, { override_type: 'price', target_key: 'setup_fee', amount: 5 }).ok,
    ],
    [true, false, false]
  );
  check(
    'is_enabled belongs to module and feature overrides, amount to price overrides, and neither crosses',
    [
      run(schemas.createOverride, {
        override_type: 'limit',
        target_key: 'student_limit',
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: 10,
        is_enabled: true,
      }).ok,
      run(schemas.createOverride, {
        override_type: 'module',
        target_key: 'library',
        is_enabled: true,
        amount: 5,
      }).ok,
    ],
    [false, false]
  );
  check(
    'an inverted effective window is refused before it reaches the database',
    run(schemas.createOverride, {
      override_type: 'module',
      target_key: 'library',
      is_enabled: true,
      effective_from: '2026-06-01T00:00:00Z',
      effective_until: '2026-05-01T00:00:00Z',
    }).messages,
    ['"effective_until" must be on or after "effective_from"']
  );
  check(
    'is_active is set by the revoke route, not by the body',
    run(schemas.createOverride, {
      override_type: 'module',
      target_key: 'library',
      is_enabled: true,
      is_active: false,
    }).ok,
    false
  );

  /* The two vocabularies the schemas publish have to match the columns that store them. */
  check(
    'EVENT_LIST is exactly the subscription_history.event ENUM',
    EVENT_LIST.slice().sort(),
    db.SubscriptionHistory.rawAttributes.event.values.slice().sort()
  );
  check(
    'and every event the service can write is in it',
    Object.values(SUBSCRIPTION_EVENTS).filter((event) => !EVENT_LIST.includes(event)),
    []
  );
  check(
    'OVERRIDE_TYPE_LIST is exactly the subscription_overrides.override_type ENUM',
    OVERRIDE_TYPE_LIST.slice().sort(),
    db.SubscriptionOverride.rawAttributes.override_type.values.slice().sort()
  );
  check('a price override has exactly one target', PRICE_TARGETS, ['cycle_amount']);

  check(
    'the list filter accepts every §12 state and refuses anything else',
    [
      SUBSCRIPTION_STATE_LIST.filter((state) => !run(schemas.list, { state }).ok),
      run(schemas.list, { state: 'lapsed' }).ok,
    ],
    [[], false]
  );
  check(
    'expiring_within_days accepts zero — "already ended" is a question worth asking',
    run(schemas.list, { expiring_within_days: 0 }).value.expiring_within_days,
    0
  );
  check(
    'the history filter is confined to the twenty storable events',
    [run(schemas.history, { event: 'downgrade_scheduled' }).ok, run(schemas.history, { event: 'refunded' }).ok],
    [true, false]
  );
}

/* ═══════════════════════ part 2 — the declared route table ═══════════════════════ */

function stackOf(router, method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer ? layer.route.stack.map((s) => s.handle) : null;
}

/** Routes declared by a router, in declaration order. */
function routesOf(router) {
  return router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
}

/** Is a named guard on this route? Only works for guards that are not asyncHandler-wrapped. */
function named(router, method, path, fnName) {
  const stack = stackOf(router, method, path);
  return stack ? stack.some((fn) => fn.name === fnName) : null;
}

/** The ten routes whose SRS actor line names the Super Admin alone. */
const PLATFORM_ONLY = [
  ['post', '/'],
  ['patch', '/:id'],
  ['post', '/:id/activate'],
  ['post', '/:id/suspend'],
  ['post', '/:id/reactivate'],
  ['post', '/:id/pause'],
  ['post', '/:id/resume'],
  ['post', '/:id/cancel'],
  ['post', '/:id/overrides'],
  ['post', '/:id/overrides/:overrideId/revoke'],
];

/** The five whose actor line names the School as well, and are therefore reachable by one. */
const SCHOOL_REACHABLE_WRITES = [
  ['post', '/:id/upgrade'],
  ['post', '/:id/downgrade'],
  ['post', '/:id/renew'],
  ['post', '/:id/addons'],
  ['post', '/:id/addons/:addonId/cancel'],
];

const READS = [
  ['get', '/catalogue'],
  ['get', '/'],
  ['get', '/:id'],
  ['get', '/:id/history'],
];

function verifyRouting() {
  console.log('\n--- routing: the declared surface ---');

  const declared = routesOf(subscriptionRoutes);

  check('the subscriptions module declares nineteen routes, in this order', declared, [
    'GET /catalogue',
    'GET /',
    'POST /',
    'GET /:id',
    'GET /:id/history',
    'PATCH /:id',
    'POST /:id/activate',
    'POST /:id/suspend',
    'POST /:id/reactivate',
    'POST /:id/pause',
    'POST /:id/resume',
    'POST /:id/cancel',
    'POST /:id/upgrade',
    'POST /:id/downgrade',
    'POST /:id/renew',
    'POST /:id/addons',
    'POST /:id/addons/:addonId/cancel',
    'POST /:id/overrides',
    'POST /:id/overrides/:overrideId/revoke',
  ]);

  /*
   * The one ordering hazard in the file. Both are one-segment GETs, so reversed, Express would match
   * `/catalogue` against `/:id` and the request would fail validation as a non-numeric id.
   */
  check(
    'GET /catalogue is declared before GET /:id, or it would never be reached',
    declared.indexOf('GET /catalogue') < declared.indexOf('GET /:id'),
    true
  );

  /*
   * The two deliberate absences. §12's terminal states keep the row — it is the school's billing
   * history and §13's invoices will point at it — and the sweep's actor is the system, so exposing it
   * over HTTP would be inventing an endpoint the SRS does not describe.
   */
  check(
    'there is no DELETE — POST /:id/cancel is §12’s removal operation',
    declared.some((route) => route.startsWith('DELETE')),
    false
  );
  check(
    'and no route reaches the lifecycle sweep: its actor is the system, and the cron is Phase 5',
    declared.filter((route) => /renewal|sweep|run-/i.test(route)),
    []
  );

  check(
    'ten routes carry requirePlatformScope — the ones whose actor line names the Super Admin alone',
    PLATFORM_ONLY.filter(([method, path]) => !named(subscriptionRoutes, method, path, 'platformGuard')),
    []
  );
  /*
   * The asymmetry that reads like an oversight. FR-SUB-013/014/015 and FR-SUB-009 name the School; the
   * six transitions live under FR-SUB-010, whose actor line is "System / Super Admin" and does not.
   */
  check(
    'and the five whose actor line names the School as well do not',
    SCHOOL_REACHABLE_WRITES.filter(([method, path]) =>
      named(subscriptionRoutes, method, path, 'platformGuard')
    ),
    []
  );
  check(
    'no read carries it either — subscriptions.self.view is seeded to four roles',
    READS.filter(([method, path]) => named(subscriptionRoutes, method, path, 'platformGuard')),
    []
  );

  const WRITES = [...PLATFORM_ONLY, ...SCHOOL_REACHABLE_WRITES];
  check(
    'every write validates its body, so a stray field is refused rather than ignored',
    WRITES.filter(([method, path]) => !named(subscriptionRoutes, method, path, 'validateRequest')),
    []
  );
  check(
    'every write declares an activity row',
    WRITES.filter(([method, path]) => !named(subscriptionRoutes, method, path, 'activityDeclaration')),
    []
  );
  check(
    'and no read does — a read is not an activity worth a row here',
    READS.filter(([method, path]) => named(subscriptionRoutes, method, path, 'activityDeclaration')),
    []
  );
  check(
    'the three reads that take an id or a query validate it; /catalogue takes neither',
    READS.filter(([method, path]) => named(subscriptionRoutes, method, path, 'validateRequest')).map(
      ([, path]) => path
    ),
    ['/', '/:id', '/:id/history']
  );
}

/* ═══════════════════ part 3 — the service and the arithmetic ═══════════════════ */

function verifyTransitionTable() {
  console.log('\n--- the §12 state machine, as data ---');

  const table = subscriptionsService.TRANSITIONS;
  const actions = Object.keys(table);

  check('six administrative transitions, and only six', actions, [
    'activate',
    'suspend',
    'reactivate',
    'pause',
    'resume',
    'cancel',
  ]);

  check(
    'every target state is one of the ten §12 states',
    actions.filter((action) => !SUBSCRIPTION_STATE_LIST.includes(table[action].to)),
    []
  );
  check(
    'every legal origin is too',
    actions.filter((action) =>
      table[action].from.some((state) => !SUBSCRIPTION_STATE_LIST.includes(state))
    ),
    []
  );
  check(
    'every edge has a storable subscription_history event',
    actions.filter((action) => !EVENT_LIST.includes(table[action].event)),
    []
  );
  /*
   * No transition lists its own target as a legal origin. That is what makes
   * `SUBSCRIPTION_STATE_UNCHANGED` reachable rather than decorative: a second click on Suspend is
   * refused by the `from` set, not by a separate equality check that could drift from it.
   */
  check(
    'and no edge accepts the state it moves to as an origin',
    actions.filter((action) => table[action].from.includes(table[action].to)),
    []
  );

  check(
    'pause is reachable only from a state the school can actually use',
    table.pause.from.filter((state) => !SUBSCRIPTION_USABLE_STATES.includes(state)),
    []
  );
  check('resume is reachable only from paused', table.resume.from, [SUBSCRIPTION_STATES.PAUSED]);
  check('reactivate is the edge out of the three closed states', table.reactivate.from, [
    SUBSCRIPTION_STATES.SUSPENDED,
    SUBSCRIPTION_STATES.EXPIRED,
    SUBSCRIPTION_STATES.CANCELLED,
  ]);
  check(
    'cancel is reachable from every state except the two that are already terminal',
    SUBSCRIPTION_STATE_LIST.filter((state) => !table.cancel.from.includes(state)),
    [SUBSCRIPTION_STATES.EXPIRED, SUBSCRIPTION_STATES.CANCELLED]
  );

  const cat = subscriptionsService.catalogue();
  check('the catalogue publishes the ten states', cat.states, SUBSCRIPTION_STATE_LIST);
  check('the five usable ones', cat.usableStates, SUBSCRIPTION_USABLE_STATES);
  check(
    'and the eight open ones, which exclude exactly expired and cancelled',
    SUBSCRIPTION_STATE_LIST.filter((state) => !cat.openStates.includes(state)),
    [SUBSCRIPTION_STATES.EXPIRED, SUBSCRIPTION_STATES.CANCELLED]
  );
  check('the §12.1 and §12.2 presets come from the constants', [cat.trialPresetDays, cat.gracePresetDays], [
    TRIAL_DURATION_DAYS,
    GRACE_PERIOD_DAYS,
  ]);
  check('the §12.4 timings and §12.5 modes', [cat.downgradeTimings, cat.renewalModes], [
    Object.values(DOWNGRADE_TIMING),
    Object.values(RENEWAL_MODES),
  ]);
  check('the four §33 override types', cat.overrideTypes, Object.values(OVERRIDE_TYPES));

  /*
   * What an override may target — published because `createOverride`'s schema restricts three of the
   * four types to lists no endpoint exposed, so a screen offering the choice had nowhere to read it
   * from.
   *
   * The limit list is asserted against `USAGE_LIMIT_KEYS` rather than against a written-out set of
   * nine, and the distinction is the whole point of the assertion: `GET /plans/catalogue` publishes
   * `LIMIT_LIST`, which is **eight** — `plan_limits.limit_key` may not hold `sms_limit`. The schema
   * here accepts nine. Publishing the plan catalogue's eight would have made the one override an SMS
   * negotiation needs unofferable, and no assertion comparing a hard-coded list to itself would have
   * noticed.
   */
  check(
    'the override target vocabularies come from the same constants the schema restricts to',
    [cat.limitTargets.map((limit) => limit.key), cat.limitTypes, cat.priceTargets],
    [USAGE_LIMIT_KEYS.slice(), Object.values(LIMIT_TYPES), PRICE_OVERRIDE_TARGETS.slice()]
  );
  check(
    '  and the limit list is the nine, which is one more than the plan catalogue publishes',
    [cat.limitTargets.length, LIMIT_LIST.length, cat.limitTargets.at(-1).key],
    [9, 8, 'sms_limit']
  );
  check(
    '  each carrying the label and unit a screen would otherwise have to invent',
    cat.limitTargets.every(
      (limit) => limit.label === LIMIT_LABELS[limit.key] && limit.unit === LIMIT_UNITS[limit.key]
    ),
    true
  );
  check(
    '  and the price target is the one column a subscription actually carries',
    [cat.priceTargets, Object.keys(db.Subscription.rawAttributes).includes('cycle_amount')],
    [['cycle_amount'], true]
  );
  check(
    'and the transition table, so a screen can disable rather than guess',
    cat.transitions.map((t) => `${t.action}:${t.from.length}->${t.to}`),
    [
      'activate:2->active',
      'suspend:7->suspended',
      'reactivate:3->active',
      'pause:3->paused',
      'resume:1->active',
      'cancel:8->cancelled',
    ]
  );
  check('the expiry notice window is seven days', cat.expiringWindowDays, 7);
  check(
    'and the sortable columns are the ones a subscriptions screen offers',
    subscriptionsService.SORTABLE.slice(),
    [
      'id',
      'state',
      'starts_at',
      'current_period_end',
      'next_renewal_at',
      'cycle_amount',
      'created_at',
      'updated_at',
    ]
  );
}

function verifyPricing() {
  console.log('\n--- §10.4 pricing models, and §12.3 proration ---');

  const fixed = {
    id: 9,
    billing_cycle: BILLING_CYCLES.CUSTOM_DAYS,
    cycle_days: 30,
    pricing_model: PRICING_MODELS.FIXED,
    currency: 'USD',
    base_amount: 30,
    unit_amount: 2,
    included_units: 10,
  };

  check(
    'a fixed price ignores quantity entirely',
    [
      subscriptionsService.computeCycleAmount(fixed, 1),
      subscriptionsService.computeCycleAmount(fixed, 500),
    ],
    [30, 30]
  );
  check(
    'a custom price is whatever was negotiated, and nothing is derived from it',
    subscriptionsService.computeCycleAmount(
      { ...fixed, pricing_model: PRICING_MODELS.CUSTOM, custom_amount: 777.5 },
      500
    ),
    777.5
  );
  check(
    'the three per-unit models charge base + unit × (quantity − included_units)',
    [PRICING_MODELS.PER_STUDENT, PRICING_MODELS.STUDENT_BASED, PRICING_MODELS.SEAT_BASED].map(
      (pricing_model) =>
        subscriptionsService.computeCycleAmount({ ...fixed, pricing_model }, 100)
    ),
    [210, 210, 210]
  );
  check(
    'and never below the base: a quantity inside the included allowance is not a discount',
    subscriptionsService.computeCycleAmount(
      { ...fixed, pricing_model: PRICING_MODELS.PER_STUDENT },
      4
    ),
    30
  );

  check(
    'a subscription copies exactly seven columns from its price row, and joins none of them',
    subscriptionsService.pricingColumns(fixed, 3),
    {
      plan_price_id: 9,
      billing_cycle: BILLING_CYCLES.CUSTOM_DAYS,
      cycle_days: 30,
      pricing_model: PRICING_MODELS.FIXED,
      currency: 'USD',
      cycle_amount: 30,
      quantity: 3,
    }
  );

  /*
   * §12.3, on a fabricated row. `prorate()` is pure, so every input is controlled here and the exact
   * figures are asserted — part 4 then only has to show that the request path reaches them. A
   * `custom_days` cycle of thirty is used throughout so `billingCycleDays()` returns thirty exactly;
   * a monthly cycle would return 28–31 and the expectation would have to be re-derived from the same
   * function under test.
   */
  const at = new Date('2026-03-16T00:00:00Z');
  const halfway = {
    billing_cycle: BILLING_CYCLES.CUSTOM_DAYS,
    cycle_days: 30,
    current_period_start: new Date('2026-03-01T00:00:00Z'),
    cycle_amount: 30,
    credit_balance: 0,
  };

  check(
    'an upgrade halfway through a 30-day cycle: half the old plan credited, half the new one due',
    subscriptionsService.prorate(halfway, 60, at),
    {
      periodDays: 30,
      elapsedDays: 15,
      remainingDays: 15,
      unusedCredit: 15,
      prorationDue: 30,
      creditApplied: 15,
      amountDue: 15,
      creditBalance: 0,
    }
  );
  check(
    'an existing credit balance is spent first, and the remainder stays on the account',
    subscriptionsService.prorate({ ...halfway, credit_balance: 20 }, 60, at),
    {
      periodDays: 30,
      elapsedDays: 15,
      remainingDays: 15,
      unusedCredit: 15,
      prorationDue: 30,
      creditApplied: 30,
      amountDue: 0,
      creditBalance: 5,
    }
  );
  check(
    'a downgrade owes nothing and leaves the difference as credit, never as a negative charge',
    subscriptionsService.prorate({ ...halfway, cycle_amount: 60 }, 30, at),
    {
      periodDays: 30,
      elapsedDays: 15,
      remainingDays: 15,
      unusedCredit: 30,
      prorationDue: 15,
      creditApplied: 15,
      amountDue: 0,
      creditBalance: 15,
    }
  );
  check(
    'a one_time subscription has no period to prorate, and its credit is left untouched',
    subscriptionsService.prorate(
      { ...halfway, billing_cycle: BILLING_CYCLES.ONE_TIME, cycle_days: null, credit_balance: 12 },
      60,
      at
    ),
    {
      periodDays: 0,
      elapsedDays: 0,
      remainingDays: 0,
      unusedCredit: 0,
      prorationDue: 0,
      creditApplied: 0,
      amountDue: 0,
      creditBalance: 12,
    }
  );
  check(
    'an overrun period clamps to zero remaining rather than crediting backwards',
    subscriptionsService.prorate(
      { ...halfway, current_period_start: new Date('2026-01-01T00:00:00Z'), credit_balance: 8 },
      60,
      at
    ),
    {
      periodDays: 30,
      elapsedDays: 30,
      remainingDays: 0,
      unusedCredit: 0,
      prorationDue: 0,
      creditApplied: 0,
      amountDue: 0,
      creditBalance: 8,
    }
  );

  /*
   * A new price on another recurring cycle. Its amount pays for a period of its own length, so the
   * remainder is priced at its daily rate: 60 per 10 days is 6 a day, for 15 days, 90. Multiplying by
   * the old period's fraction instead gave 30 — a third of the service for the price.
   */
  check(
    'moving onto another cycle prices the remaining days at the new price’s own daily rate',
    subscriptionsService.prorate(halfway, 60, at, { billing_cycle: BILLING_CYCLES.CUSTOM_DAYS, cycle_days: 10 }),
    {
      periodDays: 30,
      elapsedDays: 15,
      remainingDays: 15,
      unusedCredit: 15,
      prorationDue: 90,
      creditApplied: 15,
      amountDue: 75,
      creditBalance: 0,
    }
  );
  check(
    'and naming a price on the same cycle changes nothing',
    subscriptionsService.prorate(halfway, 60, at, { billing_cycle: BILLING_CYCLES.CUSTOM_DAYS, cycle_days: 30 }),
    subscriptionsService.prorate(halfway, 60, at)
  );
}

function verifyDerived() {
  console.log('\n--- derived views: standing() and isEffective() ---');

  const now = Date.now();
  const past = new Date(now - DAY);
  const future = new Date(now + DAY);

  check(
    'an override is in force when it is active and inside its window, and not otherwise',
    [
      subscriptionsService.isEffective({ is_active: true }),
      subscriptionsService.isEffective({ is_active: false }),
      subscriptionsService.isEffective({ is_active: true, effective_from: past }),
      subscriptionsService.isEffective({ is_active: true, effective_from: future }),
      subscriptionsService.isEffective({ is_active: true, effective_until: future }),
      subscriptionsService.isEffective({ is_active: true, effective_until: past }),
    ],
    [true, false, true, false, true, false]
  );

  /*
   * `grantedUnits` sums the *active* limit-increase purchases per target. The cancelled row carrying
   * 999 is the assertion that matters: `cancelAddon()` sets `status`, it does not delete, so a sum
   * that ignored status would keep reporting an allowance the school no longer holds.
   */
  const standing = subscriptionsService.standing({
    state: SUBSCRIPTION_STATES.ACTIVE,
    billing_cycle: BILLING_CYCLES.CUSTOM_DAYS,
    current_period_end: null,
    trial_ends_at: null,
    grace_period_ends_at: null,
    scheduled_plan_id: 4,
    credit_balance: 7.5,
    addons: [
      { status: 'active', effect_type: 'limit_increase', effect_target: 'student_limit', units_granted: 50 },
      { status: 'active', effect_type: 'limit_increase', effect_target: 'student_limit', units_granted: 100 },
      { status: 'cancelled', effect_type: 'limit_increase', effect_target: 'student_limit', units_granted: 999 },
      { status: 'active', effect_type: 'feature_unlock', effect_target: 'premium_reports', units_granted: 0 },
    ],
    overrides: [{ is_active: true }, { is_active: false }, { is_active: true, effective_until: past }],
  });

  check('standing() reports what the stored state implies, and never recomputes it', {
    isUsable: standing.isUsable,
    isOpen: standing.isOpen,
    inTrial: standing.inTrial,
    isRecurring: standing.isRecurring,
    hasScheduledChange: standing.hasScheduledChange,
    activeAddonCount: standing.activeAddonCount,
    effectiveOverrideCount: standing.effectiveOverrideCount,
    creditBalance: standing.creditBalance,
  }, {
    isUsable: true,
    isOpen: true,
    inTrial: false,
    isRecurring: true,
    hasScheduledChange: true,
    activeAddonCount: 3,
    effectiveOverrideCount: 1,
    creditBalance: 7.5,
  });
  check(
    'and grantedUnits sums the active purchases per target, labelled with the limit’s unit',
    standing.grantedUnits,
    { student_limit: { units: 150, unit: LIMIT_UNITS.student_limit } }
  );
  check(
    'a one_time subscription is not "renewable but overdue" — it is not recurring',
    subscriptionsService.standing({
      state: SUBSCRIPTION_STATES.ACTIVE,
      billing_cycle: BILLING_CYCLES.ONE_TIME,
      credit_balance: 0,
    }).isRecurring,
    false
  );
}

/* ═══════════════════════════════ fixtures ═══════════════════════════════ */

const fixtures = {};
const seeded = {};
const baseline = {};
const created = {
  users: [],
  schools: [],
  organizations: [],
  subscriptions: [],
};

/** The columns of the one seeded add-on this run edits, captured so the edit can be undone. */
const ADDON_COLUMNS = ['units_per_quantity', 'description', 'display_order', 'is_active'];

async function captureBaseline() {
  baseline.activityLog = (await db.ActivityLog.max('id')) || 0;
  baseline.auditLog = (await db.AuditLog.max('id')) || 0;
  baseline.addonPrice = (await db.AddonPrice.max('id')) || 0;
  baseline.addonPriceCount = await db.AddonPrice.count();

  seeded.addons = await db.Addon.findAll({ raw: true, order: [['id', 'ASC']] });

  /*
   * The sweep reads across every tenant, so a subscription this run did not create would land in one
   * of its five passes and make the report counts wrong. Captured here and asserted to be zero before
   * the sweep runs, so a leftover row from an aborted run fails loudly instead of skewing a count.
   */
  baseline.subscriptionCount = await db.Subscription.count();

  return seeded.addons.length;
}

async function createFixtures() {
  const roles = {};
  for (const slug of [ROLES.SUPER_ADMIN, ROLES.PRINCIPAL, ROLES.ORGANIZATION_ADMIN]) {
    roles[slug] = await db.Role.findOne({ where: { slug } });
    if (!roles[slug]) throw new Error(`The ${slug} role is missing — run the seeders first.`);
  }
  fixtures.roles = roles;

  const org = await db.Organization.create({ name: 'Verify Subs Group', code: 'VSB-GROUP' });
  created.organizations.push(org.id);
  fixtures.org = org;

  /* The subject school, plus one per sweep pass — a school may hold only one open subscription. */
  const schoolNames = [
    ['school', 'Verify Subs School', 'VSB-S1'],
    ['sweepTrial', 'Verify Subs Sweep Trial', 'VSB-W1'],
    ['sweepAuto', 'Verify Subs Sweep Auto', 'VSB-W2'],
    ['sweepLapse', 'Verify Subs Sweep Lapse', 'VSB-W3'],
    ['sweepGrace', 'Verify Subs Sweep Grace', 'VSB-W4'],
    ['sweepNotice', 'Verify Subs Sweep Notice', 'VSB-W5'],
  ];
  for (const [key, name, code] of schoolNames) {
    fixtures[key] = await db.School.create({ organization_id: org.id, name, code });
    created.schools.push(fixtures[key].id);
  }

  const password_hash = await hashPassword(PASSWORD);

  const people = [
    ['platform', ROLES.SUPER_ADMIN, 'Verify Subs Platform Admin', 'vsb_platform', null, null],
    ['principal', ROLES.PRINCIPAL, 'Verify Subs Principal', 'vsb_principal', org.id, fixtures.school.id],
    ['orgAdmin', ROLES.ORGANIZATION_ADMIN, 'Verify Subs Org Admin', 'vsb_orgadmin', org.id, null],
    /* On another school of the same organization, so the 404 below is the tenant boundary and not a role. */
    ['principalB', ROLES.PRINCIPAL, 'Verify Subs Principal B', 'vsb_principal_b', org.id, fixtures.sweepTrial.id],
  ];

  for (const [key, slug, name, username, organization_id, school_id] of people) {
    fixtures[key] = await db.User.create({
      role_id: roles[slug].id,
      organization_id,
      school_id,
      name,
      email: `${key}@${DOMAIN}`,
      username,
      password_hash,
      status: USER_STATUS.ACTIVE,
      must_change_password: false,
    });
    created.users.push(fixtures[key].id);
  }

  return created.users.length;
}

async function removeFixtures() {
  /* The rows the run generated, before the records they point at. */
  /*
   * Scoped to this run's own tenant — Known Issues #25. An unbounded delete above `baseline` also
   * removes rows belonging to any suite running concurrently, which is the mechanism behind
   * "a parallel run reports false failures": the victim then reads `[]`, not a partial set.
   *
   * Both tables are ON DELETE CASCADE from `schools` and `organizations`, so this run's rows would
   * be removed anyway when its schools and organization go. This stays explicit as belt-and-braces
   * and to keep the ordering obvious; what matters is that it can no longer reach another run.
   *
   * Rows with neither a school nor an organization — the seeded Super Admin's sign-ins — are left.
   * Every suite authenticates as that same user, so no run can claim them, and they sit below the
   * next run's baseline where no assertion can see them.
   */
  const ownTenant = [
    /* This run's own requests — what the tenant clauses below cannot reach. */
    { request_id: { [db.Op.like]: `${REQUEST_TAG}-%` } },
    ...(Array.isArray(created.schools) && created.schools.length ? [{ school_id: created.schools }] : []),
    ...(Array.isArray(created.organizations) && created.organizations.length
      ? [{ organization_id: created.organizations }] : []),
    /*
     * The run's own users, which catches its PLATFORM-scope rows — sign-ins and super-admin
     * actions have no school and no organization, so the two clauses above never match them and
     * the cascade from `schools`/`organizations` never reaches them either. This clause only works
     * because it runs BEFORE `User.destroy` below: both trail tables are ON DELETE SET NULL from
     * `users`, so afterwards there is no `user_id` left to match.
     */
    ...(Array.isArray(created.users) && created.users.length ? [{ user_id: created.users }] : []),
  ];
  if (ownTenant.length) {
    await db.ActivityLog.destroy({
      where: { id: { [db.Op.gt]: baseline.activityLog }, [db.Op.or]: ownTenant },
    });
    await db.AuditLog.destroy({
      where: { id: { [db.Op.gt]: baseline.auditLog }, [db.Op.or]: ownTenant },
    });
  }

  if (created.schools.length) {
    /*
     * By school rather than by captured id: the run creates subscriptions over HTTP, by hand for the
     * sweep, and one more after a cancellation, and a list that missed any of them would leave a row
     * pointing at a deleted school.
     */
    const where = { school_id: created.schools };
    await db.SubscriptionHistory.destroy({ where });
    await db.SubscriptionOverride.destroy({ where });
    await db.SubscriptionAddon.destroy({ where });
    await db.SubscriptionItem.destroy({ where });
    await db.Subscription.destroy({ where });
  }

  /*
   * The add-on prices this run created. Deleted above the captured high-water mark rather than by
   * emptying the table: `subscription_addons.addon_price_id` is `SET NULL`, so a blanket destroy would
   * silently blank the price pointer on any purchase row another suite's fixtures left behind.
   */
  await db.AddonPrice.destroy({ where: { id: { [db.Op.gt]: baseline.addonPrice } } });

  /* The seeded add-on this run edits, put back column by column. */
  if (seeded.addons) {
    for (const row of seeded.addons) {
      await db.Addon.update(
        ADDON_COLUMNS.reduce((acc, column) => ({ ...acc, [column]: row[column] }), {}),
        { where: { id: row.id } }
      );
    }
  }

  /* The plans the run created through /plans. `force: true` because subscription_plans is paranoid. */
  await db.SubscriptionPlan.destroy({
    where: { code: { [db.Op.like]: 'VSB-%' } },
    force: true,
    paranoid: false,
  });

  if (created.users.length) await db.User.destroy({ where: { id: created.users }, force: true });
  if (created.schools.length) {
    await db.School.destroy({ where: { id: created.schools }, force: true });
  }
  if (created.organizations.length) {
    await db.Organization.destroy({ where: { id: created.organizations }, force: true });
  }

  await entitlementService.invalidateAll();
  await tenantService.invalidateAll();
  /* The seeded add-on and the price table are back, so the journal is no longer owed. */
  clearJournal(JOURNAL);
}

/**
 * Recover from a run killed before its `finally`, which this suite needs more than most: both of its
 * restores are defined **relative to a capture taken at the start**, and a dead run poisons both.
 * `addon_prices` is cleaned by deleting everything above a high-water mark — so after a killed run the
 * next run's mark sits *above* the dead run's prices, and they are never deleted. And `extra_students`
 * is restored column by column from `seeded.addons` — so the next run would capture the dead run's
 * `units_per_quantity = 50` as the seeded value. The journal holds the mark and the columns from before
 * either was touched; see `scripts/lib/residue.js`.
 */
async function recoverFromDeadRun() {
  const pending = readJournal(JOURNAL);
  if (pending) {
    await db.AddonPrice.destroy({ where: { id: { [db.Op.gt]: pending.addonPrice } } });
    for (const row of pending.addons) {
      // eslint-disable-next-line no-await-in-loop
      await db.Addon.update(
        ADDON_COLUMNS.reduce((acc, column) => ({ ...acc, [column]: row[column] }), {}),
        { where: { id: row.id } }
      );
    }
    clearJournal(JOURNAL);
    console.log('(restored the seeded add-ons and price table a killed earlier run left mutated)');
  }
  const residueCleared = await sweepResidue(db, { codes: ['VSB-'], domains: [DOMAIN] });
  if (residueCleared) {
    console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
  }
}

/* ═══════════════════════════ part 4 — over HTTP ═══════════════════════════ */

async function verifyHttp() {
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  /*
   * Every request is tagged so this run's trail rows can be told from another run's — the last half
   * of Known Issues #25, which recorded a run id as impossible for want of somewhere to put one.
   * `requestContext.js:24` honours an inbound `X-Request-Id` matching /^[A-Za-z0-9._~-]{8,64}$/ and
   * stores it on both trail tables. The counter is zero-padded to four digits because of that lower
   * bound: a shorter tag is silently replaced with a nanoid, and the tagging would appear to work
   * while tagging nothing.
   */
  async function call(path, { method = 'GET', body, token } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Request-Id': `${REQUEST_TAG}-${String(++requestSeq).padStart(4, '0')}`,
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* left null — an assertion on `body` names the problem more clearly than a throw here */
    }

    return { status: res.status, body: parsed, raw: text };
  }

  async function signIn(identifier, password = PASSWORD) {
    const res = await call('/auth/login', { method: 'POST', body: { identifier, password } });
    return res.body && res.body.data ? res.body.data.accessToken : null;
  }

  /** The error code an envelope carries, or the status when it is not an error envelope. */
  const codeOf = (res) => (res.body && res.body.error ? res.body.error.code : `no-error:${res.status}`);
  const dataOf = (res) => (res.body && res.body.data !== undefined ? res.body.data : null);
  const detailsOf = (res) => (res.body && res.body.error ? res.body.error.details || null : null);
  /*
   * `ApiError.validation` puts the flat array from `validate.js` straight on `error.details` — the
   * per-field records are `{ field, location, message, type }`, not `{ errors: [...] }`.
   */
  const messagesOf = (res) =>
    res.body && res.body.error && Array.isArray(res.body.error.details)
      ? res.body.error.details.map((detail) => detail.message)
      : [];

  /** The subscription out of any of the fourteen envelopes that carry one. */
  const subOf = (res) => (dataOf(res) ? dataOf(res).subscription : null);

  /*
   * A snapshot straight from the service, not from a route. §30 Rule 1 says entitlement is resolved
   * from the database, and this is what every guarded route in every other module will read — so the
   * assertions below read it rather than trusting a `standing` block this module computed itself.
   */
  const snapshotOf = (schoolId) => entitlementService.getSnapshot(schoolId);

  try {
    console.log('\n--- the boundary, and who may read a subscription ---');

    const anonymous = await call('/subscriptions');
    check('an unauthenticated read is refused', anonymous.status, 401);
    check('with the code for a missing bearer token', codeOf(anonymous), 'TOKEN_MISSING');

    const platform = await signIn(`platform@${DOMAIN}`);
    const principal = await signIn(`principal@${DOMAIN}`);
    const orgAdmin = await signIn(`orgAdmin@${DOMAIN}`);
    const principalB = await signIn(`principalB@${DOMAIN}`);
    check(
      'all four fixture users sign in',
      [platform, principal, orgAdmin, principalB].map((token) => typeof token),
      ['string', 'string', 'string', 'string']
    );

    /*
     * The seeded grants, asserted rather than assumed — and no role is mutated by this suite. The
     * pairing in `subscriptions.routes.js` (`view` OR `self.view`) only makes sense if the `self.*`
     * keys are actually held by a school-scoped role, and a permission granted to a role but named
     * by no route would be dead. This is the check that keeps both halves honest.
     */
    const grantsOf = (role) => DEFAULT_ROLE_PERMISSIONS[role].filter((key) => key.startsWith('subscriptions.'));
    check(
      'the Super Admin holds all six subscription permissions',
      grantsOf(ROLES.SUPER_ADMIN).slice().sort(),
      [
        'subscriptions.lifecycle',
        'subscriptions.manage',
        'subscriptions.overrides.manage',
        'subscriptions.self.manage',
        'subscriptions.self.view',
        'subscriptions.view',
      ]
    );
    check(
      'a Principal holds the two self keys and neither platform key',
      grantsOf(ROLES.PRINCIPAL).slice().sort(),
      ['subscriptions.self.manage', 'subscriptions.self.view']
    );
    check(
      'and an Organization Admin may read but not manage — which is what makes it the 403 fixture',
      grantsOf(ROLES.ORGANIZATION_ADMIN).slice().sort(),
      ['subscriptions.self.view', 'subscriptions.view']
    );

    const cat = await call('/subscriptions/catalogue', { token: principal });
    check('a school-scoped caller may read the §12 vocabulary', cat.status, 200);
    check(
      'and it is the service catalogue, unmodified',
      Object.keys(dataOf(cat)).sort(),
      Object.keys(subscriptionsService.catalogue()).sort()
    );

    /* ─────────────────────────── fixture plans and add-on prices ─────────────────────────── */

    console.log('\n--- fixtures built through /plans and /addons ---');

    const planIds = {};
    async function makePlan(key, body, price, limitValue, modules) {
      const res = await call('/plans', { method: 'POST', body, token: platform });
      if (res.status !== 201) throw new Error(`fixture plan ${key} failed: ${res.raw}`);
      const id = dataOf(res).plan.id;
      planIds[key] = id;

      /*
       * `custom_days` / 30 throughout. A `monthly` cycle is 28–31 days depending on the month, so
       * every proration and period assertion below would have to be re-derived from
       * `dates.billingCycleDays()` — the same function under test. Thirty fixed days makes the
       * expected figures constants.
       */
      const prices = await call(`/plans/${id}/prices`, {
        method: 'PUT',
        token: platform,
        body: {
          prices: [
            {
              billing_cycle: BILLING_CYCLES.CUSTOM_DAYS,
              cycle_days: 30,
              pricing_model: PRICING_MODELS.FIXED,
              currency: 'USD',
              base_amount: price,
              is_default: true,
            },
          ],
        },
      });
      if (prices.status !== 200) throw new Error(`fixture price for ${key} failed: ${prices.raw}`);

      /*
       * All eight §11.2 keys, because `plans.validation.setLimits` refuses a partial set — an omitted
       * limit resolves to zero rather than to "leave it alone". Only `student_limit` is read below; the
       * other seven are `unlimited` so nothing here depends on a figure it does not assert.
       *
       * Both of these are checked rather than fired and forgotten. The first draft of this helper sent
       * one limit, took a 422, and carried on — every plan-base assertion in the run then read 0 from
       * `emptyLimits()` and looked like an entitlement bug.
       */
      const limits = await call(`/plans/${id}/limits`, {
        method: 'PUT',
        token: platform,
        body: {
          limits: LIMIT_LIST.map((limit_key) =>
            limit_key === 'student_limit'
              ? { limit_key, limit_type: LIMIT_TYPES.FIXED, limit_value: limitValue }
              : { limit_key, limit_type: LIMIT_TYPES.UNLIMITED, limit_value: null }
          ),
        },
      });
      if (limits.status !== 200) throw new Error(`fixture limits for ${key} failed: ${limits.raw}`);

      const mods = await call(`/plans/${id}/modules`, {
        method: 'PUT',
        token: platform,
        body: { modules: modules.map((module_key) => ({ module_key, is_enabled: true })) },
      });
      if (mods.status !== 200) throw new Error(`fixture modules for ${key} failed: ${mods.raw}`);

      return id;
    }

    await makePlan(
      'basic',
      {
        name: 'Verify Subs Basic',
        code: 'VSB-BASIC',
        tier_rank: 10,
        trial_days: 7,
        grace_period_days: 3,
        default_renewal_mode: RENEWAL_MODES.MANUAL,
        visibility: PLAN_VISIBILITY.PUBLIC,
      },
      30,
      100,
      ['students', 'teachers']
    );
    await makePlan(
      'pro',
      {
        name: 'Verify Subs Pro',
        code: 'VSB-PRO',
        tier_rank: 20,
        trial_days: 14,
        grace_period_days: 7,
        default_renewal_mode: RENEWAL_MODES.MANUAL,
        visibility: PLAN_VISIBILITY.PUBLIC,
      },
      60,
      500,
      ['students', 'teachers', 'library']
    );
    /* Same tier as Pro, so `SUBSCRIPTION_SAME_TIER` can be provoked with a genuinely different plan. */
    await makePlan(
      'same',
      {
        name: 'Verify Subs Sidegrade',
        code: 'VSB-SAME',
        tier_rank: 20,
        trial_days: 0,
        grace_period_days: 0,
        visibility: PLAN_VISIBILITY.PRIVATE,
      },
      55,
      500,
      ['students', 'teachers', 'library']
    );
    /* Priced, limited, and deliberately left inactive — FR-SUB-004's refusal needs a real plan. */
    await makePlan(
      'draft',
      { name: 'Verify Subs Draft', code: 'VSB-DRAFT', tier_rank: 5, trial_days: 0 },
      10,
      50,
      ['students']
    );

    for (const key of ['basic', 'pro', 'same']) {
      const res = await call(`/plans/${planIds[key]}/activate`, { method: 'POST', token: platform });
      if (res.status !== 200) throw new Error(`activating fixture plan ${key} failed: ${res.raw}`);
    }
    check(
      'three fixture plans are active and VSB-DRAFT is not',
      await db.SubscriptionPlan.count({ where: { code: { [db.Op.like]: 'VSB-%' }, status: 'active' } }),
      3
    );

    /*
     * The seeded `extra_students` add-on grants one student per unit bought. Raised to fifty here so
     * that `quantity × units_per_quantity` produces a number equal to neither factor — the only way
     * an assertion can tell a correct multiplication from a copied `quantity`.
     */
    const extraStudents = await db.Addon.findOne({ where: { key: 'extra_students' } });
    const premiumReports = await db.Addon.findOne({ where: { key: 'premium_reports' } });
    check(
      'the two seeded add-ons this run uses are present, with the effects §11.3 gives them',
      [
        `${extraStudents.effect_type}:${extraStudents.effect_target}`,
        `${premiumReports.effect_type}:${premiumReports.effect_target}`,
      ],
      ['limit_increase:student_limit', 'feature_unlock:premium_reports']
    );

    const blockEdit = await call(`/addons/${extraStudents.id}`, {
      method: 'PATCH',
      token: platform,
      body: { units_per_quantity: 50 },
    });
    check('the add-on block size is editable, and is now fifty', [
      blockEdit.status,
      Number(dataOf(blockEdit).addon.units_per_quantity),
    ], [200, 50]);

    /*
     * Two prices for `extra_students`: one open to any plan, one restricted to VSB-SAME. The
     * restricted row is what `ADDON_PRICE_PLAN_MISMATCH` is asserted against below — FR-SUB-009's
     * *"plan-specific pricing"* is otherwise a column nothing ever refuses.
     */
    const studentPrices = await call(`/addons/${extraStudents.id}/prices`, {
      method: 'PUT',
      token: platform,
      body: {
        prices: [
          { billing_cycle: BILLING_CYCLES.CUSTOM_DAYS, cycle_days: 30, currency: 'USD', unit_amount: 5 },
          { billing_cycle: BILLING_CYCLES.MONTHLY, currency: 'USD', unit_amount: 7, plan_id: planIds.same },
        ],
      },
    });
    const reportPrices = await call(`/addons/${premiumReports.id}/prices`, {
      method: 'PUT',
      token: platform,
      body: {
        prices: [
          { billing_cycle: BILLING_CYCLES.CUSTOM_DAYS, cycle_days: 30, currency: 'USD', unit_amount: 10 },
        ],
      },
    });
    check('three add-on prices are configured', [studentPrices.status, reportPrices.status], [200, 200]);

    /* Read back rather than guessed: `setPrices` may retire and recreate, so the ids are its output. */
    const priceRows = await db.AddonPrice.findAll({ where: { is_active: true }, order: [['id', 'ASC']] });
    const openPrice = priceRows.find(
      (row) => Number(row.addon_id) === Number(extraStudents.id) && row.plan_id === null
    );
    const restrictedPrice = priceRows.find(
      (row) => Number(row.addon_id) === Number(extraStudents.id) && row.plan_id !== null
    );
    const reportPrice = priceRows.find((row) => Number(row.addon_id) === Number(premiumReports.id));
    check(
      'and the open, plan-restricted and feature-unlock prices are all distinguishable',
      [Boolean(openPrice), Boolean(restrictedPrice), Boolean(reportPrice)],
      [true, true, true]
    );

    /* ───────────────────────── FR-SUB-010 — create ───────────────────────── */

    console.log('\n--- FR-SUB-010: creating a subscription ---');

    const asPrincipal = await call('/subscriptions', {
      method: 'POST',
      token: principal,
      body: { school_id: fixtures.school.id, plan_id: planIds.basic },
    });
    check(
      'a Principal cannot subscribe its own school — FR-SUB-010 names the Super Admin',
      [asPrincipal.status, codeOf(asPrincipal)],
      [403, 'PLATFORM_SCOPE_REQUIRED']
    );
    const asOrgAdmin = await call('/subscriptions', {
      method: 'POST',
      token: orgAdmin,
      body: { school_id: fixtures.school.id, plan_id: planIds.basic },
    });
    check(
      'nor can an Organization Admin, whose scope is an organization and not the platform',
      [asOrgAdmin.status, codeOf(asOrgAdmin)],
      [403, 'PLATFORM_SCOPE_REQUIRED']
    );

    const withState = await call('/subscriptions', {
      method: 'POST',
      token: platform,
      body: { school_id: fixtures.school.id, plan_id: planIds.basic, state: 'active' },
    });
    check(
      'a caller cannot name the state it wants — that would skip the history row',
      [withState.status, messagesOf(withState).length],
      [422, 1]
    );

    const noSchool = await call('/subscriptions', {
      method: 'POST',
      token: platform,
      body: { school_id: 99999999, plan_id: planIds.basic },
    });
    check('an unknown school is a 404', [noSchool.status, codeOf(noSchool)], [404, 'SCHOOL_NOT_FOUND']);

    const draftPlan = await call('/subscriptions', {
      method: 'POST',
      token: platform,
      body: { school_id: fixtures.school.id, plan_id: planIds.draft },
    });
    check(
      'an inactive plan is refused: FR-SUB-004 makes status mean "available for new subscriptions"',
      [draftPlan.status, codeOf(draftPlan), detailsOf(draftPlan).status],
      [409, 'PLAN_NOT_AVAILABLE', 'inactive']
    );

    const createdRes = await call('/subscriptions', {
      method: 'POST',
      token: platform,
      body: { school_id: fixtures.school.id, plan_id: planIds.basic, reason: 'Verification fixture' },
    });
    check('the platform admin subscribes the school', createdRes.status, 201);
    const sub = subOf(createdRes);
    created.subscriptions.push(sub.id);

    check(
      'it is born in trial, on the plan’s own trial length, with the plan’s price copied onto the row',
      {
        state: sub.state,
        trial_days: sub.trial_days,
        cycle_amount: money.toNumber(sub.cycle_amount),
        billing_cycle: sub.billing_cycle,
        cycle_days: sub.cycle_days,
        renewal_mode: sub.renewal_mode,
        renewal_count: Number(sub.renewal_count),
        credit_balance: money.toNumber(sub.credit_balance),
      },
      {
        state: SUBSCRIPTION_STATES.TRIAL,
        trial_days: 7,
        cycle_amount: 30,
        billing_cycle: BILLING_CYCLES.CUSTOM_DAYS,
        cycle_days: 30,
        renewal_mode: RENEWAL_MODES.MANUAL,
        renewal_count: 0,
        credit_balance: 0,
      }
    );
    check(
      'the trial ends seven days out and the period thirty, both measured from starts_at',
      [
        minutesBetween(sub.starts_at, sub.trial_ends_at),
        minutesBetween(sub.starts_at, sub.current_period_end),
        minutesBetween(sub.current_period_end, sub.next_renewal_at),
      ],
      [7 * 1440, 30 * 1440, 0]
    );
    check(
      'and the response says which state it landed in, so the operator knows what is next',
      createdRes.body.message,
      'Subscription created. The 7-day trial has started.'
    );

    /*
     * §13's invoice source. One plan line, and no setup-fee line because the fixture price carries
     * none — a second row here would mean `setup_fee` was being billed as zero.
     */
    const items = await db.SubscriptionItem.findAll({
      where: { subscription_id: sub.id },
      order: [['id', 'ASC']],
    });
    check(
      'one subscription_items row is written for the plan line, priced from the plan',
      items.map((item) => `${item.item_type}:${money.toNumber(item.amount)}:${item.is_recurring}`),
      ['plan:30:true']
    );

    const historyRes = await call(`/subscriptions/${sub.id}/history`, { token: platform });
    check(
      'and the history opens with the creation and the trial, newest first',
      dataOf(historyRes).map((row) => `${row.event}:${row.from_state}->${row.to_state}`),
      ['trial_started:null->trial', 'created:null->trial']
    );
    /*
     * `new_amount` records what the subscription now costs; `proration_amount` and `credit_applied`
     * are left *null* rather than zero-filled, because a creation moved no money and a zero there
     * would read as "prorated to nothing" on a ledger §13 will reconcile against.
     */
    check(
      'the ledger records the new amount and leaves the two §12.3 proration columns null',
      dataOf(historyRes).map(
        (row) => `${row.proration_amount}|${row.credit_applied}|${money.toNumber(row.new_amount)}`
      ),
      ['null|null|30', 'null|null|30']
    );
    check(
      'and each row says in words what it was',
      dataOf(historyRes).map((row) => row.notes),
      ['7-day trial (SRS §12.1)', 'Verification fixture']
    );
    check(
      'and paginated reads put the rows at data and the counts at meta.pagination',
      historyRes.body.meta.pagination.total,
      2
    );

    /*
     * Obligation 2, with `CACHE_TTL=600` in force: `schools.subscription_state` is a cached column and
     * `tenantService.getSchool()` is what every request reads. A create that wrote the column but
     * forgot `tenantService.invalidateSchool()` would pass a direct database read and fail here.
     */
    check(
      'schools.subscription_state moves with the subscription, through the tenant cache',
      (await tenantService.getSchool(fixtures.school.id)).subscription_state,
      SUBSCRIPTION_STATES.TRIAL
    );
    check(
      'the module’s own governing-state mirror agrees with what entitlement resolved',
      await subscriptionsService.governingStateFor(fixtures.school.id),
      (await snapshotOf(fixtures.school.id)).subscription.state
    );

    const snap1 = await snapshotOf(fixtures.school.id);
    check(
      'and the resolved snapshot is the plan’s: 100 students, from the plan, with no add-on units',
      {
        limit: snap1.limits.student_limit.value,
        base: snap1.limits.student_limit.baseValue,
        addonUnits: snap1.limits.student_limit.addonUnits,
        source: snap1.limits.student_limit.source,
        students: snap1.modules.students,
        library: snap1.modules.library,
        usable: snap1.subscription.isUsable,
      },
      { limit: 100, base: 100, addonUnits: 0, source: 'plan', students: true, library: false, usable: true }
    );

    const second = await call('/subscriptions', {
      method: 'POST',
      token: platform,
      body: { school_id: fixtures.school.id, plan_id: planIds.pro },
    });
    check(
      'a school holding an open subscription cannot be given a second one',
      [second.status, codeOf(second), detailsOf(second).state],
      [409, 'SCHOOL_ALREADY_SUBSCRIBED', SUBSCRIPTION_STATES.TRIAL]
    );

    /* ───────────────── FR-SUB-011 / FR-SUB-012 — configuration ───────────────── */

    console.log('\n--- FR-SUB-011 / FR-SUB-012: trial and grace configuration ---');

    const emptyPatch = await call(`/subscriptions/${sub.id}`, {
      method: 'PATCH',
      token: platform,
      body: {},
    });
    check(
      'an empty PATCH is refused rather than treated as a no-op write',
      [emptyPatch.status, messagesOf(emptyPatch)],
      [422, ['Provide at least one field to update']]
    );

    const patched = await call(`/subscriptions/${sub.id}`, {
      method: 'PATCH',
      token: platform,
      body: { trial_days: 14, grace_period_days: 7, renewal_mode: RENEWAL_MODES.AUTOMATIC },
    });
    check(
      'extending a running trial moves its end date, measured from trial_starts_at',
      [
        patched.status,
        subOf(patched).trial_days,
        minutesBetween(subOf(patched).trial_starts_at, subOf(patched).trial_ends_at),
        subOf(patched).grace_period_days,
        subOf(patched).renewal_mode,
      ],
      [200, 14, 14 * 1440, 7, RENEWAL_MODES.AUTOMATIC]
    );
    check(
      'and the period boundary is not touched by a trial change',
      minutesBetween(subOf(patched).starts_at, subOf(patched).current_period_end),
      30 * 1440
    );

    /* ─────────────────────── reads, and the tenant boundary ─────────────────────── */

    console.log('\n--- reads: scope, and what a school may not see ---');

    const mine = await call('/subscriptions', { token: principal });
    check(
      'a Principal sees its own school’s subscription and nothing else',
      [mine.status, dataOf(mine).length, Number(dataOf(mine)[0].school_id)],
      [200, 1, fixtures.school.id]
    );
    check(
      'the row carries the derived standing block beside its own columns',
      [dataOf(mine)[0].standing.isUsable, dataOf(mine)[0].standing.inTrial],
      [true, true]
    );

    const crossTenant = await call(`/subscriptions/${sub.id}`, { token: principalB });
    check(
      'another school’s Principal is told "not found", not "forbidden" — the scope is in the where',
      [crossTenant.status, codeOf(crossTenant)],
      [404, 'SUBSCRIPTION_NOT_FOUND']
    );
    const crossHistory = await call(`/subscriptions/${sub.id}/history`, { token: principalB });
    check('and the history 404s before a single history row is read', crossHistory.status, 404);

    const filtered = await call(
      `/subscriptions?state=${SUBSCRIPTION_STATES.SUSPENDED}`,
      { token: platform }
    );
    check(
      'the state filter is applied, not ignored',
      [filtered.status, dataOf(filtered).length],
      [200, 0]
    );

    /* ─────────────────── FR-SUB-010 — pause, resume, activate ─────────────────── */

    console.log('\n--- FR-SUB-010: pause preserves the remaining period ---');

    const badResume = await call(`/subscriptions/${sub.id}/resume`, { method: 'POST', token: platform });
    check(
      'resuming something that is not paused is refused by the transition table itself',
      [badResume.status, codeOf(badResume), detailsOf(badResume).allowedFrom],
      [409, 'SUBSCRIPTION_STATE_INVALID', [SUBSCRIPTION_STATES.PAUSED]]
    );

    const paused = await call(`/subscriptions/${sub.id}/pause`, {
      method: 'POST',
      token: platform,
      body: { reason: 'Fee dispute' },
    });
    check('pausing writes only the state and the stamp', [paused.status, subOf(paused).state], [
      200,
      SUBSCRIPTION_STATES.PAUSED,
    ]);
    check(
      'and a paused school is not usable, which the entitlement snapshot has to reflect',
      (await snapshotOf(fixtures.school.id)).subscription.isUsable,
      false
    );
    check(
      'schools.subscription_state followed it, through the cache',
      (await tenantService.getSchool(fixtures.school.id)).subscription_state,
      SUBSCRIPTION_STATES.PAUSED
    );

    /*
     * Backdated two days so the shift is a known quantity: the remaining period moves forward by
     * exactly the paused duration — including the trial end, or a school paused mid-trial would come
     * back with less trial than it stopped with.
     *
     * **That rule is this module's reading, not the source's, and this comment used to say otherwise.**
     * It attributed *"temporarily inactive"* to §12's Paused and *"resumes where it stopped"* to
     * FR-SUB-010's resume line. Neither phrase is in the SRS: "Paused" appears exactly twice, at
     * SRS:540 and SRS:576, both times as a bare item in a list of ten states, with no definition and
     * no resume behaviour anywhere; the word "resume" does not occur in the document at all. The
     * second phrase is this application's **own** response message
     * (`subscriptions.controller.js:183`), quoted back as though the source had said it.
     *
     * Found by `verify-quotations.js`, which is Known Issues #31 made assertable — these were the
     * fifth and sixth fabricated citations this project has found, and the first two it caught rather
     * than stumbled on. What the source does fix is that Paused is a state a subscription may hold;
     * everything below is the only reading that keeps a pause from costing the school time it paid
     * for, and it is recorded as a decision rather than as a requirement.
     */
    const before = await db.Subscription.findByPk(sub.id);
    const periodEndBefore = before.current_period_end;
    const trialEndBefore = before.trial_ends_at;
    await before.update({ paused_at: new Date(Date.now() - 2 * DAY) });

    const resumed = await call(`/subscriptions/${sub.id}/resume`, { method: 'POST', token: platform });
    check(
      'resuming shifts the period end and the trial end by the paused duration, and clears the stamp',
      [
        resumed.status,
        minutesBetween(periodEndBefore, subOf(resumed).current_period_end),
        minutesBetween(trialEndBefore, subOf(resumed).trial_ends_at),
        minutesBetween(subOf(resumed).current_period_end, subOf(resumed).next_renewal_at),
        subOf(resumed).paused_at,
      ],
      [200, 2 * 1440, 2 * 1440, 0, null]
    );
    /*
     * And it returns to *trial*, not active. The trial had not expired when the pause began, so
     * resuming into Active would have silently ended it and started billing early.
     */
    check(
      'a subscription paused during its trial resumes into trial, not into active',
      subOf(resumed).state,
      SUBSCRIPTION_STATES.TRIAL
    );

    const activated = await call(`/subscriptions/${sub.id}/activate`, {
      method: 'POST',
      token: platform,
      body: { reason: 'Payment received' },
    });
    check(
      'activating from trial ends the trial and re-bases the period to now',
      [
        activated.status,
        subOf(activated).state,
        minutesBetween(subOf(activated).trial_ends_at, subOf(activated).current_period_start),
        minutesBetween(subOf(activated).current_period_start, subOf(activated).current_period_end),
      ],
      [200, SUBSCRIPTION_STATES.ACTIVE, 0, 30 * 1440]
    );
    const twice = await call(`/subscriptions/${sub.id}/activate`, { method: 'POST', token: platform });
    check(
      'and activating an active subscription is refused, not silently repeated',
      [twice.status, codeOf(twice)],
      [409, 'SUBSCRIPTION_STATE_UNCHANGED']
    );
    check(
      'the two governing-state readers agree again now the trial is over',
      [
        await subscriptionsService.governingStateFor(fixtures.school.id),
        (await tenantService.getSchool(fixtures.school.id)).subscription_state,
      ],
      [
        (await snapshotOf(fixtures.school.id)).subscription.state,
        SUBSCRIPTION_STATES.ACTIVE,
      ]
    );

    /* ────────────────── FR-SUB-009 / §11.3 — the purchase copy ────────────────── */

    console.log('\n--- FR-SUB-009: what an add-on purchase actually copies ---');

    const addonForbidden = await call(`/subscriptions/${sub.id}/addons`, {
      method: 'POST',
      token: orgAdmin,
      body: { addon_id: extraStudents.id, quantity: 1 },
    });
    check(
      'an Organization Admin may read but not buy: it holds neither manage nor self.manage',
      [addonForbidden.status, codeOf(addonForbidden)],
      [403, 'INSUFFICIENT_PERMISSION']
    );
    /*
     * `requireAnyPermission` reports `requiredAnyOf`, not `missing`. Asserted by name, because an
     * assertion written against `details.missing` would compare undefined to undefined and pass
     * whatever the guard did.
     */
    check(
      'and the refusal names both keys that would have satisfied it',
      detailsOf(addonForbidden).requiredAnyOf,
      ['subscriptions.manage', 'subscriptions.self.manage']
    );

    const mismatch = await call(`/subscriptions/${sub.id}/addons`, {
      method: 'POST',
      token: platform,
      body: { addon_id: extraStudents.id, addon_price_id: restrictedPrice.id, quantity: 1 },
    });
    check(
      'a price restricted to another plan is refused — FR-SUB-009’s plan-specific pricing, enforced',
      [
        mismatch.status,
        codeOf(mismatch),
        Number(detailsOf(mismatch).restrictedToPlanId) === planIds.same,
      ],
      [409, 'ADDON_PRICE_PLAN_MISMATCH', true]
    );
    const crossAddon = await call(`/subscriptions/${sub.id}/addons`, {
      method: 'POST',
      token: platform,
      body: { addon_id: extraStudents.id, addon_price_id: reportPrice.id, quantity: 1 },
    });
    check(
      'and a price belonging to a different add-on is refused before anything is written',
      [crossAddon.status, crossAddon.status === 422 && messagesOf(crossAddon).length > 0],
      [422, true]
    );

    /*
     * The headline assertion of this suite. `units_granted` is `quantity × units_per_quantity`
     * resolved at purchase time; `entitlementService` reads it as already multiplied and skips any
     * row where it is not positive. A null or an unmultiplied 3 here leaves a purchase that looks
     * successful and grants nothing.
     */
    const bought = await call(`/subscriptions/${sub.id}/addons`, {
      method: 'POST',
      token: principal,
      body: {
        addon_id: extraStudents.id,
        addon_price_id: openPrice.id,
        quantity: 3,
        reason: 'Enrolment growth',
      },
    });
    check('a Principal may buy an add-on for its own school — FR-SUB-009 names the School', bought.status, 201);
    const purchase = dataOf(bought).purchase;
    check(
      'and the purchase resolves three blocks of fifty into one hundred and fifty units',
      {
        effectType: purchase.effectType,
        effectTarget: purchase.effectTarget,
        quantity: purchase.quantity,
        unitsPerQuantity: purchase.unitsPerQuantity,
        unitsGranted: purchase.unitsGranted,
        unitAmount: purchase.unitAmount,
        currency: purchase.currency,
      },
      {
        effectType: 'limit_increase',
        effectTarget: 'student_limit',
        quantity: 3,
        unitsPerQuantity: 50,
        unitsGranted: 150,
        unitAmount: 5,
        currency: 'USD',
      }
    );

    const purchaseRow = await db.SubscriptionAddon.findByPk(purchase.id);
    check(
      'the stored row carries the copies, not a join — a later add-on edit cannot change what was bought',
      {
        effect_type: purchaseRow.effect_type,
        effect_target: purchaseRow.effect_target,
        units_granted: Number(purchaseRow.units_granted),
        quantity: Number(purchaseRow.quantity),
        unit_amount: money.toNumber(purchaseRow.unit_amount),
        currency: purchaseRow.currency,
        status: purchaseRow.status,
        is_recurring: Boolean(purchaseRow.is_recurring),
        addon_price_id: Number(purchaseRow.addon_price_id),
      },
      {
        effect_type: 'limit_increase',
        effect_target: 'student_limit',
        units_granted: 150,
        quantity: 3,
        unit_amount: 5,
        currency: 'USD',
        status: 'active',
        is_recurring: true,
        addon_price_id: Number(openPrice.id),
      }
    );
    check(
      'the message says what was granted, in words — a wrong quantity is otherwise invisible',
      bought.body.message,
      'Extra Students purchased. 150 added to student_limit.'
    );
    check(
      'a billable item is written for §13 at unit × quantity',
      money.toNumber(
        (
          await db.SubscriptionItem.findOne({
            where: { subscription_id: sub.id, item_type: 'addon' },
          })
        ).amount
      ),
      15
    );

    const snap2 = await snapshotOf(fixtures.school.id);
    check(
      'and the resolved limit is the plan’s base plus the add-on units, attributed to the plan',
      {
        value: snap2.limits.student_limit.value,
        baseValue: snap2.limits.student_limit.baseValue,
        addonUnits: snap2.limits.student_limit.addonUnits,
        source: snap2.limits.student_limit.source,
      },
      { value: 250, baseValue: 100, addonUnits: 150, source: 'plan' }
    );
    check(
      'the derived standing block agrees with it, per target and with the limit’s unit',
      subOf(bought).standing.grantedUnits,
      { student_limit: { units: 150, unit: LIMIT_UNITS.student_limit } }
    );

    /* A feature unlock grants no units, and turns a feature on that the plan does not carry. */
    check(
      'before the unlock, premium_reports is not in the snapshot at all',
      snap2.features.premium_reports,
      undefined
    );
    /*
     * Bought without naming a price, deliberately — the other half of the pricing path. There is no
     * implicit selection here, unlike `selectPrice()` for a plan: a purchase that names no
     * `addon_price_id` is recorded at zero with a null pointer. That is what makes the module usable
     * against the shipped seed data, where `addon_prices` is empty, and it is asserted rather than
     * assumed because a purchase silently priced at zero is a billing figure nobody chose.
     */
    const unlocked = await call(`/subscriptions/${sub.id}/addons`, {
      method: 'POST',
      token: platform,
      body: { addon_id: premiumReports.id },
    });
    check(
      'a feature_unlock purchase grants zero units and says so',
      [
        unlocked.status,
        dataOf(unlocked).purchase.unitsGranted,
        dataOf(unlocked).purchase.effectType,
        unlocked.body.message,
      ],
      [201, 0, 'feature_unlock', 'Premium Reports purchased. premium_reports unlocked.']
    );
    const unlockedRow = await db.SubscriptionAddon.findByPk(dataOf(unlocked).purchase.id);
    check(
      'and with no price named it is recorded at zero, in the subscription’s own currency',
      {
        addon_price_id: unlockedRow.addon_price_id,
        unit_amount: money.toNumber(unlockedRow.unit_amount),
        currency: unlockedRow.currency,
      },
      { addon_price_id: null, unit_amount: 0, currency: 'USD' }
    );
    check(
      'a feature_unlock purchase grants zero units and says so',
      [
        unlocked.status,
        dataOf(unlocked).purchase.unitsGranted,
        dataOf(unlocked).purchase.effectType,
        unlocked.body.message,
      ],
      [201, 0, 'feature_unlock', 'Premium Reports purchased. premium_reports unlocked.']
    );
    const snap3 = await snapshotOf(fixtures.school.id);
    check(
      'and afterwards the feature is on, attributed to the add-on rather than the plan',
      snap3.features.premium_reports,
      { enabled: true, value: null, source: 'addon' }
    );
    check(
      'while the student limit is untouched by it — a feature unlock is not a limit increase',
      snap3.limits.student_limit.value,
      250
    );

    /* ────────────────────────── §33 — the three overrides ────────────────────────── */

    console.log('\n--- §33: custom limits, feature overrides, custom pricing ---');

    const overrideAsSchool = await call(`/subscriptions/${sub.id}/overrides`, {
      method: 'POST',
      token: principal,
      body: { override_type: OVERRIDE_TYPES.LIMIT, target_key: 'student_limit', limit_type: LIMIT_TYPES.FIXED, limit_value: 9999 },
    });
    check(
      'a school cannot negotiate its own override — §33 is a platform operation',
      [overrideAsSchool.status, codeOf(overrideAsSchool)],
      [403, 'PLATFORM_SCOPE_REQUIRED']
    );

    const limitOverride = await call(`/subscriptions/${sub.id}/overrides`, {
      method: 'POST',
      token: platform,
      body: {
        override_type: OVERRIDE_TYPES.LIMIT,
        target_key: 'student_limit',
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: 1000,
        reason: 'Negotiated ceiling',
      },
    });
    check('a new override is a 201', [limitOverride.status, limitOverride.body.message], [
      201,
      'Override applied',
    ]);
    check(
      'it records who applied it and is in force immediately — no window means no start date',
      {
        created_by: Number(dataOf(limitOverride).override.created_by),
        is_active: Boolean(dataOf(limitOverride).override.is_active),
        is_effective: dataOf(limitOverride).override.is_effective,
        effective_from: dataOf(limitOverride).override.effective_from,
        amount: dataOf(limitOverride).override.amount,
      },
      {
        created_by: fixtures.platform.id,
        is_active: true,
        is_effective: true,
        effective_from: null,
        amount: null,
      }
    );

    /*
     * The three-input interaction, and the reason this assertion exists at all: an override replaces
     * the *plan's* value, and the add-on units are added on top of the result. 1000 + 150, not 1000
     * and not 250 — a resolution that applied the override last and overwrote `value` would silently
     * take away an allowance the school paid for.
     */
    const snap4 = await snapshotOf(fixtures.school.id);
    check(
      'a §33 custom limit replaces the plan’s base and keeps the purchased units on top of it',
      {
        value: snap4.limits.student_limit.value,
        baseValue: snap4.limits.student_limit.baseValue,
        addonUnits: snap4.limits.student_limit.addonUnits,
        source: snap4.limits.student_limit.source,
      },
      { value: 1150, baseValue: 1000, addonUnits: 150, source: 'override' }
    );

    const replaced = await call(`/subscriptions/${sub.id}/overrides`, {
      method: 'POST',
      token: platform,
      body: {
        override_type: OVERRIDE_TYPES.LIMIT,
        target_key: 'student_limit',
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: 1200,
      },
    });
    check(
      're-applying the same target replaces the row rather than adding a second one — 200, not 201',
      [
        replaced.status,
        replaced.body.message,
        Number(dataOf(replaced).override.id) === Number(dataOf(limitOverride).override.id),
        (await snapshotOf(fixtures.school.id)).limits.student_limit.value,
      ],
      [
        200,
        'Override replaced. The previous value for this target is no longer in force.',
        true,
        1350,
      ]
    );
    check(
      'and the subscription still has exactly one override for that target',
      await db.SubscriptionOverride.count({
        where: { subscription_id: sub.id, override_type: OVERRIDE_TYPES.LIMIT, target_key: 'student_limit' },
      }),
      1
    );

    const moduleOn = await call(`/subscriptions/${sub.id}/overrides`, {
      method: 'POST',
      token: platform,
      body: { override_type: OVERRIDE_TYPES.MODULE, target_key: 'library', is_enabled: true },
    });
    const moduleOff = await call(`/subscriptions/${sub.id}/overrides`, {
      method: 'POST',
      token: platform,
      body: { override_type: OVERRIDE_TYPES.MODULE, target_key: 'students', is_enabled: false },
    });
    const snap5 = await snapshotOf(fixtures.school.id);
    check(
      'a module override works in both directions: on for one the plan omits, off for one it grants',
      [moduleOn.status, moduleOff.status, snap5.modules.library, snap5.modules.students],
      [201, 201, true, false]
    );

    /*
     * A feature key is free text, but it has the shape a plan feature key has. Entitlement keys features
     * by the exact string while the lookup that finds a row to replace is case-insensitive, so a
     * mixed-case key has to be folded before it is stored, not after.
     */
    const featureMixed = await call(`/subscriptions/${sub.id}/overrides`, {
      method: 'POST',
      token: platform,
      body: { override_type: OVERRIDE_TYPES.FEATURE, target_key: '  Custom_Branding ', is_enabled: true },
    });
    const featureBad = await call(`/subscriptions/${sub.id}/overrides`, {
      method: 'POST',
      token: platform,
      body: { override_type: OVERRIDE_TYPES.FEATURE, target_key: 'custom branding!', is_enabled: true },
    });
    check(
      'a feature override key is stored lower-case and reaches the snapshot under that key; one with spaces is refused',
      {
        status: featureMixed.status,
        stored: dataOf(featureMixed).override.target_key,
        snapshot: (await snapshotOf(fixtures.school.id)).features.custom_branding,
        refused: [featureBad.status, codeOf(featureBad)],
      },
      {
        status: 201,
        stored: 'custom_branding',
        snapshot: { enabled: true, value: null, source: 'override' },
        refused: [422, 'VALIDATION_ERROR'],
      }
    );

    /*
     * §33's Custom Pricing changes what the school is *charged*, not what it may do, so it is
     * deliberately absent from the entitlement snapshot and does not touch the row's own
     * `cycle_amount` — §13's invoice generation is what will read it.
     */
    const priceOverride = await call(`/subscriptions/${sub.id}/overrides`, {
      method: 'POST',
      token: platform,
      body: { override_type: OVERRIDE_TYPES.PRICE, target_key: 'cycle_amount', amount: 12.5 },
    });
    check(
      'a custom price is stored on the override and changes neither entitlement nor the row’s amount',
      [
        priceOverride.status,
        money.toNumber(dataOf(priceOverride).override.amount),
        money.toNumber(subOf(priceOverride).cycle_amount),
        (await snapshotOf(fixtures.school.id)).limits.student_limit.value,
      ],
      [201, 12.5, 30, 1350]
    );

    const revoked = await call(
      `/subscriptions/${sub.id}/overrides/${dataOf(moduleOff).override.id}/revoke`,
      { method: 'POST', token: platform, body: { reason: 'Dispute settled' } }
    );
    check(
      'revoking returns the plan’s own answer, and closes the window rather than deleting the row',
      [
        revoked.status,
        dataOf(revoked).override.is_active,
        dataOf(revoked).override.is_effective,
        (await snapshotOf(fixtures.school.id)).modules.students,
      ],
      [200, false, false, true]
    );
    const revokeTwice = await call(
      `/subscriptions/${sub.id}/overrides/${dataOf(moduleOff).override.id}/revoke`,
      { method: 'POST', token: platform }
    );
    check(
      'and revoking it again is refused rather than repeated',
      [revokeTwice.status, codeOf(revokeTwice)],
      [409, 'SUBSCRIPTION_OVERRIDE_INACTIVE']
    );
    const revokeUnknown = await call(`/subscriptions/${sub.id}/overrides/99999999/revoke`, {
      method: 'POST',
      token: platform,
    });
    check(
      'an override id that is not this subscription’s is a 404',
      [revokeUnknown.status, codeOf(revokeUnknown)],
      [404, 'SUBSCRIPTION_OVERRIDE_NOT_FOUND']
    );

    /* Back to the plan's own limit for the arithmetic that follows. */
    await call(`/subscriptions/${sub.id}/overrides/${dataOf(limitOverride).override.id}/revoke`, {
      method: 'POST',
      token: platform,
    });
    check(
      'with the custom limit revoked, the plan base plus the add-on units is what remains',
      (await snapshotOf(fixtures.school.id)).limits.student_limit.value,
      250
    );

    /* ────────────────── FR-SUB-013 / §12.3 — upgrade with proration ────────────────── */

    console.log('\n--- FR-SUB-013 / §12.3: proration, remaining credit, new price ---');

    /*
     * The period is repositioned so that exactly half of it has elapsed. `billingCycleDays()` returns
     * thirty for this `custom_days` price whatever the calendar says, and `daysBetween()` floors — so
     * a minute of slack keeps `elapsedDays` at fifteen rather than on the boundary.
     */
    const upgradeAt = Date.now();
    await db.Subscription.update(
      {
        current_period_start: new Date(upgradeAt - 15 * DAY - 60000),
        current_period_end: new Date(upgradeAt + 15 * DAY - 60000),
        next_renewal_at: new Date(upgradeAt + 15 * DAY - 60000),
      },
      { where: { id: sub.id } }
    );
    const periodEndBeforeUpgrade = (await db.Subscription.findByPk(sub.id)).current_period_end;

    const upgraded = await call(`/subscriptions/${sub.id}/upgrade`, {
      method: 'POST',
      token: principal,
      body: { plan_id: planIds.pro, reason: 'Growth' },
    });
    check('a school may upgrade itself — FR-SUB-013 names the School as an actor', upgraded.status, 200);
    const change = dataOf(upgraded).change;
    check(
      'half the old plan is credited, half the new one is due, and the credit is spent on it',
      change.proration,
      {
        periodDays: 30,
        elapsedDays: 15,
        remainingDays: 15,
        unusedCredit: 15,
        prorationDue: 30,
        creditApplied: 15,
        amountDue: 15,
        creditBalance: 0,
      }
    );
    check(
      'the change block says which direction, when, and to what',
      {
        direction: change.direction,
        timing: change.timing,
        applied: change.applied,
        toPlan: change.toPlan.name,
        fromPlan: change.fromPlan.name,
        newCycleAmount: money.toNumber(change.newCycleAmount),
      },
      {
        direction: 'upgrade',
        timing: DOWNGRADE_TIMING.IMMEDIATE,
        applied: true,
        toPlan: 'Verify Subs Pro',
        fromPlan: 'Verify Subs Basic',
        newCycleAmount: 60,
      }
    );
    check(
      'and the figures reach the operator in words, not only in the body',
      upgraded.body.message,
      `Upgraded to Verify Subs Pro. ${money.format(30, 'USD')} prorated for the remaining 15 day(s), ` +
        `${money.format(15, 'USD')} credit applied, ${money.format(15, 'USD')} due.`
    );

    check(
      'the school is on the new plan at the new price, with the credit consumed',
      {
        plan_id: Number(subOf(upgraded).plan_id) === planIds.pro,
        cycle_amount: money.toNumber(subOf(upgraded).cycle_amount),
        credit_balance: money.toNumber(subOf(upgraded).credit_balance),
        state: subOf(upgraded).state,
      },
      { plan_id: true, cycle_amount: 60, credit_balance: 0, state: SUBSCRIPTION_STATES.ACTIVE }
    );
    /*
     * §12.3 prorates the *difference*; it does not restart the cycle. Moving the boundary here would
     * quietly give the school half a period of the new plan for free and shift every renewal after it.
     */
    check(
      'and the period boundary is untouched: the school is on the new plan until the same date',
      minutesBetween(periodEndBeforeUpgrade, subOf(upgraded).current_period_end),
      0
    );

    /* Read as a model instance, not `raw: true`: under `raw` MariaDB hands back JSON as a string. */
    const upgradeRow = await db.SubscriptionHistory.findOne({
      where: { subscription_id: sub.id, event: SUBSCRIPTION_EVENTS.UPGRADED },
      order: [['id', 'DESC']],
    });
    check(
      'the ledger carries the three §12.3 figures it exists to record',
      {
        proration_amount: money.toNumber(upgradeRow.proration_amount),
        credit_applied: money.toNumber(upgradeRow.credit_applied),
        new_amount: money.toNumber(upgradeRow.new_amount),
        from: Number(upgradeRow.from_plan_id) === planIds.basic,
        to: Number(upgradeRow.to_plan_id) === planIds.pro,
        performed_by: Number(upgradeRow.performed_by) === fixtures.principal.id,
      },
      { proration_amount: 30, credit_applied: 15, new_amount: 60, from: true, to: true, performed_by: true }
    );
    check(
      'and its metadata records the working, so the figure can be reconciled later',
      {
        direction: upgradeRow.metadata.direction,
        remainingDays: upgradeRow.metadata.remainingDays,
        amountDue: upgradeRow.metadata.amountDue,
      },
      { direction: 'upgrade', remainingDays: 15, amountDue: 15 }
    );

    /*
     * FR-SUB-013's outcome is "upgraded with correctly prorated billing". The amount due used to be
     * reported and then billed by nothing — `generateForSubscription()` bills items at full price and
     * refuses a period it has already billed. It is now issued as its own invoice in the same
     * transaction as the switch.
     */
    const prorationInvoices = await db.Invoice.findAll({
      where: { subscription_id: sub.id },
      include: [{ model: db.InvoiceItem, as: 'items' }],
    });
    const prorationInvoice = prorationInvoices[0];
    check(
      'the amount due is invoiced once, on one line for the rest of the period, and the body names the invoice',
      {
        invoices: prorationInvoices.length,
        named: Boolean(change.invoice) && Number(change.invoice.id) === Number(prorationInvoice.id),
        lines: prorationInvoice.items.map((item) => [item.item_type, money.toNumber(item.amount)]),
        subtotal: money.toNumber(prorationInvoice.subtotal),
        creditApplied: money.toNumber(prorationInvoice.credit_applied),
        periodEndsWithCycle:
          minutesBetween(prorationInvoice.billing_period_end, periodEndBeforeUpgrade) === 0,
        plan: Number(prorationInvoice.plan_id) === planIds.pro,
      },
      {
        invoices: 1,
        named: true,
        lines: [['custom', 15]],
        subtotal: 15,
        creditApplied: 0,
        periodEndsWithCycle: true,
        plan: true,
      }
    );

    const snap6 = await snapshotOf(fixtures.school.id);
    check(
      'the upgrade takes effect in the resolved entitlement, add-on units intact',
      {
        limit: snap6.limits.student_limit.value,
        addonUnits: snap6.limits.student_limit.addonUnits,
        plan: snap6.plan.code,
        library: snap6.modules.library,
      },
      { limit: 650, addonUnits: 150, plan: 'VSB-PRO', library: true }
    );

    const wrongWay = await call(`/subscriptions/${sub.id}/upgrade`, {
      method: 'POST',
      token: platform,
      body: { plan_id: planIds.basic },
    });
    check(
      'an upgrade to a lower tier is refused by name, not silently applied as a downgrade',
      [wrongWay.status, codeOf(wrongWay), detailsOf(wrongWay).actual],
      [409, 'SUBSCRIPTION_WRONG_DIRECTION', 'downgrade']
    );
    const sameplan = await call(`/subscriptions/${sub.id}/upgrade`, {
      method: 'POST',
      token: platform,
      body: { plan_id: planIds.pro },
    });
    check(
      'and moving to the plan it is already on is refused before any proration is computed',
      [sameplan.status, codeOf(sameplan)],
      [409, 'SUBSCRIPTION_PLAN_UNCHANGED']
    );
    const sideways = await call(`/subscriptions/${sub.id}/upgrade`, {
      method: 'POST',
      token: platform,
      body: { plan_id: planIds.same },
    });
    check(
      'a different plan at the same tier is neither an upgrade nor a downgrade, and says so',
      [sideways.status, codeOf(sideways)],
      [409, 'SUBSCRIPTION_SAME_TIER']
    );

    /*
     * A plan change keeps the subscription's billing cycle unless the caller names another. Asked with
     * neither a price nor a cycle, the price used to be the target plan's default on any cycle — so this
     * `custom_days` subscription would have been moved onto a monthly price mid-period. A higher tier
     * priced only monthly is built here, after the fixture count above, so nothing else sees it.
     */
    await makePlan(
      'monthlyOnly',
      { name: 'Verify Subs Monthly', code: 'VSB-MONTHLY', tier_rank: 30, trial_days: 0 },
      90,
      900,
      ['students', 'teachers', 'library']
    );
    const monthlyPrices = await call(`/plans/${planIds.monthlyOnly}/prices`, {
      method: 'PUT',
      token: platform,
      body: {
        prices: [
          {
            billing_cycle: BILLING_CYCLES.MONTHLY,
            pricing_model: PRICING_MODELS.FIXED,
            currency: 'USD',
            base_amount: 90,
            is_default: true,
          },
        ],
      },
    });
    const monthlyActivated = await call(`/plans/${planIds.monthlyOnly}/activate`, {
      method: 'POST',
      token: platform,
    });
    if (monthlyPrices.status !== 200 || monthlyActivated.status !== 200) {
      throw new Error(`fixture plan monthlyOnly failed: ${monthlyPrices.raw} ${monthlyActivated.raw}`);
    }
    const cycleBefore = await db.Subscription.findByPk(sub.id);
    const offCycle = await call(`/subscriptions/${sub.id}/upgrade`, {
      method: 'POST',
      token: platform,
      body: { plan_id: planIds.monthlyOnly },
    });
    const cycleAfter = await db.Subscription.findByPk(sub.id);
    check(
      'an upgrade to a plan with no price on this billing cycle is refused, not switched to another cycle',
      {
        status: offCycle.status,
        code: codeOf(offCycle),
        planUnchanged: Number(cycleAfter.plan_id) === Number(cycleBefore.plan_id),
        cycle: cycleAfter.billing_cycle,
      },
      {
        status: 409,
        code: 'PLAN_PRICE_CYCLE_UNAVAILABLE',
        planUnchanged: true,
        cycle: BILLING_CYCLES.CUSTOM_DAYS,
      }
    );

    /*
     * Naming a price carries a different recurring cycle (the arithmetic is Part 3's), but not a
     * different currency — credit and proration would be relabelled, not converted — and not a switch
     * between one-time and recurring, where there is no period to prorate or none that renews.
     */
    const odd = await call(`/plans/${planIds.monthlyOnly}/prices`, {
      method: 'PUT',
      token: platform,
      body: {
        prices: [
          { billing_cycle: BILLING_CYCLES.MONTHLY, pricing_model: PRICING_MODELS.FIXED, currency: 'USD', base_amount: 90, is_default: true },
          { billing_cycle: BILLING_CYCLES.CUSTOM_DAYS, cycle_days: 30, pricing_model: PRICING_MODELS.FIXED, currency: 'EUR', base_amount: 80 },
          { billing_cycle: BILLING_CYCLES.ONE_TIME, pricing_model: PRICING_MODELS.FIXED, currency: 'USD', base_amount: 900 },
        ],
      },
    });
    if (odd.status !== 200) throw new Error(`fixture prices for monthlyOnly failed: ${odd.raw}`);
    const oddPrices = await db.PlanPrice.findAll({ where: { plan_id: planIds.monthlyOnly, is_active: true } });
    const priceOn = (cycle, currency) =>
      oddPrices.find((row) => row.billing_cycle === cycle && row.currency === currency).id;
    const inEuros = await call(`/subscriptions/${sub.id}/upgrade`, {
      method: 'POST',
      token: platform,
      body: { plan_id: planIds.monthlyOnly, plan_price_id: priceOn(BILLING_CYCLES.CUSTOM_DAYS, 'EUR') },
    });
    const oneTime = await call(`/subscriptions/${sub.id}/upgrade`, {
      method: 'POST',
      token: platform,
      body: { plan_id: planIds.monthlyOnly, plan_price_id: priceOn(BILLING_CYCLES.ONE_TIME, 'USD') },
    });
    const afterRefusals = await db.Subscription.findByPk(sub.id);
    check(
      'a plan change onto another currency, or from recurring onto one-time, is refused and changes nothing',
      {
        currency: [inEuros.status, codeOf(inEuros)],
        oneTime: [oneTime.status, codeOf(oneTime)],
        planUnchanged: Number(afterRefusals.plan_id) === Number(cycleBefore.plan_id),
        stillBilled: [afterRefusals.currency, afterRefusals.billing_cycle],
      },
      {
        currency: [409, 'PLAN_PRICE_CURRENCY_MISMATCH'],
        oneTime: [409, 'PLAN_PRICE_CYCLE_KIND_MISMATCH'],
        planUnchanged: true,
        stillBilled: ['USD', BILLING_CYCLES.CUSTOM_DAYS],
      }
    );

    /*
     * A one-time subscription has no next cycle for a scheduled downgrade to land on — `renew()` refuses
     * one and the sweep never renews one — so scheduling one is refused rather than recorded and never
     * applied. The cycle is flipped on the row for the one request and put back.
     */
    await db.Subscription.update({ billing_cycle: BILLING_CYCLES.ONE_TIME }, { where: { id: sub.id } });
    const noNextCycle = await call(`/subscriptions/${sub.id}/downgrade`, {
      method: 'POST',
      token: platform,
      body: { plan_id: planIds.basic, timing: DOWNGRADE_TIMING.NEXT_BILLING_CYCLE },
    });
    const noNextRow = await db.Subscription.findByPk(sub.id);
    await db.Subscription.update(
      { billing_cycle: cycleBefore.billing_cycle },
      { where: { id: sub.id } }
    );
    check(
      'a downgrade cannot be scheduled on a one-time subscription, and nothing is scheduled',
      [noNextCycle.status, codeOf(noNextCycle), noNextRow.scheduled_plan_id],
      [409, 'SUBSCRIPTION_NO_NEXT_CYCLE', null]
    );

    /* ────────── FR-SUB-014 / §12.4 — the deferred downgrade, then renewal ────────── */

    console.log('\n--- FR-SUB-014 / §12.4: scheduled for the next billing cycle ---');

    const scheduled = await call(`/subscriptions/${sub.id}/downgrade`, {
      method: 'POST',
      token: principal,
      body: {
        plan_id: planIds.basic,
        timing: DOWNGRADE_TIMING.NEXT_BILLING_CYCLE,
        reason: 'Enrolment fell',
      },
    });
    check(
      'the change is recorded, not applied: the school keeps its capability until the cycle ends',
      [
        scheduled.status,
        dataOf(scheduled).change.applied,
        minutesBetween(dataOf(scheduled).change.effectiveAt, subOf(scheduled).current_period_end),
        Number(subOf(scheduled).plan_id) === planIds.pro,
        Number(subOf(scheduled).scheduled_plan_id) === planIds.basic,
        subOf(scheduled).scheduled_change_timing,
        subOf(scheduled).standing.hasScheduledChange,
      ],
      [200, false, 0, true, true, DOWNGRADE_TIMING.NEXT_BILLING_CYCLE, true]
    );
    check(
      'and the operator is told the school keeps its plan until then',
      scheduled.body.message,
      'Downgrade to Verify Subs Basic scheduled for the end of the current billing cycle (SRS §12.4). ' +
        'The school keeps its current plan until then.'
    );
    check(
      'a scheduled change does not touch entitlement — the school is still on Pro',
      {
        plan: (await snapshotOf(fixtures.school.id)).plan.code,
        limit: (await snapshotOf(fixtures.school.id)).limits.student_limit.value,
        state: (await tenantService.getSchool(fixtures.school.id)).subscription_state,
      },
      { plan: 'VSB-PRO', limit: 650, state: SUBSCRIPTION_STATES.ACTIVE }
    );
    check(
      'and it is on the ledger as scheduled rather than as a downgrade that happened',
      (
        await db.SubscriptionHistory.findOne({
          where: { subscription_id: sub.id },
          order: [['id', 'DESC']],
        })
      ).event,
      SUBSCRIPTION_EVENTS.DOWNGRADE_SCHEDULED
    );

    /*
     * The cycle end reached. Both dates are moved back an hour rather than waiting: `renew()` applies
     * a scheduled change only when `scheduled_change_at` has passed, so leaving it in the future here
     * would make the renewal below look correct while quietly skipping the §12.4 half of the test.
     */
    const renewAt = new Date(Date.now() - 3600 * 1000);
    await db.Subscription.update(
      { current_period_end: renewAt, next_renewal_at: renewAt, scheduled_change_at: renewAt },
      { where: { id: sub.id } }
    );

    const renewed = await call(`/subscriptions/${sub.id}/renew`, {
      method: 'POST',
      token: principal,
      body: { reason: 'Manual renewal' },
    });
    const renewal = dataOf(renewed).renewal;
    check(
      'renewing applies the change that was waiting for the cycle end',
      [
        renewed.status,
        renewal.appliedScheduledChange,
        renewal.toPlan.name,
        renewal.mode,
        renewal.renewalCount,
        renewed.body.message,
      ],
      [
        200,
        true,
        'Verify Subs Basic',
        'manual',
        1,
        'Subscription renewed and the scheduled downgrade to Verify Subs Basic has been applied.',
      ]
    );
    check(
      'the school is now on the scheduled plan, at its price, with the schedule cleared',
      {
        plan_id: Number(subOf(renewed).plan_id) === planIds.basic,
        cycle_amount: money.toNumber(subOf(renewed).cycle_amount),
        state: subOf(renewed).state,
        scheduled_plan_id: subOf(renewed).scheduled_plan_id,
        scheduled_change_at: subOf(renewed).scheduled_change_at,
        scheduled_change_type: subOf(renewed).scheduled_change_type,
        hasScheduledChange: subOf(renewed).standing.hasScheduledChange,
      },
      {
        plan_id: true,
        cycle_amount: 30,
        state: SUBSCRIPTION_STATES.ACTIVE,
        scheduled_plan_id: null,
        scheduled_change_at: null,
        scheduled_change_type: null,
        hasScheduledChange: false,
      }
    );
    /*
     * The new period starts where the old one ended, not at the moment of the request. A renewal that
     * re-based to `now` would give away the hour — and, on a late cron run, a day.
     */
    check(
      'the new period starts at the old period end and runs a full cycle from there',
      [
        minutesBetween(renewAt, subOf(renewed).current_period_start),
        minutesBetween(subOf(renewed).current_period_start, subOf(renewed).current_period_end),
        minutesBetween(subOf(renewed).current_period_end, subOf(renewed).next_renewal_at),
      ],
      [0, 30 * 1440, 0]
    );
    check(
      'two ledger rows are written — the downgrade that landed, then the renewal, in that order',
      (
        await db.SubscriptionHistory.findAll({
          where: { subscription_id: sub.id },
          order: [['id', 'DESC']],
          limit: 2,
        })
      )
        .map((row) => row.event)
        .reverse(),
      [SUBSCRIPTION_EVENTS.DOWNGRADED, SUBSCRIPTION_EVENTS.RENEWED]
    );
    check(
      'and entitlement follows the plan it renewed onto',
      (await snapshotOf(fixtures.school.id)).limits.student_limit.value,
      250
    );

    /* ─────────────── FR-SUB-010 — suspend, and what stops working ─────────────── */

    console.log('\n--- FR-SUB-010: suspension closes the subscription to changes ---');

    const suspended = await call(`/subscriptions/${sub.id}/suspend`, {
      method: 'POST',
      token: platform,
      body: { reason: 'Non-payment' },
    });
    check(
      'suspending moves the state and leaves the period boundaries where they were',
      [
        suspended.status,
        subOf(suspended).state,
        minutesBetween(subOf(renewed).current_period_end, subOf(suspended).current_period_end),
        subOf(suspended).standing.isUsable,
      ],
      [200, SUBSCRIPTION_STATES.SUSPENDED, 0, false]
    );
    check(
      'a suspended school resolves as unusable and its cached column follows',
      [
        (await snapshotOf(fixtures.school.id)).subscription.isUsable,
        (await tenantService.getSchool(fixtures.school.id)).subscription_state,
      ],
      [false, SUBSCRIPTION_STATES.SUSPENDED]
    );
    const buyWhileSuspended = await call(`/subscriptions/${sub.id}/addons`, {
      method: 'POST',
      token: platform,
      body: { addon_id: extraStudents.id },
    });
    check(
      'nothing more can be sold onto it',
      [buyWhileSuspended.status, codeOf(buyWhileSuspended)],
      [409, 'SUBSCRIPTION_NOT_PURCHASABLE']
    );
    const changeWhileSuspended = await call(`/subscriptions/${sub.id}/upgrade`, {
      method: 'POST',
      token: platform,
      body: { plan_id: planIds.pro },
    });
    check(
      'and its plan cannot be changed while it is closed',
      [
        changeWhileSuspended.status,
        codeOf(changeWhileSuspended),
        detailsOf(changeWhileSuspended).allowedFrom,
      ],
      [409, 'SUBSCRIPTION_NOT_CHANGEABLE', SUBSCRIPTION_USABLE_STATES]
    );

    const reactivated = await call(`/subscriptions/${sub.id}/reactivate`, {
      method: 'POST',
      token: platform,
    });
    check(
      'reactivating opens a fresh cycle from now and clears the suspension stamp',
      [
        reactivated.status,
        subOf(reactivated).state,
        subOf(reactivated).suspended_at,
        minutesBetween(
          subOf(reactivated).current_period_start,
          subOf(reactivated).current_period_end
        ),
      ],
      [200, SUBSCRIPTION_STATES.ACTIVE, null, 30 * 1440]
    );

    /* ─────────────────── FR-SUB-009 — withdrawing a purchase ─────────────────── */

    console.log('\n--- FR-SUB-009: cancelling an add-on withdraws what it granted ---');

    const withdrawn = await call(`/subscriptions/${sub.id}/addons/${purchase.id}/cancel`, {
      method: 'POST',
      token: principal,
      body: { reason: 'Enrolment fell' },
    });
    check(
      'the purchase is marked cancelled, not deleted — §13 raised an invoice line against it',
      [
        withdrawn.status,
        dataOf(withdrawn).purchase.status,
        dataOf(withdrawn).purchase.unitsWithdrawn,
        withdrawn.body.message,
      ],
      [
        200,
        'cancelled',
        150,
        "Add-on cancelled. 150 unit(s) withdrawn from this subscription's allowance.",
      ]
    );
    const withdrawnRow = await db.SubscriptionAddon.findByPk(purchase.id);
    check(
      'the row survives with its figures intact, and stops recurring',
      {
        status: withdrawnRow.status,
        units_granted: Number(withdrawnRow.units_granted),
        is_recurring: Boolean(withdrawnRow.is_recurring),
      },
      { status: 'cancelled', units_granted: 150, is_recurring: false }
    );
    check(
      'and the units leave the resolved allowance at once',
      {
        value: (await snapshotOf(fixtures.school.id)).limits.student_limit.value,
        addonUnits: (await snapshotOf(fixtures.school.id)).limits.student_limit.addonUnits,
      },
      { value: 100, addonUnits: 0 }
    );
    const withdrawTwice = await call(`/subscriptions/${sub.id}/addons/${purchase.id}/cancel`, {
      method: 'POST',
      token: platform,
    });
    check(
      'cancelling it twice is refused rather than repeated',
      [withdrawTwice.status, codeOf(withdrawTwice)],
      [409, 'SUBSCRIPTION_ADDON_NOT_ACTIVE']
    );

    /*
     * Two purchases of one add-on, and one of them cancelled. Cancelling used to close every recurring
     * line with the same `addon_id`, so the purchase still in force kept its units and was never
     * invoiced for them again. Each line now names the purchase it bills in
     * `metadata.subscription_addon_id`, and cancelling closes that line only. The later purchase is the
     * one cancelled, so an implementation that closes the oldest matching line fails here too.
     */
    const buyBlock = (quantity) =>
      call(`/subscriptions/${sub.id}/addons`, {
        method: 'POST',
        token: platform,
        body: { addon_id: extraStudents.id, addon_price_id: openPrice.id, quantity },
      });
    const kept = dataOf(await buyBlock(1)).purchase;
    const dropped = dataOf(await buyBlock(2)).purchase;
    const lineFor = async (purchaseId) =>
      (
        await db.SubscriptionItem.findAll({
          where: { subscription_id: sub.id, item_type: 'addon', addon_id: extraStudents.id },
        })
      ).find((row) => row.metadata && Number(row.metadata.subscription_addon_id) === Number(purchaseId));
    check(
      'each purchase is billed on a line of its own, tagged with the purchase it bills',
      [
        Boolean(await lineFor(kept.id)),
        Boolean(await lineFor(dropped.id)),
        (await lineFor(kept.id)).id !== (await lineFor(dropped.id)).id,
      ],
      [true, true, true]
    );
    const dropOne = await call(`/subscriptions/${sub.id}/addons/${dropped.id}/cancel`, {
      method: 'POST',
      token: platform,
    });
    check(
      'cancelling one of two purchases of the same add-on closes its own line and leaves the other billing',
      {
        status: dropOne.status,
        droppedRecurring: Boolean((await lineFor(dropped.id)).is_recurring),
        keptRecurring: Boolean((await lineFor(kept.id)).is_recurring),
        keptStatus: (await db.SubscriptionAddon.findByPk(kept.id)).status,
        addonUnits: (await snapshotOf(fixtures.school.id)).limits.student_limit.addonUnits,
      },
      { status: 200, droppedRecurring: false, keptRecurring: true, keptStatus: 'active', addonUnits: 50 }
    );
    /* Put the allowance back where the rest of the suite expects it. */
    const dropKept = await call(`/subscriptions/${sub.id}/addons/${kept.id}/cancel`, {
      method: 'POST',
      token: platform,
    });
    check(
      'and cancelling the other closes its line too, leaving no add-on units',
      [
        dropKept.status,
        Boolean((await lineFor(kept.id)).is_recurring),
        (await snapshotOf(fixtures.school.id)).limits.student_limit.addonUnits,
      ],
      [200, false, 0]
    );

    /* ──────────────────── FR-SUB-010 — cancellation is terminal ──────────────────── */

    console.log('\n--- FR-SUB-010: cancellation, and what a school may not do to itself ---');

    const selfCancel = await call(`/subscriptions/${sub.id}/cancel`, {
      method: 'POST',
      token: principal,
      body: { reason: 'Closing' },
    });
    check(
      'a school may upgrade itself but not cancel itself — FR-SUB-010 does not name it as an actor',
      [selfCancel.status, codeOf(selfCancel)],
      [403, 'PLATFORM_SCOPE_REQUIRED']
    );

    const cancelled = await call(`/subscriptions/${sub.id}/cancel`, {
      method: 'POST',
      token: platform,
      body: { reason: 'School closed' },
    });
    check(
      'cancelling stamps the end date and the reason, and stops the renewal',
      [
        cancelled.status,
        subOf(cancelled).state,
        subOf(cancelled).cancellation_reason,
        subOf(cancelled).next_renewal_at,
        minutesBetween(subOf(cancelled).cancelled_at, subOf(cancelled).ends_at),
      ],
      [200, SUBSCRIPTION_STATES.CANCELLED, 'School closed', null, 0]
    );
    check(
      'the record is kept as billing history, and the school’s cached column reflects it',
      [
        await db.Subscription.count({ where: { id: sub.id } }),
        (await tenantService.getSchool(fixtures.school.id)).subscription_state,
        await subscriptionsService.governingStateFor(fixtures.school.id),
      ],
      [
        1,
        SUBSCRIPTION_STATES.CANCELLED,
        (await snapshotOf(fixtures.school.id)).subscription.state,
      ]
    );

    /*
     * The case where "most recent" and "usable" disagree. A cancelled subscription is not in
     * `OPEN_STATES`, so the school may be given a new one — and after that the school holds two rows,
     * neither usable while the new one is Pending. Both the module's mirror and entitlement's private
     * chooser have to land on the same one.
     */
    const reopened = await call('/subscriptions', {
      method: 'POST',
      token: platform,
      body: { school_id: fixtures.school.id, plan_id: planIds.same },
    });
    check(
      'a cancelled school may be subscribed again, and a plan with no trial starts Pending',
      [reopened.status, subOf(reopened).state, reopened.body.message],
      [
        201,
        SUBSCRIPTION_STATES.PENDING,
        'Subscription created in pending state. Activate it to start the billing period.',
      ]
    );
    created.subscriptions.push(subOf(reopened).id);
    check(
      'the school now holds two subscriptions, and both choosers pick the same governing one',
      {
        rows: await db.Subscription.count({ where: { school_id: fixtures.school.id } }),
        mirror: await subscriptionsService.governingStateFor(fixtures.school.id),
        resolved: (await snapshotOf(fixtures.school.id)).subscription.state,
        id:
          Number((await snapshotOf(fixtures.school.id)).subscription.id) ===
          Number(subOf(reopened).id),
      },
      {
        rows: 2,
        mirror: SUBSCRIPTION_STATES.PENDING,
        resolved: SUBSCRIPTION_STATES.PENDING,
        id: true,
      }
    );
    const renewPending = await call(`/subscriptions/${subOf(reopened).id}/renew`, {
      method: 'POST',
      token: platform,
    });
    check(
      'a pending subscription cannot be renewed — there is no period to extend yet',
      [renewPending.status, codeOf(renewPending), detailsOf(renewPending).allowedFrom],
      [
        409,
        'SUBSCRIPTION_NOT_RENEWABLE',
        [
          SUBSCRIPTION_STATES.ACTIVE,
          SUBSCRIPTION_STATES.EXPIRING,
          SUBSCRIPTION_STATES.PAST_DUE,
          SUBSCRIPTION_STATES.GRACE_PERIOD,
          SUBSCRIPTION_STATES.EXPIRED,
        ],
      ]
    );

    /* ───────── FR-SUB-010 / FR-SUB-015 — the sweep, driven directly ───────── */

    console.log('\n--- the lifecycle sweep: five passes, one subscription each ---');

    const basicPrice = await db.PlanPrice.findOne({
      where: { plan_id: planIds.basic, is_active: true },
    });
    const now = Date.now();

    /**
     * One hand-built subscription per pass. Built directly rather than through the routes because
     * each one has to sit at a date the routes will not produce — a trial that ran out an hour ago,
     * a grace period that closed, a period ending inside the notice window.
     */
    async function sweepFixture(school, columns) {
      const row = await db.Subscription.create({
        school_id: school.id,
        organization_id: fixtures.org.id,
        plan_id: planIds.basic,
        plan_price_id: basicPrice.id,
        billing_cycle: BILLING_CYCLES.CUSTOM_DAYS,
        cycle_days: 30,
        pricing_model: PRICING_MODELS.FIXED,
        currency: 'USD',
        cycle_amount: 30,
        starts_at: new Date(now - 30 * DAY),
        current_period_start: new Date(now - 30 * DAY),
        renewal_mode: RENEWAL_MODES.MANUAL,
        renewal_count: 0,
        credit_balance: 0,
        ...columns,
      });
      created.subscriptions.push(row.id);
      await db.School.update(
        { subscription_state: row.state },
        { where: { id: school.id } }
      );
      return row;
    }

    /* 1 — a trial that ran out an hour ago. Grace is configured, so it stops at Past Due. */
    const wTrial = await sweepFixture(fixtures.sweepTrial, {
      state: SUBSCRIPTION_STATES.TRIAL,
      trial_days: 7,
      trial_starts_at: new Date(now - 7 * DAY - 3600 * 1000),
      trial_ends_at: new Date(now - 3600 * 1000),
      grace_period_days: 3,
      current_period_end: new Date(now + 29 * DAY),
      next_renewal_at: new Date(now + 29 * DAY),
    });
    /* 2 — due for automatic renewal an hour ago. Pass 2 has to claim it before pass 3 does. */
    const wAuto = await sweepFixture(fixtures.sweepAuto, {
      state: SUBSCRIPTION_STATES.ACTIVE,
      renewal_mode: RENEWAL_MODES.AUTOMATIC,
      grace_period_days: 3,
      current_period_end: new Date(now - 3600 * 1000),
      next_renewal_at: new Date(now - 3600 * 1000),
    });
    /* 3 — the same date, but manual: it lapses into Past Due and then into its grace period. */
    const wLapse = await sweepFixture(fixtures.sweepLapse, {
      state: SUBSCRIPTION_STATES.ACTIVE,
      grace_period_days: 5,
      current_period_end: new Date(now - 3600 * 1000),
      next_renewal_at: new Date(now - 3600 * 1000),
    });
    /* 4 — a grace period that closed an hour ago. */
    const wGrace = await sweepFixture(fixtures.sweepGrace, {
      state: SUBSCRIPTION_STATES.GRACE_PERIOD,
      grace_period_days: 3,
      current_period_end: new Date(now - 4 * DAY),
      grace_period_ends_at: new Date(now - 3600 * 1000),
      next_renewal_at: new Date(now - 4 * DAY),
    });
    /* 5 — ending in three days: inside the seven-day notice window, and nothing else. */
    const wNotice = await sweepFixture(fixtures.sweepNotice, {
      state: SUBSCRIPTION_STATES.ACTIVE,
      grace_period_days: 3,
      current_period_end: new Date(now + 3 * DAY),
      next_renewal_at: new Date(now + 3 * DAY),
    });

    /*
     * The sweep reads across every tenant, so a row this run did not create would land in one of the
     * five passes and make the counts below wrong. Asserted rather than assumed.
     */
    check(
      'every subscription in the database belongs to this run, so the sweep counts are exact',
      [await db.Subscription.count(), baseline.subscriptionCount + created.subscriptions.length],
      [created.subscriptions.length, created.subscriptions.length]
    );

    const report = await subscriptionsService.runLifecycleSweep();
    check(
      'each pass claims exactly one subscription, and none of them fails',
      {
        trialEnded: report.trialEnded,
        renewed: report.renewed,
        pastDue: report.pastDue,
        graceStarted: report.graceStarted,
        expired: report.expired,
        expiring: report.expiring,
        failed: report.failed,
      },
      {
        trialEnded: 1,
        renewed: 1,
        pastDue: 1,
        /* Two: the lapse pass raises one, and the trial pass now raises one as well. */
        graceStarted: 2,
        expired: 1,
        expiring: 1,
        failed: [],
      }
    );

    const finalStates = {};
    for (const [key, row] of Object.entries({
      trial: wTrial,
      auto: wAuto,
      lapse: wLapse,
      grace: wGrace,
      notice: wNotice,
    })) {
      finalStates[key] = (await db.Subscription.findByPk(row.id)).state;
    }
    /*
     * The label used to read "where §12 says it should". §12 does not say: §12.1 and §12.2 are
     * duration lists and describe no transitions. FR-SUB-012 is the only clause that does — the grace
     * period is "applied after a subscription becomes past due **or expires**", and the subscription
     * "enters a Grace Period … before further state transition".
     */
    check('and each one lands where FR-SUB-012 says it should', finalStates, {
      /*
       * Trial ran out and grace is configured, so it enters Grace Period rather than waiting at Past
       * Due. It used to stop at Past Due while `grace_period_ends_at` was already written — a grace
       * deadline nothing had entered. The lapse pass below has always done both transitions.
       */
      trial: SUBSCRIPTION_STATES.GRACE_PERIOD,
      /* Renewed by pass 2 — and therefore *not* marked past due by pass 3, which is why 2 runs first. */
      auto: SUBSCRIPTION_STATES.ACTIVE,
      lapse: SUBSCRIPTION_STATES.GRACE_PERIOD,
      grace: SUBSCRIPTION_STATES.EXPIRED,
      notice: SUBSCRIPTION_STATES.EXPIRING,
    });

    const renewedRow = await db.Subscription.findByPk(wAuto.id);
    check(
      'the automatic renewal advanced the period from where it ended and counted itself',
      [
        Number(renewedRow.renewal_count),
        minutesBetween(wAuto.current_period_end, renewedRow.current_period_start),
        minutesBetween(renewedRow.current_period_start, renewedRow.current_period_end),
      ],
      [1, 0, 30 * 1440]
    );
    check(
      'the lapsed one has a grace period of the configured length, counted from the sweep',
      [
        Number((await db.Subscription.findByPk(wLapse.id)).grace_period_days),
        minutesBetween(report.at, (await db.Subscription.findByPk(wLapse.id)).grace_period_ends_at),
      ],
      [5, 5 * 1440]
    );
    check(
      'and the expired one is closed off: expiry stamped, end date set, renewal cleared',
      await db.Subscription.findOne({
        where: { id: wGrace.id },
        attributes: ['next_renewal_at'],
        raw: true,
      }),
      { next_renewal_at: null }
    );

    /*
     * The sweep's rows are read as model instances. Under `raw: true` MariaDB returns a JSON column
     * as a string, and `metadata.sweep` would be `undefined` — an assertion that passed whatever the
     * sweep wrote.
     */
    const sweepRows = await db.SubscriptionHistory.findAll({
      where: { subscription_id: [wTrial.id, wLapse.id, wGrace.id, wNotice.id] },
      order: [['id', 'ASC']],
    });
    check(
      'every sweep row is attributed to no user and marked as the sweep',
      {
        rows: sweepRows.length,
        performers: [...new Set(sweepRows.map((row) => row.performed_by))],
        sweep: [...new Set(sweepRows.map((row) => row.metadata && row.metadata.sweep))],
      },
      /* Six: the trial pass now writes a second history row for entering grace. */
      { rows: 6, performers: [null], sweep: [true] }
    );
    check(
      'and the events are the billing ones, in the order the passes ran',
      sweepRows.map((row) => row.event),
      [
        /* Pass 1: the trial ends, then immediately enters grace — two events, as §12 lists two states. */
        SUBSCRIPTION_EVENTS.TRIAL_ENDED,
        SUBSCRIPTION_EVENTS.GRACE_PERIOD_STARTED,
        /* Pass 3: the paid period lapses, then enters grace. */
        SUBSCRIPTION_EVENTS.PAST_DUE,
        SUBSCRIPTION_EVENTS.GRACE_PERIOD_STARTED,
        SUBSCRIPTION_EVENTS.EXPIRED,
        SUBSCRIPTION_EVENTS.STATE_CHANGED,
      ]
    );
    check(
      'each sweep school’s cached column moved with its subscription',
      await db.School.findAll({
        where: { id: created.schools.slice(1) },
        attributes: ['code', 'subscription_state'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      [
        { code: 'VSB-W1', subscription_state: SUBSCRIPTION_STATES.GRACE_PERIOD },
        { code: 'VSB-W2', subscription_state: SUBSCRIPTION_STATES.ACTIVE },
        { code: 'VSB-W3', subscription_state: SUBSCRIPTION_STATES.GRACE_PERIOD },
        { code: 'VSB-W4', subscription_state: SUBSCRIPTION_STATES.EXPIRED },
        { code: 'VSB-W5', subscription_state: SUBSCRIPTION_STATES.EXPIRING },
      ]
    );
    check(
      'and an expired school resolves to nothing usable, without a subscription being deleted',
      [
        (await snapshotOf(fixtures.sweepGrace.id)).subscription.isUsable,
        (await snapshotOf(fixtures.sweepGrace.id)).limits.student_limit.value,
        (await snapshotOf(fixtures.sweepGrace.id)).modules.students,
      ],
      [false, 100, true]
    );

    /* ─────────────────────────── the audit trail ─────────────────────────── */

    console.log('\n--- what the run left in the audit and activity logs ---');

    /*
     * `subscription_plans` is excluded by name: the four fixture plans are created through `/plans`,
     * whose own audit rows are `verify-plans.js`'s subject. A `startsWith('subscription')` filter
     * catches them, and that is what this run's first pass reported.
     */
    const OWNED_TABLES = ['subscriptions', 'subscription_addons', 'subscription_overrides'];
    const auditRows = await settle(
      () => db.AuditLog.findAll({
        where: { id: { [db.Op.gt]: baseline.auditLog } },
        attributes: ['table_name', 'event', 'user_id', 'reason'],
        order: [['id', 'ASC']],
        raw: true,
      }),
      /* Settled once all three owned tables are present — the strongest of the four assertions
       * below. Counting distinct names across every row would settle early, because the fixture
       * plans' `subscription_plans` rows are in this window too. */
      (rows) => new Set(
        rows.filter((row) => OWNED_TABLES.includes(row.table_name)).map((row) => row.table_name)
      ).size >= OWNED_TABLES.length
    );
    const subscriptionAudit = auditRows.filter((row) => OWNED_TABLES.includes(row.table_name));
    check(
      'each of the three tables this module writes through a route is audited',
      [...new Set(subscriptionAudit.map((row) => row.table_name))].sort(),
      OWNED_TABLES.slice().sort()
    );
    check(
      'and the events are creates and updates, never a delete — nothing here is destroyed',
      [...new Set(subscriptionAudit.map((row) => row.event))].sort(),
      ['create', 'update']
    );
    check(
      'the reason a caller gave lands on the audit row, not only in the response message',
      subscriptionAudit.some((row) => row.reason === 'School closed'),
      true
    );
    /*
     * `recordAudit(null, …)` is what the sweep calls, and `requestFields()` is skipped when there is
     * no request — so the sweep's rows carry a null actor rather than borrowing the last caller's.
     */
    check(
      'the sweep’s audit rows are attributed to no user',
      subscriptionAudit.some((row) => row.user_id === null),
      true
    );

    const activityRows = await settleDistinct(
      () => db.ActivityLog.findAll({
        where: { id: { [db.Op.gt]: baseline.activityLog }, entity_type: 'subscription' },
        attributes: ['action', 'entity_id'],
        raw: true,
      }),
      'action',
      2
    );
    check(
      'every declared subscription write left one activity row, and only writes did',
      [...new Set(activityRows.map((row) => row.action))].sort(),
      ['create', 'update']
    );
    check(
      'and the rows point at real subscriptions, so an activity feed can link to them',
      activityRows.every((row) => created.subscriptions.includes(Number(row.entity_id))),
      true
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ═══════════════════════════════ main ═══════════════════════════════ */

async function main() {
  verifySchemas();
  verifyRouting();
  verifyTransitionTable();
  verifyPricing();
  verifyDerived();

  console.log('\n--- fixtures ---');
  await recoverFromDeadRun();
  const addonCount = await captureBaseline();
  /* The mark and the add-on columns are captured and not yet touched — the moment the journal is true. */
  writeJournal(JOURNAL, { addons: seeded.addons, addonPrice: baseline.addonPrice });
  check('the seven §11.3 add-ons are seeded and captured for restoration', addonCount, 7);
  check(
    'the database holds no subscription before this run, so the sweep counts can be exact',
    baseline.subscriptionCount,
    0
  );

  try {
    const users = await createFixtures();
    check('four users, one organization and six schools are created', users, 4);

    await verifyHttp();
  } finally {
    await removeFixtures();

    /* The restores, asserted — a suite that leaves the seed data edited is worse than one that fails. */
    check(
      'the seeded add-ons are back as they were, block size included',
      await db.Addon.findAll({ attributes: ADDON_COLUMNS, order: [['id', 'ASC']], raw: true }),
      seeded.addons.map((row) =>
        ADDON_COLUMNS.reduce((acc, column) => ({ ...acc, [column]: row[column] }), {})
      )
    );
    check(
      'the add-on prices this run created are gone',
      await db.AddonPrice.count(),
      baseline.addonPriceCount
    );
    check(
      'no fixture plan, school, organization, user or subscription is left behind',
      [
        await db.SubscriptionPlan.count({ where: { code: { [db.Op.like]: 'VSB-%' } }, paranoid: false }),
        await db.School.count({ where: { code: { [db.Op.like]: 'VSB-%' } }, paranoid: false }),
        await db.Organization.count({ where: { code: 'VSB-GROUP' }, paranoid: false }),
        await db.User.count({ where: { email: { [db.Op.like]: `%@${DOMAIN}` } }, paranoid: false }),
        await db.Subscription.count(),
      ],
      [0, 0, 0, 0, 0]
    );

    console.log(
      failures === 0
        ? '\nAll subscriptions module checks passed.'
        : `\n${failures} check(s) FAILED.`
    );

    await db.sequelize.close();
    process.exit(failures === 0 ? 0 : 1);
  }
}

main().catch(async (error) => {
  console.error('\nverify-subscriptions.js could not complete:', error);
  failures += 1;
  try {
    await removeFixtures();
    await db.sequelize.close();
  } catch {
    /* the original error is what matters */
  }
  process.exit(1);
});
