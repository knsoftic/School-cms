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
 * the row action passes `row.id` and never `row.addon_id`, and why the confirmation names the units
 * that one purchase grants.
 *
 * The billing side now holds to the same rule. `cancelAddon()` used to close every
 * `subscription_items` line with the same `addon_id`, so cancelling one of two purchases left the
 * other granting its units and never invoiced again. Each line now carries the purchase it bills in
 * `metadata.subscription_addon_id`, and only that line is closed — which is what lets the dialog say
 * "its billing line" without a qualification.
 *
 * ## Only prices on the subscription's own cycle and currency are offered
 *
 * An add-on's line is billed once per subscription period, on an invoice in the subscription's
 * currency — nothing downstream reads the price's own cycle. So a monthly price on a yearly
 * subscription billed its monthly figure once a year, a EUR price billed as USD, and a one-time price
 * recurred. `purchaseAddon()` now refuses the mismatch; the select does not offer it, and says how
 * many it left out so a price the operator expected is not simply missing.
 *
 * ## A price is required
 *
 * The owner's decision D21 (closing Known Issues #18): a purchase must name its price. One that named
 * none used to be recorded at 0.00 and printed as a zero line on every invoice — a billing figure
 * nobody chose — and this form offered it as "No charge". The API now refuses it, and so does the form.
 *
 * ## A purchase into a period already invoiced is invoiced at once
 *
 * The owner's decision D24: a period's invoice is issued when the period starts, so an add-on bought
 * after that was free until the next period — and a one-off one never billed. `purchaseAddon()` now
 * issues an invoice of its own when the current period already has one: a recurring add-on prorated
 * for the rest of the period, a one-off at its full amount. The response names it as `invoice` (null
 * when nothing was issued — a period not yet invoiced carries the line on its own invoice), and the
 * panel says which invoice and for how much, and keeps saying it after the form clears, as the plan
 * change panel does for its proration invoice. A charge the school did not expect is the thing an
 * operator is asked about, and the answer is that number.
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
import { useCallback, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { rowError, splitApiErrors } from '@/lib/formErrors';
import { formatCodeWithAmount } from '@/lib/money';
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

import { cycleLabel, formatDate, howToBringIntoUse, humanise, limitLabel, sameCycle } from './detail';
import type { SubscriptionAddonRow, SubscriptionCatalogue, SubscriptionDetail } from './detail';

/** The purchase form's inputs, by the body field each sends. A 422 on anything else is a banner. */
const PURCHASE_FIELDS = new Set(['addon_id', 'addon_price_id', 'quantity', 'reason']);
const CANCEL_FIELDS = new Set(['reason']);

/** One `addon_prices` row, as `/addons` includes them. */
interface AddonPrice {
  id: number;
  billing_cycle: string;
  /** Set only for `custom_days`, where it is part of what the cycle is. */
  cycle_days: number | null;
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

/** The invoice D24 issues at purchase — `purchaseAddon()` returns these three fields, or null. */
interface PurchaseInvoice {
  id: number;
  invoice_number: string;
  total: number | string;
}

interface PurchaseResponse {
  subscription: SubscriptionDetail;
  purchase: {
    id: number;
    quantity: number;
    unitsGranted: number;
    effectTarget: string;
    /** The purchase's currency — the price's, which `purchaseAddon()` requires to be the subscription's. */
    currency: string;
    addon: { name: string };
  };
  /** Null when the period had no invoice yet; absent from an API that predates D24. */
  invoice?: PurchaseInvoice | null;
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
  catalogue: vocabulary,
  canBuy,
  onChanged,
}: {
  subscription: SubscriptionDetail;
  /** The subscription catalogue — limit labels, and what brings an unusable subscription back. */
  catalogue: SubscriptionCatalogue | null;
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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /* The last purchase's D24 invoice, kept on screen after the form clears — see the header. */
  const [charged, setCharged] = useState<{
    addon: string;
    currency: string;
    /** Read off the purchase row the response carries: a recurring one is prorated, a one-off is not. */
    recurring: boolean;
    invoice: PurchaseInvoice;
  } | null>(null);

  const [cancelling, setCancelling] = useState<SubscriptionAddonRow | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelFieldErrors, setCancelFieldErrors] = useState<Record<string, string>>({});

  /*
   * What a limit-increase grants towards, by the catalogue's label rather than its key — "Student
   * Limit", not `student_limit`. A feature unlock's target is a feature key, which has no label
   * anywhere to take one from, so it stays the key the Features screen uses.
   *
   * `useCallback` because the columns memo captures it, as `valueOf` is on the overrides tab.
   */
  const targetLabel = useCallback(
    (effectType: string, target: string) =>
      effectType === 'limit_increase' ? limitLabel(vocabulary, target) : target,
    [vocabulary]
  );

  const chosen = useMemo(
    () => catalogue.rows.find((row) => String(row.id) === addonId) ?? null,
    [catalogue.rows, addonId]
  );

  /*
   * Every add-on on sale, and not one of them priced — so nothing can be bought here yet.
   *
   * Since D21 a purchase must name a price (see the header), so an add-on with no active price is
   * something the operator has to price on the Add-ons screen first. Said once, above the form, rather
   * than discovered as a refusal after choosing one.
   */
  const nothingPriced =
    !catalogue.loading &&
    catalogue.rows.length > 0 &&
    catalogue.rows.every((row) => !row.readiness.purchasable);

  /*
   * Prices this subscription may actually be charged on.
   *
   * `purchaseAddon()` checks that a named price belongs to the add-on, **is not restricted to a
   * different plan** — `addon_prices.plan_id` is that restriction — and bills on the subscription's
   * own cycle and currency (see the header). Filtering here means the select cannot offer a price
   * whose only outcome is a refusal; the service still checks, because a screen is not a guard.
   *
   * `offerable` is the first test alone, so the hint can say how many the cycle test left out.
   */
  const offerable = useMemo(
    () =>
      (chosen?.prices ?? []).filter(
        (price) =>
          price.is_active && (price.plan_id === null || price.plan_id === subscription.plan_id)
      ),
    [chosen, subscription.plan_id]
  );
  const prices = offerable.filter(
    (price) => price.currency === subscription.currency && sameCycle(price, subscription)
  );
  const otherCycleCount = offerable.length - prices.length;
  const billing = `${cycleLabel(subscription).toLowerCase()} in ${subscription.currency}`;

  async function purchase() {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setCharged(null);
    try {
      /* Always sent — D21 makes it required, and an empty choice comes back as a 422 on this field. */
      const body: Record<string, unknown> = { addon_id: chosen.id, addon_price_id: priceId ? Number(priceId) : null };
      if (quantity.trim()) body.quantity = quantity.trim();
      if (reason.trim()) body.reason = reason.trim();

      const result = await api.post<PurchaseResponse>(
        `/subscriptions/${subscription.id}/addons`,
        body
      );
      onChanged(result.subscription);
      const granted =
        result.purchase.unitsGranted > 0
          ? `${result.purchase.unitsGranted.toLocaleString()} added to ${limitLabel(vocabulary, result.purchase.effectTarget)}.`
          : `${result.purchase.effectTarget} unlocked.`;
      /* D24 — the period was already invoiced, so the purchase was charged on an invoice of its own. */
      const invoice = result.invoice ?? null;
      const currency = result.purchase.currency || subscription.currency;
      success(
        `${result.purchase.addon.name} purchased`,
        invoice
          ? `${granted} Invoiced at once as ${invoice.invoice_number} — ${formatCodeWithAmount(currency, invoice.total)}.`
          : granted
      );
      const bought = result.subscription.addons.find((row) => row.id === result.purchase.id);
      setCharged(
        invoice
          ? {
              addon: result.purchase.addon.name,
              currency,
              /* `is_recurring` defaults to true, and this form does not send it. */
              recurring: bought ? bought.is_recurring : true,
              invoice,
            }
          : null
      );
      setAddonId('');
      setPriceId('');
      setQuantity('1');
      setReason('');
    } catch (caught) {
      if (caught instanceof ApiError) {
        const { perField, banner } = splitApiErrors(caught, PURCHASE_FIELDS);
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

  async function cancel() {
    if (!cancelling || cancelBusy) return;
    setCancelBusy(true);
    setCancelError(null);
    setCancelFieldErrors({});
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
      if (caught instanceof ApiError) {
        const { perField, banner } = splitApiErrors(caught, CANCEL_FIELDS);
        setCancelFieldErrors(perField);
        setCancelError(banner);
      } else {
        setCancelError('Could not reach the server. Check your connection and try again.');
      }
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
                ? `${formatUnits(row.units_granted)} → ${targetLabel(row.effect_type, row.effect_target)}`
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
    [canBuy, subscription.currency, targetLabel]
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

      {/* D24's charge for the last purchase — kept after the form clears; see the header. */}
      {charged ? (
        <Notice tone="success">
          This period was already invoiced, so {charged.addon} was charged at purchase on invoice{' '}
          <Link
            href={`/super-admin/invoices/${charged.invoice.id}`}
            className="font-medium underline underline-offset-2"
          >
            {charged.invoice.invoice_number}
          </Link>{' '}
          — {formatCodeWithAmount(charged.currency, charged.invoice.total)}
          {charged.recurring
            ? ', prorated for the rest of the current period. Later invoices carry its full line.'
            : ', its full amount, once.'}
        </Notice>
      ) : null}

      {/*
        * `purchaseAddon()` refuses a subscription outside the usable states, so the form is not
        * offered on one — and the notice names the transition that would change that. Cancelling
        * carries no such test, so the table's Cancel buttons stay.
        */}
      {canBuy && !subscription.standing.isUsable ? (
        <Notice tone="info">
          Add-ons can be bought only onto a subscription in use, and this one is{' '}
          {humanise(subscription.state).toLowerCase()}.{' '}
          {howToBringIntoUse(vocabulary, subscription.state)}
          {subscription.standing.activeAddonCount > 0
            ? ' Purchases already on it can still be cancelled from the table above.'
            : ''}
        </Notice>
      ) : canBuy ? (
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
            {/*
              * A refusal as well as a failure: `/addons` has a read permission of its own, and
              * `useCollection` files a missing one under `refusal`. Checking `error` alone left an
              * account without it looking at an empty dropdown and no reason.
              */}
            {catalogue.refusal ? (
              <Notice tone="warn">
                This account cannot read the add-on catalogue, so there is nothing to offer:{' '}
                {catalogue.refusal.message}
              </Notice>
            ) : catalogue.error ? (
              <Notice tone="error">The add-on catalogue could not be loaded: {catalogue.error}</Notice>
            ) : null}
            {nothingPriced ? (
              <Notice tone="info">
                No add-on has a price set, and a purchase must name one — set a price on the{' '}
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
              error={rowError(fieldErrors, 'addon_id', 'Add-on')}
              onChange={(event) => {
                setAddonId(event.target.value);
                setPriceId('');
              }}
              hint={
                catalogue.loading
                  ? 'Loading the catalogue…'
                  : 'Only add-ons currently on sale are listed — the API refuses one that has been taken off sale. One marked "no price set" cannot be bought until it is priced.'
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
                required
                value={priceId}
                error={rowError(fieldErrors, 'addon_price_id', 'Price')}
                onChange={(event) => setPriceId(event.target.value)}
                hint={
                  prices.length === 0
                    ? `This add-on has no active price this subscription may be charged on — one open to its plan and billing ${billing}${
                        otherCycleCount > 0
                          ? `; ${otherCycleCount} on another cycle or currency cannot be used`
                          : ''
                      }. Set one on the Add-ons screen before buying it.`
                    : `Only prices billing ${billing}, as this subscription does, are listed${
                        otherCycleCount > 0
                          ? ` — ${otherCycleCount} on another cycle or currency left out`
                          : ''
                      }.`
                }
              >
                <option value="">Choose a price…</option>
                {prices.map((price) => (
                  <option key={price.id} value={price.id}>
                    {`${formatCodeWithAmount(price.currency, price.unit_amount)} · ${cycleLabel(price)}${
                      price.plan_id === null ? '' : ' · this plan only'
                    }`}
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
              error={rowError(fieldErrors, 'quantity', 'Quantity')}
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
              maxLength={255}
              value={reason}
              error={rowError(fieldErrors, 'reason', 'Reason')}
              onChange={(event) => setReason(event.target.value)}
              hint="Up to 255 characters. Recorded in the audit trail."
            />

            <SubmitButton busy={busy} busyLabel="Purchasing…" fullWidth={false} disabled={!chosen || !priceId}>
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
            ? `The ${formatUnits(cancelling.units_granted)} it grants towards ${targetLabel(cancelling.effect_type, cancelling.effect_target)} are withdrawn from this subscription’s allowance, and its billing line stops recurring from today. The purchase row is kept, marked cancelled rather than deleted, as the record of what was bought.`
            : 'What it unlocks is withdrawn, and its billing line stops recurring from today. The purchase row is kept, marked cancelled rather than deleted, as the record of what was bought.'
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
            maxLength={255}
            value={cancelReason}
            error={rowError(cancelFieldErrors, 'reason', 'Reason')}
            onChange={(event) => setCancelReason(event.target.value)}
            hint="Up to 255 characters. Recorded in the audit trail."
          />
        </form>
      </Modal>
    </div>
  );
}
