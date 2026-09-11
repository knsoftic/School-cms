'use client';

/**
 * One invoice — SRS §13.1 and FR-BILL-001, and the caller `GET /invoices/:id` never had.
 *
 * FR-BILL-001 says an invoice contains *"Invoice Number, School, Plan, Add-ons, Billing Period,
 * Subtotal, Discount, Tax, Total, Due Date, and Status"*. The Invoices list shows seven columns and
 * deferred the rest to a single-invoice screen that did not exist, so five of the eleven — Add-ons,
 * Billing Period, Subtotal, Discount and Tax — were stored on every invoice and visible nowhere, and
 * so was every line it billed.
 *
 * Where each of the eleven is: the number is the heading and the status the badge under it; School,
 * Plan, Add-ons, Billing Period and Due Date are the first section; Subtotal, Discount, Tax and Total
 * are the breakdown, each once.
 *
 * ## What the read returns
 *
 * `invoices.controller.show()` answers `{ invoice }`: the whole row, spread, with `items`, `plan`,
 * `coupon`, `tax` and `payments` joined by `detailInclude()`, plus two figures `present()` derives —
 * `is_overdue` and `tax_is_inclusive`. The interface below names what this screen reads and nothing
 * else. `payments` is deliberately not declared: the §13.1 fields do not include it, and `Paid` below
 * is `amount_paid`, the figure the service keeps as the sum of them.
 *
 * ## The money is laid out in the order it is worked out
 *
 * Subtotal → discount → tax → total, which is §13.1's own order and `computeTotals()`'s: tax is
 * charged on the discounted subtotal. An **inclusive** tax is already inside the prices, so it is
 * shown and not added — `total` then equals the discounted subtotal, and without `tax_is_inclusive`
 * that would read as an arithmetic error. Credit, payments and the balance come after Total and are
 * kept in a section of their own, because they are not §13.1 fields and do not add up to it: a
 * cancelled invoice keeps its total and owes nothing.
 *
 * ## The actions are the list's four, and no others
 *
 * Finalise, apply a coupon, remove a coupon, cancel — through `../actions.tsx`, the dialog the list
 * uses, gated on `invoices.manage` and on `actionsFor()`, the same rule the list applies: a coupon is
 * applied only to a draft or unpaid invoice with nothing paid and none on it, removed only from one
 * that carries one, and an invoice is cancelled only while nothing is paid against it. This paragraph
 * used to call the coupon pair the one difference between the two screens, because the list's read
 * lacked `coupon_id`. It never did — `present()` spreads the whole row on both reads — so there is no
 * difference now.
 *
 * ## Dates
 *
 * `issue_date` and `due_date` are `DATEONLY` and are printed as sent, for the list's reason: a
 * calendar date has no instant behind it, and giving it one shifts the day west of UTC. The billing
 * period and the line periods are `DATE` instants, shown as their **UTC** day — the formatter the
 * payments screen uses, and the zone the subscriptions list shows the same period in. A period typed
 * on the generate form is a `YYYY-MM-DD` the API stores as UTC midnight, so UTC also shows the day
 * that was typed.
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
import { useSchoolNames } from '@/lib/useSchoolNames';
import { FormSection } from '@/components/form';
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

import { actionsFor, useInvoiceActions } from '../actions';

/** One `invoice_items` row. `unit_amount` and `amount` are `money()`; `quantity` is `DECIMAL(12,2)`. */
interface InvoiceLine {
  id: number;
  item_type: string;
  description: string;
  quantity: number;
  unit_amount: number;
  amount: number;
  period_start: string | null;
  period_end: string | null;
}

/** One entry of `addons_summary` — `addonsSummaryFrom()`, a copy of the invoice's add-on lines. */
interface AddonSummary {
  addon_id: number | null;
  description: string;
  quantity: number;
  amount: number;
}

