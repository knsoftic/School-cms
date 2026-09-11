/**
 * The parent surface — SRS §15.2, checklist row 4.6.
 *
 * §5 grants a parent "a Parent Account, may be linked to multiple children, and has access to a
 * Parent Dashboard", and FR-PARENT-001's outcome is that the parent "can access records for all
 * linked children". So the nav carries the dashboard and the records the API serves a parent for
 * their own children — published results and homework, and since the owner's decision D17 attendance,
 * fees, the student record and the class timetable. It used to carry the dashboard alone, on the
 * belief that no endpoint served anything more; see `parent/page.tsx`.
 */
import { AppShell } from '@/components/shell';
import { PARENT_NAV } from '@/lib/nav';

export default function ParentLayout({ children }: { children: React.ReactNode }) {
  return <AppShell nav={PARENT_NAV}>{children}</AppShell>;
}
