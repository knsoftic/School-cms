'use client';

/**
 * My timetable — SRS §20.1's Class Timetable, for the class the student sits in. Read-only.
 *
 * ## Two requests, because the week is the class's and the class is on the record
 *
 * There is no `timetable.self.view` (`timetable.routes.js` says why: the catalogue judges a timetable
 * not sensitive), so a student reads their week through `GET /timetable/class/:classId` on
 * `timetable.view`, the key every role reads a timetable with. Which class is not something a student
 * can look up — they hold no `classes.view` — so it comes from their own record, `GET /students/mine`
 * (the owner's decision D17), which names the class and section.
 *
 * ## The section's periods and the whole class's
 *
 * `section_id` narrows the week to the student's section, and `classView()` then returns the
 * whole-class periods with it, because an assembly for the class is that section's period too. A
 * student placed in no section gets the class's whole week, every entry labelled with its section.
 *
 * ## Only periods that are running
 *
 * `is_active=true` is sent. The school's own grid shows retired entries deliberately — a retired row
 * still holds its slot, which an administrator scheduling over it needs to see — but a student reading
 * their week would take a retired period for one they have to attend.
 */

import { useCallback, useMemo } from 'react';

import { api } from '@/lib/apiClient';
import { useResource } from '@/lib/useCollection';
import { EmptyNotice, ErrorNotice, LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';

import { StudentHeading, WeekGrid, placementOf } from '@/components/selfRecords';
import type { SelfHead, WeekEntry } from '@/components/selfRecords';

/** `GET /timetable/class/:classId` answers `{ timetable: { class, section_id, entries } }`. */
interface ClassTimetable {
  entries: WeekEntry[];
}

/** One student's class week, fetched once their class is known. */
function ClassWeek({ student }: { student: SelfHead }) {
  const classId = student.class_id;
  const sectionId = student.section_id;

  const load = useMemo(
    () =>
      classId === null
        ? null
        : (signal: AbortSignal) =>
            api.get<{ timetable: ClassTimetable }>(`/timetable/class/${classId}`, {
              query: { section_id: sectionId ?? undefined, is_active: true },
              signal,
            }),
    [classId, sectionId]
  );
  const { data, loading, error, refusal, reload } = useResource(load);
  const entries = data?.timetable?.entries ?? [];
  const placement = placementOf(student);

  if (classId === null) {
    return (
      <EmptyNotice icon="calendar">
        No class is recorded for this student yet, so there is no class timetable to show. The school
        office places students in classes.
      </EmptyNotice>
    );
  }
  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (error) return <ErrorNotice message={error} onRetry={reload} />;
  if (loading) return <LoadingBlock label="Loading the week…" />;
  if (entries.length === 0) {
    return <EmptyNotice icon="calendar">Nothing is scheduled for {placement ?? 'this class'} yet.</EmptyNotice>;
  }

  return (
    <>
      <p className="mb-3 text-sm text-muted">
        {sectionId === null
          ? `${placement ?? 'The class'} — no section is recorded, so every section's periods are shown, each labelled.`
          : `${placement ?? 'Your section'} — whole-class periods are included.`}
      </p>
      <WeekGrid entries={entries} caption={`Class timetable: ${placement ?? 'your class'}`} />
    </>
  );
}

export default function StudentTimetable() {
  const load = useCallback(
    (signal: AbortSignal) => api.get<{ students: SelfHead[] }>('/students/mine', { signal }),
    []
  );
  const { data, loading, error, refusal, reload } = useResource(load);
  const students = data?.students ?? [];

  return (
    <div>
      <PageHeader title="My timetable" description="Your class’s week, period by period." />

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading ? (
        <LoadingBlock label="Loading your class…" rows={3} />
      ) : students.length === 0 ? (
        <EmptyNotice>There is no student record on this account to show a timetable for.</EmptyNotice>
      ) : (
        <div className="space-y-10">
          {students.map((student) => (
            <div key={student.id}>
              {/* One for a student; more only for an account that is also a parent — see `components/selfRecords.tsx`. */}
              {students.length > 1 ? <StudentHeading student={student} /> : null}
              <ClassWeek student={student} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
