'use client';

/**
 * The application shell — sidebar, top bar, and the frame every signed-in screen sits in.
 *
 * ## What changed and why
 *
 * The previous shell painted the sidebar with a hard-coded dark ink and teal text. That reads as one
 * deliberate choice in light mode and as an accident in dark mode, where `--ink` IS the text colour —
 * the sidebar would have become light-on-light. The sidebar is now a surface like any other and takes
 * its contrast from elevation and a border, which is what lets one set of tokens serve both themes.
 *
 * Mobile was `hidden` / `block`: the panel appeared in the flow, pushed the page down, could not be
 * dismissed by tapping away or pressing Escape, and left focus behind it. It is now a real drawer —
 * an overlay, a slide, Escape, click-away, focus moved into it on open and returned to the trigger on
 * close, and `aria-modal` so a screen reader treats the page behind it as inert.
 *
 * ## Active state
 *
 * A rail on the leading edge plus a surface change, not colour alone — the same reason a status is
 * never only red or only green. `aria-current="page"` carries it for anyone not looking.
 *
 * ## The school's own name, logo and currency — the owner's decision D35
 *
 * FR-SCHOOL-001's settings were stored and applied nowhere; D35 has the school's name, logo and
 * currency "appear on its screens and documents". The shell is where every school screen is framed,
 * so it shows two of them: the top bar and the drawer carry the school's name and logo in place of the
 * product's. `useSchoolBrand()` offers the same three to any screen that prints one — the school
 * invoice's School field reads the name through it.
 *
 * They come from the profile — `school` on `GET /auth/me`, `SchoolProfile` in `lib/auth.tsx`. The
 * shell used to read `GET /school-settings`, which answers to `school.settings.view`, held by the
 * Principal and the School Admin alone, so an Accountant, a Receptionist, a Teacher or a Parent saw the
 * product's name over their own school's screens. `/auth/me` carries the name, logo and currency to
 * every school role; a caller with no school in scope has `school: null` and keeps the product's name.
 * The settings screen reloads the profile after a save, so a name or logo just changed there is the
 * one shown next. `logo_path` is an absolute http(s) URL (`settings.validation.js brandingUrl()`),
 * rendered as a plain `<img>`; one that fails to load leaves the name standing.
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Icon } from '@/components/icon';
import { Dropdown, DropdownItem } from '@/components/overlay';
import { ThemeToggle } from '@/components/theme';
import { useToast } from '@/components/toast';
import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useEntitlements } from '@/lib/entitlements';
import { visibleNav, landingRouteFor } from '@/lib/nav';
import type { NavSection } from '@/lib/nav';

/** Each portal's dashboard route: every other route of that portal starts with it. See `NavList`. */
const DASHBOARD_ROOTS = new Set(['/school', '/super-admin', '/teacher', '/parent', '/student']);

/* ─────────────────────────── the school's own settings — D35 ─────────────────────────── */

/** The three §14.1 settings D35 applies. Each is null when there is nothing to apply. */
export interface SchoolBrand {
  name: string | null;
  logoUrl: string | null;
  currency: string | null;
}

/**
 * The school's name, logo and currency, from the profile — see D35 in the header.
 *
 * All three are null for a caller with no school in scope, and the currency is null for a school that
 * has never saved its settings too, so a consumer treats null as "keep this screen's own default" and
 * never as a value.
 */
export function useSchoolBrand(): SchoolBrand {
  const { profile } = useAuth();
  const school = profile?.school ?? null;
  const name = school?.name?.trim() || null;
  const logoUrl = school?.logo_path || null;
  const currency = school?.currency?.trim() || null;
  return useMemo(() => ({ name, logoUrl, currency }), [name, logoUrl, currency]);
}

/** The product's own name — what the top bar shows when there is no school name to show. */
function ProductMark({ tagline }: { tagline?: boolean }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="font-display text-lg font-semibold tracking-tight text-ink">MSMS</span>
      {tagline ? (
        <span className="hidden text-2xs font-semibold uppercase tracking-[0.16em] text-muted-soft sm:inline">
          Multi-School
        </span>
      ) : null}
    </span>
  );
}

/**
 * The school's logo and name, falling back to the name when there is no logo or it will not load,
 * and to the product's name when the school has neither.
 *
 * Keyed by the logo's URL where it is used, so a new logo gets a fresh attempt rather than inheriting
 * the last one's failure.
 */
function SchoolMark({ brand, tagline }: { brand: SchoolBrand; tagline?: boolean }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const logo = brand.logoUrl && !logoFailed ? brand.logoUrl : null;

  if (!brand.name && !logo) return <ProductMark tagline={tagline} />;

  return (
    <span className="flex min-w-0 items-center gap-2">
      {logo ? (
        /*
         * A plain `<img>`: the URL is whatever host the school's logo lives on, and `next/image` would
         * need every such host allow-listed in `next.config.mjs` before it rendered anything.
         */
        // eslint-disable-next-line @next/next/no-img-element -- a URL the school set, on a host this app cannot know
        <img
          src={logo}
          /* Decorative when the name is written beside it — otherwise a screen reader says it twice. */
          alt={brand.name ? '' : 'School logo'}
          referrerPolicy="no-referrer"
          onError={() => setLogoFailed(true)}
          className="h-7 w-auto max-w-[7rem] shrink-0 object-contain"
        />
      ) : null}
      {brand.name ? (
        <span className="truncate font-display text-lg font-semibold tracking-tight text-ink">
          {brand.name}
        </span>
      ) : null}
    </span>
  );
}

