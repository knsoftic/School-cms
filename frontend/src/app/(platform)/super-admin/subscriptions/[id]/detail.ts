'use client';

/**
 * One subscription, its vocabulary, and the shapes both belong to.
 *
 * ## Why a module of its own rather than the page's top half
 *
 * Four files render parts of this record — the page, the lifecycle bar, the add-ons tab and the
 * overrides tab — and every one of them needs the same two things: the loaded subscription and a
 * `reload` that re-reads it. Every write on every one of those routes returns `{ subscription }`
 * **whole**, so "reload" is not a nicety: an add-on purchased on the third tab changes
 * `standing.grantedUnits` shown on the first, and a lifecycle transition changes the dates the
 * plan-change panel bases its warnings on.
 *
 * The alternative — the page owning the state and passing a setter down — was written first and
 * abandoned: it made every child take a prop it only forwarded, and it put the decision "which
 * response updates the record" in four places instead of one.
 *
 * ## The vocabulary is fetched, never declared
 *
 * `GET /subscriptions/catalogue` publishes the ten states, the transition table, the §12.4 timings,
 * the §12.1/§12.2 presets, the four override types and — since this screen needed them — the nine
 * limit keys, the two limit types and the one price target. A screen that hard-coded any of those
 * would drift from the machine that refuses the call; `subscriptions.service.catalogue()` says so
 * in its own header and this file is the reason that sentence is worth anything.
 *
 * Module override targets are the one exception and come from `lib/modules.ts`, which is a copy the
 * backend's own suite asserts against `MODULE_LABELS` in both directions. The catalogue's comment
 * explains why it does not publish a second one.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/* ─────────────────────────────── the record ─────────────────────────────── */

/** The plan a subscription points at, as `detailInclude()` loads it. */
export interface SubscriptionPlanRef {
  id: number;
  name: string;
  code: string;
  /**
   * *"Higher rank = higher tier"*, per the column's own comment.
   *
   * Read here for one purpose only: deciding whether a chosen plan is an upgrade or a downgrade, so
   * the screen sends the request to the route the service will accept. It is never compared against
   * a literal, and no capability is derived from it — SRS §30 Rule 1 forbids that, and what a plan
   * grants comes from the entitlement snapshot rather than from its position in an ordering.
   */
  tier_rank: number;
}

/** One `subscription_addons` row with the two associations the detail read includes. */
export interface SubscriptionAddonRow {
  id: number;
  addon_id: number;
  addon_price_id: number | null;
  quantity: number;
  status: string;
  /** The purchase copy — resolved at purchase time so a later catalogue edit cannot change it. */
  effect_type: string;
  effect_target: string;
  units_granted: number | string | null;
  unit_amount: number | string | null;
  currency: string | null;
  is_recurring: boolean;
  starts_at: string | null;
  ends_at: string | null;
  addon: { id: number; key: string; name: string } | null;
  addonPrice: { id: number; billing_cycle: string; currency: string } | null;
}

/**
 * One `subscription_overrides` row.
 *
 * `is_effective` is added by `subscriptions.controller.present()` from the service's own
 * `isEffective()`, which is the same function `entitlementService` resolves through. The window is
 * therefore never re-derived here — an override that this screen called "active" while entitlement
 * ignored it would be worse than no marker at all.
 */
export interface SubscriptionOverrideRow {
  id: number;
  override_type: string;
  target_key: string;
  is_enabled: boolean | null;
  limit_type: string | null;
  limit_value: number | string | null;
  amount: number | string | null;
  effective_from: string | null;
  effective_until: string | null;
  is_active: boolean;
  reason: string | null;
  is_effective: boolean;
}

/** The derived block `service.standing()` builds. Read, never recomputed. */
export interface SubscriptionStanding {
  isUsable: boolean;
  isOpen: boolean;
  inTrial: boolean;
  daysUntilPeriodEnd: number | null;
  daysUntilTrialEnd: number | null;
  daysUntilGraceEnd: number | null;
  isRecurring: boolean;
  hasScheduledChange: boolean;
  activeAddonCount: number;
  effectiveOverrideCount: number;
  creditBalance: number;
  grantedUnits: Record<string, { units: number; unit: string | null }>;
}

