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
 * Four states and each transition is one-way. **Draft** can be edited — every field, the line items
 * included; **sent** cannot, because it has left the building and editing it would change what the
 * prospect was quoted. **Accepted** is final and, when the quotation names a school, converts it to an
 * invoice. **Rejected** is the end. The dialogs say which door each one closes.
 *
 * A `sent` quotation whose "valid until" has passed is **expired**, even while its stored status still
 * reads `sent`: `expireLapsed()` writes `expired` once a day (`jobs/tasks/quotationExpiry.js`), and
 * `quotations.controller present()` derives `is_expired` so a screen need not wait for the next run.
 * Such a row used to show a live "Sent" badge and an Accept button — an offer that had lapsed,
 * presented as one still open. It now reads expired and is not offered for acceptance, which is what
 * the API itself says about it from the next sweep on.
 *
 * ## Nothing here computes money
 *
 * `subtotal`, `total` and `quotation_number` are all `forbidden()` by name: the subtotal is the sum
 * of the line items, the total is subtotal − discount + tax, and the number comes from
 * `utils/documentNumber.js`. This screen sends the line items and the two adjustments and renders
 * what comes back. A total computed here would be a second opinion about an amount a prospect has
 * been quoted. It is also why each line asks for its **line total** rather than a unit price: `amount`
 * is the figure the service sums, and turning a unit price into it would be arithmetic on this side.
 *
 * ## The prospect may not be a school yet — and that decides what Accept can do
 *
 * `organization_id` and `school_id` are both nullable and `prospect_name` exists precisely because a
 * quotation is often the first contact — there is nobody in the system to point at. So the form asks
 * for a name and a contact address, and offers the school as an **optional** pick.
 *
 * The pick matters at the end. `accept` converts to an invoice by default, and an invoice has to
 * belong to a school — `accept()` refuses `convert: true` on a quotation with no `school_id`
 * (`QUOTATION_NOT_CONVERTIBLE`). Every quotation this screen created was schoolless, so Accept was
 * refused every time. A quotation that names a school is now accepted with its invoice; one that does
 * not is accepted with `convert: false`, and the dialog says plainly that no invoice follows and that
 * acceptance being final, none can be added afterwards.
 *
 * ## Editing a draft keeps what it cannot show, and can clear what it can
 *
 * `GET /quotations` returns each row whole — `line_items` and `notes` included — so the edit form now
 * opens on the real lines and notes rather than on an empty table and a blank box. It sends only what
 * changed: a field emptied is sent as `null` (or `0` for the two money adjustments, whose schema takes
 * no null), because a form that only ever sent filled fields could never take one away. A stored
 * line's `item_type`, `metadata` and unit price ride along with it, the unit price only while the
 * figures it was derived from are unchanged.
 */

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { splitApiErrors, splitIndexedErrors } from '@/lib/formErrors';
import { formatCodeWithAmount } from '@/lib/money';
import { useCollection } from '@/lib/useCollection';
import { useSchoolNames } from '@/lib/useSchoolNames';
import {
  Field,
  FormGrid,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  humaniseFieldError,
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

/** One stored line, as `quotations.service normaliseLine()` writes it into the JSON column. */
interface StoredLine {
  item_type?: string;
  description: string;
  quantity: number;
  unit_amount?: number | null;
  amount: number;
  metadata?: Record<string, unknown> | null;
}

/** A row of `GET /quotations` — the whole row, as `present()` spreads it, plus `is_expired`. */
interface Quotation {
  id: number;
  quotation_number: string;
  school_id: number | null;
  prospect_name: string | null;
  prospect_email: string | null;
  currency: string;
  /** DECIMAL(14,2), which arrives as a number — see `lib/money.ts`. */
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  status: string;
  valid_until: string | null;
  notes: string | null;
  line_items: StoredLine[] | null;
  converted_invoice_id: number | null;
  /** `sent` and past `valid_until` — derived by the controller, not stored. See the header. */
  is_expired: boolean;
}

/** What `POST /:id/accept` answers: the quotation, with the invoice it became when it became one. */
interface AcceptResult {
  quotation: { convertedInvoice?: { invoice_number: string } | null };
}

/**
 * One line while it is being typed — every field as the input holds it.
 *
 * Inferred from `BLANK_LINE` rather than annotated: `amount` is a `money()` column and
 * `verify-frontend.js` refuses any annotation typing one as `string`, because a DECIMAL arrives from
 * this API as a number and declaring otherwise would describe the payload wrongly. It is a string
 * here and a number there, which inference says without asserting anything false. `origin` is the
 * stored line an edited row was seeded from, so what the form does not show can be sent back.
 */
const BLANK_LINE = { description: '', amount: '', quantity: '1' };

type Line = typeof BLANK_LINE & { origin?: StoredLine };

/** Nothing typed into it. Only such a line is left out of the body — see `linesForBody`. */
function isBlank(line: Line): boolean {
  const quantity = line.quantity.trim();
  return !line.description.trim() && !line.amount.trim() && (quantity === '' || quantity === '1');
}

/** A stored row's lines as the form holds them, or one blank line when there are none. */
function toFormLines(stored: unknown): Line[] {
  const rows = Array.isArray(stored)
    ? (stored as StoredLine[]).filter((line) => line && typeof line === 'object')
    : [];
  const lines = rows.map((line) => ({
    description: String(line.description ?? ''),
    amount: line.amount === undefined || line.amount === null ? '' : String(line.amount),
    quantity: line.quantity === undefined || line.quantity === null ? '1' : String(line.quantity),
    origin: line,
  }));
  return lines.length ? lines : [{ ...BLANK_LINE }];
}

/**
 * The lines to send, and which form row each one came from.
 *
 * Only a **wholly** blank line is dropped. This used to drop any line without a description, so a
 * line with an amount and no words was discarded without a sound and the quotation saved short. Now
 * it is sent, and the server's "description is required" comes back under that row — which is why the
 * index map exists: a dropped blank line shifts every index after it.
 */
function linesForBody(lines: Line[]): { items: Record<string, unknown>[]; formIndexes: number[] } {
  const items: Record<string, unknown>[] = [];
  const formIndexes: number[] = [];

  lines.forEach((line, index) => {
    if (isBlank(line)) return;
    const amount = line.amount.trim();
    const quantity = line.quantity.trim() || '1';
    const item: Record<string, unknown> = {
      description: line.description.trim(),
      amount,
      quantity,
    };

    const origin = line.origin;
    if (origin) {
      if (origin.item_type) item.item_type = origin.item_type;
      if (origin.metadata) item.metadata = origin.metadata;
      /* The stored unit price holds only while the two figures it was derived from are unchanged. */
      if (
        origin.unit_amount !== undefined &&
        origin.unit_amount !== null &&
        amount === String(origin.amount) &&
        quantity === String(origin.quantity)
      ) {
        item.unit_amount = origin.unit_amount;
      }
    }

    items.push(item);
    formIndexes.push(index);
  });

  return { items, formIndexes };
}

/** Whether the lines differ from the stored ones — an edit sends `line_items` only when they do. */
function linesChanged(lines: Line[], stored: unknown): boolean {
  const before = toFormLines(stored).filter((line) => !isBlank(line));
  const after = lines.filter((line) => !isBlank(line));
  if (before.length !== after.length) return true;
  return after.some((line, index) => {
    const was = before[index];
    return (
      line.origin !== was.origin ||
      line.description.trim() !== was.description ||
      line.amount.trim() !== was.amount ||
      (line.quantity.trim() || '1') !== was.quantity
    );
  });
}

/** The fields outside the line items that render an error of their own. */
const FORM_FIELDS = [
  'school_id',
  'prospect_name',
  'prospect_email',
  'currency',
  'line_items',
  'discount_amount',
  'tax_amount',
  'valid_until',
  'notes',
];

/** `line_items.3.amount` — the path Joi reports a rejected line field by. */
const LINE_FIELD = /^line_items\.(\d+)\.(description|amount|quantity)$/;

/** What each plain transition does, and which door it closes. Accept's copy depends on the row. */
const ACTIONS: Record<
  string,
  {
    title: string;
    description: string;
    confirm: string;
    busy: string;
    /** The past tense, for the toast — "send" + "ed" is not a word. */
    done: string;
    tone: 'primary' | 'danger';
  }
> = {
  send: {
    title: 'Send this quotation?',
    description:
      'It stops being a draft and can no longer be edited — what the prospect was quoted has to stay what they were quoted. Sending stamps the date it went out.',
    confirm: 'Send quotation',
    busy: 'Sending…',
    done: 'sent',
    tone: 'primary',
  },
  accept: {
    title: 'Record this quotation as accepted?',
    description: '',
    confirm: 'Accept',
    busy: 'Accepting…',
    done: 'accepted',
    tone: 'primary',
  },
  reject: {
    title: 'Record this quotation as rejected?',
    description:
      'The end of this quotation. Nothing is deleted and it stays readable, but it cannot be sent again or accepted — raise a new one if the prospect comes back.',
    confirm: 'Reject quotation',
    busy: 'Rejecting…',
    done: 'rejected',
    tone: 'danger',
  },
};

export default function QuotationsPage() {
  const { can } = useAuth();
  const { success } = useToast();
  const { nameFor, schools } = useSchoolNames();

  const [page, setPage] = useState(1);
  const { rows, meta, loading, error: loadError, refusal, reload } = useCollection<Quotation>(
    '/quotations',
    useMemo(() => ({ page, limit: 20 }), [page])
  );

  const canManage = can('quotations.manage');

  const [editing, setEditing] = useState<Quotation | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<{ action: string; row: Quotation } | null>(null);

  const [schoolId, setSchoolId] = useState('');
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
  /** Form row index → that row's messages, already worded for the labels the row shows. */
  const [lineErrors, setLineErrors] = useState<Map<number, Record<string, string>>>(new Map());

  function clearErrors() {
    setError(null);
    setFieldErrors({});
    setLineErrors(new Map());
  }

  function resetForm() {
    setSchoolId('');
    setProspectName('');
    setProspectEmail('');
    setCurrency('USD');
    setDiscount('');
    setTax('');
    setValidUntil('');
    setNotes('');
    setLines([{ ...BLANK_LINE }]);
    clearErrors();
  }

  /*
   * Every field the row carries, the line items and notes included — see the header. A `useCallback`
   * over setters alone, so the columns memo can name it without rebuilding on every render.
   */
  const openEdit = useCallback((row: Quotation) => {
    setEditing(row);
    setSchoolId(row.school_id === null ? '' : String(row.school_id));
    setProspectName(row.prospect_name ?? '');
    setProspectEmail(row.prospect_email ?? '');
    setCurrency(row.currency);
    setDiscount(String(row.discount_amount ?? ''));
    setTax(String(row.tax_amount ?? ''));
    setValidUntil(row.valid_until ? row.valid_until.slice(0, 10) : '');
    setNotes(row.notes ?? '');
    setLines(toFormLines(row.line_items));
    setError(null);
    setFieldErrors({});
    setLineErrors(new Map());
  }, []);

  /**
   * An edit's body: what differs from the row, with an emptied field sent as a clearing value.
   * `null` for the nullable ones; `0` for the two money adjustments, which the schema will not take
   * as null and which mean "none" at zero.
   */
  function editBody(row: Quotation): Record<string, unknown> {
    const body: Record<string, unknown> = {};

    const text = (key: string, value: string, was: string | null) => {
      const now = value.trim();
      if (now !== (was ?? '')) body[key] = now === '' ? null : now;
    };
    text('prospect_name', prospectName, row.prospect_name);
    text('prospect_email', prospectEmail, row.prospect_email);
    text('notes', notes, row.notes);

    const nextCurrency = currency.trim().toUpperCase();
    if (nextCurrency !== row.currency) body.currency = nextCurrency;

    if (schoolId !== (row.school_id === null ? '' : String(row.school_id))) {
      body.school_id = schoolId ? Number(schoolId) : null;
    }

    const wasUntil = row.valid_until ? row.valid_until.slice(0, 10) : '';
    if (validUntil !== wasUntil) body.valid_until = validUntil || null;

    const money = (key: string, value: string, was: number) => {
      const now = value.trim();
      if (now !== String(was ?? '')) body[key] = now === '' ? 0 : now;
    };
    money('discount_amount', discount, row.discount_amount);
    money('tax_amount', tax, row.tax_amount);

    if (linesChanged(lines, row.line_items)) body.line_items = linesForBody(lines).items;

    return body;
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    clearErrors();

    const { items, formIndexes } = linesForBody(lines);

    try {
      if (editing) {
        const body = editBody(editing);
        await api.patch(`/quotations/${editing.id}`, body);
        success('Quotation updated');
        setEditing(null);
      } else {
        const body: Record<string, unknown> = {
          currency: currency.trim().toUpperCase(),
          line_items: items,
        };
        if (schoolId) body.school_id = Number(schoolId);
        if (prospectName.trim()) body.prospect_name = prospectName.trim();
        if (prospectEmail.trim()) body.prospect_email = prospectEmail.trim();
        if (discount.trim()) body.discount_amount = discount.trim();
        if (tax.trim()) body.tax_amount = tax.trim();
        if (validUntil) body.valid_until = validUntil;
        if (notes.trim()) body.notes = notes.trim();

        await api.post('/quotations', body);
        success('Quotation created', 'It is a draft until it is sent.');
        setCreating(false);
        resetForm();
      }
      reload();
    } catch (caught) {
      if (caught instanceof ApiError) {
        /*
         * A rejected line comes back as `line_items.2.amount`. Those whose row can be found are
         * rendered under that row; anything else — including a line index this form did not send —
         * is left to `splitApiErrors`, which promotes it to the banner rather than losing it.
         */
        const lineKeys = Object.keys(caught.fieldErrors()).filter((key) => {
          const match = LINE_FIELD.exec(key);
          return match !== null && formIndexes[Number(match[1])] !== undefined;
        });
        const { perField, banner } = splitApiErrors(caught, new Set([...FORM_FIELDS, ...lineKeys]));

        const byRow = new Map<number, Record<string, string>>();
        const { rows: sentRows } = splitIndexedErrors(
          Object.fromEntries(lineKeys.map((key) => [key, perField[key]])),
          'line_items'
        );
        const LABELS: Record<string, string> = {
          description: 'Description',
          amount: 'Line total',
          quantity: 'Quantity',
        };
        sentRows.forEach((errors, sent) => {
          const worded: Record<string, string> = {};
          for (const [field, message] of Object.entries(errors)) {
            /* Joi names the whole path — `line_items[2].amount` — which is what the rewrite matches. */
            worded[field] = humaniseFieldError(message, `line_items[${sent}].${field}`, LABELS[field] ?? field);
          }
          byRow.set(formIndexes[sent], worded);
        });
        for (const key of lineKeys) delete perField[key];

        setFieldErrors(perField);
        setLineErrors(byRow);
        setError(banner);
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
    const { row } = pending;
    try {
      /* Three calls written out, so the check that catches an uncalled route can see all three. */
      if (pending.action === 'send') {
        await api.post(`/quotations/${row.id}/send`, {});
        success(`${row.quotation_number} ${ACTIONS.send.done}`);
      } else if (pending.action === 'accept') {
        /*
         * `convert` follows the row: an invoice needs a school, and asking for one on a quotation with
         * none is refused outright. See the header.
         */
        const result = await api.post<AcceptResult>(`/quotations/${row.id}/accept`, {
          convert: row.school_id !== null,
        });
        const invoiceNumber = result?.quotation?.convertedInvoice?.invoice_number ?? null;
        success(
          `${row.quotation_number} ${ACTIONS.accept.done}`,
          invoiceNumber
            ? `Invoice ${invoiceNumber} was raised from it.`
            : 'No invoice was raised — the quotation names no school.'
        );
      } else {
        await api.post(`/quotations/${row.id}/reject`, {});
        success(`${row.quotation_number} ${ACTIONS.reject.done}`);
      }
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
            {/* Which rows can become an invoice on acceptance, at a glance. */}
            {row.school_id !== null ? (
              <span className="block text-xs text-muted">{nameFor(row.school_id)}</span>
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
            <span className="whitespace-nowrap">
              {row.valid_until.slice(0, 10)}
              {row.is_expired ? <span className="ml-2 text-xs text-danger">passed</span> : null}
            </span>
          ) : (
            <span className="text-muted-soft">no expiry</span>
          ),
      },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => (
          <div>
            {/* A lapsed offer reads as what it is, not as one still waiting on an answer. */}
            <StatusBadge status={row.is_expired ? 'expired' : row.status} />
            {row.is_expired ? (
              <span className="block text-xs text-muted-soft">sent, and lapsed unanswered</span>
            ) : null}
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
                      {/* Not on an offer that has lapsed — see the header. */}
                      {!row.is_expired ? (
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
                      ) : null}
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
    [canManage, nameFor, openEdit]
  );

  const copy = pending ? ACTIONS[pending.action] : null;
  const formOpen = creating || editing !== null;
  const editChanges = editing ? editBody(editing) : null;

  /* Accept says what follows from this row in particular: an invoice for a named school, or none. */
  const acceptDescription =
    pending?.action === 'accept'
      ? pending.row.school_id !== null
        ? `The quotation is converted into an invoice for ${nameFor(pending.row.school_id)}, built from its line items, which is what makes it payable. The quotation is kept and points at the invoice it became.`
        : 'This quotation names no school, and an invoice has to belong to one — so accepting it records the decision without raising an invoice. Acceptance is final: an invoice cannot be added to it afterwards. To invoice this prospect, reject it and raise a new quotation that names their school once it is on the platform.'
      : null;
  const acceptConfirm =
    pending?.action === 'accept'
      ? pending.row.school_id !== null
        ? 'Accept and invoice'
        : 'Accept without invoice'
      : null;

  /* A school the lookup did not return — beyond its ceiling — still has to be the selected option. */
  const schoolOptions =
    schoolId && !schools.some((school) => String(school.id) === schoolId)
      ? [{ id: Number(schoolId), name: nameFor(Number(schoolId)) }, ...schools]
      : schools;

  return (
    <div>
      <PageHeader
        title="Quotations"
        description="What a prospect is quoted, before there is a school to bill. An accepted quotation that names a school becomes an invoice."
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
            ? 'Everything on the draft, its line items included. Only what you change is sent; the subtotal and total are worked out again by the system.'
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
              /* An empty PATCH is a 422 — the update schema needs at least one field. */
              disabled={editChanges !== null && Object.keys(editChanges).length === 0}
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

          <SelectField
            id="school_id"
            label="School"
            value={schoolId}
            error={fieldErrors.school_id}
            onChange={(event) => setSchoolId(event.target.value)}
            hint="Optional. Only a quotation that names a school can become an invoice when it is accepted — a prospect with no school yet can be quoted and accepted, but not invoiced."
          >
            <option value="">No school yet — a prospect</option>
            {schoolOptions.map((school) => (
              <option key={school.id} value={school.id}>
                {school.name}
              </option>
            ))}
          </SelectField>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Line items</h3>
            {lines.map((line, index) => {
              const errors = lineErrors.get(index) ?? {};
              return (
                <div key={index} className="rounded-lg border border-border p-3">
                  <Field
                    id={`line-description-${index}`}
                    label="Description"
                    value={line.description}
                    error={errors.description}
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
                      /* The figure the service sums into the subtotal — not a unit price. */
                      label="Line total"
                      type="number"
                      step="0.01"
                      min={0}
                      value={line.amount}
                      error={errors.amount}
                      onChange={(event) =>
                        setLines((current) =>
                          current.map((row, i) =>
                            i === index ? { ...row, amount: event.target.value } : row
                          )
                        )
                      }
                      hint="The whole line, quantity included. The subtotal is the sum of these."
                    />
                    <Field
                      id={`line-quantity-${index}`}
                      label="Quantity"
                      type="number"
                      min={1}
                      value={line.quantity}
                      error={errors.quantity}
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
                      onClick={() => {
                        setLines((current) => current.filter((_, i) => i !== index));
                        /* Row messages are keyed by position, and every position after this one moves. */
                        setLineErrors(new Map());
                      }}
                    >
                      Remove line
                    </button>
                  ) : null}
                </div>
              );
            })}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setLines((current) => [...current, { ...BLANK_LINE }])}
            >
              Add a line
            </button>
            {fieldErrors.line_items ? (
              <Notice tone="error">
                {humaniseFieldError(fieldErrors.line_items, 'line_items', 'Line items')}
              </Notice>
            ) : null}
          </div>

          <FormGrid>
            <Field
              id="currency"
              label="Currency"
              required
              maxLength={3}
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
              hint="Blank for no expiry. A sent quotation lapses after this date and is no longer offered for acceptance."
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
              hint="Blank for none."
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
        description={acceptDescription ?? copy?.description}
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
              {busy ? copy?.busy ?? 'Working…' : acceptConfirm ?? copy?.confirm ?? 'Apply'}
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
