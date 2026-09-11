'use client';

/**
 * The school's subscription, in words — SRS §12, FR-SUB-010's states as the school lives them.
 *
 * ## The state is explained, never re-derived
 *
 * `subscriptions.service.js` is explicit that the lifecycle state is written by the lifecycle sweep
 * and by the billing events the owner's decision D23 added, and *"read, never recomputed"* anywhere
 * else. So the badge shows the stored state and the sentence under it says what that state means for
 * this school — every clause of it a rule the service applies:
 *
 *  - **Trial** — trial days are not billed (D23): the sweep starts the first paid period when the trial
 *    ends and moves the subscription to Past Due until that period's invoice, issued by the D6 job, is
 *    paid (`runLifecycleSweep()` pass 1, then `settleArrears()`).
 *  - **Past Due / Grace Period** — an overdue invoice makes the subscription Past Due, and paying every
 *    overdue invoice returns it to Active (D23, `settleArrears()`), while its period is still running.
 *    FR-SUB-012's grace period is how long access survives; the sweep expires it at the end.
 *  - **Expired** — access has stopped. A payment that settles an invoice in full reactivates it
 *    (`payments.service` `REACTIVATE_FROM`).
 *  - **Suspended / Cancelled** — paying old debts never revives either (D23): both are an
 *    administrator's decision, and `transitionAfterSettlement()` leaves them alone.
 *
 * Dates are the stored ones, printed as their UTC day (see `billing.ts`); the day counts are the
 * server's own `standing` block.
 *
 * ## The quantity says what it counts
 *
 * The owner's decision D26: a Per-Student or Student-Based price bills the school's **live**
 * active-student count, taken when the price is chosen and again at every renewal
 * (`subscriptions.service.billedQuantity()`); a Seat-Based price bills the seats set on the
 * subscription; a Fixed or Custom price does not use the quantity at all. A bare "Quantity: 412" would
 * leave a principal guessing which, so the figure carries its meaning.
 *
 * ## Renewing by hand — FR-SUB-015's Manual Renewal
 *
 * `POST /subscriptions/:id/renew` on `subscriptions.self.manage`, the same `renew()` the lifecycle sweep
 * runs for Automatic Renewal. It is offered only where `renew()` accepts it: an Active, Expiring, Past
 * Due, Grace Period or Expired subscription (`renewableFrom`), and not a one-time one, which has no next
 * period (`SUBSCRIPTION_NOT_RECURRING`). The confirmation says what `renew()` does, clause by clause:
 *
 *  - the new period starts where the current one ends — not now — so renewing early does not shorten
 *    it; and only one period ahead: a period that has not begun is a renewal already made, which
 *    `renew()` refuses to stack (`SUBSCRIPTION_ALREADY_RENEWED`), so the button is not offered then;
 *  - the subscription becomes Active — unless an invoice is overdue, when it stays Past Due, or in its
 *    grace period, until that is paid (the owner's decision D23: only settling arrears returns it);
 *  - a Per-Student or Student-Based price is re-counted on the school's active students (D26);
 *  - a scheduled plan change is applied only once its date has arrived;
 *  - nothing is paid by it — an invoice already owed stays owed — and the new period's invoice is
 *    issued by the D6 job once that period has started.
 *
 * A refusal — the subscription moved while the dialog sat open, say — is shown inside the dialog in the
 * API's own words, and the response's subscription replaces the one on screen.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { rowError, splitApiErrors } from '@/lib/formErrors';
import { formatCodeWithAmount } from '@/lib/money';
import { FormSection, Notice, SubmitButton, TextAreaField } from '@/components/form';
import { Icon } from '@/components/icon';
import { Modal } from '@/components/overlay';
import { EmptyNotice, ErrorNotice, LoadingBlock, MetricCard, RefusalNotice, StatusBadge } from '@/components/table';
import { useToast } from '@/components/toast';

import { cycleLabel, formatCount, humanise, periodLabel, utcDay } from './billing';
import type { OwnSubscription, OwnSubscriptionScope } from './billing';

/** `subscriptions.service.renew()`'s `renewableFrom` — every other state is `SUBSCRIPTION_NOT_RENEWABLE`. */
const RENEWABLE_STATES = ['active', 'expiring', 'past_due', 'grace_period', 'expired'];

/** The three states in which the school is behind on paying — see `stateStory()`. */
const BEHIND_STATES = ['past_due', 'grace_period', 'expired'];

