'use strict';

/**
 * The `anthropic` AI driver — SRS §21, and checklist row 5.2.
 *
 * ## Read this before believing anything below works
 *
 * **No request from this file has ever reached Anthropic.** That was true of every line below until
 * `verify-ai.js` grew a Part 1c, and the part of it that is still true is the part that matters.
 *
 * What now runs, and is asserted: the prompt this file builds, `textOf()`'s extraction of the reply,
 * `parseJson()`'s recovery of JSON from a fenced or prose-wrapped answer, its two distinct failures
 * (no JSON at all versus malformed JSON), the missing-key refusal, the model stamp, and the
 * difficulty default. The suite replaces `@anthropic-ai/sdk` in `require.cache` before the lazily
 * built client exists, so all of that is the real code — only the HTTP call is substituted. Eight
 * deliberate regressions on this file are caught by it.
 *
 * What is still **unverified, and cannot be verified here**: that Anthropic's API answers the way the
 * stub does. Proving that needs a real key and a real request, which the development environment has
 * neither of. So a stub agreeing with itself is not evidence about the service, and row 5.2 stays
 * open for exactly that reason — narrowed to the round trip, rather than covering the whole file.
 *
 * **PDF extraction is now tested, and it works** — this paragraph previously predicted trouble and the
 * prediction did not hold. Measured directly: a `pdfkit` document written with the default font was
 * handed to this `extract()` with `mimeType: 'application/pdf'` and came back as its exact text,
 * newlines and all. That contradicts the note elsewhere in the project that `pdf-parse` "cannot parse
 * pdfkit output at all" — which may still be true of the *report* PDFs `utils/pdf.js` builds, since
 * those use embedded fonts and compressed streams this probe did not exercise. The narrow claim is
 * the safe one: simple PDFs extract correctly, and the local branch is reachable.
 *
 * That branch was in fact **unreachable until session 26**. `ai.service.js` passed `mimeType: null`
 * hardcoded, so neither this branch nor the image one could ever be selected and every upload threw
 * `Cannot extract text from "<file>" (null)`. It survived because every suite runs `AI_DRIVER=mock`
 * and the mock ignores the argument. `verify-ai.js` now spies on the seam and asserts the MIME type
 * the service hands over, which is the only place the bug is visible under the mock.
 *
 * Whether an *image* extracts correctly is still unknown: that path calls the API and needs a key.
 *
 * Recorded this plainly rather than shipping it quietly, because the same file could otherwise be read
 * as a working integration by anyone who did not check which driver is configured.
 *
 * ## Both heavy dependencies are required lazily, inside the functions that need them
 *
 * `@anthropic-ai/sdk` and `pdf-parse` are both in `package.json` and neither is required anywhere else
 * in `src/`. Requiring them at the top of this file would load them whenever the facade is imported —
 * including under `AI_DRIVER=mock`, where nothing here ever runs. `pdf-parse` in particular reads a test
 * fixture from disk at require time in some versions, which is exactly the kind of surprise a
 * verification run should not inherit from a code path it never takes.
 *
 * ## Why extraction lives here and not in a shared helper
 *
 * Turning an upload into text is provider-specific: an image goes to the model as an image block, while
 * a PDF is parsed locally first. Putting it in a shared `extract.js` would drag `pdf-parse` into the
 * mock's path and make the offline claim false. So it is a driver method, and the mock's version opens
 * no file at all.
 */

const fs = require('fs');

const config = require('../config/env');
const logger = require('../config/logger');

const IMAGE_MIME = /^image\/(jpeg|png|webp)$/;

/** Lazily constructed, so importing this file costs nothing until a request actually uses it. */
let client = null;
function anthropic() {
  if (!client) {
    // eslint-disable-next-line global-require
    const Anthropic = require('@anthropic-ai/sdk');
    if (!config.ai.apiKey) {
      /* `env.js` refuses to boot in production without this; a dev run reaches here instead. */
      throw new Error('ANTHROPIC_API_KEY is not set — cannot use AI_DRIVER=anthropic');
    }
    client = new Anthropic({ apiKey: config.ai.apiKey });
  }
  return client;
}

/** The model's reply, as text, whatever content blocks it came back in. */
function textOf(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * The model is asked for JSON, and a model may still wrap it in prose or a fence.
 *
 * So the parse is defensive: take the outermost brace-delimited span and parse that. A provider that
 * answers unparseably is a failed generation, and the module above records no usage for a failure.
 */
function parseJson(raw, what) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`The AI provider did not return JSON for ${what}`);
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new Error(`The AI provider returned malformed JSON for ${what}: ${err.message}`);
  }
}

/** SRS:1156 — *"System extracts content from the upload."* */
async function extract({ mimeType, absolutePath, filename } = {}) {
  if (mimeType === 'application/pdf') {
    // eslint-disable-next-line global-require
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(fs.readFileSync(absolutePath));
    return { text: String(parsed.text || '').trim() };
  }

  if (IMAGE_MIME.test(String(mimeType))) {
    const message = await anthropic().messages.create({
      model: config.ai.model,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: fs.readFileSync(absolutePath).toString('base64') },
          },
          { type: 'text', text: 'Transcribe all readable text from this teaching material. Return the text only.' },
        ],
      }],
    });
    return { text: textOf(message) };
  }

  throw new Error(`Cannot extract text from "${filename}" (${mimeType})`);
}

/** SRS:1157 — *"System analyzes topics within the extracted content."* */
async function analyze({ text } = {}) {
  const message = await anthropic().messages.create({
    model: config.ai.model,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: 'Identify the teaching topics in the material below. Reply with JSON only, of the shape '
        + '{"topics":[{"name":"…","weight":0.0}]} where the weights sum to 1.\n\n'
        + String(text || '').slice(0, 100000),
    }],
  });
  const parsed = parseJson(textOf(message), 'topic analysis');
  return { topics: Array.isArray(parsed.topics) ? parsed.topics : [] };
}

/**
 * SRS:1158-1159 — the MCQs and their answers, in one call.
 *
 * The returned shape must satisfy `models/exams.js`'s `mcqNeedsOptionsAndAnswer`: at least two options,
 * and a `correct_option` matching one of their keys. The module validates every question against that
 * before writing, so a provider that ignores the instruction fails the request rather than writing a
 * half-formed row.
 */
async function generate({ text, topics, count, difficulty, subject, topic } = {}) {
  const message = await anthropic().messages.create({
    model: config.ai.model,
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [
        `Write ${count} multiple-choice questions at ${difficulty} difficulty`,
        subject ? ` for the subject "${subject}"` : '',
        topic ? ` on the topic "${topic}"` : '',
        '.\nUse only the material below.',
        Array.isArray(topics) && topics.length
          ? `\nCover these topics: ${topics.map((t) => (t && t.name) || t).join(', ')}.`
          : '',
        '\nReply with JSON only, of the shape {"questions":[{"question_text":"…",',
        '"options":[{"key":"A","text":"…"}],"correct_option":"A","answer_explanation":"…","topic":"…"}]}.',
        '\nEvery question must have four options with keys A, B, C, D and exactly one correct_option.',
        '\n\n',
        String(text || '').slice(0, 100000),
      ].join(''),
    }],
  });

  const parsed = parseJson(textOf(message), 'question generation');
  const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  logger.info('AI generation returned', { model: config.ai.model, count: questions.length });

  return {
    model: `anthropic:${config.ai.model}`,
    questions: questions.map((q) => ({ ...q, difficulty: q.difficulty || difficulty })),
  };
}

module.exports = { extract, analyze, generate };
