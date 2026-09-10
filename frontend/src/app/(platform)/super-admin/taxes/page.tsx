'use client';

/**
 * Taxes — SRS §13, and five write routes with no caller and no screen.
 *
 * `POST /taxes`, `PATCH /taxes/:id`, `DELETE /taxes/:id`, `POST /taxes/:id/default` and
 * `POST /taxes/default/clear`. An invoice can cite a tax and nothing in the product could define
 * one, so every invoice this platform has raised has been untaxed by necessity rather than by
 * choice.
 *
 * ## §33 does not name this screen either
 *
 * The same reasoning as school settings, and slightly stronger: §33's Super Admin list of sixteen
 * names no Taxes screen, and `taxes` is one of §29's sixty-four tables with a full CRUD API and a
 * permission pair of its own. `verify-frontend.js` asserts the platform nav against §33 in both
 * directions, so this is reached from **Invoices** — the only place a tax is ever applied — rather
 * than from the sidebar.
 *
 * ## "Default" is a single-holder flag, and the API owns it
 *
 * `POST /:id/default` makes one tax the default and, by doing so, unmakes whichever was. That is not
 * something two requests should do, which is why setting it is its own route rather than a field on
 * the edit form — `is_default` is accepted by `update` and is deliberately **not** offered here, so
 * the exclusivity is never expressed by two screens disagreeing about who holds it.
 * `POST /default/clear` is the other half: no tax at all is the default, which is a state the flag
 * alone cannot reach by setting.
 *
 * Two consequences on this screen. "Make default" is offered only on an **active** tax that is not
 * already the default: `setDefault()` refuses an inactive one with `TAX_INACTIVE`, because
 * `resolveForInvoice()` only ever reads an active default, so the button used to promise a refusal.
 * And whether a default exists at all is asked of the API — `GET /taxes?is_default=true` — rather than
 * read off the rows in view: the list is paged at 25, and a default held by a tax on another page used
 * to hide the "Clear default" button on this one.
 *
 * ## The create dialog's errors are shown in the dialog
 *
 * A failed create used to set the page-level notice, which sits behind the modal's backdrop — so a
 * rejected rate or a taken code produced a dialog that did nothing visible. The message now renders
 * inside the form, and the page-level notice is held back while any dialog is open.
 *
 * ## Inclusive is not a rate, it is a reading of the amount
 *
 * `is_inclusive` says the invoice total already contains the tax rather than the tax being added to
 * it. Two invoices with the same figures and different `is_inclusive` are different amounts of
 * money, so it is a checkbox with a sentence rather than a flag beside the rate.
 */

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { splitApiErrors } from '@/lib/formErrors';
import { useCollection } from '@/lib/useCollection';
import { EditDialog } from '@/components/editDialog';
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

interface Tax {
  id: number;
  name: string;
  code: string;
  rate_percent: number | string;
  is_inclusive: boolean;
  country: string | null;
  state: string | null;
  is_active: boolean;
  is_default: boolean;
  description: string | null;
}

/** The create form's inputs. A 422 naming anything else is promoted to the dialog's banner. */
const CREATE_FIELDS = new Set(['name', 'code', 'rate_percent', 'description']);

