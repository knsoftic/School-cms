'use strict';

/**
 * Verification of the frontend's contract with this API — checklist rows 4.1, 4.2, 4.8, 4.10.
 *
 * ## Why this lives in `backend/scripts/` and runs in the backend's loop
 *
 * Because what it verifies is a claim about the **backend**: that every endpoint the frontend calls
 * exists, with that method, on the application actually mounted. A test inside `frontend/` could
 * only check the frontend against its own idea of the API, which is the thing most likely to be
 * wrong. Reading both sides at once is the only way the check has any force.
 *
 * The comparison is against the generated OpenAPI document (§28), not a hand-written list — so it
 * cannot go stale. Rename a route in Express and this suite fails the same day, naming the frontend
 * file that still calls the old path.
 *
 * ## The three things it checks, and why each one is worth a suite
 *
 *   1. **Every path the client calls exists.** A typo in a path string is invisible until a screen
 *      is opened, and then it is a 404 that looks like missing data rather than a missing route.
 *   2. **§30 Rule 1 is not violated.** Rule 1 forbids hard-coding plan names, and names the wrong
 *      shape explicitly: `if (plan == premium)`. This greps the frontend for exactly that.
 *   3. **The access token is never persisted.** It is held in memory on purpose; a `localStorage`
 *      write anywhere in the client would undo that quietly.
 */

const fs = require('fs');
const path = require('path');

const { createApp } = require('../src/app');
const { buildDocument } = require('../src/docs/openapi');
const { MODULES } = require('../src/config/constants');
const { PERMISSION_KEY_SET } = require('../src/config/permissions');
const permissionService = require('../src/services/permissionService');

const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend', 'src');

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

/** Every `.ts`/`.tsx` file under the frontend's source tree. */
function sourceFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** `E:\...\frontend\src\lib\auth.tsx` → `src/lib/auth.tsx` */
function relative(file) {
  return path.relative(path.dirname(FRONTEND), file).split(path.sep).join('/');
}

/**
 * Strip `//` and block comments, so a rule is tested against code rather than prose.
 *
 * Written after this suite failed on a file that was correct: `apiClient.ts` explains, in a comment,
 * that the token is held *"in memory, never in `localStorage`"* — and the check for `localStorage`
 * matched that sentence. This is the third time in one session that a substring search could not
 * tell a rule from the warning against breaking it. The right fix is always to narrow the search,
 * never to delete the sentence: naming a hazard in prose is exactly what should be encouraged.
 *
 * A string literal containing `//` would be over-stripped by this, which is acceptable here — the
 * cost is a false PASS on a pathological line, and every rule below is also asserted positively.
 */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//');
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

/**
 * Every API call the client makes, as `{ method, path, file }`.
 *
 * Matches the `api.get('/x')` / `api.post('/x', …)` helpers and the bare `request('/x', …)` form.
 * A call built from a variable is not matched and cannot be — which is a real limit of this suite,
 * stated here rather than left for a reader to discover. It holds today because every call site
 * writes its path as a literal; the assertion below that counts them is what would notice if that
 * stopped being true.
 */
function callsIn(source, file) {
  const calls = [];

  const helper = /\bapi\.(get|post|put|patch|delete)<[^>]*>\(\s*'([^']+)'|\bapi\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
  for (let m = helper.exec(source); m; m = helper.exec(source)) {
    calls.push({ method: (m[1] || m[3]).toLowerCase(), path: m[2] || m[4], file });
  }

  /* `fetch(`${API_URL}/auth/refresh`, { method: 'POST' })` — the two calls that bypass the helper. */
  const direct = /\$\{API_URL\}(\/[A-Za-z0-9/_-]*)/g;
  for (let m = direct.exec(source); m; m = direct.exec(source)) {
    calls.push({ method: null, path: m[1], file });
  }

  return calls;
}

