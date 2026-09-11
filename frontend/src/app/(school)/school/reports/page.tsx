'use client';

/**
 * Reports — SRS §22, FR-REPORT-001 and FR-REPORT-002, for a school's own staff.
 *
 * ## Why a school needed a screen of its own
 *
 * The only report screen was `super-admin/reports`, and a school cannot use it: its six school
 * reports need a school named from a picker fed by `GET /schools`, which answers to `schools.view` —
 * a platform key no school role holds. FR-REPORT-001's actors are "Super Admin / Principal / School
 * Admin / Accountant / Teacher" (SRS:1190), and the four school ones hold `reports.view` and
 * `reports.export` in the seeded catalogue, so every one of them had report permissions and nowhere
 * to use them. This screen is the same six reports with the school taken from the session:
 * `resolveSchool()` scopes a school caller to their own school without being told, so no `school_id`
 * is ever sent — naming one is how a request ends up `CROSS_SCHOOL_ACCESS`.
 *
 * Not the Subscription Report. `reports.subscription.view` is granted to Super Admin and Organization
 * Admin only, and that report is about the platform's subscriptions, not about a school's records.
 *
 * ## Each report is offered to exactly the callers its route admits
 *
 * `reports.routes.js` requires two keys on every school report — `reports.view` and the reported
 * module's own read — so that a report is a way to read rows the caller could already read, never a
 * way around the permission on them. The tabs are filtered on the same pair: a seeded Teacher sees
 * Students, Attendance and Exams, and an Accountant sees Students, Fees and Expenses. The module gate
 * stays the server's: a plan without a module answers `MODULE_NOT_SUBSCRIBED`, which `RefusalNotice`
 * explains, rather than this file re-deciding it from a snapshot that can be older than the plan.
 *
 * ## Owner decision D9: exporting and printing are Premium Reports
 *
 * `docs/OWNER-DECISIONS.md` D9 — Premium Reports "unlocks report exports — PDF, Excel and Print.
 * Without it a school still sees every report on screen." The server enforces the two formats it
 * produces: both sit behind `requireFeature('premium_reports')` in `reports.routes.js`. Print is the
 * browser's, so the screen is the only place it can be gated. All three are offered on one condition:
 * `reports.export`, whose catalogue name is "Export reports (PDF / Excel / Print)", **and** the
 * `premium_reports` feature in the school's entitlement snapshot — `/auth/me` carries it and
 * `useEntitlements().hasFeature` reads it, the same snapshot `requireFeature()` consults. Without the
 * feature every report still renders, and a sentence says what would add the three.
 *
 * The platform screen leaves Print ungated, and its reason is exactly what differs here: a platform
 * caller has no school, and so no school feature to check (`requireFeature()` passes them outright).
 *
 * ## The filters are each report's own schema, fed by pickers where one can be
 *
 * Every filter `reports.validation.js` declares for a report is offered for it — the window, the
 * class and section, the session, the student status, the exam, the attendance period and student,
 * the teachers' active flag, and the currency. None of them is an id box: "Grade 7B is `class_id=12`"
 * is not something anybody can be asked to know. Each picker needs its own list, and each list its
 * own view key (`classes.view`, `sessions.view`, `students.view`); a picker the caller cannot feed is
 * left off and said to be, and the report still runs without it, because every one of those filters
 * narrows and none is required. Only §16's `period` and `date` are required, and they start filled.
 *
 * ## One renderer for six reports
 *
 * The six payloads have six shapes and no endpoint describes them, so the report is flattened into
 * section / figure / value — the walk `reports.service.js toRows()` gives the Excel and PDF exports,
 * so what is on screen and what is exported are the same figures. Two differences, both about who
 * reads it: the four provenance keys (`type`, `school`, `scope`, `delegated_to`) are in the heading
 * rather than the table, and a list of classes reads "Grade 7 — 30" rather than three rows per class
 * with the class's database id among them.
 */

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api, saveFile } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useEntitlements } from '@/lib/entitlements';
import { splitApiErrors } from '@/lib/formErrors';
import { localDay } from '@/lib/instants';
import { formatAmountWithCode } from '@/lib/money';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { OPTION_LIMIT, useClassSections, useWholeList } from '@/lib/useTimetablePickers';
import type { Picker, SessionOption } from '@/lib/useTimetablePickers';
import { Field, Notice, SearchField, SelectField } from '@/components/form';
import { Icon, Spinner } from '@/components/icon';
import { Tabs, TabPanel, useActiveTab } from '@/components/tabs';
import type { TabDef } from '@/components/tabs';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
} from '@/components/table';

/* ─────────────────────────────── the six reports ─────────────────────────────── */

/** Every query key a school report's schema declares, bar `school_id` and `format`. */
type FilterKey =
  | 'from'
  | 'to'
  | 'class_id'
  | 'section_id'
  | 'academic_session_id'
  | 'status'
  | 'period'
  | 'date'
  | 'student_id'
  | 'currency'
  | 'exam_id'
  | 'is_active';

