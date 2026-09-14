'use client';

/**
 * Create a school — SRS §9.2 FR-SADMIN-002, checklist row 4.3, Known Issue 30.
 *
 * Built on `super-admin/organizations/new/page.tsx`, the exemplar for the eighteen create screens.
 * The decisions it already wrote down — why empty optionals are omitted, why `router.replace`, why
 * refusals go through `EXPLAINED_CODES` — are not repeated. Only what this endpoint does differently
 * is recorded below.
 *
 * ## The field set is `schemas.create`, and it surprises twice
 *
 * `schools.validation.js` `create` takes `organization_id`, `name`, `code`, `email`, `phone`,
 * `address`, `city`, `state`, `country` and `status`, marking `organization_id`, `name` and `code`
 * `.required()`. This form marks those three.
 *
 * The first surprise is `status`. It is accepted on **create** and refused on **update**, which is
 * the reverse of the "a create form is the edit form plus the required fields" reading. The
 * validation module gives the reason: FR-SADMIN-005 and FR-SADMIN-006 make every later transition its
 * own operation behind `schools.status` and `schools.archive`, so `status` is writable exactly once —
 * at the moment the row is born — and accepting it in the general edit would let a holder of only
 * `schools.manage` suspend a school through the back door.
 *
 * The second is what is absent. There is no `website` and no `notes` here, though the organization
 * form has both, and there are `city`, `state` and `country`, though it has none of those. That is
 * SRS §29's `schools` table, which the source fixes and forbids adding to — not an oversight in
 * either direction. `principal_id` is likewise absent: FR-SADMIN-009's precondition is that the school
 * exists before its Principal does, so there is no moment at which a principal id could arrive here.
 *
 * ## `code` is unique per organization, not per platform
 *
 * The index `schools_org_code_unique` spans `(organization_id, code)`. Two organizations may each
 * have a school coded `MAIN`. The hint says so, because a conflict on a code the user cannot find on
 * any school they can see reads as a bug otherwise.
 *
 * ## The 409's object-shaped `details` needs nothing from this page
 *
 * `schools.service.js` `rethrow()` raises its duplicate-code 409 with `details` as a plain **object** —
 * `{ code, organization_id }` — not the array `validate()` builds for a 422. This header used to say
 * that `fieldErrors()` would throw on it and that a local `Array.isArray` guard was the fix, because
 * `apiClient.ts` was not this page's to change. That was already untrue: `ApiError`'s constructor
 * normalises `details`, keeping only well-formed field errors in the array and moving an object to
 * `context`, so `fieldErrors()` is always safe and the guard was dead code. It is gone.
 * `SCHOOL_CODE_TAKEN` carries no field errors, so `splitApiErrors` puts the server's own sentence in
 * the top-level `Notice`.
 *
 * ## The organization select, and what it says when it is not the whole list
 *
 * `organization_id` is a required foreign key, so it is a select filled from `GET /organizations` —
 * the same endpoint the organizations list uses, needing `organizations.view`, which the Super Admin
 * who can reach this route holds through `ALL`. `commonSchemas.pagination` caps `limit` at
 * `PAGINATION.MAX_LIMIT`, which is 100, so one page of 100 sorted by name is all a request can hold.
 *
 * It used to be fetched with `api.get`, which keeps the rows and discards `meta.pagination` — so past
 * 100 organizations the one the operator needed was simply absent, with nothing on screen to say so,
 * and they would conclude it had never been created. It is `api.page` now: the total is kept, a
 * filter box appears the first time the total exceeds the page, and `?q=` — which
 * `organizations.service.js` matches against name and code — reaches the rest. The same shape the
 * school picker on the New Principal screen already had.
 *
 * ## Platform scope is a second condition this screen cannot test
 *
 * `POST /schools` carries `requirePlatformScope()` *and* `requirePermission('schools.manage')`, and
 * the two are independent on purpose. `useAuth` exposes no platform-scope predicate — `can()` reads
 * the token's permission claim and nothing more — so the gate below is the permission alone, matching
 * the list screen's "Add school" button exactly. An organization admin granted `schools.manage` would
 * therefore see this form and be refused on submit with `PLATFORM_SCOPE_REQUIRED`, which is in
 * `EXPLAINED_CODES` and so renders as an explanation rather than a fault. Inventing a client-side
 * scope test to close that gap would mean guessing at a rule the token does not carry.
 */

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { splitApiErrors } from '@/lib/formErrors';
import {
  Field,
  Notice,
  SearchField,
  SelectField,
  SubmitButton,
  focusFirstInvalidField,
  FormActions,
  FormSection,
  FormSpan,
} from '@/components/form';
import { useToast } from '@/components/toast';
import { PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/** §9.2's three school states, mirroring `SCHOOL_STATUS` in `constants.js`. */
const STATUSES = ['active', 'suspended', 'archived'];

/** `PAGINATION.MAX_LIMIT`. Asking for more is a 422, not a bigger page — see the header. */
const ORGANIZATION_LIMIT = 100;

/** Every field this form has an input for, so `splitApiErrors` can send the rest to the banner. */
const RENDERED = new Set([
  'organization_id',
  'name',
  'code',
  'email',
  'phone',
  'address',
  'city',
  'state',
  'country',
  'status',
]);

/** Only what the select needs. The endpoint sends every `organizations` column; this reads three. */
interface OrganizationOption {
  id: number;
  name: string;
  code: string;
}

export default function NewSchoolPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const [values, setValues] = useState({
    organization_id: '',
    name: '',
    code: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    state: '',
    country: '',
    status: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [organizationsLoading, setOrganizationsLoading] = useState(true);
  const [organizationsError, setOrganizationsError] = useState<string | null>(null);
  const [organizationTotal, setOrganizationTotal] = useState(0);
  const [organizationFilter, setOrganizationFilter] = useState('');
  const [organizationQuery, setOrganizationQuery] = useState('');
  const [organizationRetry, setOrganizationRetry] = useState(0);
  /*
   * Latched, never cleared — the New Principal screen's school picker gives the reason. Recomputed
   * from each response, the filter box would vanish the moment a query narrowed the count under the
   * cap, which is to say in the middle of typing into it.
   */
  const [organizationsTruncated, setOrganizationsTruncated] = useState(false);
  const [chosenOrganization, setChosenOrganization] = useState<OrganizationOption | null>(null);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  /* The inline 300 ms debounce every search box here uses: `q` reaches a `LIKE` scan. */
  useEffect(() => {
    const timer = setTimeout(() => setOrganizationQuery(organizationFilter), 300);
    return () => clearTimeout(timer);
  }, [organizationFilter]);

  useEffect(() => {
    const controller = new AbortController();
    setOrganizationsLoading(true);
    setOrganizationsError(null);

    (async () => {
      try {
        /*
         * `api.page`, not `api.get`: the total is the whole point — see the header. Sorted by name
         * because a dropdown is scanned alphabetically rather than by insertion date, and `name` is in
         * the service's `SORTABLE` allow-list, so the server will honour it instead of silently
         * falling back to `created_at DESC`.
         */
        const result = await api.page<OrganizationOption[]>('/organizations', {
          query: {
            limit: ORGANIZATION_LIMIT,
            sortBy: 'name',
            sortOrder: 'asc',
            q: organizationQuery || undefined,
          },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const rows = result.data ?? [];
        setOrganizations(rows);
        setOrganizationTotal(result.meta?.total ?? rows.length);
        if (result.meta && result.meta.total > rows.length) setOrganizationsTruncated(true);
      } catch (caught) {
        if (controller.signal.aborted || (caught as Error)?.name === 'AbortError') return;
        setOrganizationsError(
          caught instanceof ApiError ? caught.message : 'Could not load the list of organizations.'
        );
      } finally {
        if (!controller.signal.aborted) setOrganizationsLoading(false);
      }
    })();

    return () => controller.abort();
  }, [organizationQuery, organizationRetry]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    /* Only what was filled in — see the exemplar on why empty strings are dropped rather than sent. */
    const body: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value.trim()) body[key] = value.trim();
    }

    /*
     * The schema is `Joi.number().integer().positive()` and the validator runs with `convert: true`,
     * so the digits would coerce either way. Sent as a number anyway: `logActivity` records the body,
     * and a foreign key stored there as text is a small lie about what was asked for.
     */
    if (values.organization_id) body.organization_id = Number(values.organization_id);

    try {
      await api.post('/schools', body);
      success('School created', 'Subscribe it to a plan before its staff sign in.');
      router.replace('/super-admin/schools');
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError) {
        /*
         * Whole-object rules, a message keyed to a field this form has no input for, and a 409 whose
         * `details` was an object (see the header) all have nowhere to sit but the top.
         * `splitApiErrors` sorts them there and leaves the rest beside their inputs.
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

  /*
   * Gated exactly as the list screen's "Add school" button is, and for the same reason. The header
   * records why this is the permission alone and not also a platform-scope test.
   */
  if (!can('schools.manage')) {
    return (
      <div>
        <PageHeader title="New school" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to create a school.',
          }}
        />
      </div>
    );
  }

  /*
   * "None exist" only when nothing narrowed the list. An empty result for a filter is a filter with no
   * match, and telling that operator to go and create an organization would be the wrong advice.
   */
  const noOrganizations =
    !organizationsLoading && !organizationsError && organizations.length === 0 && !organizationQuery;

  /*
   * The chosen organization stays among the options while the filter moves. Without this, narrowing
   * the list past the one already picked left the select showing its placeholder while the form
   * still held — and would post — an id the operator could no longer see.
   */
  const options =
    chosenOrganization && !organizations.some((row) => row.id === chosenOrganization.id)
      ? [chosenOrganization, ...organizations]
      : organizations;

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New school"
        description="Organization, name and code are required. Everything else can be filled in later."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="Ownership"
          description="The group this school belongs to. Every school sits under exactly one."
        >
          <div>
            {/*
              The filter appears once the server has reported more organizations than one page
              holds, and sits above the select because it is used first. A search box submits
              nothing, so it can carry no 422 and is not a second organization control.
            */}
            {organizationsTruncated ? (
              <SearchField
                id="organization-filter"
                label="Filter organizations"
                placeholder="Filter by organization name or code…"
                value={organizationFilter}
                onChange={setOrganizationFilter}
                className="mb-3"
              />
            ) : null}

            {/*
              `disabled` while the fetch is in flight or after it failed: nothing to choose is not the
              same as a choice not yet made, and an enabled control whose only option is the
              placeholder invites a submit that is guaranteed to come back 422.

              A 422 on this field is the one message `SelectField` carries; a failed fetch is said
              below the select instead, because it comes with a Try again button and `error` is a
              string. `SelectField` drops the hint whenever an error is showing, so the two never
              stack, and the hint is withheld while the fetch-failure line is up.
            */}
            <SelectField
              id="organization_id"
              width="md"
              label="Organization"
              required
              value={values.organization_id}
              onChange={(event) => {
                set('organization_id')(event);
                setChosenOrganization(
                  options.find((row) => String(row.id) === event.target.value) ?? null
                );
              }}
              error={fieldErrors.organization_id}
              hint={
                noOrganizations || organizationsError
                  ? undefined
                  : organizationsTruncated && !organizationsLoading
                    ? `Showing ${organizations.length} of ${organizationTotal} organizations — a page holds at most ${ORGANIZATION_LIMIT}. Filter above to reach the rest. A school cannot be moved to another organization afterwards.`
                    : 'A school belongs to one organization and cannot be moved to another afterwards.'
              }
              disabled={organizationsLoading || Boolean(organizationsError) || options.length === 0}
            >
              <option value="">
                {organizationsLoading
                  ? 'Loading organizations…'
                  : organizationsError
                    ? 'Organizations unavailable'
                    : options.length === 0
                      ? organizationQuery
                        ? 'No organization matches the filter'
                        : 'No organizations yet'
                      : 'Select an organization'}
              </option>
              {options.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name} ({organization.code})
                </option>
              ))}
            </SelectField>
            {!fieldErrors.organization_id && organizationsError ? (
              <p className="field-error mt-1.5">
                {organizationsError}{' '}
                <button
                  type="button"
                  onClick={() => setOrganizationRetry((attempt) => attempt + 1)}
                  className="underline underline-offset-2"
                >
                  Try again
                </button>
              </p>
            ) : null}
            {/*
              The one message that cannot become a `hint`: that prop is a `string`, and this sentence
              carries a link to the organization form. It keeps the hint's own class so it reads as the
              same line, and `hint` is withheld above whenever it shows, preserving the either/or of the
              branch chain it came from. `noOrganizations` already requires the fetch to have succeeded,
              so it cannot collide with `organizationsError`; only a field error outranks it.
            */}
            {noOrganizations && !fieldErrors.organization_id ? (
              <p className="field-hint mt-1.5">
                No organizations exist yet, and every school belongs to one.{' '}
                <Link href="/super-admin/organizations/new" className="underline underline-offset-2">
                  Create an organization
                </Link>{' '}
                first.
              </p>
            ) : null}
          </div>
        </FormSection>

        <FormSection
          columns={2}
          title="The school"
          description="Its name, and the code that identifies it within its organization."
        >
          <Field
            id="name"
            width="md"
            label="Name"
            required
            value={values.name}
            onChange={set('name')}
            error={fieldErrors.name}
            hint="2 to 180 characters."
          />

          <Field
            id="code"
            width="sm"
            label="Code"
            required
            value={values.code}
            onChange={set('code')}
            error={fieldErrors.code}
            hint="2 to 40 characters: letters, digits, hyphens and underscores, starting with a letter or digit. Stored in upper case, and unique within the organization rather than across the platform."
          />
        </FormSection>

        <FormSection
          columns={2}
          title="Contact and address"
          description="How the platform and other schools reach it."
        >
          <Field
            id="email"
            width="md"
            label="Email"
            type="email"
            value={values.email}
            onChange={set('email')}
            error={fieldErrors.email}
            hint="Up to 180 characters. Stored in lower case."
          />

          <Field
            id="phone"
            width="sm"
            label="Phone"
            value={values.phone}
            onChange={set('phone')}
            error={fieldErrors.phone}
            hint="Up to 40 characters."
          />

          <FormSpan>
            <Field
              id="address"
              label="Address"
              value={values.address}
              onChange={set('address')}
              error={fieldErrors.address}
              hint="Up to 255 characters."
            />
          </FormSpan>

          <Field
            id="city"
            width="sm"
            label="City"
            value={values.city}
            onChange={set('city')}
            error={fieldErrors.city}
            hint="Up to 90 characters."
          />

          <Field
            id="state"
            width="sm"
            label="State"
            value={values.state}
            onChange={set('state')}
            error={fieldErrors.state}
            hint="Up to 90 characters."
          />

          <Field
            id="country"
            width="sm"
            label="Country"
            value={values.country}
            onChange={set('country')}
            error={fieldErrors.country}
            hint="Up to 90 characters. Free text — the schema names no country list."
          />
        </FormSection>

        <FormSection
          title="Availability"
          description="Whether the school is live. A suspended school cannot sign in."
        >
          <SelectField
            id="status"
            width="sm"
            label="Status"
            value={values.status}
            onChange={set('status')}
            error={fieldErrors.status}
          >
            {/*
              Empty sends no `status` at all and lets the column's own NOT NULL default stand, rather
              than this screen naming it. `suspended` and `archived` are offered because the create
              schema accepts them — see the header — and hiding an enum value the API takes would be
              this form inventing a rule the source does not state.
            */}
            <option value="">Server default</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SelectField>
        </FormSection>

        <FormActions cancelHref="/super-admin/schools">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create school
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
