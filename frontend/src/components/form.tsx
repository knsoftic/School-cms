'use client';

/**
 * Form primitives shared by every screen that posts something.
 *
 * Errors come from the server via `ApiError.fieldErrors()` — there is deliberately no client-side
 * rule engine here, except comparisons the API cannot make (matching passwords on one form). A
 * second set of rules in the browser is a copy that drifts from the one that actually decides.
 *
 * ## What the three field wrappers guarantee, so no screen has to
 *
 *   - A real `<label>` bound by `htmlFor`. `verify-frontend.js` asserts every input has one, and
 *     asserts the auth pages declare no raw `<input>` at all so the guarantee cannot be bypassed.
 *   - `aria-invalid` and `aria-describedby` wired to whichever of hint/error is showing, so the
 *     message reaches a screen reader at the field rather than as a banner somewhere else.
 *   - **A required field is marked with a red asterisk, and never with the asterisk alone.** The
 *     glyph is the convention every reader of a form already knows, so that is what is on screen;
 *     the word travels beside it in an `sr-only` span, because an asterisk read aloud is "star" and
 *     a marker carried only by a colour is no marker at all. `FieldLabel` renders both.
 *   - **Error replaces hint rather than stacking**, so the field never grows a third line and
 *     shifts the whole form as you type.
 */

import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

import { Icon, Spinner } from '@/components/icon';

/* ─────────────────────────── shared label / message furniture ─────────────────────────── */

function FieldLabel({
  htmlFor,
  children,
  required,
}: {
  htmlFor: string;
  children: ReactNode;
  required?: boolean;
}) {
  /* `gap-1`, not `gap-1.5`: an asterisk belongs against its label, not spaced off it. */
  return (
    <label htmlFor={htmlFor} className="field-label mb-1.5 flex items-baseline gap-1">
      <span>{children}</span>
      {required ? (
        <>
          {/*
            * A red asterisk, which is the convention every reader of a form already knows.
            *
            * `aria-hidden`, because an asterisk read aloud is the word "star" — and the word that
            * should be announced instead follows it in an `sr-only` span. So the marker is a glyph
            * on screen and a word to a screen reader, and it is never *only* the colour: anyone who
            * cannot see red still gets "(required)" from assistive technology, and the glyph itself
            * is a shape rather than a tint.
            */}
          <span aria-hidden className="text-sm font-medium leading-none text-danger">
            *
          </span>
          <span className="sr-only">(required)</span>
        </>
      ) : null}
    </label>
  );
}

/**
 * A validation message written for the person reading it.
 *
 * ## The problem, measured rather than assumed
 *
 * These messages come from Joi by way of `ApiError.fieldErrors()`, and Joi names the **column**.
 * Submitting the New Principal form empty produced, verbatim:
 *
 *     name is required
 *     email must be a valid email
 *     username length must be at least 3 characters long
 *     school_id is required          ← under a label reading "School"
 *
 * The last one is a database identifier shown to a user, and the first three start mid-sentence in
 * lower case. `Password must be at least 8 characters long.` was already fine, because that module
 * writes its own message — which is the shape the rest are brought to.
 *
 * ## What it does, and what it refuses to do
 *
 * Only a message that **begins with the field's own key** is touched, and only its opening token is
 * replaced — with the label already on screen above the input, so the two cannot disagree. Joi's
 * `length must be at least N characters long` is also unwound, since "Username length must be" is
 * not a sentence anyone writes.
 *
 * Anything else is passed through untouched. A module that took the trouble to write a real sentence
 * keeps it, and a message this function does not recognise is shown as it arrived rather than
 * guessed at — a mangled error is worse than a technical one.
 */
export function humaniseFieldError(message: string, field: string, label: string): string {
  const key = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leading = new RegExp(`^"?${key}"?\\s+`);
  if (!leading.test(message)) return message;

  const rest = message
    .replace(leading, '')
    /* `length must be at least 3 characters long` → `must be at least 3 characters` */
    .replace(
      /^length (must be (?:at least|at most|less than|greater than) \d+) characters long$/,
      '$1 characters'
    )
    /* Joi's own wording for a bounded string, which reads the same way. */
    .replace(/^length must be (\d+) characters long$/, 'must be exactly $1 characters')
    /*
     * `string.empty`, which is what Joi says when a required box is submitted blank — measured on
     * the plan duplicate dialog as "Code for the copy is not allowed to be empty". It means the same
     * thing as `any.required`'s "is required", and that is the sentence the rest of the product
     * already uses for it, so the two now read alike whether the field was left blank or omitted.
     */
    .replace(/^is not allowed to be empty$/, 'is required');

  return `${label} ${rest}`;
}

function FieldMessage({
  error,
  hint,
  errorId,
  hintId,
  field,
  label,
}: {
  error?: string | null;
  hint?: string;
  errorId: string;
  hintId: string;
  /** The field's key and its visible label, so a server message can name what the reader sees. */
  field?: string;
  label?: string;
}) {
  if (error) {
    const shown = field && label ? humaniseFieldError(error, field, label) : error;
    return (
      <p id={errorId} className="field-error mt-1.5 flex items-start gap-1.5">
        {/*
          * An icon as well as the colour, and the message itself in words — "Do not rely only on
          * colour" is the rule, and a red border with no text beside it is exactly that.
          */}
        <Icon name="alert-circle" size={13} className="mt-px" />
        <span>{shown}</span>
      </p>
    );
  }
  if (hint) {
    return (
      <p id={hintId} className="field-hint mt-1.5">
        {hint}
      </p>
    );
  }
  return null;
}

