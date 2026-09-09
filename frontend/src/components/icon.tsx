/**
 * The icon set — SRS-neutral, dependency-free.
 *
 * No icon library is installed and the brief forbids adding one, so these are hand-written inline
 * SVG on a shared 24×24 grid with a 2px stroke. Drawing them here rather than pasting paths into
 * screens is what keeps every icon the same weight and size: an interface where one icon is 1.5px
 * and its neighbour is 2px looks wrong before anyone can say why.
 *
 * Conventions, all enforced by the shared `<Icon>` wrapper rather than by each path:
 *   - `currentColor`, so an icon takes the colour of the text it sits beside.
 *   - `stroke-width: 2` at 24px, scaled with the box — a 16px icon keeps the same optical weight.
 *   - `aria-hidden` by default. An icon that carries meaning on its own takes a `title`, which
 *     turns it into `role="img"` with an accessible name. An icon-only button must still label
 *     itself; the icon is decoration inside it.
 */

import type { SVGProps } from 'react';

export type IconName =
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'check'
  | 'x'
  | 'search'
  | 'plus'
  | 'menu'
  | 'alert-circle'
  | 'alert-triangle'
  | 'info'
  | 'check-circle'
  | 'lock'
  | 'log-out'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'external-link'
  | 'download'
  | 'printer'
  | 'filter'
  | 'refresh'
  | 'inbox'
  | 'building'
  | 'school'
  | 'users'
  | 'user'
  | 'layers'
  | 'credit-card'
  | 'receipt'
  | 'ticket'
  | 'bar-chart'
  | 'settings'
  | 'book'
  | 'calendar'
  | 'clipboard'
  | 'wallet'
  | 'graduation'
  | 'clock'
  | 'file-text'
  | 'grid'
  | 'eye'
  | 'eye-off'
  | 'upload'
  | 'trash'
  | 'paperclip';

/** One entry per icon: the path data only, so the wrapper owns every shared attribute. */
const PATHS: Record<IconName, string> = {
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-left': 'm15 18-6-6 6-6',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35',
  plus: 'M12 5v14M5 12h14',
  menu: 'M4 6h16M4 12h16M4 18h16',
  'alert-circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 8v5M12 16h.01',
  'alert-triangle': 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16v-5M12 8h.01',
  'check-circle': 'M21.8 11.1V12a9 9 0 1 1-5.3-8.2M22 5 12 15l-3-3',
  lock: 'M18 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2ZM8 10V7a4 4 0 1 1 8 0v3',
  'log-out': 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',
  monitor: 'M20 3H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1ZM8 21h8M12 16v5',
  'external-link': 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  printer: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  filter: 'M22 3H2l8 9.5V19l4 2v-8.5L22 3Z',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z',
  building: 'M3 21h18M5 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17M15 21V9h3a1 1 0 0 1 1 1v11M9 7h2M9 11h2M9 15h2',
  school: 'M12 3 2 8l10 5 10-5-10-5ZM6 11v6c0 1.7 2.7 3 6 3s6-1.3 6-3v-6',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  layers: 'm12 2 10 5-10 5L2 7l10-5ZM2 17l10 5 10-5M2 12l10 5 10-5',
  'credit-card': 'M21 4H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2ZM1 10h22',
  receipt: 'M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2-3-2ZM8 9h8M8 13h6',
  ticket: 'M3 9a3 3 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a3 3 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v3ZM13 5v14',
  'bar-chart': 'M12 20V10M18 20V4M6 20v-4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z',
  calendar: 'M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2ZM16 2v4M8 2v4M3 10h18',
  clipboard: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z',
  wallet: 'M20 12V8H6a2 2 0 0 1 0-4h12v4M4 6v12a2 2 0 0 0 2 2h14v-4M18 12a2 2 0 0 0 0 4h4v-4h-4Z',
  graduation: 'M22 10 12 5 2 10l10 5 10-5ZM6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  'file-text': 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M16 13H8M16 17H8M10 9H8',
  grid: 'M10 3H3v7h7V3ZM21 3h-7v7h7V3ZM21 14h-7v7h7v-7ZM10 14H3v7h7v-7Z',
  /* Added for the forms work: a password reveal, and the file-upload control. */
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7ZM12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z',
  'eye-off': 'M9.9 4.24A9.6 9.6 0 0 1 12 4c6.4 0 10 8 10 8a18.6 18.6 0 0 1-2.16 3.19M6.61 6.61A19 19 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.39-1.61M14.12 14.12a3 3 0 1 1-4.24-4.24M2 2l20 20',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  trash: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6',
  paperclip: 'M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48',
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Pixel box. 16 for inline text, 18 in buttons, 20 in nav, 24 standalone. */
  size?: number;
  /** Give an icon that carries meaning on its own an accessible name; omit for decoration. */
  title?: string;
}

export function Icon({ name, size = 16, title, className = '', ...rest }: IconProps) {
  const d = PATHS[name];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {/*
       * One `<path>` holding every subpath, not one element per subpath.
       *
       * This used to be `d.split('M').filter(Boolean).map(s => <path d={\`M${s}\`} />)`, which split
       * the data on each uppercase `M` and re-prepended one. That corrupts any path whose first
       * command is a **relative** `m`: `m9 18 6-6-6-6` came out as `Mm9 18 6-6-6-6`, which is not
       * valid path data, so the browser rejected the whole attribute and the icon rendered nothing.
       * It broke `chevron-down`, `chevron-right`, `chevron-left` and `layers` — the account
       * dropdown's chevron, both pagination arrows and the nav — with two `<path> attribute d`
       * errors in the console and no visible glyph.
       *
       * The split bought nothing to begin with. Every icon here is stroke-only (`fill="none"`), and
       * a single `d` containing several `M`-separated subpaths strokes exactly the same pixels as
       * several elements would. Separate elements only matter when subpaths need different fills.
       */}
      <path d={d} />
    </svg>
  );
}

/** A spinner is motion rather than a glyph, so it is a element of its own rather than an icon. */
export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`spinner inline-block ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}
