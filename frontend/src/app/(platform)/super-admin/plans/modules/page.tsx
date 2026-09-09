'use client';

/**
 * Plan modules — SRS §11, §33's Super Admin "Modules", checklist row 4.3.
 *
 * §33 names this a screen; the API models it as `PUT /plans/{id}/modules`, a sub-resource of a plan.
 * So the screen asks which plan first — see `components/planScope.tsx` for why that is the question
 * rather than a workaround.
 *
 * ## The catalogue is what makes this readable
 *
 * `GET /plans/{id}` returns only the `plan_modules` rows that exist. Rendering those alone would show
 * what a plan *has* and give no way to see what it is *missing* — and "which modules is this plan
 * short of" is the question someone opens this screen with. `GET /plans/catalogue` supplies §11's
 * twenty keys with their labels, so every module appears with its state and the absent ones are
 * visible as absent.
 *
 * Read-only for now: `PUT /plans/{id}/modules` replaces the whole set, so an editor here has to send
 * every module at once and is a form rather than a toggle. That is the next increment, and building
 * a toggle that silently dropped the others would be worse than showing the state honestly.
 */

import { Suspense } from 'react';

import {
  Catalogue,
  PlanDetail,
  PlanPicker,
  usePlanDetail,
  useSelectedPlan,
} from '@/components/planScope';
import { EmptyNotice, ErrorNotice, LoadingBlock, PageHeader, RefusalNotice, StatusBadge } from '@/components/table';

function ModuleGrid({ detail, catalogue }: { detail: PlanDetail; catalogue: Catalogue }) {
  /*
   * Keyed by module rather than filtered, so a `plan_modules` row naming a key the catalogue does not
   * contain is still visible. That should be impossible — §11 fixes the twenty and `plans.validation`
   * checks them — but a row written before a key was renamed would otherwise vanish silently, and an
   * invisible row is the hardest kind to debug.
   */
  const enabledByKey = new Map(detail.modules.map((row) => [row.module_key, row.is_enabled]));
  const known = new Set(catalogue.modules.map((entry) => entry.key));
  const orphans = detail.modules.filter((row) => !known.has(row.module_key));

  const included = catalogue.modules.filter((entry) => enabledByKey.get(entry.key) === true).length;

  return (
    <>
      <p className="mb-3 text-sm">
        <strong className="tabular-nums">{included}</strong> of {catalogue.modules.length} modules
        included in <strong>{detail.name}</strong>.
      </p>

      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {catalogue.modules.map((entry) => {
          const state = enabledByKey.get(entry.key);
          return (
            <li
              key={entry.key}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium">{entry.label}</span>
                <code className="block text-xs text-muted-soft">{entry.key}</code>
              </span>
              {/*
               * Three states, not two. A module with no row at all is not the same as one with a row
               * saying `is_enabled: false` — the first has never been configured, the second was
               * turned off deliberately — and `PUT /plans/{id}/modules` treats them differently.
               */}
              <StatusBadge status={state === true ? 'active' : state === false ? 'inactive' : 'draft'} />
            </li>
          );
        })}
      </ul>

      {orphans.length > 0 ? (
        <p className="mt-4 rounded-md border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn">
          This plan carries {orphans.length} module row{orphans.length === 1 ? '' : 's'} naming a key
          that is not in §11’s catalogue: {orphans.map((row) => row.module_key).join(', ')}.
        </p>
      ) : null}
    </>
  );
}

function ModulesScreen() {
  const [selected, select] = useSelectedPlan();
  const { detail, catalogue, loading, error, refusal, reload } = usePlanDetail(selected, true);

  return (
    <div>
      <PageHeader
        title="Plan modules"
        description="Which of §11’s twenty modules a plan includes. Choose the plan first."
      />

      <PlanPicker selected={selected} onSelect={select} />

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading ? (
        <LoadingBlock />
      ) : !selected ? (
        <EmptyNotice>Choose a plan above to see the modules it includes.</EmptyNotice>
      ) : detail && catalogue ? (
        <ModuleGrid detail={detail} catalogue={catalogue} />
      ) : null}
    </div>
  );
}

export default function PlanModulesPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <ModulesScreen />
    </Suspense>
  );
}