interface ReportSpec {
  /** The `REPORT_TYPES` value the payload carries as `type`. */
  type: string;
  path: string;
  label: string;
  summary: string;
  /** Both keys `reports.routes.js` requires, in the order it mounts them. */
  permissions: [string, string];
  /** The keys this report's Joi schema accepts, in the order the controls are drawn. */
  filters: FilterKey[];
  /** What `from`/`to` is a window on, in words — each report's window is on a different column. */
  window?: { from: string; to: string };
}

/**
 * The six, with the filters each schema in `reports.validation.js` actually declares.
 *
 * Named here rather than fetched, because there is no endpoint that lists them — the platform screen
 * keeps the same table for the same reason, and a seventh school report would have to be added to
 * both.
 */
const REPORTS: ReportSpec[] = [
  {
    type: 'student',
    path: '/reports/students',
    label: 'Students',
    summary: 'Enrolment by status, by gender and by class.',
    permissions: ['reports.view', 'students.view'],
    filters: ['from', 'to', 'class_id', 'section_id', 'academic_session_id', 'status'],
    window: { from: 'Admitted on or after', to: 'Admitted on or before' },
  },
  {
    type: 'attendance',
    path: '/reports/attendance',
    label: 'Attendance',
    summary: 'Daily, monthly or yearly student attendance and its percentage — the §16 report itself.',
    permissions: ['reports.view', 'attendance.view'],
    filters: ['period', 'date', 'class_id', 'section_id', 'student_id', 'academic_session_id'],
  },
  {
    type: 'fee',
    path: '/reports/fees',
    label: 'Fees',
    summary: 'Fees billed, collected and outstanding.',
    permissions: ['reports.view', 'fees.view'],
    filters: ['from', 'to', 'class_id', 'academic_session_id', 'currency'],
    window: { from: 'Due on or after', to: 'Due on or before' },
  },
  {
    type: 'expense',
    path: '/reports/expenses',
    label: 'Expenses',
    summary: 'Income and expense by category, and the net balance — the §18 financial report.',
    permissions: ['reports.view', 'finance.view'],
    filters: ['from', 'to', 'currency'],
    window: { from: 'Dated on or after', to: 'Dated on or before' },
  },
  {
    type: 'exam',
    path: '/reports/exams',
    label: 'Exams',
    summary: 'Results, pass rate and grades, from what each exam’s generated results stored.',
    permissions: ['reports.view', 'exams.view'],
    filters: ['exam_id', 'class_id', 'section_id', 'academic_session_id'],
  },
  {
    type: 'teacher',
    path: '/reports/teachers',
    label: 'Teachers',
    summary: 'Headcount, active and inactive, and by designation.',
    permissions: ['reports.view', 'teachers.view'],
    filters: ['from', 'to', 'is_active'],
    window: { from: 'Joined on or after', to: 'Joined on or before' },
  },
];

/** The two `.required()` keys, both §16's. The screen fills them rather than sending a certain 422. */
const REQUIRED: FilterKey[] = ['period', 'date'];

