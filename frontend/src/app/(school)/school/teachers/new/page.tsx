'use client';

/**
 * Add a teacher — SRS §15.3, FR-TEACHER-001, Known Issue 30.
 *
 * Follows `super-admin/organizations/new/page.tsx`, where the shared decisions are argued — the
 * omitted-not-empty body, `replace` over `push`, each server message bound to the input it names.
 * Its immediate sibling is `school/staff/new/page.tsx`: §15.3 and §15.4 model a person on the payroll
 * the same way, so only what is different about *this* create is written down here.
 *
 * ## The field set is the create schema's
 *
 * `teachers.validation.js` `create` marks exactly three fields `.required()` — **`employee_id`**,
 * **`first_name`** and **`joining_date`** — and spreads its `profile` group for the rest. Every
 * optional field in that group is on this form, because an optional field the API accepts and the UI
 * omits is a capability the product does not have.
 *
 * There is no equivalent of Staff's required `category`: §15.3 gives a teacher no classification of
 * its own, and `designation` is the free-text job title in its place. `last_name` is optional and
 * `joining_date` is required, which is the schema following the model (`last_name allowNull: true`,
 * `joining_date allowNull: false`) rather than intuition about which of a person's names you know.
 *
 * ## Three columns are refused by name, and the interesting one is `photo_path`
 *
 * `id` and `organization_id` are `forbiddenField(...)` — allocated by the system, taken from the
 * school row. `photo_path` is `Joi.any().forbidden()` with a message that says why: *"SRS §15.3 names
 * no photo for a teacher"*. Unlike `students.photo_path` this column has **no writer anywhere** — no
 * upload route, no service assignment — so a file input here would be a control whose only possible
 * outcome is a 422 explaining that the feature does not exist.
 *
 * `left_at` is absent for a different reason: it is in `update` and not in `create`. Leaving is
 * something that happens to an existing record, so there is nothing to record on the way in.
 *
 * ## Subjects and classes are not on this form, and FR-TEACHER-001 names them
 *
 * The requirement reads "assigns Subjects and Classes", and neither is in the create schema. That is
 * deliberate rather than missing: `teacher_subjects` is written by §14.4's
 * `POST /subjects/:id/teachers`, and being class teacher of a class is `classes.class_teacher_id`,
 * set through `PATCH /classes/:id` — the same picker the New class screen offers. The teachers module
 * reads both relations (`GET /teachers/:id/assignments`) and deliberately writes neither, so that one
 * invariant has one implementation. A control here would post to an endpoint that does not accept it.
 *
 * ## There is no school picker, deliberately
 *
 * `school_id` *is* in the create schema, and it is still not on this form. `teachers.service.create()`
 * calls `resolveSchool(req, payload.school_id)`, and for a caller with a school on `req.tenant` that
 * helper ignores the body and refuses a *different* id with `CROSS_SCHOOL_ACCESS`. This is the school
 * surface, so the only value a principal could usefully supply is the one the server already has.
 *
 * The consequence is handled rather than assumed away. An organization-scoped account granted
 * `teachers.manage` has no `tenant.schoolId`, and `resolveSchool` answers it with a 422 whose only
 * detail names `school_id` — a field with no input here. A field error matching no control renders
 * nowhere at all *and* makes the map non-empty, which would suppress the banner too, so the catch
 * below promotes any such message to the top-level notice.
 *
 * ## Creating someone inactive costs the school nothing
 *
 * The most surprising thing on this screen, and it is in the route rather than the schema.
 * `POST /teachers` carries `enforceLimit(LIMITS.TEACHER_LIMIT, { increment: (req) => req.body.is_active
 * === false ? 0 : 1 })`, because §11.2's `teacher_limit` is a **headcount over `is_active: true`** and
 * a flat charge of 1 meant a school at its ceiling could not enter someone who had already left. So
 * "Inactive" is not merely a flag on the row — it is the difference between consuming an allowance and
 * not — and the hint says so. `is_active` is posted as a real boolean; `validate()` reassigns the
 * converted body before `enforceLimit` reads it, so the string would also have worked, but only by a
 * coincidence of middleware ordering.
 *
 * The router also mounts `requireModule(MODULES.TEACHERS)`, the first entitlement guard in the
 * project. Neither guard is pre-checked here: `MODULE_NOT_SUBSCRIBED` and `PLAN_LIMIT_EXCEEDED` are
 * both in `EXPLAINED_CODES`, so the API refuses and `RefusalNotice` explains (SRS §30 Rule 1).
 *
 * ## The linked account is an authorization boundary, not a convenience
 *
 * FR-TEACHER-002's dashboard resolves the teacher from `req.user.id` — `findOne({ user_id })` — so
 * this link is what decides whose timetable and classes that account sees. `loadUserInSchool()`
 * enforces both halves of it: the account must belong to this school, and no other teacher may
 * already hold it. The second check exists because `teachers.user_id` carries a plain index and not a
 * unique one, so a duplicate link would make the dashboard answer with whichever row the optimiser
 * returned first — a silent wrong-record read rather than an error.
 *
 * ## `fieldErrors()` needs no `Array.isArray` guard, and that is not an oversight
 *
 * The two platform create screens wrap it in one; they no longer need to. `ApiError`'s constructor
 * normalises `details` to an array of `{ field, message }` and drops anything else. That matters here
 * because this module's two likeliest failures both throw an **object**:
 * `TEACHER_EMPLOYEE_ID_TAKEN` sends `{ employee_id }` and `TEACHER_USER_TAKEN` sends
 * `{ user_id, teacher_id }`. Both are dropped, no field error is produced, and their message — already
 * a complete sentence — lands in the top-level notice. The 422 from `loadUserInSchool()` is the other
 * shape and does bind to its input.
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
  FormSpan,
  SearchField,
} from '@/components/form';
import { useToast } from '@/components/toast';
import { PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/** `GENDERS` in `constants.js`. The column is nullable, so "not recorded" is a real answer. */
const GENDERS = ['male', 'female', 'other'];

