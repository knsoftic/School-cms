'use client';

/**
 * Paying an invoice — FR-BILL-003 and SRS §13.3's School half: *submit payment, enter transaction ID,
 * upload screenshot, payment becomes pending*.
 *
 * `POST /payments` on `payments.submit`, multipart, with the image in the field `payments.routes.js`
 * names — `uploadSingle(UPLOAD_PROFILES.PAYMENT_PROOF, 'screenshot', …)`. Its schema is
 * `payments.validation.js` `submit`: `invoice_id`, `amount` and `method` required; `transaction_id`,
 * `reference`, `payer_note` and `paid_at` optional; `currency` optional and left unsent, so the payment
 * takes the invoice's own currency — nothing in the platform converts one into another, and a payment
 * naming a different one is refused with `PAYMENT_CURRENCY_MISMATCH`.
 *
 * ## One of the two pieces of evidence is required
 *
 * The owner's decision D8: a transaction id **or** a screenshot, and a submission with neither is
 * refused (`PAYMENT_EVIDENCE_REQUIRED`) because FR-BILL-004's reviewer would have nothing to check. A
 * wallet payment is exempt — the balance is its own record (D5). The same test runs here first, so
 * nobody uploads a file only to be told about a missing reference.
 *
 * ## Four methods, not five
 *
 * `online_gateway` is refused by the schema — a gateway payment is the platform's to process, not a
 * school's to submit. The other four are offered in the order a school is likeliest to use them.
 *
 * ## It does not settle the invoice, and says so
 *
 * A submission is always `pending`: a school does not approve its own money. The invoice's figures
 * move only when the platform approves it under FR-BILL-004, so the confirmation says "pending review"
 * and the caller keeps the pending payment on screen rather than implying the invoice is paid.
 *
 * The amount is not pre-filled — the platform's payment form argues why: a part payment is ordinary,
 * and a pre-filled figure is the one people fail to read. The balance is one click away instead.
 */

import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { rowError, splitApiErrors } from '@/lib/formErrors';
import { formatCodeWithAmount } from '@/lib/money';
import {
  Field,
  FileField,
  FormGrid,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
} from '@/components/form';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';

import { SUBMITTABLE_METHODS, methodLabel } from './billing';
import type { Invoice, SubmittedPayment } from './billing';

/** The fields the dialog reads off an invoice — a list row and the detail read both carry them. */
export type PayableInvoice = Pick<Invoice, 'id' | 'invoice_number' | 'currency' | 'total' | 'amount_due' | 'payments'>;

/** Every field this form shows an error under. Anything else a 422 names goes to the banner. */
const RENDERED = new Set(['amount', 'method', 'transaction_id', 'reference', 'paid_at', 'payer_note', 'screenshot']);

/** The image types `UPLOAD_PROFILES.PAYMENT_PROOF` accepts — `UPLOAD_IMAGE_MIMES`. */
const PROOF_TYPES = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';

/** An amount as whole minor units, for the one comparison made here — `null` when it is not a number. */
function toMinor(value: number | string): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

