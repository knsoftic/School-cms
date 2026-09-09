'use strict';

/**
 * Subjects, class assignment, teacher assignment — SRS §14.4, FR-SCHOOL-004.
 *
 * `class_subjects` unique is `(class_id, section_id, subject_id)` and `teacher_subjects` unique is
 * `(teacher_id, subject_id, class_id, section_id)`. MySQL unique indexes allow multiple NULLs, so
 * two "whole class" assignments of the same subject would both insert. The lookups below use
 * `Op.is` for a missing section/class rather than trusting the unique name.
 *
 * Naming `teacher_id` on a class-subject also upserts `teacher_subjects` for that teacher +
 * subject + class + section, so the two tables stay consistent without a teachers module.
 */

const { Op } = require('sequelize');

const db = require('../../models');
const { tenantWhere } = require('../../models');
const ApiError = require('../../utils/ApiError');
const { resolveSchool, loadTeacherInSchool } = require('../../utils/schoolScope');
const { paginateQuery, getSort } = require('../../utils/pagination');
const { recordAudit, snapshot } = require('../../middlewares/activityLog');

const SORTABLE = Object.freeze(['id', 'name', 'code', 'type', 'is_active', 'created_at']);

function nullKey(value) {
  return value === undefined || value === null || value === '' ? { [Op.is]: null } : value;
}

/**
 * Scope a `class_subjects` / `teacher_subjects` query by its already-resolved parent subject.
 *
 * These two tables are the only ones this module touches that carry `school_id` **without**
 * `organization_id` (see `src/models/academic.js`). `tenantWhere()` is model-agnostic: for a caller
 * with an organization but no school in scope it writes `organization_id` into the WHERE clause,
 * which MariaDB then rejects with `Unknown column 'ClassSubject.organization_id' in 'where clause'`
 * — a 500, not a leak. That branch is unreachable for the default role grants (only super_admin,
 * principal, school_admin, teacher and receptionist hold the `subjects.*` keys, and none of them
 * resolves to an organization-without-school tenant), which is why it never surfaced in a run; but
 * role grants are database-driven and editable through `PUT /roles/:id/permissions`, so the branch
 * is one grant away from being live.
 *
 * Scoping by the parent instead is not a weaker check: `subject` reached this function through
 * `findSubject()`, which is itself `tenantWhere`-confined against `subjects` (a table that does
 * carry both columns), so the parent is already proven in-tenant and the child must share its
 * school.
 */
function childScope(subject, where) {
  return { ...where, school_id: subject.school_id };
}

/**
 * `kind` matters because three different unique indexes can surface here. The locking reads in
 * `assignClass` / `assignTeacher` catch the duplicate first in every case they can, but the
 * assignment indexes still enforce directly whenever the nullable half of the key is populated
 * (a section-specific assignment), and a violation from those must not be reported as a duplicate
 * subject *code* — which is what this function said for every unique error before.
 */
function rethrow(err, payload, kind = 'subject') {
  if (err instanceof db.Sequelize.UniqueConstraintError) {
    if (kind === 'class_subject') {
      throw ApiError.conflict('This subject is already assigned to that class', {
        code: 'CLASS_SUBJECT_TAKEN',
        details: { class_id: payload && payload.class_id, section_id: (payload && payload.section_id) || null },
      });
    }
    if (kind === 'teacher_subject') {
      throw ApiError.conflict('This teacher is already assigned to that subject', {
        code: 'TEACHER_SUBJECT_TAKEN',
        details: { teacher_id: payload && payload.teacher_id, class_id: (payload && payload.class_id) || null },
      });
    }
    throw ApiError.conflict('A subject with this code already exists at this school', {
      code: 'SUBJECT_CODE_TAKEN',
      details: { code: payload && payload.code },
    });
  }
  if (err instanceof db.Sequelize.ValidationError) {
    throw ApiError.validation(err.message, err.errors.map((e) => ({ field: e.path, message: e.message })));
  }
  throw err;
}

async function findSubject(req, id) {
  const row = await db.Subject.findOne({ where: tenantWhere(req.tenant, { id }) });
  if (!row) throw ApiError.notFound('Subject not found', { code: 'SUBJECT_NOT_FOUND' });
  return row;
}

