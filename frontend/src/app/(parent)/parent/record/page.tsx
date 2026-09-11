'use client';

/**
 * A child's record — SRS §15.1's Student Profile, and FR-PARENT-001's "records for all linked
 * children". Read-only.
 *
 * `GET /students/mine` is the owner's decision D17: `students.self.view`, granted to a parent from the
 * start and mounted nowhere until then. For a parent it returns every linked child's record
 * (`services/selfScope.js`), each through `students.service.js SELF_ATTRIBUTES` — the record without
 * the office's working notes — and `present()`, which turns the stored photo path into `has_photo`.
 *
 * ## The choice is made here, not by the server
 *
 * Unlike attendance and fees, this endpoint takes no `student_id` — `students.validation.js mineQuery`
 * is an empty object — so the whole family arrives at once and `childSelect.tsx`'s choice picks the
 * record to show. If the child list cannot be read, every record is shown, each under its child's name.
 */

import { useCallback } from 'react';

import { api } from '@/lib/apiClient';
import { useResource } from '@/lib/useCollection';
import { EmptyNotice, ErrorNotice, LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';

import { ChildSelect, useChildChoice } from '../childSelect';
import { RecordView, StudentHeading } from '@/components/selfRecords';
import type { SelfRecord } from '@/components/selfRecords';

export default function ParentRecord() {
  const choice = useChildChoice();
  const { chosen } = choice;

  const load = useCallback(
    (signal: AbortSignal) => api.get<{ students: SelfRecord[] }>('/students/mine', { signal }),
    []
  );
  const { data, loading, error, refusal, reload } = useResource(load);
  const records = data?.students ?? [];
  /* The dashboard and this endpoint read the same links, so the chosen child is always among them. */
  const shown = chosen && records.some((record) => record.id === chosen.id)
    ? records.filter((record) => record.id === chosen.id)
    : records;

  return (
    <div>
      <PageHeader title="Student record" description="What the school holds on file about your child." />

      {choice.children.length > 1 ? (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
          <ChildSelect id="record-child" choice={choice} />
        </div>
      ) : null}

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading || choice.dashboard.loading ? (
        <LoadingBlock rows={6} />
      ) : shown.length === 0 ? (
        <EmptyNotice>
          No children are linked to your account yet. The school office links a parent to a student.
        </EmptyNotice>
      ) : (
        <>
          <div className="space-y-10">
            {shown.map((record) => (
              <div key={record.id}>
                <StudentHeading student={record} />
                <RecordView record={record} />
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-soft">
            If anything here is wrong or out of date, the school office can correct it.
          </p>
        </>
      )}
    </div>
  );
}
