'use client';

/**
 * Create a timetable entry — SRS §20.1, FR-TT-001, Known Issue 30.
 *
 * Follows `(platform)/super-admin/organizations/new/page.tsx`, which is where the shared decisions
 * are argued, and `(school)/school/classes/new/page.tsx`, which is where the foreign-key pickers and
 * the promote-an-unplaceable-message rule are argued. Only what is different about *this* create is
 * written down here.
 *
 * ## The field set is the create schema's
 *
 * `timetable.validation.js` `create` takes `school_id`, `class_id`, `day_of_week`, `period_number`,
 * `start_time`, `end_time`, `section_id`, `subject_id`, `teacher_id`, `academic_session_id`,
 * `period_label`, `room`, `is_break`, `is_active` and `reason`, and marks exactly five `.required()`:
 * **`class_id`**, **`day_of_week`**, **`period_number`**, **`start_time`** and **`end_time`**. This
 * form marks the same five.
 *
 * `id`, `organization_id` and `created_by` are `forbidden()` rather than merely absent, so they have
 * no control here: `organization_id` is copied from the school row and `created_by` from the
 * authenticated user.
 *
 * `school_id` is accepted by the schema and is still not on this form, for the reason
 * `classes/new/page.tsx` sets out at length: `resolveSchool()` reads it only when the caller has no
 * school of their own, and on this surface the caller always has one. The cost is the same — a 422
 * naming a field this form does not render — and the answer is the same `FORM_FIELDS` promotion.
 *
 * ## `subject_id` is optional in the schema and all but required by the model
 *
 * `teachingSlotNeedsSubject` refuses any row that is not a break and names no subject, so in practice
 * a lesson must have one. It is **not** marked required here, because the schema does not mark it and
 * the schema's own comment says why: requiring it would make a break impossible to record. The rule
 * is stated in the field's hint instead, where it can say the part the word `required` cannot — that
 * ticking *Break* is what excuses it.
 *
 * ## Two refusals arrive under a field name that is not a field
 *
 * This is the one genuinely surprising thing about failing on this endpoint, and it is why
 * `FORM_FIELDS` earns its place twice over.
 *
 * `timetables` carries its two cross-column rules as **model-level** validators — `timeOrdered` and
 * `teachingSlotNeedsSubject` in the model's `validate` block — and Sequelize reports a model-level
 * validator under the *validator's own name*: `instance-validator.js` sets `errorKey = validatorType`
 * whenever the validator is not attached to an attribute. `timetable.service.js`'s `rethrow()` then
 * maps `e.path` straight onto `field`, so the two likeliest mistakes on this screen —
 *
 *   * an end time at or before the start time → `field: "timeOrdered"`
 *   * a teaching period with no subject      → `field: "teachingSlotNeedsSubject"`
 *
 * — reach the client naming inputs that do not exist. Left alone they would be filed by
 * `fieldErrors()` under keys nothing renders, and the resulting non-empty map would suppress the
 * banner too, so a rejected submit would look like it had done nothing at all. They are promoted to
 * the top instead, alongside `school_id` and the `body` field that `rethrow()` uses for a broken
 * foreign key. These are whole-object rules in everything but where Joi put them.
 *
 * ## The three conflicts are 409s that speak for themselves
 *
 * FR-TT-002 is implemented as *prevented*, not flagged: a clash on period, teacher or room is a 409
 * carrying `TIMETABLE_PERIOD_CONFLICT`, `TIMETABLE_TEACHER_CONFLICT` or `TIMETABLE_ROOM_CONFLICT`.
 * None is in `EXPLAINED_CODES` — they are not entitlement or permission refusals — so each falls
 * through to the banner as its own message, and the message names which of the three axes clashed,
 * which is the one thing the operator has to change. The colliding row travels in `details` as an
 * object `{ conflict, with }`. `ApiError` keeps that object as `context` (it used to drop it), and
 * the edit screen at `timetable/[id]` uses it to name and link the clashing entry; this screen still
 * shows the server's sentence alone.
 *
 * ## Five pickers, one of them fatal, one of them dependent
 *
 * Every foreign key is a select rather than an id box, and each list needs a grant that is **not**
 * the `timetable.manage` that opened this screen: `classes.view` for classes and their sections,
 * `subjects.view`, `sessions.view`, and `teachers.view` *plus* the Teachers module, which
 * `teachers.routes.js` mounts on itself. So any of them can fail for a caller perfectly entitled to
 * create an entry, and each says its own remedy.
 *
 * Only the class list is fatal, because `class_id` is the one required key among them. The other four
 * degrade to a sentence — except that losing the subject list also loses the ability to record a
 * teaching period at all, since the model demands a subject, so that one says so rather than shrugging.
 *
 * Sections are the dependent select: they hang off `GET /classes/:id/sections`, which is unpaginated
 * and returns `{ sections }` rather than a page. The selection is cleared whenever the class changes,
 * because `loadSectionOfClass(section_id, class_id)` refuses a section of a different class — a
 * carried-over choice is a guaranteed 422 the operator cannot see coming, the dropdown having already
 * been repopulated underneath it.
 *
 * None of the five lists is narrowed. `assertReferences()` checks only that each row belongs to the
 * same school — not that the subject is assigned to the class, not that the teacher teaches it, not
 * that the session is current — so filtering here would be this screen inventing rules the module does
 * not have. Retired rows are marked in the option text rather than withheld, for the same reason.
 *
 * Nor is any of them cut at one page any more. `useTimetablePickers` reads a single page of
 * `OPTION_LIMIT`, and at a school with 140 teachers the forty sorting last could not be assigned to
 * a period at all — the form said "Showing the first 100 of 140" and offered no way through. A search
 * box would reach the teachers (`teachers.service.js` LIKEs `q`) but not the subjects, classes or
 * sessions, whose `list()` ignores `q`; so `useWholeList` (`lib/useTimetablePickers.ts`) reads the
 * remaining pages instead, which works for all four.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import {
  Field,
  Notice,
  SelectField,
  SubmitButton,
  focusFirstInvalidField,
  FormActions,
  FormSection,
} from '@/components/form';
import { useToast } from '@/components/toast';
import { PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import {
  useTimetablePickers,
  useWholeList,
  teacherName,
  dayLabel,
  sessionNames,
} from '@/lib/useTimetablePickers';

/**
 * The seven values of `WEEKDAYS` in `config/constants.js`, in the order the ENUM declares them.
 *
 * Copied rather than imported — the frontend is a separate package — and the order is load-bearing
 * the same way it is on the list screen: `day_of_week` is a MySQL ENUM and MySQL sorts an ENUM by
 * declaration order, which is what makes the register read as a week. A dropdown that offered the
 * days alphabetically would disagree with every screen that shows them back.
 */
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/**
 * The inputs this form actually renders.
 *
 * Anything else the API names in a 422 is promoted to the banner rather than filed under a key
 * nothing draws: `school_id` from `resolveSchool()`, `body` from `rethrow()`'s foreign-key branch,
 * and above all `timeOrdered` and `teachingSlotNeedsSubject`. See the header.
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

/*
 * The five option types, the `Picker<T>` state, `NO_SECTIONS`, `teacherName`, `dayLabel` and
 * `useWholeList` all live in `lib/useTimetablePickers.ts`, with the loading they describe. The edit
 * screen at `timetable/[id]` needs the same five lists and the same four failure states, and a second
 * copy is where two screens quietly stop agreeing about what a picker does.
 */

