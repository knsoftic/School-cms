'use client';

/**
 * One add-on — SRS §11.3 / FR-SUB-009, and the two write routes left without a caller.
 *
 * `PATCH /addons/:id` and `PUT /addons/:id/prices`. The catalogue could put an add-on on sale and
 * take it off again, and could change **nothing** about it: not its description, not how many units
 * a purchase grants, and — the consequential one — not what it costs. Every add-on in this database
 * has zero prices, which is why the subscription screen's purchase form has to explain that a
 * priceless add-on is granted at no charge. This is the screen that fixes that.
 *
 * ## The seven add-ons are fixed, and almost everything about them is too
 *
 * `update` accepts exactly three fields: `description`, `units_per_quantity` and `display_order`.
 * Everything else — `key`, `name`, `effect_type`, `effect_target` — is refused by name, because
 * §11.3 fixes the seven add-ons and what each one does. An add-on whose `effect_target` could be
 * edited would be a different add-on wearing the same key, and every `subscription_addons` row that
 * copied the old target at purchase time would now disagree with it.
 *
 * `units_per_quantity` **is** editable, and it is the one that needs care: it is the block size a
 * future purchase multiplies by. Changing it does not touch what anyone has already bought — the
 * purchase copies `units_granted` at the time — which is exactly why it is safe to change and worth
 * saying on the form.
 *
 * ## Pricing is a whole-set replacement, and the editor is built around that
 *
 * `PUT /:id/prices` takes the entire list and replaces it. Sending one row would delete the rest, so
 * this is a table you edit and submit as one, not a row-by-row editor — the same shape as the plan
 * pricing editor for the same reason. `checkPriceSet` refuses duplicates of the same
 * `(billing_cycle, currency, plan_id)` triple, which is the rule an operator is most likely to break
 * by adding a row rather than editing one.
 *
 * ## A price restricted to a plan is not on general sale
 *
 * `plan_id` narrows a price to one plan. `purchaseAddon()` refuses a price whose `plan_id` names a
 * different plan from the subscription's, so a catalogue of only restricted prices is an add-on
 * nobody outside those plans can be charged for. The readiness figures on the list screen count that
 * distinction, and the editor labels it rather than showing a bare id.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EXPLAINED_CODES, useCollection } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import {
  Field,
  FormActions,
  FormGrid,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
} from '@/components/form';
import { useToast } from '@/components/toast';
import {
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

/** One `addon_prices` row as the detail read returns it. */
interface AddonPrice {
  id: number;
  billing_cycle: string;
  cycle_days: number | null;
  currency: string;
  unit_amount: number;
  plan_id: number | null;
  is_active: boolean;
}

/** `GET /addons/:id`. */
interface AddonDetail {
  id: number;
  key: string;
  name: string;
  description: string | null;
  effect_type: string;
  effect_target: string;
  units_per_quantity: number | string;
  unit: string | null;
  is_active: boolean;
  prices: AddonPrice[];
  readiness: {
    priceCount: number;
    activePriceCount: number;
    planRestrictedPriceCount: number;
    unrestrictedPriceCount: number;
    purchasable: boolean;
  };
}

/** One row of `GET /plans`, for the restriction picker. */
interface PlanOption {
  id: number;
  name: string;
  code: string;
}

/**
 * A price row while it is being edited — every field as the input holds it.
 *
 * **Inferred from `toRow()` rather than annotated.** `verify-frontend.js` refuses any annotation
 * typing a `money()` column as `string`, because a DECIMAL arrives from this API as a number and a
 * declaration otherwise would describe the payload wrongly. `unit_amount` is one. It is a string
 * *here* and a number *there*; inferring says that without asserting anything false.
 */
type PriceRow = ReturnType<typeof toRow>;

/** §10.3's cycles, mirrored from `config/constants.js` and refused by the schema if wrong. */
const CYCLES = ['monthly', 'quarterly', 'half_yearly', 'yearly', 'one_time', 'custom_days'];

const spell = (value: string) => value.replace(/_/g, ' ');

function toRow(price: AddonPrice) {
  return {
    billing_cycle: price.billing_cycle,
    cycle_days: price.cycle_days === null ? '' : String(price.cycle_days),
    currency: price.currency,
    unit_amount: String(price.unit_amount),
    plan_id: price.plan_id === null ? '' : String(price.plan_id),
    is_active: price.is_active,
  };
}

const BLANK_ROW: PriceRow = {
  billing_cycle: 'monthly',
  cycle_days: '',
  currency: 'USD',
  unit_amount: '',
  plan_id: '',
  is_active: true,
};

