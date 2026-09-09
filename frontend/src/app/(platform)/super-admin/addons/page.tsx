'use client';

/**
 * Add-ons — SRS §11.3 and §33's "Add-ons", checklist row 4.3.
 *
 * The same four moving parts the Schools exemplar establishes: a `useCollection` call, a `Column[]`,
 * the four-state render in refusal → error → loading → empty → table order, and `Pagination`. What
 * follows is only the two places this screen deliberately differs from it, and why.
 *
 * ## There is no "Add add-on" button, and `addons.manage` is not the reason
 *
 * The permission exists (`config/permissions.js`, granted to `super_admin` alone) — but every route it
 * guards is addressed to a single add-on: `PATCH /addons/:id`, `POST /:id/activate`,
 * `POST /:id/deactivate`, `PUT /:id/prices`. There is no `POST /addons` and no `DELETE /:id`, and
 * `addons.routes.js` says why: SRS §11.3 names seven add-ons, `addons.key` is `unique` and validated
 * `isIn: [ADDON_LIST]`, so an eighth row cannot exist and removal is refused from the other side by
 * `subscription_addons.addon_id` being `RESTRICT`. A header "Add" button would promise a screen the
 * API is built to refuse — inventing a requirement, which SRS §35 forbids outright.
 *
 * So `addons.manage` gates the affordance the API actually has: the add-on's name links to its own
 * page. It is gated on `manage` rather than `view` because everything that page holds beyond the row
 * already on screen — the availability switch and the price set — is a `manage` route, so a
 * view-only operator would arrive at a read-only copy of this line.
 *
 * ## No search box, and only one filter
 *
 * The exemplar debounces `q` because a school list grows without bound. This one cannot: the seven
 * rows are fixed data, they arrive in `display_order` (the service's `DEFAULT_SORT`, which is the
 * order SRS §11.3 lists them in), and they fit on one page. A search box over seven rows spends a
 * request against `apiLimiter` — mounted before authentication, so the budget is real — to save an
 * operator from reading seven lines. `effect_type` splits the same seven into five and two, which is
 * a filter that cannot narrow anything a glance does not.
 *
 * `is_active` earns its place regardless of row count, because it is the one column an operator comes
 * here to *change* (FR-SUB-009's availability switch), and "what did I take off sale" is a question
 * the eye answers badly when the answer is "none of them".
 *
 * `Pagination` stays even though it renders nothing at seven rows — it hides itself below two pages,
 * and removing it would make a lowered page size silently truncate the catalogue.
 */

import { useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import {
  Notice,
  TextAreaField,
  FilterBar,
  FilterSelect,
} from '@/components/form';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  Pagination,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

/**
 * One row of `GET /addons`, as `addons.controller.present()` assembles it: the add-on's own columns
 * spread from `toJSON()`, plus the derived `readiness` block.
 *
 * `prices` also arrives (a `separate: true` include, active-only for a school-scoped caller) and is
 * deliberately not typed here. `readiness` is the counted summary of exactly that array, computed
 * server-side, and a list row that re-counted it in the browser would be a second answer to a
 * question the API has already answered.
 */
interface Addon {
  id: number;
  key: string;
  name: string;
  /** The `addons.effect_type` ENUM — two values, fixed by `ADDON_EFFECTS`. */
  effect_type: 'limit_increase' | 'feature_unlock';
  effect_target: string;
  /*
   * BIGINT. mysql2 hands a BIGINT back as a string even though `decimalNumbers: true` unwraps the
   * DECIMAL columns, so this is never arithmetic — see `formatUnits()`.
   */
  units_per_quantity: number | string;
  /** Derived from `LIMIT_UNITS[effect_target]`; null for a `feature_unlock`, which grants no units. */
  unit: string | null;
  is_active: boolean;
  readiness: {
    priceCount: number;
    activePriceCount: number;
    planRestrictedPriceCount: number;
    unrestrictedPriceCount: number;
    purchasable: boolean;
  };
}

/**
 * The block size, printed.
 *
 * `Number()` is exact up to `MAX_SAFE_INTEGER`, which is the ceiling `addons.validation.js` enforces
 * on the way in — so every value this API can write formats losslessly. A larger one could only have
 * been written into the table by hand, and showing its raw digits is more honest than a
 * thousands-separated number that has already lost the last few of them.
 */
function formatUnits(value: number | string): string {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric.toLocaleString() : String(value);
}

/**
 * Why this add-on cannot be bought — named, rather than left as a bare "no".
 *
 * `readiness.purchasable` is both halves at once (`is_active` **and** at least one active price), and
 * an operator told only that it is false has to open the add-on to find out which half is missing.
 * Both can be missing together, so the two are reported together rather than as a first-match.
 */
function blockedBecause(row: Addon): string {
  const reasons: string[] = [];
  if (!row.is_active) reasons.push('off sale');
  if (row.readiness.activePriceCount === 0) reasons.push('not priced');
  return reasons.join(' · ');
}

export default function AddonsPage() {
  const { can } = useAuth();

  /*
   * Read once into a boolean rather than calling `can()` inside a cell. A cell runs per row per
   * render, and this is the column memo's dependency — a fresh call site would not be one.
   */
  const manageable = can('addons.manage');
  /* The add-on whose on-sale state is being changed, or null. */
  const [pending, setPending] = useState<Addon | null>(null);

  const [page, setPage] = useState(1);
  /* '' means "no filter", which `buildUrl()` drops from the query string rather than sending empty. */
  const [status, setStatus] = useState('');

  /*
   * `is_active` travels as the string 'true' / 'false': `Query` values are strings or numbers, and
   * `validate()` runs Joi with `convert: true`, so `Joi.boolean()` reads either back as a boolean.
   */
  const query = useMemo(
    () => ({ page, limit: 20, is_active: status || undefined }),
    [page, status]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<Addon>('/addons', query);

  const columns = useMemo<Column<Addon>[]>(
    () => [
      {
        key: 'name',
        header: 'Add-on',
        primary: true,
        /*
         * Plain text, not a link.
         *
         * This linked to `/super-admin/addons/{id}`, and that route does not exist — the screen's only
         * affordance landed on the not-found page. FR-SUB-009's two actions are `POST /:id/activate`
         * and `POST /:id/deactivate`, so they are offered on the row itself rather than behind a
         * detail page nobody has built: one click instead of two, and no dead URL.
         */
        cell: (row) => <span className="font-medium">{row.name}</span>,
      },
      {
        key: 'key',
        header: 'Key',
        /* The stable identifier: it is what the audit trail and the purchase payloads name, and the
         * one part of the row SRS §11.3 fixes and no endpoint will ever edit. */
        cell: (row) => <code className="text-xs text-muted">{row.key}</code>,
      },
      {
        key: 'effect',
        header: 'Effect',
        /*
         * `effect_type` and `effect_target` are one fact in two columns — "raises" and "raises what" —
         * and reading either alone tells an operator nothing actionable. They share a cell so the
         * pairing survives a narrow viewport, where two adjacent columns can be scrolled apart.
         */
        cell: (row) => (
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={row.effect_type} />
            <code className="text-xs text-muted">{row.effect_target}</code>
          </span>
        ),
      },
      {
        key: 'units_per_quantity',
        header: 'Per quantity',
        numeric: true,
        /*
         * The field FR-SUB-009 exists to set — "50 extra students per purchased quantity", in the
         * column's own comment. The branch mirrors `addons.service.unitFor()`: a `feature_unlock`
         * grants no units, so its `units_per_quantity` is the column default rather than a quantity,
         * and printing "1" against Custom Domain would invite an operator to change it.
         *
         * (This is the `addons.effect_type` ENUM, not a plan name — SRS §30 Rule 1 is untouched.)
         */
        cell: (row) =>
          row.effect_type === 'limit_increase' ? (
            <span>
              {formatUnits(row.units_per_quantity)}
              {/* The API's own word for the unit, unpluralised: 'megabytes' and 'requests' come from
                  LIMIT_UNITS, and inflecting them here would invent vocabulary the backend does not
                  have. */}
              {row.unit ? <span className="ml-1 text-xs text-muted-soft">{row.unit}</span> : null}
            </span>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
      {
        key: 'prices',
        header: 'Active prices',
        numeric: true,
        /*
         * A price restricted to a plan is not on general sale, which is why `readiness` counts the
         * restricted and unrestricted separately. An add-on whose every active price is plan-bound
         * looks sellable and is invisible to most schools, so the count alone would mislead.
         */
        cell: (row) =>
          row.readiness.activePriceCount === 0 ? (
            <span className="text-muted-soft">none</span>
          ) : (
            <span>
              {row.readiness.activePriceCount}
              {row.readiness.unrestrictedPriceCount === 0 ? (
                <span className="ml-1 whitespace-nowrap text-xs text-muted-soft">plan-only</span>
              ) : null}
            </span>
          ),
      },
      {
        key: 'is_active',
        header: 'Status',
        /*
         * Deactivating takes the add-on off sale and leaves every school that already owns it
         * untouched — entitlement resolves from `subscription_addons`, never from this flag — so
         * "inactive" here means "not offered", not "withdrawn".
         */
        cell: (row) => <StatusBadge status={row.is_active ? 'active' : 'inactive'} />,
      },
      {
        key: 'purchasable',
        header: 'Purchasable',
        /*
         * Derived per response and never stored, so it cannot disagree with the price rows. Unlike a
         * plan, an add-on may be activated with nothing priced — `subscription_addons.addon_price_id`
         * is nullable, so a comped add-on is a shape the schema allows — which is exactly why this
         * has to be shown rather than assumed from the status badge beside it.
         */
        cell: (row) =>
          row.readiness.purchasable ? (
            <span className="text-success">Yes</span>
          ) : (
            <span className="whitespace-nowrap text-muted-soft">No — {blockedBecause(row)}</span>
          ),
      },
      ...(manageable
        ? [
            {
              key: 'sale',
              header: 'On sale',
              /*
               * FR-SUB-009's two actions, on the row. Deactivating is the destructive-ish direction —
               * it takes the add-on off sale for every school that has not already bought it — so it
               * asks first and offers a reason, which is the field `deactivate` accepts. Activating
               * takes an empty body and needs no confirmation: it only ever widens what is offered.
               */
              cell: (row: Addon) => (
                <button
                  type="button"
                  className={`btn btn-sm ${row.is_active ? 'btn-danger-ghost' : 'btn-secondary'}`}
                  onClick={() => setPending(row)}
                >
                  {row.is_active ? 'Take off sale' : 'Put on sale'}
                </button>
              ),
            } as Column<Addon>,
          ]
        : []),
    ],
    [manageable]
  );

  return (
    <div>
      <PageHeader
        title="Add-ons"
        description="What a school can buy on top of its plan. The seven are fixed by SRS §11.3 — configured here, never created."
      />

      <FilterBar activeCount={status ? 1 : 0} onClear={() => { setStatus(''); setPage(1); }}>
        <FilterSelect
          id="addon-status"
          label="Availability"
          value={status}
          onChange={(value) => {
            setStatus(value);
            /* Part of the filter, not a separate concern — the reasoning the exemplar gives for its
               search box. Filtering from a later page would show an empty table for a filter that has
               results. */
            setPage(1);
          }}
        >
          <option value="">All add-ons</option>
          <option value="true">On sale</option>
          <option value="false">Off sale</option>
        </FilterSelect>
      </FilterBar>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {status === 'true'
            ? 'No add-on is currently on sale.'
            : status === 'false'
              ? 'Every add-on is currently on sale.'
              : /* Not "nothing created yet": there is no create endpoint, so an empty catalogue means
                   the platform's seven rows were never installed — a different problem with a
                   different fix. */
                'The add-on catalogue is empty — SRS §11.3’s seven add-ons have not been installed.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Add-ons" busy={loading} />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <SaleDialog
        addon={pending}
        onClose={() => setPending(null)}
        onDone={() => {
          setPending(null);
          reload();
        }}
      />
    </div>
  );
}

/**
 * Put an add-on on sale, or take it off — FR-SUB-009.
 *
 * ## Why one direction confirms and the other does not
 *
 * `POST /:id/activate` takes an empty body and only ever widens what schools are offered, so it is a
 * single click. `POST /:id/deactivate` takes an optional `reason` and removes the add-on from the
 * catalogue, so it asks first — and says the thing an operator actually needs to know before
 * pressing it: **schools that already bought it keep it.** Entitlement resolves from
 * `subscription_addons`, never from this flag, so "off sale" means "not offered", not "withdrawn".
 * Getting that wrong in either direction is expensive, which is why the sentence is in the dialog
 * rather than in a tooltip.
 *
 * The reason is optional here because the schema makes it optional — unlike the payment rejection,
 * where the field is a message *to the school* and a blank one is useless. This one is an audit note.
 */
function SaleDialog({
  addon,
  onClose,
  onDone,
}: {
  addon: Addon | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { success, error: errorToast } = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!addon) return;
    setReason('');
    setBusy(false);
    setFailure(null);
  }, [addon]);

  if (!addon) return null;

  const takingOff = addon.is_active;

  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api.post(
        `/addons/${addon.id}/${takingOff ? 'deactivate' : 'activate'}`,
        takingOff ? { reason: reason.trim() || undefined } : {}
      );
      success(takingOff ? `${addon.name} taken off sale` : `${addon.name} put on sale`);
      onDone();
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      /* A 409 means the row already moved; that is worth reading here rather than as a toast. */
      if (caught.status === 409) setFailure(caught.message);
      else {
        errorToast('Could not change that add-on', caught.message);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={addon !== null}
      onClose={onClose}
      busy={busy}
      size="sm"
      title={takingOff ? `Take ${addon.name} off sale?` : `Put ${addon.name} on sale?`}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${takingOff ? 'btn-danger' : 'btn-primary'}`}
            onClick={submit}
            disabled={busy}
          >
            {busy ? 'Saving…' : takingOff ? 'Take off sale' : 'Put on sale'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {failure ? <Notice tone="error">{failure}</Notice> : null}

        <p className="text-sm leading-relaxed text-muted">
          {takingOff ? (
            <>
              No school will be able to buy <strong className="text-ink">{addon.name}</strong> while it
              is off sale. <strong className="text-ink">Schools that already own it keep it</strong> —
              their entitlement comes from what they bought, not from this setting.
            </>
          ) : (
            <>
              Any school on a plan will be able to buy{' '}
              <strong className="text-ink">{addon.name}</strong>
              {addon.readiness.purchasable
                ? '.'
                : ' — though it has no active price yet, so it will still not be purchasable.'}
            </>
          )}
        </p>

        {takingOff ? (
          <TextAreaField
            id="deactivate-reason"
            label="Reason"
            rows={2}
            maxLength={255}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            hint="Optional. Kept on the audit record, not shown to schools."
          />
        ) : null}
      </div>
    </Modal>
  );
}
