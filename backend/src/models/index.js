'use strict';

/**
 * Model registry, associations, and the tenant-scoping helper.
 *
 * SRS §29 fixes the schema at exactly 64 tables across nine groups; `EXPECTED_TABLES`
 * below reproduces that list and `assertSchemaMatchesSrs()` fails at boot if the
 * registered models drift from it in either direction.
 *
 * SRS §30 Rule 2 requires complete tenant isolation. This file provides the fourth and
 * innermost layer of that: `tenantWhere()`, through which every service query builds its
 * WHERE clause. Layers 1–3 (the schema's school_id columns, `resolveTenant` and
 * `enforceTenant`) live in the schema and the middleware.
 */

const { Op } = require('sequelize');
const { sequelize, Sequelize } = require('../config/database');
const { installJsonGetters } = require('./columns');

/* ─────────────────────────── register models ─────────────────────────── */

const core = require('./core')(sequelize);
const subscription = require('./subscription')(sequelize);
const billing = require('./billing')(sequelize);
const academic = require('./academic')(sequelize);
const people = require('./people')(sequelize);
const attendance = require('./attendance')(sequelize);
const finance = require('./finance')(sequelize);
const exams = require('./exams')(sequelize);
const other = require('./other')(sequelize);

const models = {
  ...core,
  ...subscription,
  ...billing,
  ...academic,
  ...people,
  ...attendance,
  ...finance,
  ...exams,
  ...other,
};

/**
 * Normalise JSON column reads across MySQL and MariaDB before anything else touches the
 * models. See `installJsonGetters` in ./columns for why this is necessary.
 */
const jsonColumnCount = Object.values(models).reduce((sum, model) => sum + installJsonGetters(model), 0);

const {
  /* Core */
  Role,
  Permission,
  RolePermission,
  Organization,
  School,
  User,
  SchoolSetting,
  AcademicSession,
  /* Subscription */
  SubscriptionPlan,
  PlanPrice,
  PlanModule,
  PlanFeature,
  PlanLimit,
  Addon,
  AddonPrice,
  Subscription,
  SubscriptionItem,
  SubscriptionHistory,
  SubscriptionOverride,
  SubscriptionAddon,
  UsageRecord,
  /* Billing */
  Tax,
  Coupon,
  Invoice,
  InvoiceItem,
  Payment,
  PaymentTransaction,
  Refund,
  CouponUsage,
  Quotation,
  /* Academic */
  Class,
  Section,
  Subject,
  ClassSubject,
  TeacherSubject,
  /* People */
  Student,
  Parent,
  ParentStudent,
  Teacher,
  Staff,
  /* Attendance */
  StudentAttendance,
  TeacherAttendance,
  /* Finance */
  FeeStructure,
  StudentFee,
  FeePayment,
  Expense,
  Income,
  /* Exams */
  /* `Grade` is deliberately absent: this destructure is for models that declare an EXPLICIT
   * association below, and `grades` declares none — it is a flat per-school lookup whose only
   * links are the `school`/`organization` pair the generic tenant loop adds to every model. */
  Exam,
  ExamSubject,
  Mark,
  Result,
  QuestionBank,
  Question,
  OnlineExam,
  /* Other */
  Timetable,
  Homework,
  Assignment,
  Book,
  LibraryTransaction,
  Document,
  Notification,
  ActivityLog,
  AuditLog,
} = models;

/* ─────────────────────────── shared association shapes ─────────────────────────── */

/**
 * `school_id` / `organization_id` belongsTo, applied to every tenant-scoped model.
 * Skips any model that already declared the alias explicitly above.
 */
function attachTenancy(model) {
  if (model.rawAttributes.school_id && !model.associations.school) {
    model.belongsTo(School, { as: 'school', foreignKey: 'school_id' });
  }
  if (model.rawAttributes.organization_id && !model.associations.organization) {
    model.belongsTo(Organization, { as: 'organization', foreignKey: 'organization_id' });
  }
}

/**
 * Actor columns (`created_by`, `marked_by`, …) as named belongsTo associations.
 * A missing column is not an error — the helper is applied uniformly and the actor
 * columns differ per table; `scripts/check-models.js` verifies the reverse direction,
 * that no association ever invents a column.
 */
