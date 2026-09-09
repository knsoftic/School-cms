'use client';

/**
 * Results — SRS §19.3, §33's "Results", checklist row 4.4.
 *
 * The four moving parts `super-admin/schools/page.tsx` settled: one `useCollection`, one `Column[]`,
 * the four-state render in the order refusal → error → loading → empty → table, and `Pagination`.
 * Only the decisions this screen had to make for itself are written out below.
 *
 * ## The refusal branch is a routine outcome here, not an exotic one
 *
 * `exams.routes.js` mounts `requireModule(MODULES.EXAMS)` on the whole router, above every path in
 * §19, so a school whose plan does not carry Exams is refused with `MODULE_NOT_SUBSCRIBED` before
 * `results.view` is even consulted. `useCollection` classifies that as a *refusal* and `RefusalNotice`
 * already has a sentence for it, so nothing here inspects the entitlement snapshot: the module gate
 * lives on the server, and a client that re-decided it would be a second answer free to disagree with
 * the first — and it would disagree in the direction that shows an error banner with a "Try again"
 * button for a plan that will refuse the retry identically.
 *
 * ## There is deliberately no search box
 *
 * `listResults` is built with `listQuery(...)`, which merges `commonSchemas.search` in, so `?q=` is
 * *accepted* by validation on this endpoint. But `exams.service.listResults()` never reads it: the
 * only keys it copies into the `where` are `exam_id`, `student_id`, `class_id`, `section_id` and
 * `is_published` (`exams.service.js:1312-1330`). A search box wired to `q` would therefore be
 * accepted, silently ignored, and answered with the unfiltered page — the user would read a table
 * they believe is filtered, with nothing anywhere reporting that it is not. That is a worse failure
 * than having no search, so this screen has none, and the exemplar's 300 ms debounce is absent with
 * it. Searching by student name needs a `q` branch in the service before it needs a control here.
 *
 * ## Publication is the one control, out of the five filters that exist
 *
 * `is_published` is the only one of the five that a person can answer from their own head. The other
 * four take a database id — `exam_id`, `student_id`, `class_id`, `section_id` — and a box that wants
 * a bare integer is not a control, it is a lookup the user has to perform by hand. A real picker for
 * any of them needs a second collection fetch (`/exams`, `/classes`), a second permission the holder
 * of `results.view` may not have, and a decision about what to do when the picker's own page of
 * options does not cover every row on this one. That is a screen's worth of work each, and none of it
 * is checklist row 4.4.
 *
 * Publication earns the slot on its own merits regardless: `publishResults` is what makes a result
 * visible to a parent or a student (§19.3, §23), so "which of these has the school actually released"
 * is the question this list is opened to answer between generating and announcing.
 *
 * ## The ordering, and why it is left alone
 *
 * `getSort` falls back to `['position', 'ASC']` for this route, so no `sortBy` is sent — a result
 * sheet reads rank-first, which is the order §19.3 describes. One consequence is worth stating rather
 * than hiding: `position` is NULL for a student who did not sit every paper, MySQL sorts NULLs first
 * in an ASC order, and so the unranked students head the first page. The Position column says
 * "unranked" in words for exactly that reason, and the page description warns of it, because a reader
 * who did not know would take the top of the table for the top of the class.
 *
 * ## What this list cannot say
 *
 * `listResults` includes exactly one association — `student`, with five attributes. It does **not**
 * join `Exam`, `Class` or `Section`, so `exam_id`, `class_id` and `section_id` reach this screen as
 * bare foreign keys and are not rendered: `class_id: 7` tells an administrator nothing, and printing
 * it in a column headed "Class" would dress an internal id as an answer. The cost is real and is not
 * papered over — with no exam column, two rows for the same student from two different exams are
 * indistinguishable here. The fix belongs in `listResults` (an `Exam` include, as it already does for
 * `Student`), not in a per-row fetch from this component.
 */

import { useMemo, useState } from 'react';

import { ApiError, api, saveFile } from '@/lib/apiClient';
import { useCollection } from '@/lib/useCollection';
import { Icon, Spinner } from '@/components/icon';
import { useToast } from '@/components/toast';
import type { Query } from '@/lib/useCollection';
import {
  FilterBar,
  FilterSelect,
} from '@/components/form';
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
 * The `student` include, with the five attributes `listResults` actually selects.
 *
 * **`student.student_id` is not `Result.student_id`.** The row carries both: `Result.student_id` is
 * the numeric foreign key into `students`, while `student.student_id` is the school's own admission
 * number, a `STRING(60)` (`models/people.js:47`). They differ in type and in meaning, they are one
 * dot apart, and rendering the wrong one would put a database id on screen under the heading a
 * registrar reads as the admission number. Hence the separate interface — the shadowing is at least
 * visible when the two shapes are declared side by side.
 */
