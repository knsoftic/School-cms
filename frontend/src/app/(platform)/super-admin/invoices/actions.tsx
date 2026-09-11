'use client';

/**
 * The four things that can be done to an invoice — SRS §13.1, FR-BILL-001, and §13.3's coupons.
 *
 * `POST /:id/finalise`, `POST /:id/cancel`, `POST /:id/coupon` and `DELETE /:id/coupon`, none of
 * which had a caller. The screen could list invoices and generate a run of them; it could not issue
 * one, void one, or apply the discount coupons exist to give.
 *
 * ## Why this is a module of its own
 *
 * It was written inside the Invoices list, and the single-invoice screen offers the same four. Two
 * copies of the dialog, its copy and its four calls would be two chances for the confirmation text or
 * the refusal handling to drift apart, so both screens take this hook — and `actionsFor()`, which
 * decides which of the four an invoice is offered. That decision used to be written out on each
 * screen, and the two copies had already drifted: the list offered both coupon buttons on every open
 * invoice, the detail screen one of them.
 *
 * ## Finalise is the one that changes what the invoice *is*
 *
 * A draft is a working document; finalising issues it, which is what makes it payable and what the
 * §23 job notifies about. The copy says that rather than "are you sure", because an operator who
 * reads "finalise" as "save" will issue every draft they open.
 *
 * ## Cancel is not delete
 *
 * `invoices.status` moves to `cancelled` and the row stays — it is billing history, and §13 gives no
 * delete route at all. Cancelling gives two things back, and the dialog says so: any credit the
 * invoice drew is returned to the subscription's balance, and the use of a coupon on it is released
 * (`releaseCouponUse()`), so the code counts one use fewer against its Maximum Uses. An invoice with
 * anything paid against it cannot be cancelled — `cancel()` refuses a paid or refunded one, and one
 * with a part payment — so the button is not offered on one.
 *
 * ## The coupon is applied by **code**, not by picking from the catalogue
 *
 * `applyCoupon` takes `{ code }` and the service resolves it — checking that it exists, is active,
 * is inside its window, has redemptions left and applies to this invoice's plan. A picker built from
 * `GET /coupons` would offer codes that fail every one of those checks and would still have to send
 * the code. So the control is the field the API actually takes, and the refusal it can give is
 * rendered where the code was typed.
 */

import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { formatCodeWithAmount } from '@/lib/money';
import { Field, Notice, SubmitButton, TextAreaField } from '@/components/form';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';

/**
 * The fields of an invoice the dialog and `actionsFor()` read.
 *
 * Both `GET /invoices` rows and `GET /invoices/:id` carry every one: `invoices.controller.present()`
 * spreads the whole row, list and detail alike. `plan_id` is nullable (`onDelete: 'SET NULL'` on the
 * column), and so is `coupon_id`.
 */
export interface ActionableInvoice {
  id: number;
  invoice_number: string;
  school_id: number;
  plan_id: number | null;
  currency: string;
  subtotal: number;
  total: number;
  amount_paid: number;
  coupon_id: number | null;
  status: string;
  /**
   * Read off the joined tax row by `present()`, on list rows and the detail read alike. Optional only
   * because the list's row type does not name it; the coupon preview's wording depends on it.
   */
  tax_is_inclusive?: boolean;
}

/** `MUTABLE_STATUSES` in `invoices.service.js` — the statuses whose totals may still be rewritten. */
const MUTABLE_STATUSES = new Set(['draft', 'unpaid']);

/** The statuses `cancel()` refuses outright; a part-paid one it refuses on `amount_paid` instead. */
const UNCANCELLABLE_STATUSES = new Set(['cancelled', 'paid', 'refunded']);

/**
 * Which of the four actions an invoice is offered — the service's own refusals, read in advance.
 *
 *  - **Finalise** — `finalise()` accepts a `draft` and nothing else.
 *  - **Apply a coupon** — `applyCoupon()` wants a `MUTABLE_STATUSES` invoice, nothing paid against it,
 *    and no coupon already on it (`invoices.coupon_id` is one column; §13.4 describes no stacking).
 *  - **Remove the coupon** — `removeCoupon()` wants a coupon on it, and the same status and payment test.
 *  - **Cancel** — `cancel()` refuses one already cancelled, a paid or refunded one, and any with money
 *    paid against it. A draft, an unpaid and an overdue invoice can be cancelled while nothing is paid.
 *
 * `amount_paid` is compared with zero and nothing else: it is a `DECIMAL(14,2)` the server keeps as the
 * sum of approved payments, so any positive value is at least a cent — `money.toMinor() > 0`'s test.
 * The API stays the authority; this only stops a screen offering a button whose one outcome is a 409.
 */
