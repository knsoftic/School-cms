/**
 * The platform surface's not-found page.
 *
 * ## What this page used to say, and why it no longer says it
 *
 * It was written when every list screen carried an "Add school" / "Add coupon" button pointing at a
 * `/new` route that did not exist yet. Rather than delete seven buttons that were the only rendered
 * evidence the permission gating worked, the forward reference was kept and this page explained it:
 * *"This screen has not been built yet … the forms that create and edit records are the next piece of
 * work."*
 *
 * **Those forms exist now** — `schools/new`, `organizations/new`, `principals/new`, `plans/new`,
 * `subscriptions/new`, `invoices/new` and `coupons/new` are all routes. So the old copy had become
 * false in the most misleading direction available: it told a Super Admin who mistyped a URL that the
 * product was unfinished. Its own closing comment predicted this exact moment and said what to do —
 * *"When the create screens exist, this page … goes back to being what a not-found page normally is:
 * the answer to a mistyped URL."* This is that.
 *
 * ## It renders inside the shell
 *
 * `(platform)/layout.tsx` wraps this in `AppShell`, so the navigation is already on screen and this
 * file must render a section rather than a page — no `min-h-screen`, no second `<main>`, and no
 * duplicate "sign in" link for someone who is demonstrably signed in.
 */

import Link from 'next/link';

import { Icon } from '@/components/icon';

export default function PlatformNotFound() {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border-strong bg-surface-2 px-6 py-16 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-3 text-muted">
        <Icon name="search" size={21} />
      </span>

      <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-muted-soft">Error 404</p>

      <h1 className="mt-2 font-display text-xl font-semibold tracking-tight text-ink">
        We could not find that page
      </h1>

      <p className="mx-auto mt-2.5 max-w-md text-sm leading-relaxed text-muted">
        This address does not match anything on the platform console. It may have been mistyped, or a
        link may be pointing somewhere that has since moved.
      </p>

      {/* A semantic token, not the `text-teal` primitive this page used to reach for — that colour is
          fixed across themes and only looked right in one of them. */}
      <Link href="/super-admin" className="btn btn-secondary mt-7">
        Back to the dashboard
      </Link>
    </div>
  );
}
