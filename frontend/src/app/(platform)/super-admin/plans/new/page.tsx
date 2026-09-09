'use client';

/**
 * Create a plan — SRS §10.2 (Plan Builder), FR-SUB-001, checklist row 4.3, Known Issue 30.
 *
 * Follows the organizations create screen, which is the pattern for all eighteen `/new` routes and
 * carries the reasoning for the shared parts — per-field 422s, omitted empty optionals, `replace`
 * rather than `push`. Only what is different about plans is written down here.
 *
 * ## There is no status control, and that is the point
 *
 * The organizations form has one. This one must not: `plans.validation.js` `create` does not accept
 * `status` at all, and `plans.service.create()` writes `PLAN_STATUS.INACTIVE` over whatever the column
 * default says. The reason is in the validation header — a plan created `active` is, in FR-SUB-004's
 * own words, *"available for new subscriptions"* while holding no `plan_prices` row to bill against
 * and no `plan_limits` rows, which `entitlementService` resolves to **zero** rather than to unlimited.
 * It would be advertised, unsellable, and forbid everything to any school that reached it.
 *
 * §10.2's sequence is create → configure → activate, and FR-SUB-004 is the only way a plan becomes
 * available. This screen is only the first step, which is why it says so under the title instead of
 * offering a status the API would refuse.
 *
 * ## The create schema is narrower than the edit schema is narrower than the table
 *
 * Ten fields, with `name` and `code` `.required()`. Everything the Plan Builder is really made of —
 * prices (FR-SUB-006), modules and features (§11.1), limits (§11.2) — lives behind its own `PUT` with
 * its own permission key, and none of it is reachable from `POST /plans`. A price control here would
 * invent an endpoint.
 *
 * ## `can('plans.manage')` is the weaker of the route's two guards
 *
 * `POST /plans` sits behind `requirePlatformScope()` *and* `requirePermission('plans.manage')`, because
 * `subscription_plans` has no `school_id` — a plan is offered to the whole platform, so creating one is
 * a cross-tenant write. `can()` reads permission grants and cannot see scope, so a school-scoped
 * account that somehow held `plans.manage` would pass the gate below and be refused by the API with
 * `PLATFORM_SCOPE_REQUIRED`. That code is in `EXPLAINED_CODES`, so it lands in `RefusalNotice` with an
 * explanation rather than as a red banner reading like a fault. Gating on the permission alone here is
 * therefore honest about what the client actually knows.
 *
 * ## A blank number is not zero
 *
 * `display_order`, `trial_days`, `grace_period_days` and `tier_rank` all default to `0` in the column,
 * so leaving one blank and typing `0` reach the same row. They are still omitted when blank, on the
 * exemplar's reasoning: the audit snapshot should record the numbers someone chose, not four the form
 * filled in on their behalf.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import {
  CheckboxField,
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

/** §10.2's Public/Private, mirroring `PLAN_VISIBILITY` in `constants.js`. */
const VISIBILITIES = ['public', 'private'];

/** §12.5's two renewal modes, mirroring `RENEWAL_MODES`. */
const RENEWAL_MODES = ['manual', 'automatic'];

/**
 * The four `Joi.number().integer()` fields.
 *
 * `validate.js` runs bodies with `convert: true`, so the strings these inputs hold would be coerced
 * server-side either way. They are converted here because the body is JSON and JSON has numbers —
 * leaning on the coercion would make the request depend on a setting made for query strings.
 */
const NUMERIC_FIELDS = new Set(['display_order', 'trial_days', 'grace_period_days', 'tier_rank']);

