'use strict';

/**
 * Outbound email — the transport, not the messages.
 *
 * SRS §7 requires two things to be *sent*: a password-reset link (FR-AUTH-005) and an email
 * verification step (FR-AUTH-006). §23's notification engine will need the same transport for its
 * nine fixed notification types. So this service knows how to hand a message to the outside world
 * and nothing about why any particular message exists — the modules own their own wording.
 *
 * ## Two drivers, and why `log` is the default
 *
 *   `log`   Renders the message into the application log and returns success. This is the default
 *           because a developer running `npm run db:reset && npm start` has no SMTP server, and a
 *           password reset that throws `ECONNREFUSED` would make the endpoint look broken when the
 *           endpoint is fine. The reset link appears in `storage/logs`, which is what a developer
 *           actually needs.
 *   `smtp`  nodemailer over a real server, configured by `MAIL_*`.
 *
 * A third option — `MAIL_DRIVER` set to anything else — is a configuration error and is reported as
 * one at first send rather than being silently treated as `log`.
 *
 * ## Sending never fails the request that triggered it
 *
 * `send()` resolves with `{sent: false, error}` instead of rejecting. The reason is specific to what
 * this transport is used for: a password reset has already written the token to the database by the
 * time the email goes out, so a 500 from a mail failure would tell the user their reset failed while
 * leaving a live token behind. Reporting the failure to the log and answering normally is both more
 * honest to the user ("check your email") and safer, because the alternative — rolling the token
 * back — hands an enumeration oracle to anyone who can make SMTP fail.
 *
 * A caller that genuinely must know goes by the return value. Nothing in §7 does.
 *
 * ## The transport is created once, lazily
 *
 * Not at require time: `src/models` and every verification script pull this module in transitively,
 * and creating a pooled SMTP connection because a script imported a service is wrong. The first
 * actual `send()` builds it.
 */

const config = require('../config/env');
const logger = require('../config/logger');

/** Built on first use by `smtpTransport()`; null until then. */
let transport = null;

/**
 * The nodemailer transport, created once.
 *
 * `require` is inside the function for the same reason the transport is lazy — a deployment running
 * with `MAIL_DRIVER=log` should not load the library at all.
 *
 * @returns {import('nodemailer').Transporter}
 */
function smtpTransport() {
  if (transport) return transport;

  if (!config.mail.host) {
    throw new Error('MAIL_DRIVER=smtp requires MAIL_HOST to be set.');
  }

  const nodemailer = require('nodemailer');

  transport = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    /*
     * `secure` means "TLS from the first byte" (port 465). Port 587 starts in the clear and
     * upgrades with STARTTLS, which nodemailer does by itself when the server offers it — so
     * `secure: false` on 587 is not an unencrypted connection, and forcing `true` there fails the
     * handshake. Getting this pair wrong is the most common SMTP misconfiguration, hence the note.
     */
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.password } : undefined,
    pool: true,
  });

  return transport;
}

/**
 * Fold a message into one log entry.
 *
 * The body is included in full and deliberately so — under the `log` driver this *is* the delivery
 * channel, and a reset link that is not in the log cannot be used. `storage/logs` is not a place for
 * production secrets, which is why `log` is a development driver and the header says so.
 */
function logMessage(message) {
  logger.info('Email (MAIL_DRIVER=log, not actually sent)', {
    to: message.to,
    subject: message.subject,
    body: message.text,
  });
}

/**
 * Send one message.
 *
 * @param {object} message
 * @param {string} message.to        one recipient address
 * @param {string} message.subject
 * @param {string} message.text      plain-text body; required, and the only body `log` shows
 * @param {string} [message.html]    optional HTML alternative
 * @returns {Promise<{sent: boolean, driver: string, error?: string}>}
 */
async function send(message) {
  const { to, subject, text } = message;

  if (!to || !subject || !text) {
    /*
     * Thrown, not returned: an incomplete message is a defect in the calling module, not a delivery
     * failure, and swallowing it would hide the bug behind "the email did not arrive".
     */
    throw new Error('mailService.send() requires to, subject and text');
  }

  const driver = config.mail.driver;

  try {
    if (driver === 'log') {
      logMessage(message);
      return { sent: true, driver };
    }

    if (driver === 'smtp') {
      await smtpTransport().sendMail({
        from: config.mail.from,
        to,
        subject,
        text,
        html: message.html,
      });
      logger.info('Email sent', { to, subject });
      return { sent: true, driver };
    }

    throw new Error(`Unknown MAIL_DRIVER "${driver}". Expected "log" or "smtp".`);
  } catch (err) {
    /* See the header: a delivery failure is reported, never propagated into the request. */
    logger.error('Email could not be sent', { to, subject, driver, error: err.message });
    return { sent: false, driver, error: err.message };
  }
}

/**
 * Drop the pooled transport.
 *
 * For a test that changes `MAIL_*` between cases, and for a graceful shutdown that wants the pool's
 * sockets closed. Safe to call when nothing was ever created.
 *
 * @returns {Promise<void>}
 */
async function close() {
  if (!transport) return;
  try {
    if (typeof transport.close === 'function') transport.close();
  } catch (err) {
    logger.warn('Mail transport did not close cleanly', { error: err.message });
  }
  transport = null;
}

module.exports = { send, close };
