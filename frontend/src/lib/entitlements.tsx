'use client';

/**
 * Module, feature and limit gating — SRS §30 Rule 1, `docs/ARCHITECTURE.md` §8, checklist row 4.10.
 *
 * Rule 1 is short and absolute: *"Subscription plans, modules, limits and prices must be
 * database-driven. Plan names must not be hard-coded."* It even gives the wrong shape by name —
 * `if (plan == premium)`. This file is the reason no screen ever needs to write that.
 *
 * ## Why there is no fetch here
 *
 * §8 describes this provider as fetching the snapshot. It arrives on `GET /auth/me` instead, beside
 * the permissions, and that is a deliberate narrowing rather than a shortcut:
 *
 *   - the navigation cannot render until permissions *and* modules are both known, so two calls
 *     would mean a flash of the wrong menu or a spinner across the whole shell;
 *   - they expire together — a refresh re-reads permissions from the database, and entitlements
 *     from the same response cannot drift out of step with them;
 *   - a separate endpoint would need a permission to guard it, and §29/§35 fix the catalogue at 109
 *     with no entry for one.
 *
 * ## What this deliberately does not expose
 *
 * `useEntitlements()` returns `hasModule`, `hasFeature` and `limitFor` — and **not** the plan. The
 * plan is reachable through `useAuth()` for display ("You are on the Standard plan"), which Rule 1
 * permits; what it forbids is branching on it. Keeping it out of the gating API means the wrong
 * shape is not merely discouraged, it is unavailable: there is no plan name in scope to compare.
 */

import { createContext, useCallback, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

import { useAuth } from './auth';

/** One plan limit, as `entitlementService` resolves it. */
export interface Limit {
  key: string;
  type: string;
  value: number | null;
  baseValue: number | null;
  addonUnits: number;
  unit: string | null;
  allowOverage: boolean;
  overageUnitAmount: string | number | null;
  source: string;
}

/** One plan feature. */
export interface Feature {
  enabled: boolean;
  value: unknown;
  source: string;
}

export interface Subscription {
  id: number;
  planId: number;
  state: string;
  isUsable: boolean;
  billingCycle: string;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  gracePeriodEndsAt: string | null;
  renewalMode: string;
}

export interface Entitlements {
  schoolId: number;
  organizationId: number | null;
  /*
   * **Nullable, and this was the bug.** `entitlementService.js:266` answers `subscription: null`
   * for a school that has none — a school created before billing is set up, which is an ordinary
   * state. Declaring it non-nullable hid the dereference below from TypeScript, and the provider
   * that wraps every school screen threw `Cannot read properties of null (reading 'isUsable')`,
   * so a principal of such a school met Next's error boundary instead of their dashboard.
   */
  subscription: Subscription | null;
  /* Nullable for the same reason `subscription` is: `entitlementService.js:267` nulls the two
   * together, because the plan is reached through the subscription. */
  plan: { id: number; code: string; name: string; tierRank: number } | null;
  modules: Record<string, boolean>;
  features: Record<string, Feature>;
  limits: Record<string, Limit>;
  resolvedAt: string;
}

interface EntitlementState {
  /** Null for a platform or organization caller — they are gated by permission, never by plan. */
  entitlements: Entitlements | null;
  /** True when this caller's access is decided by a subscription at all. */
  isSubscriptionScoped: boolean;
  /** False when the subscription has expired or been suspended; the UI should say so. */
  isUsable: boolean;
  hasModule: (moduleKey: string) => boolean;
  hasFeature: (featureKey: string) => boolean;
  limitFor: (limitKey: string) => Limit | null;
}

const EntitlementContext = createContext<EntitlementState | null>(null);

export function EntitlementProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const entitlements = (profile?.entitlements ?? null) as Entitlements | null;

  /*
   * A platform caller has no snapshot, and every gate must answer TRUE for them. Super Admin screens
   * are gated by permission and never by subscription — answering `false` because there is no
   * snapshot would hide the platform surface from the only role that can use it.
   */
  const isSubscriptionScoped = entitlements !== null;

  const hasModule = useCallback(
    (moduleKey: string) => (entitlements ? entitlements.modules[moduleKey] === true : true),
    [entitlements]
  );

  const hasFeature = useCallback(
    (featureKey: string) => (entitlements ? entitlements.features[featureKey]?.enabled === true : true),
    [entitlements]
  );

  const limitFor = useCallback(
    (limitKey: string) => entitlements?.limits[limitKey] ?? null,
    [entitlements]
  );

  const value = useMemo<EntitlementState>(
    () => ({
      entitlements,
      isSubscriptionScoped,
      /*
       * No snapshot means nothing to be unusable — a platform caller is never blocked by billing.
       * A snapshot with **no subscription** is the same answer for the same reason: there is no
       * billing state to be in. Its modules resolve empty, so each gated screen still refuses on
       * its own terms, which is a more useful message than one global banner.
       */
      isUsable: entitlements && entitlements.subscription ? entitlements.subscription.isUsable : true,
      hasModule,
      hasFeature,
      limitFor,
    }),
    [entitlements, isSubscriptionScoped, hasModule, hasFeature, limitFor]
  );

  return <EntitlementContext.Provider value={value}>{children}</EntitlementContext.Provider>;
}

export function useEntitlements(): EntitlementState {
  const context = useContext(EntitlementContext);
  if (!context) throw new Error('useEntitlements() must be used inside <EntitlementProvider>');
  return context;
}
