'use strict';

/*
 * Environment overrides, set before anything reads the configuration.
 *   RATE_LIMIT_MAX / AUTH_RATE_LIMIT_MAX  the limiters are not under test here.
 *   AI_RATE_LIMIT_MAX                     aiLimiter is real on three of these routes; a 60/window
 *                                         default would refuse this suite's own traffic.
 *   AI_DRIVER=mock                        pinned, so no request leaves the process and every generated
 *                                         string is predictable. See the header.
 *   BCRYPT_ROUNDS=10, PASSWORD_MIN_LENGTH pinned so neither comes from the local .env.
 *   MAIL_DRIVER=log                       no mail is sent; a stray SMTP attempt would hang the run.
 *   CACHE_TTL=600                         so no entitlement assertion can pass by TTL expiry.
 */
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.AI_RATE_LIMIT_MAX = '100000';
process.env.AI_DRIVER = 'mock';
process.env.BCRYPT_ROUNDS = '10';
process.env.PASSWORD_MIN_LENGTH = '8';
process.env.MAIL_DRIVER = 'log';
process.env.CACHE_TTL = '600';

/**
 * Verification of Phase 3.T — the AI module — `src/ai/*` and `src/modules/ai/*` — SRS §21,
 * FR-AI-001 and FR-AI-002.
 *
 * ## Two things here have never been exercised anywhere in this project
 *
 * **`usageService.recordUsage` had zero call sites in `src/`.** Every limit until now was either a
 * headcount counted live from its source table or a per-request ceiling; `ai_limit` is the first
 * *cumulative* limit a module actually increments. So this suite asserts the counter as a number that
 * moves — before, after a generation, after a second — and, more importantly, asserts the two cases
 * where it must **not** move: a request the limit blocked, and a generation the provider failed.
 *
 * **`question_banks` and `questions` had never been read or written.** Both models were registered and
 * associated since the schema was written and were dead code until now.
 *
 * ## Why AI_DRIVER=mock is pinned, and what that does and does not prove
 *
 * The mock never opens the uploaded file and contains no randomness or clock, so the whole nine-step
 * workflow runs offline and every string it produces is predictable — which lets this suite assert
 * exact values rather than shapes. What it does **not** prove is the Anthropic adapter: that has never
 * been executed, and checklist row 5.2 owns it. What *is* proved about the seam is that an unknown
 * driver name is refused and that an adapter missing a contract method is refused.
 *
 * ## The stage machine is asserted for what it REFUSES
 *
 * §21's nine steps are an order, and `workflow_stage` is the server's record of it. A machine that only
 * accepted the happy path would pass every ordinary assertion while letting a caller jump from
 * `uploaded` straight to `approve` and put unreviewed questions in the Question Bank. So every
 * transition is tried out of order as well as in it.
 *
 * Part 1 — request schemas and the driver seam (no database).
 * Part 2 — the declared route table, the guards and the meter.
 * Part 3 — over real HTTP against the real database, including a real upload.
 *
 * Run: node scripts/verify-ai.js
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/models');
const { sweepResidue } = require('./lib/residue');
const config = require('../src/config/env');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/tokens');

const aiRoutes = require('../src/modules/ai/ai.routes');
const { schemas } = require('../src/modules/ai/ai.validation');
const service = require('../src/modules/ai/ai.service');
const aiDriver = require('../src/ai');
const mockDriver = require('../src/ai/mock');

const {
  ROLES,
  USER_STATUS,
  MODULES,
  MODULE_LIST,
  LIMITS,
  LIMIT_TYPES,
  PLAN_STATUS,
  SUBSCRIPTION_STATES,
  BILLING_CYCLES,
  ACADEMIC_SESSION_STATUS,
  AI_SOURCE_TYPES,
  AI_WORKFLOW_STAGES,
  QUESTION_DIFFICULTY,
  QUESTION_STATUS,
  QUESTION_SOURCES,
  QUESTION_TYPES,
  UPLOAD_PROFILES,
  UPLOAD_RULES,
  UPLOAD_EXTENSION_MIME,
} = require('../src/config/constants');
const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = require('../src/config/permissions');

const { settle, settleDistinct } = require('./lib/settle');

const PREFIX = config.app.apiPrefix;
const DOMAIN = 'verify-ai.local';
const PASSWORD = 'Verify@Ai12345';
const CODE_PREFIX = 'VAI-';

let failures = 0;
let dbSkipped = false;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${
      ok ? '' : `  (expected ${JSON.stringify(expected)})`
    }`
  );
}

const VALIDATE_OPTIONS = { abortEarly: false, convert: true, stripUnknown: true };

function run(schema, value) {
  const { error, value: cleaned } = schema.validate(value, VALIDATE_OPTIONS);
  return { ok: !error, value: cleaned, keys: error ? error.details.map((d) => d.path.join('.')) : [] };
}

/** Source with comments stripped, so a probe cannot match explanatory prose — §5a session 18. */
function stripped(relative) {
  return fs
    .readFileSync(path.join(__dirname, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function routesOf(router) {
  return router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
}

function handlerNames(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  return layer ? layer.route.stack.map((s) => s.handle.name) : [];
}

const BANK = { name: 'Term 1 syllabus', source_type: AI_SOURCE_TYPES.SYLLABUS };


/* ═══════════ part 1c — the Anthropic adapter, Phase 5.2, without a live call ═══════════ */

/**
 * `src/ai/anthropic.js` has been written since §21 and **never executed** — its own header says so
 * first, and the checklist has carried it as Phase 5.2 ever since.
 *
 * It cannot be *completed* here: proving it works means a real request to a real key, which this
 * environment has neither of and should not have. But "written and never run" and "verified against
 * its contract" are different states, and everything except the network hop can be exercised.
 *
 * The SDK is replaced in `require.cache` before the adapter's lazily-built client exists, so the
 * **real** prompt construction, reply extraction and JSON parsing all run — only the HTTP call is
 * substituted. What stays untested is exactly one thing: that Anthropic's API answers the way the
 * stub does. That is stated rather than papered over, and the adapter's header still says it has
 * never been executed against the live service, because it has not.
 */
async function verifyAnthropicAdapter() {
  console.log('');
  console.log('── Part 1c — the Anthropic adapter (Phase 5.2), stubbed at the SDK ──');
  console.log('');

  const adapter = require('../src/ai/anthropic');

  check('the adapter satisfies the driver contract and adds nothing to it',
    Object.keys(adapter).sort(), ['analyze', 'extract', 'generate']);

  /*
   * The no-key refusal, asserted FIRST — the client is built once and cached in a module-local, so
   * after any successful call this branch is unreachable for the rest of the process.
   */
  const savedKey = config.ai.apiKey;
  config.ai.apiKey = '';
  let noKey = null;
  try { await adapter.analyze({ text: 'x' }); } catch (err) { noKey = err.message; }
  check('without a key it refuses, naming the setting rather than failing at the network',
    /ANTHROPIC_API_KEY is not set/.test(noKey || ''), true);

  /* ── the SDK, replaced before the adapter ever builds a client ── */

  const sdkPath = require.resolve('@anthropic-ai/sdk');
  const realSdk = require.cache[sdkPath];
  const sent = [];
  let reply = '';

  class StubAnthropic {
    constructor(options) { this.options = options; }

    get messages() {
      return {
        create: async (request) => {
          sent.push(request);
          return { content: [{ type: 'text', text: reply }] };
        },
      };
    }
  }
  require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: StubAnthropic };
  config.ai.apiKey = 'sk-test-not-a-real-key';

  /*
   * Read defensively. A regression that breaks the reply parsing makes these calls REJECT, and an
   * unguarded `await` would abort the suite with a crash rather than the named failure that says
   * which guard went — §5a: a crash is a detection, but a poor one. Two deliberate regressions
   * (dropping the JSON span extraction, and emptying `textOf`) did exactly that before this.
   */
  const attempt = async (fn) => {
    try { return await fn(); } catch (err) { return { threw: err.message }; }
  };

  try {
    /* ── analyze ── */

    reply = '{"topics":[{"name":"Photosynthesis","weight":0.6},{"name":"Respiration","weight":0.4}]}';
    const analyzed = await attempt(() => adapter.analyze({ text: 'Leaves convert light into sugar.' }));
    check('analyze returns the topics the model named',
      (analyzed.topics || []).map((t) => t.name), ['Photosynthesis', 'Respiration']);
    check('  and asked the configured model, not a hard-coded one',
      sent.length ? sent[0].model : null, config.ai.model);
    check('  sending the material in the prompt', /Leaves convert light into sugar/.test(sent[0].messages[0].content), true);
    check('  and asking for JSON only, since the reply is parsed',
      /Reply with JSON only/.test(sent[0].messages[0].content), true);

    /*
     * A model that wraps its JSON in prose or a fence is the normal case, not the exceptional one.
     * The adapter takes the outermost brace-delimited span, and this is what proves it.
     */
    reply = 'Certainly! Here are the topics:\n```json\n{"topics":[{"name":"Osmosis","weight":1}]}\n```\nHope that helps.';
    const fenced = await attempt(() => adapter.analyze({ text: 'x' }));
    check('a reply wrapped in prose and a code fence still parses',
      (fenced.topics || []).map((t) => t.name), ['Osmosis']);

    reply = 'I am afraid I cannot help with that.';
    let noJson = null;
    try { await adapter.analyze({ text: 'x' }); } catch (err) { noJson = err.message; }
    check('a reply with no JSON at all is a failed generation, named as such',
      /did not return JSON for topic analysis/.test(noJson || ''), true);

    reply = '{"topics":[{"name":"Broken",}]}';
    let malformed = null;
    try { await adapter.analyze({ text: 'x' }); } catch (err) { malformed = err.message; }
    check('  and malformed JSON is distinguished from missing JSON',
      /malformed JSON for topic analysis/.test(malformed || ''), true);

    /* ── generate ── */

    reply = JSON.stringify({
      questions: [{
        question_text: 'What gas do plants absorb?',
        options: [{ key: 'A', text: 'CO2' }, { key: 'B', text: 'N2' },
          { key: 'C', text: 'He' }, { key: 'D', text: 'Ar' }],
        correct_option: 'A',
        answer_explanation: 'Photosynthesis consumes carbon dioxide.',
        topic: 'Photosynthesis',
      }],
    });
    const generated = await attempt(() => adapter.generate({
      text: 'Plants absorb carbon dioxide.', count: 1, difficulty: 'easy',
      subject: 'Biology', topic: 'Photosynthesis',
      topics: [{ name: 'Photosynthesis' }],
    }));
    check('generate returns the questions the model wrote', (generated.questions || []).length, 1);
    check('  stamped with the model that wrote them, so a bank records its provenance',
      generated.model, `anthropic:${config.ai.model}`);
    /*
     * The adapter fills `difficulty` from the request when the model omits it. §21 writes that column,
     * and a null there would be a question nobody asked for at a difficulty nobody chose.
     */
    check('  and the requested difficulty is applied when the model omits it',
      (generated.questions || [{}])[0].difficulty, 'easy');

    const prompt = sent.length ? sent[sent.length - 1].messages[0].content : '';
    check('the prompt carries every constraint §19 will enforce on the way in',
      ['1 multiple-choice questions', 'easy difficulty', 'Biology', 'Photosynthesis',
        'four options with keys A, B, C, D', 'exactly one correct_option']
        .filter((needle) => !prompt.includes(needle)), []);

    /*
     * The shape the module validates against is `mcqNeedsOptionsAndAnswer` in `models/exams.js` —
     * at least two options and a `correct_option` matching one of their keys. Asserted here because
     * the adapter's prompt is the only thing that makes a provider likely to satisfy it.
     */
    const q = (generated.questions || [{ options: [] }])[0];
    check('  and what comes back satisfies the model validator the module will apply',
      [q.options.length >= 2, q.options.some((o) => o.key === q.correct_option)], [true, true]);

    /* ── what is NOT covered, said plainly ── */

    /*
     * Five: four `analyze` (topics, fenced, no-JSON, malformed) and one `generate`. The no-key call
     * above is deliberately not among them — it throws before a client is ever built, which is the
     * point of asserting it first.
     */
    check('every call went to the stub — nothing left the process', sent.length, 5);
  } finally {
    if (realSdk) require.cache[sdkPath] = realSdk;
    else delete require.cache[sdkPath];
    config.ai.apiKey = savedKey;
  }
}

/* ═══════════════════ part 1 — schemas and the driver seam ═══════════════════ */

async function verifySchemas() {
  console.log('\n── Part 1 — request schemas and the driver seam ──\n');

  /* ── the upload ── */

  check('a bank needs a name and a source type', run(schemas.createBank, BANK).ok, true);
  check('a name is required', run(schemas.createBank, { source_type: AI_SOURCE_TYPES.PDF }).ok, false);
  check('a source type is required', run(schemas.createBank, { name: 'x' }).ok, false);
  check(
    'all three of §21\'s upload kinds are accepted, and nothing else',
    [
      ...Object.values(AI_SOURCE_TYPES).map((t) => run(schemas.createBank, { name: 'x', source_type: t }).ok),
      run(schemas.createBank, { name: 'x', source_type: 'video' }).ok,
    ],
    [true, true, true, false]
  );
  check('  and §21 names exactly three', Object.values(AI_SOURCE_TYPES).sort(), ['image', 'pdf', 'syllabus']);

  /*
   * The workflow's whole state is the system's. `workflow_stage` is the one that matters most: a body
   * that could set it could jump straight to `approved`, which is what the preview-and-approve half of
   * FR-AI-001 exists to prevent.
   */
  for (const owned of [
    'workflow_stage', 'source_path', 'source_filename', 'extracted_text', 'analyzed_topics',
    'generated_count', 'approved_count', 'is_ai_generated', 'ai_model', 'error_message',
    'requested_count', 'requested_difficulty', 'created_by', 'approved_by', 'approved_at',
    'organization_id', 'id',
  ]) {
    const sample = owned === 'is_ai_generated' ? true
      : owned === 'analyzed_topics' ? [{ name: 'x' }]
        : /_(count)$/.test(owned) || /_(id|by)$/.test(owned) ? 1 : 'x';
    const r = run(schemas.createBank, { ...BANK, [owned]: sample });
    check(`the upload refuses a caller-supplied ${owned}`, [r.ok, r.keys], [false, [owned]]);
  }

  /* ── the transitions ── */

  check('extract and analyze take nothing but the school and a reason', [
    run(schemas.stageOnly, {}).ok,
    run(schemas.stageOnly, { school_id: 1, reason: 'retry' }).ok,
    run(schemas.stageOnly, { workflow_stage: AI_WORKFLOW_STAGES.APPROVED }).ok,
  ], [true, true, false]);

  check('generation bounds the work of one request', [
    run(schemas.generate, {}).ok,
    run(schemas.generate, { count: 50 }).ok,
    run(schemas.generate, { count: 51 }).ok,
    run(schemas.generate, { count: 0 }).ok,
  ], [true, true, false, false]);
  check('  and takes a difficulty hint, which the column calls "requested for generation"',
    run(schemas.generate, { difficulty: QUESTION_DIFFICULTY.HARD }).ok, true);

  /*
   * `requested_difficulty` is `forbidden()` in every other schema and lifted out for this one. The
   * §20.3/§20.4 lesson: a shared forbidden() map spread last silently shadows the field a route exists
   * to write, and only a POSITIVE assertion per route can see it.
   */
  check('the difficulty step requires a difficulty', [
    run(schemas.setDifficulty, {}).ok,
    run(schemas.setDifficulty, { difficulty: QUESTION_DIFFICULTY.EASY }).ok,
  ], [false, true]);
  check('  and the shared owned map does not shadow the one field this route writes',
    run(schemas.setDifficulty, { difficulty: QUESTION_DIFFICULTY.EASY }).keys, []);
  check('  while every other schema still refuses it',
    run(schemas.generate, { requested_difficulty: QUESTION_DIFFICULTY.EASY }).ok, false);

  /* ── the review ── */

  check('a review must name at least one question', run(schemas.review, {}).ok, false);
  check('  approving alone is enough', run(schemas.review, { approve: [1, 2] }).ok, true);
  check('  rejecting alone is enough', run(schemas.review, { reject: [3] }).ok, true);
  check('a question cannot be both approved and rejected', run(schemas.review, { approve: [1], reject: [1] }).ok, false);
  check('and a repeated id is refused rather than counted twice', run(schemas.review, { approve: [1, 1] }).ok, false);

  /* ── the reads ── */

  check('the bank list filters by every workflow stage the enum holds',
    Object.values(AI_WORKFLOW_STAGES).every((s) => run(schemas.listBanks, { workflow_stage: s }).ok), true);
  check('  and refuses a stage that is not one', run(schemas.listBanks, { workflow_stage: 'done' }).ok, false);
  check('the long extracted text is opt-in, and off by default',
    [run(schemas.showQuery, {}).value.include_text, run(schemas.showQuery, { include_text: true }).value.include_text],
    [false, true]);

  /* ── the driver seam ── */

  console.log('');
  check('the suite runs against the mock driver, so nothing leaves the process', aiDriver.driverName(), 'mock');
  check('the seam declares the three system steps of FR-AI-001', aiDriver.DRIVER_METHODS, ['extract', 'analyze', 'generate']);
  check('  and offers exactly two drivers', Object.keys(aiDriver.DRIVERS).sort(), ['anthropic', 'mock']);

  /*
   * `env.js` validates that an API key exists when the driver is `anthropic`, but does NOT validate the
   * driver name against a known set — an unrecognised value boots silently. So the facade checks it at
   * first use, which is where `mailService.js` puts the same check for MAIL_DRIVER.
   */
  const original = config.ai.driver;
  config.ai.driver = 'gpt';
  let unknown = null;
  try { aiDriver.resolve(); } catch (err) { unknown = err.message; }
  config.ai.driver = original;
  check('an unknown AI_DRIVER is refused at first use, not silently at boot',
    Boolean(unknown && unknown.includes('Unknown AI_DRIVER "gpt"')), true);
  check('  naming the drivers that do exist', Boolean(unknown && unknown.includes('mock, anthropic')), true);

  /* The mock's two load-bearing properties, measured rather than asserted from its header. */
  /*
   * Guarded: a driver that reads the path throws ENOENT here, and an unguarded call would crash the
   * run instead of failing this assertion by name. §5a session 22's lesson — a crash is a detection,
   * but a bad one.
   */
  let extracted = null;
  let openedFile = null;
  try {
    extracted = await mockDriver.extract({ sourceType: 'pdf', filename: 'x.pdf', absolutePath: '/no/such/file' });
  } catch (err) {
    openedFile = err.message;
  }
  check('the mock never opens the uploaded file — it was handed a path that does not exist',
    [openedFile, Boolean(extracted && extracted.text.startsWith('Mock extraction of x.pdf'))],
    [null, true]);
  const g1 = await mockDriver.generate({ text: 'abc', topics: [{ name: 'T' }], count: 3, difficulty: 'easy' });
  /* eslint-disable-next-line no-unused-vars */
  const g2 = await mockDriver.generate({ text: 'abc', topics: [{ name: 'T' }], count: 3, difficulty: 'easy' });
  check('and it is deterministic — same input, same output', JSON.stringify(g1) === JSON.stringify(g2), true);
  check('  producing exactly the number of questions asked for', g1.questions.length, 3);
  check('  each satisfying the model\'s own MCQ rule (>=2 options, answer among the keys)',
    g1.questions.every((q) => q.options.length >= 2 && q.options.some((o) => o.key === q.correct_option)), true);
  check('  with the correct answer rotating, so an assertion cannot pass by it always being A',
    [...new Set(g1.questions.map((q) => q.correct_option))].length > 1, true);

  /*
   * Neither heavy dependency is loaded under the mock. Both are declared in package.json and installed;
   * requiring them at the top of a shared file would make an offline suite depend on a PDF parser.
   */
  check('the Anthropic SDK is not loaded when the driver is mock',
    Object.keys(require.cache).some((k) => k.includes(`${path.sep}@anthropic-ai${path.sep}`)), false);
  check('and neither is pdf-parse',
    Object.keys(require.cache).some((k) => k.includes(`${path.sep}pdf-parse${path.sep}`)), false);
}

/* ═══════════════════ part 2 — the router as declared ═══════════════════ */

function verifyRouting() {
  console.log('\n── Part 2 — the router as declared ──\n');

  check('the ten routes', routesOf(aiRoutes), [
    'GET /usage',
    'GET /banks',
    'POST /banks',
    'GET /banks/:id',
    'POST /banks/:id/extract',
    'POST /banks/:id/analyze',
    'POST /banks/:id/generate',
    'POST /banks/:id/difficulty',
    'GET /banks/:id/questions',
    'POST /banks/:id/approve',
  ]);
  check('no DELETE — §21 names none', routesOf(aiRoutes).some((r) => r.startsWith('DELETE')), false);
  check(
    'one router-level guard, mounted ahead of every route',
    [aiRoutes.stack.filter((l) => !l.route).length, aiRoutes.stack.findIndex((l) => !l.route)],
    [1, 0]
  );

  const src = stripped('../src/modules/ai/ai.routes.js');

  /* ── the meter: exactly one route, and it is the generation ── */

  check('exactly one route carries an entitlement limit', (src.match(/enforceLimit\(/g) || []).length, 1);
  check('  and it is the AI limit', /enforceLimit\(LIMITS\.AI_LIMIT\)/.test(src), true);
  check(
    '  mounted on the generation, because §21 counts requests and a 1000-request plan must buy 1000 sets',
    handlerNames(aiRoutes, 'post', '/banks/:id/generate').length
      > handlerNames(aiRoutes, 'post', '/banks/:id/analyze').length,
    true
  );
  const svc = stripped('../src/modules/ai/ai.service.js');
  /*
   * The whole generated set is checked before ANY of it is written. The model validator would refuse a
   * malformed row, but one at a time inside a bulk insert — a provider returning nine good questions
   * and one bad one would half-fill a bank. No behavioural assertion can see this while the mock is
   * always well-formed, so it is asserted at the source: §5a session 21's technique for a guard a
   * single-threaded suite cannot provoke.
   */
  /*
   * Presence AND order. A bare `indexOf(a) < indexOf(b)` is satisfied by DELETING `a` — indexOf then
   * returns -1, which is less than everything, so the probe goes greener as the code gets worse. §5a
   * session 22 recorded exactly this about a different probe; it was written the wrong way again here
   * and caught the same way, by a deliberate regression.
   */
  const wellFormedAt = svc.indexOf('assertWellFormed(produced');
  const transactionAt = svc.indexOf('db.sequelize.transaction(');
  check('the generated set is validated before anything is written',
    [wellFormedAt > -1, transactionAt > -1, wellFormedAt < transactionAt], [true, true, true]);
  check('  and the check is defined as well as called',
    (svc.match(/assertWellFormed\(/g) || []).length, 2);
  check('  refusing a question whose answer is not one of its own options',
    /correct_option does not match any option key/.test(svc), true);

  /*
   * The meter, at the source — rewritten for Known Issues #21's `ai_limit` half.
   *
   * These five assertions used to pin the opposite arrangement: exactly one `recordUsage()`, **after**
   * the transaction, "so a failed generation is never charged". That was correct about the refund and
   * wrong about the race — `enforceLimit` read the counter, the provider was called, and the increment
   * came last, so two requests at 999 of 1000 both passed and the school landed at 1001. The
   * allowance is now taken *before* the driver and given back on either failure path, so what has to be
   * pinned is the order and the refunds rather than the single late increment.
   *
   * Behavioural assertions on the counter live in part 3; these are here because a single-threaded
   * suite cannot see an ordering that only matters under concurrency — §5a session 21's technique.
   */
  check('the service reserves the allowance exactly once', (svc.match(/reserveUsage\(/g) || []).length, 1);
  check('  against the AI limit', /reserveUsage\(bank\.school_id, LIMITS\.AI_LIMIT, 1\)/.test(svc), true);
  check(
    '  awaited, so a refused reservation stops the request instead of being swallowed',
    /await usageService\.reserveUsage\(/.test(svc),
    true
  );
  /*
   * The whole point of the change, and the one assertion that would fail if it were reverted: the
   * reservation is ahead of the provider call. Presence is asserted with the order, because
   * `indexOf(a) < indexOf(b)` is satisfied by DELETING `a` — -1 is less than everything, so the probe
   * would go greener as the code got worse.
   */
  const reserveAt = svc.indexOf('usageService.reserveUsage(');
  const driverAt = svc.indexOf('aiDriver.generate(');
  check('  and BEFORE the provider is called, which is what closes the race',
    [reserveAt > -1, driverAt > -1, reserveAt < driverAt], [true, true, true]);
  check(
    '  with a refund on both paths that produce nothing — the provider failing, and the write failing',
    (svc.match(/await usageService\.releaseUsage\(bank\.school_id, LIMITS\.AI_LIMIT, 1\)/g) || []).length,
    2
  );
  /*
   * `recordUsage` must NOT also be called here. The increment happens at the reservation, so a second
   * call would charge the request twice — the mistake this shape invites, and invisible to any
   * assertion that only counts the total after one request.
   */
  check('  and the settled figure is read, never incremented a second time',
    (svc.match(/recordUsage\(/g) || []).length, 0);
  /*
   * Comments stripped. Without it this matched `invoices.service.js` and `subscriptions.service.js`,
   * which only MENTION the usage service in prose — §5a session 18's lesson, met again on the first run.
   */
  check('  which makes ai the only production caller of the reservation',
    fs.readdirSync(path.join(__dirname, '../src/modules'))
      .filter((m) => {
        const rel = `../src/modules/${m}/${m}.service.js`;
        return fs.existsSync(path.join(__dirname, rel)) && /reserveUsage\(/.test(stripped(rel));
      }),
    ['ai']);

  /* ── aiLimiter, which existed with no caller ── */

  /* Counted from the first `router.use(` onward: the barrel destructure names it a fourth time. */
  check('the three driver routes carry aiLimiter, and nothing else does',
    (src.slice(src.indexOf('router.use(')).match(/\n  aiLimiter,/g) || []).length, 3);
  check('  which no other router mounts',
    fs.readdirSync(path.join(__dirname, '../src/modules'))
      .filter((m) => {
        const f = `../src/modules/${m}/${m}.routes.js`;
        return fs.existsSync(path.join(__dirname, f)) && /aiLimiter/.test(stripped(f));
      }),
    ['ai']);

  /* ── the upload ── */

  check('the upload profile used is the one §21 reserved', UPLOAD_PROFILES.AI_SOURCE, 'ai_source');
  check('  whose rules table cites FR-AI-001 by name',
    UPLOAD_RULES[UPLOAD_PROFILES.AI_SOURCE].srs.includes('FR-AI-001'), true);
  check('  and the router names it rather than inventing a seventh',
    /UPLOAD_PROFILES\.AI_SOURCE/.test(src), true);
  check('  on the upload route and no other', (src.match(/uploadSingle\(/g) || []).length, 1);
  check(
    '  with the multer chain ahead of validate, so the multipart text fields are visible to it',
    (() => {
      const n = handlerNames(aiRoutes, 'post', '/banks');
      return n.indexOf('multerRunner') > -1 && n.indexOf('multerRunner') < n.indexOf('validateRequest');
    })(),
    true
  );

  /* ── the catalogue is fixed, so these are facts about it ── */

  const grants = (role) => (DEFAULT_ROLE_PERMISSIONS[role] || []).filter((k) => /^(ai|question_bank)\./.test(k)).sort();
  check('FR-AI-001\'s named actor is a Teacher, and the catalogue gives one every AI key',
    grants(ROLES.TEACHER),
    ['ai.approve', 'ai.generate', 'ai.usage.view', 'question_bank.manage', 'question_bank.view']);
  check('a Student holds none', grants(ROLES.STUDENT), []);
  check('and neither does a Parent', grants(ROLES.PARENT), []);
  check(
    'question_bank.manage is granted but deliberately mounted nowhere — §21 documents no manual CRUD',
    [PERMISSIONS.some((p) => p.key === 'question_bank.manage'), /question_bank\.manage/.test(src)],
    [true, false]
  );

  /* ── the stage machine, as a table ── */

  check('the five transitions and the stage each requires', service.TRANSITIONS, {
    extract: { from: 'uploaded', to: 'extracted' },
    analyze: { from: 'extracted', to: 'analyzed' },
    generate: { from: 'analyzed', to: 'generated' },
    difficulty: { from: 'generated', to: 'preview' },
    review: { from: 'preview', to: 'approved' },
  });
  check('  which chain through every stage the enum holds except the terminal rejected',
    Object.values(AI_WORKFLOW_STAGES).filter(
      (s) => !Object.values(service.TRANSITIONS).some((t) => t.from === s || t.to === s)
    ),
    ['rejected']);
}

/* ═══════════════════ part 3 — over real HTTP ═══════════════════ */

async function verifyHttp() {
  console.log('\n── Part 3 — real HTTP against the real database ──\n');

  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  const created = { users: [], schools: [], organizations: [], plans: [], subscriptions: [] };
  const baseline = {
    activityLog: (await db.ActivityLog.max('id')) || 0,
    auditLog: (await db.AuditLog.max('id')) || 0,
  };

  async function call(pathname, { method = 'GET', body, token, form } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + pathname, { method, headers, body: payload });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* left null */ }
    return { status: res.status, body: parsed, raw: text };
  }

  const codeOf = (r) => (r.body && r.body.error ? r.body.error.code : `no-error:${r.status}`);
  const dataOf = (r) => (r.body && r.body.data !== undefined ? r.body.data : null);

  async function expectOk(pathname, options, wantStatus) {
    const res = await call(pathname, options);
    if (res.status !== wantStatus) {
      throw new Error(`${options.method || 'GET'} ${pathname} expected ${wantStatus}, got ${res.status}: ${res.raw}`);
    }
    return res;
  }

  /** The `ai_limit` counter, read straight off usage_records rather than out of a response. */
  async function usedNow(subscriptionId) {
    const row = await db.UsageRecord.findOne({
      where: { subscription_id: subscriptionId, limit_key: LIMITS.AI_LIMIT },
    });
    return row ? Number(row.used_value) : 0;
  }

  async function teardown() {
    /*
     * Scoped to this run's own tenant — Known Issues #25. An unbounded delete above `baseline` also
     * removes rows belonging to any suite running concurrently, which is the mechanism behind
     * "a parallel run reports false failures": the victim then reads `[]`, not a partial set.
     *
     * Both tables are ON DELETE CASCADE from `schools` and `organizations`, so this run's rows would
     * be removed anyway when its schools and organization go. This stays explicit as belt-and-braces
     * and to keep the ordering obvious; what matters is that it can no longer reach another run.
     *
     * Rows with neither a school nor an organization — the seeded Super Admin's sign-ins — are left.
     * Every suite authenticates as that same user, so no run can claim them, and they sit below the
     * next run's baseline where no assertion can see them.
     */
    const ownTenant = [
      ...(Array.isArray(created.schools) && created.schools.length ? [{ school_id: created.schools }] : []),
      ...(Array.isArray(created.organizations) && created.organizations.length
        ? [{ organization_id: created.organizations }] : []),
      /*
       * The run's own users, which catches its PLATFORM-scope rows — sign-ins and super-admin
       * actions have no school and no organization, so the two clauses above never match them and
       * the cascade from `schools`/`organizations` never reaches them either. This clause only works
       * because it runs BEFORE `User.destroy` below: both trail tables are ON DELETE SET NULL from
       * `users`, so afterwards there is no `user_id` left to match.
       */
      ...(Array.isArray(created.users) && created.users.length ? [{ user_id: created.users }] : []),
    ];
    if (ownTenant.length) {
      await db.ActivityLog.destroy({
        where: { id: { [db.Op.gt]: baseline.activityLog }, [db.Op.or]: ownTenant },
      });
      await db.AuditLog.destroy({
        where: { id: { [db.Op.gt]: baseline.auditLog }, [db.Op.or]: ownTenant },
      });
    }
    if (created.schools.length) {
      await db.Question.destroy({ where: { school_id: created.schools } });
      await db.QuestionBank.destroy({ where: { school_id: created.schools } });
      await db.Subject.destroy({ where: { school_id: created.schools }, force: true });
      await db.Class.destroy({ where: { school_id: created.schools }, force: true });
      await db.AcademicSession.destroy({ where: { school_id: created.schools }, force: true });
    }
    if (created.subscriptions.length) {
      await db.UsageRecord.destroy({ where: { subscription_id: created.subscriptions } });
      await db.Subscription.destroy({ where: { id: created.subscriptions }, force: true });
    }
    await db.User.destroy({ where: { email: { [db.Op.like]: `%@${DOMAIN}` } }, force: true });
    const planWhere = {
      [db.Op.or]: [
        { code: { [db.Op.like]: `${CODE_PREFIX}%` } },
        ...(created.plans.length ? [{ id: created.plans }] : []),
      ],
    };
    const stale = (await db.SubscriptionPlan.findAll({ where: planWhere, attributes: ['id'] })).map((p) => p.id);
    if (stale.length) {
      await db.PlanModule.destroy({ where: { plan_id: stale } });
      await db.PlanLimit.destroy({ where: { plan_id: stale } });
      await db.SubscriptionPlan.destroy({ where: { id: stale }, force: true });
    }
    /* The uploaded sources, wholesale — files and the empty school-<id>/ shells alike. */
    for (const schoolId of created.schools) {
      try {
        fs.rmSync(path.join(config.uploads.dir, `school-${schoolId}`), { recursive: true, force: true });
      } catch { /* best effort */ }
    }
    if (created.schools.length) await db.School.destroy({ where: { id: created.schools }, force: true });
    await db.Organization.destroy({
      where: {
        [db.Op.or]: [
          { code: { [db.Op.like]: `${CODE_PREFIX}%` } },
          ...(created.organizations.length ? [{ id: created.organizations }] : []),
        ],
      },
      force: true,
    });
  }

  const svcSource = stripped('../src/modules/ai/ai.service.js');

  try {
    const roles = {};
    for (const slug of [ROLES.PRINCIPAL, ROLES.TEACHER, ROLES.STUDENT]) {
      // eslint-disable-next-line no-await-in-loop
      const role = await db.Role.findOne({ where: { slug } });
      if (!role) throw new Error(`seeded role missing: ${slug}`);
      roles[slug] = role;
    }

    /* What a killed earlier run of this suite left behind — see scripts/lib/residue.js. */
    const residueCleared = await sweepResidue(db, { codes: ['VAI-'], domains: ['verify-ai.local'], uploadsDir: config.uploads.dir });
    if (residueCleared) {
      console.log(`(cleared ${residueCleared} row(s) left behind by an earlier run that did not finish)`);
    }
    const org = await db.Organization.create({ name: 'Verify AI Org', code: `${CODE_PREFIX}ORG` });
    created.organizations.push(org.id);

    const mkSchool = async (code, name) => {
      const s = await db.School.create({ organization_id: org.id, name, code });
      created.schools.push(s.id);
      return s;
    };
    const schoolA = await mkSchool(`${CODE_PREFIX}A`, 'Verify AI A');   /* AI, 3 requests */
    const schoolB = await mkSchool(`${CODE_PREFIX}B`, 'Verify AI B');   /* no AI module */
    const schoolC = await mkSchool(`${CODE_PREFIX}C`, 'Verify AI C');   /* no subscription */
    const schoolD = await mkSchool(`${CODE_PREFIX}D`, 'Verify AI D');   /* another school, AI on */

    const mkPlan = async (code, aiEnabled, aiLimit) => {
      const plan = await db.SubscriptionPlan.create({
        name: `Verify AI ${code}`, code: `${CODE_PREFIX}${code}`, status: PLAN_STATUS.ACTIVE,
        tier_rank: 1, trial_days: 0, grace_period_days: 7,
      });
      created.plans.push(plan.id);
      for (const key of MODULE_LIST) {
        // eslint-disable-next-line no-await-in-loop
        await db.PlanModule.create({
          plan_id: plan.id, module_key: key, is_enabled: key === MODULES.AI ? aiEnabled : true,
        });
      }
      /*
       * A deliberately tiny AI allowance, so FR-AI-002's block is reachable in three requests rather
       * than a thousand. `file_upload_limit` is seeded because `upload.js` treats an unconfigured Fixed
       * limit as ZERO — without it every upload would be refused before multer ran.
       */
      await db.PlanLimit.create({
        plan_id: plan.id, limit_key: LIMITS.AI_LIMIT, limit_type: LIMIT_TYPES.FIXED, limit_value: aiLimit,
      });
      await db.PlanLimit.create({
        plan_id: plan.id, limit_key: LIMITS.FILE_UPLOAD_LIMIT, limit_type: LIMIT_TYPES.FIXED, limit_value: 5,
      });
      return plan;
    };
    const withAi = await mkPlan('WITH', true, 3);
    const withoutAi = await mkPlan('WITHOUT', false, 100);

    const subscribe = async (school, plan) => {
      const now = new Date();
      const sub = await db.Subscription.create({
        school_id: school.id, organization_id: org.id, plan_id: plan.id,
        state: SUBSCRIPTION_STATES.ACTIVE, billing_cycle: BILLING_CYCLES.MONTHLY, cycle_amount: 100,
        starts_at: now, current_period_start: now,
        current_period_end: new Date(now.getTime() + 30 * 864e5), grace_period_days: 7,
      });
      created.subscriptions.push(sub.id);
      return sub;
    };
    const subA = await subscribe(schoolA, withAi);
    await subscribe(schoolB, withoutAi);
    await subscribe(schoolD, withAi);
    /* schoolC is deliberately left unsubscribed. */

    const mkStructure = async (school, tag) => {
      const session = await db.AcademicSession.create({
        school_id: school.id, organization_id: org.id, name: `${tag} 2025-2026`,
        start_date: '2025-04-01', end_date: '2026-03-31', status: ACADEMIC_SESSION_STATUS.ACTIVE, is_current: true,
      });
      const klass = await db.Class.create({
        school_id: school.id, organization_id: org.id, academic_session_id: session.id,
        name: `${tag} Grade 1`, numeric_order: 1,
      });
      const subject = await db.Subject.create({
        school_id: school.id, organization_id: org.id, name: `${tag} Physics`, code: `${CODE_PREFIX}${tag}P`,
      });
      return { session, klass, subject };
    };
    const A = await mkStructure(schoolA, 'A');
    const D = await mkStructure(schoolD, 'D');

    const password_hash = await hashPassword(PASSWORD);
    const mkUser = async (key, slug, organization_id, school_id) => {
      const u = await db.User.create({
        role_id: roles[slug].id, organization_id, school_id, name: `Verify AI ${key}`,
        email: `${key}@${DOMAIN}`, username: `vai_${key.replace(/-/g, '_')}`,
        password_hash, status: USER_STATUS.ACTIVE, must_change_password: false,
      });
      created.users.push(u.id);
      return u;
    };
    await mkUser('principal-a', ROLES.PRINCIPAL, org.id, schoolA.id);
    await mkUser('principal-b', ROLES.PRINCIPAL, org.id, schoolB.id);
    await mkUser('principal-c', ROLES.PRINCIPAL, org.id, schoolC.id);
    await mkUser('principal-d', ROLES.PRINCIPAL, org.id, schoolD.id);
    await mkUser('teacher', ROLES.TEACHER, org.id, schoolA.id);
    await mkUser('student', ROLES.STUDENT, org.id, schoolA.id);

    async function signIn(identifier) {
      const res = await call('/auth/login', { method: 'POST', body: { identifier, password: PASSWORD } });
      const token = res.body && res.body.data ? res.body.data.accessToken : null;
      if (!token) throw new Error(`sign-in failed for ${identifier}: ${res.raw}`);
      return token;
    }
    const principalA = await signIn(`principal-a@${DOMAIN}`);
    const principalB = await signIn(`principal-b@${DOMAIN}`);
    const principalC = await signIn(`principal-c@${DOMAIN}`);
    const principalD = await signIn(`principal-d@${DOMAIN}`);
    const teacher = await signIn(`teacher@${DOMAIN}`);
    const student = await signIn(`student@${DOMAIN}`);

    /* ── the entitlement guard — FR-AI-001's own precondition ── */

    const moduleDenied = await call('/ai/banks', { token: principalB });
    check('a plan without the AI module refuses', moduleDenied.status, 403);
    check('  naming which module', moduleDenied.body.error.details.missing, [MODULES.AI]);
    const noSub = await call('/ai/banks', { token: principalC });
    check('a school with no subscription is refused differently', noSub.status, 402);
    check('  state before module', codeOf(noSub), 'SUBSCRIPTION_INACTIVE');

    /* ── FR-AI-002 before anything has been generated ── */

    const before = dataOf(await expectOk('/ai/usage', { token: teacher }, 200)).usage;
    check('FR-AI-002 — the counter starts at zero of the plan allowance', [before.used, before.allowed], [0, 3]);
    check('  and the school is not at its limit', before.at_limit, false);
    check('  with the whole allowance remaining', before.remaining, 3);
    check('no usage row exists until something is generated', await usedNow(subA.id), 0);

    /* ── step 1: the teacher uploads ── */

    const PDF = Buffer.from('%PDF-1.4\nverify-ai\n');
    const upload = async (token, body = {}) => {
      const form = new FormData();
      form.set('name', body.name || 'Term 1 syllabus');
      form.set('source_type', body.source_type || AI_SOURCE_TYPES.SYLLABUS);
      if (body.subject_id) form.set('subject_id', String(body.subject_id));
      if (body.class_id) form.set('class_id', String(body.class_id));
      form.set('source', new Blob([PDF], { type: 'application/pdf' }), body.filename || 'syllabus.pdf');
      return call('/ai/banks', { method: 'POST', token, form });
    };

    const createdRes = await upload(teacher, { subject_id: A.subject.id, class_id: A.klass.id });
    check('a Teacher uploads a source — FR-AI-001 names them as the actor', createdRes.status, 201);
    const bank = dataOf(createdRes).bank;
    check('the bank enters the workflow at its first stage', bank.workflow_stage, AI_WORKFLOW_STAGES.UPLOADED);
    check('the school is taken from the caller', bank.school_id, schoolA.id);
    check('the source type is the teacher\'s label for the material', bank.source_type, AI_SOURCE_TYPES.SYLLABUS);
    check('the original filename is kept', bank.source_filename, 'syllabus.pdf');
    check('the bank is marked AI-generated', bank.is_ai_generated, true);
    check('and the stored path never reaches the caller', 'source_path' in bank, false);
    check('  the response saying only that there is one', bank.has_source, true);

    const storedBank = await db.QuestionBank.findByPk(bank.id);
    check('the path really is on the row', Boolean(storedBank.source_path), true);
    check('  tenant-scoped under the school and the profile §21 reserved',
      new RegExp(`^school-${schoolA.id}/ai_source/`).test(storedBank.source_path || ''), true);
    check('  and the bytes are really on disk',
      fs.existsSync(path.join(config.uploads.dir, storedBank.source_path || 'x')), true);

    /*
     * Sent as REAL multipart with a file attached. An earlier draft posted JSON with no file, and the
     * 422 it asserted came from the service's own "No file was uploaded" check — so both assertions
     * passed with the `forbidden()` deleted. Two deliberate regressions demonstrated exactly that.
     */
    const withField = async (field, value) => {
      const f = new FormData();
      f.set('name', 'Forbidden field probe');
      f.set('source_type', AI_SOURCE_TYPES.SYLLABUS);
      f.set(field, String(value));
      f.set('source', new Blob([PDF], { type: 'application/pdf' }), 'probe.pdf');
      return call('/ai/banks', { method: 'POST', token: teacher, form: f });
    };
    const bodyPath = await withField('source_path', '../../etc/passwd');
    check('a body-supplied source_path is refused, not stripped', bodyPath.status, 422);
    check('  by the field itself, on a request that is otherwise complete',
      bodyPath.body && bodyPath.body.error ? bodyPath.body.error.details[0].field : null, 'source_path');
    const bodyStage = await withField('workflow_stage', AI_WORKFLOW_STAGES.APPROVED);
    check('and a body cannot skip to a later stage of FR-AI-001', bodyStage.status, 422);
    check('  likewise named',
      bodyStage.body && bodyStage.body.error ? bodyStage.body.error.details[0].field : null, 'workflow_stage');

    const studentUpload = await upload(student);
    check('a Student cannot upload — §21\'s actor is the Teacher', studentUpload.status, 403);
    check('  refused on the permission', codeOf(studentUpload), 'INSUFFICIENT_PERMISSION');

    /* ── the stage machine refuses every out-of-order transition ── */

    /*
     * Each out-of-order call carries a body its own schema ACCEPTS, so the refusal can only come from
     * the stage guard. `difficulty` requires a difficulty; sending `{}` there is refused by `validate`
     * with a 422 before the guard is ever reached, and the assertion would then be proving the schema.
     */
    const outOfOrder = [
      ['analyze', {}],
      ['generate', { count: 2 }],
      ['difficulty', { difficulty: QUESTION_DIFFICULTY.EASY }],
    ];
    for (const [route, validBody] of outOfOrder) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(`/ai/banks/${bank.id}/${route}`, { method: 'POST', token: teacher, body: validBody });
      check(`a bank at "uploaded" refuses ${route}`, [res.status, codeOf(res)], [409, 'AI_STAGE_INVALID']);
    }
    const earlyApprove = await call(`/ai/banks/${bank.id}/approve`, {
      method: 'POST', token: teacher, body: { approve: [1] },
    });
    check('and it refuses approval outright — nothing unreviewed reaches the Question Bank',
      [earlyApprove.status, codeOf(earlyApprove)], [409, 'AI_STAGE_INVALID']);
    check('  saying which stage it is at and which it needs',
      [earlyApprove.body.error.details.stage, earlyApprove.body.error.details.requires],
      [AI_WORKFLOW_STAGES.UPLOADED, AI_WORKFLOW_STAGES.PREVIEW]);
    check('  and none of those refusals cost a unit of the AI allowance', await usedNow(subA.id), 0);

    /* ── steps 2 and 3: the system extracts, then analyses ── */

    /*
     * The driver is spied on for this one call, because the mock cannot detect the bug that lived here.
     *
     * `ai/anthropic.js` dispatches entirely on `mimeType`: `application/pdf` parses locally, an image
     * goes to the model, and **anything else throws**. `ai.service.js` passed `mimeType: null`
     * hardcoded, so with the real driver every upload threw `Cannot extract text from "<file>" (null)`
     * before doing any work — extraction was structurally unreachable.
     *
     * Nothing caught it, and nothing could: every suite runs `AI_DRIVER=mock`, and the mock ignores
     * both the path and the type by design. The whole workflow passed end to end through a driver that
     * never looks at the argument that was wrong. So the assertion cannot be about the *result* — it
     * has to be about what the service handed the seam.
     */
    let seenExtractArgs = null;
    const realExtract = aiDriver.extract;
    aiDriver.extract = (args) => {
      seenExtractArgs = args;
      return realExtract(args);
    };

    let extracted;
    try {
      extracted = dataOf(
        await expectOk(`/ai/banks/${bank.id}/extract`, { method: 'POST', token: teacher, body: {} }, 200)
      ).bank;
    } finally {
      aiDriver.extract = realExtract;
    }

    check('the service reached the driver seam at all', Boolean(seenExtractArgs), true);
    check('  and handed it a real MIME type rather than null, which the real driver dispatches on',
      seenExtractArgs && seenExtractArgs.mimeType,
      UPLOAD_EXTENSION_MIME[path.extname(String(seenExtractArgs && seenExtractArgs.filename)).toLowerCase()]);
    check('  which for this upload is the PDF type the local parser branch needs',
      seenExtractArgs && seenExtractArgs.mimeType, 'application/pdf');
    /*
     * This fixture proves the point on its own: the file is a **.pdf** and the source type is
     * **syllabus**. §21's three source types are the teacher's label for the material, not its format,
     * and a syllabus is routinely a PDF. So `source_type` could not have been used to pick the
     * driver branch even though it was already being passed — the two genuinely disagree here, which
     * is why the fix derives the MIME from the filename instead.
     */
    check('  while the §21 source type says "syllabus" for the very same .pdf file',
      seenExtractArgs && seenExtractArgs.sourceType, AI_SOURCE_TYPES.SYLLABUS);

    check('SRS step 2 — the system extracts content', extracted.workflow_stage, AI_WORKFLOW_STAGES.EXTRACTED);
    check('  and says text was produced without returning it by default',
      [extracted.has_extracted_text, 'extracted_text' in extracted], [true, false]);
    const withText = dataOf(
      await expectOk(`/ai/banks/${bank.id}?include_text=true`, { token: teacher }, 200)
    ).bank;
    check('  which is returned only when asked for', withText.extracted_text.startsWith('Mock extraction of'), true);

    const analyzed = dataOf(
      await expectOk(`/ai/banks/${bank.id}/analyze`, { method: 'POST', token: teacher, body: {} }, 200)
    ).bank;
    check('SRS step 3 — the system analyses topics', analyzed.workflow_stage, AI_WORKFLOW_STAGES.ANALYZED);
    check('  storing them on the bank', analyzed.analyzed_topics.map((t) => t.name),
      ['Foundational definitions', 'Worked procedures', 'Common errors']);
    check('neither extract nor analyze is a metered AI request', await usedNow(subA.id), 0);

    /* ── steps 4 and 5: the one metered call ── */

    const genRes = await expectOk(
      `/ai/banks/${bank.id}/generate`,
      { method: 'POST', token: teacher, body: { count: 4, difficulty: QUESTION_DIFFICULTY.HARD } },
      200
    );
    const generated = dataOf(genRes).bank;
    check('SRS steps 4 and 5 — MCQs and their answers, in one call',
      generated.workflow_stage, AI_WORKFLOW_STAGES.GENERATED);
    check('  producing the number asked for', generated.generated_count, 4);
    check('  at the difficulty requested', generated.requested_difficulty, QUESTION_DIFFICULTY.HARD);
    check('  recording which provider answered', String(generated.ai_model).startsWith('mock:'), true);

    check('FR-AI-002 — and THIS is the request that costs a unit', await usedNow(subA.id), 1);
    check('  which the response reports back, as §21 asks the system to show',
      [dataOf(genRes).usage.used, dataOf(genRes).usage.allowed], [1, 3]);

    const questions = await db.Question.findAll({ where: { question_bank_id: bank.id }, order: [['id', 'ASC']] });
    check('the questions are rows in the questions table', questions.length, 4);
    check('  every one an MCQ from the AI', [
      questions.every((q) => q.type === QUESTION_TYPES.MCQ),
      questions.every((q) => q.source === QUESTION_SOURCES.AI),
    ], [true, true]);
    check('  none of them in the Question Bank yet — nothing enters unreviewed',
      questions.every((q) => q.status === QUESTION_STATUS.PENDING_REVIEW), true);
    check('  each carrying its answer, which SRS step 5 generates alongside the question',
      questions.every((q) => q.correct_option && q.answer_explanation), true);
    check('  and each answer matching one of its own option keys',
      questions.every((q) => q.options.some((o) => o.key === q.correct_option)), true);

    /* ── step 6: the teacher selects difficulty ── */

    /*
     * `call` rather than `expectOk`: a bulk `Model.update()` on `questions` raises the MCQ validator
     * against a partial instance, and an `expectOk` here would abort the run rather than name the
     * failure. A deliberate regression put the bulk update back and proved it.
     */
    const diffRes = await call(`/ai/banks/${bank.id}/difficulty`, {
      method: 'POST', token: teacher, body: { difficulty: QUESTION_DIFFICULTY.EASY },
    });
    check('the difficulty step is accepted', diffRes.status, 200);
    check('SRS step 6 — the teacher selects difficulty, after generation as §21 orders it',
      (dataOf(diffRes) || {}).bank ? dataOf(diffRes).bank.workflow_stage : null, AI_WORKFLOW_STAGES.PREVIEW);
    check('  applying it to every question that was generated', (dataOf(diffRes) || {}).updated, 4);
    check('  which the rows show',
      (await db.Question.findAll({ where: { question_bank_id: bank.id } }))
        .every((q) => q.difficulty === QUESTION_DIFFICULTY.EASY), true);
    check('  written through loaded instances, because a bulk update trips the MCQ validator',
      /await question\.save\(\);/.test(svcSource), true);
    check('and selecting a difficulty is not an AI request', await usedNow(subA.id), 1);

    /* ── step 7: preview ── */

    const preview = await expectOk(`/ai/banks/${bank.id}/questions?limit=100`, { token: teacher }, 200);
    check('SRS step 7 — the teacher previews what was generated', dataOf(preview).length, 4);
    check('  all still awaiting review',
      dataOf(preview).every((q) => q.status === QUESTION_STATUS.PENDING_REVIEW), true);

    /* ── steps 8 and 9: approve, and the Question Bank ── */

    const ids = questions.map((q) => q.id);
    const foreignQuestion = await call(`/ai/banks/${bank.id}/approve`, {
      method: 'POST', token: teacher, body: { approve: [999999999] },
    });
    check('a question that is not in this bank cannot be approved through it', foreignQuestion.status, 422);

    const reviewed = dataOf(
      await expectOk(`/ai/banks/${bank.id}/approve`, {
        method: 'POST', token: teacher,
        body: { approve: [ids[0], ids[1]], reject: [ids[2]], review_note: 'Two are usable' },
      }, 200)
    ).bank;
    check('SRS steps 8 and 9 — the teacher approves, and the bank reaches its outcome',
      reviewed.workflow_stage, AI_WORKFLOW_STAGES.APPROVED);
    check('  counting what actually entered the Question Bank', reviewed.approved_count, 2);
    check('  and stamping who approved it and when',
      [Boolean(reviewed.approved_by), Boolean(reviewed.approved_at)], [true, true]);

    const after = await db.Question.findAll({ where: { question_bank_id: bank.id }, order: [['id', 'ASC']] });
    check('the approved questions are in the Question Bank — §21\'s Expected Outcome',
      after.filter((q) => q.status === QUESTION_STATUS.APPROVED).map((q) => q.id), [ids[0], ids[1]]);
    check('  the rejected one is rejected', after[2].status, QUESTION_STATUS.REJECTED);
    check(
      '  and the one the teacher named NEITHER way is still pending, not silently rejected',
      after[3].status,
      QUESTION_STATUS.PENDING_REVIEW
    );
    check('  the reviewer being stamped on every question that was decided',
      after.slice(0, 3).every((q) => q.reviewed_by && q.reviewed_at), true);
    check('  and not on the one that was not', [after[3].reviewed_by, after[3].reviewed_at], [null, null]);
    check('reviewing is not an AI request either', await usedNow(subA.id), 1);

    /* ── FR-AI-002: the block ── */

    const runOne = async (label) => {
      const up = await upload(teacher, { name: label });
      const id = dataOf(up).bank.id;
      await expectOk(`/ai/banks/${id}/extract`, { method: 'POST', token: teacher, body: {} }, 200);
      await expectOk(`/ai/banks/${id}/analyze`, { method: 'POST', token: teacher, body: {} }, 200);
      return call(`/ai/banks/${id}/generate`, { method: 'POST', token: teacher, body: { count: 2 } });
    };

    check('a second generation is allowed', (await runOne('Second')).status, 200);
    check('  and the counter moves', await usedNow(subA.id), 2);
    check('a third exhausts the plan', (await runOne('Third')).status, 200);
    check('  bringing usage to the allowance', await usedNow(subA.id), 3);

    const atLimit = dataOf(await expectOk('/ai/usage', { token: teacher }, 200)).usage;
    check('FR-AI-002 — the system now reports the school at its limit',
      [atLimit.used, atLimit.allowed, atLimit.remaining, atLimit.at_limit], [3, 3, 0, true]);

    const blocked = await runOne('Fourth');
    check('and the fourth is blocked — §21\'s "block/warning when the limit is reached"', blocked.status, 403);
    check('  by the limit, named', codeOf(blocked), 'PLAN_LIMIT_EXCEEDED');
    check(
      '  and the blocked request cost nothing: the counter did not move',
      await usedNow(subA.id),
      3
    );
    check('  nor did it write any questions for that bank',
      await db.Question.count({ where: { school_id: schoolA.id } }) > 0
        && (await db.QuestionBank.findOne({ where: { school_id: schoolA.id, name: 'Fourth' } })).generated_count,
      0);

    /* ── FR-AI-002: a generation that FAILS is not charged ── */

    /*
     * The service header claims this, and until now nothing proved it. The failure is forced through
     * the seam rather than by adding a test-only driver to `src/`: pointing `config.ai.driver` at a
     * name no adapter answers to makes `resolve()` throw inside `generate()`, which is the shape a
     * provider outage takes. School D is used because school A is already at its limit, and a blocked
     * request would prove the wrong thing.
     */
    const dBank = dataOf(await expectOk('/ai/banks', {
      method: 'POST', token: principalD, form: (() => {
        const f = new FormData();
        f.set('name', 'D failing bank');
        f.set('source_type', AI_SOURCE_TYPES.PDF);
        f.set('source', new Blob([PDF], { type: 'application/pdf' }), 'd.pdf');
        return f;
      })(),
    }, 201)).bank;
    await expectOk(`/ai/banks/${dBank.id}/extract`, { method: 'POST', token: principalD, body: {} }, 200);
    await expectOk(`/ai/banks/${dBank.id}/analyze`, { method: 'POST', token: principalD, body: {} }, 200);

    const dSub = created.subscriptions[created.subscriptions.length - 1];
    check('school D has spent nothing yet', await usedNow(dSub), 0);

    const realDriver = config.ai.driver;
    config.ai.driver = 'no-such-provider';
    const failed = await call(`/ai/banks/${dBank.id}/generate`, {
      method: 'POST', token: principalD, body: { count: 2 },
    });
    config.ai.driver = realDriver;

    check('a generation the provider could not complete is refused', failed.status, 422);
    check('  and costs NOTHING — the counter did not move', await usedNow(dSub), 0);
    const stalled = await db.QuestionBank.findByPk(dBank.id);
    check('  the bank stays at the stage it was, so the teacher can retry',
      stalled.workflow_stage, AI_WORKFLOW_STAGES.ANALYZED);
    check('  with the reason recorded on the row', Boolean(stalled.error_message), true);
    check('  and no half-written questions behind it',
      await db.Question.count({ where: { question_bank_id: dBank.id } }), 0);

    const retried = await expectOk(
      `/ai/banks/${dBank.id}/generate`, { method: 'POST', token: principalD, body: { count: 2 } }, 200
    );
    check('the retry succeeds once the provider is back', dataOf(retried).bank.generated_count, 2);
    check('  and only THEN is a unit charged', await usedNow(dSub), 1);
    check('  the stale failure message being cleared', dataOf(retried).bank.error_message, null);

    /* ── tenant isolation ── */

    const crossRead = await call(`/ai/banks/${bank.id}`, { token: principalD });
    check('a principal of another school cannot read this bank', crossRead.status, 404);
    const crossNamed = await call(`/ai/banks?school_id=${schoolD.id}`, { token: principalA });
    check('and naming another school is refused by the tenant chain', crossNamed.status, 403);
    check('  before the record is ever looked for', codeOf(crossNamed), 'CROSS_TENANT_ACCESS_DENIED');
    /*
     * D has spent exactly one unit — its own retry above — and none of A's three. The point is the
     * separation, so both halves are asserted: the number is D's own, and it is not A's.
     */
    const dUsage = dataOf(await expectOk('/ai/usage', { token: principalD }, 200)).usage;
    check("each school meters its own allowance, not the organization's",
      [dUsage.used, dUsage.allowed, dUsage.at_limit], [1, 3, false]);
    check('  so A exhausting its plan leaves D free to generate', dUsage.remaining, 2);

    /* ── the trail ── */

    /*
     * `logActivity` inserts from `res.on('finish')` unawaited (`activityLog.js:246`, and the comment
     * at :278), so the response resolving does not mean the row is there. Re-read until it is.
     */
    const activity = await settle(
      () => db.ActivityLog.findAll({
        where: { id: { [db.Op.gt]: baseline.activityLog } }, order: [['id', 'ASC']],
      }),
      (rows) => rows.some((r) => r.entity_type === 'question_banks')
    );
    const mine = activity.filter((r) => r.entity_type === 'question_banks');
    check('every workflow write is in the activity trail', mine.length > 0, true);
    check('  and none of them records the stored path or the extracted text',
      mine.every((r) => {
        const meta = JSON.stringify(r.metadata || {});
        return !meta.includes('school-') && !meta.includes('Mock extraction');
      }), true);

    const audits = await settleDistinct(
      () => db.AuditLog.findAll({
        where: { id: { [db.Op.gt]: baseline.auditLog }, table_name: 'question_banks' },
      }),
      'event',
      2
    );
    check('question banks are audited per row', audits.length > 0, true);
    check('  an upload as a create', audits.some((r) => r.event === 'create'), true);
    check('  and every stage move as an update', audits.some((r) => r.event === 'update'), true);
  } finally {
    try {
      await teardown();
    } catch (err) {
      console.error('verify-ai Part 3 teardown failed:', err);
    }
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

/* ═══════════════════════════════════ run ═══════════════════════════════════ */

async function main() {
  await verifySchemas();
  await verifyAnthropicAdapter();
  verifyRouting();

  try {
    await db.sequelize.authenticate();
  } catch (err) {
    dbSkipped = true;
    console.log(`\nSKIP  Part 3 (HTTP) — database unreachable: ${err.message}`);
    return;
  }

  await verifyHttp();
}

main()
  .catch((err) => {
    failures += 1;
    console.error('\nverify-ai crashed:', err);
  })
  .finally(async () => {
    console.log('');
    if (dbSkipped) {
      console.log('⚠  Part 3 (HTTP) was SKIPPED — MySQL/MariaDB is not reachable.');
      console.log('   Parts 1–2 (pure) executed in full.');
    }
    if (failures === 0) {
      console.log(
        dbSkipped
          ? 'All pure AI checks passed (Parts 1–2). Part 3 pending a live database.'
          : 'All AI checks passed (Parts 1–3).'
      );
    } else {
      console.log(`${failures} check(s) FAILED.`);
    }
    try {
      await db.sequelize.close();
    } catch (_) { /* the pool may never have opened */ }
    /*
     * A degraded run is a FAILED run — Known Issue 28.
     *
     * This suite answers an unreachable database by setting `dbSkipped`, returning early from its
     * database half and printing that it passed. Until session 26 it then **exited 0**, so a stopped
     * MySQL read as a green run to anything that looks at the exit code — which is `node
     * scripts/verify-*.js` run directly (the workflow this project's log documents throughout) and
     * `scripts/stress.sh:17`, whose entire scoring is `if ! wait "$pid"`. A stress run with the
     * database down would have reported a perfect determinism score for suites that never ran.
     *
     * `npm test` was never exposed: `tests/globalSetup.js` proves the database with `SELECT
     * DATABASE()` before any suite spawns, and `tests/verify.test.js` asserts both that `skipped` is
     * empty and that each suite produced its exact recorded count. This closes the direct-run path,
     * which is the one a person uses.
     *
     * `--allow-skip` is for running the pure checks deliberately, and mirrors `--allow-shrink` in
     * `record-baseline.js` rather than inventing a new convention. The jest harness passes no
     * arguments (`suiteRunner.js:220`), so it can never opt out by accident.
     */
    if (dbSkipped && !process.argv.includes('--allow-skip')) {
      console.log('');
      console.log('   Exiting 1: the database half did not run, so this is not a pass.');
      console.log('   Re-run with --allow-skip to execute the pure checks on purpose.');
      process.exit(1);
    }
    process.exit(failures === 0 ? 0 : 1);
  });
