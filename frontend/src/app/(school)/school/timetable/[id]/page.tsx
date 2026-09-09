'use client';

/**
 * Correct one timetable slot — SRS §14.6 / FR-TT-001, and the route that had no caller.
 *
 * ## Why this screen exists
 *
 * `timetable.routes.js` mounts `PATCH /:id` and **no DELETE at all** — its own header says so:
 * *"## No DELETE, and `is_active` does not free a slot"*. So an edit is the only way a slot ever
 * changes, and until now nothing in the frontend issued one. The register was a read-only list with
 * no row action and no `[id]` route anywhere in the app.
 *
 * The consequence was not cosmetic. `timetables_section_day_period_unique` keeps the slot claimed by
 * whatever row holds it, so a mistyped period number or a wrong room could not be fixed **and** the
 * correct entry could not be created either — the second attempt 409s against a row the operator
 * cannot reach. The create form promises this screen in its own words: *"the period stays claimed
 * until this entry is edited."*
 *
 * ## Everything is optional, and that is the schema's decision
 *
 * `schemas.update` is `Joi.object({…}).min(1)` with no `.required()` keys, so this form marks
 * nothing required — unlike the create form, where five fields are. What the two forms share is the
 * five pickers and the way a 422 is sorted, and both of those are now shared code
 * (`useTimetablePickers`, `splitApiErrors`) rather than a second copy.
 *
 * ## Retiring a slot is not the same as freeing it
 *
 * `is_active: false` takes the period off the register and **leaves the unique key claimed** — the
 * routes file is explicit about it. So the copy on that control says what it does and what it does
 * not do, because an administrator who reads "inactive" as "the slot is free" will hit a 409 on the
 * replacement and have no way to explain it. Moving the row is what frees a slot, which is what the
 * day/period fields above are for.
 */

import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { splitApiErrors } from '@/lib/formErrors';
import {
  useTimetablePickers,
  teacherName,
  dayLabel,
} from '@/lib/useTimetablePickers';
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
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
} from '@/components/table';

/** `WEEKDAYS` in `config/constants.js`, in the order the ENUM declares them. */
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/**
 * The fields this form renders an input for.
 *
 * Anything else a 422 names goes to the banner — see `splitApiErrors`, which exists because the two
 * likeliest mistakes here (`timeOrdered`, `teachingSlotNeedsSubject`) are model-level validators
 * reported under their own names rather than under a column.
 */
const FORM_FIELDS = new Set([
  'class_id',
  'section_id',
  'day_of_week',
  'period_number',
  'start_time',
  'end_time',
  'subject_id',
  'teacher_id',
  'academic_session_id',
  'period_label',
  'room',
  'is_break',
  'is_active',
  'reason',
]);

/** One row of `GET /timetable/:id`, as `ApiResponse.ok(res, { entry })` sends it. */
interface Entry {
  id: number;
  class_id: number;
  section_id: number | null;
  day_of_week: string;
  period_number: number;
  start_time: string;
  end_time: string;
  subject_id: number | null;
  teacher_id: number | null;
  academic_session_id: number | null;
  period_label: string | null;
  room: string | null;
  is_break: boolean;
  is_active: boolean;
}

/**
 * `TIME` from MySQL is `HH:MM:SS`; `<input type="time">` wants `HH:MM`.
 *
 * Feeding the seconds straight in leaves the control empty in some browsers and silently drops the
 * value — a form that looks like it has no start time for a row that does.
 */
function toTimeInput(value: string | null): string {
  if (!value) return '';
  const match = /^(\d{2}):(\d{2})/.exec(value);
  return match ? `${match[1]}:${match[2]}` : value;
}

