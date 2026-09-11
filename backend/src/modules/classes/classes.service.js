'use strict';

/**
 * Classes and sections — SRS §14.3, FR-SCHOOL-003.
 *
 * A class is unique per `(school_id, academic_session_id, name)`, so the same name may exist in
 * two sessions. Classes may be created on an upcoming session, not only the current one — a
 * Principal preparing next year should not have to activate it first.
 *
 * DELETE refuses on two separate grounds. First, while any `students` row still points at the
 * class or section (`CLASS_HAS_STUDENTS` / `SECTION_HAS_STUDENTS`): that FK is
 * `ON DELETE SET NULL`, which would silently unenroll them. Second, while any row in a table whose
 * FK is `ON DELETE CASCADE` still points at it (`CLASS_IN_USE` / `SECTION_IN_USE`): those rows
 * would be removed outright by MariaDB, below the application, so no `audit_logs` entry would ever
 * be written for them. See `CLASS_DEPENDENTS` / `SECTION_DEPENDENTS` below.
 */

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const { resolveSchool, loadTeacherInSchool, assertSessionOpen } = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');

const SORTABLE = Object.freeze(['id', 'name', 'numeric_order', 'is_active', 'created_at']);

function rethrow(err, payload, kind) {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    if (kind === 'section') {
      throw ApiError.conflict('A section with this name already exists in this class', {
        code: 'SECTION_NAME_TAKEN',
        details: { name: payload && payload.name },
      });
    }
    throw ApiError.conflict('A class with this name already exists in this session', {
      code: 'CLASS_NAME_TAKEN',
      details: { name: payload && payload.name },
    });
  }
  throw err;
}

async function loadSessionInSchool(sessionId, schoolId) {
  const session = await db.AcademicSession.findOne({ where: { id: sessionId, school_id: schoolId } });
  if (!session) {
    throw ApiError.validation('academic_session_id must name a session of this school', [
      { field: 'academic_session_id', message: 'Name an academic_sessions row of the same school' },
    ]);
  }
  return session;
}

async function findClass(req, id) {
  const row = await db.Class.findOne({
    where: tenantWhere(req.tenant, { id }),
    include: [{ model: db.Section, as: 'sections' }],
  });
  if (!row) throw ApiError.notFound('Class not found', { code: 'CLASS_NOT_FOUND' });
  return row;
}

async function findSection(req, classId, sectionId) {
  const klass = await findClass(req, classId);
  const section = await db.Section.findOne({
    where: tenantWhere(req.tenant, { id: sectionId, class_id: klass.id }),
  });
  if (!section) throw ApiError.notFound('Section not found', { code: 'SECTION_NOT_FOUND' });
  return { klass, section };
}

async function list(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  if (query.academic_session_id) where.academic_session_id = query.academic_session_id;
  if (query.is_active !== undefined) where.is_active = query.is_active;

  return paginateQuery(
    db.Class,
    {
      where,
      include: [{ model: db.Section, as: 'sections' }],
      order: getSort({ query }, SORTABLE, ['numeric_order', 'ASC']),
    },
    pagination
  );
}