/* ─────────────────────────────────── text input ─────────────────────────────────── */

/**
 * How wide an input should be, in the only terms that mean anything: **how much you type into it.**
 *
 * Every input was `width: 100%`, so a two-character school code got the same box as a postal address —
 * and on a wide window that box is 670px of empty field for "PK". A box that size is a promise about
 * the answer, and when the promise is wrong the form reads as unfinished. These caps are `max-width`
 * only, so a narrow window still collapses everything to full width and nothing is ever cut off.
 *
 *   `xs`  a code, a year, a quantity        `sm`  a phone number, a date, an amount
 *   `md`  a person's or an organization's name, an email      `full` an address, a URL (the default)
 */
export type FieldWidth = 'xs' | 'sm' | 'md' | 'full';

const FIELD_WIDTH: Record<FieldWidth, string> = {
  xs: 'max-w-[8rem]',
  sm: 'max-w-[13rem]',
  md: 'max-w-[24rem]',
  full: '',
};

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  error?: string | null;
  hint?: string;
  /** Cap the input at the length of its answer. Default `full`, as every field was. */
  width?: FieldWidth;
}

/*
 * There is deliberately no `icon` prop here.
 *
 * An icon inside an input earns its place only when it says something the label does not: the
 * magnifier on `SearchField` marks a control as search before the placeholder is read, the eye on
 * `PasswordField` is a button, and the clip and bin on `FileField` name actions. An envelope beside
 * a label already reading "Email" says nothing — and a column of twenty-eight fields each carrying
 * a different small grey mark is harder to scan than a column of plain boxes, not easier.
 *
 * So the three controls that need an icon have one built in, and the ordinary text field does not
 * offer the option.
 */
export function Field({ id, label, error, hint, className, required, width = 'full', ...input }: FieldProps) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div>
      <FieldLabel htmlFor={id} required={required}>
        {label}
      </FieldLabel>
      <input
        id={id}
        name={id}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        className={`field-input ${FIELD_WIDTH[width]} ${className ?? ''}`}
        {...input}
      />
      <FieldMessage
        error={error}
        hint={hint}
        errorId={errorId}
        hintId={hintId}
        field={id}
        label={label}
      />
    </div>
  );
}

/* ─────────────────────────────────── password ─────────────────────────────────── */

/**
 * A password field that can be read back.
 *
 * ## Why a reveal, on a project that is careful about credentials
 *
 * Five screens ask for a password and all five were `type="password"` with no way to check what was
 * typed. Two of them ask for it **twice** — a new password and its confirmation — which is a
 * mismatch a person cannot diagnose without retyping both. The one place the argument for hiding it
 * is strongest is a shared screen, and that is exactly where a reveal that defaults to **off** and
 * has to be pressed is the right shape: nothing is exposed unless somebody asks for it, out loud, by
 * pressing a button labelled for a screen reader.
 *
 * `autoComplete` stays the caller's business — `current-password` on sign-in, `new-password` on a
 * change — because a password manager keying off the wrong one is worse than no manager at all.
 */
export function PasswordField({
  id,
  label,
  error,
  hint,
  required,
  width = 'full',
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  id: string;
  label: string;
  error?: string | null;
  hint?: string;
  /** As `Field`. The cap goes on the wrapper, so the reveal button stays pinned to the input's edge. */
  width?: FieldWidth;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const [shown, setShown] = useState(false);

  return (
    <div>
      <FieldLabel htmlFor={id} required={required}>
        {label}
      </FieldLabel>
      <div className={`relative ${FIELD_WIDTH[width]}`}>
        <input
          id={id}
          name={id}
          type={shown ? 'text' : 'password'}
          required={required}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className="field-input has-trailing-button"
          {...input}
        />
        <button
          type="button"
          onClick={() => setShown((on) => !on)}
          /*
           * `aria-pressed` rather than a label that changes: a toggle whose name moves under the
           * cursor is announced as a different control each time. The name says what the button is
           * for; the pressed state says which way it currently is.
           */
          aria-pressed={shown}
          aria-controls={id}
          className="absolute right-1 top-1/2 flex h-8 w-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-soft transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon name={shown ? 'eye-off' : 'eye'} size={16} />
          <span className="sr-only">Show password</span>
        </button>
      </div>
      <FieldMessage
        error={error}
        hint={hint}
        errorId={errorId}
        hintId={hintId}
        field={id}
        label={label}
      />
    </div>
  );
}

/* ─────────────────────────────────── select ─────────────────────────────────── */

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  id: string;
  label: string;
  error?: string | null;
  hint?: string;
  children: ReactNode;
  /** As `Field` — cap it at the width of its longest option, never past it. */
  width?: FieldWidth;
}

