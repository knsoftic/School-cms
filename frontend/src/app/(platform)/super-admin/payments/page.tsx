'use client';

/**
 * Payments — SRS §13.2 / FR-BILL-004, §33's "Payments", checklist row 4.3.
 *
 * The platform-wide ledger of money received, and the queue FR-BILL-004 is written about: *"Super Admin
 * reviews the submitted transaction ID and screenshot"* and then approves or rejects.
 *
 * ## This screen used to be unable to do the thing it is named after
 *
 * It listed the queue and stopped there. The reviewer could see that a payment was pending, could see
 * its transaction id and whether a screenshot existed, and then had nowhere to go: `POST /payments/:id/
 * approve` and `/reject` existed on the server, were seeded to `payments.approve`, and no screen called
 * them. A review queue with no decision is a report. **The review now happens here**, because here is
 * where the reviewer already is — routing them to a per-payment page to press one of two buttons is the
 * extra click the brief asks to remove.
 *
 * ## The search box sends `number`, not `q`
 *
 * `listQuery()` folds `commonSchemas.search` into every list schema, so `?q=` passes `validate()` on this
 * route — and then `payments.service.js list()` never reads it. That function builds its `where` from
 * `number` alone (`payment_number LIKE '%…%'`). A box wired to `q` would validate, reach the database,
 * and return the *unfiltered* page: the worst way a filter can fail, because it looks like it worked and
 * the only symptom is results that are too broad. This box sends `number`.
 *
 * ## `pending` is deliberately not a control
 *
 * The endpoint accepts `pending` as a shorthand for the reviewer's queue, but the service applies it
 * *after* `status` and overwrites it — `if (query.pending) where.status = PENDING`. Two controls that
 * can contradict each other, where one silently wins, is a bug waiting to be filed. The Status select
 * already reaches `pending`, so `pending` is left unsent. The "Awaiting review" shortcut in the header
 * sets that same select rather than introducing the second control.
 *
 * ## Money is a number, and the currency is a code
 *
 * This header used to say `payments.amount` "hands back a **string**". It does not: `config/database.js`
 * sets `dialectOptions.decimalNumbers = true`, so mysql2 parses `DECIMAL(14,2)` into a JS number before
 * Sequelize sees it — measured, not assumed. Formatting goes through `lib/money.ts`; no arithmetic on
 * money happens on this side of the wire. The currency is printed as its three-letter code rather than a
 * glyph: this list spans every school on the platform, so two rows can be different currencies that
 * share a symbol, and `$1,000` beside `$1,000` would be a lie about which is larger.
 *
 * ## Dates are pinned to UTC
 *
 * `paid_at` is a `DATE` serialised as UTC ISO. Rendering it in the viewer's zone would let one payment
 * read as two different days depending on who opened the screen — which is exactly the ambiguity a
 * finance record must not have. The month is spelled, so nothing depends on reading 03/04 correctly.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { formatAmountWithCode } from '@/lib/money';
import { useSchoolNames } from '@/lib/useSchoolNames';
import { Icon, Spinner } from '@/components/icon';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';
import {
  Notice,
  TextAreaField,
  FilterBar,
  FilterSelect,
  SearchField,
} from '@/components/form';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  Pagination,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

/**
 * One row of `GET /payments`, as `payments.controller.js present()` builds it.
 *
 * `present()` spreads the whole model row, so far more than this arrives; typed here is only what is
 * rendered. **`screenshot_path` is deleted by `present()` and replaced by `has_screenshot`** — there is
 * no path in this payload and nothing on this screen may go looking for one.
 */
interface Payment {
  id: number;
  payment_number: string;
  school_id: number;
  method: string;
  currency: string;
  /** `DECIMAL(14,2)`, which arrives as a JS **number** — see `lib/money.ts`. */
  amount: number;
  status: string;
  transaction_id: string | null;
  paid_at: string | null;
  has_screenshot: boolean;
  /** Approval settles an invoice; a payment with none is refused with `PAYMENT_NO_INVOICE`. */
  invoice_id: number | null;
}

