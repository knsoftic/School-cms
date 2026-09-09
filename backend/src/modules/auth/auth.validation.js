'use strict';

/**
 * Auth request schemas — SRS §7, Working Method step 4 ("Validation & Constraints").
 *
 * `validate()` runs these before any controller, with `stripUnknown` on body and query, so a
 * controller below can treat `req.body` as already the right shape. Two rules here are load-bearing
 * rather than decorative and are worth reading before changing:
 *
 * ## The password ceiling is 72 bytes, not a round number
 *
 * bcrypt hashes the first 72 bytes of its input and silently ignores the rest. A 100-character
 * passphrase would therefore be accepted, stored, and then authenticate against any string sharing
 * its first 72 bytes — which the user has no way of knowing. Refusing the input is the honest
 * outcome. The check counts *bytes*: Joi's `.max()` counts characters, and a password of emoji or
 * CJK text reaches 72 bytes at 18–24 characters.
 *
 * The floor comes from `security.passwordMinLength` rather than a literal, so an operator can raise
 * it without a code change, and there is deliberately no composition rule — see config/env.js.
 *
 * ## Login takes one identifier field, not two
 *
 * SRS §9.3 has a Super Admin set both an email and a username for a Principal, and FR-AUTH-001 says
 * only "credentials". One field that accepts either keeps the form to two inputs and keeps the
 * failure message uniform, which is what stops the endpoint being an account-existence oracle.
 */

const Joi = require('joi');

const config = require('../../config/env');

/** bcrypt truncates beyond this; see the header. */
const PASSWORD_MAX_BYTES = 72;

/**
 * A new password.
 *
 * Applied to every field that *sets* a password. Never to `currentPassword` on the change endpoint:
 * an account whose existing password predates a raised `PASSWORD_MIN_LENGTH` must still be able to
 * authenticate in order to replace it, and validating the old value against the new policy would
 * lock exactly the users the policy exists to move.
 */
const newPassword = Joi.string()
  .min(config.security.passwordMinLength)
  .max(PASSWORD_MAX_BYTES)
  .custom((value, helpers) => {
    if (Buffer.byteLength(value, 'utf8') > PASSWORD_MAX_BYTES) return helpers.error('password.bytes');
    return value;
  })
  .required()
  .messages({
    'password.bytes': `Password must be at most ${PASSWORD_MAX_BYTES} bytes long.`,
    'string.min': `Password must be at least ${config.security.passwordMinLength} characters long.`,
  });

/**
 * A single-use token from an emailed link.
 *
 * `randomToken()` produces 32 bytes as base64url, which is 43 characters. The bounds are generous
 * rather than exact so a future change to the token length is not a validation failure, and the
 * character class matches base64url exactly so a token carrying anything else is refused before it
 * reaches a database lookup.
 */
const singleUseToken = Joi.string()
  .trim()
  .min(20)
  .max(200)
  .pattern(/^[A-Za-z0-9_-]+$/)
  .required()
  .messages({ 'string.pattern.base': 'This link is not valid.' });

/**
 * An email address, normalised the same way the seeder and every user-creating path normalise it.
 *
 * `tlds: { allow: false }` turns off Joi's check of the domain's last label against its built-in copy
 * of the IANA registry. That check is on by default and it rejects more than it should:
 *
 *   - The bootstrap Super Admin is seeded at `superadmin@msms.local`, so with the default on, the one
 *     account that exists on a fresh install cannot use forgot-password. That is not a hypothetical —
 *     it is what the verification suite found.
 *   - `.local`, `.internal` and `.corp` are the conventional names for a private network, and a school
 *     running split-horizon DNS has staff addresses on one of them.
 *   - The list is a snapshot baked into whichever Joi version is installed, so a domain on a TLD
 *     delegated after that release is refused until the dependency is bumped. A validator that gets
 *     less correct over time is worse than one that does not try.
 *
 * The syntax is still checked — a local part, an `@`, and a domain with at least two labels. What the
 * TLD check was standing in for is deliverability, and deliverability is proven by the confirmation
 * link in FR-AUTH-006, not by a table.
 */
const email = Joi.string()
  .trim()
  .lowercase()
  .email({ tlds: { allow: false } })
  .max(180)
  .required();

const schemas = {
  /** FR-AUTH-001. */
  login: Joi.object({
    /*
     * Not `.email()` and not lowercased by Joi — it may be a username, and the service lowercases
     * it once for both lookups. Trimmed, because a pasted credential often carries a space.
     */
    identifier: Joi.string().trim().min(3).max(180).required(),
    /*
     * No policy applied on the way in. The stored password may predate any current rule, and a
     * length check here would answer "is this even a possible password for this account", which is
     * information the endpoint must not give. Bounded only to keep a megabyte out of bcrypt.
     */
    password: Joi.string().min(1).max(200).required(),
    /*
     * Opt out of the refresh cookie. A native app or an integration holds the refresh token itself
     * and has no cookie jar; a browser leaves this alone and gets the httpOnly cookie, which is the
     * only place a refresh token should live in a browser.
     */
    returnRefreshToken: Joi.boolean().default(false),
  }),

  /**
   * FR-AUTH-003.
   *
   * The token is normally read from the httpOnly cookie and the body is empty. The field exists for
   * the non-browser caller that opted out of the cookie at login.
   */
  refresh: Joi.object({
    refreshToken: Joi.string().min(20).max(1000),
  }),

  /** FR-AUTH-005 — step one. Always answers the same way; see the controller. */
  forgotPassword: Joi.object({ email }),

  /** FR-AUTH-005 — step two. */
  resetPassword: Joi.object({
    token: singleUseToken,
    password: newPassword,
  }),

  /** Authenticated password change; also what clears `must_change_password`. */
  changePassword: Joi.object({
    currentPassword: Joi.string().min(1).max(200).required(),
    password: newPassword.invalid(Joi.ref('currentPassword')).messages({
      'any.invalid': 'The new password must be different from the current one.',
    }),
  }),

  /** FR-AUTH-006. */
  verifyEmail: Joi.object({ token: singleUseToken }),

  /**
   * FR-AUTH-006 — request a new verification link.
   *
   * The address is not taken from the body. It is the authenticated user's own, because an endpoint
   * that mails a token to an address supplied by the caller is a way to send our mail to anyone.
   */
  resendVerification: Joi.object({}),
};

/*
 * `newPassword`, `singleUseToken` and `email` are exported as shared rules, not just as internals.
 * Every module that sets a password or takes an address — §9.3's Principal creation, §15's staff
 * creation, §12's parent records — must reuse these rather than write `Joi.string().email()`, which
 * would reintroduce the TLD problem documented above one module at a time.
 */
module.exports = { schemas, newPassword, singleUseToken, email, PASSWORD_MAX_BYTES };
