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

/**
 * The four a plan can sell and nothing implements — the owner's decision **D37**.
 *
 * "Online Exams, Laboratory, Transport and Hostel can be sold and have no requirement behind them (no
 * FR; §29 gives Online Exams a table and nowhere to store an attempt)… Leave them unbuilt, recorded."
 *
 * They stay in the catalogue, because D37 left them sellable and §35 forbids editing the twenty. What
 * they must not do is claim otherwise on a page anyone can read without signing in: the landing page
 * put the same green tick beside *Online Exams* as beside *Fees*, and a tick on a marketing page is a
 * promise. Listed apart and marked, they are the truth; ticked, they were a claim no code supports.
 *
 * `verify-frontend.js` checks this list against D37's own row in `docs/OWNER-DECISIONS.md`, so building
 * one of them means editing the decision record — which is where that fact belongs.
 */
export const PLANNED_MODULE_KEYS: ReadonlyArray<string> = ['online_exams', 'laboratory', 'transport', 'hostel'];

/** Is this module one a plan may sell but nothing implements yet (D37)? */
export function isPlanned(key: string): boolean {
  return PLANNED_MODULE_KEYS.includes(key);
}

/** A module's label, falling back to its own key rather than rendering nothing. */
export function moduleLabel(key: string): string {
  return MODULES.find((module) => module.key === key)?.label ?? key;
}
