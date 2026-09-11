'use client';

/**
 * Applying a coupon to an invoice — FR-BILL-005's *"School applies a valid coupon to an
 * invoice/subscription"*, and SRS §13.4.
 *
 * `POST /invoices/:id/coupon` takes `{ code }` on `coupons.redeem` and the service resolves the code
 * itself, so the control is the field the API takes rather than a picker: `GET /coupons` is the
 * platform's (`coupons.view`), and a list would offer codes that fail every check anyway.
 *
 * ## When it is offered
 *
 * `invoices.service.applyCoupon()` takes a coupon only on a `draft` or `unpaid` invoice with nothing
 * paid against it and no coupon already on it — `takesCoupon()` in `billing.ts` is that test, so the
 * button is not shown where the only outcome is a refusal. A discount after money has arrived would
 * change a total the school has already settled against.
 *
 * ## The preview asks the question `applyCoupon()` will ask
 *
 * `POST /coupons/validate` writes nothing and answers with the discount, so a school can see what a
 * code is worth before spending one of its uses. It is sent what `applyCoupon()` sends
 * `validateForOrder()`: the invoice's **subtotal** — the discount comes off the subtotal, and tax is
 * worked out on what is left (`computeTotals()`) — its currency, and its `plan_id`, so a coupon
 * restricted to other plans is refused here rather than after pressing Apply. No `school_id`: the
 * controller fills in the caller's own school.
 */

import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { rowError, splitApiErrors } from '@/lib/formErrors';
import { formatCodeWithAmount } from '@/lib/money';
import { Field, Notice, SubmitButton } from '@/components/form';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';

import type { Invoice } from './billing';

/** `POST /coupons/validate` — `coupons.controller.validateCode()`. */
interface CouponCheck {
  coupon: { code: string; name: string | null; discount_type: string; discount_value: number };
  amount: number;
  discount_amount: number;
  net_amount: number;
  currency: string;
}

export type CouponableInvoice = Pick<Invoice, 'id' | 'invoice_number' | 'currency' | 'subtotal' | 'plan_id'>;

/** The one field this dialog renders an error under; `school_id`, `amount` and the rest go to the banner. */
const CODE_FIELD = new Set(['code']);

export function CouponDialog({
  invoice,
  onClose,
  onApplied,
}: {
  invoice: CouponableInvoice | null;
  onClose: () => void;
  /** Handed the invoice `POST /:id/coupon` answers with — its totals already recomputed. */
  onApplied: (invoice: Invoice) => void;
}) {
  const { success } = useToast();

  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<CouponCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | undefined>(undefined);

  const invoiceId = invoice ? invoice.id : null;
  useEffect(() => {
    if (invoiceId === null) return;
    setCode('');
    setPreview(null);
    setError(null);
    setCodeError(undefined);
    setBusy(false);
    setChecking(false);
  }, [invoiceId]);

  /*
   * Both routes validate `code` before anything else, and a 422's own message is only "Validation
   * failed" — the reason is in its details, keyed `code`. So a rejected code is put under the box, in
   * the box's own words, and any other message goes to the banner.
   */
  function report(caught: unknown) {
    if (caught instanceof ApiError) {
      const { perField, banner } = splitApiErrors(caught, CODE_FIELD);
      setCodeError(rowError(perField, 'code', 'Coupon code'));
      setError(banner);
    } else {
      setError('Could not reach the server. Check your connection and try again.');
    }
  }

  /** What the code is worth against this invoice, without applying it. */
  async function check() {
    if (!invoice || checking || code.trim() === '') return;
    setChecking(true);
    setError(null);
    setCodeError(undefined);
    setPreview(null);
    try {
      const body: Record<string, unknown> = {
        code: code.trim(),
        amount: invoice.subtotal,
        currency: invoice.currency,
      };
      if (invoice.plan_id) body.plan_id = invoice.plan_id;
      setPreview(await api.post<CouponCheck>('/coupons/validate', body));
    } catch (caught) {
      /* A refusal names the rule that failed — expired, used up, another plan — in the API's words. */
      report(caught);
    } finally {
      setChecking(false);
    }
  }

  async function apply() {
    if (!invoice || busy || code.trim() === '') return;
    setBusy(true);
    setError(null);
    setCodeError(undefined);
    try {
      const result = await api.post<{ invoice: Invoice }>(`/invoices/${invoice.id}/coupon`, { code: code.trim() });
      success(
        `Coupon ${result.invoice.coupon_code ?? code.trim().toUpperCase()} applied`,
        `${formatCodeWithAmount(result.invoice.currency, result.invoice.discount_amount)} off — the invoice now totals ${formatCodeWithAmount(result.invoice.currency, result.invoice.total)}.`
      );
      onApplied(result.invoice);
    } catch (caught) {
      /*
       * Kept inside the dialog: every refusal here is about the code or the invoice the reader is looking
       * at — a coupon already on it, a payment that arrived meanwhile — and belongs where they are.
       */
      report(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={invoice !== null}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={invoice ? `Apply a coupon to ${invoice.invoice_number}` : 'Apply a coupon'}
      description="The discount comes off the invoice’s subtotal, and tax is then worked out on what is left. One coupon per invoice."
      size="sm"
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <SubmitButton form="apply-coupon" busy={busy} busyLabel="Applying…" fullWidth={false} disabled={code.trim() === ''}>
            Apply coupon
          </SubmitButton>
        </>
      }
    >
      <form
        id="apply-coupon"
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void apply();
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}

        <Field
          id="coupon-code"
          label="Coupon code"
          required
          maxLength={60}
          value={code}
          error={codeError}
          onChange={(event) => {
            setCode(event.target.value);
            /* A preview, and a refusal, belong to the code they were fetched for. */
            setPreview(null);
            setCodeError(undefined);
          }}
          hint="Exactly as it was given to you. Whether it applies is decided by the coupon’s own rules."
        />

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={checking || busy || code.trim() === ''}
          aria-busy={checking}
          onClick={() => void check()}
        >
          {checking ? 'Checking…' : 'Check what it is worth'}
        </button>

        {preview && invoice ? (
          <Notice tone="success">
            {preview.coupon.discount_type === 'percentage'
              ? `${preview.coupon.discount_value}% off`
              : 'A fixed amount off'}{' '}
            — <strong>{formatCodeWithAmount(invoice.currency, preview.discount_amount)}</strong> off the{' '}
            {formatCodeWithAmount(invoice.currency, preview.amount)} subtotal, leaving{' '}
            {formatCodeWithAmount(invoice.currency, preview.net_amount)} before tax. Nothing is used up
            until you apply it.
          </Notice>
        ) : null}
      </form>
    </Modal>
  );
}
