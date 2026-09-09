'use client';

/**
 * Parents — SRS §15.2 (FR-PARENT-001, Parent Account & Multiple Children), §33's "Parents",
 * checklist row 4.4.
 *
 * The same four moving parts as the Schools exemplar — a `useCollection` call, a `Column[]`, the
 * four-state render, and `Pagination` — with the three differences this endpoint actually forces.
 *
 * ## The row shape is the model's, because this module has no `present()`
 *
 * `parents.controller.js:list` hands `service.list()`'s rows straight to `ApiResponse.paginated`,
 * and `parents.service.js:list` ends in `paginateQuery(db.Parent, options, pagination)` with no
 * `attributes` list. So the payload is every column of the `Parent` model — including
 * `organization_id`, `address`, `user_id` and `photo_path`.
 *
 * `photo_path` is a **stored filesystem path**, and this file must never put one on screen. The
 * schema forbids it as a request-body field (`parents.validation.js`, Known Issues #26) and the
 * column has no writer anywhere, so today it is permanently null — but "currently always null" is
 * not a reason to render it, and a later session that gives it a writer must not discover that a
 * list screen had been printing server paths all along.
 *
 * The `Parent` interface below is therefore deliberately **narrower than the response**. It is the
 * suppression mechanism, not documentation: a field that is not on the type cannot reach a cell
 * without someone widening the type on purpose, and TypeScript strict makes that a visible edit.
 *
 * ## The module gate is already handled, and is not re-checked here
 *
 * `parents.routes.js` mounts `requireModule(MODULES.PARENT_PORTAL)` at router level, so a school
 * without the Parent Portal gets a 403 `MODULE_NOT_SUBSCRIBED`. `useCollection` classes that as a
 * **refusal**, not an error, and `RefusalNotice` explains it. Checking the entitlement snapshot here
 * as well would be a second source of truth that can disagree with the server's — and the answer
 * would be worse, because the snapshot is a cached copy while the guard reads the subscription on
 * the request itself.
 *
 * That is also why `refusal` is tested before `error`: a plan that does not include the module is
 * not a fault, and a red banner with a "Try again" button that can only fail identically is the
 * wrong answer to give a principal.
 *
 * ## What an administrator wants here and cannot have yet
 *
 * §15.2's headline feature is *Multiple Children*, so the column this list most wants is "how many
 * children, and which". The list response cannot supply it: `service.list()` only ever joins
 * `ParentStudent` with `attributes: []` (and only when `?student_id=` is given), so not one field
 * of the link ever reaches the client. The children live at `GET /parents/:id/children`, a
 * sub-resource, and inventing a count column would mean inventing the data behind it.
 *
 * For the same reason `user_id` is not a column. It is a bare foreign key with no association
 * included — "user_id: 412" tells an administrator nothing, and rendering it would dress a primary
 * key up as information.
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
 * One parent, as this screen is willing to read it.
 *
 * Narrower than the payload on purpose — see the file header. `address`, `occupation`,
 * `organization_id`, `school_id`, `user_id`, `photo_path` and the timestamps all arrive and none of
 * them is typed, so none of them can be rendered by accident.
 */
interface Parent {
  id: number;
  name: string;
  /* Free text (`STRING(60)`), not an ENUM — the model's own comment is 'father | mother | guardian | …'. */
  relation: string | null;
  /*
   * The **profile's** contact address, which the validation schema is explicit is not the account's:
   * `parents.email` is a contact column, `users.email` is the sign-in identifier, and a school may
   * hold a personal address on one while the login is keyed to the other. This column is the former,
   * so it must not be read as "the address this parent signs in with".
   */
  email: string | null;
  phone: string | null;
  national_id: string | null;
  is_active: boolean;
}

