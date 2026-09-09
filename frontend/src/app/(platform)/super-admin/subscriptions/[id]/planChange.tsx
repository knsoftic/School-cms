'use client';

/**
 * Move a school to another plan — FR-SUB-013 (§12.3 Upgrade) and FR-SUB-014 (§12.4 Downgrade).
 *
 * `POST /:id/upgrade` and `POST /:id/downgrade`, neither of which had a caller.
 *
 * ## The direction is not a control, because it is not the operator's to choose
 *
 * There are two endpoints and one form. `subscriptions.service.changePlan()` classifies the change
 * from the two plans' `tier_rank` and **refuses a request that arrived on the wrong route** with a
 * 409 naming the other one. So the direction is a fact about the pair of plans, which this screen
 * already has, and offering "Upgrade" and "Downgrade" as two buttons would be offering the operator
 * a way to be wrong about something they cannot decide.
 *
 * The form therefore picks the route, and says which one it is picking before the button is pressed.
 * Three cases fall out of that, and all three are stated rather than left to a 409:
 *
 *  - **Higher tier** → upgrade. Proration is calculated and any remaining credit applied.
 *  - **Lower tier** → downgrade, and the §12.4 timing choice appears, because it is required with
 *    no default and the reason is real: an immediate downgrade can drop a limit below what the
 *    school is already using, and a deferred one cannot until the period ends.
 *  - **Same tier** → neither, and the service says so in as many words. The submit is disabled with
 *    that sentence beside it rather than sending a request whose only outcome is that sentence.
 *
 * `tier_rank` is read for this and for nothing else. SRS §30 Rule 1 forbids branching on a plan's
 * identity, and this does not: it compares two ranks to choose an HTTP route, and derives no
 * capability from either. What a plan grants comes from the entitlement snapshot.
 *
 * ## The proration figures are rendered from the response, not from the message
 *
 * `changePlanTo()` puts them in the toast message *and* in `change.proration`. `apiClient` unwraps
 * the envelope's `data` and drops `message`, so the figures are read from the object — which is the
 * better source anyway: `prorationDue`, `creditApplied` and `amountDue` are three numbers an
 * operator may have to reconcile against an invoice, and a sentence is not a place to reconcile
 * from.
 *
 * ## A scheduled downgrade is not an applied one
 *
 * `change.applied` is false when the timing was `next_billing_cycle`: the school keeps its current
 * plan, `scheduled_plan_id` is set, and the change lands at renewal. The panel says that, because
 * the plan named at the top of the screen is then *not* the plan the school will be on next cycle —
 * the same fact the list screen marks with "change scheduled".
 */

import { useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { formatCodeWithAmount } from '@/lib/money';
import { useCollection } from '@/lib/useCollection';
import {
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  Field,
} from '@/components/form';
import { useToast } from '@/components/toast';

import { humanise } from './detail';
import type { SubscriptionDetail } from './detail';

/** One row of `GET /plans`, of which this screen reads four columns. */
interface PlanOption {
  id: number;
  name: string;
  code: string;
  status: string;
  tier_rank: number;
}

/** `POST /:id/upgrade` and `/downgrade` both answer with this. */
interface ChangeResponse {
  subscription: SubscriptionDetail;
  change: {
    direction: string;
    timing: string;
    applied: boolean;
    currency: string;
    newCycleAmount: number;
    toPlan: { id: number; name: string };
    proration: {
      remainingDays: number;
      prorationDue: number;
      creditApplied: number;
      amountDue: number;
    } | null;
  };
}

export function PlanChangePanel({
  subscription,
  timings,
  canChange,
  onChanged,
}: {
  subscription: SubscriptionDetail;
  /** §12.4's two options, from the catalogue rather than declared here. */
  timings: string[];
  canChange: boolean;
  onChanged: (subscription: SubscriptionDetail) => void;
}) {
  const { success } = useToast();

  /*
   * Active plans only. `plans.service.list()` accepts `status`, and a plan that is inactive or
   * archived is refused by `changePlan()` with `PLAN_NOT_AVAILABLE` — so offering one would be
   * offering a choice the next request rejects. The catalogue is small enough that one page of a
   * hundred is the whole of it.
   */
  const plans = useCollection<PlanOption>('/plans', { limit: 100, status: 'active' });

  const [planId, setPlanId] = useState('');
  const [timing, setTiming] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ChangeResponse['change'] | null>(null);

  const currentRank = subscription.plan ? Number(subscription.plan.tier_rank) : 0;

  const chosen = useMemo(
    () => plans.rows.find((plan) => String(plan.id) === planId) ?? null,
    [plans.rows, planId]
  );

  /**
   * Which route the chosen plan implies, or null when it implies neither.
   *
   * `null` covers two different situations that the copy below distinguishes: nothing chosen yet,
   * and a plan on the same tier as the current one.
   */
  const direction: 'upgrade' | 'downgrade' | null = !chosen
    ? null
    : Number(chosen.tier_rank) > currentRank
      ? 'upgrade'
      : Number(chosen.tier_rank) < currentRank
        ? 'downgrade'
        : null;

  const samePlan = chosen !== null && chosen.id === subscription.plan_id;
  const sameTier = chosen !== null && !samePlan && direction === null;

  async function submit() {
    if (!chosen || !direction || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { plan_id: chosen.id };
      if (direction === 'downgrade') body.timing = timing;
      /* Sent as typed, for the reason the create screen argues: `Number('')` is 0, not "unset". */
      if (quantity.trim()) body.quantity = quantity.trim();
      if (reason.trim()) body.reason = reason.trim();

      /*
       * Both routes written out, rather than one path with the direction interpolated into it.
       * `verify-frontend.js` matches `METHOD /path` literally against this source, so an
       * interpolated verb would leave FR-SUB-013 and FR-SUB-014 reporting as uncalled after the
       * screen that calls them shipped — which is the state this screen exists to end.
       */
      const result =
        direction === 'upgrade'
          ? await api.post<ChangeResponse>(`/subscriptions/${subscription.id}/upgrade`, body)
          : await api.post<ChangeResponse>(`/subscriptions/${subscription.id}/downgrade`, body);
      onChanged(result.subscription);
      setOutcome(result.change);
      setPlanId('');
      setTiming('');
      setQuantity('');
      setReason('');
      success(
        result.change.applied
          ? `${humanise(direction)}d to ${result.change.toPlan.name}`
          : `Downgrade to ${result.change.toPlan.name} scheduled`
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setBusy(false);
    }
  }

  if (!canChange) {
    return (
      <Notice tone="info">
        Changing a school’s plan needs the subscription lifecycle permission, which this account does
        not hold.
      </Notice>
    );
  }

  return (
    <FormSection
      title="Change plan"
      description="An upgrade takes effect immediately with proration; a downgrade may be applied now or held until the end of the billing cycle."
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}

        {/*
          * The outcome of the last change, kept on screen after the form clears. A proration figure
          * that vanished with the form would be a number the operator was shown and cannot check.
          */}
        {outcome ? (
          <Notice tone="success">
            {outcome.applied ? (
              <>
                Now on <strong>{outcome.toPlan.name}</strong> at{' '}
                {formatCodeWithAmount(outcome.currency, outcome.newCycleAmount)} per cycle.
                {outcome.proration ? (
                  <>
                    {' '}
                    {formatCodeWithAmount(outcome.currency, outcome.proration.prorationDue)} prorated
                    for the remaining {outcome.proration.remainingDays} day(s),{' '}
                    {formatCodeWithAmount(outcome.currency, outcome.proration.creditApplied)} credit
                    applied, {formatCodeWithAmount(outcome.currency, outcome.proration.amountDue)}{' '}
                    due.
                  </>
                ) : null}
              </>
            ) : (
              <>
                Downgrade to <strong>{outcome.toPlan.name}</strong> scheduled for the end of the
                current billing cycle. The school keeps its current plan until then.
              </>
            )}
          </Notice>
        ) : null}

        {plans.error ? (
          <Notice tone="error">The plan catalogue could not be loaded: {plans.error}</Notice>
        ) : null}

        <SelectField
          id="change-plan"
          label="New plan"
          value={planId}
          onChange={(event) => {
            setPlanId(event.target.value);
            setTiming('');
          }}
          hint={
            plans.loading
              ? 'Loading the catalogue…'
              : 'Only plans currently offered for new subscriptions are listed — the API refuses an inactive or archived one.'
          }
        >
          <option value="">Choose a plan…</option>
          {plans.rows.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name} ({plan.code}) — tier {plan.tier_rank}
            </option>
          ))}
        </SelectField>

        {samePlan ? (
          <Notice tone="warn">
            The school is already on this plan.
          </Notice>
        ) : sameTier ? (
          <Notice tone="warn">
            <strong>{chosen?.name}</strong> is the same tier as the current plan, so this is neither
            an upgrade (FR-SUB-013) nor a downgrade (FR-SUB-014). Both routes would refuse it. Pick a
            plan on a different tier, or change the tier ranks in the plan catalogue if these two are
            genuinely ranked wrongly.
          </Notice>
        ) : direction === 'upgrade' ? (
          <Notice tone="info">
            Higher tier than the current plan, so this is an <strong>upgrade</strong>. It applies
            immediately: the remainder of the current period is prorated and any credit on the
            subscription is put towards it.
          </Notice>
        ) : direction === 'downgrade' ? (
          <Notice tone="info">
            Lower tier than the current plan, so this is a <strong>downgrade</strong> and §12.4 needs
            a timing choice below.
          </Notice>
        ) : null}

        {direction === 'downgrade' ? (
          <SelectField
            id="change-timing"
            label="When it takes effect"
            required
            value={timing}
            onChange={(event) => setTiming(event.target.value)}
            hint="Immediate can drop a limit below what the school is already using — an over-limit school keeps what it has but cannot add more. Next billing cycle leaves everything in place until the period ends."
          >
            <option value="">Choose…</option>
            {timings.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </SelectField>
        ) : null}

        <Field
          id="change-quantity"
          label="Quantity"
          type="number"
          min={1}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          hint={`Leave blank to keep the current ${subscription.quantity}. Only per-unit pricing models bill from it.`}
        />

        <TextAreaField
          id="change-reason"
          label="Reason"
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          hint="Recorded in the audit trail and on the subscription history row."
        />

        <SubmitButton
          busy={busy}
          busyLabel={direction === 'downgrade' ? 'Downgrading…' : 'Upgrading…'}
          fullWidth={false}
          disabled={!direction || (direction === 'downgrade' && timing === '')}
        >
          {direction === 'downgrade' ? 'Downgrade' : 'Upgrade'}
        </SubmitButton>
      </form>
    </FormSection>
  );
}
