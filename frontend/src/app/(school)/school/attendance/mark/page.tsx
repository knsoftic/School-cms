'use client';

/**
 * Mark attendance — SRS §16, FR-ATT-001 (students) and FR-ATT-003 (teachers).
 *
 * ## Why this screen exists
 *
 * `POST /attendance/students` and `POST /attendance/teachers` were both mounted and **neither had a
 * caller anywhere in the frontend**. The Attendance screen listed student records and contained no
 * form and no write call of any kind, and the teacher register was not even readable. So §16 — a
 * whole section of the source — was partly readable and entirely unusable: a school could look at an
 * attendance register it had no way to fill in.
 *
 * ## A register, not a form
 *
 * `entries` is an array of 1–500 `{ id, status, late_minutes, remarks }` and the day is named once,
 * so the natural shape is the paper thing it replaces: choose who and when, then mark them.
 *
 * That is why this is not built out of `Field`/`SelectField` per person. Twenty-five children ×
 * four statuses as twenty-five dropdowns is twenty-five interactions to record a normal morning. The
 * status control is a **radio group per row rendered as a segmented button**, which is one click per
 * person, and the two bulk buttons make the common case — everybody present — a single click.
 *
 * Underneath they are real `<input type="radio">` elements sharing a per-person `name`, so a
 * keyboard user gets arrow-key selection within a row and tab between rows for free, and a screen
 * reader announces a named group. The appearance is `:checked` styling on the label; nothing is
 * simulated.
 *
 * ## Everybody defaults to present
 *
 * The smart default, and the one the source implies: `ATTENDANCE_STATUS` is
 * `{ present, absent, leave, late }` and an ordinary day is mostly the first. Defaulting to *unset*
 * would mean a register cannot be submitted until every person is touched, which is how a teacher
 * ends up marking thirty children present one at a time.
 *
 * It also means the payload always carries everybody, which is what the endpoint wants: this is a
 * **register for a day**, not a list of exceptions.
 *
 * ## Two registers, one screen
 *
 * `?register=teachers` selects the staff register. The two share every mechanic above and differ in
 * exactly three ways, which is why they are a mode rather than two screens:
 *
 *   1. the roster comes from `/teachers` rather than `/students` filtered by class;
 *   2. there is therefore no class or section to choose;
 *   3. `check_in_at` and `check_out_at` exist on a teacher entry and not on a student one.
 *
 * They are also behind **different permissions** — `attendance.mark` and
 * `attendance.teacher.mark` — so the gate is per mode, not per screen.
 *
 * ## Marking a day again overwrites it, and this screen does not read the old one back
 *
 * The models carry a unique index on `(person, attendance_date)`, and both services write with
 * `bulkCreate(…, { updateOnDuplicate })` — so a second submission for the same day is not refused,
 * it **replaces** the first for everyone on the register, `marked_by` and `marked_at` included. That
 * is how a correction is made, and the service header says so ("Re-marking a register therefore
 * corrects it"). This header and the date hint used to say the opposite — that a day already marked
 * was refused — which is the one wrong belief that loses data: a teacher who trusts it re-submits a
 * day to "check", and every absence on it becomes present.
 *
 * The register is not pre-filled from what was stored; it opens with everybody present every time.
 * So the date hint says plainly that re-marking a day replaces it, and after a save the register the
 * teacher just submitted stays on screen, as submitted — it used to jump to the whole class, all
 * present, one click away from overwriting the section that had just been marked.
 *
 * ## One register holds at most 500, and a page holds 100
 *
 * `entries` is `Joi.array().max(500)`, and the roster lists are paginated at `OPTION_LIMIT`. The
 * roster used to be one page, so a class of 130 was marked as 100 and the other thirty had no row
 * for the day and no word that they had been left out. It is now read page by page up to 500, and a
 * roster larger than that says how many are missing and what to do about it.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { splitApiErrors } from '@/lib/formErrors';
import { useClassSections, OPTION_LIMIT } from '@/lib/useTimetablePickers';
import {
  Field,
  FormActions,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  focusFirstInvalidField,
} from '@/components/form';
import { Icon } from '@/components/icon';
import { useToast } from '@/components/toast';
import {
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
} from '@/components/table';

/** `ATTENDANCE_STATUS` in `config/constants.js`, in the order a register is read. */
const STATUSES = [
  { value: 'present', label: 'Present', short: 'P' },
  { value: 'absent', label: 'Absent', short: 'A' },
  { value: 'leave', label: 'Leave', short: 'L' },
  { value: 'late', label: 'Late', short: 'La' },
] as const;

