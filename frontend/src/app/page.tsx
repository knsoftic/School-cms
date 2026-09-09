'use client';

/**
 * The public landing page at `/`.
 *
 * ## Why this route did not exist
 *
 * Every screen in this application lives behind `AppShell`, which redirects an unauthenticated caller
 * to `/login`. Nothing was ever mounted at `/`, so the root URL — the address someone actually types,
 * and the one a link in an email lands on — rendered Next's built-in 404. A product that cannot be
 * reached at its own root is not shippable, which is why this exists.
 *
 * ## What it is allowed to claim
 *
 * Everything on this page is a capability that exists in the codebase. The module grid is
 * `config/constants.js MODULE_LABELS`, all twenty of them, verbatim — not a marketing selection. The
 * five audiences are the five nav surfaces that are actually built (`lib/nav.ts`). There are no
 * prices, no customer counts, no testimonials and no claims about the company, because the SRS is the
 * source of truth for this project and it describes none of those. Inventing them here would be the
 * same mistake as inventing a database column.
 *
 * ## There is no "Sign up" button, on purpose
 *
 * SRS §9.3 has the Super Admin create principals; there is no self-registration endpoint and adding
 * one would be inventing a requirement. Rather than leave a visitor wondering where the button is,
 * the page says plainly that administrators create accounts. An absence that is explained is a
 * design decision; an absence that is not is a bug report.
 *
 * ## Public, and it must stay public
 *
 * This page does not render `AppShell` and must never be given it — that is the component holding the
 * redirect. It reads `useAuth()` only to swap the call to action for someone who already has a
 * session, and it tolerates `profile === null` as the ordinary case rather than an error.
 */

import Link from 'next/link';

import { MODULE_LABELS } from '@/lib/modules';
import { useAuth } from '@/lib/auth';
import { landingRouteFor } from '@/lib/nav';
import { Icon, type IconName } from '@/components/icon';
import { ThemeToggle } from '@/components/theme';

/**
 * The five surfaces this application actually builds, from `lib/nav.ts`.
 *
 * `PLATFORM_NAV`, `SCHOOL_NAV`, `TEACHER_NAV`, `PARENT_NAV`, `STUDENT_NAV` — one entry each. No sixth
 * audience is described here because there is no sixth surface to send them to.
 */
const AUDIENCES: Array<{ icon: IconName; title: string; body: string }> = [
  {
    icon: 'layers',
    title: 'Group operators',
    body: 'One platform console across every organisation and school: plans, subscriptions, invoices, payments and coupons in a single ledger.',
  },
  {
    icon: 'school',
    title: 'School principals',
    body: 'Admissions, staff, classes and sections, timetables, exams and fees for one school — scoped so no school can read another.',
  },
  {
    icon: 'users',
    title: 'Teachers',
    body: 'Attendance, marks, homework and the timetable, on the classes actually assigned to them.',
  },
  {
    icon: 'user',
    title: 'Parents',
    body: 'Each child’s attendance, results and fees, without an account per school.',
  },
  {
    icon: 'graduation',
    title: 'Students',
    body: 'Their own timetable, homework and results.',
  },
];

/** Capabilities of the platform layer itself, each of which is implemented. */
const PILLARS: Array<{ icon: IconName; title: string; body: string }> = [
  {
    icon: 'building',
    title: 'Organisations, then schools',
    body: 'A two-level tenancy. Every query is confined to the caller’s scope by the server, not by the screen asking politely.',
  },
  {
    icon: 'lock',
    title: 'Plans decide access',
    body: 'What a school can open is its subscription’s entitlement snapshot — modules, feature flags and usage limits. Never a plan name hard-coded in a branch.',
  },
  {
    icon: 'credit-card',
    title: 'Billing that reconciles',
    body: 'Subscriptions, proration, add-ons, coupons, quotations, invoices, payments and refunds — with a review step before money is recognised.',
  },
  {
    icon: 'bar-chart',
    title: 'Reports built on the ledger',
    body: 'Financial, fee-collection, expense, attendance and academic reports read the same rows the operational screens write.',
  },
  {
    icon: 'clipboard',
    title: 'An audit trail',
    body: 'Writes record who changed what, before and after, with the reason given.',
  },
  {
    icon: 'settings',
    title: 'Configured, not customised',
    body: 'Roles, permissions, grading scales, fee structures and school settings are data. Adding a school does not mean shipping code.',
  },
];

