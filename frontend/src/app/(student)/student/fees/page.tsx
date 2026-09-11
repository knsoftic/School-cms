'use client';

/**
 * My fees — SRS §17 (Pending Fee, Partial Payment, Payment Receipt) for the student they are charged
 * to. Read-only.
 *
 * `GET /fees/mine` is the owner's decision D17: `fees.self.view` ("View own / child fees"), granted to
 * a student from the start and mounted nowhere until then. `fees.service.js mine()` confines it to the
 * caller through `services/selfScope.js` and answers whole rather than paged — one student's fees are a
 * handful of rows, not a ledger — with every fee, every receipt against them, and the pending total per
 * currency.
 *
 * ## No filter, deliberately
 *
 * The endpoint takes a `status` and an `academic_session_id`, and this screen sends neither. The
 * outstanding total is summed over whichever fees the query returns, so a status filter would make it
 * read "0.00" under "Paid" — true of the rows and false of the family. And a student holds no
 * `sessions.view`, so a session control could only offer bare ids.
 */

import { useCallback } from 'react';

import { api } from '@/lib/apiClient';
import { useResource } from '@/lib/useCollection';
import { EmptyNotice, ErrorNotice, LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';

import { FeesSummary, StudentHeading, nameOf } from '@/components/selfRecords';
import type { FeesBlock } from '@/components/selfRecords';

export default function StudentFees() {
  const load = useCallback(
    (signal: AbortSignal) => api.get<{ students: FeesBlock[] }>('/fees/mine', { signal }),
    []
  );
  const { data, loading, error, refusal, reload } = useResource(load);
  const blocks = data?.students ?? [];

  return (
    <div>
      <PageHeader
        title="My fees"
        description="What the school has charged you, what has been paid, and what is still pending."
      />

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading ? (
        <LoadingBlock rows={4} />
      ) : blocks.length === 0 ? (
        <EmptyNotice>There is no student record on this account to show fees for.</EmptyNotice>
      ) : (
        <div className="space-y-10">
          {blocks.map((block) => (
            <div key={block.student.id}>
              {/* One block for a student; more only for an account that is also a parent — see `components/selfRecords.tsx`. */}
              {blocks.length > 1 ? <StudentHeading student={block.student} /> : null}
              <FeesSummary block={block} who={blocks.length > 1 ? nameOf(block.student) : 'you'} headed={blocks.length > 1} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