/**
 * `GET /invoices/:id`, narrowed to what this screen reads.
 *
 * Money is a JS number — `config/database.js` sets `decimalNumbers`, as the list's `Invoice` records.
 * `tax_rate_percent` is `DECIMAL(7,4)` and arrives the same way: `12.5`, not `"12.5000"`.
 */
interface InvoiceDetail {
  id: number;
  invoice_number: string;
  school_id: number;
  subscription_id: number | null;
  /** The plan a coupon is checked against — `../actions.tsx` sends it to `POST /coupons/validate`. */
  plan_id: number | null;
  /** *"Snapshot at issue time"* — what was billed, not the subscription's plan today. */
  plan_name: string | null;
  billing_period_start: string | null;
  /** Null for a `one_time` subscription, which has no next period. */
  billing_period_end: string | null;
  billing_cycle: string | null;
  currency: string;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  credit_applied: number;
  amount_paid: number;
  amount_due: number;
  coupon_id: number | null;
  /** Denormalised beside the id, so a later edit to the coupon cannot rewrite the invoice. */
  coupon_code: string | null;
  tax_rate_percent: number | null;
  issue_date: string;
  due_date: string;
  status: string;
  notes: string | null;
  /** A json column, parsed by the model's getter; checked with `Array.isArray` before it is read. */
  addons_summary: AddonSummary[] | null;
  tax: { id: number; name: string; code: string } | null;
  items: InvoiceLine[];
  /** Derived per request by `present()`: past its due date while still owed. */
  is_overdue: boolean;
  /** Read off the joined tax row by `present()`. See the header. */
  tax_is_inclusive: boolean;
}

/** `invoice_items.item_type`'s six values, as words. */
const ITEM_TYPES: Record<string, string> = {
  plan: 'Plan',
  addon: 'Add-on',
  setup_fee: 'Setup fee',
  overage: 'Overage',
  credit: 'Credit',
  custom: 'Custom',
};

/** `monthly` → `Monthly`, `custom_days` → `Custom days`. */
function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* Constructed once — the payments screen's formatter, for the reason the header gives. */
const DAY = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** An instant as its UTC day; null for nothing, or for text that is not a date rather than "Invalid Date". */
function utcDay(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : DAY.format(date);
}

/** A period as two UTC days, or its start alone when it has no end. */
function period(start: string | null, end: string | null): string | null {
  const from = utcDay(start);
  if (!from) return null;
  const to = utcDay(end);
  return to ? `${from} – ${to}` : `From ${from}`;
}

/* `quantity` is `DECIMAL(12,2)`, so up to two places are kept — and it is a count, so no currency. */
const QUANTITY = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** One labelled fact. Null is rendered as an em-dash, never as a blank. */
function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-soft">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value ?? <span className="text-muted-soft">—</span>}</dd>
    </div>
  );
}

