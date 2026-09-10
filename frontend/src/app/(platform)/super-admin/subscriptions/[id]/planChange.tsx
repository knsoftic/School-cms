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
 *  - **Higher tier** → upgrade. Proration is calculated, any remaining credit applied, and a positive
 *    amount left to pay is invoiced in the same transaction.
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
 * ## The price is chosen here, not left to the server
 *
 * A plan has a price per billing cycle, currency and tier band, so "move to Premium" does not say what
 * the school will pay. This panel used to send `plan_id` alone, and `selectPrice()` then took the new
 * plan's default price on *any* cycle — a school billed yearly was moved onto a monthly price, its
 * current period prorated against the old cycle and the new one written over it. The service now
 * keeps the subscription's cycle when no price is named, and refuses when the plan has none on it;
 * this panel goes one further and always names one.
 *
 * So the Price select is required, lists the chosen plan's prices the API will accept
 * (`offerablePrices()`), and preselects the one that bills on the subscription's own cycle — among
 * those, the tier band that holds the school's quantity, then the plan's default. A price on another
 * recurring cycle can still be chosen, because moving a school to yearly billing is a real request, and
 * what that does is said before the button is pressed. A price in another currency, or one that would
 * switch between one-time and recurring, is not listed: the service refuses both, and the hint says
 * how many were left out. No amount is shown, for the reason `subscriptions/new` gives: which of a
 * price row's four amount columns is charged is `pricingColumns()`'s decision, not this dropdown's.
 *
 * ## The proration figures are rendered from the response, not from the message
 *
 * `changePlanTo()` puts them in the toast message *and* in `change.proration`. `apiClient` unwraps
 * the envelope's `data` and drops `message`, so the figures are read from the object — which is the
 * better source anyway: `prorationDue`, `creditApplied` and `amountDue` are three numbers an
 * operator may have to reconcile against an invoice, and a sentence is not a place to reconcile
 * from. `creditBalance`, what carries forward, is the fourth — and on an immediate downgrade it is
 * usually the whole outcome, so it is shown too.
 *
 * `change.invoice` names the invoice raised for `amountDue`. For a long time there was none: the
 * panel said "X due" and nothing ever billed X, because `generateForSubscription()` bills the items at
 * full price and refuses a second invoice for a period already billed. The line below says which
 * invoice, or that none was raised — never "due" on its own.
 *
 * ## A scheduled downgrade is not an applied one
 *
 * `change.applied` is false when the timing was `next_billing_cycle`: the school keeps its current
 * plan, `scheduled_plan_id` is set, and the change lands at renewal. The panel says that, because
 * the plan named at the top of the screen is then *not* the plan the school will be on next cycle —
 * the same fact the list screen marks with "change scheduled".
 *
 * Only one change can wait at a time — the `scheduled_*` columns are one group. An immediate change
 * clears it and a second scheduled downgrade overwrites it, and neither says so in its response, so
 * the panel says it before the button is pressed. A one-time subscription has no next cycle for a
 * change to wait for: the API refuses a scheduled downgrade on one, and the timing is not offered.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { rowError, splitApiErrors } from '@/lib/formErrors';
import { formatCodeWithAmount } from '@/lib/money';
import { useCollection } from '@/lib/useCollection';
import {
  Field,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
} from '@/components/form';
import { useToast } from '@/components/toast';

import { cycleLabel, howToBringIntoUse, humanise, sameCycle } from './detail';
import type { SubscriptionCatalogue, SubscriptionDetail } from './detail';

/**
 * One `plan_prices` row as `GET /plans` includes it: the columns `checkPriceSet()` treats as a price's
 * identity — cycle, days, model and tier band — plus its currency and two flags. No amount; see the
 * header.
 */
interface PlanPriceOption {
  id: number;
  billing_cycle: string;
  cycle_days: number | null;
  pricing_model: string;
  currency: string;
  tier_min_units: number | null;
  tier_max_units: number | null;
  is_active: boolean;
  is_default: boolean;
}

/** One row of `GET /plans`. `plans.service.list()` loads `DETAIL_INCLUDE`, so each carries its prices. */
interface PlanOption {
  id: number;
  name: string;
  code: string;
  status: string;
  tier_rank: number;
  prices?: PlanPriceOption[] | null;
}

