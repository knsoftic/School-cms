'use strict';

/**
 * One response envelope for every endpoint, so clients (web + the future Android/iOS/
 * third-party consumers required by SRS §30 Rule 3) parse a single stable shape.
 *
 *   success: { success: true,  data, meta?, message? }
 *   failure: { success: false, error: { code, message, details? } }
 */

/**
 * @param {import('express').Response} res
 * @param {any} data
 * @param {object} [options]
 * @param {number} [options.status=200]
 * @param {string} [options.message]
 * @param {object} [options.meta]
 */
function ok(res, data = null, options = {}) {
  const body = { success: true, data };
  if (options.meta) body.meta = options.meta;
  if (options.message) body.message = options.message;
  return res.status(options.status || 200).json(body);
}

function created(res, data, options = {}) {
  return ok(res, data, { ...options, status: 201 });
}

function noContent(res) {
  return res.status(204).send();
}

/**
 * Paginated list response.
 * @param {import('express').Response} res
 * @param {{rows: any[], count: number}} result   Sequelize findAndCountAll shape
 * @param {{page: number, limit: number}} pagination
 */
function paginated(res, result, pagination, options = {}) {
  const total = typeof result.count === 'number' ? result.count : 0;
  const limit = pagination.limit || 25;
  return ok(res, result.rows || [], {
    ...options,
    meta: {
      ...(options.meta || {}),
      pagination: {
        total,
        page: pagination.page,
        limit,
        totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
        hasNextPage: pagination.page * limit < total,
        hasPreviousPage: pagination.page > 1,
      },
    },
  });
}

module.exports = { ok, created, noContent, paginated };
