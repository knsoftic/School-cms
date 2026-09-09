'use strict';

/**
 * The `mock` AI driver — SRS §21, and the driver `.env` ships.
 *
 * `AI_DRIVER=mock` has been in `.env` since the configuration was written, with nothing reading it.
 * This is what it now selects.
 *
 * ## Deterministic, and offline in a way that is provable
 *
 * Two properties, both load-bearing for verification:
 *
 * 1. **It never opens the uploaded file.** `extract()` is handed an absolute path and ignores it. So a
 *    suite pinning `AI_DRIVER=mock` genuinely bypasses `pdf-parse`, and the 26-byte `%PDF-1.4…` fixture
 *    the other upload suites use stays usable — it does not have to be a valid PDF.
 * 2. **Same input, same output.** No `Math.random()`, no clock, no counter. Everything is a pure
 *    function of the arguments, so a suite can assert on exact strings rather than on shapes. A mock
 *    that produced plausible-looking noise could only be asserted loosely, and a loose assertion is the
 *    kind this project has repeatedly found to be true for the wrong reason.
 *
 * ## What it is not
 *
 * It is not a simulation of a language model and does not pretend to be. It produces well-formed output
 * that satisfies §21's contract and the `mcqNeedsOptionsAndAnswer` model validator, so the *workflow*
 * can be exercised end to end. The quality of generated questions is the provider's business, and the
 * provider is Phase 5.2.
 */

const OPTION_KEYS = Object.freeze(['A', 'B', 'C', 'D']);

/** A small deterministic digest, so different inputs give different — but stable — text. */
function digest(value) {
  const text = String(value == null ? '' : value);
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * SRS:1156 — *"System extracts content from the upload."*
 *
 * The uploaded file is **not read**. The text is derived from the filename and source type, which is
 * everything a caller can vary, so a suite can predict it exactly.
 */
async function extract({ sourceType, filename } = {}) {
  const name = filename || 'upload';
  return {
    text: [
      `Mock extraction of ${name} (${sourceType || 'unknown'} source).`,
      'Section 1 covers foundational definitions and the vocabulary used throughout.',
      'Section 2 covers worked procedures and the order the steps are applied in.',
      'Section 3 covers common errors and how each one is recognised and corrected.',
    ].join('\n'),
  };
}

/**
 * SRS:1157 — *"System analyzes topics within the extracted content."*
 *
 * Three topics, named after the sections `extract()` produces so the two stages visibly agree, with
 * weights that sum to 1 so a consumer can treat them as a distribution.
 */
async function analyze({ text } = {}) {
  const seed = digest(text);
  return {
    topics: [
      { name: 'Foundational definitions', weight: 0.4 },
      { name: 'Worked procedures', weight: 0.35 },
      { name: 'Common errors', weight: 0.25 },
    ],
    /* So a suite can prove `analyze` actually saw the extracted text rather than ignoring it. */
    fingerprint: seed,
  };
}

/**
 * SRS:1158-1159 — *"System generates MCQs"* and *"System generates answers."*
 *
 * One call, because §21 gives the pair one workflow stage and the answer lives on the question's own
 * row. Every question satisfies `mcqNeedsOptionsAndAnswer`: four options with distinct keys, and a
 * `correct_option` that is one of them.
 *
 * The correct answer rotates through A/B/C/D by index rather than being fixed, so a suite asserting
 * "the answer is one of the options" cannot pass by the answer always being 'A'.
 */
async function generate({ text, topics, count, difficulty, topic } = {}) {
  const wanted = Math.max(1, Number(count) || 1);
  const pool = Array.isArray(topics) && topics.length
    ? topics.map((t) => (t && t.name) || String(t))
    : [topic || 'General'];
  const seed = digest(text);

  const questions = [];
  for (let i = 0; i < wanted; i += 1) {
    const subject = pool[i % pool.length];
    const correct = OPTION_KEYS[i % OPTION_KEYS.length];
    questions.push({
      question_text: `Question ${i + 1}: which statement about "${subject}" is correct?`,
      options: OPTION_KEYS.map((key) => ({
        key,
        text: key === correct
          ? `The accurate statement about ${subject}.`
          : `A plausible but incorrect statement about ${subject} (${key}).`,
      })),
      correct_option: correct,
      answer_explanation: `Option ${correct} matches what the source says about ${subject}.`,
      difficulty,
      topic: subject,
    });
  }

  return { model: `mock:${seed}`, questions };
}

module.exports = { extract, analyze, generate };
