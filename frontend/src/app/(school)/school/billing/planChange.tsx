'use client';

/**
 * Changing the school's plan — FR-SUB-013 (§12.3 Upgrade) and FR-SUB-014 (§12.4 Downgrade), whose
 * actor lines name the School.
 *
 * `POST /subscriptions/:id/upgrade` and `/downgrade` on `subscriptions.self.manage`, from the plans
 * `GET /plans` returns to a school on `plans.view` — the active public ones, `plans.service.scopeFor()`
 * — with their prices. Both bodies are `subscriptions.validation.js` `planChange`: `plan_id` required,
 * `plan_price_id`, `quantity` and `reason` optional, and a downgrade's `timing` required with no
 * default.
 *
 * ## The direction is a fact about the two plans
 *
 * `changePlan()` classifies the change from the plans' `tier_rank` and refuses a request on the wrong
 * route, and a same-tier move on either. So the school picks a plan and the panel picks the route —
 * higher tier, upgrade; lower, downgrade with the §12.4 timing choice — and says which before anything
 * is sent. Same-tier plans are left out, with a count, rather than offered as a choice that can only be
 * refused. `tier_rank` is compared to choose an HTTP route and for nothing else (§30 Rule 1).
 *
 * ## The price is chosen, and its terms are shown
 *
 * A plan has a price per cycle, currency and band, so "move to Premium" does not say what the school
 * will pay; the select always names one, preselecting the price on the subscription's own cycle. What
 * each option shows is the price row's **terms** — the amount a Fixed price charges, a unit rate and
 * what it applies beyond — never a worked-out cycle amount: which of a row's amounts is charged, over
 * what count, is `subscriptions.service.computeCycleAmount()`'s decision, and the response's
 * `newCycleAmount` is shown after the change. The overage rate a row may carry is not shown (D26 hides
 * the unused one, and it is not a charge for the plan itself).
 *
 * Prices in another currency are not offered, and the hint says how many were left out: a plan change
 * keeps the subscription's currency — the owner's decision D22 confirmed the refusal
 * (`PLAN_PRICE_CURRENCY_MISMATCH`), because credit and proration are amounts that nothing converts.
 * A price that would switch between one-time and recurring is left out for the same reason the API
 * refuses it (`PLAN_PRICE_CYCLE_KIND_MISMATCH`).
 *
 * ## What the change costs is the response's, not this panel's
 *
 * An immediate change prorates the rest of the period at the new price, puts any credit towards it,
 * and invoices what is left in the same transaction (`change.proration`, `change.invoice`). **During a
 * trial nothing is prorated** — §12.3's remaining credit is credit from a paid plan, and a trial paid
 * for nothing (verify-subscriptions C4) — so the figures are zero and no invoice is raised; the first
 * invoice, when the trial ends, bills the new plan. The panel says so before the change and shows the
 * figures after it, and a refusal is shown in the API's own words.
 *
 * ## The quantity
 *
 * The owner's decision D26: a Per-Student or Student-Based price bills the school's active students,
 * counted when the change is made, whatever is typed — so no box is offered for one. A Seat-Based price
 * bills the seats on the subscription, and a box is offered, blank meaning "keep the current number".
 * A Fixed or Custom price does not use it.
 */