export default function EditTimetableEntryPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const entryId = params.id;
  const canManage = can('timetable.manage');

  const [values, setValues] = useState({
    class_id: '',
    section_id: '',
    day_of_week: '',
    period_number: '',
    start_time: '',
    end_time: '',
    subject_id: '',
    teacher_id: '',
    academic_session_id: '',
    period_label: '',
    room: '',
    is_break: '',
    is_active: '',
    reason: '',
  });

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /* The five pickers, keyed on whichever class the form currently holds. */
  const { classes, sections, subjects, teachers, sessions } = useTimetablePickers(
    values.class_id,
    canManage
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setRefusal(null);

    (async () => {
      try {
        const body = await api.get<{ entry: Entry }>(`/timetable/${entryId}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const entry = body.entry;
        /*
         * Every control is seeded, including the two booleans as the strings their selects use.
         * A `''` here would mean "not sent", and on an edit form that would quietly clear a flag the
         * operator never touched.
         */
        setValues({
          class_id: String(entry.class_id),
          section_id: entry.section_id === null ? '' : String(entry.section_id),
          day_of_week: entry.day_of_week,
          period_number: String(entry.period_number),
          start_time: toTimeInput(entry.start_time),
          end_time: toTimeInput(entry.end_time),
          subject_id: entry.subject_id === null ? '' : String(entry.subject_id),
          teacher_id: entry.teacher_id === null ? '' : String(entry.teacher_id),
          academic_session_id:
            entry.academic_session_id === null ? '' : String(entry.academic_session_id),
          period_label: entry.period_label ?? '',
          room: entry.room ?? '',
          is_break: entry.is_break ? 'true' : 'false',
          is_active: entry.is_active ? 'true' : 'false',
          reason: '',
        });
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
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
  }, [entryId, attempt]);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  function onClassChange(event: { target: { value: string } }) {
    /* The section goes with the class: `loadSectionOfClass` requires the pair to agree, so a section
       carried over from the previous class is a guaranteed 422 nobody can see coming. */
    setValues((prev) => ({ ...prev, class_id: event.target.value, section_id: '' }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      /*
       * The whole form is sent, not a diff. `.min(1)` would accept a diff, but computing one means
       * deciding whether a cleared field is "set to null" or "unchanged" — and getting that wrong
       * silently drops an edit. Blanks on the nullable columns go as `null`, which is what clearing
       * a room or a teacher means; the two booleans always carry their current state.
       */
      await api.patch(`/timetable/${entryId}`, {
        class_id: Number(values.class_id),
        section_id: values.section_id ? Number(values.section_id) : null,
        day_of_week: values.day_of_week,
        period_number: Number(values.period_number),
        start_time: values.start_time,
        end_time: values.end_time,
        subject_id: values.subject_id ? Number(values.subject_id) : null,
        teacher_id: values.teacher_id ? Number(values.teacher_id) : null,
        academic_session_id: values.academic_session_id
          ? Number(values.academic_session_id)
          : null,
        period_label: values.period_label.trim() || null,
        room: values.room.trim() || null,
        is_break: values.is_break === 'true',
        is_active: values.is_active === 'true',
        reason: values.reason.trim() || undefined,
      });

      success('Timetable entry updated');
      router.replace('/school/timetable');
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      if (EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else {
        const { perField, banner } = splitApiErrors(caught, FORM_FIELDS);
        setFieldErrors(perField);
        setError(banner);
        if (Object.keys(perField).length) focusFirstInvalidField();
      }
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <div className="max-w-2xl">
        <PageHeader title="Timetable entry" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'Editing the timetable needs the timetable.manage permission.',
          }}
        />
      </div>
    );
  }

  if (refusal) {
    return (
      <div className="max-w-2xl">
        <PageHeader title="Timetable entry" />
        <RefusalNotice refusal={refusal} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-2xl">
        <PageHeader title="Timetable entry" />
        <ErrorNotice message={loadError} onRetry={reload} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-2xl">
        <PageHeader title="Timetable entry" />
        <LoadingBlock />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Edit timetable entry"
        description="Move the period, change what happens in it, or take it off the register. Nothing here is required — only what you change is what changes."
        action={
          <Link href="/school/timetable" className="btn btn-secondary">
            <Icon name="chevron-left" size={15} />
            Back to the register
          </Link>
        }
      />

      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The slot"
          description="Which class, on which day, in which period. Moving any of these is what frees the old slot."
        >
          <SelectField
            id="class_id"
            label="Class"
            value={values.class_id}
            onChange={onClassChange}
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
            value={values.section_id}
            onChange={set('section_id')}
            error={fieldErrors.section_id}
            disabled={!values.class_id || sections.state === 'loading'}
            hint="Blank means the whole class. A section named without a class is refused."
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

          <SelectField
            id="day_of_week"
            label="Day"
            value={values.day_of_week}
            onChange={set('day_of_week')}
            error={fieldErrors.day_of_week}
          >
            <option value="">Choose a day</option>
            {DAYS.map((day) => (
              <option key={day} value={day}>
                {dayLabel(day)}
              </option>
            ))}
          </SelectField>

          <Field
            id="period_number"
            label="Period"
            type="number"
            min={1}
            value={values.period_number}
            onChange={set('period_number')}
            error={fieldErrors.period_number}
            hint="Unique per section and day. Changing it is how a mistyped period is corrected."
          />

          <Field
            id="start_time"
            label="Starts"
            type="time"
            value={values.start_time}
            onChange={set('start_time')}
            error={fieldErrors.start_time}
          />

          <Field
            id="end_time"
            label="Ends"
            type="time"
            value={values.end_time}
            onChange={set('end_time')}
            error={fieldErrors.end_time}
            hint="Must be after the start. The model checks the pair, so a bad order is reported above rather than here."
          />
        </FormSection>

        <FormSection
          title="What happens in it"
          description="The subject and the teacher taking it. A break needs neither."
        >
          <SelectField
            id="subject_id"
            label="Subject"
            value={values.subject_id}
            onChange={set('subject_id')}
            error={fieldErrors.subject_id}
            disabled={subjects.state === 'loading'}
            hint="Required in practice for a lesson — the model refuses a teaching period with no subject. Mark the slot a break below to leave it empty."
          >
            <option value="">
              {subjects.state === 'loading' ? 'Loading…' : 'None (break only)'}
            </option>
            {subjects.state === 'ready'
              ? subjects.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name} ({row.code})
                    {row.is_active ? '' : ' — inactive'}
                  </option>
                ))
              : null}
          </SelectField>

          <SelectField
            id="teacher_id"
            label="Teacher"
            value={values.teacher_id}
            onChange={set('teacher_id')}
            error={fieldErrors.teacher_id}
            disabled={teachers.state === 'loading'}
            hint="Clearing this frees the teacher for that period; a teacher already booked elsewhere is refused with a conflict."
          >
            <option value="">
              {teachers.state === 'loading' ? 'Loading…' : 'Nobody named'}
            </option>
            {teachers.state === 'ready'
              ? teachers.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {teacherName(row)} ({row.employee_id})
                    {row.is_active ? '' : ' — inactive'}
                  </option>
                ))
              : null}
          </SelectField>

          <SelectField
            id="academic_session_id"
            label="Academic session"
            value={values.academic_session_id}
            onChange={set('academic_session_id')}
            error={fieldErrors.academic_session_id}
            disabled={sessions.state === 'loading'}
          >
            <option value="">
              {sessions.state === 'loading' ? 'Loading…' : 'Not tagged to a session'}
            </option>
            {sessions.state === 'ready'
              ? sessions.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                    {row.is_current ? ' — current' : ''}
                  </option>
                ))
              : null}
          </SelectField>
        </FormSection>

        <FormSection
          title="Details"
          description="Naming and location, and whether the slot is on the register at all."
        >
          <Field
            id="period_label"
            label="Period label"
            maxLength={60}
            value={values.period_label}
            onChange={set('period_label')}
            error={fieldErrors.period_label}
            hint="Optional, e.g. “Assembly” or “Double period”."
          />

          <Field
            id="room"
            label="Room"
            maxLength={60}
            value={values.room}
            onChange={set('room')}
            error={fieldErrors.room}
            hint="Optional. A room already booked for that period is refused with a conflict."
          />

          <SelectField
            id="is_break"
            label="Break"
            value={values.is_break}
            onChange={set('is_break')}
            error={fieldErrors.is_break}
            hint="A break excuses the subject requirement. It still occupies the period."
          >
            <option value="false">A lesson</option>
            <option value="true">A break</option>
          </SelectField>

          <SelectField
            id="is_active"
            label="On the register"
            value={values.is_active}
            onChange={set('is_active')}
            error={fieldErrors.is_active}
            /*
             * The one sentence on this screen that has to be exactly right. `timetable.routes.js`
             * says "`is_active` does not free a slot" — the unique key still holds it — so an
             * administrator who reads "retired" as "available" will be refused on the replacement
             * with a conflict they cannot account for. Move the period instead.
             */
            hint="Retiring a slot hides it from the register but keeps the period claimed. To free the period for something else, change the day or period above rather than retiring this entry."
          >
            <option value="true">Active</option>
            <option value="false">Retired</option>
          </SelectField>
        </FormSection>

        <FormSection
          title="Internal notes"
          description="Kept on the audit entry for this change."
        >
          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            hint="Up to 255 characters, recorded against this edit. Optional."
          />
        </FormSection>

        <FormActions cancelHref="/school/timetable" cancelLabel="Cancel">
          <SubmitButton busy={saving} busyLabel="Saving…" fullWidth={false}>
            Save changes
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
