/**
 * The navigation, as data — SRS §33's screen list, §30 Rule 1, checklist rows 4.1 and 4.10.
 *
 * ## Why the nav is a table and not JSX
 *
 * Rule 1 requires gating to be database-driven. A sidebar written as markup would have to decide
 * visibility inline, and the moment one item asks a question the others do not, the rule is being
 * re-implemented per item. Here every item answers the same two questions — *which permission does
 * this screen need, and which module does it belong to* — and one function filters the whole tree.
 *
 * ## Where each column comes from
 *
 * Neither column is invented. `permission` is a key from `backend/src/config/permissions.js`, whose
 * catalogue §29/§35 fix at 109 entries. `module` is the key the corresponding router actually
 * mounts — read out of the routers rather than guessed, because a nav gating on a module the API
 * does not check would hide a working screen, and one gating on nothing would show a screen that
 * 403s the moment it loads.
 *
 * `verify-frontend.js` asserts that every module key named here is one the backend defines.
 *
 * ## The two entries that are deliberately irregular
 *
 *   - **Documents** has no single module. §20.5's seven types span four of them
 *     (`DOCUMENT_TYPE_MODULE`: `id_cards`, `certificates`, `fees`, `exams`), and its router mounts
 *     `requireActiveSubscription()` rather than `requireModule()` for exactly that reason. It is
 *     listed with `anyModule`, so it appears when any of the four is subscribed — and the screen
 *     itself then offers only the types that are.
 *   - **Classes, Sections and Subjects** have no module at all. They are core school setup, and the
 *     routers mount no `requireModule()` on them; gating them behind one would invent a
 *     subscription rule the SRS does not have.
 */

import type { IconName } from '@/components/icon';
import type { Profile } from '@/lib/auth';

export interface NavItem {
  label: string;
  href: string;
  /**
   * The glyph the sidebar draws beside the label.
   *
   * Here rather than in the shell because the nav is the single source of truth for what a
   * destination IS — `verify-frontend.js` asserts that, and an icon map kept alongside would be a
   * second list to forget to update. Optional so a new entry renders correctly before one is chosen.
   */
  icon?: IconName;
  /** A permission key from the fixed 109-entry catalogue. */
  permission: string;
  /** The module key the matching router gates on, when it gates on one. */
  module?: string;
  /** For the one screen that spans several modules; shown if any is subscribed. */
  anyModule?: string[];
  /**
   * Other keys that reach the screen as well as `permission` — shown if the caller holds any of them.
   * Billing is the case: an Accountant holds `invoices.self.view` and `payments.submit`, not
   * `subscriptions.self.view`, and pays invoices from that screen.
   */
  anyPermission?: string[];
  /**
   * What the screen's first read needs beyond `permission` and `module`, when that read is on another
   * router. A portal timetable finds the student's class (or the teacher's id) through a self view on the
   * students, parents or teachers router, each with its own module and key; without them the link would
   * lead to a refusal naming a different module.
   */
  requires?: { permission?: string; module?: string };
}

export interface NavSection {
  heading: string;
  items: NavItem[];
}

/**
 * SRS §33 "Super Admin" — sixteen screens, and §26's Logs beside them.
 *
 * Modules, Features and Limits are the three sub-screens of a plan rather than top-level
 * destinations, so they sit under Plans; §33 lists them separately because it is enumerating
 * screens, not navigation. Nothing here carries a module: the platform surface is gated by
 * permission and never by subscription, which is also why `EntitlementProvider` answers `true` for
 * every module when there is no snapshot.
 */
