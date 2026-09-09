'use strict';

/**
 * Central error handling — SRS §26 FR-LOG-001 (error logs) and §24 FR-SEC-005 (API security).
 *
 * Every failure in the application leaves through here, which buys three things:
 *
 *   - One response shape. `ApiResponse` defines the success envelope; this file defines the
 *     failure envelope, so a client parses `{ success: false, error: { code, message } }` no
 *     matter which layer failed.
 *   - One place that decides what a client may see. Framework and driver errors carry SQL text,
 *     bound parameters, table and index names, and file-system paths. None of that is useful to
 *     a caller and all of it helps an attacker map the system, so untranslated errors become a
 *     flat 500 and the detail goes to the log instead.
 *   - One place that logs. 5xx is logged at `error` with the stack; 4xx at `warn` without one,
 *     because a client sending a bad payload is not a server fault and stacks for those bury
 *     the real failures.
 *
 * The `requestId` is echoed in the body so a user reporting "I got an error" gives a token that
 * locates the exact log line.
 */

const { ValidationError: JoiValidationError } = require('joi');
const { MulterError } = require('multer');
const jwt = require('jsonwebtoken');
const Sequelize = require('sequelize');

const config = require('../config/env');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');

/** Field-level detail for a Sequelize model validation failure. */
function sequelizeValidationDetails(err) {
  return (err.errors || []).map((item) => ({
    field: item.path,
    message: item.message,
    type: item.validatorKey || item.type,
    /*
     * `item.value` is deliberately omitted. A validation failure on `password` or on a token
     * column would otherwise echo the secret back to the caller and into the log.
     */
  }));
}

/** Column names involved in a constraint violation, without the table or index name. */
function constraintFields(err) {
  if (Array.isArray(err.fields)) return err.fields;
  if (err.fields && typeof err.fields === 'object') return Object.keys(err.fields);
  return (err.errors || []).map((item) => item.path).filter(Boolean);
}

/**
 * Translate any thrown value into an ApiError.
 *
 * Anything not recognised here becomes a non-exposed 500: the safe default is to say nothing,
 * because a new error type appearing in a dependency should not start leaking its internals.
 */
function normalize(err) {
  if (err instanceof ApiError) return err;

  /* ---- Validation ------------------------------------------------------------------ */

  /*
   * Joi normally surfaces through the `validate` middleware, which formats its own details.
   * This branch catches a schema validated by hand inside a service.
   */
  if (err instanceof JoiValidationError) {
    return ApiError.validation(
      'Validation failed',
      err.details.map((d) => ({ field: d.path.join('.'), message: d.message, type: d.type }))
    );
  }

  /* ---- Database -------------------------------------------------------------------- */

  /*
   * UniqueConstraintError extends ValidationError in Sequelize, so it must be tested first or
   * a duplicate key would be reported as a 422 instead of a 409.
   */
  if (err instanceof Sequelize.UniqueConstraintError) {
    const fields = constraintFields(err);
    return ApiError.conflict(
      fields.length
        ? `A record with the same ${fields.join(', ')} already exists.`
        : 'A record with the same unique value already exists.',
      { code: 'DUPLICATE_RECORD', details: { fields } }
    );
  }

  if (err instanceof Sequelize.ValidationError) {
    return ApiError.validation('Validation failed', sequelizeValidationDetails(err));
  }

  if (err instanceof Sequelize.ForeignKeyConstraintError) {
    /*
     * Two very different situations produce this: referencing a row that does not exist, and
     * deleting a row that is still referenced. The driver does not reliably distinguish them,
     * so the message covers both rather than asserting the wrong one.
     */
    return ApiError.conflict(
      'The request references a record that does not exist, or a record that is still in use.',
      { code: 'FOREIGN_KEY_VIOLATION', details: { fields: constraintFields(err) } }
    );
  }

  if (err instanceof Sequelize.EmptyResultError) {
    return ApiError.notFound();
  }

  if (err instanceof Sequelize.OptimisticLockError) {
    return ApiError.conflict('The record changed while you were editing it. Reload and retry.', {
      code: 'STALE_RECORD',
    });
  }

  if (err instanceof Sequelize.TimeoutError) {
    return new ApiError(503, 'The database did not respond in time. Please retry.', {
      code: 'DATABASE_TIMEOUT',
      expose: true,
    });
  }

  if (err instanceof Sequelize.ConnectionError) {
    return new ApiError(503, 'The service is temporarily unavailable. Please retry.', {
      code: 'DATABASE_UNAVAILABLE',
      expose: true,
    });
  }

  if (err instanceof Sequelize.DatabaseError) {
    /*
     * Carries `sql` and `parameters`. A syntax error, an unknown column or a deadlock is a
     * defect on our side, so the caller gets a plain 500 and the query goes to the log only.
     */
    return ApiError.internal();
  }

  /* ---- Authentication -------------------------------------------------------------- */

  if (err instanceof jwt.TokenExpiredError) {
    return ApiError.unauthenticated('Your session has expired. Please sign in again.', {
      code: 'TOKEN_EXPIRED',
    });
  }

  if (err instanceof jwt.NotBeforeError || err instanceof jwt.JsonWebTokenError) {
    return ApiError.unauthenticated('Invalid authentication token.', { code: 'TOKEN_INVALID' });
  }

  /* ---- Uploads --------------------------------------------------------------------- */

  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return new ApiError(413, 'The uploaded file is larger than the allowed size.', {
        code: 'FILE_TOO_LARGE',
        details: { field: err.field },
      });
    }
    return ApiError.badRequest('The file upload could not be processed.', {
      code: `UPLOAD_${err.code}`,
      details: { field: err.field },
    });
  }

  /* ---- Request body ---------------------------------------------------------------- */

  /*
   * body-parser throws http-errors with a `type`. `entity.parse.failed` is malformed JSON;
   * `entity.too.large` is a body over the configured limit. Both are the client's doing.
   */
  if (err.type === 'entity.parse.failed') {
    return ApiError.badRequest('The request body is not valid JSON.', { code: 'MALFORMED_JSON' });
  }

  if (err.type === 'entity.too.large') {
    return new ApiError(413, 'The request body is larger than the allowed size.', {
      code: 'PAYLOAD_TOO_LARGE',
    });
  }

  if (err.type === 'charset.unsupported' || err.type === 'encoding.unsupported') {
    return ApiError.badRequest('The request encoding is not supported.', {
      code: 'UNSUPPORTED_ENCODING',
    });
  }

  /* ---- Anything else --------------------------------------------------------------- */

  /*
   * A 4xx `status` set by a middleware that does not use ApiError (cors, http-errors) is
   * honoured, but its message is only exposed for client errors.
   */
  const status = Number(err.statusCode || err.status);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return new ApiError(status, err.message || ApiError.defaultCode(status), { expose: true });
  }

  return ApiError.internal();
}

