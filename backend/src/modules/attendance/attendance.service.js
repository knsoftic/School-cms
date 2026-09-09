'use strict';

/**
 * Attendance — SRS §16, FR-ATT-001 (mark students), FR-ATT-002 (reports), FR-ATT-003 (teachers).
 *
 * ## The first module that consumes rather than creates
 *
 * Every Phase 3.J module owned its own table. This one owns two tables that reference rows
 * `students/`, `teachers/` and `classes/` own, so almost all of its correctness is in *checking what
 * it is given*: a student must belong to the school, and to the class and section the request names.
 *
 * Both `student_attendance` and `teacher_attendance` carry `organization_id` **as well as**
 * `school_id`, checked against the model rather than assumed — so `tenantWhere()` is safe here, and
 * the trap that has shipped twice (§5a defect 16, and again in `parent_students`) does not apply.
 *
 * ## Marking is an upsert, and the index is what makes it one
 *
 * `student_attendance_student_date_unique (student_id, attendance_date)` and
 * `teacher_attendance_teacher_date_unique (teacher_id, attendance_date)` both cover NOT NULL columns,
 * so unlike `class_subjects` (§5a defect 19) there is no NULL-distinct hole and the database really
 * does enforce one row per person per day. Re-marking a register therefore **corrects** it rather
 * than duplicating it, which is the behaviour a teacher fixing a mistake expects.
 *
 * ## Why there is no per-row audit
 *
 * `recordAudit` is the house rule for a write, and it is deliberately not called per attendance row.
 * `student_attendance` carries `marked_by` and `marked_at` **on the row itself** — the schema gives
 * this table its own provenance, which no other table in the project does — so a per-row
 * `audit_logs` entry would duplicate it at roughly two hundred times the volume (one per child, per
 * day, per year). The batch is recorded once in the activity trail instead, naming the class, the
 * section, the date and the count, and the row keeps the marker. Stated here because "no recordAudit"
 * looks like an omission and is not.
 *
 * ## FR-ATT-002's percentage, which §16 does not define
 *
 * §16 lists "Percentage" among the reports and says nothing about how to compute it. The reading
 * taken is `(present + late) ÷ marked`, where `marked` is every row of any status:
 *
 *   - `late` counts as attendance — the child was there.
 *   - `leave` counts in the denominator but not the numerator: it is a *marked* day the child did not
 *     attend. Excluding it from both would silently flatter a school that grants a lot of leave, which
 *     is the less safe direction to be wrong in.
 *   - Days with no row at all are not counted either way, because the school did not mark them and
 *     the module cannot tell a holiday from an oversight.
 *
 * Every raw count is returned alongside the percentage, so a consumer that prefers another definition
 * can compute it without this module having to guess a second time.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const dates = require('../../utils/dates');
const {
  resolveSchool,
  loadClassInSchool,
  loadSectionOfClass,
  loadSessionInSchool,
} = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { ATTENDANCE_STATUS, ATTENDANCE_STATUS_LIST } = require('../../config/constants');

const SORTABLE = Object.freeze(['id', 'attendance_date', 'status', 'student_id', 'created_at']);
const TEACHER_SORTABLE = Object.freeze(['id', 'attendance_date', 'status', 'teacher_id', 'created_at']);

/** The statuses that count as having attended — see the header's note on the percentage. */
const PRESENT_STATUSES = Object.freeze([ATTENDANCE_STATUS.PRESENT, ATTENDANCE_STATUS.LATE]);

function dateOnly(value) {
  return value === undefined || value === null || value === '' ? value : dates.toDateOnly(value);
}

/**
 * The window a report covers, derived from one anchor date so the caller never computes boundaries.
 *
 * Built from the **string** form rather than from a `Date`, for the same reason every date-only value
 * in this project is: a `Date` at UTC midnight formatted in local time is the previous day west of
 * UTC (Known Issues #20). Slicing `YYYY-MM-DD` cannot drift.
 */
function periodRange(period, anchor) {
  const iso = dateOnly(anchor);
  const [year, month] = iso.split('-');

  if (period === 'daily') return { from: iso, to: iso, label: iso };
  if (period === 'monthly') {
    /* Day 0 of the next month is the last day of this one, computed in UTC. */
    const last = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    return {
      from: `${year}-${month}-01`,
      to: `${year}-${month}-${String(last).padStart(2, '0')}`,
      label: `${year}-${month}`,
    };
  }
  return { from: `${year}-01-01`, to: `${year}-12-31`, label: year };
}

/** Apply the shared date filters — a single day, or a range, or neither. */
function applyDateFilter(where, query) {
  if (query.attendance_date) {
    where.attendance_date = dateOnly(query.attendance_date);
    return where;
  }
  if (query.from || query.to) {
    where.attendance_date = {
      ...(query.from ? { [Op.gte]: dateOnly(query.from) } : {}),
      ...(query.to ? { [Op.lte]: dateOnly(query.to) } : {}),
    };
  }
  return where;
}

