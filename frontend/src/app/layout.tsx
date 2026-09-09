import type { Metadata, Viewport } from 'next';
import { Figtree, Fraunces } from 'next/font/google';

import { ThemeProvider } from '@/components/theme';
import { ToastProvider } from '@/components/toast';
import { AuthProvider } from '@/lib/auth';
import { EntitlementProvider } from '@/lib/entitlements';

import './globals.css';

/*
 * Fraunces carries the brand and nothing else — page titles, the wordmark, marketing surfaces.
 * Figtree does all the work. A display serif on dense data would fight the numbers it sits beside.
 */
const display = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

const sans = Figtree({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'MSMS — Multi-School Management System',
    template: '%s · MSMS',
  },
  description:
    'Run every school in your group from one place — admissions, attendance, fees, exams and billing.',
};

/*
 * `width=device-width` with no `maximum-scale`: ARCHITECTURE.md §8 commits to 360 px upward, and
 * blocking zoom on a dashboard that renders dense tables would make it unusable for anyone who
 * needs to magnify. Two theme colours so the browser chrome matches the surface behind it.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f9fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1117' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable}`} suppressHydrationWarning>
      <head>
        {/*
         * Applies the stored theme before the first paint — without it the page renders light and
         * then snaps to dark, the flash every themed interface is judged on.
         *
         * A static file rather than an inline `dangerouslySetInnerHTML`: `verify-security.js`
         * asserts nothing in `frontend/src` calls that API, and that assertion is half of §24's
         * cross-site defence. Render-blocking on purpose — `defer` or `async` would let the paint
         * happen first and defeat the point.
         *
         * `@next/next/no-sync-scripts` flags exactly that blocking, and it is right about what it
         * sees and wrong about this one case: the rule exists to stop a script delaying paint, and
         * here delaying paint **is the requirement**. Disabled on the line rather than in
         * `eslint.config.mjs`, so the exception is one script rather than a project-wide licence.
         */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme-init.js" />
      </head>
      <body className="min-h-screen">
        {/* Keyboard users reach the content without walking the whole sidebar first. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface-1 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:shadow-lg focus:outline focus:outline-2 focus:outline-[var(--focus-ring)]"
        >
          Skip to content
        </a>
        <ThemeProvider>
          <ToastProvider>
            <AuthProvider>
              <EntitlementProvider>{children}</EntitlementProvider>
            </AuthProvider>
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
