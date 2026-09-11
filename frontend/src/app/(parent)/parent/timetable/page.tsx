'use client';

/**
 * A child's timetable — SRS §20.1's Class Timetable, for the class a linked child sits in. Read-only.
 *
 * ## The class comes from the dashboard
 *
 * There is no `timetable.self.view` (`timetable.routes.js` says why), so a parent reads the week through
 * `GET /timetable/class/:classId` on `timetable.view`, which the `parent` block grants. A parent holds
 * no `classes.view` to find a class, but `GET /parents/dashboard` now names each child's class and
 * section, and that list is already what `childSelect.tsx` offers — so the chosen child carries the two
 * ids this request needs, and no second request for the record is made.
 *
 * As on the student's screen, `section_id` brings the whole-class periods with the section's own
 * (`classView()` treats a class-wide period as every section's), and `is_active=true` leaves out retired
 * entries, which the school's own grid shows only because a retired row still holds its slot.
 *
 * ## When the child list cannot be read
 *
 * Unlike attendance and fees, there is no fallback: without the dashboard there is no class to ask
 * about. Its refusal or error is shown instead — the same one the parent's home screen would show.
 */

import { useMemo } from 'react';

import { api } from '@/lib/apiClient';
import { useResource } from '@/lib/useCollection';
import { EmptyNotice, ErrorNotice, LoadingBlock, PageHeader, RefusalNotice } from '@/components/table';

import { ChildSelect, childLabel, useChildChoice } from '../childSelect';
import type { LinkedChild } from '../childSelect';
import { childName } from '../children';
import { WeekGrid } from '@/components/selfRecords';
import type { WeekEntry } from '@/components/selfRecords';

/** `GET /timetable/class/:classId` answers `{ timetable: { class, section_id, entries } }`. */
interface ClassTimetable {
  entries: WeekEntry[];
}

/** One child's class week. Keyed on the child by the caller, so a new choice is a fresh grid. */
function ClassWeek({ child }: { child: LinkedChild }) {
  const classId = child.class_id;
  const sectionId = child.section_id;

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
  const label = childLabel(child);

  if (classId === null) {
    return (
      <EmptyNotice icon="calendar">
        No class is recorded for {childName(child)} yet, so there is no class timetable to show. The
        school office places students in classes.
      </EmptyNotice>
    );
  }
  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (error) return <ErrorNotice message={error} onRetry={reload} />;
  if (loading) return <LoadingBlock label="Loading the week…" />;
  if (entries.length === 0) {
    return <EmptyNotice icon="calendar">Nothing is scheduled for {child.class?.name ?? 'this class'} yet.</EmptyNotice>;
  }

  return (
    <>
      <p className="mb-3 text-sm text-muted">
        {label} —{' '}
        {sectionId === null
          ? 'no section is recorded, so every section’s periods are shown, each labelled.'
          : 'whole-class periods are included.'}
      </p>
      <WeekGrid entries={entries} caption={`Class timetable for ${label}`} />
    </>
  );
}

export default function ParentTimetable() {
  const choice = useChildChoice();
  const { dashboard, chosen } = choice;

  return (
    <div>
      <PageHeader title="Timetable" description="Your child’s class week, period by period." />

      {choice.children.length > 1 ? (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
          <ChildSelect id="timetable-child" choice={choice} />
        </div>
      ) : null}

      {dashboard.refusal ? (
        <RefusalNotice refusal={dashboard.refusal} />
      ) : dashboard.error ? (
        <ErrorNotice message={dashboard.error} onRetry={dashboard.reload} />
      ) : dashboard.loading ? (
        <LoadingBlock label="Loading your children…" rows={3} />
      ) : !chosen ? (
        <EmptyNotice>
          No children are linked to your account yet. The school office links a parent to a student.
        </EmptyNotice>
      ) : (
        <ClassWeek key={chosen.id} child={chosen} />
      )}
    </div>
  );
}
