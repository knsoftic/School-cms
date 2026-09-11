'use client';

/**
 * Users — SRS §10 and §33's "Users", checklist row 4.3.
 *
 * The same four moving parts as `super-admin/schools/page.tsx`, which is the exemplar: a
 * `useCollection` call, a `Column[]`, the four-state render, and pagination. What differs is what a
 * user row is allowed to say.
 *
 * ## The `users` table is the one table whose columns are mostly not renderable
 *
 * `password_hash`, `refresh_token_hash`, `email_verification_token_hash` and
 * `password_reset_token_hash` are secrets; `failed_login_attempts`, `locked_until`,
 * `extra_permissions` and `denied_permissions` are internal bookkeeping. `auth.service.js`
 * `PUBLIC_USER_FIELDS` is an allow-list, not a deny-list, so none of them reach this screen — but the
 * `UserRow` interface below is still written from the *published* fields only, so that a future
 * widening of that list cannot quietly make a column here legal. The two override arrays are
 * published deliberately on `GET /users/:id` and only there, because that is where an administrator
 * is looking at one account's access rather than scanning a hundred.
 *
 * ## The API answers with names, so the screen shows names
 *
 * `users.service.present()` attaches `role`, `school` and `organization` objects on top of
 * `publicUser()` for exactly this reason — its own docblock says a list showing `school_id: 7` is not
 * a usable screen. So `role_id`, `school_id` and `organization_id` are never rendered; their objects
 * are.
 *
 * ## Nothing here branches on a role slug
 *
 * SRS §30 Rule 1 forbids deciding behaviour from a name. The rule is written about plans, but the
 * habit is the same one: the "Platform" tenant cell is derived from *both tenant objects being
 * absent* — which is what `users.organization_id`/`school_id` being nullable actually encodes — and
 * not from `role.slug === 'super_admin'`. The slug appears in one place only, as the value the role
 * filter sends to the API, where it is data in a query string rather than a branch.
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
 * One row of `GET /users`, as `users.service.present()` composes it.
 *
 * `role` is not optional: `users.role_id` is `allowNull: false` with `onDelete: 'RESTRICT'`, and the
 * list query always includes the association, so every row carries one. `school` and `organization`
 * are, because a Super Admin's own row has neither and an Organization Admin has only the second.
 */
interface UserRow {
  id: number;
  name: string;
  email: string;
  username: string;
  status: string;
  /** Nullable column; ISO 8601 once serialised. Null until the account's first successful sign-in. */
  last_login_at: string | null;
  role: { id: number; slug: string; name: string };
  school?: { id: number; name: string; code: string; status: string };
  organization?: { id: number; name: string; code: string; status: string };
}

/**
 * SRS §5's eleven roles, as `config/constants.js` `ROLE_LIST` fixes them.
 *
 * Hardcoded rather than fetched. The set is closed by the source — it is not seed data that grows —
 * and `users.validation.js` compiles it into `Joi.valid(...ROLE_LIST)`, so a slug that is not one of
 * these is a 422 rather than an empty result. Spending a request on eleven constants would also mean
 * the filter could not render until that request came back.
 *
 * The *column* still shows `role.name` from the database, which is the label an administrator has
 * seen elsewhere; only the filter's option text is derived, because a filter has no row to read from.
 */
const ROLE_SLUGS = [
  'super_admin',
  'organization_admin',
  'principal',
  'school_admin',
  'teacher',
  'accountant',
  'receptionist',
  'librarian',
  'staff',
  'student',
  'parent',
] as const;

/** SRS §7 "Account Status" (FR-AUTH-007) — `constants.js` `USER_STATUS`. */
const STATUSES = ['active', 'inactive', 'suspended', 'pending'] as const;