/** `PAGINATION.MAX_LIMIT` — the most `commonSchemas.pagination` will accept in one page. */
const OPTION_LIMIT = 100;

/**
 * The inputs this form actually renders.
 *
 * Used to decide where a server message goes. See the header on `school_id`: a 422 naming a field
 * with no control would otherwise be counted as handled and then drawn nowhere.
 */
const FORM_FIELDS = new Set([
  'employee_id',
  'first_name',
  'last_name',
  'joining_date',
  'is_active',
  'designation',
  'qualification',
  'specialization',
  'experience_years',
  'salary',
  'gender',
  'date_of_birth',
  'email',
  'phone',
  'address',
  'user_id',
  'notes',
  'metadata',
  'reason',
]);

/**
 * A row of `GET /users`, as `users.service.present()` builds it.
 *
 * Only the four values the picker reads are declared. `publicUser()` also returns `status`, `phone`,
 * `locale` and the two id columns; none of them belong in a dropdown label.
 */
interface UserOption {
  id: number;
  name: string;
  username: string;
  email: string | null;
  role?: { slug: string; name: string } | null;
}

/** `male` → `Male`. Sentence case, exactly as the sibling screens render the same enum. */
function humanise(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

export default function NewTeacherPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const [values, setValues] = useState({
    employee_id: '',
    first_name: '',
    last_name: '',
    joining_date: '',
    designation: '',
    qualification: '',
    specialization: '',
    experience_years: '',
    salary: '',
    gender: '',
    date_of_birth: '',
    email: '',
    phone: '',
    address: '',
    user_id: '',
    notes: '',
    metadata: '',
    reason: '',
  });

  /*
   * Held apart from `values` because it is the one field that is not a string on the wire. Kept as
   * `''` / `'true'` / `'false'` so the select has a value to bind to, and converted at submit.
   */
  const [isActive, setIsActive] = useState('');

  const [users, setUsers] = useState<UserOption[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [usersFailed, setUsersFailed] = useState(false);
  const [pinnedUser, setPinnedUser] = useState<UserOption | null>(null);
  const [userSearch, setUserSearch] = useState('');
  const [userQuery, setUserQuery] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  /* The Teachers list's own 300 ms, for the same reason: `apiLimiter` sits in front of every
     keystroke, and `q` is three `LIKE '%…%'` predicates that no index can serve. */
  useEffect(() => {
    const timer = setTimeout(() => setUserQuery(userSearch.trim()), 300);
    return () => clearTimeout(timer);
  }, [userSearch]);

  /*
   * The account picker, and the one foreign key on this form.
   *
   * `user_id` is a foreign key into `users`, so it is a select rather than a number box. But a
   * school's `users` table is not a short list — every student and every parent holds an account
   * there — and `PAGINATION.MAX_LIMIT` caps a page at 100. The first hundred names alphabetically
   * would rarely contain the teacher being entered, which is a picker that *looks* complete and is
   * not. `GET /users` accepts `q` through `commonSchemas.search` (`name`, `email`, `username`, all
   * `LIKE '%…%'`), so the list is searchable rather than merely truncated.
   *
   * It is deliberately **not** narrowed to `?role=teacher`, and the temptation is sharper here than
   * on the Staff screen because a `teacher` role slug exists and would look like the obvious filter.
   * `loadUserInSchool()` checks two things and neither is the role: the account must belong to this
   * school, and no other teacher may already hold it. A role filter would be this screen inventing a
   * rule the service does not have — and it would hide the ordinary case of a head of department
   * whose account carries school leadership instead.
   *
   * `users.view` is a separate grant from the `teachers.manage` that opened this screen. Both belong
   * to `SCHOOL_LEADERSHIP` by default, but grants are editable at runtime
   * (`PUT /roles/:id/permissions`), so a failure is reported as "the list is unavailable" rather than
   * left as an empty dropdown that reads "there are no accounts".
   */
  useEffect(() => {
    /* The permission gate below is a `return` *after* the hooks, so without this the list would be
       fetched for a caller who is about to be told no. `can` is memoized on the profile. */
    if (!can('teachers.manage')) return;

    let live = true;

    (async () => {
      try {
        const page = await api.page<UserOption[]>('/users', {
          query: {
            limit: OPTION_LIMIT,
            sortBy: 'name',
            sortOrder: 'asc',
            q: userQuery || undefined,
          },
        });
        if (!live) return;
        setUsers(page.data);
        setUserTotal(page.meta?.total ?? page.data.length);
        setUsersFailed(false);
      } catch {
        /* Which failure it was does not change the remedy: the link cannot be made from here. */
        if (!live) return;
        setUsers([]);
        setUserTotal(0);
        setUsersFailed(true);
      }
    })();

    return () => {
      live = false;
    };
  }, [can, userQuery]);

  function onUserChange(event: { target: { value: string } }) {
    const chosen = event.target.value;
    setValues((prev) => ({ ...prev, user_id: chosen }));
    /*
     * The chosen account is remembered as a row, not just as an id. Searching again refetches the
     * list, and if the selection falls outside the new page the select would render blank while
     * `values.user_id` still held it — a form that silently disagrees with what it shows. The pinned
     * row is re-added below when the fetched page does not contain it.
     */
    setPinnedUser(chosen ? (users.find((row) => String(row.id) === chosen) ?? pinnedUser) : null);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    /*
     * Only what was filled in, and the two figures go as the strings that were typed.
     *
     * `salary` and `experience_years` are both `.allow(null)`, where null means "not recorded".
     * `Number('7 years')` is `NaN`, which `JSON.stringify` writes as `null` — so coercing here would
     * save a mistyped figure as *no figure at all*, silently. `validate()` runs Joi with
     * `convert: true`, so "7.5" arrives as a number and anything else is answered by the server's own
     * reading of it.
     */
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (key === 'metadata') continue;
      const trimmed = value.trim();
      if (trimmed) body[key] = trimmed;
    }

    /* Blank means the model's own default of `true`. See the header: the two explicit answers are
       booleans because the false one is also a billing decision. */
    if (isActive) body.is_active = isActive === 'true';

    if (values.metadata.trim()) {
      /*
       * A transport concern rather than a duplicated rule: `metadata` is `Joi.object().unknown(true)`
       * and the textarea holds text, so the text has to become an object before it can be a JSON body
       * at all. Anything the schema itself constrains is left to the server.
       */
      try {
        body.metadata = JSON.parse(values.metadata) as unknown;
      } catch {
        setFieldErrors({
          metadata: 'This is not valid JSON. A JSON object looks like {"timetable_code": "PHY-A"}.',
        });
        focusFirstInvalidField();
        setSaving(false);
        return;
      }
    }

    try {
      await api.post('/teachers', body);
      /* `replace`, not `push` — the exemplar's reason: Back would re-open a form already answered. */
      success('Teacher created');
      router.replace('/school/teachers');
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
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      setSaving(false);
    }
  }

  /*
   * Gated exactly as the list screen's "Add teacher" button is. The route re-reads the permission
   * from the database on the request itself, so this is a courtesy rather than a control — but it is
   * a better failure than a nineteen-field form that ends in a 403.
   */
  if (!can('teachers.manage')) {
    return (
      <div>
        <PageHeader title="New teacher" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to add a teacher.',
          }}
        />
      </div>
    );
  }

  /* The pinned selection re-added when a later search pushed it off the page. See `onUserChange`. */
  const userOptions =
    pinnedUser && !users.some((row) => row.id === pinnedUser.id) ? [pinnedUser, ...users] : users;

  /* Built here rather than in the JSX because `SelectField` takes its hint as a string: the
     truncation sentence is only true while the fetched page is shorter than the reported total. */
  const userHint = `The login this teacher signs in with, if they have one — it is what makes the teacher dashboard answer for them. It must belong to this school and may not already be linked to another teacher.${
    userTotal > userOptions.length
      ? ` Showing ${userOptions.length} of ${userTotal} accounts — search to narrow the list.`
      : ''
  }`;

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New teacher"
        description="An employee ID, a first name and a joining date are required. Everything else can be filled in later."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          columns={2}
          title="Employment"
          description="The teacher’s position at the school and the terms of their appointment."
        >
          <Field
            id="employee_id"
            width="sm"
            label="Employee ID"
            required
            maxLength={60}
            value={values.employee_id}
            onChange={set('employee_id')}
            error={fieldErrors.employee_id}
            /* `teachers_school_employee_unique` is the constraint behind the refusal, and the Teachers
               list matches this column in its search box. */
            hint="Up to 60 characters, and unique within this school — the identifier on the payroll line or the ID card."
          />

          <Field
            id="first_name"
            width="md"
            label="First name"
            required
            maxLength={90}
            value={values.first_name}
            onChange={set('first_name')}
            error={fieldErrors.first_name}
          />

          <Field
            id="last_name"
            width="md"
            label="Last name"
            maxLength={90}
            value={values.last_name}
            onChange={set('last_name')}
            error={fieldErrors.last_name}
            hint="Optional — the column is nullable, and the Teachers list joins the two names without leaving a gap when this is empty."
          />

          {/*
           * `DATEONLY`, so a plain `YYYY-MM-DD` is exactly what the column wants. Joi reads it as
           * midnight UTC and `teachers.service.js` puts every date-only write through
           * `dates.toDateOnly()` before it reaches Sequelize (Known Issues #20) — a `datetime-local`
           * here would hand the server a zoneless instant to resolve in its own timezone instead.
           */}
          <Field
            id="joining_date"
            width="sm"
            label="Joining date"
            type="date"
            required
            value={values.joining_date}
            onChange={set('joining_date')}
            error={fieldErrors.joining_date}
            hint="SRS §15.3's Joining Date. Recorded as a plain date, with no time of day."
          />

          <SelectField
            id="is_active"
            width="sm"
            label="Employment status"
            value={isActive}
            onChange={(event) => setIsActive(event.target.value)}
            error={fieldErrors.is_active}
            hint="Inactive is for someone who has already left but still needs a record — §15.3 names no teacher deletion, so this flag is how a departure is kept. It is also the only answer that costs the school nothing: the teacher limit counts active people, so an inactive record is created without consuming an allowance."
          >
            <option value="">Server default (active)</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </SelectField>

          <FormSpan>
            <Field
              id="designation"
              label="Designation"
              maxLength={120}
              value={values.designation}
              onChange={set('designation')}
              error={fieldErrors.designation}
              /* `teachers.service.list()` applies `?designation=` as an equality, not a `LIKE`, so the
                 capitalisation entered here is the capitalisation a filter would have to match exactly. */
              hint="The job title — Head of Department, Senior Teacher. Matched exactly when filtered, so keep the wording consistent between records."
            />
          </FormSpan>

          <Field
            id="qualification"
            width="md"
            label="Qualification"
            maxLength={255}
            value={values.qualification}
            onChange={set('qualification')}
            error={fieldErrors.qualification}
            hint="SRS §15.3's Qualification. Up to 255 characters — the degrees, as they should read on a profile."
          />

          <FormSpan>
            <Field
              id="specialization"
              label="Specialization"
              maxLength={160}
              value={values.specialization}
              onChange={set('specialization')}
              error={fieldErrors.specialization}
              /* The one of the pair the Teachers list gives a column to, because it answers "what does
                 this person teach" in a width a table can hold. */
              hint="Up to 160 characters. The subject area this teacher actually teaches; this is the column the Teachers list shows."
            />
          </FormSpan>

          <FormSpan>
            <Field
              id="experience_years"
              label="Years of experience"
              type="number"
              min={0}
              max={80}
              step="0.01"
              value={values.experience_years}
              onChange={set('experience_years')}
              error={fieldErrors.experience_years}
              /* `DECIMAL(5, 2)` on the model, `min(0).max(80)` in the schema — the ceiling is the
                 schema's, not the column's, which would hold three digits. */
              hint="0 to 80, and fractions are kept to two decimal places. Blank leaves it unrecorded rather than zero."
            />
          </FormSpan>

          {/*
           * Salary is on this form and is deliberately absent from the Teachers list.
           *
           * That is not an inconsistency. The list is gated on `teachers.view`, which an Organization
           * Admin and every school role with a directory to read holds; a salary column there would put
           * every wage in front of anyone who can look a colleague up. This screen is gated on
           * `teachers.manage`, which by default only school leadership holds — and the schema accepts
           * the column on create, so omitting the input would make the figure enterable nowhere.
           */}
          <Field
            id="salary"
            width="sm"
            label="Salary"
            type="number"
            min={0}
            max={999999999999.99}
            step="0.01"
            value={values.salary}
            onChange={set('salary')}
            error={fieldErrors.salary}
            hint="Two decimal places. Feeds the Salaries expense category in §18. Blank leaves it unrecorded rather than zero."
          />
        </FormSection>

        <FormSection
          title="Personal details"
          description="Profile information held on the staff record."
          columns={2}
        >
          <SelectField
            id="gender"
            width="sm"
            label="Gender"
            value={values.gender}
            onChange={set('gender')}
            error={fieldErrors.gender}
          >
            {/* The column is nullable with a null default, so leaving it blank is a recorded answer
                rather than a deferred one. */}
            <option value="">Not recorded</option>
            {GENDERS.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </SelectField>

          <Field
            id="date_of_birth"
            width="sm"
            label="Date of birth"
            type="date"
            value={values.date_of_birth}
            onChange={set('date_of_birth')}
            error={fieldErrors.date_of_birth}
          />
        </FormSection>

        <FormSection
          columns={2}
          title="Contact"
          description="How the school reaches the teacher."
        >
          <Field
            id="email"
            width="md"
            label="Email"
            type="email"
            maxLength={180}
            value={values.email}
            onChange={set('email')}
            error={fieldErrors.email}
            /* `.lowercase()` on the schema, and `email({ tlds: { allow: false } })` — so an internal
               address with no public suffix is accepted rather than rejected as a typo. */
            hint="Up to 180 characters, stored in lower case. An internal address without a public domain is accepted. This is the profile address, not the login."
          />

          <Field
            id="phone"
            width="sm"
            label="Phone"
            maxLength={40}
            value={values.phone}
            onChange={set('phone')}
            error={fieldErrors.phone}
          />

          <FormSpan>
            <Field
              id="address"
              label="Address"
              maxLength={255}
              value={values.address}
              onChange={set('address')}
              error={fieldErrors.address}
              hint="Up to 255 characters."
            />
          </FormSpan>
        </FormSection>

        <FormSection
          title="Sign-in account"
          description="An optional account so the teacher can use the portal. It can be linked later."
        >
          {usersFailed ? (
            /*
             * No control to label in this branch, so the heading is a paragraph: the account list
             * could not be read, and a `<label htmlFor="user_id">` would point at a select that is
             * not rendered. The classes are the ones `SelectField` uses for its own label and hint, so
             * the two branches read identically. A `user_id` error can still arrive here — a selection
             * made before a later search failed is still posted — so it is still drawn.
             */
            <div>
              <p className="field-label mb-1.5">Linked account</p>
              <p className="field-hint">
                The account list could not be loaded, so a login cannot be linked here. Reading it needs
                the separate &ldquo;View users&rdquo; permission. The teacher record can still be
                created, and the link added later from the record itself.
              </p>
              {fieldErrors.user_id ? (
                <p className="field-error mt-1.5">{fieldErrors.user_id}</p>
              ) : null}
            </div>
          ) : (
            /* The search box is a filter over the picker's options and posts nothing, so it stays a
               bare input with its own visually hidden label; `SelectField` labels the control that
               actually carries `user_id`, directly above it. */
            <div className="space-y-2">
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
                width="md"
                label="Linked account"
                value={values.user_id}
                onChange={onUserChange}
                error={fieldErrors.user_id}
                hint={userHint}
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
        </FormSection>

        <FormSection
          title="Internal notes"
          description="Kept on the record and the audit entry."
        >
          <TextAreaField
            id="notes"
            label="Notes"
            rows={4}
            maxLength={2000}
            value={values.notes}
            onChange={set('notes')}
            error={fieldErrors.notes}
            hint="Up to 2000 characters."
          />

          <TextAreaField
            id="metadata"
            label="Metadata"
            rows={3}
            value={values.metadata}
            onChange={set('metadata')}
            placeholder='{"timetable_code": "PHY-A"}'
            error={fieldErrors.metadata}
            hint="A JSON object. Leave it blank unless something outside the system needs to find this record by a reference of its own."
          />

          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            /* Not a column on `teachers` — `EDITABLE` omits it. `create()` passes it to `recordAudit()`
               and nothing else, so it explains the entry rather than describing the person. */
            hint="Up to 255 characters. Kept on this record's audit entry, not on the teacher record itself."
          />
        </FormSection>

        <FormActions cancelHref="/school/teachers">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create teacher
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
