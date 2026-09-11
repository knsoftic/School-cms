'use strict';

/**
 * Permission catalogue — the vocabulary for SRS §7 "Permission middleware" / §4
 * "Permission-based access control", stored in the `permissions` table by the seeder.
 *
 * Permission keys follow `<module>.<action>`. Every key here maps to a capability the SRS
 * actually names; no capability is invented. `module` ties the permission to one of the twenty
 * subscribable modules (SRS §11.1) where applicable, so plan gating and permission gating
 * compose without either being hard-coded.
 */

const { ROLES, MODULES } = require('./constants');

/**
 * @typedef {Object} PermissionDef
 * @property {string} key
 * @property {string} group     grouping used by the permission-matrix UI
 * @property {string} name
 * @property {string|null} module  subscribable module this permission belongs to, when any
 */

/** @type {PermissionDef[]} */
const PERMISSIONS = [
  // Platform administration — SRS §9, §33 Super Admin
  { key: 'platform.dashboard.view', group: 'Platform', name: 'View platform dashboard', module: null },
  { key: 'organizations.view', group: 'Organizations', name: 'View organizations', module: null },
  { key: 'organizations.manage', group: 'Organizations', name: 'Create / edit organizations', module: null },
  { key: 'schools.view', group: 'Schools', name: 'View schools', module: null },
  { key: 'schools.manage', group: 'Schools', name: 'Create / edit schools', module: null },
  { key: 'schools.status', group: 'Schools', name: 'Activate / suspend schools', module: null },
  { key: 'schools.archive', group: 'Schools', name: 'Delete / archive schools', module: null },
  { key: 'schools.assign_principal', group: 'Schools', name: 'Assign / change principal', module: null },
  { key: 'schools.usage.view', group: 'Schools', name: 'View school usage', module: null },
  { key: 'users.view', group: 'Users', name: 'View users', module: null },
  { key: 'users.manage', group: 'Users', name: 'Create / edit users', module: null },
  { key: 'roles.view', group: 'Users', name: 'View roles & permissions', module: null },
  { key: 'roles.manage', group: 'Users', name: 'Assign role permissions', module: null },
  { key: 'settings.platform.manage', group: 'Platform', name: 'Manage global settings', module: null },

  // Subscription engine — SRS §10–§12
  { key: 'plans.view', group: 'Subscriptions', name: 'View subscription plans', module: null },
  { key: 'plans.manage', group: 'Subscriptions', name: 'Create / edit / duplicate / archive plans', module: null },
  { key: 'plans.pricing.manage', group: 'Subscriptions', name: 'Configure plan pricing & billing cycles', module: null },
  { key: 'plans.modules.manage', group: 'Subscriptions', name: 'Configure plan modules & features', module: null },
  { key: 'plans.limits.manage', group: 'Subscriptions', name: 'Configure plan limits', module: null },
  { key: 'addons.view', group: 'Subscriptions', name: 'View add-ons', module: null },
  { key: 'addons.manage', group: 'Subscriptions', name: 'Create / edit add-ons', module: null },
  { key: 'subscriptions.view', group: 'Subscriptions', name: 'View subscriptions', module: null },
  { key: 'subscriptions.manage', group: 'Subscriptions', name: 'Create / change subscriptions', module: null },
  { key: 'subscriptions.lifecycle', group: 'Subscriptions', name: 'Upgrade / downgrade / renew / pause / cancel', module: null },
  { key: 'subscriptions.overrides.manage', group: 'Subscriptions', name: 'Apply feature overrides & custom limits', module: null },
  { key: 'subscriptions.self.view', group: 'Subscriptions', name: 'View own school subscription', module: null },
  { key: 'subscriptions.self.manage', group: 'Subscriptions', name: 'Change own school subscription', module: null },

  // Billing — SRS §13
  { key: 'invoices.view', group: 'Billing', name: 'View invoices', module: null },
  { key: 'invoices.manage', group: 'Billing', name: 'Create / cancel invoices', module: null },
  { key: 'invoices.self.view', group: 'Billing', name: 'View own school invoices', module: null },
  { key: 'payments.view', group: 'Billing', name: 'View payments', module: null },
  { key: 'payments.record', group: 'Billing', name: 'Record a payment', module: null },
  { key: 'payments.submit', group: 'Billing', name: 'Submit a manual payment', module: null },
  { key: 'payments.approve', group: 'Billing', name: 'Approve / reject manual payments', module: null },
  { key: 'refunds.view', group: 'Billing', name: 'View refunds', module: null },
  { key: 'refunds.manage', group: 'Billing', name: 'Issue refunds', module: null },
  { key: 'coupons.view', group: 'Billing', name: 'View coupons', module: null },
  { key: 'coupons.manage', group: 'Billing', name: 'Create / edit coupons', module: null },
  { key: 'coupons.redeem', group: 'Billing', name: 'Apply a coupon', module: null },
  { key: 'taxes.view', group: 'Billing', name: 'View taxes', module: null },
  { key: 'taxes.manage', group: 'Billing', name: 'Create / edit taxes', module: null },
  { key: 'quotations.view', group: 'Billing', name: 'View quotations', module: null },
  { key: 'quotations.manage', group: 'Billing', name: 'Create / send quotations', module: null },

  // School setup — SRS §14
  { key: 'school.dashboard.view', group: 'School', name: 'View school dashboard', module: null },
  { key: 'school.settings.view', group: 'School', name: 'View school settings', module: null },
  { key: 'school.settings.manage', group: 'School', name: 'Manage school settings', module: null },
  { key: 'sessions.view', group: 'School', name: 'View academic sessions', module: null },
  { key: 'sessions.manage', group: 'School', name: 'Create / activate / close academic sessions', module: null },
  { key: 'classes.view', group: 'Academic', name: 'View classes & sections', module: null },
  { key: 'classes.manage', group: 'Academic', name: 'Manage classes, sections & class teachers', module: null },
  { key: 'subjects.view', group: 'Academic', name: 'View subjects', module: null },
  { key: 'subjects.manage', group: 'Academic', name: 'Create subjects & assign to classes/teachers', module: null },

  // People — SRS §15
  { key: 'students.view', group: 'People', name: 'View students', module: MODULES.STUDENTS },
  { key: 'students.manage', group: 'People', name: 'Admit / edit students', module: MODULES.STUDENTS },
  { key: 'students.progression', group: 'People', name: 'Promote / transfer / mark leaving', module: MODULES.STUDENTS },
  { key: 'students.self.view', group: 'People', name: 'View own student record', module: MODULES.STUDENTS },
  { key: 'parents.view', group: 'People', name: 'View parents', module: MODULES.PARENT_PORTAL },
  { key: 'parents.manage', group: 'People', name: 'Create parents & link children', module: MODULES.PARENT_PORTAL },
  { key: 'parents.dashboard.view', group: 'People', name: 'View parent dashboard', module: MODULES.PARENT_PORTAL },
  { key: 'teachers.view', group: 'People', name: 'View teachers', module: MODULES.TEACHERS },
  { key: 'teachers.manage', group: 'People', name: 'Create / edit teachers & assignments', module: MODULES.TEACHERS },
  { key: 'teachers.dashboard.view', group: 'People', name: 'View teacher dashboard', module: MODULES.TEACHERS },
  { key: 'staff.view', group: 'People', name: 'View staff', module: MODULES.STAFF },
  { key: 'staff.manage', group: 'People', name: 'Create / edit staff', module: MODULES.STAFF },

  // Attendance — SRS §16
  { key: 'attendance.view', group: 'Attendance', name: 'View attendance', module: MODULES.ATTENDANCE },
  { key: 'attendance.mark', group: 'Attendance', name: 'Mark student attendance', module: MODULES.ATTENDANCE },
  { key: 'attendance.teacher.view', group: 'Attendance', name: 'View teacher attendance', module: MODULES.ATTENDANCE },
  { key: 'attendance.teacher.mark', group: 'Attendance', name: 'Record teacher attendance', module: MODULES.ATTENDANCE },
  { key: 'attendance.self.view', group: 'Attendance', name: 'View own attendance', module: MODULES.ATTENDANCE },

  // Fees — SRS §17
  { key: 'fees.view', group: 'Fees', name: 'View fee structures & ledgers', module: MODULES.FEES },
  { key: 'fees.manage', group: 'Fees', name: 'Define fee structures & assign to students', module: MODULES.FEES },
  { key: 'fees.collect', group: 'Fees', name: 'Collect fee payments', module: MODULES.FEES },
  { key: 'fees.self.view', group: 'Fees', name: 'View own / child fees', module: MODULES.FEES },

  // Finance — SRS §18
  { key: 'finance.view', group: 'Finance', name: 'View income, expenses & net balance', module: MODULES.FINANCE },
  { key: 'finance.manage', group: 'Finance', name: 'Record income & expenses', module: MODULES.FINANCE },

  // Exams — SRS §19
  { key: 'exams.view', group: 'Exams', name: 'View examinations', module: MODULES.EXAMS },
  { key: 'exams.manage', group: 'Exams', name: 'Create / edit examinations & grade systems', module: MODULES.EXAMS },
  { key: 'marks.enter', group: 'Exams', name: 'Enter / edit / submit marks', module: MODULES.EXAMS },
  { key: 'results.view', group: 'Exams', name: 'View results', module: MODULES.EXAMS },
  { key: 'results.generate', group: 'Exams', name: 'Generate & publish results', module: MODULES.EXAMS },
  { key: 'results.self.view', group: 'Exams', name: 'View own / child results', module: MODULES.EXAMS },
  { key: 'online_exams.view', group: 'Exams', name: 'View online exams', module: MODULES.ONLINE_EXAMS },
  { key: 'online_exams.manage', group: 'Exams', name: 'Create / publish online exams', module: MODULES.ONLINE_EXAMS },
  { key: 'online_exams.attempt', group: 'Exams', name: 'Attempt an online exam', module: MODULES.ONLINE_EXAMS },

  // Timetable — SRS §20.1
  { key: 'timetable.view', group: 'Timetable', name: 'View timetables', module: MODULES.TIMETABLE },
  { key: 'timetable.manage', group: 'Timetable', name: 'Create / edit timetables', module: MODULES.TIMETABLE },

  // Homework & assignments — SRS §20.2–§20.3
  { key: 'homework.view', group: 'Homework', name: 'View homework', module: MODULES.HOMEWORK },
  { key: 'homework.manage', group: 'Homework', name: 'Create homework', module: MODULES.HOMEWORK },
  { key: 'assignments.view', group: 'Assignments', name: 'View assignments', module: MODULES.ASSIGNMENTS },
  { key: 'assignments.manage', group: 'Assignments', name: 'Create assignments', module: MODULES.ASSIGNMENTS },
  { key: 'assignments.submit', group: 'Assignments', name: 'Submit an assignment', module: MODULES.ASSIGNMENTS },
  { key: 'assignments.review', group: 'Assignments', name: 'Review submissions', module: MODULES.ASSIGNMENTS },

  // Library — SRS §20.4
  { key: 'library.view', group: 'Library', name: 'View library catalog & transactions', module: MODULES.LIBRARY },
  { key: 'library.manage', group: 'Library', name: 'Manage books, authors & categories', module: MODULES.LIBRARY },
  { key: 'library.issue', group: 'Library', name: 'Issue / return books & record fines', module: MODULES.LIBRARY },

  // Documents — SRS §20.5
  { key: 'documents.view', group: 'Documents', name: 'View generated documents', module: null },
  { key: 'documents.generate', group: 'Documents', name: 'Generate school documents', module: null },

  // AI — SRS §21
  { key: 'ai.generate', group: 'AI', name: 'Upload content & generate questions', module: MODULES.AI },
  { key: 'ai.approve', group: 'AI', name: 'Preview & approve generated questions', module: MODULES.AI },
  { key: 'ai.usage.view', group: 'AI', name: 'View AI usage against the plan limit', module: MODULES.AI },
  { key: 'question_bank.view', group: 'AI', name: 'View the question bank', module: MODULES.AI },
  { key: 'question_bank.manage', group: 'AI', name: 'Manage question banks & questions', module: MODULES.AI },

  // Reports — SRS §22
  { key: 'reports.view', group: 'Reports', name: 'Generate reports', module: MODULES.REPORTS },
  { key: 'reports.export', group: 'Reports', name: 'Export reports (PDF / Excel / Print)', module: MODULES.REPORTS },
  { key: 'reports.subscription.view', group: 'Reports', name: 'View subscription reports', module: null },

  // Notifications — SRS §23
  { key: 'notifications.view', group: 'Notifications', name: 'View own notifications', module: null },
  { key: 'notifications.send', group: 'Notifications', name: 'Send notifications', module: null },

  // Logs & operations — SRS §26
  { key: 'logs.view', group: 'Operations', name: 'View activity & audit logs', module: null },
  { key: 'backups.manage', group: 'Operations', name: 'Trigger & inspect database backups', module: null },
];

