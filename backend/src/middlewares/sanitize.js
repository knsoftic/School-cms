'use strict';

/**
 * Input hardening — SRS §24 FR-SEC-003 (XSS) and FR-SEC-005 (API security).
 *
 * What this deliberately does *not* do: HTML-escape every incoming string. Blanket escaping
 * corrupts legitimate data — a school called "Smith & Sons" would persist as
 * "Smith &amp; Sons", and a physics question containing "5 < 7" would be mangled — and it
 * gives only the appearance of safety, because the real defence for XSS is escaping at the
 * point of *rendering*, which the React frontend does by default (see ARCHITECTURE §7).
 *
 * What it does instead, at the point where each control actually belongs:
 *
 *   1. Prototype-pollution keys are dropped. `__proto__` / `constructor` / `prototype`
 *      arriving in a JSON body is never legitimate, and assigning it can corrupt
 *      Object.prototype for the whole process.
 *   2. Control characters are stripped. They serve no purpose in API input and are the
 *      mechanism behind log forging and CSV/terminal injection.
 *   3. Actively executable markup is removed from string values — script/iframe/object/embed/
 *      style/link elements, `on*=` event handlers, and `javascript:` / `data:text/html` URIs.
 *      These are the constructs that turn stored text into stored XSS in any consumer that is
 *      *not* React: a PDF renderer, an email template, a third-party API client — all of which
 *      SRS §30 Rule 3 says will exist.
 *   4. Payload depth is capped, so a deeply nested body cannot be used to burn CPU in this
 *      walk or in any recursive code downstream.
 *
 * Fields that must legitimately hold rich text should be validated by their own Joi schema and
 * sanitised for their specific output context; the SRS names no such field today.
 */

const ApiError = require('../utils/ApiError');
const logger = require('../config/logger');

/** Keys that can reach Object.prototype through a naive assign/merge. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Tags whose content executes or loads code, rather than merely formatting text. */
const EXECUTABLE_TAGS = 'script|iframe|object|embed|style|link|base|meta|form|svg|math';

const PATTERNS = [
  /* Paired executable elements, including their contents. */
  new RegExp(`<\\s*(${EXECUTABLE_TAGS})\\b[^>]*>[\\s\\S]*?<\\s*/\\s*(${EXECUTABLE_TAGS})\\s*>`, 'gi'),
  /* Unpaired or truncated executable tags — `<script src=x>` with no closing tag. */
  new RegExp(`<\\s*/?\\s*(${EXECUTABLE_TAGS})\\b[^>]*>?`, 'gi'),
  /* Inline event handlers: onerror=, onload=, onclick= … */
  /\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
  /* Script-bearing URI schemes. */
  /javascript\s*:/gi,
  /vbscript\s*:/gi,
  /data\s*:\s*text\s*\/\s*html/gi,
];

/*
 * Control characters except tab (09), newline (0A) and carriage return (0D).
 * Built from a string rather than a regex literal so the source file stays plain ASCII —
 * a literal control byte in source is invisible in review and easy to mangle in an edit.
 */
/*
 * `no-control-regex` exists to catch a control character that arrived by accident. Here they are
 * the subject: this class is what strips them out of untrusted input, and the paragraph above
 * explains why it is built from a string rather than a literal.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

const MAX_DEPTH = 12;

/** Clean a single string value. Returns the input unchanged when nothing matched. */
function cleanString(value) {
  let out = value.replace(CONTROL_CHARS, '');

  /*
   * Applied repeatedly: removing one layer can reveal another that was split across it, as in
   * `<scr<script>ipt>`. Bounded, so a crafted input cannot spin here.
   */
  for (let pass = 0; pass < 4; pass += 1) {
    const before = out;
    for (const pattern of PATTERNS) out = out.replace(pattern, '');
    if (out === before) break;
  }

  return out;
}