export function SelectField({
  id,
  label,
  error,
  hint,
  children,
  className,
  required,
  width = 'full',
  ...select
}: SelectFieldProps) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div>
      <FieldLabel htmlFor={id} required={required}>
        {label}
      </FieldLabel>
      {/* `.field-select` rather than `.field-input`: the native chevron is dropped and redrawn so a
          select does not look like a text box that ignores typing. */}
      <select
        id={id}
        name={id}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        className={`field-select ${FIELD_WIDTH[width]} ${className ?? ''}`}
        {...select}
      >
        {children}
      </select>
      <FieldMessage
        error={error}
        hint={hint}
        errorId={errorId}
        hintId={hintId}
        field={id}
        label={label}
      />
    </div>
  );
}

/* ─────────────────────────────────── textarea ─────────────────────────────────── */

interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  id: string;
  label: string;
  error?: string | null;
  hint?: string;
}

export function TextAreaField({
  id,
  label,
  error,
  hint,
  className,
  required,
  ...area
}: TextAreaFieldProps) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div>
      <FieldLabel htmlFor={id} required={required}>
        {label}
      </FieldLabel>
      <textarea
        id={id}
        name={id}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        className={`field-textarea ${className ?? ''}`}
        {...area}
      />
      <FieldMessage
        error={error}
        hint={hint}
        errorId={errorId}
        hintId={hintId}
        field={id}
        label={label}
      />
    </div>
  );
}

/* ─────────────────────────────────── checkbox ─────────────────────────────────── */

/**
 * A checkbox with its label as one target.
 *
 * The whole row is the hit area rather than the 16px box — on a phone a bare checkbox is below every
 * touch-target guideline, and reaching for the label is what people do anyway.
 */
export function CheckboxField({
  id,
  label,
  hint,
  error,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  hint?: string;
  /**
   * The server's message for this field.
   *
   * This was missing, and its absence was load-bearing in the wrong direction: `plans/new` kept its
   * `is_recommended` checkbox hand-rolled *because* moving it here would have dropped
   * `fieldErrors.is_recommended` rather than associating it — a wrapper that silently discards an
   * error is worse than the raw control it replaces. A checkbox can be rejected like anything else
   * (a `forbiddenField`, a conditional rule), so it needs the same `aria-invalid` and
   * `aria-describedby` wiring every other field in this file has.
   */
  error?: string | null;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div>
      <label
        htmlFor={id}
        className="-mx-2 flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2"
      >
        <input
          id={id}
          name={id}
          type="checkbox"
          className="field-check mt-0.5"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          {...input}
        />
        <span className="text-sm text-ink">{label}</span>
      </label>
      {/* Indented to sit under the label rather than the box, and error replaces hint as everywhere. */}
      <div className="ml-7">
        <FieldMessage
        error={error}
        hint={hint}
        errorId={errorId}
        hintId={hintId}
        field={id}
        label={label}
      />
      </div>
    </div>
  );
}

/**
 * A group of radios.
 *
 * A `<fieldset>` with a `<legend>`, because that is what conveys "these options belong to one
 * question" — a bare label on each option says three separate things instead of one.
 */
