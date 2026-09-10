'use client';

/**
 * Reports — SRS §22, §33's "Reports", checklist row 4.3. Triage findings 29, 30 and 31.
 *
 * ## What this screen used to say, and why it was wrong
 *
 * It ran one of §22's seven reports and rendered the other six as inert cards, on this stated
 * premise: *"Six of the seven resolve a school before they can count anything, so a platform caller
 * cannot run them at all."* That is false, and it was load-bearing rather than decorative — the
 * cards existed because of it. The chain, each link now asserted in `verify-reports.js`:
 *
 *   - `entitlement.js:256` returns `next()` for `req.tenant.isPlatform` **before any snapshot loads**,
 *     so `requireModule(REPORTS, X)` never refuses a platform caller;
 *   - `permissions.js:254` gives Super Admin `ALL`, so both `requirePermission` calls pass;
 *   - every school-report schema accepts `school_id`;
 *   - `schoolScope.js:46-53` **requires** the id for a caller with no school of their own, and then
 *     **honours** it — the cross-organization branch below it is gated on `tenant.organizationId`,
 *     which is null for a platform caller.
 *
 * Measured, not reasoned: all six answer **200** to a Super Admin naming `?school_id=N`, with the same
 * figures that school's own principal sees, and the same id a principal scoped elsewhere is refused.
 * The refusal for a *missing* id is a **422 validation error naming `school_id`** — not
 * `SCHOOL_CONTEXT_REQUIRED`, which this header used to name and which a platform caller can never
 * reach, since it is raised inside `resolveGatedSchoolId` on the far side of that short-circuit.
 *
 * So the six are not structurally unreachable. They needed one control: a school to name.
 *
 * ## One renderer for seven reports, and it is the exporters' own walk
 *
 * §22's seven reports have seven different payload shapes and there is no eighth endpoint describing
 * them. Rather than seven bespoke tables, the screen flattens whatever comes back into
 * Section / Key / Value — which is not a shortcut but **`reports.service.js` `toRows()`**, the walk
 * `toExcel()` and `toPdf()` already share so the two exports cannot disagree about what a report
 * contains. The screen joining that walk extends the same guarantee to a third consumer: what is on
 * screen, what is in the workbook and what is on the printed page are one function apart.
 *
 * The Subscription Report keeps its own rendering — the state badges and the by-plan table — because
 * it is the one report this screen already displayed well and flattening it would be a regression.
 *
 * ## Export and print
 *
 * `reports.controller.js` has served Excel and PDF since Phase 5.4 with the right MIME and a dated
 * `Content-Disposition`, and until now **no caller in the UI could reach either**: `request()` ends
 * unconditionally in `response.json()`. The documented workaround of typing `?format=excel` into the
 * address bar does not work either — the access token is held in memory and sent as a header, so a
 * pasted URL is unauthenticated. `api.download()` is the missing path, and the buttons are gated on
 * `reports.export` exactly as the router's conditional `exportGuard` gates the request.
 *
 * Print is the third of §22's formats and is **client-side**. `?format=print` stays refused 422 —
 * there is no view engine here to produce a "print-ready payload" — and FR-REPORT-002's actual words
 * are an actor's action, *"User prints the report"*, which `window.print()` over the rendered report
 * plus the `@media print` block in `globals.css` satisfies with nothing invented.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api, saveFile } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { Field, SelectField } from '@/components/form';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/* ─────────────────────────────── the seven reports ─────────────────────────────── */

/** An extra query parameter a report's own schema defines. */
interface ParamSpec {
  key: string;
  label: string;
  /** `select` renders the fixed vocabulary in `options`; the others are plain inputs. */
  kind: 'select' | 'date' | 'text';
  options?: string[];
  /** `.required()` in the report's Joi schema — the screen will not call until it is filled. */
  required?: boolean;
  hint?: string;
}