async function loadClassInSchool(classId, schoolId) {
  const klass = await db.Class.findOne({ where: { id: classId, school_id: schoolId } });
  if (!klass) {
    throw ApiError.validation('class_id must name a class of this school', [
      { field: 'class_id', message: 'Name a classes row of the same school' },
    ]);
  }
  return klass;
}

async function loadSectionOfClass(sectionId, classId) {
  if (sectionId === undefined || sectionId === null || sectionId === '') return null;
  const section = await db.Section.findOne({ where: { id: sectionId, class_id: classId } });
  if (!section) {
    throw ApiError.validation('section_id must name a section of this class', [
      { field: 'section_id', message: 'Name a sections row of this class' },
    ]);
  }
  return section;
}

/**
 * The duplicate lookups below take an optional transaction, and every caller that follows them
 * with an INSERT passes one with `lock: t.LOCK.UPDATE`.
 *
 * Without that, check-then-insert is a race the database cannot close: `class_subjects_unique` is
 * `(class_id, section_id, subject_id)` and `teacher_subjects_unique` is
 * `(teacher_id, subject_id, class_id, section_id)`, but MySQL treats NULL as distinct inside a
 * UNIQUE index, so two concurrent "whole class" assignments — the case where `section_id` is NULL —
 * both pass the lookup and both insert. The index rejects neither. A locking read serialises the
 * pair, which is the only backstop available while the key stays nullable.
 */
async function findClassSubject(classId, sectionId, subjectId, options = {}) {
  return db.ClassSubject.findOne({
    where: {
      class_id: classId,
      subject_id: subjectId,
      section_id: nullKey(sectionId),
    },
    ...options,
  });
}

async function findTeacherSubject(teacherId, subjectId, classId, sectionId, options = {}) {
  return db.TeacherSubject.findOne({
    where: {
      teacher_id: teacherId,
      subject_id: subjectId,
      class_id: nullKey(classId),
      section_id: nullKey(sectionId),
    },
    ...options,
  });
}

async function upsertTeacherSubject({ schoolId, teacherId, subjectId, classId, sectionId }, t) {
  const existing = await findTeacherSubject(teacherId, subjectId, classId, sectionId, {
    transaction: t,
    lock: t ? t.LOCK.UPDATE : undefined,
  });
  if (existing) {
    if (!existing.is_active) {
      existing.is_active = true;
      await existing.save({ transaction: t });
    }
    return existing;
  }
  return db.TeacherSubject.create(
    {
      school_id: schoolId,
      teacher_id: teacherId,
      subject_id: subjectId,
      class_id: classId || null,
      section_id: sectionId || null,
      is_primary: true,
      is_active: true,
    },
    { transaction: t }
  );
}

async function list(req, query, pagination) {
  const where = tenantWhere(req.tenant, {});
  if (query.school_id) {
    const school = await resolveSchool(req, query.school_id);
    where.school_id = school.id;
  }
  if (query.type) where.type = query.type;
  if (query.is_active !== undefined) where.is_active = query.is_active;
  if (query.is_elective !== undefined) where.is_elective = query.is_elective;

  return paginateQuery(
    db.Subject,
    { where, order: getSort({ query }, SORTABLE, ['name', 'ASC']) },
    pagination
  );
}

async function create(req, payload) {
  const school = await resolveSchool(req, payload.school_id);
  let row;
  try {
    row = await db.Subject.create({
      school_id: school.id,
      organization_id: school.organization_id,
      name: payload.name,
      code: payload.code,
      type: payload.type || 'theory',
      is_elective: payload.is_elective !== undefined ? payload.is_elective : false,
      is_active: payload.is_active !== undefined ? payload.is_active : true,
      description: payload.description ?? null,
    });
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'subjects',
    recordId: row.id,
    event: 'create',
    before: null,
    after: snapshot(row),
    reason: payload.reason || null,
  });
  return row;
}

async function update(req, id, payload) {
  const row = await findSubject(req, id);
  const before = snapshot(row);
  const next = {};
  for (const key of ['name', 'code', 'type', 'is_elective', 'is_active', 'description']) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) next[key] = payload[key];
  }
  if (!Object.keys(next).length) {
    throw ApiError.validation('No subject fields to update', [{ field: 'body', message: 'Send at least one field' }]);
  }

  row.set(next);
  try {
    await row.save();
  } catch (err) {
    rethrow(err, payload);
  }

  await recordAudit(req, {
    tableName: 'subjects',
    recordId: row.id,
    event: 'update',
    before,
    after: snapshot(row),
    reason: payload.reason || null,
  });
  return row;
}

