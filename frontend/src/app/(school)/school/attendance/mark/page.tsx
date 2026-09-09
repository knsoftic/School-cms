'use client';

/**
 * Mark student attendance — SRS §16, FR-ATT-001. The route that had no caller.
 *
 * ## Why this screen exists
 *
 * `POST /attendance/students` is mounted behind `attendance.mark` and **nothing in the frontend
 * called it**. The Attendance screen listed records and contained no form and no write call of any
 * kind, so §16 — a whole section of the source — was readable and not usable: a school could look at
 * an attendance register it had no way to fill in.
 *
 * ## A register, not a form
 *
 * `entries` is an array of 1–500 `{ student_id, status, late_minutes, remarks }`, and the class is
 * named once at the top. So the natural shape is the paper thing it replaces: choose the class, the
 * section and the day, and mark the children.
 *
 * That is why this is not built out of `Field`/`SelectField` per student. Twenty-five children ×
 * four statuses as twenty-five dropdowns is twenty-five interactions to record a normal morning. The
 * status control is a **radio group per row rendered as a segmented button**, which is one click per
 * child, and the two bulk buttons make the common case — everybody present — a single click.
 *
 * Underneath they are real `<input type="radio">` elements sharing a per-student `name`, so a
 * keyboard user gets arrow-key selection within a row and tab between rows for free, and a screen
 * reader announces a named group. The appearance is `:checked` styling on the label; nothing is
 * simulated.
 *
 * ## Everybody defaults to present
 *
 * The smart default, and the one the source implies: `ATTENDANCE_STATUS` is
 * `{ present, absent, leave, late }` and an ordinary day is mostly the first. Defaulting to *unset*
 * would mean a register cannot be submitted until every child is touched, which is how a teacher
 * ends up marking thirty children present one at a time.
 *
 * It also means the payload always carries every student, which is what the endpoint wants: this is
 * a **register for a day**, not a list of exceptions.
 *
 * ## `late_minutes` appears only for `late`
 *
 * The column is on the model and the schema accepts it on any entry, but it only means anything for
 * a late arrival. Rendering it always would put a number box against every present child.
 *
 * ## One thing this screen deliberately does not do
 *
 * It does not check whether the day has already been marked. `POST /attendance/students` is the only
 * writer and `attendance.service.js` owns what a second submission for the same day does — the model
 * carries `attendance_students_unique` on `(student_id, attendance_date)`. A pre-flight read here
 * would be a second opinion about a rule the service already enforces, and the answer it gave could
 * be stale by the time the form was submitted. A conflict is reported where it is decided.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
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
 * The fields this form renders.
 *
 * `entries.0.status` and friends are **not** here on purpose: a 422 naming an index is routed to the
 * student it belongs to, and anything else goes to the banner. See `splitApiErrors`.
 */
const FORM_FIELDS = new Set([
  'class_id',
  'section_id',
  'academic_session_id',
  'attendance_date',
  'entries',
  'reason',
]);

interface StudentRow {
  id: number;
  student_id: string;
  first_name: string;
  last_name: string | null;
  roll_number: string | null;
}

/** What the register holds for one child. */
interface Entry {
  status: Status;
  lateMinutes: string;
  remarks: string;
}

