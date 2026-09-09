'use client';

/**
 * The four things that can be done to a plan from the catalogue list — FR-SUB-003, FR-SUB-004,
 * FR-SUB-005.
 *
 * ## Why a component rather than four blocks inside the list screen
 *
 * `plans/page.tsx` is the only screen that offers these today, so on the face of it they belong
 * there. They are here for a different reason: three of the four are the *same* dialog with
 * different words, and the fourth is a form. Written inline that is four overlays interleaved with
 * a table, a filter bar and a paginator, and the copy — which is the part that actually matters,
 * because "deactivate" and "archive" do genuinely different things to a school's subscription — is
 * the first thing that gets lost in it.
 *
 * ## Activate asks for nothing; the other two ask for a reason
 *
 * `plans.validation.js` is explicit: `activate` is `Joi.object({})` and `deactivate` / `archive`
 * each take an optional `reason`. That asymmetry is not cosmetic — `subscription_plans` has **no
 * reason column** and none may be added (§29 fixes the table), so the text lands in
 * `audit_logs.reason` and is the only record of why a plan left the catalogue. Turning something
 * off is the half that gets asked about six months later, which is why it is offered there and not
 * on the way back in.
 *
 * ## What these dialogs promise, and what they must not
 *
 * Deactivating and archiving change the **catalogue** and nothing else: FR-SUB-004 governs
 * availability *for new subscriptions* and FR-SUB-005 keeps an archived plan *"retained for
 * historical reference"*, so a school already paying for the plan is untouched by both. The copy
 * says that outright, because "deactivate" reads like "switch off" and an operator who believes it
 * cuts off live schools will never press it.
 *
 * Activation can be refused. `plans.service.setStatus()` throws `PLAN_NOT_PRICEABLE` — a 409 — when
 * the plan holds no active `plan_prices` row, because a plan with nothing to bill against cannot be
 * subscribed to. The dialog says so before the button is pressed and `useRowAction` puts the
 * refusal back inside the dialog rather than behind it.
 */

import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { Field, Notice, SelectField, SubmitButton, TextAreaField, focusFirstInvalidField } from '@/components/form';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';

/** The little a dialog needs to know about the plan it is acting on. */
export interface PlanTarget {
  id: number;
  name: string;
  code: string;
}

/**
 * The four things the three transition endpoints are used for.
 *
 * `restore` is `deactivate` under a different name, and the name is the point. Both write
 * `status: inactive, archived_at: null` — `plans.service.js` `TRANSITIONS` has one entry for the
 * pair — but reaching that state from `active` is withdrawing a plan from sale, and reaching it
 * from `archived` is taking a plan back out of the archive. Titling the second one "Withdraw
 * Starter from the catalogue?" would describe something that already happened.
 */
export type PlanTransition = 'activate' | 'deactivate' | 'archive' | 'restore';

const COPY: Record<
  PlanTransition,
  { title: (name: string) => string; description: string; confirm: string; busy: string; reason: boolean }
> = {
  activate: {
    title: (name) => `Offer ${name} for new subscriptions?`,
    description:
      'Schools will be able to subscribe to this plan from now on. It needs at least one active price to be sellable — without one the request is refused rather than published.',
    confirm: 'Activate plan',
    busy: 'Activating…',
    reason: false,
  },
  deactivate: {
    title: (name) => `Withdraw ${name} from the catalogue?`,
    description:
      'No new subscription can be taken on this plan. Schools already on it keep it and keep being billed — nothing about their subscription changes. You can offer it again at any time.',
    confirm: 'Withdraw plan',
    busy: 'Withdrawing…',
    reason: true,
  },
  restore: {
    title: (name) => `Take ${name} out of the archive?`,
    description:
      'The plan returns to the catalogue as a draft — visible here and still not offered to anyone. Activate it separately once you are satisfied with its pricing.',
    confirm: 'Restore plan',
    busy: 'Restoring…',
    reason: true,
  },
  archive: {
    title: (name) => `Archive ${name}?`,
    description:
      'The plan is kept for reference and stops being offered. Schools already on it are unaffected, and nothing is deleted — an archived plan still appears in this list under the archived filter, and can be brought back.',
    confirm: 'Archive plan',
    busy: 'Archiving…',
    reason: true,
  },
};

/**
 * One status transition, confirmed.
 *
 * Not `ConfirmDialog`: two of the three carry a field, and a confirm dialog that grew one would be
 * this component with a worse name.
 */
export function PlanStatusDialog({
  transition,
  plan,
  busy,
  conflict,
  onCancel,
  onConfirm,
}: {
  /** Null closes the dialog; the last non-null value is kept while it animates out. */
  transition: PlanTransition;
  plan: PlanTarget | null;
  busy: boolean;
  /** A 409 — most often "this plan has no active price" — shown here rather than behind the dialog. */
  conflict: string | null;
  onCancel: () => void;
  /** The reason, or null when the box was left empty or the transition takes none. */
  onConfirm: (reason: string | null) => void | Promise<void>;
}) {
  const copy = COPY[transition];
  const [reason, setReason] = useState('');

  /* A fresh box per plan, so the reason typed for one is not filed against the next. */
  useEffect(() => {
    if (plan) setReason('');
  }, [plan, transition]);

  return (
    <Modal
      open={Boolean(plan)}
      onClose={onCancel}
      title={copy.title(plan?.name ?? 'this plan')}
      description={copy.description}
      size="sm"
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className="btn btn-secondary">
            Cancel
          </button>
          <SubmitButton form="plan-transition" busy={busy} busyLabel={copy.busy}>
            {copy.confirm}
          </SubmitButton>
        </>
      }
    >
      {/* The submit is in the footer, outside this element — `form=` connects the two. */}
      <form
        id="plan-transition"
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void onConfirm(reason.trim() || null);
        }}
      >
        {conflict ? <Notice tone="error">{conflict}</Notice> : null}

        {copy.reason ? (
          <TextAreaField
            id="plan-transition-reason"
            label="Reason"
            rows={3}
            maxLength={255}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            hint="Optional, up to 255 characters. Kept in the audit log — the plan record itself has no field for it."
          />
        ) : null}
      </form>
    </Modal>
  );
}

