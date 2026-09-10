'use client';

/**
 * One coupon — SRS §13.3, and the two write routes the module had mounted with no caller.
 *
 * `PATCH /coupons/:id` and `DELETE /coupons/:id`. The catalogue could issue a coupon and could never
 * correct one: a typo in the code, a window that started a month early, a redemption ceiling set too
 * low — none of it could be changed from any screen, and a coupon created by mistake could not be
 * removed.
 *
 * ## Delete is refused once the coupon has been used, and that is the point
 *
 * `destroy()` counts redemptions first and answers `COUPON_IN_USE` if there are any. A coupon that
 * has discounted an invoice is part of that invoice's history, so removing it would change what the
 * school was billed. **Expiring it is the operation for a coupon in circulation** — the form's status
 * control does that, and the delete block says so rather than leaving the operator to discover the
 * refusal.
 *
 * ## `status` accepts two of its three values
 *
 * `active` and `inactive` are settable. `expired` is written by the scheduled sweep from
 * `expires_at`, and the schema's own message says so — a select offering it would be offering a
 * state the API will not take. There is no fourth: `COUPON_STATUS` is exactly those three, and a
 * coupon whose redemptions have run out stays `active` with `remaining_uses` at 0, which the line
 * under the badge shows.
 *
 * An expired coupon still has to be *shown* as expired. With only the two settable options the
 * select had nothing matching `expired`, so the browser displayed the first one — an expired coupon
 * read "Active" in its own edit form. It now gets a disabled third option naming it, and the hint
 * says the thing an operator is likeliest to assume wrongly: moving "Valid until" later does not
 * bring it back. Nothing turns `expired` into `active` except choosing Active — the sweep only ever
 * moves the other way.
 *
 * ## The discount rules are cross-field, and a PATCH body is all the schema sees
 *
 * `checkCoherence` compares fields **within the body** — on a create that is the whole coupon, on a
 * PATCH it is only what changed. Three consequences, each handled here rather than left to surface as
 * something stranger:
 *
 *   - **A fixed amount with no currency.** The create schema requires the currency; the update
 *     schema cannot, because a body that omits the type cannot say which rule applies. So turning a
 *     percentage coupon into a fixed one without naming a currency is refused here, under the
 *     Currency field, before anything is sent — `coupons.service.update()` checks the merged row too.
 *   - **A percentage with a currency.** The Currency input disappears with the type, as it does on
 *     the create screen, and switching to a percentage sends `currency: null` so the old currency is
 *     not left on a coupon that must not have one.
 *   - **A percentage above 100.** The bound is a `when` on `discount_type`, which can only read the
 *     type and the value from the same body. So whenever either is sent the other goes with it;
 *     otherwise `{ discount_value: 150 }` on a percentage coupon took the fixed-amount branch, and
 *     switching a fixed 150 to a percentage sent the type with no value to check — both met the model's
 *     own `percentageInRange` validator instead, whose message is keyed by that name, not by a field.
 *
 * The window rule — an end at or before the start — is a whole-object message with no field, and
 * `splitApiErrors` puts it in the banner. The form also swaps the discount field's unit as the type
 * changes, because "50" means half off or fifty pounds off and the label is the only thing that says
 * which.
 *
 * ## Dates are sent as instants
 *
 * `datetime-local` yields a zoneless `2026-10-31T23:59`, which Joi reads in the **server's** zone. The
 * create screen converted it with `isoInstant`; this one sent it as typed, so an expiry edited here
 * landed hours away from the one set there. Both now go through the same helper.
 *
 * ## The two restriction lists
 *
 * `restricted_plan_ids` and `restricted_school_ids` are accepted by the update schema and were not on
 * this form, so a restriction set at creation could never be corrected. They are the same checkbox
 * pickers the create screen uses, fed from `/plans` and `/schools`, with one difference that matters
 * on an edit: a coupon can already name an id the picker cannot list — beyond the first page, or in a
 * list that failed to load. `MultiSelectField` emits only the options it shows, so without care the
 * first tick would silently drop those ids from the restriction. They are carried through untouched,
 * and the hint says how many there are.
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { splitApiErrors } from '@/lib/formErrors';
import { isoInstant } from '@/lib/instants';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import {
  Field,
  FormGrid,
  FormSection,
  MultiSelectField,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
} from '@/components/form';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';
import {
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

/** `config/constants.js` COUPON_TYPES. */
const PERCENTAGE = 'percentage';
const FIXED_AMOUNT = 'fixed_amount';

