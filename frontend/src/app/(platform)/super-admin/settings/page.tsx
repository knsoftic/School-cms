'use client';

/**
 * Settings — SRS §33's sixteenth Super Admin screen, checklist row 4.3.
 *
 * ## Why this screen has no form
 *
 * §33 lists **Settings** among the sixteen Super Admin MVP screens, so the screen is required and the
 * nav entry is correct. What it should *contain* is specified nowhere:
 *
 *   - The role table (SRS line 96) says Super Admin manages "global settings (see Section 9)".
 *   - Section 9 then defines only **9.1 Dashboard**, **9.2 School Management** and **9.3 Principal
 *     Creation**. There is no global-settings subsection. The cross-reference points at nothing.
 *   - No platform-scoped settings endpoint exists. `/school-settings` is §14.1 — school-scoped, with
 *     Principal / School Admin as the actor — and answering it as a platform caller is refused with
 *     `SCHOOL_CONTEXT_REQUIRED`, correctly.
 *   - A permission **does** exist: `settings.platform.manage` — "Manage global settings",
 *     `permissions.js:39`, one of the fixed 109, granted to `super_admin` via `ALL`. The nav entry
 *     gates on it. An earlier version of this file asserted the opposite in its header *and in the
 *     copy below*, and the nav borrowed `schools.view` — which `organization_admin` also holds, so
 *     an org admin was shown a link into a platform screen. The permission was never the gap; the
 *     specification is.
 *
 * So a form here would have to invent the requirement, the fields and the endpoint to save them to.
 * `docs/SRS-extracted.md` is the sole source of truth and §35 forbids adding to the schema, so this
 * screen states the gap and points at the platform configuration that **is** real and reachable.
 *
 * This follows the precedent set by the Reports screen, which lists the six school-scoped reports a
 * platform caller structurally cannot run rather than rendering them as dead links: claiming a
 * capability the system does not have is worse than naming the absence.
 */

import Link from 'next/link';

import { PageHeader } from '@/components/table';

/**
 * Where platform configuration actually lives today.
 *
 * Every row is a screen that exists and works — this is a map of the real thing, not a stand-in for
 * it. If a global-settings specification ever lands, it belongs beside these rather than replacing
 * them.
 */
const CONFIGURATION: { label: string; href: string; what: string }[] = [
  { label: 'Plans', href: '/super-admin/plans', what: 'The subscription tiers themselves — code, name and tier rank.' },
  { label: 'Modules', href: '/super-admin/plans/modules', what: 'Which of the twenty §11 module keys each plan enables.' },
  { label: 'Features', href: '/super-admin/plans/features', what: 'Per-plan feature rows, each carrying its own name and module key.' },
  { label: 'Limits', href: '/super-admin/plans/limits', what: 'The eight §11.2 limit keys per plan, fixed or unlimited.' },
  { label: 'Add-ons', href: '/super-admin/addons', what: 'The seven add-ons sold on top of a plan.' },
  { label: 'Coupons', href: '/super-admin/coupons', what: 'Discount codes, their windows and their redemption caps.' },
];

export default function SettingsPage() {
  return (
    <div>
      <PageHeader
        title="Settings"
        description="Platform configuration. This screen is specified by name only — see below."
      />

      <div className="mb-6 rounded-md border border-warn/25 bg-warn-soft px-4 py-3 text-sm text-ink-soft">
        <p className="font-medium">This screen has no form, deliberately.</p>
        <p className="mt-2 text-muted">
          §33 lists <span className="font-medium">Settings</span> as one of the sixteen Super Admin
          screens, but nothing specifies what it contains. The role table defers to Section 9, and
          Section 9 defines only Dashboard, School Management and Principal Creation. No
          platform-scoped settings endpoint exists — <code>/school-settings</code> is §14.1 and
          school-scoped — so there is nothing for a form here to read or write.
        </p>
        <p className="mt-2 text-muted">
          Rendering a form would mean inventing the fields and somewhere to save them. The
          configuration a Super Admin can genuinely change is listed below, and each link goes to the
          screen that owns it.
        </p>
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-soft">
        Platform configuration that exists
      </h2>

      <ul className="space-y-2">
        {CONFIGURATION.map((row) => (
          <li
            key={row.href}
            className="rounded-md border border-border px-4 py-3"
          >
            <Link href={row.href} className="font-medium underline underline-offset-2">
              {row.label}
            </Link>
            <p className="mt-1 text-sm text-muted">{row.what}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
