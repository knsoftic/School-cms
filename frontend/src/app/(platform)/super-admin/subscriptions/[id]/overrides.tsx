'use client';

/**
 * Per-subscription overrides — SRS §33's Feature Overrides, Custom Limits and Custom Pricing.
 *
 * `POST /:id/overrides` and `POST /:id/overrides/:overrideId/revoke`, neither of which had a caller.
 * §33 names all three capabilities in the SaaS engine and none of them could be reached from the
 * product.
 *
 * ## This is the highest-precedence source in the entitlement chain
 *
 * Above add-ons and above the plan. That is why the routes carry their own permission key —
 * `subscriptions.overrides.manage`, seeded to `super_admin` alone — and why the form says what each
 * type actually does rather than treating the four as one shape with different fields. An operator
 * who thinks a module override "adds a module to the plan" will apply it to the wrong subscription.
 *
 * Highest precedence is not "replaces everything", and the two places that is easy to get wrong are
 * said in the form. A **limit** override replaces the *plan's* value and nothing else:
 * `entitlementService` computes `base = override ?? plan`, then `total = base + addonUnits`, so units a
 * school bought on top still count. A **price** override, by the owner's decision D7, sets the plan
 * line on invoices for periods that start while it is in effect — add-ons, the setup fee and overage
 * are billed on top as before.
 *
 * ## The vocabulary comes from the catalogue, with two deliberate exceptions
 *
 * `subscriptions.service.catalogue()` publishes `limitTargets` (nine keys — §11.2's eight **plus**
 * the add-on-only `sms_limit`), `limitTypes` and `priceTargets`. Module targets come from
 * `lib/modules.ts`, which is the copy `verify-frontend.js` asserts against the backend's own
 * `MODULE_LABELS` in both directions; publishing them a second way would be a third copy.
 *
 * **Feature targets have no fixed list, and that is a property of the source rather than a gap here.**
 * `plan_features` carries its own `name` and `module_key` per row: a feature is self-describing, and
 * §11 fixes no feature vocabulary anywhere. So the control stays a text box — but not a blank one. It
 * suggests the keys the platform already uses (every plan's features, and what each add-on unlocks),
 * and it holds a typed key to the shape `plans.validation` gives `feature_key`: lower case, starting
 * with a letter or digit. A key typed as `Premium_Reports` was accepted, stored, and matched nothing,
 * because the entitlement snapshot is keyed by the lower-case `plan_features` value and an add-on
 * unlocks `premium_reports` by exactly that name.
 *
 * ## Applying an override to a target that already has one replaces it — revoked or not
 *
 * `subscription_overrides` has a unique index over `(subscription_id, override_type, target_key)`, so
 * a second override on the same target is an update and the API answers 200 rather than 201. The
 * service's lookup ignores `is_active`, so that includes a **revoked** row: re-applying reactivates it
 * and overwrites its value, window and reason, and the revoked arrangement then survives only in the
 * audit trail. The form says both where they can be acted on — beside the target — and the toast is
 * decided by whether the returned row is one this screen already had, which is the server's answer
 * rather than a guess. `target_key` is compared case-blind, as the `utf8mb4_unicode_ci` collation
 * under that index compares it.
 *
 * ## Revoked is not deleted
 *
 * Revoking sets `is_active` false. The row stays, and `is_effective` — computed by the same
 * `isEffective()` the entitlement resolver uses — is what says whether it is in force *now*. Those
 * are two different columns and the table shows both, because an override can be active and not yet
 * effective (a window starting next month), which looks like a broken save if only one is shown.
 *
 * ## The window is whole days in the operator's own zone
 *
 * The two date inputs hold calendar days. Sent as typed, `2026-09-30` reached Joi as midnight UTC, and
 * `activeWindow()` treats `effective_until` as exclusive — so an override "until 30 September" ended
 * at 01:00 on the 30th in London and at 20:00 on the 29th in New York. `dayBound()` sends
 * the start of the "from" day and the end of the "until" day, both in the browser's zone, which is
 * what the operator meant by the two dates; the until field says "(inclusive)" because it now is.
 */

