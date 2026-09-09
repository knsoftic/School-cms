'use client';

/**
 * The session — `docs/ARCHITECTURE.md` §8's `AuthProvider`.
 *
 * Holds the access token in memory and recovers the session on reload through the httpOnly refresh
 * cookie. Nothing about the user is persisted client-side: a reload calls `GET /auth/me`, which is
 * the authoritative answer, rather than trusting a copy of it that could be days stale or edited.
 *
 * ## The permissions claim is for navigation, not authorization
 *
 * `/auth/me` returns `permissions`, and `backend/src/utils/tokens.js` says in its own words that the
 * claim exists **for navigation only** — the server re-reads permissions from the database before
 * acting on any request. So `can()` below decides what to *render*, never what is *allowed*. Hiding
 * a button is a courtesy to the user; the refusal that matters happens in Express. Any screen that
 * treated `can()` as a security boundary would be wrong about where the boundary is.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api, setAccessToken, setSessionLostHandler, clearCsrfToken, setCsrfToken, ApiError } from './apiClient';
import { resetSchoolNames } from './useSchoolNames';

/** The user, as `PUBLIC_USER_FIELDS` in `auth.service.js` defines it. */
export interface User {
  id: number;
  name: string;
  email: string;
  username: string | null;
  phone: string | null;
  avatar_path: string | null;
  status: string;
  locale: string | null;
  organization_id: number | null;
  school_id: number | null;
  role_id: number;
  email_verified_at: string | null;
  last_login_at: string | null;
  must_change_password: boolean;
}

/** The tenant scope `resolveTenant` decided for this caller. */
export interface Tenant {
  level: string;
  organizationId: number | null;
  schoolId: number | null;
  isPlatform: boolean;
}

export interface Profile {
  user: User;
  permissions: string[];
  tenant: Tenant;
  /*
   * The school's entitlement snapshot, or null for a platform or organization caller.
   * `auth.service.js` `callerEntitlements()` builds it; `EntitlementProvider` reads it from here
   * rather than fetching separately, so it can never drift from the permissions beside it.
   */
  entitlements: unknown;
}

interface LoginResult {
  accessToken: string;
  user?: User;
  /**
   * The rotated CSRF token. `publishSession()` mints a fresh one and re-sets the cookie on login,
   * refresh and change-password, then returns it here — so a client that does not adopt it holds a
   * header that no longer matches the cookie, and every later POST is refused 403. See
   * `setCsrfToken` in `apiClient.ts` for what that actually broke.
   */
  csrfToken?: string;
}

/**
 * What a successful `POST /auth/login` leaves the client in.
 *
 * Two outcomes, because the backend has two: an authenticated session, or a valid session that may
 * do exactly one thing until the password is changed. A discriminated union rather than a nullable
 * profile, so a caller cannot forget the second case — there is no profile to read in it.
 */
export type LoginResultState =
  | { status: 'authenticated'; profile: Profile }
  | { status: 'must-change-password' };

interface AuthState {
  profile: Profile | null;
  /** True until the first refresh attempt settles, so a guard does not redirect mid-recovery. */
  loading: boolean;
  login: (identifier: string, password: string) => Promise<LoginResultState>;
  changePassword: (currentPassword: string, password: string) => Promise<Profile>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  can: (...permissions: string[]) => boolean;
  canAny: (...permissions: string[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  /*
   * Strict mode runs effects twice in development. Without this the bootstrap fires two refreshes
   * with the same cookie — and the backend treats a reused refresh token as theft and ends the
   * session (`auth.service.js:424-430`). The bug would appear only in development, which is the
   * worst place for a bug that looks like "logging in immediately logs me out".
   */
  const bootstrapped = useRef(false);

  const loadProfile = useCallback(async () => {
    const next = await api.get<Profile>('/auth/me');
    setProfile(next);
    return next;
  }, []);

  const clear = useCallback(() => {
    setAccessToken(null);
    clearCsrfToken();
    setProfile(null);
    /*
     * The school-name lookup is a module-level cache, so it outlives the React tree that filled it.
     * Clearing it here — the one choke point both an explicit logout and a lost session pass through —
     * is what stops one tenant's school names being readable after the next sign-in.
     */
    resetSchoolNames();
  }, []);

  /* When a refresh fails inside the client, the session is gone; drop the profile with it. */
  useEffect(() => {
    setSessionLostHandler(() => clear());
    return () => setSessionLostHandler(null);
  }, [clear]);

  /*
   * Recover the session on first mount. A 401 here is the ordinary "not signed in" case, not an
   * error worth surfacing — the page simply renders as logged out.
   */
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    (async () => {
      try {
        await loadProfile();
      } catch {
        clear();
      } finally {
        setLoading(false);
      }
    })();
  }, [loadProfile, clear]);

