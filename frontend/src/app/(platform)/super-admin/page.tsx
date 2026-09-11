'use client';

/**
 * Super Admin dashboard — SRS §9.1 (FR-SADMIN-001), §33's first Super Admin screen.
 *
 * Renders the eleven metrics `GET /platform/dashboard` returns, in source order, plus the derived
 * figures the service already exposes (archived schools, pending amount) and the per-currency lines
 * behind the three money figures.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/money';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { ErrorNotice, LoadingBlock, MetricCard, PageHeader, RefusalNotice } from '@/components/table';

/** One currency's share of a money figure — a row of `sumPaymentsByCurrency()`, sorted by code. */
interface CurrencyLine {
  currency: string;
  amount: number;
}

interface PlatformDashboardData {
  totalOrganizations: number;
  totalSchools: number;
  activeSchools: number;
  suspendedSchools: number;
  totalStudents: number;
  totalTeachers: number;
  activeSubscriptions: number;
  expiredSubscriptions: number;
  /**
   * The one total when every payment is in one currency, 0 when there are none, and **null** when
   * currencies mix — `singleCurrencyTotal()` in `platform.service.js`. The three scalars are declared
   * so the payload is described truthfully and are never rendered; `PerCurrency` says why.
   */
  monthlyRevenue: number | null;
  yearlyRevenue: number | null;
  pendingPayments: number;
  archivedSchools: number;
  pendingPaymentsAmount: number | null;
  /** The same three figures as one line per currency — what the scalars cannot say when currencies mix. */
  revenueByCurrency: {
    month: CurrencyLine[];
    year: CurrencyLine[];
    pending: CurrencyLine[];
  };
  period?: {
    month: { from: string; to: string };
    year: { from: string; to: string };
  };
}

/**
 * A money figure as one line per currency, each with its code.
 *
 * ## Why the lines and not the scalar
 *
 * These cards used to show `SUM(payments.amount)` over every currency as one bare number, because
 * the service added USD to PKR and the screen could only stop calling the result dollars.
 * `platform.service.js` now sums per currency and refuses to add them: the scalar is the single total
 * only while one currency is in play, and **null** once a second appears, since no one figure exists
 * without an exchange rate the SRS does not supply. The lines say everything the scalar says plus the
 * case it cannot, so they are what is rendered — and a null scalar is never formatted, so it cannot
 * reach the card as "NaN" or the word "null".
 *
 * No lines means no payments in the window; the scalar is 0 then, and it is shown as a bare `0.00`
 * because there is no currency to name. The code is written out rather than a symbol for the reason
 * `lib/money.ts` gives — `$` is several currencies — and set smaller than the figure so a long amount
 * still fits a two-column card.
 */