/**
 * Tables whose FK to `subjects` is `ON DELETE CASCADE`, so a hard delete of the parent removes
 * them at the database layer with nothing written to `audit_logs`.
 *
 * `exam_subjects` is the one that matters most: `marks.exam_subject_id` cascades in turn, so
 * deleting a subject would delete every mark recorded against it. The exams module does not exist
 * yet, so those two tables are unwritable today and the live loss is confined to the two
 * assignment tables — but this module audits exactly those rows when they are removed through
 * `unassignClass` / `unassignTeacher`, so letting the cascade take them silently is inconsistent
 * with the module's own contract, and becomes a marks-destroying hazard the moment §17 lands.
 *
 * Every other reference to `subjects` (`timetables`, `homework`, `assignments`, `questions`,
 * `question_banks`, `online_exams`) is `ON DELETE SET NULL` — those rows survive, so they do not
 * block the delete.
 */
const SUBJECT_DEPENDENTS = Object.freeze([
  ['ClassSubject', 'class_subjects'],
  ['TeacherSubject', 'teacher_subjects'],
  ['ExamSubject', 'exam_subjects'],
]);

async function destroy(req, id) {
  const row = await findSubject(req, id);

  const blocking = {};
  for (const [model, table] of SUBJECT_DEPENDENTS) {
    /* eslint-disable-next-line no-await-in-loop */
    const count = await db[model].count({ where: { subject_id: row.id } });
    if (count) blocking[table] = count;
  }
  if (Object.keys(blocking).length) {
    throw ApiError.conflict('This subject is still in use', {
      code: 'SUBJECT_IN_USE',
      details: { id: row.id, blocking },
    });
  }

  const before = snapshot(row);
  await row.destroy();
  await recordAudit(req, {
    tableName: 'subjects',
    recordId: row.id,
    event: 'delete',
    before,
    after: null,
  });
  return row;
}

async function listClassAssignments(req, subjectId) {
  const subject = await findSubject(req, subjectId);
  const rows = await db.ClassSubject.findAll({
    where: childScope(subject, { subject_id: subject.id }),
    include: [
      { model: db.Class, as: 'class', attributes: ['id', 'name', 'academic_session_id'] },
      { model: db.Section, as: 'section', attributes: ['id', 'name'] },
      { model: db.Teacher, as: 'teacher', attributes: ['id', 'employee_id', 'first_name', 'last_name'] },
    ],
    order: [['id', 'ASC']],
  });
  return { subject, rows };
}

