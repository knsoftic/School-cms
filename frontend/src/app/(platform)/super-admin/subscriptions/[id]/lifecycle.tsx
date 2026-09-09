'use client';

/**
 * The six administrative transitions and the manual renewal — FR-SUB-010 and FR-SUB-015.
 *
 * `POST /:id/activate`, `/suspend`, `/reactivate`, `/pause`, `/resume`, `/cancel`, `/renew`. All
 * seven were mounted and none had a caller in the product: a subscription could be created and then
 * never activated, paused, cancelled or renewed from any screen.
 *
 * ## Which buttons exist is the server's answer, not this file's
 *
 * `GET /subscriptions/catalogue` publishes the transition table — `{ action, to, from }` per edge —
 * precisely so a screen can *"disable rather than guess"*, in the service's own words. So the bar
 * renders one button per transition whose `from` contains the current state, and nothing else. Two
 * consequences worth naming:
 *
 *  - A state with no legal transition renders no buttons, which is correct and not an empty bar to
 *    apologise for. `expired` and `cancelled` both still offer `reactivate`, so the only way to see
 *    nothing here is a state the table genuinely closes.
 *  - Adding an edge in `subscriptions.service.js TRANSITIONS` makes a button appear here with no
 *    change to this file. Its copy would then be missing, which is why `COPY` is keyed by action and
 *    falls back to a generic sentence rather than rendering `undefined`.
 *
 * ## Every one of them asks for a reason, and one of them means it
 *
 * `subscriptions.validation.js` gives all six the same body — an optional `reason` — and says why:
 * one schema so *"a reason cannot become mandatory on one transition and optional on the next by
 * accident"*. It lands in `audit_logs.reason`. `cancel` is the exception that has a second
 * destination, `subscriptions.cancellation_reason`, which is a real column on the row and the only
 * lasting record of why a school stopped paying — so its field says so, and it is the one field on
 * this screen worth filling in every time.
 *
 * ## What the copy is for
 *
 * Three of the seven move dates the operator did not ask about and cannot see without comparing
 * before and after — `activate` re-bases the paid period to now, `reactivate` starts a *fresh*
 * cycle rather than resuming the old one, and `resume` shifts every future boundary forward by the
 * paused duration. Those are the sentences that matter; "are you sure?" is not.
 *
 * The pause/suspend distinction gets its own sentence for the same reason the service flags it as an
 * interpretation: §12 names both states and defines neither, and the only reading that makes them
 * different is that a pause stops the clock and a suspension does not. An operator choosing between
 * two buttons labelled with synonyms will pick the wrong one.
 */

import { useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { Notice, SubmitButton, TextAreaField } from '@/components/form';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';

import { allowedTransitions, humanise } from './detail';
import type { SubscriptionCatalogue, SubscriptionDetail } from './detail';

/**
 * What each action does, in the words of the service that does it — and the route it posts to.
 *
 * ## Each entry holds the **call**, not a path, and not one interpolated URL
 *
 * The first version of this file built one URL — `/subscriptions/${id}/${action}` — which is
 * shorter, works identically, and is **invisible to the check that exists to catch exactly this
 * module's failure**. `verify-frontend.js` collects `api.<method>(` followed immediately by a path
 * literal, so seven routes reached through an interpolated verb would have gone on reporting as
 * uncalled after the screen that calls them shipped — which is the state this screen exists to end.
 *
 * The second version put the literal in a `path` field and passed it to a shared `api.post`. That is
 * no better: the collector looks for the literal *at the call*, so a path assembled anywhere else is
 * the same blind spot wearing a longer name. Hence `send`, which is the request.
 *
 * A route added to `TRANSITIONS` in the service and not added here still works — the dispatcher
 * falls back to building the path — so a missing entry costs its copy, not the button.
 */
const COPY: Record<
  string,
  {
    label: string;
    /** The call itself, not a path — see the note above. */
    send: (id: number, body: Record<string, unknown>) => Promise<TransitionResponse>;
    title: string;
    description: string;
    confirm: string;
    busy: string;
    tone: 'primary' | 'danger';
    reasonHint: string;
  }
> = {
  activate: {
    label: 'Activate',
    send: (id, body) =>
      api.post<TransitionResponse>(`/subscriptions/${id}/activate`, body),
    title: 'Start the billing period now?',
    description:
      'The paid period is re-based to this moment rather than to the start date — a subscription that sat pending for a week is not billed for a week it did not have. A trial being activated early ends now, and the configured trial length is kept on the record.',
    confirm: 'Activate',
    busy: 'Activating…',
    tone: 'primary',
    reasonHint: 'Recorded in the audit trail.',
  },
  suspend: {
    label: 'Suspend',
    send: (id, body) =>
      api.post<TransitionResponse>(`/subscriptions/${id}/suspend`, body),
    title: 'Suspend this subscription?',
    description:
      'Access ends immediately — a suspended subscription is not one of the states that grants entitlement. The period dates are left exactly where they are, so the school loses the time it is suspended for. Use Pause instead if the school should get that time back.',
    confirm: 'Suspend',
    busy: 'Suspending…',
    tone: 'danger',
    reasonHint: 'Recorded in the audit trail. Worth filling in — this is the record of why access stopped.',
  },
  reactivate: {
    label: 'Reactivate',
    send: (id, body) =>
      api.post<TransitionResponse>(`/subscriptions/${id}/reactivate`, body),
    title: 'Reactivate on a fresh billing cycle?',
    description:
      'A new period starts now. The old one is not resumed: a period that expired months ago would hand the school a cycle it never paid for, and would put the period end in the past for the renewal sweep to act on immediately.',
    confirm: 'Reactivate',
    busy: 'Reactivating…',
    tone: 'primary',
    reasonHint: 'Recorded in the audit trail.',
  },
  pause: {
    label: 'Pause',
    send: (id, body) =>
      api.post<TransitionResponse>(`/subscriptions/${id}/pause`, body),
    title: 'Pause this subscription?',
    description:
      'The clock stops. Resuming shifts every future date forward by however long the pause lasted, so the school gets the paused time back rather than paying for it. That is the difference between Pause and Suspend.',
    confirm: 'Pause',
    busy: 'Pausing…',
    tone: 'primary',
    reasonHint: 'Recorded in the audit trail.',
  },
  resume: {
    label: 'Resume',
    send: (id, body) =>
      api.post<TransitionResponse>(`/subscriptions/${id}/resume`, body),
    title: 'Resume this subscription?',
    description:
      'Every remaining date moves forward by the paused duration, to the hour rather than to the day. If the trial still has time left on it, the subscription resumes as a trial rather than as a paid one.',
    confirm: 'Resume',
    busy: 'Resuming…',
    tone: 'primary',
    reasonHint: 'Recorded in the audit trail.',
  },
  cancel: {
    label: 'Cancel',
    send: (id, body) =>
      api.post<TransitionResponse>(`/subscriptions/${id}/cancel`, body),
    title: 'Cancel this subscription?',
    description:
      'Access ends and the record is kept as billing history — nothing is deleted, and the row still appears in this list. It can be reactivated later, but only onto a new billing cycle starting at that moment.',
    confirm: 'Cancel subscription',
    busy: 'Cancelling…',
    tone: 'danger',
    reasonHint:
      'Stored on the subscription itself as the cancellation reason, not only in the audit trail. This is the field somebody reads six months from now.',
  },

  /*
   * Renewal is in this table and is **not** in the transition table.
   *
   * FR-SUB-015 is not a state change: `renew()` opens the next billing cycle on a subscription that
   * is already open, and refuses one that is not. So it never appears in `catalogue.transitions` and
   * its button is offered on a separate test below — but the dialog it opens is the same dialog, so
   * its copy belongs beside the other six rather than threaded through the same JSX as a second set
   * of props.
   */
  renew: {
    label: 'Renew',
    send: (id, body) =>
      api.post<TransitionResponse>(`/subscriptions/${id}/renew`, body),
    title: 'Renew for the next billing cycle?',
    description:
      'A renewal an operator starts rather than one the nightly sweep starts. The next period begins where the current one ends, and a downgrade scheduled for the cycle boundary is applied as part of it.',
    confirm: 'Renew',
    busy: 'Renewing…',
    tone: 'primary',
    reasonHint: 'Recorded in the audit trail and on the subscription history row.',
  },
};

/**
 * The copy for an edge the service has and this file does not.
 *
 * It has no `path`: the dispatcher falls back to building one from the action name, so a transition
 * added to `TRANSITIONS` still works from the day it is added. Only its words are missing, and the
 * generic sentence says as much rather than rendering `undefined` at the top of a dialog.
 */
const FALLBACK = {
  label: 'Apply',
  send: null,
  title: 'Apply this change?',
  description: 'This transition is offered by the API and has no description on this screen yet.',
  confirm: 'Apply',
  busy: 'Applying…',
  tone: 'primary' as const,
  reasonHint: 'Recorded in the audit trail.',
};

/** What a transition sends back: the whole record, as every write in this module does. */
interface TransitionResponse {
  subscription: SubscriptionDetail;
}

export function LifecycleBar({
  subscription,
  catalogue,
  canAct,
  canRenew,
  onChanged,
}: {
  subscription: SubscriptionDetail;
  catalogue: SubscriptionCatalogue | null;
  /** `subscriptions.lifecycle`. The API re-checks it; hiding the button is a courtesy. */
  canAct: boolean;
  /**
   * Renewal is a different key — `subscriptions.lifecycle` **or** `subscriptions.self.manage`, per
   * `canChangeOwn()` in the router — because FR-SUB-015 names the school as an actor and the six
   * transitions above are platform-only.
   */
  canRenew: boolean;
  onChanged: (subscription: SubscriptionDetail) => void;
}) {
  const { success } = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  /*
   * `useRowAction` is deliberately not used here, alone among the row actions in this product.
   *
   * It reports success through `onDone`, which takes no payload, because it was written for a list
   * that reloads afterwards. Every write on this module answers with the **whole** subscription, so
   * taking that response is both cheaper and more accurate than re-reading — and a hook that
   * discards it would leave this screen showing the pre-write record beside a toast saying the write
   * succeeded. The four pieces of state it owns are kept; the discarded payload is not.
   */
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);

  const copy = pending ? COPY[pending] ?? FALLBACK : null;

  async function run() {
    if (!pending || busy) return;
    setBusy(true);
    setConflict(null);
    try {
      const body = reason.trim() ? { reason: reason.trim() } : {};
      /* The table's own call, or a path built from the action for an edge it has not heard of. */
      const result = copy && copy.send
        ? await copy.send(subscription.id, body)
        : await api.post<TransitionResponse>(`/subscriptions/${subscription.id}/${pending}`, body);
      onChanged(result.subscription);
      success(`${copy?.label ?? humanise(pending)} applied`, `The subscription is now ${humanise(result.subscription.state).toLowerCase()}.`);
      setPending(null);
      setReason('');
    } catch (caught) {
      /*
       * Shown inside the dialog rather than as a toast behind it, for every failure and not only a
       * 409. A 409 here means the row moved while the dialog sat open — the sweep expired it, or
       * another operator acted first — and the answer to that is "close this and look again". The
       * dialog is still on screen with the reason the operator typed in it, so putting the message
       * anywhere else would ask them to read it through the thing they are looking at.
       */
      setConflict(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setBusy(false);
    }
  }

  const transitions = allowedTransitions(catalogue, subscription.state);

  /*
   * Renewal is not in the transition table — it is not a state change but a new billing cycle, and
   * `renew()` refuses a subscription that is not open. `standing.isRecurring` is false for a
   * `one_time` subscription, which has no next period at all: offering the button there would be
   * offering an operation whose only outcome is a refusal.
   */
  const offerRenew = canRenew && subscription.standing.isOpen && subscription.standing.isRecurring;

  if (!canAct && !offerRenew) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {canAct
          ? transitions.map((transition) => {
              const spec = COPY[transition.action] ?? FALLBACK;
              return (
                <button
                  key={transition.action}
                  type="button"
                  className={`btn ${spec.tone === 'danger' ? 'btn-danger' : 'btn-secondary'}`}
                  onClick={() => {
                    setPending(transition.action);
                    setReason('');
                    setConflict(null);
                  }}
                >
                  {spec.label}
                </button>
              );
            })
          : null}

        {offerRenew ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setPending('renew');
              setReason('');
              setConflict(null);
            }}
          >
            Renew now
          </button>
        ) : null}
      </div>

      <Modal
        open={pending !== null}
        onClose={() => {
          if (!busy) setPending(null);
        }}
        title={copy?.title ?? ''}
        description={copy?.description}
        size="sm"
        busy={busy}
        footer={
          <>
            {/*
              * "Cancel" everywhere except on the cancel dialog itself, where two buttons reading
              * "Cancel" and "Cancel subscription" would sit side by side and one of them would be
              * pressed by mistake. "Close" is not the answer either: `Modal`'s own dismiss control
              * already carries that accessible name, and two buttons named "Close" is a dialog a
              * screen reader cannot describe.
              */}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              {pending === 'cancel' ? 'Go back' : 'Cancel'}
            </button>
            <SubmitButton
              form="subscription-transition"
              busy={busy}
              busyLabel={copy?.busy ?? 'Working…'}
              fullWidth={false}
            >
              {copy?.confirm ?? 'Apply'}
            </SubmitButton>
          </>
        }
      >
        <form
          id="subscription-transition"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          {conflict ? <Notice tone="error">{conflict}</Notice> : null}

          <TextAreaField
            id="transition-reason"
            label="Reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            hint={copy?.reasonHint}
          />
        </form>
      </Modal>
    </>
  );
}
