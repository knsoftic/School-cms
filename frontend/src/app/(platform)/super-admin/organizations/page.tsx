'use client';

/**
 * Organizations — SRS §5 and §33's "Organizations", checklist row 4.3.
 *
 * The top of the tenant hierarchy: a school belongs to an organization, and FR-SADMIN-002 makes an
 * existing organization the precondition for creating one. This screen is the same four moving parts
 * as `schools/page.tsx` — a `useCollection` call, a `Column[]`, the four-state render, pagination —
 * and deviates from it only where the endpoint genuinely differs.
 *
 * ## The row type is the table, because there is no presenter
 *
 * `organizations.controller.js` `list()` hands `paginateQuery`'s rows straight to
 * `ApiResponse.paginated`, and `Organization` in `models/core.js` declares no `defaultScope`
 * exclusion. So unlike the modules that shape a response through a `present()`, **every column on the
 * table arrives in the payload** — `logo_path` and `notes` included. Nothing here is left out because
 * the API withheld it; the omissions below are this screen's own decisions, and are listed so the
 * next person does not read a missing column as an oversight:
 *
 *   - **`address`** and **`notes`** are free text of unbounded shape (`notes` is a TEXT column capped
 *     at 5 000 characters). Either one would set the row height for the whole table on the strength of
 *     the single longest value. There is no organization detail screen, so they are read and edited in
 *     the row's Edit dialog, which has the room for them — before that, both could be written on
 *     create and were never shown again.
 *   - **`logo_path`** is a storage path, not a URL, and `organizations.validation.js` records that
 *     *nothing in the backend writes it* — there is no organization-logo upload route. A column for it
 *     would be empty on every row today and would leak a server file layout the day it is not.
 *   - **`id`** is the `rowKey` but not a column: `code` is the human-facing identifier, and showing
 *     both trains people to quote the wrong one.
 *   - **`updated_at`** answers a question ("what changed lately?") that a list sorted newest-first does
 *     not ask. The audit trail answers it properly.
 *
 * ## Sort is not exposed, and that is a choice rather than an omission
 *
 * `sortBy` / `sortOrder` exist on this endpoint, but `DataTable` has no sortable-header affordance, so
 * wiring them would mean inventing one here — the kind of divergence that leaves thirty screens each
 * sorting differently. The server's fallback of `created_at DESC` (`getSort`) puts the newest
 * organization at the top, which is what an administrator who just created one is looking for.
 */

import { useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EditDialog } from '@/components/editDialog';
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

/** An organization row, as `organizations` columns define it — see the header on why that is the shape. */
interface Organization {
  id: number;
  name: string;
  code: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  /** Not columns in the table — see the header — but on every row, and edited in the dialog. */
  address: string | null;
  notes: string | null;
  status: string;
  /** Sequelize `DATE` — an ISO 8601 string once it has been through `JSON.stringify`, never a `Date`. */
  created_at: string;
}

/**
 * `ORGANIZATION_STATUS` in `config/constants.js`, which is also what `organizations.validation.js`
 * accepts. A value outside this set is rejected by `validate()` as a 422, so the filter cannot ask a
 * question the API will not answer.
 */
const STATUSES = ['active', 'suspended', 'archived'] as const;

/**
 * An href is only rendered for a value that carries its own `http`/`https` scheme.
 *
 * The validation layer already requires one, and its comment gives the reason: `sanitizeRequest`
 * strips script *text*, not a `javascript:` URL sitting in an ordinary string column. The guard is
 * repeated here because the browser is where that payload would actually fire, and because a
 * scheme-less value that predates the rule — or arrives from a direct database edit — would resolve
 * relative to this app's own origin and produce a link into the admin surface rather than out of it.
 */
