'use client';

/**
 * Exams — SRS §19 (§19.1 "the examination"), §33's "Exams", checklist row 4.4.
 *
 * The same four moving parts as the `schools` exemplar — a `useCollection` call, a `Column[]`, the
 * four-state render, and `Pagination` — over `GET /exams`, which `exams.routes.js` guards with
 * `requirePermission('exams.view')` behind a router-level `requireModule(MODULES.EXAMS)`.
 *
 * ## The module gate is why the refusal branch comes first, and it is not theoretical here
 *
 * Every platform screen can be refused for a missing permission. This one can additionally be
 * refused because the school's plan does not include §19 at all — the router's `requireModule()`
 * answers 403 `MODULE_NOT_SUBSCRIBED` before any handler runs. `useCollection` classifies that as a
 * `refusal` rather than an `error`, and `RefusalNotice` has a sentence for it, so the branch order
 * below is load-bearing: checking `error` first would offer a "Try again" button to a school whose
 * subscription cannot be changed by retrying. The module is never checked in this file — the API is
 * the authority on entitlement (§30 Rule 1), and a second copy of that judgement here could disagree
 * with it.
 *
 * ## No `school_id` is sent, deliberately
 *
 * `listExams` starts from `tenantWhere(req.tenant, {})`, and `resolveTenant.js` confines every
 * non-platform role to one `school_id` taken from the session — never from the request. A school
 * user sending `school_id` could therefore only ever restate what the server already decided, and a
 * screen that appeared to choose its own school would misrepresent where the boundary is.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { useRowAction } from '@/lib/useRowAction';
import { ConfirmDialog } from '@/components/overlay';
import {
  SearchField,
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
 * One row of `GET /exams`.
 *
 * There is no `present()` anywhere in `exams.controller.js` — `listExams` hands the Sequelize rows
 * straight to `ApiResponse.paginated`, so the shape is `models/exams.js`'s `Exam` columns plus
 * whatever the service `include`s. That is exactly one association: `db.Class as 'class'`, with
 * `attributes: ['id', 'name']` (`exams.service.js:386`). Nothing else is joined, which is the single
 * most important fact for the column list below.
 *
 * Only the fields this screen renders are declared. The row carries more — `organization_id`,
 * `created_by`, `announced_at`, `description` — and typing them would invite a later edit to put one
 * on screen without re-reading why it was left off.
 */
interface Exam {
  id: number;
  name: string;
  exam_type: string;
  /**
   * The joined class. Typed nullable even though `class_id` is a NOT NULL foreign key: the service
   * uses a plain `include` (a LEFT JOIN, not `required: true`), so a missing row would arrive as
   * `null` rather than dropping the exam from the page, and a cell that assumed otherwise would
   * throw and take the whole table down with it.
   */
  class: { id: number; name: string } | null;
  /**
   * Present as a raw id and **nothing else** — the service joins no `Section`. It is read here only
   * for its null/non-null distinction, which the model documents as meaningful ("Null = all sections
   * of the class sit the exam"); the number itself is never rendered, because `section_id: 7` tells
   * an administrator nothing they can act on.
   */
  section_id: number | null;
  start_date: string | null;
  end_date: string | null;
  grade_scale: string;
  status: string;
  published_at: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A `DATEONLY` — `start_date`, `end_date` — read as characters, never through `Date`.
 *
 * `new Date('2026-02-01')` is parsed as UTC midnight, so `toLocaleDateString()` west of Greenwich
 * renders the 31st of January. An exam period is a calendar range with no instant behind it, and
 * giving it one moves the day a paper is sat. Splitting the string the API sent cannot shift it, and
 * it also sidesteps the hydration hazard the `subscriptions` screen documents: this is a client
 * component that Next.js renders on the server first, and any locale-sensitive formatter produces
 * different characters in the two places.
 *
 * A value that is not the expected shape is returned untouched rather than guessed at — showing what
 * the server actually sent is more useful than an `Invalid Date` that reads as a UI fault.
 */
function formatDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return value;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

/**
 * A full timestamp — `published_at` is a `DATE`, not a `DATEONLY` — rendered in UTC.
 *
 * Same hydration reasoning as above: reading the UTC parts explicitly produces identical characters
 * on the server and in the browser. The clock time is dropped because the only question this column
 * answers is *which day results went out*, and an hour in the viewer's zone would be a fourth
 * timezone to reason about for no gain.
 */
function formatStamp(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * The status filter's options — every member of `EXAM_STATUS` (`config/constants.js:491`), which is
 * precisely what `listExams`'s schema accepts: `Joi.string().valid(...Object.values(EXAM_STATUS))`.
 *
 * Three of them have no writer in `exams.service.js`. Grepping every `EXAM_STATUS.` assignment there
 * finds four: the model default `draft`, `marks_entry` when the first marks are entered, `completed`
 * on result generation and `published` on publication. `scheduled` and `ongoing` are only ever
 * *read* (`:784`), and `cancelled` is the gap `exams.routes.js` records outright — §19 describes
 * creating, marking, calculating and publishing an exam, never cancelling one.
 *
 * They are offered anyway, and the asymmetry of the two mistakes is the reason. A filter that
 * returns nothing costs the user one click and tells them something true — there are no exams in
 * that state. A filter list narrower than the column's own enum makes any row holding one of those
 * values unreachable, with no hint that it exists; and this screen renders the badge for all seven
 * regardless, so it can already show a status its own filter could not find.
 */
const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'marks_entry', label: 'Marks entry' },
  { value: 'completed', label: 'Completed — results generated' },
  { value: 'published', label: 'Published' },
  { value: 'cancelled', label: 'Cancelled' },
];


