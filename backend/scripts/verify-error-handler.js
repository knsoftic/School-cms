'use strict';

/**
 * Exercises `src/middlewares/errorHandler.js` against one instance of every error type it
 * claims to translate, plus the two branches that are easy to get wrong: a subclass that must
 * not be swallowed by its parent, and a 500 whose internals must not reach the client.
 *
 * Run: node scripts/verify-error-handler.js
 */

const Sequelize = require('sequelize');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const { MulterError } = require('multer');

const { errorHandler, notFoundHandler } = require('../src/middlewares/errorHandler');
const ApiError = require('../src/utils/ApiError');

let failures = 0;

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

/** Push an error through the handler and return `{ status, body }`. */
function handle(err, req = {}) {
  const res = mockRes();
  errorHandler(err, { id: 'test-request-id', method: 'POST', originalUrl: '/api/v1/x', ...req }, res, () => {});
  return { status: res.statusCode, body: res.body };
}

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${ok ? '' : `  (expected ${JSON.stringify(expected)})`}`);
}

/* -- ApiError passes through unchanged -------------------------------------------------- */
{
  const r = handle(ApiError.forbidden('Cross-school access denied', { code: 'CROSS_TENANT_ACCESS_DENIED' }));
  check('ApiError status', r.status, 403);
  check('ApiError code', r.body.error.code, 'CROSS_TENANT_ACCESS_DENIED');
  check('ApiError message', r.body.error.message, 'Cross-school access denied');
  check('ApiError requestId echoed', r.body.error.requestId, 'test-request-id');
  check('ApiError success flag', r.body.success, false);
}

/* -- UniqueConstraintError must not be swallowed by ValidationError --------------------- */
{
  const err = new Sequelize.UniqueConstraintError({
    errors: [new Sequelize.ValidationErrorItem('email must be unique', 'unique violation', 'email', 'a@b.com')],
    fields: { email: 'a@b.com' },
  });
  const r = handle(err);
  check('UniqueConstraintError status', r.status, 409);
  check('UniqueConstraintError code', r.body.error.code, 'DUPLICATE_RECORD');
  check('UniqueConstraintError names field', r.body.error.details.fields.join(','), 'email');
  check('UniqueConstraintError hides value', JSON.stringify(r.body).includes('a@b.com'), false);

  /*
   * `details` has **two shapes**, and a client has to survive both.
   *
   * `VALIDATION_ERROR` sends an **array** of `{ field, message, type }` — the per-field form of it.
   * `DUPLICATE_RECORD` here, `FOREIGN_KEY_VIOLATION` below, and the upload errors all send a plain
   * **object** of diagnostic context instead. Both are asserted in this file already, a dozen lines
   * apart, and neither assertion says the other exists.
   *
   * That silence cost something. The web client declared `details: FieldError[]`, guarded it with
   * `?? []` — which does not replace an object, since an object is not nullish — and then ran
   * `for…of` over it in `fieldErrors()`. A duplicate code, the most ordinary create failure there is,
   * threw **"details is not iterable" inside the catch block of every form**.
   *
   * The shapes are not being unified: the object carries context that has no field to attach to, and
   * changing the envelope would be a breaking change for a cosmetic gain. What was missing is this
   * assertion — stating plainly that a consumer must check before it iterates.
   */
  check('a client cannot assume details is an array — this code sends an object',
    Array.isArray(r.body.error.details), false);
}

/* -- Model validation ------------------------------------------------------------------- */
{
  const err = new Sequelize.ValidationError('Validation error', [
    new Sequelize.ValidationErrorItem('Name is required', 'notNull violation', 'name', null),
  ]);
  const r = handle(err);
  check('ValidationError status', r.status, 422);
  check('ValidationError code', r.body.error.code, 'VALIDATION_ERROR');
  check('ValidationError field', r.body.error.details[0].field, 'name');
  check('  and this one sends an array, which is the other half of the same contract',
    Array.isArray(r.body.error.details), true);
}

/* -- Foreign key ------------------------------------------------------------------------ */
{
  const err = new Sequelize.ForeignKeyConstraintError({ fields: ['school_id'], table: 'students', index: 'fk_students_school' });
  const r = handle(err);
  check('ForeignKeyConstraintError status', r.status, 409);
  check('ForeignKeyConstraintError code', r.body.error.code, 'FOREIGN_KEY_VIOLATION');
  check('ForeignKeyConstraintError hides table', JSON.stringify(r.body).includes('students'), false);
  check('ForeignKeyConstraintError hides index', JSON.stringify(r.body).includes('fk_students_school'), false);
}

/* -- Connection / timeout are retryable 503, not 500 ------------------------------------ */
{
  const r = handle(new Sequelize.ConnectionRefusedError(new Error('ECONNREFUSED 127.0.0.1:3306')));
  check('ConnectionError status', r.status, 503);
  check('ConnectionError code', r.body.error.code, 'DATABASE_UNAVAILABLE');
  check('ConnectionError hides host', JSON.stringify(r.body.error.message).includes('3306'), false);
}
{
  const r = handle(new Sequelize.TimeoutError(new Error('Query exceeded timeout')));
  check('TimeoutError status', r.status, 503);
  check('TimeoutError code', r.body.error.code, 'DATABASE_TIMEOUT');
}

/* -- A raw DatabaseError must leak neither SQL nor parameters -------------------------- */
{
  const parent = new Error("Unknown column 'x' in 'field list'");
  parent.sql = 'SELECT `x` FROM `users` WHERE `password_hash` = ?';
  parent.parameters = ['$2b$12$abcdefghijklmnopqrstuv'];
  const r = handle(new Sequelize.DatabaseError(parent));
  check('DatabaseError status', r.status, 500);
  check('DatabaseError generic message', r.body.error.message, 'Internal server error');
  check('DatabaseError hides SQL', JSON.stringify(r.body.error.message).includes('SELECT'), false);
  check('DatabaseError hides bcrypt hash', JSON.stringify(r.body.error.message).includes('$2b$12$'), false);
  check('DatabaseError hides column name', r.body.error.message.includes('Unknown column'), false);
}

/* -- Empty result / optimistic lock ---------------------------------------------------- */
check('EmptyResultError status', handle(new Sequelize.EmptyResultError('none')).status, 404);
check('OptimisticLockError status', handle(new Sequelize.OptimisticLockError({ modelName: 'Student' })).status, 409);
check('OptimisticLockError code', handle(new Sequelize.OptimisticLockError({ modelName: 'Student' })).body.error.code, 'STALE_RECORD');

/* -- JWT ------------------------------------------------------------------------------- */
{
  const expired = jwt.sign({ sub: 1 }, 'secret', { expiresIn: '-1s' });
  let caught;
  try {
    jwt.verify(expired, 'secret');
  } catch (e) {
    caught = e;
  }
  const r = handle(caught);
  check('TokenExpiredError status', r.status, 401);
  check('TokenExpiredError code', r.body.error.code, 'TOKEN_EXPIRED');
}
{
  let caught;
  try {
    jwt.verify('not.a.token', 'secret');
  } catch (e) {
    caught = e;
  }
  const r = handle(caught);
  check('JsonWebTokenError status', r.status, 401);
  check('JsonWebTokenError code', r.body.error.code, 'TOKEN_INVALID');
}

/* -- Joi ------------------------------------------------------------------------------- */
{
  const { error } = Joi.object({ email: Joi.string().email().required() }).validate({ email: 'nope' });
  const r = handle(error);
  check('Joi status', r.status, 422);
  check('Joi field', r.body.error.details[0].field, 'email');
}

/* -- Multer ---------------------------------------------------------------------------- */
check('LIMIT_FILE_SIZE status', handle(new MulterError('LIMIT_FILE_SIZE', 'avatar')).status, 413);
check('LIMIT_FILE_SIZE code', handle(new MulterError('LIMIT_FILE_SIZE', 'avatar')).body.error.code, 'FILE_TOO_LARGE');
check('LIMIT_UNEXPECTED_FILE status', handle(new MulterError('LIMIT_UNEXPECTED_FILE', 'x')).status, 400);

/* -- body-parser ----------------------------------------------------------------------- */
{
  const err = new SyntaxError('Unexpected token } in JSON at position 12');
  err.type = 'entity.parse.failed';
  err.status = 400;
  const r = handle(err);
  check('malformed JSON status', r.status, 400);
  check('malformed JSON code', r.body.error.code, 'MALFORMED_JSON');
}
{
  const err = new Error('request entity too large');
  err.type = 'entity.too.large';
  err.status = 413;
  check('entity.too.large status', handle(err).status, 413);
}

/* -- Unknown errors are opaque --------------------------------------------------------- */
{
  const r = handle(new TypeError("Cannot read properties of undefined (reading 'schoolId')"));
  check('unknown error status', r.status, 500);
  check('unknown error message', r.body.error.message, 'Internal server error');
  check('unknown error hides internals', r.body.error.message.includes('schoolId'), false);
}

/* -- A middleware-supplied 4xx status is honoured -------------------------------------- */
{
  const err = new Error('Not allowed by CORS');
  err.status = 403;
  const r = handle(err);
  check('foreign 4xx status', r.status, 403);
  check('foreign 4xx message exposed', r.body.error.message, 'Not allowed by CORS');
}

/* -- A foreign 5xx must not expose its message ----------------------------------------- */
{
  const err = new Error('redis connection string rediss://user:pass@host');
  err.status = 502;
  const r = handle(err);
  check('foreign 5xx status', r.status, 500);
  check('foreign 5xx hides credentials', JSON.stringify(r.body.error.message).includes('pass@host'), false);
}

/* -- headersSent delegates instead of throwing ----------------------------------------- */
{
  const res = mockRes();
  res.headersSent = true;
  let delegated = null;
  errorHandler(new Error('late failure'), { id: 'r2', method: 'GET', originalUrl: '/x' }, res, (e) => {
    delegated = e;
  });
  check('headersSent delegates to next', delegated instanceof Error, true);
  check('headersSent writes no body', res.body, null);
}

/* -- notFoundHandler ------------------------------------------------------------------- */
{
  let passed = null;
  notFoundHandler({ method: 'GET', originalUrl: '/api/v1/nope' }, mockRes(), (e) => {
    passed = e;
  });
  check('notFoundHandler status', passed.statusCode, 404);
  check('notFoundHandler code', passed.code, 'ROUTE_NOT_FOUND');
}

console.log(failures === 0 ? '\nAll error-handler checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
