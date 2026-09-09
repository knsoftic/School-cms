'use strict';

/**
 * Every enumeration named in the SRS, in one place.
 *
 * These are *vocabularies* (the set of legal values), not business configuration.
 * Per SRS §30 Rule 1, no subscription decision is ever made by comparing a plan name —
 * plan/module/limit/price configuration lives in the database and is read at runtime.
 * Nothing in this file introduces a value the source document does not state.
 */

/** SRS §5 — the system defines exactly these eleven roles. */
const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  ORGANIZATION_ADMIN: 'organization_admin',
  PRINCIPAL: 'principal',
  SCHOOL_ADMIN: 'school_admin',
  TEACHER: 'teacher',
  ACCOUNTANT: 'accountant',
  RECEPTIONIST: 'receptionist',
  LIBRARIAN: 'librarian',
  STAFF: 'staff',
  STUDENT: 'student',
  PARENT: 'parent',
});

const ROLE_LIST = Object.freeze(Object.values(ROLES));

/** Roles that operate at platform level rather than inside a single school. */
const PLATFORM_ROLES = Object.freeze([ROLES.SUPER_ADMIN]);

/** Roles that administer a school (grouped as "Principals/Admins" in the SRS hierarchy). */
const SCHOOL_ADMIN_ROLES = Object.freeze([ROLES.PRINCIPAL, ROLES.SCHOOL_ADMIN]);

/** SRS §15.4 — staff categories. */
const STAFF_CATEGORIES = Object.freeze({
  RECEPTIONIST: 'receptionist',
  ACCOUNTANT: 'accountant',
  LIBRARIAN: 'librarian',
  OTHER_STAFF: 'other_staff',
});

/** SRS §7 "Account Status" — controls whether authentication is permitted. */
const USER_STATUS = Object.freeze({
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  SUSPENDED: 'suspended',
  PENDING: 'pending',
});

/** Statuses in which a user is allowed to obtain a session. */
const LOGIN_ALLOWED_STATUSES = Object.freeze([USER_STATUS.ACTIVE]);

/** SRS §9.2 — Activate / Suspend / Delete-Archive School. */
const SCHOOL_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  ARCHIVED: 'archived',
});

const ORGANIZATION_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  ARCHIVED: 'archived',
});

/** SRS §14.2 — Create / Activate / Close session. */
const ACADEMIC_SESSION_STATUS = Object.freeze({
  UPCOMING: 'upcoming',
  ACTIVE: 'active',
  CLOSED: 'closed',
});

/* ───────────────────────────── Subscription (SRS §10–§12) ───────────────────────────── */

/** SRS §10.2 — Plan Builder statuses (Activate/Deactivate, Archive). */
const PLAN_STATUS = Object.freeze({
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  ARCHIVED: 'archived',
});

/** SRS §10.2 — Public/Private visibility. */
const PLAN_VISIBILITY = Object.freeze({
  PUBLIC: 'public',
  PRIVATE: 'private',
});

/** SRS §10.3 — Billing Cycles, exactly the seven listed. */
const BILLING_CYCLES = Object.freeze({
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  SIX_MONTHS: 'six_months',
  YEARLY: 'yearly',
  CUSTOM_DAYS: 'custom_days',
  ONE_TIME: 'one_time',
});

const BILLING_CYCLE_LIST = Object.freeze(Object.values(BILLING_CYCLES));

/** Day count per billing cycle. `custom_days` reads its length from plan_prices.cycle_days. */
const BILLING_CYCLE_DAYS = Object.freeze({
  [BILLING_CYCLES.WEEKLY]: 7,
  [BILLING_CYCLES.MONTHLY]: 30,
  [BILLING_CYCLES.QUARTERLY]: 90,
  [BILLING_CYCLES.SIX_MONTHS]: 182,
  [BILLING_CYCLES.YEARLY]: 365,
  [BILLING_CYCLES.CUSTOM_DAYS]: null,
  [BILLING_CYCLES.ONE_TIME]: null,
});

/** SRS §10.4 — Pricing Models, exactly the five listed. */
const PRICING_MODELS = Object.freeze({
  FIXED: 'fixed',
  STUDENT_BASED: 'student_based',
  SEAT_BASED: 'seat_based',
  PER_STUDENT: 'per_student',
  CUSTOM: 'custom',
});

const PRICING_MODEL_LIST = Object.freeze(Object.values(PRICING_MODELS));

