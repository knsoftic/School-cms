'use strict';

/**
 * Human-readable document numbers for the billing tables — `invoices.invoice_number`,
 * `payments.payment_number`, `refunds.refund_number`, `quotations.quotation_number`.
 *
 * All four columns are `STRING(40) NOT NULL UNIQUE` in `models/billing.js`, and none of them has a
 * default. Something has to produce the value, and §13.1 lists *"Invoice Number"* as a field a person
 * reads off a screen — so it has to be legible, not a UUID.
 *
 * ## Why the number is derived from the table it is going into
 *
 * The obvious implementation is a `document_sequences` table holding a counter per prefix. SRS §29
 * fixes the schema at 64 tables and §35 forbids adding a 65th, so that table cannot exist. The only
 * other place the "highest number issued so far" is recorded is the target table's own unique column,
 * which is therefore where this reads it from.
 *
 * ## Format, and why the period is in it
 *
 *     PREFIX-YYYYMM-NNNNN        e.g.  INV-202608-00001
 *
 * The period segment does two jobs. It makes the `LIKE` scan that finds the current maximum hit a
 * bounded slice of the unique index instead of the whole table, and it makes the number say when it was
 * issued — which is what makes it useful on a printed invoice.
 *
 * The counter therefore **restarts at 1 each month**, by design. `INV-202608-00007` and
 * `INV-202609-00001` are consecutive issuances. This is stated because a monthly reset looks like a
 * bug to anyone expecting one unbroken series, and because it means a gap inside one month is genuine
 * information (see below) rather than an artefact of rollover.
 *
 * The prefixes live here rather than in `config/constants.js`: that file mirrors the SRS's own
 * vocabulary, and the SRS names no prefixes. Nor are they env-configurable — a `INVOICE_PREFIX`
 * setting would be inventing configuration the document does not describe.
 *
 * ## Concurrency: what actually prevents two invoices numbered 00007
 *
 * Three things, in order of who catches it:
 *
 *  1. **`nextNumber()` must be called inside the caller's transaction.** Its read is
 *     `... WHERE col LIKE 'INV-202608-%' ORDER BY col DESC LIMIT 1 FOR UPDATE`. On InnoDB under
 *     `REPEATABLE READ` that takes a next-key lock over the scanned index range, so a second
 *     transaction reading the same range blocks until the first commits and then sees its row. This is
 *     the mechanism that makes the common case correct rather than lucky, and it is why `transaction`
 *     is a required argument and not an option.
 *  2. **The `UNIQUE` index.** Gap locking is an InnoDB behaviour under a particular isolation level,
 *     and neither is this module's to guarantee. If the lock does not serialize — a different engine, a
 *     `READ COMMITTED` session, a replica — the second insert still fails rather than duplicating.
 *     The index is the correctness guarantee; the lock is the performance one.
 *  3. **`withRetry()`.** Turns that failure into a retry of the whole unit of work. It has to wrap the
 *     transaction, not live inside it, because a failed insert leaves a transaction that must be rolled
 *     back before a new number can be read — which is why this is a separate exported function the
 *     service wraps its `sequelize.transaction()` call in, rather than something `nextNumber()` can do
 *     for itself.
 *
 * A number is consumed by the attempt, not by the success: a transaction that allocates
 * `INV-202608-00004` and then rolls back leaves 00004 unused, and the next issuance takes 00005 only if
 * the rolled-back row is gone — it is, so the next issuance reuses 00004. A visible gap in a committed
 * series therefore means a row was **deleted**, which for these tables (not `paranoid` — a `destroy()`
 * is a real delete) is worth being able to see.
 */

const { Op } = require('sequelize');

/** One prefix per document type. Kept short because the number is read aloud over the phone. */
const PREFIXES = Object.freeze({
  INVOICE: 'INV',
  PAYMENT: 'PAY',
  REFUND: 'REF',
  QUOTATION: 'QTN',
  /** SRS §17 — the fee receipt a school hands a parent. Scoped per school; see `scope` below. */
  FEE_RECEIPT: 'RCP',
});

/** Zero-padded width of the counter. Five digits is 99,999 documents in one month per type. */
const COUNTER_WIDTH = 5;

/** How many times `withRetry()` re-runs a unit of work that lost a number race. */
const DEFAULT_ATTEMPTS = 4;

/**
 * `YYYYMM` for a date, in the server's timezone.
 *
 * Deliberately not UTC-normalised: the number is a label for humans in one deployment, and an invoice
 * issued at 9pm on the 31st should not be stamped with next month.
 *
 * @param {Date|string|number} [at]
 * @returns {string}
 */
function periodOf(at) {
  const date = at ? new Date(at) : new Date();
  const usable = Number.isNaN(date.getTime()) ? new Date() : date;
  const month = String(usable.getMonth() + 1).padStart(2, '0');

  return `${usable.getFullYear()}${month}`;
}

/**
 * Assemble a number from its parts.
 *
 * @param {string} prefix
 * @param {string} period `YYYYMM`
 * @param {number} counter
 * @returns {string}
 */
function format(prefix, period, counter) {
  return `${prefix}-${period}-${String(counter).padStart(COUNTER_WIDTH, '0')}`;
}

/**
 * Split a number back into its parts, or `null` when it does not match the format.
 *
 * Used by `nextNumber()` to read the counter off the current maximum, and worth exporting: a number
 * typed into a search box can be checked here before it becomes a query.
 *
 * @param {string} value
 * @returns {{prefix: string, period: string, counter: number}|null}
 */