export const PLATFORM_NAV: NavSection[] = [
  {
    heading: 'Overview',
    items: [
      { label: 'Dashboard', href: '/super-admin', icon: 'grid', permission: 'platform.dashboard.view' },
    ],
  },
  {
    heading: 'Tenants',
    items: [
      { label: 'Organizations', href: '/super-admin/organizations', icon: 'building', permission: 'organizations.view' },
      { label: 'Schools', href: '/super-admin/schools', icon: 'school', permission: 'schools.view' },
      { label: 'Principals', href: '/super-admin/principals', icon: 'user', permission: 'users.view' },
      { label: 'Users', href: '/super-admin/users', icon: 'users', permission: 'users.view' },
    ],
  },
  {
    heading: 'Catalogue',
    items: [
      { label: 'Plans', href: '/super-admin/plans', icon: 'layers', permission: 'plans.view' },
      { label: 'Modules', href: '/super-admin/plans/modules', icon: 'grid', permission: 'plans.view' },
      { label: 'Features', href: '/super-admin/plans/features', icon: 'check-circle', permission: 'plans.view' },
      { label: 'Limits', href: '/super-admin/plans/limits', icon: 'filter', permission: 'plans.view' },
      { label: 'Add-ons', href: '/super-admin/addons', icon: 'plus', permission: 'addons.view' },
    ],
  },
  {
    heading: 'Billing',
    items: [
      { label: 'Subscriptions', href: '/super-admin/subscriptions', icon: 'refresh', permission: 'subscriptions.view' },
      { label: 'Invoices', href: '/super-admin/invoices', icon: 'receipt', permission: 'invoices.view' },
      { label: 'Payments', href: '/super-admin/payments', icon: 'credit-card', permission: 'payments.view' },
      { label: 'Coupons', href: '/super-admin/coupons', icon: 'ticket', permission: 'coupons.view' },
    ],
  },
  {
    heading: 'System',
    items: [
      { label: 'Reports', href: '/super-admin/reports', icon: 'bar-chart', permission: 'reports.view' },
      /*
       * §33 lists Settings as one of the sixteen Super Admin MVP screens, so this entry stays.
       *
       * What the screen may *contain* is not specified anywhere: the role table (SRS line 96) says
       * Super Admin manages "global settings (see Section 9)", and Section 9 then defines only 9.1
       * Dashboard, 9.2 School Management and 9.3 Principal Creation. No platform-scoped settings
       * endpoint exists either — `/school-settings` is §14.1, school-scoped, Principal actor — and
       * the screen it points at says exactly that.
       *
       * It is gated on **`settings.platform.manage`** — "Manage global settings", `permissions.js:39`,
       * already one of the fixed 109 and already granted to `super_admin` through `ALL`. An earlier
       * version of this comment claimed no settings permission existed and borrowed `schools.view`
       * instead. That was simply false, and it had a consequence: `organization_admin` holds
       * `schools.view`, so an org admin was shown a link into a **platform** screen. The correct key
       * reaches `super_admin` alone.
       *
       * The page therefore says what it cannot do rather than inventing a form. Checklist row 4.3.
       */
      { label: 'Settings', href: '/super-admin/settings', icon: 'settings', permission: 'settings.platform.manage' },
      /*
       * SRS §26 — "Errors and activity are auditable via logs" — and not one of §33's sixteen. The
       * activity and audit trails, on `logs.view`, which reaches the Super Admin and the Organization
       * Admin; `logs.service.js` confines the second to its own organization's rows.
       */
      { label: 'Logs', href: '/super-admin/logs', icon: 'clock', permission: 'logs.view' },
    ],
  },
];

/**
 * SRS §33 "School" — seventeen screens, and three more that a requirement or an owner's decision puts
 * beside them.
 *
 * Sections is a sub-screen of Classes in the API (a section belongs to a class and has no router of
 * its own), so it is listed beneath it rather than given a top-level entry that would 404.
 *
 * `verify-frontend.js` requires each of §33's seventeen and admits an entry beyond them only from an
 * allow-list that names its source. There are three:
 *
 *   - **Reports** — SRS §22. FR-REPORT-001's actors are "Super Admin / Principal / School Admin /
 *     Accountant / Teacher" (SRS:1190), and the only report screen was the platform one, whose school
 *     picker needs a key no school role holds. Gated as the school dashboard's shortcut to it is: the
 *     door is `reports.view` and the Reports module, and each report inside checks its second key.
 *   - **Billing** — the owner's decision D27: the school's own subscription, invoices and payments.
 *     On the subscription read, as the dashboard's shortcut is, and module-free: billing is how a
 *     school keeps its modules, so a school whose plan has lapsed must still be able to reach it.
 *   - **Logs** — SRS §26, "Errors and activity are auditable via logs". The activity and audit trails
 *     on `logs.view`, which school leadership holds; no module, because §26 is operational rather than
 *     something a plan sells.
 */
