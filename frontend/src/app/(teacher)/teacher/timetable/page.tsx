'use client';

/**
 * My timetable — SRS §20.1's Teacher Timetable, for the teacher it describes. Read-only: the owner's
 * decision D14 confirmed that a teacher views the timetable and does not edit it.
 *
 * ## Why a teacher had no way to their own week
 *
 * `GET /timetable/teacher/:teacherId` is mounted on `timetable.view`, which the `teacher` block grants.
 * The school Timetable screen does call it — from its Teacher tab — but offers that tab only to a caller
 * holding `teachers.view`, because choosing *whose* week needs the teacher list, and a teacher does not
 * hold it. So a teacher could open the whole school's register and every class's grid, and not their
 * own week.
 *
 * Nothing needs choosing here. The id comes from `GET /teachers/dashboard`, which resolves the teacher
 * from the signed-in account (`teachers.service.js dashboard()`), and a teacher account with no teacher
 * record is refused there with `TEACHER_PROFILE_MISSING`, an explained code.
 *
 * ## Only periods that are running
 *
 * `is_active=true` is sent, for the student timetable's reason: the school's grid shows retired entries
 * because a retired row still holds its slot, which matters to whoever schedules; a teacher reading
 * their week would take one for a lesson they still have to give.
 *
 * ## The grid
 *
 * The school screen's `WeekGrid`, asked the teacher's question: each slot names the class and section
 * rather than the teacher. Written out here because no route imports another route group's files; the
 * grid belongs in `components/` once it is extracted, with the student and parent copies.
 */

import { useCallback, useMemo } from 'react';

