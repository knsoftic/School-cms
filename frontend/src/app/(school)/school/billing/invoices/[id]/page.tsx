'use client';

/**
 * One of the school's invoices — SRS §13.1 and FR-BILL-001, with the two things a school does to one:
 * pay it (FR-BILL-003) and apply a coupon to it (FR-BILL-005).
 *
 * `GET /invoices/:id` on `invoices.self.view`. `findById()` folds the tenant scope into its `where`, so
 * another school's invoice is a 404 exactly like one that does not exist.
 *
 * ## Every §13.1 field, once
 *
 * FR-BILL-001: *"Invoice Number, School, Plan, Add-ons, Billing Period, Subtotal, Discount, Tax, Total,
 * Due Date, and Status"*. The number is the heading and the status the badge beside it; School, Plan,
 * Add-ons, Billing Period and Due Date are the first section; Subtotal, Discount, Tax and Total are the
 * breakdown, in the order `computeTotals()` works them out — tax is charged on the discounted subtotal,
 * and an inclusive tax is already inside the prices, so it is shown and not added. What has happened
 * since — credit, payments, the balance — is kept apart, because it is not §13.1's and does not add up
 * to the total. Then the lines, then the payments made against it.
 *
 * The School field is the school's own name for the owner's decision D35 — `useSchoolBrand()`, which
 * reads it off the profile every school role receives. "Your school" stands in only for a caller with
 * no school in scope, and is still true then: the tenant scope guarantees the invoice is its own.
 *
 * The coupon is read from the invoice's own `coupon_id` and `coupon_code` columns. The joined `coupon`
 * a school is sent is narrowed to its id, code, name, discount type, value and currency, and nothing
 * here needs more than the code.
 *
 * ## The payments on it, for everyone who can read it
 *
 * The invoice read joins its payments, with the stored proof path replaced by `has_screenshot`. So an
 * Accountant, who can pay but holds no `payments.view`, still sees their submission sitting pending
 * here and what became of it. A rejected or failed payment shows its `rejection_reason`, the reason
 * written for the school — by the reviewer, or from the gateway's decline. The reviewer's internal note
 * is not sent to a school at all.
 *
 * ## Dates
 *
 * `issue_date` and `due_date` are `DATEONLY` and are printed as the calendar days they are; the billing
 * period and the line periods are instants, shown as UTC days — the zone the platform's own invoice
 * screen uses, so both sides of a query about one invoice read the same days.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { formatCodeWithAmount } from '@/lib/money';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { FormSection, Notice } from '@/components/form';
import { useSchoolBrand } from '@/components/shell';
import {
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';
import type { Column } from '@/components/table';

import {
  PAYABLE_STATUSES,
  calendarDay,
  formatCount,
  humanise,
  methodLabel,
  periodLabel,
  takesCoupon,
  utcDay,
} from '../../billing';
import type { Invoice, InvoiceLine, InvoicePayment, SubmittedPayment } from '../../billing';
import { CouponDialog } from '../../couponDialog';
import { PayDialog } from '../../payDialog';

/** `invoice_items.item_type`'s six values, as words. */
const ITEM_TYPES: Record<string, string> = {
  plan: 'Plan',
  addon: 'Add-on',
  setup_fee: 'Setup fee',
  overage: 'Overage',
  credit: 'Credit',
  custom: 'Adjustment',
};

/** One labelled fact. Null is an em-dash, never a blank. */
function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-soft">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value ?? <span className="text-muted-soft">—</span>}</dd>
    </div>
  );
}

/** One row of a money breakdown, with the operation it performs on the row above written out. */
function Figure({
  label,
  note,
  sign,
  value,
  strong = false,
}: {
  label: string;
  note?: string;
  sign?: '+' | '−';
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className={`text-sm ${strong ? 'font-semibold text-ink' : 'text-ink-soft'}`}>
        {label}
        {note ? <span className="mt-0.5 block text-xs text-muted">{note}</span> : null}
      </dt>
      <dd className={`whitespace-nowrap text-sm tabular-nums ${strong ? 'font-semibold text-ink' : 'text-ink'}`}>
        {sign ? <span className="mr-1 text-muted">{sign}</span> : null}
        {value}
      </dd>
    </div>
  );
}

