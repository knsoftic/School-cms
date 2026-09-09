'use strict';

/**
 * The AI provider seam — SRS §21, FR-AI-001.
 *
 * §21 says the *system* extracts content, analyses topics, generates MCQs and generates answers. Those
 * four things are the only work in this application that leaves the process, so they live behind one
 * contract and the module above never learns which provider answered.
 *
 * ## Why a directory rather than one service file
 *
 * `mailService.js` is the precedent for driver selection — a flat `if (driver === …)` with a throw on an
 * unknown value (`mailService.js:117-137`), and this file keeps that shape deliberately. What it does
 * not keep is the single-file layout, for one reason: the Anthropic adapter needs `@anthropic-ai/sdk`
 * and `pdf-parse`, both declared in `package.json` and neither required anywhere in `src/` today. If
 * they were required at the top of a shared file, `AI_DRIVER=mock` would still load a PDF parser and an
 * HTTP SDK, and the verification suite — which pins `AI_DRIVER=mock` — would depend on both packages
 * parsing correctly to test code that never calls them. Each adapter is therefore required lazily, and
 * `mock.js` requires nothing at all.
 *
 * ## The contract
 *
 * Four methods, one per system step of FR-AI-001. Each takes a plain object and resolves to a plain
 * object; none of them touches the database, the request, or the response. That is what makes the
 * module above testable without a network and what makes Phase 5.2 a drop-in.
 *
 *   extract({ sourceType, mimeType, absolutePath, filename })
 *     → { text }                                    SRS:1156 "System extracts content from the upload."
 *
 *   analyze({ text, sourceType })
 *     → { topics: [{ name, weight }] }               SRS:1157 "System analyzes topics…"
 *
 *   generate({ text, topics, count, difficulty, subject, topic })
 *     → { model, questions: [{ question_text, options, correct_option,
 *                             answer_explanation, difficulty, topic }] }
 *                                                    SRS:1158-1159 MCQs and their answers
 *
 * `generate` returns both halves because §21 gives them one workflow stage (`AI_WORKFLOW_STAGES` has a
 * single `generated`) and because `questions.correct_option` and `answer_explanation` sit on the same
 * row as `question_text`, under a model validator that refuses an MCQ without its answer
 * (`models/exams.js` `mcqNeedsOptionsAndAnswer`). A separate answers call would have nothing to write.
 *
 * ## What the driver is NOT allowed to do
 *
 * It does not write rows, does not read `req`, and does not decide whether a school may generate — the
 * entitlement gate and the usage increment belong to the module, because they must hold whichever
 * provider answered. It also never returns a filesystem path: the module owns `source_path` and
 * suppresses it from every response (Known Issues #26's doctrine).
 */

const config = require('../config/env');

/** The four methods every adapter must implement, checked at selection rather than at first call. */
const DRIVER_METHODS = Object.freeze(['extract', 'analyze', 'generate']);

const DRIVERS = Object.freeze({
  mock: () => require('./mock'),
  anthropic: () => require('./anthropic'),
});

/**
 * The adapter named by `AI_DRIVER`.
 *
 * `env.js` validates that `ANTHROPIC_API_KEY` is set when the driver is `anthropic`, but it does **not**
 * validate the driver name itself against a known set — an unrecognised value passes boot silently. So
 * the check happens here, at first use, which is exactly where `mailService.js:137` puts the same check
 * for `MAIL_DRIVER`.
 */
function resolve() {
  const name = config.ai.driver;
  const load = DRIVERS[name];
  if (!load) {
    throw new Error(
      `Unknown AI_DRIVER "${name}". Expected one of: ${Object.keys(DRIVERS).join(', ')}.`
    );
  }

  const driver = load();
  for (const method of DRIVER_METHODS) {
    if (typeof driver[method] !== 'function') {
      throw new Error(`AI driver "${name}" does not implement ${method}()`);
    }
  }
  return driver;
}

const extract = (input) => resolve().extract(input);
const analyze = (input) => resolve().analyze(input);
const generate = (input) => resolve().generate(input);

/** Which provider answered, for the `ai_model` column and for the log. */
const driverName = () => config.ai.driver;

module.exports = { resolve, extract, analyze, generate, driverName, DRIVER_METHODS, DRIVERS };