/** The renew form's one input. Anything else a 422 names goes to the banner. */
const RENEW_FIELDS = new Set(['reason']);

/** `POST /subscriptions/:id/renew` — `subscriptions.controller.renew()`. Dates arrive as ISO strings. */
interface RenewResponse {
  subscription: OwnSubscription;
  renewal: {
    previousState: string;
    periodStart: string;
    periodEnd: string | null;
    appliedScheduledChange: boolean;
    toPlan: { id: number; name: string } | null;
  };
}

/** One labelled fact. Null is an em-dash, never a blank. */
function Fact({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-soft">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value ?? <span className="text-muted-soft">—</span>}</dd>
      {note ? <dd className="mt-1 text-xs leading-relaxed text-muted">{note}</dd> : null}
    </div>
  );
}

/** How the subscription renews, in one sentence — FR-SUB-015's two modes, and the one-time case. */
function renewalSentence(subscription: OwnSubscription): string {
  if (!subscription.standing.isRecurring) {
    return 'It is a one-time subscription, so it has no next billing period to renew into.';
  }
  return subscription.renewal_mode === 'automatic'
    ? 'It renews automatically at the end of each billing period, and each new period’s invoice is issued when that period starts.'
    : 'It is set to renew manually, so the system does not renew it: if a billing period ends without a renewal, the subscription becomes Past Due.';
}

/** The tone of the notice under the badge — how much the reader needs to act. */
function toneOf(state: string): 'info' | 'warn' | 'error' {
  if (state === 'past_due' || state === 'grace_period' || state === 'expiring') return 'warn';
  if (state === 'expired' || state === 'suspended' || state === 'cancelled' || state === 'paused') return 'error';
  return 'info';
}

/**
 * What the stored state means for this school, in plain words. Each sentence is a rule named in the
 * header, with this subscription's own dates put into it.
 */
function stateStory(subscription: OwnSubscription, expiringWindowDays: number | null): string {
  const periodEnd = utcDay(subscription.current_period_end);
  const trialEnd = utcDay(subscription.trial_ends_at);
  const graceEnd = utcDay(subscription.grace_period_ends_at);

  /*
   * Said once and reused by the two states it applies to. "As long as its billing period is still
   * running" is `settleArrears()`'s second condition: a subscription whose period ended unrenewed is
   * waiting on a renewal, which paying an older invoice does not perform.
   */
  const settles =
    'Paying what is owed — every overdue invoice, or after a trial the first period’s invoice — returns it to Active once the payments are approved, as long as its billing period is still running.';

  /* The three ways a subscription falls behind: D23's overdue invoice, and the sweep's passes 3 and 1. */
  const behind =
    'an invoice is overdue, the billing period ended without a renewal, or the trial ended and the first paid period is not paid yet';

  switch (subscription.state) {
    case 'trial':
      return `Your school is on a free trial${trialEnd ? ` that ends on ${trialEnd}` : ''}. Trial days are not billed: the first billing period starts when the trial ends and its invoice is issued then. Until that invoice is paid the subscription shows Past Due (then Grace Period, when one is configured), and paying it — once the payment is approved — returns it to Active.`;
    case 'active':
      return `In good standing${periodEnd ? `; the current billing period runs to ${periodEnd}` : ''}. ${renewalSentence(subscription)}`;
    case 'expiring':
      return `The current billing period ends ${expiringWindowDays ? `within ${expiringWindowDays} days` : 'soon'}${periodEnd ? `, on ${periodEnd}` : ''}. ${renewalSentence(subscription)}`;
    case 'pending':
      return 'Set up, but not started yet. It becomes Active when its first invoice is paid and that payment is approved.';
    case 'past_due':
      return `Payment is behind: ${behind}. The school keeps its access for now. ${settles} ${
        graceEnd
          ? `If nothing is paid by ${graceEnd}, the subscription expires and the plan’s modules stop.`
          : 'No grace period is configured, so if nothing is paid the subscription expires at the next scheduled check.'
      }`;
    case 'grace_period':
      return `Payment is behind — ${behind} — and the school is in its grace period${
        graceEnd ? `: access continues until ${graceEnd}` : ''
      }. ${settles} If the grace period ends with nothing paid, the subscription expires and the plan’s modules stop.`;
    case 'expired':
      return 'The time allowed for payment ran out, so the plan no longer applies and its modules are switched off. When a payment that settles an invoice in full is approved, the subscription is reactivated on a new billing period.';
    case 'suspended':
      return 'Stopped by the platform administrator, so the plan’s modules are switched off. Paying invoices does not restart a suspended subscription — only the platform administrator can.';
    case 'cancelled':
      return 'Cancelled, and kept as your school’s billing history. Paying old invoices does not revive it; a new subscription is set up by the platform administrator.';
    case 'paused':
      return 'Paused by the platform administrator: the plan’s modules are off, and the rest of the current billing period is kept for when it resumes.';
    default:
      return `The subscription is ${humanise(subscription.state).toLowerCase()}.`;
  }
}

