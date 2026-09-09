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
 * ## `status` accepts two of its four values
 *
 * `active` and `inactive` are settable. `expired` is written by the scheduled sweep from
 * `expires_at`, and the schema's own message says so — a select offering it would be offering a
 * state the API will not take. `used_up` is likewise derived. So the control has exactly two
 * options and the other two are explained where they appear on the record.
 *
 * ## The discount rules are cross-field, and the API is the one that checks them
 *
 * A percentage above 100, a fixed amount with no currency, a window that ends before it starts —
 * `checkCoherence` refuses all three at object level, and the messages name the pair rather than one
 * field. So this form does not re-implement them: it renders `error.details` where they land and
 * shows the banner for anything with no field of its own. The one thing it does do is swap the
 * discount field's unit as the type changes, because "50" means half off or fifty pounds off and the
 * label is the only thing that says which.
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import {
  Field,
  FormGrid,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
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

/** `GET /coupons/:id` — the row plus the two derived fields `present()` adds. */
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
 */
type FormValues = ReturnType<typeof toValues>;

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
];

export default function CouponDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : null;

  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();

  const [coupon, setCoupon] = useState<CouponDetail | null>(null);
  const [values, setValues] = useState<FormValues | null>(null);
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

  const base = toValues(record);
  const changed: Record<string, unknown> = {};
  for (const key of FIELDS as (keyof FormValues)[]) {
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
    changed[key] = raw === '' ? null : raw;
  }
  const nothingChanged = Object.keys(changed).length === 0;

  async function save() {
    if (busy || nothingChanged) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const body = { ...changed };
      if (form.reason.trim()) body.reason = form.reason.trim();
      const result = await api.patch<{ coupon: CouponDetail }>(`/coupons/${record.id}`, body);
      setCoupon(result.coupon);
      setValues(toValues(result.coupon));
      success('Coupon updated');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(Array.isArray(caught.details) ? caught.fieldErrors() : {});
        setError(Array.isArray(caught.details) ? caught.bannerFor(FIELDS) : caught.message);
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

  const isPercentage = form.discount_type === 'percentage';

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
                  <option value="percentage">Percentage off</option>
                  <option value="fixed_amount">Fixed amount off</option>
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
                <Field
                  id="currency"
                  label="Currency"
                  value={form.currency}
                  error={fieldErrors.currency}
                  onChange={(event) => set('currency', event.target.value)}
                  hint={
                    isPercentage
                      ? 'Not needed for a percentage — it applies whatever the invoice is in.'
                      : 'Required for a fixed amount: the API refuses a fixed discount with no currency to be fixed in.'
                  }
                />
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
                hint="Only these two can be set. Expired and used up are written by the system from the window and the redemption count."
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </SelectField>
            </FormSection>

            <TextAreaField
              id="reason"
              label="Reason"
              rows={2}
              value={form.reason}
              onChange={(event) => set('reason', event.target.value)}
              hint="Recorded in the audit trail — the coupons table has no column for it and none may be added."
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
