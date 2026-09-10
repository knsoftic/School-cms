'use client';

/**
 * Set homework — SRS §20.2, FR-HW-001, Known Issue 30.
 *
 * Follows `super-admin/organizations/new/page.tsx`, which is where the shared decisions are argued,
 * and `school/exams/new/page.tsx`, which already worked out the class-and-section pair. Only what is
 * specific to homework is written down here.
 *
 * ## The field set is the create schema's
 *
 * `homework.validation.js` `create` takes `school_id`, `class_id`, `title`, `due_date`, `section_id`,
 * `subject_id`, `teacher_id`, `academic_session_id`, `description`, `assigned_date`, `is_published`
 * and `reason`, and marks exactly three `.required()`: **`class_id`**, **`title`** and **`due_date`**.
 * The schema says why each: the column is NOT NULL and §20.2's outcome is that the homework is
 * "available to the relevant class"; and setting a due date is one of the three things §20.2 names a
 * teacher doing. This form marks the same three.
 *
 * Six columns are `forbidden()` rather than merely absent, so none has a control: `id`,
 * `organization_id`, `created_by`, `notified_at` — the §23 notification job's stamp — and the
 * attachment pair. `attachment_path` and `attachment_name` are the ones worth naming, because this
 * screen does put a file on the wire: they are written from the uploaded file and refused from a body,
 * which is the doctrine `finance` and `fees` already enforce. The file input below is therefore the
 * only way to set them, and it sets both at once.
 *
 * `school_id` is accepted by the schema and is still not sent, for the reason the list screen gives:
 * `resolveSchool()` confines a school-scoped caller to the one school on their session, so the field
 * could only ever restate what the server already decided. The cost is one refusal with nowhere to
 * land — a platform caller reaching this URL directly is answered *"school_id is required when the
 * caller has no school in scope"*, a 422 naming a field this form does not have. See `FORM_FIELDS`.
 *
 * ## The whole request is `FormData`, file or no file
 *
 * `POST /homework` mounts `uploadSingle(UPLOAD_PROFILES.HOMEWORK, 'attachment')` **before**
 * `validate`, so the body the validator sees is whatever multer parsed and every field arrives as a
 * string — which is why the schema's own comment says `convert: true` is doing real work. Sending
 * multipart always, rather than JSON when no file was chosen, keeps one code path and one shape for
 * the server to read.
 *
 * It also buys nothing to do otherwise. `uploadSingle` is an unconditional chain of four middlewares,
 * and the first of them, `resolveUploadContext`, runs before multer looks at the content type: it
 * reads the school's `file_upload_limit` and, when the plan allows no uploads, refuses with
 * `PLAN_LIMIT_EXCEEDED` *before a byte is read*. A JSON body would be refused identically. That code
 * is in `EXPLAINED_CODES`, so a school on such a plan is told its plan is the problem rather than
 * being handed a retry button — but the refusal is for the whole create, not just the attachment, and
 * that is the API's decision to make, not this screen's to work around.
 *
 * ## The class picker carries its own sections, so there is no second request
 *
 * `classes.service.list()` includes `{ model: db.Section, as: 'sections' }`, so one `GET /classes`
 * answers both selects. `GET /classes/{id}/sections` exists and is not used: it is a question already
 * answered, and its payload is `ApiResponse.ok(res, { sections: rows })` — an object rather than the
 * bare array every other collection returns.
 *
 * The section is cleared whenever the class changes. `assertReferences()` calls
 * `loadSectionOfClass(section_id, class_id)`, which requires the section to belong to the class it is
 * sent with, so a selection carried over from the previous class is a guaranteed 422 — and one the
 * user cannot see coming, because the dropdown that held it has already been repopulated.
 *
 * ## What is deliberately not narrowed
 *
 * `assertReferences()` is the whole of the referential rule, and it checks four things independently:
 * the class is of this school, the section is of that class, the session is of this school, the
 * teacher is of this school, and the subject is of this school. Nothing requires any of them to agree
 * with each other, so:
 *
 *   * The **subject** list is not filtered to the class's `class_subjects` rows. That table exists
 *     (§14.4's Subject Assignment) and the service does not consult it; hiding an unassigned subject
 *     here would enforce a rule the module does not have, and homework for a subject a class has just
 *     picked up would become uncreatable.
 *   * The **class** list is not filtered by the chosen session, and each class option names its own
 *     session instead — which is also what tells two identically-named classes from consecutive years
 *     apart.
 *   * Inactive classes, sections, subjects and teachers are annotated, never withheld: not one of the
 *     four loaders tests `is_active`.
 *
 * ## Four lists, four separate grants, and `allSettled`
 *
 * `GET /classes` needs `classes.view`, `/subjects` needs `subjects.view`, `/sessions` needs
 * `sessions.view`, and `/teachers` needs `teachers.view` **plus** the Teachers module —
 * `teachers.routes.js` is the only one of the four that mounts `requireModule`. None of them is the
 * `homework.manage` that opened this screen, so any of the four can fail for a caller perfectly
 * entitled to set homework. `Promise.all` would let one refusal empty the other three dropdowns, so
 * each settles on its own and each says its own remedy. Only the class list is fatal to the form.
 *
 * ## Blank has a specific meaning on four of the optional fields
 *
 *   * **Section** blank is NULL, which the list screen reads as "all sections" — a real answer rather
 *     than an omission, which is why the empty option says so.
 *   * **Academic session** blank is NULL too. There is a `GET /sessions/current` and `create()` does
 *     **not** fall back to it, so blank ties the homework to no session rather than to the current one.
 *   * **Assigned date** blank is defaulted by the service to `dates.toDateOnly(new Date())` — the
 *     server's UTC date. That is not always the browser's date, and the gap has teeth: the model's
 *     `dueNotBeforeAssigned` validator refuses a due date before the assigned one, so a teacher west
 *     of UTC setting homework late in their evening for "today" can be refused by a default they never
 *     saw. Naming the assigned date explicitly is the way out, and the hint says so.
 *   * **Publication** blank is the column default, `true`. A draft is invisible to every student and
 *     parent — `list()` forces `is_published: true` for a self-scope caller, and `findById()` does the
 *     same for a read by id — so this is the control that decides whether §20.2's homework is
 *     "available" yet.
 *
 * ## Two refusals that have no input to land on
 *
 * `dueNotBeforeAssigned` is a **model-level** validator, and Sequelize keys a model-level failure by
 * the validator's own name rather than by a column, so `rethrow()` reports it as
 * `{ field: 'dueNotBeforeAssigned', … }`. A foreign key that vanished between the reference check and
 * the insert reports as `{ field: 'body', … }`. Neither names an input here, and the exemplar's
 * `Object.keys(perField).length ? null : caught.message` would count them, suppress the banner, and
 * render nothing at all — the form would go quiet on the likeliest mistake on the page. So a detail
 * whose field is not one of this form's own is promoted to the top-level `Notice`, alongside the
 * whole-object messages `formErrors()` returns.
 *
 * A refused *file* needs no such handling. `fileFilter` throws a 415 whose `details` is an object
 * (`{ field, received, allowed }`), and `ApiError` normalises a non-array `details` to `[]`, so
 * `fieldErrors()` returns nothing and the server's own sentence reaches the banner.
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
  FileField,
} from '@/components/form';
import { useToast } from '@/components/toast';
import { PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/** `PAGINATION.MAX_LIMIT` — the most `commonSchemas.pagination` accepts in one page. */
const OPTION_LIMIT = 100;

