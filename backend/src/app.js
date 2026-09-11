'use strict';

/**
 * The Express application — SRS §3 (Node/Express), §24 (security), §27 (deployment).
 *
 * This file is only wiring. It contains no business logic and no route handlers, because its single
 * job is to establish the order the pipeline runs in, and that order is a dependency chain rather
 * than a matter of taste. `src/middlewares/index.js` documents the same sequence in its header; the
 * two are meant to be read together, and a change here that is not reflected there is a bug in the
 * pair.
 *
 * ## Why each step sits where it does
 *
 *  1. `trust proxy` — set before anything reads `req.ip`. The rate limiter keys on it, so getting
 *     this wrong either collapses every client behind nginx onto one shared quota or lets a caller
 *     forge `X-Forwarded-For` and mint a fresh quota per request.
 *  2. `requestContext` — first middleware, so every log line, error envelope and audit row from here
 *     on carries the same request id.
 *  3. `helmet`, `cors`, `compression` — transport-level, before any work is done on the body.
 *  4. Body parsers — `req.body` has to exist before anything can clean or validate it.
 *  5. `cookieParser` — `csrf.js` throws a deliberate 500 if it runs without this, rather than
 *     failing open. That is asserted by the verification suite, so this line is load-bearing.
 *  6. `hpp` — after the parsers, since it works on the parsed query and body.
 *  7. `sanitizeRequest` — before anything reads the payload. A multipart body is not visible yet and
 *     is cleaned separately inside the upload chain.
 *  8. `apiLimiter` — a cheap refusal before any database work. After sanitising so a hostile payload
 *     is still recorded, before authentication so an unauthenticated flood is still bounded.
 *  9. `activityAudit()` — registers the `res.on('finish')` writer. It has to be installed before the
 *     handlers that describe what to write, and it writes nothing unless one of them does.
 * 10. The API router — public system routes and the public half of `/auth`, then the authentication
 *     chain, then the authenticated half of `/auth` and (as Phase 3.D proceeds) the other modules.
 * 11. `notFoundHandler`, then `errorHandler` — last, in that order. Both are error-terminal: nothing
 *     may be mounted after them or it will never run.
 *
 * ## What is deliberately not here
 *
 * No `app.listen`. Binding a port is `server.js`'s job, which keeps this module importable by a test
 * or a verification script without starting anything.
 *
 * No route handlers. The modules own theirs; this file only decides where each router is mounted
 * relative to the boundary, which is the one part of routing that cannot live inside a module.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const hpp = require('hpp');
const morgan = require('morgan');

const { router: docsRoutes } = require('./docs/routes');
const config = require('./config/env');
const logger = require('./config/logger');
const ApiError = require('./utils/ApiError');
const { createRouter } = require('./utils/createRouter');
const {
  requestContext,
  sanitizeRequest,
  apiLimiter,
  activityAudit,
  authenticate,
  enforcePasswordChange,
  resolveTenant,
  enforceTenant,
  notFoundHandler,
  errorHandler,
} = require('./middlewares');
const systemRoutes = require('./modules/system/system.routes');
const authRoutes = require('./modules/auth/auth.routes');
const platformRoutes = require('./modules/platform/platform.routes');
const organizationRoutes = require('./modules/organizations/organizations.routes');
const schoolRoutes = require('./modules/schools/schools.routes');
const principalRoutes = require('./modules/principals/principals.routes');
const userRoutes = require('./modules/users/users.routes');
const roleRoutes = require('./modules/roles/roles.routes');
const planRoutes = require('./modules/plans/plans.routes');
const addonRoutes = require('./modules/addons/addons.routes');
const subscriptionRoutes = require('./modules/subscriptions/subscriptions.routes');

// Phase 3.H — billing (SRS §13): taxes and coupons build the modifiers, invoices bill, payments settle,
// quotations pre-sell. Each is a plain router built with createRouter(); mounted below the auth boundary.
const taxRoutes = require('./modules/taxes/taxes.routes');
const couponRoutes = require('./modules/coupons/coupons.routes');
const invoiceRoutes = require('./modules/invoices/invoices.routes');
const paymentRoutes = require('./modules/payments/payments.routes');
const quotationRoutes = require('./modules/quotations/quotations.routes');

// Phase 3.I — school setup (SRS §14): settings, sessions, classes/sections, subjects/assignments.
// Each is a plain router built with createRouter(); mounted below the auth boundary.
const settingsRoutes = require('./modules/settings/settings.routes');
const sessionRoutes = require('./modules/sessions/sessions.routes');
const classRoutes = require('./modules/classes/classes.routes');
const subjectRoutes = require('./modules/subjects/subjects.routes');

// Phase 3.J — people (SRS §15). Unlike the §14 routers these are entitlement-gated: each mounts
// requireModule() for its own MODULES key, because the `module` field on a permission is metadata
// and nothing in the request path reads it.
const teacherRoutes = require('./modules/teachers/teachers.routes');
const studentRoutes = require('./modules/students/students.routes');
const parentRoutes = require('./modules/parents/parents.routes');
const staffRoutes = require('./modules/staff/staff.routes');

// Phase 3.K — attendance (SRS §16). The first module that consumes students and teachers rather than
// creating them, and the first whose write is naturally bulk.
const attendanceRoutes = require('./modules/attendance/attendance.routes');

// Phase 3.L — fees (SRS §17). The first school-side module that handles money; it reuses §13's
// `utils/money.js` and `utils/documentNumber.js` rather than growing a second arithmetic.
const feeRoutes = require('./modules/fees/fees.routes');

// Phase 3.M — finance (SRS §18). Income and expenses, and the one figure the SRS states outright:
// Income − Expense = Net Balance, computed at query time because there is no column to store it in.
const financeRoutes = require('./modules/finance/finance.routes');

// Phase 3.N — examinations & results (SRS §19). Five tables and the project's first cohort-wide
// recompute: one student's mark moves every other student's position.
const examRoutes = require('./modules/exams/exams.routes');

// Phase 3.O — timetable (SRS §20.1). FR-TT-002's conflict detection is the first guard in the
// project that a fixed unique index can only half-enforce: `section_id` is nullable.
const timetableRoutes = require('./modules/timetable/timetable.routes');

// Phase 3.P — homework (SRS §20.2). The first module in the application that actually performs an
// upload: the `homework` multer profile has existed, citing FR-HW-001, with no caller until now.
const homeworkRoutes = require('./modules/homework/homework.routes');

// Phase 3.Q — assignments (SRS §20.3). One table holds both halves of FR-ASG-001's lifecycle:
// `record_type` separates the teacher's assignment from a student's submission, because §29 lists no
// submissions table. The first module where a student's own request writes a row.
const assignmentRoutes = require('./modules/assignments/assignments.routes');

// Phase 3.R — library (SRS §20.4). The first module in the project with a shared counter:
// `books.available_quantity` is contended by concurrent issues, so issue/return/quantity-edit all
// take a locking read on the book row.
const libraryRoutes = require('./modules/library/library.routes');

// Phase 3.S — documents (SRS §20.5). The only router in the application that does NOT mount
// requireModule(): DOCUMENT_TYPE_MODULE maps the seven document types onto four different subscribable
// modules, so the gate is per request and lives in the service.
const documentRoutes = require('./modules/documents/documents.routes');

// Phase 3.T — AI module (SRS §21). The first module in the project to call
// `usageService.recordUsage`, which has had zero call sites since it was written, and the first caller
// of both `aiLimiter` and the `ai_source` upload profile. Its provider sits behind `src/ai/`.
const aiRoutes = require('./modules/ai/ai.routes');

// Phase 3.U — reports (SRS §22). The first READ-ONLY module — §22 has no table of its own, so a report
// is a read across tables other modules own — and the first that can answer with something other than
// JSON. Two of its seven reports delegate to the computations §16 and §18 already ship.
const reportRoutes = require('./modules/reports/reports.routes');

// Phase 3.V — notifications (SRS §23). One requirement whose actor is `System`, so this router carries
// only the reading surface: an inbox, a mark-read and a retry. The nine documented types are dispatched
// by `notificationsService.runNotificationSweep()`, which has **no route** for the same reason
// `runLifecycleSweep()` has none. Core rather than subscribable — there is no `MODULES.NOTIFICATIONS`.
const notificationRoutes = require('./modules/notifications/notifications.routes');
const logRoutes = require('./modules/logs/logs.routes');

/*
 * SRS §25's queue handlers. `config/queue.js` has had `registerHandler()` and no caller since
 * August; this is where the API process registers them, so `enqueue()` from a request path has
 * something to run. Idempotent — the worker process registers the same set for itself.
 */