function attachActor(model, column, alias) {
  if (!model.rawAttributes[column] || model.associations[alias]) return;
  model.belongsTo(User, { as: alias, foreignKey: column });
}

/* ─────────────────────────── Core ─────────────────────────── */

Role.hasMany(User, { as: 'users', foreignKey: 'role_id' });
User.belongsTo(Role, { as: 'role', foreignKey: 'role_id' });

Role.belongsToMany(Permission, {
  through: RolePermission,
  as: 'permissions',
  foreignKey: 'role_id',
  otherKey: 'permission_id',
});
Permission.belongsToMany(Role, {
  through: RolePermission,
  as: 'roles',
  foreignKey: 'permission_id',
  otherKey: 'role_id',
});
RolePermission.belongsTo(Role, { as: 'role', foreignKey: 'role_id' });
RolePermission.belongsTo(Permission, { as: 'permission', foreignKey: 'permission_id' });
Role.hasMany(RolePermission, { as: 'rolePermissions', foreignKey: 'role_id' });
Permission.hasMany(RolePermission, { as: 'rolePermissions', foreignKey: 'permission_id' });

Organization.hasMany(School, { as: 'schools', foreignKey: 'organization_id' });
School.belongsTo(Organization, { as: 'organization', foreignKey: 'organization_id' });

Organization.hasMany(User, { as: 'users', foreignKey: 'organization_id' });
School.hasMany(User, { as: 'users', foreignKey: 'school_id' });
User.belongsTo(Organization, { as: 'organization', foreignKey: 'organization_id' });
User.belongsTo(School, { as: 'school', foreignKey: 'school_id' });

/** SRS §9.2 — Assign / Change Principal. */
School.belongsTo(User, { as: 'principal', foreignKey: 'principal_id' });

School.hasOne(SchoolSetting, { as: 'settings', foreignKey: 'school_id' });
SchoolSetting.belongsTo(School, { as: 'school', foreignKey: 'school_id' });
SchoolSetting.belongsTo(Organization, { as: 'organization', foreignKey: 'organization_id' });

School.hasMany(AcademicSession, { as: 'academicSessions', foreignKey: 'school_id' });
AcademicSession.belongsTo(School, { as: 'school', foreignKey: 'school_id' });
AcademicSession.belongsTo(Organization, { as: 'organization', foreignKey: 'organization_id' });

/* ─────────────────────────── Subscription ─────────────────────────── */

SubscriptionPlan.hasMany(PlanPrice, { as: 'prices', foreignKey: 'plan_id' });
PlanPrice.belongsTo(SubscriptionPlan, { as: 'plan', foreignKey: 'plan_id' });

SubscriptionPlan.hasMany(PlanModule, { as: 'modules', foreignKey: 'plan_id' });
PlanModule.belongsTo(SubscriptionPlan, { as: 'plan', foreignKey: 'plan_id' });

SubscriptionPlan.hasMany(PlanFeature, { as: 'features', foreignKey: 'plan_id' });
PlanFeature.belongsTo(SubscriptionPlan, { as: 'plan', foreignKey: 'plan_id' });

SubscriptionPlan.hasMany(PlanLimit, { as: 'limits', foreignKey: 'plan_id' });
PlanLimit.belongsTo(SubscriptionPlan, { as: 'plan', foreignKey: 'plan_id' });

/** SRS §10.2 FR-SUB-003 — Duplicate Plan keeps a pointer to its source. */
SubscriptionPlan.belongsTo(SubscriptionPlan, { as: 'duplicatedFrom', foreignKey: 'duplicated_from_id' });

Addon.hasMany(AddonPrice, { as: 'prices', foreignKey: 'addon_id' });
AddonPrice.belongsTo(Addon, { as: 'addon', foreignKey: 'addon_id' });
AddonPrice.belongsTo(SubscriptionPlan, { as: 'plan', foreignKey: 'plan_id' });

School.hasMany(Subscription, { as: 'subscriptions', foreignKey: 'school_id' });
Subscription.belongsTo(SubscriptionPlan, { as: 'plan', foreignKey: 'plan_id' });
Subscription.belongsTo(PlanPrice, { as: 'planPrice', foreignKey: 'plan_price_id' });
Subscription.belongsTo(SubscriptionPlan, { as: 'scheduledPlan', foreignKey: 'scheduled_plan_id' });
Subscription.belongsTo(PlanPrice, { as: 'scheduledPlanPrice', foreignKey: 'scheduled_plan_price_id' });

