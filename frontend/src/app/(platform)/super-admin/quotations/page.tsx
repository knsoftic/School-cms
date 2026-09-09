'use client';

/**
 * Quotations — SRS §13, and five write routes with no caller and no screen.
 *
 * `POST /quotations`, `PATCH /quotations/:id`, `POST /:id/send`, `POST /:id/accept` and
 * `POST /:id/reject`. The module exists, is verified, allocates its own numbers and converts an
 * accepted quotation into an invoice — and there was no way to raise one.
 *
 * ## §33 does not name this screen
 *
 * Same as Taxes, and reached from Invoices for the same reason: the platform nav is asserted against
 * §33's sixteen in both directions, and a quotation's whole purpose is to become one of the invoices
 * on that screen.
 *
 * ## A quotation is a document that becomes a decision
 *
 * Four states and each transition is one-way. **Draft** can be edited; **sent** cannot, because it
 * has left the building and editing it would change what the prospect was quoted. **Accepted**
 * converts to an invoice by default — `accept` takes `convert`, defaulting true — and **rejected**
 * is the end. The dialogs say which door each one closes.
 *
 * ## Nothing here computes money
 *
 * `subtotal`, `total` and `quotation_number` are all `forbidden()` by name: the subtotal is the sum
 * of the line items, the total is subtotal − discount + tax, and the number comes from
 * `utils/documentNumber.js`. This screen sends the line items and the two adjustments and renders
 * what comes back. A total computed here would be a second opinion about an amount a prospect has
 * been quoted.
 *
 * ## The prospect may not be a school yet
 *
 * `organization_id` and `school_id` are both nullable and `prospect_name` exists precisely because a
 * quotation is often the first contact — there is nobody in the system to point at. So the form asks
 * for a name and a contact address rather than making the reader pick a school that does not exist.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { formatCodeWithAmount } from '@/lib/money';
import { useCollection } from '@/lib/useCollection';
import {
  Field,
  FormGrid,
  Notice,
  SubmitButton,
  TextAreaField,
} from '@/components/form';
import { Modal } from '@/components/overlay';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  Pagination,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';
import { useToast } from '@/components/toast';

interface Quotation {
  id: number;
  quotation_number: string;
  prospect_name: string | null;
  prospect_email: string | null;
  currency: string;
  subtotal: number | string;
  discount_amount: number | string;
  tax_amount: number | string;
  total: number | string;
  status: string;
  valid_until: string | null;
  converted_invoice_id: number | null;
}

/**
 * One line while it is being typed — every field as the input holds it.
 *
 * Inferred from `BLANK_LINE` rather than annotated: `amount` is a `money()` column and
 * `verify-frontend.js` refuses any annotation typing one as `string`, because a DECIMAL arrives from
 * this API as a number and declaring otherwise would describe the payload wrongly. It is a string
 * here and a number there, which inference says without asserting anything false.
 */
const BLANK_LINE = { description: '', amount: '', quantity: '1' };

type Line = typeof BLANK_LINE;

/** What each transition does, and which door it closes. */
const ACTIONS: Record<
  string,
  { label: string; title: string; description: string; confirm: string; busy: string; tone: 'primary' | 'danger' }
> = {
  send: {
    label: 'Send',
    title: 'Send this quotation?',
    description:
      'It stops being a draft and can no longer be edited — what the prospect was quoted has to stay what they were quoted. Sending stamps the date it went out.',
    confirm: 'Send quotation',
    busy: 'Sending…',
    tone: 'primary',
  },
  accept: {
    label: 'Accept',
    title: 'Record this quotation as accepted?',
    description:
      'An accepted quotation is converted into an invoice, which is what makes it payable. The quotation is kept and points at the invoice it became.',
    confirm: 'Accept and invoice',
    busy: 'Accepting…',
    tone: 'primary',
  },
  reject: {
    label: 'Reject',
    title: 'Record this quotation as rejected?',
    description:
      'The end of this quotation. Nothing is deleted and it stays readable, but it cannot be sent again or accepted — raise a new one if the prospect comes back.',
    confirm: 'Reject quotation',
    busy: 'Rejecting…',
    tone: 'danger',
  },
};

