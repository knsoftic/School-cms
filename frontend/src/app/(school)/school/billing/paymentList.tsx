'use client';

/**
 * The school's payments — SRS §13.2 / §13.3, on `payments.view`.
 *
 * A school could submit a payment and never see what became of it: `payments.view` was the platform's
 * alone. The owner's decision D27 granted it to Principal and School Admin, and
 * `payments.service.list()` confines the read to the caller's school (and refuses a `school_id` naming
 * another). An Accountant submits without it, and sees the payments on each invoice's own screen,
 * which the invoice read carries.
 *
 * ## What a school is shown, and what it is not
 *
 * Status, amount, method, the evidence it sent, and — on a rejected or failed payment — the
 * `rejection_reason`: the reason the reviewer writes for the school, or the gateway's decline, which
 * the service copies into the same field. The reviewer's internal note is the platform's, and
 * `payments.controller.present()` leaves it out of every response to a school.
 *
 * ## The proof is fetched, not linked
 *
 * `GET /payments/:id/screenshot` reads the bearer token from the `Authorization` header only, so an
 * `<img src>` at the route is a 401 and a broken image. The bytes come through `api.download()` — the
 * authenticated file helper — and are handed to the image as an object URL, revoked when the dialog
 * closes. The platform's review dialog does the same, for the same reason.
 *
 * ## The search box sends `number`
 *
 * `payments.service.list()` reads `number` (`payment_number LIKE …`) and never `q`, which validates and
 * is ignored — a box wired to `q` would return the unfiltered page and look as though it had worked.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/apiClient';
import { formatCodeWithAmount } from '@/lib/money';
import { useCollection } from '@/lib/useCollection';
import { FilterBar, FilterSelect, SearchField } from '@/components/form';
import { Spinner } from '@/components/icon';
import { Modal } from '@/components/overlay';
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

import { methodLabel, utcDay } from './billing';

/** One row of `GET /payments`, as `payments.controller.present()` builds it — narrowed to what is shown. */
interface PaymentRow {
  id: number;
  payment_number: string;
  invoice_id: number | null;
  method: string;
  currency: string;
  amount: number;
  status: string;
  transaction_id: string | null;
  reference: string | null;
  has_screenshot: boolean;
  rejection_reason: string | null;
  paid_at: string | null;
  created_at: string;
  refunded_amount: number;
  /** Joined by `detailInclude()`, so the invoice number needs no second read. */
  invoice: { id: number; invoice_number: string } | null;
}

/** `PAYMENT_STATUS`'s six values — the list schema validates `status` against exactly these. */
const STATUSES = ['pending', 'approved', 'rejected', 'failed', 'refunded', 'partially_refunded'];

const spell = (value: string) => value.replace(/_/g, ' ');

/** A payment's status in a sentence a school reads — the badge carries the word, this what it means. */
function statusNote(row: PaymentRow): string | null {
  if (row.status === 'pending') return 'Waiting for the platform to review it.';
  if (row.status === 'rejected') return row.rejection_reason ? `Rejected: ${row.rejection_reason}` : 'Rejected by the reviewer.';
  if (row.status === 'failed') {
    return row.rejection_reason
      ? `Not taken, so nothing was applied to the invoice: ${row.rejection_reason}`
      : 'Not taken — nothing was applied to the invoice.';
  }
  if (row.status === 'refunded' || row.status === 'partially_refunded') {
    return `${formatCodeWithAmount(row.currency, row.refunded_amount)} given back.`;
  }
  return null;
}