export function RadioGroupField({
  name,
  legend,
  value,
  onChange,
  options,
  error,
  hint,
}: {
  name: string;
  legend: string;
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string; hint?: string }>;
  error?: string | null;
  hint?: string;
}) {
  const base = useId();
  const errorId = `${base}-error`;
  const hintId = `${base}-hint`;

  return (
    <fieldset aria-invalid={Boolean(error)} aria-describedby={error ? errorId : hint ? hintId : undefined}>
      <legend className="field-label mb-1.5">{legend}</legend>
      <div className="space-y-0.5">
        {options.map((option) => {
          const id = `${base}-${option.value}`;
          return (
            <label
              key={option.value}
              htmlFor={id}
              className="-mx-2 flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2"
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                onChange={(event) => onChange(event.target.value)}
                className="field-check mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-sm text-ink">{option.label}</span>
                {option.hint ? (
                  <span className="block text-xs leading-relaxed text-muted">{option.hint}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {/* `name` is the group's field key here, and `legend` is what the reader sees. */}
      <FieldMessage
        error={error}
        hint={hint}
        errorId={errorId}
        hintId={hintId}
        field={name}
        label={legend}
      />
    </fieldset>
  );
}

/* ─────────────────────────── taking the user to the problem ─────────────────────────── */

/**
 * Move focus to the first field the server rejected.
 *
 * ## Why a long form needs this and a short one does not
 *
 * The field wrappers above put each message beside its own input, which is right — and on a form
 * long enough to scroll it means a rejected submit can produce **no visible change at all**. Measured
 * on `students/new`, which has 28 fields: the only required ones (`first_name`, `admission_date`) are
 * near the top, the submit button is nearly a thousand lines below them, and the banner is correctly
 * suppressed because a field is carrying the message. So the user presses "Admit student", the button
 * un-busies, and the page looks untouched. It reads as a dead button.
 *
 * Focus is the fix rather than a scroll, because it does three things at once: the browser scrolls the
 * control into view, the focus ring says which control, and a screen reader announces the field along
 * with the `aria-describedby` error the wrapper already wired to it. A bare `scrollIntoView` does only
 * the first.
 *
 * ## Why it reads the DOM instead of taking the field names
 *
 * The caller has a `Record<string, string>` whose key order is the server's, not the form's. Focusing
 * "the first" by that order can jump to a field below one that also failed. `aria-invalid="true"` is
 * set by `Field`, `SelectField`, `TextAreaField` and `RadioGroupField` whenever they hold an error, so
 * querying for it gets the first failure in **document order**, which is the one the user should be
 * taken to.
 *
 * Call it after the state update that sets the errors — the attribute does not exist until React has
 * re-rendered, which is why this defers a frame.
 */
export function focusFirstInvalidField(): void {
  if (typeof window === 'undefined') return;

  /*
   * One animation frame is not enough, which is a thing worth measuring rather than assuming.
   *
   * The caller runs this immediately after `setFieldErrors(...)`, and that is a React state update:
   * the attribute this queries does not exist until React has re-rendered and committed. The first
   * version scheduled a single `requestAnimationFrame`, which fired **before** the commit — so the
   * query matched nothing, `target` was undefined, and focus never moved. Measured in the browser:
   * `aria-invalid="true"` was correctly on the control and `document.activeElement` was still
   * `<body>`.
   *
   * So it looks again on each of the next few frames and stops at the first hit. Bounded, because a
   * submit that produced no field error at all must not leave a timer running or steal focus later.
   */
  /*
   * A timer, not `requestAnimationFrame` — and that distinction was measured, not preferred.
   *
   * rAF is the obvious choice for "after the next paint", and it is **suspended entirely in a
   * background tab**. The second version of this used it and appeared not to work at all: the
   * control had `aria-invalid="true"`, the selector matched it, `focus()` worked by hand, and
   * `document.activeElement` stayed on `<body>` — because the browser pane running the test was
   * hidden and the callback never fired. That is not only a testing artefact: a user who submits and
   * switches tabs would come back to a form that never moved.
   *
   * `setTimeout` fires either way (clamped to ~1s in a background tab, which is fine — nothing here
   * is visual). Bounded at ten attempts, so a submit that produced no field error leaves no timer
   * running and cannot steal focus later.
   */
  const ATTEMPTS = 10;
  const STEP_MS = 16;
  let attempt = 0;

  const look = () => {
    /*
     * The first one that is **rendered**. A screen that keeps several tab panels mounted and hides the
     * inactive ones (the plan editor does, so an unsaved edit survives a tab switch) can hold a stale
     * invalid field in a hidden panel; focusing it moves focus nowhere visible. A `display: none`
     * subtree has no client rects.
     */
    const target = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[aria-invalid="true"]:is(input, select, textarea), [aria-invalid="true"] :is(input, select, textarea)'
      )
    ).find((element) => element.getClientRects().length > 0);
    if (target) {
      /* `preventScroll` is left at its default: the scroll into view is half the point. */
      target.focus();
      return;
    }
    attempt += 1;
    if (attempt < ATTEMPTS) window.setTimeout(look, STEP_MS);
  };

  window.setTimeout(look, 0);
}

/**
 * A count of what failed, for a form too long to take in at once.
 *
 * Deliberately not a list of the messages: they are already beside their fields, and repeating them
 * at the top is the same text twice with no indication of where to go. The count plus the focus jump
 * answers "did anything happen?" and "where?" without duplicating "what".
 */
export function FieldErrorSummary({ count }: { count: number }) {
  if (count < 1) return null;
  return (
    <Notice tone="error">
      {count === 1
        ? 'One field needs attention — it is highlighted below.'
        : `${count} fields need attention — the first is highlighted below.`}
    </Notice>
  );
}

/* ─────────────────────────────────── messages ─────────────────────────────────── */

export function Notice({
  tone,
  children,
}: {
  tone: 'error' | 'success' | 'info' | 'warn';
  children: ReactNode;
}) {
  const style = {
    error: { cls: 'border-danger/25 bg-danger-soft text-danger', icon: 'alert-circle' },
    success: { cls: 'border-success/25 bg-success-soft text-success', icon: 'check-circle' },
    warn: { cls: 'border-warn/25 bg-warn-soft text-warn', icon: 'alert-triangle' },
    info: { cls: 'border-border bg-surface-2 text-ink-soft', icon: 'info' },
  }[tone];

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${style.cls}`}
    >
      <Icon name={style.icon as 'info'} size={16} className="mt-0.5" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * The submit button.
 *
 * `aria-busy` and a spinner rather than swapped text alone: the label changing from "Create" to
 * "Creating…" is easy to miss, and a button that looks identical while a request is in flight is
 * how a form gets submitted twice.
 */
export function SubmitButton({
  busy,
  children,
  busyLabel,
  fullWidth = true,
  form,
  disabled = false,
}: {
  busy: boolean;
  children: ReactNode;
  busyLabel: string;
  /**
   * An additional reason the form cannot be submitted — the set editors use it for "nothing has
   * changed yet".
   *
   * Separate from `busy` rather than folded into it, because the two mean different things to the
   * person looking at the button: `busy` swaps the label and shows a spinner, and this does not.
   * It never *replaces* the in-flight guard below; it only adds to it.
   */
  disabled?: boolean;
  /**
   * Full width below `sm` regardless — a submit button is the one thing on a form a thumb must not
   * miss. Above `sm` it sizes to its label unless a caller insists otherwise (the auth panel does,
   * because a 25rem column looks broken with a 9rem button in it).
   */
  fullWidth?: boolean;
  /**
   * The id of the form to submit, for a button that is not inside it.
   *
   * The two modal forms put their buttons in the dialog's footer, which is a sibling of the
   * `<form>`, not a descendant. `form=` is the attribute that connects them — and passing it here
   * rather than hand-rolling a `<button type="submit">` in each footer is what keeps every submit in
   * the product the same control, with the same spinner, the same `aria-busy` and the same
   * double-submit guard.
   */
  form?: string;
}) {
  return (
    <button
      type="submit"
      form={form}
      /*
       * `disabled` while in flight is what stops a double submission, and it is not belt-and-braces:
       * every one of these posts is non-idempotent, so a second click creates a second record. The
       * spinner and the label change are how a person knows why the button stopped responding.
       */
      disabled={busy || disabled}
      aria-busy={busy}
      /* A footer button sits beside Cancel at the dialog's own scale, so it is not stretched. */
      className={
        form
          ? 'btn btn-primary'
          : `btn btn-primary btn-lg w-full ${fullWidth ? '' : 'sm:w-auto'}`
      }
    >
      {busy ? <Spinner size={15} /> : null}
      {busy ? busyLabel : children}
    </button>
  );
}

/* ─────────────────────────────── multi-select ─────────────────────────────── */

/**
 * Choosing several things from a bounded list.
 *
 * ## Why not `<select multiple>`, which is what this replaces
 *
 * The coupon form restricted a coupon to plans and to schools through a native multiple select, and
 * that control is close to unusable:
 *
 *   - selecting more than one needs **ctrl-click**, which nothing on the page says and no touch
 *     device has;
 *   - on a phone the browser's own picker often reduces it to a single choice, silently;
 *   - the selection is only visible while the list is in view, so a reader who scrolls away has no
 *     record of what they chose;
 *   - de-selecting the last item requires ctrl-clicking it, which people discover by accident.
 *
 * A checkbox list has none of those problems. It is more vertical, which is why it scrolls at a
 * fixed height and reports its own count — the count is the thing a reader wants when the list is
 * longer than the box.
 *
 * `<fieldset>` and `<legend>`, because these checkboxes answer **one** question together. Each
 * option's own label describes it; the legend says what the set is for.
 */
export function MultiSelectField<T extends string | number>({
  id,
  label,
  options,
  selected,
  onChange,
  error,
  hint,
  disabled,
  emptyLabel = 'Nothing to choose from.',
}: {
  id: string;
  label: string;
  options: Array<{ value: T; label: string; hint?: string }>;
  selected: T[];
  onChange: (next: T[]) => void;
  error?: string | null;
  hint?: string;
  disabled?: boolean;
  emptyLabel?: string;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const chosen = new Set(selected);

  const toggle = (value: T) => {
    const next = new Set(chosen);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    /* Emitted in the options' own order, not click order, so the payload is stable across sessions. */
    onChange(options.filter((option) => next.has(option.value)).map((option) => option.value));
  };

  return (
    <fieldset
      aria-invalid={Boolean(error)}
      aria-describedby={error ? errorId : hint ? hintId : undefined}
      disabled={disabled}
    >
      <legend className="field-label mb-1.5 flex items-baseline gap-2">
        <span>{label}</span>
        {/* The count, because a fixed-height list hides most of its own state. */}
        {selected.length > 0 ? (
          <span className="text-2xs font-medium uppercase tracking-wide text-brand-text">
            {selected.length} selected
          </span>
        ) : null}
      </legend>

      {options.length === 0 ? (
        <p className="field-hint">{emptyLabel}</p>
      ) : (
        <div
          className={`max-h-56 space-y-px overflow-y-auto rounded-md border p-1 ${
            error ? 'border-danger' : 'border-border-strong'
          } bg-surface-1`}
        >
          {options.map((option) => {
            const optionId = `${id}-${option.value}`;
            return (
              <label
                key={String(option.value)}
                htmlFor={optionId}
                className="flex cursor-pointer items-start gap-2.5 rounded px-2 py-1.5 transition-colors hover:bg-surface-2"
              >
                <input
                  id={optionId}
                  type="checkbox"
                  className="field-check mt-0.5"
                  checked={chosen.has(option.value)}
                  onChange={() => toggle(option.value)}
                />
                <span className="min-w-0">
                  <span className="block text-sm text-ink">{option.label}</span>
                  {option.hint ? (
                    <span className="block text-xs text-muted-soft">{option.hint}</span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      )}

      <FieldMessage
        error={error}
        hint={hint}
        errorId={errorId}
        hintId={hintId}
        field={id}
        label={label}
      />
    </fieldset>
  );
}

/* ─────────────────────────────── file upload ─────────────────────────────── */

/** `1048576` → `1.0 MB`. Binary units, because that is what a size limit is expressed in. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed((kb / 1024) < 10 ? 1 : 0)} MB`;
}

/**
 * Attaching one file.
 *
 * ## What it replaces
 *
 * A bare `<input type="file">`, which shows the browser's own button, no name until after the pick,
 * no size, no way to change your mind except picking again, and — on the one screen that has one —
 * a separate paragraph listing the accepted types that a reader had to connect to the control
 * themselves.
 *
 * ## Drag and drop is the addition, not the mechanism
 *
 * The `<input>` is still the control. It is visually hidden but **focusable and in tab order**, and
 * the label wraps the whole drop zone — so a keyboard user tabs to it and presses Enter exactly as
 * they would any file input, and a screen reader announces a file input rather than a region. Drag
 * and drop is layered on top for people using a mouse, and nothing depends on it: `dragover` is
 * cosmetic, and `drop` sets the same `input.files` the picker would.
 *
 * Single file on purpose. The one upload in this application is
 * `uploadSingle(UPLOAD_PROFILES.HOMEWORK, 'attachment')` — one field, one file — and a control that
 * accepts several would be promising something the endpoint refuses.
 */
export function FileField({
  id,
  label,
  file,
  onChange,
  accept,
  acceptLabel,
  maxBytes,
  error,
  hint,
  required,
  busy,
}: {
  id: string;
  label: string;
  /** The chosen file, or null. Owned by the caller so the form can clear it after a submit. */
  file: File | null;
  onChange: (file: File | null) => void;
  /** Passed to the input, and spelled out for the reader — the two cannot then disagree. */
  accept?: string;
  /** Overrides the list derived from `accept`, for an `accept` with no readable extensions. */
  acceptLabel?: string;
  maxBytes?: number;
  error?: string | null;
  hint?: string;
  required?: boolean;
  /** Disables removal while a submit is in flight. */
  busy?: boolean;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  /*
   * `accept` is written for the browser and usually carries both forms — `.pdf,application/pdf`.
   * Only the extensions are readable, so only those are shown; a list that said "APPLICATION/PDF"
   * would be worse than saying nothing. `acceptLabel` overrides it where neither reads well.
   */
  const types =
    acceptLabel ??
    (accept
      ? accept
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.startsWith('.'))
          .map((part) => part.slice(1).toUpperCase())
          .join(', ')
      : '');

  const limits = [types || null, maxBytes ? `up to ${formatBytes(maxBytes)}` : null]
    .filter(Boolean)
    .join(' · ');

  /* A file already chosen: show what it is, and offer to take it back. */
  if (file) {
    return (
      <div>
        <FieldLabel htmlFor={id} required={required}>
          {label}
        </FieldLabel>
        <div className="flex items-center gap-3 rounded-md border border-border-strong bg-surface-1 px-3 py-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
            <Icon name="paperclip" size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink">{file.name}</span>
            <span className="block text-xs text-muted-soft">{formatBytes(file.size)}</span>
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onChange(null);
              /* The input keeps its old value otherwise, so re-picking the same file fires nothing. */
              if (inputRef.current) inputRef.current.value = '';
            }}
            className="btn btn-ghost btn-sm btn-icon"
          >
            <Icon name="trash" size={15} />
            <span className="sr-only">Remove {file.name}</span>
          </button>
        </div>
        {/* Kept mounted so the ref survives, and so removing restores a working picker. */}
        <input
          ref={inputRef}
          id={id}
          name={id}
          type="file"
          accept={accept}
          className="sr-only"
          onChange={(event) => onChange(event.target.files?.[0] ?? null)}
        />
        <FieldMessage
        error={error}
        hint={hint}
        errorId={errorId}
        hintId={hintId}
        field={id}
        label={label}
      />
      </div>
    );
  }

  return (
    <div>
      <FieldLabel htmlFor={id} required={required}>
        {label}
      </FieldLabel>
      {/*
        * The label IS the drop zone. That is what keeps the real input in tab order and correctly
        * announced — a `<div onClick>` calling `input.click()` would be neither.
        */}
      <label
        htmlFor={id}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const dropped = event.dataTransfer.files?.[0];
          if (dropped) onChange(dropped);
        }}
        className={`flex cursor-pointer flex-col items-center rounded-md border border-dashed px-4 py-6 text-center transition-colors ${
          error
            ? 'border-danger bg-danger-soft/40'
            : dragging
              ? 'border-brand bg-brand-subtle'
              : 'border-border-strong bg-surface-2 hover:border-muted-soft'
        }`}
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-1 text-muted">
          <Icon name="upload" size={18} />
        </span>
        <span className="mt-3 text-sm text-ink">
          <span className="font-medium text-brand-text">Choose a file</span> or drag it here
        </span>
        {limits ? <span className="mt-1 text-xs text-muted-soft">{limits}</span> : null}
        <input
          ref={inputRef}
          id={id}
          name={id}
          type="file"
          accept={accept}
          required={required}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className="sr-only"
          onChange={(event) => onChange(event.target.files?.[0] ?? null)}
        />
      </label>
      <FieldMessage
        error={error}
        hint={hint}
        errorId={errorId}
        hintId={hintId}
        field={id}
        label={label}
      />
    </div>
  );
}

