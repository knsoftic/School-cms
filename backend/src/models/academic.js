'use strict';

/**
 * Academic tables — SRS §29 "Academic", §14.3–§14.4:
 *   classes · sections · subjects · class_subjects · teacher_subjects
 *
 * SRS §14.3 lists "Classes, Sections, Class Teachers, Subjects" and §14.4 lists
 * "Subject Creation, Subject Assignment, Teacher Assignment". Class-teacher assignment
 * is a column on `classes`/`sections` (FR-SCHOOL-003), subject↔class association is
 * `class_subjects` and subject↔teacher association is `teacher_subjects` (FR-SCHOOL-004).
 */

const {
  DataTypes,
  id,
  fk,
  organizationId,
  schoolId,
  academicSessionId,
  enumOf,
  modelOptions,
} = require('./columns');

module.exports = (sequelize) => {
  /* ─────────────────────────────── classes ─────────────────────────────── */

  const Class = sequelize.define(
    'Class',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      /** Classes belong to an academic session so a new session can restructure them. */
      academic_session_id: academicSessionId(),
      name: { type: DataTypes.STRING(90), allowNull: false, comment: 'e.g. Grade 5' },
      code: { type: DataTypes.STRING(40), allowNull: true },
      /** Ordering key used for promotion (next class = same school, numeric_order + 1). */
      numeric_order: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Sort/progression order; drives default promotion target (FR-STUDENT-002)',
      },
      /** SRS §14.3 — Class Teachers. */
      class_teacher_id: fk({
        allowNull: true,
        references: { model: 'teachers', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      capacity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      description: { type: DataTypes.STRING(255), allowNull: true },
    },
    modelOptions('classes', {
      indexes: [
        {
          unique: true,
          fields: ['school_id', 'academic_session_id', 'name'],
          name: 'classes_school_session_name_unique',
        },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['academic_session_id'] },
        { fields: ['class_teacher_id'] },
      ],
    })
  );

  /* ─────────────────────────────── sections ─────────────────────────────── */

  const Section = sequelize.define(
    'Section',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      class_id: fk({ references: { model: 'classes', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      name: { type: DataTypes.STRING(60), allowNull: false, comment: 'e.g. A' },
      /** SRS §14.3 — Class Teachers may be assigned at section level. */
      class_teacher_id: fk({
        allowNull: true,
        references: { model: 'teachers', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      capacity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      room: { type: DataTypes.STRING(60), allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    modelOptions('sections', {
      indexes: [
        { unique: true, fields: ['class_id', 'name'], name: 'sections_class_name_unique' },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['class_teacher_id'] },
      ],
    })
  );

  /* ─────────────────────────────── subjects ─────────────────────────────── */

  /** SRS §14.4 — Subject Creation (FR-SCHOOL-004). */
  const Subject = sequelize.define(
    'Subject',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      name: { type: DataTypes.STRING(120), allowNull: false },
      code: { type: DataTypes.STRING(40), allowNull: false },
      type: enumOf(['theory', 'practical', 'both'], { defaultValue: 'theory' }),
      /** Optional flag so optional subjects can be excluded from result aggregation. */
      is_elective: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      description: { type: DataTypes.STRING(255), allowNull: true },
    },
    modelOptions('subjects', {
      indexes: [
        { unique: true, fields: ['school_id', 'code'], name: 'subjects_school_code_unique' },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
      ],
    })
  );

  /* ─────────────────────────────── class_subjects ─────────────────────────────── */

  /** SRS §14.4 — Subject Assignment: which subjects a class studies. */
  const ClassSubject = sequelize.define(
    'ClassSubject',
    {
      id: id(),
      school_id: schoolId(),
      class_id: fk({ references: { model: 'classes', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      /** Null = the subject applies to every section of the class. */
      section_id: fk({
        allowNull: true,
        references: { model: 'sections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      subject_id: fk({ references: { model: 'subjects', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      /** Primary teacher for this subject in this class (SRS §14.4 Teacher Assignment). */
      teacher_id: fk({
        allowNull: true,
        references: { model: 'teachers', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      /** Default full/passing marks so exam creation can pre-fill them (FR-EXAM-001). */
      full_marks: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
      passing_marks: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
      weekly_periods: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    modelOptions('class_subjects', {
      indexes: [
        {
          unique: true,
          fields: ['class_id', 'section_id', 'subject_id'],
          name: 'class_subjects_unique',
        },
        { fields: ['school_id'] },
        { fields: ['subject_id'] },
        { fields: ['teacher_id'] },
      ],
      validate: {
        passingNotAboveFull() {
          if (
            this.full_marks !== null &&
            this.full_marks !== undefined &&
            this.passing_marks !== null &&
            this.passing_marks !== undefined &&
            Number(this.passing_marks) > Number(this.full_marks)
          ) {
            throw new Error('passing_marks cannot exceed full_marks');
          }
        },
      },
    })
  );

  /* ─────────────────────────────── teacher_subjects ─────────────────────────────── */

  /**
   * SRS §15.3 — a teacher's Subjects and Classes; SRS §14.4 — Teacher Assignment.
   * class_id/section_id are nullable so a teacher can be qualified for a subject
   * generally, or assigned to it for a specific class/section.
   */
  const TeacherSubject = sequelize.define(
    'TeacherSubject',
    {
      id: id(),
      school_id: schoolId(),
      teacher_id: fk({ references: { model: 'teachers', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      subject_id: fk({ references: { model: 'subjects', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      class_id: fk({
        allowNull: true,
        references: { model: 'classes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      section_id: fk({
        allowNull: true,
        references: { model: 'sections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      is_primary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    modelOptions('teacher_subjects', {
      indexes: [
        {
          unique: true,
          fields: ['teacher_id', 'subject_id', 'class_id', 'section_id'],
          name: 'teacher_subjects_unique',
        },
        { fields: ['school_id'] },
        { fields: ['subject_id'] },
        { fields: ['class_id'] },
      ],
    })
  );

  return { Class, Section, Subject, ClassSubject, TeacherSubject };
};
