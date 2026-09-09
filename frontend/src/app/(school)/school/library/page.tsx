'use client';

/**
 * Library — SRS §20.4, §33's "Library", checklist row 4.4.
 *
 * **The exemplar for the multi-endpoint screens.** §33 names one screen; the API has two collections
 * — `/library/books` (the catalogue) and `/library/transactions` (who has what, and what they owe).
 * Fees and Finance have the same shape and follow this file.
 *
 * The two are one screen rather than two nav entries because §33's list is the requirement, and
 * splitting one of its screens would be rewriting it. The tab lives in the URL so a reload keeps it
 * and a link can point at one — see `components/tabs.tsx`.
 *
 * ## One `useCollection` per tab, and only the active one fetches
 *
 * Both hooks are declared unconditionally, because hooks must be — but the inactive one is passed a
 * path of `null`... which `useCollection` does not accept. So instead the inactive tab is simply not
 * rendered, and its hook is never mounted: each panel is a component of its own. That keeps the rule
 * simple and means switching tabs does not leave a stale request in flight for the tab nobody is
 * looking at.
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EditDialog } from '@/components/editDialog';
import { useCollection } from '@/lib/useCollection';
import { splitApiErrors } from '@/lib/formErrors';
import {
  Field,
  Notice,
  SearchField,
  SelectField,
  SubmitButton,
  TextAreaField,
  CheckboxField,
  FilterBar,
  FilterSelect,
  focusFirstInvalidField,
} from '@/components/form';
import { Icon } from '@/components/icon';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';
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
import { Tabs, TabPanel, useActiveTab } from '@/components/tabs';
import type { TabDef } from '@/components/tabs';

/** A catalogue row, as the `books` table defines it. */
interface Book {
  id: number;
  title: string;
  author: string | null;
  category: string | null;
  isbn: string | null;
  quantity: number;
  available_quantity: number;
  rack_number: string | null;
  is_active: boolean;
}

/** A loan, as `library_transactions` defines it. */
interface LoanRow {
  id: number;
  book_id: number;
  borrower_type: string;
  issue_date: string;
  due_date: string;
  return_date: string | null;
  status: string;
  /*
   * Derived per request by `presentTransaction()`, never stored. `is_overdue` is
   * `status === issued && daysOverdue(due_date) > 0`, which is the same condition the list endpoint
   * uses to answer a `status=overdue` filter — so the column and the filter cannot disagree.
   */
  is_overdue?: boolean;
  days_overdue?: number;
  /* Whichever one the borrower type points at; the other two are absent, not null. */
  student?: { first_name: string; last_name: string | null } | null;
  teacher?: { first_name: string; last_name: string | null } | null;
  staff?: { first_name: string; last_name: string | null } | null;
  /*
   * All three money fields are `DECIMAL(14,2)` (`models/other.js` uses the shared `money()` column),
   * and `config/database.js` sets `decimalNumbers: true`, so they arrive as JS **numbers**.
   *
   * `fine_paid` was typed `boolean` and read as one. It is an **amount paid so far**, not a flag: a
   * 10.00 fine with 4.00 paid arrives as the number `4`, which is truthy, so the cell said "paid"
   * and the 6.00 still owed was invisible — worst in the "Only unpaid fines" view, whose server
   * filter is `fine_amount > fine_paid`, i.e. exactly the rows where some balance remains.
   *
   * `fine_outstanding` is what to render: `presentTransaction()` computes it as
   * `clampNonNegative(fine_amount − fine_paid)`, or 0 when waived, in the money util's own minor
   * units. Recomputing it here would be a second opinion on a subtraction the server has already
   * done in the one place that does money arithmetic.
   */
  fine_amount: number | null;
  fine_paid: number | null;
  fine_outstanding: number | null;
  fine_waived: boolean;
  currency: string | null;
  book?: { id: number; title: string; author: string | null };
}

const TABS: TabDef[] = [
  { key: 'books', label: 'Catalogue' },
  { key: 'transactions', label: 'Loans' },
];

/* ─────────────────────────────── the catalogue ─────────────────────────────── */

