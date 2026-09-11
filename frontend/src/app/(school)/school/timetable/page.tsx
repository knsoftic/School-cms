'use client';

/**
 * Timetable — SRS §20.1, §33's "Timetable", checklist row 4.4.
 *
 * The register tab is built to the shape of the exemplar at `(platform)/super-admin/schools/page.tsx`:
 * one `useCollection`, one `Column[]`, the four-state render in refusal → error → loading → empty →
 * table order, and `Pagination`. Only the parts that are genuinely different from the exemplar are
 * commented below; the parts that are the same are the same on purpose.
 *
 * ## One table, three questions, three tabs
 *
 * §20.1 names a **Class Timetable** and a **Teacher Timetable**, and FR-TT-001's outcome is that
 * "class and teacher timetables are established". The API gives each its own endpoint
 * (`GET /timetable/class/:classId`, `GET /timetable/teacher/:teacherId`), which returns the whole
 * week unpaginated, deliberately — `classView()`'s docblock in `timetable.service.js` says half a
 * timetable is worse than none. The third endpoint, `GET /timetable`, is the paginated *register* of
 * every slot in the school.
 *
 * So the register is rendered as a register, and the two named views as grids. Pivoting a page of 20
 * register rows into a grid would draw a week with holes in it wherever the page boundary fell, which
 * is exactly the failure the two views avoid by refusing to paginate; a week read from one of them is
 * whole, so it can be laid out as days × periods with no blank that is not a free period. Until now
 * both endpoints were mounted and nothing in the frontend called them.
 *
 * ## Who is offered which tab
 *
 * `timetable.view` reaches almost every role, students and parents included, and reading a week needs
 * nothing more. *Choosing* whose week does: the class picker is `GET /classes` (`classes.view`) and
 * the teacher picker `GET /teachers` (`teachers.view`, plus the Teachers module `teachers.routes.js`
 * mounts on itself). Each tab is offered only to a caller holding the key its picker needs — a parent
 * holding `timetable.view` alone would otherwise be shown two pickers that could only fail. A module
 * refusal on the teacher list still reaches its tab, in words.
 *
 * ## The module gate is not checked here
 *
 * `timetable.routes.js` mounts `requireModule(MODULES.TIMETABLE)` at router level, so a school whose
 * plan omits the module gets a 403 `MODULE_NOT_SUBSCRIBED`. `useCollection` classifies that as a
 * *refusal* rather than an error — the two week views sort it by the same `EXPLAINED_CODES` — and
 * `RefusalNotice` explains it. Testing the entitlement snapshot here as well would put a second,
 * client-side copy of the rule next to the server's — and a copy that disagreed would either hide a
 * screen the plan covers or promise one it does not. No plan name is compared against a literal
 * anywhere on this screen (SRS §30 Rule 1); the only thing that decides is the server's answer.
 */

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EXPLAINED_CODES, useCollection } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import {
  sessionNames,
  teacherName,
  useClassSections,
  useList,
  useWholeList,
} from '@/lib/useTimetablePickers';
import type { SessionOption, TeacherOption } from '@/lib/useTimetablePickers';
import {
  SearchField,
  FilterBar,
  FilterSelect,
  Notice,
} from '@/components/form';
import { TabPanel, Tabs, useActiveTab } from '@/components/tabs';
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
 * One row of `timetables`, plus the four associations the list query includes.
 *
 * `timetable.controller.js` has no `present()` — `list` hands `service.list()`'s rows straight to
 * `ApiResponse.paginated` — so the wire shape is the model's columns as `timetable.service.js:321`
 * includes them. The four nested objects carry only the attributes named there: no more fields are
 * available on them than are typed here, and asking for one would get `undefined`.
 *
 * The associations are optional in the type even though the include is unconditional, because three
 * of the four foreign keys are nullable (`section_id`, `subject_id`, `teacher_id`) and a LEFT JOIN
 * on a null key yields `null`. Typing them as always-present would be a lie the compiler would then
 * help us tell.
 */
interface TimetableEntry {
  id: number;
  class_id: number;
  section_id: number | null;
  subject_id: number | null;
  teacher_id: number | null;
  day_of_week: string;
  period_number: number;
  period_label: string | null;
  start_time: string;
  end_time: string;
  room: string | null;
  is_break: boolean;
  is_active: boolean;
  class?: { id: number; name: string } | null;
  section?: { id: number; name: string } | null;
  subject?: { id: number; name: string; code: string | null } | null;
  teacher?: { id: number; employee_id: string | null; first_name: string; last_name: string | null } | null;
}

