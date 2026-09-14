'use client';

/**
 * Super Admin dashboard — SRS §9.1 (FR-SADMIN-001), §33's first Super Admin screen.
 *
 * Renders the eleven metrics `GET /platform/dashboard` returns, plus the derived figures the service
 * already exposes (archived schools, pending amount) and the per-currency lines behind the three
 * money figures. Every one of the eleven is on the screen; what changed is the arrangement.
 *
 * ## Why they are not in source order any more
 *
 * They were, and it read as a readout rather than as an overview: thirteen cards of identical weight,
 * four of them about the same fact — `Schools 1`, `Active 1`, `Suspended 0`, `Archived 0` — and one
 * carrying the sentence "Schools = active + suspended + archived" to explain why. Money, the figure a
 * platform owner opens this page for, sat below the fold behind counts of zero.
 *
 * So: **two bands.** Money first, at a larger size, because it is what the screen is for and because
 * three figures deserve more room than a count. Then the tenancy and people counts as one compact row,
 * each card holding its own parts — a school's states, a subscription's two — so a number and its
 * decomposition are one object rather than four cards that must be added up. That retires the
 * explanatory sentence: an arithmetic note is needed only when the arithmetic is spread across cards.
 *
 * **Each count links to the list it summarises.** A dashboard figure is a question — *which* school is
 * suspended, *which* payment is pending — and every answer is a screen this product already has.
 * Students and Teachers have no platform-level list to link to, so those two stay inert rather than
 * pointing somewhere that half-answers.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { Icon } from '@/components/icon';
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
  /*
   * Shown, and shown quietly. No lines means no payments in the window, and the figure is genuinely
   * 0.00 — so it is not replaced with a dash, which would say "not known" about something known, and
   * not hidden, because §9.1 asks for eleven metrics on the screen rather than eleven when convenient.
   * Muted only: on a fresh install all three money cards are zero, and at this size three bold zeros
   * read as the headline of the page.
   */
  if (lines.length === 0) return <span className="text-muted">{formatMoney(0)}</span>;
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

/** "1 school" / "2 schools" — a count beside its noun, so a breakdown line reads as a sentence. */
function plural(value: number, one: string, many: string): string {
  return `${count(value)} ${value === 1 ? one : many}`;
}

/**
 * A band of the dashboard: a quiet heading with a rule running out to the edge.
 *
 * The rule is the whole device — it separates the bands without a box around each, which is what made
 * the old screen read as a grid of grids. `aria-label` rather than `aria-labelledby` because the
 * heading is decorative shorthand for the section, and the cards inside carry their own names.
 */
function Band({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8 first:mt-6" aria-label={title}>
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">{title}</h2>
        <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-soft)]" />
      </div>
      {children}
    </section>
  );
}

/**
 * A money figure, larger than a count and with its window underneath.
 *
 * Not `MetricCard` with a bigger class: a money card holds a **list** — one line per currency, which is
 * the only honest shape once a second currency appears — and the window it covers, which a reader has
 * to have to check the figure against anything. `MetricCard`'s single-value layout would have to grow
 * two more props to say those two things, on fifty-nine screens that do not need them.
 */
