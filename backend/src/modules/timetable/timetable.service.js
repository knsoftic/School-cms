'use strict';

/**
 * Timetables — SRS §20.1, FR-TT-001 (creation) and FR-TT-002 (conflict detection).
 *
 * One table, `timetables`, holding one row per period slot. §20.1 names two things — a **Class
 * Timetable** and a **Teacher Timetable** — and §29 provides one table, so the two are two views of
 * the same rows: the same week filtered by class or by teacher. The model's own docblock says as much.
 *
 * ## FR-TT-002 — conflicts are **prevented**, not flagged
 *
 * FR-TT-002's outcome reads *"Conflicting timetable entries are flagged/prevented"* — one phrase for
 * two different products. It is implemented as **prevented**, with a 409 that carries the colliding
 * row in `details` so a client can render it as a flag. Three reasons, and the first is decisive:
 *
 *  1. **There is nowhere to store a flag.** `timetables` has no column for one and §35 forbids adding
 *     one. "Flagged" is not implementable against the fixed schema; "prevented" is.
 *  2. The schema has already chosen. `timetables_section_day_period_unique` *prevents* one of the three
 *     named conflicts at the database level. Accepting the other two with a warning would refuse one
 *     clash and allow another in the same request.
 *  3. Failing closed is this project's instinct where a wrong answer would look right — `finance`
 *     refuses a two-currency balance rather than adding pesos to dollars.
 *
 * ## What each of the three named conflicts is, exactly
 *
 * FR-TT-002 says the check is for *"Period, Room, and Teacher conflicts"*:
 *
 *  - **Period** — a section cannot hold two entries in one `(day_of_week, period_number)`. When
 *    `section_id` is set the unique index enforces it; when it is null it does not, which is the whole
 *    of the next section.
 *  - **Teacher** — the same teacher cannot appear twice in one `(day_of_week, period_number)` anywhere
 *    in the school. Only when `teacher_id` is set: two rows that both name no teacher double-book
 *    nobody. The index `(teacher_id, day_of_week, period_number)` exists for this query and its model
 *    comment says so.
 *  - **Room** — the same room cannot host two entries in one slot. Only when `room` is a non-empty
 *    string. Index `(school_id, day_of_week, period_number, room)`, again commented for this query.
 *
 * **`is_break` needs no special case, and that is worth stating because it looks like it should.** A
 * break "occupies a slot but needs no subject or teacher", so it carries a null `teacher_id` and the
 * teacher rule simply does not fire for it. It still occupies its section's slot, which is right — a
 * class cannot have a break and a lesson in period 3.
 *
 * **`period_number` is authoritative, not the clock.** All three of the schema's conflict indexes key
 * on `period_number` and none keys on `start_time`/`end_time`, so two rows sharing a period number
 * with different times *are* a conflict and two rows overlapping in clock time under different period
 * numbers are *not*. That is the schema's choice rather than this module's, and there is no `periods`
 * table to make the numbering canonical, so the times stay descriptive.
 *
 * **The check ignores `is_active` and `academic_session_id`, because the unique index does.** Both
 * columns exist and it is tempting to scope by them — but the index is on
 * `(section_id, day_of_week, period_number)` alone, so a service that allowed a second row for an
 * inactive slot, or for a different session, would be overruled by the database a moment later with a
 * refusal it had just said was fine. One rule governs, and it is the index's. The consequence, stated
 * plainly: **`is_active: false` does not free a slot.** A section's grid is one living plan, not a
 * per-session history, and rearranging it means editing the rows that are there.
 *
 * ## The NULL-permissive unique index
 *
 * `section_id` is nullable and MySQL treats NULL as distinct inside a unique index, so any number of
 * identical class-wide rows would slip past `timetables_section_day_period_unique`. That is §5a defect
 * 19's exact shape, and the answer is the one `fees.alreadyAssigned()` and the grade-band overlap
 * guard already use: the rule lives in the service, because the fixed schema cannot carry it.
 *
 * A null section is taken to mean **the whole class sits this period**, which is the meaning
 * `exams.section_id` documents for the identical column shape. Two consequences follow and both are
 * enforced: two class-wide rows in one slot are a duplicate, and a class-wide row plus a section row
 * of that class in the same slot double-books that section.
 *
 * The alternative — requiring `section_id` on every entry, which would make the index fully effective
 * and need no guard at all — was rejected because `sections` is a separate table that may be empty:
 * a school that has not divided its classes could then not build a timetable at all, and `class_id` is
 * the NOT NULL column while `section_id` is the nullable one.
 *
 * ## Provenance of the three decisions above
 *
 * §17, §18 and §19's open questions were each put to three independent reviewers before any code was
 * written. These three were decided **solo**, because the API returned `529 Overloaded` for twenty-two
 * consecutive agents across two attempts and blocking on it would have bought nothing. The reasoning
 * is set out here at the length a panel's would have been, and the counterarguments are named rather
 * than omitted — but a later reader should know the provenance differs.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const {
  resolveSchool,
  loadClassInSchool,
  loadSectionOfClass,
  loadSessionInSchool,
  loadTeacherInSchool,
} = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');

const SORTABLE = Object.freeze(['id', 'day_of_week', 'period_number', 'start_time', 'created_at']);

const EDITABLE = Object.freeze([
  'class_id', 'section_id', 'subject_id', 'teacher_id', 'academic_session_id',
  'day_of_week', 'period_number', 'period_label', 'start_time', 'end_time',
  'room', 'is_break', 'is_active',
]);

const TIME_COLUMNS = Object.freeze(['start_time', 'end_time']);

/**
 * A week reads in week order for free.
 *
 * `day_of_week` is an ENUM declared Monday-first, and MySQL orders an ENUM by its declaration order
 * rather than alphabetically — so this is the natural week, not `friday, monday, saturday…`. Asserted
 * in the suite, because it is a property of the column that a later reader would otherwise have to
 * take on trust.
 */
