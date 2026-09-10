'use client';

/**
 * Recording money against an invoice — SRS §13.2, FR-BILL-002 and FR-BILL-003.
 *
 * Two endpoints, two genuinely different operations, one screen:
 *
 *  - **`POST /payments/record`** (FR-BILL-002) — *"Super Admin records or charges a payment"*.
 *    Platform-only, `payments.record`, and it lands **approved**: the Super Admin recording it is
 *    the person who would otherwise be approving it. Every method is available, including
 *    `online_gateway`, because the platform is what processes those.
 *  - **`POST /payments`** (FR-BILL-003) — *"School submits a manual payment"*. It lands **pending**
 *    and joins the FR-BILL-004 review queue. Its method list is narrower by design: the schema
 *    refuses `online_gateway` with a message saying gateway payments are processed by the platform
 *    rather than submitted. It is also the only one that takes a **screenshot** — the proof the
 *    reviewer is told to review.
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
 * ## The invoice is chosen, not typed
 *
 * Both endpoints take `invoice_id` and refuse an invoice that is cancelled or already settled. The
 * picker lists what is outstanding, which is the set that can actually receive money, and shows what
 * each still owes so the amount can be checked against it. It does **not** default the amount to the
 * balance: a payment for less than the balance is the ordinary case for a part payment, and a
 * pre-filled figure is the one people fail to read.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
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
} from '@/components/form';
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

/**
 * The methods each endpoint accepts.
 *
 * `PAYMENT_METHOD_LIST` for the platform record; `SUBMITTABLE_METHODS` — the same list minus
 * `online_gateway` — for a school submission. Both are mirrored from `config/constants.js` and the
 * schema refuses anything else, so the difference between the two selects is the difference the API
 * actually enforces rather than a distinction drawn here.
 */
const RECORD_METHODS = ['cash', 'bank_transfer', 'manual_payment', 'online_gateway', 'wallet'];
const SUBMIT_METHODS = ['cash', 'bank_transfer', 'manual_payment', 'wallet'];

const spell = (value: string) => value.replace(/_/g, ' ');

export default function NewPaymentPage() {
  const router = useRouter();
  const { can } = useAuth();
  const { success } = useToast();
  const { nameFor } = useSchoolNames();

  const canRecord = can('payments.record');
  const canSubmit = can('payments.submit');

  /* Whichever the account can actually do; the record path first, being the platform's own. */
  const [mode, setMode] = useState<'record' | 'submit'>(canRecord ? 'record' : 'submit');

  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [loadingInvoices, setLoadingInvoices] = useState(true);

  const [invoiceId, setInvoiceId] = useState('');
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

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        /* `outstanding` is the API's own name for "still owed", and it is a string on the wire. */
        const result = await api.page<InvoiceOption[]>('/invoices', {
          query: { outstanding: 'true', limit: 100 },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setInvoices(result.data);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setInvoicesError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not load the outstanding invoices.'
        );
      } finally {
        if (!controller.signal.aborted) setLoadingInvoices(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const invoice = useMemo(
    () => invoices.find((row) => String(row.id) === invoiceId) ?? null,
    [invoices, invoiceId]
  );

  /* Switching mode can strand a method the other endpoint refuses. */
  useEffect(() => {
    if (mode === 'submit' && method === 'online_gateway') setMethod('bank_transfer');
  }, [mode, method]);

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
        await api.post('/payments/record', common);
        success('Payment recorded', 'It is approved, and the invoice has been settled by that much.');
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
         * Guarded, for the reason the subscription create screen records: these endpoints answer
         * with two shapes of `details` — an array of field errors from a 422, and a plain object
         * from a conflict — and `fieldErrors()` iterates, so an unguarded call throws inside this
         * catch and leaves the button spinning with nothing on screen.
         */
        setFieldErrors(Array.isArray(caught.details) ? caught.fieldErrors() : {});
        setError(
          Array.isArray(caught.details)
            ? caught.bannerFor([
                'invoice_id',
                'amount',
                'method',
                'transaction_id',
                'reference',
                'paid_at',
                'payer_note',
                'screenshot',
              ])
            : caught.message
        );
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

  const methods = mode === 'record' ? RECORD_METHODS : SUBMIT_METHODS;

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
          void save();
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        {invoicesError ? <Notice tone="error">{invoicesError}</Notice> : null}

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
                  hint: 'What a school does. It lands pending, carries a screenshot as proof, and waits in the review queue.',
                },
              ]}
            />
          </FormSection>
        ) : null}

        <FormSection title="The invoice" description="Only invoices with something still owed can receive money.">
          <SelectField
            id="invoice_id"
            label="Invoice"
            required
            value={invoiceId}
            error={fieldErrors.invoice_id}
            onChange={(event) => setInvoiceId(event.target.value)}
            hint={
              loadingInvoices
                ? 'Loading outstanding invoices…'
                : invoices.length === 0
                  ? 'Nothing is outstanding, so there is nothing to pay against.'
                  : 'The amount owed is shown beside each so a part payment can be checked against it.'
            }
          >
            <option value="">Choose an invoice…</option>
            {invoices.map((row) => (
              <option key={row.id} value={row.id}>
                {row.invoice_number} — {nameFor(row.school_id)} —{' '}
                {formatCodeWithAmount(row.currency, row.amount_due)} due
              </option>
            ))}
          </SelectField>

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
              label="Method"
              required
              value={method}
              error={fieldErrors.method}
              onChange={(event) => setMethod(event.target.value)}
              hint={
                mode === 'submit'
                  ? 'Online gateway is absent deliberately: those are processed by the platform, not submitted.'
                  : undefined
              }
            >
              {methods.map((value) => (
                <option key={value} value={value}>
                  {spell(value)}
                </option>
              ))}
            </SelectField>
          </FormGrid>

          <FormGrid>
            <Field
              id="transaction_id"
              label="Transaction ID"
              value={transactionId}
              error={fieldErrors.transaction_id}
              onChange={(event) => setTransactionId(event.target.value)}
              hint={
                mode === 'submit'
                  ? 'What FR-BILL-004 asks the reviewer to check, alongside the screenshot.'
                  : 'The bank or gateway reference, where there is one.'
              }
            />
            <Field
              id="paid_at"
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
    </div>
  );
}
