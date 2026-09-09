'use client';

/**
 * Attendance — SRS §16 "Attendance Management", §33's School list "Attendance",
 * `docs/IMPLEMENTATION_CHECKLIST.md` row 4.4 ("School: 17 MVP screens").
 *
 * **§16, not §18.** The brief for this screen cited "§18", and §18 of `docs/SRS-extracted.md` is
 * Finance Management — attendance is §16 (line 866), which is also what every file in
 * `backend/src/modules/attendance/` cites. Recorded here rather than silently corrected, because the
 * next reader given the same brief will otherwise trace this screen to the wrong requirement and
 * "verify" it against finance.
 *
 * This is the student register (`GET /attendance/students`, FR-ATT-001's stored rows). Teacher
 * attendance is a different endpoint behind a different permission — `attendance.teacher.view`,
 * which the seeded `teacher` role deliberately does not hold — and therefore a different screen.
 *
 * ## The shape is the exemplar's, and the two deviations are deliberate
 *
 * `super-admin/schools/page.tsx` is the pattern: one `useCollection`, one `Column[]`, the four-state
 * render in the order refusal → error → loading → empty → table, then `Pagination`. Two things here
 * differ from it, both because the endpoint differs:
 *
 *   1. **The search box filters remarks.** This header used to say there was no search box because
 *      `listStudents()` "never reads" `q`. It does — `attendance.service.js` applies it as a LIKE
 *      over `remarks`. The reasoning was sound and the premise was false, so the screen was
 *      withholding a control that works.
 *
 *      What it searches is worth labelling, because it is not what a search box usually means on a
 *      register: `remarks`, the free-text note on a row, **not** the student's name. A box labelled
 *      just "Search" would be read as name search and would quietly return nothing for a name that
 *      is present — the same dead-control problem in a different disguise. So the label and the
 *      placeholder both say remarks.
 *   2. **The action button leads to a register, not a create form** — see the note on
 *      `PageHeader` below. It was omitted entirely until the register screen existed.
 *
 * ## The module gate needs nothing from this file
 *
 * `attendance.routes.js` mounts `requireModule(MODULES.ATTENDANCE)` at router level, so a school
 * whose plan excludes attendance gets a 403 `MODULE_NOT_SUBSCRIBED`. `useCollection` classifies that
 * as a *refusal* rather than an error, and `RefusalNotice` explains it. Checking the entitlement
 * snapshot here as well would duplicate a decision the server has already made — and would be wrong
 * whenever the snapshot in the token is older than the subscription.
 */

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { Icon } from '@/components/icon';
import { Tabs, TabPanel, useActiveTab } from '@/components/tabs';
import type { TabDef } from '@/components/tabs';
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
 * The student rows the list joins on.
 *
 * These five attributes and no others: `attendance.service.js listStudents()` passes
 * `attributes: ['id', 'student_id', 'roll_number', 'first_name', 'last_name']` to the include, so
 * anything else on the `Student` model — the guardian's phone, the photo path, the class — is simply
 * not on the wire. Typing the wider model here would let a column reference a field that is always
 * `undefined`, which renders as a blank cell rather than as a compile error.
 *
 * `student_id` is the school's Student ID string (`STRING(60)`, SRS §15.1), not the foreign key;
 * the foreign key is `id`. The collision of names is the schema's and is worth knowing before
 * reading the columns below.
 */
interface AttendanceStudent {
  id: number;
  student_id: string;
  roll_number: string | null;
  first_name: string;
  last_name: string | null;
}

/**
 * One `student_attendance` row as the controller sends it.
 *
 * There is no `present()` in `attendance.controller.js` — `listStudents` hands the Sequelize rows
 * straight to `ApiResponse.paginated`, so every model column is on the wire. This interface names
 * only the ones this screen renders; the rest are listed in the header of the column table below
 * with the reason each is left out.
 *
 * `student` is optional-and-nullable even though `student_id` is NOT NULL with `ON DELETE CASCADE`,
 * because the include is a LEFT JOIN (`required` is not set) and strict mode should force the empty
 * case to be handled rather than let a cell throw on a row the query shape does not guarantee.
 */
