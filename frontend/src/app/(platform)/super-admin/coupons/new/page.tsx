'use client';

/**
 * Create a coupon — SRS §13.4, FR-BILL-005, Known Issue 30.
 *
 * Follows `super-admin/organizations/new/page.tsx`, which is the pattern for all eighteen create
 * screens. Only what is specific to coupons is written down here.
 *
 * ## The field set is the create schema's
 *
 * `coupons.validation.js` `create` marks three fields `.required()` unconditionally — **`code`**,
 * **`discount_type`** and **`discount_value`** — and a fourth, **`currency`**, only when
 * `discount_type` is `fixed_amount`. Everything else it names is optional and is on this form,
 * including the two §13.4 restriction lists: an optional field the API accepts and the UI omits is a
 * capability the product does not have.
 *
 * `used_count` and `created_by` are `forbidden()` in the schema — not merely absent — so they have no
 * control here and are never sent. `reason` is in the module's `fields` object but is *not* in the
 * `create` schema, and `validate.js` runs bodies with `stripUnknown`, so sending it would be silently
 * dropped and answered 200. It is left off rather than shipped as a field that does nothing.
 *
 * ## `currency` is required for one type and forbidden for the other
 *
 * The column comment is *"Required for fixed_amount"*, and `checkCoherence()` refuses it on a
 * percentage coupon on the grounds that a percentage discount is currency-agnostic. So the input
 * appears and disappears with the type, **and the value is dropped from the body when the type is
 * percentage** — typing USD, then changing the type, would otherwise post a field that is no longer
 * on screen and get a 422 pointing at nothing.
 *
 * `max_discount_amount` stays visible for both types, because the schema accepts it for both. On a
 * percentage coupon it is a cap with no currency of its own, compared against whatever the invoice is
 * denominated in — the validation header says so explicitly, and the hint repeats it.
 *
 * ## Two errors that arrive with no field, and one that arrives with no field list
 *
 *   * `checkCoherence()` is a `.custom()` on the **whole object**, so its two messages — the
 *     `expires_at`/`starts_at` ordering and the currency rule — carry an empty Joi path. `validate.js`
 *     writes that out as `field: ''`, which matches no input on this form. Handled explicitly: a
 *     detail with no field is promoted to the top-level `Notice` instead of being counted as a field
 *     error and then rendered nowhere.
 *   * `error.details` is **not always an array**. `errorHandler.js` copies through whatever the
 *     thrower passed, and the two failures most likely on this screen pass an object:
 *     `COUPON_CODE_TAKEN` (409) sends `{ code, couponId }` and `COUPON_RESTRICTION_UNKNOWN_PLAN` /
 *     `_SCHOOL` (422) send `{ planIds, found }`. `ApiError.fieldErrors()` iterates `details`, so
 *     calling it on one of those throws out of the catch block and leaves the button stuck on
 *     "Creating…". It is therefore reached only behind `Array.isArray`, and those refusals land in the
 *     top-level notice where their message is already a complete sentence.
 *
 * ## Numbers and dates are converted here, carefully
 *
 * Five fields are `Joi.number()`. `Number('')` is `0` and `Number('abc')` is `NaN`, and
 * `JSON.stringify` writes `NaN` as `null` — which several of these columns accept as a *meaning*
 * (`max_uses: null` is "unlimited", `max_discount_amount: null` is "no cap"). A mistyped cap would
 * therefore save silently as no cap at all. Blanks are omitted like every other field, and anything
 * unparseable is passed through as text so the server answers 422 under the input that holds it.
 *
 * `starts_at` and `expires_at` are `DATE` columns fed by `datetime-local`, which yields a zoneless
 * `2026-01-31T23:59`. Sent as typed, that is read in the *server's* zone rather than the operator's,
 * so an expiry set for end of day lands hours out. Each is converted to an instant before sending.
 *
 * ## The two restriction lists are pickers, not id boxes
 *
 * `restricted_plan_ids` and `restricted_school_ids` are arrays of ids that must already exist —
 * `coupons.service.assertRestrictionsExist()` refuses the create otherwise — so they are multi-selects
 * fed from `/plans` and `/schools`. Both list endpoints need no parameter this screen cannot supply;
 * they are capped at `PAGINATION.MAX_LIMIT`, so when more rows exist than one page holds the picker
 * says so rather than quietly hiding the plan the operator was looking for. A list that fails to load
 * (`plans.view` / `schools.view` are separate grants from `coupons.manage`) is replaced by a sentence
 * saying the restriction cannot be set here — an empty select would read as "there are none".
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
/* A `datetime-local` value as an instant. See the header on why the zoneless form is not sent. */
import { isoInstant } from '@/lib/instants';
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
  MultiSelectField,
} from '@/components/form';
import { useToast } from '@/components/toast';
import { PageHeader, RefusalNotice } from '@/components/table';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/** `config/constants.js` COUPON_TYPES. */
const PERCENTAGE = 'percentage';
const FIXED_AMOUNT = 'fixed_amount';

