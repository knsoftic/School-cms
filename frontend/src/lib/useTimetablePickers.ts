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
 */

import { useEffect, useState } from 'react';

import { api } from '@/lib/apiClient';

/** `PAGINATION.MAX_LIMIT` — the most `commonSchemas.pagination` will accept in one page. */
export const OPTION_LIMIT = 100;

/**
 * A class as `GET /classes` returns it.
 *
 * `classes.controller.js` has no `present()` — it hands `ApiResponse.paginated` the Sequelize rows
 * whole — so the row carries every column of the model; only the four these pickers read are
 * declared.
 */
export interface ClassOption {
  id: number;
  name: string;
  code: string | null;
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

export interface TimetablePickers {
  classes: Picker<ClassOption>;
  sections: Picker<SectionOption>;
  subjects: Picker<SubjectOption>;
  teachers: Picker<TeacherOption>;
  sessions: Picker<SessionOption>;
}

/**
 * @param classId  the chosen class, as the form holds it. `''` before one is chosen.
 * @param enabled  false for a caller who is about to be refused, so nothing is fetched for them.
 */
export function useTimetablePickers(classId: string, enabled: boolean): TimetablePickers {
  const [classes, setClasses] = useState<Picker<ClassOption>>({ state: 'loading' });
  const [sections, setSections] = useState<Picker<SectionOption>>(NO_SECTIONS);
  const [subjects, setSubjects] = useState<Picker<SubjectOption>>({ state: 'loading' });
  const [teachers, setTeachers] = useState<Picker<TeacherOption>>({ state: 'loading' });
  const [sessions, setSessions] = useState<Picker<SessionOption>>({ state: 'loading' });

  useEffect(() => {
    /* The permission gate is a `return` after the hooks on both screens, so without this four lists
       would be fetched for a caller who is about to be told no. */
    if (!enabled) return;

    let cancelled = false;

    /*
     * Four independent fetches rather than one `Promise.all`. The four grants are separate and so are
     * the four consequences — a school without the Teachers module still builds a timetable — and an
     * `all` would let one refusal take the other three lists down with it.
     *
     * `api.page` rather than `api.get`: `meta.pagination.total` is the only thing that tells a picker
     * it is showing a first page rather than the whole set.
     *
     * None of the calls sends `school_id`. `tenantWhere(req.tenant, …)` already pins every query to
     * the caller's school, and naming one here is how a request ends up `CROSS_SCHOOL_ACCESS`.
     */
    async function load<T>(path: string, apply: (picker: Picker<T>) => void) {
      try {
        const page = await api.page<T[]>(path, { query: { limit: OPTION_LIMIT } });
        if (!cancelled) {
          apply({ state: 'ready', rows: page.data, total: page.meta?.total ?? page.data.length });
        }
      } catch {
        /* Which refusal it was does not change the remedy, and each branch on the screen states its own. */
        if (!cancelled) apply({ state: 'failed' });
      }
    }

    void load<ClassOption>('/classes', setClasses);
    void load<SubjectOption>('/subjects', setSubjects);
    void load<TeacherOption>('/teachers', setTeachers);
    void load<SessionOption>('/sessions', setSessions);

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  /*
   * Sections hang off the chosen class, so this effect is keyed on it.
   *
   * `GET /classes/:id/sections` is deliberately not a page — `listSections` answers
   * `{ sections: rows }` ordered by name, with no pagination to read — so there is no `total` to
   * compare and nothing here can be truncated.
   *
   * It needs `classes.view`, the same grant as the class list above, so a failure here is almost
   * never a permission problem: by the time a class can be chosen, the grant has already been proved.
   * What it does catch is a class deleted between the two calls, which is why the branch still exists.
   */
  useEffect(() => {
    if (!classId) {
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
  }, [classId]);

  return { classes, sections, subjects, teachers, sessions };
}
