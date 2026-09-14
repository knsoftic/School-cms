# Deploying to Hostinger — Business or Cloud web hosting

This is the guide for Hostinger's **managed Node.js web apps** (hPanel → Websites, on a Business web
hosting plan or any Cloud hosting plan). If you are on a **Hostinger VPS**, use the kit in
[`deploy/`](../deploy) instead — Nginx, PM2, logrotate and MySQL tuning — which assumes a server you
control.

The two are different machines, and the differences are the reason this document exists:

| | Managed Node.js hosting (this guide) | VPS (`deploy/`) |
|---|---|---|
| Process manager | Hostinger's — one process per app | PM2, as many as you like |
| Reverse proxy, TLS | Hostinger's | Nginx and your certificate |
| Scheduler (renewals, invoices, notifications) | inside the API process — `CRON_IN_API` | its own PM2 process |
| Database migrations | applied by the API at boot — `MIGRATE_ON_BOOT` | run by hand before starting |
| Uploaded files | **wiped on every redeploy** unless kept outside the app | persistent |

Both settings above were written for this host and are off by default everywhere else.

---

## What you need before starting

- A **Business** web hosting plan (5 Node.js apps) or a **Cloud** plan (10). This system uses **two**.
- One domain in hPanel, with two subdomains. This guide uses:
  - `app.example.com` — the web application people open (Next.js)
  - `api.example.com` — the API it talks to (Express)

  Keep both under the **same** domain. The sign-in cookie is `SameSite=Lax`, which a browser sends
  between `app.example.com` and `api.example.com` (the same *site*) and does not send between two
  unrelated domains — on those, nobody could stay signed in.
- A **mailbox to send from** (hPanel → Emails). Password resets and email verification are *sent*,
  and the API refuses to start in production without a real mail driver.
- An **Anthropic API key**, if a plan you sell includes the AI question generator (SRS §21).

---

## 1. Create the database

hPanel → **Databases → MySQL Databases** → create a database, and a user with a strong password.

Hostinger prefixes both with your account id. Write down the **full** names — for example
`u123456789_msms` and `u123456789_msmsuser` — and the host that page shows (usually `localhost`).

Leave the database **empty**. The API builds every table itself on its first start (step 3).

---

## 2. Get the code onto Hostinger

Hostinger deploys an app from a **GitHub repository** or an **uploaded archive**. This repository holds
two apps, `backend/` and `frontend/`, so each Hostinger app must be given one of those folders.

### Option A — GitHub, with automatic redeploys on every push

Push this repository to GitHub and create each app from it in hPanel. If the setup screen offers a
**root directory**, set it to `backend` for the API and `frontend` for the web app.

If there is no root directory setting, use option B: Hostinger would build the repository's top
folder, which is not an app.

### Option B — upload one archive per app

On your computer, from the repository's top folder, after committing:

```bash
git archive --format=zip -o msms-backend.zip HEAD:backend
```

```bash
git archive --format=zip -o msms-frontend.zip HEAD:frontend
```

`git archive` packs **committed files only** — no `node_modules`, no local `.env`, no uploaded
documents, no logs — and `HEAD:backend` puts that folder's contents at the archive's root, where
Hostinger looks for `package.json`. Each archive is under 2 MB.

---

## 3. The API — `api.example.com`

hPanel → **Websites → Add website → Node.js app**, on `api.example.com`.

| Setting | Value |
|---|---|
| Framework | Express (or "Other") |
| Node.js version | **24** — the version this release was verified on |
| Root directory (GitHub only) | `backend` |
| Build command | none — there is nothing to build |
| Entry file | `src/server.js` |

**Environment variables:** copy every line of
[`deploy/hostinger/api.env.example`](../deploy/hostinger/api.env.example) into hPanel and fill in the
blanks. Each is explained in that file. The ones that differ on this host:

| Variable | Value | Why |
|---|---|---|
| `MIGRATE_ON_BOOT` | `true` | Nobody can run `npm run db:migrate` here. The API applies pending migrations and the mandatory seed before it listens, on every start — which is how the empty database gets its tables, and how a later release's migrations get applied. Both steps are idempotent. |
| `CRON_IN_API` | `true` | There is no second process for the scheduler, so the API runs renewals, invoice issuing, overdue flags, fee fines, coupon and quotation expiry, and notifications itself. |
| `CRON_SKIP` | `database-backup` | That task needs `mysqldump`, which an app on this hosting does not get. Use hPanel's own backups. |
| `UPLOAD_DIR`, `LOG_DIR`, `BACKUP_DIR` | absolute paths **outside** the app, e.g. `/home/u123456789/msms-data/uploads` | Hostinger overwrites the app's folder on every deploy. The default relative paths would put student documents inside it, and the next deploy would delete them. |
| `MAIL_DRIVER` | `smtp`, with the mailbox's settings | Production refuses `log`, which writes reset links to a file and emails nobody. |
| `SUPER_ADMIN_PASSWORD` | a strong password of your own | The first start creates the platform owner with it. The example value is refused in production. |
| `LOG_CONSOLE` | `true` | hPanel's Runtime logs show the app's stdout and nothing else. In production the log goes only to `LOG_DIR` by default, so without this a healthy start leaves the runtime log **empty**. |
| `TRUST_PROXY` | `1` | Hostinger's proxy is in front of the app. Without it every visitor looks like one client to the rate limiter. |
| `PORT` | **not set** | Hostinger assigns the port. A `PORT` copied in by hand would override it. |