/**
 * How many pages of one option list this form will read — an operational ceiling, not an SRS one.
 *
 * A thousand options is more than any school's classes, subjects or sessions, and ten requests stay
 * well inside `apiLimiter`'s budget. Past it the hints below still say how many were left out.
 */
const MAX_PAGES = 10;

/**
 * The multipart field name `uploadSingle(UPLOAD_PROFILES.HOMEWORK, 'attachment')` listens on. A file
 * sent under any other name is not `req.file`, and the homework would save with no attachment and no
 * complaint.
 */
const FILE_FIELD = 'attachment';

/**
 * The `homework` profile's allowlist, from `UPLOAD_RULES` — PDF plus the three raster formats, one
 * file. A hint to the file picker only: the server checks the declared type *and* that the extension
 * matches it, and this attribute is not a substitute for either.
 */
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';

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

/** `subjects.code` is NOT NULL and unique per school, which is what separates two "Mathematics". */
interface SubjectOption {
  id: number;
  name: string;
  code: string;
  is_active: boolean;
}

/** A teacher as `GET /teachers` returns it. `last_name` is nullable on the model. */
interface TeacherOption {
  id: number;
  employee_id: string;
  first_name: string;
  last_name: string | null;
  is_active: boolean;
}

interface SessionOption {
  id: number;
  name: string;
  /** `ACADEMIC_SESSION_STATUS` — shown as context, never acted on. */
  status: string;
  is_current: boolean;
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
 * Every page of an option list, not only the first.
 *
 * This form used to stop at one page of `OPTION_LIMIT`, so at a school with more than a hundred
 * classes the 101st could never be given homework: `class_id` is required, and no search can reach
 * the rest because `classes.service.list()` ignores `q`. The class picker said so in words and
 * offered no way through. So the remaining pages are read too, in the server's own order — the `id`
 * tiebreaker `getSort` appends keeps every row on exactly one page — up to `MAX_PAGES`.
 *
 * `meta` is the first page's, so `total` is still the whole count and `settle()` can still tell a
 * list that was cut short at the ceiling from one that was read in full.
 *
 * `allSettled`, not `all`: a later page that fails is left out rather than failing the whole list.
 * With `all`, one dropped request among pages two to ten emptied the picker — a school past a hundred
 * classes lost even the first hundred, and the required class could not be chosen at all. The first
 * page still stands, and the shortfall hint says how many are missing, as `useWholeList` does.
 */
async function allPages<T>(path: string): Promise<{ data: T[]; meta: PageMeta | null }> {
  const first = await api.page<T[]>(path, { query: { limit: OPTION_LIMIT } });
  const pages = Math.min(first.meta?.totalPages ?? 1, MAX_PAGES);
  const rest = await Promise.allSettled(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) =>
      api.page<T[]>(path, { query: { page: index + 2, limit: OPTION_LIMIT } })
    )
  );
  return {
    data: [
      ...(first.data ?? []),
      ...rest.flatMap((next) => (next.status === 'fulfilled' ? next.value.data ?? [] : [])),
    ],
    meta: first.meta,
  };
}

