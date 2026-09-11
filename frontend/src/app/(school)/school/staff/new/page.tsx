'use client';

/**
 * Record a member of staff — SRS §15.4, FR-STAFF-001, Known Issue 30.
 *
 * Follows `super-admin/organizations/new/page.tsx`, which is where the shared decisions are argued —
 * the omitted-not-empty body, `replace` over `push`, errors bound to the input each one names. Only
 * what is different about *this* create is written down here.
 *
 * ## The field set is the create schema's
 *
 * `staff.validation.js` `create` marks four fields `.required()` — **`employee_id`**, **`category`**,
 * **`first_name`** and **`joining_date`** — and spreads its `profile` group for the rest. Every
 * optional field in that group is on this form, because an optional field the API accepts and the UI
 * omits is a capability the product does not have.
 *
 * Two of those four are worth a note:
 *
 *   * `category` is required *even though the column defaults*. `models/people.js:247` gives it
 *     `defaultValue: STAFF_CATEGORIES.OTHER_STAFF`, so a body without it would still store a row —
 *     but the schema's own comment says §15.4 makes it the defining field, so the schema is stricter
 *     than the column. The select therefore offers no "server default" option, unlike the status
 *     select on the organizations exemplar: a default the schema refuses is not a default.
 *   * `joining_date` is required and `last_name` is not, which is the schema following the model
 *     (`joining_date allowNull: false`, `last_name allowNull: true`) rather than following intuition
 *     about which of a person's two names you are more likely to know.
 *
 * ## Three columns are refused by name, and one of them is `photo_path`
 *
 * `id` and `organization_id` are `forbiddenField(...)` — allocated by the system, taken from the
 * school row — and `photo_path` is `Joi.any().forbidden()` with a message that says why: *"SRS §15.4
 * names no photo for a staff member"*. The validation header is explicit that the column has **no
 * writer at all**, so a file input here would be a control whose only possible outcome is a 422. None
 * of the three appears below.
 *
 * `left_at` is absent for a different reason: it is in `update` and not in `create`. Leaving is
 * something that happens to an existing record, so there is nothing to record on the way in.
 *
 * ## There is no school picker, deliberately
 *
 * `school_id` *is* in the create schema, and it is still not on this form. `staff.service.create()`
 * calls `resolveSchool(req, payload.school_id)`, and for a caller with a school on `req.tenant` that
 * helper ignores the body and refuses a *different* id with `CROSS_SCHOOL_ACCESS`. This is the school
 * surface, so the only value a principal could usefully supply is the one the server already has. The
 * Staff list next door leaves the matching `?school_id=` filter off for the same reason.
 *
 * The consequence is handled rather than assumed away. An organization-scoped account that had been
 * granted `staff.manage` has no `tenant.schoolId`, and `resolveSchool` answers it with a 422 whose
 * only detail names `school_id` — a field with no input on this form. A field error that matches no
 * control renders nowhere at all, so the catch below promotes any such message to the top-level
 * notice instead of dropping it into an empty `fieldErrors` slot.
 *
 * ## Creating someone inactive costs the school nothing
 *
 * The single most surprising thing on this screen, and it is in the route rather than the schema.
 * `POST /staff` carries `enforceLimit(LIMITS.STAFF_LIMIT, { increment: (req) => req.body.is_active
 * === false ? 0 : 1 })`, because `staff_limit` counts `is_active: true` and a flat charge of 1 meant
 * a school at its ceiling could not enter someone who had already left. So "Inactive" is not merely a
 * flag on the row — it is the difference between consuming an allowance and not — and the hint says
 * so. `is_active` is posted as a real boolean; `validate()` reassigns the converted body before
 * `enforceLimit` reads it, so the string would also have worked, but only by a coincidence of
 * middleware ordering.
 *
 * `PLAN_LIMIT_EXCEEDED` and `MODULE_NOT_SUBSCRIBED` are both in `EXPLAINED_CODES`, so neither guard
 * is pre-checked here — the API refuses and `RefusalNotice` explains.
 *
 * ## `fieldErrors()` needs no `Array.isArray` guard, and that is not an oversight
 *
 * The two platform create screens wrap it in one. They no longer need to: `ApiError`'s constructor
 * normalises `details` to an array of `{ field, message }` and drops anything else. That matters here
 * because this module's two likeliest failures both throw an **object** — `STAFF_EMPLOYEE_ID_TAKEN`
 * sends `{ employee_id }` and `STAFF_USER_TAKEN` sends `{ user_id, staff_id }`. Both are dropped, no
 * field error is produced, and their message — already a complete sentence — lands in the top-level
 * notice. The 422 from `loadUserInSchool()` is the other shape and does bind to its input.
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
  SearchField,
} from '@/components/form';
import { useToast } from '@/components/toast';
import { PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/** §15.4's four categories, mirroring `STAFF_CATEGORIES` in `constants.js`. */
const CATEGORIES = ['receptionist', 'accountant', 'librarian', 'other_staff'];

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
  'category',
  'first_name',
  'last_name',
  'designation',
  'joining_date',
  'is_active',
  'salary',
  'qualification',
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