/**
 * Resolve and cross-check the placement a mark is for.
 *
 * The class must belong to the school and the section to the class — the body is not trusted for
 * either, the same rule `students.resolvePlacement` applies for the same reason.
 */
async function resolveRegister(payload, schoolId) {
  const klass = await loadClassInSchool(payload.class_id, schoolId);
  if (payload.section_id) await loadSectionOfClass(payload.section_id, payload.class_id);
  if (payload.academic_session_id) await loadSessionInSchool(payload.academic_session_id, schoolId);
  return {
    classId: klass.id,
    sectionId: payload.section_id || null,
    sessionId: payload.academic_session_id || null,
  };
}

/**
 * Every named student must belong to this school — and to the class and section being marked.
 *
 * One query, not one per entry: a register is a whole section, and forty round trips to prove
 * membership would make the common case the slow case. The set difference is what refuses.
 */
async function assertStudentsInRegister(studentIds, schoolId, register) {
  const unique = [...new Set(studentIds.map(Number))];

  const rows = await db.Student.findAll({
    where: {
      id: { [Op.in]: unique },
      school_id: schoolId,
      class_id: register.classId,
      ...(register.sectionId ? { section_id: register.sectionId } : {}),
    },
    attributes: ['id'],
  });

  const found = new Set(rows.map((r) => Number(r.id)));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) {
    throw ApiError.validation('Every student must belong to the class being marked', [
      { field: 'entries', message: `Not in this class/section: ${missing.join(', ')}` },
    ]);
  }
  return unique;
}

async function assertTeachersInSchool(teacherIds, schoolId) {
  const unique = [...new Set(teacherIds.map(Number))];
  const rows = await db.Teacher.findAll({
    where: { id: { [Op.in]: unique }, school_id: schoolId },
    attributes: ['id'],
  });
  const found = new Set(rows.map((r) => Number(r.id)));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) {
    throw ApiError.validation('Every teacher must belong to this school', [
      { field: 'entries', message: `Not in this school: ${missing.join(', ')}` },
    ]);
  }
  return unique;
}

/** A body naming the same person twice is a mistake, not a last-one-wins. */
function assertNoDuplicates(ids, field) {
  const seen = new Set();
  const repeated = [];
  for (const id of ids) {
    if (seen.has(Number(id))) repeated.push(Number(id));
    seen.add(Number(id));
  }
  if (repeated.length) {
    throw ApiError.validation('The same person may not be marked twice in one request', [
      { field, message: `Repeated: ${[...new Set(repeated)].join(', ')}` },
    ]);
  }
}

/* ── FR-ATT-001 ── */

async function markStudents(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  const register = await resolveRegister(payload, school.id);
  const date = dateOnly(payload.attendance_date);

  assertNoDuplicates(payload.entries.map((e) => e.student_id), 'entries');
  await assertStudentsInRegister(payload.entries.map((e) => e.student_id), school.id, register);

  const markedAt = new Date();
  const rows = payload.entries.map((entry) => ({
    school_id: school.id,
    organization_id: school.organization_id,
    academic_session_id: register.sessionId,
    student_id: entry.student_id,
    class_id: register.classId,
    section_id: register.sectionId,
    attendance_date: date,
    status: entry.status,
    late_minutes: entry.late_minutes ?? null,
    remarks: entry.remarks ?? null,
    marked_by: req.user ? req.user.id : null,
    marked_at: markedAt,
  }));

  /*
   * One statement, and `updateOnDuplicate` is what makes a re-mark a correction. The unique index is
   * `(student_id, attendance_date)`, so a second mark of the same register overwrites rather than
   * inserting — including `marked_by` and `marked_at`, so the row always names whoever last set it.
   */
  await db.StudentAttendance.bulkCreate(rows, {
    updateOnDuplicate: [
      'status',
      'late_minutes',
      'remarks',
      'class_id',
      'section_id',
      'academic_session_id',
      'marked_by',
      'marked_at',
      'updated_at',
    ],
  });

  const saved = await db.StudentAttendance.findAll({
    where: {
      school_id: school.id,
      attendance_date: date,
      student_id: { [Op.in]: payload.entries.map((e) => Number(e.student_id)) },
    },
    order: [['student_id', 'ASC']],
  });

  return { register, date, rows: saved };
}

async function listStudents(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  if (query.class_id) where.class_id = query.class_id;
  if (query.section_id) where.section_id = query.section_id;
  if (query.student_id) where.student_id = query.student_id;
  if (query.academic_session_id) where.academic_session_id = query.academic_session_id;
  if (query.status) where.status = query.status;

  /*
   * `remarks` is the only free-text column on the row, so it is the whole of what `q` can mean here.
   *
   * `listQuery()` concatenates `commonSchemas.search`, so this endpoint has always advertised `q` and
   * always discarded it — Known Issue #24, whose other half (`fees/`) was closed the same way. No
   * screen sends it today, so nothing was visibly wrong; an endpoint that accepts a filter and
   * returns an unfiltered list is wrong regardless of who is currently asking.
   */
  if (query.q) where.remarks = { [Op.like]: `%${query.q}%` };
  applyDateFilter(where, query);

  return paginateQuery(
    db.StudentAttendance,
    {
      where,
      include: [
        {
          model: db.Student,
          as: 'student',
          attributes: ['id', 'student_id', 'roll_number', 'first_name', 'last_name'],
        },
      ],
      order: getSort({ query }, SORTABLE, ['attendance_date', 'DESC']),
    },
    pagination
  );
}

