'use client';

/**
 * Add-ons bought onto one subscription — SRS §11.3 / FR-SUB-009.
 *
 * `POST /:id/addons` and `POST /:id/addons/:addonId/cancel`, neither of which had a caller. The
 * catalogue screen at `/super-admin/addons` could put an add-on on sale and take it off again; there
 * was no way to sell one to anybody.
 *
 * ## The purchase copy is the point of this table
 *
 * `subscriptions.validation.js` forbids `unit_amount`, `effect_type`, `effect_target`,
 * `units_granted` and `currency` by name, each with a message saying they are copied from the
 * `addons` and `addon_prices` rows **at purchase time**. That is not a detail: it is why editing the
 * add-on catalogue later cannot change what a school already bought. So the table shows the copy on
 * the purchase row rather than the current catalogue value, and never joins back to the live add-on
 * for anything but its name.
 *
 * ## `:addonId` is the purchase, not the add-on
 *
 * The cancel route takes a `subscription_addons.id`. A school may hold two purchases of the same
 * add-on — two blocks of a hundred students — and cancelling one must not cancel both. That is why
 * the row action passes `row.id` and never `row.addon_id`, and why the confirmation names the
 * quantity as well as the add-on.
 *
 * ## Cancelling withdraws the units, and says how many
 *
 * `cancelAddon()` answers with `purchase.unitsWithdrawn`, which is what the school's allowance drops
 * by. An operator cancelling a limit increase on a school already over the plan's own limit needs
 * that number, so it is in the toast rather than only in the audit row.
 *
 * ## What is not offered here
 *
 * There is no *edit*. `subscription_addons` has no update route, and the honest reading of §11.3 is
 * that a purchase is a purchase: changing a quantity is cancelling one and buying another, and both
 * halves are recorded. Inventing a PATCH would be inventing a requirement, and the two-step is also
 * the one the invoice line in §13 can follow.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { formatCodeWithAmount } from '@/lib/money';
import { useCollection } from '@/lib/useCollection';
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
import type { SubscriptionAddonRow, SubscriptionDetail } from './detail';

/** One `addon_prices` row, as `/addons` includes them. */
interface AddonPrice {
  id: number;
  billing_cycle: string;
  currency: string;
  unit_amount: number | string | null;
  plan_id: number | null;
  is_active: boolean;
}

/** One row of `GET /addons`, of which this screen reads what a purchase needs. */
interface AddonOption {
  id: number;
  key: string;
  name: string;
  effect_type: string;
  effect_target: string;
  units_per_quantity: number | string;
  unit: string | null;
  is_active: boolean;
  prices: AddonPrice[];
  readiness: { purchasable: boolean };
}

interface PurchaseResponse {
  subscription: SubscriptionDetail;
  purchase: {
    id: number;
    quantity: number;
    unitsGranted: number;
    effectTarget: string;
    addon: { name: string };
  };
}

interface CancelResponse {
  subscription: SubscriptionDetail;
  purchase: { id: number; unitsWithdrawn: number | null };
}

/** BIGINT arrives as a string; this is display only, never arithmetic. */
function formatUnits(value: number | string | null): string {
  if (value === null) return '—';
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric.toLocaleString() : String(value);
}