/**
 * One row of the money breakdown.
 *
 * `sign` is the operation the row performs on the one above, written out so the column reads as the
 * sum it is — and left off where the figure is not added at all, which is an inclusive tax.
 */
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

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : null;

  const { can } = useAuth();
  const { nameFor } = useSchoolNames();

  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  /*
   * Kept apart from `error` for the reason the subscription screen gives: "Try again" on an id that
   * names nothing this caller can see fails the same way forever, and the way on is the list.
   */
  const [notFound, setNotFound] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!id) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);
    setNotFound(false);

    (async () => {
      try {
        const result = await api.get<{ invoice: InvoiceDetail }>(`/invoices/${id}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        /* `show` wraps its payload — `ApiResponse.ok(res, { invoice })`. */
        setInvoice(result.invoice);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (
          caught instanceof ApiError &&
          (caught.status === 404 || caught.code === 'VALIDATION_ERROR')
        ) {
          /*
           * `findById()` folds the tenant scope into its `where`, so another school's invoice is a
           * 404 exactly like one that never existed — `INVOICE_NOT_FOUND` either way. A non-numeric
           * id never reaches the service: the `idParam` schema refuses it with a 422.
           */
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
  const { ask, dialog } = useInvoiceActions({ onDone: reload, nameFor });

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (notFound) {
    return (
      <EmptyNotice
        icon="search"
        title="Invoice not found"
        action={
          <Link href="/super-admin/invoices" className="btn btn-secondary">
            Back to invoices
          </Link>
        }
      >
        No invoice with this id exists, or it belongs to a school outside this account’s scope.
      </EmptyNotice>
    );
  }
  if (error) return <ErrorNotice message={error} onRetry={reload} />;
  /* The skeleton only for the first load; a re-read after an action dims the body in place. */
  if (!invoice) return <LoadingBlock />;

  const money = (value: number) => formatCodeWithAmount(invoice.currency, value);
  const canManage = can('invoices.manage');
  /* The list's rule, from the one function both screens call — see the header. */
  const offered = actionsFor(invoice);
  const addons = Array.isArray(invoice.addons_summary) ? invoice.addons_summary : [];
  const billed = period(invoice.billing_period_start, invoice.billing_period_end);

  /*
   * What the tax line says about itself. The rate is the invoice's own snapshot, `tax_rate_percent`
   * — copied at issue so a later edit to the rate cannot rewrite the document — and the name comes
   * from the joined row, which is null once that row is gone.
   */
  const taxName = invoice.tax ? invoice.tax.name : 'Tax';
  const taxNote =
    invoice.tax_rate_percent === null
      ? 'No tax on this invoice.'
      : invoice.tax_is_inclusive
        ? `${taxName} at ${invoice.tax_rate_percent}%, already inside the prices — shown, not added.`
        : `${taxName} at ${invoice.tax_rate_percent}%, charged on the discounted subtotal.`;

  const columns: Column<InvoiceLine>[] = [
    { key: 'description', header: 'Description', primary: true, cell: (line) => line.description },
    {
      key: 'type',
      header: 'Type',
      cell: (line) => ITEM_TYPES[line.item_type] ?? humanise(line.item_type),
    },
    {
      key: 'period',
      header: 'Period (UTC)',
      cell: (line) => period(line.period_start, line.period_end) ?? <span className="text-muted-soft">—</span>,
    },
    { key: 'quantity', header: 'Quantity', numeric: true, cell: (line) => QUANTITY.format(line.quantity) },
    { key: 'unit_amount', header: 'Unit amount', numeric: true, cell: (line) => money(line.unit_amount) },
    { key: 'amount', header: 'Amount', numeric: true, cell: (line) => money(line.amount) },
  ];

  return (
    <div>
      <PageHeader
        title={invoice.invoice_number}
        description={`${nameFor(invoice.school_id)} · issued ${invoice.issue_date}`}
        action={
          <Link href="/super-admin/invoices" className="btn btn-secondary">
            Back to invoices
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={invoice.status} />
        {/*
          * Beside the badge, not folded into it — the list's reason: the stored status is the
          * record, and an invoice can read `unpaid` and be past due until the overdue sweep runs.
          */}
        {invoice.is_overdue ? <span className="text-sm text-danger">Past its due date</span> : null}

        {/*
          * Disabled while a re-read is in flight. These sit outside the body that dims, and until the
          * re-read lands `invoice` is the one from before the last action — so a button pressed then
          * would open its dialog on figures and a status that are no longer the invoice's.
          */}
        {canManage ? (
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            {offered.finalise ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={loading}
                onClick={() => ask('finalise', invoice)}
              >
                Finalise
              </button>
            ) : null}
            {offered.applyCoupon ? (
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={loading}
                onClick={() => ask('coupon', invoice)}
              >
                Apply coupon
              </button>
            ) : null}
            {offered.removeCoupon ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={loading}
                onClick={() => ask('uncoupon', invoice)}
              >
                Remove coupon
              </button>
            ) : null}
            {offered.cancel ? (
              <button
                type="button"
                className="btn btn-sm btn-danger-ghost"
                disabled={loading}
                onClick={() => ask('cancel', invoice)}
              >
                Cancel invoice
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div
        className={`space-y-8 transition-opacity duration-200 ${loading ? 'pointer-events-none opacity-60' : ''}`}
        aria-busy={loading || undefined}
      >
        <FormSection
          title="Invoice"
          description="SRS §13.1's fields other than the money, which is laid out in the order it is worked out below."
        >
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="School" value={nameFor(invoice.school_id)} />
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
              label="Billing period (UTC)"
              value={
                billed === null
                  ? null
                  : `${billed}${invoice.billing_cycle ? ` · ${humanise(invoice.billing_cycle)}` : ''}`
              }
            />
            <Fact label="Due date" value={invoice.due_date} />
            {/*
              * Not §13.1 fields. FR-BILL-001's outcome is an invoice *"associated with the school and
              * subscription"*, and this is the association; the notes are what the generate form
              * and a cancellation's reason write.
              */}
            <Fact
              label="Subscription"
              value={
                !invoice.subscription_id ? null : can('subscriptions.view') ? (
                  <Link
                    href={`/super-admin/subscriptions/${invoice.subscription_id}`}
                    className="underline-offset-2 hover:underline focus-visible:underline"
                  >
                    Subscription #{invoice.subscription_id}
                  </Link>
                ) : (
                  `Subscription #${invoice.subscription_id}`
                )
              }
            />
            {invoice.notes ? (
              <Fact label="Notes" value={<span className="whitespace-pre-wrap">{invoice.notes}</span>} />
            ) : null}
          </dl>
        </FormSection>

        <FormSection
          title="How the total is reached"
          description="Worked out in §13.1's order, so tax is charged on the subtotal after the discount."
        >
          <dl className="max-w-lg divide-y divide-border-soft">
            <Figure label="Subtotal" note="The lines below, added up." value={money(invoice.subtotal)} />
            <Figure
              label="Discount"
              note={invoice.coupon_code ? `Coupon ${invoice.coupon_code}.` : 'No coupon.'}
              sign="−"
              value={money(invoice.discount_amount)}
            />
            <Figure
              label="Tax"
              note={taxNote}
              sign={invoice.tax_is_inclusive ? undefined : '+'}
              value={money(invoice.tax_amount)}
            />
            <Figure label="Total" value={money(invoice.total)} strong />
          </dl>
        </FormSection>

        <FormSection
          title="Settlement"
          description="Not §13.1 fields — what has happened to the total since the invoice was issued."
        >
          <dl className="max-w-lg divide-y divide-border-soft">
            <Figure
              label="Credit applied"
              note="The subscription’s remaining credit (§12.3), drawn when the invoice was issued."
              value={money(invoice.credit_applied)}
            />
            <Figure
              label="Paid"
              note="Payments received against this invoice, less refunds."
              value={money(invoice.amount_paid)}
            />
            <Figure
              label="Still due"
              note={
                invoice.status === 'cancelled'
                  ? 'Nothing — the invoice is cancelled.'
                  : 'The total, less what has been paid and credited.'
              }
              value={money(invoice.amount_due)}
              strong
            />
          </dl>
        </FormSection>

        <FormSection
          title="Lines"
          description="Copied onto the invoice when it was issued, so a later catalogue or quantity change cannot rewrite them."
        >
          {invoice.items.length === 0 ? (
            <p className="text-sm text-muted">This invoice has no lines.</p>
          ) : (
            /* No `busy` here: the whole body above already dims while a re-read is in flight. */
            <DataTable
              columns={columns}
              rows={invoice.items}
              rowKey={(line) => line.id}
              caption={`Lines of invoice ${invoice.invoice_number}`}
            />
          )}
        </FormSection>
      </div>

      {dialog}
    </div>
  );
}
