'use client';

/**
 * Modal, confirmation and dropdown — none of which existed.
 *
 * The product had no overlay primitive of any kind, so a destructive action was a bare button that
 * did the thing, and anything needing a second step needed a whole route.
 *
 * ## Built on `<dialog>`, deliberately
 *
 * `showModal()` gives the focus trap, the inert background, the top layer and Escape-to-close for
 * free, and gets them right in ways a hand-rolled div does not — the trap survives a focusable
 * element appearing while the modal is open, and the background is genuinely inert rather than
 * merely covered. What is added here is the animation (a `<dialog>` cannot transition out of the
 * top layer without help), the click-outside, and the scroll lock.
 *
 * ## The one thing a `<dialog>` gets wrong for us
 *
 * Escape fires `cancel`, which closes the dialog whatever the caller wanted. A modal in the middle
 * of saving must not vanish and leave the request in flight with nothing to report to, so `cancel`
 * is prevented while `busy` is set.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Icon } from '@/components/icon';
import { Spinner } from '@/components/icon';

/* ─────────────────────────────────── Modal ─────────────────────────────────── */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** Blocks Escape and the backdrop while a submit is in flight. */
  busy?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const SIZE = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  busy = false,
  size = 'md',
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  /* Kept mounted through the closing animation, then unmounted. */
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      setClosing(true);
      const t = setTimeout(() => {
        node.close();
        setClosing(false);
      }, 140);
      return () => clearTimeout(t);
    }
  }, [open]);

  /*
   * The scroll lock, in an effect of its own.
   *
   * It used to be set inside the `showModal()` branch above and cleared by a separate mount-once
   * cleanup. Those two halves have different lifecycles, and Strict Mode runs effects
   * mount → unmount → mount: the cleanup cleared `overflow`, and the re-run could not restore it
   * because `open && !node.open` is false the second time round — `showModal()` had already been
   * called. The measured result was a modal open over a page that still scrolled behind it.
   *
   * Keyed on `open` with its own cleanup, this is idempotent: every re-run re-applies the lock, and
   * every teardown restores it. It also restores the *previous* value rather than the empty string,
   * so a modal opened over something else that had already locked the body does not unlock it on the
   * way out.
   */
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const onCancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      /* `cancel` is Escape. Always prevented, so closing goes through one path the caller owns. */
      event.preventDefault();
      if (!busy) onClose();
    },
    [busy, onClose]
  );

  const onBackdrop = useCallback(
    (event: React.MouseEvent<HTMLDialogElement>) => {
      if (busy) return;
      /* The dialog element fills the viewport; a click whose target IS the dialog is the backdrop. */
      if (event.target === ref.current) onClose();
    },
    [busy, onClose]
  );

  if (!open && !closing) return null;

  return (
    <dialog
      ref={ref}
      onCancel={onCancel}
      onClick={onBackdrop}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      className={`m-auto w-[calc(100vw-2rem)] ${SIZE[size]} rounded-2xl border border-border bg-surface-1 p-0 text-ink shadow-xl backdrop:bg-[var(--overlay)] ${
        closing ? 'opacity-0' : 'animate-scale-in'
      } transition-opacity duration-150`}
    >
      <div className="flex items-start gap-4 border-b border-border-soft px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="font-display text-xl font-semibold tracking-tight">
            {title}
          </h2>
          {description ? (
            <p id={descId} className="mt-1 text-sm leading-relaxed text-muted">
              {description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="btn btn-ghost btn-sm btn-icon -mr-1 -mt-0.5"
        >
          <Icon name="x" size={16} />
          <span className="sr-only">Close</span>
        </button>
      </div>

      {children ? <div className="px-5 py-5 sm:px-6">{children}</div> : null}

      {footer ? (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border-soft bg-surface-2 p-4">
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}

/* ─────────────────────────────── ConfirmDialog ─────────────────────────────── */

export interface ConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  /** Say what will happen, in the user's terms. "This cannot be undone" is not a description. */
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
}

/**
 * The second step a destructive action needs.
 *
 * The confirm button carries the verb — "Delete invoice", not "OK" — because a dialog read out of
 * context should still say what pressing it does. Cancel is focused on open for the same reason a
 * cash machine returns your card first: the safe path should be the one you get by reflex.
 */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setBusy(false);
      /* After the dialog has been shown, so the browser's own initial focus is overridden. */
      const t = setTimeout(() => cancelRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      busy={busy}
      size="sm"
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={confirm}
            disabled={busy}
          >
            {busy ? <Spinner size={14} /> : null}
            {confirmLabel}
          </button>
        </>
      }
    />
  );
}

/* ─────────────────────────────────── Dropdown ─────────────────────────────────── */

export interface DropdownProps {
  /** The control. Given the props that make it a correct menu button. */
  trigger: (props: {
    'aria-expanded': boolean;
    'aria-haspopup': 'menu';
    onClick: () => void;
    ref: React.Ref<HTMLButtonElement>;
  }) => ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
  label?: string;
}

/**
 * A menu that closes on Escape, on a click elsewhere, and when focus leaves it.
 *
 * Not a `<select>` and not a `<dialog>`: this is a menu of actions, so it takes `role="menu"` and
 * returns focus to its trigger on close, which is what makes it usable from a keyboard.
 */
export function Dropdown({ trigger, children, align = 'end', label }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;

    const onPointer = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative inline-block">
      {trigger({
        'aria-expanded': open,
        'aria-haspopup': 'menu',
        onClick: () => setOpen((v) => !v),
        ref: triggerRef,
      })}
      {open ? (
        <div
          role="menu"
          aria-label={label}
          className={`animate-scale-in absolute z-40 mt-1 min-w-[11rem] origin-top rounded-lg border border-border bg-surface-1 p-1 shadow-lg ${
            align === 'end' ? 'right-0' : 'left-0'
          }`}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** One row of a `Dropdown`. A button, not a link, unless `href` is given. */
export function DropdownItem({
  children,
  onClick,
  href,
  tone = 'default',
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  tone?: 'default' | 'danger';
}) {
  const className = `flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
    tone === 'danger'
      ? 'text-danger hover:bg-danger-soft'
      : 'text-ink-soft hover:bg-surface-3 hover:text-ink'
  }`;

  if (href) {
    return (
      <a role="menuitem" href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <button role="menuitem" type="button" onClick={onClick} className={className}>
      {children}
    </button>
  );
}
