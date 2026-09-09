'use client';

/**
 * Subjects — SRS §14.4 "Subject Creation" (FR-SCHOOL-004), §33's School → "Subjects",
 * checklist row 4.4.
 *
 * §14.4 is where subjects live, not §17 — §17 is Fee Management. Both `subjects.routes.js` and
 * `subjects.validation.js` cite §14.4 / FR-SCHOOL-004 in their own headers, and that is the pairing
 * kept here so the next reader does not "fix" it in the wrong direction.
 *
 * The four moving parts are `super-admin/schools/page.tsx`'s: one `useCollection`, one `Column[]`,
 * the four-state render in the order refusal → error → loading → empty → table, and `Pagination`.
 * Only the decisions this screen had to make for itself are written out below.
 *
 * ## There is no search box, and that is the finding rather than an omission
 *
 * `subjects.validation.js` builds its list schema with `listQuery()`, which merges in
 * `commonSchemas.search` — so `?q=…` passes validation on this endpoint and returns 200. But
 * `subjects.service.list()` reads exactly four keys off the query (`school_id`, `type`,
 * `is_active`, `is_elective`) and never touches `q`; there is no `LIKE` anywhere in it. A search
 * box wired to `q` would therefore be accepted, ignored, and answer with the unfiltered page —
 * the worst of the three possible outcomes, because no layer reports it and the user reads the
 * full catalogue as "my search matched everything".
 *
 * A subject catalogue is also the collection least in need of one: it is tens of rows, not
 * thousands, and the service's fallback sort is `['name', 'ASC']`, so the table already arrives
 * alphabetised and the browser's own find-in-page works on it. No box, and therefore no debounce —
 * the exemplar's 300 ms timer exists to stop a request per keystroke reaching an `apiLimiter` that
 * sits in front of authentication, and with nothing to type there is nothing to throttle.
 *
 * ## Three controls out of the eight parameters the endpoint accepts
 *
 * The schema accepts `page`, `limit`, `sortBy`, `sortOrder`, `q`, `school_id`, `type`, `is_active`
 * and `is_elective`. Three become controls; the rest are deliberate:
 *
 *   - **`school_id` is not a control on this surface.** `tenantWhere()` (`models/index.js:660`)
 *     writes `school_id = tenant.schoolId` before any query filter is applied, so a principal is
 *     already pinned to their own school. Sending it would restate what the tenant scope decided,
 *     and naming a different school is refused by `resolveSchool()` anyway. A school picker belongs
 *     to the platform surface, where the caller genuinely has more than one.
 *   - **`sortBy`/`sortOrder` are left at the service's default.** `SORTABLE` is
 *     `['id','name','code','type','is_active','created_at']` and the fallback is `['name','ASC']`,
 *     which is the order a catalogue is read in. Sortable headers are worth building once, for
 *     every list at once, in `DataTable` — not bolted onto this one screen with markup the shared
 *     component does not know about.
 *
 * ## The module gate this screen does not have
 *
 * `subjects.routes.js` mounts no `requireModule()` — subjects are core school setup, available on
 * every plan, and `SCHOOL_NAV`'s entry for `/school/subjects` carries a permission with no module
 * beside it for the same reason. The `refusal` branch is still rendered, but for exactly one reason:
 * `requirePermission('subjects.view')` raises `INSUFFICIENT_PERMISSION`, which the nav hides and a
 * bookmarked URL reaches. Nothing here checks that condition itself — `useCollection` classifies the
 * code and `RefusalNotice` explains it.
 *
 * It cannot receive `SUBSCRIPTION_INACTIVE`. That 402 comes from `assertSubscriptionUsable()` inside
 * `entitlement.js`, which runs only from the entitlement guards; `subjects.routes.js` mounts none of
 * them, and `app.js` mounts no global subscription check either. A lapsed school still reaches this
 * screen — which is the intended behaviour, since subjects are core setup rather than a subscribed
 * module, and locking a principal out of their own class structure over an unpaid invoice would be
 * the wrong failure.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
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
 * One row of `GET /subjects`.
 *
 * `subjects.controller.list()` has no `present()`: it hands `service.list()`'s rows straight to
 * `ApiResponse.paginated`, so what arrives is the `Subject` model serialised whole — the six fields
 * below plus `id`, `school_id`, `organization_id`, `created_at` and `updated_at`. Only what is
 * rendered is typed, so that adding a column is a deliberate edit here rather than a field that was
 * always in scope and quietly leaked into the table.
 *
 * The two flags are typed `boolean` rather than `0 | 1`: `models/academic.js` declares them
 * `DataTypes.BOOLEAN`, which Sequelize maps to MySQL's `TINYINT(1)` and parses back on the way out.
 * The cells below still read them for truthiness rather than comparing against `true`, which costs
 * nothing and survives the driver handing back `1`.
 *
 * `subjects` is not paranoid — `modelOptions()` without `softDeleteOptions()`, so there is no
 * `deleted_at` and `DELETE /subjects/:id` is a real delete. `is_active` is therefore the whole of
 * this table's lifecycle, which is why it earns a column and a filter rather than being assumed.
 */
