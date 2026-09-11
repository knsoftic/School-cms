'use strict';

/**
 * The students a signed-in student or parent may read about — the self-service half of SRS §5.
 *
 * SRS:105 gives a Student "access relevant to their own records within their school", and §15.2 a
 * Parent the records "for all linked children" (SRS:835). The owner's decision D17 built the read-only
 * views that say so — attendance, fees and the student record — on the three self-view keys the
 * catalogue already granted and nothing mounted (`students.self.view`, `attendance.self.view`,
 * `fees.self.view`). This is the one answer they share to "whose records are these?", so the three
 * cannot drift apart: `exams.myResults()` answers the same question the same way for results.
 *
 * Both profiles are consulted, not just the first one found. Nothing stops one account being both a
 * student and a parent — an adult learner with a child enrolled — and resolving only the student half
 * silently hid the children once already (`exams.myResults()`, §5a session 19).
 *
 * `parent_students` carries `school_id` but no `organization_id`, so it is scoped by the parent's school
 * rather than through `tenantWhere()`, as every other reader of it is.
 */

const { Op } = require('sequelize');

const db = require('../models');
const ApiError = require('../utils/ApiError');

const { tenantWhere } = db;

/**
 * Ids of the caller's own student record and of every child linked to them.
 *
 * @param {import('express').Request} req
 * @returns {Promise<number[]>} possibly empty — a parent with no children linked yet
 */
async function linkedStudentIds(req) {
  if (!req.user || !req.user.id) {
    throw ApiError.unauthenticated('This view is for a signed-in student or parent');
  }

  const ids = new Set();
  const student = await db.Student.findOne({ where: tenantWhere(req.tenant, { user_id: req.user.id }) });
  if (student) ids.add(Number(student.id));

  const parent = await db.Parent.findOne({ where: tenantWhere(req.tenant, { user_id: req.user.id }) });
  if (parent) {
    if (!parent.is_active) {
      throw ApiError.forbidden('This parent account is no longer active', {
        code: 'PARENT_INACTIVE',
        details: { parent_id: parent.id },
      });
    }
    const links = await db.ParentStudent.findAll({
      where: { parent_id: parent.id, school_id: parent.school_id },
      attributes: ['student_id'],
    });
    for (const link of links) ids.add(Number(link.student_id));
  }

  if (!student && !parent) {
    throw ApiError.notFound('No student or parent profile is linked to this account', {
      code: 'SELF_PROFILE_MISSING',
      details: { user_id: req.user.id },
    });
  }
  return [...ids];
}

/**
 * Narrow to one child when the caller names one — but only to one of theirs.
 *
 * @param {number[]} ids        from `linkedStudentIds()`
 * @param {number|string} [studentId]
 * @returns {number[]}
 */
function pickLinked(ids, studentId) {
  if (studentId === undefined || studentId === null || studentId === '') return ids;
  if (!ids.includes(Number(studentId))) {
    throw ApiError.forbidden('That student is not linked to this account', {
      code: 'STUDENT_NOT_LINKED',
      details: { student_id: studentId },
    });
  }
  return [Number(studentId)];
}

/** The linked students themselves, named and placed — what every self-service view heads its rows with. */
async function linkedStudents(ids, attributes = ['id', 'school_id', 'student_id', 'roll_number', 'first_name', 'last_name', 'status']) {
  if (!ids.length) return [];
  return db.Student.findAll({
    where: { id: { [Op.in]: ids } },
    attributes: [...new Set([...attributes, 'class_id', 'section_id', 'academic_session_id'])],
    include: [
      { model: db.Class, as: 'class', attributes: ['id', 'name'] },
      { model: db.Section, as: 'section', attributes: ['id', 'name'] },
      { model: db.AcademicSession, as: 'academicSession', attributes: ['id', 'name'] },
    ],
    order: [['first_name', 'ASC'], ['id', 'ASC']],
  });
}

module.exports = { linkedStudentIds, pickLinked, linkedStudents };
