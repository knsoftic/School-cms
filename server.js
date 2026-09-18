/**
 * Production start file for hosts that ask for an entry file — Hostinger's managed Node.js hosting
 * (`docs/DEPLOY-HOSTINGER.md`). On a VPS, PM2 runs `next start` directly and this file is not used.
 *
 * ## Why it exists at all
 *
 * Hostinger's Node.js apps start from an entry file ending in `.js`, and assign the port themselves.
 * `package.json`'s `start` script is `next start -p 3000` — the port is pinned because
 * `deploy/pm2/ecosystem.config.js` and Nginx's upstream must agree on it, and `verify-deploy.js` holds
 * them together. A pinned port is wrong on a host that chooses it, so this file reads `PORT` instead
 * and leaves the VPS contract untouched. It is Next's documented custom-server pattern
 * (`node_modules/next/dist/docs/01-app/02-guides/custom-server.md`), with two changes.
 *
 * ## The two changes from the documented example
 *
 *   1. **Production unless told otherwise.** The example starts Next in development mode whenever
 *      `NODE_ENV !== 'production'`. On a hosting dashboard where one variable is easy to miss, that
 *      turns a forgotten setting into a live site running the dev server — slow, and with its error
 *      overlay on public pages. Here it is development only when `NODE_ENV=development` is explicit.
 *   2. **It says where it failed.** `app.prepare()` rejects when there is no build (`next build` never
 *      ran, or ran in another folder). The example leaves that as an unhandled rejection; here it is a
 *      one-line reason and a non-zero exit, which the host's runtime log shows as a failed start.
 */

'use strict';

const { createServer } = require('http');
const next = require('next');

const port = Number.parseInt(process.env.PORT || '3000', 10);
const dev = process.env.NODE_ENV === 'development';

const app = next({ dev, dir: __dirname });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    createServer((req, res) => handle(req, res)).listen(port, () => {
      console.log(`MSMS web listening on port ${port} (${dev ? 'development' : 'production'})`);
    });
  })
  .catch((err) => {
    console.error(`MSMS web failed to start: ${err.message}`);
    if (!dev) console.error('Has `npm run build` run in this folder? The production server needs its output.');
    process.exit(1);
  });
