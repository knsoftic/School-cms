'use strict';

/**
 * Academic sessions — SRS §14.2, FR-SCHOOL-002.
 *
 * Three operations: create (always `upcoming`), activate, close. Activate flags this row current
 * and clears `is_current` on the school's other sessions; it does **not** auto-close them — a
 * school may have several `active` rows in the table and exactly one current. Close stamps
 * `closed` and clears current; a school may then have no current session. There is no DELETE:
 * close is the operation the source names.
 *
 * The bulk `is_current` flip uses `validate: false`. Sequelize 6's `Model.update` with
 * `validate: true` builds a skeleton from the payload plus column defaults and throws even when
 * zero rows match (the same trap `coupons.expireLapsed` hit).
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const { resolveSchool } = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const { ACADEMIC_SESSION_STATUS } = require('../../config/constants');
const dates = require('../../utils/dates');

/**
 * `start_date` and `end_date` are `DATEONLY` columns, and every date-only value written in this
 * project goes through `dates.toDateOnly()` first.
 *
 * The reason is not style. `validate()` runs Joi with `convert: true`, so `Joi.date().iso()` turns
 * `"2025-04-01"` into a `Date` at **UTC** midnight; Sequelize's `DATEONLY._stringify`
 * (`node_modules/sequelize/lib/data-types.js:351`) then formats that instant with
 * `moment(date).format('YYYY-MM-DD')`, which is **local** time. On a server west of UTC the two
 * disagree and the column stores the previous day — measured, not reasoned about: the same `Date`
 * formats as `2025-04-01` at UTC+0/+4/+5/+10 and as `2025-03-31` at UTC-5.
 *
 * `dates.toDateOnly()` is `toISOString().slice(0, 10)`, so it is UTC by construction and the value
 * reaching the column is the string the client sent. `invoices.service.js:559-565` and
 * `quotations.service.js:275` already did this; this module did not, which is the whole of the
 * defect (§5a session 16, defect 20).
 */
function dateOnly(value) {
  return value === undefined || value === null || value === '' ? value : dates.toDateOnly(value);
}

const SORTABLE = Object.freeze(['id', 'name', 'start_date', 'end_date', 'status', 'is_current', 'created_at']);

function rethrow(err, payload) {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    throw ApiError.conflict('A session with this name already exists at this school', {
      code: 'SESSION_NAME_TAKEN',
      details: { name: payload && payload.name },
    });
  }
  if (err instanceof db.Sequelize.ValidationError) {
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  throw err;
}

async function findById(req, id) {
  const row = await db.AcademicSession.findOne({ where: tenantWhere(req.tenant, { id }) });
  if (!row) throw ApiError.notFound('Academic session not found', { code: 'SESSION_NOT_FOUND' });
  return row;
}

async function list(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  if (query.status) where.status = query.status;
  if (query.is_current !== undefined) where.is_current = query.is_current;

  return paginateQuery(
    db.AcademicSession,
    { where, order: getSort({ query }, SORTABLE, ['start_date', 'DESC']) },
    pagination
  );
}

async function current(req) {
  const school = await resolveSchool(req, req.query.school_id);
  const row = await db.AcademicSession.findOne({
    where: tenantWhere(req.tenant, { school_id: school.id, is_current: true }),
  });
  if (!row) {
    throw ApiError.notFound('This school has no current academic session', { code: 'SESSION_NOT_CURRENT' });
  }
  return row;
}

async function create(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  let row;
  try {
    row = await db.AcademicSession.create({
      school_id: school.id,
      organization_id: school.organization_id,
      name: payload.name,
      start_date: dateOnly(payload.start_date),
      end_date: dateOnly(payload.end_date),
      status: ACADEMIC_SESSION_STATUS.UPCOMING,
      is_current: false,
    });
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'academic_sessions',
    recordId: row.id,
    event: 'create',
    before: null,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  return row;
}

async function update(req, id, payload) {
  const row = await findById(req, id);
  if (row.status === ACADEMIC_SESSION_STATUS.CLOSED) {
    throw ApiError.conflict('A closed session cannot be edited', { code: 'SESSION_CLOSED', details: { id: row.id } });
  }

  const before = snapshot(row);
  const next = {};
  for (const key of ['name', 'start_date', 'end_date']) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      next[key] = key === 'name' ? payload[key] : dateOnly(payload[key]);
    }
  }
  if (!Object.keys(next).length) {
    throw ApiError.validation('No session fields to update', [
      { field: 'body', message: 'Send name, start_date or end_date' },
    ]);
  }

  row.set(next);
  try {
    await row.save();
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'academic_sessions',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  return row;
}

async function activate(req, id, payload = {}) {
  const row = await findById(req, id);
  if (row.status === ACADEMIC_SESSION_STATUS.CLOSED) {
    throw ApiError.conflict('A closed session cannot be activated', {
      code: 'SESSION_CLOSED',
      details: { id: row.id },
    });
  }

  const before = snapshot(row);

  await db.sequelize.transaction(async (t) => {
    await db.AcademicSession.update(
      { is_current: false },
      {
        where: { school_id: row.school_id, id: { [Op.ne]: row.id }, is_current: true },
        transaction: t,
        validate: false,
      }
    );
    row.status = ACADEMIC_SESSION_STATUS.ACTIVE;
    row.is_current = true;
    if (!row.activated_at) row.activated_at = new Date();
    await row.save({ transaction: t });
  });

  await recordAudit(req, {
    tableName: 'academic_sessions',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  return row;
}

async function close(req, id, payload = {}) {
  const row = await findById(req, id);
  if (row.status === ACADEMIC_SESSION_STATUS.CLOSED) {
    throw ApiError.conflict('This session is already closed', {
      code: 'SESSION_ALREADY_CLOSED',
      details: { id: row.id },
    });
  }

  const before = snapshot(row);
  row.status = ACADEMIC_SESSION_STATUS.CLOSED;
  row.is_current = false;
  row.closed_at = new Date();
  await row.save();

  await recordAudit(req, {
    tableName: 'academic_sessions',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  return row;
}

module.exports = { list, findById, current, create, update, activate, close };