export default function NewTimetableEntryPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

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

  /* The five lists, their four failure states and the section-follows-class rule — and the four
     paginated ones read past their first page. Sections are one unpaginated call and need nothing. */
  const pickers = useTimetablePickers(values.class_id, can('timetable.manage'));
  const { sections } = pickers;
  const classes = useWholeList('/classes', pickers.classes);
  const subjects = useWholeList('/subjects', pickers.subjects);
  const teachers = useWholeList('/teachers', pickers.teachers);
  const sessions = useWholeList('/sessions', pickers.sessions);
  /* Each class option names its session — "Grade 5" exists once a year. See `sessionNames`. */
  const classSessions = sessionNames(sessions);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  /* Both loading effects moved into `useTimetablePickers`; see the note above the imports. */

  function onClassChange(event: { target: { value: string } }) {
    /* The section goes with the class. See the header: keeping it is a 422 nobody can see coming. */
    setValues((prev) => ({ ...prev, class_id: event.target.value, section_id: '' }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    /*
     * Only what was filled in — the exemplar's rule, and it matters most on the required five: an
     * omitted `period_number` is answered '"period_number" is required', where `""` is answered "must
     * be a number", and only the first names the actual problem.
     *
     * `period_number` goes over the wire as the text that was typed. `validate()` runs Joi with
     * `convert: true`, so `"3"` arrives as `3`; coercing here with `Number()` would turn a mistyped
     * value into `NaN`, which `JSON.stringify` writes as `null` — and the 422 would then complain
     * about a value nobody entered.
     */
    const body: Record<string, unknown> = {};
    const put = (key: string, text: string) => {
      const trimmed = text.trim();
      if (trimmed) body[key] = trimmed;
    };

    put('class_id', values.class_id);
    put('section_id', values.section_id);
    put('day_of_week', values.day_of_week);
    put('period_number', values.period_number);
    put('start_time', values.start_time);
    put('end_time', values.end_time);
    put('subject_id', values.subject_id);
    put('teacher_id', values.teacher_id);
    put('academic_session_id', values.academic_session_id);
    put('period_label', values.period_label);
    put('room', values.room);
    put('reason', values.reason);

    /* The two sent as real booleans: JSON can carry one, so there is nothing to make the server coerce. */
    if (values.is_break) body.is_break = values.is_break === 'true';
    if (values.is_active) body.is_active = values.is_active === 'true';

    try {
      await api.post('/timetable', body);
      /* `replace`, not `push` — the exemplar's reason: Back would re-open a form already answered. */
      success('Timetable entry created');
      router.replace('/school/timetable');
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError) {
        const perField = caught.fieldErrors();

        /* Whole-object rules, plus the model validators and `school_id`. See the header. */
        const unplaced = caught.formErrors();
        for (const [field, message] of Object.entries(perField)) {
          if (!FORM_FIELDS.has(field)) {
            unplaced.push(message);
            delete perField[field];
          }
        }

        setFieldErrors(perField);
        focusFirstInvalidField();
        setError(
          unplaced.length
            ? unplaced.join(' ')
            : Object.keys(perField).length
              ? null
              : caught.message
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      setSaving(false);
    }
  }

  /*
   * Gated exactly as the list screen's "Add entry" button is.
   *
   * `timetable.manage` and nothing else is restated here. `timetable.routes.js` also mounts
   * `requireModule(MODULES.TIMETABLE)` at router level, but that is the API's to decide and its
   * refusal already lands in `EXPLAINED_CODES` — a second, client-side copy of the entitlement rule
   * would either hide a screen the plan covers or promise one it does not. There is no
   * `enforceLimit` on this route: §11.2's limits contain nothing timetable-shaped.
   */
  if (!can('timetable.manage')) {
    return (
      <div>
        <PageHeader title="New timetable entry" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to create a timetable entry.',
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New timetable entry"
        description="One period slot. A class, a day, a period number and the two clock times are required."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The slot"
          description="Which class, on which day, in which period."
        >
          {classes.state === 'failed' ? (
            /*
             * No select and no number box. The id is the only thing a fallback input could take, and
             * `classes.id` is not a number anyone in a school office has ever been shown.
             *
             * And no `SelectField`, so no `<label>` either: the component draws a label for a control
             * and this branch has none. The heading borrows `.field-label` so it still reads as the
             * field it stands in for, without an `htmlFor` naming an element that was never rendered.
             */
            <div>
              <p className="field-label mb-1.5">Class</p>
              <p className="text-sm text-danger">
                The class list could not be loaded, so the class cannot be chosen here — and an entry
                cannot be created without one. Reading it needs the separate &ldquo;View
                classes&rdquo; permission.
              </p>
            </div>
          ) : (
            <SelectField
              id="class_id"
              label="Class"
              required
              disabled={classes.state === 'loading'}
              value={values.class_id}
              onChange={onClassChange}
              error={fieldErrors.class_id}
              hint={
                classes.state === 'ready' && classes.rows.length === 0
                  ? 'This school has no classes yet. One has to exist before a period can be scheduled against it.'
                  : `In promotion order.${
                      classSessions.size > 0
                        ? ' Each names its session, so two classes of the same name from consecutive years can be told apart.'
                        : ''
                    }${
                      classes.state === 'ready' && classes.total > classes.rows.length
                        ? ` Showing the first ${classes.rows.length} of ${classes.total}.`
                        : ''
                    }`
              }
            >
              <option value="">
                {classes.state === 'loading' ? 'Loading…' : 'Choose a class'}
              </option>
              {classes.state === 'ready'
                ? classes.rows.map((option) => {
                    const session =
                      option.academic_session_id === null
                        ? undefined
                        : classSessions.get(option.academic_session_id);
                    return (
                      /* Retired classes are marked, not withheld — `loadClassInSchool()` checks the
                         school and nothing else, so excluding them would be a rule of our own. */
                      <option key={option.id} value={option.id}>
                        {option.name}
                        {option.code ? ` (${option.code})` : ''}
                        {session ? ` · ${session}` : ''}
                        {option.is_active ? '' : ' · inactive'}
                      </option>
                    );
                  })
                : null}
            </SelectField>
          )}

          {sections.state === 'failed' ? (
            /* No control in this branch, so the heading stands in for the label the component draws. */
            <div>
              <p className="field-label mb-1.5">Section</p>
              <p className="text-sm text-muted">
                This class&rsquo;s sections could not be loaded, so the entry can only be made for the
                whole class. That is a valid entry, not a fallback.
              </p>
            </div>
          ) : (
            <SelectField
              id="section_id"
              label="Section"
              disabled={!values.class_id || sections.state === 'loading'}
              value={values.section_id}
              onChange={set('section_id')}
              error={fieldErrors.section_id}
              /* The <em> that used to sit around "every" went with the hand-rolled <p>: `hint` is a
                 string, not a node. The sentence still turns on that word. */
              hint={
                values.class_id && sections.state === 'ready' && sections.rows.length === 0
                  ? 'This class has no sections, so the entry is for the whole class.'
                  : 'Leaving this as the whole class is a meaning, not a blank: the service reads a section-less entry as every section sitting this period, so it clashes both with a second whole-class entry and with any single section’s entry in the same slot.'
              }
            >
              <option value="">
                {!values.class_id
                  ? 'Choose a class first'
                  : sections.state === 'loading'
                    ? 'Loading…'
                    : 'The whole class'}
              </option>
              {sections.state === 'ready'
                ? sections.rows.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                      {option.is_active ? '' : ' · inactive'}
                    </option>
                  ))
                : null}
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
            {WEEKDAYS.map((day) => (
              <option key={day} value={day}>
                {dayLabel(day)}
              </option>
            ))}
          </SelectField>

          <Field
            id="period_number"
            label="Period number"
            type="number"
            required
            min={1}
            max={50}
            step={1}
            value={values.period_number}
            onChange={set('period_number')}
            error={fieldErrors.period_number}
            /* All three of FR-TT-002's conflict indexes key on this number and none keys on the clock,
               which is what makes it the field that decides whether two entries collide. */
            hint="Whole number from 1 to 50. This is the slot the conflict checks use — not the clock times — so two entries sharing a period number clash even if their times differ."
          />

          {/*
            * `<input type="time">` for both, because the HTML value is always 24-hour `HH:MM` whatever
            * clock the browser displays — which is exactly `timeField`'s pattern, two-digit hour and
            * all. That pattern exists because MySQL's `TIME` is a *duration* type and would otherwise
            * accept `24:00`; a native time control cannot produce one. The seconds the server stores
            * are its own: `normaliseTime()` writes `HH:MM:SS` so the create response and the stored row
            * agree.
            */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="start_time"
              label="Start time"
              type="time"
              required
              value={values.start_time}
              onChange={set('start_time')}
              error={fieldErrors.start_time}
            />
            <Field
              id="end_time"
              label="End time"
              type="time"
              required
              value={values.end_time}
              onChange={set('end_time')}
              error={fieldErrors.end_time}
              hint="Must be later than the start time."
            />
          </div>
        </FormSection>

        <FormSection
          title="What happens in it"
          description="The subject and the teacher taking it. A break period needs neither."
        >
          {subjects.state === 'failed' ? (
            /*
             * Stated as the blocker it is rather than as an optional field gone missing. A row that
             * is not a break must name a subject, so without this list the only entry that can still
             * be created is a break.
             *
             * As with the class list: no control in this branch, so the heading stands in for the
             * label a `SelectField` would have drawn.
             */
            <div>
              <p className="field-label mb-1.5">Subject</p>
              <p className="text-sm text-danger">
                The subject list could not be loaded, so only a break can be recorded here — a teaching
                period must name a subject. Reading it needs the separate &ldquo;View
                subjects&rdquo; permission.
              </p>
            </div>
          ) : (
            <SelectField
              id="subject_id"
              label="Subject"
              disabled={subjects.state === 'loading'}
              value={values.subject_id}
              onChange={set('subject_id')}
              error={fieldErrors.subject_id}
              /* "not starred" described the hand-rolled label. `SelectField` writes the word
                 `required` rather than an asterisk, so the hint names what the label does not say. */
              hint={`Required unless this period is a break — that is the model’s rule rather than the form’s, which is why the label does not say required. Every subject of the school is offered: nothing requires it to be one the class already studies.${
                subjects.state === 'ready' && subjects.total > subjects.rows.length
                  ? ` Showing the first ${subjects.rows.length} of ${subjects.total} by name.`
                  : ''
              }`}
            >
              <option value="">
                {subjects.state === 'loading' ? 'Loading…' : 'None (break only)'}
              </option>
              {subjects.state === 'ready'
                ? subjects.rows.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name} ({option.code})
                      {option.is_active ? '' : ' · inactive'}
                    </option>
                  ))
                : null}
            </SelectField>
          )}

          {teachers.state === 'failed' ? (
            /* Neither of the first two branches draws a control, so each carries its own heading. */
            <div>
              <p className="field-label mb-1.5">Teacher</p>
              <p className="text-sm text-muted">
                The teacher list could not be loaded, so nobody can be assigned here. Reading it needs
                the &ldquo;View teachers&rdquo; permission and a plan that carries the Teachers module.
                The entry can be created without one.
              </p>
            </div>
          ) : teachers.state === 'ready' && teachers.rows.length === 0 ? (
            <div>
              <p className="field-label mb-1.5">Teacher</p>
              <p className="text-sm text-muted">
                No teachers have been added to this school yet, so there is nobody to assign.
              </p>
            </div>
          ) : (
            <SelectField
              id="teacher_id"
              label="Teacher"
              disabled={teachers.state === 'loading'}
              value={values.teacher_id}
              onChange={set('teacher_id')}
              error={fieldErrors.teacher_id}
              hint={`Naming one brings this slot into that teacher’s own timetable — and into the double-booking check, which a nameless period never triggers.${
                teachers.state === 'ready' && teachers.total > teachers.rows.length
                  ? ` Showing the first ${teachers.rows.length} of ${teachers.total} by first name.`
                  : ''
              }`}
            >
              <option value="">
                {teachers.state === 'loading' ? 'Loading…' : 'Nobody yet'}
              </option>
              {teachers.state === 'ready'
                ? teachers.rows.map((option) => (
                    <option key={option.id} value={option.id}>
                      {teacherName(option)} ({option.employee_id})
                      {option.is_active ? '' : ' · inactive'}
                    </option>
                  ))
                : null}
            </SelectField>
          )}

          {sessions.state === 'failed' ? (
            /* No control in this branch, so the heading stands in for the label. */
            <div>
              <p className="field-label mb-1.5">Academic session</p>
              <p className="text-sm text-muted">
                The academic session list could not be loaded, so the entry cannot be tagged with one.
                Reading it needs the &ldquo;View academic sessions&rdquo; permission. The entry can be
                created without one.
              </p>
            </div>
          ) : (
            <SelectField
              id="academic_session_id"
              label="Academic session"
              disabled={sessions.state === 'loading'}
              value={values.academic_session_id}
              onChange={set('academic_session_id')}
              error={fieldErrors.academic_session_id}
              hint={`A label for filtering, and no more: the conflict checks ignore it, so tagging next year’s entries with next year’s session does not give them a grid of their own. A section’s week is one living plan.${
                sessions.state === 'ready' && sessions.total > sessions.rows.length
                  ? ` Showing the first ${sessions.rows.length} of ${sessions.total}, newest first.`
                  : ''
              }`}
            >
              <option value="">
                {sessions.state === 'loading' ? 'Loading…' : 'Not tagged to a session'}
              </option>
              {sessions.state === 'ready'
                ? sessions.rows.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name} · {option.status}
                      {option.is_current ? ' · current' : ''}
                    </option>
                  ))
                : null}
            </SelectField>
          )}
        </FormSection>

        <FormSection
          title="Details"
          description="Naming and location, and whether the slot is a break rather than a lesson."
        >
          <Field
            id="period_label"
            label="Period label"
            maxLength={60}
            value={values.period_label}
            onChange={set('period_label')}
            error={fieldErrors.period_label}
            hint="Up to 60 characters — the school's own name for this slot, e.g. Assembly. Searchable on the timetable list."
          />

          <Field
            id="room"
            label="Room"
            maxLength={60}
            value={values.room}
            onChange={set('room')}
            error={fieldErrors.room}
            /* Trimmed and emptied to null by `normaliseRoom()`; matched case-insensitively because the
               column's collation is, not because anything here lower-cases it. */
            hint="Up to 60 characters. A named room is checked for double-booking in this slot; leaving it blank books no room at all."
          />

          <SelectField
            id="is_break"
            label="Kind of period"
            value={values.is_break}
            onChange={set('is_break')}
            error={fieldErrors.is_break}
            hint="A break occupies its slot without a subject or a teacher — which is why it still blocks a lesson in the same period, and why it is the one kind of entry that may leave the subject empty."
          >
            {/* Blank is the column's own default rather than this screen naming one. */}
            <option value="">Server default (teaching period)</option>
            <option value="false">Teaching period</option>
            <option value="true">Break</option>
          </SelectField>

          <SelectField
            id="is_active"
            label="Status"
            value={values.is_active}
            onChange={set('is_active')}
            error={fieldErrors.is_active}
            /* The <strong> around "not" went with the hand-rolled <p>: `hint` is a string, not a node.
               The word is left where the emphasis was, because the sentence turns on it. */
            hint="Inactive retires an entry without deleting it — there is no delete — but it does not free the slot: the unique index counts retired rows too, so the period stays claimed until this entry is edited."
          >
            <option value="">Server default (active)</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </SelectField>
        </FormSection>

        <FormSection
          title="Internal notes"
          description="Kept on the audit entry for this slot."
        >
          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            hint="Up to 255 characters. Not stored on the entry — it is the note on this entry's audit record."
          />
        </FormSection>

        <FormActions cancelHref="/school/timetable">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create entry
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
