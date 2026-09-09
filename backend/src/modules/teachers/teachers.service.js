'use strict';

/**
 * Teachers — SRS §15.3, FR-TEACHER-001 / FR-TEACHER-002.
 *
 * **The first module in the project to consume a plan allowance.** `teacher_limit` is one of SRS
 * §11.2's eight limits and its engine has been verified since session 4 without ever having a
 * caller. The two calls do different jobs, and an earlier revision of this header stated the
 * relationship wrongly — corrected here because the wrong version is the more plausible one:
 *
 *   - `enforceLimit('teacher_limit')` on the route *checks* the ceiling. For a **headcount** limit
 *     it counts live: `getUsage()` routes `MEASUREMENT.HEADCOUNT` to `countHeadcount()`
 *     (`usageService.js:276-277`), a `SELECT COUNT(*) FROM teachers WHERE is_active = 1`. It does
 *     **not** read `usage_records`.
 *   - `usageService.syncHeadcount()` here maintains the `usage_records` **mirror**, which is
 *     reporting data — the §9.1 dashboard and the §13 overage lines read it. Enforcement does not
 *     depend on it.
 *
 * So the mirror going stale would corrupt reports, not the ceiling. That is a weaker claim than the
 * one this header used to make ("a module that only mounts the guard enforces against a count that
 * never moves"), and it is the true one; for a *periodic* limit such as `api_limit` the old
 * sentence would have been right, because those read the row.
 *
 * `teacher_limit` counts `Teacher where is_active: true` (`usageService.HEADCOUNT_SOURCES`), which
 * is why deactivating a teacher re-syncs as well as creating one — otherwise the reported figure
 * would keep showing a retired teacher against the allowance.
 *
 * `date_of_birth` and `joining_date` are `DATEONLY`. Joi with `convert: true` hands us a `Date` at
 * **UTC** midnight and Sequelize's `DATEONLY._stringify` formats it in **local** time, so a server
 * west of UTC would store the previous day. Every date-only write in this project goes through
 * `dates.toDateOnly()` first — see Known Issues #20, which was exactly this bug in `sessions/`.
 *
 * There is no DELETE: §15.3 names no teacher deletion. A teacher who leaves is deactivated through
 * `PATCH` (`is_active: false`), which is the edit FR-TEACHER-001 does name.
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
  'first_name',
  'last_name',
  'joining_date',
  'designation',
  'is_active',
  'created_at',
]);

/** Columns a body may set, in the order §15.3 lists them. */
const EDITABLE = Object.freeze([
  'employee_id',
  'user_id',
  'first_name',
  'last_name',
  'gender',
  'date_of_birth',
  'email',
  'phone',
  'address',
  /*
   * `photo_path` is deliberately absent — Known Issues #26. SRS §15.3 names no photo for
   * a teacher, so the column has no writer at all and `pickEditable()` must never copy one
   * off a request body.
   */
  'qualification',
  'specialization',
  'experience_years',
  'joining_date',
  'salary',
  'designation',
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
    throw ApiError.conflict('A teacher with this employee id already exists at this school', {
      code: 'TEACHER_EMPLOYEE_ID_TAKEN',
      details: { employee_id: payload && payload.employee_id },
    });
  }
  if (err instanceof db.Sequelize.ValidationError) {
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  throw err;
}

/**
 * A `user_id` may only name a `users` row of the same school.
 *
 * Without this a school could attach another tenant's user to its own teacher record and the
 * teacher dashboard would then answer for them — the linkage is the authorization boundary that
 * FR-TEACHER-002 rests on, so it is checked here rather than trusted from the body.
 */
async function loadUserInSchool(userId, schoolId, exceptTeacherId = null) {
  if (userId === undefined || userId === null || userId === '') return null;
  const user = await db.User.findOne({ where: { id: userId, school_id: schoolId } });
  if (!user) {
    throw ApiError.validation('user_id must name a user of this school', [
      { field: 'user_id', message: 'Name a users row of the same school' },
    ]);
  }

  /*
   * One teacher per account. `teachers.user_id` carries a plain index, not a unique one
   * (`src/models/people.js`), so the database will not stop a second teacher row claiming the same
   * account — and FR-TEACHER-002's dashboard resolves the teacher *by* `user_id`
   * (`findOne({ user_id })`), so a duplicate link would make it answer with whichever row the
   * optimiser returned first. That is a silent wrong-record read, not an error, which is why it is
   * refused here rather than left to a constraint that does not exist.
   */
  const taken = await db.Teacher.findOne({
    where: {
      user_id: userId,
      school_id: schoolId,
      ...(exceptTeacherId ? { id: { [Op.ne]: exceptTeacherId } } : {}),
    },
  });
  if (taken) {
    throw ApiError.conflict('That account is already linked to a teacher', {
      code: 'TEACHER_USER_TAKEN',
      details: { user_id: Number(userId), teacher_id: taken.id },
    });
  }

  return user;
}

/**
 * Load a teacher, scoped to the same school the entitlement guard was evaluated against.
 *
 * `requireModule` resolves *which* school to gate on from the request — for a caller with no school
 * of their own it comes from `?school_id` — while `tenantWhere()` scopes an organization-level
 * caller by `organization_id`, i.e. across every school in the organization. Those two are not the
 * same school, and the gap is reachable: an organization admin whose organization holds school X (on
 * a plan with the Teachers module) and school Y (on a plan without it) could name `?school_id=X` to
 * satisfy the guard and then read a teacher of Y by id. Naming the school in the where clause makes
 * the record and the guard agree by construction.
 *
 * A school-scoped caller is unaffected: `resolveSchool()` refuses a `school_id` that is not theirs
 * (`CROSS_SCHOOL_ACCESS`), so the added predicate is their own school either way. A platform caller
 * is also unaffected — `requireModule` returns early for them, so there is no gated school to
 * disagree with.
 */
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

  const row = await db.Teacher.findOne({ where });
  if (!row) throw ApiError.notFound('Teacher not found', { code: 'TEACHER_NOT_FOUND' });
  return row;
}

