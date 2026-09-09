'use strict';

/**
 * School settings schemas — SRS §14.1, FR-SCHOOL-001.
 *
 * The ten named fields are columns on `school_settings`. `logo_path` / `favicon_path` are **absolute
 * http(s) URLs**, not a seventh upload profile: §14.1 lists Logo and Favicon beside Name, Address,
 * Phone, Email, Website, Theme, Currency and Timezone — configuration a school sets, not a capture
 * step — and inventing a profile would break the six-surface allow-list Known Issue #14 recorded.
 *
 * ## Known Issues #26 — why a URL rather than a free string
 *
 * Both columns used to be `Joi.string().max(255)`, so a caller could store `../../../etc/passwd`. The
 * column names say `path`, and §35 forbids renaming a column, so the name and the accepted value will
 * disagree permanently — that is stated here rather than left for a reader to trip over.
 *
 * The check **normalises** rather than pattern-matches, because a pattern is not enough. Measured:
 * `Joi.uri({ scheme: ['http','https'] })` accepts `https://a.test/../../../etc/passwd`, and
 * `path.join(uploadsRoot, that)` resolves **outside** the root. A `.pattern(/\.\./, { invert: true })`
 * guard also rejects a legitimate `https://cdn/logo..png` and still admits `%2e%2e`. Parsing with
 * `new URL()` collapses `..`, decodes `%2e%2e`, leaves a `logo..png` filename intact, and yields a
 * normalised `href` — which is what gets stored, so the value checked is the value written. That is
 * the `.precision(2)` doctrine `finance` and `plans` record, applied to a URL.
 *
 * `organization_id` and `id` are refused. `school_id` is accepted so a platform caller can name
 * the school; a school-scoped caller that sends a different one is refused by `enforceTenant`
 * (`CROSS_TENANT_ACCESS_DENIED`) before this module runs, and `resolveSchool()` repeats the
 * check as `CROSS_SCHOOL_ACCESS` if a request ever reached the service without that body field.
 */

const Joi = require('joi');

const { commonSchemas } = require('../../middlewares/validate');

const forbiddenField = (because) => Joi.any().forbidden().messages({ 'any.unknown': because });

/** The column is `STRING(255)`; the normalised href is what has to fit, not the submitted string. */
const BRANDING_MAX = 255;

/**
 * An absolute http(s) URL, stored normalised — SRS §14.1 Logo / Favicon, Known Issues #26.
 *
 * `new URL()` does the work a pattern cannot: it collapses `..` segments and decodes percent-encoded
 * ones, so nothing that survives can be used as a relative filesystem path. A relative path, an
 * absolute filesystem path, and a `javascript:` or `file:` scheme all fail to parse or fail the scheme
 * check.
 */
const brandingUrl = (column) =>
  Joi.string()
    .trim()
    .empty('')
    .allow(null)
    .custom((value, helpers) => {
      let url;
      try {
        url = new URL(value);
      } catch {
        return helpers.error('any.invalid');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return helpers.error('any.invalid');
      /* Measured on the normalised form, which is what the column receives. */
      if (url.href.length > BRANDING_MAX) return helpers.error('string.max', { limit: BRANDING_MAX });
      return url.href;
    }, 'absolute http(s) URL')
    .messages({
      'any.invalid': `"${column}" must be an absolute http(s) URL — a filesystem path is never accepted from a request body (Known Issues #26)`,
      'string.max': `"${column}" must be at most ${BRANDING_MAX} characters once normalised`,
    });

const fields = {
  school_id: Joi.number().integer().min(1),
  name: Joi.string().trim().min(1).max(180).empty('').allow(null),
  address: Joi.string().trim().max(255).empty('').allow(null),
  phone: Joi.string().trim().max(40).empty('').allow(null),
  email: Joi.string()
    .trim()
    .lowercase()
    .email({ tlds: { allow: false } })
    .max(180)
    .empty('')
    .allow(null),
  website: Joi.string().trim().max(180).empty('').allow(null),
  logo_path: brandingUrl('logo_path'),
  favicon_path: brandingUrl('favicon_path'),
  theme: Joi.string().trim().max(40),
  theme_config: Joi.object().unknown(true).allow(null),
  currency: Joi.string().trim().uppercase().max(10),
  timezone: Joi.string().trim().max(64),
  preferences: Joi.object().unknown(true).allow(null),
  reason: Joi.string().trim().max(255).empty('').allow(null),
};

const update = Joi.object({
  school_id: fields.school_id,
  name: fields.name,
  address: fields.address,
  phone: fields.phone,
  email: fields.email,
  website: fields.website,
  logo_path: fields.logo_path,
  favicon_path: fields.favicon_path,
  theme: fields.theme,
  theme_config: fields.theme_config,
  currency: fields.currency,
  timezone: fields.timezone,
  preferences: fields.preferences,
  reason: fields.reason,
  id: forbiddenField('"id" is allocated by the system'),
  organization_id: forbiddenField('"organization_id" is taken from the school row'),
}).min(1);

const showQuery = Joi.object({
  school_id: fields.school_id,
});

module.exports = {
  schemas: {
    update,
    showQuery,
    idParam: commonSchemas.idParam,
  },
  fields,
};
