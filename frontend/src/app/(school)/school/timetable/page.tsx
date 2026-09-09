'use client';

/**
 * Timetable — SRS §20.1, §33's "Timetable", checklist row 4.4.
 *
 * Built to the shape of the exemplar at `(platform)/super-admin/schools/page.tsx`: one
 * `useCollection`, one `Column[]`, the four-state render in refusal → error → loading → empty →
 * table order, and `Pagination`. Only the parts that are genuinely different from the exemplar are
 * commented below; the parts that are the same are the same on purpose.
 *
 * ## Why this screen is a flat list and not a week grid
 *
 * §20.1 names a **Class Timetable** and a **Teacher Timetable**, and the API gives each its own
 * endpoint (`GET /timetable/class/:classId`, `GET /timetable/teacher/:teacherId`) which returns the
 * whole week unpaginated, deliberately — `timetable.service.js:431` says half a timetable is worse
 * than none. This screen is the third endpoint, `GET /timetable`, which is the paginated *register*
 * of every slot in the school. Pivoting a page of 20 rows into a grid would draw a week with holes
 * in it wherever the page boundary fell, which is exactly the failure those two views avoid by
 * refusing to paginate. So the register is rendered as a register, and the grid belongs to the two
 * per-class and per-teacher screens.
 *
 * ## The module gate is not checked here
 *
 * `timetable.routes.js` mounts `requireModule(MODULES.TIMETABLE)` at router level, so a school whose
 * plan omits the module gets a 403 `MODULE_NOT_SUBSCRIBED`. `useCollection` classifies that as a
 * *refusal* rather than an error and `RefusalNotice` explains it. Testing the entitlement snapshot
 * here as well would put a second, client-side copy of the rule next to the server's — and a copy
 * that disagreed would either hide a screen the plan covers or promise one it does not. No plan name
 * is compared against a literal anywhere on this screen (SRS §30 Rule 1); the only thing that decides
 * is the server's answer.
 */

import Link from 'next/link';
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

export default function TimetablePage() {
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
   * another collection (`/classes`, `/subjects`, `/teachers`, `/academic-sessions`) and a bare
   * numeric input asking an administrator for "class 7" would be worse than no control at all.
   * `school_id` is omitted on purpose: this surface is one school, `tenantWhere` already scopes the
   * query to it, and naming a school here is how a request ends up refused with
   * `SCHOOL_CONTEXT_REQUIRED` or pointed at a school the caller does not hold.
   *
   * **No `sortBy` is sent, and that is a decision rather than an omission.** `getSort`
   * (`utils/pagination.js:35-43`) defaults `sortOrder` to `DESC` for anything that is not exactly
   * `asc`, so sending `sortBy=day_of_week` without a direction would hand back the week backwards,
   * Sunday first. Sending nothing lets the route's own fallback — `['day_of_week', 'ASC']` — stand,
   * which is the natural week. Whoever adds a sort control here must send `sortOrder` with it.
   */
  const query = useMemo(
    () => ({
      page,
      limit: 20,
      q: debounced || undefined,
      day_of_week: day || undefined,
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
        /*
         * `first_name` and `last_name` are the two attributes the include actually selects, joined
         * here rather than assuming a `name` column the query never asked for. `employee_id` is
         * selected too but is not shown: it is the payroll key, and a timetable is read by name.
         */
        cell: (row) => {
          if (!row.teacher) return NONE;
          const name = `${row.teacher.first_name} ${row.teacher.last_name ?? ''}`.trim();
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
      <PageHeader
        title="Timetable"
        description="Every scheduled period in the school. A single class or teacher’s week is on their own timetable."
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
            <a
              href="/school/timetable/new"
              className="btn btn-primary"
            >
              Add entry
            </a>
          ) : null
        }
      />

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