interface Subject {
  id: number;
  name: string;
  code: string;
  type: string;
  is_elective: boolean;
  is_active: boolean;
  description: string | null;
}

/**
 * `type` is the model's own enum (`enumOf(['theory','practical','both'])`), written out rather than
 * capitalised mechanically — "Both" alone answers a question the reader did not ask, where
 * "Theory & practical" says what the subject actually involves.
 *
 * The lookup falls back to the raw value so a fourth member added to the enum shows as itself
 * instead of rendering an empty cell that looks like missing data.
 */
const TYPE_LABELS: Record<string, string> = {
  theory: 'Theory',
  practical: 'Practical',
  both: 'Theory & practical',
};

const TYPE_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All types' },
  { value: 'theory', label: 'Theory' },
  { value: 'practical', label: 'Practical' },
  { value: 'both', label: 'Theory & practical' },
];

/*
 * Both flag filters offer "either" as the first option and default to it. Defaulting to active-only
 * would be the more common view but the more dangerous one: a subject deactivated by mistake would
 * be invisible on the only screen that lists subjects, and the administrator looking for it would
 * conclude it had been deleted. The unfiltered list is the honest starting point, and `is_active`
 * is a column as well as a filter so the state is legible without touching the control.
 */
const ACTIVE_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Active and inactive' },
  { value: 'true', label: 'Active only' },
  { value: 'false', label: 'Inactive only' },
];

const ELECTIVE_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'Core and elective' },
  { value: 'false', label: 'Core only' },
  { value: 'true', label: 'Elective only' },
];


