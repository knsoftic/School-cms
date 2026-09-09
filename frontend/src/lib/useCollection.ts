'use client';

/**
 * Fetching a paginated collection — the hook behind every list screen in §33.
 *
 * Thirty-one screens are still to be built and most of them are a filtered, paginated list. Written
 * once, they all get the same handling of the four states a list is actually in — loading, empty,
 * failed, populated — and the same behaviour for the failures that are not really failures.
 *
 * ## The three failures that are not errors
 *
 * A list screen sees refusals that a banner saying "something went wrong" would describe badly:
 *
 *   - **403 `MODULE_NOT_SUBSCRIBED`** — the plan does not include this module. Nothing is broken and
 *     retrying will not help; the screen should explain, not apologise.
 *   - **402 `SUBSCRIPTION_INACTIVE`** — the subscription lapsed. Same shape, different remedy.
 *   - **403 `FORBIDDEN`** — the role lacks the permission. The nav hides these screens, but a
 *     bookmarked URL reaches them anyway, and "forbidden" is the honest answer.
 *
 * They are surfaced as `refusal` rather than `error` so a screen can render the right thing. Anything
 * else — a 500, a dropped connection — is an `error`, which is the state where "try again" belongs.
 *
 * ## Requests are abandoned, not cancelled-and-forgotten
 *
 * Every fetch carries an `AbortSignal` tied to the effect. Without it, typing in a search box starts
 * a request per keystroke and whichever *finishes* last wins — so a fast empty query can overwrite
 * the results of the slower one the user is actually waiting for. The abort makes the last request
 * issued the last one applied.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, api } from './apiClient';
import type { PageMeta } from './apiClient';

/** A refusal the screen should explain rather than report as a fault. */
export interface Refusal {
  code: string;
  message: string;
}

export interface Query {
  page?: number;
  limit?: number;
  q?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  [key: string]: string | number | undefined;
}

export interface Collection<T> {
  rows: T[];
  meta: PageMeta | null;
  loading: boolean;
  /** A 500 or a network failure — the state where retrying makes sense. */
  error: string | null;
  /** A deliberate refusal: no module, no subscription, no permission. */
  refusal: Refusal | null;
  reload: () => void;
}

/*
 * The codes the guards actually raise, read out of the middleware rather than guessed.
 *
 * `FORBIDDEN` is `ApiError.forbidden()`'s default and is **not** what a permission refusal carries:
 * `authorize.js:135` raises `INSUFFICIENT_PERMISSION` and `:198` raises `PLATFORM_SCOPE_REQUIRED`.
 * Listing only `FORBIDDEN` made the refusal branch unreachable for the single most likely refusal on
 * a dashboard — a role without the permission got a red error banner and a "Try again" button that
 * could never succeed, on every screen at once. `FORBIDDEN` is kept because other call sites do use
 * the default.
 *
 * `scripts/verify-frontend.js` asserts this set against the codes the middleware raises, so it
 * cannot drift again.
 */
export const EXPLAINED_CODES = new Set([
  /* entitlement.js — the plan does not cover this */
  'MODULE_NOT_SUBSCRIBED',
  'FEATURE_NOT_SUBSCRIBED',
  'SUBSCRIPTION_INACTIVE',
  'PLAN_LIMIT_EXCEEDED',
  /* authorize.js — the caller is not permitted this */
  'INSUFFICIENT_PERMISSION',
  'INSUFFICIENT_ROLE',
  'PLATFORM_SCOPE_REQUIRED',
  'FORBIDDEN',
  /* entitlement.js — the request did not say which school, or said too many */
  'SCHOOL_CONTEXT_REQUIRED',
  'MULTIPLE_SCHOOL_CONTEXT',
  /*
   * Raised by a **service** rather than by a guard — `exams.service.js` refuses
   * `GET /exams/my-results?student_id=` for a student not linked to the caller. It is a refusal by
   * every test that matters (retrying cannot help, and the remedy belongs to the school office), so
   * it is explained rather than reported as an error.
   *
   * `verify-frontend.js` scans `authorize.js` and `entitlement.js` for codes and so would never have
   * required this one. Noted here because that assertion's silence is not evidence of completeness:
   * any service is free to raise its own code.
   */
  'STUDENT_NOT_LINKED',
  /*
   * Three more raised by services, for the same reason and found the same way — by reading the
   * screens rather than the guards.
   *
   * A parent or teacher whose account has no linked profile row, or whose profile has been
   * deactivated, meets a **permanent structural condition**: `parents.service.js` and
   * `teachers.service.js` raise these when the signed-in user has no `parents`/`teachers` record, or
   * has one that is inactive. Retrying cannot change any of them and the remedy belongs to the
   * school office, which is exactly the test this set applies.
   *
   * Left out, they rendered as "Something went wrong" with a **Try again** button — the worst
   * possible answer, because the one thing that cannot help is trying again, and the message says
   * nothing about who can fix it. The dashboards for both roles are the *only* screen those accounts
   * have, so this was the whole product for them.
   */
  'PARENT_PROFILE_MISSING',
  'PARENT_INACTIVE',
  'TEACHER_PROFILE_MISSING',
]);

/**
 * Load one page of a collection.
 *
 * @param path   the API path below the prefix, e.g. `/schools`
 * @param query  filters and pagination; a change to any value refetches
 */
export function useCollection<T>(path: string, query: Query = {}): Collection<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  /*
   * The query is an object literal at every call site, so it is a new reference on every render and
   * cannot go in the dependency array directly — it would refetch forever. Serialising it compares
   * by value, which is what "the query changed" actually means.
   */
  /*
   * `q` is truncated to the length the API accepts. `commonSchemas.search` is
   * `Joi.string().trim().allow('').max(120)` (`validate.js:157`), so a longer value is refused with
   * a 422 — and `VALIDATION_ERROR` is not one of the explained codes, so it would surface as a red
   * error banner with a "Try again" button that is guaranteed to fail identically, because the
   * offending text is still in the box.
   *
   * Truncating is the better failure: the user gets results for the first 120 characters of what
   * they pasted, rather than an error about a limit no screen told them about. Done here rather than
   * with `maxLength` on each input so that a screen which forgets the attribute is still safe.
   */
  const key = JSON.stringify(
    typeof query.q === 'string' && query.q.length > 120
      ? { ...query, q: query.q.slice(0, 120) }
      : query
  );
  const stableQuery = useMemo(() => JSON.parse(key) as Query, [key]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    setLoading(true);
    setError(null);
    setRefusal(null);

    (async () => {
      try {
        const result = await api.page<T[]>(path, { query: stableQuery, signal: controller.signal });
        if (controller.signal.aborted || !mounted.current) return;
        setRows(result.data ?? []);
        setMeta(result.meta ?? null);
      } catch (caught) {
        if (controller.signal.aborted || !mounted.current) return;

        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
          setRows([]);
          setMeta(null);
        } else if (caught instanceof ApiError) {
          setError(caught.message);
        } else {
          /*
           * An abort surfaces here as a DOMException. It is not a failure — the request was replaced
           * by a newer one — and reporting it would flash an error every time the user typed.
           */
          if ((caught as Error)?.name === 'AbortError') return;
          setError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted && mounted.current) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [path, stableQuery, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { rows, meta, loading, error, refusal, reload };
}
