'use client';

/**
 * Principal dashboard — SRS §33's first School screen.
 *
 * Shows the entitlement snapshot truthfully: plan name for display only (§30 Rule 1 — nothing
 * branches on it), module coverage, and limits that matter day to day.
 */

import Link from 'next/link';

import { Icon } from '@/components/icon';
import { useAuth } from '@/lib/auth';
import { useEntitlements } from '@/lib/entitlements';
import type { Limit } from '@/lib/entitlements';
import { limitLabel } from '@/lib/limits';
import { moduleLabel } from '@/lib/modules';
import {
  DashboardBanner,
  HeaderActions,
  MetricCard,
  PageHeader,
  SectionHeading,
  ShortcutTile,
  StatusBadge,
} from '@/components/table';

/**
 * The date a subscription's state turns on, in the viewer's own zone.
 *
 * A state word alone — Active, Trial, Grace Period — says nothing about *when*, which is the only part
 * a principal has to act on. Rendered from the instant the snapshot already carries, so the screen adds
 * no fact of its own.
 */
const DAY = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

function onDay(instant: string | null): string | null {
  if (!instant) return null;
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? null : DAY.format(date);
}

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

  /*
   * What the state means in dates. Each branch reads the instant that *that* state turns on, so the
   * line is never a guess: a trial says when it ends, a grace period says when it runs out, and an
   * ordinary period says when it renews.
   */
  const subscription = entitlements?.subscription ?? null;
  const renewsOn = (() => {
    if (!subscription) return null;
    const state = subscription.state.toLowerCase();
    if (state.includes('trial')) {
      const day = onDay(subscription.trialEndsAt);
      return day ? `Trial ends ${day}` : null;
    }
    if (state.includes('grace')) {
      const day = onDay(subscription.gracePeriodEndsAt);
      return day ? `Grace ends ${day}` : null;
    }
    const day = onDay(subscription.currentPeriodEnd);
    if (!day) return null;
    return subscription.renewalMode === 'manual' ? `Period ends ${day}` : `Renews ${day}`;
  })();

  const canBilling = can('subscriptions.self.view') || can('invoices.self.view');
  const canStudents = can('students.view') && hasModule('students');
  const canAttendance = can('attendance.view') && hasModule('attendance');

  const shortcuts = [
    { href: '/school/students', label: 'Students', permission: 'students.view', icon: 'graduation' as const, module: 'students' },
    { href: '/school/attendance', label: 'Attendance', permission: 'attendance.view', icon: 'clipboard' as const, module: 'attendance' },
    { href: '/school/fees', label: 'Fees', permission: 'fees.view', icon: 'wallet' as const, module: 'fees' },
    { href: '/school/exams', label: 'Exams', permission: 'exams.view', icon: 'file-text' as const, module: 'exams' },
    { href: '/school/classes', label: 'Classes', permission: 'classes.view', icon: 'grid' as const, module: null },
    { href: '/school/teachers', label: 'Teachers', permission: 'teachers.view', icon: 'users' as const, module: 'teachers' },
    /*
     * School settings and academic sessions — FR-SCHOOL-001 and FR-SCHOOL-002.
     *
     * Reached from here rather than from the sidebar. The School nav is §33's seventeen plus the
     * entries `verify-frontend.js` allow-lists, each with the source that puts it there — Reports
     * (§22), Billing (D27) and Logs (§26) — and settings is not among them. The two requirements are
     * real and their routes have a caller; nothing yet names the sidebar as the place for them.
     */
    { href: '/school/settings', label: 'School settings', permission: 'school.settings.view', icon: 'settings' as const, module: null },
    /*
     * Two more screens §33's seventeen do not list and whose requirements are real: §20.3's
     * assignments, and §23's notification centre. The notification one is the starker case — the
     * engine has been writing `in_app` rows since it was built and nothing could read them, so a
     * delivery channel had no recipient.
     */
    { href: '/school/assignments', label: 'Assignments', permission: 'assignments.view', icon: 'paperclip' as const, module: 'assignments' },
    { href: '/school/notifications', label: 'Notifications', permission: 'notifications.view', icon: 'inbox' as const, module: null },
    /* §21's workflow. Module-gated as well as permission-gated, like every other AI route. */
    { href: '/school/ai', label: 'AI questions', permission: 'ai.generate', icon: 'layers' as const, module: 'ai' },
    /*
     * §22's six school reports, for the actors FR-REPORT-001 names (SRS:1190). §33's School list has
     * no Reports entry, and the only report screen was the platform one, whose school picker needs
     * `schools.view`, which no school role holds. §22 is the source the School nav now names it from
     * too, so it is in the sidebar as well as here, on the same pair of keys. Each report inside is
     * gated again on its route's second key; `reports.view` is only the door.
     */
    { href: '/school/reports', label: 'Reports', permission: 'reports.view', icon: 'bar-chart' as const, module: 'reports' },
    /*
     * The owner's decision D27 — the school's own subscription, invoices and payments. On the
     * subscription read, and module-free: billing is how a school keeps its modules, so a school whose
     * plan has lapsed must still be able to reach it. In the sidebar too, on the same keys — and on
     * `invoices.self.view` as well, which is how an Accountant, who pays the invoices, reaches it.
     */
    { href: '/school/billing', label: 'Billing', permission: 'subscriptions.self.view', icon: 'credit-card' as const, module: null, alsoPermission: 'invoices.self.view' },
  ].filter(
    (item) => (can(item.permission) || Boolean(item.alsoPermission && can(item.alsoPermission)))
      && (item.module === null || hasModule(item.module))
  );

  return (
    <div>
      <PageHeader
        title="School dashboard"
        description={`Welcome back, ${profile?.user.name ?? 'administrator'}. Start with the work that matters today.`}
        action={
          <HeaderActions>
            {can('notifications.view') ? (
              <Link href="/school/notifications" className="btn btn-secondary">
                <Icon name="inbox" size={15} />
                Notifications
              </Link>
            ) : null}
            {canAttendance ? (
              <Link href="/school/attendance/mark" className="btn btn-secondary">
                <Icon name="clipboard" size={15} />
                Mark attendance
              </Link>
            ) : null}
            {canStudents ? (
              <Link href="/school/students/new" className="btn btn-primary">
                <Icon name="plus" size={15} />
                Add student
              </Link>
            ) : null}
          </HeaderActions>
        }
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
        <DashboardBanner
          title="No school in scope"
          icon="school"
          action={
            <Link href="/super-admin/schools" className="btn btn-primary">
              <Icon name="school" size={15} />
              Go to Schools
            </Link>
          }
        >
          This dashboard reports on one school, and your account is not scoped to one — a platform or
          organization sign-in covers many. Open a school from the Schools screen to see its plan,
          limits and modules.
        </DashboardBanner>
      ) : !entitlements ? (
        /* Scoped to a school but the snapshot did not arrive — a read that failed, not a state. */
        <DashboardBanner title="Plan details unavailable" icon="alert-circle" tone="warn">
          We could not load this school’s plan just now. Reloading usually settles it; if it does not,
          a platform administrator can check the subscription.
        </DashboardBanner>
      ) : (
        <>
          {/*
            * The plan band says three things a principal acts on: which plan, what state it is in, and
            * **the date that state turns**. It used to say the first two and leave the third in the
            * billing screen, so "Trial" carried no hint of how long is left.
            */}
          <section className="surface mb-7 p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted">
                  Current plan
                </p>
                <h2 className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-ink">
                  {entitlements.plan ? entitlements.plan.name : 'No plan yet'}
                </h2>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">
                  {entitlements.plan
                    ? `${enabled.length} of ${modules.length} modules included${renewsOn ? ` · ${renewsOn}` : ''}`
                    : 'This school is not on a plan, so no modules are included yet.'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                {/* Nullable: a school may have no subscription at all. */}
                {entitlements.subscription ? (
                  <StatusBadge status={entitlements.subscription.state} />
                ) : (
                  <span className="text-sm text-muted-soft">No subscription</span>
                )}
                {canBilling ? (
                  <Link href="/school/billing" className="btn btn-secondary btn-sm">
                    <Icon name="credit-card" size={14} />
                    Manage billing
                  </Link>
                ) : null}
              </div>
            </div>
          </section>

          {/*
            * Shortcuts first, limits and modules after.
            *
            * The order was the other way round, which put nine allowance figures and a row of module
            * chips — reference, read once a month — above the only part of this screen that *goes*
            * anywhere. A dashboard's job is to start work, so the links come first and the plan's
            * small print sits under them.
            */}
          {shortcuts.length > 0 ? (
            <section className="mb-8" aria-label="Go to">
              <SectionHeading>Quick links</SectionHeading>
              <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {shortcuts.map((item) => (
                  <li key={item.href}>
                    <ShortcutTile href={item.href} label={item.label} icon={item.icon} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="mb-8" aria-label="Key limits">
            <SectionHeading>What the plan allows</SectionHeading>
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
                  /* §11.2's own names, mirrored in `lib/limits.ts`; the key itself is not a name. */
                  label={limitLabel(key)}
                  value={formatLimit(limit)}
                  hint={limitUnit(limit)}
                />
              ))}
            </dl>
          </section>

          <section className="mb-2" aria-label="Included modules">
            <SectionHeading>Included modules</SectionHeading>
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
                    className="rounded-md border border-brand-subtle-border bg-brand-subtle px-3 py-1.5 text-xs font-semibold text-brand-text"
                  >
                    {/* §11's own names, from `lib/modules.ts` — not the key with its underscores rubbed out. */}
                    {moduleLabel(key)}
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
        </>
      )}
    </div>
  );
}
