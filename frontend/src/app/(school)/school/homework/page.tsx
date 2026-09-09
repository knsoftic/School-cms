'use client';

/**
 * Homework — SRS §20.2 (FR-HW-001), §33's "Homework", checklist row 4.4.
 *
 * The same four moving parts as the `schools` exemplar — a `useCollection` call, a `Column[]`, the
 * four-state render, and `Pagination` — over `GET /homework`, which `homework.routes.js` guards with
 * `requirePermission('homework.view')` behind a router-level `requireModule(MODULES.HOMEWORK)`.
 *
 * ## The refusal branch is first because this screen has two ways to be refused
 *
 * A permission refusal is possible on every screen. This one can additionally be refused because the
 * school's plan does not include §20 at all: `router.use(requireModule(MODULES.HOMEWORK))` answers
 * 403 `MODULE_NOT_SUBSCRIBED` before any handler runs. `useCollection` classifies that as a
 * `refusal` rather than an `error`, and `RefusalNotice` carries a sentence for it. The branch order
 * below is therefore load-bearing — checking `error` first would put a "Try again" button in front
 * of a school whose subscription no amount of retrying will change.
 *
 * The module is never checked in this file. The API is the authority on entitlement (§30 Rule 1),
 * and a second copy of that judgement in the browser is a copy that can disagree with it.
 *
 * ## No `school_id` is sent, deliberately
 *
 * `list()` starts from `tenantWhere(req.tenant, {})`, and `resolveTenant.js` confines every
 * non-platform role to one `school_id` taken from the session rather than the request. A school user
 * sending `school_id` could only ever restate what the server had already decided, and a control
 * that appeared to choose a school would misrepresent where the tenant boundary actually is.
 *
 * ## No stored path reaches this screen, and none could
 *
 * `homework.service.js`'s `present()` deletes `attachment_path` and substitutes
 * `has_attachment: Boolean(row.attachment_path)`. The column below renders that boolean. The bytes
 * live behind `GET /homework/:id/attachment`, which is a separate authenticated request — see the
 * attachment column for why the cell is an indicator rather than a link.
 */

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import {
  SearchField,
  FilterBar,
  FilterSelect,
  FilterDate,
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
 * One row of `GET /homework`, as `homework.service.js`'s `present()` builds it.
 *
 * `present()` is `{ ...row.toJSON(), has_attachment }` with `attachment_path` deleted — so the shape
 * is every `Homework` column in `models/other.js` except that one, plus the boolean, plus whatever
 * `list()` chose to `include`. That include list is the single most important fact for the columns
 * below, and it is shorter than the associations suggest: `models/index.js:466-470` declares five
 * (`class`, `section`, `subject`, `teacher`, `academicSession`), but the list query joins exactly
 * **two** — `Class as 'class'` with `['id','name']` and `Subject as 'subject'` with
 * `['id','name','code']`. `section`, `teacher` and `academicSession` arrive as bare foreign keys.
 *
 * Only the fields this screen renders are declared. The row carries more — `description`,
 * `attachment_name`, `notified_at`, `created_by`, `organization_id`, `academic_session_id` — and
 * typing them here would invite a later edit to put one on screen without re-reading why it was
 * left off.
 */
interface Homework {
  id: number;
  title: string;
  /**
   * The joined class. Typed nullable even though `class_id` is a NOT NULL foreign key: `list()` uses
   * a plain `include` (a LEFT JOIN, not `required: true`), so an unresolvable class would arrive as
   * `null` rather than dropping the homework from the page — and a cell that assumed otherwise would
   * throw and take the whole table down with it.
   */
  class: { id: number; name: string } | null;
  /**
   * Present as a raw id and **nothing else** — `list()` does not join `Section`. It is read here
   * only for its null/non-null distinction, which is meaningful on this model: the section is
   * optional (`allowNull: true`), and homework with none is set for the whole class. The number
   * itself is never rendered, because `section_id: 7` tells an administrator nothing they can act
   * on.
   */
  section_id: number | null;
  /** Nullable twice over: `subject_id` is `allowNull: true` and its FK is `onDelete: 'SET NULL'`. */
  subject: { id: number; name: string; code: string | null } | null;
  /** `DATEONLY`, NOT NULL — defaulted to today by the service when a teacher does not name one. */
  assigned_date: string;
  /** `DATEONLY`, NOT NULL — §20.2's "Set Due Date", and the list's default sort key. */
  due_date: string;
  is_published: boolean;
  has_attachment: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A `DATEONLY` — `assigned_date`, `due_date` — read as characters, never through `Date`.
 *
 * `new Date('2026-02-01')` is parsed as UTC midnight, so `toLocaleDateString()` west of Greenwich
 * renders the 31st of January. A due date is a calendar day with no instant behind it, and giving it
 * one moves the day the work is owed — which on this screen is the whole point of the column.
 * Splitting the string the API sent cannot shift it, and it also sidesteps the hydration hazard: this
 * is a client component that Next.js renders on the server first, and any locale-sensitive formatter
 * produces different characters in the two places.
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
 * The publication filter.
 *
 * `is_published` is a bare `Joi.boolean()` in the list schema with no `.empty('')`, so `?is_published=`
 * is a 422 — and `VALIDATION_ERROR` is **not** in `EXPLAINED_CODES`, so it would surface as a red
 * banner with a "Try again" button guaranteed to fail identically. The empty option therefore carries
 * the empty string only as a local sentinel; `query` below maps it to `undefined`, and `buildUrl`
 * drops undefined keys instead of sending a valueless parameter.
 *
 * Both halves are offered because both are questions a school actually asks. "Drafts" is the one an
 * administrator cannot get any other way: unpublished homework is invisible to every student by
 * design (`list()` forces `is_published: true` for a self-scope caller), so this filter is the only
 * place a coordinator can see what a teacher has written but not yet released.
 */
const PUBLISHED_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Published and drafts' },
  { value: 'true', label: 'Published only' },
  { value: 'false', label: 'Drafts only' },
];


export default function HomeworkPage() {
  const { can } = useAuth();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [published, setPublished] = useState('');
  const [dueFrom, setDueFrom] = useState('');

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
   * Only parameters `schemas.list` declares are sent. `validate()` runs the query container with
   * `stripUnknown: true`, so an invented key is deleted in silence rather than refused — the request
   * would answer 200 having ignored the filter, which is indistinguishable from the filter working.
   *
   * The schema is `listQuery({ school_id, class_id, section_id, subject_id, teacher_id,
   * academic_session_id, is_published, due_from, due_to })`, and `listQuery` adds `page`, `limit`,
   * `sortBy`, `sortOrder` and `q`. Four of those get a control here; the rest are left off on
   * purpose:
   *
   *   - **`class_id`, `section_id`, `subject_id`, `teacher_id`, `academic_session_id`** each take a
   *     bare id. A box asking an administrator to type "7" is worse than no filter at all; they need
   *     pickers fed by this school's own `/classes`, `/subjects` and `/teachers` collections, which
   *     is a different screen's worth of work than a list.
   *   - **`due_to`** is omitted even though `due_from` is offered, and the asymmetry is deliberate.
   *     The schema orders the pair — `due_to` is `fields.due_date.when('due_from', { is: exist,
   *     then: min(ref('due_from')) })` — so a window typed end-first is a 422 `VALIDATION_ERROR`,
   *     which is not an explained code and would put a retry banner in front of what is only a
   *     typing order. The open-ended half answers the question this screen is scanned for ("what is
   *     still coming") with no way to transpose it.
   *   - **`school_id`** — see the file header; the tenant is the session's, not the request's.
   *   - **`sortBy`/`sortOrder`** — `getSort` falls back to `['due_date', 'ASC']`
   *     (`homework.service.js`'s `list()`), so the soonest deadline is already first. That is the
   *     order a deadline list is read in, and re-sorting it by title would bury the row that matters.
   */
  const query = useMemo(
    () => ({
      page,
      limit: 20,
      q: debounced || undefined,
      /*
       * `is_published` crosses the wire as the string 'true'/'false' — `Query`'s values are strings
       * or numbers, and Joi's `convert: true` turns the string back into a boolean on arrival. The
       * `|| undefined` matters beyond `buildUrl`'s own empty-string check: `useCollection` keys its
       * effect on `JSON.stringify(query)`, and `''` and `undefined` serialise differently, so
       * flipping between them would refetch for a query that had not changed.
       */
      is_published: published || undefined,
      due_from: dueFrom || undefined,
    }),
    [page, debounced, published, dueFrom]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<Homework>('/homework', query);

  const columns = useMemo<Column<Homework>[]>(
    () => [
      {
        key: 'title',
        header: 'Homework',
        cell: (row) => <span className="font-medium">{row.title}</span>,
      },
      {
        key: 'class',
        header: 'Class',
        cell: (row) => (
          <span className="whitespace-nowrap">
            {/*
              * The joined name, never `class_id`. This is one of only two associations the list
              * query provides, and it is the difference between a column an administrator can read
              * and a number they would have to look up elsewhere.
              */}
            {row.class ? row.class.name : <span className="text-muted-soft">—</span>}
            {/*
              * The section has no join, so its *name* is unavailable — but whether the field is set
              * is itself a fact worth reporting: it decides whether the whole class owes this work
              * or one section does. Saying "one section" rather than printing an id is the honest
              * version; which section it is has to come from the homework's own detail screen.
              */}
            <span className="ml-2 text-xs text-muted-soft">
              {row.section_id === null ? 'all sections' : 'one section'}
            </span>
          </span>
        ),
      },
      {
        key: 'subject',
        header: 'Subject',
        /*
         * The second and last association `list()` joins, requested with `['id','name','code']`. The
         * code is shown small beside the name because a school runs "Mathematics" in several
         * flavours and the code is what separates them on a crowded list; it is a nullable column,
         * so its absence must not leave a stray bracket.
         *
         * The whole object is nullable — `subject_id` is optional on the model, and homework set for
         * a class without naming a subject is a real state, not a data fault. It reads as "—" rather
         * than a blank cell so it cannot be mistaken for a rendering failure.
         */
        cell: (row) => {
          if (!row.subject) return <span className="text-muted-soft">—</span>;
          return (
            <span className="whitespace-nowrap">
              {row.subject.name}
              {row.subject.code ? <span className="ml-2 text-xs text-muted-soft">{row.subject.code}</span> : null}
            </span>
          );
        },
      },
      {
        key: 'assigned_date',
        header: 'Assigned',
        /*
         * Kept beside the due date rather than folded into it. The pair is what tells a head of year
         * whether a class was given a week or a night, which is the complaint a parent actually
         * phones about — and it is the only way to notice a teacher backdating an assignment.
         * `NOT NULL` on the model, so there is no empty case to render.
         */
        cell: (row) => <span className="whitespace-nowrap">{formatDay(row.assigned_date)}</span>,
      },
      {
        key: 'due_date',
        header: 'Due',
        /*
         * The sort key, so this column is the spine of the table — the rows arrive soonest-first and
         * this is the value that ordering is by. It gets its own header rather than sharing the
         * assigned column's, because a reader has to be able to tell at a glance which of the two
         * dates the list is ordered on.
         *
         * Deliberately **not** toned for lateness. "Overdue" needs a today, and there is no honest
         * one available here: comparing against `new Date()` in a client component that Next.js
         * renders on the server first produces different output in the two passes (a hydration
         * mismatch), and the school's own day is in a timezone the browser does not know. A red date
         * that is wrong by a day on either side of midnight is worse than a plain one.
         */
        cell: (row) => <span className="whitespace-nowrap font-medium">{formatDay(row.due_date)}</span>,
      },
      {
        key: 'is_published',
        header: 'Published',
        /*
         * `StatusBadge`, not local markup — the house primitive, and the same `boolean → vocabulary`
         * mapping `classes`, `staff` and `subjects` already use for their `is_active` columns.
         *
         * The words are chosen for the tone map rather than for the column name. Passing 'published'
         * would be the literal reading and the wrong one: the map has no entry for it, so it and
         * 'draft' would both render the neutral grey, and the column would lose the single
         * distinction it exists to make. 'active' is a `GOOD` word (green — students can see it) and
         * 'draft' is an `ENDED` one (grey, faded), which is exactly the contrast wanted. 'draft' is
         * also the service's own word for an unpublished row.
         */
        cell: (row) => <StatusBadge status={row.is_published ? 'active' : 'draft'} />,
      },
      {
        key: 'has_attachment',
        header: 'Attachment',
        /*
         * The boolean `present()` substitutes for the path, and the reason the substitution exists:
         * `attachment_path` describes the server's directory layout and is deleted before the row
         * leaves the service. Nothing on this screen could render it even by mistake — it is not in
         * the response and not in the interface above.
         *
         * Not a link, and that is a deduction rather than a preference. The bytes come from
         * `GET /homework/:id/attachment`, which sits behind `requirePermission('homework.view')`;
         * the access token is held in memory and attached as an `Authorization: Bearer` header by
         * `apiClient` (`apiClient.ts:274`). A plain `<a href>` is a browser navigation that carries
         * no such header, so the link would 401 every time — a control that always fails is worse
         * than an indicator that is honest about being one. Downloading needs a fetch through the
         * client and an object URL, which belongs on the detail screen that can also show
         * `attachment_name`.
         */
        cell: (row) =>
          row.has_attachment ? (
            <span className="whitespace-nowrap text-xs text-muted">file attached</span>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
    ],
    []
  );

  /* Named once so the empty message and nothing else has to re-derive "a filter is on". */
  const filtered = Boolean(debounced || published || dueFrom);

  return (
    <div>
      <PageHeader
        title="Homework"
        description="Homework set for this school, soonest due first."
        action={
          /*
           * Hidden without `homework.manage`, which `permissions.js:133` defines ("Create homework")
           * and which `POST /homework` requires. This is a courtesy, not a control: `requirePermission`
           * re-reads the permission from the database on the request itself, so a user who forced
           * this button into existence would still be refused by the API.
           */
          can('homework.manage') ? (
            <a
              href="/school/homework/new"
              className="btn btn-primary"
            >
              Set homework
            </a>
          ) : null
        }
      />

      <FilterBar
        activeCount={[dueFrom, published, search].filter(Boolean).length}
        onClear={() => {
          setDueFrom('');
          setPublished('');
          setSearch('');
          setPage(1);
        }}
      >
        <div>
          {/*
            * The placeholder names both fields the server searches. `q` is LIKEd against `title` OR
            * `description` (`homework.service.js`'s `list()`), and a box labelled only "search by
            * title" would make every description match look like a bug — especially here, where the
            * description is not a column and the matching text is therefore off-screen.
            */}
          <SearchField
            id="homework-search"
            label="Search homework"
            placeholder="Search title or description…"
            value={search}
            onChange={setSearch}
          />
        </div>

        <div>
          {/*
            * A note rather than a defect: for a caller who resolves to a Student or Parent row,
            * `list()` overwrites `where.is_published = true` *after* reading this parameter, so
            * "Drafts only" returns the same published list. That is the §20.2 disclosure rule
            * working — a draft is not "available to the relevant class/students" yet — and it is not
            * something this screen should try to pre-empt: `can()` exposes permission keys, not
            * whether the signed-in user is also a student, so any attempt to hide the option here
            * would be guessing at a fact only the server holds.
            */}
          <FilterSelect
            id="homework-published"
            label="Filter by publication"
            value={published}
            onChange={(value) => {
              setPublished(value);
              /* Page three of the old filter is rarely page three of the new one. */
              setPage(1);
            }}
          >
            {PUBLISHED_FILTERS.map((option) => (
              <option key={option.value || 'all'} value={option.value}>
                {option.label}
              </option>
            ))}
          </FilterSelect>
        </div>

        <div>
          {/*
            * `type="date"` emits `YYYY-MM-DD`, which is exactly what `Joi.date().iso()` accepts and
            * what the service's `dateOnly()` normalises to — the value crosses the wire without ever
            * being turned into an instant, the same reason the columns above format by slicing.
            * Clearing the field yields `''`, which `query` maps to `undefined` and the filter lifts;
            * sending the empty string instead would be a 422, because `due_from` has no `.empty('')`.
            *
            * Left blank by default rather than pre-set to today. A default filter that hides last
            * term's homework would be a filter the user never chose and might never notice, and the
            * empty list it produces for a quiet week is indistinguishable from a broken screen.
            */}
          <FilterDate
            id="homework-due-from"
            label="Due on or after"
            value={dueFrom}
            onChange={(value) => {
              setDueFrom(value);
              setPage(1);
            }}
          />
        </div>
      </FilterBar>

      {/*
        * Refusal before error, error before loading. A school whose plan excludes §20 gets the
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
            * The empty message names that filters are on. "No homework yet" underneath an active
            * due-date or drafts filter is a lie that sends a coordinator looking for missing data
            * instead of at the control that hid it.
            */}
          {filtered
            ? 'No homework matches these filters.'
            : 'No homework has been set for this school yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Homework"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
