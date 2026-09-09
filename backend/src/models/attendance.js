'use strict';

/**
 * Attendance tables — SRS §29 "Attendance", §16:
 *   student_attendance · teacher_attendance
 *
 * SRS §16 fixes the status vocabulary to Present / Absent / Leave / Late, and requires
 * Daily / Monthly / Yearly reports plus a Percentage. Percentage is derived at query time
 * from these rows rather than stored, so it can never drift from the underlying records.
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

const { ATTENDANCE_STATUS } = require('../config/constants');

module.exports = (sequelize) => {
  /* ─────────────────────────────── student_attendance ─────────────────────────────── */

  /** SRS §16 / FR-ATT-001 — Teacher marks each student Present, Absent, Leave or Late. */
  const StudentAttendance = sequelize.define(
    'StudentAttendance',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      academic_session_id: academicSessionId(),
      student_id: fk({ references: { model: 'students', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
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
      attendance_date: { type: DataTypes.DATEONLY, allowNull: false },
      status: enumOf(ATTENDANCE_STATUS),
      /** Minutes late, recorded when status is `late`. */
      late_minutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      remarks: { type: DataTypes.STRING(255), allowNull: true },
      /** Teacher who marked it (FR-ATT-001). */
      marked_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      marked_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      /** Set once the low-attendance alert has fired, so it is not sent twice (SRS §23). */
      alert_sent_at: { type: DataTypes.DATE, allowNull: true },
    },
    modelOptions('student_attendance', {
      indexes: [
        {
          unique: true,
          fields: ['student_id', 'attendance_date'],
          name: 'student_attendance_student_date_unique',
        },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['school_id', 'attendance_date'] },
        { fields: ['section_id', 'attendance_date'] },
        { fields: ['status'] },
        { fields: ['academic_session_id'] },
      ],
    })
  );

  /* ─────────────────────────────── teacher_attendance ─────────────────────────────── */

  /** SRS §16 / FR-ATT-003 — "Teacher attendance is also documented in the source." */
  const TeacherAttendance = sequelize.define(
    'TeacherAttendance',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      academic_session_id: academicSessionId(),
      teacher_id: fk({ references: { model: 'teachers', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      attendance_date: { type: DataTypes.DATEONLY, allowNull: false },
      status: enumOf(ATTENDANCE_STATUS),
      check_in_at: { type: DataTypes.DATE, allowNull: true },
      check_out_at: { type: DataTypes.DATE, allowNull: true },
      late_minutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      remarks: { type: DataTypes.STRING(255), allowNull: true },
      marked_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      marked_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    modelOptions('teacher_attendance', {
      indexes: [
        {
          unique: true,
          fields: ['teacher_id', 'attendance_date'],
          name: 'teacher_attendance_teacher_date_unique',
        },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['school_id', 'attendance_date'] },
        { fields: ['status'] },
      ],
    })
  );

  return { StudentAttendance, TeacherAttendance };
};