/* ── FR-ATT-003 ── */

async function markTeachers(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  if (payload.academic_session_id) await loadSessionInSchool(payload.academic_session_id, school.id);
  const date = dateOnly(payload.attendance_date);

  assertNoDuplicates(payload.entries.map((e) => e.teacher_id), 'entries');
  await assertTeachersInSchool(payload.entries.map((e) => e.teacher_id), school.id);

  const markedAt = new Date();
  const rows = payload.entries.map((entry) => ({
    school_id: school.id,
    organization_id: school.organization_id,
    academic_session_id: payload.academic_session_id || null,
    teacher_id: entry.teacher_id,
    attendance_date: date,
    status: entry.status,
    check_in_at: entry.check_in_at ?? null,
    check_out_at: entry.check_out_at ?? null,
    late_minutes: entry.late_minutes ?? null,
    remarks: entry.remarks ?? null,
    marked_by: req.user ? req.user.id : null,
    marked_at: markedAt,
  }));

  await db.TeacherAttendance.bulkCreate(rows, {
    updateOnDuplicate: [
      'status',
      'check_in_at',
      'check_out_at',
      'late_minutes',
      'remarks',
      'academic_session_id',
      'marked_by',
      'marked_at',
      'updated_at',
    ],
  });

  const saved = await db.TeacherAttendance.findAll({
    where: {
      school_id: school.id,
      attendance_date: date,
      teacher_id: { [Op.in]: payload.entries.map((e) => Number(e.teacher_id)) },
    },
    order: [['teacher_id', 'ASC']],
  });

  return { date, rows: saved };
}

async function listTeachers(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  if (query.teacher_id) where.teacher_id = query.teacher_id;
  if (query.academic_session_id) where.academic_session_id = query.academic_session_id;
  if (query.status) where.status = query.status;
  /* Same as `listStudents()`: `remarks` is the only free-text column, and `q` was being discarded. */
  if (query.q) where.remarks = { [Op.like]: `%${query.q}%` };
  applyDateFilter(where, query);

  return paginateQuery(
    db.TeacherAttendance,
    {
      where,
      include: [
        {
          model: db.Teacher,
          as: 'teacher',
          attributes: ['id', 'employee_id', 'first_name', 'last_name'],
        },
      ],
      order: getSort({ query }, TEACHER_SORTABLE, ['attendance_date', 'DESC']),
    },
    pagination
  );
}

/* ── FR-ATT-002 ── */

/**
 * Daily / Monthly / Yearly counts and the percentage.
 *
 * Counted in SQL rather than by loading rows: a yearly report for a school is tens of thousands of
 * rows, and the four numbers are all the caller needs. The grouping is by status, and every one of
 * the four statuses appears in the result even when its count is zero — a report that silently omits
 * "leave: 0" is one a reader has to guess at.
 */
async function report(req, query) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  if (query.class_id) where.class_id = query.class_id;
  if (query.section_id) where.section_id = query.section_id;
  if (query.student_id) where.student_id = query.student_id;
  if (query.academic_session_id) where.academic_session_id = query.academic_session_id;

  const range = periodRange(query.period, query.date);
  where.attendance_date = { [Op.gte]: range.from, [Op.lte]: range.to };

  const grouped = await db.StudentAttendance.findAll({
    where,
    attributes: ['status', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
    group: ['status'],
    raw: true,
  });

  const counts = {};
  for (const status of ATTENDANCE_STATUS_LIST) counts[status] = 0;
  for (const row of grouped) counts[row.status] = Number(row.count);

  const marked = ATTENDANCE_STATUS_LIST.reduce((sum, s) => sum + counts[s], 0);
  const attended = PRESENT_STATUSES.reduce((sum, s) => sum + counts[s], 0);

  /*
   * Two decimals, and `null` rather than 0 when nothing was marked — a school with no register for
   * the period has an *unknown* attendance rate, not a zero one, and reporting 0% would read as a
   * catastrophe rather than an absence of data.
   */
  const percentage = marked === 0 ? null : Math.round((attended / marked) * 10000) / 100;

  return {
    period: query.period,
    label: range.label,
    from: range.from,
    to: range.to,
    counts,
    marked,
    attended,
    percentage,
  };
}

module.exports = {
  markStudents,
  listStudents,
  markTeachers,
  listTeachers,
  report,
  periodRange,
  PRESENT_STATUSES,
};