Subscription.hasMany(SubscriptionItem, { as: 'items', foreignKey: 'subscription_id' });
SubscriptionItem.belongsTo(Subscription, { as: 'subscription', foreignKey: 'subscription_id' });
SubscriptionItem.belongsTo(SubscriptionPlan, { as: 'plan', foreignKey: 'plan_id' });
SubscriptionItem.belongsTo(Addon, { as: 'addon', foreignKey: 'addon_id' });

Subscription.hasMany(SubscriptionHistory, { as: 'history', foreignKey: 'subscription_id' });
SubscriptionHistory.belongsTo(Subscription, { as: 'subscription', foreignKey: 'subscription_id' });
SubscriptionHistory.belongsTo(SubscriptionPlan, { as: 'fromPlan', foreignKey: 'from_plan_id' });
SubscriptionHistory.belongsTo(SubscriptionPlan, { as: 'toPlan', foreignKey: 'to_plan_id' });

Subscription.hasMany(SubscriptionOverride, { as: 'overrides', foreignKey: 'subscription_id' });
SubscriptionOverride.belongsTo(Subscription, { as: 'subscription', foreignKey: 'subscription_id' });

Subscription.hasMany(SubscriptionAddon, { as: 'addons', foreignKey: 'subscription_id' });
SubscriptionAddon.belongsTo(Subscription, { as: 'subscription', foreignKey: 'subscription_id' });
SubscriptionAddon.belongsTo(Addon, { as: 'addon', foreignKey: 'addon_id' });
SubscriptionAddon.belongsTo(AddonPrice, { as: 'addonPrice', foreignKey: 'addon_price_id' });

Subscription.hasMany(UsageRecord, { as: 'usageRecords', foreignKey: 'subscription_id' });
UsageRecord.belongsTo(Subscription, { as: 'subscription', foreignKey: 'subscription_id' });

/* ─────────────────────────── Billing ─────────────────────────── */

Subscription.hasMany(Invoice, { as: 'invoices', foreignKey: 'subscription_id' });
Invoice.belongsTo(Subscription, { as: 'subscription', foreignKey: 'subscription_id' });
Invoice.belongsTo(SubscriptionPlan, { as: 'plan', foreignKey: 'plan_id' });
Invoice.belongsTo(Coupon, { as: 'coupon', foreignKey: 'coupon_id' });
Invoice.belongsTo(Tax, { as: 'tax', foreignKey: 'tax_id' });

Invoice.hasMany(InvoiceItem, { as: 'items', foreignKey: 'invoice_id' });
InvoiceItem.belongsTo(Invoice, { as: 'invoice', foreignKey: 'invoice_id' });
InvoiceItem.belongsTo(SubscriptionItem, { as: 'subscriptionItem', foreignKey: 'subscription_item_id' });
InvoiceItem.belongsTo(Addon, { as: 'addon', foreignKey: 'addon_id' });

Invoice.hasMany(Payment, { as: 'payments', foreignKey: 'invoice_id' });
Payment.belongsTo(Invoice, { as: 'invoice', foreignKey: 'invoice_id' });
Payment.belongsTo(Subscription, { as: 'subscription', foreignKey: 'subscription_id' });

Payment.hasMany(PaymentTransaction, { as: 'transactions', foreignKey: 'payment_id' });
PaymentTransaction.belongsTo(Payment, { as: 'payment', foreignKey: 'payment_id' });

Payment.hasMany(Refund, { as: 'refunds', foreignKey: 'payment_id' });
Refund.belongsTo(Payment, { as: 'payment', foreignKey: 'payment_id' });
Refund.belongsTo(Invoice, { as: 'invoice', foreignKey: 'invoice_id' });

Coupon.hasMany(CouponUsage, { as: 'usages', foreignKey: 'coupon_id' });
CouponUsage.belongsTo(Coupon, { as: 'coupon', foreignKey: 'coupon_id' });
CouponUsage.belongsTo(Subscription, { as: 'subscription', foreignKey: 'subscription_id' });
CouponUsage.belongsTo(Invoice, { as: 'invoice', foreignKey: 'invoice_id' });