/** A payment's outcome in words, beside the badge that carries the status itself. */
function paymentNote(payment: InvoicePayment): string | null {
  if (payment.status === 'pending') return 'Waiting for the platform to review it. It counts once approved.';
  if (payment.status === 'rejected') {
    return payment.rejection_reason ? `Rejected: ${payment.rejection_reason}` : 'Rejected by the reviewer.';
  }
  /* A gateway decline writes its reason into `rejection_reason` too. */
  if (payment.status === 'failed') {
    return payment.rejection_reason
      ? `Not taken, so nothing was applied to this invoice: ${payment.rejection_reason}`
      : 'Not taken — nothing was applied to this invoice.';
  }
  return null;
}

export default function SchoolInvoicePage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : null;

  const { can } = useAuth();
  const canPay = can('payments.submit');
  const canRedeem = can('coupons.redeem');
  /* §13.1's School — the school's own name from the profile (D35), or null with no school in scope. */
  const { name: schoolName } = useSchoolBrand();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  /* Apart from `error`: "Try again" on an id that names nothing this school can see fails forever. */
  const [notFound, setNotFound] = useState(false);
  const [nonce, setNonce] = useState(0);

  const [paying, setPaying] = useState(false);
  const [couponing, setCouponing] = useState(false);
  const [submitted, setSubmitted] = useState<SubmittedPayment | null>(null);

  useEffect(() => {
    if (!id) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);
    setNotFound(false);

    (async () => {
      try {
        const result = await api.get<{ invoice: Invoice }>(`/invoices/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        /* `show` wraps its payload — `ApiResponse.ok(res, { invoice })`. */
        setInvoice(result.invoice);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError && (caught.status === 404 || caught.code === 'VALIDATION_ERROR')) {
          /* A non-numeric id never reaches the service: the `idParam` schema refuses it with a 422. */
          setNotFound(true);
        } else if (caught instanceof ApiError) {
          setError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [id, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const back = (
    <Link href="/school/billing?tab=invoices" className="btn btn-secondary">
      Back to invoices
    </Link>
  );

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (notFound) {
    return (
      <EmptyNotice icon="search" title="Invoice not found" action={back}>
        No invoice with this number belongs to your school.
      </EmptyNotice>
    );
  }
  if (error && !invoice) return <ErrorNotice message={error} onRetry={reload} />;
  /* The skeleton only for the first load; a re-read after a payment dims the body in place. */
  if (!invoice) return <LoadingBlock />;

  const money = (value: number | string | null) => formatCodeWithAmount(invoice.currency, value);
  const payable = canPay && PAYABLE_STATUSES.includes(invoice.status);
  const couponable = canRedeem && takesCoupon(invoice);
  const addons = Array.isArray(invoice.addons_summary) ? invoice.addons_summary : [];
  const lines = invoice.items ?? [];
  const payments = invoice.payments ?? [];
  const billed = periodLabel(invoice.billing_period_start, invoice.billing_period_end);

  /* The rate is the invoice's own snapshot, so a later change to the tax cannot rewrite the document. */
  const taxName = invoice.tax ? invoice.tax.name : 'Tax';
  const taxNote =
    invoice.tax_rate_percent === null
      ? 'No tax on this invoice.'
      : invoice.tax_is_inclusive
        ? `${taxName} at ${invoice.tax_rate_percent}%, already inside the prices — shown, not added.`
        : `${taxName} at ${invoice.tax_rate_percent}%, charged on the subtotal after the discount.`;

  const lineColumns: Column<InvoiceLine>[] = [
    { key: 'description', header: 'Description', primary: true, cell: (line) => line.description },
    { key: 'type', header: 'Type', cell: (line) => ITEM_TYPES[line.item_type] ?? humanise(line.item_type) },
    {
      key: 'period',
      header: 'Period',
      hideOnMobile: true,
      cell: (line) => periodLabel(line.period_start, line.period_end) ?? <span className="text-muted-soft">—</span>,
    },
    { key: 'quantity', header: 'Quantity', numeric: true, cell: (line) => formatCount(line.quantity) },
    { key: 'unit_amount', header: 'Unit amount', numeric: true, cell: (line) => money(line.unit_amount) },
    { key: 'amount', header: 'Amount', numeric: true, cell: (line) => money(line.amount) },
  ];

  const paymentColumns: Column<InvoicePayment>[] = [
    {
      key: 'number',
      header: 'Payment',
      primary: true,
      cell: (payment) => <code className="whitespace-nowrap font-medium">{payment.payment_number}</code>,
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      cell: (payment) => formatCodeWithAmount(payment.currency, payment.amount),
    },
    { key: 'method', header: 'Method', cell: (payment) => methodLabel(payment.method) },
    {
      key: 'status',
      header: 'Status',
      cell: (payment) => {
        const note = paymentNote(payment);
        return (
          <div className="max-w-[20rem]">
            <StatusBadge status={payment.status} />
            {note ? <span className="mt-0.5 block text-xs text-muted">{note}</span> : null}
          </div>
        );
      },
    },
    {
      key: 'evidence',
      header: 'Evidence',
      hideOnMobile: true,
      cell: (payment) => (
        <span className="text-xs text-muted">
          {[payment.transaction_id ? `Ref ${payment.transaction_id}` : null, payment.has_screenshot ? 'screenshot' : null]
            .filter(Boolean)
            .join(' · ') || '—'}
        </span>
      ),
    },
    {
      key: 'recorded',
      header: 'Recorded',
      hideOnMobile: true,
      cell: (payment) => <span className="whitespace-nowrap text-xs text-muted">{utcDay(payment.created_at) ?? '—'}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title={invoice.invoice_number}
        description={`Issued ${calendarDay(invoice.issue_date) ?? invoice.issue_date} · due ${calendarDay(invoice.due_date) ?? invoice.due_date}`}
        action={back}
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={invoice.status} />
        {/* Beside the badge: the stored status can read unpaid until the overdue sweep runs. */}
        {invoice.is_overdue ? <span className="text-sm text-danger">Past its due date</span> : null}
        {payable || couponable ? (
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            {couponable ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCouponing(true)}>
                Apply a coupon
              </button>
            ) : null}
            {payable ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setPaying(true)}>
                Pay this invoice
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}

      {submitted ? (
        <div className="mb-6">
          <Notice tone="success">
            Payment <strong>{submitted.payment_number}</strong> of{' '}
            {formatCodeWithAmount(submitted.currency, submitted.amount)} by{' '}
            {methodLabel(submitted.method).toLowerCase()} is <strong>{humanise(submitted.status).toLowerCase()}</strong>.
            The figures below move once the platform approves it.
          </Notice>
        </div>
      ) : null}

      <div
        className={`space-y-8 transition-opacity duration-200 ${loading ? 'pointer-events-none opacity-60' : ''}`}
        aria-busy={loading || undefined}
      >
        <FormSection title="Invoice" description="SRS §13.1’s fields. The money is laid out below in the order it is worked out.">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Invoice number" value={invoice.invoice_number} />
            <Fact label="School" value={schoolName ?? 'Your school'} />
            <Fact label="Plan" value={invoice.plan_name} />
            <Fact
              label="Add-ons"
              value={
                addons.length === 0 ? (
                  'None'
                ) : (
                  <ul className="space-y-0.5">
                    {addons.map((addon, index) => (
                      <li key={`${addon.addon_id ?? 'addon'}-${index}`}>
                        {addon.description} · {money(addon.amount)}
                      </li>
                    ))}
                  </ul>
                )
              }
            />
            <Fact
              label="Billing period"
              value={billed === null ? null : `${billed}${invoice.billing_cycle ? ` · ${humanise(invoice.billing_cycle)}` : ''}`}
            />
            <Fact label="Due date" value={calendarDay(invoice.due_date)} />
            <Fact label="Status" value={humanise(invoice.status)} />
            {invoice.notes ? <Fact label="Notes" value={<span className="whitespace-pre-wrap">{invoice.notes}</span>} /> : null}
          </dl>
        </FormSection>

        <FormSection title="How the total is reached" description="Tax is charged on the subtotal after the discount.">
          <dl className="max-w-lg divide-y divide-border-soft">
            <Figure label="Subtotal" note="The lines below, added up." value={money(invoice.subtotal)} />
            <Figure
              label="Discount"
              note={invoice.coupon_code ? `Coupon ${invoice.coupon_code}.` : 'No coupon.'}
              sign="−"
              value={money(invoice.discount_amount)}
            />
            <Figure label="Tax" note={taxNote} sign={invoice.tax_is_inclusive ? undefined : '+'} value={money(invoice.tax_amount)} />
            <Figure label="Total" value={money(invoice.total)} strong />
          </dl>
          {couponable ? (
            <p className="mt-3 text-sm text-muted">
              A coupon can still be applied: this invoice has nothing paid against it and no coupon yet.
            </p>
          ) : null}
        </FormSection>

        <FormSection title="Settlement" description="Not §13.1’s fields — what has happened to the total since the invoice was issued.">
          <dl className="max-w-lg divide-y divide-border-soft">
            <Figure
              label="Credit applied"
              note="Credit left by an earlier plan change, drawn when the invoice was issued."
              value={money(invoice.credit_applied)}
            />
            <Figure label="Paid" note="Approved payments against this invoice, less refunds." value={money(invoice.amount_paid)} />
            <Figure
              label="Still owed"
              note={invoice.status === 'cancelled' ? 'Nothing — the invoice is cancelled.' : 'The total, less what has been paid and credited.'}
              value={money(invoice.amount_due)}
              strong
            />
          </dl>
        </FormSection>

        <FormSection
          title="Lines"
          description="Copied onto the invoice when it was issued, so a later plan or add-on change cannot rewrite them."
        >
          {lines.length === 0 ? (
            <p className="text-sm text-muted">This invoice has no lines.</p>
          ) : (
            /* No `busy` here: the whole body already dims while a re-read is in flight. */
            <DataTable columns={lineColumns} rows={lines} rowKey={(line) => line.id} caption={`Lines of invoice ${invoice.invoice_number}`} />
          )}
        </FormSection>

        <FormSection
          title="Payments"
          description="Everything submitted or recorded against this invoice. A submitted payment is pending until the platform reviews it."
        >
          {payments.length === 0 ? (
            <p className="text-sm text-muted">
              No payment has been made against this invoice{payable ? ' yet' : ''}.
            </p>
          ) : (
            <DataTable
              columns={paymentColumns}
              rows={payments}
              rowKey={(payment) => payment.id}
              caption={`Payments against invoice ${invoice.invoice_number}`}
            />
          )}
        </FormSection>
      </div>

      <PayDialog
        invoice={paying ? invoice : null}
        walletBalance={null}
        onClose={() => setPaying(false)}
        onSubmitted={(payment) => {
          setSubmitted(payment);
          setPaying(false);
          reload();
        }}
      />

      <CouponDialog
        invoice={couponing ? invoice : null}
        onClose={() => setCouponing(false)}
        onApplied={(next) => {
          /* The response is the invoice with its totals recomputed, so it replaces the one on screen. */
          setInvoice(next);
          setCouponing(false);
        }}
      />
    </div>
  );
}
