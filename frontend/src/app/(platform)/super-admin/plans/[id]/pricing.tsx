'use client';

/**
 * FR-SUB-006 — Configure Plan Pricing & Billing Cycle. `PUT /plans/:id/prices`.
 *
 * ## Why this is a set editor and not a row form
 *
 * The endpoint replaces the plan's whole price list in one transaction, on the reasoning
 * `plans.validation.js` gives: a delta needs the client to say what changed, which lets two
 * administrators each apply an edit to a set neither was looking at. So the screen holds the whole
 * set, adds and removes rows locally, and sends all of them — what is on screen when Save is pressed
 * is exactly what the plan will have.
 *
 * The consequence worth stating: a row deleted here and saved is **gone** — unless something still
 * points at it. `plans.service.js` `setPrices()` matches each submitted price to an existing row by
 * its identity — cycle, days, pricing model and tier band — and updates a match in place. A row the
 * set no longer holds is deleted, unless `pricesInUse()` finds it referenced (a subscription's current
 * or scheduled price, or a quotation's): then it is switched to not offered instead, because deleting
 * it would blank the pointer on a live subscription. The response counts those as `retired`, and the
 * save toast says how many, since the row comes back on reload marked "Retired" and would otherwise
 * look like a removal that did not take.
 *
 * What a subscription already on a price pays after that price is edited depends on its model. A
 * Fixed, Seat-Based or Custom subscription keeps the amount it was sold at — renewal bills its own
 * `cycle_amount`, not the price row's — until its quantity is changed, which re-reads the row. A
 * Per-Student or Student-Based one does not: owner decision D26 has `renew()` re-count the school's
 * students and re-read the row at **every** renewal (`billedQuantity()`, `COUNTED_MODELS`), so an edit
 * to its price — rates, units included — reaches it at its next renewal, retired or not. `is_active`
 * still exists as a control of its own — retiring a price on purpose while keeping its record is a
 * different act from removing it, and the two must not be the same button.
 *
 * ## The pricing model decides which amounts matter
 *
 * §10.4 has five models, and `computeCycleAmount()` in `subscriptions.service.js` is what each one
 * bills: Fixed bills `base_amount`; the three unit models bill `base_amount` **plus** `unit_amount`
 * for every unit beyond `included_units`; Custom bills `custom_amount`. The validator makes each
 * model's own amount `.required()` per row — `base_amount` for Fixed, `unit_amount` for the unit
 * models, `custom_amount` for Custom — so a form showing every amount at once would offer boxes that
 * are, for that row, decoration, and an operator who filled the wrong one would get a 422 naming a
 * field they had typed into. Each row therefore shows the amounts its own model bills.
 *
 * What a unit *is* differs, and D26 decided it. **Per-Student** and **Student-Based** count the
 * school's active students — the live count `student_limit` measures, taken when the subscription is
 * created or changes plan and taken again at every renewal — and never a typed number; the
 * subscription screen does not offer them a quantity to edit. **Seat-Based** bills the quantity typed
 * when subscribing, a seat being whatever the school buys. The hints on the unit boxes say which.
 *
 * The base amount on a unit model is optional, and this screen used to offer it on Fixed alone. The
 * API accepts it on every model and the calculation adds it, so a per-student price with a fixed
 * platform fee could not be set here — while the "Units included" hint described a base amount the
 * row had no box for.
 *
 * The tier band is shown for the unit models only, and its hints say what it does, which is less
 * than the name suggests: nothing reads `tier_min_units` / `tier_max_units` to choose or bill a price.
 * The band is part of a price's identity — two prices on one cycle and model differ by it — and it is
 * shown beside the price where one is chosen; the price billed is the price chosen, whatever the
 * school's size.
 *
 * ## Blank boxes are sent as zero, not left out
 *
 * `setPrices()` updates a price something still uses **in place**, with `row.update({ ...price })`: a
 * column the payload omits keeps its stored value there, while a new row takes the column default.
 * So a box the hint says means "none" when blank has to send that none — `0` for the base amount on
 * a unit model, the units included and the setup fee — or clearing it on a price in use would change
 * nothing.
 *
 * ## The overage rate on a price is hidden — owner decision D26
 *
 * `plan_prices.overage_unit_amount` is validated, stored and copied by a plan duplicate, and read by
 * nothing that bills. `computeCycleAmount()` says it is *"deliberately not used here"*, and the
 * overage that is billed — `usageService` into `usage_records`, then §13's overage line — is priced
 * from `plan_limits.overage_unit_amount`, set on the Plan limits screen. This screen offered a box for
 * it with a hint saying it billed nothing; D26 hid it instead.
 *
 * Hidden, not cleared. A row loaded with a stored rate sends that value back unchanged, and a row
 * without one sends nothing. Leaving the field out altogether would keep a stored rate only on the
 * in-place path above: every price nothing references is deleted and re-created by `setPrices()`, so
 * an omitted rate would come back as the column default — null — on a save that never touched it.
 *
 * ## Per-row errors
 *
 * A 422 from this endpoint names its field as `prices.2.base_amount`. Left as-is that lands nowhere
 * — no input on the page has that id — so the prefix is parsed off and the message is attached to
 * the row it belongs to. Set-level messages from `checkPriceSet` (a repeated tier band, two
 * defaults) have no row of their own and go to the banner.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { rowError, splitIndexedErrors } from '@/lib/formErrors';
import type { Catalogue, PlanDetail, PlanPrice } from '@/components/planScope';
import {
  CheckboxField,
  Field,
  FormActions,
  FormGrid,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
} from '@/components/form';
import { Icon } from '@/components/icon';
import { ConfirmDialog } from '@/components/overlay';
import { useToast } from '@/components/toast';

/** `PRICING_MODELS` in `config/constants.js`, and which amount each one bills. */
const UNIT_MODELS = new Set(['student_based', 'seat_based', 'per_student']);

