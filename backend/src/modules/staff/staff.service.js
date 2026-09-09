'use strict';

/**
 * Staff — SRS §15.4, FR-STAFF-001.
 *
 * The last §15 module and deliberately the least interesting: `teachers/` is the worked example and
 * this follows it rather than finding a new shape. What it does *not* copy is that module's original
 * bug — see the ceiling note below.
 *
 * ## The ceiling, both halves
 *
 * `staff_limit` is one of SRS §11.2's eight limits and counts `Staff where is_active: true`
 * (`usageService.HEADCOUNT_SOURCES`). Two places assert it, not one:
 *
 *   - `enforceLimit('staff_limit')` on `POST /` — the route guard, which sees only creation.
 *   - `assertWithinLimit` here on the **re-activation transition**, because the flag the headcount
 *     counts can also be flipped by `PATCH`. Without it a school at its ceiling could deactivate one
 *     member of staff, create a replacement into the freed allowance, then flip the first back and
 *     sit at limit + 1 with no guard having run. `teachers/` shipped exactly that hole and it became
 *     §5a defect 21; it is closed here from the start rather than rediscovered.
 *
 * As everywhere: for a headcount limit `enforceLimit` counts **live** from this table, so
 * `syncHeadcount` maintains the `usage_records` mirror that §9.1 and §13 report from — not the
 * enforcement path.
 *
 * ## Dates
 *
 * `date_of_birth` and `joining_date` are `DATEONLY`. Joi with `convert: true` hands the service a
 * `Date` at **UTC** midnight and Sequelize's `DATEONLY._stringify` formats it in **local** time, so a
 * server west of UTC stores the previous day. Every date-only write goes through `dates.toDateOnly()`
 * first (Known Issues #20).
 *
 * There is no DELETE: §15.4 names none. A member of staff who leaves is deactivated through `PATCH`.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const dates = require('../../utils/dates');
const { resolveSchool } = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');
const usageService = require('../../services/usageService');
const { LIMITS } = require('../../config/constants');

const SORTABLE = Object.freeze([
  'id',
  'employee_id',
  'category',
  'first_name',
  'last_name',
  'joining_date',
  'designation',
  'is_active',
  'created_at',
]);

const EDITABLE = Object.freeze([
  'employee_id',
  'user_id',
  'category',
  'first_name',
  'last_name',
  'gender',
  'date_of_birth',
  'email',
  'phone',
  'address',
  /*
   * `photo_path` is deliberately absent — Known Issues #26. SRS §15.4 names no photo for
   * a staff member, so the column has no writer at all and `pickEditable()` must never copy one
   * off a request body.
   */
  'qualification',
  'designation',
  'joining_date',
  'salary',
  'is_active',
  'left_at',
  'notes',
  'metadata',
]);

const DATE_ONLY_FIELDS = Object.freeze(['date_of_birth', 'joining_date']);

function dateOnly(value) {
  return value === undefined || value === null || value === '' ? value : dates.toDateOnly(value);
}

function pickEditable(payload) {
  const next = {};
  for (const key of EDITABLE) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    next[key] = DATE_ONLY_FIELDS.includes(key) ? dateOnly(payload[key]) : payload[key];
  }
  return next;
}

function rethrow(err, payload) {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    /* `staff_school_employee_unique` is the only unique index on this table. */
    throw ApiError.conflict('A staff member with this employee id already exists at this school', {
      code: 'STAFF_EMPLOYEE_ID_TAKEN',
      details: { employee_id: payload && payload.employee_id },
    });
  }
  if (err instanceof db.Sequelize.ValidationError) {
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  throw err;
}

/**
 * A `user_id` may only name a `users` row of the same school, and only one staff record may hold it.
 *
 * `staff.user_id` carries a plain index, not a unique one — the same shape as `teachers` and
 * `students`, and unlike `parents`, whose `parents_user_unique` lets the database enforce it. So the
 * rule lives here (§5a defects 23 and 29). A duplicate link would make any future
 * `findOne({ user_id })` resolve to whichever row the optimiser returned first.
 */
