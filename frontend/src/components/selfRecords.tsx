'use client';

/**
 * The pieces the student's and the parent's D17 screens share — attendance, fees, the record and the
 * timetable.
 *
 * The owner's decision D17 mounted three self-view endpoints (`GET /students/mine`,
 * `GET /attendance/mine`, `GET /fees/mine`) and read the class timetable through the ordinary
 * `GET /timetable/class/:classId`. All three self views answer with one block **per student**, headed
 * by the same student object (`services/selfScope.js linkedStudents()`): for a parent, one per linked
 * child or the one child named in `student_id`; for a student, their own — and one account can be both,
 * an adult learner with a child enrolled, because `selfScope` consults both profiles. So every screen
 * renders whatever blocks come back rather than assuming how many.
 *
 * Shared, here, because no route group imports another's files: the student and parent surfaces each
 * held an identical 700-line copy of this until a review of both found nothing but the header differed.
 */

import type { ReactNode } from 'react';

import { localDay } from '@/lib/instants';
import { formatAmountWithCode } from '@/lib/money';
import { Column, DataTable, EmptyNotice, MetricCard, StatusBadge } from '@/components/table';

/* ─────────────────────────────── the student every block is about ─────────────────────────────── */

/**
 * The student a self view heads its rows with — `selfScope.linkedStudents()`: seven named columns,
 * the three placement ids it always adds, and the class, section and session by name, since neither a
 * student nor a parent holds `classes.view` or `sessions.view` to resolve an id. Each association is a
 * LEFT JOIN on a nullable key, so each can be null.
 */
export interface SelfHead {
  id: number;
  student_id: string;
  roll_number: string | null;
  first_name: string;
  last_name: string | null;
  status: string;
  class_id: number | null;
  section_id: number | null;
  class: { id: number; name: string } | null;
  section: { id: number; name: string } | null;
  academicSession: { id: number; name: string } | null;
}

/** "First Last", with a nullable last name dropped rather than printed as "null". */
export function nameOf(student: { first_name: string; last_name: string | null }): string {
  return [student.first_name, student.last_name].filter(Boolean).join(' ');
}

/** "Grade 5 · A", "Grade 5", or null for a student not yet placed in a class. */
export function placementOf(student: SelfHead): string | null {
  if (!student.class) return null;
  return student.section ? `${student.class.name} · ${student.section.name}` : student.class.name;
}

/**
 * Who a block is about, above it. Shown only where it tells the reader something: a student with one
 * record knows whose it is, and a heading repeating their own name would be noise.
 *
 * `level` keeps the outline in order: an `h2` directly under the page title, an `h3` where a section
 * heading already sits above it (the attendance period).
 */
export function StudentHeading({ student, level = 2 }: { student: SelfHead; level?: 2 | 3 }) {
  const detail = [placementOf(student), `Student ID ${student.student_id}`].filter(Boolean).join(' · ');
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <Heading className="text-base font-semibold tracking-tight text-ink">{nameOf(student)}</Heading>
      <p className="text-sm text-muted">{detail}</p>
    </div>
  );
}

/* ─────────────────────────────── dates ─────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A `DATEONLY` read as characters, never through `Date` — the school screens' formatter, for their
 * reason: `new Date('2026-02-01')` is UTC midnight, which west of Greenwich is the 31st of January, so
 * the day a fee falls due or a register was marked would move. Anything else is shown as sent.
 */
export function formatDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : value;
}

