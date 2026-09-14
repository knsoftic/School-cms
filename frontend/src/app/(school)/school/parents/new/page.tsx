'use client';

/**
 * Create a parent account — SRS §15.2, FR-PARENT-001, Known Issue 30.
 *
 * Follows `super-admin/organizations/new/page.tsx`, where the shared decisions are argued. Only what
 * is different about *this* create is written down here — and a fair amount is, because this is the
 * one create screen in the product that brings a sign-in account into existence.
 *
 * ## Four required fields, and the fourth is invisible in the create schema
 *
 * `parents.validation.js` `create` reads as three `.required()` calls — `name`, `email` and
 * `username` — with `password: newPassword` sitting beside them looking optional. It is not.
 * `newPassword` is imported from `auth.validation.js`, where it is defined
 * `.min(…).max(72).custom(…).required()`, and a Joi schema carries its own `.required()` wherever it
 * is reused. `parents.service.create()` agrees: it calls `hashPassword(payload.password)`
 * unconditionally, before the transaction opens. So four fields are marked required below, and the
 * fourth is required because of a rule written in another file.
 *
 * That is also why this screen looks unlike its siblings. `parents.user_id` is NOT NULL —
 * FR-PARENT-001 says "System creates a Parent Account" — so `POST /parents` writes a `users` row and
 * a `parents` row in one transaction. `name`, `email`, `username` and `password` are the **account's**;
 * everything under Contact details is the **profile's**.
 *
 * `email` and `contact_email` are two different columns and the schema is emphatic about it:
 * `users.email` is the sign-in identifier, `parents.email` is a contact address the office holds. The
 * labels say which is which, because getting them the wrong way round produces an account nobody can
 * sign in to and no error anywhere.
 *
 * ## What is deliberately absent
 *
 *   * **`school_id`.** The schema accepts it, but on the school surface it is a scope declaration
 *     rather than a field: `resolveSchool()` takes the caller's own school off `req.tenant` and
 *     answers `CROSS_SCHOOL_ACCESS` if a body names a different one. A school picker on a school's own
 *     screen would offer an administrator a choice they do not have — the reasoning the Parents list
 *     already gives for leaving `school_id` off its filter bar.
 *   * **`photo_path`, `id`, `organization_id`, `user_id`.** All four are `forbidden()`, not merely
 *     absent, so a control for any of them is a control whose only outcome is a 422. `user_id` is the
 *     interesting one: `teachers` and `students` let a body link an existing account, and this module
 *     refuses to, because the account is created *here*.
 *   * **A module pre-check.** `parents.routes.js` mounts `requireModule(MODULES.PARENT_PORTAL)` at
 *     router level. That refusal is `MODULE_NOT_SUBSCRIBED`, which is in `EXPLAINED_CODES`, so it
 *     lands as a refusal on submit. Reading the cached entitlement snapshot here instead would be a
 *     second source of truth free to disagree with the guard — and the guard reads the live
 *     subscription.
 *
 * ## The children list is the point of the screen, and it is a picker
 *
 * §15.2's headline is *Multiple Children*, and `create` takes `children[]` (at most 50) so a parent
 * and their links land in one request. Each entry needs a `student_id` naming a student of this
 * school — `loadStudentInSchool()` checks every one *before* the transaction opens, so one mistyped id
 * refuses the whole create. Which is exactly why these are chosen from `/students` rather than typed.
 *
 * A school holds more students than one page returns (`PAGINATION.MAX_LIMIT` is 100), so the picker is
 * searchable rather than truncated: `?q=` matches first name, last name, student id and roll number,
 * which is how an office looks a child up. A chosen child keeps the row it was chosen from, so it goes
 * on being listed by name after the search that found it has moved on.
 *
 * Students are **not** narrowed to `status = 'active'`. `loadStudentInSchool()` filters on `school_id`
 * alone, and a parent of a student who has left still has fees and results to read. The status is
 * shown beside the name as context and acted on nowhere.
 *
 * ## Three ways a 422 arrives here naming no input on this form
 *
 *   * `children.0.student_id` — `validate.js` joins the Joi path with dots, so a bad entry names its
 *     index. Those are routed back to the row that caused them, keyed by **student id** rather than by
 *     index, so removing a row above one does not move somebody else's error onto it.
 *   * `student_id`, with no index — `loadStudentInSchool()` raises its own validation error and names
 *     the bare column. No input on this form is called that.
 *   * `PARENT_CHILD_LINKED`, `PARENT_USER_TAKEN` and the two account-side duplicates — conflicts,
 *     whose `details` is an object of diagnostics rather than a field list. `ApiError`'s constructor
 *     already drops a non-array to `[]`, so `fieldErrors()` is safe to call here without the
 *     `Array.isArray` guard the earlier create screens needed; what survives is the top-level message.
 *
 * All three end in the banner. Dropping a detail that matches no input is the failure
 * `ApiError.formErrors()` exists to prevent — a rejected submit that looks like nothing happened.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import {
  CheckboxField,
  Field,
  Notice,
  SelectField,
  SubmitButton,
  focusFirstInvalidField,
  FormActions,
  PasswordField,
  FormSection,
  FormSpan,
  SearchField,
} from '@/components/form';
import { Icon } from '@/components/icon';
import { useToast } from '@/components/toast';
import { PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/** `PAGINATION.MAX_LIMIT` — the most `commonSchemas.pagination` accepts in one page. */
const OPTION_LIMIT = 100;

