'use client';

/**
 * A child's fees — SRS §17 (Pending Fee, Partial Payment, Payment Receipt) and FR-PARENT-001's
 * "records for all linked children". Read-only.
 *
 * `GET /fees/mine` is the owner's decision D17: `fees.self.view` — the catalogue's own words are "View
 * own / child fees" — granted to a parent from the start and mounted nowhere until then.
 * `fees.service.js mine()` confines it to the caller's linked children through
 * `services/selfScope.js` and answers whole rather than paged, with every fee, every receipt against
 * them, and the pending total per currency.
 *
 * `student_id` narrows it to the child `childSelect.tsx` shows, once the child list has settled; if the
 * list cannot be read, every child's block comes back, each headed with the child's name. No `status`
 * or session filter is sent, for the student screen's reason: the outstanding total is summed over the
 * rows returned, so a status filter would make it read "0.00" under "Paid".
 */

import { useMemo } from 'react';

import { api } from '@/lib/apiClient';
import { useResource } from '@/lib/useCollection';
import { EmptyNotice, ErrorNotice, LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';

import { ChildSelect, useChildChoice } from '../childSelect';
import { FeesSummary, StudentHeading, nameOf } from '@/components/selfRecords';
import type { FeesBlock } from '@/components/selfRecords';

export default function ParentFees() {
  const choice = useChildChoice();
  const listLoading = choice.dashboard.loading;
  const chosenId = choice.chosen?.id ?? null;

  const load = useMemo(
    () =>
      listLoading
        ? null
        : (signal: AbortSignal) =>
            api.get<{ students: FeesBlock[] }>('/fees/mine', {
              query: { student_id: chosenId ?? undefined },
              signal,
            }),
    [listLoading, chosenId]
  );
  const { data, loading, error, refusal, reload } = useResource(load);
  const blocks = data?.students ?? [];

  return (
    <div>
      <PageHeader
        title="Fees"
        description="What the school has charged your child, what has been paid, and what is still pending."
      />

      {choice.children.length > 1 ? (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
          <ChildSelect id="fees-child" choice={choice} />
        </div>
      ) : null}

      {listLoading ? (
        <LoadingBlock rows={4} />
      ) : refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && !data ? (
        <LoadingBlock rows={4} />
      ) : blocks.length === 0 ? (
        <EmptyNotice>
          No children are linked to your account yet. The school office links a parent to a student.
        </EmptyNotice>
      ) : (
        <div
          aria-busy={loading || undefined}
          className={`space-y-10 transition-opacity duration-200 ${loading ? 'opacity-60' : ''}`}
        >
          {blocks.map((block) => (
            <div key={block.student.id}>
              <StudentHeading student={block.student} />
              <FeesSummary block={block} who={nameOf(block.student)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