function PerCurrency({ lines }: { lines: CurrencyLine[] }) {
  if (lines.length === 0) return <>{formatMoney(0)}</>;
  return (
    <ul>
      {lines.map((line) => (
        <li key={line.currency}>
          {formatMoney(line.amount)}{' '}
          <span className="text-sm font-medium text-muted">{line.currency}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Said on both revenue cards: what is counted, and why a card can hold more than one line.
 *
 * "Less refunds" because revenue is `amount − refunded_amount` over approved, partially refunded and
 * refunded payments — the service header's reading. It used to count `approved` alone, so a payment
 * with any refund against it contributed nothing.
 */
const RECEIVED = 'Payments received, less refunds. One line per currency — never converted or added together.';

function count(value: number): string {
  return new Intl.NumberFormat().format(value);
}

/**
 * The revenue window, as days a person can check a figure against.
 *
 * The API sends `period.month` / `period.year` as `Date`s, which `res.json()` serialises to ISO
 * instants — so the hint used to read `2026-09-01T00:00:00.000Z → 2026-09-30T23:59:59.999Z`, on the two
 * cards the hint was added to make checkable. Formatted in **UTC** on purpose: `periodRange()` builds
 * both bounds with `Date.UTC(...)`, so the month is a UTC month, and rendering it in the viewer's zone
 * would move the start back a day for anyone west of Greenwich. The same formatter payments uses.
 */
const DAY = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

function span(from: string, to: string): string {
  const start = new Date(from);
  const end = new Date(to);
  /* Shown as sent rather than as "Invalid Date" if either bound is not an instant at all. */
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return `${from} – ${to}`;
  return `${DAY.format(start)} – ${DAY.format(end)}`;
}

export default function PlatformDashboard() {
  const { profile } = useAuth();
  const [data, setData] = useState<PlatformDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);

    (async () => {
      try {
        /*
         * `{ metrics }`, not the metrics themselves: `platform.controller.js:13` answers
         * `ApiResponse.ok(res, { metrics })`, so the envelope nests them one level down. Reading
         * `result` directly gave every field as `undefined`, which `count()` rendered as **NaN**
         * and the old money formatter as the literal string "undefined" — all thirteen cards, at
         * text-3xl, on the first screen a Super Admin sees. The same shallow-envelope mistake this client
         * already records for `meta.pagination`, and visible here rather than silent.
         */
        const result = await api.get<{ metrics: PlatformDashboardData }>('/platform/dashboard', {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setData(result.metrics ?? null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
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
  }, [nonce]);

  return (
    <div>
      {/*
        * Worded by scope. `GET /platform/dashboard` has no platform-scope guard: the Organization Admin
        * holds `platform.dashboard.view` too, and `platform.service.getDashboard()` counts the same
        * eleven figures over their own organization. "Across every organization" is the Super Admin's.
        */}
      <PageHeader
        title={profile?.tenant.isPlatform === false ? 'Organization overview' : 'Platform overview'}
        description={`Signed in as ${profile?.user.name ?? 'administrator'}. ${
          profile?.tenant.isPlatform === false
            ? 'Live figures from your organization’s schools.'
            : 'Live figures from across every organization.'
        }`}
        action={
          /* The platform notifications of the owner's decision D15 — payments and expiring subscriptions. */
          <Link href="/super-admin/notifications" className="btn btn-secondary">
            Notifications
          </Link>
        }
      />

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={() => setNonce((n) => n + 1)} />
      ) : loading || !data ? (
        <LoadingBlock label="Loading platform metrics…" />
      ) : (
        <>
          <section aria-label="Schools and people">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
              Schools and people
            </h2>
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
              <MetricCard label="Organizations" value={count(data.totalOrganizations)} />
              <MetricCard label="Schools" value={count(data.totalSchools)} />
              <MetricCard label="Active schools" value={count(data.activeSchools)} />
              <MetricCard label="Suspended schools" value={count(data.suspendedSchools)} />
              <MetricCard label="Students" value={count(data.totalStudents)} />
              <MetricCard label="Teachers" value={count(data.totalTeachers)} />
              {/*
                * Not one of §9.1's eleven metrics — `platform.service.js` adds it so the schools figures
                * reconcile, and says so in its own comment. The citation stays here; the card says the
                * thing a reader needs.
                */}
              <MetricCard
                label="Archived schools"
                value={count(data.archivedSchools)}
                hint="Schools = active + suspended + archived."
              />
            </dl>
          </section>

          <section className="mt-8" aria-label="Subscriptions and revenue">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
              Subscriptions and revenue
            </h2>
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
              <MetricCard label="Active subscriptions" value={count(data.activeSubscriptions)} />
              <MetricCard label="Expired subscriptions" value={count(data.expiredSubscriptions)} />
              <MetricCard
                label="Monthly revenue"
                value={<PerCurrency lines={data.revenueByCurrency.month} />}
                hint={
                  data.period
                    ? `${span(data.period.month.from, data.period.month.to)} (UTC). ${RECEIVED}`
                    : RECEIVED
                }
              />
              <MetricCard
                label="Yearly revenue"
                value={<PerCurrency lines={data.revenueByCurrency.year} />}
                hint={
                  data.period
                    ? `${span(data.period.year.from, data.period.year.to)} (UTC). ${RECEIVED}`
                    : RECEIVED
                }
              />
              <MetricCard label="Pending payments" value={count(data.pendingPayments)} />
              <MetricCard
                label="Pending amount"
                value={<PerCurrency lines={data.revenueByCurrency.pending} />}
                hint="The payments awaiting review, totalled per currency."
              />
            </dl>
          </section>
        </>
      )}
    </div>
  );
}