export function AddonsPanel({
  subscription,
  canBuy,
  onChanged,
}: {
  subscription: SubscriptionDetail;
  /** `subscriptions.manage` or `subscriptions.self.manage` — `canBuyAddons()` in the router. */
  canBuy: boolean;
  onChanged: (subscription: SubscriptionDetail) => void;
}) {
  const { success } = useToast();

  const catalogue = useCollection<AddonOption>('/addons', { limit: 100, is_active: 'true' });

  const [addonId, setAddonId] = useState('');
  const [priceId, setPriceId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cancelling, setCancelling] = useState<SubscriptionAddonRow | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const chosen = useMemo(
    () => catalogue.rows.find((row) => String(row.id) === addonId) ?? null,
    [catalogue.rows, addonId]
  );

  /*
   * Every add-on on sale, and not one of them priced.
   *
   * ## This block replaces a control that was stricter than the API, which is a defect
   *
   * Found by driving this screen against a database where no `addon_prices` row exists. The first
   * version marked each add-on "(not purchasable)" and **disabled** it, from `readiness.purchasable`
   * — which is `is_active` **and** at least one active price. That is the right test for the Add-ons
   * catalogue screen, where "purchasable" means "a school could buy this", and the wrong one here.
   *
   * `subscriptions.service.purchaseAddon()` refuses exactly one thing: an add-on that is not
   * `is_active`. A price is **optional** — `addon_price_id` is nullable and `SET NULL` on purpose,
   * because §11.3 add-ons are granted at no charge as part of a negotiation, and this screen's own
   * price control says so two fields further down. So the first version forbade a supported
   * operation, and forbade it for precisely the add-ons that need it.
   *
   * A screen may be looser than the API — the API is the guard. It may not be tighter, because
   * nothing then tells the operator that the thing they cannot do is a thing the system does.
   */
  const nothingPriced =
    !catalogue.loading &&
    catalogue.rows.length > 0 &&
    catalogue.rows.every((row) => !row.readiness.purchasable);

  /*
   * Prices this subscription may actually be charged on.
   *
   * `purchaseAddon()` checks that a named price belongs to the add-on **and is not restricted to a
   * different plan** — `addon_prices.plan_id` is that restriction. Filtering here means the select
   * cannot offer a price whose only outcome is a 422; the service still checks, because a screen is
   * not a guard.
   */
  const prices = useMemo(
    () =>
      (chosen?.prices ?? []).filter(
        (price) =>
          price.is_active && (price.plan_id === null || price.plan_id === subscription.plan_id)
      ),
    [chosen, subscription.plan_id]
  );

  async function purchase() {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { addon_id: chosen.id };
      if (priceId) body.addon_price_id = Number(priceId);
      if (quantity.trim()) body.quantity = quantity.trim();
      if (reason.trim()) body.reason = reason.trim();

      const result = await api.post<PurchaseResponse>(
        `/subscriptions/${subscription.id}/addons`,
        body
      );
      onChanged(result.subscription);
      success(
        `${result.purchase.addon.name} purchased`,
        result.purchase.unitsGranted > 0
          ? `${result.purchase.unitsGranted.toLocaleString()} added to ${result.purchase.effectTarget}.`
          : `${result.purchase.effectTarget} unlocked.`
      );
      setAddonId('');
      setPriceId('');
      setQuantity('1');
      setReason('');
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

  async function cancel() {
    if (!cancelling || cancelBusy) return;
    setCancelBusy(true);
    setCancelError(null);
    try {
      const result = await api.post<CancelResponse>(
        `/subscriptions/${subscription.id}/addons/${cancelling.id}/cancel`,
        cancelReason.trim() ? { reason: cancelReason.trim() } : {}
      );
      onChanged(result.subscription);
      success(
        'Add-on cancelled',
        result.purchase.unitsWithdrawn
          ? `${Number(result.purchase.unitsWithdrawn).toLocaleString()} unit(s) withdrawn from this subscription’s allowance.`
          : undefined
      );
      setCancelling(null);
      setCancelReason('');
    } catch (caught) {
      setCancelError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setCancelBusy(false);
    }
  }

  const columns = useMemo<Column<SubscriptionAddonRow>[]>(
    () => [
      {
        key: 'addon',
        header: 'Add-on',
        cell: (row) => (
          <div>
            <span className="font-medium">{row.addon ? row.addon.name : `Add-on #${row.addon_id}`}</span>
            <span className="block text-xs text-muted-soft">
              {row.addon ? row.addon.key : ''}
            </span>
          </div>
        ),
      },
      {
        key: 'grants',
        header: 'Grants',
        cell: (row) => (
          <div>
            {/*
              * The purchase copy, not the catalogue's current value — see the header. A
              * `feature_unlock` grants no units, so it says what it unlocks instead of "0".
              */}
            <span>
              {row.effect_type === 'limit_increase'
                ? `${formatUnits(row.units_granted)} → ${row.effect_target}`
                : `Unlocks ${row.effect_target}`}
            </span>
            <span className="block text-xs text-muted-soft">
              × {row.quantity} · {humanise(row.effect_type)}
            </span>
          </div>
        ),
      },
      {
        key: 'price',
        header: 'Unit price',
        numeric: true,
        cell: (row) =>
          /*
           * Zero, not null, is what a no-charge grant looks like.
           *
           * This read `row.unit_amount === null` first, on the reasoning that `addon_price_id` is
           * nullable and `SET NULL`. That is true of the *price pointer* and not of this column:
           * `purchaseAddon()` writes `price ? money.round(price.unit_amount) : 0`, so the null branch
           * was unreachable and every no-charge purchase rendered as "USD 0.00". Found by making one.
           */
          Number(row.unit_amount) === 0 ? (
            <span className="text-muted-soft">no charge</span>
          ) : (
            <span>{formatCodeWithAmount(row.currency ?? subscription.currency, row.unit_amount)}</span>
          ),
      },
      {
        key: 'window',
        header: 'Window',
        cell: (row) => (
          <div className="text-xs text-muted">
            <span className="block">{formatDate(row.starts_at) ?? 'from purchase'}</span>
            <span className="block text-muted-soft">
              {formatDate(row.ends_at) ?? (row.is_recurring ? 'recurring' : 'no end date')}
            </span>
          </div>
        ),
      },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
      ...(canBuy
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: SubscriptionAddonRow) =>
                row.status === 'active' ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger-ghost"
                    onClick={() => {
                      setCancelling(row);
                      setCancelReason('');
                      setCancelError(null);
                    }}
                  >
                    Cancel
                  </button>
                ) : (
                  <span className="text-muted-soft">—</span>
                ),
            } as Column<SubscriptionAddonRow>,
          ]
        : []),
    ],
    [canBuy, subscription.currency]
  );

  return (
    <div className="space-y-8">
      {subscription.addons.length === 0 ? (
        <EmptyNotice>
          Nothing has been bought onto this subscription. What the school can do comes from its plan
          alone.
        </EmptyNotice>
      ) : (
        <DataTable
          columns={columns}
          rows={subscription.addons}
          rowKey={(row) => row.id}
          caption="Add-ons purchased onto this subscription"
        />
      )}

      {canBuy ? (
        <FormSection
          title="Buy an add-on"
          description="What is bought is copied onto the purchase — a later change to the add-on catalogue does not change what this school has."
        >
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void purchase();
            }}
          >
            {error ? <Notice tone="error">{error}</Notice> : null}
            {catalogue.error ? (
              <Notice tone="error">The add-on catalogue could not be loaded: {catalogue.error}</Notice>
            ) : null}
            {nothingPriced ? (
              <Notice tone="info">
                No add-on has a price set, so anything bought here is granted at no charge and raises
                no invoice line. That is a supported outcome, not a blocked one — if it should be
                billed, set a price on the{' '}
                <Link href="/super-admin/addons" className="font-medium underline underline-offset-2">
                  Add-ons
                </Link>{' '}
                screen first.
              </Notice>
            ) : null}

            <SelectField
              id="addon-choice"
              label="Add-on"
              required
              value={addonId}
              onChange={(event) => {
                setAddonId(event.target.value);
                setPriceId('');
              }}
              hint={
                catalogue.loading
                  ? 'Loading the catalogue…'
                  : 'Only add-ons currently on sale are listed — the API refuses one that has been taken off sale. "No price set" means it can still be granted, at no charge.'
              }
            >
              <option value="">Choose an add-on…</option>
              {catalogue.rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                  {row.effect_type === 'limit_increase'
                    ? ` — ${formatUnits(row.units_per_quantity)} ${row.unit ?? ''} per unit`.trimEnd()
                    : ` — unlocks ${row.effect_target}`}
                  {/* A statement about billing, not about availability — see `nothingPriced`. */}
                  {row.readiness.purchasable ? '' : ' (no price set)'}
                </option>
              ))}
            </SelectField>

            {chosen ? (
              <SelectField
                id="addon-price"
                label="Price"
                value={priceId}
                onChange={(event) => setPriceId(event.target.value)}
                hint={
                  prices.length === 0
                    ? 'This add-on has no active price this subscription’s plan may be charged on. Buying it without one grants the add-on at no charge.'
                    : 'Leave blank to grant the add-on at no charge — the purchase row survives a price being retired either way.'
                }
              >
                <option value="">No charge</option>
                {prices.map((price) => (
                  <option key={price.id} value={price.id}>
                    {formatCodeWithAmount(price.currency, price.unit_amount)} ·{' '}
                    {humanise(price.billing_cycle)}
                    {price.plan_id === null ? '' : ' · this plan only'}
                  </option>
                ))}
              </SelectField>
            ) : null}

            <Field
              id="addon-quantity"
              label="Quantity"
              type="number"
              min={1}
              required
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              hint={
                chosen && chosen.effect_type === 'limit_increase'
                  ? `Each unit grants ${formatUnits(chosen.units_per_quantity)} ${chosen.unit ?? ''}.`.replace(
                      ' .',
                      '.'
                    )
                  : 'How many blocks of this add-on to buy.'
              }
            />

            <TextAreaField
              id="addon-reason"
              label="Reason"
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              hint="Recorded in the audit trail — a negotiated grant is worth explaining."
            />

            <SubmitButton busy={busy} busyLabel="Purchasing…" fullWidth={false} disabled={!chosen}>
              Purchase
            </SubmitButton>
          </form>
        </FormSection>
      ) : null}

      <Modal
        open={cancelling !== null}
        onClose={() => {
          if (!cancelBusy) setCancelling(null);
        }}
        title={`Cancel ${cancelling?.addon ? cancelling.addon.name : 'this add-on'}?`}
        description={
          cancelling && cancelling.effect_type === 'limit_increase'
            ? `The ${formatUnits(cancelling.units_granted)} it grants towards ${cancelling.effect_target} are withdrawn from this subscription’s allowance. The purchase row is kept — §13 raised an invoice line against it — and is marked cancelled rather than deleted.`
            : 'What it unlocks is withdrawn. The purchase row is kept and marked cancelled rather than deleted, because §13 raised an invoice line against it.'
        }
        size="sm"
        busy={cancelBusy}
        footer={
          <>
            {/*
              * "Go back", not "Cancel" and not "Close".
              *
              * "Close" duplicates the accessible name of `Modal`'s own dismiss control, and a dialog
              * with two buttons named "Close" is one a screen reader cannot describe. "Cancel" — the
              * label every other dialog in the product uses — is worse here for a different reason:
              * it would sit beside "Cancel add-on" and mean the opposite of it. Both were tried; the
              * dialog was read back with both in place.
              */}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={cancelBusy}
              onClick={() => setCancelling(null)}
            >
              Go back
            </button>
            <SubmitButton
              form="cancel-addon"
              busy={cancelBusy}
              busyLabel="Cancelling…"
              fullWidth={false}
            >
              Cancel add-on
            </SubmitButton>
          </>
        }
      >
        <form
          id="cancel-addon"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void cancel();
          }}
        >
          {cancelError ? <Notice tone="error">{cancelError}</Notice> : null}
          <TextAreaField
            id="cancel-addon-reason"
            label="Reason"
            rows={2}
            value={cancelReason}
            onChange={(event) => setCancelReason(event.target.value)}
            hint="Recorded in the audit trail."
          />
        </form>
      </Modal>
    </div>
  );
}