interface StudentAttendanceRow {
  id: number;
  /** `DATEONLY` — a calendar date, `YYYY-MM-DD`, with no instant behind it. */
  attendance_date: string;
  status: string;
  late_minutes: number | null;
  remarks: string | null;
  /** A real timestamp: when the register was last written, from the row's own provenance columns. */
  marked_at: string | null;
  student?: AttendanceStudent | null;
}

/**
 * §16's status vocabulary, in the order the SRS lists it.
 *
 * Mirrors `ATTENDANCE_STATUS` in `backend/src/config/constants.js`, which is what the Joi schema's
 * `valid(...ATTENDANCE_STATUS_LIST)` is built from — a word not in that list is a 422, and
 * `VALIDATION_ERROR` is not an explained code, so it would surface as a retryable red banner for a
 * filter the user cannot un-choose. Four fixed words, so a hardcoded list cannot drift far; this is
 * an enum on the column, not a plan name (SRS §30 Rule 1 is untouched).
 */
const STATUSES = ['present', 'absent', 'leave', 'late'] as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A `YYYY-MM-DD` rendered as `5 Sep 2026`, without ever constructing a `Date`.
 *
 * Two separate traps, and only string arithmetic avoids both:
 *
 *   - `new Date('2026-09-05')` is parsed as **UTC midnight**, so `toLocaleDateString()` west of UTC
 *     prints the 4th. `attendance_date` is a `DATEONLY`; a register marked on the 5th that reads
 *     "4 Sep" in a Chicago browser is a wrong answer to the question this screen exists to answer.
 *     The sibling invoice screen prints its `due_date` raw for exactly this reason.
 *   - This is a client component, which Next.js still renders on the server first. Any locale- or
 *     zone-dependent formatting produces one string in Node and another in the browser — a
 *     hydration mismatch on every date cell.
 *
 * Slicing the digits the server sent cannot do either. A value that does not match falls through
 * unchanged rather than rendering "Invalid Date" into a register.
 */
function formatDateOnly(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : value;
}

/**
 * A full ISO timestamp as `5 Sep 2026`, read in UTC.
 *
 * `marked_at` *is* an instant, so a `Date` is legitimate here — but its parts are read in UTC for
 * the hydration reason above, and only the day is shown. The clock time is deliberately dropped:
 * showing "21:40" without saying it is UTC invites it to be read as local, and saying so would put a
 * timezone abbreviation in a register column that has no room for one.
 */
function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return null;
  return `${when.getUTCDate()} ${MONTHS[when.getUTCMonth()]} ${when.getUTCFullYear()}`;
}

/**
 * A check-in or check-out as a **time of day**, in the viewer's zone.
 *
 * ## Why not UTC, when every other stamp on this screen is
 *
 * `formatTimestamp` above pins to UTC deliberately: a `DATEONLY` serialised as UTC midnight renders
 * as the previous day west of Greenwich, so a calendar day must not be given a zone. That reasoning
 * is about **days**. A check-in is a *time*, and the time that matters is the one on the clock in the
 * corridor.
 *
 * Rendering 03:55 for a teacher who arrived at 08:55 would be worse than useless — it is a number
 * nobody can reconcile with anything. So this renders in the viewer's zone, which is also the zone
 * the value was **entered** in: the register's `datetime-local` control is viewer-zone by
 * definition, and `isoInstant` converted from it on the way out. The value therefore round-trips to
 * what was typed.
 *
 * The limit, stated rather than hidden: a viewer in a different zone from the school sees their own
 * clock. `school_settings.timezone` exists and this screen does not read it, because doing so means
 * a second request on every render of a list, and the reader of a school's own register is in the
 * school's zone in every case that matters.
 */
const TIME_OF_DAY = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function formatTimeOfDay(value: string | null): string | null {
  if (!value) return null;
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? null : TIME_OF_DAY.format(when);
}