export function PayDialog({
  invoice,
  walletBalance,
  onClose,
  onSubmitted,
}: {
  /** The invoice being paid, or null when the dialog is closed. */
  invoice: PayableInvoice | null;
  /**
   * The subscription's wallet, when this account can read the subscription — so a wallet payment the
   * balance cannot cover is flagged before it is sent. Null for an account that cannot (an
   * Accountant): the API still refuses a short balance with `WALLET_INSUFFICIENT`.
   */
  walletBalance: number | null;
  onClose: () => void;
  onSubmitted: (payment: SubmittedPayment) => void;
}) {
  const { success } = useToast();

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [transactionId, setTransactionId] = useState('');
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [paidAt, setPaidAt] = useState('');
  const [reference, setReference] = useState('');
  const [payerNote, setPayerNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /* A fresh form for every invoice opened, so one invoice's half-typed reference never reaches another. */
  const invoiceId = invoice ? invoice.id : null;
  useEffect(() => {
    if (invoiceId === null) return;
    setAmount('');
    setMethod('bank_transfer');
    setTransactionId('');
    setScreenshot(null);
    setPaidAt('');
    setReference('');
    setPayerNote('');
    setError(null);
    setFieldErrors({});
    setBusy(false);
  }, [invoiceId]);

  const isWallet = method === 'wallet';
  const amountMinor = amount.trim() === '' ? null : toMinor(amount.trim());
  const dueMinor = invoice ? toMinor(invoice.amount_due) : null;
  const overpays = amountMinor !== null && dueMinor !== null && amountMinor > dueMinor;
  const walletMinor = walletBalance === null ? null : toMinor(walletBalance);
  const walletShort = isWallet && amountMinor !== null && walletMinor !== null && amountMinor > walletMinor;

  /*
   * A submission waiting for review has not moved the invoice's figures, so "still owed" does not count
   * it. Said before a second one is sent, because the likeliest duplicate payment is the one submitted
   * again by someone who saw the invoice still reading unpaid.
   */
  const pending = (invoice?.payments ?? []).filter((payment) => payment.status === 'pending');

  /*
   * The inputs carry `pay-` ids, because this dialog opens over screens with fields of their own, and the
   * server keys its messages by body field — so the label is put into the message here, where the key is
   * still known, rather than by the field wrapper, which can only match its own id.
   */
  const errorFor = (field: string, label: string) => rowError(fieldErrors, field, label);

  async function submit() {
    if (!invoice || busy) return;
    setError(null);
    setFieldErrors({});

    /* D8, before anything is uploaded — the server refuses the same case with PAYMENT_EVIDENCE_REQUIRED. */
    if (!isWallet && !transactionId.trim() && !screenshot) {
      setFieldErrors({
        transaction_id: 'Enter the transaction ID or attach a screenshot below — the reviewer needs one of the two to check.',
      });
      focusFirstInvalidField();
      return;
    }

    setBusy(true);
    try {
      /*
       * Multipart even without a file: `uploadSingle` parses the body before `validate()` runs, so every
       * scalar travels as a form field. `formData` is an option, not the body — `apiClient` then sets no
       * `Content-Type`, and the browser writes the multipart boundary itself.
       */
      const form = new FormData();
      form.append('invoice_id', String(invoice.id));
      form.append('amount', amount.trim());
      form.append('method', method);
      if (transactionId.trim()) form.append('transaction_id', transactionId.trim());
      if (reference.trim()) form.append('reference', reference.trim());
      /* A `YYYY-MM-DD`, as the platform's payment form sends it: payments are shown as UTC days. */
      if (paidAt) form.append('paid_at', paidAt);
      if (payerNote.trim()) form.append('payer_note', payerNote.trim());
      /* Not for a wallet payment, whose picker is hidden: a file chosen before switching is not sent unseen. */
      if (screenshot && !isWallet) form.append('screenshot', screenshot);

      const result = await api.post<{ payment: SubmittedPayment }>('/payments', undefined, { formData: form });
      success(
        `Payment ${result.payment.payment_number} submitted`,
        'It is pending until the platform reviews it, and counts towards the invoice once it is approved.'
      );
      onSubmitted(result.payment);
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

  return (
    <Modal
      open={invoice !== null}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={invoice ? `Pay invoice ${invoice.invoice_number}` : 'Pay an invoice'}
      description="Tell the platform about a payment you have made. It is reviewed before it counts towards the invoice."
      size="lg"
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <SubmitButton form="pay-invoice" busy={busy} busyLabel="Submitting…" fullWidth={false} disabled={amount.trim() === ''}>
            Submit payment
          </SubmitButton>
        </>
      }
    >
      <form
        id="pay-invoice"
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}

        {invoice ? (
          <p className="text-sm text-muted">
            {formatCodeWithAmount(invoice.currency, invoice.amount_due)} still owed of{' '}
            {formatCodeWithAmount(invoice.currency, invoice.total)}. The payment is taken in the
            invoice’s currency, {invoice.currency}.
          </p>
        ) : null}

        {invoice && pending.length > 0 ? (
          <Notice tone="warn">
            {pending.length === 1
              ? `Payment ${pending[0].payment_number} of ${formatCodeWithAmount(pending[0].currency, pending[0].amount)} is already waiting for review on this invoice, and is not counted in what is still owed until it is approved.`
              : `${pending.length} payments are already waiting for review on this invoice, and are not counted in what is still owed until they are approved.`}{' '}
            Submit another only if it is a separate payment.
          </Notice>
        ) : null}

        <FormGrid>
          <div>
            <Field
              id="pay-amount"
              label="Amount"
              type="number"
              step="0.01"
              min={0}
              required
              value={amount}
              error={errorFor('amount', 'Amount')}
              onChange={(event) => setAmount(event.target.value)}
              hint="May be less than what is owed — a part payment leaves the invoice partially paid."
            />
            {invoice && Number(invoice.amount_due) > 0 ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm mt-1"
                onClick={() => setAmount(String(invoice.amount_due))}
              >
                Use the {formatCodeWithAmount(invoice.currency, invoice.amount_due)} owed
              </button>
            ) : null}
          </div>
          <SelectField
            id="pay-method"
            label="Method"
            required
            value={method}
            error={errorFor('method', 'Method')}
            onChange={(event) => setMethod(event.target.value)}
            hint={
              walletBalance !== null
                ? `The wallet holds ${formatCodeWithAmount(invoice?.currency ?? null, walletBalance)}. Online payments are taken by the platform, not submitted here.`
                : 'Online payments are taken by the platform, not submitted here.'
            }
          >
            {SUBMITTABLE_METHODS.map((value) => (
              <option key={value} value={value}>
                {methodLabel(value)}
              </option>
            ))}
          </SelectField>
        </FormGrid>

        {overpays && invoice ? (
          <Notice tone="warn">
            This is more than the {formatCodeWithAmount(invoice.currency, invoice.amount_due)} still owed.
            If it is approved the invoice reads paid, and the excess is not credited anywhere.
          </Notice>
        ) : null}
        {walletShort ? (
          <Notice tone="warn">
            The wallet holds less than this, and a wallet payment the balance cannot cover is refused.
          </Notice>
        ) : null}

        <FormGrid>
          <Field
            id="pay-transaction-id"
            label="Transaction ID"
            maxLength={160}
            value={transactionId}
            error={errorFor('transaction_id', 'Transaction ID')}
            onChange={(event) => setTransactionId(event.target.value)}
            hint={
              isWallet
                ? 'Not needed for a wallet payment — the balance is its own record.'
                : 'The bank or receipt reference. Needed unless a screenshot is attached.'
            }
          />
          <Field
            id="pay-paid-at"
            label="Paid on"
            type="date"
            value={paidAt}
            error={errorFor('paid_at', 'Paid on')}
            onChange={(event) => setPaidAt(event.target.value)}
            hint="When the money moved, if that was not today."
          />
        </FormGrid>

        {isWallet ? null : (
          <FileField
            id="pay-screenshot"
            label="Screenshot"
            accept={PROOF_TYPES}
            acceptLabel="PNG, JPEG or WEBP"
            file={screenshot}
            error={errorFor('screenshot', 'Screenshot')}
            busy={busy}
            onChange={(file) => setScreenshot(file)}
            hint="An image of the receipt or transfer. Needed unless a transaction ID is entered."
          />
        )}

        <Field
          id="pay-reference"
          label="Reference"
          maxLength={160}
          value={reference}
          error={errorFor('reference', 'Reference')}
          onChange={(event) => setReference(event.target.value)}
        />

        <TextAreaField
          id="pay-payer-note"
          label="Note for the reviewer"
          rows={2}
          maxLength={500}
          value={payerNote}
          error={errorFor('payer_note', 'Note for the reviewer')}
          onChange={(event) => setPayerNote(event.target.value)}
          hint="Up to 500 characters. Shown to whoever reviews the payment."
        />
      </form>
    </Modal>
  );
}
