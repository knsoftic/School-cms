'use client';

/**
 * A parent's view of their children's results — SRS §19.3, FR-EXAM-005 (whose actors include
 * Parent), and FR-PARENT-001's "Parent can access records for all linked children".
 *
 * ## The endpoint already served parents; no parent screen called it
 *
 * `GET /exams/my-results` requires `results.self.view`, which the `parent` block in `permissions.js`
 * grants. `exams.service.js myResults()` resolves the parent from their own account and confines the
 * query through `parent_students` to their linked children — and to **published** rows only, the
 * rule the student portal states. So nothing here filters for safety: the server already has.
 *
 * ## One child at a time, decided by the server
 *
 * `student_id` narrows the list to one child, and the service refuses a child who is not linked with
 * `STUDENT_NOT_LINKED`, an explained code, so it reads as a refusal rather than a fault. The picker is
 * fed from `GET /parents/dashboard`, so it only offers children the school has linked, and it appears
 * only when there are two or more to choose between. If that list cannot be read the results still
 * load, because each row names its own child.
 *
 * ## No result card download
 *
 * The card is `GET /exams/results/:id`, which requires `results.view`, a staff key the parent block
 * does not hold. So this screen offers no download rather than a button that would be refused.
 */

import { useMemo, useState } from 'react';

import { useCollection } from '@/lib/useCollection';
import { FilterBar, FilterSelect } from '@/components/form';
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

import { childName, useParentDashboard } from '../children';

/**
 * One row of `GET /exams/my-results` — the `results` table, sent unmapped by the controller.
 *
 * Typed as the student portal types the same rows (`student/page.tsx`): the three DECIMALs and both
 * counters are NOT NULL with a default of 0 and arrive as numbers (`decimalNumbers: true`), while
 * `grade_name` and `outcome` really are nullable. `student` is what makes this the parent's version:
 * `myResults()` includes it with `['id', 'student_id', 'roll_number', 'first_name', 'last_name']`,
 * so every row can say whose result it is.
 */
interface ChildResult {
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
  student?: { id: number; first_name: string; last_name: string | null; student_id: string | null };
  exam?: { id: number; name: string; exam_type: string | null; start_date: string | null };
}

/**
 * A DECIMAL, for display only — the student portal's formatter, for the same columns.
 *
 * As many decimals as the value carries, up to two, so a half-mark is never rounded into a mark the
 * child was not given; `percentage` asks for exactly two. See `student/page.tsx` for the defect that
 * rule came from.
 */
function figure(value: number, digits?: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (digits !== undefined) return parsed.toFixed(digits);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(parsed);
}

export default function ParentResults() {
  const [page, setPage] = useState(1);
  /* A child's `students.id` as the select holds it; '' is every linked child. */
  const [child, setChild] = useState('');

  const { data: dashboard } = useParentDashboard();
  const children = useMemo(
    () => (dashboard?.children ?? []).flatMap((link) => (link.student ? [link.student] : [])),
    [dashboard]
  );

  const query = useMemo(() => ({ page, limit: 20, student_id: child || undefined }), [page, child]);
  const { rows, meta, loading, error, refusal, reload } = useCollection<ChildResult>('/exams/my-results', query);

  /*
   * The Child column is dropped only when the dashboard says there is exactly one child — a column
   * repeating one name on every row is noise. When the list could not be read it stays, because then
   * nothing else on the screen says whose result a row is.
   */
  const showChild = children.length !== 1;

  const columns = useMemo<Column<ChildResult>[]>(
    () => [
      {
        key: 'exam',
        header: 'Exam',
        /* The card heading below `md`: one card per result, and the exam is what a result is of. */
        primary: true,
        cell: (row) => (
          <>
            <span className="font-medium">{row.exam?.name ?? `exam #${row.exam_id}`}</span>
            {row.exam?.exam_type ? (
              <span className="block text-xs text-muted-soft">{row.exam.exam_type.replace(/_/g, ' ')}</span>
            ) : null}
          </>
        ),
      },
      ...(showChild
        ? [
            {
              key: 'child',
              header: 'Child',
              cell: (row: ChildResult) =>
                row.student ? childName(row.student) : <span className="text-muted-soft">student #{row.student_id}</span>,
            } as Column<ChildResult>,
          ]
        : []),
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
        cell: (row) => (row.outcome ? <StatusBadge status={row.outcome} /> : <span className="text-muted-soft">—</span>),
      },
      {
        key: 'failed',
        header: 'Subjects failed',
        numeric: true,
        /* Shown even when zero, as on the student portal: a blank would not say "none". */
        cell: (row) => (
          <span className={row.subjects_failed > 0 ? 'font-medium' : 'text-muted-soft'}>
            {row.subjects_failed}
            {row.subjects_count ? <span className="text-muted-soft"> of {row.subjects_count}</span> : null}
          </span>
        ),
      },
    ],
    [showChild]
  );

  const chosen = children.find((student) => String(student.id) === child);

  return (
    <div>
      <PageHeader
        title="Results"
        description="Your children’s exam results, once the school publishes them."
      />

      {children.length > 1 ? (
        <FilterBar
          activeCount={child ? 1 : 0}
          onClear={() => {
            setChild('');
            setPage(1);
          }}
        >
          <div>
            <FilterSelect
              id="results-child"
              label="Filter by child"
              value={child}
              onChange={(value) => {
                setChild(value);
                /* Page three of every child's results is rarely page three of one child's. */
                setPage(1);
              }}
            >
              <option value="">All children</option>
              {children.map((student) => (
                <option key={student.id} value={String(student.id)}>
                  {childName(student)}
                </option>
              ))}
            </FilterSelect>
          </div>
        </FilterBar>
      ) : null}

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {/*
            * Three different empties. No linked child is a state only the school office can change,
            * and "not published yet" is the usual meaning of an empty list here — `myResults()` pins
            * `is_published: true`, so a sat but unreleased exam is invisible by design.
            */}
          {dashboard && dashboard.children.length === 0
            ? 'No children are linked to your account yet. The school office links a parent to a student.'
            : chosen
              ? `No published results for ${childName(chosen)} yet. Marks appear here after the school publishes the exam.`
              : 'No published results yet. Marks appear here after the school publishes the exam.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Your children’s published results"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
