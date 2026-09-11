'use client';

/**
 * Create a class — SRS §14.3, FR-SCHOOL-003, Known Issue 30.
 *
 * Follows `(platform)/super-admin/organizations/new/page.tsx`, which is where the shared decisions
 * are argued. Only what is different about *this* create is written down here.
 *
 * ## The field set is the create schema's
 *
 * `classes.validation.js` `create` takes `school_id`, `academic_session_id`, `name`, `code`,
 * `numeric_order`, `class_teacher_id`, `capacity`, `is_active`, `description` and `reason`, and marks
 * exactly two `.required()`: **`academic_session_id`** and **`name`**. This form marks the same two.
 * Everything else has a defensible default in `classes.service.create()` — `numeric_order` of 0,
 * `is_active` of true, and `null` for the rest.
 *
 * `id` and `organization_id` are `forbidden()` rather than merely absent, so they have no control
 * here and are never sent; `organization_id` is copied from the school row by the service.
 *
 * Unlike `coupons`, `reason` **is** in this create schema. It is not a column on `classes`: the
 * service passes it to `recordAudit(...)` as the note on the created-record audit entry. It is on the
 * form because leaving it off would drop the one field that explains *why* a class was added.
 *
 * ## `school_id` is accepted by the schema and is still not on this form
 *
 * `resolveSchool()` reads it only when the caller has no school of their own: a Principal or School
 * Admin — the actors `classes.routes.js` names — already has `tenant.schoolId`, and naming a
 * different id is `CROSS_SCHOOL_ACCESS`. So on the school surface the field offers no capability, and
 * the sibling list screen omits it from `GET /classes` for the same reason.
 *
 * The cost is one refusal that has nowhere to land. A platform caller who reaches this URL directly
 * (nothing in `SCHOOL_NAV` points them here, but the route answers) is refused
 * *"school_id is required when the caller has no school in scope"* — a 422 whose `field` is
 * `school_id`, which matches no input on this form. `fieldErrors()` would file it under a key nothing
 * renders, and the non-empty map would then suppress the banner as well, so the submit would look
 * like it did nothing. Hence `FORM_FIELDS` below: a detail naming a field this form does not have is
 * promoted to the top-level `Notice` alongside the ones that name no field at all.
 *
 * ## Two pickers, and one rule between them
 *
 * `academic_session_id` and `class_teacher_id` are foreign keys, so both are selects rather than id
 * boxes — `classes/page.tsx` already argues that a raw `academic_session_id` in front of an
 * administrator names a row nobody can look up.
 *
 *   * **Sessions: a closed one is not offered, and the current one is the default** — the owner's
 *     decision D20. `classes.service.create()` refuses a class on a closed session with 409
 *     `SESSION_CLOSED` (`assertSessionOpen()`), so offering one would be offering a refusal. An
 *     upcoming session stays a valid choice — the service header says so in as many words, *"Classes
 *     may be created on an upcoming session, not only the current one"* — and the status is shown
 *     beside each name. The default is the school's current session from the profile
 *     (`school.current_session` on `/auth/me`), put in only while the field is still blank; a school
 *     with no current session gets no default. A session closed while the form sat open is still
 *     refused by the server, and that refusal is put on the session select.
 *   * **Teachers are not narrowed.** `loadTeacherInSchool()` checks only that the teacher belongs to
 *     the school, so a retired teacher is marked inactive in the option rather than withheld.
 *
 * Both endpoints need `limit` and nothing this screen cannot supply, and both are capped at
 * `PAGINATION.MAX_LIMIT`; when more rows exist than one page holds, the picker says so rather than
 * quietly hiding the row the operator was looking for.
 *
 * ## The two pickers fail differently, because one of them is required
 *
 * `GET /sessions` needs `sessions.view` and `GET /teachers` needs `teachers.view` **plus** the
 * Teachers module — `teachers.routes.js` mounts `requireModule(MODULES.TEACHERS)`, and it is the only
 * one of the two that does. None of those is `classes.manage`, which is the grant that opened this
 * screen, so either list can fail for a caller who is perfectly entitled to create a class.
 *
 * A missing teacher list costs nothing that cannot wait: `class_teacher_id` is optional, so the
 * picker is replaced by a sentence saying the assignment cannot be made here. A missing session list
 * leaves the current session, which the profile carries, as the one session offered; with no current
 * session either the form cannot go on, because the field is required — and it says so plainly
 * rather than offering a number box for a `academic_sessions.id` no principal has ever seen.
 *
 * ## Numbers go over the wire as the text that was typed
 *
 * `validate()` runs Joi with `convert: true`, so `"3"` arrives as `3`. Coercing here with `Number()`
 * would turn anything unparseable into `NaN`, which `JSON.stringify` writes as `null` — and `null` is
 * a *meaning* on `capacity` rather than an error: the list screen renders it as "not set", which is a
 * different fact from a capacity of 0. A mistyped capacity would save silently as no capacity at all.
 *
 * `is_active` is the exception and is sent as a real boolean, because JSON can carry one and there is
 * no reason to make the server coerce a string it did not have to receive.
 *
 * ## `CLASS_NAME_TAKEN` arrives with an object where the field list goes
 *
 * The likeliest failure on this screen is a duplicate name — the unique key is
 * `(school_id, academic_session_id, name)`, so "Grade 5" twice in one session is refused with
 * `CLASS_NAME_TAKEN` and `details: { name }`, an object rather than the array of `{ field, message }`
 * a 422 carries. `ApiError`'s constructor already normalises that: anything that is not an array of
 * field errors is dropped, so `details` is `[]` here and the conflict's own message reaches the
 * banner. No `Array.isArray` guard is needed at the call site any more, and adding one would imply a
 * hazard the client no longer has.
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
  TextAreaField,
  focusFirstInvalidField,
  FormActions,
  FormSection,
} from '@/components/form';
import { useToast } from '@/components/toast';
import { PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/** `PAGINATION.MAX_LIMIT` — the most `commonSchemas.pagination` will accept in one page. */
const OPTION_LIMIT = 100;

