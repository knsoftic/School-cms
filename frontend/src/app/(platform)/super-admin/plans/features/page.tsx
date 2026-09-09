'use client';

/**
 * Plan features — SRS §11, §33's Super Admin "Features", checklist row 4.3.
 *
 * ## The one of the three with no catalogue, and that is not an omission
 *
 * Modules and Limits render against `GET /plans/catalogue`, which supplies §11's twenty module keys
 * and eight limit keys. **It returns no features**, and there is no feature vocabulary anywhere in
 * the codebase — no `FEATURE_LIST`, no feature constant in `config/constants.js`, nothing.
 *
 * That was recorded earlier as a §33-versus-API mismatch, and it is a real one — but it is not a
 * blocker, because `plan_features` carries its own `name` and `module_key` per row. A feature is
 * self-describing: it is whatever a plan says it is. So this screen shows the features a plan
 * actually has, and cannot show what it is missing, because "missing" is undefined for a vocabulary
 * that does not exist. The empty state says exactly that rather than implying the data failed to
 * load.
 *
 * ## `value` is a nullable string, and this header used to say otherwise
 *
 * It claimed `plan_features.value` was *"a JSON column with no schema: a feature may be a boolean
 * toggle, a number, or a string"*. The model says `value: { type: DataTypes.STRING(120), allowNull:
 * true }` — one type, and the column's own comment is *"Feature value when a feature is more than a
 * boolean (e.g. a retention window)"*. The boolean itself lives in the separate `is_enabled` column,
 * which is what the shape of this table actually is.
 *
 * So the renderer's boolean, number and `JSON.stringify` branches were unreachable. It is still
 * typed `unknown` and still narrows before rendering, and that is now a stated defence rather than a
 * belief about the column: this screen reads a payload, `STRING(120)` is what the schema promises
 * today, and a cell should degrade rather than throw if that promise ever changes.
 */

import { Suspense } from 'react';

import { PlanDetail, PlanPicker, usePlanDetail, useSelectedPlan } from '@/components/planScope';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';
import type { PlanFeature } from '@/components/planScope';

/** A JSON value rendered without pretending to know its shape. */
function featureValue(value: unknown) {
  if (value === null || value === undefined) return <span className="text-muted-soft">—</span>;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return <code className="text-xs">{JSON.stringify(value)}</code>;
}

function FeatureTable({ detail }: { detail: PlanDetail }) {
  /*
   * `display_order` first, then key — the column exists to let an administrator control the order,
   * and ignoring it here would make this screen disagree with wherever else features are shown.
   * Sorted on a copy: the array belongs to the fetched object and mutating it would reorder state.
   */
  const rows = [...detail.features].sort(
    (a, b) =>
      (a.display_order ?? Number.MAX_SAFE_INTEGER) - (b.display_order ?? Number.MAX_SAFE_INTEGER) ||
      a.feature_key.localeCompare(b.feature_key)
  );

  const columns: Column<PlanFeature>[] = [
    {
      key: 'feature',
      header: 'Feature',
      cell: (row) => (
        <>
          <span className="block font-medium">{row.name ?? row.feature_key}</span>
          {row.name ? <code className="block text-xs text-muted-soft">{row.feature_key}</code> : null}
        </>
      ),
    },
    {
      key: 'module',
      header: 'Module',
      /*
       * A feature may belong to a module or stand alone. Naming the module matters because a feature
       * inside an unsubscribed module is unreachable whatever its own flag says.
       */
      cell: (row) =>
        row.module_key ? row.module_key.replace(/_/g, ' ') : <span className="text-muted-soft">standalone</span>,
    },
    { key: 'enabled', header: 'Status', cell: (row) => <StatusBadge status={row.is_enabled ? 'active' : 'inactive'} /> },
    { key: 'value', header: 'Value', cell: (row) => featureValue(row.value) },
  ];

  const enabled = rows.filter((row) => row.is_enabled).length;

  return (
    <>
      <p className="mb-3 text-sm">
        <strong className="tabular-nums">{enabled}</strong> of {rows.length} features enabled on{' '}
        <strong>{detail.name}</strong>.
      </p>
      <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Plan features" />
    </>
  );
}

function FeaturesScreen() {
  const [selected, select] = useSelectedPlan();
  /* No catalogue: there is no feature vocabulary to fetch. */
  const { detail, loading, error, refusal, reload } = usePlanDetail(selected, false);

  return (
    <div>
      <PageHeader
        title="Plan features"
        description="What a plan switches on beyond its modules. Choose the plan first."
      />

      <PlanPicker selected={selected} onSelect={select} />

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading ? (
        <LoadingBlock />
      ) : !selected ? (
        <EmptyNotice>Choose a plan above to see its features.</EmptyNotice>
      ) : detail && detail.features.length === 0 ? (
        <EmptyNotice>
          This plan has no features configured. Unlike modules and limits there is no fixed list to
          compare against — a feature is whatever a plan defines, so there is nothing here yet rather
          than something missing.
        </EmptyNotice>
      ) : detail ? (
        <FeatureTable detail={detail} />
      ) : null}
    </div>
  );
}

export default function PlanFeaturesPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <FeaturesScreen />
    </Suspense>
  );
}
