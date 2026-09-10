'use strict';

/**
 * SRS §24 — injection and cross-site protection, over HTTP. Checklist rows 6.3 and 6.4, FR-SEC-003.
 *
 * ## Why this suite exists when both rows were already "In Progress"
 *
 * The coverage that existed was real but lopsided, and the checklist said so precisely:
 *
 *   - **6.3** — `sortBy` is allow-listed per call site and `verify-platform-modules.js` probes that
 *     over a real endpoint, so a SQL-shaped *column name* is refused. **No probe sent a payload at a
 *     value parameter.** The defence there is Sequelize's parameterisation, and it was untested.
 *   - **6.4** — prototype-pollution keys are dropped and the drop is recorded, but **no script
 *     payload was ever sent over HTTP**.
 *
 * Both gaps are about the same thing: the guards were tested, the *data path* was not.
 *
 * ## What "protected" means here — and I got this wrong first
 *
 * The first version of this suite asserted that a script payload comes back **verbatim**, on the
 * strength of a checklist note saying "input is not HTML-escaped". That note is accurate and it is
 * about *escaping*: `sanitize.js` does not turn `&` into `&amp;`, because that corrupts "Smith &
 * Sons" in the database and mangles a physics question containing "5 < 7", and the corruption
 * compounds on every read-modify-write.
 *
 * But `sanitize.js` does something else that I had not read, and it is stronger. It **removes
 * actively executable markup** from string values — script/iframe/object/embed/style/link/base/
 * meta/form/svg/math elements, `on*=` event handlers, and `javascript:` / `vbscript:` URIs — looping
 * up to four times so that `<scr<script>ipt>` cannot reassemble into a live tag after one pass.
 *
 * The suite failed on its own wrong premise: posting `<script>alert(1)</script>` as a name returned
 * 422 `string.empty`, because the payload sanitised to nothing and the field's `min(2)` then refused
 * it. So the assertions below are the ones the code actually earns:
 *
 *   1. executable markup is **stripped**, and nothing tag-shaped survives a round trip;
 *   2. ordinary text containing `&` and `<` is left **exactly alone** — the assertion that catches an
 *      over-eager sanitiser, which would be a data-corruption bug wearing a security badge;
 *   3. a SQL payload in a *value* is stored and returned verbatim, proving it was bound rather than
 *      interpolated — `'` is a character, not a quote;
 *   4. the response is `application/json` with `nosniff`, so nothing that did survive can be parsed
 *      as a document.
 *
 * Escaping still belongs at render time, and the frontend does it: React escapes interpolated text by
 * construction, nothing in `frontend/src` calls `dangerouslySetInnerHTML`, and the one screen that
 * builds an href from API data guards it with an `^https?://` allow-list. All three are asserted
 * here rather than assumed, because they are the half of §24's defence this repository owns.
 */

const path = require('path');
const fs = require('fs');

const config = require('../src/config/env');
const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');
const { ROLES, USER_STATUS } = require('../src/config/constants');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-security.local';
const PASSWORD = 'Verify@Security123';
const REQUEST_TAG = 'vfy-security';
let requestSeq = 0;

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

const created = { users: [], organizations: [] };

/**
 * The payloads.
 *
 * Chosen so that a failure is unambiguous rather than merely alarming: each one, if it reached the
 * SQL parser or an HTML renderer, produces a *different* observable outcome from the one asserted.
 */
const SQL_PAYLOADS = [
  "' OR '1'='1",
  "'; DROP TABLE users; --",
  "1' UNION SELECT null, version() --",
  "\\'; SELECT SLEEP(5) --",
  "admin'--",
  '") OR ("a"="a',
];

const SCRIPT_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg/onload=alert(1)>',
  "javascript:alert(document.cookie)",
  '<iframe src="javascript:alert(1)">',
];

async function buildFixtures() {
  /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
  const residueCleared = await sweepResidue(db, { codes: ['VSEC-'], domains: ['verify-security.local'] });
  if (residueCleared) {
    console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
  }
  const roleRows = await db.Role.findAll({ where: { slug: ROLES.SUPER_ADMIN } });
  if (!roleRows.length) throw new Error('The super_admin role is missing — run the seeders first.');

  const password_hash = await hashPassword(PASSWORD);

  const platform = await db.User.create({
    role_id: roleRows[0].id,
    name: 'Verify Security Admin',
    email: `platform@${DOMAIN}`,
    username: 'vsec_platform',
    password_hash,
    status: USER_STATUS.ACTIVE,
    must_change_password: false,
  });
  created.users.push(platform.id);

  return { platform };
}

