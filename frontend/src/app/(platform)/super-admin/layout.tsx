/**
 * The Super Admin surface — SRS §9, §33's sixteen screens.
 *
 * Its own route group so the shell can be given a different nav without either surface knowing the
 * other exists. Nothing here is gated by subscription: the platform role administers the plans, so
 * gating it on one would let a lapsed subscription lock out the account that fixes subscriptions.
 */
import { AppShell } from '@/components/shell';
import { PLATFORM_NAV } from '@/lib/nav';

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return <AppShell nav={PLATFORM_NAV}>{children}</AppShell>;
}
