'use client';

/**
 * The school's notification centre — SRS §23, FR-NOTIF-001.
 *
 * `POST /notifications/:id/read`, `POST /notifications/read-all` and `POST /notifications/:id/retry`
 * had no caller until this screen existed: §23's engine wrote rows nobody could open. Reached from the
 * dashboard rather than the sidebar, because §33 fixes the School nav at seventeen and the suite
 * asserts the count. The inbox itself is `components/notificationsInbox.tsx`, shared with the
 * platform's, the student's and the parent's routes — see its header for the rules it keeps.
 */

import { NotificationsInbox } from '@/components/notificationsInbox';

export default function NotificationsPage() {
  return <NotificationsInbox surface="school" />;
}