/** SRS §11.1 — the twenty subscribable modules. */
const MODULES = Object.freeze({
  STUDENTS: 'students',
  TEACHERS: 'teachers',
  STAFF: 'staff',
  ATTENDANCE: 'attendance',
  FEES: 'fees',
  FINANCE: 'finance',
  EXAMS: 'exams',
  ONLINE_EXAMS: 'online_exams',
  LIBRARY: 'library',
  LABORATORY: 'laboratory',
  TIMETABLE: 'timetable',
  HOMEWORK: 'homework',
  ASSIGNMENTS: 'assignments',
  TRANSPORT: 'transport',
  HOSTEL: 'hostel',
  PARENT_PORTAL: 'parent_portal',
  AI: 'ai',
  REPORTS: 'reports',
  CERTIFICATES: 'certificates',
  ID_CARDS: 'id_cards',
});

const MODULE_LIST = Object.freeze(Object.values(MODULES));

/** Human labels for the module list, used by the plan builder UI and entitlement responses. */
const MODULE_LABELS = Object.freeze({
  students: 'Students',
  teachers: 'Teachers',
  staff: 'Staff',
  attendance: 'Attendance',
  fees: 'Fees',
  finance: 'Finance',
  exams: 'Exams',
  online_exams: 'Online Exams',
  library: 'Library',
  laboratory: 'Laboratory',
  timetable: 'Timetable',
  homework: 'Homework',
  assignments: 'Assignments',
  transport: 'Transport',
  hostel: 'Hostel',
  parent_portal: 'Parent Portal',
  ai: 'AI',
  reports: 'Reports',
  certificates: 'Certificates',
  id_cards: 'ID Cards',
});

/** SRS §11.2 — the eight limits. */
const LIMITS = Object.freeze({
  STUDENT_LIMIT: 'student_limit',
  TEACHER_LIMIT: 'teacher_limit',
  STAFF_LIMIT: 'staff_limit',
  ADMIN_LIMIT: 'admin_limit',
  STORAGE_LIMIT: 'storage_limit',
  AI_LIMIT: 'ai_limit',
  API_LIMIT: 'api_limit',
  FILE_UPLOAD_LIMIT: 'file_upload_limit',
});

const LIMIT_LIST = Object.freeze(Object.values(LIMITS));

/**
 * Add-on-only allowance key.
 *
 * SRS §11.2 lists exactly eight configurable plan limits, and "SMS Limit" is not among
 * them. SRS §11.3 nonetheless lists "SMS Credits" as a purchasable add-on. Rather than
 * invent a ninth plan limit the source does not define, SMS allowance exists only as an
 * add-on grant: nothing can set it in `plan_limits`, but `subscription_addons` can grant
 * units against it and `usage_records` can track consumption of it. Its base value is
 * therefore always zero until an add-on is purchased.
 */
const ADDON_ONLY_LIMITS = Object.freeze(['sms_limit']);

/**
 * Every key that may appear in `usage_records.limit_key` — the eight plan limits plus the
 * add-on-only allowances above. `plan_limits.limit_key` remains restricted to LIMIT_LIST.
 */
const USAGE_LIMIT_KEYS = Object.freeze([...LIMIT_LIST, ...ADDON_ONLY_LIMITS]);

const LIMIT_LABELS = Object.freeze({
  student_limit: 'Student Limit',
  teacher_limit: 'Teacher Limit',
  staff_limit: 'Staff Limit',
  admin_limit: 'Admin Limit',
  storage_limit: 'Storage Limit',
  ai_limit: 'AI Limit',
  api_limit: 'API Limit',
  file_upload_limit: 'File Upload Limit',
  /* Not an SRS §11.2 plan limit — see ADDON_ONLY_LIMITS. */
  sms_limit: 'SMS Credits',
});

/** SRS §11.2 — "Each limit may be configured as: Fixed | Unlimited". */
const LIMIT_TYPES = Object.freeze({
  FIXED: 'fixed',
  UNLIMITED: 'unlimited',
});

/**
 * Unit each limit is measured in. Drives how usage is accumulated in usage_records.
 *  count  — current headcount, recalculated from the source table
 *  megabytes — cumulative stored bytes
 *  requests  — cumulative counter reset each billing period
 *
 * Covers every key in USAGE_LIMIT_KEYS, so the add-on-only `sms_limit` is here too.
 */
const LIMIT_UNITS = Object.freeze({
  student_limit: 'count',
  teacher_limit: 'count',
  staff_limit: 'count',
  admin_limit: 'count',
  storage_limit: 'megabytes',
  ai_limit: 'requests',
  api_limit: 'requests',
  file_upload_limit: 'megabytes',
  /*
   * Messages sent. `count` rather than `requests` because SMS allowance is a purchased
   * balance with no plan-level base value, so it does not reset at the start of a billing
   * period the way AI and API allowances do — see ADDON_ONLY_LIMITS and PERIODIC_LIMITS.
   */
  sms_limit: 'count',
});

