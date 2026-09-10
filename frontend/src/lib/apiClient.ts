/**
 * The API client — SRS §4, §30, and `docs/ARCHITECTURE.md` §8.
 *
 * One place that knows how to talk to the backend, because three things about that conversation are
 * easy to get subtly wrong in each of thirty-three screens and impossible to get wrong once:
 *
 *   1. **The envelope.** Every response is `{ success, data, meta? }` or `{ success:false, error }`
 *      (`backend/src/utils/ApiResponse.js`, `middlewares/errorHandler.js`). A screen wants `data`,
 *      not the wrapper, and it wants a failure to be a thrown error rather than a falsy `success`
 *      flag someone forgot to check.
 *   2. **401 refresh-and-retry.** The access token is short-lived and held in memory; the refresh
 *      token is an httpOnly cookie the browser sends on its own. When a call 401s, exactly one
 *      refresh must happen — not one per concurrent request — and the original call is then retried.
 *   3. **CSRF.** The backend runs a double-submit check (`middlewares/csrf.js`), so a mutating call
 *      needs the token from `GET /csrf-token` echoed in a header.
 *
 * ## What this file deliberately does not do
 *
 * It does not decide what a user may see. The access token carries a `permissions` claim, and the
 * backend's own comment on that claim says it exists **for navigation only** — the server always
 * re-reads permissions from the database before acting. So this client never treats a permission as
 * authorization; `AuthProvider` uses the claim to choose what to render, and the API remains the only
 * thing that decides what happens. A UI that hid a button would still be talking to a server that
 * refuses the call.
 */

/** The success envelope, as `ApiResponse` builds it. */
export interface ApiEnvelope<T> {
  success: true;
  data: T;
  /* The wire shape: pagination is nested, and other meta keys may sit beside it. */
  meta?: { pagination?: PageMeta } & Record<string, unknown>;
  message?: string;
}

/**
 * Pagination, as `ApiResponse.paginated` actually sends it.
 *
 * The envelope nests this: `{ meta: { pagination: { … } } }` (`ApiResponse.js:45-55`), not
 * `{ meta: { page, … } }`. The first version of this client read the shallow shape, so every field
 * came back `undefined` — and nothing caught it, because every collection in this environment holds
 * at most one page, and `<Pagination>` returns null on a single page. The footer that would have
 * shown the mistake was never rendered. Found by an adversarial review of the generated screens.
 *
 * `hasNextPage` / `hasPreviousPage` are the server's own answers and are used in preference to
 * comparing `page` against `totalPages`: the server knows about a row inserted since this page was
 * fetched, and the arithmetic here does not.
 */
export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** One field that failed validation, as the 422 body carries it. */
export interface FieldError {
  field: string;
  location: 'body' | 'query' | 'params' | 'headers';
  message: string;
  type: string;
}