/**
 * `GET /subscriptions/:id`.
 *
 * Money columns arrive as JS numbers because `config/database.js` sets `dialectOptions.decimalNumbers`;
 * the union with `string` is kept for the reason `PlanPrice` gives — one line of configuration
 * decides it, and a type that accepts both cannot be broken by flipping it.
 */
export interface SubscriptionDetail {
  id: number;
  school_id: number;
  organization_id: number | null;
  plan_id: number;
  plan_price_id: number | null;
  scheduled_plan_id: number | null;
  state: string;
  billing_cycle: string;
  cycle_days: number | null;
  currency: string;
  cycle_amount: number | string;
  quantity: number;
  credit_balance: number | string;
  /** §13.2's wallet — credited by refunds to it, drawn by approved wallet payments (owner decision D5). */
  wallet_balance: number | string;
  trial_days: number;
  grace_period_days: number;
  renewal_mode: string;
  renewal_count: number;
  starts_at: string | null;
  ends_at: string | null;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  next_renewal_at: string | null;
  grace_period_ends_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;

  plan: SubscriptionPlanRef | null;
  scheduledPlan: SubscriptionPlanRef | null;
  addons: SubscriptionAddonRow[];
  overrides: SubscriptionOverrideRow[];
  standing: SubscriptionStanding;
}

/* ───────────────────────────── the vocabulary ───────────────────────────── */

/** One row of the transition table: which action, to which state, legal from which. */
export interface TransitionSpec {
  action: string;
  to: string;
  from: string[];
  event: string;
}

/** `GET /subscriptions/catalogue`. */
export interface SubscriptionCatalogue {
  states: string[];
  usableStates: string[];
  openStates: string[];
  events: string[];
  trialPresetDays: number[];
  gracePresetDays: number[];
  downgradeTimings: string[];
  renewalModes: string[];
  overrideTypes: string[];
  limitTargets: { key: string; label: string; unit: string | null }[];
  limitTypes: string[];
  priceTargets: string[];
  transitions: TransitionSpec[];
  expiringWindowDays: number;
}

/* ─────────────────────────────── the hook ─────────────────────────────── */

export interface SubscriptionScope {
  detail: SubscriptionDetail | null;
  catalogue: SubscriptionCatalogue | null;
  loading: boolean;
  error: string | null;
  refusal: Refusal | null;
  /**
   * The id names no subscription this caller can see — a 404, or an id the route refuses to parse.
   *
   * Kept apart from `error` because the two want different screens. `error` offers "Try again", and
   * for a subscription that does not exist that button can only fail the same way forever; what the
   * operator needs is the way back to the list.
   */
  notFound: boolean;
  /** Re-read from the server. */
  reload: () => void;
  /**
   * Adopt the record a write returned, without a second round trip.
   *
   * Every write on this module answers with the whole `{ subscription }` after the transaction, so
   * the response *is* the reload. Taking it saves a request and, more importantly, removes the
   * window in which the screen shows the pre-write record next to a toast saying the write
   * succeeded.
   */
  adopt: (subscription: SubscriptionDetail) => void;
}

