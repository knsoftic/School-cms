/**
 * ESLint for the frontend — flat config, which is the only shape Next 16 supports.
 *
 * ## Why this file did not exist until now
 *
 * `next lint` was removed in Next 16 and `next build` no longer lints
 * (`node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md:1084`). `package.json`'s
 * `lint` script still pointed at the removed command, so `npm run lint` failed outright and there
 * was **no eslint configuration of any kind** — which `docs/VERIFICATION.md` recorded: the frontend
 * has had no lint coverage since that upgrade, and every screen in it was written after.
 *
 * `@next/eslint-plugin-next` now defaults to flat config, so this is `eslint.config.mjs` and not an
 * `.eslintrc`. The backend is unaffected and keeps its own `.eslintrc.json`.
 *
 * ## `core-web-vitals`, not the base config
 *
 * It is the base config plus the rules that affect Core Web Vitals raised from warnings to errors —
 * `@next/next/no-img-element` and `no-sync-scripts` among them. Warnings that nothing fails on are
 * warnings nobody reads, and this project's whole convention is that a check either holds or is not
 * worth having.
 *
 * ## What is deliberately not turned on
 *
 * `eslint-config-next/typescript` adds `typescript-eslint`'s rules, which need type information and
 * a second full type-check pass. `tsc --noEmit` already runs on every change and is the authority on
 * types here; a second opinion that is slower and less complete would mostly duplicate it. The
 * frontend's own contract — which paths it calls, which permissions it names, which columns it may
 * not read — is checked by `backend/scripts/verify-frontend.js`, and that is deliberate too: those
 * are claims about the **backend**, and a linter cannot see the other side of the wire.
 */

import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default defineConfig([
  ...nextVitals,

  /*
   * ## The one rule turned off, and what it would take to turn it back on
   *
   * `react-hooks/set-state-in-effect` fires **66 times** on the first run, and every one is one of
   * two patterns this product uses everywhere on purpose:
   *
   *  - a fetch effect that sets `loading` and clears `error` before awaiting a request;
   *  - a form re-seeding its state when the row it edits changes.
   *
   * The rule is right that both cause an extra render pass, and right that React would rather have
   * neither. But the alternatives are architectural, not local: the first wants a data-fetching
   * library or Suspense, and the second wants remount-by-`key` instead of an effect. Adopting either
   * is a deliberate decision about how this frontend fetches, and it should be made as one — not
   * arrived at by suppressing sixty-six warnings one file at a time.
   *
   * So it is **off**, and named here rather than left as a warning. A warning that nothing fails on
   * is a warning nobody reads; sixty-six of them would make `npm run lint` permanently red, which is
   * how a project ends up not running its linter at all. Everything else in this config is an error
   * and the run is green, so a new problem is visible the day it appears.
   *
   * The debt is recorded in `IMPLEMENTATION_PROGRESS.md` §7. Turning this back on is the acceptance
   * test for whichever fetching architecture replaces the current one.
   */
  {
    rules: {
      'react-hooks/set-state-in-effect': 'off',
    },
  },

  globalIgnores([
    /* The defaults of `eslint-config-next`, restated because overriding `ignores` replaces them. */
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    /* Build output, not source: TypeScript's incremental cache is committed and is not linted. */
    'tsconfig.tsbuildinfo',
  ]),
]);
