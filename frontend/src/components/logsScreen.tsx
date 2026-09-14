'use client';

/**
 * The activity and audit trails — SRS §26, "Errors and activity are auditable via logs" — shared by the
 * school's Logs screen and the platform's.
 *
 * `GET /logs/activity` and `GET /logs/audit`, both on `logs.view`, which the seeded catalogue grants to
 * the Principal, the School Admin, the Organization Admin and the Super Admin. Both tables had been
 * written since §26 was built and nothing could read them without the database. The API is read-only —
 * nothing edits or deletes a log row — and so is this screen.
 *
 * ## Whose rows these are is the server's decision
 *
 * `logs.service.js` starts from `tenantWhere()`: a school caller reads its own school's rows, an
 * Organization Admin its organization's, and the Super Admin every row, the platform's own included
 * (`school_id` null). So the school screen sends no `school_id` and has no School filter. The platform
 * screen offers one, fed by `useSchoolNames()` — the lookup the billing screens use, which reads
 * `GET /schools` and is itself confined to the caller's organization — and `resolveSchool()` refuses a
 * school that is not the caller's.
 *
 * ## Two tabs, because they answer two questions
 *
 *  - **Activity** is what people did: a sign-in or a failed one, a change, an export, a refusal — each
 *    request the system recorded, with who made it, from where, and the status it was answered with.
 *  - **Audit** is what changed: one row per record written, and `recordAudit()` keeps only the columns
 *    that changed, before and after — so an update's two sides are the whole of the change. They are
 *    shown field by field in a dialog, never as a JSON blob in a cell.
 *
 * ## Every filter is the query schema's, and no id is typed
 *
 * `logs.validation.js` accepts, for activity, `action` (`ACTIVITY_ACTIONS`), `entity_type`, `q` (up to
 * 100 characters, over the description, the email and the path) and a window; for audit, `table_name`,
 * `record_id`, `event` and a window; for both, `user_id` and `school_id`. The two names are exact matches
 * in the service, so their boxes say so. The ids — an account, a record — are set from a row ("Only this
 * account", "This record's history") rather than typed, because `user_id=412` is not something anybody
 * can be asked to know; the filter bar then shows them as removable filters.
 *
 * ## The window is the viewer's days
 *
 * `from` and `to` bound `created_at`, an instant, and a bare `2026-09-10` would be read as midnight UTC
 * — so "to the 10th" would end as the 10th began. Each day is sent as the instant it starts or ends in
 * the viewer's zone (`dayBound()`), and a "To" before "From" is left off, with a word, rather than sent
 * to be refused.
 */