export default function SubjectsPage() {
  const { can } = useAuth();
  /*
   * Read once rather than called inside a cell. `can()` is cheap, but a cell runs per row per
   * render and the answer cannot differ between two rows of the same table.
   */
  const canManage = can('subjects.manage');

  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const [active, setActive] = useState('');
  const [elective, setElective] = useState('');

  const query = useMemo<Query>(() => {
    const next: Query = { page, limit: 20 };

    /*
     * Each filter is added only when it has a value, rather than assigned unconditionally.
     *
     * `fields.is_active` and `fields.is_elective` are bare `Joi.boolean()` with no `.empty('')`, so
     * `?is_active=` is a 422 — and `VALIDATION_ERROR` is not in `EXPLAINED_CODES`, so it would
     * surface as a red banner with a "Try again" button that fails identically every time, for the
     * user simply choosing "Active and inactive". `buildUrl()` happens to drop empty strings today,
     * which would mask this; the screen should not depend on the client's filter for its own
     * correctness.
     *
     * The values are strings because `Query` carries `string | number | undefined` and a query
     * string has never held a boolean. `validate()` runs Joi with `convert: true`
     * (`middlewares/validate.js:37`), so `'true'` and `'false'` both arrive as booleans — and the
     * service tests `!== undefined` rather than truthiness, so "Inactive only" is not swallowed.
     */
    if (type) next.type = type;
    if (active) next.is_active = active;
    if (elective) next.is_elective = elective;

    return next;
  }, [page, type, active, elective]);

  const { rows, meta, loading, error, refusal, reload } = useCollection<Subject>('/subjects', query);

  /*
   * Narrowing the list is one action, not two. Changing a filter while on page three otherwise
   * shows an empty table for a filter that has one page of matches — the rows exist, the offset is
   * past the end of them — which reads as "nothing matched" and is the opposite of the truth.
   */
  /*
   * Takes the value, not the event: `FilterSelect` owns the `<select>` now and hands back the
   * string. Page one for the same reason every other filter does it — page three of the old filter
   * is rarely page three of the new one.
   */
  const onFilterChange = (set: (value: string) => void) => (value: string) => {
    set(value);
    setPage(1);
  };

  const isFiltered = Boolean(type || active || elective);

  const columns = useMemo<Column<Subject>[]>(
    () => [
      {
        key: 'name',
        header: 'Subject',
        /*
         * The way into the record, and until now there was none: `PATCH`, `DELETE` and both
         * assignment endpoints had no caller anywhere in the product, so a subject could be created
         * and never corrected — including the `is_active` flag the create form tells the operator to
         * come back and switch on.
         *
         * The name is the link rather than a separate "Manage" column, because the name is what a
         * reader is already looking at and pointing a whole extra column at one verb costs the table
         * width it needs for the columns that carry information.
         */
        cell: (row) => (
          <Link
            href={`/school/subjects/${row.id}`}
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            {row.name}
          </Link>
        ),
      },
      {
        key: 'code',
        header: 'Code',
        /*
         * Unique per school (`subjects_school_code_unique` on `school_id, code`) and the handle the
         * rest of the system uses — SRS §14.4 ends on subjects being "available for timetable, exam,
         * and marks-related operations", and it is the code that appears there, not the id.
         * Monospaced so a column of them scans as identifiers rather than as prose.
         */
        cell: (row) => <code className="text-xs text-muted">{row.code}</code>,
      },
      {
        key: 'type',
        header: 'Type',
        cell: (row) => <span className="whitespace-nowrap">{TYPE_LABELS[row.type] ?? row.type}</span>,
      },
      {
        key: 'is_elective',
        header: 'Requirement',
        /*
         * Not a `StatusBadge`. Badge chrome says "this is a lifecycle state that may need
         * attention", and `StatusBadge` would give both words the same default grey border anyway
         * because neither appears in its tone lists — two rings of decoration carrying no signal,
         * next to a real status badge in the very next column.
         *
         * Elective is the exception and gets the emphasis; core is the model default
         * (`is_elective: false`) and is muted. The model's comment says the flag exists so optional
         * subjects can be excluded from result aggregation, which is exactly why a reader checking a
         * results discrepancy needs to see it here.
         */
        cell: (row) =>
          row.is_elective ? (
            <span className="whitespace-nowrap">Elective</span>
          ) : (
            <span className="whitespace-nowrap text-muted-soft">Core</span>
          ),
      },
      {
        key: 'is_active',
        header: 'Status',
        /*
         * Mapped to the vocabulary `StatusBadge` already tones: `active` is green, `inactive` is
         * the muted "ended" grey. Inventing words here — `enabled`/`disabled`, `yes`/`no` — would
         * fall through to the default border and lose the colour that makes the column scannable.
         */
        cell: (row) => <StatusBadge status={row.is_active ? 'active' : 'inactive'} />,
      },
      {
        key: 'description',
        header: 'Description',
        /*
         * `STRING(255)` and optional. Clamped to one line with the full text in `title`, because an
         * unclamped 255-character cell sets the width of the whole table — `DataTable` renders
         * `min-w-max`, so one long description pushes every other column off-screen and turns a
         * six-column table into a horizontal scroll for everyone.
         *
         * Worth the space despite being frequently empty: it is the only free text on the row, and
         * it is what separates two subjects whose names are nearly the same. There is no
         * single-subject screen yet for it to live on instead.
         */
        cell: (row) =>
          row.description ? (
            <span className="block max-w-xs truncate" title={row.description}>
              {row.description}
            </span>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
    ],
    []
  );

  return (
    <div>
      <PageHeader
        title="Subjects"
        description="This school’s subject catalogue. Codes are unique per school and are what the timetable, exam and marks screens refer to."
        action={
          /*
           * `subjects.manage` exists (`config/permissions.js:83`, "Create subjects & assign to
           * classes/teachers") and is the key `POST /subjects` is guarded by. Hiding the button is a
           * courtesy: `requirePermission` re-reads the grant from the database on the request
           * itself, so a user who forced this link into existence still gets a 403.
           */
          canManage ? (
            <Link
              href="/school/subjects/new"
              className="btn btn-primary"
            >
              Add subject
            </Link>
          ) : null
        }
      />

      <FilterBar
        activeCount={[active, elective, type].filter(Boolean).length}
        onClear={() => {
          setActive('');
          setElective('');
          setType('');
          setPage(1);
        }}
      >
        <FilterSelect
          id="subject-type"
          label="Filter by type"
          value={type}
          onChange={onFilterChange(setType)}
        >
          {TYPE_FILTERS.map((option) => (
            <option key={option.value || 'all'} value={option.value}>
              {option.label}
            </option>
          ))}
        </FilterSelect>

        <FilterSelect
          id="subject-requirement"
          label="Filter by core or elective"
          value={elective}
          onChange={onFilterChange(setElective)}
        >
          {ELECTIVE_FILTERS.map((option) => (
            <option key={option.value || 'all'} value={option.value}>
              {option.label}
            </option>
          ))}
        </FilterSelect>

        <FilterSelect
          id="subject-status"
          label="Filter by status"
          value={active}
          onChange={onFilterChange(setActive)}
        >
          {ACTIVE_FILTERS.map((option) => (
            <option key={option.value || 'all'} value={option.value}>
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
        /*
         * The empty message says whether a control is narrowing the list. "No subjects" under an
         * active filter reads as "this school has none" and sends a new administrator off to create
         * a catalogue that already exists.
         */
        <EmptyNotice>
          {isFiltered
            ? 'No subject matches these filters.'
            : 'No subjects have been created for this school yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Subjects"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