import Link from 'next/link';
import { useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { rowError, splitApiErrors } from '@/lib/formErrors';
import { formatCodeWithAmount } from '@/lib/money';
import { useCollection } from '@/lib/useCollection';
import {
  Field,
  FormSection,
  Notice,
  RadioGroupField,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
} from '@/components/form';
import { ConfirmDialog } from '@/components/overlay';
import { EmptyNotice, ErrorNotice, LoadingBlock, RefusalNotice } from '@/components/table';
import { useToast } from '@/components/toast';

import { calendarDay, cycleLabel, formatCount, humanise, sameCycle, utcDay } from './billing';
import type { OwnSubscription, OwnSubscriptionScope, SubscriptionVocabulary } from './billing';

/** One `plan_prices` row as `GET /plans` includes it, narrowed to the terms shown. */
interface PlanPriceOption {
  id: number;
  billing_cycle: string;
  cycle_days: number | null;
  pricing_model: string;
  currency: string;
  base_amount: number | string;
  unit_amount: number | string;
  included_units: number;
  custom_amount: number | string | null;
  tier_min_units: number | null;
  tier_max_units: number | null;
  is_active: boolean;
  is_default: boolean;
}

/** One row of `GET /plans`. `plans.service.list()` loads `DETAIL_INCLUDE`, so each carries its prices. */
interface PlanOption {
  id: number;
  name: string;
  description: string | null;
  tier_rank: number;
  is_recommended: boolean;
  prices?: PlanPriceOption[] | null;
}

/** `change` in the upgrade and downgrade responses — `subscriptions.service.changePlan()`. */
interface ChangeOutcome {
  direction: string;
  timing: string;
  applied: boolean;
  effectiveAt: string | null;
  currency: string;
  newCycleAmount: number;
  toPlan: { id: number; name: string };
  /** Absent on a scheduled downgrade, which bills nothing until the renewal it waits for. */
  proration?: {
    remainingDays: number;
    prorationDue: number;
    creditApplied: number;
    amountDue: number;
    creditBalance: number;
  } | null;
  /** The invoice raised for `amountDue`; null when nothing was owed. */
  invoice?: { id: number; invoice_number: string; total: number | string; due_date: string | null } | null;
}

interface ChangeResponse {
  subscription: OwnSubscription;
  change: ChangeOutcome;
}

/** The fields this form has an input for. A 422 naming anything else goes to the banner. */
const FORM_FIELDS = new Set(['plan_id', 'plan_price_id', 'timing', 'quantity', 'reason']);

/** The two models D26 counts students for. */
const COUNTED = ['per_student', 'student_based'];

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

/**
 * A price row's terms, in the words of §10.4's models: Fixed charges `base_amount`; Custom charges
 * `custom_amount`; the three unit models charge `base_amount` plus `unit_amount` for each unit beyond
 * `included_units`. The terms only — see the header on why no cycle amount is worked out here.
 */
function priceTerms(price: PlanPriceOption): string {
  const money = (value: number | string | null) => formatCodeWithAmount(price.currency, value);
  if (price.pricing_model === 'fixed') return `${money(price.base_amount)} per billing period`;
  if (price.pricing_model === 'custom') return `${money(price.custom_amount)} per billing period (custom price)`;

  const unit = price.pricing_model === 'seat_based' ? 'seat' : 'student';
  const included = Number(price.included_units) || 0;
  const rate = `${money(price.unit_amount)} per ${unit}${included > 0 ? ` beyond the first ${formatCount(included)}` : ''}`;
  return Number(price.base_amount) > 0 ? `${money(price.base_amount)} + ${rate}` : rate;
}

/** One option's text, built as one string — an `<option>` renders text and nothing else. */
function priceOptionLabel(price: PlanPriceOption): string {
  const band = bandLabel(price);
  return [
    cycleLabel(price),
    humanise(price.pricing_model),
    priceTerms(price),
    ...(band ? [band] : []),
    ...(price.is_default ? ['default'] : []),
  ].join(' · ');
}

/**
 * The prices this subscription can move onto: active (a withdrawn one is refused), in its own
 * currency (D22), and one-time only when it is.
 */
function offerablePrices(plan: PlanOption | null, subscription: OwnSubscription): PlanPriceOption[] {
  const oneTime = subscription.billing_cycle === 'one_time';
  return (plan?.prices ?? []).filter(
    (price) =>
      price.is_active
      && price.currency === subscription.currency
      && (price.billing_cycle === 'one_time') === oneTime
  );
}

/** The price to preselect: on the subscription's own cycle, then in its band, then the plan's default. */
function preselect(prices: PlanPriceOption[], subscription: OwnSubscription): string {
  const matching = prices.filter((price) => sameCycle(price, subscription));
  const banded = matching.filter((price) => inBand(price, subscription.quantity));
  const pool = banded.length > 0 ? banded : matching;
  const pick = pool.find((price) => price.is_default) ?? pool[0];
  return pick ? String(pick.id) : '';
}

/** What brings an unusable subscription back into use — for a school, which of these it can do. */
function bringIntoUse(state: string): string {
  if (state === 'pending') return 'It starts once its first invoice is paid and that payment approved.';
  if (state === 'expired') return 'It is reactivated when a payment that settles an invoice in full is approved.';
  return 'Only the platform administrator can bring it back into use.';
}

/* ─────────────────────────────── the form ─────────────────────────────── */

function PlanChangeForm({
  subscription,
  vocabulary,
  canSeeInvoices,
  onChanged,
}: {
  subscription: OwnSubscription;
  vocabulary: SubscriptionVocabulary | null;
  canSeeInvoices: boolean;
  onChanged: (subscription: OwnSubscription) => void;
}) {
  const { success } = useToast();

  /*
   * `status: 'active'` is already the school's scope — `scopeFor()` confines a non-platform caller to
   * active public plans — and is sent anyway so the request says what it wants. One page of a hundred
   * is the whole catalogue.
   */
  const plans = useCollection<PlanOption>('/plans', { limit: 100, status: 'active' });

  const [planId, setPlanId] = useState('');
  const [priceId, setPriceId] = useState('');
  const [timing, setTiming] = useState('');
  const [seats, setSeats] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);

  const { isRecurring, hasScheduledChange } = subscription.standing;
  const inTrial = subscription.state === 'trial';
  const currentRank = subscription.plan ? Number(subscription.plan.tier_rank) : 0;

  /* The current plan is not a choice, and a same-tier plan is refused on both routes — see the header. */
  const others = plans.rows.filter((plan) => plan.id !== subscription.plan_id);
  const choices = others.filter((plan) => Number(plan.tier_rank) !== currentRank);
  const sameTierCount = others.length - choices.length;

  const chosen = choices.find((plan) => String(plan.id) === planId) ?? null;
  const direction: 'upgrade' | 'downgrade' | null = !chosen
    ? null
    : Number(chosen.tier_rank) > currentRank
      ? 'upgrade'
      : 'downgrade';

  const prices = offerablePrices(chosen, subscription);
  const activeCount = (chosen?.prices ?? []).filter((price) => price.is_active).length;
  const otherCurrency = (chosen?.prices ?? []).filter(
    (price) => price.is_active && price.currency !== subscription.currency
  ).length;
  const otherKind = activeCount - prices.length - otherCurrency;
  const chosenPrice = prices.find((price) => String(price.id) === priceId) ?? null;

  /*
   * §12.4's two timings, from the catalogue rather than written out here — it arrives with the
   * subscription, so it is always present by the time this form renders. A one-time subscription has
   * no next cycle for a change to wait for, and the API refuses one scheduled for it.
   */
  const timings = (vocabulary?.downgradeTimings ?? []).filter(
    (value) => isRecurring || value !== 'next_billing_cycle'
  );
  const deferred = direction === 'downgrade' && timing === 'next_billing_cycle';
  const cycleChanges = chosenPrice !== null && !sameCycle(chosenPrice, subscription);

  /* D7 — a negotiated price in effect bills the plan line whatever the new plan costs. */
  const priceOverride = subscription.overrides.find(
    (row) => row.override_type === 'price' && row.is_active && row.is_effective
  );

  const errorFor = (field: string, label: string) => rowError(fieldErrors, field, label);

  function choosePlan(value: string) {
    setPlanId(value);
    setTiming('');
    setSeats('');
    const plan = choices.find((row) => String(row.id) === value) ?? null;
    setPriceId(preselect(offerablePrices(plan, subscription), subscription));
  }

  /** What pressing the button will do, said in the confirmation before it is done. */
  function consequence(): string {
    if (!chosen) return '';
    if (deferred) {
      const end = utcDay(subscription.current_period_end);
      return `Your school keeps ${subscription.plan?.name ?? 'its current plan'} until the end of this billing period${end ? ` (${end})` : ''} and moves to ${chosen.name} at the renewal that starts the next one. Nothing is charged now.`;
    }
    if (inTrial) {
      return `Your school moves to ${chosen.name} now. Nothing is prorated or invoiced during the trial — the first invoice, when the trial ends, bills the new plan.`;
    }
    if (!isRecurring) {
      return `Your school moves to ${chosen.name} now. A one-time subscription has no billing period to prorate, so the change itself raises no charge.`;
    }
    return direction === 'upgrade'
      ? `Your school moves to ${chosen.name} now. The days left in this billing period are charged at the new price, any credit is put towards it, and what is left to pay is invoiced straight away.`
      : `Your school moves to ${chosen.name} now, and its limits apply at once — a school already over one keeps what it has but cannot add more. The rest of this billing period is recalculated at the new price; what is not used becomes credit.`;
  }

  function requestChange() {
    if (!chosen || !chosenPrice || !direction || busy) return;
    if (direction === 'downgrade' && !timing) {
      setFieldErrors({ timing: 'Choose when the downgrade takes effect.' });
      focusFirstInvalidField();
      return;
    }
    setError(null);
    setFieldErrors({});
    setConfirming(true);
  }

  async function change() {
    if (!chosen || !chosenPrice || !direction || busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const body: Record<string, unknown> = { plan_id: chosen.id, plan_price_id: chosenPrice.id };
      if (direction === 'downgrade') body.timing = timing;
      /* Only a Seat-Based price reads it; blank keeps the subscription's own number (see the header). */
      if (chosenPrice.pricing_model === 'seat_based' && seats.trim()) body.quantity = seats.trim();
      if (reason.trim()) body.reason = reason.trim();

      /*
       * Both routes written out rather than one path built from `direction`: `verify-frontend.js`
       * collects `api.<method>(` followed by a path literal, and an interpolated verb would hide both
       * FR-SUB-013 and FR-SUB-014 from it.
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
      setSeats('');
      setReason('');
      success(
        result.change.applied
          ? `${direction === 'upgrade' ? 'Upgraded' : 'Downgraded'} to ${result.change.toPlan.name}`
          : `Downgrade to ${result.change.toPlan.name} scheduled`
      );
    } catch (caught) {
      /*
       * Every refusal these routes give is a sentence written for the reader — another currency (D22),
       * a subscription not in use, a plan withdrawn meanwhile, the same tier — so it is shown as it came.
       */
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

  const invoiceLink = (invoice: NonNullable<ChangeOutcome['invoice']>) =>
    canSeeInvoices ? (
      <Link href={`/school/billing/invoices/${invoice.id}`} className="font-medium underline underline-offset-2">
        {invoice.invoice_number}
      </Link>
    ) : (
      <strong>{invoice.invoice_number}</strong>
    );

  return (
    <FormSection
      title="Change plan"
      description={
        isRecurring
          ? 'An upgrade takes effect straight away, with the rest of this billing period prorated. A downgrade can take effect now or at the end of the period.'
          : 'A one-time subscription changes plan straight away. It has no billing period to prorate and no next period to wait for.'
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          requestChange();
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}

        {/* The last change's figures, kept after the form clears: a proration shown once and gone cannot be checked. */}
        {outcome ? (
          <Notice tone="success">
            {outcome.applied ? (
              <>
                Now on <strong>{outcome.toPlan.name}</strong> at{' '}
                {formatCodeWithAmount(outcome.currency, outcome.newCycleAmount)}
                {isRecurring ? ' per billing period' : ''}.
                {outcome.proration && outcome.proration.prorationDue > 0 ? (
                  <>
                    {' '}
                    {formatCodeWithAmount(outcome.currency, outcome.proration.prorationDue)} for the remaining{' '}
                    {outcome.proration.remainingDays} day(s) at the new price,{' '}
                    {formatCodeWithAmount(outcome.currency, outcome.proration.creditApplied)} of credit put
                    towards it, {formatCodeWithAmount(outcome.currency, outcome.proration.amountDue)} left to pay.
                  </>
                ) : outcome.proration ? (
                  <> Nothing was prorated{inTrial ? ', because your school is in its trial' : ''}.</>
                ) : null}
                {outcome.invoice ? (
                  <>
                    {' '}
                    Invoiced as {invoiceLink(outcome.invoice)} —{' '}
                    {formatCodeWithAmount(outcome.currency, outcome.invoice.total)}
                    {outcome.invoice.due_date ? `, due ${calendarDay(outcome.invoice.due_date)}` : ''}.
                  </>
                ) : outcome.proration && outcome.proration.amountDue > 0 ? (
                  <> No invoice was raised for it.</>
                ) : null}
                {outcome.proration && outcome.proration.creditBalance > 0 ? (
                  <>
                    {' '}
                    {formatCodeWithAmount(outcome.currency, outcome.proration.creditBalance)} of credit carries
                    forward to the next invoice or change.
                  </>
                ) : null}
              </>
            ) : (
              <>
                Downgrade to <strong>{outcome.toPlan.name}</strong> scheduled for the end of the current
                billing period{utcDay(outcome.effectiveAt) ? ` (${utcDay(outcome.effectiveAt)})` : ''}. Your
                school keeps its current plan until then.
              </>
            )}
          </Notice>
        ) : null}

        {inTrial ? (
          <Notice tone="info">
            Your school is in its trial, so a change made now is not prorated and raises no invoice — trial
            days are not billed, and the first invoice, when the trial ends, bills the plan you are on then.
          </Notice>
        ) : null}

        {plans.refusal ? (
          <RefusalNotice refusal={plans.refusal} />
        ) : plans.error ? (
          <Notice tone="error">The plans could not be loaded: {plans.error}</Notice>
        ) : plans.loading && plans.rows.length === 0 ? (
          <LoadingBlock rows={3} label="Loading the plans…" />
        ) : choices.length === 0 ? (
          <EmptyNotice icon="layers" title="No other plan to move to">
            {sameTierCount > 0
              ? `The ${sameTierCount} other plan(s) on offer are on the same tier as yours, and a move between plans of one tier is neither an upgrade nor a downgrade.`
              : 'No other plan is on offer at the moment.'}
          </EmptyNotice>
        ) : (
          <>
            <RadioGroupField
              name="plan_id"
              legend={`Move from ${subscription.plan?.name ?? 'your plan'} to`}
              value={planId}
              onChange={choosePlan}
              error={errorFor('plan_id', 'Plan')}
              hint={
                sameTierCount > 0
                  ? `${sameTierCount} plan(s) on the same tier as yours are not listed — a same-tier move is refused.`
                  : undefined
              }
              options={choices.map((plan) => ({
                value: String(plan.id),
                label: `${plan.name}${plan.is_recommended ? ' (recommended)' : ''}`,
                hint: `${Number(plan.tier_rank) > currentRank ? 'Higher tier — an upgrade' : 'Lower tier — a downgrade'}${
                  plan.description ? `. ${plan.description}` : ''
                }`,
              }))}
            />

            {chosen ? (
              prices.length === 0 ? (
                <Notice tone="warn">
                  {activeCount === 0
                    ? `${chosen.name} has no price on offer, so your school cannot move to it.`
                    : `None of ${chosen.name}’s prices can take your subscription: ${
                        otherCurrency > 0
                          ? `${otherCurrency} ${otherCurrency === 1 ? 'is' : 'are'} in another currency, and a plan change keeps your subscription’s ${subscription.currency}`
                          : ''
                      }${otherCurrency > 0 && otherKind > 0 ? '; ' : ''}${
                        otherKind > 0
                          ? isRecurring
                            ? `${otherKind} ${otherKind === 1 ? 'is' : 'are'} one-time, and a recurring subscription cannot move onto one`
                            : `${otherKind} ${otherKind === 1 ? 'is' : 'are'} recurring, and a one-time subscription stays one-time`
                          : ''
                      }.`}
                </Notice>
              ) : (
                <SelectField
                  id="change-price"
                  label="Price"
                  required
                  value={priceId}
                  error={errorFor('plan_price_id', 'Price')}
                  onChange={(event) => setPriceId(event.target.value)}
                  hint={`Only prices in ${subscription.currency}, your subscription’s currency, are listed — a plan change keeps the currency, and one in another is refused${
                    otherCurrency > 0 ? ` (${otherCurrency} left out)` : ''
                  }. Each shows the price’s terms; what one billing period comes to is worked out when the change is made.`}
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

            {chosenPrice && COUNTED.includes(chosenPrice.pricing_model) ? (
              <Notice tone="info">
                This price bills your school’s active students: they are counted when the change is made
                and again at every renewal.
              </Notice>
            ) : null}

            {chosenPrice && chosenPrice.pricing_model === 'seat_based' ? (
              <Field
                id="change-seats"
                label="Seats"
                type="number"
                min={1}
                value={seats}
                error={errorFor('quantity', 'Seats')}
                onChange={(event) => setSeats(event.target.value)}
                hint={`Leave blank to keep the current ${formatCount(subscription.quantity)}. A Seat-Based price bills this number.`}
              />
            ) : null}

            {chosenPrice && cycleChanges ? (
              <Notice tone="warn">
                This price bills <strong>{cycleLabel(chosenPrice).toLowerCase()}</strong>; your subscription
                bills {cycleLabel(subscription).toLowerCase()} today.{' '}
                {deferred
                  ? 'The new cycle starts with the renewal this downgrade waits for.'
                  : 'The current period keeps its end date, and the days left in it are charged at this price’s daily rate. The new cycle starts at the next renewal.'}
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
                    ? 'Immediate applies the lower plan’s limits now — a school already over one keeps what it has but cannot add more. Next billing cycle leaves everything as it is until the period ends.'
                    : 'A one-time subscription has no next billing period for a downgrade to wait for, so only an immediate one is offered.'
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

            {direction && hasScheduledChange ? (
              <Notice tone="warn">
                A move to {subscription.scheduledPlan ? subscription.scheduledPlan.name : 'another plan'} is
                already scheduled for the end of this period.{' '}
                {deferred ? 'Scheduling this downgrade replaces it.' : 'Changing plan now cancels it.'}
              </Notice>
            ) : null}

            {direction && priceOverride ? (
              <Notice tone="info">
                A negotiated price of {formatCodeWithAmount(subscription.currency, priceOverride.amount)} is in
                effect on your subscription, and invoices bill the plan at that amount while it applies —
                whatever the new plan costs.
              </Notice>
            ) : null}

            {direction ? (
              <TextAreaField
                id="change-reason"
                label="Reason"
                rows={2}
                maxLength={255}
                value={reason}
                error={errorFor('reason', 'Reason')}
                onChange={(event) => setReason(event.target.value)}
                hint="Optional, up to 255 characters. Kept with the subscription’s history."
              />
            ) : null}

            <SubmitButton
              busy={busy}
              busyLabel={direction === 'downgrade' ? 'Downgrading…' : 'Upgrading…'}
              fullWidth={false}
              disabled={!direction || !chosenPrice}
            >
              {direction === 'downgrade' ? 'Downgrade' : 'Upgrade'}
            </SubmitButton>
          </>
        )}
      </form>

      <ConfirmDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          setConfirming(false);
          await change();
        }}
        title={
          chosen
            ? deferred
              ? `Schedule the move to ${chosen.name}?`
              : `${direction === 'upgrade' ? 'Upgrade' : 'Downgrade'} to ${chosen.name}?`
            : 'Change plan?'
        }
        description={consequence()}
        confirmLabel={deferred ? 'Schedule downgrade' : direction === 'upgrade' ? 'Upgrade now' : 'Downgrade now'}
        tone="default"
      />
    </FormSection>
  );
}

/* ─────────────────────────────── the panel ─────────────────────────────── */

export function PlanChangePanel({
  scope,
  canChange,
  canReadPlans,
  canSeeInvoices,
}: {
  scope: OwnSubscriptionScope;
  /** `subscriptions.self.manage` — the key the two routes accept from a school. */
  canChange: boolean;
  /** `plans.view` — D27 granted it to Principal and School Admin so there is something to choose. */
  canReadPlans: boolean;
  canSeeInvoices: boolean;
}) {
  const { subscription, vocabulary, loading, error, refusal, reload, adopt } = scope;

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (error) return <ErrorNotice message={error} onRetry={reload} />;
  if (loading && !subscription) return <LoadingBlock rows={3} />;
  if (!subscription) {
    return (
      <EmptyNotice title="No subscription yet">
        There is no plan to change from. A platform administrator puts a school on its first plan.
      </EmptyNotice>
    );
  }
  if (!canChange) {
    return (
      <Notice tone="info">
        Changing the school’s plan needs the permission to change its subscription, which this account
        does not hold.
      </Notice>
    );
  }
  if (!canReadPlans) {
    return (
      <Notice tone="info">
        Choosing a new plan needs the permission to view plans, which this account does not hold.
      </Notice>
    );
  }
  /* Both routes refuse a subscription outside the usable states (`SUBSCRIPTION_NOT_CHANGEABLE`). */
  if (!subscription.standing.isUsable) {
    return (
      <Notice tone="info">
        A {humanise(subscription.state).toLowerCase()} subscription cannot change plan — an upgrade or a
        downgrade needs one in use. {bringIntoUse(subscription.state)}
      </Notice>
    );
  }

  return (
    <PlanChangeForm
      subscription={subscription}
      vocabulary={vocabulary}
      canSeeInvoices={canSeeInvoices}
      onChanged={adopt}
    />
  );
}
