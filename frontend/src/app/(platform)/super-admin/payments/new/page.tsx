'use client';

/**
 * Recording money against an invoice — SRS §13.2, FR-BILL-002 and FR-BILL-003.
 *
 * Two endpoints, two genuinely different operations, one screen:
 *
 *  - **`POST /payments/record`** (FR-BILL-002) — *"Super Admin records or charges a payment"*.
 *    Platform-only, `payments.record`, and it lands **approved**: the Super Admin recording it is
 *    the person who would otherwise be approving it. The schema accepts `online_gateway` here too,
 *    and on that method the service charges live through `services/paymentGatewayService` — which
 *    ships with **zero adapters**, so on this deployment the charge can only be refused. The option
 *    is not offered; see `METHODS`.
 *  - **`POST /payments`** (FR-BILL-003) — *"School submits a manual payment"*. It lands **pending**
 *    and joins the FR-BILL-004 review queue. Its schema refuses `online_gateway` with a message
 *    saying gateway payments are processed by the platform rather than submitted. It is also the only
 *    one that takes a **screenshot** — the proof the reviewer is told to review — and, by the owner's
 *    decision D8, it needs that screenshot or a transaction ID: a submission with neither is a pending
 *    row with nothing to review. A wallet payment is exempt, because the balance is its own evidence.
 *
 * ## Why both are here, when one of them is the school's action
 *
 * `payments.submit` is seeded to `principal`, `school_admin`, `accountant` **and** `super_admin`, so
 * a Super Admin submitting on a school's behalf is the API working as designed — a school that
 * telephones its bank transfer through is the ordinary case. What is genuinely missing is a
 * *school-side* billing surface: `invoices.self.view` and `payments.submit` reach three school roles
 * and §33's School list of seventeen names no screen for either. That is a gap in the source of the
 * same shape as academic sessions, recorded rather than invented past — a school-side screen built
 * here would be this project deciding what §33 should have said.
 *
 * ## The invoice is chosen, not typed — and can be searched for
 *
 * Both endpoints take `invoice_id` and refuse an invoice that is cancelled or already settled. The
 * picker lists what is outstanding, which is the set that can actually receive money, and shows what
 * each still owes so the amount can be checked against it. It does **not** default the amount to the
 * balance: a payment for less than the balance is the ordinary case for a part payment, and a
 * pre-filled figure is the one people fail to read.
 *
 * One page of `GET /invoices` is at most `PAGINATION.MAX_LIMIT` rows, and the picker used to take
 * that page and discard `meta` — so on a platform owing more than a hundred invoices the rest were
 * simply absent, with nothing saying so. The count is now shown when the list is short, and a search
 * box narrows it by `number`, the invoice-number filter the list schema accepts (`q` validates on this
 * endpoint and is never read — the invoices list header records why). The invoice already chosen stays
 * chosen while the search moves on.
 *
 * A failed load is said as a failure, beside the select, with a retry — it used to fall through to
 * "Nothing is outstanding", which is the one reading of an empty list that sends nobody looking.
 *
 * ## Recording more than is owed asks first
 *
 * `invoices.applyPayment()` settles an invoice on `>=` its total: an overpayment is accepted, the
 * invoice reads `paid`, and the excess is credited nowhere — it sits on the payment until a refund
 * gives it back. On the record path that is immediate and approved, so a figure above the balance is
 * confirmed before it is sent. The comparison is the only thing done with the two figures here; what
 * the excess comes to is not worked out on this side of the wire.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { splitApiErrors } from '@/lib/formErrors';
import { formatCodeWithAmount } from '@/lib/money';
import { useSchoolNames } from '@/lib/useSchoolNames';
import {
  Field,
  FileField,
  FormActions,
  FormGrid,
  FormSection,
  Notice,
  RadioGroupField,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
} from '@/components/form';
import { ConfirmDialog } from '@/components/overlay';
import { PageHeader } from '@/components/table';
import { useToast } from '@/components/toast';

/** One row of `GET /invoices`, of which this screen reads what a payment needs. */
interface InvoiceOption {
  id: number;
  invoice_number: string;
  school_id: number;
  currency: string;
  total: number;
  amount_due: number;
  status: string;
}

