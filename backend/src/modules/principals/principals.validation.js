'use strict';

/**
 * Principal creation schemas — SRS §9.3 and FR-SADMIN-009.
 *
 * This is one of the few places the source gives an explicit field list, so it is followed exactly:
 *
 *   Name · Email · Phone · Username · Password · School · Status
 *
 * Seven fields, no more. `organization_id` is **not** among them and is not accepted: FR-SADMIN-009
 * links the account to a school, and the school already knows its organization, so deriving it in the
 * service is both correct and one fewer value a caller can get wrong. `role_id` is not accepted either —
 * the role is `principal` by definition of the endpoint.
 *
 * ## Which of the seven are required
 *
 * Name, Email, Username, Password and School are required; the source lists them as the fields
 * creation *captures*. Phone and Status are optional because their columns are nullable / defaulted —
 * `users.phone` allows null, and `users.status` is NOT NULL with a default. FR-SADMIN-009 says the
 * account is created *"with the submitted status"*, so a submitted value is honoured verbatim rather
 * than overridden; when none is submitted the column's own default applies.
 *
 * ## The shared rules
 *
 * `email` and `newPassword` come from `auth.validation.js`, which exports them for exactly this. Writing
 * `Joi.string().email()` here would reintroduce the TLD problem documented there — `@msms.local` has no
 * public suffix — and a local password rule would drift from `config.security.passwordMinLength`.
 *
 * `username` is lowercased on the way in. `authService.findByIdentifier()` lowercases what a caller
 * types before matching it against both the email and username columns, so a username stored with
 * capitals is a username whose stored form disagrees with every lookup that will ever be made for it.
 * The character class keeps it usable as an identifier rather than accepting spaces.
 *
 * `USERNAME_PATTERN` itself lives in `users.validation.js` — `users` is the table that owns the column,
 * and a second copy of the regex here would be free to drift from the one the §33 Users screen enforces.
 * It is re-exported so existing importers keep working.
 */

const Joi = require('joi');
const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { USER_STATUS } = require('../../config/constants');
const { email, newPassword } = require('../auth/auth.validation');
const { USERNAME_PATTERN } = require('../users/users.validation');

const fields = {
  name: Joi.string().trim().min(2).max(160),

  username: Joi.string()
    .trim()
    .lowercase()
    .min(3)
    .max(80)
    .pattern(USERNAME_PATTERN)
    .messages({
      'string.pattern.base':
        '"username" must start with a letter or digit and may contain only letters, digits, dots, hyphens and underscores',
    }),

  phone: Joi.string().trim().max(40).empty('').allow(null),

  status: Joi.string().valid(...Object.values(USER_STATUS)),

  school_id: commonSchemas.id,
};

/** FR-SADMIN-009 — the seven fields, and only those. */
const create = Joi.object({
  name: fields.name.required(),
  email,
  phone: fields.phone,
  username: fields.username.required(),
  password: newPassword,
  school_id: fields.school_id.required(),
  status: fields.status,
});

/**
 * The list FR-SADMIN-007 needs.
 *
 * *"Super Admin selects a Principal for the school"* is not performable without a way to see which
 * Principals exist, and §33 lists "Principals" as a Super Admin MVP screen. `school_id` narrows it to
 * the candidates for one school, which is the assignment screen's actual query.
 */
const list = listQuery(
  Joi.object({
    school_id: fields.school_id,
    status: fields.status,
  })
);

module.exports = {
  schemas: {
    create,
    list,
    idParam: commonSchemas.idParam,
  },
  USERNAME_PATTERN,
};
