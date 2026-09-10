'use client';

/**
 * Student portal — SRS §5, checklist row 4.7.
 *
 * ## The smallest surface in the product, and every reason for that is external
 *
 * §5 gives the Student one sentence: they are the "subject of admission, class/section assignment,
 * attendance, fee, examination, result, timetable, homework, assignment, and library records" and
 * have "access relevant to their own records within their school."
 *
 * That reads like a large portal. It is not one, because of three facts that are all recorded
 * elsewhere rather than decided here:
 *
 *   1. **§33's MVP list names no student screen.** It enumerates sixteen Super Admin screens and
 *      seventeen School screens. There is no student section.
 *   2. **Four self-service permissions exist with no route behind them.** `students.self.view`,
 *      `attendance.self.view` and `fees.self.view` are in §29's fixed 109-key catalogue and are
 *      mounted nowhere — `attendance.routes.js:27` and `fees.routes.js:28` each record the reason in
 *      their own header: the SRS section describes no self-service view, so the permission was left
 *      unmounted rather than given an endpoint nobody asked for.
 *   3. **`results.self.view` is the one that *is* mounted**, on `GET /exams/my-results`, because
 *      §19.3 does describe a student seeing their result.
 *
 * So this screen shows published results, and says plainly what it does not show. Building the rest
 * would mean inventing four endpoints and the requirements to justify them.
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

export default function StudentPortal() {
  const { profile, can } = useAuth();
  const [page, setPage] = useState(1);

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
           */
          <div className="flex gap-2">
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

      {/*
        * Stated once rather than left as an absence to infer. A student looking for their attendance
        * or fees should find out here that this account does not carry them, instead of concluding
        * the page is broken.
        */}
      <p className="mt-4 text-xs text-muted-soft">
        This account shows published exam results. Attendance, fees and timetable records are held by
        the school office.
      </p>
    </div>
  );
}
