'use client';

/**
 * My attendance — SRS §16, FR-ATT-002's daily, monthly and yearly figures for the student they are
 * about. Read-only.
 *
 * ## The endpoint, and why it is the school's own report
 *
 * `GET /attendance/mine` is the owner's decision D17: `attendance.self.view`, which the catalogue
 * granted a student from the start and nothing mounted. `attendance.service.js mine()` confines it to
 * the caller through `services/selfScope.js` and, for each student, runs the same `report()` the
 * school's Attendance screen runs — so the percentage here is the school's percentage for this child,
 * not a second definition that could disagree with it — and lists the register day by day beside it.
 *
 * No class, section or student is sent. Whose attendance this is, is the caller's identity: the service
 * lets a student narrow only to themselves and a parent to one of their children
 * (`attendance.service.js` `mine()`), and a student reading their own has nothing to narrow.
 *
 * ## Monthly, anchored on the viewer's today
 *
 * Monthly is where the endpoint's own default and the school's report both start: one student's day
 * is a single mark, and the month is the first period worth a percentage. The anchor is the viewer's
 * calendar day (`localDay`), not the server's: the validator's default is the server's UTC date, which
 * east of Greenwich reads yesterday until the small hours. Any day in the period names the period.
 */

import { useMemo, useState } from 'react';

import { api } from '@/lib/apiClient';
import { localDay } from '@/lib/instants';
import { useResource } from '@/lib/useCollection';
import { FilterBar, FilterDate, FilterSelect } from '@/components/form';
import { EmptyNotice, ErrorNotice, LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';

import { AttendanceSummary, PERIODS, StudentHeading, formatDay, nameOf, periodTitle } from '@/components/selfRecords';
import type { MyAttendance } from '@/components/selfRecords';

export default function StudentAttendance() {
  const [period, setPeriod] = useState<string>('monthly');
  const [date, setDate] = useState(() => localDay(new Date()) ?? '');

  /* A cleared date box asks for a day rather than silently falling back to the server's today. */
  const load = useMemo(
    () =>
      date
        ? (signal: AbortSignal) =>
            api.get<{ attendance: MyAttendance }>('/attendance/mine', { query: { period, date }, signal })
        : null,
    [period, date]
  );
  const { data, loading, error, refusal, reload } = useResource(load);
  const attendance = data?.attendance ?? null;
  const blocks = attendance?.students ?? [];

  return (
    <div>
      <PageHeader title="My attendance" description="Your school register for a day, a month or a year." />

      <FilterBar>
        <FilterSelect id="attendance-period" label="Period" labelVisible value={period} onChange={setPeriod}>
          {PERIODS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </FilterSelect>
        {/* The label says the day only anchors the period, for the school report's reason. */}
        <FilterDate
          id="attendance-date"
          label={period === 'daily' ? 'Day' : period === 'monthly' ? 'Any day in the month' : 'Any day in the year'}
          value={date}
          onChange={setDate}
        />
      </FilterBar>

      {!date ? (
        <EmptyNotice icon="calendar">Choose a day — any day inside the period will do.</EmptyNotice>
      ) : refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && !attendance ? (
        <LoadingBlock rows={3} />
      ) : !attendance || blocks.length === 0 ? (
        <EmptyNotice>There is no student record on this account to show attendance for.</EmptyNotice>
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
                {/* One block for a student; more only for an account that is also a parent — see `components/selfRecords.tsx`. */}
                {blocks.length > 1 ? <StudentHeading student={block.student} level={3} /> : null}
                <AttendanceSummary
                  block={block}
                  caption={
                    blocks.length > 1
                      ? `${nameOf(block.student)}’s attendance, day by day`
                      : 'Your attendance, day by day'
                  }
                />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
