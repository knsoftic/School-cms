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
 * ## The vocabulary comes from the catalogue, with two deliberate exceptions
 *
 * `subscriptions.service.catalogue()` publishes `limitTargets` (nine keys — §11.2's eight **plus**
 * the add-on-only `sms_limit`), `limitTypes` and `priceTargets`. Module targets come from
 * `lib/modules.ts`, which is the copy `verify-frontend.js` asserts against the backend's own
 * `MODULE_LABELS` in both directions; publishing them a second way would be a third copy.
 *
 * **Feature targets have no list, and that is a property of the source rather than a gap here.**
 * `plan_features` carries its own `name` and `module_key` per row: a feature is self-describing, and
 * §11 fixes no feature vocabulary anywhere. The override schema does not restrict `target_key` for a
 * feature either — the schema and the missing list are the same fact — so the control is a text box
 * and says where the key has to come from. The same reasoning is already recorded on the Features
 * screen, which cannot show what a plan is *missing* for the same reason.
 *
 * ## Applying an override twice replaces it
 *
 * `subscription_overrides` has a unique index over `(subscription_id, override_type, target_key)`, so
 * a second override on the same target is an update and the API answers 200 rather than 201. The
 * form says so where it can be acted on — beside the target — rather than leaving an operator to
 * discover it by finding one row where they expected two.
 *
 * ## Revoked is not deleted
 *
 * Revoking sets `is_active` false. The row stays, and `is_effective` — computed by the same
 * `isEffective()` the entitlement resolver uses — is what says whether it is in force *now*. Those
 * are two different columns and the table shows both, because an override can be active and not yet
 * effective (a window starting next month), which looks like a broken save if only one is shown.
 */

import { useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { formatCodeWithAmount } from '@/lib/money';
import { MODULES, moduleLabel } from '@/lib/modules';
import {
  Field,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
} from '@/components/form';
import { Modal } from '@/components/overlay';
import { Column, DataTable, EmptyNotice, StatusBadge } from '@/components/table';
import { useToast } from '@/components/toast';

import { formatDate, humanise } from './detail';
import type {
  SubscriptionCatalogue,
  SubscriptionDetail,
  SubscriptionOverrideRow,
} from './detail';

interface OverrideResponse {
  subscription: SubscriptionDetail;
  override: SubscriptionOverrideRow;
}

/** What each type overrides, in one sentence, shown once a type is chosen. */
const EXPLAINS: Record<string, string> = {
  module:
    'Turns one of the twenty §11.1 modules on or off for this school, whatever the plan says. An override naming anything else is ignored by entitlement resolution, so the list is fixed.',
  feature:
    'Turns one feature on or off. Features are named per plan rather than drawn from a fixed list, so the key has to be typed — take it from the plan’s own Features screen.',
  limit:
    'Replaces one allowance. This is where a negotiated ceiling lives — including SMS credits, which are not a plan limit at all and can only be raised here or by an add-on.',
  price:
    'Replaces the amount billed each cycle. It does not change the plan’s price for anyone else, and it does not re-issue invoices already raised.',
};

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

  const [revoking, setRevoking] = useState<SubscriptionOverrideRow | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const limitTargets = catalogue?.limitTargets ?? [];
  const priceTargets = catalogue?.priceTargets ?? [];

  /** True when this target already carries an active override, which a save would replace. */
  const replaces = useMemo(
    () =>
      subscription.overrides.some(
        (row) => row.override_type === type && row.target_key === targetKey && row.is_active
      ),
    [subscription.overrides, type, targetKey]
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
  }

  async function apply() {
    if (!type || !targetKey.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      /*
       * Only the fields the chosen type accepts are sent. The schema `forbidden()`s the rest by
       * name — `is_enabled` on a limit override, `limit_value` on an unlimited one — so sending a
       * blank one is a 422 explaining a field the operator never filled in.
       */
      const body: Record<string, unknown> = {
        override_type: type,
        target_key: targetKey.trim(),
      };
      if (type === 'module' || type === 'feature') body.is_enabled = isEnabled === 'true';
      if (type === 'limit') {
        body.limit_type = limitType;
        if (limitType === 'fixed') body.limit_value = limitValue.trim();
      }
      if (type === 'price') body.amount = amount.trim();
      if (from) body.effective_from = from;
      if (until) body.effective_until = until;
      if (reason.trim()) body.reason = reason.trim();

      const result = await api.post<OverrideResponse>(
        `/subscriptions/${subscription.id}/overrides`,
        body
      );
      onChanged(result.subscription);
      success(
        replaces ? 'Override replaced' : 'Override applied',
        replaces
          ? 'The previous value for this target is no longer in force.'
          : `${humanise(result.override.override_type)} override on ${result.override.target_key}.`
      );
      resetForm();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking || revokeBusy) return;
    setRevokeBusy(true);
    setRevokeError(null);
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
      setRevokeError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setRevokeBusy(false);
    }
  }

  /** What one override row actually sets, in the terms of its own type. */
  function valueOf(row: SubscriptionOverrideRow) {
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
  }

  const columns = useMemo<Column<SubscriptionOverrideRow>[]>(
    () => [
      {
        key: 'target',
        header: 'Target',
        cell: (row) => (
          <div>
            <span className="font-medium">
              {row.override_type === 'module' ? moduleLabel(row.target_key) : row.target_key}
            </span>
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
            <span className="block">{formatDate(row.effective_from) ?? 'immediately'}</span>
            <span className="block text-muted-soft">
              {formatDate(row.effective_until) ?? 'until revoked'}
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
    [canManage, subscription.currency]
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
              onChange={(event) => {
                setType(event.target.value);
                setTargetKey('');
                setLimitType('');
                setLimitValue('');
                setAmount('');
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
              <Field
                id="override-feature"
                label="Feature key"
                required
                value={targetKey}
                onChange={(event) => setTargetKey(event.target.value)}
                hint="Taken from the plan’s Features screen — features are named per plan, so there is no fixed list to choose from."
              />
            ) : null}

            {replaces ? (
              <Notice tone="warn">
                This subscription already carries an active {humanise(type).toLowerCase()} override on{' '}
                <strong>{targetKey}</strong>. Applying another replaces it — one target holds one
                override.
              </Notice>
            ) : null}

            {type === 'module' || type === 'feature' ? (
              <SelectField
                id="override-enabled"
                label="Set it to"
                required
                value={isEnabled}
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
                    onChange={(event) => setLimitValue(event.target.value)}
                    hint="The number this school is allowed, replacing whatever the plan sets."
                  />
                ) : null}
              </>
            ) : null}

            {type === 'price' ? (
              <Field
                id="override-amount"
                label={`Amount per cycle (${subscription.currency})`}
                type="number"
                min={0}
                step="0.01"
                required
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                hint="Replaces what this school is billed each cycle. Invoices already raised are not re-issued."
              />
            ) : null}

            {type ? (
              <>
                <Field
                  id="override-from"
                  label="Effective from"
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  hint="Leave blank to apply immediately."
                />
                <Field
                  id="override-until"
                  label="Effective until"
                  type="date"
                  value={until}
                  onChange={(event) => setUntil(event.target.value)}
                  hint="Leave blank for an override that lasts until it is revoked — the ordinary case for a negotiated allowance."
                />
                <TextAreaField
                  id="override-reason"
                  label="Reason"
                  rows={2}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  hint="Stored on the override row itself, not only in the audit trail. This is what explains the exception to whoever finds it later."
                />
              </>
            ) : null}

            <SubmitButton
              busy={busy}
              busyLabel="Applying…"
              fullWidth={false}
              disabled={!type || !targetKey.trim()}
            >
              {replaces ? 'Replace override' : 'Apply override'}
            </SubmitButton>
          </form>
        </FormSection>
      ) : null}

      <Modal
        open={revoking !== null}
        onClose={() => {
          if (!revokeBusy) setRevoking(null);
        }}
        title={`Revoke the override on ${revoking ? revoking.target_key : 'this target'}?`}
        description="The plan’s own value applies from that moment. The row is kept and marked inactive rather than deleted, so the exception and the reason for it stay on the record."
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
            value={revokeReason}
            onChange={(event) => setRevokeReason(event.target.value)}
            hint="Recorded in the audit trail."
          />
        </form>
      </Modal>
    </div>
  );
}
