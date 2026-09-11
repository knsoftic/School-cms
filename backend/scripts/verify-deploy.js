'use strict';

/**
 * Verification of Phase 7 / FR-DEPLOY-001 — the `deploy/` configuration set.
 *
 * ## What this suite can and cannot do, stated first because it bounds everything below
 *
 * `nginx`, `pm2` and `logrotate` are **absent from this machine**, and `mysql`/`mysqldump` are present only
 * as XAMPP's, off PATH (`MYSQLDUMP_PATH` names the dump; `scripts/restore-drill.js` uses both). So **none
 * of the nginx, PM2 or logrotate files can be validated by the tool that will consume it**. There is
 * no `nginx -t` here, no `pm2 start --dry-run`, no `logrotate -d`.
 *
 * That is a real limitation and it is not worked around, because it cannot be. What this suite does
 * instead is the thing that actually goes wrong with deployment configuration: it checks that each
 * file **agrees with the application it is deploying**. A config can be perfectly valid nginx and
 * still proxy to the wrong port, cap bodies below what the app accepts, or serve a directory the
 * app's authorization depends on never being served. Syntax validation would catch none of that.
 *
 * The one exception is `ecosystem.config.js`, which is JavaScript: `require()`-ing it is genuine
 * execution, and it earned its place immediately — the first version shipped a `SyntaxError`,
 * because a cron **step expression** (a star, a slash, a number) inside a block comment closed the comment
 * and turned the rest of the line into code. Three independent adversarial reviewers read that file
 * and none of them saw it. One `require()` found it in under a second.
 *
 * ## Why the assertions are mostly cross-references
 *
 * Every concrete number in `deploy/` has a source in `backend/src/`. `client_max_body_size` must
 * clear `MAX_UPLOAD_MB`; `kill_timeout` must exceed `SHUTDOWN_TIMEOUT_MS`; the proxy port must be
 * `config.app.port`. Asserting the deployment against the application is the only way those stay
 * true as the application changes — the same principle as §28's generated OpenAPI document.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = require('../src/config/env');

const ROOT = path.resolve(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'deploy');

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

/** Run a thunk that may throw, so a broken file fails by name rather than aborting the suite. */
function attempt(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    return typeof fallback === 'function' ? fallback(err) : fallback;
  }
}

function read(rel) {
  return attempt(() => fs.readFileSync(path.join(DEPLOY, rel), 'utf8'), '');
}