const WEEK_ORDER = Object.freeze([['day_of_week', 'ASC'], ['period_number', 'ASC']]);

/** `HH:MM` → `HH:MM:SS`, so the create response and the stored row are the same string. */
function normaliseTime(value) {
  if (value === undefined || value === null || value === '') return value;
  const s = String(value).trim();
  return /^\d{2}:\d{2}$/.test(s) ? `${s}:00` : s;
}

function normaliseTimes(payload) {
  const next = { ...payload };
  for (const column of TIME_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(next, column)) next[column] = normaliseTime(next[column]);
  }
  return next;
}

/** A room is compared as a trimmed string; an empty one is no room at all. */
function normaliseRoom(value) {
  if (value === undefined || value === null) return value;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function pick(payload) {
  const next = {};
  for (const key of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) next[key] = payload[key];
  }
  return next;
}

function rethrow(err) {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    /*
     * The one unique index on the table. Reaching it means `assertNoConflict()` missed — which the
     * locking reads there now make very unlikely, but the index stays the last word: a lock is an
     * InnoDB behaviour under one isolation level, and the index is a guarantee. The refusal is the
     * same shape either way. (This comment used to say the race "cannot be closed without the index
     * covering the NULL case", which understated the remedy `subjects.service.js` already had.)
     */
    throw ApiError.conflict('That section already has an entry in this period', {
      code: 'TIMETABLE_SLOT_TAKEN',
      details: {},
    });
  }
  if (err instanceof db.Sequelize.ValidationError) {
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  if (err instanceof db.Sequelize.ForeignKeyConstraintError) {
    throw ApiError.validation('A referenced record does not exist', [
      { field: 'body', message: 'One of the records this entry refers to no longer exists' },
    ]);
  }
  throw err;
}

/* ─────────────────────────── FR-TT-002 ─────────────────────────── */

/**
 * The three conflict queries of FR-TT-002, run as one.
 *
 * `excludeId` is the row being edited — FR-TT-002 covers editing, and an entry must not be found to
 * conflict with itself.
 *
 * Every query is scoped to the school and to the same `(day_of_week, period_number)`, and none is
 * scoped by `is_active` or `academic_session_id` — see the header for why that matters.
 */
