'use client';

/**
 * Create a principal — SRS §9.3 (FR-SADMIN-009), §33's "Principals", Known Issue 30.
 *
 * Built on the Organizations exemplar. Only what is specific to this endpoint is written down here;
 * anything that file already decided — why empty optionals are omitted, why the redirect is `replace`,
 * why field errors come from the server — is not restated.
 *
 * ## Seven fields, and the two that are conspicuously absent
 *
 * `principals.validation.js` `create` takes exactly `name`, `email`, `phone`, `username`, `password`,
 * `school_id` and `status`. **`organization_id` and `role_id` are not accepted at all** — the service
 * copies the organization from the chosen school and resolves the role from the `principal` slug, and
 * its header is explicit that accepting a `role_id` here would let the Principals screen mint a
 * `super_admin`. So this form has no organization control and no role control; adding either would not
 * merely be extra UI, it would send keys `stripUnknown` throws away.
 *
 * ## Which five are required, and why reading the schema object alone is misleading
 *
 * `name`, `username` and `school_id` carry a visible `.required()`. `email` and `password` do not —
 * they are the shared `email` and `newPassword` rules imported from `auth.validation.js`, and the
 * `.required()` is baked into each rule at its definition. Skimming the `create` object would leave
 * both looking optional and this form would happily submit without them. They are required.
 *
 * `phone` and `status` are the only optional two: `users.phone` is nullable, and `users.status` is
 * NOT NULL with a column default that FR-SADMIN-009 wants applied when nothing was submitted.
 *
 * ## The password is not trimmed
 *
 * Every other value is trimmed on the way out, as the exemplar does. The password is sent verbatim.
 * Trimming a credential stores a different secret from the one that was typed, and the person handed
 * that password would then be unable to sign in with it — a failure with no visible cause anywhere.
 * No length is enforced here either: the server's floor is `config.security.passwordMinLength`, which
 * an operator can raise, and the ceiling is 72 **bytes** rather than characters, so a `maxLength` on
 * the input would be wrong for any password carrying a non-ASCII character.
 *
 * ## `details` is not always an array, and that is `ApiError`'s problem, not this page's
 *
 * Two failures this form will routinely provoke carry an object rather than the `validate`
 * middleware's `[{ field, location, message, type }]`: `users.service.rethrowUniqueViolation()` raises
 * 409 `EMAIL_TAKEN` / `USERNAME_TAKEN` with `details: { email: <submitted value> }`, and
 * `requireSchool()` raises 422 with `details: { school_id: '…' }`. This header used to say that
 * `fieldErrors()` would throw on those inside the catch block and that a local `Array.isArray` guard
 * prevented it. The guard was dead: `ApiError`'s constructor already keeps only well-formed field
 * errors in `details` and moves an object to `context`, so `fieldErrors()` cannot throw. It is gone,
 * and the object-shaped cases still reach the top-level notice through `splitApiErrors`, where their
 * messages name the offending field in words ("This username is already taken").
 *
 * ## Arriving from a school
 *
 * The school screen's Principal tab links here as `?school_id=<id>` when the school has no Principal
 * account to assign — `assignPrincipal()` only accepts a principal already belonging to that school,
 * so creating one is the step before assigning. The id preselects the school, and the form then
 * returns to that school's Principal tab rather than to the Principals list — as long as the account
 * is still for that school — so the operator lands where the assignment is made. Cancel goes back
 * there too. The school is fetched by id as well as listed, because on a platform with more schools
 * than a page holds it may not be among the hundred the select loads.
 *
 * ## What the redirect discards
 *
 * The response carries `verificationEmailSent`, and the service's header is clear that a false there is
 * the operator's only signal that FR-AUTH-006's mail did not go out. It is not surfaced here, because
 * the list this screen returns to already carries an "Email verified" column for exactly that question
 * and it answers it for every principal rather than only the one just created.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { splitApiErrors } from '@/lib/formErrors';
import {
  Field,
  Notice,
  SelectField,
  SubmitButton,
  focusFirstInvalidField,
  FormActions,
  PasswordField,
  FormSection,
  SearchField,
} from '@/components/form';
import { useToast } from '@/components/toast';
import { LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/** Every field this form has an input for, so `splitApiErrors` can send the rest to the banner. */
const RENDERED = new Set(['name', 'email', 'username', 'password', 'phone', 'school_id', 'status']);

/** `USER_STATUS` in `constants.js` — the four values `validate()` will accept, mirrored exactly. */
const STATUSES = ['active', 'inactive', 'suspended', 'pending'];

/** `PAGINATION.MAX_LIMIT`. Asking for more is a 422, not a bigger page — see the select's comment. */
const SCHOOL_LIMIT = 100;

