'use client';

/**
 * Invoices — SRS §13.1 and §33's "Invoices", checklist row 4.3.
 *
 * The four moving parts `schools/page.tsx` settled: one `useCollection`, one `Column[]`, the
 * four-state render in the order refusal → error → loading → empty → table, and `Pagination`.
 * What follows is only the decisions this screen had to make for itself.
 *
 * ## Seven columns out of thirty
 *
 * `invoices.controller.present()` spreads the whole row and then joins `items`, `plan`, `coupon`,
 * `tax` and `payments` on top of it, so the response is far larger than a list should render. The
 * seven kept are the ones an administrator scans a billing list *for*: which document, whose, on
 * what plan, how much was billed, how much is still owed, when it falls due, and where it stands.
 * Everything else is detail for a single-invoice screen, where there is room to lay out the
 * subtotal → discount → tax → total derivation in the order §13.1 states it.
 *
 * `issue_date` is the one omission worth naming, because it is a §13.1 field. The service's
 * `DEFAULT_SORT` is `['issue_date', 'DESC']`, so the ordering of the table already carries it —
 * a column repeating the sort key earns less than the space it costs, and `due_date` is the date
 * that tells an administrator whether to act.
 *
 * ## The search box sends `number`, not `q`
 *
 * `invoices.validation.js` builds its list schema with `listQuery()`, which merges in
 * `commonSchemas.search` — so `q` passes validation on this endpoint. But `invoices.service.list()`
 * never reads it: the only text filter it implements is `number`, a `LIKE '%…%'` on
 * `invoice_number`. A search box wired to `q` would therefore be accepted, ignored, and return the
 * unfiltered page — the worst of the three possible outcomes, because nothing anywhere reports it.
 * The debounce is the exemplar's, and for the exemplar's reason: `apiLimiter` sits in front of
 * authentication, so a request per keystroke spends a budget that is not free.
 *
 * ## Status and "outstanding" are one control because the API makes them one
 *
 * `invoices.service.list()` applies `status` first and then, unconditionally,
 * `if (query.outstanding) where.status = { [Op.in]: OUTSTANDING_STATUSES }` — the second assignment
 * overwrites the first. Two independent controls could therefore be set to "Paid" and "Outstanding"
 * at once and the screen would show outstanding invoices under a filter reading Paid. A single
 * select cannot express the contradiction, so it cannot be sent.
 *
 * `outstanding` is worth the top slot rather than being left to the seven statuses: it is the
 * shorthand for `unpaid + partially_paid + overdue`, which is the question a billing screen is
 * opened to answer, and `draft` is deliberately outside it — a draft is not yet a demand.
 */

import { useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { formatCodeWithAmount } from '@/lib/money';
import { useCollection } from '@/lib/useCollection';
import { useSchoolNames } from '@/lib/useSchoolNames';
import type { Query } from '@/lib/useCollection';
import { Field, Notice, SubmitButton, TextAreaField } from '@/components/form';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';
import {
  SearchField,
  FilterBar,
  FilterSelect,
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
 * One row of `GET /invoices`, as `present()` actually returns it.
 *
 * The money fields are `DECIMAL(14,2)`, and they arrive as JS **numbers**. This comment used to say
 * the opposite — *"Sequelize hands DECIMALs back as strings … typing them as `number` would compile
 * and then produce `"1200.00" + "300.00" === "1200.00300.00"`"* — which was measured false:
 * `config/database.js` sets `dialectOptions.decimalNumbers = true`, so mysql2 parses them before
 * Sequelize sees them. The underlying warning still stands, though, and is why formatting lives in
 * `lib/money.ts` and no arithmetic on money happens on this side of the wire.
 *
 * `issue_date` and `due_date` are `DATEONLY`, which arrives as `YYYY-MM-DD` — a calendar date with
 * no instant behind it. `is_overdue` is not a column: the controller derives it per request from
 * `due_date` and the clock, because `markOverdue()` is a scheduled sweep and `src/jobs/` does not
 * exist yet, so an invoice can be genuinely past due while `status` still reads `unpaid`.
 */
interface Invoice {
  id: number;
  invoice_number: string;
  school_id: number;
  plan_name: string | null;
  currency: string;
  total: number;
  amount_due: number;
  due_date: string;
  status: string;
  is_overdue: boolean;
}

/*
 * Money formatting comes from `lib/money.ts`, which three billing screens now share.
 *
 * The reasoning this screen recorded for rolling its own is still the right reasoning and is kept
 * there: not `Intl.NumberFormat({ style: 'currency' })`, because `invoices.currency` is a
 * `STRING(10)` with no ISO constraint behind it and an unrecognised code makes that constructor
 * throw a `RangeError` — a formatter that can crash the row it renders is the wrong tool for data
 * this loose. And because this list spans every school on the platform, two rows can be different
 * currencies: `$1,200.00` twice would be actively misleading where `USD` and `CAD` are both `$`.
 * The code is written out beside the figure for that reason.
 */

/**
 * The one status control. `outstanding` is the service's own shorthand, not a status; every other
 * value is a member of `INVOICE_STATUS`, and the query builder below routes it to the right key.
 */
const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'outstanding', label: 'Outstanding — unpaid, part paid or overdue' },
  { value: 'draft', label: 'Draft' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'partially_paid', label: 'Partly paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'refunded', label: 'Refunded' },
];


/**
 * The four things that can be done to an invoice — SRS §13.1, FR-BILL-001, and §13.3's coupons.
 *
 * `POST /:id/finalise`, `POST /:id/cancel`, `POST /:id/coupon` and `DELETE /:id/coupon`, none of
 * which had a caller. The screen could list invoices and generate a run of them; it could not issue
 * one, void one, or apply the discount coupons exist to give.
 *
 * ## Finalise is the one that changes what the invoice *is*
 *
 * A draft is a working document; finalising issues it, which is what makes it payable and what the
 * §23 job notifies about. The copy says that rather than "are you sure", because an operator who
 * reads "finalise" as "save" will issue every draft they open.
 *
 * ## Cancel is not delete
 *
 * `invoices.status` moves to `cancelled` and the row stays — it is billing history, and §13 gives no
 * delete route at all. An invoice already paid cannot be cancelled; the API refuses that, and the
 * dialog says so before the button is pressed rather than after.
 *
 * ## The coupon is applied by **code**, not by picking from the catalogue
 *
 * `applyCoupon` takes `{ code }` and the service resolves it — checking that it exists, is active,
 * is inside its window, has redemptions left and applies to this invoice's plan. A picker built from
 * `GET /coupons` would offer codes that fail every one of those checks and would still have to send
 * the code. So the control is the field the API actually takes, and the refusal it can give is
 * rendered where the code was typed.
 */
const INVOICE_ACTIONS: Record<
  string,
  {
    label: string;
    title: string;
    description: string;
    confirm: string;
    busy: string;
    tone: 'primary' | 'danger';
    /** True for the one action that carries a field of its own. */
    code?: boolean;
  }
> = {
  finalise: {
    label: 'Finalise',
    title: 'Issue this invoice?',
    description:
      'Finalising turns a draft into an issued invoice: it becomes payable, it counts towards what the school owes, and its number is fixed. A draft can still be replaced by regenerating; an issued invoice cannot.',
    confirm: 'Finalise invoice',
    busy: 'Finalising…',
    tone: 'primary',
  },
  cancel: {
    label: 'Cancel',
    title: 'Cancel this invoice?',
    description:
      'The invoice stops being payable and is kept as billing history — nothing is deleted, and §13 provides no way to delete one. An invoice that has already been paid cannot be cancelled; the API refuses that.',
    confirm: 'Cancel invoice',
    busy: 'Cancelling…',
    tone: 'danger',
  },
  coupon: {
    label: 'Apply coupon',
    title: 'Apply a coupon to this invoice?',
    description:
      'The discount is worked out by the API from the coupon’s own rules and applied to this invoice’s total. A coupon that has expired, run out of redemptions or does not apply to this plan is refused with the reason.',
    confirm: 'Apply coupon',
    busy: 'Applying…',
    tone: 'primary',
    code: true,
  },
  uncoupon: {
    label: 'Remove coupon',
    title: 'Remove the coupon from this invoice?',
    description:
      'The discount comes off and the total goes back up. The redemption is released, so the coupon can be used again elsewhere.',
    confirm: 'Remove coupon',
    busy: 'Removing…',
    tone: 'danger',
  },
};

export default function InvoicesPage() {
  const { can } = useAuth();
  const { nameFor } = useSchoolNames();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useMemo<Query>(() => {
    const base: Query = { page, limit: 20, number: debounced || undefined };

    /*
     * `outstanding` is a `Joi.boolean()`, which accepts the string form — and it has to be a string,
     * because `Query` carries no boolean and `buildUrl` would stringify it anyway.
     */
    if (statusFilter === 'outstanding') return { ...base, outstanding: 'true' };
    if (statusFilter) return { ...base, status: statusFilter };
    return base;
  }, [page, debounced, statusFilter]);

  const { rows, meta, loading, error, refusal, reload } = useCollection<Invoice>('/invoices', query);

  /* ── the four write actions ── */

  const { success } = useToast();
  const [pending, setPending] = useState<{ action: string; invoice: Invoice } | null>(null);
  const [couponCode, setCouponCode] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /*
   * The coupon preview — `POST /coupons/validate`, which had no caller anywhere.
   *
   * `docs/VERIFICATION.md` classified it as *deliberately* uncalled, "a checkout-time call and there
   * is no checkout screen". That was right about the absence and wrong about the conclusion: this
   * dialog **is** the checkout moment for an invoice, and it has every field the endpoint needs —
   * the school, the amount and the currency all sit on the row. What it adds over simply applying
   * the coupon is the figure: `POST /:id/coupon` answers with the invoice, so an operator who wants
   * to know what a code is worth before committing has to commit to find out.
   *
   * `plan_id` is not sent. `GET /invoices` returns `plan_name` and not the id, so a coupon
   * restricted to particular plans cannot be checked against this invoice's plan here — the preview
   * would say it applies and `POST /:id/coupon` would then refuse it. The notice says so rather than
   * letting the operator read a green tick as a guarantee.
   */
  const [preview, setPreview] = useState<{ discount: number; net: number; label: string } | null>(null);
  const [checking, setChecking] = useState(false);

  const canManage = can('invoices.manage');
  const copy = pending ? INVOICE_ACTIONS[pending.action] : null;

  function ask(action: string, invoice: Invoice) {
    setPending({ action, invoice });
    setCouponCode('');
    setReason('');
    setActionError(null);
    setPreview(null);
  }

  /** Ask the API what a code is worth against this invoice, without applying it. */
  async function checkCoupon() {
    if (!pending || checking || couponCode.trim() === '') return;
    setChecking(true);
    setActionError(null);
    setPreview(null);
    try {
      const result = await api.post<{
        discount_amount: number;
        net_amount: number;
        coupon: { code: string; discount_type: string; discount_value: number };
      }>('/coupons/validate', {
        code: couponCode.trim(),
        school_id: pending.invoice.school_id,
        amount: pending.invoice.total,
        currency: pending.invoice.currency,
      });
      setPreview({
        discount: result.discount_amount,
        net: result.net_amount,
        label:
          result.coupon.discount_type === 'percentage'
            ? `${result.coupon.discount_value}% off`
            : 'fixed amount off',
      });
    } catch (caught) {
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setChecking(false);
    }
  }

  async function run() {
    if (!pending || busy) return;
    setBusy(true);
    setActionError(null);
    const body = reason.trim() ? { reason: reason.trim() } : {};
    const id = pending.invoice.id;
    try {
      /*
       * Four calls written out rather than one path built from `pending.action`.
       *
       * `verify-frontend.js` collects `api.<method>(` followed immediately by a path literal, so a
       * URL assembled from the action name is invisible to the very check that exists to catch a
       * route with no caller — recorded in `subscriptions/[id]/lifecycle.tsx` after two drafts of
       * this same mistake. `DELETE` also takes no body, which is a second reason these cannot be
       * one call: `api.delete` has no body parameter at all.
       */
      if (pending.action === 'finalise') {
        await api.post(`/invoices/${id}/finalise`, body);
      } else if (pending.action === 'cancel') {
        await api.post(`/invoices/${id}/cancel`, body);
      } else if (pending.action === 'coupon') {
        await api.post(`/invoices/${id}/coupon`, { code: couponCode.trim(), ...body });
      } else {
        await api.delete(`/invoices/${id}/coupon`);
      }
      success(`${copy?.label ?? 'Done'} — ${pending.invoice.invoice_number}`);
      setPending(null);
      reload();
    } catch (caught) {
      /*
       * Shown inside the dialog rather than as a toast behind it. Every refusal these four can give
       * is actionable where the operator is standing — a coupon that has expired, an invoice already
       * paid, a draft that is already issued — and a message behind an open dialog is a message read
       * through the thing that is covering it.
       */
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<Column<Invoice>[]>(
    () => [
      {
        key: 'invoice_number',
        header: 'Invoice',
        cell: (row) => <span className="font-medium whitespace-nowrap">{row.invoice_number}</span>,
      },
      {
        key: 'school',
        header: 'School',
        /*
         * The name, from `lib/useSchoolNames`. `detailInclude()` joins the plan, coupon, tax, items
         * and payments but not the school, so the response holds only `school_id` — this column used
         * to print `#12797`, which is not something a person can reconcile an invoice against. The
         * comment here previously ruled the fix out because "fetching one per row would be twenty
         * requests to decorate a page of twenty", and that objection was right about the method: the
         * lookup is **one** request per session, shared with the payments and subscriptions screens,
         * and it falls back to `School #12797` above its ceiling. No endpoint changed shape.
         */
        cell: (row) => <span className="truncate text-muted">{nameFor(row.school_id)}</span>,
      },
      {
        key: 'plan_name',
        header: 'Plan',
        /*
         * The snapshot taken at issue time, not the subscription's plan today — which is the point
         * of the column, since an invoice must keep saying what it billed for after an upgrade.
         * Displayed and never tested: §30 Rule 1 forbids branching on a plan name, and a list cell
         * that read `plan_name === 'Premium'` would be that rule's own counter-example.
         */
        cell: (row) => row.plan_name ?? <span className="text-muted-soft">—</span>,
      },
      {
        key: 'total',
        header: 'Total',
        numeric: true,
        cell: (row) => formatCodeWithAmount(row.currency, row.total),
      },
      {
        key: 'amount_due',
        header: 'Due',
        numeric: true,
        /*
         * Shown beside the total rather than instead of it. They differ by what has been paid, and
         * an invoice partly settled is the case where seeing only one of the two figures misleads.
         */
        cell: (row) => formatCodeWithAmount(row.currency, row.amount_due),
      },
      {
        key: 'due_date',
        header: 'Due date',
        cell: (row) => (
          <span className="whitespace-nowrap">
            {/*
              * Printed as the API sends it. `new Date('2026-01-05')` is parsed as UTC midnight, so
              * `toLocaleDateString()` in any negative-offset timezone renders the 4th — a DATEONLY
              * is a calendar date with no instant behind it, and giving it one shifts the day.
              */}
            {row.due_date}
            {row.is_overdue ? (
              <span className="ml-2 text-xs text-danger">overdue</span>
            ) : null}
          </span>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        /*
         * The stored status, which is the record. `is_overdue` sits on the due date instead of
         * being folded in here, so the badge never contradicts the column the API sorts and filters
         * on — an invoice can read `unpaid` and still be past due until the sweep runs.
         */
        cell: (row) => <StatusBadge status={row.status} />,
      },
      ...(canManage
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: Invoice) => (
                <div className="flex flex-wrap gap-1">
                  {/*
                    * Which actions a row is offered is decided from its stored status, and only to
                    * hide the absurd — the API is the authority and refuses the rest. A draft is the
                    * only thing that can be issued; a paid or already-cancelled invoice cannot be
                    * cancelled; and a coupon can be applied to anything still open.
                    */}
                  {row.status === 'draft' ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => ask('finalise', row)}
                    >
                      Finalise
                    </button>
                  ) : null}
                  {row.status !== 'paid' && row.status !== 'cancelled' ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => ask('coupon', row)}
                      >
                        Coupon
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger-ghost"
                        onClick={() => ask('cancel', row)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : null}
                  {/*
                    * Removing a coupon is offered on every open invoice rather than only on one the
                    * list can see carries a coupon: `GET /invoices` does not return `coupon_id`, so
                    * this screen cannot tell. Hiding it on a guess would hide it from the invoices
                    * that have one; offering it means an invoice without one is refused by the API
                    * with a message that says exactly that.
                    */}
                  {row.status !== 'paid' && row.status !== 'cancelled' ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => ask('uncoupon', row)}
                    >
                      Remove coupon
                    </button>
                  ) : null}
                </div>
              ),
            } as Column<Invoice>,
          ]
        : []),
    ],
    /* `nameFor` must be listed: the school lookup resolves after the first render, and an empty
       dependency array froze these columns around the version that still answered `School #12797`. */
    [nameFor, canManage]
  );

  return (
    <div>
      <PageHeader
        title="Invoices"
        description="Every invoice issued on the platform, newest first."
        action={
          /*
           * Hidden without the permission, as on every list — a courtesy, not a control. Here the
           * API is doubly unmoved by the button existing: `POST /invoices/generate` mounts
           * `requirePlatformScope()` *and* `requirePermission('invoices.manage')`, so a school-side
           * caller is refused by the scope guard even if a Super Admin re-granted the key under
           * FR-AUTH-009. "Generate" rather than "New": there is no free-form `POST /invoices`,
           * because FR-BILL-001's precondition is that a subscription exists and is being billed.
           */
          can('invoices.manage') ? (
            <a
              href="/super-admin/invoices/new"
              className="btn btn-primary"
            >
              Generate invoice
            </a>
          ) : null
        }
      />

      <FilterBar
        activeCount={[search, statusFilter].filter(Boolean).length}
        onClear={() => {
          setSearch('');
          setStatusFilter('');
          setPage(1);
        }}
      >
        <SearchField
          id="invoice-search"
          label="Search invoices by number"
          placeholder="Search by invoice number…"
          value={search}
          onChange={setSearch}
        />

        <FilterSelect
          id="invoice-status"
          label="Filter by status"
          value={statusFilter}
          onChange={(value) => {
            setStatusFilter(value);
            /* Same reason as the search: page four of the old filter is rarely page four of the new. */
            setPage(1);
          }}
        >
          {STATUS_FILTERS.map((option) => (
            <option key={option.value || 'all'} value={option.value}>
              {option.label}
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
        /*
         * The empty message names whichever control is narrowing the list, because "no invoices"
         * under an active filter is read as "the platform has none" and sends the reader looking
         * for a problem that is one select away from resolving.
         */
        <EmptyNotice>
          {debounced
            ? `No invoice number matches “${debounced}”.`
            : statusFilter
              ? 'No invoice matches this status.'
              : 'No invoices have been issued yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Invoices"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <Modal
        open={pending !== null}
        onClose={() => {
          if (!busy) setPending(null);
        }}
        title={copy?.title ?? ''}
        description={copy?.description}
        size="sm"
        busy={busy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              {/* "Go back", not "Cancel", on the dialog whose action is itself a cancellation. */}
              {pending?.action === 'cancel' ? 'Go back' : 'Cancel'}
            </button>
            <SubmitButton
              form="invoice-action"
              busy={busy}
              busyLabel={copy?.busy ?? 'Working…'}
              fullWidth={false}
              disabled={pending?.action === 'coupon' && couponCode.trim() === ''}
            >
              {copy?.confirm ?? 'Apply'}
            </SubmitButton>
          </>
        }
      >
        <form
          id="invoice-action"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          {actionError ? <Notice tone="error">{actionError}</Notice> : null}

          {pending ? (
            <p className="text-sm text-muted">
              Invoice <strong>{pending.invoice.invoice_number}</strong> ·{' '}
              {nameFor(pending.invoice.school_id)} ·{' '}
              {formatCodeWithAmount(pending.invoice.currency, pending.invoice.total)}
            </p>
          ) : null}

          {copy?.code ? (
            <>
              <Field
                id="coupon-code"
                label="Coupon code"
                required
                value={couponCode}
                onChange={(event) => {
                  setCouponCode(event.target.value);
                  /* A preview belongs to the code it was fetched for, and this is a different one. */
                  setPreview(null);
                }}
                hint="Exactly as issued. Whether it applies to this invoice is decided by the API from the coupon’s own rules."
              />

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={checking || couponCode.trim() === ''}
                aria-busy={checking}
                onClick={() => void checkCoupon()}
              >
                {checking ? 'Checking…' : 'Check what it is worth'}
              </button>

              {preview && pending ? (
                <Notice tone="success">
                  {preview.label} —{' '}
                  <strong>
                    {formatCodeWithAmount(pending.invoice.currency, preview.discount)}
                  </strong>{' '}
                  off, bringing this invoice to{' '}
                  {formatCodeWithAmount(pending.invoice.currency, preview.net)} before tax. A coupon
                  restricted to particular plans is not checked here — this invoice’s plan id is not
                  in the list response — so applying it can still be refused.
                </Notice>
              ) : null}
            </>
          ) : null}

          {/*
            * `DELETE /:id/coupon` validates a body but `api.delete` sends none, so the reason field
            * is not offered on that one action — a box whose contents cannot be transmitted is worse
            * than no box.
            */}
          {pending?.action === 'uncoupon' ? null : (
            <TextAreaField
              id="invoice-reason"
              label="Reason"
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              hint="Recorded in the audit trail."
            />
          )}
        </form>
      </Modal>
    </div>
  );
}