/** `create`'s `children: Joi.array().max(50)`. */
const MAX_CHILDREN = 50;

/** `STUDENT_STATUS.ACTIVE`. The other five are shown; none of them is filtered on. */
const STUDENT_ACTIVE = 'active';

/**
 * One student, as the picker is willing to read them.
 *
 * Narrower than the payload on purpose, the way the Parents and Students lists are narrow: the
 * response is every column of the model bar `photo_path`, and a field that is not on the type cannot
 * reach the screen without a visible edit.
 */
interface StudentOption {
  id: number;
  /** The human-readable admission id, `S-<year>-<sequence>` — not the primary key `children[]` wants. */
  student_id: string;
  first_name: string;
  last_name: string | null;
  status: string;
}

/** One `children[]` entry, holding the row it was chosen from so it survives the next search. */
interface ChildLink {
  student: StudentOption;
  relation: string;
  is_primary_guardian: boolean;
}

/** The student list: still loading, unreachable, or the rows plus how many matched in total. */
type Picker =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; rows: StudentOption[]; total: number };

function studentLabel(student: StudentOption): string {
  const name = [student.first_name, student.last_name].filter(Boolean).join(' ');
  const status = student.status === STUDENT_ACTIVE ? '' : ` — ${student.status}`;
  return `${name} (${student.student_id})${status}`;
}