async function create(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  /* D20 — a closed session takes no new class. */
  assertSessionOpen(await loadSessionInSchool(payload.academic_session_id, school.id), 'class');
  if (payload.class_teacher_id) {
    await loadTeacherInSchool(payload.class_teacher_id, school.id, 'class_teacher_id');
  }

  let row;
  try {
    row = await db.Class.create({
      school_id: school.id,
      organization_id: school.organization_id,
      academic_session_id: payload.academic_session_id,
      name: payload.name,
      code: payload.code ?? null,
      numeric_order: payload.numeric_order ?? 0,
      class_teacher_id: payload.class_teacher_id ?? null,
      capacity: payload.capacity ?? null,
      is_active: payload.is_active !== undefined ? payload.is_active : true,
      description: payload.description ?? null,
    });
  } catch (err) {
    rethrow(err, payload, 'class');
  }

  await recordAudit(req, {
    tableName: 'classes',
    recordId: row.id,
    event: 'create',
    before: null,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  return findClass(req, row.id);
}

async function update(req, id, payload) {
  const row = await findClass(req, id);
  if (payload.academic_session_id) {
    const session = await loadSessionInSchool(payload.academic_session_id, row.school_id);
    /*
     * D20 — moving a class into a closed session is adding one to it. Refusing only the create let a
     * class be made in an open year and then patched into a closed one; editing a class already in a
     * closed session, without moving it, is still allowed.
     */
    if (Number(payload.academic_session_id) !== Number(row.academic_session_id)) {
      assertSessionOpen(session, 'class');
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'class_teacher_id') && payload.class_teacher_id) {
    await loadTeacherInSchool(payload.class_teacher_id, row.school_id, 'class_teacher_id');
  }

  const before = snapshot(row);
  const next = {};
  for (const key of [
    'academic_session_id',
    'name',
    'code',
    'numeric_order',
    'class_teacher_id',
    'capacity',
    'is_active',
    'description',
  ]) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) next[key] = payload[key];
  }
  if (!Object.keys(next).length) {
    throw ApiError.validation('No class fields to update', [{ field: 'body', message: 'Send at least one field' }]);
  }

  row.set(next);
  try {
    await row.save();
  } catch (err) {
    rethrow(err, payload, 'class');
  }

  await recordAudit(req, {
    tableName: 'classes',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  return findClass(req, row.id);
}

/**
 * Tables whose FK to `classes` / `sections` is `ON DELETE CASCADE`.
 *
 * The student guard below covers `students.class_id` / `students.section_id`, which are
 * `ON DELETE SET NULL` — the rows survive and are merely unenrolled. Everything listed here is
 * the harder case: MariaDB removes the row outright, and because that happens at the database
 * layer nothing reaches `audit_logs`. This module audits a section deletion when it goes through
 * `destroySection`, so allowing the same row to vanish as a side effect of deleting its class
 * would contradict the module's own contract.
 *
 * The bar is already set by the student guard: if a class may not be deleted while rows would only
 * be *detached*, it certainly may not be deleted while rows would be *destroyed*. Deleting the
 * children explicitly first is the supported path, and each of those deletions is audited.
 */
const CLASS_DEPENDENTS = Object.freeze([
  ['Section', 'sections', 'class_id'],
  ['ClassSubject', 'class_subjects', 'class_id'],
  ['TeacherSubject', 'teacher_subjects', 'class_id'],
  ['Exam', 'exams', 'class_id'],
  ['FeeStructure', 'fee_structures', 'class_id'],
  ['Timetable', 'timetables', 'class_id'],
  ['Homework', 'homework', 'class_id'],
  ['Assignment', 'assignments', 'class_id'],
]);

const SECTION_DEPENDENTS = Object.freeze([
  ['ClassSubject', 'class_subjects', 'section_id'],
  ['TeacherSubject', 'teacher_subjects', 'section_id'],
  ['Exam', 'exams', 'section_id'],
  ['Timetable', 'timetables', 'section_id'],
  ['Homework', 'homework', 'section_id'],
  ['Assignment', 'assignments', 'section_id'],
]);

async function blockingDependents(dependents, id) {
  const blocking = {};
  for (const [model, table, column] of dependents) {
    /* eslint-disable-next-line no-await-in-loop */
    const count = await db[model].count({ where: { [column]: id } });
    if (count) blocking[table] = count;
  }
  return blocking;
}

async function destroy(req, id) {
  const row = await findClass(req, id);
  const enrolled = await db.Student.count({ where: { class_id: row.id } });
  if (enrolled) {
    throw ApiError.conflict('This class still has enrolled students', {
      code: 'CLASS_HAS_STUDENTS',
      details: { id: row.id, count: enrolled },
    });
  }

  const blocking = await blockingDependents(CLASS_DEPENDENTS, row.id);
  if (Object.keys(blocking).length) {
    throw ApiError.conflict('This class still has dependent records', {
      code: 'CLASS_IN_USE',
      details: { id: row.id, blocking },
    });
  }

  const before = snapshot(row);
  await row.destroy();
  await recordAudit(req, {
    tableName: 'classes',
    recordId: row.id,
    event: 'delete',
    before,
    after: null,
  });
  return row;
}

async function listSections(req, classId) {
  const klass = await findClass(req, classId);
  const rows = await db.Section.findAll({
    where: tenantWhere(req.tenant, { class_id: klass.id }),
    order: [['name', 'ASC']],
  });
  return { klass, rows };
}

async function createSection(req, classId, payload) {
  const klass = await findClass(req, classId);
  if (payload.class_teacher_id) {
    await loadTeacherInSchool(payload.class_teacher_id, klass.school_id, 'class_teacher_id');
  }

  let row;
  try {
    row = await db.Section.create({
      school_id: klass.school_id,
      organization_id: klass.organization_id,
      class_id: klass.id,
      name: payload.name,
      class_teacher_id: payload.class_teacher_id ?? null,
      capacity: payload.capacity ?? null,
      room: payload.room ?? null,
      is_active: payload.is_active !== undefined ? payload.is_active : true,
    });
  } catch (err) {
    rethrow(err, payload, 'section');
  }

  await recordAudit(req, {
    tableName: 'sections',
    recordId: row.id,
    event: 'create',
    before: null,
    after: snapshot(row),
    reason: payload.reason || null,
  });

  return row;
}

async function updateSection(req, classId, sectionId, payload) {
  const { section } = await findSection(req, classId, sectionId);
  if (Object.prototype.hasOwnProperty.call(payload, 'class_teacher_id') && payload.class_teacher_id) {
    await loadTeacherInSchool(payload.class_teacher_id, section.school_id, 'class_teacher_id');
  }

  const before = snapshot(section);
  const next = {};
  for (const key of ['name', 'class_teacher_id', 'capacity', 'room', 'is_active']) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) next[key] = payload[key];
  }
  if (!Object.keys(next).length) {
    throw ApiError.validation('No section fields to update', [{ field: 'body', message: 'Send at least one field' }]);
  }

  section.set(next);
  try {
    await section.save();
  } catch (err) {
    rethrow(err, payload, 'section');
  }

  await recordAudit(req, {
    tableName: 'sections',
    recordId: section.id,
    event: 'update',
    before,
    after: snapshot(section),
    reason: payload.reason || null,
  });

  return section;
}

async function destroySection(req, classId, sectionId) {
  const { section } = await findSection(req, classId, sectionId);
  const enrolled = await db.Student.count({ where: { section_id: section.id } });
  if (enrolled) {
    throw ApiError.conflict('This section still has enrolled students', {
      code: 'SECTION_HAS_STUDENTS',
      details: { id: section.id, count: enrolled },
    });
  }

  const blocking = await blockingDependents(SECTION_DEPENDENTS, section.id);
  if (Object.keys(blocking).length) {
    throw ApiError.conflict('This section still has dependent records', {
      code: 'SECTION_IN_USE',
      details: { id: section.id, blocking },
    });
  }

  const before = snapshot(section);
  await section.destroy();
  await recordAudit(req, {
    tableName: 'sections',
    recordId: section.id,
    event: 'delete',
    before,
    after: null,
  });
  return section;
}

module.exports = {
  list,
  findClass,
  create,
  update,
  destroy,
  listSections,
  createSection,
  updateSection,
  destroySection,
};