interface ReportSpec {
  /** The `REPORT_TYPES` value, and the path segment. */
  type: string;
  path: string;
  label: string;
  summary: string;
  /** Both keys the route requires, in the order `reports.routes.js` mounts them. */
  permissions: string[];
  /** School-scoped reports send `school_id`; the Subscription Report does not take one. */
  needsSchool: boolean;
  params?: ParamSpec[];
}

/**
 * The seven, with the parameters each one's schema actually declares.
 *
 * Named here rather than fetched, because there is no endpoint that lists them — `REPORT_TYPES` is a
 * backend constant with no route exposing it. An eighth report would have to be added here too, and
 * that is a real maintenance cost worth stating rather than hiding.
 */
const REPORTS: ReportSpec[] = [
  {
    type: 'student',
    path: '/reports/students',
    label: 'Students',
    summary: 'Enrolment, status and class distribution',
    permissions: ['reports.view', 'students.view'],
    needsSchool: true,
  },
  {
    type: 'attendance',
    path: '/reports/attendance',
    label: 'Attendance',
    summary: 'Presence rates over §16’s own period taxonomy',
    permissions: ['reports.view', 'attendance.view'],
    needsSchool: true,
    /*
     * Both `.required()` in §16's own schema (`attendance.validation.js:118-119`), which §22 reuses
     * verbatim rather than copying — so the two endpoints cannot drift apart on what they accept.
     * Marked required here for the same reason: calling without them is a guaranteed 422.
     */
    params: [
      { key: 'period', label: 'Period', kind: 'select', options: ['daily', 'monthly', 'yearly'], required: true },
      { key: 'date', label: 'Date', kind: 'date', required: true },
    ],
  },
  {
    type: 'fee',
    path: '/reports/fees',
    label: 'Fees',
    summary: 'Billed, collected and outstanding',
    permissions: ['reports.view', 'fees.view'],
    needsSchool: true,
    params: [
      {
        key: 'currency',
        label: 'Currency',
        kind: 'text',
        hint: 'Required when the school holds rows in more than one currency — there is no conversion table.',
      },
    ],
  },
  {
    type: 'expense',
    path: '/reports/expenses',
    label: 'Expenses',
    summary: 'Recorded spending by category',
    permissions: ['reports.view', 'finance.view'],
    needsSchool: true,
    params: [
      { key: 'currency', label: 'Currency', kind: 'text', hint: 'As above — §18 refuses a window holding two.' },
    ],
  },
  {
    type: 'exam',
    path: '/reports/exams',
    label: 'Exams',
    summary: 'Results and pass rates',
    permissions: ['reports.view', 'exams.view'],
    needsSchool: true,
  },
  {
    type: 'teacher',
    path: '/reports/teachers',
    label: 'Teachers',
    summary: 'Headcount, subjects and workload',
    permissions: ['reports.view', 'teachers.view'],
    needsSchool: true,
  },
  {
    type: 'subscription',
    path: '/reports/subscriptions',
    label: 'Subscriptions',
    summary: 'Platform-wide, and the only one that takes no school',
    permissions: ['reports.subscription.view'],
    needsSchool: false,
  },
];

/* ─────────────────────────────── shapes off the wire ─────────────────────────────── */

interface PlanRow {
  plan_id: number;
  plan_name: string | null;
  plan_code: string | null;
  count: number;
}

interface SubscriptionReport {
  type: string;
  scope: { platform?: boolean; organization_id?: number };
  window: { from: string | null; to: string | null };
  total: number;
  by_state: Record<string, number>;
  by_plan: PlanRow[];
}

/** Every report is `{ report: … }`; only the subscription one has a shape this screen knows. */
type AnyReport = Record<string, unknown>;

interface SchoolOption {
  id: number;
  name: string;
  code: string;
}

/** One flattened line, exactly as `reports.service.js` `toRows()` produces it. */
interface FlatRow {
  section: string;
  key: string;
  value: string | number | boolean;
}

