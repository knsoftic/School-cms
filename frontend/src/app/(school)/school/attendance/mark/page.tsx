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
 * ## One thing this screen deliberately does not do
 *
 * It does not check whether the day has already been marked. The POST routes are the only writers
 * and the service owns what a second submission for the same day does — the models carry a unique
 * index on `(person, attendance_date)`. A pre-flight read here would be a second opinion about a
 * rule the service already enforces, and the answer it gave could be stale by the time the form was
 * submitted. A conflict is reported where it is decided.
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
import { EmptyNotice, LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';

/** `ATTENDANCE_STATUS` in `config/constants.js`, in the order a register is read. */
const STATUSES = [
  { value: 'present', label: 'Present', short: 'P' },
  { value: 'absent', label: 'Absent', short: 'A' },
  { value: 'leave', label: 'Leave', short: 'L' },
  { value: 'late', label: 'Late', short: 'La' },
] as const;

type Status = (typeof STATUSES)[number]['value'];

/**
 * The fields this form renders.
 *
 * `entries.0.status` and friends are **not** here on purpose: a 422 naming an index is routed to the
 * person it belongs to, and anything else goes to the banner. See `splitApiErrors`.
 */
const FORM_FIELDS = new Set([
  'class_id',
  'section_id',
  'academic_session_id',
  'attendance_date',
  'entries',
  'reason',
]);

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
      setRosterState('idle');
      return;
    }

    const controller = new AbortController();
    setRosterState('loading');

    (async () => {
      try {
        const rows: RosterRow[] = teachers
          ? (
              await api.page<{
                id: number;
                employee_id: string;
                first_name: string;
                last_name: string | null;
              }[]>('/teachers', {
                query: { is_active: 'true', limit: OPTION_LIMIT },
                signal: controller.signal,
              })
            ).data.map((row) => ({
              id: row.id,
              first_name: row.first_name,
              last_name: row.last_name,
              reference: row.employee_id,
            }))
          : (
              await api.page<{
                id: number;
                student_id: string;
                first_name: string;
                last_name: string | null;
                roll_number: string | null;
              }[]>('/students', {
                query: {
                  class_id: classId,
                  section_id: sectionId || undefined,
                  status: 'active',
                  limit: OPTION_LIMIT,
                },
                signal: controller.signal,
              })
            ).data.map((row) => ({
              id: row.id,
              first_name: row.first_name,
              last_name: row.last_name,
              reference: row.student_id,
              roll_number: row.roll_number,
            }));

        if (controller.signal.aborted) return;
        setRoster(rows);
        /* Everybody present — see the header on why the default is not "unset". */
        setEntries(Object.fromEntries(rows.map((row) => [row.id, { ...BLANK }])));
        setRosterState('ready');
      } catch (caught) {
        if (controller.signal.aborted) return;
        setRoster([]);
        setEntries({});
        setRosterState('failed');
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        }
      }
    })();

    return () => controller.abort();
  }, [teachers, classId, sectionId, canMark]);

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

      await api.post(teachers ? '/attendance/teachers' : '/attendance/students', body);

      const noun = teachers ? 'teacher' : 'student';
      success(
        `Attendance recorded for ${roster.length} ${noun}${roster.length === 1 ? '' : 's'}`,
        `${counts.present} present · ${counts.absent} absent · ${counts.leave} on leave · ${counts.late} late`
      );
      /* Stay on the screen: the next thing a teacher does is the next section, not the list. */
      if (!teachers) setSectionId('');
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      if (EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
        return;
      }

      /*
       * An entry error arrives as `entries.<index>.<field>`. The index is into the array this screen
       * built, so it maps back to a person — and routing it to that row is the difference between
       * "something is wrong with entry 14" and a message beside the person it is about.
       */
      const routed: Record<number, string> = {};
      for (const [field, message] of Object.entries(caught.fieldErrors())) {
        const match = /^entries\.(\d+)\./.exec(field);
        if (match) {
          const row = roster[Number(match[1])];
          if (row) routed[row.id] = message;
        }
      }
      setEntryErrors(routed);

      const { perField, banner } = splitApiErrors(caught, FORM_FIELDS);
      setFieldErrors(perField);
      setError(
        Object.keys(routed).length && !banner ? 'Some entries were refused — see below.' : banner
      );
      if (Object.keys(perField).length) focusFirstInvalidField();
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

              <SelectField
                id="section_id"
                label="Section"
                value={sectionId}
                onChange={(event) => setSectionId(event.target.value)}
                error={fieldErrors.section_id}
                disabled={!classId || sections.state === 'loading'}
                hint="Blank marks the whole class in one go."
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
            hint="Defaults to today. A day already marked for somebody is refused, so a correction is not made by submitting twice."
          />
        </FormSection>

        {/* ─────────── the register itself ─────────── */}

        {rosterState === 'idle' ? null : rosterState === 'loading' ? (
          <LoadingBlock />
        ) : rosterState === 'failed' ? (
          <EmptyNotice>
            The roster could not be loaded. That needs its own view permission, separate from marking
            attendance.
          </EmptyNotice>
        ) : roster.length === 0 ? (
          <EmptyNotice>
            {teachers
              ? 'No active teacher is on this school, so there is nothing to mark.'
              : `No active student is placed in this ${sectionId ? 'section' : 'class'} yet, so there is nothing to mark.`}
          </EmptyNotice>
        ) : (
          <section aria-labelledby="roster-heading" className="border-t border-border-soft pt-6">
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

        <FormSection title="Internal notes" description="Kept on the audit entry for this register.">
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
          <SubmitButton busy={saving} busyLabel="Recording…" fullWidth={false}>
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