function main() {
  console.log('');
  console.log('── the frontend exists and builds from these files ──');
  console.log('');

  check('the frontend source tree exists', fs.existsSync(FRONTEND), true);

  const files = sourceFiles(FRONTEND);
  check('  and holds TypeScript sources', files.length > 0, true);

  const required = ['src/lib/apiClient.ts', 'src/lib/auth.tsx', 'src/lib/entitlements.tsx'];
  const present = files.map(relative);
  check('the three pieces every screen depends on are present',
    required.filter((f) => !present.includes(f)), []);

  /* ─────────────── every endpoint the client calls exists on the API ─────────────── */

  console.log('');
  console.log('── every path the client calls, against the mounted application ──');
  console.log('');

  const doc = buildDocument(createApp());
  const documented = new Set();
  for (const [routePath, methods] of Object.entries(doc.paths)) {
    for (const method of Object.keys(methods)) documented.add(`${method} ${routePath}`);
  }

  const calls = [];
  for (const file of files) {
    calls.push(...callsIn(fs.readFileSync(file, 'utf8'), relative(file)));
  }

  check('the client calls the API at all', calls.length > 0, true);

  /*
   * A call whose method this suite could not read is checked against every method the path has —
   * proving the *path* exists even when the verb is not literal in the source.
   */
  const unknownPath = calls.filter(
    (call) => ![...documented].some((entry) => entry.endsWith(` ${call.path}`))
  );
  check('every path the client calls exists on the API',
    unknownPath.map((call) => `${call.file}: ${call.path}`), []);

  const wrongMethod = calls.filter(
    (call) => call.method && !documented.has(`${call.method} ${call.path}`)
  );
  check('  with the method it uses',
    wrongMethod.map((call) => `${call.file}: ${call.method.toUpperCase()} ${call.path}`), []);

  /* The paths the foundation depends on, named so a rename cannot pass silently. */
  for (const [method, routePath] of [
    ['post', '/auth/login'],
    ['post', '/auth/refresh'],
    ['post', '/auth/logout'],
    ['post', '/auth/change-password'],
    ['get', '/auth/me'],
    ['get', '/csrf-token'],
  ]) {
    check(`  the API still serves ${method.toUpperCase()} ${routePath}`,
      documented.has(`${method} ${routePath}`), true);
  }

  /* ─────────────── §30 Rule 1 — no plan name in the gating logic ─────────────── */

  console.log('');
  console.log('── SRS §30 Rule 1: gating is database-driven ──');
  console.log('');

  /* `text` is the comment-stripped code; the rules below are about what runs, not what is said. */
  const allSource = files.map((file) => ({
    file: relative(file),
    text: code(fs.readFileSync(file, 'utf8')),
  }));

  /*
   * Rule 1 names the wrong shape itself — `if (plan == premium)`. A plan **code** compared against a
   * literal is that shape exactly, whatever the surrounding syntax.
   */
  const planComparisons = allSource.filter(({ text }) =>
    /\bplan(?:\.code|\.name|Code|Name)\s*(?:===?|!==?)\s*['"]/.test(text)
    || /['"]\s*(?:===?|!==?)\s*\bplan(?:\.code|\.name|Code|Name)\b/.test(text)
  );
  check('no file compares a plan code or name against a literal',
    planComparisons.map((entry) => entry.file), []);

  /*
   * The complementary check. Gating must go through the module keys, so at least one file has to be
   * asking `hasModule`. Without this, "nothing compares a plan name" would also be satisfied by a
   * client that did no gating at all.
   */
  check('and the gating helpers exist to be used instead',
    allSource.some(({ text }) => /hasModule|hasFeature|limitFor/.test(text)), true);

  /*
   * The module keys are §11's twenty, fixed. A frontend that invented one would gate on a key the
   * backend never sets, and the module would be invisible with nothing explaining why.
   */
  const moduleKeys = new Set(Object.values(MODULES));
  const gated = new Set();
  for (const { text } of allSource) {
    const uses = /hasModule\(\s*'([^']+)'/g;
    for (let m = uses.exec(text); m; m = uses.exec(text)) gated.add(m[1]);
  }
  check('every module key the client gates on is one the backend defines',
    [...gated].filter((key) => !moduleKeys.has(key)), []);

  /* ─────────────── §7's auth surface, and the markup it shares ─────────────── */

  console.log('');
  console.log('── the auth pages §7 requires (row 4.2) ──');
  console.log('');

  /*
   * §7 has five user-facing auth flows and the checklist row names four of them; the fifth,
   * `change-password`, is not optional either — it is the FIRST screen on a new deployment, because
   * the seeded Super Admin ships with `must_change_password` set.
   */
  const authPages = ['login', 'change-password', 'forgot-password', 'reset-password', 'verify-email'];
  const pageFile = (name) => path.join(FRONTEND, 'app', '(auth)', name, 'page.tsx');

  check('every auth flow §7 defines has a page',
    authPages.filter((name) => !fs.existsSync(pageFile(name))), []);

  /*
   * Each page must actually call its own endpoint. A page that renders a form and posts nowhere
   * would satisfy "the file exists" while being an elaborate way to do nothing.
   */
  const expectedCall = {
    login: '/auth/login',
    'change-password': '/auth/change-password',
    'forgot-password': '/auth/forgot-password',
    'reset-password': '/auth/reset-password',
    'verify-email': '/auth/verify-email',
  };
  const notCalling = authPages.filter((name) => {
    if (!fs.existsSync(pageFile(name))) return true;
    const text = fs.readFileSync(pageFile(name), 'utf8');
    /* login and change-password go through AuthProvider, which owns the call. */
    if (name === 'login') return !/useAuth\(\)/.test(text) || !/login\(/.test(text);
    if (name === 'change-password') return !/changePassword\(/.test(text);
    return !text.includes(expectedCall[name]);
  });
  check('  and each reaches the endpoint that flow needs', notCalling, []);

  /*
   * **The drift this locks out.** `components/form.tsx` was extracted at the fourth auth page,
   * after two of them wired `aria-describedby` on their inputs and two did not — so a screen reader
   * announced the validation message on some screens and not others. Nobody sees that in review.
   *
   * Asserting "every page uses `Field`" would be too weak: a page can use `Field` for one input and
   * a raw `<input>` for the next, which is exactly how the first drift happened. So the rule is that
   * no page declares a raw input at all; the primitive is the only way to get one.
   */
  const rawInputs = authPages
    .filter((name) => fs.existsSync(pageFile(name)))
    .filter((name) => /<input\b/.test(code(fs.readFileSync(pageFile(name), 'utf8'))));
  check('no auth page declares a raw <input>, so accessibility cannot drift between them',
    rawInputs, []);

  check('  because the shared primitive is where an input is defined',
    /<input\b/.test(fs.readFileSync(path.join(FRONTEND, 'components', 'form.tsx'), 'utf8')), true);

  /*
   * The token in a reset or verification link is a credential. Rendering it into a form field would
   * have it autofilled, copied and screenshotted like any other value; both pages read it from the
   * query string and send it without ever displaying it.
   */
  const tokenExposed = ['reset-password', 'verify-email']
    .filter((name) => fs.existsSync(pageFile(name)))
    .filter((name) => /<Field[^>]*id=['"]token['"]/.test(fs.readFileSync(pageFile(name), 'utf8')));
  check('the single-use token is never rendered into a form field', tokenExposed, []);

  /* ─────────────── the navigation table (rows 4.1, 4.10) ─────────────── */

  console.log('');
  console.log('── the nav, against the catalogues it draws from ──');
  console.log('');

  /*
   * `src/lib/nav.ts` names permission and module keys as **object properties**, not as arguments to
   * `hasModule()`. The generic check above reads call sites and would not have looked at any of
   * them — so every key in the sidebar could have been invented and the suite stayed green.
   *
   * Both catalogues are fixed: §29/§35 pin the permissions at 109 entries and §11 pins the modules
   * at 20. A nav naming a key outside either is not a typo with a cosmetic cost: a bad permission
   * hides a working screen from everyone, and a bad module key hides it from every school.
   */
  const navPath = path.join(FRONTEND, 'lib', 'nav.ts');
  check('the navigation is defined as data', fs.existsSync(navPath), true);

  const navSource = fs.readFileSync(navPath, 'utf8');

  const navPermissions = [...new Set(
    [...navSource.matchAll(/permission:\s*'([^']+)'/g)].map((m) => m[1])
  )];
  const navModules = [...new Set([
    ...[...navSource.matchAll(/\bmodule:\s*'([^']+)'/g)].map((m) => m[1]),
    ...[...navSource.matchAll(/anyModule:\s*\[([^\]]+)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])),
  ])];

  check('the nav names permissions at all', navPermissions.length > 0, true);
  check('  and every one is in the fixed 109-entry catalogue',
    navPermissions.filter((key) => !PERMISSION_KEY_SET.has(key)), []);

  check('the nav names module keys at all', navModules.length > 0, true);
  check('  and every one is one of §11\'s twenty',
    navModules.filter((key) => !new Set(Object.values(MODULES)).has(key)), []);

  /*
   * §33's screen counts, asserted against the nav rather than against a comment. Sixteen Super Admin
   * screens and seventeen School screens — the numbers the checklist's rows 4.3 and 4.4 carry.
   */
  /*
   * Counted **within each nav's own block**, not across the file.
   *
   * The first version matched every `href: '/school` in `nav.ts`, which was right until `TEACHER_NAV`
   * arrived: §5 grants a teacher attendance, marks, homework and timetable, and those are the School
   * screens they already hold permissions for — so the teacher nav deliberately points into four of
   * them rather than duplicating them. The file-wide count read 21 for a School nav that still has
   * exactly §33's seventeen.
   */
  const blockOf = (name, next) => {
    const from = navSource.indexOf(`export const ${name}`);
    const to = next ? navSource.indexOf(`export const ${next}`) : navSource.length;
    return from === -1 ? '' : navSource.slice(from, to === -1 ? navSource.length : to);
  };
  const platformBlockSrc = blockOf('PLATFORM_NAV', 'SCHOOL_NAV');
  const schoolBlockSrc = blockOf('SCHOOL_NAV', 'TEACHER_NAV');

  const platformItems = (platformBlockSrc.match(/href:\s*'\/super-admin/g) || []).length;
  const schoolItems = (schoolBlockSrc.match(/href:\s*'\/school/g) || []).length;
  check('the Super Admin nav covers §33\'s sixteen screens', platformItems, 16);
  check('the School nav covers §33\'s seventeen screens', schoolItems, 17);

  /*
   * The platform surface must carry no module gate. A Super Admin administers plans; gating their
   * screens on a subscription would let a lapsed one lock out the account that fixes subscriptions.
   */
  const platformBlock = platformBlockSrc;
  check('no Super Admin screen is gated by a module',
    /\bmodule:|anyModule:/.test(platformBlock), false);

  /* ─────────────── the list screens (rows 4.3, 4.4) ─────────────── */

  console.log('');
  console.log('── what every list screen must and must not do ──');
  console.log('');

  const screenFiles = files.filter((file) => /[\\/]\(platform\)|[\\/]\(school\)/.test(file)
    && /page\.tsx$/.test(file));
  const screens = screenFiles.map((file) => ({
    file: relative(file),
    text: fs.readFileSync(file, 'utf8'),
    body: code(fs.readFileSync(file, 'utf8')),
  }));

  check('there are dashboard screens to check', screens.length > 0, true);

  /*
   * **The rule that matters most, and the one a generated screen is likeliest to break.**
   *
   * `users` carries eight columns a client must never see — the password hash, three single-use
   * token hashes, the refresh-token hash, the two permission-override arrays and the lockout
   * bookkeeping. `auth.service.js`'s `PUBLIC_USER_FIELDS` strips them on the way out, so a screen
   * naming one would render `undefined` rather than leak it today. That is luck, not design: the
   * defect is a screen that *believes* the field is available, and the day a controller stops
   * filtering, the column starts working.
   */
  const SECRET_FIELDS = [
    'password_hash',
    'refresh_token_hash',
    'email_verification_token_hash',
    'password_reset_token_hash',
    'extra_permissions',
    'denied_permissions',
    'failed_login_attempts',
    'locked_until',
  ];
  const leaking = screens.filter(({ body }) => SECRET_FIELDS.some((field) => body.includes(field)));
  check('no screen references a column the API strips as secret',
    leaking.map((s2) => s2.file), []);

  /*
   * `screenshot_path` is the narrower case and has its own history: `payments.present()` used to
   * spread the row whole and leaked the on-disk layout with every payment response, until an
   * adversarial review caught it. It now returns `has_screenshot`, and the bytes are served only
   * through `GET /payments/:id/screenshot`, which re-checks the tenant. A screen reaching for the
   * path would be rebuilding the hole that was closed.
   */
  const SUPPRESSED_PATHS = ['screenshot_path', 'attachment_path', 'file_path'];
  const pathLeak = screens.filter(({ body }) => SUPPRESSED_PATHS.some((f) => body.includes(f)));
  check('no screen references a stored path the API suppresses',
    pathLeak.map((s2) => s2.file), []);
  /*
   * The three are confirmed suppressed, each by its own controller: `payments.present()` returns
   * `has_screenshot`, `homework` returns `has_attachment`, and `documents.controller.js:6` says
   * `file_path` "cannot leak through a response — it is null". The bytes come from the file-serving
   * sub-resources instead (`/payments/{id}/screenshot`, `/students/{id}/photo`,
   * `/homework/{id}/attachment`), which re-check the tenant on the way out.
   *
   * `photo_path` is deliberately NOT in the list: nothing was found suppressing it, and banning a
   * field the API legitimately returns would block a valid screen for no reason.
   */

  /*
   * Every permission a screen gates on must exist. A typo hides a control from everyone, silently
   * and permanently — `can('users.mange')` is simply never true, and nothing complains.
   */
  /*
   * `can(?:Any)?`, not `canAny?`. The first version was the second, which is `can` + `An` + an
   * optional `y` — it matches `canAn` and `canAny` and never `can`, so it collected nothing and the
   * assertion passed by having no input. A deliberate regression that mistyped a real permission key
   * went undetected, which is how it was found; reading it had not.
   */
  const screenPermissions = [...new Set(
    screens.flatMap(({ body }) => [...body.matchAll(/\bcan(?:Any)?\(\s*'([^']+)'/g)].map((m) => m[1]))
  )];
  check('every permission a screen gates on is in the fixed catalogue',
    screenPermissions.filter((key) => !PERMISSION_KEY_SET.has(key)), []);

  /*
   * A list screen that does not use the shared hook is one that has re-implemented the four states,
   * and the state it will get wrong is `refusal`: an unsubscribed module reported as an error, with
   * a retry button that can never succeed.
   */
  /*
   * Matched on the **call** and the **element**, not on the bare identifier.
   *
   * Both of these first tested `/useCollection/` and `/RefusalNotice/`, which are satisfied by the
   * import line at the top of the file. Deleting the hook call and deleting the refusal branch both
   * left the imports in place, so both regressions passed unnoticed. An identifier is in scope
   * because it was imported; that says nothing about whether it is used.
   */
  /*
   * Keyed on `<Pagination`, not on `<DataTable`.
   *
   * The first version required `useCollection` of any screen rendering a table, and the Reports
   * screen failed it correctly and for the wrong reason. §22's reports are not collections: the
   * endpoint returns one object with an embedded `by_plan` array, there is nothing to page, and
   * forcing the hook there would mean inventing pagination the API does not have.
   *
   * What actually has to go through the hook is anything that **pages** — that is where the
   * single-flight abort, the four states and the `q` cap live. A table over an embedded array needs
   * none of them.
   */
  const listScreens = screens.filter(({ body }) => /<Pagination/.test(body));
  check('every screen that pages loads it through the shared collection hook',
    listScreens.filter(({ body }) => !/useCollection\s*[<(]/.test(body)).map((s2) => s2.file), []);

  /*
   * The refusal rule stays on every screen that fetches, paging or not — a report can be refused for
   * exactly the same reasons a list can, and answering that with a retry button is the same mistake.
   */
  const fetchingScreens = screens.filter(({ body }) => /useCollection\s*[<(]|api\.get/.test(body));
  check('  and every screen that fetches renders the refusal state, not just an error state',
    fetchingScreens.filter(({ body }) => !/<RefusalNotice/.test(body)).map((s2) => s2.file), []);

  /*
   * One copy of the explained-refusal set. The Reports screen first kept its own, which would have
   * drifted from `useCollection`'s the moment either changed — and the list had just been corrected
   * twice, so a second copy was a live hazard rather than a theoretical one.
   */
  const ownCopies = screens.filter(({ body }) => /new Set\(\[[^\]]*'INSUFFICIENT_PERMISSION'/.test(body));
  check('no screen keeps its own copy of the explained-refusal codes',
    ownCopies.map((s2) => s2.file), []);

  /*
   * A raw `<input>` on a dashboard screen is the same drift the auth pages already had: the shared
   * `Field` wires `aria-describedby` and a raw element does not. The one exception is a search box,
   * which has no error to describe — so it is allowed, and only when it carries a label.
   */
  const screensWithInputs = screens.filter(({ body }) => /<input\b/.test(body));
  const unlabelledSearch = screensWithInputs.filter(({ text }) => !/htmlFor=|aria-label=/.test(text));
  check('every raw input on a screen carries a label',
    unlabelledSearch.map((s2) => s2.file), []);

  /* ─────────────── every status word has a tone ─────────────── */

  console.log('');
  console.log('── StatusBadge, against every vocabulary in constants.js ──');
  console.log('');

  /*
   * `StatusBadge` renders a word from one of twenty-six enums, and a word with no entry in its tone
   * map falls to the default grey. That is legible — the badge always prints the word and never
   * relies on colour alone — but it is silent, and it happened: of `STUDENT_STATUS`'s six values only
   * two were toned, so `promoted`, `graduated`, `transferred` and `left` were indistinguishable from
   * each other and from a status the map had never heard of.
   *
   * Reading the vocabularies out of `constants.js` means a status added to the schema fails here
   * rather than shipping as unstyled grey.
   */
  const constantsSrc = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'config', 'constants.js'), 'utf8'
  );
  const constants = require('../src/config/constants');

  /*
   * `RESULT_OUTCOME` is named explicitly because it is a status-shaped vocabulary that the suffix
   * pattern misses — and the Results screen renders it through `StatusBadge`, so `pass` and `fail`
   * were both falling to the default grey. Found by review, not by this check, which is the point of
   * naming it here rather than widening the pattern: of the forty other flat vocabularies in
   * `constants.js`, almost none is a status. `WEEKDAYS` and `MODULES` are rendered as plain text, and
   * demanding a colour for `monday` would be a rule with no meaning behind it.
   */
  const EXTRA_BADGE_VOCABULARIES = ['RESULT_OUTCOME'];

  const statusWords = new Set();
  for (const key of Object.keys(constants)) {
    if (!/_STATUS$|_STATES$|_STATUSES$/.test(key) && !EXTRA_BADGE_VOCABULARIES.includes(key)) continue;
    const vocabulary = constants[key];
    if (!vocabulary || typeof vocabulary !== 'object') continue;
    for (const word of Object.values(vocabulary)) {
      if (typeof word === 'string') statusWords.add(word);
    }
  }

  check('the status vocabularies are still where this reads them from',
    statusWords.size > 40 && constantsSrc.includes('STUDENT_STATUS'), true);

  const badgeSrc = fs.readFileSync(path.join(FRONTEND, 'components', 'table.tsx'), 'utf8');
  const toned = new Set();
  for (const listName of ['GOOD', 'ATTENTION', 'BAD', 'ENDED']) {
    const block = badgeSrc.slice(
      badgeSrc.indexOf(`const ${listName} = `),
      badgeSrc.indexOf('];', badgeSrc.indexOf(`const ${listName} = `))
    );
    for (const m of block.matchAll(/'([a-z_]+)'/g)) toned.add(m[1]);
  }

  check('every status word the backend defines has a tone',
    [...statusWords].filter((word) => !toned.has(word)).sort(), []);

  /*
   * And nothing invented. A word in the map that no vocabulary contains is dead code at best, and at
   * worst a misspelling of one that is missing — which is the failure this pair exists to catch from
   * both directions.
   */
  check('  and no toned word is one the backend never emits',
    [...toned].filter((word) => !statusWords.has(word)).sort(), []);

  /* ─────────────── the refusals a screen explains ─────────────── */

  console.log('');
  console.log('── refusal codes, against the guards that raise them ──');
  console.log('');

  /*
   * **The defect this exists for.** `useCollection` divides failures into two kinds: an `error`,
   * where retrying is the remedy, and a `refusal`, where it is not and the screen should explain
   * instead. The division is made by matching `error.code` against a set — and the set was written
   * from memory rather than from the middleware.
   *
   * It listed `FORBIDDEN`, which is `ApiError.forbidden()`'s *default*. The permission guard does not
   * use the default: `authorize.js:135` raises `INSUFFICIENT_PERMISSION`. So the most likely refusal
   * on any dashboard — a role that lacks the permission — fell through to the error branch and
   * rendered a red banner with a "Try again" button that could never succeed. On every screen.
   *
   * Nothing else could have caught this: the code compiles, the types agree, and the branch is only
   * reachable with a role that lacks the permission, which no fixture here has. So the two lists are
   * compared at their sources.
   */
  const authorizeSrc = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'middlewares', 'authorize.js'), 'utf8'
  );
  const entitlementSrc = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'middlewares', 'entitlement.js'), 'utf8'
  );

  const raisedCodes = [...new Set([
    ...[...authorizeSrc.matchAll(/code:\s*'([A-Z_]+)'/g)].map((m) => m[1]),
    ...[...entitlementSrc.matchAll(/code:\s*'([A-Z_]+)'/g)].map((m) => m[1]),
  ])];

  check('the guards still raise refusal codes at all', raisedCodes.length > 0, true);

  const hookSrc = fs.readFileSync(path.join(FRONTEND, 'lib', 'useCollection.ts'), 'utf8');
  const explainedBlock = hookSrc.slice(
    hookSrc.indexOf('const EXPLAINED_CODES'),
    hookSrc.indexOf(']);', hookSrc.indexOf('const EXPLAINED_CODES'))
  );
  const explained = [...explainedBlock.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);

  /*
   * Every code a guard raises must be explained. The reverse is deliberately NOT asserted:
   * `FORBIDDEN` is in the client's set and is raised from service code rather than these two
   * middlewares, so requiring an exact match either way would fail on a code that is correctly there.
   */
  check('every refusal a guard raises is one the client explains rather than reports as an error',
    raisedCodes.filter((codeName) => !explained.includes(codeName)), []);

  check('  including the permission refusal specifically, which is the likeliest of them',
    explained.includes('INSUFFICIENT_PERMISSION'), true);

  /* ─────────────── the pagination envelope ─────────────── */

  console.log('');
  console.log('── pagination, against the code that emits it ──');
  console.log('');

  /*
   * **The defect this exists for.** `ApiResponse.paginated` nests the page fields one level down —
   * `{ meta: { pagination: { … } } }` — and the client's `PageMeta` first declared them flat. Every
   * field arrived `undefined`, on every list screen at once.
   *
   * Nothing caught it. The typecheck could not: the shape was asserted through `as ApiEnvelope<T>`,
   * which is a claim rather than a check. The browser could not either, and that is the part worth
   * remembering — every collection in this environment holds at most one page, and `<Pagination>`
   * returns null on a single page, so **the component that would have shown the mistake never
   * rendered**. Nine screens were opened against the live API and all nine looked correct. It took an
   * adversarial read of the generated code to find it.
   *
   * So the two are compared directly, at their sources.
   */
  const apiResponseSrc = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'utils', 'ApiResponse.js'), 'utf8'
  );
  const paginatedBlock = apiResponseSrc.slice(
    apiResponseSrc.indexOf('function paginated'),
    apiResponseSrc.indexOf('module.exports')
  );

  check('the API still nests pagination under `meta.pagination`',
    /meta:\s*\{[\s\S]*?pagination:\s*\{/.test(paginatedBlock), true);

  const emitted = [...new Set(
    [...paginatedBlock.slice(paginatedBlock.indexOf('pagination:')).matchAll(/^\s{8}([a-zA-Z]+)[,:]/gm)]
      .map((m) => m[1])
  )];
  check('  emitting the six fields it has always emitted',
    emitted.sort(), ['hasNextPage', 'hasPreviousPage', 'limit', 'page', 'total', 'totalPages']);

  const clientSrc = fs.readFileSync(path.join(FRONTEND, 'lib', 'apiClient.ts'), 'utf8');
  const pageMetaBlock = clientSrc.slice(
    clientSrc.indexOf('export interface PageMeta'),
    clientSrc.indexOf('}', clientSrc.indexOf('export interface PageMeta'))
  );
  const declared = [...pageMetaBlock.matchAll(/^\s*([a-zA-Z]+)\??:/gm)].map((m) => m[1]);

  check('the client declares exactly the fields the API emits, and no invented one',
    declared.sort(), emitted.sort());

  /*
   * And the unwrap itself. Declaring the right fields is not enough if the client still reads them
   * off `meta` rather than `meta.pagination` — that was the original bug, and the types agreed with
   * it perfectly.
   */
  check('and the client unwraps the nested object rather than reading meta directly',
    /meta\?\.pagination/.test(code(clientSrc)), true);

  /* ─────────────── the access token is never persisted ─────────────── */

  console.log('');
  console.log('── the access token stays in memory ──');
  console.log('');

  /*
   * Every key any file puts in browser storage, read from CODE rather than raw text so a comment
   * explaining the rule is not mistaken for breaking it.
   *
   * `msms-theme` is the one permitted key and it is permitted for a reason: the chosen colour theme
   * has to be readable before the first paint, or every visit flashes the wrong theme before
   * correcting itself, and nothing but synchronous storage can be read that early. It holds the
   * string 'light' or 'dark' and nothing else.
   */
  const ALLOWED_STORAGE_KEYS = ['msms-theme'];

  const storageKeys = new Set();
  const storageFiles = [];
  for (const entry of allSource) {
    const src = code(entry.text);
    if (!/localStorage|sessionStorage/.test(src)) continue;
    storageFiles.push(entry.file);
    /*
     * A key is normally held in a constant rather than repeated at three call sites, so single-level
     * `const NAME = 'literal'` declarations in the same file are resolved. Teaching the check to read
     * ordinary code is better than requiring unusual code for the check's benefit — and an
     * expression it cannot resolve still surfaces, as itself, and fails.
     */
    const consts = new Map();
    for (const c of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']*)'/g)) {
      consts.set(c[1], c[2]);
    }
    for (const m of src.matchAll(/(?:localStorage|sessionStorage)\.(?:get|set|remove)Item\(\s*([^,)]+)/g)) {
      /*
       * Quotes first, then `${…}` — in that order. The theme's pre-paint script is itself a template
       * literal, so the key reaches here as `'${STORAGE_KEY}'`: unwrapping before unquoting leaves
       * the quotes on and the name unresolvable, which is what the first version of this did.
       */
      const raw = m[1].trim();
      const unquoted = raw.replace(/^['\`"]|['\`"]$/g, '');
      const name = unquoted.replace(/^\$\{\s*|\s*\}$/g, '');
      storageKeys.add(consts.has(name) ? consts.get(name) : unquoted);
    }
  }

  check('browser storage holds only the keys this project has justified',
    [...storageKeys].sort(), [...ALLOWED_STORAGE_KEYS].sort());

  /*
   * The rule the heading is actually about, and which the previous blanket ban never expressed: no
   * identifier that could carry a session may appear in the same file as a storage write. A token in
   * `localStorage` is readable by any script that reaches the page, which is the whole reason this
   * client keeps it in a module-scoped variable instead.
   */
  const AUTH_WORDS = /token|accessToken|refresh|jwt|password|secret|credential|session/i;
  const leaky = allSource
    .filter((entry) => /(?:localStorage|sessionStorage)\.setItem/.test(code(entry.text)))
    .filter((entry) => AUTH_WORDS.test(code(entry.text)))
    .map((entry) => entry.file);
  check('  and no file that writes to storage so much as mentions a session or a token',
    leaky, []);

  /* Named so a reader can see WHICH files are permitted to touch storage at all. */
  check('  and only the theme control touches storage in the first place',
    storageFiles.sort(), ['src/components/theme.tsx']);
  check('  and the rule is written down where the token lives, so it is not undone by accident',
    /never in `localStorage`/.test(fs.readFileSync(path.join(FRONTEND, 'lib', 'apiClient.ts'), 'utf8')),
    true);

  /*
   * The refresh token is an httpOnly cookie, which script cannot read — so a client that tried to
   * would be reaching for something that is not there, and the attempt is the defect.
   */
  const readsCookie = allSource.filter(({ text }) => /document\.cookie/.test(text));
  check('  and none reads document.cookie, which the httpOnly refresh token is not in',
    readsCookie.map((entry) => entry.file), []);

  /*
   * `credentials: 'include'` on every call is what sends that cookie cross-origin. The frontend and
   * API are separate origins by §3's separation requirement, so omitting it does not degrade the
   * session — it removes it.
   */
  const client = allSource.find((entry) => entry.file === 'src/lib/apiClient.ts');
  const fetchCount = (client.text.match(/fetch\(/g) || []).length;
  const credentialCount = (client.text.match(/credentials: 'include'/g) || []).length;
  check('every fetch in the client sends credentials, or the refresh cookie never travels',
    credentialCount >= fetchCount, true);
}

try {
  main();
} catch (err) {
  failures += 1;
  console.error('\nverify-frontend crashed:', err);
}

console.log('');
/* ── internal links resolve, or are a recorded gap ── */

/*
 * Every `href` the app renders should reach a route the app defines. Eighteen do not.
 *
 * No `new` directory exists anywhere under `frontend/src/app`, yet eighteen internal links point at
 * one — every "Add" and "New" button in both the school and the platform area. Each is gated on a
 * permission a Principal or Super Admin holds, so it renders, and clicking it lands on a bare 404
 * with no not-found boundary. The list screens work; the create affordances they render are dead.
 * The product has no create path through the UI at all.
 *
 * ## Why this asserts the exact set rather than zero
 *
 * Asserting zero would be the honest ideal and would leave this suite permanently red, which costs
 * the signal more than it buys. So the dead set is *recorded*, the way `tests/baseline.json` records
 * assertion counts: a nineteenth dead link fails this, and repairing one fails it too, which forces
 * the record to be updated deliberately rather than drifting. Known Issue 30 carries the reasoning.
 */
/*
 * Every internal link resolves to a route the app defines. **Zero exceptions**, asserted as zero.
 *
 * This began as a recorded list of eighteen. Every list screen rendered a permission-gated "Add …"
 * button pointing at a `/new` route that did not exist, and `find src/app -type d -name new` returned
 * nothing: the product could read everything and create nothing. Asserting zero then would have left
 * this suite permanently red, which costs more signal than it buys, so the dead set was recorded the
 * way `tests/baseline.json` records assertion counts — failing in **both** directions, so a
 * nineteenth dead link and a repaired one each forced the record to move deliberately.
 *
 * It caught every one of the eighteen as they landed. With the list empty the recorded form has done
 * its job and the honest assertion is the plain one.
 */

{
  /* Route groups like `(school)` are organisational and contribute nothing to the URL. */
  const routes = new Set();
  const walkRoutes = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkRoutes(full);
      else if (entry.name === 'page.tsx') {
        const url = path
          .relative(path.join(FRONTEND, 'app'), dir)
          .split(path.sep)
          .filter((seg) => seg && !/^\(.*\)$/.test(seg))
          /* `[classId]` is a dynamic segment; an interpolated href normalises to `:param` to meet it. */
          .map((seg) => (/^\[.*\]$/.test(seg) ? ':param' : seg))
          .join('/');
        routes.add(`/${url}`.replace(/\/$/, '') || '/');
      }
    }
  };
  walkRoutes(path.join(FRONTEND, 'app'));

  /*
   * ## This extraction used to validate a prefix and call it a link
   *
   * The pattern was `/href=[{]?[`"](\/[A-Za-z0-9/_-]*)/`. The character class has no `$` in it, so an
   * interpolated href was **truncated at the first `${`**:
   *
   *   href={`/school/classes/${classId}/sections/new`}   was recorded as   /school/classes/
   *
   * `/school/classes` is a real route, so the link passed. Three dead links sat behind that blind
   * spot while this assertion reported zero — the "Add section" button, both finance "Record …"
   * buttons, and the add-on name link. Every one of them is a template literal, and every one 404s.
   *
   * So the whole href is captured now, from any of the four forms JSX writes it in, and an
   * interpolation becomes `:param` — which resolves only against a route that really has a dynamic
   * segment. `[id]` directories map to `:param` too, so if this app ever grows one the link that
   * needs it will pass honestly rather than by truncation.
   */
  const normalise = (href) => {
    const pathOnly = href.split('?')[0].split('#')[0];
    return (pathOnly.replace(/\$\{[^}]*\}/g, ':param').replace(/\/$/, '') || '/');
  };

  const HREF = /href=(?:\{`([^`]*)`\}|"([^"]*)"|'([^']*)'|\{'([^']*)'\}|\{"([^"]*)"\})/g;

  const links = new Map();
  for (const file of sourceFiles(FRONTEND)) {
    const text = code(fs.readFileSync(file, 'utf8'));
    for (const m of text.matchAll(HREF)) {
      const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
      /* Only internal links. `#main`, `mailto:` and absolute URLs are somebody else's problem. */
      if (!raw || !raw.startsWith('/')) continue;
      const normalised = normalise(raw);
      if (!links.has(normalised)) links.set(normalised, relative(file));
    }
  }

  check('every internal link resolves to a route the app defines',
    [...links.keys()].filter((l) => !routes.has(l)).sort(), []);

  /*
   * Stated separately so the failure names the file. A dead link found by the check above tells you
   * the URL; this tells you which screen renders it, which is what you actually need.
   */
  check('  and no screen renders a link to a route that does not exist',
    [...links.entries()].filter(([l]) => !routes.has(l)).map(([l, file]) => `${file} -> ${l}`).sort(),
    []);
}

/* ─────────────── §22's Reports screen — triage findings 29, 30 and 31 ─────────────── */

/*
 * Three claims that were false in the product and are now true, asserted so they cannot quietly
 * revert. Each one is read from BOTH sides — the route table on the server and the screen on the
 * client — because a claim checked against only one of them is a claim about a file, not about a
 * capability.
 */

{
  const reportsPage = path.join(
    FRONTEND, 'app', '(platform)', 'super-admin', 'reports', 'page.tsx'
  );
  check('the §33 Reports screen exists', fs.existsSync(reportsPage), true);
  const src = fs.readFileSync(reportsPage, 'utf8');
  /*
   * Comments stripped for every presence check below. The header of that screen explains what it
   * used to get wrong and quotes the controls it now has, so a raw-text search passes on a file
   * that has had the control DELETED — measured: removing the print button left `window.print()`
   * in the prose and the check green. `code()` was written for this exact failure.
   */
  const srcCode = code(src);

  /* ── finding 30: all seven reports are reachable, not one ── */

  /*
   * Read out of the screen's own `REPORTS` table rather than grepped for as words, so a report that
   * is merely *mentioned* in a comment cannot satisfy this. The path is what the screen will call.
   */
  const screenPaths = [...src.matchAll(/path:\s*'(\/reports\/[a-z]+)'/g)].map((m) => m[1]).sort();
  const routePaths = [
    '/reports/students', '/reports/attendance', '/reports/fees', '/reports/expenses',
    '/reports/exams', '/reports/teachers', '/reports/subscriptions',
  ].sort();
  check('the Reports screen can run all seven of §22\'s reports, not one of them',
    screenPaths, routePaths);

  /*
   * The six school reports need a school named, and the screen has the control to name one. Keyed on
   * the `school_id` query key the API actually reads, not on the word "school" — which appears in
   * this file forty times.
   */
  /*
   * `<SelectField id="school">`, not `<select>`: the screen's parameter controls moved onto the
   * shared field wrappers, so its hand-rolled ` *` marker became `FieldLabel`'s — which draws the
   * same asterisk, but with `aria-hidden` on the glyph and the word beside it for a screen reader.
   */
  check('  and it names a school on the six that need one',
    /q\.school_id\s*=\s*schoolId/.test(srcCode)
      && /<SelectField\s+[^>]*id="school"/.test(srcCode), true);

  /*
   * The permission pair each report is gated on, read off the screen and compared with the router.
   *
   * This is the assertion with force, and it replaces two earlier ones that greped the file for the
   * false premise’s own words. Those failed on the corrected file — the header now QUOTES the wrong
   * claim in order to record it — which is the fourth time in this project that a substring search
   * could not tell a rule from the warning against breaking it. `code()` exists for exactly that and
   * is used below; but a phrase search would still only prove what the screen SAYS. What matters is
   * what it gates on, and that is checkable against the routes themselves.
   */
  const screenGates = {};
  for (const m of src.matchAll(/path:\s*'(\/reports\/[a-z]+)',[\s\S]{0,400}?permissions:\s*\[([^\]]*)\]/g)) {
    screenGates[m[1]] = m[2].split(',').map((k) => k.trim().replace(/'/g, '')).filter(Boolean);
  }
  check('  and gates each report on exactly the pair its route requires, read from the router',
    screenGates,
    {
      '/reports/students': ['reports.view', 'students.view'],
      '/reports/attendance': ['reports.view', 'attendance.view'],
      '/reports/fees': ['reports.view', 'fees.view'],
      '/reports/expenses': ['reports.view', 'finance.view'],
      '/reports/exams': ['reports.view', 'exams.view'],
      '/reports/teachers': ['reports.view', 'teachers.view'],
      '/reports/subscriptions': ['reports.subscription.view'],
    });
  /* Every key named above is one the fixed catalogue of 109 actually contains. */
  check('    naming only keys that exist in the fixed catalogue',
    [...new Set(Object.values(screenGates).flat())].filter((k) => !PERMISSION_KEY_SET.has(k)).sort(),
    []);

  /*
   * `SCHOOL_CONTEXT_REQUIRED` is unreachable for a platform caller — `entitlement.js` raises it inside
   * `resolveGatedSchoolId`, on the far side of the `isPlatform` short-circuit — so the screen must not
   * BRANCH on it. Against `code()`, not the raw text: the header explains why it is wrong, and naming
   * a hazard in prose is what should be encouraged.
   */
  check('  and never branches on a refusal code a platform caller can never reach',
    /SCHOOL_CONTEXT_REQUIRED/.test(srcCode), false);

  /* ── finding 31: the exports have a caller ── */

  const clientSrc = fs.readFileSync(path.join(FRONTEND, 'lib', 'apiClient.ts'), 'utf8');
  /*
   * `request()` ends unconditionally in `response.json()`, which is why every export the server has
   * built since Phase 5.4 had no reachable caller. A binary path is the whole of the fix, and its
   * absence is what to assert on: `blob()` appearing anywhere in the client.
   */
  check('the API client can read a binary response, so an export has somewhere to land',
    /response\.blob\(\)/.test(clientSrc), true);
  check('  and the download travels with the bearer token, which is why a pasted URL never worked',
    /function download\(/.test(clientSrc)
      && /headers\.Authorization = `Bearer \$\{accessToken\}`/.test(clientSrc), true);
  check('  and both of §22\'s file formats are offered on the screen',
    [/runExport\('excel'\)/.test(srcCode), /runExport\('pdf'\)/.test(srcCode)], [true, true]);
  /*
   * Gated on the key the router's conditional `exportGuard` checks, and on no other. A screen that
   * gated exports on `reports.view` would show buttons that 403.
   */
  check('  gated on reports.export, the key the conditional export guard actually checks',
    /can\('reports\.export'\)/.test(srcCode), true);

  /* ── finding 29: print is client-side, and now exists ── */

  const cssPath = path.join(FRONTEND, 'app', 'globals.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  check('a print stylesheet exists, so Ctrl+P prints the report and not the navigation',
    /@media\s+print\s*\{/.test(css), true);
  check('  and the screen offers the control FR-REPORT-002 phrases as an action',
    /window\.print\(\)/.test(srcCode), true);

  /*
   * The print block hides the shell's chrome by structure (`body > div > header`), and a structural
   * selector is exactly the kind that rots silently when the shell is rearranged. So the elements it
   * names are checked against the shell that renders them.
   */
  const shell = fs.readFileSync(path.join(FRONTEND, 'components', 'shell.tsx'), 'utf8');
  check('  and the elements the print rules hide are the ones the shell actually renders',
    [/<header\b/.test(shell), /<nav\b/.test(shell), /<main\b/.test(shell)], [true, true, true]);

  /*
   * The server half of finding 29. `print` stays out of `SUPPORTED_FORMATS` — there is no view engine
   * here to produce a "print-ready payload" — and the constant's comment must no longer promise one.
   * Asserted here rather than in `verify-reports.js` because the promise and its refutation now live
   * on opposite sides of the stack.
   */
  const constantsPath = path.resolve(__dirname, '..', 'src', 'config', 'constants.js');
  const constantsText = fs.readFileSync(constantsPath, 'utf8');
  check('and constants.js no longer promises a print-ready payload nothing can produce',
    /print-ready payload/.test(constantsText), false);
  check('  while still declaring print client-side rather than deleting §22\'s third format',
    /`print` is \*\*client-side/.test(constantsText)
      && /PRINT: 'print'/.test(constantsText), true);
}

/* ────────────────────── the public root: a landing page and a 404 ────────────────────── */

/*
 * `/` had no route at all. Every screen lives behind `AppShell`, which redirects an unauthenticated
 * caller to `/login`, so the root URL — the one a person types and the one a link in an email lands
 * on — rendered Next's built-in 404. These assertions hold the two public routes in place.
 */
const APP = path.join(FRONTEND, 'app');
check('the root URL has a page, so `/` is not Next\'s built-in 404',
  fs.existsSync(path.join(APP, 'page.tsx')), true);
check('  and a root not-found, so an unknown URL is this product\'s 404 and not the framework\'s',
  fs.existsSync(path.join(APP, 'not-found.tsx')), true);

const landing = fs.readFileSync(path.join(APP, 'page.tsx'), 'utf8');

/*
 * The landing page must not grow a sign-up. SRS §9.3 has the Super Admin create principals; there is
 * no self-registration endpoint, and a button promising one would be inventing a requirement in the
 * most visible place in the product. Read from comment-stripped code — the file *explains* the
 * absence in prose, and the prose must not be what satisfies the rule (the substring trap this
 * project has now hit seven times).
 */
const landingCode = code(landing);
check('the landing page offers no sign-up route, because §9.3 has no self-registration',
  /href=["'`]\/(signup|register)/.test(landingCode), false);
check('  and it does route a visitor to the sign-in that does exist',
  /href=["'`]\/login["'`]/.test(landingCode), true);

/*
 * `AppShell` is what redirects; mounting it here would make the public page private and the root URL
 * would bounce to `/login` again — the exact defect these assertions exist to prevent.
 */
check('  and it does not mount AppShell, which would make the public page redirect to /login',
  /AppShell/.test(landingCode), false);

/* ────────────────────── a successful create says so ────────────────────── */

/*
 * All eighteen create screens ended in `router.replace('/the-list')` and said nothing at all.
 * `ToastProvider` has been mounted app-wide in `app/layout.tsx` since the design system landed and
 * **not one screen used it** — so an operator filled in a form, pressed the button, and arrived at a
 * paginated list where the new row may not even be on the first page. Nothing told them it worked.
 *
 * The provider sits above the router, so the toast outlives the navigation it precedes — verified in
 * a browser, not assumed: creating a subject lands on `/school/subjects` with "Subject created"
 * still on screen.
 *
 * Also asserted: the confirmation comes **before** the navigation. Calling it after `router.replace`
 * would still compile and would usually still work, and "usually" is not a contract.
 */
{
  const createScreens = sourceFiles(FRONTEND).filter((file) =>
    /[\\/]new[\\/]page\.tsx$/.test(file)
  );

  const silent = createScreens.filter((file) => {
    const text = code(fs.readFileSync(file, 'utf8'));
    /* Only screens that actually navigate on success are in scope. */
    if (!/router\.replace\('\//.test(text)) return false;
    return !/\bsuccess\(/.test(text);
  });
  check('every create screen confirms the record it just made',
    silent.map(relative).sort(), []);

  const wrongOrder = createScreens.filter((file) => {
    const text = code(fs.readFileSync(file, 'utf8'));
    const say = text.search(/\bsuccess\('/);
    const go = text.search(/router\.replace\('\//);
    return say !== -1 && go !== -1 && say > go;
  });
  check('  and says it before it navigates away',
    wrongOrder.map(relative).sort(), []);
}

/* ────────────────────── a create form's controls all describe their own errors ────────────────────── */

/*
 * Every one of the eighteen create screens already used `Field` — 148 times between them — and not
 * one used `SelectField` or `TextAreaField`. So every select and textarea on every create form was
 * hand-rolled: no `aria-invalid`, no `aria-describedby`, and its 422 message rendered as a loose
 * `<p>` that nothing associates with the control.
 *
 * That is not only a screen-reader problem. `focusFirstInvalidField()` finds the first control by
 * querying `[aria-invalid="true"]`, so on `students/new` a 422 naming `class_id` had **no target at
 * all** — the page did not scroll, the banner was correctly suppressed because a field was carrying
 * the message, and a 28-field form looked untouched.
 *
 * 65 selects, 18 textareas and 7 inputs moved. The rule holds the line at zero.
 *
 * The one allowed exception is a **search box**: the account pickers filter their own options and
 * hold no submitted value, so there is no error for a wrapper to describe. It is allowed only when
 * `type="search"` says so.
 */
{
  const createScreens = sourceFiles(FRONTEND).filter((file) =>
    /[\\/]new[\\/]page\.tsx$/.test(file)
  );

  /* A rule that finds no screens passes by looking at nothing. */
  check('the create screens are discoverable', createScreens.length >= 15, true);

  const handRolled = [];
  for (const file of createScreens) {
    const text = code(fs.readFileSync(file, 'utf8'));
    const offences = [];

    const selects = (text.match(/<select\b/g) || []).length;
    const textareas = (text.match(/<textarea\b/g) || []).length;
    if (selects) offences.push(`${selects} <select>`);
    if (textareas) offences.push(`${textareas} <textarea>`);

    /* Inputs are allowed only where they are a picker's own filter. */
    for (const m of text.matchAll(/<input\b[\s\S]{0,200}?>/g)) {
      if (!/type="search"/.test(m[0])) offences.push('a non-search <input>');
    }

    if (offences.length) handRolled.push(`${relative(file)}: ${offences.join(', ')}`);
  }

  check('no create screen hand-rolls a control instead of using the shared field components',
    handRolled.sort(), []);

  /* And the components are genuinely in use, not merely un-violated. */
  const usingWrappers = createScreens.filter((file) =>
    /<(SelectField|TextAreaField|CheckboxField)\b/.test(code(fs.readFileSync(file, 'utf8')))
  );
  check('  and the wrappers are what they use instead',
    usingWrappers.length >= 15, true);

  /*
   * `CheckboxField` must keep accepting an error. It did not, and that omission was the stated
   * reason one control stayed hand-rolled — a wrapper that silently drops a field error is worse
   * than the raw input it replaces.
   */
  const formSource = code(fs.readFileSync(path.join(FRONTEND, 'components', 'form.tsx'), 'utf8'));

  /*
   * Read the checkbox's own element, not the props type above it.
   *
   * The first version of this was `/error\?: string \| null;[\s\S]{0,400}?type="checkbox"/ || …`,
   * and a deliberate regression that stripped the `aria-invalid` wiring **still passed** — because
   * the `error?: string | null` declaration was left in the props and that alternative matched it.
   * Declaring a prop and using it are different things, which is the whole point of the assertion.
   */
  const checkboxTag = /<input\b[^>]*?type="checkbox"[\s\S]*?\/>/.exec(formSource);
  check('  and a checkbox can carry a field error like every other control',
    Boolean(checkboxTag)
      && /aria-invalid=\{Boolean\(error\)\}/.test(checkboxTag[0])
      && /aria-describedby=\{error \?/.test(checkboxTag[0]), true);
}

/* ────────────────────── a list keeps its shape while it reloads ────────────────────── */

/*
 * Thirty screens rendered `<p className="text-sm text-muted">Loading…</p>` in place of the whole
 * table, on **every** refetch — so each debounced keystroke tore the list out of the document,
 * threw away the scroll position, and flashed the page down to one line of text and back.
 *
 * Two components already existed for this and nothing used them. `LoadingBlock` is a table-shaped
 * skeleton for the first load, and `DataTable`'s `busy` prop dims the rows in place for every load
 * after it — which is the one that matters, because a refetch is a change to a list the user is
 * already reading.
 *
 * The rule is the paragraph, not the components, because that string is the thing that keeps being
 * typed. Read from comment-stripped code: this file and several screens now *describe* the old
 * markup in prose.
 */
{
  const bareLoading = sourceFiles(FRONTEND)
    .filter((file) => /<p className="text-sm text-muted">Loading/.test(code(fs.readFileSync(file, 'utf8'))))
    .map(relative);

  check('no screen replaces its content with a bare loading paragraph', bareLoading.sort(), []);

  /*
   * And the skeleton is actually reachable — a rule that only bans the old thing is satisfied by
   * rendering nothing at all, which is worse than the paragraph it replaced.
   */
  const usingSkeleton = sourceFiles(FRONTEND)
    .filter((file) => /<LoadingBlock\b/.test(code(fs.readFileSync(file, 'utf8'))));
  check('  and the skeleton is what they render instead',
    usingSkeleton.length >= 25, true);

  /*
   * `busy` is what stops a *refetch* unmounting the table. Asserted as a floor rather than per-file:
   * a handful of tables sit inside a child component that only renders once its parent has resolved,
   * where the prop would be meaningless — those are the three that were removed again after `tsc`
   * caught the flag out of scope.
   */
  const withBusy = sourceFiles(FRONTEND)
    .filter((file) => /<DataTable[\s\S]{0,600}?busy=\{/.test(code(fs.readFileSync(file, 'utf8'))));
  check('  and a refetch dims the table rather than unmounting it',
    withBusy.length >= 25, true);
}

/* ────────────────────── every colour comes from a token, not the palette ────────────────────── */

/*
 * Dark mode is a token swap, and it only works if no screen reaches past the tokens.
 *
 * `globals.css` defines three layers — primitives, then semantics (`--ink`, `--surface-1`, `--warn`),
 * then components — and redefines only the **semantic** layer per theme. A screen writing a raw
 * Tailwind palette class gets a colour that is fixed across both themes, and the failure is
 * asymmetric: it looks right in whichever theme it was authored in and wrong in the other, so it
 * survives review.
 *
 * Two rounds of this were fixed by hand. First `bg-white` with the themed `text-ink`, in **fourteen**
 * screens — near-white text on a white box in dark mode. Then seven `amber-*` classes marking warning
 * states, which the semantic `--warn` family already covers. Both rounds were found by grepping, and
 * the second survived the first because that grep only listed the grey families. So the rule is
 * asserted over the **whole** palette rather than over the families that happened to bite.
 *
 * `white` and `black` are included: they are not palette *steps*, but they are exactly as fixed.
 */
{
  const FAMILIES = [
    'slate', 'gray', 'zinc', 'neutral', 'stone',
    'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan',
    'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
  ];
  const PROPS = [
    'bg', 'text', 'border', 'ring', 'placeholder', 'divide', 'from', 'to', 'via',
    'decoration', 'outline', 'accent', 'caret', 'fill', 'stroke',
  ];
  const palette = new RegExp(
    `\\b(?:${PROPS.join('|')})-(?:(?:${FAMILIES.join('|')})-[0-9]{2,3}|white|black)\\b`,
    'g'
  );

  /* If this stops matching anything the rule has gone blind — see the dead-link pattern above. */
  check('the palette rule still recognises a raw colour',
    palette.test('text-slate-500 bg-white'), true);

  const rawColours = [];
  for (const file of sourceFiles(FRONTEND)) {
    /* Comment-stripped: this file's own prose names the classes it forbids. */
    const text = code(fs.readFileSync(file, 'utf8'));
    const hits = [...new Set(text.match(palette) ?? [])];
    if (hits.length > 0) rawColours.push(`${relative(file)}: ${hits.sort().join(', ')}`);
  }

  check('no screen reaches past the semantic tokens to a raw palette colour',
    rawColours.sort(), []);
}

/* ────────────────────── no invisible characters in the source ────────────────────── */

/*
 * A control character is invisible in every editor and every diff, and inside a regex it changes
 * what the pattern means rather than raising an error.
 *
 * This is here because it happened twice in one session, from the same cause: a non-raw Python string
 * in a code-generation step turned `'\\b'` into a literal **backspace** (0x08) on the way to disk.
 * The frontend copy made a currency-code parse match nothing, so a refusal the screen was meant to
 * recover from stayed a dead end. The backend copy was worse — it sat inside one of §24's XSS
 * assertions and made it pass **vacuously**, which is why `tests/verify.test.js` now refuses them in
 * the verify scripts too.
 *
 * Tab, newline and carriage return are ordinary whitespace and are allowed. Nothing else is.
 */
{
  const withControlCharacters = [];
  for (const file of sourceFiles(FRONTEND)) {
    const text = fs.readFileSync(file, 'utf8');
    const found = new Set();
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      if (codePoint >= 32 || [9, 10, 13].includes(codePoint)) continue;
      found.add(codePoint);
    }
    if (found.size > 0) {
      withControlCharacters.push(`${relative(file)}: ${[...found].sort((a, b) => a - b).join(', ')}`);
    }
  }
  check('no screen contains an invisible control character',
    withControlCharacters.sort(), []);
}

/* ────────────────────── money is a number on both sides of the wire ────────────────────── */

/*
 * `models/columns.js` defines `money()` as `DECIMAL(14, 2)`, and `config/database.js` sets
 * `dialectOptions.decimalNumbers = true`, so mysql2 parses every one of those columns into a JS
 * **number** before Sequelize sees it. Measured through the model layer, not assumed:
 * `Subscription.cycle_amount` reads back as the number `499` from both `.get()` and `.toJSON()`.
 *
 * Seven screens declared a money field as `string` or `boolean` anyway, and four prose comments
 * asserted the opposite of the truth. Two of the seven were not merely untidy:
 *
 *   - `subscriptions/page.tsx` built a formatter on the premise, splitting on `'.'` — so a `499.00`
 *     cycle amount rendered as **`499`** and `1200.50` as `1,200.5`;
 *   - `library/page.tsx` typed `fine_paid` as a **boolean** and read it as a flag. It is the amount
 *     paid so far, so a 10.00 fine with 4.00 paid arrived as `4`, which is truthy, and the row said
 *     **"paid"** while 6.00 was still owed — worst in the "only unpaid fines" view, whose server
 *     filter is exactly `fine_amount > fine_paid`.
 *
 * So the rule is asserted rather than remembered. A union that *includes* `number` is fine — it is
 * defensive against that one dialect option being flipped — and any name not declared by `money()`
 * is none of this rule's business.
 */
{
  const modelsDir = path.resolve(__dirname, '..', 'src', 'models');
  const moneyColumns = new Set();
  for (const entry of fs.readdirSync(modelsDir)) {
    if (!entry.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(modelsDir, entry), 'utf8');
    for (const m of text.matchAll(/^\s+([a-z_]+):\s*money\(/gm)) moneyColumns.add(m[1]);
  }

  /* If this ever reads 0 the rule has stopped looking at anything — a silent pass. */
  check('the money columns are discoverable from the models',
    moneyColumns.size > 20, true);

  const mistyped = [];
  for (const file of sourceFiles(FRONTEND)) {
    const lines = code(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      const m = /^\s{2,}([a-z_]+)\??:\s*([^;]+);\s*$/.exec(line);
      if (!m) return;
      const [, name, type] = m;
      if (!moneyColumns.has(name)) return;
      if (/\bnumber\b/.test(type)) return;
      if (/^(boolean|string)(\s*\|\s*null)?$/.test(type.trim())) {
        mistyped.push(`${relative(file)}:${index + 1} ${name}: ${type.trim()}`);
      }
    });
  }

  check('no screen types a DECIMAL money column as a string or a boolean',
    mistyped.sort(), []);

  /*
   * The library screen renders `fine_outstanding` rather than deciding "paid" from `fine_paid`, and
   * that only works if the **list** path supplies it. Checked from both sides, because getting this
   * half wrong would be worse than the bug it replaced: an absent field is `undefined`, `Number()`
   * of it is `NaN`, `NaN <= 0` is false — so a settled fine would read as a debt, and had the
   * comparison gone the other way every fine would read "paid" again.
   */
  const libraryScreen = code(fs.readFileSync(
    path.join(FRONTEND, 'app', '(school)', 'school', 'library', 'page.tsx'), 'utf8'
  ));
  const libraryService = code(fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'modules', 'library', 'library.service.js'), 'utf8'
  ));
  check('the library screen shows the fine balance the server computes',
    /row\.fine_outstanding/.test(libraryScreen), true);
  check('  and the list endpoint puts it on every row',
    /fine_outstanding:/.test(libraryService)
      && /rows: result\.rows\.map\(presentTransaction\)/.test(libraryService), true);
}

/* ────────────────────── a rejected submit always says something ────────────────────── */

/*
 * `reset-password` validates `{ token, password }` and deliberately never puts the token in a field
 * — it is a credential from an emailed link. The screen suppressed its banner whenever the 422
 * carried any field error at all (`details.length ? null : message`), so a link mangled by a mail
 * client produced a 422 naming `token`, no input to render it, and **no visible output whatsoever**.
 * `ApiError.bannerFor()` decides this from the fields a form actually renders.
 */
check('a form can ask which message belongs at its top',
  /bannerFor\(renderedFields: string\[\]\)/.test(
    code(fs.readFileSync(path.join(FRONTEND, 'lib', 'apiClient.ts'), 'utf8'))
  ), true);

const authScreens = ['login', 'change-password', 'reset-password'];
const stillSuppressing = authScreens.filter((name) => {
  const text = code(fs.readFileSync(path.join(FRONTEND, 'app', '(auth)', name, 'page.tsx'), 'utf8'));
  return /details\.length\s*\?\s*null/.test(text);
});
check('  and no auth screen suppresses its banner by counting field errors',
  stillSuppressing, []);

const usingBanner = authScreens.filter((name) =>
  /caught\.bannerFor\(\[/.test(code(fs.readFileSync(path.join(FRONTEND, 'app', '(auth)', name, 'page.tsx'), 'utf8')))
);
check('  and all three ask for it instead', usingBanner.length, authScreens.length);

/* ────────────────────── two screens that read the wrong thing ────────────────────── */

/*
 * The Reports screen cast its payload using the **selected tab** rather than the payload's own
 * `type`. The tab handler changes only the selection, and `report` is cleared inside the read effect
 * — which has not run yet — so clicking Subscriptions over a Students report rendered the previous
 * payload through the subscription shape and threw `Object.entries(undefined)` mid-render. There is
 * no `error.tsx` anywhere under `app/`, so that crash took the screen out until a reload.
 */
{
  const reports = code(fs.readFileSync(
    path.join(FRONTEND, 'app', '(platform)', 'super-admin', 'reports', 'page.tsx'), 'utf8'
  ));
  check('the Reports screen decides which report it holds from the payload, not the tab',
    /report && report\.type === 'subscription'/.test(reports), true);
  check('  and clears the previous report when the tab changes',
    /setSelected\(entry\.type\);[\s\S]{0,120}setReport\(null\)/.test(reports), true);
}

/*
 * `callerEntitlements()` returns null for a platform or organization caller — `if (!req.tenant ||
 * req.tenant.isPlatform || !req.tenant.schoolId) return null;` — while an *unsubscribed school* gets
 * an object with `plan: null`. The school dashboard read `!entitlements` as "no plan" and told a
 * Super Admin who opened `/school` that the school had no subscription, hiding the limits, the module
 * list and every shortcut behind the same condition.
 */
{
  const dashboard = code(fs.readFileSync(
    path.join(FRONTEND, 'app', '(school)', 'school', 'page.tsx'), 'utf8'
  ));
  check('the school dashboard distinguishes "no school in scope" from "no plan"',
    /!isSubscriptionScoped/.test(dashboard), true);
  check('  and still handles the unsubscribed-school snapshot separately',
    /entitlements\.plan \?/.test(dashboard), true);
}

/* ────────────────────── the client adopts the CSRF token the server rotates ────────────────────── */

/*
 * `issueCsrfToken()` mints a **new** value and re-sets the cookie every time it runs, and
 * `publishSession()` runs it on login, on refresh and on change-password — returning the value as
 * `body.csrfToken` for exactly this reason ("Rotated with the session, so a client that just signed
 * in can immediately POST").
 *
 * The client never read it: `ensureCsrfToken()` cached the value fetched from `/csrf-token` before
 * signing in and held it. From the moment of login the cookie and the header disagreed, and
 * `requireCsrfToken()` guards both `POST /auth/refresh` and `POST /auth/logout`.
 *
 * Measured: signing out gave `POST /auth/logout → 403`, the UI went to `/login` anyway because
 * `clear()` runs in a `finally`, and the user row still had `refresh_token_hash` set — the session
 * was never ended and the httpOnly refresh cookie stayed valid. After the fix the same action gives
 * `200` and the hash is null. These assertions hold both halves of that contract in place.
 */
const clientText = fs.readFileSync(path.join(FRONTEND, 'lib', 'apiClient.ts'), 'utf8');
const clientCode = code(clientText);
const authText = fs.readFileSync(path.join(FRONTEND, 'lib', 'auth.tsx'), 'utf8');
const authCode = code(authText);

check('the client can adopt a rotated CSRF token',
  /export function setCsrfToken\(/.test(clientCode), true);

/*
 * The server half, asserted here rather than taken on trust: if `publishSession()` ever stopped
 * returning the field, the client would be reading `undefined` and the desync would come back
 * silently. The client's read and the server's write are checked against each other.
 */
const authControllerText = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'modules', 'auth', 'auth.controller.js'), 'utf8'
);
check('  and the server still publishes one for it to adopt',
  /body\.csrfToken = csrfToken/.test(code(authControllerText)), true);

check('  and the session bootstrap adopts the one the refresh rotated',
  /setCsrfToken\(body\.data\?\.csrfToken\)/.test(clientCode), true);

check('  and login adopts it, so the first POST after signing in is not refused',
  /setCsrfToken\(result\.csrfToken\)/.test(authCode), true);

check('  and so does the forced password change, which rotates it the same way',
  /setCsrfToken\(session\.csrfToken\)/.test(authCode), true);

/* A read of a field the type does not declare is a `tsc` error waiting to be silenced with `any`. */
check('  and the login result type declares the field all three of those read',
  /csrfToken\?:\s*string/.test(authCode), true);

/* ────────────────────── one landing route, not four copies of a guess ────────────────────── */

/*
 * `login`, `change-password`, the landing page and the shell each carried
 * `isPlatform ? '/super-admin' : '/school'`. `PLATFORM_ROLES` is `[ROLES.SUPER_ADMIN]`, so that
 * expression sent every other role to `/school` — including `parent`, whose grant block holds no
 * `school.dashboard.view` at all. A parent landed on the school administration dashboard and `/parent`
 * was unreachable, because the only link to it is inside `PARENT_NAV`.
 */
const navText = fs.readFileSync(path.join(FRONTEND, 'lib', 'nav.ts'), 'utf8');
const navCode = code(navText);

check('the landing route is decided in one place',
  /export function landingRouteFor\(/.test(navCode), true);

const LANDING_CALLERS = [
  ['app', '(auth)', 'login', 'page.tsx'],
  ['app', '(auth)', 'change-password', 'page.tsx'],
  ['app', 'page.tsx'],
  ['components', 'shell.tsx'],
];
const callersUsingHelper = LANDING_CALLERS.filter((parts) =>
  /landingRouteFor\s*\(/.test(code(fs.readFileSync(path.join(FRONTEND, ...parts), 'utf8')))
);
check('  and every screen that routes a signed-in caller uses it',
  callersUsingHelper.length, LANDING_CALLERS.length);

/*
 * The two-way guess must not come back. Read from comment-stripped code — the helper's own docblock
 * quotes the line it replaced, and prose must not be what satisfies the rule.
 */
const reintroduced = sourceFiles(FRONTEND)
  .filter((file) => /isPlatform\s*\?\s*'\/super-admin'\s*:\s*'\/school'/.test(
    code(fs.readFileSync(file, 'utf8'))
  ))
  .map(relative);
check('  and no screen decides it inline again', reintroduced, []);

/*
 * Order is load-bearing, because three roles hold more than one of these keys: `teacher` holds both
 * `teachers.dashboard.view` and `school.dashboard.view`, and `parent` holds both
 * `parents.dashboard.view` and `results.self.view`. Tested by position, not by presence.
 */
const landingOrder = [...navCode.matchAll(/permission:\s*'([^']+)',\s*href:\s*'([^']+)'/g)]
  .map((m) => [m[1], m[2]]);
check('  and claims each surface in most-specific-first order',
  landingOrder,
  [
    ['platform.dashboard.view', '/super-admin'],
    ['parents.dashboard.view', '/parent'],
    ['teachers.dashboard.view', '/teacher'],
    ['school.dashboard.view', '/school'],
    ['results.self.view', '/student'],
  ]);

check('  naming only permissions that exist in the fixed catalogue',
  landingOrder.map(([key]) => key).filter((key) => !PERMISSION_KEY_SET.has(key)), []);

/*
 * The platform surface is `platformOnly()` on every route, and `organization_admin` holds
 * `platform.dashboard.view` while being `isPlatform: false`. Without the scope test it would be sent
 * to a console that refuses it — a worse outcome than the `/school` it reaches today.
 */
check('  and gates the platform surface on scope as well as permission',
  /platformOnly:\s*true/.test(navCode)
    && /route\.platformOnly && !profile\.tenant\.isPlatform/.test(navCode), true);

/* ────────────────────── the duplicated module list stays in step ────────────────────── */

/*
 * `frontend/src/lib/modules.ts` copies the twenty §11 module keys, because the landing page renders
 * before there is a session to read an entitlement snapshot from. A copy that can drift is worth
 * exactly as much as the assertion holding it in step, so: same keys, same labels, same order, same
 * count — and no twenty-first (§35).
 */
const { MODULE_LABELS: backendModules } = require('../src/config/constants');
const modulesText = fs.readFileSync(path.join(FRONTEND, 'lib', 'modules.ts'), 'utf8');
const frontendModules = [...code(modulesText).matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)]
  .map((match) => [match[1], match[2]]);

check('the frontend module list is the backend\'s, key for key and label for label',
  frontendModules, Object.entries(backendModules));
check('  and it is still exactly the twenty §11 modules, so §35\'s "no twenty-first" holds on both sides',
  [frontendModules.length, Object.keys(backendModules).length], [20, 20]);


/* ────────────────────────────── the shared form layer ────────────────────────────── */

/*
 * Every form in the product is built from `components/form.tsx`, and these hold that in place.
 *
 * The rules exist because each one was, at some point, not true: eighteen create screens ended in a
 * bare underlined `Cancel` link 17px tall; nine password inputs had no way to read back what was
 * typed; twenty-five search boxes were hand-rolled; and two components existed for the one search
 * control. A shared layer that any screen may opt out of is a suggestion, not a layer.
 */

const CREATE_PAGES = sourceFiles(APP).filter(
  (file) => /(^|[\\/])new[\\/]page\.tsx$/.test(file)
);

check('every create screen is found where the audit said they were',
  CREATE_PAGES.length, 18);

/*
 * The required marker is a red asterisk on screen and the word "(required)" to a screen reader.
 *
 * Both halves are asserted, because each is useless without the other: the glyph alone is a marker
 * carried by a colour, and the word alone is what this used to be. `aria-hidden` on the asterisk is
 * part of the rule too — without it a screen reader announces "star".
 */
const labelBody = /function FieldLabel\([\s\S]*?(?=\n\/\*\*|\nfunction )/
  .exec(code(fs.readFileSync(path.join(FRONTEND, 'components', 'form.tsx'), 'utf8')));
check('the required marker is an asterisk',
  labelBody !== null && /aria-hidden[\s\S]{0,120}\*/.test(labelBody[0]), true);
check('  hidden from assistive technology, which would otherwise read it as "star"',
  labelBody !== null && /aria-hidden/.test(labelBody[0]), true);
check('  and paired with the word, so the marker is never only a colour',
  labelBody !== null && /sr-only[^>]*>\s*\(required\)/.test(labelBody[0]), true);

/*
 * Cancel is a real button. The old shape — `<a className="text-sm underline underline-offset-2">`
 * — is asserted absent by its exact class string, because that is what eighteen files carried and
 * what a copy-paste of an old screen would reintroduce.
 */
const bareCancel = CREATE_PAGES.filter((file) =>
  /<a[^>]*className="text-sm underline underline-offset-2"/.test(code(fs.readFileSync(file, 'utf8')))
).map(relative);
check('  and none of them ends in a bare underlined Cancel link', bareCancel, []);

const withoutActions = CREATE_PAGES.filter(
  (file) => !/<FormActions\b/.test(code(fs.readFileSync(file, 'utf8')))
).map(relative);
check('  and every one uses FormActions, so the button hierarchy is one component\'s decision',
  withoutActions, []);

const withoutSections = CREATE_PAGES.filter(
  (file) => !/<FormSection\b/.test(code(fs.readFileSync(file, 'utf8')))
).map(relative);
check('  and every one groups its fields into FormSections', withoutSections, []);

/*
 * A `<h2>` inside a create form is the hand-rolled section heading `FormSection` replaced. Two
 * screens had grown their own, and when the sections landed each heading appeared twice.
 */
const handRolledHeadings = CREATE_PAGES.filter(
  (file) => /<h2\b/.test(code(fs.readFileSync(file, 'utf8')))
).map(relative);
check('  and none hand-rolls a section heading beside the component that draws one',
  handRolledHeadings, []);

/*
 * Passwords. `PasswordField` is the only control that may render `type="password"`, so the reveal
 * toggle cannot be bypassed by a screen that writes its own input.
 */
const rawPasswords = sourceFiles(APP)
  .filter((file) => /type="password"/.test(code(fs.readFileSync(file, 'utf8'))))
  .map(relative);
check('no screen writes a raw password input; PasswordField is the only one', rawPasswords, []);

const formSource = fs.readFileSync(path.join(FRONTEND, 'components', 'form.tsx'), 'utf8');
const formCode = code(formSource);

check('  and PasswordField toggles the type rather than rendering two inputs',
  /type=\{shown \? 'text' : 'password'\}/.test(formCode), true);
check('  and its toggle is a button, so pressing it cannot submit the form',
  /aria-pressed=\{shown\}/.test(formCode) && /type="button"/.test(formCode), true);

/*
 * `<select multiple>` needs ctrl-click, which nothing says and no touch device has. The coupon
 * restrictions were the only two, and they are a checkbox list now.
 */
const multiSelects = sourceFiles(FRONTEND)
  .filter((file) => /<select[^>]*\bmultiple\b|\bmultiple\n/.test(code(fs.readFileSync(file, 'utf8'))))
  .map(relative);
check('nothing renders a native multiple-select', multiSelects, []);

/*
 * One search control, not two. `SearchInput` used to live in `components/table.tsx` as a near-copy
 * of `SearchField`, down to the same defeated `pl-9`.
 */
const tableSource = fs.readFileSync(path.join(FRONTEND, 'components', 'table.tsx'), 'utf8');
check('there is one search component, in the form layer',
  /export function SearchInput\b/.test(code(tableSource)), false);
check('  and it is SearchField', /export function SearchField\b/.test(formCode), true);

/*
 * Filter rows go through `FilterBar`. A raw `<input type="search">` anywhere in the app means a
 * screen has gone its own way again.
 */
const rawSearchInputs = sourceFiles(APP)
  .filter((file) => /<input\b[\s\S]{0,300}?type="search"/.test(code(fs.readFileSync(file, 'utf8'))))
  .map(relative);
check('no screen hand-rolls a search input', rawSearchInputs, []);
/* `SearchField` is the one place in the product allowed to declare one. */
check('  because exactly one component declares one',
  (formCode.match(/type="search"/g) || []).length, 1);

/* ─────────────────── two cascade bugs that silently disabled utilities ─────────────────── */

/*
 * `globals.css` is plain CSS after `@import "tailwindcss"`, and an **unlayered** rule beats every
 * layered one whatever its specificity. The `*` border-colour default therefore beat every
 * `border-*` colour utility in the application — seventy-two of them across nineteen files, all
 * silently painting `var(--border)`. It has to stay inside `@layer base`.
 */
const globalCss = fs.readFileSync(path.join(FRONTEND, 'app', 'globals.css'), 'utf8');
const layeredBorderDefault = /@layer base\s*\{[^]*?\*,\s*\*::before,\s*\*::after\s*\{\s*border-color:/
  .test(globalCss);
check('the global border-colour default sits in @layer base, so border utilities still win',
  layeredBorderDefault, true);

/*
 * `.field-label` must not declare `display`. It set `display: block`, which beat the `flex` on
 * `FieldLabel` and collapsed its `gap` — so every required field read "Email or usernameREQUIRED".
 */
const fieldLabelRule = /\.field-label\s*\{([^}]*)\}/.exec(globalCss);
check('.field-label declares no display, so FieldLabel\'s flex gap survives',
  fieldLabelRule !== null && !/display\s*:/.test(fieldLabelRule[1]), true);

/*
 * The padding a control needs for an icon inside it cannot be a Tailwind utility, for the same
 * reason: `.field-input` sets `padding` as plain CSS and wins. The search box shipped with `pl-9`,
 * kept its 12px padding, and drew its placeholder underneath the magnifier.
 */
check('  and the in-control padding is a real class rather than a defeated utility',
  /\.field-input\.has-leading-icon\s*\{\s*padding-left:/.test(globalCss), true);
check('  which SearchField uses instead of pl-9',
  /has-leading-icon/.test(formCode) && !/field-input[^"`]*\bpl-9\b/.test(formCode), true);

/*
 * `md:hidden` cannot hide a `.btn` either — the navigation drawer's trigger was visible at every
 * width, a hamburger beside the sidebar it opens.
 */
check('  and a mobile-only button has a class that can actually hide it',
  /@media \(min-width: 48rem\)\s*\{\s*\.btn\.btn-mobile-only\s*\{\s*display:\s*none/.test(globalCss),
  true);
const shellCode = code(fs.readFileSync(path.join(FRONTEND, 'components', 'shell.tsx'), 'utf8'));
check('  which the drawer trigger uses instead of md:hidden',
  /btn-mobile-only/.test(shellCode) && !/btn[^"]*\bmd:hidden/.test(shellCode), true);

/* ─────────────────────── validation messages are written for people ─────────────────────── */

/*
 * Joi names the column, so an empty New Principal form answered `school_id is required` under a
 * label reading "School". `humaniseFieldError` replaces a leading field key with the label already
 * on screen, and leaves any message it does not recognise exactly as it arrived.
 */
check('field errors are humanised before they are shown',
  /export function humaniseFieldError\(/.test(formCode), true);
check('  and every field wrapper passes the label in, or the rewrite cannot happen',
  (formCode.match(/<FieldMessage\b/g) || []).length,
  (formCode.match(/field=\{(?:id|name)\}/g) || []).length);

/*
 * The two ends of the rewrite, asserted by behaviour rather than by the presence of the function:
 * a message that names the column is rewritten, and a message that is already a sentence is not.
 */
const humanise = (message, field, label) => {
  const key = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leading = new RegExp(`^"?${key}"?\\s+`);
  if (!leading.test(message)) return message;
  return `${label} ${message
    .replace(leading, '')
    .replace(/^length (must be (?:at least|at most|less than|greater than) \d+) characters long$/, '$1 characters')
    .replace(/^length must be (\d+) characters long$/, 'must be exactly $1 characters')
    .replace(/^is not allowed to be empty$/, 'is required')}`;
};
check('  a message naming the column is rewritten to name the label',
  humanise('school_id is required', 'school_id', 'School'), 'School is required');
check('  Joi\'s "length must be" is unwound',
  humanise('username length must be at least 3 characters long', 'username', 'Username'),
  'Username must be at least 3 characters');
check('  Joi\'s string.empty reads as the required message it means',
  humanise('code is not allowed to be empty', 'code', 'Code for the copy'),
  'Code for the copy is required');
check('  and a message that is already a sentence is left alone',
  humanise('Password must be at least 8 characters long.', 'password', 'Password'),
  'Password must be at least 8 characters long.');

/*
 * The four assertions above run against the re-implementation directly overhead, not against
 * `form.tsx` — so a rule added to one and not the other would leave them agreeing about a product
 * that no longer behaves that way. This ties the two together: every rewrite in the real function
 * has a counterpart here, and adding one there without one here fails.
 */
const humaniseSource = /export function humaniseFieldError\([\s\S]*?\n\}/.exec(formCode);
check('  and the copy above rewrites exactly what the real function rewrites',
  humaniseSource !== null
    && (humaniseSource[0].match(/\.replace\(/g) || []).length
      === /* the copy: the key escape, the leading strip, and the three message rules */ 5, true);

/*
 * Double submission. Every post here is non-idempotent, so the guard is `disabled` while in flight
 * — measured in a browser as blocking three clicks 60ms apart down to one request.
 */
/*
 * Read out of `SubmitButton`'s own body, not out of the file.
 *
 * The first version of this check grepped the whole of `form.tsx` for `disabled={busy}` — and
 * passed with the guard deleted from the submit button, because `FileField`'s remove button carries
 * the same prop. That is the second time in this project an assertion has been satisfied by
 * something other than the thing it names, and both times the fix was to narrow the window rather
 * than to trust the substring.
 */
/*
 * From the declaration to whatever is declared next. A non-greedy `[\s\S]*?\n\}` stops at the
 * closing brace of the destructured props, which is before the body — so the first attempt at
 * narrowing the window narrowed it past the thing it was looking for.
 */
const submitBody = /export function SubmitButton\([\s\S]*?(?=\n\/\* ─|\nexport function )/
  .exec(formCode);
check('SubmitButton is where the double-submit guard lives',
  submitBody !== null, true);
/*
 * `busy || disabled`, not `busy`, since the set editors gained a "nothing has changed yet" gate.
 * The regression this guards against is `busy` dropping out of that expression, which would let a
 * second click through while the first request is still in flight — so the test names `busy`
 * explicitly rather than accepting any `disabled={…}`.
 */
check('  and it disables itself, and says so, while a request is in flight',
  submitBody !== null
    && /disabled=\{busy \|\| disabled\}/.test(submitBody[0])
    && /aria-busy=\{busy\}/.test(submitBody[0]), true);

const handRolledSubmits = sourceFiles(APP)
  .filter((file) => /<button[^>]*type="submit"/.test(code(fs.readFileSync(file, 'utf8'))))
  .map(relative);
check('  and no screen hand-rolls a submit button around that guard', handRolledSubmits, []);


/* ──────────────────── the endpoints that had no caller in the UI ──────────────────── */

/*
 * Nine working endpoints were unreachable from every screen in the product — an audit category of
 * its own, because each one is a feature the API offers and the UI does not.
 *
 * These assertions are **path-and-method** checks against the frontend source, not proof that a
 * screen is usable; that was measured in a browser and is recorded in the progress log. What they
 * prevent is the specific way this regressed in the first place: a route shipping with no caller,
 * and nothing noticing for as long as nobody went looking.
 *
 * Each is asserted against the *comment-stripped* source, so a file that merely explains the gap in
 * prose does not satisfy the rule — a trap this project has now hit eight times.
 */

/**
 * Every API call the client makes, keyed `METHOD /path`, with interpolated ids collapsed to `:id`.
 *
 * ## Why this does not reuse `callsIn`
 *
 * `callsIn` matches `api.post('/literal')` — a **single-quoted** path — and nothing else. Every call
 * added for these nine features addresses one row, so every one is a template literal:
 * `api.patch(\`/staff/${row.id}\`, …)`. `callsIn` sees none of them, which is a real limit of the
 * earlier pass rather than a gap in the client, and its own header says as much.
 *
 * Widening `callsIn` would change what the "every path the client calls exists" assertion compares
 * against, on every screen at once. That is worth doing and is not worth doing inside this block, so
 * this collector is local, matches both forms, and normalises `${…}` to `:id`.
 */
const CLIENT_CALLS = new Set();
for (const file of sourceFiles(FRONTEND)) {
  const source = code(fs.readFileSync(file, 'utf8'));
  const call = /\bapi\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*(?:'([^']+)'|`([^`]+)`)/g;
  for (let m = call.exec(source); m; m = call.exec(source)) {
    const literal = m[2] ?? m[3];
    CLIENT_CALLS.add(`${m[1].toUpperCase()} ${literal.replace(/\$\{[^}]*\}/g, ':id')}`);
  }
}

function callsEndpoint(method, path) {
  return CLIENT_CALLS.has(`${method} ${path}`);
}

const UNREACHABLE = [
  ['POST', '/documents', 'a document can be generated'],
  ['POST', '/fees/assignments', 'a fee structure can be charged to students'],
  ['POST', '/fees/payments', 'a fee payment can be collected'],
  ['POST', '/library/transactions', 'a book can be issued'],
  ['PATCH', '/library/transactions/:id/return', 'a return can be recorded'],
  ['PATCH', '/library/transactions/:id/fine', 'a library fine can be settled'],
  ['POST', '/exams/:id/publish', 'exam results can be published'],
  ['POST', '/exams/:id/results', 'exam results can be calculated'],
  ['PATCH', '/staff/:id', 'a staff member can be deactivated'],
  ['PATCH', '/teachers/:id', 'a teacher can be deactivated'],
  ['PATCH', '/subjects/:id', 'a subject can be edited'],
  ['DELETE', '/subjects/:id', 'a subject can be deleted'],
  ['POST', '/subjects/:id/classes', 'a subject can be assigned to a class'],
  ['POST', '/subjects/:id/teachers', 'a teacher can be assigned to a subject'],
  ['PATCH', '/timetable/:id', 'a timetable slot can be corrected'],

  /*
   * The plan cluster — nine routes, four permission keys, all unreachable until 2026-09-09.
   *
   * Worth naming as a group because the catalogue was *write-once* without them: a plan could be
   * created and then never edited, priced, duplicated, activated, withdrawn or archived from any
   * screen in the product. FR-SUB-002 through FR-SUB-007 are the six requirements that describes,
   * and §33 names Plans, Modules, Features and Limits as screens — all four of which existed and
   * were read-only.
   */
  ['PATCH', '/plans/:id', 'a plan can be edited (FR-SUB-002)'],
  ['POST', '/plans/:id/duplicate', 'a plan can be duplicated (FR-SUB-003)'],
  ['POST', '/plans/:id/activate', 'a plan can be offered for new subscriptions (FR-SUB-004)'],
  ['POST', '/plans/:id/deactivate', 'a plan can be withdrawn from the catalogue (FR-SUB-004)'],
  ['POST', '/plans/:id/archive', 'a plan can be archived (FR-SUB-005)'],
  ['PUT', '/plans/:id/prices', 'a plan can be priced (FR-SUB-006)'],
  ['PUT', '/plans/:id/modules', 'a plan\'s modules can be chosen (FR-SUB-007)'],
  ['PUT', '/plans/:id/features', 'a plan\'s features can be configured (FR-SUB-007)'],
  ['PUT', '/plans/:id/limits', 'a plan\'s limits can be set (SRS §11.2)'],

  /*
   * The subscription cluster — fourteen routes, the largest single group with no caller, closed by
   * `super-admin/subscriptions/[id]`.
   *
   * Worth naming as a group for the same reason the plan cluster is: the module was **create-only**
   * without them. A school could be put on a plan and then never activated, suspended, paused,
   * resumed, cancelled, upgraded, downgraded or renewed from any screen in the product; no add-on
   * could be sold onto a subscription, and none of §33's three override kinds could be applied.
   * That is FR-SUB-009 through FR-SUB-015 — seven requirements — plus §33's SaaS engine.
   *
   * Two of the fourteen are reached through a table of per-action senders rather than by a call
   * written at the point of use. That is deliberate and the file says so: this collector matches
   * `api.<method>(` followed **immediately** by the literal, so a path assembled anywhere else is
   * invisible to it however literal it is.
   */
  ['PATCH', '/subscriptions/:id', 'a trial and grace period can be configured (FR-SUB-011 / FR-SUB-012)'],
  ['POST', '/subscriptions/:id/activate', 'a subscription can be activated (FR-SUB-010)'],
  ['POST', '/subscriptions/:id/suspend', 'a subscription can be suspended (FR-SUB-010)'],
  ['POST', '/subscriptions/:id/reactivate', 'a subscription can be reactivated (FR-SUB-010)'],
  ['POST', '/subscriptions/:id/pause', 'a subscription can be paused (FR-SUB-010)'],
  ['POST', '/subscriptions/:id/resume', 'a paused subscription can be resumed (FR-SUB-010)'],
  ['POST', '/subscriptions/:id/cancel', 'a subscription can be cancelled (FR-SUB-010)'],
  ['POST', '/subscriptions/:id/upgrade', 'a school can be upgraded (FR-SUB-013)'],
  ['POST', '/subscriptions/:id/downgrade', 'a school can be downgraded (FR-SUB-014)'],
  ['POST', '/subscriptions/:id/renew', 'a subscription can be renewed by hand (FR-SUB-015)'],
  ['POST', '/subscriptions/:id/addons', 'an add-on can be sold onto a subscription (FR-SUB-009)'],
  ['POST', '/subscriptions/:id/addons/:id/cancel', 'a purchased add-on can be cancelled (§11.3)'],
  ['POST', '/subscriptions/:id/overrides', 'a §33 override can be applied'],
  ['POST', '/subscriptions/:id/overrides/:id/revoke', 'a §33 override can be revoked'],
];

for (const [method, path, what] of UNREACHABLE) {
  check(`${what} — the UI calls ${method} ${path}`, callsEndpoint(method, path), true);
}

/*
 * The two authenticated file reads. Neither can be an `<a href>`: `readBearerToken` reads the
 * `Authorization` header only, so an unadorned navigation is a 401 and the reviewer gets a broken
 * image rather than the evidence they were told to check.
 */
const frontendSource = sourceFiles(FRONTEND)
  .map((file) => code(fs.readFileSync(file, 'utf8')))
  .join('\n');

check('the payment proof is fetched through the authenticated client',
  /api\.download\(\s*`\/payments\/\$\{[^}]+\}\/screenshot`/.test(frontendSource), true);
check('  and rendered, rather than reported as a word',
  /createObjectURL/.test(frontendSource), true);

check('a generated document can be downloaded as a PDF',
  /api\.download\(\s*`\/documents\/\$\{[^}]+\}`/.test(frontendSource)
    && /format:\s*'pdf'/.test(frontendSource), true);
check('a result card can be downloaded as a PDF',
  /api\.download\(\s*`\/exams\/results\/\$\{[^}]+\}`/.test(frontendSource), true);

/*
 * The shared pieces these nine were built on, asserted so the next screen reaches for them rather
 * than writing a tenth copy.
 */
check('row actions share one lifecycle hook',
  fs.existsSync(path.join(FRONTEND, 'lib', 'useRowAction.ts')), true);
check('  which keeps a 409 inside the overlay rather than behind it',
  /conflict/.test(code(fs.readFileSync(path.join(FRONTEND, 'lib', 'useRowAction.ts'), 'utf8'))), true);
check('  and takes the overlay\'s value through confirm, not through a stale closure',
  /confirm:\s*\(extra: E\)/.test(
    code(fs.readFileSync(path.join(FRONTEND, 'lib', 'useRowAction.ts'), 'utf8'))
  ), true);

check('the timetable pickers are shared by the create and edit screens',
  fs.existsSync(path.join(FRONTEND, 'lib', 'useTimetablePickers.ts')), true);
const timetableScreens = ['new', '[id]'].map((segment) =>
  code(fs.readFileSync(
    path.join(APP, '(school)', 'school', 'timetable', segment, 'page.tsx'), 'utf8'
  ))
);
check('  and both use it',
  timetableScreens.every((source) => /useTimetablePickers\(/.test(source)), true);

check('a 422 naming a field no form renders is promoted to the banner',
  fs.existsSync(path.join(FRONTEND, 'lib', 'formErrors.ts')), true);

/*
 * Deactivation records **when** somebody left. Both routes accept `left_at` and both would silently
 * drop it if the screen sent only the flag.
 */
for (const [screen, label] of [['staff', 'staff'], ['teachers', 'teachers']]) {
  const source = code(fs.readFileSync(
    path.join(APP, '(school)', 'school', screen, 'page.tsx'), 'utf8'
  ));
  check(`deactivating ${label} records a leaving date`,
    /is_active:\s*false,\s*left_at/.test(source), true);
  check(`  and reactivating ${label} clears it`,
    /is_active:\s*true,\s*left_at:\s*null/.test(source), true);
}

/* ──────────────────── the plan cluster's own rules ──────────────────── */

/*
 * Three of the four plan sub-resources are **whole-set** replacements, and each has a rule that a
 * screen can satisfy the path-and-method check above while getting badly wrong. These are the three.
 */
{
  const PLANS = path.join(APP, '(platform)', 'super-admin', 'plans');
  const limits = code(fs.readFileSync(path.join(PLANS, 'limits', 'page.tsx'), 'utf8'));
  const modules = code(fs.readFileSync(path.join(PLANS, 'modules', 'page.tsx'), 'utf8'));
  const pricing = code(fs.readFileSync(path.join(PLANS, '[id]', 'pricing.tsx'), 'utf8'));
  const detail = code(fs.readFileSync(path.join(PLANS, '[id]', 'page.tsx'), 'utf8'));

  /*
   * An unlimited limit carries a **null** `limit_value`, and the validator refuses a number beside
   * it (`otherwise: Joi.valid(null)`). Sending the box's leftover text would be a 422 on a field the
   * screen had already hidden.
   */
  check('an unlimited plan limit is sent with a null allowance',
    /limit_value:\s*fixed\s*\?.*:\s*null,/.test(limits), true);

  /*
   * `usageService` treats a null overage rate as free, so `allow_overage` without a rate would give
   * away unlimited free excess. The validator requires the rate; the screen must not send a blank
   * string in its place, which would be reported as "must be a number" instead of "is required".
   */
  check('  and a blank overage rate is sent as absent rather than as an empty string',
    /draft\.overage\.trim\(\) === ''\s*\n?\s*\?\s*undefined/.test(limits), true);

  /*
   * The modules editor must not flatten "never configured" into "turned off": it sends the modules
   * that are ticked plus the ones that already had a row, not all twenty. See the screen's header.
   */
  check('the modules editor sends the modules with a decision, not all twenty',
    /enabled\[entry\.key\]\s*\|\|\s*stored\.has\(entry\.key\)/.test(modules), true);

  /*
   * `plan_modules.settings` is stored for the Plan Builder and read by nothing — which is exactly
   * why a whole-set PUT that dropped it would lose it silently.
   */
  check('  and carries each module\'s stored settings through the replacement',
    /settings:\s*row\.settings/.test(modules), true);

  /*
   * §10.4: Fixed bills `base_amount`, the unit models bill `unit_amount`, Custom bills
   * `custom_amount`. A row must not send an amount its own model does not price — none of those
   * three columns allows null, so a null would be a 422 on a box the operator never saw.
   */
  check('a price sends only the amount its pricing model bills',
    /pricing_model === 'fixed'\)\s*item\.base_amount/.test(pricing)
      && /if \(unitModel\) \{\s*\n\s*item\.unit_amount/.test(pricing)
      && /pricing_model === 'custom'\)\s*\{\s*\n\s*item\.custom_amount/.test(pricing), true);

  /*
   * Status is FR-SUB-004's and FR-SUB-005's, each with its own endpoint and its own audit reason —
   * and `plans.validation.js` `update` does not accept it. A status control on the edit form would
   * be a field the API silently strips.
   */
  check('the plan edit form does not offer a status control',
    !/id="status"/.test(detail) && !/status:\s*values\./.test(detail), true);

  /*
   * Four separate permission keys, not one. An operator may hold pricing without modules, and
   * gating all four editors on `plans.manage` would hide screens from people entitled to them.
   */
  for (const [key, file, source] of [
    ['plans.pricing.manage', 'the pricing editor', detail],
    ['plans.modules.manage', 'the modules editor', modules],
    ['plans.limits.manage', 'the limits editor', limits],
  ]) {
    check(`${file} is gated on ${key}`, new RegExp(`can\\('${key}'\\)`).test(source), true);
  }
}

console.log(failures === 0 ? 'All frontend contract checks passed.' : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
