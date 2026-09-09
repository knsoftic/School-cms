'use client';

/**
 * Plans — SRS §11 (and §10.2, which fixes the plan's own fields), §33's "Plans", checklist row 4.3.
 *
 * The subscription catalogue: one row per `subscription_plans` record, in the order its author
 * arranged them. Built on the four moving parts the Schools screen settled — `useCollection`, a
 * `Column[]`, the four-state render, `Pagination` — and the reasoning for each of those lives there
 * rather than being restated here. What follows is only what is different about plans.
 *
 * ## The list is not just the plan's columns
 *
 * `plans.controller.present()` adds a derived `readiness` block to every row, computed from the four
 * configuration collections the service eager-loads with `separate: true`. That is what makes a
 * readiness column affordable — it is one extra query for the page, not one per row — and it is worth
 * a column because `status` alone is misleading. FR-SUB-004 makes `active` mean *"available for new
 * subscriptions"*, and a plan can be `active` while holding no active `plan_prices` row, at which
 * point nothing can be sold against it. The server computes `subscribable` from both halves; the
 * screen shows the answer instead of guessing at one.
 *
 * ## No plan is identified by its name (SRS §30 Rule 1)
 *
 * Every branch below reads a count, a boolean the server derived, or a status enum. None compares a
 * plan's `name` or `code` against a literal — which is the rule that keeps "Premium" from acquiring
 * behaviour that a renamed or duplicated plan would silently lose.
 *
 * ## Search is debounced for a sharper reason than on /schools
 *
 * `plans.service.list()` builds its `q` filter as three `LIKE '%…%'` clauses — `name`, `code` and
 * `description` — and `description` is a `TEXT` column, so the scan is wider than the two-column one
 * the exemplar debounces. 300 ms collapses a typed word into a single request.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { useRowAction } from '@/lib/useRowAction';
import { PlanDuplicateDialog, PlanStatusDialog } from '@/components/planLifecycle';
import {
  SearchField,
  FilterBar,
  FilterSelect,
} from '@/components/form';
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
 * The derived block `present()` adds to every plan.
 *
 * Typed in full even though the table reads three of its fields, because the shape is the contract
 * with `plans.service.readiness()` and a partial interface would let a rename there pass silently.
 */
interface PlanReadiness {
  priceCount: number;
  activePriceCount: number;
  hasDefaultPrice: boolean;
  enabledModuleCount: number;
  configuredLimitCount: number;
  /** Limit keys with no `plan_limits` row. Each resolves to **zero** in `entitlementService`. */
  unconfiguredLimits: string[];
  /** `status === active` **and** at least one active price. Both halves are required. */
  subscribable: boolean;
}

/** A plan row, as `subscription_plans` and `present()` define it. */
interface Plan {
  id: number;
  name: string;
  code: string;
  status: string;
  visibility: string;
  is_recommended: boolean;
  /**
   * `INTEGER.UNSIGNED`, so a number.
   *
   * The rest of that sentence used to read "rather than one of the DECIMAL strings elsewhere in this
   * module" — there are none. `config/database.js` sets `dialectOptions.decimalNumbers = true`, so
   * every DECIMAL in this module arrives as a number too; this field is a plain integer, which is a
   * difference in scale, not in JavaScript type.
   */
  trial_days: number;
  readiness: PlanReadiness;
}


/*
 * The two filter vocabularies, written out.
 *
 * `plans.service.catalogue()` exists so the frontend does not duplicate the *long* vocabularies — the
 * twenty modules, eight limits, seven add-ons — and the Plan Builder screens must read them from it.
 * These two are a different case: SRS §10.2 fixes Public/Private and FR-SUB-004/005 fix the three
 * statuses, they are closed sets of two and three words, and a value outside them is rejected by Joi
 * with a 422 naming the field. Fetching a second endpoint to populate five `<option>` elements would
 * buy a loading state and no safety this does not already have.
 */
const STATUS_OPTIONS = ['active', 'inactive', 'archived'] as const;
const VISIBILITY_OPTIONS = ['public', 'private'] as const;

