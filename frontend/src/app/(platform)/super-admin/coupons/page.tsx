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
 *     `expireLapsed()` has swept, and `coupons.routes.js` says plainly that the sweep has no scheduler
 *     yet. So "active" and "usable right now" are genuinely different sets today.
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
 * ## Money is a string, and a percentage has no currency
 *
 * `discount_value`, `max_discount_amount` and `min_order_amount` are `DECIMAL(14,2)` and arrive as JS
 * **numbers** — `config/database.js` sets `decimalNumbers: true`. Both formatters below take either,
 * because they already run `Number()` first; the types were declared `string` and that was wrong,
 * harmlessly here and not harmlessly elsewhere. (`models/columns.js`
 * `money()`), which the driver hands over as a **string** — `"15.00"`, not `15`. Interpolating one
 * straight into a cell prints "15.00%" where the operator typed 15, so every amount goes through the
 * helpers below.
 *
 * A percentage coupon has **no currency at all**: `coupons.validation.js` forbids the column on one,
 * on the grounds that a percentage discount is currency-agnostic and its `max_discount_amount` cap is
 * compared against whatever the invoice is denominated in. Printing "$50" beside a percentage cap
 * would therefore assert a currency the coupon does not have — the cap is shown as a bare figure.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/lib/auth';
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

/**
 * A money figure, formatted in the currency it is denominated in.
 *
 * `currency` is `STRING(10)` in the database while `Intl.NumberFormat` accepts only a valid ISO 4217
 * code — it throws `RangeError` on anything else. The request schema constrains new rows to three
 * characters, but a single legacy row with a malformed code would throw inside a cell and take the
 * whole table down with it, so the failure is caught and degraded to the code plus the number.
 */
function formatMoney(value: number | string | null, currency: string | null): string | null {
  if (value === null) return null;

  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;

  if (!currency) return amount.toFixed(2);

  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** A percentage, with the trailing zeros the DECIMAL column carries trimmed off. */
function formatPercent(value: number | string): string {
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
            const cap = formatMoney(row.max_discount_amount, null);
            return (
              <span>
                {formatPercent(row.discount_value)}
                {cap ? <span className="text-muted-soft"> · capped at {cap}</span> : null}
              </span>
            );
          }

          return <span>{formatMoney(row.discount_value, row.currency) ?? row.discount_value}</span>;
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