/**
 * Id-based teardown **plus a prefix sweep**, the pattern `verify-billing.js` records for this hazard.
 *
 * The id list alone is not enough, and this suite proved it. One assertion expects a 422 — a name
 * that is nothing but markup sanitises to empty and the field's `min(2)` refuses it — so that branch
 * captures no id, because normally no row is created. During a **deliberate regression** that
 * disabled the sanitiser, the request succeeded instead, created an organization named
 * `<script>alert(1)</script>`, and left it behind.
 *
 * It then broke `verify-platform-modules.js`, four assertions deep, in a suite this one never
 * touches — because that suite counts organizations globally and pages through them. The failure
 * surfaced two runs later with no obvious connection to its cause.
 *
 * A sweep by code prefix cannot miss a row for want of an id, and costs one query.
 */
async function dropFixtures() {
  if (created.organizations.length) {
    await db.Organization.destroy({ where: { id: created.organizations }, force: true });
  }
  await db.Organization.destroy({
    where: { code: { [db.Sequelize.Op.like]: 'VSEC-%' } },
    force: true,
  });

  if (created.users.length) {
    await db.User.destroy({ where: { id: created.users }, force: true });
  }
  await db.User.destroy({ where: { email: { [db.Sequelize.Op.like]: `%@${DOMAIN}` } }, force: true });
}