/** §10.2's Public/Private, as `plans.validation.js` accepts them. */
const VISIBILITIES = ['public', 'private'];

/**
 * FR-SUB-003 — Duplicate Plan.
 *
 * ## Why this one owns its own request
 *
 * The other three go through `useRowAction`, which turns anything that is not a 409 into a toast.
 * That is right for a confirmation and wrong for a form: `code` is `.required()` and pattern-checked,
 * so a rejected duplicate has a message that belongs **under the box that caused it**. A toast saying
 * *"code must start with a letter or digit"* over a dialog still holding the bad value is the worst
 * of both.
 *
 * ## What it deliberately does not ask
 *
 * `plans.service.duplicate()` copies the source's description, trial and grace periods, renewal mode
 * and tier rank, along with all four configuration collections — prices, modules, features and
 * limits — because FR-SUB-003 is *"copying the source plan's configuration"*. Re-asking for any of
 * that here would invite an operator to change one field of a copy in a dialog that shows none of
 * the others. The four fields below are the ones that **must** differ or that a copy gets wrong by
 * inheritance: the code is unique, the name would otherwise read as the original, the display order
 * would sit the copy on top of its source, and visibility is the one property worth deciding before
 * the copy exists rather than after.
 *
 * The copy is always created inactive, whatever the source's status, so there is no status control.
 */
export function PlanDuplicateDialog({
  plan,
  onCancel,
  onDone,
}: {
  plan: PlanTarget | null;
  onCancel: () => void;
  /** The list's `reload`. Called after the copy exists. */
  onDone: () => void;
}) {
  const { success } = useToast();

  const [values, setValues] = useState({ code: '', name: '', visibility: '', display_order: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!plan) return;
    setValues({ code: '', name: '', visibility: '', display_order: '' });
    setFieldErrors({});
    setError(null);
    setSaving(false);
  }, [plan]);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }));

  async function onSubmit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!plan || saving) return;

    setSaving(true);
    setError(null);
    setFieldErrors({});

    /* Blank means "let the service decide", which for a duplicate means "take the source's". */
    const body: Record<string, string | number> = { code: values.code.trim() };
    if (values.name.trim()) body.name = values.name.trim();
    if (values.visibility) body.visibility = values.visibility;
    if (values.display_order.trim()) body.display_order = Number(values.display_order.trim());

    try {
      await api.post(`/plans/${plan.id}/duplicate`, body);
      success(`${plan.name} duplicated`, 'The copy is inactive until you activate it.');
      onDone();
      onCancel();
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        setError('Could not reach the server. Check your connection and try again.');
      } else {
        const perField = caught.fieldErrors();
        setFieldErrors(perField);
        focusFirstInvalidField();
        const formLevel = caught.formErrors();
        setError(
          formLevel.length ? formLevel.join(' ') : Object.keys(perField).length ? null : caught.message
        );
      }
      setSaving(false);
    }
  }

  return (
    <Modal
      open={Boolean(plan)}
      onClose={saving ? () => {} : onCancel}
      title={`Duplicate ${plan?.name ?? 'this plan'}?`}
      description="The copy carries this plan's prices, modules, features and limits, and starts inactive so you can change them before it is offered."
      busy={saving}
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={saving} className="btn btn-secondary">
            Cancel
          </button>
          <SubmitButton form="plan-duplicate" busy={saving} busyLabel="Duplicating…">
            Create copy
          </SubmitButton>
        </>
      }
    >
      <form id="plan-duplicate" className="space-y-4" noValidate onSubmit={onSubmit}>
        {error ? <Notice tone="error">{error}</Notice> : null}

        <Field
          id="code"
          label="Code for the copy"
          required
          value={values.code}
          onChange={set('code')}
          error={fieldErrors.code}
          hint={
            plan
              ? `Must differ from ${plan.code}. 2 to 60 characters, starting with a letter or digit; letters, digits, hyphens and underscores only.`
              : undefined
          }
        />

        <Field
          id="name"
          label="Name for the copy"
          value={values.name}
          onChange={set('name')}
          error={fieldErrors.name}
          hint={plan ? `Leave blank to call it "${plan.name} (Copy)".` : undefined}
        />

        <SelectField
          id="visibility"
          label="Visibility"
          value={values.visibility}
          onChange={set('visibility')}
          error={fieldErrors.visibility}
          hint="Blank keeps whatever the original uses. A private copy is the shape for a rate negotiated with one school."
        >
          <option value="">Same as the original</option>
          {VISIBILITIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </SelectField>

        <Field
          id="display_order"
          label="Display order"
          type="number"
          min={0}
          max={100000}
          step={1}
          value={values.display_order}
          onChange={set('display_order')}
          error={fieldErrors.display_order}
          hint="Blank keeps the original's, which puts the copy alongside it in the catalogue."
        />
      </form>
    </Modal>
  );
}