function parse(value) {
  const match = /^([A-Z]{2,6})-(\d{6})-(\d+)$/.exec(String(value || '').trim().toUpperCase());
  if (!match) return null;

  return { prefix: match[1], period: match[2], counter: Number(match[3]) };
}

/**
 * Allocate the next number for a document type, inside the caller's transaction.
 *
 * `ORDER BY column DESC` is a lexical sort, which is the same as numeric here **because the counter is
 * zero-padded to a fixed width** — `00010` sorts above `00009`. That is the reason for the padding, not
 * cosmetics. It holds until the counter overflows `COUNTER_WIDTH`, at which point `000100000` would sort
 * below `00099999`; the guard below refuses that rather than issuing a number that breaks the ordering
 * every subsequent call depends on.
 *
 * ## `scope`, and why it is not optional decoration
 *
 * The four billing columns above are unique **across the whole table**, so the maximum is found by
 * scanning the period alone. `fee_payments.receipt_number` is not: its index is
 * `(school_id, receipt_number)`, unique **per school** (SRS §17's receipt belongs to one school's books).
 * Allocating it from an unscoped scan would still be *correct* — a globally rising number satisfies a
 * per-school index trivially — but it would make one school's receipt series carry the gaps left by every
 * other school's collections, which both looks wrong to the accountant reading it and discloses other
 * tenants' transaction volume. `scope` narrows the locking read to the tenant that owns the series.
 *
 * @param {import('sequelize').ModelStatic<any>} model The Sequelize model owning the column.
 * @param {object} options
 * @param {string} options.column Unique column holding the number.
 * @param {string} options.prefix One of `PREFIXES`.
 * @param {import('sequelize').Transaction} options.transaction Required — see the header.
 * @param {Date|string} [options.at] Issue date the period is taken from. Defaults to now.
 * @param {object} [options.scope] Extra `where` terms the series is counted within, for a column whose
 *   unique index is composite (e.g. `{ school_id: 7 }`). Omit for a table-wide series.
 * @returns {Promise<string>}
 */
async function nextNumber(model, { column, prefix, transaction, at, scope } = {}) {
  if (!model || !column || !prefix) {
    throw new Error('nextNumber() needs a model, a column and a prefix');
  }

  /*
   * Not an ApiError: a caller reaching here without a transaction is a programming mistake, and the
   * whole safety argument in the header rests on the lock this read takes. Failing loudly in
   * development is the point — the alternative is a number generator that silently races in production.
   */
  if (!transaction) {
    throw new Error(
      `nextNumber() requires a transaction — the ${column} allocation relies on a locking read`
    );
  }

  const period = periodOf(at);
  const series = `${prefix}-${period}-`;

  const latest = await model.findOne({
    where: { ...(scope || {}), [column]: { [Op.like]: `${series}%` } },
    order: [[column, 'DESC']],
    attributes: [column],
    /* The next-key lock the header's point 1 describes. */
    lock: transaction.LOCK.UPDATE,
    transaction,
    /* These tables are not `paranoid`, but say so explicitly: a deleted row must not hold a number. */
    paranoid: false,
  });

  const parsed = latest ? parse(latest.get(column)) : null;
  const counter = (parsed ? parsed.counter : 0) + 1;

  if (String(counter).length > COUNTER_WIDTH) {
    throw new Error(
      `${column} sequence for ${series} exhausted at ${10 ** COUNTER_WIDTH - 1} documents in one month`
    );
  }

  return format(prefix, period, counter);
}

/**
 * Was this error a collision on a document-number column?
 *
 * Sequelize reports a duplicate key as `SequelizeUniqueConstraintError` with the offending field in
 * `error.fields`. MySQL names the *index* rather than the column there, so the column name is matched
 * against both the field keys and the raw message — the index on `invoice_number` is auto-named after
 * the column, so one of the two hits.
 *
 * @param {Error} error
 * @param {string} [column] Restrict the match to one column. Omit to accept any number collision.
 * @returns {boolean}
 */
function isDuplicateNumber(error, column) {
  if (!error || error.name !== 'SequelizeUniqueConstraintError') return false;
  if (!column) return true;

  const fields = Object.keys(error.fields || {});
  if (fields.some((f) => String(f).includes(column))) return true;

  const original = error.original || error.parent;
  return String(original?.sqlMessage || error.message || '').includes(column);
}

/**
 * Run a unit of work, re-running it if it lost a document-number race.
 *
 * Wraps the *transaction*, for the reason the header's point 3 gives. Anything that is not a duplicate
 * number rethrows immediately — a retry loop that swallowed other conflicts would turn a real 409 into
 * four attempts and then the same 409, having taken four times as long to say so.
 *
 * @template T
 * @param {() => Promise<T>} task
 * @param {object} [options]
 * @param {string} [options.column] Passed to `isDuplicateNumber()`.
 * @param {number} [options.attempts]
 * @returns {Promise<T>}
 */
async function withRetry(task, { column, attempts = DEFAULT_ATTEMPTS } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      if (!isDuplicateNumber(error, column)) throw error;
      lastError = error;
    }
  }

  throw lastError;
}

module.exports = {
  PREFIXES,
  COUNTER_WIDTH,
  DEFAULT_ATTEMPTS,
  periodOf,
  format,
  parse,
  nextNumber,
  isDuplicateNumber,
  withRetry,
};