import { api } from '@/lib/apiClient';
import { useResource } from '@/lib/useCollection';
import { EmptyNotice, ErrorNotice, LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';

/** The one field of `GET /teachers/dashboard` this screen needs: whose week to ask for. */
interface TeacherSelf {
  teacher: { id: number };
}

/**
 * One `timetables` row with the four associations `timetable.service.js INCLUDES` joins. The teacher
 * is this teacher, so it is not declared; three foreign keys are nullable and the joins are LEFT JOINs.
 */
interface TeachingSlot {
  id: number;
  class_id: number;
  day_of_week: string;
  period_number: number;
  period_label: string | null;
  /** `TIME`, always read back as `HH:MM:SS`. */
  start_time: string;
  end_time: string;
  room: string | null;
  is_break: boolean;
  class: { id: number; name: string } | null;
  section: { id: number; name: string } | null;
  subject: { id: number; name: string; code: string | null } | null;
}

/** `GET /timetable/teacher/:teacherId` answers `{ timetable: { teacher, entries } }`. */
interface TeacherTimetable {
  entries: TeachingSlot[];
}

/** The `day_of_week` ENUM in its declared order, which is the order MySQL sorts it in. */
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** `HH:MM:SS` → `HH:MM`; anything else (a `TIME` can exceed 24 hours) is shown whole. */
function clock(value: string): string {
  return /^\d{2}:\d{2}:\d{2}$/.test(value) ? value.slice(0, 5) : value;
}

function dayLabel(day: string): string {
  return day.charAt(0).toUpperCase() + day.slice(1);
}

/** The subject, then where — class and section — then the clock and the room. */
function Slot({ entry }: { entry: TeachingSlot }) {
  return (
    <div>
      <p className="font-medium text-ink">
        {entry.is_break ? (
          <span className="text-muted">Break</span>
        ) : entry.subject ? (
          entry.subject.name
        ) : (
          <span className="text-muted-soft">No subject</span>
        )}
        {entry.period_label ? <span className="font-normal text-muted"> · {entry.period_label}</span> : null}
      </p>
      <p className="text-xs text-muted">
        {entry.class ? entry.class.name : `class #${entry.class_id}`} ·{' '}
        {entry.section ? entry.section.name : 'all sections'}
      </p>
      <p className="text-xs tabular-nums text-muted-soft">
        {clock(entry.start_time)}–{clock(entry.end_time)}
        {entry.room ? ` · ${entry.room}` : ''}
      </p>
    </div>
  );
}

/**
 * Days × periods, from the week itself: only days that hold an entry get a column, the rows are the
 * period numbers that appear, and a blank cell is a free period. One card per day below `md`.
 */
function WeekGrid({ entries, caption }: { entries: TeachingSlot[]; caption: string }) {
  const days = WEEKDAYS.filter((day) => entries.some((entry) => entry.day_of_week === day));
  const periods = [...new Set(entries.map((entry) => entry.period_number))].sort((a, b) => a - b);
  /* A teacher is in one place per period — FR-TT-002's teacher conflict — so a slot normally holds one. */
  const slots = new Map<string, TeachingSlot[]>();
  for (const entry of entries) {
    const key = `${entry.day_of_week}|${entry.period_number}`;
    slots.set(key, [...(slots.get(key) ?? []), entry]);
  }
  const slot = (day: string, period: number) => slots.get(`${day}|${period}`) ?? [];

  return (
    <>
      <div className="table-scroll surface hidden md:block" tabIndex={0} role="region" aria-label={caption}>
        <table className="data-table w-full min-w-max text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
                Period
              </th>
              {days.map((day) => (
                <th
                  key={day}
                  scope="col"
                  className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-muted"
                >
                  {dayLabel(day)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-soft">
            {periods.map((period) => (
              <tr key={period}>
                <th scope="row" className="px-4 py-3 text-left align-top font-semibold tabular-nums text-ink">
                  {period}
                </th>
                {days.map((day) => (
                  <td key={day} className="px-4 py-3 align-top">
                    <div className="max-w-56">
                      {slot(day, period).length === 0 ? (
                        <>
                          <span aria-hidden className="text-muted-soft">—</span>
                          <span className="sr-only">Free period</span>
                        </>
                      ) : (
                        <ul className="space-y-2.5">
                          {slot(day, period).map((entry) => (
                            <li key={entry.id}>
                              <Slot entry={entry} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden" aria-label={caption}>
        {days.map((day) => (
          <li key={day} className="surface p-3.5">
            <p className="text-sm font-semibold text-ink">{dayLabel(day)}</p>
            <ol className="mt-2.5 space-y-2.5">
              {periods
                .filter((period) => slot(day, period).length > 0)
                .map((period) => (
                  <li key={period} className="flex gap-3">
                    <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-soft">
                      <span className="sr-only">Period </span>
                      {period}
                    </span>
                    <ul className="min-w-0 flex-1 space-y-2">
                      {slot(day, period).map((entry) => (
                        <li key={entry.id}>
                          <Slot entry={entry} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
            </ol>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function TeacherTimetable() {
  const loadSelf = useCallback(
    (signal: AbortSignal) => api.get<TeacherSelf>('/teachers/dashboard', { signal }),
    []
  );
  const self = useResource(loadSelf);
  const teacherId = self.data?.teacher?.id ?? null;

  const loadWeek = useMemo(
    () =>
      teacherId === null
        ? null
        : (signal: AbortSignal) =>
            api.get<{ timetable: TeacherTimetable }>(`/timetable/teacher/${teacherId}`, {
              query: { is_active: true },
              signal,
            }),
    [teacherId]
  );
  const week = useResource(loadWeek);
  const entries = week.data?.timetable?.entries ?? [];

  return (
    <div>
      <PageHeader title="My timetable" description="Where you teach each day, period by period." />

      {self.refusal ? (
        <RefusalNotice refusal={self.refusal} />
      ) : self.error ? (
        <ErrorNotice message={self.error} onRetry={self.reload} />
      ) : self.loading || teacherId === null ? (
        <LoadingBlock label="Loading your week…" />
      ) : week.refusal ? (
        <RefusalNotice refusal={week.refusal} />
      ) : week.error ? (
        <ErrorNotice message={week.error} onRetry={week.reload} />
      ) : week.loading ? (
        <LoadingBlock label="Loading your week…" />
      ) : entries.length === 0 ? (
        <EmptyNotice icon="calendar">
          No periods are scheduled for you yet. The school office builds the timetable.
        </EmptyNotice>
      ) : (
        <WeekGrid entries={entries} caption="Your teaching week" />
      )}
    </div>
  );
}
