'use strict';

/**
 * Organization request schemas.
 *
 * SRS §5 puts the organization at the top of the tenant hierarchy and §33 lists "Organizations" as a
 * Super Admin MVP screen, but the functional requirements never enumerate an organization's fields.
 * FR-SADMIN-002 only states the precondition: *"Organization exists (per system hierarchy)"*. So the
 * field set here is taken from the `organizations` table in SRS §29 — which is fixed by the source and
 * is therefore the nearest thing to a specification the document offers — and nothing is added to it.
 *
 * ## Two columns are deliberately not accepted from a request body
 *
 *  - `logo_path` — not declared here, so `validate.js`'s `stripUnknown: true` removes it before the
 *    service ever sees it. Accepting it would let a caller point a record at an arbitrary path on disk.
 *
 *    An earlier revision of this comment said the column is "written by the upload middleware". It is
 *    not: nothing in `src/` writes `organizations.logo_path` at all, there is no organization logo
 *    upload route, and no `UPLOAD_RULES` entry for one. The security conclusion held, but for a
 *    different mechanism than the one stated — corrected while closing Known Issues #26, which is
 *    about exactly this class of column. `verify-platform-modules.js` asserts the strip, not a refusal.
 *
 *    §9's source text names no organization logo, so no writer is added here. If one is ever built it
 *    must come from an upload and the column must be `forbidden()` in the body, the way
 *    `students.photo_path` now is.
 *  - `id`, `created_at`, `updated_at`, `deleted_at` — Sequelize's, not the client's.
 *
 * ## Decisions recorded because the source does not specify them
 *
 *  - **`code` is normalised to upper case and restricted to `A-Z 0-9 _ -`.** The source gives no format.
 *    The column carries a unique index, and MariaDB's default collation is case-insensitive, so `acme`
 *    and `ACME` already collide at the index; upper-casing makes the value that is *stored* agree with
 *    the value the index compares. The character class keeps a code usable as an identifier — it ends up
 *    in URLs and reports — rather than accepting spaces and slashes that would have to be escaped
 *    everywhere downstream.
 *  - **`website` must carry an `http`/`https` scheme.** A `website` a front end will render as a link is
 *    a URL, and requiring the scheme rules out the `javascript:` href that `sanitizeRequest` does not
 *    catch (it strips script *text*, not a dangerous URL in an ordinary string field).
 *  - **`status` is editable here.** The column exists, `resolveTenant` already refuses a suspended or
 *    archived organization, and no functional requirement claims a separate activate/suspend workflow
 *    for organizations the way FR-SADMIN-005 does for schools. There is no organization DELETE, for the
 *    same reason in reverse: the source describes no organization-deletion workflow, and `status:
 *    'archived'` covers the need without one.
 */

const Joi = require('joi');
const { commonSchemas, listQuery } = require('../../middlewares/validate');
const { ORGANIZATION_STATUS } = require('../../config/constants');
const { email } = require('../auth/auth.validation');

/**
 * The shared address rule from the auth module, relaxed to optional.
 *
 * `auth.validation.js` exports `email` precisely so that no other module writes `Joi.string().email()`
 * and reintroduces the TLD problem documented there — `superadmin@msms.local` has no public TLD and
 * must still validate. `.empty('')` maps a blank field from a form to "absent" rather than to a
 * validation error, which is what a nullable column means in practice.
 */
const optionalEmail = email.optional().empty('').allow(null);

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;

const fields = {
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

  website: Joi.string()
    .trim()
    .max(180)
    .uri({ scheme: ['http', 'https'] })
    .empty('')
    .allow(null)
    /*
     * `string.uriCustomScheme`, not `string.uri`. Joi raises the former whenever a `scheme` list is
     * supplied — including for a value with no scheme at all — so overriding `string.uri` here would
     * be dead code and the caller would get Joi's default text naming an "http|https pattern".
     */
    .messages({
      'string.uriCustomScheme': '"website" must be a full http:// or https:// address',
    }),

  status: Joi.string().valid(...Object.values(ORGANIZATION_STATUS)),
  notes: Joi.string().trim().max(5000).empty('').allow(null),
};

const create = Joi.object({
  name: fields.name.required(),
  code: fields.code.required(),
  email: fields.email,
  phone: fields.phone,
  address: fields.address,
  website: fields.website,
  status: fields.status,
  notes: fields.notes,
});

/*
 * `.min(1)` because an empty PATCH is a client defect, not a no-op to be absorbed: it would write an
 * audit row's worth of nothing and return 200, hiding a broken form.
 */
const update = Joi.object({
  name: fields.name,
  code: fields.code,
  email: fields.email,
  phone: fields.phone,
  address: fields.address,
  website: fields.website,
  status: fields.status,
  notes: fields.notes,
})
  .min(1)
  .messages({ 'object.min': 'Provide at least one field to update' });

const list = listQuery(
  Joi.object({
    status: fields.status,
  })
);

module.exports = {
  schemas: {
    create,
    update,
    list,
    idParam: commonSchemas.idParam,
  },
  CODE_PATTERN,
};
