'use client';

/**
 * Resolve a `school_id` to the school's name, for the platform screens that only receive the id.
 *
 * ## Why this exists
 *
 * Three billing screens — payments, invoices, subscriptions — render rows that carry `school_id` and
 * nothing else. `payments.service.js detailInclude()` joins the invoice, the subscription, the
 * transactions and the refunds, but deliberately **not** `School`, and the other two are the same. So
 * those screens printed `#42`, which is not a thing a reviewer can act on: approving a payment means
 * knowing whose payment it is, and an integer is not an answer.
 *
 * The fix is deliberately on this side of the wire. Adding a join to three services would change the
 * shape of three verified endpoints to improve a label, and the brief this was written under is a UI
 * brief: *"Do not break backend/API integrations."* One cached lookup costs one request per session
 * and cannot change what any endpoint returns.
 *
 * ## What it does not promise
 *
 * `PAGINATION.MAX_LIMIT` is 100, so the list is walked a page at a time up to `MAX_PAGES`. A platform
 * with more schools than that resolves the first `MAX_PAGES * 100` and **falls back to `School #42`
 * for the rest** — the same string those screens showed before, so the ceiling degrades to today's
 * behaviour rather than to a blank or a wrong name. It never guesses.
 *
 * The cache is module-level and lives for the tab. School names change rarely and a stale name on a
 * payment row is a cosmetic lag, not a correctness problem; `reset()` exists for the sign-out path so
 * one tenant's names cannot outlive their session.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { requestPage } from '@/lib/apiClient';

interface SchoolRow {
  id: number;
  name: string;
}

/** 10 pages × 100 = 1,000 schools resolved before the fallback takes over. */
const MAX_PAGES = 10;

let cache: Map<number, string> | null = null;
let inFlight: Promise<Map<number, string>> | null = null;

/** Drop the cache. Called on sign-out so names do not cross sessions. */
export function resetSchoolNames() {
  cache = null;
  inFlight = null;
}

async function loadAll(): Promise<Map<number, string>> {
  const names = new Map<number, string>();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, meta } = await requestPage<SchoolRow[]>('/schools', {
      query: { page, limit: 100 },
    });

    for (const row of data) {
      if (typeof row?.id === 'number' && typeof row?.name === 'string') names.set(row.id, row.name);
    }

    /* No meta means the endpoint did not paginate this answer — one pass is all there is. */
    if (!meta || page >= meta.totalPages) break;
  }

  return names;
}

/**
 * The lookup.
 *
 * Returns a `nameFor` that is safe to call during the first render, before anything has loaded — it
 * answers with the fallback until the names arrive, so a row never renders empty and never suspends.
 * A failed load is swallowed on purpose: the caller is a payments table, and a screen that refuses to
 * list payments because it could not decorate them with names is worse than one that shows ids.
 */
export function useSchoolNames(): {
  nameFor: (id: number | null | undefined) => string;
  /** The resolved schools, by name, for the screens that offer a "filter by school" control. */
  schools: Array<{ id: number; name: string }>;
  ready: boolean;
} {
  const [names, setNames] = useState<Map<number, string> | null>(cache);

  useEffect(() => {
    if (cache) {
      setNames(cache);
      return;
    }

    let alive = true;
    inFlight =
      inFlight ??
      loadAll()
        .then((loaded) => {
          cache = loaded;
          return loaded;
        })
        .catch(() => {
          /* Let a later mount try again rather than caching the failure forever. */
          inFlight = null;
          return new Map<number, string>();
        });

    inFlight.then((loaded) => {
      if (alive) setNames(loaded);
    });

    return () => {
      alive = false;
    };
  }, []);

  /*
   * `nameFor` and `schools` are memoised on `names`, and that is not a micro-optimisation.
   *
   * Every screen here builds its `Column[]` inside a `useMemo` that lists `nameFor` as a dependency.
   * A fresh arrow on every render makes that dependency change on every render, so the columns are
   * rebuilt constantly — and any `useEffect` a screen keys on the same value would re-run forever.
   * Keyed on `names`, the identity changes exactly once: when the lookup arrives.
   */
  const nameFor = useCallback(
    (id: number | null | undefined) => {
      if (id === null || id === undefined) return '—';
      return names?.get(id) ?? `School #${id}`;
    },
    [names]
  );

  const schools = useMemo(
    () =>
      names
        ? [...names.entries()]
            .map(([id, name]) => ({ id, name }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [names]
  );

  return { nameFor, schools, ready: names !== null };
}