async function assignClass(req, subjectId, payload) {
  const subject = await findSubject(req, subjectId);
  const klass = await loadClassInSchool(payload.class_id, subject.school_id);
  await loadSectionOfClass(payload.section_id, klass.id);
  if (payload.teacher_id) {
    await loadTeacherInSchool(payload.teacher_id, subject.school_id, 'teacher_id');
  }

  let row;
  try {
    row = await db.sequelize.transaction(async (t) => {
      const existing = await findClassSubject(klass.id, payload.section_id, subject.id, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (existing) {
        throw ApiError.conflict('This subject is already assigned to that class', {
          code: 'CLASS_SUBJECT_TAKEN',
          details: { class_id: klass.id, section_id: payload.section_id || null, subject_id: subject.id },
        });
      }

      const created = await db.ClassSubject.create(
        {
          school_id: subject.school_id,
          class_id: klass.id,
          section_id: payload.section_id || null,
          subject_id: subject.id,
          teacher_id: payload.teacher_id || null,
          full_marks: payload.full_marks ?? null,
          passing_marks: payload.passing_marks ?? null,
          weekly_periods: payload.weekly_periods ?? null,
          is_active: payload.is_active !== undefined ? payload.is_active : true,
        },
        { transaction: t }
      );

      if (payload.teacher_id) {
        await upsertTeacherSubject(
          {
            schoolId: subject.school_id,
            teacherId: payload.teacher_id,
            subjectId: subject.id,
            classId: klass.id,
            sectionId: payload.section_id || null,
          },
          t
        );
      }

      return created;
    });
  } catch (err) {
    rethrow(err, payload, 'class_subject');
  }

  await recordAudit(req, {
    tableName: 'class_subjects',
    recordId: row.id,
    event: 'create',
    before: null,
    after: snapshot(row),
    reason: payload.reason || null,
  });
  return row;
}

async function unassignClass(req, subjectId, assignmentId) {
  const subject = await findSubject(req, subjectId);
  const row = await db.ClassSubject.findOne({
    where: childScope(subject, { id: assignmentId, subject_id: subject.id }),
  });
  if (!row) throw ApiError.notFound('Class assignment not found', { code: 'CLASS_SUBJECT_NOT_FOUND' });

  const before = snapshot(row);
  await row.destroy();
  await recordAudit(req, {
    tableName: 'class_subjects',
    recordId: row.id,
    event: 'delete',
    before,
    after: null,
  });
  return row;
}

async function listTeacherAssignments(req, subjectId) {
  const subject = await findSubject(req, subjectId);
  const rows = await db.TeacherSubject.findAll({
    where: childScope(subject, { subject_id: subject.id }),
    include: [
      { model: db.Teacher, as: 'teacher', attributes: ['id', 'employee_id', 'first_name', 'last_name'] },
      { model: db.Class, as: 'class', attributes: ['id', 'name'] },
      { model: db.Section, as: 'section', attributes: ['id', 'name'] },
    ],
    order: [['id', 'ASC']],
  });
  return { subject, rows };
}

async function assignTeacher(req, subjectId, payload) {
  const subject = await findSubject(req, subjectId);
  await loadTeacherInSchool(payload.teacher_id, subject.school_id, 'teacher_id');
  let classId = payload.class_id || null;
  let sectionId = payload.section_id || null;
  if (classId) {
    const klass = await loadClassInSchool(classId, subject.school_id);
    await loadSectionOfClass(sectionId, klass.id);
  } else if (sectionId) {
    throw ApiError.validation('section_id requires class_id', [
      { field: 'class_id', message: 'Name the class this section belongs to' },
    ]);
  }

  let row;
  try {
    row = await db.sequelize.transaction(async (t) => {
      const existing = await findTeacherSubject(payload.teacher_id, subject.id, classId, sectionId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (existing) {
        throw ApiError.conflict('This teacher is already assigned to that subject', {
          code: 'TEACHER_SUBJECT_TAKEN',
          details: {
            teacher_id: payload.teacher_id,
            subject_id: subject.id,
            class_id: classId,
            section_id: sectionId,
          },
        });
      }

      return db.TeacherSubject.create(
        {
          school_id: subject.school_id,
          teacher_id: payload.teacher_id,
          subject_id: subject.id,
          class_id: classId,
          section_id: sectionId,
          is_primary: payload.is_primary !== undefined ? payload.is_primary : true,
          is_active: payload.is_active !== undefined ? payload.is_active : true,
        },
        { transaction: t }
      );
    });
  } catch (err) {
    rethrow(err, payload, 'teacher_subject');
  }

  await recordAudit(req, {
    tableName: 'teacher_subjects',
    recordId: row.id,
    event: 'create',
    before: null,
    after: snapshot(row),
    reason: payload.reason || null,
  });
  return row;
}

async function unassignTeacher(req, subjectId, assignmentId) {
  const subject = await findSubject(req, subjectId);
  const row = await db.TeacherSubject.findOne({
    where: childScope(subject, { id: assignmentId, subject_id: subject.id }),
  });
  if (!row) throw ApiError.notFound('Teacher assignment not found', { code: 'TEACHER_SUBJECT_NOT_FOUND' });

  const before = snapshot(row);
  await row.destroy();
  await recordAudit(req, {
    tableName: 'teacher_subjects',
    recordId: row.id,
    event: 'delete',
    before,
    after: null,
  });
  return row;
}

module.exports = {
  list,
  findSubject,
  create,
  update,
  destroy,
  listClassAssignments,
  assignClass,
  unassignClass,
  listTeacherAssignments,
  assignTeacher,
  unassignTeacher,
};