Quotation.belongsTo(SubscriptionPlan, { as: 'plan', foreignKey: 'plan_id' });
Quotation.belongsTo(PlanPrice, { as: 'planPrice', foreignKey: 'plan_price_id' });
Quotation.belongsTo(Invoice, { as: 'convertedInvoice', foreignKey: 'converted_invoice_id' });

/* ─────────────────────────── Academic ─────────────────────────── */

Class.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });
Class.belongsTo(Teacher, { as: 'classTeacher', foreignKey: 'class_teacher_id' });
Class.hasMany(Section, { as: 'sections', foreignKey: 'class_id' });
Section.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
Section.belongsTo(Teacher, { as: 'classTeacher', foreignKey: 'class_teacher_id' });

Class.hasMany(ClassSubject, { as: 'classSubjects', foreignKey: 'class_id' });
Section.hasMany(ClassSubject, { as: 'classSubjects', foreignKey: 'section_id' });
Subject.hasMany(ClassSubject, { as: 'classSubjects', foreignKey: 'subject_id' });
ClassSubject.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
ClassSubject.belongsTo(Section, { as: 'section', foreignKey: 'section_id' });
ClassSubject.belongsTo(Subject, { as: 'subject', foreignKey: 'subject_id' });
ClassSubject.belongsTo(Teacher, { as: 'teacher', foreignKey: 'teacher_id' });

Class.belongsToMany(Subject, {
  through: ClassSubject,
  as: 'subjects',
  foreignKey: 'class_id',
  otherKey: 'subject_id',
});
Subject.belongsToMany(Class, {
  through: ClassSubject,
  as: 'classes',
  foreignKey: 'subject_id',
  otherKey: 'class_id',
});

Teacher.hasMany(TeacherSubject, { as: 'teacherSubjects', foreignKey: 'teacher_id' });
Subject.hasMany(TeacherSubject, { as: 'teacherSubjects', foreignKey: 'subject_id' });
TeacherSubject.belongsTo(Teacher, { as: 'teacher', foreignKey: 'teacher_id' });
TeacherSubject.belongsTo(Subject, { as: 'subject', foreignKey: 'subject_id' });
TeacherSubject.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
TeacherSubject.belongsTo(Section, { as: 'section', foreignKey: 'section_id' });

Teacher.belongsToMany(Subject, {
  through: TeacherSubject,
  as: 'subjects',
  foreignKey: 'teacher_id',
  otherKey: 'subject_id',
});
Subject.belongsToMany(Teacher, {
  through: TeacherSubject,
  as: 'teachers',
  foreignKey: 'subject_id',
  otherKey: 'teacher_id',
});

/* ─────────────────────────── People ─────────────────────────── */

Student.belongsTo(User, { as: 'user', foreignKey: 'user_id' });
Student.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
Student.belongsTo(Section, { as: 'section', foreignKey: 'section_id' });
Student.belongsTo(Class, { as: 'previousClass', foreignKey: 'previous_class_id' });
Student.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });
Student.belongsTo(AcademicSession, { as: 'admissionSession', foreignKey: 'admission_session_id' });
Class.hasMany(Student, { as: 'students', foreignKey: 'class_id' });
Section.hasMany(Student, { as: 'students', foreignKey: 'section_id' });
User.hasOne(Student, { as: 'studentProfile', foreignKey: 'user_id' });

Parent.belongsTo(User, { as: 'user', foreignKey: 'user_id' });
User.hasOne(Parent, { as: 'parentProfile', foreignKey: 'user_id' });

/** SRS §15.2 — Multiple Children. */
Parent.belongsToMany(Student, {
  through: ParentStudent,
  as: 'students',
  foreignKey: 'parent_id',
  otherKey: 'student_id',
});
Student.belongsToMany(Parent, {
  through: ParentStudent,
  as: 'parents',
  foreignKey: 'student_id',
  otherKey: 'parent_id',
});
Parent.hasMany(ParentStudent, { as: 'links', foreignKey: 'parent_id' });
Student.hasMany(ParentStudent, { as: 'parentLinks', foreignKey: 'student_id' });
ParentStudent.belongsTo(Parent, { as: 'parent', foreignKey: 'parent_id' });
ParentStudent.belongsTo(Student, { as: 'student', foreignKey: 'student_id' });

