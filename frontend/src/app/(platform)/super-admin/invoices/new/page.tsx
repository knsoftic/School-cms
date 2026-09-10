'use client';

/**
 * Generate an invoice — SRS §13.1, FR-BILL-001, Known Issue 30.
 *
 * Built on the pattern `super-admin/organizations/new/page.tsx` establishes: the field set is the
 * create schema's, empty optional values are omitted rather than sent as `""`, `ApiError.fieldErrors()`
 * puts a 422 under the input it names, refusals render through `RefusalNotice`, and success is a
 * `router.replace` back to the list. Only the decisions this screen had to make for itself are written
 * down below.
 *
 * ## There is no `POST /invoices`, and that is the shape of the whole form
 *
 * `invoices.routes.js` mounts `POST /generate` and nothing else that creates. Its own header says why:
 * FR-BILL-001's precondition is *"Subscription exists and a billing event occurs"*, so an invoice is
 * **derived from a subscription**, not authored. `subscription_id` is therefore the only `.required()`
 * field in `schemas.generate`, and everything else on this form is an override of a default the service
 * would otherwise compute. Send nothing but the id and you get the invoice the requirement describes.
 *
 * The four §13.1 money figures are not here because the schema *forbids* them — `refused` names
 * `subtotal`, `discount_amount`, `tax_amount`, `total`, `amount_paid`, `amount_due` and `credit_applied`
 * explicitly so a request carrying one gets a 422 saying which function owns the figure. A form field
 * for any of them would be inventing an editable invoice.
 *
 * ## Two guards, not one, and they refuse with different codes
 *
 * `canManage()` in the routes file is `[requirePlatformScope(), requirePermission('invoices.manage')]`.
 * The list screen's "Generate invoice" button checks only the permission, which is right for hiding a
 * button; a screen that is about to explain *why* it will not open should name the condition that
 * actually fails, and the scope guard runs first. So an organization admin holding a re-granted
 * `invoices.manage` (FR-AUTH-009 makes that possible) is told about scope, not about permissions.
 *
 * ## One coupon control, because two would be a 422 waiting to happen
 *
 * The schema accepts `coupon_code` **or** `coupon_id` and `checkPeriod()` refuses both together. Its own
 * comment settles which belongs here — *"`coupon_code` is what a school types; the id is the screen's"* —
 * so this renders a select of coupons and sends `coupon_id`. The list is filtered with `valid_now`,
 * which `coupons.service.list()` documents as the same four conditions `validateForOrder()` applies:
 * offering a coupon that has expired or has not started would offer a choice the issuance then refuses.
 *
 * ## Where the schema surprised me
 *
 *  1. **`tax_id: null` does not mean "no tax".** `invoices.validation.js` says it does — *"`null` is
 *     meaningful: 'no tax on this invoice', as opposed to omitted, which takes the default"* — but
 *     `taxes.service.resolveForInvoice()` opens with `if (taxId !== undefined && taxId !== null)` and
 *     falls through to the default row for both. `issue()` passes `payload.tax_id` straight in, so a
 *     `null` and an omission produce the same invoice. This form therefore does **not** offer a "no tax"
 *     option: a control whose label promises something the service does not do is worse than an absent
 *     one. Naming a zero-rate tax row is how an operator gets an untaxed invoice today.
 *
 *  2. **An object-level 422 arrives with no field, and would otherwise vanish.** `checkPeriod()` reports
 *     *"billing_period_end must be after billing_period_start"* through `helpers.message()` on the
 *     object, so `item.path` is empty and `validate.js` sends `field: ''`. The exemplar's
 *     `Object.keys(perField).length ? null : caught.message` would then see one key, suppress the banner,
 *     and render the message under an input named `''` — which is to say nowhere. Every message whose
 *     field this form does not render is hoisted to the top instead; see `onSubmit`.
 *
 *  3. **`first_cycle` is tri-state, not a checkbox.** The service infers it from
 *     `renewal_count === 0` when it is absent, and the override exists so a re-issued first invoice can
 *     still say the setup fee is owed. A checkbox has no "absent", so defaulting it either way would
 *     silently replace the inference — and on a first cycle overage is skipped entirely, so getting it
 *     wrong changes what is billed rather than just a flag.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { formatCodeWithAmount } from '@/lib/money';
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

/**
 * Two of `INVOICE_STATUS`'s seven values, mirroring `ISSUABLE_STATUSES` in `invoices.validation.js`.
 *
 * The other five are consequences, not choices: `partially_paid` and `paid` are sums of approved
 * payments, `overdue` is the clock, and `cancelled` and `refunded` each have their own operation.
 */
