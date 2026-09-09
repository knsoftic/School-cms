'use strict';

/**
 * Exercises `src/middlewares/validate.js`.
 *
 * The checks that matter most here are the security ones: unknown body keys must be stripped
 * (mass assignment), and a `sortBy` shaped like SQL must be rejected before it can reach
 * `getSort()`.
 *
 * Run: node scripts/verify-validate.js
 */

const Joi = require('joi');

const { validate, commonSchemas, listQuery } = require('../src/middlewares/validate');

let failures = 0;

/** Run the middleware and resolve with whatever it passed to `next` (undefined on success). */
function run(middleware, req) {
  return new Promise((resolve) => middleware(req, {}, (err) => resolve(err)));
}

/** Stable stringify so object comparisons do not depend on key insertion order. */
function canonical(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(',')}}`;
}

function check(label, actual, expected) {
  const ok = canonical(actual) === canonical(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${canonical(actual)}${ok ? '' : `  (expected ${canonical(expected)})`}`
  );
}

(async () => {
  /* -- Mass assignment: keys absent from the schema never reach the controller ---------- */
  {
    const mw = validate({ body: Joi.object({ name: Joi.string().required() }) });
    const req = { body: { name: 'Ali', role_id: 1, school_id: 9, is_admin: true } };
    check('extra body keys accepted without error', await run(mw, req), undefined);
    check('extra body keys stripped', req.body, { name: 'Ali' });
  }

  /* -- Every error is reported at once, tagged with its container ----------------------- */
  {
    const mw = validate({
      params: commonSchemas.idParam,
      query: commonSchemas.pagination,
      body: Joi.object({
        email: Joi.string().email().required(),
        age: Joi.number().min(5).required(),
      }),
    });
    const err = await run(mw, {
      params: { id: 'abc' },
      query: { page: 0, limit: 5000 },
      body: { email: 'x', age: 1 },
    });
    check('status', err.statusCode, 422);
    check('all five errors returned', err.details.length, 5);
    check(
      'locations in container order',
      err.details.map((d) => d.location).join(','),
      'params,query,query,body,body'
    );
    check('fields named', err.details.map((d) => d.field).join(','), 'id,page,limit,email,age');
  }

  /* -- Coercion and defaults ------------------------------------------------------------ */
  {
    const mw = validate({ query: commonSchemas.pagination });
    const req = { query: { page: '3', limit: '50' } };
    check('query accepted', await run(mw, req), undefined);
    check('strings coerced to numbers', req.query, { page: 3, limit: 50 });

    const bare = { query: {} };
    await run(mw, bare);
    check('defaults match PAGINATION constants', bare.query, { page: 1, limit: 25 });

    const err = await run(mw, { query: { limit: '101' } });
    check('over-MAX_LIMIT rejected rather than clamped', err.statusCode, 422);
    check('message states the cap', /100/.test(err.details[0].message), true);
  }

  /* -- sortBy shape guard (the column allow-list itself belongs to the route) ----------- */
  {
    const mw = validate({ query: commonSchemas.pagination });
    check(
      'SQL-shaped sortBy rejected',
      (await run(mw, { query: { sortBy: 'name; DROP TABLE users' } })).statusCode,
      422
    );
    check(
      'dotted association column allowed',
      await run(mw, { query: { sortBy: 'student.first_name' } }),
      undefined
    );
  }

  /* -- listQuery composition ------------------------------------------------------------ */
  {
    const mw = validate({
      query: listQuery(Joi.object({ status: Joi.string().valid('active', 'left') })),
    });
    const req = { query: { page: '2', q: ' ali ', status: 'active', bogus: 'x' } };
    check('composed query accepted', await run(mw, req), undefined);
    check('merged, trimmed and stripped', req.query, {
      page: 2,
      limit: 25,
      q: 'ali',
      status: 'active',
    });
  }

  /* -- dateRange ordering --------------------------------------------------------------- */
  {
    const mw = validate({ query: commonSchemas.dateRange });
    check(
      'to before from rejected',
      (await run(mw, { query: { from: '2026-05-01', to: '2026-04-01' } })).statusCode,
      422
    );
    check(
      'valid range accepted',
      await run(mw, { query: { from: '2026-04-01', to: '2026-05-01' } }),
      undefined
    );

    /*
     * A one-sided window is a legitimate question and used to be a 422.
     *
     * `to` carried a bare `.min(Joi.ref('from'))`. With `from` absent Joi cannot resolve the
     * reference and **errors rather than skipping the rule**, so "everything up to a date" was
     * refused by every endpoint sharing this schema — with a message about a reference, which reads
     * as a server fault rather than a rejected input. The rule is now conditional on `from` existing.
     *
     * Both directions are asserted: the open-ended windows pass, and a backwards range is still
     * refused, which is the rule the fix must not have discarded.
     */
    check(
      'a to-only window is accepted — "everything up to a date"',
      await run(mw, { query: { to: '2026-05-01' } }),
      undefined
    );
    check(
      '  and a from-only window still is too',
      await run(mw, { query: { from: '2026-04-01' } }),
      undefined
    );
    check(
      '  while a backwards range is still refused, so the ordering rule survived',
      (await run(mw, { query: { from: '2026-05-01', to: '2026-04-01' } })).statusCode,
      422
    );
  }

  /* -- Headers are validated but never replaced ----------------------------------------- */
  {
    const mw = validate({
      headers: Joi.object({ 'x-school-id': Joi.number().integer().positive() }),
    });
    const req = { headers: { 'x-school-id': '7', host: 'localhost', 'user-agent': 'node' } };
    check('unknown headers allowed', await run(mw, req), undefined);
    check('headers object left intact', req.headers, {
      'x-school-id': '7',
      host: 'localhost',
      'user-agent': 'node',
    });
  }

  /* -- A missing container is validated as {} rather than skipped ----------------------- */
  {
    const mw = validate({ body: Joi.object({ name: Joi.string().required() }) });
    check('absent body still rejected', (await run(mw, {})).statusCode, 422);
  }

  /* -- No half-validated request -------------------------------------------------------- */
  {
    const mw = validate({
      params: commonSchemas.idParam,
      body: Joi.object({ n: Joi.number().required() }),
    });
    const req = { params: { id: '5' }, body: { n: 'bad' } };
    await run(mw, req);
    check('params untouched when body fails', req.params, { id: '5' });
  }

  /* -- Wiring mistakes fail at require-time -------------------------------------------- */
  {
    let message;
    try {
      validate({});
    } catch (err) {
      message = err.message;
    }
    check(
      'empty schema set throws',
      message,
      'validate() requires at least one of: body, query, params, headers'
    );

    let typoMessage;
    try {
      validate({ bodys: Joi.object() });
    } catch (err) {
      typoMessage = err.message;
    }
    check(
      'misspelled container names itself',
      typoMessage,
      'validate() received unsupported container(s): bodys'
    );
  }

  /* ─────────────── getSort, and the tiebreaker paging depends on ─────────────── */

  console.log('');
  console.log('── getSort ORDER BY ──');
  console.log('');

  /*
   * **`getSort` had no direct coverage anywhere in this project**, which is exactly why the defect
   * below survived: three suites name it in a comment and none of them called it.
   *
   * It emitted a single-column ORDER BY. SQL guarantees no ordering between rows that compare equal,
   * so on any list whose sort column has ties, MySQL may return them differently between two
   * queries — a row appears on page one **and** page two, or on neither, with nothing logged. That
   * is not an edge case: `classes` sorts by `numeric_order`, and a school with two Year 3 sections
   * has ties by construction.
   *
   * Found in session 26 by an adversarial review of the §33 Classes screen. The screen was correct;
   * the bug was under every paginated endpoint in the application at once.
   */
  {
    const { getSort } = require('../src/utils/pagination');
    const req = (query = {}) => ({ query });

    check('the default order carries a primary-key tiebreaker',
      getSort(req(), ['name']), [['created_at', 'DESC'], ['id', 'DESC']]);

    check('a requested column carries one too',
      getSort(req({ sortBy: 'name', sortOrder: 'asc' }), ['name']), [['name', 'ASC'], ['id', 'ASC']]);

    check('  and the tiebreaker follows the primary direction, so newest-first stays newest-first',
      getSort(req({ sortBy: 'name', sortOrder: 'desc' }), ['name'])[1], ['id', 'DESC']);

    check('a caller-supplied fallback gets one as well',
      getSort(req(), ['name'], ['numeric_order', 'ASC']), [['numeric_order', 'ASC'], ['id', 'ASC']]);

    /*
     * Sorting by the key itself needs no tiebreaker, and adding one would emit `ORDER BY id, id`.
     */
    check('sorting by id is left alone rather than doubled',
      getSort(req({ sortBy: 'id', sortOrder: 'asc' }), ['id']), [['id', 'ASC']]);

    /*
     * The allow-list is the injection guard: a column outside it must be ignored rather than
     * interpolated. Asserted here because the tiebreaker changed this function's return shape, and a
     * shape change is exactly when a guard gets dropped by accident.
     */
    check('a column outside the allow-list falls back and does not reach the query',
      getSort(req({ sortBy: 'password_hash' }), ['name']), [['created_at', 'DESC'], ['id', 'DESC']]);

    /*
     * An association sort splits on the dot, so Sequelize reads it as `[Model, column, direction]`.
     * The tiebreaker still lands on the primary model's own `id`.
     */
    check('an association sort still splits on the dot and still gets a tiebreaker',
      getSort(req({ sortBy: 'plan.name', sortOrder: 'asc' }), ['plan.name']),
      [['plan', 'name', 'ASC'], ['id', 'ASC']]);

    /* Every model has an `id`, which is what makes an unconditional tiebreaker safe. */
    const db = require('../src/models');
    const models = Object.keys(db).filter((name) => db[name] && db[name].rawAttributes);
    check('every model has the id column the tiebreaker orders on',
      models.filter((name) => !db[name].rawAttributes.id), []);
    check('  and none renames its primary key away from id',
      models.filter((name) => db[name].primaryKeyAttribute !== 'id'), []);
  }

  console.log(failures === 0 ? '\nAll validate checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
