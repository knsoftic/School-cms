'use client';

/**
 * Put a school on a plan — SRS §12, FR-SUB-010, Known Issue 30.
 *
 * Follows `super-admin/organizations/new/page.tsx`, which is where the shared decisions are argued.
 * Only what is different about *this* create is written down here.
 *
 * ## The field set is the schema's
 *
 * `subscriptions.validation.js` `create` takes `school_id`, `plan_id`, `plan_price_id`,
 * `billing_cycle`, `quantity`, `starts_at`, `trial_days`, `grace_period_days`, `renewal_mode`,
 * `reason` and `metadata`, and marks only **`school_id`** and **`plan_id`** `.required()`. Its own
 * comment says why: *"neither side of it can be inferred"*, and everything else has a defensible
 * default in `subscriptions.service.create()` — the plan's trial and grace lengths, its
 * `default_renewal_mode`, its default price, `starts_at` of now, `quantity` of 1.
 *
 * That schema also **forbids** some thirty columns by name rather than stripping them, `state` above
 * all. None of them appear below; a form control for one would be a control whose only outcome is a
 * 422 explaining where the value really comes from.
 *
 * ## Blank and `0` are different answers for the trial
 *
 * The one place the schema's shape is genuinely surprising. `trial_days` blank inherits the plan's
 * length; `trial_days: 0` is an explicit refusal of a trial, and the service reads the difference as
 * the difference between a subscription born in Trial and one born Pending. So the control is a
 * number input where empty means "inherit", not a select with a "no trial" option that would have to
 * pick one of the two to stand for.
 *
 * ## Why the numeric fields are posted as the strings that were typed
 *
 * `validate()` runs Joi with `convert: true`, so `"25"` arrives as `25`. Coercing with `Number()`
 * here would turn anything unparseable into `NaN`, which `JSON.stringify` writes as `null` — and the
 * 422 would then complain about a value the user never entered. Sent as typed, the server's message
 * is about the server's own reading of the input.
 *
 * Empty values are omitted rather than sent as `""`, including the two required ones: an omitted
 * `school_id` fails as *"school_id is required"*, where `""` fails as *"must be a number"*. Same
 * refusal, and the first one names the actual problem.
 *
 * ## `fieldErrors()` is guarded, because this endpoint answers with two shapes of `details`
 *
 * A 422 carries `details` as the array of `{ field, message }` that `ApiError.fieldErrors()` walks.
 * But `create()` also throws conflicts — `SCHOOL_ALREADY_SUBSCRIBED` when the school already holds an
 * open subscription, `PLAN_NOT_AVAILABLE` when the plan is not active — and `ApiError.conflict()`
 * hands those an **object** (`{ subscriptionId, state }`). `fieldErrors()` iterates with `for…of`,
 * which throws on an object, and it would throw *inside this catch block*: the button would stay on
 * "Creating…" with nothing on screen, for the single most likely operator mistake on the page.
 * Hence the `Array.isArray` test before calling it. Guarded here rather than in `apiClient.ts`,
 * which is shared with seventeen other screens and is not this file's to change.
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

/** §10.3's seven billing cycles, mirroring `BILLING_CYCLES` in `constants.js`. */
const BILLING_CYCLES = [
  'weekly',
  'monthly',
  'quarterly',
  'six_months',
  'yearly',
  'custom_days',
  'one_time',
];

/** §12.5's two renewal modes, mirroring `RENEWAL_MODES`. */
const RENEWAL_MODES = ['manual', 'automatic'];

/**
 * The page size every list endpoint caps at.
 *
 * `PAGINATION.MAX_LIMIT` is 100 and `commonSchemas.pagination` enforces it, so asking for more is a
 * 422 rather than a longer list. Both pickers below are therefore first-page-only, and the school
 * one says so when it is full.
 */
const OPTION_LIMIT = 100;

/** A school as `GET /schools` returns it; only the columns the picker reads are declared. */
interface SchoolOption {
  id: number;
  name: string;
  code: string;
  /** `schools.subscription_state` — *"cached from the school's active subscription"*. */
  subscription_state: string | null;
}

interface PlanOption {
  id: number;
  name: string;
  code: string;
}

