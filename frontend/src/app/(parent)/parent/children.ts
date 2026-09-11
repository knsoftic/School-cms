'use client';

/**
 * The signed-in parent's children — `GET /parents/dashboard` — read by every parent screen.
 *
 * ## Why one hook rather than a copy of the fetch per screen
 *
 * The dashboard lists the children, the Results screen offers them as a filter, the Homework screen
 * says which of them a piece of homework is for, and the four D17 screens (attendance, fees, timetable,
 * record) choose one child through `childSelect.tsx`. All of them need the same list, and this is the
 * only endpoint a parent's grants reach for it: `GET /parents/{id}/children` is `parents.view`, which
 * the `parent` block in `permissions.js` does not hold. Written once so the refusal handling cannot
 * drift between them.
 *
 * Colocated with the parent screens rather than put in `lib/`, because nothing outside this surface
 * has a use for it. Next.js routes only `page.tsx` and its sibling conventions, so a module here is
 * never mistaken for a route.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';

/** A parent–student link, with the student included by the service. */
export interface ChildLink {
  id: number;
  student_id: number;
  relation: string | null;
  /**
   * `is_primary_guardian`, not `is_primary`.
   *
   * The column on `parent_students` is `is_primary_guardian` (`models/people.js`), and
   * `parents.service.js` writes exactly that name. This was declared and read as `is_primary`, which
   * is `undefined` on every row — so the "Primary contact" column answered **"no" for every child**,
   * including the one the school had recorded as the first to call.
   *
   * Worth naming the trap: `is_primary` *does* exist in `models/academic.js`, on a different table.
   * A grep for the bare name confirms the wrong thing.
   */
  is_primary_guardian: boolean;
  student?: {
    id: number;
    first_name: string;
    last_name: string | null;
    student_id: string | null;
    roll_number: string | null;
    status: string;
    /**
     * Both nullable on `students`. The Homework screen matches rows against them to say which child a
     * piece of homework is for, and the Timetable screen asks for the child's class week with them.
     */
    class_id: number | null;
    section_id: number | null;
    /**
     * The same two by name. `parents.service.js dashboard()` joins `Class` and `Section` onto each
     * child — a parent holds no `classes.view` to resolve an id another way — and this comment used
     * to say it joined neither. Each is a LEFT JOIN on a nullable key, so each can be null.
     */
    class: { id: number; name: string } | null;
    section: { id: number; name: string } | null;
  };
}

export interface ParentDashboardData {
  parent: { id: number; name: string };
  counts: { children: number; activeChildren: number };
  children: ChildLink[];
}

/** "First Last", with a nullable last name dropped rather than printed as "null". */
export function childName(student: { first_name: string; last_name: string | null }): string {
  return [student.first_name, student.last_name].filter(Boolean).join(' ');
}

/**
 * Load the dashboard payload, sorting failures the way `useCollection` does.
 *
 * `PARENT_PROFILE_MISSING` and `PARENT_INACTIVE` are in `EXPLAINED_CODES` because both are permanent
 * until the school office acts, so they arrive as a `refusal` rather than as an error with a "Try
 * again" button that cannot help.
 */
export function useParentDashboard(): {
  data: ParentDashboardData | null;
  loading: boolean;
  error: string | null;
  refusal: Refusal | null;
  reload: () => void;
} {
  const [data, setData] = useState<ParentDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setRefusal(null);

    (async () => {
      try {
        const result = await api.get<ParentDashboardData>('/parents/dashboard', { signal: controller.signal });
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

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, refusal, reload };
}
