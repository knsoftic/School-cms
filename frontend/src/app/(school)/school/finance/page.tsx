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
 * JS number before Sequelize sees it. Measured, not reasoned — `lib/money.ts` records the
 * measurement.
 *
 * Every figure is formatted by `formatAmountWithCode` from that file. The local `money()` this screen
 * used to carry printed `toFixed(2)` with no grouping, so the headline Net Balance read `4835000.00`
 * — the hardest form of a large figure to read, and the easiest to misjudge by a factor of ten.
 *
 * The rule the old sentence was reaching for still holds, and is the important part: **nothing here
 * accumulates money.** A total across pages would be a total of *the page*, which is worse than no
 * total at all. `/finance/report` sums the whole ledger, and that is where the three figures above
 * the tabs come from — and, since FR-FIN-003 was given its controls, the per-category split beneath
 * them and the window they cover.
 *
 * `attachment_path` exists on both tables and is **never rendered** — it is a server storage path,
 * and this screen has no route to serve those bytes.
 */

import { Suspense, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { formatAmountWithCode } from '@/lib/money';
import { localDay } from '@/lib/instants';
import { splitApiErrors } from '@/lib/formErrors';
import { OPTION_LIMIT, teacherName, useWholeList } from '@/lib/useTimetablePickers';
import type { Picker, TeacherOption } from '@/lib/useTimetablePickers';
import { EditDialog } from '@/components/editDialog';
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
  FilterDate,
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
  /* A number — see the header. */
  amount: number;
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

/** A category's label from the list above, or the stored word spelled out for one it does not know. */
function categoryLabel(kind: 'incomes' | 'expenses', value: string): string {
  return CATEGORIES[kind].find((option) => option.value === value)?.label ?? value.replace(/_/g, ' ');
}

/** A staff member as `GET /staff` returns one. `last_name` and `designation` are nullable. */
interface StaffOption {
  id: number;
  employee_id: string;
  first_name: string;
  last_name: string | null;
  designation: string | null;
  is_active: boolean;
}

/**
 * One recipient list, read to its end.
 *
 * The first page is fetched here and the rest by `useWholeList`, the timetable screens' reader, so a
 * school with more than a hundred teachers can still name the one it paid. `enabled` is false until
 * a salary is actually being recorded by someone who holds the list's own view key, so no request is
 * spent on a list nobody will see. The list is unfiltered on purpose: a salary can be owed to someone
 * who has since left, and `useWholeList` reads later pages without filters, so a filtered first page
 * would be a different list from the rest of it.
 */
function useRecipientList<T extends { id: number }>(path: string, enabled: boolean): Picker<T> {
  const [first, setFirst] = useState<Picker<T>>({ state: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    (async () => {
      try {
        const page = await api.page<T[]>(path, { query: { limit: OPTION_LIMIT } });
        if (!cancelled) {
          setFirst({ state: 'ready', rows: page.data ?? [], total: page.meta?.total ?? page.data.length });
        }
      } catch {
        /* Which refusal it was does not change the remedy: the name can still be typed. */
        if (!cancelled) setFirst({ state: 'failed' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, enabled]);

  return useWholeList(path, first);
}

/**
 * Joi's refusal of a window whose end is before its start, said as what it means.
 *
 * `orderedWindow()` makes `to` a `date.min` against `from`, and with `wrap.label` off Joi writes
 * `to must be greater than or equal to ref:from` — a reference name, shown to a person. Only that one
 * refusal is rewritten; anything else is passed on as the server wrote it.
 */
function windowRefusal(caught: ApiError): string | null {
  const reversed = caught.details.find((detail) => detail.field === 'to' && detail.type === 'date.min');
  return reversed ? '“To” is before “From”, so the window holds no days. Move one of them.' : null;
}

function LedgerPanel({ kind, onRecorded }: { kind: 'incomes' | 'expenses'; onRecorded: () => void }) {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState('');
  const [recording, setRecording] = useState(false);

  /*
   * 300 ms, as every other search screen does. `useCollection` refetches on every change to the
   * query, so feeding `search` straight in sent one request per keystroke, each a leading-wildcard
   * LIKE across three columns.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      /*
       * Resetting to page one is part of the search, not a separate concern — searching from page
       * three and staying there shows an empty table for a query that has two pages of results.
       */
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  /*
   * Correcting an entry — `PATCH /finance/incomes/:id` and `PATCH /finance/expenses/:id`, neither of
   * which had a caller. A ledger is exactly where a typo has to be fixable: an amount entered wrong
   * feeds every §18 total and every §22 expense report until it is corrected, and there was no way
   * to correct it.
   *
   * §18 gives no delete on either ledger, deliberately — a correction is recorded, a deletion is
   * not — so this dialog is the whole of what can be done to an entry after it is written.
   */
  const [editing, setEditing] = useState<Entry | null>(null);

  const query = useMemo(
    () => ({ page, limit: 20, q: debounced || undefined, category: category || undefined }),
    [page, debounced, category]
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
      {
        key: 'amount',
        header: 'Amount',
        numeric: true,
        /* `whitespace-nowrap` keeps the code on its figure's line; `numeric` supplies `tabular-nums`. */
        cell: (row) => <span className="whitespace-nowrap">{formatAmountWithCode(row.amount, row.currency)}</span>,
      },
      ...(can('finance.manage')
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: Entry) => (
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing(row)}>
                  Edit
                </button>
              ),
            } as Column<Entry>,
          ]
        : []),
    ],
    [isIncome, can]
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
          {/*
            * The placeholder names all three columns the server scans — `finance.service.js` LIKEs
            * `title` (this screen's "Description" column), `subcategory` and `reference`. Naming two
            * made the subcategory matches look like a bug.
            */}
          <SearchField
            id={`${kind}-search`}
            label={`Search ${isIncome ? 'income' : 'expenses'}`}
            placeholder="Description, subcategory or reference…"
            value={search}
            onChange={setSearch}
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
          {debounced || category
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

      <EditDialog
        row={editing}
        title={editing ? `Edit ${editing.title}` : ''}
        description={
          isIncome
            ? 'Correcting an income entry. It feeds the §18 totals and the expense report, so the correction is what those read next.'
            : 'Correcting an expense entry. It feeds the §18 totals and the expense report, so the correction is what those read next.'
        }
        success={isIncome ? 'Income updated' : 'Expense updated'}
        onClose={() => setEditing(null)}
        onSaved={() => {
          reload();
          /* The ledger and the totals are two reads; a corrected amount staled both. */
          onRecorded();
        }}
        /*
         * The two routes written out rather than one interpolated path — the blind spot this file
         * already hit once on the create side, recorded in `RecordEntryDialog`.
         */
        save={(row, body) =>
          isIncome
            ? api.patch(`/finance/incomes/${row.id}`, body)
            : api.patch(`/finance/expenses/${row.id}`, body)
        }
        initial={(row) => ({
          title: row.title,
          amount: String(row.amount),
          category: row.category,
          subcategory: row.subcategory ?? '',
          reference: row.reference ?? '',
          [isIncome ? 'received_from' : 'paid_to']:
            (isIncome ? row.received_from : row.paid_to) ?? '',
          [isIncome ? 'income_date' : 'expense_date']:
            ((isIncome ? row.income_date : row.expense_date) ?? '').slice(0, 10),
        })}
        fields={[
          { name: 'title', label: 'Title', required: true },
          { name: 'amount', label: 'Amount', kind: 'number', step: '0.01', min: 0 },
          {
            name: 'category',
            label: 'Category',
            hint: 'One of the categories §18 fixes for this ledger — the API refuses anything else.',
          },
          { name: 'subcategory', label: 'Subcategory', nullable: true },
          {
            name: isIncome ? 'received_from' : 'paid_to',
            label: isIncome ? 'Received from' : 'Paid to',
            nullable: true,
          },
          {
            name: isIncome ? 'income_date' : 'expense_date',
            label: 'Date',
            kind: 'date',
          },
          { name: 'reference', label: 'Reference', nullable: true },
        ]}
      />

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
 * ## Only the fields the schema requires, plus the ones a salary cannot be recorded without
 *
 * `createIncome` / `createExpense` require `title`, `amount` and the date; everything else is
 * optional. So this asks for those three, plus category, currency and a description.
 * `academic_session_id` and `student_id` are accepted by the endpoint and are deliberately **not**
 * here: they default at the column or the service.
 *
 * ## The currency starts on the school's — the owner's decision D35
 *
 * This dialog used to send no currency, so every entry took the column's `USD` whatever the school
 * had set. D35 makes the school's currency the default: `finance.service.js` now gives an entry sent
 * without one the school's, and the field is shown and starts on it, read from the profile
 * (`school.currency` on `/auth/me`) — which every school role receives, so the seeded Accountant, who
 * cannot read the settings themselves, sees the currency the entry will be in. Only a school that has
 * never saved its settings has none; the field then starts blank, a blank stores `USD`, and the hint
 * says so rather than leaving the currency to be discovered on the ledger.
 *
 * ## A salary names who was paid
 *
 * SRS:951 is "User records Expense entries, including Salaries and Other Expenses", and this dialog
 * offered Salaries while sending nothing that could satisfy the model's `salaryNeedsRecipient`
 * validator — a `salaries` row must name a teacher, a staff member or a `paid_to`. So choosing
 * Salaries was a guaranteed 422, and the dialog described itself as not collecting what the refusal
 * asked for. One of the three was therefore offered as the only way to finish.
 *
 * The recipient controls appear only for Salaries, and are sent only then. `paid_to` is always
 * there, because anyone can type a name. The teacher and staff lists are offered only to a caller
 * holding `teachers.view` / `staff.view` — the seeded Accountant, the actor FR-FIN-001 names first,
 * holds neither, so for them the name is the whole of it. None of the three is marked required,
 * because none of them is: any one satisfies the rule, and the server says so if all are blank.
 *
 * The service reports that refusal against `paid_to` — Sequelize names a model-level validator's
 * error after the validator, and `finance.service.js rethrow()` maps it to the one field a person
 * can type into — so it lands beside the Paid to box. Anything a 422 names that this form has no
 * input for (the `body` of a foreign-key race, `school_id` from `resolveSchool()`) goes to the banner
 * through `splitApiErrors`, rather than being filed under a field nothing draws. Before, every field
 * error was taken as renderable, so such a message was set, drawn nowhere, and suppressed the banner
 * too: a rejected submit that looked like nothing happened.
 *
 * ## The date defaults to today and is not pre-filled by a client clock beyond that
 *
 * A ledger entry is almost always being recorded on the day it happened, and that is the recorder's
 * calendar day. The API stores the `YYYY-MM-DD` it is sent as that day (Known Issues #20), so the
 * default is the viewer's day, as the attendance register's is. This used to be
 * `toISOString().slice(0, 10)` — the UTC day — on the reasoning that it matched what the API stores;
 * it did not, because the API stores whatever day it is given, and the UTC day put an entry recorded
 * at 22:00 in UTC−5 on the next day and one recorded at 01:00 in UTC+5 on the previous one.
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
  const { can, profile } = useAuth();
  /* D35's default, from the profile — see the header. */
  const schoolCurrency = profile?.school?.currency?.trim() || null;

  /* The viewer's today: `income_date` / `expense_date` are calendar days, and the UTC one is not theirs. */
  const today = useMemo(() => localDay(new Date()) ?? '', []);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('');
  const [date, setDate] = useState(today);
  const [entryCategory, setEntryCategory] = useState(isIncome ? 'other_income' : 'other_expenses');
  const [description, setDescription] = useState('');
  /* The salary recipient — see the header. Held for any category, sent only for Salaries. */
  const [paidTo, setPaidTo] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const isSalary = !isIncome && entryCategory === 'salaries';
  /* The keys `GET /teachers` and `GET /staff` are mounted behind; without one, its picker is not offered. */
  const canPickTeacher = can('teachers.view');
  const canPickStaff = can('staff.view');

  const teachers = useRecipientList<TeacherOption>('/teachers', open && isSalary && canPickTeacher);
  const staff = useRecipientList<StaffOption>('/staff', open && isSalary && canPickStaff);

  /* Reopening must not show the last entry's values, or the previous attempt's errors. */
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setAmount('');
    setCurrency('');
    setDate(today);
    setEntryCategory(isIncome ? 'other_income' : 'other_expenses');
    setDescription('');
    setPaidTo('');
    setTeacherId('');
    setStaffId('');
    setBusy(false);
    setFailure(null);
    setFieldErrors({});
  }, [open, today, isIncome]);

  /*
   * D35's default, after the reset above and apart from it: the profile can be re-read while the
   * dialog is open, and folding it into the reset would wipe what had been typed. Only into an empty
   * field.
   */
  useEffect(() => {
    if (!open || !schoolCurrency) return;
    setCurrency((prev) => prev || schoolCurrency);
  }, [open, schoolCurrency]);

  /**
   * The fields this form has an input for, as it stands. The recipient trio only while Salaries is
   * chosen, and each picker only while it is drawn — a message keyed to a control that is not on
   * screen has to reach the banner, not a key nothing renders.
   */
  const rendered = new Set<string>([
    'title',
    'amount',
    'currency',
    isIncome ? 'income_date' : 'expense_date',
    'category',
    'description',
    ...(isSalary ? ['paid_to'] : []),
    ...(isSalary && canPickTeacher && teachers.state !== 'failed' ? ['teacher_id'] : []),
    ...(isSalary && canPickStaff && staff.state !== 'failed' ? ['staff_id'] : []),
  ]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setFieldErrors({});

    try {
      /*
       * The two ledgers are two calls rather than one interpolated path, for the reason the add-ons
       * dialog now records: `verify-frontend.js` looks for the literal **at** the call, so
       * `/finance/${kind}` left both §18 create routes reporting as uncalled while this form was
       * creating rows with them.
       */
      const body: Record<string, unknown> = {
        title: title.trim(),
        amount,
        /* Blank is left off, so the column's default applies — see the header on D35. */
        currency: currency.trim() || undefined,
        [isIncome ? 'income_date' : 'expense_date']: date,
        category: entryCategory,
        description: description.trim() || undefined,
      };
      /*
       * Only for a salary. A recipient left over from before the category was changed would record a
       * teacher against "Other expenses" without anyone having meant it.
       */
      if (isSalary) {
        body.paid_to = paidTo.trim() || undefined;
        body.teacher_id = teacherId ? Number(teacherId) : undefined;
        body.staff_id = staffId ? Number(staffId) : undefined;
      }
      if (isIncome) {
        await api.post('/finance/incomes', body);
      } else {
        await api.post('/finance/expenses', body);
      }
      success(isIncome ? 'Income recorded' : 'Expense recorded');
      onRecorded();
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        /*
         * A failed `fetch` is a TypeError, not an ApiError. This used to rethrow it, which from a
         * submit handler is an unhandled rejection: the button stopped spinning and nothing said
         * whether the entry had been recorded.
         */
        setFailure('Could not reach the server. Check your connection and try again.');
        return;
      }
      /*
       * Field errors go to the fields this form draws, and everything else to the banner — see the
       * header on what used to happen to a message naming a field with no input.
       */
      const { perField, banner } = splitApiErrors(caught, rendered);
      setFieldErrors(perField);
      setFailure(banner);
      if (Object.keys(perField).length > 0) focusFirstInvalidField();
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
          : 'Money paid out. A salary names who was paid — a teacher, a staff member, or a name.'
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

        <div className="grid gap-4 sm:grid-cols-2">
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
          <Field
            id="currency"
            label="Currency"
            maxLength={10}
            autoComplete="off"
            value={currency}
            error={fieldErrors.currency}
            onChange={(event) => setCurrency(event.target.value)}
            hint={
              schoolCurrency
                ? `Starts on ${schoolCurrency}, this school’s currency, which a blank also takes.`
                : 'A code such as USD, stored in upper case. Blank takes the school’s currency, or USD while the school has not saved one in its settings.'
            }
          />
        </div>

        {isSalary ? (
          /*
           * A group, because the three answer one question together — "who was paid" — and any one
           * of them answers it. `<fieldset>` and `<legend>` say that to a screen reader; the sentence
           * under the legend says it to everyone else, since no single box here is required.
           */
          <fieldset className="space-y-4 rounded-md border border-border p-4">
            <legend className="field-label px-1">Who was paid</legend>
            <p className="-mt-2 text-sm leading-relaxed text-muted">
              A salary must name its recipient. Any one of these is enough.
            </p>

            {canPickTeacher ? (
              teachers.state === 'failed' ? (
                <p className="field-hint">
                  The teacher list could not be loaded, so a teacher cannot be chosen here. Type the
                  name under Paid to instead.
                </p>
              ) : (
                <SelectField
                  id="teacher_id"
                  label="Teacher"
                  value={teacherId}
                  error={fieldErrors.teacher_id}
                  disabled={teachers.state === 'loading'}
                  onChange={(event) => setTeacherId(event.target.value)}
                  hint={
                    teachers.state === 'ready' && teachers.total > teachers.rows.length
                      ? `Showing ${teachers.rows.length} of ${teachers.total} teachers.`
                      : undefined
                  }
                >
                  <option value="">{teachers.state === 'loading' ? 'Loading…' : 'Not a teacher'}</option>
                  {teachers.state === 'ready'
                    ? teachers.rows.map((row) => (
                        <option key={row.id} value={row.id}>
                          {teacherName(row)} ({row.employee_id})
                          {row.is_active ? '' : ' — inactive'}
                        </option>
                      ))
                    : null}
                </SelectField>
              )
            ) : null}

            {canPickStaff ? (
              staff.state === 'failed' ? (
                <p className="field-hint">
                  The staff list could not be loaded, so a staff member cannot be chosen here. Type the
                  name under Paid to instead.
                </p>
              ) : (
                <SelectField
                  id="staff_id"
                  label="Staff member"
                  value={staffId}
                  error={fieldErrors.staff_id}
                  disabled={staff.state === 'loading'}
                  onChange={(event) => setStaffId(event.target.value)}
                  hint={
                    staff.state === 'ready' && staff.total > staff.rows.length
                      ? `Showing ${staff.rows.length} of ${staff.total} staff members.`
                      : undefined
                  }
                >
                  <option value="">{staff.state === 'loading' ? 'Loading…' : 'Not a staff member'}</option>
                  {staff.state === 'ready'
                    ? staff.rows.map((row) => (
                        <option key={row.id} value={row.id}>
                          {[row.first_name, row.last_name].filter(Boolean).join(' ')} ({row.employee_id})
                          {row.designation ? ` — ${row.designation}` : ''}
                          {row.is_active ? '' : ' — inactive'}
                        </option>
                      ))
                    : null}
                </SelectField>
              )
            ) : null}

            <Field
              id="paid_to"
              label="Paid to"
              maxLength={180}
              value={paidTo}
              error={fieldErrors.paid_to}
              onChange={(event) => setPaidTo(event.target.value)}
              hint={
                canPickTeacher || canPickStaff
                  ? 'The name, for someone not in the lists above. It is also what the ledger’s Paid to column shows.'
                  : 'The name of the person paid. It is what the ledger’s Paid to column shows.'
              }
            />
          </fieldset>
        ) : null}

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

/** One ledger's half of the report: its total, and that total split by §18's categories. */
interface LedgerTotals {
  total: number;
  /*
   * Zero-filled from the category list by `foldBuckets()`, so a category with no rows still reads
   * `0` rather than vanishing, and the buckets sum to `total` by construction.
   */
  by_category: Record<string, number>;
}

interface FinanceReport {
  /* The window the server applied, echoed as `YYYY-MM-DD`, or null for an open end. */
  from: string | null;
  to: string | null;
  currency: string | null;
  income: LedgerTotals;
  expense: LedgerTotals;
  net_balance: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A `YYYY-MM-DD` as `5 Sep 2026`, by slicing rather than through `Date`, which reads a bare date as
 * UTC midnight and moves it a day west of Greenwich — the reason the attendance screen gives.
 */
function formatDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${Number(match[3])} ${month} ${match[1]}` : value;
}

/** One ledger's categories and their amounts, beneath that ledger's total. */
function CategorySplit({
  kind,
  totals,
  currency,
}: {
  kind: 'incomes' | 'expenses';
  totals: LedgerTotals;
  currency: string | null;
}) {
  return (
    <dl className="space-y-1 text-sm">
      {Object.entries(totals.by_category ?? {}).map(([category, amount]) => (
        <div key={category} className="flex items-baseline justify-between gap-3">
          <dt className="text-muted">{categoryLabel(kind, category)}</dt>
          <dd className="whitespace-nowrap tabular-nums">{formatAmountWithCode(amount, currency)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * FR-FIN-002's Expected Outcome and FR-FIN-003's report, rendered.
 *
 * The three figures come from `/finance/report`, which sums across the whole ledger rather than the
 * page in view — the distinction the ledger tabs deliberately refuse to blur by totalling a page.
 *
 * A deficit is shown as a negative and is never clamped, because `finance.service.js:502` does not
 * clamp it either: *"a deficit is real"*. Colouring it is the whole point of showing it.
 *
 * ## The window and the categories, which the report always had
 *
 * FR-FIN-003 is "System generates Financial Reports based on recorded Income and Expenses"
 * (SRS:965-966), and `/finance/report` has accepted an ordered `from`/`to` and answered a
 * `by_category` split of both ledgers since it was built. This panel read only the three totals and
 * sent only `currency`, so the report existed and could not be asked for a quarter, nor show where a
 * total came from. The two dates are the window the service takes — §18 names no period taxonomy, so
 * none is invented here — and blank is every entry ever recorded, which is FR-FIN-002's dashboard
 * figure exactly as it was. The categories are listed under the total they sum to.
 */
function FinancialReport({ version }: { version: number }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [report, setReport] = useState<FinanceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /* A 422 about the window itself, said beside the dates rather than behind a retry button. */
  const [invalid, setInvalid] = useState<string | null>(null);
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
    setLoading(true);
    setError(null);
    setInvalid(null);
    setRefusal(null);
    (async () => {
      try {
        /*
         * `{ report }`, not the report: `finance.controller.js:83` answers
         * `ApiResponse.ok(res, { report: data })`. Reading `result` directly threw a TypeError on
         * `report.income.total` below — and before it threw, `Number(report.net_balance) < 0` was
         * `NaN < 0`, i.e. false, so a school in deficit would have been painted in the success
         * colour. Same envelope mistake as the Super Admin dashboard's thirteen NaN cards.
         *
         * `from` and `to` are sent as the date boxes hold them, `YYYY-MM-DD` — a calendar day, which
         * is what `expense_date` / `income_date` store — and left off when blank, so an open end is
         * really open rather than bounded at some default.
         */
        const result = await api.get<{ report: FinanceReport }>('/finance/report', {
          signal: controller.signal,
          query: {
            currency: chosenCurrency || undefined,
            from: from || undefined,
            to: to || undefined,
          },
        });
        if (controller.signal.aborted) return;
        setReport(result.report ?? null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          const named = caught.fieldErrors().currency;
          const reversed = windowRefusal(caught);
          if (reversed) {
            /* The window, not the ledger, is what is wrong — so the figures step aside for the sentence. */
            setInvalid(reversed);
            setReport(null);
          } else if (named) {
            /*
             * Tolerant on purpose: the codes are read out of the server's own sentence, and if that
             * sentence ever changes shape the list comes back empty and the message is shown as
             * received — which is the old behaviour, not a worse one.
             */
            const offered = [...new Set(named.match(/\b[A-Z]{3}\b/g) ?? [])];
            setChoices(offered);
            setError(offered.length > 0 ? null : caught.message);
            setReport(null);
          } else if (caught.status === 422) {
            const [first] = [...caught.formErrors(), ...Object.values(caught.fieldErrors())];
            setInvalid(first ?? caught.message);
            setReport(null);
          } else {
            setError(caught.message);
          }
        } else if ((caught as Error)?.name !== 'AbortError') {
          setError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    /*
     * `version` is bumped when an entry is recorded on either ledger. Without it these three figures
     * stayed at the values they were fetched with: recording 1,250.75 of income left the card reading
     * 0.00 beside a ledger row showing the entry, which reads as the total being wrong rather than
     * stale. The report sums the whole ledger, so it has to be re-asked, not adjusted locally.
     */
  }, [attempt, version, chosenCurrency, from, to]);

  if (refusal) return <RefusalNotice refusal={refusal} />;

  /*
   * What the figures cover, read from the window the server echoed rather than from the boxes — while
   * a new window is loading, the figures on screen are still the old one's, and so is this sentence.
   */
  const shownFrom = report?.from ?? null;
  const shownTo = report?.to ?? null;
  const coverage =
    shownFrom && shownTo
      ? `Entries dated ${formatDay(shownFrom)} to ${formatDay(shownTo)}.`
      : shownFrom
        ? `Entries dated ${formatDay(shownFrom)} onwards.`
        : shownTo
          ? `Entries dated up to ${formatDay(shownTo)}.`
          : 'Every entry recorded — the net balance of the whole ledger.';

  /*
   * `report.currency` is null only when both ledgers are empty — `report()` answers
   * `currency || currencies[0] || null` — and `formatAmountWithCode` then prints the bare `0.00`
   * rather than the figure, a space and an empty label.
   */
  const deficit = report ? Number(report.net_balance) < 0 : false;

  return (
    <section aria-labelledby="finance-report-heading" className="mb-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="finance-report-heading" className="text-base font-semibold tracking-tight text-ink">
          Financial report
        </h2>
        {report ? <p className="text-sm text-muted">{coverage}</p> : null}
      </div>

      <FilterBar
        activeCount={[from, to].filter(Boolean).length}
        onClear={() => {
          setFrom('');
          setTo('');
        }}
      >
        <FilterDate id="finance-report-from" label="From" value={from} onChange={setFrom} />
        <FilterDate id="finance-report-to" label="To" value={to} onChange={setTo} />
        {/*
          * Once a currency has been chosen, it stays changeable. The choice used to be a one-way
          * door: the buttons below vanished with the refusal, so a school that picked USD could not
          * get back to EUR short of reloading — and with a window to move, the two are read side by
          * side more often than once.
          */}
        {choices.length > 1 && chosenCurrency ? (
          <FilterSelect
            id="finance-report-currency"
            label="Currency"
            labelVisible
            value={chosenCurrency}
            onChange={setChosenCurrency}
          >
            {choices.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </FilterSelect>
        ) : null}
      </FilterBar>

      {error ? (
        <ErrorNotice message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : invalid ? (
        <Notice tone="error">{invalid}</Notice>
      ) : choices.length > 0 && !report ? (
        /* Two currencies in the window: pick one, because a single net balance across both is undefined. */
        <div className="surface p-5">
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
      ) : !report ? null : (
        <dl
          aria-busy={loading || undefined}
          className={`grid grid-cols-1 gap-3 transition-opacity duration-200 sm:grid-cols-3 ${
            loading ? 'opacity-60' : ''
          }`}
        >
          <div className="rounded-md border border-border px-4 py-3">
            <dt className="text-xs uppercase tracking-wide text-muted-soft">Income</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">
              {formatAmountWithCode(report.income.total, report.currency)}
            </dd>
            <dd className="mt-2 border-t border-border-soft pt-2">
              <CategorySplit kind="incomes" totals={report.income} currency={report.currency} />
            </dd>
          </div>
          <div className="rounded-md border border-border px-4 py-3">
            <dt className="text-xs uppercase tracking-wide text-muted-soft">Expense</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">
              {formatAmountWithCode(report.expense.total, report.currency)}
            </dd>
            <dd className="mt-2 border-t border-border-soft pt-2">
              <CategorySplit kind="expenses" totals={report.expense} currency={report.currency} />
            </dd>
          </div>
          <div className="rounded-md border border-border px-4 py-3">
            <dt className="text-xs uppercase tracking-wide text-muted-soft">Net balance</dt>
            <dd
              className={`mt-1 text-lg font-semibold tabular-nums ${
                deficit ? 'text-danger' : 'text-success'
              }`}
            >
              {formatAmountWithCode(report.net_balance, report.currency)}
            </dd>
            <dd className="mt-2 border-t border-border-soft pt-2 text-sm text-muted">
              Income minus expense, over the same entries.
            </dd>
          </div>
        </dl>
      )}
    </section>
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
      <FinancialReport version={ledgerVersion} />
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