/* ─────────────────────────────── form layout ─────────────────────────────── */

/**
 * One group of related fields, under a heading that says what the group is for.
 *
 * ## Why every long form needs this
 *
 * Eighteen create screens rendered a flat `space-y-4` list of fields — `students/new` puts
 * **twenty-eight** of them in one column with nothing between "Last name" and "Uses transport" to
 * say that one is about a person and the other about logistics. Two screens had grown ad-hoc `<h2>`
 * headings, in two different sizes. A reader cannot tell what a form wants without scrolling the
 * whole thing and holding it in their head.
 *
 * The heading is an `<h2>` because that is what it is — the page's `<h1>` is the form's title — so
 * a screen reader can jump between sections, and `aria-labelledby` ties the group to its name.
 * `<section>` rather than `<div>` for the same reason.
 *
 * `description` is for the sentence a field hint cannot carry because it applies to several fields
 * at once. It is optional and should stay optional: a heading that needs explaining usually needs
 * renaming instead.
 */
export function FormSection({
  title,
  description,
  children,
  columns = 1,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  /** 2 puts short fields side by side above `sm`. See `FormGrid`. */
  columns?: 1 | 2;
}) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="border-t border-border-soft pt-5 first:border-0 first:pt-0">
      {/*
        * `text-base` and `font-semibold`, against a field label's `text-sm` at weight 550.
        *
        * At `text-sm font-semibold` — which this was — a heading and the first label beneath it were
        * within a hair of each other, and on screen "The principal" and "Name" read as two labels
        * rather than as a heading and the field it introduces. A section heading has to be legible
        * as a heading at a glance, or the grouping it announces does nothing.
        */}
      <div className="mb-3 max-w-2xl">
        <h2 id={headingId} className="text-base font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {description ? (
          <p className="mt-0.5 text-sm leading-snug text-muted">{description}</p>
        ) : null}
      </div>
      {columns === 2 ? <FormGrid>{children}</FormGrid> : <div className="space-y-4">{children}</div>}
    </section>
  );
}

