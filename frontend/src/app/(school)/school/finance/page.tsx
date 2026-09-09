'use client';

/**
 * Finance — SRS §18, §33's "Finance", checklist row 4.4.
 *
 * Two collections under one §33 screen, following `library/page.tsx`: `/finance/incomes` and
 * `/finance/expenses`, plus the **Net Balance summary** from `/finance/report`.
 *
 * The summary was previously deferred "to the school Reports screen", and that screen does not exist
 * and is not required: §33's School list is exactly seventeen entries — Principal Dashboard,
 * Teachers, Staff, Students, Parents, Classes, Sections, Subjects, Attendance, Fees, **Finance**,
 * Exams, Results, Timetable, Homework, Library, Documents — and Reports is not among them. So the
 * deferral pointed nowhere, and FR-FIN-002's Expected Outcome — *"Net Balance is displayed on the
 * finance dashboard"* — went unmet while the checklist recorded the requirement Completed. The
 * backend had computed it all along (`finance.service.js:502`); nothing rendered it. `net_balance`
 * did not appear anywhere in `frontend/src`.
 *
 * ## Money arrives as a number, and is never summed here
 *
 * This header used to say `amount` "is returned as a **string** — deliberately". It is not:
 * `config/database.js` sets `dialectOptions.decimalNumbers = true`, so mysql2 parses DECIMAL into a
 * JS number before Sequelize sees it. Measured, not reasoned.
 *
 * The rule the old sentence was reaching for still holds, and is the important part: **nothing here
 * accumulates money.** A total across pages would be a total of *the page*, which is worse than no
 * total at all. `/finance/report` sums the whole ledger, and that is where the three figures above
 * the tabs come from.
 *
 * `attachment_path` exists on both tables and is **never rendered** — it is a server storage path,
 * and this screen has no route to serve those bytes.
 */

import { Suspense, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EXPLAINED_CODES, useCollection } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  Pagination,
  RefusalNotice,
} from '@/components/table';
import { Tabs, TabPanel, useActiveTab } from '@/components/tabs';
import type { TabDef } from '@/components/tabs';
import {
  Field,
  Notice,
  SelectField,
  TextAreaField,
  focusFirstInvalidField,
  SearchField,
  FilterBar,
  FilterSelect,
  SubmitButton,
} from '@/components/form';
import { Icon } from '@/components/icon';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';

/**
 * §18's two categories per ledger, mirroring `EXPENSE_CATEGORIES` / `INCOME_CATEGORIES`
 * (`backend/src/config/constants.js:480-488`), which the list endpoints validate against.
 */
const CATEGORIES: Record<'incomes' | 'expenses', { value: string; label: string }[]> = {
  incomes: [
    { value: 'fees', label: 'Fees' },
    { value: 'other_income', label: 'Other income' },
  ],
  expenses: [
    { value: 'salaries', label: 'Salaries' },
    { value: 'other_expenses', label: 'Other expenses' },
  ],
};

interface Entry {
  id: number;
  category: string;
  subcategory: string | null;
  title: string;
  currency: string;
  amount: string | number;
  payment_method: string | null;
  reference: string | null;
  /* Income carries `received_from` and `income_date`; expense carries `paid_to` and `expense_date`. */
  received_from?: string | null;
  paid_to?: string | null;
  income_date?: string;
  expense_date?: string;
}

const TABS: TabDef[] = [
  { key: 'incomes', label: 'Income' },
  { key: 'expenses', label: 'Expenses' },
];

/**
 * Display only — never accumulate.
 *
 * The parameter stays `string | number` on purpose. DECIMAL arrives as a number today, and the one
 * dialect option that decides it (`decimalNumbers`) is a single line in `config/database.js`; a
 * formatter that copes with both cannot be broken by flipping it.
 */