export default function NewParentPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  /* Every key here is a field the create schema accepts *and* an input id below, which is what lets a
     422's `field` be matched against it. Nothing else on the form is in this object. */
  const [values, setValues] = useState({
    name: '',
    email: '',
    username: '',
    password: '',
    relation: '',
    contact_email: '',
    phone: '',
    occupation: '',
    address: '',
    national_id: '',
    is_active: '',
    reason: '',
  });
  /*
   * Not a schema field, and never sent. `components/form.tsx` names this as the one thing a page may
   * check for itself — "a comparison the API cannot make" — and both auth pages that set a password
   * already do it. It earns its place more here than there: the operator is typing a credential for
   * somebody else and cannot see it, and a typo locks a parent out of an account that has just been
   * mailed a verification link.
   */
  const [confirmation, setConfirmation] = useState('');

  const [children, setChildren] = useState<ChildLink[]>([]);
  const [pick, setPick] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picker, setPicker] = useState<Picker>({ state: 'loading' });

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Keyed by student id, not by row index — see the header. */
  const [childErrors, setChildErrors] = useState<Record<number, string>>({});
  const [notices, setNotices] = useState<string[]>([]);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  /* 300ms, the interval the Parents list already debounces its own search at. */
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    /*
     * The permission gate below is a `return` *after* the hooks, so without this a caller about to be
     * told no would still spend a request on the student list. `can` is `useCallback`-memoized on the
     * profile, so naming it in the deps does not re-run this every render.
     */
    if (!can('parents.manage')) return;

    let cancelled = false;
    setPicker({ state: 'loading' });

    (async () => {
      try {
        /* `api.page`, not `api.get`: `meta.total` is what tells the picker its list is short. */
        const page = await api.page<StudentOption[]>('/students', {
          query: { limit: OPTION_LIMIT, q: debounced.trim() || undefined },
        });
        if (!cancelled) {
          setPicker({
            state: 'ready',
            rows: page.data,
            total: page.meta?.total ?? page.data.length,
          });
        }
      } catch {
        /*
         * Which failure it was does not change the remedy. `students.view` is a separate grant from
         * the `parents.manage` that opened this screen, so a role holding only the latter lands here —
         * and an empty listbox would read as "this school has no students".
         */
        if (!cancelled) setPicker({ state: 'failed' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [can, debounced]);

  const chosen = new Set(children.map((child) => child.student.id));
  /* A student already added is dropped from the picker: `parent_students_unique` refuses the pair, so
     offering the same child twice is offering a request that cannot succeed. */
  const offered = picker.state === 'ready' ? picker.rows.filter((row) => !chosen.has(row.id)) : [];

  function addChild() {
    if (picker.state !== 'ready') return;
    const student = picker.rows.find((row) => String(row.id) === pick);
    if (!student || chosen.has(student.id)) return;
    setChildren((prev) => [...prev, { student, relation: '', is_primary_guardian: false }]);
    setPick('');
  }

  function updateChild(studentId: number, patch: Partial<Omit<ChildLink, 'student'>>) {
    setChildren((prev) =>
      prev.map((child) => (child.student.id === studentId ? { ...child, ...patch } : child))
    );
  }

  function removeChild(studentId: number) {
    setChildren((prev) => prev.filter((child) => child.student.id !== studentId));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setNotices([]);
    setRefusal(null);
    setFieldErrors({});
    setChildErrors({});

    if (values.password !== confirmation) {
      setFieldErrors({ confirmation: 'The two passwords do not match.' });
      focusFirstInvalidField();
      return;
    }

    setSaving(true);

    /* Only what was filled in — the exemplar's rule. A blank required field is then answered
       '"username" is required' rather than by a coerced value the operator never typed. */
    const body: Record<string, unknown> = {};

    const put = (key: string, text: string) => {
      const trimmed = text.trim();
      if (trimmed) body[key] = trimmed;
    };

    put('name', values.name);
    put('email', values.email);
    put('username', values.username);
    /*
     * The password is the one field that is **not** trimmed. `newPassword` is a bare
     * `Joi.string().min().max()` with no `.trim()`, so the server hashes exactly what arrives;
     * trimming here would store something other than what was typed, and the parent would then fail to
     * sign in with the password they were handed.
     */
    if (values.password) body.password = values.password;

    put('relation', values.relation);
    put('contact_email', values.contact_email);
    put('phone', values.phone);
    put('occupation', values.occupation);
    put('address', values.address);
    put('national_id', values.national_id);
    put('reason', values.reason);

    /* A real boolean, not the select's string. `validate()` runs bodies with `convert: true` and would
       read 'false' back either way, but 'false' is a truthy string everywhere else in JavaScript, and
       nothing downstream should have to know that Joi ran first. */
    if (values.is_active) body.is_active = values.is_active === 'true';

    if (children.length) {
      body.children = children.map((child) => {
        const entry: Record<string, unknown> = {
          student_id: child.student.id,
          /* Always sent: the checkbox has a definite state either way, and `create()` defaults an
             omitted one to false. */
          is_primary_guardian: child.is_primary_guardian,
        };
        /* Omitted when blank, and that is load-bearing rather than tidy: `create()` writes
           `child.relation ?? payload.relation ?? null`, so a child with no relation of its own inherits
           the parent profile's. `''` would reach the same place — `link_relation` is `.empty('')` — but
           the body the audit log records should say what the operator actually supplied. */
        if (child.relation.trim()) entry.relation = child.relation.trim();
        return entry;
      });
    }

    try {
      await api.post('/parents', body);
      /* `replace`, not `push` — the exemplar's reason: Back would re-open a form already answered. */
      success('Parent created', 'They must change their password on first sign-in.');
      router.replace('/school/parents');
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError) {
        const perField: Record<string, string> = {};
        const perChild: Record<number, string> = {};
        /* Whole-object Joi rules report with an empty path and have nowhere but the top to sit. */
        const banner = caught.formErrors();
        let unplaced = false;

        for (const detail of caught.details) {
          const indexed = /^children\.(\d+)(?:\.|$)/.exec(detail.field);
          if (indexed) {
            const row = children[Number(indexed[1])];
            /* One message per row. A row can only fail on its student, its relation or its flag, and
               the first of those is the one worth acting on. */
            if (!row) unplaced = true;
            else if (!(row.student.id in perChild)) perChild[row.student.id] = detail.message;
          } else if (detail.field in values || detail.field === 'children') {
            if (!(detail.field in perField)) perField[detail.field] = detail.message;
          } else {
            /* `student_id` from `loadStudentInSchool()`, or a column this form does not render. */
            unplaced = true;
          }
        }

        setFieldErrors(perField);
        focusFirstInvalidField();
        setChildErrors(perChild);

        const placed = Object.keys(perField).length + Object.keys(perChild).length;
        if (banner.length) setNotices(banner);
        else if (unplaced || !placed) setNotices([caught.message]);
      } else {
        setNotices(['Could not reach the server. Check your connection and try again.']);
      }
      setSaving(false);
    }
  }

  /*
   * Gated exactly as the list screen's "Add parent" button is — `parents.manage`, which
   * `parents.routes.js` puts in front of `POST /`. Saying so before a form is filled in is the better
   * failure; the API re-reads the grant on the request either way.
   */
  if (!can('parents.manage')) {
    return (
      <div>
        <PageHeader title="New parent" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to create a parent.',
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New parent"
        description="Creates the parent's sign-in account and their profile together. Name, email, username and password are required."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {notices.map((message) => (
        <Notice key={message} tone="error">
          {message}
        </Notice>
      ))}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          columns={2}
          title="Account"
          description="The sign-in the parent will use. The email address doubles as the username unless one is given."
        >
          <Field
            id="name"
            width="md"
            label="Full name"
            required
            maxLength={160}
            value={values.name}
            onChange={set('name')}
            error={fieldErrors.name}
            hint="2 to 160 characters. Written to both the account and the profile."
          />

          <Field
            id="email"
            width="md"
            label="Sign-in email"
            type="email"
            required
            maxLength={180}
            autoComplete="off"
            value={values.email}
            onChange={set('email')}
            error={fieldErrors.email}
            hint="The address this parent signs in with, and where the verification link is sent. Stored in lower case."
          />

          <Field
            id="username"
            width="md"
            label="Username"
            required
            maxLength={80}
            autoComplete="off"
            value={values.username}
            onChange={set('username')}
            error={fieldErrors.username}
            hint="3 to 80 characters: letters, digits, dots, hyphens and underscores, starting with a letter or digit. Stored in lower case, so capitals are safe to type."
          />

          {/*
            No `maxLength` on either password box. The ceiling is 72 **bytes** — bcrypt hashes no further,
            and the schema refuses the rest rather than truncating silently — while `maxLength` counts
            UTF-16 units, so it would wave 72 emoji through and stop nothing that matters.
          */}
          <PasswordField
            id="password"
            width="md"
            label="Temporary password"
            required
            autoComplete="new-password"
            value={values.password}
            onChange={set('password')}
            error={fieldErrors.password}
            hint="At least 8 characters, up to 72 bytes. The account is created with 'must change password' set, so the parent replaces this on first sign-in."
          />

          <PasswordField
            id="confirmation"
            width="md"
            label="Confirm password"
            required
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            error={fieldErrors.confirmation}
          />

          {/*
            The hint used to set `users.status = inactive` in a <code> element. `hint` is a string, so
            the column is named in the sentence instead: the wording is what carried the point, and
            keeping the monospace would have meant keeping a hand-rolled paragraph that the error has
            to be taught to replace. `SelectField` does that replacing itself.
          */}
          <SelectField
            id="is_active"
            width="sm"
            label="Account state"
            value={values.is_active}
            onChange={set('is_active')}
            error={fieldErrors.is_active}
            hint="This is the login, not a soft profile flag. Creating the parent deactivated writes users.status = inactive in the same transaction, so they cannot sign in until the profile is reactivated."
          >
            <option value="">Server default (active)</option>
            <option value="true">Active</option>
            <option value="false">Deactivated</option>
          </SelectField>
        </FormSection>

        <FormSection
          columns={2}
          title="Parent details"
          description="Held on the parent record, and shown to staff rather than to other families."
        >
          <FormSpan>
            <Field
              id="relation"
              label="Relation"
              maxLength={60}
              value={values.relation}
              onChange={set('relation')}
              error={fieldErrors.relation}
              /* Free text (`STRING(60)`), not an ENUM — the model's comment is the whole vocabulary and the
                 database enforces none of it, so this is an input rather than a select. */
              hint="Free text, up to 60 characters — father, mother, guardian, and so on. A child linked below with no relation of its own inherits this one."
            />
          </FormSpan>

          <Field
            id="contact_email"
            width="md"
            label="Contact email"
            type="email"
            maxLength={180}
            value={values.contact_email}
            onChange={set('contact_email')}
            error={fieldErrors.contact_email}
            hint="A second address held on the profile. Not the sign-in address above; leave it blank if there is only one."
          />

          <Field
            id="phone"
            width="sm"
            label="Phone"
            maxLength={40}
            value={values.phone}
            onChange={set('phone')}
            error={fieldErrors.phone}
            hint="Up to 40 characters. Copied onto the account as well as the profile."
          />

          <Field
            id="occupation"
            width="md"
            label="Occupation"
            maxLength={120}
            value={values.occupation}
            onChange={set('occupation')}
            error={fieldErrors.occupation}
          />

          <FormSpan>
            <Field
              id="address"
              label="Address"
              maxLength={255}
              value={values.address}
              onChange={set('address')}
              error={fieldErrors.address}
            />
          </FormSpan>

          <Field
            id="national_id"
            width="sm"
            label="National ID"
            maxLength={60}
            value={values.national_id}
            onChange={set('national_id')}
            error={fieldErrors.national_id}
            hint="One of the three columns the Parents list searches, alongside name and phone."
          />
        </FormSection>

        <FormSection
          title="Children"
          description="The students this parent is responsible for. Links can be added and removed later."
        >
          {picker.state === 'failed' ? (
            <p className="text-sm text-muted">
              The student list could not be loaded, so children cannot be linked here. The parent can
              still be created; linking a child needs permission to view students as well.
            </p>
          ) : (
            <>
              {/*
                Deliberately not a `Field`. This box submits nothing and can hold no 422: it narrows
                the listbox below it, and the paragraph under it is a live count of what matched
                rather than a hint about what to type, which is neither of the things the wrapper's
                error/hint slot means. Its own `<label htmlFor>` is therefore written out here.
              */}
              <div>
                <SearchField
                  id="child-search"
                  label="Find a student"
                  labelVisible
                  placeholder="Name, student ID or roll number…"
                  value={search}
                  onChange={setSearch}
                  maxLength={120}
                />
                <p className="mt-1 text-sm text-muted">
                  {picker.state === 'ready' && picker.total > picker.rows.length
                    ? `Showing ${picker.rows.length} of ${picker.total} matches — narrow the search to reach the rest.`
                    : 'Students of every status are listed: a child who has left still has records a parent may read.'}
                </p>
              </div>

              <div className="flex flex-wrap items-end gap-3">
                {/* The wrapper stays: it is what gives the picker the width of the row and leaves the
                    button on the end of it. The label is `SelectField`'s now. */}
                <div className="min-w-0 grow">
                  <SelectField
                    id="child-pick"
                    label="Student"
                    value={pick}
                    onChange={(event) => setPick(event.target.value)}
                    disabled={picker.state === 'loading'}
                  >
                    <option value="">
                      {picker.state === 'loading'
                        ? 'Loading…'
                        : offered.length === 0
                          ? 'No student left to add'
                          : 'Choose a student…'}
                    </option>
                    {offered.map((student) => (
                      <option key={student.id} value={student.id}>
                        {studentLabel(student)}
                      </option>
                    ))}
                  </SelectField>
                </div>
                <button
                  type="button"
                  onClick={addChild}
                  /* Capped at the schema's own `.max(50)`. Past that the request is a certain 422, and an
                     operator who has added fifty children is better told now than refused on submit. */
                  disabled={!pick || children.length >= MAX_CHILDREN}
                  className="rounded-md border border-border-strong px-3 py-2 text-sm font-medium disabled:opacity-50"
                >
                  Add child
                </button>
              </div>

              {/* Left as a paragraph of its own. `children` is the array, and no control on the form
                  carries that id; hanging it on the picker would mark a staging select invalid for
                  something the submitted list got wrong. */}
              {fieldErrors.children ? (
                <p className="text-sm text-danger">{fieldErrors.children}</p>
              ) : null}

              {children.length === 0 ? (
                <p className="text-sm text-muted">
                  No children linked yet. This is optional — a parent can be created now and children
                  linked afterwards — but linking them here happens in the same transaction as the
                  account.
                </p>
              ) : (
                <ul className="space-y-3">
                  {children.map((child) => (
                    <li
                      key={child.student.id}
                      className="rounded-md border border-border p-3"
                    >
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-medium">{studentLabel(child.student)}</span>
                        {/*
                          * A real button rather than the underlined text this was: at 17px tall it
                          * was a third of the height of every other control on the form, and on a
                          * phone it sat inside the tap target of the row above it.
                          */}
                        <button
                          type="button"
                          onClick={() => removeChild(child.student.id)}
                          className="btn btn-ghost btn-sm ml-auto"
                        >
                          <Icon name="trash" size={14} />
                          Remove
                        </button>
                      </div>

                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        {/* No wrapper of its own: `Field` renders the div that is the grid cell. */}
                        <Field
                          id={`child-relation-${child.student.id}`}
                          label="Relation to this child"
                          maxLength={60}
                          value={child.relation}
                          onChange={(event) =>
                            updateChild(child.student.id, { relation: event.target.value })
                          }
                          placeholder={values.relation.trim() || 'Inherits the relation above'}
                        />
                        {/* `CheckboxField` gives the box the id and the `htmlFor` label that the
                            wrapping label stood in for, plus the whole row as a hit area. The cell
                            keeps `items-end` so it still sits level with the input beside it. */}
                        <div className="flex items-end">
                          <CheckboxField
                            id={`child-primary-${child.student.id}`}
                            label="Primary guardian"
                            checked={child.is_primary_guardian}
                            onChange={(event) =>
                              updateChild(child.student.id, {
                                is_primary_guardian: event.target.checked,
                              })
                            }
                          />
                        </div>
                      </div>

                      {/* The row's message, not the relation input's: a row can be refused on its
                          student, its relation or its flag, so it belongs to the whole <li> rather
                          than to one of the wrappers. */}
                      {childErrors[child.student.id] ? (
                        <p className="mt-2 text-sm text-danger">
                          {childErrors[child.student.id]}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </FormSection>

        <FormSection
          title="Internal notes"
          description="Kept on the audit entry for this parent."
        >
          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            hint="Up to 255 characters, kept as the reason on this parent's audit entry. The account's own entry records the school instead."
          />
        </FormSection>

        <FormActions cancelHref="/school/parents">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create parent
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
