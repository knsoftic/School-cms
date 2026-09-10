'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *
 * `dotenv` does not overwrite variables that are already present, so assigning them here is enough to
 * pin the three settings this script needs to know exactly:
 *
 *   MAX_UPLOAD_MB=2   the server backstop. Small, so a file that has to exceed it stays small — an
 *                     oversize body is aborted mid-stream, and a body only slightly over the ceiling
 *                     keeps the abort near its end where the client is certain to read the response.
 *   UPLOAD_DIR        a dedicated directory, removed in teardown, so nothing is written into the real
 *                     storage/uploads tree.
 *   CSRF_ENABLED=true so the guard is exercised whatever NODE_ENV the run happens to have.
 */
process.env.MAX_UPLOAD_MB = '2';
process.env.UPLOAD_DIR = 'storage/uploads/verify-mw';
process.env.CSRF_ENABLED = 'true';

/**
 * Verification of the five middlewares added in Phase 3.C, against the real database and over real
 * HTTP with real JWTs and real multipart bodies.
 *
 *   middlewares/upload       per-surface allowlists, the plan-vs-server ceiling, the three refusals,
 *                            random stored names, per-school directories, cleanup
 *   middlewares/rateLimit    address canonicalisation, per-user keying, the 429 envelope
 *   middlewares/csrf         double-submit across every failure shape, and the two escape hatches
 *   middlewares/activityLog  what gets a row and what does not, audit diffing, and the two things
 *                            recorded whether or not a route asked
 *   middlewares/sanitize     the multipart body pass added for the upload chain
 *
 * The four upload plans differ only in their `plan_limits` row for `file_upload_limit`, which is what
 * makes SRS §30 Rule 1 verifiable here: 1 MB, 5 MB, Unlimited and *absent* produce four different
 * ceilings from identical code, and every expected number below is derived from the row rather than
 * from a plan name.
 *
 * Two behaviours are deliberately asserted as they are rather than as one might assume:
 *
 *  - `verifyUploadedSize` cannot refuse a file that multer accepted, because multer's ceiling is
 *    derived from the same plan limit the service then re-checks. It confirms, and leaves the
 *    `req.limitChecks` entry a handler needs. Its refusal branch is a backstop for the case where the
 *    entitlement changes mid-request, so `cleanupUploads` is verified directly instead.
 *  - `activity_logs` rows are written after `res.on('finish')` and are not awaited, so a row is polled
 *    for; an assertion that no row exists waits a fixed grace period first.
 *
 * Fixtures use a `VERIFY-MW` code prefix and a `@verify-mw.invalid` email domain, and are removed in a
 * `finally` block. Nothing seeded is modified. Two `logger.error` lines are expected in the output —
 * they are the deliberately-failing log inserts proving that a failed write cannot fail a request.
 *
 * Run: node scripts/verify-middlewares.js
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { cache } = require('../src/config/cache');
const ApiError = require('../src/utils/ApiError');
const asyncHandler = require('../src/middlewares/asyncHandler');
const { requestContext } = require('../src/middlewares/requestContext');
const { sanitizeRequest } = require('../src/middlewares/sanitize');
const { authenticate } = require('../src/middlewares/authenticate');
const { resolveTenant } = require('../src/middlewares/resolveTenant');
const { enforceTenant } = require('../src/middlewares/enforceTenant');
const { uploadSingle, uploadArray, cleanupUploads, uploadedFiles } = require('../src/middlewares/upload');
const { createRateLimiter, clientKey, clientAddress } = require('../src/middlewares/rateLimit');
const {
  requireCsrfToken,
  attachCsrfToken,
  clearCsrfToken,
  secretsMatch,
} = require('../src/middlewares/csrf');
const {
  activityAudit,
  logActivity,
  describeActivity,
  recordActivity,
  recordAudit,
  snapshot,
  diff,
  METHOD_ACTIONS,
} = require('../src/middlewares/activityLog');
const { errorHandler, notFoundHandler } = require('../src/middlewares/errorHandler');
const { createRouter } = require('../src/utils/createRouter');
const {
  ROLES,
  USER_STATUS,
  SCHOOL_STATUS,
  ORGANIZATION_STATUS,
  MODULES,
  LIMITS,
  LIMIT_TYPES,
  PLAN_STATUS,
  BILLING_CYCLES,
  SUBSCRIPTION_STATES,
  ACTIVITY_ACTIONS,
  UPLOAD_PROFILES,
  UPLOAD_MIME_LIST,
  UPLOAD_IMAGE_MIMES,
} = require('../src/config/constants');
const { hashPassword, signAccessToken, accessTokenPayload } = require('../src/utils/tokens');

const CODE_PREFIX = 'VERIFY-MW';
const EMAIL_DOMAIN = '@verify-mw.invalid';
const AUDIT_TABLE = 'verify_mw_records';

const MEGABYTE = 1024 * 1024;
const UPLOAD_LIMIT = LIMITS.FILE_UPLOAD_LIMIT;

const STARTS_AT = new Date('2026-01-01T00:00:00Z');
const PERIOD_START = new Date('2026-08-01T00:00:00Z');
const PERIOD_END = new Date('2026-09-01T00:00:00Z');

let failures = 0;
const created = {
  users: [],
  schools: [],
  organizations: [],
  plans: [],
};
/** Every `X-Request-Id` this run sent, so its log rows can be removed by exactly that set. */
const requestIds = [];

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

