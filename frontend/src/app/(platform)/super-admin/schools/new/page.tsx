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
 * ## The 409 is unpacked by hand, and that guard is not cosmetic
 *
 * `ApiError.fieldErrors()` iterates `details` with `for…of`, which is right for the array `validate()`
 * builds for a 422. `schools.service.js` `rethrow()` raises its duplicate-code 409 with `details` as a
 * plain **object** — `{ code, organization_id }` — and `errorHandler.js:269` copies it to the wire
 * untouched. Calling `fieldErrors()` on that throws `TypeError: … is not iterable` from inside this
 * catch block, so the rejection escapes, `saving` is never cleared, and the button sticks on
 * "Creating…" with nothing on screen — for the single most likely failure this form has.
 *
 * The `Array.isArray` guard below is deliberately local to this page rather than a fix in
 * `apiClient.ts`: that client is shared by thirty screens and is not this change's to alter.
 * `SCHOOL_CODE_TAKEN` therefore lands in the top-level `Notice`, carrying the server's own sentence.
 *
 * ## The organization select, and the ceiling it has
 *
 * `organization_id` is a required foreign key, so it is a select filled from `GET /organizations` —
 * the same endpoint the organizations list uses, needing `organizations.view`, which the Super Admin
 * who can reach this route holds through `ALL`. `commonSchemas.pagination` caps `limit` at
 * `PAGINATION.MAX_LIMIT`, which is 100, so this asks for one page of 100 sorted by name. A platform
 * with more than 100 organizations would not find them all in this list. That is a real limit and it
 * is stated here rather than papered over, because the alternative — paging the whole table into a
 * dropdown on mount — is a worse thing to ship quietly.
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

/** §9.2's three school states, mirroring `SCHOOL_STATUS` in `constants.js`. */
const STATUSES = ['active', 'suspended', 'archived'];

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

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        /*
         * `api.get` unwraps the envelope to `data`, which for a paginated route is the row array —
         * `meta.pagination` is discarded, and it is not wanted: this is a one-page fetch by design.
         * Sorted by name because a dropdown is scanned alphabetically rather than by insertion date,
         * and `name` is in the service's `SORTABLE` allow-list, so the server will honour it instead
         * of silently falling back to `created_at DESC`.
         */
        const rows = await api.get<OrganizationOption[]>('/organizations', {
          query: { limit: 100, sortBy: 'name', sortOrder: 'asc' },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setOrganizations(rows ?? []);
      } catch (caught) {
        if (controller.signal.aborted || (caught as Error)?.name === 'AbortError') return;
        setOrganizationsError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not load the list of organizations. Reload the page to try again.'
        );
      } finally {
        if (!controller.signal.aborted) setOrganizationsLoading(false);
      }
    })();

    return () => controller.abort();
  }, []);

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
         * See the header: this endpoint's 409 carries `details` as an object, which `fieldErrors()`
         * cannot walk. Anything not shaped like the 422's array is sent to the banner instead.
         */
        const perField = Array.isArray(caught.details) ? caught.fieldErrors() : {};
        setFieldErrors(perField);
        focusFirstInvalidField();
        /*
         * Whole-object rules ("expires_at must be after starts_at") report with an empty field and
         * belong at the top; `formErrors()` returns exactly those. Without them a rejected submit
         * showed nothing at all — the message went to a key no input renders.
         */
        const formLevel = caught.formErrors();
        setError(
          formLevel.length
            ? formLevel.join(' ')
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

  const noOrganizations = !organizationsLoading && !organizationsError && organizations.length === 0;

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
              `disabled` while the fetch is in flight or after it failed: nothing to choose is not the
              same as a choice not yet made, and an enabled control whose only option is the
              placeholder invites a submit that is guaranteed to come back 422.

              Both failures share the field's single message slot, in the order the hand-rolled
              paragraphs used to walk: a 422 on this field wins, and a fetch that failed leaves nothing
              to pick from, so it is this control's problem rather than a note floating beside it.
              `SelectField` drops the hint whenever an error is showing, so the two never stack.
            */}
            <SelectField
              id="organization_id"
              label="Organization"
              required
              value={values.organization_id}
              onChange={set('organization_id')}
              error={fieldErrors.organization_id || organizationsError}
              hint={
                noOrganizations
                  ? undefined
                  : 'A school belongs to one organization and cannot be moved to another afterwards.'
              }
              disabled={organizationsLoading || organizations.length === 0}
            >
              <option value="">
                {organizationsLoading ? 'Loading organizations…' : 'Select an organization'}
              </option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name} ({organization.code})
                </option>
              ))}
            </SelectField>
            {/*
              The one message that cannot become a `hint`: that prop is a `string`, and this sentence
              carries a link to the organization form. It keeps the hint's own class so it reads as the
              same line, and `hint` is withheld above whenever it shows, preserving the either/or of the
              branch chain it came from. `noOrganizations` already requires the fetch to have succeeded,
              so it cannot collide with `organizationsError`; only a field error outranks it.
            */}
            {noOrganizations && !fieldErrors.organization_id ? (
              <p className="field-hint mt-1.5">
                No organizations exist yet, and FR-SADMIN-002 makes one the precondition for a school.{' '}
                <a href="/super-admin/organizations/new" className="underline underline-offset-2">
                  Create an organization
                </a>{' '}
                first.
              </p>
            ) : null}
          </div>
        </FormSection>

        <FormSection
          title="The school"
          description="Its name and the code that identifies it across the platform."
        >
          <Field
            id="name"
            label="Name"
            required
            value={values.name}
            onChange={set('name')}
            error={fieldErrors.name}
            hint="2 to 180 characters."
          />

          <Field
            id="code"
            label="Code"
            required
            value={values.code}
            onChange={set('code')}
            error={fieldErrors.code}
            hint="2 to 40 characters: letters, digits, hyphens and underscores, starting with a letter or digit. Stored in upper case, and unique within the organization rather than across the platform."
          />
        </FormSection>

        <FormSection
          title="Contact and address"
          description="How the platform and other schools reach it."
        >
          <Field
            id="email"
            label="Email"
            type="email"
            value={values.email}
            onChange={set('email')}
            error={fieldErrors.email}
            hint="Up to 180 characters. Stored in lower case."
          />

          <Field
            id="phone"
            label="Phone"
            value={values.phone}
            onChange={set('phone')}
            error={fieldErrors.phone}
            hint="Up to 40 characters."
          />

          <Field
            id="address"
            label="Address"
            value={values.address}
            onChange={set('address')}
            error={fieldErrors.address}
            hint="Up to 255 characters."
          />

          <Field
            id="city"
            label="City"
            value={values.city}
            onChange={set('city')}
            error={fieldErrors.city}
            hint="Up to 90 characters."
          />

          <Field
            id="state"
            label="State"
            value={values.state}
            onChange={set('state')}
            error={fieldErrors.state}
            hint="Up to 90 characters."
          />

          <Field
            id="country"
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