/**
 * `reports.service.js:427-449`, reproduced.
 *
 * Deliberately a transcription rather than an improvement. Its whole value is that the screen shows
 * what the workbook and the PDF contain; a "better" flattening here would be a fourth answer to a
 * question three consumers had agreed on.
 */
/**
 * Leaf keys whose value is money, and the section that contains nothing else.
 *
 * There is no schema anywhere saying which of a report's figures are amounts and which are counts,
 * so this is named rather than inferred — and named narrowly, from the two reports that carry money.
 * The Fee report's amounts are `billed`, `collected` and `outstanding`; the Expense report delegates
 * to `finance.report()`, whose amounts are `income.total`, `expense.total`, `net_balance` and every
 * leaf under `by_category`. Everything else — `assignments`, `by_status`, headcounts — is a count and
 * must not be decorated with cents.
 */
const MONEY_KEYS = new Set(['billed', 'collected', 'outstanding', 'total', 'net_balance']);
const MONEY_SECTIONS = ['by_category'];

/**
 * Flatten a report into Section / Key / Value, the walk `toExcel()` and `toPdf()` already share.
 *
 * ## It used to stop one level down, and the Expense report is two
 *
 * `finance.report()` answers `{ income: { total, by_category: {…} }, expense: { … }, net_balance }`.
 * The old version walked `income`, pushed `total` correctly, and then pushed `by_category` — an
 * **object** — straight into a cell, where `String(value)` rendered it as `[object Object]`. The
 * whole category breakdown was lost, twice, on the one report that exists to show it.
 *
 * So the walk recurses, and the key carries the path (`by_category.salaries`). Arrays keep their
 * 1-based index for the same reason they did before: a reader counting rows in the workbook and on
 * the screen should see the same numbering.
 */
function toRows(report: AnyReport): FlatRow[] {
  const rows: FlatRow[] = [];

  const isMoney = (section: string, key: string) => {
    const leaf = key.split('.').pop() ?? key;
    if (MONEY_KEYS.has(leaf)) return true;
    return MONEY_SECTIONS.some((name) => key.startsWith(`${name}.`) || section === name);
  };

  const push = (section: string, key: string, value: unknown) => {
    /*
     * Money to two decimal places. `String(1250.5)` is `"1250.5"`, which in a column of amounts
     * reads as five cents rather than fifty; the server rounds these to the currency scale before
     * sending them, and dropping a digit here undoes that.
     */
    const formatted =
      typeof value === 'number' && isMoney(section, key) ? value.toFixed(2) : value;
    rows.push({ section, key, value: formatted as string | number | boolean });
  };

  const walk = (section: string, prefix: string, value: unknown) => {
    if (value === null || value === undefined) {
      push(section, prefix, '');
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry, i) => {
        if (entry && typeof entry === 'object') {
          for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
            walk(prefix, `${i + 1}.${k}`, v);
          }
        } else {
          walk(prefix, String(i + 1), entry);
        }
      });
      return;
    }

    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        /* One level down becomes the section; anything deeper extends the key path. */
        if (section === 'summary') walk(prefix, k, v);
        else walk(section, `${prefix}.${k}`, v);
      }
      return;
    }

    push(section, prefix, value);
  };

  for (const [key, value] of Object.entries(report)) walk('summary', key, value);
  return rows;
}

/** How many schools the selector loads. See the note it renders when there are more. */
const SCHOOL_LIMIT = 100;