function humanise(slug: string): string {
  return slug.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

/**
 * A timestamp an administrator can read, or the placeholder for one that never happened.
 *
 * Locale formatting is safe here despite being non-deterministic across environments: the table is
 * only mounted after a client-side fetch resolves, so there is no server-rendered markup for the
 * browser's locale to disagree with. The `<time>` element keeps the machine-readable instant, since
 * "5 Sep 2026" loses the timezone and the hour that `last_login_at` actually stores.
 */
function LastSignIn({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-soft">never</span>;

  const when = new Date(value);
  /* An unparseable string would otherwise render the words "Invalid Date" as though it were data. */
  if (Number.isNaN(when.getTime())) return <span className="text-muted-soft">—</span>;

  return (
    <time dateTime={value} title={value} className="whitespace-nowrap">
      {when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
    </time>
  );
}

export default function UsersPage() {
  const { can, profile } = useAuth();

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  /*
   * `q` reaches three `LIKE '%…%'` scans on `users` — name, email and username — and `apiLimiter` is
   * mounted before authentication, so an unthrottled request per keystroke spends a real budget. The
   * exemplar's 300 ms is the same trade for the same reason.
   */
  const query = useMemo(
    () => ({
      page,
      limit: 20,
      q: debounced || undefined,
      status: status || undefined,
      role: role || undefined,
    }),
    [page, debounced, status, role]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<UserRow>('/users', query);

  const columns = useMemo<Column<UserRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Name',
        /* Into the account's own screen: its editable fields, its permission overrides, its role. */
        cell: (row) => (
          <Link
            href={`/super-admin/users/${row.id}`}
            className="font-medium underline-offset-2 hover:underline focus-visible:underline"
          >
            {row.name}
          </Link>
        ),
      },
      {
        key: 'username',
        /*
         * Kept alongside the email rather than treated as a duplicate of it. `authService
         * .findByIdentifier()` accepts either at the sign-in prompt, so when an administrator is
         * helping someone who cannot get in, the username is the value they have to read back.
         */
        header: 'Username',
        cell: (row) => <code className="text-xs text-muted">{row.username}</code>,
      },
      { key: 'email', header: 'Email', cell: (row) => row.email },
      { key: 'role', header: 'Role', cell: (row) => row.role.name },
      {
        key: 'tenant',
        header: 'School / Organization',
        /*
         * One column for two nullable tenant columns, because they are one question: where does this
         * account live? The school is the narrower answer and wins when present; an Organization
         * Admin has only the wider one and is marked as such, so an organization name is not misread
         * as a school; and an account with neither is a platform account, which is what `users`
         * allowing both to be null means.
         */
        cell: (row) =>
          row.school ? (
            row.school.name
          ) : row.organization ? (
            <span>
              {row.organization.name}
              <span className="ml-1 text-xs text-muted-soft">(org)</span>
            </span>
          ) : (
            <span className="text-muted-soft">Platform</span>
          ),
      },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
      {
        key: 'last_login_at',
        header: 'Last sign-in',
        cell: (row) => <LastSignIn value={row.last_login_at} />,
      },
    ],
    []
  );

  const filtered = Boolean(debounced || status || role);

  return (
    <div>
      <PageHeader
        title="Users"
        description={
          /* An Organization Admin reads this list too, confined to their organization by `tenantWhere()`. */
          profile?.tenant.isPlatform === false
            ? 'Every account in your organization — its schools’ staff and its administrators.'
            : 'Every account on the platform — school staff, organization administrators and platform users.'
        }
        action={
          /*
           * Not "Add user". `POST /users` exists since owner decision D1, and it creates a login for
           * someone the product already has a record of — `CREATABLE_ROLES` in `users.validation.js`:
           * a school's own people, from that school's people screens, where the profile the login
           * belongs to is; and, since D18, an Organization Admin, from the Organizations list, where the
           * organization it belongs to is. So this screen creates neither. It creates a Principal,
           * through §9.3's own path, and points at the Organizations list for the other — an operator
           * looking at the organization admins here is the one who wants to add one.
           *
           * `POST /principals` is guarded by **`requirePlatformScope()` and then**
           * `requirePermission('users.manage')` (`principals.routes.js:52-56`) — two gates, not one.
           * So this button is not a prediction that the destination will accept the caller: an
           * organization-scoped administrator holding `users.manage` would see it and be refused by
           * the scope check. Matching both gates here would put a second copy of the routing table
           * in the UI; the honest reading is the one below.
           *
           * Hiding it is a courtesy, not a control: `users.manage` is re-read from the database on
           * the request itself, so forcing the link into existence changes nothing.
           */
          can('users.manage') ? (
            <div className="flex flex-wrap gap-2">
              {/*
                * D18 — the Organizations list's "Add admin". Both of that dialog's conditions:
                * `createOrganizationAdmin()` refuses a caller without a platform scope.
                */}
              {profile?.tenant.isPlatform && can('organizations.view') ? (
                <Link href="/super-admin/organizations" className="btn btn-secondary">
                  Add an organization admin
                </Link>
              ) : null}
              <Link href="/super-admin/principals/new" className="btn btn-primary">
                Create principal
              </Link>
            </div>
          ) : null
        }
      />

      {/*
        * Three controls, not nine. `school_id` and `organization_id` exist as parameters but get no
        * control here: they take a row id, and a box an administrator types "7" into is not a filter
        * anyone can use — it needs a picker fed by `/schools` and `/organizations`, which is two more
        * collections loaded on a screen that has not been asked for them. The route into one school's
        * people is that school, not this list. `sortBy`/`sortOrder` are left alone too, because
        * `DataTable` has no sort affordance and inventing one here would put table interaction in a
        * page instead of the shared component.
        */}
      <FilterBar
        activeCount={[role, search, status].filter(Boolean).length}
        onClear={() => {
          setRole('');
          setSearch('');
          setStatus('');
          setPage(1);
        }}
      >
        <SearchField
          id="user-search"
          label="Search users"
          placeholder="Search by name, email or username…"
          value={search}
          onChange={setSearch}
        />

        <FilterSelect
          id="user-status"
          label="Filter by account status"
          value={status}
          onChange={(value) => {
            setStatus(value);
            /* Same reason the search resets: filtering from page four shows an empty table for a
             * filter that has two pages of matches. */
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {humanise(value)}
            </option>
          ))}
        </FilterSelect>

        <FilterSelect
          id="user-role"
          label="Filter by role"
          value={role}
          onChange={(value) => {
            setRole(value);
            setPage(1);
          }}
        >
          <option value="">All roles</option>
          {ROLE_SLUGS.map((slug) => (
            <option key={slug} value={slug}>
              {humanise(slug)}
            </option>
          ))}
        </FilterSelect>
      </FilterBar>

      {/*
        * `refusal` before `error`, and both before content. A Super Admin whose account somehow lost
        * `users.view` gets an explanation; only a 500 or a dead connection gets a retry button, which
        * is the only case where retrying is the right advice.
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
            * A filtered empty result and a genuinely empty table read identically otherwise, and the
            * remedy is opposite: clear a filter, or go and create an account.
            */}
          {filtered
            ? 'No user matches these filters.'
            : 'No user accounts exist yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Users"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