Your home path (`/home/u123456789`) is shown in hPanel → **Files → File Manager**. The folders are
created on first use.

**Deploy.** With `LOG_CONSOLE=true`, the app's **Runtime logs** show, in this order (each line also
carries a timestamp and some JSON detail):

```text
Schema matches SRS §29 (64 tables)
Database connected (u123456789_msms)
MIGRATE_ON_BOOT: applied 1 migration(s); mandatory seed complete
cron: scheduler started
Multi-School Management System listening on port …
```

On later starts the third line reads `applied 0 migration(s)` — nothing pending, nothing re-seeded.

Then open `https://api.example.com/api/v1/health/ready`. It answers
`{"success":true,"data":{"status":"ready",…,"checks":{"database":"up"}}}`.

**If it does not start**, the runtime log gives the reason on a `Failed to start:` line. Three
mistakes are refused by name: a placeholder or missing JWT secret and `MAIL_DRIVER=log` (checked
first, before the database is contacted), and a misspelt task in `CRON_SKIP` (checked just before the
API starts listening). A database name missing its `u123456789_`
prefix, or a wrong password, arrives instead as the database's own error — `Unknown database` or
`Access denied` — on the same line.

---

## 4. The web application — `app.example.com`

hPanel → **Websites → Add website → Node.js app**, on `app.example.com`.

| Setting | Value |
|---|---|
| Framework | Next.js |
| Node.js version | **24** |
| Root directory (GitHub only) | `frontend` |
| Build command | `npm run build` |
| Entry file | `server.js` |

**Environment variables** — [`deploy/hostinger/app.env.example`](../deploy/hostinger/app.env.example):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NEXT_PUBLIC_API_URL` | `https://api.example.com/api/v1` |

`NEXT_PUBLIC_API_URL` is compiled into the pages **when the app is built**. Set it before the first
deploy; after changing it, redeploy — a restart keeps the old address.

`server.js` serves the built application on the port Hostinger assigns, and runs in production mode
unless `NODE_ENV=development` is set explicitly — so a forgotten variable cannot put the dev server on
a public address.

---

## 5. First sign-in

1. Open `https://app.example.com` and sign in with `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`.
   You will be made to choose a new password before anything else — deliberately.
2. In the API app's environment variables, **delete `SUPER_ADMIN_PASSWORD`** and redeploy. The account
   exists now, and the seed never changes an existing account's password, so it is not needed again
   and should not sit in a dashboard.
3. Create your first organization, school and plan.

---

## Updating a live deployment

- **GitHub:** push. Hostinger rebuilds and restarts, and the API applies any new migrations as it
  starts.
- **Archives:** make a new archive for the folder that changed (step 2) and upload it in that app's
  settings.

Uploads, logs and backups survive either way **only** because they live outside the app (step 3).

---

## Limits of this hosting

- **One API process.** The job queue is in memory: an email still waiting to go out when the app
  restarts is not retried. Never run a second API app against the same database with
  `CRON_IN_API=true` — two schedulers would race the renewals and send every notification twice.
- **Shared resources.** Business gives 3 GB of RAM and 2 CPU cores to everything on the plan; Cloud
  Startup, 4 GB and 4 cores. Comfortable for a group of schools. A large group, or one that needs a
  separate worker process, should move to a VPS and the `deploy/` kit.
- **No `mysqldump`.** Database backups are Hostinger's (hPanel → Files → Backups), not this system's.

---

## Things to check on your hPanel screen

Hostinger's documentation does not state these, and this guide was written without access to your
account. Each has a fallback above, so none should block you.

- **Root directory** on GitHub deployment. If absent, use archives (option B).
- **The port.** Both entry files read `PORT` and fall back to 4000 (API) and 3000 (web) only when
  nothing sets it. If the API's log shows `listening on port 4000` and the site does not answer, the
  host is not passing `PORT` — contact Hostinger support with that log line.
- **The database host.** If `localhost` is refused, try `127.0.0.1`, or the host hPanel shows.

---

## What was verified before this guide was written

On the development machine, against the code this guide ships with, each run on a throwaway database
created for it and dropped afterwards:

- The API started on an **empty database** with `MIGRATE_ON_BOOT`, `CRON_IN_API` and
  `CRON_SKIP=database-backup`: it built 65 tables, created exactly one platform owner, started the
  scheduler without `database-backup`, migrated before listening, and answered `/health` and
  `/health/ready`. Started again, it applied nothing and created no second owner.
- A misspelt `CRON_SKIP` stopped the start; a separate `cron.js` refused to run beside `CRON_IN_API`.
- **In production mode**, with this guide's API settings: production refused `MAIL_DRIVER=log`,
  `CRON_IN_API` with `ENABLE_CRON`, and the example owner password. With a real one it started, logged
  to stdout in plain timestamped lines and to the absolute `LOG_DIR`, answered `/health/ready`, and the
  owner signed in and was sent to change the password. The refresh cookie was `HttpOnly; Secure;
  SameSite=Lax` and never appeared in a response body; errors carried no stack trace. Redeployed with
  `SUPER_ADMIN_PASSWORD` removed, it started and applied nothing.
  This run is also how `LOG_CONSOLE` came to exist: without it the start was healthy and printed
  nothing at all.
- `npm run build` completed for all 90 pages, and `server.js` served them in production mode on an
  assigned port with `NODE_ENV` unset.
- The `git archive` commands above produced archives with `package.json` at the root and no
  `node_modules`, `.env` or uploaded files.

What could not be verified is Hostinger itself.