Teacher.belongsTo(User, { as: 'user', foreignKey: 'user_id' });
User.hasOne(Teacher, { as: 'teacherProfile', foreignKey: 'user_id' });
Teacher.hasMany(Class, { as: 'classesAsClassTeacher', foreignKey: 'class_teacher_id' });
Teacher.hasMany(Section, { as: 'sectionsAsClassTeacher', foreignKey: 'class_teacher_id' });

Staff.belongsTo(User, { as: 'user', foreignKey: 'user_id' });
User.hasOne(Staff, { as: 'staffProfile', foreignKey: 'user_id' });

/* ─────────────────────────── Attendance ─────────────────────────── */

Student.hasMany(StudentAttendance, { as: 'attendance', foreignKey: 'student_id' });
StudentAttendance.belongsTo(Student, { as: 'student', foreignKey: 'student_id' });
StudentAttendance.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
StudentAttendance.belongsTo(Section, { as: 'section', foreignKey: 'section_id' });
StudentAttendance.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });
attachActor(StudentAttendance, 'marked_by', 'markedBy');

Teacher.hasMany(TeacherAttendance, { as: 'attendance', foreignKey: 'teacher_id' });
TeacherAttendance.belongsTo(Teacher, { as: 'teacher', foreignKey: 'teacher_id' });
TeacherAttendance.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });
attachActor(TeacherAttendance, 'marked_by', 'markedBy');

/* ─────────────────────────── Finance ─────────────────────────── */

FeeStructure.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
FeeStructure.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });
Class.hasMany(FeeStructure, { as: 'feeStructures', foreignKey: 'class_id' });

StudentFee.belongsTo(Student, { as: 'student', foreignKey: 'student_id' });
StudentFee.belongsTo(FeeStructure, { as: 'feeStructure', foreignKey: 'fee_structure_id' });
StudentFee.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
StudentFee.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });
Student.hasMany(StudentFee, { as: 'fees', foreignKey: 'student_id' });
attachActor(StudentFee, 'created_by', 'createdBy');

StudentFee.hasMany(FeePayment, { as: 'payments', foreignKey: 'student_fee_id' });
FeePayment.belongsTo(StudentFee, { as: 'studentFee', foreignKey: 'student_fee_id' });
FeePayment.belongsTo(Student, { as: 'student', foreignKey: 'student_id' });
FeePayment.belongsTo(Income, { as: 'income', foreignKey: 'income_id' });
Student.hasMany(FeePayment, { as: 'feePayments', foreignKey: 'student_id' });
attachActor(FeePayment, 'collected_by', 'collectedBy');

Expense.belongsTo(Teacher, { as: 'teacher', foreignKey: 'teacher_id' });
Expense.belongsTo(Staff, { as: 'staff', foreignKey: 'staff_id' });
Expense.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });
attachActor(Expense, 'recorded_by', 'recordedBy');

Income.belongsTo(Student, { as: 'student', foreignKey: 'student_id' });
Income.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });
attachActor(Income, 'recorded_by', 'recordedBy');

/* ─────────────────────────── Exams ─────────────────────────── */

Exam.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
Exam.belongsTo(Section, { as: 'section', foreignKey: 'section_id' });
Exam.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });
Class.hasMany(Exam, { as: 'exams', foreignKey: 'class_id' });
attachActor(Exam, 'created_by', 'createdBy');

Exam.hasMany(ExamSubject, { as: 'examSubjects', foreignKey: 'exam_id' });
ExamSubject.belongsTo(Exam, { as: 'exam', foreignKey: 'exam_id' });
ExamSubject.belongsTo(Subject, { as: 'subject', foreignKey: 'subject_id' });
ExamSubject.belongsTo(Teacher, { as: 'teacher', foreignKey: 'teacher_id' });

Exam.hasMany(Mark, { as: 'marks', foreignKey: 'exam_id' });
ExamSubject.hasMany(Mark, { as: 'marks', foreignKey: 'exam_subject_id' });
Student.hasMany(Mark, { as: 'marks', foreignKey: 'student_id' });
Mark.belongsTo(Exam, { as: 'exam', foreignKey: 'exam_id' });
Mark.belongsTo(ExamSubject, { as: 'examSubject', foreignKey: 'exam_subject_id' });
Mark.belongsTo(Student, { as: 'student', foreignKey: 'student_id' });
attachActor(Mark, 'entered_by', 'enteredBy');
attachActor(Mark, 'submitted_by', 'submittedBy');