export default function QuotationsPage() {
  const { can } = useAuth();
  const { success } = useToast();

  const [page, setPage] = useState(1);
  const { rows, meta, loading, error: loadError, refusal, reload } = useCollection<Quotation>(
    '/quotations',
    useMemo(() => ({ page, limit: 20 }), [page])
  );

  const canManage = can('quotations.manage');

  const [editing, setEditing] = useState<Quotation | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<{ action: string; row: Quotation } | null>(null);

  const [prospectName, setProspectName] = useState('');
  const [prospectEmail, setProspectEmail] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [discount, setDiscount] = useState('');
  const [tax, setTax] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([{ ...BLANK_LINE }]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function resetForm() {
    setProspectName('');
    setProspectEmail('');
    setCurrency('USD');
    setDiscount('');
    setTax('');
    setValidUntil('');
    setNotes('');
    setLines([{ ...BLANK_LINE }]);
    setError(null);
    setFieldErrors({});
  }

  function openEdit(row: Quotation) {
    /*
     * The list does not return `line_items`, so an edit opened from here would start with an empty
     * table and saving would replace the real lines with nothing. The form therefore edits only the
     * fields the list carries, and says so — rather than silently destroying what it cannot show.
     */
    setEditing(row);
    setProspectName(row.prospect_name ?? '');
    setProspectEmail(row.prospect_email ?? '');
    setCurrency(row.currency);
    setDiscount(String(row.discount_amount ?? ''));
    setTax(String(row.tax_amount ?? ''));
    setValidUntil(row.valid_until ? row.valid_until.slice(0, 10) : '');
    setNotes('');
    setError(null);
    setFieldErrors({});
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const body: Record<string, unknown> = { currency: currency.trim().toUpperCase() };
      if (prospectName.trim()) body.prospect_name = prospectName.trim();
      if (prospectEmail.trim()) body.prospect_email = prospectEmail.trim();
      if (discount.trim()) body.discount_amount = discount.trim();
      if (tax.trim()) body.tax_amount = tax.trim();
      if (validUntil) body.valid_until = validUntil;
      if (notes.trim()) body.notes = notes.trim();

      if (editing) {
        await api.patch(`/quotations/${editing.id}`, body);
        success('Quotation updated');
        setEditing(null);
      } else {
        /* Only a create sends the lines — see the note in `openEdit`. */
        body.line_items = lines
          .filter((line) => line.description.trim() !== '')
          .map((line) => ({
            description: line.description.trim(),
            amount: line.amount.trim(),
            quantity: line.quantity.trim() || '1',
          }));
        await api.post('/quotations', body);
        success('Quotation created', 'It is a draft until it is sent.');
        setCreating(false);
        resetForm();
      }
      reload();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(Array.isArray(caught.details) ? caught.fieldErrors() : {});
        setError(
          Array.isArray(caught.details)
            ? caught.bannerFor([
                'prospect_name',
                'prospect_email',
                'currency',
                'line_items',
                'discount_amount',
                'tax_amount',
                'valid_until',
                'notes',
              ])
            : caught.message
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function runAction() {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      /* Three calls written out, so the check that catches an uncalled route can see all three. */
      if (pending.action === 'send') {
        await api.post(`/quotations/${pending.row.id}/send`, {});
      } else if (pending.action === 'accept') {
        await api.post(`/quotations/${pending.row.id}/accept`, { convert: true });
      } else {
        await api.post(`/quotations/${pending.row.id}/reject`, {});
      }
      success(`${pending.row.quotation_number} ${pending.action}ed`);
      setPending(null);
      reload();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<Column<Quotation>[]>(
    () => [
      {
        key: 'number',
        header: 'Quotation',
        cell: (row) => <code className="whitespace-nowrap font-medium">{row.quotation_number}</code>,
      },
      {
        key: 'prospect',
        header: 'Prospect',
        cell: (row) => (
          <div>
            <span>{row.prospect_name ?? <span className="text-muted-soft">unnamed</span>}</span>
            {row.prospect_email ? (
              <span className="block text-xs text-muted-soft">{row.prospect_email}</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'total',
        header: 'Total',
        numeric: true,
        cell: (row) => (
          <div>
            <span>{formatCodeWithAmount(row.currency, row.total)}</span>
            {/* The server's arithmetic, shown rather than recomputed — see the header. */}
            <span className="block text-xs text-muted-soft">
              {formatCodeWithAmount(row.currency, row.subtotal)} before adjustments
            </span>
          </div>
        ),
      },
      {
        key: 'valid',
        header: 'Valid until',
        cell: (row) =>
          row.valid_until ? (
            <span className="whitespace-nowrap">{row.valid_until.slice(0, 10)}</span>
          ) : (
            <span className="text-muted-soft">no expiry</span>
          ),
      },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => (
          <div>
            <StatusBadge status={row.status} />
            {row.converted_invoice_id ? (
              <span className="block text-xs text-success">invoiced</span>
            ) : null}
          </div>
        ),
      },
      ...(canManage
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: Quotation) => (
                <div className="flex flex-wrap gap-1">
                  {/* A draft is the only editable and the only sendable state. */}
                  {row.status === 'draft' ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => openEdit(row)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => {
                          setPending({ action: 'send', row });
                          setError(null);
                        }}
                      >
                        Send
                      </button>
                    </>
                  ) : null}
                  {row.status === 'sent' ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => {
                          setPending({ action: 'accept', row });
                          setError(null);
                        }}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger-ghost"
                        onClick={() => {
                          setPending({ action: 'reject', row });
                          setError(null);
                        }}
                      >
                        Reject
                      </button>
                    </>
                  ) : null}
                  {row.status !== 'draft' && row.status !== 'sent' ? (
                    <span className="text-muted-soft">—</span>
                  ) : null}
                </div>
              ),
            } as Column<Quotation>,
          ]
        : []),
    ],
    [canManage]
  );

  const copy = pending ? ACTIONS[pending.action] : null;
  const formOpen = creating || editing !== null;

  return (
    <div>
      <PageHeader
        title="Quotations"
        description="What a prospect is quoted, before there is a school to bill. An accepted quotation becomes an invoice."
        action={
          <div className="flex gap-2">
            <Link href="/super-admin/invoices" className="btn btn-secondary">
              Invoices
            </Link>
            {canManage ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  resetForm();
                  setCreating(true);
                }}
              >
                New quotation
              </button>
            ) : null}
          </div>
        }
      />

      {error && !formOpen && !pending ? (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : loadError ? (
        <ErrorNotice message={loadError} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          No quotation has been raised. A quotation is the step before an invoice, for a prospect who
          is not yet a school on the platform.
        </EmptyNotice>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption="Quotations"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <Modal
        open={formOpen}
        onClose={() => {
          if (busy) return;
          setCreating(false);
          setEditing(null);
        }}
        title={editing ? `Edit ${editing.quotation_number}` : 'New quotation'}
        description={
          editing
            ? 'The prospect and the adjustments. The line items are not shown — the list does not return them, and a form that saved an empty table would delete the real ones.'
            : 'What the prospect is being quoted. The number, the subtotal and the total are all worked out by the system.'
        }
        size="lg"
        busy={busy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                setCreating(false);
                setEditing(null);
              }}
            >
              Cancel
            </button>
            <SubmitButton
              form="quotation-form"
              busy={busy}
              busyLabel={editing ? 'Saving…' : 'Creating…'}
              fullWidth={false}
            >
              {editing ? 'Save changes' : 'Create quotation'}
            </SubmitButton>
          </>
        }
      >
        <form
          id="quotation-form"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {error ? <Notice tone="error">{error}</Notice> : null}

          <FormGrid>
            <Field
              id="prospect_name"
              label="Prospect"
              value={prospectName}
              error={fieldErrors.prospect_name}
              onChange={(event) => setProspectName(event.target.value)}
              hint="Who is being quoted. They need not exist as a school yet — that is what a quotation is for."
            />
            <Field
              id="prospect_email"
              label="Contact email"
              type="email"
              value={prospectEmail}
              error={fieldErrors.prospect_email}
              onChange={(event) => setProspectEmail(event.target.value)}
            />
          </FormGrid>

          {creating ? (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Line items</h3>
              {lines.map((line, index) => (
                <div key={index} className="rounded-lg border border-border p-3">
                  <Field
                    id={`line-description-${index}`}
                    label="Description"
                    value={line.description}
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((row, i) =>
                          i === index ? { ...row, description: event.target.value } : row
                        )
                      )
                    }
                  />
                  <FormGrid>
                    <Field
                      id={`line-amount-${index}`}
                      label="Amount"
                      type="number"
                      step="0.01"
                      min={0}
                      value={line.amount}
                      onChange={(event) =>
                        setLines((current) =>
                          current.map((row, i) =>
                            i === index ? { ...row, amount: event.target.value } : row
                          )
                        )
                      }
                    />
                    <Field
                      id={`line-quantity-${index}`}
                      label="Quantity"
                      type="number"
                      min={1}
                      value={line.quantity}
                      onChange={(event) =>
                        setLines((current) =>
                          current.map((row, i) =>
                            i === index ? { ...row, quantity: event.target.value } : row
                          )
                        )
                      }
                    />
                  </FormGrid>
                  {lines.length > 1 ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger-ghost mt-2"
                      onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                    >
                      Remove line
                    </button>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setLines((current) => [...current, { ...BLANK_LINE }])}
              >
                Add a line
              </button>
              {fieldErrors.line_items ? (
                <Notice tone="error">{fieldErrors.line_items}</Notice>
              ) : null}
            </div>
          ) : null}

          <FormGrid>
            <Field
              id="currency"
              label="Currency"
              required
              value={currency}
              error={fieldErrors.currency}
              onChange={(event) => setCurrency(event.target.value)}
            />
            <Field
              id="valid_until"
              label="Valid until"
              type="date"
              value={validUntil}
              error={fieldErrors.valid_until}
              onChange={(event) => setValidUntil(event.target.value)}
            />
          </FormGrid>

          <FormGrid>
            <Field
              id="discount_amount"
              label="Discount"
              type="number"
              step="0.01"
              min={0}
              value={discount}
              error={fieldErrors.discount_amount}
              onChange={(event) => setDiscount(event.target.value)}
            />
            <Field
              id="tax_amount"
              label="Tax"
              type="number"
              step="0.01"
              min={0}
              value={tax}
              error={fieldErrors.tax_amount}
              onChange={(event) => setTax(event.target.value)}
              hint="An amount, not a rate. The total is the subtotal minus the discount plus this."
            />
          </FormGrid>

          <TextAreaField
            id="notes"
            label="Notes"
            rows={3}
            value={notes}
            error={fieldErrors.notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </form>
      </Modal>

      <Modal
        open={pending !== null}
        onClose={() => {
          if (!busy) setPending(null);
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
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`btn ${copy?.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
              disabled={busy}
              aria-busy={busy}
              onClick={() => void runAction()}
            >
              {busy ? copy?.busy ?? 'Working…' : copy?.confirm ?? 'Apply'}
            </button>
          </>
        }
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        {pending ? (
          <p className="text-sm text-muted">
            {pending.row.quotation_number} ·{' '}
            {formatCodeWithAmount(pending.row.currency, pending.row.total)}
            {pending.row.prospect_name ? ` · ${pending.row.prospect_name}` : ''}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}
