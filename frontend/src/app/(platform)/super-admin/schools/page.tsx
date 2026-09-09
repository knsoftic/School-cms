'use client';

/**
 * Schools — SRS §9.2, §33's "Schools", checklist row 4.3.
 *
 * **This is the exemplar list screen.** The other thirty in §33 are the same four moving parts:
 * a `useCollection` call, a `Column[]`, the four-state render, and pagination. Anything that had to
 * be decided once is decided here.
 *
 * ## The four states, and why the order matters
 *
 * `refusal` is checked before `error`, and both before `loading` resolves to content. A screen that
 * checked `error` first would report "something went wrong" for a school whose plan simply does not
 * include a module — the request did exactly what it should, and the answer is an explanation rather
 * than a retry button.
 *
 * ## Search is debounced, and the reason is the backend's
 *
 * `apiLimiter` is mounted before authentication, so an unthrottled request per keystroke spends a
 * real budget — and `q` reaches a `LIKE` scan. 300 ms is long enough to collapse a typed word into
 * one request and short enough to feel immediate.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { SearchField } from '@/components/form';
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

/** A school row, as `schools` columns define it. */
interface School {
  id: number;
  name: string;
  code: string;
  city: string | null;
  email: string | null;
  status: string;
  subscription_state: string | null;
}

export default function SchoolsPage() {
  const { can } = useAuth();

  const [page, setPage] = useState(1);
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

  const query = useMemo(
    () => ({ page, limit: 20, q: debounced || undefined }),
    [page, debounced]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<School>('/schools', query);

  const columns = useMemo<Column<School>[]>(
    () => [
      {
        key: 'name',
        header: 'School',
        /* The way into the school's own screen — its details, its status and its Principal. */
        cell: (row) => (
          <Link
            href={`/super-admin/schools/${row.id}`}
            className="font-medium underline-offset-2 hover:underline focus-visible:underline"
          >
            {row.name}
          </Link>
        ),
      },
      { key: 'code', header: 'Code', cell: (row) => <code className="text-xs text-muted">{row.code}</code> },
      { key: 'city', header: 'City', cell: (row) => row.city ?? <span className="text-muted-soft">—</span> },
      { key: 'email', header: 'Email', cell: (row) => row.email ?? <span className="text-muted-soft">—</span> },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
      {
        key: 'subscription',
        header: 'Subscription',
        cell: (row) =>
          row.subscription_state ? (
            <StatusBadge status={row.subscription_state} />
          ) : (
            <span className="text-muted-soft">none</span>
          ),
      },
    ],
    []
  );

  return (
    <div>
      <PageHeader
        title="Schools"
        description="Every school on the platform, across all organizations."
        action={
          /*
           * The button is hidden without the permission — a courtesy, not a control. `schools.manage`
           * is re-read from the database on the request itself, so a user who forced this button
           * into existence would still be refused by the API.
           */
          can('schools.manage') ? (
            <Link
              href="/super-admin/schools/new"
              className="btn btn-primary"
            >
              Add school
            </Link>
          ) : null
        }
      />

      <SearchField
        id="school-search"
        label="Search schools"
        placeholder="Search by name or code…"
        value={search}
        onChange={setSearch}
      />

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {debounced
            ? `No school matches “${debounced}”.`
            : 'No schools have been created yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Schools"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