/** The quantity, and what it counts — the owner's decision D26. */
function quantityNote(subscription: OwnSubscription): string {
  switch (subscription.pricing_model) {
    case 'per_student':
    case 'student_based':
      return 'Your school’s active students. A Per-Student or Student-Based price bills the live count: it was taken when this price was chosen and is taken again at every renewal, so admissions and departures change the next period’s amount, not this one’s.';
    case 'seat_based':
      return 'The seats set on this subscription. A Seat-Based price bills this number, whatever the student count.';
    default:
      return 'Not used: this price is one amount per billing period, whatever the number of students.';
  }
}

/** What a manual renewal of this subscription will do — each sentence a clause of `renew()`. */
function renewalTerms(subscription: OwnSubscription): string[] {
  const periodEnd = utcDay(subscription.current_period_end);
  const terms = [
    `The next ${cycleLabel(subscription).toLowerCase()} billing period starts where the current one ends${
      periodEnd ? `, on ${periodEnd}` : ''
    }, so renewing early does not shorten it. It can be renewed one period ahead, not more.`,
    'Its invoice is issued automatically once that period has started.',
  ];
  if (subscription.pricing_model === 'per_student' || subscription.pricing_model === 'student_based') {
    terms.push('The price is re-counted on your school’s active students as it renews.');
  }
  if (subscription.standing.hasScheduledChange) {
    terms.push(
      `The scheduled move to ${
        subscription.scheduledPlan ? subscription.scheduledPlan.name : 'another plan'
      } is applied by this renewal only if its date has arrived; otherwise it stays scheduled.`
    );
  }
  /*
   * What the state becomes, clause by clause of `renew()` — it checks for an overdue invoice at the
   * moment of renewal, and only settling one returns the subscription to Active (D23).
   */
  if (BEHIND_STATES.includes(subscription.state)) {
    terms.push('Renewing pays nothing: an invoice already owed stays owed, on the Invoices tab.');
  }
  if (subscription.state === 'past_due' || subscription.state === 'grace_period') {
    terms.push(
      `If an invoice is overdue when you renew, the subscription stays ${
        subscription.state === 'grace_period' ? 'in its grace period, with the same end date' : 'Past Due'
      }; paying it is what makes it Active. With nothing overdue, it becomes Active.`
    );
  } else if (subscription.state === 'expired') {
    terms.push(
      'If an invoice is overdue, renewing is refused: an expired subscription is reactivated by paying what is owed. With nothing overdue, it becomes Active.'
    );
  } else {
    terms.push(
      'It stays Active — unless an invoice is already overdue, in which case it moves into its grace period (or Past Due, when none is set) until that is paid.'
    );
  }
  return terms;
}

