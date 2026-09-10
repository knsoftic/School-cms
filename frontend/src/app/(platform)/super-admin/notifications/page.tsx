'use client';

/**
 * The Super Admin's notifications — the owner's decision D15.
 *
 * FR-NOTIF-001 names the Super Admin among its recipients and §29 defines a platform notification (a
 * null `school_id`), and until D15 nothing wrote one. The engine now copies payment received, payment
 * failed and subscription expiry to every Super Admin; this is where they are read. Reached from the
 * platform dashboard, not the nav, which mirrors §33's sixteen Super Admin screens.
 */

import { NotificationsInbox } from '@/components/notificationsInbox';

export default function PlatformNotificationsPage() {
  return <NotificationsInbox surface="platform" />;
}
