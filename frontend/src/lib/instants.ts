/**
 * Turning what a date or time input holds into what the API should be sent.
 *
 * A `datetime-local` value has no zone — `2026-10-31T23:59` — and Joi parses a zoneless string in the
 * **server's** zone, so sent as typed it means a different instant for every operator not sitting in
 * the server's timezone. `isoInstant` resolves it in the browser, which is the zone the operator meant,
 * and sends an unambiguous instant. First written for the new-coupon screen and shared from here since
 * the coupon edit screen needed the same thing and was sending the zoneless form.
 */

/** A `datetime-local` value as an ISO instant, resolved in the viewer's zone. Unparseable text passes through for the server to refuse. */
export function isoInstant(local: string): string {
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? local : parsed.toISOString();
}

/**
 * A `type="date"` value as the instant its day **starts** or **ends** in the viewer's zone.
 *
 * For a window whose end is exclusive — an override "effective until" a day — the operator means
 * "through the end of that day", and midnight UTC of it is neither the start nor the end of their day.
 */
export function dayBound(date: string, edge: 'start' | 'end'): string {
  const parsed = new Date(`${date}T${edge === 'start' ? '00:00:00' : '23:59:59.999'}`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toISOString();
}

/**
 * The calendar day an instant falls on **in the viewer's zone**, as `YYYY-MM-DD`; null for nothing or
 * for text that is not a date.
 *
 * The other direction from the two above, and the fix for `iso.slice(0, 10)` and
 * `new Date().toISOString().slice(0, 10)`, which both read the **UTC** day: a payment taken at 01:00
 * in UTC+5 showed the day before, and a form defaulting to "today" offered yesterday until 05:00.
 * Not for a `DATEONLY` value — that is already a calendar day, and passing it through `Date` moves it
 * west of UTC.
 */
export function localDay(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}
