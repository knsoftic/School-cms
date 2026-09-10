'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *
 *   RATE_LIMIT_MAX       raised past what this script sends. `apiLimiter` is mounted globally and this
 *   AUTH_RATE_LIMIT_MAX  run makes a few hundred calls; the limiter's own behaviour is verified in
 *                        scripts/verify-middlewares.js and is not what is under test here.
 *   BCRYPT_ROUNDS=10     two fixture hashes. 10 keeps the run short; the shipped default is 12.
 *   PASSWORD_MIN_LENGTH  pinned so nothing here depends on the local .env.
 *   MAIL_DRIVER=log      nothing in this module sends mail, but a stray SMTP attempt would hang the run.
 *   CACHE_TTL=600        the whole point of the invalidation assertions is that a plan edit bites
 *                        *before* the TTL expires. A short TTL would let them pass for the wrong reason.
 */
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.BCRYPT_ROUNDS = '10';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';
process.env.CACHE_TTL = '600';

/**
 * Verification of the plans module — `src/modules/plans/*`.
 *
 * Covers SRS §10.2 (Plan Builder), §10.3 (Billing Cycles), §10.4 (Pricing Models), §11.1 (Modules and
 * features), §11.2 (Limits) and FR-SUB-001 … FR-SUB-007, plus SRS §30 Rule 1 — *"Subscription plans,
 * modules, limits and prices must be database-driven"*.
 *
 * ## What is asserted, and why each part exists
 *
 *  - **Part 1 — the schemas, directly.** The decisions no HTTP response can show. That `status` is
 *    **refused** on create, update and duplicate, with a message naming FR-SUB-004 and FR-SUB-005 as
 *    the operations that do write it. It was *stripped* until triage finding 11: the outcome was the
 *    same either way, since the service hard-codes `inactive`, but a caller sending the seven fields
 *    §10.2 names got a 201 whose status disagreed with their body and no way to tell. That the `settings` map survives `stripUnknown: true` —
 *    a bare `Joi.object()` there would arrive as `{}` with no error, which is the footgun
 *    `plans.validation.js` documents. And the eight §11.2 limit keys being mandatory, with the
 *    rejection message naming the missing one.
 *
 *  - **Part 2 — the route table, by name.** `validateRequest`, `activityDeclaration` and
 *    `platformGuard` are plain named functions, so their presence is checkable without a request. This
 *    is where two properties are pinned: every write carries `platformGuard`, and `GET /catalogue` is
 *    declared *before* `GET /:id` — reverse those two and `/catalogue` is matched as an id and 422s.
 *    The permission guard is `asyncHandler`-wrapped and anonymous, so it is asserted in part 3 from its
 *    own 403 body.
 *
 *  - **Part 3 — over real HTTP, against the real database.** The lifecycle in the order FR-SUB-001 …
 *    FR-SUB-007 puts it in, the two refusals, tenant confinement of the reads, the price-retirement
 *    rule, the entitlement-cache invalidation, and the audit trail.
 *
 * ## The four assertions worth reading before changing anything
 *
 *  - **A new plan is inactive, and asking for `active` is refused rather than ignored.**
 *    `subscription_plans.status` defaults to `active` at the column, so the inactive birth only holds
 *    because `plans.service.create()` overrides it — asserted here, and separately from the refusal,
 *    so removing the override would still fail even though the schema would still reject the field. A
 *    plan born active would be advertised as available for new subscriptions while holding no price
 *    and no limits — and an absent `plan_limits` row resolves to **zero**, not to unlimited, so it
 *    would permit its schools nothing. Whether the SRS *wants* `status` accepted on create is a
 *    separate and still-open question (SRS-TRIAGE-VERDICTS.md finding 11); this pins only that the
 *    answer today is disclosed rather than silent.
 *
 *  - **Activating a priceless plan is refused.** `PLAN_NOT_PRICEABLE`, 409. A subscription denormalises
 *    its billing terms from a `plan_prices` row, so an active plan with no active price is an offer the
 *    system cannot fulfil.
 *
 *  - **A limit change bites on the next resolve, not after the TTL.** A subscription is created for
 *    school A on the plan, the snapshot is read, `PUT /:id/limits` changes `student_limit`, and the
 *    snapshot is read again. With `CACHE_TTL=600` a missing `entitlementService.invalidatePlan()` would
 *    leave the old ceiling enforced for ten minutes. The same shape is asserted for modules, and for a
 *    plain `PATCH /:id` rename — the snapshot caches the plan's `name`, so even a rename must flush.
 *
 *  - **A price row in use is deactivated, not deleted.** `subscriptions.plan_price_id` is `SET NULL`, so
 *    deleting a referenced row would not fail — it would quietly blank a live subscription's pointer
 *    back to the price it was quoted. The replacement retains it with `is_active = false` instead, and
 *    the response says how many.
 *
 * ## Fixtures
 *
 * Two users under `@verify-plans.local` (a platform Super Admin and a Principal), one organization and
 * one school, and every plan the run creates. All hard-deleted at the end — `subscription_plans` is
 * paranoid, so the cleanup passes `force: true` or the rows would survive as soft-deleted clutter.
 *
 * One *seeded* row is mutated and restored: the `principal` role's grant set, which gains `plans.view`
 * for the read-confinement assertions. It is captured before the run and written back in
 * `removeFixtures()` unconditionally, so an abort mid-run still leaves the role as it found it. The
 * restore is asserted, not assumed.
 *
 * `logger.warn` / `logger.error` lines during the run are expected: every deliberate 403 and 409 logs,
 * and every plan write logs an entitlement-cache flush at info level.
 *
 * Run: node scripts/verify-plans.js
 */

const db = require('../src/models');
const { sweepResidue, readJournal, writeJournal, clearJournal } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const permissionService = require('../src/services/permissionService');
const entitlementService = require('../src/services/entitlementService');
const plansService = require('../src/modules/plans/plans.service');
const {
  ROLES,
  USER_STATUS,
  PLAN_STATUS,
  PLAN_VISIBILITY,
  BILLING_CYCLES,
  PRICING_MODELS,
  MODULES,
  LIMITS,
  LIMIT_LIST,
  LIMIT_TYPES,
  LIMIT_UNITS,
  SUBSCRIPTION_STATES,
} = require('../src/config/constants');
const { DEFAULT_ROLE_PERMISSIONS } = require('../src/config/permissions');

