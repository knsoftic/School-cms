'use client';

/**
 * One school — SRS §9.2, FR-SADMIN-003 through FR-SADMIN-008: the six write routes the module had
 * mounted with no caller, and the one read (usage) that had none either.
 *
 * `PATCH /schools/:id` (edit), `POST /:id/activate`, `/suspend`, `/archive` (the status lifecycle),
 * `DELETE /:id` (a soft delete), `PUT /:id/principal`, and `GET /:id/usage`. Without them the Schools
 * screen was a directory: a school could be created and then never corrected, never suspended when it
 * stopped paying, never archived, never given the Principal that FR-SADMIN-007 requires, and never
 * checked against what its subscription allows.
 *
 * ## Five permissions, not one
 *
 * `schools.manage` edits, `schools.status` activates and suspends, `schools.archive` archives **and
 * deletes**, `schools.assign_principal` links the Principal, `schools.usage.view` reads the usage.
 * They are five keys in `config/permissions.js` and an operator may hold any subset, so each control
 * is gated on its own — the Usage tab is not even offered without its key. The six write routes also
 * carry `requirePlatformScope()`, which `can()` cannot see: an organization-scoped account holding the
 * permission is refused by the API with `PLATFORM_SCOPE_REQUIRED`, and that refusal's own sentence
 * ("restricted to platform administrators") is what the form or dialog's error notice shows.
 * `RefusalNotice` is for the school's own read, which is where a refusal replaces the whole screen.
 * (This paragraph used to say `RefusalNotice` explained the write refusals too; none of the write
 * handlers ever rendered it.)
 *
 * ## Archive and delete are different things and are deliberately not adjacent
 *
 * Archiving sets a status and keeps the row. Deleting is a **soft delete** — `school.destroy()` on a
 * paranoid model — so the row survives in the database and drops out of every default query: everyone
 * at the school loses access (`resolveTenant` no longer finds it), and nothing reached *through* the
 * school opens any more. It is not the end of every trace, and the copy used to say it was: the
 * subscription, invoices and payments carry `school_id` and are kept for the financial record, so they
 * stay on the platform's billing screens; the user accounts stay on the Users screen, unable to sign
 * in; and `remove()` touches no subscription, so a live one is **not cancelled** by deleting its
 * school. The dialog says so, and warns outright when the subscription is still open. Delete sits
 * apart from the lifecycle row, in its own bordered block, because a button beside "Archive" that does
 * something much larger is a button pressed by mistake.
 *
 * ## The Principal must already exist, and this screen does not create one
 *
 * `assignPrincipal()` refuses a user whose role is not `principal`, and refuses one belonging to a
 * different school. So the picker lists `GET /principals?school_id=` — the principals of *this*
 * school. When there are none it links to the New Principal form with this school preselected, and
 * that form comes back here afterwards. When the list could not be read at all — it needs
 * `users.view`, a key this screen does not otherwise require — it says that, rather than claiming the
 * school has no Principals.
 *
 * ## A school that is not there
 *
 * `GET /schools/:id` answers 404 `SCHOOL_NOT_FOUND` for an id outside the caller's scope or deleted,
 * and 422 for an id that is not a number. Both used to land in `ErrorNotice` — "Something went wrong"
 * and a Try again that could only fail the same way. They are a not-found state with a way back.
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { splitApiErrors } from '@/lib/formErrors';
import { EXPLAINED_CODES, useCollection } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import {
  Field,
  FormGrid,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  humaniseFieldError,
} from '@/components/form';
import { Modal } from '@/components/overlay';
import { TabPanel, Tabs, useActiveTab } from '@/components/tabs';
import type { TabDef } from '@/components/tabs';
import { useToast } from '@/components/toast';
import {
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';
import type { Column } from '@/components/table';

const BASE_TABS: TabDef[] = [
  { key: 'details', label: 'Details' },
  { key: 'principal', label: 'Principal' },
];

/** Offered only to a holder of `schools.usage.view` — see the header. */
const USAGE_TAB: TabDef = { key: 'usage', label: 'Usage' };