/**
 * A failed API call.
 *
 * Carries the backend's own `code` rather than only a message, because the codes are the stable part
 * of the contract and several of them need distinct handling in the UI: `PASSWORD_CHANGE_REQUIRED`
 * redirects, `MODULE_NOT_SUBSCRIBED` explains rather than errors, `PLAN_LIMIT_EXCEEDED` offers an
 * upgrade, and `VALIDATION_ERROR` belongs on the fields rather than in a banner.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: FieldError[];
  /**
   * The object-shaped `details` a conflict carries — `{ conflict, with }` from a timetable clash,
   * `{ conflicts_with }` from a grade band, `{ blocking }` from a subject still in use. Kept beside the
   * normalised `details` rather than dropped, so a screen can say *which* entry clashed instead of
   * only that one did. `null` when the API sent an array or nothing.
   */
  readonly context: Record<string, unknown> | null;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, details: unknown = [], requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    /*
     * `details` is normalised here because the API sends **two different shapes** under that key, and
     * only one of them is the array this type claims.
     *
     * `validate.js` sends the array of `{ field, message, type }` this class was written for. But
     * `errorHandler.js` sends a plain **object** for several codes — `DUPLICATE_RECORD`
     * (`{ fields }`), `FOREIGN_KEY_VIOLATION`, an upload's `{ field }`, and services raise their own,
     * such as `SCHOOL_CODE_TAKEN` with `{ code, organization_id }`.
     *
     * Before this, an object went straight through: `body?.error?.details ?? []` does not replace it
     * (an object is not nullish), the declared `FieldError[]` type was simply wrong at runtime, and
     * `fieldErrors()` then ran `for…of` over it and threw **"details is not iterable"** — *inside the
     * catch block of every form*. So the most ordinary create failure there is, a duplicate code,
     * produced an unhandled exception instead of "that code is taken".
     *
     * Anything that is not an array of field errors is dropped rather than coerced: those objects
     * carry diagnostic context, not per-field messages, and the top-level `message` already says what
     * went wrong. A form with no field errors shows that message, which is the right outcome.
     */
    this.details = Array.isArray(details)
      ? (details as unknown[]).filter(
          (d): d is FieldError =>
            typeof d === 'object' && d !== null
            && typeof (d as FieldError).field === 'string'
            && typeof (d as FieldError).message === 'string'
        )
      : [];
    this.context =
      details && typeof details === 'object' && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : null;
    this.requestId = requestId;
  }

  /**
   * Field errors keyed by field name, for a form to render beside its inputs.
   *
   * Entries with an **empty** field are excluded, and `formErrors()` returns them instead. A Joi
   * `.custom()` on the whole object — "expires_at must be after starts_at", "billing_period_end must
   * be after billing_period_start" — reports with `path: []`, which `validate.js:91` turns into
   * `field: ""`. Those used to land here under the `''` key, where no input renders them; worse, the
   * form then saw a non-empty map and suppressed its banner as well, so the message **disappeared
   * completely** and a rejected submit looked like nothing had happened.
   */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const detail of this.details) {
      if (!detail.field) continue;
      if (!(detail.field in out)) out[detail.field] = detail.message;
    }
    return out;
  }

  /**
   * Validation messages that belong to no single field — whole-object rules, which have nowhere to sit
   * but the top of the form. Empty for most failures; never silently dropped.
   */
  formErrors(): string[] {
    return this.details.filter((detail) => !detail.field).map((detail) => detail.message);
  }

  /**
   * The message a form should show at its top, given the fields it actually renders an input for.
   *
   * ## Why a form cannot decide this from `details.length` alone
   *
   * The obvious rule is `setError(caught.details.length ? null : caught.message)` — suppress the
   * banner when the fields will carry the message instead. That is right only when **every** field
   * error names an input the form renders, and `reset-password` is the case where it is not:
   * `resetPassword` validates `{ token, password }`, and the token is a credential from an emailed
   * link that the page deliberately never puts in a field. A token mangled by a mail client came
   * back as a 422 whose only error named `token`, `details.length` was 1, the banner was suppressed,
   * and there was no input to render it — so pressing "Set new password" produced **no visible
   * output at all** and the server's "This link is not valid." was discarded.
   *
   * This is the same failure `fieldErrors()` above already records for whole-object rules, one step
   * along: there, the field was empty; here it is named, and named a thing the form has no box for.
   *
   * @param renderedFields the field names this form has an input for, and will show an error beside
   * @returns the banner text, or `null` when a rendered field will carry the message
   */
  bannerFor(renderedFields: string[]): string | null {
    /* A whole-object rule has nowhere else to go, so it wins. */
    const [formError] = this.formErrors();
    if (formError) return formError;

    const perField = Object.entries(this.fieldErrors());
    if (perField.length === 0) return this.message;

    const rendered = new Set(renderedFields);
    const orphan = perField.find(([field]) => !rendered.has(field));
    /* Something named a field this form cannot show; say it at the top rather than lose it. */
    if (orphan) return orphan[1];

    /* Every error has an input waiting for it. */
    return null;
  }
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

