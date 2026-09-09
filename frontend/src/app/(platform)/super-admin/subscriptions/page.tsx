'use client';

/**
 * Subscriptions — SRS §12 and §33's "Subscriptions", checklist row 4.3.
 *
 * The same four moving parts as `super-admin/schools/page.tsx`: a `useCollection` call, a `Column[]`,
 * the four-state render, and pagination. What differs is what a subscription list is *for*. Schools
 * is a directory — you arrive knowing a name. This screen is a work queue: FR-SUB-015's renewal is
 * *"initiated by the system at cycle end"*, and the only rows a Super Admin needs to touch are the
 * ones the system will not handle on its own. So the two filters here answer "what ends soon" and
 * "what state is it in", and the columns are chosen so the answer is readable without opening a row.
 *
 * ## There is no search box, and that is not an oversight
 *
 * `q` is accepted by this endpoint — `listQuery()` in `middlewares/validate.js` merges
 * `commonSchemas.search` into every list schema, so `validate()` will let it through. But
 * `subscriptions.service.list()` reads only `school_id`, `plan_id`, `state`, `renewal_mode` and
 * `expiring_within_days`; `q` is never applied to the `where`. A search box here would accept typing,
 * issue a request, and return the unfiltered page — the worst kind of broken, because it looks like
 * it worked and the user concludes the row does not exist. A parameter being *accepted* is not the
 * same as it being *implemented*, and the service is the authority on which.
 *
 * `school_id` and `plan_id` are real filters and are still not offered: both take a numeric id, and a
 * control that asks an operator to type `17` is worse than no control. They become useful when this
 * screen can be reached *from* a school or a plan, which is a link on those screens, not an input on
 * this one.
 *
 * ## Nothing here derives a lifecycle state from a date
 *
 * `subscriptions.service.js` is explicit that lifecycle state is written by `runLifecycleSweep()` and
 * *"read, never recomputed"* elsewhere — two components inferring `expired` from
 * `current_period_end` is exactly how they come to disagree. So `state` is displayed as stored, and
 * "how many days left" is read from the server's own `standing` block rather than subtracted here.
 * The dates below are formatted, never interpreted.
 */