export default function ParentsPage() {
  const { can } = useAuth();

  /*
   * Read once, outside the column memo and outside every cell. `can()` inside a cell would run per
   * row per render, and — more to the point — a fresh call site would not be a dependency of the
   * memo, so the columns would keep whichever answer they captured first.
   */
  const manageable = can('parents.manage');

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  /* '' means "no filter": `buildUrl()` drops empty values rather than sending `is_active=`. */
  const [active, setActive] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      /*
       * Resetting to page one is part of the search, not a separate concern — searching from page
       * four and staying there shows an empty table for a query that has three pages of results.
       */
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  /*
   * Only the parameters `schemas.list` declares survive `validate()`, which runs with
   * `stripUnknown` on query strings — anything else would be silently dropped, so a control for it
   * would look like it worked and do nothing. That schema is
   * `listQuery({ school_id, is_active, student_id, q })`, and `listQuery` adds
   * `page`/`limit`/`sortBy`/`sortOrder`. Of those seven this screen sends three, and the three it
   * leaves out are left out for reasons rather than for brevity:
   *
   *   - **`school_id`** — a scope declaration, not a filter. On the school surface the caller's own
   *     school is already the tenant scope (`tenantWhere`), and `resolveSchool` only consults this
   *     when a platform-scoped caller names a school themselves. A school picker on a school's own
   *     screen would offer an administrator a choice they do not have.
   *   - **`student_id`** — this is "who are this child's parents", which is a question asked *from a
   *     student*, not from the parent directory. As a control here it would be a box asking an
   *     administrator to type a student's primary key, which nobody knows. It belongs as a link off
   *     the Students screen.
   *   - **`sortBy`/`sortOrder`** — the service already orders by `name ASC` (`getSort`'s default),
   *     which is the order a directory is read in. Offering the other four sortable columns would
   *     need clickable headers, and `Column` has no sortable flag — writing my own header markup to
   *     get one is exactly what "do not write your own table" rules out.
   *
   * `is_active` travels as the string 'true' / 'false'. `Query`'s values are strings or numbers, and
   * `validate()` runs Joi with `convert: true`, so `Joi.boolean()` reads either back as a boolean.
   */
  const query = useMemo(
    () => ({ page, limit: 20, q: debounced || undefined, is_active: active || undefined }),
    [page, debounced, active]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<Parent>('/parents', query);

  const columns = useMemo<Column<Parent>[]>(
    () => [
      { key: 'name', header: 'Parent', cell: (row) => <span className="font-medium">{row.name}</span> },
      {
        key: 'relation',
        header: 'Relation',
        /*
         * Plain text, not a `StatusBadge`. The column is free text rather than an ENUM, so the
         * badge's tone map has no opinion about it — every value would land in the default grey and
         * the badge would be decoration implying a vocabulary the database does not enforce.
         */
        cell: (row) => row.relation ?? <span className="text-muted-soft">—</span>,
      },
      { key: 'email', header: 'Email', cell: (row) => row.email ?? <span className="text-muted-soft">—</span> },
      { key: 'phone', header: 'Phone', cell: (row) => row.phone ?? <span className="text-muted-soft">—</span> },
      {
        key: 'national_id',
        header: 'National ID',
        /*
         * Kept because it is one of the three columns `?q=` searches (`name`, `phone`,
         * `national_id`). Without it a search that matched on a national ID would return rows with
         * nothing on them explaining the match, which reads as a broken search.
         */
        cell: (row) =>
          row.national_id ? (
            <code className="text-xs text-muted">{row.national_id}</code>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
      {
        key: 'is_active',
        header: 'Status',
        /*
         * This badge means more here than on the other people screens, and the difference is worth
         * knowing before anyone treats it as a soft profile flag. `parents.user_id` is NOT NULL — a
         * parent row cannot exist without a login — and `parents.service.update()` moves the profile
         * flag and `users.status` in **one transaction**, which `parents.routes.js` calls out as the
         * point where this module diverges from `teachers/`. So "inactive" here is a revoked
         * account: that parent can no longer sign in or read their children's dashboard.
         *
         * 'active' and 'inactive' are both in `StatusBadge`'s tone map (GOOD and ENDED), so the
         * boolean gets the same green/grey vocabulary as every other status column in §33 instead of
         * a bespoke yes/no of its own.
         */
        cell: (row) => <StatusBadge status={row.is_active ? 'active' : 'inactive'} />,
      },
    ],
    []
  );

  return (
    <div>
      <PageHeader
        title="Parents"
        description="Parent accounts for this school, and the contact details attached to them."
        action={
          /*
           * `parents.manage` is confirmed in `config/permissions.js:91` ("Create parents & link
           * children"), so the button is real. Hiding it without the permission is a courtesy rather
           * than a control — `requirePermission('parents.manage')` re-reads the grant on the request
           * itself, so a user who forced this link into existence still gets a 403 from `POST
           * /parents`.
           */
          manageable ? (
            <a
              href="/school/parents/new"
              className="btn btn-primary"
            >
              Add parent
            </a>
          ) : null
        }
      />

      <FilterBar
        activeCount={[active, search].filter(Boolean).length}
        onClear={() => {
          setActive('');
          setSearch('');
          setPage(1);
        }}
      >
        <div>
          <SearchField
            id="parent-search"
            label="Search parents"
            placeholder="Name, phone or national ID…"
            value={search}
            onChange={setSearch}
          />
        </div>
        <div>
          <FilterSelect
            id="parent-active"
            label="Account status"
            value={active}
            onChange={(value) => {
              setActive(value);
              /* Part of the filter, for the same reason the debounce resets it. */
              setPage(1);
            }}
          >
            <option value="">All parents</option>
            <option value="true">Active</option>
            <option value="false">Deactivated</option>
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
        /*
         * Three different emptinesses, because the fix for each is different: narrow the search,
         * clear the filter, or create the first parent. One "No results" would send an
         * administrator hunting for missing records when they have simply filtered them out.
         */
        <EmptyNotice>
          {debounced
            ? `No parent matches “${debounced}”.`
            : active === 'true'
              ? 'No parent account is active.'
              : active === 'false'
                ? 'No parent account has been deactivated.'
                : 'No parent accounts have been created yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Parents"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
