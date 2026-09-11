'use strict';

/**
 * User request schemas — SRS §33 "Users" (Super Admin MVP screen).
 *
 * ## What the source actually says about this screen
 *
 * §33 lists **"Users"** among the Super Admin MVP screens and says nothing else about it: there is no
 * `FR-USER-nnn` anywhere in the document, and §9's functional requirements stop at FR-SADMIN-009
 * (Principal creation). The nearest requirement that touches a user record is FR-AUTH-007 *"Account
 * Status Management"*, whose actor is **"Super Admin / School Admin / System"** and whose behaviour is
 * *"System tracks and enforces account status"*. So the editable surface here is derived from the
 * `users` columns in §29 plus FR-AUTH-007, and nothing beyond that is invented — §35 rules out
 * additional workflows, and this is precisely the kind of gap it names.
 *
 * ## Fields deliberately not accepted
 *
 *  - **`role_id`** — moving an account between §5's eleven roles is not a workflow the source
 *    describes, and it is the shortest path to privilege escalation: a Principal holding
 *    `users.manage` could promote a teacher to `super_admin` with one PATCH. The role is decided by
 *    whichever module creates the account (§9.3 for a Principal, §15 for school people).
 *  - **`password`** — FR-AUTH-005 makes password reset the account holder's own operation, initiated
 *    by them. An administrator types someone else's password only at creation — §9.3's Principal, a
 *    Parent, and the school logins of the owner's decision D1 (`create` below), each a temporary
 *    password the account must change at first sign-in. An administrator-sets-any-password endpoint is
 *    not in the document.
 *  - **`organization_id` / `school_id`** — moving a user between tenants would make
 *    `users.school_id` disagree with the records that reference them (`schools.principal_id`, marks,
 *    attendance) and there is no source requirement for a transfer. Tenancy is set at creation from
 *    the school, as `principals.service` documents.
 *  - **`avatar_path`** — written by the upload middleware, never by a JSON field, for the reason
 *    `organizations.validation` records: accepting it would let a caller point a row at any path.
 *  - **`email_verified_at`, `must_change_password`, the lockout counters, every token column** —
 *    owned by the auth module's own flows (FR-AUTH-003/005/006).
 *
 * That leaves the six columns a Users screen actually edits: name, email, username, phone, status
 * and locale.
 *
 * ## The shared rules
 *
 * `email` comes from `auth.validation.js` — writing `Joi.string().email()` here would reintroduce the
 * TLD problem documented there, since `superadmin@msms.local` has no public suffix and must validate.
 * `USERNAME_PATTERN` and the lowercasing are defined here because `users` is the table that owns the
 * column; `principals.validation` imports them rather than keeping a second copy of the regex.
 */

const Joi = require('joi');
const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { USER_STATUS, ROLE_LIST, ROLES } = require('../../config/constants');
const { email, newPassword } = require('../auth/auth.validation');

/**
 * The roles a school may create a login for — the owner's decision D1 in `docs/OWNER-DECISIONS.md`.
 *
 * Every school person except the two the source already gives a creation path: a **Principal** is
 * created by the Super Admin (FR-SADMIN-009) and a **Parent** with their profile (FR-PARENT-001). The
 * platform roles are never a school's to create. `users.service` pairs each role with the profile it
 * must be linked to; a School Admin has no profile table, so it links to nothing.
 */
const CREATABLE_ROLES = Object.freeze([
  ROLES.SCHOOL_ADMIN,
  ROLES.TEACHER,
  ROLES.ACCOUNTANT,
  ROLES.RECEPTIONIST,
  ROLES.LIBRARIAN,
  ROLES.STAFF,
  ROLES.STUDENT,
  /*
   * The owner's decision D18: the Super Admin creates Organization Admins. SRS:97 places the role in
   * the hierarchy and leaves its workflows "Not Specified", and nothing created one. It belongs to an
   * organization rather than a school and links to no profile; `users.service.create()` refuses it to
   * anyone but a platform caller.
   */
  ROLES.ORGANIZATION_ADMIN,
]);

/** The two roles a login is created for without a profile — and so with a name of their own. */
const PROFILELESS_ROLES = Object.freeze([ROLES.SCHOOL_ADMIN, ROLES.ORGANIZATION_ADMIN]);

/**
 * The username character class.
 *
 * Lowercase-only, and lowercased on the way in, because `authService.findByIdentifier()` lowercases
 * whatever a caller types before matching it against both the email and username columns. A username
 * stored with capitals is a username whose stored form disagrees with every lookup ever made for it.
 */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * A permission key as the §29 `permissions` table stores it: `<module>.<action>`, with optional
 * middle segments (`students.self.view`, `attendance.teacher.mark`).
 *
 * Shape-checked here, existence checked in the service. Listing all 109 keys in a `.valid()` would
 * produce a validation message longer than the response body, and the service can name the unknown
 * keys individually — which is the message an administrator can act on.
 */
const PERMISSION_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

