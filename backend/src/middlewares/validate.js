'use strict';

/**
 * Request validation — SRS Working Method step 4 ("Validation & Constraints") and §24 FR-SEC-005.
 *
 * A route declares Joi schemas per container and this middleware enforces them *before* the
 * controller runs, so a controller never re-checks types and a service never receives a string
 * where it expected a number.
 *
 * Three properties of the configuration below are load-bearing rather than stylistic:
 *
 *   - `stripUnknown` on body and query. This is the mass-assignment defence: a client that POSTs
 *     `{ name: "…", role_id: 1, school_id: 9 }` to an endpoint whose schema names only `name`
 *     has the extra keys removed here, so they cannot reach `Model.create(req.body)` even if a
 *     controller passes the body straight through. `enforceTenant` catches a hostile `school_id`
 *     as well; this removes the whole class rather than that one field.
 *   - `abortEarly: false`. A form with four bad fields returns four errors, not the first one,
 *     which is what SRS §33's inline field validation needs.
 *   - `convert: true`. Query strings and route params are always strings; `?page=2` has to reach
 *     the controller as the number 2, and `?active=true` as a boolean.
 *
 * Errors carry `location` so the frontend can bind body errors to form fields and surface
 * query/param errors separately, instead of guessing from a dotted path.
 */

const { annotate } = require('../utils/routeMeta');
const Joi = require('joi');

const ApiError = require('../utils/ApiError');
const { PAGINATION } = require('../config/constants');

/** Containers validated in this order, so the response lists errors predictably. */
const CONTAINERS = ['params', 'query', 'body', 'headers'];

const BASE_OPTIONS = {
  abortEarly: false,
  convert: true,
  errors: { wrap: { label: false } },
};

/**
 * Per-container Joi options.
 *
 * `headers` is deliberately different: it always carries dozens of keys we do not model, and
 * stripping them would delete the very headers Express and the logger depend on. It is also
 * never reassigned back onto the request for the same reason.
 */
const CONTAINER_OPTIONS = {
  params: { ...BASE_OPTIONS, stripUnknown: true },
  query: { ...BASE_OPTIONS, stripUnknown: true },
  body: { ...BASE_OPTIONS, stripUnknown: true },
  headers: { ...BASE_OPTIONS, allowUnknown: true, stripUnknown: false },
};

/**
 * Build the middleware.
 *
 * @param {{body?: Joi.Schema, query?: Joi.Schema, params?: Joi.Schema, headers?: Joi.Schema}} schemas
 * @returns {import('express').RequestHandler}
 */
function validate(schemas = {}) {
  /*
   * Both guards fire at require-time, so a wiring mistake stops the boot instead of silently
   * validating nothing in production. The unknown-container check is first because a typo —
   * `validate({ bodys: schema })` — satisfies neither guard, and "unsupported container: bodys"
   * names the actual mistake where "requires at least one of…" would send the reader hunting.
   */
  const unknown = Object.keys(schemas).filter((key) => !CONTAINERS.includes(key));
  if (unknown.length) {
    throw new Error(`validate() received unsupported container(s): ${unknown.join(', ')}`);
  }

  const active = CONTAINERS.filter((container) => schemas[container]);
  if (!active.length) {
    throw new Error('validate() requires at least one of: body, query, params, headers');
  }

  const documented = function validateRequest(req, res, next) {
    const details = [];
    const validated = {};

    for (const container of active) {
      const { value, error } = schemas[container].validate(
        req[container] === undefined ? {} : req[container],
        CONTAINER_OPTIONS[container]
      );

      if (error) {
        for (const item of error.details) {
          details.push({
            field: item.path.join('.'),
            location: container,
            message: item.message,
            type: item.type,
          });
        }
      } else {
        validated[container] = value;
      }
    }

    if (details.length) return next(ApiError.validation('Validation failed', details));

    /*
     * Only assigned once every container passed, so a handler can never observe a half-validated
     * request. `headers` is excluded — see CONTAINER_OPTIONS.
     */
    for (const container of Object.keys(validated)) {
      if (container !== 'headers') req[container] = validated[container];
    }

    return next();
  };

  /* The Joi schemas this validator was built from. See utils/routeMeta.js. */
  return annotate(documented, { schemas, containers: active });
}

/*
 * Shared fragments.
 *
 * These live beside the middleware rather than in a module's `*.validation.js` because they are
 * not any one module's rules: `pagination` has to agree with `utils/pagination.js`'s clamping, and
 * duplicating the numbers per module is how the two drift apart.
 */

/** A database primary key as it arrives from a URL or a body. */
const id = Joi.number().integer().positive();

const commonSchemas = {
  id,

  /** `/:id` — the shape used by every show/update/destroy route. */
  idParam: Joi.object({ id: id.required() }),

  /**
   * `?page=&limit=&sortBy=&sortOrder=`.
   *
   * `limit` is capped at the same MAX_LIMIT `getPagination()` clamps to, so an over-limit request
   * is rejected with an explanation instead of being silently reduced.
   *
   * `sortBy` is only shape-checked here. The column allow-list belongs to the route, because only
   * the route knows which columns exist — see `getSort(req, allowed)`.
   */
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(PAGINATION.DEFAULT_PAGE),
    limit: Joi.number()
      .integer()
      .min(1)
      .max(PAGINATION.MAX_LIMIT)
      .default(PAGINATION.DEFAULT_LIMIT),
    sortBy: Joi.string().max(64).pattern(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/),
    sortOrder: Joi.string().valid('asc', 'desc', 'ASC', 'DESC'),
  }),

  /** Free-text list filter. Bounded so it cannot be used to build a huge LIKE pattern. */
  search: Joi.object({ q: Joi.string().trim().allow('').max(120) }),

  /**
   * `?from=&to=` for the report and attendance ranges.
   *
   * The ordering rule is conditional, and it was not. `to: Joi.date().iso().min(Joi.ref('from'))`
   * reads as "no earlier than `from`", but when `from` is absent Joi cannot resolve the reference and
   * **errors instead of skipping the rule** — so `?to=2025-12-31` on its own was a 422 saying
   * *"to date references ref:from which must have a valid date"*. Every endpoint sharing this schema
   * was unable to express "everything up to a date", which is an ordinary thing to ask a report for.
   *
   * `.when()` applies the comparison only when there is something to compare against. A range given
   * backwards is still refused — that assertion is unchanged.
   */
  dateRange: Joi.object({
    from: Joi.date().iso(),
    to: Joi.date().iso().when('from', {
      is: Joi.exist(),
      then: Joi.date().iso().min(Joi.ref('from')),
    }),
  }),
};

/**
 * Merge shared fragments into one query schema.
 *
 * `validate({ query: listQuery(mySchema) })` keeps a route from having to re-declare page/limit
 * every time, which is what makes `stripUnknown` safe to leave on for query strings.
 */
function listQuery(...schemas) {
  return schemas.reduce(
    (acc, schema) => acc.concat(schema),
    commonSchemas.pagination.concat(commonSchemas.search)
  );
}

module.exports = { validate, commonSchemas, listQuery, CONTAINERS };