/** The four fields this screen reads off a `GET /schools` row; the row carries more. */
interface SchoolOption {
  id: number;
  name: string;
  code: string;
  status: string;
}

function NewPrincipalScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const { can, profile } = useAuth();
  const { success } = useToast();

  /*
   * `?school_id=` from the school screen — see the header. Only a positive integer is taken; anything
   * else is ignored rather than posted, since `commonSchemas.id` would refuse it anyway.
   */
  const requestedSchool = params.get('school_id');
  const fromSchool = requestedSchool && /^[1-9]\d*$/.test(requestedSchool) ? requestedSchool : null;

  /*
   * Both of `POST /principals`'s guards, not just the permission. The route is `requirePlatformScope()`
   * **then** `requirePermission('users.manage')`, and the two refuse for different reasons under
   * different codes, so they are reported separately rather than collapsed into one "not allowed".
   * `profile` is non-null by the time this renders: `AppShell` renders no children until the session
   * has resolved.
   */
  const isPlatform = profile?.tenant.isPlatform === true;
  const allowed = isPlatform && can('users.manage');

  const [values, setValues] = useState({
    name: '',
    email: '',
    phone: '',
    username: '',
    password: '',
    school_id: fromSchool ?? '',
    status: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  /* The `school_id` options. See the effect below for why they carry a filter and a retry. */
  const [schools, setSchools] = useState<SchoolOption[]>([]);
  const [schoolsLoading, setSchoolsLoading] = useState(true);
  const [schoolsError, setSchoolsError] = useState<string | null>(null);
  const [schoolTotal, setSchoolTotal] = useState(0);
  const [schoolFilter, setSchoolFilter] = useState('');
  const [schoolQuery, setSchoolQuery] = useState('');
  const [schoolRetry, setSchoolRetry] = useState(0);
  /*
   * Latched, never cleared. It becomes true the first time the server reports more schools than one
   * page holds, and it is what renders the filter box below. Recomputing it from the current response
   * would take the filter box away the moment a query narrowed the count under the cap — that is, in
   * the middle of typing into it.
   */
  const [schoolsTruncated, setSchoolsTruncated] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSchoolQuery(schoolFilter), 300);
    return () => clearTimeout(timer);
  }, [schoolFilter]);

  /*
   * The school select's options.
   *
   * `api.page` rather than `api.get`, for the `meta.pagination.total` that `api.get` discards. The
   * endpoint caps a page at `PAGINATION.MAX_LIMIT` (100) and refuses a larger `limit` outright, so on
   * a platform with more schools than that the select is *silently* not the whole list — the worst
   * possible failure for a required foreign key, because the operator concludes the school they are
   * looking for was never created. With the total in hand the screen can say so, and `?q=` reaches the
   * rest.
   *
   * `schools.view` is a different permission from the `users.manage` that gates this page. Super Admin
   * holds every permission so the two travel together in practice, but a failure is reported against
   * the select rather than being allowed to look like a platform with no schools in it.
   */
  useEffect(() => {
    if (!allowed) return;

    const controller = new AbortController();
    setSchoolsLoading(true);
    setSchoolsError(null);

    (async () => {
      try {
        const result = await api.page<SchoolOption[]>('/schools', {
          query: {
            limit: SCHOOL_LIMIT,
            sortBy: 'name',
            sortOrder: 'asc',
            q: schoolQuery || undefined,
          },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSchools(result.data);
        setSchoolTotal(result.meta?.total ?? result.data.length);
        if (result.meta && result.meta.total > result.data.length) setSchoolsTruncated(true);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError) {
          setSchoolsError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setSchoolsError('Could not load the list of schools.');
        }
      } finally {
        if (!controller.signal.aborted) setSchoolsLoading(false);
      }
    })();

    return () => controller.abort();
  }, [allowed, schoolQuery, schoolRetry]);

  /*
   * The chosen school, kept among the options whatever the filter shows — so neither a preselected
   * school beyond the first hundred nor one the filter has since narrowed away leaves the select on
   * its placeholder while the form holds, and would post, an id nobody can see.
   */
  const [chosenSchool, setChosenSchool] = useState<SchoolOption | null>(null);
  /* Set when `?school_id=` names no school this account can read; the form then behaves as if unlinked. */
  const [originMissing, setOriginMissing] = useState(false);

  useEffect(() => {
    if (!allowed || !fromSchool) return undefined;
    const controller = new AbortController();

    (async () => {
      try {
        const result = await api.get<{ school: SchoolOption }>(`/schools/${fromSchool}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setChosenSchool(result.school);
      } catch (caught) {
        if (controller.signal.aborted || (caught as Error)?.name === 'AbortError') return;
        /*
         * A school that is gone, or out of reach, cannot be preselected or returned to. Clearing the
         * preselection only if it is still the one the link set, so a school picked by hand meanwhile
         * is left alone.
         */
        setOriginMissing(true);
        setValues((prev) => (prev.school_id === fromSchool ? { ...prev, school_id: '' } : prev));
      }
    })();

    return () => controller.abort();
  }, [allowed, fromSchool]);

  /* Where to go afterwards — the school the operator came from, while it is one that exists. */
  const returnSchool = fromSchool && !originMissing ? fromSchool : null;
  const returnHref = returnSchool
    ? `/super-admin/schools/${returnSchool}?tab=principal`
    : '/super-admin/principals';

  const schoolOptions =
    chosenSchool && !schools.some((school) => school.id === chosenSchool.id)
      ? [chosenSchool, ...schools]
      : schools;

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    const body: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(values)) {
      /* Both are assembled below: one must not be trimmed, the other must not be a string. */
      if (key === 'password' || key === 'school_id') continue;
      if (value.trim()) body[key] = value.trim();
    }
    /* Verbatim — see the header on why trimming a password is not a tidy-up. */
    if (values.password) body.password = values.password;
    /*
     * `commonSchemas.id` is `Joi.number()` and `convert: true` would coerce the string anyway; sent as
     * a number so the request says what it means rather than leaning on the coercion.
     */
    if (values.school_id) body.school_id = Number(values.school_id);

    /*
     * Back to the school when the operator came from one and the account is still for that school —
     * its Principal tab is where the account just made gets assigned. A different school picked by
     * hand goes to the list instead: the origin's picker would not offer an account of another school.
     */
    const backTo = returnSchool && values.school_id === returnSchool ? returnSchool : null;

    try {
      await api.post('/principals', body);
      if (backTo) {
        success(
          'Principal created',
          'They must change their password on first sign-in. Choose them in the Principal picker to assign them.'
        );
        router.replace(`/super-admin/schools/${backTo}?tab=principal`);
      } else {
        success('Principal created', 'They must change their password on first sign-in.');
        router.replace('/super-admin/principals');
      }
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError) {
        /*
         * Whole-object rules, messages keyed to a field with no input, and the object-shaped 409 of a
         * duplicate email or username (see the header) all belong at the top; `splitApiErrors` sends
         * them there and leaves the rest beside their inputs.
         */
        const { perField, banner } = splitApiErrors(caught, RENDERED);
        setFieldErrors(perField);
        focusFirstInvalidField();
        setError(banner);
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      setSaving(false);
    }
  }

  if (!allowed) {
    return (
      <div>
        <PageHeader title="New principal" />
        <RefusalNotice
          refusal={
            isPlatform
              ? {
                  code: 'INSUFFICIENT_PERMISSION',
                  message: 'You do not have permission to create a principal account.',
                }
              : {
                  code: 'PLATFORM_SCOPE_REQUIRED',
                  message:
                    'Creating a principal is restricted to platform administrators. An organization ' +
                    'administrator can view principals but not create one.',
                }
          }
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New principal"
        description="Name, email, username, password and school are required. Phone and status are optional."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {/*
        * `noValidate` is load-bearing for the email field here: the API deliberately accepts internal
        * domains such as `@msms.local` — `auth.validation.js` turns Joi's TLD registry check off and
        * says why — and the browser's own `type="email"` check does not. The type is kept for the
        * keyboard it brings up, not for the validation it would otherwise impose.
        */}
      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The principal"
          description="Their name and the sign-in they will use."
        >
          <Field
            id="name"
            label="Name"
            required
            maxLength={160}
            value={values.name}
            onChange={set('name')}
            error={fieldErrors.name}
          />

          <Field
            id="email"
            label="Email"
            type="email"
            required
            maxLength={180}
            value={values.email}
            onChange={set('email')}
            error={fieldErrors.email}
            hint="Stored in lower case. Internal domains such as @school.local are accepted."
          />

          <Field
            id="username"
            label="Username"
            required
            maxLength={80}
            value={values.username}
            onChange={set('username')}
            error={fieldErrors.username}
            hint="At least 3 characters, starting with a letter or digit; then letters, digits, dots, hyphens and underscores. Stored in lower case."
          />

          <PasswordField
            id="password"
            label="Password"
            required
            autoComplete="new-password"
            value={values.password}
            onChange={set('password')}
            error={fieldErrors.password}
            hint="At least 8 characters, up to 72 bytes. The principal must change it at first sign-in, so hand it over by a route you trust."
          />
        </FormSection>

        <FormSection
          title="Contact and school"
          description="How to reach them, and the school they run."
        >
          <Field
            id="phone"
            label="Phone"
            maxLength={40}
            value={values.phone}
            onChange={set('phone')}
            error={fieldErrors.phone}
          />

          {/*
            * The filter box and the school select are one question to the operator, so the wrapper stays
            * to hold them together — as two children of the form, `space-y-4` would set them as far apart
            * as it sets Phone from School. The filter sits above `SelectField` rather than between its
            * label and its select, because that gap belongs to the component; it is also the order the
            * pair is used in, and it keeps the truncation hint's "Filter above" literally true.
            */}
          <div>
            {schoolsTruncated ? (
              <>
                {/*
                  * Deliberately still a raw input: this one submits nothing. It has no key in `values`,
                  * can never carry a 422, and re-filing it as a `Field` would give the form a second
                  * labelled school control competing with the one that actually posts.
                  */}
                <SearchField
                  id="school-filter"
                  label="Filter schools"
                  placeholder="Filter by school name, code or city…"
                  value={schoolFilter}
                  onChange={setSchoolFilter}
                />
              </>
            ) : null}

            <SelectField
              id="school_id"
              label="School"
              required
              value={values.school_id}
              onChange={(event) => {
                set('school_id')(event);
                setChosenSchool(
                  schoolOptions.find((school) => String(school.id) === event.target.value) ?? null
                );
              }}
              disabled={schoolsLoading || Boolean(schoolsError)}
              error={fieldErrors.school_id}
              /*
               * `schoolsError` is excluded here as well as from `error` — see the notice below the
               * select. Without the guard a failed load would show the "showing N of M" count from the
               * previous successful response beside a select that can no longer be opened.
               */
              hint={
                !schoolsError && schoolsTruncated && !schoolsLoading
                  ? `Showing ${schools.length} of ${schoolTotal} schools — a page holds at most ${SCHOOL_LIMIT}. Filter above to reach the rest.`
                  : undefined
              }
            >
              <option value="">
                {schoolsLoading
                  ? 'Loading schools…'
                  : schoolsError
                    ? 'Schools unavailable'
                    : 'Select a school'}
              </option>
              {schoolOptions.map((school) => (
                <option key={school.id} value={school.id}>
                  {/*
                    * The status is shown, not filtered on. `requireSchool()` accepts any school inside
                    * the caller's scope whatever its state, so hiding the suspended ones would be a rule
                    * §9.3 does not state — but attaching a principal to an archived school by accident
                    * is worth one word of warning.
                    */}
                  {school.name} · {school.code}
                  {school.status === 'active' ? '' : ` (${school.status})`}
                </option>
              ))}
            </SelectField>

            {/*
              * The one message that could not move into the field. It carries a "Try again" button and
              * `error` is a `string`, so it stays a sibling in the slot `SelectField` leaves empty. Its
              * old precedence is unchanged: a 422 on `school_id` still suppresses it, and the component
              * drops the hint by itself whenever it is rendering an error, so at most one message is
              * ever under the select. It is not passed as `error` even as text, because the select is
              * `disabled` in exactly this state — marking an unreachable control `aria-invalid` would
              * blame the operator for a request that never arrived.
              */}
            {!fieldErrors.school_id && schoolsError ? (
              <p className="mt-1 text-sm text-danger">
                {schoolsError}{' '}
                <button
                  type="button"
                  onClick={() => setSchoolRetry((attempt) => attempt + 1)}
                  className="underline underline-offset-2"
                >
                  Try again
                </button>
              </p>
            ) : null}
          </div>
        </FormSection>

        <FormSection
          title="Access"
          description="Whether the account can sign in yet."
        >
          <SelectField
            id="status"
            label="Status"
            value={values.status}
            onChange={set('status')}
            error={fieldErrors.status}
          >
            {/*
              * FR-SADMIN-009 creates the account "with the submitted status", and the service sets the
              * column only when one was submitted. Empty therefore means the column's own default,
              * which is the server's to name and not this screen's.
              */}
            <option value="">Server default</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SelectField>
        </FormSection>

        <FormActions cancelHref={returnHref}>
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create principal
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}

export default function NewPrincipalPage() {
  /*
   * `useSearchParams` reads `?school_id=`, and a statically prerendered route that calls it has to sit
   * under a Suspense boundary or the production build fails — the same wrapper the plan screens use.
   */
  return (
    <Suspense fallback={<LoadingBlock />}>
      <NewPrincipalScreen />
    </Suspense>
  );
}