/** Limits whose usage is a live headcount rather than a cumulative counter. */
const HEADCOUNT_LIMITS = Object.freeze([
  LIMITS.STUDENT_LIMIT,
  LIMITS.TEACHER_LIMIT,
  LIMITS.STAFF_LIMIT,
  LIMITS.ADMIN_LIMIT,
]);

/** Limits that reset at the start of each billing period. */
const PERIODIC_LIMITS = Object.freeze([LIMITS.AI_LIMIT, LIMITS.API_LIMIT]);

/** SRS §11.3 — the seven add-ons. */
const ADDONS = Object.freeze({
  EXTRA_STUDENTS: 'extra_students',
  EXTRA_TEACHERS: 'extra_teachers',
  EXTRA_STORAGE: 'extra_storage',
  AI_CREDITS: 'ai_credits',
  SMS_CREDITS: 'sms_credits',
  CUSTOM_DOMAIN: 'custom_domain',
  PREMIUM_REPORTS: 'premium_reports',
});

const ADDON_LIST = Object.freeze(Object.values(ADDONS));

/**
 * How each add-on affects entitlement.
 *  limit_increase — adds `quantity × units_per_quantity` to the named limit
 *  feature_unlock — turns on the named feature key
 */
const ADDON_EFFECTS = Object.freeze({
  extra_students: { type: 'limit_increase', target: LIMITS.STUDENT_LIMIT },
  extra_teachers: { type: 'limit_increase', target: LIMITS.TEACHER_LIMIT },
  extra_storage: { type: 'limit_increase', target: LIMITS.STORAGE_LIMIT },
  ai_credits: { type: 'limit_increase', target: LIMITS.AI_LIMIT },
  sms_credits: { type: 'limit_increase', target: ADDON_ONLY_LIMITS[0] },
  custom_domain: { type: 'feature_unlock', target: 'custom_domain' },
  premium_reports: { type: 'feature_unlock', target: 'premium_reports' },
});

/** SRS §12 — the ten subscription lifecycle states. */
const SUBSCRIPTION_STATES = Object.freeze({
  TRIAL: 'trial',
  ACTIVE: 'active',
  PENDING: 'pending',
  PAST_DUE: 'past_due',
  EXPIRING: 'expiring',
  GRACE_PERIOD: 'grace_period',
  EXPIRED: 'expired',
  SUSPENDED: 'suspended',
  CANCELLED: 'cancelled',
  PAUSED: 'paused',
});

const SUBSCRIPTION_STATE_LIST = Object.freeze(Object.values(SUBSCRIPTION_STATES));

/** States in which a school may use its subscribed modules. */
const SUBSCRIPTION_USABLE_STATES = Object.freeze([
  SUBSCRIPTION_STATES.TRIAL,
  SUBSCRIPTION_STATES.ACTIVE,
  SUBSCRIPTION_STATES.EXPIRING,
  SUBSCRIPTION_STATES.PAST_DUE,
  SUBSCRIPTION_STATES.GRACE_PERIOD,
]);

/** SRS §12.1 — Trial durations. `custom` reads its length from the plan/subscription. */
const TRIAL_DURATION_DAYS = Object.freeze([3, 7, 14, 30]);

/** SRS §12.2 — Grace Period durations. */
const GRACE_PERIOD_DAYS = Object.freeze([1, 3, 7, 15]);

/** SRS §12.4 — Downgrade timing. */
const DOWNGRADE_TIMING = Object.freeze({
  IMMEDIATE: 'immediate',
  NEXT_BILLING_CYCLE: 'next_billing_cycle',
});

/** SRS §12.5 — Renewal modes. */
const RENEWAL_MODES = Object.freeze({
  MANUAL: 'manual',
  AUTOMATIC: 'automatic',
});

/** Events recorded in subscription_history. */
const SUBSCRIPTION_EVENTS = Object.freeze({
  CREATED: 'created',
  TRIAL_STARTED: 'trial_started',
  TRIAL_ENDED: 'trial_ended',
  ACTIVATED: 'activated',
  RENEWED: 'renewed',
  UPGRADED: 'upgraded',
  DOWNGRADED: 'downgraded',
  DOWNGRADE_SCHEDULED: 'downgrade_scheduled',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  SUSPENDED: 'suspended',
  REACTIVATED: 'reactivated',
  PAST_DUE: 'past_due',
  GRACE_PERIOD_STARTED: 'grace_period_started',
  STATE_CHANGED: 'state_changed',
  ADDON_ADDED: 'addon_added',
  ADDON_REMOVED: 'addon_removed',
  OVERRIDE_APPLIED: 'override_applied',
});

