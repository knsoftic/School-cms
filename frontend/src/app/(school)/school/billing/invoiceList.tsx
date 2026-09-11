'use client';

/**
 * The school's invoices — SRS §13.1, FR-BILL-001, on `invoices.self.view`.
 *
 * `GET /invoices` reaches the school through the same handler the platform's list uses: the reads name
 * `invoices.view` **or** `invoices.self.view`, and `tenantWhere()` confines every row to the caller's
 * school. So this is the school's whole invoice history with nothing to filter out on this side.
 *
 * ## One filter, because the API has two that fight
 *
 * The list schema takes both `status` and `outstanding`, and `invoices.service.list()` applies
 * `outstanding` after `status` and overwrites it. Two controls where one silently wins is a bug
 * waiting to be filed, so they are one select: "Still owed" sends `outstanding`, a status sends
 * `status`, and never both.
 *
 * ## Paying from the list
 *
 * The one action a row offers is Pay, on `payments.submit` and only on a status
 * `loadInvoiceForPayment()` accepts. Everything else — the §13.1 breakdown, the lines, the coupon — is
 * on the invoice's own screen, one click away.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { useCollection } from '@/lib/useCollection';
import { formatCodeWithAmount } from '@/lib/money';
import { FilterBar, FilterSelect, Notice } from '@/components/form';
import {
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  Pagination,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';
import type { Column } from '@/components/table';

import { PAYABLE_STATUSES, calendarDay, formatCount, methodLabel, periodLabel } from './billing';
import type { Invoice, SubmittedPayment } from './billing';
import { PayDialog } from './payDialog';

/** `INVOICE_STATUS`'s seven values — the list schema validates `status` against exactly these. */
const STATUSES = ['draft', 'unpaid', 'partially_paid', 'overdue', 'paid', 'cancelled', 'refunded'];

const spell = (value: string) => value.replace(/_/g, ' ');

export function InvoicesPanel({
  canPay,
  walletBalance,
}: {
  /** `payments.submit` — Principal, School Admin and Accountant hold it. */
  canPay: boolean;
  walletBalance: number | null;
}) {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('');
  const [paying, setPaying] = useState<Invoice | null>(null);
  const [submitted, setSubmitted] = useState<{ payment: SubmittedPayment; invoiceNumber: string } | null>(null);

  const query = useMemo(
    () => ({
      page,
      limit: 20,
      /* See the header: one of the two, never both. `outstanding` is a Joi boolean sent as a string. */
      outstanding: filter === 'outstanding' ? 'true' : undefined,
      status: filter && filter !== 'outstanding' ? filter : undefined,
    }),
    [page, filter]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<Invoice>('/invoices', query);

  const columns = useMemo<Column<Invoice>[]>(
    () => [
      {
        key: 'number',
        header: 'Invoice',
        primary: true,
        cell: (row) => (
          <Link
            href={`/school/billing/invoices/${row.id}`}
            className="font-medium underline-offset-2 hover:underline focus-visible:underline"
          >
            {row.invoice_number}
          </Link>
        ),
      },
      {
        key: 'plan',
        header: 'Plan',
        cell: (row) => row.plan_name ?? <span className="text-muted-soft">—</span>,
      },
      {
        key: 'period',
        header: 'Billing period',
        hideOnMobile: true,
        cell: (row) =>
          periodLabel(row.billing_period_start, row.billing_period_end) ?? <span className="text-muted-soft">—</span>,
      },
      {
        key: 'total',
        header: 'Total',
        numeric: true,
        cell: (row) => <span className="whitespace-nowrap">{formatCodeWithAmount(row.currency, row.total)}</span>,
      },
      {
        key: 'due',
        header: 'Still owed',
        numeric: true,
        cell: (row) => <span className="whitespace-nowrap">{formatCodeWithAmount(row.currency, row.amount_due)}</span>,
      },
      {
        key: 'due_date',
        header: 'Due',
        cell: (row) => (
          <span className="whitespace-nowrap">
            {calendarDay(row.due_date)}
            {/* Beside the date, not in the badge: the stored status can read unpaid until the sweep runs. */}
            {row.is_overdue ? <span className="block text-xs text-danger">Past its due date</span> : null}
          </span>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => {
          const pending = (row.payments ?? []).filter((payment) => payment.status === 'pending').length;
          return (
            <div>
              <StatusBadge status={row.status} />
              {pending > 0 ? (
                <span className="mt-0.5 block text-xs text-muted">
                  {formatCount(pending)} payment{pending === 1 ? '' : 's'} pending review
                </span>
              ) : null}
            </div>
          );
        },
      },
      {
        key: 'actions',
        header: 'Actions',
        cell: (row) => (
          <div className="flex flex-wrap gap-1">
            {canPay && PAYABLE_STATUSES.includes(row.status) ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setPaying(row)}>
                Pay
              </button>
            ) : null}
            <Link href={`/school/billing/invoices/${row.id}`} className="btn btn-secondary btn-sm">
              Open
            </Link>
          </div>
        ),
      },
    ],
    [canPay]
  );

  return (
    <div>
      {/*
        * Kept on screen after the dialog closes. A submission is pending until the platform reviews it, so
        * the invoice beside this still reads unpaid — which, without this line, looks like the payment
        * went nowhere.
        */}
      {submitted ? (
        <div className="mb-4">
          <Notice tone="success">
            Payment <strong>{submitted.payment.payment_number}</strong> of{' '}
            {formatCodeWithAmount(submitted.payment.currency, submitted.payment.amount)} by{' '}
            {methodLabel(submitted.payment.method).toLowerCase()} against {submitted.invoiceNumber} is{' '}
            <strong>{spell(submitted.payment.status)}</strong>. It counts towards the invoice once the
            platform approves it.
          </Notice>
        </div>
      ) : null}

      <FilterBar
        activeCount={filter ? 1 : 0}
        onClear={() => {
          setFilter('');
          setPage(1);
        }}
      >
        <FilterSelect
          id="invoice-filter"
          label="Which invoices"
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setPage(1);
          }}
        >
          <option value="">All invoices</option>
          <option value="outstanding">Still owed</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {spell(status).charAt(0).toUpperCase() + spell(status).slice(1)}
            </option>
          ))}
        </FilterSelect>
      </FilterBar>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice icon="receipt">
          {filter
            ? 'No invoice matches this filter.'
            : 'No invoice has been issued to your school yet. One is issued as each paid billing period starts — trial days are not billed.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Your school’s invoices" busy={loading} />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <PayDialog
        invoice={paying}
        walletBalance={walletBalance}
        onClose={() => setPaying(null)}
        onSubmitted={(payment) => {
          setSubmitted({ payment, invoiceNumber: paying?.invoice_number ?? '' });
          setPaying(null);
          reload();
        }}
      />
    </div>
  );
}
