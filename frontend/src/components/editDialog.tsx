'use client';

/**
 * Editing one row's scalar fields, in a modal.
 *
 * ## Why this exists rather than seven copies of it
 *
 * Seven screens needed the same thing at once — classes, organizations, fee structures, homework,
 * library books, parents and users all had a `PATCH /:id` with no caller — and the mechanism is
 * identical in all seven: seed a form from a row, send only what changed, put `error.details` on the
 * fields it names, show the rest in a banner, close on success and reload the list.
 *
 * That is the same split `useRowAction` already draws and for the same reason. **The dialog owns the
 * state machine; the caller owns the words.** Every label, every hint and every decision about which
 * fields exist stays with the screen that knows the domain — a shared component that generated those
 * would produce seven forms that each said slightly the wrong thing, which is worse than seven
 * copies of the right thing.
 *
 * ## Only what changed is sent, and the difference between blank and absent is preserved
 *
 * Every `update` schema in this API is `.min(1)` — a body with nothing in it is refused — and every
 * one of them writes an audit row naming the fields the body carried. Sending the whole form each
 * time would therefore record a change to every field on a save that touched one.
 *
 * A field left blank is sent as `null` when it is nullable and **left out entirely** when it is not.
 * That distinction is `nullable`, and it has to be per field rather than inferred: a required field
 * emptied by mistake should fail on the field, not be silently dropped, and a nullable one cleared
 * on purpose must actually clear.
 *
 * ## What it deliberately does not do
 *
 * No validation of its own beyond required-ness, which is the browser's. The API validates with Joi
 * and its refusals are precise; a second rule engine here would be a copy that drifts from the one
 * that decides. It also does not know how to *fetch* the row — the caller already has it, because
 * the caller is a list.
 */

import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import {
  Field,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
} from '@/components/form';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';

export interface EditField {
  /** The API's own field name. Sent as this, and errors are keyed on it. */
  name: string;
  label: string;
  /** `text` unless said otherwise. `select` needs `options`; `textarea` takes `rows`. */
  kind?: 'text' | 'number' | 'date' | 'email' | 'tel' | 'select' | 'textarea' | 'checkbox';
  hint?: string;
  required?: boolean;
  /** True when the column accepts null and a cleared field should clear it. See the header. */
  nullable?: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: string;
  rows?: number;
}

export interface EditDialogProps<T> {
  /** The row being edited, or null when nothing is open. */
  row: T | null;
  title: string;
  /** Say what saving does in this screen's terms; "Edit this" is not a description. */
  description?: string;
  fields: EditField[];
  /** The starting value of every field, as strings (or booleans for a checkbox). */
  initial: (row: T) => Record<string, string | boolean>;
  /** `PATCH /whatever/${row.id}` — written out by the caller so the route stays a literal. */
  save: (row: T, body: Record<string, unknown>) => Promise<unknown>;
  /** The toast on success. */
  success: string;
  onClose: () => void;
  onSaved: () => void;
  /** Rendered above the fields — a warning about what this particular edit affects. */
  children?: React.ReactNode;
}

export function EditDialog<T>({
  row,
  title,
  description,
  fields,
  initial,
  save,
  success,
  onClose,
  onSaved,
  children,
}: EditDialogProps<T>) {
  const { success: toast } = useToast();

  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [base, setBase] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /* Re-seeded per row, so yesterday's dialog does not decide today's values. */
  useEffect(() => {
    if (!row) return;
    const seeded = initial(row);
    setValues(seeded);
    setBase(seeded);
    setError(null);
    setFieldErrors({});
    /* `initial` is a fresh closure per render; keying on the row is what makes this run once. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row]);

  function set(name: string, value: string | boolean) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  const changed: Record<string, unknown> = {};
  for (const field of fields) {
    const now = values[field.name];
    if (now === base[field.name]) continue;
    if (typeof now === 'boolean') {
      changed[field.name] = now;
      continue;
    }
    const trimmed = (now ?? '').trim();
    if (trimmed === '') {
      /* Blank clears a nullable column and is not sent at all for one that cannot be null. */
      if (field.nullable) changed[field.name] = null;
      continue;
    }
    changed[field.name] = trimmed;
  }
  const nothingChanged = Object.keys(changed).length === 0;

  async function submit() {
    if (!row || busy || nothingChanged) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await save(row, changed);
      toast(success);
      onSaved();
      onClose();
    } catch (caught) {
      if (caught instanceof ApiError) {
        /*
         * Guarded, because these endpoints answer with two shapes of `details`: an array of field
         * errors from a 422 and a plain object from a conflict. `fieldErrors()` iterates, so an
         * unguarded call throws inside this catch and leaves the button spinning with nothing said.
         */
        setFieldErrors(Array.isArray(caught.details) ? caught.fieldErrors() : {});
        setError(
          Array.isArray(caught.details)
            ? caught.bannerFor(fields.map((field) => field.name))
            : caught.message
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={row !== null}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      description={description}
      size="lg"
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <SubmitButton
            form="edit-dialog"
            busy={busy}
            busyLabel="Saving…"
            fullWidth={false}
            disabled={nothingChanged}
          >
            Save changes
          </SubmitButton>
        </>
      }
    >
      <form
        id="edit-dialog"
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        {children}

        {fields.map((field) => {
          const value = values[field.name];

          if (field.kind === 'checkbox') {
            return (
              <label key={field.name} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={Boolean(value)}
                  onChange={(event) => set(field.name, event.target.checked)}
                />
                <span>
                  {field.label}
                  {field.hint ? (
                    <span className="block text-xs text-muted">{field.hint}</span>
                  ) : null}
                </span>
              </label>
            );
          }

          if (field.kind === 'select') {
            return (
              <SelectField
                key={field.name}
                id={field.name}
                label={field.label}
                required={field.required}
                hint={field.hint}
                error={fieldErrors[field.name]}
                value={String(value ?? '')}
                onChange={(event) => set(field.name, event.target.value)}
              >
                {/* A nullable select needs a way back to nothing; a required one does not. */}
                {field.required ? null : <option value="">—</option>}
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </SelectField>
            );
          }

          if (field.kind === 'textarea') {
            return (
              <TextAreaField
                key={field.name}
                id={field.name}
                label={field.label}
                rows={field.rows ?? 3}
                required={field.required}
                hint={field.hint}
                error={fieldErrors[field.name]}
                value={String(value ?? '')}
                onChange={(event) => set(field.name, event.target.value)}
              />
            );
          }

          return (
            <Field
              key={field.name}
              id={field.name}
              label={field.label}
              type={field.kind ?? 'text'}
              required={field.required}
              hint={field.hint}
              error={fieldErrors[field.name]}
              min={field.min}
              max={field.max}
              step={field.step}
              value={String(value ?? '')}
              onChange={(event) => set(field.name, event.target.value)}
            />
          );
        })}
      </form>
    </Modal>
  );
}
