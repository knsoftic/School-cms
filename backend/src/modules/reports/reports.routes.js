'use strict';

/**
 * Report routes — mounted at `/api/v1/reports`. SRS §22, FR-REPORT-001 and FR-REPORT-002.
 *
 * | § | Route | Permissions | Modules |
 * |---|---|---|---|
 * | Student | `GET /students` | `reports.view` + `students.view` | reports + students |
 * | Attendance | `GET /attendance` | `reports.view` + `attendance.view` | reports + attendance |
 * | Fee | `GET /fees` | `reports.view` + `fees.view` | reports + fees |
 * | Expense | `GET /expenses` | `reports.view` + `finance.view` | reports + finance |
 * | Exam | `GET /exams` | `reports.view` + `exams.view` | reports + exams |
 * | Teacher | `GET /teachers` | `reports.view` + `teachers.view` | reports + teachers |
 * | Subscription | `GET /subscriptions` | `reports.subscription.view` | **none** |
 *
 * Seven routes for §22's seven reports. All GET — this is the **first read-only module** in the
 * application, because §22 has no table of its own and a report writes nothing.
 *
 * ## Two permissions per report, and why that is a narrowing worth making
 *
 * `reports.view` is granted to Super Admin, Organization Admin, Principal, School Admin, Teacher,
 * Accountant **and Librarian** — a wider set than the underlying modules allow. `finance.view` reaches
 * neither Teacher nor Librarian; `fees.view` reaches neither; `teachers.view` reaches neither Teacher
 * nor Accountant. So `reports.view` on its own would let a Librarian read the school's expense ledger
 * through §22 that §18 refuses them directly — the report becoming a way around the permission on the
 * data it reports.
 *
 * Each route therefore requires **both** keys: the reporting surface *and* the module's own read. A
 * caller sees a report exactly when they could already have read the rows behind it.
 *
 * This is consistent with FR-REPORT-001, which names Super Admin / Principal / School Admin /
 * Accountant / Teacher as the actors for the reports collectively rather than for each of the seven: a
 * Teacher generating Student, Attendance and Exam reports satisfies it, and an Accountant generating
 * Fee and Expense reports satisfies it. What it does not do is invent a disclosure the FR never asks
 * for. The catalogue over-grant — Organization Admin and Librarian hold `reports.view` while
 * FR-REPORT-001 names neither — is recorded rather than corrected, because §29/§35 fix the catalogue.
 *
 * ## No router-level guard — alone among the entitlement-aware modules
 *
 * Fifteen module routers reference `requireModule()` or `requireActiveSubscription()`; fourteen mount
 * one at router level and this is the only one that does not. (The other nineteen routers — §9's
 * platform surface, §13 billing, §14 school setup — mount none either, but they are not
 * entitlement-aware at all, so they are a different case and not a precedent.)
 *
 * It mounts none because the Subscription Report can pass neither guard.
 *
 * `reports.subscription.view` is declared with **`module: null`** and granted only to Super Admin and
 * Organization Admin — the two scopes that have no single school. A module gate resolves one school or
 * refuses with `SCHOOL_CONTEXT_REQUIRED`, so an organization-wide report is structurally unreachable
 * through one. The six school reports carry their gates per route instead, naming **both** modules:
 * `requireModule(MODULES.REPORTS, MODULES.X)` — you bought reporting, and you bought the thing being
 * reported on.
 *
 * ## The export permission is conditional, because the format is
 *
 * `reports.export` guards an export and not a read. A JSON report is the report itself, not an export
 * of it, so requiring the key on every route would deny a plain read to a role that may perfectly well
 * have it. The guard runs after `validate`, so it sees the coerced, defaulted `format`.
 */

const { createRouter } = require('../../utils/createRouter');
const {
  asyncHandler,
  validate,
  logActivity,
  requirePermission,
  requireModule,
  requireFeature,
} = require('../../middlewares');
const {
  MODULES,
  REPORT_TYPES,
  REPORT_FORMATS,
  ADDONS,
  ADDON_EFFECTS,
} = require('../../config/constants');

const controller = require('./reports.controller');
const { schemas } = require('./reports.validation');
const { annotate, respondsWithFile } = require('../../utils/routeMeta');

const router = createRouter();

/** When the two export guards below apply — any `format` but the on-screen JSON. */
const WHEN_EXPORTING = `format is not ${REPORT_FORMATS.JSON}`;