/**
 * 404 for an unmatched route.
 *
 * Mounted after all routers so a typo in a client's URL returns the standard envelope instead
 * of Express's HTML error page.
 */
function notFoundHandler(req, res, next) {
  next(
    ApiError.notFound(`No route matches ${req.method} ${req.originalUrl}`, {
      code: 'ROUTE_NOT_FOUND',
    })
  );
}

/* eslint-disable no-unused-vars */
/** Express identifies an error handler by its four-parameter signature; `next` must stay. */
function errorHandler(err, req, res, next) {
  /* eslint-enable no-unused-vars */
  const apiError = normalize(err);

  /*
   * If the response has already begun streaming, no envelope can be written. Handing back to
   * Express lets it destroy the socket, which is the only correct outcome left.
   */
  if (res.headersSent) {
    logger.error('Error after response started', {
      requestId: req.id,
      message: err.message,
      stack: err.stack,
    });
    return next(err);
  }

  const context = {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    statusCode: apiError.statusCode,
    code: apiError.code,
    userId: req.user ? req.user.id : null,
    schoolId: req.tenant ? req.tenant.schoolId : null,
    ip: req.ip,
  };

  if (apiError.statusCode >= 500) {
    /*
     * `sql` is logged because a database error is undiagnosable without it. `parameters` is not:
     * an INSERT into `users` binds the bcrypt hash, and a log file is a weaker place to keep it
     * than the column it came from.
     */
    logger.error(err.message || 'Unhandled error', {
      ...context,
      errorName: err.name,
      stack: err.stack,
      sql: err.sql,
    });
  } else {
    logger.warn(apiError.message, { ...context, errorName: err.name });
  }

  const body = {
    success: false,
    error: {
      code: apiError.code,
      message: apiError.expose ? apiError.message : 'Internal server error',
    },
  };

  if (apiError.expose && apiError.details !== undefined) body.error.details = apiError.details;
  if (req.id) body.error.requestId = req.id;

  /*
   * The stack is attached outside production only. It is the single most useful thing during
   * development and the single most dangerous thing to ship.
   */
  if (!config.isProduction && apiError.statusCode >= 500) body.error.stack = err.stack;

  return res.status(apiError.statusCode).json(body);
}

module.exports = { errorHandler, notFoundHandler, normalize };