export default function PlansPage() {
  const { can } = useAuth();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [visibility, setVisibility] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useMemo(
    () => ({
      page,
      limit: 20,
      q: debounced || undefined,
      status: status || undefined,
      visibility: visibility || undefined,
    }),
    [page, debounced, status, visibility]
  );

  /*
   * `sortBy` is deliberately not sent. The service defaults to `display_order ASC`, which is SRS
   * §10.2's "Display Order" — the arrangement the catalogue's author chose — and that is the one
   * order this screen is for. A sort control would let a click discard it and leave the rows in an
   * order that means nothing to the person who arranged them.
   */
  const { rows, meta, loading, error, refusal, reload } = useCollection<Plan>('/plans', query);

  /*
   * The five write routes this screen owns, as four confirmations and one form.
   *
   * All five sit behind `plans.manage`, so one flag gates the whole column. `reason` is sent only
   * when something was typed: the schema is `.empty('').allow(null)`, so a blank string would be
   * accepted and then written to `audit_logs.reason` as an empty record of nothing.
   */
  const canManage = can('plans.manage');

  const activate = useRowAction<Plan, string | null>({
    perform: (row) => api.post(`/plans/${row.id}/activate`, {}),
    success: (row) => `${row.name} is now offered for new subscriptions`,
    failure: 'Could not activate that plan',
    onDone: reload,
  });

  const withdraw = useRowAction<Plan, string | null>({
    perform: (row, reason) => api.post(`/plans/${row.id}/deactivate`, reason ? { reason } : {}),
    success: (row) => `${row.name} withdrawn from the catalogue`,
    failure: 'Could not withdraw that plan',
    onDone: reload,
  });

  const restore = useRowAction<Plan, string | null>({
    /* The same endpoint as `withdraw`; see `PlanTransition` for why it is offered under two names. */
    perform: (row, reason) => api.post(`/plans/${row.id}/deactivate`, reason ? { reason } : {}),
    success: (row) => `${row.name} restored as a draft`,
    failure: 'Could not restore that plan',
    onDone: reload,
  });

  const archive = useRowAction<Plan, string | null>({
    perform: (row, reason) => api.post(`/plans/${row.id}/archive`, reason ? { reason } : {}),
    success: (row) => `${row.name} archived`,
    failure: 'Could not archive that plan',
    onDone: reload,
  });

  /** The plan whose duplicate dialog is open. Not a `useRowAction` — see `PlanDuplicateDialog`. */
  const [duplicating, setDuplicating] = useState<Plan | null>(null);

  const columns = useMemo<Column<Plan>[]>(
    () => {
      const base: Column<Plan>[] = [
      {
        key: 'name',
        header: 'Plan',
        cell: (row) => (
          <span className="font-medium">
            {/*
              * A link only for someone who can act on it. The detail screen is an edit form and a
              * pricing editor; offering it to a reader would open a screen whose every control is
              * refused.
              */}
            {canManage ? (
              <Link
                href={`/super-admin/plans/${row.id}`}
                className="text-brand-text underline-offset-4 hover:underline"
              >
                {row.name}
              </Link>
            ) : (
              row.name
            )}
            {/*
              * Recommended rides in this cell rather than taking a column of its own. It is true for
              * one or two rows in a catalogue, so a dedicated column would be a strip of blanks —
              * and its meaning is "this is the one we point schools at", which belongs beside the
              * name it qualifies.
              */}
            {row.is_recommended ? (
              <span className="ml-2 rounded-full border border-border-strong px-2 py-0.5 text-xs font-normal text-muted">
                Recommended
              </span>
            ) : null}
          </span>
        ),
      },
      { key: 'code', header: 'Code', cell: (row) => <code className="text-xs text-muted">{row.code}</code> },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
      {
        key: 'visibility',
        header: 'Visibility',
        /*
         * A private plan is one negotiated with a single school and hidden from everyone else —
         * `scopeFor()` will not return it to a non-platform caller at all. That makes it a property
         * an operator has to be able to see at a glance from the catalogue, not a detail-page field.
         */
        cell: (row) => <StatusBadge status={row.visibility} />,
      },
      {
        key: 'trial_days',
        header: 'Trial',
        numeric: true,
        /* The column's own comment: 0 means no trial, not "unset". */
        cell: (row) =>
          row.trial_days > 0 ? (
            `${row.trial_days} ${row.trial_days === 1 ? 'day' : 'days'}`
          ) : (
            <span className="text-muted-soft">none</span>
          ),
      },
      {
        key: 'modules',
        header: 'Modules',
        numeric: true,
        cell: (row) => row.readiness.enabledModuleCount,
      },
      {
        key: 'readiness',
        header: 'Readiness',
        cell: (row) => {
          const { subscribable, activePriceCount, unconfiguredLimits } = row.readiness;

          /*
           * `subscribable` is false for exactly two reasons, and only one of them is invisible from
           * here: a missing price. The other is the status, which the column three to the left
           * already states — repeating it would be noise where the useful half is the price.
           */
          if (!subscribable) {
            return (
              <span className="whitespace-nowrap text-warn">
                {activePriceCount === 0 ? 'No active price' : 'Not offered'}
              </span>
            );
          }

          /*
           * A sellable plan can still be quietly broken: an absent `plan_limits` row resolves to
           * zero rather than to unlimited, so a plan missing `teacher_limit` forbids teachers to
           * every school on it. That is worth saying on the list, because the symptom appears in a
           * different tenant's screen days later.
           */
          if (unconfiguredLimits.length > 0) {
            return (
              <span className="whitespace-nowrap text-warn">
                Sellable · {unconfiguredLimits.length} limit
                {unconfiguredLimits.length === 1 ? '' : 's'} unset
              </span>
            );
          }

          /* The word carries the state; the colour only makes it faster to find. */
          return <span className="whitespace-nowrap text-success">Sellable</span>;
        },
      },
      ];

      if (!canManage) return base;

      return [
        ...base,
        {
          key: 'actions',
          header: 'Actions',
          /*
           * Which buttons appear is decided by `status`, not by the plan's name or code — SRS §30
           * Rule 1, the same rule the rest of this screen keeps.
           *
           * An active plan can be withdrawn or archived; a draft can be offered or archived; an
           * archived one can be offered again or brought back as a draft. Every row can be
           * duplicated, because FR-SUB-003 puts no state condition on it and a copy is born
           * inactive whatever the source was.
           */
          cell: (row) => (
            <span className="flex flex-wrap gap-1">
              {row.status !== 'active' ? (
                <button type="button" onClick={() => activate.ask(row)} className="btn btn-ghost btn-sm">
                  Activate
                </button>
              ) : (
                <button type="button" onClick={() => withdraw.ask(row)} className="btn btn-ghost btn-sm">
                  Withdraw
                </button>
              )}

              {row.status === 'archived' ? (
                <button type="button" onClick={() => restore.ask(row)} className="btn btn-ghost btn-sm">
                  Restore
                </button>
              ) : (
                <button type="button" onClick={() => archive.ask(row)} className="btn btn-ghost btn-sm">
                  Archive
                </button>
              )}

              <button type="button" onClick={() => setDuplicating(row)} className="btn btn-ghost btn-sm">
                Duplicate
              </button>
            </span>
          ),
        },
      ];
    },
    [canManage, activate, withdraw, restore, archive]
  );

  /** Whether the empty table is an empty catalogue or an over-narrow query. */
  const narrowed = Boolean(debounced || status || visibility);

  return (
    <div>
      <PageHeader
        title="Plans"
        description="The subscription catalogue, in its display order. Archived plans are retained and listed here too — filter by status to set them aside."
        action={
          /* `plans.manage` is one of the five keys in `config/permissions.js`; the API re-reads it on
           * the request, so hiding the button is a courtesy rather than the control. */
          can('plans.manage') ? (
            <a
              href="/super-admin/plans/new"
              className="btn btn-primary"
            >
              New plan
            </a>
          ) : null
        }
      />

      <FilterBar
        activeCount={[search, status, visibility].filter(Boolean).length}
        onClear={() => {
          setSearch('');
          setStatus('');
          setVisibility('');
          setPage(1);
        }}
      >
        <div>
          {/* The placeholder carries the meaning of a search box; a select has no placeholder, so the
            * two below are labelled visibly instead. */}
          <SearchField
            id="plan-search"
            label="Search plans"
            placeholder="Search by name, code or description…"
            value={search}
            onChange={setSearch}
          />
        </div>

        <div>
          <FilterSelect
            id="plan-status"
            label="Status"
            labelVisible
            value={status}
            onChange={(value) => {
              setStatus(value);
              /* Same reason the debounce resets it: a filter applied from page four shows an empty
               * table for a result set that has one page. */
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </FilterSelect>
        </div>

        <div>
          <FilterSelect
            id="plan-visibility"
            label="Visibility"
            labelVisible
            value={visibility}
            onChange={(value) => {
              setVisibility(value);
              setPage(1);
            }}
          >
            <option value="">All visibilities</option>
            {VISIBILITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </FilterSelect>
        </div>
      </FilterBar>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {narrowed
            ? 'No plan matches the current search and filters.'
            : 'No plans yet. A new plan starts inactive — configure its pricing, modules and limits, then activate it.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Subscription plans"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      {/*
        * Four dialogs rather than one with a prop, because each is bound to its own `useRowAction`
        * and each of those owns the row it is acting on. Only one can have a target at a time — the
        * buttons above are mutually exclusive per row — so at most one is ever open.
        */}
      <PlanStatusDialog
        transition="activate"
        plan={activate.target}
        busy={activate.busy}
        conflict={activate.conflict}
        onCancel={activate.cancel}
        onConfirm={() => activate.confirm(null)}
      />
      <PlanStatusDialog
        transition="deactivate"
        plan={withdraw.target}
        busy={withdraw.busy}
        conflict={withdraw.conflict}
        onCancel={withdraw.cancel}
        onConfirm={(reason) => withdraw.confirm(reason)}
      />
      <PlanStatusDialog
        transition="restore"
        plan={restore.target}
        busy={restore.busy}
        conflict={restore.conflict}
        onCancel={restore.cancel}
        onConfirm={(reason) => restore.confirm(reason)}
      />
      <PlanStatusDialog
        transition="archive"
        plan={archive.target}
        busy={archive.busy}
        conflict={archive.conflict}
        onCancel={archive.cancel}
        onConfirm={(reason) => archive.confirm(reason)}
      />

      <PlanDuplicateDialog
        plan={duplicating}
        onCancel={() => setDuplicating(null)}
        onDone={reload}
      />
    </div>
  );
}
