'use client';

/**
 * The notification centre — SRS §23, FR-NOTIF-001, and three write routes with no caller.
 *
 * `POST /notifications/:id/read`, `POST /notifications/read-all` and `POST /notifications/:id/retry`.
 * §23's engine has been writing `notifications` rows since it was built — nine types, eight sweeps —
 * and **nothing in the product read them**. Every in-app notification the system has ever raised was
 * delivered to a table nobody could open.
 *
 * ## Why this is not filed under "needs a decision"
 *
 * `docs/VERIFICATION.md` put it there because §33 lists no notification centre. That is true of the
 * screen list and not of the requirement: FR-NOTIF-001 is `Completed` and its `in_app` channel is
 * defined as *the delivery itself* — an in-app row is born `sent`, and reading it is the whole of
 * what a recipient does with it. A delivery channel whose recipient cannot see the delivery is not a
 * channel. Reached from the dashboard rather than the sidebar, for the reason school settings gives:
 * §33 fixes the School nav at seventeen and the suite asserts the count.
 *
 * ## Scoped by user, never by tenant
 *
 * `notifications.school_id` is **nullable**, and §29 says a null one is a platform notification. So
 * `tenantWhere()` is deliberately not applied by the service; every read is scoped by `user_id`,
 * which is narrower than any tenant filter. Nothing on this screen sends a `school_id`, and there is
 * no "everyone's notifications" view to build — the endpoint does not offer one.
 *
 * ## Retry is for e-mail, and it is a different permission
 *
 * An `in_app` row **is** the delivery; there is nothing to retry. An `email` row is an *attempt*, and
 * a failed one is the only thing a retry can repair. `notifications.send` guards it — a separate key
 * from `notifications.view`, seeded narrowly — so the button appears only on a failed e-mail row and
 * only for an account holding it.
 */

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { FilterBar, FilterSelect, Notice } from '@/components/form';
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
import { useToast } from '@/components/toast';

/** One `notifications` row. */
interface NotificationRow {
  id: number;
  type: string;
  channel: string;
  title: string;
  message: string | null;
  action_url: string | null;
  status: string;
  sent_at: string | null;
  read_at: string | null;
  error_message: string | null;
  created_at: string;
}

const spell = (value: string) => value.replace(/_/g, ' ');

export default function NotificationsPage() {
  const { can } = useAuth();
  const { success } = useToast();

  const [page, setPage] = useState(1);
  const [unread, setUnread] = useState('');
  const [channel, setChannel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(
    () => ({
      page,
      limit: 25,
      /* `unread` is a Joi boolean; `Query` carries strings, and `convert: true` reads it. */
      unread: unread === '' ? undefined : unread,
      channel: channel || undefined,
    }),
    [page, unread, channel]
  );

  const { rows, meta, loading, error: loadError, refusal, reload } =
    useCollection<NotificationRow>('/notifications', query);

  const canRetry = can('notifications.send');

  /*
   * `useCallback`, because these two are captured by the `useMemo` that builds the columns.
   *
   * Without it the memo closes over whichever version existed when its own dependencies last
   * changed, and stays correct only by accident of what the function happens to read — `busy` here,
   * which is in the dependency list for other reasons. `react-hooks/exhaustive-deps` is what named
   * it, on the first ESLint run this frontend has ever had. Making the handler stable turns "safe
   * because of what it reads today" into "safe because of how it is built".
   */
  const markRead = useCallback(async (row: NotificationRow) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/notifications/${row.id}/read`, {});
      reload();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setBusy(false);
    }
  }, [busy, reload]);

  async function markAllRead() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/notifications/read-all', {});
      success('All marked as read');
      reload();
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

  const retry = useCallback(async (row: NotificationRow) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/notifications/${row.id}/retry`, {});
      success('Sending again', 'The row moves back to pending and the transport tries once more.');
      reload();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setBusy(false);
    }
  }, [busy, reload, success]);

  const columns = useMemo<Column<NotificationRow>[]>(
    () => [
      {
        key: 'title',
        header: 'Notification',
        cell: (row) => (
          <div>
            {/*
              * Unread is the whole point of the column, so it carries weight rather than a badge in
              * a separate column that would have to be scanned against this one.
              */}
            <span className={row.read_at ? 'text-muted' : 'font-semibold'}>{row.title}</span>
            {row.message ? (
              <span className="block max-w-lg truncate text-xs text-muted-soft">{row.message}</span>
            ) : null}
            <span className="block text-xs text-muted-soft">{spell(row.type)}</span>
          </div>
        ),
      },
      { key: 'channel', header: 'Channel', cell: (row) => spell(row.channel) },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => (
          <div>
            <StatusBadge status={row.status} />
            {/* The transport's own words, which is what a retry is deciding about. */}
            {row.error_message ? (
              <span className="block max-w-xs truncate text-xs text-danger">{row.error_message}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'when',
        header: 'Raised',
        cell: (row) => (
          <span className="whitespace-nowrap text-xs text-muted">
            {row.created_at.slice(0, 10)}
          </span>
        ),
      },
      {
        key: 'actions',
        header: 'Actions',
        cell: (row) => (
          <div className="flex flex-wrap gap-1">
            {/*
              * `action_url` is where the notification points. Rendered as an internal link only when
              * it is one: the column is free text on the model, and turning an arbitrary value into
              * an anchor is how a notification becomes a way to send somebody off-site.
              */}
            {row.action_url && row.action_url.startsWith('/') ? (
              <Link href={row.action_url} className="btn btn-sm btn-secondary">
                Open
              </Link>
            ) : null}
            {!row.read_at ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy}
                onClick={() => void markRead(row)}
              >
                Mark read
              </button>
            ) : null}
            {/* Only a failed e-mail can be retried — an in-app row *is* the delivery. */}
            {canRetry && row.channel === 'email' && row.status === 'failed' ? (
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={busy}
                onClick={() => void retry(row)}
              >
                Send again
              </button>
            ) : null}
          </div>
        ),
      },
    ],
    [busy, canRetry, markRead, retry]
  );

  const unreadCount = rows.filter((row) => !row.read_at).length;

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="What the system has raised for you — SRS §23. An in-app notification is delivered by being here."
        action={
          <div className="flex gap-2">
            <Link href="/school" className="btn btn-secondary">
              Back to dashboard
            </Link>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || unreadCount === 0}
              onClick={() => void markAllRead()}
            >
              Mark all read
            </button>
          </div>
        }
      />

      {error ? (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}

      <FilterBar
        activeCount={[unread, channel].filter(Boolean).length}
        onClear={() => {
          setUnread('');
          setChannel('');
          setPage(1);
        }}
      >
        <div>
          <FilterSelect
            id="notification-unread"
            label="Read"
            labelVisible
            value={unread}
            onChange={(value) => {
              setUnread(value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="true">Unread only</option>
          </FilterSelect>
        </div>
        <div>
          <FilterSelect
            id="notification-channel"
            label="Channel"
            labelVisible
            value={channel}
            onChange={(value) => {
              setChannel(value);
              setPage(1);
            }}
          >
            <option value="">All channels</option>
            <option value="in_app">In app</option>
            <option value="email">Email</option>
          </FilterSelect>
        </div>
      </FilterBar>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : loadError ? (
        <ErrorNotice message={loadError} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {unread || channel
            ? 'Nothing matches these filters.'
            : 'Nothing has been raised for you. §23 notifies about subscriptions, fees, exams, homework and attendance as those things happen.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption="Notifications"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