/** Fast lookup + guard against typos in role maps below. */
const PERMISSION_KEYS = Object.freeze(PERMISSIONS.map((p) => p.key));
const PERMISSION_KEY_SET = new Set(PERMISSION_KEYS);

/** Every permission — used for the Super Admin role. */
const ALL = PERMISSION_KEYS;

/*
 * School leadership's defaults before the owner's decision D27 — kept, because the seeder upgrades a role
 * that still holds exactly an earlier version's defaults (see `PREVIOUS_DEFAULTS`).
 */
const SCHOOL_LEADERSHIP_BEFORE_D27 = [
  'school.dashboard.view',
  'school.settings.view',
  'school.settings.manage',
  'sessions.view',
  'sessions.manage',
  'classes.view',
  'classes.manage',
  'subjects.view',
  'subjects.manage',
  'students.view',
  'students.manage',
  'students.progression',
  'parents.view',
  'parents.manage',
  'teachers.view',
  'teachers.manage',
  'staff.view',
  'staff.manage',
  'attendance.view',
  'attendance.mark',
  'attendance.teacher.view',
  'attendance.teacher.mark',
  'fees.view',
  'fees.manage',
  'fees.collect',
  'finance.view',
  'finance.manage',
  'exams.view',
  'exams.manage',
  'marks.enter',
  'results.view',
  'results.generate',
  'online_exams.view',
  'online_exams.manage',
  'timetable.view',
  'timetable.manage',
  'homework.view',
  'homework.manage',
  'assignments.view',
  'assignments.manage',
  'assignments.review',
  'library.view',
  'library.manage',
  'library.issue',
  'documents.view',
  'documents.generate',
  'ai.generate',
  'ai.approve',
  'ai.usage.view',
  'question_bank.view',
  'question_bank.manage',
  'reports.view',
  'reports.export',
  'notifications.view',
  'notifications.send',
  'logs.view',
  'users.view',
  'users.manage',
  'subscriptions.self.view',
  'subscriptions.self.manage',
  'invoices.self.view',
  'payments.submit',
  'coupons.redeem',
];

