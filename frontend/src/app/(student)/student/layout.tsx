/**
 * The student surface — SRS §5, checklist row 4.7.
 *
 * §5 gives the Student one sentence of "access relevant to their own records", and §33's MVP list
 * names no student screen at all. What this surface carries is what the API serves a student about
 * themselves: published results, the homework `GET /homework` narrows to their class, and — since the
 * owner's decision D17 — their attendance, fees, record and class timetable. See `student/page.tsx`
 * for the grant behind each.
 */
import { AppShell } from '@/components/shell';
import { STUDENT_NAV } from '@/lib/nav';

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return <AppShell nav={STUDENT_NAV}>{children}</AppShell>;
}