/** Strip `#` comments so a directive is not "found" inside prose about it. */
function uncommented(text, marker = '#') {
  return text
    .split('\n')
    .map((line) => {
      const at = line.indexOf(marker);
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

/* ═══════════════════════════ part 1 — the set of files ═══════════════════════════ */

const FILES = [
  'nginx/msms.conf',
  'pm2/ecosystem.config.js',
  'mysql/production.cnf',
  'env/production.env.example',
  'logrotate/msms',
  'monitoring/README.md',
];

function verifyFiles() {
  console.log('');
  console.log('── Part 1 — the artifacts §27 asks for ──');
  console.log('');

  check('deploy/ exists', fs.existsSync(DEPLOY), true);
  check('every artifact is present',
    FILES.filter((f) => !fs.existsSync(path.join(DEPLOY, f))), []);
  check('  and none is a stub',
    FILES.filter((f) => read(f).split('\n').length < 40), []);

  /*
   * §27 lists twelve items. Four of them are not files here and that is correct rather than missing:
   * Cron Jobs and Queue Workers are `src/jobs/`, Database Backup is `databaseBackup.js`, and Domain
   * is a value an operator substitutes. Asserted so that "deploy/ has six files" is never read as
   * "§27 has six items".
   */
  check('the backup is code, not a shell script duplicated into deploy/',
    [fs.existsSync(path.join(ROOT, 'backend/src/jobs/tasks/databaseBackup.js')),
      fs.existsSync(path.join(DEPLOY, 'backup'))], [true, false]);
}

/* ═══════════════ part 2 — PM2, the one file that can actually be executed ═══════════════ */

function verifyPm2() {
  console.log('');
  console.log('── Part 2 — the PM2 ecosystem file, loaded rather than read ──');
  console.log('');

  const eco = attempt(() => require(path.join(DEPLOY, 'pm2/ecosystem.config.js')), null);

  check('the ecosystem file parses and loads — PM2 would refuse to start otherwise', eco !== null, true);
  if (!eco) return;

  const apps = eco.apps || [];
  const byName = Object.fromEntries(apps.map((a) => [a.name, a]));
  const api = byName['msms-api'] || {};
  const cron = byName['msms-cron'] || {};
  const web = byName['msms-web'] || {};

  check('it defines the API, the cron scheduler and the dashboard',
    Object.keys(byName).sort(), ['msms-api', 'msms-cron', 'msms-web']);

  /*
   * Two apps, not three. `worker.js` runs one job and exits; PM2 would restart it in a loop forever.
   * Its own header records why a resident consumer is impossible: the queue is an in-process
   * `MemoryQueue`, and a shared one needs a jobs table that §29/§35 forbid.
   */
  check('  and does NOT manage the worker, which runs one job and exits',
    apps.some((a) => /worker/.test(String(a.script || ''))), false);

  /*
   * The decisive constraint, and it is the application's own words. `rateLimit.js:29-32` records
   * that the limiter's store is per-process, so "behind N workers the effective ceiling is N × the
   * configured limit", and names SRS §3 as describing a single-process deployment. Clustering the
   * API would multiply the rate limit FR-SEC-005 exists to impose.
   */
  check('the API runs as a single fork instance, because the rate limiter is per-process',
    [api.exec_mode, api.instances], ['fork', 1]);
  check('  and the cron scheduler likewise, because two schedulers double-sweep one database',
    [cron.exec_mode, cron.instances], ['fork', 1]);

  const SHUTDOWN_MS = attempt(() => {
    const src = fs.readFileSync(path.join(ROOT, 'backend/src/server.js'), 'utf8');
    return Number((src.match(/SHUTDOWN_TIMEOUT_MS\s*=\s*(\d+)/) || [])[1]);
  }, NaN);

  check('server.js still declares the shutdown budget this file is sized against', SHUTDOWN_MS, 15000);
  check('  and PM2 waits longer than it, or graceful shutdown is killed mid-flight',
    api.kill_timeout > SHUTDOWN_MS, true);

  /*
   * A script PM2 is told to run must exist, or the failure is a restart loop at 3 a.m. Resolved against
   * the app's own `cwd`, which is where PM2 resolves it — the dashboard's is `frontend/`.
   */
  check('every script PM2 is pointed at exists, from the directory it runs in',
    apps.filter((a) => a.script && !fs.existsSync(path.resolve(a.cwd || path.join(DEPLOY, 'pm2'), a.script)))
      .map((a) => a.name), []);

  /*
   * The dashboard. It serves a build rather than a source tree, on loopback, on the port its own
   * `npm start` names — the port nginx's dashboard upstream must target (Part 3).
   */
  const frontendStart = attempt(() => JSON.parse(
    fs.readFileSync(path.join(ROOT, 'frontend', 'package.json'), 'utf8')).scripts.start, '');
  check('the dashboard runs from frontend/, with Next\'s own server',
    [path.basename(String(web.cwd || '')), /next\/dist\/bin\/next$/.test(String(web.script || ''))], ['frontend', true]);
  check('  on the port frontend/package.json starts it on',
    (String(web.args || '').match(/-p\s+(\d+)/) || [])[1], (frontendStart.match(/-p\s+(\d+)/) || [])[1]);
  check('  bound to loopback, so only nginx reaches it — next start binds every interface by default',
    /-H\s+127\.0\.0\.1\b/.test(String(web.args || '')), true);
  check('  in production mode', (web.env && web.env.NODE_ENV) || null, 'production');

  check('the API runs with NODE_ENV=production',
    (api.env_production && api.env_production.NODE_ENV) || (api.env && api.env.NODE_ENV), 'production');

  /*
   * `cron.js` refuses to start unless ENABLE_CRON is true — it is the guard against a second
   * scheduler. If the ecosystem file does not set it, the cron app starts, refuses, exits 1, and
   * PM2 restarts it forever while every sweep silently never runs.
   */
  const cronEnv = { ...(cron.env || {}), ...(cron.env_production || {}) };
  check('the cron app sets ENABLE_CRON, without which it exits 1 on every start',
    String(cronEnv.ENABLE_CRON), 'true');
}

/* ═══════════════════ part 3 — nginx, checked against the application ═══════════════════ */

function verifyNginx() {
  console.log('');
  console.log('── Part 3 — the nginx site, against what the app actually serves ──');
  console.log('');

  const raw = read('nginx/msms.conf');
  const conf = uncommented(raw);

  check('the site is not empty', raw.length > 2000, true);

  /* The proxy must reach the port the app binds. */
  const upstream = (conf.match(/server\s+127\.0\.0\.1:(\d+)/) || [])[1];
  check('the upstream targets the port server.js binds', Number(upstream), config.app.port);
  check('  on loopback, so the API is unreachable except through this proxy',
    /server\s+127\.0\.0\.1:/.test(conf), true);

  /*
   * The body cap. `MAX_UPLOAD_MB` is the application's absolute ceiling (`env.js:192`); a plan's
   * `file_upload_limit` can only lower it (`upload.js:229`, `Math.min(planMb, hardMb)`). nginx must
   * sit at or above that, or it rejects with its own 413 a file the app would have accepted — and
   * the caller never sees the app's own refusal codes.
   */
  /*
   * The body cap is per-location, not one server-wide number, and the structure is the point.
   *
   * `MAX_UPLOAD_MB` (`env.js:192`) is the application's absolute ceiling; a plan's `file_upload_limit`
   * can only lower it (`upload.js:229`, `Math.min(planMb, hardMb)`). But only five routes in the whole
   * API accept a file. A single server-wide 12m would let every one of the other ~260 endpoints —
   * each of which the app caps at a 100kb JSON body — absorb a 12 MB body before Express rejected it.
   * So the server default is deliberately tight and the ceiling is raised only where a file is
   * actually accepted.
   */
  const serverDefault = Number((conf.match(/^\s*client_max_body_size\s+(\d+)m/im) || [])[1]);
  const raised = [...conf.matchAll(/client_max_body_size\s+(\d+)m/gi)].map((m) => Number(m[1]));

  check('the server default is well below the upload ceiling, so ordinary endpoints cannot absorb one',
    serverDefault < config.uploads.maxMb, true);
  check('  and above the app’s JSON body limit, so a legitimate JSON request is never cut off by nginx',
    serverDefault * 1024 > parseInt(config.app.jsonBodyLimit, 10), true);
  /*
   * `Math.max()` was the first form of this and it was too weak: with five upload locations, lowering
   * any ONE of them below the ceiling left the maximum untouched and the assertion green, while that
   * module quietly stopped accepting files. Every raised cap is checked, not the largest.
   */
  const uploadCaps = raised.filter((mb) => mb !== serverDefault);
  check('every raised cap clears the application ceiling MAX_UPLOAD_MB',
    uploadCaps.filter((mb) => mb < config.uploads.maxMb), []);
  check('  and none is wildly above it, which would forward bodies only to be refused',
    uploadCaps.filter((mb) => mb > config.uploads.maxMb * 3), []);

  /*
   * The completeness property, and the one worth having: every module that actually mounts an upload
   * must have a location raising the cap. A missed one does not fail loudly — nginx returns its own
   * 413 and the caller never reaches the app's refusal, so the module simply stops accepting files.
   */
  const uploadModules = attempt(() => {
    const dir = path.join(ROOT, 'backend/src/modules');
    return fs.readdirSync(dir).filter((mod) => {
      const routes = path.join(dir, mod, `${mod}.routes.js`);
      return fs.existsSync(routes) && /upload(Single|Array|Fields)\(/.test(fs.readFileSync(routes, 'utf8'));
    });
  }, []);

  check('every module that mounts an upload is known', uploadModules.length, 5);
  /*
   * `\b` was the first form of this boundary and it does not hold: `-` is a non-word character, so
   * `location /api/v1/homework-disabled` still matched `homework\b` and renaming a location away
   * went undetected. The location name must be followed by whitespace or the opening brace and
   * nothing else — which is also what nginx itself requires.
   */
  check('  and each has an nginx location raising the cap for it',
    uploadModules.filter((mod) => !new RegExp(`location\\s+${config.app.apiPrefix}/${mod}\\s*\\{`).test(conf)), []);

  /*
   * Written without a trailing slash on purpose. `homework.routes.js:78-79` and
   * `payments.routes.js:121-122` mount their upload on the module's BARE path (`router.post('/')`),
   * so `location /api/v1/homework/` would never match `POST /api/v1/homework` — every homework
   * attachment and payment screenshot would fall to the server default and 413.
   */
  check('  matching the bare mount, since two uploads are mounted on the module root',
    /location\s+\/api\/v1\/(homework|payments)\/\s/.test(conf), false);

  /*
   * The forwarded headers. `trust proxy` makes express-rate-limit key on X-Forwarded-For; without
   * nginx setting it every request appears to come from 127.0.0.1 and one client exhausts the
   * limit for everyone.
   */
  check('the client IP and scheme are forwarded, which trust-proxy depends on',
    ['X-Forwarded-For', 'X-Forwarded-Proto', 'Host'].filter((h) => !new RegExp(`proxy_set_header\\s+${h}\\b`, 'i').test(conf)), []);

  /*
   * **The security assertion.** `fileResponse.js` streams a stored file only after the owning module
   * has applied its permission check, re-checks the `school-<id>` segment against the record's
   * tenant, and sets `private, no-store`. A static location over the uploads directory bypasses all
   * three; upload paths are 32-hex random, so what would remain is obscurity, not authorization.
   * `docs/ARCHITECTURE.md` described exactly this until it was corrected, which is why it is pinned.
   */
  check('nginx never serves the uploads directory statically',
    /location\s+[^{]*\/uploads/i.test(conf), false);
  check('  and declares no root/alias into the storage tree at all',
    /(root|alias)\s+[^;]*\/(uploads|storage)\b/i.test(conf), false);

  check('plain HTTP is redirected to TLS', /return\s+30[18]\s+https:/.test(conf), true);
  check('  and the ACME challenge is answerable, or renewal fails silently in sixty days',
    /\.well-known\/acme-challenge/.test(conf), true);
  check('TLS is configured', /listen\s+443\s+ssl/.test(conf), true);
  /*
   * Asserted as the absence of `on` rather than the presence of `off`. `server_tokens` is set in two
   * contexts here, and `server_tokens` is per-context: switching the inner one on while the outer
   * stayed off satisfied "an `off` exists somewhere" while the server block — the one that decides —
   * announced the version.
   */
  check('nginx does not announce its version', /server_tokens\s+off/.test(conf), true);
  check('  in any context, since the innermost one wins', /server_tokens\s+on/.test(conf), false);

  /*
   * ── The dashboard origin ──
   *
   * The second site, in front of msms-web. Checked against the ecosystem file and against the one place
   * the frontend learns where the API is, because each of these fails silently: a wrong upstream port
   * is a 502 on every page, and a NEXT_PUBLIC_API_URL naming a host nginx does not serve builds a
   * dashboard that loads and then cannot sign anybody in.
   */
  const eco = attempt(() => require(path.join(DEPLOY, 'pm2/ecosystem.config.js')), { apps: [] });
  const web = (eco.apps || []).find((a) => a.name === 'msms-web') || {};
  const webPort = (String(web.args || '').match(/-p\s+(\d+)/) || [])[1];
  const webUpstream = (conf.match(/upstream\s+msms_web\s*\{[^}]*server\s+127\.0\.0\.1:(\d+)/) || [])[1];
  check('the dashboard upstream targets the port msms-web is started on, on loopback',
    [webUpstream, webUpstream === webPort], [webPort, true]);
  check('  and a TLS site proxies to it', /proxy_pass\s+http:\/\/msms_web\s*;/.test(conf), true);

  const serverNames = [...conf.matchAll(/server_name\s+([^\s;]+)\s*;/g)].map((m) => m[1]);
  const apiHost = serverNames[0];
  const webHost = serverNames.find((name) => name !== apiHost);
  check('  under its own hostname, beside the API\'s', [Boolean(apiHost), Boolean(webHost)], [true, true]);
  check('  with its own certificate', conf.includes(`/etc/letsencrypt/live/${webHost}/fullchain.pem`), true);

  /*
   * Security headers: the API's come from helmet, so the API block must not add them (two HSTS headers
   * and a browser keeps only the first); Next sets none, so the dashboard block must. Exactly one
   * uncommented HSTS line, therefore — the dashboard's — and a Next config that sets none of its own.
   */
  const nextConfig = attempt(() => fs.readFileSync(path.join(ROOT, 'frontend', 'next.config.mjs'), 'utf8'), '');
  check('HSTS is added once — for the dashboard, which nothing upstream gives it',
    [(conf.match(/add_header\s+Strict-Transport-Security/g) || []).length, /Strict-Transport-Security/.test(nextConfig)],
    [1, false]);

  /*
   * The frontend's API URL, built into the bundle, must be the API site's hostname and the prefix the
   * app mounts; and the dashboard's origin must be one the API accepts — in CORS_ORIGINS, in
   * FRONTEND_URL (which is mailed in reset links) and in nginx's own $cors_allow map.
   */
  const frontendEnv = attempt(() => fs.readFileSync(path.join(ROOT, 'frontend', '.env.example'), 'utf8'), '');
  const apiUrl = (frontendEnv.match(/^NEXT_PUBLIC_API_URL=(\S+)$/m) || [])[1] || '';
  const apiClient = attempt(() => fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'lib', 'apiClient.ts'), 'utf8'), '');
  check('the frontend documents NEXT_PUBLIC_API_URL, and the API client is what reads it',
    [Boolean(apiUrl), /process\.env\.NEXT_PUBLIC_API_URL/.test(apiClient)], [true, true]);
  check('  naming the API site nginx serves and the prefix the app mounts',
    apiUrl, `https://${apiHost}${config.app.apiPrefix}`);
  const template = read('env/production.env.example');
  const templateValue = (key) => (template.match(new RegExp(`^${key}=(\\S+)$`, 'm')) || [])[1] || '';
  check('the dashboard origin is the one the API is told to accept — CORS_ORIGINS, FRONTEND_URL, $cors_allow',
    [templateValue('CORS_ORIGINS').split(',').includes(`https://${webHost}`), templateValue('FRONTEND_URL'),
      conf.includes(`"https://${webHost}"`)],
    [true, `https://${webHost}`, true]);

  /* The API prefix the app actually mounts. */
  check('the site knows the API prefix the app mounts', raw.includes(config.app.apiPrefix), true);
}

/* ═══════════════════ part 4 — the production environment template ═══════════════════ */

function verifyEnv() {
  console.log('');
  console.log('── Part 4 — the production env template, against env.js ──');
  console.log('');

  const template = read('env/production.env.example');
  const exampleSrc = attempt(() => fs.readFileSync(path.join(ROOT, 'backend/.env.example'), 'utf8'), '');
  const envSrc = attempt(() => fs.readFileSync(path.join(ROOT, 'backend/src/config/env.js'), 'utf8'), '');

  const keysIn = (text) => [...new Set([...text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]))];
  /*
   * `NODE_ENV` is the one key env.js reads directly (`env.js:25`) rather than through a typed
   * helper, because it decides which .env file is loaded and so must be resolved before the helpers
   * exist. Counting only helper calls reports 72 and then flags the template's NODE_ENV as invented.
   */
  const readByEnvJs = [...new Set([
    ...[...envSrc.matchAll(/\b(?:str|num|bool|list)\(\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]),
    ...(/process\.env\.NODE_ENV/.test(envSrc) ? ['NODE_ENV'] : []),
  ])];

  const templateKeys = keysIn(template);
  const exampleKeys = keysIn(exampleSrc);

  check('env.js still reads the key count .env.example documents',
    [readByEnvJs.length, exampleKeys.length], [73, 73]);

  check('the production template covers every key env.js reads',
    readByEnvJs.filter((k) => !templateKeys.includes(k)), []);
  check('  and invents none that env.js would ignore',
    templateKeys.filter((k) => !readByEnvJs.includes(k)), []);

  /*
   * The template is committed, so it must carry no usable secret. A placeholder is fine; a
   * plausible-looking value is how a development secret reaches production unchanged.
   */
  const secretish = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'DB_PASSWORD', 'SUPER_ADMIN_PASSWORD',
    'ANTHROPIC_API_KEY', 'MAIL_PASSWORD', 'ONLINE_GATEWAY_SECRET'];
  const assigned = Object.fromEntries(
    [...template.matchAll(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2].trim()])
  );
  const populated = secretish.filter((k) => {
    const v = assigned[k];
    if (v === undefined || v === '') return false;
    return !/^(<|\$\{|CHANGE|REPLACE|GENERATE|__|xxx|\.\.\.)/i.test(v);
  });
  check('no secret carries a usable value', populated, []);

  /*
   * And neither does `env.js` — Known Issue 29.
   *
   * The template being clean is only half of it. `env.js:135-136` used to read
   * `str('JWT_ACCESS_SECRET', isTest ? '<a 44-character literal in this file>' : '')`, which made
   * `NODE_ENV=test` the ONE environment where `assertRuntimeConfig()` would let the process serve
   * with no configuration at all, signing real tokens with a secret committed to this repository.
   * Measured before the fix, with `.env` moved aside and restored:
   *
   *     NODE_ENV=test         BOOTS, accessSecret = 'test-access-secret-...'
   *     NODE_ENV=development  refuses
   *     NODE_ENV=production   refuses
   *
   * Asserted on the SOURCE rather than the behaviour, deliberately: `.env` is always loaded from
   * `__dirname/../..` (env.js:14), so within this repository the fallback is unreachable and no
   * runtime probe can see it without moving that file. What is checkable is that the fallback is
   * the empty string and nothing else — which catches a conditional smuggled back in for ANY
   * environment, not only `test`.
   */
  /*
   * Comment-stripped, and that is not fastidiousness. The first version of this check read the raw
   * text and matched an illustrative helper call written inside the very comment that explains the
   * fix — reporting the defect as still present on a file that no longer had it. The env-key census
   * twenty lines above reads the raw text too, and counted a second phantom key out of the same
   * comment, taking it from 73 to 74. Both went red on the first run and the comment was reworded;
   * this check reads code so the next comment cannot do it again. The census still cannot tell code
   * from prose, which is a real limitation of that assertion rather than of this one.
   */
  const envCode = envSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  const jwtFallbacks = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'].map((key) => {
    const m = new RegExp(`str\\(\\s*'${key}'\\s*,([^\\n]*)\\)`).exec(envCode);
    return [key, m ? m[1].replace(/\),?$/, '').trim() : 'NOT FOUND'];
  });
  check('env.js gives the JWT secrets no fallback a boot could survive on',
    jwtFallbacks, [['JWT_ACCESS_SECRET', "''"], ['JWT_REFRESH_SECRET', "''"]]);

  /*
   * The guard the fallback was defeating, exercised directly. `config` is a plain object, so each
   * case mutates one field, calls the real `assertRuntimeConfig()` and puts the value back — the
   * restore is in a `finally` so a thrown assertion cannot leave the process misconfigured for the
   * checks below.
   */
  const refusesWhen = (field, value) => {
    const original = config.jwt[field];
    try {
      config.jwt[field] = value;
      require('../src/config/env').assertRuntimeConfig();
      return 'accepted';
    } catch (err) {
      return /JWT_(ACCESS|REFRESH)_SECRET/.test(err.message) ? 'refused' : `refused for another reason: ${err.message}`;
    } finally {
      config.jwt[field] = original;
    }
  };
  check('  and the boot guard refuses an absent, a short and a duplicated secret',
    [refusesWhen('accessSecret', ''), refusesWhen('accessSecret', 'too-short'),
      refusesWhen('refreshSecret', config.jwt.accessSecret)],
    ['refused', 'refused', 'refused']);
  check('  while the real configuration still passes it, so the guard is not simply always red',
    refusesWhen('accessSecret', config.jwt.accessSecret), 'accepted');

  /* Production must differ from development on the settings that are unsafe if left alone. */
  check('NODE_ENV is production', assigned.NODE_ENV, 'production');
  check('TRUST_PROXY is enabled, since the app sits behind nginx',
    /^(true|1)$/i.test(String(assigned.TRUST_PROXY || '')), true);
  check('  and it defaults to false in the app, which is why the template must say so',
    config.app.trustProxy, false);
  check('the mysqldump path is not the Windows development one',
    /xampp|\.exe/i.test(String(assigned.MYSQLDUMP_PATH || '')), false);
}