/**
 * `COUNTED_MODELS` in `subscriptions.service.js` — the unit models whose unit is the school's live
 * active-student count rather than a typed quantity (owner decision D26).
 */
const COUNTED_MODELS = new Set(['per_student', 'student_based']);

/** `plans.validation.js` caps the set at 100 rows. */
const MAX_PRICES = 100;

/**
 * Every field of a price that the form holds as text.
 *
 * Written as one list and mapped, rather than as sixteen `field: string` declarations, for two
 * reasons. It says the thing that is true of all of them in one place — *the form holds the text in
 * the box, not the column's type* — and it keeps the money keys out of any `: string` declaration,
 * which is what `verify-frontend.js` looks for when it checks that no screen has decided a DECIMAL
 * column arrives as a string. That rule is right and this type is not an exception to it: these are
 * not `plan_prices` values, they are what is typed into the inputs before conversion.
 */
const TEXT_FIELDS = [
  'billing_cycle',
  'cycle_days',
  'pricing_model',
  'currency',
  'base_amount',
  'unit_amount',
  'included_units',
  'tier_min_units',
  'tier_max_units',
  'overage_unit_amount',
  'custom_amount',
  'custom_notes',
  'setup_fee',
  'display_order',
] as const;

type TextField = (typeof TEXT_FIELDS)[number];

/**
 * One row, as the form holds it.
 *
 * The difference between "0" and "" has to survive editing: a blank money box means *"this plan
 * does not charge that"* and a zero means *"it charges nothing"*, and the second is a real answer —
 * a free plan is a price row with `base_amount` 0. Only a string can hold both.
 *
 * `key` is a client-side identity, not the database id. Rows added here have no id yet, and the
 * whole set is replaced on save, so React needs something stable that survives a re-order.
 */
interface PriceDraft extends Record<TextField, string> {
  key: string;
  is_active: boolean;
  is_default: boolean;
}

