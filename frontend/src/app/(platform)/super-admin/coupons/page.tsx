'use client';

/**
 * Coupons — SRS §14, §33's "Coupons", checklist row 4.3.
 *
 * The same four moving parts as `super-admin/schools/page.tsx`: a `useCollection` call, a `Column[]`,
 * the four-state render, and pagination. What is specific to coupons is below.
 *
 * ## The three filters, and the one that overrides another
 *
 * `GET /coupons` accepts `status`, `discount_type` and `valid_now` (`coupons.validation.js` `list`).
 * Only two of them are worth a control:
 *
 *   - **`status`** — the question every coupon list is asked first.
 *   - **`valid_now`** — the question it is asked second, and the one `status` cannot answer. An
 *     `active` coupon whose `starts_at` is still in the future does not work yet, and one whose
 *     `expires_at` has passed does not work any more — `status` only catches the second case *after*
 *     `expireLapsed()` has swept (`jobs/tasks/couponExpiry.js`, on the cron), and never catches the
 *     first. So "active" and "usable right now" are genuinely different sets.
 *
 * `discount_type` gets no control: it has two values, and the Discount column already spells the type
 * out on every row, so filtering by it hides rows to reveal something already visible.
 *
 * **`valid_now` overrides `status` on the server.** `coupons.service.list()` assigns
 * `where.status = ACTIVE` inside the `valid_now` branch, after the `status` filter has been applied —
 * so "expired" plus "usable now" returns active rows and the status control would be lying about what
 * the table shows. The control is therefore disabled while `valid_now` is on, and the parameter is not
 * sent, rather than left enabled and quietly ignored.
 *
 * ## Money arrives as a number, and a percentage has no currency
 *
 * `discount_value` and `max_discount_amount` are `money()` — `DECIMAL(14,2)` — and arrive as JS
 * **numbers**: `config/database.js` sets `decimalNumbers: true`, and `lib/money.ts` records the
 * measurement. They are typed `number` here for that reason. An amount goes through `lib/money`, which
 * always prints two decimal places and the currency as a code rather than a glyph — this list spans
 * every school, so two rows can share a symbol and differ in currency. A percentage is formatted by
 * `formatPercent` below instead, with trailing zeros trimmed, because 15 percent is what the operator
 * typed and "15.00%" reads like a rate someone measured.
 *
 * A percentage coupon has **no currency at all**: `coupons.validation.js` forbids the column on one,
 * on the grounds that a percentage discount is currency-agnostic and its `max_discount_amount` cap is
 * compared against whatever the invoice is denominated in. Printing "$50" beside a percentage cap
 * would therefore assert a currency the coupon does not have — the cap is shown as a bare figure.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { formatCodeWithAmount, formatMoney } from '@/lib/money';
import { useCollection } from '@/lib/useCollection';
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
 * A coupon row, as `coupons.controller.present()` builds it: the model's own columns spread from
 * `toJSON()`, plus the one derived field.
 *
 * Only the fields this screen renders are declared. A field listed here that the response does not
 * carry is a promise TypeScript cannot keep.
 */
interface Coupon {
  id: number;
  code: string;
  name: string | null;
  /** `config/constants.js` COUPON_TYPES. */
  discount_type: 'percentage' | 'fixed_amount';
  /** DECIMAL over the wire — see the header. Percent when percentage, money when fixed_amount. */
  discount_value: number;
  currency: string | null;
  max_discount_amount: number | null;
  starts_at: string | null;
  expires_at: string | null;
  used_count: number;
  /**
   * `max_uses − used_count`, floored at zero, or `null` for unlimited.
   *
   * Derived by the controller rather than recomputed here for the reason its own comment gives: a
   * second place holding the number can disagree with the first.
   */
  remaining_uses: number | null;
  status: string;
}

/** `config/constants.js` COUPON_TYPES — compared against, not displayed. */
const PERCENTAGE = 'percentage';

/** `config/constants.js` COUPON_STATUS, in the order an operator scans them. */
const STATUSES = ['active', 'inactive', 'expired'];

/*
 * There used to be a file-local `formatMoney` here, built on the premise that the amount arrived as a
 * string and formatting it with `Intl`'s currency style — a glyph, where every other platform list
 * shows the code. `lib/money` is the one place money is formatted; see its header for why.
 */

