'use client';

/**
 * The school's Logs — SRS §26, "Errors and activity are auditable via logs".
 *
 * The screen is `components/logsScreen.tsx`, shared with the platform's `/super-admin/logs`; its header
 * says what the two trails are and whose rows each caller reads. In the School nav on `logs.view` —
 * the Principal's and the School Admin's — from the allow-list `verify-frontend.js` keeps beside §33's
 * seventeen. Every row here is this school's, because the server confines it, so there is no School
 * filter.
 */

import { LogsScreen } from '@/components/logsScreen';

export default function SchoolLogsPage() {
  return <LogsScreen surface="school" />;
}
