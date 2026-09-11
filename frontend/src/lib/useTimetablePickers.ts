'use client';

/**
 * The five lists a timetable slot is built from.
 *
 * ## Why this is a hook rather than code in one screen
 *
 * `timetable/new` loaded these and, when the edit screen was added, would have needed the same
 * ninety lines a second time: four independent fetches, four separate failure states, a fifth list
 * that hangs off the chosen class, and one rule about what happens when that class changes. Copying
 * that is copying four reasons it is written the way it is, and the copy is where they drift apart.
 *
 * The reasoning below is the create screen's, moved here with the code it explains.
 *
 * `useCurriculum` at the end is the one reader that is not a timetable list: the subjects a chosen class
 * and section teach, which homework and assignments narrow their subject pickers to (D30). It hangs off
 * the same class choice and reuses the same `Picker` states, so it sits with them.
 */

import { useEffect, useState } from 'react';

import { api } from '@/lib/apiClient';

/** `PAGINATION.MAX_LIMIT` — the most `commonSchemas.pagination` will accept in one page. */
export const OPTION_LIMIT = 100;

/**
 * A class as `GET /classes` returns it.
 *
 * `classes.controller.js` has no `present()` — it hands `ApiResponse.paginated` the Sequelize rows
 * whole — so the row carries every column of the model; only the five these pickers read are
 * declared.
 */
export interface ClassOption {
  id: number;
  name: string;
  code: string | null;
  /**
   * The session the class belongs to. A class is unique per `(school, session, name)`, so "Grade 5"
   * exists once a year and this is what tells two of them apart — see `sessionNames`. Nullable on the
   * column even though `classes.create` requires it: the foreign key is `SET NULL` on session delete.
   */
  academic_session_id: number | null;
  is_active: boolean;
}

/** A section as `GET /classes/:id/sections` returns it, ordered by name. */
export interface SectionOption {
  id: number;
  name: string;
  is_active: boolean;
}

/** A subject as `GET /subjects` returns it. `code` is NOT NULL and unique within the school. */
export interface SubjectOption {
  id: number;
  name: string;
  code: string;
  is_active: boolean;
}

/** A teacher as `GET /teachers` returns it. `last_name` is nullable on the model. */
export interface TeacherOption {
  id: number;
  employee_id: string;
  first_name: string;
  last_name: string | null;
  is_active: boolean;
}

/** An academic session as `GET /sessions` returns it. Status is shown, never acted on. */
export interface SessionOption {
  id: number;
  name: string;
  status: string;
  is_current: boolean;
}

/** One picker: still loading, unreachable, or the rows plus how many exist in total. */
export type Picker<T> =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; rows: T[]; total: number };

/** An empty, already-settled picker — what the section list is before a class has been chosen. */
export const NO_SECTIONS: Picker<SectionOption> = { state: 'ready', rows: [], total: 0 };

/** `teachers.controller.js` joins the two names and drops the null. */
export function teacherName(row: TeacherOption): string {
  return [row.first_name, row.last_name].filter(Boolean).join(' ');
}

/** `monday` → `Monday`. The ENUM is stored lower case; a dropdown of days should not read that way. */
export function dayLabel(day: string): string {
  return day.charAt(0).toUpperCase() + day.slice(1);
}

/**
 * Session names by id, for the label that tells two same-named classes apart.
 *
 * `students/new` and `homework/new` already label each class option with its session this way; this
 * is the same map for the screens that load their sessions through a `Picker`. Empty until the list
 * is ready, and for a caller who cannot read it (`GET /sessions` needs `sessions.view`, which a
 * teacher does not hold) — so an option falls back to the bare class name rather than to an id.
 */
export function sessionNames(sessions: Picker<SessionOption>): Map<number, string> {
  return new Map(sessions.state === 'ready' ? sessions.rows.map((row) => [row.id, row.name]) : []);
}

export interface TimetablePickers {
  classes: Picker<ClassOption>;
  sections: Picker<SectionOption>;
  subjects: Picker<SubjectOption>;
  teachers: Picker<TeacherOption>;
  sessions: Picker<SessionOption>;
}