/** SRS §33 SaaS Engine — Feature Overrides / Custom Limits / Custom Pricing. */
const OVERRIDE_TYPES = Object.freeze({
  MODULE: 'module',
  FEATURE: 'feature',
  LIMIT: 'limit',
  PRICE: 'price',
});

/**
 * What a `price` override may target — the only price component a `subscriptions` row carries.
 *
 * Declared here rather than in `subscriptions.validation.js`, which is where it began, because it
 * now has two readers: the schema that refuses anything else, and `subscriptions.service.catalogue()`
 * which publishes the vocabulary so a screen offers exactly what the schema accepts. Two frozen
 * one-element arrays that must agree is how they come to disagree, and every other vocabulary these
 * two read is already here.
 */
const PRICE_OVERRIDE_TARGETS = Object.freeze(['cycle_amount']);

/* ─────────────────────────────── Billing (SRS §13) ─────────────────────────────── */

/** SRS §13.1 — Invoice Status. */
const INVOICE_STATUS = Object.freeze({
  DRAFT: 'draft',
  UNPAID: 'unpaid',
  PARTIALLY_PAID: 'partially_paid',
  PAID: 'paid',
  OVERDUE: 'overdue',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
});

/** SRS §13.2 — the five payment methods. */
const PAYMENT_METHODS = Object.freeze({
  CASH: 'cash',
  BANK_TRANSFER: 'bank_transfer',
  MANUAL_PAYMENT: 'manual_payment',
  ONLINE_GATEWAY: 'online_gateway',
  WALLET: 'wallet',
});

const PAYMENT_METHOD_LIST = Object.freeze(Object.values(PAYMENT_METHODS));

/** SRS §13.3 — Manual payment becomes Pending, then Super Admin approves or rejects. */
const PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
});

const PAYMENT_TRANSACTION_STATUS = Object.freeze({
  INITIATED: 'initiated',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const REFUND_STATUS = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
});

/** SRS §13.4 — Coupon types. */
const COUPON_TYPES = Object.freeze({
  PERCENTAGE: 'percentage',
  FIXED_AMOUNT: 'fixed_amount',
});

const COUPON_STATUS = Object.freeze({
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  EXPIRED: 'expired',
});

const QUOTATION_STATUS = Object.freeze({
  DRAFT: 'draft',
  SENT: 'sent',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
});

/* ────────────────────────── School operations (SRS §15–§20) ────────────────────────── */

/** SRS §15.1 — Promotion / Transfer / Leaving. */
const STUDENT_STATUS = Object.freeze({
  ACTIVE: 'active',
  PROMOTED: 'promoted',
  TRANSFERRED: 'transferred',
  LEFT: 'left',
  GRADUATED: 'graduated',
  INACTIVE: 'inactive',
});

const GENDERS = Object.freeze({ MALE: 'male', FEMALE: 'female', OTHER: 'other' });

/** SRS §16 — student attendance statuses, exactly the four listed. */
const ATTENDANCE_STATUS = Object.freeze({
  PRESENT: 'present',
  ABSENT: 'absent',
  LEAVE: 'leave',
  LATE: 'late',
});

const ATTENDANCE_STATUS_LIST = Object.freeze(Object.values(ATTENDANCE_STATUS));

/** SRS §16 — attendance report periods. */
const ATTENDANCE_REPORT_PERIODS = Object.freeze({
  DAILY: 'daily',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
});

/** SRS §17 — fee components. */
const FEE_COMPONENTS = Object.freeze({
  MONTHLY_FEE: 'monthly_fee',
  ADMISSION_FEE: 'admission_fee',
  EXAM_FEE: 'exam_fee',
  TRANSPORT_FEE: 'transport_fee',
});

const FEE_COMPONENT_LIST = Object.freeze(Object.values(FEE_COMPONENTS));

const STUDENT_FEE_STATUS = Object.freeze({
  UNPAID: 'unpaid',
  PARTIALLY_PAID: 'partially_paid',
  PAID: 'paid',
  WAIVED: 'waived',
});

/** SRS §18 — Income / Expenses / Salaries / Other Expenses. */
const EXPENSE_CATEGORIES = Object.freeze({
  SALARIES: 'salaries',
  OTHER_EXPENSES: 'other_expenses',
});

const INCOME_CATEGORIES = Object.freeze({
  FEES: 'fees',
  OTHER_INCOME: 'other_income',
});

