'use client';

/**
 * Students — SRS §15.1 (FR-STUDENT-001 / FR-STUDENT-002) and §33's "Students", checklist row 4.4.
 *
 * The same four moving parts as `super-admin/schools/page.tsx`, which is the exemplar: a
 * `useCollection` call, a `Column[]`, the four-state render, and pagination. What differs is what a
 * student row is allowed to say, and how little of the placement an administrator can be shown.
 *
 * ## The module gate is already handled, and that is why `refusal` is checked first
 *
 * `students.routes.js` mounts `requireModule(MODULES.STUDENTS)` at router level — before every route
 * on it, `GET /` included. A school whose plan omits the Students module gets 403
 * `MODULE_NOT_SUBSCRIBED` on this screen's only request. `useCollection` puts that in `refusal`
 * rather than `error` and `RefusalNotice` explains it, so nothing here inspects the entitlement
 * snapshot: a second copy of the gate in the page could only ever disagree with the one that decides.
 * The nav does hide the item (`SCHOOL_NAV` marks it `module: 'students'`), but a bookmarked URL
 * reaches this file anyway, which is the case the refusal branch exists for.
 *
 * ## The stored photo path is not on a row to render, and that is deliberate
 *
 * `students.service.present()` deletes `photo_path` and substitutes `has_photo` (Known Issues #26),
 * and the controller maps `present` over **every** row of the list, not just a read by id. The
 * `StudentRow` interface below therefore has no `photo_path` at all — writing it as optional would
 * invite a column that the API can never populate and that must never exist if it could.
 *
 * ## Class and Section are absent from this table on purpose
 *
 * `students.service.list()` builds `paginateQuery(db.Student, { where, order }, …)` with **no
 * `include`**, so a row carries `class_id` and `section_id` as bare integers and nothing else. A
 * column reading "7" tells an administrator nothing it could not have made up, so the placement is
 * not shown rather than shown wrongly. Fixing this belongs in the service — an `include` of `Class`
 * and `Section` — not in a page that would have to fetch two more collections to decode two numbers.
 *
 * ## Dates are `DATEONLY`, so they must never touch the local timezone
 *
 * `admission_date` and `date_of_birth` are `DataTypes.DATEONLY` (`models/people.js`), which
 * serialises as the bare string `YYYY-MM-DD`. `new Date('2011-03-01')` parses that as **UTC**
 * midnight, and formatting the result in a negative-offset locale renders the day before — a
 * birthday off by one on every row west of Greenwich. `DateOnly` below formats in UTC for that
 * reason. This is not the same problem `last_login_at` has on the Users screen: that column is a real
 * instant, where the local hour is the correct answer.
 */

import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
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
 * One row of `GET /students`, as `students.service.present()` leaves it.
 *
 * Only the fields this screen renders are declared. The row the API sends is wider — guardian
 * details, address, `notes`, `metadata`, the FR-STUDENT-002 lifecycle stamps — but a type that
 * enumerated them would read as a licence to put them in a column, and a roster is not a profile.
 *
 * Nullability is the model's, not a guess: `student_id`, `first_name`, `admission_date` and `status`
 * are `allowNull: false`; `roll_number`, `last_name`, `gender` and `date_of_birth` are not.
 */
interface StudentRow {
  id: number;
  student_id: string;
  roll_number: string | null;
  first_name: string;
  last_name: string | null;
  gender: string | null;
  /** `DATEONLY` — the string `YYYY-MM-DD`, never an instant. */
  date_of_birth: string | null;
  /** `DATEONLY`, and NOT NULL: FR-STUDENT-001 makes admission the event that creates the row. */
  admission_date: string;
  status: string;
}

/**
 * SRS §15.1's student lifecycle, as `config/constants.js` `STUDENT_STATUS` fixes it.
 *
 * Hardcoded rather than fetched, for the reason the Users screen gives about roles: the set is closed
 * by the source, `students.validation.js` compiles it into `Joi.valid(...)` so anything else is a 422
 * rather than an empty table, and spending a request on six constants would leave the filter unable
 * to render until it came back.
 *
 * Note what these words are: the product of `/promote`, `/transfer` and `/leave`. `status` is
 * `forbidden()` in both body schemas precisely so that `student_limit` — which counts
 * `status = 'active'` — cannot be moved by an ordinary edit. So the filter is the only place on this
 * screen where the vocabulary appears, and it appears as a query value, never as a branch.
 */
/*
 * Three of `STUDENT_STATUS`'s six, not all six — because only three are ever written.
 *
 * `students.service.js:29-38` records the decision deliberately: promotion keeps `status = 'active'`
 * and moves `promoted_at` and `previous_class_id` instead, "because the student is still enrolled",
 * and it says in as many words that `promoted` "is a value this module never writes", with
 * `graduated` and `inactive` likewise. A grep for `STUDENT_STATUS.` across `backend/src` finds only
 * ACTIVE, LEFT and TRANSFERRED assigned anywhere.
 *
 * Offering the other three would be offering filters that always return nothing — and worse than
 * nothing: an administrator who has just promoted a cohort, filters "Promoted" and sees an empty
 * table would reasonably conclude the cohort had been lost. The Joi schema accepts all six, so this
 * is a narrowing of the UI to what the data can answer, not a disagreement with the API.
 */
