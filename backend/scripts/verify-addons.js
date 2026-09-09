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
 *   CACHE_TTL=600        load-bearing, and in the opposite direction from verify-plans.js. There the long
 *                        TTL proves an invalidation *happens*; here it proves an add-on edit needs none —
 *                        the snapshot is deliberately left cached and asserted unchanged. A short TTL
 *                        would let that pass by expiry instead of by design.
 */
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.BCRYPT_ROUNDS = '10';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';
process.env.CACHE_TTL = '600';

/**
 * Verification of the add-ons module — `src/modules/addons/*`.
 *
 * Covers SRS §11.3 (the seven add-ons) and FR-SUB-009 (*"Super Admin and/or school configure add-ons
 * purchasable in addition to the base plan"*), plus SRS §30 Rule 1 — add-on effects are read from the
 * database, never branched on by key.
 *
 * ## What is asserted, and why each part exists
 *
 *  - **Part 1 — the schemas, directly.** The six columns this module refuses to write, each with the
 *    message naming where its value actually comes from. `stripUnknown: true` would have dropped all six
 *    *silently*, which is the failure this part exists to rule out: an operator renaming an add-on would
 *    get a 200, see the new name, and have it reverted by the next seed run with nothing recorded.
 *
 *  - **Part 2 — the route table, by name.** Six routes, no `POST /` and no `DELETE /:id`. Every write
 *    carries `platformGuard`; no read does. The permission guard is `asyncHandler`-wrapped and anonymous,
 *    so it is asserted in part 4 from its own 403 body.
 *
 *  - **Part 3 — the service, directly.** `scopeFor()` throwing on an absent tenant, and `unitFor()`
 *    agreeing with `05-addons.js` about the `'count'` fallback. Also that `EFFECT_TYPES` — derived from
 *    `ADDON_EFFECTS` — is exactly the `addons.effect_type` ENUM, so a filter cannot name a kind no row
 *    can hold.
 *
 *  - **Part 4 — over real HTTP, against the real database.** FR-SUB-009 end to end, the scope
 *    confinement, the retire-not-delete rule, the audit trail, and the invalidation assertion below.
 *
 * ## The four assertions worth reading before changing anything
 *
 *  - **Editing an add-on does not disturb a resolved entitlement, and must not.** A school is subscribed,
 *    holds a `subscription_addons` row granting 500 extra students, and its snapshot is read. Then
 *    `PATCH /addons/:id` changes `units_per_quantity` from 1 to 50 — and the snapshot, re-read with
 *    `CACHE_TTL=600` still in force, is *identical*. This is the one module in the subscription area whose
 *    writes correctly invalidate nothing: `subscription_addons` copies `effect_type`, `effect_target` and
 *    `units_granted` at purchase, and `entitlementService` never joins `addons`. The run also asserts the
 *    `addons` row really did change, so the check cannot pass because the PATCH silently failed.
 *
 *  - **Deactivating an add-on withdraws the offer, not the grant.** The same school's snapshot still
 *    carries its 500 units after the add-on it bought is taken off sale — the retention rule FR-SUB-004
 *    applies to plans, applied here for the same reason.
 *
 *  - **A price row a purchase points at is deactivated, not deleted.** `subscription_addons.addon_price_id`
 *    is `SET NULL`, so deleting it would not fail — it would quietly blank the trail from a school's bill
 *    back to the price it was quoted. The replacement retains it with `is_active = false`, the response
 *    says how many, and the purchase's pointer is asserted to still resolve.
 *
 *  - **A filter cannot widen a scope.** The principal is granted `addons.view`, so it can read the
 *    catalogue — and `?is_active=false` returns *nothing* rather than the deactivated add-ons, because
 *    `scopeFor()` has already confined it to the active ones.
 *
 * ## Fixtures
 *
 * Two users under `@verify-addons.local` (a platform Super Admin and a Principal), one organization, one
 * school, one plan (`VAD-PLAN`, created through `/plans` rather than by hand so the fixture path is one
 * the plans suite already verifies), one subscription and one `subscription_addons` row.
 *
 * Two *seeded* things are mutated and restored:
 *
 *   1. **The seven `addons` rows and every `addon_prices` row.** There is no `POST /addons` — SRS §11.3
 *      fixes the set — so this suite has no choice but to write the seeded rows. Every column of all seven
 *      is captured before the run and written back in `removeFixtures()`, along with a full rebuild of
 *      `addon_prices` from the captured snapshot, ids included. Both restores are asserted, not assumed.
 *   2. **The `principal` role's grant set**, which gains `addons.view` and `addons.manage`.
 *
 * All three restores run unconditionally in a `finally`, so an abort mid-run still leaves the database as
 * it found it.
 *
 * `logger.warn` / `logger.error` lines during the run are expected: every deliberate 401, 403, 404 and 422
 * logs.
 *
 * Run: node scripts/verify-addons.js
 */

const db = require('../src/models');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const permissionService = require('../src/services/permissionService');
const entitlementService = require('../src/services/entitlementService');
const addonsService = require('../src/modules/addons/addons.service');
const {
  ROLES,
  USER_STATUS,
  BILLING_CYCLES,
  PRICING_MODELS,
  PLAN_VISIBILITY,
  LIMITS,
  LIMIT_LIST,
  LIMIT_TYPES,
  LIMIT_UNITS,
  ADDONS,
  ADDON_LIST,
  ADDON_EFFECTS,
  SUBSCRIPTION_STATES,
} = require('../src/config/constants');
const { DEFAULT_ROLE_PERMISSIONS } = require('../src/config/permissions');

const addonRoutes = require('../src/modules/addons/addons.routes');
const { schemas, EFFECT_TYPES } = require('../src/modules/addons/addons.validation');

const { settle } = require('./lib/settle');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-addons.local';
const PASSWORD = 'Verify@Addons123';

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

/** The six columns FR-SUB-009 does not put in the operator's hands, and the word that proves each. */
const REFUSED = [
  ['key', 'SRS §11.3'],
  ['name', 'seed run'],
  ['effect_type', 'ADDON_EFFECTS'],
  ['effect_target', 'ADDON_EFFECTS'],
  ['unit', 'LIMIT_UNITS'],
  ['is_active', 'deactivate'],
];