/** `GET /coupons/:id` — the row plus the derived field `present()` adds. */
interface CouponDetail {
  id: number;
  code: string;
  name: string | null;
  description: string | null;
  discount_type: 'percentage' | 'fixed_amount';
  discount_value: number;
  currency: string | null;
  max_discount_amount: number | null;
  min_order_amount: number | null;
  starts_at: string | null;
  expires_at: string | null;
  max_uses: number | null;
  max_uses_per_school: number | null;
  /** JSON columns. `null` and `[]` both mean unrestricted — the model's own comment. */
  restricted_plan_ids: number[] | null;
  restricted_school_ids: number[] | null;
  used_count: number;
  remaining_uses: number | null;
  status: string;
}

/**
 * The form's state — every field a typed string, because that is what an input holds.
 *
 * **Inferred from `toValues()` rather than annotated**, which is the convention every create screen
 * in this product follows and which `verify-frontend.js` is the reason for: it refuses any
 * annotation typing a `money()` column as `string`, since a DECIMAL arrives from this API as a
 * number and a screen that declared otherwise would be describing the payload wrongly. Three of the
 * fields below are money columns. They are strings *here* and numbers *there*, and inferring the
 * type says that without asserting anything false about the API's shape.
 *
 * The two restriction lists are not in here: they are id arrays, not text, and live in their own
 * state beside it.
 */
type FormValues = ReturnType<typeof toValues>;

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

/** An ISO timestamp as `<input type="datetime-local">` wants it, or blank. */
function toLocal(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toValues(coupon: CouponDetail) {
  return {
    code: coupon.code,
    name: coupon.name ?? '',
    description: coupon.description ?? '',
    /*
     * Widened to `string` on purpose. Inferring it from `CouponDetail` would give the two-value
     * union, and a `<select>`'s `onChange` hands back a plain string — so the form state would be
     * narrower than the control that writes it, and the type error would be in the wrong place.
     * What the API accepts is checked by the API.
     */
    discount_type: String(coupon.discount_type),
    discount_value: String(coupon.discount_value),
    currency: coupon.currency ?? '',
    max_discount_amount: coupon.max_discount_amount === null ? '' : String(coupon.max_discount_amount),
    min_order_amount: coupon.min_order_amount === null ? '' : String(coupon.min_order_amount),
    starts_at: toLocal(coupon.starts_at),
    expires_at: toLocal(coupon.expires_at),
    max_uses: coupon.max_uses === null ? '' : String(coupon.max_uses),
    max_uses_per_school:
      coupon.max_uses_per_school === null ? '' : String(coupon.max_uses_per_school),
    status: coupon.status,
    reason: '',
  };
}

/**
 * A restriction list as the form holds it. The column is JSON, and `parseJsonValue` hands back
 * malformed content untouched rather than throwing — so anything that is not an array of ids is read
 * as "unrestricted" rather than trusted.
 */
function idsOf(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
}

/** Two id lists hold the same ids, in whatever order. The picker emits in its own order. */
function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((value, index) => value === right[index]);
}

/** The text fields sent when they differ from the record. `reason` is not one — see `save()`. */
const FIELDS = [
  'code',
  'name',
  'description',
  'discount_type',
  'discount_value',
  'currency',
  'max_discount_amount',
  'min_order_amount',
  'starts_at',
  'expires_at',
  'max_uses',
  'max_uses_per_school',
  'status',
] as const;

/** Every field this form renders an error under. Anything else a 422 names goes to the banner. */
const RENDERED = new Set<string>([
  ...FIELDS,
  'restricted_plan_ids',
  'restricted_school_ids',
  'reason',
]);

