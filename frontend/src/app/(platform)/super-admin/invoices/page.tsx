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
 * Everything else is detail for the single-invoice screen, `invoices/[id]`, which lays out every
 * §13.1 field, the subtotal → discount → tax → total derivation in the order §13.1 states it, and
 * the line items. Each row's invoice number links to it.
 *
 * `issue_date` is the one omission worth naming. It is not one of §13.1's eleven fields (SRS §13.1
 * lists Invoice Number, School, Plan, Add-ons, Billing Period, Subtotal, Discount, Tax, Total, Due
 * Date and Status) — this comment used to say it was — but it is the date an invoice is filed by.
 * The service's `DEFAULT_SORT` is `['issue_date', 'DESC']`, so the ordering of the table already
 * carries it — a column repeating the sort key earns less than the space it costs, and `due_date` is
 * the date that tells an administrator whether to act. The single-invoice screen prints it.
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

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { formatCodeWithAmount } from '@/lib/money';
import { useCollection } from '@/lib/useCollection';
import { useSchoolNames } from '@/lib/useSchoolNames';
import type { Query } from '@/lib/useCollection';
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

import { actionsFor, useInvoiceActions } from './actions';

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
 * `due_date` and the clock. `markOverdue()` is a scheduled sweep — `backend/src/jobs/cron.js` runs
 * `tasks/invoiceOverdue.js` once a day (`20 2 * * *`, server time) where `ENABLE_CRON` is on — so
 * between an invoice's due date passing and the next sweep it is genuinely past due while `status`
 * still reads `unpaid`. (This used to say `src/jobs/` did not exist; it does.)
 *
 * `plan_id`, `subtotal`, `amount_paid` and `coupon_id` are read by `actionsFor()` and the coupon
 * dialog in `./actions.tsx`, not rendered — `present()` spreads the whole row onto every list item,
 * so they are here as on the single-invoice read.
 */