export const SCHOOL_NAV: NavSection[] = [
  {
    heading: 'Overview',
    items: [
      { label: 'Dashboard', href: '/school', icon: 'grid', permission: 'school.dashboard.view' },
    ],
  },
  {
    heading: 'People',
    items: [
      { label: 'Students', href: '/school/students', icon: 'graduation', permission: 'students.view', module: 'students' },
      { label: 'Teachers', href: '/school/teachers', icon: 'users', permission: 'teachers.view', module: 'teachers' },
      { label: 'Staff', href: '/school/staff', icon: 'user', permission: 'staff.view', module: 'staff' },
      { label: 'Parents', href: '/school/parents', icon: 'users', permission: 'parents.view', module: 'parent_portal' },
    ],
  },
  {
    heading: 'Academics',
    items: [
      { label: 'Classes', href: '/school/classes', icon: 'grid', permission: 'classes.view' },
      { label: 'Sections', href: '/school/classes/sections', icon: 'layers', permission: 'classes.view' },
      { label: 'Subjects', href: '/school/subjects', icon: 'book', permission: 'subjects.view' },
      { label: 'Timetable', href: '/school/timetable', icon: 'calendar', permission: 'timetable.view', module: 'timetable' },
      { label: 'Attendance', href: '/school/attendance', icon: 'clipboard', permission: 'attendance.view', module: 'attendance' },
      { label: 'Homework', href: '/school/homework', icon: 'clipboard', permission: 'homework.view', module: 'homework' },
    ],
  },
  {
    heading: 'Assessment',
    items: [
      { label: 'Exams', href: '/school/exams', icon: 'file-text', permission: 'exams.view', module: 'exams' },
      { label: 'Results', href: '/school/results', icon: 'bar-chart', permission: 'results.view', module: 'exams' },
    ],
  },
  {
    heading: 'Operations',
    items: [
      { label: 'Fees', href: '/school/fees', icon: 'wallet', permission: 'fees.view', module: 'fees' },
      { label: 'Finance', href: '/school/finance', icon: 'credit-card', permission: 'finance.view', module: 'finance' },
      { label: 'Library', href: '/school/library', icon: 'book', permission: 'library.view', module: 'library' },
      {
        label: 'Documents',
        href: '/school/documents', icon: 'file-text',
        permission: 'documents.view',
        anyModule: ['id_cards', 'certificates', 'fees', 'exams'],
      },
      /* SRS §22 — the first of the three entries beyond §33's seventeen; see the docblock above. */
      { label: 'Reports', href: '/school/reports', icon: 'bar-chart', permission: 'reports.view', module: 'reports' },
    ],
  },
  {
    heading: 'Administration',
    items: [
      /* The owner's decision D27, and SRS §26 — the other two. */
      { label: 'Billing', href: '/school/billing', icon: 'credit-card', permission: 'subscriptions.self.view', anyPermission: ['invoices.self.view'] },
      { label: 'Logs', href: '/school/logs', icon: 'clock', permission: 'logs.view' },
    ],
  },
];


