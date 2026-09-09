/**
 * The student surface — SRS §5, checklist row 4.7.
 *
 * The smallest surface in the product, and deliberately: §5 gives the Student one sentence of
 * "access relevant to their own records", §33's MVP list names no student screen at all, and the
 * backend mounted exactly one self-service endpoint. See `student/page.tsx` for what that means.
 */
import { AppShell } from '@/components/shell';
import { STUDENT_NAV } from '@/lib/nav';

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return <AppShell nav={STUDENT_NAV}>{children}</AppShell>;
}
