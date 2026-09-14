'use strict';

/**
 * Assemble the web app as Hostinger runs it: already built, nothing left to compile.
 *
 *     node deploy/hostinger/bundle-frontend.js <frontend-dir> <output-dir>
 *
 * Run by `.github/workflows/hostinger-frontend.yml` after `next build`, whose output this copies into a
 * directory that becomes the `hostinger-frontend` branch — the branch Hostinger's web app deploys from.
 *
 * ## Why the build does not happen on Hostinger
 *
 * Next.js 16 builds with Turbopack, which needs the native compiler `@next/swc-linux-x64-gnu`, and
 * Tailwind 4 needs native engines too. On Hostinger's Business web hosting that compiler installs and
 * then **cannot load**: the build servers' GLIBC is older than the binary requires, so Next falls back
 * to WebAssembly bindings that cannot run Turbopack, and the build fails. No package version changes
 * the servers' GLIBC, so upgrading Next.js does not fix it.
 *
 * **Running** a built app needs none of that. Verified before this file was written: the production
 * build served every route, dynamic ones included, with the native compiler and both Tailwind engines
 * removed from `node_modules`, and no mention of SWC in its log. The app uses no `next/image`, so `sharp`
 * — the other GLIBC-bound native module — is never loaded either. So the build moves to a GitHub
 * runner with a current Linux, and Hostinger only installs dependencies and starts `server.js`.
 *
 * ## What is copied, and what is changed
 *
 * The build output `.next/` without its caches, `public/`, `server.js` and the files Next reads at
 * start. `package.json` keeps its dependencies byte-for-byte — the lockfile must still match it or an
 * `npm ci` on Hostinger refuses — and changes only two scripts: `build` becomes a no-op, so a host
 * preset that runs it anyway cannot trigger the failing compile, and `start` runs `server.js`, which
 * listens on the port the host assigns rather than `next start`'s pinned 3000.
 */

const fs = require('fs');
const path = require('path');

const [, , frontendArg, outputArg] = process.argv;
if (!frontendArg || !outputArg) {
  console.error('usage: node deploy/hostinger/bundle-frontend.js <frontend-dir> <output-dir>');
  process.exit(2);
}
const FRONTEND = path.resolve(frontendArg);
const OUTPUT = path.resolve(outputArg);

/** Refuse to assemble from a folder that has not been built — a branch without a build serves nothing. */
const buildId = path.join(FRONTEND, '.next', 'BUILD_ID');
if (!fs.existsSync(buildId)) {
  console.error(`No build at ${path.join(FRONTEND, '.next')} — run \`npm run build\` in ${FRONTEND} first.`);
  process.exit(1);
}

fs.rmSync(OUTPUT, { recursive: true, force: true });
fs.mkdirSync(OUTPUT, { recursive: true });

/*
 * `cache` is the build cache and `dev` is `next dev`'s own output; neither is read by a production server,
 * and `cache` alone is often larger than everything else. `diagnostics` and `trace` are build telemetry.
 */
const SKIP_IN_NEXT = new Set(['cache', 'dev', 'diagnostics', 'trace']);
fs.cpSync(path.join(FRONTEND, '.next'), path.join(OUTPUT, '.next'), {
  recursive: true,
  filter: (source) => {
    const relative = path.relative(path.join(FRONTEND, '.next'), source);
    return !SKIP_IN_NEXT.has(relative.split(path.sep)[0]);
  },
});

if (fs.existsSync(path.join(FRONTEND, 'public'))) {
  fs.cpSync(path.join(FRONTEND, 'public'), path.join(OUTPUT, 'public'), { recursive: true });
}

/*
 * `next.config.mjs` is evaluated when the server starts, and `tsconfig.json` is read by Next's config
 * loading in a TypeScript project. `package-lock.json` pins exactly what the verified build used.
 */
for (const file of ['server.js', 'next.config.mjs', 'tsconfig.json', 'package-lock.json']) {
  const source = path.join(FRONTEND, file);
  if (!fs.existsSync(source)) {
    console.error(`Missing ${file} in ${FRONTEND}`);
    process.exit(1);
  }
  fs.copyFileSync(source, path.join(OUTPUT, file));
}

const pkg = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'package.json'), 'utf8'));
pkg.scripts = {
  build: 'echo "Built by GitHub Actions (.github/workflows/hostinger-frontend.yml) - nothing to compile here."',
  start: 'node server.js',
};
fs.writeFileSync(path.join(OUTPUT, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

fs.writeFileSync(
  path.join(OUTPUT, 'README.md'),
  [
    '# hostinger-frontend — generated, do not edit',
    '',
    'This branch is the web app, already built, as Hostinger runs it. It is rewritten by',
    '`.github/workflows/hostinger-frontend.yml` on every push to `master` that touches `frontend/`.',
    'Change the source on `master`; anything committed here is replaced by the next build.',
    '',
    'Hostinger: deploy this branch with Node.js 24, no build step, and entry file `server.js`.',
    'Why the build does not happen on Hostinger: `deploy/hostinger/bundle-frontend.js` on `master`.',
    '',
  ].join('\n')
);

const count = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, entry) => n + (entry.isDirectory() ? count(path.join(dir, entry.name)) : 1), 0);
console.log(`Bundled build ${fs.readFileSync(buildId, 'utf8').trim()} into ${OUTPUT} (${count(OUTPUT)} files).`);
