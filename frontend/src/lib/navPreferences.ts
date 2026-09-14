/**
 * The one thing the sidebar remembers: which groups the reader folded away.
 *
 * ## Why this is a file of its own
 *
 * `verify-frontend.js` holds three rules about browser storage, and the sharpest is that **no file
 * which writes to storage may so much as mention a token, a session or a password** — a heuristic that
 * keeps credentials out of `localStorage` by keeping the two subjects in separate files. `shell.tsx`
 * renders the change-password banner, so it mentions passwords, so it must not be the file that writes
 * the preference. Splitting it out keeps that rule at full strength rather than loosening it to fit a
 * sidebar convenience.
 *
 * What is stored is an array of section headings — "Catalogue", "Billing" — and nothing else. It is a
 * display preference: losing it costs a reader one click, so every failure here is swallowed rather
 * than surfaced.
 */

const COLLAPSED_KEY = 'msms.nav.collapsed';

/** The folded groups, or none if the store is empty, unavailable or holds something unexpected. */
export function readCollapsedGroups(): string[] {
  try {
    const stored = window.localStorage.getItem(COLLAPSED_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    /* Shape-checked, not trusted: this value survives upgrades and can be edited by hand. */
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/** Remember them. A private window, a full disk or a blocked store leaves the sidebar working. */
export function writeCollapsedGroups(headings: string[]): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(headings));
  } catch {
    /* Not remembered for next time; still folded for this visit. */
  }
}