/* ─────────────────────────── the in-memory access token ─────────────────────────── */

/*
 * In memory, never in `localStorage`. A token in local storage is readable by any script that
 * reaches the page, and it survives a tab the user thought they had closed. The refresh token is an
 * httpOnly cookie, which no script can read, so a page reload recovers the session by refreshing
 * rather than by having stored anything sensitive.
 */
let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Called when refreshing fails, so `AuthProvider` can clear state and route to /login. */
export function setSessionLostHandler(handler: (() => void) | null): void {
  onSessionLost = handler;
}

/* ─────────────────────────────────── CSRF ─────────────────────────────────── */

let csrfToken: string | null = null;

const CSRF_HEADER = 'X-CSRF-Token';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Fetch and cache the CSRF token.
 *
 * `/csrf-token` is public — deliberately, so a reloaded page holding only a refresh cookie can
 * bootstrap before it has an access token.
 */
async function ensureCsrfToken(): Promise<string | null> {
  if (csrfToken) return csrfToken;

  const response = await fetch(`${API_URL}/csrf-token`, { credentials: 'include' });
  if (!response.ok) return null;

  /*
   * `data.token`, not `data.csrfToken`. `system.routes.js:34-35` is
   * `ApiResponse.ok(res, { token: req.csrfToken || null })` — the property is named for the payload
   * it sits in, not for the middleware that produced it. Guessing `csrfToken` here would have made
   * every mutating call fail its double-submit check with a 403 that named CSRF and looked like a
   * cookie problem.
   */
  const body = (await response.json()) as ApiEnvelope<{ token: string | null }>;
  csrfToken = body.data?.token ?? null;
  return csrfToken;
}

/** Discard the cached CSRF token, so the next mutating call fetches a fresh one. */
export function clearCsrfToken(): void {
  csrfToken = null;
}

/**
 * Adopt a CSRF token the server has just rotated.
 *
 * ## Why this has to exist
 *
 * `issueCsrfToken()` mints a **new** value and re-sets the cookie every time it is called, and
 * `auth.controller.js publishSession()` calls it on login, on refresh and on change-password —
 * returning the new value as `body.csrfToken`, with the comment *"Rotated with the session, so a
 * client that just signed in can immediately POST."*
 *
 * The client never read it. `ensureCsrfToken()` caches the value it fetched from `/csrf-token`
 * before signing in and `if (csrfToken) return csrfToken;` then holds it forever, so from the moment
 * of login the cookie and the header disagreed. `requireCsrfToken()` compares the two and refuses a
 * mismatch, and it guards both `POST /auth/refresh` and `POST /auth/logout`.
 *
 * Measured, not reasoned: signing out through the account menu produced
 * `POST /api/v1/auth/logout → 403 Forbidden`. The UI still went to `/login`, because `clear()` runs
 * in a `finally` — so it *looked* like signing out worked while the server never ended the session,
 * leaving `refresh_token_hash` set and the httpOnly refresh cookie valid. The same mismatch refuses
 * the refresh, so a session also died at the first access-token expiry instead of renewing.
 *
 * The server was already correct and complete here; this is the client half that was missing.
 */
export function setCsrfToken(token: string | null | undefined): void {
  if (token) csrfToken = token;
}

/* ─────────────────────────── the single-flight refresh ─────────────────────────── */

