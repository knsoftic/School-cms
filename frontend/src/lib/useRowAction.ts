'use client';

/**
 * The lifecycle of an action taken on one row of a list.
 *
 * ## Why this exists rather than five copies of it
 *
 * Eight endpoints had no caller in the UI, and six of them are the same shape: pick a row, confirm,
 * send one request, say what happened, reload the list. Written out per screen that is five copies
 * of the same four pieces of state — which row, is it in flight, did it fail, and what do we say —
 * and five chances for one of them to forget the reload or to leave the button spinning after a
 * 409.
 *
 * The hook owns the state machine. The caller owns the words and the markup, because those are the
 * parts that genuinely differ: "Deactivate Ada Lovelace" and "Publish the Term 2 results" are not
 * interchangeable, and a shared component that tried to generate them would produce neither.
 *
 * ## What it deliberately does not do
 *
 * It does not render a dialog. `ConfirmDialog` and `Modal` already exist and already handle focus,
 * Escape and the busy state; wrapping them here would mean a second opinion on all three. The
 * caller passes `target` to whichever overlay it wants and calls `confirm`.
 */

import { useCallback, useState } from 'react';

import { ApiError } from '@/lib/apiClient';
import { useToast } from '@/components/toast';

export interface RowAction<T, E = void> {
  /** The row awaiting confirmation, or `null` when nothing is pending. */
  target: T | null;
  /** Open the confirmation for a row. */
  ask: (row: T) => void;
  /** Close it without acting. */
  cancel: () => void;
  /**
   * Run the request for the pending row. Resolves once the toast has been raised.
   *
   * `extra` carries whatever the overlay collected — a leaving date, an amount, a waiver reason. It
   * is passed **through the call** rather than read out of the caller's state, because `perform`
   * closes over the render it was created in: a dialog that set state and then called `confirm`
   * would send the *previous* value, and the bug would be invisible on the first use and wrong on
   * every one after it.
   */
  confirm: (extra: E) => Promise<void>;
  /** True while the request is in flight. */
  busy: boolean;
  /**
   * A message worth showing **inside** the overlay rather than as a toast.
   *
   * Set only for a 409, which on these routes means the row moved while the dialog sat open —
   * somebody else deactivated it, or the slot was taken. The answer to that is "close this and look
   * again", not "press the button harder", and a toast that appears behind a dialog the user is
   * still looking at says it in the wrong place.
   */
  conflict: string | null;
}

export function useRowAction<T, E = void>({
  perform,
  success,
  failure,
  onDone,
}: {
  perform: (row: T, extra: E) => Promise<unknown>;
  /** The confirmation toast. Takes the row so it can name what just happened. */
  success: (row: T) => string;
  /** The heading for any failure that is not a 409. */
  failure: string;
  /** Usually the list's `reload`. Called only after the request succeeds. */
  onDone: () => void;
}): RowAction<T, E> {
  const { success: toastSuccess, error: toastError } = useToast();

  const [target, setTarget] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);

  const ask = useCallback((row: T) => {
    setTarget(row);
    setConflict(null);
    setBusy(false);
  }, []);

  const cancel = useCallback(() => {
    setTarget(null);
    setConflict(null);
  }, []);

  const confirm = useCallback(async (extra: E) => {
    if (!target || busy) return;

    setBusy(true);
    setConflict(null);
    try {
      await perform(target, extra);
      toastSuccess(success(target));
      setTarget(null);
      onDone();
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      if (caught.status === 409) {
        setConflict(caught.message);
      } else {
        toastError(failure, caught.message);
        setTarget(null);
      }
    } finally {
      setBusy(false);
    }
  }, [target, busy, perform, success, failure, onDone, toastSuccess, toastError]);

  return { target, ask, cancel, confirm, busy, conflict };
}
