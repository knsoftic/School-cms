'use client';

/**
 * List-screen primitives — the table, its four states, and the page chrome around them.
 *
 * Fifty-nine screens compose from this file, so every improvement here lands everywhere at once and
 * every mistake does too. The rules it enforces on their behalf:
 *
 *   - **A table becomes cards below `md`.** Shrinking a seven-column table onto a 375px screen gives
 *     a horizontal scrollbar and unreadable columns; the same rows as stacked label/value pairs are
 *     legible. Both are rendered from one `Column[]`, so a screen cannot describe them differently.
 *   - **A refresh does not blank the screen.** The old list screens replaced the whole table with the
 *     word "Loading…" on every debounced keystroke, so the page jumped and the scroll position went.
 *     `DataTable` now dims in place while `busy`, and the skeleton is only for the first load, when
 *     there is genuinely nothing to keep.
 *   - **Status is never colour alone.** Word plus tone plus a shape, so it survives a colour-blind
 *     reader, a greyscale print and a screen reader.
 *   - **Empty is not the same as filtered-empty.** "No students yet" and "No students match
 *     'abc'" need different words and different actions, and a screen that says the first when it
 *     means the second sends someone looking for a bug.
 */

import type { ReactNode } from 'react';

import { Icon } from '@/components/icon';
import type { IconName } from '@/components/icon';
import type { PageMeta } from '@/lib/apiClient';
import type { Refusal } from '@/lib/useCollection';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  numeric?: boolean;
  /**
   * Hide this column in the mobile card. For ids and secondary detail that make a card too tall —
   * the row is still fully readable on a wider screen.
   */
  hideOnMobile?: boolean;
  /** Used as the card's heading on mobile. Exactly one column per table should set it. */
  primary?: boolean;
}

/* ─────────────────────────────── the four states ─────────────────────────────── */

export function RefusalNotice({ refusal }: { refusal: Refusal }) {
  const EXPLANATIONS: Record<string, string> = {
    MODULE_NOT_SUBSCRIBED:
      'This module is not part of your current plan. An administrator can add it to your subscription.',
    FEATURE_NOT_SUBSCRIBED:
      'Your subscription does not include this feature. An administrator can upgrade the plan or add it.',
    SUBSCRIPTION_INACTIVE:
      'This school’s subscription is not active, so this screen is unavailable until it is renewed.',
    PLAN_LIMIT_EXCEEDED:
      'A plan limit has been reached. An administrator can raise it or add an add-on.',
    PLATFORM_SCOPE_REQUIRED:
      'This screen is part of the platform administration surface, which your account is not scoped to.',
    INSUFFICIENT_ROLE: 'Your role does not have access to this resource.',
    SCHOOL_CONTEXT_REQUIRED:
      'This screen needs to know which school it applies to, and the request did not say.',
    MULTIPLE_SCHOOL_CONTEXT:
      'This screen applies to one school at a time, and the request covered several.',
    STUDENT_NOT_LINKED:
      'That student is not linked to this account. The school office manages parent–student links.',
    /*
     * These three are not permission problems, and the fallback below would have called them that.
     * They mean the signed-in account has no profile row behind it — or has one that was switched
     * off — which is a record-keeping state only the school can resolve. Saying "you do not have
     * permission" to a parent whose child was enrolled last week sends them to argue with the wrong
     * person.
     */
    PARENT_PROFILE_MISSING:
      'This account is not yet linked to a parent record, so there are no children to show. The school office creates that link.',
    PARENT_INACTIVE:
      'This parent record has been made inactive, so its children are no longer shown. The school office can reactivate it.',
    TEACHER_PROFILE_MISSING:
      'This account is not yet linked to a teacher record, so there are no classes or subjects to show. The school office creates that link.',
  };

  const explanation =
    EXPLANATIONS[refusal.code] ?? 'Your account does not have permission to view this.';

  return (
    <div role="status" className="surface flex flex-col items-center px-6 py-12 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-warn-soft text-warn">
        <Icon name="lock" size={20} />
      </span>
      <p className="mt-4 max-w-md text-sm font-semibold text-ink">{explanation}</p>
      <p className="mt-1.5 max-w-md text-xs leading-relaxed text-muted">{refusal.message}</p>
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="surface flex flex-col items-center border-danger/25 px-6 py-12 text-center"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-danger-soft text-danger">
        <Icon name="alert-circle" size={20} />
      </span>
      <p className="mt-4 text-sm font-semibold text-ink">Something went wrong</p>
      <p className="mt-1.5 max-w-md text-xs leading-relaxed text-muted">{message}</p>
      <button type="button" onClick={onRetry} className="btn btn-secondary mt-5">
        <Icon name="refresh" size={15} />
        Try again
      </button>
    </div>
  );
}