/**
 * Two columns above `sm`, one below.
 *
 * The gap is deliberately larger between columns than between rows (`gap-x-5 gap-y-4`): two fields
 * side by side need more air between them than a field needs from the one under it, or the eye reads
 * across the row before it reads down the column and the labels stop lining up with their inputs.
 *
 * Not used for anything long. A textarea, or a field whose hint runs to two lines, belongs in one
 * column — put it in a `columns={1}` section rather than making a reader's eye jump a ragged edge.
 */
export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">{children}</div>;
}

/** A field that should span both columns inside a `FormGrid` — a textarea, or a long hint. */
export function FormSpan({ children }: { children: ReactNode }) {
  return <div className="sm:col-span-2">{children}</div>;
}

/**
 * The row of buttons that ends a form.
 *
 * ## The hierarchy, and why Cancel stopped being a bare link
 *
 * All eighteen create screens ended with a `SubmitButton` and then
 * `<a className="text-sm underline">Cancel</a>` — an underlined text link with no button shape, no
 * height, no hit area, and no visual relationship to the button beside it. On a phone that is a
 * 17px-tall tap target next to a 42px one.
 *
 * Three ranks, and no more: **primary** is the one thing the form is for; **secondary** is Cancel,
 * a real button because leaving a half-filled form is a deliberate act; **destructive** is offered
 * separately and only where a form can delete, so it can never sit where a reader's thumb expects
 * Cancel.
 *
 * ## Order on screen is not order in the DOM
 *
 * The primary action comes **first in the DOM**, so it is the first thing after the last field in
 * tab order and the default for an Enter press. Visually it sits on the right on desktop, where a
 * left-to-right reader expects the forward action, via `sm:flex-row-reverse`. On mobile the row
 * stacks with the primary on top — reversed again — because the thumb rests at the bottom of the
 * screen and the destructive-adjacent button should not be what it lands on.
 */