export default function TaxesPage() {
  const { can } = useAuth();
  const { success } = useToast();

  const [page, setPage] = useState(1);
  const { rows, meta, loading, error: loadError, refusal, reload } = useCollection<Tax>(
    '/taxes',
    useMemo(() => ({ page, limit: 25 }), [page])
  );

  /*
   * Whether any tax holds the default, across every page — see the header. `is_default` is a filter
   * the list schema accepts, and one row answers the question.
   */
  const { rows: defaultRows, reload: reloadDefault } = useCollection<Tax>('/taxes', {
    is_default: 'true',
    limit: 1,
  });
  const hasDefault = defaultRows.length > 0;

  /* Every write can move the default — making one, clearing it, deactivating or deleting its holder. */
  const reloadAll = useCallback(() => {
    reload();
    reloadDefault();
  }, [reload, reloadDefault]);

  const canManage = can('taxes.manage');

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Tax | null>(null);
  const [removing, setRemoving] = useState<Tax | null>(null);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [rate, setRate] = useState('');
  const [inclusive, setInclusive] = useState(false);
  const [description, setDescription] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        code: code.trim(),
        rate_percent: rate.trim(),
        is_inclusive: inclusive,
      };
      if (description.trim()) body.description = description.trim();
      await api.post('/taxes', body);
      success('Tax created', 'Making it the default is a separate step.');
      setCreating(false);
      setName('');
      setCode('');
      setRate('');
      setInclusive(false);
      setDescription('');
      reloadAll();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const { perField, banner } = splitApiErrors(caught, CREATE_FIELDS);
        setFieldErrors(perField);
        setError(banner);
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  /*
   * `useCallback`: the columns memo captures this, and a plain function would be a new value every
   * render that the memo silently keeps the old copy of. Named by `react-hooks/exhaustive-deps`.
   */
  const makeDefault = useCallback(async (row: Tax) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/taxes/${row.id}/default`, {});
      success(`${row.name} is now the default`, 'Whichever tax held it no longer does.');
      reloadAll();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setBusy(false);
    }
  }, [busy, reloadAll, success]);

  async function clearDefault() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/taxes/default/clear', {});
      success('No default tax', 'New invoices are raised untaxed unless a tax is named on them.');
      reloadAll();
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

  async function remove() {
    if (!removing || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/taxes/${removing.id}`);
      success(`${removing.name} deleted`);
      setRemoving(null);
      reloadAll();
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

  const columns = useMemo<Column<Tax>[]>(
    () => [
      {
        key: 'name',
        header: 'Tax',
        cell: (row) => (
          <div>
            <span className="font-medium">{row.name}</span>
            <span className="block text-xs text-muted-soft">{row.code}</span>
          </div>
        ),
      },
      {
        key: 'rate',
        header: 'Rate',
        numeric: true,
        cell: (row) => (
          <div>
            <span>{row.rate_percent}%</span>
            <span className="block text-xs text-muted-soft">
              {row.is_inclusive ? 'included in the total' : 'added to the total'}
            </span>
          </div>
        ),
      },
      {
        key: 'where',
        header: 'Applies in',
        cell: (row) =>
          row.country || row.state ? (
            <span className="text-muted">{[row.state, row.country].filter(Boolean).join(', ')}</span>
          ) : (
            <span className="text-muted-soft">anywhere</span>
          ),
      },
      {
        key: 'status',
        header: 'Status',
        cell: (row) => (
          <div>
            <StatusBadge status={row.is_active ? 'active' : 'inactive'} />
            {row.is_default ? (
              <span className="block text-xs text-success">default</span>
            ) : null}
          </div>
        ),
      },
      ...(canManage
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: Tax) => (
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => setEditing(row)}
                  >
                    Edit
                  </button>
                  {/* Active and not already the default — the API refuses an inactive one. */}
                  {row.is_active && !row.is_default ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      disabled={busy}
                      onClick={() => void makeDefault(row)}
                    >
                      Make default
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-sm btn-danger-ghost"
                    onClick={() => {
                      setRemoving(row);
                      setError(null);
                    }}
                  >
                    Delete
                  </button>
                </div>
              ),
            } as Column<Tax>,
          ]
        : []),
    ],
    [canManage, busy, makeDefault]
  );

  /* Closing a dialog takes its message with it, so it does not resurface on the page behind. */
  function closeCreate() {
    if (busy) return;
    setCreating(false);
    setError(null);
    setFieldErrors({});
  }

  return (
    <div>
      <PageHeader
        title="Taxes"
        description="What an invoice may be taxed at. §13 lets an invoice cite one; this is where they are defined."
        action={
          <div className="flex gap-2">
            <Link href="/super-admin/invoices" className="btn btn-secondary">
              Invoices
            </Link>
            {canManage && hasDefault ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void clearDefault()}
              >
                Clear default
              </button>
            ) : null}
            {canManage ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setCreating(true);
                  setError(null);
                  setFieldErrors({});
                }}
              >
                Add a tax
              </button>
            ) : null}
          </div>
        }
      />

      {/* Held back while a dialog is open: each dialog shows its own, above its backdrop. */}
      {error && !creating && removing === null ? (
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
          No tax is defined, so every invoice is raised untaxed. Adding one does not by itself change
          that — an invoice uses the default, and a new tax is not the default until it is made so.
        </EmptyNotice>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption="Taxes"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <Modal
        open={creating}
        onClose={closeCreate}
        title="Add a tax"
        description="A rate an invoice can be raised at. It is not applied to anything until it is made the default or named on an invoice."
        size="lg"
        busy={busy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={closeCreate}
            >
              Cancel
            </button>
            <SubmitButton form="create-tax" busy={busy} busyLabel="Creating…" fullWidth={false}>
              Create tax
            </SubmitButton>
          </>
        }
      >
        <form
          id="create-tax"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          {error ? <Notice tone="error">{error}</Notice> : null}

          <FormGrid>
            <Field
              id="name"
              label="Name"
              required
              value={name}
              error={fieldErrors.name}
              onChange={(event) => setName(event.target.value)}
            />
            <Field
              id="code"
              label="Code"
              required
              value={code}
              error={fieldErrors.code}
              onChange={(event) => setCode(event.target.value)}
              hint="Short form that appears on the invoice."
            />
          </FormGrid>

          <Field
            id="rate_percent"
            label="Rate (%)"
            type="number"
            step="0.01"
            min={0}
            required
            value={rate}
            error={fieldErrors.rate_percent}
            onChange={(event) => setRate(event.target.value)}
          />

          <div className="flex items-start gap-2 text-sm">
            <input
              id="is_inclusive"
              type="checkbox"
              className="mt-0.5 size-4"
              checked={inclusive}
              onChange={(event) => setInclusive(event.target.checked)}
            />
            <label htmlFor="is_inclusive">
              The invoice total already includes this tax
              <span className="block text-xs text-muted">
                Left unticked, the tax is added on top. The same figures under the two readings are
                different amounts of money, so this is worth getting right before the first invoice.
              </span>
            </label>
          </div>

          <TextAreaField
            id="description"
            label="Description"
            rows={2}
            value={description}
            error={fieldErrors.description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </form>
      </Modal>

      <EditDialog
        row={editing}
        title={editing ? `Edit ${editing.name}` : ''}
        description="Changing a rate does not re-tax invoices already raised — each carries what it was taxed at."
        success="Tax updated"
        onClose={() => setEditing(null)}
        onSaved={reloadAll}
        save={(row, body) => api.patch(`/taxes/${row.id}`, body)}
        initial={(row) => ({
          name: row.name,
          code: row.code,
          rate_percent: String(row.rate_percent),
          is_inclusive: row.is_inclusive,
          country: row.country ?? '',
          state: row.state ?? '',
          is_active: row.is_active,
          description: row.description ?? '',
        })}
        fields={[
          { name: 'name', label: 'Name', required: true },
          { name: 'code', label: 'Code', required: true },
          { name: 'rate_percent', label: 'Rate (%)', kind: 'number', step: '0.01', min: 0 },
          {
            name: 'is_inclusive',
            kind: 'checkbox',
            label: 'The invoice total already includes this tax',
            hint: 'Unticked means it is added on top.',
          },
          { name: 'country', label: 'Country', nullable: true },
          { name: 'state', label: 'State', nullable: true },
          {
            name: 'is_active',
            kind: 'checkbox',
            label: 'Available',
            hint: 'An inactive tax cannot be applied to a new invoice. Invoices already taxed keep it.',
          },
          { name: 'description', label: 'Description', kind: 'textarea', rows: 2, nullable: true },
        ]}
      >
        {/*
          * `is_default` is accepted by the update schema and is not a field here: making a tax the
          * default unmakes the previous one, which is a single-holder change the API does through
          * its own route. Two ways to set it is how two screens come to disagree about who holds it.
          */}
        <Notice tone="info">
          Whether this is the default tax is set from the row’s own action, not from this form.
        </Notice>
      </EditDialog>

      <Modal
        open={removing !== null}
        onClose={() => {
          if (busy) return;
          setRemoving(null);
          setError(null);
        }}
        title={`Delete ${removing ? removing.name : 'this tax'}?`}
        description="An invoice that has already cited this tax keeps what it was taxed at. If the tax is in use the API refuses, and deactivating it instead takes it out of circulation."
        size="sm"
        busy={busy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                setRemoving(null);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void remove()}
            >
              {busy ? 'Deleting…' : 'Delete tax'}
            </button>
          </>
        }
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
      </Modal>
    </div>
  );
}