/*
 * The owner's decision D27 — the school billing screen. FR-SUB-013/014/015 and FR-BILL-003/005 name the
 * school as an actor, and school leadership held `subscriptions.self.manage` and `payments.submit` but
 * not the reads those actions need: the plans it could move to, the add-ons it could buy, and its own
 * payments' status. Three keys the catalogue already had; no new permission. A school's reads of all
 * three are confined by the tenant layer (`plans.service.scopeFor()` shows it the public active plans,
 * `addons.service` the active add-ons, `payments.service.list()` its own school's payments).
 */
const D27_BILLING_KEYS = ['plans.view', 'addons.view', 'payments.view'];
const SCHOOL_LEADERSHIP = [...SCHOOL_LEADERSHIP_BEFORE_D27, ...D27_BILLING_KEYS];

/**
 * Earlier versions' defaults, per role — what an install seeded before a default changed holds.
 *
 * `03-role-permissions` leaves a role's grants alone once it has any: they are the Super Admin's to
 * change. That also meant a change to the defaults never reached an existing install. A role whose
 * grants are **exactly** one of these earlier sets was never customised, so the seeder brings it up to
 * the current defaults; a role that differs in any way is left as configured.
 */
const PREVIOUS_DEFAULTS = Object.freeze({
  [ROLES.PRINCIPAL]: [SCHOOL_LEADERSHIP_BEFORE_D27],
  [ROLES.SCHOOL_ADMIN]: [SCHOOL_LEADERSHIP_BEFORE_D27],
});

