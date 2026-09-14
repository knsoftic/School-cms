'use client';

/**
 * Schedule an examination — SRS §19.1, FR-EXAM-001, Known Issue 30.
 *
 * Follows `super-admin/organizations/new/page.tsx`, which is where the shared decisions are argued.
 * Only what is specific to an exam is written down here.
 *
 * ## The field set is the create schema's
 *
 * `exams.validation.js` `createExam` takes `name`, `exam_type`, `class_id`, `section_id`,
 * `academic_session_id`, `start_date`, `end_date`, `grade_scale`, `description` and `reason`, and
 * marks exactly three `.required()`: **`name`**, **`exam_type`** and **`class_id`**. The first nine
 * are also `exams.service.js`'s `EXAM_EDITABLE`, so every one of them reaches a column; `reason` is
 * the note on the audit entry rather than a column, as it is everywhere else in this codebase.
 *
 * Seven columns are `forbidden()` rather than merely absent, and so have no control here:
 * `status`, `published_at`, `announced_at`, `created_by`, `id`, `organization_id` and
 * `result_card_path`. `status` is the one worth naming — the exams list offers a seven-way status
 * filter, which makes it look settable, and it is not: an exam is born `draft` (the model default)
 * and moves only through the lifecycle routes. A control for it would be a control whose only
 * outcome is a 422 saying so.
 *
 * `school_id` is accepted by the schema and is still not sent, for the reason the list screen gives:
 * `resolveSchool()` confines a school-scoped caller to the one school on their session, so the field
 * could only ever restate what the server already decided.
 *
 * The route carries `requireModule(MODULES.EXAMS)`, which is not pre-checked here — `§30 Rule 1`
 * puts entitlement with the API, and `MODULE_NOT_SUBSCRIBED` is in `EXPLAINED_CODES`, so a school
 * whose plan excludes §19 gets the same explanation the list screen gives it.
 *
 * ## The class picker carries its own sections, so there is no second request
 *
 * `classes.service.list()` includes `{ model: db.Section, as: 'sections' }`, so one `GET /classes`
 * answers both selects and the section list narrows from data already in hand. The obvious
 * alternative, `GET /classes/{id}/sections`, was not used for two reasons: it is a request that has
 * already been answered, and its payload is `ApiResponse.ok(res, { sections: rows })` — an **object**,
 * not the bare array every other collection in this client returns. `classes/sections/page.tsx` reads
 * it with `api.get<{ sections }>` and unwraps it itself, which is one more shape to get right for a
 * list this form already has in hand.
 *
 * The section is cleared whenever the class changes. `loadSectionOfClass()` requires the section to
 * belong to the class it is sent with, so a selection carried over from the previous class is a
 * guaranteed 422 — and one the user cannot see coming, because the dropdown that held it has already
 * been repopulated.
 *
 * ## What is deliberately *not* narrowed
 *
 * A class belongs to an academic session, so it is tempting to filter the class list by the session
 * chosen above it. `assertExamReferences()` checks the two independently — the class must be of this
 * school, the session must be of this school, and nothing requires them to agree — so narrowing would
 * hide classes the API would have accepted. Each class option instead names its own session, which
 * is what makes two identically-named classes from consecutive years tellable apart.
 *
 * Inactive classes and sections are annotated, never withheld: `loadClassInSchool()` and
 * `loadSectionOfClass()` do not test `is_active`, and a picker that dropped them would be enforcing
 * a rule the module does not have.
 *
 * ## A closed session takes no new exam — the owner's decision D20
 *
 * `createExam()` calls `assertOpenForNew()` on the session named **and** on the class's own session,
 * and refuses either when it is closed: 409 `SESSION_CLOSED`, naming the session. So a closed session
 * is not offered in the session list, and a class of a closed session stays listed — it is still the
 * school's class, and hiding it would read as "deleted" — but is disabled and says why. Both rest on
 * the session list; a caller who cannot read it gets the API's refusal, which is put under the field
 * it is about rather than in a banner: under the session when it is the one named, and under the
 * class otherwise, since then it was the class's own session that was closed.
 *
 * ## Three optional fields where blank has a specific meaning
 *
 *   * **Section** blank is NULL, which the column comment defines as *"all sections of the class sit
 *     the exam"* — a real answer, not an omission, which is why the empty option says it.
 *   * **Academic session** starts on the current one — D20's "forms default to the current session",
 *     read from the profile (`school.current_session` on `/auth/me`) rather than from
 *     `GET /sessions/current`, which needs the list's `sessions.view`. `createExam` does **not** fall
 *     back to it itself, so the default is this form's, and it is a default, not a lock: choosing
 *     "Not tied to a session" still posts NULL. A school with no current session starts blank. A
 *     caller who cannot read the session list is offered the current session alone.
 *   * **Grade scale** blank stores the column default, the literal string `default`. This is the one
 *     that can bite: `grade_scale` is a `STRING(90)` matching `grades.scale_name` and **not** a
 *     foreign key, and `assertExamReferences()` only checks a scale that was actually sent. So a
 *     blank field is the one way to attach an exam to a scale with no bands — every percentage
 *     calculates and none of them matches a grade. The hint says so, and the options are the distinct
 *     scale names that currently have at least one active band.
 *
 * ## Dates are posted exactly as typed, which is safe here and was not on the coupon screen
 *
 * `start_date` and `end_date` are `DATEONLY`. `<input type="date">` yields `2026-03-01`, Joi reads
 * that as midnight UTC, and `dates.toDateOnly()` is `toISOString().slice(0, 10)` — so the characters
 * that were typed are the characters that are stored. The `datetime-local` conversion the coupon
 * screen needs has no counterpart here; adding one would introduce the zone shift it exists to avoid.
 *
 * ## The refusal that has no input to land on
 *
 * `end_date` before `start_date` is not a Joi rule — `createExam` bounds each date separately and
 * never compares them. It is caught by a **model-level** validator, `endNotBeforeStart` in
 * `models/exams.js`, and Sequelize keys a model-level failure by the validator's own name:
 * `_invokeCustomValidator` sets `errorKey = validatorType` when no attribute is defined
 * (`instance-validator.js:135`). `exams.service.rethrow()` maps that to
 * `{ field: 'endNotBeforeStart', message: 'Exam end_date cannot be before start_date' }`.
 *
 * The exemplar's `Object.keys(perField).length ? null : caught.message` would therefore count one
 * field error, suppress the banner, and render the message under an input that does not exist — the
 * form would simply go quiet on the most likely mistake on the page. So a detail whose field is not
 * one of this form's own is promoted to the top-level `Notice` instead. That also covers the empty
 * `field: ''` a `.custom()` on a whole object produces, though this module has none.
 *
 * The module's conflicts (`DUPLICATE_RECORD` and friends) pass `details: {}` — an object. No guard is
 * needed for that: `ApiError` normalises a non-array `details` to `[]`, so `fieldErrors()` returns
 * nothing and the conflict's own message reaches the banner.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import type { PageMeta } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import {
  Field,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
  FormActions,
  FormSection,
  FormSpan,
} from '@/components/form';
import { useToast } from '@/components/toast';
import { PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/** `PAGINATION.MAX_LIMIT` — the most `commonSchemas.pagination` accepts in one page. */
const OPTION_LIMIT = 100;

