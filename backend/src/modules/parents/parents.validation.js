'use strict';

/**
 * Parent schemas — SRS §15.2, FR-PARENT-001 / FR-PARENT-002.
 *
 * §15.2 names three things: Parent Account, Multiple Children, Parent Dashboard. The first is why
 * this module is different from its two siblings — `parents.user_id` is **NOT NULL**, so a parent row
 * cannot exist without a login. FR-PARENT-001 says outright "System creates a Parent Account", so
 * `POST /parents` creates the `users` row as well as the `parents` row, and the credential fields
 * below are the account's, not the profile's.
 *
 * `email`, `newPassword` and `USERNAME_PATTERN` are **reused, not restated** — the per-module contract
 * requires it, and `principals/` (the only other module that creates a user) reuses the same three.
 * A second password policy here would be free to drift from `config.security.passwordMinLength`.
 *
 * The profile's own `email` is separate from the account's and deliberately so: `parents.email` is a
 * contact column on the profile, `users.email` is the sign-in identifier. A school may hold a parent's
 * personal address on the profile while the account is keyed to something else.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { email, newPassword } = require('../auth/auth.validation');
const { USERNAME_PATTERN } = require('../users/users.validation');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

const fields = {
  school_id: Joi.number().integer().min(1),

  /* The account. */
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

  /* The profile — every width taken from the model, not chosen (§5a defect 24). */
  name: Joi.string().trim().min(2).max(160),
  relation: Joi.string().trim().max(60).empty('').allow(null),
  contact_email: Joi.string()
    .trim()
    .lowercase()
    .email({ tlds: { allow: false } })
    .max(180)
    .empty('')
    .allow(null),
  phone: Joi.string().trim().max(40).empty('').allow(null),
  occupation: Joi.string().trim().max(120).empty('').allow(null),
  address: Joi.string().trim().max(255).empty('').allow(null),
  national_id: Joi.string().trim().max(60).empty('').allow(null),
  /*
   * Known Issues #26. A stored filesystem path never comes from a request body — the doctrine
   * `finance`, `fees`, `homework`, `assignments`, `library` and `documents` all enforce.
   *
   * Unlike `students.photo_path`, this column gets **no writer**: SRS §15.2 names no photo and no image
   * for a parent, so an upload route here would be inventing a requirement rather than implementing one.
   * The column therefore stays permanently null, which is why this module needs no `present()` — there
   * is no stored path to suppress. A later session that gives it a writer must add one in the same
   * change.
   */
  photo_path: Joi.any()
    .forbidden()
    .messages({
      'any.unknown':
        '"photo_path" is not a request-body field; SRS §15.2 names no photo for a parent',
    }),
  is_active: Joi.boolean(),

  /* The link. */
  student_id: Joi.number().integer().min(1),
  link_relation: Joi.string().trim().max(60).empty('').allow(null),
  is_primary_guardian: Joi.boolean(),

  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const owned = {
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
  user_id: forbiddenField('"user_id" is the account this endpoint creates, not one a body may name'),
};

const profile = {
  relation: fields.relation,
  contact_email: fields.contact_email,
  phone: fields.phone,
  occupation: fields.occupation,
  address: fields.address,
  national_id: fields.national_id,
  photo_path: fields.photo_path,
  reason: fields.reason,
};

/**
 * FR-PARENT-001. `email`, `username` and `password` are the account's; the rest is the profile.
 *
 * `user_id` is `forbidden()` rather than accepted: unlike `teachers` and `students`, where linking an
 * existing account is a legitimate operation, a parent's account is *created here*. Accepting one
 * would mean two ways to reach the same NOT NULL column with different guarantees behind them.
 */
const create = Joi.object({
  school_id: fields.school_id,
  name: fields.name.required(),
  email: email.required(),
  username: fields.username.required(),
  password: newPassword,
  is_active: fields.is_active,
  /* Link one or more children at creation — FR-PARENT-001's second half, in one request. */
  children: Joi.array()
    .items(
      Joi.object({
        student_id: fields.student_id.required(),
        relation: fields.link_relation,
        is_primary_guardian: fields.is_primary_guardian,
      })
    )
    .max(50),
  ...profile,
  ...owned,
});

/**
 * The profile only. The account's own `email`, `username` and `password` are not editable here —
 * §33's Users screen owns a `users` row, and a second write path to the sign-in identifier would be a
 * second place the uniqueness and the lower-casing rules have to hold.
 */
const update = Joi.object({
  school_id: fields.school_id,
  name: fields.name,
  is_active: fields.is_active,
  ...profile,
  ...owned,
  email: forbiddenField('"email" is the account\'s — change it through the Users screen'),
  username: forbiddenField('"username" is the account\'s — change it through the Users screen'),
  password: forbiddenField('"password" is changed through /auth, never through a profile edit'),
}).min(1);

/** FR-PARENT-001 — link a child to an existing parent. */
const linkChild = Joi.object({
  school_id: fields.school_id,
  student_id: fields.student_id.required(),
  relation: fields.link_relation,
  is_primary_guardian: fields.is_primary_guardian,
  reason: fields.reason,
});

const list = listQuery(
  Joi.object({
    school_id: fields.school_id,
    is_active: Joi.boolean(),
    student_id: fields.student_id,
    q: Joi.string().trim().max(120),
  })
);

const showQuery = Joi.object({
  school_id: fields.school_id,
});

const linkParams = Joi.object({
  id: commonSchemas.id.required(),
  linkId: commonSchemas.id.required(),
});

module.exports = {
  schemas: {
    create,
    update,
    linkChild,
    list,
    showQuery,
    idParam: commonSchemas.idParam,
    linkParams,
  },
  fields,
};
