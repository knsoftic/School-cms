'use client';

/**
 * Plan features — SRS §11, §33's Super Admin "Features", checklist row 4.3.
 * `PUT /plans/:id/features`.
 *
 * ## The one of the three with no vocabulary of its own
 *
 * Modules and Limits render against `GET /plans/catalogue`, which supplies §11's twenty module keys
 * and eight limit keys. **It returns no features**, and there is no feature vocabulary anywhere in
 * the codebase — no `FEATURE_LIST`, no feature constant in `config/constants.js`, nothing.
 *
 * That is a real §33-versus-API asymmetry and not a blocker, because `plan_features` carries its own
 * `feature_key` and `name` per row: a feature is whatever a plan says it is. So this editor is a free
 * list — the operator names the feature — rather than a grid of checkboxes over a fixed set. It
 * cannot show what a plan is *missing*, because "missing" is undefined for a vocabulary that does not
 * exist.
 *
 * The catalogue is still fetched, for one narrow purpose: `featureItem.module_key` is
 * `valid(...MODULE_LIST)`, so the module a feature is grouped under **does** come from a fixed list of
 * twenty. Typing that key by hand is the one part of this form a 422 could reject on spelling, which
 * is exactly what a select is for. This screen's header used to say it needed no catalogue; that was
 * true while it was read-only.
 *
 * ## `value` is a nullable string, and this header used to say otherwise
 *
 * It claimed `plan_features.value` was *"a JSON column with no schema"*. The model says
 * `value: { type: DataTypes.STRING(120), allowNull: true }`, and the column's own comment is
 * *"Feature value when a feature is more than a boolean (e.g. a retention window)"*. The boolean
 * lives in the separate `is_enabled` column. So the field below is a text box, and the validator
 * agrees: `Joi.string().trim().max(120).empty('').allow(null)`.
 *
 * ## A whole-set replacement
 *
 * `PUT /plans/{id}/features` replaces every row, so a feature removed here and saved is deleted, not
 * disabled — which is why `is_enabled` is a control of its own. Removal is confirmed for that reason.
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { rowError, splitIndexedErrors } from '@/lib/formErrors';
import {
  Catalogue,
  PlanDetail,
  PlanPicker,
  usePlanDetail,
  useSelectedPlan,
} from '@/components/planScope';
import {
  CheckboxField,
  Field,
  FormActions,
  FormGrid,
  Notice,
  SelectField,
  SubmitButton,
  focusFirstInvalidField,
} from '@/components/form';
import { Icon } from '@/components/icon';
import { ConfirmDialog } from '@/components/overlay';
import { useToast } from '@/components/toast';
import { EmptyNotice, ErrorNotice, LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';

/** `plans.validation.js` caps the set at 200 rows. */
const MAX_FEATURES = 200;

/**
 * One feature as the form holds it.
 *
 * `key` is a client-side identity, not the database id — a row added here has none until it is
 * saved, and the whole set is replaced on save.
 */
interface FeatureDraft {
  key: string;
  feature_key: string;
  name: string;
  value: string;
  module_key: string;
  display_order: string;
  is_enabled: boolean;
}

let nextKey = 0;

function toDrafts(detail: PlanDetail): FeatureDraft[] {
  /*
   * `display_order` first, then key — the column exists to let an administrator control the order,
   * and ignoring it would make this screen disagree with wherever else features are shown. Sorted on
   * a copy: the array belongs to the fetched object and mutating it would reorder state.
   */
  return [...detail.features]
    .sort(
      (a, b) =>
        (a.display_order ?? Number.MAX_SAFE_INTEGER) - (b.display_order ?? Number.MAX_SAFE_INTEGER) ||
        a.feature_key.localeCompare(b.feature_key)
    )
    .map((row) => ({
      key: `feature-${row.id}`,
      feature_key: row.feature_key,
      name: row.name ?? '',
      /* `unknown` on the wire; `STRING(120)` in the column. Narrowed rather than trusted. */
      value: typeof row.value === 'string' || typeof row.value === 'number' ? String(row.value) : '',
      module_key: row.module_key ?? '',
      display_order: row.display_order === null ? '' : String(row.display_order),
      is_enabled: row.is_enabled,
    }));
}