function money(amount: string | number, currency: string) {
  const value = typeof amount === 'number' ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(value)) return <span className="text-muted-soft">—</span>;
  return (
    <span className="tabular-nums">
      {value.toFixed(2)} <span className="text-muted-soft">{currency}</span>
    </span>
  );
}

function LedgerPanel({ kind, onRecorded }: { kind: 'incomes' | 'expenses'; onRecorded: () => void }) {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [recording, setRecording] = useState(false);

  const query = useMemo(
    () => ({ page, limit: 20, q: search || undefined, category: category || undefined }),
    [page, search, category]
  );
  const { rows, meta, loading, error, refusal, reload } = useCollection<Entry>(`/finance/${kind}`, query);

  const isIncome = kind === 'incomes';

  const columns = useMemo<Column<Entry>[]>(
    () => [
      {
        key: 'date',
        header: 'Date',
        cell: (row) => (isIncome ? row.income_date : row.expense_date)?.slice(0, 10) ?? '—',
      },
      { key: 'title', header: 'Description', cell: (row) => <span className="font-medium">{row.title}</span> },
      {
        key: 'category',
        header: 'Category',
        /*
         * Subcategory is shown beneath rather than as its own column: it is null on most rows, and an
         * almost-empty column costs the table width it needs for the figures.
         */
        cell: (row) => (
          <>
            {row.category.replace(/_/g, ' ')}
            {row.subcategory ? (
              <span className="block text-xs text-muted-soft">{row.subcategory}</span>
            ) : null}
          </>
        ),
      },
      {
        key: 'party',
        header: isIncome ? 'Received from' : 'Paid to',
        cell: (row) => (isIncome ? row.received_from : row.paid_to) ?? <span className="text-muted-soft">—</span>,
      },
      {
        key: 'method',
        header: 'Method',
        cell: (row) => row.payment_method?.replace(/_/g, ' ') ?? <span className="text-muted-soft">—</span>,
      },
      { key: 'amount', header: 'Amount', numeric: true, cell: (row) => money(row.amount, row.currency) },
    ],
    [isIncome]
  );

  return (
    <>
      <FilterBar
        activeCount={[category, search].filter(Boolean).length}
        onClear={() => {
          setCategory('');
          setSearch('');
          setPage(1);
        }}
      >
        <div>
          <SearchField
            id={`${kind}-search`}
            label={`Search ${isIncome ? 'income' : 'expenses'}`}
            placeholder="Description or reference…"
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
          />
        </div>
        <div>
          {/*
            A select, not a free-text box — which is what this was, and it broke the screen on the
            first keystroke.

            §18 fixes the categories: expenses are { salaries, other_expenses } and incomes are
            { fees, other_income } (SRS:935-938, `constants.js:480-488`), and the list endpoints pin
            the filter to those enums (`finance.validation.js:207,220`). The box sent whatever was
            typed, so any input at all was an off-enum value: Joi refused the request with 422 and the
            ledger vanished behind "Validation failed". A control that cannot be used correctly is
            worse than no control.

            The options mirror the enums rather than restating them loosely; there are two per ledger
            because §18 lists two.
          */}
          <FilterSelect
            id={`${kind}-category`}
            label="Category"
            value={category}
            onChange={(value) => {
              setCategory(value);
              setPage(1);
            }}
          >
            <option value="">Any category</option>
            {CATEGORIES[kind].map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </FilterSelect>
        </div>
        {can('finance.manage') ? (
          /*
           * A button, not a link. This pointed at `/school/finance/${kind}/new`, and no such route
           * exists — the primary action on the finance screen landed on a 404. The record form is a
           * dialog on this screen instead of a page of its own: it is six fields, the ledger behind
           * it is the context you are recording against, and returning to a refreshed list is the
           * whole point of the action.
           */
          <button
            type="button"
            onClick={() => setRecording(true)}
            className="ml-auto self-start btn btn-primary"
          >
            <Icon name="plus" size={15} />
            {isIncome ? 'Record income' : 'Record expense'}
          </button>
        ) : null}
      </FilterBar>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>
          {search || category
            ? 'Nothing matches these filters.'
            : `No ${isIncome ? 'income' : 'expenses'} recorded yet.`}
        </EmptyNotice>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={isIncome ? 'Income entries' : 'Expense entries'}
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <RecordEntryDialog
        kind={kind}
        open={recording}
        onClose={() => setRecording(false)}
        onRecorded={() => {
          setRecording(false);
          reload();
          /* The ledger and the totals are two reads; both are now stale. */
          onRecorded();
        }}
      />
    </>
  );
}

/**
 * Record one income or expense — FR-FIN-001's "Accountant records income / records an expense".
 *
 * ## Only the fields the schema requires, plus the two that are usually wanted
 *
 * `createIncome` / `createExpense` require `title`, `amount` and the date; everything else is
 * optional. So this asks for those three, plus category and a description, and stops. `currency`,
 * `academic_session_id`, `student_id` and the salary recipient fields are all accepted by the
 * endpoint and are deliberately **not** here: the first three default at the column or the service,
 * and a salary payment naming its recipient is a different form than "record a cost" — the model's
 * own `salaryNeedsRecipient` validator refuses it, and this dialog surfaces that 422 rather than
 * pretending to satisfy it.
 *
 * ## The date defaults to today and is not pre-filled by a client clock beyond that
 *
 * A ledger entry is almost always being recorded on the day it happened. `toISOString().slice(0,10)`
 * is UTC, which is the same calendar day the API stores it under — using a local-midnight date here
 * would let an entry recorded late in the evening west of UTC land on the previous day in the ledger.
 */
function RecordEntryDialog({
  kind,
  open,
  onClose,
  onRecorded,
}: {
  kind: 'incomes' | 'expenses';
  open: boolean;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const isIncome = kind === 'incomes';
  const { success } = useToast();

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [entryCategory, setEntryCategory] = useState(isIncome ? 'other_income' : 'other_expenses');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /* Reopening must not show the last entry's values, or the previous attempt's errors. */
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setAmount('');
    setDate(today);
    setEntryCategory(isIncome ? 'other_income' : 'other_expenses');
    setDescription('');
    setBusy(false);
    setFailure(null);
    setFieldErrors({});
  }, [open, today, isIncome]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setFieldErrors({});

    try {
      await api.post(`/finance/${kind}`, {
        title: title.trim(),
        amount,
        [isIncome ? 'income_date' : 'expense_date']: date,
        category: entryCategory,
        description: description.trim() || undefined,
      });
      success(isIncome ? 'Income recorded' : 'Expense recorded');
      onRecorded();
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      /*
       * Field errors go to the fields. `ApiError.fieldErrors()` normalises the two shapes the API
       * sends under `details`; anything that is not per-field falls back to the banner, which is
       * where a 422 with only a top-level message belongs.
       */
      const perField = caught.fieldErrors();
      if (Object.keys(perField).length > 0) {
        setFieldErrors(perField);
        focusFirstInvalidField();
      } else {
        setFailure(caught.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={isIncome ? 'Record income' : 'Record expense'}
      description={
        isIncome
          ? 'Money received. This is the only path by which a fees income row is created.'
          : 'Money paid out. Salaries must name a recipient, which this form does not collect.'
      }
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <SubmitButton
            form="record-entry"
            busy={busy}
            busyLabel="Recording…"
          >
            {isIncome ? 'Record income' : 'Record expense'}
          </SubmitButton>
        </>
      }
    >
      {/* The submit button lives in the footer, outside this element — `form=` is what connects them. */}
      <form id="record-entry" onSubmit={submit} className="space-y-4">
        {failure ? <Notice tone="error">{failure}</Notice> : null}

        <Field
          id="title"
          label={isIncome ? 'What was received' : 'What was paid for'}
          required
          maxLength={180}
          value={title}
          error={fieldErrors.title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={isIncome ? 'Term 2 fees — Class 5' : 'Generator fuel'}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="amount"
            label="Amount"
            required
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={amount}
            error={fieldErrors.amount}
            onChange={(event) => setAmount(event.target.value)}
            hint="Two decimal places."
          />
          <Field
            id={isIncome ? 'income_date' : 'expense_date'}
            label="Date"
            required
            type="date"
            value={date}
            error={fieldErrors[isIncome ? 'income_date' : 'expense_date']}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>

        <SelectField
          id="entry-category"
          label="Category"
          value={entryCategory}
          error={fieldErrors.category}
          onChange={(event) => setEntryCategory(event.target.value)}
        >
          {CATEGORIES[kind].map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>

        <TextAreaField
          id="description"
          label="Description"
          rows={2}
          value={description}
          error={fieldErrors.description}
          onChange={(event) => setDescription(event.target.value)}
          hint="Optional. Anything the figure alone does not explain."
        />
      </form>
    </Modal>
  );
}

interface FinanceReport {
  currency: string | null;
  income: { total: number };
  expense: { total: number };
  net_balance: number;
}

/**
 * FR-FIN-002's Expected Outcome, rendered.
 *
 * The three figures come from `/finance/report`, which sums across the whole ledger rather than the
 * page in view — the distinction the ledger tabs deliberately refuse to blur by totalling a page.
 *
 * A deficit is shown as a negative and is never clamped, because `finance.service.js:502` does not
 * clamp it either: *"a deficit is real"*. Colouring it is the whole point of showing it.
 */
function NetBalance({ version }: { version: number }) {
  const [report, setReport] = useState<FinanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  /* Bumped by the retry button; the effect keys on it. */
  const [attempt, setAttempt] = useState(0);

  /*
   * The multi-currency case, which used to be a dead end.
   *
   * `/finance/report` is called with no `currency`, and `finance.service.js report()` refuses a
   * window holding more than one — *"This window holds more than one currency, so a single net
   * balance is undefined"* — with `details: [{ field: 'currency', message: 'Name one of: EUR, USD' }]`.
   * That is a correct refusal: there is no conversion table, and adding the two would be arithmetic
   * nobody asked for. But the screen rendered it as a plain error with a **retry button that could
   * never succeed**, so a school billing in two currencies had a permanent red box where its Net
   * Balance belongs and nothing to do about it.
   *
   * The server names the options in the message it already sends, so the refusal is turned into the
   * control it implies.
   */
  const [choices, setChoices] = useState<string[]>([]);
  const [chosenCurrency, setChosenCurrency] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setRefusal(null);
    (async () => {
      try {
        /*
         * `{ report }`, not the report: `finance.controller.js:83` answers
         * `ApiResponse.ok(res, { report: data })`. Reading `result` directly threw a TypeError on
         * `report.income.total` below — and before it threw, `Number(report.net_balance) < 0` was
         * `NaN < 0`, i.e. false, so a school in deficit would have been painted in the success
         * colour. Same envelope mistake as the Super Admin dashboard's thirteen NaN cards.
         */
        const result = await api.get<{ report: FinanceReport }>('/finance/report', {
          signal: controller.signal,
          query: { currency: chosenCurrency || undefined },
        });
        if (controller.signal.aborted) return;
        setReport(result.report ?? null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          const named = caught.fieldErrors().currency;
          if (named) {
            /*
             * Tolerant on purpose: the codes are read out of the server's own sentence, and if that
             * sentence ever changes shape the list comes back empty and the message is shown as
             * received — which is the old behaviour, not a worse one.
             */
            const offered = [...new Set(named.match(/\b[A-Z]{3}\b/g) ?? [])];
            setChoices(offered);
            setError(offered.length > 0 ? null : caught.message);
            setReport(null);
          } else {
            setError(caught.message);
          }
        } else if ((caught as Error)?.name !== 'AbortError') {
          setError('Could not reach the server. Check your connection and try again.');
        }
      }
    })();
    return () => controller.abort();
    /*
     * `version` is bumped when an entry is recorded on either ledger. Without it these three figures
     * stayed at the values they were fetched with: recording 1,250.75 of income left the card reading
     * 0.00 beside a ledger row showing the entry, which reads as the total being wrong rather than
     * stale. The report sums the whole ledger, so it has to be re-asked, not adjusted locally.
     */
  }, [attempt, version, chosenCurrency]);

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (error) return <ErrorNotice message={error} onRetry={() => setAttempt((n) => n + 1)} />;

  /* Two currencies in the window: pick one, because a single net balance across both is undefined. */
  if (choices.length > 0 && !report) {
    return (
      <div className="surface mb-6 p-5">
        <p className="text-sm font-semibold text-ink">Which currency?</p>
        <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">
          This school has recorded money in more than one currency, and there is no conversion rate
          here — so Income, Expense and Net Balance have to be read one currency at a time.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {choices.map((code) => (
            <button
              key={code}
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setChosenCurrency(code)}
            >
              {code}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (!report) return null;

  const currency = report.currency ?? '';
  const deficit = Number(report.net_balance) < 0;

  return (
    <dl className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="rounded-md border border-border px-4 py-3">
        <dt className="text-xs uppercase tracking-wide text-muted-soft">Income</dt>
        <dd className="mt-1 text-lg font-semibold tabular-nums">{money(report.income.total, currency)}</dd>
      </div>
      <div className="rounded-md border border-border px-4 py-3">
        <dt className="text-xs uppercase tracking-wide text-muted-soft">Expense</dt>
        <dd className="mt-1 text-lg font-semibold tabular-nums">{money(report.expense.total, currency)}</dd>
      </div>
      <div className="rounded-md border border-border px-4 py-3">
        <dt className="text-xs uppercase tracking-wide text-muted-soft">Net balance</dt>
        <dd
          className={`mt-1 text-lg font-semibold tabular-nums ${
            deficit ? 'text-danger' : 'text-success'
          }`}
        >
          {money(report.net_balance, currency)}
        </dd>
      </div>
    </dl>
  );
}

function FinanceScreen() {
  const [active, setActive] = useActiveTab(TABS);
  /* Bumped whenever a ledger entry is recorded, so the totals above the tabs re-ask the report. */
  const [ledgerVersion, setLedgerVersion] = useState(0);

  return (
    <div>
      <PageHeader
        title="Finance"
        description="Money in and money out. Totals come from the finance report, not from a page of rows."
      />
      <NetBalance version={ledgerVersion} />
      <Tabs tabs={TABS} active={active} onChange={setActive} label="Finance sections" />
      <TabPanel tabKey={active}>
        {/*
         * `key` is load-bearing, not decoration.
         *
         * This was one `LedgerPanel` whose `kind` prop changed, so React reconciled it as the same
         * element and **kept its state**. Select "Fees" on Income, switch to Expenses, and the panel
         * sent `category=fees` to `/finance/expenses` — a value outside `EXPENSE_CATEGORIES`, so the
         * endpoint answered 422 and the whole ledger showed an error for a filter the user could not
         * see was still set. `page` and `search` leaked the same way: page four of the income ledger
         * is not page four of the expense ledger.
         *
         * Keying on `kind` remounts the panel, which resets all three at once — the fix belongs here
         * rather than in three effects inside the panel, because the panel's state is *per ledger* and
         * this is the line that says which ledger it is.
         */}
        <LedgerPanel
          key={active === 'expenses' ? 'expenses' : 'incomes'}
          kind={active === 'expenses' ? 'expenses' : 'incomes'}
          onRecorded={() => setLedgerVersion((n) => n + 1)}
        />
      </TabPanel>
    </div>
  );
}

export default function FinancePage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <FinanceScreen />
    </Suspense>
  );
}
