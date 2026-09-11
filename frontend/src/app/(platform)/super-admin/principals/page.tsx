'use client';

/**
 * Principals — SRS §9.3 (FR-SADMIN-009), §33's "Principals", checklist row 4.3.
 *
 * The same four moving parts as the Schools exemplar — a `useCollection`, a `Column[]`, the
 * four-state render, and `Pagination`. What is specific to this screen is written below; anything the
 * exemplar already decided is not restated here.
 *
 * ## The row is a user, not a principal
 *
 * There is no `principals` table. `principals.service.js` queries `users` filtered to the `principal`
 * role and presents each row through `auth.service.js` `publicUser()`, then attaches the four school
 * fields it includes. So the columns below are drawn from `PUBLIC_USER_FIELDS` plus the `role` and
 * `school` objects, and from nothing else. `role` is there because the list query includes the
 * association and `publicUser()` attaches it whenever it is loaded — this header used to say the
 * response carried no other key, which would have talked anyone out of a Role column that works.
 *
 * ## The row is a way in, not the end of the road
 *
 * A Principal is a user, so the name opens the account on the Users detail screen — status,
 * permission overrides, role — rather than a principal screen of its own that would be a second
 * editor for the same `users` row (`principals.routes.js` declines a PATCH for exactly that reason).
 * The school opens the school, whose Principal tab is where FR-SADMIN-007's assignment lives:
 * `PUT /schools/:id/principal` needs the school as well as the person, so it belongs on the school.
 *
 * ## Why verification and last sign-in are worth a column each
 *
 * FR-SADMIN-009 has the Super Admin type the Principal's password, so the account starts life with
 * `must_change_password` set and an unverified address. The service header is explicit that the
 * verification mail is sent on a best-effort basis: if SMTP is down the account is still created and
 * committed, and the only signal the operator gets is `verificationEmailSent: false` on a response
 * they have long since navigated away from. Without these two columns the list cannot answer the
 * question that follows every batch of principal creation — *which of these people can actually get
 * in?* — and the operator would be resending verification blind.
 *
 * ## No sort controls
 *
 * `sortBy` and `sortOrder` exist on the endpoint and `SORTABLE` names seven columns, but `Column` has
 * no sort affordance, so wiring them here would add query state nothing on screen can change. It
 * belongs with a sortable header in `table.tsx`, not with a hidden parameter in one page.
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

/** The school `principals.service.js` `present()` attaches — four fields, not the whole record. */
interface PrincipalSchool {
  id: number;
  name: string;
  code: string;
  status: string;
}

/**
 * A principal row, as `present()` emits it.
 *
 * `school` is optional rather than nullable because `publicUser()` builds its payload by copying keys
 * that exist, and `present()` only adds `school` when the association loaded — an account whose
 * `school_id` is null has no `school` key at all, not a null one.
 */
interface Principal {
  id: number;
  name: string;
  email: string;
  /*
   * Not nullable: `users.username` is `allowNull: false` behind a unique index, and the create schema
   * requires it. It was typed `string | null` with an em-dash branch for a row the database forbids.
   */
  username: string;
  status: string;
  /** ISO timestamps, or null. Sequelize `DATE` columns serialised by `JSON.stringify`. */
  email_verified_at: string | null;
  last_login_at: string | null;
  school?: PrincipalSchool;
}

/** `USER_STATUS` in `backend/src/config/constants.js` — the four values `validate()` will accept. */
const STATUSES = ['active', 'inactive', 'suspended', 'pending'] as const;


/**
 * A timestamp as a day.
 *
 * Local formatting is safe here even though this is a server-rendered client component: `rows` starts
 * empty and is only filled by `useCollection`'s effect, so a cell holding a date has no server render
 * to disagree with. The `Number.isNaN` guard is for a value that is not a timestamp at all — printing
 * the string "Invalid Date" into a table is worse than printing nothing.
 */