function BooksPanel() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [available, setAvailable] = useState('');

  const query = useMemo(
    () => ({ page, limit: 20, q: search || undefined, available: available || undefined }),
    [page, search, available]
  );
  const { rows, meta, loading, error, refusal, reload } = useCollection<Book>('/library/books', query);

  /*
   * Correcting a book — `PATCH /library/books/:id`, which had no caller. A catalogue entry could be
   * added and never fixed: a mistyped ISBN, a book moved to another rack, a copy lost and the count
   * left too high.
   *
   * `quantity` is the one that needs care and is offered anyway: `available_quantity` is derived
   * from it minus what is on loan, so lowering it below the number currently issued is refused by
   * the API. The hint says so rather than leaving the refusal to explain itself.
   */
  const [editing, setEditing] = useState<Book | null>(null);

  const columns = useMemo<Column<Book>[]>(
    () => [
      { key: 'title', header: 'Title', cell: (row) => <span className="font-medium">{row.title}</span> },
      { key: 'author', header: 'Author', cell: (row) => row.author ?? <span className="text-muted-soft">—</span> },
      { key: 'category', header: 'Category', cell: (row) => row.category ?? <span className="text-muted-soft">—</span> },
      { key: 'isbn', header: 'ISBN', cell: (row) => <code className="text-xs text-muted">{row.isbn ?? '—'}</code> },
      /*
       * Availability is the one number a librarian is looking for, and it is two columns' worth of
       * information in one: how many exist, and how many are on the shelf right now. `available` is
       * `quantity` minus the open loans, maintained by the module rather than computed here.
       */
      {
        key: 'available',
        header: 'Available',
        numeric: true,
        cell: (row) => (
          <span className={row.available_quantity === 0 ? 'text-muted-soft' : undefined}>
            {row.available_quantity} / {row.quantity}
          </span>
        ),
      },
      { key: 'rack', header: 'Rack', cell: (row) => row.rack_number ?? <span className="text-muted-soft">—</span> },
      { key: 'active', header: 'Status', cell: (row) => <StatusBadge status={row.is_active ? 'active' : 'inactive'} /> },
      ...(can('library.manage')
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: Book) => (
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => setEditing(row)}>
                  Edit
                </button>
              ),
            } as Column<Book>,
          ]
        : []),
    ],
    [can]
  );

  return (
    <>
      <FilterBar
        activeCount={[available, search].filter(Boolean).length}
        onClear={() => {
          setAvailable('');
          setSearch('');
          setPage(1);
        }}
      >
        <div>
          <SearchField
            id="book-search"
            label="Search the catalogue"
            placeholder="Title, author or ISBN…"
            value={search}
            onChange={(value) => { setSearch(value); setPage(1); }}
          />
        </div>
        <div>
          <FilterSelect
            id="book-available"
            label="Availability"
            value={available}
            onChange={(value) => { setAvailable(value); setPage(1); }}
          >
            <option value="">All books</option>
            <option value="true">On the shelf</option>
            <option value="false">All copies out</option>
          </FilterSelect>
        </div>
        {can('library.manage') ? (
          <a
            href="/school/library/books/new"
            className="ml-auto self-start btn btn-primary"
          >
            Add book
          </a>
        ) : null}
      </FilterBar>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>{search ? `No book matches “${search}”.` : 'The catalogue is empty.'}</EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Library catalogue"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <EditDialog
        row={editing}
        title={editing ? `Edit ${editing.title}` : ''}
        description="The catalogue entry. Loans already out are untouched by anything changed here."
        success="Book updated"
        onClose={() => setEditing(null)}
        onSaved={reload}
        save={(row, body) => api.patch(`/library/books/${row.id}`, body)}
        initial={(row) => ({
          title: row.title,
          author: row.author ?? '',
          category: row.category ?? '',
          isbn: row.isbn ?? '',
          rack_number: row.rack_number ?? '',
          quantity: String(row.quantity),
          is_active: row.is_active,
        })}
        fields={[
          { name: 'title', label: 'Title', required: true },
          { name: 'author', label: 'Author', nullable: true },
          { name: 'category', label: 'Category', nullable: true },
          { name: 'isbn', label: 'ISBN', nullable: true },
          { name: 'rack_number', label: 'Rack', nullable: true },
          {
            name: 'quantity',
            label: 'Copies held',
            kind: 'number',
            min: 0,
            hint: 'Available copies are this minus what is on loan, so it cannot be lowered below the number currently issued — the API refuses that with the figure.',
          },
          {
            name: 'is_active',
            kind: 'checkbox',
            label: 'In the catalogue',
            hint: 'A withdrawn book cannot be issued. Loans already out are unaffected and can still be returned.',
          },
        ]}
      />
    </>
  );
}

