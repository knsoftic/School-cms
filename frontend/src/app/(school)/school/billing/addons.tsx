'use client';

/**
 * Add-ons — SRS §11.3 and FR-SUB-009, whose Description reads *"Super Admin and/or school configure
 * add-ons"*; the owner's decision D10 confirmed the school buys them too.
 *
 * What is bought is read off the subscription (`addons` in `detailInclude()`); what can be bought is
 * `GET /addons` on `addons.view` — D27 granted it to Principal and School Admin — which a school
 * receives confined to the active add-ons and the active prices its own plan may buy. The purchase is
 * `POST /subscriptions/:id/addons` on `subscriptions.self.manage`.
 *
 * ## A price is required, and only one on the subscription's cycle and currency is offered
 *
 * The owner's decision D21: a purchase must name its price (`addon_price_id` is required), because one
 * that named none used to be billed at 0.00. And `purchaseAddon()` refuses a price on another cycle or
 * currency (`ADDON_PRICE_CYCLE_MISMATCH`) — the add-on's line is billed once per subscription period on
 * an invoice in the subscription's currency, and nothing reads the price's own cycle. So the select
 * lists the prices the API will take and says how many it left out.
 *
 * ## Bought mid-period, it is invoiced at once
 *
 * The owner's decision D24: when the current period has already been invoiced, the purchase is charged
 * straight away — a recurring add-on prorated for the rest of the period, as an upgrade is — on an
 * invoice of its own, returned as `invoice`. When the period has not been invoiced yet (a trial, a
 * pending subscription), there is nothing to add to: the period's own invoice carries the line when it
 * is issued. The confirmation says which happened, and names the invoice when there is one.
 *
 * ## Cancelling a purchase
 *
 * `POST /subscriptions/:id/addons/:addonId/cancel` on `subscriptions.self.manage`, where `:addonId` is
 * the purchase — the `subscription_addons` row — not the add-on: a school may hold two purchases of one
 * add-on, and cancelling one must not cancel both. `cancelAddon()` takes only an **active** purchase
 * (`SUBSCRIPTION_ADDON_NOT_ACTIVE` otherwise) and does not look at the subscription's state, so Cancel
 * is on every active row, in use or not. What it does, as the confirmation says: the grant stops at
 * once — the units a limit increase added are withdrawn, a feature it unlocked is locked again — and
 * the purchase's billing line stops recurring, so later invoices leave it out. Nothing already
 * invoiced is refunded or credited, and the row is kept, marked cancelled, as the record of what was
 * bought. A refusal is shown inside the dialog in the API's own words.
 *
 * ## What is not offered
 *
 * No edit and no quantity change: a purchase is a purchase, copied at the time it was made — the units,
 * the effect and the price — so a later catalogue edit cannot change what the school has. Changing a
 * quantity is cancelling one purchase and buying another.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

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
import { ConfirmDialog, Modal } from '@/components/overlay';
import { DataTable, EmptyNotice, ErrorNotice, LoadingBlock, RefusalNotice, StatusBadge } from '@/components/table';
import type { Column } from '@/components/table';
import { useToast } from '@/components/toast';

import { cycleLabel, formatCount, humanise, sameCycle, utcDay } from './billing';
import type { OwnSubscription, OwnSubscriptionScope, SubscriptionAddonRow, SubscriptionVocabulary } from './billing';

/** The purchase form's inputs, by the body field each sends. A 422 on anything else is a banner. */
const PURCHASE_FIELDS = new Set(['addon_id', 'addon_price_id', 'quantity', 'reason']);

/** The cancel dialog's one input. */
const CANCEL_FIELDS = new Set(['reason']);

/** `POST /subscriptions/:id/addons/:addonId/cancel` — `subscriptions.controller.cancelAddon()`. */
interface CancelResponse {
  subscription: OwnSubscription;
  purchase: { id: number; status: string; unitsWithdrawn: number | null };
}

/** One `addon_prices` row, as `/addons` includes them for a school. */
interface AddonPrice {
  id: number;
  billing_cycle: string;
  cycle_days: number | null;
  currency: string;
  unit_amount: number | string | null;
  plan_id: number | null;
  is_active: boolean;
}