/**
 * `config/constants.js` COUPON_STATUS, minus the one an operator may not set.
 *
 * `expired` is deliberately absent: `coupons.validation.js` restricts `status` to these two, because
 * `expired` is a fact about `expires_at` and the clock that `expireLapsed()` writes. `inactive` is the
 * switch for "stop honouring this now".
 */
const SETTABLE_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

/** `PAGINATION.MAX_LIMIT` — the most `commonSchemas.pagination` will accept in one page. */
const OPTION_LIMIT = 100;

/** A row from `/plans` or `/schools`; both presenters carry these three columns. */
interface Option {
  id: number;
  name: string;
  code: string;
}

/** One restriction picker: still loading, unreachable, or the rows plus how many exist in total. */
type Picker =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; rows: Option[]; total: number };

/**
 * A number for the body, or the raw text when it is not one.
 *
 * See the header: converting an unparseable entry would post `null`, and `null` means "unlimited" or
 * "no cap" on four of these five columns rather than "invalid".
 */
function numeric(text: string): number | string {
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : text;
}


/**
 * One of the two §13.4 restriction lists.
 *
 * Extracted because the plan list and the school list differ only in their labels and their endpoint,
 * and the three states each has to render are the part worth getting right once.
 */
function RestrictionField({
  id,
  label,
  noun,
  picker,
  selected,
  onChange,
  error,
}: {
  id: string;
  label: string;
  /** Singular, for the three sentences below; both of these pluralise with an `s`. */
  noun: string;
  picker: Picker;
  selected: number[];
  onChange: (ids: number[]) => void;
  error?: string;
}) {
  const unrestricted = `Select none to let the coupon apply to every ${noun}.`;

  /*
   * Two states have no select to show, and they mean opposite things — "we could not ask" versus
   * "there are none". A single empty listbox would read as the second in both cases.
   */
  if (picker.state === 'failed' || (picker.state === 'ready' && picker.rows.length === 0)) {
    return (
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-1 text-sm text-muted">
          {picker.state === 'failed'
            ? `The ${noun} list could not be loaded, so ${noun} restrictions cannot be set here. The coupon will apply to every ${noun}.`
            : `No ${noun}s have been created yet, so there is nothing to restrict the coupon to.`}
        </p>
      </div>
    );
  }

  const rows = picker.state === 'ready' ? picker.rows : [];
  const truncated = picker.state === 'ready' && picker.total > picker.rows.length;

  /*
   * A checkbox list, not `<select multiple>`. Picking a second plan in the native control needs
   * ctrl-click — undiscoverable, and unavailable on a touch device, where the browser's own picker
   * often reduces the whole thing to a single choice without saying so. Restricting a coupon to
   * three plans was effectively impossible on a tablet.
   */
  return (
    <MultiSelectField<number>
      id={id}
      label={label}
      disabled={picker.state === 'loading'}
      selected={selected}
      onChange={onChange}
      options={rows.map((row) => ({ value: row.id, label: row.name, hint: row.code }))}
      emptyLabel={picker.state === 'loading' ? 'Loading…' : `No ${noun}s to choose from.`}
      error={error}
      /* One sentence rather than two stacked paragraphs: the error replaces the hint, so the
         truncation warning has to travel inside the "select none" line. */
      hint={
        unrestricted +
        (truncated
          ? ` Showing the first ${picker.rows.length} of ${picker.total} — anything beyond that cannot be picked here.`
          : '')
      }
    />
  );
}

