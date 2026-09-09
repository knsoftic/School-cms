/**
 * The school surface — SRS §33's seventeen screens.
 *
 * Every item in `SCHOOL_NAV` that names a module is filtered by the school's entitlement snapshot,
 * so what a principal sees is decided by their plan and never by a plan name in this code (§30 R1).
 */
import { AppShell } from '@/components/shell';
import { SCHOOL_NAV } from '@/lib/nav';

export default function SchoolLayout({ children }: { children: React.ReactNode }) {
  return <AppShell nav={SCHOOL_NAV}>{children}</AppShell>;
}
