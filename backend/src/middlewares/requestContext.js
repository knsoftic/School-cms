'use strict';

/**
 * Per-request context — request id and timing.
 *
 * SRS §26 requires error and activity logs. Both are only useful if a single request can be
 * traced across them, so every request gets an id that is echoed in the response header, put
 * on every log line, stored on `activity_logs.request_id` / `audit_logs.request_id`, and
 * returned inside error envelopes.
 *
 * An inbound `X-Request-Id` is honoured so a reverse proxy or a mobile client can correlate
 * its own id — but only after validation. Reflecting an unvalidated header into a response
 * header and into log files invites header injection and log forging, so anything that is not
 * a short, boring token is replaced with one we generated.
 */

const { nanoid } = require('nanoid');

/** Conservative: the characters a correlation id legitimately needs, and no more. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._~-]{8,64}$/;

function requestContext(req, res, next) {
  const inbound = req.get('X-Request-Id');
  req.id = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : nanoid(16);
  req.startedAt = process.hrtime.bigint();

  res.setHeader('X-Request-Id', req.id);
  next();
}

/** Elapsed milliseconds since `requestContext` ran, to one decimal place. */
function elapsedMs(req) {
  if (!req.startedAt) return null;
  return Number((process.hrtime.bigint() - req.startedAt) / 1000n) / 1000;
}

module.exports = { requestContext, elapsedMs, SAFE_REQUEST_ID };
