'use client';

/**
 * Teacher dashboard — SRS §15.3, checklist row 4.5.
 *
 * Orientation page: what the teacher is assigned to, and shortcuts into the School screens where the
 * work happens.
 *
 * ## Named, not counted
 *
 * FR-TEACHER-002 (SRS:852) is "a dashboard relevant to their assigned classes and subjects", and this
 * page used to answer it with numbers: "Classes 3" named none of them, the subject chips dropped the
 * class and section each assignment row carries, and a section chip read "A" with nothing to say A of
 * what. Every name is in the `/teachers/dashboard` payload except one — `sectionTeacherOf` rows carry
 * `class_id` alone (`teachers.service.js assignments()` selects `['id', 'name', 'class_id',
 * 'is_active']` from `sections`) — and that one is resolved through `GET /classes`, which a teacher
 * holds `classes.view` for, and only when the payload has not already named that class.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useEntitlements } from '@/lib/entitlements';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { useClassSections, useWholeList } from '@/lib/useTimetablePickers';
import type { ClassOption } from '@/lib/useTimetablePickers';
import { Icon } from '@/components/icon';
import {
  ActionTile,
  DashboardBanner,
  ErrorNotice,
  HeaderActions,
  LoadingBlock,
  MetricCard,
  PageHeader,
  RefusalNotice,
  SectionHeading,
} from '@/components/table';

interface NamedRow {
  id: number;
  name: string;
}

/**
 * One `sections` row this teacher is section teacher of. Flat, like `classTeacherOf`, but its class is
 * a bare `class_id` — the query selects no `Class` — which is why a chip needs the lookup below.
 */
interface SectionRow {
  id: number;
  name: string;
  class_id: number;
}

/** A subject and every class — and section, where the assignment names one — it is taught in. */
interface SubjectTaught {
  id: number;
  name: string;
  code: string | null;
  places: string[];
}

/**
 * One `teacher_subjects` row, as `teachers.service.js assignments()` returns it.
 *
 * **This is not a `NamedRow`, and typing it as one is what emptied the chips.** `assignments()` does
 * `db.TeacherSubject.findAll({ include: [{ model: db.Subject, as: 'subject', … }, … ] })`, so the
 * subject's name is one level down at `row.subject.name`. The join row itself has no `name` at all,
 * so every "My subjects" chip rendered as an empty pill. `classTeacherOf` and `sectionTeacherOf`
 * really are flat — they come from `db.Class.findAll` / `db.Section.findAll` with
 * `attributes: ['id', 'name', …]` — which is why only one of the three lists was broken and why one
 * shared type for all three hid it.
 */
interface TeacherSubjectRow {
  id: number;
  subject: { id: number; name: string; code: string | null; type: string | null } | null;
  class: { id: number; name: string } | null;
  section: { id: number; name: string } | null;
}

interface TeacherDashboard {
  teacher: { id: number; first_name: string; last_name: string | null; employee_id: string | null };
  counts: { subjects: number; classes: number; classTeacherOf: number; sectionTeacherOf: number };
  subjects: TeacherSubjectRow[];
  classTeacherOf: NamedRow[];
  sectionTeacherOf: SectionRow[];
}

/** The chip every assignment list on this page uses, named once so the three cannot drift apart. */
const CHIP =
  'rounded-md border border-brand-subtle-border bg-brand-subtle px-2.5 py-0.5 text-xs font-semibold text-brand-text';

/**
 * Where one assignment row puts the subject.
 *
 * `teacher_subjects.class_id` and `section_id` are both nullable, and `models/academic.js` says what
 * each state means: no class is a teacher "qualified for a subject generally", a class with no
 * section is the whole class, and a section is that section alone.
 */
function placeOf(row: TeacherSubjectRow): string {
  if (!row.class) return 'not tied to a class';
  return row.section ? `${row.class.name} · ${row.section.name}` : row.class.name;
}