/* ─────────────────────────────── the loans ─────────────────────────────── */

function LoansPanel() {
  const { can } = useAuth();
  const { success } = useToast();

  /*
   * `library.issue` guards all three routes — `POST /transactions`,
   * `PATCH /transactions/:id/return` and `PATCH /transactions/:id/fine` — so one key decides
   * whether any of these controls exists.
   */
  const canIssue = can('library.issue');

  const [issuing, setIssuing] = useState(false);
  const [returning, setReturning] = useState<LoanRow | null>(null);
  const [settling, setSettling] = useState<LoanRow | null>(null);

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [outstanding, setOutstanding] = useState(false);

  const query = useMemo(
    () => ({
      page,
      limit: 20,
      status: status || undefined,
      fine_outstanding: outstanding ? 'true' : undefined,
    }),
    [page, status, outstanding]
  );
  const { rows, meta, loading, error, refusal, reload } = useCollection<LoanRow>('/library/transactions', query);

  const columns = useMemo<Column<LoanRow>[]>(() => {
    const base: Column<LoanRow>[] = [
      {
        key: 'book',
        header: 'Book',
        /*
         * The service includes the book, so the title is available. A bare `book_id` would be the
         * one column nobody can act on — a librarian does not know book 412 by its number.
         */
        cell: (row) => row.book?.title ?? <span className="text-muted-soft">book #{row.book_id}</span>,
      },
      {
        key: 'borrower',
        header: 'Borrower',
        /*
         * Who, then what kind — this showed only the kind. `presentTransaction()` spreads the whole
         * row, so whichever of `student`/`teacher`/`staff` the include populated is on the wire; the
         * type alone answers a question nobody asks of a loans register.
         */
        cell: (row) => {
          const person = row.student ?? row.teacher ?? row.staff ?? null;
          const named = person
            ? [person.first_name, person.last_name].filter(Boolean).join(' ')
            : null;
          return (
            <span className="min-w-0">
              <span className="block truncate">
                {named ?? <span className="text-muted-soft">not named</span>}
              </span>
              <span className="block text-xs text-muted-soft">
                {row.borrower_type.replace(/_/g, ' ')}
              </span>
            </span>
          );
        },
      },
      { key: 'issued', header: 'Issued', cell: (row) => row.issue_date?.slice(0, 10) ?? '—' },
      { key: 'due', header: 'Due', cell: (row) => row.due_date?.slice(0, 10) ?? '—' },
      {
        key: 'returned',
        header: 'Returned',
        cell: (row) => row.return_date?.slice(0, 10) ?? <span className="text-muted-soft">—</span>,
      },
      {
        key: 'status',
        header: 'Status',
        /*
         * `is_overdue`, not the stored `status`.
         *
         * Nothing ever writes `status = 'overdue'` — `OVERDUE` appears exactly once in the whole
         * library module, and it is in the *filter*, which derives it as
         * `status = issued AND due_date < today`. The service's own comment says so: "Derived, because
         * nothing writes the stored value". So the backend filter is right and this column was not:
         * choosing **Overdue** returned the correct rows and every one of them displayed **issued**,
         * which reads as the filter being broken.
         *
         * `presentTransaction()` already sends `is_overdue` and `days_overdue` for exactly this.
         */
        cell: (row) =>
          row.is_overdue ? (
            <span className="inline-flex items-center gap-1.5">
              <StatusBadge status="overdue" />
              {row.days_overdue ? (
                <span className="text-xs text-muted-soft">
                  {row.days_overdue} {row.days_overdue === 1 ? 'day' : 'days'}
                </span>
              ) : null}
            </span>
          ) : (
            <StatusBadge status={row.status} />
          ),
      },
      {
        key: 'fine',
        header: 'Fine',
        numeric: true,
        /*
         * A fine is only interesting while it is owed. Paid and waived are both settled outcomes and
         * are shown as such rather than as a figure that reads like a debt.
         */
        cell: (row) => {
          const amount = Number(row.fine_amount ?? 0);
          if (!amount) return <span className="text-muted-soft">—</span>;
          if (row.fine_waived) return <span className="text-muted-soft">waived</span>;

          const outstanding = Number(row.fine_outstanding ?? 0);
          /* Settled, and only when nothing is left — a part-payment is still a debt. */
          if (outstanding <= 0) return <span className="text-muted-soft">paid</span>;

          const paid = Number(row.fine_paid ?? 0);
          return (
            <span className="font-medium">
              {outstanding.toFixed(2)} {row.currency ?? ''}
              {/* Part-paid rows say so, because "6.00 owed" and "6.00 fine" are different facts. */}
              {paid > 0 ? (
                <span className="block text-xs font-normal text-muted-soft">
                  {paid.toFixed(2)} of {amount.toFixed(2)} paid
                </span>
              ) : null}
            </span>
          );
        },
      },
    ];

    /*
     * §20.4's three verbs, none of which was reachable.
     *
     * The panel was a read-only queue and "Only unpaid fines" was a worklist with no way to work it:
     * a librarian holding `library.issue` could not issue a book, record a return, or mark a fine
     * paid or waived anywhere in the product.
     *
     * Which controls a row gets depends on where the loan is, because offering all three on every
     * row would mean offering two that are guaranteed to be refused:
     *
     *   - **Return** only while the loan is open. `returned` and `lost` are terminal
     *     (`library.service.js` refuses a second return), so a settled row gets no button.
     *   - **Fine** only while something is owed. `fine_outstanding` is computed by the server as
     *     `clampNonNegative(fine_amount − fine_paid)`, or 0 when waived, so this reads the server's
     *     own answer rather than recomputing a subtraction.
     */
    if (!canIssue) return base;

    const OPEN = ['issued', 'overdue'];

    return [
      ...base,
      {
        key: 'actions',
        header: 'Actions',
        cell: (row) => {
          const open = OPEN.includes(row.status);
          const owed = Number(row.fine_outstanding ?? 0) > 0 && !row.fine_waived;

          if (!open && !owed) return <span className="text-muted-soft">—</span>;

          return (
            <span className="flex flex-wrap gap-1">
              {open ? (
                <button
                  type="button"
                  onClick={() => setReturning(row)}
                  className="btn btn-ghost btn-sm"
                >
                  Return
                </button>
              ) : null}
              {owed ? (
                <button
                  type="button"
                  onClick={() => setSettling(row)}
                  className="btn btn-ghost btn-sm"
                >
                  Fine
                </button>
              ) : null}
            </span>
          );
        },
      },
    ];
  }, [canIssue]);

  return (
    <>
      <FilterBar
        activeCount={[status, outstanding].filter(Boolean).length}
        onClear={() => {
          setStatus('');
          setOutstanding(false);
          setPage(1);
        }}
      >
        <FilterSelect
          id="loan-status"
          label="Loan status"
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        >
          <option value="">Any status</option>
          <option value="issued">Issued</option>
          <option value="returned">Returned</option>
          <option value="overdue">Overdue</option>
          <option value="lost">Lost</option>
        </FilterSelect>
        {/* The one filter checkbox in the app; `field-check` is what every other checkbox uses. */}
        <label
          htmlFor="loan-outstanding"
          className="flex h-10 cursor-pointer items-center gap-2 text-sm text-ink"
        >
          <input
            id="loan-outstanding"
            type="checkbox"
            className="field-check"
            checked={outstanding}
            onChange={(event) => {
              setOutstanding(event.target.checked);
              setPage(1);
            }}
          />
          Only unpaid fines
        </label>
        {canIssue ? (
          <button
            type="button"
            onClick={() => setIssuing(true)}
            className="btn btn-primary ml-auto self-start"
          >
            <Icon name="plus" size={15} />
            Issue a book
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
        <EmptyNotice>No loans match these filters.</EmptyNotice>
      ) : (
        <>
          <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Library loans"
            busy={loading}
          />
          {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
        </>
      )}

      <IssueDialog
        open={issuing}
        onClose={() => setIssuing(false)}
        onDone={() => {
          setIssuing(false);
          success('Book issued');
          reload();
        }}
      />

      <ReturnDialog
        loan={returning}
        onClose={() => setReturning(null)}
        onDone={(outcome) => {
          setReturning(null);
          success(outcome === 'lost' ? 'Copy recorded as lost' : 'Return recorded');
          reload();
        }}
      />

      <FineDialog
        loan={settling}
        onClose={() => setSettling(null)}
        onDone={(waived) => {
          setSettling(null);
          success(waived ? 'Fine waived' : 'Fine payment recorded');
          reload();
        }}
      />
    </>
  );
}

/* ─────────────────────────────── the screen ─────────────────────────────── */

function LibraryScreen() {
  const [active, setActive] = useActiveTab(TABS);

  return (
    <div>
      <PageHeader
        title="Library"
        description="The catalogue, and who currently holds what."
      />
      <Tabs tabs={TABS} active={active} onChange={setActive} label="Library sections" />
      <TabPanel tabKey={active}>{active === 'books' ? <BooksPanel /> : <LoansPanel />}</TabPanel>
    </div>
  );
}

export default function LibraryPage() {
  /* `useActiveTab` reads the query string, which cannot run during prerender. */
  return (
    <Suspense fallback={<LoadingBlock />}>
      <LibraryScreen />
    </Suspense>
  );
}


/* ─────────────────────────────── FR-LIB-002, step one: issue ─────────────────────────────── */

/** The three borrower kinds `LIBRARY_BORROWER_TYPES` fixes. */
const BORROWERS = [
  { value: 'student', label: 'A student', field: 'student_id', path: '/students' },
  { value: 'teacher', label: 'A teacher', field: 'teacher_id', path: '/teachers' },
  { value: 'staff', label: 'A member of staff', field: 'staff_id', path: '/staff' },
] as const;

const ISSUE_FIELDS = new Set([
  'book_id',
  'borrower_type',
  'student_id',
  'teacher_id',
  'staff_id',
  'issue_date',
  'due_date',
  'remarks',
]);

interface BorrowerOption {
  id: number;
  first_name: string;
  last_name: string | null;
  /** Students carry `student_id`; teachers and staff carry `employee_id`. */
  student_id?: string;
  employee_id?: string;
}

interface AvailableBook {
  id: number;
  title: string;
  author: string | null;
  available_quantity: number;
}

/**
 * `POST /library/transactions`.
 *
 * ## The exclusivity is the whole shape of this form
 *
 * `borrower_type` decides which of `student_id` / `teacher_id` / `staff_id` is **required**, and the
 * other two are `Joi.forbidden()` with their own messages — *"belongs to a student loan;
 * borrower_type says otherwise"*. The schema enforces what the model's `borrowerMatchesType`
 * validator does not, so sending two ids is a 422 rather than a silently wrong loan.
 *
 * That is why one picker swaps rather than three sitting side by side: three would invite exactly
 * the mistake the schema refuses, and only one of them can ever be right.
 *
 * ## Books with no copies on the shelf are still offered
 *
 * `available_quantity` is shown and not filtered on. The service takes a locking read and refuses an
 * issue with nothing available, and hiding those rows would leave a librarian looking for a book
 * that is in the catalogue with no way to see why it is missing. The count says why.
 */
function IssueDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [bookId, setBookId] = useState('');
  const [borrowerType, setBorrowerType] = useState('');
  const [borrowerId, setBorrowerId] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [books, setBooks] = useState<AvailableBook[]>([]);
  const [borrowers, setBorrowers] = useState<BorrowerOption[]>([]);
  const [borrowersFailed, setBorrowersFailed] = useState(false);

  const borrower = BORROWERS.find((row) => row.value === borrowerType) ?? null;

  useEffect(() => {
    if (!open) return;
    setBookId('');
    setBorrowerType('');
    setBorrowerId('');
    setIssueDate('');
    setDueDate('');
    setRemarks('');
    setBusy(false);
    setFailure(null);
    setFieldErrors({});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    (async () => {
      try {
        const page = await api.page<AvailableBook[]>('/library/books', {
          query: { limit: 100 },
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setBooks(page.data);
      } catch {
        /* The select stays empty and the server refuses; the catalogue tab already reports its own. */
      }
    })();
    return () => controller.abort();
  }, [open]);

  /* The borrower list follows the kind, because only one of the three can ever be the right list. */
  useEffect(() => {
    if (!open || !borrower) return;
    const controller = new AbortController();
    setBorrowersFailed(false);

    (async () => {
      try {
        const page = await api.page<BorrowerOption[]>(borrower.path, {
          query: { limit: 100 },
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setBorrowers(page.data);
      } catch {
        if (!controller.signal.aborted) setBorrowersFailed(true);
      }
    })();

    return () => controller.abort();
  }, [open, borrower]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setFieldErrors({});

    try {
      /*
       * Exactly one borrower id on the body. Carrying a second — from a kind the user changed away
       * from — is a 422 naming a field that is no longer on screen.
       */
      const body: Record<string, unknown> = {
        book_id: Number(bookId),
        borrower_type: borrowerType,
        issue_date: issueDate || undefined,
        due_date: dueDate || undefined,
        remarks: remarks.trim() || undefined,
      };
      if (borrower) body[borrower.field] = Number(borrowerId);

      await api.post('/library/transactions', body);
      onDone();
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      const { perField, banner } = splitApiErrors(caught, ISSUE_FIELDS);
      setFieldErrors(perField);
      setFailure(banner);
      if (Object.keys(perField).length) focusFirstInvalidField();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Issue a book"
      description="Leave the dates blank and the loan starts today and runs for the book’s own loan period."
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary">
            Cancel
          </button>
          <SubmitButton form="issue-book" busy={busy} busyLabel="Issuing…">
            Issue
          </SubmitButton>
        </>
      }
    >
      <form id="issue-book" onSubmit={submit} className="space-y-4" noValidate>
        {failure ? <Notice tone="error">{failure}</Notice> : null}

        <SelectField
          id="book_id"
          label="Book"
          required
          value={bookId}
          onChange={(event) => setBookId(event.target.value)}
          error={fieldErrors.book_id}
          hint="The count is what is on the shelf now. Issuing the last copy is allowed; issuing from none is refused."
        >
          <option value="">Choose a book</option>
          {books.map((row) => (
            <option key={row.id} value={row.id}>
              {row.title}
              {row.author ? ` — ${row.author}` : ''} ({row.available_quantity} available)
            </option>
          ))}
        </SelectField>

        <SelectField
          id="borrower_type"
          label="Borrower"
          required
          value={borrowerType}
          onChange={(event) => {
            setBorrowerType(event.target.value);
            /* The list changes with the kind, so a carried-over id would name the wrong person. */
            setBorrowerId('');
          }}
          error={fieldErrors.borrower_type}
        >
          <option value="">Who is borrowing it</option>
          {BORROWERS.map((row) => (
            <option key={row.value} value={row.value}>
              {row.label}
            </option>
          ))}
        </SelectField>

        {borrower ? (
          <>
            {borrowersFailed ? (
              <Notice tone="warn">
                That list could not be loaded, so there is nobody to choose from. It needs its own
                view permission, separate from issuing books.
              </Notice>
            ) : null}
            <SelectField
              id={borrower.field}
              label={borrower.label.replace(/^A member of |^A /, '').replace(/^./, (c) => c.toUpperCase())}
              required
              value={borrowerId}
              onChange={(event) => setBorrowerId(event.target.value)}
              error={fieldErrors[borrower.field]}
            >
              <option value="">Choose somebody</option>
              {borrowers.map((row) => (
                <option key={row.id} value={row.id}>
                  {[row.first_name, row.last_name].filter(Boolean).join(' ')}
                  {row.student_id ? ` (${row.student_id})` : ''}
                  {row.employee_id ? ` (${row.employee_id})` : ''}
                </option>
              ))}
            </SelectField>
          </>
        ) : null}

        <Field
          id="issue_date"
          label="Issued on"
          type="date"
          value={issueDate}
          onChange={(event) => setIssueDate(event.target.value)}
          error={fieldErrors.issue_date}
          hint="Optional. Defaults to today."
        />

        <Field
          id="due_date"
          label="Due back"
          type="date"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
          error={fieldErrors.due_date}
          hint="Optional. Defaults to the issue date plus the book’s loan period, and is what any fine is measured from."
        />

        <TextAreaField
          id="remarks"
          label="Remarks"
          rows={2}
          maxLength={255}
          value={remarks}
          onChange={(event) => setRemarks(event.target.value)}
          error={fieldErrors.remarks}
          hint="Optional. Anything worth noting about the condition or the loan."
        />
      </form>
    </Modal>
  );
}

/* ─────────────────────────────── step two: return ─────────────────────────────── */

const RETURN_FIELDS = new Set(['outcome', 'return_date', 'remarks']);

/**
 * `PATCH /library/transactions/:id/return`.
 *
 * ## `lost` is offered, and it is not a fine
 *
 * `outcome` is `returned` or `lost`. §20.4 names only Issue, Return and Fine, and the module offers
 * `lost` because `LIBRARY_TRANSACTION_STATUS` carries it and a copy that never comes back otherwise
 * has no terminal state — the alternatives are a loan open for ever or one falsely marked returned.
 * Nothing further is inferred: **no price is charged and the shelf count is not adjusted**, because
 * the SRS says nothing about either. The copy says so, so a librarian does not expect a charge that
 * is not coming.
 *
 * ## The fine is not settled here
 *
 * The schema `forbidden()`s `fine_paid` and `fine_waived` on this route with its own reason —
 * *"settle the fine on the fine route, so the calculation and the payment stay separate"*. A return
 * computes what is owed; the next dialog is where it is paid.
 */
function ReturnDialog({
  loan,
  onClose,
  onDone,
}: {
  loan: LoanRow | null;
  onClose: () => void;
  onDone: (outcome: string) => void;
}) {
  const [outcome, setOutcome] = useState('returned');
  const [returnDate, setReturnDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!loan) return;
    setOutcome('returned');
    setReturnDate('');
    setRemarks('');
    setBusy(false);
    setFailure(null);
    setFieldErrors({});
  }, [loan]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!loan) return;
    setBusy(true);
    setFailure(null);
    setFieldErrors({});

    try {
      await api.patch(`/library/transactions/${loan.id}/return`, {
        outcome,
        return_date: returnDate || undefined,
        remarks: remarks.trim() || undefined,
      });
      onDone(outcome);
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      const { perField, banner } = splitApiErrors(caught, RETURN_FIELDS);
      setFieldErrors(perField);
      setFailure(banner);
      if (Object.keys(perField).length) focusFirstInvalidField();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={loan !== null}
      onClose={onClose}
      title="Record a return"
      description={
        loan?.book
          ? `${loan.book.title} — due back ${loan.due_date.slice(0, 10)}.`
          : 'Any fine owed is worked out from the due date and settled separately.'
      }
      size="sm"
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary">
            Cancel
          </button>
          <SubmitButton form="return-book" busy={busy} busyLabel="Recording…">
            Record
          </SubmitButton>
        </>
      }
    >
      <form id="return-book" onSubmit={submit} className="space-y-4" noValidate>
        {failure ? <Notice tone="error">{failure}</Notice> : null}

        <SelectField
          id="outcome"
          label="Outcome"
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
          error={fieldErrors.outcome}
          hint="A lost copy closes the loan and does not go back on the shelf. No charge is raised for it — a replacement cost is not something this module records."
        >
          <option value="returned">Returned</option>
          <option value="lost">Lost</option>
        </SelectField>

        <Field
          id="return_date"
          label="Returned on"
          type="date"
          value={returnDate}
          onChange={(event) => setReturnDate(event.target.value)}
          error={fieldErrors.return_date}
          hint="Optional. Defaults to today, and is what a late fine is counted to."
        />

        <TextAreaField
          id="remarks"
          label="Remarks"
          rows={2}
          maxLength={255}
          value={remarks}
          onChange={(event) => setRemarks(event.target.value)}
          error={fieldErrors.remarks}
          hint="Optional. Condition on return, or why it is recorded as lost."
        />
      </form>
    </Modal>
  );
}

/* ─────────────────────────────── step three: the fine ─────────────────────────────── */

const FINE_FIELDS = new Set(['fine_paid', 'fine_waived', 'remarks']);

/**
 * `PATCH /library/transactions/:id/fine`.
 *
 * Two outcomes on one form, because they answer the same question — what happens to what is owed —
 * and the school is choosing between them rather than doing both. Waiving hides the amount, because
 * an amount box that is about to be ignored is a control that lies about what it does.
 *
 * The amount offered is the server's own `fine_outstanding`
 * (`clampNonNegative(fine_amount − fine_paid)`), not a subtraction repeated here: the module has one
 * place that does money arithmetic and this is not it. A payment above what is owed is refused.
 */
function FineDialog({
  loan,
  onClose,
  onDone,
}: {
  loan: LoanRow | null;
  onClose: () => void;
  onDone: (waived: boolean) => void;
}) {
  const owed = Number(loan?.fine_outstanding ?? 0);

  const [waive, setWaive] = useState(false);
  const [amount, setAmount] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /* The full outstanding amount is the default, because settling in full is the common case. */
  useEffect(() => {
    if (!loan) return;
    setWaive(false);
    setAmount(owed > 0 ? owed.toFixed(2) : '');
    setRemarks('');
    setBusy(false);
    setFailure(null);
    setFieldErrors({});
  }, [loan, owed]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!loan) return;
    setBusy(true);
    setFailure(null);
    setFieldErrors({});

    try {
      /*
       * One or the other. The schema is `.min(1)` and accepts both keys, but sending an amount
       * alongside a waiver would be asking the server to decide which the school meant.
       */
      const body = waive
        ? { fine_waived: true, remarks: remarks.trim() || undefined }
        : { fine_paid: Number(amount), remarks: remarks.trim() || undefined };

      await api.patch(`/library/transactions/${loan.id}/fine`, body);
      onDone(waive);
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      const { perField, banner } = splitApiErrors(caught, FINE_FIELDS);
      setFieldErrors(perField);
      setFailure(banner);
      if (Object.keys(perField).length) focusFirstInvalidField();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={loan !== null}
      onClose={onClose}
      title="Settle the fine"
      description={`${owed.toFixed(2)} ${loan?.currency ?? ''} is outstanding on this loan.`.trim()}
      size="sm"
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary">
            Cancel
          </button>
          <SubmitButton form="settle-fine" busy={busy} busyLabel="Recording…">
            {waive ? 'Waive the fine' : 'Record payment'}
          </SubmitButton>
        </>
      }
    >
      <form id="settle-fine" onSubmit={submit} className="space-y-4" noValidate>
        {failure ? <Notice tone="error">{failure}</Notice> : null}

        <CheckboxField
          id="fine_waived"
          label="Waive it instead"
          checked={waive}
          onChange={(event) => setWaive(event.target.checked)}
          error={fieldErrors.fine_waived}
          hint="Clears the whole outstanding amount without a payment. Recorded as waived rather than as paid."
        />

        {waive ? null : (
          <Field
            id="fine_paid"
            label="Amount paid"
            type="number"
            step="0.01"
            min={0}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            error={fieldErrors.fine_paid}
            hint="Defaults to the whole amount outstanding. A part-payment leaves the rest owed; more than is owed is refused."
          />
        )}

        <TextAreaField
          id="remarks"
          label="Remarks"
          rows={2}
          maxLength={255}
          value={remarks}
          onChange={(event) => setRemarks(event.target.value)}
          error={fieldErrors.remarks}
          hint="Optional. Worth using for a waiver, which otherwise records no reason."
        />
      </form>
    </Modal>
  );
}
