'use client';

/**
 * Sorting a 422 into the fields that can show it and the banner that has to.
 *
 * ## The failure this exists to prevent
 *
 * `ApiError.fieldErrors()` returns whatever the server keyed its messages by, and on several
 * endpoints that is **not** the name of an input. Three sources, all real:
 *
 *   * **Model-level Sequelize validators.** `instance-validator.js` sets `errorKey = validatorType`
 *     for a validator not attached to an attribute, so `timetables`' cross-column rules arrive as
 *     `field: "timeOrdered"` and `field: "teachingSlotNeedsSubject"` — an end time at or before the
 *     start, and a teaching period with no subject. Those are the two likeliest mistakes on that
 *     screen.
 *   * **`rethrow()`'s foreign-key branch**, which reports `field: "body"`.
 *   * **`resolveSchool()`**, which names `school_id` — a field the school-surface forms deliberately
 *     do not render, because the tenant scope already decides it.
 *
 * Left alone each is filed under a key nothing draws, and the resulting **non-empty** map then
 * suppresses the top-level banner as well. The net effect is a rejected submit that looks like
 * nothing happened at all: no message anywhere, on the mistake a user is most likely to make.
 *
 * So a message whose field the form does not render is promoted to the banner. Passing the set of
 * rendered fields explicitly, rather than inferring it, is what makes that decision reviewable — the
 * set sits beside the form it describes and a field added to one without the other is visible.
 */

import type { ApiError } from '@/lib/apiClient';
import { humaniseFieldError } from '@/components/form';

export interface SplitErrors {
  /** Keyed by field, for the inputs that render one. */
  perField: Record<string, string>;
  /** Everything with nowhere to sit, joined into one sentence. `null` when there is nothing. */
  banner: string | null;
}

export interface IndexedErrors {
  /** Row index → that row's messages, keyed by field. `_row` holds a message about the row itself. */
  rows: Map<number, Record<string, string>>;
  /** Messages about the collection as a whole, in the order the server reported them. */
  set: string[];
}

/**
 * A 422 from a whole-collection `PUT`, sorted by row.
 *
 * The three set editors — plan prices, plan limits, and the attendance register before them — send an
 * array, and Joi reports a rejected item by its **path**: `prices.2.base_amount`, `limits.5.limit_value`.
 * No input on any of those screens is called that, so left alone the message lands nowhere and the
 * non-empty map then suppresses the banner too — the same silent-rejection failure `splitApiErrors`
 * exists to prevent, one level down.
 *
 * Set-level rules have no index and belong at the top: `checkPriceSet`'s two, `setLimits`' "every plan
 * limit must be configured", and any `array.max` / `array.length`.
 *
 * @param perField `ApiError.fieldErrors()`
 * @param collection the array's name in the request body — `prices`, `limits`, `entries`
 */
export function splitIndexedErrors(
  perField: Record<string, string>,
  collection: string
): IndexedErrors {
  const rows = new Map<number, Record<string, string>>();
  const set: string[] = [];

  /* Both notations, because Joi's own messages use `prices[1]` while its paths use `prices.1`. */
  const indexed = new RegExp(`^${collection}[.[](\\d+)\\]?\\.?(.*)$`);

  for (const [field, message] of Object.entries(perField)) {
    const match = indexed.exec(field);
    if (!match) {
      set.push(message);
      continue;
    }
    const index = Number(match[1]);
    const existing = rows.get(index) ?? {};
    /* A rule on the item rather than on one of its fields — `limitItem`'s own `when` clauses. */
    existing[match[2] || '_row'] = message;
    rows.set(index, existing);
  }

  return { rows, set };
}

/**
 * One row's message for one field, named the way the row labels it.
 *
 * `FieldMessage` humanises every error it renders, but it can only match a message that begins with
 * the input's **own id** — and in a set editor no input can be called `overage_unit_amount`, because
 * eight rows would then share an id. So the rewrite has to happen here, where the server's key is
 * still known.
 *
 * Measured, not hypothetical: ticking "allow going over the limit" on the plan limits screen and
 * saving with the rate blank produced, verbatim, `"overage_unit_amount" is required when overage is
 * allowed; use 0 for free overage` — under a box labelled "Rate per extra count".
 *
 * @param errors one row of `splitIndexedErrors().rows`
 * @param field the field's name in the request item, which is what the server keyed the message by
 * @param label the label the row shows above that control
 */
export function rowError(
  errors: Record<string, string>,
  field: string,
  label: string
): string | undefined {
  const message = errors[field];
  return message === undefined ? undefined : humaniseFieldError(message, field, label);
}

export function splitApiErrors(error: ApiError, rendered: Set<string>): SplitErrors {
  const perField = error.fieldErrors();

  /* Whole-object rules first — `formErrors()` is already the messages Joi reported with no path. */
  const unplaced = error.formErrors();

  for (const [field, message] of Object.entries(perField)) {
    if (!rendered.has(field)) {
      unplaced.push(message);
      delete perField[field];
    }
  }

  return {
    perField,
    /*
     * `error.message` as the last resort, so a 422 whose details were an object rather than an
     * array — which several conflict codes send — still says something.
     */
    banner: unplaced.length
      ? unplaced.join(' ')
      : Object.keys(perField).length
        ? null
        : error.message,
  };
}