/** A section as `/classes` nests it. Only the three columns the picker reads are declared. */
interface SectionOption {
  id: number;
  name: string;
  is_active: boolean;
}

interface ClassOption {
  id: number;
  name: string;
  code: string | null;
  /** Nullable on the column even though `classes.create` requires it — `SET NULL` on session delete. */
  academic_session_id: number | null;
  is_active: boolean;
  sections?: SectionOption[] | null;
}

interface SessionOption {
  id: number;
  name: string;
  status: string;
  is_current: boolean;
}

/**
 * One row of `GET /exams/grade-scales`, which lists **bands**, not scales.
 *
 * `scale_name` is what groups them, so the picker below is the distinct set of names rather than the
 * rows themselves; nothing else on a band is of use when choosing one.
 */
interface GradeBand {
  scale_name: string;
}

/** One option list: what came back, how many exist, and whether the call failed outright. */
interface Loaded<T> {
  rows: T[];
  total: number;
  failed: boolean;
}

const NOT_LOADED = { rows: [], total: 0, failed: false };

function settle<T>(result: PromiseSettledResult<{ data: T[]; meta: PageMeta | null }>): Loaded<T> {
  if (result.status !== 'fulfilled') return { rows: [], total: 0, failed: true };
  const rows = result.value.data ?? [];
  return { rows, total: result.value.meta?.total ?? rows.length, failed: false };
}

/**
 * The form's own field names, and the whole of the create schema's settable surface.
 *
 * Doubles as the test for "does this 422 belong to an input on this page" — see the header on
 * `endNotBeforeStart`.
 */
const EMPTY_VALUES = {
  name: '',
  exam_type: '',
  class_id: '',
  section_id: '',
  academic_session_id: '',
  start_date: '',
  end_date: '',
  grade_scale: '',
  description: '',
  reason: '',
};

