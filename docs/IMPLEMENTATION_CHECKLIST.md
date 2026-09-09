# Implementation Checklist — Multi-School Management System

Source of truth: `SRS_Multi-School-Management-System.docx` (36 sections, 1,698 extracted lines).
Every requirement below is traced to its SRS section / requirement ID.

**Status legend:** `Pending` · `In Progress` · `Implemented` · `Tested` · `Needs Fix` · `Completed`

---

## Read this before trusting a status

**The previous revision of this file was wrong.** Almost every row across all seven phases was
pre-filled `Completed` or `Tested`, including Phases 4–7 and most of Phase 3, none of which had been
started — 37 SRS requirement IDs were marked complete against modules that do not exist on disk. It
was written as a plan and read as a record. This revision replaces every status with one derived from
what is actually in the repository, checked file by file on **2026-08-26**; the 3.D rows were
re-derived on **2026-08-27** when the four §9 modules were built, the FR-AUTH rows again on
**2026-08-27** when the users and roles modules were verified, the 3.E / 3.F rows on
**2026-08-27** when the plan catalogue was built and verified, and FR-SUB-009 plus the
verification table on **2026-08-27** when the add-on module was verified. That last update was one
session late: the add-on module was written in a session that recorded nothing, so for one session this
file and `IMPLEMENTATION_PROGRESS.md` both understated what existed while overstating what passed.
See §5a of the progress log. The **3.G rows and the verification table were re-derived on
2026-08-28**, when the subscription lifecycle module was built and verified.

The six legend words are used with these specific meanings, so a row cannot be read generously:

| Status | Means |
|---|---|
| `Completed` | The code exists **and** an executable check covers it **and** that check passes today |
| `Tested` | Implemented and covered by a passing check, but not yet reachable in the running application — nothing mounts it |
| `Implemented` | The code exists; no executable check covers it |
| `In Progress` | Part of the requirement is done. The Notes column says which part, and which part is not |
| `Pending` | Not started |
| `Needs Fix` | Implemented, but a known defect makes it wrong |

"An executable check" means one of the thirty-eight `backend/scripts/verify-*.js` suites or
`scripts/check-models.js`. As of **2026-09-03 (session 22)** they total **4,613 assertions, 0 failures, 0 skips**,
every script exit 0, measured as one loop against live MariaDB:

| Script | Checks |
|---|---|
| `verify-addons.js` | 169 |
| `verify-ai.js` | 188 |
| `verify-app.js` | 205 |
| `verify-assignments.js` | 196 |
| `verify-attendance.js` | 82 |
| `verify-auth-chain.js` | 84 |
| `verify-auth-module.js` | 237 |
| `verify-billing.js` | 220 |
| `verify-deploy.js` | 52 |
| `verify-documents.js` | 133 |
| `verify-entitlement.js` | 272 |
| `verify-error-handler.js` | 54 |
| `verify-exams.js` | 219 |
| `verify-fees.js` | 174 |
| `verify-finance.js` | 163 |
| `verify-frontend.js` | 51 |
| `verify-homework.js` | 109 |
| `verify-jobs.js` | 57 |
| `verify-library.js` | 161 |
| `verify-middlewares.js` | 262 |
| `verify-notifications.js` | 100 |
| `verify-openapi.js` | 104 |
| `verify-parents.js` | 116 |
| `verify-pdf.js` | 20 |
| `verify-performance.js` | 16 |
| `verify-plans.js` | 175 |
| `verify-platform-modules.js` | 313 |
| `verify-reports.js` | 106 |
| `verify-school-setup.js` | 168 |
| `verify-security.js` | 28 |
| `verify-seed.js` | 22 |
| `verify-staff.js` | 89 |
| `verify-students.js` | 136 |
| `verify-subscriptions.js` | 208 |
| `verify-teachers.js` | 87 |
| `verify-timetable.js` | 115 |
| `verify-users-roles.js` | 236 |
| `verify-validate.js` | 35 |
| **Total** | **5,162** |

Regenerated from `backend/tests/baseline.json`, the manifest `npm test` checks each run
against. The previous table listed **30** suites totalling **4,613** — stale by 8 suites and
533 assertions, with individual rows out by as much as 23 (`verify-entitlement.js` read 249
against a measured 272). Nine further rows elsewhere in this file cited suite figures the
manifest contradicts; those are corrected too.

```bash
cd "E:/School Managment System/backend" && npm test
```

That runs **all 38** suites against `msms_test`, refusing to start unless `SELECT DATABASE()`
actually returns it, and checks each suite's assertion count against `tests/baseline.json`.
A jest-free equivalent, if you want the raw output:

```bash
cd "E:/School Managment System/backend" && for f in scripts/verify-*.js; do NODE_ENV=development DB_NAME=msms_test UPLOAD_DIR=storage/uploads-test node "$f" || break; done
```

`verify-app.js` reads **178**: `/api/v1` is **thirty-four** layers after the Phase 3.O `/timetable` mount.
It has moved on every mount — 118 → 123 → 127 → 129 → 131 → 133 → 143 → 151 → 154 → 157 → 160 → 163 →
166 → 169 → 172. Any row here that cites a figure should be re-measured after a mount, not carried
forward.

`verify-seed.js` is counted as **22**, not the 1 a `grep -c "^PASS"` reports: it prints a single
`PASS (22)` summary line followed by 22 `  + …` sub-bullets.

**Four suites mutate seeded rows** and restore them in a `finally`: `verify-users-roles.js` (two roles),
`verify-plans.js` (the `principal` role gains `plans.view`), `verify-addons.js` (the seven add-ons) and
`verify-subscriptions.js` (it raises `extra_students.units_per_quantity` from 1 to 50 and creates three
`addon_prices` rows).
`npm run db:seed` repairs a role and the SRS-fixed add-on columns, but **not** `units_per_quantity`,
`unit`, `is_active` or `display_order` — FR-SUB-009 makes those the operator's — so for those four the
script's own restore is the only thing that puts them back. `addon_prices` is not seeded at all, so
those three rows are the script's alone to remove.

**The jest suite exists and passes.** `npm test` runs all 38 `verify-*.js` suites through `tests/globalSetup.js` and reports them as named cases — see row 6.17. This paragraph previously read "There is no jest test suite. `tests/` does not exist and `npm test` fails", which was true when written and contradicted row 6.17 for the rest of session 26. Every `Tested` and
`Completed` status in this file rests on the standalone scripts above, which are run by hand.
Folding them into jest is Phase 6 work and is itself tracked as `Pending` below.

For narrative detail — what was built when, which defects were found, what the open issues are —
see [`../IMPLEMENTATION_PROGRESS.md`](../IMPLEMENTATION_PROGRESS.md). That file and this one are
meant to agree; where they disagree, the progress log is the one that gets corrected first.

---

## Phase 1 — Project & Requirement Analysis

| # | Requirement | Status | Notes |
|---|---|---|---|
| 1.1 | Read complete SRS (Sections 1–36) | Completed | Extracted to markdown, 72,799 chars / 1,698 lines, read end to end |
| 1.2 | Analyze existing project (folder contained only the SRS → greenfield build) | Completed | Nothing pre-existing to preserve |
| 1.3 | Extract functional / non-functional / UI / technical / DB requirements | Completed | Fixed vocabularies in `src/config/constants.js`; 109 permissions in `src/config/permissions.js` |
| 1.4 | Environment verification (Node 24.19.0, npm 11.17.0, MariaDB 10.4.32 via XAMPP) | Completed | |

### Ambiguities in the source, and the resolution applied

The SRS offers explicit either/or choices. One option was selected for each; nothing was invented.

| SRS text | Choice | Reason |
|---|---|---|
| "Sequelize ORM or Prisma ORM" (§3) | **Sequelize** | Listed first; `sequelize-cli`-style migrations satisfy Working Method step 2 ("Create database migration") |
| "React.js / Next.js" (§3) | **Next.js (App Router)** | A React.js framework — satisfies both names; SSR-capable responsive dashboard |
| "Bootstrap/Tailwind CSS" (§3) | **Tailwind CSS** | Utility-first, no CSS conflicts with a large custom dashboard |
| §11.2 lists 8 plan limits; §11.3 lists "SMS Credits" as an add-on | `sms_limit` is an **add-on-only** allowance, never a 9th plan limit | Avoids inventing a limit the source does not define. `ADDON_ONLY_LIMITS` / `USAGE_LIMIT_KEYS` in `constants.js` |
| §29 fixes the schema at 64 tables, but §3/§28 mandate migrations | `sequelize_meta` is tooling, not application data, and is excluded from the 64-table guard by name | Documented in `src/database/migrator.js` |

### Hard constraints extracted from the source

* §29 — "No tables beyond those listed above are introduced." → **exactly the 64 named tables, no more.**
  Consequences handled without new tables:
  * Refresh tokens, password reset, email verification, account status → columns on `users`.
  * Assignment submissions → self-referencing rows in `assignments` (`parent_assignment_id` + `student_id` + `record_type`).
* §30 Rule 1 — no hard-coded subscription logic; all plans/modules/limits/prices DB-driven.
* §30 Rule 2 — complete tenant isolation (School A must never read School B).
* §30 Rule 3 — API-first REST so Android / iOS / Mobile Web / third parties can attach later.
* §35 — gaps stay marked "Not Specified in Source Requirements"; no invented roles, modules, tables, tech, business rules, pricing rules, security policies, performance numbers, payment gateways, or notification channels.

---

## Phase 2 — Architecture & Planning

| # | Requirement | SRS | Status | Notes |
|---|---|---|---|---|
| 2.1 | Multi-tenant architecture, isolation at data + API layer | §4 | Completed | 4-layer defence; 84 checks in `verify-auth-chain.js` |
| 2.2 | Backend/frontend clearly separated | §3, §4 | Completed | `backend/` exists and runs; `frontend/` is Phase 4 |
| 2.3 | REST API architecture | §4, §30 R3 | Completed | `verify-app.js` drives it over real HTTP |
| 2.4 | API versioning under `/api/v1` | §4 | Completed | `config.app.apiPrefix`; asserted in `verify-app.js` |
| 2.5 | Organization → School → School Users hierarchy | §4 | Completed | Schema + `resolveTenant` scope derivation |
| 2.6 | JWT authentication layer | §4 | Completed | `utils/tokens.js` + `authenticate.js` |
| 2.7 | Authorization layer = role-based + permission-based | §4 | Completed | `authorize.js` + `permissionService.js`, DB-read per request |
| 2.8 | Tenant/school isolation via middleware | §4, §8 | Completed | `resolveTenant` + `enforceTenant` + `createRouter()` param guards |

Architecture record: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)

---

## Phase 3 — Database & Backend

### 3.A Database schema — §29 (64 tables, exactly as named)

| Group | Tables | Status | Notes |
|---|---|---|---|
| Core (8) | users, roles, permissions, role_permissions, organizations, schools, school_settings, academic_sessions | Completed | |
| Subscription (13) | subscription_plans, plan_prices, plan_modules, plan_features, plan_limits, subscriptions, subscription_items, subscription_history, subscription_overrides, addons, addon_prices, subscription_addons, usage_records | Completed | **Twelve of the thirteen now have an API writing them** — `src/modules/plans/` owns the first five, `src/modules/addons/` owns `addons` / `addon_prices`, and `src/modules/subscriptions/` owns the other five. The thirteenth, `usage_records`, is written by `usageService` behind `enforceLimit` and has no API of its own by design |
| Billing (9) | invoices, invoice_items, payments, payment_transactions, refunds, coupons, coupon_usages, taxes, quotations | Completed | Written by `src/modules/{taxes,coupons,invoices,payments,quotations}/` — 3.H, verified 216/216 |
| Academic (5) | classes, sections, subjects, class_subjects, teacher_subjects | Completed | Tables only (3.I) |
| People (5) | students, parents, parent_students, teachers, staff | Completed | `students` is read by `usageService.countHeadcount` |
| Attendance (2) | student_attendance, teacher_attendance | Completed | Tables only (3.K) |
| Finance (5) | fee_structures, student_fees, fee_payments, expenses, incomes | Completed | Tables only (3.L, 3.M) |
| Exams (8) | exams, exam_subjects, marks, grades, results, question_banks, questions, online_exams | Completed | Tables only (3.N, 3.P) |
| Other (9) | timetables, homework, assignments, books, library_transactions, documents, notifications, activity_logs, audit_logs | Completed | `activity_logs` / `audit_logs` are written by `activityLog.js` and read back by the suites |
| Tenancy | `school_id` on school-scoped tables; `organization_id` where required | Completed | `PLATFORM_TABLES` names the 15 non-school-scoped tables, each with a rationale |
| Migration | Versioned migration runner + initial schema | Completed | 3-pass migration; `check:models` 64/64, no extras, no duplicates |
| Seeders | 11 roles, 109 permissions, 353 role_permissions, 1 bootstrap Super Admin, 7 add-ons | Completed | 22 checks in `verify-seed.js`, incl. transactional rollback |

**The seeders row previously also claimed taxes and grades.** It should not have: §13's taxes and
§19's grade system are both *school-configured*, not SRS-fixed data, so seeding them would invent
requirements the source does not state (§35). Only SRS-fixed vocabularies are seeded. Sample data
belongs in `src/database/seeders/demo/`, which is optional and does not exist yet (3.S).

Schema totals from the models (`npm run db:schema`): 64 tables, 1,154 columns, 354 indexes, 254
foreign keys, 8 soft-delete tables, 323 associations. The live database independently reported
1,156 columns — a 2-column discrepancy that is recorded as **Known Issue #8** in the progress log
and has not been investigated.

### 3.B Authentication & Authorization — §7

Module: `src/modules/auth/` — `auth.routes.js`, `auth.controller.js`, `auth.service.js`,
`auth.validation.js`. Nine endpoints across two routers (five public, four authenticated), both
mounted in `buildApiRouter()`. Covered by `verify-auth-module.js` (237 checks) plus the middleware
half in `verify-auth-chain.js` (84). The administrative side of FR-AUTH-006/007/009 — editing an
account, suspending it, and setting what a role or an account may do — lives in `src/modules/users/`
and `src/modules/roles/`; see **3.D-2**.

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-AUTH-001 | User Login (JWT access + refresh) | Completed | `POST /auth/login`; lockout after `LOGIN_MAX_ATTEMPTS`; identifier is email **or** username |
| FR-AUTH-002 | User Logout (token invalidation) | Completed | `POST /auth/logout`; clears the stored refresh hash, the cookie and the CSRF token |
| FR-AUTH-003 | Access token & refresh token management | Completed | `POST /auth/refresh`; rotation on every use, and a replayed token ends the session |
| FR-AUTH-004 | Password hashing | Completed | bcrypt cost 12; `PASSWORD_MIN_LENGTH`, and a 72-byte ceiling because bcrypt truncates there |
| FR-AUTH-005 | Password reset | Completed | `forgot-password` (always 202, no address oracle) → `reset-password`; single-use hashed token |
| FR-AUTH-006 | Email verification | Completed | `POST /auth/verify-email` + `resend-verification`; POST not GET, so the token never enters an access log. Re-verified from the other side by `verify-users-roles.js`: changing a user's email through `PATCH /users/:id` clears `email_verified_at` and writes a fresh token hash and expiry |
| FR-AUTH-007 | Account status management | Completed | SRS text is "tracks and enforces account status on each authentication attempt" — `STATUS_REFUSALS` in `authenticate.js`, plus the login path. Now also exercised through the administrative side: `PATCH /users/:id` with `status: 'suspended'` refuses the target's **existing** access token with `ACCOUNT_SUSPENDED` and works again on reactivation, with no second write to clear the refresh hash |
| FR-AUTH-008 | Role middleware | Completed | `requireRole` / `requirePlatformScope`; 16 checks in `verify-auth-chain.js`, arguments validated at require-time. `GET /roles` and `GET /roles/:id` serve the client half — the eleven §5 roles with their grant counts |
| FR-AUTH-009 | Permission middleware | Completed | `requirePermission` / `requireAny` / `requireAll`, read from the database per request; `GET /auth/me` serves the client half. The data behind it is now settable at runtime: `PUT /roles/:id/permissions` (platform-only) and `PUT /users/:id/permissions` (per-account overrides), with `GET /users/permissions` as the 109-key catalogue. **Both invalidation properties verified with a 600-second TTL**, so a revocation is proven to bite before the cache could have expired |
| FR-AUTH-010 | Unauthorized school data access prevention | Completed | See FR-TENANT-003 — the same mechanism, proven in 8 request shapes |

Not an SRS requirement, recorded as an implementation decision: **`must_change_password`**. A Super
Admin types a Principal's initial password (§9.3), so somebody other than the account holder knows
it. `enforcePasswordChange` in `app.js` allows exactly two paths through until the flag clears.

### 3.C Multi-Tenant & School Isolation — §8

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-TENANT-001 | Organization & school data segregation | Completed | `school_id` / `organization_id` columns + `tenantWhere()` fail-closed |
| FR-TENANT-002 | Multi-tenant middleware enforcement | Completed | Mounted once in `buildApiRouter()`, so a module cannot forget it. Now demonstrated on real feature modules: an `organization_admin` calling the §9 routes is narrowed to its own organization and its own schools, and every refusal leaves an `access_denied` activity row attributed to the caller |
| FR-TENANT-003 | Cross-school access rejection (incl. altered URL `school_id`) → 403 | Completed | The SRS's named critical scenario, proven in **8** shapes: URL path, zero-padded, percent-encoded, unplaceable route param, nested router, three query spellings, array query, nested bulk body |
| FR-TENANT-004 | School settings & academic session scoping | Completed | Both halves are now done. The scoping half was already verified (both tables carry `school_id` and sit inside the boundary); the create/manage endpoints landed as 3.I — see FR-SCHOOL-001 and FR-SCHOOL-002. `verify-school-setup.js` asserts a principal of school B is refused school A's settings (`CROSS_TENANT_ACCESS_DENIED`) and reads none of its sessions |

### 3.D Super Admin Module — §9