/*
 * One refresh at a time, shared by every caller that 401s.
 *
 * A dashboard fires several requests on mount. If the access token has expired they all 401 at once,
 * and a per-request refresh would send N refresh calls with the same cookie. The backend rotates the
 * refresh token on every use and **treats reuse of an old one as theft** — it ends the session
 * (`REFRESH_TOKEN_REUSED` in `auth.service.js`). So the naive version does not merely waste calls:
 * it logs the user out, and only when the page is busy, which is the hardest kind of bug to see.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      /*
       * The CSRF header is required here too, and forgetting it is not a small bug.
       *
       * `/auth/refresh` is a POST, so `requireCsrfToken()` guards it exactly as it guards every
       * other mutating call — `verify-auth-module.js` asserts "without the CSRF header it is 403".
       * This function bypasses `request()` (it must: a 401 from the refresh call cannot itself
       * trigger a refresh), so it has to repeat the header rather than inherit it.
       *
       * Measured, not reasoned: the first version omitted it, and the browser log showed
       * `POST /auth/refresh → 403`. Every expiring session would have been logged out instead of
       * renewed, and only after the access token's lifetime had elapsed — long enough after login
       * that it would not look related to this code at all.
       */
      const csrf = await ensureCsrfToken();

      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
        },
      });

      if (!response.ok) return false;

      const body = (await response.json()) as ApiEnvelope<{
        accessToken: string;
        csrfToken?: string;
      }>;
      const token = body.data?.accessToken;
      if (!token) return false;

      accessToken = token;
      /*
       * The refresh rotated the CSRF cookie too — `publishSession()` runs on this route as well. Not
       * adopting it here is what made the desync re-form on every page reload, because the bootstrap
       * refresh rotates the cookie while this cache keeps the value it fetched a moment earlier.
       */
      setCsrfToken(body.data?.csrfToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/* ─────────────────────────────────── the request ─────────────────────────────────── */

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Set for `FormData` uploads, where the browser must choose the boundary itself. */
  formData?: FormData;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'UNKNOWN';
  let message = response.statusText || 'Request failed';
  let details: FieldError[] = [];
  let requestId: string | undefined;

  /*
   * A failure that is not JSON is still a failure. nginx's own 502 or 504 arrives as HTML, and a
   * client that assumed an envelope would throw a SyntaxError naming the wrong problem entirely.
   */
  try {
    const body = await response.json();
    code = body?.error?.code ?? code;
    message = body?.error?.message ?? message;
    details = body?.error?.details ?? [];
    requestId = body?.requestId;
  } catch {
    /* keep the status-derived message */
  }

  return new ApiError(response.status, code, message, details, requestId);
}

/**
 * Perform one API call, returning `data` and throwing `ApiError` on failure.
 *
 * @param path   path below the API prefix, e.g. `/students`
 * @param options
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    let payload: BodyInit | undefined;
    if (options.formData) {
      payload = options.formData; /* no Content-Type: the browser sets the multipart boundary */
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }

    if (MUTATING.has(method)) {
      const token = await ensureCsrfToken();
      if (token) headers[CSRF_HEADER] = token;
    }

    return fetch(buildUrl(path, options.query), {
      method,
      headers,
      body: payload,
      credentials: 'include',
      signal: options.signal,
    });
  };

  let response = await send();

  /*
   * Retried once, and only for 401. A 403 is a decision the server has made about a caller it
   * successfully identified — refreshing changes nothing and retrying would just ask twice.
   */
  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      response = await send();
    } else {
      accessToken = null;
      clearCsrfToken();
      onSessionLost?.();
    }
  }

  if (!response.ok) throw await toApiError(response);

  if (response.status === 204) return undefined as T;

  const body = (await response.json()) as ApiEnvelope<T>;
  return body.data;
}

/** A collection call, where `meta` is wanted alongside the rows. */
export async function requestPage<T>(
  path: string,
  options: RequestOptions = {}
): Promise<{ data: T; meta: PageMeta | null }> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const url = buildUrl(path, options.query);
  let response = await fetch(url, { method, headers, credentials: 'include', signal: options.signal });

  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      const retryHeaders: Record<string, string> = {};
      if (accessToken) retryHeaders.Authorization = `Bearer ${accessToken}`;
      response = await fetch(url, { method, headers: retryHeaders, credentials: 'include', signal: options.signal });
    } else {
      accessToken = null;
      clearCsrfToken();
      onSessionLost?.();
    }
  }

  if (!response.ok) throw await toApiError(response);

  const body = (await response.json()) as ApiEnvelope<T>;
  /* Unwrapped here, once, so no screen has to know the envelope nests it. */
  return { data: body.data, meta: body.meta?.pagination ?? null };
}