const STATUSES = ['active', 'transferred', 'left'] as const;

function humanise(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

/**
 * A `DATEONLY` column rendered as a calendar day, in the timezone it was stored in: none.
 *
 * `timeZone: 'UTC'` is the whole point — see the file header. The `<time>` element keeps the original
 * `YYYY-MM-DD`, which is the value anyone comparing this screen against the database needs.
 *
 * Locale formatting is safe despite being environment-dependent, for the reason the Users screen
 * records: the table mounts only after a client-side fetch resolves, so there is no server-rendered
 * markup for the browser's locale to disagree with.
 */
function DateOnly({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-soft">—</span>;

  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  /*
   * If the shape is ever not `YYYY-MM-DD` — a column promoted to DATETIME, say — the raw string is
   * shown rather than pushed through `Date`, which would print the words "Invalid Date" as data.
   */
  if (!parts) return <span className="whitespace-nowrap">{value}</span>;

  const when = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));

  return (
    <time dateTime={value} title={value} className="whitespace-nowrap">
      {when.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })}
    </time>
  );
}

export default function StudentsPage() {
  const { can } = useAuth();

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      /*
       * Resetting to page one is part of the search, not a separate concern — searching from page
       * four and staying there shows an empty table for a query with three pages of results.
       */
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  /*
   * 300 ms, and the reason is the backend's: `q` reaches **four** `LIKE '%…%'` scans on `students`
   * (`first_name`, `last_name`, `student_id`, `roll_number`), and `apiLimiter` is mounted before
   * authentication, so an unthrottled request per keystroke spends a real budget on the widest scan
   * in this module. `students` is also the largest table a school has, which makes it the worst place
   * in §33 to send one request per character.
   *
   * `q` is not truncated here: `useCollection` clips it to the 120 characters `commonSchemas.search`
   * accepts, so a pasted essay returns results instead of a 422 that "Try again" could never clear.
   */
  const query = useMemo(
    () => ({
      page,
      limit: 20,
      q: debounced || undefined,
      status: status || undefined,
    }),
    [page, debounced, status]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<StudentRow>(
    '/students',
    query
  );

  const columns = useMemo<Column<StudentRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Name',
        /*
         * One column, because a person has one name. `last_name` is nullable in the model, so the
         * two are joined through a filter rather than a template — `${first} ${last}` renders a
         * trailing space and, when the column is null, the literal text "null".
         */
        cell: (row) => (
          <span className="font-medium">
            {[row.first_name, row.last_name].filter(Boolean).join(' ')}
          </span>
        ),
      },
      {
        key: 'student_id',
        /*
         * FR-STUDENT-001's "Student ID" — the school's own identifier, unique per school
         * (`students_school_studentid_unique`), allocated by the service when admission does not
         * supply one. Not `students.id`: the surrogate key is a database detail that appears on no
         * document a parent or a teacher holds, whereas this is the number written on the file.
         */
        header: 'Student ID',
        cell: (row) => <code className="text-xs text-muted">{row.student_id}</code>,
      },
      {
        key: 'roll_number',
        /*
         * FR-STUDENT-001's "Roll Number", unique within class+section+session. It is the number a
         * teacher calls from a register, and one of the four fields `q` searches, so it has to be
         * visible — a search that matches on a value the table does not show looks broken.
         */
        header: 'Roll no.',
        cell: (row) => row.roll_number ?? <span className="text-muted-soft">—</span>,
      },
      {
        key: 'gender',
        header: 'Gender',
        cell: (row) =>
          row.gender ? humanise(row.gender) : <span className="text-muted-soft">—</span>,
      },
      {
        key: 'date_of_birth',
        /*
         * Carried because the placement columns cannot be: with no class or section to separate them,
         * two students of the same name are otherwise indistinguishable on this screen, and picking
         * the wrong one is how a record gets edited by mistake. A birth date also decides age-banded
         * eligibility, which is a roster question rather than a profile one.
         */
        header: 'Date of birth',
        cell: (row) => <DateOnly value={row.date_of_birth} />,
      },
      {
        key: 'admission_date',
        /* SRS §15.1 "Admission" — NOT NULL, and the row's own origin date. */
        header: 'Admitted',
        cell: (row) => <DateOnly value={row.admission_date} />,
      },
      {
        key: 'status',
        /*
         * `StatusBadge` tones `active` green and `inactive` grey from its own vocabulary lists; the
         * four FR-STUDENT-002 outcomes — `promoted`, `transferred`, `left`, `graduated` — are not in
         * them and fall to the neutral default — which was true when this was written and is no
         * longer: the map was widened to all fifty status words in session 26, so `transferred` and
         * `left` now read as ended. (`promoted`, `graduated` and `inactive` are toned too, though no
         * code path writes them — see the STATUSES note above.) It was right not to fix it here:
         * the tone map is shared by every list
         * in §33, and widening it from one screen is how a shared component acquires a caller's
         * opinions.
         */
        header: 'Status',
        cell: (row) => <StatusBadge status={row.status} />,
      },
    ],
    []
  );

  const filtered = Boolean(debounced || status);

  return (
    <div>
      <PageHeader
        title="Students"
        description="Everyone admitted to this school, and where they are in the admission-to-leaving cycle."
        action={
          /*
           * `students.manage` exists in the catalogue (`config/permissions.js:87`, "Admit / edit
           * students") and is what `POST /students` requires, so the button is gated on it rather
           * than on `students.view` — a class teacher can read this roster and cannot admit to it.
           *
           * "Admit", not "Add": FR-STUDENT-001 calls the operation admission, the service stamps
           * `admission_date` as a required field, and the activity log records "Admitted student".
           * Naming the button after the row it creates would hide that this is a dated event.
           *
           * Two things it does not promise. It is a courtesy, not a control — `students.manage` is
           * re-read from the database on the request itself, so forcing the link into existence
           * changes nothing. And it does not predict success: `POST /students` also carries
           * `enforceLimit('student_limit')`, so a school at its §11.2 ceiling will be refused with
           * `PLAN_LIMIT_EXCEEDED` at the far end. Re-checking the limit here would put a copy of the
           * plan's arithmetic in a page, and it would be stale the moment another admission lands.
           */
          can('students.manage') ? (
            <a
              href="/school/students/new"
              className="btn btn-primary"
            >
              Admit student
            </a>
          ) : null
        }
      />

      {/*
        * Two controls out of the eleven parameters `schemas.list` declares — seven of its own
        * (`school_id`, `status`, `class_id`, `section_id`, `academic_session_id`, `uses_transport`,
        * `q`) plus `page`, `limit`, `sortBy` and `sortOrder` from `commonSchemas.pagination`. The
        * omissions are reasoned rather than lazy.
        *
        * `class_id`, `section_id` and `academic_session_id` take a row id. A box an administrator
        * types "7" into is not a filter anyone can use; each needs a picker fed by another collection,
        * which is three more requests on a screen that cannot even label the ids it already receives
        * (see the header). Filtering a roster by class properly begins on the Classes screen.
        *
        * `school_id` is a platform-caller parameter. On the School surface the tenant comes from the
        * session — `tenantWhere(req.tenant, …)` scopes the query before any of this is read — and a
        * school picker on a school's own roster would only ever be a way to get 403
        * `SCHOOL_CONTEXT_REQUIRED` wrong.
        *
        * `uses_transport` answers a transport-desk question (§17's fee component), not a roster one,
        * and its `false` is the column default rather than a recorded decision — so "does not use
        * transport" and "nobody has said" would be the same filter result with different meanings.
        *
        * `sortBy`/`sortOrder` are left at the service's default (`first_name ASC`) because
        * `DataTable` has no sort affordance; inventing one here would put table interaction in a page
        * instead of in the component every §33 list shares.
        */}
      <FilterBar
        activeCount={[search, status].filter(Boolean).length}
        onClear={() => {
          setSearch('');
          setStatus('');
          setPage(1);
        }}
      >
        <SearchField
          id="student-search"
          label="Search students"
          placeholder="Search by name, student ID or roll number…"
          value={search}
          onChange={setSearch}
        />

        <FilterSelect
          id="student-status"
          label="Filter by student status"
          value={status}
          onChange={(value) => {
            setStatus(value);
            /* Same reason the search resets: filtering from page four shows an empty table for a
             * filter that has two pages of matches. */
            setPage(1);
          }}
        >
          {/*
            * "All statuses" is the default rather than "Active", even though a roster is usually a
            * roster of current students. Defaulting to a filter means the first thing this screen
            * ever shows is a subset presented as a whole — and a student who has left would appear
            * to have vanished from the system rather than to have a status.
            */}
          <option value="">All statuses</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {humanise(value)}
            </option>
          ))}
        </FilterSelect>
      </FilterBar>

      {/*
        * `refusal` before `error`, and both before `loading` resolves to content. A screen that
        * checked `error` first would offer "something went wrong" and a Try again button to a school
        * whose plan does not include the Students module — the request did exactly what it should,
        * and retrying it cannot change the plan.
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
            * An empty filtered list and an empty school are different facts, and conflating them
            * sends someone looking for a data-import problem they do not have.
            */}
          {filtered
            ? 'No student matches these filters.'
            : 'No students have been admitted to this school yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Students"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