/** `2026-09-01` → `Sep 2026`, for `period_month`, the first day of the month a recurring fee covers. */
function formatMonth(value: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(value);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${match[1]}` : value;
}

/**
 * A `DATE` — an instant, such as `paid_at` — as the day it fell on **in the viewer's zone**, then
 * spelled like a `DATEONLY`. `localDay()` exists because slicing the ISO string read the UTC day.
 */
function formatInstantDay(value: string | null): string | null {
  const day = localDay(value);
  return day ? formatDay(day) : null;
}

/** `partially_paid` → `partially paid`, for a word a person reads. */
const spell = (value: string) => value.replace(/_/g, ' ');

const NONE = <span className="text-muted-soft">—</span>;

/* Pinned to `en-US`, as the school screens pin theirs, so a count is grouped the same way everywhere. */
const COUNT = new Intl.NumberFormat('en-US');

/* ─────────────────────────────── attendance ─────────────────────────────── */

/** One day of the register, as `attendance.service.js mine()` selects it. */
export interface AttendanceDay {
  id: number;
  /** `DATEONLY`, NOT NULL. */
  attendance_date: string;
  status: string;
  /**
   * Minutes late. The API accepts it with any status (`attendance.validation.js` records why), so it is
   * shown only on a `late` day — a "late by 5 min" beside Present or Absent would contradict itself.
   */
  late_minutes: number | null;
  remarks: string | null;
}

/** One student's period: `report()`'s figures for them alone, and their register beside it. */
export interface AttendanceBlock {
  student: SelfHead;
  /** All four statuses, zero-filled by `report()`, so a missing word is never a guess. */
  counts: Record<string, number>;
  marked: number;
  attended: number;
  /** Two decimals, and **null** when nothing was marked — an unknown rate, not a zero one. */
  percentage: number | null;
  records: AttendanceDay[];
}

/** `GET /attendance/mine`, inside `{ attendance }`. */
export interface MyAttendance {
  period: 'daily' | 'monthly' | 'yearly';
  /** `periodRange()`'s name for the period: `2026-09-05`, `2026-09` or `2026`. */
  label: string;
  /** Both `YYYY-MM-DD`, inclusive — the window the server derived from the anchor date. */
  from: string;
  to: string;
  students: AttendanceBlock[];
}

/** FR-ATT-002's three periods, exactly — `attendance.validation.js` `mine` accepts no fourth. */
export const PERIODS = [
  { value: 'daily', label: 'Daily' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
] as const;

/** §16's statuses in the SRS's order — `ATTENDANCE_STATUS` in `constants.js`. */
const STATUSES = ['present', 'absent', 'leave', 'late'] as const;

/** "Monthly — Sep 2026", by slicing the label rather than through `Date`. */
export function periodTitle(attendance: MyAttendance): string {
  const kind = PERIODS.find((option) => option.value === attendance.period)?.label ?? attendance.period;
  if (attendance.period === 'daily') return `${kind} — ${formatDay(attendance.label)}`;
  if (attendance.period === 'monthly') return `${kind} — ${formatMonth(attendance.label)}`;
  return `${kind} — ${attendance.label}`;
}

const ATTENDANCE_COLUMNS: Column<AttendanceDay>[] = [
  {
    key: 'date',
    header: 'Date',
    primary: true,
    cell: (row) => <span className="whitespace-nowrap">{formatDay(row.attendance_date)}</span>,
  },
  { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
  {
    key: 'late',
    header: 'Late by',
    numeric: true,
    cell: (row) => (row.status === 'late' && row.late_minutes ? `${row.late_minutes} min` : NONE),
  },
  { key: 'remarks', header: 'Remarks', cell: (row) => row.remarks ?? NONE },
];

/**
 * The percentage, the four counts behind it, and the register day by day.
 *
 * The percentage is the server's and is never recomputed here: `mine()` runs the school's own
 * `report()` narrowed to this student, so the figure a family reads is the figure the school's
 * Attendance report gives for the same child and period. The hint states its definition, because §16
 * does not and a reader cannot guess whether leave counts against them.
 */
export function AttendanceSummary({ block, caption }: { block: AttendanceBlock; caption: string }) {
  return (
    <>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <MetricCard
          label="Attendance"
          value={block.percentage === null ? '—' : `${block.percentage.toFixed(2)}%`}
          hint={
            block.percentage === null
              ? 'Nothing was marked in this period, so there is no rate yet — which is not the same as 0%.'
              : `Present or late on ${COUNT.format(block.attended)} of ${COUNT.format(block.marked)} marked days. Leave counts as marked, not attended.`
          }
        />
        {STATUSES.map((status) => (
          <MetricCard key={status} label={status} value={COUNT.format(block.counts[status] ?? 0)} />
        ))}
      </dl>

      <div className="mt-4">
        {block.records.length === 0 ? (
          <EmptyNotice icon="calendar">No attendance was marked in this period.</EmptyNotice>
        ) : (
          <DataTable columns={ATTENDANCE_COLUMNS} rows={block.records} rowKey={(row) => row.id} caption={caption} />
        )}
      </div>
    </>
  );
}

/* ─────────────────────────────── fees ─────────────────────────────── */

/**
 * One `student_fees` row, as `fees.service.js mine()` sends it: the named columns of
 * `SELF_FEE_ATTRIBUTES` — what the family owes and paid, and when — never the office's working fields.
 * Only what this screen shows is declared. The money columns are `DECIMAL(14,2)` and arrive as numbers
 * (`decimalNumbers: true` — `lib/money.ts` records the measurement).
 */
export interface SelfFee {
  id: number;
  component: string;
  title: string;
  /** `DATEONLY`: the first day of the month a recurring fee covers; null for a one-off. */
  period_month: string | null;
  currency: string;
  amount: number;
  discount_amount: number;
  fine_amount: number;
  /** amount − discount + fine: what was charged, before any payment. */
  net_amount: number;
  paid_amount: number;
  /** SRS §17's Pending Fee — `max(0, net − paid)`, stored by the service. */
  pending_amount: number;
  due_date: string;
  status: string;
}

/** One `fee_payments` row — a receipt, named columns only (`SELF_PAYMENT_ATTRIBUTES`): no stored path, no collector. */
export interface SelfFeePayment {
  id: number;
  student_fee_id: number;
  receipt_number: string;
  currency: string;
  amount: number;
  method: string;
  reference: string | null;
  /** `DATE` — an instant — so it is shown as the viewer's day. */
  paid_at: string;
}

/** `GET /fees/mine`, one per student inside `{ students }`. */
export interface FeesBlock {
  student: SelfHead;
  fees: SelfFee[];
  payments: SelfFeePayment[];
  /** The pending total per currency, summed by the server in minor units. Never summed across currencies. */
  outstanding: { currency: string; amount: number }[];
}

const FEE_COLUMNS: Column<SelfFee>[] = [
  {
    key: 'fee',
    header: 'Fee',
    primary: true,
    cell: (row) => (
      <>
        <span className="font-medium">{row.title}</span>
        <span className="block text-xs capitalize text-muted-soft">
          {spell(row.component)}
          {row.period_month ? ` · ${formatMonth(row.period_month)}` : ''}
        </span>
      </>
    ),
  },
  { key: 'due', header: 'Due', cell: (row) => <span className="whitespace-nowrap">{formatDay(row.due_date)}</span> },
  {
    key: 'charged',
    header: 'Charged',
    numeric: true,
    /*
     * `net_amount`, with what made it differ from the fee's own amount beneath — a fine a family did
     * not know about is the first thing they will ask the school about.
     */
    cell: (row) => (
      <span className="whitespace-nowrap">
        {formatAmountWithCode(row.net_amount, row.currency)}
        {row.discount_amount > 0 ? (
          <span className="block text-xs text-muted-soft">discount {formatAmountWithCode(row.discount_amount, row.currency)}</span>
        ) : null}
        {row.fine_amount > 0 ? (
          <span className="block text-xs text-muted-soft">fine {formatAmountWithCode(row.fine_amount, row.currency)}</span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'paid',
    header: 'Paid',
    numeric: true,
    cell: (row) => <span className="whitespace-nowrap">{formatAmountWithCode(row.paid_amount, row.currency)}</span>,
  },
  {
    key: 'pending',
    header: 'Pending',
    numeric: true,
    cell: (row) => (
      <span className={`whitespace-nowrap ${row.pending_amount > 0 ? 'font-medium' : 'text-muted-soft'}`}>
        {formatAmountWithCode(row.pending_amount, row.currency)}
      </span>
    ),
  },
  { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
];

/**
 * Where a family's money stands: the pending total per currency, every fee with what is paid and
 * pending, and the receipts.
 *
 * Nothing is added up here. The outstanding figure is the server's — `mine()` sums `pending_amount` in
 * minor units, per currency — because `lib/money.ts` keeps arithmetic on money off the client, and a
 * school charging in two currencies must never have them added into one number.
 *
 * `headed` says whether a `StudentHeading` sits above the block: its two sections are then `h3`s under
 * it, and `h2`s directly under the page title when a student reads their own fees with no heading.
 */
export function FeesSummary({ block, who, headed = true }: { block: FeesBlock; who: string; headed?: boolean }) {
  const level = headed ? 3 : 2;
  /* A receipt names its fee by id; the fee rows are all here (no status or session filter is sent). */
  const feeTitle = new Map(block.fees.map((fee) => [fee.id, fee.title]));

  const paymentColumns: Column<SelfFeePayment>[] = [
    {
      key: 'receipt',
      header: 'Receipt',
      primary: true,
      cell: (row) => <code className="text-xs">{row.receipt_number}</code>,
    },
    { key: 'paid_at', header: 'Paid on', cell: (row) => formatInstantDay(row.paid_at) ?? NONE },
    { key: 'fee', header: 'For', cell: (row) => feeTitle.get(row.student_fee_id) ?? NONE },
    { key: 'method', header: 'Method', cell: (row) => <span className="capitalize">{spell(row.method)}</span> },
    { key: 'reference', header: 'Reference', cell: (row) => row.reference ?? NONE },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      cell: (row) => <span className="whitespace-nowrap">{formatAmountWithCode(row.amount, row.currency)}</span>,
    },
  ];

  return (
    <>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {block.outstanding.length === 0 ? (
          <MetricCard label="Outstanding" value="—" hint="No fee has been charged yet." />
        ) : (
          block.outstanding.map((row) => (
            <MetricCard
              key={row.currency}
              label={block.outstanding.length > 1 ? `Outstanding in ${row.currency}` : 'Outstanding'}
              value={formatAmountWithCode(row.amount, row.currency)}
              hint={
                block.outstanding.length > 1
                  ? `${row.amount > 0 ? 'Still to pay on' : 'Nothing left to pay on'} the ${row.currency} fees below.`
                  : row.amount > 0
                    ? 'Still to pay across the fees below.'
                    : 'Nothing is left to pay on the fees below.'
              }
            />
          ))
        )}
      </dl>

      <Section title="Fees" level={level}>
        {block.fees.length === 0 ? (
          <EmptyNotice icon="wallet">No fee has been charged to {who} yet.</EmptyNotice>
        ) : (
          <DataTable columns={FEE_COLUMNS} rows={block.fees} rowKey={(row) => row.id} caption={`Fees charged to ${who}`} />
        )}
      </Section>

      <Section title="Receipts" level={level}>
        {block.payments.length === 0 ? (
          <EmptyNotice icon="receipt">No payment has been recorded for {who} yet.</EmptyNotice>
        ) : (
          <DataTable
            columns={paymentColumns}
            rows={block.payments}
            rowKey={(row) => row.id}
            caption={`Receipts for ${who}`}
          />
        )}
      </Section>
    </>
  );
}

function Section({ title, level, children }: { title: string; level: 2 | 3; children: ReactNode }) {
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <section className="mt-6">
      <Heading className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted">{title}</Heading>
      {children}
    </section>
  );
}

/* ─────────────────────────────── the record ─────────────────────────────── */

/**
 * `GET /students/mine` — `students.service.js SELF_ATTRIBUTES` through `present()`: the record without
 * the office's working notes (`notes`, `metadata`, `leaving_reason`) and with `photo_path` replaced by
 * `has_photo`. `admission_session_id` is sent as a bare id with no name joined, so it is not shown.
 */
export interface SelfRecord extends SelfHead {
  admission_number: string | null;
  /** `DATEONLY`, NOT NULL. */
  admission_date: string;
  gender: string | null;
  date_of_birth: string | null;
  blood_group: string | null;
  religion: string | null;
  nationality: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  guardian_relation: string | null;
  emergency_contact: string | null;
  /** Three `DATE`s — instants — set by FR-STUDENT-002's promotion, transfer and leaving. */
  promoted_at: string | null;
  transferred_at: string | null;
  left_at: string | null;
  transfer_to: string | null;
  uses_transport: boolean;
  has_photo: boolean;
}

type Fact = [label: string, value: ReactNode];

function FactGroup({ title, facts }: { title: string; facts: Fact[] }) {
  return (
    <section className="surface p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">{title}</h3>
      <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-4 gap-y-2 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 break-words text-ink">{value ?? NONE}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The record, grouped as FR-STUDENT-001's admission form groups it.
 *
 * Every field is shown even when empty, as a dash: a family checking the record needs to see that the
 * school holds no emergency contact, not to wonder whether this screen forgot the row. The movement
 * group is the exception — promotion, transfer and leaving are events most records never have.
 *
 * The photo is named, not drawn. `GET /students/:id/photo` requires `students.view`, which neither a
 * student nor a parent holds, so the file cannot be fetched from here.
 */
export function RecordView({ record }: { record: SelfRecord }) {
  const events: Fact[] = [
    ['Promoted', formatInstantDay(record.promoted_at)],
    ['Transferred', formatInstantDay(record.transferred_at)],
    ['Transferred to', record.transfer_to],
    ['Left', formatInstantDay(record.left_at)],
  ];
  const movement = events.filter(([, value]) => value);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <FactGroup
        title="Enrolment"
        facts={[
          ['Student ID', <code key="id" className="text-xs">{record.student_id}</code>],
          ['Status', <StatusBadge key="status" status={record.status} />],
          ['Class', record.class?.name ?? null],
          ['Section', record.section?.name ?? null],
          ['Roll number', record.roll_number],
          ['Academic session', record.academicSession?.name ?? null],
          ['Admission number', record.admission_number],
          ['Admitted', formatDay(record.admission_date)],
          ['Uses transport', record.uses_transport ? 'Yes' : 'No'],
        ]}
      />
      <FactGroup
        title="Personal"
        facts={[
          ['Name', nameOf(record)],
          ['Gender', record.gender ? <span className="capitalize">{spell(record.gender)}</span> : null],
          ['Date of birth', record.date_of_birth ? formatDay(record.date_of_birth) : null],
          ['Blood group', record.blood_group],
          ['Religion', record.religion],
          ['Nationality', record.nationality],
          ['Photo', record.has_photo ? 'On file with the school' : 'None on file'],
        ]}
      />
      <FactGroup
        title="Contact"
        facts={[
          ['Email', record.email],
          ['Phone', record.phone],
          ['Address', record.address],
          ['City', record.city],
        ]}
      />
      <FactGroup
        title="Guardian"
        facts={[
          ['Name', record.guardian_name],
          ['Relation', record.guardian_relation],
          ['Phone', record.guardian_phone],
          ['Emergency contact', record.emergency_contact],
        ]}
      />
      {movement.length > 0 ? <FactGroup title="Movement" facts={movement} /> : null}
    </div>
  );
}

/* ─────────────────────────────── the class week ─────────────────────────────── */

/**
 * One `timetables` row with the four associations `timetable.service.js INCLUDES` joins. Three of the
 * foreign keys are nullable and the joins are LEFT JOINs, so three of the four can be null.
 */
export interface WeekEntry {
  id: number;
  class_id: number;
  section_id: number | null;
  day_of_week: string;
  period_number: number;
  period_label: string | null;
  /** `TIME`, always read back as `HH:MM:SS` (`timetable.validation.js` explains why). */
  start_time: string;
  end_time: string;
  room: string | null;
  is_break: boolean;
  class: { id: number; name: string } | null;
  section: { id: number; name: string } | null;
  subject: { id: number; name: string; code: string | null } | null;
  teacher: { id: number; first_name: string; last_name: string | null } | null;
}

/** The `day_of_week` ENUM in its declared order, which is the order MySQL sorts it in. */
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** `HH:MM:SS` → `HH:MM`; anything else (a `TIME` can exceed 24 hours) is shown whole. */
function clock(value: string): string {
  return /^\d{2}:\d{2}:\d{2}$/.test(value) ? value.slice(0, 5) : value;
}

function dayLabel(day: string): string {
  return day.charAt(0).toUpperCase() + day.slice(1);
}

/**
 * One slot of a class's week: the subject, then the section and teacher, then the clock and room. A
 * break says so; a lesson whose subject was deleted from under it (`SET NULL`) says that rather than
 * going blank — the school timetable screen's rules.
 */
function Slot({ entry }: { entry: WeekEntry }) {
  const teacher = entry.teacher ? nameOf(entry.teacher) : null;
  return (
    <div>
      <p className="font-medium text-ink">
        {entry.is_break ? (
          <span className="text-muted">Break</span>
        ) : entry.subject ? (
          entry.subject.name
        ) : (
          <span className="text-muted-soft">No subject</span>
        )}
        {entry.period_label ? <span className="font-normal text-muted"> · {entry.period_label}</span> : null}
      </p>
      <p className="text-xs text-muted">
        {[entry.section ? entry.section.name : 'whole class', teacher].filter(Boolean).join(' · ')}
      </p>
      <p className="text-xs tabular-nums text-muted-soft">
        {clock(entry.start_time)}–{clock(entry.end_time)}
        {entry.room ? ` · ${entry.room}` : ''}
      </p>
    </div>
  );
}

/**
 * A week laid out as days × periods — the school timetable screen's `WeekGrid`, read-only.
 *
 * Only the days that hold an entry get a column, in the ENUM's order, and the rows are the period
 * numbers that appear: `period_number` is what the conflict checks key on and the clock is descriptive,
 * so a row is a period and each entry carries its own times. A blank cell is a free period. Below `md`
 * it becomes one card per day, the rule `DataTable` keeps: seven columns on a phone are a scrollbar.
 */
export function WeekGrid({ entries, caption }: { entries: WeekEntry[]; caption: string }) {
  const days = WEEKDAYS.filter((day) => entries.some((entry) => entry.day_of_week === day));
  const periods = [...new Set(entries.map((entry) => entry.period_number))].sort((a, b) => a - b);
  /* Every entry in one `(day, period)` — more than one where sections of a class differ. */
  const slots = new Map<string, WeekEntry[]>();
  for (const entry of entries) {
    const key = `${entry.day_of_week}|${entry.period_number}`;
    slots.set(key, [...(slots.get(key) ?? []), entry]);
  }
  const slot = (day: string, period: number) => slots.get(`${day}|${period}`) ?? [];

  return (
    <>
      <div className="table-scroll surface hidden md:block" tabIndex={0} role="region" aria-label={caption}>
        <table className="data-table w-full min-w-max text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
                Period
              </th>
              {days.map((day) => (
                <th
                  key={day}
                  scope="col"
                  className="px-4 py-2.5 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-muted"
                >
                  {dayLabel(day)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-soft">
            {periods.map((period) => (
              <tr key={period}>
                <th scope="row" className="px-4 py-3 text-left align-top font-semibold tabular-nums text-ink">
                  {period}
                </th>
                {days.map((day) => (
                  <td key={day} className="px-4 py-3 align-top">
                    {/* The width bound sits on a block: `max-width` on a table cell is undefined in CSS 2.1. */}
                    <div className="max-w-56">
                      {slot(day, period).length === 0 ? (
                        <>
                          <span aria-hidden className="text-muted-soft">—</span>
                          <span className="sr-only">Free period</span>
                        </>
                      ) : (
                        <ul className="space-y-2.5">
                          {slot(day, period).map((entry) => (
                            <li key={entry.id}>
                              <Slot entry={entry} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden" aria-label={caption}>
        {days.map((day) => (
          <li key={day} className="surface p-3.5">
            <p className="text-sm font-semibold text-ink">{dayLabel(day)}</p>
            <ol className="mt-2.5 space-y-2.5">
              {periods
                .filter((period) => slot(day, period).length > 0)
                .map((period) => (
                  <li key={period} className="flex gap-3">
                    <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-soft">
                      <span className="sr-only">Period </span>
                      {period}
                    </span>
                    <ul className="min-w-0 flex-1 space-y-2">
                      {slot(day, period).map((entry) => (
                        <li key={entry.id}>
                          <Slot entry={entry} />
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
            </ol>
          </li>
        ))}
      </ul>
    </>
  );
}
