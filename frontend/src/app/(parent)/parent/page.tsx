'use client';

/**
 * Parent dashboard — SRS §15.2 (FR-PARENT-002), checklist row 4.6.
 *
 * ## What a parent's grants actually reach
 *
 * §5 gives a parent an account, links to children and "access to a Parent Dashboard", and
 * FR-PARENT-001's outcome is that the parent "can access records for all linked children". The
 * `parent` block in `permissions.js` carries that onto these read routes, each confined to the
 * caller's own children by the service rather than by the permission:
 *
 *   - `GET /parents/dashboard` (`parents.dashboard.view`) — this screen: the children and their links;
 *   - `GET /exams/my-results` (`results.self.view`) — published results only, confined by
 *     `exams.service.js myResults()` through `parent_students` — the Results screen;
 *   - `GET /homework` (`homework.view`) — published homework, narrowed by `homework.service.js` to
 *     the children's classes — the Homework screen;
 *   - `GET /attendance/mine`, `GET /fees/mine` and `GET /students/mine` (`attendance.self.view`,
 *     `fees.self.view`, `students.self.view`) — the owner's decision D17, confined by
 *     `services/selfScope.js` — the Attendance, Fees and Student record screens;
 *   - `GET /timetable/class/:classId` (`timetable.view`), for the class this dashboard names — the
 *     Timetable screen;
 *   - `GET /assignments` (`assignments.view`) and the notification inbox, linked from the header.
 *
 * This header used to say that the dashboard and `GET /parents/{id}/children` were the only two
 * endpoints a parent's permissions reach. The second is `parents.view`, which a parent does not hold,
 * and the claim left out the results and homework routes above — so results the API was already
 * confining to a parent's own children had no screen, and the footnote told parents the school office
 * held them.
 *
 * It then said the three self-view keys had **no route behind them**, and the footnote told parents
 * that attendance and fees were held by the school office. Both were true until D17 mounted the three
 * routes; the screens now exist and are linked below the table.
 */

import Link from 'next/link';

import { Icon } from '@/components/icon';
import { useAuth } from '@/lib/auth';
import { useEntitlements } from '@/lib/entitlements';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

import { childName, useParentDashboard } from './children';
import type { ChildLink } from './children';

/**
 * The children's records, each gated exactly as its `PARENT_NAV` entry is — the permission and the
 * module its router requires — so a card never leads to a refusal the nav would have spared. Each
 * screen asks which child when there is more than one.
 */
const RECORDS = [
  { href: '/parent/results', label: 'Results', description: 'Exam results, once the school publishes them.', icon: 'bar-chart' as const, permission: 'results.self.view', module: 'exams' },
  { href: '/parent/homework', label: 'Homework', description: 'Homework published for your children’s classes.', icon: 'book' as const, permission: 'homework.view', module: 'homework' },
  { href: '/parent/attendance', label: 'Attendance', description: 'The register for a day, a month or a year, with the percentage.', icon: 'clipboard' as const, permission: 'attendance.self.view', module: 'attendance' },
  { href: '/parent/fees', label: 'Fees', description: 'What is charged, paid and still pending, with the receipts.', icon: 'wallet' as const, permission: 'fees.self.view', module: 'fees' },
  { href: '/parent/timetable', label: 'Timetable', description: 'Each child’s class week, period by period.', icon: 'calendar' as const, permission: 'timetable.view', module: 'timetable' },
  { href: '/parent/record', label: 'Student record', description: 'What the school holds on file about each child.', icon: 'user' as const, permission: 'students.self.view', module: 'students' },
];