function day(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function PrincipalsPage() {
  const { can, profile } = useAuth();

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useMemo(
    () => ({ page, limit: 20, q: debounced || undefined, status: status || undefined }),
    [page, debounced, status]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<Principal>(
    '/principals',
    query
  );

  const columns = useMemo<Column<Principal>[]>(
    () => [
      {
        key: 'name',
        header: 'Principal',
        /*
         * Into the account — see the header. `GET /users/:id` needs `users.view`, the same key this
         * list needs, so a reader of this row can always open it.
         */
        cell: (row) => (
          <Link
            href={`/super-admin/users/${row.id}`}
            className="font-medium underline-offset-2 hover:underline focus-visible:underline"
          >
            {row.name}
          </Link>
        ),
      },
      { key: 'email', header: 'Email', cell: (row) => row.email },
      {
        key: 'username',
        header: 'Username',
        /*
         * Carried because `findByIdentifier()` matches a sign-in attempt against the username as well
         * as the email, so it is half the answer to "why can this person not log in" — and it is the
         * half the operator cannot guess from the name.
         */
        cell: (row) => <code className="text-xs text-muted">{row.username}</code>,
      },
      {
        key: 'school',
        header: 'School',
        /*
         * A link only for a reader who can open the school: `GET /schools/:id` is `schools.view`, a
         * different key from the `users.view` that shows this list.
         */
        cell: (row) =>
          row.school ? (
            <span className="whitespace-nowrap">
              {can('schools.view') ? (
                <Link
                  href={`/super-admin/schools/${row.school.id}?tab=principal`}
                  className="underline-offset-2 hover:underline focus-visible:underline"
                >
                  {row.school.name}
                </Link>
              ) : (
                row.school.name
              )}{' '}
              <code className="text-xs text-muted-soft">{row.school.code}</code>
            </span>
          ) : (
            <span className="text-muted-soft">unassigned</span>
          ),
      },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
      {
        key: 'email_verified_at',
        header: 'Email verified',
        /*
         * A badge rather than a dash for the unverified case. The empty-looking cell an operator
         * skims past is exactly the row that needs FR-AUTH-006's resend, so the absence is spelled
         * out as a word instead of being rendered as missing data.
         */
        cell: (row) => {
          const verified = day(row.email_verified_at);
          return verified ?? <StatusBadge status="not verified" />;
        },
      },
      {
        key: 'last_login_at',
        header: 'Last sign-in',
        cell: (row) => day(row.last_login_at) ?? <span className="text-muted-soft">never</span>,
      },
    ],
    [can]
  );

  return (
    <div>
      <PageHeader
        title="Principals"
        description={
          /* An Organization Admin reads this list too, confined to their organization by `tenantWhere()`. */
          profile?.tenant.isPlatform === false
            ? 'Principal accounts across your organization’s schools.'
            : 'Principal accounts across every school on the platform.'
        }
        action={
          /* Hidden without `users.manage` — the same courtesy the exemplar documents. `POST /principals`
           * additionally carries `requirePlatformScope()`, so an organization admin holding the
           * permission still cannot create one; the button is not the place that decides. */
          can('users.manage') ? (
            <a
              href="/super-admin/principals/new"
              className="btn btn-primary"
            >
              Add principal
            </a>
          ) : null
        }
      />

      <FilterBar
        activeCount={[search, status].filter(Boolean).length}
        onClear={() => {
          setSearch('');
          setStatus('');
          setPage(1);
        }}
      >
        <SearchField
          id="principal-search"
          label="Search principals"
          placeholder="Search by name, email or username…"
          value={search}
          onChange={setSearch}
        />

        <FilterSelect
          id="principal-status"
          label="Filter by status"
          value={status}
          onChange={(value) => {
            setStatus(value);
            /* Same reasoning as the search: a filter applied from page three would show an empty
             * table for a result set that has two. */
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
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
        <EmptyNotice>
          {/*
            * The two filters are named separately because they fail differently: a query with no
            * match is a typo, and a status with no match is a real fact about the accounts. Telling
            * the operator only "no results" leaves them clearing the wrong control.
            */}
          {debounced && status
            ? `No ${status} principal matches “${debounced}”.`
            : debounced
              ? `No principal matches “${debounced}”.`
              : status
                ? `No principal currently has the status “${status}”.`
                : 'No principals have been created yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Principals"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