/** FR-SUB-015's Manual Renewal, confirmed — see the header. */
function RenewDialog({
  subscription,
  open,
  onClose,
  onRenewed,
}: {
  subscription: OwnSubscription;
  open: boolean;
  onClose: () => void;
  onRenewed: (subscription: OwnSubscription) => void;
}) {
  const { success } = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /* A fresh form each time it opens, so a refusal from the last attempt is not left standing. */
  useEffect(() => {
    if (!open) return;
    setReason('');
    setError(null);
    setFieldErrors({});
  }, [open]);

  async function renew() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await api.post<RenewResponse>(
        `/subscriptions/${subscription.id}/renew`,
        reason.trim() ? { reason: reason.trim() } : {}
      );
      const periodEnd = utcDay(result.renewal.periodEnd);
      /* The state the renewal left, not the one hoped for: with an invoice overdue it is still in arrears. */
      const stillOwed = result.subscription.state === 'past_due' || result.subscription.state === 'grace_period';
      success(
        stillOwed ? 'Renewed — an overdue invoice is still unpaid' : 'Subscription renewed',
        [
          result.renewal.appliedScheduledChange && result.renewal.toPlan
            ? `The scheduled move to ${result.renewal.toPlan.name} was applied with it.`
            : null,
          periodEnd ? `The new billing period runs to ${periodEnd}.` : null,
          stillOwed
            ? `The subscription is ${humanise(result.subscription.state)} until that invoice is paid.`
            : null,
        ].filter(Boolean).join(' ') || undefined
      );
      onRenewed(result.subscription);
    } catch (caught) {
      if (caught instanceof ApiError) {
        /* The refusal in the API's own words — `SUBSCRIPTION_NOT_RENEWABLE` names the state it found. */
        const { perField, banner } = splitApiErrors(caught, RENEW_FIELDS);
        setFieldErrors(perField);
        setError(banner);
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Renew for another billing period?"
      description={`${subscription.plan ? subscription.plan.name : `Subscription #${subscription.id}`} · ${cycleLabel(subscription)}`}
      busy={busy}
      footer={
        <>
          {/* "Go back", beside "Renew subscription" — the add-on dialog argues why not "Cancel". */}
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Go back
          </button>
          <SubmitButton form="renew-subscription" busy={busy} busyLabel="Renewing…" fullWidth={false}>
            Renew subscription
          </SubmitButton>
        </>
      }
    >
      <form
        id="renew-subscription"
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void renew();
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-soft">
          {renewalTerms(subscription).map((term) => (
            <li key={term}>{term}</li>
          ))}
        </ul>
        <TextAreaField
          id="renew-reason"
          label="Reason"
          rows={2}
          maxLength={255}
          value={reason}
          error={rowError(fieldErrors, 'reason', 'Reason')}
          onChange={(event) => setReason(event.target.value)}
          hint="Optional, up to 255 characters. Kept with the subscription’s history."
        />
      </form>
    </Modal>
  );
}

export function OverviewPanel({
  scope,
  canRenew,
}: {
  scope: OwnSubscriptionScope;
  /** `subscriptions.self.manage` — `canChangeOwn()` in the router. */
  canRenew: boolean;
}) {
  const { subscription, vocabulary, loading, error, refusal, reload, adopt } = scope;
  const [renewing, setRenewing] = useState(false);
  /* The clock, read once when the panel mounts — a render must not read it (react-hooks/purity). */
  const [openedAt] = useState(() => Date.now());

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (error) return <ErrorNotice message={error} onRetry={reload} />;
  if (loading && !subscription) return <LoadingBlock rows={3} />;
  if (!subscription) {
    return (
      <EmptyNotice title="No subscription yet">
        Your school has not been put on a plan, so there is nothing to bill. A platform administrator
        sets the subscription up.
      </EmptyNotice>
    );
  }

  const { standing } = subscription;
  const trialDays = standing.daysUntilTrialEnd;
  const priceOverride = subscription.overrides.find(
    (row) => row.override_type === 'price' && row.is_active && row.is_effective
  );
  /*
   * Only where `renew()` would take it — see the header — and not when the period on record has not
   * begun yet: that is a renewal already made, and `renew()` refuses a second (`SUBSCRIPTION_ALREADY_RENEWED`).
   */
  const alreadyRenewed = Boolean(
    subscription.current_period_start && new Date(subscription.current_period_start).getTime() > openedAt
  );
  const renewable = canRenew && standing.isRecurring && RENEWABLE_STATES.includes(subscription.state) && !alreadyRenewed;

  return (
    <>
      <div
        className={`space-y-8 transition-opacity duration-200 ${loading ? 'pointer-events-none opacity-60' : ''}`}
        aria-busy={loading || undefined}
      >
        <section className="surface p-5" aria-label="Your plan">
          <div className="flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Current plan</p>
              <h2 className="mt-1 font-display text-2xl font-semibold text-ink">
                {/* The name for display only — SRS §30 Rule 1: nothing branches on it. */}
                {subscription.plan ? subscription.plan.name : `Subscription #${subscription.id}`}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {cycleLabel(subscription)} ·{' '}
                {formatCodeWithAmount(subscription.currency, subscription.cycle_amount)}
                {standing.isRecurring ? ' per billing period' : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={subscription.state} />
              {renewable ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRenewing(true)}>
                  <Icon name="refresh" size={14} />
                  Renew…
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-4">
            <Notice tone={toneOf(subscription.state)}>
              {stateStory(subscription, vocabulary?.expiringWindowDays ?? null)}
            </Notice>
          </div>

          {/*
            * Negative is a real answer here: `daysBetween()` floors a signed difference, so a trial whose
            * end has passed while the sweep has not yet moved it reads below zero. Said in words rather
            * than printed as "-1 day(s)".
            */}
          {standing.inTrial && trialDays !== null ? (
            <p className="mt-3 text-sm text-muted">
              {trialDays < 0
                ? 'The trial’s end has passed; the subscription moves on at the next scheduled check.'
                : trialDays === 0
                  ? 'The trial ends within a day.'
                  : `${trialDays} day(s) of trial left.`}
            </p>
          ) : null}

          {standing.hasScheduledChange ? (
            <p className="mt-3 text-sm text-warn">
              A move to {subscription.scheduledPlan ? subscription.scheduledPlan.name : 'another plan'} is
              scheduled for the end of the current billing period
              {utcDay(subscription.scheduled_change_at) ? ` (${utcDay(subscription.scheduled_change_at)})` : ''}.
              Your school keeps its current plan until then.
            </p>
          ) : null}
        </section>

        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Per billing period"
            value={formatCodeWithAmount(subscription.currency, subscription.cycle_amount)}
            hint="The plan’s own charge. Add-ons, a coupon and tax are applied on each invoice."
          />
          <MetricCard
            label="Days left in period"
            value={standing.daysUntilPeriodEnd === null ? '—' : String(Math.max(standing.daysUntilPeriodEnd, 0))}
            hint={standing.isRecurring ? undefined : 'A one-time subscription has no period end.'}
          />
          <MetricCard
            label="Credit"
            value={formatCodeWithAmount(subscription.currency, standing.creditBalance)}
            hint="Unused value left by an earlier plan change (SRS §12.3), drawn by the next invoice issued or the next plan change."
          />
          <MetricCard
            label="Wallet"
            value={formatCodeWithAmount(subscription.currency, Number(subscription.wallet_balance) || 0)}
            hint="Credited by refunds sent to the wallet; an invoice can be paid from it."
          />
        </dl>

        <FormSection
          title="Billing"
          description="As the subscription stores them. Periods are shown as UTC days, as on every invoice."
        >
          <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Billing cycle" value={cycleLabel(subscription)} />
            <Fact label="Currency" value={subscription.currency} />
            <Fact label="Pricing model" value={humanise(subscription.pricing_model)} />
            <Fact
              label="Current period"
              value={periodLabel(subscription.current_period_start, subscription.current_period_end)}
            />
            <Fact
              label="Next renewal"
              value={standing.isRecurring ? utcDay(subscription.next_renewal_at) : 'None — one-time'}
            />
            <Fact label="Renewal" value={humanise(subscription.renewal_mode)} />
            <Fact
              label="Quantity"
              value={formatCount(subscription.quantity)}
              note={quantityNote(subscription)}
            />
            {subscription.trial_ends_at ? <Fact label="Trial ends" value={utcDay(subscription.trial_ends_at)} /> : null}
            {subscription.grace_period_ends_at ? (
              <Fact label="Grace period ends" value={utcDay(subscription.grace_period_ends_at)} />
            ) : null}
          </dl>
        </FormSection>

        {/*
          * A price override is the owner's decision D7: while it is in effect, invoices bill the plan line
          * at the override's amount instead of the price above. Only one in force is mentioned — a
          * revoked or out-of-window one changes nothing the school pays.
          */}
        {priceOverride ? (
          <Notice tone="info">
            A negotiated price of {formatCodeWithAmount(subscription.currency, priceOverride.amount)} is in
            effect, so invoices bill the plan at that amount while it applies.
          </Notice>
        ) : null}

        {!standing.isUsable ? (
          <Notice tone="warn">
            In its current state this subscription gives your school no access to the plan’s modules.
          </Notice>
        ) : null}
      </div>

      {/* Outside the panel, whose `pointer-events-none` while a re-read runs would reach into it. */}
      {renewable ? (
        <RenewDialog
          subscription={subscription}
          open={renewing}
          onClose={() => setRenewing(false)}
          onRenewed={(next) => {
            /* The response is the subscription after the renewal, so it replaces the one on screen. */
            adopt(next);
            setRenewing(false);
          }}
        />
      ) : null}
    </>
  );
}