import { Fragment, Suspense, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { useAuth } from '@/lib/auth';
import { dayBound } from '@/lib/instants';
import { useCollection } from '@/lib/useCollection';
import { useSchoolNames } from '@/lib/useSchoolNames';
import { Field, FilterBar, FilterDate, FilterSelect, Notice, SearchField } from '@/components/form';
import { Icon } from '@/components/icon';
import { Modal } from '@/components/overlay';
import { TabPanel, Tabs, useActiveTab } from '@/components/tabs';
import {
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  Pagination,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';
import type { Column } from '@/components/table';

export type LogsSurface = 'school' | 'platform';

/** One `activity_logs` row, as `GET /logs/activity` returns it. */
interface ActivityRow {
  id: number;
  school_id: number | null;
  organization_id: number | null;
  user_id: number | null;
  /** Kept on the row so it stays readable after the account is deleted. */
  user_email: string | null;
  role_slug: string | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  description: string | null;
  method: string | null;
  path: string | null;
  status_code: number | null;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  metadata: unknown;
  created_at: string;
}

/** One `audit_logs` row, as `GET /logs/audit` returns it. The two value maps hold changed columns only. */
interface AuditRow {
  id: number;
  school_id: number | null;
  organization_id: number | null;
  user_id: number | null;
  table_name: string;
  record_id: number | null;
  event: string;
  /** Null on a create — there was nothing before. */
  old_values: Record<string, unknown> | null;
  /** Null on a delete — there is nothing after. */
  new_values: Record<string, unknown> | null;
  changed_fields: string[] | null;
  ip_address: string | null;
  request_id: string | null;
  reason: string | null;
  created_at: string;
}

/** `ACTIVITY_ACTIONS` in `config/constants.js` — the activity schema accepts exactly these. */
const ACTIONS = [
  'login',
  'login_failed',
  'logout',
  'create',
  'update',
  'delete',
  'view',
  'export',
  'approve',
  'reject',
  'access_denied',
];

/** The audit schema's `event` — `Joi.string().valid('create', 'update', 'delete', 'restore')`. */
const EVENTS = ['create', 'update', 'delete', 'restore'];

/** The two actions that record something refused, toned as such; every other word is neutral. */
const REFUSED_ACTIONS = new Set(['login_failed', 'access_denied']);

/** `commonSchemas.search` narrowed by the activity schema: `q` longer than this is a 422. */
const Q_MAX = 100;

const PAGE_SIZE = 25;

const TABS = [
  { key: 'activity', label: 'Activity' },
  { key: 'audit', label: 'Audit' },
];

/** `login_failed` → `Login failed`. */
function spell(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/*
 * An instant, in the viewer's own zone and to the second — the order two entries happened in is often
 * the question. Rows exist only after the client fetch, so the server render never formats one.
 */
const WHEN = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function formatWhen(value: string): string {
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? value : WHEN.format(when);
}

/** A text filter's value 300 ms after the last keystroke — the list screens' debounce. */
function useDebounced(value: string): string {
  const [settled, setSettled] = useState(value.trim());
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value.trim()), 300);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

/** The schools a platform caller may filter by, and each row's school by name. Null on the school screen. */
interface SchoolNames {
  nameFor: (id: number | null | undefined) => string;
  schools: Array<{ id: number; name: string }>;
}

/**
 * Whose row it is, for the platform's School column. Derived from the two nullable tenant columns, the
 * way the users screen derives "Platform", and never from a role name.
 */
function tenantOf(row: { school_id: number | null; organization_id: number | null }, names: SchoolNames): string {
  if (row.school_id !== null) return names.nameFor(row.school_id);
  return row.organization_id !== null ? 'Organization, no school' : 'Platform';
}

/* ─────────────────────────────── a stored value, readably ─────────────────────────────── */

/**
 * One value out of a log's JSON — a column's before or after, or a piece of an activity's metadata.
 *
 * Scalars are shown as they are; an empty value says so in words, since a blank cell reads as "not
 * loaded"; an object is a small labelled list, nested as deep as it goes. Nothing is reformatted: a
 * log is a record, and a date or an amount is shown exactly as it was stored.
 */
/** A stored JSON column's text, parsed — or null for anything that is not a JSON object or array. */
function storedJson(value: string): object | null {
  if (!/^\s*[[{]/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    /* Not JSON after all — the caller shows it as written. */
    return null;
  }
}

function Readable({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-soft">empty</span>;
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (typeof value === 'number') return <span className="tabular-nums">{String(value)}</span>;
  if (typeof value === 'string') {
    if (value === '') return <span className="text-muted-soft">blank</span>;
    /*
     * A JSON column arrives as its stored text: the audit snapshot reads `getDataValue()`, and on MariaDB
     * a JSON column's raw value is a string. Parsed back, it renders as fields rather than a blob; text
     * that only looks like JSON stays text.
     */
    const parsed = storedJson(value);
    if (parsed) return <Readable value={parsed} />;
    return <span className="whitespace-pre-wrap break-words">{value}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-soft">none</span>;
    if (value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
      return <span className="break-words">{value.map((item) => (item === null ? '—' : String(item))).join(', ')}</span>;
    }
    return (
      <ol className="list-decimal space-y-1 pl-4">
        {value.map((item, index) => (
          <li key={index}>
            <Readable value={item} />
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-muted-soft">none</span>;
    return (
      <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-3 gap-y-0.5">
        {entries.map(([key, inner]) => (
          <Fragment key={key}>
            <dt className="text-muted">
              <code className="text-xs">{key}</code>
            </dt>
            <dd className="min-w-0">
              <Readable value={inner} />
            </dd>
          </Fragment>
        ))}
      </dl>
    );
  }
  return <>{String(value)}</>;
}

/** One labelled fact in a details dialog. Null is an em-dash, never a blank. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children ?? <span className="text-muted-soft">—</span>}</dd>
    </>
  );
}

/** An id set from a row, shown in the filter bar so it can be seen and taken off. */
interface Pinned {
  id: number;
  label: string;
}

function PinnedFilter({ what, pinned, onClear }: { what: string; pinned: Pinned; onClear: () => void }) {
  return (
    <button type="button" className="btn btn-secondary btn-sm self-start sm:self-end" onClick={onClear}>
      <Icon name="x" size={14} />
      <span className="sr-only">Remove the {what} filter: </span>
      {pinned.label}
    </button>
  );
}

/** "To" before "From": a window with no days, which the schema would refuse. */
function reversedWindow(from: string, to: string): boolean {
  return Boolean(from && to && to < from);
}

/* ─────────────────────────────── the activity trail ─────────────────────────────── */

function ActivityTab({ names }: { names: SchoolNames | null }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [typeText, setTypeText] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [schoolId, setSchoolId] = useState('');
  const [account, setAccount] = useState<Pinned | null>(null);
  const [viewing, setViewing] = useState<ActivityRow | null>(null);

  const q = useDebounced(search);
  const entityType = useDebounced(typeText);
  /* Page four of the old answer is not page four of the new one. */
  useEffect(() => {
    setPage(1);
  }, [q, entityType]);

  const reversed = reversedWindow(from, to);
  const query = useMemo(
    () => ({
      page,
      limit: PAGE_SIZE,
      q: q || undefined,
      action: action || undefined,
      entity_type: entityType || undefined,
      from: from && !reversed ? dayBound(from, 'start') : undefined,
      to: to && !reversed ? dayBound(to, 'end') : undefined,
      school_id: schoolId || undefined,
      user_id: account ? account.id : undefined,
    }),
    [page, q, action, entityType, from, to, reversed, schoolId, account]
  );
  const { rows, meta, loading, error, refusal, reload } = useCollection<ActivityRow>('/logs/activity', query);

  const columns = useMemo<Column<ActivityRow>[]>(() => {
    const base: Column<ActivityRow>[] = [
      {
        key: 'when',
        header: 'When',
        cell: (row) => <span className="whitespace-nowrap text-xs text-muted">{formatWhen(row.created_at)}</span>,
      },
      {
        /*
         * The action and the sentence are one cell.
         *
         * They were two columns, and with `Request` and `School` beside them the table was seven
         * columns wide and scrolled sideways on a full-screen window — so a reader chasing "who did
         * this" had to scroll right to find out, losing `When` and `What` off the left edge. The chip
         * qualifies the sentence, so it belongs against it; the two columns that moved are both in the
         * Details dialog already, spelled out in full rather than truncated with an ellipsis.
         */
        key: 'what',
        header: 'What',
        primary: true,
        cell: (row) => (
          <div className="max-w-lg">
            <span className="flex flex-wrap items-center gap-2">
              <StatusBadge status={row.action} tone={REFUSED_ACTIONS.has(row.action) ? 'bad' : 'neutral'} />
              <span>{row.description || <span className="text-muted-soft">No description</span>}</span>
            </span>
            {row.entity_type ? (
              <span className="mt-0.5 block text-xs text-muted-soft">
                {row.entity_type}
                {row.entity_id !== null ? ` #${row.entity_id}` : ''}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'who',
        header: 'Who',
        cell: (row) => (
          <div className="max-w-[16rem]">
            <span className="block truncate">
              {row.user_email || (row.user_id !== null ? `Account #${row.user_id}` : 'No signed-in account')}
            </span>
            {row.role_slug ? <span className="block text-xs text-muted-soft">{spell(row.role_slug)}</span> : null}
            {row.user_id !== null && account?.id !== row.user_id ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm mt-0.5"
                onClick={() => {
                  setAccount({ id: row.user_id as number, label: row.user_email || `Account #${row.user_id}` });
                  setPage(1);
                }}
              >
                Only this account
              </button>
            ) : null}
          </div>
        ),
      },
    ];

    return [
      ...base,
      {
        key: 'details',
        header: 'Details',
        cell: (row) => (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setViewing(row)}>
            Details
          </button>
        ),
      },
    ];
  }, [account]);

  const activeCount = [search, action, typeText, from, to, schoolId, account].filter(Boolean).length;
  const clearFilters = () => {
    setSearch('');
    setAction('');
    setTypeText('');
    setFrom('');
    setTo('');
    setSchoolId('');
    setAccount(null);
    setPage(1);
  };

  return (
    <div>
      <FilterBar activeCount={activeCount} onClear={clearFilters}>
        <SearchField
          id="activity-search"
          label="Search activity by description, email or path"
          placeholder="Description, email or path…"
          maxLength={Q_MAX}
          value={search}
          onChange={setSearch}
        />
        <div>
          <FilterSelect
            id="activity-action"
            label="Action"
            labelVisible
            value={action}
            onChange={(value) => {
              setAction(value);
              setPage(1);
            }}
          >
            <option value="">Any action</option>
            {ACTIONS.map((value) => (
              <option key={value} value={value}>
                {spell(value)}
              </option>
            ))}
          </FilterSelect>
        </div>
        <div className="w-full sm:w-44">
          {/* An exact match in the service, so the placeholder says the word is taken whole. */}
          <Field
            id="activity-entity-type"
            label="Record type"
            className="mt-0"
            maxLength={60}
            placeholder="Exact, e.g. student"
            value={typeText}
            onChange={(event) => setTypeText(event.target.value)}
          />
        </div>
        <FilterDate
          id="activity-from"
          label="From"
          value={from}
          onChange={(value) => {
            setFrom(value);
            setPage(1);
          }}
        />
        <FilterDate
          id="activity-to"
          label="To"
          value={to}
          onChange={(value) => {
            setTo(value);
            setPage(1);
          }}
        />
        {/* Only offered once the names have loaded — an empty select is a control that looks broken. */}
        {names && names.schools.length > 0 ? (
          <div>
            <FilterSelect
              id="activity-school"
              label="School"
              labelVisible
              value={schoolId}
              onChange={(value) => {
                setSchoolId(value);
                setPage(1);
              }}
            >
              <option value="">Any school</option>
              {names.schools.map((school) => (
                <option key={school.id} value={school.id}>
                  {school.name}
                </option>
              ))}
            </FilterSelect>
          </div>
        ) : null}
        {account ? (
          <PinnedFilter
            what="account"
            pinned={account}
            onClear={() => {
              setAccount(null);
              setPage(1);
            }}
          />
        ) : null}
      </FilterBar>

      {reversed ? (
        <div className="mb-4">
          <Notice tone="warn">“To” is before “From”, so the dates are left off until one of them moves.</Notice>
        </div>
      ) : null}

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock label="Loading the activity log…" />
      ) : rows.length === 0 ? (
        <EmptyNotice
          icon="clock"
          title={activeCount > 0 ? 'Nothing matches these filters' : 'No activity recorded yet'}
          action={
            activeCount > 0 ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null
          }
        >
          {activeCount > 0
            ? 'Try a wider window or another action — or clear the filters to see everything.'
            : 'Sign-ins, changes and refusals appear here as the system records them.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Activity log" busy={loading} />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <Modal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title="Activity entry"
        description={viewing ? formatWhen(viewing.created_at) : undefined}
        size="lg"
        footer={
          <button type="button" className="btn btn-secondary" onClick={() => setViewing(null)}>
            Close
          </button>
        }
      >
        {viewing ? (
          <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-6 gap-y-2 text-sm">
            <Fact label="Action">{spell(viewing.action)}</Fact>
            <Fact label="Account">
              {viewing.user_email || (viewing.user_id !== null ? `Account #${viewing.user_id}` : null)}
            </Fact>
            <Fact label="Role">{viewing.role_slug ? spell(viewing.role_slug) : null}</Fact>
            <Fact label="Description">{viewing.description}</Fact>
            <Fact label="Record">
              {viewing.entity_type
                ? `${viewing.entity_type}${viewing.entity_id !== null ? ` #${viewing.entity_id}` : ''}`
                : null}
            </Fact>
            <Fact label="Request">
              {viewing.method || viewing.path ? (
                <code className="break-all text-xs">{[viewing.method, viewing.path].filter(Boolean).join(' ')}</code>
              ) : null}
            </Fact>
            <Fact label="Answered">{viewing.status_code !== null ? String(viewing.status_code) : null}</Fact>
            {names ? <Fact label="School">{tenantOf(viewing, names)}</Fact> : null}
            <Fact label="IP address">{viewing.ip_address}</Fact>
            <Fact label="Browser">{viewing.user_agent}</Fact>
            <Fact label="Request ID">
              {viewing.request_id ? <code className="break-all text-xs">{viewing.request_id}</code> : null}
            </Fact>
            <Fact label="Details">
              {viewing.metadata === null || viewing.metadata === undefined ? null : <Readable value={viewing.metadata} />}
            </Fact>
          </dl>
        ) : null}
      </Modal>
    </div>
  );
}

/* ─────────────────────────────── the audit trail ─────────────────────────────── */

/** The columns an audit row names, in the order it names them: `changed_fields`, else both maps' keys. */
function fieldsOf(row: AuditRow): string[] {
  if (Array.isArray(row.changed_fields) && row.changed_fields.length > 0) return row.changed_fields;
  return [...new Set([...Object.keys(row.old_values ?? {}), ...Object.keys(row.new_values ?? {})])];
}

/** What an audit row changed, in a few words for the table; the dialog has the values. */
function changeSummary(row: AuditRow): string {
  const fields = fieldsOf(row);
  if (row.event === 'create') return fields.length ? `New record · ${fields.length} field(s) set` : 'New record';
  if (row.event === 'delete') return 'Record removed';
  if (fields.length === 0) return '—';
  const shown = fields.slice(0, 3).join(', ');
  return fields.length > 3 ? `${shown} and ${fields.length - 3} more` : shown;
}

function AuditTab({ names }: { names: SchoolNames | null }) {
  const [page, setPage] = useState(1);
  const [tableText, setTableText] = useState('');
  const [event, setEvent] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [schoolId, setSchoolId] = useState('');
  const [account, setAccount] = useState<Pinned | null>(null);
  /* A record id belongs to a table, so it is held with the table it was taken from. */
  const [record, setRecord] = useState<Pinned & { table: string } | null>(null);
  const [viewing, setViewing] = useState<AuditRow | null>(null);

  const tableName = useDebounced(tableText);
  useEffect(() => {
    setPage(1);
  }, [tableName]);

  const reversed = reversedWindow(from, to);
  const query = useMemo(
    () => ({
      page,
      limit: PAGE_SIZE,
      /* A record's history names its own table, whatever the box holds. */
      table_name: record ? record.table : tableName || undefined,
      record_id: record ? record.id : undefined,
      event: event || undefined,
      from: from && !reversed ? dayBound(from, 'start') : undefined,
      to: to && !reversed ? dayBound(to, 'end') : undefined,
      school_id: schoolId || undefined,
      user_id: account ? account.id : undefined,
    }),
    [page, record, tableName, event, from, to, reversed, schoolId, account]
  );
  const { rows, meta, loading, error, refusal, reload } = useCollection<AuditRow>('/logs/audit', query);

  const columns = useMemo<Column<AuditRow>[]>(() => {
    const base: Column<AuditRow>[] = [
      {
        key: 'when',
        header: 'When',
        cell: (row) => <span className="whitespace-nowrap text-xs text-muted">{formatWhen(row.created_at)}</span>,
      },
      {
        key: 'record',
        header: 'Record',
        primary: true,
        cell: (row) => (
          <div className="flex flex-col items-start gap-0.5">
            <code className="text-xs font-medium">
              {row.table_name}
              {row.record_id !== null ? ` #${row.record_id}` : ''}
            </code>
            <StatusBadge status={row.event} tone="neutral" />
            {row.record_id !== null && !(record && record.id === row.record_id && record.table === row.table_name) ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setRecord({ id: row.record_id as number, table: row.table_name, label: `${row.table_name} #${row.record_id}` });
                  setPage(1);
                }}
              >
                This record’s history
              </button>
            ) : null}
          </div>
        ),
      },
      {
        /*
         * What changed, and why underneath it. `Reason` was a column of its own and `Event` another,
         * which took this table to eight columns — wider than the window, so the rightmost three were
         * only reachable by scrolling. The event is now a chip on the record it happened to, and the
         * reason sits under the change it explains, which is where it reads anyway.
         */
        key: 'changed',
        header: 'Changed',
        cell: (row) => (
          <div className="max-w-lg">
            <span className="block break-words text-sm">{changeSummary(row)}</span>
            {row.reason ? (
              <span className="mt-0.5 block break-words text-xs text-muted">“{row.reason}”</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'who',
        header: 'Who',
        hideOnMobile: true,
        cell: (row) =>
          row.user_id === null ? (
            <span className="text-muted-soft">No signed-in account</span>
          ) : (
            <div>
              <span className="block">Account #{row.user_id}</span>
              {account?.id !== row.user_id ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm mt-0.5"
                  onClick={() => {
                    setAccount({ id: row.user_id as number, label: `Account #${row.user_id}` });
                    setPage(1);
                  }}
                >
                  Only this account
                </button>
              ) : null}
            </div>
          ),
      },
    ];

    return [
      ...base,
      {
        key: 'details',
        header: 'Changes',
        cell: (row) => (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setViewing(row)}>
            View changes
          </button>
        ),
      },
    ];
  }, [account, record]);

  const activeCount = [tableText, event, from, to, schoolId, account, record].filter(Boolean).length;
  const clearFilters = () => {
    setTableText('');
    setEvent('');
    setFrom('');
    setTo('');
    setSchoolId('');
    setAccount(null);
    setRecord(null);
    setPage(1);
  };

  const viewingFields = viewing ? fieldsOf(viewing) : [];
  const showBefore = viewing ? viewing.old_values !== null : false;
  const showAfter = viewing ? viewing.new_values !== null : false;

  return (
    <div>
      <FilterBar activeCount={activeCount} onClear={clearFilters}>
        <div className="w-full sm:w-48">
          {/* An exact match in the service; a record's history, once set, names its own table instead. */}
          <Field
            id="audit-table"
            label="Table"
            className="mt-0"
            maxLength={60}
            placeholder="Exact, e.g. students"
            value={record ? record.table : tableText}
            disabled={record !== null}
            onChange={(change) => setTableText(change.target.value)}
          />
        </div>
        <div>
          <FilterSelect
            id="audit-event"
            label="Event"
            labelVisible
            value={event}
            onChange={(value) => {
              setEvent(value);
              setPage(1);
            }}
          >
            <option value="">Any event</option>
            {EVENTS.map((value) => (
              <option key={value} value={value}>
                {spell(value)}
              </option>
            ))}
          </FilterSelect>
        </div>
        <FilterDate
          id="audit-from"
          label="From"
          value={from}
          onChange={(value) => {
            setFrom(value);
            setPage(1);
          }}
        />
        <FilterDate
          id="audit-to"
          label="To"
          value={to}
          onChange={(value) => {
            setTo(value);
            setPage(1);
          }}
        />
        {names && names.schools.length > 0 ? (
          <div>
            <FilterSelect
              id="audit-school"
              label="School"
              labelVisible
              value={schoolId}
              onChange={(value) => {
                setSchoolId(value);
                setPage(1);
              }}
            >
              <option value="">Any school</option>
              {names.schools.map((school) => (
                <option key={school.id} value={school.id}>
                  {school.name}
                </option>
              ))}
            </FilterSelect>
          </div>
        ) : null}
        {record ? (
          <PinnedFilter
            what="record"
            pinned={record}
            onClear={() => {
              setRecord(null);
              setPage(1);
            }}
          />
        ) : null}
        {account ? (
          <PinnedFilter
            what="account"
            pinned={account}
            onClear={() => {
              setAccount(null);
              setPage(1);
            }}
          />
        ) : null}
      </FilterBar>

      {reversed ? (
        <div className="mb-4">
          <Notice tone="warn">“To” is before “From”, so the dates are left off until one of them moves.</Notice>
        </div>
      ) : null}

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock label="Loading the audit log…" />
      ) : rows.length === 0 ? (
        <EmptyNotice
          icon="clock"
          title={activeCount > 0 ? 'Nothing matches these filters' : 'No changes recorded yet'}
          action={
            activeCount > 0 ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null
          }
        >
          {activeCount > 0
            ? 'Try a wider window or another table — or clear the filters to see everything.'
            : 'Each record created, changed or removed appears here with its values before and after.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Audit log" busy={loading} />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <Modal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={
          viewing
            ? `${spell(viewing.event)} · ${viewing.table_name}${viewing.record_id !== null ? ` #${viewing.record_id}` : ''}`
            : 'Audit entry'
        }
        description={viewing ? formatWhen(viewing.created_at) : undefined}
        size="lg"
        footer={
          <button type="button" className="btn btn-secondary" onClick={() => setViewing(null)}>
            Close
          </button>
        }
      >
        {viewing ? (
          <div className="space-y-5">
            <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-6 gap-y-2 text-sm">
              <Fact label="Account">
                {viewing.user_id !== null ? `Account #${viewing.user_id}` : 'No signed-in account'}
              </Fact>
              <Fact label="Reason">{viewing.reason}</Fact>
              {names ? <Fact label="School">{tenantOf(viewing, names)}</Fact> : null}
              <Fact label="IP address">{viewing.ip_address}</Fact>
              <Fact label="Request ID">
                {viewing.request_id ? <code className="break-all text-xs">{viewing.request_id}</code> : null}
              </Fact>
            </dl>

            {/*
              * Field by field, each column's value before and after. Only the columns that changed are
              * stored, so this is the whole of the change; a create has no "before" and a delete no
              * "after", and those columns are left out rather than shown empty.
              */}
            {viewingFields.length === 0 ? (
              <p className="text-sm text-muted">This entry records no field values.</p>
            ) : (
              <div className="table-scroll rounded-md border border-border-soft" tabIndex={0} role="region" aria-label="Changed fields">
                <table className="w-full text-sm">
                  <caption className="sr-only">Changed fields</caption>
                  <thead>
                    <tr className="border-b border-border-soft bg-surface-2">
                      <th scope="col" className="px-3 py-2 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
                        Field
                      </th>
                      {showBefore ? (
                        <th scope="col" className="px-3 py-2 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
                          Before
                        </th>
                      ) : null}
                      {showAfter ? (
                        <th scope="col" className="px-3 py-2 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
                          {showBefore ? 'After' : 'Value'}
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-soft">
                    {viewingFields.map((field) => (
                      <tr key={field}>
                        <th scope="row" className="px-3 py-2 text-left align-top font-normal">
                          <code className="text-xs">{field}</code>
                        </th>
                        {showBefore ? (
                          <td className="px-3 py-2 align-top">
                            <Readable value={viewing.old_values?.[field]} />
                          </td>
                        ) : null}
                        {showAfter ? (
                          <td className="px-3 py-2 align-top">
                            <Readable value={viewing.new_values?.[field]} />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

/* ─────────────────────────────── the screen ─────────────────────────────── */

function LogsTabs({ surface, names }: { surface: LogsSurface; names: SchoolNames | null }) {
  const { profile } = useAuth();
  const [active, setActive] = useActiveTab(TABS);

  const scope =
    surface === 'school'
      ? 'What happened in your school, and who did it.'
      : profile?.tenant.isPlatform
        ? 'Across the platform — every school’s entries and the platform’s own.'
        : 'Across your organization’s schools, and your organization’s own entries.';

  return (
    <div>
      <PageHeader
        title="Logs"
        description={`${scope} Activity is each request the system recorded — sign-ins, changes, exports and refusals; Audit is each record that changed, with its values before and after. Newest first, and read-only.`}
      />
      <Tabs tabs={TABS} active={active} onChange={setActive} label="Log trails" />
      <TabPanel tabKey={active}>
        {active === 'audit' ? <AuditTab names={names} /> : <ActivityTab names={names} />}
      </TabPanel>
    </div>
  );
}

/** The platform's screen reads the school names it filters by; the school's has none to read. */
function PlatformLogs() {
  const { nameFor, schools } = useSchoolNames();
  const names = useMemo(() => ({ nameFor, schools }), [nameFor, schools]);
  return <LogsTabs surface="platform" names={names} />;
}

export function LogsScreen({ surface }: { surface: LogsSurface }) {
  const { can } = useAuth();

  /* Gated as the nav entry is; the API refuses without it regardless (`INSUFFICIENT_PERMISSION`). */
  if (!can('logs.view')) {
    return (
      <div>
        <PageHeader title="Logs" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to view the activity and audit logs.',
          }}
        />
      </div>
    );
  }

  /* `useActiveTab` reads the address, so the tabs render inside a Suspense boundary — the Fees shape. */
  return (
    <Suspense fallback={<LoadingBlock />}>
      {surface === 'platform' ? <PlatformLogs /> : <LogsTabs surface="school" names={null} />}
    </Suspense>
  );
}
