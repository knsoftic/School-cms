'use strict';

/**
 * Pagination + safe sorting — SRS §25 "Pagination", "Large student lists".
 *
 * Sort columns pass through an explicit allow-list per call site. That is the reason no
 * user-supplied string ever reaches an ORDER BY clause (SRS §24 SQL-injection protection).
 */

const { PAGINATION } = require('../config/constants');

/**
 * Read page/limit from the query string, clamped to safe bounds.
 * @param {import('express').Request} req
 * @returns {{page: number, limit: number, offset: number}}
 */
function getPagination(req) {
  const rawPage = Number.parseInt(req.query.page, 10);
  const rawLimit = Number.parseInt(req.query.limit, 10);

  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : PAGINATION.DEFAULT_PAGE;
  let limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : PAGINATION.DEFAULT_LIMIT;
  limit = Math.min(limit, PAGINATION.MAX_LIMIT);

  return { page, limit, offset: (page - 1) * limit };
}

/**
 * Build a Sequelize `order` array from `?sortBy=&sortOrder=`, restricted to an allow-list.
 * @param {import('express').Request} req
 * @param {string[]} allowed         column names (or 'assoc.column') that may be sorted on
 * @param {[string, 'ASC'|'DESC']} [fallback]
 * @returns {Array<Array<string>>}
 */
function getSort(req, allowed, fallback = ['created_at', 'DESC']) {
  const requested = String(req.query.sortBy || '').trim();
  const direction = String(req.query.sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const primary = requested && allowed.includes(requested)
    ? [...requested.split('.'), direction]
    : [...String(fallback[0]).split('.'), fallback[1]];

  /*
   * A tiebreaker on the primary key, appended to every order.
   *
   * Without it, paging is not deterministic whenever the sort column has ties — which is not an edge
   * case but the normal state of most of these lists. SQL guarantees no ordering between rows that
   * compare equal, and MySQL is free to return them differently between two queries, so a row can
   * appear on page one **and** page two, or on neither. The user sees a duplicate or a silent
   * omission, and nothing anywhere reports an error.
   *
   * `classes` is the clearest case: it defaults to `numeric_order ASC`, and a school with two Year 3
   * sections has ties by construction. Found by a review of the §33 Classes screen in session 26,
   * but the defect was never in that screen — it was here, under every paginated endpoint at once.
   *
   * Safe on all 64 models: every one has an `id` primary key (checked, not assumed). Skipped when the
   * sort is already on `id`, which needs no tiebreaker and would otherwise emit `ORDER BY id, id`.
   *
   * The direction follows the primary sort so that "newest first" stays newest-first within a tie
   * rather than flipping to oldest-first on the second key.
   */
  const column = primary[primary.length - 2];
  if (column === 'id') return [primary];

  return [primary, ['id', primary[primary.length - 1]]];
}

/**
 * Convenience wrapper: run findAndCountAll with pagination and return both halves.
 * `distinct` is forced on so a row multiplied by an include does not inflate `count`.
 */
async function paginateQuery(model, options, pagination) {
  const result = await model.findAndCountAll({
    ...options,
    limit: pagination.limit,
    offset: pagination.offset,
    distinct: true,
    subQuery: options.subQuery,
  });
  return {
    rows: result.rows,
    count: Array.isArray(result.count) ? result.count.length : result.count,
  };
}

module.exports = { getPagination, getSort, paginateQuery };