const ISSUABLE_STATUSES = ['draft', 'unpaid'];

/** `PAGINATION.MAX_LIMIT` — `getPagination()` clamps anything larger, so asking for more is a lie. */
const OPTION_LIMIT = 100;

/** The plain string fields, sent trimmed when filled and omitted when not. */
const TEXTUAL_FIELDS = [
  'billing_period_start',
  'billing_period_end',
  'issue_date',
  'due_date',
  'status',
  'notes',
  'reason',
] as const;

/**
 * One row of `GET /subscriptions`.
 *
 * `subscriptions.controller.present()` spreads the whole model and joins five relations on top, so far
 * more arrives than this names; these are the columns the picker and its hints read.
 *
 * `credit_balance` is `money()` — `DECIMAL(14,2)`, and it arrives as a JS **number**
 * (`config/database.js` sets `decimalNumbers: true`; this comment used to say string). It is only
 * displayed, through `lib/money`, and never added to anything on this side of the wire.
 */
interface SubscriptionOption {
  id: number;
  school_id: number;
  state: string;
  currency: string;
  credit_balance: number;
  /** §12.7's tolerance, and the term the invoice's due date is derived from. See the `due_date` hint. */
  grace_period_days: number;
  current_period_start: string;
  /** Null for a `one_time` subscription — the column's own comment. */
  current_period_end: string | null;
  plan: { id: number; name: string } | null;
}

/**
 * One row of `GET /taxes`. `rate_percent` is `DECIMAL(7,4)`, which `decimalNumbers: true` delivers as
 * a number — `12.5`, not `"12.5000"` — so it is interpolated as it comes: a rate of 12.5 reads "12.5%".
 */
interface TaxOption {
  id: number;
  name: string;
  code: string;
  rate_percent: number;
  is_default: boolean;
}

/** One row of `GET /coupons`, narrowed to what a label needs. */
interface CouponOption {
  id: number;
  code: string;
  name: string | null;
}

/**
 * The calendar date of an instant, for a label.
 *
 * `current_period_start` and `current_period_end` are `DATE`, not `DATEONLY`, so they arrive as full
 * ISO timestamps. Sliced rather than run through `toLocaleDateString()` because these appear inside an
 * option label beside an id — the point is to tell two periods apart, not to state a local date.
 */