function blankDraft(): FeatureDraft {
  nextKey += 1;
  return {
    key: `draft-${nextKey}`,
    feature_key: '',
    name: '',
    value: '',
    module_key: '',
    display_order: '',
    is_enabled: true,
  };
}

function FeatureEditor({
  detail,
  catalogue,
  canEdit,
  onSaved,
}: {
  detail: PlanDetail;
  catalogue: Catalogue;
  /** `plans.modules.manage` — features and modules share one key. */
  canEdit: boolean;
  onSaved: () => void;
}) {
  const { success } = useToast();

  const [drafts, setDrafts] = useState<FeatureDraft[]>(() => toDrafts(detail));
  const [rowErrors, setRowErrors] = useState<Map<number, Record<string, string>>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<FeatureDraft | null>(null);

  useEffect(() => {
    setDrafts(toDrafts(detail));
    setRowErrors(new Map());
  }, [detail]);

  const update = (key: string, patch: Partial<FeatureDraft>) =>
    setDrafts((prev) => prev.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));

  const dirty = useMemo(
    () => JSON.stringify(toDrafts(detail)) !== JSON.stringify(drafts),
    [detail, drafts]
  );

  const enabled = drafts.filter((draft) => draft.is_enabled).length;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;

    setSaving(true);
    setError(null);
    setRowErrors(new Map());

    const features = drafts.map((draft) => ({
      /* Lower-cased here as well as by Joi, so what is sent is what the operator will see stored. */
      feature_key: draft.feature_key.trim().toLowerCase(),
      /* Null rather than omitted: each of these three is `.empty('').allow(null)`, and null is how
       * the column is cleared — an omitted key would leave the old text in place. */
      name: draft.name.trim() || null,
      value: draft.value.trim() || null,
      module_key: draft.module_key || null,
      is_enabled: draft.is_enabled,
      ...(draft.display_order.trim() ? { display_order: Number(draft.display_order) } : {}),
    }));

    try {
      await api.put(`/plans/${detail.id}/features`, { features });
      success(
        'Features saved',
        features.length === 0
          ? `${detail.name} now has no features.`
          : `${features.filter((row) => row.is_enabled).length} of ${features.length} enabled on ${detail.name}.`
      );
      onSaved();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const { rows, set } = splitIndexedErrors(caught.fieldErrors(), 'features');
        setRowErrors(rows);
        const formLevel = [...set, ...caught.formErrors()];
        setError(
          formLevel.length
            ? formLevel.join(' ')
            : rows.size
              ? `${rows.size} feature${rows.size === 1 ? '' : 's'} below need${rows.size === 1 ? 's' : ''} attention.`
              : caught.message
        );
        focusFirstInvalidField();
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {error ? <Notice tone="error">{error}</Notice> : null}

      {!canEdit ? (
        <Notice tone="info">
          You can see this plan&apos;s features but not change them. Editing needs the
          &ldquo;plans.modules.manage&rdquo; permission, which covers modules and features together.
        </Notice>
      ) : null}

      {drafts.length === 0 ? (
        <EmptyNotice>
          This plan has no features configured. Unlike modules and limits there is no fixed list to
          compare against — a feature is whatever a plan defines, so there is nothing here yet rather
          than something missing.
        </EmptyNotice>
      ) : (
        <p className="text-sm">
          <strong className="tabular-nums">{enabled}</strong> of {drafts.length} features enabled on{' '}
          <strong>{detail.name}</strong>.
        </p>
      )}

      <ol className="space-y-4">
        {drafts.map((draft, index) => {
          const errors = rowErrors.get(index) ?? {};
          const id = (field: string) => `feature-${draft.key}-${field}`;

          return (
            <li key={draft.key} className="rounded-md border border-border p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <h3 className="text-sm font-semibold">
                  {draft.name.trim() || draft.feature_key.trim() || `Feature ${index + 1}`}
                </h3>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => setRemoving(draft)}
                    className="btn btn-ghost btn-sm text-danger"
                  >
                    <Icon name="trash" size={14} />
                    Remove
                  </button>
                ) : null}
              </div>

              {errors._row ? <Notice tone="error">{errors._row}</Notice> : null}

              <FormGrid>
                <Field
                  id={id('feature_key')}
                  label="Key"
                  required
                  disabled={!canEdit}
                  maxLength={80}
                  value={draft.feature_key}
                  onChange={(event) => update(draft.key, { feature_key: event.target.value })}
                  error={rowError(errors, 'feature_key', 'Key')}
                  hint="How the rest of the system refers to this feature — 2 to 80 characters, lower case, starting with a letter or digit; letters, digits, underscores, dots and hyphens only. Unique within the plan."
                />

                <Field
                  id={id('name')}
                  label="Name"
                  disabled={!canEdit}
                  maxLength={160}
                  value={draft.name}
                  onChange={(event) => update(draft.key, { name: event.target.value })}
                  error={rowError(errors, 'name', 'Name')}
                  hint="What a person calls it. Blank falls back to the key wherever the feature is shown."
                />

                <Field
                  id={id('value')}
                  label="Value"
                  disabled={!canEdit}
                  maxLength={120}
                  value={draft.value}
                  onChange={(event) => update(draft.key, { value: event.target.value })}
                  error={rowError(errors, 'value', 'Value')}
                  hint="For a feature that is more than on or off — a retention window, a quota. Leave blank for a plain switch."
                />

                <SelectField
                  id={id('module_key')}
                  label="Grouped under"
                  disabled={!canEdit}
                  value={draft.module_key}
                  onChange={(event) => update(draft.key, { module_key: event.target.value })}
                  error={rowError(errors, 'module_key', 'Grouped under')}
                  hint="Advisory only — it groups the feature for display. A feature inside a module the plan does not include is unreachable whatever its own switch says."
                >
                  <option value="">Standalone</option>
                  {catalogue.modules.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </SelectField>

                <Field
                  id={id('display_order')}
                  label="Display order"
                  type="number"
                  min={0}
                  max={100000}
                  step={1}
                  disabled={!canEdit}
                  value={draft.display_order}
                  onChange={(event) => update(draft.key, { display_order: event.target.value })}
                  error={rowError(errors, 'display_order', 'Display order')}
                  hint="Lower comes first. Blank sorts the feature after the ordered ones, by key."
                />
              </FormGrid>

              <div className="mt-3">
                <CheckboxField
                  id={id('is_enabled')}
                  label="Enabled"
                  disabled={!canEdit}
                  checked={draft.is_enabled}
                  onChange={(event) => update(draft.key, { is_enabled: event.target.checked })}
                  error={rowError(errors, 'is_enabled', 'Enabled')}
                  hint="Unticking switches the feature off while keeping its row, which is how a feature is withdrawn without losing what it was called."
                />
              </div>
            </li>
          );
        })}
      </ol>

      {canEdit ? (
        <>
          <button
            type="button"
            onClick={() => setDrafts((prev) => [...prev, blankDraft()])}
            disabled={drafts.length >= MAX_FEATURES}
            className="btn btn-secondary"
          >
            <Icon name="plus" size={15} />
            Add a feature
          </button>

          <FormActions>
            <SubmitButton fullWidth={false} busy={saving} busyLabel="Saving…" disabled={!dirty}>
              Save features
            </SubmitButton>
          </FormActions>
        </>
      ) : null}

      <ConfirmDialog
        open={Boolean(removing)}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          setDrafts((prev) => prev.filter((draft) => draft.key !== removing?.key));
          setRemoving(null);
        }}
        title="Remove this feature?"
        description="It disappears from the list now and is deleted from the plan when you save. To switch a feature off while keeping its row, untick “Enabled” instead."
        confirmLabel="Remove feature"
      />
    </form>
  );
}

function FeaturesScreen() {
  const { can } = useAuth();
  const [selected, select] = useSelectedPlan();
  /* The catalogue is for the module select only — see the header. */
  const { detail, catalogue, loading, error, refusal, reload } = usePlanDetail(selected, true);

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
      ) : detail && catalogue ? (
        <FeatureEditor
          detail={detail}
          catalogue={catalogue}
          canEdit={can('plans.modules.manage')}
          onSaved={reload}
        />
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
