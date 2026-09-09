'use strict';

/**
 * End-to-end verification of the subscription entitlement engine, against the real database and —
 * for the middleware half — over real HTTP with real JWTs.
 *
 *   entitlementService.resolve   the §11/§12 chain: overrides → add-ons → plan → deny
 *   usageService                 the four measurement kinds, overage, and FR-SUB-008 blocking
 *   middlewares/entitlement      402 / 403 / 400 refusals, platform bypass, per-school resolution
 *
 * The point of the fixtures is that no two schools share a shape. Each one isolates one behaviour of
 * the chain, so a failure names the rule that broke rather than "entitlement is wrong":
 *
 *   S1  plan only                     the baseline, plus rows that must be ignored (a cancelled
 *                                     add-on, an expired override, a deactivated override)
 *   S2  plan + add-ons                additive units from two rows, an add-on-only limit, and a
 *                                     feature the plan disables being unlocked by purchase
 *   S3  plan + overrides              a module on that the plan disables, a module off that it
 *                                     enables, a limit raised to unlimited, a feature switched off
 *   S4  plan + add-on + limit override  the base is replaced, the purchased units survive
 *   S5  expired subscription          entitlement still resolves; the state is what refuses
 *   S6  grace period                  a non-'active' state that is nonetheless usable (SRS §12.2)
 *   S7  no subscription at all        everything denied, nothing throws
 *   S8  premium plan                  unlimited from the plan, and a limit with overage permitted
 *
 * SRS §30 Rule 1 is verified structurally rather than by assertion: the two plans differ only in
 * their rows, and every expected value below is derived from those rows. A plan-name comparison
 * anywhere in the chain would make S3 and S4 — same plan, different answers — impossible to pass.
 *
 * The seven `addons` rows come from seeder 05 and are reused, not recreated: `addons.key` is
 * globally unique and there are exactly seven (SRS §11.3). Nothing seeded is modified or removed.
 *
 * Fixtures use a `VERIFY-` code prefix and a `@verify-ent.invalid` email domain, and are removed in
 * a `finally` block. Nothing outside those prefixes is touched.
 *
 * Run: node scripts/verify-entitlement.js
 */

const express = require('express');

const db = require('../src/models');
const { cache } = require('../src/config/cache');
const { requestContext } = require('../src/middlewares/requestContext');
const { sanitizeRequest } = require('../src/middlewares/sanitize');
const { authenticate } = require('../src/middlewares/authenticate');
const { resolveTenant } = require('../src/middlewares/resolveTenant');
const { enforceTenant } = require('../src/middlewares/enforceTenant');
const {
  requireActiveSubscription,
  requireModule,
  requireAnyModule,
  requireFeature,
  enforceLimit,
  attachEntitlement,
} = require('../src/middlewares/entitlement');
const { errorHandler, notFoundHandler } = require('../src/middlewares/errorHandler');
const { createRouter } = require('../src/utils/createRouter');
const entitlementService = require('../src/services/entitlementService');
const usageService = require('../src/services/usageService');
const {
  ROLES,
  USER_STATUS,
  SCHOOL_STATUS,
  ORGANIZATION_STATUS,
  STUDENT_STATUS,
  MODULES,
  LIMITS,
  LIMIT_TYPES,
  PLAN_STATUS,
  BILLING_CYCLES,
  SUBSCRIPTION_STATES,
  OVERRIDE_TYPES,
  ADDONS,
  USAGE_LIMIT_KEYS,
} = require('../src/config/constants');
const { hashPassword, signAccessToken, accessTokenPayload } = require('../src/utils/tokens');

const CODE_PREFIX = 'VERIFY-';
const EMAIL_DOMAIN = '@verify-ent.invalid';

/**
 * `starts_at` and `current_period_start` are deliberately different dates. Cumulative limits are
 * tracked against the first and periodic limits against the second, so a bug that used one for both
 * would be invisible if they were equal.
 */
const STARTS_AT = new Date('2026-01-01T00:00:00Z');
const PERIOD_START = new Date('2026-08-01T00:00:00Z');
const PERIOD_END = new Date('2026-09-01T00:00:00Z');
/** Used for effective windows that must not apply. */
const LONG_PAST = new Date('2025-01-01T00:00:00Z');
const LONG_AGO_END = new Date('2025-06-01T00:00:00Z');