/**
 * The inputs this form actually renders.
 *
 * Anything else the API names in a 422 — `school_id`, above all — has no control to sit under, so it
 * is promoted to the banner instead of vanishing. See the header.
 */
const FORM_FIELDS = new Set([
  'academic_session_id',
  'name',
  'code',
  'numeric_order',
  'class_teacher_id',
  'capacity',
  'is_active',
  'description',
  'reason',
]);

/**
 * An academic session as `GET /sessions` returns it.
 *
 * `sessions.controller.js` hands `ApiResponse.paginated` the Sequelize rows whole, so the row carries
 * every column of the model; only the four this picker reads are declared.
 */
interface SessionOption {
  id: number;
  name: string;
  /** `ACADEMIC_SESSION_STATUS` — upcoming, active or closed. Shown; a closed one is not offered (D20). */
  status: string;
  is_current: boolean;
}

/** `ACADEMIC_SESSION_STATUS.CLOSED` — the status D20 refuses a new class on. */
const CLOSED = 'closed';

/** A teacher as `GET /teachers` returns it. `last_name` is nullable on the model. */
interface TeacherOption {
  id: number;
  employee_id: string;
  first_name: string;
  last_name: string | null;
  is_active: boolean;
}

/** One picker: still loading, unreachable, or the rows plus how many exist in total. */
type Picker<T> =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; rows: T[]; total: number };

/** `teachers.controller.js:8-10` joins the two names and drops the null. */
function teacherName(row: TeacherOption): string {
  return [row.first_name, row.last_name].filter(Boolean).join(' ');
}