/** `partially_paid` → `partially paid`, for a label a person reads. */
const spell = (value: string) => value.replace(/_/g, ' ');

function StudentsPanel() {
  const { can } = useAuth();
  /* The key `POST /attendance/students` is mounted behind. */
  const canMark = can('attendance.mark');

  const [page, setPage] = useState(1);
  const [date, setDate] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  /* Debounced for the reason every list screen here debounces: `apiLimiter` sits in front of
     authentication, so a request per keystroke spends a budget that is not free. */
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  /**
   * Only the parameters `listStudents()` branches on, and only one shape of date filter.
   *
   * The schema also declares `class_id`, `section_id`, `student_id`, `academic_session_id`, `from`
   * and `to`. The first four need a picker fed by another endpoint — a raw id box asks an
   * administrator to know that Grade 7B is `class_id=12`, which is not a question a person can
   * answer — and are left to the detail screens that already have those lists.
   *
   * `from`/`to` are left off for a sharper reason: `applyDateFilter()` in the service checks
   * `attendance_date` **first and returns**, so a request carrying both a day and a range silently
   * drops the range. Two date controls that cancel each other with no feedback is worse than one
   * that always works, so the screen exposes the single day — which is also the question a register
   * answers ("who was absent on the 3rd?"). Without it the list is every marked day, newest first.
   *
   * `undefined` rather than `''` for an unset filter is not cosmetic: `buildUrl` in `apiClient`
   * skips `undefined`, `null` and `''` alike, but `useCollection` keys its refetch on
   * `JSON.stringify(query)`, and `''` and `undefined` serialise differently — so returning `''` here
   * would refetch when clearing a filter that was already clear.
   */
  const query = useMemo(
    () => ({
      page,
      limit: 20,
      attendance_date: date || undefined,
      status: status || undefined,
      q: debounced || undefined,
    }),
    [page, date, status, debounced]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<StudentAttendanceRow>(
    '/attendance/students',
    query
  );

  /**
   * Seven columns, chosen for the two things an administrator does with this screen: read one day's
   * register down the roll, and scan a stretch of days for the children who are missing.
   *
   * What is on the wire and deliberately not here:
   *
   *   - `class_id` / `section_id` — the associations exist (`models/index.js:368-369`, as `class` and
   *     `section`) but `listStudents()` includes only `student`, so the response carries bare
   *     integers. "7" names no class to anyone, and rendering it as though it did is worse than
   *     leaving the column out; fixing it means adding the includes to the service, not guessing here.
   *   - `academic_session_id`, `marked_by` — same problem. `marked_by` is the one that stings, since
   *     FR-ATT-001 is about *who* recorded the register and `attachActor` defines a `markedBy`
   *     association; it is just not included by this query, and "#4" is not a teacher's name.
   *   - `alert_sent_at` — the low-attendance notification's de-duplication flag (SRS §23). It records
   *     what the *system* did, not what the child did.
   *   - `id`, `school_id`, `organization_id`, `created_at`, `updated_at` — a surrogate key, the
   *     tenancy this whole surface is already scoped to, and row bookkeeping that `marked_at`
   *     supersedes. `student_attendance` is the one table in the project that carries its own
   *     provenance, so `marked_at` is the honest "when was this written" and `updated_at` is noise
   *     beside it.
   */
  const columns = useMemo<Column<StudentAttendanceRow>[]>(
    () => [
      {
        key: 'attendance_date',
        header: 'Date',
        cell: (row) => (
          <span className="whitespace-nowrap tabular-nums">{formatDateOnly(row.attendance_date)}</span>
        ),
      },
      {
        /*
         * The name, with the school's Student ID beneath it. The ID is not decoration: two children
         * called Ali Khan in one section is the ordinary case, and the name alone then identifies
         * neither. `last_name` is nullable on the model, so it is joined conditionally rather than
         * interpolated into a trailing space.
         */
        key: 'student',
        header: 'Student',
        cell: (row) => {
          if (!row.student) return <span className="text-muted-soft">unknown student</span>;
          const name = [row.student.first_name, row.student.last_name].filter(Boolean).join(' ');
          return (
            <div className="min-w-0">
              <span className="font-medium">{name}</span>
              <code className="mt-0.5 block truncate text-xs text-muted-soft">{row.student.student_id}</code>
            </div>
          );
        },
      },
      {
        /*
         * A separate column rather than more small print under the name, because reading a register
         * *in roll order* is the whole workflow — the paper one is sorted by it. `STRING(40)` and
         * nullable in the schema, so it is not a numeric column even though it usually looks like
         * one; `tabular-nums` lines up the common case without claiming the value is a number.
         */
        key: 'roll_number',
        header: 'Roll',
        cell: (row) =>
          row.student?.roll_number ? (
            <span className="tabular-nums">{row.student.roll_number}</span>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
      {
        /*
         * The stored word, through the shared badge. All four of §16's statuses are toned:
         * `present` reads as good, `late` as needing attention, `absent` as bad, and `leave` as
         * neutral — an approved absence is not a failure to attend.
         *
         * This comment used to say the opposite, and was right when it was written: the tone map
         * then covered only the billing and tenancy vocabularies, so all four rendered grey. It was
         * widened to all fifty status words in session 26, and `verify-frontend.js` now fails if any
         * vocabulary gains a word with no tone. The fix
         * belongs in `components/table.tsx` (present → good, late → attention, absent → bad,
         * leave → ended) and is reported rather than made here.
         */
        key: 'status',
        header: 'Status',
        cell: (row) => <StatusBadge status={row.status} />,
      },
      {
        /*
         * Rendered for whatever status carries it, not only for `late`. The validation schema's own
         * comment is explicit that `late_minutes` is accepted on any entry because the column is
         * nullable and §16 says nothing about the pairing — so a screen that showed it only beside
         * `late` would hide data the API stored on purpose.
         *
         * `0` is a real value and must not be swallowed by a truthiness check: a child marked late by
         * zero minutes was recorded as such, and blanking it would look like the field was left empty.
         */
        key: 'late_minutes',
        header: 'Late',
        numeric: true,
        cell: (row) =>
          row.late_minutes === null || row.late_minutes === undefined ? (
            <span className="text-muted-soft">—</span>
          ) : (
            <span className="whitespace-nowrap">{row.late_minutes} min</span>
          ),
      },
      {
        /*
         * `STRING(255)`, so it is capped in width and truncated rather than allowed to set the
         * table's column widths from one long note. `title` keeps the full text reachable on hover
         * for a sighted user; the untruncated value is on the record either way.
         */
        key: 'remarks',
        header: 'Remarks',
        cell: (row) =>
          row.remarks ? (
            <span className="block max-w-[18rem] truncate" title={row.remarks}>
              {row.remarks}
            </span>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
      {
        /*
         * When the register was last written. Re-posting a register corrects it — the unique index on
         * `(student_id, attendance_date)` makes the write an upsert, and `marked_at` is in
         * `updateOnDuplicate` — so this is "when this row last changed", which is what makes a
         * disputed absence traceable.
         *
         * No "backfilled" flag is derived from comparing this against `attendance_date`, tempting as
         * it is: one is a calendar date and the other a UTC instant, so a register marked at 8pm
         * local anywhere west of UTC would be labelled a day late. A wrong badge on an audit column
         * is worse than no badge.
         */
        key: 'marked_at',
        header: 'Marked',
        cell: (row) => {
          const when = formatTimestamp(row.marked_at);
          return when ? (
            <span className="whitespace-nowrap text-muted">{when}</span>
          ) : (
            <span className="text-muted-soft">—</span>
          );
        },
      },
    ],
    []
  );

  const filtered = Boolean(date || status);

  return (
    <>
      {/*
        * The action lives on the panel rather than the screen header, because the two registers are
        * marked at different URLs and behind different keys — `attendance.mark` here,
        * `attendance.teacher.mark` on the other tab. A single header button would have to pick one.
        *
        * The button was deliberately absent until 2026-09-09, and the reason is worth keeping
        * because it was the right call at the time: `POST /attendance/students` takes a class, a
        * date and an `entries` array of up to 500 students, because FR-ATT-001 is "a teacher marks a
        * section", not "a user adds a row". That is a register form and a screen of its own, and
        * linking to a route that did not exist would have been worse than linking to nothing.
        */}
      {canMark ? (
        <div className="mb-4 flex justify-end">
          <Link href="/school/attendance/mark" className="btn btn-primary">
            <Icon name="plus" size={15} />
            Mark student attendance
          </Link>
        </div>
      ) : null}

      <FilterBar
        activeCount={[date, search, status].filter(Boolean).length}
        onClear={() => {
          setDate('');
          setSearch('');
          setStatus('');
          setPage(1);
        }}
      >
        <div>
          {/* Labelled "remarks", not "search": see point 1 in the header. */}
          <SearchField
            id="attendance-search"
            label="Remarks"
            labelVisible
            placeholder="Search the remarks on a row…"
            value={search}
            onChange={setSearch}
          />
        </div>
        <div>
          {/*
            * `type="date"` emits `YYYY-MM-DD`, which is exactly what `Joi.date().iso()` accepts and
            * what `dates.toDateOnly()` normalises to — the value crosses the wire without ever being
            * turned into an instant, which is the same reason the column above formats by slicing.
            * Clearing the field yields `''`, which `query` maps to `undefined` and the filter lifts.
            */}
          <FilterDate
            id="attendance-date"
            label="Date"
            value={date}
            onChange={(value) => {
              setDate(value);
              /* Page four of the old result set is not page four of this one. */
              setPage(1);
            }}
          />
        </div>

        <div>
          <FilterSelect
            id="attendance-status"
            label="Status"
            labelVisible
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          >
            <option value="">Any status</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {spell(value)}
              </option>
            ))}
          </FilterSelect>
        </div>
      </FilterBar>

      {/*
        * Refusal before error, error before loading. Reversing the first two would greet a school
        * without the attendance module — or a role without `attendance.view`, which every parent and
        * most staff are — with "something went wrong" and a Try again button that can only fail the
        * same way. Both of those are 403s the server meant to send.
        */}
      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {filtered
            ? 'No attendance record matches these filters.'
            : 'No attendance has been marked yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption="Student attendance"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </>
  );
}

/* ─────────────────────────────── the teacher register ─────────────────────────────── */

/**
 * One row of `GET /attendance/teachers`.
 *
 * `attendance.controller.js` presents both registers the same way, which is deliberate — §16 asks
 * for teacher attendance in the same terms as student attendance — so this row is the student shape
 * with `teacher` in place of `student` and two timestamps the student register does not have.
 */
interface TeacherAttendanceRow {
  id: number;
  teacher_id: number;
  attendance_date: string;
  status: string;
  late_minutes: number | null;
  check_in_at: string | null;
  check_out_at: string | null;
  remarks: string | null;
  teacher?: { id: number; employee_id: string; first_name: string; last_name: string | null } | null;
}

function TeachersPanel() {
  const { can } = useAuth();
  /* A different key from the student register — `attendance.teacher.mark`, not `attendance.mark`. */
  const canMark = can('attendance.teacher.mark');

  const [page, setPage] = useState(1);
  const [date, setDate] = useState('');
  const [status, setStatus] = useState('');

  const query = useMemo(
    () => ({
      page,
      limit: 20,
      attendance_date: date || undefined,
      status: status || undefined,
    }),
    [page, date, status]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<TeacherAttendanceRow>(
    '/attendance/teachers',
    query
  );

  const columns = useMemo<Column<TeacherAttendanceRow>[]>(
    () => [
      {
        key: 'date',
        header: 'Day',
        cell: (row) => <span className="whitespace-nowrap">{formatDateOnly(row.attendance_date)}</span>,
      },
      {
        key: 'teacher',
        header: 'Teacher',
        primary: true,
        cell: (row) =>
          row.teacher ? (
            <>
              <span className="font-medium">
                {[row.teacher.first_name, row.teacher.last_name].filter(Boolean).join(' ')}
              </span>
              <span className="block text-xs text-muted-soft">{row.teacher.employee_id}</span>
            </>
          ) : (
            /* A LEFT JOIN, so the association is not guaranteed; the id is what is certain. */
            <span className="text-muted-soft">teacher #{row.teacher_id}</span>
          ),
      },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
      {
        key: 'late',
        header: 'Late by',
        numeric: true,
        cell: (row) =>
          row.late_minutes ? `${row.late_minutes} min` : <span className="text-muted-soft">—</span>,
      },
      {
        /*
         * The two columns the student register does not have. `check_in_at` and `check_out_at` are
         * `DATE`, not `DATEONLY` — they are instants — so they go through `formatTimestamp`, which
         * is the same helper the student panel uses for its own stamps.
         */
        key: 'in',
        header: 'In',
        hideOnMobile: true,
        cell: (row) => formatTimeOfDay(row.check_in_at) ?? <span className="text-muted-soft">—</span>,
      },
      {
        key: 'out',
        header: 'Out',
        hideOnMobile: true,
        cell: (row) => formatTimeOfDay(row.check_out_at) ?? <span className="text-muted-soft">—</span>,
      },
      {
        key: 'remarks',
        header: 'Remarks',
        hideOnMobile: true,
        cell: (row) => row.remarks ?? <span className="text-muted-soft">—</span>,
      },
    ],
    []
  );

  const filtered = Boolean(date || status);

  return (
    <>
      {canMark ? (
        <div className="mb-4 flex justify-end">
          <Link href="/school/attendance/mark?register=teachers" className="btn btn-primary">
            <Icon name="plus" size={15} />
            Mark teacher attendance
          </Link>
        </div>
      ) : null}

      <FilterBar
        activeCount={[date, status].filter(Boolean).length}
        onClear={() => {
          setDate('');
          setStatus('');
          setPage(1);
        }}
      >
        <FilterDate
          id="teacher-attendance-date"
          label="Day"
          value={date}
          onChange={(value) => {
            setDate(value);
            setPage(1);
          }}
        />
        <FilterSelect
          id="teacher-attendance-status"
          label="Attendance status"
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        >
          <option value="">Any status</option>
          <option value="present">Present</option>
          <option value="absent">Absent</option>
          <option value="leave">Leave</option>
          <option value="late">Late</option>
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
          {filtered
            ? 'No teacher attendance matches these filters.'
            : 'No teacher attendance has been recorded yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption="Teacher attendance"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </>
  );
}

/* ─────────────────────────────── the screen ─────────────────────────────── */

/**
 * §33 names one Attendance screen; §16 defines two registers and the API has two collections.
 *
 * Tabs, on the precedent Library and Fees already set: splitting one of §33's screens in two would
 * be rewriting the requirement, and leaving the teacher register unreachable was the alternative —
 * `GET` and `POST /attendance/teachers` had no caller anywhere in the product.
 */
const TABS: TabDef[] = [
  { key: 'students', label: 'Students' },
  { key: 'teachers', label: 'Teachers' },
];

function AttendanceScreen() {
  const [active, setActive] = useActiveTab(TABS);

  return (
    <div>
      <PageHeader
        title="Attendance"
        description="Who was in, and who was not — for students and for staff."
      />
      <Tabs tabs={TABS} active={active} onChange={setActive} label="Attendance registers" />
      <TabPanel tabKey={active}>
        {active === 'students' ? <StudentsPanel /> : <TeachersPanel />}
      </TabPanel>
    </div>
  );
}

export default function AttendancePage() {
  /* `useActiveTab` reads the query string, which cannot run during prerender. */
  return (
    <Suspense fallback={<LoadingBlock />}>
      <AttendanceScreen />
    </Suspense>
  );
}
