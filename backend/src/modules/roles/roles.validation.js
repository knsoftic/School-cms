'use strict';

/**
 * Role and role-permission schemas.
 *
 * ## What the source supports
 *
 * SRS §29 fixes `roles`, `permissions` and `role_permissions` as three of the sixty-four tables, and
 * FR-AUTH-008 / FR-AUTH-009 require role and permission middleware to check a request against granted
 * permissions. Data that middleware reads has to be settable, so a role's grant set is editable here.
 *
 * §33 does **not** list a "Roles & Permissions" screen — the Super Admin list is Dashboard,
 * Organizations, Schools, Principals, Users, Plans, Modules, Features, Limits, Add-ons, Subscriptions,
 * Invoices, Payments, Coupons, Reports, Settings, and nothing else. Seven docblock passages elsewhere in
 * this codebase cited one, across `services/permissionService.js`, `config/permissions.js`,
 * `middlewares/authorize.js` and `database/seeders/03-role-permissions.js`; all seven have been
 * corrected to cite §29 and FR-AUTH-009 instead. The capability stands on those two, not on a screen the
 * source never named.
 *
 * A grep of the source for `roles &`, `role management`, `manage roles`, `role builder`, `assign role`
 * and `custom role` returns nothing, so this module deliberately claims no more than the data model and
 * the two FRs give it.
 *
 * ## No create, and no delete
 *
 * SRS §5 opens with *"The system defines exactly the following eleven roles"*, and `roles.slug` carries
 * `validate: { isIn: [ROLE_LIST] }` so the model would refuse a twelfth anyway. §35 names "Additional
 * roles" as the first thing not to invent. So a role's *grants* are editable and the role list is not:
 * there is no `POST /roles` and no `DELETE /roles/:id`.
 *
 * Nor are `slug`, `is_platform_role`, `is_school_role` or `is_system` editable. `slug` is the value
 * `ROLES` in `config/constants.js` matches against and `principals.service` resolves by; the two
 * booleans are what `resolveTenant` reads to decide whether an account needs a `school_id`. All four are
 * structural facts about §5's eleven, not settings. `name` and `description` are labels and are editable.
 */

const Joi = require('joi');
const { commonSchemas } = require('../../middlewares/validate');
const { PERMISSION_KEY_PATTERN } = require('../users/users.validation');

/**
 * The complete grant set for one role.
 *
 * `permissions: []` is legal and means exactly what it says — a role with nothing granted. It has to be
 * expressible: a replacement API where the empty case is rejected cannot revoke the last permission.
 */
const setPermissions = Joi.object({
  permissions: Joi.array()
    .items(Joi.string().trim().max(120).pattern(PERMISSION_KEY_PATTERN))
    .max(400)
    .unique()
    .required()
    .messages({
      /* Unquoted `{#label}` — see the note on the same message in `users.validation.js`. */
      'string.pattern.base': '{#label} must be a permission key in the form module.action',
      'array.unique': 'The same permission key was listed twice',
      'any.required': 'Send the complete permission set for this role, including an empty array to revoke all',
    }),
});

/** Labels only — see the header for why the four structural columns are absent. */
const update = Joi.object({
  name: Joi.string().trim().min(2).max(120),
  description: Joi.string().trim().max(255).empty('').allow(null),
})
  .min(1)
  .messages({ 'object.min': 'Provide at least one field to update' });

module.exports = {
  schemas: {
    update,
    setPermissions,
    idParam: commonSchemas.idParam,
  },
};
