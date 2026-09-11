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

/* Pinned to `en-US`, as `lib/money.ts` pins its own, so a figure is grouped the same way everywhere. */
const COUNT = new Intl.NumberFormat('en-US');

function formatLimit(limit: Limit): string {
  if (limit.type === 'unlimited' || limit.value === null) return 'Unlimited';
  return COUNT.format(limit.value);
}

/*
 * The unit under each figure. `entitlementService` fills `limit.unit` on every limit — `megabytes`
 * for storage and file uploads, `requests` for AI and API, `count` for the headcounts and SMS — and
 * the cards used to drop it, so "5,000" of storage and "5,000" students sat side by side as if they
 * were the same kind of number. An unlimited card has no figure for a unit to qualify.
 */
function limitUnit(limit: Limit): string | undefined {
  if (limit.type === 'unlimited' || limit.value === null) return undefined;
  return limit.unit ?? undefined;
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
    /*
     * School settings and academic sessions — FR-SCHOOL-001 and FR-SCHOOL-002.
     *
     * Reached from here rather than from the sidebar. The School nav is §33's seventeen plus the
     * entries `verify-frontend.js` allow-lists, each with the source that puts it there — Reports
     * (§22), Billing (D27) and Logs (§26) — and settings is not among them. The two requirements are
     * real and their routes have a caller; nothing yet names the sidebar as the place for them.
     */
    { href: '/school/settings', label: 'School settings', permission: 'school.settings.view', module: null },
    /*
     * Two more screens §33's seventeen do not list and whose requirements are real: §20.3's
     * assignments, and §23's notification centre. The notification one is the starker case — the
     * engine has been writing `in_app` rows since it was built and nothing could read them, so a
     * delivery channel had no recipient.
     */
    { href: '/school/assignments', label: 'Assignments', permission: 'assignments.view', module: 'assignments' },
    { href: '/school/notifications', label: 'Notifications', permission: 'notifications.view', module: null },
    /* §21's workflow. Module-gated as well as permission-gated, like every other AI route. */
    { href: '/school/ai', label: 'AI questions', permission: 'ai.generate', module: 'ai' },
    /*
     * §22's six school reports, for the actors FR-REPORT-001 names (SRS:1190). §33's School list has
     * no Reports entry, and the only report screen was the platform one, whose school picker needs
     * `schools.view`, which no school role holds. §22 is the source the School nav now names it from
     * too, so it is in the sidebar as well as here, on the same pair of keys. Each report inside is
     * gated again on its route's second key; `reports.view` is only the door.
     */
    { href: '/school/reports', label: 'Reports', permission: 'reports.view', module: 'reports' },
    /*
     * The owner's decision D27 — the school's own subscription, invoices and payments. On the
     * subscription read, and module-free: billing is how a school keeps its modules, so a school whose
     * plan has lapsed must still be able to reach it. In the sidebar too, on the same keys — and on
     * `invoices.self.view` as well, which is how an Accountant, who pays the invoices, reaches it.
     */
    { href: '/school/billing', label: 'Billing', permission: 'subscriptions.self.view', module: null, alsoPermission: 'invoices.self.view' },
  ].filter(
    (item) => (can(item.permission) || Boolean(item.alsoPermission && can(item.alsoPermission)))
      && (item.module === null || hasModule(item.module))
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
            {/*
              * Every limit the snapshot carries. This was `limits.slice(0, 8)`, and the snapshot has
              * nine — the eight §11.2 plan limits and `sms_limit`, an add-on-only allowance that
              * `emptyLimits()` inserts last — so the cut always fell on SMS credits, the one a school
              * buys, and nothing said a card was missing. The grid wraps.
              */}
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {limits.map(([key, limit]) => (
                <MetricCard
                  key={key}
                  label={key.replace(/_/g, ' ')}
                  value={formatLimit(limit)}
                  hint={limitUnit(limit)}
                />
              ))}
            </dl>
          </section>

          <section className="mb-8" aria-label="Included modules">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
              Included modules
            </h2>
            {/*
              * An unsubscribed school has every module off — `unsubscribedSnapshot()` returns
              * `emptyModules()` — which is the ordinary state before billing starts, and it used to
              * render this heading over blank space. The plan card above already words it; this says
              * the same in its own place.
              */}
            {enabled.length > 0 ? (
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
            ) : (
              <p className="text-sm text-muted">
                {entitlements.plan
                  ? 'No modules are included at the moment.'
                  : 'No modules are included yet. They come with a plan, which a platform administrator sets up.'}
              </p>
            )}
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