function isoDay(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

function subscriptionLabel(row: SubscriptionOption): string {
  const plan = row.plan ? row.plan.name : 'no plan';
  const end = isoDay(row.current_period_end);
  const period = end ? `${isoDay(row.current_period_start)} → ${end}` : 'one-time';
  return `#${row.id} · school ${row.school_id} · ${plan} · ${row.state} · ${period}`;
}

export default function GenerateInvoicePage() {
  const router = useRouter();
  const { can, profile } = useAuth();
  const { success } = useToast();

  const [values, setValues] = useState({
    subscription_id: '',
    billing_period_start: '',
    billing_period_end: '',
    issue_date: '',
    due_date: '',
    coupon_id: '',
    tax_id: '',
    first_cycle: '',
    status: '',
    notes: '',
    metadata: '',
    reason: '',
  });

  /*
   * The two booleans are held apart from `values` because they are not optional in the same sense: a
   * checkbox has no empty state to omit. Both mirror the schema's `.default(true)` so the form opens on
   * the invoice the service would have produced unaided.
   */
  const [applyCredit, setApplyCredit] = useState(true);
  const [includeOverage, setIncludeOverage] = useState(true);

  const [subscriptions, setSubscriptions] = useState<SubscriptionOption[]>([]);
  const [subscriptionTotal, setSubscriptionTotal] = useState<number | null>(null);
  const [subscriptionsError, setSubscriptionsError] = useState<string | null>(null);
  const [taxes, setTaxes] = useState<TaxOption[]>([]);
  const [coupons, setCoupons] = useState<CouponOption[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(true);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  /*
   * Both halves of `canManage()`, in the order the router applies them — computed here, above the
   * effect, because the effect needs the answer too. See the header and the refusal below.
   */
  const isPlatform = profile?.tenant.isPlatform ?? false;
  const allowed = isPlatform && can('invoices.manage');

  /*
   * Three lookups, each failing on its own terms.
   *
   * Only `/subscriptions` is load-bearing: without it the one required field cannot be filled, so its
   * failure is reported beside the select. `/taxes` needs `taxes.view` and `/coupons` needs
   * `coupons.view`, neither of which travels with `invoices.manage` — a caller holding one and not the
   * others is a re-grant away, and losing an *optional* override to a 403 must not stop an invoice being
   * issued. So those two are allowed to come back empty and their controls degrade to the default.
   *
   * None of them is sent for a caller the page is about to refuse. The gate below is a `return`
   * *after* the hooks, so without this the three requests went out anyway — spending the pre-auth
   * `apiLimiter` budget on a screen that then says no. `coupons/new` guards its lookups the same way.
   */
  useEffect(() => {
    if (!allowed) return undefined;

    const controller = new AbortController();
    let cancelled = false;

    /** An abort is a replaced request, not a failure — the reason `useCollection` checks the same name. */
    const aborted = (caught: unknown) => (caught as Error)?.name === 'AbortError';

    (async () => {
      try {
        const page = await api.page<SubscriptionOption[]>('/subscriptions', {
          query: { limit: OPTION_LIMIT },
          signal: controller.signal,
        });
        if (cancelled) return;
        setSubscriptions(page.data ?? []);
        setSubscriptionTotal(page.meta?.total ?? null);
      } catch (caught) {
        if (cancelled || aborted(caught)) return;
        setSubscriptionsError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not load subscriptions. Check your connection and reload.'
        );
      }

      try {
        /* Inactive rates are refused at issue with `TAX_INACTIVE`, so they are not offered. */
        const rows = await api.get<TaxOption[]>('/taxes', {
          query: { limit: OPTION_LIMIT, is_active: true },
          signal: controller.signal,
        });
        if (!cancelled) setTaxes(rows ?? []);
      } catch (caught) {
        if (!cancelled && !aborted(caught)) setTaxes([]);
      }

      try {
        const rows = await api.get<CouponOption[]>('/coupons', {
          query: { limit: OPTION_LIMIT, valid_now: true },
          signal: controller.signal,
        });
        if (!cancelled) setCoupons(rows ?? []);
      } catch (caught) {
        if (!cancelled && !aborted(caught)) setCoupons([]);
      }

      if (!cancelled) setLoadingOptions(false);
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [allowed]);

  /** The row behind the current selection, which several hints below quote figures from. */
  const selected = subscriptions.find((row) => String(row.id) === values.subscription_id) ?? null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setRefusal(null);
    setFieldErrors({});

    const body: Record<string, unknown> = {
      apply_credit: applyCredit,
      include_overage: includeOverage,
    };

    /*
     * Omitted when nothing is chosen rather than sent as `0`. The API's own `"subscription_id" is
     * required` then lands on the select, which is a better message than a `min(1)` failure on a value
     * the operator never typed.
     */
    if (values.subscription_id) body.subscription_id = Number(values.subscription_id);
    if (values.coupon_id) body.coupon_id = Number(values.coupon_id);
    if (values.tax_id) body.tax_id = Number(values.tax_id);
    /* Absent means "infer from `renewal_count`" — see note 3 in the header. */
    if (values.first_cycle) body.first_cycle = values.first_cycle === 'true';

    for (const key of TEXTUAL_FIELDS) {
      const value = values[key].trim();
      if (value) body[key] = value;
    }

    /*
     * The one check this form makes for itself, and it is the exception `components/form.tsx` names:
     * malformed JSON cannot be expressed in a request body at all, so there is no API rule being
     * duplicated here. What the object may *contain* is still the server's call — `Joi.object()` refuses
     * a string or an array with a 422 that lands on this field.
     */
    if (values.metadata.trim()) {
      try {
        body.metadata = JSON.parse(values.metadata) as unknown;
      } catch {
        setFieldErrors({ metadata: 'This is not valid JSON.' });
        focusFirstInvalidField();
        setSaving(false);
        return;
      }
    }

    try {
      await api.post('/invoices/generate', body);
      /* `replace`, so Back does not re-open a form for an invoice that now exists. */
      success('Invoice generated', 'It is listed with the subscription it bills.');
      router.replace('/super-admin/invoices');
    } catch (caught) {
      if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
        setRefusal({ code: caught.code, message: caught.message });
      } else if (caught instanceof ApiError) {
        /*
         * `details` is not always an array, and `fieldErrors()` iterates it.
         *
         * `ApiError` takes `details` as `any` and `errorHandler.js:269` copies it onto the body
         * verbatim, so a plain object gets through — which is exactly what this module's own failures
         * send: `INVOICE_PERIOD_ALREADY_BILLED` carries `{ invoice_id, invoice_number, status }`,
         * `INVOICE_NO_PERIOD` carries `{ subscription_id, state }`, `INVOICE_NO_LINES` likewise. Only
         * the 422s from `validate.js` are the `FieldError[]` the client's type claims. Calling
         * `fieldErrors()` on one of the others throws "is not iterable" from inside this catch, so
         * `setSaving(false)` never runs and the screen answers a re-issued period with a permanently
         * disabled button and no message at all — the likeliest failure this form has, failing worst.
         *
         * That guard now lives in `apiClient.ts` itself, where it belongs: the `ApiError` constructor
         * drops a `details` that is not an array of field errors, so `fieldErrors()` can no longer
         * throw. Five of the six screens built alongside this one hit the same trap independently,
         * which is what settled it as a shared fix rather than six local ones. The split below stays,
         * because "the API named a field this form does not render" is a different problem from
         * "details was the wrong type", and only the second one is fixed upstream.
         */
        const perField = caught.fieldErrors();
        const known: Record<string, string> = {};
        const orphans: string[] = [];

        /* Split by whether this form has an input to put the message under — header, note 2. */
        for (const [field, message] of Object.entries(perField)) {
          if (field && field in values) known[field] = message;
          else orphans.push(message);
        }

        /* Whole-object rules report with no field at all; `formErrors()` is where they now arrive. */
        orphans.push(...caught.formErrors());

        setFieldErrors(known);
        focusFirstInvalidField();
        setError(orphans.length ? orphans.join(' ') : Object.keys(known).length ? null : caught.message);
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      setSaving(false);
    }
  }

  /* `isPlatform` first, so the refusal names the condition that actually failed. See the header. */
  if (!allowed) {
    return (
      <div>
        <PageHeader title="Generate invoice" />
        <RefusalNotice
          refusal={
            isPlatform
              ? {
                  code: 'INSUFFICIENT_PERMISSION',
                  message: 'You do not have permission to generate an invoice.',
                }
              : {
                  code: 'PLATFORM_SCOPE_REQUIRED',
                  message: 'Invoice generation is a platform operation.',
                }
          }
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Generate invoice"
        description="Choose a subscription. Everything else overrides a figure the billing service would otherwise work out for itself."
      />

      {refusal ? <RefusalNotice refusal={refusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection
          title="Subscription and period"
          description="The subscription being billed, and the span of service this invoice covers."
        >
          {/* The only `.required()` field in `schemas.generate`, so `SelectField` says the word
              "required" where this used to carry a bare `aria-hidden` asterisk — a convention nobody
              not looking at the colour can read. */}
          <SelectField
            id="subscription_id"
            label="Subscription"
            required
            value={values.subscription_id}
            onChange={set('subscription_id')}
            /*
             * A failed lookup is an error, not a hint: without this list the one required field cannot be
             * filled at all. It ranks below a 422 on the same field, which is the more recent news.
             */
            error={fieldErrors.subscription_id || subscriptionsError}
            /*
             * Said plainly rather than papered over: `MAX_LIMIT` is 100, so beyond that this picker
             * cannot show every subscription and there is no id box to fall back on. Narrowing the
             * subscriptions list and coming back is the way through.
             */
            hint={
              subscriptionTotal !== null && subscriptionTotal > subscriptions.length
                ? `Showing the ${subscriptions.length} most recent of ${subscriptionTotal} subscriptions. If the one you want is not here, find it on the Subscriptions screen first.`
                : 'The invoice is derived from the subscription: its items, its currency and its period.'
            }
          >
            <option value="">
              {loadingOptions ? 'Loading subscriptions…' : 'Select a subscription'}
            </option>
            {subscriptions.map((row) => (
              <option key={row.id} value={row.id}>
                {subscriptionLabel(row)}
              </option>
            ))}
          </SelectField>

          <Field
            id="billing_period_start"
            label="Billing period start"
            type="date"
            value={values.billing_period_start}
            onChange={set('billing_period_start')}
            error={fieldErrors.billing_period_start}
            hint={
              selected
                ? `Defaults to the subscription's current period, starting ${isoDay(selected.current_period_start)}.`
                : "Defaults to the subscription's current period."
            }
          />

          <Field
            id="billing_period_end"
            label="Billing period end"
            type="date"
            value={values.billing_period_end}
            onChange={set('billing_period_end')}
            error={fieldErrors.billing_period_end}
            hint="Must be after the start date."
          />

          <Field
            id="issue_date"
            label="Issue date"
            type="date"
            value={values.issue_date}
            onChange={set('issue_date')}
            error={fieldErrors.issue_date}
            hint="Defaults to today."
          />

          <Field
            id="due_date"
            label="Due date"
            type="date"
            value={values.due_date}
            onChange={set('due_date')}
            error={fieldErrors.due_date}
            /*
             * §13.1 fixes no payment term, so the service takes one from the subscription's grace period
             * rather than inventing a default. Quoted here because it is the only place an operator can
             * see what leaving this blank will produce.
             */
            hint={
              selected
                ? `Defaults to the issue date plus this subscription's grace period of ${selected.grace_period_days} day(s).`
                : "Defaults to the issue date plus the subscription's grace period."
            }
          />
        </FormSection>

        <FormSection
          title="Adjustments"
          description="Discounts, tax and credit applied to the total before it is issued."
        >
          <SelectField
            id="coupon_id"
            label="Coupon"
            value={values.coupon_id}
            onChange={set('coupon_id')}
            error={fieldErrors.coupon_id}
            /*
             * The escape hatch is real and worth naming: FR-BILL-005's `POST /invoices/:id/coupon` takes
             * a code and works on a `draft` or `unpaid` invoice, so a coupon missing from this list is
             * not a coupon that can never be applied.
             */
            hint="Only coupons valid today are listed. One can also be applied to the invoice after it is issued, while it is still draft or unpaid."
          >
            <option value="">No coupon</option>
            {coupons.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name ? `${row.code} — ${row.name}` : row.code}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="tax_id"
            label="Tax rate"
            value={values.tax_id}
            onChange={set('tax_id')}
            error={fieldErrors.tax_id}
            hint="The rate is copied onto the invoice at issue, so a later edit to it cannot rewrite this document."
          >
            {/* No "none" option — header note 1 explains why one would not do what it says. */}
            <option value="">Use the default rate</option>
            {taxes.map((row) => (
              <option key={row.id} value={row.id}>
                {row.code} — {row.rate_percent}%{row.is_default ? ' (default)' : ''}
              </option>
            ))}
          </SelectField>

          {/* Tri-state, not a checkbox — header note 3. The empty option is the service's inference. */}
          <SelectField
            id="first_cycle"
            label="First cycle"
            value={values.first_cycle}
            onChange={set('first_cycle')}
            error={fieldErrors.first_cycle}
            hint="Inferred from whether the subscription has ever renewed. Forcing “Yes” also skips overage, because a period that has not been used yet has none of its own."
          >
            <option value="">Infer from the subscription</option>
            <option value="true">Yes — bill the one-off items too</option>
            <option value="false">No — recurring items only</option>
          </SelectField>

          <SelectField
            id="status"
            label="Status"
            value={values.status}
            onChange={set('status')}
            error={fieldErrors.status}
            hint="Only these two may be set at issue. A draft is not yet a demand and is excluded from the outstanding total."
          >
            <option value="">Server default — unpaid</option>
            {ISSUABLE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SelectField>

          <div className="space-y-2 pt-1">
            {/* Formatted, not interpolated raw: a balance of 1250.5 read as "USD 1250.5". */}
            <CheckboxField
              id="apply_credit"
              label={`Draw down the subscription's credit balance${
                selected ? ` (${formatCodeWithAmount(selected.currency, selected.credit_balance)})` : ''
              }`}
              checked={applyCredit}
              onChange={(event) => setApplyCredit(event.target.checked)}
              hint="§12.3's remaining credit from a proration. Unchecked, the invoice is raised for the full amount and the credit stays on the subscription."
            />

            <CheckboxField
              id="include_overage"
              label="Sweep in metered overage for the period"
              checked={includeOverage}
              onChange={(event) => setIncludeOverage(event.target.checked)}
              hint="Ignored on a first cycle, where there is no prior usage to bill."
            />
          </div>
        </FormSection>

        <FormSection
          title="Internal notes"
          description="Kept on the invoice record and its audit entry."
        >
          <TextAreaField
            id="notes"
            label="Notes"
            rows={3}
            value={values.notes}
            onChange={set('notes')}
            error={fieldErrors.notes}
            hint="Carried on the printed invoice. Up to 5,000 characters."
          />

          <TextAreaField
            id="metadata"
            label="Metadata"
            rows={2}
            value={values.metadata}
            onChange={set('metadata')}
            className="font-mono text-sm"
            placeholder='{"po_number": "4471"}'
            error={fieldErrors.metadata}
            /*
             * A raw JSON box because the schema is `Joi.object().unknown(true)` — there is no shape to
             * build a control from, and leaving the field out would hide a column the invoice stores.
             */
            hint="Optional JSON object stored with the invoice. Leave empty if you have nothing to attach."
          />

          <Field
            id="reason"
            label="Reason"
            value={values.reason}
            onChange={set('reason')}
            error={fieldErrors.reason}
            hint="Recorded against this action in the audit log, up to 255 characters. Not shown on the invoice."
          />
        </FormSection>

        <FormActions cancelHref="/super-admin/invoices">
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Generating…">
            Generate invoice
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
