'use client';

/**
 * Teacher dashboard — SRS §15.3, checklist row 4.5.
 *
 * Orientation page: assignments + shortcuts into School screens the teacher can reach.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useEntitlements } from '@/lib/entitlements';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { ErrorNotice, LoadingBlock, MetricCard, PageHeader, RefusalNotice } from '@/components/table';

interface NamedRow {
  id: number;
  name: string;
  code?: string | null;
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
  sectionTeacherOf: NamedRow[];
}

export default function TeacherDashboard() {
  const { profile, can } = useAuth();
  const { hasModule } = useEntitlements();

  const [data, setData] = useState<TeacherDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  /* The join rows, flattened to the chip shape and de-duplicated by subject. See the render below. */
  const subjectChips = useMemo<NamedRow[]>(() => {
    const seen = new Map<number, NamedRow>();
    for (const row of data?.subjects ?? []) {
      if (!row.subject || seen.has(row.subject.id)) continue;
      seen.set(row.subject.id, { id: row.subject.id, name: row.subject.name, code: row.subject.code });
    }
    return [...seen.values()];
  }, [data]);

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
    { href: '/school/attendance', label: 'Attendance', description: 'Mark and review attendance for your classes.', permission: 'attendance.view', module: 'attendance' },
    { href: '/school/exams', label: 'Exams and marks', description: 'Enter and submit marks for your subjects.', permission: 'exams.view', module: 'exams' },
    { href: '/school/homework', label: 'Homework', description: 'Set homework and see what is due.', permission: 'homework.view', module: 'homework' },
    { href: '/school/timetable', label: 'Timetable', description: 'Your teaching periods.', permission: 'timetable.view', module: 'timetable' },
  ].filter((item) => can(item.permission) && hasModule(item.module));

  return (
    <div>
      <PageHeader
        title={`Welcome, ${profile?.user.name ?? 'teacher'}`}
        description="What you are assigned to, and where the work happens."
      />

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={() => setNonce((n) => n + 1)} />
      ) : loading ? (
        <LoadingBlock />
      ) : !data ? null : (
        <>
          <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricCard label="Subjects" value={data.counts.subjects} />
            <MetricCard label="Classes" value={data.counts.classes} />
            <MetricCard label="Class teacher of" value={data.counts.classTeacherOf} />
            <MetricCard label="Section teacher of" value={data.counts.sectionTeacherOf} />
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
            <p className="mb-6 rounded-[var(--radius-lg)] border border-dashed border-border-strong bg-teal-mist/40 px-4 py-8 text-center text-sm text-muted">
              You have no subjects or classes assigned yet. An administrator assigns these from the
              Subjects and Classes screens.
            </p>
          ) : (
            <div className="mb-6 grid gap-4 sm:grid-cols-2">
              {[
                /*
                 * Flattened AND de-duplicated. One row per subject-in-a-class means a teacher who
                 * takes the same subject in three classes has three join rows — while
                 * `counts.subjects` is built from `new Set(subjects.map(r => r.subject_id))`. Without
                 * the same de-duplication here the card would read "Subjects 1" above three
                 * identical chips.
                 */
                ['My subjects', subjectChips],
                ['Class teacher of', data.classTeacherOf],
                ['Section teacher of', data.sectionTeacherOf],
              ]
                .filter(([, rows]) => (rows as NamedRow[]).length > 0)
                .map(([label, rows]) => (
                  <section key={String(label)} className="surface p-4">
                    <h2 className="mb-2 text-sm font-semibold text-ink">{label as string}</h2>
                    <ul className="flex flex-wrap gap-2">
                      {(rows as NamedRow[]).map((row) => (
                        <li
                          key={row.id}
                          className="rounded-full border border-teal/30 bg-teal-mist px-2.5 py-0.5 text-xs font-medium text-teal-deep"
                        >
                          {row.name}
                          {row.code ? <span className="text-muted"> ({row.code})</span> : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
            </div>
          )}

          {shortcuts.length > 0 ? (
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                Where the work happens
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {shortcuts.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="surface block p-4 transition-transform duration-200 hover:-translate-y-0.5 hover:border-teal"
                    >
                      <span className="font-semibold text-ink">{item.label}</span>
                      <p className="mt-1 text-xs text-muted">{item.description}</p>
                    </Link>
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