const permissionKeyList = Joi.array()
  .items(Joi.string().trim().max(120).pattern(PERMISSION_KEY_PATTERN))
  .max(200)
  .unique()
  .messages({
    /* No literal quotes around `{#label}` — Joi renders the label already quoted, so adding a pair
     * here produces `""extra_permissions[0]"" must be…` in the response. */
    'string.pattern.base': '{#label} must be a permission key in the form module.action',
    'array.unique': 'The same permission key was listed twice',
  });

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

  /** FR-AUTH-007 — the account status this screen's actors control. */
  status: Joi.string().valid(...Object.values(USER_STATUS)),

  /** BCP 47-ish, matching the 10-character column. Not an SRS field; the column exists. */
  locale: Joi.string().trim().max(10).empty('').allow(null),
};

/*
 * `.min(1)` for the same reason `organizations.validation` gives: an empty PATCH is a client defect,
 * not a no-op to absorb. It would write an audit row's worth of nothing and answer 200, hiding a
 * broken form.
 */
const update = Joi.object({
  name: fields.name,
  email: email.optional(),
  username: fields.username,
  phone: fields.phone,
  status: fields.status,
  locale: fields.locale,
})
  .min(1)
  .messages({ 'object.min': 'Provide at least one field to update' });

/**
 * `POST /users` — a login for someone the school already has on record (D1).
 *
 * `profile_id` names the teacher, staff member or student the login is for; it is refused for a School
 * Admin, who has no profile. `name` defaults to the profile's own name, so it is required only for a
 * School Admin. `password` is the temporary one: the account is created with `must_change_password`,
 * as a Parent's is, and the same shared policy governs it. The tenancy comes from the school — a body
 * `school_id` is how a platform caller names it, and a school caller's own is used regardless.
 */
const create = Joi.object({
  role: Joi.string()
    .valid(...CREATABLE_ROLES)
    .required()
    .messages({
      'any.only': `"role" must be one of ${CREATABLE_ROLES.join(', ')} — a Principal is created by the Super Admin and a Parent with their profile`,
    }),
  school_id: Joi.number().integer().min(1).when('role', {
    is: ROLES.ORGANIZATION_ADMIN,
    then: Joi.forbidden().messages({ 'any.unknown': 'An Organization Admin belongs to an organization, not a school' }),
  }),
  /* D18 — the organization an Organization Admin administers; meaningless for any other role. */
  organization_id: Joi.number().integer().min(1).when('role', {
    is: ROLES.ORGANIZATION_ADMIN,
    then: Joi.required().messages({ 'any.required': '"organization_id" names the organization this admin administers' }),
    otherwise: Joi.forbidden(),
  }),
  profile_id: Joi.number()
    .integer()
    .min(1)
    .when('role', {
      is: Joi.valid(...PROFILELESS_ROLES),
      then: Joi.forbidden().messages({ 'any.unknown': 'A School Admin or Organization Admin login is not linked to a profile' }),
      otherwise: Joi.required().messages({
        'any.required': '"profile_id" names the teacher, staff member or student this login is for',
      }),
    }),
  name: fields.name.when('role', { is: Joi.valid(...PROFILELESS_ROLES), then: Joi.required() }),
  email: email.required(),
  username: fields.username.required(),
  phone: fields.phone,
  password: newPassword,
  reason: Joi.string().trim().max(255).empty('').allow(null),
});

/**
 * The §33 Users list.
 *
 * `role` is the §5 slug rather than a `role_id`, because the screen's filter is a role name and an id
 * would make the query depend on seeding order. `school_id` and `organization_id` narrow a Super
 * Admin's view; for a school-scoped caller they are redundant — `tenantWhere()` has already pinned
 * the scope — and a request for someone else's tenant comes back empty rather than widening it.
 */
const list = listQuery(
  Joi.object({
    role: Joi.string().valid(...ROLE_LIST),
    status: fields.status,
    school_id: commonSchemas.id,
    organization_id: commonSchemas.id,
  })
);

/**
 * Per-user permission overrides — the `users.extra_permissions` / `users.denied_permissions` columns.
 *
 * A full replacement (PUT), not a patch: the columns are JSON arrays, and "add this one key" over a
 * concurrent edit is how two administrators silently overwrite each other. Sending the whole set makes
 * the last write obviously the last write.
 *
 * Both keys are optional so a caller can clear one side by sending `[]` and leave the other alone;
 * `.min(1)` keeps a body with neither from writing an audit row for nothing.
 */
const setPermissions = Joi.object({
  extra_permissions: permissionKeyList,
  denied_permissions: permissionKeyList,
})
  .min(1)
  .messages({
    'object.min': 'Provide extra_permissions, denied_permissions, or both',
  });

module.exports = {
  schemas: {
    create,
    update,
    list,
    setPermissions,
    idParam: commonSchemas.idParam,
  },
  CREATABLE_ROLES,
  USERNAME_PATTERN,
  PERMISSION_KEY_PATTERN,
};
