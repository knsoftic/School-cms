# Architecture — Multi-School Management System

Derived from SRS §3 (Technology Stack), §4 (System Architecture), §8 (Multi-Tenant), §29 (Database),
§30 (Non-Negotiable Development Rules).

---

## 1. Repository layout

```
School Managment System/
├── SRS_Multi-School-Management-System.docx   source of truth
├── docs/                                     checklist, architecture, verification, API notes
├── backend/                                  Node.js + Express.js REST API
└── frontend/                                 Next.js + Tailwind responsive dashboard
```

SRS §3 requires backend and frontend to "remain clearly separated during development" — they are two
independent npm packages with no shared build, communicating only over `/api/v1` HTTP (§30 Rule 3).

---

## 2. Backend layers

Request flow, outermost first:

```
Nginx  →  Express app
            ├─ requestContext                    request id, first  (§26 Logging)
            ├─ morgan → winston.info              access log        (§26 Logging)
            ├─ helmet · cors · compression        transport
            ├─ json + urlencoded parsers          body must exist before it can be cleaned
            ├─ cookieParser                       csrf.js fails closed without it
            ├─ hpp · sanitizeRequest             (§24 Input Validation)
            ├─ apiLimiter                        (§24 Rate Limiting)
            ├─ activityAudit()                    installs the res.finish writer  (§26)
            ├─ /api/v1 router                    (§4 API versioning)
            │    ├─ system routes        health · health/ready · meta · csrf-token — public
            │    ├─ authenticate         JWT verify + account status   (FR-AUTH-001/007)
            │    ├─ enforcePasswordChange forced change, allow-listing the paths that clear it (no FR — see app.js)
            │    ├─ resolveTenant        derives organization_id / school_id from the token
            │    ├─ enforceTenant        rejects any mismatching :schoolId / body / query  (FR-TENANT-003)
            │    ├─ requireRole(...)     role-based access control     (FR-AUTH-008)
            │    ├─ requirePermission()  permission-based access ctrl   (FR-AUTH-009)
            │    ├─ requireModule(...)   subscription module gating     (FR-SUB-007, §30 R1)
            │    ├─ enforceLimit(...)    subscription limit gating      (FR-SUB-008)
            │    ├─ validate(schema)     Joi request validation         (Working Method step 4)
            │    └─ controller → service → model
            ├─ notFoundHandler                    an unmatched path becomes an ApiError, not HTML
            └─ errorHandler                       ApiError → JSON envelope + error log
```

The first nine steps are mounted by `createApp()` in `src/app.js`, in that order, and the order is
asserted layer by layer by `scripts/verify-app.js` — the reason each step sits where it does is in
that file's header. Everything from `authenticate` down is inside the `/api/v1` router; the first four
of those are mounted once at the boundary in `buildApiRouter()`, so a feature module is authenticated
and tenant-scoped by construction rather than by remembering to be. The rest are per-route.

### Directory map

| Path | Responsibility |
|---|---|
| `src/config` | env loading + validation, Sequelize connection, constants (all SRS enumerations), logger, cache, queue |
| `src/models` | 64 Sequelize models — exactly the tables named in SRS §29, plus associations |
| `src/database/migrations` | versioned migrations, tracked in `sequelize_meta` |
| `src/database/seeders` | roles, permissions, role_permissions, super admin, add-ons |
| `src/middlewares` | auth, tenant, rbac, pbac, subscription gating, validation, upload, rate limit, error, csrf |
| `src/modules/<name>` | one folder per feature: `*.routes.js`, `*.controller.js`, `*.service.js`, `*.validation.js` |
| `src/services` | cross-module domain services shared by the modules: permissions, tenancy, entitlement, usage |
| `src/payments` | plugin-based gateway registry (§13.2) + built-in providers |
| `src/ai` | provider-agnostic AI client, content extraction, MCQ generation pipeline (§21) |
| `src/jobs` | queue worker definitions + cron schedules (§25, §27) |
| `src/utils` | ApiError, ApiResponse, pagination, pdf, excel, mailer, crypto, dates, money |
| `src/docs` | Swagger/OpenAPI definition + per-module JSDoc annotations (§28) |
| `tests` | Jest + Supertest integration tests including the critical isolation scenario |

---

## 3. Multi-tenancy model (§2.4, §8, §30 Rule 2)

Three concentric scopes:

```
platform  (Super Admin)          no organization_id, no school_id
   └── organization              organization_id
         └── school              organization_id + school_id
               └── school users  organization_id + school_id
```