/**
 * The seven values of the `day_of_week` ENUM, in the order the column declares them.
 *
 * Copied from `config/constants.js:511-519` rather than derived, the way the library screen copies
 * the loan statuses — the frontend is a separate package and cannot import the backend's constants.
 * The order matters: `day_of_week` is a MySQL ENUM and MySQL sorts an ENUM by *declaration* order,
 * which is what makes the server's default `['day_of_week', 'ASC']` produce a real week rather than
 * `friday, monday, saturday…`. Listing them in a different order here would make the filter read
 * differently from the table it filters.
 */
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Shared placeholder for a column that has no value, rather than an empty cell that reads as a bug. */
const NONE = <span className="text-muted-soft">—</span>;

/**
 * `HH:MM:SS` → `HH:MM`.
 *
 * `start_time` and `end_time` are MySQL `TIME` columns and always read back with seconds attached:
 * `timetable.validation.js` says a value written as `'09:30'` returns `'09:30:00'` on every read
 * after the first, and the service normalises to `HH:MM:SS` on the way in so that the row and the
 * response agree. The seconds are therefore always `:00` and cost a third of the column's width to
 * say nothing. The regex guard means an unexpected value (a duration over 24 hours, which the `TIME`
 * type does permit) is shown whole rather than silently truncated into a different, plausible time.
 */
function clock(value: string): string {
  return /^\d{2}:\d{2}:\d{2}$/.test(value) ? value.slice(0, 5) : value;
}

/** `monday` → `Monday`. The ENUM is stored lower-case; a column header's worth of days should not be. */
function dayLabel(day: string): string {
  return day.charAt(0).toUpperCase() + day.slice(1);
}

/**
 * The teacher on an entry, by name, or null.
 *
 * `first_name` and `last_name` are the two attributes the include actually selects, joined here
 * rather than assuming a `name` column the query never asked for. `employee_id` is selected too but
 * is not shown: it is the payroll key, and a timetable is read by name.
 */
function entryTeacher(entry: TimetableEntry): string | null {
  if (!entry.teacher) return null;
  return `${entry.teacher.first_name} ${entry.teacher.last_name ?? ''}`.trim() || null;
}

/* ─────────────────────────────── the register ─────────────────────────────── */

