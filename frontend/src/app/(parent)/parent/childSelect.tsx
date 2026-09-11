'use client';

/**
 * Choosing one child — for the four D17 screens that show a parent one child at a time.
 *
 * ## One child, not "all children"
 *
 * Results and Homework filter a list whose every row names its child, so "All children" is a fair
 * default there. Attendance, fees, the record and the timetable are each *about* a child: a timetable
 * is one class's week, and a percentage for two children at once is nobody's percentage. So the choice
 * here is always a child, the first one linked until another is picked, and the control appears only
 * when there are two or more to choose between.
 *
 * The list is `GET /parents/dashboard` (`children.ts`), the only endpoint a parent's grants reach for
 * it. The chosen id is what the screen sends as `student_id`, which `services/selfScope.js pickLinked()`
 * accepts only for a child linked to this parent — a stale id is refused with `STUDENT_NOT_LINKED`, an
 * explained code, rather than answered with someone else's child.
 */

import { useMemo, useState } from 'react';

import { FilterSelect } from '@/components/form';

import { childName, useParentDashboard } from './children';
import type { ChildLink } from './children';

/** A linked child as the dashboard includes it — `ChildLink.student`, never undefined here. */
export type LinkedChild = NonNullable<ChildLink['student']>;

export interface ChildChoice {
  /** The dashboard the list comes from: its loading flag gates the first request, its refusal is shown. */
  dashboard: ReturnType<typeof useParentDashboard>;
  children: LinkedChild[];
  /** The child picked, else the first linked; null when none is linked or the list could not be read. */
  chosen: LinkedChild | null;
  pick: (studentId: string) => void;
}

export function useChildChoice(): ChildChoice {
  const dashboard = useParentDashboard();
  const children = useMemo(
    () => (dashboard.data?.children ?? []).flatMap((link) => (link.student ? [link.student] : [])),
    [dashboard.data]
  );
  /*
   * The pick is held as the select holds it, and the default is derived rather than stored: a stored
   * default would need an effect to seed it once the list arrived, and would go stale if it changed.
   */
  const [picked, setPicked] = useState('');
  const chosen = children.find((child) => String(child.id) === picked) ?? children[0] ?? null;

  return { dashboard, children, chosen, pick: setPicked };
}

/** "Ali Khan · Grade 5" — the class is what tells two children apart at a glance. */
export function childLabel(child: LinkedChild): string {
  const place = child.class ? (child.section ? `${child.class.name} · ${child.section.name}` : child.class.name) : null;
  return [childName(child), place].filter(Boolean).join(' · ');
}

/** The picker, for a `FilterBar`; nothing at all when there is only one child to show. */
export function ChildSelect({ id, choice }: { id: string; choice: ChildChoice }) {
  if (choice.children.length < 2) return null;
  return (
    <FilterSelect
      id={id}
      label="Child"
      labelVisible
      value={choice.chosen ? String(choice.chosen.id) : ''}
      onChange={choice.pick}
      className="sm:min-w-64"
    >
      {choice.children.map((child) => (
        <option key={child.id} value={String(child.id)}>
          {childLabel(child)}
        </option>
      ))}
    </FilterSelect>
  );
}