/** The proof image for one payment, fetched through the authenticated client. */
function ProofDialog({ payment, onClose }: { payment: PaymentRow | null; onClose: () => void }) {
  const [proof, setProof] = useState<
    { state: 'idle' } | { state: 'loading' } | { state: 'ready'; url: string } | { state: 'failed' }
  >({ state: 'idle' });

  const id = payment ? payment.id : null;

  /*
   * The revoke is in the cleanup: nothing races a navigation here, and a blob held for every proof
   * opened in a sitting is a leak that grows with the images. `cancelled` guards the late resolve that
   * Strict Mode's mount → unmount → mount produces.
   */
  useEffect(() => {
    if (id === null) {
      setProof({ state: 'idle' });
      return undefined;
    }
    let cancelled = false;
    let url: string | null = null;
    setProof({ state: 'loading' });
    (async () => {
      try {
        const file = await api.download(`/payments/${id}/screenshot`);
        if (cancelled) return;
        url = URL.createObjectURL(file.blob);
        setProof({ state: 'ready', url });
      } catch {
        if (!cancelled) setProof({ state: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);

  return (
    <Modal
      open={payment !== null}
      onClose={onClose}
      title={payment ? `Proof for ${payment.payment_number}` : 'Proof'}
      description="The screenshot sent with this payment."
      footer={
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      {proof.state === 'ready' && payment ? (
        <a
          href={proof.url}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-md border border-border-strong bg-surface-2"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a blob URL, not a served asset */}
          <img src={proof.url} alt={`Payment proof for ${payment.payment_number}`} className="max-h-96 w-full object-contain" />
        </a>
      ) : proof.state === 'failed' ? (
        <p className="rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
          The proof could not be loaded. Try again in a moment.
        </p>
      ) : (
        <p className="flex items-center gap-2 rounded-md border border-border-soft bg-surface-2 px-3 py-6 text-sm text-muted">
          <Spinner size={14} />
          Loading the proof…
        </p>
      )}
    </Modal>
  );
}

export function PaymentsPanel() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [viewing, setViewing] = useState<PaymentRow | null>(null);

  /* The list screens' debounce — a keystroke is a request. */
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useMemo(
    () => ({ page, limit: 20, status: status || undefined, number: debounced || undefined }),
    [page, status, debounced]
  );
  const { rows, meta, loading, error, refusal, reload } = useCollection<PaymentRow>('/payments', query);

  const columns = useMemo<Column<PaymentRow>[]>(
    () => [
      {
        key: 'number',
        header: 'Payment',
        primary: true,
        cell: (row) => <code className="whitespace-nowrap font-medium">{row.payment_number}</code>,
      },
      {
        key: 'invoice',
        header: 'Invoice',
        cell: (row) =>
          row.invoice_id ? (
            <Link
              href={`/school/billing/invoices/${row.invoice_id}`}
              className="underline-offset-2 hover:underline focus-visible:underline"
            >
              {row.invoice ? row.invoice.invoice_number : `Invoice #${row.invoice_id}`}
            </Link>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
      {
        key: 'amount',
        header: 'Amount',
        numeric: true,
        cell: (row) => <span className="whitespace-nowrap">{formatCodeWithAmount(row.currency, row.amount)}</span>,
      },
      { key: 'method', header: 'Method', cell: (row) => methodLabel(row.method) },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => {
          const note = statusNote(row);
          return (
            <div className="max-w-[18rem]">
              <StatusBadge status={row.status} />
              {note ? <span className="mt-0.5 block text-xs text-muted">{note}</span> : null}
            </div>
          );
        },
      },
      {
        key: 'proof',
        header: 'Evidence',
        hideOnMobile: true,
        cell: (row) => (
          <div className="max-w-[16rem]">
            {row.transaction_id ? (
              <code className="block truncate text-xs">{row.transaction_id}</code>
            ) : (
              <span className="block text-xs text-muted-soft">No transaction ID</span>
            )}
            {row.has_screenshot ? (
              <button type="button" className="btn btn-ghost btn-sm mt-0.5" onClick={() => setViewing(row)}>
                View screenshot
              </button>
            ) : null}
          </div>
        ),
      },
      {
        /* `created_at` — a payment the platform recorded for the school was not "submitted" by it. */
        key: 'dates',
        header: 'Recorded',
        hideOnMobile: true,
        cell: (row) => (
          <div className="whitespace-nowrap text-xs text-muted">
            <span className="block">{utcDay(row.created_at) ?? '—'}</span>
            {row.paid_at ? <span className="block text-muted-soft">paid {utcDay(row.paid_at)}</span> : null}
          </div>
        ),
      },
    ],
    []
  );

  return (
    <div>
      <FilterBar
        activeCount={[status, debounced].filter(Boolean).length}
        onClear={() => {
          setStatus('');
          setSearch('');
          setPage(1);
        }}
      >
        <SearchField
          id="payment-search"
          label="Search payments by number"
          placeholder="Payment number…"
          maxLength={40}
          value={search}
          onChange={setSearch}
        />
        <FilterSelect
          id="payment-status"
          label="Status"
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {spell(value).charAt(0).toUpperCase() + spell(value).slice(1)}
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
        <EmptyNotice icon="credit-card">
          {status || debounced
            ? 'No payment matches these filters.'
            : 'Your school has not submitted a payment yet. Pay an invoice from the Invoices tab.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Your school’s payments" busy={loading} />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <ProofDialog payment={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