interface ResultStudent {
  id: number;
  /** The admission number, not a key. `students_school_studentid_unique` makes it unique per school. */
  student_id: string;
  roll_number: string | null;
  first_name: string;
  last_name: string | null;
}

/**
 * One row of `GET /exams/results`.
 *
 * There is no `present()` on this endpoint: `listResults` hands `paginateQuery`'s Sequelize rows
 * straight to `ApiResponse.paginated`, so the wire shape is the `results` table itself. Two columns
 * that arrive because of that are deliberately absent from this interface, so that no cell can reach
 * them by accident:
 *
 *   - **`result_card_path`** — a stored file path. It is null today (the PDF at `GET /results/:id`
 *     is streamed as a Buffer and nothing writes the column), but "currently null" is not why it is
 *     omitted. A stored path is never rendered anywhere in this application, for the reason
 *     `documents.controller.js:6` states about its own: it cannot leak through a response, and a
 *     screen that printed one would hand a reader the shape of the server's filesystem.
 *   - **`subject_breakdown`** — the per-subject JSON snapshot. It is the body of the result *card*
 *     and belongs on the single-result screen, which has room to lay the papers out in rows; a list
 *     cell could only stringify it.
 *
 * The three DECIMAL columns are typed `number`, not `string`: `config/database.js:59` sets mysql2's
 * `decimalNumbers: true`, so DECIMAL crosses the wire as a JS number rather than the string a MySQL
 * driver hands back by default. The formatters below still push their input through `Number()`, which
 * costs nothing on a number and keeps a `NaN` out of a cell if that flag ever changes.
 */
interface ExamResult {
  id: number;
  total_full_marks: number;
  total_marks_obtained: number;
  /** `DECIMAL(6,3)` — three decimal places are stored, two are shown. See `PERCENT`. */
  percentage: number;
  /** Null when no band in the exam's grade scale covers the percentage. */
  grade_name: string | null;
  /** `RESULT_OUTCOME` — `pass` or `fail`; null until the result has been calculated. */
  outcome: 'pass' | 'fail' | null;
  subjects_count: number;
  subjects_failed: number;
  /** Null for a student who did not sit every paper — `generateResults` ranks only complete results. */
  position: number | null;
  position_out_of: number | null;
  is_published: boolean;
  /*
   * Which exam this result is for.
   *
   * `listResults()` accepted an `exam_id` filter and applied it, but included only the student — so
   * a row could not say which exam it came from, and two results for the same student from two
   * different exams were indistinguishable in a list ordered by position. The include now supplies
   * it; optional here because it is a LEFT JOIN and a cell must not throw on a shape the query does
   * not guarantee.
   */
  exam?: { id: number; name: string; exam_type: string | null; start_date: string | null } | null;
  /*
   * Not optional, and the reason is a constraint rather than optimism: the include is a LEFT JOIN,
   * but `results.student_id` is NOT NULL with `ON DELETE CASCADE` (`models/exams.js`), so a result
   * cannot outlive the student it belongs to and the join cannot miss.
   */
  student: ResultStudent;
}

/**
 * Marks, at the precision they were actually entered.
 *
 * `minimumFractionDigits: 0` because marks are whole numbers far more often than not, and a column
 * reading `47.00 / 50.00` spends four characters per row to say nothing. A half mark still shows as
 * `47.5`, which is the case the two decimal places exist for.
 */
const MARKS = new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/**
 * Percentages, at a fixed two places, so the column aligns down the page.
 *
 * The column stores three (`DECIMAL(6,3)`) and this shows two: the third place is an artefact of
 * dividing marks by a total, not a figure anyone reports a child's result to. Fixed rather than
 * trimmed, because `87.5` beside `87.53` in a scanned column reads as a different number of digits
 * rather than a different value.
 */
const PERCENT = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Format a figure, or say plainly that it is not a figure — `NaN` in a cell reads as a UI fault. */
function figure(value: number, format: Intl.NumberFormat): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? format.format(parsed) : '—';
}

/** `last_name` is nullable (`models/people.js:57`), so the join has to tolerate a missing half. */
function fullName(student: ResultStudent): string {
  return [student.first_name, student.last_name].filter(Boolean).join(' ');
}

