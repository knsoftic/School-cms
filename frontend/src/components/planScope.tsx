'use client';

/**
 * The plan picker shared by §33's Modules, Features and Limits screens.
 *
 * ## Why these three screens need one
 *
 * §33 names Modules, Features and Limits as screens. The API has no collection behind any of them:
 * they are `PUT /plans/{id}/modules`, `…/features` and `…/limits` — sub-resources of a plan, edited
 * through the plan that owns them. There is no "all modules across all plans" to list, and there
 * could not be: a module key means nothing on its own, only whether *this plan* includes it.
 *
 * So each screen asks which plan first, exactly as Sections asks which class. That is not a
 * workaround for a missing endpoint — it is the question the endpoint answers.
 *
 * The chosen plan lives in the URL (`?plan=3`), so the screen survives a reload and can be linked.
 *
 * ## Two requests, and both are needed
 *
 * `/plans` fills the picker. `/plans/{id}` returns that plan **with its modules, features, limits and
 * prices included** (`plans.service.js:84` `DETAIL_INCLUDE`), which is what each screen renders.
 * `/plans/catalogue` supplies the vocabulary for Modules and Limits — §11's twenty module keys and
 * eight limit keys with their units — so those two screens can show what a plan *could* include and
 * not merely what it does.
 *
 * Features needs no catalogue and has none: there is no feature vocabulary anywhere in the codebase,
 * and `plan_features` carries its own `name` per row. That asymmetry is real and is why the three
 * screens are three files rather than one with a switch.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useCollection, EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { EmptyNotice, ErrorNotice, LoadingBlock, RefusalNotice } from '@/components/table';

export interface PlanRow {
  id: number;
  name: string;
  code: string;
  status: string;
}

export interface PlanModule {
  id: number;
  module_key: string;
  is_enabled: boolean;
}

export interface PlanFeature {
  id: number;
  feature_key: string;
  name: string | null;
  is_enabled: boolean;
  value: unknown;
  module_key: string | null;
  display_order: number | null;
}

export interface PlanLimit {
  id: number;
  limit_key: string;
  limit_type: string;
  limit_value: number | null;
  unit: string | null;
  allow_overage: boolean;
  overage_unit_amount: string | number | null;
}

export interface PlanDetail extends PlanRow {
  modules: PlanModule[];
  features: PlanFeature[];
  limits: PlanLimit[];
}

/** `GET /plans/catalogue` — §11's fixed vocabulary. Features are absent from it by design. */
export interface Catalogue {
  modules: { key: string; label: string }[];
  limits: { key: string; label: string; unit: string | null; types: string[] }[];
}

/** The plan chosen in the URL, and a setter that keeps it there. */
export function useSelectedPlan(): [string | null, (id: string) => void] {
  const router = useRouter();
  const params = useSearchParams();

  const selected = params.get('plan');

  const select = (id: string) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('plan', id);
    else next.delete('plan');
    router.replace(`?${next.toString()}`, { scroll: false });
  };

  return [selected, select];
}

/**
 * Load one plan with everything `DETAIL_INCLUDE` attaches, and optionally the catalogue.
 *
 * Returns `null` for the detail until a plan is chosen, rather than fetching `/plans/undefined`.
 */
export function usePlanDetail(planId: string | null, withCatalogue: boolean) {
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!planId) {
      setDetail(null);
      return undefined;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);

    (async () => {
      try {
        const [plan, cat] = await Promise.all([
          api.get<{ plan: PlanDetail }>(`/plans/${planId}`, { signal: controller.signal }),
          withCatalogue
            ? api.get<Catalogue>('/plans/catalogue', { signal: controller.signal })
            : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return;
        /* `show` wraps its payload: `{ plan: … }`, unlike the list, which returns rows directly. */
        setDetail(plan.plan);
        if (cat) setCatalogue(cat);
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
  }, [planId, withCatalogue, nonce]);

  return { detail, catalogue, loading, error, refusal, reload: () => setNonce((n) => n + 1) };
}

/** The picker itself, plus the states that belong to loading the plan list. */
export function PlanPicker({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const plans = useCollection<PlanRow>('/plans', { limit: 100 });

  if (plans.refusal) return <RefusalNotice refusal={plans.refusal} />;
  if (plans.error) return <ErrorNotice message={plans.error} onRetry={plans.reload} />;
  if (plans.loading) return <LoadingBlock />;
  if (plans.rows.length === 0) {
    return <EmptyNotice>No plans exist yet. Create one before configuring what it includes.</EmptyNotice>;
  }

  return (
    <div className="mb-5 max-w-sm">
      <label htmlFor="plan-picker" className="block text-sm font-medium">
        Plan
      </label>
      <select
        id="plan-picker"
        value={selected ?? ''}
        onChange={(event) => onSelect(event.target.value)}
        className="field-select"
      >
        <option value="">Choose a plan…</option>
        {plans.rows.map((plan) => (
          <option key={plan.id} value={plan.id}>
            {plan.name} ({plan.code})
          </option>
        ))}
      </select>
    </div>
  );
}