export default function NewCouponPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const [values, setValues] = useState({
    code: '',
    name: '',
    description: '',
    discount_type: '',
    discount_value: '',
    currency: '',
    max_discount_amount: '',
    min_order_amount: '',
    starts_at: '',
    expires_at: '',
    max_uses: '',
    max_uses_per_school: '',
    status: '',
  });
  const [planIds, setPlanIds] = useState<number[]>([]);
  const [schoolIds, setSchoolIds] = useState<number[]>([]);
  const [plans, setPlans] = useState<Picker>({ state: 'loading' });
  const [schools, setSchools] = useState<Picker>({ state: 'loading' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  useEffect(() => {
    /*
     * The permission gate below is a `return` *after* the hooks, so without this the two lists would
     * still be fetched for a caller who is about to be told no. `can` is `useCallback`-memoized on the
     * profile in `AuthProvider`, so naming it in the deps does not re-run this on every render.
     */
    if (!can('coupons.manage')) return;

    let cancelled = false;

    /* `api.page` rather than `api.get`: `meta.pagination.total` is what tells the picker it is short. */
    async function load(path: string, apply: (picker: Picker) => void) {
      try {
        const page = await api.page<Option[]>(path, { query: { limit: OPTION_LIMIT } });
        if (!cancelled) {
          apply({ state: 'ready', rows: page.data, total: page.meta?.total ?? page.data.length });
        }
      } catch {
        /* Which failure it was does not change the remedy — the restriction cannot be set here. */
        if (!cancelled) apply({ state: 'failed' });
      }
    }

    void load('/plans', setPlans);
    void load('/schools', setSchools);

    return () => {
      cancelled = true;
    };
  }, [can]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    /* Only what was filled in — the exemplar's rule, so a blank required field is answered
     * '"code" is required' rather than by a coerced value the operator never typed. */
    const body: Record<string, unknown> = {};

    const put = (key: string, text: string) => {
      const trimmed = text.trim();
      if (trimmed) body[key] = trimmed;
    };
    const putNumber = (key: string, text: string) => {
      const trimmed = text.trim();
      if (trimmed) body[key] = numeric(trimmed);
    };
    const putInstant = (key: string, text: string) => {
      if (text) body[key] = isoInstant(text);
    };

    put('code', values.code);
    put('name', values.name);
    put('description', values.description);
    put('discount_type', values.discount_type);
    putNumber('discount_value', values.discount_value);

    /* Never on a percentage coupon, whatever is still in the input. See the header. */
    if (values.discount_type === FIXED_AMOUNT) put('currency', values.currency);

    putNumber('max_discount_amount', values.max_discount_amount);
    putNumber('min_order_amount', values.min_order_amount);
    putInstant('starts_at', values.starts_at);
    putInstant('expires_at', values.expires_at);
    putNumber('max_uses', values.max_uses);
    putNumber('max_uses_per_school', values.max_uses_per_school);

    /* The model's comment: `null` and `[]` both mean unrestricted, so an empty picker sends nothing. */
    if (planIds.length) body.restricted_plan_ids = planIds;
    if (schoolIds.length) body.restricted_school_ids = schoolIds;

    put('status', values.status);

    try {
      await api.post('/coupons', body);
      /* `replace`, not `push`: Back would otherwise re-open an empty form for a coupon that exists. */
      success('Coupon created', 'It is now in the catalogue.');
      router.replace('/super-admin/coupons');
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError) {
        const perField: Record<string, string> = {};
        let rootMessage: string | null = null;

        /*
         * Both hazards this screen guarded against locally are now handled in `ApiError` itself, and
         * this reads the result rather than re-deriving it: the constructor drops a non-array
         * `details` (this module's two most likely refusals send an object), and `fieldErrors()`
         * excludes the empty-field entries that `checkCoherence()`'s object-level `.custom()`
         * produces. `formErrors()` returns exactly those.
         */
        Object.assign(perField, caught.fieldErrors());
        const formLevel = caught.formErrors();
        if (formLevel.length) rootMessage = formLevel.join(' ');

        setFieldErrors(perField);
        focusFirstInvalidField();
        setError(rootMessage ?? (Object.keys(perField).length ? null : caught.message));
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      setSaving(false);
    }
  }

  /*
   * Gated exactly as the list screen's "Add coupon" button is. `coupons.routes.js` puts
   * `requirePlatformScope()` in front of `coupons.manage` as well, and that half cannot be read from
   * the token's permission claim — a school-scoped user holding a re-granted `coupons.manage` reaches
   * this form and is refused on submit with `PLATFORM_SCOPE_REQUIRED`, which is in `EXPLAINED_CODES`
   * and so renders as a refusal rather than as a fault.
   */
  if (!can('coupons.manage')) {
    return (
      <div>
        <PageHeader title="New coupon" />
        <RefusalNotice
          refusal={{
            code: 'INSUFFICIENT_PERMISSION',
            message: 'You do not have permission to create a coupon.',
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="New coupon"
        description="A code, a discount type and its value are required. Everything else narrows when, where and how often it applies."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="The coupon"
          description="Its code and what it is called. The code is what a school types at checkout."
        >
          <Field
            id="code"
            width="sm"
            label="Code"
            required
            value={values.code}
            onChange={set('code')}
            error={fieldErrors.code}
            hint="3 to 60 characters: letters, digits, dashes and underscores, starting with a letter or digit. Stored in upper case."
          />

          <Field
            id="name"
            width="md"
            label="Name"
            value={values.name}
            onChange={set('name')}
            error={fieldErrors.name}
            hint="2 to 160 characters. Shown beside the code on the coupon list."
          />

          <TextAreaField
            id="description"
            label="Description"
            rows={3}
            value={values.description}
            onChange={set('description')}
            error={fieldErrors.description}
            hint="Up to 255 characters."
          />
        </FormSection>

        <FormSection
          columns={2}
          title="Discount"
          description="How much comes off, and the order values it applies between."
        >
          <SelectField
            id="discount_type"
            width="sm"
            label="Discount type"
            required
            value={values.discount_type}
            onChange={set('discount_type')}
            error={fieldErrors.discount_type}
          >
            {/* No default is offered: the schema requires the field, and guessing one for the operator
                decides which of the two meanings `discount_value` carries. */}
            <option value="">Choose one…</option>
            <option value={PERCENTAGE}>Percentage</option>
            <option value={FIXED_AMOUNT}>Fixed amount</option>
          </SelectField>

          <FormSpan>
            <Field
              id="discount_value"
              label="Discount value"
              type="number"
              step="0.01"
              required
              value={values.discount_value}
              onChange={set('discount_value')}
              error={fieldErrors.discount_value}
              /* The column comment — *"Percent when percentage, currency amount when fixed_amount"* — is
                 the whole reason the bound changes with the control above it. */
              hint={
                values.discount_type === PERCENTAGE
                  ? '0.01 to 100, to two decimal places. A 0% coupon is refused — it discounts nothing.'
                  : values.discount_type === FIXED_AMOUNT
                    ? 'Greater than 0, in the currency below.'
                    : 'A percentage or a currency amount, depending on the discount type above.'
              }
            />
          </FormSpan>

          {values.discount_type === FIXED_AMOUNT ? (
            <Field
              id="currency"
              width="xs"
              label="Currency"
              required
              value={values.currency}
              onChange={set('currency')}
              error={fieldErrors.currency}
              hint="Three-letter ISO 4217 code, e.g. USD. Stored in upper case. A coupon is only redeemable against an invoice in the same currency."
            />
          ) : null}

          <FormSpan>
            <Field
              id="max_discount_amount"
              label="Maximum discount"
              type="number"
              step="0.01"
              value={values.max_discount_amount}
              onChange={set('max_discount_amount')}
              error={fieldErrors.max_discount_amount}
              hint="A ceiling on what the coupon takes off. On a percentage coupon it has no currency of its own and is compared against the invoice's. Blank means no ceiling."
            />
          </FormSpan>

          <Field
            id="min_order_amount"
            width="sm"
            label="Minimum order amount"
            type="number"
            step="0.01"
            value={values.min_order_amount}
            onChange={set('min_order_amount')}
            error={fieldErrors.min_order_amount}
            hint="The coupon does not apply below this figure. Blank means no minimum."
          />
        </FormSection>

        <FormSection
          columns={2}
          title="When it can be used"
          description="The window it is valid in, and how many times it may be redeemed."
        >
          <Field
            id="starts_at"
            width="sm"
            label="Starts"
            type="datetime-local"
            value={values.starts_at}
            onChange={set('starts_at')}
            error={fieldErrors.starts_at}
            hint="Blank means usable immediately. Entered in your own time zone."
          />

          <Field
            id="expires_at"
            width="sm"
            label="Expires"
            type="datetime-local"
            value={values.expires_at}
            onChange={set('expires_at')}
            error={fieldErrors.expires_at}
            hint="Blank means no expiry. Must be after the start."
          />

          <Field
            id="max_uses"
            width="xs"
            label="Maximum uses"
            type="number"
            step="1"
            value={values.max_uses}
            onChange={set('max_uses')}
            error={fieldErrors.max_uses}
            hint="SRS §13.4's Maximum Uses, across every school. Blank means unlimited; the smallest limit is 1."
          />

          <Field
            id="max_uses_per_school"
            width="xs"
            label="Maximum uses per school"
            type="number"
            step="1"
            value={values.max_uses_per_school}
            onChange={set('max_uses_per_school')}
            error={fieldErrors.max_uses_per_school}
            hint="Blank means unlimited per school, within whatever the overall limit allows."
          />
        </FormSection>

        <FormSection
          title="Restrictions"
          description="Leave both empty for a coupon that any school may use on any plan."
          columns={2}
        >
          <RestrictionField
            id="restricted_plan_ids"
            label="Plan restrictions"
            noun="plan"
            picker={plans}
            selected={planIds}
            onChange={setPlanIds}
            error={fieldErrors.restricted_plan_ids}
          />

          <RestrictionField
            id="restricted_school_ids"
            label="School restrictions"
            noun="school"
            picker={schools}
            selected={schoolIds}
            onChange={setSchoolIds}
            error={fieldErrors.restricted_school_ids}
          />
        </FormSection>

        <FormSection
          title="Availability"
          description="Whether the coupon is live. A draft can be created now and switched on later."
        >
          <SelectField
            id="status"
            width="sm"
            label="Status"
            value={values.status}
            onChange={set('status')}
            error={fieldErrors.status}
            /* The absent option has to explain itself somewhere, and the hint is where `SelectField`
               puts that. Curly quotes are literal, not `&ldquo;`: this is a string prop, not JSX text. */
            hint="There is no “expired” option: that is set from the expiry date by the scheduled sweep. Use Inactive to stop honouring a coupon now."
          >
            <option value="">Server default (active)</option>
            {SETTABLE_STATUSES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
        </FormSection>

        <FormActions cancelHref="/super-admin/coupons">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Creating…">
            Create coupon
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
