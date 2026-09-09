'use strict';

/**
 * Exam tables — SRS §29 "Exams", §19 and §21:
 *   exams · exam_subjects · marks · grades · results · question_banks · questions · online_exams
 *
 * SRS §19.2 requires the system to calculate Total, Percentage, Grade and Pass/Fail, and
 * SRS §19.3 requires Position. Those calculated values are persisted on `results` so a
 * published result card is reproducible, and recalculated whenever marks change.
 */

const {
  DataTypes,
  id,
  fk,
  organizationId,
  schoolId,
  academicSessionId,
  enumOf,
  json,
  modelOptions,
} = require('./columns');

const {
  EXAM_STATUS,
  MARK_STATUS,
  RESULT_OUTCOME,
  QUESTION_DIFFICULTY,
  QUESTION_TYPES,
  QUESTION_STATUS,
  QUESTION_SOURCES,
  ONLINE_EXAM_STATUS,
  AI_SOURCE_TYPES,
  AI_WORKFLOW_STAGES,
} = require('../config/constants');

module.exports = (sequelize) => {
  /* ─────────────────────────────── grades (SRS §19.1 Grade System) ─────────────────────────────── */

  /**
   * One row per band of a grading scale. `scale_name` groups the bands, so a school can
   * keep more than one scale and pick which an exam uses (FR-EXAM-001 "selects/configures
   * the Grade System").
   */
  const Grade = sequelize.define(
    'Grade',
    {
      id: id(),
      school_id: schoolId({ allowNull: true, onDelete: 'CASCADE' }),
      organization_id: organizationId({ allowNull: true, onDelete: 'CASCADE' }),
      scale_name: { type: DataTypes.STRING(90), allowNull: false, defaultValue: 'default' },
      name: { type: DataTypes.STRING(20), allowNull: false, comment: 'e.g. A+' },
      min_percentage: { type: DataTypes.DECIMAL(6, 3), allowNull: false },
      max_percentage: { type: DataTypes.DECIMAL(6, 3), allowNull: false },
      /** Grade point / GPA value, when the school uses one. */
      grade_point: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
      /** A band marked `is_failing` yields Pass/Fail = fail (SRS §19.2). */
      is_failing: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      remarks: { type: DataTypes.STRING(120), allowNull: true },
      /**
       * A null school_id row is a platform-provided default scale usable by any school;
       * `is_system` marks it so schools cannot delete it.
       */
      is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    modelOptions('grades', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['school_id', 'scale_name'] },
      ],
      validate: {
        bandOrdered() {
          if (Number(this.max_percentage) <= Number(this.min_percentage)) {
            throw new Error('Grade max_percentage must be greater than min_percentage');
          }
        },
        bandInRange() {
          if (Number(this.min_percentage) < 0 || Number(this.max_percentage) > 100) {
            throw new Error('Grade band must lie within 0–100');
          }
        },
      },
    })
  );

  /* ─────────────────────────────── exams (SRS §19.1) ─────────────────────────────── */

  const Exam = sequelize.define(
    'Exam',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      academic_session_id: academicSessionId(),
      name: { type: DataTypes.STRING(160), allowNull: false },
      /** SRS §19.1 — Exam Type. The source names the field but no closed value list. */
      exam_type: { type: DataTypes.STRING(90), allowNull: false, comment: 'e.g. Midterm, Final' },
      class_id: fk({ references: { model: 'classes', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      /** Null = all sections of the class sit the exam. */
      section_id: fk({
        allowNull: true,
        references: { model: 'sections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      start_date: { type: DataTypes.DATEONLY, allowNull: true },
      end_date: { type: DataTypes.DATEONLY, allowNull: true },
      /** SRS §19.1 — Grade System selection, by scale name within this school. */
      grade_scale: { type: DataTypes.STRING(90), allowNull: false, defaultValue: 'default' },
      status: enumOf(EXAM_STATUS, { defaultValue: EXAM_STATUS.DRAFT }),
      /** Results become visible to parents/students only once published (SRS §19.3, §23). */
      published_at: { type: DataTypes.DATE, allowNull: true },
      /** Set when the Exam Announcement notification has been dispatched (SRS §23). */
      announced_at: { type: DataTypes.DATE, allowNull: true },
      description: { type: DataTypes.TEXT, allowNull: true },
      created_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
    },
    modelOptions('exams', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['class_id'] },
        { fields: ['section_id'] },
        { fields: ['status'] },
        { fields: ['school_id', 'academic_session_id'] },
      ],
      validate: {
        endNotBeforeStart() {
          if (this.start_date && this.end_date && this.end_date < this.start_date) {
            throw new Error('Exam end_date cannot be before start_date');
          }
        },
      },
    })
  );

  /* ─────────────────────────────── exam_subjects (SRS §19.1) ─────────────────────────────── */

  /** SRS §19.1 — Subjects, Marks, Passing Marks for the exam. */
  const ExamSubject = sequelize.define(
    'ExamSubject',
    {
      id: id(),
      school_id: schoolId(),
      exam_id: fk({ references: { model: 'exams', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      subject_id: fk({ references: { model: 'subjects', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      teacher_id: fk({
        allowNull: true,
        references: { model: 'teachers', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      /** SRS §19.1 — Marks / Passing Marks. */
      full_marks: { type: DataTypes.DECIMAL(7, 2), allowNull: false },
      passing_marks: { type: DataTypes.DECIMAL(7, 2), allowNull: false },
      /** Practical component, when the subject has one. */
      practical_full_marks: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
      practical_passing_marks: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
      exam_date: { type: DataTypes.DATEONLY, allowNull: true },
      start_time: { type: DataTypes.TIME, allowNull: true },
      end_time: { type: DataTypes.TIME, allowNull: true },
      room: { type: DataTypes.STRING(60), allowNull: true },
      /** Weight used when aggregating into the exam total; 1 = counted at face value. */
      weightage: { type: DataTypes.DECIMAL(6, 3), allowNull: false, defaultValue: 1 },
      /** All marks for this subject submitted (SRS §19.2 Submit Marks). */
      marks_submitted_at: { type: DataTypes.DATE, allowNull: true },
    },
    modelOptions('exam_subjects', {
      indexes: [
        { unique: true, fields: ['exam_id', 'subject_id'], name: 'exam_subjects_unique' },
        { fields: ['school_id'] },
        { fields: ['subject_id'] },
        { fields: ['teacher_id'] },
      ],
      validate: {
        passingNotAboveFull() {
          if (Number(this.passing_marks) > Number(this.full_marks)) {
            throw new Error('passing_marks cannot exceed full_marks');
          }
        },
        practicalPassingNotAboveFull() {
          if (
            this.practical_full_marks !== null &&
            this.practical_full_marks !== undefined &&
            this.practical_passing_marks !== null &&
            this.practical_passing_marks !== undefined &&
            Number(this.practical_passing_marks) > Number(this.practical_full_marks)
          ) {
            throw new Error('practical_passing_marks cannot exceed practical_full_marks');
          }
        },
        timeOrdered() {
          if (this.start_time && this.end_time && this.end_time <= this.start_time) {
            throw new Error('exam_subject end_time must be after start_time');
          }
        },
      },
    })
  );

  /* ─────────────────────────────── marks (SRS §19.2) ─────────────────────────────── */

  const Mark = sequelize.define(
    'Mark',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      exam_id: fk({ references: { model: 'exams', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      exam_subject_id: fk({
        references: { model: 'exam_subjects', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      student_id: fk({ references: { model: 'students', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
      /** Null when the student was absent for the paper. */
      marks_obtained: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
      practical_marks_obtained: { type: DataTypes.DECIMAL(7, 2), allowNull: true },
      is_absent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      /** Derived per subject from the exam_subject passing marks. */
      grade_name: { type: DataTypes.STRING(20), allowNull: true },
      outcome: enumOf(RESULT_OUTCOME, { allowNull: true, defaultValue: null }),
      /** SRS §19.2 — marks may be edited while `draft`, and are locked on `submitted`. */
      status: enumOf(MARK_STATUS, { defaultValue: MARK_STATUS.DRAFT }),
      remarks: { type: DataTypes.STRING(255), allowNull: true },
      entered_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      submitted_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      submitted_at: { type: DataTypes.DATE, allowNull: true },
    },
    modelOptions('marks', {
      indexes: [
        { unique: true, fields: ['exam_subject_id', 'student_id'], name: 'marks_examsubject_student_unique' },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['exam_id'] },
        { fields: ['student_id'] },
        { fields: ['status'] },
      ],
      validate: {
        absentHasNoMarks() {
          if (this.is_absent && this.marks_obtained !== null && this.marks_obtained !== undefined) {
            throw new Error('An absent student cannot have marks_obtained');
          }
        },
        marksNotNegative() {
          if (this.marks_obtained !== null && this.marks_obtained !== undefined && Number(this.marks_obtained) < 0) {
            throw new Error('marks_obtained cannot be negative');
          }
        },
      },
    })
  );

  /* ─────────────────────────────── results (SRS §19.3) ─────────────────────────────── */

  /** One row per student per exam, holding the values SRS §19.2/§19.3 require. */
  const Result = sequelize.define(
    'Result',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      academic_session_id: academicSessionId(),
      exam_id: fk({ references: { model: 'exams', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' }),
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

      /** SRS §19.2 — system-calculated Total, Percentage, Grade, Pass/Fail. */
      total_full_marks: { type: DataTypes.DECIMAL(9, 2), allowNull: false, defaultValue: 0 },
      total_marks_obtained: { type: DataTypes.DECIMAL(9, 2), allowNull: false, defaultValue: 0 },
      percentage: { type: DataTypes.DECIMAL(6, 3), allowNull: false, defaultValue: 0 },
      grade_name: { type: DataTypes.STRING(20), allowNull: true },
      grade_point: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
      outcome: enumOf(RESULT_OUTCOME, { allowNull: true, defaultValue: null }),

      subjects_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      subjects_failed: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },

      /** SRS §19.3 — Position within the class/section. */
      position: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      position_out_of: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

      /** Generated result card PDF (SRS §19.3 PDF/Print support). */
      result_card_path: { type: DataTypes.STRING(255), allowNull: true },
      is_published: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      published_at: { type: DataTypes.DATE, allowNull: true },
      calculated_at: { type: DataTypes.DATE, allowNull: true },
      remarks: { type: DataTypes.STRING(255), allowNull: true },
      /** Per-subject snapshot used to render the card without re-joining marks. */
      subject_breakdown: json(),
    },
    modelOptions('results', {
      indexes: [
        { unique: true, fields: ['exam_id', 'student_id'], name: 'results_exam_student_unique' },
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['student_id'] },
        { fields: ['class_id'] },
        { fields: ['section_id'] },
        { fields: ['is_published'] },
      ],
    })
  );

  /* ─────────────────────────────── question_banks (SRS §21) ─────────────────────────────── */

  /**
   * A question bank is both the destination of the AI workflow and the record of the
   * upload that produced it, so SRS §21's "Upload → Extract → Analyze → Generate →
   * Answers → Difficulty → Preview → Approve → Question Bank" is fully traceable
   * without introducing a table SRS §29 does not list.
   */
  const QuestionBank = sequelize.define(
    'QuestionBank',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      name: { type: DataTypes.STRING(180), allowNull: false },
      subject_id: fk({
        allowNull: true,
        references: { model: 'subjects', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      class_id: fk({
        allowNull: true,
        references: { model: 'classes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      topic: { type: DataTypes.STRING(180), allowNull: true },
      description: { type: DataTypes.TEXT, allowNull: true },

      /** SRS §21 — the teacher uploads PDF, Image, or Syllabus. */
      source_type: enumOf(AI_SOURCE_TYPES, { allowNull: true, defaultValue: null }),
      source_path: { type: DataTypes.STRING(255), allowNull: true },
      source_filename: { type: DataTypes.STRING(255), allowNull: true },
      /** Text produced by the Extract Content stage. */
      extracted_text: { type: DataTypes.TEXT('long'), allowNull: true },
      /** Topics produced by the Analyze Topics stage. */
      analyzed_topics: json(),
      /** Where this bank currently sits in the §21 workflow. */
      workflow_stage: enumOf(AI_WORKFLOW_STAGES, { allowNull: true, defaultValue: null }),
      /** SRS §21 — "Select Difficulty" requested for generation. */
      requested_difficulty: enumOf(QUESTION_DIFFICULTY, { allowNull: true, defaultValue: null }),
      requested_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      generated_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      approved_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      is_ai_generated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      ai_model: { type: DataTypes.STRING(90), allowNull: true },
      /** Failure detail when a generation attempt could not complete. */
      error_message: { type: DataTypes.STRING(500), allowNull: true },
      created_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      approved_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      approved_at: { type: DataTypes.DATE, allowNull: true },
    },
    modelOptions('question_banks', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['subject_id'] },
        { fields: ['class_id'] },
        { fields: ['workflow_stage'] },
        { fields: ['created_by'] },
      ],
    })
  );

  /* ─────────────────────────────── questions (SRS §21) ─────────────────────────────── */

  const Question = sequelize.define(
    'Question',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      question_bank_id: fk({
        references: { model: 'question_banks', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      }),
      subject_id: fk({
        allowNull: true,
        references: { model: 'subjects', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      /** SRS §21 generates MCQs. */
      type: enumOf(QUESTION_TYPES, { defaultValue: QUESTION_TYPES.MCQ }),
      question_text: { type: DataTypes.TEXT, allowNull: false },
      /** MCQ choices: [{ key: 'A', text: '…' }, …]. */
      options: json(),
      /** SRS §21 — Generate Answers. */
      correct_option: { type: DataTypes.STRING(10), allowNull: true },
      answer_explanation: { type: DataTypes.TEXT, allowNull: true },
      difficulty: enumOf(QUESTION_DIFFICULTY, { defaultValue: QUESTION_DIFFICULTY.MEDIUM }),
      topic: { type: DataTypes.STRING(180), allowNull: true },
      marks: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 1 },
      /** SRS §21 — Teacher Preview → Approve before the question enters the bank. */
      status: enumOf(QUESTION_STATUS, { defaultValue: QUESTION_STATUS.PENDING_REVIEW }),
      source: enumOf(QUESTION_SOURCES, { defaultValue: QUESTION_SOURCES.AI }),
      reviewed_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      reviewed_at: { type: DataTypes.DATE, allowNull: true },
      review_note: { type: DataTypes.STRING(500), allowNull: true },
      metadata: json(),
    },
    modelOptions('questions', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['question_bank_id'] },
        { fields: ['subject_id'] },
        { fields: ['status'] },
        { fields: ['difficulty'] },
      ],
      validate: {
        mcqNeedsOptionsAndAnswer() {
          if (this.type !== QUESTION_TYPES.MCQ) return;
          const options = this.options;
          if (!Array.isArray(options) || options.length < 2) {
            throw new Error('An MCQ must define at least two options');
          }
          if (!this.correct_option) {
            throw new Error('An MCQ must define correct_option');
          }
          const keys = options.map((o) => String(o && o.key));
          if (!keys.includes(String(this.correct_option))) {
            throw new Error('correct_option must match one of the option keys');
          }
        },
      },
    })
  );

  /* ─────────────────────────────── online_exams (SRS §11.1) ─────────────────────────────── */

  /**
   * SRS §11.1 lists "Online Exams" as a subscribable module and §29 lists the table.
   * The source states no further behaviour, so this holds only what the listed module
   * and the question bank it draws from imply.
   */
  const OnlineExam = sequelize.define(
    'OnlineExam',
    {
      id: id(),
      school_id: schoolId(),
      organization_id: organizationId(),
      academic_session_id: academicSessionId(),
      title: { type: DataTypes.STRING(180), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
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
      subject_id: fk({
        allowNull: true,
        references: { model: 'subjects', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      question_bank_id: fk({
        allowNull: true,
        references: { model: 'question_banks', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      /** Optional link to the offline exam this online paper belongs to. */
      exam_id: fk({
        allowNull: true,
        references: { model: 'exams', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
      total_questions: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      total_marks: { type: DataTypes.DECIMAL(8, 2), allowNull: false, defaultValue: 0 },
      passing_marks: { type: DataTypes.DECIMAL(8, 2), allowNull: true },
      duration_minutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      starts_at: { type: DataTypes.DATE, allowNull: true },
      ends_at: { type: DataTypes.DATE, allowNull: true },
      status: enumOf(ONLINE_EXAM_STATUS, { defaultValue: ONLINE_EXAM_STATUS.DRAFT }),
      /** Selected question ids, in presentation order. */
      question_ids: json(),
      shuffle_questions: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      created_by: fk({
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      }),
    },
    modelOptions('online_exams', {
      indexes: [
        { fields: ['school_id'] },
        { fields: ['organization_id'] },
        { fields: ['class_id'] },
        { fields: ['subject_id'] },
        { fields: ['question_bank_id'] },
        { fields: ['status'] },
      ],
      validate: {
        windowOrdered() {
          if (this.starts_at && this.ends_at && new Date(this.ends_at) <= new Date(this.starts_at)) {
            throw new Error('online_exam ends_at must be after starts_at');
          }
        },
      },
    })
  );

  return { Grade, Exam, ExamSubject, Mark, Result, QuestionBank, Question, OnlineExam };
};
