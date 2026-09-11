'use client';

/**
 * One subscription — SRS §12, and the home of the fourteen write routes this module had mounted
 * with no caller anywhere in the product.
 *
 * `PATCH /:id` (FR-SUB-011 / FR-SUB-012), the six transitions and the renewal (FR-SUB-010 /
 * FR-SUB-015) in `lifecycle.tsx`, the plan change (FR-SUB-013 / FR-SUB-014) in `planChange.tsx`,
 * the two add-on routes (§11.3 / FR-SUB-009) in `addons.tsx` and the two override routes (§33) in
 * `overrides.tsx`.
 *
 * ## Why a detail screen and not row actions on the list
 *
 * The precedent in this product is a row action: Plans, Schools and Students all act from their
 * list. That works when the action is one confirmation on one row. Here it is not — a plan change
 * needs a plan, a timing and a quantity; an override needs four fields whose shapes depend on each
 * other; an add-on purchase needs a price the subscription's own plan is allowed to be charged on.
 * Those are forms, and a list screen carrying five of them is a list screen nobody can read.
 *
 * §33 names "Subscriptions" as a screen and does not name this one, exactly as it names Plans and
 * does not name `plans/[id]`. A detail view of a row on a named list is not a new screen in §33's
 * sense; it is where that row's operations live, and this file follows the shape `plans/[id]`
 * already set.
 *
 * ## Everything reachable here is gated on a key the API also checks
 *
 * Four different keys, not one, because the router uses four:
 *
 *  - `subscriptions.manage` — the configuration form and add-on purchases.
 *  - `subscriptions.lifecycle` — the six transitions, the plan change and the renewal.
 *  - `subscriptions.overrides.manage` — the overrides, seeded to `super_admin` alone.
 *  - `subscriptions.view` — reading this screen at all.
 *
 * `can()` cannot see `requirePlatformScope()`, which the configuration `PATCH`, the six transitions
 * and the two override routes also carry. The plan change, the renewal and the two add-on routes do
 * not — their FRs name the school as an actor too, so the router pairs each key with
 * `subscriptions.self.manage` instead. A school-scoped account holding a platform-only permission is
 * refused with `PLATFORM_SCOPE_REQUIRED`: on the read that opens this screen it lands in
 * `RefusalNotice`, and on a write it is shown, in the API's own words, inside the form or dialog that
 * sent it.
 *
 * ## Nothing on this screen derives a lifecycle state from a date
 *
 * The list screen says this and it matters more here, where the dates are all on one page and
 * subtracting two of them is one keystroke away. `subscriptions.service.js` is explicit that state
 * is written by `runLifecycleSweep()` and *"read, never recomputed"*; `standing` carries the day
 * counts the server itself derived. Every figure below comes from one of those two.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { formatCodeWithAmount } from '@/lib/money';
import { useSchoolNames } from '@/lib/useSchoolNames';
import {
  Field,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
} from '@/components/form';
import { TabPanel, Tabs, useActiveTab } from '@/components/tabs';
import { useToast } from '@/components/toast';
import {
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  MetricCard,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

import { AddonsPanel } from './addons';
import { LifecycleBar } from './lifecycle';
import { OverridesPanel } from './overrides';
import { PlanChangePanel } from './planChange';
import { formatDate, humanise, isCountedModel, useSubscriptionDetail } from './detail';
import type { SubscriptionDetail } from './detail';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'plan', label: 'Plan & renewal' },
  { key: 'addons', label: 'Add-ons' },
  { key: 'overrides', label: 'Overrides' },
];

/* ─────────────────────────── the configuration form ─────────────────────────── */

/**
 * `PATCH /subscriptions/:id` — the four fields FR-SUB-011 and FR-SUB-012 make configurable on a
 * live subscription, plus the quantity §10.4's per-unit models bill from.
 *
 * The schema takes exactly `trial_days`, `grace_period_days`, `renewal_mode`, `quantity`,
 * `metadata` and `reason`, and `.min(1)` — a body with nothing in it is refused with *"Provide at
 * least one field to update"*. `metadata` is not offered: it is a free-form JSON column with no
 * defined shape, and a textarea that has to parse as JSON to save is a way to lose a form's worth
 * of typing to a missing brace.
 *
 * Everything else it refuses **by name** — `plan_id`, `state`, `currency`, `cycle_amount` and some
 * thirty more — each with a message saying where the value really comes from. None of them appears
 * here; a control for one would be a control whose only outcome is that message.
 *
 * The quantity is refused too, on a Per-Student or Student-Based subscription. Owner decision D26
 * makes those bill the school's active-student count — counted when the subscription is created or
 * changes plan, and again at every renewal — so `update()` answers a typed change with 409
 * `SUBSCRIPTION_QUANTITY_COUNTED`, and the next count would overwrite it anyway. The box is not
 * offered on one; the count is shown in its place, with where it comes from.
 */