async function list(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
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
    db.Teacher,
    { where, order: getSort({ query }, SORTABLE, ['first_name', 'ASC']) },
    pagination
  );
}

async function create(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  await loadUserInSchool(payload.user_id, school.id);

  let row;
  try {
    row = await db.Teacher.create({
      school_id: school.id,
      organization_id: school.organization_id,
      ...pickEditable(payload),
      is_active: payload.is_active !== undefined ? payload.is_active : true,
    });
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'teachers',
    recordId: row.id,
    event: 'create',
    before: null,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  await syncTeacherHeadcount(school.id);
  return row;
}

async function update(req, id, payload) {
  /* PATCH carries the school in the body rather than the query — same guard-agreement reasoning. */
  const row = await findById(req, id, payload.school_id);
  if (Object.prototype.hasOwnProperty.call(payload, 'user_id') && payload.user_id) {
    await loadUserInSchool(payload.user_id, row.school_id, row.id);
  }

  const before = snapshot(row);
  const next = pickEditable(payload);
  if (!Object.keys(next).length) {
    throw ApiError.validation('No teacher fields to update', [
      { field: 'body', message: 'Send at least one profile field' },
    ]);
  }

  const activeChanged =
    Object.prototype.hasOwnProperty.call(next, 'is_active') && Boolean(next.is_active) !== Boolean(row.is_active);

  /*
   * Re-activation is a limit event, and `enforceLimit` cannot see it.
   *
   * That guard is mounted per route and belongs on `POST /`, so it runs when a teacher is *created*.
   * But `teacher_limit` counts `is_active: true`, not rows — so a school at its ceiling could
   * deactivate one teacher, create a replacement, then flip the first back through `PATCH` and sit
   * at limit + 1 with no guard having run. Verified as a real hole before this check existed: the
   * PATCH returned 200 and `usage_records` recorded 3 used against an allowance of 2.
   *
   * The ceiling therefore has to be asserted wherever the counted flag is *set*, which is here. The
   * platform bypass mirrors `enforceLimit`'s own (`entitlement.js:365`) so a Super Admin behaves
   * identically on both paths, and `assertWithinLimit` raises the same `PLAN_LIMIT_EXCEEDED` the
   * create path raises — one refusal shape for one rule.
   */
  const activating = activeChanged && Boolean(next.is_active);
  if (activating && req.tenant && !req.tenant.isPlatform) {
    await usageService.assertWithinLimit(row.school_id, LIMITS.TEACHER_LIMIT, 1);
  }

  row.set(next);
  try {
    await row.save();
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'teachers',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  /* Only when the flag the headcount counts actually moved — a name edit is not a usage event. */
  if (activeChanged) await syncTeacherHeadcount(row.school_id);
  return row;
}

/**
 * Recount `teacher_limit` from the `teachers` table.
 *
 * Failure here must not fail the request: the teacher row is already committed and the usage mirror
 * is a reporting artefact that the next sync repairs. `syncHeadcount` returns null when the school
 * has no resolvable billing period, which is the normal case for a school with no subscription, so
 * a null return is not an error either.
 */
async function syncTeacherHeadcount(schoolId) {
  try {
    return await usageService.syncHeadcount(schoolId, LIMITS.TEACHER_LIMIT);
  } catch (err) {
    require('../../config/logger').warn('teacher headcount sync failed', {
      schoolId,
      limitKey: LIMITS.TEACHER_LIMIT,
      error: err.message,
    });
    return null;
  }
}

/**
 * FR-TEACHER-001's "assigns Subjects and Classes" — read side only, deliberately.
 *
 * `teacher_subjects` already has a write path: `POST /subjects/:id/teachers` and
 * `DELETE /subjects/:id/teachers/:assignmentId` (§14.4, FR-SCHOOL-004), which is the *same relation*
 * viewed from the subject. Adding a second writer here would mean two implementations of one
 * invariant — including the NULL-unique locking read that §5a defect 19 exists for — and they would
 * drift. So this module reads the assignments and the §14.4 endpoints keep writing them.
 *
 * "Classes" is two different things in §15.3 and both are answered: the classes this teacher is
 * *class teacher* of (`classes.class_teacher_id`, set through `PATCH /classes/:id`) and the classes
 * they teach a subject in (`teacher_subjects.class_id`).
 */
async function assignments(req, id) {
  const teacher = await findById(req, id);

  const [subjects, classTeacherOf, sectionTeacherOf] = await Promise.all([
    db.TeacherSubject.findAll({
      where: { teacher_id: teacher.id, school_id: teacher.school_id },
      include: [
        { model: db.Subject, as: 'subject', attributes: ['id', 'name', 'code', 'type'] },
        { model: db.Class, as: 'class', attributes: ['id', 'name', 'academic_session_id'] },
        { model: db.Section, as: 'section', attributes: ['id', 'name'] },
      ],
      order: [['id', 'ASC']],
    }),
    db.Class.findAll({
      where: { class_teacher_id: teacher.id, school_id: teacher.school_id },
      attributes: ['id', 'name', 'academic_session_id', 'is_active'],
      order: [['numeric_order', 'ASC']],
    }),
    db.Section.findAll({
      where: { class_teacher_id: teacher.id, school_id: teacher.school_id },
      attributes: ['id', 'name', 'class_id', 'is_active'],
      order: [['name', 'ASC']],
    }),
  ]);

  return { teacher, subjects, classTeacherOf, sectionTeacherOf };
}

/**
 * FR-TEACHER-002 — the dashboard, for the *authenticated* teacher.
 *
 * The actor is the teacher themselves, so the record is found by `user_id` rather than by an id in
 * the path: a teacher must not be able to read a colleague's dashboard by changing a number in the
 * URL, and `teachers.dashboard.view` is a key every teacher holds. `TEACHER_PROFILE_MISSING` is a
 * 404 rather than a 403 because the caller is legitimately authenticated — there is simply no
 * `teachers` row linked to them, which is the state FR-TEACHER-002's precondition excludes.
 */
async function dashboard(req) {
  if (!req.user || !req.user.id) {
    throw ApiError.unauthenticated('This dashboard is for a signed-in teacher');
  }

  const teacher = await db.Teacher.findOne({
    where: tenantWhere(req.tenant, { user_id: req.user.id }),
  });
  if (!teacher) {
    throw ApiError.notFound('No teacher profile is linked to this account', {
      code: 'TEACHER_PROFILE_MISSING',
      details: { user_id: req.user.id },
    });
  }

  const { subjects, classTeacherOf, sectionTeacherOf } = await assignments(req, teacher.id);

  const subjectIds = [...new Set(subjects.map((r) => Number(r.subject_id)).filter(Boolean))];
  const classIds = [
    ...new Set([
      ...subjects.map((r) => Number(r.class_id)).filter(Boolean),
      ...classTeacherOf.map((r) => Number(r.id)),
    ]),
  ];

  return {
    teacher,
    counts: {
      subjects: subjectIds.length,
      classes: classIds.length,
      classTeacherOf: classTeacherOf.length,
      sectionTeacherOf: sectionTeacherOf.length,
    },
    subjects,
    classTeacherOf,
    sectionTeacherOf,
  };
}

module.exports = {
  list,
  findById,
  create,
  update,
  assignments,
  dashboard,
  EDITABLE,
};
