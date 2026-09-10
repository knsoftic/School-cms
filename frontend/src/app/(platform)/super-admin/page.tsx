'use client';

/**
 * Super Admin dashboard — SRS §9.1 (FR-SADMIN-001), §33's first Super Admin screen.
 *
 * Renders the eleven metrics `GET /platform/dashboard` returns, in source order, plus the two
 * derived figures the service already exposes (archived schools, pending amount).
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { ErrorNotice, LoadingBlock, MetricCard, PageHeader, RefusalNotice } from '@/components/table';

interface PlatformDashboardData {
  totalOrganizations: number;
  totalSchools: number;
  activeSchools: number;
  suspendedSchools: number;
  totalStudents: number;
  totalTeachers: number;
  activeSubscriptions: number;
  expiredSubscriptions: number;
  monthlyRevenue: number | string;
  yearlyRevenue: number | string;
  pendingPayments: number;
  archivedSchools: number;
  pendingPaymentsAmount: number | string;
  period?: {
    month: { from: string; to: string };
    year: { from: string; to: string };
  };
}

/**
 * A cross-currency total: grouped, two decimals, and **no currency symbol**.
 *
 * ## Why no symbol
 *
 * These figures are `SUM(payments.amount)` with **no currency clause** — `sumPayments()` in
 * `platform.service.js` passes only a tenant scope and a date range. A platform billing one school
 * in USD and another in EUR therefore adds the two together, and this card used to stamp the result
 * with a hardcoded `currency: 'USD'`. That is not a rounding difference; it is a number presented as
 * dollars that is not a number of dollars.
 *
 * The frontend cannot fix the sum — that would mean changing what the endpoint returns — but it can
 * stop asserting something the data does not support. The figure is shown as a plain grouped number
 * and the cards say what it is, which is honest at the cost of being less tidy.
 *
 * ## Why two decimals
 *
 * `maximumFractionDigits: 0` silently discarded the cents the server had just been careful to round
 * to the currency scale — `sumPayments()` ends in `money.round(money.toNumber(total))`. Measured:
 * two pending payments of 499.00 and 1,250.50 rendered as **`$1,750`**.
 */
function money(value: number | string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/** Said on every cross-currency card, so the bare number is never read as one currency. */
const MIXED_CURRENCY = 'Summed across every currency on the platform — not converted.';

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
         * and `money()` as the literal string "undefined" — all thirteen cards, at text-3xl, on
         * the first screen a Super Admin sees. The same shallow-envelope mistake this client
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
      <PageHeader
        title="Platform overview"
        description={`Signed in as ${profile?.user.name ?? 'administrator'}. Live figures from across every organization.`}
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
                value={money(data.monthlyRevenue)}
                hint={
                  data.period
                    ? `${span(data.period.month.from, data.period.month.to)} (UTC). ${MIXED_CURRENCY}`
                    : MIXED_CURRENCY
                }
              />
              <MetricCard
                label="Yearly revenue"
                value={money(data.yearlyRevenue)}
                hint={
                  data.period
                    ? `${span(data.period.year.from, data.period.year.to)} (UTC). ${MIXED_CURRENCY}`
                    : MIXED_CURRENCY
                }
              />
              <MetricCard label="Pending payments" value={count(data.pendingPayments)} />
              <MetricCard
                label="Pending amount"
                value={money(data.pendingPaymentsAmount)}
                hint={MIXED_CURRENCY}
              />
            </dl>
          </section>
        </>
      )}
    </div>
  );
}