interface Invoice {
  id: number;
  invoice_number: string;
  school_id: number;
  plan_id: number | null;
  plan_name: string | null;
  currency: string;
  subtotal: number;
  total: number;
  amount_paid: number;
  amount_due: number;
  coupon_id: number | null;
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

/*
 * The four write actions — finalise, cancel, apply and remove a coupon — their dialog, and
 * `actionsFor()`, which decides which of them an invoice is offered, live in `./actions.tsx`, shared
 * with the single-invoice screen so the two cannot offer different buttons on the same invoice.
 */

export default function InvoicesPage() {
  const { can, profile } = useAuth();
  const { nameFor, schools } = useSchoolNames();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  /*
   * `invoices.service.list()` reads `school_id` and the list schema accepts it, and nothing on this
   * screen could send it — a platform-wide billing list with no way to ask "what does this school
   * owe?". Fed from the same cached lookup that names the School column, as on payments.
   */
  const [schoolId, setSchoolId] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useMemo<Query>(() => {
    const base: Query = {
      page,
      limit: 20,
      number: debounced || undefined,
      school_id: schoolId || undefined,
    };

    /*
     * `outstanding` is a `Joi.boolean()`, which accepts the string form — and it has to be a string,
     * because `Query` carries no boolean and `buildUrl` would stringify it anyway.
     */
    if (statusFilter === 'outstanding') return { ...base, outstanding: 'true' };
    if (statusFilter) return { ...base, status: statusFilter };
    return base;
  }, [page, debounced, statusFilter, schoolId]);

  const { rows, meta, loading, error, refusal, reload } = useCollection<Invoice>('/invoices', query);

  /* ── the four write actions — `./actions.tsx` ── */

  const canManage = can('invoices.manage');
  const { ask, dialog } = useInvoiceActions({ onDone: reload, nameFor });

  const columns = useMemo<Column<Invoice>[]>(
    () => [
      {
        key: 'invoice_number',
        header: 'Invoice',
        /* The way into `invoices/[id]`, where the rest of §13.1's fields and the lines are shown. */
        cell: (row) => (
          <Link
            href={`/super-admin/invoices/${row.id}`}
            className="font-medium whitespace-nowrap underline-offset-2 hover:underline focus-visible:underline"
          >
            {row.invoice_number}
          </Link>
        ),
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
              cell: (row: Invoice) => {
                /*
                 * `actionsFor()` reads the service's own refusals off the row: a coupon only while the
                 * invoice is a draft or unpaid with nothing paid, applied only when it carries none and
                 * removed only when it carries one; a cancel only while nothing is paid. The list used
                 * to offer both coupon buttons and Cancel on every invoice not paid or cancelled, so a
                 * part-paid or refunded invoice carried three buttons that each ended in a 409, an
                 * overdue one two, and every open invoice a Remove coupon whether it had a coupon or
                 * not — on the premise that `GET /invoices` did not return `coupon_id`. It does:
                 * `present()` spreads the whole row.
                 */
                const offered = actionsFor(row);
                if (!offered.finalise && !offered.applyCoupon && !offered.removeCoupon && !offered.cancel) {
                  return <span className="text-muted-soft">—</span>;
                }
                return (
                  <div className="flex flex-wrap gap-1">
                    {offered.finalise ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => ask('finalise', row)}
                      >
                        Finalise
                      </button>
                    ) : null}
                    {offered.applyCoupon ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => ask('coupon', row)}
                      >
                        Coupon
                      </button>
                    ) : null}
                    {offered.removeCoupon ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => ask('uncoupon', row)}
                      >
                        Remove coupon
                      </button>
                    ) : null}
                    {offered.cancel ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-danger-ghost"
                        onClick={() => ask('cancel', row)}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>
                );
              },
            } as Column<Invoice>,
          ]
        : []),
    ],
    /* `nameFor` must be listed: the school lookup resolves after the first render, and an empty
       dependency array froze these columns around the version that still answered `School #12797`.
       `ask` is stable — `useInvoiceActions` memoises it — and is listed because the cells call it. */
    [nameFor, canManage, ask]
  );

  return (
    <div>
      <PageHeader
        title="Invoices"
        description={
          /* An Organization Admin reads this list too, confined to their organization by `tenantWhere()`. */
          profile?.tenant.isPlatform === false
            ? 'Every invoice issued to your organization’s schools, newest first.'
            : 'Every invoice issued on the platform, newest first.'
        }
        action={
          /*
           * Hidden without the permission, as on every list — a courtesy, not a control. Here the
           * API is doubly unmoved by the button existing: `POST /invoices/generate` mounts
           * `requirePlatformScope()` *and* `requirePermission('invoices.manage')`, so a school-side
           * caller is refused by the scope guard even if a Super Admin re-granted the key under
           * FR-AUTH-009. "Generate" rather than "New": there is no free-form `POST /invoices`,
           * because FR-BILL-001's precondition is that a subscription exists and is being billed.
           */
          <div className="flex flex-wrap gap-2">
            {/*
              * Taxes and quotations are reached from here, and not from the sidebar. §33 fixes the
              * Super Admin nav at sixteen entries and `verify-frontend.js` asserts the count in both
              * directions, so an eighteenth would be this product editing a list the source defines.
              * Both belong beside invoices anyway: a tax is what an invoice is raised at, and a
              * quotation is what becomes one.
              */}
            {can('quotations.view') ? (
              <Link href="/super-admin/quotations" className="btn btn-secondary">
                Quotations
              </Link>
            ) : null}
            {can('taxes.view') ? (
              <Link href="/super-admin/taxes" className="btn btn-secondary">
                Taxes
              </Link>
            ) : null}
            {can('invoices.manage') ? (
              <Link href="/super-admin/invoices/new" className="btn btn-primary">
                Generate invoice
              </Link>
            ) : null}
          </div>
        }
      />

      <FilterBar
        activeCount={[search, statusFilter, schoolId].filter(Boolean).length}
        onClear={() => {
          setSearch('');
          setStatusFilter('');
          setSchoolId('');
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

        {/* Only offered once the names have loaded — an empty select is a control that looks broken. */}
        {schools.length > 0 ? (
          <FilterSelect
            id="invoice-school"
            label="Filter by school"
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
        ) : null}
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
            : statusFilter || schoolId
              ? 'No invoice matches these filters.'
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

      {dialog}
    </div>
  );
}
