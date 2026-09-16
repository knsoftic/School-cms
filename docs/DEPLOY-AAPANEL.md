# Deploying on aaPanel — school.knbazaar.com

This is the deployment guide for **this project's aaPanel server**. Every command below already has the
real addresses, folders and ports in it, so it can be copied as it is.

| | Web app (frontend) | API (backend) |
|---|---|---|
| Address | `https://school.knbazaar.com` | `https://school-api.knbazaar.com` |
| aaPanel site folder | `/www/wwwroot/school.knbazaar.com` | `/www/wwwroot/school-api.knbazaar.com` |
| Part of the repository it runs | `frontend/` | `backend/` |
| PM2 process | `msms-web` | `msms-api` and `msms-cron` |
| Local port (never public) | `3100` | `4100` |

| | |
|---|---|
| Server IP | `187.77.138.214` |
| Database | `msms`, created in aaPanel |
| Uploads, backups, logs | `/www/msms-data` — outside both site folders |
| Runs as | the Linux user `msms`, not root |

**How it works.** aaPanel's web server (nginx or Apache) receives HTTPS traffic for both addresses. Its
**Reverse proxy** passes each site to a Node.js process on a local port. PM2 keeps the three processes
running and restarts them after a crash or a reboot. `msms-cron` is the scheduler for renewals,
invoices, notifications and the 03:00 backup. There must only ever be **one** of it, because two would
send every notification twice.

For Hostinger's managed web hosting, use [`DEPLOY-HOSTINGER.md`](DEPLOY-HOSTINGER.md) instead.

---

## Contents