/** `other_staff` → `Other staff`. Sentence case, exactly as the Staff list renders the same enum. */
function humanise(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

export default function NewStaffPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const [values, setValues] = useState({
    employee_id: '',
    category: '',
    first_name: '',
    last_name: '',
    designation: '',
    joining_date: '',
    salary: '',
    qualification: '',
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

  /* The Staff list's own 300 ms, for the same reason: `apiLimiter` sits in front of every keystroke. */
  useEffect(() => {
    const timer = setTimeout(() => setUserQuery(userSearch.trim()), 300);
    return () => clearTimeout(timer);
  }, [userSearch]);

  /*
   * The account picker, and the one place this screen departs from the platform create screens.
   *
   * `user_id` is a foreign key into `users`, so it is a select rather than a number box. But a
   * school's `users` table is not a short list the way `/plans` or `/schools` are — every student and
   * every parent holds an account there — and `PAGINATION.MAX_LIMIT` caps a page at 100. The first
   * hundred names alphabetically would almost never contain the receptionist being entered, which is
   * a picker that *looks* complete and is not. `GET /users` accepts `q` through
   * `commonSchemas.search` (`name`, `email`, `username`, all `LIKE '%…%'`), so the list is searchable
   * rather than merely truncated.
   *
   * It is not narrowed by role, though the temptation is real — four of the eleven role slugs read
   * `receptionist`, `accountant`, `librarian`, `staff`, which is almost §15.4's category list.
   * `loadUserInSchool()` checks two things and neither is the role: the account must belong to this
   * school, and no other staff record may already hold it. A role filter here would be this screen
   * inventing a rule the service does not have, and it would hide the school administrator whose
   * account a principal legitimately wants to link.
   *
   * `users.view` is a separate grant from the `staff.manage` that opened this screen. Both belong to
   * `SCHOOL_LEADERSHIP` by default, but grants are editable at runtime (`PUT /roles/:id/permissions`),
   * so a failure is reported as "the list is unavailable" rather than left as an empty dropdown that
   * reads "there are no accounts".
   */
  useEffect(() => {
    if (!can('staff.manage')) return;

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
     * Only what was filled in. `salary` goes as the string that was typed rather than through
     * `Number()`: the column is `.allow(null)` and null means "not recorded", so a coerced `NaN`
     * would be serialised as `null` and save a mistyped figure as no salary at all. `validate()` runs
     * Joi with `convert: true`, so "42000" arrives as a number and "42,000" is answered by the
     * server's own reading of it.
     */
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (key === 'metadata') continue;
      const trimmed = value.trim();
      if (trimmed) body[key] = trimmed;
    }

    /* Blank means the model's own default of `true`; the two explicit answers are booleans. */
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
          metadata: 'This is not valid JSON. A JSON object looks like {"desk": "front-office-2"}.',
        });
        focusFirstInvalidField();
        setSaving(false);
        return;
      }
    }

    try {
      await api.post('/staff', body);
      /* `replace`, not `push` — the exemplar's reason: Back would re-open a form already answered. */
      success('Staff member created');
      router.replace('/school/staff');
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
   * Gated exactly as the list screen's "Add staff member" button is. The route re-reads the
   * permission from the database on the request itself, so this is a courtesy rather than a control —
   * but it is a better failure than an eighteen-field form that ends in a 403.
   *
   * The router also mounts `requireModule(MODULES.STAFF)` above every route, and nothing here reads
   * the entitlement snapshot to anticipate it (SRS §30 Rule 1). A school whose plan omits Staff is
   * refused with `MODULE_NOT_SUBSCRIBED` on submit, which `RefusalNotice` explains.
   */
  if (!can('staff.manage')) {
    return (
      <div>
        <PageHeader title="New staff member" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to add a staff member.',
          }}
        />
      </div>
    );
  }

  /* The pinned selection re-added when a later search pushed it off the page. See `onUserChange`. */
  const userOptions =
    pinnedUser && !users.some((row) => row.id === pinnedUser.id) ? [pinnedUser, ...users] : users;

  /*
   * Built here rather than inline because `SelectField` takes its hint as a string: the sentence is
   * fixed, and the truncation count is only appended when the page really is a page of a longer list.
   */
  const userHint =
    'The login this person signs in with, if they have one. It must belong to this school and may not already be linked to another staff record.' +
    (userTotal > userOptions.length
      ? ` Showing ${userOptions.length} of ${userTotal} accounts — search to narrow the list.`
      : '');

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New staff member"
        description="An employee ID, a category, a first name and a joining date are required. Everything else can be filled in later."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="Employment"
          description="The role this person holds and the terms of their appointment."
        >
          <Field
            id="employee_id"
            label="Employee ID"
            required
            maxLength={60}
            value={values.employee_id}
            onChange={set('employee_id')}
            error={fieldErrors.employee_id}
            hint="Up to 60 characters, and unique within this school — the identifier on the payroll line or the ID card."
          />

          <SelectField
            id="category"
            label="Category"
            required
            value={values.category}
            onChange={set('category')}
            error={fieldErrors.category}
            hint="SRS §15.4’s four categories. Use Other staff for a role none of the first three names, and the Designation below for the actual job title."
          >
            {/* No "server default" option — see the header: the schema requires this even though the
                column would fall back to Other staff. */}
            <option value="">Choose one…</option>
            {CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </SelectField>

          <Field
            id="first_name"
            label="First name"
            required
            maxLength={90}
            value={values.first_name}
            onChange={set('first_name')}
            error={fieldErrors.first_name}
          />

          <Field
            id="last_name"
            label="Last name"
            maxLength={90}
            value={values.last_name}
            onChange={set('last_name')}
            error={fieldErrors.last_name}
            hint="Optional — the column is nullable, and the Staff list joins the two names without leaving a gap when this is empty."
          />

          <Field
            id="designation"
            label="Designation"
            maxLength={120}
            value={values.designation}
            onChange={set('designation')}
            error={fieldErrors.designation}
            /* `staff.service.list()` applies `?designation=` as an equality, not a `LIKE`, so the
               capitalisation entered here is the capitalisation a filter has to match exactly. */
            hint="The free-text job title that separates two people in the same category. Filtered by exact match, so keep the wording consistent between records."
          />

          {/*
           * `DATEONLY`, so a plain `YYYY-MM-DD` is exactly what the column wants. Joi reads it as
           * midnight UTC and `staff.service.js` puts every date-only write through `dates.toDateOnly()`
           * before it reaches Sequelize (Known Issues #20) — a `datetime-local` here would hand the
           * server a zoneless instant to resolve in its own timezone instead.
           */}
          <Field
            id="joining_date"
            label="Joining date"
            type="date"
            required
            value={values.joining_date}
            onChange={set('joining_date')}
            error={fieldErrors.joining_date}
            hint="The date employment started. Recorded as a plain date, with no time of day."
          />

          <SelectField
            id="is_active"
            label="Employment status"
            value={isActive}
            onChange={(event) => setIsActive(event.target.value)}
            error={fieldErrors.is_active}
            hint="Inactive is for someone who has already left but still needs a record. It is also the only answer that costs the school nothing: the staff limit counts active people, so an inactive record is created without consuming an allowance."
          >
            <option value="">Server default (active)</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </SelectField>

          {/*
           * Salary is on this form and is deliberately absent from the Staff list.
           *
           * That is not an inconsistency. The list is gated on `staff.view`, which the **Librarian**
           * holds (`config/permissions.js:366`) purely to look colleagues up; a salary column there
           * would show every wage in the school to a role with no finance permission at all. This
           * screen is gated on `staff.manage`, which by default only school leadership holds — and the
           * schema accepts the column on create, so omitting the input would make a figure enterable
           * nowhere in the product.
           */}
          {/*
            * `type="text"` with a decimal keypad, not `type="number"`.
            *
            * A number input hands back the **empty string** for anything the browser cannot parse — so
            * "12,500" or "1 200" read as blank, and the submit below only sends what was filled in.
            * A mistyped salary was therefore saved as *unrecorded*, silently, and the hint underneath
            * said that is what blank means. Nothing anywhere reported it.
            *
            * As text the value reaches the server exactly as typed, and `salary` is a Joi number, so a
            * comma comes back as a 422 naming the field — which `fieldErrors.salary` renders right
            * here. `inputMode` keeps the numeric keypad on a phone; the form is `noValidate` anyway, so
            * the `min`/`max` attributes were never enforcing anything the server does not.
            */}

          <Field
            id="salary"
            label="Salary"
            type="text"
            inputMode="decimal"
            value={values.salary}
            onChange={set('salary')}
            error={fieldErrors.salary}
            hint="Two decimal places, digits only. Blank leaves it unrecorded rather than zero."
          />

          <Field
            id="qualification"
            label="Qualification"
            maxLength={255}
            value={values.qualification}
            onChange={set('qualification')}
            error={fieldErrors.qualification}
            hint="Up to 255 characters."
          />
        </FormSection>

        <FormSection
          title="Personal details"
          description="Profile information held on the staff record."
          columns={2}
        >
          <SelectField
            id="gender"
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
            label="Date of birth"
            type="date"
            value={values.date_of_birth}
            onChange={set('date_of_birth')}
            error={fieldErrors.date_of_birth}
          />
        </FormSection>

        <FormSection
          title="Contact"
          description="How the school reaches this member of staff."
        >
          <Field
            id="email"
            label="Email"
            type="email"
            maxLength={180}
            value={values.email}
            onChange={set('email')}
            error={fieldErrors.email}
            /* `.lowercase()` on the schema, and `email({ tlds: { allow: false } })` — so an internal
               address with no public suffix is accepted rather than rejected as a typo. */
            hint="Up to 180 characters, stored in lower case. An internal address without a public domain is accepted."
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
        </FormSection>

        <FormSection
          title="Sign-in account"
          description="An optional account so they can use the portal. It can be linked later."
        >
          {/*
           * The picker keeps a wrapper of its own because two controls belong to it, and only one of
           * them is a form field. The search box narrows the list and posts nothing, so it stays a raw
           * input with a screen-reader-only label of its own; `SelectField` carries the "Linked
           * account" label and, with it, the `aria-describedby` that ties the count and the 422 below
           * to the select they are about.
           */}
          <div>
            {usersFailed ? (
              /*
               * Nothing to label here: when the list could not be loaded the fallback is prose, not a
               * control, so the heading is a paragraph in the label's own style rather than a
               * `<label htmlFor="user_id">` pointing at a select that was never rendered.
               */
              <>
                <p className="field-label mb-1.5">Linked account</p>
                <p className="field-hint">
                  The account list could not be loaded, so a login cannot be linked here. Reading it
                  needs the separate &ldquo;View users&rdquo; permission. The staff record can still be
                  created, and the link added later from the record itself.
                </p>
                {fieldErrors.user_id ? (
                  <p className="field-error mt-1.5">{fieldErrors.user_id}</p>
                ) : null}
              </>
            ) : (
              <>
                <SearchField
                  id="user_id_search"
                  label="Search accounts"
                  placeholder="Search accounts by name, email or username…"
                  value={userSearch}
                  onChange={setUserSearch}
                />
                <SelectField
                  id="user_id"
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
              </>
            )}
          </div>
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
            placeholder='{"desk": "front-office-2"}'
            /* The one error on this form the server never sees: `onSubmit` sets it from `JSON.parse`
               failing, and it renders through the same slot as a 422 would. */
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
            /* Not a column on `staff` — `EDITABLE` omits it. `create()` passes it to `recordAudit()`
               and nothing else, so it explains the entry rather than describing the person. */
            hint="Up to 255 characters. Kept on this record's audit entry, not on the staff record itself."
          />
        </FormSection>

        <FormActions cancelHref="/school/staff">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create staff member
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
