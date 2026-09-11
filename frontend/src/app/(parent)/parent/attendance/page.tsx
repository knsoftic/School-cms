'use client';

/**
 * A child's attendance — SRS §16, FR-ATT-002's daily, monthly and yearly figures, and FR-PARENT-001's
 * "Parent can access records for all linked children". Read-only.
 *
 * ## The endpoint, and why it is the school's own report
 *
 * `GET /attendance/mine` is the owner's decision D17: `attendance.self.view`, granted to a parent from
 * the start and mounted nowhere until then. `attendance.service.js mine()` confines it to the caller's
 * linked children through `services/selfScope.js` and, for each, runs the same `report()` the school's
 * Attendance screen runs — so the percentage a parent reads is the school's own figure for that child —
 * with the register day by day beside it.
 *
 * ## One child at a time
 *
 * `student_id` narrows the answer to the child `childSelect.tsx` shows, and the request waits for the
 * child list so the first one sent is already narrowed. If that list cannot be read the request goes
 * without it, and every linked child's block comes back, each headed with the child's name — the
 * server's narrowing does not depend on the picker, only the choice does.
 *
 * ## Monthly, anchored on the viewer's today
 *
 * As on the student's screen: monthly is where the endpoint and the school report both start, and the
 * anchor is the viewer's calendar day rather than the validator's UTC default.
 */

import { useMemo, useState } from 'react';

import { api } from '@/lib/apiClient';
import { localDay } from '@/lib/instants';
import { useResource } from '@/lib/useCollection';
import { FilterBar, FilterDate, FilterSelect } from '@/components/form';
import { EmptyNotice, ErrorNotice, LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';

import { ChildSelect, useChildChoice } from '../childSelect';
import { AttendanceSummary, PERIODS, StudentHeading, formatDay, nameOf, periodTitle } from '@/components/selfRecords';
import type { MyAttendance } from '@/components/selfRecords';

export default function ParentAttendance() {
  const choice = useChildChoice();
  const listLoading = choice.dashboard.loading;
  const chosenId = choice.chosen?.id ?? null;

  const [period, setPeriod] = useState<string>('monthly');
  const [date, setDate] = useState(() => localDay(new Date()) ?? '');

  const load = useMemo(
    () =>
      listLoading || !date
        ? null
        : (signal: AbortSignal) =>
            api.get<{ attendance: MyAttendance }>('/attendance/mine', {
              query: { period, date, student_id: chosenId ?? undefined },
              signal,
            }),
    [listLoading, period, date, chosenId]
  );
  const { data, loading, error, refusal, reload } = useResource(load);
  const attendance = data?.attendance ?? null;
  const blocks = attendance?.students ?? [];

  return (
    <div>
      <PageHeader
        title="Attendance"
        description="Your child’s school register for a day, a month or a year."
      />

      <FilterBar>
        <ChildSelect id="attendance-child" choice={choice} />
        <FilterSelect id="attendance-period" label="Period" labelVisible value={period} onChange={setPeriod}>
          {PERIODS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </FilterSelect>
        <FilterDate
          id="attendance-date"
          label={period === 'daily' ? 'Day' : period === 'monthly' ? 'Any day in the month' : 'Any day in the year'}
          value={date}
          onChange={setDate}
        />
      </FilterBar>

      {listLoading ? (
        <LoadingBlock rows={3} />
      ) : !date ? (
        <EmptyNotice icon="calendar">Choose a day — any day inside the period will do.</EmptyNotice>
      ) : refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && !attendance ? (
        <LoadingBlock rows={3} />
      ) : !attendance || blocks.length === 0 ? (
        <EmptyNotice>
          No children are linked to your account yet. The school office links a parent to a student.
        </EmptyNotice>
      ) : (
        <section
          aria-labelledby="attendance-heading"
          aria-busy={loading || undefined}
          className={`transition-opacity duration-200 ${loading ? 'opacity-60' : ''}`}
        >
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="attendance-heading" className="text-base font-semibold tracking-tight text-ink">
              {periodTitle(attendance)}
            </h2>
            <p className="text-sm text-muted">
              {formatDay(attendance.from)}
              {attendance.to !== attendance.from ? ` to ${formatDay(attendance.to)}` : ''} · only days the
              register was marked are listed
            </p>
          </div>

          <div className="space-y-8">
            {blocks.map((block) => (
              <div key={block.student.id}>
                <StudentHeading student={block.student} level={3} />
                <AttendanceSummary block={block} caption={`${nameOf(block.student)}’s attendance, day by day`} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