/**
 * One of the two §13.4 restriction lists, on an existing coupon.
 *
 * The create screen has the same control; this one differs in what a failed or short list means. On
 * a create there is nothing to lose. Here the coupon may already name ids the list cannot show, and
 * those are kept rather than silently dropped — see the header.
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
  /** Singular; both of these pluralise with an `s`. */
  noun: string;
  picker: Picker;
  selected: number[];
  onChange: (ids: number[]) => void;
  error?: string;
}) {
  if (picker.state === 'failed') {
    return (
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-1 text-sm text-muted">
          {`The ${noun} list could not be loaded, so ${noun} restrictions cannot be changed here. `}
          {selected.length
            ? `The coupon stays restricted to the ${selected.length} ${noun}${selected.length === 1 ? '' : 's'} it names now.`
            : `The coupon keeps applying to every ${noun}.`}
        </p>
      </div>
    );
  }

  if (picker.state === 'ready' && picker.rows.length === 0 && selected.length === 0) {
    return (
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-1 text-sm text-muted">
          {`No ${noun}s have been created yet, so there is nothing to restrict the coupon to.`}
        </p>
      </div>
    );
  }

  const rows = picker.state === 'ready' ? picker.rows : [];
  const listed = new Set(rows.map((row) => row.id));
  /* Only knowable once the list is in; while it loads the control is disabled and cannot emit. */
  const unlisted = picker.state === 'ready' ? selected.filter((value) => !listed.has(value)) : [];
  const truncated = picker.state === 'ready' && picker.total > picker.rows.length;

  return (
    <MultiSelectField<number>
      id={id}
      label={label}
      disabled={picker.state === 'loading'}
      selected={selected}
      /* `MultiSelectField` emits only what it lists; the ids it cannot show ride along unchanged. */
      onChange={(ids) => onChange([...unlisted, ...ids])}
      options={rows.map((row) => ({ value: row.id, label: row.name, hint: row.code }))}
      emptyLabel={picker.state === 'loading' ? 'Loading…' : `No ${noun}s to choose from.`}
      error={error}
      hint={
        `Select none to let the coupon apply to every ${noun}.` +
        (truncated
          ? ` Showing the first ${rows.length} of ${picker.total} — anything beyond that cannot be picked here.`
          : '') +
        (unlisted.length
          ? ` ${unlisted.length} ${noun}${unlisted.length === 1 ? '' : 's'} the coupon already names ${unlisted.length === 1 ? 'is' : 'are'} not in this list and ${unlisted.length === 1 ? 'is' : 'are'} kept as ${unlisted.length === 1 ? 'it is' : 'they are'}.`
          : '')
      }
    />
  );
}

