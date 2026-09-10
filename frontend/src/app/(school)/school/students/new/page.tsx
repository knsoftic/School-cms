'use client';

/**
 * Admit a student — SRS §15.1, FR-STUDENT-001, Known Issue 30.
 *
 * Follows `super-admin/organizations/new/page.tsx`, which is where the shared decisions are argued —
 * the omitted-not-empty body, `replace` over `push`, a server message bound to the input it names.
 * Only what is different about *this* create is written down here.
 *
 * ## The field set is the create schema's
 *
 * `students.validation.js` `create` takes `school_id`, `student_id`, `first_name`, `admission_date`,
 * `class_id`, `section_id`, `academic_session_id` and the whole of its `profile` group, and marks
 * three `.required()`: **`first_name`**, **`admission_date`** and — since the owner's decision D4 in
 * `docs/OWNER-DECISIONS.md` — **`class_id`**. This form marks the same three.
 * Every optional field in that group is here, because an optional field the API accepts and the UI
 * omits is a capability the product does not have.
 *
 * ## Ten columns are refused by name, and the form has a control for none of them
 *
 * `id` and `organization_id` are `forbiddenField(...)`, and so are the seven lifecycle columns —
 * `status`, `promoted_at`, `previous_class_id`, `transferred_at`, `transfer_to`, `left_at`,
 * `leaving_reason`. The validation header gives the reason and it is a security one rather than a
 * tidiness one: `student_limit` counts `status = 'active'`, so a body that could set `status` would
 * put the §11.2 ceiling behind `students.manage` instead of behind `students.progression`. A student
 * is *born* active — `create()` writes `STUDENT_STATUS.ACTIVE` itself — and moves only through
 * `/promote`, `/transfer` and `/leave`.
 *
 * `photo_path` is the tenth, and it is refused with a message naming its one writer:
 * `POST /students/:id/photo`, which takes the image from multer rather than from a body (Known
 * Issues #26). A file input here would be a control whose only outcome is a 422 explaining that.
 * FR-STUDENT-001's "Student Photo" is captured after admission, against the student's own record.
 *
 * ## `school_id` is accepted by the schema and is still not on this form
 *
 * `resolveSchool()` reads it only when the caller has no school of their own, and refuses a
 * *different* id with `CROSS_SCHOOL_ACCESS`. On the school surface the only value a principal or a
 * receptionist could usefully supply is the one the server already holds, so the field offers no
 * capability — the sibling list screen omits the matching `?school_id=` filter for the same reason.
 *
 * The cost is one refusal with nowhere to land. An organization-scoped account granted
 * `students.manage` has no `tenant.schoolId` and is answered *"school_id is required when the caller
 * has no school in scope"* — a 422 whose only detail names a field this form does not render.
 * `fieldErrors()` would file it under a key nothing draws, and the non-empty map would then suppress
 * the banner as well, so a twenty-eight-field submit would look like it had done nothing. Hence
 * `FORM_FIELDS`: a detail naming a field with no control is promoted to the top-level `Notice`.
 *
 * ## The two identifiers are optional even though one of their columns is NOT NULL
 *
 * FR-STUDENT-001 says *"System assigns a Student ID and Roll Number"*, so leaving both blank has to
 * work, and the service allocates them inside the insert's own transaction with a locking read. They
 * are still *accepted*, because the SRS names no format and a school with a numbering scheme of its
 * own must be able to keep it.
 *
 * Two things about that allocation are worth saying on the form, because neither is guessable:
 *
 *   * The generated student ID is `<the school's code>-<the admission year>-<a four-digit sequence>`,
 *     and the year comes from the **admission date on this form**, not from today. Back-dating an
 *     admission therefore back-dates the identifier.
 *   * `allocateRollNumber()` numbers within school + class + section. It used to return `null` for
 *     a student admitted with no class, who then never got a roll number; D4 made the class required,
 *     so every admission is numbered.
 *
 * ## One request answers the class picker and the section picker
 *
 * `classes.service.list()` includes `{ model: db.Section, as: 'sections' }`, so `GET /classes` already
 * carries the sections and the second select narrows from data in hand. `exams/new/page.tsx` argues
 * the alternative and rejects it: `GET /classes/{id}/sections` is a request already answered, and its
 * payload is `ApiResponse.ok(res, { sections: rows })` — an object where every other collection in
 * this client returns a bare array.
 *
 * The section is cleared whenever the class changes, because `loadSectionOfClass()` requires the
 * section to belong to the class it arrives with; a selection carried over from the previous class is
 * a guaranteed 422 the operator cannot see coming, the dropdown having already been repopulated.
 * A section with no class is refused too, and note where that one reports: `resolvePlacement()`
 * raises *"section_id requires class_id"* against **`class_id`**, so the message lands on the select
 * that was left empty rather than on the one that was filled in.
 *
 * ## Two session fields, and they are not the same session
 *
 * `students` carries two foreign keys into `academic_sessions`, and the difference only shows a year
 * later. `academic_session_id` is the session the student is *in*, and `applyTransition()` moves it on
 * every promotion. `admission_session_id` is the session they were *admitted* in, and none of the
 * three FR-STUDENT-002 routes touches it — which is what makes it the intake cohort, though a profile
 * edit may still correct it. Both are checked against the school — the second only since the fix
 * noted in `resolvePlacement()`, which had been letting a body pin a student to another tenant's
 * admission session.
 *
 * ## Nothing here is narrowed, and each omission is the service's decision showing through
 *
 *   * Inactive classes and sections are annotated, never withheld: `loadClassInSchool()` and
 *     `loadSectionOfClass()` test the school and the parent class, and nothing else.
 *   * Sessions of every status are offered, closed ones included. `loadSessionInSchool()` checks only
 *     the school, and a student admitted into a past session is exactly how a school enters a record
 *     it is catching up on.
 *   * The account list is not filtered by role. `loadUserInSchool()` checks two things and neither is
 *     the role: the account must belong to this school, and no other student may already hold it.
 *
 * Each list is capped at `PAGINATION.MAX_LIMIT`, which is 100 and refuses more with a 422, so every
 * picker says when it is showing a first page rather than a set.
 *
 * ## Everything goes over the wire as the text that was typed
 *
 * `validate()` runs Joi with `convert: true`, so `"7"` arrives as `7` and `"2026-04-01"` as a date.
 * Coercing here with `Number()` would turn a stray character into `NaN`, which `JSON.stringify`
 * writes as `null` — and on this record `null` is a *meaning* rather than an error: `class_id`,
 * `section_id` and both session columns are nullable and `ON DELETE SET NULL`, so a mistyped id would
 * save silently as "not placed" instead of being refused.
 *
 * The dates are `DATEONLY` and are posted as the plain `YYYY-MM-DD` an `<input type="date">` yields.
 * Joi reads that as midnight UTC and the service puts both through `dates.toDateOnly()` (Known Issues
 * #20), so the characters typed are the characters stored. A `datetime-local` would hand the server a
 * zoneless instant to resolve in its own timezone instead, and the same form filled in identically
 * from two places would write two different days.
 *
 * `uses_transport` is the one value converted here, because JSON can carry a real boolean and there
 * is no reason to make the server coerce a string it did not have to receive.
 *
 * ## The two guards on the route are left to the API, and they fail in that order
 *
 * `students.routes.js` mounts `requireModule(MODULES.STUDENTS)` router-level and
 * `enforceLimit(LIMITS.STUDENT_LIMIT)` on this POST. Neither is pre-checked here (§30 Rule 1), and
 * both `MODULE_NOT_SUBSCRIBED` and `PLAN_LIMIT_EXCEEDED` are in `EXPLAINED_CODES`, so each arrives as
 * a refusal rather than a red error. `enforceLimit` sits *after* `validate` in that chain, so a form
 * with a bad field is answered 422 first and a school at its ceiling learns so only once the form is
 * clean — which is the right order, but it does mean the limit refusal can appear on a second submit
 * that changed nothing relevant to it.
 *
 * ## No `Array.isArray` guard before `fieldErrors()`, and that is not an oversight
 *
 * The two likeliest conflicts here both send an **object** where the field list goes:
 * `STUDENT_ID_TAKEN` sends `{ student_id }` and `STUDENT_USER_TAKEN` sends `{ user_id, student_id }`.
 * `ApiError`'s constructor already drops a non-array `details`, so `fieldErrors()` returns nothing and
 * each conflict's own message — a complete sentence — reaches the banner. Adding a guard would imply
 * a hazard the client no longer has. The 422 from `loadUserInSchool()` is the other shape, and does
 * bind to its input.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import type { PageMeta } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import {
  Field,
  FieldErrorSummary,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
  FormActions,
  FormSection,
  SearchField,
} from '@/components/form';
import { useToast } from '@/components/toast';
import { PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/** `PAGINATION.MAX_LIMIT` — the most `commonSchemas.pagination` accepts in one page. */
const OPTION_LIMIT = 100;