function verifyAddonSchemas() {
  console.log('\n--- schemas: what FR-SUB-009 may and may not change ---');

  const edited = run(schemas.update, {
    description: 'Sold in blocks of 50.',
    units_per_quantity: 50,
    display_order: 3,
  });
  check('the three configurable fields validate together', edited.ok, true);
  check('and arrive intact', edited.value, {
    description: 'Sold in blocks of 50.',
    units_per_quantity: 50,
    display_order: 3,
  });

  check('an empty edit is refused', run(schemas.update, {}).ok, false);
  check('and it says what to do about it', run(schemas.update, {}).messages, [
    'Provide at least one field to update',
  ]);

  /*
   * The heart of part 1. Each of these six is *refused*, not stripped — `stripUnknown: true` would have
   * answered 200 having changed nothing, which is indistinguishable from success on the client side.
   */
  for (const [field, evidence] of REFUSED) {
    const result = run(schemas.update, { [field]: field === 'is_active' ? false : 'anything' });
    check(`${field} is refused, not silently dropped`, result.ok, false);
    check(
      `and the message says where ${field} comes from`,
      result.messages.length === 1 && result.messages[0].includes(evidence),
      true
    );
  }

  check(
    'a genuinely unknown key is still stripped, as everywhere else',
    run(schemas.update, { units_per_quantity: 5, nonsense: 1 }).value,
    { units_per_quantity: 5 }
  );

  /* SRS names no block sizes, so this is the field the add-ons screen exists to set. */
  check('a block size of zero is refused', run(schemas.update, { units_per_quantity: 0 }).ok, false);
  check(
    'and the message explains why, rather than quoting a bound',
    run(schemas.update, { units_per_quantity: 0 }).messages,
    ['"units_per_quantity" must be at least 1 — a block size of 0 would grant nothing']
  );
  check('one is allowed — the seeded value', run(schemas.update, { units_per_quantity: 1 }).ok, true);

  check(
    'the description can be cleared, which hands it back to the seeder',
    run(schemas.update, { description: null }).value,
    { description: null }
  );
  check(
    'but an empty string is not a way to clear it — it reads as an empty edit',
    run(schemas.update, { description: '' }).messages,
    ['Provide at least one field to update']
  );

  console.log('\n--- schemas: the availability switch (FR-SUB-009) ---');

  check('activate takes nothing', run(schemas.activate, {}).ok, true);
  check('and a stray body is stripped', run(schemas.activate, { reason: 'why' }).value, {});
  check(
    'deactivate keeps a reason, which lands in audit_logs.reason',
    run(schemas.deactivate, { reason: 'Withdrawn from sale' }).value,
    { reason: 'Withdrawn from sale' }
  );

  console.log('\n--- schemas: prices (§10.3 cycles, quantity pricing) ---');

  check('an empty price set is accepted, and is the seeded state', run(schemas.setPrices, {}).value, {
    prices: [],
  });

  const priced = run(schemas.setPrices, {
    prices: [
      { billing_cycle: BILLING_CYCLES.MONTHLY, currency: 'usd', unit_amount: 5 },
      { billing_cycle: BILLING_CYCLES.YEARLY, unit_amount: '50.00', plan_id: 7 },
    ],
  });
  check('two prices on different cycles validate', priced.ok, true);
  check('the currency is uppercased', priced.value.prices[0].currency, 'USD');
  check('and a plan restriction survives', priced.value.prices[1].plan_id, 7);

  check(
    'a price with no amount is refused — §11.3 add-ons are sold by quantity',
    run(schemas.setPrices, { prices: [{ billing_cycle: BILLING_CYCLES.MONTHLY }] }).ok,
    false
  );
  check(
    'but zero is a real amount, so it is accepted',
    run(schemas.setPrices, {
      prices: [{ billing_cycle: BILLING_CYCLES.MONTHLY, unit_amount: 0 }],
    }).ok,
    true
  );

  check(
    'custom_days without a length is refused',
    run(schemas.setPrices, {
      prices: [{ billing_cycle: BILLING_CYCLES.CUSTOM_DAYS, unit_amount: 5 }],
    }).messages,
    ['"cycle_days" is required when the billing cycle is custom_days']
  );
  check(
    'and a length on a named cycle is refused too, rather than ignored',
    run(schemas.setPrices, {
      prices: [{ billing_cycle: BILLING_CYCLES.MONTHLY, cycle_days: 30, unit_amount: 5 }],
    }).messages,
    ['"cycle_days" may only be set when the billing cycle is custom_days']
  );

  /*
   * The set-level rule no `unique()` can express: a price is identified by its cycle *and* its plan
   * restriction, so the same cycle twice is ambiguous unless the restrictions differ.
   */
  check(
    'the same cycle twice is refused',
    run(schemas.setPrices, {
      prices: [
        { billing_cycle: BILLING_CYCLES.MONTHLY, unit_amount: 5 },
        { billing_cycle: BILLING_CYCLES.MONTHLY, unit_amount: 7 },
      ],
    }).messages,
    ['prices[1] repeats the billing cycle and plan restriction of an earlier entry']
  );
  check(
    'but the same cycle on a different plan is a different offer',
    run(schemas.setPrices, {
      prices: [
        { billing_cycle: BILLING_CYCLES.MONTHLY, unit_amount: 5, plan_id: 1 },
        { billing_cycle: BILLING_CYCLES.MONTHLY, unit_amount: 7 },
      ],
    }).ok,
    true
  );

  console.log('\n--- schemas: the list query ---');

  check('effect_type is limited to the two kinds an add-on can have', EFFECT_TYPES, [
    'limit_increase',
    'feature_unlock',
  ]);
  check('a third kind is refused', run(schemas.list, { effect_type: 'discount' }).ok, false);
  check('and both real ones pass', [
    run(schemas.list, { effect_type: 'limit_increase' }).ok,
    run(schemas.list, { effect_type: 'feature_unlock' }).ok,
  ], [true, true]);
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
  ['patch', '/:id'],
  ['post', '/:id/activate'],
  ['post', '/:id/deactivate'],
  ['put', '/:id/prices'],
];

const READS = [
  ['get', '/'],
  ['get', '/:id'],
];