function isLinkable(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * A creation date is context, not a timestamp to reconcile against anything, so it is rendered to the
 * day and in the viewer's own locale. There is no hydration risk in leaving the locale to the browser:
 * rows exist only after `useCollection`'s effect has run, so the server never renders this cell.
 */
function formatDate(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function OrganizationsPage() {
  const { can } = useAuth();

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    /*
     * 300 ms, for the reason the schools screen gives: `apiLimiter` is mounted ahead of authentication,
     * so a request per keystroke spends a real budget, and `q` lands in a `LIKE '%…%'` scan over both
     * `name` and `code` (`organizations.service.js`).
     */
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

  const { rows, meta, loading, error, refusal, reload } = useCollection<Organization>(
    '/organizations',
    query
  );

  /*
   * Editing an organization — `PATCH /organizations/:id`, which had no caller. FR-SADMIN-002 creates
   * one; nothing could correct it afterwards, so a typo in the name or a changed contact address was
   * permanent.
   *
   * All eight fields `update` accepts are offered, `address` and `notes` included. This comment used to
   * say `notes` was left out because `GET /organizations` does not return it, so the dialog would open
   * blank and a save would erase it. The premise was false — the list hands `paginateQuery`'s rows
   * straight through with no presenter and `Organization` has no `defaultScope` (see the header), so
   * both columns are on every row — and the omission meant the two fields could be written on create
   * and never read back anywhere. The dialog seeds them from the row, so it opens with what is stored.
   */
  const [editing, setEditing] = useState<Organization | null>(null);

  const columns = useMemo<Column<Organization>[]>(
    () => [
      {
        key: 'name',
        header: 'Organization',
        cell: (row) => <span className="font-medium">{row.name}</span>,
      },
      { key: 'code', header: 'Code', cell: (row) => <code className="text-xs text-muted">{row.code}</code> },
      { key: 'email', header: 'Email', cell: (row) => row.email ?? <span className="text-muted-soft">—</span> },
      { key: 'phone', header: 'Phone', cell: (row) => row.phone ?? <span className="text-muted-soft">—</span> },
      {
        key: 'website',
        header: 'Website',
        cell: (row) => {
          if (!row.website) return <span className="text-muted-soft">—</span>;
          /* Shown either way; only a value that proves its scheme becomes clickable. */
          if (!isLinkable(row.website)) return <span className="text-muted">{row.website}</span>;
          return (
            <a
              href={row.website}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              {/* The scheme is noise in a column being scanned; the link still carries the full value. */}
              {row.website.replace(/^https?:\/\//i, '')}
            </a>
          );
        },
      },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
      {
        key: 'created_at',
        header: 'Created',
        cell: (row) => {
          const formatted = formatDate(row.created_at);
          return formatted ? (
            /* The machine-readable value stays in the markup, where a `<time>` element belongs. */
            <time dateTime={row.created_at} className="whitespace-nowrap text-muted">
              {formatted}
            </time>
          ) : (
            <span className="text-muted-soft">—</span>
          );
        },
      },
      ...(can('organizations.manage')
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: Organization) => (
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing(row)}>
                  Edit
                </button>
              ),
            } as Column<Organization>,
          ]
        : []),
    ],
    [can]
  );

  return (
    <div>
      <PageHeader
        title="Organizations"
        description="The top of the tenant hierarchy — every school on the platform belongs to one of these."
        action={
          /*
           * Hidden without the permission, which is a courtesy and not a control: `requirePermission`
           * re-reads `organizations.manage` from the database on the request, and `requirePlatformScope`
           * guards the write a second time, so forcing this button into existence gets a 403 either way.
           */
          can('organizations.manage') ? (
            <a
              href="/super-admin/organizations/new"
              className="btn btn-primary"
            >
              Add organization
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
          id="organization-search"
          label="Search organizations"
          placeholder="Search by name or code…"
          value={search}
          onChange={setSearch}
        />

        {/*
          * Status earns a control where the other parameters do not: `resolveTenant` refuses a suspended
          * or archived organization outright, so "which of these are switched off" is the question this
          * list is opened to answer, and it is not one the free-text search can express.
          */}
        <FilterSelect
          id="organization-status"
          label="Filter by status"
          value={status}
          onChange={(value) => {
            setStatus(value);
            /* Same reason as the search: page four of "all" is usually past the end of "suspended". */
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
        /*
         * The empty message names the filters that are on. "No organizations" under an active status
         * filter reads as an empty platform, and sends the reader looking for a problem with the data
         * rather than at the control they set a moment ago.
         */
        <EmptyNotice>
          {debounced && status
            ? `No ${status} organization matches “${debounced}”.`
            : debounced
              ? `No organization matches “${debounced}”.`
              : status
                ? `No organization is currently ${status}.`
                : 'No organizations have been created yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption="Organizations"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <EditDialog
        row={editing}
        title={editing ? `Edit ${editing.name}` : ''}
        description="The organization's own record. Its schools, and their status, are managed on the Schools screen."
        success="Organization updated"
        onClose={() => setEditing(null)}
        onSaved={reload}
        save={(row, body) => api.patch(`/organizations/${row.id}`, body)}
        initial={(row) => ({
          name: row.name,
          code: row.code,
          email: row.email ?? '',
          phone: row.phone ?? '',
          website: row.website ?? '',
          address: row.address ?? '',
          status: row.status,
          notes: row.notes ?? '',
        })}
        fields={[
          { name: 'name', label: 'Name', required: true },
          {
            name: 'code',
            label: 'Code',
            required: true,
            hint: 'Unique across the platform. Nothing that already refers to this organization does so by code.',
          },
          { name: 'email', label: 'Email', kind: 'email', nullable: true },
          { name: 'phone', label: 'Phone', kind: 'tel', nullable: true },
          {
            name: 'website',
            label: 'Website',
            nullable: true,
            hint: 'Must carry its scheme — http:// or https://. The API refuses anything else.',
          },
          { name: 'address', label: 'Address', nullable: true, hint: 'Up to 255 characters.' },
          {
            name: 'status',
            label: 'Status',
            kind: 'select',
            required: true,
            options: STATUSES.map((value) => ({ value, label: value })),
            hint: 'Suspending an organization does not suspend its schools; each school carries its own status.',
          },
          {
            name: 'notes',
            label: 'Notes',
            kind: 'textarea',
            rows: 4,
            nullable: true,
            hint: 'Up to 5,000 characters. Clearing the box removes the notes.',
          },
        ]}
      />
    </div>
  );
}