/** FR-ATT-002's three periods, exactly — `Joi.string().valid('daily', 'monthly', 'yearly')`. */
const PERIODS = [
  { value: 'daily', label: 'Daily' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];

/**
 * `STUDENT_STATUS` in `config/constants.js`, which the Student Report's `status` is `.valid()` against —
 * a word outside it is a 422, so the list mirrors the constant rather than approximating it.
 */
const STUDENT_STATUSES = ['active', 'promoted', 'transferred', 'left', 'graduated', 'inactive'];

/** The feature Premium Reports unlocks — `ADDON_EFFECTS.premium_reports.target`. See D9 above. */
const PREMIUM_REPORTS = 'premium_reports';

/* ─────────────────────────────── shapes and wording ─────────────────────────────── */

/** Every report is `{ report: … }`, and each has its own shape; the walk below reads any of them. */
type AnyReport = Record<string, unknown>;

interface ExamOption {
  id: number;
  name: string;
  class: { id: number; name: string } | null;
  section?: { id: number; name: string } | null;
}

interface StudentOption {
  id: number;
  student_id: string;
  first_name: string;
  last_name: string | null;
  roll_number: string | null;
}

/** One flattened line: which part of the report, which figure, and the figure. */
interface FlatRow {
  section: string;
  /** The figure's path in the payload, dot-joined — what `isMoney` reads. */
  key: string;
  /** The path's last segment, kept whole: a stored name may itself contain a dot. */
  leaf: string;
  /** The figure as a person reads it — identifiers reworded, stored names exactly as stored. */
  label: string;
  value: unknown;
  /** The leaf is a name taken from the data — a class, a grade, a designation — not an identifier. */
  stored?: boolean;
  /**
   * The id beside a counted name, when the payload sends one — `class_id` for a class — and the key it
   * came under. A class name is unique only within its session, so the name alone keys nothing.
   */
  id?: unknown;
  idKey?: string;
  /**
   * The session a counted class belongs to, when the entry names one — the Student Report's `by_class`
   * carries `session_name` beside each class. Null for a class whose session was deleted (the foreign
   * key is `SET NULL`). What tells two same-named classes apart; see `ReportPanel`'s `rows`.
   */
  session?: string | null;
}

/* Pinned to `en-US`, as the dashboard pins its own, so a count is grouped the same way everywhere. */
const COUNT = new Intl.NumberFormat('en-US');

/** `by_status` → `By status`. Only for identifiers: a stored name is never reworded. */
function humanise(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) return value;
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function studentLabel(row: StudentOption): string {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ');
  return `${name} (${row.roll_number ? `roll ${row.roll_number} · ` : ''}${row.student_id})`;
}

function examLabel(exam: ExamOption): string {
  const who = exam.class
    ? `${exam.class.name}${exam.section ? `, section ${exam.section.name}` : ''}`
    : null;
  return who ? `${exam.name} — ${who}` : exam.name;
}

/** The keys that tell a reader where a report came from; the heading says them instead. */
const PROVENANCE = new Set(['type', 'school', 'scope', 'delegated_to']);

/**
 * The count maps whose keys are names a school typed rather than identifiers.
 *
 * `reports.service.js countBy()` keys its map by the grouped column's value. For `status`, `gender`,
 * `outcome` and §18's categories that value is an enum identifier, and `active` reads better as
 * "Active". For the Teacher Report's `by_designation` and the Exam Report's `by_grade` it is a free
 * `STRING` column — `teachers.designation`, `results.grade_name` — so the key is the school's own
 * name for the thing, and it is shown exactly as stored: rewording it turned "Sr. Teacher" into
 * "Sr · Teacher", because the dot in the name was read as a path separator.
 */
const STORED_NAME_MAPS = new Set(['by_designation', 'by_grade']);

/** `countBy()`'s own word for a NULL in the grouped column — the server's identifier, not a name. */
const UNSPECIFIED = 'unspecified';

/** One step of a figure's path, and whether it is a stored name rather than an identifier. */
interface Segment {
  key: string;
  stored: boolean;
}

const isStoredUnder = (parent: string, key: string) => STORED_NAME_MAPS.has(parent) && key !== UNSPECIFIED;

/**
 * A report flattened the way `reports.service.js toRows()` flattens it for Excel and PDF — one level
 * of object becomes the section, anything deeper extends the key — recursing where the platform
 * screen's copy learned it had to, because the Expense Report nests `by_category` two levels down.
 *
 * The path is carried as segments, not as a dot-joined string, so a stored name that contains a dot
 * stays one segment and is never split.
 *
 * An array of counted names (`by_class: [{ class_id, class_name, academic_session_id, session_name,
 * count }]`) becomes one line per name, the name as the figure: see the header. The id and the session
 * the entry carries beside its name ride along on the row, because the name is not unique — see
 * `ReportPanel`'s `rows`. `session_name` is a name too, so it is passed over when choosing which
 * `_name` the line is about.
 */
function toRows(report: AnyReport): FlatRow[] {
  const rows: FlatRow[] = [];
  const keyOf = (path: Segment[]) => path.map((segment) => segment.key).join('.');

  const walk = (section: string, path: Segment[], value: unknown) => {
    const prefix = keyOf(path);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          const nameKey = Object.keys(record).find((key) => key.endsWith('_name') && key !== 'session_name');
          if (nameKey && typeof record.count === 'number') {
            const name = typeof record[nameKey] === 'string' ? (record[nameKey] as string) : `Unnamed ${index + 1}`;
            const idKey = nameKey.replace(/_name$/, '_id');
            rows.push({
              section: prefix,
              key: name,
              leaf: name,
              label: name,
              value: record.count,
              stored: true,
              ...(idKey in record ? { id: record[idKey], idKey } : {}),
              ...('session_name' in record
                ? { session: typeof record.session_name === 'string' ? record.session_name : null }
                : {}),
            });
          } else {
            for (const [key, inner] of Object.entries(record)) {
              walk(prefix, [{ key: String(index + 1), stored: false }, { key, stored: false }], inner);
            }
          }
        } else {
          walk(prefix, [{ key: String(index + 1), stored: false }], entry);
        }
      });
      return;
    }

    if (value && typeof value === 'object') {
      const parent = path[path.length - 1]?.key ?? '';
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        const segment = { key, stored: isStoredUnder(parent, key) };
        if (section === 'summary') walk(prefix, [segment], inner);
        else walk(section, [...path, segment], inner);
      }
      return;
    }

    const last = path[path.length - 1];
    rows.push({
      section,
      key: prefix,
      leaf: last?.key ?? prefix,
      label: path.map((segment) => (segment.stored ? segment.key : humanise(segment.key))).join(' · '),
      value,
      stored: last?.stored ?? false,
    });
  };

  for (const [key, value] of Object.entries(report)) {
    if (!PROVENANCE.has(key)) walk('summary', [{ key, stored: false }], value);
  }
  return rows;
}