async function main() {
  const fixtures = await buildFixtures();

  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  async function call(pathname, { method = 'GET', body, token } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Request-Id': `${REQUEST_TAG}-${String(++requestSeq).padStart(4, '0')}`,
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(base + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* left null; an assertion names it better than a throw would */
    }

    return { status: res.status, body: parsed, raw: text, headers: res.headers };
  }

  /*
   * **The leak check moved to the end of the run, and why it had to.**
   *
   * A previous run of this suite left one organization behind — created during a deliberate
   * regression that disabled the sanitiser, so a request expected to fail with 422 succeeded
   * instead and the branch had no id to tear down by. It then broke `verify-platform-modules.js`
   * four assertions deep, in a suite this one never touches, because that suite counts
   * organizations globally.
   *
   * The teardown sweeps by code prefix and cannot miss a row for want of an id, and this suite used
   * to assert that here, at the start of the *next* run. That punished the wrong run: a leak from a
   * buggy teardown and a leftover from a killed process look identical at this point, and only the
   * first is a defect. Measured — a run killed at 24 of 28 assertions made the next one fail with
   * nothing wrong in the code. `buildFixtures()` now clears what a dead run left, which would make a
   * check here vacuous, so the same count is asserted after `dropFixtures()` instead: it tests the
   * teardown of the run that actually executed, and a real leak fails in the run that caused it.
   */

  const login = await call('/auth/login', {
    method: 'POST',
    body: { identifier: `platform@${DOMAIN}`, password: PASSWORD },
  });
  const token = login.body && login.body.data ? login.body.data.accessToken : null;
  check('the security fixture can sign in', typeof token, 'string');

  try {
    /* ═══════════════ 6.3 — SQL injection at VALUE parameters ═══════════════ */

    console.log('');
    console.log('── 6.3 — injection payloads at value parameters ──');
    console.log('');

    /*
     * The gap this closes: `sortBy` was probed because it is interpolated as a *column name* and so
     * must be allow-listed. A value parameter is a different defence entirely — Sequelize binds it —
     * and no test had ever exercised it.
     */
    const searchResults = [];
    for (const payload of SQL_PAYLOADS) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(`/organizations?q=${encodeURIComponent(payload)}&limit=5`, { token });
      searchResults.push({ payload, status: res.status, rows: Array.isArray(res.body?.data) ? res.body.data.length : null });
    }

    check('every injection payload in `q` is answered normally, not with a 500',
      searchResults.filter((r) => r.status !== 200).map((r) => `${r.payload} -> ${r.status}`), []);

    /*
     * A 500 would mean the payload reached the parser. But a 200 alone is not proof of safety: a
     * successful injection would *also* be a 200, returning rows it should not. `' OR '1'='1` is the
     * canonical case — if it were interpolated the WHERE collapses to always-true and every row
     * comes back. Treated as data it matches nothing, because no organization is literally named
     * that.
     */
    const alwaysTrue = searchResults.find((r) => r.payload === "' OR '1'='1");
    check('  and `\' OR \'1\'=\'1` matches nothing rather than everything',
      alwaysTrue.rows, 0);

    /* The table is still there. A dropped table would fail every later assertion, but say it plainly. */
    const usersStillThere = await db.User.count();
    check('the users table survived the DROP TABLE payload', usersStillThere > 0, true);
    const orgTableStillThere = await db.Organization.count();
    check('  as did organizations', typeof orgTableStillThere, 'number');

    /*
     * Payloads at a **path** parameter, which is the other place a value reaches the query. The id
     * schema is numeric, so these are refused by validation before Sequelize ever sees them — a 422
     * or 404 is the right answer and a 500 is not.
     */
    const pathResults = [];
    for (const payload of SQL_PAYLOADS.slice(0, 3)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(`/organizations/${encodeURIComponent(payload)}`, { token });
      pathResults.push({ payload, status: res.status });
    }
    check('an injection payload in a path id is refused, never executed',
      pathResults.filter((r) => ![400, 404, 422].includes(r.status)).map((r) => `${r.payload} -> ${r.status}`), []);

    /*
     * And in a request **body**, which is the largest surface of all: a create call writes what it is
     * given. The payload must be stored as characters and come back identical.
     */
    const createRes = await call('/organizations', {
      method: 'POST',
      token,
      body: { name: `Sec ${SQL_PAYLOADS[0]}`, code: 'VSEC-SQL', email: `sql@${DOMAIN}` },
    });
    const createdOrg = createRes.body?.data?.organization ?? createRes.body?.data;
    if (createdOrg?.id) created.organizations.push(createdOrg.id);

    check('a value containing SQL syntax is accepted as data', createRes.status, 201);
    check('  and stored verbatim, character for character',
      createdOrg?.name, `Sec ${SQL_PAYLOADS[0]}`);

    /*
     * Read back through a *fresh* query rather than trusting the create response, which could have
     * echoed the input without ever writing it.
     */
    const readBack = await call(`/organizations/${createdOrg.id}`, { token });
    const fetched = readBack.body?.data?.organization ?? readBack.body?.data;
    check('  and survives a round trip through the database unchanged',
      fetched?.name, `Sec ${SQL_PAYLOADS[0]}`);

    /* ═══════════════ 6.4 — script payloads over HTTP ═══════════════ */

    console.log('');
    console.log('── 6.4 — script payloads, and why they come back unescaped ──');
    console.log('');

    /*
     * **My first version of this section asserted the opposite and was wrong.** It expected a script
     * payload to be stored verbatim, on the strength of a checklist note saying input is not
     * HTML-escaped. That note is true and is about *escaping*: `sanitize.js` does not turn `&` into
     * `&amp;`, because that corrupts "Smith & Sons" and mangles a physics question containing
     * "5 < 7".
     *
     * What it does instead is narrower and stronger: it **removes actively executable markup** —
     * script/iframe/object/embed/style/link/base/meta/form/svg/math elements, `on*=` handlers, and
     * `javascript:` / `vbscript:` URIs — and leaves ordinary text alone. Both halves are asserted
     * below, because a sanitiser that strips too much is a data-corruption bug wearing a security
     * badge.
     */
    const stripped = await call('/organizations', {
      method: 'POST',
      token,
      body: { name: `Sec ${SCRIPT_PAYLOADS[0]} Ltd`, code: 'VSEC-XSS', email: `xss@${DOMAIN}` },
    });
    const xssOrg = stripped.body?.data?.organization ?? stripped.body?.data;
    if (xssOrg?.id) created.organizations.push(xssOrg.id);

    check('a name wrapped around a script payload is accepted', stripped.status, 201);
    check('  with the executable markup removed, not escaped and not stored',
      xssOrg?.name, 'Sec  Ltd');
    check('  so nothing resembling a tag survives the round trip',
      /<\s*script/i.test(xssOrg?.name ?? ''), false);

    /*
     * A payload that is *only* markup sanitises to the empty string, and the field's own
     * `min(2)` then refuses it. Two independent layers, and the 422 is the correct outcome — worth
     * asserting because it is the behaviour that made the first version of this test fail.
     */
    const emptied = await call('/organizations', {
      method: 'POST',
      token,
      body: { name: SCRIPT_PAYLOADS[0], code: 'VSEC-XSS2', email: `xss2@${DOMAIN}` },
    });
    check('a name that is nothing but markup sanitises to empty and is then refused',
      emptied.status, 422);
    check('  by the field rule rather than by a security-shaped error',
      emptied.body?.error?.details?.[0]?.type, 'string.empty');

    /*
     * The other half: ordinary text that *looks* dangerous must survive. This is the assertion that
     * catches an over-eager sanitiser, and it is the reason escaping was rejected in the first place.
     */
    const ampersand = await call('/organizations', {
      method: 'POST',
      token,
      body: { name: 'Smith & Sons 5 < 7 Ltd', code: 'VSEC-AMP', email: `amp@${DOMAIN}` },
    });
    const ampOrg = ampersand.body?.data?.organization ?? ampersand.body?.data;
    if (ampOrg?.id) created.organizations.push(ampOrg.id);
    check('an ampersand and a less-than in real text are left exactly alone',
      ampOrg?.name, 'Smith & Sons 5 < 7 Ltd');

    /*
     * Nesting, with a payload chosen by measurement rather than by looking plausible.
     *
     * The obvious `<scr<script>ipt>` does NOT test the loop: one pass leaves `<scr`, which is inert,
     * so the assertion passed with the loop cut to a single pass and proved nothing. Reducing the
     * bound is exactly the regression this exists to catch.
     *
     * `<scri<script>pt>…</scri<script>pt>` does test it: after one pass it reassembles into a live
     * `<script>alert(1)</script>`, and only the second pass removes it. That is why `cleanString`
     * loops, and why the bound is four rather than one.
     */
    const nested = await call('/organizations', {
      method: 'POST',
      token,
      body: { name: 'Sec <scri<script>pt>alert(1)</scri<script>pt> Ltd', code: 'VSEC-NEST', email: `nest@${DOMAIN}` },
    });
    const nestedOrg = nested.body?.data?.organization ?? nested.body?.data;
    if (nestedOrg?.id) created.organizations.push(nestedOrg.id);
    check('a nested tag does not reassemble into a live one after stripping',
      /<\s*script/i.test(nestedOrg?.name ?? ''), false);

    /*
     * `javascript:` in a URL field. The organizations screen renders `website` as an href, so this is
     * the one payload with a rendering path already built for it.
     */
    const jsUri = await call('/organizations', {
      method: 'POST',
      token,
      body: {
        name: 'Sec JS URI',
        code: 'VSEC-URI',
        email: `uri@${DOMAIN}`,
        website: 'javascript:alert(document.cookie)',
      },
    });
    check('a javascript: URI in a website field never survives as one',
      /javascript\s*:/i.test(JSON.stringify(jsUri.body ?? {})), false);
    if ((jsUri.body?.data?.organization ?? jsUri.body?.data)?.id) {
      created.organizations.push((jsUri.body.data.organization ?? jsUri.body.data).id);
    }

    const listWithScript = await call(`/organizations?q=${encodeURIComponent('<script>')}&limit=5`, { token });
    check('a script payload in a query parameter is answered normally',
      listWithScript.status, 200);

    /*
     * The headers are the last line, and they are what makes any payload that *did* survive inert.
     * `application/json` means a browser parses the response as data; `nosniff` stops it from
     * second-guessing that and sniffing HTML out of a body that happens to begin with a tag.
     */
    check('every response is JSON, so a payload is never parsed as a document',
      (stripped.headers.get('content-type') || '').split(';')[0], 'application/json');
    check('  with nosniff, so the browser cannot decide otherwise',
      stripped.headers.get('x-content-type-options'), 'nosniff');

    check('and the framing and referrer headers arrive with it',
      [
        stripped.headers.get('x-frame-options') !== null,
        stripped.headers.get('referrer-policy') !== null,
      ], [true, true]);

    /*
     * Prototype pollution, over HTTP rather than through the middleware directly. `__proto__` in a
     * JSON body is the one input that can change the behaviour of code that never reads it.
     */
    const pollute = await call('/organizations', {
      method: 'POST',
      token,
      body: { name: 'Sec Proto', code: 'VSEC-PROTO', email: `proto@${DOMAIN}`, __proto__: { polluted: true } },
    });
    const polluted = pollute.body?.data?.organization ?? pollute.body?.data;
    if (polluted?.id) created.organizations.push(polluted.id);

    check('Object.prototype is intact after a __proto__ payload',
      ({}).polluted, undefined);
    check('  and the request itself was not rejected, because the key is dropped rather than refused',
      [201, 422].includes(pollute.status), true);

    /* ═══════════════ the half this repository owns: render time ═══════════════ */

    console.log('');
    console.log('── escaping belongs at render time, and the frontend does it ──');
    console.log('');

    /*
     * The API returning a payload verbatim is only safe if whatever renders it escapes. React does,
     * by construction, for every interpolated value — the single exception being
     * `dangerouslySetInnerHTML`, which is named that way for this reason.
     *
     * Asserted rather than assumed, because it is the other half of §24's cross-site defence and it
     * lives in this repository. One call anywhere in the frontend would undo the argument above.
     */
    const frontendSrc = path.resolve(__dirname, '..', '..', 'frontend', 'src');
    const sourceFiles = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) sourceFiles.push(full);
      }
    };
    walk(frontendSrc);

    check('the frontend source tree is where this expects it', sourceFiles.length > 0, true);

    /*
     * Comments stripped before the search, on this project's own established doctrine: a file that
     * NAMES the hazard in prose is not a file that uses it, and `verify-frontend.js` records why the
     * distinction matters — "the right fix is always to narrow the search, never to delete the
     * sentence: naming a hazard in prose is exactly what should be encouraged."
     *
     * It became load-bearing when the root layout grew a comment explaining that its theme script is
     * a static file SPECIFICALLY so this assertion stays true. A raw-text search failed on the
     * sentence documenting its own compliance, which would have taught the next reader to delete the
     * explanation rather than keep it.
     */
    const withoutComments = (text) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ');

    const unsafe = sourceFiles.filter((file) =>
      /dangerouslySetInnerHTML/.test(withoutComments(fs.readFileSync(file, 'utf8')))
    );
    check('no frontend file uses dangerouslySetInnerHTML',
      unsafe.map((file) => path.relative(frontendSrc, file)), []);

    /*
     * `javascript:` in an href is the other way a payload executes without any HTML being injected —
     * and `sanitize.js` already strips that scheme on the way in, proved above. This asserts the
     * second layer: that a screen building an href out of API data checks the scheme itself.
     *
     * **The first version banned the pattern outright and was wrong.** It flagged the organizations
     * screen, which renders `website` as a link — correctly, behind an `isLinkable` guard requiring
     * `^https?://`, with everything else shown as dimmed text and a comment explaining why the check
     * is repeated in the browser. A blanket ban would have forced that screen to render every URL as
     * unclickable text, making the code worse to satisfy a rule that had mistaken a guard for a
     * defect.
     *
     * So the rule is the one that matters: an href built from a value must not be the *only* thing
     * the file does with it. A scheme check has to be present.
     */
    const hrefFromData = sourceFiles.filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      /*
       * ## This test was passing vacuously, and had been since it was written
       *
       * The pattern read `[^}]*\brow\.` — except the `\b` was a literal **backspace character**
       * (0x08), not a word boundary. A backspace never appears in source, so `.test()` was always
       * false, `if (!false) return false` rejected **every** file, and the check compared `[]` with
       * `[]` and reported PASS whatever any screen did. A security assertion that cannot fail is
       * worse than no assertion, because the suite says it is covered.
       *
       * Found by sweeping the tree for stray control characters after the same mistake — a non-raw
       * Python string turning `\b` into a backspace on the way to disk — was caught in a frontend
       * regex. This is why that sweep was worth running over files nobody had touched that day.
       *
       * ## And once it worked, it needed narrowing
       *
       * With the boundary restored it flagged `super-admin/settings/page.tsx`, which maps over a
       * module-level `const CONFIGURATION` of six hardcoded internal paths — `row` there is a
       * `.map()` variable, not API data. The rule is about values that came over the wire, so the
       * discriminator is whether the file ever reaches the wire: that screen imports exactly `Link`
       * and `PageHeader` and makes no request at all.
       */
      if (!/\bapi\.|useCollection|requestPage|\bfetch\(/.test(text)) return false;
      if (!/href=\{(?!`?\/)[^}]*\brow\./.test(text)) return false;
      /* A scheme guard anywhere in the file that renders the link. */
      /*
       * A plain substring, not a regex. The thing being looked for *is* a regex in the source
       * (`/^https?:\/\//i`), and matching one regex with another means escaping backslashes twice —
       * which is how the first attempt at this line produced "Invalid regular expression flags".
       */
      /*
       * `.test(` matters. The organizations screen contains `^https?:\/\//i` twice — once as the
       * guard and once in a `.replace()` that strips the scheme for display — so a bare
       * `includes('https?:')` stayed true when the guard itself was replaced by a denylist, and the
       * regression went unnoticed. Only the boolean test counts as a guard.
       */
      const schemeAllowlist = /\^https\?:[^)]*\.test\(/.test(text);

      /*
       * ## The second shape of guard, added when a screen used the stronger one
       *
       * The notification centre renders `action_url` — free text on the model, written by §23's
       * engine — and guards it with `startsWith('/')`, which admits **only** internal paths. That is
       * strictly stronger than a scheme allowlist: `https://elsewhere.test` passes `^https?:` and
       * fails this. Requiring the weaker guard would have forced that screen to widen what it
       * accepts in order to satisfy a rule about not accepting too much.
       *
       * So either counts, and the rule's subject is unchanged: a screen may not turn a value that
       * came over the wire into a link without deciding what it will accept.
       */
      const internalOnly = /startsWith\(\s*'\//.test(text);

      return !schemeAllowlist && !internalOnly;
    });
    check('a screen linking to API data checks the scheme before it does',
      hrefFromData.map((file) => path.relative(frontendSrc, file)), []);

    /*
     * And the guard is asserted to be the strict one. `startsWith('http')` would pass a
     * `httpx:` scheme, and a check for the absence of `javascript:` alone would miss `vbscript:` and
     * `data:text/html`. An allow-list of two schemes is the only form that is safe by construction.
     */
    /*
     * The organizations **list** screen specifically, matched on the path that ends
     * `organizations/page.tsx` rather than on any file whose path merely *contains* "organizations".
     *
     * The loose form was `f.includes('organizations') && f.endsWith('page.tsx')`, which was unique
     * only for as long as one such file existed. Adding `organizations/new/page.tsx` broke it: `find`
     * returned whichever came first in the walk, the create screen has a `type="url"` input rather
     * than a scheme guard, and this assertion went red against code that had not changed. A substring
     * standing in for an identity, which is the same mistake this project has now made in a suite, in
     * a document tool and in a regression fixture.
     */
    const ORG_LIST = `organizations${path.sep}page.tsx`;
    const orgScreen = sourceFiles.find((f) => f.endsWith(ORG_LIST));
    check('  and that check is an allow-list of http and https, not a denylist',
      orgScreen ? /\^https\?:[^)]*\.test\(/.test(fs.readFileSync(orgScreen, 'utf8')) : false, true);

  } finally {
    await new Promise((resolve) => server.close(resolve));
    await dropFixtures();
    /* The leak check, where it tests this run's own teardown — see the note where it used to sit. */
    const left = await db.Organization.count({
      where: { code: { [db.Sequelize.Op.like]: 'VSEC-%' } },
      paranoid: false,
    });
    check('this run leaves no organization behind for the next one', left, 0);
  }
}

main()
  .catch(async (err) => {
    failures += 1;
    console.error('\nverify-security crashed:', err);
    try {
      await dropFixtures();
    } catch (cleanupError) {
      console.error('teardown also failed:', cleanupError.message);
    }
  })
  .finally(async () => {
    console.log('');
    console.log(failures === 0 ? 'All security checks passed.' : `${failures} check(s) FAILED.`);
    await db.sequelize.close();
    process.exit(failures === 0 ? 0 : 1);
  });
