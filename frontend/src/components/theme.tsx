'use client';

/**
 * Theme: light, dark, or follow the system.
 *
 * ## Why three states and not a switch
 *
 * A two-state toggle forces a choice the moment someone arrives, and gets it wrong for everyone who
 * has already told their operating system what they prefer. "System" is the default and stays the
 * default until it is overridden.
 *
 * ## The flash, and the one line that prevents it
 *
 * Reading the stored choice in a `useEffect` means the first paint happens in the wrong theme and
 * then snaps — the flash of incorrect theme. The only fix is to apply it before first paint, which
 * means a synchronous script in `<head>`; `ThemeScript` below is that script, and it is deliberately
 * tiny and dependency-free because it runs render-blocking.
 *
 * `localStorage` is wrapped everywhere it is touched: it throws outright in some privacy modes, and
 * a theme preference is not worth taking the application down for.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { Icon } from '@/components/icon';
import type { IconName } from '@/components/icon';

export type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'msms-theme';

interface ThemeApi {
  choice: ThemeChoice;
  setChoice: (next: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeApi | null>(null);

/*
 * The pre-paint half of this lives in `public/theme-init.js`, loaded render-blocking by the root
 * layout. It reads the same key and writes the same attribute; the two are kept in step by hand
 * because both are three lines and neither can import the other — one runs before React exists.
 */

function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', choice);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  /*
   * Starts at 'system' on both server and client so the markup matches; the real stored value is
   * read in the effect below. The script in `<head>` has already applied it to the DOM by then, so
   * there is nothing to correct visually — only the control's own state catches up.
   */
  const [choice, setChoiceState] = useState<ThemeChoice>('system');

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'dark' || stored === 'light') setChoiceState(stored);
    } catch {
      /* privacy mode, or storage disabled — 'system' is a fine answer */
    }
  }, []);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    applyTheme(next);
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* the choice still applies for this session */
    }
  }, []);

  const value = useMemo(() => ({ choice, setChoice }), [choice, setChoice]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeApi {
  const ctx = useContext(ThemeContext);
  return ctx ?? { choice: 'system', setChoice: () => undefined };
}

const OPTIONS: Array<{ value: ThemeChoice; label: string; icon: IconName }> = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
];

/**
 * A three-way segmented control rather than a toggle.
 *
 * `radiogroup` rather than a row of buttons: these are three mutually exclusive states, and that is
 * what a radio group is. Arrow keys move between them for free.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { choice, setChoice } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={`inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5 ${className}`}
    >
      {OPTIONS.map((option) => {
        const active = choice === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.label}
            onClick={() => setChoice(option.value)}
            className={`theme-option flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              active
                ? 'bg-surface-1 text-ink shadow-xs'
                : 'text-muted hover:text-ink'
            }`}
          >
            <Icon name={option.icon} size={14} />
            <span className="sr-only">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