Exam.hasMany(Result, { as: 'results', foreignKey: 'exam_id' });
Student.hasMany(Result, { as: 'results', foreignKey: 'student_id' });
Result.belongsTo(Exam, { as: 'exam', foreignKey: 'exam_id' });
Result.belongsTo(Student, { as: 'student', foreignKey: 'student_id' });
Result.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
Result.belongsTo(Section, { as: 'section', foreignKey: 'section_id' });
Result.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });

QuestionBank.belongsTo(Subject, { as: 'subject', foreignKey: 'subject_id' });
QuestionBank.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
attachActor(QuestionBank, 'created_by', 'createdBy');
attachActor(QuestionBank, 'approved_by', 'approvedBy');

QuestionBank.hasMany(Question, { as: 'questions', foreignKey: 'question_bank_id' });
Question.belongsTo(QuestionBank, { as: 'questionBank', foreignKey: 'question_bank_id' });
Question.belongsTo(Subject, { as: 'subject', foreignKey: 'subject_id' });
attachActor(Question, 'reviewed_by', 'reviewedBy');

OnlineExam.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
OnlineExam.belongsTo(Section, { as: 'section', foreignKey: 'section_id' });
OnlineExam.belongsTo(Subject, { as: 'subject', foreignKey: 'subject_id' });
OnlineExam.belongsTo(QuestionBank, { as: 'questionBank', foreignKey: 'question_bank_id' });
OnlineExam.belongsTo(Exam, { as: 'exam', foreignKey: 'exam_id' });
OnlineExam.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });
attachActor(OnlineExam, 'created_by', 'createdBy');

/* ─────────────────────────── Other ─────────────────────────── */

Timetable.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
Timetable.belongsTo(Section, { as: 'section', foreignKey: 'section_id' });
Timetable.belongsTo(Subject, { as: 'subject', foreignKey: 'subject_id' });
Timetable.belongsTo(Teacher, { as: 'teacher', foreignKey: 'teacher_id' });
Timetable.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });
Class.hasMany(Timetable, { as: 'timetables', foreignKey: 'class_id' });
Teacher.hasMany(Timetable, { as: 'timetables', foreignKey: 'teacher_id' });
attachActor(Timetable, 'created_by', 'createdBy');

Homework.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
Homework.belongsTo(Section, { as: 'section', foreignKey: 'section_id' });
Homework.belongsTo(Subject, { as: 'subject', foreignKey: 'subject_id' });
Homework.belongsTo(Teacher, { as: 'teacher', foreignKey: 'teacher_id' });
Homework.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });
Teacher.hasMany(Homework, { as: 'homework', foreignKey: 'teacher_id' });
attachActor(Homework, 'created_by', 'createdBy');

/**
 * SRS §20.3 — submissions are child rows of the assignment they answer.
 *
 * The `belongsTo` alias is `parentAssignment`, not `assignment`. MySQL compares table aliases
 * case-insensitively, so a self-join aliased `assignment` collides with Sequelize's own `Assignment`
 * alias for the base table and every query including it fails with *"Not unique table/alias"*. The
 * association was therefore unusable as first written; `parentAssignment` also matches the column it
 * follows.
 */
Assignment.hasMany(Assignment, { as: 'submissions', foreignKey: 'parent_assignment_id' });
Assignment.belongsTo(Assignment, { as: 'parentAssignment', foreignKey: 'parent_assignment_id' });
Assignment.belongsTo(Class, { as: 'class', foreignKey: 'class_id' });
Assignment.belongsTo(Section, { as: 'section', foreignKey: 'section_id' });
Assignment.belongsTo(Subject, { as: 'subject', foreignKey: 'subject_id' });
Assignment.belongsTo(Teacher, { as: 'teacher', foreignKey: 'teacher_id' });
Assignment.belongsTo(Student, { as: 'student', foreignKey: 'student_id' });
Assignment.belongsTo(AcademicSession, { as: 'academicSession', foreignKey: 'academic_session_id' });
attachActor(Assignment, 'created_by', 'createdBy');
attachActor(Assignment, 'reviewed_by', 'reviewedBy');