export function FormActions({
  children,
  cancelHref,
  cancelLabel = 'Cancel',
  destructive,
}: {
  /** The `SubmitButton`. */
  children: ReactNode;
  /** Where Cancel goes. Omit it and no Cancel is rendered — modal footers own their own. */
  cancelHref?: string;
  cancelLabel?: string;
  /** A delete or archive action, kept away from Cancel. */
  destructive?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-border-soft pt-5 sm:flex-row-reverse sm:items-center sm:justify-start sm:gap-3">
      {children}
      {cancelHref ? (
        <Link href={cancelHref} className="btn btn-secondary btn-lg w-full sm:w-auto">
          {cancelLabel}
        </Link>
      ) : null}
      {/* Pushed to the far end, so it is never adjacent to either of the other two. */}
      {destructive ? <div className="sm:mr-auto">{destructive}</div> : null}
    </div>
  );
}

/* ─────────────────────────────── list filters ─────────────────────────────── */

/**
 * The row of controls above a list.
 *
 * Twenty-seven list screens hand-rolled this, and the result drifted in ways that are small
 * individually and obvious side by side:
 *
 *   - the search box carried `mb-4` **inside** a `flex items-center` row, so it sat a quarter-inch
 *     lower than the select beside it on every screen that had both;
 *   - on a narrow window the controls squeezed rather than stacked, and a select whose longest
 *     option is "All fee statuses" became a few characters wide;
 *   - and there was **no way to clear a filter set** except returning each control to its default by
 *     hand, which matters most at exactly the moment it is missing — the empty state reading "No
 *     student matches these filters" is a dead end without it.
 *
 * `<div role="search">`, not `<form>`: everything here filters as you type or as you pick, so there
 * is nothing to submit, and a `<form>` would invite an Enter keypress to reload the page.
 */