/**
 * Walk a parsed request payload in place.
 * @param {object|any[]} node
 * @param {number} depth
 * @param {{cleaned: number, dropped: string[]}} report
 */
function walk(node, depth, report) {
  if (depth > MAX_DEPTH) {
    throw ApiError.badRequest('Request payload is nested too deeply.', {
      code: 'PAYLOAD_TOO_DEEP',
      details: { maxDepth: MAX_DEPTH },
    });
  }

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      if (typeof node[i] === 'string') {
        const cleaned = cleanString(node[i]);
        if (cleaned !== node[i]) {
          node[i] = cleaned;
          report.cleaned += 1;
        }
      } else if (node[i] && typeof node[i] === 'object') {
        walk(node[i], depth + 1, report);
      }
    }
    return report;
  }

  for (const key of Object.keys(node)) {
    if (FORBIDDEN_KEYS.has(key)) {
      delete node[key];
      report.dropped.push(key);
      continue;
    }

    const value = node[key];
    if (typeof value === 'string') {
      const cleaned = cleanString(value);
      if (cleaned !== value) {
        node[key] = cleaned;
        report.cleaned += 1;
      }
    } else if (value && typeof value === 'object') {
      walk(value, depth + 1, report);
    }
  }

  return report;
}

/**
 * Clean the named containers on a request, accumulating the outcome onto `req.sanitized`.
 *
 * Accumulated rather than assigned because a request can be sanitised twice: once for its query and
 * params, and again for a multipart body that did not exist the first time round. A second pass that
 * overwrote the first would lose whatever the first one found.
 *
 * @param {import('express').Request} req
 * @param {string[]} containers
 * @returns {{cleaned: number, dropped: string[]}} what *this* pass found
 */
function sanitizeContainers(req, containers) {
  const report = { cleaned: 0, dropped: [] };

  for (const container of containers) {
    const value = req[container];
    if (value && typeof value === 'object') walk(value, 0, report);
  }

  /* Surfaced so `activityLog` can record that a request arrived carrying hostile input. */
  if (report.cleaned || report.dropped.length) {
    const previous = req.sanitized || { cleaned: 0, dropped: [] };
    req.sanitized = {
      cleaned: previous.cleaned + report.cleaned,
      dropped: [...previous.dropped, ...report.dropped],
    };

    /*
     * Logged here as well as folded into the activity row, because `activity_logs.action` is a fixed
     * SRS §26 enumeration with no value meaning "hostile input" — so a request that was sanitised but
     * recorded nothing else would otherwise leave no trace at all.
     */
    logger.warn('Request input was sanitised', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      containers,
      cleaned: report.cleaned,
      dropped: report.dropped,
    });
  }

  return report;
}

/**
 * Sanitise `req.body`, `req.query` and `req.params`.
 *
 * Runs after the body parsers and before validation, so Joi sees the cleaned values and a
 * schema's `.max()` applies to what will actually be stored.
 */
function sanitizeRequest(req, res, next) {
  try {
    sanitizeContainers(req, ['body', 'query', 'params']);
  } catch (err) {
    return next(err);
  }

  return next();
}

/**
 * Sanitise a body that only came into existence after `sanitizeRequest` had already run.
 *
 * A multipart request has no `req.body` at that point — multer parses it per route, much later — so
 * its text fields would otherwise reach the database having passed through no cleaning at all. That is
 * precisely the payload an attacker would choose: a student's "notes" field submitted alongside a photo
 * is stored text like any other. Part of the `uploadSingle`/`uploadArray` chain rather than something a
 * route has to remember.
 *
 * @type {import('express').RequestHandler}
 */
function sanitizeParsedBody(req, res, next) {
  try {
    sanitizeContainers(req, ['body']);
  } catch (err) {
    return next(err);
  }

  return next();
}

module.exports = {
  sanitizeRequest,
  sanitizeParsedBody,
  sanitizeContainers,
  cleanString,
  FORBIDDEN_KEYS,
  MAX_DEPTH,
};