/**
 * The empty state.
 *
 * Takes an action, because "there is nothing here" is only half a message — the other half is what
 * to do about it, and a screen that offers a create button everywhere else should offer it here
 * most of all, when the list is empty and that is the only thing worth doing.
 */
export function EmptyNotice({
  children,
  icon = 'inbox',
  title,
  action,
}: {
  children?: ReactNode;
  icon?: IconName;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border-strong bg-surface-2 px-6 py-14 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-3 text-muted">
        <Icon name={icon} size={20} />
      </span>
      {title ? <p className="mt-4 text-sm font-semibold text-ink">{title}</p> : null}
      {children ? (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">{children}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function LoadingBlock({ label = 'Loading…', rows = 5 }: { label?: string; rows?: number }) {
  return (
    <div className="surface overflow-hidden" aria-busy="true" aria-live="polite">
      <p className="sr-only">{label}</p>
      <div className="border-b border-border-soft bg-surface-2 px-4 py-3">
        <div className="skeleton h-3.5 w-32" />
      </div>
      <div className="divide-y divide-border-soft">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3.5">
            <div className="skeleton h-3.5 flex-1" style={{ maxWidth: `${9 + ((i * 7) % 8)}rem` }} />
            <div className="skeleton hidden h-3.5 w-24 sm:block" />
            <div className="skeleton hidden h-3.5 w-20 md:block" />
            <div className="skeleton h-5 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────── the table ─────────────────────────────── */

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  caption: string;
  /** A refresh in flight. Dims in place instead of unmounting, so the page does not jump. */
  busy?: boolean;
}

export function DataTable<T>({ columns, rows, rowKey, caption, busy = false }: DataTableProps<T>) {
  const mobileColumns = columns.filter((c) => !c.hideOnMobile);
  const heading = columns.find((c) => c.primary) ?? columns[0];
  const rest = mobileColumns.filter((c) => c !== heading);

  return (
    <div
      className={`transition-opacity duration-200 ${busy ? 'pointer-events-none opacity-60' : ''}`}
      aria-busy={busy || undefined}
    >
      {/* Table from `md` up. */}
      <div
        className="table-scroll surface hidden md:block"
        tabIndex={0}
        role="region"
        aria-label={caption}
      >
        <table className="data-table w-full min-w-max text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`px-4 py-2.5 text-2xs font-semibold uppercase tracking-[0.08em] text-muted ${
                    column.numeric ? 'text-right' : 'text-left'
                  }`}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-soft">
            {rows.map((row) => (
              <tr key={rowKey(row)} className="transition-colors hover:bg-surface-2">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`px-4 py-3 align-middle text-ink ${
                      column.numeric ? 'text-right tabular-nums' : ''
                    }`}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
       * Cards below `md`. The same rows and the same `Column[]` — a second hand-written mobile
       * layout is how the two drift apart, so there is only one description of what a row contains.
       */}
      <ul className="space-y-2 md:hidden" aria-label={caption}>
        {rows.map((row) => (
          <li key={rowKey(row)} className="surface p-3.5">
            <div className="text-sm font-semibold text-ink">{heading.cell(row)}</div>
            <dl className="mt-2.5 grid grid-cols-[minmax(0,auto)_1fr] gap-x-4 gap-y-1.5">
              {rest.map((column) => (
                <div key={column.key} className="contents">
                  <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-soft">
                    {column.header}
                  </dt>
                  <dd className={`text-sm text-ink ${column.numeric ? 'tabular-nums' : ''}`}>
                    {column.cell(row)}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Pagination({ meta, onPage }: { meta: PageMeta; onPage: (page: number) => void }) {
  if (meta.totalPages <= 1) return null;

  const from = (meta.page - 1) * meta.limit + 1;
  const to = Math.min(meta.page * meta.limit, meta.total);

  return (
    <nav
      aria-label="Pagination"
      className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"
    >
      {/* Which rows these are, not just which page — the question a reader actually has. */}
      <p aria-live="polite" className="text-muted">
        <span className="font-medium text-ink tabular-nums">
          {from}–{to}
        </span>{' '}
        of <span className="tabular-nums">{meta.total}</span>
      </p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPage(meta.page - 1)}
          disabled={!meta.hasPreviousPage}
          className="btn btn-secondary btn-sm"
        >
          <Icon name="chevron-left" size={15} />
          Previous
        </button>
        <span className="px-1 text-xs text-muted tabular-nums">
          {meta.page} / {meta.totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPage(meta.page + 1)}
          disabled={!meta.hasNextPage}
          className="btn btn-secondary btn-sm"
        >
          Next
          <Icon name="chevron-right" size={15} />
        </button>
      </div>
    </nav>
  );
}

/* ─────────────────────────────── page chrome ─────────────────────────────── */

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}

/*
 * `SearchInput` used to live here.
 *
 * It was a near-copy of `SearchField` in `components/form.tsx` — same props, same magnifier, same
 * clear button, and the same defeated `pl-9`. Two components for one control is how the two drift
 * apart, so the one search box in the product is now the one in the form layer, beside the fields it
 * sits next to. See `SearchField`.
 */

/* ─────────────────────────────── status ─────────────────────────────── */

const GOOD = [
  'active', 'approved', 'paid', 'completed', 'present', 'succeeded', 'published',
  'accepted', 'graduated', 'promoted', 'returned', 'read', 'pass', 'reviewed',
];
const ATTENTION = [
  'pending', 'pending_review', 'unpaid', 'partially_paid', 'overdue', 'past_due',
  'expiring', 'grace_period', 'trial', 'late', 'processing', 'ongoing', 'marks_entry',
  'scheduled', 'upcoming', 'issued', 'submitted', 'sent', 'initiated',
];
const BAD = ['rejected', 'failed', 'suspended', 'absent', 'lost', 'fail'];
const ENDED = [
  'archived', 'cancelled', 'expired', 'inactive', 'refunded', 'partially_refunded',
  'paused', 'draft', 'closed', 'left', 'transferred', 'waived', 'leave',
];

export type StatusTone = 'good' | 'attention' | 'bad' | 'ended' | 'neutral';

const TONE_CLASSES: Record<StatusTone, { pill: string; dot: string }> = {
  good: { pill: 'border-success/25 bg-success-soft text-success', dot: 'bg-success' },
  attention: { pill: 'border-warn/25 bg-warn-soft text-warn', dot: 'bg-warn' },
  bad: { pill: 'border-danger/25 bg-danger-soft text-danger', dot: 'bg-danger' },
  ended: { pill: 'border-border bg-surface-2 text-muted', dot: 'bg-muted-soft' },
  neutral: { pill: 'border-border bg-surface-2 text-ink-soft', dot: 'bg-muted' },
};

/**
 * A status word, its tone, and a dot.
 *
 * The dot is not decoration: it carries the tone at a glance for anyone scanning a column, and it
 * means the badge still reads correctly in greyscale, where four tinted pills look identical.
 *
 * `tone` overrides the shared map for a word that means different things in different places: a
 * `returned` library book is good news, a `returned` assignment has been sent back to be redone; a
 * `sent` e-mail was delivered, a `sent` quotation is waiting on an answer. The map keeps one default
 * per word, and the screen that knows which meaning it has says so.
 */
export function StatusBadge({ status, tone: override }: { status: string; tone?: StatusTone }) {
  const inferred: StatusTone = GOOD.includes(status)
    ? 'good'
    : ATTENTION.includes(status)
      ? 'attention'
      : BAD.includes(status)
        ? 'bad'
        : ENDED.includes(status)
          ? 'ended'
          : 'neutral';
  const tone = TONE_CLASSES[override ?? inferred];

  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${tone.pill}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: IconName;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-2">
        <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">{label}</dt>
        {icon ? <Icon name={icon} size={15} className="text-muted-soft" /> : null}
      </div>
      <dd className="mt-2 font-display text-2xl font-semibold tabular-nums tracking-tight text-ink">
        {value}
      </dd>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p> : null}
    </div>
  );
}
