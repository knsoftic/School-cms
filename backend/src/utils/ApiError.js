'use strict';

/**
 * Typed application error. The error handler turns these into the JSON envelope,
 * so controllers/services never build HTTP responses for failures themselves.
 */

class ApiError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} message
   * @param {object} [options]
   * @param {string} [options.code]     stable machine-readable code
   * @param {any}    [options.details]  field errors or extra context
   * @param {boolean}[options.expose]   include details in the response (default true for 4xx)
   */
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = options.code || ApiError.defaultCode(statusCode);
    this.details = options.details;
    this.expose = options.expose !== undefined ? options.expose : statusCode < 500;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static defaultCode(statusCode) {
    return (
      {
        400: 'BAD_REQUEST',
        401: 'UNAUTHENTICATED',
        402: 'PAYMENT_REQUIRED',
        403: 'FORBIDDEN',
        404: 'NOT_FOUND',
        409: 'CONFLICT',
        413: 'PAYLOAD_TOO_LARGE',
        415: 'UNSUPPORTED_MEDIA_TYPE',
        422: 'VALIDATION_ERROR',
        429: 'RATE_LIMITED',
      }[statusCode] || (statusCode >= 500 ? 'INTERNAL_ERROR' : 'ERROR')
    );
  }

  static badRequest(message = 'Bad request', options) {
    return new ApiError(400, message, options);
  }

  static unauthenticated(message = 'Authentication required', options) {
    return new ApiError(401, message, { code: 'UNAUTHENTICATED', ...options });
  }

  /** SRS §8 / §24 — cross-school access and insufficient role/permission both land here. */
  static forbidden(message = 'Forbidden', options) {
    return new ApiError(403, message, { code: 'FORBIDDEN', ...options });
  }

  static notFound(message = 'Resource not found', options) {
    return new ApiError(404, message, options);
  }

  static conflict(message = 'Conflict', options) {
    return new ApiError(409, message, options);
  }

  static validation(message = 'Validation failed', details) {
    return new ApiError(422, message, { code: 'VALIDATION_ERROR', details });
  }

  /** SRS §11 / §21 — plan limit reached (AI limit, student limit, storage, …). */
  static limitExceeded(message, details) {
    return new ApiError(403, message, { code: 'PLAN_LIMIT_EXCEEDED', details });
  }

  /** SRS §11 — the school's plan does not include the requested module. */
  static moduleNotSubscribed(message, details) {
    return new ApiError(403, message, { code: 'MODULE_NOT_SUBSCRIBED', details });
  }

  /** SRS §12 — subscription is not in a usable state. */
  static subscriptionInactive(message, details) {
    return new ApiError(402, message, { code: 'SUBSCRIPTION_INACTIVE', details });
  }

  static internal(message = 'Internal server error', options) {
    return new ApiError(500, message, { expose: false, ...options });
  }
}

module.exports = ApiError;