/**
 * Default role → permission grants, seeded into `role_permissions`.
 *
 * These are *defaults*, not the runtime source of truth. `PUT /roles/:id/permissions` replaces a role's
 * grant set in the database, and the middleware always reads the database, never this map. Re-running
 * the seeder restores these values; a deployment that has customised its grants should not re-run it.
 *
 * The mutability rests on SRS §29 giving `role_permissions` its own table rather than fixing the grants
 * in the role row, and on FR-AUTH-009 requiring permission middleware that reads it. §33 lists a "Users"
 * screen but no roles screen, so it is not cited here.
 */
const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  [ROLES.SUPER_ADMIN]: ALL,

  [ROLES.ORGANIZATION_ADMIN]: [
    // SRS §5: the source places this role in the hierarchy above schools without
    // enumerating workflows, so it receives read access across its organization's
    // schools plus the subscription/billing views its position implies.
    'platform.dashboard.view',
    'organizations.view',
    'schools.view',
    'schools.usage.view',
    'school.dashboard.view',
    'users.view',
    'subscriptions.view',
    'subscriptions.self.view',
    'invoices.view',
    'invoices.self.view',
    'payments.view',
    'payments.submit',
    'reports.view',
    'reports.export',
    'reports.subscription.view',
    'notifications.view',
    'students.view',
    'teachers.view',
    'staff.view',
    'attendance.view',
    'fees.view',
    'finance.view',
    'exams.view',
    'results.view',
    'logs.view',
  ],

  [ROLES.PRINCIPAL]: SCHOOL_LEADERSHIP,

  // SRS §5 groups School Admin with Principals/Admins; same school-level administration.
  [ROLES.SCHOOL_ADMIN]: SCHOOL_LEADERSHIP,

  [ROLES.TEACHER]: [
    // SRS §5: manages assigned subjects/classes, takes attendance, enters/edits/submits marks,
    // creates homework and assignments, teaching periods, and the AI workflow.
    'school.dashboard.view',
    'teachers.dashboard.view',
    'classes.view',
    'subjects.view',
    'students.view',
    'parents.view',
    'attendance.view',
    'attendance.mark',
    'attendance.self.view',
    'exams.view',
    'marks.enter',
    'results.view',
    'online_exams.view',
    'online_exams.manage',
    'timetable.view',
    'homework.view',
    'homework.manage',
    'assignments.view',
    'assignments.manage',
    'assignments.review',
    'ai.generate',
    'ai.approve',
    'ai.usage.view',
    'question_bank.view',
    'question_bank.manage',
    'reports.view',
    'reports.export',
    'notifications.view',
    'documents.view',
  ],

  [ROLES.ACCOUNTANT]: [
    // SRS §5: associated with Finance/Fee school operations (Sections 17–18).
    'school.dashboard.view',
    'students.view',
    'fees.view',
    'fees.manage',
    'fees.collect',
    'finance.view',
    'finance.manage',
    'invoices.self.view',
    'payments.submit',
    'documents.view',
    'documents.generate',
    'reports.view',
    'reports.export',
    'notifications.view',
  ],

  [ROLES.RECEPTIONIST]: [
    // SRS §15.1 lists Receptionist among the actors that can admit a student (FR-STUDENT-001).
    'school.dashboard.view',
    'students.view',
    'students.manage',
    'parents.view',
    'parents.manage',
    'classes.view',
    'attendance.view',
    'fees.view',
    'fees.collect',
    'documents.view',
    'documents.generate',
    'notifications.view',
    'timetable.view',
  ],

  [ROLES.LIBRARIAN]: [
    // SRS §5: associated with the Library module (Section 20).
    'school.dashboard.view',
    'students.view',
    'teachers.view',
    'staff.view',
    'library.view',
    'library.manage',
    'library.issue',
    'reports.view',
    'reports.export',
    'notifications.view',
  ],

  [ROLES.STAFF]: [
    // SRS §15.4 "Other Staff" — general staff with no module-specific duties stated.
    'school.dashboard.view',
    'notifications.view',
    'timetable.view',
    'attendance.self.view',
  ],

  [ROLES.STUDENT]: [
    // SRS §5: "has access relevant to their own records within their school".
    'students.self.view',
    'attendance.self.view',
    'fees.self.view',
    'results.self.view',
    'timetable.view',
    'homework.view',
    'assignments.view',
    'assignments.submit',
    'online_exams.view',
    'online_exams.attempt',
    'library.view',
    'notifications.view',
    'documents.view',
  ],

  [ROLES.PARENT]: [
    // SRS §15.2: Parent Account, multiple children, Parent Dashboard.
    'parents.dashboard.view',
    'students.self.view',
    'attendance.self.view',
    'fees.self.view',
    'results.self.view',
    'timetable.view',
    'homework.view',
    'assignments.view',
    'notifications.view',
    'documents.view',
  ],
});

// Fail loudly at load time if a role map references a permission that does not exist.
for (const [role, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
  for (const key of keys) {
    if (!PERMISSION_KEY_SET.has(key)) {
      throw new Error(`DEFAULT_ROLE_PERMISSIONS["${role}"] references unknown permission "${key}"`);
    }
  }
}

module.exports = {
  PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSION_KEY_SET,
  DEFAULT_ROLE_PERMISSIONS,
  PREVIOUS_DEFAULTS,
};
