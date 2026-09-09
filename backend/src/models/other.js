'use strict';

/**
 * Remaining tables — SRS §29 "Other", §20, §23, §26:
 *   timetables · homework · assignments · books · library_transactions ·
 *   documents · notifications · activity_logs · audit_logs
 *
 * SRS §29 lists no assignment-submissions table, so SRS §20.3's
 * "Create → Submit → Review" lifecycle is stored inside `assignments`: a submission is a
 * child row (record_type = 'submission', parent_assignment_id set, student_id set).
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
} = require('./columns');

const {
  WEEKDAYS,
  ASSIGNMENT_RECORD_TYPES,
  ASSIGNMENT_STATUS,
  SUBMISSION_STATUS,
  LIBRARY_TRANSACTION_STATUS,
  LIBRARY_BORROWER_TYPES,
  DOCUMENT_TYPES,
  DOCUMENT_OWNER_TYPES,
  NOTIFICATION_TYPES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUS,
  ACTIVITY_ACTIONS,
} = require('../config/constants');

module.exports = (sequelize) => {
  /* ─────────────────────────────── timetables (SRS §20.1) ─────────────────────────────── */

  /**
   * One row per period slot. A Class Timetable is these rows filtered by class/section,
   * a Teacher Timetable the same rows filtered by teacher — SRS §20.1 needs both views
   * and §29 lists a single table. FR-TT-002 conflict detection queries
   * (day_of_week, period_number) against teacher_id and room within the school.
   */
  const Timetable = sequelize.define(
    'Timetable',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      academic_session_id: academicSessionId(),
      class_id: fk({ references: { model: 'classes', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      section_id: fk({
        allowNull: true,
        references: { model: 'sections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      /** SRS §20.1 — Subject. */
      subject_id: fk({
        allowNull: true,
        references: { model: 'subjects', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      /** SRS §20.1 — Teacher. */
      teacher_id: fk({
        allowNull: true,
        references: { model: 'teachers', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      day_of_week: enumOf(WEEKDAYS),
      /** SRS §20.1 — Period. */
      period_number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      period_label: { type: DataTypes.STRING(60), allowNull: true },
      start_time: { type: DataTypes.TIME, allowNull: false },
      end_time: { type: DataTypes.TIME, allowNull: false },
      /** SRS §20.1 — Room. */
      room: { type: DataTypes.STRING(60), allowNull: true },
      /** A break period occupies a slot but needs no subject or teacher. */
      is_break: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
    },
    modelOptions('timetables', {
      indexes: [
        {
          unique: true,
          fields: ['section_id', 'day_of_week', 'period_number'],
          name: 'timetables_section_day_period_unique',
        },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['class_id'] },
        { fields: ['subject_id'] },
        /* Supports the teacher-clash query in FR-TT-002. */
        { fields: ['teacher_id', 'day_of_week', 'period_number'] },
        /* Supports the room-clash query in FR-TT-002. */
        { fields: ['school_id', 'day_of_week', 'period_number', 'room'] },
      ],
      validate: {
        timeOrdered() {
          if (this.start_time && this.end_time && this.end_time <= this.start_time) {
            throw new Error('Timetable end_time must be after start_time');
          }
        },
        teachingSlotNeedsSubject() {
          if (!this.is_break && !this.subject_id) {
            throw new Error('A teaching period must specify a subject');
          }
        },
      },
    })
  );

  /* ─────────────────────────────── homework (SRS §20.2) ─────────────────────────────── */

  const Homework = sequelize.define(
    'Homework',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      academic_session_id: academicSessionId(),
      class_id: fk({ references: { model: 'classes', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      section_id: fk({
        allowNull: true,
        references: { model: 'sections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      subject_id: fk({
        allowNull: true,
        references: { model: 'subjects', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      teacher_id: fk({
        allowNull: true,
        references: { model: 'teachers', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      title: { type: DataTypes.STRING(180), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      assigned_date: { type: DataTypes.DATEONLY, allowNull: false },
      /** SRS §20.2 — Set Due Date. */
      due_date: { type: DataTypes.DATEONLY, allowNull: false },
      /** SRS §20.2 — Upload File. Additional files live in `documents`. */
      attachment_path: { type: DataTypes.STRING(255), allowNull: true },
      attachment_name: { type: DataTypes.STRING(255), allowNull: true },
      is_published: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      /** Set once the Homework notification has been dispatched (SRS §23). */
      notified_at: { type: DataTypes.DATE, allowNull: true },
      created_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
    },
    modelOptions('homework', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['class_id'] },
        { fields: ['section_id'] },
        { fields: ['teacher_id'] },
        { fields: ['due_date'] },
      ],
      validate: {
        dueNotBeforeAssigned() {
          if (this.assigned_date && this.due_date && this.due_date < this.assigned_date) {
            throw new Error('Homework due_date cannot be before assigned_date');
          }
        },
      },
    })
  );

  /* ─────────────────────────────── assignments (SRS §20.3) ─────────────────────────────── */

  const Assignment = sequelize.define(
    'Assignment',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      academic_session_id: academicSessionId(),
      /**
       * 'assignment' = the teacher's task; 'submission' = a student's answer to it.
       * SRS §29 lists no submissions table, so both live here (see file header).
       */
      record_type: enumOf(ASSIGNMENT_RECORD_TYPES, { defaultValue: ASSIGNMENT_RECORD_TYPES.ASSIGNMENT }),
      parent_assignment_id: fk({
        allowNull: true,
        references: { model: 'assignments', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
        comment: 'Set on submission rows; points at the assignment being submitted',
      }),
      /** Set on submission rows (SRS §20.3 Submit). */
      student_id: fk({
        allowNull: true,
        references: { model: 'students', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),

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
      subject_id: fk({
        allowNull: true,
        references: { model: 'subjects', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      teacher_id: fk({
        allowNull: true,
        references: { model: 'teachers', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),

      title: { type: DataTypes.STRING(180), allowNull: true },
      description: { type: DataTypes.TEXT, allowNull: true },
      assigned_date: { type: DataTypes.DATEONLY, allowNull: true },
      due_date: { type: DataTypes.DATEONLY, allowNull: true },
      total_marks: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
      attachment_path: { type: DataTypes.STRING(255), allowNull: true },
      attachment_name: { type: DataTypes.STRING(255), allowNull: true },

      /** Lifecycle of an `assignment` row. */
      status: enumOf(ASSIGNMENT_STATUS, { allowNull: true, defaultValue: null }),
      /** Lifecycle of a `submission` row (SRS §20.3 Submit → Review). */
      submission_status: enumOf(SUBMISSION_STATUS, { allowNull: true, defaultValue: null }),
      submitted_at: { type: DataTypes.DATE, allowNull: true },
      submission_text: { type: DataTypes.TEXT, allowNull: true },
      is_late: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

      /** SRS §20.3 — Review. */
      marks_obtained: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
      feedback: { type: DataTypes.TEXT, allowNull: true },
      reviewed_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      reviewed_at: { type: DataTypes.DATE, allowNull: true },

      created_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
    },
    modelOptions('assignments', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['record_type'] },
        { fields: ['class_id'] },
        { fields: ['section_id'] },
        { fields: ['teacher_id'] },
        { fields: ['due_date'] },
        /* One submission per student per assignment. */
        {
          unique: true,
          fields: ['parent_assignment_id', 'student_id'],
          name: 'assignments_submission_unique',
        },
      ],
      validate: {
        shapeMatchesRecordType() {
          if (this.record_type === ASSIGNMENT_RECORD_TYPES.SUBMISSION) {
            if (!this.parent_assignment_id) {
              throw new Error('A submission row must set parent_assignment_id');
            }
            if (!this.student_id) {
              throw new Error('A submission row must set student_id');
            }
          } else {
            if (this.parent_assignment_id) {
              throw new Error('An assignment row must not set parent_assignment_id');
            }
            if (!this.title) {
              throw new Error('An assignment row must have a title');
            }
            if (!this.class_id) {
              throw new Error('An assignment row must target a class');
            }
          }
        },
      },
    })
  );

  /* ─────────────────────────────── books (SRS §20.4) ─────────────────────────────── */

  const Book = sequelize.define(
    'Book',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      title: { type: DataTypes.STRING(255), allowNull: false },
      /** SRS §20.4 — Authors. */
      author: { type: DataTypes.STRING(255), allowNull: true },
      /** SRS §20.4 — Categories. */
      category: { type: DataTypes.STRING(120), allowNull: true },
      isbn: { type: DataTypes.STRING(40), allowNull: true },
      publisher: { type: DataTypes.STRING(180), allowNull: true },
      edition: { type: DataTypes.STRING(60), allowNull: true },
      language: { type: DataTypes.STRING(60), allowNull: true },
      /** SRS §20.4 — Quantity, plus the derived available count. */
      quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      available_quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      rack_number: { type: DataTypes.STRING(60), allowNull: true },
      price: money({ allowNull: true, defaultValue: null }),
      /** Per-day fine used when a loan runs past its due date (SRS §20.4 Fine). */
      fine_per_day: money({ defaultValue: 0 }),
      /** Default loan length in days. */
      loan_days: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 14 },
      cover_path: { type: DataTypes.STRING(255), allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      description: { type: DataTypes.TEXT, allowNull: true },
    },
    modelOptions('books', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['category'] },
        { fields: ['title'] },
        { fields: ['isbn'] },
      ],
      validate: {
        availableWithinQuantity() {
          if (Number(this.available_quantity) > Number(this.quantity)) {
            throw new Error('available_quantity cannot exceed quantity');
          }
        },
      },
    })
  );

  /* ─────────────────────────────── library_transactions (SRS §20.4) ─────────────────────────────── */

  /** SRS §20.4 / FR-LIB-002 — Issue, Return, Fine. */
  const LibraryTransaction = sequelize.define(
    'LibraryTransaction',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      book_id: fk({ references: { model: 'books', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      /** A book may be issued to a student, a teacher or a staff member. */
      borrower_type: enumOf(LIBRARY_BORROWER_TYPES),
      student_id: fk({
        allowNull: true,
        references: { model: 'students', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      teacher_id: fk({
        allowNull: true,
        references: { model: 'teachers', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      staff_id: fk({
        allowNull: true,
        references: { model: 'staff', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      issue_date: { type: DataTypes.DATEONLY, allowNull: false },
      due_date: { type: DataTypes.DATEONLY, allowNull: false },
      return_date: { type: DataTypes.DATEONLY, allowNull: true },
      status: enumOf(LIBRARY_TRANSACTION_STATUS, { defaultValue: LIBRARY_TRANSACTION_STATUS.ISSUED }),
      /** SRS §20.4 — Fine. */
      fine_amount: money({ defaultValue: 0 }),
      fine_paid: money({ defaultValue: 0 }),
      fine_waived: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      currency: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'USD' },
      issued_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      received_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      remarks: { type: DataTypes.STRING(255), allowNull: true },
    },
    modelOptions('library_transactions', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['book_id'] },
        { fields: ['student_id'] },
        { fields: ['teacher_id'] },
        { fields: ['staff_id'] },
        { fields: ['status'] },
        { fields: ['due_date'] },
      ],
      validate: {
        borrowerMatchesType() {
          const map = {
            student: this.student_id,
            teacher: this.teacher_id,
            staff: this.staff_id,
          };
          if (!map[this.borrower_type]) {
            throw new Error(`borrower_type "${this.borrower_type}" requires the matching borrower id`);
          }
        },
        dueNotBeforeIssue() {
          if (this.issue_date && this.due_date && this.due_date < this.issue_date) {
            throw new Error('Library due_date cannot be before issue_date');
          }
        },
      },
    })
  );

  /* ─────────────────────────────── documents (SRS §20.5, §15.1) ─────────────────────────────── */

  /**
   * Holds both generated documents (SRS §20.5's seven types) and uploaded attachments
   * (SRS §15.1 "Documents"). `document_type` is null for a plain upload.
   */
  const Document = sequelize.define(
    'Document',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      /** SRS §20.5 — one of the seven generated documents, or null for an upload. */
      document_type: enumOf(DOCUMENT_TYPES, { allowNull: true, defaultValue: null }),
      /** What the file belongs to. */
      owner_type: enumOf(DOCUMENT_OWNER_TYPES),
      owner_id: fk({ allowNull: true, comment: 'Id within owner_type; no FK because the type varies' }),
      title: { type: DataTypes.STRING(255), allowNull: false },
      file_path: { type: DataTypes.STRING(255), allowNull: true },
      file_name: { type: DataTypes.STRING(255), allowNull: true },
      mime_type: { type: DataTypes.STRING(120), allowNull: true },
      /** Counted toward the Storage Limit (SRS §11.2). */
      file_size_bytes: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
      is_generated: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'true = produced by the document generator, false = uploaded',
      },
      /** Values merged into the template when generated, so it can be reproduced. */
      generation_payload: json(),
      generated_at: { type: DataTypes.DATE, allowNull: true },
      uploaded_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      description: { type: DataTypes.STRING(255), allowNull: true },
    },
    modelOptions('documents', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['owner_type', 'owner_id'] },
        { fields: ['document_type'] },
        { fields: ['school_id', 'is_generated'] },
      ],
    })
  );

  /* ─────────────────────────────── notifications (SRS §23) ─────────────────────────────── */

  const Notification = sequelize.define(
    'Notification',
    {
      id: id(),
      /**
       * Null school_id = a platform notification addressed to the Super Admin — **a shape that is
       * defined and unused**, which triage finding 63 asked to be said here rather than implied.
       *
       * The column is nullable and `notifications.service.js` honours it (`school_id: event.schoolId
       * || null`), but all eight sweeps pass a `school_id` read off a school-scoped row, so nothing in
       * the application has ever produced one. That is not an oversight to be fixed by writing a
       * sweep: §23 binds none of its nine types to any of FR-NOTIF-001's five recipient classes —
       * *"school, parent, student, teacher, or Super Admin **as applicable**"* is the whole of the
       * rule — so which type should reach the Super Admin as a platform notification is a decision the
       * source does not supply. Recorded as available and unreached rather than as coverage.
       */
      school_id: schoolId({ allowNull: true, onDelete: 'CASCADE' }),
      organization_id: organizationId({ allowNull: true, onDelete: 'CASCADE' }),
      user_id: fk({ references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      /** SRS §23 — one of the nine documented types; no others are introduced. */
      type: enumOf(NOTIFICATION_TYPES),
      channel: enumOf(NOTIFICATION_CHANNELS, { defaultValue: NOTIFICATION_CHANNELS.IN_APP }),
      title: { type: DataTypes.STRING(180), allowNull: false },
      message: { type: DataTypes.TEXT, allowNull: false },
      /** Deep-link target and the record that triggered the notification. */
      action_url: { type: DataTypes.STRING(255), allowNull: true },
      reference_type: { type: DataTypes.STRING(60), allowNull: true },
      reference_id: fk({ allowNull: true }),
      status: enumOf(NOTIFICATION_STATUS, { defaultValue: NOTIFICATION_STATUS.PENDING }),
      sent_at: { type: DataTypes.DATE, allowNull: true },
      read_at: { type: DataTypes.DATE, allowNull: true },
      error_message: { type: DataTypes.STRING(500), allowNull: true },
      metadata: json(),
    },
    modelOptions('notifications', {
      indexes: [
        { fields: ['user_id', 'read_at'] },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['type'] },
        { fields: ['status'] },
        { fields: ['reference_type', 'reference_id'] },
      ],
    })
  );

  /* ─────────────────────────────── activity_logs (SRS §26) ─────────────────────────────── */

  /** SRS §26 / FR-LOG-001 — Activity Logs for user and system actions. */
  const ActivityLog = sequelize.define(
    'ActivityLog',
    {
      id: id(),
      school_id: schoolId({ allowNull: true, onDelete: 'CASCADE' }),
      organization_id: organizationId({ allowNull: true, onDelete: 'CASCADE' }),
      user_id: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      /** Retained separately so the log survives the user row being deleted. */
      user_email: { type: DataTypes.STRING(180), allowNull: true },
      role_slug: { type: DataTypes.STRING(60), allowNull: true },
      action: enumOf(ACTIVITY_ACTIONS),
      /** What was acted on. */
      entity_type: { type: DataTypes.STRING(80), allowNull: true },
      entity_id: fk({ allowNull: true }),
      description: { type: DataTypes.STRING(500), allowNull: true },
      method: { type: DataTypes.STRING(10), allowNull: true },
      path: { type: DataTypes.STRING(255), allowNull: true },
      status_code: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      ip_address: { type: DataTypes.STRING(60), allowNull: true },
      user_agent: { type: DataTypes.STRING(255), allowNull: true },
      request_id: { type: DataTypes.STRING(60), allowNull: true },
      metadata: json(),
    },
    modelOptions('activity_logs', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['user_id'] },
        { fields: ['action'] },
        { fields: ['entity_type', 'entity_id'] },
        { fields: ['created_at'] },
      ],
    })
  );

  /* ─────────────────────────────── audit_logs (SRS §29) ─────────────────────────────── */

  /**
   * Field-level record of data changes, complementing `activity_logs` (which records the
   * action). Kept separate because SRS §29 lists both tables.
   */
  const AuditLog = sequelize.define(
    'AuditLog',
    {
      id: id(),
      school_id: schoolId({ allowNull: true, onDelete: 'CASCADE' }),
      organization_id: organizationId({ allowNull: true, onDelete: 'CASCADE' }),
      user_id: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      table_name: { type: DataTypes.STRING(80), allowNull: false },
      record_id: fk({ allowNull: true }),
      event: enumOf(['create', 'update', 'delete', 'restore'], { defaultValue: 'update' }),
      /** Only the columns that actually changed. */
      old_values: json(),
      new_values: json(),
      changed_fields: json(),
      ip_address: { type: DataTypes.STRING(60), allowNull: true },
      request_id: { type: DataTypes.STRING(60), allowNull: true },
      reason: { type: DataTypes.STRING(255), allowNull: true },
    },
    modelOptions('audit_logs', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['user_id'] },
        { fields: ['table_name', 'record_id'] },
        { fields: ['created_at'] },
      ],
    })
  );

  return {
    Timetable,
    Homework,
    Assignment,
    Book,
    LibraryTransaction,
    Document,
    Notification,
    ActivityLog,
    AuditLog,
  };
};