/** `teachers.controller.js:8-10` joins the two names and drops the null. */
function teacherName(row: TeacherOption): string {
  return [row.first_name, row.last_name].filter(Boolean).join(' ');
}

/**
 * The form's own field names, and the whole of the create schema's settable surface bar `school_id`.
 *
 * Doubles as the test for "does this 422 belong to an input on this page" — see the header on
 * `dueNotBeforeAssigned`. The file is not among them: no body validation can name it.
 */
const EMPTY_VALUES = {
  title: '',
  class_id: '',
  section_id: '',
  subject_id: '',
  teacher_id: '',
  academic_session_id: '',
  assigned_date: '',
  due_date: '',
  description: '',
  is_published: '',
  reason: '',
};

const FORM_FIELDS = new Set(Object.keys(EMPTY_VALUES));

export default function NewHomeworkPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const [values, setValues] = useState(EMPTY_VALUES);
  const [file, setFile] = useState<File | null>(null);

  const [classes, setClasses] = useState<Loaded<ClassOption>>(NOT_LOADED);
  const [subjects, setSubjects] = useState<Loaded<SubjectOption>>(NOT_LOADED);
  const [teachers, setTeachers] = useState<Loaded<TeacherOption>>(NOT_LOADED);
  const [sessions, setSessions] = useState<Loaded<SessionOption>>(NOT_LOADED);
  const [loadingOptions, setLoadingOptions] = useState(true);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  useEffect(() => {
    /*
     * The permission gate below is a `return` *after* the hooks, so without this all four lists would
     * be fetched for a caller who is about to be told no. `can` is `useCallback`-memoized on the
     * profile in `AuthProvider`, so naming it in the deps does not re-run this on every render.
     */
    if (!can('homework.manage')) {
      setLoadingOptions(false);
      return;
    }

    let live = true;

    (async () => {
      /* `allSettled`, not `all` — see the header on the four separate grants. No `school_id` on any
         of them: `tenantWhere()` has already pinned every one to the caller's school. Each list is
         read to its end rather than to one page — see `allPages()`. */
      const [classResult, subjectResult, teacherResult, sessionResult] = await Promise.allSettled([
        allPages<ClassOption>('/classes'),
        allPages<SubjectOption>('/subjects'),
        allPages<TeacherOption>('/teachers'),
        allPages<SessionOption>('/sessions'),
      ]);
      if (!live) return;

      setClasses(settle(classResult));
      setSubjects(settle(subjectResult));
      setTeachers(settle(teacherResult));
      setSessions(settle(sessionResult));
      setLoadingOptions(false);
    })();

    return () => {
      live = false;
    };
  }, [can]);

  /** Session names by id, for the label that tells two same-named classes apart. */
  const sessionNames = useMemo(() => {
    const byId = new Map<number, string>();
    for (const session of sessions.rows) byId.set(session.id, session.name);
    return byId;
  }, [sessions.rows]);

  const sections = useMemo(() => {
    const chosen = classes.rows.find((row) => String(row.id) === values.class_id);
    return chosen?.sections ?? [];
  }, [classes.rows, values.class_id]);

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
     * Only what was filled in, and every value as the text that was typed. Multipart carries nothing
     * but text anyway, and Joi's `convert: true` is what turns `"7"` into `7`, `"2026-03-01"` into a
     * date and `"false"` into a boolean. Coercing here would turn a stray character into `NaN` — and
     * `section_id`, `subject_id`, `teacher_id` and `academic_session_id` all accept `null` as a
     * *meaning*, so a typo would save silently as "all sections" rather than being refused.
     *
     * Omitting the empties matters most on the three required fields: a missing `class_id` is
     * answered '"class_id" is required', where `""` is answered "must be a number", and only the
     * first names the actual problem.
     */
    const form = new FormData();
    for (const [key, value] of Object.entries(values)) {
      const trimmed = value.trim();
      if (trimmed) form.append(key, trimmed);
    }
    if (file) form.append(FILE_FIELD, file);

    try {
      /* No `body`: `request()` sends `formData` instead and leaves `Content-Type` unset, so the
         browser writes the multipart boundary itself. The CSRF header is still added — it is keyed
         off the method, not the body shape. */
      await api.post('/homework', undefined, { formData: form });
      /* `replace`, not `push`: Back would otherwise re-open an empty form for homework that exists. */
      success('Homework set', 'It is now visible to the class.');
      router.replace('/school/homework');
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError) {
        const perField = caught.fieldErrors();

        /* Whole-object rules have no field at all; `dueNotBeforeAssigned`, `body` and `school_id`
           have one this form does not render. Both belong at the top. See the header. */
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
   * Gated exactly as the list screen's "Set homework" button is. One key and no more:
   * `homework.routes.js` requires `homework.manage` on this POST, and the router-level
   * `requireModule(MODULES.HOMEWORK)` is left to the API — §30 Rule 1 puts entitlement there, and
   * `MODULE_NOT_SUBSCRIBED` is explained by `RefusalNotice` if it comes back.
   */
  if (!can('homework.manage')) {
    return (
      <div>
        <PageHeader title="New homework" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to set homework.',
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New homework"
        description="A class, a title and a due date are required. The file, if there is one, has to be attached now."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {classes.failed ? (
        <Notice tone="error">
          The class list could not be loaded, so the class cannot be chosen here — and homework cannot
          be set without one. Viewing classes is a separate permission from setting homework.
        </Notice>
      ) : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The assignment"
          description="What is being set, and what the students are asked to do."
        >
          <Field
            id="title"
            label="Title"
            required
            maxLength={180}
            value={values.title}
            onChange={set('title')}
            error={fieldErrors.title}
            hint="Up to 180 characters. Searched alongside the description on the homework list."
          />
        </FormSection>

        <FormSection
          title="Who it is for"
          description="The class, subject and teacher this homework belongs to."
        >
          <SelectField
            id="class_id"
            label="Class"
            required
            value={values.class_id}
            onChange={onClassChange}
            disabled={loadingOptions || classes.failed}
            error={fieldErrors.class_id}
            /* Neither branch is a caveat about the control — the first says homework cannot be set at
               all yet, the second that the class you want may be missing from a truncated page. */
            hint={
              !loadingOptions && !classes.failed && classes.rows.length === 0
                ? 'This school has no classes yet, and homework has to be set for one. Create a class first.'
                : classes.total > classes.rows.length
                  ? `Only the first ${classes.rows.length} of ${classes.total} classes could be listed here.`
                  : undefined
            }
          >
            <option value="">{loadingOptions ? 'Loading…' : 'Choose a class'}</option>
            {classes.rows.map((row) => {
              const session = row.academic_session_id
                ? sessionNames.get(row.academic_session_id)
                : undefined;
              return (
                <option key={row.id} value={row.id}>
                  {row.name}
                  {row.code ? ` (${row.code})` : ''}
                  {session ? ` — ${session}` : ''}
                  {row.is_active ? '' : ' — inactive'}
                </option>
              );
            })}
          </SelectField>

          <SelectField
            id="section_id"
            label="Section"
            value={values.section_id}
            onChange={set('section_id')}
            disabled={!values.class_id || sections.length === 0}
            error={fieldErrors.section_id}
            hint="Naming a section confines the homework to it. Left blank, the whole class owes it."
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
            id="subject_id"
            label="Subject"
            value={values.subject_id}
            onChange={set('subject_id')}
            disabled={loadingOptions || subjects.failed}
            error={fieldErrors.subject_id}
            hint={
              subjects.failed
                ? 'The subject list could not be loaded, so a subject cannot be chosen here. Reading it needs the separate “View subjects” permission. The homework can be set without one.'
                : `Every subject of the school is offered, not only those assigned to the chosen class — the API checks the school and nothing else.${
                    subjects.total > subjects.rows.length
                      ? ` Showing the first ${subjects.rows.length} of ${subjects.total}.`
                      : ''
                  }`
            }
          >
            <option value="">
              {loadingOptions ? 'Loading…' : subjects.failed ? 'Unavailable' : 'No subject'}
            </option>
            {subjects.rows.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name} ({subject.code}){subject.is_active ? '' : ' — inactive'}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="teacher_id"
            label="Teacher"
            value={values.teacher_id}
            onChange={set('teacher_id')}
            disabled={loadingOptions || teachers.failed}
            error={fieldErrors.teacher_id}
            /* This hint read `The <code>teachers</code> row…` while it was hand-rolled markup. `hint`
               takes a string, so the table name is plain text now: being tied to the select by
               `aria-describedby` is worth more than the monospace. */
            hint={
              teachers.failed
                ? 'The teacher list could not be loaded, so no teacher can be named here. Reading it needs the “View teachers” permission and a plan that carries the Teachers module. The homework can be set without one.'
                : `The teachers row this homework is attributed to, which the list can filter on. The account that created it is recorded separately and cannot be changed here.${
                    teachers.total > teachers.rows.length
                      ? ` Showing the first ${teachers.rows.length} of ${teachers.total} by first name.`
                      : ''
                  }`
            }
          >
            <option value="">
              {loadingOptions ? 'Loading…' : teachers.failed ? 'Unavailable' : 'Nobody named'}
            </option>
            {teachers.rows.map((teacher) => (
              <option key={teacher.id} value={teacher.id}>
                {teacherName(teacher)} ({teacher.employee_id})
                {teacher.is_active ? '' : ' — inactive'}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="academic_session_id"
            label="Academic session"
            value={values.academic_session_id}
            onChange={set('academic_session_id')}
            disabled={loadingOptions || sessions.failed}
            error={fieldErrors.academic_session_id}
            hint={
              sessions.failed
                ? 'The session list could not be loaded, so a session cannot be chosen here. Reading it needs the separate “View academic sessions” permission. The homework can be set without one.'
                : 'Optional, and not defaulted: left blank the homework belongs to no session, not to the current one. Newest first.'
            }
          >
            <option value="">
              {loadingOptions ? 'Loading…' : sessions.failed ? 'Unavailable' : 'No session'}
            </option>
            {sessions.rows.map((session) => (
              <option key={session.id} value={session.id}>
                {session.name} · {session.status}
                {session.is_current ? ' · current' : ''}
              </option>
            ))}
          </SelectField>
        </FormSection>

        <FormSection
          title="Dates"
          description="When it is handed out and when it is due back."
        >
          <Field
            id="assigned_date"
            label="Assigned date"
            type="date"
            value={values.assigned_date}
            onChange={set('assigned_date')}
            error={fieldErrors.assigned_date}
            hint="Blank means the server's own date for today, which can be tomorrow's date west of UTC — name it here if the due date is today."
          />

          <Field
            id="due_date"
            label="Due date"
            type="date"
            required
            value={values.due_date}
            onChange={set('due_date')}
            error={fieldErrors.due_date}
            hint="SRS §20.2's due date, and what the homework list is sorted by. It cannot fall before the assigned date."
          />
        </FormSection>

        <FormSection
          title="Details and attachment"
          description="The brief itself, and an optional file to go with it."
        >
          <TextAreaField
            id="description"
            label="Description"
            rows={5}
            maxLength={5000}
            value={values.description}
            onChange={set('description')}
            error={fieldErrors.description}
            hint="Up to 5000 characters. The work itself — searched alongside the title on the list."
          />

          {/*
            * No `error`: a refused file comes back as a 415 whose details carry no field name, so its
            * message reaches the banner above rather than this control.
            *
            * `FileField` owns the chosen file rather than reading it back off the input, because a
            * file input is the one control a browser will not let a page set — which is also why
            * removing an attachment has to clear `input.value` by hand. See the component.
            */}
          <FileField
            id={FILE_FIELD}
            label="Attachment"
            accept={ACCEPT}
            file={file}
            onChange={setFile}
            busy={saving}
            hint="The size ceiling is your plan's file upload limit, so it is not checked here. Attach it now: editing homework afterwards cannot add or swap the file."
          />
        </FormSection>

        <FormSection
          title="Publishing"
          description="Unpublished homework is visible to staff only."
        >
          <SelectField
            id="is_published"
            label="Publication"
            value={values.is_published}
            onChange={set('is_published')}
            error={fieldErrors.is_published}
            hint="A draft is invisible to every student and parent, by id as well as on their list. Publishing is what makes the homework available; unpublishing is how it is withdrawn, since there is no delete."
          >
            {/* Blank is the column's own default rather than this screen naming one. */}
            <option value="">Server default (published)</option>
            <option value="true">Published</option>
            <option value="false">Draft</option>
          </SelectField>

          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            hint="Up to 255 characters. Not stored on the homework — it is the note on this homework's audit entry."
          />
        </FormSection>

        <FormActions cancelHref="/school/homework">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Set homework
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