/** One row of `GET /addons`, narrowed to what a purchase needs. */
interface AddonOption {
  id: number;
  name: string;
  description: string | null;
  effect_type: string;
  effect_target: string;
  units_per_quantity: number | string;
  unit: string | null;
  prices: AddonPrice[];
}

/** `POST /subscriptions/:id/addons` — `subscriptions.controller.purchaseAddon()`. */
interface PurchaseResponse {
  subscription: OwnSubscription;
  purchase: {
    id: number;
    addon: { id: number; key: string; name: string };
    quantity: number;
    effectType: string;
    effectTarget: string;
    unitsGranted: number;
    unitAmount: number;
    currency: string;
  };
  /** D24's charge at purchase when the period was already invoiced, else null. */
  invoice: { id: number; invoice_number: string; total: number | string } | null;
}

/** What a limit-increase adds to, by the catalogue's label — "Student Limit", not `student_limit`. */
function targetLabel(vocabulary: SubscriptionVocabulary | null, effectType: string, target: string): string {
  if (effectType !== 'limit_increase') return target;
  return vocabulary?.limitTargets.find((limit) => limit.key === target)?.label ?? target;
}

/* ─────────────────────────────── the purchase form ─────────────────────────────── */

function PurchaseForm({
  subscription,
  vocabulary,
  canSeeInvoices,
  onChanged,
}: {
  subscription: OwnSubscription;
  vocabulary: SubscriptionVocabulary | null;
  canSeeInvoices: boolean;
  onChanged: (subscription: OwnSubscription) => void;
}) {
  const { success } = useToast();
  const catalogue = useCollection<AddonOption>('/addons', { limit: 100 });

  const [addonId, setAddonId] = useState('');
  const [priceId, setPriceId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<PurchaseResponse | null>(null);

  const chosen = catalogue.rows.find((row) => String(row.id) === addonId) ?? null;
  const active = (chosen?.prices ?? []).filter((price) => price.is_active);
  const prices = active.filter((price) => price.currency === subscription.currency && sameCycle(price, subscription));
  const leftOut = active.length - prices.length;
  const chosenPrice = prices.find((price) => String(price.id) === priceId) ?? null;
  const billing = `${cycleLabel(subscription).toLowerCase()} in ${subscription.currency}`;

  function choose(value: string) {
    setAddonId(value);
    const addon = catalogue.rows.find((row) => String(row.id) === value) ?? null;
    const usable = (addon?.prices ?? []).filter(
      (price) => price.is_active && price.currency === subscription.currency && sameCycle(price, subscription)
    );
    /* One price the API will take is the only sensible choice, so it is made; several are left to the reader. */
    setPriceId(usable.length === 1 ? String(usable[0].id) : '');
  }

  function requestPurchase() {
    if (!chosen || !chosenPrice || busy) return;
    setError(null);
    setFieldErrors({});
    setConfirming(true);
  }

  async function purchase() {
    if (!chosen || !chosenPrice || busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      /* Sent as typed: `Number('')` is 0, and the server's "must be at least 1" names the real problem. */
      const body: Record<string, unknown> = { addon_id: chosen.id, addon_price_id: chosenPrice.id };
      if (quantity.trim()) body.quantity = quantity.trim();
      if (reason.trim()) body.reason = reason.trim();

      const result = await api.post<PurchaseResponse>(`/subscriptions/${subscription.id}/addons`, body);
      onChanged(result.subscription);
      setOutcome(result);
      success(
        `${result.purchase.addon.name} bought`,
        result.purchase.unitsGranted > 0
          ? `${formatCount(result.purchase.unitsGranted)} added to ${targetLabel(vocabulary, result.purchase.effectType, result.purchase.effectTarget)}.`
          : `${result.purchase.effectTarget} unlocked.`
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

  return (
    <FormSection
      title="Buy an add-on"
      description={`Billed ${billing}, as your subscription is. What is bought is copied onto the purchase, so a later change to the add-on catalogue does not change what your school has.`}
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          requestPurchase();
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}

        {outcome ? (
          <Notice tone="success">
            <strong>{outcome.purchase.addon.name}</strong> × {formatCount(outcome.purchase.quantity)} bought at{' '}
            {formatCodeWithAmount(outcome.purchase.currency, outcome.purchase.unitAmount)} each.{' '}
            {outcome.invoice ? (
              <>
                This billing period had already been invoiced, so the charge for the rest of it was invoiced now
                as{' '}
                {canSeeInvoices ? (
                  <Link
                    href={`/school/billing/invoices/${outcome.invoice.id}`}
                    className="font-medium underline underline-offset-2"
                  >
                    {outcome.invoice.invoice_number}
                  </Link>
                ) : (
                  <strong>{outcome.invoice.invoice_number}</strong>
                )}{' '}
                — {formatCodeWithAmount(outcome.purchase.currency, outcome.invoice.total)}. Later invoices carry its
                full line.
              </>
            ) : (
              'Nothing was invoiced now: it is billed on your subscription’s invoices, starting with the next one issued.'
            )}
          </Notice>
        ) : null}

        {catalogue.refusal ? (
          <RefusalNotice refusal={catalogue.refusal} />
        ) : catalogue.error ? (
          <Notice tone="error">The add-ons could not be loaded: {catalogue.error}</Notice>
        ) : catalogue.loading && catalogue.rows.length === 0 ? (
          <LoadingBlock rows={3} label="Loading the add-ons…" />
        ) : catalogue.rows.length === 0 ? (
          <EmptyNotice icon="layers">No add-on is on sale at the moment.</EmptyNotice>
        ) : (
          <>
            <SelectField
              id="addon-choice"
              label="Add-on"
              required
              value={addonId}
              error={rowError(fieldErrors, 'addon_id', 'Add-on')}
              onChange={(event) => choose(event.target.value)}
              hint="The add-ons on sale for your plan."
            >
              <option value="">Choose an add-on…</option>
              {catalogue.rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                  {row.effect_type === 'limit_increase'
                    ? ` — ${formatCount(row.units_per_quantity)} ${row.unit ?? ''} per unit`.trimEnd()
                    : ` — unlocks ${row.effect_target}`}
                </option>
              ))}
            </SelectField>

            {chosen?.description ? <p className="text-sm text-muted">{chosen.description}</p> : null}

            {chosen ? (
              prices.length === 0 ? (
                <Notice tone="warn">
                  {chosen.name} has no price your subscription can be charged on — one billing {billing}
                  {leftOut > 0 ? `; its ${leftOut} other price(s) bill on another cycle or currency` : ''}. It cannot be
                  bought until the platform prices it for your cycle.
                </Notice>
              ) : (
                <SelectField
                  id="addon-price"
                  label="Price"
                  required
                  value={priceId}
                  error={rowError(fieldErrors, 'addon_price_id', 'Price')}
                  onChange={(event) => setPriceId(event.target.value)}
                  hint={`Per unit, per billing period. Only prices billing ${billing} are listed${
                    leftOut > 0 ? ` — ${leftOut} on another cycle or currency left out` : ''
                  }.`}
                >
                  <option value="">Choose a price…</option>
                  {prices.map((price) => (
                    <option key={price.id} value={price.id}>
                      {`${formatCodeWithAmount(price.currency, price.unit_amount)} · ${cycleLabel(price)}${
                        price.plan_id === null ? '' : ' · for your plan'
                      }`}
                    </option>
                  ))}
                </SelectField>
              )
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
                  ? `Each unit adds ${formatCount(chosen.units_per_quantity)}${chosen.unit ? ` ${chosen.unit}` : ''} to ${targetLabel(vocabulary, chosen.effect_type, chosen.effect_target)}.`
                  : 'How many of this add-on to buy.'
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
              hint="Optional, up to 255 characters. Kept with the subscription’s history."
            />

            <SubmitButton busy={busy} busyLabel="Buying…" fullWidth={false} disabled={!chosen || !chosenPrice}>
              Buy add-on
            </SubmitButton>
          </>
        )}
      </form>

      <ConfirmDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          setConfirming(false);
          await purchase();
        }}
        title={chosen ? `Buy ${chosen.name}?` : 'Buy this add-on?'}
        description={
          chosen && chosenPrice
            ? `${quantity.trim() || '1'} × ${formatCodeWithAmount(chosenPrice.currency, chosenPrice.unit_amount)}, billed ${billing}. If this billing period has already been invoiced, the rest of it is charged now on an invoice of its own; otherwise it is billed from the next invoice.`
            : ''
        }
        confirmLabel="Buy add-on"
        tone="default"
      />
    </FormSection>
  );
}

/* ─────────────────────────────── cancelling a purchase ─────────────────────────────── */

/** One purchase's cancellation, confirmed — see the header. */
function CancelAddonDialog({
  subscription,
  purchase,
  vocabulary,
  onClose,
  onCancelled,
}: {
  subscription: OwnSubscription;
  /** The purchase being cancelled, or null when the dialog is closed. */
  purchase: SubscriptionAddonRow | null;
  vocabulary: SubscriptionVocabulary | null;
  onClose: () => void;
  onCancelled: (subscription: OwnSubscription) => void;
}) {
  const { success } = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /* A fresh form for every purchase opened, so one row's refusal is never shown over another's. */
  const purchaseId = purchase ? purchase.id : null;
  useEffect(() => {
    if (purchaseId === null) return;
    setReason('');
    setError(null);
    setFieldErrors({});
  }, [purchaseId]);

  const name = purchase ? (purchase.addon ? purchase.addon.name : `Add-on #${purchase.addon_id}`) : 'this add-on';

  async function cancel() {
    if (!purchase || busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      /* The purchase's own id — `subscription_addons.id` — never `addon_id`. See the header. */
      const result = await api.post<CancelResponse>(
        `/subscriptions/${subscription.id}/addons/${purchase.id}/cancel`,
        reason.trim() ? { reason: reason.trim() } : {}
      );
      success(
        `${name} cancelled`,
        result.purchase.unitsWithdrawn
          ? `${formatCount(result.purchase.unitsWithdrawn)} withdrawn from ${targetLabel(vocabulary, purchase.effect_type, purchase.effect_target)}.`
          : undefined
      );
      onCancelled(result.subscription);
    } catch (caught) {
      if (caught instanceof ApiError) {
        /* `SUBSCRIPTION_ADDON_NOT_ACTIVE` and the rest, in the API's own words. */
        const { perField, banner } = splitApiErrors(caught, CANCEL_FIELDS);
        setFieldErrors(perField);
        setError(banner);
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={purchase !== null}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={`Cancel ${name}?`}
      description={
        purchase && purchase.effect_type === 'limit_increase'
          ? `The ${formatCount(purchase.units_granted)} it adds to ${targetLabel(vocabulary, purchase.effect_type, purchase.effect_target)} are withdrawn at once, and it is left off your subscription’s later invoices. Nothing already invoiced is refunded or credited.`
          : 'What it unlocks is locked again at once, and it is left off your subscription’s later invoices. Nothing already invoiced is refunded or credited.'
      }
      size="sm"
      busy={busy}
      footer={
        <>
          {/* "Go back", not "Cancel", beside "Cancel add-on" — the platform's add-on dialog says why. */}
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Go back
          </button>
          <SubmitButton form="cancel-school-addon" busy={busy} busyLabel="Cancelling…" fullWidth={false}>
            Cancel add-on
          </SubmitButton>
        </>
      }
    >
      <form
        id="cancel-school-addon"
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void cancel();
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        <p className="text-sm text-muted">
          The purchase is kept, marked cancelled, as the record of what your school bought.
        </p>
        <TextAreaField
          id="cancel-school-addon-reason"
          label="Reason"
          rows={2}
          maxLength={255}
          value={reason}
          error={rowError(fieldErrors, 'reason', 'Reason')}
          onChange={(event) => setReason(event.target.value)}
          hint="Optional, up to 255 characters. Kept with the subscription’s history."
        />
      </form>
    </Modal>
  );
}

/* ─────────────────────────────── the panel ─────────────────────────────── */

export function AddonsPanel({
  scope,
  canBuy,
  canReadCatalogue,
  canSeeInvoices,
}: {
  scope: OwnSubscriptionScope;
  /** `subscriptions.self.manage` — `canBuyAddons()` in the router. */
  canBuy: boolean;
  /** `addons.view` — what can be bought. */
  canReadCatalogue: boolean;
  canSeeInvoices: boolean;
}) {
  const { subscription, vocabulary, loading, error, refusal, reload, adopt } = scope;
  /* The purchase whose cancellation is being confirmed — see the header. */
  const [cancelling, setCancelling] = useState<SubscriptionAddonRow | null>(null);

  const label = useCallback(
    (effectType: string, target: string) => targetLabel(vocabulary, effectType, target),
    [vocabulary]
  );

  const columns = useMemo<Column<SubscriptionAddonRow>[]>(
    () => [
      {
        key: 'addon',
        header: 'Add-on',
        primary: true,
        cell: (row) => <span className="font-medium">{row.addon ? row.addon.name : `Add-on #${row.addon_id}`}</span>,
      },
      {
        key: 'grants',
        header: 'Adds',
        cell: (row) =>
          row.effect_type === 'limit_increase'
            ? `${formatCount(row.units_granted)} to ${label(row.effect_type, row.effect_target)}`
            : `Unlocks ${row.effect_target}`,
      },
      { key: 'quantity', header: 'Quantity', numeric: true, cell: (row) => formatCount(row.quantity) },
      {
        key: 'price',
        header: 'Unit price',
        numeric: true,
        cell: (row) => formatCodeWithAmount(row.currency, row.unit_amount),
      },
      {
        key: 'window',
        header: 'From',
        hideOnMobile: true,
        cell: (row) => (
          <span className="whitespace-nowrap text-xs text-muted">
            {utcDay(row.starts_at) ?? 'purchase'}
            {row.ends_at ? ` – ${utcDay(row.ends_at)}` : row.is_recurring ? ', every period' : ''}
          </span>
        ),
      },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
      /* `cancelAddon()` takes an active purchase and nothing else, whatever the subscription's state. */
      ...(canBuy
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: SubscriptionAddonRow) =>
                row.status === 'active' ? (
                  <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => setCancelling(row)}>
                    Cancel…
                  </button>
                ) : (
                  <span className="text-muted-soft">—</span>
                ),
            } as Column<SubscriptionAddonRow>,
          ]
        : []),
    ],
    [label, canBuy]
  );

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (error) return <ErrorNotice message={error} onRetry={reload} />;
  if (loading && !subscription) return <LoadingBlock rows={3} />;
  if (!subscription) {
    return (
      <EmptyNotice title="No subscription yet">
        Add-ons are bought onto a subscription, and your school does not have one yet.
      </EmptyNotice>
    );
  }

  return (
    <div className="space-y-8">
      {subscription.addons.length === 0 ? (
        <EmptyNotice icon="layers">
          Nothing has been added to your subscription. What your school can do comes from its plan alone.
        </EmptyNotice>
      ) : (
        <DataTable
          columns={columns}
          rows={subscription.addons}
          rowKey={(row) => row.id}
          caption="Add-ons on your subscription"
          busy={loading}
        />
      )}

      {!canBuy ? null : !canReadCatalogue ? (
        <Notice tone="info">
          Buying an add-on needs the permission to view add-ons, which this account does not hold.
        </Notice>
      ) : !subscription.standing.isUsable ? (
        /* `purchaseAddon()` refuses a subscription outside the usable states (`SUBSCRIPTION_NOT_PURCHASABLE`). */
        <Notice tone="info">
          Add-ons can be bought only onto a subscription in use, and yours is{' '}
          {humanise(subscription.state).toLowerCase()}.
          {subscription.standing.activeAddonCount > 0
            ? ' Purchases already on it can still be cancelled from the table above.'
            : ''}
        </Notice>
      ) : (
        <PurchaseForm
          subscription={subscription}
          vocabulary={vocabulary}
          canSeeInvoices={canSeeInvoices}
          onChanged={adopt}
        />
      )}

      {canBuy ? (
        <CancelAddonDialog
          subscription={subscription}
          purchase={cancelling}
          vocabulary={vocabulary}
          onClose={() => setCancelling(null)}
          onCancelled={(next) => {
            /* The response is the subscription after the cancellation, so it replaces the one on screen. */
            adopt(next);
            setCancelling(null);
          }}
        />
      ) : null}
    </div>
  );
}
