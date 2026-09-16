'use strict';

/**
 * PM2 ecosystem for the aaPanel server — docs/DEPLOY-AAPANEL.md, step 10.
 *
 * aaPanel gives each website its own folder, and this deployment puts one clone of the repository in
 * each: the API site's folder runs `backend/`, the web app site's folder runs `frontend/`. The VPS file
 * in deploy/pm2/ assumes both halves sit side by side in one checkout, so it cannot reach two folders;
 * this one names them absolutely. Everything else is that file's decision, kept for that file's reasons:
 *
 *   msms-api    one instance, fork mode — the entitlement cache and rate limiter live in its memory
 *   msms-cron   exactly one — two schedulers would send every notification twice
 *   msms-web    `next start`, bound to loopback so only the web server's reverse proxy reaches it
 *
 * Run it as the `msms` user (the guide's step 3), never as root:
 *   pm2 start /www/wwwroot/school-api.knbazaar.com/deploy/aapanel/ecosystem.config.js
 *
 * PM2 keeps its own log files in ~/.pm2/logs; `pm2 install pm2-logrotate` (step 10) trims them.
 */

const fs = require('fs');
const path = require('path');

/** The API site's folder — aaPanel → Website → school-api.knbazaar.com. */
const API_SITE = '/www/wwwroot/school-api.knbazaar.com';

/** The web app site's folder — aaPanel → Website → school.knbazaar.com. */
const WEB_SITE = '/www/wwwroot/school.knbazaar.com';

/**
 * The web app's port. The API's port is PORT in backend/.env (4100). Neither is the common 3000/4000,
 * because other Node apps on the same server usually already hold those. aaPanel's reverse proxy for
 * school.knbazaar.com must point at this port.
 */
const WEB_PORT = 3100;

const BACKEND = path.join(API_SITE, 'backend');
const FRONTEND = path.join(WEB_SITE, 'frontend');

/**
 * Node.js 24 from NodeSource (guide step 2). Pinned by path, not left to PATH: this server also has an
 * older Node.js from before, and whichever comes first in the PATH of whoever starts PM2 — root at boot,
 * msms by hand — would otherwise decide which one runs the application.
 */
const NODE = '/usr/bin/node';

/*
 * Checked on the server, not on a Windows development machine where these paths cannot exist. A wrong
 * folder otherwise reaches PM2 as "Script not found", which says nothing about the cause.
 */
if (process.platform !== 'win32') {
  /*
   * PM2 reads this file as whoever runs `pm2 start`. Started as root, the three apps join root's PM2 —
   * beside this server's other projects, running the application as root, invisible to `msms`'s
   * `pm2 list`, and brought back at boot by root's dump. That happened on this server, so it is refused.
   */
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error(
      'ecosystem.config.js: do not start this as root. Start it as the msms user: '
      + 'sudo -iu msms pm2 start /www/wwwroot/school-api.knbazaar.com/deploy/aapanel/ecosystem.config.js '
      + '(docs/DEPLOY-AAPANEL.md, step 10).'
    );
  }
  if (!fs.existsSync(NODE)) {
    throw new Error(
      `ecosystem.config.js: there is no Node.js at ${NODE}. Install Node.js 24 from NodeSource first `
      + '(docs/DEPLOY-AAPANEL.md, step 2).'
    );
  }
  for (const [label, dir] of [['the API (backend/)', BACKEND], ['the web app (frontend/)', FRONTEND]]) {
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      throw new Error(
        `ecosystem.config.js: expected ${label} at ${dir}, and there is no package.json there. `
        + 'Clone the repository into that site folder first (docs/DEPLOY-AAPANEL.md, step 6).'
      );
    }
  }
}

const shared = {
  interpreter: NODE,
  vizion: false,
  time: true,
  exp_backoff_restart_delay: 100,
  min_uptime: 30000,
  max_restarts: 20,
};

module.exports = {
  apps: [
    {
      name: 'msms-api',
      script: 'src/server.js',
      cwd: BACKEND,
      ...shared,
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      /* Above server.js's own 15 s graceful shutdown, so a restart lets requests finish. */
      kill_timeout: 20000,
      wait_ready: false,
      autorestart: true,
      max_memory_restart: '512M',
    },
    {
      name: 'msms-cron',
      script: 'src/jobs/cron.js',
      cwd: BACKEND,
      ...shared,
      instances: 1,
      exec_mode: 'fork',
      /*
       * ENABLE_CRON belongs to this process only: backend/.env keeps it false, so a scheduler started
       * by hand refuses to run beside this one. Its own log folder, so the two processes never rotate
       * the same file.
       */
      env: {
        NODE_ENV: 'production',
        ENABLE_CRON: 'true',
        LOG_DIR: '/www/msms-data/logs/cron',
      },
      autorestart: true,
    },
    {
      name: 'msms-web',
      script: 'node_modules/next/dist/bin/next',
      args: `start -p ${WEB_PORT} -H 127.0.0.1`,
      cwd: FRONTEND,
      ...shared,
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      autorestart: true,
    },
  ],
};