type Status = (typeof STATUSES)[number]['value'];

/**
 * The fields this form renders an error beside.
 *
 * `entries.0.status` and friends are **not** here on purpose: a 422 naming an index is routed to the
 * person it belongs to, and anything else goes to the banner. See `splitApiErrors`.
 *
 * Nor is bare `entries`, which used to be. No control renders it, and it is the key the service's
 * own refusals use — "Every student must belong to the class being marked", a person named twice —
 * as well as Joi's "must contain at least 1 items". Listed here, each was filed under a field
 * nothing draws, the non-empty map stood the banner down, and a refused register looked like a
 * click that did nothing. Left out, they reach the banner.
 *
 * `academic_session_id` is gone for the same reason — there is no session control on this form.
 */
const FORM_FIELDS = new Set(['class_id', 'section_id', 'attendance_date', 'reason']);

/** The most one register carries — `entries: Joi.array().max(500)` in `attendance.validation.js`. */
const MAX_ENTRIES = 500;

/**
 * A roster, page by page, up to what one register can carry.
 *
 * `total` is the server's count, so a roster larger than `MAX_ENTRIES` can say how many it left out
 * rather than quietly marking the first five hundred as though they were everyone.
 */
async function loadRoster<T>(
  path: string,
  query: Record<string, string | number | undefined>,
  signal: AbortSignal
): Promise<{ rows: T[]; total: number }> {
  const rows: T[] = [];
  let total = 0;
  for (let page = 1; rows.length < MAX_ENTRIES; page += 1) {
    const result = await api.page<T[]>(path, {
      query: { ...query, page, limit: OPTION_LIMIT },
      signal,
    });
    const data = result.data ?? [];
    rows.push(...data);
    total = result.meta?.total ?? rows.length;
    if (!result.meta?.hasNextPage || data.length === 0) break;
  }
  return { rows: rows.slice(0, MAX_ENTRIES), total };
}

/**
 * One person on the register.
 *
 * The two rosters are the same three things — an id, a name, and an identifier the school issued —
 * so one type covers both and each loader fills `reference` from whichever column its endpoint
 * returns. A second interface would mean a second copy of every row-rendering decision below.
 */
interface RosterRow {
  id: number;
  first_name: string;
  last_name: string | null;
  /** `student_id` on a student, `employee_id` on a teacher. */
  reference: string;
  /** Students only. */
  roll_number?: string | null;
}

/** What the register holds for one person. */
interface Entry {
  status: Status;
  lateMinutes: string;
  remarks: string;
  /** Teachers only — neither column exists on a student entry. */
  checkIn: string;
  checkOut: string;
}

const BLANK: Entry = { status: 'present', lateMinutes: '', remarks: '', checkIn: '', checkOut: '' };