/** What `POST /payments/record` answers — `payments.controller.js record()`. */
interface RecordResult {
  payment: { payment_number: string; review_note: string | null };
  /** `invoices.applyPayment()`'s result, or `null` when nothing was applied. */
  settlement: { status: string } | null;
  /** True when a gateway charge was declined: the payment exists, as `failed`, and settled nothing. */
  gateway_failed: boolean;
}

/**
 * The methods this screen offers, on either path.
 *
 * `config/constants.js` has five. `online_gateway` is left out of both:
 *
 *   - a **submission** refuses it in the schema — gateway payments are the platform's to process;
 *   - a **record** accepts it and dispatches a live charge through the gateway registry, which ships
 *     with no adapter registered, so the charge is refused with `PAYMENT_GATEWAY_NOT_CONFIGURED`
 *     every time. No endpoint reports whether an adapter exists (`paymentGatewayService.methods()`
 *     answers exactly that and has no route), so the screen cannot grey the option out on demand —
 *     and offering a method that can only fail is offering a refusal. Add it back here when an
 *     adapter is registered.
 *
 * So the two paths offer the same four, and the API still refuses anything else.
 */
const METHODS = ['cash', 'bank_transfer', 'manual_payment', 'wallet'];

/** `PAGINATION.MAX_LIMIT` — the most one page of `GET /invoices` will return. */
const OPTION_LIMIT = 100;

/** Every field this form renders an error under. Anything else a 422 names goes to the banner. */
const RENDERED = new Set([
  'invoice_id',
  'amount',
  'method',
  'transaction_id',
  'reference',
  'paid_at',
  'payer_note',
  'screenshot',
  'reason',
]);

const spell = (value: string) => value.replace(/_/g, ' ');

/** An amount as whole minor units, for comparing — `null` when the text is not a number. */
function toMinor(value: number | string): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