const planRoutes = require('../src/modules/plans/plans.routes');
const { schemas } = require('../src/modules/plans/plans.validation');
const { settle, settleDistinct } = require('./lib/settle');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-plans.local';
/** The journal this suite writes its seeded-grant capture to — see scripts/lib/residue.js. */
const JOURNAL = 'verify-plans';
const PASSWORD = 'Verify@Plans123';

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${
      ok ? '' : `  (expected ${JSON.stringify(expected)})`
    }`
  );
}

/* ═══════════════════════════ part 1 — the schemas ═══════════════════════════ */

/** Validate against one schema and report the outcome in a shape an assertion can name. */
function run(schema, value) {
  const { error, value: cleaned } = schema.validate(value, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });
  return {
    ok: !error,
    value: cleaned,
    messages: error ? error.details.map((detail) => detail.message) : [],
  };
}

/** A complete, valid §11.2 limit set — the shape `PUT /:id/limits` demands. */
function allLimits(overrides = {}) {
  return LIMIT_LIST.map((key) => ({
    limit_key: key,
    limit_type: LIMIT_TYPES.FIXED,
    limit_value: 100,
    ...(overrides[key] || {}),
  }));
}

function verifyPlanSchemas() {
  console.log('\n--- schemas: the plan record (FR-SUB-001, FR-SUB-002) ---');

  const created = run(schemas.create, {
    name: 'Starter',
    code: 'starter-2026',
    tier_rank: 10,
  });
  check('a plan validates with a name and a code', created.ok, true);
  check('the code is uppercased before it reaches a unique index', created.value.code, 'STARTER-2026');

  /*
   * `status` is REFUSED, not stripped — triage finding 11 applied.
   *
   * These three assertions used to read "status is stripped, not refused" and pinned the opposite
   * behaviour. Stripping was never wrong about the *outcome* — the service hard-codes `inactive`
   * either way — but §10.2:385 and FR-SUB-001:412 both name Status among the fields a Super Admin
   * submits, so a caller sending it got a 201 whose status disagreed with their body, silently. That
   * is the shape `coupons.validation.js:60-62` argues against in this same codebase.
   *
   * Refusing settles the disclosure and settles nothing else: whether `status` should be *accepted*
   * on create is still open, and stays open, in SRS-TRIAGE-VERDICTS.md finding 11.
   */
  const withStatus = run(schemas.create, {
    name: 'Starter',
    code: 'starter-2026',
    status: PLAN_STATUS.ACTIVE,
  });
  check('a create naming status is refused rather than silently discarding it', withStatus.ok, false);
  check(
    '  with a message naming the operations that do write it',
    withStatus.messages.some((m) => m.includes('FR-SUB-004') && m.includes('FR-SUB-005')),
    true
  );

  check('a name alone is not enough', run(schemas.create, { name: 'Starter' }).ok, false);
  check(
    'a code with a space is refused',
    run(schemas.create, { name: 'Starter', code: 'STAR TER' }).ok,
    false
  );

  check('an empty edit is refused', run(schemas.update, {}).ok, false);
  check(
    'and it says what to do about it',
    run(schemas.update, {}).messages,
    ['Provide at least one field to update']
  );
  check(
    'status is not reachable through the edit either, and is refused there too',
    run(schemas.update, { name: 'Starter Plus', status: PLAN_STATUS.ARCHIVED }).ok,
    false
  );
  check(
    'nor is archived_at, which FR-SUB-005 derives',
    Object.prototype.hasOwnProperty.call(
      run(schemas.update, { name: 'Starter Plus', archived_at: null }).value,
      'archived_at'
    ),
    false
  );
  check(
    'nor duplicated_from_id, which would assert a lineage that never happened',
    Object.prototype.hasOwnProperty.call(
      run(schemas.update, { name: 'Starter Plus', duplicated_from_id: 3 }).value,
      'duplicated_from_id'
    ),
    false
  );

  console.log('\n--- schemas: duplicate (FR-SUB-003) ---');

  check('a duplicate needs its own code', run(schemas.duplicate, {}).ok, false);
  check('a code alone is enough — the name falls back to "(Copy)"', run(schemas.duplicate, { code: 'X2' }).ok, true);
  check(
    'and the copy cannot be born active — asking is refused, not ignored',
    run(schemas.duplicate, { code: 'X2', status: PLAN_STATUS.ACTIVE }).ok,
    false
  );

  console.log('\n--- schemas: pricing (FR-SUB-006, SRS §10.3 / §10.4) ---');

  check(
    'a plan may legally offer no prices at all — a new plan has none',
    run(schemas.setPrices, { prices: [] }).ok,
    true
  );
  check('and prices defaults to an empty set rather than being required', run(schemas.setPrices, {}).value, {
    prices: [],
  });

  const fixedMonthly = {
    billing_cycle: BILLING_CYCLES.MONTHLY,
    pricing_model: PRICING_MODELS.FIXED,
    base_amount: 49,
  };
  check('a fixed monthly price validates', run(schemas.setPrices, { prices: [fixedMonthly] }).ok, true);
  check(
    'a fixed price with no base amount does not — FR-SUB-006 requires "a price for each"',
    run(schemas.setPrices, {
      prices: [{ billing_cycle: BILLING_CYCLES.MONTHLY, pricing_model: PRICING_MODELS.FIXED }],
    }).ok,
    false
  );
  check(
    'a student-based price needs a unit amount',
    run(schemas.setPrices, {
      prices: [{ billing_cycle: BILLING_CYCLES.YEARLY, pricing_model: PRICING_MODELS.STUDENT_BASED }],
    }).ok,
    false
  );
  check(
    'a custom price needs a custom amount',
    run(schemas.setPrices, {
      prices: [{ billing_cycle: BILLING_CYCLES.YEARLY, pricing_model: PRICING_MODELS.CUSTOM }],
    }).ok,
    false
  );
  check(
    'custom_days is the one cycle whose length is not implied by its name',
    run(schemas.setPrices, {
      prices: [
        { billing_cycle: BILLING_CYCLES.CUSTOM_DAYS, pricing_model: PRICING_MODELS.FIXED, base_amount: 5 },
      ],
    }).ok,
    false
  );
  check(
    'and it validates once the length is given',
    run(schemas.setPrices, {
      prices: [
        {
          billing_cycle: BILLING_CYCLES.CUSTOM_DAYS,
          cycle_days: 45,
          pricing_model: PRICING_MODELS.FIXED,
          base_amount: 5,
        },
      ],
    }).ok,
    true
  );

  /* §10.4's Student-Based bands are several rows for one cycle, so the identity of a price is the
   * whole tuple — which is why `unique('billing_cycle')` would have been wrong. */
  const bands = [
    {
      billing_cycle: BILLING_CYCLES.YEARLY,
      pricing_model: PRICING_MODELS.STUDENT_BASED,
      unit_amount: 4,
      tier_min_units: 0,
      tier_max_units: 500,
    },
    {
      billing_cycle: BILLING_CYCLES.YEARLY,
      pricing_model: PRICING_MODELS.STUDENT_BASED,
      unit_amount: 3,
      tier_min_units: 501,
      tier_max_units: null,
    },
  ];
  check('two student-based bands on one billing cycle are legal', run(schemas.setPrices, { prices: bands }).ok, true);
  check(
    'the same band twice is not',
    run(schemas.setPrices, { prices: [bands[0], bands[0]] }).ok,
    false
  );
  check(
    'an inverted band is refused',
    run(schemas.setPrices, {
      prices: [
        {
          billing_cycle: BILLING_CYCLES.YEARLY,
          pricing_model: PRICING_MODELS.STUDENT_BASED,
          unit_amount: 4,
          tier_min_units: 500,
          tier_max_units: 100,
        },
      ],
    }).ok,
    false
  );
  check(
    'two default prices are refused — "pre-selected option when subscribing" is singular',
    run(schemas.setPrices, {
      prices: [
        { ...fixedMonthly, is_default: true },
        { ...fixedMonthly, billing_cycle: BILLING_CYCLES.YEARLY, is_default: true },
      ],
    }).ok,
    false
  );
  check(
    'an amount past DECIMAL(14,2) is refused rather than reaching the driver',
    run(schemas.setPrices, { prices: [{ ...fixedMonthly, base_amount: 1e15 }] }).ok,
    false
  );

  console.log('\n--- schemas: modules and features (FR-SUB-007, SRS §11.1) ---');

  check(
    'a module outside the twenty is refused — nothing here is free text',
    run(schemas.setModules, { modules: [{ module_key: 'telepathy' }] }).ok,
    false
  );
  check(
    'a module named twice is refused',
    run(schemas.setModules, {
      modules: [{ module_key: MODULES.STUDENTS }, { module_key: MODULES.STUDENTS }],
    }).ok,
    false
  );

  /*
   * The footgun `plans.validation.js` documents. `validate.js` runs body schemas with
   * `stripUnknown: true`, which takes precedence over `.unknown(true)` — so a bare `Joi.object()` here
   * would hand the service `settings: {}` with no error to explain where the keys went.
   */
  const withSettings = run(schemas.setModules, {
    modules: [{ module_key: MODULES.STUDENTS, settings: { photoRequired: true, nested: { a: 1 } } }],
  });
  check('a settings map survives stripUnknown', withSettings.ok, true);
  check('with its keys intact', withSettings.value.modules[0].settings, {
    photoRequired: true,
    nested: { a: 1 },
  });

  const feature = run(schemas.setFeatures, {
    features: [{ feature_key: 'Custom_Domain', is_enabled: true }],
  });
  check(
    'a feature key is lowercased, so ADDON_EFFECTS can match what it claims to unlock',
    feature.value.features[0].feature_key,
    'custom_domain'
  );
  check(
    'a feature key with a space is refused',
    run(schemas.setFeatures, { features: [{ feature_key: 'custom domain' }] }).ok,
    false
  );

  console.log('\n--- schemas: limits (FR-SUB-007, SRS §11.2) ---');

  check('the complete set of eight validates', run(schemas.setLimits, { limits: allLimits() }).ok, true);

  const partial = run(schemas.setLimits, {
    limits: allLimits().filter((limit) => limit.limit_key !== LIMITS.TEACHER_LIMIT),
  });
  check('a partial set is refused — an omitted limit resolves to zero, not to "leave alone"', partial.ok, false);
  check(
    'and the refusal names the missing key',
    partial.messages.some((message) => message.includes(LIMITS.TEACHER_LIMIT)),
    true
  );

  check(
    'a fixed limit with no value is refused',
    run(schemas.setLimits, {
      limits: allLimits({ [LIMITS.AI_LIMIT]: { limit_value: undefined } }),
    }).ok,
    false
  );
  check(
    'an unlimited limit carrying a value is refused — a number nothing will read is a trap',
    run(schemas.setLimits, {
      limits: allLimits({ [LIMITS.AI_LIMIT]: { limit_type: LIMIT_TYPES.UNLIMITED, limit_value: 50 } }),
    }).ok,
    false
  );
  check(
    'an unlimited limit with no value validates',
    run(schemas.setLimits, {
      limits: allLimits({ [LIMITS.AI_LIMIT]: { limit_type: LIMIT_TYPES.UNLIMITED, limit_value: null } }),
    }).ok,
    true
  );
  check(
    'allowed overage with no rate is refused — a null rate is free, unlimited excess',
    run(schemas.setLimits, {
      limits: allLimits({ [LIMITS.STUDENT_LIMIT]: { allow_overage: true } }),
    }).ok,
    false
  );
  check(
    'and zero is accepted, so free overage stays possible as a decision',
    run(schemas.setLimits, {
      limits: allLimits({
        [LIMITS.STUDENT_LIMIT]: { allow_overage: true, overage_unit_amount: 0 },
      }),
    }).ok,
    true
  );
  check(
    'unit is not accepted from the caller — it is a property of the limit',
    Object.prototype.hasOwnProperty.call(
      run(schemas.setLimits, { limits: allLimits({ [LIMITS.STORAGE_LIMIT]: { unit: 'gigabytes' } }) })
        .value.limits[4],
      'unit'
    ),
    false
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

const WRITES = [
  ['post', '/'],
  ['patch', '/:id'],
  ['post', '/:id/duplicate'],
  ['post', '/:id/activate'],
  ['post', '/:id/deactivate'],
  ['post', '/:id/archive'],
  ['put', '/:id/prices'],
  ['put', '/:id/modules'],
  ['put', '/:id/features'],
  ['put', '/:id/limits'],
];

const READS = [
  ['get', '/catalogue'],
  ['get', '/'],
  ['get', '/:id'],
];

function verifyRouting() {
  console.log('\n--- routing: the declared surface ---');

  /*
   * The declaration *order* is asserted, not just the set. `/catalogue` and `/:id` are both
   * one-segment GETs, so Express would match `/catalogue` against `/:id` first if these were reversed,
   * and the request would fail id validation instead of reaching the handler.
   */
  check('the plans module declares thirteen routes, in this order', routesOf(planRoutes), [
    'GET /catalogue',
    'GET /',
    'POST /',
    'GET /:id',
    'PATCH /:id',
    'POST /:id/duplicate',
    'POST /:id/activate',
    'POST /:id/deactivate',
    'POST /:id/archive',
    'PUT /:id/prices',
    'PUT /:id/modules',
    'PUT /:id/features',
    'PUT /:id/limits',
  ]);
  check(
    'GET /catalogue is declared before GET /:id, or it would be matched as an id',
    routesOf(planRoutes).indexOf('GET /catalogue') < routesOf(planRoutes).indexOf('GET /:id'),
    true
  );

  /* FR-SUB-005 Archive is the source's removal operation, and `subscriptions.plan_id` is RESTRICT. */
  check(
    'and there is no DELETE — FR-SUB-005 Archive is the specified removal',
    routesOf(planRoutes).some((route) => route.startsWith('DELETE')),
    false
  );

  check(
    'every write carries requirePlatformScope — §10 and §11 actor the Super Admin throughout',
    WRITES.filter(([method, path]) => !named(planRoutes, method, path, 'platformGuard')),
    []
  );
  check(
    'and no read does, so §12.3 can let a school read the catalogue later',
    READS.filter(([method, path]) => named(planRoutes, method, path, 'platformGuard')),
    []
  );
  check(
    'every write validates its body',
    WRITES.filter(([method, path]) => !named(planRoutes, method, path, 'validateRequest')),
    []
  );
  check(
    'every write declares an activity row',
    WRITES.filter(([method, path]) => !named(planRoutes, method, path, 'activityDeclaration')),
    []
  );
  check(
    'and no read does — a read is not an activity worth a row here',
    READS.filter(([method, path]) => named(planRoutes, method, path, 'activityDeclaration')),
    []
  );
  check(
    'GET /catalogue needs no validation: it takes nothing',
    named(planRoutes, 'get', '/catalogue', 'validateRequest'),
    false
  );
}

/* ═══════════════════════════════ fixtures ═══════════════════════════════ */

const fixtures = {};
const seeded = {};
const baseline = {};
const created = { users: [], schools: [], organizations: [], plans: [], subscriptions: [] };

async function captureBaseline() {
  baseline.activityLog = (await db.ActivityLog.max('id')) || 0;
  baseline.auditLog = (await db.AuditLog.max('id')) || 0;
  return true;
}

async function createFixtures() {
  const roles = {};
  for (const slug of [ROLES.SUPER_ADMIN, ROLES.PRINCIPAL]) {
    roles[slug] = await db.Role.findOne({ where: { slug } });
    if (!roles[slug]) throw new Error(`The ${slug} role is missing — run the seeders first.`);
  }
  fixtures.roles = roles;

  /* Captured before anything writes, and restored unconditionally at the end. */
  seeded.principalGrants = (
    await db.RolePermission.findAll({
      where: { role_id: roles[ROLES.PRINCIPAL].id },
      attributes: ['permission_id'],
      raw: true,
    })
  ).map((row) => row.permission_id);

  const org = await db.Organization.create({ name: 'Verify Plans Group', code: 'VPL-GROUP' });
  created.organizations.push(org.id);
  fixtures.org = org;

  const school = await db.School.create({
    organization_id: org.id,
    name: 'Verify Plans School',
    code: 'VPL-S1',
  });
  created.schools.push(school.id);
  fixtures.school = school;

  const password_hash = await hashPassword(PASSWORD);

  const people = [
    ['platform', ROLES.SUPER_ADMIN, 'Verify Plans Platform Admin', 'vpl_platform', null, null],
    ['principal', ROLES.PRINCIPAL, 'Verify Plans Principal', 'vpl_principal', org.id, school.id],
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

  /* The seeded row this run mutates, put back whether or not the run reached the restore. */
  await restoreGrants();

  if (created.subscriptions.length) {
    await db.Subscription.destroy({ where: { id: created.subscriptions } });
  }

  /*
   * Every plan the run created, including any duplicate whose id the script never captured — a failed
   * assertion mid-run must not leave rows behind for the next one to trip over. `force: true` because
   * `subscription_plans` is paranoid; the four child tables cascade.
   */
  await db.SubscriptionPlan.destroy({
    where: { code: { [db.Op.like]: 'VPL-%' } },
    force: true,
    paranoid: false,
  });

  if (created.users.length) await db.User.destroy({ where: { id: created.users }, force: true });
  if (created.schools.length) await db.School.destroy({ where: { id: created.schools }, force: true });
  if (created.organizations.length) {
    await db.Organization.destroy({ where: { id: created.organizations }, force: true });
  }

  await entitlementService.invalidateAll();
  /* The grants are back, so the journal that would have restored them is no longer owed. */
  clearJournal(JOURNAL);
}

/**
 * Put the principal role's grants back exactly as captured. Shared by `removeFixtures()` and the
 * recovery below; the role is looked up rather than read from `fixtures`, which the recovery path has
 * not built yet.
 */
async function restoreGrants() {
  if (!seeded.principalGrants) return;
  const principal = await db.Role.findOne({ where: { slug: ROLES.PRINCIPAL } });
  await db.RolePermission.destroy({ where: { role_id: principal.id } });
  await db.RolePermission.bulkCreate(
    seeded.principalGrants.map((permission_id) => ({ role_id: principal.id, permission_id }))
  );
  await permissionService.invalidateRole(principal.id);
}

/**
 * Recover from a run killed before its `finally`. A dead run leaves the principal holding `plans.view`,
 * and without this the next run would capture that as the seeded grant set and restore it for ever —
 * see `scripts/lib/residue.js`. The journal predates the mutation, so it is the set to put back.
 */
async function recoverFromDeadRun() {
  const pending = readJournal(JOURNAL);
  if (pending) {
    Object.assign(seeded, pending);
    await restoreGrants();
    clearJournal(JOURNAL);
    delete seeded.principalGrants;
    console.log('(restored the principal grants a killed earlier run left mutated)');
  }
  const residueCleared = await sweepResidue(db, { codes: ['VPL-'], domains: [DOMAIN] });
  if (residueCleared) {
    console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
  }
}

/** Grant one extra key to the seeded `principal` role, live. */
async function grantToPrincipal(key) {
  const roleId = fixtures.roles[ROLES.PRINCIPAL].id;
  const [permission] = await permissionService.findPermissionsByKeys([key]);
  await db.RolePermission.findOrCreate({
    where: { role_id: roleId, permission_id: permission.id },
    defaults: { role_id: roleId, permission_id: permission.id },
  });
  await permissionService.invalidateRole(roleId);
}

/* ═══════════════════════════ part 3 — over HTTP ═══════════════════════════ */

async function verifyHttp() {
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  async function call(path, { method = 'GET', body, token } = {}) {
    const headers = { 'Content-Type': 'application/json' };
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

  try {
    console.log('\n--- the boundary: /plans sits below it ---');

    const anonymous = await call('/plans');
    check('an unauthenticated read is refused', anonymous.status, 401);
    check('with the code for a missing bearer token, not a permission one', codeOf(anonymous), 'TOKEN_MISSING');

    const platform = await signIn(`platform@${DOMAIN}`);
    const principal = await signIn(`principal@${DOMAIN}`);
    check('the platform admin signs in', typeof platform, 'string');
    check('and the principal signs in', typeof principal, 'string');

    /*
     * The behavioural assertion for `requirePermission`. The guard is `asyncHandler`-wrapped and
     * anonymous, so its presence cannot be checked by name in part 2 — only from its own 403 body.
     * `DEFAULT_ROLE_PERMISSIONS` gives the principal role no `plans.*` key at all.
     */
    console.log('\n--- permissions: no plans.* key reaches a school role by default ---');
    check(
      'the seeded principal role holds no plans permission',
      DEFAULT_ROLE_PERMISSIONS[ROLES.PRINCIPAL].filter((key) => key.startsWith('plans.')),
      []
    );
    const deniedRead = await call('/plans', { token: principal });
    check('so the principal cannot read the catalogue', deniedRead.status, 403);
    check('and the guard says which key was missing', codeOf(deniedRead), 'INSUFFICIENT_PERMISSION');
    check(
      'naming plans.view',
      deniedRead.body.error.details.missing,
      ['plans.view']
    );

    /* ───────────────────────── FR-SUB-001 — Create Plan ───────────────────────── */

    console.log('\n--- FR-SUB-001: a new plan is inactive, whatever the caller asked for ---');

    const createRes = await call('/plans', {
      method: 'POST',
      token: platform,
      body: {
        name: 'Verify Plans Starter',
        code: 'vpl-starter',
        description: 'Created by scripts/verify-plans.js',
        visibility: PLAN_VISIBILITY.PUBLIC,
        tier_rank: 10,
        trial_days: 14,
        grace_period_days: 7,
      },
    });
    check('the plan is created', createRes.status, 201);
    const plan = dataOf(createRes).plan;
    created.plans.push(plan.id);

    check('the code is stored uppercase', plan.code, 'VPL-STARTER');
    check('and the plan is born inactive — FR-SUB-004 is the only way to active', plan.status,
      PLAN_STATUS.INACTIVE);

    /*
     * Over HTTP as well as at the schema, because `validate.js` is what turns a `forbidden()` into a
     * 422 and a schema assertion alone would not prove the middleware surfaces it. The body used to
     * carry `status: active` and this suite asserted the response came back `inactive` — which was
     * true, and was the silent discard triage finding 11 named.
     */
    const bornActive = await call('/plans', {
      method: 'POST',
      token: platform,
      body: { name: 'Verify Plans Born Active', code: 'vpl-born', status: PLAN_STATUS.ACTIVE },
    });
    check('a create naming status is refused over HTTP', bornActive.status, 422);
    check('  naming the field', bornActive.body.error.details[0].field, 'status');
    check('with no archive stamp', plan.archived_at, null);
    check('it carries no prices yet', plan.prices, []);
    check('no modules', plan.modules, []);
    check('and no limits', plan.limits, []);
    check('so it is not subscribable', plan.readiness.subscribable, false);
    check('and readiness names all eight unconfigured limits', plan.readiness.unconfiguredLimits, [
      ...LIMIT_LIST,
    ]);

    const duplicateCode = await call('/plans', {
      method: 'POST',
      token: platform,
      body: { name: 'Another', code: 'VPL-STARTER' },
    });
    check('a repeated code is a 409', duplicateCode.status, 409);
    check('with a code the frontend can branch on', codeOf(duplicateCode), 'PLAN_CODE_TAKEN');

    const notPlatform = await call('/plans', {
      method: 'POST',
      token: principal,
      body: { name: 'School-made', code: 'VPL-NOPE' },
    });
    check('a school-scoped caller cannot create a plan', notPlatform.status, 403);
    check(
      'and the scope guard answers before the permission guard',
      codeOf(notPlatform),
      'PLATFORM_SCOPE_REQUIRED'
    );

    /* ───────────────────── FR-SUB-004 — activation needs a price ───────────────────── */

    console.log('\n--- FR-SUB-004: activation requires something to sell ---');

    const prematureActivate = await call(`/plans/${plan.id}/activate`, {
      method: 'POST',
      token: platform,
    });
    check('activating a priceless plan is refused', prematureActivate.status, 409);
    check('with PLAN_NOT_PRICEABLE', codeOf(prematureActivate), 'PLAN_NOT_PRICEABLE');
    check(
      'and it points at FR-SUB-006 rather than just saying no',
      prematureActivate.body.error.message.includes('FR-SUB-006'),
      true
    );

    /* ──────────────────── FR-SUB-006 — pricing (§10.3, §10.4) ──────────────────── */

    console.log('\n--- FR-SUB-006: pricing and billing cycles ---');

    const pricesRes = await call(`/plans/${plan.id}/prices`, {
      method: 'PUT',
      token: platform,
      body: {
        prices: [
          {
            billing_cycle: BILLING_CYCLES.MONTHLY,
            pricing_model: PRICING_MODELS.FIXED,
            currency: 'usd',
            base_amount: 49,
            is_default: true,
            display_order: 1,
          },
          {
            billing_cycle: BILLING_CYCLES.YEARLY,
            pricing_model: PRICING_MODELS.FIXED,
            base_amount: 499,
            display_order: 2,
          },
          {
            billing_cycle: BILLING_CYCLES.CUSTOM_DAYS,
            cycle_days: 45,
            pricing_model: PRICING_MODELS.STUDENT_BASED,
            unit_amount: 2.5,
            tier_min_units: 0,
            tier_max_units: 500,
            display_order: 3,
          },
        ],
      },
    });
    check('three prices are stored', pricesRes.status, 200);
    const priced = dataOf(pricesRes);
    check('all three created', priced.created, 3);
    check('none deleted', priced.deleted, 0);
    check('none retired', priced.retired, 0);
    check('the currency is uppercased', priced.plan.prices[0].currency, 'USD');
    check('the default price is the monthly one', priced.plan.prices[0].billing_cycle, BILLING_CYCLES.MONTHLY);
    check('and readiness now sees a default', priced.plan.readiness.hasDefaultPrice, true);
    check('but the plan is still not subscribable while inactive', priced.plan.readiness.subscribable, false);

    const badPrice = await call(`/plans/${plan.id}/prices`, {
      method: 'PUT',
      token: platform,
      body: { prices: [{ billing_cycle: BILLING_CYCLES.MONTHLY, pricing_model: PRICING_MODELS.FIXED }] },
    });
    check('a fixed price with no amount is a 422, not a 500', badPrice.status, 422);
    check('from the validator', codeOf(badPrice), 'VALIDATION_ERROR');

    /* ─────────────────── FR-SUB-007 — modules, features, limits ─────────────────── */

    console.log('\n--- FR-SUB-007: modules, features and limits ---');

    const modulesRes = await call(`/plans/${plan.id}/modules`, {
      method: 'PUT',
      token: platform,
      body: {
        modules: [
          { module_key: MODULES.STUDENTS, is_enabled: true, settings: { photoRequired: true } },
          { module_key: MODULES.ATTENDANCE, is_enabled: true },
          { module_key: MODULES.LIBRARY, is_enabled: false },
        ],
      },
    });
    check('three module rows are stored', modulesRes.status, 200);
    check('two of them enabled', dataOf(modulesRes).plan.readiness.enabledModuleCount, 2);
    check(
      'and the settings map survived the round trip to a LONGTEXT column',
      dataOf(modulesRes).plan.modules.find((row) => row.module_key === MODULES.STUDENTS).settings,
      { photoRequired: true }
    );

    const featuresRes = await call(`/plans/${plan.id}/features`, {
      method: 'PUT',
      token: platform,
      body: {
        features: [
          { feature_key: 'Custom_Domain', name: 'Custom domain', is_enabled: true },
          { feature_key: 'report_retention', name: 'Report retention', is_enabled: true, value: '24' },
        ],
      },
    });
    check('two features are stored', featuresRes.status, 200);
    check(
      'with the key lowercased so ADDON_EFFECTS can match it',
      dataOf(featuresRes).plan.features.map((row) => row.feature_key).sort(),
      ['custom_domain', 'report_retention']
    );

    const partialLimits = await call(`/plans/${plan.id}/limits`, {
      method: 'PUT',
      token: platform,
      body: { limits: allLimits().slice(0, 7) },
    });
    check('seven of the eight limits is refused', partialLimits.status, 422);

    const limitsRes = await call(`/plans/${plan.id}/limits`, {
      method: 'PUT',
      token: platform,
      body: {
        limits: allLimits({
          [LIMITS.STUDENT_LIMIT]: { limit_value: 500, allow_overage: true, overage_unit_amount: 1.5 },
          [LIMITS.TEACHER_LIMIT]: { limit_value: 40 },
          [LIMITS.AI_LIMIT]: { limit_type: LIMIT_TYPES.UNLIMITED, limit_value: null },
          [LIMITS.STORAGE_LIMIT]: { limit_value: 2048, unit: 'gigabytes' },
        }),
      },
    });
    check('all eight limits are stored', limitsRes.status, 200);
    const limited = dataOf(limitsRes).plan;
    check('with nothing left unconfigured', limited.readiness.unconfiguredLimits, []);
    check(
      'the unit is derived, not taken from the caller',
      limited.limits.find((row) => row.limit_key === LIMITS.STORAGE_LIMIT).unit,
      LIMIT_UNITS[LIMITS.STORAGE_LIMIT]
    );
    check(
      'an unlimited limit stores no number',
      limited.limits.find((row) => row.limit_key === LIMITS.AI_LIMIT).limit_value,
      null
    );

    /* ────────────────── FR-SUB-004 — activate, deactivate, archive ────────────────── */

    console.log('\n--- FR-SUB-004 / FR-SUB-005: the status transitions ---');

    const activated = await call(`/plans/${plan.id}/activate`, { method: 'POST', token: platform });
    check('a priced plan activates', activated.status, 200);
    check('reaching active', dataOf(activated).plan.status, PLAN_STATUS.ACTIVE);
    check('and it is now subscribable', dataOf(activated).plan.readiness.subscribable, true);

    /* ─────────────────── the reads, and what a school may see ─────────────────── */

    console.log('\n--- reads: scopeFor() confines a non-platform caller ---');

    /* A private, inactive plan the principal must not see under any filter. */
    const privateRes = await call('/plans', {
      method: 'POST',
      token: platform,
      body: {
        name: 'Verify Plans Bespoke',
        code: 'vpl-bespoke',
        visibility: PLAN_VISIBILITY.PRIVATE,
      },
    });
    const privatePlan = dataOf(privateRes).plan;
    created.plans.push(privatePlan.id);

    await grantToPrincipal('plans.view');
    const principalWithView = await signIn(`principal@${DOMAIN}`);

    const schoolList = await call('/plans?limit=100', { token: principalWithView });
    check('the principal can now read the catalogue', schoolList.status, 200);
    const visibleCodes = dataOf(schoolList).map((row) => row.code);
    check('and sees the active public plan', visibleCodes.includes('VPL-STARTER'), true);
    check('but not the private one', visibleCodes.includes('VPL-BESPOKE'), false);
    check(
      'nor anything that is not active',
      dataOf(schoolList).every(
        (row) => row.status === PLAN_STATUS.ACTIVE && row.visibility === PLAN_VISIBILITY.PUBLIC
      ),
      true
    );

    const privateFetch = await call(`/plans/${privatePlan.id}`, { token: principalWithView });
    check('a private plan is "not found" rather than forbidden', privateFetch.status, 404);
    check('with the not-found code', codeOf(privateFetch), 'PLAN_NOT_FOUND');

    /* A filter must not widen a scope. `?status=archived` from a school caller returns nothing. */
    const widened = await call(`/plans?status=${PLAN_STATUS.ARCHIVED}`, { token: principalWithView });
    check('a status filter cannot widen the scope it was given', dataOf(widened), []);
    check(
      'and the platform admin sees the private plan the principal could not',
      dataOf(await call('/plans?limit=100', { token: platform })).some((row) => row.code === 'VPL-BESPOKE'),
      true
    );

    const catalogueRes = await call('/plans/catalogue', { token: platform });
    check('GET /catalogue is matched as a literal, not as an id', catalogueRes.status, 200);
    check('and publishes the eight §11.2 limit keys', dataOf(catalogueRes).limits.map((row) => row.key), [
      ...LIMIT_LIST,
    ]);
    check('with the twenty §11.1 modules', dataOf(catalogueRes).modules.length, 20);
    check(
      'and the seven §10.3 billing cycles, custom_days carrying no fixed length',
      dataOf(catalogueRes).billingCycles.find((row) => row.cycle === BILLING_CYCLES.CUSTOM_DAYS).days,
      null
    );

    /* ─────────── the entitlement cache: a plan edit bites on the next resolve ─────────── */

    console.log('\n--- SRS §30 Rule 1: a plan edit reaches the entitlement snapshot at once ---');

    const now = new Date();
    const subscription = await db.Subscription.create({
      school_id: fixtures.school.id,
      organization_id: fixtures.org.id,
      plan_id: plan.id,
      plan_price_id: priced.plan.prices[0].id,
      state: SUBSCRIPTION_STATES.ACTIVE,
      billing_cycle: BILLING_CYCLES.MONTHLY,
      pricing_model: PRICING_MODELS.FIXED,
      currency: 'USD',
      cycle_amount: 49,
      starts_at: now,
      current_period_start: now,
      current_period_end: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
    });
    created.subscriptions.push(subscription.id);
    await entitlementService.invalidateSchool(fixtures.school.id);

    const first = await entitlementService.getSnapshot(fixtures.school.id);
    check('the school resolves against the plan', first.plan.code, 'VPL-STARTER');
    check('its student limit is what the plan says', first.limits.student_limit.value, 500);
    check('the students module is on', first.modules[MODULES.STUDENTS], true);
    check('the library module is off', first.modules[MODULES.LIBRARY], false);
    check('and the unlimited AI limit resolves as unlimited', first.limits.ai_limit.type, LIMIT_TYPES.UNLIMITED);

    await call(`/plans/${plan.id}/limits`, {
      method: 'PUT',
      token: platform,
      body: {
        limits: allLimits({
          [LIMITS.STUDENT_LIMIT]: { limit_value: 900 },
          [LIMITS.AI_LIMIT]: { limit_type: LIMIT_TYPES.UNLIMITED, limit_value: null },
        }),
      },
    });
    const afterLimits = await entitlementService.getSnapshot(fixtures.school.id);
    check(
      'a limit change is visible immediately, not after CACHE_TTL',
      afterLimits.limits.student_limit.value,
      900
    );

    await call(`/plans/${plan.id}/modules`, {
      method: 'PUT',
      token: platform,
      body: { modules: [{ module_key: MODULES.STUDENTS, is_enabled: false }] },
    });
    const afterModules = await entitlementService.getSnapshot(fixtures.school.id);
    check('a module change too', afterModules.modules[MODULES.STUDENTS], false);
    check(
      'and a module removed from the set resolves as absent, which is off',
      afterModules.modules[MODULES.ATTENDANCE],
      false
    );

    /* The snapshot caches the plan's `name`, so even a rename has to flush. */
    await call(`/plans/${plan.id}`, {
      method: 'PATCH',
      token: platform,
      body: { name: 'Verify Plans Starter Renamed' },
    });
    const afterRename = await entitlementService.getSnapshot(fixtures.school.id);
    check('and a plain rename flushes it as well', afterRename.plan.name, 'Verify Plans Starter Renamed');

    /* ───────────── FR-SUB-006 — a price in use is retired, not deleted ───────────── */

    console.log('\n--- FR-SUB-006: a price a subscription points at survives its own removal ---');

    const inUsePriceId = priced.plan.prices[0].id;
    const replaced = await call(`/plans/${plan.id}/prices`, {
      method: 'PUT',
      token: platform,
      body: {
        prices: [
          {
            billing_cycle: BILLING_CYCLES.MONTHLY,
            pricing_model: PRICING_MODELS.FIXED,
            base_amount: 59,
            is_default: true,
          },
        ],
      },
    });
    check('the replacement succeeds', replaced.status, 200);
    check('one new price created', dataOf(replaced).created, 1);
    check('the two unreferenced rows deleted', dataOf(replaced).deleted, 2);
    check('and the referenced one retired instead', dataOf(replaced).retired, 1);
    check(
      'the message says so, rather than leaving an operator to count rows',
      replaced.body.message.includes('deactivated rather than removed'),
      true
    );

    const survivor = await db.PlanPrice.findByPk(inUsePriceId);
    check('the retained row is still there', Boolean(survivor), true);
    check('deactivated', survivor.is_active, false);
    check('and no longer pre-selected', survivor.is_default, false);

    const stillPointing = await db.Subscription.findByPk(subscription.id);
    check(
      'so the subscription still points at the price it was quoted',
      Number(stillPointing.plan_price_id),
      Number(inUsePriceId)
    );

    /* ───────────────────────── FR-SUB-003 — Duplicate ───────────────────────── */

    console.log('\n--- FR-SUB-003: a duplicate copies the whole configuration ---');

    const dup = await call(`/plans/${plan.id}/duplicate`, {
      method: 'POST',
      token: platform,
      body: { code: 'vpl-starter-copy' },
    });
    check('the copy is created', dup.status, 201);
    const copy = dataOf(dup).plan;
    created.plans.push(copy.id);

    check('with the code the caller chose', copy.code, 'VPL-STARTER-COPY');
    check('a name derived from the source', copy.name, 'Verify Plans Starter Renamed (Copy)');
    check('the lineage recorded', Number(copy.duplicated_from_id), Number(plan.id));
    check('and inactive, whatever the source was', copy.status, PLAN_STATUS.INACTIVE);
    check('not inheriting the recommendation', copy.is_recommended, false);

    /*
     * Two prices, not one: the source holds the new price *and* the row retired above, and
     * `duplicate()` copies the price table as it stands rather than filtering to the active rows. That
     * is the honest reading of "duplicate" — the copy's retired row is inactive and not the default, so
     * it is invisible in the catalogue, and an operator who wants it gone can say so. Filtering here
     * would silently drop configuration the source screen shows.
     */
    check('the whole price table copied, retired row included', copy.prices.length, 2);
    check('one of them still active', copy.prices.filter((row) => row.is_active).length, 1);
    check('the modules copied', copy.modules.length, 1);
    check('the features copied', copy.features.length, 2);
    check('the limits copied', copy.limits.length, LIMIT_LIST.length);
    check('and the counts reported', dataOf(dup).copied, {
      prices: 2,
      modules: 1,
      features: 2,
      limits: LIMIT_LIST.length,
    });

    const sourceAfter = await db.PlanPrice.findAll({ where: { plan_id: plan.id }, attributes: ['id'], raw: true });
    check(
      'and every copied price is a new row, sharing none with the source',
      copy.prices.some((row) => sourceAfter.some((src) => Number(src.id) === Number(row.id))),
      false
    );

    const dupConflict = await call(`/plans/${plan.id}/duplicate`, {
      method: 'POST',
      token: platform,
      body: { code: 'VPL-STARTER-COPY' },
    });
    check('duplicating onto a taken code is a 409', dupConflict.status, 409);
    check('and nothing is left behind by the rolled-back transaction', codeOf(dupConflict), 'PLAN_CODE_TAKEN');
    check(
      'the copy count is unchanged, so the failed duplicate created no plan',
      await db.SubscriptionPlan.count({ where: { code: 'VPL-STARTER-COPY' } }),
      1
    );

    /* ────────────────── FR-SUB-005 — archive, and back again ────────────────── */

    console.log('\n--- FR-SUB-005: archiving is retention, not deletion ---');

    const archived = await call(`/plans/${plan.id}/archive`, {
      method: 'POST',
      token: platform,
      body: { reason: 'Replaced by the 2027 catalogue' },
    });
    check('the plan archives', archived.status, 200);
    check('reaching archived', dataOf(archived).plan.status, PLAN_STATUS.ARCHIVED);
    check('with a stamp', typeof dataOf(archived).plan.archived_at, 'string');
    check('and it is no longer subscribable', dataOf(archived).plan.readiness.subscribable, false);

    /* FR-SUB-005 governs availability for *new* subscriptions; the existing one is untouched. */
    const stillUsable = await entitlementService.getSnapshot(fixtures.school.id);
    check('the school already on the plan keeps its entitlement', stillUsable.plan.code, 'VPL-STARTER');
    check('and its limits', stillUsable.limits.student_limit.value, 900);

    const reactivated = await call(`/plans/${plan.id}/activate`, { method: 'POST', token: platform });
    check('an archived plan can be brought back', reactivated.status, 200);
    check(
      'and the stamp is cleared, so status and archived_at never disagree',
      dataOf(reactivated).plan.archived_at,
      null
    );

    const deactivated = await call(`/plans/${plan.id}/deactivate`, {
      method: 'POST',
      token: platform,
      body: { reason: 'Paused while pricing is reviewed' },
    });
    check('and deactivating is never blocked by an existing subscription', deactivated.status, 200);
    check('reaching inactive', dataOf(deactivated).plan.status, PLAN_STATUS.INACTIVE);

    /* ─────────── the five permission keys are five, not one wearing five names ─────────── */

    console.log('\n--- permissions: the five plans.* keys are enforced separately ---');

    await fixtures.platform.update({ denied_permissions: ['plans.pricing.manage'] });
    const deniedPricing = await call(`/plans/${plan.id}/prices`, {
      method: 'PUT',
      token: platform,
      body: { prices: [] },
    });
    check('a denied plans.pricing.manage blocks the pricing route', deniedPricing.status, 403);
    check('with the permission code', codeOf(deniedPricing), 'INSUFFICIENT_PERMISSION');
    check(
      'and the limits route is unaffected, so the keys are not interchangeable',
      (
        await call(`/plans/${plan.id}/limits`, {
          method: 'PUT',
          token: platform,
          body: { limits: allLimits() },
        })
      ).status,
      200
    );
    await fixtures.platform.update({ denied_permissions: [] });

    /* ────────────────────────────── the audit trail ────────────────────────────── */

    console.log('\n--- SRS §29: what the run wrote to audit_logs and activity_logs ---');

    const audits = await settleDistinct(
      () =>
        db.AuditLog.findAll({
          where: { id: { [db.Op.gt]: baseline.auditLog } },
          attributes: ['table_name', 'event', 'record_id', 'reason'],
          raw: true,
        }),
      'table_name',
      5
    );
    const tables = [...new Set(audits.map((row) => row.table_name))].sort();
    check('every plan table the run touched is audited', tables, [
      'plan_features',
      'plan_limits',
      'plan_modules',
      'plan_prices',
      'subscription_plans',
    ]);
    check(
      'the archive reason lands in audit_logs.reason, where §29 puts it',
      audits.some((row) => row.reason === 'Replaced by the 2027 catalogue'),
      true
    );
    check(
      'and the duplicate records what it was copied from',
      audits.some((row) => row.reason && row.reason.startsWith(`Duplicated from plan ${plan.id}`)),
      true
    );

    const activities = await settle(
      () =>
        db.ActivityLog.findAll({
          where: { id: { [db.Op.gt]: baseline.activityLog }, entity_type: 'plan' },
          attributes: ['action', 'description'],
          raw: true,
        }),
      (rows) => rows.filter((row) => row.action === 'create').length >= 2
    );
    check('the writes produced activity rows', activities.length > 0, true);
    check(
      'each with a description a human can read',
      activities.every((row) => typeof row.description === 'string' && row.description.length > 0),
      true
    );
    check(
      'and the create is recorded as a create, not as an update',
      activities.filter((row) => row.action === 'create').length >= 2,
      true
    );

    /*
     * The refusals must not leave rows. `onlyOnSuccess: true` is on every write, and the 403s and 409s
     * above would otherwise be recorded as though the operation had happened.
     */
    check(
      'no activity row was written for a refused write',
      activities.some((row) => row.description && row.description.includes('VPL-NOPE')),
      false
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ══════════════════ part 4 — the service, where HTTP cannot reach ══════════════════ */

/**
 * `scopeFor()` throws rather than returning `{}` when the tenant is missing.
 *
 * Unreachable over HTTP — `resolveTenant` always runs first — and that is exactly why it is asserted
 * here. If a future mount put `/plans` above index 4, the difference between throwing and defaulting to
 * an unscoped read is the difference between a 500 and every school reading every private plan.
 */
function verifyServiceScope() {
  console.log('\n--- service: scopeFor() refuses to run without a tenant ---');

  let threw = null;
  try {
    plansService.scopeFor(undefined);
  } catch (err) {
    threw = err.message;
  }
  check('an absent tenant throws', typeof threw, 'string');
  check('naming resolveTenant, so the cause is findable', threw.includes('resolveTenant'), true);

  check('a platform tenant is unscoped', plansService.scopeFor({ isPlatform: true }), {});
  check('and anyone else is confined to the active public plans', plansService.scopeFor({ isPlatform: false }), {
    status: PLAN_STATUS.ACTIVE,
    visibility: PLAN_VISIBILITY.PUBLIC,
  });

  /* The copy field lists are what stop a column added later from being copied silently. */
  check('the duplicate never copies an id', plansService.COPY_FIELDS.prices.includes('id'), false);
  check('nor a timestamp', plansService.COPY_FIELDS.prices.includes('created_at'), false);
  check(
    'and all three transitions are declared, so status and archived_at cannot drift',
    Object.keys(plansService.TRANSITIONS).sort(),
    [PLAN_STATUS.ACTIVE, PLAN_STATUS.ARCHIVED, PLAN_STATUS.INACTIVE].sort()
  );
}

/* ══════════════════════════════════ main ══════════════════════════════════ */

async function main() {
  verifyPlanSchemas();
  verifyRouting();
  verifyServiceScope();

  console.log('\n--- fixtures ---');
  await recoverFromDeadRun();
  check('the log tables are baselined before anything is written', await captureBaseline(), true);
  check('two users, one organization and one school created', await createFixtures(), 2);
  /* The grant set is captured and not yet mutated — the moment the journal is true. */
  writeJournal(JOURNAL, seeded);
  check(
    'and the seeded role this run mutates was captured for restoration',
    seeded.principalGrants.length,
    DEFAULT_ROLE_PERMISSIONS[ROLES.PRINCIPAL].length
  );

  await verifyHttp();
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nVerification aborted:', err);
  })
  .finally(async () => {
    try {
      await removeFixtures();
      console.log('\nFixtures removed, and the principal role put back.');

      /* The restore is asserted, not assumed — an abort mid-run must still leave the role as found. */
      const principalKeys = await permissionService.getRolePermissions(
        fixtures.roles[ROLES.PRINCIPAL].id
      );
      check(
        'the principal role holds its seeded grants again, without plans.view',
        principalKeys.slice().sort(),
        DEFAULT_ROLE_PERMISSIONS[ROLES.PRINCIPAL].slice().sort()
      );
      check(
        'and no plan the run created is left behind',
        await db.SubscriptionPlan.count({
          where: { code: { [db.Op.like]: 'VPL-%' } },
          paranoid: false,
        }),
        0
      );
    } catch (err) {
      failures += 1;
      console.error('Fixture cleanup failed:', err.message);
    }
    console.log(
      failures === 0 ? '\nAll plans module checks passed.' : `\n${failures} check(s) FAILED.`
    );
    await db.sequelize.close();
    process.exit(failures === 0 ? 0 : 1);
  });