/** `GENDERS` in `constants.js`. The column is nullable, so "not recorded" is a real answer. */
const GENDERS = ['male', 'female', 'other'];

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
  /** `ACADEMIC_SESSION_STATUS` — shown as context, never acted on. */
  status: string;
  is_current: boolean;
}

/**
 * A row of `GET /users`, as `users.service.present()` builds it.
 *
 * Only the values the picker reads are declared; `publicUser()` returns rather more, and none of the
 * rest belongs in a dropdown label.
 */
interface UserOption {
  id: number;
  name: string;
  username: string;
  email: string | null;
  role?: { slug: string; name: string } | null;
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
 * The form's own field names — the whole settable surface of the create schema bar `school_id`.
 *
 * Doubles as the test for "does this 422 belong to an input on this page". See the header.
 */
const EMPTY_VALUES = {
  first_name: '',
  last_name: '',
  admission_date: '',
  student_id: '',
  admission_number: '',
  admission_session_id: '',
  class_id: '',
  section_id: '',
  academic_session_id: '',
  roll_number: '',
  gender: '',
  date_of_birth: '',
  blood_group: '',
  religion: '',
  nationality: '',
  email: '',
  phone: '',
  address: '',
  city: '',
  guardian_name: '',
  guardian_phone: '',
  guardian_relation: '',
  emergency_contact: '',
  user_id: '',
  uses_transport: '',
  notes: '',
  metadata: '',
  reason: '',
};

const FORM_FIELDS = new Set(Object.keys(EMPTY_VALUES));

/** Sentence case for an enum value, exactly as the students list renders the same words. */
function humanise(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

export default function NewStudentPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const [values, setValues] = useState(EMPTY_VALUES);

  const [classes, setClasses] = useState<Loaded<ClassOption>>(NOT_LOADED);
  const [sessions, setSessions] = useState<Loaded<SessionOption>>(NOT_LOADED);
  const [loadingOptions, setLoadingOptions] = useState(true);

  const [users, setUsers] = useState<Loaded<UserOption>>(NOT_LOADED);
  const [pinnedUser, setPinnedUser] = useState<UserOption | null>(null);
  const [userSearch, setUserSearch] = useState('');
  const [userQuery, setUserQuery] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  /*
   * `allSettled`, not `all`. `GET /classes` needs `classes.view` and `GET /sessions` needs
   * `sessions.view`, and neither is the `students.manage` that opened this screen — grants are
   * editable at runtime (`PUT /roles/:id/permissions`), so a receptionist may well hold one and not
   * the other. An `all` would let either failure empty both dropdowns, and every field they feed is
   * optional: a student can be admitted unplaced and given a class afterwards.
   *
   * Neither call sends `school_id`; `tenantWhere(req.tenant, …)` has already pinned both queries to
   * the caller's school.
   */
  useEffect(() => {
    /* The permission gate is a `return` after the hooks, so without this the lists would be fetched
       for a caller about to be told no. `can` is memoized on the profile in `AuthProvider`. */
    if (!can('students.manage')) {
      setLoadingOptions(false);
      return;
    }

    let live = true;

    (async () => {
      const [classResult, sessionResult] = await Promise.allSettled([
        api.page<ClassOption[]>('/classes', { query: { limit: OPTION_LIMIT } }),
        api.page<SessionOption[]>('/sessions', { query: { limit: OPTION_LIMIT } }),
      ]);
      if (!live) return;

      setClasses(settle(classResult));
      setSessions(settle(sessionResult));
      setLoadingOptions(false);
    })();

    return () => {
      live = false;
    };
  }, [can]);

  /* The students list's own 300 ms, for the same reason: `apiLimiter` is mounted before
     authentication, so it is in front of every keystroke. */
  useEffect(() => {
    const timer = setTimeout(() => setUserQuery(userSearch.trim()), 300);
    return () => clearTimeout(timer);
  }, [userSearch]);

  /*
   * The account picker is searchable, where the other two are merely capped.
   *
   * A school's `users` table is the one list on this screen that is not short — every student and
   * every parent holds a row in it — and `PAGINATION.MAX_LIMIT` caps a page at 100. The first hundred
   * names alphabetically would almost never contain the child being admitted, which is a picker that
   * *looks* complete and is not. `GET /users` accepts `q` through `commonSchemas.search`, scanning
   * `name`, `email` and `username`.
   *
   * Held apart from the two above because it refetches on every search. Its failure is reported
   * rather than left as an empty dropdown: "there are no accounts" is a different claim from "this
   * account needs `users.view`".
   */
  useEffect(() => {
    if (!can('students.manage')) return;

    let live = true;

    (async () => {
      const [result] = await Promise.allSettled([
        api.page<UserOption[]>('/users', {
          query: {
            limit: OPTION_LIMIT,
            sortBy: 'name',
            sortOrder: 'asc',
            q: userQuery || undefined,
          },
        }),
      ]);
      if (!live) return;
      setUsers(settle(result));
    })();

    return () => {
      live = false;
    };
  }, [can, userQuery]);

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

  function onUserChange(event: { target: { value: string } }) {
    const chosen = event.target.value;
    setValues((prev) => ({ ...prev, user_id: chosen }));
    /*
     * The chosen account is remembered as a row, not just as an id. Searching again refetches the
     * list, and if the selection falls outside the new page the select would render blank while
     * `values.user_id` still held it — a form that silently disagrees with what it shows.
     */
    setPinnedUser(
      chosen ? (users.rows.find((row) => String(row.id) === chosen) ?? pinnedUser) : null
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    /*
     * Only what was filled in, and each value as the string it was typed as — see the header. It
     * matters most on the two required fields: an omitted `first_name` is answered
     * '"first_name" is required', where `""` is answered "is not allowed to be empty", and only the
     * first names the actual problem.
     */
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (key === 'metadata' || key === 'uses_transport') continue;
      const trimmed = value.trim();
      if (trimmed) body[key] = trimmed;
    }

    /* Blank leaves the column at its own default of `false`, which is what "does not" stores too. */
    if (values.uses_transport) body.uses_transport = values.uses_transport === 'true';

    if (values.metadata.trim()) {
      /*
       * A transport concern rather than a duplicated rule: `metadata` is `Joi.object().unknown(true)`
       * and the textarea holds text, so the text has to become an object before it can be a JSON body
       * at all. Anything the schema itself constrains is left to the server, which is why a parsed
       * `[1, 2]` is posted rather than rejected here.
       */
      try {
        body.metadata = JSON.parse(values.metadata) as unknown;
      } catch {
        setFieldErrors({
          metadata: 'This is not valid JSON. A JSON object looks like {"house": "Blue"}.',
        });
        focusFirstInvalidField();
        setSaving(false);
        return;
      }
    }

    try {
      await api.post('/students', body);
      /* `replace`, not `push` — the exemplar's reason: Back would re-open a form already answered. */
      success('Student admitted', 'Their student ID and roll number are on the list.');
      router.replace('/school/students');
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError) {
        const perField: Record<string, string> = {};
        const homeless: string[] = [];

        for (const [field, message] of Object.entries(caught.fieldErrors())) {
          /* See the header: `school_id` is the one that reaches here, and it has no control. */
          if (FORM_FIELDS.has(field)) perField[field] = message;
          else homeless.push(message);
        }

        /* Whole-object rules have no field at all; `formErrors()` is where they arrive. */
        homeless.push(...caught.formErrors());

        setFieldErrors(perField);
        focusFirstInvalidField();
        setError(
          homeless.length
            ? homeless.join(' ')
            : Object.keys(perField).length
              ? null
              : caught.message
        );
        /*
         * Take the user to the problem. Suppressing the banner is right — a field is carrying the
         * message — but on 28 fields the button is far below the first of them, so without this the
         * page looked untouched and the submit read as dead. See focusFirstInvalidField.
         */
        focusFirstInvalidField();
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      setSaving(false);
    }
  }

  /*
   * Gated exactly as the list screen's "Admit student" button is.
   *
   * `students.manage` and not `students.progression`: `students.routes.js` records that split as
   * FR-STUDENT-001's own — it names the Receptionist among the actors who admit, and the seeded
   * catalogue gives that role `students.manage` without `students.progression`. So a receptionist may
   * admit a child from this screen and may not later mark one as having left.
   */
  if (!can('students.manage')) {
    return (
      <div>
        <PageHeader title="Admit student" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to admit a student.',
          }}
        />
      </div>
    );
  }

  /* The pinned selection re-added when a later search pushed it off the page. See `onUserChange`. */
  const userOptions =
    pinnedUser && !users.rows.some((row) => row.id === pinnedUser.id)
      ? [pinnedUser, ...users.rows]
      : users.rows;

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Admit student"
        description="A first name, an admission date and a class are required. Everything else — section, profile, guardian — can be filled in later."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {/* Only when the banner is suppressed, so the two never say the same thing twice. */}
      {!error ? <FieldErrorSummary count={Object.keys(fieldErrors).length} /> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="Identity and admission"
          description="Who the student is, and the day they joined. With the class below, these are the fields this form requires."
        >
          <Field
            id="first_name"
            label="First name"
            required
            maxLength={90}
            value={values.first_name}
            onChange={set('first_name')}
            error={fieldErrors.first_name}
            hint="1 to 90 characters. Searched by the students list alongside the last name."
          />

          <Field
            id="last_name"
            label="Last name"
            maxLength={90}
            value={values.last_name}
            onChange={set('last_name')}
            error={fieldErrors.last_name}
            hint="Optional — the column is nullable, and the students list joins the two names without leaving a gap when this is empty."
          />

          {/* `DATEONLY`, posted as typed. See the header on why this is not a `datetime-local`. */}
          <Field
            id="admission_date"
            label="Admission date"
            type="date"
            required
            value={values.admission_date}
            onChange={set('admission_date')}
            error={fieldErrors.admission_date}
            hint="The day the student joined — the event this record exists to capture. Its year is also the year in a generated student ID, so back-dating an admission back-dates the identifier."
          />

          <Field
            id="student_id"
            label="Student ID"
            maxLength={60}
            value={values.student_id}
            onChange={set('student_id')}
            error={fieldErrors.student_id}
            hint="Optional. Left blank, the server allocates one from the school's code, the admission year and a four-digit sequence. Unique within the school, so a duplicate is refused rather than renumbered."
          />

          <Field
            id="admission_number"
            label="Admission number"
            maxLength={60}
            value={values.admission_number}
            onChange={set('admission_number')}
            error={fieldErrors.admission_number}
            hint="Up to 60 characters. A separate number from the student ID, and never generated — a school that does not use one leaves it blank."
          />

          {/* The failure branch is a hint rather than a paragraph of its own: `SelectField` swaps a
              server error in for the hint, so the two can never stack. */}
          <SelectField
            id="admission_session_id"
            label="Admission session"
            value={values.admission_session_id}
            onChange={set('admission_session_id')}
            disabled={loadingOptions || sessions.failed}
            error={fieldErrors.admission_session_id}
            hint={
              sessions.failed
                ? 'The session list could not be loaded, so neither session can be chosen here. Viewing academic sessions is a separate permission from admitting students, and the student can be admitted without either.'
                : `The intake cohort — the session the student joined in. Promotion never moves it, which is what separates it from the current session below.${
                    sessions.total > sessions.rows.length
                      ? ` The first ${sessions.rows.length} of ${sessions.total}; a page cannot hold more.`
                      : ''
                  }`
            }
          >
            <option value="">{loadingOptions ? 'Loading…' : 'Not recorded'}</option>
            {sessions.rows.map((session) => (
              /* Status and "current" are context, never acted on: `loadSessionInSchool()` accepts a
                 session of any status, and disabling options from those columns would be a rule of
                 this screen's own. */
              <option key={session.id} value={session.id}>
                {session.name} — {session.status}
                {session.is_current ? ' — current' : ''}
              </option>
            ))}
          </SelectField>
        </FormSection>

        <FormSection
          title="Class placement"
          description="Where the student sits. The class is required — the roll number is allocated within it — and the section and current session can be set later."
        >
          <SelectField
            id="class_id"
            label="Class"
            required
            value={values.class_id}
            onChange={onClassChange}
            disabled={loadingOptions || classes.failed}
            /* Also where "section_id requires class_id" lands — see the header. */
            error={fieldErrors.class_id}
            hint={
              classes.failed
                ? 'The class list could not be loaded, so a student cannot be admitted from here — every admission names a class. Viewing classes is a separate permission from admitting students; ask someone who holds it, or try again.'
                : !loadingOptions && classes.rows.length === 0
                  ? 'This school has no classes yet. Create one first: every student is admitted into a class, which is where their roll number comes from.'
                  : `Each option names its own session, so two identically-named classes from consecutive years are tellable apart.${
                      classes.total > classes.rows.length
                        ? ` The first ${classes.rows.length} of ${classes.total}; a page cannot hold more.`
                        : ''
                    }`
            }
          >
            <option value="">{loadingOptions ? 'Loading…' : 'Choose a class'}</option>
            {classes.rows.map((row) => {
              const session = row.academic_session_id
                ? sessionNames.get(row.academic_session_id)
                : undefined;
              return (
                /* Inactive classes are marked, not withheld — `loadClassInSchool()` tests the school
                   and nothing else, so dropping them would be a rule of this screen's own. */
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
            hint="Sections of the chosen class only, and cleared whenever that class changes. A section named without a class is refused."
          >
            {/* The empty option carries the reason the select is disabled, so a greyed-out control is
                never silent about why. */}
            <option value="">
              {!values.class_id
                ? 'Choose a class first'
                : sections.length === 0
                  ? 'This class has no sections'
                  : 'No section'}
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
            label="Current session"
            value={values.academic_session_id}
            onChange={set('academic_session_id')}
            disabled={loadingOptions || sessions.failed}
            error={fieldErrors.academic_session_id}
            hint="The session the student is sitting in now. Promotion moves this one and leaves the admission session alone. Blank ties the record to no session at all — the server does not fall back to the current one, even though it is marked in the list."
          >
            <option value="">{loadingOptions ? 'Loading…' : 'Not tied to a session'}</option>
            {sessions.rows.map((session) => (
              <option key={session.id} value={session.id}>
                {session.name} — {session.status}
                {session.is_current ? ' — current' : ''}
              </option>
            ))}
          </SelectField>

          <Field
            id="roll_number"
            label="Roll number"
            maxLength={40}
            value={values.roll_number}
            onChange={set('roll_number')}
            error={fieldErrors.roll_number}
            hint="Optional. With a class chosen, the server issues the next number within that class and section; with no class there is nothing to number within, and the student is admitted without one."
          />
        </FormSection>

        <FormSection
          title="Personal details"
          description="Profile information held on the student record. Every field here is optional."
        >
          {/* No hint: the empty option says everything there is to say, and `SelectField` renders
              nothing at all when neither hint nor error is present. */}
          <SelectField
            id="gender"
            label="Gender"
            value={values.gender}
            onChange={set('gender')}
            error={fieldErrors.gender}
          >
            {/* The column is nullable with no default, so blank is a recorded absence, not a guess. */}
            <option value="">Not recorded</option>
            {GENDERS.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </SelectField>

          <Field
            id="date_of_birth"
            label="Date of birth"
            type="date"
            value={values.date_of_birth}
            onChange={set('date_of_birth')}
            error={fieldErrors.date_of_birth}
            hint="A plain date, with no time of day. The students list shows it because that table has no class column — it is what separates two students of the same name there."
          />

          <Field
            id="blood_group"
            label="Blood group"
            maxLength={10}
            value={values.blood_group}
            onChange={set('blood_group')}
            error={fieldErrors.blood_group}
            /* No select: `constants.js` closes an enum for gender and does not for this. */
            hint="Free text, up to 10 characters. The source fixes no list of values, so nothing here invents one."
          />

          <Field
            id="religion"
            label="Religion"
            maxLength={60}
            value={values.religion}
            onChange={set('religion')}
            error={fieldErrors.religion}
          />

          <Field
            id="nationality"
            label="Nationality"
            maxLength={60}
            value={values.nationality}
            onChange={set('nationality')}
            error={fieldErrors.nationality}
          />
        </FormSection>

        <FormSection
          title="Contact"
          description="How the school reaches the student directly."
        >
          <Field
            id="email"
            label="Email"
            type="email"
            maxLength={180}
            value={values.email}
            onChange={set('email')}
            error={fieldErrors.email}
            hint="The student's own address, stored lower case. Nothing checks it for uniqueness, and it is not a login — that is the linked account below."
          />

          <Field
            id="phone"
            label="Phone"
            maxLength={40}
            value={values.phone}
            onChange={set('phone')}
            error={fieldErrors.phone}
          />

          <Field
            id="address"
            label="Address"
            maxLength={255}
            value={values.address}
            onChange={set('address')}
            error={fieldErrors.address}
            hint="Up to 255 characters."
          />

          <Field
            id="city"
            label="City"
            maxLength={90}
            value={values.city}
            onChange={set('city')}
            error={fieldErrors.city}
          />
        </FormSection>

        <FormSection
          title="Guardian and emergency contact"
          description="Who to call, and who to call when the guardian cannot be reached."
        >
          <Field
            id="guardian_name"
            label="Guardian name"
            maxLength={160}
            value={values.guardian_name}
            onChange={set('guardian_name')}
            error={fieldErrors.guardian_name}
            /* Four plain columns on `students`, not a link to `parents`: §15.2's parent account is its
               own record, related through `parent_students`, and is created on the Parents screen. */
            hint="Recorded on the student row itself. A parent who signs in is a separate §15.2 record, created on the Parents screen and linked there."
          />

          <Field
            id="guardian_phone"
            label="Guardian phone"
            maxLength={40}
            value={values.guardian_phone}
            onChange={set('guardian_phone')}
            error={fieldErrors.guardian_phone}
          />

          <Field
            id="guardian_relation"
            label="Guardian relation"
            maxLength={60}
            value={values.guardian_relation}
            onChange={set('guardian_relation')}
            error={fieldErrors.guardian_relation}
            hint="Free text, up to 60 characters — father, mother, uncle. The source fixes no list."
          />

          <Field
            id="emergency_contact"
            label="Emergency contact"
            maxLength={40}
            value={values.emergency_contact}
            onChange={set('emergency_contact')}
            error={fieldErrors.emergency_contact}
            hint="Up to 40 characters — a number to call, held apart from the guardian's own."
          />
        </FormSection>

        <FormSection
          title="Account and services"
          description="An optional sign-in account for the student, and the services they are enrolled in."
        >
          {/*
            * The one group that cannot be a single `SelectField`, because on the failure branch there
            * is no select to be a field of: the account list is fetched separately from the other two
            * and its failure withdraws the control rather than emptying it. The two branches are held
            * apart so that the heading is a `<label htmlFor>` exactly when there is something for it
            * to point at.
            */}
          {users.failed ? (
            <div>
              <p className="field-label mb-1.5">Linked account</p>
              <p className="field-hint mt-1.5">
                The account list could not be loaded, so a login cannot be linked here. Viewing accounts
                is a separate permission from admitting students; the student can be admitted without
                one, and the link made later.
              </p>
              {/* Kept for the case the list fails *after* a 422 named this field — unlikely, but the
                  message must not disappear with the control it belongs to. */}
              {fieldErrors.user_id ? (
                <p className="field-error mt-1.5">{fieldErrors.user_id}</p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              {/* Not a field and so deliberately not a `Field`: this filters the picker below and
                  posts nothing, which is the one raw `<input>` `verify-frontend.js` allows on a
                  screen — provided it carries a label, which the sr-only one here is. */}
              <div>
                <SearchField
                  id="user_id_search"
                  label="Search accounts"
                  placeholder="Search accounts by name, email or username…"
                  value={userSearch}
                  onChange={setUserSearch}
                />
              </div>
              <SelectField
                id="user_id"
                label="Linked account"
                value={values.user_id}
                onChange={onUserChange}
                error={fieldErrors.user_id}
                hint={`The login the student signs in to the portal with, if one has been issued. It must belong to this school, and no other student may already hold it — the column carries a plain index rather than a unique one, so the service refuses the duplicate itself.${
                  users.total > userOptions.length
                    ? ` Showing ${userOptions.length} of ${users.total} accounts — search to narrow the list.`
                    : ''
                }`}
              >
                <option value="">No linked account</option>
                {userOptions.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name} ({row.username})
                    {row.role ? ` — ${row.role.name}` : ''}
                    {row.email ? ` · ${row.email}` : ''}
                  </option>
                ))}
              </SelectField>
            </div>
          )}

          {/*
            * The hint says plainly what the flag does and does not do, because it promises more than
            * it currently delivers: the column's comment is "set when a transport fee component should
            * apply (SRS §17)", and a grep finds no reader of it in the fees module. Today it records
            * the fact and filters.
            */}
          <SelectField
            id="uses_transport"
            label="School transport"
            value={values.uses_transport}
            onChange={set('uses_transport')}
            error={fieldErrors.uses_transport}
            hint="The column exists for §17’s transport fee component. Nothing in the fees module reads it yet, so for now it records the fact and filters the students list."
          >
            {/* Blank is the column's own default rather than this screen naming one; it and the
                explicit "does not" store the same `false`. */}
            <option value="">Server default (does not use transport)</option>
            <option value="true">Uses school transport</option>
            <option value="false">Does not use school transport</option>
          </SelectField>
        </FormSection>

        <FormSection
          title="Internal notes"
          description="Kept on the record and the audit entry. Never shown to the student or their guardian."
        >
          <TextAreaField
            id="notes"
            label="Notes"
            rows={4}
            maxLength={2000}
            value={values.notes}
            onChange={set('notes')}
            error={fieldErrors.notes}
            hint="Up to 2000 characters, kept on the record."
          />

          {/* The client-side JSON parse in `onSubmit` reports here, which is why this one field
              can hold an error the server never sent. */}
          <TextAreaField
            id="metadata"
            label="Metadata"
            rows={3}
            value={values.metadata}
            onChange={set('metadata')}
            placeholder='{"house": "Blue"}'
            error={fieldErrors.metadata}
            hint="A JSON object. Leave it blank unless something outside the system needs to find this student by a reference of its own."
          />

          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            /* Not a column on `students` — `EDITABLE` omits it. `create()` passes it to `recordAudit()`
               and nothing else, so it explains the entry rather than describing the child. */
            hint="Up to 255 characters. Kept on this admission's audit entry, not on the student record itself."
          />
        </FormSection>

        <FormActions cancelHref="/school/students">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Admitting…">
            Admit student
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
