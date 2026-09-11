'use client';

/**
 * Student portal — SRS §5, checklist row 4.7.
 *
 * ## What a student's grants reach
 *
 * §5 gives the Student one sentence: they are the "subject of admission, class/section assignment,
 * attendance, fee, examination, result, timetable, homework, assignment, and library records" and
 * have "access relevant to their own records within their school" (SRS:105). §33's MVP list names no
 * student screen, so every screen here rests on a grant in the `student` block of `permissions.js`:
 *
 *   1. **Results** — `results.self.view` on `GET /exams/my-results`, because §19.3 describes a student
 *      seeing their result. This page.
 *   2. **Homework** — `homework.view` on `GET /homework`, which `homework.service.js` narrows to the
 *      student's own class and to published rows. `student/homework`.
 *   3. **Attendance, fees and the record** — `attendance.self.view`, `fees.self.view` and
 *      `students.self.view`. All three sat in §29's catalogue with no route until the owner's decision
 *      D17 mounted `GET /attendance/mine`, `GET /fees/mine` and `GET /students/mine`. This page used to
 *      tell a student the school office held those records; it now links to them.
 *   4. **Timetable** — `timetable.view` on `GET /timetable/class/:classId`, the student's class read
 *      from their own record. `student/timetable`.
 *
 * ## Only published results, and that is the backend's rule
 *
 * `exams.service.js` pins `is_published: true` on this query. A student cannot see a mark before the
 * school releases it, which is the entire point of `published_at` on an exam — so an empty list here
 * often means "not released yet" rather than "no exams", and the empty state says so.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { useEntitlements } from '@/lib/entitlements';
import { useCollection } from '@/lib/useCollection';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  Pagination,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

/**
 * One row of `GET /exams/my-results` — the `results` table, which the controller sends unmapped.
 *
 * Typed as the columns are, the way `(school)/school/results/page.tsx` types the same rows. The three
 * DECIMALs and both counters are `allowNull: false, defaultValue: 0` in `models/exams.js`, and
 * `config/database.js` sets `decimalNumbers: true`, so none of them can arrive as a string or as null.
 * They used to be typed `string | number | null` — which kept a dead null branch in the Subjects
 * failed cell and had this screen disagree with the school's results screen about the same column.
 * `grade_name` and `outcome` really are nullable.
 */
interface MyResult {
  id: number;
  exam_id: number;
  student_id: number;
  total_full_marks: number;
  total_marks_obtained: number;
  percentage: number;
  grade_name: string | null;
  outcome: string | null;
  subjects_count: number;
  subjects_failed: number;
  exam?: { id: number; name: string; exam_type: string | null; start_date: string | null };
}

/**
 * A DECIMAL, for display only.
 *
 * Two corrections to what this used to be. It said *"DECIMAL columns arrive as strings"* — they
 * arrive as JS **numbers**, because `config/database.js` sets `dialectOptions.decimalNumbers = true`.
 * The value still goes through `Number()`, which costs nothing on a number and keeps a `NaN` out of a
 * cell if that option is ever flipped. And it defaulted to `digits = 0`, so `toFixed(0)` was applied
 * to marks: a `DECIMAL(9,2)` total of **47.5 rendered as 48**. Not truncated — *rounded up*, so a
 * student saw a mark they had not been given, and half-marks vanished from every row that had one.
 *
 * The default now shows as many decimals as the value actually carries, up to two: `47` stays `47`,
 * `47.5` stays `47.5`. `percentage` still asks for exactly 2 explicitly, because a percentage reads
 * better padded.
 */
function figure(value: number, digits?: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (digits !== undefined) return parsed.toFixed(digits);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(parsed);
}

/**
 * The student's other records, each gated exactly as its `STUDENT_NAV` entry is — the permission and
 * the module its router requires — so a card never leads to a refusal the nav would have spared.
 */
const RECORDS = [
  { href: '/student/attendance', label: 'Attendance', description: 'Your register for a day, a month or a year, with the percentage.', permission: 'attendance.self.view', module: 'attendance' },
  { href: '/student/fees', label: 'Fees', description: 'What is charged, paid and still pending, with your receipts.', permission: 'fees.self.view', module: 'fees' },
  { href: '/student/timetable', label: 'Timetable', description: 'Your class’s week, period by period.', permission: 'timetable.view', module: 'timetable' },
  { href: '/student/homework', label: 'Homework', description: 'Homework published for your class, latest due date first.', permission: 'homework.view', module: 'homework' },
  { href: '/student/record', label: 'My record', description: 'What your school holds on file about you.', permission: 'students.self.view', module: 'students' },
];