export default function TeacherDashboard() {
  const { profile, can } = useAuth();
  const { hasModule } = useEntitlements();

  const [data, setData] = useState<TeacherDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  /*
   * One entry per subject — still de-duplicated, so the list agrees with `counts.subjects`, which the
   * service builds from `new Set(subjects.map(r => r.subject_id))` — but each now keeps every place
   * it is taught in. The old chips kept the subject and threw the rest of the row away, so a teacher
   * taking Mathematics in three classes read "Mathematics" once and could not tell which three.
   */
  const subjectsTaught = useMemo<SubjectTaught[]>(() => {
    const bySubject = new Map<number, SubjectTaught>();
    for (const row of data?.subjects ?? []) {
      if (!row.subject) continue;
      const entry =
        bySubject.get(row.subject.id) ??
        { id: row.subject.id, name: row.subject.name, code: row.subject.code, places: [] };
      const place = placeOf(row);
      if (!entry.places.includes(place)) entry.places.push(place);
      bySubject.set(row.subject.id, entry);
    }
    return [...bySubject.values()];
  }, [data]);

  /*
   * Every class the payload names, by id: the classes subjects are taught in, and the classes this
   * teacher is class teacher of. Those two sets are exactly what `counts.classes` is built from, so
   * the same map both names the Classes card and names most sections' classes for free.
   */
  const payloadClassNames = useMemo(() => {
    const names = new Map<number, string>();
    for (const row of data?.subjects ?? []) if (row.class) names.set(row.class.id, row.class.name);
    for (const row of data?.classTeacherOf ?? []) names.set(row.id, row.name);
    return names;
  }, [data]);

  /*
   * The lookup for the rest. Asked only when a section's class is not already named, and only of a
   * caller who holds `classes.view` — which the `teacher` block grants — so a teacher whose sections
   * all sit in their own classes makes no extra request. `useWholeList` reads past the first page of
   * a hundred. Any failure leaves the chip as the section name alone, which is what it was before.
   */
  const needsClassLookup = (data?.sectionTeacherOf ?? []).some((row) => !payloadClassNames.has(row.class_id));
  const { classes: firstClassPage } = useClassSections('', needsClassLookup && can('classes.view'));
  const allClasses = useWholeList<ClassOption>('/classes', firstClassPage);

  const classNameOf = (classId: number): string | undefined =>
    payloadClassNames.get(classId) ??
    (allClasses.state === 'ready' ? allClasses.rows.find((row) => row.id === classId)?.name : undefined);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);

    (async () => {
      try {
        const result = await api.get<TeacherDashboard>('/teachers/dashboard', { signal: controller.signal });
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

  const shortcuts = [
    /*
     * The teacher's own week, first because it is the one screen here that is theirs alone. It asks
     * `GET /timetable/teacher/:teacherId` with the id this dashboard's payload carries.
     */
    { href: '/teacher/timetable', label: 'My timetable', description: 'Your own teaching periods, day by day.', icon: 'calendar' as const, permission: 'timetable.view', module: 'timetable' },
    { href: '/school/attendance', label: 'Attendance', description: 'Mark and review attendance for your classes.', icon: 'clipboard' as const, permission: 'attendance.view', module: 'attendance' },
    { href: '/school/exams', label: 'Exams and marks', description: 'Enter and submit marks for your subjects.', icon: 'file-text' as const, permission: 'exams.view', module: 'exams' },
    { href: '/school/homework', label: 'Homework', description: 'Set homework and see what is due.', icon: 'book' as const, permission: 'homework.view', module: 'homework' },
    /*
     * FR-ASG-001 (SRS:1107) and FR-AI-001 (SRS:1152) both name Teacher, and both screens used to be
     * reachable only from the principal's dashboard. Gated on the same keys and modules as the
     * shortcuts there, so the two dashboards cannot disagree about who may open them.
     */
    { href: '/school/assignments', label: 'Assignments', description: 'Set assignments and mark the work students hand in.', icon: 'paperclip' as const, permission: 'assignments.view', module: 'assignments' },
    /*
     * Captioned for where it goes. It said "Your teaching periods", and it opens the whole-school
     * register: `/school/timetable` sends no teacher filter, and its search matches period labels and
     * rooms only. That screen's Teacher tab does call `GET /timetable/teacher/:teacherId`, but offers
     * the tab only to a caller holding `teachers.view`, which a teacher does not — so the teacher's
     * own week is the "My timetable" shortcut above, and this one is labelled as the school's.
     */
    { href: '/school/timetable', label: 'School timetable', description: 'The whole school’s periods, by day — not only yours.', icon: 'grid' as const, permission: 'timetable.view', module: 'timetable' },
    { href: '/school/ai', label: 'AI questions', description: 'Generate multiple-choice questions from a PDF, image or syllabus, then review them.', icon: 'layers' as const, permission: 'ai.generate', module: 'ai' },
  ].filter((item) => can(item.permission) && hasModule(item.module));

  return (
    <div>
      <PageHeader
        title={`Welcome, ${profile?.user.name ?? 'teacher'}`}
        description="Your assignments and the screens where the day’s work happens."
        action={
          <HeaderActions>
            {can('attendance.view') && hasModule('attendance') ? (
              <Link href="/school/attendance" className="btn btn-secondary">
                <Icon name="clipboard" size={15} />
                Attendance
              </Link>
            ) : null}
            {can('timetable.view') && hasModule('timetable') ? (
              <Link href="/teacher/timetable" className="btn btn-primary">
                <Icon name="calendar" size={15} />
                My timetable
              </Link>
            ) : null}
          </HeaderActions>
        }
      />

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={() => setNonce((n) => n + 1)} />
      ) : loading ? (
        <LoadingBlock />
      ) : !data ? null : (
        <>
          <dl className="mb-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricCard label="Subjects" value={data.counts.subjects} icon="book" />
            {/*
              * The count names what it counts. `payloadClassNames` is built from the same two sets
              * the service counts — the classes subjects are taught in and the classes this teacher
              * is class teacher of — so the names under the figure are the classes in it.
              */}
            <MetricCard
              label="Classes"
              value={data.counts.classes}
              icon="grid"
              hint={payloadClassNames.size > 0 ? [...payloadClassNames.values()].join(', ') : undefined}
            />
            <MetricCard label="Class teacher of" value={data.counts.classTeacherOf} icon="users" />
            <MetricCard label="Section teacher of" value={data.counts.sectionTeacherOf} icon="user" />
          </dl>

          {/*
            * All four counts, not two.
            *
            * This was gated on `subjects === 0 && classes === 0`, so a teacher who is the class
            * teacher of a form — or the section teacher of one — but takes no subject was told
            * **"You have no subjects or classes assigned yet"** while the cards above them showed a
            * non-zero count. `classTeacherOf` and `sectionTeacherOf` are separate assignments in
            * `teacher_subjects`' sibling tables and neither contributes to the two counts that were
            * checked, which is exactly how the state became reachable.
            */}
          {data.counts.subjects === 0 &&
          data.counts.classes === 0 &&
          data.counts.classTeacherOf === 0 &&
          data.counts.sectionTeacherOf === 0 ? (
            <DashboardBanner title="Nothing assigned yet" icon="users" tone="brand">
              You have no subjects or classes assigned yet. An administrator assigns these from the
              Subjects and Classes screens.
            </DashboardBanner>
          ) : (
            <div className="mb-8 grid gap-4 sm:grid-cols-2">
              {subjectsTaught.length > 0 ? (
                <section className="surface p-5">
                  <h2 className="mb-3 text-sm font-semibold text-ink">My subjects</h2>
                  {/*
                    * One line per subject — matching the Subjects figure — with its classes as chips
                    * beneath. A subject taught to one section reads "Grade 5 · A"; taught to the
                    * whole class, just "Grade 5".
                    */}
                  <ul className="space-y-3">
                    {subjectsTaught.map((subject) => (
                      <li key={subject.id}>
                        <p className="text-sm font-semibold text-ink">
                          {subject.name}
                          {subject.code ? (
                            <span className="font-normal text-muted"> ({subject.code})</span>
                          ) : null}
                        </p>
                        <ul
                          className="mt-1.5 flex flex-wrap gap-1.5"
                          aria-label={`Where you teach ${subject.name}`}
                        >
                          {subject.places.map((place) => (
                            <li key={place} className={CHIP}>
                              {place}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {[
                {
                  label: 'Class teacher of',
                  chips: data.classTeacherOf.map((row) => ({ id: row.id, text: row.name })),
                },
                {
                  label: 'Section teacher of',
                  /*
                   * "Grade 5 · A", not "A". A section name is only unique within its class, so on
                   * its own it does not say which form this teacher looks after.
                   */
                  chips: data.sectionTeacherOf.map((row) => {
                    const className = classNameOf(row.class_id);
                    return { id: row.id, text: className ? `${className} · ${row.name}` : row.name };
                  }),
                },
              ]
                .filter((group) => group.chips.length > 0)
                .map((group) => (
                  <section key={group.label} className="surface p-5">
                    <h2 className="mb-3 text-sm font-semibold text-ink">{group.label}</h2>
                    <ul className="flex flex-wrap gap-2">
                      {group.chips.map((chip) => (
                        <li key={chip.id} className={CHIP}>
                          {chip.text}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
            </div>
          )}

          {shortcuts.length > 0 ? (
            <section>
              <SectionHeading>Where the work happens</SectionHeading>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {shortcuts.map((item) => (
                  <li key={item.href}>
                    <ActionTile
                      href={item.href}
                      label={item.label}
                      description={item.description}
                      icon={item.icon}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