const { registerAll: registerJobHandlers } = require('./jobs/handlers');

/**
 * The CORS options.
 *
 * An allow-list, not a reflector. `origin: true` echoes whatever the caller sent, which combined with
 * `credentials: true` would let any site read authenticated responses — and the refresh cookie makes
 * `credentials` non-optional.
 *
 * A request with no `Origin` is allowed through: that is a server-to-server caller, a health probe or
 * curl, none of which CORS governs. CORS constrains what a *browser* will hand to a page; it is not
 * an authentication mechanism, and treating a missing origin as hostile would break every non-browser
 * client while stopping nothing.
 */
function corsOptions() {
  const allowed = config.app.corsOrigins;

  return {
    origin(origin, callback) {
      if (!origin || allowed.includes(origin)) return callback(null, true);

      logger.warn('CORS origin refused', { origin });
      return callback(
        new ApiError(403, 'This origin is not allowed to call the API.', {
          code: 'ORIGIN_NOT_ALLOWED',
          details: { origin },
        })
      );
    },
    credentials: true,
    /* `X-CSRF-Token` is the double-submit header; without it here the browser preflight refuses it. */
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-Id'],
    /*
     * `X-Request-Id` so a client can read the id of the request it just made and quote it in a bug
     * report. `Content-Disposition` so a download keeps the server's filename: the browser hides every
     * non-safelisted response header from a cross-origin caller, and `api.download()` fell back to a
     * name of its own on every export, report and attachment.
     */
    exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
    maxAge: 600,
  };
}