export function useSubscriptionDetail(id: string | null): SubscriptionScope {
  const [detail, setDetail] = useState<SubscriptionDetail | null>(null);
  const [catalogue, setCatalogue] = useState<SubscriptionCatalogue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      return undefined;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);
    setNotFound(false);

    (async () => {
      try {
        const [record, vocabulary] = await Promise.all([
          api.get<{ subscription: SubscriptionDetail }>(`/subscriptions/${id}`, {
            signal: controller.signal,
          }),
          api.get<SubscriptionCatalogue>('/subscriptions/catalogue', {
            signal: controller.signal,
          }),
        ]);
        if (controller.signal.aborted) return;
        /* `show` wraps its payload, as every detail read in this API does. */
        setDetail(record.subscription);
        setCatalogue(vocabulary);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (
          caught instanceof ApiError &&
          (caught.status === 404 || caught.code === 'VALIDATION_ERROR')
        ) {
          /*
           * Two ways to reach a subscription that is not there, and retrying changes neither.
           * `findById()` folds the tenant scope into its `where`, so a row this caller may not see is
           * a 404 exactly like a row that never existed — `SUBSCRIPTION_NOT_FOUND` either way. And the
           * id in the address is validated before the service runs: `/subscriptions/abc` is refused
           * by the `idParam` schema with a 422. The catalogue read takes no parameter, so neither of
           * these can have come from it.
           */
          setNotFound(true);
        } else if (caught instanceof ApiError) {
          setError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [id, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const adopt = useCallback((subscription: SubscriptionDetail) => setDetail(subscription), []);

  return { detail, catalogue, loading, error, refusal, notFound, reload, adopt };
}

/* ───────────────────────────── shared formatting ───────────────────────────── */

/** `pending` → `Pending`, `next_billing_cycle` → `Next billing cycle`. */
export function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A stored timestamp as a date, or null when there is none.
 *
 * Null is a real answer on most of these columns — `current_period_end` is null for `one_time`, and
 * `trial_ends_at` for a subscription that never had a trial — so the caller decides what to render
 * in its place rather than being handed a dash it cannot distinguish from a formatting failure.
 */
export function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Which transitions the record's current state permits, in the catalogue's own order. */
export function allowedTransitions(
  catalogue: SubscriptionCatalogue | null,
  state: string
): TransitionSpec[] {
  if (!catalogue) return [];
  return catalogue.transitions.filter((transition) => transition.from.includes(state));
}

/**
 * What an operator has to do before a plan change or an add-on purchase can happen — `"Activate it
 * first."`, `"Resume it first."`, `"Reactivate it first."`.
 *
 * Both routes refuse a subscription outside `usableStates`, and the remedy differs by state: a
 * pending subscription is activated, a paused one resumed, and only suspended, expired or cancelled
 * ones reactivated. The API's own refusal once said "Reactivate it first" to all five, which sent an
 * operator looking for a button this screen does not show on a pending row. So the answer is read off
 * the transition table — the edges out of this state that land in a usable one — rather than written
 * out a second time here.
 */
export function howToBringIntoUse(catalogue: SubscriptionCatalogue | null, state: string): string {
  if (!catalogue) return 'It has to be brought back into use first.';
  const actions = allowedTransitions(catalogue, state)
    .filter((transition) => catalogue.usableStates.includes(transition.to))
    .map((transition) => humanise(transition.action));
  return actions.length === 0
    ? 'It has to be brought back into use first.'
    : `${actions.join(' or ')} it first.`;
}

/**
 * A limit key as the catalogue labels it — `student_limit` → `Student Limit` — or the key itself.
 *
 * `limitTargets` is `LIMIT_LABELS` over all nine `USAGE_LIMIT_KEYS`, the add-on-only `sms_limit`
 * included, so an add-on's `effect_target` and a limit override's `target_key` both resolve here.
 */
export function limitLabel(catalogue: SubscriptionCatalogue | null, key: string): string {
  return catalogue?.limitTargets.find((limit) => limit.key === key)?.label ?? key;
}

/** The fields a plan or add-on price shares with a subscription about when and how it bills. */
interface Billing {
  billing_cycle: string;
  cycle_days: number | null;
  currency: string;
}

/**
 * Whether a price row bills on the same cycle this subscription bills on now.
 *
 * `cycle_days` counts only for `custom_days`, the one cycle whose length its name does not imply —
 * `plans.validation` lets a monthly row carry a stray `cycle_days`, and nothing reads it there. The
 * same rule `purchaseAddon()` applies when it refuses a price on another cycle.
 */
export function sameCycle(price: Billing, subscription: Billing): boolean {
  if (price.billing_cycle !== subscription.billing_cycle) return false;
  return (
    price.billing_cycle !== 'custom_days' ||
    Number(price.cycle_days) === Number(subscription.cycle_days)
  );
}

/** `Monthly`, or `Custom days (45)` — the length is part of what a custom cycle is. */
export function cycleLabel(billing: Pick<Billing, 'billing_cycle' | 'cycle_days'>): string {
  return billing.billing_cycle === 'custom_days' && billing.cycle_days
    ? `${humanise(billing.billing_cycle)} (${billing.cycle_days})`
    : humanise(billing.billing_cycle);
}