/**
 * SRS §15.3 — the teacher surface.
 *
 * §5 (SRS:100) says a teacher takes attendance, enters marks, "creates homework and assignments",
 * manages teaching periods and "participates in the AI question-generation workflow", and every one
 * of those is an existing School screen they already hold the permission for. So this nav **points
 * into those screens** rather than duplicating them: a second attendance screen gated differently is
 * how two versions of one workflow start.
 *
 * Assignments and AI questions were missing, although FR-ASG-001 (SRS:1107) and FR-AI-001 (SRS:1152)
 * both name Teacher as an actor and the `teacher` block grants `assignments.view` and `ai.generate`.
 * They are absent from `SCHOOL_NAV` for a reason that does not apply here — that nav is §33's
 * seventeen plus an allow-list of three, each with its source, and `verify-frontend.js` reads only its
 * block — so the principal reaches them from the school dashboard, and nothing led a teacher to them
 * at all. `(school)/layout.tsx` guards nothing beyond sign-in, so a teacher opens both routes under the
 * School shell as they already open Attendance, and each screen gates its own controls.
 *
 * The module keys are the same ones the School nav and the school dashboard use, so a school whose
 * plan omits Homework — or AI — hides it from the teacher too, from one source of truth.
 *
 * **My timetable is the one screen of the teacher's own.** `/school/timetable` is the whole school's
 * week — it sends no teacher filter — so a teacher asking "where am I on Tuesday" had to read every
 * class's grid. `teacher/timetable` asks `GET /timetable/teacher/:teacherId` instead, with the id
 * `GET /teachers/dashboard` returns; the school one is relabelled so the two are not both
 * "Timetable".
 *
 * **Reports** because FR-REPORT-001's actor line names Teacher (SRS:1190) and the `teacher` block
 * grants `reports.view` and `reports.export`. It opens the school Reports screen under the School
 * shell, as the entries above do, gated as the school dashboard gates its own Reports shortcut:
 * `reports.view` and the Reports module. Each report inside checks its second key again.
 */
export const TEACHER_NAV: NavSection[] = [
  {
    heading: 'Overview',
    items: [{ label: 'Dashboard', href: '/teacher', permission: 'teachers.dashboard.view' }],
  },
  {
    heading: 'My teaching',
    items: [
      { label: 'My timetable', href: '/teacher/timetable', icon: 'calendar', permission: 'timetable.view', module: 'timetable', requires: { permission: 'teachers.dashboard.view', module: 'teachers' } },
      { label: 'Attendance', href: '/school/attendance', icon: 'clipboard', permission: 'attendance.view', module: 'attendance' },
      { label: 'Exams and marks', href: '/school/exams', icon: 'file-text', permission: 'exams.view', module: 'exams' },
      { label: 'Homework', href: '/school/homework', icon: 'clipboard', permission: 'homework.view', module: 'homework' },
      { label: 'Assignments', href: '/school/assignments', icon: 'paperclip', permission: 'assignments.view', module: 'assignments' },
      { label: 'School timetable', href: '/school/timetable', icon: 'grid', permission: 'timetable.view', module: 'timetable' },
      { label: 'AI questions', href: '/school/ai', icon: 'layers', permission: 'ai.generate', module: 'ai' },
      { label: 'Reports', href: '/school/reports', icon: 'bar-chart', permission: 'reports.view', module: 'reports' },
    ],
  },
];

/**
 * SRS §15.2 — the parent surface.
 *
 * §5 grants a parent an account, a link to children, and "access to a Parent Dashboard", and
 * FR-PARENT-001's outcome is that the parent "can access records for all linked children". Two of
 * those records the API served a parent before D17, confined to their own children by the service:
 * published results on `GET /exams/my-results` (`results.self.view`) and homework on `GET /homework`
 * (`homework.view`). This nav used to carry the dashboard alone, saying the API exposed nothing more.
 *
 * Each record is gated on the module its router requires, as the School nav's are.
 *
 * Attendance, fees and the student record joined them with the owner's decision D17, which mounted
 * the three self-view keys the catalogue had granted a parent from the start: `GET /attendance/mine`
 * (`attendance.self.view`), `GET /fees/mine` (`fees.self.view`) and `GET /students/mine`
 * (`students.self.view`), each confined to the caller's own children by `services/selfScope.js`. The
 * class timetable is `GET /timetable/class/:classId` on `timetable.view`, the key everyone reads a
 * timetable with — the child's class comes from the dashboard.
 */
