'use client';

/**
 * The notification inbox — SRS §23, FR-NOTIF-001 — shared by every surface that has one.
 *
 * `/school/notifications` was the only route, so a Super Admin had nowhere to read the platform
 * notifications the owner's decision D15 now sends them, and a student or parent — the recipients of
 * most of §23's types — reached it only by typing the address. One component, one route per surface:
 * the school's, the platform's, the student's and the parent's, each under its own shell.
 *
 * ## Scoped by user, never by tenant
 *
 * `notifications.school_id` is **nullable**, and §29 says a null one is a platform notification. So
 * every read is scoped by `user_id` on the server, which is narrower than any tenant filter; nothing
 * here sends a `school_id`, and there is no "everyone's notifications" view.
 *
 * ## "Open" goes to a screen that exists
 *
 * The engine writes an `action_url` naming the record — `/exams/12`, `/fees/payments/7` — and those
 * are API-shaped paths no screen answers. `destinationFor()` maps each onto the screen that shows that
 * kind of record on the viewer's own surface, and shows no "Open" at all where there is none, rather
 * than a link that 404s. Platform notifications are written with `/super-admin/…` paths and are used as
 * they are.
 *
 * ## Two channels, two different things
 *
 * An `in_app` row **is** the delivery and is what "read" means; an `email` row is a delivery attempt,
 * and only a failed one can be retried (on `notifications.send`, a separate key). So "Mark read" is an
 * inbox action and never offered on an e-mail row — marking one would end its retry for good — and the
 * Email view is where a failure is found, not a second inbox.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

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

export type InboxSurface = 'school' | 'platform' | 'student' | 'parent';

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
  created_at: string;
}

const HOME: Record<InboxSurface, string> = {
  school: '/school',
  platform: '/super-admin',
  student: '/student',
  parent: '/parent',
};

const spell = (value: string) => value.replace(/_/g, ' ');

/**
 * Where "Open" takes this viewer, or null when no screen on their surface shows that record.
 *
 * Only the school surface has screens for the records §23 is about; a student's and a parent's portal
 * is the dashboard. Every mapping is to a route that exists, and anything unrecognised gets no link.
 */
export function destinationFor(actionUrl: string | null, surface: InboxSurface): string | null {
  if (!actionUrl || !actionUrl.startsWith('/')) return null;
  if (actionUrl.startsWith('/super-admin/')) return surface === 'platform' ? actionUrl : null;
  if (surface === 'platform') return null;
  if (surface !== 'school') return HOME[surface];

  const exam = actionUrl.match(/^\/exams\/(\d+)$/);
  if (exam) return `/school/exams/${exam[1]}`;
  if (actionUrl.startsWith('/homework')) return '/school/homework';
  if (actionUrl.startsWith('/results')) return '/school/results';
  if (actionUrl.startsWith('/attendance')) return '/school/attendance';
  if (actionUrl.startsWith('/fees')) return '/school/fees';
  /* A school's subscription and its platform payments are shown on its dashboard. */
  if (actionUrl.startsWith('/subscriptions') || actionUrl.startsWith('/payments')) return '/school';
  return null;
}