/** What an export is sent as, read off the controller's own table, and the query that selects it. */
const EXPORT_FILE = {
  types: Object.values(controller.EXPORTS).map((spec) => spec.mime),
  when: Object.keys(controller.EXPORTS).map((format) => `format=${format}`).join(' or '),
};

/**
 * `reports.export`, but only when something is actually being exported.
 *
 * Wraps the real permission middleware rather than reimplementing the check, so a change to how
 * permissions are resolved reaches this route like any other. Annotated as conditional, because the
 * wrapper — not the guard inside it — is what the route mounts, and the document must neither drop the
 * requirement nor state it for the on-screen read. See utils/routeMeta.js.
 */
const exportGuard = (() => {
  const guard = requirePermission('reports.export');
  return annotate(
    function requireExportPermission(req, res, next) {
      const format = req.query && req.query.format;
      if (!format || format === REPORT_FORMATS.JSON) return next();
      return guard(req, res, next);
    },
    { conditional: { when: WHEN_EXPORTING, permissions: ['reports.export'] } }
  );
})();

/*
 * Premium Reports unlocks exports — the owner's decision D9 in `docs/OWNER-DECISIONS.md`, settling
 * triage finding 64.
 *
 * §11.3 sells "Premium Reports" and §22 defines seven reports with no premium tier, so for a long time
 * the add-on resolved to a `feature_unlock` nothing checked: a school could pay for it and see no
 * change. D9 made it the exports — PDF and Excel here, and Print, which is the browser's
 * `window.print()` and so is gated on the screen. Every report stays readable on screen without it.
 *
 * The key is the feature the add-on unlocks, read from `ADDON_EFFECTS` rather than restated, so a plan
 * may also grant it directly as a plan feature. Only the six school reports: the Subscription Report
 * belongs to no single school, so there is no school's feature to check, and `requireFeature()` passes
 * a platform caller anyway.
 */
const PREMIUM_REPORTS_FEATURE = ADDON_EFFECTS[ADDONS.PREMIUM_REPORTS].target;

const schoolExportGuard = (() => {
  const premium = requireFeature(PREMIUM_REPORTS_FEATURE);
  return annotate(
    function requirePremiumForExport(req, res, next) {
      const format = req.query && req.query.format;
      if (!format || format === REPORT_FORMATS.JSON) return next();
      return premium(req, res, next);
    },
    { conditional: { when: WHEN_EXPORTING, features: [PREMIUM_REPORTS_FEATURE] } }
  );
})();

/** The six school-side reports differ only in their second permission, module and schema. */
const SCHOOL_REPORTS = [
  { path: '/students', type: REPORT_TYPES.STUDENT, permission: 'students.view', module: MODULES.STUDENTS, schema: schemas.students },
  { path: '/attendance', type: REPORT_TYPES.ATTENDANCE, permission: 'attendance.view', module: MODULES.ATTENDANCE, schema: schemas.attendance },
  { path: '/fees', type: REPORT_TYPES.FEE, permission: 'fees.view', module: MODULES.FEES, schema: schemas.fees },
  { path: '/expenses', type: REPORT_TYPES.EXPENSE, permission: 'finance.view', module: MODULES.FINANCE, schema: schemas.expenses },
  { path: '/exams', type: REPORT_TYPES.EXAM, permission: 'exams.view', module: MODULES.EXAMS, schema: schemas.exams },
  { path: '/teachers', type: REPORT_TYPES.TEACHER, permission: 'teachers.view', module: MODULES.TEACHERS, schema: schemas.teachers },
];

for (const report of SCHOOL_REPORTS) {
  router.get(
    report.path,
    requirePermission('reports.view'),
    requirePermission(report.permission),
    requireModule(MODULES.REPORTS, report.module),
    validate({ query: report.schema }),
    exportGuard,
    schoolExportGuard,
    logActivity({ action: 'export', entityType: 'reports', onlyOnSuccess: true }),
    respondsWithFile(asyncHandler(controller.handlerFor(report.type)), EXPORT_FILE)
  );
}

/*
 * The Subscription Report — the one that is not about a school, and the first consumer of
 * `reports.subscription.view`, which has been in the catalogue with no caller. No module gate: see the
 * header.
 */
router.get(
  '/subscriptions',
  requirePermission('reports.subscription.view'),
  validate({ query: schemas.subscriptions }),
  exportGuard,
  logActivity({ action: 'export', entityType: 'reports', onlyOnSuccess: true }),
  respondsWithFile(asyncHandler(controller.handlerFor(REPORT_TYPES.SUBSCRIPTION)), EXPORT_FILE)
);

module.exports = router;
