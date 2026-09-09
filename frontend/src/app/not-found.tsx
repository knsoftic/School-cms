/**
 * The root not-found page.
 *
 * ## Why this exists
 *
 * Next renders a built-in 404 — an unstyled "This page could not be found" on a white page — for any
 * URL that matches no route and sits outside a route group with its own `not-found`. That page has no
 * navigation, ignores the theme, and looks like the application has crashed rather than like the
 * address was wrong. It was what `/` itself served until the landing page landed, and it is still what
 * every mistyped public URL would serve without this file.
 *
 * ## It is deliberately a server component
 *
 * There is no `'use client'` here and nothing reads `useAuth()`. A 404 must render when routing has
 * already failed, so the fewer things that can go wrong the better: this page needs no session, no
 * fetch and no provider. The links it offers are the two that are correct for everybody — the public
 * root, and sign-in — rather than a dashboard link that would be wrong for a signed-out visitor.
 *
 * Theming still works: `theme-init.js` sets `data-theme` on `<html>` before first paint, and these
 * are semantic tokens, so this page follows the theme without any JavaScript of its own.
 */

import Link from 'next/link';

import { Icon } from '@/components/icon';

export const metadata = {
  title: 'Page not found',
};

export default function NotFound() {
  return (
    <main id="main" className="flex min-h-screen flex-col items-center justify-center bg-paper px-5 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full border border-border bg-surface-2 text-muted">
        <Icon name="search" size={24} />
      </span>

      {/* The code is stated as well as described: someone reporting this to an administrator needs
          the number, and "404" is the word they will be asked for. */}
      <p className="mt-6 text-xs font-semibold uppercase tracking-widest text-muted-soft">Error 404</p>

      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
        We could not find that page
      </h1>

      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
        The address may have been mistyped, or the page may have moved. Nothing has gone wrong with
        your account.
      </p>

      <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
        <Link href="/" className="btn btn-primary w-full sm:w-auto">
          Go to the home page
        </Link>
        <Link href="/login" className="btn btn-secondary w-full sm:w-auto">
          Sign in
        </Link>
      </div>
    </main>
  );
}
