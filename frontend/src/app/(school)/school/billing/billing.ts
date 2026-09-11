'use client';

/**
 * The school's own billing — the shapes its screens read, the one subscription read they share, and
 * the few rules each of them would otherwise restate.
 *
 * The owner's decision D27 built this screen: FR-SUB-013/014/015 and FR-BILL-003/005 name the school
 * as an actor, and school leadership held the keys to change its plan and to pay but not the reads
 * those actions need. The platform's own billing screens under `super-admin/` already do most of these
 * operations for the Super Admin; nothing is imported from them, because the codebase does not import
 * across route groups, and because what a school is shown differs — its own records only, and in
 * words for a reader who did not configure any of it.
 *
 * ## Every read here is the school's own because the API makes it so
 *
 * `GET /subscriptions`, `/invoices` and `/payments` all start from `tenantWhere()`, so a school caller
 * receives its own rows and nothing wider; nothing on these screens sends a `school_id`. `GET /plans`
 * is confined to the active public plans (`plans.service.scopeFor()`) and `GET /addons` to the active
 * add-ons and the prices the school's own plan may buy (`addons.service.detailInclude()`).
 *
 * ## Money is formatted here and never worked out
 *
 * Every figure — a cycle amount, a proration, a discount, what an invoice still owes — is the server's.
 * `lib/money.ts` formats; nothing on these screens adds, subtracts or multiplies an amount.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/* ─────────────────────────────── the subscription ─────────────────────────────── */

/** The plan a subscription points at, as `subscriptions.service.detailInclude()` loads it. */
export interface PlanRef {
  id: number;
  name: string;
  code: string;
  /** *"Higher rank = higher tier"* — read only to choose the upgrade or the downgrade route. */
  tier_rank: number;
}

/** One `subscription_addons` row — the purchase copy, fixed when it was bought. */
export interface SubscriptionAddonRow {
  id: number;
  addon_id: number;
  quantity: number;
  status: string;
  effect_type: string;
  effect_target: string;
  units_granted: number | string | null;
  unit_amount: number | string | null;
  currency: string | null;
  is_recurring: boolean;
  starts_at: string | null;
  ends_at: string | null;
  addon: { id: number; key: string; name: string } | null;
}

/** One `subscription_overrides` row. `is_effective` is the service's own reading of its window. */
export interface SubscriptionOverrideRow {
  id: number;
  override_type: string;
  target_key: string;
  amount: number | string | null;
  is_active: boolean;
  is_effective: boolean;
}

/** `subscriptions.service.standing()` — derived by the server, read here and never recomputed. */
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
  creditBalance: number;
}

/**
 * One row of `GET /subscriptions`, narrowed to what these screens read.
 *
 * Money arrives as a JS number (`config/database.js` sets `decimalNumbers`); the union with `string`
 * is the defence `lib/money.ts` describes, so flipping that one option cannot break a figure.
 */
export interface OwnSubscription {
  id: number;
  plan_id: number;
  state: string;
  billing_cycle: string;
  cycle_days: number | null;
  /** Copied from the price row the subscription bills from — SRS §10.4's five models. */
  pricing_model: string;
  currency: string;
  cycle_amount: number | string;
  quantity: number;
  credit_balance: number | string;
  /** §13.2's wallet — credited by refunds to it and spent by approved wallet payments (D5). */
  wallet_balance: number | string;
  grace_period_days: number;
  renewal_mode: string;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  next_renewal_at: string | null;
  grace_period_ends_at: string | null;
  scheduled_change_at: string | null;
  plan: PlanRef | null;
  scheduledPlan: PlanRef | null;
  addons: SubscriptionAddonRow[];
  overrides: SubscriptionOverrideRow[];
  standing: SubscriptionStanding;
}

/** The parts of `GET /subscriptions/catalogue` these screens read — the §12 vocabulary. */
export interface SubscriptionVocabulary {
  downgradeTimings: string[];
  limitTargets: { key: string; label: string; unit: string | null }[];
  expiringWindowDays: number;
}

export interface OwnSubscriptionScope {
  /** Null when the school has no subscription at all, which is an ordinary state before billing starts. */
  subscription: OwnSubscription | null;
  vocabulary: SubscriptionVocabulary | null;
  loading: boolean;
  error: string | null;
  refusal: Refusal | null;
  reload: () => void;
  /**
   * Take the record a write returned. Every subscription write answers with the whole
   * `{ subscription }` after its transaction, so the response is the reload — and adopting it removes
   * the moment in which the old record sits beside a toast saying the change was made.
   */
  adopt: (subscription: OwnSubscription) => void;
}

