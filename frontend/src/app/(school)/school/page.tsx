'use client';

/**
 * Principal dashboard — SRS §33's first School screen.
 *
 * Shows the entitlement snapshot truthfully: plan name for display only (§30 Rule 1 — nothing
 * branches on it), module coverage, and limits that matter day to day.
 */

import Link from 'next/link';

import { useAuth } from '@/lib/auth';
import { useEntitlements } from '@/lib/entitlements';
import type { Limit } from '@/lib/entitlements';
import { MetricCard, PageHeader, StatusBadge } from '@/components/table';

function formatLimit(limit: Limit): string {
  if (limit.type === 'unlimited' || limit.value === null) return 'Unlimited';
  return new Intl.NumberFormat().format(limit.value);
}

export default function SchoolDashboard() {
  const { profile, can } = useAuth();
  const { entitlements, hasModule, isSubscriptionScoped } = useEntitlements();

  const modules = entitlements ? Object.entries(entitlements.modules) : [];
  const enabled = modules.filter(([, on]) => on);
  const limits = entitlements ? Object.entries(entitlements.limits) : [];

  const shortcuts = [
    { href: '/school/students', label: 'Students', permission: 'students.view', module: 'students' },
    { href: '/school/attendance', label: 'Attendance', permission: 'attendance.view', module: 'attendance' },
    { href: '/school/fees', label: 'Fees', permission: 'fees.view', module: 'fees' },
    { href: '/school/exams', label: 'Exams', permission: 'exams.view', module: 'exams' },
    { href: '/school/classes', label: 'Classes', permission: 'classes.view', module: null },
    { href: '/school/teachers', label: 'Teachers', permission: 'teachers.view', module: 'teachers' },
  ].filter(
    (item) => can(item.permission) && (item.module === null || hasModule(item.module))
  );

  return (
    <div>
      <PageHeader
        title="School dashboard"
        description={`Welcome back, ${profile?.user.name ?? 'administrator'}.`}
      />

      {/*
        * `!entitlements` does not mean "no plan" — it means **no school in scope**.
        *
        * `auth.service.js callerEntitlements()` returns null for a platform or organization caller:
        * `if (!req.tenant || req.tenant.isPlatform || !req.tenant.schoolId) return null;`. An
        * *unsubscribed school* gets an object instead — `entitlementService.unsubscribedSnapshot()`
        * with `subscription: null, plan: null` — and that case is handled inside the branch below,
        * where it correctly reads "No plan yet".
        *
        * So this branch used to tell a Super Admin or an Organization Admin who opened `/school`
        * that "this school has no active plan", naming a subscription that was never the problem,
        * and hiding the limits, the module list and every shortcut behind the same condition. The
        * flag the provider already publishes says which situation it actually is.
        */}
      {!isSubscriptionScoped ? (
        <div className="surface px-5 py-8 text-center">
          <p className="font-display text-xl font-semibold text-ink">No school in scope</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
            This dashboard reports on one school, and your account is not scoped to one — a platform
            or organization sign-in covers many. Open a school from the Schools screen to see its
            plan, limits and modules.
          </p>
          <Link href="/super-admin/schools" className="btn btn-secondary mt-5">
            Go to Schools
          </Link>
        </div>
      ) : !entitlements ? (
        /* Scoped to a school but the snapshot did not arrive — a read that failed, not a state. */
        <div className="surface px-5 py-8 text-center">
          <p className="font-display text-xl font-semibold text-ink">Plan details unavailable</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
            We could not load this school’s plan just now. Reloading usually settles it; if it does
            not, a platform administrator can check the subscription.
          </p>
        </div>
      ) : (
        <>
          <section className="surface mb-6 p-5">
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Current plan</p>
                <h2 className="mt-1 font-display text-2xl font-semibold text-ink">
                  {entitlements.plan ? entitlements.plan.name : 'No plan yet'}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  {entitlements.plan
                    ? `${enabled.length} of ${modules.length} modules included`
                    : 'This school is not on a plan, so no modules are included yet.'}
                </p>
              </div>
              {/* Nullable: a school may have no subscription at all. */}
              {entitlements.subscription ? (
                <StatusBadge status={entitlements.subscription.state} />
              ) : (
                <span className="text-sm text-muted-soft">No subscription</span>
              )}
            </div>
          </section>

          <section className="mb-8" aria-label="Key limits">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Limits</h2>
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {limits.slice(0, 8).map(([key, limit]) => (
                <MetricCard key={key} label={key.replace(/_/g, ' ')} value={formatLimit(limit)} />
              ))}
            </dl>
          </section>

          <section className="mb-8" aria-label="Included modules">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
              Included modules
            </h2>
            <ul className="flex flex-wrap gap-2">
              {enabled.map(([key]) => (
                <li
                  key={key}
                  className="rounded-full border border-teal/30 bg-teal-mist px-3 py-1 text-xs font-medium capitalize text-teal-deep"
                >
                  {key.replace(/_/g, ' ')}
                </li>
              ))}
            </ul>
          </section>

          {shortcuts.length > 0 ? (
            <section aria-label="Shortcuts">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                Jump to
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {shortcuts.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="surface block p-4 transition-transform duration-200 hover:-translate-y-0.5 hover:border-teal"
                    >
                      <span className="font-semibold text-ink">{item.label}</span>
                      <span className="mt-1 block text-xs text-teal">Open →</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