/**
 * Whether a figure is money, decided by the report it is in.
 *
 * Not by the key alone. The platform screen treats every `total` as money, and the Student and
 * Teacher Reports' `total` is a headcount — 120 students is not 120.00. Only two reports carry money:
 * the Fee Report's `billed`, `collected` and `outstanding`, and the Expense Report's two ledgers and
 * its net balance.
 */
function isMoney(type: string, row: FlatRow): boolean {
  if (type === 'fee') return ['billed', 'collected', 'outstanding'].includes(row.key);
  if (type === 'expense') return row.section === 'income' || row.section === 'expense' || row.key === 'net_balance';
  return false;
}

/** A figure as a person reads it: money with its currency, a rate with its sign, a count grouped. */
function displayValue(type: string, row: FlatRow, currency: string | null): string {
  const { value } = row;
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (isMoney(type, row)) return formatAmountWithCode(value, currency);
    /*
     * The server's rates, shown at the two places it rounds them to. `null` — nothing marked, nobody
     * sat — has already become the em dash above, and must not become 0%. Never for a stored name: a
     * grade a school called "Top percentage" is still a count.
     */
    if (!row.stored && (/percentage$/.test(row.leaf) || row.leaf === 'pass_rate')) return `${value.toFixed(2)}%`;
    return COUNT.format(value);
  }
  return String(value);
}

/** Joi's refusal of a transposed window, said as what it means — see the Finance screen's copy. */
function windowRefusal(caught: ApiError): string | null {
  const reversed = caught.details.find((detail) => detail.field === 'to' && detail.type === 'date.min');
  return reversed ? '“To” is before “From”, so the window holds no days. Move one of them.' : null;
}

/**
 * One picker list, read to its end — the first page here, the rest through `useWholeList`, the
 * timetable screens' reader. `enabled` is false until the list's report is on screen and the caller
 * holds its view key, so nothing is fetched for a control that is not drawn.
 */