Enforcement is **defence in depth** — four independent layers, so a bug in one does not open a hole:

1. **Schema** — every school-scoped table carries `school_id`; tables that must be resolvable
   organization-wide additionally carry `organization_id` (SRS §2.4: "Where required").
2. **`resolveTenant` middleware** — reads the tenant context from the verified JWT *only*. Client-supplied
   `school_id` is never trusted as the source of scope.
3. **`enforceTenant` middleware** — if the request carries a `schoolId`/`organizationId` in params, query or
   body and it does not equal the token's scope, respond **403 Forbidden** (FR-TENANT-003, §24 test case).
4. **Sequelize scoping helper** — `tenantWhere(req, extra)` injects `school_id` into every query built by
   services, so an omitted `where` clause cannot leak rows.

Super Admin bypasses scoping by role, and only for platform-level endpoints.

---

## 4. Subscription engine (§10–§12, §30 Rule 1)

Nothing keys off a plan *name*. The resolution chain for "can this school do X?" is:

```
subscription_overrides   (per-school feature override / custom limit)   highest precedence
        ↓ falls through to
subscription_addons      (purchased add-on quantity, e.g. Extra Students)
        ↓ falls through to
plan_modules / plan_features / plan_limits  (the subscribed plan's configuration)
        ↓ falls through to
deny
```

`SubscriptionAccessService` returns a cached, per-school **entitlement snapshot**:

```js
{
  state: 'active',                       // one of the 10 SRS lifecycle states
  modules: { students: true, ai: true, hostel: false, ... },   // the 20 SRS modules
  features: { 'reports.premium': true, ... },
  limits:   { student_limit: { type: 'fixed', value: 500 },     // Fixed | Unlimited
              ai_limit:      { type: 'unlimited' }, ... },
  usage:    { student_limit: 132, ai_limit: 750, ... }          // from usage_records
}
```

`requireModule('ai')` and `enforceLimit('ai_limit')` read that snapshot. Adding a plan never requires a code
change — the check is always "look up the configuration in the database".

---

## 5. Payment gateway plugin architecture (§13.2)

```
src/payments/
├── PaymentGatewayRegistry.js     register() / get() / list()
├── BaseGateway.js                contract: createCharge, verifyWebhook, refund, describe
└── providers/
    ├── CashGateway.js
    ├── BankTransferGateway.js
    ├── ManualPaymentGateway.js   txn id + screenshot → Pending → Super Admin approve/reject
    ├── WalletGateway.js
    └── OnlineGatewayTemplate.js  drop-in template for any online provider
```

The SRS names the five *methods* but **no specific online provider** (§35: "Additional payment gateways" is
explicitly out of scope). `OnlineGatewayTemplate` therefore implements the contract and is registered under a
configurable key, so a real provider is added by dropping in a file — no core change.

---

## 6. Data-access & performance (§25)

* **Indexes** — declared on every foreign key, every `school_id`, and on the hot filters
  (attendance by date, invoices by status/due date, marks by exam/student).
* **Pagination** — a single `paginate()` helper; every list endpoint uses it. Default 25, max 100.
* **Caching** — `src/config/cache.js` provides a namespaced TTL cache with an in-memory driver by default and
  a Redis driver when `REDIS_URL` is set. Entitlement snapshots and dashboard aggregates are cached and
  invalidated on write.
* **Background jobs / queue** — `src/config/queue.js` exposes `enqueue(job, payload)`. Heavy reports, PDF
  batches, emails, and notification fan-out run there rather than in the request.
* **Query optimization** — aggregate dashboard metrics are computed with grouped SQL, not N+1 loops.

No numeric targets are asserted anywhere: SRS §25 explicitly leaves them unspecified.

---

## 7. Security (§7, §24)

| Control | Implementation |
|---|---|
| Authentication | JWT access token (short-lived) + refresh token (rotated, hashed at rest) |
| Password hashing | bcrypt, cost from `BCRYPT_ROUNDS` |
| Authorization | role middleware + permission middleware, backed by `roles`/`permissions`/`role_permissions` |
| School isolation | four layers, §3 above |
| SQL injection | Sequelize parameter binding everywhere; zero string-concatenated SQL; identifier allow-lists for sort columns |
| XSS | `helmet` CSP, output escaped by React, recursive input sanitiser on body/query/params |
| CSRF | double-submit cookie token required on cookie-authenticated state-changing requests |
| File upload | per-surface extension + declared-MIME allow-list cross-checked against each other, size cap from the plan's File Upload Limit, randomised stored filenames, per-school directories. **No magic-byte sniffing** — the declared type must match the extension it carries, which defeats the renamed-payload case without an extra dependency; noted as a known limitation in `upload.js`. Nothing serves uploads back yet |
| API security | helmet, CORS allow-list, `hpp`, body size caps, request ids |
| Rate limiting | global limiter + stricter limiter on auth and AI endpoints; per-school API Limit from the plan |
| JWT security | separate access/refresh secrets, `iss`/`aud` claims, `jti`, algorithm pinned to HS256, refresh reuse detection |

