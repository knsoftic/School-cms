'use client';

/**
 * Parent dashboard — SRS §15.2 (FR-PARENT-002), checklist row 4.6.
 *
 * ## §5 grants a parent exactly one thing
 *
 * *"Holds a Parent Account, may be linked to multiple children, and has access to a Parent
 * Dashboard."* That is the whole of it. No parent-facing list screens are named anywhere in the SRS,
 * and none exist in the API — `GET /parents/dashboard` and `GET /parents/{id}/children` are the only
 * two endpoints a parent's permissions reach.
 *
 * So this screen is the parent surface, not its landing page. That is the requirement rather than a
 * shortfall, and it is worth saying plainly: a fuller parent portal — attendance, fees, results per
 * child — would need self-service endpoints the SRS never asks for and the backend deliberately did
 * not mount. `attendance.self.view`, `fees.self.view` and `students.self.view` all exist in §29's
 * fixed permission catalogue with **no route behind them**, and each router records that decision in
 * its own header rather than leaving it to look like an oversight.
 */

import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

/** A parent–student link, with the student included by the service. */
interface ChildLink {
  id: number;
  student_id: number;
  relation: string | null;
  /**
   * `is_primary_guardian`, not `is_primary`.
   *
   * The column on `parent_students` is `is_primary_guardian` (`models/people.js`), and
   * `parents.service.js` writes exactly that name. This was declared and read as `is_primary`, which
   * is `undefined` on every row — so the "Primary contact" column answered **"no" for every child**,
   * including the one the school had recorded as the first to call.
   *
   * Worth naming the trap: `is_primary` *does* exist in `models/academic.js`, on a different table.
   * A grep for the bare name confirms the wrong thing.
   */
  is_primary_guardian: boolean;
  student?: {
    id: number;
    first_name: string;
    last_name: string | null;
    student_id: string | null;
    roll_number: string | null;
    status: string;
  };
}

interface ParentDashboard {
  parent: { id: number; name: string };
  counts: { children: number; activeChildren: number };
  children: ChildLink[];
}

export default function ParentDashboard() {
  const { profile } = useAuth();

  const [data, setData] = useState<ParentDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);

    (async () => {
      try {
        const result = await api.get<ParentDashboard>('/parents/dashboard', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(result);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          setError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [nonce]);

  const columns: Column<ChildLink>[] = [
    {
      key: 'name',
      header: 'Child',
      cell: (row) =>
        row.student ? (
          <span className="font-medium">
            {[row.student.first_name, row.student.last_name].filter(Boolean).join(' ')}
          </span>
        ) : (
          <span className="text-muted-soft">student #{row.student_id}</span>
        ),
    },
    {
      key: 'student_id',
      header: 'Student ID',
      cell: (row) => <code className="text-xs text-muted">{row.student?.student_id ?? '—'}</code>,
    },
    { key: 'roll', header: 'Roll', cell: (row) => row.student?.roll_number ?? <span className="text-muted-soft">—</span> },
    {
      key: 'relation',
      /*
       * Free text, not an ENUM — so plain text rather than a badge, for the same reason the school
       * Parents screen renders it plainly: a badge would imply a vocabulary the database does not
       * enforce.
       */
      header: 'Relation',
      cell: (row) => row.relation ?? <span className="text-muted-soft">—</span>,
    },
    {
      key: 'primary',
      header: 'Primary contact',
      /*
       * The flag decides who is contacted first, so it earns a column on the one screen a parent
       * sees. Rendered as words rather than a tick, which a screen reader announces as nothing.
       */
      cell: (row) => (row.is_primary_guardian ? 'yes' : <span className="text-muted-soft">no</span>),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (row.student ? <StatusBadge status={row.student.status} /> : <span className="text-muted-soft">—</span>),
    },
  ];

  return (
    <div>
      <PageHeader
        title={`Welcome, ${profile?.user.name ?? 'parent'}`}
        description="The children linked to your account."
      />

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={() => setNonce((n) => n + 1)} />
      ) : loading ? (
        <LoadingBlock />
      ) : !data ? null : data.children.length === 0 ? (
        /*
         * A parent account with no linked children is a normal state — the account is created before
         * the link (FR-PARENT-001 then FR-PARENT-003) — and the remedy is someone else's to apply, so
         * the message says who rather than offering an action this screen cannot take.
         */
        <EmptyNotice>
          No children are linked to your account yet. The school office links a parent to a student.
        </EmptyNotice>
      ) : (
        <>
          <dl className="mb-5 grid grid-cols-2 gap-3 sm:max-w-sm">
            <div className="rounded-md border border-border p-3">
              <dt className="text-xs text-muted">Children</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{data.counts.children}</dd>
            </div>
            <div className="rounded-md border border-border p-3">
              <dt className="text-xs text-muted">Currently enrolled</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{data.counts.activeChildren}</dd>
            </div>
          </dl>

          <DataTable columns={columns} rows={data.children} rowKey={(row) => row.id} caption="Your children"
            busy={loading}
          />

          {/*
            * Said once, plainly, rather than left as an absence the parent has to infer. §5 grants a
            * parent a dashboard and nothing else, so there is no attendance or fee view to link to —
            * and a parent looking for one should learn that here rather than by hunting.
            */}
          <p className="mt-4 text-xs text-muted-soft">
            Attendance, fees and results are held by the school office; this account shows the link
            between you and your children.
          </p>
        </>
      )}
    </div>
  );
}