let failures = 0;
const created = {
  students: [],
  users: [],
  schools: [],
  organizations: [],
  plans: [],
};

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${ok ? '' : `  (expected ${JSON.stringify(expected)})`}`
  );
}

/** Run something that may throw and hand back both outcomes, so either can be asserted on. */
async function capture(fn) {
  try {
    return { value: await fn(), error: null };
  } catch (err) {
    return { value: null, error: err };
  }
}

/* ─────────────────────────────── fixtures ─────────────────────────────── */

/**
 * @param {object} spec
 * @param {string} spec.code
 * @param {Record<string, boolean>} spec.modules
 * @param {Array<object>} spec.features
 * @param {Array<object>} spec.limits
 */
async function makePlan(spec) {
  const plan = await db.SubscriptionPlan.create({
    name: `Verify ${spec.code}`,
    code: `${CODE_PREFIX}${spec.code}`,
    status: PLAN_STATUS.ACTIVE,
    tier_rank: spec.tierRank,
    trial_days: 0,
    grace_period_days: 7,
  });
  created.plans.push(plan.id);

  for (const [moduleKey, isEnabled] of Object.entries(spec.modules)) {
    // eslint-disable-next-line no-await-in-loop
    await db.PlanModule.create({ plan_id: plan.id, module_key: moduleKey, is_enabled: isEnabled });
  }
  for (const feature of spec.features) {
    // eslint-disable-next-line no-await-in-loop
    await db.PlanFeature.create({ plan_id: plan.id, ...feature });
  }
  for (const limit of spec.limits) {
    // eslint-disable-next-line no-await-in-loop
    await db.PlanLimit.create({ plan_id: plan.id, ...limit });
  }
  return plan;
}

async function buildFixtures() {
  const roles = await db.Role.findAll({ attributes: ['id', 'slug'], raw: true });
  const roleId = Object.fromEntries(roles.map((r) => [r.slug, r.id]));

  const addonRows = await db.Addon.findAll({ attributes: ['id', 'key'], raw: true });
  const addonId = Object.fromEntries(addonRows.map((a) => [a.key, a.id]));

  /* Hashed once — bcrypt at the configured cost would otherwise dominate the run. */
  const passwordHash = await hashPassword('Verify-Only-Never-Used-1!');

  const orgOne = await db.Organization.create({
    name: 'Verify Ent Org One',
    code: `${CODE_PREFIX}EORG1`,
    status: ORGANIZATION_STATUS.ACTIVE,
  });
  const orgTwo = await db.Organization.create({
    name: 'Verify Ent Org Two',
    code: `${CODE_PREFIX}EORG2`,
    status: ORGANIZATION_STATUS.ACTIVE,
  });
  created.organizations.push(orgOne.id, orgTwo.id);

  /*
   * Basic: three modules on, one explicitly off, five of the eight limits configured. The three it
   * leaves out (teacher/staff/admin are configured; api_limit and sms_limit are not) exercise step 4
   * of the chain — an unconfigured limit denies rather than defaulting to something permissive.
   */
  const basic = await makePlan({
    code: 'BASIC',
    tierRank: 1,
    modules: {
      [MODULES.STUDENTS]: true,
      [MODULES.TEACHERS]: true,
      [MODULES.ATTENDANCE]: true,
      /* An explicit disabled row must deny just as firmly as an absent one. */
      [MODULES.LIBRARY]: false,
    },
    features: [
      { feature_key: 'basic_reports', name: 'Basic Reports', is_enabled: true },
      { feature_key: 'data_retention_days', is_enabled: true, value: '365' },
      /* Disabled here so an add-on can be seen to unlock it on S2. */
      { feature_key: 'custom_domain', is_enabled: false },
    ],
    limits: [
      { limit_key: LIMITS.STUDENT_LIMIT, limit_type: LIMIT_TYPES.FIXED, limit_value: 3, unit: 'count' },
      { limit_key: LIMITS.TEACHER_LIMIT, limit_type: LIMIT_TYPES.FIXED, limit_value: 1, unit: 'count' },
      { limit_key: LIMITS.AI_LIMIT, limit_type: LIMIT_TYPES.FIXED, limit_value: 2, unit: 'requests' },
      { limit_key: LIMITS.STORAGE_LIMIT, limit_type: LIMIT_TYPES.FIXED, limit_value: 10, unit: 'megabytes' },
      { limit_key: LIMITS.FILE_UPLOAD_LIMIT, limit_type: LIMIT_TYPES.FIXED, limit_value: 5, unit: 'megabytes' },
    ],
  });

  /*
   * Premium: unlimited students from the plan itself, and an AI limit with overage permitted. Its
   * file upload limit also permits overage, which must be ignored — overage is a billing arrangement
   * and cannot apply to a per-request ceiling.
   */
  const premium = await makePlan({
    code: 'PREMIUM',
    tierRank: 2,
    modules: {
      [MODULES.STUDENTS]: true,
      [MODULES.TEACHERS]: true,
      [MODULES.ATTENDANCE]: true,
      [MODULES.LIBRARY]: true,
      [MODULES.AI]: true,
      [MODULES.ONLINE_EXAMS]: true,
    },
    features: [
      { feature_key: 'basic_reports', is_enabled: true },
      { feature_key: 'premium_reports', is_enabled: true },
    ],
    limits: [
      { limit_key: LIMITS.STUDENT_LIMIT, limit_type: LIMIT_TYPES.UNLIMITED, unit: 'count' },
      {
        limit_key: LIMITS.AI_LIMIT,
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: 2,
        unit: 'requests',
        allow_overage: true,
        overage_unit_amount: 0.5,
      },
      { limit_key: LIMITS.STORAGE_LIMIT, limit_type: LIMIT_TYPES.FIXED, limit_value: 100, unit: 'megabytes' },
      {
        limit_key: LIMITS.FILE_UPLOAD_LIMIT,
        limit_type: LIMIT_TYPES.FIXED,
        limit_value: 20,
        unit: 'megabytes',
        allow_overage: true,
        overage_unit_amount: 1,
      },
    ],
  });

  const schools = {};
  async function makeSchool(key, organization) {
    const school = await db.School.create({
      organization_id: organization.id,
      name: `Verify Ent School ${key}`,
      code: `${CODE_PREFIX}E${key}`,
      status: SCHOOL_STATUS.ACTIVE,
    });
    created.schools.push(school.id);
    schools[key] = school;
    return school;
  }

  /* All eight in orgOne, so the organization-scoped caller can reach any of them. */
  for (const key of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
    // eslint-disable-next-line no-await-in-loop
    await makeSchool(key, orgOne);
  }
  /* One school in the other organization, to prove the org-scoped caller is still bounded. */
  await makeSchool('S9', orgTwo);

  async function subscribe(school, plan, state, extra = {}) {
    return db.Subscription.create({
      school_id: school.id,
      organization_id: school.organization_id,
      plan_id: plan.id,
      state,
      billing_cycle: BILLING_CYCLES.MONTHLY,
      cycle_amount: 100,
      starts_at: STARTS_AT,
      current_period_start: PERIOD_START,
      current_period_end: PERIOD_END,
      grace_period_days: 7,
      ...extra,
    });
  }

  const subs = {};
  subs.S1 = await subscribe(schools.S1, basic, SUBSCRIPTION_STATES.ACTIVE);
  subs.S2 = await subscribe(schools.S2, basic, SUBSCRIPTION_STATES.ACTIVE);
  subs.S3 = await subscribe(schools.S3, basic, SUBSCRIPTION_STATES.ACTIVE);
  subs.S4 = await subscribe(schools.S4, basic, SUBSCRIPTION_STATES.ACTIVE);
  subs.S5 = await subscribe(schools.S5, basic, SUBSCRIPTION_STATES.EXPIRED);
  subs.S6 = await subscribe(schools.S6, basic, SUBSCRIPTION_STATES.GRACE_PERIOD);
  /* S7 gets no subscription row at all. */
  subs.S8 = await subscribe(schools.S8, premium, SUBSCRIPTION_STATES.ACTIVE);
  subs.S9 = await subscribe(schools.S9, basic, SUBSCRIPTION_STATES.ACTIVE);

  /* ---- S1: rows that must be ignored ---------------------------------------------------- */

  /* A cancelled add-on grants nothing. */
  await db.SubscriptionAddon.create({
    subscription_id: subs.S1.id,
    school_id: schools.S1.id,
    addon_id: addonId[ADDONS.EXTRA_TEACHERS],
    quantity: 1,
    unit_amount: 10,
    effect_type: 'limit_increase',
    effect_target: LIMITS.TEACHER_LIMIT,
    units_granted: 40,
    status: 'cancelled',
  });
  /* An add-on whose window has closed grants nothing either. */
  await db.SubscriptionAddon.create({
    subscription_id: subs.S1.id,
    school_id: schools.S1.id,
    addon_id: addonId[ADDONS.EXTRA_STORAGE],
    quantity: 1,
    unit_amount: 10,
    effect_type: 'limit_increase',
    effect_target: LIMITS.STORAGE_LIMIT,
    units_granted: 900,
    status: 'active',
    starts_at: LONG_PAST,
    ends_at: LONG_AGO_END,
  });
  /* An override whose window has closed changes nothing. */
  await db.SubscriptionOverride.create({
    subscription_id: subs.S1.id,
    school_id: schools.S1.id,
    override_type: OVERRIDE_TYPES.MODULE,
    target_key: MODULES.FEES,
    is_enabled: true,
    effective_from: LONG_PAST,
    effective_until: LONG_AGO_END,
  });
  /* A deactivated override changes nothing. */
  await db.SubscriptionOverride.create({
    subscription_id: subs.S1.id,
    school_id: schools.S1.id,
    override_type: OVERRIDE_TYPES.MODULE,
    target_key: MODULES.HOSTEL,
    is_enabled: true,
    is_active: false,
  });
  /* A price override is not entitlement — it must be skipped, not misread as a limit. */
  await db.SubscriptionOverride.create({
    subscription_id: subs.S1.id,
    school_id: schools.S1.id,
    override_type: OVERRIDE_TYPES.PRICE,
    target_key: 'cycle_amount',
    amount: 1,
  });

  /* ---- S2: add-ons ---------------------------------------------------------------------- */

  /* Two rows against the same limit, to prove the units sum rather than replace. */
  await db.SubscriptionAddon.create({
    subscription_id: subs.S2.id,
    school_id: schools.S2.id,
    addon_id: addonId[ADDONS.EXTRA_STUDENTS],
    quantity: 2,
    unit_amount: 5,
    effect_type: 'limit_increase',
    effect_target: LIMITS.STUDENT_LIMIT,
    units_granted: 50,
    status: 'active',
    starts_at: STARTS_AT,
  });
  await db.SubscriptionAddon.create({
    subscription_id: subs.S2.id,
    school_id: schools.S2.id,
    addon_id: addonId[ADDONS.EXTRA_STUDENTS],
    quantity: 1,
    unit_amount: 5,
    effect_type: 'limit_increase',
    effect_target: LIMITS.STUDENT_LIMIT,
    units_granted: 10,
    status: 'active',
  });
  /* An add-on-only allowance: no plan row can configure sms_limit (SRS §11.2 lists eight, not SMS). */
  await db.SubscriptionAddon.create({
    subscription_id: subs.S2.id,
    school_id: schools.S2.id,
    addon_id: addonId[ADDONS.SMS_CREDITS],
    quantity: 1,
    unit_amount: 20,
    effect_type: 'limit_increase',
    effect_target: 'sms_limit',
    units_granted: 100,
    status: 'active',
  });
  /* A purchase that unlocks a feature the plan disables. */
  await db.SubscriptionAddon.create({
    subscription_id: subs.S2.id,
    school_id: schools.S2.id,
    addon_id: addonId[ADDONS.CUSTOM_DOMAIN],
    quantity: 1,
    unit_amount: 15,
    effect_type: 'feature_unlock',
    effect_target: 'custom_domain',
    units_granted: 0,
    status: 'active',
  });

  /* ---- S3: overrides ------------------------------------------------------------------- */

  await db.SubscriptionOverride.create({
    subscription_id: subs.S3.id,
    school_id: schools.S3.id,
    override_type: OVERRIDE_TYPES.MODULE,
    target_key: MODULES.LIBRARY,
    is_enabled: true,
    reason: 'Granted outside the plan',
  });
  await db.SubscriptionOverride.create({
    subscription_id: subs.S3.id,
    school_id: schools.S3.id,
    override_type: OVERRIDE_TYPES.MODULE,
    target_key: MODULES.TEACHERS,
    is_enabled: false,
    reason: 'Withdrawn despite the plan',
  });
  await db.SubscriptionOverride.create({
    subscription_id: subs.S3.id,
    school_id: schools.S3.id,
    override_type: OVERRIDE_TYPES.LIMIT,
    target_key: LIMITS.STUDENT_LIMIT,
    limit_type: LIMIT_TYPES.UNLIMITED,
  });
  await db.SubscriptionOverride.create({
    subscription_id: subs.S3.id,
    school_id: schools.S3.id,
    override_type: OVERRIDE_TYPES.FEATURE,
    target_key: 'basic_reports',
    is_enabled: false,
  });

  /* ---- S4: add-on units surviving a custom base ----------------------------------------- */

  await db.SubscriptionAddon.create({
    subscription_id: subs.S4.id,
    school_id: schools.S4.id,
    addon_id: addonId[ADDONS.EXTRA_STUDENTS],
    quantity: 1,
    unit_amount: 5,
    effect_type: 'limit_increase',
    effect_target: LIMITS.STUDENT_LIMIT,
    units_granted: 100,
    status: 'active',
  });
  await db.SubscriptionOverride.create({
    subscription_id: subs.S4.id,
    school_id: schools.S4.id,
    override_type: OVERRIDE_TYPES.LIMIT,
    target_key: LIMITS.STUDENT_LIMIT,
    limit_type: LIMIT_TYPES.FIXED,
    limit_value: 500,
  });

  /* ---- users --------------------------------------------------------------------------- */

  async function makeUser(key, attrs) {
    const user = await db.User.create({
      name: `Verify Ent ${key}`,
      email: `${key.toLowerCase()}${EMAIL_DOMAIN}`,
      username: `verify_ent_${key.toLowerCase()}`,
      password_hash: passwordHash,
      status: USER_STATUS.ACTIVE,
      must_change_password: false,
      ...attrs,
    });
    created.users.push(user.id);
    return user;
  }

  const users = {
    superAdmin: await makeUser('superadmin', { role_id: roleId[ROLES.SUPER_ADMIN] }),
    orgAdmin: await makeUser('orgadmin', {
      role_id: roleId[ROLES.ORGANIZATION_ADMIN],
      organization_id: orgOne.id,
    }),
  };
  for (const key of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
    // eslint-disable-next-line no-await-in-loop
    users[key] = await makeUser(`p${key}`, {
      role_id: roleId[ROLES.PRINCIPAL],
      organization_id: orgOne.id,
      school_id: schools[key].id,
    });
  }

  /* ---- students: S1 is filled exactly to its cap of three ------------------------------- */

  async function makeStudent(school, index, status) {
    const student = await db.Student.create({
      school_id: school.id,
      organization_id: school.organization_id,
      student_id: `${CODE_PREFIX}${school.code}-${index}`,
      admission_date: STARTS_AT,
      first_name: `Verify${index}`,
      status,
    });
    created.students.push(student.id);
    return student;
  }
  await makeStudent(schools.S1, 1, STUDENT_STATUS.ACTIVE);
  await makeStudent(schools.S1, 2, STUDENT_STATUS.ACTIVE);
  await makeStudent(schools.S1, 3, STUDENT_STATUS.ACTIVE);
  /* A departed student must not count against a limit on enrolment. */
  await makeStudent(schools.S1, 4, STUDENT_STATUS.LEFT);

  return { roleId, addonId, orgs: { one: orgOne, two: orgTwo }, plans: { basic, premium }, schools, subs, users };
}

async function dropFixtures() {
  const subscriptionIds = created.plans.length
    ? (
        await db.Subscription.findAll({
          where: { plan_id: created.plans },
          attributes: ['id'],
          raw: true,
        })
      ).map((row) => row.id)
    : [];

  if (created.schools.length) {
    await db.UsageRecord.destroy({ where: { school_id: created.schools }, force: true });
    await db.Student.destroy({ where: { school_id: created.schools }, force: true });
  }
  if (subscriptionIds.length) {
    await db.SubscriptionAddon.destroy({ where: { subscription_id: subscriptionIds }, force: true });
    await db.SubscriptionOverride.destroy({ where: { subscription_id: subscriptionIds }, force: true });
    await db.SubscriptionItem.destroy({ where: { subscription_id: subscriptionIds }, force: true });
    await db.SubscriptionHistory.destroy({ where: { subscription_id: subscriptionIds }, force: true });
    await db.Subscription.destroy({ where: { id: subscriptionIds }, force: true });
  }
  if (created.plans.length) {
    /* Plan children cascade, but deleting them explicitly keeps the teardown independent of that. */
    await db.PlanModule.destroy({ where: { plan_id: created.plans }, force: true });
    await db.PlanFeature.destroy({ where: { plan_id: created.plans }, force: true });
    await db.PlanLimit.destroy({ where: { plan_id: created.plans }, force: true });
    await db.PlanPrice.destroy({ where: { plan_id: created.plans }, force: true });
    await db.SubscriptionPlan.destroy({ where: { id: created.plans }, force: true });
  }
  /* `schools.principal_id` and `users.school_id` reference each other. */
  if (created.schools.length) {
    await db.School.update({ principal_id: null }, { where: { id: created.schools } });
  }
  if (created.users.length) {
    await db.User.destroy({ where: { id: created.users }, force: true });
  }
  if (created.schools.length) {
    await db.School.destroy({ where: { id: created.schools }, force: true });
  }
  if (created.organizations.length) {
    await db.Organization.destroy({ where: { id: created.organizations }, force: true });
  }
  await cache.flush();
}

/* ─────────────────────────────── test app ─────────────────────────────── */

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use(sanitizeRequest);

  const api = createRouter();
  api.use(authenticate);
  api.use(resolveTenant);
  api.use(enforceTenant);

  const ok = (req, res) => res.json({ success: true, data: 'ok' });

  /* Ordered as production will be: module gate, then permission (omitted here), then limit. */
  api.get('/students', requireModule(MODULES.STUDENTS), ok);
  api.get('/teachers', requireModule(MODULES.TEACHERS), ok);
  api.get('/library', requireModule(MODULES.LIBRARY), ok);
  api.get('/students-and-library', requireModule(MODULES.STUDENTS, MODULES.LIBRARY), ok);
  api.get('/either', requireAnyModule(MODULES.LIBRARY, MODULES.STUDENTS), ok);
  api.get('/neither', requireAnyModule(MODULES.HOSTEL, MODULES.TRANSPORT), ok);
  api.get('/reports', requireFeature('basic_reports'), ok);
  api.get('/billing', requireActiveSubscription(), ok);

  /* A school id in the path, so an organization-scoped caller can be gated on a named school. */
  api.get('/schools/:schoolId/library', requireModule(MODULES.LIBRARY), ok);

  api.post(
    '/students',
    requireModule(MODULES.STUDENTS),
    enforceLimit(LIMITS.STUDENT_LIMIT),
    (req, res) => res.json({ success: true, data: req.limitChecks })
  );
  api.post(
    '/students/bulk',
    enforceLimit(LIMITS.STUDENT_LIMIT, { increment: (req) => (req.body.students || []).length }),
    (req, res) => res.json({ success: true, data: req.limitChecks })
  );
  api.post('/ai', enforceLimit(LIMITS.AI_LIMIT), (req, res) =>
    res.json({ success: true, data: req.limitChecks })
  );
  /* A route whose increment function returns nonsense: a 500, never a silent fallback to 1. */
  api.post('/bad-increment', enforceLimit(LIMITS.AI_LIMIT, { increment: () => 'x' }), ok);

  /*
   * Echoes the tenant as the gate left it. `loadSnapshot()` narrows `req.tenant.schoolId` to the school
   * it judged, so that the entitlement decision and every subsequent `tenantWhere()` query cannot be
   * about different schools. Without a route that can see `req.tenant` after the gate, that narrowing
   * is invisible to this suite and the §5a session-18 bypass could return unnoticed.
   */
  api.get('/tenant-after-gate', requireModule(MODULES.STUDENTS), (req, res) =>
    res.json({
      success: true,
      data: {
        schoolId: req.tenant.schoolId === null ? null : Number(req.tenant.schoolId),
        organizationId: req.tenant.organizationId === null ? null : Number(req.tenant.organizationId),
        isPlatform: req.tenant.isPlatform,
        level: req.tenant.level,
        /* Null for a platform caller: every guard short-circuits before a snapshot is loaded. */
        gated: req.entitlement ? Number(req.entitlement.schoolId) : null,
      },
    })
  );
  api.get('/dashboard', attachEntitlement(), (req, res) =>
    res.json({
      success: true,
      data: {
        hasSnapshot: Boolean(req.entitlement),
        planCode: req.entitlement && req.entitlement.plan ? req.entitlement.plan.code : null,
      },
    })
  );

  app.use('/api/v1', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/* ─────────────────────────────── driver ─────────────────────────────── */

async function main() {
  const fixtures = await buildFixtures();
  const { schools, users, plans, orgs } = fixtures;

  console.log('\n--- entitlementService.resolve: S1, plan only ---');
  {
    const snap = await entitlementService.resolve(schools.S1.id);
    check('plan code resolved', snap.plan.code, `${CODE_PREFIX}BASIC`);
    check('organization carried from the subscription', snap.organizationId, orgs.one.id);
    check('state', snap.subscription.state, 'active');
    check('state is usable', snap.subscription.isUsable, true);
    check('module the plan enables', snap.modules[MODULES.STUDENTS], true);
    check('module the plan explicitly disables', snap.modules[MODULES.LIBRARY], false);
    check('module the plan never mentions', snap.modules[MODULES.FEES], false);
    check('every module key is answered', Object.keys(snap.modules).length, 20);
    check('feature the plan enables', snap.features.basic_reports.enabled, true);
    check('feature the plan disables', snap.features.custom_domain.enabled, false);
    check('feature value', snap.features.data_retention_days.value, '365');
    check('feature source', snap.features.basic_reports.source, 'plan');

    const student = snap.limits[LIMITS.STUDENT_LIMIT];
    check('configured limit type', student.type, 'fixed');
    check('configured limit value', student.value, 3);
    check('configured limit base', student.baseValue, 3);
    check('configured limit unit', student.unit, 'count');
    check('configured limit source', student.source, 'plan');
    check('configured limit has no add-on units', student.addonUnits, 0);
    check('overage off by default', student.allowOverage, false);

    check('unconfigured limit denies', snap.limits[LIMITS.API_LIMIT].value, 0);
    check('unconfigured limit source', snap.limits[LIMITS.API_LIMIT].source, 'default');
    check('unconfigured limit type', snap.limits[LIMITS.API_LIMIT].type, 'fixed');
    check('every limit key is answered', Object.keys(snap.limits).length, USAGE_LIMIT_KEYS.length);
    check('add-on-only limit denies without a purchase', snap.limits.sms_limit.value, 0);

    check('cancelled add-on grants nothing', snap.limits[LIMITS.TEACHER_LIMIT].value, 1);
    check('expired add-on grants nothing', snap.limits[LIMITS.STORAGE_LIMIT].value, 10);
    check('expired override changes nothing', snap.modules[MODULES.FEES], false);
    check('deactivated override changes nothing', snap.modules[MODULES.HOSTEL], false);
    check(
      'price override is not read as entitlement',
      snap.limits[LIMITS.STUDENT_LIMIT].value,
      3
    );
  }

  console.log('\n--- entitlementService.resolve: S2, add-ons ---');
  {
    const snap = await entitlementService.resolve(schools.S2.id);
    const student = snap.limits[LIMITS.STUDENT_LIMIT];
    check('two add-on rows sum', student.addonUnits, 60);
    check('add-on units are added to the plan base', student.value, 63);
    check('the plan base is unchanged', student.baseValue, 3);
    check('source stays with the plan that configured it', student.source, 'plan');

    const sms = snap.limits.sms_limit;
    check('add-on-only limit granted by purchase', sms.value, 100);
    check('add-on-only limit base', sms.baseValue, 0);
    check('add-on-only limit source', sms.source, 'addon');
    check('add-on-only limit unit', sms.unit, 'count');

    check('feature unlocked by add-on', snap.features.custom_domain.enabled, true);
    check('unlocked feature source', snap.features.custom_domain.source, 'addon');
    check('an add-on does not turn a plan feature off', snap.features.basic_reports.enabled, true);
  }

  console.log('\n--- entitlementService.resolve: S3, overrides ---');
  {
    const snap = await entitlementService.resolve(schools.S3.id);
    check('same plan as S1', snap.plan.code, `${CODE_PREFIX}BASIC`);
    check('override turns a module on', snap.modules[MODULES.LIBRARY], true);
    check('override turns a module off', snap.modules[MODULES.TEACHERS], false);
    check('module the override does not touch', snap.modules[MODULES.STUDENTS], true);

    const student = snap.limits[LIMITS.STUDENT_LIMIT];
    check('override raises a limit to unlimited', student.type, 'unlimited');
    check('unlimited carries no value', student.value, null);
    check('unlimited carries no base', student.baseValue, null);
    check('limit source', student.source, 'override');

    check('override turns a feature off', snap.features.basic_reports.enabled, false);
    check('overridden feature source', snap.features.basic_reports.source, 'override');
  }

  console.log('\n--- entitlementService.resolve: S4, override base plus purchased units ---');
  {
    const snap = await entitlementService.resolve(schools.S4.id);
    const student = snap.limits[LIMITS.STUDENT_LIMIT];
    check('override replaces the plan base', student.baseValue, 500);
    check('purchased units survive the override', student.addonUnits, 100);
    check('total is base plus purchased', student.value, 600);
    check('source', student.source, 'override');
  }

  console.log('\n--- entitlementService.resolve: lifecycle states (SRS §12) ---');
  {
    const expired = await entitlementService.resolve(schools.S5.id);
    check('expired state is reported', expired.subscription.state, 'expired');
    check('expired is not usable', expired.subscription.isUsable, false);
    check('entitlement still resolves for an expired subscription', expired.modules[MODULES.STUDENTS], true);
    check('and its limits still resolve', expired.limits[LIMITS.STUDENT_LIMIT].value, 3);

    const grace = await entitlementService.resolve(schools.S6.id);
    check('grace period state', grace.subscription.state, 'grace_period');
    check('grace period is usable', grace.subscription.isUsable, true);

    const none = await entitlementService.resolve(schools.S7.id);
    check('no subscription row', none.subscription, null);
    check('no plan', none.plan, null);
    check('all modules denied', Object.values(none.modules).every((v) => v === false), true);
    check('no features', Object.keys(none.features).length, 0);
    check('all limits denied', Object.values(none.limits).every((l) => l.value === 0), true);
    check('limit sources are default', none.limits[LIMITS.STUDENT_LIMIT].source, 'default');
  }

  console.log('\n--- entitlementService.resolve: S8, premium ---');
  {
    const snap = await entitlementService.resolve(schools.S8.id);
    check('plan code', snap.plan.code, `${CODE_PREFIX}PREMIUM`);
    check('unlimited from the plan', snap.limits[LIMITS.STUDENT_LIMIT].type, 'unlimited');
    check('unlimited value', snap.limits[LIMITS.STUDENT_LIMIT].value, null);
    const ai = snap.limits[LIMITS.AI_LIMIT];
    check('ai limit value', ai.value, 2);
    check('overage permitted', ai.allowOverage, true);
    check('overage rate is a number, not a string', ai.overageUnitAmount, 0.5);
    check('module only premium has', snap.modules[MODULES.ONLINE_EXAMS], true);
    check('module neither plan has', snap.modules[MODULES.HOSTEL], false);
  }

  console.log('\n--- entitlementService helpers ---');
  check('hasModule true', await entitlementService.hasModule(schools.S1.id, MODULES.STUDENTS), true);
  check('hasModule false', await entitlementService.hasModule(schools.S1.id, MODULES.LIBRARY), false);
  check('hasFeature true', await entitlementService.hasFeature(schools.S2.id, 'custom_domain'), true);
  check('hasFeature false', await entitlementService.hasFeature(schools.S1.id, 'custom_domain'), false);
  check(
    'hasFeature for a key nobody configured',
    await entitlementService.hasFeature(schools.S1.id, 'nothing_named_this'),
    false
  );
  check(
    'getFeatureValue',
    await entitlementService.getFeatureValue(schools.S1.id, 'data_retention_days'),
    '365'
  );
  check(
    'getFeatureValue is null for a disabled feature',
    await entitlementService.getFeatureValue(schools.S1.id, 'custom_domain'),
    null
  );
  check(
    'isSubscriptionUsable true',
    await entitlementService.isSubscriptionUsable(schools.S6.id),
    true
  );
  check(
    'isSubscriptionUsable false for expired',
    await entitlementService.isSubscriptionUsable(schools.S5.id),
    false
  );
  check(
    'isSubscriptionUsable false for unsubscribed',
    await entitlementService.isSubscriptionUsable(schools.S7.id),
    false
  );
  check('getLimit', (await entitlementService.getLimit(schools.S2.id, 'sms_limit')).value, 100);

  console.log('\n--- usageService: headcount (student_limit) ---');
  check('live count ignores departed students', await usageService.countHeadcount(schools.S1.id, LIMITS.STUDENT_LIMIT), 3);
  check('empty school counts zero', await usageService.countHeadcount(schools.S2.id, LIMITS.STUDENT_LIMIT), 0);
  {
    const usage = await usageService.getUsage(schools.S1.id, LIMITS.STUDENT_LIMIT);
    check('measurement', usage.measurement, 'headcount');
    check('allowed', usage.allowed, 3);
    check('used', usage.used, 3);
    check('remaining', usage.remaining, 0);
    check('label', usage.label, 'Student Limit');

    const one = await usageService.checkLimit(schools.S1.id, LIMITS.STUDENT_LIMIT, 1);
    check('one more student is refused', one.allowed, false);
    check('reason', one.reason, 'limit_exceeded');
    check('would exceed by', one.wouldOverage, 1);
    const none = await usageService.checkLimit(schools.S1.id, LIMITS.STUDENT_LIMIT, 0);
    check('a zero-unit check is permitted', none.allowed, true);

    const refused = await capture(() =>
      usageService.assertWithinLimit(schools.S1.id, LIMITS.STUDENT_LIMIT, 1)
    );
    check('assertWithinLimit throws', refused.error !== null, true);
    check('code', refused.error && refused.error.code, 'PLAN_LIMIT_EXCEEDED');
    check('status', refused.error && refused.error.statusCode, 403);
    check('details name the limit', refused.error && refused.error.details.limitKey, 'student_limit');
    check('details name the allowance', refused.error && refused.error.details.limit, 3);
    check('details name the usage', refused.error && refused.error.details.used, 3);
    check(
      'message names the numbers',
      /Student Limit reached\. Your plan allows 3 count and 3 are in use\./.test(
        (refused.error && refused.error.message) || ''
      ),
      true
    );
  }
  check(
    'S2, with purchased units, permits far more',
    (await usageService.checkLimit(schools.S2.id, LIMITS.STUDENT_LIMIT, 63)).allowed,
    true
  );
  check(
    'S2 refuses one past the purchased total',
    (await usageService.checkLimit(schools.S2.id, LIMITS.STUDENT_LIMIT, 64)).allowed,
    false
  );
  check(
    'an unlimited limit permits any amount',
    (await usageService.checkLimit(schools.S3.id, LIMITS.STUDENT_LIMIT, 100000)).allowed,
    true
  );
  check(
    'unlimited reports no remaining figure',
    (await usageService.checkLimit(schools.S3.id, LIMITS.STUDENT_LIMIT, 1)).remaining,
    null
  );

  console.log('\n--- usageService: headcount mirror ---');
  {
    const synced = await usageService.syncHeadcount(schools.S1.id, LIMITS.STUDENT_LIMIT);
    check('sync returns the live count', synced.used, 3);
    check('sync records the allowance', synced.allowed, 3);
    const row = await db.UsageRecord.findOne({
      where: { school_id: schools.S1.id, limit_key: LIMITS.STUDENT_LIMIT },
      raw: true,
    });
    check('mirror row written', Number(row.used_value), 3);
    check('mirror allowance', Number(row.allowed_value), 3);
    check('mirror overage', Number(row.overage_value), 0);
    check('mirror unit', row.unit, 'count');
    /* Cumulative and headcount limits track against the subscription start, not the billing period. */
    check('mirror period start is the subscription start', new Date(row.period_start).getTime(), STARTS_AT.getTime());

    const wrongKind = await capture(() => usageService.syncHeadcount(schools.S1.id, LIMITS.AI_LIMIT));
    check('syncHeadcount refuses a non-headcount limit', /not a headcount limit/.test((wrongKind.error || {}).message || ''), true);

    const all = await usageService.syncAllHeadcounts(schools.S1.id);
    check('every headcount mirror is refreshed', Object.keys(all).length, 4);
    check('teacher mirror', all[LIMITS.TEACHER_LIMIT].used, 0);
    /* The principal fixture is a school_admin-tier role, so it counts against admin_limit. */
    check('admin headcount counts the principal', all[LIMITS.ADMIN_LIMIT].used, 1);
    check('admin limit is unconfigured, so the allowance is zero', all[LIMITS.ADMIN_LIMIT].allowed, 0);
  }

  console.log('\n--- usageService: periodic (ai_limit) ---');
  {
    const first = await usageService.recordUsage(schools.S1.id, LIMITS.AI_LIMIT, 1);
    check('first request recorded', first.used, 1);
    check('allowance recorded alongside', first.allowed, 2);
    const second = await usageService.recordUsage(schools.S1.id, LIMITS.AI_LIMIT, 1);
    check('increments accumulate', second.used, 2);
    check('no overage while inside the allowance', second.overage, 0);

    const usage = await usageService.getUsage(schools.S1.id, LIMITS.AI_LIMIT);
    check('measurement', usage.measurement, 'periodic');
    check('used', usage.used, 2);
    check('remaining', usage.remaining, 0);
    check(
      'periodic usage tracks the billing period, not the subscription start',
      usage.periodStart,
      PERIOD_START.toISOString()
    );
    check('period end recorded', usage.periodEnd, PERIOD_END.toISOString());

    const third = await usageService.checkLimit(schools.S1.id, LIMITS.AI_LIMIT, 1);
    check('a plan without overage blocks', third.allowed, false);
    check('reason', third.reason, 'limit_exceeded');

    /* Two rows for one school, on two different period boundaries. */
    await usageService.recordUsage(schools.S1.id, LIMITS.STORAGE_LIMIT, 4);
    const rows = await db.UsageRecord.findAll({
      where: { school_id: schools.S1.id, limit_key: [LIMITS.AI_LIMIT, LIMITS.STORAGE_LIMIT] },
      attributes: ['limit_key', 'period_start'],
      raw: true,
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.limit_key, new Date(r.period_start).getTime()]));
    check(
      'periodic and cumulative rows sit on different periods',
      byKey[LIMITS.AI_LIMIT] !== byKey[LIMITS.STORAGE_LIMIT],
      true
    );
    check('cumulative period is the subscription start', byKey[LIMITS.STORAGE_LIMIT], STARTS_AT.getTime());
  }

  console.log('\n--- usageService: cumulative (storage_limit) ---');
  {
    const usage = await usageService.getUsage(schools.S1.id, LIMITS.STORAGE_LIMIT);
    check('measurement', usage.measurement, 'cumulative');
    check('used', usage.used, 4);
    check('remaining', usage.remaining, 6);
    check('unit', usage.unit, 'megabytes');

    const returned = await usageService.recordUsage(schools.S1.id, LIMITS.STORAGE_LIMIT, -3);
    check('a deletion returns storage', returned.used, 1);
    const clamped = await usageService.recordUsage(schools.S1.id, LIMITS.STORAGE_LIMIT, -50);
    check('a counter cannot go negative', clamped.used, 0);
    const row = await db.UsageRecord.findOne({
      where: { school_id: schools.S1.id, limit_key: LIMITS.STORAGE_LIMIT },
      raw: true,
    });
    check('the clamp is persisted, not just returned', Number(row.used_value), 0);
  }

  console.log('\n--- usageService: overage (SRS §33) ---');
  {
    const over = await usageService.recordUsage(schools.S8.id, LIMITS.AI_LIMIT, 3);
    check('usage past the allowance is recorded', over.used, 3);
    check('overage units', over.overage, 1);
    check('overage is priced', over.overageAmount, 0.5);

    const next = await usageService.checkLimit(schools.S8.id, LIMITS.AI_LIMIT, 1);
    check('overage permits the request', next.allowed, true);
    check('reason', next.reason, 'overage');
    check('projected overage', next.wouldOverage, 2);
    check('overage is flagged as allowed', next.overageAllowed, true);

    const row = await db.UsageRecord.findOne({
      where: { school_id: schools.S8.id, limit_key: LIMITS.AI_LIMIT },
      raw: true,
    });
    check('overage stored for billing', Number(row.overage_value), 1);
    check('overage amount stored', Number(row.overage_amount), 0.5);
  }

  console.log('\n--- usageService: per-request (file_upload_limit) ---');
  {
    const usage = await usageService.getUsage(schools.S1.id, LIMITS.FILE_UPLOAD_LIMIT);
    check('measurement', usage.measurement, 'per_request');
    check('nothing accumulates', usage.used, 0);
    check('not tracked in usage_records', usage.tracked, false);
    check('allowance', usage.allowed, 5);

    check(
      'a file inside the ceiling is permitted',
      (await usageService.checkPerRequestLimit(schools.S1.id, LIMITS.FILE_UPLOAD_LIMIT, 4)).allowed,
      true
    );
    check(
      'a file at the ceiling is permitted',
      (await usageService.checkPerRequestLimit(schools.S1.id, LIMITS.FILE_UPLOAD_LIMIT, 5)).allowed,
      true
    );
    check(
      'a file over the ceiling is refused',
      (await usageService.checkPerRequestLimit(schools.S1.id, LIMITS.FILE_UPLOAD_LIMIT, 6)).allowed,
      false
    );
    /* Premium permits overage on this limit; a per-request ceiling must ignore that. */
    const premiumOver = await usageService.checkPerRequestLimit(
      schools.S8.id,
      LIMITS.FILE_UPLOAD_LIMIT,
      25
    );
    check('overage cannot apply to a per-request ceiling', premiumOver.allowed, false);
    check('reason', premiumOver.reason, 'limit_exceeded');

    const noRows = await db.UsageRecord.count({
      where: { school_id: schools.S1.id, limit_key: LIMITS.FILE_UPLOAD_LIMIT },
    });
    check('no usage row was written for a per-request limit', noRows, 0);
  }

  console.log('\n--- usageService: misuse is refused, not guessed ---');
  {
    const headcount = await capture(() =>
      usageService.recordUsage(schools.S1.id, LIMITS.STUDENT_LIMIT, 1)
    );
    check(
      'recordUsage refuses a headcount limit',
      /headcount limit/.test((headcount.error || {}).message || ''),
      true
    );
    const perRequest = await capture(() =>
      usageService.recordUsage(schools.S1.id, LIMITS.FILE_UPLOAD_LIMIT, 1)
    );
    check(
      'recordUsage refuses a per-request limit',
      /not accumulated/.test((perRequest.error || {}).message || ''),
      true
    );
    const notPerRequest = await capture(() =>
      usageService.checkPerRequestLimit(schools.S1.id, LIMITS.AI_LIMIT, 1)
    );
    check(
      'checkPerRequestLimit refuses an accumulating limit',
      /not a per-request limit/.test((notPerRequest.error || {}).message || ''),
      true
    );
    const badKey = await capture(() => usageService.getUsage(schools.S1.id, 'students_limit'));
    check(
      'a mistyped limit key is refused',
      /unknown limit key/.test((badKey.error || {}).message || ''),
      true
    );
    const badIncrement = await capture(() =>
      usageService.checkLimit(schools.S1.id, LIMITS.AI_LIMIT, -1)
    );
    check(
      'a negative increment is refused',
      /non-negative/.test((badIncrement.error || {}).message || ''),
      true
    );
  }

  console.log('\n--- usageService: a school with no subscription ---');
  {
    const usage = await usageService.getUsage(schools.S7.id, LIMITS.STUDENT_LIMIT);
    check('allowance is zero', usage.allowed, 0);
    check('nothing is permitted', (await usageService.checkLimit(schools.S7.id, LIMITS.AI_LIMIT, 1)).allowed, false);
    check('recordUsage has nothing to track against', await usageService.recordUsage(schools.S7.id, LIMITS.AI_LIMIT, 1), null);
    check(
      'no usage row was created',
      await db.UsageRecord.count({ where: { school_id: schools.S7.id } }),
      0
    );
    check('syncHeadcount has nothing to track against', await usageService.syncHeadcount(schools.S7.id, LIMITS.STUDENT_LIMIT), null);
  }

  console.log('\n--- usageService.getUsageSummary ---');
  {
    const summary = await usageService.getUsageSummary(schools.S2.id);
    check('one entry per limit key', summary.length, USAGE_LIMIT_KEYS.length);
    check('keys in SRS order', summary.map((s) => s.limitKey), USAGE_LIMIT_KEYS);
    const sms = summary.find((s) => s.limitKey === 'sms_limit');
    check('add-on-only allowance appears', sms.allowed, 100);
    check('and is measured cumulatively', sms.measurement, 'cumulative');
  }

  console.log('\n--- cache invalidation ---');
  {
    await entitlementService.invalidateAll();
    check('baseline', (await entitlementService.getSnapshot(schools.S1.id)).limits[LIMITS.STUDENT_LIMIT].value, 3);

    await db.PlanLimit.update(
      { limit_value: 99 },
      { where: { plan_id: plans.basic.id, limit_key: LIMITS.STUDENT_LIMIT } }
    );
    check(
      'a plan edit is not visible until it is invalidated',
      (await entitlementService.getSnapshot(schools.S1.id)).limits[LIMITS.STUDENT_LIMIT].value,
      3
    );
    await entitlementService.invalidatePlan(plans.basic.id);
    check(
      'invalidatePlan makes it visible',
      (await entitlementService.getSnapshot(schools.S1.id)).limits[LIMITS.STUDENT_LIMIT].value,
      99
    );
    check(
      'and to every school on the plan',
      (await entitlementService.getSnapshot(schools.S4.id)).limits[LIMITS.STUDENT_LIMIT].baseValue,
      500
    );

    /* Restore, so the HTTP checks below run against the documented fixture. */
    await db.PlanLimit.update(
      { limit_value: 3 },
      { where: { plan_id: plans.basic.id, limit_key: LIMITS.STUDENT_LIMIT } }
    );
    await entitlementService.invalidatePlan(plans.basic.id);
    check('restored', (await entitlementService.getSnapshot(schools.S1.id)).limits[LIMITS.STUDENT_LIMIT].value, 3);

    const addon = await db.SubscriptionAddon.create({
      subscription_id: fixtures.subs.S1.id,
      school_id: schools.S1.id,
      addon_id: fixtures.addonId[ADDONS.EXTRA_STUDENTS],
      quantity: 1,
      unit_amount: 5,
      effect_type: 'limit_increase',
      effect_target: LIMITS.STUDENT_LIMIT,
      units_granted: 7,
      status: 'active',
    });
    check(
      'a purchase is not visible until it is invalidated',
      (await entitlementService.getSnapshot(schools.S1.id)).limits[LIMITS.STUDENT_LIMIT].value,
      3
    );
    await entitlementService.invalidateSchool(schools.S1.id);
    check(
      'invalidateSchool makes it visible',
      (await entitlementService.getSnapshot(schools.S1.id)).limits[LIMITS.STUDENT_LIMIT].value,
      10
    );
    check(
      'and leaves other schools alone',
      (await entitlementService.getSnapshot(schools.S2.id)).limits[LIMITS.STUDENT_LIMIT].value,
      63
    );

    await addon.destroy({ force: true });
    await entitlementService.invalidateSchool(schools.S1.id);
    check('back to the fixture', (await entitlementService.getSnapshot(schools.S1.id)).limits[LIMITS.STUDENT_LIMIT].value, 3);
  }

  console.log('\n--- boot-time guards ---');
  {
    const cases = [
      ['mistyped module key', () => requireModule('studnets'), /unknown module key\(s\) studnets/],
      ['no module key', () => requireModule(), /requires at least one module key/],
      ['mistyped limit key', () => enforceLimit('students_limit'), /unknown limit key\(s\) students_limit/],
      [
        'non-numeric increment',
        () => enforceLimit(LIMITS.STUDENT_LIMIT, { increment: 'x' }),
        /must be a number or a function/,
      ],
      ['empty feature key', () => requireFeature(''), /invalid feature key/],
      ['no feature key', () => requireFeature(), /requires at least one feature key/],
      ['mistyped module in requireAnyModule', () => requireAnyModule(MODULES.STUDENTS, 'libary'), /unknown module key\(s\) libary/],
    ];
    for (const [label, fn, pattern] of cases) {
      let message = '';
      try {
        fn();
      } catch (err) {
        message = err.message;
      }
      check(`${label} throws at definition`, pattern.test(message), true);
    }
  }

  /* ─────────────────────── HTTP: the middleware ─────────────────────── */

  const app = buildApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const user of Object.values(users)) {
    // eslint-disable-next-line no-await-in-loop
    user.role = await db.Role.findByPk(user.role_id);
  }

  function tokenFor(user) {
    return signAccessToken(accessTokenPayload({ ...user.get(), role: user.role || null }));
  }

  async function call(path, { user, method = 'GET', body } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(user ? { Authorization: `Bearer ${tokenFor(user)}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    return {
      status: res.status,
      body: payload,
      code: payload && payload.error && payload.error.code,
      details: payload && payload.error && payload.error.details,
      data: payload && payload.data,
    };
  }

  console.log('\n--- requireModule over HTTP ---');
  check('subscribed module -> 200', (await call('/api/v1/students', { user: users.S1 })).status, 200);
  {
    const r = await call('/api/v1/library', { user: users.S1 });
    check('unsubscribed module -> 403', r.status, 403);
    check('code', r.code, 'MODULE_NOT_SUBSCRIBED');
    check('missing module named', r.details.missing, ['library']);
    check('plan id reported for support', typeof r.details.planId, 'number');
    check('message names the module label', r.body.error.message, 'Your subscription does not include Library.');
  }
  check('override turns a module on -> 200', (await call('/api/v1/library', { user: users.S3 })).status, 200);
  check('override turns a module off -> 403', (await call('/api/v1/teachers', { user: users.S3 })).code, 'MODULE_NOT_SUBSCRIBED');
  check('same plan, other school, module on -> 200', (await call('/api/v1/teachers', { user: users.S1 })).status, 200);
  {
    const r = await call('/api/v1/students-and-library', { user: users.S1 });
    check('requireModule needs every key -> 403', r.status, 403);
    check('only the missing one is named', r.details.missing, ['library']);
  }
  check('requireAnyModule is satisfied by one -> 200', (await call('/api/v1/either', { user: users.S1 })).status, 200);
  {
    const r = await call('/api/v1/neither', { user: users.S1 });
    check('requireAnyModule with none -> 403', r.status, 403);
    check('all candidates named', r.details.requiredAnyOf, ['hostel', 'transport']);
  }

  console.log('\n--- requireFeature over HTTP ---');
  check('enabled feature -> 200', (await call('/api/v1/reports', { user: users.S1 })).status, 200);
  {
    const r = await call('/api/v1/reports', { user: users.S3 });
    check('feature switched off by override -> 403', r.status, 403);
    check('code', r.code, 'FEATURE_NOT_SUBSCRIBED');
    check('missing feature named', r.details.missing, ['basic_reports']);
  }

  console.log('\n--- subscription state over HTTP (SRS §12) ---');
  {
    const r = await call('/api/v1/students', { user: users.S5 });
    check('expired subscription -> 402', r.status, 402);
    check('code', r.code, 'SUBSCRIPTION_INACTIVE');
    check('state named so the frontend can act', r.details.state, 'expired');
  }
  check('grace period is usable -> 200', (await call('/api/v1/students', { user: users.S6 })).status, 200);
  {
    const r = await call('/api/v1/students', { user: users.S7 });
    check('no subscription -> 402', r.status, 402);
    check('state is null, not invented', r.details.state, null);
  }
  check('requireActiveSubscription passes for an active one', (await call('/api/v1/billing', { user: users.S1 })).status, 200);
  check('requireActiveSubscription refuses an expired one', (await call('/api/v1/billing', { user: users.S5 })).code, 'SUBSCRIPTION_INACTIVE');
  check(
    'state is checked before the module',
    (await call('/api/v1/library', { user: users.S5 })).code,
    'SUBSCRIPTION_INACTIVE'
  );

  console.log('\n--- enforceLimit over HTTP (FR-SUB-008) ---');
  {
    const r = await call('/api/v1/students', { user: users.S1, method: 'POST' });
    check('a create that would breach the cap -> 403', r.status, 403);
    check('code', r.code, 'PLAN_LIMIT_EXCEEDED');
    check('limit named', r.details.limitKey, 'student_limit');
  }
  {
    const r = await call('/api/v1/students', { user: users.S2, method: 'POST' });
    check('inside the purchased allowance -> 200', r.status, 200);
    check('the check is left on the request', r.data.student_limit.allowed, true);
    check('with the resolved allowance', r.data.student_limit.limit, 63);
    check('and no overage', r.data.student_limit.reason, null);
  }
  check('unlimited via override -> 200', (await call('/api/v1/students', { user: users.S3, method: 'POST' })).status, 200);
  {
    const body = { students: [{ n: 1 }, { n: 2 }, { n: 3 }] };
    const r = await call('/api/v1/students/bulk', { user: users.S2, method: 'POST', body });
    check('a bulk create counts its rows -> 200', r.status, 200);
    check('requested units', r.data.student_limit.requested, 3);
  }
  {
    const students = Array.from({ length: 64 }, (_, i) => ({ n: i }));
    const r = await call('/api/v1/students/bulk', { user: users.S2, method: 'POST', body: { students } });
    check('a bulk create past the cap -> 403', r.status, 403);
    check('the whole batch is refused, not part of it', r.details.requested, 64);
  }
  {
    const r = await call('/api/v1/ai', { user: users.S8, method: 'POST' });
    check('overage permits the request -> 200', r.status, 200);
    check('and it is flagged as billable', r.data.ai_limit.reason, 'overage');
  }
  check(
    'a limit the plan never configured refuses',
    (await call('/api/v1/ai', { user: users.S1, method: 'POST' })).code,
    'PLAN_LIMIT_EXCEEDED'
  );
  check(
    'a nonsense increment is a 500, not a silent 1',
    (await call('/api/v1/bad-increment', { user: users.S2, method: 'POST' })).status,
    500
  );

  console.log('\n--- platform scope bypasses every gate ---');
  check('super admin reaches an unsubscribed module', (await call('/api/v1/library', { user: users.superAdmin })).status, 200);
  check('super admin passes a limit gate', (await call('/api/v1/students', { user: users.superAdmin, method: 'POST' })).status, 200);
  check('super admin passes a feature gate', (await call('/api/v1/reports', { user: users.superAdmin })).status, 200);
  check('super admin passes the state gate', (await call('/api/v1/billing', { user: users.superAdmin })).status, 200);

  console.log('\n--- organization scope: which school is gated ---');
  {
    const r = await call('/api/v1/students', { user: users.orgAdmin });
    check('no school named -> 400', r.status, 400);
    check('code', r.code, 'SCHOOL_CONTEXT_REQUIRED');
  }
  check(
    'school in the path, module on -> 200',
    (await call(`/api/v1/schools/${schools.S3.id}/library`, { user: users.orgAdmin })).status,
    200
  );
  check(
    'same caller, same route, school without the module -> 403',
    (await call(`/api/v1/schools/${schools.S1.id}/library`, { user: users.orgAdmin })).code,
    'MODULE_NOT_SUBSCRIBED'
  );
  check(
    'school in the query string is resolved',
    (await call(`/api/v1/library?school_id=${schools.S3.id}`, { user: users.orgAdmin })).status,
    200
  );

  console.log('\n--- the gated school becomes the requested school (§5a session 18) ---');
  /*
   * The defect this block exists for: `resolveGatedSchoolId()` reads the raw request through
   * `collect()`, which normalises key spellings, while a module's list query reads `req.query.school_id`
   * AFTER `validate({query})` has stripped every key its schema does not declare. So the gate could
   * approve school S3 from `?schoolId=S3` while the service saw no school at all and `tenantWhere()`
   * answered across the whole organization — including schools whose plan excludes the module.
   * Measured on all six module-gated routers before the fix.
   *
   * The assertion that matters is the aliased spelling: revert the narrowing in `loadSnapshot()` and
   * the third check below reports null.
   */
  {
    const canonical = await call(`/api/v1/tenant-after-gate?school_id=${schools.S3.id}`, { user: users.orgAdmin });
    check('an organization admin naming a school is narrowed to it', canonical.data.schoolId, schools.S3.id);
    check('  which is the same school the gate judged', canonical.data.gated, schools.S3.id);
    check('  and the organization is still carried, so narrowing never widens', canonical.data.organizationId, orgs.one.id);

    const aliased = await call(`/api/v1/tenant-after-gate?schoolId=${schools.S3.id}`, { user: users.orgAdmin });
    check('an aliased spelling the gate accepts narrows identically', aliased.data.schoolId, schools.S3.id);
    check('  so the gate and the query can never be about different schools', aliased.data.gated, aliased.data.schoolId);

    const dashed = await call(`/api/v1/tenant-after-gate?school-id=${schools.S3.id}`, { user: users.orgAdmin });
    check('and so does the dashed spelling', dashed.data.schoolId, schools.S3.id);
  }
  {
    const own = await call(`/api/v1/tenant-after-gate`, { user: users.S1 });
    check('a school-scoped caller keeps their own school', own.data.schoolId, schools.S1.id);
    check('  and the gate judged that same school', own.data.gated, schools.S1.id);
  }
  {
    /*
     * A platform caller is deliberately NOT narrowed here, and asserting it stops the comment above
     * from drifting: every guard in `entitlement.js` short-circuits on `isPlatform` before a snapshot
     * is loaded, so `loadSnapshot()` never runs for them and there is nothing to narrow from. Their
     * named school is honoured one layer down instead, by `resolveSchool()` inside the module service.
     */
    const pf = await call(`/api/v1/tenant-after-gate?school_id=${schools.S3.id}`, { user: users.superAdmin });
    check('a platform caller reaches the route at all', pf.status, 200);
    check('  but is not narrowed — no guard loaded a snapshot for them', pf.data.schoolId, null);
    check('  which is why no snapshot was attached either', pf.data.gated, null);
    check('  and they are still platform', pf.data.isPlatform, true);
  }
  {
    const r = await call(
      `/api/v1/students?school_id=${schools.S1.id}&schoolId=${schools.S2.id}`,
      { user: users.orgAdmin }
    );
    check('two schools in one request -> 400', r.status, 400);
    check('code', r.code, 'MULTIPLE_SCHOOL_CONTEXT');
  }
  check(
    'the same school named twice is not ambiguous',
    (await call(`/api/v1/students?school_id=${schools.S1.id}&schoolId=${schools.S1.id}`, { user: users.orgAdmin })).status,
    200
  );
  check(
    'a school outside the organization is still refused by layer 3',
    (await call(`/api/v1/schools/${schools.S9.id}/library`, { user: users.orgAdmin })).code,
    'CROSS_TENANT_ACCESS_DENIED'
  );

  console.log('\n--- attachEntitlement ---');
  {
    const r = await call('/api/v1/dashboard', { user: users.S1 });
    check('school-scoped caller gets a snapshot', r.data.hasSnapshot, true);
    check('with its plan', r.data.planCode, `${CODE_PREFIX}BASIC`);
  }
  check(
    'an expired subscription still gets a snapshot rather than a refusal',
    (await call('/api/v1/dashboard', { user: users.S5 })).data.hasSnapshot,
    true
  );
  check(
    'a caller with no school context is not refused',
    (await call('/api/v1/dashboard', { user: users.orgAdmin })).data.hasSnapshot,
    false
  );
  check(
    'platform scope gets no snapshot',
    (await call('/api/v1/dashboard', { user: users.superAdmin })).data.hasSnapshot,
    false
  );

  /* ─────────────── the entitlements /auth/me carries (§30 R1, checklist 4.10) ─────────────── */

  /*
   * `authService.profile()` is called directly rather than over HTTP, because the app this suite
   * builds is a synthetic one with test routes — `/auth/me` is not mounted on it. The split is
   * deliberate and each half is tested where it can be: `verify-auth-module.js` proves that
   * `/auth/me` returns `profile()`'s output over the real chain, and this proves what `profile()`
   * computes, using the only fixtures in the project that have plans, modules and an expired
   * subscription to compute it from.
   *
   * Why the field exists at all: §30 Rule 1 requires module gating to be database-driven with no
   * plan name in the logic, and ARCHITECTURE.md §8 builds the entire navigation from this snapshot.
   * Without it the frontend has no lawful way to know which modules to show.
   */
  console.log('\n--- the entitlements /auth/me carries ---');
  {
    const authService = require('../src/modules/auth/auth.service');

    /** A request shaped as the auth chain leaves it, for a caller in a given scope. */
    const reqFor = (user, tenant) => ({
      user,
      tenant,
      getPermissions: async () => new Set(),
    });

    const schoolTenant = (schoolId) => ({
      level: 'school',
      organizationId: null,
      schoolId,
      isPlatform: false,
    });

    const s1 = await authService.profile(reqFor(users.S1, schoolTenant(users.S1.school_id)));

    /*
     * Read with `?.` throughout, and the presence check tests the KEY rather than the value.
     * A deliberate regression that deleted the field outright proved both necessary: `entitlements`
     * became `undefined`, `undefined !== null` is true so the presence check passed, and the next
     * property access threw — aborting the suite instead of naming the defect. A crash is a
     * detection, but a poor one.
     */
    check('a school caller receives its entitlements',
      'entitlements' in s1 && s1.entitlements != null, true);
    check('  naming the school they are for', s1.entitlements?.schoolId, users.S1.school_id);
    check('  with the plan the school is actually on, read from the database',
      s1.entitlements?.plan?.code, `${CODE_PREFIX}BASIC`);
    check('  a modules map the navigation can be generated from',
      typeof s1.entitlements?.modules, 'object');
    check('  a limits map, so a screen can show a quota without asking a second endpoint',
      typeof s1.entitlements?.limits, 'object');
    check('  and the subscription state, which decides whether the UI is usable at all',
      typeof s1.entitlements?.subscription?.isUsable, 'boolean');

    /*
     * The gating contract in one assertion: the modules map answers per module key, so a client
     * never has to ask which plan this is. §30 Rule 1's whole point.
     */
    const moduleMap = s1.entitlements?.modules ?? {};
    const moduleKeys = Object.keys(moduleMap);
    check('every module key answers true or false, so no plan name is ever consulted',
      moduleKeys.length > 0 && moduleKeys.every((key) => typeof moduleMap[key] === 'boolean'),
      true);

    /*
     * An expired subscription must still return a snapshot. The frontend has to render an expiry or
     * grace banner, and it can only do that if the state reaches it — a refusal here would leave the
     * user staring at an empty dashboard with nothing saying why.
     */
    const s5 = await authService.profile(reqFor(users.S5, schoolTenant(users.S5.school_id)));
    check('an unusable subscription still yields a snapshot rather than a refusal',
      'entitlements' in s5 && s5.entitlements != null, true);
    check('  reporting itself as unusable, so the UI can say why',
      s5.entitlements?.subscription?.isUsable, false);

    /*
     * Null, not `{}`, for a caller with no school. An empty object would read as "every module is
     * off" to a client that checked it — which for a Super Admin is exactly backwards, since the
     * platform surface is gated by permission and never by subscription.
     */
    const platform = await authService.profile(
      reqFor(users.superAdmin, { level: 'platform', organizationId: null, schoolId: null, isPlatform: true })
    );
    check('a platform caller receives null, not an empty snapshot',
      'entitlements' in platform ? platform.entitlements : 'FIELD MISSING', null);

    const org = await authService.profile(
      reqFor(users.orgAdmin, { level: 'organization', organizationId: 1, schoolId: null, isPlatform: false })
    );
    check('  as does an organization caller who has not selected a school',
      'entitlements' in org ? org.entitlements : 'FIELD MISSING', null);
  }

  await new Promise((resolve) => server.close(resolve));
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nVerification aborted:', err);
  })
  .finally(async () => {
    await dropFixtures();
    console.log(failures === 0 ? '\nAll entitlement checks passed.' : `\n${failures} check(s) FAILED.`);
    await db.sequelize.close();
    process.exit(failures === 0 ? 0 : 1);
  });
