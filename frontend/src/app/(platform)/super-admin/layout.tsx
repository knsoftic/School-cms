/**
 * The Super Admin surface — SRS §9, §33's sixteen screens, and §26's Logs.
 *
 * Its own route group so the shell can be given a different nav without either surface knowing the
 * other exists. Nothing here is gated by subscription: the platform role administers the plans, so
 * gating it on one would let a lapsed subscription lock out the account that fixes subscriptions.
 *
 * Nor is anything here gated by role. The Organization Admin (owner decision D18) holds the read keys
 * of ten of these screens — the dashboard, organizations, schools, principals, users, subscriptions,
 * invoices, payments, reports and §26's logs — and every read of a tenant's rows behind them is confined
 * to its organization on the server (`tenantWhere()`, `scopeFor()`, `resolveSchool()`,
 * `platform.service.getDashboard()`). `AppShell` filters
 * `PLATFORM_NAV` by `can()`, and each write control is gated on its own permission. Where a signed-in
 * caller is *sent* is `landingRouteFor()` in `lib/nav.ts`, not this layout.
 */
import { AppShell } from '@/components/shell';
import { PLATFORM_NAV } from '@/lib/nav';

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return <AppShell nav={PLATFORM_NAV}>{children}</AppShell>;
}