const FORM_FIELDS = new Set(Object.keys(EMPTY_VALUES));

/** `ACADEMIC_SESSION_STATUS.CLOSED` — the one status D20 refuses a new exam in. */
const CLOSED = 'closed';

export default function NewExamPage() {
  const router = useRouter();
  const { can, profile } = useAuth();
  const { success } = useToast();

  /* D20's default, from the profile — see the header. */
  const current = profile?.school?.current_session ?? null;
  const currentId = current && current.status !== CLOSED ? String(current.id) : '';

  const [values, setValues] = useState(EMPTY_VALUES);

  /*
   * Only into an empty field, and only when the current session itself changes, so "Not tied to a
   * session", once chosen, stays chosen.
   */
  useEffect(() => {
    if (!currentId) return;
    setValues((prev) => (prev.academic_session_id ? prev : { ...prev, academic_session_id: currentId }));
  }, [currentId]);

  const [classes, setClasses] = useState<Loaded<ClassOption>>(NOT_LOADED);
  const [sessions, setSessions] = useState<Loaded<SessionOption>>(NOT_LOADED);
  const [bands, setBands] = useState<Loaded<GradeBand>>(NOT_LOADED);
  const [loadingOptions, setLoadingOptions] = useState(true);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  /*
   * `allSettled`, not `all`. The three lists need `classes.view`, `sessions.view` and `exams.view`,
   * all of them separate grants from the `exams.manage` that opened this screen. `Promise.all` would
   * let one missing permission empty the other two dropdowns, and each of the three has its own
   * remedy — so each reports its own failure below and the form still works without the optional ones.
   *
   * No `school_id` on any of them, for the reason the header gives.
   */
  useEffect(() => {
    /* The permission gate is a `return` after the hooks, so without this the lists would be fetched
       for a caller who is about to be told no. `can` is memoized on the profile in `AuthProvider`. */
    if (!can('exams.manage')) {
      setLoadingOptions(false);
      return;
    }

    let live = true;

    (async () => {
      const [classResult, sessionResult, bandResult] = await Promise.allSettled([
        api.page<ClassOption[]>('/classes', { query: { limit: OPTION_LIMIT } }),
        api.page<SessionOption[]>('/sessions', { query: { limit: OPTION_LIMIT } }),
        /* Active bands only: `assertExamReferences()` refuses a scale whose bands are all retired,
           so an inactive-only scale in this list would be an option the API will not accept. */
        api.page<GradeBand[]>('/exams/grade-scales', {
          query: { limit: OPTION_LIMIT, is_active: true },
        }),
      ]);
      if (!live) return;

      setClasses(settle(classResult));
      setSessions(settle(sessionResult));
      setBands(settle(bandResult));
      setLoadingOptions(false);
    })();

    return () => {
      live = false;
    };
  }, [can]);

  /*
   * The sessions the select offers: the list, with the current session added when it fell past the
   * first page — it is the default, so it has to be an option — or the current session alone for a
   * caller who cannot read the list.
   */
  const sessionOptions = useMemo<SessionOption[]>(() => {
    const own = current ? { ...current, is_current: true } : null;
    if (sessions.failed) return own ? [own] : [];
    return own && !sessions.rows.some((row) => row.id === own.id) ? [own, ...sessions.rows] : sessions.rows;
  }, [sessions, current]);

  /** Session names by id, for the label that tells two same-named classes apart. */
  const sessionNames = useMemo(() => {
    const byId = new Map<number, string>();
    for (const session of sessionOptions) byId.set(session.id, session.name);
    return byId;
  }, [sessionOptions]);

  /** The sessions D20 refuses a new exam in — see the header. Empty when the list could not be read. */
  const closedSessions = useMemo(
    () => new Set(sessionOptions.filter((session) => session.status === CLOSED).map((session) => session.id)),
    [sessionOptions]
  );
  const inClosedSession = (row: ClassOption) =>
    row.academic_session_id !== null && closedSessions.has(row.academic_session_id);

  const sections = useMemo(() => {
    const chosen = classes.rows.find((row) => String(row.id) === values.class_id);
    return chosen?.sections ?? [];
  }, [classes.rows, values.class_id]);

  const scaleNames = useMemo(
    () => Array.from(new Set(bands.rows.map((band) => band.scale_name))).sort((a, b) => a.localeCompare(b)),
    [bands.rows]
  );

  function onClassChange(event: { target: { value: string } }) {
    setValues((prev) => ({ ...prev, class_id: event.target.value, section_id: '' }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    /*
     * Only what was filled in, and every value as the string it was typed as. `validate()` runs Joi
     * with `convert: true`, so `"7"` arrives as `7` and `"2026-03-01"` as a date; coercing here would
     * turn a stray character into `NaN`, which `JSON.stringify` writes as `null` — and `section_id`
     * and `academic_session_id` both accept `null` as a *meaning*, so a typo would save silently as
     * "all sections" rather than being refused.
     */
    const body: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      const trimmed = value.trim();
      if (trimmed) body[key] = trimmed;
    }

    try {
      await api.post('/exams', body);
      /* `replace`, not `push`: Back would otherwise re-open an empty form for an exam that exists. */
      success('Exam created', 'Add its subjects before marks can be entered.');
      router.replace('/school/exams');
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError && caught.code === 'SESSION_CLOSED') {
        /*
         * D20, under the field it is about — see the header. The refusal names the closed session;
         * when that is not the one chosen here, it was the class's own.
         */
        const named = caught.context?.academic_session_id;
        const onSession = values.academic_session_id !== '' && String(named) === values.academic_session_id;
        setFieldErrors(
          onSession
            ? { academic_session_id: caught.message }
            : { class_id: `${caught.message}. This class is in that session; choose a class of an open one.` }
        );
        focusFirstInvalidField();
      } else if (caught instanceof ApiError) {
        const perField: Record<string, string> = {};
        let rootMessage: string | null = null;

        for (const [field, message] of Object.entries(caught.fieldErrors())) {
          /* A field this form does not have goes to the banner rather than nowhere. See the header. */
          if (FORM_FIELDS.has(field)) perField[field] = message;
          else rootMessage = message;
        }

        setFieldErrors(perField);
        focusFirstInvalidField();
        /* Whole-object rules have no field at all; `formErrors()` is where they arrive. */
        const formLevel = caught.formErrors();
        setError(
          formLevel.length
            ? formLevel.join(' ')
            : rootMessage ?? (Object.keys(perField).length ? null : caught.message)
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      setSaving(false);
    }
  }

  /*
   * Gated exactly as the list screen's "Add exam" button is. `exams.routes.js` requires
   * `exams.manage` on `POST /exams`, and the seeded catalogue withholds it from `teacher` — a teacher
   * may enter and submit marks for an exam but not create one, which `exams.routes.js` records as a
   * deliberate reading of FR-EXAM-001's actor list rather than an oversight.
   */
  if (!can('exams.manage')) {
    return (
      <div>
        <PageHeader title="New exam" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to create an exam.',
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New exam"
        description="A name, a type and a class are required. The exam starts as a draft; subjects, marks and results come afterwards."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {classes.failed ? (
        <Notice tone="error">
          The class list could not be loaded, so the class cannot be chosen here. Viewing classes is a
          separate permission from creating exams.
        </Notice>
      ) : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The exam"
          description="What it is called and what kind of assessment it is."
        >
          <Field
            id="name"
            width="md"
            label="Name"
            required
            maxLength={160}
            value={values.name}
            onChange={set('name')}
            error={fieldErrors.name}
            hint="Up to 160 characters. Searched alongside the type on the exams list."
          />

          <Field
            id="exam_type"
            label="Type"
            required
            maxLength={90}
            value={values.exam_type}
            onChange={set('exam_type')}
            error={fieldErrors.exam_type}
            /* No select, and no invented vocabulary: the column's comment is *"e.g. Midterm, Final"*
               and SRS §19.1 names Exam Type without closing the value list. */
            hint="Free text, up to 90 characters — the source names this field but lists no fixed values. The column's own examples are Midterm and Final."
          />
        </FormSection>

        <FormSection
          title="Who sits it"
          description="The class, section and session the exam belongs to."
        >
          <SelectField
            id="class_id"
            label="Class"
            required
            value={values.class_id}
            onChange={onClassChange}
            disabled={loadingOptions || classes.failed}
            error={fieldErrors.class_id}
            /* Neither branch is a caveat about the control — the first says an exam cannot be created
               at all yet, the second that the option you want may be missing from a truncated page. */
            hint={
              !loadingOptions && !classes.failed && classes.rows.length === 0
                ? 'This school has no classes yet, and an exam has to belong to one. Create a class first.'
                : [
                    classes.total > classes.rows.length
                      ? `The first ${classes.rows.length} of ${classes.total} classes. A page cannot hold more.`
                      : null,
                    classes.rows.some(inClosedSession)
                      ? 'A class of a closed session is shown and cannot be chosen: a closed session takes no new exam.'
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined
            }
          >
            <option value="">{loadingOptions ? 'Loading…' : 'Choose a class'}</option>
            {classes.rows.map((row) => {
              const session = row.academic_session_id ? sessionNames.get(row.academic_session_id) : undefined;
              const closed = inClosedSession(row);
              return (
                <option key={row.id} value={row.id} disabled={closed}>
                  {row.name}
                  {row.code ? ` (${row.code})` : ''}
                  {session ? ` — ${session}` : ''}
                  {closed ? ' (closed)' : ''}
                  {row.is_active ? '' : ' — inactive'}
                </option>
              );
            })}
          </SelectField>

          <SelectField
            id="section_id"
            width="md"
            label="Section"
            value={values.section_id}
            onChange={set('section_id')}
            disabled={!values.class_id || sections.length === 0}
            error={fieldErrors.section_id}
            hint="Naming a section confines the exam to it. Left blank, every section of the class sits it."
          >
            {/* The empty option is an answer, not an absence — see the header. */}
            <option value="">
              {!values.class_id
                ? 'Choose a class first'
                : sections.length === 0
                  ? 'This class has no sections'
                  : 'All sections of this class'}
            </option>
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.name}
                {section.is_active ? '' : ' — inactive'}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="academic_session_id"
            label="Academic session"
            value={values.academic_session_id}
            onChange={set('academic_session_id')}
            /* Without the list, still the current session — see the header. */
            disabled={loadingOptions || (sessions.failed && sessionOptions.length === 0)}
            error={fieldErrors.academic_session_id}
            hint={
              sessions.failed
                ? sessionOptions.length > 0
                  ? 'The session list could not be loaded, so only the current session is offered. Viewing sessions is a separate permission from creating exams. Left blank, the exam belongs to no session at all.'
                  : 'The session list could not be loaded, so the exam will not be tied to a session. Viewing sessions is a separate permission from creating exams.'
                : 'Starts on the current session. Closed sessions are not offered — a closed session takes no new exam. Left blank, the exam belongs to no session at all; the server does not fall back to the current one.'
            }
          >
            <option value="">Not tied to a session</option>
            {/* D20: a closed session is not offered for a new exam — see the header. */}
            {sessionOptions
              .filter((session) => session.status !== CLOSED)
              .map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name} — {session.status}
                  {session.is_current ? ' — current' : ''}
                </option>
              ))}
          </SelectField>
        </FormSection>

        <FormSection
          columns={2}
          title="When and how it is marked"
          description="The dates it runs between, and the scale results are graded on."
        >
          {/* Both are `DATEONLY`, and both round-trip as typed. See the header. */}
          <Field
            id="start_date"
            width="sm"
            label="Start date"
            type="date"
            value={values.start_date}
            onChange={set('start_date')}
            error={fieldErrors.start_date}
            hint="The first day of the exam period. Optional — a draft can be scheduled later."
          />

          <Field
            id="end_date"
            width="sm"
            label="End date"
            type="date"
            value={values.end_date}
            onChange={set('end_date')}
            error={fieldErrors.end_date}
            hint="The last day. Cannot be before the start date."
          />

          <FormSpan>
            <SelectField
              id="grade_scale"
              label="Grade scale"
              value={values.grade_scale}
              onChange={set('grade_scale')}
              disabled={loadingOptions || bands.failed}
              error={fieldErrors.grade_scale}
              /*
               * The consequence is spelled out because the API cannot warn about it: a scale that is
               * *chosen* is checked for active bands, and the unchosen default is not.
               */
              hint={
                bands.failed
                  ? 'The grade scales could not be loaded, so the exam will use the scale named “default”. Viewing exams is a separate permission from creating them.'
                  : `Scales that currently have at least one active band. A scale with no bands grades every percentage as blank, and the “default” fallback is not checked for one.${
                      bands.total > bands.rows.length
                        ? ` Read from the first ${bands.rows.length} of ${bands.total} bands, so a scale beyond that is not listed.`
                        : ''
                    }`
              }
            >
              <option value="">Server default (the scale named “default”)</option>
              {scaleNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </SelectField>
          </FormSpan>
        </FormSection>

        <FormSection
          title="Details"
          description="A description for staff, and why the exam was created."
        >
          <TextAreaField
            id="description"
            label="Description"
            rows={4}
            maxLength={5000}
            value={values.description}
            onChange={set('description')}
            error={fieldErrors.description}
            hint="Up to 5000 characters."
          />

          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            hint="Up to 255 characters. Kept as the note on this exam's created audit entry, not on the exam itself."
          />
        </FormSection>

        <FormActions cancelHref="/school/exams">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create exam
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