/**
 * Four independent fetches rather than one `Promise.all`.
 *
 * The grants are separate and so are the consequences — a school without the Teachers module still
 * builds a timetable — and an `all` would let one refusal take the other lists down with it.
 *
 * `api.page` rather than `api.get`: `meta.pagination.total` is the only thing that tells a picker it
 * is showing a first page rather than the whole set.
 *
 * None of the calls sends `school_id`. `tenantWhere(req.tenant, …)` already pins every query to the
 * caller's school, and naming one here is how a request ends up `CROSS_SCHOOL_ACCESS`.
 *
 * Exported for a screen that needs one of these lists and not the other four — the classes list
 * wants teachers and sessions, the assignment form wants subjects — so it gets the same four states
 * without a fifth copy of the fetch. A picker that is never `enabled` stays `loading`; a caller that
 * gates on a permission reads that as "not offered", not as a spinner.
 */
export function useList<T>(path: string, enabled: boolean): Picker<T> {
  const [picker, setPicker] = useState<Picker<T>>({ state: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    (async () => {
      try {
        const page = await api.page<T[]>(path, { query: { limit: OPTION_LIMIT } });
        if (!cancelled) {
          setPicker({
            state: 'ready',
            rows: page.data,
            total: page.meta?.total ?? page.data.length,
          });
        }
      } catch {
        /* Which refusal it was does not change the remedy; each screen states its own. */
        if (!cancelled) setPicker({ state: 'failed' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, enabled]);

  return picker;
}

/**
 * How many pages of one picker `useWholeList` will read — an operational ceiling, not an SRS one.
 * A thousand options is past any school's staff room, and ten requests stay well inside
 * `apiLimiter`'s budget. Past it the hints still say how many were left out.
 */
export const MAX_PAGES = 10;

/**
 * A picker cut at one page, read to its end.
 *
 * Pages two onwards are fetched in the server's own order — the `id` tiebreaker `getSort` appends
 * keeps each row on exactly one page — and appended to the first. `total` stays the server's count, so
 * a "Showing the first N of M" hint is still right in the one case it can still fire: a list past
 * `MAX_PAGES`, or a later page that failed. A failed later page leaves the first standing rather than
 * taking the whole picker down with it.
 *
 * Kept here rather than folded into `useList` so a screen opts in per list: the timetable screens read
 * every class, subject, teacher and session, and the attendance register needs only the first page of
 * classes it already asks for. Both timetable screens carried their own copy of this until it moved.
 */
export function useWholeList<T extends { id: number }>(path: string, first: Picker<T>): Picker<T> {
  const total = first.state === 'ready' ? first.total : 0;
  const loaded = first.state === 'ready' ? first.rows.length : 0;
  const [rest, setRest] = useState<T[]>([]);

  useEffect(() => {
    if (total <= loaded) return;
    let cancelled = false;
    const pages = Math.min(Math.ceil(total / OPTION_LIMIT), MAX_PAGES);

    (async () => {
      try {
        const results = await Promise.all(
          Array.from({ length: Math.max(0, pages - 1) }, (_, index) =>
            api.page<T[]>(path, { query: { page: index + 2, limit: OPTION_LIMIT } })
          )
        );
        if (!cancelled) setRest(results.flatMap((result) => result.data ?? []));
      } catch {
        /* The first page still stands, and its hint still says how many it is short. */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, total, loaded]);

  if (first.state !== 'ready' || rest.length === 0) return first;
  const seen = new Set(first.rows.map((row) => row.id));
  return {
    state: 'ready',
    rows: [...first.rows, ...rest.filter((row) => !seen.has(row.id))],
    total: first.total,
  };
}

/**
 * The class list, plus the sections of whichever class is chosen.
 *
 * Split out of `useTimetablePickers` when the attendance register needed exactly these two and none
 * of the other three: loading subjects, teachers and sessions for a screen that shows none of them
 * is two or three wasted requests per visit, and copying the section-follows-class rule instead
 * would put the same decision in two places.
 */
export function useClassSections(
  classId: string,
  enabled: boolean
): { classes: Picker<ClassOption>; sections: Picker<SectionOption> } {
  const classes = useList<ClassOption>('/classes', enabled);
  const [sections, setSections] = useState<Picker<SectionOption>>(NO_SECTIONS);

  /*
   * Sections hang off the chosen class, so this effect is keyed on it — and on `enabled`, which gates
   * this fetch exactly as it gates the class list. A caller that is not enabled is given the settled
   * empty list a caller with no class chosen is given, and nothing is requested for them.
   *
   * `GET /classes/:id/sections` is deliberately not a page — `listSections` answers
   * `{ sections: rows }` ordered by name, with no pagination to read — so there is no `total` to
   * compare and nothing here can be truncated.
   *
   * It needs `classes.view`, the same grant as the class list, and a failure here can be exactly that.
   * A class id does not only arrive by being picked from the list: `students/[id]` opens on the class
   * the record already names, and the Accountant and the Librarian read that record without holding
   * `classes.view`. That is what `enabled` is for — a caller who cannot read classes passes false and
   * is not sent to be refused. The failed branch still catches a class deleted between the two calls,
   * and a caller that asked anyway.
   */
  useEffect(() => {
    if (!classId || !enabled) {
      setSections(NO_SECTIONS);
      return;
    }

    let cancelled = false;
    setSections({ state: 'loading' });

    (async () => {
      try {
        const body = await api.get<{ sections: SectionOption[] }>(`/classes/${classId}/sections`);
        const rows = body.sections ?? [];
        if (!cancelled) setSections({ state: 'ready', rows, total: rows.length });
      } catch {
        if (!cancelled) setSections({ state: 'failed' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [classId, enabled]);

  return { classes, sections };
}

/** The curriculum before a class is chosen: settled, and empty. */
const NO_SUBJECTS: Picker<SubjectOption> = { state: 'ready', rows: [], total: 0 };

/**
 * The subjects one class teaches, for work set for the whole class or for one of its sections — the
 * owner's decision D30.
 *
 * Homework and assignments refuse a subject that is not on the chosen class's curriculum
 * (`homework.service.assertOnCurriculum()`, shared by `assignments.service`): an active `class_subjects`
 * row of that class, whole-class or — when a section is named — that section's. `GET /subjects?class_id=`
 * (with `section_id=` to narrow) answers exactly that set, by the same rule, so this is one read per
 * class and section chosen. It needs `subjects.view`, the grant the subject list itself needs.
 *
 * This used to ask `GET /subjects/:id/classes` once for every subject in the school and fold the answers
 * together — capped at fifty subjects, past which the pickers offered every subject and let the server
 * refuse — because no read listed a class's subjects. The class filter is that read, so neither the
 * cap nor the fallback is left.
 *
 * `total` is the server's count, so a curriculum longer than one page (`OPTION_LIMIT`) can say so.
 * While the next class's read is in flight the answer is `loading`, never the previous class's subjects.
 *
 * @param classId    the chosen class, as the form holds it. `''` before one is chosen.
 * @param sectionId  the chosen section, `''` for the whole class
 * @param enabled    false for a caller who is about to be refused, or while the form is closed
 */
export function useCurriculum(classId: string, sectionId: string, enabled: boolean): Picker<SubjectOption> {
  const key = enabled && classId ? `${classId}:${sectionId}` : '';
  const [settled, setSettled] = useState<{ key: string; result: Picker<SubjectOption> } | null>(null);

  useEffect(() => {
    if (!key) return;
    const [klass, section] = key.split(':');
    let cancelled = false;

    (async () => {
      try {
        /* `section_id` only beside a class, which the key guarantees: alone it is a 422. */
        const page = await api.page<SubjectOption[]>('/subjects', {
          query: { class_id: klass, section_id: section || undefined, limit: OPTION_LIMIT },
        });
        const rows = page.data ?? [];
        if (!cancelled) {
          setSettled({ key, result: { state: 'ready', rows, total: page.meta?.total ?? rows.length } });
        }
      } catch {
        /* Which refusal it was does not change the remedy; each screen states its own. */
        if (!cancelled) setSettled({ key, result: { state: 'failed' } });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!enabled) return { state: 'loading' };
  if (!classId) return NO_SUBJECTS;
  return settled && settled.key === key ? settled.result : { state: 'loading' };
}

/**
 * @param classId  the chosen class, as the form holds it. `''` before one is chosen.
 * @param enabled  false for a caller who is about to be refused, so nothing is fetched for them.
 */
export function useTimetablePickers(classId: string, enabled: boolean): TimetablePickers {
  const { classes, sections } = useClassSections(classId, enabled);
  const subjects = useList<SubjectOption>('/subjects', enabled);
  const teachers = useList<TeacherOption>('/teachers', enabled);
  const sessions = useList<SessionOption>('/sessions', enabled);

  return { classes, sections, subjects, teachers, sessions };
}