export default function ReportsPage() {
  const { can } = useAuth();

  const [selected, setSelected] = useState<string>('subscription');
  const [schoolId, setSchoolId] = useState<string>('');
  const [params, setParams] = useState<Record<string, string>>({});

  const [schools, setSchools] = useState<SchoolOption[]>([]);
  const [schoolTotal, setSchoolTotal] = useState<number | null>(null);
  const [schoolsError, setSchoolsError] = useState<string | null>(null);

  /*
   * Debounced copies of the free-text parameters — see `query` below for why only those.
   * `params` is what the inputs show; this is what the request is built from.
   */
  const [typed, setTyped] = useState<Record<string, string>>({});

  const [report, setReport] = useState<AnyReport | null>(null);
  /*
   * `true` from the start, as `useCollection` does. It was `false`, and the default tab (Subscriptions)
   * needs no school and no parameter, so a fetch is certain on mount — but `setLoading(true)` runs
   * inside the read effect, after the first commit, so every visit painted "Nothing was returned for
   * this report." for a frame before the report arrived. The effect sets it back to `false` itself
   * whenever there is nothing to fetch.
   */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const spec = useMemo(
    () => REPORTS.find((r) => r.type === selected) ?? REPORTS[REPORTS.length - 1],
    [selected]
  );

  /** Every key the route requires, checked the way the router checks them: all of them. */
  const allowed = spec.permissions.every((key) => can(key));

  /* ── the school list, loaded once ── */

  useEffect(() => {
    /* Only a caller who can read schools needs it; the Subscription Report never does. */
    if (!can('schools.view')) return undefined;

    const controller = new AbortController();
    (async () => {
      try {
        const { data, meta } = await api.page<SchoolOption[]>('/schools', {
          query: { limit: SCHOOL_LIMIT, sortBy: 'name', sortOrder: 'asc' },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSchools(data);
        setSchoolTotal(meta?.total ?? data.length);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if ((caught as Error)?.name !== 'AbortError') {
          setSchoolsError(
            caught instanceof ApiError ? caught.message : 'Could not load the list of schools.'
          );
        }
      }
    })();
    return () => controller.abort();
  }, [can]);

  /* ── what is missing before a call can be made ── */

  const missing = useMemo(() => {
    const gaps: string[] = [];
    if (spec.needsSchool && !schoolId) gaps.push('a school');
    for (const param of spec.params ?? []) {
      if (param.required && !params[param.key]) gaps.push(param.label.toLowerCase());
    }
    return gaps;
  }, [spec, schoolId, params]);

  /*
   * The free-text parameters reach the request 300 ms after the last keystroke, not on each one.
   *
   * `params` fed `query` directly, and `query` is a dependency of the read effect, so typing "USD"
   * into the Fees report's Currency box sent three `/reports/fees` calls. The two in the middle
   * filtered on "U" and "US" — `currency` is `Joi.string().uppercase().max(10)`, so a partial code is
   * accepted, and `where.currency = 'U'` matches nothing — and painted a school with no fees between
   * keystrokes. Each also spent the pre-authentication `apiLimiter` budget on a grouped SUM. The same
   * 300 ms the list screens use for their search boxes, for the same two reasons. Selects and dates
   * are one deliberate change each, so they stay immediate.
   */
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const param of spec.params ?? []) {
      if (param.kind === 'text' && params[param.key]) next[param.key] = params[param.key];
    }
    /*
     * Kept as the same object when nothing typed has changed. `next` is a new object on every run —
     * and this runs after every select, date and report switch too — so storing it unconditionally
     * rebuilt `query` with the same contents 300 ms later and fetched each report twice.
     */
    const timer = setTimeout(
      () => setTyped((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next)),
      300
    );
    return () => clearTimeout(timer);
  }, [spec, params]);

  /** The query both the read and the two exports send, so they cannot describe different reports. */
  const query = useMemo(() => {
    const q: Record<string, string> = {};
    if (spec.needsSchool && schoolId) q.school_id = schoolId;
    for (const param of spec.params ?? []) {
      const value = param.kind === 'text' ? typed[param.key] : params[param.key];
      if (value) q[param.key] = value;
    }
    return q;
  }, [spec, schoolId, params, typed]);

  /* ── the read ── */

  useEffect(() => {
    if (!allowed || missing.length > 0) {
      setReport(null);
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);
    setExportError(null);

    (async () => {
      try {
        const result = await api.get<{ report: AnyReport }>(spec.path, {
          query,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setReport(result.report ?? null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setReport(null);
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          /*
           * A 422 here is usually informative rather than a bug — "this school holds two currencies,
           * name one" arrives as a field error — so the field is named alongside the message.
           */
          const fields = caught.fieldErrors();
          const named = Object.entries(fields)
            .map(([field, message]) => (field ? `${field}: ${message}` : message))
            .join(' ');
          setError(named || caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [allowed, missing.length, spec.path, query, nonce]);

  /* ── the two exports ── */

  const runExport = useCallback(
    async (format: 'excel' | 'pdf') => {
      setExporting(format);
      setExportError(null);
      try {
        const file = await api.download(
          spec.path,
          { query: { ...query, format } },
          `report-${spec.type}.${format === 'excel' ? 'xlsx' : 'pdf'}`
        );
        saveFile(file);
      } catch (caught) {
        setExportError(
          caught instanceof ApiError ? caught.message : 'The export could not be downloaded.'
        );
      } finally {
        setExporting(null);
      }
    },
    [spec, query]
  );

  const schoolName = useMemo(
    () => schools.find((s) => String(s.id) === schoolId)?.name ?? null,
    [schools, schoolId]
  );

  const flatColumns = useMemo<Column<FlatRow>[]>(
    () => [
      { key: 'section', header: 'Section', cell: (row) => <span className="text-muted">{row.section}</span> },
      { key: 'key', header: 'Key', cell: (row) => <span className="font-medium">{row.key}</span> },
      {
        key: 'value',
        header: 'Value',
        cell: (row) =>
          row.value === '' ? (
            <span className="text-muted-soft">—</span>
          ) : (
            <span className="tabular-nums">{String(row.value)}</span>
          ),
      },
    ],
    []
  );

  const planColumns = useMemo<Column<PlanRow>[]>(
    () => [
      {
        key: 'plan',
        header: 'Plan',
        /*
         * `plan_name` is null when the plan row was deleted out from under a subscription that still
         * references it. Showing the id is more useful than an em-dash: it is what an administrator
         * would search the audit trail with.
         */
        cell: (row) =>
          row.plan_name ?? <span className="text-muted-soft">plan #{row.plan_id} (removed)</span>,
      },
      { key: 'code', header: 'Code', cell: (row) => <code className="text-xs text-muted">{row.plan_code ?? '—'}</code> },
      { key: 'count', header: 'Subscriptions', numeric: true, cell: (row) => row.count },
    ],
    []
  );

  /*
   * Branch on the **payload's** discriminator, not on the selected tab.
   *
   * This read `spec.type === 'subscription'`, and the tab handler changes only the selection —
   * `report` is cleared inside the read effect, which has not run yet. So clicking Subscriptions
   * while a Students (or Fees, Exams, Teachers) report was on screen produced one render with
   * `spec.type === 'subscription'`, `loading === false` and `report` still the **previous** payload,
   * cast to a shape it does not have. `Object.entries(subscription.by_state)` then threw mid-render
   * on `undefined`, and with no `error.tsx` anywhere under `app/` the crash reached Next's default
   * handler and the screen was gone until a reload.
   *
   * `reports.service.js` puts `type` on every report, so the payload can answer this about itself.
   * The tab handler clears `report` as well — the cast is now safe either way, but a screen showing
   * one report's figures under another report's heading for a frame is its own small lie.
   */
  const subscription =
    report && report.type === 'subscription' ? (report as unknown as SubscriptionReport) : null;
  const flatRows = report && !subscription ? toRows(report) : [];

  return (
    <div>
      <PageHeader
        title="Reports"
        description="SRS §22 defines seven reports. Six are a school’s; the seventh is the platform’s."
      />

      {/* Provenance the screen does not need and a sheet of paper does. */}
      <div className="print-only mb-4">
        <h1 className="text-lg font-semibold">{spec.label} report</h1>
        <p className="text-sm">
          {schoolName ? `${schoolName} — ` : ''}
          {Object.entries(query)
            .filter(([key]) => key !== 'school_id')
            .map(([key, value]) => `${key}: ${value}`)
            .join(', ')}
        </p>
      </div>

      {/* ── the controls ── */}
      <div className="no-print mb-6 space-y-4">
        {/*
          * Seven toggle buttons, one pressed. The selected one used to differ only by its fill — no
          * `aria-pressed`, so a screen reader heard seven identical buttons and nothing said which
          * report was on screen. And an unreachable report was `disabled` with its reason in a
          * `title`: a disabled button takes no focus, so "Requires …" was never announced to anyone
          * not holding a mouse over it. Now it is `aria-disabled` — still focusable, still refusing
          * the click — and the reason is part of its accessible name.
          */}
        <div className="flex flex-wrap gap-2" role="group" aria-label="Report">
          {REPORTS.map((entry) => {
            const reachable = entry.permissions.every((key) => can(key));
            const current = entry.type === selected;
            const requirement = `Requires ${entry.permissions.join(' and ')}`;
            return (
              <button
                key={entry.type}
                type="button"
                onClick={() => {
                  /*
                   * Re-pressing the current report is a no-op. It used to clear the report, and with
                   * nothing in the read effect's dependencies changed, no fetch followed — the screen
                   * sat on "Nothing was returned" until something else moved.
                   */
                  if (!reachable || current) return;
                  setSelected(entry.type);
                  setParams({});
                  /* The previous report is not this report. See the cast above. */
                  setReport(null);
                  /* Nor are its typed parameters — the debounce would carry them over for 300 ms. */
                  setTyped({});
                  /* A new report is about to be fetched; say so rather than "nothing was returned". */
                  setLoading(true);
                }}
                aria-pressed={current}
                aria-disabled={!reachable || undefined}
                title={reachable ? entry.summary : requirement}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  current
                    ? /* `text-brand-contrast`, not `text-white`: in dark mode `--brand` lightens and
                         white on it fails contrast. The token is white in light, near-black in dark. */
                      'border-brand bg-brand text-brand-contrast'
                    : reachable
                      ? 'border-border-strong hover:border-brand'
                      : 'cursor-not-allowed border-border-strong opacity-50'
                }`}
              >
                {entry.label}
                {reachable ? null : <span className="sr-only"> — {requirement}</span>}
              </button>
            );
          })}
        </div>

        <p className="text-sm text-muted">{spec.summary}</p>

        <div className="flex flex-wrap items-end gap-3">
          {/*
            * The shared field wrappers, like every other form in the product. This panel had its own
            * labels (`text-xs` where a field label is `text-sm`) and marked a required parameter with
            * a bare ` *` — a convention rather than a label, and invisible to anyone not looking at
            * the glyph. `required` on the wrapper says the word.
            */}
          {spec.needsSchool ? (
            <SelectField
              id="school"
              label="School"
              value={schoolId}
              onChange={(event) => setSchoolId(event.target.value)}
              className="sm:min-w-64"
            >
              <option value="">Choose a school…</option>
              {schools.map((school) => (
                <option key={school.id} value={school.id}>
                  {school.name} ({school.code})
                </option>
              ))}
            </SelectField>
          ) : null}

          {(spec.params ?? []).map((param) => (
            <div key={param.key} className="max-w-xs">
              {param.kind === 'select' ? (
                <SelectField
                  id={param.key}
                  label={param.label}
                  required={param.required}
                  hint={param.hint}
                  value={params[param.key] ?? ''}
                  onChange={(event) =>
                    setParams((prev) => ({ ...prev, [param.key]: event.target.value }))
                  }
                >
                  <option value="">Choose…</option>
                  {(param.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </SelectField>
              ) : (
                <Field
                  id={param.key}
                  label={param.label}
                  required={param.required}
                  hint={param.hint}
                  type={param.kind === 'date' ? 'date' : 'text'}
                  value={params[param.key] ?? ''}
                  onChange={(event) =>
                    setParams((prev) => ({ ...prev, [param.key]: event.target.value }))
                  }
                />
              )}
            </div>
          ))}
        </div>

        {spec.needsSchool && schoolsError ? (
          <p className="text-sm text-danger">{schoolsError}</p>
        ) : null}
        {spec.needsSchool && schoolTotal !== null && schoolTotal > schools.length ? (
          <p className="text-xs text-muted-soft">
            Showing the first {schools.length} of {schoolTotal} schools by name.
          </p>
        ) : null}

        {/* Export and print, on the report that is actually on screen. */}
        {report ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {can('reports.export') ? (
              <>
                <button
                  type="button"
                  onClick={() => runExport('excel')}
                  disabled={exporting !== null}
                  className="btn btn-secondary btn-sm"
                >
                  {exporting === 'excel' ? 'Preparing…' : 'Export Excel'}
                </button>
                <button
                  type="button"
                  onClick={() => runExport('pdf')}
                  disabled={exporting !== null}
                  className="btn btn-secondary btn-sm"
                >
                  {exporting === 'pdf' ? 'Preparing…' : 'Export PDF'}
                </button>
              </>
            ) : null}
            {/*
             * Print needs no permission and no server call. `reports.export` guards bytes leaving the
             * server; this prints what the caller is already looking at, so requiring the key would
             * deny a capability the browser gives them anyway through Ctrl+P.
             */}
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-md border border-border-strong px-3 py-1.5 text-sm hover:border-teal"
            >
              Print
            </button>
          </div>
        ) : null}

        {exportError ? <p className="text-sm text-danger">{exportError}</p> : null}
      </div>

      {/* ── the report ── */}
      <section>
        {!allowed ? (
          <RefusalNotice
            refusal={{
              code: 'INSUFFICIENT_PERMISSION',
              message: `${spec.permissions.join(' and ')} are required for the ${spec.label} report.`,
            }}
          />
        ) : missing.length > 0 ? (
          <EmptyNotice>
            Choose {missing.join(' and ')} to run the {spec.label} report.
          </EmptyNotice>
        ) : refusal ? (
          <RefusalNotice refusal={refusal} />
        ) : error ? (
          <ErrorNotice message={error} onRetry={() => setNonce((n) => n + 1)} />
        ) : loading ? (
          <LoadingBlock />
        ) : !report ? (
          <EmptyNotice>Nothing was returned for this report.</EmptyNotice>
        ) : subscription ? (
          subscription.total === 0 ? (
            <EmptyNotice>No subscriptions exist yet, so there is nothing to report on.</EmptyNotice>
          ) : (
            <>
              <p className="mb-3 text-sm">
                <strong className="tabular-nums">{subscription.total}</strong> subscription
                {subscription.total === 1 ? '' : 's'} across the platform.
              </p>

              <div className="mb-4 flex flex-wrap gap-2">
                {Object.entries(subscription.by_state).map(([state, count]) => (
                  <span
                    key={state}
                    className="inline-flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs"
                  >
                    {/* §30 Rule 1: the plan is displayed, never branched on. */}
                    <StatusBadge status={state} />
                    <span className="tabular-nums">{count}</span>
                  </span>
                ))}
              </div>

              <DataTable
                columns={planColumns}
                rows={subscription.by_plan}
                rowKey={(row) => row.plan_id}
                caption="Subscriptions by plan"
            busy={loading}
          />
            </>
          )
        ) : flatRows.length === 0 ? (
          <EmptyNotice>This report came back empty.</EmptyNotice>
        ) : (
          <DataTable
            columns={flatColumns}
            rows={flatRows}
            rowKey={(row) => `${row.section}:${row.key}`}
            caption={`${spec.label} report${schoolName ? ` — ${schoolName}` : ''}`}
            busy={loading}
          />
        )}
      </section>
    </div>
  );
}