function SubscriptionNotice() {
  const { entitlements, isUsable } = useEntitlements();
  /* `subscription` is nullable — a school may have none. `isUsable` is true in that case, so this
   * returns early anyway; the explicit check is here so the deref below cannot be reached. */
  if (isUsable || !entitlements || !entitlements.subscription) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-warn/25 bg-warn-soft px-4 py-2 text-sm text-warn"
    >
      <Icon name="alert-triangle" size={15} />
      <span>
        This school&rsquo;s subscription is <strong>{entitlements.subscription.state}</strong>. Some
        screens will refuse to load until it is renewed.
      </span>
    </div>
  );
}

/** Initials for the avatar. Two at most, so the circle never has to shrink its type. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function NavList({
  sections,
  pathname,
  onNavigate,
}: {
  sections: NavSection[];
  pathname: string;
  onNavigate?: () => void;
}) {
  if (sections.length === 0) {
    return (
      <div className="px-3 py-8 text-center">
        <Icon name="inbox" size={22} className="mx-auto text-muted-soft" />
        <p className="mt-3 text-sm font-medium text-ink">Nothing available yet</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          No screens are available to your account. This is usually a subscription that has not been
          activated.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 px-3 py-4">
      {sections.map((section) => (
        <div key={section.heading}>
          <h2 className="mb-1.5 px-2.5 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-soft">
            {section.heading}
          </h2>
          <ul className="space-y-px">
            {section.items.map((item) => {
              /*
               * An item is current on its own route and on every route below it, so `/school/exams`
               * stays lit on `/school/exams/12`. That includes a child that is a nav item of its
               * own: on `/school/classes/sections` both Classes and Sections are lit, and on
               * `/super-admin/plans/modules` both Plans and Modules. The dashboards are the one
               * exception, excluded from prefix matching entirely, since every route in their portal
               * starts with them — the teacher, parent and student portals now have screens of their
               * own below their dashboards, so "My children" lit up beside "Results" on
               * `/parent/results`.
               */
              const current =
                pathname === item.href ||
                (!DASHBOARD_ROOTS.has(item.href) && pathname.startsWith(`${item.href}/`));

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={current ? 'page' : undefined}
                    className={`group relative flex items-center gap-2.5 rounded-md py-2 pl-2.5 pr-2 text-sm transition-colors ${
                      current
                        ? 'bg-brand-subtle font-semibold text-brand-text'
                        : 'font-medium text-ink-soft hover:bg-surface-3 hover:text-ink'
                    }`}
                  >
                    {current ? (
                      <span
                        aria-hidden
                        className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand"
                      />
                    ) : null}
                    {item.icon ? (
                      <Icon
                        name={item.icon}
                        size={16}
                        className={current ? 'text-brand' : 'text-muted-soft group-hover:text-muted'}
                      />
                    ) : (
                      <span className="w-4" aria-hidden />
                    )}
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function AppShell({ nav, children }: { nav: NavSection[]; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { profile, loading, logout, can } = useAuth();
  const { hasModule } = useEntitlements();
  const { success, error } = useToast();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!loading && !profile) router.replace('/login');
  }, [loading, profile, router]);

  /* A route change closes the drawer — otherwise it stays open over the screen just navigated to. */
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  /* Escape, and focus into the drawer on open / back to the trigger on close. */
  useEffect(() => {
    if (!drawerOpen) return undefined;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';

    const firstLink = drawerRef.current?.querySelector<HTMLElement>('a, button');
    firstLink?.focus();

    /*
     * The trigger is captured **here**, not read in the cleanup.
     *
     * `react-hooks/exhaustive-deps` names the reason: a ref read during cleanup gives whatever the
     * ref points at when the drawer closes, which need not be the element that opened it. Focus
     * belongs on the control the user actually pressed, and capturing it at open is what guarantees
     * that. Found by the first ESLint run this frontend has had.
     */
    const trigger = triggerRef.current;

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      trigger?.focus();
    };
  }, [drawerOpen]);

  const sections = useMemo(() => visibleNav(nav, can, hasModule), [nav, can, hasModule]);

  /* D35 — the school's name and logo, from the profile. See the header. */
  const brand = useSchoolBrand();

  const signOut = useCallback(() => {
    logout().then(() => router.replace('/login'));
  }, [logout, router]);

  const [resending, setResending] = useState(false);
  const resendVerification = useCallback(async () => {
    if (resending) return;
    setResending(true);
    try {
      await api.post('/auth/resend-verification', {});
      success('Verification email sent', 'Check the inbox for the address on this account.');
    } catch (caught) {
      /*
       * Reported, never swallowed. The likeliest refusal is the rate limit on this route, and a
       * button that appears to do nothing is what sends someone to press it four more times.
       */
      error(
        'Could not send the email',
        caught instanceof ApiError ? caught.message : 'Check your connection and try again.'
      );
    } finally {
      setResending(false);
    }
  }, [resending, success, error]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <p className="font-display text-2xl font-semibold text-ink">MSMS</p>
          <div className="mt-4 flex items-center justify-center gap-2 text-sm text-muted">
            <span className="spinner inline-block h-3.5 w-3.5" aria-hidden />
            Loading your workspace…
          </div>
        </div>
      </div>
    );
  }

  if (!profile) return null;

  const home = landingRouteFor(profile);
  const roleLabel = profile.tenant.isPlatform
    ? 'Platform'
    : profile.tenant.schoolId
      ? 'School'
      : profile.tenant.organizationId
        ? 'Organization'
        : 'Account';

  return (
    <div className="min-h-screen">
      <SubscriptionNotice />

      <header className="app-topbar sticky top-0 z-30 h-14">
        <div className="flex h-full items-center gap-3 px-4">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
            aria-controls="app-nav"
            className="btn btn-ghost btn-icon btn-sm btn-mobile-only"
          >
            <Icon name="menu" size={18} />
            <span className="sr-only">Open navigation</span>
          </button>

          <Link href={home} className="flex min-w-0">
            <SchoolMark key={brand.logoUrl ?? ''} brand={brand} tagline />
          </Link>

          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle className="hidden sm:inline-flex" />

            <Dropdown
              label="Account"
              trigger={({ ref, ...props }) => (
                <button
                  ref={ref}
                  type="button"
                  {...props}
                  className="btn btn-ghost h-9"
                >
                  <span
                    aria-hidden
                    className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-2xs font-bold text-[var(--brand-contrast)]"
                  >
                    {initialsOf(profile.user.name)}
                  </span>
                  <span className="hidden max-w-[10rem] truncate text-sm font-medium sm:inline">
                    {profile.user.name}
                  </span>
                  <Icon name="chevron-down" size={14} className="text-muted" />
                </button>
              )}
            >
              <div className="border-b border-border-soft px-2.5 pb-2 pt-1">
                <p className="truncate text-sm font-semibold text-ink">{profile.user.name}</p>
                <p className="truncate text-xs text-muted">{profile.user.email}</p>
                <p className="mt-1 inline-flex rounded-full bg-surface-3 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-muted">
                  {roleLabel}
                </p>
              </div>
              <div className="pt-1 sm:hidden">
                <div className="px-2.5 py-1.5">
                  <ThemeToggle />
                </div>
              </div>
              {/*
                * Only for an unverified address, and only because the endpoint exists and nothing
                * called it.
                *
                * `POST /auth/resend-verification` is a real protected route taking an empty body,
                * and a grep of `frontend/src` for it returned **nothing** — so the copy on
                * `verify-email` telling the user to "request a new link from your profile" pointed
                * at a screen that does not exist and an action nothing could reach. There is no
                * profile screen to add it to; this menu is where the account's own actions already
                * live, which makes it the honest place for it.
                */}
              {profile.user.email_verified_at === null ? (
                <DropdownItem onClick={resendVerification}>
                  <Icon name="refresh" size={15} />
                  {resending ? 'Sending…' : 'Resend verification email'}
                </DropdownItem>
              ) : null}
              <DropdownItem href="/change-password">
                <Icon name="lock" size={15} />
                Change password
              </DropdownItem>
              <DropdownItem onClick={signOut} tone="danger">
                <Icon name="log-out" size={15} />
                Sign out
              </DropdownItem>
            </Dropdown>
          </div>
        </div>
      </header>

      <div className="md:flex">
        {/* Desktop rail. */}
        <nav
          aria-label="Main"
          className="app-sidebar sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 overflow-y-auto md:block"
        >
          <NavList sections={sections} pathname={pathname} />
        </nav>

        {/* Mobile drawer. Rendered only while open, so nothing focusable hides off-screen. */}
        {drawerOpen ? (
          <div className="fixed inset-0 z-40 md:hidden">
            <div
              className="animate-fade-in absolute inset-0 bg-[var(--overlay)]"
              onClick={() => setDrawerOpen(false)}
              aria-hidden
            />
            <div
              ref={drawerRef}
              id="app-nav"
              role="dialog"
              aria-modal="true"
              aria-label="Main navigation"
              className="animate-slide-in absolute inset-y-0 left-0 flex w-[17rem] max-w-[85vw] flex-col overflow-y-auto border-r border-border bg-surface-1 shadow-xl"
            >
              <div className="flex h-14 items-center justify-between gap-2 border-b border-border-soft px-4">
                <SchoolMark key={brand.logoUrl ?? ''} brand={brand} />
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="btn btn-ghost btn-icon btn-sm"
                >
                  <Icon name="x" size={18} />
                  <span className="sr-only">Close navigation</span>
                </button>
              </div>
              <NavList
                sections={sections}
                pathname={pathname}
                onNavigate={() => setDrawerOpen(false)}
              />
            </div>
          </div>
        ) : null}

        <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