/**
 * `GET /schools/:id` — the `schools` columns plus the two associations `DETAIL_INCLUDE` loads.
 *
 * The status columns are read as well as `status` itself: `suspension_reason` and `suspended_at` are
 * written by Suspend and `archived_at` by Archive (`TRANSITIONS` in `schools.service.js`), and the
 * screen used to show none of them — so the reason typed into the Suspend dialog went into a column
 * nothing ever displayed, while the dialog's hint claimed the table had no such column.
 */
interface SchoolDetail {
  id: number;
  name: string;
  code: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  status: string;
  principal_id: number | null;
  suspended_at: string | null;
  suspension_reason: string | null;
  archived_at: string | null;
  /** Cached from the school's subscription by the subscription module. Null when it has none. */
  subscription_state: string | null;
  organization?: { id: number; name: string; code: string; status: string } | null;
  principal?: { id: number; name: string; email: string; status: string } | null;
}

/** One row of `GET /principals`. */
interface PrincipalOption {
  id: number;
  name: string;
  email: string;
  status: string;
}

interface FormValues {
  name: string;
  code: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  country: string;
}

/**
 * The two fields `update` cannot store as null. Blank is sent as `''` for these, so the schema's
 * `string.empty` names the field ("Name is required") instead of the box being quietly ignored.
 */
const REQUIRED_FIELDS: ReadonlySet<keyof FormValues> = new Set(['name', 'code']);

function toValues(school: SchoolDetail): FormValues {
  return {
    name: school.name,
    code: school.code,
    email: school.email ?? '',
    phone: school.phone ?? '',
    address: school.address ?? '',
    city: school.city ?? '',
    state: school.state ?? '',
    country: school.country ?? '',
  };
}