/** A percentage, with the trailing zeros trimmed — 15 rather than 15.00. */
function formatPercent(value: number): string {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return `${value}%`;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(percent)}%`;
}

/** A date, or `null` if the column held something unparseable. */
function formatDate(value: string | null): string | null {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function CouponsPage() {
  const { can } = useAuth();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [validNow, setValidNow] = useState(false);

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
      q: debounced || undefined,
      /* Not sent while `valid_now` is on — the server would discard it. See the header. */
      status: validNow ? undefined : status || undefined,
      /*
       * A string, not a boolean: `Query` carries `string | number | undefined`, and Joi's `boolean()`
       * coerces the query-string form anyway — a query string has never had a boolean in it.
       */
      valid_now: validNow ? 'true' : undefined,
    }),
    [page, debounced, status, validNow]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<Coupon>('/coupons', query);

  const columns = useMemo<Column<Coupon>[]>(
    () => [
      {
        key: 'code',
        header: 'Code',
        /* The way into the coupon's own screen, where it can be corrected or removed. */
        cell: (row) => (
          <Link
            href={`/super-admin/coupons/${row.id}`}
            className="underline-offset-2 hover:underline focus-visible:underline"
          >
            <code className="text-xs font-medium">{row.code}</code>
          </Link>
        ),
      },
      {
        key: 'name',
        header: 'Name',
        cell: (row) => row.name ?? <span className="text-muted-soft">—</span>,
      },
      {
        /*
         * Type, value and cap read as one fact. `discount_value` alone is the number 15 with no way to
         * tell fifteen percent from fifteen dollars — the column comment in `models/billing.js` says
         * as much — so splitting them across two columns would put a figure on screen that cannot be
         * read without the one beside it.
         */
        key: 'discount',
        header: 'Discount',
        cell: (row) => {
          if (row.discount_type === PERCENTAGE) {
            /* A bare figure: the cap has no currency of its own. See the header. */
            const cap = row.max_discount_amount === null ? null : formatMoney(row.max_discount_amount);
            return (
              <span>
                {formatPercent(row.discount_value)}
                {cap ? <span className="text-muted-soft"> · capped at {cap}</span> : null}
              </span>
            );
          }

          return <span>{formatCodeWithAmount(row.currency, row.discount_value)}</span>;
        },
      },
      {
        /*
         * SRS §14's *Expiry*. `starts_at` gets no column of its own — it is null on most coupons and
         * says nothing when it is in the past. It matters in exactly one case, which is the case that
         * confuses: a coupon reading `active` that does not work yet. So it is shown only then.
         */
        key: 'expires',
        header: 'Expires',
        cell: (row) => {
          const expires = formatDate(row.expires_at);
          const startsAt = row.starts_at ? new Date(row.starts_at) : null;
          const pending = startsAt !== null && !Number.isNaN(startsAt.getTime()) && startsAt > new Date();

          return (
            <span className="whitespace-nowrap">
              {expires ?? <span className="text-muted-soft">never</span>}
              {pending ? (
                <span className="block text-xs text-muted-soft">starts {formatDate(row.starts_at)}</span>
              ) : null}
            </span>
          );
        },
      },
      {
        /* SRS §14's *Maximum Uses*, as the two numbers an operator acts on. */
        key: 'used',
        header: 'Used',
        numeric: true,
        cell: (row) => row.used_count,
      },
      {
        key: 'remaining',
        header: 'Remaining',
        numeric: true,
        cell: (row) =>
          row.remaining_uses === null ? (
            <span className="text-muted-soft">unlimited</span>
          ) : (
            row.remaining_uses
          ),
      },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
    ],
    []
  );

  return (
    <div>
      <PageHeader
        title="Coupons"
        description="Discount codes redeemable against subscription invoices."
        action={
          /*
           * Hidden without the permission — a courtesy, not a control. `coupons.manage` is re-read from
           * the database on the request itself, and `coupons.routes.js` puts `requirePlatformScope()`
           * in front of it as well, so a user who forced this button into existence would be refused
           * twice over.
           */
          can('coupons.manage') ? (
            <Link
              href="/super-admin/coupons/new"
              className="btn btn-primary"
            >
              Add coupon
            </Link>
          ) : null
        }
      />

      <FilterBar
        activeCount={[search, status].filter(Boolean).length}
        onClear={() => {
          setSearch('');
          setStatus('');
          setPage(1);
        }}
      >
        <SearchField
          id="coupon-search"
          label="Search coupons"
          placeholder="Search by code or name…"
          value={search}
          onChange={setSearch}
        />

        <FilterSelect
          id="coupon-status"
          label="Filter by status"
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          /* See the header: the server ignores `status` under `valid_now`, so the control says so. */
          disabled={validNow}
        >
          <option value="">Any status</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </FilterSelect>

        <label
          htmlFor="coupon-valid-now"
          className="flex h-10 cursor-pointer items-center gap-2 text-sm text-ink"
        >
          <input
            id="coupon-valid-now"
            type="checkbox"
            className="field-check"
            checked={validNow}
            onChange={(event) => {
              setValidNow(event.target.checked);
              setPage(1);
            }}
          />
          Usable right now
        </label>
      </FilterBar>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {/*
            * The message names the filter that emptied the table. "No coupons yet" under an active
            * "usable right now" tick would send an operator looking for coupons that are already there.
            */}
          {debounced
            ? `No coupon matches “${debounced}”.`
            : validNow
              ? 'No coupon is usable right now.'
              : status
                ? `No coupon is ${status}.`
                : 'No coupons have been created yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Coupons"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
