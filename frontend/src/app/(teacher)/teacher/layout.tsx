/**
 * The teacher surface — SRS §15.3, checklist row 4.5.
 *
 * A route group of its own so the shell can carry a teacher's nav rather than the school
 * administrator's. The teacher's work happens in the School screens themselves — §5 grants a teacher
 * attendance, marks, homework and timetable, all of which already exist and are permission-gated —
 * so this nav points at those rather than duplicating them.
 */
import { AppShell } from '@/components/shell';
import { TEACHER_NAV } from '@/lib/nav';

export default function TeacherLayout({ children }: { children: React.ReactNode }) {
  return <AppShell nav={TEACHER_NAV}>{children}</AppShell>;
}