/** A stored instant as a day in the reader's locale, or null for one that is absent or unparseable. */
function day(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * A 404, or a 422 on the route parameter — the two ways `GET /schools/:id` says there is no such
 * school. A 422 anywhere else is a real validation failure and stays an error.
 */
function isMissing(caught: ApiError): boolean {
  return (
    caught.status === 404
    || (caught.status === 422 && caught.details.some((detail) => detail.location === 'params'))
  );
}

/** The subscription states in which nothing is billed any more. Any other state is still open. */
const CLOSED_SUBSCRIPTION_STATES = new Set(['expired', 'cancelled']);

/**
 * The three status transitions plus the delete, with the words each one needs.
 *
 * Written as a table rather than four blocks for the reason `planLifecycle.tsx` gives: three of the
 * four are the same dialog with different copy, and the copy is the part that matters — "suspend"
 * and "archive" do genuinely different things to a school that is still paying.
 *
 * `reasonHint` is per action because the two reasons are kept in different places. Suspend writes
 * `schools.suspension_reason`, which this screen shows while the school stays suspended; Archive has
 * no column of its own and lands only in `audit_logs.reason`. One shared hint used to tell both that
 * the table had no column for it.
 */
const LIFECYCLE: Record<
  string,
  {
    label: string;
    title: (name: string) => string;
    description: string;
    confirm: string;
    busy: string;
    tone: 'primary' | 'danger';
    reason: boolean;
    reasonHint?: string;
  }
> = {
  activate: {
    label: 'Activate',
    title: (name) => `Activate ${name}?`,
    description:
      'The school and its users can sign in and work again. Nothing about its subscription changes — if that has lapsed, activating the school does not renew it.',
    confirm: 'Activate school',
    busy: 'Activating…',
    tone: 'primary',
    reason: false,
  },
  suspend: {
    label: 'Suspend',
    title: (name) => `Suspend ${name}?`,
    description:
      'Everybody at the school loses access immediately, including its Principal. The data is untouched and the subscription keeps running — this is an administrative stop, not a cancellation.',
    confirm: 'Suspend school',
    busy: 'Suspending…',
    tone: 'danger',
    reason: true,
    reasonHint:
      'Optional, up to 255 characters. Stored with the school and shown on this screen for as long as it stays suspended; the audit trail keeps it too.',
  },
  archive: {
    label: 'Archive',
    title: (name) => `Archive ${name}?`,
    description:
      'The school is kept for reference and stops being active. Nothing is deleted: it stays in the Schools list, marked Archived, and activating it brings it back.',
    confirm: 'Archive school',
    busy: 'Archiving…',
    tone: 'danger',
    reason: true,
    reasonHint:
      'Optional, up to 255 characters. Kept in the audit trail only — a school has no field of its own for an archive reason.',
  },
};

/* ─────────────────────────────── usage — FR-SADMIN-008 ─────────────────────────────── */

/**
 * One limit's standing, as `usageService.getUsage()` returns it and `GET /schools/:id/usage` lists it
 * — every key in `USAGE_LIMIT_KEYS`, resolved through the school's subscription, plan, add-ons and
 * overrides. Only the fields this panel reads are declared.
 */
interface LimitUsage {
  limitKey: string;
  label: string;
  /** `LIMIT_UNITS` — `count`, `megabytes` or `requests` — or the plan row's own unit. */
  unit: string | null;
  measurement: 'headcount' | 'cumulative' | 'periodic' | 'per_request';
  unlimited: boolean;
  allowed: number | null;
  used: number;
  remaining: number | null;
  /** Units beyond the allowance. Recorded even where overage is not permitted. */
  overage: number;
  allowOverage: boolean;
  /** `plan`, `addon`, `override`, or `default` when nothing in the chain set it. */
  source: string;
  /** The end of the billing period a periodic limit resets at; null for the other three kinds. */
  periodEnd: string | null;
  /** False when nothing accumulates (a per-file ceiling) or there is no subscription to count against. */
  tracked: boolean;
}

interface UsageReport {
  usage: LimitUsage[];
}

const NUMBER = new Intl.NumberFormat();

/** A quantity in its unit. `count` needs no word; megabytes read better as MB. */
function quantity(value: number, unit: string | null): string {
  const figure = NUMBER.format(value);
  if (!unit || unit === 'count') return figure;
  if (unit === 'megabytes') return `${figure} MB`;
  return `${figure} ${unit}`;
}

/**
 * How each kind of limit is counted, in the words `usageService.js`'s header uses for them — the four
 * are measured four different ways, and a reader comparing "used" across rows needs to know that.
 */
function measuredAs(row: LimitUsage): string {
  switch (row.measurement) {
    case 'headcount':
      return 'Counted live';
    case 'periodic':
      return row.periodEnd ? `Resets ${day(row.periodEnd) ?? 'each billing period'}` : 'Resets each billing period';
    case 'per_request':
      return 'A ceiling on each file';
    default:
      return 'Running total, never resets';
  }
}

const SOURCE_LABELS: Record<string, string> = {
  plan: 'Plan',
  addon: 'Add-on',
  override: 'Override',
  default: 'Not set',
};

/**
 * The usage panel. Its own component, fetched when the tab opens, so a reader who never opens it
 * never spends the request — `getUsageSummary()` counts four tables to answer it.
 */
function UsagePanel({ schoolId }: { schoolId: number }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);

    (async () => {
      try {
        const result = await api.get<UsageReport>(`/schools/${schoolId}/usage`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setReport(result);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          setError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [schoolId, nonce]);

  const columns = useMemo<Column<LimitUsage>[]>(
    () => [
      { key: 'limit', header: 'Limit', primary: true, cell: (row) => <span className="font-medium">{row.label}</span> },
      {
        key: 'used',
        header: 'Used',
        numeric: true,
        cell: (row) =>
          row.measurement === 'per_request' ? (
            <span className="text-muted-soft">per file</span>
          ) : !row.tracked ? (
            <span className="text-muted-soft">not tracked</span>
          ) : (
            quantity(row.used, row.unit)
          ),
      },
      {
        key: 'allowed',
        header: 'Allowed',
        numeric: true,
        cell: (row) =>
          row.unlimited ? (
            'Unlimited'
          ) : (
            `${quantity(row.allowed ?? 0, row.unit)}${row.measurement === 'per_request' ? ' per file' : ''}`
          ),
      },
      {
        key: 'remaining',
        header: 'Remaining',
        numeric: true,
        cell: (row) => {
          if (row.unlimited || row.measurement === 'per_request' || row.remaining === null) {
            return <span className="text-muted-soft">—</span>;
          }
          if (row.overage > 0) {
            /*
             * Over the allowance is two different situations. With overage allowed the excess is
             * billed; without it, the limit should have refused the action, so the figure is the
             * shortfall a report shows rather than something the school was permitted.
             */
            return (
              <span className={row.allowOverage ? 'text-warn' : 'text-danger'}>
                {quantity(row.overage, row.unit)} over{row.allowOverage ? ', billed as overage' : ' the limit'}
              </span>
            );
          }
          return quantity(row.remaining, row.unit);
        },
      },
      { key: 'measured', header: 'Counted', cell: (row) => <span className="text-muted">{measuredAs(row)}</span> },
      {
        key: 'source',
        header: 'Set by',
        hideOnMobile: true,
        cell: (row) => <span className="text-muted">{SOURCE_LABELS[row.source] ?? row.source}</span>,
      },
    ],
    []
  );

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (error) return <ErrorNotice message={error} onRetry={() => setNonce((n) => n + 1)} />;
  if (loading && !report) return <LoadingBlock label="Loading this school’s usage…" />;
  if (!report || report.usage.length === 0) {
    return <EmptyNotice>No limits were reported for this school.</EmptyNotice>;
  }

  /*
   * Derived from the rows rather than from `subscription_state`, which is a cache: when every limit
   * resolved from `default`, no plan limit and no override reached this school, so every fixed
   * allowance is zero. That has two causes the rows cannot tell apart — no subscription in use, or a
   * subscription on a plan with no limits configured (activating a plan needs only a price) — so the
   * notice names both rather than guessing.
   */
  const ungoverned = report.usage.every((row) => row.source === 'default');

  return (
    <FormSection
      title="Usage"
      description="Each limit this school's subscription sets and how much of it is in use. Headcounts are counted live; AI and API allowances reset each billing period."
    >
      {ungoverned ? (
        <Notice tone="info">
          Every limit here is the default, so every fixed allowance is zero. Either this school has no
          subscription in use, or its plan has no limits configured — the plan&apos;s own screen
          shows how many of its limits are set.
        </Notice>
      ) : null}
      <DataTable
        columns={columns}
        rows={report.usage}
        rowKey={(row) => row.limitKey}
        caption="School usage by limit"
        busy={loading}
      />
    </FormSection>
  );
}

/* ─────────────────────────────── the screen ─────────────────────────────── */

export default function SchoolDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : null;

  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const canUsage = can('schools.usage.view');
  const tabs = useMemo(() => (canUsage ? [...BASE_TABS, USAGE_TAB] : BASE_TABS), [canUsage]);
  const [tab, setTab] = useActiveTab(tabs);

  const [school, setSchool] = useState<SchoolDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [missing, setMissing] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!id) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setRefusal(null);
    setMissing(false);

    (async () => {
      try {
        const result = await api.get<{ school: SchoolDetail }>(`/schools/${id}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSchool(result.school);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError && isMissing(caught)) {
          setMissing(true);
        } else if (caught instanceof ApiError) {
          setLoadError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setLoadError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [id, nonce]);

  /* ── the edit form ── */
  const [values, setValues] = useState<FormValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (school) setValues(toValues(school));
  }, [school]);

  /* ── the lifecycle dialogs ── */
  const [pending, setPending] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /* ── the delete confirmation, which asks the operator to type the code ── */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typedCode, setTypedCode] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /* ── the principal picker ── */
  const principals = useCollection<PrincipalOption>(
    '/principals',
    useMemo(() => (school ? { school_id: school.id, limit: 100 } : {}), [school])
  );
  const [principalId, setPrincipalId] = useState('');
  const [principalBusy, setPrincipalBusy] = useState(false);
  const [principalError, setPrincipalError] = useState<string | null>(null);

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (missing) {
    return (
      <div>
        <PageHeader
          title="School not found"
          action={
            <Link href="/super-admin/schools" className="btn btn-secondary">
              Back to schools
            </Link>
          }
        />
        <EmptyNotice
          icon="search"
          title="There is no school at this address"
          action={
            <Link href="/super-admin/schools" className="btn btn-secondary">
              Back to schools
            </Link>
          }
        >
          It may have been deleted, the link may be mistyped, or the school is outside what this
          account can see. The Schools list shows every school that is.
        </EmptyNotice>
      </div>
    );
  }
  if (loadError) return <ErrorNotice message={loadError} onRetry={reload} />;
  if (loading || !school || !values) return <LoadingBlock />;

  /*
   * A non-null local, because the guard above narrows `school` for the render and **not** inside the
   * async handlers below: each closes over the state variable, whose type is still nullable at the
   * point the closure is created. Capturing it here is the narrowing the closures cannot do for
   * themselves, and it also pins the record the request was started against.
   */
  const record = school;

  const canEdit = can('schools.manage');
  const canStatus = can('schools.status');
  const canArchive = can('schools.archive');
  const canAssign = can('schools.assign_principal');

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((current) => (current ? { ...current, [key]: value } : current));
  }

  /*
   * What the PATCH carries. A cleared optional box is sent as `null`, not `''`: every optional field
   * in `update` is `.empty('').allow(null)`, so `''` is turned into "absent" before validation. Clearing
   * one field alone therefore failed `.min(1)` with "Provide at least one field to update", and clearing
   * one beside another edit was silently ignored — the old value came back after a save that said it
   * had worked. The two required fields are sent blank so the schema names them instead.
   */
  const base = toValues(record);
  const changed: Record<string, string | null> = {};
  for (const key of Object.keys(base) as (keyof FormValues)[]) {
    if (values[key] === base[key]) continue;
    const trimmed = values[key].trim();
    changed[key] = trimmed === '' && !REQUIRED_FIELDS.has(key) ? null : trimmed;
  }
  const nothingChanged = Object.keys(changed).length === 0;

  async function save() {
    if (saving || nothingChanged) return;
    setSaving(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const result = await api.patch<{ school: SchoolDetail }>(`/schools/${record.id}`, changed);
      setSchool(result.school);
      success('School updated');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        setFormError(caught.bannerFor(Object.keys(base)));
      } else {
        setFormError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  /*
   * The three transitions, written out rather than built from `pending`.
   *
   * `verify-frontend.js` matches `api.<method>(` followed immediately by the path literal, so a URL
   * assembled from the action name is invisible to the check that exists to catch a route with no
   * caller — the trap the subscription screen recorded after hitting it twice.
   */
  async function runTransition() {
    if (!pending || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    setReasonError(null);
    const body = reason.trim() ? { reason: reason.trim() } : {};
    try {
      const result =
        pending === 'activate'
          ? await api.post<{ school: SchoolDetail }>(`/schools/${record.id}/activate`, {})
          : pending === 'suspend'
            ? await api.post<{ school: SchoolDetail }>(`/schools/${record.id}/suspend`, body)
            : await api.post<{ school: SchoolDetail }>(`/schools/${record.id}/archive`, body);
      setSchool(result.school);
      success(`${LIFECYCLE[pending].label} applied`, `${record.name} is now ${result.school.status}.`);
      setPending(null);
      setReason('');
    } catch (caught) {
      if (caught instanceof ApiError) {
        /*
         * A reason over 255 characters is a 422 keyed `reason`, whose top-level message is
         * "Validation failed" — which is all this dialog used to show. The message belongs on the
         * reason box, named the way the box is labelled.
         */
        const { perField, banner } = splitApiErrors(caught, new Set(['reason']));
        setReasonError(perField.reason ? humaniseFieldError(perField.reason, 'reason', 'Reason') : null);
        setActionError(banner);
      } else {
        setActionError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setActionBusy(false);
    }
  }

  async function removeSchool() {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.delete(`/schools/${record.id}`);
      success(
        'School deleted',
        `${record.name} is out of the Schools list and everyone at it has lost access. Its billing records are kept.`
      );
      /*
       * Nothing here left to show, so back to the list rather than an empty detail screen.
       *
       * `router.push`, not `window.location.href`. The latter was written first and is a **full page
       * reload**: it discards the in-memory access token, so the next screen begins by refreshing the
       * session it did not need to lose. `@next/next/no-location-assign-relative-destination` is the
       * rule that flagged it, on the first run of a linter this frontend had never had.
       */
      router.push('/super-admin/schools');
    } catch (caught) {
      setDeleteError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
      setDeleteBusy(false);
    }
  }

  async function assignPrincipal() {
    if (!principalId || principalBusy) return;
    setPrincipalBusy(true);
    setPrincipalError(null);
    try {
      const result = await api.put<{ school: SchoolDetail }>(`/schools/${record.id}/principal`, {
        user_id: Number(principalId),
      });
      setSchool(result.school);
      success('Principal assigned');
      setPrincipalId('');
    } catch (caught) {
      setPrincipalError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setPrincipalBusy(false);
    }
  }

  /* Which transitions make sense from here. The API is the authority; this only hides the absurd. */
  const offered: string[] = [];
  if (canStatus && record.status !== 'active') offered.push('activate');
  if (canStatus && record.status === 'active') offered.push('suspend');
  if (canArchive && record.status !== 'archived') offered.push('archive');

  const copy = pending ? LIFECYCLE[pending] : null;

  /* A subscription in any state but these two is still live, and deleting the school leaves it so. */
  const subscriptionOpen =
    record.subscription_state !== null && !CLOSED_SUBSCRIPTION_STATES.has(record.subscription_state);

  return (
    <div>
      <PageHeader
        title={record.name}
        description={`${record.code}${record.organization ? ` · ${record.organization.name}` : ''}${
          record.city ? ` · ${record.city}` : ''
        }`}
        action={
          <Link href="/super-admin/schools" className="btn btn-secondary">
            Back to schools
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={record.status} />
        {/*
          * When and why, from the columns the transitions write. Only for the status the school is in
          * now: archiving leaves an earlier suspension's reason on the row, and showing it under
          * "archived" would explain the wrong thing.
          */}
        {record.status === 'suspended' ? (
          <span className="text-sm text-muted">
            {day(record.suspended_at) ? `Since ${day(record.suspended_at)}` : 'Suspended'}
            {record.suspension_reason ? (
              <>
                {' — '}
                <q className="text-ink">{record.suspension_reason}</q>
              </>
            ) : (
              ' — no reason was given'
            )}
          </span>
        ) : record.status === 'archived' && day(record.archived_at) ? (
          <span className="text-sm text-muted">
            Archived {day(record.archived_at)}. Any reason given is kept in the audit trail.
          </span>
        ) : null}
        {record.principal ? (
          <span className="text-sm text-muted">Principal: {record.principal.name}</span>
        ) : (
          <span className="text-sm text-warn">No Principal assigned</span>
        )}
      </div>

      {offered.length > 0 ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {offered.map((action) => (
            <button
              key={action}
              type="button"
              className={`btn ${LIFECYCLE[action].tone === 'danger' ? 'btn-danger' : 'btn-secondary'}`}
              onClick={() => {
                setPending(action);
                setReason('');
                setReasonError(null);
                setActionError(null);
              }}
            >
              {LIFECYCLE[action].label}
            </button>
          ))}
        </div>
      ) : null}

      <Tabs tabs={tabs} active={tab} onChange={setTab} label="School sections" />

      <TabPanel tabKey={tab}>
        {tab === 'details' ? (
          <div className="space-y-8">
            {!canEdit ? (
              <Notice tone="info">
                Editing a school needs the school management permission, which this account does not
                hold.
              </Notice>
            ) : (
              <FormSection
                title="Details"
                description="The school's own record. Its subscription, its people and its settings live elsewhere."
              >
                <form
                  className="space-y-4"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  {formError ? <Notice tone="error">{formError}</Notice> : null}

                  <FormGrid>
                    <Field
                      id="name"
                      label="Name"
                      required
                      value={values.name}
                      error={fieldErrors.name}
                      onChange={(event) => set('name', event.target.value)}
                    />
                    <Field
                      id="code"
                      label="Code"
                      required
                      value={values.code}
                      error={fieldErrors.code}
                      onChange={(event) => set('code', event.target.value)}
                      /*
                       * Per organization, not per platform: the index is `schools_org_code_unique`
                       * over `(organization_id, code)`, and the conflict message says the same.
                       */
                      hint="Unique within its organization — another organization may use the same code. Changing it does not change anything that already refers to this school by id."
                    />
                  </FormGrid>

                  <FormGrid>
                    <Field
                      id="email"
                      label="Email"
                      type="email"
                      value={values.email}
                      error={fieldErrors.email}
                      onChange={(event) => set('email', event.target.value)}
                    />
                    <Field
                      id="phone"
                      label="Phone"
                      value={values.phone}
                      error={fieldErrors.phone}
                      onChange={(event) => set('phone', event.target.value)}
                    />
                  </FormGrid>

                  <Field
                    id="address"
                    label="Address"
                    value={values.address}
                    error={fieldErrors.address}
                    onChange={(event) => set('address', event.target.value)}
                  />

                  <FormGrid>
                    <Field
                      id="city"
                      label="City"
                      value={values.city}
                      error={fieldErrors.city}
                      onChange={(event) => set('city', event.target.value)}
                    />
                    <Field
                      id="state"
                      label="State"
                      value={values.state}
                      error={fieldErrors.state}
                      onChange={(event) => set('state', event.target.value)}
                    />
                  </FormGrid>

                  <Field
                    id="country"
                    label="Country"
                    value={values.country}
                    error={fieldErrors.country}
                    onChange={(event) => set('country', event.target.value)}
                    hint="Clearing any of the contact or address boxes removes that value from the school."
                  />

                  <SubmitButton
                    busy={saving}
                    busyLabel="Saving…"
                    fullWidth={false}
                    disabled={nothingChanged}
                  >
                    Save changes
                  </SubmitButton>
                </form>
              </FormSection>
            )}

            {canArchive ? (
              <FormSection
                title="Delete this school"
                description="Separate from the lifecycle actions above, because it is a much larger thing than archiving."
              >
                <Notice tone="warn">
                  Deleting takes the school out of the product: everyone at it loses access, and its
                  students, teachers, fees and results can no longer be opened through it. It does{' '}
                  <strong>not</strong> remove its subscription, invoices or payments, which stay on the
                  platform&apos;s billing screens, or its user accounts, which stay on the Users screen
                  unable to sign in — and it does not cancel the subscription. The row itself is kept
                  in the database, so this is recoverable by someone with database access and by
                  nobody else. <strong>Archive instead</strong> if the school may come back.
                </Notice>
                <div className="mt-4">
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => {
                      setConfirmDelete(true);
                      setTypedCode('');
                      setDeleteError(null);
                    }}
                  >
                    Delete {record.name}
                  </button>
                </div>
              </FormSection>
            ) : null}
          </div>
        ) : tab === 'usage' ? (
          <UsagePanel schoolId={record.id} />
        ) : (
          <FormSection
            title="Principal"
            description="The Principal is a user of this school whose role is Principal — assigning one here does not create the account."
          >
            {!canAssign ? (
              <Notice tone="info">
                Assigning a Principal needs its own permission, which this account does not hold.
              </Notice>
            ) : (
              <form
                className="space-y-4"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void assignPrincipal();
                }}
              >
                {principalError ? <Notice tone="error">{principalError}</Notice> : null}

                {record.principal ? (
                  <Notice tone="info">
                    Currently <strong>{record.principal.name}</strong> ({record.principal.email}).
                    Choosing another replaces them; the previous Principal keeps their account.
                  </Notice>
                ) : null}

                {/*
                  * Three ways the list can be empty, and they need three different sentences. A read
                  * that was refused or failed used to fall into the third — "this school has no
                  * Principal accounts" — which sent the operator off to create one the school may
                  * already have.
                  */}
                {principals.refusal ? (
                  <Notice tone="warn">
                    This school&apos;s Principal accounts could not be listed: this account cannot read
                    user accounts, which listing them needs. {principals.refusal.message}
                  </Notice>
                ) : principals.error ? (
                  <Notice tone="error">
                    The Principal accounts could not be loaded: {principals.error}{' '}
                    <button
                      type="button"
                      onClick={principals.reload}
                      className="font-medium underline underline-offset-2"
                    >
                      Try again
                    </button>
                  </Notice>
                ) : !principals.loading && principals.rows.length === 0 ? (
                  <Notice tone="warn">
                    This school has no Principal accounts to choose from, and only a Principal who
                    belongs to this school can be assigned.{' '}
                    {can('users.manage') ? (
                      <>
                        <Link
                          href={`/super-admin/principals/new?school_id=${record.id}`}
                          className="font-medium underline underline-offset-2"
                        >
                          Create one for this school
                        </Link>{' '}
                        — the form brings you back here to assign it.
                      </>
                    ) : (
                      'Creating one needs the user management permission.'
                    )}
                  </Notice>
                ) : (
                  <SelectField
                    id="principal"
                    label="Principal"
                    required
                    value={principalId}
                    onChange={(event) => setPrincipalId(event.target.value)}
                    hint={
                      principals.loading
                        ? 'Loading this school’s Principal accounts…'
                        : 'Only users of this school whose role is Principal. The API refuses anything else.'
                    }
                  >
                    <option value="">Choose a Principal…</option>
                    {principals.rows.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name} ({option.email})
                      </option>
                    ))}
                  </SelectField>
                )}

                <SubmitButton
                  busy={principalBusy}
                  busyLabel="Assigning…"
                  fullWidth={false}
                  disabled={!principalId}
                >
                  Assign Principal
                </SubmitButton>
              </form>
            )}
          </FormSection>
        )}
      </TabPanel>

      <Modal
        open={pending !== null}
        onClose={() => {
          if (!actionBusy) setPending(null);
        }}
        title={copy ? copy.title(record.name) : ''}
        description={copy?.description}
        size="sm"
        busy={actionBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={actionBusy}
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
            <SubmitButton
              form="school-transition"
              busy={actionBusy}
              busyLabel={copy?.busy ?? 'Working…'}
              fullWidth={false}
            >
              {copy?.confirm ?? 'Apply'}
            </SubmitButton>
          </>
        }
      >
        <form
          id="school-transition"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void runTransition();
          }}
        >
          {actionError ? <Notice tone="error">{actionError}</Notice> : null}
          {copy?.reason ? (
            <TextAreaField
              id="transition-reason"
              label="Reason"
              rows={3}
              /* `schools.validation.js` caps `reason` at 255; the box now stops where the API does. */
              maxLength={255}
              value={reason}
              error={reasonError}
              onChange={(event) => setReason(event.target.value)}
              hint={copy.reasonHint}
            />
          ) : (
            <p className="text-sm text-muted">
              Activation takes no reason: the API accepts an empty body and records the transition
              itself.
            </p>
          )}
        </form>
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => {
          if (!deleteBusy) setConfirmDelete(false);
        }}
        title={`Delete ${record.name}?`}
        description="This is not archiving. The school leaves the product and nothing on this platform can bring it back."
        size="sm"
        busy={deleteBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={deleteBusy}
              onClick={() => setConfirmDelete(false)}
            >
              Go back
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={deleteBusy || typedCode.trim() !== record.code}
              aria-busy={deleteBusy}
              onClick={() => void removeSchool()}
            >
              {deleteBusy ? 'Deleting…' : 'Delete school'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {deleteError ? <Notice tone="error">{deleteError}</Notice> : null}
          {/*
            * `subscription_state` is the school's cached subscription state. Anything but expired or
            * cancelled is still running — and `remove()` touches no subscription, so it keeps billing
            * a school nobody can reach. Said here, at the moment of deciding, not only in the panel.
            */}
          {subscriptionOpen ? (
            <Notice tone="warn">
              This school&apos;s subscription is <strong>{record.subscription_state?.replace(/_/g, ' ')}</strong>.
              Deleting the school does not cancel it. If billing should stop, cancel the subscription
              on the{' '}
              <Link href="/super-admin/subscriptions" className="font-medium underline underline-offset-2">
                Subscriptions
              </Link>{' '}
              screen first.
            </Notice>
          ) : null}
          {/*
            * Typing the code, rather than a plain confirm button.
            *
            * Every other confirmation in this product is one click, and that is right for actions
            * that can be undone from the same screen. This one cannot: nothing in the product can
            * bring the school back. The friction is the point, and the code is used rather than the
            * name because it is short, unique and unambiguous to type.
            */}
          <Field
            id="confirm-code"
            label={`Type ${record.code} to confirm`}
            value={typedCode}
            onChange={(event) => setTypedCode(event.target.value)}
            hint="The school's code, exactly as it appears at the top of this screen."
          />
        </div>
      </Modal>
    </div>
  );
}