/* ═══════════════════ part 5 — logrotate and the monitoring runbook ═══════════════════ */

function verifyOps() {
  console.log('');
  console.log('── Part 5 — log rotation and monitoring ──');
  console.log('');

  const rot = read('logrotate/msms');
  const mon = read('monitoring/README.md');

  check('the logrotate config is present and not a stub', rot.split('\n').length > 40, true);

  /*
   * winston-daily-rotate-file already rotates and already prunes `error-%DATE%.log` and
   * `combined-%DATE%.log`. logrotate must not manage those too — two rotators on one file is how
   * log lines vanish. What is left for it is PM2's own stdout/stderr capture.
   */
  const rotBodies = uncommented(rot);
  check('logrotate does not also manage winston’s own dated files',
    /(error|combined)-.*\.log/.test(rotBodies), false);
  check('  and it does cover the PM2 logs, which nothing else rotates',
    /pm2|out\.log|error\.log/i.test(rotBodies), true);

  /*
   * The `grep -c` trap, reproduced on this machine: `n=$(grep -c PAT f || echo 0)` yields "0\n0"
   * when there are zero matches, because grep -c prints 0 AND exits 1. Arithmetic on that fails
   * outright — so the error-rate signal breaks precisely on a healthy day.
   */
  /*
   * Tested against the runbook's *executable* lines only, with `#` comments stripped first.
   *
   * The first version of this assertion searched the raw file and failed on a runbook that was
   * already correct: the fix is accompanied by a comment explaining the trap and ending "do not
   * reintroduce the `|| echo 0`", and a substring search cannot tell a warning from the thing it
   * warns about. Naming the defect in prose is exactly what should be encouraged, so the assertion
   * had to become narrower rather than the documentation quieter.
   */
  check('no executable line uses the `grep -c ... || echo 0` idiom',
    /grep\s+-c[^\n]*\|\|\s*echo\s+0/.test(uncommented(mon)), false);
  check('  and the safe form is what the schedule actually runs',
    /now=\$\(grep -c[^)]*\);\s*now=\$\{now:-0\}/.test(uncommented(mon)), true);
  check('  with the trap itself written down, so it is not silently reintroduced',
    /do not reintroduce/i.test(mon), true);

  /* Monitoring must be built from what exists, and the health endpoints are what exists. */
  check('the runbook probes the health endpoints the app actually serves',
    [`${config.app.apiPrefix}/health`, `${config.app.apiPrefix}/health/ready`]
      .filter((p) => !mon.includes(p)), []);

  /*
   * The complementary direction, and the one that catches a typo. "Both endpoints appear somewhere"
   * stays true when one probe among five is misspelled — the others still carry the right URL, and
   * the broken probe reports a permanent 404 that reads exactly like an outage. So every health URL
   * the runbook names must be one the application actually serves.
   */
  const probed = [...new Set([...mon.matchAll(/\/api\/v1\/health[a-z/]*/g)].map((m) => m[0]))];
  check('  and names no health URL the app does not serve',
    probed.filter((url) => ![`${config.app.apiPrefix}/health`, `${config.app.apiPrefix}/health/ready`].includes(url)), []);
  check('  and says what a liveness 200 does NOT prove',
    /does not prove|cannot tell|says nothing about/i.test(mon), true);

  /*
   * §27 fixes the stack and forbids anything beyond it. A monitoring document is where an invented
   * dependency is most likely to appear.
   */
  const forbidden = ['docker', 'kubernetes', 'systemd', 'prometheus', 'grafana', 'datadog', 'sentry'];
  const all = FILES.map((f) => uncommented(read(f))).join('\n').toLowerCase();
  check('no artifact configures a technology §27 does not list',
    forbidden.filter((t) => new RegExp(`^\\s*[a-z_]*${t}`, 'm').test(all)), []);

  /*
   * Redis is checked separately from the keyword ban above, because the env template *must* mention
   * it: `REDIS_URL` and `CACHE_DRIVER` are real keys `env.js` reads, and the template's whole job is
   * to say what they should be set to. A blanket keyword ban flagged the very comment explaining why
   * Redis is not used. What matters is not whether it is named but whether it is left DISABLED.
   */
  const envTemplate = read('env/production.env.example');
  const setting = (key) => {
    const found = envTemplate.match(new RegExp(`^\\s*${key}=(.*)$`, 'm'));
    return found ? found[1].trim() : null;
  };
  check('Redis is named only in order to be left off — §27 does not list it',
    [setting('REDIS_URL'), setting('CACHE_DRIVER'), setting('QUEUE_DRIVER')], ['', 'memory', 'memory']);
}

