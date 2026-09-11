'use client';

/**
 * One member of staff — SRS §15.4, FR-STAFF-001: *"User creates/manages staff records under the
 * categories Receptionist, Accountant, Librarian, and Other Staff."*
 *
 * `teachers/[id]` is the sibling and argues every shared decision — the read-only form for a reader,
 * salary shown only behind the manage key, the list's lifecycle dialogs reused for `is_active` and
 * `left_at`, the whole editable set sent with three reasoned exceptions, and the Login section that
 * answers "can they sign in?". §15.4 and §15.3 model a person on the payroll the same way, so only
 * what is different about *this* record is written down here.
 *
 * ## Why this screen exists
 *
 * `GET /staff/:id` had no caller, and `PATCH /staff/:id` had one, which sent `is_active` and
 * `left_at` and nothing else. "Manages staff records" was therefore "deactivates staff records": a
 * category entered wrongly, a designation that changed, a new phone number could not be recorded
 * anywhere. And `staff/new` had to warn that an account not linked on the way in could never be linked
 * afterwards, because there was no edit screen to link it from.
 *
 * ## What is different from a teacher
 *
 *   - **`category` is the defining field** and has no "not recorded": the column is NOT NULL and the
 *     schema a bare `valid(...STAFF_CATEGORIES)`. Changing it does not re-role a login already linked —
 *     a login keeps the role it was created with, and `users.validation.js` refuses `role_id` on an
 *     edit — so the hint says so rather than letting the two drift apart unannounced.
 *   - **No assignments.** §15.4 names none, and the router mounts no such read.
 *   - **A new login's role follows the category** (`ROLE_FOR_STAFF_CATEGORY`), exactly as on the list;
 *     the server refuses any other.
 *
 * `staff.view` is held by the Librarian — a role with no finance permission at all — which is the
 * whole of the case for rendering `salary` only behind `staff.manage`. The list's header makes it.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { splitApiErrors } from '@/lib/formErrors';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { useRowAction } from '@/lib/useRowAction';
import { DeactivateDialog, ReactivateDialog } from '@/components/deactivate';
import { ROLE_FOR_STAFF_CATEGORY } from '@/components/createLogin';
import {
  Field,
  FormActions,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
} from '@/components/form';
import { Icon } from '@/components/icon';
import { useToast } from '@/components/toast';
import { ErrorNotice, LoadingBlock, PageHeader, RefusalNotice, StatusBadge } from '@/components/table';
import {
  LinkedAccountField,
  LinkedLoginPanel,
  useLinkedAccount,
} from '@/app/(school)/school/settings/admins';

/** §15.4's four categories, mirroring `STAFF_CATEGORIES` in `constants.js`. */
const CATEGORIES = ['receptionist', 'accountant', 'librarian', 'other_staff'];

/** `GENDERS` in `constants.js`. */
const GENDERS = ['male', 'female', 'other'];

/** Every field this form renders. Anything else a 422 names goes to the banner. */
const FORM_FIELDS = new Set([
  'employee_id',
  'category',
  'first_name',
  'last_name',
  'designation',
  'joining_date',
  'salary',
  'qualification',
  'gender',
  'date_of_birth',
  'email',
  'phone',
  'address',
  'user_id',
  'notes',
  'metadata',
  'reason',
]);

const NETWORK_FAILURE = 'Could not reach the server. Check your connection and try again.';

/**
 * `GET /staff/:id` — the raw model row; `staff.controller.js` has no `present()`.
 *
 * `photo_path` is on the row and deliberately absent: §15.4 names no photo and the column has no writer.
 */
interface StaffMember {
  id: number;
  employee_id: string;
  category: string;
  first_name: string;
  last_name: string | null;
  gender: string | null;
  /** `DATEONLY`. */
  date_of_birth: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  qualification: string | null;
  designation: string | null;
  /** `DATEONLY`, NOT NULL. */
  joining_date: string;
  /** `money()`. Read only for a holder of `staff.manage`. */
  salary: number | null;
  is_active: boolean;
  /** `DATE` — an instant; `teachers/[id]` `leftOn()` explains the slice. */
  left_at: string | null;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  user_id: number | null;
}

const text = (value: string | null | undefined) => value ?? '';
const num = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value));
const orNull = (value: string) => (value.trim() ? value.trim() : null);

function metadataText(value: Record<string, unknown> | null): string {
  return value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : '';
}

/** `other_staff` → `Other staff`, as the Staff list renders the same enum. */
function humanise(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());
}

/** `staff.controller.js` `label()`. */
function fullName(row: StaffMember): string {
  return [row.first_name, row.last_name].filter(Boolean).join(' ');
}

