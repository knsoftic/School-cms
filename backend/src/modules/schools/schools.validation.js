'use strict';

/**
 * School request schemas — SRS §9.2 (FR-SADMIN-002 … FR-SADMIN-008).
 *
 * FR-SADMIN-002 says only *"Super Admin submits school details"* and FR-SADMIN-003 *"submits updated
 * school details"*; neither enumerates the fields. The field set is therefore the `schools` table from
 * SRS §29, which the source fixes and forbids adding to, minus the columns no client may write.
 *
 * ## What the body may not contain, and why
 *
 *  - **`status`** — not on create's sibling `update`. FR-SADMIN-005 gives status its own Activate /
 *    Suspend operation and FR-SADMIN-006 gives archiving another, each behind its own permission
 *    (`schools.status`, `schools.archive`). Accepting `status` in the general edit would let a caller
 *    holding only `schools.manage` suspend a school, routing around both. `status` *is* accepted on
 *    **create**, because a school has to start somewhere and the column is NOT NULL with a default;
 *    only the transition afterwards is a governed operation.
 *  - **`organization_id` on update** — moving a school between organizations is not an operation the
 *    source describes, and it would strand every row that copied the old `organization_id` for tenant
 *    scoping (users, students, invoices, subscriptions all carry it). Accepted on create only.
 *  - **`principal_id`** — FR-SADMIN-007 is a dedicated operation with its own permission, and
 *    FR-SADMIN-009's precondition is that the *school* exists before the Principal does, so there is no
 *    moment at which a principal id could legitimately arrive in a create body.
 *  - **`suspended_at`, `suspension_reason`, `archived_at`** — derived by the status operations below.
 *  - **`subscription_state`** — a cache of the school's active subscription, written by the
 *    subscription module (SRS §10). A client-supplied value would be a lie the dashboards then read.
 *
 * `code` and `website` follow the same normalisation as the organization module — see
 * `organizations.validation.js` for the reasoning, which is not repeated here.
 */

const Joi = require('joi');
const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { SCHOOL_STATUS } = require('../../config/constants');
const { email } = require('../auth/auth.validation');
const { CODE_PATTERN } = require('../organizations/organizations.validation');

const optionalEmail = email.optional().empty('').allow(null);

const fields = {
  organization_id: commonSchemas.id,

  name: Joi.string().trim().min(2).max(180),

  code: Joi.string()
    .trim()
    .uppercase()
    .min(2)
    .max(40)
    .pattern(CODE_PATTERN)
    .messages({
      'string.pattern.base':
        '"code" must start with a letter or digit and may contain only letters, digits, hyphens and underscores',
    }),

  email: optionalEmail,
  phone: Joi.string().trim().max(40).empty('').allow(null),
  address: Joi.string().trim().max(255).empty('').allow(null),
  city: Joi.string().trim().max(90).empty('').allow(null),
  state: Joi.string().trim().max(90).empty('').allow(null),
  country: Joi.string().trim().max(90).empty('').allow(null),

  status: Joi.string().valid(...Object.values(SCHOOL_STATUS)),

  /* Stored in `schools.suspension_reason` when suspending; kept only in the audit row when archiving,
   * because SRS §29 gives `schools` no archive-reason column and none may be added. */
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const create = Joi.object({
  organization_id: fields.organization_id.required(),
  name: fields.name.required(),
  code: fields.code.required(),
  email: fields.email,
  phone: fields.phone,
  address: fields.address,
  city: fields.city,
  state: fields.state,
  country: fields.country,
  status: fields.status,
});

const update = Joi.object({
  name: fields.name,
  code: fields.code,
  email: fields.email,
  phone: fields.phone,
  address: fields.address,
  city: fields.city,
  state: fields.state,
  country: fields.country,
})
  .min(1)
  .messages({ 'object.min': 'Provide at least one field to update' });

/** FR-SADMIN-005 — Suspend. A reason is optional; the column is nullable. */
const suspend = Joi.object({ reason: fields.reason });

/** FR-SADMIN-006 — Archive. The reason lands in `audit_logs.reason`, which exists for exactly this. */
const archive = Joi.object({ reason: fields.reason });

/*
 * FR-SADMIN-005 — Activate takes nothing. Declared as an empty object rather than omitted so that
 * `stripUnknown` removes a stray body instead of the route silently accepting fields it ignores.
 */
const activate = Joi.object({});

/** FR-SADMIN-007 — the Principal to link. Validated as a reference; the rules are in the service. */
const assignPrincipal = Joi.object({ user_id: commonSchemas.id.required() });

const list = listQuery(
  Joi.object({
    status: fields.status,
    organization_id: fields.organization_id,
  })
);

module.exports = {
  schemas: {
    create,
    update,
    suspend,
    archive,
    activate,
    assignPrincipal,
    list,
    idParam: commonSchemas.idParam,
  },
};