function verifyRouting() {
  console.log('\n--- routing: the declared surface ---');

  check('the add-ons module declares six routes, in this order', routesOf(addonRoutes), [
    'GET /',
    'GET /:id',
    'PATCH /:id',
    'POST /:id/activate',
    'POST /:id/deactivate',
    'PUT /:id/prices',
  ]);

  /*
   * The two absences are the point of this module's shape, and both are asserted rather than left to the
   * header comment. SRS §11.3 fixes the seven — `addons.key` is unique and `isIn: [ADDON_LIST]` — so
   * there is nothing for a create endpoint to create; and `subscription_addons.addon_id` is RESTRICT, so
   * a purchased add-on cannot leave the table at all.
   */
  check(
    'there is no POST / — SRS §11.3 fixes the seven add-ons',
    routesOf(addonRoutes).includes('POST /'),
    false
  );
  check(
    'and no DELETE — deactivation is how an add-on comes off sale',
    routesOf(addonRoutes).some((route) => route.startsWith('DELETE')),
    false
  );

  check(
    'every write carries requirePlatformScope — addons has no school_id',
    WRITES.filter(([method, path]) => !named(addonRoutes, method, path, 'platformGuard')),
    []
  );
  check(
    'and no read does, because FR-SUB-009 actors a school as well as the Super Admin',
    READS.filter(([method, path]) => named(addonRoutes, method, path, 'platformGuard')),
    []
  );
  check(
    'every write validates its body',
    WRITES.filter(([method, path]) => !named(addonRoutes, method, path, 'validateRequest')),
    []
  );
  check(
    'every write declares an activity row',
    WRITES.filter(([method, path]) => !named(addonRoutes, method, path, 'activityDeclaration')),
    []
  );
  check(
    'and no read does — a read is not an activity worth a row here',
    READS.filter(([method, path]) => named(addonRoutes, method, path, 'activityDeclaration')),
    []
  );
  check(
    'both reads validate too: one a query, one an id',
    READS.filter(([method, path]) => !named(addonRoutes, method, path, 'validateRequest')),
    []
  );
}

/* ═══════════════════════ part 3 — the service, directly ═══════════════════════ */

/**
 * The two properties no HTTP request can show.
 *
 * `scopeFor()` throwing is unreachable over HTTP — `resolveTenant` always runs first — and that is
 * exactly why it is asserted here. If a future mount put `/addons` above index 4, the difference between
 * throwing and defaulting to `{}` is the difference between a 500 and every school reading the
 * deactivated catalogue.
 */
function verifyService() {
  console.log('\n--- service: scopeFor() refuses to run without a tenant ---');

  let threw = null;
  try {
    addonsService.scopeFor(undefined);
  } catch (err) {
    threw = err.message;
  }
  check('an absent tenant throws', typeof threw, 'string');
  check('naming resolveTenant, so the cause is findable', threw.includes('resolveTenant'), true);

  check('a platform tenant is unscoped', addonsService.scopeFor({ isPlatform: true }), {});
  check('and anyone else sees only what is on sale', addonsService.scopeFor({ isPlatform: false }), {
    is_active: true,
  });

  console.log('\n--- service: unit derivation agrees with the seeder ---');

  /*
   * `05-addons.js` writes `LIMIT_UNITS[effect.target] || 'count'` on insert. `unitFor()` has to produce
   * the same answer or a PATCH would silently disagree with the seeder about a column neither of them
   * lets an operator set.
   */
  check(
    'a student-limit add-on is counted',
    addonsService.unitFor({ effect_type: 'limit_increase', effect_target: LIMITS.STUDENT_LIMIT }),
    'count'
  );
  check(
    'a storage add-on is measured in megabytes',
    addonsService.unitFor({ effect_type: 'limit_increase', effect_target: LIMITS.STORAGE_LIMIT }),
    'megabytes'
  );
  check(
    'an AI add-on in requests',
    addonsService.unitFor({ effect_type: 'limit_increase', effect_target: LIMITS.AI_LIMIT }),
    'requests'
  );
  check(
    'a feature unlock grants no units, so it has no unit',
    addonsService.unitFor({ effect_type: 'feature_unlock', effect_target: 'custom_domain' }),
    null
  );
  check(
    'an unmapped limit target falls back to count, exactly as the seeder does',
    addonsService.unitFor({ effect_type: 'limit_increase', effect_target: 'not_a_limit' }),
    'count'
  );
  check(
    'and a prototype key is not a limit target',
    addonsService.unitFor({ effect_type: 'limit_increase', effect_target: 'constructor' }),
    'count'
  );

  console.log('\n--- service: the derived vocabulary matches the column ---');

  /* A filter must not be able to name a kind no row can hold, so the derived list is compared to the
   * ENUM the migration created. */
  check(
    'EFFECT_TYPES is exactly the addons.effect_type ENUM',
    EFFECT_TYPES.slice().sort(),
    db.Addon.rawAttributes.effect_type.values.slice().sort()
  );
  check(
    'and every one of the seven add-ons has one of those two effects',
    ADDON_LIST.filter((key) => !EFFECT_TYPES.includes(ADDON_EFFECTS[key].type)),
    []
  );

  check('display_order is the default sort — SRS §11.3 lists them in an order', addonsService.DEFAULT_SORT, [
    'display_order',
    'ASC',
  ]);
}

/* ═══════════════════════════════ fixtures ═══════════════════════════════ */

const fixtures = {};
const seeded = {};
const baseline = {};
const created = { users: [], schools: [], organizations: [], subscriptions: [], subscriptionAddons: [] };

/** Every column of every add-on, and every price row, exactly as found. */
const ADDON_COLUMNS = [
  'key',
  'name',
  'description',
  'effect_type',
  'effect_target',
  'units_per_quantity',
  'unit',
  'is_active',
  'display_order',
];