/**
 * One `plan_prices` row, from `GET /plans/:id`.
 *
 * No amount is declared, and that is deliberate. A price row carries `base_amount`, `unit_amount`,
 * `custom_amount` and `included_units`, and which of them is charged depends on its `pricing_model`
 * and on the quantity — `subscriptions.service.pricingColumns()` is the one place that decides. A
 * figure rendered in this dropdown would be a second implementation of that calculation, free to
 * disagree with what the subscription is actually billed.
 */
interface PriceOption {
  id: number;
  billing_cycle: string;
  cycle_days: number | null;
  pricing_model: string;
  currency: string;
  is_active: boolean;
  is_default: boolean;
}

interface PlanDetail {
  prices?: PriceOption[] | null;
}

/** Enum values are stored `snake_case` and read as words. */
function humanise(value: string): string {
  return value.replace(/_/g, ' ');
}

export default function NewSubscriptionPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const [values, setValues] = useState({
    school_id: '',
    plan_id: '',
    plan_price_id: '',
    billing_cycle: '',
    quantity: '',
    starts_at: '',
    trial_days: '',
    grace_period_days: '',
    renewal_mode: '',
    reason: '',
    metadata: '',
  });

  const [schools, setSchools] = useState<SchoolOption[]>([]);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [prices, setPrices] = useState<PriceOption[]>([]);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [pricesError, setPricesError] = useState<string | null>(null);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  /*
   * The two required ids are foreign keys, so they are pickers rather than number boxes.
   *
   * Plans are narrowed to `status=active`: `loadSubscribablePlan()` refuses anything else with a 409
   * naming FR-SUB-004, so an inactive plan in this list would be an offer the API will not honour.
   * Schools are **not** narrowed — `create()` checks only that the school exists and holds no open
   * subscription, and neither of those is a `/schools` filter. Deciding here which schools may be
   * subscribed would be this screen inventing a rule the module does not have.
   *
   * Plans keep the server's own order (`display_order`), which SRS §10.2 calls Display Order and
   * `plans.service.js` calls *"the order its author arranged it"*. Schools have no such order, so
   * they are sorted by name.
   */
  useEffect(() => {
    let live = true;

    (async () => {
      try {
        const [schoolRows, planRows] = await Promise.all([
          api.get<SchoolOption[]>('/schools', {
            query: { limit: OPTION_LIMIT, sortBy: 'name', sortOrder: 'asc' },
          }),
          api.get<PlanOption[]>('/plans', { query: { limit: OPTION_LIMIT, status: 'active' } }),
        ]);
        if (!live) return;
        setSchools(schoolRows ?? []);
        setPlans(planRows ?? []);
      } catch (caught) {
        if (!live) return;
        /*
         * Reported rather than swallowed. These lists need `schools.view` and `plans.view`, which are
         * separate keys from the `subscriptions.manage` that opened this screen — a role holding only
         * the latter arrives to two empty dropdowns, and an empty dropdown does not say why.
         */
        setOptionsError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not load the school and plan lists. Check your connection and try again.'
        );
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  /*
   * Prices hang off the plan, not off a list endpoint of their own.
   *
   * There is no `/plan-prices`; `plan_prices` rows are reachable only through `GET /plans/:id`, whose
   * `DETAIL_INCLUDE` carries them ordered by `display_order`. So this fetch waits for a plan and
   * re-runs when it changes. Inactive rows are dropped because `selectPrice()` refuses an inactive
   * price named explicitly — `is_active = false` is how `/plans` retires an offer that a live
   * subscription still points at, and re-offering it here would resurrect it.
   */
  useEffect(() => {
    if (!values.plan_id) {
      setPrices([]);
      setPricesError(null);
      return;
    }

    let live = true;
    setPricesError(null);

    (async () => {
      try {
        const detail = await api.get<{ plan: PlanDetail | null }>(`/plans/${values.plan_id}`);
        if (!live) return;
        setPrices((detail.plan?.prices ?? []).filter((price) => price.is_active));
      } catch (caught) {
        if (!live) return;
        setPrices([]);
        setPricesError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not load this plan’s prices. Leaving the price blank lets the server pick one.'
        );
      }
    })();

    return () => {
      live = false;
    };
  }, [values.plan_id]);

  function onPlanChange(event: { target: { value: string } }) {
    /*
     * The price is cleared with the plan. `selectPrice()` requires the named price to belong to the
     * named plan, so a selection carried across from the previous plan is a guaranteed 422 — and one
     * the operator cannot see coming, because the dropdown that held it has already been repopulated.
     */
    setValues((prev) => ({ ...prev, plan_id: event.target.value, plan_price_id: '' }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    /* Only what was filled in — see the header on why the empty ones are dropped rather than sent. */
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (key === 'metadata') continue;
      const trimmed = value.trim();
      if (trimmed) body[key] = trimmed;
    }

    if (values.metadata.trim()) {
      /*
       * The one client-side rule on this screen, and it is a transport concern rather than a
       * duplicated validation: `metadata` is `Joi.object()`, the textarea holds text, and the text has
       * to become an object before it can be a JSON body at all. Everything the schema actually
       * constrains — at most 50 keys, key names to 120 characters — is left to the server, which is
       * why a parsed `[1, 2]` is posted rather than rejected here. *"must be of type object"* is the
       * API's answer to give.
       */
      try {
        body.metadata = JSON.parse(values.metadata) as unknown;
      } catch {
        setFieldErrors({
          metadata: 'This is not valid JSON. A JSON object looks like {"po_number": "X-1024"}.',
        });
        focusFirstInvalidField();
        setSaving(false);
        return;
      }
    }

    try {
      await api.post('/subscriptions', body);
      /* `replace`, not `push` — the exemplar's reason: Back would re-open a form already answered. */
      success('Subscription created', 'Check the invoice it generated.');
      router.replace('/super-admin/subscriptions');
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError) {
        /* `Array.isArray` first — the conflicts this endpoint throws carry an object. See the header. */
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
   * Gated exactly as the list screen's "Add subscription" button is.
   *
   * The route also carries `requirePlatformScope()`, which no permission claim can stand in for. A
   * school-scoped caller who somehow held `subscriptions.manage` would pass this check and be refused
   * by the API with `PLATFORM_SCOPE_REQUIRED` — which is in `EXPLAINED_CODES`, so it lands as a
   * refusal rather than a red error. Restating the scope rule here would be guessing at a decision
   * `resolveTenant` makes from the session, not from the token's permission list.
   */
  if (!can('subscriptions.manage')) {
    return (
      <div>
        <PageHeader title="New subscription" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to create a subscription.',
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New subscription"
        description="School and plan are required. Every other field falls back to the plan's own setting."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {optionsError ? <Notice tone="error">{optionsError}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="School and plan"
          description="Who is subscribing, and to what."
        >
          {/*
           * The truncation notice is a `hint` rather than a paragraph of its own, so `SelectField`
           * drops it the moment a 422 arrives — an error and a caveat stacked under one control were
           * two competing explanations of the same field.
           */}
          <SelectField
            id="school_id"
            label="School"
            required
            value={values.school_id}
            onChange={set('school_id')}
            error={fieldErrors.school_id}
            hint={
              schools.length === OPTION_LIMIT
                ? `The first ${OPTION_LIMIT} schools by name. A page cannot hold more, so a school past that has to be reached from the Schools screen.`
                : undefined
            }
          >
            <option value="">Choose a school</option>
            {schools.map((school) => (
              /*
               * The cached state is shown beside the name, never acted on. A school already holding an
               * open subscription is refused with `SCHOOL_ALREADY_SUBSCRIBED`, but which states count
               * as open is `OPEN_STATES` in the service, and disabling options from a cached string
               * here would be a second copy of that set, free to drift. Context, and the server still
               * decides.
               */
              <option key={school.id} value={school.id}>
                {school.name} ({school.code})
                {school.subscription_state ? ` — ${humanise(school.subscription_state)}` : ''}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="plan_id"
            label="Plan"
            required
            value={values.plan_id}
            onChange={onPlanChange}
            error={fieldErrors.plan_id}
            hint="Active plans only. FR-SUB-004 puts an inactive or archived plan out of reach of a new subscription."
          >
            <option value="">Choose a plan</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name} ({plan.code})
              </option>
            ))}
          </SelectField>

          {/*
           * Two things can put a red message under this control and only one of them is a 422, so the
           * three-way choice the markup used to make by hand is made in the `error` prop instead: a
           * field error first, then a failed price fetch, and the hint when neither is showing. Both
           * red messages now reach the select through `aria-describedby` rather than sitting beside
           * it as an unassociated paragraph.
           */}
          <SelectField
            id="plan_price_id"
            label="Price"
            value={values.plan_price_id}
            onChange={set('plan_price_id')}
            disabled={!values.plan_id}
            error={fieldErrors.plan_price_id ?? pricesError}
            hint="Left blank, the server takes the plan’s default active price, then its lowest display order."
          >
            <option value="">
              {values.plan_id ? 'The plan’s default price' : 'Choose a plan first'}
            </option>
            {prices.map((price) => (
              <option key={price.id} value={price.id}>
                {humanise(price.billing_cycle)}
                {price.cycle_days ? ` (${price.cycle_days} days)` : ''}
                {' · '}
                {humanise(price.pricing_model)}
                {' · '}
                {price.currency}
                {price.is_default ? ' · default' : ''}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="billing_cycle"
            label="Billing cycle"
            value={values.billing_cycle}
            onChange={set('billing_cycle')}
            error={fieldErrors.billing_cycle}
            hint="With no price chosen, this narrows which of the plan’s prices the server picks. Given alongside a price, the two must name the same cycle — the service refuses the pair rather than preferring one of them."
          >
            <option value="">From the chosen price</option>
            {BILLING_CYCLES.map((cycle) => (
              <option key={cycle} value={cycle}>
                {humanise(cycle)}
              </option>
            ))}
          </SelectField>
        </FormSection>

        <FormSection
          title="Term"
          description="How many seats, when it starts, and the trial and grace periods that apply."
        >
          <Field
            id="quantity"
            label="Quantity"
            type="number"
            min={1}
            max={1000000}
            step={1}
            value={values.quantity}
            onChange={set('quantity')}
            error={fieldErrors.quantity}
            hint="Seats or students, for the SRS §10.4 per-unit pricing models. Blank means 1."
          />

          {/*
           * A date, not a datetime, and that was measured rather than assumed. `Joi.date().iso()` reads
           * a bare `2026-09-05` as midnight UTC, but a `datetime-local` value such as
           * `2026-09-05T14:30` carries no offset and Joi resolves it in the **server's** timezone — so
           * the same form, filled in identically from two places, would write two different
           * `current_period_start` values and nothing in the response would say so.
           */}
          <Field
            id="starts_at"
            label="Start date"
            type="date"
            value={values.starts_at}
            onChange={set('starts_at')}
            error={fieldErrors.starts_at}
            hint="Blank starts it now. A past date is allowed, for a school already running on an agreed plan. Read as midnight UTC."
          />

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
            hint="Blank inherits the plan's trial length. 0 means no trial, and starts the subscription Pending rather than in Trial. SRS §12.1 offers 3, 7, 14 or 30 days, or any count up to 3650."
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
            hint="Blank inherits the plan's grace period. SRS §12.2 offers 1, 3, 7 or 15 days, or any count up to 3650."
          />

          <SelectField
            id="renewal_mode"
            label="Renewal mode"
            value={values.renewal_mode}
            onChange={set('renewal_mode')}
            error={fieldErrors.renewal_mode}
          >
            {/* Blank means the plan's `default_renewal_mode`, which this screen has no business naming. */}
            <option value="">The plan’s default</option>
            {RENEWAL_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </SelectField>
        </FormSection>

        <FormSection
          title="Internal notes"
          description="Kept on the subscription record and its audit entry."
        >
          <Field
            id="reason"
            label="Reason"
            maxLength={255}
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            hint="Up to 255 characters. Kept as the notes on this subscription's created history entry."
          />

          <TextAreaField
            id="metadata"
            label="Metadata"
            rows={4}
            value={values.metadata}
            onChange={set('metadata')}
            placeholder='{"po_number": "X-1024"}'
            error={fieldErrors.metadata}
            hint="A JSON object, up to 50 keys. Leave it blank unless something outside the system needs to find this subscription by a reference of its own."
          />
        </FormSection>

        <FormActions cancelHref="/super-admin/subscriptions">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create subscription
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