---

## 8. Frontend (§3, §33)

Next.js App Router, Tailwind, one route group per audience:

```
frontend/src/app/
├── (auth)/login · forgot-password · reset-password · verify-email
├── (platform)/super-admin/…    16 screens from SRS §33 "Super Admin"
├── (school)/school/…           17 screens from SRS §33 "School"
├── (teacher)/teacher/…         teacher dashboard + teaching workflows
├── (parent)/parent/…           parent dashboard, children
└── (student)/student/…         student's own records
```

* `AuthProvider` holds the session; access token in memory, refresh via httpOnly cookie.
* `EntitlementProvider` reads the school's entitlement snapshot and hides/disables gated modules —
  the nav is generated from the snapshot, so no plan name ever appears in the UI code (§30 Rule 1).
  **It does not fetch it.** The snapshot rides on `GET /auth/me` beside the permissions
  (`auth.service.js` `callerEntitlements()`), added in session 26 because no endpoint returned it
  for the current caller and row 4.10 could not be built without one. Three reasons it lives
  there rather than on a route of its own: the nav cannot render until permissions *and* modules
  are both known, so two calls would mean a flash of the wrong menu; they expire together, so
  they cannot drift; and a separate route would need a permission to guard it, which §29/§35's
  fixed 109-entry catalogue does not contain. It is `null` for a platform or organization
  caller — not `{}`, which a client would read as "every module is off".
* A shared `apiClient` handles the envelope, 401 refresh-and-retry, and error surfacing.
* Layout is responsive from 360 px up: collapsible sidebar, card grids, horizontally scrollable tables.

---

## 9. Deployment (§27)

`deploy/` contains the Nginx site, the PM2 ecosystem file, the MySQL production configuration, the
production environment template, a logrotate config and the monitoring runbook. Backup is not a
script here — it is `src/jobs/tasks/databaseBackup.js`, run by `npm run db:backup` and scheduled by
the cron process.

**This section previously described three things that are not true of this application, and the
corrections are worth keeping rather than silently overwriting.** It read: *"the Nginx site (reverse
proxy + SSL + **static uploads**), the PM2 ecosystem file (**API cluster** + **queue worker** + cron
runner), the backup script with retention"*. It also described `deploy/` in the present tense while
the directory did not exist; it was created in session 26.

- **Nginx must not serve uploads statically.** There is no `express.static` anywhere in the
  application, and that is deliberate: `utils/fileResponse.js` streams a stored file only after the
  owning module has already applied its permission check, and it re-checks the `school-<id>` segment
  against the record's tenant (`fileResponse.js:142`) and sets `Cache-Control: private, no-store`
  (`:200`). A static `location /uploads/` bypasses all three at once. Upload paths are 32-hex random,
  so what would be left is obscurity, not authorization.

- **The API cannot run as a cluster.** `middlewares/rateLimit.js:29-32` records that the store is
  `express-rate-limit`'s in-memory one, so *"behind N workers the effective ceiling is N × the
  configured limit"* — and names SRS §3 as describing a single-process deployment. The entitlement
  cache and the in-process queue are per-process for the same reason. The ecosystem file therefore
  pins `instances: 1, exec_mode: 'fork'`.

- **There is no resident queue worker.** `jobs/worker.js` runs one job and exits; its header explains
  that a worker consuming the API's queue would need a durable job store, and §29 fixes the schema at
  64 tables while §35 forbids a 65th. Durability across restarts comes from the cron reconciliation
  sweeps instead. PM2 manages the API and the cron scheduler — two apps, not three.

Provenance, from file mtimes, since this project has no git history: `ARCHITECTURE.md` was last
written 2026-08-26 18:34. `rateLimit.js` (2026-08-26 14:53) predates it by four hours, so the
"cluster" claim was already contradicted when it was written. `worker.js` (2026-09-04 14:58) and
`fileResponse.js` (2026-09-04 15:15) came nine days later, so those two claims became wrong
afterwards rather than starting that way.