  const login = useCallback<AuthState['login']>(
    async (identifier, password) => {
      const result = await api.post<LoginResult>('/auth/login', { identifier, password });
      setAccessToken(result.accessToken);
      /* Signing in rotated the CSRF cookie; without this the header keeps the pre-login value. */
      setCsrfToken(result.csrfToken);

      /*
       * The profile is fetched rather than taken from the login response. `/auth/me` is the one
       * endpoint that returns permissions, the resolved tenant and the entitlements together, and a
       * screen that rendered from the login payload would have none of them.
       *
       * ## Why this returns a result rather than a profile
       *
       * A user with `must_change_password` set cannot call `/auth/me` at all.
       * `enforcePasswordChange` is mounted at the boundary with the allow-list
       * `['/auth/change-password', '/auth/logout']`, so their very next request after a *successful*
       * login is refused with `PASSWORD_CHANGE_REQUIRED`.
       *
       * The first version of this checked `profile.user.must_change_password` after loading the
       * profile, which is unreachable: the load throws first. Running it proved it —
       * `POST /auth/login → 200` followed by `GET /auth/me → 403`, and the sign-in form showed
       * "You must change your password before continuing" as though the credentials had been
       * rejected. They had not. The seeded Super Admin ships with the flag set, so this was the
       * state of the very first login anyone would attempt.
       */
      try {
        const profile = await loadProfile();
        return { status: 'authenticated', profile };
      } catch (error) {
        if (error instanceof ApiError && error.code === 'PASSWORD_CHANGE_REQUIRED') {
          /* The login succeeded; the token is valid and is what /auth/change-password will need. */
          return { status: 'must-change-password' };
        }
        setAccessToken(null);
        throw error;
      }
    },
    [loadProfile]
  );

  /*
   * The forced password change, and the one call a `must_change_password` account may make besides
   * logout. `publishSession` hands back a fresh access token in the same response — deliberately, so
   * the session doing the change survives it (every *other* session is ended, which is the point).
   * Adopting that token is what makes the very next `/auth/me` succeed; without it the caller would
   * still hold the pre-change token, which `tokenPredatesPasswordChange()` now refuses.
   */
  const changePassword = useCallback(async (currentPassword: string, password: string) => {
    const session = await api.post<LoginResult>('/auth/change-password', { currentPassword, password });
    setAccessToken(session.accessToken);
    /* Same rotation as login — `publishSession()` runs on this route too. */
    setCsrfToken(session.csrfToken);
    return loadProfile();
  }, [loadProfile]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      /*
       * A logout that fails server-side must still clear the client. The common cause is an access
       * token that expired while the tab sat open, and refusing to sign out because the session was
       * already gone is the wrong answer to give a user asking to sign out.
       */
      if (!(error instanceof ApiError)) throw error;
    } finally {
      clear();
    }
  }, [clear]);

  const permissionSet = useMemo(() => new Set(profile?.permissions ?? []), [profile]);

  const can = useCallback(
    (...permissions: string[]) => permissions.every((key) => permissionSet.has(key)),
    [permissionSet]
  );

  const canAny = useCallback(
    (...permissions: string[]) => permissions.some((key) => permissionSet.has(key)),
    [permissionSet]
  );

  const value = useMemo<AuthState>(
    () => ({ profile, loading, login, logout, changePassword, reload: () => loadProfile().then(() => undefined), can, canAny }),
    [profile, loading, login, logout, changePassword, loadProfile, can, canAny]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth() must be used inside <AuthProvider>');
  return context;
}
