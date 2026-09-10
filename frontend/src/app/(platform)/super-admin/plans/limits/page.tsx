'use client';

/**
 * Plan limits — SRS §11.2, §33's Super Admin "Limits", checklist row 4.3. `PUT /plans/:id/limits`.
 *
 * Plan-scoped for the same reason as Modules: the API models this as a sub-resource, and a limit key
 * means nothing on its own — only what *this plan* allows. See `components/planScope.tsx`.
 *
 * ## Why every limit has to be answered, not just the ones being changed
 *
 * `setLimits` is `.length(LIMIT_LIST.length).required()` with a custom rule that names any key left
 * out. That is not strictness for its own sake: an absent `plan_limits` row resolves to **zero** in
 * `entitlementService`, not to unlimited, so a plan missing `teacher_limit` forbids teachers to every
 * school on it. A partial save would therefore be a way to silently forbid something.
 *
 * So the form holds all eight and sends all eight. A plan that has never had a limit set opens with
 * that limit as Fixed and its allowance empty, which the API refuses until a number is typed — the
 * one honest default, since neither zero nor unlimited is a decision this screen may make on the
 * operator's behalf.
 *
 * ## `unlimited` is not a very large number
 *
 * The two types are stored differently: an unlimited limit carries a null `limit_value`, and the
 * validator refuses a number alongside it so a row cannot keep a stale ceiling that nothing reads.
 * The allowance box therefore disappears when Unlimited is chosen rather than being ignored.
 *
 * ## Overage is a separate axis
 *
 * A limit can be exceeded (`allow_overage`) at a price per unit, which is why a school can pass its
 * student ceiling and be billed rather than blocked. The rate is `.required()` when overage is
 * allowed **and may be 0**, because `usageService` treats a null rate as free — so a blank would give
 * unlimited free excess while the screen showed a Fixed limit. Zero is a decision; blank is an
 * omission, and the API will not accept one.
 *
 * Overage is offered for a Fixed limit only. An unlimited allowance cannot be exceeded, so the pair
 * would describe nothing; `allow_overage: false` is sent for those rows.
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
import { useToast } from '@/components/toast';
import { EmptyNotice, ErrorNotice, LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';

/** `LIMIT_TYPES` in `config/constants.js`. */
const FIXED = 'fixed';
const UNLIMITED = 'unlimited';

/**
 * One limit as the form holds it.
 *
 * `value` and `overage` are strings for the reason the pricing editor gives: the difference between
 * "0" and "" is the difference between a decision and an omission, and the API distinguishes them.
 */
interface LimitDraft {
  key: string;
  label: string;
  unit: string | null;
  type: string;
  value: string;
  allowOverage: boolean;
  overage: string;
  /** Whether the plan already had a `plan_limits` row for this key. Shown, never sent. */
  configured: boolean;
}

function toDrafts(detail: PlanDetail, catalogue: Catalogue): LimitDraft[] {
  const byKey = new Map(detail.limits.map((row) => [row.limit_key, row]));

  return catalogue.limits.map((entry) => {
    const row = byKey.get(entry.key);
    return {
      key: entry.key,
      label: entry.label,
      unit: row?.unit ?? entry.unit,
      /* Fixed for an unconfigured limit — see the header on why no other default is honest. */
      type: row?.limit_type ?? FIXED,
      value: row?.limit_value === null || row?.limit_value === undefined ? '' : String(row.limit_value),
      allowOverage: Boolean(row?.allow_overage),
      overage:
        row?.overage_unit_amount === null || row?.overage_unit_amount === undefined
          ? ''
          : String(row.overage_unit_amount),
      configured: Boolean(row),
    };
  });
}

