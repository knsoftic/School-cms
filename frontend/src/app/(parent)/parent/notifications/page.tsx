'use client';

/**
 * A parent's notifications — SRS §23. Attendance alerts, fee reminders, receipts, results and homework
 * are addressed to a guardian; until this route a parent reached the inbox only by typing the school
 * surface's address. Linked from the parent dashboard.
 */

import { NotificationsInbox } from '@/components/notificationsInbox';

export default function ParentNotificationsPage() {
  return <NotificationsInbox surface="parent" />;
}
