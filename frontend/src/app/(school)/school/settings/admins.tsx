'use client';

/**
 * The school's School Admin logins — the owner's decisions D1 and D2.
 *
 * A School Admin has no profile table (teachers, staff and students each do), so there is no list
 * where "Create login" could sit beside the person; this panel is that place. It lists the accounts
 * with the `school_admin` role through the ordinary Users read (`users.view`, scoped to this school by
 * the server) and adds one through `POST /users` (`users.manage`).
 *
 * Adding one is capped by the plan's Admin Limit (D2), which counts Principals and School Admins
 * together — the SRS hierarchy's "Principals/Admins" tier. A school at its limit is refused with the
 * limit's own message, inside the dialog, rather than having the button guess in advance.
 */

import { useMemo, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { Notice } from '@/components/form';
import { CreateLoginDialog } from '@/components/createLogin';
import type { LoginTarget } from '@/components/createLogin';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

interface AdminRow {
  id: number;
  name: string;
  email: string;
  username: string;
  status: string;
}

export function SchoolAdminsPanel() {
  const { can } = useAuth();
  if (!can('users.view')) {
    return (
      <Notice tone="info">
        Seeing the school&apos;s administrator accounts needs the permission to view users, which this
        account does not hold.
      </Notice>
    );
  }
  return <AdminsList canAdd={can('users.manage')} />;
}

/* Split out so the list is only ever requested by an account that may read it. */
function AdminsList({ canAdd }: { canAdd: boolean }) {
  const [loginFor, setLoginFor] = useState<LoginTarget | null>(null);

  const query = useMemo(() => ({ role: 'school_admin', limit: 50 }), []);
  const { rows, loading, error, refusal, reload } = useCollection<AdminRow>('/users', query);

  const columns = useMemo<Column<AdminRow>[]>(
    () => [
      { key: 'name', header: 'Name', cell: (row) => <span className="font-medium">{row.name}</span> },
      { key: 'username', header: 'Username', cell: (row) => <code className="text-xs text-muted">{row.username}</code> },
      { key: 'email', header: 'Email', cell: (row) => row.email },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
    ],
    []
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-2xl text-sm leading-relaxed text-muted">
          School Admins run the school alongside the Principal. Each one counts towards your plan&apos;s
          Admin Limit together with the Principal, so a school at its limit is told so when it adds
          another. They sign in with a temporary password and choose their own at the first sign-in.
        </p>
        {canAdd ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setLoginFor({ role: 'school_admin', person: 'a new School Admin' })}
          >
            Add a School Admin
          </button>
        ) : null}
      </div>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>This school has no School Admin accounts yet.</EmptyNotice>
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="School Admins" busy={loading} />
      )}

      <CreateLoginDialog target={loginFor} onClose={() => setLoginFor(null)} onCreated={reload} />
    </div>
  );
}