Book.hasMany(LibraryTransaction, { as: 'transactions', foreignKey: 'book_id' });
LibraryTransaction.belongsTo(Book, { as: 'book', foreignKey: 'book_id' });
LibraryTransaction.belongsTo(Student, { as: 'student', foreignKey: 'student_id' });
LibraryTransaction.belongsTo(Teacher, { as: 'teacher', foreignKey: 'teacher_id' });
LibraryTransaction.belongsTo(Staff, { as: 'staff', foreignKey: 'staff_id' });
attachActor(LibraryTransaction, 'issued_by', 'issuedBy');
attachActor(LibraryTransaction, 'received_by', 'receivedBy');

attachActor(Document, 'uploaded_by', 'uploadedBy');

Notification.belongsTo(User, { as: 'user', foreignKey: 'user_id' });
User.hasMany(Notification, { as: 'notifications', foreignKey: 'user_id' });

ActivityLog.belongsTo(User, { as: 'user', foreignKey: 'user_id' });
AuditLog.belongsTo(User, { as: 'user', foreignKey: 'user_id' });

attachActor(Coupon, 'created_by', 'createdBy');
attachActor(Quotation, 'created_by', 'createdBy');
attachActor(Payment, 'reviewed_by', 'reviewedBy');
attachActor(Payment, 'submitted_by', 'submittedBy');
attachActor(Refund, 'requested_by', 'requestedBy');
attachActor(Refund, 'approved_by', 'approvedBy');
attachActor(CouponUsage, 'redeemed_by', 'redeemedBy');
attachActor(SubscriptionHistory, 'performed_by', 'performedBy');
attachActor(SubscriptionOverride, 'created_by', 'createdBy');

/* Tenancy belongsTo for every model that carries a tenant column. */
for (const model of Object.values(models)) {
  if (model === School || model === Organization) continue;
  attachTenancy(model);
}

/* ─────────────────────────── SRS §29 schema guard ─────────────────────────── */

/**
 * The 64 tables named in SRS §29, grouped exactly as the source groups them.
 * "No additional tables are introduced."
 */
const EXPECTED_TABLES = Object.freeze({
  core: ['users', 'roles', 'permissions', 'role_permissions', 'organizations', 'schools', 'school_settings', 'academic_sessions'],
  subscription: [
    'subscription_plans',
    'plan_prices',
    'plan_modules',
    'plan_features',
    'plan_limits',
    'subscriptions',
    'subscription_items',
    'subscription_history',
    'subscription_overrides',
    'addons',
    'addon_prices',
    'subscription_addons',
    'usage_records',
  ],
  billing: [
    'invoices',
    'invoice_items',
    'payments',
    'payment_transactions',
    'refunds',
    'coupons',
    'coupon_usages',
    'taxes',
    'quotations',
  ],
  academic: ['classes', 'sections', 'subjects', 'class_subjects', 'teacher_subjects'],
  people: ['students', 'parents', 'parent_students', 'teachers', 'staff'],
  attendance: ['student_attendance', 'teacher_attendance'],
  finance: ['fee_structures', 'student_fees', 'fee_payments', 'expenses', 'incomes'],
  exams: ['exams', 'exam_subjects', 'marks', 'grades', 'results', 'question_banks', 'questions', 'online_exams'],
  other: [
    'timetables',
    'homework',
    'assignments',
    'books',
    'library_transactions',
    'documents',
    'notifications',
    'activity_logs',
    'audit_logs',
  ],
});

const EXPECTED_TABLE_LIST = Object.freeze(Object.values(EXPECTED_TABLES).flat());

/**
 * Tables that are *not* school-scoped, and why. Everything else must carry `school_id`
 * (SRS §2.4: "School-related database tables must contain a school_id column").
 */
const PLATFORM_TABLES = Object.freeze([
  'users', //             may be a Super Admin, so school_id is nullable but present
  'roles', //             platform-wide role catalogue
  'permissions', //       platform-wide permission catalogue
  'role_permissions', //  joins the two catalogues
  'organizations', //     the tenant parent itself
  'schools', //           the tenant itself
  'subscription_plans', //   plan catalogue is platform-level (SRS §10.2)
  'plan_prices',
  'plan_modules',
  'plan_features',
  'plan_limits',
  'addons', //            add-on catalogue is platform-level (SRS §11.3)
  'addon_prices',
  'taxes', //             tax catalogue is platform-level (SRS §33)
  'coupons', //           coupon catalogue is platform-level, with optional school restrictions (SRS §13.4)
]);

