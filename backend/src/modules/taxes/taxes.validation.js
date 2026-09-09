'use strict';

/**
 * Tax request schemas — SRS §33 *"Taxes"*, §13.1's invoice **Tax** field.
 *
 * Every field below is a column in `models/billing.js`'s `Tax` model and nothing else is accepted.
 * The source states no tax rules at all beyond naming the capability, so the schema's job here is
 * narrow: keep the column constraints out of the driver and into a 422 that names the field.
 *
 * ## `rate_percent` is `DECIMAL(7, 4)` and that shapes the validator
 *
 * Four decimal places, so 8.8750% is expressible — real rates are not always whole numbers. Seven
 * significant digits with four after the point leaves three before it, so the column's own ceiling is
 * 999.9999. The schema caps at **100** instead: a tax rate above 100% is not a rate this system can
 * price coherently — `quoteFor()`'s inclusive branch divides by `1 + rate/100`, which stays sane, but
 * an exclusive 200% tax on an invoice is far more likely to be a typo (200 meant as 2.00) than an
 * intent. An operator who genuinely needs it is refused with a message, which is recoverable; an
 * operator who fat-fingered it and was not refused bills every school three times over.
 *
 * ## `code` is uppercased here, not in the service
 *
 * `unique` on the column is case-sensitive under the project's collation for the purposes anyone
 * cares about, so `VAT` and `vat` would be two rows meaning one thing. Normalising at the edge makes
 * the uniqueness check in `taxes.service.create()` compare like with like.
 */

const Joi = require('joi');

const { commonSchemas, listQuery } = require('../../middlewares/validate');

/** Uppercase letters, digits, dash and underscore — the shape a tax code is written in. */
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;

const fields = {
  name: Joi.string().trim().min(2).max(120),

  code: Joi.string().trim().uppercase().min(2).max(40).pattern(CODE_PATTERN).messages({
    'string.pattern.base':
      '"code" may contain uppercase letters, digits, dashes and underscores only',
  }),

  /* See the header on why the ceiling is 100 and not the column's 999.9999. */
  rate_percent: Joi.number().min(0).max(100).precision(4).messages({
    'number.max': '"rate_percent" may not exceed 100 — a rate above 100% is almost always a typo',
  }),

  is_inclusive: Joi.boolean(),
  is_active: Joi.boolean(),
  is_default: Joi.boolean(),

  country: Joi.string().trim().max(90).empty('').allow(null),
  state: Joi.string().trim().max(90).empty('').allow(null),
  description: Joi.string().trim().max(255).empty('').allow(null),
};

/**
 * Create a tax rate.
 *
 * `name`, `code` and `rate_percent` are required because all three are `allowNull: false` in the
 * model and `rate_percent` defaults to 0 — a rate row that silently means "0%" is indistinguishable
 * from a misconfigured one, so the number is stated rather than defaulted.
 */
const create = Joi.object({
  name: fields.name.required(),
  code: fields.code.required(),
  rate_percent: fields.rate_percent.required(),
  is_inclusive: fields.is_inclusive.default(false),
  is_active: fields.is_active.default(true),
  is_default: fields.is_default.default(false),
  country: fields.country,
  state: fields.state,
  description: fields.description,
});

/**
 * Edit a tax rate.
 *
 * `rate_percent` is editable — `taxes.service.update()` states why that is safe, and it comes down to
 * `invoices.tax_rate_percent` being a copy rather than a join.
 */
const update = Joi.object({
  name: fields.name,
  code: fields.code,
  rate_percent: fields.rate_percent,
  is_inclusive: fields.is_inclusive,
  is_active: fields.is_active,
  is_default: fields.is_default,
  country: fields.country,
  state: fields.state,
  description: fields.description,
})
  .min(1)
  .messages({ 'object.min': 'Provide at least one field to update' });

/**
 * `POST /taxes/:id/default` and `POST /taxes/default/clear` both land here.
 *
 * Empty by design: the target is the path parameter, and a body would be a second place to say the
 * same thing.
 */
const setDefault = Joi.object({});

const list = listQuery(
  Joi.object({
    is_active: Joi.boolean(),
    is_inclusive: Joi.boolean(),
    is_default: Joi.boolean(),
    country: Joi.string().trim().max(90),
    state: Joi.string().trim().max(90),
  })
);

module.exports = {
  schemas: {
    create,
    update,
    setDefault,
    list,
    idParam: commonSchemas.idParam,
  },
  fields,
  CODE_PATTERN,
};