export function actionsFor(invoice: ActionableInvoice): {
  finalise: boolean;
  applyCoupon: boolean;
  removeCoupon: boolean;
  cancel: boolean;
} {
  const nothingPaid = !(Number(invoice.amount_paid) > 0);
  const mutable = MUTABLE_STATUSES.has(invoice.status) && nothingPaid;
  return {
    finalise: invoice.status === 'draft',
    applyCoupon: mutable && !invoice.coupon_id,
    removeCoupon: mutable && Boolean(invoice.coupon_id),
    cancel: !UNCANCELLABLE_STATUSES.has(invoice.status) && nothingPaid,
  };
}

const INVOICE_ACTIONS: Record<
  string,
  {
    label: string;
    title: string;
    description: string;
    confirm: string;
    busy: string;
    tone: 'primary' | 'danger';
    /** True for the one action that carries a field of its own. */
    code?: boolean;
  }
> = {
  finalise: {
    label: 'Finalise',
    title: 'Issue this invoice?',
    description:
      'Finalising turns a draft into an issued invoice: it becomes payable, it counts towards what the school owes, and it can fall overdue. Its number and lines stay as they are, and a coupon can still be applied or removed until something is paid against it or it falls overdue. To replace it instead, cancel it and generate the period again — a draft blocks a second invoice for its period just as an issued one does.',
    confirm: 'Finalise invoice',
    busy: 'Finalising…',
    tone: 'primary',
  },
  cancel: {
    label: 'Cancel',
    title: 'Cancel this invoice?',
    description:
      'The invoice stops being payable and is kept as billing history — nothing is deleted, and §13 provides no way to delete one. Any credit it drew goes back to the subscription’s balance, and a coupon on it has its use released, so the code can be used again; the code stays printed on the cancelled invoice. An invoice with anything paid against it cannot be cancelled: the way back from money received is a refund.',
    confirm: 'Cancel invoice',
    busy: 'Cancelling…',
    tone: 'danger',
  },
  coupon: {
    label: 'Apply coupon',
    title: 'Apply a coupon to this invoice?',
    description:
      'The discount is worked out by the API from the coupon’s own rules on this invoice’s subtotal — its lines added up — and tax is then worked out again on what is left. A coupon that has expired, run out of redemptions or does not apply to this plan is refused with the reason.',
    confirm: 'Apply coupon',
    busy: 'Applying…',
    tone: 'primary',
    code: true,
  },
  uncoupon: {
    label: 'Remove coupon',
    title: 'Remove the coupon from this invoice?',
    description:
      'The discount comes off and the total goes back up. The redemption is released, so the coupon can be used again elsewhere.',
    confirm: 'Remove coupon',
    busy: 'Removing…',
    tone: 'danger',
  },
};

/**
 * The dialog, its state and its four calls.
 *
 * Returns `ask`, which a screen's buttons call with the action and the invoice, and `dialog`, which
 * the screen renders once. `onDone` runs after a success, and both callers re-read: every one of the
 * four changes a status or a total the screen is showing.
 */