/** Today as `YYYY-MM-DD` in the viewer's zone, which is the day they mean by "today". */
function today(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function studentName(row: StudentRow): string {
  return [row.first_name, row.last_name].filter(Boolean).join(' ');
}

export default function MarkAttendancePage() {
  const { can } = useAuth();
  const { success } = useToast();

  const canMark = can('attendance.mark');

  const [classId, setClassId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState('');

  const { classes, sections } = useClassSections(classId, canMark);

  const [students, setStudents] = useState<StudentRow[]>([]);
  const [rosterState, setRosterState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [entries, setEntries] = useState<Record<number, Entry>>({});

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** A 422 that named `entries.<n>.…`, keyed by student id so it renders on that row. */
  const [entryErrors, setEntryErrors] = useState<Record<number, string>>({});

  /*
   * The roster follows the class and section.
   *
   * `?status=active` narrows it, and that narrowing is this screen's judgement rather than the
   * endpoint's: `GET /students` filters on `class_id` / `section_id` and says nothing about status,
   * but a register for today is a register of the children who are here today. A student who has
   * transferred out should not be markable.
   */
  useEffect(() => {
    if (!classId || !canMark) {
      setStudents([]);
      setEntries({});
      setRosterState('idle');
      return;
    }

    const controller = new AbortController();
    setRosterState('loading');

    (async () => {
      try {
        const page = await api.page<StudentRow[]>('/students', {
          query: {
            class_id: classId,
            section_id: sectionId || undefined,
            status: 'active',
            limit: OPTION_LIMIT,
          },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setStudents(page.data);
        /* Everybody present — see the header on why the default is not "unset". */
        setEntries(
          Object.fromEntries(
            page.data.map((row) => [row.id, { status: 'present' as Status, lateMinutes: '', remarks: '' }])
          )
        );
        setRosterState('ready');
      } catch (caught) {
        if (controller.signal.aborted) return;
        setStudents([]);
        setEntries({});
        setRosterState('failed');
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        }
      }
    })();

    return () => controller.abort();
  }, [classId, sectionId, canMark]);

  const counts = useMemo(() => {
    const tally: Record<string, number> = { present: 0, absent: 0, leave: 0, late: 0 };
    for (const entry of Object.values(entries)) tally[entry.status] += 1;
    return tally;
  }, [entries]);

  function setStatus(studentId: number, status: Status) {
    setEntries((prev) => ({ ...prev, [studentId]: { ...prev[studentId], status } }));
  }

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
      await api.post('/attendance/students', {
        class_id: Number(classId),
        section_id: sectionId ? Number(sectionId) : undefined,
        attendance_date: date,
        entries: students.map((row) => {
          const entry = entries[row.id];
          return {
            student_id: row.id,
            status: entry.status,
            /* Only for a late arrival, and only when a figure was given. */
            late_minutes:
              entry.status === 'late' && entry.lateMinutes.trim()
                ? Number(entry.lateMinutes)
                : undefined,
            remarks: entry.remarks.trim() || undefined,
          };
        }),
        reason: reason.trim() || undefined,
      });

      success(
        `Attendance recorded for ${students.length} student${students.length === 1 ? '' : 's'}`,
        `${counts.present} present · ${counts.absent} absent · ${counts.leave} on leave · ${counts.late} late`
      );
      /* Stay on the screen: the next thing a teacher does is the next section, not the list. */
      setSectionId('');
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      if (EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
        return;
      }

      /*
       * An entry error arrives as `entries.<index>.<field>`. The index is into the array this screen
       * built, so it maps back to a student — and routing it to that row is the difference between
       * "something is wrong with entry 14" and a message beside the child it is about.
       */
      const routed: Record<number, string> = {};
      for (const [field, message] of Object.entries(caught.fieldErrors())) {
        const match = /^entries\.(\d+)\./.exec(field);
        if (match) {
          const row = students[Number(match[1])];
          if (row) routed[row.id] = message;
        }
      }
      setEntryErrors(routed);

      const { perField, banner } = splitApiErrors(caught, FORM_FIELDS);
      setFieldErrors(perField);
      setError(Object.keys(routed).length && !banner ? 'Some entries were refused — see below.' : banner);
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
            message: 'Marking attendance needs the attendance.mark permission.',
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Mark attendance"
        description="Choose a class and a day, then mark the register. Everybody starts as present — change only the children who were not."
        action={
          <Link href="/school/attendance" className="btn btn-secondary">
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
          description="Which children, and for which day. A section is optional — leave it unset for the whole class."
        >
          <SelectField
            id="class_id"
            label="Class"
            required
            value={classId}
            onChange={(event) => {
              setClassId(event.target.value);
              /* The section belongs to the class; carrying one over would name another class's. */
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

          <Field
            id="attendance_date"
            label="Day"
            type="date"
            required
            value={date}
            onChange={(event) => setDate(event.target.value)}
            error={fieldErrors.attendance_date}
            hint="Defaults to today. A day already marked for a child is refused, so a correction is not made by submitting twice."
          />
        </FormSection>

        {/* ─────────── the register itself ─────────── */}

        {rosterState === 'idle' ? null : rosterState === 'loading' ? (
          <LoadingBlock />
        ) : rosterState === 'failed' ? (
          <EmptyNotice>
            The class roster could not be loaded. That needs `students.view`, which is a separate
            grant from marking attendance.
          </EmptyNotice>
        ) : students.length === 0 ? (
          <EmptyNotice>
            No active student is placed in this {sectionId ? 'section' : 'class'} yet, so there is
            nothing to mark.
          </EmptyNotice>
        ) : (
          <section aria-labelledby="roster-heading" className="border-t border-border-soft pt-6">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div className="max-w-xl">
                <h2 id="roster-heading" className="text-base font-semibold tracking-tight text-ink">
                  {students.length} student{students.length === 1 ? '' : 's'}
                </h2>
                {/*
                  * The tally in words as well as figures, so the register can be checked against a
                  * headcount before it is submitted — which is what a teacher actually does.
                  */}
                <p className="mt-1 text-sm leading-relaxed text-muted">
                  {counts.present} present · {counts.absent} absent · {counts.leave} on leave ·{' '}
                  {counts.late} late
                </p>
              </div>

              {/* The common case in one click, and its opposite for a closure or a trip. */}
              <div className="flex gap-2">
                <button type="button" onClick={() => setAll('present')} className="btn btn-secondary btn-sm">
                  All present
                </button>
                <button type="button" onClick={() => setAll('absent')} className="btn btn-secondary btn-sm">
                  All absent
                </button>
              </div>
            </div>

            <ul className="space-y-px overflow-hidden rounded-md border border-border-strong">
              {students.map((row) => {
                const entry = entries[row.id];
                if (!entry) return null;
                const rowError = entryErrors[row.id];

                return (
                  <li key={row.id} className="bg-surface-1 px-3 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">
                          {studentName(row)}
                        </span>
                        <span className="block text-xs text-muted-soft">
                          {row.roll_number ? `Roll ${row.roll_number} · ` : ''}
                          {row.student_id}
                        </span>
                      </div>

                      {/*
                        * A real radio group. `role` and `aria` are not simulated: each option is an
                        * `<input type="radio">` sharing this student's `name`, so arrow keys move
                        * within the row and a screen reader announces the group and the choice. The
                        * segmented appearance is `:checked` styling on the label.
                        */}
                      <fieldset className="shrink-0">
                        <legend className="sr-only">Attendance for {studentName(row)}</legend>
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
                                  onChange={() => setStatus(row.id, option.value)}
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
                        <label
                          htmlFor={`late-${row.id}`}
                          className="field-label mb-1.5 block text-xs"
                        >
                          Minutes late
                        </label>
                        <input
                          id={`late-${row.id}`}
                          type="number"
                          min={0}
                          value={entry.lateMinutes}
                          onChange={(event) =>
                            setEntries((prev) => ({
                              ...prev,
                              [row.id]: { ...prev[row.id], lateMinutes: event.target.value },
                            }))
                          }
                          className="field-input mt-0"
                        />
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
            hint="Up to 255 characters. Worth using when a whole class is marked absent."
          />
        </FormSection>

        <FormActions cancelHref="/school/attendance" cancelLabel="Cancel">
          <SubmitButton
            busy={saving}
            busyLabel="Recording…"
            fullWidth={false}
          >
            {students.length
              ? `Record ${students.length} student${students.length === 1 ? '' : 's'}`
              : 'Record attendance'}
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