async function captureBaseline() {
  baseline.activityLog = (await db.ActivityLog.max('id')) || 0;
  baseline.auditLog = (await db.AuditLog.max('id')) || 0;

  seeded.addons = await db.Addon.findAll({ raw: true, order: [['id', 'ASC']] });
  seeded.addonPrices = await db.AddonPrice.findAll({ raw: true, order: [['id', 'ASC']] });

  return seeded.addons.length;
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

  const org = await db.Organization.create({ name: 'Verify Addons Group', code: 'VAD-GROUP' });
  created.organizations.push(org.id);
  fixtures.org = org;

  const school = await db.School.create({
    organization_id: org.id,
    name: 'Verify Addons School',
    code: 'VAD-S1',
  });
  created.schools.push(school.id);
  fixtures.school = school;

  const password_hash = await hashPassword(PASSWORD);

  const people = [
    ['platform', ROLES.SUPER_ADMIN, 'Verify Addons Platform Admin', 'vad_platform', null, null],
    ['principal', ROLES.PRINCIPAL, 'Verify Addons Principal', 'vad_principal', org.id, school.id],
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

  if (created.subscriptionAddons.length) {
    await db.SubscriptionAddon.destroy({ where: { id: created.subscriptionAddons } });
  }
  if (created.subscriptions.length) {
    await db.Subscription.destroy({ where: { id: created.subscriptions } });
  }

  /*
   * The seeded catalogue, put back column by column. This suite has to write these rows — SRS §11.3
   * fixes the set, so there is no fixture add-on to create instead — which makes the restore part of the
   * test rather than housekeeping.
   */
  if (seeded.addons) {
    for (const row of seeded.addons) {
      await db.Addon.update(
        ADDON_COLUMNS.reduce((acc, column) => ({ ...acc, [column]: row[column] }), {}),
        { where: { id: row.id } }
      );
    }
  }
  /*
   * The price rows, restored by id rather than by emptying the table. A blanket
   * `destroy({ where: {} })` would be simpler and wrong: `subscription_addons.addon_price_id` is
   * `SET NULL`, so it would silently blank the price pointer on any purchase row this run did not
   * create — the exact damage the retire-not-delete rule exists to prevent.
   */
  if (seeded.addonPrices) {
    const keep = seeded.addonPrices.map((row) => row.id);
    await db.AddonPrice.destroy({
      where: keep.length ? { id: { [db.Op.notIn]: keep } } : {},
    });

    for (const row of seeded.addonPrices) {
      const [, written] = await db.AddonPrice.upsert(row);
      /* `written` is null on MariaDB — the driver cannot tell an insert from an update — so nothing
       * is asserted from it here. The count check in the `finally` block covers the outcome. */
      void written;
    }
  }

  /* The plan the run created through /plans. `force: true` because subscription_plans is paranoid. */
  await db.SubscriptionPlan.destroy({
    where: { code: { [db.Op.like]: 'VAD-%' } },
    force: true,
    paranoid: false,
  });

  /* The seeded role this run mutates, put back whether or not the run reached the restore. */
  if (seeded.principalGrants) {
    const roleId = fixtures.roles[ROLES.PRINCIPAL].id;
    await db.RolePermission.destroy({ where: { role_id: roleId } });
    await db.RolePermission.bulkCreate(
      seeded.principalGrants.map((permission_id) => ({ role_id: roleId, permission_id }))
    );
    await permissionService.invalidateRole(roleId);
  }

  if (created.users.length) await db.User.destroy({ where: { id: created.users }, force: true });
  if (created.schools.length) await db.School.destroy({ where: { id: created.schools }, force: true });
  if (created.organizations.length) {
    await db.Organization.destroy({ where: { id: created.organizations }, force: true });
  }

  await entitlementService.invalidateAll();
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

/* ═══════════════════════════ part 4 — over HTTP ═══════════════════════════ */

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
  /*
   * `ApiError.validation` puts the flat array from `validate.js` straight on `error.details` — the
   * per-field records are `{ field, location, message, type }`, not `{ errors: [...] }`. Reading
   * `details.errors` here returned `[]` for every 422 and made three message assertions unfalsifiable.
   */
  const messagesOf = (res) =>
    res.body && res.body.error && Array.isArray(res.body.error.details)
      ? res.body.error.details.map((detail) => detail.message)
      : [];

  try {
    console.log('\n--- the boundary: /addons sits below it ---');

    const anonymous = await call('/addons');
    check('an unauthenticated read is refused', anonymous.status, 401);
    check(
      'with the code for a missing bearer token, not a permission one',
      codeOf(anonymous),
      'TOKEN_MISSING'
    );

    const platform = await signIn(`platform@${DOMAIN}`);
    const principal = await signIn(`principal@${DOMAIN}`);
    check('the platform admin signs in', typeof platform, 'string');
    check('and the principal signs in', typeof principal, 'string');

    /*
     * The behavioural assertion for `requirePermission`. The guard is `asyncHandler`-wrapped and
     * anonymous, so its presence cannot be checked by name in part 2 — only from its own 403 body.
     */
    console.log('\n--- permissions: no addons.* key reaches a school role by default ---');
    check(
      'the seeded principal role holds no addons permission',
      DEFAULT_ROLE_PERMISSIONS[ROLES.PRINCIPAL].filter((key) => key.startsWith('addons.')),
      []
    );
    const deniedRead = await call('/addons', { token: principal });
    check('so the principal cannot read the catalogue', deniedRead.status, 403);
    check('and the guard says which key was missing', codeOf(deniedRead), 'INSUFFICIENT_PERMISSION');
    check('naming addons.view', deniedRead.body.error.details.missing, ['addons.view']);

    /* ─────────────────── SRS §11.3 — the catalogue is what the seeder made ─────────────────── */

    console.log('\n--- SRS §11.3: seven add-ons, in the order the source lists them ---');

    const listed = await call('/addons?limit=100', { token: platform });
    check('the platform admin reads the catalogue', listed.status, 200);

    /*
     * `ApiResponse.paginated` puts the array at `data` itself and the counts under `meta.pagination`
     * — it is not `{ data: { rows, count } }`. The draft of this script assumed the latter and read
     * `dataOf(listed).rows`, which is `undefined`; the first `.some()` on it threw and aborted the run.
     */
    const rows = dataOf(listed);
    check('all seven SRS §11.3 add-ons are present', ADDON_LIST.filter(
      (key) => !rows.some((row) => row.key === key)
    ), []);
    check(
      'and the default sort is display_order, which the seeder set from §11.3',
      rows.filter((row) => ADDON_LIST.includes(row.key)).map((row) => row.key),
      [...ADDON_LIST]
    );

    /* SRS §30 Rule 1: the effect is data on the row, not a branch on the key. */
    check(
      'every row carries the effect entitlement resolves through',
      rows
        .filter((row) => ADDON_LIST.includes(row.key))
        .filter(
          (row) =>
            row.effect_type !== ADDON_EFFECTS[row.key].type ||
            row.effect_target !== ADDON_EFFECTS[row.key].target
        ),
      []
    );

    const students = rows.find((row) => row.key === ADDONS.EXTRA_STUDENTS);
    const domain = rows.find((row) => row.key === ADDONS.CUSTOM_DOMAIN);
    /* A third add-on, kept clear of the two above so the Known Issues #17 price set stands alone. */
    const storage = rows.find((row) => row.key === ADDONS.EXTRA_STORAGE);
    check('Extra Students raises a limit', students.effect_type, 'limit_increase');
    check('specifically the student limit', students.effect_target, LIMITS.STUDENT_LIMIT);
    check('Custom Domain unlocks a feature instead', domain.effect_type, 'feature_unlock');
    check('and therefore has no unit', domain.unit, null);

    check('a seeded add-on carries no prices yet', students.prices, []);
    check('so nothing is purchasable', students.readiness.purchasable, false);
    check('though it is on sale', students.is_active, true);

    const shown = await call(`/addons/${students.id}`, { token: platform });
    check('one add-on reads back on its own', shown.status, 200);
    check('with the same readiness block', dataOf(shown).addon.readiness, students.readiness);

    const missing = await call('/addons/99999999', { token: platform });
    check('an unknown id is a 404', missing.status, 404);
    check('with a code the frontend can branch on', codeOf(missing), 'ADDON_NOT_FOUND');

    /* ─────────────────── FR-SUB-009 — configure an add-on ─────────────────── */

    console.log('\n--- FR-SUB-009: the block size is the field this screen exists to set ---');

    /*
     * A number, not a string. `units_per_quantity` is `BIGINT`, and mysql2 hands BIGINT back as a JS
     * number here — confirmed through `toJSON()`, the raw attribute and a raw query, all three. The
     * draft of this script expected `'1'`; nothing in the stack stringifies it, and stringifying it in
     * `present()` would change a contract the entitlement arithmetic depends on for no requirement.
     */
    check('the seeder ships it at one, because SRS names no block sizes', students.units_per_quantity, 1);

    const patched = await call(`/addons/${students.id}`, {
      method: 'PATCH',
      token: platform,
      body: { units_per_quantity: 50, description: 'Sold in blocks of 50 students.' },
    });
    check('the edit is accepted', patched.status, 200);
    check('the block size is stored', dataOf(patched).addon.units_per_quantity, 50);
    check('the description with it', dataOf(patched).addon.description, 'Sold in blocks of 50 students.');
    check(
      'and the unit is re-derived, not taken from the body',
      dataOf(patched).addon.unit,
      LIMIT_UNITS[LIMITS.STUDENT_LIMIT]
    );

    const renamed = await call(`/addons/${students.id}`, {
      method: 'PATCH',
      token: platform,
      body: { name: 'Even More Students' },
    });
    check('renaming is refused rather than reverted by the next seed run', renamed.status, 422);
    check('as a validation error', codeOf(renamed), 'VALIDATION_ERROR');
    check(
      'and the message says the seeder would undo it',
      messagesOf(renamed).some((message) => message.includes('seed run')),
      true
    );

    const repointed = await call(`/addons/${students.id}`, {
      method: 'PATCH',
      token: platform,
      body: { effect_target: LIMITS.STORAGE_LIMIT },
    });
    check('repointing the effect is refused too', repointed.status, 422);
    check(
      'because it is what entitlement resolves through',
      messagesOf(repointed).some((message) => message.includes('ADDON_EFFECTS')),
      true
    );

    const switched = await call(`/addons/${students.id}`, {
      method: 'PATCH',
      token: platform,
      body: { is_active: false },
    });
    check('and so is flipping availability through the general edit', switched.status, 422);
    check(
      'which points at the two endpoints that record a reason',
      messagesOf(switched).some((message) => message.includes('deactivate')),
      true
    );

    const emptyEdit = await call(`/addons/${students.id}`, {
      method: 'PATCH',
      token: platform,
      body: {},
    });
    check('an empty edit is refused', emptyEdit.status, 422);

    /* ─────────────────── FR-SUB-009 — prices (§10.3 cycles) ─────────────────── */

    console.log('\n--- FR-SUB-009: what an add-on costs ---');

    const setTwo = await call(`/addons/${students.id}/prices`, {
      method: 'PUT',
      token: platform,
      body: {
        prices: [
          { billing_cycle: BILLING_CYCLES.MONTHLY, currency: 'USD', unit_amount: 5 },
          { billing_cycle: BILLING_CYCLES.YEARLY, currency: 'USD', unit_amount: 50 },
        ],
      },
    });
    check('two prices are written', setTwo.status, 200);
    check('and counted', [dataOf(setTwo).created, dataOf(setTwo).deleted, dataOf(setTwo).retired], [2, 0, 0]);
    check('the add-on now has two price rows', dataOf(setTwo).addon.prices.length, 2);
    check('so it is purchasable', dataOf(setTwo).addon.readiness.purchasable, true);
    check(
      'and both are unrestricted, so any plan can buy them',
      dataOf(setTwo).addon.readiness.unrestrictedPriceCount,
      2
    );

    const badPlan = await call(`/addons/${students.id}/prices`, {
      method: 'PUT',
      token: platform,
      body: {
        prices: [
          { billing_cycle: BILLING_CYCLES.MONTHLY, unit_amount: 5, plan_id: 99999999 },
        ],
      },
    });
    check('a price restricted to a plan that does not exist is refused', badPlan.status, 422);
    check('with a code, not a foreign-key error', codeOf(badPlan), 'ADDON_PRICE_PLAN_NOT_FOUND');
    check('naming the id that was wrong', badPlan.body.error.details.planIds, [99999999]);
    check(
      'and the refusal left the existing price set alone',
      (await db.AddonPrice.count({ where: { addon_id: students.id } })),
      2
    );

    /* ─────────────── scope: a write is platform-only, a read is not ─────────────── */

    console.log('\n--- scope: FR-SUB-009 actors a school for the read, the platform for the write ---');

    await grantToPrincipal('addons.view');
    await grantToPrincipal('addons.manage');

    const schoolWrite = await call(`/addons/${students.id}`, {
      method: 'PATCH',
      token: principal,
      body: { display_order: 99 },
    });
    check('a school-scoped caller cannot configure an add-on', schoolWrite.status, 403);
    check(
      'and the scope guard answers before the permission it now holds',
      codeOf(schoolWrite),
      'PLATFORM_SCOPE_REQUIRED'
    );

    const schoolRead = await call('/addons?limit=100', { token: principal });
    check('but it can read the catalogue, which FR-SUB-009 expects', schoolRead.status, 200);
    check(
      'seeing the seven',
      ADDON_LIST.filter((key) => !dataOf(schoolRead).some((row) => row.key === key)),
      []
    );

    const deactivated = await call(`/addons/${domain.id}/deactivate`, {
      method: 'POST',
      token: platform,
      body: { reason: 'Withdrawn from sale by scripts/verify-addons.js' },
    });
    check('an add-on is taken off sale', deactivated.status, 200);
    check('the row says so', dataOf(deactivated).addon.is_active, false);
    check('and it is no longer purchasable', dataOf(deactivated).addon.readiness.purchasable, false);
    check(
      'the message says the schools that bought it keep it',
      deactivated.body.message.includes('keep'),
      true
    );

    const afterOff = await call('/addons?limit=100', { token: principal });
    check(
      'the school no longer sees it — a deactivated add-on is not an offer',
      dataOf(afterOff).some((row) => row.key === ADDONS.CUSTOM_DOMAIN),
      false
    );
    const hiddenDirect = await call(`/addons/${domain.id}`, { token: principal });
    check('and asking for it directly is a 404, not a 403', hiddenDirect.status, 404);
    check('because the scope is folded into the lookup', codeOf(hiddenDirect), 'ADDON_NOT_FOUND');
    check(
      'while the platform admin still sees it',
      (await call(`/addons/${domain.id}`, { token: platform })).status,
      200
    );

    /*
     * A filter cannot widen a scope. The principal is already confined to the active add-ons, so asking
     * for the inactive ones has to return nothing rather than the row it was just denied.
     */
    const filtered = await call('/addons?limit=100&is_active=false', { token: principal });
    check('a school asking for the inactive add-ons gets none', dataOf(filtered), []);
    check(
      'and a count of zero, not a count of seven',
      filtered.body.meta.pagination.total,
      0
    );
    check(
      'whereas the platform admin gets the one that is off',
      (await call('/addons?limit=100&is_active=false', { token: platform })).body.data.map(
        (row) => row.key
      ),
      [ADDONS.CUSTOM_DOMAIN]
    );

    const effectFilter = await call(`/addons?limit=100&effect_type=feature_unlock`, {
      token: platform,
    });
    check(
      'the effect filter narrows to the two unlocks',
      dataOf(effectFilter)
        .map((row) => row.key)
        .sort(),
      [ADDONS.CUSTOM_DOMAIN, ADDONS.PREMIUM_REPORTS].sort()
    );

    const reactivated = await call(`/addons/${domain.id}/activate`, {
      method: 'POST',
      token: platform,
      body: {},
    });
    check('it goes back on sale without needing a price first', reactivated.status, 200);
    check(
      'which is the difference from a plan: a comped add-on is a shape the schema allows',
      dataOf(reactivated).addon.is_active,
      true
    );
    check('though it reports itself unpurchasable', dataOf(reactivated).addon.readiness.purchasable, false);

    /* ─────────── a subscribed school, and what an add-on edit does to it ─────────── */

    console.log('\n--- entitlement: a purchase copies the effect, so an edit cannot reach it ---');

    /* The plan is built through /plans, a path the plans suite already verifies. */
    const planRes = await call('/plans', {
      method: 'POST',
      token: platform,
      body: {
        name: 'Verify Addons Plan',
        code: 'VAD-PLAN',
        visibility: PLAN_VISIBILITY.PUBLIC,
      },
    });
    check('a plan is created for the subscription fixture', planRes.status, 201);
    const plan = dataOf(planRes).plan;

    const planPrices = await call(`/plans/${plan.id}/prices`, {
      method: 'PUT',
      token: platform,
      body: {
        prices: [
          {
            billing_cycle: BILLING_CYCLES.MONTHLY,
            pricing_model: PRICING_MODELS.FIXED,
            currency: 'USD',
            base_amount: 49,
          },
        ],
      },
    });
    check('and priced', planPrices.status, 200);

    const planLimits = await call(`/plans/${plan.id}/limits`, {
      method: 'PUT',
      token: platform,
      body: {
        limits: LIMIT_LIST.map((key) => ({
          limit_key: key,
          limit_type: LIMIT_TYPES.FIXED,
          limit_value: 100,
        })),
      },
    });
    check('with all eight §11.2 limits at 100', planLimits.status, 200);
    check(
      'and activated',
      (await call(`/plans/${plan.id}/activate`, { method: 'POST', token: platform, body: {} })).status,
      200
    );

    const now = new Date();
    const subscription = await db.Subscription.create({
      school_id: fixtures.school.id,
      organization_id: fixtures.org.id,
      plan_id: plan.id,
      plan_price_id: dataOf(planPrices).plan.prices[0].id,
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

    /*
     * The purchase. Every field entitlement reads is *copied here* — that copy is what makes an add-on
     * edit harmless, and it is why this module invalidates nothing.
     */
    const purchasedPrice = await db.AddonPrice.findOne({
      where: { addon_id: students.id, billing_cycle: BILLING_CYCLES.MONTHLY },
    });
    const purchase = await db.SubscriptionAddon.create({
      subscription_id: subscription.id,
      school_id: fixtures.school.id,
      addon_id: students.id,
      addon_price_id: purchasedPrice.id,
      quantity: 10,
      unit_amount: 5,
      currency: 'USD',
      effect_type: 'limit_increase',
      effect_target: LIMITS.STUDENT_LIMIT,
      units_granted: 500,
      status: 'active',
    });
    created.subscriptionAddons.push(purchase.id);
    await entitlementService.invalidateSchool(fixtures.school.id);

    const first = await entitlementService.getSnapshot(fixtures.school.id);
    check('the school resolves against the plan', first.plan.code, 'VAD-PLAN');
    check('its base student limit is what the plan says', first.limits.student_limit.baseValue, 100);
    check('the purchase adds its granted units', first.limits.student_limit.addonUnits, 500);
    check('so the ceiling is the sum', first.limits.student_limit.value, 600);

    /* ───────── Known Issues #17 — a school sees only the prices its plan can buy ───────── */

    /*
     * The defect: `detailInclude()` filtered `addon_prices` by `is_active` alone, so a school-scoped
     * read returned prices whose `plan_id` named a **different plan**. The purchase path already
     * refused them with `ADDON_PRICE_PLAN_MISMATCH` (asserted in `verify-subscriptions.js`), so the
     * hole was never in the write — it was a school reading a figure it could not act on.
     *
     * Three prices on one add-on, which is the smallest set that separates the two failure modes: a
     * filter that hides too much would drop the unrestricted row, and one that hides nothing would
     * keep the foreign row. A test with only two could pass while doing either.
     */
    const otherPlanRes = await call('/plans', {
      method: 'POST',
      token: platform,
      body: { name: 'Verify Addons Other Plan', code: 'VAD-OTHER', visibility: PLAN_VISIBILITY.PUBLIC },
    });
    check('a second plan exists to restrict a price to', otherPlanRes.status, 201);
    const otherPlan = dataOf(otherPlanRes).plan;

    const threePrices = await call(`/addons/${storage.id}/prices`, {
      method: 'PUT',
      token: platform,
      body: {
        prices: [
          { billing_cycle: BILLING_CYCLES.MONTHLY, currency: 'USD', unit_amount: 5 },
          { billing_cycle: BILLING_CYCLES.YEARLY, currency: 'USD', unit_amount: 50, plan_id: plan.id },
          { billing_cycle: BILLING_CYCLES.QUARTERLY, currency: 'USD', unit_amount: 15, plan_id: otherPlan.id },
        ],
      },
    });
    check('three prices are written — unrestricted, this plan, another plan', threePrices.status, 200);
    check(
      '  and the platform admin sees all three, because its catalogue is the whole catalogue',
      dataOf(threePrices).addon.prices.length,
      3
    );

    await entitlementService.invalidateSchool(fixtures.school.id);
    const schoolPrices = await call(`/addons/${storage.id}`, { token: principal });
    check('the school reads the add-on', schoolPrices.status, 200);
    const visible = (dataOf(schoolPrices).addon.prices || []).map((row) => row.billing_cycle).sort();
    check(
      'and sees the unrestricted price and its own plan’s, and not the other plan’s',
      visible,
      [BILLING_CYCLES.MONTHLY, BILLING_CYCLES.YEARLY].sort()
    );
    check(
      '  which is not vacuous — the row it cannot see exists and is active',
      await db.AddonPrice.count({
        where: { addon_id: storage.id, plan_id: otherPlan.id, is_active: true },
      }),
      1
    );
    /*
     * The list read goes through the same helper by a different call site, so both are asserted: a fix
     * applied to `findById` alone would leave the catalogue listing leaking.
     */
    const listedForPlan = await call('/addons?limit=100', { token: principal });
    const listedRow = (dataOf(listedForPlan) || []).find((row) => row.id === storage.id);
    check(
      'the list read is filtered too, not only the read by id',
      (listedRow.prices || []).map((row) => row.billing_cycle).sort(),
      [BILLING_CYCLES.MONTHLY, BILLING_CYCLES.YEARLY].sort()
    );

    /*
     * The headline assertion. `CACHE_TTL=600` is still in force and this module calls no `invalidate*`,
     * so an unchanged snapshot here is the *correct* result — the opposite of what verify-plans.js
     * asserts about a plan edit.
     */
    const bumped = await call(`/addons/${students.id}`, {
      method: 'PATCH',
      token: platform,
      body: { units_per_quantity: 1000 },
    });
    check('the block size is changed again', bumped.status, 200);
    check('and the catalogue row really did change', dataOf(bumped).addon.units_per_quantity, 1000);

    const second = await entitlementService.getSnapshot(fixtures.school.id);
    check(
      'but the resolved ceiling is untouched — subscription_addons holds the copy',
      second.limits.student_limit.value,
      600
    );
    check('down to the granted units', second.limits.student_limit.addonUnits, 500);
    check(
      'so no cache invalidation was owed, and none was made',
      JSON.stringify(second.limits.student_limit),
      JSON.stringify(first.limits.student_limit)
    );

    /* The retention rule, from the other direction. */
    const offSale = await call(`/addons/${students.id}/deactivate`, {
      method: 'POST',
      token: platform,
      body: { reason: 'Retention check' },
    });
    check('the add-on the school bought is taken off sale', offSale.status, 200);
    await entitlementService.invalidateSchool(fixtures.school.id);
    const third = await entitlementService.getSnapshot(fixtures.school.id);
    check(
      'and the school keeps what it paid for, even after a forced re-resolve',
      third.limits.student_limit.value,
      600
    );
    check(
      'because resolution reads subscription_addons.status, not addons.is_active',
      third.limits.student_limit.addonUnits,
      500
    );
    await call(`/addons/${students.id}/activate`, { method: 'POST', token: platform, body: {} });

    /* ─────────── the retire-not-delete rule for a referenced price ─────────── */

    console.log('\n--- prices: a row a purchase points at is retired, not deleted ---');

    const replaced = await call(`/addons/${students.id}/prices`, {
      method: 'PUT',
      token: platform,
      body: {
        prices: [{ billing_cycle: BILLING_CYCLES.QUARTERLY, currency: 'USD', unit_amount: 14 }],
      },
    });
    check('the price set is replaced', replaced.status, 200);
    check(
      'one written, one deleted, one retained',
      [dataOf(replaced).created, dataOf(replaced).deleted, dataOf(replaced).retired],
      [1, 1, 1]
    );
    check(
      'and the response says why the count does not match what was sent',
      replaced.body.message.includes('deactivated rather than removed'),
      true
    );

    const survivor = await db.AddonPrice.findByPk(purchasedPrice.id);
    check('the referenced row survived', survivor !== null, true);
    check('deactivated rather than deleted', survivor.is_active, false);

    const stillLinked = await db.SubscriptionAddon.findByPk(purchase.id);
    check(
      'so the purchase still points back at the price it was quoted',
      Number(stillLinked.addon_price_id),
      Number(purchasedPrice.id)
    );

    check(
      'the platform admin sees the retired row',
      (await call(`/addons/${students.id}`, { token: platform })).body.data.addon.prices.length,
      2
    );
    check(
      'the school sees only the live one — a retired price is history, not an offer',
      (await call(`/addons/${students.id}`, { token: principal })).body.data.addon.prices.map(
        (price) => price.billing_cycle
      ),
      [BILLING_CYCLES.QUARTERLY]
    );

    const emptied = await call(`/addons/${students.id}/prices`, {
      method: 'PUT',
      token: platform,
      body: { prices: [] },
    });
    check('an add-on can be returned to its seeded, priceless state', emptied.status, 200);
    check('the unreferenced row goes', dataOf(emptied).deleted, 1);
    check('the referenced one stays, retired', dataOf(emptied).retired, 1);
    check('and it reports itself unpurchasable again', dataOf(emptied).addon.readiness.purchasable, false);

    /* ───────────────────────────── the trail ───────────────────────────── */

    console.log('\n--- audit and activity: every write left a trail ---');

    /*
     * Read as model instances, not `raw: true` — the same trap `verify-users-roles.js` documents.
     * `old_values`, `new_values` and `changed_fields` are `json()` columns, which MariaDB stores as
     * LONGTEXT and Sequelize parses in the *model* layer only. Under `raw: true` they arrive as
     * strings, and the danger is not that assertions fail loudly: `changed_fields.includes('x')`
     * silently becomes a substring match on JSON text and passes for the wrong reason.
     */
    const audits = await settle(
      () =>
        db.AuditLog.findAll({
          where: { id: { [db.Op.gt]: baseline.auditLog } },
          order: [['id', 'ASC']],
        }),
      /* The strongest of the four assertions below, so a slow write cannot leave `find()` undefined. */
      (rows) =>
        rows.filter((row) => row.table_name === 'addon_prices').length >= 3 &&
        rows.some(
          (row) =>
            row.table_name === 'addons' && (row.changed_fields || []).includes('units_per_quantity')
        ) &&
        rows.some(
          (row) =>
            row.table_name === 'addons' && row.reason && row.reason.includes('Withdrawn from sale')
        )
    );

    check(
      'the add-on edits are audited against addons',
      audits.filter((row) => row.table_name === 'addons').length > 0,
      true
    );
    /*
     * Four, not three, since the Known Issues #17 block added a fourth `PUT /addons/:id/prices` — the
     * three-price set on `extra_storage`. An exact count rather than a floor, deliberately: a price
     * replacement that stopped auditing would slip past `>= 3` for as long as any other one still did.
     */
    check(
      'and the price replacements against addon_prices',
      audits.filter((row) => row.table_name === 'addon_prices').length,
      4
    );

    const blockSizeAudit = audits.find(
      (row) =>
        row.table_name === 'addons' &&
        (row.changed_fields || []).includes('units_per_quantity')
    );
    check('the block-size change names the column it changed', Boolean(blockSizeAudit), true);
    check(
      'with the value it had before',
      String(blockSizeAudit.old_values.units_per_quantity),
      '1'
    );
    check('and the one it has now', String(blockSizeAudit.new_values.units_per_quantity), '50');

    const reasoned = audits.find(
      (row) => row.table_name === 'addons' && row.reason && row.reason.includes('Withdrawn from sale')
    );
    check(
      'a deactivation reason is kept in audit_logs, which is the only column for it',
      Boolean(reasoned),
      true
    );
    check('against the is_active change', (reasoned.changed_fields || []).includes('is_active'), true);

    /*
     * `logActivity` inserts from `res.on('finish')` and does not await it (`activityLog.js:246`, and
     * the comment at :278), so `await call(...)` resolving does not mean the row exists yet. Re-read
     * until an `addon` row is there rather than racing it — Known Issues #25.
     */
    const activities = await settle(
      () =>
        db.ActivityLog.findAll({
          where: { id: { [db.Op.gt]: baseline.activityLog } },
          order: [['id', 'ASC']],
          raw: true,
        }),
      (rows) => rows.some((row) => row.entity_type === 'addon')
    );
    const addonActivities = activities.filter((row) => row.entity_type === 'addon');
    check('every add-on write logged an activity row', addonActivities.length > 0, true);
    check(
      'each naming the add-on it touched',
      addonActivities.filter((row) => !row.description || !row.entity_id).length,
      0
    );
    check(
      'and none of the reads did',
      activities.filter((row) => row.entity_type === 'addon' && row.action === 'view').length,
      0
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ══════════════════════════════════ main ══════════════════════════════════ */

async function main() {
  verifyAddonSchemas();
  verifyRouting();
  verifyService();

  console.log('\n--- fixtures ---');
  check('the seven seeded add-ons are captured before anything writes them', await captureBaseline(), 7);
  check('two users, one organization and one school created', await createFixtures(), 2);
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
      console.log('\nFixtures removed, and the seeded catalogue put back.');

      /*
       * The restores are asserted, not assumed. This suite writes seeded rows, so an abort mid-run that
       * left `units_per_quantity` at 1000 would silently change what every future purchase grants.
       */
      const restored = await db.Addon.findAll({ raw: true, order: [['id', 'ASC']] });
      check(
        'every add-on column is back exactly as it was found',
        restored.map((row) => ADDON_COLUMNS.map((column) => String(row[column]))),
        seeded.addons.map((row) => ADDON_COLUMNS.map((column) => String(row[column])))
      );
      check(
        'and the addon_prices table with it',
        (await db.AddonPrice.count()),
        seeded.addonPrices.length
      );

      const principalKeys = await permissionService.getRolePermissions(
        fixtures.roles[ROLES.PRINCIPAL].id
      );
      check(
        'the principal role holds its seeded grants again, without either addons key',
        principalKeys.slice().sort(),
        DEFAULT_ROLE_PERMISSIONS[ROLES.PRINCIPAL].slice().sort()
      );
      check(
        'and no plan the run created is left behind',
        await db.SubscriptionPlan.count({
          where: { code: { [db.Op.like]: 'VAD-%' } },
          paranoid: false,
        }),
        0
      );
    } catch (err) {
      failures += 1;
      console.error('Fixture cleanup failed:', err.message);
    }
    console.log(
      failures === 0 ? '\nAll add-ons module checks passed.' : `\n${failures} check(s) FAILED.`
    );
    await db.sequelize.close();
    process.exit(failures === 0 ? 0 : 1);
  });