/** Fails at boot if the registered models drift from the SRS §29 table list. */
function assertSchemaMatchesSrs() {
  const actual = Object.values(models).map((m) => m.getTableName());
  const actualSet = new Set(actual);
  const expectedSet = new Set(EXPECTED_TABLE_LIST);

  const missing = EXPECTED_TABLE_LIST.filter((t) => !actualSet.has(t));
  const extra = actual.filter((t) => !expectedSet.has(t));
  const duplicates = actual.filter((t, i) => actual.indexOf(t) !== i);

  const problems = [];
  if (missing.length) problems.push(`missing tables: ${missing.join(', ')}`);
  if (extra.length) problems.push(`tables not listed in SRS §29: ${extra.join(', ')}`);
  if (duplicates.length) problems.push(`duplicate table names: ${[...new Set(duplicates)].join(', ')}`);

  /* SRS §2.4 — every school-related table carries school_id. */
  const untenanted = Object.values(models)
    .filter((m) => !PLATFORM_TABLES.includes(m.getTableName()))
    .filter((m) => !m.rawAttributes.school_id)
    .map((m) => m.getTableName());
  if (untenanted.length) {
    problems.push(`school-scoped tables without a school_id column: ${untenanted.join(', ')}`);
  }

  if (problems.length) {
    throw new Error(`Schema does not match SRS §29 — ${problems.join(' | ')}`);
  }

  return { tableCount: actual.length };
}

/* ─────────────────────────── tenant scoping (SRS §8, §30 Rule 2) ─────────────────────────── */

/**
 * Build a WHERE clause locked to the caller's tenant.
 *
 * This is the innermost of the four isolation layers, and it fails closed: a caller who is
 * neither a platform user nor scoped to a school/organization gets an exception rather
 * than an unscoped query.
 *
 * @param {{schoolId?: number|null, organizationId?: number|null, isPlatform?: boolean}} tenant
 *        normally `req.tenant`, which `resolveTenant` derives from the JWT — never from
 *        user-supplied parameters.
 * @param {object} [where] additional conditions
 * @param {{column?: string, allowPlatformWide?: boolean}} [options]
 *        `column` overrides the tenant column (e.g. 'organization_id' on an
 *        organization-level table); `allowPlatformWide` lets a platform caller read
 *        across tenants, which is the default and is what the Super Admin dashboard needs.
 */
function tenantWhere(tenant, where = {}, options = {}) {
  const { column, allowPlatformWide = true } = options;
  const scoped = { ...where };

  if (!tenant) {
    throw new Error('tenantWhere() called without a tenant scope');
  }

  /* An explicit school scope always wins, including for a Super Admin who selected a school. */
  if (tenant.schoolId) {
    scoped[column || 'school_id'] = tenant.schoolId;
    return scoped;
  }

  if (tenant.organizationId) {
    scoped[column || 'organization_id'] = tenant.organizationId;
    return scoped;
  }

  if (tenant.isPlatform && allowPlatformWide) {
    return scoped;
  }

  throw new Error('tenantWhere() refused to build an unscoped query for a non-platform caller');
}

/**
 * Assert that a loaded record belongs to the caller's tenant.
 * Used after a primary-key lookup, where the WHERE clause cannot carry the scope —
 * this is what turns `GET /students/:id` for another school's id into a 404/403
 * rather than a data leak (SRS §8 Critical Test Scenario).
 */
function belongsToTenant(record, tenant) {
  if (!record || !tenant) return false;
  if (tenant.schoolId) {
    return String(record.school_id) === String(tenant.schoolId);
  }
  if (tenant.organizationId) {
    return String(record.organization_id) === String(tenant.organizationId);
  }
  return Boolean(tenant.isPlatform);
}

module.exports = {
  sequelize,
  Sequelize,
  Op,
  ...models,
  models,
  jsonColumnCount,
  EXPECTED_TABLES,
  EXPECTED_TABLE_LIST,
  PLATFORM_TABLES,
  assertSchemaMatchesSrs,
  tenantWhere,
  belongsToTenant,
};
