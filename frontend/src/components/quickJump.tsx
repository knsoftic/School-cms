'use client';

/**
 * Jump to a screen by typing its name — `Ctrl K`, or the button in the header.
 *
 * ## Why this exists
 *
 * SRS §33 fixes the screen list: sixteen for the Super Admin, seventeen for a school. That is the
 * requirement, not an accident, so the sidebar cannot be shortened by merging screens away — and a
 * twenty-entry sidebar means finding a screen is a scan down a list every time, which is what the
 * owner reported as the thing that makes the product slow to use.
 *
 * Typing the name is the shortest path that does not remove anything. Three letters and Enter reaches
 * any screen from any other, and the sidebar stays exactly as §33 describes it.
 *
 * ## What it will and will not offer
 *
 * It searches **the caller's own navigation** — `visibleNav()`'s output, already filtered by
 * permission and by the school's subscribed modules — so it can never offer a screen that would answer
 * 403, and a school without the Library module is not told the Library exists. That is the same rule
 * the sidebar follows, from the same source, so the two cannot disagree.
 *
 * Screens only, not actions: "New student" is not offered, because whether this caller may admit a
 * student is a permission the navigation does not carry, and an entry that leads to a refusal is worse
 * than no entry.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { Icon } from '@/components/icon';
import { Modal } from '@/components/overlay';
import type { NavSection } from '@/lib/nav';

interface Entry {
  href: string;
  label: string;
  heading: string;
  icon?: React.ComponentProps<typeof Icon>['name'];
}

/**
 * Rank a match so the obvious answer is first.
 *
 * Typing "sch" should offer **Schools** before *School timetable*, and both before anything that only
 * matches on its section heading. Three tiers, scored rather than sorted by name, because alphabetical
 * order puts "Add-ons" above "Attendance" for a reader who typed "att".
 */
function score(entry: Entry, query: string): number {
  const label = entry.label.toLowerCase();
  const heading = entry.heading.toLowerCase();
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  /* A word inside the label: "timetable" finds *School timetable*. */
  if (label.split(/\s+/).some((word) => word.startsWith(query))) return 2;
  if (label.includes(query)) return 3;
  if (heading.includes(query)) return 4;
  return -1;
}

export function QuickJump({
  open,
  onClose,
  sections,
}: {
  open: boolean;
  onClose: () => void;
  sections: NavSection[];
}) {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const entries = useMemo<Entry[]>(
    () =>
      sections.flatMap((section) =>
        section.items.map((item) => ({
          href: item.href,
          label: item.label,
          heading: section.heading,
          icon: item.icon,
        }))
      ),
    [sections]
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries
      .map((entry) => ({ entry, rank: score(entry, q) }))
      .filter((row) => row.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map((row) => row.entry);
  }, [entries, query]);

  /* A new search starts at the top; without this the highlight stays on a row that has scrolled away. */
  useEffect(() => {
    setActive(0);
  }, [query]);

  /* Each opening starts empty, so the palette is never showing the last search. */
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      /* The dialog takes focus on open; the input is what should have it. */
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  function go(href: string) {
    onClose();
    router.push(href);
  }

  return (
    <Modal open={open} onClose={onClose} title="Go to screen" size="md">
      <div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((i) => (results.length ? (i + 1) % results.length : 0));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const target = results[active];
              if (target) go(target.href);
            }
          }}
          placeholder="Type a screen name…"
          aria-label="Search screens"
          aria-controls={listId}
          aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
          role="combobox"
          aria-expanded
          autoComplete="off"
          className="field-input"
        />

        {results.length === 0 ? (
          <p className="mt-4 text-sm text-muted">
            No screen matches “{query.trim()}”. Only screens this account can open are listed.
          </p>
        ) : (
          <ul id={listId} role="listbox" aria-label="Screens" className="mt-3 max-h-80 overflow-y-auto">
            {results.map((entry, index) => (
              <li key={entry.href} id={`${listId}-${index}`} role="option" aria-selected={index === active}>
                {/*
                  * A button, not a `Link`: the row is chosen by keyboard as often as by mouse, and a
                  * link that is "activated" by Enter on a *different* element is a link the browser
                  * never sees. `router.push` is the one path, so both routes behave identically.
                  */}
                <button
                  type="button"
                  onClick={() => go(entry.href)}
                  onMouseEnter={() => setActive(index)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                    index === active ? 'bg-brand-subtle text-brand-text' : 'text-ink-soft hover:bg-surface-3'
                  }`}
                >
                  {entry.icon ? (
                    <Icon name={entry.icon} size={16} className={index === active ? 'text-brand' : 'text-muted-soft'} />
                  ) : (
                    <span className="w-4" aria-hidden />
                  )}
                  <span className="truncate font-medium">{entry.label}</span>
                  <span className="ml-auto shrink-0 text-2xs uppercase tracking-[0.1em] text-muted-soft">
                    {entry.heading}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 border-t border-border-soft pt-2 text-xs text-muted">
          <kbd className="rounded border border-border px-1">↑</kbd>{' '}
          <kbd className="rounded border border-border px-1">↓</kbd> to move,{' '}
          <kbd className="rounded border border-border px-1">Enter</kbd> to open,{' '}
          <kbd className="rounded border border-border px-1">Esc</kbd> to close.
        </p>
      </div>
    </Modal>
  );
}