async function loadUserInSchool(userId, schoolId, exceptStaffId = null) {
  if (userId === undefined || userId === null || userId === '') return null;

  const user = await db.User.findOne({ where: { id: userId, school_id: schoolId } });
  if (!user) {
    throw ApiError.validation('user_id must name a user of this school', [
      { field: 'user_id', message: 'Name a users row of the same school' },
    ]);
  }

  const taken = await db.Staff.findOne({
    where: {
      user_id: userId,
      school_id: schoolId,
      ...(exceptStaffId ? { id: { [Op.ne]: exceptStaffId } } : {}),
    },
  });
  if (taken) {
    throw ApiError.conflict('That account is already linked to a staff member', {
      code: 'STAFF_USER_TAKEN',
      details: { user_id: Number(userId), staff_id: taken.id },
    });
  }

  return user;
}

async function findById(req, id, namedSchoolId = undefined) {
  const where = tenantWhere(req.tenant, { id });
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;

  /*
   * Keep the record and the entitlement guard on the same school — §5a defect 22.
   *
   * The platform caller is deliberately **not** excluded. `named` is only truthy when the caller named
   * a school themselves and `resolveSchool()` already handles all three scopes, so the exclusion
   * relaxed nothing — it discarded the one scope declaration a Super Admin can make, letting a request
   * that named school A read or write a row belonging to school B instead of answering 404.
   */
  if (named) {
    const school = await resolveSchool(req, named);
    where.school_id = school.id;
  }

  const row = await db.Staff.findOne({ where });
  if (!row) throw ApiError.notFound('Staff member not found', { code: 'STAFF_NOT_FOUND' });
  return row;
}

async function list(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  if (query.category) where.category = query.category;
  if (query.is_active !== undefined) where.is_active = query.is_active;
  if (query.designation) where.designation = query.designation;
  if (query.q) {
    where[Op.or] = [
      { first_name: { [Op.like]: `%${query.q}%` } },
      { last_name: { [Op.like]: `%${query.q}%` } },
      { employee_id: { [Op.like]: `%${query.q}%` } },
    ];
  }

  return paginateQuery(
    db.Staff,
    { where, order: getSort({ query }, SORTABLE, ['first_name', 'ASC']) },
    pagination
  );
}

async function create(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  await loadUserInSchool(payload.user_id, school.id);

  let row;
  try {
    row = await db.Staff.create({
      school_id: school.id,
      organization_id: school.organization_id,
      ...pickEditable(payload),
      is_active: payload.is_active !== undefined ? payload.is_active : true,
    });
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'staff',
    recordId: row.id,
    event: 'create',
    before: null,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  await syncStaffHeadcount(school.id);
  return row;
}

async function update(req, id, payload) {
  const row = await findById(req, id, payload.school_id);
  if (Object.prototype.hasOwnProperty.call(payload, 'user_id') && payload.user_id) {
    await loadUserInSchool(payload.user_id, row.school_id, row.id);
  }

  const before = snapshot(row);
  const next = pickEditable(payload);
  if (!Object.keys(next).length) {
    throw ApiError.validation('No staff fields to update', [
      { field: 'body', message: 'Send at least one profile field' },
    ]);
  }

  const activeChanged =
    Object.prototype.hasOwnProperty.call(next, 'is_active') && Boolean(next.is_active) !== Boolean(row.is_active);

  /*
   * Re-activation is a limit event that `enforceLimit` cannot see — it is a route guard and it is
   * mounted on `POST /`. `staff_limit` counts `is_active: true`, so a deactivate / create / reactivate
   * sequence would otherwise land the school at limit + 1. `teachers/` shipped without this and it
   * became §5a defect 21; the platform bypass mirrors `enforceLimit`'s own so a Super Admin behaves
   * identically on both paths.
   */
  if (activeChanged && Boolean(next.is_active) && req.tenant && !req.tenant.isPlatform) {
    await usageService.assertWithinLimit(row.school_id, LIMITS.STAFF_LIMIT, 1);
  }

  row.set(next);
  try {
    await row.save();
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'staff',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  /* Only when the flag the headcount counts actually moved — a name edit is not a usage event. */
  if (activeChanged) await syncStaffHeadcount(row.school_id);
  return row;
}

/**
 * Recount `staff_limit` from the `staff` table.
 *
 * A failure must not fail the request: the row is already committed and the mirror is reporting data
 * the next sync repairs. A null return is normal for a school with no resolvable billing period.
 */
async function syncStaffHeadcount(schoolId) {
  try {
    return await usageService.syncHeadcount(schoolId, LIMITS.STAFF_LIMIT);
  } catch (err) {
    require('../../config/logger').warn('staff headcount sync failed', {
      schoolId,
      limitKey: LIMITS.STAFF_LIMIT,
      error: err.message,
    });
    return null;
  }
}

module.exports = { list, findById, create, update, EDITABLE };