function RegisterPanel() {
  const { can } = useAuth();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [day, setDay] = useState('');
  const [activity, setActivity] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      /* Searching from page four and staying there shows an empty table for a query with results. */
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  /**
   * Only the parameters `schemas.list` actually declares, and only three of the eleven it does.
   *
   * The full set is `page`, `limit`, `sortBy`, `sortOrder`, `q`, `school_id`, `class_id`,
   * `section_id`, `subject_id`, `teacher_id`, `academic_session_id`, `day_of_week`, `period_number`,
   * `room` and `is_active` (`timetable.validation.js` `list`, via `listQuery`). Anything else is
   * dropped by `validate()`'s `stripUnknown`, so a misspelled filter would not fail loudly — it
   * would silently return the unfiltered list, which is why these are read from the schema rather
   * than guessed.
   *
   * Three are wired to controls. The six id filters are not, because each needs a picker fed by
   * another collection (`/classes`, `/subjects`, `/teachers`, `/sessions`) and a bare numeric input
   * asking an administrator for "class 7" would be worse than no control at all.
   * `school_id` is omitted on purpose: this surface is one school, `tenantWhere` already scopes the
   * query to it, and naming a school here is how a request ends up refused with
   * `SCHOOL_CONTEXT_REQUIRED` or pointed at a school the caller does not hold.
   *
   * **The order.** With no `sortBy`, `list()` falls back to its own `WEEK_ORDER` — day, then period,
   * then id — as the class and teacher views do, so the unfiltered week reads in order. (It used to
   * fall back to `day_of_week` alone, and within a day the periods came in the order they were
   * typed; `verify-timetable.js` now asserts the week order.)
   *
   * With a **day chosen**, `period_number` ascending is sent as well, which is the same order for a
   * single day and keeps this screen right against an API that sorted by one column. `sortOrder`
   * travels with it because `getSort` reads anything other than `asc` as `DESC`
   * (`utils/pagination.js:37`) — a `sortBy` alone would hand the day back last period first.
   */
  const query = useMemo(
    () => ({
      page,
      limit: 20,
      q: debounced || undefined,
      day_of_week: day || undefined,
      sortBy: day ? 'period_number' : undefined,
      sortOrder: day ? ('asc' as const) : undefined,
      /*
       * `is_active` is a `Joi.boolean()` and `validate()` runs with `convert: true`, so the string
       * the `<select>` produces is coerced server-side. Sent as a string because `Query`'s index
       * signature is `string | number | undefined` — a raw boolean would not type-check, and
       * `URLSearchParams` would stringify it to the same thing anyway.
       */
      is_active: activity || undefined,
    }),
    [page, debounced, day, activity]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<TimetableEntry>(
    '/timetable',
    query
  );

  /* `timetable.manage` is what `PATCH /timetable/:id` is mounted behind. */
  const canManage = can('timetable.manage');

  const columns = useMemo<Column<TimetableEntry>[]>(() => {
    const base: Column<TimetableEntry>[] = [
      {
        key: 'day',
        header: 'Day',
        cell: (row) => <span className="whitespace-nowrap">{dayLabel(row.day_of_week)}</span>,
      },
      {
        key: 'period',
        header: 'Period',
        /*
         * Three facts about the slot in one column, because they are one fact to the reader.
         *
         * `period_number` is the authoritative one: all three of FR-TT-002's conflict indexes key on
         * it and none keys on the clock, so it is the number that decides whether two entries clash.
         * `period_label` is the school's own name for that number ("Assembly", "Period 3") and is
         * null more often than not, so it earns a suffix rather than a column of blanks.
         *
         * The `inactive` badge is here rather than in a column of its own, and it has to be visible
         * somewhere: `timetable.service.js:49-55` is explicit that **`is_active: false` does not
         * free a slot** — `timetables_section_day_period_unique` counts retired rows too. An
         * administrator who could not see the retired entry would try to schedule over it and get a
         * 409 naming a row that, as far as this screen ever showed, did not exist. The slot is what
         * the retired row still holds, so the warning belongs beside the slot's number.
         */
        cell: (row) => (
          <span className="whitespace-nowrap">
            <span className="tabular-nums">{row.period_number}</span>
            {row.period_label ? <span className="text-muted"> · {row.period_label}</span> : null}
            {row.is_active ? null : (
              <span className="ml-2">
                <StatusBadge status="inactive" />
              </span>
            )}
          </span>
        ),
      },
      {
        key: 'time',
        header: 'Time',
        /*
         * One column, not two. Start and end are never read apart — a period is an interval — and
         * the model's `timeOrdered` validator guarantees the end is after the start, so the range
         * can be printed without checking that it reads forwards.
         */
        cell: (row) => (
          <span className="whitespace-nowrap tabular-nums">
            {clock(row.start_time)}–{clock(row.end_time)}
          </span>
        ),
      },
      {
        key: 'class',
        header: 'Class',
        /*
         * The included `class` and `section` rows, never `class_id` / `section_id`. "class_id: 7"
         * is unreadable, and the service includes both names precisely so it need not be shown.
         *
         * A **null section is not missing data** — `timetable.service.js:64` gives it a meaning:
         * the whole class sits this period. Rendering it as an em-dash would read as an entry
         * nobody had finished filling in, when it is in fact the broadest possible assignment and
         * the one that collides with every section of the class (`assertNoConflict`'s period rule).
         * So it is spelled out.
         *
         * The `class #id` fallback exists only for the impossible case — `class_id` is NOT NULL with
         * `onDelete: CASCADE`, so a row without its class should not survive — and shows the id
         * rather than crashing on an optional chain that returned nothing.
         */
        cell: (row) => (
          <span className="whitespace-nowrap">
            {row.class ? row.class.name : <span className="text-muted-soft">class #{row.class_id}</span>}
            {row.section ? (
              <span className="text-muted"> · {row.section.name}</span>
            ) : (
              <span className="text-muted-soft"> · all sections</span>
            )}
          </span>
        ),
      },
      {
        key: 'subject',
        header: 'Subject',
        /*
         * `is_break` lives here instead of in a boolean column of its own. A break "occupies a slot
         * but needs no subject or teacher" (the model's own words), so on a break row this cell
         * would otherwise be empty — and an empty subject is the one thing the model's
         * `teachingSlotNeedsSubject` validator refuses, which would make a blank read as corruption
         * rather than as lunch. Saying "Break" fills the gap with the reason for it, and spares a
         * whole column that would be "no" on nine rows in ten.
         *
         * A non-break row with no subject is possible despite that validator: `subject_id` is
         * `onDelete: SET NULL`, so deleting a subject nulls it on rows already written, and model
         * validators do not run on other rows' behalf. That case gets the em-dash, honestly.
         */
        cell: (row) => {
          if (row.is_break) return <span className="text-muted-soft">Break</span>;
          if (!row.subject) return NONE;
          return (
            <span className="whitespace-nowrap">
              {row.subject.name}
              {row.subject.code ? <code className="ml-1 text-xs text-muted-soft">{row.subject.code}</code> : null}
            </span>
          );
        },
      },
      {
        key: 'teacher',
        header: 'Teacher',
        /* Joined by `entryTeacher`, which the week grids share — see there for which columns. */
        cell: (row) => {
          const name = entryTeacher(row);
          return name ? <span className="whitespace-nowrap">{name}</span> : NONE;
        },
      },
      {
        key: 'room',
        header: 'Room',
        /* One of FR-TT-002's three conflict axes, so it stays visible even though it is often null. */
        cell: (row) => row.room ?? NONE,
      },
    ];

    /*
     * The way into the entry, and until now there was none.
     *
     * `PATCH /timetable/:id` had no caller anywhere in the frontend and there is no DELETE at all, so
     * a wrongly-scheduled period could neither be corrected nor replaced: the unique key
     * `timetables_section_day_period_unique` kept the slot claimed, and the second attempt 409'd
     * against a row nobody could reach.
     */
    if (!canManage) return base;

    return [
      ...base,
      {
        key: 'actions',
        header: 'Actions',
        cell: (row) => (
          <Link href={`/school/timetable/${row.id}`} className="btn btn-ghost btn-sm">
            Edit
          </Link>
        ),
      },
    ];
  }, [canManage]);

  return (
    <div>
      <FilterBar
        activeCount={[activity, day, search].filter(Boolean).length}
        onClear={() => {
          setActivity('');
          setDay('');
          setSearch('');
          setPage(1);
        }}
      >
        <div>
          {/*
            * The placeholder names exactly the two columns `q` searches. `timetable.service.js:338`
            * builds the LIKE over `period_label` and `room` and nothing else — not the teacher, not
            * the subject, both of which are joined tables the filter never touches. A box promising
            * "search" in general would send an administrator hunting for a teacher by name and
            * conclude from the empty table that the teacher has no lessons.
            */}
          <SearchField
            id="timetable-search"
            label="Search periods and rooms"
            placeholder="Period label or room…"
            value={search}
            onChange={setSearch}
          />
        </div>

        <div>
          <FilterSelect
            id="timetable-day"
            label="Day of the week"
            value={day}
            onChange={(value) => {
              setDay(value);
              setPage(1);
            }}
          >
            <option value="">Every day</option>
            {WEEKDAYS.map((weekday) => (
              <option key={weekday} value={weekday}>
                {dayLabel(weekday)}
              </option>
            ))}
          </FilterSelect>
        </div>

        <div>
          {/*
            * Defaults to showing everything, which is the unusual choice and the deliberate one.
            * A retired entry still claims its `(section, day, period)` slot, so filtering it out by
            * default would hide precisely the rows that explain a scheduling refusal. "Active only"
            * is available for reading the live plan; it is not the default.
            */}
          <FilterSelect
            id="timetable-activity"
            label="Entry state"
            value={activity}
            onChange={(value) => {
              setActivity(value);
              setPage(1);
            }}
          >
            <option value="">Active and retired</option>
            <option value="true">Active only</option>
            <option value="false">Retired only</option>
          </FilterSelect>
        </div>
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
            * Three messages, because "nothing found" answers a different question each time: a
            * search that missed, a filter that excluded everything, or a school that has not built
            * a timetable yet. The last one is the only one where "add an entry" is the next step.
            */}
          {debounced
            ? `No period matches “${debounced}”.`
            : day || activity
              ? 'No timetable entry matches these filters.'
              : 'No timetable entries have been scheduled yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption="Timetable entries"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}

/* ─────────────────────────────── §20.1's two named views ─────────────────────────────── */

/**
 * What one slot of a week grid says.
 *
 * The same four associations the register's columns read, folded into one cell. Which of them is
 * worth a line depends on the question: a class's week names the teacher, and — since one period of
 * a class can hold one entry per section — the section; a teacher's week names the class. The subject
 * line follows the register's rule: a break says "Break", and a lesson whose subject was deleted from
 * under it (`SET NULL`) says so rather than going blank.
 *
 * The retired badge is kept for the register's reason: `is_active: false` does not free the slot.
 */
function SlotEntry({ entry, kind }: { entry: TimetableEntry; kind: 'class' | 'teacher' }) {
  const teacher = entryTeacher(entry);
  const where =
    kind === 'class'
      ? [entry.section ? entry.section.name : 'whole class', teacher]
      : [
          entry.class ? entry.class.name : `class #${entry.class_id}`,
          entry.section ? entry.section.name : 'all sections',
        ];

  return (
    <div>
      <p className="font-medium text-ink">
        {entry.is_break ? (
          <span className="text-muted">Break</span>
        ) : entry.subject ? (
          entry.subject.name
        ) : (
          <span className="text-muted-soft">No subject</span>
        )}
        {entry.period_label ? (
          <span className="font-normal text-muted"> · {entry.period_label}</span>
        ) : null}
      </p>
      <p className="text-xs text-muted">{where.filter(Boolean).join(' · ')}</p>
      <p className="text-xs tabular-nums text-muted-soft">
        {clock(entry.start_time)}–{clock(entry.end_time)}
        {entry.room ? ` · ${entry.room}` : ''}
      </p>
      {entry.is_active ? null : (
        <span className="mt-1 inline-block">
          <StatusBadge status="inactive" />
        </span>
      )}
    </div>
  );
}

/**
 * One week, read from one of the two named views and laid out as days × periods.
 *
 * ## One request per mount
 *
 * The parent keys this component on whose week it shows, so a new choice mounts a fresh grid rather
 * than dimming the previous class's week under a caption that already names the next one. The four
 * states are kept by hand, as `classes/sections` keeps them for the same reason: `useCollection`
 * reads the paginated envelope, and these two answer `ApiResponse.ok(res, { timetable })`.
 *
 * Both calls are written out rather than built from a path variable. `verify-frontend.js` finds a
 * caller by `api.get(` followed immediately by the literal, and a path assembled elsewhere reads as
 * no caller at all — the trap `attendance/mark` fell into with a ternary inside the call.
 *
 * ## Days and periods come from the week, not from a template
 *
 * Only the days that hold an entry get a column, in the ENUM's own order — which days a school
 * teaches is its business, and a fixed Monday-to-Friday frame would draw an empty Friday for a school
 * that teaches Sunday to Thursday and leave its Sunday off the end. Rows are the period numbers that
 * appear, in order: `period_number` is what the conflict checks key on and the clock is descriptive
 * (the service header), so a row is a period and each entry carries its own times. A blank cell is a
 * free period.
 *
 * Below `md` the grid becomes one card per day, the rule `DataTable` keeps for every list: a
 * seven-column grid on a 375px screen is a scrollbar, not a timetable.
 */
function WeekGrid({
  kind,
  id,
  sectionId = '',
  caption,
  empty,
}: {
  kind: 'class' | 'teacher';
  id: string;
  sectionId?: string;
  caption: string;
  empty: string;
}) {
  const [entries, setEntries] = useState<TimetableEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);

    (async () => {
      try {
        /*
         * `section_id` is the one filter used. With it, `classView()` returns that section's periods
         * *and* the class-wide ones, because a whole-class period is that section's too — the rule
         * `assertNoConflict()` enforces, read instead of written. `is_active` is left unset so a
         * retired entry still shows where it holds its slot, as on the register by default.
         */
        const body =
          kind === 'class'
            ? await api.get<{ timetable: { entries: TimetableEntry[] } }>(`/timetable/class/${id}`, {
                query: { section_id: sectionId || undefined },
                signal: controller.signal,
              })
            : await api.get<{ timetable: { entries: TimetableEntry[] } }>(`/timetable/teacher/${id}`, {
                signal: controller.signal,
              });
        if (controller.signal.aborted) return;
        setEntries(body.timetable?.entries ?? []);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setEntries([]);
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          setError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [kind, id, sectionId, attempt]);

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (error) return <ErrorNotice message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (loading) return <LoadingBlock label="Loading the week…" />;
  if (entries.length === 0) return <EmptyNotice icon="calendar">{empty}</EmptyNotice>;

  const days = WEEKDAYS.filter((day) => entries.some((entry) => entry.day_of_week === day));
  const periods = [...new Set(entries.map((entry) => entry.period_number))].sort((a, b) => a - b);
  /* Every entry in one `(day, period)` — several in a class's week, one per section. */
  const slots = new Map<string, TimetableEntry[]>();
  for (const entry of entries) {
    const key = `${entry.day_of_week}|${entry.period_number}`;
    slots.set(key, [...(slots.get(key) ?? []), entry]);
  }
  const slot = (day: string, period: number) => slots.get(`${day}|${period}`) ?? [];

  return (
    <>
      {/* The grid from `md` up. Same header styling as `DataTable`, so the two tabs read alike. */}
      <div
        className="table-scroll surface hidden md:block"
        tabIndex={0}
        role="region"
        aria-label={caption}
      >
        <table className="data-table w-full min-w-max text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border">
              <th
                scope="col"
                className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-muted"
              >
                Period
              </th>
              {days.map((day) => (
                <th
                  key={day}
                  scope="col"
                  className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-muted"
                >
                  {dayLabel(day)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-soft">
            {periods.map((period) => (
              <tr key={period}>
                <th scope="row" className="px-4 py-3 text-left align-top font-semibold tabular-nums text-ink">
                  {period}
                </th>
                {days.map((day) => (
                  <td key={day} className="px-4 py-3 align-top">
                    {/* The width bound sits on a block, not the cell: CSS 2.1 §10.4 leaves `max-width`
                        on a table cell undefined, and one long period label would widen the day. */}
                    <div className="max-w-56">
                      {slot(day, period).length === 0 ? (
                        <>
                          <span aria-hidden className="text-muted-soft">—</span>
                          <span className="sr-only">Free period</span>
                        </>
                      ) : (
                        <ul className="space-y-2.5">
                          {slot(day, period).map((entry) => (
                            <li key={entry.id}>
                              <SlotEntry entry={entry} kind={kind} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* One card per day below `md`, free periods left out rather than drawn as dashes. */}
      <ul className="space-y-2 md:hidden" aria-label={caption}>
        {days.map((day) => (
          <li key={day} className="surface p-3.5">
            <p className="text-sm font-semibold text-ink">{dayLabel(day)}</p>
            <ol className="mt-2.5 space-y-2.5">
              {periods
                .filter((period) => slot(day, period).length > 0)
                .map((period) => (
                  <li key={period} className="flex gap-3">
                    <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-soft">
                      <span className="sr-only">Period </span>
                      {period}
                    </span>
                    <ul className="min-w-0 flex-1 space-y-2">
                      {slot(day, period).map((entry) => (
                        <li key={entry.id}>
                          <SlotEntry entry={entry} kind={kind} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
            </ol>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * §20.1's Class Timetable — choose a class, and optionally one of its sections.
 *
 * The class and section lists come from `useClassSections`, the same hook the create and edit forms
 * use, with the class list read past its first page. It is enabled unconditionally because this tab
 * is only offered to a caller holding `classes.view` (see the header). The section is cleared when the
 * class changes: `classView()` refuses a section of another class through `loadSectionOfClass`.
 *
 * Each class option names its session, as the admission and homework forms label theirs — "Grade 5"
 * exists once a year. The session list is asked for only by a caller who can read it; for anyone
 * else the option is the bare name.
 */
function ClassWeekPanel() {
  const { can } = useAuth();
  const [classId, setClassId] = useState('');
  const [sectionId, setSectionId] = useState('');

  const { classes: firstClasses, sections } = useClassSections(classId, true);
  const classes = useWholeList('/classes', firstClasses);
  const firstSessions = useList<SessionOption>('/sessions', can('sessions.view'));
  const sessions = useWholeList('/sessions', firstSessions);
  const classSessions = sessionNames(sessions);

  const chosen =
    classes.state === 'ready' ? classes.rows.find((row) => String(row.id) === classId) : undefined;
  const section =
    sections.state === 'ready' ? sections.rows.find((row) => String(row.id) === sectionId) : undefined;
  const title = chosen ? `${chosen.name}${section ? `, section ${section.name}` : ''}` : '';

  return (
    <>
      <FilterBar>
        <FilterSelect
          id="week-class"
          label="Class"
          labelVisible
          value={classId}
          onChange={(value) => {
            setClassId(value);
            setSectionId('');
          }}
          disabled={classes.state !== 'ready' || classes.rows.length === 0}
          className="sm:min-w-64"
        >
          <option value="">{classes.state === 'loading' ? 'Loading…' : 'Choose a class…'}</option>
          {classes.state === 'ready'
            ? classes.rows.map((row) => {
                const session =
                  row.academic_session_id === null
                    ? undefined
                    : classSessions.get(row.academic_session_id);
                return (
                  <option key={row.id} value={row.id}>
                    {row.name}
                    {row.code ? ` (${row.code})` : ''}
                    {session ? ` · ${session}` : ''}
                    {row.is_active ? '' : ' · inactive'}
                  </option>
                );
              })
            : null}
        </FilterSelect>

        <FilterSelect
          id="week-section"
          label="Section"
          labelVisible
          value={sectionId}
          onChange={setSectionId}
          disabled={!classId || sections.state !== 'ready' || sections.rows.length === 0}
        >
          {/* The empty option says why the select is disabled, so a greyed-out control is never silent. */}
          <option value="">
            {!classId
              ? 'Choose a class first'
              : sections.state === 'loading'
                ? 'Loading…'
                : sections.state === 'failed'
                  ? 'Sections could not be loaded'
                  : sections.rows.length === 0
                    ? 'This class has no sections'
                    : 'Every section'}
          </option>
          {sections.state === 'ready'
            ? sections.rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                  {row.is_active ? '' : ' · inactive'}
                </option>
              ))
            : null}
        </FilterSelect>
      </FilterBar>

      {classes.state === 'ready' && classes.total > classes.rows.length ? (
        <p className="-mt-2 mb-4 text-sm text-muted">
          Showing the first {classes.rows.length} of {classes.total} classes.
        </p>
      ) : null}
      {section ? (
        <p className="-mt-2 mb-4 text-sm text-muted">
          Whole-class periods are included: a period set for the whole class is this section&rsquo;s
          period too.
        </p>
      ) : null}

      {classes.state === 'failed' ? (
        <Notice tone="error">
          The class list could not be loaded, so a class cannot be chosen here. Reload the page to
          try again.
        </Notice>
      ) : classes.state === 'ready' && classes.rows.length === 0 ? (
        <EmptyNotice>This school has no classes yet, so there is no class timetable to show.</EmptyNotice>
      ) : !chosen ? (
        <EmptyNotice icon="calendar">Choose a class to see its week.</EmptyNotice>
      ) : (
        <WeekGrid
          key={`${classId}|${sectionId}`}
          kind="class"
          id={classId}
          sectionId={sectionId}
          caption={`Class timetable: ${title}`}
          empty={
            section
              ? `Nothing is scheduled for ${title}, nor for the whole of ${chosen.name}.`
              : `Nothing is scheduled for ${chosen.name} yet.`
          }
        />
      )}
    </>
  );
}

/**
 * §20.1's Teacher Timetable — the same rows, asked where one teacher is.
 *
 * Enabled unconditionally for the reason `ClassWeekPanel` is: the tab is only offered to a caller
 * holding `teachers.view`. The plan can still refuse it — `teachers.routes.js` mounts
 * `requireModule(MODULES.TEACHERS)` — and that is said in words rather than left as an empty select.
 * Retired teachers are listed and marked: a teacher who has left can still be named on a slot.
 */
function TeacherWeekPanel() {
  const [teacherId, setTeacherId] = useState('');
  const firstTeachers = useList<TeacherOption>('/teachers', true);
  const teachers = useWholeList('/teachers', firstTeachers);

  const chosen =
    teachers.state === 'ready' ? teachers.rows.find((row) => String(row.id) === teacherId) : undefined;

  return (
    <>
      <FilterBar>
        <FilterSelect
          id="week-teacher"
          label="Teacher"
          labelVisible
          value={teacherId}
          onChange={setTeacherId}
          disabled={teachers.state !== 'ready' || teachers.rows.length === 0}
          className="sm:min-w-64"
        >
          <option value="">{teachers.state === 'loading' ? 'Loading…' : 'Choose a teacher…'}</option>
          {teachers.state === 'ready'
            ? teachers.rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {teacherName(row)} ({row.employee_id})
                  {row.is_active ? '' : ' · inactive'}
                </option>
              ))
            : null}
        </FilterSelect>
      </FilterBar>

      {teachers.state === 'ready' && teachers.total > teachers.rows.length ? (
        <p className="-mt-2 mb-4 text-sm text-muted">
          Showing the first {teachers.rows.length} of {teachers.total} teachers by first name.
        </p>
      ) : null}

      {teachers.state === 'failed' ? (
        <Notice tone="error">
          The teacher list could not be loaded, so a teacher cannot be chosen here. Reading it needs
          the &ldquo;View teachers&rdquo; permission and a plan that carries the Teachers module.
        </Notice>
      ) : teachers.state === 'ready' && teachers.rows.length === 0 ? (
        <EmptyNotice>No teachers have been added to this school yet.</EmptyNotice>
      ) : !chosen ? (
        <EmptyNotice icon="calendar">Choose a teacher to see where they teach each period.</EmptyNotice>
      ) : (
        <WeekGrid
          key={teacherId}
          kind="teacher"
          id={teacherId}
          caption={`Teacher timetable: ${teacherName(chosen)}`}
          empty={`${teacherName(chosen)} is not named on any period. A slot joins a teacher’s timetable when the teacher is named on it.`}
        />
      )}
    </>
  );
}

/* ─────────────────────────────── the screen ─────────────────────────────── */

/** What the header says under each tab — each view answers a different question. */
const DESCRIPTIONS: Record<string, string> = {
  register: 'Every scheduled period in the school, Monday first. Choose a day to read it period by period.',
  class: 'One class’s week, day by day and period by period — SRS §20.1’s Class Timetable.',
  teacher: 'Where one teacher is, day by day and period by period — SRS §20.1’s Teacher Timetable.',
};

function TimetableScreen() {
  const { can } = useAuth();

  /* Each week tab only for the caller its picker can serve — see the header. */
  const tabs = useMemo(
    () => [
      { key: 'register', label: 'Register' },
      ...(can('classes.view') ? [{ key: 'class', label: 'Class timetable' }] : []),
      ...(can('teachers.view') ? [{ key: 'teacher', label: 'Teacher timetable' }] : []),
    ],
    [can]
  );
  const [tab, setTab] = useActiveTab(tabs);

  return (
    <div>
      <PageHeader
        title="Timetable"
        description={DESCRIPTIONS[tab]}
        action={
          /*
           * `timetable.manage` exists — `config/permissions.js:129`, granted to Principal, School
           * Admin and Super Admin only, while `timetable.view` reaches almost every role including
           * students and parents. That gap is the reason the button is conditional: this screen is
           * readable by nearly everyone and writable by three roles.
           *
           * Hiding it is a courtesy, not a control. `requirePermission('timetable.manage')` re-reads
           * the permission from the database on the request itself, so a reader who conjured this
           * link would still be refused by Express.
           */
          can('timetable.manage') ? (
            <Link
              href="/school/timetable/new"
              className="btn btn-primary"
            >
              Add entry
            </Link>
          ) : null
        }
      />

      {/* A single tab is no choice, so a caller offered only the register gets it without a tab bar. */}
      {tabs.length > 1 ? (
        <>
          <Tabs tabs={tabs} active={tab} onChange={setTab} label="Timetable views" />
          <TabPanel tabKey={tab}>
            {tab === 'class' ? (
              <ClassWeekPanel />
            ) : tab === 'teacher' ? (
              <TeacherWeekPanel />
            ) : (
              <RegisterPanel />
            )}
          </TabPanel>
        </>
      ) : (
        <RegisterPanel />
      )}
    </div>
  );
}

export default function TimetablePage() {
  /* `useActiveTab` reads the query string, which cannot run during prerender. */
  return (
    <Suspense fallback={<LoadingBlock />}>
      <TimetableScreen />
    </Suspense>
  );
}
