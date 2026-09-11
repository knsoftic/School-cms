'use client';

/**
 * Taking a person off a school's active roll.
 *
 * ## Why this is a form and not a `ConfirmDialog`
 *
 * `PATCH /staff/:id` and `PATCH /teachers/:id` both accept **`is_active` and `left_at`**, and
 * `teachers.validation.js` says why in its own voice: §15.3 names no teacher deletion and no
 * "leaving" operation, so *"a teacher who leaves is deactivated by an edit"*. The leaving date is
 * part of that edit and it is a fact the school knows — not something a screen should invent, and
 * not something it should silently drop either.
 *
 * So the dialog asks. Today is offered as a **default** rather than a guess, because a departure is
 * usually recorded on or near the day, and the field can be cleared for a deactivation whose date
 * genuinely is not known.
 *
 * ## Both directions, deliberately
 *
 * The mistake this control makes possible is deactivating the wrong person, and a one-way door
 * turns that into a support request. Reactivation clears `left_at` back to `null`, because a person
 * who is active again has no leaving date — leaving the old one would make the record say two
 * contradictory things.
 *
 * Reactivation can be refused: `staff_limit` and `teacher_limit` both count `is_active: true`
 * (`usageService.HEADCOUNT_SOURCES`), so restoring somebody into a full allowance is a
 * `PLAN_LIMIT_EXCEEDED`. The copy says so before the button is pressed.
 *
 * ## The login moves with the record
 *
 * The owner's decision D19: the same PATCH moves the person's login, in the same transaction
 * (`usersService.followProfile()`). Deactivating takes an `active` login to `inactive`, so they can no
 * longer sign in; reactivating restores a login that is `inactive`. One an administrator **suspended**
 * stays suspended either way — reactivating a person is not a decision about that account. Only a login
 * of the person's own kind moves (a Teacher login for a teacher, one of the four staff roles for staff),
 * so an account of another role linked to the record by hand is left alone. Both dialogs say what
 * happens to the login, because it is the half of the action with an effect outside the school office.
 *
 * Both are used on a list and on the person's own record, so neither names where to undo it from.
 */

import { useEffect, useState } from 'react';

import { Modal } from '@/components/overlay';
import { Field, Notice, SubmitButton } from '@/components/form';

/** Today as `YYYY-MM-DD` in the **viewer's** zone, which is the day they mean by "today". */
function today(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function DeactivateDialog({
  open,
  person,
  noun,
  allowance,
  busy,
  conflict,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** The person's name, for the copy. Null while nothing is open. */
  person: string | null;
  /** "staff member" / "teacher" — used in the sentences below. */
  noun: string;
  /** The plan limit this frees, named as the school sees it: "staff allowance". */
  allowance: string;
  busy: boolean;
  /** A 409 worth showing here rather than as a toast behind the dialog. */
  conflict: string | null;
  onCancel: () => void;
  /** `left_at` as `YYYY-MM-DD`, or null when the date was cleared. */
  onConfirm: (leftAt: string | null) => void | Promise<void>;
}) {
  const [leftAt, setLeftAt] = useState(today());

  /* A fresh default per person, so yesterday's dialog does not decide today's leaving date. */
  useEffect(() => {
    if (open) setLeftAt(today());
  }, [open, person]);

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={`Deactivate ${person ?? `this ${noun}`}?`}
      description={`They will stop counting towards your ${allowance} and will no longer show as active, and their login, if they have one, is switched off with them — set to inactive, so they cannot sign in. Nothing is deleted: reactivating them later switches it back on, unless an administrator has suspended it.`}
      size="sm"
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className="btn btn-secondary">
            Cancel
          </button>
          <SubmitButton form="deactivate-person" busy={busy} busyLabel="Deactivating…">
            Deactivate
          </SubmitButton>
        </>
      }
    >
      {/* The submit lives in the footer, outside this element — `form=` connects the two. */}
      <form
        id="deactivate-person"
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void onConfirm(leftAt || null);
        }}
      >
        {conflict ? <Notice tone="error">{conflict}</Notice> : null}

        <Field
          id="left_at"
          label="Left on"
          type="date"
          value={leftAt}
          onChange={(event) => setLeftAt(event.target.value)}
          hint="Defaults to today. Clear it if the leaving date is not known — the deactivation still applies."
        />
      </form>
    </Modal>
  );
}

/**
 * Putting a person back on the roll.
 *
 * Separate from the dialog above rather than a mode of it: this one asks for nothing, so a form
 * would be a form with no fields, and the one thing worth saying is that it can be refused.
 */
export function ReactivateDialog({
  open,
  person,
  noun,
  allowance,
  busy,
  conflict,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  person: string | null;
  noun: string;
  allowance: string;
  busy: boolean;
  conflict: string | null;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={`Reactivate ${person ?? `this ${noun}`}?`}
      description={`They will count towards your ${allowance} again, and their leaving date will be cleared. A login switched off when they were deactivated is switched back on; one an administrator suspended stays suspended. If the allowance is already full, this will be refused.`}
      size="sm"
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className="btn btn-secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={busy}
            aria-busy={busy}
            className="btn btn-primary"
          >
            {busy ? 'Reactivating…' : 'Reactivate'}
          </button>
        </>
      }
    >
      {conflict ? <Notice tone="error">{conflict}</Notice> : null}
    </Modal>
  );
}