function MoneyCard({
  label,
  lines,
  footer,
  href,
}: {
  label: string;
  lines: CurrencyLine[];
  footer: string;
  href?: string;
}) {
  return (
    <div className={`card p-5${href ? ' card-interactive relative' : ''}`}>
      <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
        {href ? (
          <Link
            href={href}
            className="rounded-sm after:absolute after:inset-0 after:content-[''] hover:text-ink"
          >
            {label}
          </Link>
        ) : (
          label
        )}
      </dt>
      <dd className="mt-2 font-display text-3xl font-semibold tabular-nums tracking-tight text-ink">
        <PerCurrency lines={lines} />
      </dd>
      <p className="mt-2 text-xs leading-relaxed text-muted">{footer}</p>
    </div>
  );
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
  const { profile, can } = useAuth();
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
          {/*
            * Every figure on this screen counts schools or what happens inside them, so with no school
            * in scope all thirteen are zero — correctly, and unhelpfully. A new organization's admin
            * landed here on a wall of zeros with nothing saying why or what comes next.
            *
            * The figures stay on screen: §9.1 asks for eleven metrics, and a zero is one of them. What
            * is added is the reason, worded by what this caller may actually do — a platform
            * administrator holds `schools.manage` and can add the school; an organization admin holds
            * none of the write keys (`DEFAULT_ROLE_PERMISSIONS.organization_admin` is read-only), so
            * offering them an Add button would be offering a refusal.
            */}
          {data.totalSchools === 0 ? (
            <div className="surface mb-6 flex flex-wrap items-start gap-4 p-5">
              <Icon name="school" size={20} className="mt-0.5 shrink-0 text-muted-soft" />
              <div className="min-w-0 flex-1">
                <p className="font-display text-lg font-semibold text-ink">
                  {profile?.tenant.isPlatform === false
                    ? 'This organization has no schools yet'
                    : 'No schools yet'}
                </p>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
                  {profile?.tenant.isPlatform === false
                    ? 'Every figure below counts schools in this organization, so each reads zero until one is added. Schools are created by a platform administrator.'
                    : 'Every figure below counts schools and what happens inside them, so each reads zero until the first school is added and put on a plan.'}
                </p>
              </div>
              {can('schools.manage') ? (
                <Link href="/super-admin/schools/new" className="btn btn-primary shrink-0">
                  Add a school
                </Link>
              ) : can('schools.view') ? (
                <Link href="/super-admin/schools" className="btn btn-secondary shrink-0">
                  View schools
                </Link>
              ) : null}
            </div>
          ) : null}

          <Band title="Revenue">
            <dl className="grid gap-4 md:grid-cols-3">
              <MoneyCard
                label="Revenue this month"
                lines={data.revenueByCurrency.month}
                href="/super-admin/payments"
                footer={
                  data.period
                    ? `${span(data.period.month.from, data.period.month.to)} (UTC). ${RECEIVED}`
                    : RECEIVED
                }
              />
              <MoneyCard
                label="Revenue this year"
                lines={data.revenueByCurrency.year}
                href="/super-admin/payments"
                footer={
                  data.period
                    ? `${span(data.period.year.from, data.period.year.to)} (UTC). ${RECEIVED}`
                    : RECEIVED
                }
              />
              {/*
                * §9.1's "pending payments" is the count; the amount is the service's own derived figure.
                * The amount is the value because it is the one a person acts on, and the count is under
                * it — two metrics, one object, rather than two cards that have to be read together.
                */}
              <MoneyCard
                label="Pending payments"
                lines={data.revenueByCurrency.pending}
                href="/super-admin/payments"
                footer={`${plural(data.pendingPayments, 'payment', 'payments')} awaiting review, totalled per currency.`}
              />
            </dl>
          </Band>

          <Band title="Tenants and people">
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              <MetricCard
                label="Organizations"
                value={count(data.totalOrganizations)}
                icon="building"
                href="/super-admin/organizations"
              />
              {/*
                * `archivedSchools` is not one of §9.1's eleven — `platform.service.js` adds it so the
                * schools figures reconcile. As a breakdown of the total it needs no explaining: the
                * three states are visibly the parts of the number above them.
                */}
              <MetricCard
                label="Schools"
                value={count(data.totalSchools)}
                icon="school"
                href="/super-admin/schools"
                breakdown={
                  <>
                    {count(data.activeSchools)} active · {count(data.suspendedSchools)} suspended ·{' '}
                    {count(data.archivedSchools)} archived
                  </>
                }
              />
              <MetricCard
                label="Active subscriptions"
                value={count(data.activeSubscriptions)}
                icon="refresh"
                href="/super-admin/subscriptions"
                breakdown={`${count(data.expiredSubscriptions)} expired`}
              />
              {/* No platform-level list of either, so neither card pretends to lead anywhere. */}
              <MetricCard label="Students" value={count(data.totalStudents)} icon="graduation" />
              <MetricCard label="Teachers" value={count(data.totalTeachers)} icon="users" />
            </dl>
          </Band>
        </>
      )}
    </div>
  );
}