/**
 * Which of the school's subscription rows is "the" subscription.
 *
 * A school accumulates rows — a cancelled one, an expired one, then a new one — so it has to be
 * chosen. The order is `entitlementService.findGoverningSubscription()`'s, which is what decides what
 * the school may use: a usable row wins, and failing that the most recent (`GET /subscriptions` lists
 * newest first). Between the two sits an **open** row — pending, paused, suspended — because
 * `subscriptions.service.create()` refuses a second open subscription per school, so an open row is
 * the one billing is still about even when it grants nothing today.
 */
function currentOf(rows: OwnSubscription[]): OwnSubscription | null {
  return (
    rows.find((row) => row.standing?.isUsable)
    ?? rows.find((row) => row.standing?.isOpen)
    ?? rows[0]
    ?? null
  );
}

/**
 * The school's subscription and the §12 vocabulary, read once for every panel that needs them.
 *
 * `enabled` is `subscriptions.self.view`: an Accountant holds `invoices.self.view` without it, and a
 * read that could only be refused is not sent.
 */
export function useOwnSubscription(enabled: boolean): OwnSubscriptionScope {
  const [subscription, setSubscription] = useState<OwnSubscription | null>(null);
  const [vocabulary, setVocabulary] = useState<SubscriptionVocabulary | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);

    (async () => {
      try {
        /*
         * One page of a hundred — `PAGINATION.MAX_LIMIT` — is every row a school will realistically
         * hold, and the list read already carries the detail includes (plan, add-ons, overrides) and
         * the `standing` block, so no second request per row is needed.
         */
        const [rows, catalogue] = await Promise.all([
          api.get<OwnSubscription[]>('/subscriptions', {
            query: { limit: 100 },
            signal: controller.signal,
          }),
          api.get<SubscriptionVocabulary>('/subscriptions/catalogue', { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setSubscription(currentOf(rows ?? []));
        setVocabulary(catalogue);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
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
  }, [enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const adopt = useCallback((next: OwnSubscription) => setSubscription(next), []);

  return { subscription, vocabulary, loading, error, refusal, reload, adopt };
}

/* ─────────────────────────────── invoices and payments ─────────────────────────────── */

/** One `invoice_items` row. `quantity` is `DECIMAL(12,2)`, not money. */
export interface InvoiceLine {
  id: number;
  item_type: string;
  description: string;
  quantity: number;
  unit_amount: number;
  amount: number;
  period_start: string | null;
  period_end: string | null;
}

/** One entry of `addons_summary` — the invoice's add-on lines, copied for the §13.1 field. */
export interface AddonSummary {
  addon_id: number | null;
  description: string;
  quantity: number;
  amount: number;
}

/**
 * A payment as `invoices.controller.present()` joins it onto an invoice: the row, with
 * `screenshot_path` replaced by `has_screenshot`.
 *
 * `rejection_reason` is read because it is written for the school — by the reviewer, whose dialog says
 * *"the school is told the payment was rejected, and shown the reason you give"*, or from a gateway's
 * decline on a failed payment. The reviewer's internal note is not sent to a school caller at all.
 */
export interface InvoicePayment {
  id: number;
  payment_number: string;
  method: string;
  currency: string;
  amount: number;
  status: string;
  transaction_id: string | null;
  has_screenshot: boolean;
  rejection_reason: string | null;
  paid_at: string | null;
  created_at: string;
}

/**
 * One invoice — a row of `GET /invoices` or the body of `GET /invoices/:id`, which carry the same
 * `detailInclude()` joins and the two figures `present()` derives.
 */
export interface Invoice {
  id: number;
  invoice_number: string;
  subscription_id: number | null;
  /** §13.1 Plan — the id `applyCoupon()` checks a plan-restricted coupon against. */
  plan_id: number | null;
  /** *"Snapshot at issue time"* — what was billed, not the subscription's plan today. */
  plan_name: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  billing_cycle: string | null;
  currency: string;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  credit_applied: number;
  amount_paid: number;
  amount_due: number;
  coupon_id: number | null;
  coupon_code: string | null;
  tax_rate_percent: number | null;
  /** `DATEONLY` — a calendar day with no instant behind it. */
  issue_date: string;
  due_date: string;
  status: string;
  notes: string | null;
  addons_summary: AddonSummary[] | null;
  tax: { id: number; name: string } | null;
  items?: InvoiceLine[];
  payments?: InvoicePayment[];
  /** Past its due date while still owed — derived per request, so it is right before the sweep runs. */
  is_overdue: boolean;
  tax_is_inclusive: boolean;
}

/** The payment `POST /payments` answers with — `payments.controller.present()`. */
export interface SubmittedPayment {
  id: number;
  payment_number: string;
  invoice_id: number | null;
  method: string;
  currency: string;
  amount: number;
  status: string;
}

/**
 * The statuses a payment can be submitted against: `invoices.service.PAYABLE_STATUSES`, which is
 * `OUTSTANDING_STATUSES`. A draft is not yet a demand and a paid or cancelled invoice owes nothing, so
 * `loadInvoiceForPayment()` refuses all three with `INVOICE_NOT_PAYABLE`.
 */
export const PAYABLE_STATUSES = ['unpaid', 'partially_paid', 'overdue'];

/**
 * Whether `applyCoupon()` would take a coupon on this invoice: a `draft` or `unpaid` one
 * (`MUTABLE_STATUSES`), with nothing paid against it yet (`INVOICE_HAS_PAYMENTS`), and no coupon
 * already on it (`INVOICE_COUPON_PRESENT` — `invoices.coupon_id` is one column).
 */
export function takesCoupon(invoice: Pick<Invoice, 'status' | 'amount_paid' | 'coupon_id'>): boolean {
  return (
    (invoice.status === 'draft' || invoice.status === 'unpaid')
    && Number(invoice.amount_paid) === 0
    && !invoice.coupon_id
  );
}

/* ─────────────────────────────── words and dates ─────────────────────────────── */

/** `past_due` → `Past due`, `next_billing_cycle` → `Next billing cycle`. */
export function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** `Monthly`, or `Custom days (45)` — the length is part of what a custom cycle is. */
export function cycleLabel(billing: { billing_cycle: string; cycle_days: number | null }): string {
  return billing.billing_cycle === 'custom_days' && billing.cycle_days
    ? `${humanise(billing.billing_cycle)} (${billing.cycle_days} days)`
    : humanise(billing.billing_cycle);
}

/**
 * Whether a price bills on the subscription's own cycle — the same `billing_cycle`, and for
 * `custom_days` the same number of days. `subscriptions.service.sameCycle()` and the add-on purchase's
 * `ADDON_PRICE_CYCLE_MISMATCH` apply the same rule.
 */
export function sameCycle(
  price: { billing_cycle: string; cycle_days: number | null },
  subscription: { billing_cycle: string; cycle_days: number | null }
): boolean {
  if (price.billing_cycle !== subscription.billing_cycle) return false;
  return (
    price.billing_cycle !== 'custom_days'
    || Number(price.cycle_days) === Number(subscription.cycle_days)
  );
}

/*
 * Constructed once, and pinned to UTC — the zone the platform's own billing screens show the same
 * periods in, so a school and the Super Admin looking at one invoice read the same days.
 */
const DAY = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** An instant as its UTC day; null for nothing, or for text that is not a date. */
export function utcDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : DAY.format(date);
}

/**
 * A `DATEONLY` value — `issue_date`, `due_date` — as a readable day.
 *
 * Read as UTC midnight and printed in UTC, so the calendar day that was stored is the day shown:
 * handing `2026-09-30` to `new Date()` in the viewer's zone would move it west of UTC.
 */
export function calendarDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? String(value) : DAY.format(date);
}

/** A period as two UTC days, or its start alone when it has no end (a one-time subscription). */
export function periodLabel(start: string | null, end: string | null): string | null {
  const from = utcDay(start);
  if (!from) return null;
  const to = utcDay(end);
  return to ? `${from} – ${to}` : `From ${from}`;
}

/** The four methods a school may submit — `payments.validation.js` `SUBMITTABLE_METHODS`. */
export const SUBMITTABLE_METHODS = ['bank_transfer', 'cash', 'manual_payment', 'wallet'];

/** `bank_transfer` → `Bank transfer`. */
export const methodLabel = (method: string) => humanise(method);

/** Count formatting pinned to `en-US`, as `lib/money.ts` pins its own. */
const COUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** A count as grouped digits; a BIGINT that arrives as a string is shown as it came. */
export function formatCount(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? COUNT.format(numeric) : String(value);
}
