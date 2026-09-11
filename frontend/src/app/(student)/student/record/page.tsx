'use client';

/**
 * My record — SRS §15.1's Student Profile, for the student it describes. Read-only.
 *
 * `GET /students/mine` is the owner's decision D17: `students.self.view` ("View own student record"),
 * granted to a student from the start and mounted nowhere until then. `students.service.js mine()`
 * sends the record through a named attribute list (`SELF_ATTRIBUTES`) rather than the staff row, so the
 * office's working notes — `notes`, `metadata`, `leaving_reason` — never reach it, and through
 * `present()`, so the stored photo path becomes `has_photo`.
 *
 * Nothing here is editable, and nothing offers to be: every write to a student is `students.manage` or
 * `students.progression` (`students.routes.js`), and only school staff hold either. The footnote says
 * who corrects a record instead.
 */

import { useCallback } from 'react';

import { api } from '@/lib/apiClient';
import { useResource } from '@/lib/useCollection';
import { EmptyNotice, ErrorNotice, LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';

import { RecordView, StudentHeading } from '@/components/selfRecords';
import type { SelfRecord } from '@/components/selfRecords';

export default function StudentRecord() {
  const load = useCallback(
    (signal: AbortSignal) => api.get<{ students: SelfRecord[] }>('/students/mine', { signal }),
    []
  );
  const { data, loading, error, refusal, reload } = useResource(load);
  const records = data?.students ?? [];

  return (
    <div>
      <PageHeader title="My record" description="What your school holds on file about you." />

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading ? (
        <LoadingBlock rows={6} />
      ) : records.length === 0 ? (
        <EmptyNotice>There is no student record on this account.</EmptyNotice>
      ) : (
        <>
          <div className="space-y-10">
            {records.map((record) => (
              <div key={record.id}>
                {/* One record for a student; more only for an account that is also a parent — see `components/selfRecords.tsx`. */}
                {records.length > 1 ? <StudentHeading student={record} /> : null}
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
