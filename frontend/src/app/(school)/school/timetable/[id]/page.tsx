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
 * ## Nothing is required by the schema, and five fields are required by the row
 *
 * `schemas.update` is `Joi.object({…}).min(1)` with no `.required()` keys. But this form sends the
 * whole row, not a diff (see `onSubmit`), so a blank is never "unchanged" — it is an attempt to
 * clear the column. Five columns cannot be cleared: `class_id`, `day_of_week`, `period_number`,
 * `start_time` and `end_time` are NOT NULL, which is why the create schema requires them. The server
 * refused a blank on each, but in terms that named the wrong thing — `Number('')` is `0`, so a
 * cleared class came back as "Class must be greater than or equal to 1". So those five are marked
 * required here and a blank is refused before the request, in words. What the two forms share is
 * the five pickers and the way a 422 is sorted, and both of those are shared code
 * (`useTimetablePickers`, `splitApiErrors`) rather than a second copy.
 *
 * ## A stored value is always shown, even when its list is not
 *
 * Each picker's list needs its own view permission, and a list can also be cut short. A select
 * whose options do not include the value it holds displays its first option — so a failed teacher
 * list read "Nobody named" for an entry that has a teacher, and saving would have looked like it
 * cleared one. So a failed list is replaced by a sentence naming what the entry keeps (the create
 * form's failed branches, ported), the paginated lists are read to their end (`useWholeList`), and
 * a stored value missing from whatever did load is added as its own option. The names come from the
 * register's list query, because `GET /timetable/:id` is the bare row.
 *
 * ## Retiring a slot is not the same as freeing it
 *
 * `is_active: false` marks the entry inactive — the register still lists it, badged, unless it is
 * filtered to active entries — and **leaves the unique key claimed**; the routes file is explicit
 * about the second half. So the copy on that control says what it does and what it does not do,
 * because an administrator who reads "retired" as "the slot is free" will hit a 409 on the
 * replacement and have no way to explain it. Moving the row is what frees a slot, which is what the
 * day/period fields above are for.
 *
 * ## A clash names the entry it clashed with
 *
 * The three FR-TT-002 refusals carry the colliding row as `details: { conflict, with }`, which
 * `ApiError` keeps as `context`. The banner used to say only "That teacher is already teaching in
 * this period", leaving the operator to hunt the register for which entry; it now describes that
 * entry and links to it.
 */

import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { splitApiErrors } from '@/lib/formErrors';
import {
  useTimetablePickers,
  useWholeList,
  teacherName,
  dayLabel,
  OPTION_LIMIT,
} from '@/lib/useTimetablePickers';
import type { Picker } from '@/lib/useTimetablePickers';
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

/**
 * The five NOT NULL columns, and what to say when one is left blank. See the header: the form sends
 * the whole row, so a blank here is an attempt to clear a column that cannot be empty.
 */
const REQUIRED = [
  ['class_id', 'Choose a class. Every entry belongs to one, so it cannot be cleared.'],
  ['day_of_week', 'Choose a day.'],
  ['period_number', 'Enter a period number.'],
  ['start_time', 'Enter a start time.'],
  ['end_time', 'Enter an end time.'],
] as const;

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
 * The same row as the register's `GET /timetable` returns it — the four associations its `INCLUDES`
 * join, which are the only place the stored class, section, subject and teacher have a name.
 */
interface ListedEntry {
  id: number;
  class?: { id: number; name: string } | null;
  section?: { id: number; name: string } | null;
  subject?: { id: number; name: string; code: string | null } | null;
  teacher?: { id: number; first_name: string; last_name: string | null } | null;
}

/** What the stored ids are called, when the register could say. */
interface StoredNames {
  class?: string;
  section?: string;
  subject?: string;
  teacher?: string;
}

/**
 * The colliding row a FR-TT-002 refusal carries — `describe()` in `timetable.service.js`, less the
 * one column (`subject_id`) this screen has no use for.
 */
interface Clash {
  id: number;
  class_id: number;
  section_id: number | null;
  teacher_id: number | null;
  room: string | null;
  day_of_week: string;
  period_number: number;
}

/** `ApiError.context.with`, when it is the row shape above; `null` for any other refusal. */
function clashOf(caught: ApiError): Clash | null {
  const other = caught.context?.with;
  if (caught.status !== 409 || !other || typeof other !== 'object') return null;
  const row = other as Partial<Clash>;
  return typeof row.id === 'number' && typeof row.day_of_week === 'string' ? (row as Clash) : null;
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

/** " Showing the first 100 of 140 by name." — or nothing, for a list that loaded whole. */
function shortfall<T>(picker: Picker<T>, order = ''): string {
  return picker.state === 'ready' && picker.total > picker.rows.length
    ? ` Showing the first ${picker.rows.length} of ${picker.total}${order}.`
    : '';
}

/**
 * The stored value as its own option, when the list on screen does not hold it.
 *
 * Without it the select would display its first option — "None", "Nobody named" — for a value it
 * is in fact holding and will send back unchanged. Shown while the list is still loading too, so the
 * control reads as the entry does from the first paint.
 */
function storedOption<T extends { id: number }>(
  picker: Picker<T>,
  storedId: number | null | undefined,
  name: string | undefined,
  fallback: string
): ReactNode {
  if (storedId === null || storedId === undefined) return null;
  if (picker.state === 'ready' && picker.rows.some((row) => row.id === storedId)) return null;
  return <option value={storedId}>{name ? `${name} — current` : fallback}</option>;
}

/**
 * A picker whose list could not be loaded: its label, and a sentence in place of the control.
 *
 * No `SelectField`, so no `<label>` — the component draws one for a control and this branch has
 * none. The heading borrows `.field-label` so it still reads as the field it stands in for, the way
 * the create form's failed branches do.
 */
function Unavailable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="field-label mb-1.5">{label}</p>
      <p className="text-sm text-muted">{children}</p>
    </div>
  );
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

  /* The row as loaded, and what its ids are called — see "A stored value is always shown". */
  const [stored, setStored] = useState<Entry | null>(null);
  const [storedNames, setStoredNames] = useState<StoredNames>({});

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [clash, setClash] = useState<Clash | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /* The five pickers, keyed on whichever class the form currently holds, and the four paginated
     ones read past their first page. Sections are one unpaginated call and need nothing. */
  const pickers = useTimetablePickers(values.class_id, canManage);
  const { sections } = pickers;
  const classes = useWholeList('/classes', pickers.classes);
  const subjects = useWholeList('/subjects', pickers.subjects);
  const teachers = useWholeList('/teachers', pickers.teachers);
  const sessions = useWholeList('/sessions', pickers.sessions);

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
        setStored(entry);
        setStoredNames({});
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

        /*
         * The names behind the stored ids. `show()` hands back the bare row, so the register's list
         * query — whose `INCLUDES` join all four — is asked for this slot's class, day and period,
         * which returns this row among at most a handful. Only the names ride on it: a failure here
         * leaves the ids in place and the options fall back to saying "the one it has now".
         */
        try {
          const listed = await api.page<ListedEntry[]>('/timetable', {
            query: {
              class_id: entry.class_id,
              day_of_week: entry.day_of_week,
              period_number: entry.period_number,
              limit: OPTION_LIMIT,
            },
            signal: controller.signal,
          });
          const match = listed.data.find((row) => row.id === entry.id);
          if (match && !controller.signal.aborted) {
            setStoredNames({
              class: match.class?.name,
              section: match.section?.name,
              subject: match.subject
                ? `${match.subject.name}${match.subject.code ? ` (${match.subject.code})` : ''}`
                : undefined,
              teacher: match.teacher
                ? [match.teacher.first_name, match.teacher.last_name].filter(Boolean).join(' ')
                : undefined,
            });
          }
        } catch {
          /* Names only — see above. */
        }
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

  /** "It clashes with Monday, period 3 · Grade 7 (whole class) · taught by Ada Lovelace · in Lab 2." */
  function describeClash(other: Clash): string {
    const klass =
      classes.state === 'ready' ? classes.rows.find((row) => row.id === other.class_id) : undefined;
    /* The section list on screen is the chosen class's, so it can only name a section of that one. */
    const section =
      other.section_id !== null &&
      other.class_id === Number(values.class_id) &&
      sections.state === 'ready'
        ? sections.rows.find((row) => row.id === other.section_id)
        : undefined;
    const teacher =
      other.teacher_id !== null && teachers.state === 'ready'
        ? teachers.rows.find((row) => row.id === other.teacher_id)
        : undefined;

    const parts = [
      `${dayLabel(other.day_of_week)}, period ${other.period_number}`,
      `${klass ? klass.name : 'another class'}${
        other.section_id === null ? ' (whole class)' : section ? `, ${section.name}` : ' (one section)'
      }`,
      teacher ? `taught by ${teacherName(teacher)}` : null,
      other.room ? `in ${other.room}` : null,
    ].filter(Boolean);
    return `It clashes with ${parts.join(' · ')}.`;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setClash(null);

    /* The five NOT NULL columns — see the header. Refused here rather than sent as `0` or `''`. */
    const missing: Record<string, string> = {};
    for (const [key, message] of REQUIRED) {
      if (!values[key].trim()) missing[key] = message;
    }
    if (Object.keys(missing).length) {
      setFieldErrors(missing);
      focusFirstInvalidField();
      return;
    }

    setSaving(true);
    setFieldErrors({});

    try {
      /*
       * The whole form is sent, not a diff. `.min(1)` would accept a diff, but computing one means
       * deciding whether a cleared field is "set to null" or "unchanged" — and getting that wrong
       * silently drops an edit. Blanks on the nullable columns go as `null`, which is what clearing
       * a room or a teacher means; the two booleans always carry their current state; and the five
       * NOT NULL columns cannot be blank by the time this runs.
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
      if (!(caught instanceof ApiError)) {
        /*
         * A failed `fetch` is a TypeError, not an ApiError. This used to rethrow it, which from a
         * submit handler is an unhandled rejection: the button stopped spinning and nothing said
         * whether the edit had been saved.
         */
        setError('Could not reach the server. Check your connection and try again.');
      } else if (EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else {
        const { perField, banner } = splitApiErrors(caught, FORM_FIELDS);
        setFieldErrors(perField);
        setError(banner);
        /* A FR-TT-002 refusal carries the row it collided with — see the header. */
        setClash(clashOf(caught));
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

  /* The stored section belongs to the stored class; once the class changes it is not an option. */
  const storedSection =
    stored && values.class_id === String(stored.class_id) ? stored.section_id : null;

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Edit timetable entry"
        description="Move the period, change what happens in it, or retire it. Class, day, period and the two times cannot be left blank; only what you change is what changes."
        action={
          <Link href="/school/timetable" className="btn btn-secondary">
            <Icon name="chevron-left" size={15} />
            Back to the register
          </Link>
        }
      />

      {error ? (
        <Notice tone="error">
          {error}
          {clash ? (
            <>
              {' '}
              {describeClash(clash)}{' '}
              <Link
                href={`/school/timetable/${clash.id}`}
                className="font-medium underline underline-offset-2"
              >
                Open that entry
              </Link>
            </>
          ) : null}
        </Notice>
      ) : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The slot"
          description="Which class, on which day, in which period. Moving any of these is what frees the old slot."
        >
          {classes.state === 'failed' ? (
            <Unavailable label="Class">
              The class list could not be loaded, so the class cannot be changed here — the entry
              stays with {storedNames.class ?? 'the class it has now'}. Reading the list needs the
              separate &ldquo;View classes&rdquo; permission.
            </Unavailable>
          ) : (
            <SelectField
              id="class_id"
              label="Class"
              required
              value={values.class_id}
              onChange={onClassChange}
              error={fieldErrors.class_id}
              disabled={classes.state === 'loading'}
              hint={`In promotion order.${shortfall(classes)}`}
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
              {storedOption(classes, stored?.class_id, storedNames.class, 'The class it has now')}
            </SelectField>
          )}

          {sections.state === 'failed' ? (
            <Unavailable label="Section">
              This class&rsquo;s sections could not be loaded, so the section cannot be changed here
              {values.section_id
                ? ` — the entry stays with ${storedNames.section ?? 'the section it has now'}.`
                : ' — the entry is for the whole class.'}
            </Unavailable>
          ) : (
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
              {storedOption(sections, storedSection, storedNames.section, 'The section it has now')}
            </SelectField>
          )}

          <SelectField
            id="day_of_week"
            label="Day"
            required
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
            required
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
            required
            value={values.start_time}
            onChange={set('start_time')}
            error={fieldErrors.start_time}
          />

          <Field
            id="end_time"
            label="Ends"
            type="time"
            required
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
          {subjects.state === 'failed' ? (
            <Unavailable label="Subject">
              The subject list could not be loaded, so the subject cannot be changed here — the
              entry keeps{' '}
              {values.subject_id ? storedNames.subject ?? 'the subject it has now' : 'no subject'}.
              Reading the list needs the separate &ldquo;View subjects&rdquo; permission.
            </Unavailable>
          ) : (
            <SelectField
              id="subject_id"
              label="Subject"
              value={values.subject_id}
              onChange={set('subject_id')}
              error={fieldErrors.subject_id}
              disabled={subjects.state === 'loading'}
              hint={`Required in practice for a lesson — the model refuses a teaching period with no subject. Mark the slot a break below to leave it empty.${shortfall(subjects, ' by name')}`}
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
              {storedOption(subjects, stored?.subject_id, storedNames.subject, 'The subject it has now')}
            </SelectField>
          )}

          {teachers.state === 'failed' ? (
            <Unavailable label="Teacher">
              The teacher list could not be loaded, so the teacher cannot be changed here — the
              entry keeps{' '}
              {values.teacher_id ? storedNames.teacher ?? 'the teacher it has now' : 'nobody named'}.
              Reading the list needs the &ldquo;View teachers&rdquo; permission and a plan that
              carries the Teachers module.
            </Unavailable>
          ) : (
            <SelectField
              id="teacher_id"
              label="Teacher"
              value={values.teacher_id}
              onChange={set('teacher_id')}
              error={fieldErrors.teacher_id}
              disabled={teachers.state === 'loading'}
              hint={`Clearing this frees the teacher for that period; a teacher already booked elsewhere is refused with a conflict.${shortfall(teachers, ' by first name')}`}
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
              {storedOption(teachers, stored?.teacher_id, storedNames.teacher, 'The teacher it has now')}
            </SelectField>
          )}

          {sessions.state === 'failed' ? (
            <Unavailable label="Academic session">
              The academic session list could not be loaded, so the session cannot be changed here —
              the entry{' '}
              {values.academic_session_id
                ? 'keeps the session it is tagged to'
                : 'stays untagged'}
              . Reading the list needs the &ldquo;View academic sessions&rdquo; permission.
            </Unavailable>
          ) : (
            <SelectField
              id="academic_session_id"
              label="Academic session"
              value={values.academic_session_id}
              onChange={set('academic_session_id')}
              error={fieldErrors.academic_session_id}
              disabled={sessions.state === 'loading'}
              hint={shortfall(sessions, ', newest first').trim() || undefined}
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
              {/* The register's list does not join the session, so there is no name to give it. */}
              {storedOption(sessions, stored?.academic_session_id, undefined, 'The session it is tagged to now')}
            </SelectField>
          )}
        </FormSection>

        <FormSection
          title="Details"
          description="Naming and location, whether the slot is a lesson, and whether the entry is active."
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
            label="Status"
            value={values.is_active}
            onChange={set('is_active')}
            error={fieldErrors.is_active}
            /*
             * The one sentence on this screen that has to be exactly right. `timetable.routes.js`
             * says "`is_active` does not free a slot" — the unique key still holds it — so an
             * administrator who reads "retired" as "available" will be refused on the replacement
             * with a conflict they cannot account for. Move the period instead.
             *
             * It used to say retiring "hides it from the register" as well, which is not so: the
             * register lists active and retired entries by default and badges the retired ones. The
             * label was "On the register" for the same reason, and is the plain word now.
             */
            hint="Retiring marks the entry inactive: the register still lists it, badged, unless it is filtered to active entries — and the period stays claimed. To free the period for something else, change the day or period above rather than retiring this entry."
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