/* ═══════════════════════ part 6 — the lint toolchain, Known Issue 6 ═══════════════════════ */

/**
 * `npm run lint` has to actually run, and has to actually pass.
 *
 * `eslint ^8.57.1` was a dependency and the `lint` script was wired for twenty-five sessions with **no
 * config file anywhere**, so the command exited non-zero on a ValidationError and nothing was ever
 * linted. Adding a config is only half of it: a config nobody runs is how the nine errors it first
 * reported would quietly come back. So the command is run here, in the loop, and its exit code is the
 * assertion.
 *
 * Cheap enough to belong in the loop rather than in a separate ritual: measured at **2.5 seconds**
 * over the 222 files of the target.
 *
 * ESLint is **not an SRS requirement** — the word appears nowhere in the 1,698 lines — so nothing here
 * claims otherwise. It is repository hygiene, and the checklist files it as such.
 */
function verifyLint() {
  console.log('');
  console.log('── Part 6 — the lint toolchain ──');

  const configPath = path.join(ROOT, 'backend', '.eslintrc.json');
  check('an ESLint config exists, without which the command dies before linting anything',
    fs.existsSync(configPath), true);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend', 'package.json'), 'utf8'));
  /*
   * Pinned, because the target is easy to widen by accident and easy to narrow by accident. It is
   * `src tests` today and **not** `scripts` — the 39 verification suites are outside it and hold 46
   * errors of their own, measured 2026-09-09: 22 `no-inner-declarations`, 19 `no-unused-vars`, 2
   * `no-useless-escape`, and one each of `no-regex-spaces`, `import/no-dynamic-require` and
   * `no-irregular-whitespace`. The whole breakdown is recorded rather than the two largest, because
   * the previous note said "45" and listed 41 of them, and the four it did not name are exactly the
   * ones that could drift without anyone noticing. Clearing them is a separate job.
   * Recording the exclusion here means "lint passes" cannot be read as "everything is linted".
   */
  check('and the lint target is the one this check measured', pkg.scripts.lint, 'eslint src tests');

  /*
   * `--max-warnings 0` is deliberate even though the config declares no warnings: a rule downgraded
   * to "warn" would otherwise make the exit code green while the finding stayed.
   */
  const run = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['eslint', 'src', 'tests', '--max-warnings', '0'],
    { cwd: path.join(ROOT, 'backend'), encoding: 'utf8', shell: process.platform === 'win32' }
  );
  const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
  check('  and `npm run lint` passes over it',
    run.status === 0 ? 'clean' : `exit ${run.status}: ${output.split('\n').slice(-3).join(' | ').slice(0, 300)}`,
    'clean');

  /*
   * ## The frontend half, which had the same defect for longer and worse
   *
   * The backend's version of this was a script wired to a command with no config. The frontend's was
   * a script wired to a command that **no longer exists**: Next 16 removed `next lint` and stopped
   * `next build` linting, so `npm run lint` failed outright and there was no eslint configuration of
   * any kind. `docs/VERIFICATION.md` recorded it, and the consequence is larger than the backend's
   * ever was — **every screen in the product was written after that upgrade**, so none had ever been
   * linted. The first run reported 83 problems and seventeen of them were real, including eight
   * `<a href>` internal links doing a full page reload where `<Link>` belongs.
   *
   * Asserted the same way and for the same reason: a config nobody runs is how those come back.
   */
  const frontendConfig = path.join(ROOT, 'frontend', 'eslint.config.mjs');
  check('the frontend has an ESLint config too — flat, which is the only shape Next 16 reads',
    fs.existsSync(frontendConfig), true);

  const frontendPkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'frontend', 'package.json'), 'utf8')
  );
  /* `next lint` was removed in Next 16; a script still pointing at it is the defect, not the fix. */
  check('  and its lint script calls ESLint directly rather than the removed `next lint`',
    frontendPkg.scripts.lint, 'eslint .');

  const frontendRun = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['eslint', '.', '--max-warnings', '0'],
    { cwd: path.join(ROOT, 'frontend'), encoding: 'utf8', shell: process.platform === 'win32' }
  );
  const frontendOutput = `${frontendRun.stdout || ''}${frontendRun.stderr || ''}`.trim();
  check('  and it passes over the whole frontend',
    frontendRun.status === 0
      ? 'clean'
      : `exit ${frontendRun.status}: ${frontendOutput.split('\n').slice(-3).join(' | ').slice(0, 300)}`,
    'clean');
}

/* ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Part 7 — what must never reach the repository.
 *
 * `.gitignore` names runtime storage under SRS §26 and looked correct. It was not: a pattern with a
 * slash anywhere but at the end is **anchored to the file's own directory**, so `storage/logs/`
 * matched `<repo>/storage/logs/` — a path that does not exist — and never `backend/storage/logs/`,
 * which is the one that does. Eleven runtime files were tracked as a result: ten rotated log archives
 * and an uploaded student photo.
 *
 * The logs are not inert. `.env` sets `MAIL_DRIVER=log` and `mailService.js` says in its own header
 * that this renders the message into the application log — *"a reset link appears in
 * `storage/logs`"* — so every password-reset mail sent in development is written there.
 *
 * Asserted two ways on purpose. The **patterns** are checked because they are the thing that was
 * wrong, and `git ls-files` is checked because a pattern only governs what is not already tracked:
 * fixing the first without the second leaves every existing file in the index, which is exactly the
 * state this was found in. Neither assertion alone would have caught it.
 */
function verifyRepositoryHygiene() {
  console.log('');
  console.log('── Part 7 — what must never reach the repository ──');

  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const dir of ['logs', 'uploads', 'backups', 'tmp']) {
    check(
      `storage/${dir} is ignored at any depth, not only at the repository root`,
      ignore.includes(`**/storage/${dir}/`),
      true
    );
  }

  /*
   * `git ls-files` rather than a directory walk: the question is what the **index** holds, and a file
   * on disk that git has never been told about is not the problem. `-z` and a split on NUL, because a
   * path may contain anything but a NUL.
   */
  const tracked = spawnSync('git', ['ls-files', '-z', '--', '*/storage/logs/*', '*/storage/uploads/*',
    '*/storage/backups/*', '*/storage/tmp/*'], { cwd: ROOT, encoding: 'utf8' });
  const trackedFiles = (tracked.stdout || '').split('\0').filter(Boolean);
  check('and no runtime file is tracked, whatever the patterns say', trackedFiles, []);

  /* The one that would matter most, kept as its own assertion so a failure names it. */
  const env = spawnSync('git', ['ls-files', '-z', '--', '*.env', '.env'], { cwd: ROOT, encoding: 'utf8' });
  check('no .env is tracked either',
    (env.stdout || '').split('\0').filter(Boolean), []);
}

function main() {
  verifyFiles();
  verifyPm2();
  verifyNginx();
  verifyEnv();
  verifyOps();
  verifyLint();
  verifyRepositoryHygiene();
}

try {
  main();
} catch (err) {
  failures += 1;
  console.error('\nverify-deploy crashed:', err);
}

console.log('');
console.log(failures === 0 ? 'All deployment checks passed.' : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