function LimitEditor({
  detail,
  catalogue,
  canEdit,
  onSaved,
}: {
  detail: PlanDetail;
  catalogue: Catalogue;
  /** `plans.limits.manage`. Without it the set is shown and every control is disabled. */
  canEdit: boolean;
  onSaved: () => void;
}) {
  const { success } = useToast();

  const [drafts, setDrafts] = useState<LimitDraft[]>(() => toDrafts(detail, catalogue));
  const [rowErrors, setRowErrors] = useState<Map<number, Record<string, string>>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDrafts(toDrafts(detail, catalogue));
    setRowErrors(new Map());
  }, [detail, catalogue]);

  const update = (key: string, patch: Partial<LimitDraft>) =>
    setDrafts((prev) => prev.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));

  const configured = drafts.filter((draft) => draft.configured).length;

  const dirty = useMemo(() => {
    const original = toDrafts(detail, catalogue);
    return JSON.stringify(original) !== JSON.stringify(drafts);
  }, [detail, catalogue, drafts]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;

    setSaving(true);
    setError(null);
    setRowErrors(new Map());

    const limits = drafts.map((draft) => {
      const fixed = draft.type === FIXED;
      return {
        limit_key: draft.key,
        limit_type: draft.type,
        /*
         * Null, not omitted, for an unlimited limit: the validator's `otherwise` is `valid(null)`,
         * so null is the accepted way to say "no ceiling" and an omitted key would be the same
         * thing said less clearly. A blank Fixed allowance is sent as undefined so the refusal names
         * `limit_value` rather than reporting "must be a number" about an empty string.
         */
        limit_value: fixed ? (draft.value.trim() === '' ? undefined : Number(draft.value)) : null,
        allow_overage: fixed ? draft.allowOverage : false,
        overage_unit_amount:
          fixed && draft.allowOverage
            ? draft.overage.trim() === ''
              ? undefined
              : Number(draft.overage)
            : null,
      };
    });

    try {
      await api.put(`/plans/${detail.id}/limits`, { limits });
      success('Limits saved', `All ${limits.length} of §11.2's limits are set on ${detail.name}.`);
      onSaved();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const { rows, set } = splitIndexedErrors(caught.fieldErrors(), 'limits');
        setRowErrors(rows);
        const formLevel = [...set, ...caught.formErrors()];
        setError(
          formLevel.length
            ? formLevel.join(' ')
            : rows.size
              ? `${rows.size} limit${rows.size === 1 ? '' : 's'} below need${rows.size === 1 ? 's' : ''} attention.`
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
          You can see this plan&apos;s limits but not change them. Editing needs the
          &ldquo;plans.limits.manage&rdquo; permission.
        </Notice>
      ) : null}

      {configured < drafts.length ? (
        <Notice tone="warn">
          {drafts.length - configured} of {drafts.length} limits have never been set on{' '}
          {detail.name}. Each of those allows <strong>nothing</strong> today, not everything — so a
          school on this plan is refused the thing it counts. Saving this form sets all{' '}
          {drafts.length}.
        </Notice>
      ) : (
        <p className="text-sm">
          All <strong className="tabular-nums">{drafts.length}</strong> of §11.2&rsquo;s limits are
          set on <strong>{detail.name}</strong>.
        </p>
      )}

      <ol className="space-y-4">
        {drafts.map((draft, index) => {
          const errors = rowErrors.get(index) ?? {};
          const fixed = draft.type === FIXED;
          const id = (field: string) => `limit-${draft.key}-${field}`;

          /*
           * Held in a variable rather than written twice, because the label and the message have to
           * agree: `rowError` rewrites the server's column name into the label above the box, and a
           * second copy of that phrase is a second place for it to drift.
           */
          const valueLabel = draft.unit ? `Allowance (${draft.unit})` : 'Allowance';
          const rateLabel = draft.unit ? `Rate per extra ${draft.unit}` : 'Rate per extra unit';
          const overageLabel = 'Allow going over the limit, and bill for it';

          return (
            <li key={draft.key} className="rounded-md border border-border p-4">
              <div className="mb-3">
                <h3 className="text-sm font-semibold">{draft.label}</h3>
                <p className="text-xs text-muted">
                  <code>{draft.key}</code>
                  {draft.unit ? ` · measured in ${draft.unit}` : ''}
                  {draft.configured ? '' : ' · never set'}
                </p>
              </div>

              {errors._row ? <Notice tone="error">{errors._row}</Notice> : null}

              <FormGrid>
                <SelectField
                  id={id('type')}
                  label="Allowance type"
                  required
                  disabled={!canEdit}
                  value={draft.type}
                  onChange={(event) => update(draft.key, { type: event.target.value })}
                  error={rowError(errors, 'limit_type', 'Allowance type')}
                  hint="Unlimited removes the ceiling entirely; Fixed sets a number."
                >
                  {(catalogue.limits.find((entry) => entry.key === draft.key)?.types ?? [
                    FIXED,
                    UNLIMITED,
                  ]).map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </SelectField>

                {fixed ? (
                  <Field
                    id={id('value')}
                    label={valueLabel}
                    required
                    type="number"
                    min={0}
                    step={1}
                    disabled={!canEdit}
                    value={draft.value}
                    onChange={(event) => update(draft.key, { value: event.target.value })}
                    error={rowError(errors, 'limit_value', valueLabel)}
                    hint="How many a school on this plan may have. Zero means none are permitted."
                  />
                ) : null}
              </FormGrid>

              {fixed ? (
                <div className="mt-3 space-y-3">
                  <CheckboxField
                    id={id('overage')}
                    label={overageLabel}
                    disabled={!canEdit}
                    checked={draft.allowOverage}
                    onChange={(event) =>
                      update(draft.key, { allowOverage: event.target.checked })
                    }
                    error={rowError(errors, 'allow_overage', overageLabel)}
                    hint="Unticked makes the allowance a hard stop — the school is refused rather than charged."
                  />

                  {draft.allowOverage ? (
                    <Field
                      id={id('rate')}
                      label={rateLabel}
                      required
                      type="number"
                      min={0}
                      step="0.01"
                      disabled={!canEdit}
                      value={draft.overage}
                      onChange={(event) => update(draft.key, { overage: event.target.value })}
                      error={rowError(errors, 'overage_unit_amount', rateLabel)}
                      hint="Required, and 0 is allowed — it means the excess is free. A blank rate would mean the same thing by accident, so the API refuses it."
                    />
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      {canEdit ? (
        <FormActions>
          <SubmitButton fullWidth={false} busy={saving} busyLabel="Saving…" disabled={!dirty}>
            Save limits
          </SubmitButton>
        </FormActions>
      ) : null}
    </form>
  );
}

function LimitsScreen() {
  const { can } = useAuth();
  const [selected, select] = useSelectedPlan();
  const { detail, catalogue, loading, error, refusal, reload } = usePlanDetail(selected, true);

  return (
    <div>
      <PageHeader
        title="Plan limits"
        description="§11.2’s eight limit keys, and what a plan allows for each."
      />

      <PlanPicker selected={selected} onSelect={select} />

      {/*
        * `!selected` first — `usePlanDetail` leaves the previous plan's `error`, `refusal` and
        * `loading` in place when the picker is cleared. The Features screen has the full note.
        */}
      {!selected ? (
        <EmptyNotice>Choose a plan above to see its limits.</EmptyNotice>
      ) : refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading ? (
        <LoadingBlock />
      ) : detail && catalogue ? (
        <LimitEditor
          detail={detail}
          catalogue={catalogue}
          canEdit={can('plans.limits.manage')}
          onSaved={reload}
        />
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