/** SRS §19.1 — Exam Type. The source names the field but not a closed list of values. */
const EXAM_STATUS = Object.freeze({
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  ONGOING: 'ongoing',
  MARKS_ENTRY: 'marks_entry',
  COMPLETED: 'completed',
  PUBLISHED: 'published',
  CANCELLED: 'cancelled',
});

/** SRS §19.2 — Enter / Edit / Submit marks. */
const MARK_STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
});

/** SRS §19.2 — system-calculated Pass/Fail. */
const RESULT_OUTCOME = Object.freeze({ PASS: 'pass', FAIL: 'fail' });

/** SRS §20.1 — timetable days. */
const WEEKDAYS = Object.freeze({
  MONDAY: 'monday',
  TUESDAY: 'tuesday',
  WEDNESDAY: 'wednesday',
  THURSDAY: 'thursday',
  FRIDAY: 'friday',
  SATURDAY: 'saturday',
  SUNDAY: 'sunday',
});

const WEEKDAY_LIST = Object.freeze(Object.values(WEEKDAYS));

/**
 * SRS §20.3 — Assignment lifecycle: Create → Submit → Review.
 * SRS §29 introduces no submissions table, so a submission is stored as a child row
 * in `assignments` (record_type = 'submission', parent_assignment_id set).
 */
const ASSIGNMENT_RECORD_TYPES = Object.freeze({
  ASSIGNMENT: 'assignment',
  SUBMISSION: 'submission',
});

const ASSIGNMENT_STATUS = Object.freeze({
  DRAFT: 'draft',
  PUBLISHED: 'published',
  CLOSED: 'closed',
});

const SUBMISSION_STATUS = Object.freeze({
  SUBMITTED: 'submitted',
  REVIEWED: 'reviewed',
  RETURNED: 'returned',
});

/** SRS §20.4 — Issue / Return / Fine. */
const LIBRARY_TRANSACTION_STATUS = Object.freeze({
  ISSUED: 'issued',
  RETURNED: 'returned',
  OVERDUE: 'overdue',
  LOST: 'lost',
});

const LIBRARY_BORROWER_TYPES = Object.freeze({
  STUDENT: 'student',
  TEACHER: 'teacher',
  STAFF: 'staff',
});

/** SRS §20.5 — the seven generated documents. */
const DOCUMENT_TYPES = Object.freeze({
  STUDENT_ID_CARD: 'student_id_card',
  TEACHER_ID_CARD: 'teacher_id_card',
  ADMISSION_FORM: 'admission_form',
  FEE_RECEIPT: 'fee_receipt',
  RESULT_CARD: 'result_card',
  CHARACTER_CERTIFICATE: 'character_certificate',
  LEAVING_CERTIFICATE: 'leaving_certificate',
});

const DOCUMENT_TYPE_LIST = Object.freeze(Object.values(DOCUMENT_TYPES));

/** Which subscribable module each document type belongs to (SRS §11.1 Certificates / ID Cards). */
const DOCUMENT_TYPE_MODULE = Object.freeze({
  student_id_card: MODULES.ID_CARDS,
  teacher_id_card: MODULES.ID_CARDS,
  admission_form: MODULES.CERTIFICATES,
  fee_receipt: MODULES.FEES,
  result_card: MODULES.EXAMS,
  character_certificate: MODULES.CERTIFICATES,
  leaving_certificate: MODULES.CERTIFICATES,
});

/** Attachment/document owner kinds stored in `documents`. */
const DOCUMENT_OWNER_TYPES = Object.freeze({
  STUDENT: 'student',
  TEACHER: 'teacher',
  STAFF: 'staff',
  SCHOOL: 'school',
  PAYMENT: 'payment',
  HOMEWORK: 'homework',
  ASSIGNMENT: 'assignment',
  AI_UPLOAD: 'ai_upload',
});

/* ─────────────────────────────── AI module (SRS §21) ─────────────────────────────── */

/** SRS §21 — Teacher can upload PDF, Image, or Syllabus. */
const AI_SOURCE_TYPES = Object.freeze({
  PDF: 'pdf',
  IMAGE: 'image',
  SYLLABUS: 'syllabus',
});

