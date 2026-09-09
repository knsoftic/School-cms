/**
 * The twenty module keys and their labels, mirroring `backend/src/config/constants.js MODULE_LABELS`.
 *
 * ## This is a duplicated constant, and duplication is how constants go wrong
 *
 * SRS §11 fixes the module list at exactly twenty keys, and §35 forbids a twenty-first. The backend
 * already holds them; this file exists because the landing page at `/` is public and has no session,
 * so there is no entitlement snapshot to read the list from — a page that must render before anyone
 * signs in cannot get it over the wire.
 *
 * The copy is made safe the way this project makes every other copy safe: **`verify-frontend.js`
 * asserts this file and `MODULE_LABELS` are the same twenty keys with the same twenty labels**, so a
 * change to one that is not made to the other fails the suite rather than shipping a landing page
 * advertising a module that no longer exists. Do not edit this list without editing the backend's, and
 * do not add a twenty-first entry to either.
 */

/** Key → label, in the backend's declaration order. */
export const MODULES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'students', label: 'Students' },
  { key: 'teachers', label: 'Teachers' },
  { key: 'staff', label: 'Staff' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'fees', label: 'Fees' },
  { key: 'finance', label: 'Finance' },
  { key: 'exams', label: 'Exams' },
  { key: 'online_exams', label: 'Online Exams' },
  { key: 'library', label: 'Library' },
  { key: 'laboratory', label: 'Laboratory' },
  { key: 'timetable', label: 'Timetable' },
  { key: 'homework', label: 'Homework' },
  { key: 'assignments', label: 'Assignments' },
  { key: 'transport', label: 'Transport' },
  { key: 'hostel', label: 'Hostel' },
  { key: 'parent_portal', label: 'Parent Portal' },
  { key: 'ai', label: 'AI' },
  { key: 'reports', label: 'Reports' },
  { key: 'certificates', label: 'Certificates' },
  { key: 'id_cards', label: 'ID Cards' },
];

/** Just the labels, for the places that list what a plan can include. */
export const MODULE_LABELS: ReadonlyArray<string> = MODULES.map((module) => module.label);

/** A module's label, falling back to its own key rather than rendering nothing. */
export function moduleLabel(key: string): string {
  return MODULES.find((module) => module.key === key)?.label ?? key;
}