export default function LandingPage() {
  const { profile, loading } = useAuth();

  /* One helper, shared with `login`, `change-password` and the shell — this used to be a copy of
     `isPlatform ? '/super-admin' : '/school'`, and four copies of a routing rule is how a parent
     ends up on the school administration dashboard. See `landingRouteFor`. */
  const dashboard = profile ? landingRouteFor(profile) : '/login';

  return (
    <div className="min-h-screen bg-paper">
      {/* ─────────────────────────────── top bar ─────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-border-soft bg-paper/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
          <p className="flex items-baseline gap-2">
            <span className="font-display text-lg font-semibold tracking-tight text-ink">MSMS</span>
            <span className="hidden text-xs text-muted sm:inline">Multi-School Management</span>
          </p>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            {/*
             * "Sign in" is the default and it renders immediately — it is NOT gated on `loading`.
             *
             * The first version of this rendered a skeleton until `/auth/me` resolved, reasoning that
             * flashing "Sign in" at someone already signed in would read as a flicker. Measured with
             * the API down, that reasoning was backwards: the page sat there with **no call to action
             * at all**, which is far worse than a label that settles. This is a public page, so the
             * signed-out case is the common one, and `/login` is a plain link that works whether or
             * not the API is reachable. `loading` is used only to hold off the *swap*.
             */}
            {!loading && profile ? (
              <Link href={dashboard} className="btn btn-primary btn-sm">
                Go to dashboard
                <Icon name="chevron-right" size={14} />
              </Link>
            ) : (
              <Link href="/login" className="btn btn-primary btn-sm">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main id="main">
        {/* ─────────────────────────────── hero ─────────────────────────────── */}
        <section className="relative overflow-hidden border-b border-border-soft">
          {/*
            * A single soft brand wash rather than a photograph or an illustration. Nothing on this
            * page ships an image: every byte would be a decorative asset in a repository that has no
            * asset pipeline, and `aria-hidden` decoration cannot fail to load.
            */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 -top-40 h-[28rem] bg-[radial-gradient(60%_60%_at_50%_50%,var(--brand-subtle),transparent_70%)] opacity-70"
          />

          <div className="relative mx-auto max-w-4xl px-5 py-20 text-center sm:px-8 sm:py-28">
            <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-brand-subtle-border bg-brand-subtle px-3 py-1 text-xs font-medium text-brand-text">
              <Icon name="building" size={13} />
              Built for groups running more than one school
            </p>

            <h1 className="font-display text-3xl font-semibold leading-[1.1] tracking-tight text-ink sm:text-5xl">
              Run every school in your group
              <span className="block text-brand-text">from one system.</span>
            </h1>

            <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
              Admissions, attendance, fees, exams, library and finance for each school — and the
              subscriptions, invoices and payments for all of them — in one place. What each school can
              open is decided by its own plan.
            </p>

            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              {!loading && profile ? (
                <Link href={dashboard} className="btn btn-primary btn-lg w-full sm:w-auto">
                  Go to dashboard
                  <Icon name="chevron-right" size={16} />
                </Link>
              ) : (
                <Link href="/login" className="btn btn-primary btn-lg w-full sm:w-auto">
                  Sign in
                  <Icon name="chevron-right" size={16} />
                </Link>
              )}
              <a href="#modules" className="btn btn-secondary btn-lg w-full sm:w-auto">
                See what is included
              </a>
            </div>

            {/* The explained absence. See the header comment. */}
            {profile ? null : (
              <p className="mt-5 text-sm text-muted-soft">
                Accounts are created by your administrator — there is no public sign-up.
              </p>
            )}
          </div>
        </section>

        {/* ─────────────────────────────── audiences ─────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
          <div className="max-w-2xl">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              Five people open this system, and each sees a different one.
            </h2>
            <p className="mt-3 text-base leading-relaxed text-muted">
              Not one screen with things greyed out. Each role has its own navigation, its own
              dashboard, and a server that will not answer for anything outside its scope.
            </p>
          </div>

          <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AUDIENCES.map((item) => (
              <li key={item.title} className="card p-5">
                <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-brand-subtle text-brand-text">
                  <Icon name={item.icon} size={17} />
                </span>
                <h3 className="text-sm font-semibold text-ink">{item.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{item.body}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* ─────────────────────────────── pillars ─────────────────────────────── */}
        <section className="border-y border-border-soft bg-surface-2">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
            <div className="max-w-2xl">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
                The parts that are hard to retrofit.
              </h2>
              <p className="mt-3 text-base leading-relaxed text-muted">
                Tenancy, entitlements, billing and audit are decided at the boundary, so a new school
                is a row rather than a release.
              </p>
            </div>

            <ul className="mt-10 grid gap-x-8 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
              {PILLARS.map((item) => (
                <li key={item.title}>
                  <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-paper text-brand-text">
                    <Icon name={item.icon} size={17} />
                  </span>
                  <h3 className="text-sm font-semibold text-ink">{item.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ─────────────────────────────── modules ─────────────────────────────── */}
        <section id="modules" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-16 sm:px-8 sm:py-24">
          <div className="max-w-2xl">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              Twenty modules. A plan turns on the ones a school pays for.
            </h2>
            <p className="mt-3 text-base leading-relaxed text-muted">
              This is the whole list, not a selection — the same keys the entitlement snapshot carries.
              A school that is not entitled to a module does not see it in its navigation, and its
              endpoints refuse.
            </p>
          </div>

          <ul className="mt-10 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            {MODULE_LABELS.map((label) => (
              <li key={label} className="flex items-center gap-2.5 text-sm text-ink-soft">
                <Icon name="check" size={14} className="shrink-0 text-brand-text" />
                {label}
              </li>
            ))}
          </ul>
        </section>

        {/* ─────────────────────────────── close ─────────────────────────────── */}
        <section className="border-t border-border-soft bg-surface-2">
          <div className="mx-auto max-w-3xl px-5 py-16 text-center sm:px-8 sm:py-20">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
              Already have an account?
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-base leading-relaxed text-muted">
              Sign in with the address your administrator registered. If you have forgotten your
              password you can reset it yourself.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href="/login" className="btn btn-primary btn-lg w-full sm:w-auto">
                Sign in
              </Link>
              <Link href="/forgot-password" className="btn btn-ghost btn-lg w-full sm:w-auto">
                Reset your password
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border-soft">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-5 py-8 text-xs text-muted-soft sm:flex-row sm:px-8">
          <p>MSMS — Multi-School Management System</p>
          <nav aria-label="Footer" className="flex items-center gap-5">
            <Link href="/login" className="transition-colors hover:text-ink">
              Sign in
            </Link>
            <Link href="/forgot-password" className="transition-colors hover:text-ink">
              Forgot password
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