export default function StudentPortal() {
  const { profile, can } = useAuth();
  const { hasModule } = useEntitlements();
  const [page, setPage] = useState(1);

  const records = RECORDS.filter((item) => can(item.permission) && hasModule(item.module));

  const query = useMemo(() => ({ page, limit: 20 }), [page]);
  const { rows, meta, loading, error, refusal, reload } = useCollection<MyResult>('/exams/my-results', query);

  const columns = useMemo<Column<MyResult>[]>(
    () => [
      {
        key: 'exam',
        header: 'Exam',
        cell: (row) => (
          <>
            <span className="font-medium">{row.exam?.name ?? `exam #${row.exam_id}`}</span>
            {row.exam?.exam_type ? (
              <span className="block text-xs text-muted-soft">{row.exam.exam_type.replace(/_/g, ' ')}</span>
            ) : null}
          </>
        ),
      },
      { key: 'date', header: 'Held', cell: (row) => row.exam?.start_date?.slice(0, 10) ?? <span className="text-muted-soft">—</span> },
      {
        key: 'marks',
        header: 'Marks',
        numeric: true,
        cell: (row) => {
          const got = figure(row.total_marks_obtained);
          const outOf = figure(row.total_full_marks);
          return got && outOf ? `${got} / ${outOf}` : <span className="text-muted-soft">—</span>;
        },
      },
      {
        key: 'percentage',
        header: 'Percentage',
        numeric: true,
        cell: (row) => {
          const pct = figure(row.percentage, 2);
          return pct ? `${pct}%` : <span className="text-muted-soft">—</span>;
        },
      },
      { key: 'grade', header: 'Grade', cell: (row) => row.grade_name ?? <span className="text-muted-soft">—</span> },
      {
        key: 'outcome',
        header: 'Outcome',
        /*
         * `RESULT_OUTCOME` is `pass` / `fail`, and both are toned in `StatusBadge` — they were not
         * until session 26, because the tone map only scanned vocabularies named `*_STATUS`.
         */
        cell: (row) => (row.outcome ? <StatusBadge status={row.outcome} /> : <span className="text-muted-soft">—</span>),
      },
      {
        key: 'failed',
        header: 'Subjects failed',
        numeric: true,
        /*
         * Shown even when zero. A blank here would be ambiguous between "none" and "not computed",
         * and on a result card the difference matters to the person reading it. There is no null
         * branch: the column is NOT NULL with a default of 0 — see `MyResult`.
         */
        cell: (row) => (
          <span className={row.subjects_failed > 0 ? 'font-medium' : 'text-muted-soft'}>
            {row.subjects_failed}
            {row.subjects_count ? <span className="text-muted-soft"> of {row.subjects_count}</span> : null}
          </span>
        ),
      },
    ],
    []
  );

  return (
    <div>
      <PageHeader
        title={`Your results, ${profile?.user.name ?? ''}`.trim()}
        description="Results appear here once your school publishes them."
        action={
          /*
           * The two screens a student acts on and could not reach from here: the inbox §23 addresses
           * them in, and the assignments they hand work in to (`assignments.submit`). Links rather than
           * nav entries, as the School surface links its own extra screens.
           *
           * Homework used to be a button here too. It is one of the student's own records, so it now
           * sits with the others in "Your records" below, which is what the nav's Records section lists.
           */
          <div className="flex flex-wrap gap-2">
            <Link href="/student/notifications" className="btn btn-secondary">
              Notifications
            </Link>
            {can('assignments.submit') ? (
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
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          No published results yet. Marks are only visible here after the school publishes the exam.
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Your published results"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      {records.length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Your records</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {records.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="surface block p-4 transition-transform duration-200 hover:-translate-y-0.5 hover:border-teal"
                >
                  <span className="font-semibold text-ink">{item.label}</span>
                  <p className="mt-1 text-xs text-muted">{item.description}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        * This footnote used to say that attendance, fees and timetable records were "held by the
        * school office". That was true while their permissions had no route; D17 mounted them and they
        * are linked above. What is still worth saying is that those records are read-only, and who to
        * ask when one is wrong.
        */}
      <p className="mt-4 text-xs text-muted-soft">
        Your records are read-only. If something in them looks wrong, speak to the school office.
      </p>
    </div>
  );
}
