'use client';

/**
 * Fees — SRS §17, §33's "Fees", checklist row 4.4.
 *
 * (This line read §18.1. §17 is Fee Management; §18 is Finance Management, which is the other screen.)
 *
 * Three collections under one §33 screen, following `library/page.tsx`:
 *
 *   - **Structures** (`/fees/structures`) — what a class is charged, per component. The definition.
 *   - **Ledger** (`/fees/ledger`) — what each student actually owes, once a structure has been
 *     assigned to them. `/fees/assignments` is the POST that creates these and has no GET, which is
 *     why assignment is an action rather than a fourth tab.
 *   - **Payments** (`/fees/payments`) — what has been collected against the ledger.
 *
 * Reading them in that order is reading the module: a structure produces a ledger row, a ledger row
 * receives payments. The tab order is deliberate for that reason.
 *
 * ## Money is a string here too
 *
 * Every amount is a DECIMAL and arrives as a string. Parsed for display only, never summed across a
 * page — see `finance/page.tsx`, which has the same rule and the same reason.
 *
 * `receipt_path` on a payment is a stored path and is never rendered.
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { useCollection } from '@/lib/useCollection';
import { splitApiErrors } from '@/lib/formErrors';
import { formatAmountWithCode } from '@/lib/money';
import {
  CheckboxField,
  Field,
  MultiSelectField,
  Notice,
  SearchField,
  SelectField,
  SubmitButton,
  TextAreaField,
  FilterBar,
  FilterSelect,
  focusFirstInvalidField,
} from '@/components/form';
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

interface Structure {
  id: number;
  name: string;
  component: string;
  class_id: number | null;
  amount: string | number;
  currency: string;
  is_recurring: boolean;
  due_day: number | null;
  is_active: boolean;
  class?: { id: number; name: string };
}

interface LedgerRow {
  id: number;
  student_id: number;
  component: string;
  title: string;
  period_month: string | null;
  currency: string;
  amount: string | number;
  net_amount: string | number;
  /* Returned by `GET /fees/ledger` — the query restricts no attributes on `student_fees`. */
  paid_amount: string | number;
  pending_amount: string | number;
  status: string;
  due_date?: string | null;
  student?: { id: number; first_name: string; last_name: string | null };
}

interface PaymentRow {
  id: number;
  receipt_number: string;
  student_id: number;
  currency: string;
  amount: string | number;
  method: string;
  reference: string | null;
  paid_at: string;
  student?: { id: number; first_name: string; last_name: string | null };
}

const TABS: TabDef[] = [
  { key: 'structures', label: 'Structures' },
  { key: 'ledger', label: 'Ledger' },
  { key: 'payments', label: 'Payments' },
];

function money(amount: string | number, currency: string) {
  const value = typeof amount === 'number' ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(value)) return <span className="text-muted-soft">—</span>;
  return (
    <span className="tabular-nums">
      {value.toFixed(2)} <span className="text-muted-soft">{currency}</span>
    </span>
  );
}

/** A student's name from the included association, or the id when it was not included. */
function studentName(row: { student?: { first_name: string; last_name: string | null }; student_id: number }) {
  if (!row.student) return <span className="text-muted-soft">student #{row.student_id}</span>;
  return [row.student.first_name, row.student.last_name].filter(Boolean).join(' ');
}

/**
 * The same name as **plain text**, for a dialog title or description.
 *
 * `studentName` returns JSX on its fallback branch, which is right for a table cell and wrong
 * anywhere a string is expected: interpolating it into a template literal renders
 * `[object Object]` — which is exactly what the payment dialog said until this existed. The
 * association is a LEFT JOIN, so that branch is reachable, and the failure would have shown up only
 * for the rows whose student did not come back.
 */
function studentText(row: {
  student?: { first_name: string; last_name: string | null };
  student_id: number;
}): string {
  if (!row.student) return `student #${row.student_id}`;
  return [row.student.first_name, row.student.last_name].filter(Boolean).join(' ');
}

