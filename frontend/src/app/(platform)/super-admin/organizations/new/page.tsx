'use client';

/**
 * Create an organization — SRS §10, checklist row 4.3, Known Issue 30.
 *
 * ## The exemplar for eighteen create screens
 *
 * Every list screen in the product rendered a permission-gated "Add …" button pointing at a `/new`
 * route that did not exist. Eighteen of them, and no `new` directory anywhere under `src/app`: the
 * product could read everything and create nothing. This is the first of those routes and the pattern
 * the rest follow, so the decisions are written down once here rather than seventeen times.
 *
 * ## The field set is the schema's, not a designer's
 *
 * `organizations.validation.js` `create` takes exactly `name`, `code`, `email`, `phone`, `address`,
 * `website`, `status` and `notes`, and marks only **`name`** and **`code`** `.required()`. This form
 * marks the same two and no others. Adding a required field the API does not require would invent a
 * rule; omitting an optional one the API accepts would hide a capability.
 *
 * `code` is `.uppercase()` server-side, so what is typed in lower case is stored upper. The hint says
 * so rather than rewriting the value as it is typed — a field that silently changes what you entered
 * is harder to trust than one that tells you what it will do.
 *
 * ## Empty optional fields are omitted, not sent as `""`
 *
 * The schema writes `.empty('')` on the optional strings, so an empty string would be coerced away
 * server-side and the request would succeed either way. They are still omitted here, because the
 * request that reaches the audit log should record what the user actually supplied.
 *
 * ## Errors come back per field
 *
 * `ApiError.fieldErrors()` maps the envelope's `details[]` onto the input each one names, so a 422
 * lands under the offending field rather than as one banner listing five problems. Anything without a
 * field of its own — a duplicate `code`, a refusal — stays at the top. Refusals use the shared
 * `EXPLAINED_CODES` set, so an entitlement or permission refusal reads the same here as on a list.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
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

/** §10's three organization states, mirroring `ORGANIZATION_STATUS` in `constants.js`. */
const STATUSES = ['active', 'suspended', 'archived'];

export default function NewOrganizationPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const [values, setValues] = useState({
    name: '',
    code: '',
    email: '',
    phone: '',
    address: '',
    website: '',
    status: '',
    notes: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    /* Only what was filled in. See the header on why empty strings are dropped rather than sent. */
    const body: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value.trim()) body[key] = value.trim();
    }

    try {
      await api.post('/organizations', body);
      /*
       * `replace`, not `push`: the created organization is on the list behind this screen, and leaving
       * the empty form in history means Back re-opens a form for a record that already exists.
       */
      success('Organisation created', 'Schools can now be added to it.');
      router.replace('/super-admin/organizations');
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError) {
        const perField = caught.fieldErrors();
        setFieldErrors(perField);
        focusFirstInvalidField();
        /*
         * A message with no field of its own — a duplicate code, say — has nowhere else to go, and
         * whole-object rules ("expires_at must be after starts_at") report with an empty field and
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
   * Gated exactly as the list screen's "Add organization" button is. A caller reaching this URL
   * without the permission would be refused by the API anyway; saying so before they fill in a form
   * is the better failure.
   */
  if (!can('organizations.manage')) {
    return (
      <div>
        <PageHeader title="New organization" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to create an organization.',
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New organization"
        description="Name and code are required. Everything else can be filled in later."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The organization"
          description="Its name and the code that identifies it across the platform."
        >
          <Field
            id="name"
            label="Name"
            required
            value={values.name}
            onChange={set('name')}
            error={fieldErrors.name}
          />

          <Field
            id="code"
            label="Code"
            required
            value={values.code}
            onChange={set('code')}
            error={fieldErrors.code}
            /*
             * Both rules `CODE_PATTERN` and `.min(2)` enforce, not just the character class: the hint
             * used to allow `-ACME` and a single character, and the schema refuses both.
             */
            hint="2 to 40 characters, starting with a letter or digit, then letters, digits, hyphens and underscores. Stored in upper case."
          />
        </FormSection>

        <FormSection
          title="Contact"
          description="How the platform reaches the organization."
          columns={2}
        >
          <Field
            id="email"
            label="Email"
            type="email"
            value={values.email}
            onChange={set('email')}
            error={fieldErrors.email}
          />

          <Field
            id="phone"
            label="Phone"
            value={values.phone}
            onChange={set('phone')}
            error={fieldErrors.phone}
          />

          <Field
            id="address"
            label="Address"
            value={values.address}
            onChange={set('address')}
            error={fieldErrors.address}
          />

          <Field
            id="website"
            label="Website"
            type="url"
            value={values.website}
            onChange={set('website')}
            error={fieldErrors.website}
            hint="Must start with http:// or https://"
          />
        </FormSection>

        <FormSection
          title="Status and notes"
          description="Whether the organization is active, and anything worth recording."
        >
          {/*
           * `SelectField` rather than a hand-rolled `<select>` with a loose `<p className="text-danger">`
           * beside it: the wrapper binds the label with `htmlFor` and points `aria-describedby` at the 422
           * message, so a rejected status reaches a screen reader at the control instead of as orphaned
           * text near it. `status` is optional in the schema, so no `required`.
           */}
          <SelectField
            id="status"
            label="Status"
            value={values.status}
            onChange={set('status')}
            error={fieldErrors.status}
          >
            {/* Empty means "let the server decide" rather than this screen naming a default §10 omits. */}
            <option value="">Server default</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SelectField>

          <TextAreaField
            id="notes"
            label="Notes"
            rows={4}
            value={values.notes}
            onChange={set('notes')}
            error={fieldErrors.notes}
          />
        </FormSection>

        <FormActions cancelHref="/super-admin/organizations">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create organization
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
