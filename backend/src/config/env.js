'use strict';

/**
 * Environment loading + validation.
 *
 * Fails fast on a bad configuration rather than surfacing a confusing runtime error later.
 * Every key here maps to an entry in .env.example (SRS §27 "Environment Variables").
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..', '..');

// Load .env.test first when running tests so test runs never touch the dev database.
const envFiles =
  process.env.NODE_ENV === 'test' ? ['.env.test', '.env'] : ['.env'];

for (const file of envFiles) {
  const full = path.join(ROOT, file);
  if (fs.existsSync(full)) dotenv.config({ path: full });
}

const NODE_ENV = process.env.NODE_ENV || 'development';

/** @returns {string} */
function str(key, fallback) {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (fallback === undefined) return '';
    return fallback;
  }
  return value;
}

/** @returns {number} */
function num(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, received "${raw}"`);
  }
  return parsed;
}

/** @returns {boolean} */
function bool(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

/** @returns {string[]} */
function list(key, fallback = []) {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const isTest = NODE_ENV === 'test';
const isProduction = NODE_ENV === 'production';

/**
 * Express's `trust proxy` setting, which decides what `req.ip` is.
 *
 * It matters beyond cosmetics: the rate limiter keys on `req.ip`, so trusting a proxy that is not
 * really there lets a caller set their own `X-Forwarded-For` and get a fresh quota per request, while
 * failing to trust a real one collapses every client behind it onto one shared quota. Neither is safe
 * to guess, so the default is `false` — correct when the app is exposed directly — and a deployment
 * behind nginx sets `TRUST_PROXY=1` for one hop.
 *
 * Accepted forms mirror Express's own: a hop count (`1`), a boolean, or a subnet/name list
 * (`loopback`, `10.0.0.0/8`).
 *
 * @returns {boolean|number|string}
 */
function trustProxy() {
  const raw = str('TRUST_PROXY', '').trim();
  if (raw === '') return false;

  const lowered = raw.toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  if (['true', 'yes', 'on'].includes(lowered)) return true;

  const hops = Number(raw);
  if (Number.isInteger(hops) && hops >= 0) return hops;

  /* A subnet or named range list — handed to Express verbatim, which knows how to read it. */
  return raw;
}

const config = {
  env: NODE_ENV,
  isTest,
  isProduction,
  isDevelopment: NODE_ENV === 'development',

  app: {
    name: str('APP_NAME', 'Multi-School Management System'),
    port: num('PORT', 4000),
    apiPrefix: str('API_PREFIX', '/api/v1'),
    url: str('APP_URL', 'http://localhost:4000'),
    frontendUrl: str('FRONTEND_URL', 'http://localhost:3000'),
    corsOrigins: list('CORS_ORIGINS', ['http://localhost:3000']),
    trustProxy: trustProxy(),
    /*
     * The cap on a JSON / urlencoded body, separate from `MAX_UPLOAD_MB`, which bounds a multipart
     * file. Express's own default is 100kb and that is kept — every endpoint in the SRS submits a
     * form, not a document, and the one bulk path (§21's AI source material) arrives as a file.
     * Configurable because a future bulk-import endpoint is the kind of thing that needs it raised
     * for one deployment without a code change.
     */
    jsonBodyLimit: str('JSON_BODY_LIMIT', '100kb'),
    rootDir: ROOT,
  },

  db: {
    host: str('DB_HOST', '127.0.0.1'),
    port: num('DB_PORT', 3306),
    name: isTest ? str('DB_NAME_TEST', 'msms_test') : str('DB_NAME', 'msms'),
    user: str('DB_USER', 'root'),
    password: str('DB_PASSWORD', ''),
    poolMax: num('DB_POOL_MAX', 15),
    poolMin: num('DB_POOL_MIN', 0),
    logging: bool('DB_LOGGING', false),
    timezone: str('DB_TIMEZONE', '+00:00'),
  },

  jwt: {
    /*
     * No fallback, and specifically **no `isTest` fallback** — Known Issue 29.
     *
     * These two lines used to give each secret a fallback of the form
     * “if isTest then a 44-character literal written here, else the empty string”, which made
     * `NODE_ENV=test` the one environment in the application where
     * `assertRuntimeConfig()` below would let the process **serve** with no configuration at all —
     * signing real access and refresh tokens with a secret committed to this repository.
     *
     * Measured, with `.env` moved aside and restored:
     *
     *     NODE_ENV=test         BOOTS, accessSecret = 'test-access-secret-…'   <- the whole defect
     *     NODE_ENV=development  refuses
     *     NODE_ENV=production   refuses
     *
     * Removing it is subtractive and a proven no-op everywhere it matters: `.env` and
     * `.env.example` both set the two keys, so with either present the config is byte-identical
     * under any NODE_ENV. Exactly one case changes, from BOOTS to refuses, and it is the unsafe one.
     *
     * The env-key census is unaffected: `verify-deploy.js:315` matches a typed-helper call by its key
     * name whatever the second argument is, so both keys still count toward its `[73, 73]`. Note that
     * the census scans this file as TEXT, comments included — an illustrative helper call written out
     * in a comment here would be counted as a real environment key. It cost one red run to learn.
     */
    accessSecret: str('JWT_ACCESS_SECRET', ''),
    refreshSecret: str('JWT_REFRESH_SECRET', ''),
    accessExpiresIn: str('JWT_ACCESS_EXPIRES_IN', '15m'),
    refreshExpiresIn: str('JWT_REFRESH_EXPIRES_IN', '7d'),
    issuer: str('JWT_ISSUER', 'msms'),
    audience: str('JWT_AUDIENCE', 'msms-api'),
    algorithm: 'HS256',
  },

  security: {
    bcryptRounds: num('BCRYPT_ROUNDS', isTest ? 4 : 12),
    passwordResetTtlMinutes: num('PASSWORD_RESET_TOKEN_TTL_MINUTES', 60),
    emailVerificationTtlHours: num('EMAIL_VERIFICATION_TOKEN_TTL_HOURS', 48),
    /*
     * The floor on a new password. The SRS states no policy, so this is the weakest rule that is
     * still defensible, and it is a number rather than a regex on purpose: a composition rule
     * ("one upper, one digit, one symbol") narrows the search space an attacker has to cover and
     * pushes users towards `Passw0rd!`, which is why NIST SP 800-63B dropped the recommendation.
     * Length is the property that helps.
     */
    passwordMinLength: num('PASSWORD_MIN_LENGTH', 8),
    /*
     * Failed logins before the account is locked, and for how long. `users.failed_login_attempts`
     * and `users.locked_until` exist for this and `authenticate` already refuses a locked account;
     * without a writer those two columns would be schema that can never be true.
     *
     * Not an SRS requirement — §24 asks for "API Security" and rate limiting, which `authLimiter`
     * covers per IP. This covers the other axis: a distributed attempt against one known account,
     * which no per-IP limit sees. A temporary lock rather than a permanent one, because a permanent
     * lock lets anybody who knows an email address disable that person's account.
     */
    maxLoginAttempts: num('LOGIN_MAX_ATTEMPTS', 5),
    lockoutMinutes: num('LOGIN_LOCKOUT_MINUTES', 15),
    csrfEnabled: bool('CSRF_ENABLED', !isTest),
    csrfCookieName: str('CSRF_COOKIE_NAME', 'msms_csrf'),
    refreshCookieName: str('REFRESH_COOKIE_NAME', 'msms_refresh'),
  },

  superAdmin: {
    name: str('SUPER_ADMIN_NAME', 'Platform Owner'),
    email: str('SUPER_ADMIN_EMAIL', 'superadmin@msms.local'),
    username: str('SUPER_ADMIN_USERNAME', 'superadmin'),
    password: str('SUPER_ADMIN_PASSWORD', 'SuperAdmin@123'),
  },

  rateLimit: {
    windowMinutes: num('RATE_LIMIT_WINDOW_MINUTES', 15),
    max: num('RATE_LIMIT_MAX', 1000),
    authMax: num('AUTH_RATE_LIMIT_MAX', 20),
    aiMax: num('AI_RATE_LIMIT_MAX', 60),
    enabled: !isTest,
  },

  uploads: {
    dir: path.isAbsolute(str('UPLOAD_DIR', 'storage/uploads'))
      ? str('UPLOAD_DIR', 'storage/uploads')
      : path.join(ROOT, str('UPLOAD_DIR', 'storage/uploads')),
    maxMb: num('MAX_UPLOAD_MB', 10),
  },

  cache: {
    driver: str('CACHE_DRIVER', 'memory'),
    redisUrl: str('REDIS_URL', ''),
    ttlSeconds: num('CACHE_TTL_SECONDS', 300),
  },

  queue: {
    driver: str('QUEUE_DRIVER', 'memory'),
    concurrency: num('QUEUE_CONCURRENCY', 3),
    enableWorker: bool('ENABLE_QUEUE_WORKER', false),
  },

  mail: {
    driver: str('MAIL_DRIVER', 'log'),
    host: str('MAIL_HOST', ''),
    port: num('MAIL_PORT', 587),
    secure: bool('MAIL_SECURE', false),
    user: str('MAIL_USER', ''),
    password: str('MAIL_PASSWORD', ''),
    from: str('MAIL_FROM', 'Multi-School Management System <no-reply@msms.local>'),
  },

  ai: {
    driver: isTest ? 'mock' : str('AI_DRIVER', 'anthropic'),
    model: str('AI_MODEL', 'claude-opus-5'),
    apiKey: str('ANTHROPIC_API_KEY', ''),
  },

  payments: {
    enabledGateways: list('PAYMENT_GATEWAYS', [
      'cash',
      'bank_transfer',
      'manual_payment',
      'wallet',
      'online_gateway',
    ]),
    onlineGateway: {
      key: str('ONLINE_GATEWAY_KEY', 'online_gateway'),
      label: str('ONLINE_GATEWAY_LABEL', 'Online Gateway'),
      apiKey: str('ONLINE_GATEWAY_API_KEY', ''),
      secret: str('ONLINE_GATEWAY_SECRET', ''),
      webhookSecret: str('ONLINE_GATEWAY_WEBHOOK_SECRET', ''),
    },
  },

  logging: {
    level: str('LOG_LEVEL', isTest ? 'error' : 'info'),
    dir: path.isAbsolute(str('LOG_DIR', 'storage/logs'))
      ? str('LOG_DIR', 'storage/logs')
      : path.join(ROOT, str('LOG_DIR', 'storage/logs')),
    retentionDays: num('LOG_RETENTION_DAYS', 30),
    /**
     * Also write the log to stdout. The default is what the logger always did — on in development, off
     * in production and in tests — so nothing changes unless a deployment asks.
     *
     * Hostinger's managed Node.js hosting is the deployment that asks. Its **Runtime logs** panel shows
     * stdout and stderr and nothing else, and with this off a healthy production start printed nothing
     * there at all: the only line an operator could ever see was `Failed to start:`, which `server.js`
     * writes to stderr directly. Found by booting the Hostinger configuration in production mode, whose
     * probe waited two minutes for a "listening" line that went only to a file.
     */
    console: bool('LOG_CONSOLE', !isProduction && !isTest),
  },

  backup: {
    dir: path.isAbsolute(str('BACKUP_DIR', 'storage/backups'))
      ? str('BACKUP_DIR', 'storage/backups')
      : path.join(ROOT, str('BACKUP_DIR', 'storage/backups')),
    retentionDays: num('BACKUP_RETENTION_DAYS', 30),
    mysqldumpPath: str('MYSQLDUMP_PATH', 'mysqldump'),
  },

  cron: {
    enabled: bool('ENABLE_CRON', false),
    /**
     * Run the scheduler inside the API process instead of as `npm run cron`.
     *
     * For hosts that run exactly one process per app and give it no second one — Hostinger's managed
     * Node.js hosting is the case this exists for (`docs/DEPLOY-HOSTINGER.md`). On a server with PM2,
     * leave it off and run `cron.js` as its own process, as `deploy/pm2/ecosystem.config.js` does.
     *
     * Separate from `ENABLE_CRON` on purpose. That key licenses the *resident cron process*, and a
     * VPS's API and cron processes read the same `.env` — so if one key meant both, turning the
     * scheduler on would start it twice against one database and double every notification.
     * `cron.js` refuses resident mode while this is on, so the two cannot both be scheduling.
     */
    inApi: bool('CRON_IN_API', false),
    /** Task names to leave out of the schedule — on a host with no `mysqldump`, `database-backup`. */
    skip: list('CRON_SKIP', []),
  },

  boot: {
    /**
     * Apply pending migrations and the mandatory seed before the API accepts traffic.
     *
     * For hosts where nobody can run `npm run db:migrate` by hand. Both halves are idempotent —
     * `migrator.up()` applies only what `SequelizeMeta` does not record, and the seed finds and keeps
     * rows that already exist (it never changes an existing password) — so it is safe on every start.
     * Off by default: on a VPS, migrating is a deliberate step taken before the new code is started.
     */
    migrate: bool('MIGRATE_ON_BOOT', false),
  },
};

/**
 * Configuration that must be present before the process is allowed to serve traffic.
 * Kept out of module load so the migration CLI can run without full app config.
 */
function assertRuntimeConfig() {
  const errors = [];

  if (!config.jwt.accessSecret || config.jwt.accessSecret.length < 32) {
    errors.push('JWT_ACCESS_SECRET must be set and at least 32 characters long.');
  }
  if (!config.jwt.refreshSecret || config.jwt.refreshSecret.length < 32) {
    errors.push('JWT_REFRESH_SECRET must be set and at least 32 characters long.');
  }
  if (config.jwt.accessSecret === config.jwt.refreshSecret) {
    errors.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.');
  }
  if (!config.db.name) errors.push('DB_NAME must be set.');

  if (config.isProduction) {
    if (config.jwt.accessSecret.startsWith('change-me')) {
      errors.push('JWT_ACCESS_SECRET still holds its placeholder value.');
    }
    if (config.jwt.refreshSecret.startsWith('change-me')) {
      errors.push('JWT_REFRESH_SECRET still holds its placeholder value.');
    }
    if (config.ai.driver === 'anthropic' && !config.ai.apiKey) {
      errors.push('ANTHROPIC_API_KEY must be set when AI_DRIVER=anthropic.');
    }
    /*
     * The one development default that fails *silently* in production.
     *
     * `log` is right for a developer with no SMTP server — `mailService.js` writes the message into
     * the application log. Left on in production it does the same thing, and nothing looks wrong: a
     * password reset answers "check your email", the link goes to a file on the server, and the person
     * locked out of their account never receives it. FR-AUTH-005 and FR-AUTH-006 require those links
     * to be *sent*. A misconfigured JWT secret stops the process; this one would have let it serve
     * for weeks before anybody noticed, which is the stronger reason to stop it.
     */
    if (config.mail.driver === 'log') {
      errors.push(
        'MAIL_DRIVER=log writes password-reset and verification links to a log file and emails nobody. ' +
          'Set MAIL_DRIVER=smtp with MAIL_HOST, MAIL_PORT, MAIL_USER and MAIL_PASSWORD.'
      );
    }
    /* A scheduler started inside the API and a resident `cron.js` would both sweep one database. */
    if (config.cron.inApi && config.cron.enabled) {
      errors.push(
        'CRON_IN_API and ENABLE_CRON are both true. Choose one: CRON_IN_API for a host with a single ' +
          'process (Hostinger web hosting), ENABLE_CRON for a separate cron process (PM2 on a VPS).'
      );
    }
  }

  if (errors.length) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
  }
}

module.exports = config;
module.exports.assertRuntimeConfig = assertRuntimeConfig;