/** The invoice an immediate change raised for its `amountDue`, as `changePlan()` returns it. */
interface ProrationInvoice {
  id: number;
  invoice_number: string;
  total: number | string;
  /** `DATEONLY` — a calendar date with no instant behind it, so it is printed, never parsed. */
  due_date: string | null;
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
      /** What is left on `credit_balance` afterwards. */
      creditBalance: number;
    } | null;
    /**
     * `null` on an immediate change that owed nothing; absent on a scheduled one, which bills nothing
     * until the renewal it waits for.
     */
    invoice?: ProrationInvoice | null;
  };
}

/** The fields this form has an input for. A 422 naming anything else goes to the banner. */
const FORM_FIELDS = new Set(['plan_id', 'plan_price_id', 'timing', 'quantity', 'reason']);

/** `101+ units`, `up to 100 units`, `101–500 units` — or nothing, for a row that is not banded. */
function bandLabel(price: PlanPriceOption): string {
  const min = price.tier_min_units ?? null;
  const max = price.tier_max_units ?? null;
  if (min === null && max === null) return '';
  if (max === null) return `${min}+ units`;
  if (min === null) return `up to ${max} units`;
  return `${min}–${max} units`;
}

/** Whether a quantity falls inside a price's band. An unbanded row holds every quantity. */
function inBand(price: PlanPriceOption, quantity: number): boolean {
  const min = price.tier_min_units ?? null;
  const max = price.tier_max_units ?? null;
  return (min === null || quantity >= Number(min)) && (max === null || quantity <= Number(max));
}

/** Active prices only: `selectPrice()` refuses a withdrawn one named explicitly. */
function activePrices(plan: PlanOption | null): PlanPriceOption[] {
  return (plan?.prices ?? []).filter((price) => price.is_active);
}

/**
 * The prices a plan change can move this subscription onto — what the API accepts, and nothing it
 * refuses. Active; in the subscription's own currency (`PLAN_PRICE_CURRENCY_MISMATCH`: its credit and
 * proration are amounts in that currency and nothing converts them); and one-time only when the
 * subscription is (`PLAN_PRICE_CYCLE_KIND_MISMATCH`: a one-time period has nothing to prorate, and a
 * one-time subscription is never renewed onto a recurring price). Another recurring cycle is offered —
 * the remainder of the period is charged at the new price's daily rate.
 */
function offerablePrices(plan: PlanOption | null, subscription: SubscriptionDetail): PlanPriceOption[] {
  const oneTime = subscription.billing_cycle === 'one_time';
  return activePrices(plan).filter(
    (price) =>
      price.currency === subscription.currency && (price.billing_cycle === 'one_time') === oneTime
  );
}

/**
 * The price to preselect for a plan — see the header. Empty when no active price bills on the
 * subscription's own cycle and currency: the operator then chooses, and the hint says why.
 */
function preselect(
  prices: PlanPriceOption[],
  subscription: SubscriptionDetail,
  quantity: number
): string {
  const matching = prices.filter(
    (price) => price.currency === subscription.currency && sameCycle(price, subscription)
  );
  const banded = matching.filter((price) => inBand(price, quantity));
  const pool = banded.length > 0 ? banded : matching;
  const pick = pool.find((price) => price.is_default) ?? pool[0];
  return pick ? String(pick.id) : '';
}

/** One option's text, built as one string — an `<option>` renders text and nothing else. */
function priceOptionLabel(price: PlanPriceOption): string {
  const band = bandLabel(price);
  return [
    cycleLabel(price),
    humanise(price.pricing_model),
    price.currency,
    ...(band ? [band] : []),
    ...(price.is_default ? ['default'] : []),
  ].join(' · ');
}