export const PARENT_NAV: NavSection[] = [
  {
    heading: 'Overview',
    items: [{ label: 'My children', href: '/parent', permission: 'parents.dashboard.view' }],
  },
  {
    heading: 'Records',
    items: [
      { label: 'Results', href: '/parent/results', icon: 'bar-chart', permission: 'results.self.view', module: 'exams' },
      { label: 'Homework', href: '/parent/homework', icon: 'clipboard', permission: 'homework.view', module: 'homework' },
      { label: 'Attendance', href: '/parent/attendance', icon: 'check-circle', permission: 'attendance.self.view', module: 'attendance' },
      { label: 'Fees', href: '/parent/fees', icon: 'wallet', permission: 'fees.self.view', module: 'fees' },
      { label: 'Timetable', href: '/parent/timetable', icon: 'calendar', permission: 'timetable.view', module: 'timetable', requires: { permission: 'parents.dashboard.view', module: 'parent_portal' } },
      { label: 'Student record', href: '/parent/record', icon: 'user', permission: 'students.self.view', module: 'students' },
    ],
  },
];

/**
 * SRS §5 — the student surface.
 *
 * §5 gives a student "access relevant to their own records within their school" (SRS:105), and §33's
 * MVP list names no student screen. For a long time only `results.self.view` of the four self-service
 * keys in §29's catalogue had a route, so this nav carried results and homework alone. The owner's
 * decision D17 mounted the other three — `GET /students/mine`, `GET /attendance/mine` and
 * `GET /fees/mine`, each confined to the caller by `services/selfScope.js` — and they are here now,
 * with the class timetable, which a student reads on `timetable.view` like everyone else. Homework is
 * here because the student holds `homework.view` and `GET /homework` narrows it to their own class.
 *
 * Every entry carries the module its router requires. `module: 'exams'` because `GET /exams/my-results`
 * sits behind the exams router's `requireModule(MODULES.EXAMS)`: a school without the Exams module has
 * no results to publish, so the entry correctly disappears rather than leading to a refusal. The same
 * reasoning gives each of the others its own router's module.
 */
export const STUDENT_NAV: NavSection[] = [
  {
    heading: 'Overview',
    items: [{ label: 'My results', href: '/student', permission: 'results.self.view', module: 'exams' }],
  },
  {
    heading: 'Records',
    items: [
      { label: 'Homework', href: '/student/homework', icon: 'clipboard', permission: 'homework.view', module: 'homework' },
      { label: 'Attendance', href: '/student/attendance', icon: 'check-circle', permission: 'attendance.self.view', module: 'attendance' },
      { label: 'Fees', href: '/student/fees', icon: 'wallet', permission: 'fees.self.view', module: 'fees' },
      { label: 'Timetable', href: '/student/timetable', icon: 'calendar', permission: 'timetable.view', module: 'timetable', requires: { permission: 'students.self.view', module: 'students' } },
      { label: 'My record', href: '/student/record', icon: 'user', permission: 'students.self.view', module: 'students' },
    ],
  },
];

/**
 * Filter a nav tree to what this caller can both reach and use.
 *
 * Two gates, and the order does not matter because both must pass:
 *
 *   - **Permission** decides whether the screen exists for this role at all. Hiding it is a
 *     courtesy — the API refuses the call regardless, and this is navigation, not authorization.
 *   - **Module** decides whether the school's plan includes it. `hasModule` answers `true` when
 *     there is no snapshot, so a platform caller is never hidden from their own surface.
 *
 * A section whose items all disappear is dropped with them; an empty heading is worse than no
 * heading, because it reads as a section that failed to load.
 */
export function visibleNav(
  sections: NavSection[],
  can: (permission: string) => boolean,
  hasModule: (moduleKey: string) => boolean
): NavSection[] {
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (!can(item.permission) && !(item.anyPermission || []).some((key) => can(key))) return false;
        if (item.module && !hasModule(item.module)) return false;
        if (item.anyModule && !item.anyModule.some((key) => hasModule(key))) return false;
        if (item.requires && item.requires.permission && !can(item.requires.permission)) return false;
        if (item.requires && item.requires.module && !hasModule(item.requires.module)) return false;
        return true;
      }),
    }))
    .filter((section) => section.items.length > 0);
}