/*
 * The two closed sets the API will accept, mirroring `config/constants.js` — `payments.validation.js`
 * validates `status` and `method` against exactly these, so anything else is a 422 rather than a wider
 * search. They are payment states, not plan names: SRS §30 Rule 1 forbids branching on a *plan* name,
 * and nothing here does.
 */
const STATUSES = ['pending', 'approved', 'rejected', 'failed', 'refunded', 'partially_refunded'];
const METHODS = ['cash', 'bank_transfer', 'manual_payment', 'online_gateway', 'wallet'];

/** `partially_refunded` → `partially refunded`, for a label a person reads. */
const spell = (value: string) => value.replace(/_/g, ' ');

/* Constructed once. Building a formatter per cell is measurable on a page of twenty rows. */
const DAY = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  /* An unparseable date must not render "Invalid Date" into a finance table. */
  return Number.isNaN(date.getTime()) ? null : DAY.format(date);
}

export default function PaymentsPage() {
  const { can } = useAuth();
  const { nameFor, schools } = useSchoolNames();
  const { success, error: errorToast } = useToast();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [schoolId, setSchoolId] = useState('');

  /** The payment open in the review dialog, or `null`. */
  const [reviewing, setReviewing] = useState<Payment | null>(null);

  /*
   * The refund, which is a separate operation on a payment that has already been approved — §33's
   * Refunds, `POST /payments/:id/refunds`, which had no caller.
   *
   * Its own state rather than a mode of the review dialog: reviewing decides whether money was
   * received, refunding gives money back, and they apply to payments in different states. Sharing a
   * dialog would mean one set of copy trying to say both.
   */
  const [refunding, setRefunding] = useState<Payment | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundDestination, setRefundDestination] = useState('original_method');
  const [refundReason, setRefundReason] = useState('');
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      /* Searching from page four and staying there shows an empty table for a query that has results. */
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useMemo(
    () => ({
      page,
      limit: 20,
      /* `number`, not `q` — see the header. */
      number: debounced || undefined,
      status: status || undefined,
      method: method || undefined,
      school_id: schoolId || undefined,
    }),
    [page, debounced, status, method, schoolId]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<Payment>('/payments', query);

  /* `payments.approve` is the key the routes guard with. Without it the column is not rendered at all
     rather than rendered disabled: a control that can never be used is noise in every row. */
  const canReview = can('payments.approve');

  const onReviewed = useCallback(
    (message: string) => {
      success(message);
      setReviewing(null);
      reload();
    },
    [success, reload]
  );

  /** `refunds.manage` — its own key, held by super_admin alone in the seeded catalogue. */
  const canRefund = can('refunds.manage');

  function askRefund(row: Payment) {
    setRefunding(row);
    /* Blank means "all of it": the service defaults to the whole refundable balance. */
    setRefundAmount('');
    setRefundDestination('original_method');
    setRefundReason('');
    setRefundError(null);
  }

  async function submitRefund() {
    if (!refunding || refundBusy) return;
    setRefundBusy(true);
    setRefundError(null);
    try {
      const body: Record<string, unknown> = { destination: refundDestination };
      if (refundAmount.trim()) body.amount = refundAmount.trim();
      if (refundReason.trim()) body.reason = refundReason.trim();

      await api.post(`/payments/${refunding.id}/refunds`, body);
      success(`Refund raised against ${refunding.payment_number}`);
      setRefunding(null);
      reload();
    } catch (caught) {
      setRefundError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setRefundBusy(false);
    }
  }

  const columns = useMemo<Column<Payment>[]>(() => {
    const base: Column<Payment>[] = [
      {
        key: 'payment_number',
        header: 'Payment',
        primary: true,
        cell: (row) => <code className="whitespace-nowrap font-medium">{row.payment_number}</code>,
      },
      {
        /*
         * The name, resolved client-side by `useSchoolNames` — the payload carries only `school_id`,
         * because `detailInclude()` joins the invoice, the subscription, the transactions and the
         * refunds but never `School`. Falls back to `School #42`, which is what this column used to
         * show unconditionally.
         */
        key: 'school',
        header: 'School',
        cell: (row) => <span className="truncate text-muted">{nameFor(row.school_id)}</span>,
      },
      {
        key: 'amount',
        header: 'Amount',
        numeric: true,
        cell: (row) => <span className="whitespace-nowrap">{formatAmountWithCode(row.amount, row.currency)}</span>,
      },
      {
        key: 'method',
        header: 'Method',
        cell: (row) => <span className="whitespace-nowrap">{spell(row.method)}</span>,
      },
      {
        /*
         * `StatusBadge` tones `active`/`suspended`/`archived`/`cancelled` and gives every payment status
         * its neutral border. That is not an oversight to fix by forking the badge: the component's whole
         * argument is that the *word* carries the meaning and colour is the accelerator, and six payment
         * states do not map onto four tenancy states without inventing a colour vocabulary.
         */
        key: 'status',
        header: 'Status',
        cell: (row) => <StatusBadge status={row.status} />,
      },
      {
        /*
         * FR-BILL-004 names the pair — *"the submitted transaction ID and screenshot"* — so they share a
         * column. A reviewer is not asking "is there a screenshot?" and separately "is there a reference?";
         * they are asking whether this payment has enough evidence to act on, and the answer is both
         * fields or neither. `has_screenshot` is the boolean `present()` returns in place of the path.
         */
        key: 'proof',
        header: 'Proof',
        hideOnMobile: true,
        cell: (row) => (
          <div className="max-w-[16rem]">
            <span className={row.has_screenshot ? '' : 'text-muted-soft'}>
              {row.has_screenshot ? 'Screenshot' : 'No screenshot'}
            </span>
            {row.transaction_id ? (
              <code className="mt-0.5 block truncate text-xs text-muted">{row.transaction_id}</code>
            ) : null}
          </div>
        ),
      },
      {
        /*
         * When the school says the money moved, which is not when the row was written — the list is
         * ordered by `created_at DESC`, so a blank here on a recent row means "submitted, not yet dated".
         */
        key: 'paid_at',
        header: 'Paid',
        hideOnMobile: true,
        cell: (row) => {
          const day = formatDay(row.paid_at);
          return day ? <span className="whitespace-nowrap">{day}</span> : <span className="text-muted-soft">—</span>;
        },
      },
    ];

    if (!canReview && !canRefund) return base;

    return [
      ...base,
      {
        key: 'review',
        header: 'Review',
        cell: (row) => (
          <div className="flex flex-wrap gap-1">
            {/* Only `pending` is reviewable — the service answers anything else with a 409
                `PAYMENT_NOT_PENDING`, so offering the button on a settled row would promise a
                refusal. */}
            {canReview && row.status === 'pending' ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReviewing(row)}>
                <Icon name="check-circle" size={14} />
                Review
              </button>
            ) : null}
            {/*
              * Only money actually received can be given back. `RECEIVED_STATUSES` is what the
              * service checks, and `partially_refunded` is in it: a payment refunded in part can be
              * refunded again up to what is left, which is why it is offered here and not only on
              * `approved`.
              */}
            {canRefund && (row.status === 'approved' || row.status === 'partially_refunded') ? (
              <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => askRefund(row)}>
                Refund
              </button>
            ) : null}
            {(canReview && row.status === 'pending') ||
            (canRefund && (row.status === 'approved' || row.status === 'partially_refunded')) ? null : (
              <span className="text-muted-soft">—</span>
            )}
          </div>
        ),
      },
    ];
  }, [canReview, canRefund, nameFor]);

  const filtered = Boolean(debounced || status || method || schoolId);
  const clearFilters = () => {
    setSearch('');
    setDebounced('');
    setStatus('');
    setMethod('');
    setSchoolId('');
    setPage(1);
  };

  return (
    <div>
      <PageHeader
        title="Payments"
        description="Every payment recorded or submitted across the platform, newest first."
        action={
          <div className="flex gap-2">
            {canReview && status !== 'pending' ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setStatus('pending');
                  setPage(1);
                }}
              >
                <Icon name="clock" size={14} />
                Awaiting review
              </button>
            ) : null}
            {/*
              * FR-BILL-002 and FR-BILL-003 both land here, and the screen behind this link decides
              * which by what the account can do. Shown if either key is held rather than both.
              */}
            {can('payments.record') || can('payments.submit') ? (
              <Link href="/super-admin/payments/new" className="btn btn-primary btn-sm">
                Record a payment
              </Link>
            ) : null}
          </div>
        }
      />

      <FilterBar
        activeCount={[method, schoolId, search, status].filter(Boolean).length}
        onClear={() => {
          setMethod('');
          setSchoolId('');
          setSearch('');
          setStatus('');
          setPage(1);
        }}
      >
        <SearchField
          id="payment-search"
          label="Search payments by number"
          value={search}
          onChange={setSearch}
          placeholder="Search by payment number…"
        />

        <div>
          <FilterSelect
            id="payment-status"
            label="Status"
            labelVisible
            value={status}
            onChange={(value) => {
              setStatus(value);
              /* Same reason the search resets it: page four of the old result set is not page four here. */
              setPage(1);
            }}
          >
            <option value="">Any status</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {spell(value)}
              </option>
            ))}
          </FilterSelect>
        </div>

        <div>
          <FilterSelect
            id="payment-method"
            label="Method"
            labelVisible
            value={method}
            onChange={(value) => {
              setMethod(value);
              setPage(1);
            }}
          >
            <option value="">Any method</option>
            {METHODS.map((value) => (
              <option key={value} value={value}>
                {spell(value)}
              </option>
            ))}
          </FilterSelect>
        </div>

        {/* Only offered once the names have loaded — an empty select is a control that looks broken. */}
        {schools.length > 0 ? (
          <div>
            <FilterSelect
              id="payment-school"
              label="School"
              labelVisible
              value={schoolId}
              onChange={(value) => {
                setSchoolId(value);
                setPage(1);
              }}
            >
              <option value="">Any school</option>
              {schools.map((school) => (
                <option key={school.id} value={school.id}>
                  {school.name}
                </option>
              ))}
            </FilterSelect>
          </div>
        ) : null}

        {filtered ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
            <Icon name="x" size={14} />
            Clear filters
          </button>
        ) : null}
      </FilterBar>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock label="Loading payments…" />
      ) : rows.length === 0 ? (
        <EmptyNotice
          icon="credit-card"
          title={filtered ? 'No payment matches these filters' : 'No payments yet'}
          action={
            filtered ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null
          }
        >
          {filtered
            ? 'Try a different status, method or school — or clear the filters to see everything.'
            : 'Payments recorded by the platform, or submitted by a school for review, will appear here.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption="Payments"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <ReviewDialog
        payment={reviewing}
        schoolName={reviewing ? nameFor(reviewing.school_id) : ''}
        onClose={() => setReviewing(null)}
        onDone={onReviewed}
        onFailed={errorToast}
      />

      <Modal
        open={refunding !== null}
        onClose={() => {
          if (!refundBusy) setRefunding(null);
        }}
        title={`Refund ${refunding ? refunding.payment_number : 'this payment'}?`}
        description="Money already received is given back. A refund is a record of its own — the payment stays, and its status becomes refunded or partially refunded depending on how much is returned."
        size="sm"
        busy={refundBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={refundBusy}
              onClick={() => setRefunding(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={refundBusy}
              aria-busy={refundBusy}
              onClick={() => void submitRefund()}
            >
              {refundBusy ? <Spinner size={14} /> : null}
              {refundBusy ? 'Refunding…' : 'Raise refund'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {refundError ? <Notice tone="error">{refundError}</Notice> : null}

          {refunding ? (
            <p className="text-sm text-muted">
              {nameFor(refunding.school_id)} paid{' '}
              <strong>{formatAmountWithCode(refunding.amount, refunding.currency)}</strong> by{' '}
              {spell(refunding.method)}.
            </p>
          ) : null}

          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="refund-amount">
              Amount
            </label>
            <input
              id="refund-amount"
              type="number"
              step="0.01"
              min={0}
              className="field-input"
              value={refundAmount}
              onChange={(event) => setRefundAmount(event.target.value)}
            />
            <p className="mt-1 text-xs text-muted">
              {/*
                * Blank is a real answer and the useful default: `requestRefund()` refunds the whole
                * remaining balance when no amount is given. The screen does not compute that balance
                * itself — `GET /payments` returns `amount` but not `refunded_amount`, so a figure
                * shown here would be the full payment rather than what is left on a partly refunded
                * one, and would be wrong exactly where it mattered.
                */}
              Leave blank to refund everything still refundable on this payment. A larger amount is
              refused with the figure that is actually available.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="refund-destination">
              Destination
            </label>
            <select
              id="refund-destination"
              className="field-select"
              value={refundDestination}
              onChange={(event) => setRefundDestination(event.target.value)}
            >
              <option value="original_method">Back to the original method</option>
              <option value="wallet">To the school’s wallet</option>
            </select>
            <p className="mt-1 text-xs text-muted">
              The two the API accepts. Returning money the way it arrived is the default.
            </p>
          </div>

          <TextAreaField
            id="refund-reason"
            label="Reason"
            rows={2}
            value={refundReason}
            onChange={(event) => setRefundReason(event.target.value)}
            hint="Recorded on the refund and in the audit trail. This is what explains the money leaving."
          />
        </div>
      </Modal>
    </div>
  );
}

/* ─────────────────────────────── FR-BILL-004: the decision ─────────────────────────────── */

/**
 * Approve or reject one payment.
 *
 * ## Why the evidence is repeated inside the dialog
 *
 * The reviewer is about to move money against an invoice. Reading the amount off the row behind a
 * dialog and pressing a button inside it is how the wrong payment gets approved, so the dialog restates
 * what is being decided — school, amount, method, reference, screenshot — and the buttons sit under
 * that rather than under the table.
 *
 * ## The rejection reason is required here, and the schema does not require it
 *
 * `payments.validation.js` allows `rejection_reason` to be absent. This dialog will not send a rejection
 * without one. That is a deliberate, documented departure from `form.tsx`'s "no client-side rule engine"
 * rule, and it is not validation drift: a stricter client cannot accept anything the server refuses. It
 * is there because FR-BILL-004's rejection is a message *to the school* — `rejection_reason` is the field
 * the school reads — and a rejection with nothing in it tells them only that they must ask someone.
 *
 * ## Approving without an invoice
 *
 * `review()` refuses an approval when `invoice_id` is null (`PAYMENT_NO_INVOICE`) — there is nothing to
 * settle. The dialog says so up front and disables Approve, rather than letting the reviewer discover it
 * from a 409. Reject stays available, which is the action that payment actually needs.
 */
function ReviewDialog({
  payment,
  schoolName,
  onClose,
  onDone,
  onFailed,
}: {
  payment: Payment | null;
  schoolName: string;
  onClose: () => void;
  onDone: (message: string) => void;
  onFailed: (title: string, description?: string) => void;
}) {
  const [mode, setMode] = useState<'choose' | 'reject'>('choose');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * The proof image, as an object URL.
   *
   * ## Why it cannot be an `<img src>` pointing at the route
   *
   * `GET /payments/:id/screenshot` is behind `requirePermission('payments.view')`, and
   * `middlewares/authenticate.js` `readBearerToken` reads `req.get('Authorization')` and nothing
   * else — no cookie fallback. A browser fetching an `<img>` sends no Authorization header, so the
   * request is a 401 and the dialog shows a broken image. The bytes have to come through the
   * authenticated client and then be handed to the `<img>` as a blob URL.
   *
   * `proof` is a small state machine rather than a nullable string because "not fetched yet",
   * "fetching", "here it is" and "it would not load" are four different things to show, and a
   * reviewer deciding on FR-BILL-004 needs to know which one they are looking at — an empty frame
   * that might still be loading is the one answer that would make them guess.
   */
  const [proof, setProof] = useState<
    { state: 'idle' } | { state: 'loading' } | { state: 'ready'; url: string } | { state: 'failed' }
  >({ state: 'idle' });

  /* Reset every time a different payment is opened — otherwise the previous reviewer's half-typed
     rejection reason is sitting in the box for the next payment. */
  useEffect(() => {
    if (payment) {
      setMode('choose');
      setNote('');
      setReason('');
      setReasonError(null);
      setFailure(null);
      setBusy(false);
    }
  }, [payment]);

  /*
   * Fetch the proof when a payment that has one is opened, and revoke the URL on the way out.
   *
   * The revoke is in the cleanup rather than deferred on a timer: unlike `saveFile`, nothing here
   * races a navigation, and holding a blob for every payment a reviewer opens in a sitting is a leak
   * that grows with the size of the images. `cancelled` guards the late resolve — React 19 Strict
   * Mode runs this mount → unmount → mount, so the first fetch lands after its own teardown.
   */
  useEffect(() => {
    if (!payment?.has_screenshot) {
      setProof({ state: 'idle' });
      return;
    }

    let cancelled = false;
    let url: string | null = null;
    setProof({ state: 'loading' });

    (async () => {
      try {
        const file = await api.download(`/payments/${payment.id}/screenshot`);
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
  }, [payment?.id, payment?.has_screenshot]);

  if (!payment) return null;

  const settleable = payment.invoice_id !== null;

  const submit = async (decision: 'approve' | 'reject') => {
    if (decision === 'reject' && !reason.trim()) {
      setReasonError('Say why this payment is being rejected — the school is shown this message.');
      return;
    }

    setBusy(true);
    setFailure(null);

    try {
      /*
       * The two calls are written out rather than built from `decision`, and the bodies with them.
       *
       * This read `api.post(\`/payments/${payment.id}/${decision}\`, body)`, which works and is
       * invisible to `verify-frontend.js`: that suite collects `api.<method>(` followed
       * **immediately** by a path literal, so both FR-BILL-004 routes went on reporting as having no
       * caller for as long as this screen has existed. The same trap is recorded in
       * `subscriptions/[id]/lifecycle.tsx`, which hit it twice before getting it right.
       */
      if (decision === 'approve') {
        await api.post(`/payments/${payment.id}/approve`, { note: note.trim() || undefined });
      } else {
        await api.post(`/payments/${payment.id}/reject`, {
          rejection_reason: reason.trim(),
          note: note.trim() || undefined,
        });
      }
      onDone(
        decision === 'approve'
          ? `Payment ${payment.payment_number} approved`
          : `Payment ${payment.payment_number} rejected`
      );
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;

      /*
       * A 409 means the row moved under the reviewer — someone else decided it, or the invoice was
       * cancelled while this sat open. That is worth saying inside the dialog, because the answer is
       * "close this and look again", not "retry".
       */
      if (caught.status === 409) {
        setFailure(caught.message);
      } else {
        onFailed('Could not record that decision', caught.message);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={payment !== null}
      onClose={onClose}
      busy={busy}
      title={mode === 'reject' ? 'Reject this payment' : 'Review payment'}
      description={
        mode === 'reject'
          ? 'The school is told the payment was rejected, and shown the reason you give.'
          : 'Check the evidence against the amount before deciding.'
      }
      footer={
        mode === 'reject' ? (
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setMode('choose')} disabled={busy}>
              Back
            </button>
            <button type="button" className="btn btn-danger" onClick={() => submit('reject')} disabled={busy}>
              {busy ? 'Rejecting…' : 'Reject payment'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => setMode('reject')}
              disabled={busy}
            >
              Reject…
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => submit('approve')}
              disabled={busy || !settleable}
            >
              {busy ? 'Approving…' : 'Approve payment'}
            </button>
          </>
        )
      }
    >
      <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted">Payment</dt>
        <dd>
          <code className="font-medium">{payment.payment_number}</code>
        </dd>

        <dt className="text-muted">School</dt>
        <dd className="text-ink">{schoolName}</dd>

        <dt className="text-muted">Amount</dt>
        <dd className="font-semibold tabular-nums text-ink">
          {formatAmountWithCode(payment.amount, payment.currency)}
        </dd>

        <dt className="text-muted">Method</dt>
        <dd className="text-ink">{spell(payment.method)}</dd>

        <dt className="text-muted">Reference</dt>
        <dd>
          {payment.transaction_id ? (
            <code className="break-all text-xs">{payment.transaction_id}</code>
          ) : (
            <span className="text-muted-soft">None given</span>
          )}
        </dd>

        <dt className="text-muted">Screenshot</dt>
        <dd className={payment.has_screenshot ? 'text-ink' : 'text-muted-soft'}>
          {payment.has_screenshot ? 'Attached' : 'None attached'}
        </dd>

        {/*
          * The proof itself, spanning both columns.
          *
          * The dialog's own description tells the reviewer to "check the evidence against the
          * amount", and until now the only evidence on screen was the word "Attached". A failure to
          * load says so rather than showing an empty frame, because a reviewer who cannot tell
          * "no proof" from "proof did not load" will approve on the transaction id alone.
          */}
        {payment.has_screenshot ? (
          <div className="col-span-2 mt-1">
            {proof.state === 'ready' ? (
              <a
                href={proof.url}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-md border border-border-strong bg-surface-2"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a blob URL, not a served asset */}
                <img
                  src={proof.url}
                  alt={`Payment proof for ${payment.payment_number}`}
                  className="max-h-72 w-full object-contain"
                />
              </a>
            ) : proof.state === 'loading' ? (
              <p className="flex items-center gap-2 rounded-md border border-border-soft bg-surface-2 px-3 py-6 text-sm text-muted">
                <Spinner size={14} />
                Loading the proof…
              </p>
            ) : (
              <p className="rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
                The proof could not be loaded. Decide on the reference above, or ask the school to
                re-send it.
              </p>
            )}
            {proof.state === 'ready' ? (
              <p className="mt-1.5 text-xs text-muted-soft">Opens full size in a new tab.</p>
            ) : null}
          </div>
        ) : null}

        <dt className="text-muted">Paid</dt>
        <dd className="text-ink">{formatDay(payment.paid_at) ?? <span className="text-muted-soft">Not dated</span>}</dd>
      </dl>

      {failure ? (
        <div className="mb-4">
          <Notice tone="error">{failure}</Notice>
        </div>
      ) : null}

      {mode === 'choose' && !settleable ? (
        <div className="mb-4">
          <Notice tone="warn">
            This payment is not linked to an invoice, so there is nothing for an approval to settle.
            It can still be rejected.
          </Notice>
        </div>
      ) : null}

      {mode === 'reject' ? (
        <div className="space-y-4">
          <TextAreaField
            id="rejection-reason"
            label="Reason the school will see"
            rows={3}
            required
            maxLength={255}
            value={reason}
            error={reasonError}
            onChange={(event) => {
              setReason(event.target.value);
              if (reasonError) setReasonError(null);
            }}
            hint="For example: the reference does not match any transfer we received."
          />
          <TextAreaField
            id="review-note"
            label="Internal note"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            hint="Kept on the payment record. The school does not see this."
          />
        </div>
      ) : (
        <TextAreaField
          id="approve-note"
          label="Internal note"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          hint="Optional. Kept on the payment record; the school does not see it."
        />
      )}
    </Modal>
  );
}