/**
 * Morgan piped into Winston.
 *
 * `activityAudit` records business events — who changed what — and is silent for everything else, so
 * without this there would be no record that a request arrived at all.
 *
 * Logged at `info`, not at winston's `http` level: npm's levels put `http` (3) below `info` (2), so
 * with the default `LOG_LEVEL=info` every line would be discarded and this middleware would look
 * like it worked while recording nothing. Turn it down with `LOG_LEVEL=warn` on a deployment whose
 * nginx access log already covers this (SRS §27).
 *
 * Skipped under test, where it is pure noise on the verification output.
 */
function requestLogging() {
  return morgan(':method :url :status :res[content-length] - :response-time ms', {
    skip: () => config.isTest,
    stream: { write: (line) => logger.info(line.trim()) },
  });
}

/**
 * Build the application.
 *
 * A factory rather than a module-level singleton, so a test can build a fresh app without inheriting
 * another one's state. Note that `apiLimiter` is itself a singleton from the barrel — its counters
 * are shared across apps built in the same process, which is correct for the real deployment and
 * worth knowing in a test that asserts on 429s.
 *
 * @returns {import('express').Express}
 */
function createApp() {
  const app = express();

  /*
   * SRS §25's queue handlers, registered before any route can enqueue.
   *
   * Idempotent, so repeated `createApp()` calls in a verification suite register once. Done here
   * rather than at module load because a require should not have side effects — and because the
   * worker process registers the same set for itself, so neither depends on the other having run.
   */
  registerJobHandlers();

  /* Step 1 — before the limiter, or `req.ip` is meaningless. See config/env.js `trustProxy()`. */
  app.set('trust proxy', config.app.trustProxy);

  /* Express advertises itself in a header by default. There is no reason to help fingerprinting. */
  app.disable('x-powered-by');

  /* Step 2 */
  app.use(requestContext);
  app.use(requestLogging());

  /* Step 3 */
  app.use(
    helmet({
      /*
       * This process serves JSON, not HTML, so a Content-Security-Policy here governs nothing — the
       * frontend is a separate Next.js origin that sets its own (ARCHITECTURE §7). Left on anyway:
       * it costs one header and it applies to the one HTML surface this app will grow, the §28
       * Swagger UI, whose own assets are same-origin.
       */
      crossOriginResourcePolicy: { policy: 'same-site' },
    })
  );
  app.use(cors(corsOptions()));
  app.use(compression());

  /* Step 4 */
  app.use(express.json({ limit: config.app.jsonBodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: config.app.jsonBodyLimit }));

  /* Step 5 — required by `requireCsrfToken`, which fails closed without `req.cookies`. */
  app.use(cookieParser());

  /* Step 6 */
  app.use(hpp());

  /* Step 7 */
  app.use(sanitizeRequest);

  /* Step 8 */
  app.use(apiLimiter);

  /* Step 9 */
  app.use(activityAudit());

  /* Step 10 */
  app.use(config.app.apiPrefix, buildApiRouter());

  /* Step 11 — nothing may be mounted after these. */
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * The `/api/v1` router.
 *
 * Split into a public half and an authenticated half, with the boundary drawn once here instead of
 * repeated on every route. Anything mounted after the chain below is authenticated, tenant-resolved
 * and tenant-enforced by construction — a module cannot forget to be.
 *
 * @returns {import('express').Router}
 */
function buildApiRouter() {
  const api = createRouter();

  /* Public: liveness, readiness, the API descriptor, and the CSRF bootstrap. */
  api.use('/', systemRoutes);

  /*
   * §28's Swagger UI and OpenAPI document — FR-APIDOC-001. Mounted above the authentication
   * boundary because a document describing how to obtain a token is of no use to a caller who
   * needs a token to read it, and because the generators that consume OpenAPI do not carry one.
   * It reads routes and Joi schemas only, never the database. See src/docs/routes.js.
   */
  api.use('/docs', docsRoutes);

  /*
   * The public half of §7. Mounted above the boundary because these five endpoints are how a caller
   * gets a token in the first place — `authenticate` below would reject every one of them. The module
   * splits itself into two routers precisely so this line and the one after the boundary can differ;
   * see the header of `auth.routes.js`.
   */
  api.use('/auth', authRoutes.publicRoutes);

  /*
   * The boundary. Layer 2 (`resolveTenant`) and layer 3 (`enforceTenant`) of the four-layer isolation
   * chain are mounted here, once, for everything below — the other two layers are the `school_id`
   * columns themselves and `tenantWhere()` in the query layer.
   *
   * `enforcePasswordChange` takes its exception list here rather than owning one, so the whole set of
   * routes reachable while a forced change is outstanding is visible in one place. It is deliberately
   * short: the call that clears the flag, and the one that walks away. Nothing else is needed — the
   * refusal carries `PASSWORD_CHANGE_REQUIRED`, which is what tells a client to show the
   * change-password screen. The bootstrap Super Admin is seeded with the flag set, so this list is the
   * only thing that account can reach.
   *
   * The forced change itself is not an SRS functional requirement — `must_change_password` is a column
   * this implementation added so that a seeded or administrator-set password cannot survive first
   * login. It supports FR-AUTH-004 (passwords are never stored recoverably) and §9.3, where a Super
   * Admin types a Principal's initial password; the SRS specifies neither behaviour, and this is the
   * safest reading of both.
   */
  api.use(
    authenticate,
    enforcePasswordChange({ allow: ['/auth/change-password', '/auth/logout'] }),
    resolveTenant,
    enforceTenant
  );

  /*
   * The authenticated half of §7. First below the boundary, and it must be: the two paths named in
   * `enforcePasswordChange` above are in this router, so a user with `must_change_password` set can
   * reach these and nothing else.
   */
  api.use('/auth', authRoutes.protectedRoutes);

  /*
   * The Super Admin platform surface — SRS §9. Mounted below the boundary, so every route in these four
   * modules is authenticated, tenant-resolved and tenant-enforced without asking to be.
   *
   *   /platform       §9.1  FR-SADMIN-001                the eleven dashboard metrics
   *   /organizations  §5, §33                            the rows FR-SADMIN-002's precondition needs
   *   /schools        §9.2  FR-SADMIN-002 … FR-SADMIN-008  the nine School Management operations
   *   /principals     §9.3  FR-SADMIN-009                 Principal creation, and the list §9.2's
   *                                                       Assign Principal selects from
   *
   * `/organizations` and `/schools` are mounted at the paths `enforceTenant.collectFromPath()` already
   * recognises, so a cross-tenant `/schools/8` is refused by layer 3 before either module's own scope
   * helper runs. That overlap is intended: the two checks are independent, and neither is load-bearing
   * alone.
   */
  api.use('/platform', platformRoutes);
  api.use('/organizations', organizationRoutes);
  api.use('/schools', schoolRoutes);
  api.use('/principals', principalRoutes);

  /*
   * Accounts and access — SRS §33 "Users", §29's `roles` / `permissions` / `role_permissions`, and the
   * data FR-AUTH-008 and FR-AUTH-009's middleware read.
   *
   *   /users   §33, FR-AUTH-007      the Users screen: list, view, edit, per-user permission overrides
   *   /roles   §29, FR-AUTH-009      §5's eleven roles and the platform-wide grant set behind each
   *
   * Unlike the four above, `/users` is **not** platform-only: `users.view` is granted to Organization
   * Admin and `users.manage` to school leadership by `config/permissions.js`, so a Principal manages
   * their own school's accounts here. That is exactly why it sits below the boundary — `resolveTenant`
   * and `enforceTenant` have already run, and `tenantWhere()` in the service confines every query.
   *
   * `/roles` splits its guards instead: the reads are open to `users.view`, the writes are
   * `requirePlatformScope()` + `roles.manage`, because `role_permissions` has no `school_id` and one
   * edit there changes every school on the platform. That module's own header sets out the reasoning.
   */
  api.use('/users', userRoutes);
  api.use('/roles', roleRoutes);

  /*
   * Subscription plans — SRS §10 (Plan Builder, billing cycles, pricing models) and §11 (modules,
   * features, limits), covering FR-SUB-001 … FR-SUB-007.
   *
   *   /plans   §10, §11   the catalogue every subscription resolves its entitlements from
   *
   * Guarded like `/roles`, and for the same reason: `subscription_plans` has no `school_id`, so a plan
   * row belongs to the platform and one edit to its limits changes what every school on that plan may
   * do. Every write therefore carries `requirePlatformScope()` on top of its `plans.*` permission. The
   * reads do not — SRS §12.3 has a school choosing an upgrade target — and are confined instead by
   * `plans.service.scopeFor()`, which shows a non-platform caller only the active, public plans.
   *
   * This is also the first module whose writes must invalidate the entitlement cache: a plan's modules,
   * features and limits are read into a per-school snapshot, so `requireModule`, `requireFeature` and
   * `enforceLimit` would otherwise keep enforcing the previous configuration until a TTL lapsed.
   */
  api.use('/plans', planRoutes);

  /*
   * Add-ons — SRS §11.3, covering FR-SUB-009.
   *
   *   /addons   §11.3   the seven add-ons a school may buy on top of its base plan
   *
   * Guarded like `/plans`: the writes carry `requirePlatformScope()` because `addons` has no `school_id`,
   * and the reads do not, because FR-SUB-009's own **Description** is *"Super Admin and/or school configure add-ons"* (SRS:521 —
   * its Actor / Role line one line below reads only *"Super Admin"*) — a school
   * has to be able to see what it can buy. `addons.service.scopeFor()` confines a non-platform caller to
   * the active add-ons and their active prices.
   *
   * Unlike `/plans`, this module's writes deliberately invalidate **nothing**. `entitlementService`
   * resolves add-ons from `subscription_addons`, which copies `effect_type`, `effect_target` and
   * `units_granted` at the moment of purchase and is never joined back to `addons` — so editing a
   * catalogue row changes what the next purchase grants and cannot stale a snapshot. The invalidation
   * obligation belongs to whatever writes `subscription_addons`. `addons.service.js` states this at
   * length, because an absent `invalidate*` call is otherwise indistinguishable from a forgotten one.
   */
  api.use('/addons', addonRoutes);

  /*
   * Subscriptions — SRS §12 (the lifecycle) and §33 (feature overrides, custom limits, custom
   * pricing), covering FR-SUB-010 … FR-SUB-015 plus the purchase half of FR-SUB-009.
   *
   *   /subscriptions   §12, §33   what actually puts a school on a plan
   *
   * The module the two catalogues above exist for. `/plans` and `/addons` build the offer and neither
   * can be sold from; this one writes `subscriptions`, `subscription_items`, `subscription_addons`,
   * `subscription_overrides` and `subscription_history`.
   *
   * Guarded three ways rather than one, because the SRS actor lines differ per requirement.
   * FR-SUB-010 (*"System / Super Admin"*) and FR-SUB-011/012 (*"Super Admin"*) get
   * `requirePlatformScope()` on top of their permission — creating a subscription names a `school_id`
   * in the body, which `enforceTenant.checkReference()` permits only for a platform caller.
   * FR-SUB-013/014/015 (*"Super Admin / School"*) and FR-SUB-009's purchase (*"Super Admin and/or
   * school"*) instead pair the platform key with the `subscriptions.self.*` key seeded to `principal`
   * and `school_admin`; the tenant boundary still holds because every read folds `tenantWhere()` into
   * its `where`, so a school naming another school's subscription gets a 404. The module header sets
   * out each case against the sentence it comes from.
   *
   * This module is the counterpart to the invalidation obligation `/addons` deliberately declines.
   * It writes the three tables `entitlementService.resolve()` actually reads, and it owns
   * `schools.subscription_state` — so every write calls both `entitlementService.invalidateSchool()`
   * and, when the cached state moves, `tenantService.invalidateSchool()`.
   *
   * FR-SUB-015's Automatic Renewal and the date-driven half of FR-SUB-010 are implemented as
   * `subscriptionsService.runLifecycleSweep()` and have **no route**: their actor is the system, and
   * the scheduler runs it — the hourly `subscription-lifecycle` job in `src/jobs/`.
   */
  api.use('/subscriptions', subscriptionRoutes);

  /*
   * Phase 3.H — billing (SRS §13). The five modules form the money pipeline in dependency order: `/taxes`
   * and `/coupons` are the catalogue of modifiers an invoice cites; `/invoices` bills a subscription and
   * applies exactly one coupon and one tax to its lines; `/payments` settles an invoice and carries the
   * refund sub-resource; `/quotations` is the pre-sales document that, once accepted, converts into an
   * invoice through the same `invoices.service.issue()` primitive. Each router already carries its own
   * permission and platform-scope guards; they sit here, below `authenticate → resolveTenant →
   * enforceTenant`, so every read is tenant-confined and every write is scope-checked before it runs.
   */
  api.use('/taxes', taxRoutes);
  api.use('/coupons', couponRoutes);
  api.use('/invoices', invoiceRoutes);
  api.use('/payments', paymentRoutes);
  api.use('/quotations', quotationRoutes);

  /*
   * Phase 3.I — school setup (SRS §14). Four modules, four mounts, none of them the platform
   * `schools/` router: that one owns the tenant row (create / archive / suspend). These own the
   * school's own settings and academic structure — Principal / School Admin is the actor, so there
   * is no `requirePlatformScope()`. Isolation is `resolveSchool()` plus `tenantWhere()`.
   *
   *   /school-settings  §14.1  FR-SCHOOL-001   Logo, Name, Address, Phone, Email, Website, Favicon,
   *                                            Theme, Currency, Timezone
   *   /sessions         §14.2  FR-SCHOOL-002   Create / Activate / Close (no DELETE)
   *   /classes          §14.3  FR-SCHOOL-003   Classes, sections, class teachers
   *   /subjects         §14.4  FR-SCHOOL-004   Subjects, class assignment, teacher assignment
   *
   * They sit here, below `authenticate → resolveTenant → enforceTenant`, so a school caller naming
   * another school's id is `CROSS_TENANT_ACCESS_DENIED` (layer 3, before the module runs) and a
   * platform caller without `school_id` is a 422 from `resolveSchool()`.
   */
  api.use('/school-settings', settingsRoutes);
  api.use('/sessions', sessionRoutes);
  api.use('/classes', classRoutes);
  api.use('/subjects', subjectRoutes);

  /*
   * Phase 3.J — people (SRS §15).
   *
   *   /teachers  §15.3  FR-TEACHER-001 / 002  Teacher profiles, assignments, teacher dashboard
   *
   * Same side of the boundary as §14, with one addition: `teacherRoutes` mounts
   * `requireModule('teachers')` on itself, so a school whose plan does not carry the Teachers
   * module gets `MODULE_NOT_SUBSCRIBED` rather than a 200. This is the first entitlement guard
   * mounted on a real feature route in the project.
   */
  api.use('/teachers', teacherRoutes);
  api.use('/students', studentRoutes);
  api.use('/parents', parentRoutes);
  api.use('/staff', staffRoutes);
  api.use('/attendance', attendanceRoutes);
  api.use('/fees', feeRoutes);
  api.use('/finance', financeRoutes);
  api.use('/exams', examRoutes);
  api.use('/timetable', timetableRoutes);
  api.use('/homework', homeworkRoutes);
  api.use('/assignments', assignmentRoutes);
  api.use('/library', libraryRoutes);
  api.use('/documents', documentRoutes);
  api.use('/ai', aiRoutes);
  api.use('/reports', reportRoutes);

  /*
   * Phase 3.V — notifications (SRS §23). The engine that §29 designed the five marker columns for:
   * `homework.notified_at`, `exams.announced_at`, `student_attendance.alert_sent_at`,
   * `student_fees.reminder_sent_at` and `subscriptions.expiry_notified_at`, whose own comments name a
   * cron. Dispatch is `runNotificationSweep()` and has no route; this mount is the inbox.
   */
  api.use('/notifications', notificationRoutes);

  /*
   * SRS §26 — "Errors and activity are auditable via logs". The activity and audit trails, read on
   * `logs.view`, which the catalogue granted and nothing mounted. Reads only, tenant-confined.
   */
  api.use('/logs', logRoutes);

  return api;
}

module.exports = { createApp, corsOptions };
