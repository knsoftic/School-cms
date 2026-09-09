'use strict';

/**
 * People tables — SRS §29 "People", §15:
 *   students · parents · parent_students · teachers · staff
 *
 * Each of these is a *profile* row that hangs off a `users` row (the login), because
 * SRS §5 defines Student, Parent, Teacher and Staff as roles that authenticate.
 * `user_id` is nullable only where a school records someone who has no portal login yet.
 */

const {
  DataTypes,
  id,
  fk,
  organizationId,
  schoolId,
  academicSessionId,
  money,
  enumOf,
  json,
  modelOptions,
  softDeleteOptions,
} = require('./columns');

const { STUDENT_STATUS, GENDERS, STAFF_CATEGORIES } = require('../config/constants');

module.exports = (sequelize) => {
  /* ─────────────────────────────── students ─────────────────────────────── */

  /** SRS §15.1 — Admission, Profile, Photo, Documents, Class/Section, Student ID, Roll No. */
  const Student = sequelize.define(
    'Student',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      user_id: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Login for the student portal, when one has been issued',
      }),

      /** SRS §15.1 — Student ID (unique within the school). */
      student_id: { type: DataTypes.STRING(60), allowNull: false },
      /** SRS §15.1 — Roll Number (unique within class+section+session). */
      roll_number: { type: DataTypes.STRING(40), allowNull: true },
      admission_number: { type: DataTypes.STRING(60), allowNull: true },
      /** SRS §15.1 — Admission. */
      admission_date: { type: DataTypes.DATEONLY, allowNull: false },
      admission_session_id: academicSessionId(),

      /** SRS §15.1 — Student Profile. */
      first_name: { type: DataTypes.STRING(90), allowNull: false },
      last_name: { type: DataTypes.STRING(90), allowNull: true },
      gender: enumOf(GENDERS, { allowNull: true, defaultValue: null }),
      date_of_birth: { type: DataTypes.DATEONLY, allowNull: true },
      blood_group: { type: DataTypes.STRING(10), allowNull: true },
      religion: { type: DataTypes.STRING(60), allowNull: true },
      nationality: { type: DataTypes.STRING(60), allowNull: true },
      email: { type: DataTypes.STRING(180), allowNull: true, validate: { isEmail: true } },
      phone: { type: DataTypes.STRING(40), allowNull: true },
      address: { type: DataTypes.STRING(255), allowNull: true },
      city: { type: DataTypes.STRING(90), allowNull: true },
      guardian_name: { type: DataTypes.STRING(160), allowNull: true },
      guardian_phone: { type: DataTypes.STRING(40), allowNull: true },
      guardian_relation: { type: DataTypes.STRING(60), allowNull: true },
      emergency_contact: { type: DataTypes.STRING(40), allowNull: true },
      /** SRS §15.1 — Student Photo. Supporting files live in `documents`. */
      photo_path: { type: DataTypes.STRING(255), allowNull: true },

      /** SRS §15.1 — Class Assignment / Section Assignment. */
      class_id: fk({
        allowNull: true,
        references: { model: 'classes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      section_id: fk({
        allowNull: true,
        references: { model: 'sections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      academic_session_id: academicSessionId(),

      /** SRS §15.1 — Promotion / Transfer / Leaving (FR-STUDENT-002). */
      status: enumOf(STUDENT_STATUS, { defaultValue: STUDENT_STATUS.ACTIVE }),
      promoted_at: { type: DataTypes.DATE, allowNull: true },
      /** Where the student came from on the last promotion, for an auditable trail. */
      previous_class_id: fk({
        allowNull: true,
        references: { model: 'classes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      transferred_at: { type: DataTypes.DATE, allowNull: true },
      transfer_to: { type: DataTypes.STRING(180), allowNull: true, comment: 'Destination school name' },
      left_at: { type: DataTypes.DATE, allowNull: true },
      leaving_reason: { type: DataTypes.STRING(255), allowNull: true },

      /** Set when a transport fee component should apply to this student (SRS §17). */
      uses_transport: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      notes: { type: DataTypes.TEXT, allowNull: true },
      metadata: json(),
    },
    softDeleteOptions('students', {
      indexes: [
        { unique: true, fields: ['school_id', 'student_id'], name: 'students_school_studentid_unique' },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['user_id'] },
        { fields: ['class_id'] },
        { fields: ['section_id'] },
        { fields: ['status'] },
        { fields: ['school_id', 'status'] },
        { fields: ['section_id', 'roll_number'] },
      ],
    })
  );

  /* ─────────────────────────────── parents ─────────────────────────────── */

  /** SRS §15.2 — Parent Account (FR-PARENT-001). */
  const Parent = sequelize.define(
    'Parent',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      user_id: fk({
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
        comment: 'A parent account always has a login — the Parent Dashboard requires it',
      }),
      name: { type: DataTypes.STRING(160), allowNull: false },
      relation: { type: DataTypes.STRING(60), allowNull: true, comment: 'father | mother | guardian | …' },
      email: { type: DataTypes.STRING(180), allowNull: true, validate: { isEmail: true } },
      phone: { type: DataTypes.STRING(40), allowNull: true },
      occupation: { type: DataTypes.STRING(120), allowNull: true },
      address: { type: DataTypes.STRING(255), allowNull: true },
      national_id: { type: DataTypes.STRING(60), allowNull: true },
      photo_path: { type: DataTypes.STRING(255), allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    softDeleteOptions('parents', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { unique: true, fields: ['user_id'], name: 'parents_user_unique' },
      ],
    })
  );

  /* ─────────────────────────────── parent_students ─────────────────────────────── */

  /** SRS §15.2 — Multiple Children: one parent account links to many students. */
  const ParentStudent = sequelize.define(
    'ParentStudent',
    {
      id: id(),
      school_id: schoolId(),
      parent_id: fk({ references: { model: 'parents', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      student_id: fk({ references: { model: 'students', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      relation: { type: DataTypes.STRING(60), allowNull: true },
      /** The contact to notify first for this student. */
      is_primary_guardian: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    },
    modelOptions('parent_students', {
      indexes: [
        { unique: true, fields: ['parent_id', 'student_id'], name: 'parent_students_unique' },
        { fields: ['school_id'] },
        { fields: ['student_id'] },
      ],
    })
  );

  /* ─────────────────────────────── teachers ─────────────────────────────── */

  /** SRS §15.3 — Teacher Profile, Qualification, Joining Date. */
  const Teacher = sequelize.define(
    'Teacher',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      user_id: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      employee_id: { type: DataTypes.STRING(60), allowNull: false },
      first_name: { type: DataTypes.STRING(90), allowNull: false },
      last_name: { type: DataTypes.STRING(90), allowNull: true },
      gender: enumOf(GENDERS, { allowNull: true, defaultValue: null }),
      date_of_birth: { type: DataTypes.DATEONLY, allowNull: true },
      email: { type: DataTypes.STRING(180), allowNull: true, validate: { isEmail: true } },
      phone: { type: DataTypes.STRING(40), allowNull: true },
      address: { type: DataTypes.STRING(255), allowNull: true },
      photo_path: { type: DataTypes.STRING(255), allowNull: true },
      /** SRS §15.3 — Qualification. */
      qualification: { type: DataTypes.STRING(255), allowNull: true },
      specialization: { type: DataTypes.STRING(160), allowNull: true },
      experience_years: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
      /** SRS §15.3 — Joining Date. */
      joining_date: { type: DataTypes.DATEONLY, allowNull: false },
      /** Feeds the Salaries expense category (SRS §18). */
      salary: money({ allowNull: true, defaultValue: null }),
      designation: { type: DataTypes.STRING(120), allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      left_at: { type: DataTypes.DATE, allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      metadata: json(),
    },
    softDeleteOptions('teachers', {
      indexes: [
        { unique: true, fields: ['school_id', 'employee_id'], name: 'teachers_school_employee_unique' },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['user_id'] },
        { fields: ['is_active'] },
      ],
    })
  );

  /* ─────────────────────────────── staff ─────────────────────────────── */

  /** SRS §15.4 — Receptionist / Accountant / Librarian / Other Staff (FR-STAFF-001). */
  const Staff = sequelize.define(
    'Staff',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      user_id: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      employee_id: { type: DataTypes.STRING(60), allowNull: false },
      /** SRS §15.4 — the four staff categories. */
      category: enumOf(STAFF_CATEGORIES, { defaultValue: STAFF_CATEGORIES.OTHER_STAFF }),
      first_name: { type: DataTypes.STRING(90), allowNull: false },
      last_name: { type: DataTypes.STRING(90), allowNull: true },
      gender: enumOf(GENDERS, { allowNull: true, defaultValue: null }),
      date_of_birth: { type: DataTypes.DATEONLY, allowNull: true },
      email: { type: DataTypes.STRING(180), allowNull: true, validate: { isEmail: true } },
      phone: { type: DataTypes.STRING(40), allowNull: true },
      address: { type: DataTypes.STRING(255), allowNull: true },
      photo_path: { type: DataTypes.STRING(255), allowNull: true },
      qualification: { type: DataTypes.STRING(255), allowNull: true },
      designation: { type: DataTypes.STRING(120), allowNull: true },
      joining_date: { type: DataTypes.DATEONLY, allowNull: false },
      salary: money({ allowNull: true, defaultValue: null }),
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      left_at: { type: DataTypes.DATE, allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      metadata: json(),
    },
    softDeleteOptions('staff', {
      indexes: [
        { unique: true, fields: ['school_id', 'employee_id'], name: 'staff_school_employee_unique' },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['user_id'] },
        { fields: ['category'] },
        { fields: ['is_active'] },
      ],
    })
  );

  return { Student, Parent, ParentStudent, Teacher, Staff };
};