export default function NewClassPage() {
  const router = useRouter();
  const { can, profile } = useAuth();
  const { success } = useToast();

  /* D20's default, from the profile — see the header. */
  const current = profile?.school?.current_session ?? null;
  const currentId = current && current.status !== CLOSED ? String(current.id) : '';

  const [values, setValues] = useState({
    academic_session_id: '',
    name: '',
    code: '',
    numeric_order: '',
    class_teacher_id: '',
    capacity: '',
    is_active: '',
    description: '',
    reason: '',
  });

  const [sessions, setSessions] = useState<Picker<SessionOption>>({ state: 'loading' });
  const [teachers, setTeachers] = useState<Picker<TeacherOption>>({ state: 'loading' });

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  useEffect(() => {
    /*
     * The permission gate below is a `return` *after* the hooks, so without this both lists would be
     * fetched for a caller who is about to be told no. `can` is `useCallback`-memoized on the profile
     * in `AuthProvider`, so naming it in the deps does not re-run this on every render.
     */
    if (!can('classes.manage')) return;

    let cancelled = false;

    /*
     * Fetched independently rather than through one `Promise.all`. The two grants are separate and so
     * are the two consequences — a school without the Teachers module still creates classes — and an
     * `all` would let the teacher refusal take the session list down with it.
     *
     * `api.page` rather than `api.get`: `meta.pagination.total` is what tells a picker it is short.
     *
     * Neither call sends `school_id`. `tenantWhere(req.tenant, …)` already pins both queries to the
     * caller's school; a platform caller has none, and would see every school's rows here exactly as
     * they would on any other screen of this surface.
     */
    async function load<T>(path: string, apply: (picker: Picker<T>) => void) {
      try {
        const page = await api.page<T[]>(path, { query: { limit: OPTION_LIMIT } });
        if (!cancelled) {
          apply({ state: 'ready', rows: page.data, total: page.meta?.total ?? page.data.length });
        }
      } catch {
        /* Which refusal it was does not change the remedy, and each branch below says its own. */
        if (!cancelled) apply({ state: 'failed' });
      }
    }

    void load<SessionOption>('/sessions', setSessions);
    void load<TeacherOption>('/teachers', setTeachers);

    return () => {
      cancelled = true;
    };
  }, [can]);

  /*
   * D20's default — see the header. Only into a blank field, so a session somebody has already chosen
   * is never overwritten; a school with no current session has no default.
   */
  useEffect(() => {
    if (!currentId) return;
    setValues((prev) => (prev.academic_session_id ? prev : { ...prev, academic_session_id: currentId }));
  }, [currentId]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    /*
     * Only what was filled in — the exemplar's rule. It matters most on the two required fields: an
     * omitted `academic_session_id` is answered '"academic_session_id" is required', where `""` is
     * answered "must be a number", and only the first names the actual problem.
     */
    const body: Record<string, unknown> = {};
    const put = (key: string, text: string) => {
      const trimmed = text.trim();
      if (trimmed) body[key] = trimmed;
    };

    put('academic_session_id', values.academic_session_id);
    put('name', values.name);
    put('code', values.code);
    put('numeric_order', values.numeric_order);
    put('class_teacher_id', values.class_teacher_id);
    put('capacity', values.capacity);
    put('description', values.description);
    put('reason', values.reason);

    /* The one value converted here. Blank still means "let the service default it" — to `true`. */
    if (values.is_active) body.is_active = values.is_active === 'true';

    try {
      await api.post('/classes', body);
      /* `replace`, not `push` — the exemplar's reason: Back would re-open a form already answered. */
      success('Class created', 'Add its sections next.');
      router.replace('/school/classes');
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError && caught.code === 'SESSION_CLOSED') {
        /*
         * D20 — a 409 whose `details` is an object, so it names no input by itself. The session is the
         * only thing it can be about here: put it there, with the way out. See the header.
         */
        setFieldErrors({ academic_session_id: `${caught.message}. Choose a session that is still open.` });
        setError(null);
        focusFirstInvalidField();
      } else if (caught instanceof ApiError) {
        const perField = caught.fieldErrors();

        /* Messages with no input to sit under: whole-object rules, and `school_id`. See the header. */
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
   * Gated exactly as the list screen's "Add class" button is.
   *
   * One key and no more: `classes.routes.js` mounts `requirePermission('classes.manage')` on this
   * POST and nothing else — no `requirePlatformScope()`, and no `requireModule()`, because classes
   * are core school setup rather than a subscribed module. There is no second rule to restate.
   */
  if (!can('classes.manage')) {
    return (
      <div>
        <PageHeader title="New class" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to create a class.',
          }}
        />
      </div>
    );
  }

  /*
   * D20 — the sessions a new class may be created on. The list, with the current session added when
   * it fell past the first page — it is the default, so it has to be an option — or, for a caller who
   * cannot read the list, the current session alone. See the header.
   */
  const listed = sessions.state === 'ready' ? sessions.rows : [];
  const own = current && sessions.state !== 'loading' ? { ...current, is_current: true } : null;
  const openSessions = (own && !listed.some((row) => row.id === own.id) ? [own, ...listed] : listed)
    .filter((session) => session.status !== CLOSED);

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New class"
        description="An academic session and a name are required. Everything else can be filled in later."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="Session and class"
          description="The academic session this class belongs to, and what it is called."
        >
          {sessions.state === 'failed' && openSessions.length === 0 ? (
            /*
             * No select and no number box. The id is the only thing a fallback input could take, and
             * `academic_sessions.id` is not a number anyone in a school office has ever been shown.
             *
             * Nothing to bind a label to either, so the heading is a paragraph in the label's own
             * style rather than a `<label htmlFor>` pointing at a select that was never rendered.
             */
            <div>
              <p className="field-label mb-1.5">Academic session</p>
              <p className="field-error">
                The academic session list could not be loaded and the school has no current session,
                so the session cannot be chosen here — and a class cannot be created without one.
                Reading the list needs the separate &ldquo;View academic sessions&rdquo; permission.
              </p>
            </div>
          ) : (
            <SelectField
              id="academic_session_id"
              label="Academic session"
              required
              disabled={sessions.state === 'loading'}
              value={values.academic_session_id}
              onChange={set('academic_session_id')}
              error={fieldErrors.academic_session_id}
              /* Every fallback is the one `hint` rather than a paragraph of its own: `SelectField`
                 swaps the 422 in for the hint, so a message and a hint can never stack. */
              hint={
                sessions.state === 'failed'
                  ? 'The academic session list could not be loaded, so only the school’s current session is offered. Reading the list needs the separate “View academic sessions” permission.'
                  : sessions.state === 'ready' && sessions.rows.length === 0
                    ? 'This school has no academic session yet. One has to exist before a class can belong to it — a class is unique per session, so the same name may be reused next year.'
                    : sessions.state === 'ready' && openSessions.length === 0
                      ? 'Every academic session of this school is closed, and a closed session takes no new class. Create or activate a session first.'
                      : `Defaults to the school’s current session. An upcoming session is a valid choice too — next year’s classes can be prepared before it is activated — but a closed one takes no new class and is not offered.${
                          sessions.state === 'ready' && sessions.total > sessions.rows.length
                            ? ` Showing the first ${sessions.rows.length} of ${sessions.total}, newest first.`
                            : ''
                        }`
              }
            >
              <option value="">
                {sessions.state === 'loading' ? 'Loading…' : 'Choose a session'}
              </option>
              {openSessions.map((session) => (
                /*
                 * Status and "current" are shown beside each name. A closed session is left out
                 * rather than disabled: D20 refuses a class on one, and a form for a new class has
                 * no use for it. See the header.
                 */
                <option key={session.id} value={session.id}>
                  {session.name} · {session.status}
                  {session.is_current ? ' · current' : ''}
                </option>
              ))}
            </SelectField>
          )}

          <Field
            id="name"
            label="Name"
            required
            value={values.name}
            onChange={set('name')}
            error={fieldErrors.name}
            hint="1 to 90 characters, e.g. Grade 5. Unique within the chosen session — the same name in two sessions is fine."
          />

          <Field
            id="code"
            label="Code"
            maxLength={40}
            value={values.code}
            onChange={set('code')}
            error={fieldErrors.code}
            hint="Up to 40 characters. A short label of the school's own; nothing checks it for uniqueness."
          />

          <Field
            id="numeric_order"
            label="Order"
            type="number"
            min={0}
            step={1}
            value={values.numeric_order}
            onChange={set('numeric_order')}
            error={fieldErrors.numeric_order}
            /* The model comment: "drives default promotion target (FR-STUDENT-002)" — next class is the
               same school at `numeric_order + 1`, which is why a gap or a duplicate here is worth care. */
            hint="Whole number from 0. Sets the promotion sequence: the next class up is this order plus one. Blank means 0."
          />
        </FormSection>

        <FormSection
          title="Teacher and capacity"
          description="Who runs the class, and how many students it takes."
        >
          {teachers.state === 'failed' ? (
            /*
             * Nothing to bind a label to in either prose branch — the select is the only control, so
             * where it is not rendered the heading is a paragraph in the label's own style rather
             * than a `<label htmlFor>` pointing at nothing. `SelectField` carries it in the third.
             */
            <div>
              <p className="field-label mb-1.5">Class teacher</p>
              <p className="field-hint">
                The teacher list could not be loaded, so a class teacher cannot be chosen here. Reading
                it needs the &ldquo;View teachers&rdquo; permission and a plan that carries the Teachers
                module. The class can be created without one.
              </p>
            </div>
          ) : teachers.state === 'ready' && teachers.rows.length === 0 ? (
            <div>
              <p className="field-label mb-1.5">Class teacher</p>
              <p className="field-hint">
                No teachers have been added to this school yet, so there is nobody to assign.
              </p>
            </div>
          ) : (
            <SelectField
              id="class_teacher_id"
              label="Class teacher"
              disabled={teachers.state === 'loading'}
              value={values.class_teacher_id}
              onChange={set('class_teacher_id')}
              error={fieldErrors.class_teacher_id}
              hint={`SRS §14.3’s class teacher. Optional, and sections carry one of their own.${
                teachers.state === 'ready' && teachers.total > teachers.rows.length
                  ? ` Showing the first ${teachers.rows.length} of ${teachers.total} by first name.`
                  : ''
              }`}
            >
              <option value="">
                {teachers.state === 'loading' ? 'Loading…' : 'Nobody yet'}
              </option>
              {teachers.state === 'ready'
                ? teachers.rows.map((teacher) => (
                    /* Retired teachers are marked, not withheld — `loadTeacherInSchool()` checks
                       the school and nothing else, so excluding them would be a rule of our own. */
                    <option key={teacher.id} value={teacher.id}>
                      {teacherName(teacher)} ({teacher.employee_id})
                      {teacher.is_active ? '' : ' · inactive'}
                    </option>
                  ))
                : null}
            </SelectField>
          )}

          <Field
            id="capacity"
            label="Capacity"
            type="number"
            min={0}
            step={1}
            value={values.capacity}
            onChange={set('capacity')}
            error={fieldErrors.capacity}
            hint="Whole number from 0. Blank leaves it unset, which the class list shows as “not set” — a different fact from a capacity of 0."
          />
        </FormSection>

        <FormSection
          title="Status and notes"
          description="Whether the class is in use, and why it was created."
        >
          <SelectField
            id="is_active"
            label="Status"
            value={values.is_active}
            onChange={set('is_active')}
            error={fieldErrors.is_active}
            hint="Inactive is how a class is retired without deleting it — and deleting is refused outright while students or sections still point at it."
          >
            {/* Blank is the service's own default rather than this screen naming one. */}
            <option value="">Server default (active)</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </SelectField>

          <TextAreaField
            id="description"
            label="Description"
            rows={3}
            maxLength={255}
            value={values.description}
            onChange={set('description')}
            error={fieldErrors.description}
            hint="Up to 255 characters."
          />

          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            hint="Up to 255 characters. Not stored on the class — it is the note on this class's audit entry."
          />
        </FormSection>

        <FormActions cancelHref="/school/classes">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create class
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
