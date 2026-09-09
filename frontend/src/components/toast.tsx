'use client';

/**
 * Toasts — the feedback channel this product did not have.
 *
 * Until now every outcome was reported inline: a create screen navigated away on success and said
 * nothing, and a failure printed a banner the user had to still be looking at. Neither survives the
 * navigation that follows most actions, so the most common thing a user does — save something —
 * produced no confirmation at all.
 *
 * ## Decisions worth stating
 *
 * **Rendered in place, not through a portal.** A portal would need `document`, which does not exist
 * during the server render, and the region is `position: fixed` anyway — so it is already out of
 * flow and a portal buys nothing but a hydration hazard.
 *
 * **`role="status"` with `aria-live="polite"`, and errors are not louder.** An `assertive` region
 * interrupts a screen reader mid-sentence; a failed save is not worth cutting someone off. The
 * region is in the DOM from first render, empty, because a live region added at the same moment as
 * its content is frequently not announced at all.
 *
 * **Errors do not auto-dismiss.** A success can disappear on its own because the proof is on the
 * screen behind it. A failure the user missed is a failure they will hit again.
 *
 * **Timers are cleared on unmount and reset on replace**, so a toast dismissed by hand cannot be
 * dismissed a second time by a timer that outlived it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { Icon } from '@/components/icon';
import type { IconName } from '@/components/icon';

export type ToastTone = 'success' | 'error' | 'info' | 'warn';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastApi {
  /** Show a toast. Returns its id so a caller can dismiss it early. */
  toast: (tone: ToastTone, title: string, description?: string) => number;
  success: (title: string, description?: string) => number;
  error: (title: string, description?: string) => number;
  info: (title: string, description?: string) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Milliseconds before a toast retires itself. `null` means it waits to be dismissed. */
const LIFETIME: Record<ToastTone, number | null> = {
  success: 4000,
  info: 5000,
  warn: 7000,
  error: null,
};

const TONE: Record<ToastTone, { icon: IconName; className: string; iconClass: string }> = {
  success: {
    icon: 'check-circle',
    className: 'border-success/30 bg-success-soft',
    iconClass: 'text-success',
  },
  error: {
    icon: 'alert-circle',
    className: 'border-danger/30 bg-danger-soft',
    iconClass: 'text-danger',
  },
  warn: {
    icon: 'alert-triangle',
    className: 'border-warn/30 bg-warn-soft',
    iconClass: 'text-warn',
  },
  info: {
    icon: 'info',
    className: 'border-border bg-surface-1',
    iconClass: 'text-brand-text',
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (tone: ToastTone, title: string, description?: string) => {
      const id = nextId.current;
      nextId.current += 1;

      setToasts((current) => {
        /* Three at a time. A stack taller than that covers the thing it is reporting on. */
        const next = [...current, { id, tone, title, description }];
        return next.slice(-3);
      });

      const life = LIFETIME[tone];
      if (life !== null) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), life)
        );
      }
      return id;
    },
    [dismiss]
  );

  /* Every pending timer dies with the provider, so none fires into an unmounted tree. */
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (title, description) => toast('success', title, description),
      error: (title, description) => toast('error', title, description),
      info: (title, description) => toast('info', title, description),
      dismiss,
    }),
    [toast, dismiss]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastRegion({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-relevant="additions"
      /*
       * Bottom-right on a desktop, but full-width along the bottom on a phone, where a floating
       * card in the corner is both easy to miss and easy to hit by accident. `pointer-events-none`
       * on the region with `auto` on each toast keeps the page beneath it clickable.
       */
      className="no-print pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-stretch gap-2 p-4 sm:inset-x-auto sm:right-0 sm:max-w-sm"
    >
      {toasts.map((t) => {
        const tone = TONE[t.tone];
        return (
          <div
            key={t.id}
            className={`animate-slide-in pointer-events-auto flex items-start gap-3 rounded-lg border p-3 shadow-lg ${tone.className}`}
          >
            <Icon name={tone.icon} size={18} className={`mt-0.5 ${tone.iconClass}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">{t.title}</p>
              {t.description ? (
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{t.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              className="btn btn-ghost btn-sm btn-icon -mr-1 -mt-1"
            >
              <Icon name="x" size={14} />
              <span className="sr-only">Dismiss notification</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Read the toast API.
 *
 * Returns a no-op implementation outside a provider rather than throwing: a toast is feedback about
 * something that already happened, and taking down the screen because the confirmation could not be
 * shown would turn a cosmetic problem into a broken page.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  return (
    ctx ?? {
      toast: () => 0,
      success: () => 0,
      error: () => 0,
      info: () => 0,
      dismiss: () => undefined,
    }
  );
}
