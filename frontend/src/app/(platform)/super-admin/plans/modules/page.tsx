'use client';

/**
 * Plan modules — SRS §11, §33's Super Admin "Modules", checklist row 4.3. `PUT /plans/:id/modules`.
 *
 * §33 names this a screen; the API models it as a sub-resource of a plan. So the screen asks which
 * plan first — see `components/planScope.tsx` for why that is the question rather than a workaround.
 *
 * ## The catalogue is what makes this editable
 *
 * `GET /plans/{id}` returns only the `plan_modules` rows that exist. Rendering those alone would show
 * what a plan *has* and give no way to add what it is *missing* — and "which modules is this plan
 * short of" is the question someone opens this screen with. `GET /plans/catalogue` supplies §11's
 * twenty keys with their labels, so every module appears as a checkbox whether or not the plan has a
 * row for it.
 *
 * ## A whole-set replacement, and what that means for a module nobody has touched
 *
 * `PUT /plans/{id}/modules` replaces the set, so this screen sends every module it means the plan to
 * have. It deliberately does **not** send twenty rows every time: a module with no `plan_modules` row
 * has never been configured, one with a row saying `is_enabled: false` was turned off on purpose, and
 * flattening the first into the second would destroy a distinction the read model goes out of its way
 * to show. So the payload is the modules that are ticked, plus any that already had a row — which is
 * exactly the set whose state somebody has decided.
 *
 * This was read-only until 2026-09-09, and the note explaining why said a toggle "that silently
 * dropped the others would be worse than showing the state honestly". That was right about the risk
 * and wrong about the fix: the answer is to send the others, not to withhold the control.
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import {
  Catalogue,
  PlanDetail,
  PlanPicker,
  usePlanDetail,
  useSelectedPlan,
} from '@/components/planScope';
import { CheckboxField, FormActions, Notice, SubmitButton } from '@/components/form';
import { useToast } from '@/components/toast';
import { EmptyNotice, ErrorNotice, LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';

/** What the plan has stored for one module, or `undefined` when it has no row at all. */
type Stored = PlanDetail['modules'][number] | undefined;

function ModuleEditor({
  detail,
  catalogue,
  canEdit,
  onSaved,
}: {
  detail: PlanDetail;
  catalogue: Catalogue;
  /** `plans.modules.manage`. Without it the set is shown and every box is disabled. */
  canEdit: boolean;
  onSaved: () => void;
}) {
  const { success } = useToast();

  const stored = useMemo(
    () => new Map<string, Stored>(detail.modules.map((row) => [row.module_key, row])),
    [detail.modules]
  );

  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /* Re-synced on load and after a save, so what is ticked is what is stored. */
  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const entry of catalogue.modules) next[entry.key] = stored.get(entry.key)?.is_enabled === true;
    setEnabled(next);
  }, [catalogue.modules, stored]);

  const known = useMemo(() => new Set(catalogue.modules.map((entry) => entry.key)), [catalogue.modules]);
  const orphans = detail.modules.filter((row) => !known.has(row.module_key));

  const included = catalogue.modules.filter((entry) => enabled[entry.key]).length;

  const dirty = catalogue.modules.some(
    (entry) => Boolean(enabled[entry.key]) !== (stored.get(entry.key)?.is_enabled === true)
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;

    setSaving(true);
    setError(null);

    /* See the header: ticked, or already carrying a row. `settings` is passed through untouched. */
    const modules = catalogue.modules
      .filter((entry) => enabled[entry.key] || stored.has(entry.key))
      .map((entry) => {
        const row = stored.get(entry.key);
        return {
          module_key: entry.key,
          is_enabled: Boolean(enabled[entry.key]),
          ...(row?.settings ? { settings: row.settings } : {}),
        };
      });

    try {
      await api.put(`/plans/${detail.id}/modules`, { modules });
      success(
        'Modules saved',
        `${modules.filter((row) => row.is_enabled).length} of ${catalogue.modules.length} included in ${detail.name}.`
      );
      onSaved();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const formLevel = caught.formErrors();
        setError(formLevel.length ? formLevel.join(' ') : caught.message);
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {error ? <Notice tone="error">{error}</Notice> : null}

      {!canEdit ? (
        <Notice tone="info">
          You can see what this plan includes but not change it. Editing needs the
          &ldquo;plans.modules.manage&rdquo; permission.
        </Notice>
      ) : null}

      <p className="mb-3 text-sm">
        <strong className="tabular-nums">{included}</strong> of {catalogue.modules.length} modules
        included in <strong>{detail.name}</strong>.
      </p>

      <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {catalogue.modules.map((entry) => {
          const row = stored.get(entry.key);
          return (
            <li key={entry.key} className="rounded-md border border-border px-3 py-2">
              <CheckboxField
                id={`module-${entry.key}`}
                label={entry.label}
                disabled={!canEdit}
                checked={Boolean(enabled[entry.key])}
                onChange={(event) =>
                  setEnabled((prev) => ({ ...prev, [entry.key]: event.target.checked }))
                }
                /*
                 * The key is here because it is what the API, the audit log and every error message
                 * call this module — an operator reading a 422 needs to be able to find the box it
                 * names. "Never configured" is the third state the header describes.
                 */
                hint={row ? entry.key : `${entry.key} · never configured`}
              />
            </li>
          );
        })}
      </ul>

      {orphans.length > 0 ? (
        <p className="mt-4 rounded-md border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn">
          This plan carries {orphans.length} module row{orphans.length === 1 ? '' : 's'} naming a key
          that is not in §11’s catalogue: {orphans.map((row) => row.module_key).join(', ')}. Saving
          removes {orphans.length === 1 ? 'it' : 'them'} — the API accepts only the twenty keys above.
        </p>
      ) : null}

      {canEdit ? (
        <FormActions>
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Saving…" disabled={!dirty}>
            Save modules
          </SubmitButton>
        </FormActions>
      ) : null}
    </form>
  );
}

function ModulesScreen() {
  const { can } = useAuth();
  const [selected, select] = useSelectedPlan();
  const { detail, catalogue, loading, error, refusal, reload } = usePlanDetail(selected, true);

  return (
    <div>
      <PageHeader
        title="Plan modules"
        description="Which of §11’s twenty modules a plan includes. Choose the plan first."
      />

      <PlanPicker selected={selected} onSelect={select} />

      {/*
        * `!selected` first — `usePlanDetail` leaves the previous plan's `error`, `refusal` and
        * `loading` in place when the picker is cleared. The Features screen has the full note.
        */}
      {!selected ? (
        <EmptyNotice>Choose a plan above to see the modules it includes.</EmptyNotice>
      ) : refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading ? (
        <LoadingBlock />
      ) : detail && catalogue ? (
        <ModuleEditor
          detail={detail}
          catalogue={catalogue}
          canEdit={can('plans.modules.manage')}
          onSaved={reload}
        />
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