/** SRS §21 — Upload → Extract → Analyze → Generate MCQs → Answers → Difficulty → Preview → Approve → Bank. */
const AI_WORKFLOW_STAGES = Object.freeze({
  UPLOADED: 'uploaded',
  EXTRACTED: 'extracted',
  ANALYZED: 'analyzed',
  GENERATED: 'generated',
  PREVIEW: 'preview',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

/** SRS §21 — "Select Difficulty". */
const QUESTION_DIFFICULTY = Object.freeze({
  EASY: 'easy',
  MEDIUM: 'medium',
  HARD: 'hard',
});

/** SRS §21 generates MCQs; `questions` also backs online_exams (§11.1). */
const QUESTION_TYPES = Object.freeze({
  MCQ: 'mcq',
});

const QUESTION_STATUS = Object.freeze({
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

const QUESTION_SOURCES = Object.freeze({
  AI: 'ai',
  MANUAL: 'manual',
});

const ONLINE_EXAM_STATUS = Object.freeze({
  DRAFT: 'draft',
  PUBLISHED: 'published',
  ONGOING: 'ongoing',
  CLOSED: 'closed',
});

/* ───────────────────────── Reports & notifications (SRS §22–§23) ───────────────────────── */

/** SRS §22 — the seven report types. */
const REPORT_TYPES = Object.freeze({
  STUDENT: 'student',
  ATTENDANCE: 'attendance',
  FEE: 'fee',
  EXPENSE: 'expense',
  EXAM: 'exam',
  TEACHER: 'teacher',
  SUBSCRIPTION: 'subscription',
});

const REPORT_TYPE_LIST = Object.freeze(Object.values(REPORT_TYPES));

/**
 * SRS §22 — export formats.
 *
 * `print` is **client-side and is not a server format.** This comment used to promise that the
 * format returned server-rendered HTML — a shape nothing in this application can produce:
 * there is no view engine here, no `res.render` and no template directory, and
 * `reports.service.js` said so in its own header while leaving the promise standing above it.
 * `verify-frontend.js` now asserts the promise is gone, so the phrasing here is load-bearing:
 * restoring the old sentence fails a named check rather than quietly re-describing the format.
 * `SUPPORTED_FORMATS` omits `print`, so `?format=print` is refused 422 — asserted twice in
 * `verify-reports.js`. FR-REPORT-002 states the behaviour as an actor's action, *"User prints
 * the report"*, and that is satisfied in the browser: a print control over the rendered report
 * plus the `@media print` block in `frontend/src/app/globals.css`.
 *
 * `json` is the un-exported form — the report itself — which is why it sits here beside three
 * formats §22 names without pretending §22 named a fourth.
 */
const REPORT_FORMATS = Object.freeze({
  JSON: 'json',
  PDF: 'pdf',
  EXCEL: 'excel',
  PRINT: 'print',
});

/** SRS §23 — the nine notification types. No others are introduced. */
const NOTIFICATION_TYPES = Object.freeze({
  FEE_REMINDER: 'fee_reminder',
  FEE_PAID: 'fee_paid',
  EXAM_ANNOUNCEMENT: 'exam_announcement',
  RESULT_PUBLISHED: 'result_published',
  ATTENDANCE_ALERT: 'attendance_alert',
  HOMEWORK: 'homework',
  SUBSCRIPTION_EXPIRY: 'subscription_expiry',
  PAYMENT_RECEIVED: 'payment_received',
  PAYMENT_FAILED: 'payment_failed',
});

const NOTIFICATION_TYPE_LIST = Object.freeze(Object.values(NOTIFICATION_TYPES));

/**
 * Delivery channels. SRS §35 marks "Additional notification channels" as unspecified,
 * so only in-app persistence and e-mail (required anyway by §7 email verification) exist.
 */
const NOTIFICATION_CHANNELS = Object.freeze({
  IN_APP: 'in_app',
  EMAIL: 'email',
});

const NOTIFICATION_STATUS = Object.freeze({
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  READ: 'read',
});

/* ─────────────────────────────── Infrastructure ─────────────────────────────── */

/** Queue job names (SRS §25 "Background jobs", "Queue system"). */
const JOB_NAMES = Object.freeze({
  SEND_EMAIL: 'send_email',
  SEND_NOTIFICATION: 'send_notification',
  GENERATE_REPORT: 'generate_report',
  GENERATE_DOCUMENT: 'generate_document',
  AI_GENERATE_QUESTIONS: 'ai_generate_questions',
  RECALCULATE_RESULTS: 'recalculate_results',
  SYNC_USAGE: 'sync_usage',
  DATABASE_BACKUP: 'database_backup',
});

const QUEUE_JOB_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

/** Activity-log actions (SRS §26 "Activity Logs"). */
const ACTIVITY_ACTIONS = Object.freeze({
  LOGIN: 'login',
  LOGIN_FAILED: 'login_failed',
  LOGOUT: 'logout',
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  VIEW: 'view',
  EXPORT: 'export',
  APPROVE: 'approve',
  REJECT: 'reject',
  ACCESS_DENIED: 'access_denied',
});

const PAGINATION = Object.freeze({
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 25,
  MAX_LIMIT: 100,
});

/* ───────────────── File uploads (SRS §21, §13.3, §15.1, §24 FR-SEC-004) ───────────────── */

/**
 * Accepted MIME types, each mapped to the extensions that legitimately carry it.
 *
 * The SRS enumerates upload file types in exactly one place — §21 / FR-AI-001, which names
 * "PDF, Image, Syllabus". Every other upload surface either names a shape without a format
 * ("screenshot", "Photo") or is marked "Not Specified in Source Requirements" (FR-SEC-004,
 * which nonetheless *requires* file-upload validation under §24 "File Upload security").
 * This table is therefore the narrowest set that satisfies every surface the document
 * describes: PDF plus the common raster image formats, and nothing else.
 *
 * SVG is excluded deliberately — it is an image by MIME family but can carry script, which
 * would defeat the §24 requirement it would otherwise satisfy.
 */
const UPLOAD_MIME_EXTENSIONS = Object.freeze({
  'application/pdf': Object.freeze(['.pdf']),
  'image/jpeg': Object.freeze(['.jpg', '.jpeg']),
  'image/png': Object.freeze(['.png']),
  'image/webp': Object.freeze(['.webp']),
});

const UPLOAD_MIME_LIST = Object.freeze(Object.keys(UPLOAD_MIME_EXTENSIONS));

/** Flat extension allowlist, derived — never maintained separately. */
const UPLOAD_EXTENSION_LIST = Object.freeze(
  Object.values(UPLOAD_MIME_EXTENSIONS).reduce((all, exts) => all.concat(exts), []),
);

/**
 * Extension -> MIME, derived from the same table and never maintained separately.
 *
 * `question_banks` stores `source_type`, `source_path` and `source_filename` and no MIME column, and
 * §35 forbids adding one. But the AI driver has to dispatch on format — a PDF is parsed locally, an
 * image goes to the model as an image block — so the format has to come from somewhere the schema
 * already holds. The filename extension is that place, and it is safe to trust precisely here:
 * `uploadSingle` has already refused any file whose extension is not in this table.
 *
 * `source_type` cannot serve instead. It is §21's *semantic* category — PDF, Image, Syllabus — and a
 * syllabus is a document that arrives as either format.
 */
const UPLOAD_EXTENSION_MIME = Object.freeze(
  Object.entries(UPLOAD_MIME_EXTENSIONS).reduce((all, [mime, exts]) => {
    exts.forEach((ext) => {
      all[ext] = mime;
    });
    return all;
  }, {}),
);

/** Image-only subset, for the surfaces the SRS describes as a photo or a screenshot. */
const UPLOAD_IMAGE_MIMES = Object.freeze(
  UPLOAD_MIME_LIST.filter((mime) => mime.startsWith('image/')),
);

/** One profile per upload surface the SRS actually describes. */
const UPLOAD_PROFILES = Object.freeze({
  AI_SOURCE: 'ai_source',
  PAYMENT_PROOF: 'payment_proof',
  PERSON_PHOTO: 'person_photo',
  HOMEWORK: 'homework',
  SUBMISSION: 'submission',
  STUDENT_DOCUMENT: 'student_document',
});

const UPLOAD_PROFILE_LIST = Object.freeze(Object.values(UPLOAD_PROFILES));

/** Default cap on files per multi-file request. Not an SRS figure — an operational bound. */
const UPLOAD_MAX_FILES_DEFAULT = 10;

/**
 * Per-surface upload rules.
 *
 * `srs` records the clause each rule came from so the reasoning survives review.
 * `maxFiles` is an operational bound multer needs in order not to accept an unbounded
 * array; it is 1 wherever the SRS describes a single artefact.
 *
 * Byte size is *not* here on purpose: SRS §11.2 makes `file_upload_limit` a per-plan limit
 * in megabytes, so the effective ceiling is resolved per request from the subscription
 * (falling back to `env.uploads.maxMb` when the plan grants Unlimited).
 */
const UPLOAD_RULES = Object.freeze({
  [UPLOAD_PROFILES.AI_SOURCE]: Object.freeze({
    srs: '§21 / FR-AI-001 — "Upload PDF / Image / Syllabus"',
    mimeTypes: UPLOAD_MIME_LIST,
    maxFiles: 1,
  }),
  [UPLOAD_PROFILES.PAYMENT_PROOF]: Object.freeze({
    srs: '§13.3 / FR-BILL-003 — manual payment "screenshot"',
    mimeTypes: UPLOAD_IMAGE_MIMES,
    maxFiles: 1,
  }),
  [UPLOAD_PROFILES.PERSON_PHOTO]: Object.freeze({
    srs: '§15.1 / FR-STUDENT-001 — "Photo"',
    mimeTypes: UPLOAD_IMAGE_MIMES,
    maxFiles: 1,
  }),
  [UPLOAD_PROFILES.HOMEWORK]: Object.freeze({
    srs: '§20.2 / FR-HW-001 — "Upload File" (format not specified)',
    mimeTypes: UPLOAD_MIME_LIST,
    maxFiles: 1,
  }),
  [UPLOAD_PROFILES.SUBMISSION]: Object.freeze({
    srs: '§20.3 / FR-ASG-001 — student "Submit" (format not specified)',
    mimeTypes: UPLOAD_MIME_LIST,
    maxFiles: 1,
  }),
  [UPLOAD_PROFILES.STUDENT_DOCUMENT]: Object.freeze({
    srs: '§15.1 / FR-STUDENT-001 — "Documents" (formats not specified)',
    mimeTypes: UPLOAD_MIME_LIST,
    maxFiles: UPLOAD_MAX_FILES_DEFAULT,
  }),
});

module.exports = {
  ROLES,
  ROLE_LIST,
  PLATFORM_ROLES,
  SCHOOL_ADMIN_ROLES,
  STAFF_CATEGORIES,
  USER_STATUS,
  LOGIN_ALLOWED_STATUSES,
  SCHOOL_STATUS,
  ORGANIZATION_STATUS,
  ACADEMIC_SESSION_STATUS,
  PLAN_STATUS,
  PLAN_VISIBILITY,
  BILLING_CYCLES,
  BILLING_CYCLE_LIST,
  BILLING_CYCLE_DAYS,
  PRICING_MODELS,
  PRICING_MODEL_LIST,
  MODULES,
  MODULE_LIST,
  MODULE_LABELS,
  LIMITS,
  LIMIT_LIST,
  ADDON_ONLY_LIMITS,
  USAGE_LIMIT_KEYS,
  LIMIT_LABELS,
  LIMIT_TYPES,
  LIMIT_UNITS,
  HEADCOUNT_LIMITS,
  PERIODIC_LIMITS,
  ADDONS,
  ADDON_LIST,
  ADDON_EFFECTS,
  SUBSCRIPTION_STATES,
  SUBSCRIPTION_STATE_LIST,
  SUBSCRIPTION_USABLE_STATES,
  TRIAL_DURATION_DAYS,
  GRACE_PERIOD_DAYS,
  DOWNGRADE_TIMING,
  RENEWAL_MODES,
  SUBSCRIPTION_EVENTS,
  OVERRIDE_TYPES,
  PRICE_OVERRIDE_TARGETS,
  INVOICE_STATUS,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LIST,
  PAYMENT_STATUS,
  PAYMENT_TRANSACTION_STATUS,
  REFUND_STATUS,
  COUPON_TYPES,
  COUPON_STATUS,
  QUOTATION_STATUS,
  STUDENT_STATUS,
  GENDERS,
  ATTENDANCE_STATUS,
  ATTENDANCE_STATUS_LIST,
  ATTENDANCE_REPORT_PERIODS,
  FEE_COMPONENTS,
  FEE_COMPONENT_LIST,
  STUDENT_FEE_STATUS,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  EXAM_STATUS,
  MARK_STATUS,
  RESULT_OUTCOME,
  WEEKDAYS,
  WEEKDAY_LIST,
  ASSIGNMENT_RECORD_TYPES,
  ASSIGNMENT_STATUS,
  SUBMISSION_STATUS,
  LIBRARY_TRANSACTION_STATUS,
  LIBRARY_BORROWER_TYPES,
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LIST,
  DOCUMENT_TYPE_MODULE,
  DOCUMENT_OWNER_TYPES,
  AI_SOURCE_TYPES,
  AI_WORKFLOW_STAGES,
  QUESTION_DIFFICULTY,
  QUESTION_TYPES,
  QUESTION_STATUS,
  QUESTION_SOURCES,
  ONLINE_EXAM_STATUS,
  REPORT_TYPES,
  REPORT_TYPE_LIST,
  REPORT_FORMATS,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_LIST,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUS,
  JOB_NAMES,
  QUEUE_JOB_STATUS,
  ACTIVITY_ACTIONS,
  PAGINATION,
  UPLOAD_MIME_EXTENSIONS,
  UPLOAD_MIME_LIST,
  UPLOAD_EXTENSION_LIST,
  UPLOAD_EXTENSION_MIME,
  UPLOAD_IMAGE_MIMES,
  UPLOAD_PROFILES,
  UPLOAD_PROFILE_LIST,
  UPLOAD_MAX_FILES_DEFAULT,
  UPLOAD_RULES,
};
