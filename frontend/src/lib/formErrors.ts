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

export interface SplitErrors {
  /** Keyed by field, for the inputs that render one. */
  perField: Record<string, string>;
  /** Everything with nowhere to sit, joined into one sentence. `null` when there is nothing. */
  banner: string | null;
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