export default function NewPlanPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const [values, setValues] = useState({
    name: '',
    code: '',
    description: '',
    visibility: '',
    trial_days: '',
    grace_period_days: '',
    default_renewal_mode: '',
    display_order: '',
    tier_rank: '',
  });
  /*
   * Held apart from `values` rather than as the string `'true'`, because a checkbox has no third state
   * to stand for "unset" the way a select's empty option does — unticked *is* the answer.
   */
  const [isRecommended, setIsRecommended] = useState(false);
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

    /* Only what was filled in. See the header on why blank numbers are dropped rather than sent as 0. */
    const body: Record<string, string | number | boolean> = {};
    for (const [key, raw] of Object.entries(values)) {
      const value = raw.trim();
      if (!value) continue;
      body[key] = NUMERIC_FIELDS.has(key) ? Number(value) : value;
    }
    /* The column defaults to false, so an unticked box and an absent key produce the same plan. */
    if (isRecommended) body.is_recommended = true;

    try {
      await api.post('/plans', body);
      /*
       * `replace`, not `push`: the created plan is on the list behind this screen, and leaving the
       * empty form in history means Back re-opens a form for a record that already exists.
       */
      success('Plan created', 'Configure its modules, limits and prices before selling it.');
      router.replace('/super-admin/plans');
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
   * Gated exactly as the list screen's "New plan" button is. The header covers the second guard, which
   * the client cannot check for itself.
   */
  if (!can('plans.manage')) {
    return (
      <div>
        <PageHeader title="New plan" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to create a plan.',
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New plan"
        description="Name and code are required. The plan is created inactive — configure its pricing, modules and limits, then activate it to offer it for new subscriptions."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The plan"
          description="Its name, code and description — what a school sees when choosing."
        >
          <Field
            id="name"
            label="Name"
            required
            value={values.name}
            onChange={set('name')}
            error={fieldErrors.name}
            hint="2 to 160 characters."
          />

          <Field
            id="code"
            label="Code"
            required
            value={values.code}
            onChange={set('code')}
            error={fieldErrors.code}
            hint="2 to 60 characters, starting with a letter or digit. Letters, digits, hyphens and underscores only. Stored in upper case."
          />

          <TextAreaField
            id="description"
            label="Description"
            rows={4}
            value={values.description}
            onChange={set('description')}
            error={fieldErrors.description}
            hint="Up to 5,000 characters. The plans list searches it alongside name and code."
          />
        </FormSection>

        <FormSection
          title="Availability"
          description="Who can see the plan, and the trial and grace periods it comes with."
        >
          <SelectField
            id="visibility"
            label="Visibility"
            value={values.visibility}
            onChange={set('visibility')}
            error={fieldErrors.visibility}
            hint="A private plan is withheld from every caller outside the platform, so it is the shape for a rate negotiated with one school."
          >
            {/* Empty means "let the server decide" rather than this screen naming a default §10.2 omits. */}
            <option value="">Server default</option>
            {VISIBILITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SelectField>

          <Field
            id="trial_days"
            label="Trial days"
            type="number"
            min={0}
            max={3650}
            step={1}
            value={values.trial_days}
            onChange={set('trial_days')}
            error={fieldErrors.trial_days}
            hint="0 to 3,650. Zero means no trial, not an unset one."
          />

          <Field
            id="grace_period_days"
            label="Grace period days"
            type="number"
            min={0}
            max={3650}
            step={1}
            value={values.grace_period_days}
            onChange={set('grace_period_days')}
            error={fieldErrors.grace_period_days}
            hint="0 to 3,650. How long an unpaid subscription keeps working (SRS §12.2)."
          />

          <SelectField
            id="default_renewal_mode"
            label="Default renewal mode"
            value={values.default_renewal_mode}
            onChange={set('default_renewal_mode')}
            error={fieldErrors.default_renewal_mode}
            hint="What a subscription on this plan starts out renewing by (SRS §12.5)."
          >
            <option value="">Server default</option>
            {RENEWAL_MODES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SelectField>
        </FormSection>

        <FormSection
          title="Placement"
          description="Where the plan sits in the list, and whether it is the one recommended."
        >
          <Field
            id="display_order"
            label="Display order"
            type="number"
            min={0}
            max={100000}
            step={1}
            value={values.display_order}
            onChange={set('display_order')}
            error={fieldErrors.display_order}
            hint="0 to 100,000. The catalogue is listed in ascending order, so a lower number comes first."
          />

          <Field
            id="tier_rank"
            label="Tier rank"
            type="number"
            min={0}
            max={10000}
            step={1}
            value={values.tier_rank}
            onChange={set('tier_rank')}
            error={fieldErrors.tier_rank}
            hint="0 to 10,000. Higher is a higher tier — this is what tells an upgrade from a downgrade (SRS §12.3, §12.4)."
          />

          {/*
           * This was the last hand-rolled control on the form, and it stayed that way for a real
           * reason: `CheckboxField` took a `hint` and no `error`, so moving it here would have
           * *dropped* `fieldErrors.is_recommended` rather than associating it. The wrapper has grown
           * the `error` prop, so the reason is gone and so is the exception.
           */}
          <CheckboxField
            id="is_recommended"
            label="Recommended"
            checked={isRecommended}
            onChange={(event) => setIsRecommended(event.target.checked)}
            error={fieldErrors.is_recommended}
            hint="Marks this as the plan the catalogue points schools at. Nothing at the database level stops a second plan carrying it, so check the list before ticking it."
          />
        </FormSection>

        <FormActions cancelHref="/super-admin/plans">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create plan
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