/* ─────────────────────────────── structures ─────────────────────────────── */

function StructuresPanel() {
  const { success } = useToast();
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  const query = useMemo(() => ({ page, limit: 20, q: search || undefined }), [page, search]);
  const { rows, meta, loading, error, refusal, reload } = useCollection<Structure>('/fees/structures', query);

  /* `fees.manage` is what `POST /fees/assignments` is mounted behind. */
  const canManage = can('fees.manage');
  const [assigning, setAssigning] = useState<Structure | null>(null);

  const columns = useMemo<Column<Structure>[]>(() => {
    const base: Column<Structure>[] = [
      { key: 'name', header: 'Name', cell: (row) => <span className="font-medium">{row.name}</span> },
      { key: 'component', header: 'Component', cell: (row) => row.component.replace(/_/g, ' ') },
      {
        key: 'class',
        header: 'Class',
        /* A structure with no class applies school-wide, which is a fact worth showing as words. */
        cell: (row) => row.class?.name ?? (row.class_id ? `class #${row.class_id}` : <span className="text-muted-soft">all classes</span>),
      },
      { key: 'amount', header: 'Amount', numeric: true, cell: (row) => money(row.amount, row.currency) },
      {
        key: 'recurring',
        header: 'Recurring',
        cell: (row) => (row.is_recurring ? `monthly${row.due_day ? `, day ${row.due_day}` : ''}` : 'one-off'),
      },
      { key: 'active', header: 'Status', cell: (row) => <StatusBadge status={row.is_active ? 'active' : 'inactive'} /> },
    ];

    /*
     * FR-FEE-001's actual operation, which had no control anywhere.
     *
     * `POST /fees/assignments` is the **only** writer of `student_fees` —
     * `fees.service.js` `assign()` and its `bulkCreate` are reachable through no other route — and
     * nothing in the frontend called it. So a school could define what it charges and never charge
     * anyone: the ledger had no populating path, its empty notice described a step the product did
     * not offer, and `fees.collect` was a permission nothing could exercise.
     */
    if (!canManage) return base;

    return [
      ...base,
      {
        key: 'actions',
        header: 'Actions',
        cell: (row) =>
          row.is_active ? (
            <button
              type="button"
              onClick={() => setAssigning(row)}
              className="btn btn-ghost btn-sm"
            >
              Assign
            </button>
          ) : (
            /* An inactive structure is one the school has stopped charging; assigning it would
               create a live debt from a retired rule. */
            <span className="text-muted-soft">—</span>
          ),
      },
    ];
  }, [canManage]);

  return (
    <>
      <FilterBar
        activeCount={[search].filter(Boolean).length}
        onClear={() => {
          setSearch('');
          setPage(1);
        }}
      >
        <SearchField
          id="structure-search"
          label="Search fee structures"
          placeholder="Name or component…"
          value={search}
          onChange={(value) => { setSearch(value); setPage(1); }}
        />
        {can('fees.manage') ? (
          <a href="/school/fees/structures/new" className="ml-auto self-start btn btn-primary">
            Add structure
          </a>
        ) : null}
      </FilterBar>

      {refusal ? <RefusalNotice refusal={refusal} />
        : error ? <ErrorNotice message={error} onRetry={reload} />
        : loading && rows.length === 0 ? <LoadingBlock />
        : rows.length === 0 ? <EmptyNotice>No fee structures have been defined yet.</EmptyNotice>
        : (
          <>
            <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Fee structures"
            busy={loading}
          />
            {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
          </>
        )}

      <AssignDialog
        structure={assigning}
        onClose={() => setAssigning(null)}
        onDone={(count) => {
          setAssigning(null);
          success(
            `Assigned to ${count} student${count === 1 ? '' : 's'}`,
            'The charges are on the Ledger tab.'
          );
          reload();
        }}
      />
    </>
  );
}

/* ─────────────────────────────── ledger ─────────────────────────────── */

function LedgerPanel() {
  const { can } = useAuth();
  const { success } = useToast();

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');

  const query = useMemo(() => ({ page, limit: 20, status: status || undefined }), [page, status]);
  const { rows, meta, loading, error, refusal, reload } = useCollection<LedgerRow>('/fees/ledger', query);

  /* `fees.collect` is what `POST /fees/payments` is mounted behind — a narrower grant than manage. */
  const canCollect = can('fees.collect');
  const [collecting, setCollecting] = useState<LedgerRow | null>(null);

  const columns = useMemo<Column<LedgerRow>[]>(() => {
    const base: Column<LedgerRow>[] = [
      { key: 'student', header: 'Student', cell: (row) => studentName(row) },
      { key: 'title', header: 'Fee', cell: (row) => <span className="font-medium">{row.title}</span> },
      { key: 'component', header: 'Component', cell: (row) => row.component.replace(/_/g, ' ') },
      { key: 'period', header: 'Period', cell: (row) => row.period_month ?? <span className="text-muted-soft">—</span> },
      /*
       * Three money columns, because FR-FEE-002's Expected Outcome is that the ledger "reflects
       * payments made and any remaining pending balance" — two figures this screen did not show.
       *
       * It previously showed one column labelled **Owed** bound to `net_amount`, and the comment
       * defending that said `net_amount` "is what the student actually owes after discount and fine".
       * That is wrong, and wrong in the direction that matters: `net_amount` is what the student was
       * *charged* after discount and fine, before any payment. `pending_amount` is what they owe, and
       * `fees.service.js:448` computes and stores exactly that as `max(0, net − paid)`.
       *
       * The visible consequence: a student who had paid 300 against a 950 fee rendered as
       * "Owed 950.00" beside a `partially_paid` badge — the label asserted a balance, the value was
       * the bill, and the badge contradicted both.
       */
      { key: 'net', header: 'Charged', numeric: true, cell: (row) => money(row.net_amount, row.currency) },
      { key: 'paid', header: 'Paid', numeric: true, cell: (row) => money(row.paid_amount, row.currency) },
      { key: 'pending', header: 'Pending', numeric: true, cell: (row) => money(row.pending_amount, row.currency) },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
    ];

    /*
     * FR-FEE-002 — collection. `POST /fees/payments` is the only creator of a `FeePayment` and had
     * no caller either, so a fee could be charged and never receipted.
     *
     * Offered only while something is owed: `pending_amount` is `max(0, net − paid)` computed and
     * stored by the service, so this reads the server's own answer. A settled or waived fee gets no
     * button, because a payment against it is refused.
     */
    if (!canCollect) return base;

    return [
      ...base,
      {
        key: 'actions',
        header: 'Actions',
        cell: (row) =>
          Number(row.pending_amount) > 0 ? (
            <button
              type="button"
              onClick={() => setCollecting(row)}
              className="btn btn-ghost btn-sm"
            >
              Record payment
            </button>
          ) : (
            <span className="text-muted-soft">—</span>
          ),
      },
    ];
  }, [canCollect]);

  return (
    <>
      <FilterBar activeCount={status ? 1 : 0} onClear={() => { setStatus(''); setPage(1); }}>
        <FilterSelect
          id="ledger-status"
          label="Fee status"
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        >
          <option value="">Any status</option>
          <option value="unpaid">Unpaid</option>
          <option value="partially_paid">Partially paid</option>
          <option value="paid">Paid</option>
          {/*
            No "Overdue" option. `STUDENT_FEE_STATUS` is exactly
            { unpaid, partially_paid, paid, waived } (`constants.js:472-477`) and the ledger endpoint
            pins the filter to it (`fees.validation.js:186`). Offering `overdue` sent a value the enum
            does not contain, so Joi refused the whole request with 422 and the screen replaced its
            table with a validation error — one of five options broke the page it belonged to.

            Overdue is a *derived* condition, not a stored status: it is `pending_amount > 0` past
            `due_date`. §17 names "Pending Fee" and no overdue state, so adding one would be inventing
            a sixth status; filtering by it would need a query parameter the API does not offer.
          */}
          <option value="waived">Waived</option>
        </FilterSelect>
      </FilterBar>

      {refusal ? <RefusalNotice refusal={refusal} />
        : error ? <ErrorNotice message={error} onRetry={reload} />
        : loading && rows.length === 0 ? <LoadingBlock />
        : rows.length === 0 ? (
          <EmptyNotice>
            Nothing on the ledger. Fees appear here once a structure has been assigned to students.
          </EmptyNotice>
        ) : (
          <>
            <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Student fee ledger"
            busy={loading}
          />
            {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
          </>
        )}

      <CollectDialog
        fee={collecting}
        onClose={() => setCollecting(null)}
        onDone={() => {
          setCollecting(null);
          success('Payment recorded', 'The receipt is on the Payments tab.');
          reload();
        }}
      />
    </>
  );
}

/* ─────────────────────────────── payments ─────────────────────────────── */

function PaymentsPanel() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  const query = useMemo(() => ({ page, limit: 20, q: search || undefined }), [page, search]);
  const { rows, meta, loading, error, refusal, reload } = useCollection<PaymentRow>('/fees/payments', query);

  const columns = useMemo<Column<PaymentRow>[]>(
    () => [
      { key: 'receipt', header: 'Receipt', cell: (row) => <code className="text-xs">{row.receipt_number}</code> },
      { key: 'student', header: 'Student', cell: (row) => studentName(row) },
      { key: 'paid_at', header: 'Paid', cell: (row) => row.paid_at?.slice(0, 10) ?? '—' },
      { key: 'method', header: 'Method', cell: (row) => row.method.replace(/_/g, ' ') },
      { key: 'reference', header: 'Reference', cell: (row) => row.reference ?? <span className="text-muted-soft">—</span> },
      { key: 'amount', header: 'Amount', numeric: true, cell: (row) => money(row.amount, row.currency) },
    ],
    []
  );

  return (
    <>
      <div className="mb-4">
        <SearchField
          id="payment-search"
          label="Search fee payments"
          placeholder="Receipt number or reference…"
          value={search}
          onChange={(value) => { setSearch(value); setPage(1); }}
        />
      </div>

      {refusal ? <RefusalNotice refusal={refusal} />
        : error ? <ErrorNotice message={error} onRetry={reload} />
        : loading && rows.length === 0 ? <LoadingBlock />
        : rows.length === 0 ? <EmptyNotice>No fee payments have been collected yet.</EmptyNotice>
        : (
          <>
            <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Fee payments"
            busy={loading}
          />
            {meta ? <Pagination meta={meta} onPage={setPage} /> : null}
          </>
        )}
    </>
  );
}

/* ─────────────────────────────── the screen ─────────────────────────────── */

function FeesScreen() {
  const [active, setActive] = useActiveTab(TABS);

  return (
    <div>
      <PageHeader
        title="Fees"
        description="What is charged, what each student owes, and what has been collected."
      />
      <Tabs tabs={TABS} active={active} onChange={setActive} label="Fee sections" />
      <TabPanel tabKey={active}>
        {active === 'structures' ? <StructuresPanel /> : active === 'payments' ? <PaymentsPanel /> : <LedgerPanel />}
      </TabPanel>
    </div>
  );
}

export default function FeesPage() {
  return (
    <Suspense fallback={<LoadingBlock />}>
      <FeesScreen />
    </Suspense>
  );
}


/* ─────────────────────────── FR-FEE-001: assigning a structure ─────────────────────────── */

const ASSIGN_FIELDS = new Set([
  'fee_structure_id',
  'student_ids',
  'due_date',
  'period_month',
  'title',
  'amount',
  'discount_amount',
  'fine_amount',
  'remarks',
]);

interface StudentPick {
  id: number;
  student_id: string;
  first_name: string;
  last_name: string | null;
  status: string;
  class_id: number | null;
}

/**
 * `POST /fees/assignments` — the only writer of the ledger.
 *
 * ## Why the student list is a checkbox set and not a `<select multiple>`
 *
 * `student_ids` is `Joi.array().min(1).max(500)`, so this is a genuinely multiple choice, and
 * `MultiSelectField` is what the product uses for one: a native multiple-select needs ctrl-click,
 * which nothing says and no touch device has, and it shows the selection only while the list is in
 * view. Charging thirty students is exactly the case where a reader needs to see what they have
 * ticked, which is why the control reports its own count.
 *
 * ## The class filter is a convenience, not a rule
 *
 * A structure may name a class (`class_id`), and when it does the picker offers that class first —
 * because assigning a Grade 5 fee to Grade 5 is the overwhelming case. It is **not** enforced:
 * `fees.service.js` `assign()` checks each student belongs to the school and requires nothing about
 * their class, so filtering would refuse an assignment the API accepts. The toggle says so.
 *
 * ## The three money fields override the structure, for this assignment only
 *
 * Left blank they are not sent and the structure's own figures apply — which is the point of having
 * a structure. `net_amount`, `paid_amount`, `pending_amount` and `status` are `forbidden()` on the
 * schema with their own messages, because the ledger's arithmetic is the system's.
 */
function AssignDialog({
  structure,
  onClose,
  onDone,
}: {
  structure: Structure | null;
  onClose: () => void;
  onDone: (count: number) => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [periodMonth, setPeriodMonth] = useState('');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [discount, setDiscount] = useState('');
  const [fine, setFine] = useState('');
  const [remarks, setRemarks] = useState('');
  const [onlyThisClass, setOnlyThisClass] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [students, setStudents] = useState<StudentPick[]>([]);
  const [studentsFailed, setStudentsFailed] = useState(false);

  useEffect(() => {
    if (!structure) return;
    setSelected([]);
    setDueDate('');
    setPeriodMonth('');
    setTitle('');
    setAmount('');
    setDiscount('');
    setFine('');
    setRemarks('');
    setOnlyThisClass(true);
    setBusy(false);
    setFailure(null);
    setFieldErrors({});
  }, [structure]);

  useEffect(() => {
    if (!structure) return;
    const controller = new AbortController();
    setStudentsFailed(false);

    (async () => {
      try {
        const page = await api.page<StudentPick[]>('/students', {
          query: { limit: 100 },
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setStudents(page.data);
      } catch {
        if (!controller.signal.aborted) setStudentsFailed(true);
      }
    })();

    return () => controller.abort();
  }, [structure]);

  /*
   * Only `active` students are offered.
   *
   * Unlike the parent picker, which deliberately offers everybody because a parent of a departed
   * student still has fees to read, this creates a **new debt** — and raising one against a student
   * who has left is a mistake nobody would make deliberately. The API would accept it, so the
   * narrowing is this screen's judgement and is stated rather than silent.
   */
  const options = useMemo(() => {
    const live = students.filter((row) => row.status === 'active');
    const scoped =
      onlyThisClass && structure?.class_id
        ? live.filter((row) => row.class_id === structure.class_id)
        : live;
    return scoped.map((row) => ({
      value: row.id,
      label: [row.first_name, row.last_name].filter(Boolean).join(' '),
      hint: row.student_id,
    }));
  }, [students, onlyThisClass, structure?.class_id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!structure) return;
    setBusy(true);
    setFailure(null);
    setFieldErrors({});

    try {
      await api.post('/fees/assignments', {
        fee_structure_id: structure.id,
        student_ids: selected,
        due_date: dueDate,
        period_month: periodMonth || undefined,
        title: title.trim() || undefined,
        amount: amount.trim() ? Number(amount) : undefined,
        discount_amount: discount.trim() ? Number(discount) : undefined,
        fine_amount: fine.trim() ? Number(fine) : undefined,
        remarks: remarks.trim() || undefined,
      });
      onDone(selected.length);
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      const { perField, banner } = splitApiErrors(caught, ASSIGN_FIELDS);
      setFieldErrors(perField);
      setFailure(banner);
      if (Object.keys(perField).length) focusFirstInvalidField();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={structure !== null}
      onClose={onClose}
      title={structure ? `Charge “${structure.name}”` : 'Assign a fee'}
      description={
        structure
          ? `${formatAmountWithCode(structure.amount, structure.currency)} each unless you override it below. Every student you tick gets one charge on the ledger.`
          : ''
      }
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary">
            Cancel
          </button>
          <SubmitButton form="assign-fee" busy={busy} busyLabel="Assigning…">
            {selected.length ? `Charge ${selected.length}` : 'Charge'}
          </SubmitButton>
        </>
      }
    >
      <form id="assign-fee" onSubmit={submit} className="space-y-4" noValidate>
        {failure ? <Notice tone="error">{failure}</Notice> : null}
        {studentsFailed ? (
          <Notice tone="warn">
            The student list could not be loaded, so there is nobody to charge. It needs
            `students.view`, which is separate from managing fees.
          </Notice>
        ) : null}

        {structure?.class_id ? (
          <CheckboxField
            id="only_this_class"
            label={`Only ${structure.class?.name ?? 'this structure’s class'}`}
            checked={onlyThisClass}
            onChange={(event) => setOnlyThisClass(event.target.checked)}
            hint="A convenience, not a rule — the API accepts any student of this school, so untick it to charge somebody outside the class this structure names."
          />
        ) : null}

        <MultiSelectField<number>
          id="student_ids"
          label="Students"
          options={options}
          selected={selected}
          onChange={setSelected}
          error={fieldErrors.student_ids}
          emptyLabel="No active student matches. Untick the class filter, or admit a student first."
          hint="At least one, up to 500. Only students with an active status are listed — a new charge against somebody who has left is almost never intended."
        />

        <Field
          id="due_date"
          label="Due date"
          type="date"
          required
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
          error={fieldErrors.due_date}
          hint="Required. What any late fine is measured from."
        />

        <Field
          id="period_month"
          label="Period"
          type="month"
          value={periodMonth}
          onChange={(event) => setPeriodMonth(event.target.value)}
          error={fieldErrors.period_month}
          hint="Optional, for a recurring fee — which month this charge is for."
        />

        <Field
          id="title"
          label="Title"
          maxLength={180}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          error={fieldErrors.title}
          hint="Optional. Left blank, the charge is named after the structure."
        />

        <Field
          id="amount"
          label="Amount"
          type="number"
          step="0.01"
          min={0}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          error={fieldErrors.amount}
          hint="Optional override for this assignment only. Blank uses the structure’s own amount."
        />

        <Field
          id="discount_amount"
          label="Discount"
          type="number"
          step="0.01"
          min={0}
          value={discount}
          onChange={(event) => setDiscount(event.target.value)}
          error={fieldErrors.discount_amount}
          hint="Optional. Comes off the amount before anything is owed."
        />

        <Field
          id="fine_amount"
          label="Fine"
          type="number"
          step="0.01"
          min={0}
          value={fine}
          onChange={(event) => setFine(event.target.value)}
          error={fieldErrors.fine_amount}
          hint="Optional. Added to what is owed."
        />

        <TextAreaField
          id="remarks"
          label="Remarks"
          rows={2}
          maxLength={255}
          value={remarks}
          onChange={(event) => setRemarks(event.target.value)}
          error={fieldErrors.remarks}
          hint="Optional. Kept on every charge this creates."
        />
      </form>
    </Modal>
  );
}

/* ─────────────────────────── FR-FEE-002: recording a payment ─────────────────────────── */

/** `PAYMENT_METHODS` in `config/constants.js`, which the schema pins the field to. */
const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'manual_payment', label: 'Manual payment' },
  { value: 'online_gateway', label: 'Online gateway' },
  { value: 'wallet', label: 'Wallet' },
];

const COLLECT_FIELDS = new Set([
  'student_fee_id',
  'amount',
  'method',
  'fine_paid',
  'discount_given',
  'reference',
  'paid_at',
  'remarks',
]);

/**
 * `POST /fees/payments`.
 *
 * The amount defaults to the whole outstanding balance, because settling in full is the common case
 * and a part-payment is the deliberate one. `receipt_number` is `forbidden()` on the schema — it is
 * issued by the system — so nothing here offers to name one.
 */
function CollectDialog({
  fee,
  onClose,
  onDone,
}: {
  fee: LedgerRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const pending = Number(fee?.pending_amount ?? 0);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!fee) return;
    setAmount(pending > 0 ? pending.toFixed(2) : '');
    setMethod('cash');
    setReference('');
    setPaidAt('');
    setRemarks('');
    setBusy(false);
    setFailure(null);
    setFieldErrors({});
  }, [fee, pending]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!fee) return;
    setBusy(true);
    setFailure(null);
    setFieldErrors({});

    try {
      await api.post('/fees/payments', {
        student_fee_id: fee.id,
        amount: Number(amount),
        method,
        reference: reference.trim() || undefined,
        paid_at: paidAt || undefined,
        remarks: remarks.trim() || undefined,
      });
      onDone();
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      const { perField, banner } = splitApiErrors(caught, COLLECT_FIELDS);
      setFieldErrors(perField);
      setFailure(banner);
      if (Object.keys(perField).length) focusFirstInvalidField();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={fee !== null}
      onClose={onClose}
      title="Record a payment"
      description={
        fee
          ? `${fee.title} — ${studentText(fee)} owes ${formatAmountWithCode(fee.pending_amount, fee.currency)}.`
          : ''
      }
      size="sm"
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary">
            Cancel
          </button>
          <SubmitButton form="collect-fee" busy={busy} busyLabel="Recording…">
            Record payment
          </SubmitButton>
        </>
      }
    >
      <form id="collect-fee" onSubmit={submit} className="space-y-4" noValidate>
        {failure ? <Notice tone="error">{failure}</Notice> : null}

        <Field
          id="amount"
          label="Amount"
          type="number"
          step="0.01"
          min={0}
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          error={fieldErrors.amount}
          hint="Defaults to the whole balance. A smaller figure leaves the rest owed and the fee partially paid."
        />

        <SelectField
          id="method"
          label="Method"
          required
          value={method}
          onChange={(event) => setMethod(event.target.value)}
          error={fieldErrors.method}
        >
          {METHODS.map((row) => (
            <option key={row.value} value={row.value}>
              {row.label}
            </option>
          ))}
        </SelectField>

        <Field
          id="reference"
          label="Reference"
          maxLength={120}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          error={fieldErrors.reference}
          hint="Optional. A transaction id or cheque number — whatever the school would look this up by."
        />

        <Field
          id="paid_at"
          label="Paid on"
          type="date"
          value={paidAt}
          onChange={(event) => setPaidAt(event.target.value)}
          error={fieldErrors.paid_at}
          hint="Optional. Defaults to today."
        />

        <TextAreaField
          id="remarks"
          label="Remarks"
          rows={2}
          maxLength={255}
          value={remarks}
          onChange={(event) => setRemarks(event.target.value)}
          error={fieldErrors.remarks}
          hint="Optional. Kept on the receipt."
        />
      </form>
    </Modal>
  );
}