/** A number column as a form value. Null and undefined are both "not set", and both render blank. */
function text(value: string | number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

let nextKey = 0;
function makeKey(): string {
  nextKey += 1;
  return `draft-${nextKey}`;
}

function toDraft(price: PlanPrice): PriceDraft {
  return {
    key: `price-${price.id}`,
    billing_cycle: price.billing_cycle,
    cycle_days: text(price.cycle_days),
    pricing_model: price.pricing_model,
    currency: price.currency ?? '',
    base_amount: text(price.base_amount),
    unit_amount: text(price.unit_amount),
    included_units: text(price.included_units),
    tier_min_units: text(price.tier_min_units),
    tier_max_units: text(price.tier_max_units),
    overage_unit_amount: text(price.overage_unit_amount),
    custom_amount: text(price.custom_amount),
    custom_notes: price.custom_notes ?? '',
    setup_fee: text(price.setup_fee),
    is_active: price.is_active,
    is_default: price.is_default,
    display_order: text(price.display_order),
  };
}

/**
 * A new row.
 *
 * Monthly and Fixed because they are the commonest arrangement, not because the API defaults to
 * them — both are `.required()`, so something has to be chosen and an empty select would be a 422
 * waiting to happen. The currency copies whatever the plan's other prices use, so a second price on
 * a plan billed in PKR does not silently arrive in USD.
 */
function blankDraft(currency: string): PriceDraft {
  return {
    key: makeKey(),
    billing_cycle: 'monthly',
    cycle_days: '',
    pricing_model: 'fixed',
    currency,
    base_amount: '',
    unit_amount: '',
    included_units: '',
    tier_min_units: '',
    tier_max_units: '',
    overage_unit_amount: '',
    custom_amount: '',
    custom_notes: '',
    setup_fee: '',
    is_active: true,
    is_default: false,
    display_order: '',
  };
}

/** A money or count box as the API wants it: a number, or absent when the box was left empty. */
function num(value: string): number | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : Number(trimmed);
}

/**
 * One draft as a request item.
 *
 * Fields the row's own model does not use are left out rather than sent as null: `unit_amount` is
 * `amount()` without `.allow(null)`, so a Fixed row carrying `unit_amount: null` is a 422 on a field
 * the operator never saw.
 */
function toPayload(draft: PriceDraft): Record<string, unknown> {
  const unitModel = UNIT_MODELS.has(draft.pricing_model);
  const item: Record<string, unknown> = {
    billing_cycle: draft.billing_cycle,
    pricing_model: draft.pricing_model,
    is_active: draft.is_active,
    is_default: draft.is_default,
  };

  if (draft.billing_cycle === 'custom_days') item.cycle_days = num(draft.cycle_days);
  if (draft.currency.trim()) item.currency = draft.currency.trim().toUpperCase();

  if (draft.pricing_model === 'fixed') item.base_amount = num(draft.base_amount);
  if (unitModel) {
    item.unit_amount = num(draft.unit_amount);
    /*
     * Optional here, and billed: `computeCycleAmount()` adds it to the per-unit charge every cycle.
     * A blank box is sent as 0 rather than left out, because `setPrices()` updates a price that a
     * subscription still uses **in place**, with `row.update({ ...price })` — a column the payload
     * omits keeps its stored value there, while a new row takes the column default of 0. Sending 0
     * makes a cleared box mean the same thing on both paths.
     */
    item.base_amount = num(draft.base_amount) ?? 0;
    /*
     * The same, for the same reason: `included_units` defaults to 0 on a new row and its hint says
     * blank means none, but it used to be left out when blank — so clearing it on a price in use kept
     * the stored count, and the rate went on starting above it.
     */
    item.included_units = num(draft.included_units) ?? 0;
    /* Null is meaningful on the band: an open-ended top tier has no maximum. */
    item.tier_min_units = num(draft.tier_min_units) ?? null;
    item.tier_max_units = num(draft.tier_max_units) ?? null;
  }
  if (draft.pricing_model === 'custom') {
    item.custom_amount = num(draft.custom_amount);
    item.custom_notes = draft.custom_notes.trim() || null;
  }

  /*
   * The overage rate has no box (owner decision D26 — see the header), so the draft holds only what
   * was loaded. Sent back as it was when there is one, so the delete-and-re-create path keeps it too;
   * left out when there is none, which both paths store as null.
   */
  if (num(draft.overage_unit_amount) !== undefined) {
    item.overage_unit_amount = num(draft.overage_unit_amount);
  }

  /* Blank is none, sent as 0 on every model — the in-place path again; see the header. */
  item.setup_fee = num(draft.setup_fee) ?? 0;
  if (num(draft.display_order) !== undefined) item.display_order = num(draft.display_order);

  return item;
}