/**
 * The publication filter.
 *
 * The empty value is "no filter", not "false". `buildUrl` drops an empty string before it reaches the
 * query string (`apiClient.ts`), and `listResults` only copies `is_published` into the `where` when
 * it is `!== undefined` — so an unset control leaves the key off the request entirely, which is what
 * "Any" has to mean. Sending `is_published=false` for "Any" would quietly hide every published
 * result behind a control that claims to hide nothing.
 *
 * The values are the *strings* `'true'` and `'false'`: `Query` carries no boolean, `buildUrl` would
 * stringify one anyway, and the schema is a `Joi.boolean()` under `convert: true`, which is precisely
 * the case that accepts them.
 */
const PUBLICATION_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Any publication state' },
  { value: 'true', label: 'Published — visible to students and parents' },
  { value: 'false', label: 'Not published' },
];


export default function ResultsPage() {
  const { error: errorToast } = useToast();

  const [page, setPage] = useState(1);
  const [published, setPublished] = useState('');

  const query = useMemo<Query>(
    () => ({ page, limit: 20, is_published: published || undefined }),
    [page, published]
  );

  /** The result whose card is being fetched, so only that button spins. */
  const [downloading, setDownloading] = useState<number | null>(null);

  /*
   * The result card, which `exams.controller.js` `showResult()` has streamed as a PDF since Phase
   * 5.4 and which nothing in the frontend requested. `GET /exams/results/:id?format=pdf` needs
   * `results.view` — the same key that opened this screen — so no separate gate is needed.
   *
   * A plain `<a href>` cannot reach it: `readBearerToken` reads the `Authorization` header only, so
   * an unadorned navigation is a 401.
   */
  async function downloadCard(row: ExamResult) {
    setDownloading(row.id);
    try {
      const file = await api.download(
        `/exams/results/${row.id}`,
        { query: { format: 'pdf' } },
        `result-card-${row.id}.pdf`
      );
      saveFile(file);
    } catch (caught) {
      errorToast(
        'Could not produce that result card',
        caught instanceof ApiError ? caught.message : undefined
      );
    } finally {
      setDownloading(null);
    }
  }

  const { rows, meta, loading, error, refusal, reload } = useCollection<ExamResult>(
    '/exams/results',
    query
  );

  const columns = useMemo<Column<ExamResult>[]>(() => {
    const base: Column<ExamResult>[] = [
      {
        key: 'student',
        header: 'Student',
        /*
         * Three fields in one cell rather than three columns, because they are one fact — *who* —
         * and a table already carrying marks, a percentage, a grade, an outcome and a rank cannot
         * afford two more columns of identity. The roll number leads the sub-line: it is what a
         * class teacher calls a student by, and it is what the result sheet this table replaces was
         * ordered on. It is nullable, so the admission number stands alone when it is absent —
         * `student_id` is NOT NULL and unique per school, which makes it the identifier that is
         * always there to disambiguate two children with the same name.
         */
        cell: (row) => (
          <div className="min-w-0">
            <span className="font-medium">{fullName(row.student)}</span>
            <span className="mt-0.5 block text-xs text-muted-soft">
              {row.student.roll_number ? `Roll ${row.student.roll_number} · ` : ''}
              {row.student.student_id}
            </span>
          </div>
        ),
      },
      {
        key: 'exam',
        header: 'Exam',
        /* Named, because a results table without it is a list of numbers about nobody in particular. */
        cell: (row) =>
          row.exam ? (
            <div className="min-w-0">
              <span className="font-medium">{row.exam.name}</span>
              {row.exam.exam_type ? (
                <span className="mt-0.5 block text-xs text-muted-soft">{row.exam.exam_type}</span>
              ) : null}
            </div>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
      {
        key: 'marks',
        header: 'Marks',
        numeric: true,
        /*
         * Obtained and total together, because neither means anything alone: 47 is excellent out of
         * 50 and a failure out of 100, and §19.2 calculates the percentage from exactly this pair.
         * The total is dimmed so the eye lands on the figure that varies between rows.
         */
        cell: (row) => (
          <span className="whitespace-nowrap">
            {figure(row.total_marks_obtained, MARKS)}
            <span className="text-muted-soft"> / {figure(row.total_full_marks, MARKS)}</span>
          </span>
        ),
      },
      {
        key: 'percentage',
        header: 'Percentage',
        numeric: true,
        cell: (row) => `${figure(row.percentage, PERCENT)}%`,
      },
      {
        key: 'grade_name',
        header: 'Grade',
        /*
         * The band's name as `generateResults` resolved it against the exam's scale, not a letter
         * derived here from the percentage. Re-deriving it in the browser would be a second
         * implementation of §19.1's grade table, free to disagree with the stored one the moment a
         * school edits a band — and the stored value is the one printed on the result card.
         */
        cell: (row) => row.grade_name ?? <span className="text-muted-soft">—</span>,
      },
      {
        key: 'outcome',
        header: 'Outcome',
        /*
         * `subjects_failed` rides in this cell rather than taking a column of its own, because it is
         * the reason for the verdict beside it rather than an independent figure: "fail" answers
         * what, "2 of 6 papers below pass" answers why, and an administrator deciding who needs a
         * re-sit reads them together. Shown for a pass as well — `0 of 6` is the confirmation that
         * the count was computed rather than missing.
         *
         * Null is the ungenerated case: `outcome` is nullable and `generateResults` is what fills it,
         * so a row can exist before §19.2's calculation has run. "not calculated" says that, where an
         * em dash would read as "no outcome", which is a different and worse claim about a child.
         */
        cell: (row) => (
          <span className="flex items-baseline gap-2 whitespace-nowrap">
            {row.outcome ? (
              <StatusBadge status={row.outcome} />
            ) : (
              <span className="text-muted-soft">not calculated</span>
            )}
            {row.subjects_count > 0 ? (
              <span className="text-xs text-muted-soft">
                {row.subjects_failed} of {row.subjects_count} below pass
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: 'position',
        header: 'Position',
        numeric: true,
        /*
         * §19.3's "Position within the class/section", and the column the default ordering is on.
         * The null case is the one that needs words: it does not mean last, it means the student did
         * not sit every paper, so `generateResults` left them out of the ranking rather than ranking
         * them against an incomplete total. "unranked" says that; a dash would let a reader supply
         * their own, worse, explanation.
         */
        cell: (row) =>
          row.position === null ? (
            <span className="text-muted-soft">unranked</span>
          ) : (
            <span className="whitespace-nowrap">
              {row.position}
              {row.position_out_of === null ? null : (
                <span className="text-muted-soft"> of {row.position_out_of}</span>
              )}
            </span>
          ),
      },
      {
        key: 'is_published',
        header: 'Publication',
        /*
         * The boolean is turned into a word before it is shown. `is_published` is the line between a
         * result the school is still checking and one a parent can already read (§19.3, §23), and a
         * tick or a blank cell states that far too quietly for a column that decides whether a
         * mistake is still private.
         */
        cell: (row) => <StatusBadge status={row.is_published ? 'published' : 'unpublished'} />,
      },
    ];

    /*
     * The card itself. This screen listed finished results and offered no way to open one — the
     * finding's words were that "nothing in the entire frontend can publish a result, generate one,
     * or open a result card". Publishing and generating now live on the Exams screen, where the exam
     * is; opening the card belongs here, where the result is.
     */
    return [
      ...base,
      {
        key: 'card',
        header: 'Card',
        cell: (row) => (
          <button
            type="button"
            onClick={() => void downloadCard(row)}
            disabled={downloading === row.id}
            aria-busy={downloading === row.id}
            className="btn btn-ghost btn-sm"
          >
            {downloading === row.id ? <Spinner size={13} /> : <Icon name="download" size={14} />}
            {downloading === row.id ? 'Preparing…' : 'PDF'}
          </button>
        ),
      },
    ];
  }, [downloading]);

  return (
    <div>
      {/*
        * No action button: §33 gives Results no create route, and there is nothing to create — a
        * result is calculated by `POST /exams/:id/results` from marks that already exist, from the
        * exam's own screen where the exam is known. A "New result" button here would offer a form
        * that could not be filled in.
        */}
      <PageHeader
        title="Results"
        description="Calculated results across every exam, ordered by class position. Students who missed a paper are unranked and sort to the top."
      />

      <FilterBar
        activeCount={[published].filter(Boolean).length}
        onClear={() => {
          setPublished('');
          setPage(1);
        }}
      >
        <FilterSelect
          id="results-published"
          label="Filter by publication state"
          value={published}
          onChange={(value) => {
            setPublished(value);
            /*
             * Part of changing the filter, not a separate concern. Narrowing from page four and
             * staying there shows an empty table for a filter that has two pages of results, and the
             * reader blames the filter rather than the page they never left.
             */
            setPage(1);
          }}
        >
          {PUBLICATION_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </FilterSelect>
      </FilterBar>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {/*
            * The filtered empty state names the filter, because "no results" under an active filter
            * is ambiguous between "this school has none" and "none match" — and the remedy for the
            * two is opposite: generate some, or widen the filter.
            */}
          {published === 'true'
            ? 'No results have been published yet. Results become visible to students and parents once an exam is published.'
            : published === 'false'
              ? 'Every calculated result has been published.'
              : 'No results have been calculated yet. Results appear once an exam’s marks are submitted and its results are generated.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Exam results"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
