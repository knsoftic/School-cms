'use client';

/**
 * A student's notifications — SRS §23. Homework, exam announcements and published results are
 * addressed to the student as well as their parents, and until this route a student reached the inbox
 * only by typing the school surface's address. Linked from the student dashboard.
 */

import { NotificationsInbox } from '@/components/notificationsInbox';

export default function StudentNotificationsPage() {
  return <NotificationsInbox surface="student" />;
}