export default function CouponDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : null;

  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const [coupon, setCoupon] = useState<CouponDetail | null>(null);
  const [values, setValues] = useState<FormValues | null>(null);
  const [planIds, setPlanIds] = useState<number[]>([]);
  const [schoolIds, setSchoolIds] = useState<number[]>([]);
  const [plans, setPlans] = useState<Picker>({ state: 'loading' });
  const [schools, setSchools] = useState<Picker>({ state: 'loading' });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** The record and everything the form derives from it, in one place so a save resets all of it. */
  function adopt(next: CouponDetail) {
    setCoupon(next);
    setValues(toValues(next));
    setPlanIds(idsOf(next.restricted_plan_ids));
    setSchoolIds(idsOf(next.restricted_school_ids));
  }

  useEffect(() => {
    if (!id) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setRefusal(null);

    (async () => {
      try {
        const result = await api.get<{ coupon: CouponDetail }>(`/coupons/${id}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setCoupon(result.coupon);
        setValues(toValues(result.coupon));
        setPlanIds(idsOf(result.coupon.restricted_plan_ids));
        setSchoolIds(idsOf(result.coupon.restricted_school_ids));
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          setLoadError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setLoadError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [id, nonce]);

  useEffect(() => {
    /*
     * The pickers are part of the edit form, which is only rendered with the permission — so they are
     * not fetched without it either. `can` is `useCallback`-memoized on the profile in `AuthProvider`.
     */
    if (!can('coupons.manage')) return undefined;

    let cancelled = false;

    /* `api.page` rather than `api.get`: `meta.total` is what tells the picker it is short. */
    async function load(path: string, apply: (picker: Picker) => void) {
      try {
        const page = await api.page<Option[]>(path, { query: { limit: OPTION_LIMIT } });
        if (!cancelled) {
          apply({ state: 'ready', rows: page.data, total: page.meta?.total ?? page.data.length });
        }
      } catch {
        /* Which failure it was does not change the remedy — the restriction cannot be changed here. */
        if (!cancelled) apply({ state: 'failed' });
      }
    }

    void load('/plans', setPlans);
    void load('/schools', setSchools);

    return () => {
      cancelled = true;
    };
  }, [can]);

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (loadError) return <ErrorNotice message={loadError} onRetry={() => setNonce((n) => n + 1)} />;
  if (loading || !coupon || !values) return <LoadingBlock />;

  /* Narrowed for the closures below, which the guard above cannot narrow for. */
  const record = coupon;
  const form = values;
  const canManage = can('coupons.manage');

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((current) => (current ? { ...current, [key]: value } : current));
  }

  const isPercentage = form.discount_type === PERCENTAGE;
  const isExpired = record.status === 'expired';

  const base = toValues(record);
  const changed: Record<string, unknown> = {};
  for (const key of FIELDS) {
    if (form[key] === base[key]) continue;
    const raw = form[key].trim();
    /*
     * Blank means null on every nullable field here, and the schema accepts null on all of them.
     * `code`, `discount_type`, `discount_value` and `status` are the four that are not nullable, so
     * a blank one is left out of the body rather than sent as null — the API would refuse it, and
     * the message would be about a field the operator emptied rather than about emptying it.
     */
    const NOT_NULLABLE = ['code', 'discount_type', 'discount_value', 'status'];
    if (raw === '' && NOT_NULLABLE.includes(key)) continue;
    if (raw === '') {
      changed[key] = null;
    } else if (key === 'starts_at' || key === 'expires_at') {
      /* An instant, not the zoneless text the input holds. See the header. */
      changed[key] = isoInstant(raw);
    } else {
      changed[key] = raw;
    }
  }

  if (isPercentage) {
    /*
     * Never a currency on a percentage coupon, whatever the hidden input still holds. Switching *to*
     * a percentage says so explicitly, so the fixed amount's currency is cleared rather than kept.
     */
    delete changed.currency;
    if (record.discount_type !== PERCENTAGE) changed.currency = null;
  }

  /*
   * The value's bound depends on the type, and the schema can only read either from this body — so
   * whenever one of the pair is sent, the other goes with it. Switching a fixed 150 to a percentage
   * without retyping the value would otherwise send the type alone, the `when` would have no value to
   * check, and the model's `percentageInRange` would refuse it under a name no field carries.
   */
  if ('discount_value' in changed || 'discount_type' in changed) {
    changed.discount_type = form.discount_type;
    if (!('discount_value' in changed) && form.discount_value.trim() !== '') {
      changed.discount_value = form.discount_value.trim();
    }
  }

  /* An empty picker is sent as `null`, which is what the create screen leaves on a coupon it never restricted. */
  if (!sameIds(planIds, idsOf(record.restricted_plan_ids))) {
    changed.restricted_plan_ids = planIds.length ? planIds : null;
  }
  if (!sameIds(schoolIds, idsOf(record.restricted_school_ids))) {
    changed.restricted_school_ids = schoolIds.length ? schoolIds : null;
  }

  const nothingChanged = Object.keys(changed).length === 0;

  async function save() {
    if (busy || nothingChanged) return;
    setError(null);
    setFieldErrors({});

    /*
     * Checked here because the PATCH schema cannot: a body without `discount_type` cannot tell it which
     * rule to apply. Against the coupon as it would be saved, not the fields that happen to be sent.
     */
    if (form.discount_type === FIXED_AMOUNT && !form.currency.trim()) {
      setFieldErrors({
        currency: 'A fixed-amount coupon needs a currency — the three-letter code the amount is taken off in.',
      });
      focusFirstInvalidField();
      return;
    }

    setBusy(true);
    try {
      const body = { ...changed };
      /*
       * `reason` goes to `audit_logs.reason` — `coupons` has no column for it. Sent only alongside a
       * real change: the button stays disabled until there is one, because a reason on its own would
       * record an audit entry for an edit that changed nothing.
       */
      if (form.reason.trim()) body.reason = form.reason.trim();
      const result = await api.patch<{ coupon: CouponDetail }>(`/coupons/${record.id}`, body);
      adopt(result.coupon);
      success('Coupon updated');
    } catch (caught) {
      if (caught instanceof ApiError) {
        const { perField, banner } = splitApiErrors(caught, RENDERED);
        setFieldErrors(perField);
        setError(banner);
        if (Object.keys(perField).length) focusFirstInvalidField();
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function removeCoupon() {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.delete(`/coupons/${record.id}`);
      success('Coupon deleted');
      router.push('/super-admin/coupons');
    } catch (caught) {
      setDeleteError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
      setDeleteBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={record.code}
        description={record.name ?? 'No name — the code is what a school types.'}
        action={
          <Link href="/super-admin/coupons" className="btn btn-secondary">
            Back to coupons
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={record.status} />
        <span className="text-sm text-muted">
          Redeemed {record.used_count} time(s)
          {record.remaining_uses === null ? ' · unlimited' : ` · ${record.remaining_uses} left`}
        </span>
      </div>

      {!canManage ? (
        <Notice tone="info">
          Editing a coupon needs the coupon management permission, which this account does not hold.
        </Notice>
      ) : (
        <div className="max-w-3xl space-y-8">
          <form
            className="space-y-6"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {error ? <Notice tone="error">{error}</Notice> : null}

            <FormSection title="Identity">
              <FormGrid>
                <Field
                  id="code"
                  label="Code"
                  required
                  value={form.code}
                  error={fieldErrors.code}
                  onChange={(event) => set('code', event.target.value)}
                  hint="What a school types. Uppercased by the API; changing it does not affect redemptions already made."
                />
                <Field
                  id="name"
                  label="Name"
                  value={form.name}
                  error={fieldErrors.name}
                  onChange={(event) => set('name', event.target.value)}
                />
              </FormGrid>
              <TextAreaField
                id="description"
                label="Description"
                rows={2}
                value={form.description}
                error={fieldErrors.description}
                onChange={(event) => set('description', event.target.value)}
              />
            </FormSection>

            <FormSection title="The discount">
              <FormGrid>
                <SelectField
                  id="discount_type"
                  label="Type"
                  required
                  value={form.discount_type}
                  error={fieldErrors.discount_type}
                  onChange={(event) => set('discount_type', event.target.value)}
                >
                  <option value={PERCENTAGE}>Percentage off</option>
                  <option value={FIXED_AMOUNT}>Fixed amount off</option>
                </SelectField>
                <Field
                  id="discount_value"
                  /* The unit is the label, because "50" is meaningless without it. */
                  label={isPercentage ? 'Percent off' : 'Amount off'}
                  type="number"
                  step="0.01"
                  min={0.01}
                  max={isPercentage ? 100 : undefined}
                  required
                  value={form.discount_value}
                  error={fieldErrors.discount_value}
                  onChange={(event) => set('discount_value', event.target.value)}
                />
              </FormGrid>

              <FormGrid>
                {/* Only for a fixed amount — a percentage coupon must not carry one. See the header. */}
                {isPercentage ? null : (
                  <Field
                    id="currency"
                    label="Currency"
                    required
                    maxLength={3}
                    value={form.currency}
                    error={fieldErrors.currency}
                    onChange={(event) => set('currency', event.target.value)}
                    hint="Three-letter ISO 4217 code, e.g. USD. The coupon is only redeemable against an invoice in this currency."
                  />
                )}
                <Field
                  id="max_discount_amount"
                  label="Maximum discount"
                  type="number"
                  step="0.01"
                  min={0}
                  value={form.max_discount_amount}
                  error={fieldErrors.max_discount_amount}
                  onChange={(event) => set('max_discount_amount', event.target.value)}
                  hint="Caps what a percentage can take off. Blank for no cap."
                />
              </FormGrid>

              <Field
                id="min_order_amount"
                label="Minimum invoice total"
                type="number"
                step="0.01"
                min={0}
                value={form.min_order_amount}
                error={fieldErrors.min_order_amount}
                onChange={(event) => set('min_order_amount', event.target.value)}
                hint="Below this the coupon does not apply. Blank for no floor."
              />
            </FormSection>

            <FormSection title="When and how often">
              <FormGrid>
                <Field
                  id="starts_at"
                  label="Valid from"
                  type="datetime-local"
                  value={form.starts_at}
                  error={fieldErrors.starts_at}
                  onChange={(event) => set('starts_at', event.target.value)}
                  hint="Entered in your own time zone."
                />
                <Field
                  id="expires_at"
                  label="Valid until"
                  type="datetime-local"
                  value={form.expires_at}
                  error={fieldErrors.expires_at}
                  onChange={(event) => set('expires_at', event.target.value)}
                  hint="The scheduled sweep marks the coupon expired from this, which is why expired is not a status you can set."
                />
              </FormGrid>

              <FormGrid>
                <Field
                  id="max_uses"
                  label="Maximum redemptions"
                  type="number"
                  min={1}
                  value={form.max_uses}
                  error={fieldErrors.max_uses}
                  onChange={(event) => set('max_uses', event.target.value)}
                  hint="Blank for unlimited. Cannot be lowered below what has already been redeemed."
                />
                <Field
                  id="max_uses_per_school"
                  label="Maximum per school"
                  type="number"
                  min={1}
                  value={form.max_uses_per_school}
                  error={fieldErrors.max_uses_per_school}
                  onChange={(event) => set('max_uses_per_school', event.target.value)}
                  hint="Blank for unlimited."
                />
              </FormGrid>

              <SelectField
                id="status"
                label="Status"
                required
                value={form.status}
                error={fieldErrors.status}
                onChange={(event) => set('status', event.target.value)}
                hint={
                  isExpired
                    ? 'Expired was set by the scheduled sweep when “Valid until” passed. Moving that date later does not reactivate the coupon — choose Active as well. Active on a window that has already closed is expired again by the next sweep.'
                    : 'Only these two can be set. Expired is written by the scheduled sweep once “Valid until” has passed.'
                }
              >
                {/* Shown, never chosen: without it an expired coupon's select displayed "Active". */}
                {isExpired ? (
                  <option value="expired" disabled>
                    Expired (set by the system)
                  </option>
                ) : null}
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </SelectField>
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

            <TextAreaField
              id="reason"
              label="Reason"
              rows={2}
              maxLength={255}
              value={form.reason}
              error={fieldErrors.reason}
              onChange={(event) => set('reason', event.target.value)}
              hint="Recorded in the audit trail with this change — the coupons table has no column for it and none may be added. Up to 255 characters."
            />

            <SubmitButton busy={busy} busyLabel="Saving…" fullWidth={false} disabled={nothingChanged}>
              Save changes
            </SubmitButton>
          </form>

          <FormSection
            title="Delete this coupon"
            description="Only possible while it has never been redeemed."
          >
            {record.used_count > 0 ? (
              <Notice tone="info">
                This coupon has been redeemed {record.used_count} time(s), so it cannot be deleted —
                it is part of the history of the invoices it discounted. Set its status to{' '}
                <strong>inactive</strong> above to take it out of circulation.
              </Notice>
            ) : (
              <>
                <Notice tone="warn">
                  Nothing has been redeemed against this coupon, so deleting it removes it entirely.
                </Notice>
                <div className="mt-4">
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => {
                      setConfirmDelete(true);
                      setDeleteError(null);
                    }}
                  >
                    Delete {record.code}
                  </button>
                </div>
              </>
            )}
          </FormSection>
        </div>
      )}

      <Modal
        open={confirmDelete}
        onClose={() => {
          if (!deleteBusy) setConfirmDelete(false);
        }}
        title={`Delete ${record.code}?`}
        description="The coupon is removed from the catalogue. If it has been redeemed since this screen was opened, the API refuses — a redeemed coupon is part of an invoice's history."
        size="sm"
        busy={deleteBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={deleteBusy}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={deleteBusy}
              aria-busy={deleteBusy}
              onClick={() => void removeCoupon()}
            >
              {deleteBusy ? 'Deleting…' : 'Delete coupon'}
            </button>
          </>
        }
      >
        {deleteError ? <Notice tone="error">{deleteError}</Notice> : null}
      </Modal>
    </div>
  );
}
