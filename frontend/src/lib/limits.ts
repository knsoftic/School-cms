/**
 * The nine limit keys and their labels, mirroring `backend/src/config/constants.js LIMIT_LABELS`.
 *
 * ## Why a copy, and what keeps it honest
 *
 * The entitlement snapshot sends a limit as `{ key, type, value, unit, … }` and no label, so a screen
 * showing limits had nothing to print but the key — and it printed it, with the underscores turned into
 * spaces: "ai limit", "file upload limit", "sms limit". Those are identifiers, not names, and a
 * dashboard is the wrong place to read a database column out loud.
 *
 * The labels are §11.2's own words, so this is a copy of the source rather than a new naming scheme —
 * and, as `lib/modules.ts` does for the twenty modules, **`verify-frontend.js` asserts this file and
 * `LIMIT_LABELS` are the same keys with the same labels**, so a change to one that is not made to the
 * other fails the suite. Eight §11.2 plan limits plus `sms_limit`, which §11.3 sells as an add-on.
 */

/** Key → label, in the backend's declaration order. */
export const LIMITS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'student_limit', label: 'Student Limit' },
  { key: 'teacher_limit', label: 'Teacher Limit' },
  { key: 'staff_limit', label: 'Staff Limit' },
  { key: 'admin_limit', label: 'Admin Limit' },
  { key: 'storage_limit', label: 'Storage Limit' },
  { key: 'ai_limit', label: 'AI Limit' },
  { key: 'api_limit', label: 'API Limit' },
  { key: 'file_upload_limit', label: 'File Upload Limit' },
  { key: 'sms_limit', label: 'SMS Credits' },
];

/** A limit's label, falling back to its own key rather than rendering nothing. */
export function limitLabel(key: string): string {
  return LIMITS.find((limit) => limit.key === key)?.label ?? key.replace(/_/g, ' ');
}