export default function ExamsPage() {
  const { can } = useAuth();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      /*
       * Resetting to page one is part of the search, not a separate concern — searching from page
       * three and staying there shows an empty table for a query that has two pages of results.
       */
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  /*
   * Only parameters `listExams` declares are sent. `validate()` runs the query container with
   * `stripUnknown: true`, so an invented key is deleted in silence rather than refused — the request
   * would answer 200 having ignored the filter, which is indistinguishable from the filter working.
   *
   * The schema offers `class_id`, `section_id`, `academic_session_id` and `exam_type` as well, and
   * none of them gets a control here. The first three take a bare id, and a box asking an
   * administrator to type "7" is worse than no filter at all; they need a picker fed by their own
   * `/classes` and `/academic-sessions` collections, which is a different screen's worth of work.
   * `exam_type` is free text with no enumeration anywhere (the column comment says the source names
   * the field but no closed value list), and `q` already LIKEs it alongside `name`
   * (`exams.service.js:375-380`) — a second text box searching a subset of what the first one
   * searches is a way to get two contradictory-looking answers to the same question.
   *
   * `sortBy`/`sortOrder` are likewise unsent. The service defaults to `['start_date', 'DESC']`, so
   * the most recent exam period is already first, which is the order this list is scanned in.
   */
  const query = useMemo(
    () => ({ page, limit: 20, q: debounced || undefined, status: status || undefined }),
    [page, debounced, status]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<Exam>('/exams', query);

  /*
   * `results.generate` guards **both** routes — `POST /exams/:id/results` and
   * `POST /exams/:id/publish` — so one key decides whether this column exists at all.
   */
  const canGenerate = can('results.generate');

  /*
   * Two separate actions, deliberately, because they are two separate decisions.
   *
   * Generating calculates totals, percentages, grades and class positions from the marks that have
   * been entered. Publishing is the disclosure: `list()` forces `is_published: true` for a student
   * or parent caller, so until this runs a finished result is staff-only. Folding them into one
   * button would mean a school could not check a result before a parent could read it — and §19.3
   * separates them for exactly that reason.
   */
  const generate = useRowAction<Exam>({
    perform: (row) => api.post(`/exams/${row.id}/results`, {}),
    success: (row) => `Results calculated for ${row.name}`,
    failure: 'Could not calculate those results',
    onDone: reload,
  });

  const publish = useRowAction<Exam>({
    perform: (row) => api.post(`/exams/${row.id}/publish`, {}),
    success: (row) => `${row.name} results published`,
    failure: 'Could not publish those results',
    onDone: reload,
  });

  const columns = useMemo<Column<Exam>[]>(() => {
    const base: Column<Exam>[] = [
      {
        key: 'name',
        header: 'Exam',
        /*
         * The way into the exam's own screen, where its papers are configured and its marks are
         * entered. The name is the link rather than a trailing "View" column, for the reason the
         * Students list gives: a row whose most identifying cell is not clickable teaches people to
         * hunt for an action column.
         */
        cell: (row) => (
          <Link
            href={`/school/exams/${row.id}`}
            className="font-medium underline-offset-2 hover:underline focus-visible:underline"
          >
            {row.name}
          </Link>
        ),
      },
      {
        key: 'exam_type',
        header: 'Type',
        /*
         * Kept as its own column rather than folded under the name. A school runs "Midterm" and
         * "Final" for many classes in a session, and the type is what separates two rows whose names
         * are otherwise near-identical.
         */
        cell: (row) => row.exam_type,
      },
      {
        key: 'class',
        header: 'Class',
        cell: (row) => (
          <span className="whitespace-nowrap">
            {/*
              * The joined name, never `class_id`. This is the one association the service provides,
              * and it is the difference between a column an administrator can read and a number
              * they would have to look up elsewhere.
              */}
            {row.class ? row.class.name : <span className="text-muted-soft">—</span>}
            {/*
              * The section is a bare foreign key with no join, so the *name* is unavailable — but
              * whether the field is set is itself the fact the model documents, and it changes who
              * is expected to sit the paper. Saying "one section" rather than printing an id is the
              * honest version: it reports what is known and does not dress a number up as an
              * answer. Which section it is has to come from the exam's own detail screen.
              */}
            <span className="ml-2 text-xs text-muted-soft">
              {row.section_id === null ? 'all sections' : 'one section'}
            </span>
          </span>
        ),
      },
      {
        key: 'dates',
        header: 'Dates',
        /*
         * Start and end in one cell because they are read as one fact — the window the exam occupies.
         * Two columns would double the horizontal budget of a table that already has to scroll on a
         * phone, to show a pair of dates that are nearly always within a fortnight of each other.
         *
         * Both are nullable on the model, and all three combinations are rendered rather than
         * collapsing a half-scheduled exam into a blank: a draft with a start and no end is a real
         * and common state, and showing nothing for it would hide the date that has been decided.
         */
        cell: (row) => {
          if (!row.start_date && !row.end_date) return <span className="text-muted-soft">not scheduled</span>;
          if (row.start_date && row.end_date) {
            return (
              <span className="whitespace-nowrap">
                {formatDay(row.start_date)} – {formatDay(row.end_date)}
              </span>
            );
          }
          const only = row.start_date ?? row.end_date;
          return (
            <span className="whitespace-nowrap">
              {row.start_date ? 'from ' : 'until '}
              {formatDay(only as string)}
            </span>
          );
        },
      },
      {
        key: 'grade_scale',
        header: 'Grade scale',
        /*
         * A `STRING(90)` matching `grades.scale_name`, **not** a foreign key — the service header
         * calls this out, and it is why the scale is worth a column. Nothing in the database stops
         * an exam naming a scale with no bands, and an exam graded against one calculates every
         * percentage and then matches no grade at all. The create/update path checks it, so a scale
         * reaching this screen had active bands when it was set; seeing which scale each exam uses
         * is how an administrator notices the row that is about to produce a blank grade column.
         */
        cell: (row) => row.grade_scale,
      },
      {
        key: 'status',
        header: 'Status',
        /*
         * `StatusBadge`, not local markup. All seven of `EXAM_STATUS`'s values are toned: `draft`
         * and `cancelled` as ended, `scheduled`, `ongoing` and `marks_entry` as in-progress, and
         * `completed` and `published` as done.
         *
         * The claim here was previously that the four working states were left neutral — true when
         * written, and made false by widening the map in session 26. The word is always rendered
         * beside the colour regardless, so the badge never depends on colour alone.
         */
        cell: (row) => <StatusBadge status={row.status} />,
      },
      {
        key: 'published_at',
        header: 'Results published',
        /*
         * Not redundant with the badge, and cannot contradict it: `publishResults` writes
         * `status: 'published'` and `published_at` in the same transaction
         * (`exams.service.js:1299`), so the badge answers *whether* and this column answers *when*.
         * "When" is the question a principal fielding a parent's call is actually asking.
         */
        cell: (row) => {
          if (!row.published_at) return <span className="text-muted-soft">—</span>;
          const formatted = formatStamp(row.published_at);
          return formatted ? <span className="whitespace-nowrap">{formatted}</span> : <span className="text-muted-soft">—</span>;
        },
      },
    ];

    /*
     * The two controls this screen was named for and did not have.
     *
     * Nothing in the frontend called either route. A principal could filter the Results screen to
     * "Not published", see finished results, and have no way to publish them — and its empty state
     * told them to generate results the product could not generate. Both routes existed and were
     * seeded to `results.generate`.
     *
     * Publish is offered only once, and reads as done afterwards: `publishResults` sets
     * `published_at` in the same transaction, so a second press has nothing to do.
     */
    if (!canGenerate) return base;

    return [
      ...base,
      {
        key: 'actions',
        header: 'Results',
        cell: (row) => (
          <span className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => generate.ask(row)}
              className="btn btn-ghost btn-sm"
            >
              Calculate
            </button>
            {row.published_at ? (
              <span className="inline-flex items-center px-2 text-xs text-muted-soft">
                Published
              </span>
            ) : (
              <button
                type="button"
                onClick={() => publish.ask(row)}
                className="btn btn-ghost btn-sm"
              >
                Publish
              </button>
            )}
          </span>
        ),
      },
    ];
  }, [canGenerate, generate, publish]);

  return (
    <div>
      <PageHeader
        title="Exams"
        description="Examinations scheduled for this school, newest first."
        action={
          /*
           * Hidden without `exams.manage`, which `permissions.js:118` defines and the routes table
           * requires for `POST /exams`. This is a courtesy, not a control: the permission is re-read
           * from the database on the request itself, so forcing this button into existence would
           * still meet a 403 from `requirePermission`.
           */
          <div className="flex gap-2">
            {/*
              * Grade scales are school-wide rather than per exam — `exams.grade_scale` is a name
              * pointing at a set of bands several exams share — so the screen is reached from here
              * rather than being a tab on one exam. Gated on the same key as its two routes.
              */}
            {can('exams.manage') ? (
              <Link href="/school/exams/grade-scales" className="btn btn-secondary">
                Grade scales
              </Link>
            ) : null}
            {can('exams.manage') ? (
              <Link
                href="/school/exams/new"
                className="btn btn-primary"
              >
                Add exam
              </Link>
            ) : null}
          </div>
        }
      />

      <FilterBar
        activeCount={[search, status].filter(Boolean).length}
        onClear={() => {
          setSearch('');
          setStatus('');
          setPage(1);
        }}
      >
        {/*
          * The placeholder names both fields the server searches. `q` is LIKEd against `name` OR
          * `exam_type`, and a box labelled only "search by name" would make the type matches look
          * like a bug.
          */}
        <SearchField
          id="exam-search"
          label="Search exams"
          placeholder="Search by name or type…"
          value={search}
          onChange={setSearch}
        />

        <FilterSelect
          id="exam-status"
          label="Filter by status"
          value={status}
          onChange={(value) => {
            setStatus(value);
            /* Same reason as the search: page three of the old filter is rarely page three of the new. */
            setPage(1);
          }}
        >
          {STATUS_FILTERS.map((option) => (
            <option key={option.value || 'all'} value={option.value}>
              {option.label}
            </option>
          ))}
        </FilterSelect>
      </FilterBar>

      {/*
        * Refusal before error, error before loading. A school whose plan excludes §19 gets the
        * explanation `RefusalNotice` holds for `MODULE_NOT_SUBSCRIBED`; only a genuine fault reaches
        * the branch with a retry button.
        */}
      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {/*
            * The empty message names the filters that are on. "No exams yet" under an active status
            * filter is a lie that sends an administrator looking for missing data instead of at the
            * control that hid it.
            */}
          {debounced || status
            ? 'No exam matches these filters.'
            : 'No exams have been created for this school yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Exams"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      {/*
        * Calculating is confirmed rather than immediate because it **recalculates**: an exam whose
        * results already exist has them replaced from whatever marks are entered now, which is the
        * right behaviour after a correction and the wrong surprise if the button was a mis-click.
        */}
      <ConfirmDialog
        open={generate.target !== null}
        onCancel={generate.cancel}
        onConfirm={() => generate.confirm()}
        tone="default"
        title="Calculate results for this exam?"
        description={
          generate.conflict ??
          `Totals, percentages, grades and class positions for ${
            generate.target?.name ?? 'this exam'
          } will be worked out from the marks entered so far. Running it again replaces the previous calculation. Students and parents see nothing until the results are published.`
        }
        confirmLabel="Calculate"
      />

      {/*
        * Publishing is the disclosure step, and the copy says who gains access — that is the fact a
        * principal is deciding about, not the database write.
        */}
      <ConfirmDialog
        open={publish.target !== null}
        onCancel={publish.cancel}
        onConfirm={() => publish.confirm()}
        title="Publish these results?"
        description={
          publish.conflict ??
          `Every student who sat ${
            publish.target?.name ?? 'this exam'
          } and their parents will be able to see their own result card from that moment. Check the results are right first — this is what makes them visible outside the school office.`
        }
        confirmLabel="Publish results"
      />
    </div>
  );
}