/** Today as `YYYY-MM-DD` in the viewer's zone, which is the day they mean by "today". */
function today(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function personName(row: RosterRow): string {
  return [row.first_name, row.last_name].filter(Boolean).join(' ');
}

/**
 * A `datetime-local` value as an instant.
 *
 * `check_in_at` is `Joi.date().iso()`, and the control yields a zoneless `2026-09-09T08:55`. Sent as
 * typed that is read in the **server's** zone rather than the school's, so a check-in recorded at
 * five to nine can land hours out. The same conversion the coupon form makes for its expiry.
 */
function isoInstant(local: string): string | undefined {
  if (!local) return undefined;
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? local : parsed.toISOString();
}

function MarkAttendanceScreen() {
  const params = useSearchParams();
  const { can } = useAuth();
  const { success } = useToast();

  /** `students` unless the query string says otherwise. */
  const teachers = params.get('register') === 'teachers';

  /* Different keys, so the gate is per register rather than per screen. */
  const canMark = can(teachers ? 'attendance.teacher.mark' : 'attendance.mark');

  const [classId, setClassId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState('');

  /* Only the student register needs these, so only it asks for them. */
  const { classes, sections } = useClassSections(classId, canMark && !teachers);

  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [rosterState, setRosterState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  /** How many the server says there are — more than `roster.length` only past `MAX_ENTRIES`. */
  const [rosterTotal, setRosterTotal] = useState(0);
  /**
   * Why the roster failed, when it was not a refusal. A refusal is explained by `RefusalNotice` at
   * the top; anything else — a 500, a dropped connection — is said here, with a retry.
   */
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [rosterAttempt, setRosterAttempt] = useState(0);
  const [entries, setEntries] = useState<Record<number, Entry>>({});

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** A 422 that named `entries.<n>.…`, keyed by person id so it renders on that row. */
  const [entryErrors, setEntryErrors] = useState<Record<number, string>>({});

  /*
   * The roster.
   *
   * Students follow the chosen class and section and are narrowed to `status=active` — that
   * narrowing is this screen's judgement rather than the endpoint's, because a register for today is
   * a register of the children who are here today, and a student who has transferred out should not
   * be markable. Teachers are the whole active staff list, since there is nothing to scope them by.
   */
  useEffect(() => {
    if (!canMark || (!teachers && !classId)) {
      setRoster([]);
      setEntries({});
      setRosterTotal(0);
      setRosterState('idle');
      return;
    }

    const controller = new AbortController();
    setRosterState('loading');
    setRosterError(null);
    /* A refusal is about the roster that was asked for; a new one deserves a fresh answer. */
    setRefusal(null);

    (async () => {
      try {
        /* Read to its end, up to one register's worth — see the header on 500 and 100. */
        let rows: RosterRow[];
        let total: number;
        if (teachers) {
          const loaded = await loadRoster<{
            id: number;
            employee_id: string;
            first_name: string;
            last_name: string | null;
          }>('/teachers', { is_active: 'true' }, controller.signal);
          rows = loaded.rows.map((row) => ({
            id: row.id,
            first_name: row.first_name,
            last_name: row.last_name,
            reference: row.employee_id,
          }));
          total = loaded.total;
        } else {
          const loaded = await loadRoster<{
            id: number;
            student_id: string;
            first_name: string;
            last_name: string | null;
            roll_number: string | null;
          }>(
            '/students',
            { class_id: classId, section_id: sectionId || undefined, status: 'active' },
            controller.signal
          );
          rows = loaded.rows.map((row) => ({
            id: row.id,
            first_name: row.first_name,
            last_name: row.last_name,
            reference: row.student_id,
            roll_number: row.roll_number,
          }));
          total = loaded.total;
        }

        if (controller.signal.aborted) return;
        setRoster(rows);
        setRosterTotal(total);
        /* Everybody present — see the header on why the default is not "unset". */
        setEntries(Object.fromEntries(rows.map((row) => [row.id, { ...BLANK }])));
        setRosterState('ready');
      } catch (caught) {
        if (controller.signal.aborted) return;
        setRoster([]);
        setEntries({});
        setRosterTotal(0);
        setRosterState('failed');
        /*
         * Said as what it was. This used to be one sentence for every failure — "That needs its own
         * view permission" — which was wrong for a dropped connection, and wrong for the teacher
         * register at a school without the Teachers module, where `RefusalNotice` above was already
         * saying the right thing.
         */
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          setRosterError(caught.message);
        } else {
          setRosterError('Could not reach the server. Check your connection and try again.');
        }
      }
    })();

    return () => controller.abort();
  }, [teachers, classId, sectionId, canMark, rosterAttempt]);

  /*
   * A different day starts with everybody present, as the date hint promises. The roster is the same
   * people, so it is not refetched — only the marks go back. Without this, the statuses from a register
   * just recorded stayed on screen after the day was changed, and the next "Record" wrote them onto
   * the new day, overwriting whatever it held.
   */
  useEffect(() => {
    setEntries((prev) => Object.fromEntries(Object.keys(prev).map((id) => [id, { ...BLANK }])));
    setEntryErrors({});
  }, [date]);

  const counts = useMemo(() => {
    const tally: Record<string, number> = { present: 0, absent: 0, leave: 0, late: 0 };
    for (const entry of Object.values(entries)) tally[entry.status] += 1;
    return tally;
  }, [entries]);

  const patch = (id: number, changes: Partial<Entry>) =>
    setEntries((prev) => ({ ...prev, [id]: { ...prev[id], ...changes } }));

  function setAll(status: Status) {
    setEntries((prev) =>
      Object.fromEntries(Object.entries(prev).map(([id, entry]) => [id, { ...entry, status }]))
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});
    setEntryErrors({});

    try {
      const body = {
        attendance_date: date,
        entries: roster.map((row) => {
          const entry = entries[row.id];
          const shared = {
            status: entry.status,
            /* Only for a late arrival, and only when a figure was given. */
            late_minutes:
              entry.status === 'late' && entry.lateMinutes.trim()
                ? Number(entry.lateMinutes)
                : undefined,
            remarks: entry.remarks.trim() || undefined,
          };
          return teachers
            ? {
                teacher_id: row.id,
                ...shared,
                check_in_at: isoInstant(entry.checkIn),
                check_out_at: isoInstant(entry.checkOut),
              }
            : { student_id: row.id, ...shared };
        }),
        reason: reason.trim() || undefined,
        /* The student register scopes by class; the teacher register has nothing to scope by. */
        ...(teachers
          ? {}
          : {
              class_id: Number(classId),
              section_id: sectionId ? Number(sectionId) : undefined,
            }),
      };

      /*
       * The two calls are written out rather than selected by a ternary inside `api.post(…)`.
       *
       * `verify-frontend.js` collects `api.<method>(` followed **immediately** by a path literal, so
       * `api.post(teachers ? '/attendance/teachers' : '/attendance/students', body)` was invisible to
       * it: both FR-ATT-001 routes read as having no caller, and would have gone on reading that way
       * if this screen ever lost them. The same trap is recorded in `super-admin/payments/page.tsx`
       * for FR-BILL-004's approve and reject, and in `subscriptions/[id]/lifecycle.tsx`, which hit it
       * twice before getting it right. One extra branch buys two routes inside the safety net.
       */
      if (teachers) {
        await api.post('/attendance/teachers', body);
      } else {
        await api.post('/attendance/students', body);
      }

      const noun = teachers ? 'teacher' : 'student';
      success(
        `Attendance recorded for ${roster.length} ${noun}${roster.length === 1 ? '' : 's'}`,
        `${counts.present} present · ${counts.absent} absent · ${counts.leave} on leave · ${counts.late} late`
      );
      /*
       * Stay on the screen, and on this register as it was submitted. The section used to be
       * cleared here, which reloaded the whole class with everybody present — so the register just
       * saved vanished, and the next click of "Record" overwrote it. The next section is one choice
       * away in the picker above.
       */
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        /*
         * A failed `fetch` is a TypeError, not an ApiError. This used to rethrow it, which from a
         * submit handler is an unhandled rejection: the button stopped spinning and nothing said
         * whether the register had been recorded.
         */
        setError('Could not reach the server. Check your connection and try again.');
        return;
      }
      if (EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
        return;
      }

      /*
       * An entry error arrives as `entries.<index>.<field>`. The index is into the array this screen
       * built, so it maps back to a person — and routing it to that row is the difference between
       * "something is wrong with entry 14" and a message beside the person it is about.
       *
       * Each field routed to a row is counted as rendered for `splitApiErrors`, so it is not also
       * promoted to the banner. It used to be both — the same sentence at the top and beside the
       * child. An index that matches nobody is left unrendered, so it still reaches the banner.
       */
      const routed: Record<number, string> = {};
      const rendered = new Set(FORM_FIELDS);
      for (const [field, message] of Object.entries(caught.fieldErrors())) {
        const match = /^entries\.(\d+)\./.exec(field);
        const row = match ? roster[Number(match[1])] : undefined;
        if (row) {
          routed[row.id] = routed[row.id] ?? message;
          rendered.add(field);
        }
      }
      setEntryErrors(routed);

      const { perField, banner } = splitApiErrors(caught, rendered);
      setFieldErrors(perField);
      setError(
        Object.keys(routed).length && !banner ? 'Some entries were refused — see below.' : banner
      );
      if (Object.keys(perField).some((field) => FORM_FIELDS.has(field))) focusFirstInvalidField();
    } finally {
      setSaving(false);
    }
  }

  if (!canMark) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Mark attendance" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: teachers
              ? 'Marking teacher attendance needs the attendance.teacher.mark permission.'
              : 'Marking student attendance needs the attendance.mark permission.',
          }}
        />
      </div>
    );
  }

  const noun = teachers ? 'teacher' : 'student';

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={teachers ? 'Mark teacher attendance' : 'Mark student attendance'}
        description={
          teachers
            ? 'Choose a day and mark the staff register. Everybody starts as present — change only who was not.'
            : 'Choose a class and a day, then mark the register. Everybody starts as present — change only the children who were not.'
        }
        action={
          <Link
            href={teachers ? '/school/attendance?tab=teachers' : '/school/attendance'}
            className="btn btn-secondary"
          >
            <Icon name="chevron-left" size={15} />
            Attendance records
          </Link>
        }
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The register"
          description={
            teachers
              ? 'Which day. The whole active staff list is marked in one go.'
              : 'Which children, and for which day. A section is optional — leave it unset for the whole class.'
          }
        >
          {teachers ? null : (
            <>
              {classes.state === 'failed' ? (
                /*
                 * Said, not left as an empty dropdown. The class select used to sit here with only
                 * "Choose a class" in it and nothing to say why — the register could not be started
                 * and the screen did not say so. No `SelectField`, so no `<label>`: the heading
                 * borrows `.field-label` the way the timetable form's failed branches do.
                 */
                <div>
                  <p className="field-label mb-1.5">Class</p>
                  <p className="text-sm text-danger">
                    The class list could not be loaded, so a class cannot be chosen and the register
                    cannot be marked here. Reading it needs the separate &ldquo;View classes&rdquo;
                    permission; if you have that, reload the page to try again.
                  </p>
                </div>
              ) : (
                <SelectField
                  id="class_id"
                  label="Class"
                  required
                  value={classId}
                  onChange={(event) => {
                    setClassId(event.target.value);
                    /* The section belongs to the class; carrying one over names another class's. */
                    setSectionId('');
                  }}
                  error={fieldErrors.class_id}
                  disabled={classes.state === 'loading'}
                >
                  <option value="">
                    {classes.state === 'loading' ? 'Loading…' : 'Choose a class'}
                  </option>
                  {classes.state === 'ready'
                    ? classes.rows.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                          {row.code ? ` (${row.code})` : ''}
                          {row.is_active ? '' : ' — inactive'}
                        </option>
                      ))
                    : null}
                </SelectField>
              )}

              <SelectField
                id="section_id"
                label="Section"
                value={sectionId}
                onChange={(event) => setSectionId(event.target.value)}
                error={fieldErrors.section_id}
                disabled={!classId || sections.state !== 'ready'}
                hint={
                  sections.state === 'failed'
                    ? 'This class’s sections could not be loaded, so only the whole class can be marked.'
                    : 'Blank marks the whole class in one go.'
                }
              >
                <option value="">Whole class</option>
                {sections.state === 'ready'
                  ? sections.rows.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                        {row.is_active ? '' : ' — inactive'}
                      </option>
                    ))
                  : null}
              </SelectField>
            </>
          )}

          <Field
            id="attendance_date"
            label="Day"
            type="date"
            required
            value={date}
            onChange={(event) => setDate(event.target.value)}
            error={fieldErrors.attendance_date}
            /* See the header: re-marking overwrites, and the register never opens pre-filled. */
            hint="Defaults to today. Recording a day that is already marked replaces it for everyone listed below — that is how a correction is made — and the register always starts with everybody present, not as the day was marked."
          />
        </FormSection>

        {/* ─────────── the register itself ─────────── */}

        {rosterState === 'idle' ? null : rosterState === 'loading' ? (
          <LoadingBlock />
        ) : rosterState === 'failed' ? (
          rosterError ? (
            <ErrorNotice message={rosterError} onRetry={() => setRosterAttempt((n) => n + 1)} />
          ) : (
            <EmptyNotice>
              The {noun} list could not be loaded, so there is nobody to mark — the notice above
              says why.
            </EmptyNotice>
          )
        ) : roster.length === 0 ? (
          <EmptyNotice>
            {teachers
              ? 'No active teacher is on this school, so there is nothing to mark.'
              : `No active student is placed in this ${sectionId ? 'section' : 'class'} yet, so there is nothing to mark.`}
          </EmptyNotice>
        ) : (
          <section aria-labelledby="roster-heading" className="border-t border-border-soft pt-6">
            {rosterTotal > roster.length ? (
              <div className="mb-4">
                <Notice tone="warn">
                  {teachers
                    ? `There are ${rosterTotal} active teachers and one register holds at most ${MAX_ENTRIES}, so only the first ${roster.length} are listed; the rest cannot be marked from this screen.`
                    : sectionId
                      ? `This section has ${rosterTotal} active students and one register holds at most ${MAX_ENTRIES}, so only the first ${roster.length} are listed; the rest cannot be marked from this screen.`
                      : `This class has ${rosterTotal} active students and one register holds at most ${MAX_ENTRIES}, so only the first ${roster.length} are listed. Mark it a section at a time so nobody is left out.`}
                </Notice>
              </div>
            ) : null}

            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div className="max-w-xl">
                <h2 id="roster-heading" className="text-base font-semibold tracking-tight text-ink">
                  {roster.length} {noun}
                  {roster.length === 1 ? '' : 's'}
                </h2>
                {/*
                  * The tally in figures, so the register can be checked against a headcount before
                  * it is submitted — which is what a teacher actually does.
                  */}
                <p className="mt-1 text-sm leading-relaxed text-muted">
                  {counts.present} present · {counts.absent} absent · {counts.leave} on leave ·{' '}
                  {counts.late} late
                </p>
              </div>

              {/* The common case in one click, and its opposite for a closure or a trip. */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setAll('present')}
                  className="btn btn-secondary btn-sm"
                >
                  All present
                </button>
                <button
                  type="button"
                  onClick={() => setAll('absent')}
                  className="btn btn-secondary btn-sm"
                >
                  All absent
                </button>
              </div>
            </div>

            <ul className="space-y-px overflow-hidden rounded-md border border-border-strong">
              {roster.map((row) => {
                const entry = entries[row.id];
                if (!entry) return null;
                const rowError = entryErrors[row.id];

                return (
                  <li key={row.id} className="bg-surface-1 px-3 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">
                          {personName(row)}
                        </span>
                        <span className="block text-xs text-muted-soft">
                          {row.roll_number ? `Roll ${row.roll_number} · ` : ''}
                          {row.reference}
                        </span>
                      </div>

                      {/*
                        * A real radio group. `role` and `aria` are not simulated: each option is an
                        * `<input type="radio">` sharing this person's `name`, so arrow keys move
                        * within the row and a screen reader announces the group and the choice. The
                        * segmented appearance is `:checked` styling on the label.
                        */}
                      <fieldset className="shrink-0">
                        <legend className="sr-only">Attendance for {personName(row)}</legend>
                        <div className="flex overflow-hidden rounded-md border border-border-strong">
                          {STATUSES.map((option) => {
                            const id = `status-${row.id}-${option.value}`;
                            return (
                              <span key={option.value} className="contents">
                                <input
                                  id={id}
                                  type="radio"
                                  name={`status-${row.id}`}
                                  value={option.value}
                                  checked={entry.status === option.value}
                                  onChange={() => patch(row.id, { status: option.value })}
                                  className="peer sr-only"
                                />
                                <label
                                  htmlFor={id}
                                  className="cursor-pointer border-l border-border-strong px-2.5 py-1.5 text-xs font-medium text-muted transition-colors first:border-l-0 hover:bg-surface-2 peer-checked:bg-brand peer-checked:text-[var(--brand-contrast)] peer-focus-visible:ring-2 peer-focus-visible:ring-brand"
                                >
                                  <span className="sm:hidden">{option.short}</span>
                                  <span className="hidden sm:inline">{option.label}</span>
                                </label>
                              </span>
                            );
                          })}
                        </div>
                      </fieldset>
                    </div>

                    {/* `late_minutes` only means something for a late arrival. */}
                    {entry.status === 'late' ? (
                      <div className="mt-2.5 max-w-xs">
                        <label htmlFor={`late-${row.id}`} className="field-label mb-1.5 block text-xs">
                          Minutes late
                        </label>
                        <input
                          id={`late-${row.id}`}
                          type="number"
                          min={0}
                          value={entry.lateMinutes}
                          onChange={(event) => patch(row.id, { lateMinutes: event.target.value })}
                          className="field-input mt-0"
                        />
                      </div>
                    ) : null}

                    {/*
                      * Check-in and check-out, teachers only — the two columns a student entry does
                      * not have. Offered on any status, because a teacher who left early was present
                      * and a teacher on leave has neither, and the schema allows both to be null.
                      */}
                    {teachers ? (
                      <div className="mt-2.5 grid max-w-md gap-3 sm:grid-cols-2">
                        <div>
                          <label htmlFor={`in-${row.id}`} className="field-label mb-1.5 block text-xs">
                            Checked in
                          </label>
                          <input
                            id={`in-${row.id}`}
                            type="datetime-local"
                            value={entry.checkIn}
                            onChange={(event) => patch(row.id, { checkIn: event.target.value })}
                            className="field-input mt-0"
                          />
                        </div>
                        <div>
                          <label htmlFor={`out-${row.id}`} className="field-label mb-1.5 block text-xs">
                            Checked out
                          </label>
                          <input
                            id={`out-${row.id}`}
                            type="datetime-local"
                            value={entry.checkOut}
                            onChange={(event) => patch(row.id, { checkOut: event.target.value })}
                            className="field-input mt-0"
                          />
                        </div>
                      </div>
                    ) : null}

                    {rowError ? (
                      <p className="field-error mt-2 flex items-start gap-1.5">
                        <Icon name="alert-circle" size={13} className="mt-px" />
                        <span>{rowError}</span>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <FormSection title="Internal notes" description="Kept with this register's entry in the activity log.">
          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            error={fieldErrors.reason}
            hint="Up to 255 characters. Worth using when a whole class or the whole staff is marked absent."
          />
        </FormSection>

        <FormActions
          cancelHref={teachers ? '/school/attendance?tab=teachers' : '/school/attendance'}
          cancelLabel="Cancel"
        >
          {/*
            * Disabled until there is a register to record. An empty `entries` is refused by Joi
            * ("must contain at least 1 items"), and before that message reached the banner it was
            * swallowed — see `FORM_FIELDS`. Better not to offer the click at all.
            */}
          <SubmitButton
            busy={saving}
            busyLabel="Recording…"
            fullWidth={false}
            disabled={rosterState !== 'ready' || roster.length === 0}
          >
            {roster.length
              ? `Record ${roster.length} ${noun}${roster.length === 1 ? '' : 's'}`
              : 'Record attendance'}
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}

export default function MarkAttendancePage() {
  /* `useSearchParams` reads the query string, which cannot run during prerender. */
  return (
    <Suspense fallback={<LoadingBlock />}>
      <MarkAttendanceScreen />
    </Suspense>
  );
}
