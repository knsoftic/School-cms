'use client';

/**
 * Teachers — SRS §15.3 (FR-TEACHER-001) and §33's "Teachers", checklist row 4.4.
 *
 * The same four moving parts as `super-admin/schools/page.tsx`, which is the exemplar: a
 * `useCollection` call, a `Column[]`, the four-state render, and pagination. What follows is only
 * what is *different* about this endpoint, because everything else was decided there.
 *
 * ## This is the first screen behind a module gate, and that is why `refusal` comes first
 *
 * `teachers.routes.js:55` mounts `requireModule(MODULES.TEACHERS)` on the whole router — the first
 * entitlement guard in the project. A school whose plan omits the Teachers module gets a 403
 * `MODULE_NOT_SUBSCRIBED` from `GET /teachers`, which is not a fault: the request did exactly what it
 * should and retrying will never change the answer. `useCollection` classifies it as a `refusal` and
 * `RefusalNotice` explains it, so the branch order below (refusal → error → loading → empty → table)
 * is load-bearing here in a way it only theoretically was on the platform screens. Checking `error`
 * first would hand a principal on a smaller plan a red banner and a "Try again" button.
 *
 * The module is *not* re-checked in this file. `SCHOOL_NAV` already hides the nav item for a school
 * without the module, and a bookmarked URL is answered by the guard; a second copy of the rule here
 * would be a plan decision made in the client, which is the shape §30 Rule 1 forbids.
 *
 * ## The API returns the raw `teachers` row, so the interface is the allow-list
 *
 * `teachers.controller.js` has **no `present()`** — `list` hands `service.list`'s rows straight to
 * `ApiResponse.paginated`, so every column of the model is in the payload, including `salary`,
 * `notes`, `address`, `metadata` and the never-written `photo_path`. The validation file's own
 * docblock explains the absence: §15.3 names no teacher photo, so the column has no writer and there
 * was no stored path to suppress.
 *
 * "Nothing writes it today" is not a reason to *read* it, so `TeacherRow` below is written from the
 * fields this screen renders and nothing else. That is the same defence `super-admin/users/page.tsx`
 * uses: an allow-list interface means a future session that gives that column a writer cannot make a
 * column here quietly start working. It also keeps `salary` off a list that every holder of
 * `teachers.view` can open — a payroll figure is a `GET /teachers/:id` question, not something to
 * scan a hundred of.
 *
 * ## The service `include`s nothing, so there is no association to render
 *
 * `teachers.service.list()` is a plain `paginateQuery(db.Teacher, { where, order })` — no `include`.
 * The row's one foreign key to a thing with a name, `user_id`, therefore arrives as a bare integer,
 * and a column reading "User 41" tells an administrator nothing. It is never rendered as a number —
 * only as whether the teacher can sign in, which is what decides if "Create login" is offered (the
 * owner's decision D1).
 * Subjects and classes are a real answer to "what does this teacher do", but they live behind
 * `GET /teachers/:id/assignments` and cost a request per row; they belong on the detail screen.
 */

import { useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { useRowAction } from '@/lib/useRowAction';
import { DeactivateDialog, ReactivateDialog } from '@/components/deactivate';
import { CreateLoginDialog } from '@/components/createLogin';
import type { LoginTarget } from '@/components/createLogin';
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
 * One row of `GET /teachers`, narrowed to what this screen shows.
 *
 * Only `id`, `employee_id`, `first_name` and `is_active` are `allowNull: false` on the model
 * (`models/people.js:196-214`); every other field here is nullable and is rendered with a
 * placeholder rather than assumed present.
 *
 * `experience_years` is `DECIMAL(5,2)`, and it arrives as a JS **number** — `7.5`, not `"7.50"`.
 * This comment claimed the opposite, citing MySQL's driver returning DECIMAL as a string "to avoid
 * the precision loss a float round-trip causes". That is true of mysql2 by default and false here:
 * `config/database.js` sets `dialectOptions.decimalNumbers = true`, so the driver parses it before
 * Sequelize sees it.
 *
 * The union is kept anyway, and the reason is worth stating because it is not the one above: it is
 * one line of configuration that decides this, so a type accepting both cannot be broken by flipping
 * it. `Experience` below narrows it once, which is what stops `row.experience_years > 10` from ever
 * being a string comparison either way.
 */
interface TeacherRow {
  id: number;
  employee_id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  specialization: string | null;
  experience_years: number | string | null;
  is_active: boolean;
  /*
   * Read as a yes/no and never rendered as a number — the header's point about "User 41" stands. It is
   * what decides whether "Create login" is offered (the owner's decision D1).
   */
  user_id: number | null;
}

/**
 * The `?is_active=` filter, as a tri-state the URL can carry.
 *
 * The parameter is `Joi.boolean()` (`teachers.validation.js:127`) and `validate()` runs with
 * `convert: true`, so the strings `'true'` and `'false'` are coerced server-side. They are kept as
 * strings rather than booleans on purpose: `useCollection`'s `Query` index signature is
 * `string | number | undefined`, and `buildUrl` drops `undefined`, `null` and `''` before they reach
 * the query string (`apiClient.ts:235`). So the empty value here means "send no filter at all",
 * which is what "All teachers" has to mean — a literal `false` would have been serialised as
 * `is_active=false` and silently hidden every active teacher.
 */
const ACTIVITY_FILTERS = [
  { value: '', label: 'All teachers' },
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
] as const;

/**
 * The teacher's name, composed the way the API composes it for its own audit descriptions.
 *
 * `teachers.controller.js:8-10` joins `[first_name, last_name].filter(Boolean)` — `last_name` is
 * nullable, so a naive `${first} ${last}` renders a trailing space for a mononymous teacher and the
 * word "null" if the JSON round-trip ever hands back the literal. Matching the controller also means
 * the name in this table is the same string that appears in the activity log for that row.
 */
function fullName(row: TeacherRow): string {
  return [row.first_name, row.last_name].filter(Boolean).join(' ');
}

/**
 * Years of experience, as a figure rather than as whatever the driver sent.
 *
 * `Number('7.50')` is `7.5` and `Number('7.00')` is `7`, so `String(Number(v))` drops the storage
 * precision that means nothing to a reader without inventing a rounding rule. The `NaN` guard is not
 * defensive padding: `Number('')` is `0`, and rendering a confident "0 years" for a field nobody
 * filled in is worse than an em dash, so the empty case is caught before the conversion.
 */
function Experience({ value }: { value: number | string | null }) {
  if (value === null || value === undefined || value === '') return <span className="text-muted-soft">—</span>;

  const years = Number(value);
  if (Number.isNaN(years)) return <span className="text-muted-soft">—</span>;

  return <>{String(years)}</>;
}

/** A nullable text cell — an em dash reads as "not recorded", an empty cell reads as a bug. */
function Optional({ value }: { value: string | null }) {
  return value ? <>{value}</> : <span className="text-muted-soft">—</span>;
}

export default function TeachersPage() {
  const { can } = useAuth();

  const [page, setPage] = useState(1);
  const [activity, setActivity] = useState<string>('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      /* Resetting to page one is part of the search: searching from page four and staying there
       * shows an empty table for a query that has three pages of results. */
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  /*
   * 300 ms, for the exemplar's reason and one of this endpoint's own. `apiLimiter` is mounted before
   * authentication, so a request per keystroke spends a real budget — and here `q` becomes three
   * `LIKE '%…%'` predicates ORed together over `first_name`, `last_name` and `employee_id`
   * (`teachers.service.js:203-209`). A leading wildcard cannot use the index on any of them, so each
   * keystroke is three full scans of the school's teacher table.
   */
  const query = useMemo(
    () => ({
      page,
      limit: 20,
      q: debounced || undefined,
      is_active: activity || undefined,
    }),
    [page, debounced, activity]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<TeacherRow>('/teachers', query);

  /* `teachers.manage` is what `PATCH /teachers/:id` is mounted behind. */
  const canManage = can('teachers.manage');
  /* `users.manage` is what `POST /users` is mounted behind — a login is an account, not a profile edit. */
  const canCreateLogin = can('users.manage');
  const [loginFor, setLoginFor] = useState<LoginTarget | null>(null);

  const label = (row: TeacherRow) => [row.first_name, row.last_name].filter(Boolean).join(' ');

  /*
   * `is_active` **and** `left_at`, together, because that is how §15.3 says a departure is recorded.
   * `teachers.validation.js` puts both on the update schema and explains it in its own voice: the
   * SRS names no teacher deletion and no leaving operation, so *"a teacher who leaves is deactivated
   * by an edit"*. Deactivating without the date would lose a fact the school knows; guessing it
   * would invent one. The dialog asks, defaulting to today.
   */
  const deactivate = useRowAction<TeacherRow, string | null>({
    perform: (row, leftAt) => api.patch(`/teachers/${row.id}`, { is_active: false, left_at: leftAt }),
    success: (row) => `${label(row)} deactivated`,
    failure: 'Could not deactivate that teacher',
    onDone: reload,
  });

  const reactivate = useRowAction<TeacherRow>({
    perform: (row) => api.patch(`/teachers/${row.id}`, { is_active: true, left_at: null }),
    success: (row) => `${label(row)} reactivated`,
    failure: 'Could not reactivate that teacher',
    onDone: reload,
  });

  const columns = useMemo<Column<TeacherRow>[]>(() => {
    const base: Column<TeacherRow>[] = [
      {
        key: 'name',
        header: 'Name',
        cell: (row) => <span className="font-medium">{fullName(row)}</span>,
      },
      {
        key: 'employee_id',
        /*
         * The school's own identifier for the person, and unique per school by constraint
         * (`teachers_school_employee_unique`). It earns a column because it is the value an
         * administrator is given when someone else refers to a teacher — on a leave form, a payroll
         * line, an ID card — and it is one of the three fields the search box actually matches.
         */
        header: 'Employee ID',
        cell: (row) => <code className="text-xs text-muted">{row.employee_id}</code>,
      },
      {
        key: 'specialization',
        /*
         * Chosen over `qualification`, which answers nearly the same question at three times the
         * width. `qualification` is `STRING(255)` of free text — "M.Sc. Physics, B.Ed., PhD
         * (Mathematics Education)" is a realistic value and would wrap every row it appeared in,
         * destroying the vertical rhythm that makes a table scannable. `specialization` is
         * `STRING(160)` and is the half of the pair that says what the teacher actually teaches,
         * which is the question being asked of this list.
         */
        header: 'Specialization',
        cell: (row) => <Optional value={row.specialization} />,
      },
      {
        key: 'experience_years',
        header: 'Experience (yrs)',
        /* Right-aligned and tabular, which is the only thing that makes a column of figures
         * comparable at a glance rather than a list of characters. */
        numeric: true,
        cell: (row) => <Experience value={row.experience_years} />,
      },
      { key: 'email', header: 'Email', cell: (row) => <Optional value={row.email} /> },
      { key: 'phone', header: 'Phone', cell: (row) => <Optional value={row.phone} /> },
      {
        key: 'is_active',
        header: 'Status',
        /*
         * **`teachers` has no `status` column.** §15.3 names no teacher deletion and no "leaving"
         * operation, so the module models departure as an edit: `is_active: false`, set through
         * `PATCH /teachers/:id` (`teachers.service.js:104-112`). The flag is also what the plan
         * ceiling counts — `teacher_limit` is a headcount over `is_active: true` — so it is the one
         * boolean on this row an administrator has a reason to scan.
         *
         * Mapped onto the two words `StatusBadge` already tones (`active` green, `inactive` grey)
         * rather than inventing a third state from `left_at`. Every other list on this surface reads
         * its status column the same way, and a teacher list that used a private vocabulary would
         * make the reader learn one badge twice.
         */
        cell: (row) => <StatusBadge status={row.is_active ? 'active' : 'inactive'} />,
      },
      {
        key: 'login',
        header: 'Login',
        cell: (row) =>
          row.user_id ? <span>Can sign in</span> : <span className="text-muted-soft">No login</span>,
      },
    ];

    /*
     * The one lifecycle control this record has, and the login a teacher needs to sign in at all.
     *
     * There is no teacher detail route and §15.3 asks for none. Until now the status column was
     * display-only and `PATCH /teachers/:id` had no caller anywhere in the frontend, so a departing
     * teacher's record stayed active — and `teacher_limit` counts `is_active: true`, so the school
     * could not hire a replacement without buying capacity it was not using.
     */
    if (!canManage && !canCreateLogin) return base;

    return [
      ...base,
      {
        key: 'actions',
        header: 'Actions',
        cell: (row) => (
          <div className="flex gap-1">
            {canManage ? (
              <button
                type="button"
                onClick={() => (row.is_active ? deactivate.ask(row) : reactivate.ask(row))}
                className="btn btn-ghost btn-sm"
              >
                {row.is_active ? 'Deactivate' : 'Reactivate'}
              </button>
            ) : null}
            {canCreateLogin && !row.user_id && row.is_active ? (
              <button
                type="button"
                onClick={() =>
                  setLoginFor({ role: 'teacher', person: fullName(row), profileId: row.id, email: row.email })
                }
                className="btn btn-ghost btn-sm"
              >
                Create login
              </button>
            ) : null}
          </div>
        ),
      },
    ];
  }, [canManage, canCreateLogin, deactivate, reactivate]);

  const filtered = Boolean(debounced || activity);

  return (
    <div>
      <PageHeader
        title="Teachers"
        description="Teaching staff at this school — profile, specialization and contact details."
        action={
          /*
           * Hidden without `teachers.manage`, which is a courtesy rather than a control: the
           * permission is re-read from the database on the request itself, so forcing this link into
           * existence changes nothing about what `POST /teachers` will accept.
           *
           * It is deliberately not a prediction that the create will succeed. `POST /teachers`
           * carries `enforceLimit(LIMITS.TEACHER_LIMIT)` as well as the permission
           * (`teachers.routes.js:71-78`), so a school already at its plan's headcount is refused with
           * `PLAN_LIMIT_EXCEEDED` no matter who is asking. Mirroring that ceiling here would mean
           * fetching the usage snapshot on a screen that has not been asked for it, and then being
           * wrong about it the moment another administrator adds someone. The refusal belongs on the
           * create form, where there is a request to attach it to.
           */
          can('teachers.manage') ? (
            <a
              href="/school/teachers/new"
              className="btn btn-primary"
            >
              Add teacher
            </a>
          ) : null
        }
      />

      {/*
        * Two controls out of the seven parameters `schemas.list` declares, because the other five
        * cannot be operated by a person on this screen.
        *
        * `designation` is matched **exactly** (`where.designation = query.designation`) against a
        * free-text `STRING(120)` with no enumeration anywhere in the source — no constant, no check
        * constraint, nothing to build a `<select>` from. A text box over an exact match is a trap: it
        * returns nothing for "Head Teacher" when the row says "Head teacher", and an empty table is
        * indistinguishable from "no such teacher". A usable control would need a distinct-values
        * endpoint that does not exist.
        *
        * `school_id` is meaningless from the school surface — `tenantWhere()` has already scoped the
        * query to the caller's own school, and `resolveSchool()` refuses any other one.
        *
        * `sortBy`/`sortOrder` are left alone: `DataTable` has no sort affordance, and inventing one
        * in a page would put table interaction outside the shared component. The server's default,
        * `first_name ASC`, is the right one for a list read as a directory.
        *
        * `limit` is fixed rather than exposed, matching every other list in §33.
        */}
      <FilterBar
        activeCount={[activity, search].filter(Boolean).length}
        onClear={() => {
          setActivity('');
          setSearch('');
          setPage(1);
        }}
      >
        <SearchField
          id="teacher-search"
          label="Search teachers"
          placeholder="Search by name or employee ID…"
          value={search}
          onChange={setSearch}
        />

        <FilterSelect
          id="teacher-activity"
          label="Filter by status"
          value={activity}
          onChange={(value) => {
            setActivity(value);
            /* Same reason the search resets: filtering from page four shows an empty table for a
             * filter that has two pages of matches. */
            setPage(1);
          }}
        >
          {ACTIVITY_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </FilterSelect>
      </FilterBar>

      {/*
        * `refusal` before `error`, and both before content — see the header. On this screen the
        * refusal is the likeliest non-success of the three: the module gate refuses every school
        * whose plan omits Teachers, which is a supported state rather than a broken one.
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
            * A filtered empty result and a genuinely empty table read identically otherwise, and
            * their remedies are opposite: clear a filter, or go and add a teacher. The distinction
            * matters more here than on most lists, because "Inactive" is a filter a school with no
            * departures yet will legitimately find empty.
            */}
          {filtered
            ? 'No teacher matches these filters.'
            : 'No teachers have been added to this school yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Teachers"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <DeactivateDialog
        open={deactivate.target !== null}
        person={deactivate.target ? label(deactivate.target) : null}
        noun="teacher"
        allowance="teacher allowance"
        busy={deactivate.busy}
        conflict={deactivate.conflict}
        onCancel={deactivate.cancel}
        onConfirm={(date) => deactivate.confirm(date)}
      />

      <ReactivateDialog
        open={reactivate.target !== null}
        person={reactivate.target ? label(reactivate.target) : null}
        noun="teacher"
        allowance="teacher allowance"
        busy={reactivate.busy}
        conflict={reactivate.conflict}
        onCancel={reactivate.cancel}
        onConfirm={() => reactivate.confirm()}
      />

      <CreateLoginDialog target={loginFor} onClose={() => setLoginFor(null)} onCreated={reload} />
    </div>
  );
}