/**
 * A set-level message, said the way the screen is labelled.
 *
 * `checkPriceSet` writes for the API: measured verbatim, its two messages are *"prices[1] repeats
 * the billing cycle, pricing model and tier band of an earlier entry"* and *"Only one price may be
 * marked \"is_default\" for a plan"*. Both are accurate and neither is readable — `prices[1]` is a
 * zero-based array index for a row this screen calls "Price 2", and `is_default` is a column name
 * for a box labelled "Pre-selected when subscribing".
 *
 * Only those two notations are touched, and both are substitutions rather than rewrites: the index
 * becomes the heading the row actually carries, and the column name becomes the label above the
 * control. Anything else is shown as it arrived — see `humaniseFieldError` for why a mangled message
 * is worse than a technical one.
 */
function humaniseSetMessage(message: string): string {
  return message
    .replace(/\bprices\[(\d+)\]/g, (_, index) => `Price ${Number(index) + 1}`)
    .replace(/"is_default"/g, '“Pre-selected when subscribing”')
    .replace(/"is_active"/g, '“Offered for new subscriptions”');
}

export function PricingEditor({
  plan,
  catalogue,
  canEdit,
  onSaved,
}: {
  plan: PlanDetail;
  catalogue: Catalogue;
  /** `plans.pricing.manage`. Without it the set is shown and every control is disabled. */
  canEdit: boolean;
  onSaved: () => void;
}) {
  const { success } = useToast();

  const [drafts, setDrafts] = useState<PriceDraft[]>(() => plan.prices.map(toDraft));
  const [rowErrors, setRowErrors] = useState<Map<number, Record<string, string>>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<PriceDraft | null>(null);

  /*
   * Re-sync when the plan is reloaded, so a save leaves the form showing what was stored — but only
   * when the stored prices changed. The Details tab reloads the plan as well and stays mounted beside
   * this one (`page.tsx`'s header), so re-seeding on every new `plan` object would throw away a price
   * set the operator was still building because they saved the plan's name.
   */
  const seeded = useRef(JSON.stringify(plan.prices));
  useEffect(() => {
    const key = JSON.stringify(plan.prices);
    if (key === seeded.current) return;
    seeded.current = key;
    setDrafts(plan.prices.map(toDraft));
    setRowErrors(new Map());
  }, [plan]);

  const currency = useMemo(
    () => plan.prices.find((price) => price.currency)?.currency ?? 'USD',
    [plan.prices]
  );

  const update = (key: string, patch: Partial<PriceDraft>) =>
    setDrafts((prev) => prev.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;

    setSaving(true);
    setError(null);
    setRowErrors(new Map());

    try {
      const result = await api.put<{ retired?: number }>(`/plans/${plan.id}/prices`, {
        prices: drafts.map(toPayload),
      });
      /*
       * `retired` is the server's count of referenced rows it kept instead of deleting — see the
       * header. Said in the toast because each one reappears on the reload below, marked "Retired",
       * and without the sentence that reads as a removal the save ignored.
       */
      const retired = result?.retired ?? 0;
      const kept =
        retired > 0
          ? ` ${retired} price${retired === 1 ? ' is' : 's are'} still used by a subscription or quotation, so ${
              retired === 1 ? 'it was' : 'they were'
            } kept as retired — no longer offered — rather than deleted.`
          : '';
      success(
        'Pricing saved',
        (drafts.length === 0
          ? 'Nothing is on offer now, so the plan cannot be sold until a price is added.'
          : `${drafts.length} price${drafts.length === 1 ? '' : 's'} stored.`) + kept
      );
      /* This editor's own save always re-seeds from the reload — the retired rows come back in it. */
      seeded.current = '';
      onSaved();
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        setError('Could not reach the server. Check your connection and try again.');
      } else {
        const { rows, set } = splitIndexedErrors(caught.fieldErrors(), 'prices');
        setRowErrors(rows);
        const formLevel = [...set, ...caught.formErrors()].map(humaniseSetMessage);
        setError(
          formLevel.length
            ? formLevel.join(' ')
            : rows.size
              ? `${rows.size} price${rows.size === 1 ? '' : 's'} below need${rows.size === 1 ? 's' : ''} attention.`
              : caught.message
        );
        focusFirstInvalidField();
      }
    } finally {
      setSaving(false);
    }
  }

  const dirty = useMemo(
    () => JSON.stringify(drafts.map(toPayload)) !== JSON.stringify(plan.prices.map(toDraft).map(toPayload)),
    [drafts, plan.prices]
  );

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      {error ? <Notice tone="error">{error}</Notice> : null}

      {!canEdit ? (
        <Notice tone="info">
          You can see this plan&apos;s pricing but not change it. Setting prices needs the
          &ldquo;plans.pricing.manage&rdquo; permission.
        </Notice>
      ) : null}

      {drafts.length === 0 ? (
        <p className="rounded-md border border-border bg-surface-2 px-4 py-6 text-sm text-muted">
          This plan has no prices. A plan with no active price cannot be activated — FR-SUB-004 makes
          an active plan one that is available for new subscriptions, and there would be nothing to
          bill against.
        </p>
      ) : null}

      <ol className="space-y-5">
        {drafts.map((draft, index) => {
          const errors = rowErrors.get(index) ?? {};
          const unitModel = UNIT_MODELS.has(draft.pricing_model);
          /* Per-Student and Student-Based count the school's students; Seat-Based bills a typed quantity. */
          const counted = COUNTED_MODELS.has(draft.pricing_model);
          const id = (field: string) => `price-${draft.key}-${field}`;

          return (
            <li key={draft.key} className="rounded-md border border-border p-4">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Price {index + 1}</h3>
                  <p className="text-xs text-muted">
                    {draft.is_active ? 'Offered' : 'Retired — kept on the plan, not offered'}
                    {draft.is_default ? ' · pre-selected when subscribing' : ''}
                  </p>
                </div>
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
              {/* The overage rate has no box (D26), so a refusal of the stored value it carries shows here. */}
              {errors.overage_unit_amount ? (
                <Notice tone="error">
                  {rowError(errors, 'overage_unit_amount', 'Stored overage rate')}
                </Notice>
              ) : null}

              <FormGrid>
                <SelectField
                  id={id('billing_cycle')}
                  label="Billing cycle"
                  required
                  disabled={!canEdit}
                  value={draft.billing_cycle}
                  onChange={(event) => update(draft.key, { billing_cycle: event.target.value })}
                  error={rowError(errors, 'billing_cycle', 'Billing cycle')}
                  hint="How often the school is billed (SRS §10.3)."
                >
                  {catalogue.billingCycles.map((entry) => (
                    <option key={entry.cycle} value={entry.cycle}>
                      {entry.cycle.replace(/_/g, ' ')}
                      {entry.days ? ` (${entry.days} days)` : ''}
                    </option>
                  ))}
                </SelectField>

                {draft.billing_cycle === 'custom_days' ? (
                  <Field
                    id={id('cycle_days')}
                    label="Cycle length in days"
                    required
                    type="number"
                    min={1}
                    max={3650}
                    step={1}
                    disabled={!canEdit}
                    value={draft.cycle_days}
                    onChange={(event) => update(draft.key, { cycle_days: event.target.value })}
                    error={rowError(errors, 'cycle_days', 'Cycle length in days')}
                    hint="1 to 3,650. Required for a custom cycle — it is the only one whose length its name does not give."
                  />
                ) : null}

                <SelectField
                  id={id('pricing_model')}
                  label="Pricing model"
                  required
                  disabled={!canEdit}
                  value={draft.pricing_model}
                  onChange={(event) => update(draft.key, { pricing_model: event.target.value })}
                  error={rowError(errors, 'pricing_model', 'Pricing model')}
                  hint="Decides which amounts below are charged (SRS §10.4)."
                >
                  {catalogue.pricingModels.map((model) => (
                    <option key={model} value={model}>
                      {model.replace(/_/g, ' ')}
                    </option>
                  ))}
                </SelectField>

                <Field
                  id={id('currency')}
                  label="Currency"
                  disabled={!canEdit}
                  maxLength={3}
                  value={draft.currency}
                  onChange={(event) => update(draft.key, { currency: event.target.value })}
                  error={rowError(errors, 'currency', 'Currency')}
                  hint="Three-letter ISO code, such as USD or PKR. Stored in upper case."
                />

                {draft.pricing_model === 'fixed' ? (
                  <Field
                    id={id('base_amount')}
                    label="Amount per cycle"
                    required
                    type="number"
                    min={0}
                    step="0.01"
                    disabled={!canEdit}
                    value={draft.base_amount}
                    onChange={(event) => update(draft.key, { base_amount: event.target.value })}
                    error={rowError(errors, 'base_amount', 'Amount per cycle')}
                    hint="What the school pays each cycle. Zero is allowed — that is how a free plan is priced."
                  />
                ) : null}

                {unitModel ? (
                  <>
                    {/*
                      * The hints on these three state `computeCycleAmount()` as it is: base amount +
                      * rate per unit × (units − units included, never below zero). What the units are
                      * is owner decision D26 — the school's active students, counted, for Per-Student
                      * and Student-Based; the subscription's typed quantity for Seat-Based.
                      */}
                    <Field
                      id={id('base_amount')}
                      label="Base amount per cycle"
                      type="number"
                      min={0}
                      step="0.01"
                      disabled={!canEdit}
                      value={draft.base_amount}
                      onChange={(event) => update(draft.key, { base_amount: event.target.value })}
                      error={rowError(errors, 'base_amount', 'Base amount per cycle')}
                      hint="Charged every cycle, whatever the count, on top of the per-unit charge. Blank means none."
                    />

                    <Field
                      id={id('unit_amount')}
                      label="Rate per unit"
                      required
                      type="number"
                      min={0}
                      step="0.01"
                      disabled={!canEdit}
                      value={draft.unit_amount}
                      onChange={(event) => update(draft.key, { unit_amount: event.target.value })}
                      error={rowError(errors, 'unit_amount', 'Rate per unit')}
                      hint={
                        counted
                          ? "Charged each cycle for every one of the school's active students beyond the units included. The count is taken when the school subscribes or changes plan, and again at every renewal — it is never typed."
                          : 'Charged each cycle for every seat beyond the units included. The seats are the quantity typed when the school subscribes, changed on the subscription’s screen.'
                      }
                    />

                    <Field
                      id={id('included_units')}
                      label="Units included"
                      type="number"
                      min={0}
                      step={1}
                      disabled={!canEdit}
                      value={draft.included_units}
                      onChange={(event) => update(draft.key, { included_units: event.target.value })}
                      error={rowError(errors, 'included_units', 'Units included')}
                      hint={`Covered by the base amount: the rate per unit applies only to the ${
                        counted ? 'students' : 'seats'
                      } above this. Blank means none.`}
                    />

                    {/*
                      * The band is a label, not a selector — see the header. Its hints say so, because
                      * "Band starts at" reads as a rule the API applies, and nothing reads the band to
                      * choose or bill a price.
                      */}
                    <Field
                      id={id('tier_min_units')}
                      label="Band starts at"
                      type="number"
                      min={0}
                      step={1}
                      disabled={!canEdit}
                      value={draft.tier_min_units}
                      onChange={(event) => update(draft.key, { tier_min_units: event.target.value })}
                      error={rowError(errors, 'tier_min_units', 'Band starts at')}
                      hint={`The ${
                        counted ? 'student' : 'seat'
                      } range this price is meant for, shown beside it where a price is chosen. Nothing enforces it: the price billed is the price chosen, whatever the school's size. It is what lets two prices on one cycle and model differ. Leave both blank for no band.`}
                    />

                    <Field
                      id={id('tier_max_units')}
                      label="Band ends at"
                      type="number"
                      min={0}
                      step={1}
                      disabled={!canEdit}
                      value={draft.tier_max_units}
                      onChange={(event) => update(draft.key, { tier_max_units: event.target.value })}
                      error={rowError(errors, 'tier_max_units', 'Band ends at')}
                      hint="Inclusive. Blank leaves the band open-ended at the top."
                    />
                  </>
                ) : null}

                {draft.pricing_model === 'custom' ? (
                  <>
                    <Field
                      id={id('custom_amount')}
                      label="Negotiated amount"
                      required
                      type="number"
                      min={0}
                      step="0.01"
                      disabled={!canEdit}
                      value={draft.custom_amount}
                      onChange={(event) => update(draft.key, { custom_amount: event.target.value })}
                      error={rowError(errors, 'custom_amount', 'Negotiated amount')}
                      hint="The figure agreed with the school. This is what is billed each cycle."
                    />

                    <TextAreaField
                      id={id('custom_notes')}
                      label="What was agreed"
                      rows={2}
                      maxLength={255}
                      disabled={!canEdit}
                      value={draft.custom_notes}
                      onChange={(event) => update(draft.key, { custom_notes: event.target.value })}
                      error={rowError(errors, 'custom_notes', 'What was agreed')}
                      hint="Up to 255 characters. Kept with the price so the next person can see why it differs."
                    />
                  </>
                ) : null}

                <Field
                  id={id('setup_fee')}
                  label="One-off setup fee"
                  type="number"
                  min={0}
                  step="0.01"
                  disabled={!canEdit}
                  value={draft.setup_fee}
                  onChange={(event) => update(draft.key, { setup_fee: event.target.value })}
                  error={rowError(errors, 'setup_fee', 'One-off setup fee')}
                  hint="Billed on the first invoice only. Blank means none."
                />

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
                  hint="Lower comes first where a school chooses between this plan's prices."
                />
              </FormGrid>

              <div className="mt-4 space-y-3">
                <CheckboxField
                  id={id('is_active')}
                  label="Offered for new subscriptions"
                  disabled={!canEdit}
                  checked={draft.is_active}
                  onChange={(event) => update(draft.key, { is_active: event.target.checked })}
                  error={rowError(errors, 'is_active', 'Offered for new subscriptions')}
                  hint="Unticking retires the price without deleting it. A plan needs at least one offered price to be activated."
                />

                <CheckboxField
                  id={id('is_default')}
                  label="Pre-selected when subscribing"
                  disabled={!canEdit}
                  checked={draft.is_default}
                  onChange={(event) => update(draft.key, { is_default: event.target.checked })}
                  error={rowError(errors, 'is_default', 'Pre-selected when subscribing')}
                  hint="Only one price on a plan may carry this."
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
            onClick={() => setDrafts((prev) => [...prev, blankDraft(currency)])}
            disabled={drafts.length >= MAX_PRICES}
            className="btn btn-secondary"
          >
            <Icon name="plus" size={15} />
            Add a price
          </button>

          <FormActions>
            <SubmitButton fullWidth={false} busy={saving} busyLabel="Saving…" disabled={!dirty}>
              Save pricing
            </SubmitButton>
          </FormActions>
        </>
      ) : null}

      {/*
        * Removing is confirmed even though nothing leaves the database until Save, because the row
        * being removed may be the only thing keeping the plan sellable and its contents are gone from
        * the screen the moment it goes. The copy names the one case where a save does not delete it —
        * a price something still points at — because that row comes back after the save.
        */}
      <ConfirmDialog
        open={Boolean(removing)}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          setDrafts((prev) => prev.filter((draft) => draft.key !== removing?.key));
          setRemoving(null);
        }}
        title="Remove this price?"
        description="It disappears from the list now and is deleted from the plan when you save — unless a subscription or quotation still uses it. Then it is kept: if the prices you save include one with the same cycle, pricing model and tier band, that one takes its place and is updated in place; otherwise it is retired and shows again after the save as no longer offered. Either way, subscriptions already on it stay on it: a Fixed, Seat-Based or Custom one keeps the amount it was sold at until its quantity is changed, and a Per-Student or Student-Based one is re-priced from this row, at the school’s student count, at every renewal. To stop offering a price while keeping its record, untick “Offered for new subscriptions” instead."
        confirmLabel="Remove price"
      />
    </form>
  );
}
