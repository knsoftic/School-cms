'use client';

/**
 * Plan limits — SRS §11.2, §33's Super Admin "Limits", checklist row 4.3.
 *
 * Plan-scoped for the same reason as Modules: the API models this as `PUT /plans/{id}/limits`, and a
 * limit key means nothing on its own — only what *this plan* allows. See `components/planScope.tsx`.
 *
 * ## `unlimited` is not a very large number
 *
 * `LIMIT_TYPES` is `fixed` or `unlimited`, and the two are stored differently: an unlimited limit
 * carries a null `limit_value`. Rendering that null as "0" or as an em-dash would both be wrong in
 * the same direction — one says nothing is allowed, the other says nothing is known. The word is
 * shown instead.
 *
 * ## Overage is a separate axis
 *
 * A limit can be exceeded (`allow_overage`) at a price per unit, which is why a school can pass its
 * student ceiling and be billed rather than blocked. That is two facts about one row, so the column
 * shows both or says "hard limit" — a blank would read as "no overage price set" rather than "going
 * over is refused".
 */

import { Suspense } from 'react';

import {
  Catalogue,
  PlanDetail,
  PlanPicker,
  usePlanDetail,
  useSelectedPlan,
} from '@/components/planScope';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
} from '@/components/table';

interface LimitRow {
  key: string;
  label: string;
  unit: string | null;
  type: string | null;
  value: number | null;
  allowOverage: boolean;
  overageAmount: string | number | null;
  configured: boolean;
}

function LimitTable({ detail, catalogue }: { detail: PlanDetail; catalogue: Catalogue }) {
  const byKey = new Map(detail.limits.map((row) => [row.limit_key, row]));

  /*
   * Every catalogue limit appears, configured or not. §11.2 fixes eight keys, and a plan that has
   * never had one set is a real and important state — `entitlementService` falls back to a default
   * for it, so "not configured" is not the same as "zero".
   */
  const rows: LimitRow[] = catalogue.limits.map((entry) => {
    const row = byKey.get(entry.key);
    return {
      key: entry.key,
      label: entry.label,
      unit: row?.unit ?? entry.unit,
      type: row?.limit_type ?? null,
      value: row?.limit_value ?? null,
      allowOverage: Boolean(row?.allow_overage),
      overageAmount: row?.overage_unit_amount ?? null,
      configured: Boolean(row),
    };
  });

  const columns: Column<LimitRow>[] = [
    {
      key: 'limit',
      header: 'Limit',
      cell: (row) => (
        <>
          <span className="block font-medium">{row.label}</span>
          <code className="block text-xs text-muted-soft">{row.key}</code>
        </>
      ),
    },
    {
      key: 'allowance',
      header: 'Allowance',
      numeric: true,
      cell: (row) => {
        if (!row.configured) return <span className="text-muted-soft">not configured</span>;
        if (row.type === 'unlimited') return <span className="font-medium">unlimited</span>;
        return (
          <span className="font-medium tabular-nums">
            {row.value ?? 0}
            {row.unit ? <span className="ml-1 font-normal text-muted-soft">{row.unit}</span> : null}
          </span>
        );
      },
    },
    {
      key: 'overage',
      header: 'Over the limit',
      cell: (row) => {
        if (!row.configured) return <span className="text-muted-soft">—</span>;
        if (row.type === 'unlimited') return <span className="text-muted-soft">n/a</span>;
        if (!row.allowOverage) return 'hard limit';
        const price = row.overageAmount === null ? null : Number(row.overageAmount);
        return price !== null && Number.isFinite(price)
          ? `billed at ${price.toFixed(2)} per ${row.unit ?? 'unit'}`
          : 'billed (no price set)';
      },
    },
  ];

  const configured = rows.filter((row) => row.configured).length;

  return (
    <>
      <p className="mb-3 text-sm">
        <strong className="tabular-nums">{configured}</strong> of {rows.length} limits configured on{' '}
        <strong>{detail.name}</strong>.
      </p>
      <DataTable columns={columns} rows={rows} rowKey={(row) => row.key} caption="Plan limits" />
    </>
  );
}

function LimitsScreen() {
  const [selected, select] = useSelectedPlan();
  const { detail, catalogue, loading, error, refusal, reload } = usePlanDetail(selected, true);

  return (
    <div>
      <PageHeader
        title="Plan limits"
        description="§11.2’s eight limit keys, and what a plan allows for each."
      />

      <PlanPicker selected={selected} onSelect={select} />

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading ? (
        <LoadingBlock />
      ) : !selected ? (
        <EmptyNotice>Choose a plan above to see its limits.</EmptyNotice>
      ) : detail && catalogue ? (
        <LimitTable detail={detail} catalogue={catalogue} />
      ) : null}
    </div>
  );
}

export default function PlanLimitsPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <LimitsScreen />
    </Suspense>
  );
}
