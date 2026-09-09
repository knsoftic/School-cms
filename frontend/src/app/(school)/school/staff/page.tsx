'use client';

/**
 * Staff — SRS §15.4 (FR-STAFF-001) and §33's "Staff", checklist row 4.4.
 *
 * The same four moving parts as `super-admin/schools/page.tsx`, which is the exemplar: a
 * `useCollection` call, a `Column[]`, the four-state render, and pagination. What differs is where
 * the response shape comes from and which of its fields are allowed onto the screen.
 *
 * ## This module has no `present()`, so the whole row arrives
 *
 * Every other list screen reads a controller's `present()` to learn what a row carries.
 * `staff.controller.js` has none, and `staff.service.list()` is a bare
 * `paginateQuery(db.Staff, { where, order })` — no `attributes`, no `include`, and
 * `softDeleteOptions` adds no attribute-excluding scope. So the client receives **every column of
 * the `staff` model**, `salary` and `photo_path` included.
 *
 * The service's own docblock explains why nobody added a `present()`: SRS §15.4 names no photo, so
 * `photo_path` has no writer and is permanently null, and there was judged to be no stored path to
 * suppress. That reasoning covers the path and stops there — it is not a statement that the rest of
 * the row is safe to display. `StaffRow` below is therefore written as an **allow-list of the fields
 * this screen chose**, not a transcription of the model. A field absent from the interface cannot be
 * rendered by a later edit without someone first adding it here and having to justify it.
 *
 * `salary` is the field that matters. It is real compensation data and it is in the payload today.
 * `staff.view` is emphatically not a payroll permission: `config/permissions.js` grants it to school
 * leadership (:193), the Organization Admin (:278), and — the case that settles it — the
 * **Librarian** (:366), a role that holds it to look colleagues up and that is granted no finance
 * permission whatsoever. The Accountant is not even among the holders. A salary column would
 * therefore show every wage in the school to the librarian, so the field is absent from the
 * interface; it belongs on a single-record screen behind a narrower permission, if anywhere.
 *
 * ## There is no `status` column on this table
 *
 * §33 lists "status" among the staff fields, but `models/people.js:259` defines
 * `is_active BOOLEAN NOT NULL DEFAULT true` and a nullable `left_at`; there is no status enum here
 * the way `users` and `schools` have one. The Status column is therefore *derived*, and the two
 * words it derives to are chosen to land inside `StatusBadge`'s vocabulary — `active` tones green
 * and `inactive` tones as ended. Inventing a third word would silently fall through to the default
 * grey and read as "unrecognised" rather than as a state.
 *
 * That flag is also the school's headcount: `staff_limit` counts `is_active: true`
 * (`usageService.HEADCOUNT_SOURCES`), which is why deactivating rather than deleting is the whole
 * lifecycle here — §15.4 names no deletion and the router mounts no DELETE.
 *
 * ## The module gate is not this screen's job
 *
 * `staff.routes.js` mounts `requireModule(MODULES.STAFF)` at router level, so a school whose plan
 * omits Staff gets a 403 `MODULE_NOT_SUBSCRIBED` on the list request itself. `useCollection`
 * classifies that as a *refusal* and `RefusalNotice` explains it. Nothing here reads the
 * entitlement snapshot and nothing here compares a plan name against a literal (SRS §30 Rule 1) —
 * the refusal branch simply renders whatever the API refused with.
 */

import { useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { useRowAction } from '@/lib/useRowAction';
import { DeactivateDialog, ReactivateDialog } from '@/components/deactivate';
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
 * One row of `GET /staff` — the seven fields this screen displays, plus the key.
 *
 * Deliberately narrower than the payload. See the file header: the response is an unfiltered
 * `staff` model instance, so `salary`, `photo_path`, `address`, `notes`, `metadata`,
 * `date_of_birth`, `gender`, `qualification`, `user_id` and `left_at` all arrive and are all
 * omitted here on purpose.
 *
 * The nullability is the model's, not a guess: `employee_id`, `category` and `first_name` are
 * `allowNull: false`; `last_name`, `designation`, `email` and `phone` are not.
 */
interface StaffRow {
  id: number;
  employee_id: string;
  category: string;
  first_name: string;
  last_name: string | null;
  designation: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
}

/**
 * SRS §15.4's four categories, as `config/constants.js` `STAFF_CATEGORIES` fixes them.
 *
 * Hardcoded rather than fetched, on the same reasoning the Users screen hardcodes its role slugs:
 * the set is closed by the SRS, it is compiled into the column's ENUM *and* into
 * `staff.validation.js`'s `Joi.valid(...)`, so a fifth value is a 422 rather than an empty result —
 * and a filter that cannot render until a request for four constants resolves is worse than one
 * that renders immediately.
 *
 * The table cell humanises the row's own `category` rather than looking it up here, so a value the
 * database somehow holds that is not in this list still displays instead of blanking.
 */
const CATEGORIES = ['receptionist', 'accountant', 'librarian', 'other_staff'] as const;

/** `other_staff` → `Other staff`. Sentence case, because these are labels and not proper nouns. */
function humanise(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

/** An absent optional field, drawn so it reads as "nothing recorded" rather than as a value. */
function Blank() {
  return <span className="text-muted-soft">—</span>;
}

export default function StaffPage() {
  const { can } = useAuth();

  const [page, setPage] = useState(1);
  const [category, setCategory] = useState('');
  /*
   * Held as a string, not a boolean, and the empty string is a third state — "no filter" — that a
   * boolean cannot express. It is also the shape the wire needs: `Query` values are
   * `string | number | undefined`, so a `true` could not be passed at all, and `validate()` runs
   * Joi with `convert: true` (`middlewares/validate.js:37`), which turns the string `'true'` back
   * into a boolean before `staff.service.list()` reads it.
   */
  const [active, setActive] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      /*
       * Resetting to page one is part of the search, not a separate concern. Searching from page
       * four and staying there shows an empty table for a query that has three pages of results.
       */
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  /*
   * `q` reaches three `LIKE '%…%'` scans on `staff` — `first_name`, `last_name`, `employee_id`
   * (`staff.service.js` `list()`) — and `apiLimiter` is mounted before authentication, so an
   * unthrottled request per keystroke spends a real budget. The exemplar's 300 ms is the same trade
   * for the same reason.
   *
   * Every key below is one the endpoint declares. `staff.validation.js` `list` is
   * `listQuery({ school_id, category, is_active, designation, q })`, and `validate()` runs query
   * strings with `stripUnknown: true` — so anything else would be dropped in transit and the filter
   * would appear to do nothing rather than fail loudly.
   */
  const query = useMemo(
    () => ({
      page,
      limit: 20,
      q: debounced || undefined,
      category: category || undefined,
      is_active: active || undefined,
    }),
    [page, debounced, category, active]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<StaffRow>('/staff', query);

  /* `staff.manage` is the key `PATCH /staff/:id` is mounted behind. Without it the column is not
     rendered at all rather than rendered disabled — a control nobody can use is noise per row. */
  const canManage = can('staff.manage');

  const label = (row: StaffRow) => [row.first_name, row.last_name].filter(Boolean).join(' ');

  /* The leaving date arrives as the `confirm` argument — see `useRowAction` on why not via state. */
  const deactivate = useRowAction<StaffRow, string | null>({
    perform: (row, leftAt) => api.patch(`/staff/${row.id}`, { is_active: false, left_at: leftAt }),
    success: (row) => `${label(row)} deactivated`,
    failure: 'Could not deactivate that record',
    onDone: reload,
  });

  const reactivate = useRowAction<StaffRow>({
    /* `left_at: null` because a person who is active again has no leaving date. */
    perform: (row) => api.patch(`/staff/${row.id}`, { is_active: true, left_at: null }),
    success: (row) => `${label(row)} reactivated`,
    failure: 'Could not reactivate that record',
    onDone: reload,
  });

  const columns = useMemo<Column<StaffRow>[]>(() => {
    const base: Column<StaffRow>[] = [
      {
        key: 'employee_id',
        /*
         * First, because it is the identifier the school issued and therefore the one an
         * administrator is holding when they arrive here — off a payroll line or an ID card. It is
         * also unique per school (`staff_school_employee_unique`) and one of the three fields `q`
         * searches, so it is the column that makes a search result explicable.
         */
        header: 'Employee ID',
        cell: (row) => <code className="text-xs text-muted">{row.employee_id}</code>,
      },
      {
        key: 'name',
        header: 'Name',
        /*
         * Two model columns, one screen column. `last_name` is nullable, so joining on a filtered
         * array avoids the trailing space a template string would leave; this is exactly what
         * `staff.controller.js` `label()` does when it writes an activity description, so the name
         * in the audit log and the name in this table are composed the same way.
         *
         * The default sort is `first_name ASC` (`staff.service.js` `getSort` fallback), which is why
         * the given name leads rather than the surname — a column ordered by a value it does not
         * show first would look unsorted.
         */
        cell: (row) => (
          <span className="font-medium">{[row.first_name, row.last_name].filter(Boolean).join(' ')}</span>
        ),
      },
      {
        key: 'category',
        /* §15.4's defining field — the one the SRS actually enumerates, and the primary filter. */
        header: 'Category',
        cell: (row) => humanise(row.category),
      },
      {
        key: 'designation',
        /*
         * Kept beside Category rather than treated as a duplicate of it. Category is one of four
         * fixed buckets; designation is the free-text job title that separates two people who are
         * both `accountant`. Nullable, and frequently null in practice, hence the placeholder.
         */
        header: 'Designation',
        cell: (row) => row.designation ?? <Blank />,
      },
      { key: 'email', header: 'Email', cell: (row) => row.email ?? <Blank /> },
      {
        key: 'phone',
        header: 'Phone',
        /*
         * `whitespace-nowrap` because a wrapped phone number reads as two numbers. The table already
         * scrolls inside its own container, so widening it costs nothing the page has to absorb.
         */
        cell: (row) => (row.phone ? <span className="whitespace-nowrap">{row.phone}</span> : <Blank />),
      },
      {
        key: 'status',
        header: 'Status',
        /*
         * Derived, not stored — see the file header. `active`/`inactive` are chosen because both sit
         * in `StatusBadge`'s tone map (green and ended-grey); a word outside it would render in the
         * default border and lose the distinction this column exists to make.
         */
        cell: (row) => <StatusBadge status={row.is_active ? 'active' : 'inactive'} />,
      },
    ];

    /*
     * The lifecycle column, and the reason it is the only one.
     *
     * §15.4 names no deletion and `staff.routes.js` mounts no DELETE, so `is_active` is the whole of
     * a staff member's lifecycle — which is what the header above already says. Until now there was
     * nowhere to set it: `PATCH /staff/:id` accepts `is_active` (`staff.validation.js`) and nothing
     * in the frontend issued a PATCH at all.
     *
     * That was not only an inconvenience. `staff_limit` counts `is_active: true`
     * (`usageService.HEADCOUNT_SOURCES`), so a departed member kept consuming a seat and the school
     * met `PLAN_LIMIT_EXCEEDED` on the next hire with no way to free the allowance.
     *
     * Reactivation is offered on the same column, because the mistake this column makes possible is
     * deactivating the wrong person, and a one-way door would turn that into a support request.
     */
    if (!canManage) return base;

    return [
      ...base,
      {
        key: 'actions',
        header: 'Actions',
        cell: (row) => (
          <button
            type="button"
            onClick={() => (row.is_active ? deactivate.ask(row) : reactivate.ask(row))}
            className="btn btn-ghost btn-sm"
          >
            {row.is_active ? 'Deactivate' : 'Reactivate'}
          </button>
        ),
      },
    ];
  }, [canManage, deactivate, reactivate]);

  const filtered = Boolean(debounced || category || active);

  return (
    <div>
      <PageHeader
        title="Staff"
        description="Receptionists, accountants, librarians and other staff employed at this school."
        action={
          /*
           * The button is hidden without the permission — a courtesy, not a control. `staff.manage`
           * exists (`config/permissions.js:97`) and guards `POST /staff`, where it is re-read from
           * the database on the request itself, so a user who forced this button into existence
           * would still be refused by the API.
           *
           * It would also be refused for a second reason this button cannot predict: `POST /staff`
           * carries `enforceLimit('staff_limit')`, so a school at its ceiling is turned away with
           * `PLAN_LIMIT_EXCEEDED` even holding the permission. Matching that here would mean
           * reading the usage snapshot to grey out a link, which puts a copy of the limit rule in
           * the UI; the create screen is the honest place to report it.
           */
          can('staff.manage') ? (
            <a
              href="/school/staff/new"
              className="btn btn-primary"
            >
              Add staff member
            </a>
          ) : null
        }
      />

      {/*
        * Three controls out of the five filters the endpoint declares.
        *
        * `school_id` gets none: this is the school surface, `tenantWhere(req.tenant, {})` has
        * already narrowed the query to the caller's school, and the parameter exists for a platform
        * caller naming a school from outside. A box a principal types "7" into filters nothing they
        * can reach.
        *
        * `designation` gets none either, and that one is a near miss worth recording.
        * `staff.service.list()` applies it as `where.designation = query.designation` — an exact
        * match, not the `LIKE` that `q` uses — so a text box would return nothing for "Senior
        * Accountant" when the row says "Senior accountant", and the user would read that as "there
        * are none" rather than "you typed it differently". A select would need the distinct values,
        * which no endpoint exposes. Better absent than quietly wrong; the column still shows it.
        *
        * `sortBy`/`sortOrder` are left alone because `DataTable` has no sort affordance, and
        * inventing one in a page would put table interaction outside the shared component.
        */}
      <FilterBar
        activeCount={[active, category, search].filter(Boolean).length}
        onClear={() => {
          setActive('');
          setCategory('');
          setSearch('');
          setPage(1);
        }}
      >
        <SearchField
          id="staff-search"
          label="Search staff"
          placeholder="Search by name or employee ID…"
          value={search}
          onChange={setSearch}
        />

        <FilterSelect
          id="staff-category"
          label="Filter by category"
          value={category}
          onChange={(value) => {
            setCategory(value);
            /* Same reason the search resets: filtering from page four shows an empty table for a
             * filter that has two pages of matches. */
            setPage(1);
          }}
        >
          <option value="">All categories</option>
          {CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {humanise(value)}
            </option>
          ))}
        </FilterSelect>

        <FilterSelect
          id="staff-active"
          label="Filter by employment status"
          value={active}
          onChange={(value) => {
            setActive(value);
            setPage(1);
          }}
        >
          {/*
            * "All" is the default rather than "Current", even though a directory is usually about
            * people who still work here. Defaulting to a filter would mean the unfiltered count in
            * the pagination footer never matches the school's actual staff record, and someone
            * looking for a former employee would be told they do not exist. The filter is one click
            * away and visibly set when it is on.
            *
            * The values are the strings Joi coerces; see the `active` state declaration.
            */}
          <option value="">All staff</option>
          <option value="true">Current</option>
          <option value="false">Former</option>
        </FilterSelect>
      </FilterBar>

      {/*
        * Refusal before error, and both before loading resolves to content. A screen that checked
        * `error` first would show "something went wrong" with a retry button to a school whose plan
        * does not include the Staff module — the request did exactly what it should, and the answer
        * is an explanation rather than a retry that is guaranteed to fail identically.
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
            * The two empty states are different facts and get different sentences: a filter that
            * matched nothing is the user's own doing and is undone by clearing it, whereas an empty
            * table with no filter set means the school has not recorded any staff yet.
            */}
          {filtered
            ? 'No staff member matches these filters.'
            : 'No staff have been recorded for this school yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Staff"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <DeactivateDialog
        open={deactivate.target !== null}
        person={deactivate.target ? label(deactivate.target) : null}
        noun="staff member"
        allowance="staff allowance"
        busy={deactivate.busy}
        conflict={deactivate.conflict}
        onCancel={deactivate.cancel}
        onConfirm={(date) => deactivate.confirm(date)}
      />

      <ReactivateDialog
        open={reactivate.target !== null}
        person={reactivate.target ? label(reactivate.target) : null}
        noun="staff member"
        allowance="staff allowance"
        busy={reactivate.busy}
        conflict={reactivate.conflict}
        onCancel={reactivate.cancel}
        onConfirm={() => reactivate.confirm()}
      />

    </div>
  );
}