function useWholePicker<T extends { id: number }>(path: string, enabled: boolean): Picker<T> {
  const [first, setFirst] = useState<Picker<T>>({ state: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    (async () => {
      try {
        const page = await api.page<T[]>(path, { query: { limit: OPTION_LIMIT } });
        if (!cancelled) {
          setFirst({ state: 'ready', rows: page.data ?? [], total: page.meta?.total ?? page.data.length });
        }
      } catch {
        /* The report runs without this filter; the control says the list is unavailable. */
        if (!cancelled) setFirst({ state: 'failed' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, enabled]);

  return useWholeList(path, first);
}

/** Where the controls start: §16's period and anchor filled, everything else open. */
function initialValues(spec: ReportSpec): Record<string, string> {
  return spec.filters.includes('period')
    ? { period: 'monthly', date: localDay(new Date()) ?? '' }
    : {};
}

/* ─────────────────────────────── one report ─────────────────────────────── */

function ReportPanel({ spec }: { spec: ReportSpec }) {
  const { can } = useAuth();
  const { hasFeature } = useEntitlements();

  const has = (key: FilterKey) => spec.filters.includes(key);

  /* The separate view keys the pickers need — see the header on filters left off. */
  const canPickClass = can('classes.view');
  const canPickSession = can('sessions.view');
  const canPickStudent = can('students.view');

  const [values, setValues] = useState<Record<string, string>>(() => initialValues(spec));
  const set = (key: FilterKey, value: string) => setValues((prev) => ({ ...prev, [key]: value }));

  const { classes, sections } = useClassSections(values.class_id ?? '', canPickClass && has('class_id'));
  const sessions = useWholePicker<SessionOption>('/sessions', canPickSession && has('academic_session_id'));
  /* The Exam Report's own pair includes `exams.view`, so whoever sees this report can list exams. */
  const exams = useWholePicker<ExamOption>('/exams', has('exam_id'));

  /* ── the attendance report's student, searched as the account pickers search accounts ── */

  const studentsWanted = has('student_id') && canPickStudent;
  const [studentSearch, setStudentSearch] = useState('');
  const [studentQuery, setStudentQuery] = useState('');
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [studentTotal, setStudentTotal] = useState(0);
  const [studentsFailed, setStudentsFailed] = useState(false);
  /* Remembered as a row, so a new search cannot blank the select while the report is narrowed to it. */
  const [pinnedStudent, setPinnedStudent] = useState<StudentOption | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setStudentQuery(studentSearch.trim()), 300);
    return () => clearTimeout(timer);
  }, [studentSearch]);

  useEffect(() => {
    if (!studentsWanted) return;
    const controller = new AbortController();

    (async () => {
      try {
        const page = await api.page<StudentOption[]>('/students', {
          query: {
            limit: OPTION_LIMIT,
            q: studentQuery || undefined,
            class_id: values.class_id || undefined,
            section_id: values.section_id || undefined,
          },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setStudents(page.data ?? []);
        setStudentTotal(page.meta?.total ?? page.data.length);
        setStudentsFailed(false);
      } catch {
        if (controller.signal.aborted) return;
        setStudents([]);
        setStudentTotal(0);
        setStudentsFailed(true);
      }
    })();

    return () => controller.abort();
  }, [studentsWanted, studentQuery, values.class_id, values.section_id]);

  const studentOptions =
    pinnedStudent && !students.some((row) => row.id === pinnedStudent.id)
      ? [pinnedStudent, ...students]
      : students;

  /* ── the currency, the one typed filter, reaches the request after the typing stops ── */

  const [typedCurrency, setTypedCurrency] = useState('');
  useEffect(() => {
    /*
     * The platform screen's 300 ms and its reason: `currency` is `.uppercase().max(10)`, so "U" and
     * "US" are accepted, match nothing, and would paint a school with no money between keystrokes.
     */
    const timer = setTimeout(() => setTypedCurrency((values.currency ?? '').trim()), 300);
    return () => clearTimeout(timer);
  }, [values.currency]);

  /* ── which controls are drawn, and so which field errors have somewhere to sit ── */

  const drawn = new Set<FilterKey>(
    spec.filters.filter((key) => {
      if (key === 'class_id' || key === 'section_id') return canPickClass;
      if (key === 'academic_session_id') return canPickSession;
      if (key === 'student_id') return canPickStudent && !studentsFailed;
      return true;
    })
  );

  /** The filters this report has and this caller cannot feed, for the one sentence that says so. */
  const leftOff = [
    has('class_id') && !canPickClass ? (has('section_id') ? 'class and section' : 'class') : null,
    has('academic_session_id') && !canPickSession ? 'academic session' : null,
    has('student_id') && !canPickStudent ? 'student' : null,
  ].filter(Boolean) as string[];

  /**
   * The query the read and both exports send, so the three cannot describe different reports.
   *
   * Compared by value, as `useCollection` compares its own. `values` is a new object on every
   * keystroke in the Currency box, and a query rebuilt from it would be a new reference with the same
   * contents — which the read effect takes as a new report, so the debounce above would hold back the
   * currency and fetch the unchanged report once per keystroke anyway.
   */
  const queryKey = JSON.stringify(
    Object.fromEntries(
      spec.filters
        .map((key) => [key, key === 'currency' ? typedCurrency : (values[key] ?? '')] as const)
        .filter(([, value]) => value !== '')
    )
  );
  const query = useMemo(() => JSON.parse(queryKey) as Record<string, string>, [queryKey]);

  const missing = REQUIRED.filter((key) => has(key) && !values[key]);

  /* ── the read ── */

  const [report, setReport] = useState<AnyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /*
   * A 422, kept whole and sorted at render time against the controls drawn *then* — a picker whose
   * list fails after the refusal arrived removes its control, and its message must move to the banner
   * with it rather than stay filed under a field that is gone.
   */
  const [invalid, setInvalid] = useState<ApiError | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (missing.length > 0) {
      setReport(null);
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setInvalid(null);
    setRefusal(null);

    (async () => {
      try {
        const result = await api.get<{ report: AnyReport }>(spec.path, { query, signal: controller.signal });
        if (controller.signal.aborted) return;
        setReport(result.report ?? null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setReport(null);
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError && caught.status === 422) {
          /*
           * A 422 here is usually informative rather than a fault — "this window holds two
           * currencies, name one" arrives as a field error on `currency` — so it goes beside the
           * control it names, and anything with no control goes to the banner. See `invalid`.
           */
          setInvalid(caught);
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
  }, [spec.path, query, missing.length, attempt]);

  /* The refusal sorted onto the controls on screen; `to` is always drawn where a window exists. */
  const split = invalid ? splitApiErrors(invalid, new Set<string>(drawn)) : null;
  const reversed = invalid ? windowRefusal(invalid) : null;
  const fieldErrors: Record<string, string> = split
    ? reversed
      ? { ...split.perField, to: reversed }
      : split.perField
    : {};
  const banner = split ? split.banner : null;

  /* ── export and print: D9 ── */

  const canExport = can('reports.export');
  const premium = hasFeature(PREMIUM_REPORTS);
  const [exporting, setExporting] = useState<'excel' | 'pdf' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

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
        setExportError(caught instanceof ApiError ? caught.message : 'The export could not be downloaded.');
      } finally {
        setExporting(null);
      }
    },
    [spec, query]
  );

  /* ── wording ── */

  /** A filter's value as a person would name it, for the printed heading. */
  const describe = (key: string, value: string): string => {
    if (key === 'class_id' && classes.state === 'ready') {
      return classes.rows.find((row) => String(row.id) === value)?.name ?? value;
    }
    if (key === 'section_id' && sections.state === 'ready') {
      return sections.rows.find((row) => String(row.id) === value)?.name ?? value;
    }
    if (key === 'academic_session_id' && sessions.state === 'ready') {
      return sessions.rows.find((row) => String(row.id) === value)?.name ?? value;
    }
    if (key === 'exam_id' && exams.state === 'ready') {
      const exam = exams.rows.find((row) => String(row.id) === value);
      return exam ? examLabel(exam) : value;
    }
    if (key === 'student_id') {
      const student = studentOptions.find((row) => String(row.id) === value);
      return student ? studentLabel(student) : value;
    }
    if (key === 'is_active') return value === 'true' ? 'active only' : 'inactive only';
    return humanise(value);
  };

  const labelFor = (key: FilterKey): string => {
    if (key === 'from') return spec.window?.from ?? 'From';
    if (key === 'to') return spec.window?.to ?? 'To';
    if (key === 'date') {
      return values.period === 'daily' ? 'Day' : values.period === 'yearly' ? 'Any day in the year' : 'Any day in the month';
    }
    return {
      class_id: 'Class',
      section_id: 'Section',
      academic_session_id: 'Academic session',
      status: 'Student status',
      period: 'Period',
      student_id: 'Student',
      currency: 'Currency',
      exam_id: 'Exam',
      is_active: 'Teachers',
    }[key];
  };

  const schoolName =
    report && report.school && typeof report.school === 'object'
      ? ((report.school as { name?: unknown }).name as string | undefined) ?? null
      : null;
  const currency = report && typeof report.currency === 'string' ? report.currency : null;

  /*
   * Two same-named classes, told apart by their session.
   *
   * A class is unique per `(school, session, name)`, so "Grade 5" exists once a year — and the Student
   * Report's `by_class` groups by `class_id`, so the two are two rows with one name. Each entry carries
   * its class's `session_name`, so a repeated name is labelled with it. This used to look the session
   * up through the class and session picker lists, which a caller without `classes.view` and
   * `sessions.view` — the seeded Accountant — could not read, so for them the names stayed bare. A
   * class whose session was deleted says so.
   */
  const rows = useMemo(() => {
    const flat = report ? toRows(report) : [];
    const repeats = new Map<string, number>();
    const nameKey = (row: FlatRow) => `${row.section}|${row.label}`;
    for (const row of flat) {
      if (row.idKey === 'class_id') repeats.set(nameKey(row), (repeats.get(nameKey(row)) ?? 0) + 1);
    }

    return flat.map((row) =>
      row.idKey === 'class_id' && (repeats.get(nameKey(row)) ?? 0) > 1
        ? { ...row, label: `${row.label} — ${row.session ?? 'no session'}` }
        : row
    );
  }, [report]);

  const columns = useMemo<Column<FlatRow>[]>(
    () => [
      {
        key: 'section',
        header: 'Section',
        cell: (row) => <span className="text-muted">{humanise(row.section)}</span>,
      },
      {
        key: 'figure',
        header: 'Figure',
        primary: true,
        cell: (row) => <span className="font-medium">{row.label}</span>,
      },
      {
        key: 'value',
        header: 'Value',
        numeric: true,
        cell: (row) => <span className="whitespace-nowrap">{displayValue(spec.type, row, currency)}</span>,
      },
    ],
    [spec.type, currency]
  );

  /* ── the controls ── */

  const renderControl = (key: FilterKey) => {
    if (!drawn.has(key)) return null;
    const common = { id: `report-${key}`, label: labelFor(key), error: fieldErrors[key] };

    switch (key) {
      case 'from':
      case 'to':
      case 'date':
        return (
          <Field
            {...common}
            type="date"
            required={REQUIRED.includes(key)}
            value={values[key] ?? ''}
            onChange={(event) => set(key, event.target.value)}
          />
        );
      case 'period':
        return (
          <SelectField {...common} required value={values.period ?? ''} onChange={(event) => set('period', event.target.value)}>
            {PERIODS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
        );
      case 'class_id':
        return (
          <SelectField
            {...common}
            value={values.class_id ?? ''}
            disabled={classes.state !== 'ready'}
            hint={classes.state === 'failed' ? 'The class list could not be loaded.' : undefined}
            onChange={(event) => {
              /* The section belongs to the class, and the child to both; neither survives a new class. */
              setValues((prev) => ({ ...prev, class_id: event.target.value, section_id: '', student_id: '' }));
              setPinnedStudent(null);
            }}
          >
            <option value="">{classes.state === 'loading' ? 'Loading…' : 'Every class'}</option>
            {classes.state === 'ready'
              ? classes.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                    {row.is_active ? '' : ' — inactive'}
                  </option>
                ))
              : null}
          </SelectField>
        );
      case 'section_id':
        return (
          <SelectField
            {...common}
            value={values.section_id ?? ''}
            disabled={!values.class_id || sections.state !== 'ready'}
            onChange={(event) => {
              setValues((prev) => ({ ...prev, section_id: event.target.value, student_id: '' }));
              setPinnedStudent(null);
            }}
          >
            <option value="">{values.class_id ? 'Every section' : 'Choose a class first'}</option>
            {sections.state === 'ready'
              ? sections.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))
              : null}
          </SelectField>
        );
      case 'academic_session_id':
        return (
          <SelectField
            {...common}
            value={values.academic_session_id ?? ''}
            disabled={sessions.state !== 'ready'}
            hint={sessions.state === 'failed' ? 'The session list could not be loaded.' : undefined}
            onChange={(event) => set('academic_session_id', event.target.value)}
          >
            <option value="">{sessions.state === 'loading' ? 'Loading…' : 'Every session'}</option>
            {sessions.state === 'ready'
              ? sessions.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                    {row.is_current ? ' (current)' : ''}
                  </option>
                ))
              : null}
          </SelectField>
        );
      case 'status':
        return (
          <SelectField {...common} value={values.status ?? ''} onChange={(event) => set('status', event.target.value)}>
            <option value="">Any status</option>
            {STUDENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {humanise(status)}
              </option>
            ))}
          </SelectField>
        );
      case 'is_active':
        /* `Joi.boolean()` under `convert`, so the strings arrive as the boolean they spell. */
        return (
          <SelectField {...common} value={values.is_active ?? ''} onChange={(event) => set('is_active', event.target.value)}>
            <option value="">Active and inactive</option>
            <option value="true">Active only</option>
            <option value="false">Inactive only</option>
          </SelectField>
        );
      case 'exam_id':
        return (
          <SelectField
            {...common}
            value={values.exam_id ?? ''}
            disabled={exams.state !== 'ready'}
            hint={exams.state === 'failed' ? 'The exam list could not be loaded.' : undefined}
            onChange={(event) => set('exam_id', event.target.value)}
          >
            <option value="">{exams.state === 'loading' ? 'Loading…' : 'Every exam'}</option>
            {exams.state === 'ready'
              ? exams.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {examLabel(row)}
                  </option>
                ))
              : null}
          </SelectField>
        );
      case 'currency':
        return (
          <Field
            {...common}
            maxLength={10}
            autoComplete="off"
            value={values.currency ?? ''}
            onChange={(event) => set('currency', event.target.value)}
            hint="Only needed when this school has recorded money in more than one currency — there is no conversion rate."
          />
        );
      case 'student_id':
        return (
          <div className="space-y-2">
            <SearchField
              id="report-student-search"
              label="Search students"
              placeholder="Name, student ID or roll number…"
              value={studentSearch}
              onChange={setStudentSearch}
            />
            <SelectField
              {...common}
              value={values.student_id ?? ''}
              hint={
                studentTotal > students.length
                  ? `Showing ${students.length} of ${COUNT.format(studentTotal)} — search to narrow the list.`
                  : undefined
              }
              onChange={(event) => {
                const chosen = event.target.value;
                set('student_id', chosen);
                setPinnedStudent(chosen ? (studentOptions.find((row) => String(row.id) === chosen) ?? null) : null);
              }}
            >
              <option value="">Every student</option>
              {studentOptions.map((row) => (
                <option key={row.id} value={row.id}>
                  {studentLabel(row)}
                </option>
              ))}
            </SelectField>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <>
      {/* Provenance a sheet of paper needs and the screen already shows in its tabs and controls. */}
      <div className="print-only mb-4">
        <h2 className="text-lg font-semibold">
          {spec.label} report{schoolName ? ` — ${schoolName}` : ''}
        </h2>
        <p className="text-sm">
          {Object.entries(query)
            .map(([key, value]) => `${labelFor(key as FilterKey)}: ${describe(key, value)}`)
            .join(' · ')}
        </p>
      </div>

      <div className="no-print mb-6 space-y-4">
        <p className="text-sm text-muted">{spec.summary}</p>

        <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {spec.filters.map((key) => {
            const control = renderControl(key);
            return control ? <div key={key}>{control}</div> : null;
          })}
        </div>

        {leftOff.length > 0 ? (
          <p className="field-hint">
            Narrowing by{' '}
            {leftOff.length === 1
              ? leftOff[0]
              : `${leftOff.slice(0, -1).join(', ')} or ${leftOff[leftOff.length - 1]}`}{' '}
            needs a view permission this account does not hold, so
            {leftOff.length === 1 ? ' that filter is' : ' those filters are'} not offered. The report
            still runs, over everything those filters would have narrowed.
          </p>
        ) : null}
        {has('student_id') && canPickStudent && studentsFailed ? (
          <p className="field-hint">
            The student list could not be loaded, so the report cannot be narrowed to one child here.
          </p>
        ) : null}

        {/* Export and print, on the report that is actually on screen — D9, see the header. */}
        {report ? (
          canExport && premium ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void runExport('excel')}
                disabled={exporting !== null}
                aria-busy={exporting === 'excel'}
                className="btn btn-secondary btn-sm"
              >
                {exporting === 'excel' ? <Spinner size={13} /> : <Icon name="download" size={14} />}
                {exporting === 'excel' ? 'Preparing…' : 'Export Excel'}
              </button>
              <button
                type="button"
                onClick={() => void runExport('pdf')}
                disabled={exporting !== null}
                aria-busy={exporting === 'pdf'}
                className="btn btn-secondary btn-sm"
              >
                {exporting === 'pdf' ? <Spinner size={13} /> : <Icon name="download" size={14} />}
                {exporting === 'pdf' ? 'Preparing…' : 'Export PDF'}
              </button>
              <button type="button" onClick={() => window.print()} className="btn btn-secondary btn-sm">
                <Icon name="printer" size={14} />
                Print
              </button>
            </div>
          ) : canExport ? (
            <Notice tone="info">
              Exporting a report to PDF or Excel, and printing it, come with Premium Reports, which
              this school&rsquo;s plan does not include. Every report can still be read here in full.
            </Notice>
          ) : (
            <p className="field-hint">
              Exporting and printing reports need the &ldquo;Export reports&rdquo; permission, which
              this account does not hold.
            </p>
          )
        ) : null}

        {exportError ? <Notice tone="error">{exportError}</Notice> : null}
      </div>

      {/* ── the report ── */}
      <section aria-label={`${spec.label} report`}>
        {missing.length > 0 ? (
          <EmptyNotice>
            Choose {missing.map((key) => labelFor(key).toLowerCase()).join(' and ')} to run the{' '}
            {spec.label} report.
          </EmptyNotice>
        ) : refusal ? (
          <RefusalNotice refusal={refusal} />
        ) : error ? (
          <ErrorNotice message={error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : banner ? (
          <Notice tone="error">{banner}</Notice>
        ) : Object.keys(fieldErrors).length > 0 ? (
          <EmptyNotice>Change the filter marked above to run the {spec.label} report.</EmptyNotice>
        ) : loading && !report ? (
          <LoadingBlock rows={4} />
        ) : !report ? (
          <EmptyNotice>Nothing was returned for this report.</EmptyNotice>
        ) : rows.length === 0 ? (
          <EmptyNotice>This report came back empty.</EmptyNotice>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            /*
             * By id where the entry has one. Keyed by name, two classes called "Grade 5" from two
             * sessions were one key, and React reconciled the second row onto the first.
             */
            rowKey={(row) => `${row.section}:${row.idKey ? `${row.idKey}=${String(row.id)}` : row.key}`}
            caption={`${spec.label} report${schoolName ? ` — ${schoolName}` : ''}`}
            busy={loading}
          />
        )}
      </section>
    </>
  );
}