import { useMemo, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { formatCodeWithAmount } from '@/lib/money';
import { useCollection } from '@/lib/useCollection';
import { useSchoolNames } from '@/lib/useSchoolNames';
import {
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
 * One row of `GET /subscriptions`, as `subscriptions.controller.present()` builds it.
 *
 * `present()` is `subscription.toJSON()` plus a derived `standing` block, so the shape is the
 * `subscriptions` columns plus the `detailInclude()` associations. Only the fields this screen reads
 * are declared — an interface listing `items`, `addons`, `overrides`, `planPrice` and
 * `scheduledPlanPrice` would imply this screen is entitled to render them.
 *
 * Note what is **absent**: `detailInclude()` includes `plan`, but no `school`. The payload carries a
 * `school_id` and no school name. This screen used to print `#42` and argue that resolving it "would be
 * this screen deciding what the API should have returned" — which was right about the principle and
 * wrong about the remedy, because the column stayed unreadable. The lookup is now `lib/useSchoolNames`:
 * shared by the three platform screens with the same gap, fetched once per session rather than once per
 * row, and falling back to `School #42` above its page ceiling. No endpoint's shape changed.
 */
interface SubscriptionRow {
  id: number;
  school_id: number;
  state: string;
  billing_cycle: string;
  currency: string;
  /**
   * `models/columns.js` defines `money()` as `DECIMAL(14, 2)`. It arrives as a JS **number**, not a
   * string — `config/database.js` sets `dialectOptions.decimalNumbers = true`, so mysql2 parses it
   * before Sequelize sees it. This was typed `string` and the formatter split it on `'.'`, so a
   * `499.00` amount rendered as `499`. Format it with `formatMoney`; do no arithmetic on it here.
   */
  cycle_amount: number;
  current_period_end: string | null;
  renewal_mode: string;
  next_renewal_at: string | null;
  plan: { id: number; name: string } | null;
  standing: {
    daysUntilPeriodEnd: number | null;
    hasScheduledChange: boolean;
  } | null;
}

/**
 * The ten `SUBSCRIPTION_STATES` of SRS §12, copied from `backend/src/config/constants.js`.
 *
 * A duplicated enum is a liability, so the failure mode is worth being precise about: `state` is
 * validated with `Joi.valid(...SUBSCRIPTION_STATE_LIST)`, which means a value that drifts out of the
 * backend's list is refused with a 422 rather than silently returning wrong rows. The cost of this
 * list going stale is a *missing option*, never a wrong answer. `GET /subscriptions/catalogue` serves
 * the live vocabulary if this ever needs to stop being a constant.
 */
const STATES = [
  'trial',
  'active',
  'pending',
  'past_due',
  'expiring',
  'grace_period',
  'expired',
  'suspended',
  'cancelled',
  'paused',
] as const;

/** `expiring_within_days` presets. The parameter takes any 0–3650; these are the questions asked. */
const EXPIRY_WINDOWS = [
  { value: '7', label: 'Period ends within 7 days, or already has' },
  { value: '30', label: 'Period ends within 30 days, or already has' },
  { value: '0', label: 'Already past period end' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * An ISO timestamp as a fixed `5 Sep 2026`, in UTC.
 *
 * `toLocaleDateString()` is the obvious choice and the wrong one here. This is a client component,
 * which Next.js still renders on the server first: Node formats with the server's locale and zone,
 * the browser re-formats with the user's, and the two strings differ — a hydration mismatch on every
 * date cell. Reading the UTC parts explicitly produces the same characters in both places, and picks
 * a day-month order that cannot be misread the way `09/05/2026` can.
 */
function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Enum values are stored `snake_case` and read as words. */
function humanise(value: string): string {
  return value.replace(/_/g, ' ');
}

/** An em dash carrying the meaning "the server sent nothing here", not "zero". */
function Blank() {
  return <span className="text-muted-soft">—</span>;
}

export default function SubscriptionsPage() {
  const { can } = useAuth();
  const { nameFor } = useSchoolNames();

  const [page, setPage] = useState(1);
  const [state, setState] = useState('');
  const [expiring, setExpiring] = useState('');

  /*
   * Every filter change resets to page one, for the reason the Schools screen gives about search:
   * narrowing from page four to a result set with one page shows an empty table for a filter that
   * matched. Wrapped here so neither `<select>` can forget it.
   */
  function applyFilter(setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
      setPage(1);
    };
  }

  const query = useMemo(
    () => ({
      page,
      limit: 20,
      state: state || undefined,
      /*
       * `0` is a legal window — the validation comments call it *"already past its period end"* — and
       * `0 || undefined` is `undefined`, which would silently drop the most urgent filter on the
       * screen. Hence the explicit empty-string test rather than a falsy one.
       */
      expiring_within_days: expiring === '' ? undefined : Number(expiring),
    }),
    [page, state, expiring]
  );

  const { rows, meta, loading, error, refusal, reload } = useCollection<SubscriptionRow>(
    '/subscriptions',
    query
  );

  const columns = useMemo<Column<SubscriptionRow>[]>(
    () => [
      {
        key: 'school',
        header: 'School',
        cell: (row) => <span className="truncate text-muted">{nameFor(row.school_id)}</span>,
      },
      {
        key: 'plan',
        header: 'Plan',
        cell: (row) => (
          <div>
            {/*
              * Displayed, never compared. SRS §30 Rule 1 forbids branching on a plan name — what a
              * plan grants is `plan_modules` / `plan_features` / `plan_limits`, resolved by
              * `entitlementService`, and a screen that read "Premium" to decide anything would break
              * the moment a school is sold a renamed or custom plan.
              */}
            <span className="font-medium">{row.plan ? row.plan.name : <Blank />}</span>
            {/*
              * `hasScheduledChange` is `standing`'s, derived from `scheduled_plan_id`. A downgrade in
              * SRS §12.4 may be *scheduled* rather than applied, so the plan named above is not
              * necessarily the plan this school will be on next cycle. Without this marker the list
              * states something that is about to stop being true.
              */}
            {row.standing?.hasScheduledChange ? (
              <span className="block text-xs text-muted-soft">change scheduled</span>
            ) : null}
          </div>
        ),
      },
      { key: 'state', header: 'State', cell: (row) => <StatusBadge status={row.state} /> },
      {
        key: 'amount',
        header: 'Cycle amount',
        numeric: true,
        cell: (row) => (
          <div>
            <span>
              {formatCodeWithAmount(row.currency, row.cycle_amount)}
            </span>
            {/*
              * `billing_cycle` shares this cell rather than taking its own column: an amount without
              * its period is not a figure anyone can compare, and 1,200 yearly beside 1,200 monthly
              * in a "cycle amount" column invites exactly that comparison.
              */}
            <span className="block text-xs text-muted-soft">{humanise(row.billing_cycle)}</span>
          </div>
        ),
      },
      {
        key: 'period_end',
        header: 'Period ends',
        cell: (row) => {
          const formatted = formatDate(row.current_period_end);
          /* Null for `one_time`, which the model's own column comment says outright. */
          if (!formatted) return <Blank />;

          const days = row.standing ? row.standing.daysUntilPeriodEnd : null;
          return (
            <div>
              <span className="whitespace-nowrap">{formatted}</span>
              {days === null ? null : (
                <span className="block text-xs text-muted-soft">
                  {/*
                    * `daysBetween()` floors a signed difference, so a past period end is negative.
                    * Saying "-3 days left" would read as a rendering fault; the sign is the whole
                    * message on the rows that need attention most, so it gets words.
                    */}
                  {days < 0 ? `${Math.abs(days)} days ago` : days === 0 ? 'today' : `in ${days} days`}
                </span>
              )}
            </div>
          );
        },
      },
      {
        key: 'renewal',
        header: 'Renewal',
        cell: (row) => {
          const next = formatDate(row.next_renewal_at);
          return (
            <div>
              {/*
                * The mode is the actionable half: `automatic` means the sweep handles it, `manual`
                * means a person must. Pairing it with the date is what turns this list into the queue
                * FR-SUB-015 implies, without needing a filter for it.
                */}
              <span>{humanise(row.renewal_mode)}</span>
              <span className="block whitespace-nowrap text-xs text-muted-soft">{next ?? '—'}</span>
            </div>
          );
        },
      },
    ],
    [nameFor]
  );

  const filtered = state !== '' || expiring !== '';

  return (
    <div>
      <PageHeader
        title="Subscriptions"
        description="Every school’s plan, billing cycle and renewal, across all organizations."
        action={
          /*
           * Hidden without the permission — a courtesy, not a control, exactly as on Schools.
           * `subscriptions.manage` is `permissions.js` line 50 ("Create / change subscriptions") and
           * is re-read from the database on the request itself, so forcing this button into existence
           * gets the user a 403 rather than a subscription.
           *
           * Deliberately *not* `subscriptions.lifecycle`: that key guards upgrade / renew / pause /
           * cancel, which are actions on an existing row and belong on its detail screen, not on a
           * button whose only job is to start a new one.
           */
          can('subscriptions.manage') ? (
            <a
              href="/super-admin/subscriptions/new"
              className="btn btn-primary"
            >
              New subscription
            </a>
          ) : null
        }
      />

      <FilterBar
        activeCount={[expiring, state].filter(Boolean).length}
        onClear={() => {
          setExpiring('');
          setState('');
          setPage(1);
        }}
      >
        <div>
          <FilterSelect
            id="subscription-state"
            label="State"
            labelVisible
            value={state}
            onChange={(value) => applyFilter(setState)(value)}
          >
            <option value="">All states</option>
            {STATES.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </FilterSelect>
        </div>

        <div>
          <FilterSelect
            id="subscription-expiring"
            label="Period end"
            labelVisible
            value={expiring}
            onChange={(value) => applyFilter(setExpiring)(value)}
          >
            <option value="">Any time</option>
            {/* Not named `window` — shadowing the global inside a client component is a trap. */}
            {EXPIRY_WINDOWS.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </FilterSelect>
        </div>
      </FilterBar>

      {/*
        * Refusal before error, error before loading — the order the exemplar sets and the reason it
        * gives. It matters more here than anywhere: a school principal reaching this screen with a
        * lapsed subscription gets `SUBSCRIPTION_INACTIVE`, and telling them "something went wrong"
        * about the very thing that has gone wrong sends them looking for a fault instead of a
        * renewal.
        */}
      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {filtered
            ? 'No subscription matches these filters.'
            : 'No school has been put on a plan yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption="Subscriptions"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
