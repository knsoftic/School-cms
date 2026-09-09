/**
 * The parent surface — SRS §15.2, checklist row 4.6.
 *
 * §5 grants a parent exactly one thing: "Holds a Parent Account, may be linked to multiple children,
 * and has access to a Parent Dashboard." No parent-facing list screens are named, and none exist —
 * so this nav has one entry, and that is the requirement rather than a shortfall.
 */
import { AppShell } from '@/components/shell';
import { PARENT_NAV } from '@/lib/nav';

export default function ParentLayout({ children }: { children: React.ReactNode }) {
  return <AppShell nav={PARENT_NAV}>{children}</AppShell>;
}