function ConfigurationForm({
  subscription,
  presets,
  renewalModes,
  canEdit,
  onSaved,
}: {
  subscription: SubscriptionDetail;
  presets: { trial: number[]; grace: number[] };
  renewalModes: string[];
  canEdit: boolean;
  onSaved: (subscription: SubscriptionDetail) => void;
}) {
  const { success } = useToast();

  const [trialDays, setTrialDays] = useState(String(subscription.trial_days));
  const [graceDays, setGraceDays] = useState(String(subscription.grace_period_days));
  const [renewalMode, setRenewalMode] = useState(subscription.renewal_mode);
  const [quantity, setQuantity] = useState(String(subscription.quantity));
  /* D26 — a student-counted price has no typed quantity to change. See the header. */
  const counted = isCountedModel(subscription.pricing_model);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /* Re-seed when a write elsewhere on the screen returns a new record. */
  useEffect(() => {
    setTrialDays(String(subscription.trial_days));
    setGraceDays(String(subscription.grace_period_days));
    setRenewalMode(subscription.renewal_mode);
    setQuantity(String(subscription.quantity));
  }, [
    subscription.trial_days,
    subscription.grace_period_days,
    subscription.renewal_mode,
    subscription.quantity,
  ]);

  /*
   * Only what changed is sent.
   *
   * Not an optimisation: `update()` re-evaluates `cycle_amount` from the price row whenever
   * `quantity` is present, and writes an audit row naming every field in the body. Sending all four
   * every time would record a change of renewal mode on a save that only touched the trial length.
   */
  const changed: Record<string, unknown> = {};
  if (trialDays !== String(subscription.trial_days)) changed.trial_days = trialDays;
  if (graceDays !== String(subscription.grace_period_days)) changed.grace_period_days = graceDays;
  if (renewalMode !== subscription.renewal_mode) changed.renewal_mode = renewalMode;
  if (!counted && quantity !== String(subscription.quantity)) changed.quantity = quantity;
  const nothingChanged = Object.keys(changed).length === 0;

  async function save() {
    if (busy || nothingChanged) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const body = { ...changed };
      if (reason.trim()) body.reason = reason.trim();
      const result = await api.patch<{ subscription: SubscriptionDetail }>(
        `/subscriptions/${subscription.id}`,
        body
      );
      onSaved(result.subscription);
      success('Subscription updated');
      setReason('');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        /* No quantity box on a counted price, so a message about it belongs in the banner. */
        setError(
          caught.bannerFor(
            counted
              ? ['trial_days', 'grace_period_days', 'renewal_mode']
              : ['trial_days', 'grace_period_days', 'renewal_mode', 'quantity']
          )
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!canEdit) {
    return (
      <Notice tone="info">
        Changing a subscription’s trial, grace period, renewal mode or quantity needs the
        subscription management permission, which this account does not hold.
      </Notice>
    );
  }

  return (
    <FormSection
      title="Configuration"
      description={
        counted
          ? 'The trial and grace lengths and the renewal mode — what changes on a live subscription without it being a plan change. This price bills per student, so its quantity is counted, not set.'
          : 'The trial and grace lengths, the renewal mode and the quantity — the four things that change on a live subscription without it being a plan change.'
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}

        <Field
          id="trial_days"
          label="Trial length (days)"
          type="number"
          min={0}
          value={trialDays}
          error={fieldErrors.trial_days}
          onChange={(event) => setTrialDays(event.target.value)}
          hint={`The presets are ${presets.trial.join(', ')} days, but any whole number is accepted. Changing it does not restart a trial that has already ended.`}
        />

        <Field
          id="grace_period_days"
          label="Grace period (days)"
          type="number"
          min={0}
          value={graceDays}
          error={fieldErrors.grace_period_days}
          onChange={(event) => setGraceDays(event.target.value)}
          hint={`The presets are ${presets.grace.join(', ')} days, but any whole number is accepted. This is how long access survives past the period end before the lifecycle sweep expires it.`}
        />

        <SelectField
          id="renewal_mode"
          label="Renewal"
          value={renewalMode}
          error={fieldErrors.renewal_mode}
          onChange={(event) => setRenewalMode(event.target.value)}
          hint="Automatic renews from the hourly lifecycle sweep once the period ends. Manual leaves it to an operator — the Renew button on this screen is that operation."
        >
          {renewalModes.map((mode) => (
            <option key={mode} value={mode}>
              {humanise(mode)}
            </option>
          ))}
        </SelectField>

        {counted ? (
          <div>
            <p className="text-sm font-medium text-ink">Quantity</p>
            <p className="mt-1 text-sm text-ink">
              <span className="tabular-nums">{subscription.quantity.toLocaleString()}</span>{' '}
              active student{subscription.quantity === 1 ? '' : 's'}
            </p>
            <p className="mt-1 text-xs text-muted">
              This is a {humanise(subscription.pricing_model)} price, so it bills the school’s live
              active-student count: taken when the subscription was created or last changed plan, and
              taken again at every renewal. It cannot be typed here — the API refuses a change, and
              the next count would replace it.
            </p>
          </div>
        ) : (
          <Field
            id="quantity"
            label="Quantity"
            type="number"
            min={1}
            value={quantity}
            error={fieldErrors.quantity}
            onChange={(event) => setQuantity(event.target.value)}
            hint={
              subscription.pricing_model === 'seat_based'
                ? 'The seats this Seat-Based price bills. Changing it re-evaluates the cycle amount from the same price row.'
                : `A ${humanise(subscription.pricing_model)} price is not multiplied by the quantity. Changing it still re-evaluates the cycle amount from the same price row.`
            }
          />
        )}

        <TextAreaField
          id="update-reason"
          label="Reason"
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          hint="Recorded in the audit trail beside the fields that changed."
        />

        <SubmitButton busy={busy} busyLabel="Saving…" fullWidth={false} disabled={nothingChanged}>
          Save changes
        </SubmitButton>
      </form>
    </FormSection>
  );
}

/* ───────────────────────────────── the screen ───────────────────────────────── */

/** One labelled fact from the record. Null is rendered as an em-dash, never as a blank cell. */
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-soft">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value ?? <span className="text-muted-soft">—</span>}</dd>
    </div>
  );
}