1. [Step 1 — DNS and aaPanel apps](#step-1--dns-and-aapanel-apps)
2. [Step 2 — Node.js 24 and PM2](#step-2--nodejs-24-and-pm2)
3. [Step 3 — Check what is already running](#step-3--check-what-is-already-running)
4. [Step 4 — The msms user and the data folder](#step-4--the-msms-user-and-the-data-folder)
5. [Step 5 — The two websites and SSL](#step-5--the-two-websites-and-ssl)
6. [Step 6 — Put the code in the site folders](#step-6--put-the-code-in-the-site-folders)
7. [Step 7 — Database and API settings](#step-7--database-and-api-settings)
8. [Step 8 — Install, migrate and seed the API](#step-8--install-migrate-and-seed-the-api)
9. [Step 9 — Build the web app](#step-9--build-the-web-app)
10. [Step 10 — Start everything with PM2](#step-10--start-everything-with-pm2)
11. [Step 11 — Reverse proxy in aaPanel](#step-11--reverse-proxy-in-aapanel)
12. [Step 12 — First sign-in](#step-12--first-sign-in)
13. [Step 13 — Check the deployment](#step-13--check-the-deployment)
14. [Backups and restoring](#backups-and-restoring)
15. [Updating to a new version](#updating-to-a-new-version)
16. [Logs and monitoring](#logs-and-monitoring)
17. [Troubleshooting](#troubleshooting)
18. [What was verified](#what-was-verified)

Commands marked **root** run in the server terminal as root (SSH, or aaPanel → Terminal). Commands
marked **msms** run after `sudo -iu msms`.

**The prompt tells you who you are:**
- `root@srv1910435:~#` is **root**.
- `msms@srv1910435:~$` is **msms**.

To go from msms back to root, type `exit`. A root command run as msms fails with `Permission denied` or
`are you root?`, and changes nothing.

---

## Step 1 — DNS and aaPanel apps

**DNS.** At your domain registrar, create two `A` records pointing at `187.77.138.214`:

| Name | Type | Value |
|---|---|---|
| `school` | A | `187.77.138.214` |
| `school-api` | A | `187.77.138.214` |

From your own computer, `nslookup school-api.knbazaar.com` must answer `187.77.138.214`. SSL (step 5)
fails until both do.

**aaPanel apps.** In **aaPanel → App Store → Installed**, you need:

- a **web server**, either **Nginx** or **Apache**. Note which one; step 11 differs slightly between
  them.
- a **database**: MySQL or MariaDB. MariaDB 10.6 or newer is closest to what this system was tested on.

**Firewall.** In **aaPanel → Security**, allow only `22`, `80`, `443` and the panel's own port.
**Never open 3100 or 4100.** The API listens on every network interface, so the firewall is what keeps
port 4100 private.

---

## Step 2 — Node.js 24 and PM2

**root.** On this server, Node.js 24's installer (NodeSource) stopped with
`Error: Failed to run 'apt update'`. The cause was a third-party package list, `rspamd.com`, which has no
packages for this Ubuntu release and returns 404. Because of that, `apt-get install nodejs` installed
Ubuntu's own Node.js 22 instead. Fix it in this order.

Your prompt must start with `root@` (type `exit` if it shows `msms@`). Find and disable the broken rspamd
list. It is renamed, not deleted, so you can restore it by removing `.disabled`. The command only touches
active lists, so running it again does nothing:

```bash
for f in $(grep -rl rspamd /etc/apt/sources.list.d/ --include='*.list' --include='*.sources'); do mv "$f" "$f.disabled"; done; ls /etc/apt/sources.list.d/ | grep rspamd
```

The last line must end in `.disabled`, e.g. `rspamd.list.disabled`.

```bash
apt-get update
```

It must finish with **no** `Error:` line.

Remove Ubuntu's Node.js 22 (installed a moment ago, and nothing else uses it), then install Node.js 24:

```bash
apt-get remove -y nodejs nodejs-doc
```

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh && bash /tmp/nodesource_setup.sh
```

```bash
apt-get install -y nodejs && /usr/bin/node -v
```

The last command must print `v24.…`. Do **not** run the `apt autoremove` that apt suggests: other
software on this shared server may still use those packages.

PM2 is **not** installed here as root. Root's PM2 on this server runs the other projects. Its global
packages also live in a folder the `msms` user cannot find: installing PM2 as root and then running
`pm2 -v` as `msms` gave `pm2: command not found`. Step 4 installs a separate PM2 for `msms` in its own home
folder instead.

This server also has an older Node.js. The PM2 file therefore runs the application with `/usr/bin/node`
(Node.js 24) by full path, so the two can never be mixed up.

---

## Step 3 — Check what is already running

**root.** The server already runs other projects under PM2. Look before starting anything:

```bash
pm2 list
```

This project's processes are named `msms-api`, `msms-cron` and `msms-web`. On this server the list
showed `hunario-queue`, `hunario-web`, `vyra-admin`, `vyra-api` and `vyra-worker`. Those belong to other
projects: **leave them alone**. If a line starting `msms-` ever appears here before step 10, it is left
over from an earlier attempt. Remove those with `pm2 delete msms-api msms-cron msms-web && pm2 save`.

Then make sure the two ports this guide uses are free. This must print **nothing**:

```bash
ss -ltnp | grep -E ':(3100|4100) '
```

If it prints a line, another program owns that port. See [Troubleshooting](#troubleshooting) → "port
already in use".

---

## Step 4 — The msms user and the data folder

**root.** The application runs as its own user, never as root, so a fault in it cannot reach the rest of
the server:

```bash
adduser --system --group --home /home/msms --shell /bin/bash msms
```

```bash
echo 'export PATH=/usr/bin:$PATH' >> /home/msms/.profile && chown msms:msms /home/msms/.profile
```

That line puts Node.js 24 first for the `msms` user, ahead of the older Node.js already on the server.

Install PM2 for `msms` in its own home folder, where it never touches root's PM2 or the other projects:

```bash
sudo -iu msms bash -c 'npm config set prefix ~/.npm-global && npm install -g pm2'
```

```bash
echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> /home/msms/.profile && chown msms:msms /home/msms/.profile
```

```bash
mkdir -p /www/msms-data/uploads /www/msms-data/backups /www/msms-data/logs && chown -R msms:msms /www/msms-data && chmod 0750 /www/msms-data
```

Check that `msms` sees Node.js 24 and PM2:

```bash
sudo -iu msms bash -c 'node -v; pm2 -v; command -v pm2'
```

Three lines: `v24.…`, a PM2 version number, and `/home/msms/.npm-global/bin/pm2`.

---

## Step 5 — The two websites and SSL

**aaPanel.**

**5.1 The web app site** already exists: `school.knbazaar.com`, folder `/www/wwwroot/school.knbazaar.com`.

**5.2 Create the API site.**
1. Open **Website → Add site**.
2. Domain `school-api.knbazaar.com`.
3. PHP version **Static** (no PHP).
4. **No** database, **no** FTP.
5. Keep the folder `/www/wwwroot/school-api.knbazaar.com`.

**5.3 SSL for both sites.** For `school.knbazaar.com`, then again for `school-api.knbazaar.com`:
1. Open the site's settings → **SSL → Let's Encrypt**.
2. Choose **file verification**, tick the domain, click **Apply**.
3. Once it succeeds, turn on **Force HTTPS**.

If Let's Encrypt fails, DNS is not pointing here yet (step 1).

---

## Step 6 — Put the code in the site folders

Each site folder gets its own copy of the repository. The web app site uses its `frontend/`, the API site
its `backend/`.

**root.** Move aaPanel's default files out of the way (renamed, not deleted), and give both folders to
`msms`. The command first checks that step 4 created `msms`, and it is safe to run again: a folder that
was already moved is not moved twice.

```bash
id msms && for d in school.knbazaar.com school-api.knbazaar.com; do [ -d /www/wwwroot/$d.aapanel-default ] || { mv /www/wwwroot/$d /www/wwwroot/$d.aapanel-default && mkdir /www/wwwroot/$d; }; chown msms:msms /www/wwwroot/$d; done
```

```bash
ls -ld /www/wwwroot/school.knbazaar.com /www/wwwroot/school-api.knbazaar.com
```

Both lines must show `msms msms`.

The SSL certificates are stored elsewhere (`/www/server/panel/vhost/cert/`), so this does not affect
them. Delete the two `.aapanel-default` folders once the sites work.

**msms.** Switch to the `msms` user:

```bash
sudo -iu msms
```

The repository `knsoftic/School-cms` is **public**, so the server needs no GitHub key. Clone branch `main`
into both folders over HTTPS:

```bash
git clone -b main https://github.com/knsoftic/School-cms.git /www/wwwroot/school-api.knbazaar.com
```

```bash
git clone -b main https://github.com/knsoftic/School-cms.git /www/wwwroot/school.knbazaar.com
```

Check that the aaPanel files arrived:

```bash
ls /www/wwwroot/school-api.knbazaar.com/deploy/aapanel/
```

It must list `api.env.example` and `ecosystem.config.js`.

- **`Remote branch main not found`:** `main` has not been pushed to GitHub yet. Push it from the
  development machine first.
- **Do not use the `hostinger-frontend` branch:** it is a build for a different API address.

**If the repository is ever made private**, the clone asks for a username. Give the server a read-only
deploy key instead:
1. As `msms`, run `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""`, then `cat ~/.ssh/id_ed25519.pub`.
2. Add that whole line under **knsoftic/School-cms → Settings → Deploy keys**, with write access off.
3. Check with `ssh -T git@github.com`. Success greets `knsoftic/School-cms`. GitHub's real host fingerprint
   is `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`.
4. Clone with `git@github.com:knsoftic/School-cms.git` in place of the `https://` address.

---

## Step 7 — Database and API settings

**aaPanel → Databases → Add database:**

| Field | Value |
|---|---|
| Database name | `msms` |
| Username | `msms` |
| Password | a strong password. Write it down. |
| Access permission | **Local server** |

Leave it empty; step 8 builds all 64 tables.

**msms.** Create the API's settings file from the template, which already contains both addresses, port
4100 and the data folders:

```bash
cd /www/wwwroot/school-api.knbazaar.com && cp deploy/aapanel/api.env.example backend/.env && chmod 600 backend/.env
```

`chmod 600` means only `msms` can read it, not even the web server.

Generate two secrets. Run this **twice** and keep both outputs:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Open `nano backend/.env` and fill in:

| Setting | Value |
|---|---|
| `DB_PASSWORD` | the database password from above |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | the two secrets, one each |
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | your email and a strong first password |
| `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM` | your SMTP mailbox. Port 587 goes with `MAIL_SECURE=false`, port 465 with `MAIL_SECURE=true`. |
| `ANTHROPIC_API_KEY` | your key. Without one, set `AI_DRIVER=mock`, which starts but produces **sample** AI questions. |
| `MYSQLDUMP_PATH` | keep it if `ls /www/server/mysql/bin/mysqldump` finds the file. Otherwise use what `command -v mysqldump` prints. |

Save with Ctrl+O, Enter, then Ctrl+X.

The API **refuses to start**, and says why, in any of these cases:
- a JWT secret is missing, too short, or the same as the other
- mail is not set up (`MAIL_DRIVER=log`)
- AI is `anthropic` with no key

---

## Step 8 — Install, migrate and seed the API

**msms.**

```bash
cd /www/wwwroot/school-api.knbazaar.com/backend && npm ci --omit=dev
```

`LOG_CONSOLE=true` in front of the next two commands makes them show their output. In production the log
goes to files only, and without it both commands succeed **silently**.

```bash
LOG_CONSOLE=true npm run db:migrate
```

The migration takes a minute or two. Each line starts with a timestamp; the last three read:

```text
… info: Initial schema created: 64 tables, 354 indexes, 254 foreign keys.
… info: Migrated up: 20260825120000-initial-schema.js (…ms)
… info: Applied 1 migration(s).
```

```bash
LOG_CONSOLE=true npm run db:seed
```

```text
… info:   roles (created=11, updated=0, total=11)
… info:   permissions (created=109, updated=0, removed=0, total=109)
… info:   role-permissions (bootstrapped=11, preserved=0, granted=359, revoked=0, total=359)
… info: Created Super Admin "you@your-email" (must change password on first login).
… info:   super-admin (created=true, id=1, email=you@your-email)
… info:   addons (created=7, updated=0, total=7)
… info: Core seed complete.
```

Both are safe to run again: a second migrate prints `No pending migrations.`, and a second seed creates
nothing and never changes an existing password.

---

## Step 9 — Build the web app

**msms.** The API address is compiled into the pages at build time, so set it first. The file is not
tracked by git, so `git pull` never overwrites it.

```bash
cd /www/wwwroot/school.knbazaar.com/frontend && echo 'NEXT_PUBLIC_API_URL=https://school-api.knbazaar.com/api/v1' > .env.production
```

```bash
npm ci --omit=dev && npm run build
```

The build ends with a table of routes and the lines `○ (Static)` and `ƒ (Dynamic)`. If it stops with
`Killed` or `JavaScript heap out of memory`, the server ran out of memory. Check swap is on
(`free -h`), then run `npm run build` again.

---

## Step 10 — Start everything with PM2

**msms.**

```bash
pm2 start /www/wwwroot/school-api.knbazaar.com/deploy/aapanel/ecosystem.config.js && pm2 save
```

```bash
pm2 list
```

Three processes must be **online**: `msms-api`, `msms-cron`, `msms-web`. Check each one answers on the
server itself:

```bash
curl -sS http://127.0.0.1:4100/api/v1/health/ready
```

The API prints `{"success":true,"data":{"status":"ready",…,"checks":{"database":"up"}}}`.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/login
```

The web app prints `200`.

Keep PM2's own log files from growing forever:

```bash
pm2 install pm2-logrotate
```

**Start on boot.** Type `exit` to leave the `msms` shell, then as **root**:

```bash
/usr/bin/node /home/msms/.npm-global/lib/node_modules/pm2/bin/pm2 startup systemd -u msms --hp /home/msms
```

This runs **msms's** PM2 (from step 4) with Node.js 24, so the boot service it creates uses both. It must
not use root's PM2, which the `msms` user cannot reach.

```bash
systemctl is-enabled pm2-msms
```

It must print `enabled`. After a reboot, the service brings back the processes `pm2 save` recorded.

---

## Step 11 — Reverse proxy in aaPanel

**aaPanel.** This connects each address to its local port.

**11.1 The API.**
1. Open **Website → school-api.knbazaar.com → Reverse proxy → Add reverse proxy**.
2. Target URL: `http://127.0.0.1:4100`.
3. Sent domain: `$host`.
4. **Cache: off.** Every response is one school's private data and must never be cached.
5. Save.

**11.2 The web app.** Repeat for **school.knbazaar.com**, with target URL `http://127.0.0.1:3100`,
sent domain `$host`, and cache **off**.

**11.3 Give the API more time.** AI question generation can take several minutes, and the web server
stops waiting after 60 s by default. On **school-api.knbazaar.com → Reverse proxy**, open the proxy's
**config file** and add these lines:

| Web server | Add | Where |
|---|---|---|
| Nginx | `proxy_read_timeout 300s;` and `proxy_send_timeout 300s;` | inside the `location ^~ /` block, before its closing `}` |
| Apache | `ProxyTimeout 300` | on its own line, next to the `ProxyPass` line |

Save; aaPanel checks and reloads the web server.

**11.4 Check from your own computer:**
- `https://school-api.knbazaar.com/api/v1/health/ready` → `"status":"ready"`
- `https://school.knbazaar.com` → the landing page

**While the code sits in the site folders, never remove these reverse proxies.** Without them the web
server would serve the folder's files directly. `backend/.env` is still protected by `chmod 600`, but the
source code would be visible.

---

## Step 12 — First sign-in

1. Open `https://school.knbazaar.com/login` and sign in with `SUPER_ADMIN_EMAIL` and
   `SUPER_ADMIN_PASSWORD`. You are made to choose a new password before anything else, deliberately.
2. **msms:** remove the first password from the settings file, since it is no longer needed:

   ```bash
   cd /www/wwwroot/school-api.knbazaar.com && sed -i 's/^SUPER_ADMIN_PASSWORD=.*/SUPER_ADMIN_PASSWORD=/' backend/.env && pm2 restart msms-api
   ```

3. Create your first organization, school and subscription plan.

---

## Step 13 — Check the deployment

| Check | How | Expected |
|---|---|---|
| API up, database reachable | open `https://school-api.knbazaar.com/api/v1/health/ready` | `"status":"ready"`, `"database":"up"` |
| Local ports not public | from **your own computer**: `curl -m 5 http://187.77.138.214:4100/api/v1/health` | timeout or "connection refused", **never** JSON. Same for port `3100`. |
| HTTPS redirect | open `http://school.knbazaar.com` | lands on `https://` |
| Sign-in survives a reload | sign in, press F5 | still signed in |
| Email is sent | *Forgot password* on the sign-in page | the email arrives |
| Uploads work | upload a student photo | it displays |
| Scheduler alive | root: `sudo -iu msms pm2 list` | `msms-cron` online |
| Backup works | msms: `cd /www/wwwroot/school-api.knbazaar.com/backend && npm run db:backup` | `backup: /www/msms-data/backups/msms-….sql (… bytes)` |
| Survives a reboot | root: `reboot`, wait, then `sudo -iu msms pm2 list` | three processes online |

The server also reported a pending kernel update, so this reboot test installs that update too.

---

## Backups and restoring

**Automatic.** Every night at **03:00 server time** (`timedatectl` shows the timezone), `msms-cron`
dumps the database into `/www/msms-data/backups` and keeps 30 days.

**Add these yourself**, because a backup on the same disk dies with the disk:
1. **aaPanel → Cron → Backup directory:** back up `/www/msms-data` to remote storage.
2. `/www/msms-data/uploads` holds the uploaded files. It is **not** in the database dump, and is just as
   important.

**Prove a backup restores.** This needs the MySQL root password (**aaPanel → Databases → Root
password**), because it creates a temporary database. **msms:**

Replace `ROOT_PASSWORD_HERE` with that password, keeping the quotes:

```bash
cd /www/wwwroot/school-api.knbazaar.com/backend && DB_USER=root DB_PASSWORD='ROOT_PASSWORD_HERE' npm run db:restore-drill -- --fresh
```

It dumps the database, restores it into `msms_restore_drill`, compares every table, column and foreign
key, then drops the temporary database.

**Restoring for real:**
1. root: `sudo -iu msms pm2 stop msms-api msms-cron`
2. Import the chosen `.sql` into `msms` (**aaPanel → Databases → Import**).
3. Put back `/www/msms-data/uploads` from the same date, if it was lost.
4. root: `sudo -iu msms pm2 start msms-api`, check `/api/v1/health/ready`, and sign in.
5. Only then: `sudo -iu msms pm2 start msms-cron`

---

## Updating to a new version

**msms.** Back up first. Migrations cannot be undone in production, so this backup is your way back.

```bash
cd /www/wwwroot/school-api.knbazaar.com/backend && npm run db:backup
```

The API:

```bash
cd /www/wwwroot/school-api.knbazaar.com && git pull && cd backend && npm ci --omit=dev && LOG_CONSOLE=true npm run db:migrate && LOG_CONSOLE=true npm run db:seed
```

The web app:

```bash
cd /www/wwwroot/school.knbazaar.com && git pull && cd frontend && npm ci --omit=dev && npm run build
```

Restart:

```bash
pm2 restart msms-api msms-web
```

```bash
pm2 restart msms-cron
```

- **Update both folders** every time, so the web app and the API are always the same version.
- **Do not restart `msms-cron` between 02:55 and 03:15.** It would cut off the nightly backup.
- If `deploy/aapanel/ecosystem.config.js` itself changed, `restart` does not pick it up. Run
  `pm2 delete msms-api msms-cron msms-web`, then the `pm2 start …` command from step 10, then `pm2 save`.
- **To go back:** find the previous version's commit id with `git log --oneline -5`, run
  `git checkout` with that id in both folders, then repeat the install, build and restart steps. If the
  update included a migration, also restore the backup.

---

## Logs and monitoring

| What | Where |
|---|---|
| Process state and restarts | `sudo -iu msms pm2 list` |
| Why a process will not start | `sudo -iu msms pm2 logs msms-api --err --lines 50` |
| API errors | `/www/msms-data/logs/error-<date>.log` |
| API requests | `/www/msms-data/logs/combined-<date>.log` |
| Scheduler | `/www/msms-data/logs/cron/` |
| Web server | `/www/wwwlogs/school-api.knbazaar.com.log`, `/www/wwwlogs/school.knbazaar.com.log` |
| Health | `https://school-api.knbazaar.com/api/v1/health/ready` — point an uptime monitor at it |

In production, `pm2 logs msms-api` is nearly empty; that is normal. **Watch for `msms-cron` stopped or
restarting.** Nothing else notices, and renewals, invoices, notifications and backups would silently
stop.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `sudo: I'm sorry msms. I'm afraid I can't do that` | You are **already** `msms` (the prompt shows `msms@`), and `msms` may not use sudo, by design. Skip `sudo -iu msms` and run the msms commands directly. For a root command, type `exit` first. |
| `Permission denied`, `are you root?`, or `curl: (23)` | A **root** command was run as `msms` (the prompt shows `msms@`). Type `exit` to get back to `root@`, then run it again. Nothing was changed by the failed attempt. |
| NodeSource: `Error: Failed to run 'apt update'` | A third-party package list is broken. Run `apt-get update` and read the `Err:` line to find it, then disable that file in `/etc/apt/sources.list.d/` as step 2 does for rspamd. |
| `node -v` shows an old version as `msms` | The PATH line from step 4 is missing. Add it to `/home/msms/.profile` and run `sudo -iu msms node -v` again. |
| Port already in use (step 3 printed a line, or `EADDRINUSE`) | Choose another free port. For the API, change `PORT` in `backend/.env` and the target URL in step 11.1. For the web app, change `WEB_PORT` in `deploy/aapanel/ecosystem.config.js` and the target URL in step 11.2. Then `pm2 delete` and start again (step 10). |
| `git clone`: `Permission denied (publickey)` | The `git@github.com:` address needs a GitHub key. The repository is public, so use the `https://github.com/knsoftic/School-cms.git` address from step 6 instead; no key is needed. |
| `git clone`: `Remote branch main not found` | Branch `main` is not on GitHub yet. Push it from the development machine, then clone again. |
| `cp: cannot stat 'deploy/aapanel/api.env.example'` | The clone is older than the aaPanel files. Push the latest `main` to GitHub, then `git pull` in both site folders. |
| `msms-api`, `msms-cron`, `msms-web` appear in **root's** `pm2 list` (and `sudo -iu msms pm2 list` is empty) | They were started as root. As root, run `pm2 delete msms-api msms-cron msms-web && pm2 save`, then `chown -R msms:msms /www/wwwroot/school.knbazaar.com /www/wwwroot/school-api.knbazaar.com /www/msms-data`, then start them again as `msms` (step 10). The PM2 file now refuses to start as root. |
| Port 3100 held by a leftover `next-server` (`ss -ltnp` shows it, `msms-web` keeps restarting) | A `next-server` outlived its PM2 process. Take the pid from `ss -ltnp \| grep 3100` and confirm it is this app with `readlink /proc/PID/cwd`, which must print `/www/wwwroot/school.knbazaar.com/frontend`. Then `kill PID`, and restart `msms-web`. |
| `EACCES` / `permission denied` in `npm ci`, `npm run build` or logs, as `msms` | Those files were created by root. As root: `chown -R msms:msms /www/wwwroot/school.knbazaar.com /www/wwwroot/school-api.knbazaar.com /www/msms-data`. Run all `npm` and `pm2` commands as `msms`. |
| `ecosystem.config.js: do not start this as root` | Start it as `msms`: `sudo -iu msms pm2 start /www/wwwroot/school-api.knbazaar.com/deploy/aapanel/ecosystem.config.js`. |
| `ecosystem.config.js: expected … there is no package.json there` | A site folder has no clone. Repeat step 6 for that folder. |
| `pm2 list` shows `msms-api` restarting | `pm2 logs msms-api --err --lines 30`, then read the `Failed to start:` line. It names the setting to fix (step 7). |
| `Access denied for user 'msms'` | The database password in `backend/.env` is wrong. Reset it in aaPanel → Databases and keep *Local server*. If it still fails, try `DB_HOST=localhost`. |
| `db:migrate` / `db:seed` print nothing | Put `LOG_CONSOLE=true` in front of the command (step 8). |
| **502 Bad Gateway** | The process behind that site is down, or the reverse proxy points at the wrong port. Check `sudo -iu msms pm2 list`: 4100 is the API, 3100 the web app. |
| aaPanel's default page instead of the app | The reverse proxy for that site is missing (step 11). |
| Let's Encrypt fails | DNS does not point at `187.77.138.214` yet (step 1), or it has not spread yet; wait and retry. |
| Browser console shows a CORS error | `CORS_ORIGINS` in `backend/.env` must be exactly `https://school.knbazaar.com`. Then `pm2 restart msms-api`. |
| The web app calls `localhost:4000` or another API | It was built without the right `.env.production`. Fix the file (step 9), `npm run build`, `pm2 restart msms-web`. |
| Signed out on every reload | Open the site over `https://`. Both addresses must stay under `knbazaar.com`. |
| AI generation fails with **504** | Step 11.3 was skipped. |
| Upload fails with **413** | The web server's upload limit is too small. Set it to at least 12 MB: Nginx in aaPanel → App Store → Nginx → Settings → `client_max_body_size`. |
| `npm run db:backup`: `could not run mysqldump` | Fix `MYSQLDUMP_PATH` (step 7). |
| `npm run build` ends with `Killed` | Out of memory. Check swap with `free -h`. |
| `pm2: command not found` as `msms` | PM2 for `msms` is not installed, or its folder is not on the PATH. Run step 4's two PM2 commands (`npm config set prefix …` and the `.npm-global/bin` PATH line), then `sudo -iu msms bash -c 'pm2 -v'`. |
| `there is no Node.js at /usr/bin/node` | Step 2 did not finish. Install Node.js 24 from NodeSource, then start PM2 again. |
| Nothing runs after a reboot | Step 10's `startup` command was not run as root, or `pm2 save` was not run as `msms`. |

---

## What was verified

On the development machine (Windows, MariaDB 10.4, Node 24), against the code this guide ships with:

- All 6,043 automated checks pass. Lint, typecheck and the production build are clean, and production
  dependencies have 0 known vulnerabilities.
- File-name case was checked for Linux: 2,534 imports, 0 mismatches.
- **The settings in `deploy/aapanel/api.env.example` were run in production mode** on an empty
  database, with only secrets and this machine's paths filled in:
  - The template covers all 77 settings the application reads, and no others.
  - Migrate and seed each ran repeatedly without creating duplicates.
  - The API answered `/health/ready` on port 4100 and signed the owner in with a secure cookie.
  - A backup was written.
- A clean copy of the frontend installed with production dependencies, built, and served its pages on
  `127.0.0.1:3100`, with the API address compiled in.
- `deploy/aapanel/ecosystem.config.js` loads and defines the three processes with the folders and ports
  above.

**Not verified**, because it needs the real server:
- aaPanel's screens.
- The reverse proxy config files aaPanel writes.
- Linux, PM2 startup on boot, and `pm2-logrotate`.
- MySQL 8.
- A real SMTP delivery and a live AI request.

Step 13 is the check for all of those.
