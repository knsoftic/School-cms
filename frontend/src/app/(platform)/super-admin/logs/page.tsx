'use client';

/**
 * The platform's Logs — SRS §26, "Errors and activity are auditable via logs".
 *
 * The screen is `components/logsScreen.tsx`, shared with the school's `/school/logs`; its header says
 * what the two trails are and whose rows each caller reads. In the platform nav on `logs.view`, which
 * reaches the Super Admin — every row, the platform's own included — and the Organization Admin, whose
 * reads the server confines to its organization. This screen adds a School filter the school's does not
 * have.
 */

import { LogsScreen } from '@/components/logsScreen';

export default function PlatformLogsPage() {
  return <LogsScreen surface="platform" />;
}