export default function SubscriptionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : null;

  const { can } = useAuth();
  const { nameFor } = useSchoolNames();
  const [tab, setTab] = useActiveTab(TABS);

  const { detail, catalogue, loading, error, refusal, notFound, reload, adopt } =
    useSubscriptionDetail(id);

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (notFound) {
    /*
     * Not `ErrorNotice`: its "Try again" re-reads an id that names nothing this caller can see, and
     * would fail the same way every time it was pressed. The way forward is back to the list.
     */
    return (
      <EmptyNotice
        icon="search"
        title="Subscription not found"
        action={
          <Link href="/super-admin/subscriptions" className="btn btn-secondary">
            Back to subscriptions
          </Link>
        }
      >
        No subscription with this id exists, or it belongs to a school outside this account’s scope.
      </EmptyNotice>
    );
  }
  if (error) return <ErrorNotice message={error} onRetry={reload} />;
  if (loading || !detail) return <LoadingBlock />;

  const canManage = can('subscriptions.manage');
  const canLifecycle = can('subscriptions.lifecycle');
  const canOverrides = can('subscriptions.overrides.manage');

  const { standing } = detail;

  /*
   * `standing.daysUntilTrialEnd` is `daysBetween()`, which floors a signed difference: 0 means the
   * trial ends within the next 24 hours, and a negative count means its end has passed while the
   * state still reads `trial` — the hourly sweep has not moved it on yet. Printing the raw number
   * gave "Trial ends in -1 day(s)" on exactly that row.
   */
  const trialDays = standing.daysUntilTrialEnd;
  const trialNote =
    trialDays === null
      ? null
      : trialDays < 0
        ? 'The trial end has passed; the lifecycle sweep has not moved it on yet'
        : trialDays === 0
          ? 'Trial ends within a day'
          : `Trial ends in ${trialDays} day(s)`;

  return (
    <div>
      <PageHeader
        title={detail.plan ? detail.plan.name : `Subscription #${detail.id}`}
        /*
         * "per cycle" only where there is a cycle. A `one_time` subscription has no next period —
         * `standing.isRecurring` is false for exactly that — so its amount is charged once, and the
         * cycle name beside it already says "One time".
         */
        description={`${nameFor(detail.school_id)} · ${humanise(detail.billing_cycle)} · ${formatCodeWithAmount(
          detail.currency,
          detail.cycle_amount
        )}${standing.isRecurring ? ' per cycle' : ''}`}
        action={
          <Link href="/super-admin/subscriptions" className="btn btn-secondary">
            Back to subscriptions
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={detail.state} />
        {/*
          * Both of these are `standing`'s, not this screen's arithmetic. `inTrial` is a state test
          * and `hasScheduledChange` reads `scheduled_plan_id` — the plan named in the header is
          * therefore not the plan the school will be on next cycle, which is worth saying beside
          * the name rather than three tabs away.
          */}
        {standing.inTrial && trialNote ? (
          <span className={`text-sm ${trialDays !== null && trialDays < 0 ? 'text-warn' : 'text-muted'}`}>
            {trialNote}
          </span>
        ) : null}
        {standing.hasScheduledChange && detail.scheduledPlan ? (
          <span className="text-sm text-warn">
            Scheduled to move to {detail.scheduledPlan.name} at the end of the cycle
          </span>
        ) : null}
        {/*
          * A statement about this row, not about the school. Entitlement is resolved from the
          * school's governing subscription — a usable one if it has one — so an expired or
          * cancelled row viewed here may sit beside a newer, live subscription that the school is
          * using right now. "The school has no access" was true only when this row was the latest.
          */}
        {!standing.isUsable ? (
          <span className="text-sm text-danger">
            This subscription grants no entitlement in its current state.
          </span>
        ) : null}
      </div>

      <div className="mb-6">
        <LifecycleBar
          subscription={detail}
          catalogue={catalogue}
          canAct={canLifecycle}
          canRenew={canLifecycle}
          onChanged={adopt}
        />
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} label="Subscription sections" />

      {/*
        * One panel whose key follows the active tab, not four panels three of which are empty.
        * `TabPanel` renders `role="tabpanel"` with an `aria-labelledby` pointing at its tab, so four
        * of them would announce three empty panels to a screen reader. Same shape as `plans/[id]`.
        */}
      <TabPanel tabKey={tab}>
        {tab === 'overview' ? (
          <div className="space-y-8">
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard
                label="Days left in period"
                value={
                  standing.daysUntilPeriodEnd === null
                    ? '—'
                    : String(standing.daysUntilPeriodEnd)
                }
                hint={
                  standing.daysUntilPeriodEnd !== null && standing.daysUntilPeriodEnd < 0
                    ? 'The period end has passed.'
                    : undefined
                }
              />
              <MetricCard label="Active add-ons" value={String(standing.activeAddonCount)} />
              <MetricCard
                label="Overrides in force"
                value={String(standing.effectiveOverrideCount)}
              />
              <MetricCard
                label="Credit balance"
                value={formatCodeWithAmount(detail.currency, standing.creditBalance)}
                hint="Applied against the next proration or renewal."
              />
              <MetricCard
                label="Wallet"
                value={formatCodeWithAmount(detail.currency, Number(detail.wallet_balance) || 0)}
                hint="Credited by refunds sent to the wallet; the school can pay an invoice from it."
              />
            </dl>

            <FormSection title="Dates" description="As stored. Nothing here is inferred from anything else.">
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Fact label="Starts" value={formatDate(detail.starts_at)} />
                <Fact label="Trial ends" value={formatDate(detail.trial_ends_at)} />
                <Fact label="Period start" value={formatDate(detail.current_period_start)} />
                <Fact label="Period end" value={formatDate(detail.current_period_end)} />
                <Fact label="Next renewal" value={formatDate(detail.next_renewal_at)} />
                <Fact label="Grace ends" value={formatDate(detail.grace_period_ends_at)} />
                <Fact label="Renewals so far" value={String(detail.renewal_count)} />
                <Fact label="Cancelled" value={formatDate(detail.cancelled_at)} />
                <Fact
                  label="Cancellation reason"
                  value={detail.cancellation_reason}
                />
              </dl>
            </FormSection>

            <ConfigurationForm
              subscription={detail}
              presets={{
                trial: catalogue?.trialPresetDays ?? [],
                grace: catalogue?.gracePresetDays ?? [],
              }}
              renewalModes={catalogue?.renewalModes ?? [detail.renewal_mode]}
              canEdit={canManage}
              onSaved={adopt}
            />
          </div>
        ) : tab === 'plan' ? (
          <PlanChangePanel
            subscription={detail}
            catalogue={catalogue}
            canChange={canLifecycle}
            onChanged={adopt}
          />
        ) : tab === 'addons' ? (
          <AddonsPanel
            subscription={detail}
            catalogue={catalogue}
            canBuy={canManage}
            onChanged={adopt}
          />
        ) : (
          <OverridesPanel
            subscription={detail}
            catalogue={catalogue}
            canManage={canOverrides}
            onChanged={adopt}
          />
        )}
      </TabPanel>
    </div>
  );
}