/* ─────────────────────────────── binary downloads ─────────────────────────────── */

/**
 * One downloaded file: the bytes, and the name the server chose for them.
 */
export interface DownloadedFile {
  blob: Blob;
  filename: string;
}

/**
 * Parse the filename out of a `Content-Disposition` header.
 *
 * The server sends `attachment; filename="report-student-2026-09-05.xlsx"`
 * (`reports.controller.js:31-35`). RFC 5987's `filename*=UTF-8''…` form is read first when present,
 * because a server that sends both intends that one to win; neither this API nor any other in the
 * project sends it today, and handling it costs three lines.
 *
 * The result is passed through `basename` semantics before it is used: a header is attacker-shaped
 * input in the general case, and a filename containing `../` or a drive letter has no business
 * reaching a save dialog.
 */
function filenameFrom(header: string | null, fallback: string): string {
  if (!header) return fallback;

  let name: string | null = null;
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended) {
    try {
      name = decodeURIComponent(extended[1]);
    } catch {
      name = null;
    }
  }
  if (!name) {
    const plain = /filename="?([^";]+)"?/i.exec(header);
    if (plain) name = plain[1];
  }
  if (!name) return fallback;

  /* Path separators of either flavour, and any leading dots, are stripped rather than escaped. */
  const base = name.split(/[\\\/]/).pop() ?? '';
  const cleaned = base.replace(/^\.+/, '').trim();
  return cleaned || fallback;
}

/**
 * Fetch a binary response — an Excel workbook or a PDF — rather than a JSON envelope.
 *
 * `request()` cannot serve this: it ends unconditionally in `await response.json()`, so every export
 * the server has built since Phase 5.4 had **no reachable caller in the UI**. The documented
 * workaround — typing `?format=excel` into the address bar — does not work either, because the access
 * token lives in memory and travels as an `Authorization` header, so a pasted URL is unauthenticated.
 *
 * The bearer header and the single-flight 401 refresh are the same ones `request()` uses, deliberately
 * repeated rather than abstracted: the difference between the two functions is one line at the end,
 * and a shared "parse or don't" flag would make the common path harder to read than both.
 *
 * A **failure** still arrives as JSON — `errorHandler.js` never sends a binary error — so the error
 * path goes through `toApiError()` exactly as everywhere else, and a 403 from `reports.export` reads
 * the same here as on any other call.
 */
export async function download(
  path: string,
  options: Omit<RequestOptions, 'method' | 'body' | 'formData'> = {},
  fallbackFilename = 'download'
): Promise<DownloadedFile> {
  const url = buildUrl(path, options.query);

  const send = (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return fetch(url, { method: 'GET', headers, credentials: 'include', signal: options.signal });
  };

  let response = await send();

  if (response.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      response = await send();
    } else {
      accessToken = null;
      clearCsrfToken();
      onSessionLost?.();
    }
  }

  if (!response.ok) throw await toApiError(response);

  return {
    blob: await response.blob(),
    filename: filenameFrom(response.headers.get('Content-Disposition'), fallbackFilename),
  };
}

/**
 * Hand a fetched file to the browser's save flow.
 *
 * Split from `download()` so the fetch can be unit-reasoned without a DOM, and so a caller that wants
 * the bytes for something other than saving is not forced through an anchor click.
 *
 * `revokeObjectURL` is deferred rather than called immediately: revoking in the same tick races the
 * navigation the click starts, and the failure mode is a silently empty file.
 */
export function saveFile(file: DownloadedFile): void {
  const href = URL.createObjectURL(file.blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = file.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
  page: requestPage,
  download,
};

export { API_URL };