export function useInvoiceActions({
  onDone,
  nameFor,
}: {
  onDone: () => void;
  /** The school lookup the calling screen already holds, for the line naming the invoice. */
  nameFor: (id: number) => string;
}): { ask: (action: string, invoice: ActionableInvoice) => void; dialog: ReactNode } {
  const { success } = useToast();
  const { can } = useAuth();
  const [pending, setPending] = useState<{ action: string; invoice: ActionableInvoice } | null>(null);
  const [couponCode, setCouponCode] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /*
   * The coupon preview — `POST /coupons/validate`, which had no caller anywhere.
   *
   * `docs/VERIFICATION.md` classified it as *deliberately* uncalled, "a checkout-time call and there
   * is no checkout screen". That was right about the absence and wrong about the conclusion: this
   * dialog **is** the checkout moment for an invoice, and it has every field the endpoint needs —
   * the school, the plan, the subtotal and the currency all sit on the row. What it adds over simply
   * applying the coupon is the figure: `POST /:id/coupon` answers with the invoice, so an operator who
   * wants to know what a code is worth before committing has to commit to find out.
   *
   * It asks the question `applyCoupon()` asks. That calls `validateForOrder()` with the invoice's
   * `school_id`, `plan_id`, **`subtotal`** and `currency`, and `computeTotals()` then takes the discount
   * off the subtotal before tax is worked out. This used to send `total` — tax included, credit not yet
   * taken — and no `plan_id`: so a percentage was worked out on the wrong figure, a minimum order could
   * pass here and fail there, and a coupon restricted to other plans read as applying. With the same
   * four inputs the two checks agree; what can still differ is the moment, since a use can be spent by
   * someone else in between.
   */
  const [preview, setPreview] = useState<{ discount: number; net: number; label: string } | null>(null);
  const [checking, setChecking] = useState(false);

  /*
   * Which check the screen is still waiting for.
   *
   * A check is a request, and the answer can arrive after the question has changed: the code edited,
   * the dialog closed, or reopened on another invoice. Its answer would then fill the preview — or the
   * error banner — for a code or an invoice it was not about, and a figure is exactly the thing an
   * operator acts on. So every check takes a number, anything that makes a pending answer stale moves
   * the number on, and an answer carrying an old number is dropped. A ref, not state: it is read
   * inside the request's continuation, which a state value captured at call time could not see change.
   */
  const checkToken = useRef(0);

  /** Forget any preview, and any check still in flight — see `checkToken`. */
  const discardPreview = useCallback(() => {
    checkToken.current += 1;
    setPreview(null);
    setChecking(false);
  }, []);

  const copy = pending ? INVOICE_ACTIONS[pending.action] : null;

  /* Stable, so a screen can list it among a memoised column set's dependencies. */
  const ask = useCallback(
    (action: string, invoice: ActionableInvoice) => {
      discardPreview();
      setPending({ action, invoice });
      setCouponCode('');
      setReason('');
      setActionError(null);
    },
    [discardPreview]
  );

  /** Close the dialog. A check still in flight belongs to it and is discarded with it. */
  function close() {
    discardPreview();
    setPending(null);
  }

  /** Ask the API what a code is worth against this invoice, without applying it. */
  async function checkCoupon() {
    if (!pending || checking || couponCode.trim() === '') return;
    checkToken.current += 1;
    const token = checkToken.current;
    const { invoice } = pending;
    setChecking(true);
    setActionError(null);
    setPreview(null);
    try {
      const result = await api.post<{
        discount_amount: number;
        net_amount: number;
        coupon: { code: string; discount_type: string; discount_value: number };
      }>('/coupons/validate', {
        code: couponCode.trim(),
        school_id: invoice.school_id,
        /* Omitted when null: `plan_id` is `.min(1)`, and `applyCoupon()` passes a null plan as none. */
        ...(invoice.plan_id ? { plan_id: invoice.plan_id } : {}),
        amount: invoice.subtotal,
        currency: invoice.currency,
      });
      if (token !== checkToken.current) return;
      setPreview({
        discount: result.discount_amount,
        net: result.net_amount,
        label:
          result.coupon.discount_type === 'percentage'
            ? `${result.coupon.discount_value}% off`
            : 'fixed amount off',
      });
    } catch (caught) {
      if (token !== checkToken.current) return;
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      if (token === checkToken.current) setChecking(false);
    }
  }

  async function run() {
    if (!pending || busy) return;
    setBusy(true);
    setActionError(null);
    const body = reason.trim() ? { reason: reason.trim() } : {};
    const id = pending.invoice.id;
    try {
      /*
       * Four calls written out rather than one path built from `pending.action`.
       *
       * `verify-frontend.js` collects `api.<method>(` followed immediately by a path literal, so a
       * URL assembled from the action name is invisible to the very check that exists to catch a
       * route with no caller — recorded in `subscriptions/[id]/lifecycle.tsx` after two drafts of
       * this same mistake. The `DELETE` carries its reason like the other three: `api.delete` takes
       * a body in its options, and the route validates it (`reasonOnly`) and `removeCoupon()` writes
       * it to the audit trail.
       */
      if (pending.action === 'finalise') {
        await api.post(`/invoices/${id}/finalise`, body);
      } else if (pending.action === 'cancel') {
        await api.post(`/invoices/${id}/cancel`, body);
      } else if (pending.action === 'coupon') {
        await api.post(`/invoices/${id}/coupon`, { code: couponCode.trim(), ...body });
      } else {
        await api.delete(`/invoices/${id}/coupon`, { body });
      }
      success(`${copy?.label ?? 'Done'} — ${pending.invoice.invoice_number}`);
      close();
      onDone();
    } catch (caught) {
      /*
       * Shown inside the dialog rather than as a toast behind it. Every refusal these four can give
       * is actionable where the operator is standing — a coupon that has expired, an invoice already
       * paid, a draft that is already issued — and a message behind an open dialog is a message read
       * through the thing that is covering it.
       */
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <Modal
      open={pending !== null}
      onClose={() => {
        if (!busy) close();
      }}
      title={copy?.title ?? ''}
      description={copy?.description}
      size="sm"
      busy={busy}
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={close}
          >
            {/* "Go back", not "Cancel", on the dialog whose action is itself a cancellation. */}
            {pending?.action === 'cancel' ? 'Go back' : 'Cancel'}
          </button>
          <SubmitButton
            form="invoice-action"
            busy={busy}
            busyLabel={copy?.busy ?? 'Working…'}
            fullWidth={false}
            disabled={pending?.action === 'coupon' && couponCode.trim() === ''}
          >
            {copy?.confirm ?? 'Apply'}
          </SubmitButton>
        </>
      }
    >
      <form
        id="invoice-action"
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        {actionError ? <Notice tone="error">{actionError}</Notice> : null}

        {pending ? (
          <p className="text-sm text-muted">
            Invoice <strong>{pending.invoice.invoice_number}</strong> ·{' '}
            {nameFor(pending.invoice.school_id)} ·{' '}
            {formatCodeWithAmount(pending.invoice.currency, pending.invoice.total)}
          </p>
        ) : null}

        {copy?.code ? (
          <>
            <Field
              id="coupon-code"
              label="Coupon code"
              required
              value={couponCode}
              onChange={(event) => {
                setCouponCode(event.target.value);
                /*
                 * A preview belongs to the code it was fetched for, and this is a different one — so is
                 * the answer to a check still in flight, and so is a refusal of the last code.
                 */
                discardPreview();
                setActionError(null);
              }}
              hint="Exactly as issued. Whether it applies to this invoice is decided by the API from the coupon’s own rules."
            />

            {/*
              * `POST /coupons/validate` is `requirePermission('coupons.redeem')`, a different key from
              * the `invoices.manage` that offered this dialog — and applying accepts either, so an
              * account can hold the one that applies and not the one that checks.
              */}
            {can('coupons.redeem') ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={checking || couponCode.trim() === ''}
                aria-busy={checking}
                onClick={() => void checkCoupon()}
              >
                {checking ? 'Checking…' : 'Check what it is worth'}
              </button>
            ) : (
              <p className="text-sm text-muted">
                Checking what a code is worth before applying it needs the coupon-redemption
                permission, which this account does not hold.
              </p>
            )}

            {/*
              * `net_amount` is the subtotal less the discount, which is the amount `computeTotals()`
              * works tax out on. An exclusive tax is then added to it; an inclusive one is already
              * inside it (`quoteFor()` adds nothing), so the figure is the new total. What is still due
              * after credit is the API's to state, and the invoice shows it once the coupon is applied.
              */}
            {preview && pending ? (
              <Notice tone="success">
                {preview.label} —{' '}
                <strong>
                  {formatCodeWithAmount(pending.invoice.currency, preview.discount)}
                </strong>{' '}
                off the {formatCodeWithAmount(pending.invoice.currency, pending.invoice.subtotal)}{' '}
                subtotal, leaving {formatCodeWithAmount(pending.invoice.currency, preview.net)}
                {pending.invoice.tax_is_inclusive
                  ? ' — the new total, as this invoice’s tax is inclusive and already inside it.'
                  : ' before any tax is added.'}{' '}
                Applying it runs the same checks again, so a use taken elsewhere in the meantime can
                still see it refused.
              </Notice>
            ) : null}
          </>
        ) : null}

        <TextAreaField
          id="invoice-reason"
          label="Reason"
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          hint={
            /* `cancel()` writes a given reason over `invoices.notes`; a blank one leaves them alone. */
            pending?.action === 'cancel'
              ? 'Recorded in the audit trail, and it replaces the invoice’s notes. Left blank, the notes stay as they are.'
              : 'Recorded in the audit trail.'
          }
        />
      </form>
    </Modal>
  );

  return { ask, dialog };
}