async function assertNoConflict(schoolId, next, excludeId, transaction) {
  /*
   * The transaction is required, and every query below takes `LOCK.UPDATE`, because a check-then-insert
   * on this table cannot be closed by the index alone: `timetables_section_day_period_unique` is
   * NULL-permissive on `section_id`, so two concurrent class-wide rows for the same class/day/period
   * both pass the lookup and both insert, and the index rejects neither. Proved against this database,
   * not assumed.
   *
   * `subjects.service.js:112-120` states the remedy for the identical shape: "A locking read serialises
   * the pair, which is the only backstop available while the key stays nullable." This module had the
   * same hole and had settled for the weaker, non-locking `fees.alreadyAssigned()` posture instead.
   *
   * All three queries run in the same order for every caller, so the lock ordering is consistent and
   * two concurrent writers queue rather than deadlock.
   */
  if (!transaction) throw new Error('assertNoConflict() must run inside the caller transaction');

  const slot = {
    school_id: schoolId,
    day_of_week: next.day_of_week,
    period_number: next.period_number,
    ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
  };

  const describe = (row) => ({
    id: row.id,
    class_id: row.class_id,
    section_id: row.section_id,
    subject_id: row.subject_id,
    teacher_id: row.teacher_id,
    room: row.room,
    day_of_week: row.day_of_week,
    period_number: row.period_number,
  });

  /*
   * PERIOD. A section cannot be in two places at once — and a class-wide row (section null) means
   * every section of that class, so it collides both with another class-wide row for the same class
   * and with any section row of that class. This is the half the unique index cannot see.
   */
  const periodWhere = next.section_id
    ? {
        ...slot,
        [Op.or]: [
          { section_id: next.section_id },
          /* A class-wide row over this section's class occupies this section too. */
          { class_id: next.class_id, section_id: null },
        ],
      }
    : { ...slot, class_id: next.class_id };

  const periodClash = await db.Timetable.findOne({
    where: periodWhere,
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (periodClash) {
    throw ApiError.conflict(
      next.section_id
        ? 'That section already has an entry in this period'
        : 'That class already has an entry in this period',
      { code: 'TIMETABLE_PERIOD_CONFLICT', details: { conflict: 'period', with: describe(periodClash) } }
    );
  }

  /* TEACHER. Only a named teacher can be double-booked; a break names none and never fires this. */
  if (next.teacher_id) {
    const teacherClash = await db.Timetable.findOne({
      where: { ...slot, teacher_id: next.teacher_id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (teacherClash) {
      throw ApiError.conflict('That teacher is already teaching in this period', {
        code: 'TIMETABLE_TEACHER_CONFLICT',
        details: { conflict: 'teacher', with: describe(teacherClash) },
      });
    }
  }

  /* ROOM. Only a named room can be double-booked. Case-insensitivity is the collation's, not ours. */
  const room = normaliseRoom(next.room);
  if (room) {
    const roomClash = await db.Timetable.findOne({
      where: { ...slot, room },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (roomClash) {
      throw ApiError.conflict('That room is already in use in this period', {
        code: 'TIMETABLE_ROOM_CONFLICT',
        details: { conflict: 'room', with: describe(roomClash) },
      });
    }
  }
}

/* ─────────────────────────── FR-TT-001 ─────────────────────────── */

async function findEntry(req, id, namedSchoolId = undefined) {
  const where = tenantWhere(req.tenant, { id });
  const named = namedSchoolId !== undefined ? namedSchoolId : req.query && req.query.school_id;
  /* Record and entitlement guard resolved from the same school — §5a defects 22 and 35. */
  if (named) {
    const school = await resolveSchool(req, named);
    where.school_id = school.id;
  }
  const row = await db.Timetable.findOne({ where });
  if (!row) throw ApiError.notFound('Timetable entry not found', { code: 'TIMETABLE_ENTRY_NOT_FOUND' });
  return row;
}

/** Every optional reference on an entry must point inside the same school. */
async function assertReferences(payload, schoolId, existing = null) {
  const classId = payload.class_id !== undefined ? payload.class_id : existing && existing.class_id;
  if (payload.class_id !== undefined) await loadClassInSchool(payload.class_id, schoolId);
  if (payload.section_id) await loadSectionOfClass(payload.section_id, classId);
  /*
   * A class change that keeps the existing section would leave the entry pointing at a section of the
   * class it used to belong to — the pairing `POST` refuses and `PATCH` would otherwise allow, which
   * was §5a defect 47 in the exams module.
   */
  if (payload.class_id !== undefined && payload.section_id === undefined && existing && existing.section_id) {
    await loadSectionOfClass(existing.section_id, payload.class_id);
  }
  if (payload.teacher_id) await loadTeacherInSchool(payload.teacher_id, schoolId);
  if (payload.academic_session_id) await loadSessionInSchool(payload.academic_session_id, schoolId);
  if (payload.subject_id) {
    const subject = await db.Subject.findOne({ where: { id: payload.subject_id, school_id: schoolId } });
    if (!subject) {
      throw ApiError.validation('That subject is not in this school', [
        { field: 'subject_id', message: 'Unknown subject for this school' },
      ]);
    }
  }
}

const INCLUDES = Object.freeze([
  { model: db.Class, as: 'class', attributes: ['id', 'name'] },
  { model: db.Section, as: 'section', attributes: ['id', 'name'] },
  { model: db.Subject, as: 'subject', attributes: ['id', 'name', 'code'] },
  { model: db.Teacher, as: 'teacher', attributes: ['id', 'employee_id', 'first_name', 'last_name'] },
]);

async function list(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  for (const field of ['class_id', 'section_id', 'subject_id', 'teacher_id', 'academic_session_id', 'day_of_week', 'period_number', 'is_active']) {
    if (query[field] !== undefined) where[field] = query[field];
  }
  if (query.room) where.room = normaliseRoom(query.room);
  if (query.q) {
    where[Op.or] = [
      { period_label: { [Op.like]: `%${query.q}%` } },
      { room: { [Op.like]: `%${query.q}%` } },
    ];
  }

  /*
   * Unsorted, the list reads as the week does — day, then period — as the class and teacher views
   * already do. `getSort()` takes one fallback column, so the default used to be `day_of_week` alone,
   * and within a day the periods came back in primary-key order, which is the order they were typed.
   */
  const sortRequested = SORTABLE.includes(String(query.sortBy || '').trim());
  const order = sortRequested
    ? getSort({ query }, SORTABLE, ['day_of_week', 'ASC'])
    : [...WEEK_ORDER, ['id', 'ASC']];

  return paginateQuery(db.Timetable, { where, include: INCLUDES, order }, pagination);
}

async function create(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  await assertReferences(payload, school.id);

  const next = normaliseTimes(pick(payload));
  next.room = normaliseRoom(next.room);

  let row;
  try {
    row = await db.sequelize.transaction(async (transaction) => {
      await assertNoConflict(school.id, next, null, transaction);
      return db.Timetable.create(
        {
          school_id: school.id,
          organization_id: school.organization_id,
          created_by: req.user ? req.user.id : null,
          ...next,
        },
        { transaction }
      );
    });
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'timetables', recordId: row.id, event: 'create',
    before: null, after: snapshot(row), reason: payload.reason || null,
  });
  return row;
}

async function update(req, id, payload) {
  const row = await findEntry(req, id, payload.school_id);
  await assertReferences(payload, row.school_id, row);

  const before = snapshot(row);
  const next = normaliseTimes(pick(payload));
  if (Object.prototype.hasOwnProperty.call(next, 'room')) next.room = normaliseRoom(next.room);
  if (!Object.keys(next).length) {
    throw ApiError.validation('No timetable fields to update', [
      { field: 'body', message: 'Send at least one field' },
    ]);
  }

  try {
    await db.sequelize.transaction(async (transaction) => {
      /*
       * The conflict check runs against the row as it WILL be, not as it is — an edit that moves a
       * period, a teacher or a room has to be checked at its destination.
       */
      const merged = {
        class_id: next.class_id !== undefined ? next.class_id : row.class_id,
        section_id: next.section_id !== undefined ? next.section_id : row.section_id,
        teacher_id: next.teacher_id !== undefined ? next.teacher_id : row.teacher_id,
        room: next.room !== undefined ? next.room : row.room,
        day_of_week: next.day_of_week !== undefined ? next.day_of_week : row.day_of_week,
        period_number: next.period_number !== undefined ? next.period_number : row.period_number,
      };
      await assertNoConflict(row.school_id, merged, row.id, transaction);
      row.set(next);
      await row.save({ transaction });
    });
  } catch (err) {
    rethrow(err);
  }

  await recordAudit(req, {
    tableName: 'timetables', recordId: row.id, event: 'update',
    before, after: snapshot(row), reason: payload.reason || null,
  });
  return row;
}

/* ─────────────────────────── §20.1's two named views ─────────────────────────── */

/**
 * The Class Timetable — every slot for one class, in week order.
 *
 * Not paginated: a week is seven days by a handful of periods, and half a timetable is worse than
 * none. The attendance report is shaped the same way for the same reason.
 *
 * A section may be named to narrow the view, and when one is, the class-wide rows come with it —
 * because a class-wide row *is* that section's period too. That is the same rule
 * `assertNoConflict()` enforces, read instead of written, and a section timetable that omitted the
 * whole-class assembly would be wrong in the way a reader would not notice.
 */
async function classView(req, classId, query) {
  const school = await resolveSchool(req, query.school_id);
  const klass = await loadClassInSchool(classId, school.id);

  const where = { school_id: school.id, class_id: klass.id };
  if (query.section_id) {
    await loadSectionOfClass(query.section_id, klass.id);
    where[Op.or] = [{ section_id: query.section_id }, { section_id: null }];
  }
  if (query.academic_session_id) where.academic_session_id = query.academic_session_id;
  if (query.day_of_week) where.day_of_week = query.day_of_week;
  if (query.is_active !== undefined) where.is_active = query.is_active;

  const rows = await db.Timetable.findAll({ where, include: INCLUDES, order: WEEK_ORDER });
  return { class: klass, section_id: query.section_id || null, entries: rows };
}

/** The teacher columns a timetable may show — the same four its entries carry (`INCLUDES`). */
const TEACHER_HEADING = Object.freeze(['id', 'employee_id', 'first_name', 'last_name']);

/**
 * The Teacher Timetable — the same rows, filtered by teacher instead of by class.
 *
 * The teacher comes back as a heading and nothing more. `timetable.view` reaches Students, Parents,
 * Receptionists and Staff, and this route returned the whole `teachers` row — salary, notes, date of
 * birth, address, phone — to any of them for any teacher id in the school. `loadTeacherInSchool()` is a
 * membership check, not a projection, so its row is used for the check and never returned.
 */
async function teacherView(req, teacherId, query) {
  const school = await resolveSchool(req, query.school_id);
  const found = await loadTeacherInSchool(teacherId, school.id);
  const teacher = Object.fromEntries(TEACHER_HEADING.map((key) => [key, found.get(key)]));

  const where = { school_id: school.id, teacher_id: teacher.id };
  if (query.academic_session_id) where.academic_session_id = query.academic_session_id;
  if (query.day_of_week) where.day_of_week = query.day_of_week;
  if (query.is_active !== undefined) where.is_active = query.is_active;

  const rows = await db.Timetable.findAll({ where, include: INCLUDES, order: WEEK_ORDER });
  return { teacher, entries: rows };
}

module.exports = {
  list,
  findEntry,
  create,
  update,
  classView,
  teacherView,
  assertNoConflict,
  normaliseTime,
  normaliseRoom,
  WEEK_ORDER,
  EDITABLE,
};