function seed(row: StaffMember) {
  return {
    employee_id: row.employee_id,
    category: row.category,
    first_name: row.first_name,
    last_name: text(row.last_name),
    designation: text(row.designation),
    joining_date: row.joining_date.slice(0, 10),
    salary: num(row.salary),
    qualification: text(row.qualification),
    gender: text(row.gender),
    date_of_birth: row.date_of_birth ? row.date_of_birth.slice(0, 10) : '',
    email: text(row.email),
    phone: text(row.phone),
    address: text(row.address),
    user_id: num(row.user_id),
    notes: text(row.notes),
    metadata: metadataText(row.metadata),
    reason: '',
  };
}

type Values = ReturnType<typeof seed>;

export default function StaffDetailPage() {
  const params = useParams<{ id: string }>();
  const { can } = useAuth();
  const { success } = useToast();

  const staffId = params.id;
  /* `staff.manage` is what `PATCH /staff/:id` is mounted behind. */
  const canManage = can('staff.manage');

  const [member, setMember] = useState<StaffMember | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const [values, setValues] = useState<Values | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveRefusal, setSaveRefusal] = useState<Refusal | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setRefusal(null);

    (async () => {
      try {
        const body = await api.get<{ staff: StaffMember }>(`/staff/${staffId}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setMember(body.staff);
        setValues(seed(body.staff));
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          setLoadError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setLoadError(NETWORK_FAILURE);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [staffId, attempt]);

  /* After a login is created from the Login section — `teachers/[id]` `refreshTeacher()` gives the reason. */
  const refreshMember = useCallback(async () => {
    try {
      const body = await api.get<{ staff: StaffMember }>(`/staff/${staffId}`);
      setMember(body.staff);
      setValues((prev) => (prev ? { ...prev, user_id: num(body.staff.user_id) } : prev));
    } catch {
      /* The change itself succeeded and said so; the record catches up on the next visit. */
    }
  }, [staffId]);

  const { linked, reload: reloadLinked, replace: replaceLinked } = useLinkedAccount(member?.user_id ?? null);

  /*
   * The list's two lifecycle actions, keeping the server's copy — see `teachers/[id]`, which also gives
   * the reason `onDone` re-reads the login: under D19 the same PATCH switches a staff-role login off with
   * the record and back on with it (a suspended one stays suspended).
   */
  const deactivate = useRowAction<StaffMember, string | null>({
    perform: async (row, leftAt) => {
      const body = await api.patch<{ staff: StaffMember }>(`/staff/${row.id}`, { is_active: false, left_at: leftAt });
      setMember(body.staff);
    },
    success: (row) => `${fullName(row)} deactivated`,
    failure: 'Could not deactivate that record',
    onDone: reloadLinked,
  });

  const reactivate = useRowAction<StaffMember>({
    perform: async (row) => {
      const body = await api.patch<{ staff: StaffMember }>(`/staff/${row.id}`, { is_active: true, left_at: null });
      setMember(body.staff);
    },
    success: (row) => `${fullName(row)} reactivated`,
    failure: 'Could not reactivate that record',
    onDone: reloadLinked,
  });

  const set = (key: keyof Values) => (event: { target: { value: string } }) =>
    setValues((prev) => (prev ? { ...prev, [key]: event.target.value } : prev));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canManage || !member || !values) return;
    setSaving(true);
    setError(null);
    setSaveRefusal(null);
    setFieldErrors({});

    const stored = seed(member);
    const body: Record<string, unknown> = {
      employee_id: values.employee_id.trim(),
      category: values.category,
      first_name: values.first_name.trim(),
      last_name: orNull(values.last_name),
      designation: orNull(values.designation),
      joining_date: values.joining_date,
      salary: orNull(values.salary),
      qualification: orNull(values.qualification),
      /* A bare `valid(...GENDERS)` — no null, so blank is left out rather than sent. */
      ...(values.gender ? { gender: values.gender } : {}),
      date_of_birth: values.date_of_birth || null,
      email: orNull(values.email),
      phone: orNull(values.phone),
      address: orNull(values.address),
      notes: orNull(values.notes),
      reason: values.reason.trim() || undefined,
    };

    /* Only a link somebody moved: without `users.view` there is no picker, and '' would unlink. */
    if (values.user_id !== stored.user_id) {
      body.user_id = values.user_id ? Number(values.user_id) : null;
    }

    if (values.metadata !== stored.metadata) {
      if (!values.metadata.trim()) {
        body.metadata = null;
      } else {
        try {
          body.metadata = JSON.parse(values.metadata) as unknown;
        } catch {
          setFieldErrors({
            metadata: 'This is not valid JSON. A JSON object looks like {"desk": "front-office-2"}.',
          });
          focusFirstInvalidField();
          setSaving(false);
          return;
        }
      }
    }

    try {
      const result = await api.patch<{ staff: StaffMember }>(`/staff/${member.id}`, body);
      setMember(result.staff);
      setValues(seed(result.staff));
      success('Staff member updated');
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        setError(NETWORK_FAILURE);
        return;
      }
      if (EXPLAINED_CODES.has(caught.code)) {
        setSaveRefusal({ code: caught.code, message: caught.message });
        return;
      }
      /* `STAFF_EMPLOYEE_ID_TAKEN` and `STAFF_USER_TAKEN` send objects; their sentence reaches the banner. */
      const { perField, banner } = splitApiErrors(caught, FORM_FIELDS);
      setFieldErrors(perField);
      setError(banner);
      if (Object.keys(perField).length) focusFirstInvalidField();
    } finally {
      setSaving(false);
    }
  }

  if (refusal) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Staff member" />
        <RefusalNotice refusal={refusal} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Staff member" />
        <ErrorNotice message={loadError} onRetry={reload} />
      </div>
    );
  }

  if (loading || !member || !values) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Staff member" />
        <LoadingBlock />
      </div>
    );
  }

  const name = fullName(member);
  /* The UTC day of an instant written as a calendar day — `teachers/[id]` `leftOn()`. */
  const departed = member.left_at ? member.left_at.slice(0, 10) : null;
  const loginRole = ROLE_FOR_STAFF_CATEGORY[member.category];

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={name}
        description={`${humanise(member.category)}. Employee ID ${member.employee_id}. Joined ${member.joining_date.slice(0, 10)}.`}
        action={
          <Link href="/school/staff" className="btn btn-secondary">
            <Icon name="chevron-left" size={15} />
            All staff
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm text-muted">
        <StatusBadge status={member.is_active ? 'active' : 'inactive'} />
        <span>
          {member.is_active
            ? 'Counted against the staff allowance.'
            : departed
              ? `Left on ${departed}. Not counted against the staff allowance.`
              : 'Not counted against the staff allowance.'}
        </span>
        {canManage ? (
          <button
            type="button"
            onClick={() => (member.is_active ? deactivate.ask(member) : reactivate.ask(member))}
            className="btn btn-ghost btn-sm"
          >
            {member.is_active ? 'Deactivate' : 'Reactivate'}
          </button>
        ) : null}
      </div>

      {saveRefusal ? <RefusalNotice refusal={saveRefusal} /> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!canManage ? (
        <Notice tone="info">
          You can view this staff member but not change the record — editing staff needs a permission
          this account does not hold.
        </Notice>
      ) : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        <FormSection title="Employment" description="The role this person holds and the terms of their appointment.">
          <Field
            id="employee_id"
            label="Employee ID"
            required
            disabled={!canManage}
            maxLength={60}
            value={values.employee_id}
            onChange={set('employee_id')}
            error={fieldErrors.employee_id}
            hint="Unique within this school — the identifier on the payroll line or the ID card."
          />
          <SelectField
            id="category"
            label="Category"
            required
            disabled={!canManage}
            value={values.category}
            onChange={set('category')}
            error={fieldErrors.category}
            hint="SRS §15.4’s four categories. Changing it does not change the role of a login already linked — a login keeps the role it was created with."
          >
            {CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </SelectField>
          <Field
            id="first_name"
            label="First name"
            required
            disabled={!canManage}
            maxLength={90}
            value={values.first_name}
            onChange={set('first_name')}
            error={fieldErrors.first_name}
          />
          <Field
            id="last_name"
            label="Last name"
            disabled={!canManage}
            maxLength={90}
            value={values.last_name}
            onChange={set('last_name')}
            error={fieldErrors.last_name}
            hint="Optional — the column is nullable, and the Staff list joins the two names without leaving a gap."
          />
          <Field
            id="designation"
            label="Designation"
            disabled={!canManage}
            maxLength={120}
            value={values.designation}
            onChange={set('designation')}
            error={fieldErrors.designation}
            hint="The free-text job title that separates two people in the same category. Filtered by exact match, so keep the wording consistent between records."
          />
          <Field
            id="joining_date"
            label="Joining date"
            type="date"
            required
            disabled={!canManage}
            value={values.joining_date}
            onChange={set('joining_date')}
            error={fieldErrors.joining_date}
            hint="The date employment started. A plain date, with no time of day."
          />
          {canManage ? (
            <Field
              id="salary"
              label="Salary"
              type="text"
              inputMode="decimal"
              value={values.salary}
              onChange={set('salary')}
              error={fieldErrors.salary}
              hint="Two decimal places, digits only. Blank leaves it unrecorded rather than zero."
            />
          ) : null}
          <Field
            id="qualification"
            label="Qualification"
            disabled={!canManage}
            maxLength={255}
            value={values.qualification}
            onChange={set('qualification')}
            error={fieldErrors.qualification}
          />
        </FormSection>

        <FormSection title="Personal details" description="Profile information held on the staff record." columns={2}>
          <SelectField
            id="gender"
            label="Gender"
            disabled={!canManage}
            value={values.gender}
            onChange={set('gender')}
            error={fieldErrors.gender}
            hint="Once set this cannot be returned to “not recorded” — the schema accepts the three values and nothing else."
          >
            <option value="">Not recorded</option>
            {GENDERS.map((value) => (
              <option key={value} value={value}>
                {humanise(value)}
              </option>
            ))}
          </SelectField>
          <Field
            id="date_of_birth"
            label="Date of birth"
            type="date"
            disabled={!canManage}
            value={values.date_of_birth}
            onChange={set('date_of_birth')}
            error={fieldErrors.date_of_birth}
          />
        </FormSection>

        <FormSection title="Contact" description="How the school reaches this member of staff.">
          <Field
            id="email"
            label="Email"
            type="email"
            disabled={!canManage}
            maxLength={180}
            value={values.email}
            onChange={set('email')}
            error={fieldErrors.email}
            hint="Stored in lower case. This is the profile address, not the login — the login has its own, in the Login section below."
          />
          <Field
            id="phone"
            label="Phone"
            disabled={!canManage}
            maxLength={40}
            value={values.phone}
            onChange={set('phone')}
            error={fieldErrors.phone}
          />
          <Field
            id="address"
            label="Address"
            disabled={!canManage}
            maxLength={255}
            value={values.address}
            onChange={set('address')}
            error={fieldErrors.address}
          />
        </FormSection>

        {canManage ? (
          <FormSection title="Sign-in account" description="Which existing login is this person’s.">
            <LinkedAccountField
              value={values.user_id}
              onChange={(next) => setValues((prev) => (prev ? { ...prev, user_id: next } : prev))}
              error={fieldErrors.user_id}
              stored={linked.state === 'ready' ? linked.account : null}
              noun="staff record"
            />
          </FormSection>
        ) : null}

        <FormSection title="Internal notes" description="Kept on the record.">
          <TextAreaField
            id="notes"
            label="Notes"
            rows={4}
            disabled={!canManage}
            maxLength={2000}
            value={values.notes}
            onChange={set('notes')}
            error={fieldErrors.notes}
          />
          <TextAreaField
            id="metadata"
            label="Metadata"
            rows={3}
            disabled={!canManage}
            value={values.metadata}
            onChange={set('metadata')}
            placeholder='{"desk": "front-office-2"}'
            error={fieldErrors.metadata}
            hint="A JSON object, for something outside the system that needs to find this record by a reference of its own. Clear it to remove it."
          />
          {canManage ? (
            <Field
              id="reason"
              label="Reason"
              maxLength={255}
              value={values.reason}
              onChange={set('reason')}
              error={fieldErrors.reason}
              hint="Recorded against this edit's audit entry rather than on the staff record. Optional."
            />
          ) : null}
        </FormSection>

        <FormActions cancelHref="/school/staff" cancelLabel="Back to staff">
          {canManage ? (
            <SubmitButton busy={saving} busyLabel="Saving…" fullWidth={false}>
              Save changes
            </SubmitButton>
          ) : null}
        </FormActions>
      </form>

      <LinkedLoginPanel
        noun="staff member"
        linked={linked}
        onRetry={reloadLinked}
        onStatusSaved={replaceLinked}
        createTarget={
          member.is_active && loginRole
            ? { role: loginRole, person: name, profileId: member.id, email: member.email }
            : null
        }
        onCreated={() => void refreshMember()}
      />

      <DeactivateDialog
        open={deactivate.target !== null}
        person={deactivate.target ? fullName(deactivate.target) : null}
        noun="staff member"
        allowance="staff allowance"
        busy={deactivate.busy}
        conflict={deactivate.conflict}
        onCancel={deactivate.cancel}
        onConfirm={(date) => deactivate.confirm(date)}
      />

      <ReactivateDialog
        open={reactivate.target !== null}
        person={reactivate.target ? fullName(reactivate.target) : null}
        noun="staff member"
        allowance="staff allowance"
        busy={reactivate.busy}
        conflict={reactivate.conflict}
        onCancel={reactivate.cancel}
        onConfirm={() => reactivate.confirm()}
      />
    </div>
  );
}