/* ─────────────────────────────── the screen ─────────────────────────────── */

/** The tabs, URL-backed like every other tabbed school screen, over the reports this caller can run. */
function ReportTabs({ reports }: { reports: ReportSpec[] }) {
  const tabs = useMemo<TabDef[]>(() => reports.map((spec) => ({ key: spec.type, label: spec.label })), [reports]);
  const [active, setActive] = useActiveTab(tabs);
  const spec = reports.find((entry) => entry.type === active) ?? reports[0];

  return (
    <>
      <div className="no-print">
        <Tabs tabs={tabs} active={spec.type} onChange={setActive} label="Reports" />
      </div>
      <TabPanel tabKey={spec.type}>
        {/*
          * Keyed on the report, so each one's filters, picker state and payload start fresh. One panel
          * whose `spec` prop changed would keep the last report's filters — a class chosen on
          * Students carried into Teachers, whose schema does not take one — and for a frame would
          * render the old payload under the new report's heading.
          */}
        <ReportPanel key={spec.type} spec={spec} />
      </TabPanel>
    </>
  );
}

function ReportsScreen() {
  const { can } = useAuth();
  const { isSubscriptionScoped } = useEntitlements();

  /* Both keys of each route's pair, checked the way the router checks them: all of them. */
  const reachable = useMemo(
    () => REPORTS.filter((spec) => spec.permissions.every((key) => can(key))),
    [can]
  );

  return (
    <div>
      <PageHeader
        title="Reports"
        description="SRS §22’s six school reports, for this school: read on screen, and exported or printed where the plan includes it."
      />

      {/*
        * `!isSubscriptionScoped` is a platform or organization sign-in — no school in scope, so no
        * school report can be about anyone. The school dashboard draws the same line for the same
        * reason; the platform Reports screen is where such a caller names a school.
        */}
      {!isSubscriptionScoped ? (
        <div className="surface px-5 py-8 text-center">
          <p className="font-display text-xl font-semibold text-ink">No school in scope</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
            These reports are about one school, and your account is not scoped to one. The platform
            Reports screen runs the same reports for a school you name.
          </p>
          <Link href="/super-admin/reports" className="btn btn-secondary mt-5">
            Go to platform reports
          </Link>
        </div>
      ) : !can('reports.view') ? (
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'Generating reports needs the reports.view permission.',
          }}
        />
      ) : reachable.length === 0 ? (
        <EmptyNotice title="No report is available to this account">
          Each report also needs the view permission of what it reports on — students, attendance,
          fees, finance, exams or teachers — and this account holds none of them.
        </EmptyNotice>
      ) : (
        <ReportTabs reports={reachable} />
      )}
    </div>
  );
}

export default function SchoolReportsPage() {
  /* `useActiveTab` reads the query string, which cannot run during prerender. */
  return (
    <Suspense fallback={<LoadingBlock />}>
      <ReportsScreen />
    </Suspense>
  );
}
