# Multi-School Management System

A multi-tenant SaaS for running schools: a platform operator sells subscription plans to organizations,
each of which runs one or more schools — students, staff, attendance, fees, finance, exams, timetables,
homework, assignments, the library, generated documents, AI question generation, reports and
notifications. Every feature is gated by the school's subscription, and no plan name appears in code.

**The specification is the source of truth.** `SRS_Multi-School-Management-System.docx`, extracted to
[`docs/SRS-extracted.md`](docs/SRS-extracted.md), decides what is built. Where it does not specify a
detail, §35 says the project does not decide it either — so a gap in the source is recorded, never
filled with an invented requirement, table, permission or seed row.

## Where it stands

**Built and verified against the SRS.** What is left needs a credential, not code: an Anthropic API
key to make the AI adapter's first live call. No question is open for the owner — the thirty-eight
gaps the SRS left open are answered in [`docs/OWNER-DECISIONS.md`](docs/OWNER-DECISIONS.md), and each
answer is built or recorded. The measured figures — suites, assertions,
pages, routes, open issues — are in the first table of
[`IMPLEMENTATION_PROGRESS.md`](IMPLEMENTATION_PROGRESS.md), and they are kept there rather than here so
that there is exactly one place for them to go stale.

## Layout

```
backend/     Node.js + Express REST API, Sequelize over MySQL/MariaDB — everything under /api/v1
frontend/    Next.js App Router + React + Tailwind — one route group per audience
deploy/      nginx, PM2, MySQL, logrotate and the monitoring runbook for a VPS (none of it run yet — see
             below), and hostinger/ — the env templates for Hostinger's managed Node.js hosting
docs/        the SRS, the requirement checklist, the verification record, and the audit findings
```

The two halves are separate npm packages with no shared build, talking only over HTTP, as SRS §3
requires.

## Running it locally

You need Node.js (developed on 24) and MySQL or MariaDB (developed on MariaDB 10.4 under XAMPP).

**Backend** — from `backend/`:

```bash
npm install
```

Copy `.env.example` to `.env` and set at least the `DB_*` connection values and `SUPER_ADMIN_PASSWORD`.
The seeder refuses the example password when `NODE_ENV=production`. Then create, migrate and seed:

```bash
npm run db:create
```

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

```bash
npm start
```

The API listens on port 4000; `GET http://localhost:4000/api/v1/health` answers when it is up, and the
generated API reference is served under `/api/v1/docs`.

**Frontend** — from `frontend/`:

```bash
npm install
```

```bash
npm run dev
```

It opens on port 3000 and talks to `http://localhost:4000/api/v1` unless `NEXT_PUBLIC_API_URL` says
otherwise. Sign in with the Super Admin account the seeder created.

**Scheduled work** runs in a separate process, `npm run cron` from `backend/`, and only when
`ENABLE_CRON=true` — two schedulers against one database would double-notify.

## Verifying it

```bash
npm test
```

Run from `backend/`. It spawns every `scripts/verify-*.js` suite **serially** against a separate
`msms_test` database, and checks each suite's exact assertion count against `tests/baseline.json` — so a
suite that silently stops running half of itself fails the loop instead of passing it. Three things to
know before relying on it:

- **`msms_test` must exist, migrated and seeded**, the same way as above with `DB_NAME=msms_test`. The
  harness proves which database it is connected to before running anything.
- **Never run two loops at once.** The suites share one database; overlapping runs delete each other's
  fixtures and fail suites that are fine. A lock file enforces this.
- **When a suite legitimately gains assertions**, re-record the baseline deliberately with
  `npm run test:baseline`. It refuses to record a run with any failure in it.
- **A killed run does not poison the next one**: each suite clears what a dead run of itself left
  before it builds anything. A new suite has to as well — `node scripts/kill-test.js <suite>` kills it
  partway, reruns it and diffs every table.

Both halves lint (`npm run lint`) and the frontend typechecks (`npm run typecheck`).

## Where the state lives

| Read | For |
|---|---|
| [`IMPLEMENTATION_PROGRESS.md`](IMPLEMENTATION_PROGRESS.md) | **Start here.** The measured state, the stopping point and next action (§7), the Known Issues register (§5), a file-by-file map (§6), and the rules the log is kept by (§8) |
| [`docs/IMPLEMENTATION_CHECKLIST.md`](docs/IMPLEMENTATION_CHECKLIST.md) | Every requirement, its status, and the evidence for it |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | What was measured and when — and, more usefully, what has **never been run** |
| [`docs/SRS-TRIAGE-VERDICTS.md`](docs/SRS-TRIAGE-VERDICTS.md) | The open specification questions, and why each cannot be settled by reading the SRS again |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the pieces fit. A design document: where it and the code disagree, the code wins |
| [`deploy/monitoring/README.md`](deploy/monitoring/README.md) | The operations runbook |
| [`docs/DEPLOY-HOSTINGER.md`](docs/DEPLOY-HOSTINGER.md) | Deploying to Hostinger Business or Cloud web hosting — two Node.js apps, migrations and the scheduler inside the API, storage kept outside the folder each deploy overwrites |

## Deploying

Two targets, and they are different machines:

- **A VPS you control** — `deploy/`: Nginx in front, PM2 running the API, the dashboard and the
  scheduler as separate processes, migrations run by hand before the new code starts.
- **Hostinger's managed Node.js hosting** (Business or any Cloud plan) — [`docs/DEPLOY-HOSTINGER.md`](docs/DEPLOY-HOSTINGER.md):
  one process per app on a port the host assigns, so the API migrates itself at boot
  (`MIGRATE_ON_BOOT`), runs the scheduler inside itself (`CRON_IN_API`) and logs to stdout
  (`LOG_CONSOLE`), and the web app starts from `frontend/server.js`. All of those are off by default.

## Never run against a real deployment

`deploy/` is configuration that agrees with the application — `verify-deploy.js` checks that — but nginx,
PM2, MySQL's production config and logrotate have never been executed by the tools that consume them.
Neither has a real SMTP delivery (development mail goes to the log) or a live Anthropic request. Treat
the first real deployment as the first test of all four.

The Hostinger path is closer: its API configuration has been booted **in production mode** against an
empty database — migrating, seeding, scheduling, signing the owner in over a secure cookie — and the web
app's production build served through `server.js` on an assigned port. What has not run is Hostinger
itself.