/* ─────────────────────────── where a caller lands after signing in ─────────────────────────── */

/**
 * The surface to send a caller to once they have a session.
 *
 * ## What this replaces, and why it was wrong
 *
 * Three screens each carried the same line — `login/page.tsx`, `change-password/page.tsx` and the
 * public landing page:
 *
 * ```ts
 * router.replace(profile.tenant.isPlatform ? '/super-admin' : '/school');
 * ```
 *
 * `isPlatform` is true for exactly one role: `PLATFORM_ROLES` in `config/constants.js` is
 * `[ROLES.SUPER_ADMIN]`. So that expression routed **everybody else** to `/school`, including the two
 * roles that hold no `school.dashboard.view` at all — measured against `config/permissions.js`, the
 * `parent` block has ten keys and the `student` block thirteen, and neither contains it.
 *
 * A parent therefore signed in and landed on the school administration dashboard: a page titled for
 * a school they do not administer, with every shortcut filtered away by `can()` and a sidebar
 * filtered to nothing. `/parent` was **unreachable**, because the only link to it lives in
 * `PARENT_NAV`, which only renders once you are already there. `change-password` matters just as
 * much as `login`: `must_change_password: true` is written by exactly three places —
 * `04-super-admin.js`, `principals.service.js` and `parents.service.js` — so every parent account a
 * school creates is forced through that screen on its first sign-in.
 *
 * ## Why the order is what it is
 *
 * Each surface is claimed by the permission its own nav gate names, so this function and
 * `visibleNav` cannot disagree about who a surface is for. The order is most-specific-first, because
 * three roles hold more than one of these keys:
 *
 *   - `teacher` holds **both** `teachers.dashboard.view` and `school.dashboard.view`, so the teacher
 *     surface has to be tested first or a teacher would never see their own dashboard.
 *   - `parent` holds **both** `parents.dashboard.view` and `results.self.view`, so the parent surface
 *     has to be tested before the student one.
 *   - `organization_admin` holds `platform.dashboard.view` **and** `school.dashboard.view`, so the
 *     platform surface is tested before the school one.
 *
 * ## The platform surface is for a caller above any one school
 *
 * `/super-admin` is claimed only by a caller with no school in scope — `aboveSchool` below. That is
 * the Super Admin, and since the owner's decision D18 the Organization Admin too (`level:
 * 'organization'`, `schoolId: null`, `isPlatform: false`).
 *
 * This used to require `isPlatform`, on the claim that every `/super-admin` route is `platformOnly()`.
 * That is true of the platform's writes and false of its reads: `GET /platform/dashboard` is
 * `platform.dashboard.view` alone, and the organizations, schools, users, subscriptions, invoices,
 * payments and reports reads behind the screens the Organization Admin holds keys for take no scope
 * guard — each confines its rows to the caller's organization on the server. So an Organization Admin
 * was sent to `/school`, which reports on one school and says it has none in scope, while the surface
 * built for it went unvisited.
 *
 * A caller *with* a school in scope never lands there, whatever it holds — a school role, or an
 * Organization Admin whose account names a school, which `resolveTenant` narrows to that school.
 *
 * The fallback stays `/school`.
 */
const LANDING_ROUTES: Array<{ permission: string; href: string; aboveSchool?: boolean }> = [
  { permission: 'platform.dashboard.view', href: '/super-admin', aboveSchool: true },
  { permission: 'parents.dashboard.view', href: '/parent' },
  { permission: 'teachers.dashboard.view', href: '/teacher' },
  { permission: 'school.dashboard.view', href: '/school' },
  { permission: 'results.self.view', href: '/student' },
];

export function landingRouteFor(profile: Pick<Profile, 'tenant' | 'permissions'>): string {
  const held = new Set(profile.permissions);

  for (const route of LANDING_ROUTES) {
    if (route.aboveSchool && profile.tenant.schoolId) continue;
    if (held.has(route.permission)) return route.href;
  }

  /* A role holding none of the five still needs somewhere to be; `/school` is where it went before. */
  return '/school';
}