export default function NewPaymentPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success, error: toastError } = useToast();
  const { nameFor } = useSchoolNames();

  const canRecord = can('payments.record');
  const canSubmit = can('payments.submit');

  /* Whichever the account can actually do; the record path first, being the platform's own. */
  const [mode, setMode] = useState<'record' | 'submit'>(canRecord ? 'record' : 'submit');

  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [invoicesTotal, setInvoicesTotal] = useState<number | null>(null);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [loadingInvoices, setLoadingInvoices] = useState(true);
  const [invoicesNonce, setInvoicesNonce] = useState(0);
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [invoiceQuery, setInvoiceQuery] = useState('');

  /*
   * The chosen invoice itself, not just its id. The search replaces the options under the select, and
   * an id alone would stop resolving the moment the chosen row scrolled out of the result set.
   */
  const [invoice, setInvoice] = useState<InvoiceOption | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [transactionId, setTransactionId] = useState('');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [payerNote, setPayerNote] = useState('');
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [reason, setReason] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmOverpay, setConfirmOverpay] = useState(false);

  /* The list pages' debounce: `apiLimiter` sits in front of authentication, so a keystroke is not free. */
  useEffect(() => {
    const timer = setTimeout(() => setInvoiceQuery(invoiceSearch.trim()), 300);
    return () => clearTimeout(timer);
  }, [invoiceSearch]);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingInvoices(true);
    setInvoicesError(null);
    (async () => {
      try {
        /* `outstanding` is the API's own name for "still owed", and it is a string on the wire. */
        const result = await api.page<InvoiceOption[]>('/invoices', {
          query: { outstanding: 'true', limit: OPTION_LIMIT, number: invoiceQuery || undefined },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setInvoices(result.data ?? []);
        setInvoicesTotal(result.meta?.total ?? null);
      } catch (caught) {
        if (controller.signal.aborted || (caught as Error)?.name === 'AbortError') return;
        setInvoices([]);
        setInvoicesTotal(null);
        setInvoicesError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not load the outstanding invoices. Check your connection and try again.'
        );
      } finally {
        if (!controller.signal.aborted) setLoadingInvoices(false);
      }
    })();
    return () => controller.abort();
  }, [invoiceQuery, invoicesNonce]);

  /* The chosen invoice stays selectable even when the current search does not return it. */
  const options =
    invoice && !invoices.some((row) => row.id === invoice.id) ? [invoice, ...invoices] : invoices;

  const amountMinor = amount.trim() === '' ? null : toMinor(amount.trim());
  const dueMinor = invoice ? toMinor(invoice.amount_due) : null;
  const overpays = amountMinor !== null && dueMinor !== null && amountMinor > dueMinor;

  /** The two checks that happen before anything is sent, then either a confirmation or the request. */
  function requestSave() {
    if (busy || !invoice) return;
    setError(null);
    setFieldErrors({});

    /*
     * D8, in submit mode only: the record path is the platform asserting the money arrived and needs
     * no evidence from itself. The server refuses the same case with `PAYMENT_EVIDENCE_REQUIRED`; this
     * says it under the field, before a screenshot has been uploaded for nothing.
     */
    if (mode === 'submit' && method !== 'wallet' && !transactionId.trim() && !screenshot) {
      setFieldErrors({
        transaction_id:
          'Enter the transaction ID or attach a screenshot below — the reviewer needs one of the two to check.',
      });
      focusFirstInvalidField();
      return;
    }

    if (mode === 'record' && overpays) {
      setConfirmOverpay(true);
      return;
    }

    void save();
  }

  async function save() {
    if (busy || !invoice) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const common: Record<string, unknown> = {
        invoice_id: invoice.id,
        amount: amount.trim(),
        method,
      };
      if (transactionId.trim()) common.transaction_id = transactionId.trim();
      if (reference.trim()) common.reference = reference.trim();
      if (paidAt) common.paid_at = paidAt;
      if (payerNote.trim()) common.payer_note = payerNote.trim();
      if (reason.trim()) common.reason = reason.trim();

      if (mode === 'record') {
        const result = await api.post<RecordResult>('/payments/record', common);
        /*
         * A declined gateway charge is a 201, not an error: the payment is written as `failed` and the
         * invoice is untouched. No gateway method is offered today, so this should not happen — but a
         * "Payment recorded" toast over a failed charge is the one outcome worse than not checking.
         */
        if (result.gateway_failed) {
          toastError(
            'The charge was declined',
            `${result.payment.payment_number} is recorded as failed${
              result.payment.review_note ? ` — ${result.payment.review_note}` : ''
            }. Nothing was applied to the invoice.`
          );
          router.push('/super-admin/payments');
          return;
        }
        success(
          'Payment recorded',
          result.settlement
            ? `It is approved, and the invoice is now ${spell(result.settlement.status)}.`
            : 'It is approved.'
        );
      } else {
        /*
         * Multipart, because FR-BILL-003's screenshot is a file. `uploadSingle` parses the body
         * before `validate()` runs, so every scalar has to travel as a form field — which is why
         * this cannot reuse the JSON path above even for a submission with no screenshot attached.
         */
        const form = new FormData();
        for (const [key, value] of Object.entries(common)) form.append(key, String(value));
        if (screenshot) form.append('screenshot', screenshot);
        /*
         * `formData` is an *option*, not the body: `apiClient` sets no `Content-Type` for it so the
         * browser can choose the multipart boundary, which it cannot do if the header is already
         * set. Passing the form as the second argument would have JSON-stringified it into `{}`.
         */
        await api.post('/payments', undefined, { formData: form });
        success('Payment submitted', 'It is pending and now sits in the review queue.');
      }
      router.push('/super-admin/payments');
    } catch (caught) {
      if (caught instanceof ApiError) {
        /*
         * A conflict's object-shaped `details` is dropped by `ApiError` itself now, so its message
         * reaches the banner; a 422 naming a field this form renders lands under that field.
         */
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

  if (!canRecord && !canSubmit) {
    return (
      <div>
        <PageHeader title="Record a payment" description="" />
        <Notice tone="info">
          Recording or submitting a payment needs one of two permissions, and this account holds
          neither.
        </Notice>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={mode === 'record' ? 'Record a payment' : 'Submit a payment'}
        description="Money against an outstanding invoice."
        action={
          <Link href="/super-admin/payments" className="btn btn-secondary">
            Back to payments
          </Link>
        }
      />

      <form
        className="max-w-2xl space-y-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          requestSave();
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}

        {canRecord && canSubmit ? (
          <FormSection
            title="Which of the two"
            description="They differ in who is asserting that the money arrived, and the API treats them differently because of it."
          >
            <RadioGroupField
              name="mode"
              legend="Kind"
              value={mode}
              onChange={(value) => setMode(value as 'record' | 'submit')}
              options={[
                {
                  value: 'record',
                  label: 'Record it (FR-BILL-002)',
                  hint: 'The platform confirms the money arrived. It lands approved and settles the invoice immediately.',
                },
                {
                  value: 'submit',
                  label: 'Submit it for review (FR-BILL-003)',
                  hint: 'What a school does. It lands pending, carries a transaction ID or a screenshot as proof, and waits in the review queue.',
                },
              ]}
            />
          </FormSection>
        ) : null}

        <FormSection title="The invoice" description="Only invoices with something still owed can receive money.">
          <Field
            id="invoice_search"
            label="Find an invoice"
            type="search"
            maxLength={40}
            value={invoiceSearch}
            onChange={(event) => setInvoiceSearch(event.target.value)}
            placeholder="Part of an invoice number…"
            hint="Narrows the list below by invoice number."
          />

          <div>
            <SelectField
              id="invoice_id"
              width="md"
              label="Invoice"
              required
              value={invoice ? String(invoice.id) : ''}
              /* A failed lookup is an error, not a hint: without the list the field cannot be filled. */
              error={fieldErrors.invoice_id || invoicesError}
              onChange={(event) =>
                setInvoice(options.find((row) => String(row.id) === event.target.value) ?? null)
              }
              hint={
                loadingInvoices
                  ? 'Loading outstanding invoices…'
                  : options.length === 0
                    ? invoiceQuery
                      ? `No outstanding invoice number matches “${invoiceQuery}”.`
                      : 'Nothing is outstanding, so there is nothing to pay against.'
                    : invoicesTotal !== null && invoicesTotal > invoices.length
                      ? `Showing ${invoices.length} of ${invoicesTotal} outstanding invoices — search above for the one you want.`
                      : 'The amount owed is shown beside each so a part payment can be checked against it.'
              }
            >
              <option value="">Choose an invoice…</option>
              {options.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.invoice_number} — {nameFor(row.school_id)} —{' '}
                  {formatCodeWithAmount(row.currency, row.amount_due)} due
                </option>
              ))}
            </SelectField>
            {invoicesError ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm mt-2"
                onClick={() => setInvoicesNonce((n) => n + 1)}
              >
                Try again
              </button>
            ) : null}
          </div>

          {invoice ? (
            <Notice tone="info">
              {formatCodeWithAmount(invoice.currency, invoice.amount_due)} still owed of{' '}
              {formatCodeWithAmount(invoice.currency, invoice.total)}. The payment’s currency is taken
              from the invoice — it is not a field here, because a payment in a different currency
              from the invoice it settles is a conversion this system does not do.
            </Notice>
          ) : null}
        </FormSection>

        <FormSection title="The money">
          <FormGrid>
            <Field
              id="amount"
              width="sm"
              label="Amount"
              type="number"
              step="0.01"
              min={0}
              required
              value={amount}
              error={fieldErrors.amount}
              onChange={(event) => setAmount(event.target.value)}
              hint="May be less than the balance — a part payment leaves the invoice partially paid."
            />
            <SelectField
              id="method"
              width="sm"
              label="Method"
              required
              value={method}
              error={fieldErrors.method}
              onChange={(event) => setMethod(event.target.value)}
              hint={
                mode === 'submit'
                  ? 'Online gateway is absent deliberately: those are processed by the platform, not submitted.'
                  : 'Online gateway is not offered: no payment gateway is connected on this deployment, so a charge could only be refused.'
              }
            >
              {METHODS.map((value) => (
                <option key={value} value={value}>
                  {spell(value)}
                </option>
              ))}
            </SelectField>
          </FormGrid>

          {overpays && invoice ? (
            <Notice tone="warn">
              This is more than the {formatCodeWithAmount(invoice.currency, invoice.amount_due)} still
              owed. The invoice will read paid, and the excess is not credited anywhere — it stays on
              this payment until a refund gives it back.
            </Notice>
          ) : null}

          <FormGrid>
            <Field
              id="transaction_id"
              width="md"
              label="Transaction ID"
              value={transactionId}
              error={fieldErrors.transaction_id}
              onChange={(event) => setTransactionId(event.target.value)}
              hint={
                mode === 'submit'
                  ? method === 'wallet'
                    ? 'Not needed for a wallet payment — the balance is its own record.'
                    : 'Required unless a screenshot is attached below. What FR-BILL-004 asks the reviewer to check.'
                  : 'The bank reference, where there is one.'
              }
            />
            <Field
              id="paid_at"
              width="sm"
              label="Paid on"
              type="date"
              value={paidAt}
              error={fieldErrors.paid_at}
              onChange={(event) => setPaidAt(event.target.value)}
              hint="When the money moved, if that is not today."
            />
          </FormGrid>

          <Field
            id="reference"
            width="md"
            label="Reference"
            value={reference}
            error={fieldErrors.reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </FormSection>

        {mode === 'submit' ? (
          <FormSection
            title="Proof"
            description="FR-BILL-004 tells the reviewer to review the transaction ID and the screenshot. Without one they have only the number."
          >
            <FileField
              id="screenshot"
              label="Screenshot"
              accept="image/png,image/jpeg,image/webp"
              file={screenshot}
              error={fieldErrors.screenshot}
              onChange={(file) => setScreenshot(file)}
              hint="An image of the receipt. A submission needs this or a transaction ID — one of the two, so the reviewer has something to check. A wallet payment needs neither."
            />
          </FormSection>
        ) : null}

        <FormSection title="Notes">
          <TextAreaField
            id="payer_note"
            label="Payer note"
            rows={2}
            value={payerNote}
            error={fieldErrors.payer_note}
            onChange={(event) => setPayerNote(event.target.value)}
            hint="Travels with the payment and is shown to whoever reviews it."
          />
          <TextAreaField
            id="reason"
            label="Reason"
            rows={2}
            value={reason}
            error={fieldErrors.reason}
            onChange={(event) => setReason(event.target.value)}
            hint="Recorded in the audit trail."
          />
        </FormSection>

        <FormActions cancelHref="/super-admin/payments">
          <SubmitButton
            busy={busy}
            busyLabel={mode === 'record' ? 'Recording…' : 'Submitting…'}
            fullWidth={false}
            disabled={!invoice || amount.trim() === ''}
          >
            {mode === 'record' ? 'Record payment' : 'Submit payment'}
          </SubmitButton>
        </FormActions>
      </form>

      <ConfirmDialog
        open={confirmOverpay}
        onCancel={() => setConfirmOverpay(false)}
        onConfirm={async () => {
          setConfirmOverpay(false);
          await save();
        }}
        title="Record more than is owed?"
        description={
          invoice
            ? `${formatCodeWithAmount(invoice.currency, amount.trim())} is more than the ${formatCodeWithAmount(invoice.currency, invoice.amount_due)} still owed on ${invoice.invoice_number}. Recording it approves it at once: the invoice reads paid, and the excess is credited nowhere — it stays on this payment until a refund gives it back.`
            : ''
        }
        confirmLabel="Record anyway"
        tone="default"
      />
    </div>
  );
}
