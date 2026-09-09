'use strict';

/**
 * Resolve which school a school-operations request is about.
 *
 * `tenantWhere()` is correct once the school is known. Getting *to* that id is a different
 * question: a Principal has it on `req.tenant`, a Super Admin must name it, and an organization
 * admin may name one of theirs. Naming another school's id is `CROSS_SCHOOL_ACCESS` — the same
 * code `coupons.controller.validateCode()` uses, for the same reason.
 *
 * Used by the Phase 3.I modules (`settings`, `sessions`, `classes`, `subjects`). Not a fifth
 * table and not a new permission.
 */

const db = require('../models');
const ApiError = require('./ApiError');

/**
 * @param {import('express').Request} req
 * @param {number|string|null} [requestedId]  from query or body
 * @returns {Promise<object>} the `schools` row
 */
async function resolveSchool(req, requestedId) {
  const tenant = req.tenant;
  if (!tenant) {
    throw new Error('resolveSchool() called without req.tenant — resolveTenant did not run');
  }

  const requested =
    requestedId !== undefined && requestedId !== null && requestedId !== ''
      ? Number(requestedId)
      : null;

  if (tenant.schoolId) {
    if (requested && requested !== Number(tenant.schoolId)) {
      throw ApiError.forbidden('This action is limited to your own school.', {
        code: 'CROSS_SCHOOL_ACCESS',
        details: { requested, allowed: Number(tenant.schoolId) },
      });
    }
    const school = await db.School.findByPk(tenant.schoolId);
    if (!school) throw ApiError.notFound('School not found', { code: 'SCHOOL_NOT_FOUND' });
    return school;
  }

  if (!requested) {
    throw ApiError.validation('"school_id" is required when the caller has no school in scope', [
      { field: 'school_id', message: 'Name the school' },
    ]);
  }

  const school = await db.School.findByPk(requested);
  if (!school) throw ApiError.notFound('School not found', { code: 'SCHOOL_NOT_FOUND' });

  if (tenant.organizationId && Number(school.organization_id) !== Number(tenant.organizationId)) {
    throw ApiError.forbidden('This action is limited to schools in your organization.', {
      code: 'CROSS_SCHOOL_ACCESS',
      details: { requested, organizationId: tenant.organizationId },
    });
  }

  if (!tenant.isPlatform && !tenant.organizationId) {
    throw ApiError.forbidden('This account is not scoped to a school', {
      code: 'TENANT_SCOPE_REQUIRED',
    });
  }

  return school;
}

/**
 * A class/section/subject teacher assignment may only name a `teachers` row of the same school.
 * There is no teachers API in this phase — the check is a `findOne`, not an invented endpoint.
 */
async function loadTeacherInSchool(teacherId, schoolId, field = 'teacher_id') {
  if (teacherId === undefined || teacherId === null || teacherId === '') return null;
  const teacher = await db.Teacher.findOne({ where: { id: teacherId, school_id: schoolId } });
  if (!teacher) {
    throw ApiError.validation('That teacher does not belong to this school', [
      { field, message: 'Name a teachers row of the same school' },
    ]);
  }
  return teacher;
}

/**
 * A `class_id` may only name a `classes` row of the same school.
 *
 * `subjects.service.js` carries private copies of this and of `loadSectionOfClass` from Phase 3.I,
 * written before there was a second caller. They are here now because §15 needs them too; the
 * copies in `subjects/` are left alone deliberately — that module is verified at 157 assertions and
 * converging it is a refactor, not a fix. A later session can collapse the two.
 */
async function loadClassInSchool(classId, schoolId, field = 'class_id') {
  if (classId === undefined || classId === null || classId === '') return null;
  const klass = await db.Class.findOne({ where: { id: classId, school_id: schoolId } });
  if (!klass) {
    throw ApiError.validation(`${field} must name a class of this school`, [
      { field, message: 'Name a classes row of the same school' },
    ]);
  }
  return klass;
}

/** A `section_id` may only name a section of the class it is given with. */
async function loadSectionOfClass(sectionId, classId, field = 'section_id') {
  if (sectionId === undefined || sectionId === null || sectionId === '') return null;
  const section = await db.Section.findOne({ where: { id: sectionId, class_id: classId } });
  if (!section) {
    throw ApiError.validation(`${field} must name a section of this class`, [
      { field, message: 'Name a sections row of this class' },
    ]);
  }
  return section;
}

/** An `academic_session_id` may only name a session of the same school. */
async function loadSessionInSchool(sessionId, schoolId, field = 'academic_session_id') {
  if (sessionId === undefined || sessionId === null || sessionId === '') return null;
  const session = await db.AcademicSession.findOne({ where: { id: sessionId, school_id: schoolId } });
  if (!session) {
    throw ApiError.validation(`${field} must name an academic session of this school`, [
      { field, message: 'Name an academic_sessions row of the same school' },
    ]);
  }
  return session;
}

module.exports = {
  resolveSchool,
  loadTeacherInSchool,
  loadClassInSchool,
  loadSectionOfClass,
  loadSessionInSchool,
};