export function FilterBar({
  children,
  activeCount = 0,
  onClear,
}: {
  children: ReactNode;
  /**
   * How many controls are away from their default. Drives the clear button, and is spelled out in
   * words — the visual cue on an active control must not be the only signal.
   */
  activeCount?: number;
  onClear?: () => void;
}) {
  return (
    <div role="search" className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
      {children}
      {onClear && activeCount > 0 ? (
        <button type="button" onClick={onClear} className="btn btn-ghost btn-sm self-start sm:self-end">
          <Icon name="x" size={14} />
          Clear {activeCount} {activeCount === 1 ? 'filter' : 'filters'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A search box.
 *
 * Used in two places: above a list inside a `FilterBar`, and inside a form, where five create
 * screens search for a user account to link. Those five were raw `<input type="search">` with an
 * `sr-only` label and no magnifier, so nothing but the placeholder marked them as search — and no
 * way to clear one except selecting the text and deleting it.
 *
 * The magnifier is the one icon that earns its place here: it is what makes the control readable as
 * search before the placeholder is read. The clear button appears only once there is something to
 * clear, because a permanently visible × on an empty box is a control that does nothing.
 *
 * The label is `sr-only` on purpose. Its visible equivalent is the placeholder, which on these
 * screens names the fields actually scanned ("Search by name, student ID or roll number…") — and
 * unlike a value that has to be checked against its label later, a search term is transient.
 */
export function SearchField({
  id,
  label,
  labelVisible,
  value,
  onChange,
  placeholder,
  maxLength,
  className,
}: {
  id: string;
  label: string;
  /**
   * Show the label above the box.
   *
   * For a search that is not searching the obvious thing. The attendance filter is labelled
   * "Remarks" because that is the only column it scans, and a reader who cannot see that word would
   * reasonably expect it to search students.
   */
  labelVisible?: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  className?: string;
}) {
  return (
    <div className={`w-full sm:w-auto sm:min-w-64 ${className ?? ''}`}>
      <label htmlFor={id} className={labelVisible ? 'field-label mb-1.5 block' : 'sr-only'}>
        {label}
      </label>
      <div className="relative">
        <Icon
          name="search"
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-soft"
        />
        <input
          id={id}
          type="search"
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
          /* `mt-0` undoes the stacked-form spacing `.field-input` carries; the row supplies its own. */
          className="field-input has-leading-icon has-trailing-icon mt-0"
        />
        {value ? (
          <button
            type="button"
            onClick={() => onChange('')}
            className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="x" size={14} />
            <span className="sr-only">Clear search</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A dropdown filter in a `FilterBar`.
 *
 * `label` is not rendered visibly, and that is deliberate rather than an omission: the first option
 * of every one of these selects is its own name ("All statuses", "All classes"), so the control
 * states what it filters at all times, including while a value is chosen. The label exists for
 * assistive technology, where the option text alone would read as a bare value.
 *
 * An active filter — one that is not on its default — is marked by a **stronger border and heavier
 * text**, never by colour alone.
 */
export function FilterSelect({
  id,
  label,
  labelVisible,
  value,
  onChange,
  disabled,
  children,
  className,
}: {
  id: string;
  label: string;
  /**
   * Show the label above the control.
   *
   * For a filter whose options do not name it. A date filter's value is "2026-03-01" and its empty
   * state is blank, so without a visible "Due on or after" there is nothing at all to read.
   */
  labelVisible?: boolean;
  value: string;
  onChange: (value: string) => void;
  /** For a filter another control has made irrelevant, rather than removing it from the row. */
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`w-full sm:w-auto ${className ?? ''}`}>
      <label htmlFor={id} className={labelVisible ? 'field-label mb-1.5 block' : 'sr-only'}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={`field-select mt-0 disabled:cursor-not-allowed disabled:opacity-50 ${
          value && !disabled ? 'border-muted-soft font-medium' : ''
        }`}
      >
        {children}
      </select>
    </div>
  );
}

/**
 * A date filter in a `FilterBar`.
 *
 * `labelVisible` defaults to **true** here, unlike the other two, and that is the whole reason this
 * exists rather than callers passing `type="date"` to something else: an empty date box shows
 * nothing at all, and a filled one shows `01/03/2026`. Neither says which date it means. "Due on or
 * after" has to be on screen.
 */
export function FilterDate({
  id,
  label,
  value,
  onChange,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={`w-full sm:w-auto ${className ?? ''}`}>
      <label htmlFor={id} className="field-label mb-1.5 block">
        {label}
      </label>
      <input
        id={id}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`field-input mt-0 ${value ? 'border-muted-soft font-medium' : ''}`}
      />
    </div>
  );
}

/* ─────────────────────────────────── auth stage ─────────────────────────────────── */

export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <main id="main" className="auth-stage">
      <div className="relative z-10 w-full max-w-[25rem]">
        <p className="auth-brand">
          MSMS
          <span>Multi-School Management</span>
        </p>
        <div className="auth-panel">
          <h1 className="font-display text-xl font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm leading-relaxed text-muted">{subtitle}</p> : null}
          {children}
        </div>
      </div>
    </main>
  );
}