**Complete and verified.** Four modules, eighteen endpoints, all mounted below the authentication
boundary in `buildApiRouter()`: `src/modules/platform/` (§9.1), `src/modules/organizations/` (§5, §33 —
the rows FR-SADMIN-002's precondition needs), `src/modules/schools/` (§9.2) and
`src/modules/principals/` (§9.3). Covered by `verify-platform-modules.js` — **313 checks**, the Joi
schemas directly, the four route tables by function identity, and the rest over real HTTP against the
real database.

Each route's permission key was pinned from the route's own 403 body rather than read off the source,
using a `super_admin` fixture with all eleven §9 keys in `denied_permissions` — `requirePermission` is
`asyncHandler`-wrapped and so is identifiable by neither name nor identity. The ten writes carry
`requirePlatformScope()`; the eight reads deliberately do not, because `organization_admin` holds all
five §9 read keys and none of the six write keys.

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-SADMIN-001 | Dashboard: 11 metrics (orgs, schools, active, suspended, students, teachers, active/expired subs, monthly/yearly revenue, pending payments) | Completed | `GET /platform/dashboard`, `platform.dashboard.view`. All eleven present in source order, verified individually; plus `archivedSchools`, `pendingPaymentsAmount` and `scope` — recorded as decisions in the progress log §2e, not as requirements. The three status counts are asserted to sum to `totalSchools`; periods are the current calendar month and year |
| FR-SADMIN-002 | Create school | Completed | `POST /schools`, `schools.manage`, platform-only, logged `create`. Awaits `tenantService.invalidateSchool` / `invalidateOrganization`; the organization must exist and be usable, which is the SRS precondition |
| FR-SADMIN-003 | Edit school | Completed | `PATCH /schools/:id`, `schools.manage`, platform-only, logged `update`. Same invalidation contract; an empty body is a 400, not a silent 200 |
| FR-SADMIN-004 | View school | Completed | `GET /schools` (paginated, filterable) and `GET /schools/:id`, `schools.view`. Reads are open to `organization_admin` and narrowed to its own organization by `enforceTenant` |
| FR-SADMIN-005 | Activate / suspend school | Completed | `POST /schools/:id/activate` and `/suspend`, `schools.status`, platform-only, logged `update`. **Proven with a live token:** suspending a school refuses the Principal's *existing* access token with `SCHOOL_SUSPENDED`, and a fresh sign-in is refused too — which only holds because `setStatus` awaits the tenant-cache invalidation. The Super Admin is exempt, so the state stays reversible; activating serves the Principal again |
| FR-SADMIN-006 | Delete / archive school | Completed | `POST /schools/:id/archive` (`schools.archive`) and `DELETE /schools/:id` (`schools.archive`, logged `delete`). The DELETE is a soft delete — findable only with `paranoid: false` — and deleting twice is a 404 rather than a second audit row. §29 gives `schools` no column for an archive reason, so it lands in `audit_logs.reason` |
| FR-SADMIN-007 | Assign / change principal | Completed | `PUT /schools/:id/principal`, `schools.assign_principal`, platform-only, logged `update`. The `schools.principal_id ↔ users.school_id` FK cycle resolves; reassignment returns the displaced holder as `previousPrincipal` |
| FR-SADMIN-008 | View school usage | Completed | `GET /schools/:id/usage`, `schools.usage.view`, no platform guard (a dashboard read that `organization_admin` may make). One row per `USAGE_LIMIT_KEYS` entry. `admin_limit` is verified to report the live headcount — 2 immediately after two Principals are created, with no `usage_records` row — and an unsubscribed school resolves every limit to `allowed: 0, unlimited: false` rather than to unlimited |
| FR-SADMIN-009 | Principal creation (Name, Email, Phone, Username, Password, School, Status) | Completed | `POST /principals`, `users.manage`, platform-only, logged `create`. Calls `authService.sendVerificationEmail`, and a send failure cannot fail the request — the account is already committed, so the response reports `verificationEmailSent: false` for the resend endpoint. `role_id`, `organization_id` and `must_change_password` are all derived, never accepted: the verification submits the *other* organization's id and asserts the school-derived one wins |

Recorded as decisions rather than as omissions, both in the progress log §2e:

* **No `PATCH`/`DELETE /principals/:id` and no organization DELETE.** The source describes neither.
  User editing belongs to the §33 Users module, which owns `users.manage` for every role rather than
  just Principals; `status: 'archived'` covers the organization case. **The editing half is now
  delivered — see 3.D-2.** Deleting a person is still absent everywhere, because nothing in the source
  deletes one.
* **`POST /principals` does not mount `enforceLimit('admin_limit')`.** §9's own order creates a school
  before it can hold a subscription, so an unsubscribed school resolves `admin_limit.allowed = 0` and
  the guard would refuse the first Principal of every new school. The figure is still reported by
  FR-SADMIN-008; only the refusal is absent. **Revisited when the Users module was built and still
  deferred:** `src/modules/users/` has no `POST`, so it creates nobody to count — enforcement belongs
  to whichever §15 module first creates a school administrator, by which point a school can hold a
  subscription.

### 3.D-2 Accounts & access — §33 "Users", §29 `roles` / `permissions` / `role_permissions`

*(Lettered `3.D-2` rather than given a new letter, because 3.E–3.S are already assigned to SRS
sections §10–§23 and renumbering them would break every reference to a row.)*

**Complete and verified.** Two modules, nine endpoints, both mounted below the authentication boundary
in `buildApiRouter()`: `src/modules/users/` (§33 "Users", plus the administrative side of FR-AUTH-006,
FR-AUTH-007 and FR-AUTH-009) and `src/modules/roles/` (§29's three tables, plus FR-AUTH-008/009's
data). Covered by `verify-users-roles.js` — **236 checks**: the Joi schemas directly (31), the route
tables by name and function identity (29), 162 over real HTTP, and 9 against `users.service.list()`
called directly.

**This is the thinnest requirement basis of any module group so far, and the code says so.** §33 lists
"Users" among the Super Admin MVP screens and says nothing further; there is **no `FR-USER-nnn`
anywhere in the source**, and §9's requirements stop at FR-SADMIN-009. §33 also lists **no** "Roles &
Permissions" screen — a grep of the source for `roles &`, `role management`, `manage roles`,
`role builder`, `assign role` and `custom role` returns nothing. The roles module therefore stands on
§29 giving role grants their own table plus FR-AUTH-009 requiring middleware that reads it. Seven
docblock passages across four files had cited a §33 roles screen that does not exist; all seven were
corrected to cite §29 and FR-AUTH-009.

| Endpoint | Permission | Platform-only | Status | Notes |
|---|---|---|---|---|
| `GET /users` | `users.view` | no | Completed | §33. Paginated; `?role=` by §5 slug, `?status=`, `?q=` across name/email/username. A widening `?school_id=` is refused by `enforceTenant` at the router layer with 403 `CROSS_TENANT_ACCESS_DENIED`, before the service runs — which is why 9 assertions call the service directly, to reach its own refusal too |
| `GET /users/permissions` | `users.manage` **or** `roles.view` | no | Completed | FR-AUTH-009's catalogue — 109 keys in 22 groups. Declared **before** `/:id` or the literal would be swallowed as an id. Reachable by a Principal, who holds `users.manage`: requiring `roles.view` alone would let them write an override while hiding the list of keys to choose from |
| `GET /users/:id` | `users.view` | no | Completed | Returns the account plus its effective permissions (role grants ∪ extras − denials). A cross-tenant id answers **404, not 403** — the scope makes the row invisible rather than forbidden, so the id is not an enumeration oracle |
| `PATCH /users/:id` | `users.manage` | no | Completed | §33 + FR-AUTH-006 + FR-AUTH-007, logged `update`. Six editable columns: name, email, username, phone, status, locale. `role_id`, `password`, `organization_id`, `school_id`, `avatar_path`, `must_change_password`, `email_verified_at` and the token columns are **stripped, not refused** — a body of only `role_id` answers "provide at least one field", which does not tell a caller which field to try next |
| `PUT /users/:id/permissions` | `users.manage` | no | Completed | FR-AUTH-009, logged `update`. Whole-set replacement of `extra_permissions` / `denied_permissions`; deny wins over grant. Needs **no cache invalidation** — the columns are read off the `users` row `authenticate` already loaded, and that is asserted with a 600-second TTL |
| `GET /roles` | `users.view` **or** `roles.view` | no | Completed | §29, FR-AUTH-008. The eleven §5 roles, unpaginated by design — the list has a known ceiling and `roles.slug` validates against it. `userCount` is tenant-scoped; `permissionCount` cannot be, because `role_permissions` has no `school_id` |
| `GET /roles/:id` | `users.view` **or** `roles.view` | no | Completed | The role plus its granted keys, read **through** `permissionService`'s cache so the screen shows the set the guard will actually enforce |
| `PATCH /roles/:id` | `roles.manage` | **yes** | Completed | §29, logged `update`. Labels only — `slug`, `is_platform_role`, `is_school_role` and `is_system` are structural facts about §5's eleven, not settings |
| `PUT /roles/:id/permissions` | `roles.manage` | **yes** | Completed | FR-AUTH-009, logged `update`. Whole-set replacement in one transaction, then `permissionService.invalidateRole`. **Verified to bite on the very next request against an unchanged token** with a 600-second TTL — a missed invalidation would have left a revoked permission working for ten minutes |

Every permission key above was pinned from the route's own 403 body, not read off the source.

**The guard split is why there are two modules.** No route in `users/` carries
`requirePlatformScope()`; both writes in `roles/` do. `role_permissions` has no `school_id`, so
revoking a key from the `teacher` role revokes it from every teacher in every school — a cross-tenant
write, which §30 Rule 2 forbids anyone below the platform from making. The per-user override columns
sit on a `users` row and *are* tenant-scoped, which is why a Principal may set them for their own
school's accounts. Role grants are platform policy; overrides are one account's exception.

Recorded as decisions rather than as omissions, all in the progress log §2f:

* **No `POST /users`, no `DELETE /users/:id`.** §9.3 creates a Principal and §15 creates school people;
  a generic create would be a second implementation of each. Nothing in the source deletes a person —
  `status` covers deactivation.
* **No `POST /roles`, no `DELETE /roles/:id`.** §5: *"The system defines **exactly** the following
  eleven roles."* §35 names "Additional roles" first among the things not to invent, and the model would
  refuse a twelfth slug anyway.
* **`super_admin`'s grant set is read-only** (403 `ROLE_NOT_EDITABLE`). The seeder hard-syncs it to the
  full catalogue on every run, so accepting the edit would report a change the next `db:seed` undoes —
  and it is the only role that can edit grants at all, so a revoked `roles.manage` would lock the
  platform out of its own recovery path.
* **Three safety properties the source does not describe**, each recorded as a decision, not as a
  requirement: you may not change your own account status, you may not edit your own overrides, and you
  may only *grant* permissions you hold yourself (403 `PERMISSION_GRANT_EXCEEDS_OWN`). The third is
  deliberately one-sided — **denying** a key you do not hold is allowed, because revocation cannot
  escalate anything. Without it, `users.manage` would be the highest privilege in the system: a
  Principal could write `subscriptions.manage` into a teacher's overrides and operate the platform
  through them.
* **`{phone: ''}` is a 422, not a clear.** `.empty('')` strips the key and `.min(1)` then refuses the
  emptied body; clearing a phone is `{phone: null}`. Consistent with `principals.validation.js`, judged
  defensible, and pinned by an assertion rather than changed.

### 3.E Subscription Management — §10

**Complete and verified.** Two modules, nineteen endpoints, both mounted below the authentication boundary
in `buildApiRouter()` at indices 13 and 14: `src/modules/plans/` — `plans.routes.js`,
`plans.controller.js`,
`plans.service.js`, `plans.validation.js` — and `src/modules/addons/`, the same four files. Covered by
`verify-plans.js` — **175 checks**: the eleven Joi
schemas directly (41), the route table by name (9), the service called directly (7), and 118 over real
HTTP against the real database — and by `verify-addons.js`, **169 checks**; see FR-SUB-009 in 3.F for what
the add-on half does and deliberately does not do.

Twelve of the thirteen §29 subscription tables now have an API writing them — `subscription_plans`,
`plan_prices`, `plan_modules`, `plan_features`, `plan_limits`, `addons` and `addon_prices` from this
phase, and `subscriptions`, `subscription_items`, `subscription_history`, `subscription_overrides` and
`subscription_addons` from 3.G. The thirteenth, `usage_records`, is written by `usageService` behind
`enforceLimit` rather than by a request, which is deliberate — a usage row is a side effect of a
guarded write, not something a client posts.

Every write carries `requirePlatformScope()` on top of its `plans.*` / `addons.*` permission, because
neither table has a `school_id` and one edit to a plan's limits changes what every school on
that plan may do. No read does: reads are confined instead by each module's `scopeFor()`, which shows a
non-platform caller only the active, public plans — and only the active add-ons, since an add-on
withdrawn from sale is not an offer. So
granting `plans.view` to a Principal for §12.3
later is a seed change, not a routing change. Each of the five plan keys was pinned from its own 403 body.

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-SUB-001 | Create plan (Name, Code, Description, Status, Public/Private, Recommended, Display Order) | Completed | `POST /plans`, `plans.manage`, platform-only, logged `create`. Table is `subscription_plans`, not `plans`. **Six** of the seven source fields are accepted; the seventh, Status, is stripped rather than accepted — this row used to say "all seven", which its own next sentence contradicts; `code` is upper-cased and a repeat is 409 `PLAN_CODE_TAKEN`. **A new plan is born `inactive` whatever the body says** — the column defaults to `active`, so the service overrides it and `status` is *stripped* rather than refused. A plan created active would appear in the catalogue holding no price and no limits |
| FR-SUB-002 | Edit plan | Completed | `PATCH /plans/:id`, `plans.manage`, platform-only, logged `update`; `GET /plans` (paginated, filterable) and `GET /plans/:id` for the read half, `plans.view`. An empty body is a 422 naming the requirement, not a silent 200. Every write awaits `entitlementService.invalidatePlan` — asserted with a 600-second TTL, including for a plain rename, since the snapshot caches the plan's `name` |
| FR-SUB-003 | Duplicate plan | Completed | `POST /plans/:id/duplicate`, `plans.manage`, platform-only, logged `create`. One transaction copying all four child collections — prices, modules, features, limits — recording lineage in `duplicated_from_id` and in `audit_logs.reason`. The copy is born `inactive`. A taken code rolls the whole transaction back, verified by re-counting the plans afterwards |
| FR-SUB-004 | Activate / deactivate plan | Completed | `POST /plans/:id/activate` and `/deactivate`, `plans.manage`, platform-only, logged `update`. **Activation requires an active price** — 409 `PLAN_NOT_PRICEABLE`, whose message cites FR-SUB-006 — because a subscription denormalises its billing terms from a `plan_prices` row, so an active plan with nothing to sell is an offer the system cannot fulfil. Deactivation carries no such condition and does not disturb schools already subscribed, which is asserted |
| FR-SUB-005 | Archive plan | Completed | `POST /plans/:id/archive`, `plans.manage`, platform-only, logged `update`. Stamps `archived_at`; reactivating clears it. §29 gives `subscription_plans` no column for an archive reason, so it lands in `audit_logs.reason` — the same treatment FR-SADMIN-006 gets. **Retention, not removal:** a school already on the plan keeps its resolved entitlement across the archive, asserted at 900 students. There is deliberately **no `DELETE /plans/:id`** — FR-SUB-005 is the source's removal operation and `subscriptions.plan_id` is `RESTRICT` besides |
| FR-SUB-006 | Configure pricing & billing cycle — 7 cycles × 5 pricing models | Completed | `PUT /plans/:id/prices`, `plans.pricing.manage`, platform-only, logged `update`. Whole-set replacement; both vocabularies come from `constants.js`, and the cross-field rules are enforced per model (fixed needs `base_amount`, student_based needs `unit_amount` and accepts multiple tier bands, custom needs `custom_amount`, `custom_days` needs `cycle_days`). Inverted tiers, a repeated `(cycle, days, model, tier_min, tier_max)` tuple and a second `is_default` are all refused. **A price row a subscription points at is retired, not deleted** — `is_active: false, is_default: false` — because `subscriptions.plan_price_id`, `subscriptions.scheduled_plan_price_id` and `quotations.plan_price_id` are all `SET NULL`, so a delete would silently blank a live pointer instead of failing. The count retired is reported in the body and the message |
| §10.3 / §10.4 / §11 | Catalogue of the fixed vocabularies | Completed | `GET /plans/catalogue`, `plans.view` — the 7 cycles, 5 pricing models, 20 modules and 8 limit keys projected from `config/constants.js` so a client never hard-codes them (§30 Rule 1). Declared **before** `GET /:id` or Express would match the literal as an id, and that ordering is asserted |

Recorded as decisions rather than as omissions, all in the progress log §2g:

* **The four configuration routes are `PUT`, not `POST`.** The body is the plan's complete set for that
  table, so sending it twice leaves the same state.
* **`PUT /:id/limits` demands all eight §11.2 keys** and names the missing one, because
  `entitlementService`'s `emptyLimits()` resolves an absent `plan_limits` row to **0** rather than to
  "unchanged" — a partial set would silently zero whatever it omitted. Modules and features are the
  opposite: an absent row means "not in this plan", so partial sets are accepted there.
* **`readiness` is derived per response, never stored.** Price counts, the default-price flag, the
  enabled-module count and `unconfiguredLimits` are computed on read. A stored "is this plan ready"
  column would be a second source of truth that could disagree with the rows.
* **A filter cannot widen a scope.** `?status=archived` from a school-scoped caller returns an empty
  page, not the archived plans. Asserted over HTTP and directly against the service.
* **A private plan answers 404, not 403,** to a school-scoped caller — the scope is folded into the
  `where`, so the row is invisible rather than forbidden and the id is not an enumeration oracle.

### 3.F Modules, Features, Limits & Add-ons — §11

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-SUB-007 | Assign 20 modules / features / 8 limits (Fixed or Unlimited) to a plan | Completed | Both halves are now done. **Resolution:** `entitlementService` resolves the full §11/§12 precedence chain (plan → add-on → override) with a cached per-school snapshot, 249 checks across 9 deliberately dissimilar schools. **Assignment:** `PUT /plans/:id/modules` and `/features` (`plans.modules.manage`) and `PUT /plans/:id/limits` (`plans.limits.manage`), all platform-only and logged `update`, write `plan_modules` / `plan_features` / `plan_limits` as whole sets in one transaction each. `unlimited: true` with a `value` is refused, `allow_overage` without a rate is refused (a rate of `0` is accepted), and `unit` is derived rather than taken from the caller. Verified end to end that a limit raised from 500 to 900 reaches a subscribed school's snapshot on the next request, and that a module dropped from the set resolves to `false` rather than to "unchanged" |
| FR-SUB-008 | Enforce plan limits against actual usage | Tested | `enforceLimit`, `usageService` and all four measurement kinds are implemented and verified, including overage pricing and headcount-from-source-table. **No longer pending a caller: session 16 mounted the first one.** `src/modules/teachers/` carries `requireModule(MODULES.TEACHERS)` router-level and `enforceLimit(LIMITS.TEACHER_LIMIT)` on `POST /`, asserted over HTTP in `verify-teachers.js` — a plan without the module is `MODULE_NOT_SUBSCRIBED`, no subscription at all is `SUBSCRIPTION_INACTIVE` (402), and the third teacher against a limit of 2 is `PLAN_LIMIT_EXCEEDED`. One correction that matters when the next module copies it: for a **headcount** limit the guard counts *live* from the source table and never reads `usage_records`, so `syncHeadcount` maintains a reporting mirror rather than the enforcement path. Every module built so far governs the platform rather than consuming a school's allowances: the four §9 modules and the two catalogue modules are platform-scoped, `src/modules/subscriptions/` sells the allowances rather than spending them, and `POST /principals` deliberately omits it (see 3.D). `verify-entitlement.js` mounts it on its own app, 55 assertions over real HTTP. **The two preconditions are now both met** — there is a priced catalogue to resolve from (3.E) and a subscription created through an API to resolve it for (3.G), so `GET /schools/:id/usage` reports real ceilings. What remains is a consuming route, which arrives with the first §15 module that creates a school person **Qualified in the §36 final pass — the machinery is verified, the coverage is not complete.** FR-SUB-008 requires the system to track usage against **each** configured limit and block actions exceeding a Fixed one. Counted precisely: `enforceLimit` guards five route families (`STUDENT`, `TEACHER`, `STAFF`, `STORAGE`, `AI`) and `file_upload_limit` is enforced separately in `middlewares/upload.js` — six of the eight. **`admin_limit` is counted but never blocks**: `usageService.js:125` defines its headcount over `SCHOOL_ADMIN_ROLES`, and no route calls `enforceLimit` for it. **`api_limit` is neither counted nor blocked** — it appears only in a prose comment (`usageService.js:30`), has no counter among the four defined at `:105-125`, and no enforcement anywhere. **Not fixed here:** §11.2 names "API Limit" and never says what it measures — requests over what window — so implementing it means inventing the unit; and `admin_limit`’s only creation path is `principals.service.js`, which a **platform** caller drives, and `enforceLimit` deliberately skips platform callers (`entitlement.js:409`), so enforcing it there requires deciding whether a Super Admin acting for a school consumes that school’s limit — a question the SRS does not answer. |
| FR-SUB-009 | Manage 7 add-ons | Completed | `src/modules/addons/` — 958 lines, six endpoints, verified by `scripts/verify-addons.js` → **169 / 169, exit 0**. `GET /addons` and `GET /addons/:id` need `addons.view`; `PATCH /:id`, `PUT /:id/prices`, `POST /:id/activate` and `POST /:id/deactivate` need `addons.manage` **and** `requirePlatformScope()`. There is deliberately **no POST and no DELETE**: SRS §11.3 fixes the seven, `addons.key` is unique and `isIn`-validated, and `subscription_addons.addon_id` is `RESTRICT`. `key`, `name`, `effect_type`, `effect_target`, `unit` and `is_active` are explicitly `forbidden()` rather than stripped, each with a message naming where the value comes from — the first four because the seeder repairs them on every run (so a 200 here would be silently reverted by the next `npm run db:seed`), `unit` because it is derived from `LIMIT_UNITS[effect_target]`, and `is_active` because the two activation routes record a reason. So the editable set is `description`, `units_per_quantity` (min 1 — a block size of 0 would grant nothing) and `display_order`. `PUT /:id/prices` replaces the whole price set and **retires rather than deletes** a price a purchase points at, because `subscription_addons.addon_price_id` is `ON DELETE SET NULL` and a delete would silently blank a live pointer. Unlike a plan, activation carries **no price precondition** — that column is nullable, so a comped add-on with no price is a shape the schema allows; `readiness()` reports `purchasable` instead. **This module deliberately invalidates no cache**, and the service header says so in case the absence reads as an oversight: `entitlementService.resolveSchool()` reads add-ons from `subscription_addons` and never joins `addons`, so a catalogue edit changes what the *next* purchase grants and cannot stale an existing one. **Mutates seeded rows** — it edits the seven add-ons and restores them in its `finally`; the four fields the seeder does not repair are the script's own responsibility. Confirmed afterwards: `addons` back at 7, `addon_prices` 0. **The purchase half now exists too** (3.G): `POST /subscriptions/:id/addons` and `POST /subscriptions/:id/addons/:addonId/cancel`, `subscriptions.manage` **or** `subscriptions.self.manage` because FR-SUB-009's **Description** is *"Super Admin and/or school configure add-ons"* (SRS:521). §11.3 has no actor line at all, and FR-SUB-009's own Actor / Role line one line below the Description reads *"Super Admin"* (SRS:522) — triage finding 53. The purchase copies `effect_type`, `effect_target` and `units_granted = quantity × units_per_quantity` onto the `subscription_addons` row, and `verify-subscriptions.js` asserts the copied values — the block size is raised to 50 first, so a row that quietly stored the quantity would fail. A price belonging to another plan is refused with `ADDON_PRICE_PLAN_MISMATCH`, which is what downgraded Known Issue #17 to a display-only imprecision. A purchase naming **no** `addon_price_id` is recorded at zero with a null price pointer — Known Issue #18, deliberate and asserted, with the billing decision left to §13 |

**§30 Rule 1 is verified structurally, not asserted.** The entitlement fixtures use two plans that
differ only in their rows, and every expected value is derived from a row. Two schools on the *same*
plan answer differently, which a plan-name comparison anywhere in the chain would make impossible.
`requireModule` receives a module key and gets back a boolean — there is no API by which a guard
*could* write `if plan == 'premium'`. The plans module is held to the same standard from the other
side: `GET /plans/catalogue` projects the four fixed vocabularies out of `config/constants.js` so a
client cannot hard-code them either, and `PUT /:id/limits` accepts only the eight `LIMIT_LIST` keys.

### 3.G Subscription Lifecycle — §12

**Complete and verified.** One module, nineteen endpoints, mounted below the authentication boundary in
`buildApiRouter()` at index 15: `src/modules/subscriptions/` — `subscriptions.routes.js` (304 lines),
`subscriptions.controller.js` (482), `subscriptions.service.js` (2,608) and
`subscriptions.validation.js` (596), 3,990 lines in all, the largest module in the project. Covered by
`scripts/verify-subscriptions.js` — **208 checks, 0 failures, exit 0**: the sixteen Joi schemas
directly, the route table by name and function identity, `runLifecycleSweep()` called directly against
hand-built fixtures, and the rest over real HTTP against the real database.

**The catalogue can now be sold from.** `POST /subscriptions { school_id, plan_id }` — those two fields
are the whole minimum body — creates the subscription in `pending`, `POST /:id/activate` starts the
billing period, and from that moment `GET /schools/:id/usage` reports real ceilings instead of
`allowed: 0` for every limit. Every write runs in one transaction that also writes a
`subscription_history` row, refreshes `schools.subscription_state`, and invalidates **both** the
entitlement snapshot and the tenant cache.

Three guard shapes, each derived from the SRS actor line for the requirement rather than applied
uniformly: `requirePlatformScope()` + a permission where the actor is the Super Admin alone
(FR-SUB-010/011/012 and §33's overrides), `requireAnyPermission(lifecycle, self.manage)` where the
actor line names both Super Admin and School (FR-SUB-013/014/015 and §11.3's purchase), and a
permission alone for the reads. Exactly the six `subscriptions.*` keys already in
`config/permissions.js` are used; a seventh would have been an invented permission (§35).

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-SUB-010 | 10 lifecycle states + transitions | Completed | `POST /` plus the six administrative transitions — `/activate`, `/suspend`, `/reactivate`, `/pause`, `/resume`, `/cancel` — each `requirePlatformScope()` + `subscriptions.lifecycle`, each logged. The edges are a **frozen `TRANSITIONS` data table** (`subscriptions.service.js:917`), not six hand-written guards, so an illegal edge is refused by data rather than by an omission; the reads are `GET /`, `GET /:id`, `GET /:id/history` and `GET /catalogue`. The date-driven half is `runLifecycleSweep()` — **five passes in a fixed order**: trial ended → automatic renewal → period ended without renewal → grace ended → expiring notice (`subscriptions.service.js:2268`). It is exported and asserted by direct call and has **no route**, because its actor is the *system*; the cron trigger now exists — `src/jobs/tasks/subscriptionLifecycle.js`, scheduled by `src/jobs/cron.js`. This clause read "the cron trigger is Phase 5.9 and `src/jobs/` does not exist", which stopped being true when the scheduler shipped. There is deliberately no `DELETE /:id` — §12's terminal states keep the row |
| FR-SUB-011 | Trial config (3/7/14/30/custom days) | Completed | `PATCH /:id`, platform-only + `subscriptions.manage`. One PATCH serves this and FR-SUB-012 because they are two columns on one row set from one screen; splitting them would let an operator adjusting both half-fail. The sweep's first pass ends a lapsed trial, verified against a fixture with a back-dated `trial_ends_at` |
| FR-SUB-012 | Grace period config (1/3/7/15/custom days) | Completed | Same `PATCH /:id`. The sweep's fourth pass expires a subscription whose grace period has run out; `assertSubscriptionUsable` already treated `grace_period` as usable, and now something puts a subscription into it and takes it out |
| FR-SUB-013 | Upgrade with proration + remaining credit + new price | Completed | `POST /:id/upgrade`, `subscriptions.lifecycle` **or** `subscriptions.self.manage` — §12.3's actor is *"Super Admin / School"*, so a school's own Principal may upgrade. §12.3's arithmetic runs through `utils/money` and `utils/dates`, and `proration_amount`, `credit_applied` and `amount_due` are stored on the `subscription_history` row in `money`-rounded form. The suite uses `custom_days`/30 throughout rather than `monthly`, because a monthly cycle is 28–31 days and every expectation would have to be re-derived from the function under test |
| FR-SUB-014 | Downgrade (immediate or next billing cycle) | Completed | `POST /:id/downgrade`, same guard. **The only one of the three with a required body field:** §12.4 offers Immediate and Next Billing Cycle, and an immediate downgrade can drop a limit below what the school is already using, so the choice is not defaulted. A deferred downgrade writes `scheduled_plan_id` / `scheduled_plan_price_id` / `scheduled_change_at` — the three columns 3.E left for this module |
| FR-SUB-015 | Renewal (manual + automatic) | Completed | Manual: `POST /:id/renew`, same guard, §12.5. Automatic: the sweep's second pass, which renews a subscription whose period has ended when `renewal_mode` allows it and increments `renewal_count`. Both verified. **The scheduler that calls the sweep now exists** — `subscription-lifecycle` in `src/jobs/cron.js`, and this clause said it was outstanding; exposing it over HTTP to make it reachable sooner would have invented an endpoint the SRS does not describe |
| §33 | Feature overrides, custom limits, custom pricing | Completed | `POST /:id/overrides` and `POST /:id/overrides/:overrideId/revoke`, `requirePlatformScope()` + **`subscriptions.overrides.manage`** — its own key, seeded to `super_admin` alone, because an override is the highest-precedence source in the entitlement chain and a school able to write one could grant itself any module, feature or limit. The entitlement resolver's deliberate skipping of `price` overrides is unchanged and still asserted in `verify-entitlement.js` |
| §11.3 | Add-ons on a subscription | Completed | `POST /:id/addons` and `POST /:id/addons/:addonId/cancel` — see FR-SUB-009 in 3.F. `:addonId` is a `subscription_addons.id`, not an `addons.id`, because a school may hold two purchases of the same add-on and cancelling one must not cancel both. POST rather than DELETE: the row becomes `status = 'cancelled'`, since §13's invoice line will have been raised against it |

Recorded as decisions rather than as omissions, all in the progress log §2i:

* **Cancel is platform-only while upgrade is not.** It reads as inconsistent and it is deliberate:
  FR-SUB-013/014/015 name the School as an actor, FR-SUB-010 — where Cancel sits alongside Activate,
  Suspend, Reactivate, Pause and Resume — does not; its actor line is *"System / Super Admin"*. A school
  cancelling its own subscription is a plausible product decision and not this document's.
* **Activation is administrative, not paid.** `POST /:id/activate` starts the billing period on a Super
  Admin's say-so because §13 does not exist yet. When it does, that becomes one of two ways in and this
  route stays — an operator activating against a bank transfer they have seen is a real §13.2 case.
* **`GET /catalogue` is declared before `GET /:id`,** and the ordering is asserted: both are
  one-segment GETs, so the reverse order would match `/catalogue` against `/:id` and fail validation as
  a non-numeric id. It is the only ordering hazard in the file.
* **Twenty-seven derived columns are `forbidden()`, not stripped,** each with a message naming where the
  value comes from — every date, counter, balance and state column a transition owns. `plan_id` and
  `plan_price_id` are refused on `PATCH /:id` separately, because changing a plan is what
  `/upgrade` and `/downgrade` are for and a silent PATCH would skip §12.3's proration entirely.
* **A cross-tenant id 404s rather than 403s.** `findById()` folds `tenantWhere()` into its `where`, so a
  `school_admin` calling `POST /subscriptions/99/upgrade` for another school's subscription cannot tell
  the subscription exists.

### 3.H Invoice, Payment & Coupon — §13

**Complete and verified.** Five modules (`taxes/`, `coupons/`, `invoices/`, `payments/`, `quotations/`),
mounted below the tenant boundary, covered by `scripts/verify-billing.js` → **239 / 239, exit 0**,
including Part 5 over real HTTP: issue (subtotal 1000, exclusive 10% tax → 1100) → school applies a 10%
coupon (discount-then-tax → 990) → school submits a pending bank transfer → Super Admin approves
(invoice `paid`, `amount_due` 0) → full refund (invoice `refunded`). A principal is refused
`POST /invoices/generate` and `POST /payments/record` with `PLATFORM_SCOPE_REQUIRED`.

Two leftovers, neither a missing table: **Known Issue #18** (an unpriced add-on bills as a zero line)
and **Known Issue #19** (`wallet` is an accepted method; `wallet_balance` is never debited).

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-BILL-001 | Invoice generation (11 fields) | Implemented | `POST /invoices/generate`, platform + `invoices.manage`. Totals are computed (`computeTotals`: discount then tax); the eleven money/status fields are refused at validation. Period collision is `INVOICE_PERIOD_ALREADY_BILLED`. **Scoped in session 26: the missing System actor is BLOCKED, and this row understates the rest.** *"A billing event"* — FR-BILL-001's own precondition — appears **exactly once** in the 1,698-line source and is never defined or enumerated. Building the automatic trigger would mean deciding at least four things the SRS does not state: which events count, when in the period to issue, what `due_date` to set (and `issue()` refuses when given neither a `dueDate` nor a numeric `dueDays`), and what to do for a subscription in grace or past due. §35 forbids deciding them, so this is `real-blocked` in the same sense as the thirteen in `docs/SRS-TRIAGE-VERDICTS.md` rather than work nobody has done. **The other half is better than recorded:** all eleven §13.1 fields really are written, Add-ons included. Six were asserted by no suite at all; **five of those six are now covered** — Invoice Number, School, Plan, Billing Period and Due Date, **+17 assertions** in `verify-billing.js` (220 → 237), every expected value derived from the fixture rather than typed, and **12/12 deliberate regressions detected**. Two of those regressions were the wrong shape and both were rebuilt: one could not fail at all, because the fixture activated and billed within the same second so the period start and a fresh clock read were indistinguishable — the fixture now back-dates the period by five whole days; the other failed only by **crashing**, since booking the invoice to the organization id violates the foreign key and the request 409s before the assertion runs, so it is broken in the response instead. `plan_name` is asserted as a **snapshot** by renaming the plan after issue and requiring the joined plan to move while the column does not. **Add-ons is now covered too, so all eleven fields are asserted** (+2, 220 → 239 overall). Its first design was refused rather than corrected: `addonsSummaryFrom()` returns `null` when no line is an add-on and the column is nullable, so a check against `null` passes whether or not the column is ever written. Instead the fixture buys a real add-on — `extra_students` at 25 a unit × 2 = 50, every figure that arithmetic rather than a literal — and bills it on a **second** invoice for a period the first does not cover, so the 1000/100/1100/990 figures never move. The summary is asserted to **agree** with the `invoice_items` addon line and to trace back to the purchase through `subscription_item_id`, which is what the column is for. The vacuity test — deleting the `addons_summary` write, the exact regression that left the refused design green — now fails by name; 5/5 detected. **Downgraded from Completed in the §36 final pass: the fields are right and the trigger is absent.** FR-BILL-001’s Actor is **System** and its precondition is *"Subscription exists and a billing event occurs"*, but `generateForSubscription()` is reachable **only** from `invoices.controller.js:69` — an authenticated platform operator over HTTP. No scheduler task raises an invoice: `src/jobs/cron.js` runs coupon-expiry, database-backup, **invoice-overdue**, notification-dispatch and subscription-lifecycle, and none of them generates. So an invoice exists only because a human asked for one. **Not implemented here deliberately:** the SRS never defines what "a billing event" is — which subscriptions, at what moment, with which lines — and choosing would be inventing a business rule §35 forbids. It needs a specification before it needs code. **Separately fixed in the same pass:** the due-date fallback in `issue()` read `GRACE_PERIOD_DAYS`, which is §12.2’s preset **list** `[1,3,7,15]`, not a day count — the arithmetic yielded `Invalid Date` and `toDateOnly()` silently substituted **today**, so any caller omitting `dueDays` raised an invoice already due. Unreachable today (the sole caller always passes `subscription.grace_period_days`, `allowNull: false, default 0`); `issue()` now refuses rather than guessing. **No suite covers invoice `due_date` at all**, which is why it survived. |
| FR-BILL-002 | 5 payment methods; plugin-based gateway architecture | Completed | All five methods are accepted on `POST /payments/record`. `paymentGatewayService` is a plugin registry that **ships zero adapters** — `get()` refuses `PAYMENT_GATEWAY_NOT_CONFIGURED`. Live adapters are Phase 5.1. Wallet as a *method* is done; debiting `wallet_balance` is Known Issue #19 |
| FR-BILL-003 | Manual payment submission (txn id + screenshot → Pending) | Completed | `POST /payments` (multipart, field `screenshot`), `payments.submit`, no platform scope. File is optional; status is always `pending` and settles nothing |
| FR-BILL-004 | Manual payment approve / reject | Completed | `POST /payments/:id/approve` and `/reject`, platform + `payments.approve`. Approve writes `audit_logs.event = update` (the column has no `approve` value). Paid invoice can activate a pending subscription via `transition()` |
| FR-BILL-005 | Coupons (%/fixed, expiry, max uses, plan + school restrictions) | Completed | Management is platform-only; `POST /coupons/validate` and `POST /invoices/:id/coupon` are school-reachable (`coupons.redeem`). `expireLapsed()` is the Phase-5 cron, asserted by direct call |
| §33 (§29 for quotations) | Refunds, taxes, quotations, overage, custom pricing, custom limits, feature overrides | Completed | **Write APIs now exist** for refunds (`POST /payments/:id/refunds`), taxes and quotations. Overage / custom limits / feature overrides remain 3.G. Custom pricing override is still skipped by the entitlement resolver on purpose. **Quotations are not a §33 item.** `grep -i quotation docs/SRS-extracted.md` returns exactly one line in 1,698 — the bare table name `quotations` at :1445, inside §29’s Billing group — and §33’s SaaS Engine list (:1617-1637) is 21 named items with no Quotations among them. The module’s own files cited "§33 *Quotations*" in five places and now cite the §29 table alone, in the same form `roles.validation.js:12` already uses for the Roles screen. Whether a bare table name warrants a five-state lifecycle with automatic invoice issuance is a §35 "Additional workflows" question the SRS does not answer; correcting the citation does not settle it |
| §13.2 | Wallet | In Progress | Method enum and `refunds.destination = wallet` are wired. `subscriptions.wallet_balance` is never debited (Known Issue #19) |

### 3.I School Setup & Academic — §14

**Complete and tested.** Four modules — `settings/`, `sessions/`, `classes/`, `subjects/` — plus
`src/utils/schoolScope.js`. **Twenty-nine endpoints, all twenty-nine exercised over real HTTP** by
`scripts/verify-school-setup.js` → **168 / 168, exit 0**. No new table: all seven tables the group
writes were already in the §29 sixty-four.

*Provenance, because "Tested" here does not mean what it means in the other sections:* the module code
arrived unrecorded (file mtimes 16:21–16:27 on 2026-09-02, after the session-15 log entry at 16:16;
whether that was session 15 continuing or a separate session is not knowable without git history).
**Session 16 audited it, found five defects in it, fixed them, and wrote 46 of the 157 assertions.** The
statuses below rest on session 16's verification, not on the state the code was found in. See
`IMPLEMENTATION_PROGRESS.md` §2j and §5a defects 16–20.

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-SCHOOL-001 | School settings (Logo, Name, Address, Phone, Email, Website, Favicon, Theme, Currency, Timezone) | Tested | All ten §14.1 fields are `school_settings` columns and all ten are accepted by `PATCH /school-settings`. `GET` find-or-**virtuals** and deliberately does not insert (asserted: the table is still empty after a GET); the first `PATCH` inserts, the second updates — both branches now exercised. `schools.name` is asserted not to be overwritten by `school_settings.name` |
| FR-SCHOOL-002 | Academic session create / activate / close | Tested | Seven endpoints. Create is always `upcoming`; activate flips `is_current` for the school inside a transaction and does **not** auto-close siblings; close stamps `closed` and clears current. **No DELETE** — close is the operation §14.2 names, and its absence is asserted. A closed session refuses edit and re-activation (`SESSION_CLOSED`). The `active → closed` transition is asserted in the audit row's `old_values`/`new_values` |
| FR-SCHOOL-003 | Classes, sections, class teachers, subjects | Tested | Nine endpoints. Unique per `(school_id, academic_session_id, name)`; classes may be created against an *upcoming* session; class teachers resolved through `loadTeacherInSchool()` and refused across schools. DELETE refuses on two grounds — enrolled students (`CLASS_HAS_STUDENTS`, FK is SET NULL) and cascade dependants (`CLASS_IN_USE` / `SECTION_IN_USE`, 8 and 6 tables), the latter added in session 16 after the cascade was found removing rows below the application |
| FR-SCHOOL-004 | Subject creation + class assignment + teacher assignment | Tested | Eleven endpoints. Assignment de-duplication uses a locking read inside a transaction, because `class_subjects_unique` and `teacher_subjects_unique` both contain nullable columns and **MySQL treats NULL as distinct in a UNIQUE index** — the index cannot enforce a whole-class assignment. Naming `teacher_id` on a class-subject upserts the matching `teacher_subjects` row. `DELETE /subjects/:id` is not a §14.4 behaviour but was already shipped; it is now guarded with `SUBJECT_IN_USE` rather than cascading into `exam_subjects` and, through it, `marks` |

**Not gated by entitlement, deliberately.** SRS §11.2's eight plan limits contain no class, section,
subject or session limit, and `MODULES` has no school-setup module — so the absence of `enforceLimit`
and `requireModule` on this group is correct, not an omission. Inventing a `class_limit` would be a
ninth plan limit the source does not define.

### 3.J Student, Parent, Teacher & Staff — §15

**Complete.** All four §15 modules are implemented and tested; SRS §15 is closed. Tables exist. `students` is already read by
`usageService.countHeadcount`, and a departed student is verified not to count against an enrolment
limit.

**This phase is where entitlement stopped being theoretical.** `src/modules/teachers/` is the first
route in the project to mount `requireModule()` and the first to call `enforceLimit()` — see the
FR-SUB-008 row, which recorded the gap from session 4 until now. The `teachers.*`, `students.*`,
`parents.*` and `staff.*` permission keys all carry a `module` binding, but that field is **metadata**
and nothing in the request path reads it, so every module in this phase must mount its own guard.

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-STUDENT-001 | Admission, profile, photo, documents, class/section, student ID, roll number | **Tested** | `src/modules/students/`, eight endpoints, `verify-students.js` → **136 / 136, exit 0**. `requireModule('students')` router-level and `enforceLimit('student_limit')` on admission, proven as a cycle (admit → refuse the third → transfer → leave → re-admit into the freed allowance). Student ID and Roll Number are assigned when omitted — the prefix is `schools.code`, which the schema documents as "also used as the student-ID prefix", not an invented format. A **receptionist may admit**, which is FR-STUDENT-001's own actor list. **Session 23 gave the photo a real writer** — `POST /:id/photo` under `students.manage`, using the `PERSON_PHOTO` upload profile that had cited §15.1 / FR-STUDENT-001 since `upload.js` was written and had never been called. `photo_path` is now `forbidden()` in both body schemas and out of the service's writable list (Known Issues #26), and `present()` keeps the stored path out of the upload response, the read by id and every row of the list. The suite uploads real PNG bytes and proves them on disk under `school-<id>/person_photo/`. **Not covered:** §15.1's "Documents" — the `student_document` profile still has no caller **§36 triage — two gaps, both blocked on the source rather than on code.** **(1) The "documents" in this row’s own title has no code path.** `UPLOAD_PROFILES.STUDENT_DOCUMENT` exists at `constants.js:803` with a rule at `:848` whose `srs` field reads *§15.1 / FR-STUDENT-001 — "Documents"*, and **nothing in `src/` references it** — the photo half of the same clause is fully mounted, the documents half never was. It is not simply buildable: the `documents` table’s `document_type` enum holds only *generated* kinds (`student_id_card`, `admission_form`, `result_card`…) with nothing for uploaded paperwork, its other columns (`is_generated`, `generation_payload`, `generated_at`) are shaped for generation, and the only view permission in the fixed 109 is `documents.view` — *"View **generated** documents"*. §15.1 lists "Documents" as a bare feature name with no formats, types or storage model. So a student’s uploaded birth certificate has no type, and no permission that names it; choosing either would be inventing. **(2) Admission does not require a class.** SRS:812 makes "Class and section exist" a precondition and :818 says "Student is assigned to a Class and Section", but `class_id` is optional on create and `verify-students.js:122` deliberately asserts *"first_name and admission_date are enough to admit"*. The source answers this twice: §15.1 lists **Admission**, **Class Assignment** and **Section Assignment** as three separate features, which is what the code implements. Not changed on an ambiguous reading. |
| FR-STUDENT-002 | Promotion, transfer, leaving | **Tested** | Three routes behind `students.progression` — which a **receptionist does not hold**, matching FR-STUDENT-002's narrower actor list. A transition table on `students.status`, no new table. Nothing returns a student to `active`, so the ceiling cannot be re-entered without a fresh admission (the §5a defect 21 shape, answered by design rather than by a second guard). **Promotion keeps `status = 'active'`** — writing `promoted` would drop the student out of the `student_limit` headcount and let a school evade its ceiling by promoting everyone; the consequence is that `?status=promoted` is a filter that always returns empty, recorded in IMPLEMENTATION_PROGRESS.md §2l rather than hidden |
| FR-PARENT-001 | Parent account + multiple children linking | Completed | `parent_students` is the join table — it carries `school_id` **without** `organization_id`, so `tenantWhere()` will 500 on it for an organization-scoped caller. Scope it by the parent, the way `subjects.service.js` does (§5a defect 16). `parents.user_id` is **NOT NULL**, so this is the first module that must actually create a user — call `authService.sendVerificationEmail` rather than reimplementing the token. `parents_user_unique` enforces one account per parent at the database, unlike teachers and students | **Row corrected in session 24: it still read "Next" though the module shipped in §2m.** `src/modules/parents/`, eight endpoints; `verify-parents.js` → **116 / 116, exit 0**.
| FR-PARENT-002 | Parent dashboard | Completed | Resolve the parent from `req.user.id`, not a path id — the pattern `teachers.dashboard` sets | **Row corrected in session 24.** `GET /parents/dashboard` is declared ahead of `GET /:id` so the literal path is not swallowed, and the suite asserts that ordering.
| FR-TEACHER-001 | Teacher profile (qualification, joining date, subjects, classes) | **Tested** | `src/modules/teachers/`, six endpoints, `verify-teachers.js` → **87 / 87, exit 0**. Profile CRUD with every string width taken from the model; `GET /:id/assignments` reads `teacher_subjects` plus both senses of "classes". Assignment *writes* stay in §14.4's `POST /subjects/:id/teachers` so one relation has one writer. No DELETE — §15.3 names none; a teacher who leaves is deactivated by a `PATCH` |
| FR-TEACHER-002 | Teacher dashboard | **Tested** | `GET /teachers/dashboard`, resolved from `req.user.id` so no teacher can read a colleague's by changing a path id. A `teacher`-role user with no linked row gets 404 `TEACHER_PROFILE_MISSING`; a principal gets 403, because the seeded grants give `teachers.dashboard.view` to `super_admin` and `teacher` only |
| FR-STAFF-001 | Staff management (receptionist, accountant, librarian, other) | **Tested** | `src/modules/staff/`, four endpoints, `verify-staff.js` → **89 / 89, exit 0**. A deliberate near-copy of `teachers/` — same guards, `staff_limit`, the four §15.4 categories taken from the `staff.category` enum rather than restated. **It carries the re-activation ceiling `teachers/` shipped without** (§5a defect 21) from the start, asserted as a cycle: create to the ceiling, refuse, deactivate, reuse the freed allowance, then fail to re-activate. No dashboard and no DELETE — §15.4 names neither, unlike §15.3 and §15.2 |

### 3.K Attendance — §16

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-ATT-001 | Mark student attendance (Present/Absent/Leave/Late) | Completed | `POST /attendance/students`, marked by a `teacher`-role user as the FR names. Bulk by shape; the unique index on `(student_id, attendance_date)` makes a re-mark a **correction** rather than a duplicate, which is why there is no PATCH and no DELETE. `verify-attendance.js` → **82 / 82, exit 0** |
| FR-ATT-002 | Reports: daily, monthly, yearly, percentage | Completed | `GET /attendance/students/report`, exactly the three periods §16 names. §16 lists a percentage without defining it; the formula chosen is recorded in §2o of the progress log and asserted against **hand-computed** figures (75% for the day, 80% for the year) rather than against the code's own answer |
| FR-ATT-003 | Teacher attendance | Completed | `POST /attendance/teachers` + `GET /attendance/teachers`. **Narrower than the FR's actor list, deliberately:** FR-ATT-003 names Teacher, but the seeded catalogue gives a teacher only `attendance.self.view`, and the 109 permissions are fixed by §29/§30. The reading and its reason are recorded in §2o |

### 3.L Fee Management — §17

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-FEE-001 | Fee structure (monthly, admission, exam, transport, fine, discount) | Completed | `src/modules/fees/`, four structure endpoints plus `POST /fees/assignments` — the bridge FR-FEE-001's outcome and FR-FEE-002's precondition both name. The four components come from the `fee_structures.component` enum, asserted schema-against-model; a fifth is refused. Fine and Discount are the "may configure" half and both `fixed` and `percentage` are honoured. `fees.manage`, which the seeded grants give to exactly Principal / School Admin / Accountant — the FR's actor list. `verify-fees.js` → **174 / 174, exit 0** |
| FR-FEE-002 | Collection, partial payment, pending balance, payment receipt | Completed | `POST /fees/payments` (`fees.collect`, reaching Accountant and Receptionist) plus `GET /fees/ledger` and `GET /fees/payments`. Partial payment produces `partially_paid` and a `pending_amount`; the balance is **recomputed from a SUM over the fee's payments** inside the payment's transaction behind a `LOCK.UPDATE` read, never incremented. The receipt is `RCP-YYYYMM-NNNNN`, allocated per **school** because the unique index is `(school_id, receipt_number)`. Every figure runs through `utils/money.js` in integer minor units. A second assignment of the same fee for the same period is refused as a double-bill — `student_fees` has no unique index to do it **Corrected in the §36 final pass:** the Expected Outcome — the ledger "reflects payments made and any remaining pending balance" — was **not met by the UI**. The Fees screen had one money column labelled **Owed** bound to `net_amount`, the amount charged after discount and fine and *before* any payment, so a student who had paid 300 of 950 rendered as "Owed 950.00" beside a `partially_paid` badge. The row interface did not declare `paid_amount` or `pending_amount` at all, though the endpoint returns both. Now three columns: Charged, Paid, Pending. |

### 3.M Finance — §18

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-FIN-001 | Record Income & Expenses (incl. Salaries, Other Expenses) | Completed | `src/modules/finance/`, four routes per ledger. Both category enums are closed by §29/§35 and asserted schema-against-model. `finance.manage`, granted to exactly FR-FIN-001's actors — Accountant / Principal / School Admin (plus Super Admin). A `salaries` expense must name a teacher, a staff member or a `paid_to`, enforced by the model's own validator and surfaced as 422. All four optional FKs are checked in-school on create **and** update. `verify-finance.js` → **163 / 163, exit 0** |
| FR-FIN-002 | Net Balance = Income − Expense | Completed | A **field on `GET /finance/report`**, not a route: FR-FIN-002's actor is literally "System", and the seeded `finance.view` is one key named "View income, expenses & net balance". Computed at query time — `models/finance.js:10` says it is never stored and there is no column for it. `0` over an empty window (defined, and zero) and **never clamped**, so a school that overspent reports a negative balance. A window holding two currencies is refused rather than summed **Corrected in the §36 final pass:** *"Net Balance is displayed on the finance dashboard"* was **not met** — the figure was computed at `finance.service.js:502` and `net_balance` appeared nowhere in `frontend/src`. The Finance screen deferred it to "the school Reports screen", which §33 does not list among its seventeen School screens, so the deferral pointed at a screen that is neither required nor built. The Finance screen now renders Income, Expense and Net Balance from `/finance/report`, deficit shown negative and never clamped. |
| FR-FIN-003 | Financial Reports | Completed | The same `GET /finance/report`, taking an optional `from`/`to` window and an optional currency, returning both totals partitioned by their fixed category enums. **No period enum and no export**: §18 names neither, and SRS §22 is a separate Reports section that owns "Expense Reports" and PDF/Excel/Print (FR-REPORT-001/002) — a taxonomy here would pre-empt a module that does not exist yet. A transposed window is refused rather than answered with a confident `0.00`. **Known gap, recorded in §2q:** fee collections are not posted to `incomes`, so the balance reflects what was *recorded*, not everything received |

### 3.N Examination & Result — §19

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-EXAM-001 | Create exam (type, subjects, marks, passing marks, grade system) | Completed | `src/modules/exams/`, mounted `/api/v1/exams`. Grade scales are school-configured (`POST /exams/grade-scales`) and nothing is seeded, as this row already noted; an overlapping band is refused at write time because `grades` has no unique index and §35 forbids adding one. An exam naming a scale with no active bands is refused — nothing would grade it. `exams.manage`, which the seeded catalogue gives Principal / School Admin / Super Admin. **Narrower than the FR’s actor list, deliberately:** FR-EXAM-001 (SRS:1001) names Teacher, and the seeded catalogue gives a teacher `exams.view`, `marks.enter` and `results.view` — not `exams.manage`. The 109 permissions and 353 grants are fixed by §29/§30/§35, so the narrowing cannot change; it is stated here for the reason FR-ATT-003 states its own. `verify-exams.js` → **219 / 219, exit 0** |
| FR-EXAM-002 | Marks enter / edit / submit | Completed | `POST /exams/marks` (bulk upsert on the `(exam_subject_id, student_id)` unique index, so re-posting **corrects** rather than duplicates — which is what "may edit prior to submission" asks for) and `POST /exams/marks/submit`, both `marks.enter`, which the catalogue does give a Teacher. A submitted paper is closed; an entry must record a mark **or** an absence; and a paper cannot be submitted while any student in the cohort lacks a row, so "forgotten" and "absent" cannot reach the calculation as the same thing |
| FR-EXAM-003 | Auto-calc total, percentage, grade, pass/fail | Completed | `recalculate()` runs on submission, requires a transaction, re-derives from the exam's own rows and never increments. Practical marks count on both sides; **weighting is not applied** (§19 names none, and `weightage` is refused in both schemas so the column holds its default); Pass/Fail is conjunctive — any failing paper, or a band marked `is_failing`, fails the exam. A percentage matching no band is left ungraded and blocks generation rather than silently passing. Every figure in the suite is hand-computed |
| FR-EXAM-004 | Result card, class result, student result, position, grade | Completed | `POST /exams/:id/results` (`results.generate`) computes Position; `GET /exams/:id/results` is the Class Result, `GET /exams/results/:id` the Student Result and Result Card payload. Ranked on the stored percentage in integer thousandths so two cards printing the same figure share a place; ties share a position and the next skips. Only students with a mark on **every** paper are ranked — a child who transferred out, was promoted, or enrolled late is calculated but not ranked and not published (§5a defect 40). **Narrower than the FR’s actor list, deliberately:** FR-EXAM-004 (SRS:1025) names Teacher, and `POST /exams/:id/results` requires `results.generate`, which the seeded teacher does not hold. Same fixed catalogue, same reason as FR-EXAM-001 and FR-ATT-003 |
| FR-EXAM-005 | PDF export + print support | Completed (PDF); Print is a client concern | `GET /exams/results/:id` returns a card-complete payload — school, exam, student, per-subject rows, totals, grade, outcome, position — from one response with no follow-up call, and `?format=pdf` renders that **same payload** through `src/utils/pdf.js`, so the printed card and the one on screen cannot disagree. §19.3 names PDF and Print and **no Excel**, so a spreadsheet is refused with 422 even though §22 offers one; `print` is refused for §22's reason — there is no view engine here. An absent paper prints `absent`, not the `0` that would report a mark the student never received. `results.result_card_path` stays NULL and is still refused in every schema: the Buffer is **streamed**, which needs no storage profile and no serving route — persisting a card is a separate decision from rendering one. **The FR’s Parent and Student actors reach the results and not the artefact, and this row used to say otherwise.** `GET /exams/my-results` reaches them with `results.self.view` for *viewing* their own or their child’s published results — it has no `format` branch and its schema declares no `format` key, so `?format=pdf` is stripped before the controller sees it. The only PDF route, `GET /exams/results/:id`, is gated on `results.view`, which the fixed catalogue grants neither role (`permissions.js:388, :406` give them `results.self.view` only). So the PDF/Print half of FR-EXAM-005 does not reach two of its five named actors; they can obtain a result-card PDF only through §20.5’s documents route, after a `documents.generate` holder has generated the row. Closing it needs no new permission — `requireAnyPermission('results.view', 'results.self.view')` with the self-narrowing `myResults()` already applies — but that is an implementation decision and is not taken here. `verify-exams.js` → **219 / 219, exit 0**; nine deliberate regressions on the export alone |

### 3.O Timetable, Homework, Assignment, Library, Documents — §20

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-TT-001 | Class + teacher timetable (period, room, subject, teacher) | Completed | `src/modules/timetable/`, mounted `/api/v1/timetable`, six endpoints. §20.1 names a Class Timetable and a Teacher Timetable and §29 gives one table, so each gets its own named read — `GET /class/:classId` and `GET /teacher/:teacherId` — returning rows in **week order**, which works because the `day_of_week` ENUM is declared Monday-first and MySQL orders an ENUM by declaration. Period, Room, Subject and Teacher are all on the row; a break needs no subject, which the model's own `teachingSlotNeedsSubject` validator enforces. `timetable.manage` is granted to exactly Principal / School Admin / Super Admin — an exact match for this FR's actors. `verify-timetable.js` → **115 / 115, exit 0** |
| FR-TT-002 | Conflict detection (period / room / teacher) | Completed | All three conflicts checked as one query set inside the write transaction, on create **and** on edit (the row being edited is excluded, or every edit would find itself). Conflicts are **prevented** with a 409 rather than flagged, because §35 forbids adding a column and there is nowhere to store a flag — the colliding row is returned in `details` so a client can render one. Teacher and Room fire only when the column is set, so two entries naming neither clash with nobody and are allowed; `is_break` therefore needs no special case. The unique index is NULL-permissive on `section_id`, so the class-wide half is the service's work — §5a defect 19's third sighting. `period_number` is authoritative rather than the clock, because that is what all three of the schema's indexes key on. Ten deliberate regressions, each failing its own assertion |
| FR-HW-001 | Homework create + file upload + due date | Completed | `src/modules/homework/`, **five** endpoints at `/api/v1/homework` — the fifth is `GET /:id/attachment` (`homework.routes.js:91`), the download route an earlier note said did not exist ("no file-serving anywhere in the application"). It does, and has since the upload shipped. Create, upload and due date are one multipart request, using the `homework` multer profile that `upload.js` had reserved for this FR and never had a caller for — the first upload the application actually performs. `attachment_path` is refused from the body and the stored path never reaches a caller. `homework.manage` reaches Teacher, this FR's named actor. Because `homework.view` also reaches students and parents with no `.self.view` to separate them, the service narrows a student to their own class's published homework and a parent to their children's, on the read-by-id as well as the list. `verify-homework.js` → **109 / 109, exit 0**, and it uploads real bytes, checks them on disk and cleans them up. **Not covered:** no download route — there is no file-serving anywhere in the application, which row 5.4 and FR-DOC-001 own |
| FR-ASG-001 | Assignment create → submit → review | Completed | `src/modules/assignments/`, eight endpoints at `/api/v1/assignments`. All three steps of the FR: `POST /` (Teacher, `assignments.manage`), `POST /:id/submissions` (Student, `assignments.submit`, multipart via the `submission` profile that cited this FR and had no caller), `PATCH /submissions/:id/review` (Teacher, `assignments.review`). One table, `record_type` separating the two shapes, so the two lists are filtered separately and each is asserted for what it must **exclude**. `assignments_submission_unique` genuinely enforces one submission per student here — both its columns are non-null on a submission row, unlike the three other tables carrying that index shape. `returned` re-opens the submit route and a replacement clears the stale mark; `submitted`/`reviewed` are refused. Students are narrowed by `student_id` and not by class, so a classmate's answer is not visible. `verify-assignments.js` → **196 / 196, exit 0**, sixteen deliberate regressions. **Not covered:** no download route — row 5.4 and FR-DOC-001 own it |
| FR-LIB-001 | Catalog: books, authors, categories, quantity | Completed | `src/modules/library/`, four catalogue endpoints at `/api/v1/library/books` under `library.manage` / `library.view`. Author and category are the free `STRING` columns §29 gives them, not a 65th and 66th table. `available_quantity` is derived and `forbidden()` from the body — editing `quantity` moves it by the same delta, and a reduction below the copies on loan is refused with `QUANTITY_BELOW_LOANS`, under a locking read. `cover_path` is refused too, so this module adds no sixth column to Known Issues #26. A book is retired with `is_active: false`; there is no DELETE. `verify-library.js` → **161 / 161, exit 0** |
| FR-LIB-002 | Issue, return, fine | Completed | Five endpoints at `/api/v1/library/transactions` under `library.issue`: issue, return, and a **separate** fine route, because calculating a fine and settling it are separate events and folding them together would make an unpaid fine unrecordable. All three borrower types work; the schema enforces the **exclusivity** the model's `borrowerMatchesType` validator does not. Issue and return each take a locking read on the book row — the project's first shared counter. The fine is computed (`fine_per_day` × whole days late, via `utils/money.js`), a payment above it is refused, and a waiver settles it. A **lost** copy does not return to the shelf. Overdue is **derived, never stored** — the enum value exists and nothing writes it, because a stored flag would be wrong every day between the due date and a sweep §20.4 does not ask for. **Twenty-one** deliberate regressions |
| FR-DOC-001 | 7 documents: student ID card, teacher ID card, admission form, fee receipt, result card, character certificate, leaving certificate | Completed | `src/modules/documents/`. All seven generate a record with a `generation_payload` snapshot, and **all seven render as PDF** via `?format=pdf` (Phase 5.4). Three shapes: label/value for the two ID cards, label/value plus a table for the admission form, fee receipt and result card, and **prose** for the two certificates, which are letters. The PDF is rendered from the stored payload, not the live record — a certificate reissued later says what it said when issued, asserted by renaming the student and requiring the old name to survive. A Character Certificate **characterises nothing**: §29 records no conduct and §20.5 fixes no wording, so it states what is on file and ends in a signature block, and the suite asserts the conduct phrases are absent. §19's absence rule is shared via `subjectRows()` rather than copied, so `0` can never replace `absent` in one renderer and not the other. `documents.file_path` stays null: the Buffer is streamed. `verify-documents.js` → **133 / 133, exit 0**; ten deliberate regressions on the export alone |

### 3.P AI Module — §21

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-AI-001 | Upload → Extract → Analyze Topics → MCQs → Answers → Difficulty → Preview → Approve → Question Bank | Completed (workflow, stage machine and mock driver; the provider is row 5.2) | `src/modules/ai/`, ten endpoints at `/api/v1/ai`, and `src/ai/` for the provider seam. The nine steps become ten routes with three collapses, each forced by something that already existed — steps 4+5 share one `AI_WORKFLOW_STAGES` value and one row, step 7 is a read, step 9 is step 8's outcome. `workflow_stage` is a state machine `forbidden()` in every schema, so no body can jump to `approved`; every transition is asserted out of order as well as in it. `source_path` is refused from the body (Known Issues #26's doctrine, eighth module). Brings `question_banks`, `questions`, `aiLimiter` and the `ai_source` profile alive — all four were dead code. `verify-ai.js` → **188 / 188, exit 0**, sixteen deliberate regressions. **Not covered:** the Anthropic adapter has never been executed — row 5.2 |
| FR-AI-002 | AI usage limit enforcement + block/warning at limit | Completed | The generation route is the only one carrying `enforceLimit(LIMITS.AI_LIMIT)` and the only caller of `usageService.recordUsage` — **which had zero call sites in `src/` until now**. §21's example is "1000 AI Requests", so one generation is one unit; had extract and analyze counted too, that plan would buy 333 question sets. The increment runs **after the commit, awaited and unswallowed**, and all three properties are proved: a blocked request leaves the counter unmoved, a failed generation leaves it unmoved with the bank retryable and no questions written, and only the retry charges. `GET /ai/usage` is §21's "Usage: 750 / 1000" display with an `at_limit` flag computed server-side. Each school meters its own allowance |

### 3.Q Reports — §22

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-REPORT-001 | 7 reports: student, attendance, fee, expense, exam, teacher, subscription | Completed | `src/modules/reports/`, seven GET endpoints at `/api/v1/reports` — the **first read-only module**, because §29 gives §22 no table. Two of the seven **delegate** rather than reimplement: the Attendance Report calls `attendanceService.report()` and the Expense Report calls `financeService.report()`, and both routes validate against the owning module's own schema, so the paired endpoints cannot drift. The suite compares the payloads field for field. The Exam Report aggregates §19's **stored** columns and recomputes no position. Every route requires **two** permissions — `reports.view` plus the owning module's read — because `reports.view` reaches Teacher and Librarian whom `finance.view` and `fees.view` do not. `verify-reports.js` → **112 / 112, exit 0**, twenty-three deliberate regressions |
| FR-REPORT-002 | Export PDF / Excel / Print | Completed | **Excel is delivered.** `?format=excel` on any of the seven returns a real workbook — proved by its zip magic and by reading the cells back through exceljs and matching them to the JSON. `exceljs` had been installed and unused since `package.json` was written; `writeBuffer()` returns a Buffer, so nothing touches disk and no upload profile or storage accounting is involved. What was actually missing was a **non-JSON response** — `ApiResponse` emits only `res.status().json()`. `reports.export` is required only when a format is asked for. **PDF also ships** (row 5.4): `src/utils/pdf.js` renders it from `toRows()`, the same walk `toExcel()` consumes, so the two exports cannot disagree about what a report contains. **Print is client-side and now exists.** `?format=print` stays **refused 422** — there is no view engine here to produce a print-ready payload, and `constants.js` no longer claims otherwise — while FR-REPORT-002’s own words are an actor’s action, *"User prints the report"*, which the Reports screen’s print control and the `@media print` block in `globals.css` satisfy. **And until session 26 the two file formats had no reachable caller.** `apiClient.request()` ended unconditionally in `response.json()`, and the documented workaround of typing `?format=excel` into the address bar could not work either — the access token is held in memory and travels as a header, so a pasted URL is unauthenticated. `api.download()` is the binary path; the Reports screen offers both exports, gated on `reports.export` exactly as the router’s conditional guard is |

### 3.R Notifications — §23

| ID | Requirement | Status | Notes |
|---|---|---|---|
| FR-NOTIF-001 | 9 notification types | Completed | `src/modules/notifications/`. FR-NOTIF-001's actor is **System**, so dispatch has **no route**: `runNotificationSweep()` runs eight passes covering all nine types and is called by a scheduler, exactly as `subscriptions.runLifecycleSweep()` is. The architecture was settled by §29 rather than chosen — five tables carry a marker column (`homework.notified_at`, `exams.announced_at`, `student_attendance.alert_sent_at`, `student_fees.reminder_sent_at`, `subscriptions.expiry_notified_at`) whose own comments name a *cron*, and two earlier modules already refuse theirs with *"stamped by the §23 notification job"*. The four types §29 gave no marker are held idempotent by `(reference_type, reference_id)`, which is why that index exists. **No module gate and no limit**: there is no `MODULES.NOTIFICATIONS` and none of §11.2's eight limits counts notifications, so §23 is core. Two channels only — an `in_app` row *is* the delivery and is born `sent`; an `email` row is a delivery attempt through `mailService` and is the only thing `POST /:id/retry` can repair. **Not one line of the seven owning modules changed.** `verify-notifications.js` → **100 / 100, exit 0**, forty-three deliberate regressions **Corrected in the §36 final pass:** four of the nine types — Result Published, Fee Paid, Payment Received, Payment Failed — **stopped permanently after 500 rows**. The five marker-backed passes exclude notified rows in SQL; these four selected the OLDEST `limit` rows and filtered the notified ones in **JavaScript, after the LIMIT**, so the limit was spent on work already done. Past `SWEEP_LIMIT` (500) every run refetched the same 500, filtered them all out and reported 0 for ever. `sweepFeePaid` had **no WHERE clause at all**. Fixed with a subquery against `notifications` (§35 forbids the marker columns the others have); the payments pass keeps its per-*type* check. `verify-notifications.js` 98 -> 100: with `limit: 1`, one payment announced and a second waiting, a sweep of one must reach the second — the old code returns 0. |

### 3.S Optional demo seeders

| # | Requirement | Status | Notes |
|---|---|---|---|
| 3.S.1 | `src/database/seeders/demo/` sample data behind `npm run db:seed:demo` | Pending | The CLI commands are wired and currently warn *"No demo seeders found"* and no-op — correct behaviour, not a bug. Optional; the SRS names no concrete plans, classes or students, and §35 forbids inventing them |

---

## Phase 4 — Frontend

**Started in session 26.** `frontend/` is scaffolded — Next.js 16 App Router, React 19, Tailwind 4,
TypeScript — with the three pieces every screen depends on: `src/lib/apiClient.ts` (the envelope,
single-flight 401 refresh-and-retry, CSRF), `src/lib/auth.tsx` (`AuthProvider`), and the sign-in
page. Built to `docs/ARCHITECTURE.md` §8, which already fixed the route groups and the providers.

**One blocker found, and it is a real gap rather than a missing screen.** §8 describes an
`EntitlementProvider` that "fetches the school's entitlement snapshot and hides/disables gated
modules", and §30 Rule 1 requires that gating to be database-driven with no plan name in UI code.
**No endpoint returns that snapshot for the current caller.** `entitlementService.getSnapshot()`
computes exactly the right thing — `modules`, `features`, `limits`, `subscription.isUsable`, cached
per school — but it is reachable only from middleware. `/subscriptions/catalogue` returns the §12
vocabulary, not this school's entitlements, and `/schools/{id}/usage` is Super-Admin-shaped and
needs an id the school user should not have to supply. **Row 4.10 cannot be built until that is
closed.** The cheapest close is to extend `GET /auth/me`, which already returns the resolved
tenant and is already called on every load: it adds no route and no permission, which matters
because §29/§35 fix the catalogue at 109 permissions and a new route would want one.

| # | Requirement | SRS | Status | Notes |
|---|---|---|---|---|
| 4.1 | Responsive dashboard (Next.js + Tailwind) | §3 | Completed | |
| 4.2 | Auth pages (login, forgot/reset password, verify email) | §7 | Completed | |
| 4.3 | Super Admin: 16 MVP screens | §33 | Completed | **All sixteen exist and are reachable — fourteen functional, one a dashboard placeholder, and the sixteenth documents a gap in the SRS rather than inventing past it.** *(Reports was counted among the fourteen while running **one** of §22’s seven reports and offering **none** of its three export formats; it now runs all seven and offers all three — see §3.R and the note below.)* §33 lists **Settings** among the sixteen, so the screen and its nav entry are required; but nothing specifies what it contains. The role table (SRS line 96) defers to "global settings (see Section 9)", and §9 defines only 9.1 Dashboard, 9.2 School Management and 9.3 Principal Creation — the cross-reference points at nothing. No platform-scoped settings endpoint exists (`/school-settings` is §14.1, school-scoped, Principal actor, and refuses a platform caller with `SCHOOL_CONTEXT_REQUIRED`), A permission **does** exist and an earlier version of this row said otherwise: `settings.platform.manage` — "Manage global settings", `permissions.js:39` — is one of the fixed 109 and is granted to `super_admin` via `ALL`. The nav now gates on it. It had previously borrowed `schools.view`, which `organization_admin` also holds, so an org admin was shown a link into a **platform** screen; and the false claim was rendered to the signed-in user on the screen itself. The permission was never the gap — the specification is. A form would have had to invent the requirement, the fields **and** an endpoint to save them to. The screen instead states the gap and links to the six places platform configuration genuinely lives (Plans, Modules, Features, Limits, Add-ons, Coupons), following the precedent the Reports screen set: naming an absence beats claiming a capability the system does not have. **The link was previously dead** — the nav pointed at a page that did not exist and returned a bare 404, found by running the app. **The create screens are built too (session 26).** This row previously carried a warning that every "Add"/"New" button pointed at a route that did not exist — eighteen dead links, no create path through the UI at all. All eighteen now exist, each built against its module’s own create schema, with the field set and the required-ness taken from the API rather than chosen. `next build` generates 61 pages (was 43) and `verify-frontend.js` asserts **zero** unresolved internal links. Known Issue 30 is closed. |

**15 of 16 built** (session 26). Six by hand — the dashboard placeholder and **Schools**, the exemplar — and nine by a workflow following it: Organizations, Principals, Users, Plans, Add-ons, Subscriptions, Invoices, Payments, Coupons. All build, typecheck and pass `verify-frontend.js`.

**Three of the four I had recorded as unbuildable turned out to be buildable**, and the note above
is wrong about them — kept, because the reasoning that produced it is the same reasoning that fixed
it. `GET /plans/{id}` attaches `modules`, `features`, `limits` and `prices` through `DETAIL_INCLUDE`
(`plans.service.js:84`), so **Modules**, **Features** and **Limits** are plan-scoped views: the screen
asks which plan first, exactly as Sections asks which class. And the Features problem dissolved on
inspection — `plan_features` carries its own `name` and `module_key` per row, so a feature is
self-describing even though no global vocabulary exists.

Each says where it stops. **Modules** renders all twenty §11 keys against the plan's rows so a
*missing* module is visible, and distinguishes three states rather than two — no row at all means
"never configured", which `PUT /plans/{id}/modules` treats differently from a row saying
`is_enabled: false`. **Limits** renders `unlimited` as the word, because a null `limit_value` shown
as `0` says nothing is allowed and an em-dash says nothing is known, both wrong in the same
direction. **Features** cannot show what a plan is missing and says so: *missing* is undefined for a
vocabulary that does not exist.

All three are **read-only on purpose**. `PUT /plans/{id}/modules` replaces the whole set, so an
editor is a form that sends every module at once; a toggle that silently dropped the others would be
worse than showing the state honestly. That is the next increment.

**The sixteenth screen, Settings, is not missing frontend work.** `/platform` exposes only
`/platform/dashboard`, `/school-settings` is school-scoped (§14.1), and `/meta` is the public API
descriptor. There is no platform-settings endpoint to build against, and inventing one would be
inventing a requirement §33 does not state. The row stays In Progress rather than Completed because
the screen §33 names does not exist — but the remaining work is a decision about the API, not about
this phase.

**Reports** was built by hand rather than generated, because it is not a list: §22 has seven endpoints and no `GET /reports` above them. **This row used to say a platform caller "cannot run them at all", and that was false.** Six of the seven resolve a school, but a platform caller names one: `entitlement.js:256` returns `next()` for `req.tenant.isPlatform` before any snapshot loads, so `requireModule` never refuses; Super Admin holds `ALL`; every school schema accepts `school_id`; and `schoolScope.js:46-53` **requires** the id then **honours** it. Measured in `verify-reports.js`: all six answer **200** to a Super Admin naming `?school_id=N`, with the same figures that school’s own principal sees, and on the same id a principal scoped elsewhere is refused. The refusal for a *missing* id is a **422 naming `school_id`**, not the `SCHOOL_CONTEXT_REQUIRED` this row and the screen’s header both named — that code is raised inside `resolveGatedSchoolId`, on the far side of the platform short-circuit, and a platform caller can never see it. The false premise was load-bearing: the six were rendered as inert `<li>` cards because of it. The screen now runs all seven behind a school selector fed by `GET /schools`, and renders each through the exporters’ own `toRows()` flattening so the screen, the workbook and the printed page cannot disagree.

**Formerly recorded as four unbuilt** — Settings and the three plan sub-screens. All four now exist: Modules, Features and Limits are plan-scoped views built in session 26, and Settings was built as the screen §33 requires, stating the specification gap rather than inventing a form. The sentence below is kept because the reasoning is still the reason Settings has no form. **Settings has no endpoint at all** — `/platform` exposes only `/platform/dashboard`, `/school-settings` is school-scoped (§14.1), and `/meta` is the public API descriptor. That is a fourth §33-versus-API mismatch of the same kind as Modules, Features and Limits, recorded rather than resolved by inventing a settings surface the SRS does not describe.

**The review found four defects in the shared layer, not in the generated screens** — pagination read one level too shallow, the refusal branch was unreachable for the likeliest refusal, `StatusBadge` toned four status words out of twenty, and one comment stated a false fact about a guard. Each affected all nine screens at once, and none was caught by the build, the typecheck, or nine browser sessions. Written up in §2aj.

Every list screen carries a permission-gated "Add …" button pointing at a `/new` route that does not exist. **The claim that "a group-level `not-found.tsx` answers those honestly rather than with a bare 404" was wrong and is now tested.** `(platform)/not-found.tsx` exists and renders "This screen has not been built yet", but it is **never reached**: Next cannot attribute a completely unmatched path to a route group, so `/super-admin/schools/new`, `/school/students/new` and a nonsense path all return the framework default, *"This page could not be found"* — measured against the running dev server. The boundary is dead code for the case it was written for. Known Issue 30 and rows 4.3/4.4 carry the eighteen links.

The original exemplar note, kept because it is what the nine were built against: **Schools** is the exemplar the rest follow — `useCollection` + a `Column[]` + the four-state render + pagination. Verified in a browser against the live API: `GET /schools?page=1&limit=20` → 200, the permission-gated action button rendered, both empty-state variants correct, and typing five characters into search produced **one** request rather than five. One request showed `ERR_ABORTED` — that is the `AbortController` collapsing Strict Mode’s double-effect, and the hook ignoring the abort instead of flashing an error.

The shared pieces the other fourteen need are done: `lib/useCollection.ts` (four states, and a **refusal** channel separate from **error** so `MODULE_NOT_SUBSCRIBED` / `SUBSCRIPTION_INACTIVE` / `FORBIDDEN` are explained rather than reported as faults) and `components/table.tsx` (`DataTable` scrolling inside its own focusable region, `Pagination` with an `aria-live` position, `StatusBadge` showing the word and not colour alone).
| 4.4 | School: 17 MVP screens | §33 | Completed **The create screens are built too (session 26).** This row previously carried a warning that every "Add"/"New" button pointed at a route that did not exist — eighteen dead links, no create path through the UI at all. All eighteen now exist, each built against its module’s own create schema, with the field set and the required-ness taken from the API rather than chosen. `next build` generates 61 pages (was 43) and `verify-frontend.js` asserts **zero** unresolved internal links. Known Issue 30 is closed. |

**All 17 built** (session 26). Eleven by a workflow following the Schools exemplar; six by hand,
because they are not single lists:

| Screen | Why it was built by hand |
|---|---|
| **Library** | Two collections — `/library/books` and `/library/transactions` |
| **Finance** | Two — `/finance/incomes` and `/finance/expenses`; `/finance/report` is a summary and belongs on Reports |
| **Fees** | Three — `structures` → `ledger` → `payments`, tabbed in that order because it is the module's own causality |
| **Sections** | No collection exists. `GET /classes/{id}/sections` needs a class, so the screen picks one first — unlike Features on the platform side, this one has a real vocabulary to pick from |
| **Documents** | The one router with no `requireModule()`: §20.5's seven types span four modules, so the check happens per type inside the service |
| **Dashboard** | A placeholder rendering the entitlement snapshot |

The multi-endpoint screens share `components/tabs.tsx`, which keeps the active tab **in the URL** so a
reload holds it and a link can point at one.

**The review found three defects, none of them in the generated screens.** Two were in the shared
layer and one was in the backend, all recorded in §2ak: a missing `ORDER BY` tiebreaker that made
**every paginated endpoint in the application** able to repeat or skip rows; `StatusBadge` toning
twenty of the fifty status words; and `pass`/`fail` untoned because `RESULT_OUTCOME` is not named
`*_STATUS`.

### Two limitations recorded rather than resolved

- **`GET /students` returns no class or section.** `students.service.js:402-405` passes only
  `{ where, order }` to `paginateQuery` — there is no Sequelize `include` in the module at all — so
  `class_id` and `section_id` arrive as bare integers. The Students screen therefore cannot show
  placement, which is the most useful thing about a student list. The agent that built it correctly
  declined to render the raw ids. Adding the includes is a change to the API's payload rather than a
  defect fix, and §15.1 does not specify list columns, so it is recorded here instead of assumed.
- **Three of `STUDENT_STATUS`'s six values are never written.** `students.service.js:29-38` records
  the decision in its own words — promotion keeps `status = 'active'` and moves `promoted_at`
  instead, so `promoted` "is a value this module never writes", with `graduated` and `inactive`
  likewise. The screen's filter was narrowed to the three reachable values: offering the others meant
  an administrator who had just promoted a cohort could filter "Promoted", see nothing, and conclude
  the cohort was lost.
| 4.5 | Teacher dashboard | §15.3 | Completed | `(teacher)/teacher` on `GET /teachers/dashboard`. It answers the one question no list screen can — **which subjects and classes are mine** — because every list is school-wide. §5’s teacher work (attendance, marks, homework) is already those School screens with permissions a teacher holds. **Timetable is the exception and this row used to include it:** §5:100 says a Teacher "manages timetable-related teaching periods", the seeded catalogue gives them `timetable.view` and not `timetable.manage`, and FR-TT-001's own Actor / Role line (SRS:1084) names only Principal / School Admin. The screen the shortcut points at is a read, and labels itself one. The source contradicts itself and §29/§30/§35 fix the grants, so this is recorded rather than resolved — triage finding 47. The same is true of §5's "manages subjects and classes assigned to them": the teacher holds `classes.view` and `subjects.view` only, so `TEACHER_NAV` points into them rather than duplicating them: a second attendance screen gated differently is how two versions of one workflow start. Shortcuts are filtered by the same permission-and-module pair as the sidebar, so a link never leads to a refusal. |
| 4.6 | Parent dashboard | §15.2 | Completed | `(parent)/parent` on `GET /parents/dashboard` — the linked children, their enrolment status, and which link is the primary contact. **One nav entry, and that is the requirement rather than a shortfall**: §5 grants a parent an account, a link to children and "access to a Parent Dashboard", and names no parent-facing list screen. The API has no endpoint for one. The screen says so in a line at the foot rather than leaving a parent to infer it from an absence. |
| 4.7 | Student portal | §5 | Completed | `(student)/student` on `GET /exams/my-results`. **The smallest surface in the product, for three reasons all recorded elsewhere**: §33’s MVP list names no student screen at all; three of the four self-service permissions in §29’s fixed catalogue — `students.self.view`, `attendance.self.view`, `fees.self.view` — are mounted **nowhere**, each router recording in its own header that the SRS section describes no self-service view; and `results.self.view` is the one that *is* mounted, because §19.3 does describe a student seeing their result. Only published results are returned — the service pins `is_published: true` — so an empty list usually means "not released yet", which the empty state says. Building more would mean inventing four endpoints and the requirements to justify them. |
| 4.8 | Frontend ↔ backend API integration | §4 | Completed | `src/lib/apiClient.ts` — the envelope unwrapped once, single-flight 401 refresh-and-retry, CSRF on every mutating call, and a typed `ApiError` carrying the backend’s own `code` plus `fieldErrors()`. Twenty-nine screens call it. `verify-frontend.js` checks **every path the client calls against the generated OpenAPI document**, so a renamed route fails the suite the same day and names the file still calling the old path. |
| 4.9 | Client-side validation + error states | §32 | Completed | **Error states are the substantial half and they are complete**: `useCollection` gives every list four states, and splits a **refusal** from an **error** so the ten codes `authorize.js` and `entitlement.js` raise are each explained with their own remedy rather than answered by a "Try again" button that cannot succeed. Field errors come from the API’s own `error.details`, keyed onto the inputs by `components/form.tsx`. **Client-side validation is deliberately thin**: the API validates with Joi and its refusals are precise, so a second rule engine in the browser would be a copy that drifts — and the one it drifts from is the one that decides. The exception is a comparison the API cannot make, like "these two passwords match", which is a property of the form rather than of the request. |
| 4.10 | Module gating from subscription (no hard-coded plan names) | §30 R1 | Completed | `EntitlementProvider` exposes `hasModule` / `hasFeature` / `limitFor` and **not the plan**, so the shape Rule 1 forbids is unavailable rather than merely discouraged — there is no plan name in scope to compare. The nav is generated from `lib/nav.ts` by `visibleNav()`, and the entitlement snapshot rides on `GET /auth/me` (added in §2ah, because no endpoint returned it for the current caller). `verify-frontend.js` asserts no file compares a plan code or name against a literal, that every module key named in the nav is one of §11’s twenty, and that no Super Admin screen carries a module gate at all. |

### What shipped in session 26, and what each row still owes

`frontend/` is scaffolded and **builds** — Next.js 16.3.4 App Router, React 19.2.8, Tailwind 4.3.3,
TypeScript 5.9.3. `npm run build` and `tsc --noEmit` both pass. Verified by
`backend/scripts/verify-frontend.js` (170 assertions, 43 deliberate regressions all caught), which
checks the client against the **generated OpenAPI document** rather than a hand-written list, so a
renamed route fails the suite the same day and names the frontend file still calling the old path.

| Row | Shipped | Still owed |
|---|---|---|
| Row 4.1 | **The shell.** `components/shell.tsx` — the signed-out guard, the header, and a sidebar whose items are generated by `visibleNav()` from `lib/nav.ts`. Measured in a browser at both breakpoints: at 1440 px the sidebar is visible and the toggle is `display:none`; at **360 px** the sidebar is `display:none` (out of the accessibility tree, not merely off-screen), the toggle is named "Open navigation", `aria-expanded` flips, all sixteen links become reachable, and the document does not scroll horizontally — `scrollWidth` 360 against a 360 px viewport. **The desktop half of that was not true when it was written and is now.** The toggle carried Tailwind's `md:hidden`, which cannot hide a `.btn`: `.btn { display: inline-flex }` is plain CSS after `@import "tailwindcss"` and beats a layered utility, so the hamburger rendered 30×30 beside the sidebar it opens at every width. Re-measured at 1440 px as `display: none` only after `.btn-mobile-only` replaced it | — |
| Row 4.2 | **All five.** `login` and `change-password` were driven end-to-end in a browser against the real API; `forgot-password`, `reset-password` and `verify-email` build and are asserted by `verify-frontend.js`. Every input goes through `components/form.tsx`, so `aria-describedby` cannot drift between pages again — the suite refuses a raw `<input>` on any auth page | — |
| Row 4.8 | `apiClient.ts` — the envelope, single-flight 401 refresh-and-retry, CSRF, typed `ApiError` with `fieldErrors()` | Per-module clients for the 33 screens |
| Row 4.10 | `EntitlementProvider` with `hasModule` / `hasFeature` / `limitFor`, the backend `entitlements` field that makes it possible, and `lib/nav.ts` — the nav as a **table**, each row naming the permission the screen needs and the module key its router actually gates on. `verify-frontend.js` checks every one of those keys against the fixed catalogues (109 permissions, 20 modules) and asserts that no Super Admin screen carries a module gate at all | The screens themselves |

**Three of the sixteen Super Admin nav items are provisional, and the reason is a real mismatch
between §33 and the API.** §33 lists **Modules**, **Features** and **Limits** as screens. The API
models all three as `PUT /plans/{id}/modules`, `…/features`, `…/limits` — sub-resources of a plan,
with no standalone list endpoint. So none of them can be the list screen the nav currently implies:

- **Modules** and **Limits** at least have a vocabulary to render. `GET /plans/catalogue` returns
  `modules` (§11's twenty, with labels) and `limits` (the eight keys with units and permitted types).
- **Features has no vocabulary at all.** There is no `FEATURE_LIST`, no feature constant of any kind,
  and `plans.service.catalogue()` returns `modules`, `limits` and `addons` — not features.
  `plan_features.feature_key` is free-form per plan. Measured, not assumed: a grep for `FEATURE` over
  `config/constants.js` returns nothing.

So the honest shape is a plan-scoped editor reached after choosing a plan, not three top-level lists.
The nav keeps the three entries because §33 names them as screens and the suite asserts §33's count of
sixteen; **the hrefs are placeholders until those screens are built**, and building them is where the
choice gets made. Recorded rather than quietly resolved, because picking one shape here would be
inventing a requirement §33 does not state.

Also worth knowing before the Reports screen is built: there is **no `GET /reports`**. There are seven
sibling paths (`/reports/students`, `/attendance`, `/fees`, `/expenses`, `/exams`, `/teachers`,
`/subscriptions`), so that screen is an index over seven endpoints rather than one list.

**The sidebar is generated, not written.** `lib/nav.ts` is a table: every row names the permission
the screen needs and, for school screens, the module key **the matching router actually mounts** —
read out of the routers rather than guessed, because a nav gating on a module the API does not check
would hide a working screen, and one gating on nothing would show a screen that 403s on load.

Two rows are deliberately irregular and say so in place. **Documents** has no single module: §20.5's
seven types span four of them, and its router mounts `requireActiveSubscription()` instead — so it is
listed with `anyModule` and appears when any of the four is subscribed. **Classes, Sections and
Subjects** carry no module at all, because their routers mount none; gating them would invent a
subscription rule the SRS does not have.

Rendered and counted in a browser as a signed-in Super Admin: **sixteen links across five sections**,
which is exactly §33's Super Admin list, with `aria-current="page"` on the one open screen. The
seventeen School items are asserted by the suite but have not been rendered — reaching them needs a
school-scoped account, and the environment has none seeded.

**The one mutation this required was reverted and verified.** Rendering an authenticated shell meant
getting past `must_change_password`, which the seeded Super Admin ships with set. Rather than change
the seeded password — the destructive-cleanup hazard that broke `verify-addons` earlier in this
session — the single boolean was toggled off, the shell measured, and the flag set back; `verify-seed`
was then re-run green to prove the seed state was intact.

**Three bugs were found by running it that reading it had missed**, and all three would have shipped:

1. **`GET /csrf-token` returns `data.token`, not `data.csrfToken`.** Every mutating call would have
   failed its double-submit check with a 403 naming CSRF that looked like a cookie problem.
2. **The refresh call sent no CSRF header.** `/auth/refresh` is a POST and `requireCsrfToken()`
   guards it; the browser log showed `POST /auth/refresh → 403`. Every expiring session would have
   been logged out instead of renewed — and only after the access token's lifetime had elapsed, long
   enough after login to look unrelated to this code.
3. **The `must_change_password` redirect was unreachable.** It was checked *after* loading the
   profile, but `enforcePasswordChange` refuses `GET /auth/me` for exactly those users. The browser
   showed `POST /auth/login → 200` then `GET /auth/me → 403`, and the form reported "You must change
   your password" as though the credentials were wrong. The seeded Super Admin ships with the flag
   set, so this was the state of the **first login on any new deployment**.

**Not yet verified:** the post-change landing. Completing that flow means changing the seeded Super
Admin's password, which would leave the environment inconsistent with `.env` if anything failed
mid-flow — the destructive-cleanup lesson from earlier this session. The redirect is proven; what
happens after the change is not.


Two backend affordances already exist for this phase and should be used rather than reinvented: the
access token's `permissions` claim is populated **for navigation only** (the server always re-reads
permissions from the database), and `GET /auth/me` returns the authoritative profile plus permissions
on page load. `/api/v1/csrf-token` is public so a reloaded page holding only a refresh cookie can
bootstrap.

---

## Phase 5 — Integrations

| # | Requirement | SRS | Status | Notes |
|---|---|---|---|---|
| 5.1 | Plugin-based payment gateway architecture | §13.2 | Completed | `src/services/paymentGatewayService.js` **is** the plugin architecture — a registry validating an adapter contract (charge + refund) at registration, dispatched from `payments.service.js`. It ships **zero adapters by design**: §13.2 says only *"the payment gateway system must be plugin-based"* and names no provider, and §35 leaves providers unspecified. `verify-billing.js` asserts the empty registry refuses with `PAYMENT_GATEWAY_NOT_CONFIGURED` (422), then registers a stub, dispatches a charge to it and unregisters it. *(The old note pointed at `src/payments/`, a path from `docs/ARCHITECTURE.md` that predates the code by two days; the registry landed in `src/services/` instead.)* Live adapters remain Phase 5.1 work |
| 5.2 | AI provider integration (Claude) for question generation | §21 | In Progress — **everything but the round trip** | `src/ai/` is a flat driver switch over `mock` (deterministic, offline) and `anthropic`. Session 26 exercised the adapter **without a live call**: `verify-ai.js` Part 1c replaces `@anthropic-ai/sdk` in `require.cache` before the lazily built client exists, so the real prompt construction, `textOf()` and `parseJson()` all run and only the HTTP hop is substituted. Asserted: the prompt carries every constraint `mcqNeedsOptionsAndAnswer` enforces on the way back; a fenced/prose-wrapped reply still parses; "no JSON" and "malformed JSON" are distinct failures; a missing key is refused by name before any network attempt; the model stamp and the difficulty default both apply. **Eight deliberate regressions, all caught.** **Still open, and not closeable here:** that Anthropic's API answers the way the stub does — that needs a real key and a real request. A stub agreeing with itself is not evidence about the service. Also untested: `extract()`'s PDF path, which calls `pdf-parse` — measured this session to fail with "Illegal character" on an untouched pdfkit document, and so the likeliest place for a first live run to break |
| 5.3 | Content extraction: PDF, Image, Syllabus | §21 | Implemented | **This row was recorded as `Pending` with an empty note; the code existed and was broken.** `ai/anthropic.js` `extract()` dispatches entirely on `mimeType` — `application/pdf` parses locally with `pdf-parse`, `/^image\/(jpeg\|png\|webp)$/` goes to the model as an image block, anything else throws. `ai.service.js` passed **`mimeType: null` hardcoded**, so neither branch could ever be taken and every PDF, image and syllabus upload threw `Cannot extract text from "<file>" (null)` before doing any work. **Extraction was structurally unreachable with the real driver**, proven by calling it with the caller’s own arguments. It survived because every suite runs `AI_DRIVER=mock` and the mock ignores both the path and the type by design — the workflow passed end to end through a driver that never looks at the argument that was wrong. **Fixed** by deriving the MIME from the filename via `UPLOAD_EXTENSION_MIME`, itself derived from the `UPLOAD_MIME_EXTENSIONS` allow-list `uploadSingle` already enforces, so no schema changed (§35) and the lookup cannot miss. `source_type` could not serve: the suite’s own fixture is a **`.pdf` whose source type is `syllabus`**, which is asserted. **PDF extraction now verified end to end** — a real `pdfkit` document extracted to its exact text, contradicting the recorded expectation that `pdf-parse` would fail on it. `verify-ai.js` gained 4 assertions (184 -> 188) spying on the driver seam, and restoring `mimeType: null` produces two named failures. **Not covered:** the image branch calls the API and needs a live key (row 5.2), so Implemented rather than Tested. |
| 5.4 | PDF generation (results, documents, reports) | §19.3, §20.5, §22 | Completed | `src/utils/pdf.js` is the table engine: a titled table with repeating headers, wrapped cells and numbered pages, returning a Buffer so no file touches disk. §22's seven reports all accept `?format=pdf`, fed by the same `toRows()` walk the Excel export uses. Result cards (FR-EXAM-005) and the seven documents (FR-DOC-001) are wired — this clause said they "still need wiring" — both are now a `?format=pdf` branch rather than infrastructure, though ID cards and certificates are not tables and will want a second shape. `verify-pdf.js` → **20 / 20** plus 8 new checks in `verify-reports.js`; ten deliberate regressions. *Previous note:* \| Blocks FR-EXAM-005, FR-DOC-001, FR-REPORT-002’s PDF half (its Excel half shipped in §2z), FR-HW-001's attachment and FR-ASG-001's submission. **Four requirements wait on this and nothing else.** Known Issues #26 — the prerequisite — was **closed in session 23**: all six caller-supplied path columns are refused from every body, and the doctrine is now written and enforced in **seven** modules. The one column still protected by `stripUnknown` rather than a refusal is `organizations.logo_path`, which has no writer either |
| 5.5 | Excel export | §22 | Completed | Shipped in §2z. `reports.service.js` `toExcel()` lazily requires exceljs and returns `writeBuffer()`; the controller sets the spreadsheet Content-Type and a dated `Content-Disposition`. All seven reports accept `?format=excel`. `verify-reports.js` asserts the bytes really are a workbook (zip magic `504b0304`, not JSON wearing a header) and reads the cells back through exceljs to match the JSON. PDF and print are refused 422 rather than downgraded. *(Row 5.4 already said "its Excel half shipped in §2z"; this row simply never got updated.)* |
| 5.6 | Email (verification, reset, notifications) | §7, §23 | Completed | **The recorded gap was stale.** The note said "§23's nine notification types are not built (3.R)"; they are — FR-NOTIF-001 is Completed, `runNotificationSweep()` covers all nine in eight passes, driven by a scheduler because the FR's actor is **System** and dispatch therefore has no route. `services/mailService.js` carries both a `log` and an `smtp` driver and delivers the two §7 mails — reset and verification — both verified end to end in `verify-auth-module.js`. Notifications reach e-mail too: `notifications.service.js:300` calls `mailService.send()`, and an `email` row is a *delivery attempt* (born `pending`, becoming `sent` or `failed`) written beside every in-app row, which `verify-notifications.js` asserts in three places — that the row exists for every recipient, that `in_app` is the default channel with e-mail rows as delivery records, and that those rows are queryable, "which is how a failure is found". **Not exercised:** a real SMTP delivery. `.env` sets `MAIL_DRIVER=log`, so the `smtp` driver is code-complete but has never spoken to a mail server; the suites assert the delivery *records*, not that a message left the machine. §35 marks additional channels unspecified, so in-app and e-mail are the whole surface. |
| 5.7 | Swagger / OpenAPI | §28 | Completed | `src/docs/` — `openapi.js` walks the mounted Express stack, `joiSchema.js` converts the Joi schemas, `routes.js` serves the UI and the JSON. helmet's CSP was left on for exactly this and the UI runs under it: no inline script, all six assets same-origin, asserted over real HTTP |
| 5.8 | Queue system + background jobs | §25 | Completed | `src/config/queue.js` is a real in-memory FIFO with retry and backoff (`enqueue`, `runNow`, `registerHandler`, `queueStats`, `waitUntilIdle`) and **now has consumers**. `src/jobs/handlers/index.js` and `src/jobs/worker.js` both exist — the row said they "do not exist" — and `app.js:242` calls `registerJobHandlers()` inside `createApp()`, so the FIFO has handlers from the moment the application is built. Four of the eight `JOB_NAMES` are registered (`send_email`, `send_notification`, `sync_usage`, `database_backup`); the rest are listed in `UNREGISTERED` with the reason each is not — `generate_report`, for instance, "renders a Buffer with no storage or serving route to complete into". §29 forbids a jobs table, so there is nowhere to persist a pending job — and `queue.js`'s own header says the answer: *"durability across restarts is provided by the cron reconciliation tasks, which re-derive any missed work from application state"*. **Those tasks now exist** (5.9), which is why the five sweeps are idempotent and marker-driven. What remains is the handlers and the worker process |
| 5.9 | Cron jobs (renewals, expiry, reminders, backup) | §27 | Completed | `src/jobs/cron.js` plus `src/jobs/tasks/` — five tasks in a documented **run order**, because `notification-dispatch` must follow `subscription-lifecycle`: §23 notifies subscriptions in state `expiring`, which the lifecycle sweep writes. `npm run cron` stays resident behind `ENABLE_CRON` (two schedulers would double-notify and race the renewals); `--once` runs everything and exits, and `--list` prints the schedule. A failing task is recorded and the run continues, and a task that never settles is failed on a ten-minute bound rather than wedging its own future ticks. Cadence is chosen here and said to be — §25 declines to invent numeric targets. `verify-jobs.js` → **57 / 57, exit 0**, fifteen deliberate regressions |
| 5.10 | Caching | §25 | Completed | `config/cache.js` (memory driver default, redis driver available) is used by `permissionService`, `tenantService` and `entitlementService`. Invalidation is verified in both directions and for narrowness — 27 checks in `verify-entitlement.js`, incl. that a snapshot stays stale until invalidated and that `invalidateSchool` does not reach a second school |

---

## Phase 6 — Testing & Validation

**The jest suite exists and passes.** `tests/setup.js`, `tests/globalSetup.js` and
`tests/verify.test.js` are all present, the `msms_test` database has been created, migrated and
seeded, and `npm test` runs the whole safety net — all **38** `scripts/verify-*.js` suites, spawned
serially and reported as named jest cases. Row 6.17 carries the detail.

This paragraph previously read *"There is no jest suite … `npm test` fails … the thirteen standalone
`scripts/verify-*.js` suites"*. Every clause of that was true when it was written and false by the end
of session 26, and it sat two hundred lines from row 6.17 saying the opposite. The suite count was
stale by a wider margin than the jest claim: **thirteen** against a measured thirty-eight.

**Fifteen rows in this table read `Tested` and now read `Completed`, and the word was the problem
rather than the work.** The legend defines `Tested` as *"implemented and covered by a passing check,
but not yet reachable in the running application — nothing mounts it"*. That distinction is
meaningful for a module, and meaningless for a **test**: nothing is supposed to mount
`verify-security.js`. Read literally the status asserted that these suites were not reachable, which
was never true and never what anyone meant.

Against the legend's own bar for `Completed` — *"the code exists **and** an executable check covers
it **and** that check passes today"* — all fifteen qualify and did when they were written. Each row's
Notes name the suite that covers it, all thirty-eight run under `npm test`, and the loop was measured
at **5,512 assertions, 0 failures, six consecutive serial runs** on 2026-09-09. Rows 6.3 and 6.4
already read `Completed` on identical evidence, which is what made the inconsistency visible.

| # | Requirement | SRS | Status | Notes |
|---|---|---|---|---|
| 6.1 | Critical school-isolation test → 403 | §8, §24 | Completed | 8 independent request shapes in `verify-auth-chain.js`; the refusal carries no `data` and does not echo the foreign id |
| 6.2 | `school_id` tampering in URL never grants access | §8 | Completed | Includes zero-padded and percent-encoded segments, and a nonexistent school id returning the same 403 rather than a 404 — no enumeration oracle |
| 6.3 | SQL injection protection test | §24 | Completed | `scripts/verify-security.js` closes the gap this row recorded. Six payloads go at **value** parameters — `q`, a path id, and a request body — where the defence is Sequelize’s binding rather than the `sortBy` allow-list that was already probed. The assertion that carries the weight is not the absence of a 500: a successful injection returns 200 too. It is that `' OR '1'='1` matches **zero** rows rather than every row, and that a value containing SQL syntax survives a database round trip character-for-character — proof it was bound, not interpolated. |
| 6.4 | XSS protection test | §24 | Completed | `scripts/verify-security.js`. **The premise this row recorded was wrong and the suite failed on it first**: the note said input is not escaped, which is true and is about *escaping* — but `sanitize.js` also **strips executable markup** (script/iframe/object/embed/style/link/base/meta/form/svg/math, `on*=` handlers, `javascript:` and `vbscript:` URIs), looping four times against reassembly. Posting `<script>alert(1)</script>` as a name returns 422 `string.empty`, because it sanitises to nothing and `min(2)` then refuses it. Asserted in **both** directions: markup stripped, and `Smith & Sons 5 < 7 Ltd` surviving intact — a sanitiser that strips too much is a data-corruption bug wearing a security badge. Plus the headers that make any survivor inert (`application/json`, `nosniff`), and the render half this repo owns: no `dangerouslySetInnerHTML`, and the one href built from API data guarded by an `^https?://` **allow-list**. |
| 6.5 | CSRF protection test | §24 | Completed | All five double-submit states, the three failure shapes confirmed indistinguishable, and the fail-closed 500 when `cookie-parser` is absent |
| 6.6 | File upload security test | §24 | Completed | 109 checks: per-surface allowlists, extension/MIME mismatch, Windows and traversal path names reduced to a bare name, 32-hex stored names, four plan ceilings, multer count refusals as 400 not 500, `cleanupUploads` |
| 6.7 | API security + rate limiting test | §24 | Completed | 38 checks incl. address canonicalisation across 11 spellings, per-user keying behind NAT, the 429 envelope and `Retry-After` |
| 6.8 | JWT security test | §24 | Completed | 15 checks in `verify-auth-chain.js` plus the refresh/rotation and `password_changed_at` sections of `verify-auth-module.js` — rotation, replay ending the session, and a token predating a password change being refused |
| 6.9 | Role + permission enforcement test | §7, §24 | Completed | 16 checks in `verify-auth-chain.js`, incl. require-time argument validation so a typo fails when the route is defined. Extended by `verify-users-roles.js` over real HTTP: the `requireAny` refusal shape (`details.requiredAnyOf`), the deny-wins precedence of a per-user override, and **both cache-invalidation directions with a 600-second TTL** — a role edit bites on the next request against an unchanged token, and an override bites with no cache call at all. Also the escalation ceiling: `users.manage` cannot grant a key the caller does not hold. `verify-plans.js` adds a fourth angle — that the five `plans.*` keys are five **distinct** keys, pinned by denying one at a time on the Super Admin fixture and confirming the sibling route still answers 200 (denying `plans.pricing.manage` breaks `PUT /:id/prices` and leaves `PUT /:id/limits` working). That technique only works because `buildPermissionGuard` has **no super_admin bypass** — it reads `req.getPermissions()`, so the platform's own account is subject to the same grant table as everyone else, and each 403 body's `details.missing` names the denied key |
| 6.10 | Subscription lifecycle / proration test | §12 | Completed | `verify-subscriptions.js`, **208 checks**. **Now also:** `verify-billing.js` Part 5 issues an invoice from a live subscription's items (1000 + 10% tax → coupon → 990 paid → refunded). Proration-vs-invoice reconciliation of `subscription_history.amount_due` is still not asserted |
| 6.11 | Limit enforcement + overage test | §11 | Completed | All four measurement kinds, overage recorded and priced, per-request limits writing no usage row, negative deltas clamped in the database |
| 6.12 | Exam calculation + position test | §19 | Completed | Covered by `verify-exams.js` (219 checks) — grade bands, percentage, grade points, outcome, and **position**, including §19's rule that a rank is assigned only to students who sat every counted paper. `verify-reports.js` additionally asserts §22 aggregates the *stored* result columns rather than recomputing a rank |
| 6.13 | Timetable conflict test | §20.1 | Completed | Covered by `verify-timetable.js` (115 checks) — teacher double-booking, room clash and period overlap are each provoked and refused |
| 6.14 | Fee partial payment / pending balance test | §17 | Completed | Covered by `verify-fees.js`, over real HTTP: a 300 payment against a 950 fee leaves 650 pending and `partially_paid`; a second payment of 650 settles it and stamps `paid_at`; an overpayment settles the fee and clamps the balance at zero rather than going negative; and deleting a payment behind the API proves the balance is a **SUM** rather than a running total. Float drift is asserted both offline (`netOf(0.1, 0, 0.2) === 0.3`) and end-to-end. **The concurrency gap this row recorded is now closed**: `fees.service.js:513-517` reads the row with `lock: transaction.LOCK.UPDATE`, and that was argued from the SQL rather than exercised. Two payments of 120 and 180 now go out inside one `Promise.all` — both in flight before either resolves — and the assertion is **arithmetic, not status**, because a lost update is silent: `paid_amount` must read **300**, reachable only if the second transaction waited and re-summed. Two receipts are on file, since the lock serialises rather than drops. Removing the `lock` line produces four named failures — `[201,500]`, `paid_amount 120`, `pending 830`, `1 receipt`. **Not covered:** no jest test (row 6.17) |
| 6.15 | Pagination + performance (indexes, caching) test | §25 | Completed | The pagination *query contract* is in `verify-validate.js`, caching in `verify-entitlement.js`, and the `meta.pagination` envelope in `verify-platform-modules.js` (six keys, `total` counting every match rather than the page, `hasNextPage`/`hasPreviousPage` either side of a two-page split, a second page returning a *different* row, `sortOrder` flipping the first row, a page past the end returning `[]` rather than 404, and an over-`MAX_LIMIT` request refused at 422 rather than silently clamped). **The measurement gap this row recorded is now closed** by `scripts/verify-performance.js` — 14 assertions, seven deliberate regressions, all caught. **No timing assertion, deliberately**: §25 sets no numeric target, and "under 50 ms" would measure this machine on this afternoon and fail on a slower one for a reason nobody could act on. Structural instead — all **50** tables carrying `school_id` have a `school_id`-**leading** index (leading, because MySQL reads a composite left to right, so `(status, school_id)` cannot serve a filter on `school_id` alone), and the cache is measured by **counting queries** rather than by the clock. **Two mistakes worth keeping**: the draft listed six table names as string literals and one, `student_attendances`, does not exist — the table is `student_attendance` — so the sweep now derives every name from `getTableName()` and covers all fifty, and widening it from six to fifty immediately found what the hand-picked six had missed; that find, `school_settings`, then proved the *assertion* wrong rather than the schema, because a table with a UNIQUE `school_id` index is const-resolved by MySQL and reports a null `possible_keys` — the best outcome, indistinguishable in that one field from the worst. The assertion now targets `type: 'ALL'` **with no index offered at all**. **Not covered:** no jest test (row 6.17) |
| 6.16 | Database operations end-to-end against MySQL | §29 | Completed | A 15-point behavioural check (FK cycle insert, JSON round-trip, secret-column scopes, ENUM rejection, `DECIMAL(14,2)` money, soft delete, cascade), plus every database-touching suite. Strict `sql_mode` is pinned on every pooled connection — without it MariaDB silently coerced invalid ENUM values to `''` |
| 6.17 | Fold the `verify-*.js` scripts into a jest suite | §24 | Completed | **Done. `npm test` runs 5,453 jest tests, 0 failures, exit 0** — 5,253 assertions from all 38 suites, each a named test case, plus 196 suite-level and integrity tests. **What this is, precisely: jest reports the suites, it does not execute them.** All 5,253 assertions run in 38 child processes inside `globalSetup`, which finishes before jest evaluates its first test file; each jest case is a re-print of a result decided minutes earlier, so `-t` cannot narrow the work and `testTimeout` governs a string comparison. It is a **wrapper**, chosen because `require()` is impossible without rewriting all 38 files (every one calls `process.exit()` with no `require.main` guard). The value delivered is not jest execution — it is the exact per-suite assertion baseline, the degradation detection and the database guard, none of which existed before. `tests/globalSetup.js` runs the suites serially as **child processes**: every script calls `process.exit()` and none guards on `require.main`, so an in-process harness would be killed by the first suite and exit with *its* code. `tests/verify.test.js` reads the results synchronously at module scope, because jest builds its test tree by executing the module body and a `test()` registered from a callback is never collected. **Investigating this found two defects bigger than the fold** — Known Issues 28 and 29. (28) Nineteen suites exit **0** while skipping most of their assertions when the database is unreachable: measured, **3,143 of 5,112 vanish** and nothing noticed, because exit code and FAIL count both look right. (29) `NODE_ENV=test` disables the rate limiter, CSRF and the access log, so the obvious jest configuration would verify a **different application** — `verify-app.js` fails 11 assertions under it; the harness therefore runs the shipped composition against `msms_test`. Each suite is judged on four signals that must agree — exit code, FAIL count, degradation markers, and an **exact** assertion count from `tests/baseline.json` (exact, not a floor: a floor passes a suite that grew to 200 and silently fell back to 168). Discovery is a glob with an asserted manifest, so the `verify-school-setup.js` unnoticed-file failure cannot recur. Seven deliberate regressions, all caught. `--forceExit` removed; jest exits cleanly. **Not covered:** the suites still degrade silently when run directly rather than through `npm test` — fixing that at source is a 19-file change, deliberately not bundled here |

Each suite creates its own fixtures under a recognisable code prefix and a non-routable email domain
(`VERIFY-` / `.invalid` for the earlier suites, `VPM-` / `@verify-platform.local` for the §9 one,
`VUR-` / `@verify-users.local` for the users/roles one, `VPL-` / `@verify-plans.local` for the plans
one, `VSB-` / `@verify-subs.local` for the subscriptions one) and
removes them in a `finally` block; teardown has been confirmed directly against the database after
every run. The §9 suite deletes schools with `force: true` so the soft-deleted row from its own DELETE
test also goes, and the plans and subscriptions suites do the same for their plans, since
`subscription_plans` is paranoid. **Four suites mutate seeded data** — the users/roles one changes the
`principal` role's grants and the `librarian` role's labels, the plans one grants the `principal` role
`plans.view` to prove the school-scoped read path, the add-ons one edits all seven add-ons, and the
subscriptions one raises `extra_students.units_per_quantity` from 1 to 50 so a purchase that stored the
quantity instead of the computed grant would fail. Every mutation is restored unconditionally in a
`finally` and the restore is then asserted, so an abort mid-run cannot leave a broken role or add-on
behind. The subscriptions suite also creates three `addon_prices` rows, which are not seeded at all and
so are its alone to remove. Directly measured after the last run: `subscriptions 0`,
`subscription_addons 0`, `subscription_overrides 0`, `subscription_history 0`, `addon_prices 0`,
`addons 7` all with `units_per_quantity = 1`, `roles 11`, `permissions 109`, `role_permissions 353`,
`principal` grants back at 63, and no `%verify%` users left. They currently
wrote to the **development** database, because `NODE_ENV=test` resolved
`DB_NAME` to `msms_test`, which did not exist. **Both halves are now false:** `msms_test` was
created, migrated and seeded in session 26, and the harness runs every suite against it — proving the
target with `SELECT DATABASE()` before it starts.

---

## Cross-cutting SRS requirements (§24–§28)

**The SRS defines 90 functional requirements. This document tracked 79 of them by name.** The eleven
below are cross-cutting — they describe properties of the whole application rather than a module — and
were covered only implicitly, by numbered Phase 5/6/7 rows that never cite them. A reader counting
`FR-` rows would conclude the SRS had 79 requirements. Added in session 26 from a reconciliation of
`docs/SRS-extracted.md` against this file; the cause of the original omission is unknown.

| ID | Requirement | SRS | Status | Evidence |
|---|---|---|---|---|
| FR-SEC-001 | Authentication & Authorization Enforcement | §24 | Completed | `middlewares/authenticate.js` + `authorize.js`, the four-step chain mounted in `app.js` before every module router. `verify-auth-chain.js` → 84 checks; every module suite asserts its own permission refusals |
| FR-SEC-002 | School Isolation Testing | §24 | Completed | `resolveTenant`/`enforceTenant` plus `tenantWhere()` in every service. Each module suite plants a second school and asserts it is unreachable; `createRouter()` installs the `router.param` guard that refuses a cross-tenant id before the record is looked for |
| FR-SEC-003 | Injection & Cross-Site Protection Testing | §24 | Completed | `scripts/verify-security.js` — 27 assertions over real HTTP, six deliberate regressions all caught. **Two of those regressions initially went unnoticed and both were the test’s fault**: the canonical `<scr<script>ipt>` payload leaves the inert `<scr` after one pass, so it passed with the anti-reassembly loop cut from four passes to one — replaced by `<scri<script>pt>…</scri<script>pt>`, which does reassemble into a live tag; and the href guard check matched a `.replace()` elsewhere in the same file, so it stayed green when the guard became a denylist. Rows 6.3 and 6.4 carry the detail. |
| FR-SEC-004 | File Upload Security | §24 | Completed | `middlewares/upload.js` — a four-MIME allowlist, random hex filenames so nothing caller-supplied reaches the filesystem, per-school directories, and `FILE_UPLOAD_LIMIT` enforced. Known Issues #26 closed the six columns that accepted a caller-supplied path. `utils/fileResponse.js` re-validates on the way back out |
| FR-SEC-005 | API Security & Rate Limiting | §24 | Completed | `middlewares/rateLimit.js` — `apiLimiter` before authentication so an unauthenticated flood is bounded, `authLimiter` on the five public auth endpoints. `helmet`, `cors`, `hpp` and a 1 kb JSON body limit are pinned by `verify-app.js` |
| FR-SEC-006 | JWT Security | §24 | Completed | `utils/tokens.js` — signed access/refresh pair, refresh-token hash stored and rotated, reuse detected and the session ended. `verify-auth-module.js` asserts `TOKEN_INVALID`, `TOKEN_WRONG_TYPE`, `REFRESH_TOKEN_REUSED` and `SESSION_ENDED` as distinct outcomes |
| FR-PERF-001 | Performance Optimization Implementation | §25 | Completed | Indexes declared on every model; `utils/pagination.js` on every list endpoint; entitlement caching with a TTL; background jobs and the queue system — four of the eight `JOB_NAMES` registered by `registerAll()`, called from `createApp()`, with the unregistered four each carrying its reason in `handlers/index.js` — (§2ab, §2ad). §25 states no numeric targets and none is invented |
| FR-BKP-001 | Database Backup & Retention | §26 | Completed | `src/jobs/tasks/databaseBackup.js` — real `mysqldump`, `BACKUP_RETENTION_DAYS` pruning by mtime, a part-written dump deleted rather than kept. `verify-jobs.js` asserts the dump contains all 64 model tables plus `sequelize_meta` |
| FR-LOG-001 | Error & Activity Logging | §26 | Completed | `config/logger.js` (winston, daily rotation, separate error log) and `middlewares/activityLog.js` (`activity_logs` + `audit_logs`, written on `res.on('finish')` so a logging failure cannot turn a save into a 500) |
| FR-DEPLOY-001 | Production Environment Setup | §27 | Completed | `deploy/` — six artifacts, 5,332 lines, verified by `scripts/verify-deploy.js` (58 assertions, 21 deliberate regressions all caught). Nginx reverse proxy + TLS + ACME renewal, the PM2 ecosystem (two apps: API and cron; the worker is deliberately unmanaged because it runs one job and exits), MySQL production config, the production env template covering every key `env.js` reads, logrotate for the PM2 logs only, and a monitoring runbook built from the health endpoints, PM2 and the log files — nothing off §27's list. **Complete as configuration, never executed:** nginx, pm2, mysql and logrotate are all absent from this machine, so no file was validated by its own tool. The suite checks agreement with the application instead. |
| FR-APIDOC-001 | Swagger / OpenAPI Documentation | §28 | Completed | `src/docs/` — `GET /docs` (Swagger UI) and `GET /docs/openapi.json`, both above the authentication boundary. The document is **generated from the mounted Express stack**: six of §28's seven fields are read from the routes, the guards and the Joi schemas that enforce them, so it cannot drift. The seventh — the shape of a success payload — has no machine-readable source, and the document says so rather than guessing. 195 paths, 266 operations. `verify-openapi.js` → 101 checks, 17 deliberate regressions all caught **Corrected in the §36 final pass:** the generated document described the success envelope’s `meta` as a **flat** object of four keys; `ApiResponse.paginated()` has always nested under `meta.pagination` and emitted **six**, adding `hasNextPage`/`hasPreviousPage`. A client trusting it would have read `meta.totalPages` as `undefined` and built a broken pager — the exact bug this project’s own frontend had. 101 of the suite’s assertions checked the document is well-formed and that its guards match the routers; **none checked that a shape it describes is one the application emits**. `verify-openapi.js` now captures a real `paginated()` envelope and compares its keys to the document’s, neither side a literal (101 -> 104). |

## Phase 7 — Deployment, Docs & Final Review

**`deploy/` exists** — six artifacts, 5,312 lines, written in session 26 and verified by
`scripts/verify-deploy.js` (58 assertions). **Nothing in it has been executed**: nginx, pm2,
mysql and logrotate are all absent from this machine, so no file was validated by the tool that
will consume it. What the suite checks instead is that each config **agrees with the application**
— the proxy port against `config.app.port`, the body caps against `MAX_UPLOAD_MB`, PM2's
`kill_timeout` against `server.js`'s real shutdown budget, the env template against every key
`env.js` reads. The one file that can be executed, `ecosystem.config.js`, is `require()`d.

| # | Requirement | SRS | Status | Notes |
|---|---|---|---|---|
| 7.1 | Node.js production config | §27 | Completed | `NODE_ENV=production` already changes real behaviour: destructive CLI commands refuse to run, the seeder hard-refuses the example Super Admin password, and cookies become `secure` |
| 7.2 | MySQL production config | §27 | Completed | `deploy/mysql/production.cnf` (1,049 lines). Character set and collation match what the migrations create; `max_connections` is sized against `database.js`'s pool plus the cron process and backups; the InnoDB and locking settings are checked against `databaseBackup.js`'s actual `mysqldump` flags (`--single-transaction --routines --triggers`). **Found while writing it:** those flags need the **global** `PROCESS` privilege on MySQL 8.0.21+, which cannot be granted database-scoped — a backup user granted only `ON msms.*` would fail the backup this same config schedules. |
| 7.3 | Nginx reverse proxy | §27 | Completed | `TRUST_PROXY` is parsed and wired (`app.set('trust proxy', …)`) so the rate limiter keys on the real address once a proxy is in front |
| 7.4 | SSL + domain | §27 | Completed | In `deploy/nginx/msms.conf`: TLS 1.2/1.3, the :80 → :443 redirect, HSTS reconciled against what helmet already emits in-process, and a reachable `.well-known/acme-challenge` location — without which renewal fails silently sixty days later. The domain itself is a placeholder an operator substitutes; certificate issuance is an operator step (certbot), not tooling built here. |
| 7.5 | Environment variables | §27 | Completed | The mechanism was already done and verified: `.env.example` documents 73 keys, `env.js` types them and asserts the required ones. What was missing was the **production** half, and it shipped in §2ag: `deploy/env/production.env.example` covers every key `env.js` actually reads (verified both directions — nothing missing, nothing invented), marks each secret as must-be-generated with no usable value committed, and calls out every setting whose production value must differ from the development default. |
| 7.6 | PM2 process management | §27 | Completed | `server.js`'s graceful shutdown is verified — HTTP server closed, then the pool, then exit 0 |
| 7.7 | Cron jobs | §27 | Completed | See 5.9 — `npm run cron`, gated by `ENABLE_CRON` |
| 7.8 | Queue workers | §27 | Completed | See 5.8. `npm run worker` runs one job on demand. A *resident* worker consuming the API's queue is **not possible** with an in-memory queue and no jobs table (§29/§35) — `worker.js` records that rather than shipping a process that idles looking healthy, and `queue.js`'s own answer is that the §2ab cron tasks carry the durability |
| 7.9 | Database backup + retention | §26, §27 | Completed | `src/jobs/tasks/databaseBackup.js` (`npm run db:backup`, and scheduled daily by 5.9). Real `mysqldump` — writing a dump from Sequelize would mean reimplementing dependency ordering and DDL, and getting it wrong yields a file that looks like a backup and is not. `BACKUP_DIR`, `BACKUP_RETENTION_DAYS` (30) and `MYSQLDUMP_PATH` had been declared in `config/env.js` since it was written and used by nothing. Retention prunes only files this task names, judged by mtime, and a part-written dump is deleted rather than kept. The suite asserts the dump is restorable: all 64 model tables appear as `CREATE TABLE`, plus `sequelize_meta` — the migration ledger, not a 65th table |
| 7.10 | Logging (error + activity) | §26, §27 | Completed | The application half was already done and verified: winston with daily rotation, a separate error log, morgan piped into it, and the `activity_logs` / `audit_logs` trails. The **operating-system** half shipped in §2ag: `deploy/logrotate/msms` rotates PM2’s stdout/stderr capture and deliberately does **not** touch winston’s own dated files — winston already rotates and prunes those, and two rotators on one file is how log lines vanish. |
| 7.11 | Monitoring | §27 (**not** §26) | Completed | **This row cited a section that does not contain the requirement, and its note was false about the repository.** It read *"No monitoring is attached to them, which is the requirement this row is named for."* **(a) §26 imposes no monitoring obligation at all.** Its heading is "Backup, Logging & Monitoring", but its body is four items — Database Backup, Backup Retention, Error Logs, Activity Logs (SRS:1323-1326) — and its two FRs are FR-BKP-001 and FR-LOG-001, both `Completed`. `grep -in monitor` over the 1,698 lines returns **four** hits and the §26 one is the heading. **(b) §27's requirement is a deployment artifact, not a running process.** :1358 is the bare word "- Monitoring" and FR-DEPLOY-001:1374 is *"Database Backup, Logging, and Monitoring are **configured** for production"* — the same grammar as :1369 nginx, :1370 SSL, :1371 environment variables and :1373 cron/queue workers, every one of which is `Completed` here on the strength of a `deploy/` file. **(c) Probes are attached, and asserted.** `deploy/monitoring/README.md` is 863 lines whose crontab block hits **both** health endpoints every minute — :689 liveness, :690 readiness capturing the response body — plus the public chain through DNS/TLS/nginx, a cron heartbeat read out of the combined log, an error-log delta against a state file, backup freshness, disk and TLS expiry. Every literal is cross-referenced to the application rather than guessed: the port is `config.app.port`, the backup glob matches `databaseBackup.js` `filenameFor()`, the log names match `logger.js`, and the heartbeat greps the exact string `cron.js:166` logs. `verify-deploy.js` part 5 asserts six things about it, including that it probes the endpoints the app actually serves and names none it does not. **What is NOT claimed:** no monitor runs inside this repository, and none is asked for — §27 gives one word and :1359 forbids introducing a technology beyond its list, so every threshold, interval, channel and recipient would be invented. The runbook says so in its own voice: *"Every threshold in this document — 1800 s, 93600 s, 85%, 14 days — is a choice, not a measurement."* Holding this row to "a monitor is running" while rows 7.2–7.6 pass on unexecuted config files applied a standard to one row and not its siblings. Original note: `GET /api/v1/health` and `/health/ready` exist and are verified — readiness returns 503 when the database is down rather than throwing. Recorded `Completed` until the §36 pass, against its own note and against the legend’s definition of `In Progress` — "part of the requirement is done; the Notes column says which part, and which part is not". The probes are the part that is done. |
| 7.12 | Swagger/OpenAPI docs (endpoint, method, auth, params, body, response, error) | §28 | Completed | All seven fields. Six are generated from the routes and Joi schemas that enforce them; the seventh, the shape of a success payload, has no machine-readable source and the document states that rather than guessing. See 5.7 and [FR-APIDOC-001](#cross-cutting-srs-requirements-2428) |
| 7.13 | Re-read SRS and verify every requirement | §36 | In Progress | **The pass has been run.** Nine read-only agents took §1–§37 a slice at a time, checking **367 requirements** against the code *and* against this file’s own claims: 173 verified clean, **70 findings**, recorded in `docs/SRS-FINAL-PASS-FINDINGS.md`. **The four high-severity findings are resolved** — FR-FEE-002 (the fee ledger showed neither payments made nor the pending balance; column labelled "Owed" was bound to `net_amount`), FR-FIN-002 (Net Balance computed but displayed nowhere — `net_balance` appeared nowhere in `frontend/src`, deferred to a school Reports screen §33 does not list), FR-NOTIF-001 (four of nine notification types stopped permanently past 500 rows because the LIMIT was spent on already-notified rows), and one that had already been fixed before it was reported. Each was verified by hand first — a fifth finding claiming the §2 assertion table sums to 5,060 was **false**; it sums to 5,133. **Triage complete: all 70 verified**, verdicts in `docs/SRS-TRIAGE-VERDICTS.md` — **44 real-fixable, 11 real-blocked, 1 already-fixed, 5 refused**, plus the 9 resolved earlier. `real-blocked` means the defect is real but the fix needs a decision the SRS does not supply; eleven land there, which is the honest end state for a source that names capabilities without specifying them. **Fixed so far from the triage:** the §29 schema guard was documented as running at boot and had exactly one caller, an opt-in developer script — `npm start` bound its port with the guard never run; three quotations attributed to the SRS ("Database Migrations", "Run migrations", "Seed initial data") appear **nowhere** in it — "seed" occurs zero times in 1,698 lines — and were the stated authority for the one table outside §29’s sixty-four; `settings.platform.manage` **does** exist in the fixed 109, contradicting a claim this file, the nav and the Settings screen all made, with the screen rendering it to the user and the nav borrowing `schools.view`, which `organization_admin` also holds; the catalogue has **22** permission groups, not the 24 recorded; and two preambles still said "There is no jest suite" and "the thirteen standalone suites" two hundred lines from row 6.17 saying the opposite. **Applied since:** the two screens that broke on contact (Fees ledger’s off-enum "Overdue" filter, Finance’s free-text Category box against a two-value enum — both returned 422 and replaced the table with a validation error); the checklist’s per-suite table, stale at **30 suites / 4,613** against a measured **38 / 5,146** and now regenerated from `tests/baseline.json`; and ten further stale suite citations. **Two verdicts were overturned on inspection** — student Documents and admission-without-a-class are real gaps but `real-blocked`, not fixable: the first needs a document type and a permission the source never supplies, the second is answered two ways by §15.1 and FR-STUDENT-001. **Thirteen findings now sit in `real-blocked`** — where the SRS lists a capability without specifying it, a "fix" is a specification decision wearing implementation clothes. The remaining real-fixable findings are documentation-accuracy items with no runtime consequence. The row also cannot close while Phase 5 is open — 5.2’s live provider round trip needs an API key this environment does not have. **Its output now exists:** [`docs/VERIFICATION.md`](VERIFICATION.md), written 2026-09-09, records what was measured and on what date, and names the four things that have never been executed. Writing it surfaced one item no queue in this repository had sized — **142 write routes are mounted and 43 have a frontend caller; 99 do not** — which is now the largest single piece of outstanding frontend work and is recorded there in full, including why the UI audit register (which closed nine such findings) could not have found it: that register audited screens that exist. **What is left on this row is not engineering:** a key for 5.2, and a decision on each of the 13 `real-blocked` findings. |
| 7.14 | Create Git commit — §32 Working Method step 8 | §32 | Completed | **This was previously filed alongside the missing ESLint config under "neither is an SRS requirement", and for this half that reason was false.** SRS:1571 reads "8. Create Git commit.", inside a list SRS:1563 introduces as "The exact daily development workflow specified in the source" — SRS text, not project convention. `test -d .git` fails; there is a `.gitignore` and no repository. This file already treats the same section as binding four hundred lines earlier, at row 3.A, where §32 step 2 decides the ORM; a project that lets step 2 pick its ORM cannot classify step 8 as not-a-requirement. The consequence is already visible in this document — provenance for a module cannot be attributed because there is no history, and the standing rule that doc drift be dated from file mtimes exists only because of this absence. The remedy is what the step says: `git init` and commits. Known Issue 12.
**Done on 2026-09-09.** `git init`, then one commit of **397 files** on `master`. The ignore rules
were audited before committing rather than after: `backend/.env` and `frontend/.env.local` both exist
on disk, both are matched by the root `.gitignore`, and `git log --all --name-only` confirms neither
is in history. The two `*.env.example` files are committed deliberately (`!.env.example`) and carry
placeholders or empty values only — checked line by line for `SECRET`, `PASSWORD`, `API_KEY` and
`TOKEN` assignments. `SuperAdmin@123` appears in `backend/.env.example` because that is the documented
example value the seeder hard-refuses under `NODE_ENV=production`; the *real* `.env` still using it is
Known Issue 11 and is not committed. Working tree clean afterwards. |

Also outstanding and **not** an SRS requirement: `npm run lint` fails (no ESLint config exists, though `eslint ^8.57.1` is installed and several files already carry `eslint-disable` comments). The word "eslint" appears nowhere in the SRS.

Final verification record: [`docs/VERIFICATION.md`](VERIFICATION.md) — **written 2026-09-09.** It is
7.13's output and could not exist before the final pass had been run; the pass is recorded there with
what was measured, on what date, and what has never been executed. A previous revision linked to it
before it existed, which is why the link is dated here.