/** Assert that a synchronous call throws something matching `pattern`. */
function checkThrows(label, fn, pattern) {
  let message = '(did not throw)';
  try {
    fn();
  } catch (err) {
    message = err.message;
  }
  check(label, pattern.test(message), true);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ─────────────────────────────── fixtures ─────────────────────────────── */

/**
 * @param {object} spec
 * @param {string} spec.code
 * @param {number} spec.tierRank
 * @param {Array<object>} spec.limits
 */
async function makePlan(spec) {
  const plan = await db.SubscriptionPlan.create({
    name: `Verify MW ${spec.code}`,
    code: `${CODE_PREFIX}-${spec.code}`,
    status: PLAN_STATUS.ACTIVE,
    tier_rank: spec.tierRank,
    trial_days: 0,
    grace_period_days: 7,
  });
  created.plans.push(plan.id);

  await db.PlanModule.create({
    plan_id: plan.id,
    module_key: MODULES.STUDENTS,
    is_enabled: true,
  });
  for (const limit of spec.limits) {
    // eslint-disable-next-line no-await-in-loop
    await db.PlanLimit.create({ plan_id: plan.id, ...limit });
  }
  return plan;
}

async function buildFixtures() {
  /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
  let residueCleared = await sweepResidue(db, { codes: ['VERIFY-MW-'], domains: ['verify-mw.invalid'] });
  /*
   * And the log rows the sweep cannot reach. It finds rows through a fixture's user or school, but
   * recordAudit is also exercised the way a job calls it, with no request — that row has no tenant and
   * no user, so nothing on it points back at a fixture. Such rows are found by what this suite alone
   * writes: the table name it invented, and the `verify-mw-` request ids — numbered from 001 on every
   * run, so a rerun asks for the very ids a killed run already used. Measured: the rerun read the killed
   * run's four audit rows as its own and failed twenty assertions, with every fixture table already
   * clean. The upload tree is not the cause; this run's teardown removes it whole.
   */
  const ownRequestIds = { request_id: { [db.Op.like]: 'verify-mw-%' } };
  residueCleared += await db.AuditLog.destroy({ where: { table_name: AUDIT_TABLE }, force: true });
  residueCleared += await db.AuditLog.destroy({ where: ownRequestIds, force: true });
  residueCleared += await db.ActivityLog.destroy({ where: ownRequestIds, force: true });
  if (residueCleared) {
    console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
  }
  const roles = await db.Role.findAll({ attributes: ['id', 'slug'], raw: true });
  const roleId = Object.fromEntries(roles.map((r) => [r.slug, r.id]));

  /* Hashed once — bcrypt at the configured cost would otherwise dominate the run. */
  const passwordHash = await hashPassword('Verify-Only-Never-Used-1!');

  const orgOne = await db.Organization.create({
    name: 'Verify MW Org One',
    code: `${CODE_PREFIX}-ORG1`,
    status: ORGANIZATION_STATUS.ACTIVE,
  });
  const orgTwo = await db.Organization.create({
    name: 'Verify MW Org Two',
    code: `${CODE_PREFIX}-ORG2`,
    status: ORGANIZATION_STATUS.ACTIVE,
  });
  created.organizations.push(orgOne.id, orgTwo.id);

  /*
   * Four plans, one `plan_limits` row of difference between them. The server backstop is 2 MB, so:
   * SMALL is stricter than it, BIG is looser, UNLIM defers to it entirely, and ZERO never configured
   * the limit at all — which the entitlement chain answers with a deny, not with "unlimited".
   */
  const plans = {
    small: await makePlan({
      code: 'SMALL',
      tierRank: 1,
      limits: [
        { limit_key: UPLOAD_LIMIT, limit_type: LIMIT_TYPES.FIXED, limit_value: 1, unit: 'megabytes' },
      ],
    }),
    big: await makePlan({
      code: 'BIG',
      tierRank: 2,
      limits: [
        { limit_key: UPLOAD_LIMIT, limit_type: LIMIT_TYPES.FIXED, limit_value: 5, unit: 'megabytes' },
      ],
    }),
    unlimited: await makePlan({
      code: 'UNLIM',
      tierRank: 3,
      limits: [{ limit_key: UPLOAD_LIMIT, limit_type: LIMIT_TYPES.UNLIMITED, unit: 'megabytes' }],
    }),
    zero: await makePlan({ code: 'ZERO', tierRank: 4, limits: [] }),
  };

  const schools = {};
  async function makeSchool(key, organization) {
    const school = await db.School.create({
      organization_id: organization.id,
      name: `Verify MW School ${key}`,
      code: `${CODE_PREFIX}-${key}`,
      status: SCHOOL_STATUS.ACTIVE,
    });
    created.schools.push(school.id);
    schools[key] = school;
    return school;
  }

  for (const key of ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7']) {
    // eslint-disable-next-line no-await-in-loop
    await makeSchool(key, orgOne);
  }
  /* In the other organization, so a cross-tenant reference is unambiguous. */
  await makeSchool('U8', orgTwo);

  async function subscribe(school, plan, state) {
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
    });
  }

  await subscribe(schools.U1, plans.small, SUBSCRIPTION_STATES.ACTIVE);
  await subscribe(schools.U2, plans.big, SUBSCRIPTION_STATES.ACTIVE);
  await subscribe(schools.U3, plans.unlimited, SUBSCRIPTION_STATES.ACTIVE);
  await subscribe(schools.U4, plans.zero, SUBSCRIPTION_STATES.ACTIVE);
  await subscribe(schools.U5, plans.small, SUBSCRIPTION_STATES.EXPIRED);
  /* U6 gets no subscription row at all. */
  await subscribe(schools.U7, plans.small, SUBSCRIPTION_STATES.ACTIVE);
  await subscribe(schools.U8, plans.small, SUBSCRIPTION_STATES.ACTIVE);

  async function makeUser(key, attrs) {
    const user = await db.User.create({
      name: `Verify MW ${key}`,
      email: `${key.toLowerCase()}${EMAIL_DOMAIN}`,
      username: `verify_mw_${key.toLowerCase()}`,
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
  for (const key of ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7']) {
    // eslint-disable-next-line no-await-in-loop
    users[key] = await makeUser(`p${key}`, {
      role_id: roleId[ROLES.PRINCIPAL],
      organization_id: orgOne.id,
      school_id: schools[key].id,
    });
  }

  return { roleId, orgs: { one: orgOne, two: orgTwo }, plans, schools, users };
}

async function dropFixtures() {
  if (requestIds.length) {
    await db.ActivityLog.destroy({ where: { request_id: requestIds }, force: true });
    await db.AuditLog.destroy({ where: { request_id: requestIds }, force: true });
  }
  await db.AuditLog.destroy({ where: { table_name: AUDIT_TABLE }, force: true });

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
    /* Belt and braces: any row this run wrote against a fixture school, whatever its request id. */
    await db.ActivityLog.destroy({ where: { school_id: created.schools }, force: true });
    await db.AuditLog.destroy({ where: { school_id: created.schools }, force: true });
    await db.UsageRecord.destroy({ where: { school_id: created.schools }, force: true });
  }
  if (subscriptionIds.length) {
    await db.SubscriptionAddon.destroy({ where: { subscription_id: subscriptionIds }, force: true });
    await db.SubscriptionOverride.destroy({ where: { subscription_id: subscriptionIds }, force: true });
    await db.SubscriptionItem.destroy({ where: { subscription_id: subscriptionIds }, force: true });
    await db.SubscriptionHistory.destroy({ where: { subscription_id: subscriptionIds }, force: true });
    await db.Subscription.destroy({ where: { id: subscriptionIds }, force: true });
  }
  if (created.plans.length) {
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
    await db.ActivityLog.destroy({ where: { user_id: created.users }, force: true });
    await db.AuditLog.destroy({ where: { user_id: created.users }, force: true });
    await db.User.destroy({ where: { id: created.users }, force: true });
  }
  if (created.schools.length) {
    await db.School.destroy({ where: { id: created.schools }, force: true });
  }
  if (created.organizations.length) {
    await db.Organization.destroy({ where: { id: created.organizations }, force: true });
  }

  /* The dedicated upload tree, and only it — `config.uploads.dir` was pinned at the top of the file. */
  await fsp.rm(config.uploads.dir, { recursive: true, force: true });
  await cache.flush();
}

/* ─────────────────────────────── test app ─────────────────────────────── */

/** What a handler reports about a file, without leaking an absolute path into the assertions. */
function fileInfo(file) {
  return {
    field: file.fieldname,
    originalname: file.originalname,
    filename: file.filename,
    mimetype: file.mimetype,
    size: file.size,
    dir: path.relative(config.uploads.dir, file.destination).split(path.sep).join('/'),
  };
}

function buildApp() {
  /*
   * `config.rateLimit.enabled` is false under NODE_ENV=test, which would make every limiter a
   * passthrough. Both branches are wanted: one limiter is built with it off to prove the passthrough,
   * and the rest with it on to prove the counting.
   */
  const wasEnabled = config.rateLimit.enabled;
  config.rateLimit.enabled = false;
  const disabledLimiter = createRateLimiter({ name: 'verify-off', windowMs: 60000, limit: 1 });
  config.rateLimit.enabled = true;
  const anonLimiter = createRateLimiter({ name: 'verify-anon', windowMs: 60000, limit: 3 });
  const userLimiter = createRateLimiter({ name: 'verify-user', windowMs: 60000, limit: 2 });
  const failuresOnlyLimiter = createRateLimiter({
    name: 'verify-failures',
    windowMs: 60000,
    limit: 1,
    skipSuccessfulRequests: true,
  });
  config.rateLimit.enabled = wasEnabled;

  const app = express();
  app.set('trust proxy', config.app.trustProxy);
  app.use(express.json());
  app.use(cookieParser());
  app.use(requestContext);
  app.use(sanitizeRequest);
  app.use(activityAudit());

  const ok = (req, res) => res.json({ success: true, data: 'ok' });

  /* ---- rate limiting ------------------------------------------------------------------ */

  app.get('/plain/rate', anonLimiter, ok);
  app.get('/plain/no-limit', disabledLimiter, ok);
  app.get('/plain/failures-only', failuresOnlyLimiter, (req, res) => {
    if (req.query.fail === '1') return res.status(401).json({ success: false });
    return res.json({ success: true, data: 'ok' });
  });

  /* ---- csrf --------------------------------------------------------------------------- */

  app.get('/csrf/token', attachCsrfToken(), (req, res) =>
    res.json({ success: true, data: { token: req.csrfToken } })
  );
  app.get('/csrf/guarded', requireCsrfToken(), ok);
  app.post('/csrf/guarded', requireCsrfToken(), ok);
  app.post('/csrf/logout', requireCsrfToken(), (req, res) => {
    clearCsrfToken(res);
    return res.json({ success: true, data: 'ok' });
  });

  /* ---- the API router ----------------------------------------------------------------- */

  const api = createRouter();
  api.use(authenticate);
  api.use(resolveTenant);
  api.use(enforceTenant);

  api.get('/rate', userLimiter, ok);

  const report = (req, res) =>
    res.json({
      success: true,
      data: {
        upload: req.upload,
        file: req.file ? fileInfo(req.file) : null,
        files: Array.isArray(req.files) ? req.files.map(fileInfo) : null,
        body: req.body || null,
        limitCheck: (req.limitChecks && req.limitChecks[UPLOAD_LIMIT]) || null,
      },
    });

  api.post('/upload/photo', ...uploadSingle(UPLOAD_PROFILES.PERSON_PHOTO, 'photo'), report);
  api.post('/upload/ai', ...uploadSingle(UPLOAD_PROFILES.AI_SOURCE, 'source'), report);
  api.post('/upload/proof', ...uploadSingle(UPLOAD_PROFILES.PAYMENT_PROOF, 'proof'), report);
  api.post('/upload/docs', ...uploadArray(UPLOAD_PROFILES.STUDENT_DOCUMENT, 'documents'), report);
  api.post('/upload/two', ...uploadArray(UPLOAD_PROFILES.STUDENT_DOCUMENT, 'documents', 2), report);
  api.post(
    '/schools/:schoolId/upload/photo',
    ...uploadSingle(UPLOAD_PROFILES.PERSON_PHOTO, 'photo'),
    report
  );

  /* Proves `cleanupUploads` from inside a handler, and that a second call tolerates the absence. */
  api.post(
    '/upload/cleanup',
    ...uploadSingle(UPLOAD_PROFILES.PERSON_PHOTO, 'photo'),
    asyncHandler(async (req, res) => {
      const target = req.file.path;
      const existedBefore = fs.existsSync(target);
      await cleanupUploads(req);
      const existsAfter = fs.existsSync(target);
      await cleanupUploads(req);
      return res.json({
        success: true,
        data: { existedBefore, existsAfter, counted: uploadedFiles(req).length },
      });
    })
  );

  /* ---- activity logging --------------------------------------------------------------- */

  api.post(
    '/logged',
    logActivity({
      action: ACTIVITY_ACTIONS.CREATE,
      entityType: 'student',
      description: 'Created a pupil',
    }),
    ok
  );
  api.put('/inferred', logActivity(), ok);
  api.post('/only-success', logActivity({ onlyOnSuccess: true }), () => {
    throw ApiError.badRequest('Refused on purpose.');
  });
  api.post('/also-failed', logActivity(), () => {
    throw ApiError.badRequest('Refused on purpose.');
  });
  api.post('/described/:id', logActivity({ entityType: 'invoice' }), (req, res) => {
    describeActivity(req, { entityId: 9042, metadata: { note: 'from the handler' } });
    return res.json({ success: true, data: 'ok' });
  });
  api.post('/param/:id', logActivity({ entityType: 'student' }), ok);
  api.get('/undeclared', ok);
  api.get('/schools/:schoolId/thing', ok);

  app.use('/api/v1', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app, disabledLimiter };
}

/** A second app with no `cookie-parser`, to prove the CSRF guard fails closed. */
function buildBareApp() {
  const app = express();
  app.use(requestContext);
  app.post('/csrf/guarded', requireCsrfToken(), (req, res) =>
    res.json({ success: true, data: 'ok' })
  );
  app.use(errorHandler);
  return app;
}

/* ─────────────────────────────── driver ─────────────────────────────── */

async function main() {
  const fixtures = await buildFixtures();
  const { schools, users, orgs } = fixtures;

  /* ─────────────────── unit: rateLimit key derivation ─────────────────── */

  console.log('\n--- rateLimit: clientAddress ---');
  check('IPv4', clientAddress({ ip: '203.0.113.4' }), '203.0.113.4');
  check(
    'IPv4 mapped into IPv6 by a dual-stack socket',
    clientAddress({ ip: '::ffff:203.0.113.4' }),
    '203.0.113.4'
  );
  check(
    'IPv6 collapses to its /64',
    clientAddress({ ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' }),
    '2001:db8:85a3:0::/64'
  );
  check(
    'the compressed spelling of the same prefix is the same key',
    clientAddress({ ip: '2001:db8:85a3::1' }),
    '2001:db8:85a3:0::/64'
  );
  check(
    'leading zeros do not make a second key',
    clientAddress({ ip: '2001:0db8:85a3:0000::1' }),
    '2001:db8:85a3:0::/64'
  );
  check(
    'a zone index is not part of the client',
    clientAddress({ ip: '2001:db8:85a3:0::1%eth0' }),
    '2001:db8:85a3:0::/64'
  );
  check('loopback IPv6', clientAddress({ ip: '::1' }), '0:0:0:0::/64');
  check(
    'a different /64 is a different key',
    clientAddress({ ip: '2001:db8:85a3:1::1' }),
    '2001:db8:85a3:1::/64'
  );
  check(
    'no req.ip falls back to the socket',
    clientAddress({ socket: { remoteAddress: '198.51.100.7' } }),
    '198.51.100.7'
  );
  check('nothing at all is still a key', clientAddress({}), 'unknown');
  check('an unparseable address is keyed verbatim', clientAddress({ ip: 'not-an-ip' }), 'not-an-ip');

  console.log('\n--- rateLimit: clientKey ---');
  check(
    'an authenticated request counts against the user',
    clientKey({ user: { id: 7 }, ip: '203.0.113.4' }),
    'user:7'
  );
  check(
    'two users behind one address are two keys',
    clientKey({ user: { id: 8 }, ip: '203.0.113.4' }),
    'user:8'
  );
  check('an anonymous request counts against the address', clientKey({ ip: '203.0.113.4' }), 'ip:203.0.113.4');
  check('a user with no id is not trusted as one', clientKey({ user: {}, ip: '203.0.113.4' }), 'ip:203.0.113.4');

  console.log('\n--- rateLimit: createRateLimiter validation ---');
  checkThrows('no name', () => createRateLimiter({ windowMs: 1000, limit: 1 }), /requires a name/);
  checkThrows(
    'window of zero',
    () => createRateLimiter({ name: 'x', windowMs: 0, limit: 1 }),
    /windowMs must be a positive number/
  );
  checkThrows(
    'a fractional limit',
    () => createRateLimiter({ name: 'x', windowMs: 1000, limit: 1.5 }),
    /limit must be a positive integer/
  );
  checkThrows(
    'a limit of zero',
    () => createRateLimiter({ name: 'x', windowMs: 1000, limit: 0 }),
    /limit must be a positive integer/
  );

  /* ─────────────────── unit: csrf.secretsMatch ─────────────────── */

  console.log('\n--- csrf: secretsMatch ---');
  check('identical secrets match', secretsMatch('a'.repeat(64), 'a'.repeat(64)), true);
  check('different secrets of equal length do not', secretsMatch('a'.repeat(64), 'b'.repeat(64)), false);
  check('different lengths do not throw, they fail', secretsMatch('abc', 'abcd'), false);
  check('an empty secret never matches', secretsMatch('', ''), false);
  check('a missing secret never matches', secretsMatch('abc', undefined), false);
  check('a non-string never matches', secretsMatch('abc', 123), false);

  /* ─────────────────── unit: activityLog helpers ─────────────────── */

  console.log('\n--- activityLog: diff ---');
  check('nothing changed', diff({ a: 1 }, { a: 1 }), { changed: [], old: {}, new: {} });
  check('one column changed', diff({ a: 1, b: 2 }, { a: 1, b: 3 }), {
    changed: ['b'],
    old: { b: 2 },
    new: { b: 3 },
  });
  check(
    'two equal Dates are not a change',
    diff({ at: new Date('2026-01-01T00:00:00Z') }, { at: new Date('2026-01-01T00:00:00Z') }).changed,
    []
  );
  check(
    'a different Date is',
    diff({ at: new Date('2026-01-01T00:00:00Z') }, { at: new Date('2026-01-02T00:00:00Z') }).changed,
    ['at']
  );
  check(
    'a DECIMAL arriving as a string compares by value',
    diff({ amount: '10.00' }, { amount: '10.00' }).changed,
    []
  );
  check(
    'an equal JSON object is not a change',
    diff({ meta: { a: [1, 2] } }, { meta: { a: [1, 2] } }).changed,
    []
  );
  check(
    'a changed JSON object is',
    diff({ meta: { a: [1, 2] } }, { meta: { a: [1, 3] } }).changed,
    ['meta']
  );
  check('undefined and null are the same absence', diff({ a: undefined }, { a: null }).changed, []);
  check('a column present on one side only', diff({}, { a: 5 }), {
    changed: ['a'],
    old: { a: null },
    new: { a: 5 },
  });
  check('null to a value', diff({ a: null }, { a: 5 }).changed, ['a']);
  check('empty on both sides', diff(), { changed: [], old: {}, new: {} });

  console.log('\n--- activityLog: snapshot ---');
  check('a plain object is not an instance', snapshot({ name: 'x' }), {});
  check('null is not an instance', snapshot(null), {});
  {
    const school = schools.U1;
    check('named fields only', snapshot(school, ['name', 'code']), {
      name: 'Verify MW School U1',
      code: `${CODE_PREFIX}-U1`,
    });
    const all = snapshot(school);
    check('a full snapshot covers the columns', all.id !== undefined && all.status !== undefined, true);
    check('and reads the stored value, not a derived one', all.code, `${CODE_PREFIX}-U1`);
    check('an attribute the row does not carry is omitted', 'not_a_column' in snapshot(school, ['not_a_column']), false);
  }

  console.log('\n--- activityLog: describeActivity ---');
  {
    const req = {};
    describeActivity(req, { action: ACTIVITY_ACTIONS.CREATE, metadata: { a: 1 } });
    describeActivity(req, { description: 'later', metadata: { b: 2 } });
    check('fields accumulate', { action: req.activity.action, description: req.activity.description }, {
      action: 'create',
      description: 'later',
    });
    check('metadata is merged rather than replaced', req.activity.metadata, { a: 1, b: 2 });
    describeActivity(req, { action: ACTIVITY_ACTIONS.UPDATE });
    check('the later value wins', req.activity.action, 'update');
  }

  console.log('\n--- activityLog: logActivity validation ---');
  checkThrows(
    'an action outside the SRS §26 enumeration',
    () => logActivity({ action: 'exfiltrate' }),
    /unknown action 'exfiltrate'/
  );
  check('a valid action is accepted', typeof logActivity({ action: ACTIVITY_ACTIONS.EXPORT }), 'function');
  check('no action at all is accepted', typeof logActivity(), 'function');
  check('METHOD_ACTIONS infers from the verb', METHOD_ACTIONS, {
    POST: 'create',
    PUT: 'update',
    PATCH: 'update',
    DELETE: 'delete',
    GET: 'view',
    HEAD: 'view',
  });

  console.log('\n--- activityLog: a failed write cannot fail the caller ---');
  {
    /* The `logger.error` line this produces is expected. */
    const attempt = await capture(() => recordActivity({ action: 'not-a-real-action' }));
    check('recordActivity swallows an invalid insert', attempt.error, null);
  }

  /* ─────────────────── recordAudit ─────────────────── */

  console.log('\n--- activityLog: recordAudit ---');
  {
    const auditReq = {
      id: 'verify-mw-audit-01',
      method: 'PATCH',
      originalUrl: '/api/v1/students/4242',
      ip: '203.0.113.9',
      get: () => 'verify-mw-agent',
      tenant: { schoolId: schools.U1.id, organizationId: orgs.one.id, roleSlug: ROLES.PRINCIPAL },
      user: { id: users.U1.id, email: users.U1.email },
    };
    requestIds.push(auditReq.id);

    async function auditRows() {
      return db.AuditLog.findAll({
        where: { table_name: AUDIT_TABLE },
        order: [['id', 'ASC']],
      });
    }

    await recordAudit(auditReq, {
      tableName: AUDIT_TABLE,
      recordId: 4242,
      event: 'update',
      before: { first_name: 'Aisha', status: 'active' },
      after: { first_name: 'Aisha', status: 'active' },
    });
    check('an update that changed nothing writes no row', (await auditRows()).length, 0);

    await recordAudit(auditReq, {
      tableName: AUDIT_TABLE,
      recordId: 4242,
      event: 'update',
      before: { first_name: 'Aisha', status: 'active' },
      after: { first_name: 'Aisha', status: 'left' },
      reason: 'Transferred out',
    });
    {
      const rows = await auditRows();
      check('a real change writes one row', rows.length, 1);
      const row = rows[0];
      check('only the changed column is listed', row.changed_fields, ['status']);
      check('old value', row.old_values, { status: 'active' });
      check('new value', row.new_values, { status: 'left' });
      check('event', row.event, 'update');
      check('record id', Number(row.record_id), 4242);
      check('school from the request', Number(row.school_id), schools.U1.id);
      check('organization from the request', Number(row.organization_id), orgs.one.id);
      check('user from the request', Number(row.user_id), users.U1.id);
      check('address from the request', row.ip_address, '203.0.113.9');
      check('request id from the request', row.request_id, 'verify-mw-audit-01');
      check('reason', row.reason, 'Transferred out');
    }

    await recordAudit(auditReq, {
      tableName: AUDIT_TABLE,
      recordId: 4243,
      event: 'create',
      after: { first_name: 'Bilal' },
    });
    {
      const row = (await auditRows())[1];
      check('a create has no old values', row.old_values, null);
      check('and records what was written', row.new_values, { first_name: 'Bilal' });
    }

    await recordAudit(auditReq, {
      tableName: AUDIT_TABLE,
      recordId: 4244,
      event: 'delete',
      before: { first_name: 'Chidi' },
    });
    {
      const row = (await auditRows())[2];
      check('a delete has no new values', row.new_values, null);
      check('and records what was removed', row.old_values, { first_name: 'Chidi' });
    }

    await recordAudit(null, {
      tableName: AUDIT_TABLE,
      recordId: 4245,
      event: 'restore',
      before: { deleted_at: '2026-01-01' },
      after: { deleted_at: null },
    });
    {
      const row = (await auditRows())[3];
      check('a job with no request still writes a row', row.event, 'restore');
      check('with no tenant attributed to it', [row.school_id, row.user_id], [null, null]);
    }

    const missing = await capture(() => recordAudit(auditReq, { event: 'update' }));
    check(
      'a call with no table name is a programming error, not a silent skip',
      /requires tableName and event/.test(missing.error ? missing.error.message : ''),
      true
    );

    /* The `logger.error` line this produces is expected. */
    const bad = await capture(() =>
      recordAudit(auditReq, { tableName: AUDIT_TABLE, event: 'sabotage', after: { a: 1 } })
    );
    check('an invalid event is swallowed rather than thrown', bad.error, null);
    check('and wrote nothing', (await auditRows()).length, 4);
  }

  /* ─────────────────── HTTP ─────────────────── */

  const { app, disabledLimiter } = buildApp();
  check('a disabled limiter is still mountable', disabledLimiter.name, 'passthrough');

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const bareServer = await new Promise((resolve) => {
    const s = buildBareApp().listen(0, () => resolve(s));
  });
  const bareBase = `http://127.0.0.1:${bareServer.address().port}`;

  for (const user of Object.values(users)) {
    // eslint-disable-next-line no-await-in-loop
    user.role = await db.Role.findByPk(user.role_id);
  }

  function tokenFor(user) {
    return signAccessToken(accessTokenPayload({ ...user.get(), role: user.role || null }));
  }

  /** A request id this run owns, so its log rows can be found and later removed. */
  let idCounter = 0;
  function nextRequestId(label) {
    idCounter += 1;
    const id = `verify-mw-${label}-${String(idCounter).padStart(3, '0')}`;
    requestIds.push(id);
    return id;
  }

  function readResponse(res, payload, requestId) {
    return {
      status: res.status,
      headers: res.headers,
      body: payload,
      code: payload && payload.error && payload.error.code,
      message: payload && payload.error && payload.error.message,
      details: payload && payload.error && payload.error.details,
      data: payload && payload.data,
      requestId,
    };
  }

  async function parse(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  /**
   * A JSON request.
   *
   * `raw` sends a body string verbatim. It exists for one case: `{"__proto__": …}` cannot be expressed
   * as an object literal — `__proto__:` in a literal sets the prototype rather than creating an own
   * property, so `JSON.stringify` would never emit it and the very key under test would go unsent.
   */
  async function call(
    url,
    { user, method = 'GET', body, raw, headers = {}, label = 'req', origin = base } = {}
  ) {
    const requestId = nextRequestId(label);
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) payload = JSON.stringify(body);

    const res = await fetch(origin + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
        ...(user ? { Authorization: `Bearer ${tokenFor(user)}` } : {}),
        ...headers,
      },
      body: payload,
    });
    return readResponse(res, await parse(res), requestId);
  }

  /**
   * A multipart request.
   *
   * @param {string} url
   * @param {object} options
   * @param {object} options.user
   * @param {Array<{field: string, name: string, type: string, bytes: number}>} [options.files]
   * @param {Record<string, string>} [options.fields]
   */
  async function upload(url, { user, files = [], fields = {}, label = 'upl' } = {}) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    for (const file of files) {
      form.append(
        file.field,
        new Blob([Buffer.alloc(file.bytes, 0x61)], { type: file.type }),
        file.name
      );
    }

    const requestId = nextRequestId(label);
    const res = await fetch(base + url, {
      method: 'POST',
      headers: {
        'X-Request-Id': requestId,
        ...(user ? { Authorization: `Bearer ${tokenFor(user)}` } : {}),
      },
      body: form,
    });
    return readResponse(res, await parse(res), requestId);
  }

  const png = (bytes, name = 'photo.png') => ({
    field: 'photo',
    name,
    type: 'image/png',
    bytes,
  });

  /* ─────────────────── upload: the ceiling ─────────────────── */

  console.log('\n--- upload: the ceiling is resolved from the plan (SRS §11.2, §30 Rule 1) ---');
  {
    const r = await upload('/api/v1/upload/ai', { user: users.U1, fields: { note: 'hello' } });
    check('a stricter plan is what binds', r.status, 200);
    check('plan allowance', r.data.upload.planMb, 1);
    check('server backstop', r.data.upload.hardMb, 2);
    check('effective ceiling is the lower of the two', r.data.upload.maxMb, 1);
    check('and the plan is named as its source', r.data.upload.source, 'plan');
    check('in bytes', r.data.upload.maxBytes, MEGABYTE);
    check('the school it was resolved for', r.data.upload.schoolId, schools.U1.id);
    check('the surface', r.data.upload.profile, 'ai_source');
    check('the surface allowlist', r.data.upload.mimeTypes, UPLOAD_MIME_LIST);
    check('where the limit came from', r.data.upload.limitSource, 'plan');
    check('no file is not an error', r.data.file, null);
    check('and nothing was measured', r.data.limitCheck, null);
    check('multer parsed the text field', r.data.body.note, 'hello');
  }
  {
    const r = await upload('/api/v1/upload/ai', { user: users.U2 });
    check('a looser plan leaves the server backstop binding', r.data.upload.maxMb, 2);
    check('plan allowance is still reported', r.data.upload.planMb, 5);
    check('source', r.data.upload.source, 'server');
  }
  {
    const r = await upload('/api/v1/upload/ai', { user: users.U3 });
    check('an Unlimited plan does not mean an unbounded body', r.data.upload.maxMb, 2);
    check('no plan number to report', r.data.upload.planMb, null);
    check('source', r.data.upload.source, 'server');
  }
  {
    const r = await upload('/api/v1/upload/ai', { user: users.U4 });
    check('a plan that never configured the limit refuses', r.status, 403);
    check('code', r.code, 'PLAN_LIMIT_EXCEEDED');
    check('message', r.message, 'Your plan does not include file uploads.');
    check('details', r.details, {
      limitKey: 'file_upload_limit',
      limit: 0,
      unit: 'megabytes',
      requested: null,
    });
  }
  {
    const r = await upload('/api/v1/upload/ai', { user: users.U5 });
    check('an expired subscription is a different refusal from a small plan', r.status, 402);
    check('code', r.code, 'SUBSCRIPTION_INACTIVE');
    check('the state is named', r.details.state, 'expired');
  }
  {
    const r = await upload('/api/v1/upload/ai', { user: users.U6 });
    check('no subscription at all', r.status, 402);
    check('code', r.code, 'SUBSCRIPTION_INACTIVE');
    check('with no state to name', r.details.state, null);
  }
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.superAdmin,
      files: [png(1024)],
    });
    check('platform scope reads no plan', r.status, 200);
    check('no school in scope', r.data.upload.schoolId, null);
    check('so the server backstop is the only ceiling', r.data.upload.maxMb, 2);
    check('source', r.data.upload.source, 'server');
    check('and the file lands outside every school tree', r.data.file.dir, 'platform/person_photo');
    check('no plan measurement was taken', r.data.limitCheck, null);
  }
  {
    const r = await upload('/api/v1/upload/photo', { user: users.orgAdmin, files: [png(1024)] });
    check('an organization-scoped caller naming no school is refused', r.status, 400);
    check('code', r.code, 'SCHOOL_CONTEXT_REQUIRED');
  }
  {
    const r = await upload(`/api/v1/schools/${schools.U2.id}/upload/photo`, {
      user: users.orgAdmin,
      files: [png(1024)],
    });
    check('naming a school in its own organization resolves that plan', r.status, 200);
    check('the named school', r.data.upload.schoolId, schools.U2.id);
    check('its allowance', r.data.upload.planMb, 5);
    check('and the file lands in that school tree', r.data.file.dir, `school-${schools.U2.id}/person_photo`);
  }

  /* ─────────────────── upload: the three refusals ─────────────────── */

  console.log('\n--- upload: size refusals name the remedy that fits ---');
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.U1,
      files: [png(MEGABYTE + 8192)],
    });
    check('over the plan allowance -> 403, not 413', r.status, 403);
    check('code', r.code, 'PLAN_LIMIT_EXCEEDED');
    check('message names the allowance so an upgrade is actionable (SRS §11.3)', r.message,
      'File Upload Limit reached. Your plan allows 1 MB per file.');
    check('details', r.details, {
      limitKey: 'file_upload_limit',
      limit: 1,
      unit: 'megabytes',
      requested: null,
    });
  }
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.U3,
      files: [png(2 * MEGABYTE + 8192)],
    });
    check('over the server backstop -> 413', r.status, 413);
    check('code', r.code, 'FILE_TOO_LARGE');
    check('message', r.message, 'Uploads are limited to 2 MB per file.');
    check('details', r.details, { limit: 2, unit: 'megabytes' });
  }
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.U2,
      files: [png(2 * MEGABYTE + 8192)],
    });
    check(
      'a plan looser than the backstop also refuses at 413 — no upgrade would help',
      [r.status, r.code],
      [413, 'FILE_TOO_LARGE']
    );
  }
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.U1,
      files: [png(MEGABYTE)],
    });
    check('exactly at the allowance is accepted', r.status, 200);
    check('the service was consulted for the authoritative answer', r.data.limitCheck.allowed, true);
    check('and left the same shape enforceLimit leaves', r.data.limitCheck.limitKey, 'file_upload_limit');
    check('the plan number it judged against', r.data.limitCheck.limit, 1);
    check('unit', r.data.limitCheck.unit, 'megabytes');
    check('measured in megabytes, not bytes', r.data.limitCheck.requested, 1);
    check('a per-request limit accumulates nothing', r.data.limitCheck.used, 0);
    check('and overage cannot apply to one file', r.data.limitCheck.overageAllowed, false);
  }
  {
    const r = await upload('/api/v1/upload/photo', { user: users.U3, files: [png(MEGABYTE)] });
    check('an Unlimited plan reports itself as such', r.data.limitCheck.unlimited, true);
    check('with no allowance to compare against', r.data.limitCheck.limit, null);
  }

  console.log('\n--- upload: per-surface type allowlists ---');
  {
    const r = await upload('/api/v1/upload/ai', {
      user: users.U1,
      files: [{ field: 'source', name: 'syllabus.pdf', type: 'application/pdf', bytes: 2048 }],
    });
    check('§21 names PDF for the AI surface', r.status, 200);
    check('stored type', r.data.file.mimetype, 'application/pdf');
  }
  {
    const r = await upload('/api/v1/upload/proof', {
      user: users.U1,
      files: [{ field: 'proof', name: 'receipt.pdf', type: 'application/pdf', bytes: 2048 }],
    });
    check('a payment "screenshot" surface does not inherit PDF', r.status, 415);
    check('code', r.code, 'UNSUPPORTED_MEDIA_TYPE');
    check('and says what it does take', r.details.allowed, UPLOAD_IMAGE_MIMES);
    check('naming the field', r.details.field, 'proof');
    check('and what arrived', r.details.received, 'application/pdf');
  }
  {
    const r = await upload('/api/v1/upload/proof', {
      user: users.U1,
      files: [{ field: 'proof', name: 'receipt.jpg', type: 'image/jpeg', bytes: 2048 }],
    });
    check('an image is what that surface is for', r.status, 200);
  }
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.U1,
      files: [{ field: 'photo', name: 'run.exe', type: 'application/x-msdownload', bytes: 2048 }],
    });
    check('a type on no allowlist', r.status, 415);
    check('code', r.code, 'UNSUPPORTED_MEDIA_TYPE');
  }
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.U1,
      files: [{ field: 'photo', name: 'payload.php', type: 'image/png', bytes: 2048 }],
    });
    check('a declared type that its extension does not carry', r.status, 415);
    check('code', r.code, 'FILE_EXTENSION_MISMATCH');
    check('the disagreement is spelled out', [r.details.declared, r.details.extension], [
      'image/png',
      '.php',
    ]);
    check('with what the type should have arrived as', r.details.expected, ['.png']);
  }
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.U1,
      files: [{ field: 'photo', name: 'photo.PNG', type: 'IMAGE/PNG; charset=utf-8', bytes: 2048 }],
    });
    check('case and parameters do not defeat the allowlist', r.status, 200);
    check('the multipart parser has already reduced the type to its essence', r.data.file.mimetype, 'image/png');
    check('and the stored extension is lowercased', path.extname(r.data.file.filename), '.png');
  }
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.U1,
      files: [{ field: 'photo', name: 'scan.jpeg', type: 'image/jpeg', bytes: 2048 }],
    });
    check('a type with two legitimate extensions accepts either', r.status, 200);
  }

  console.log('\n--- upload: nothing the caller chose reaches the filesystem ---');
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.U1,
      files: [png(4096, 'C:\\Users\\attacker\\evil.png')],
    });
    check('a Windows path is reduced to a bare name', r.data.file.originalname, 'evil.png');
    check('and is not what was stored', r.data.file.filename !== 'evil.png', true);
  }
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.U1,
      files: [png(4096, '../../../../etc/passwd.png')],
    });
    check('traversal is reduced to a bare name', r.data.file.originalname, 'passwd.png');
    check('stored name is random hex', /^[0-9a-f]{32}\.png$/.test(r.data.file.filename), true);
    check('under this school and this surface', r.data.file.dir, `school-${schools.U1.id}/person_photo`);
  }
  {
    const first = await upload('/api/v1/upload/photo', { user: users.U1, files: [png(4096)] });
    const second = await upload('/api/v1/upload/photo', { user: users.U1, files: [png(4096)] });
    check(
      'two uploads of the same name do not collide',
      first.data.file.filename !== second.data.file.filename,
      true
    );
    check(
      'tenancy holds on disk as well as in the schema',
      [first.data.file.dir, second.data.file.dir],
      [`school-${schools.U1.id}/person_photo`, `school-${schools.U1.id}/person_photo`]
    );
    check('and the bytes are really there', fs.existsSync(path.join(config.uploads.dir, first.data.file.dir, first.data.file.filename)), true);
  }

  console.log('\n--- upload: several files, and multer refusals other than size ---');
  {
    const r = await upload('/api/v1/upload/docs', {
      user: users.U1,
      files: [
        { field: 'documents', name: 'a.pdf', type: 'application/pdf', bytes: 1024 },
        { field: 'documents', name: 'b.png', type: 'image/png', bytes: 2048 },
        { field: 'documents', name: 'c.webp', type: 'image/webp', bytes: 4096 },
      ],
    });
    check('a documents surface takes several', r.status, 200);
    check('all of them', r.data.files.length, 3);
    check('the largest is what the plan was asked about', r.data.limitCheck.requested, 4096 / MEGABYTE);
    check('each got its own random name', new Set(r.data.files.map((f) => f.filename)).size, 3);
    check('in one directory', new Set(r.data.files.map((f) => f.dir)).size, 1);
  }
  {
    const r = await upload('/api/v1/upload/two', {
      user: users.U1,
      files: [
        { field: 'documents', name: 'a.pdf', type: 'application/pdf', bytes: 1024 },
        { field: 'documents', name: 'b.pdf', type: 'application/pdf', bytes: 1024 },
        { field: 'documents', name: 'c.pdf', type: 'application/pdf', bytes: 1024 },
      ],
    });
    check('more files than the route allows -> 400, not 500', r.status, 400);
    check('and the code says which multer rule refused', /^UPLOAD_LIMIT_/.test(r.code), true);
  }
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.U1,
      files: [{ field: 'not_photo', name: 'a.png', type: 'image/png', bytes: 1024 }],
    });
    check('a field the route never declared -> 400', r.status, 400);
    check('code', r.code, 'UPLOAD_LIMIT_UNEXPECTED_FILE');
  }
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.U1,
      files: [png(1024), png(1024, 'second.png')],
    });
    check('two files on a single-file field -> 400', r.status, 400);
    check('refused on the count, before the second field name is looked at', r.code, 'UPLOAD_LIMIT_FILE_COUNT');
  }

  console.log('\n--- upload: cleanupUploads ---');
  {
    const r = await upload('/api/v1/upload/cleanup', { user: users.U1, files: [png(4096)] });
    check('the file was on disk when the handler ran', r.data.existedBefore, true);
    check('and is gone once cleanup has run', r.data.existsAfter, false);
    check('a second cleanup tolerates the absence', r.status, 200);
    check('the file list is unchanged by cleaning', r.data.counted, 1);
  }

  console.log('\n--- upload: multipart text fields are sanitised (SRS §24 FR-SEC-003) ---');
  {
    const r = await upload('/api/v1/upload/photo', {
      user: users.U1,
      files: [png(2048)],
      fields: { note: 'Hello <script>steal()</script>world', ok: 'Smith & Sons 5 < 7' },
    });
    check('markup that executes is removed from a multipart field', r.data.body.note, 'Hello world');
    check('legitimate text is left alone', r.data.body.ok, 'Smith & Sons 5 < 7');
  }

  console.log('\n--- upload: construction-time validation ---');
  checkThrows(
    'an unknown profile',
    () => uploadSingle('not_a_profile', 'file'),
    /unknown upload profile 'not_a_profile'/
  );
  checkThrows('no field name', () => uploadSingle(UPLOAD_PROFILES.PERSON_PHOTO), /requires a field name/);
  checkThrows(
    'a count above the surface maximum',
    () => uploadArray(UPLOAD_PROFILES.PAYMENT_PROOF, 'proof', 2),
    /maxCount must be an integer between 1 and 1/
  );
  checkThrows(
    'a count of zero',
    () => uploadArray(UPLOAD_PROFILES.STUDENT_DOCUMENT, 'documents', 0),
    /maxCount must be an integer between 1 and 10/
  );
  checkThrows(
    'a count that is not a number',
    () => uploadArray(UPLOAD_PROFILES.STUDENT_DOCUMENT, 'documents', 'ten'),
    /maxCount must be an integer between 1 and 10/
  );
  check(
    'the chain a route mounts',
    uploadSingle(UPLOAD_PROFILES.PERSON_PHOTO, 'photo').length,
    4
  );

  /* ─────────────────── rate limiting over HTTP ─────────────────── */

  console.log('\n--- rateLimit over HTTP ---');
  {
    check('first request under the limit', (await call('/api/v1/rate', { user: users.U1 })).status, 200);
    check('second, at the limit', (await call('/api/v1/rate', { user: users.U1 })).status, 200);
    const r = await call('/api/v1/rate', { user: users.U1 });
    check('third is refused', r.status, 429);
    check('code', r.code, 'RATE_LIMIT_EXCEEDED');
    check('the limiter that refused is named', r.details.scope, 'verify-user');
    check('with a wait the client can act on', r.details.retryAfterSeconds > 0, true);
    check('and the standard header', r.headers.get('retry-after'), String(r.details.retryAfterSeconds));
    check('the envelope is the project one, not the library default', r.body.success, false);
    check(
      'another user behind the same address has their own quota',
      (await call('/api/v1/rate', { user: users.U2 })).status,
      200
    );
  }
  {
    for (const attempt of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call('/plain/rate');
      check(`anonymous request ${attempt} of 3`, r.status, 200);
    }
    const r = await call('/plain/rate');
    check('an anonymous caller over the limit', r.status, 429);
    check('scope', r.details.scope, 'verify-anon');
  }
  {
    const results = [];
    for (const _attempt of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      results.push((await call('/plain/no-limit')).status);
    }
    check('a disabled limiter never refuses', results, [200, 200, 200]);
  }
  {
    /* Limit 1 with skipSuccessfulRequests: successes are not counted, so only failures accumulate. */
    const first = await call('/plain/failures-only');
    const second = await call('/plain/failures-only');
    check('successes are not counted against a credential limiter', [first.status, second.status], [200, 200]);
    check('one failure is within the limit', (await call('/plain/failures-only?fail=1')).status, 401);
    const r = await call('/plain/failures-only?fail=1');
    check('a second failure is refused', r.status, 429);
    check('scope', r.details.scope, 'verify-failures');
  }

  /* ─────────────────── csrf over HTTP ─────────────────── */

  console.log('\n--- csrf over HTTP ---');
  const cookieName = config.security.csrfCookieName;
  let token = null;
  {
    const requestId = nextRequestId('csrf');
    const res = await fetch(`${base}/csrf/token`, { headers: { 'X-Request-Id': requestId } });
    const payload = await res.json();
    token = payload.data.token;
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${cookieName}=`));

    check('a token is issued', /^[0-9a-f]{64}$/.test(token), true);
    check('and published as a cookie', Boolean(setCookie), true);
    check('the frontend has to read it, so it is not HttpOnly', /HttpOnly/i.test(setCookie), false);
    check('scoped to the whole site', /Path=\//.test(setCookie), true);
    check('SameSite=Lax', /SameSite=Lax/i.test(setCookie), true);
    check('the cookie carries the same token', setCookie.startsWith(`${cookieName}=${token}`), true);
  }
  check('a safe method needs no token', (await call('/csrf/guarded')).status, 200);
  {
    const r = await call('/csrf/guarded', { method: 'POST' });
    check('no cookie and no header -> 403', r.status, 403);
    check('code', r.code, 'CSRF_TOKEN_INVALID');
  }
  check(
    'the cookie alone is not enough',
    (await call('/csrf/guarded', { method: 'POST', headers: { Cookie: `${cookieName}=${token}` } })).code,
    'CSRF_TOKEN_INVALID'
  );
  check(
    'the header alone is not enough',
    (await call('/csrf/guarded', { method: 'POST', headers: { 'X-CSRF-Token': token } })).code,
    'CSRF_TOKEN_INVALID'
  );
  check(
    'a mismatch is refused',
    (
      await call('/csrf/guarded', {
        method: 'POST',
        headers: { Cookie: `${cookieName}=${token}`, 'X-CSRF-Token': 'f'.repeat(64) },
      })
    ).code,
    'CSRF_TOKEN_INVALID'
  );
  check(
    'the three failures are indistinguishable to a caller',
    (await call('/csrf/guarded', { method: 'POST' })).message,
    'This request could not be verified. Please refresh and try again.'
  );
  check(
    'both halves together pass',
    (
      await call('/csrf/guarded', {
        method: 'POST',
        headers: { Cookie: `${cookieName}=${token}`, 'X-CSRF-Token': token },
      })
    ).status,
    200
  );
  {
    const requestId = nextRequestId('csrf');
    const res = await fetch(`${base}/csrf/logout`, {
      method: 'POST',
      headers: {
        'X-Request-Id': requestId,
        Cookie: `${cookieName}=${token}`,
        'X-CSRF-Token': token,
      },
    });
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith(`${cookieName}=`));
    check('logout clears the token', res.status, 200);
    check('by expiring the cookie', /Expires=Thu, 01 Jan 1970/i.test(cleared), true);
  }
  {
    const r = await call('/csrf/guarded', { method: 'POST', origin: bareBase });
    check('without cookie-parser the guard fails closed, not open', r.status, 500);
    check('and reports it as our defect', r.code, 'INTERNAL_ERROR');
  }
  {
    config.security.csrfEnabled = false;
    const r = await call('/csrf/guarded', { method: 'POST' });
    config.security.csrfEnabled = true;
    check('CSRF_ENABLED=false lets a suite drive the endpoint directly', r.status, 200);
  }

  /* ─────────────────── activity logging over HTTP ─────────────────── */

  console.log('\n--- activityAudit over HTTP ---');

  /** The row a request wrote, polled for because the insert is deliberately not awaited. */
  async function activityFor(requestId, attempts = 60) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const row = await db.ActivityLog.findOne({ where: { request_id: requestId } });
      if (row) return row;
      // eslint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    return null;
  }

  /** No row. There is nothing to poll for, so a grace period is waited out first. */
  async function noActivityFor(requestId) {
    await sleep(400);
    return db.ActivityLog.count({ where: { request_id: requestId } });
  }

  {
    const r = await call('/api/v1/logged', { user: users.U7, method: 'POST', body: { a: 1 }, label: 'log' });
    check('the request itself succeeded', r.status, 200);
    const row = await activityFor(r.requestId);
    check('a declared route writes one row', Boolean(row), true);
    check('the declared action', row.action, 'create');
    check('entity type', row.entity_type, 'student');
    check('description', row.description, 'Created a pupil');
    check('status code', row.status_code, 200);
    check('method', row.method, 'POST');
    check('path', row.path, '/api/v1/logged');
    check('school from the tenant', Number(row.school_id), schools.U7.id);
    check('organization from the tenant', Number(row.organization_id), orgs.one.id);
    check('user', Number(row.user_id), users.U7.id);
    check('the email is kept so the row survives the user', row.user_email, users.U7.email);
    check('the role that acted', row.role_slug, ROLES.PRINCIPAL);
    check('address', typeof row.ip_address, 'string');
    check('and the request can be traced across the logs', row.request_id, r.requestId);
    check('duration was measured', typeof row.metadata.durationMs, 'number');
    check('nothing hostile to report', row.metadata.sanitized, undefined);
  }
  {
    const r = await call('/api/v1/inferred', { user: users.U7, method: 'PUT', body: {}, label: 'log' });
    const row = await activityFor(r.requestId);
    check('an undeclared action is inferred from the verb', row.action, 'update');
    check('with no entity type to report', row.entity_type, null);
  }
  {
    const r = await call('/api/v1/undeclared', { user: users.U7, label: 'log' });
    check('a route that declared nothing succeeded', r.status, 200);
    check('and wrote no row — FR-LOG-001 asks for actions, not traffic', await noActivityFor(r.requestId), 0);
  }
  {
    const r = await call('/api/v1/only-success', { user: users.U7, method: 'POST', body: {}, label: 'log' });
    check('the route refused', r.status, 400);
    check('onlyOnSuccess skips the row', await noActivityFor(r.requestId), 0);
  }
  {
    const r = await call('/api/v1/also-failed', { user: users.U7, method: 'POST', body: {}, label: 'log' });
    const row = await activityFor(r.requestId);
    check('without onlyOnSuccess a failure is still recorded', Boolean(row), true);
    check('with the status it failed at', row.status_code, 400);
  }
  {
    const r = await call('/api/v1/described/17', { user: users.U7, method: 'POST', body: {}, label: 'log' });
    const row = await activityFor(r.requestId);
    check('a handler can name the record it touched', Number(row.entity_id), 9042);
    check('and add to the metadata', row.metadata.note, 'from the handler');
    check('the route\u2019s own fields survive', row.entity_type, 'invoice');
  }
  {
    const r = await call('/api/v1/param/2024', { user: users.U7, method: 'POST', body: {}, label: 'log' });
    const row = await activityFor(r.requestId);
    check('an entity id defaults to the route parameter', Number(row.entity_id), 2024);
  }
  {
    const r = await call('/api/v1/logged', {
      user: users.U7,
      method: 'POST',
      raw: '{"note":"x<script>steal()</script>","__proto__":{"polluted":true}}',
      label: 'log',
    });
    const row = await activityFor(r.requestId);
    check('a sanitised request is folded into whatever row it wrote', row.metadata.sanitized.cleaned, 1);
    check('and the dropped key is named', row.metadata.sanitized.dropped, ['__proto__']);
    check('the action is still the route\u2019s own', row.action, 'create');
    check('and nothing reached Object.prototype', {}.polluted, undefined);
  }
  {
    const r = await call(`/api/v1/schools/${schools.U8.id}/thing`, { user: users.U7, label: 'deny' });
    check('a cross-tenant reference is refused', r.status, 403);
    check('code', r.code, 'CROSS_TENANT_ACCESS_DENIED');
    const row = await activityFor(r.requestId);
    check('and recorded even though the route asked for nothing', Boolean(row), true);
    check('as the one action SRS §26 has for it', row.action, 'access_denied');
    check('naming what was reached for', row.description, `Refused access to school ${schools.U8.id}`);
    check('the refused status', row.status_code, 403);
    check('the caller\u2019s own school, not the one they tried', Number(row.school_id), schools.U7.id);
    check('with the whole violation kept', row.metadata.violation.attempted, {
      kind: 'school',
      value: String(schools.U8.id),
    });
    check('and where in the request it came from', row.metadata.violation.location, 'path');
  }

  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => bareServer.close(resolve));
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nVerification aborted:', err);
  })
  .finally(async () => {
    await dropFixtures();
    console.log(failures === 0 ? '\nAll middleware checks passed.' : `\n${failures} check(s) FAILED.`);
    await db.sequelize.close();
    process.exit(failures === 0 ? 0 : 1);
  });
