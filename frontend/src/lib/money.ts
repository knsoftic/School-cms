/**
 * Money formatting, in one place, because three screens each had their own and two were wrong.
 *
 * ## The premise the old helpers were built on was false
 *
 * `subscriptions/page.tsx` carried this, with `cycle_amount` typed `string`:
 *
 * ```ts
 * // "The digits after the point are the server's, untouched — "1200.00" renders as
 * //  1,200.00 and not 1200 the way Number("1200.00") would."
 * const [whole, fraction] = String(value).split('.');
 * ```
 *
 * A DECIMAL does **not** arrive as a string. `config/database.js` sets `dialectOptions.decimalNumbers
 * = true`, so mysql2 parses DECIMAL into a JS number before Sequelize ever sees it — measured through
 * the model layer, `Subscription.cycle_amount` reads back as the number `499` from both `.get()` and
 * `.toJSON()`. So the split found no `'.'`, `fraction` came back `undefined`, and the cell rendered
 * **`499`** — precisely the outcome the comment claimed the helper existed to prevent. A cycle amount
 * of `1200.50` rendered `1,200.5`.
 *
 * That is not a cosmetic rounding difference. In a money column `499` and `499.00` differ in what they
 * claim to know, and `1,200.5` is ambiguous between five cents and fifty.
 *
 * ## Why a float is safe here, and where it would stop being safe
 *
 * `models/columns.js` defines `money()` as `DECIMAL(14, 2)` — at most 999,999,999,999.99, which is
 * about 1e12. A float64 holds every integer up to 2^53 (~9.0e15) exactly, so every value this column
 * can store survives the trip and the cents are exact. **Formatting is the only thing done here.**
 * Arithmetic on money — summing a column, applying a discount — belongs on the server, where
 * `utils/money.js` works in minor units; do not add a `sum()` to this file.
 *
 * Currency stays a three-letter code rather than a glyph on the platform screens. Those lists span
 * every school on the platform, so two rows can be different currencies that share a symbol, and
 * `$1,000` beside `$1,000` would be a lie about which is larger.
 */

/* Constructed once. Building a formatter per cell is measurable on a page of twenty rows. */
const DECIMAL = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * A money amount, grouped, always with exactly two decimal places.
 *
 * Accepts `number` (what the API sends today) or `string` (what it would send if `decimalNumbers` were
 * ever turned off) so a change to that one dialect option cannot silently break every money cell.
 * Anything unparseable comes back as the raw input rather than `NaN`: a finance table showing the
 * server's own odd value is debuggable, one showing `NaN` is just broken.
 */
export function formatMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? DECIMAL.format(numeric) : String(value);
}

/** `formatMoney` with the currency code after it — `1,200.00 USD`. */
export function formatAmountWithCode(
  value: number | string | null | undefined,
  currency: string | null | undefined
): string {
  const amount = formatMoney(value);
  if (amount === '—' || !currency) return amount;
  return `${amount} ${currency}`;
}

/** `formatMoney` with the currency code before it — `USD 1,200.00`. */
export function formatCodeWithAmount(
  currency: string | null | undefined,
  value: number | string | null | undefined
): string {
  const amount = formatMoney(value);
  if (amount === '—') return amount;
  return currency ? `${currency} ${amount}` : amount;
}