import { useCallback, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { rowError, splitApiErrors } from '@/lib/formErrors';
import { dayBound } from '@/lib/instants';
import { formatCodeWithAmount } from '@/lib/money';
import { MODULES, moduleLabel } from '@/lib/modules';
import { useCollection } from '@/lib/useCollection';
import {
  Field,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
} from '@/components/form';
import { Modal } from '@/components/overlay';
import { Column, DataTable, EmptyNotice, StatusBadge } from '@/components/table';
import { useToast } from '@/components/toast';

import { formatDate, humanise, limitLabel } from './detail';
import type {
  SubscriptionCatalogue,
  SubscriptionDetail,
  SubscriptionOverrideRow,
} from './detail';

interface OverrideResponse {
  subscription: SubscriptionDetail;
  override: SubscriptionOverrideRow;
}

/** The apply form's inputs, by the body field each sends. A 422 on anything else is a banner. */
const APPLY_FIELDS = new Set([
  'override_type',
  'target_key',
  'is_enabled',
  'limit_type',
  'limit_value',
  'amount',
  'effective_from',
  'effective_until',
  'reason',
]);
const REVOKE_FIELDS = new Set(['reason']);

/**
 * `plans.validation`'s `feature_key` shape: a letter or digit, then lower-case letters, digits, `_`,
 * `.` or `-`. The override schema does not check it yet, so this is where a key that could never
 * match a plan feature or an add-on unlock is stopped.
 */
const FEATURE_KEY = /^[a-z0-9][a-z0-9_.-]*$/;

/** The id tying the feature-key box to its suggestions. */
const FEATURE_LIST_ID = 'override-feature-keys';

/** What each type overrides, in one sentence, shown once a type is chosen. */
const EXPLAINS: Record<string, string> = {
  module:
    'Turns one of the twenty modules on or off for this school, whatever the plan says. An override naming anything else is ignored by entitlement resolution, so the list is fixed.',
  feature:
    'Turns one feature on or off. Features are named per plan rather than drawn from a fixed list, so the key is typed — the keys the plans and add-ons already use are suggested.',
  limit:
    'Replaces the plan’s value for one allowance. Add-on units bought on top still count, so the school’s total is this figure plus what its add-ons grant. This is where a negotiated ceiling lives — including SMS credits, which are not a plan limit at all and can only be raised here or by an add-on.',
  price:
    'Sets the plan line on this school’s invoices for every billing period that starts while it is in effect. Add-ons, the setup fee and overage are billed on top as usual. It does not change the plan’s price for anyone else, and invoices already raised are not re-issued.',
};

/** One row of `GET /plans`, of which the suggestions read only the features. */
interface PlanFeatures {
  id: number;
  features?: { feature_key: string; name: string | null }[] | null;
}

/** One row of `GET /addons`, of which the suggestions read what it unlocks. */
interface AddonUnlock {
  id: number;
  name: string;
  effect_type: string;
  effect_target: string;
}

/**
 * The feature keys the platform already uses, as a `<datalist>` for the feature-key box.
 *
 * Every plan's `plan_features` rows, and the target of every `feature_unlock` add-on — the two places a
 * feature key is written down. Suggestions, not a restriction: a feature override may name a key no
 * plan carries yet, which is how a school is given a feature ahead of its plan.
 *
 * Its own component so the two catalogue reads happen only while a feature override is being
 * written, not every time the Overrides tab opens. Inactive plans and add-ons are included: a key is
 * no less a key because the thing that carries it is off sale.
 */
function KnownFeatureKeys({ listId }: { listId: string }) {
  const plans = useCollection<PlanFeatures>('/plans', { limit: 100 });
  const addons = useCollection<AddonUnlock>('/addons', { limit: 100 });

  const known = useMemo(() => {
    const names = new Map<string, string>();
    for (const plan of plans.rows) {
      for (const feature of plan.features ?? []) {
        if (!names.get(feature.feature_key)) names.set(feature.feature_key, feature.name ?? '');
      }
    }
    for (const addon of addons.rows) {
      if (addon.effect_type === 'feature_unlock' && !names.get(addon.effect_target)) {
        names.set(addon.effect_target, addon.name);
      }
    }
    return [...names.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [plans.rows, addons.rows]);

  const unreadable =
    (plans.refusal !== null || plans.error !== null) &&
    (addons.refusal !== null || addons.error !== null);

  return (
    <>
      <datalist id={listId}>
        {known.map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </datalist>
      {/* Said, not left as a box that simply offers nothing. */}
      {unreadable ? (
        <p className="text-xs text-muted">
          No keys can be suggested: neither the plan nor the add-on catalogue could be read by this
          account.
        </p>
      ) : !plans.loading && !addons.loading && known.length === 0 ? (
        <p className="text-xs text-muted">No plan or add-on uses a feature key yet.</p>
      ) : null}
    </>
  );
}

export function OverridesPanel({
  subscription,
  catalogue,
  canManage,
  onChanged,
}: {
  subscription: SubscriptionDetail;
  catalogue: SubscriptionCatalogue | null;
  /** `subscriptions.overrides.manage`, which is its own key for the reason the router gives. */
  canManage: boolean;
  onChanged: (subscription: SubscriptionDetail) => void;
}) {
  const { success } = useToast();

  const [type, setType] = useState('');
  const [targetKey, setTargetKey] = useState('');
  const [isEnabled, setIsEnabled] = useState('true');
  const [limitType, setLimitType] = useState('');
  const [limitValue, setLimitValue] = useState('');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [revoking, setRevoking] = useState<SubscriptionOverrideRow | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeFieldErrors, setRevokeFieldErrors] = useState<Record<string, string>>({});

  const limitTargets = catalogue?.limitTargets ?? [];
  const priceTargets = catalogue?.priceTargets ?? [];

  const key = targetKey.trim();

  /**
   * The row this save would land on, if there is one — active or revoked, compared case-blind. See
   * the header: the service's lookup ignores `is_active`, and the collation ignores case.
   */
  const sameTarget = useMemo(
    () =>
      subscription.overrides.find(
        (row) =>
          row.override_type === type && key !== '' && row.target_key.toLowerCase() === key.toLowerCase()
      ) ?? null,
    [subscription.overrides, type, key]
  );
  const replaces = sameTarget !== null && sameTarget.is_active;
  const revives = sameTarget !== null && !sameTarget.is_active;

  /*
   * Everything the chosen type requires, so the button does not offer a request whose only outcome
   * is "is required". `is_enabled` always holds a value; the rest start blank.
   */
  const complete =
    type !== '' &&
    key !== '' &&
    (type !== 'limit' || (limitType !== '' && (limitType !== 'fixed' || limitValue.trim() !== ''))) &&
    (type !== 'price' || amount.trim() !== '');

  /* Units this school's active add-on purchases already grant towards the chosen allowance. */
  const addonUnits = type === 'limit' ? subscription.standing.grantedUnits[key]?.units ?? 0 : 0;

  /* The server keys errors by body field; the inputs carry prefixed ids, so the label is put in here. */
  const errorFor = (field: string, label: string) => rowError(fieldErrors, field, label);

  /**
   * An override's target as the rest of the product names it — a module's label, an allowance's
   * catalogue label, a price component in words. A feature key has no label anywhere, so it is shown
   * as the key the Features screen uses.
   *
   * `useCallback` because the columns memo captures it, as it does `valueOf`.
   */
  const labelFor = useCallback(
    (row: Pick<SubscriptionOverrideRow, 'override_type' | 'target_key'>) => {
      if (row.override_type === 'module') return moduleLabel(row.target_key);
      if (row.override_type === 'limit') return limitLabel(catalogue, row.target_key);
      if (row.override_type === 'price') return humanise(row.target_key);
      return row.target_key;
    },
    [catalogue]
  );

  function resetForm() {
    setType('');
    setTargetKey('');
    setIsEnabled('true');
    setLimitType('');
    setLimitValue('');
    setAmount('');
    setFrom('');
    setUntil('');
    setReason('');
    setFieldErrors({});
  }

  async function apply() {
    if (!complete || busy) return;
    setError(null);
    setFieldErrors({});

    if (type === 'feature' && (key.length < 2 || !FEATURE_KEY.test(key))) {
      setFieldErrors({
        target_key:
          'A feature key is at least two characters: a lower-case letter or digit first, then lower-case letters, digits, underscores, dots or hyphens.',
      });
      focusFirstInvalidField();
      return;
    }

    setBusy(true);
    try {
      /*
       * Only the fields the chosen type accepts are sent. The schema `forbidden()`s the rest by
       * name — `is_enabled` on a limit override, `limit_value` on an unlimited one — so sending a
       * blank one is a 422 explaining a field the operator never filled in.
       */
      const body: Record<string, unknown> = {
        override_type: type,
        target_key: key,
      };
      if (type === 'module' || type === 'feature') body.is_enabled = isEnabled === 'true';
      if (type === 'limit') {
        body.limit_type = limitType;
        if (limitType === 'fixed') body.limit_value = limitValue.trim();
      }
      if (type === 'price') body.amount = amount.trim();
      /* Whole days in the operator's zone — see the header. */
      if (from) body.effective_from = dayBound(from, 'start');
      if (until) body.effective_until = dayBound(until, 'end');
      if (reason.trim()) body.reason = reason.trim();

      const result = await api.post<OverrideResponse>(
        `/subscriptions/${subscription.id}/overrides`,
        body
      );
      /*
       * Replaced or new is the server's answer, read before the record is adopted: a row id this
       * screen already held is a row the service updated in place.
       */
      const existing = subscription.overrides.find((row) => row.id === result.override.id) ?? null;
      onChanged(result.subscription);
      success(
        existing ? 'Override replaced' : 'Override applied',
        existing
          ? existing.is_active
            ? 'The previous value for this target is no longer in force.'
            : 'The revoked override on this target was overwritten; its earlier values remain in the audit trail.'
          : `${humanise(result.override.override_type)} override on ${labelFor(result.override)}.`
      );
      resetForm();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const { perField, banner } = splitApiErrors(caught, APPLY_FIELDS);
        setFieldErrors(perField);
        setError(banner);
        if (Object.keys(perField).length) focusFirstInvalidField();
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking || revokeBusy) return;
    setRevokeBusy(true);
    setRevokeError(null);
    setRevokeFieldErrors({});
    try {
      const result = await api.post<OverrideResponse>(
        `/subscriptions/${subscription.id}/overrides/${revoking.id}/revoke`,
        revokeReason.trim() ? { reason: revokeReason.trim() } : {}
      );
      onChanged(result.subscription);
      success('Override revoked', 'The plan’s own value applies from now on.');
      setRevoking(null);
      setRevokeReason('');
    } catch (caught) {
      if (caught instanceof ApiError) {
        const { perField, banner } = splitApiErrors(caught, REVOKE_FIELDS);
        setRevokeFieldErrors(perField);
        setRevokeError(banner);
      } else {
        setRevokeError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setRevokeBusy(false);
    }
  }

  /**
   * What one override row actually sets, in the terms of its own type.
   *
   * `useCallback` because the columns memo captures it — see the note the taxes screen carries.
   */
  const valueOf = useCallback((row: SubscriptionOverrideRow) => {
    if (row.override_type === 'limit') {
      if (row.limit_type === 'unlimited') return 'unlimited';
      return row.limit_value === null ? '—' : Number(row.limit_value).toLocaleString();
    }
    if (row.override_type === 'price') {
      return row.amount === null
        ? '—'
        : formatCodeWithAmount(subscription.currency, row.amount);
    }
    return row.is_enabled ? 'enabled' : 'disabled';
  }, [subscription.currency]);

  const columns = useMemo<Column<SubscriptionOverrideRow>[]>(
    () => [
      {
        key: 'target',
        header: 'Target',
        cell: (row) => (
          <div>
            <span className="font-medium">{labelFor(row)}</span>
            <span className="block text-xs text-muted-soft">{humanise(row.override_type)}</span>
          </div>
        ),
      },
      { key: 'value', header: 'Sets', cell: (row) => <span>{valueOf(row)}</span> },
      {
        key: 'window',
        header: 'Window',
        cell: (row) => (
          <div className="text-xs text-muted">
            <span className="block">
              {formatDate(row.effective_from) ? `from ${formatDate(row.effective_from)}` : 'immediately'}
            </span>
            <span className="block text-muted-soft">
              {formatDate(row.effective_until)
                ? `through ${formatDate(row.effective_until)}`
                : 'until revoked'}
            </span>
          </div>
        ),
      },
      {
        key: 'standing',
        header: 'In force',
        cell: (row) => (
          <div>
            {/*
              * `active` / `inactive` rather than `active` / `revoked`, which was written first.
              * `is_active` is a boolean, not a status enum, and "revoked" is a word no backend
              * vocabulary emits — `StatusBadge` tones only words `constants.js` defines, so an
              * invented one renders as untoned grey and reads as a badge that failed to load.
              */}
            <StatusBadge status={row.is_active ? 'active' : 'inactive'} />
            {/*
              * Active and effective are different questions — see the header. Only the disagreement
              * is annotated, because an active override that is also in force needs no explanation.
              */}
            {row.is_active && !row.is_effective ? (
              <span className="block text-xs text-muted-soft">outside its window</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'reason',
        header: 'Reason',
        cell: (row) =>
          row.reason ? (
            <span className="text-xs text-muted">{row.reason}</span>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
      ...(canManage
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: SubscriptionOverrideRow) =>
                row.is_active ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger-ghost"
                    onClick={() => {
                      setRevoking(row);
                      setRevokeReason('');
                      setRevokeError(null);
                      setRevokeFieldErrors({});
                    }}
                  >
                    Revoke
                  </button>
                ) : (
                  <span className="text-muted-soft">—</span>
                ),
            } as Column<SubscriptionOverrideRow>,
          ]
        : []),
    ],
    [canManage, labelFor, valueOf]
  );

  return (
    <div className="space-y-8">
      {subscription.overrides.length === 0 ? (
        <EmptyNotice>
          No override is in place. What this school can do comes from its plan and its add-ons.
        </EmptyNotice>
      ) : (
        <DataTable
          columns={columns}
          rows={subscription.overrides}
          rowKey={(row) => row.id}
          caption="Overrides on this subscription"
        />
      )}

      {canManage ? (
        <FormSection
          title="Apply an override"
          description="An override is the highest-precedence source in the entitlement chain — above add-ons and above the plan."
        >
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void apply();
            }}
          >
            {error ? <Notice tone="error">{error}</Notice> : null}

            <SelectField
              id="override-type"
              label="What to override"
              required
              value={type}
              error={errorFor('override_type', 'What to override')}
              onChange={(event) => {
                setType(event.target.value);
                setTargetKey('');
                setLimitType('');
                setLimitValue('');
                setAmount('');
                setFieldErrors({});
              }}
            >
              <option value="">Choose…</option>
              {(catalogue?.overrideTypes ?? []).map((value) => (
                <option key={value} value={value}>
                  {humanise(value)}
                </option>
              ))}
            </SelectField>

            {type ? <Notice tone="info">{EXPLAINS[type] ?? ''}</Notice> : null}

            {type === 'module' ? (
              <SelectField
                id="override-module"
                label="Module"
                required
                value={targetKey}
                error={errorFor('target_key', 'Module')}
                onChange={(event) => setTargetKey(event.target.value)}
              >
                <option value="">Choose a module…</option>
                {MODULES.map((module) => (
                  <option key={module.key} value={module.key}>
                    {module.label}
                  </option>
                ))}
              </SelectField>
            ) : null}

            {type === 'limit' ? (
              <SelectField
                id="override-limit"
                label="Allowance"
                required
                value={targetKey}
                error={errorFor('target_key', 'Allowance')}
                onChange={(event) => setTargetKey(event.target.value)}
              >
                <option value="">Choose an allowance…</option>
                {limitTargets.map((limit) => (
                  <option key={limit.key} value={limit.key}>
                    {limit.label}
                    {limit.unit ? ` (${limit.unit})` : ''}
                  </option>
                ))}
              </SelectField>
            ) : null}

            {type === 'price' ? (
              <SelectField
                id="override-price-target"
                label="Price component"
                required
                value={targetKey}
                error={errorFor('target_key', 'Price component')}
                onChange={(event) => setTargetKey(event.target.value)}
              >
                <option value="">Choose…</option>
                {priceTargets.map((target) => (
                  <option key={target} value={target}>
                    {humanise(target)}
                  </option>
                ))}
              </SelectField>
            ) : null}

            {type === 'feature' ? (
              <>
                {/*
                  * Lower-cased as it is typed rather than refused on submit: the case is never
                  * the operator's intent, and a box that shows the key as it will be stored cannot
                  * surprise anyone. The shape check waits for submit, so a half-typed key is not
                  * shouted at.
                  */}
                <Field
                  id="override-feature"
                  label="Feature key"
                  required
                  maxLength={60}
                  autoComplete="off"
                  list={FEATURE_LIST_ID}
                  value={targetKey}
                  error={errorFor('target_key', 'Feature key')}
                  onChange={(event) => setTargetKey(event.target.value.toLowerCase())}
                  hint="Lower-case letters, digits, underscores, dots and hyphens, as on the plan’s Features screen. The keys already in use are suggested as you type."
                />
                <KnownFeatureKeys listId={FEATURE_LIST_ID} />
              </>
            ) : null}

            {replaces ? (
              <Notice tone="warn">
                This subscription already carries an active {humanise(type).toLowerCase()} override on{' '}
                <strong>{labelFor({ override_type: type, target_key: key })}</strong>. Applying another
                replaces it — one target holds one override.
              </Notice>
            ) : revives ? (
              <Notice tone="warn">
                This subscription has a revoked {humanise(type).toLowerCase()} override on{' '}
                <strong>{labelFor({ override_type: type, target_key: key })}</strong>. Applying one
                reuses that row: its value, window and reason are overwritten, and the revoked
                arrangement is then kept only in the audit trail.
              </Notice>
            ) : null}

            {type === 'module' || type === 'feature' ? (
              <SelectField
                id="override-enabled"
                label="Set it to"
                required
                value={isEnabled}
                error={errorFor('is_enabled', 'Set it to')}
                onChange={(event) => setIsEnabled(event.target.value)}
                hint="Required on a module or feature override: entitlement resolution ignores one with no value."
              >
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </SelectField>
            ) : null}

            {type === 'limit' ? (
              <>
                <SelectField
                  id="override-limit-type"
                  label="Limit type"
                  required
                  value={limitType}
                  error={errorFor('limit_type', 'Limit type')}
                  onChange={(event) => setLimitType(event.target.value)}
                >
                  <option value="">Choose…</option>
                  {(catalogue?.limitTypes ?? []).map((value) => (
                    <option key={value} value={value}>
                      {humanise(value)}
                    </option>
                  ))}
                </SelectField>

                {limitType === 'fixed' ? (
                  <Field
                    id="override-limit-value"
                    label="Allowance"
                    type="number"
                    min={0}
                    required
                    value={limitValue}
                    error={errorFor('limit_value', 'Allowance')}
                    onChange={(event) => setLimitValue(event.target.value)}
                    hint={
                      addonUnits > 0
                        ? `Replaces the plan’s value. This school’s active add-ons grant ${addonUnits.toLocaleString()} more on top, so its total will be this figure plus ${addonUnits.toLocaleString()}.`
                        : 'Replaces the plan’s value. Add-on units the school buys later are added on top of it.'
                    }
                  />
                ) : null}
              </>
            ) : null}

            {type === 'price' ? (
              <Field
                id="override-amount"
                label={`Amount per billing period (${subscription.currency})`}
                type="number"
                min={0}
                step="0.01"
                required
                value={amount}
                error={errorFor('amount', 'Amount per billing period')}
                onChange={(event) => setAmount(event.target.value)}
                hint="What the plan line bills for each period that starts while this is in effect. Add-ons, the setup fee and overage are billed on top; invoices already raised are not re-issued."
              />
            ) : null}

            {type ? (
              <>
                <Field
                  id="override-from"
                  label="Effective from"
                  type="date"
                  value={from}
                  error={errorFor('effective_from', 'Effective from')}
                  onChange={(event) => setFrom(event.target.value)}
                  hint="Leave blank to apply immediately. A date starts at the beginning of that day, in your time zone."
                />
                <Field
                  id="override-until"
                  label="Effective until (inclusive)"
                  type="date"
                  value={until}
                  error={errorFor('effective_until', 'Effective until')}
                  onChange={(event) => setUntil(event.target.value)}
                  hint="The override lasts through the end of that day, in your time zone. Leave blank for one that lasts until it is revoked — the ordinary case for a negotiated allowance."
                />
                <TextAreaField
                  id="override-reason"
                  label="Reason"
                  rows={2}
                  maxLength={255}
                  value={reason}
                  error={errorFor('reason', 'Reason')}
                  onChange={(event) => setReason(event.target.value)}
                  hint="Up to 255 characters. Stored on the override row itself, not only in the audit trail. This is what explains the exception to whoever finds it later."
                />
              </>
            ) : null}

            <SubmitButton
              busy={busy}
              busyLabel="Applying…"
              fullWidth={false}
              disabled={!complete}
            >
              {replaces || revives ? 'Replace override' : 'Apply override'}
            </SubmitButton>
          </form>
        </FormSection>
      ) : null}

      <Modal
        open={revoking !== null}
        onClose={() => {
          if (!revokeBusy) setRevoking(null);
        }}
        title={`Revoke the override on ${revoking ? labelFor(revoking) : 'this target'}?`}
        description="The plan’s own value applies from that moment. The row is kept and marked inactive rather than deleted — until another override is applied to the same target, which reuses this row and overwrites it, leaving the earlier values only in the audit trail."
        size="sm"
        busy={revokeBusy}
        footer={
          <>
            {/* "Cancel", not "Close" — `Modal`'s own dismiss control already carries that name. */}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={revokeBusy}
              onClick={() => setRevoking(null)}
            >
              Cancel
            </button>
            <SubmitButton
              form="revoke-override"
              busy={revokeBusy}
              busyLabel="Revoking…"
              fullWidth={false}
            >
              Revoke
            </SubmitButton>
          </>
        }
      >
        <form
          id="revoke-override"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void revoke();
          }}
        >
          {revokeError ? <Notice tone="error">{revokeError}</Notice> : null}
          <TextAreaField
            id="revoke-reason"
            label="Reason"
            rows={2}
            maxLength={255}
            value={revokeReason}
            error={rowError(revokeFieldErrors, 'reason', 'Reason')}
            onChange={(event) => setRevokeReason(event.target.value)}
            hint="Up to 255 characters. Recorded in the audit trail."
          />
        </form>
      </Modal>
    </div>
  );
}