export default function ParentDashboard() {
  const { profile, can } = useAuth();
  const { hasModule } = useEntitlements();
  const { data, loading, error, refusal, reload } = useParentDashboard();

  const records = RECORDS.filter((item) => can(item.permission) && hasModule(item.module));

  /*
   * Class and Section by name. They were missing because `dashboard()` selected each child's
   * `class_id` and `section_id` without joining `Class` or `Section`, and a parent holds no
   * `classes.view` to resolve an id another way; the service now includes both names (SRS:842,
   * "relevant information for their children"). Either can be null — a child not yet placed, or a
   * class not divided into sections — and says so with a dash rather than an id.
   */
  const columns: Column<ChildLink>[] = [
    {
      key: 'name',
      header: 'Child',
      cell: (row) =>
        row.student ? (
          <span className="font-medium">{childName(row.student)}</span>
        ) : (
          <span className="text-muted-soft">student #{row.student_id}</span>
        ),
    },
    {
      key: 'student_id',
      header: 'Student ID',
      cell: (row) => <code className="text-xs text-muted">{row.student?.student_id ?? '—'}</code>,
    },
    { key: 'class', header: 'Class', cell: (row) => row.student?.class?.name ?? <span className="text-muted-soft">—</span> },
    { key: 'section', header: 'Section', cell: (row) => row.student?.section?.name ?? <span className="text-muted-soft">—</span> },
    { key: 'roll', header: 'Roll', cell: (row) => row.student?.roll_number ?? <span className="text-muted-soft">—</span> },
    {
      key: 'relation',
      /*
       * Free text, not an ENUM — so plain text rather than a badge, for the same reason the school
       * Parents screen renders it plainly: a badge would imply a vocabulary the database does not
       * enforce.
       */
      header: 'Relation',
      cell: (row) => row.relation ?? <span className="text-muted-soft">—</span>,
    },
    {
      key: 'primary',
      header: 'Primary contact',
      /*
       * The flag decides who is contacted first, so it earns a column on the one screen that shows a
       * parent their links. Rendered as words rather than a tick, which a screen reader announces as
       * nothing.
       */
      cell: (row) => (row.is_primary_guardian ? 'yes' : <span className="text-muted-soft">no</span>),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (row.student ? <StatusBadge status={row.student.status} /> : <span className="text-muted-soft">—</span>),
    },
  ];

  return (
    <div>
      <PageHeader
        title={`Welcome, ${profile?.user.name ?? 'parent'}`}
        description="The children linked to your account."
        action={
          /*
           * The inbox — §23 addresses attendance alerts, fee reminders, receipts and results to a
           * guardian — and the children's assignments (`assignments.view`, narrowed to their classes
           * by the API). Links rather than nav entries, as the student dashboard does.
           *
           * Results and Homework used to be buttons here as well. They are records FR-PARENT-001
           * promises, like the four D17 added, so all six now sit together under the table — the
           * same list the nav's Records section carries.
           */
          <div className="flex flex-wrap gap-2">
            <Link href="/parent/notifications" className="btn btn-secondary">
              Notifications
            </Link>
            {can('assignments.view') ? (
              <Link href="/school/assignments" className="btn btn-secondary">
                Assignments
              </Link>
            ) : null}
          </div>
        }
      />

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading ? (
        <LoadingBlock />
      ) : !data ? null : data.children.length === 0 ? (
        /*
         * A parent account with no linked children is a normal state — the account is created before
         * the link (FR-PARENT-001 then FR-PARENT-003) — and the remedy is someone else's to apply, so
         * the message says who rather than offering an action this screen cannot take.
         */
        <EmptyNotice>
          No children are linked to your account yet. The school office links a parent to a student.
        </EmptyNotice>
      ) : (
        <>
          <dl className="mb-5 grid grid-cols-2 gap-3 sm:max-w-sm">
            <div className="rounded-md border border-border p-3">
              <dt className="text-xs text-muted">Children</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{data.counts.children}</dd>
            </div>
            <div className="rounded-md border border-border p-3">
              <dt className="text-xs text-muted">Currently enrolled</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{data.counts.activeChildren}</dd>
            </div>
          </dl>

          <DataTable columns={columns} rows={data.children} rowKey={(row) => row.id} caption="Your children"
            busy={loading}
          />

          {records.length > 0 ? (
            <section className="mt-8">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                Your children’s records
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {records.map((item) => (
                  <li key={item.href}>
                    <Link href={item.href} className="card card-interactive block p-4">
                      <span className="flex items-center gap-2 font-semibold text-ink">
                        <Icon name={item.icon} size={16} className="shrink-0 text-muted-soft" />
                        {item.label}
                      </span>
                      <p className="mt-1.5 text-xs leading-relaxed text-muted">{item.description}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/*
            * This footnote used to say that attendance and fees were "held by the school office" —
            * true while their permissions had no route, and false since D17 mounted them; they are
            * linked above. What is still worth saying is that the records are read-only, and who to
            * ask when one is wrong.
            */}
          <p className="mt-4 text-xs text-muted-soft">
            Your children’s records are read-only here. If something looks wrong, speak to the school
            office.
          </p>
        </>
      )}
    </div>
  );
}