export function NotificationsInbox({ surface }: { surface: InboxSurface }) {
  const { can } = useAuth();
  const { success } = useToast();

  const [page, setPage] = useState(1);
  const [unread, setUnread] = useState('');
  /* '' is the inbox — the server's own default is `in_app` — and 'email' is the delivery attempts. */
  const [channel, setChannel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEmail = channel === 'email';

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

  /*
   * The unread count across every page, not the rows on this one — the list's own `meta.unread` is not
   * carried by the client, so a one-row query for unread in-app rows is asked instead. Refreshed with
   * the list, so "Mark all read" is enabled exactly when there is something to mark.
   */
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [countVersion, setCountVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await api.page<NotificationRow[]>('/notifications', { query: { unread: 'true', limit: 1 } });
        if (!cancelled) setUnreadTotal(result.meta ? result.meta.total : 0);
      } catch {
        if (!cancelled) setUnreadTotal(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [countVersion, rows]);

  const refresh = useCallback(() => {
    reload();
    setCountVersion((n) => n + 1);
  }, [reload]);

  const canRetry = can('notifications.send');

  const run = useCallback(
    async (action: () => Promise<unknown>, done?: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await action();
        if (done) success(done);
        refresh();
      } catch (caught) {
        setError(
          caught instanceof ApiError ? caught.message : 'Could not reach the server. Check your connection and try again.'
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, success]
  );

  const columns = useMemo<Column<NotificationRow>[]>(
    () => [
      {
        key: 'title',
        header: 'Notification',
        cell: (row) => (
          <div>
            <span className={row.read_at || row.channel === 'email' ? 'text-muted' : 'font-semibold'}>
              {row.title}
            </span>
            {/* Two lines and the whole text on hover, so a long message is readable without a click. */}
            {row.message ? (
              <span className="block max-w-lg text-xs text-muted-soft line-clamp-2" title={row.message}>
                {row.message}
              </span>
            ) : null}
            <span className="block text-xs text-muted-soft">{spell(row.type)}</span>
          </div>
        ),
      },
      { key: 'channel', header: 'Channel', cell: (row) => (row.channel === 'in_app' ? 'In app' : 'Email') },
      {
        key: 'status',
        header: 'Status',
        /* A `sent` notification was delivered — good news here, whatever `sent` means on a quotation. */
        cell: (row) => <StatusBadge status={row.status} tone={row.status === 'sent' ? 'good' : undefined} />,
      },
      {
        key: 'when',
        header: 'Raised',
        /* In the viewer's own zone — slicing the ISO string showed the UTC day. */
        cell: (row) => (
          <span className="whitespace-nowrap text-xs text-muted">{new Date(row.created_at).toLocaleString()}</span>
        ),
      },
      {
        key: 'actions',
        header: 'Actions',
        cell: (row) => {
          const href = destinationFor(row.action_url, surface);
          return (
            <div className="flex flex-wrap gap-1">
              {href ? (
                <Link href={href} className="btn btn-sm btn-secondary">
                  Open
                </Link>
              ) : null}
              {row.channel === 'in_app' && !row.read_at ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy}
                  onClick={() => void run(() => api.post(`/notifications/${row.id}/read`, {}))}
                >
                  Mark read
                </button>
              ) : null}
              {canRetry && row.channel === 'email' && row.status === 'failed' ? (
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.post(`/notifications/${row.id}/retry`, {}), 'Sending again')
                  }
                >
                  Send again
                </button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [busy, canRetry, run, surface]
  );

  return (
    <div>
      <PageHeader
        title="Notifications"
        description={
          isEmail
            ? 'The e-mail copies of your notifications. A failed one can be sent again.'
            : 'What the system has raised for you. An in-app notification is delivered by being here.'
        }
        action={
          <div className="flex gap-2">
            <Link href={HOME[surface]} className="btn btn-secondary">
              Back to dashboard
            </Link>
            {!isEmail ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || unreadTotal === 0}
                onClick={() => void run(() => api.post('/notifications/read-all', {}), 'All marked as read')}
              >
                Mark all read{unreadTotal > 0 ? ` (${unreadTotal})` : ''}
              </button>
            ) : null}
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
            label="Show"
            labelVisible
            value={channel}
            onChange={(value) => {
              setChannel(value);
              setPage(1);
            }}
          >
            <option value="">Inbox (in app)</option>
            <option value="email">Email deliveries</option>
          </FilterSelect>
        </div>
      </FilterBar>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : loadError ? (
        <ErrorNotice message={loadError} onRetry={refresh} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {unread || channel ? 'Nothing matches these filters.' : 'Nothing has been raised for you yet.'}
        </EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Notifications" busy={loading} />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}
    </div>
  );
}