export function PlanChangePanel({
  subscription,
  catalogue,
  canChange,
  onChanged,
}: {
  subscription: SubscriptionDetail;
  /** For §12.4's two timings and for what brings an unusable subscription back into use. */
  catalogue: SubscriptionCatalogue | null;
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
  const [priceId, setPriceId] = useState('');
  const [timing, setTiming] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<ChangeResponse['change'] | null>(null);

  const currentRank = subscription.plan ? Number(subscription.plan.tier_rank) : 0;
  const { isRecurring, isUsable, hasScheduledChange } = subscription.standing;

  const chosen = useMemo(
    () => plans.rows.find((plan) => String(plan.id) === planId) ?? null,
    [plans.rows, planId]
  );
  const prices = useMemo(() => offerablePrices(chosen, subscription), [chosen, subscription]);
  /* Active prices left out because the API would refuse them — said in the hint, not hidden. */
  const withheld = activePrices(chosen).length - prices.length;
  const chosenPrice = prices.find((price) => String(price.id) === priceId) ?? null;

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

  /*
   * Both timings, unless there is no next cycle to wait for. `renew()` refuses a one-time
   * subscription and the sweep never renews one, so a change scheduled for its "next billing cycle"
   * could never land — the service now refuses it, and offering it would be offering that refusal.
   */
  const timings = (catalogue?.downgradeTimings ?? []).filter(
    (value) => isRecurring || value !== 'next_billing_cycle'
  );
  const deferred = direction === 'downgrade' && timing === 'next_billing_cycle';

  /* Every offered price is already in the subscription's currency; only the cycle can differ. */
  const noMatchingPrice = prices.length > 0 && !prices.some((price) => sameCycle(price, subscription));
  const cycleChanges = chosenPrice !== null && !sameCycle(chosenPrice, subscription);

  /*
   * A price override on `cycle_amount` — owner decision D7. While it applies, invoices bill the plan
   * line at the override's amount for every period that starts inside its window, so the new plan's
   * price is not what the school pays. The unique index allows one per subscription; `is_effective`
   * is the service's own reading of the window, never re-derived here.
   */
  const priceOverride =
    subscription.overrides.find((row) => row.override_type === 'price' && row.is_active) ?? null;

  /* The server keys errors by body field; the inputs carry prefixed ids, so the label is put in here. */
  const errorFor = (field: string, label: string) => rowError(fieldErrors, field, label);

  function choosePlan(value: string) {
    setPlanId(value);
    setTiming('');
    const plan = plans.rows.find((row) => String(row.id) === value) ?? null;
    const typed = Number(quantity.trim());
    setPriceId(
      preselect(
        offerablePrices(plan, subscription),
        subscription,
        quantity.trim() && Number.isFinite(typed) ? typed : subscription.quantity
      )
    );
  }

  async function submit() {
    if (!chosen || !chosenPrice || !direction || busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const body: Record<string, unknown> = { plan_id: chosen.id, plan_price_id: chosenPrice.id };
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
      setPriceId('');
      setTiming('');
      setQuantity('');
      setReason('');
      success(
        result.change.applied
          ? `${humanise(direction)}d to ${result.change.toPlan.name}`
          : `Downgrade to ${result.change.toPlan.name} scheduled`
      );
    } catch (caught) {
      if (caught instanceof ApiError) {
        const { perField, banner } = splitApiErrors(caught, FORM_FIELDS);
        setFieldErrors(perField);
        setError(banner);
        if (Object.keys(perField).length) focusFirstInvalidField();
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
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

  /*
   * Both routes refuse a subscription outside the usable states, so the form is not offered on one.
   * What to do instead depends on the state — see `howToBringIntoUse()`.
   */
  if (!isUsable) {
    return (
      <Notice tone="info">
        A {humanise(subscription.state).toLowerCase()} subscription cannot change plan — an upgrade or
        downgrade needs one that is in use. {howToBringIntoUse(catalogue, subscription.state)}
      </Notice>
    );
  }

  return (
    <FormSection
      title="Change plan"
      description={
        isRecurring
          ? 'An upgrade takes effect immediately with proration; a downgrade may be applied now or held until the end of the billing cycle.'
          : 'A one-time subscription changes plan immediately. It has no billing period to prorate and no next cycle to wait for.'
      }
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
                {formatCodeWithAmount(outcome.currency, outcome.newCycleAmount)}
                {isRecurring ? ' per cycle' : ''}.
                {priceOverride ? (
                  <>
                    {' '}
                    A price override of{' '}
                    {formatCodeWithAmount(subscription.currency, priceOverride.amount)}{' '}
                    {priceOverride.is_effective ? 'is in effect' : 'is set, outside its window today'},
                    so invoices bill the plan line at that amount instead while it applies.
                  </>
                ) : null}
                {outcome.proration ? (
                  <>
                    {' '}
                    {formatCodeWithAmount(outcome.currency, outcome.proration.prorationDue)} for the
                    remaining {outcome.proration.remainingDays} day(s) at the new price,{' '}
                    {formatCodeWithAmount(outcome.currency, outcome.proration.creditApplied)} of
                    credit put towards it,{' '}
                    {formatCodeWithAmount(outcome.currency, outcome.proration.amountDue)} left to pay.
                    {outcome.invoice ? (
                      <>
                        {' '}
                        Invoiced as <strong>{outcome.invoice.invoice_number}</strong> —{' '}
                        {formatCodeWithAmount(outcome.currency, outcome.invoice.total)}
                        {outcome.invoice.due_date
                          ? `, due ${String(outcome.invoice.due_date).slice(0, 10)}`
                          : ''}{' '}
                        — on the{' '}
                        <Link
                          href="/super-admin/invoices"
                          className="font-medium underline underline-offset-2"
                        >
                          Invoices
                        </Link>{' '}
                        screen.
                      </>
                    ) : outcome.proration.amountDue > 0 ? (
                      <> No invoice was raised for it.</>
                    ) : null}
                    {outcome.proration.creditBalance > 0 ? (
                      <>
                        {' '}
                        {formatCodeWithAmount(outcome.currency, outcome.proration.creditBalance)} of
                        credit carries forward to the next renewal or change.
                      </>
                    ) : null}
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

        {/*
          * A refusal as well as a failure. `/plans` needs `plans.view`, a different key from the
          * `subscriptions.lifecycle` that opened this panel, and `useCollection` files a missing
          * permission under `refusal` rather than `error` — so checking `error` alone left an account
          * without it looking at an empty dropdown and no reason.
          */}
        {plans.refusal ? (
          <Notice tone="warn">
            This account cannot read the plan catalogue, so there is no plan to offer:{' '}
            {plans.refusal.message}
          </Notice>
        ) : plans.error ? (
          <Notice tone="error">The plan catalogue could not be loaded: {plans.error}</Notice>
        ) : null}

        <SelectField
          id="change-plan"
          label="New plan"
          required
          value={planId}
          error={errorFor('plan_id', 'New plan')}
          onChange={(event) => choosePlan(event.target.value)}
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
            an upgrade nor a downgrade, and both would be refused. Pick a plan on a different tier, or
            change the tier ranks in the plan catalogue if these two are genuinely ranked wrongly.
          </Notice>
        ) : direction === 'upgrade' ? (
          <Notice tone="info">
            Higher tier than the current plan, so this is an <strong>upgrade</strong>.{' '}
            {isRecurring
              ? 'It applies immediately: the rest of the current period is prorated at the new price, any credit on the subscription is put towards it, and what is left to pay is invoiced at once.'
              : 'It applies immediately. A one-time subscription has no period to prorate, so the change itself raises no charge.'}
          </Notice>
        ) : direction === 'downgrade' ? (
          <Notice tone="info">
            Lower tier than the current plan, so this is a <strong>downgrade</strong>, and it needs a
            timing choice below.
          </Notice>
        ) : null}

        {direction ? (
          prices.length === 0 ? (
            <Notice tone="warn">
              {withheld > 0 ? (
                <>
                  None of <strong>{chosen?.name}</strong>’s {withheld} active price(s) can take this
                  subscription: a plan change keeps the subscription’s currency ({subscription.currency})
                  and {isRecurring ? 'cannot move it onto a one-time price' : 'cannot move a one-time subscription onto a recurring price'}.
                  Price the plan to match on the Plans screen first.
                </>
              ) : (
                <>
                  <strong>{chosen?.name}</strong> has no active price, so the API refuses a change to
                  it. It has to be priced on the Plans screen first.
                </>
              )}
            </Notice>
          ) : (
            <SelectField
              id="change-price"
              label="Price"
              required
              value={priceId}
              error={errorFor('plan_price_id', 'Price')}
              onChange={(event) => setPriceId(event.target.value)}
              hint={`${
                noMatchingPrice
                  ? `None of this plan’s prices bills ${cycleLabel(subscription).toLowerCase()}, as the subscription does today — whichever is chosen changes its cycle.`
                  : `The price billing ${cycleLabel(subscription).toLowerCase()} in ${subscription.currency}, as the subscription does today, is chosen for you. A tier band is the number of units the price applies to.`
              }${
                withheld > 0
                  ? ` ${withheld} other price(s) are not listed: a plan change keeps the subscription’s currency${isRecurring ? ' and cannot move it onto a one-time price' : ' and a one-time subscription stays one-time'}.`
                  : ''
              }`}
            >
              <option value="">Choose a price…</option>
              {prices.map((price) => (
                <option key={price.id} value={price.id}>
                  {priceOptionLabel(price)}
                </option>
              ))}
            </SelectField>
          )
        ) : null}

        {/*
          * Allowed, and said. A school moving to yearly billing is a real request, but the cycle is not
          * visible in the plan name and it changes what every later invoice says. (A change of
          * currency is not offered at all — see `offerablePrices()`.)
          */}
        {chosenPrice && cycleChanges ? (
          <Notice tone="warn">
            This price bills <strong>{cycleLabel(chosenPrice).toLowerCase()}</strong>; the subscription
            bills {cycleLabel(subscription).toLowerCase()} today.{' '}
            {direction === 'downgrade' && timing === ''
              ? 'The school moves onto the new cycle at its next renewal.'
              : deferred
                ? 'The new cycle starts with the renewal this downgrade waits for.'
                : 'The current period keeps its end date, and the days left in it are charged at this price’s daily rate — its cycle amount spread over its own cycle’s length. The new cycle starts at the next renewal.'}
          </Notice>
        ) : null}

        {direction === 'downgrade' ? (
          <SelectField
            id="change-timing"
            label="When it takes effect"
            required
            value={timing}
            error={errorFor('timing', 'When it takes effect')}
            onChange={(event) => setTiming(event.target.value)}
            hint={
              isRecurring
                ? 'Immediate can drop a limit below what the school is already using — an over-limit school keeps what it has but cannot add more. Next billing cycle leaves everything in place until the period ends.'
                : 'A one-time subscription has no next billing cycle for a downgrade to wait for, so only an immediate one is offered. It can drop a limit below what the school is already using.'
            }
          >
            <option value="">Choose…</option>
            {timings.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </SelectField>
        ) : null}

        {/*
          * One change can wait at a time. An immediate change clears the scheduled one and a second
          * scheduled downgrade overwrites it; the response says neither, so it is said here.
          */}
        {direction && hasScheduledChange ? (
          <Notice tone="warn">
            A downgrade to{' '}
            <strong>{subscription.scheduledPlan ? subscription.scheduledPlan.name : 'another plan'}</strong>{' '}
            is already scheduled for the end of this cycle.{' '}
            {direction === 'downgrade' && timing === ''
              ? 'Changing plan now cancels it; scheduling this downgrade instead replaces it.'
              : deferred
                ? 'Scheduling this downgrade replaces it.'
                : 'Changing plan now cancels it.'}
          </Notice>
        ) : null}

        {direction && priceOverride ? (
          <Notice tone="warn">
            This subscription carries a price override of{' '}
            {formatCodeWithAmount(subscription.currency, priceOverride.amount)}
            {priceOverride.is_effective ? ', in effect now' : ', outside its window today'}. Invoices
            for billing periods that start while it is in effect bill the plan line at that amount,
            whatever the new plan costs — revoke or replace it on the Overrides tab if the change
            should alter what the school pays. An immediate change’s proration is still worked out
            from the plan prices.
          </Notice>
        ) : null}

        <Field
          id="change-quantity"
          label="Quantity"
          type="number"
          min={1}
          value={quantity}
          error={errorFor('quantity', 'Quantity')}
          onChange={(event) => setQuantity(event.target.value)}
          hint={`Leave blank to keep the current ${subscription.quantity}. Only per-unit pricing models bill from it.`}
        />

        <TextAreaField
          id="change-reason"
          label="Reason"
          rows={2}
          maxLength={255}
          value={reason}
          error={errorFor('reason', 'Reason')}
          onChange={(event) => setReason(event.target.value)}
          hint="Up to 255 characters. Recorded in the audit trail and on the subscription history row."
        />

        <SubmitButton
          busy={busy}
          busyLabel={direction === 'downgrade' ? 'Downgrading…' : 'Upgrading…'}
          fullWidth={false}
          disabled={!direction || !chosenPrice || (direction === 'downgrade' && timing === '')}
        >
          {direction === 'downgrade' ? 'Downgrade' : 'Upgrade'}
        </SubmitButton>
      </form>
    </FormSection>
  );
}