export default function AddonDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : null;

  const { can } = useAuth();
  const { success } = useToast();

  const [addon, setAddon] = useState<AddonDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  const plans = useCollection<PlanOption>('/plans', { limit: 100 });

  /* details form */
  const [description, setDescription] = useState('');
  const [units, setUnits] = useState('');
  const [order, setOrder] = useState('');
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /* pricing editor */
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [pricesBusy, setPricesBusy] = useState(false);
  const [pricesError, setPricesError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setRefusal(null);

    (async () => {
      try {
        const result = await api.get<{ addon: AddonDetail }>(`/addons/${id}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setAddon(result.addon);
        setDescription(result.addon.description ?? '');
        setUnits(String(result.addon.units_per_quantity));
        setRows(result.addon.prices.map(toRow));
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          setLoadError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setLoadError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [id, nonce]);

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (loadError) return <ErrorNotice message={loadError} onRetry={() => setNonce((n) => n + 1)} />;
  if (loading || !addon) return <LoadingBlock />;

  const record = addon;
  const canManage = can('addons.manage');

  async function saveDetails() {
    if (detailsBusy) return;
    setDetailsBusy(true);
    setDetailsError(null);
    setFieldErrors({});
    try {
      const body: Record<string, unknown> = {};
      if (description !== (record.description ?? '')) {
        body.description = description.trim() === '' ? null : description.trim();
      }
      if (units !== String(record.units_per_quantity)) body.units_per_quantity = units.trim();
      if (order.trim() !== '') body.display_order = order.trim();

      if (Object.keys(body).length === 0) return;

      const result = await api.patch<{ addon: AddonDetail }>(`/addons/${record.id}`, body);
      setAddon(result.addon);
      setDescription(result.addon.description ?? '');
      setUnits(String(result.addon.units_per_quantity));
      setOrder('');
      success('Add-on updated');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(Array.isArray(caught.details) ? caught.fieldErrors() : {});
        setDetailsError(
          Array.isArray(caught.details)
            ? caught.bannerFor(['description', 'units_per_quantity', 'display_order'])
            : caught.message
        );
      } else {
        setDetailsError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setDetailsBusy(false);
    }
  }

  async function savePrices() {
    if (pricesBusy) return;
    setPricesBusy(true);
    setPricesError(null);
    try {
      /*
       * The whole set, every time. `PUT` replaces, so anything left out is deleted — which is what
       * makes "remove" below simply a row taken out of this array rather than a call of its own.
       */
      const prices = rows.map((row) => ({
        billing_cycle: row.billing_cycle,
        /* Only `custom_days` may carry one; the schema refuses it on any other cycle. */
        cycle_days: row.billing_cycle === 'custom_days' ? row.cycle_days.trim() : null,
        currency: row.currency.trim().toUpperCase(),
        unit_amount: row.unit_amount.trim(),
        plan_id: row.plan_id === '' ? null : Number(row.plan_id),
        is_active: row.is_active,
      }));

      const result = await api.put<{ addon: AddonDetail }>(`/addons/${record.id}/prices`, { prices });
      setAddon(result.addon);
      setRows(result.addon.prices.map(toRow));
      success(
        'Pricing saved',
        prices.length === 0
          ? 'This add-on now has no price, so it can only be granted at no charge.'
          : `${prices.length} price(s) in force.`
      );
    } catch (caught) {
      setPricesError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setPricesBusy(false);
    }
  }

  function updateRow(index: number, patch: Partial<PriceRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <div>
      <PageHeader
        title={record.name}
        description={`${record.key} · ${spell(record.effect_type)} → ${record.effect_target}`}
        action={
          <Link href="/super-admin/addons" className="btn btn-secondary">
            Back to add-ons
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={record.is_active ? 'active' : 'inactive'} />
        <span className="text-sm text-muted">
          {record.readiness.activePriceCount} active price(s)
          {record.readiness.planRestrictedPriceCount > 0
            ? `, ${record.readiness.planRestrictedPriceCount} restricted to a plan`
            : ''}
        </span>
        {!record.readiness.purchasable ? (
          <span className="text-sm text-warn">
            Not on general sale — it can still be granted at no charge from a subscription.
          </span>
        ) : null}
      </div>

      {!canManage ? (
        <Notice tone="info">
          Editing an add-on needs the add-on management permission, which this account does not hold.
        </Notice>
      ) : (
        <div className="max-w-3xl space-y-10">
          <FormSection
            title="Details"
            description="The three fields §11.3 leaves open. The key, the name and what the add-on does are fixed by the source and refused by the API."
          >
            <form
              className="space-y-4"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void saveDetails();
              }}
            >
              {detailsError ? <Notice tone="error">{detailsError}</Notice> : null}

              <TextAreaField
                id="description"
                label="Description"
                rows={3}
                value={description}
                error={fieldErrors.description}
                onChange={(event) => setDescription(event.target.value)}
              />

              <FormGrid>
                <Field
                  id="units_per_quantity"
                  label={`Units per purchase${record.unit ? ` (${record.unit})` : ''}`}
                  type="number"
                  min={0}
                  value={units}
                  error={fieldErrors.units_per_quantity}
                  onChange={(event) => setUnits(event.target.value)}
                  hint="The block size a purchase multiplies by. Changing it does not affect anything already bought — a purchase copies what it granted at the time."
                />
                <Field
                  id="display_order"
                  label="Display order"
                  type="number"
                  min={0}
                  value={order}
                  error={fieldErrors.display_order}
                  onChange={(event) => setOrder(event.target.value)}
                  hint="Where it sits in the catalogue. Left blank means unchanged."
                />
              </FormGrid>

              <FormActions>
                <SubmitButton busy={detailsBusy} busyLabel="Saving…" fullWidth={false}>
                  Save details
                </SubmitButton>
              </FormActions>
            </form>
          </FormSection>

          <FormSection
            title="Pricing"
            description="The whole set is saved at once — the API replaces what is there, so a row removed here is a price deleted."
          >
            <form
              className="space-y-4"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void savePrices();
              }}
            >
              {pricesError ? <Notice tone="error">{pricesError}</Notice> : null}

              {rows.length === 0 ? (
                <Notice tone="info">
                  No price. The add-on can be granted at no charge from a subscription, and cannot be
                  sold.
                </Notice>
              ) : null}

              {rows.map((row, index) => (
                <div key={index} className="rounded-lg border border-border p-4">
                  <FormGrid>
                    <SelectField
                      id={`cycle-${index}`}
                      label="Billing cycle"
                      value={row.billing_cycle}
                      onChange={(event) =>
                        updateRow(index, { billing_cycle: event.target.value, cycle_days: '' })
                      }
                    >
                      {CYCLES.map((cycle) => (
                        <option key={cycle} value={cycle}>
                          {spell(cycle)}
                        </option>
                      ))}
                    </SelectField>
                    <Field
                      id={`amount-${index}`}
                      label="Unit amount"
                      type="number"
                      step="0.01"
                      min={0}
                      required
                      value={row.unit_amount}
                      onChange={(event) => updateRow(index, { unit_amount: event.target.value })}
                    />
                  </FormGrid>

                  <FormGrid>
                    <Field
                      id={`currency-${index}`}
                      label="Currency"
                      required
                      value={row.currency}
                      onChange={(event) => updateRow(index, { currency: event.target.value })}
                      hint="Three-letter code."
                    />
                    {/* Only `custom_days` carries a length; the schema refuses it on the others. */}
                    {row.billing_cycle === 'custom_days' ? (
                      <Field
                        id={`days-${index}`}
                        label="Cycle length (days)"
                        type="number"
                        min={1}
                        required
                        value={row.cycle_days}
                        onChange={(event) => updateRow(index, { cycle_days: event.target.value })}
                      />
                    ) : (
                      <SelectField
                        id={`plan-${index}`}
                        label="Restricted to plan"
                        value={row.plan_id}
                        onChange={(event) => updateRow(index, { plan_id: event.target.value })}
                        hint="A restricted price can only be charged to a subscription on that plan."
                      >
                        <option value="">Any plan</option>
                        {plans.rows.map((plan) => (
                          <option key={plan.id} value={plan.id}>
                            {plan.name} ({plan.code})
                          </option>
                        ))}
                      </SelectField>
                    )}
                  </FormGrid>

                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    {/*
                      * `htmlFor` rather than a wrapping label. Both associate the control, and only
                      * one of them is checkable: `verify-frontend.js` requires every screen carrying
                      * a raw `<input>` to carry `htmlFor=` or `aria-label=` somewhere, because a
                      * wrapping label is indistinguishable from no label at all to a text scan.
                      */}
                    <div className="flex items-center gap-2 text-sm">
                      <input
                        id={`active-${index}`}
                        type="checkbox"
                        className="size-4"
                        checked={row.is_active}
                        onChange={(event) => updateRow(index, { is_active: event.target.checked })}
                      />
                      <label htmlFor={`active-${index}`}>On sale</label>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger-ghost"
                      onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    >
                      Remove this price
                    </button>
                  </div>
                </div>
              ))}

              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setRows((current) => [...current, { ...BLANK_ROW }])}
              >
                Add a price
              </button>

              <FormActions>
                <SubmitButton busy={pricesBusy} busyLabel="Saving…" fullWidth={false}>
                  Save pricing
                </SubmitButton>
              </FormActions>
            </form>
          </FormSection>
        </div>
      )}
    </div>
  );
}
