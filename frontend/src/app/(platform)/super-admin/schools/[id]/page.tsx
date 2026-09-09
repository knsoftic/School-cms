'use client';

/**
 * One school — SRS §9.2, FR-SADMIN-003 through FR-SADMIN-007, and the six write routes the module
 * had mounted with no caller.
 *
 * `PATCH /schools/:id` (edit), `POST /:id/activate`, `/suspend`, `/archive` (the status lifecycle),
 * `DELETE /:id` (a soft delete) and `PUT /:id/principal`. Without them the Schools screen was a
 * directory: a school could be created and then never corrected, never suspended when it stopped
 * paying, never archived, and never given the Principal that FR-SADMIN-007 requires.
 *
 * ## Four permissions, not one
 *
 * `schools.manage` edits, `schools.status` activates and suspends, `schools.archive` archives **and
 * deletes**, `schools.assign_principal` links the Principal. They are four keys in
 * `config/permissions.js` and an operator may hold any subset, so each control is gated on its own.
 * All six routes also carry `requirePlatformScope()`, which `can()` cannot see — an organization-
 * scoped account holding the permission is refused by the API with `PLATFORM_SCOPE_REQUIRED`, and
 * `RefusalNotice` explains that rather than a toast saying "failed".
 *
 * ## Archive and delete are different things and are deliberately not adjacent
 *
 * Archiving sets a status and keeps the row. Deleting is a **soft delete** — `school.destroy()` on a
 * paranoid model — so the row survives in the database and disappears from every read the product
 * makes. From the operator's side that is indistinguishable from removal, and the copy says so
 * rather than claiming the data is gone or implying it is retrievable from this screen. Delete sits
 * apart from the lifecycle row, in its own bordered block, because a button beside "Archive" that
 * does something much larger is a button pressed by mistake.
 *
 * ## The Principal must already exist, and this screen cannot create one
 *
 * `assignPrincipal()` refuses a user whose role is not `principal`, and refuses one belonging to a
 * different school. So the picker lists `GET /principals?school_id=` — the principals of *this*
 * school — and when there are none it says where they are created rather than rendering an empty
 * select that reads as a fault.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { EXPLAINED_CODES, useCollection } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import {
  Field,
  FormGrid,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
} from '@/components/form';
import { Modal } from '@/components/overlay';
import { TabPanel, Tabs, useActiveTab } from '@/components/tabs';
import { useToast } from '@/components/toast';
import {
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

const TABS = [
  { key: 'details', label: 'Details' },
  { key: 'principal', label: 'Principal' },
];

/** `GET /schools/:id` — the `schools` columns plus the two associations `DETAIL_INCLUDE` loads. */
interface SchoolDetail {
  id: number;
  name: string;
  code: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  status: string;
  principal_id: number | null;
  organization?: { id: number; name: string; code: string; status: string } | null;
  principal?: { id: number; name: string; email: string; status: string } | null;
}

/** One row of `GET /principals`. */
interface PrincipalOption {
  id: number;
  name: string;
  email: string;
  status: string;
}

interface FormValues {
  name: string;
  code: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  country: string;
}

function toValues(school: SchoolDetail): FormValues {
  return {
    name: school.name,
    code: school.code,
    email: school.email ?? '',
    phone: school.phone ?? '',
    address: school.address ?? '',
    city: school.city ?? '',
    state: school.state ?? '',
    country: school.country ?? '',
  };
}

/**
 * The three status transitions plus the delete, with the words each one needs.
 *
 * Written as a table rather than four blocks for the reason `planLifecycle.tsx` gives: three of the
 * four are the same dialog with different copy, and the copy is the part that matters — "suspend"
 * and "archive" do genuinely different things to a school that is still paying.
 */
const LIFECYCLE: Record<
  string,
  { label: string; title: (name: string) => string; description: string; confirm: string; busy: string; tone: 'primary' | 'danger'; reason: boolean }
> = {
  activate: {
    label: 'Activate',
    title: (name) => `Activate ${name}?`,
    description:
      'The school and its users can sign in and work again. Nothing about its subscription changes — if that has lapsed, activating the school does not renew it.',
    confirm: 'Activate school',
    busy: 'Activating…',
    tone: 'primary',
    reason: false,
  },
  suspend: {
    label: 'Suspend',
    title: (name) => `Suspend ${name}?`,
    description:
      'Everybody at the school loses access immediately, including its Principal. The data is untouched and the subscription keeps running — this is an administrative stop, not a cancellation.',
    confirm: 'Suspend school',
    busy: 'Suspending…',
    tone: 'danger',
    reason: true,
  },
  archive: {
    label: 'Archive',
    title: (name) => `Archive ${name}?`,
    description:
      'The school is kept for reference and stops being active. Nothing is deleted, and it still appears in this list under the archived filter.',
    confirm: 'Archive school',
    busy: 'Archiving…',
    tone: 'danger',
    reason: true,
  },
};

export default function SchoolDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : null;

  const { can } = useAuth();
  const { success } = useToast();
  const [tab, setTab] = useActiveTab(TABS);

  const [school, setSchool] = useState<SchoolDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!id) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setRefusal(null);

    (async () => {
      try {
        const result = await api.get<{ school: SchoolDetail }>(`/schools/${id}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSchool(result.school);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError) {
          setLoadError(caught.message);
        } else if ((caught as Error)?.name !== 'AbortError') {
          setLoadError('Could not reach the server. Check your connection and try again.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [id, nonce]);

  /* ── the edit form ── */
  const [values, setValues] = useState<FormValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (school) setValues(toValues(school));
  }, [school]);

  /* ── the lifecycle dialogs ── */
  const [pending, setPending] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /* ── the delete confirmation, which asks the operator to type the code ── */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typedCode, setTypedCode] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /* ── the principal picker ── */
  const principals = useCollection<PrincipalOption>(
    '/principals',
    useMemo(() => (school ? { school_id: school.id, limit: 100 } : {}), [school])
  );
  const [principalId, setPrincipalId] = useState('');
  const [principalBusy, setPrincipalBusy] = useState(false);
  const [principalError, setPrincipalError] = useState<string | null>(null);

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (loadError) return <ErrorNotice message={loadError} onRetry={reload} />;
  if (loading || !school || !values) return <LoadingBlock />;

  /*
   * A non-null local, because the guard above narrows `school` for the render and **not** inside the
   * async handlers below: each closes over the state variable, whose type is still nullable at the
   * point the closure is created. Capturing it here is the narrowing the closures cannot do for
   * themselves, and it also pins the record the request was started against.
   */
  const record = school;

  const canEdit = can('schools.manage');
  const canStatus = can('schools.status');
  const canArchive = can('schools.archive');
  const canAssign = can('schools.assign_principal');

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((current) => (current ? { ...current, [key]: value } : current));
  }

  const base = toValues(record);
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(base) as (keyof FormValues)[]) {
    if (values[key] !== base[key]) changed[key] = values[key].trim();
  }
  const nothingChanged = Object.keys(changed).length === 0;

  async function save() {
    if (saving || nothingChanged) return;
    setSaving(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const result = await api.patch<{ school: SchoolDetail }>(`/schools/${record.id}`, changed);
      setSchool(result.school);
      success('School updated');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        setFormError(caught.bannerFor(Object.keys(base)));
      } else {
        setFormError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  /*
   * The three transitions, written out rather than built from `pending`.
   *
   * `verify-frontend.js` matches `api.<method>(` followed immediately by the path literal, so a URL
   * assembled from the action name is invisible to the check that exists to catch a route with no
   * caller — the trap the subscription screen recorded after hitting it twice.
   */
  async function runTransition() {
    if (!pending || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    const body = reason.trim() ? { reason: reason.trim() } : {};
    try {
      const result =
        pending === 'activate'
          ? await api.post<{ school: SchoolDetail }>(`/schools/${record.id}/activate`, {})
          : pending === 'suspend'
            ? await api.post<{ school: SchoolDetail }>(`/schools/${record.id}/suspend`, body)
            : await api.post<{ school: SchoolDetail }>(`/schools/${record.id}/archive`, body);
      setSchool(result.school);
      success(`${LIFECYCLE[pending].label} applied`, `${record.name} is now ${result.school.status}.`);
      setPending(null);
      setReason('');
    } catch (caught) {
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setActionBusy(false);
    }
  }

  async function removeSchool() {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.delete(`/schools/${record.id}`);
      success('School deleted', `${record.name} no longer appears anywhere in the product.`);
      /* Nothing here left to show, so back to the list rather than an empty detail screen. */
      window.location.href = '/super-admin/schools';
    } catch (caught) {
      setDeleteError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
      setDeleteBusy(false);
    }
  }

  async function assignPrincipal() {
    if (!principalId || principalBusy) return;
    setPrincipalBusy(true);
    setPrincipalError(null);
    try {
      const result = await api.put<{ school: SchoolDetail }>(`/schools/${record.id}/principal`, {
        user_id: Number(principalId),
      });
      setSchool(result.school);
      success('Principal assigned');
      setPrincipalId('');
    } catch (caught) {
      setPrincipalError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setPrincipalBusy(false);
    }
  }

  /* Which transitions make sense from here. The API is the authority; this only hides the absurd. */
  const offered: string[] = [];
  if (canStatus && record.status !== 'active') offered.push('activate');
  if (canStatus && record.status === 'active') offered.push('suspend');
  if (canArchive && record.status !== 'archived') offered.push('archive');

  const copy = pending ? LIFECYCLE[pending] : null;

  return (
    <div>
      <PageHeader
        title={record.name}
        description={`${record.code}${record.organization ? ` · ${record.organization.name}` : ''}${
          record.city ? ` · ${record.city}` : ''
        }`}
        action={
          <Link href="/super-admin/schools" className="btn btn-secondary">
            Back to schools
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={record.status} />
        {record.principal ? (
          <span className="text-sm text-muted">Principal: {record.principal.name}</span>
        ) : (
          <span className="text-sm text-warn">No Principal assigned — FR-SADMIN-007</span>
        )}
      </div>

      {offered.length > 0 ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {offered.map((action) => (
            <button
              key={action}
              type="button"
              className={`btn ${LIFECYCLE[action].tone === 'danger' ? 'btn-danger' : 'btn-secondary'}`}
              onClick={() => {
                setPending(action);
                setReason('');
                setActionError(null);
              }}
            >
              {LIFECYCLE[action].label}
            </button>
          ))}
        </div>
      ) : null}

      <Tabs tabs={TABS} active={tab} onChange={setTab} label="School sections" />

      <TabPanel tabKey={tab}>
        {tab === 'details' ? (
          <div className="space-y-8">
            {!canEdit ? (
              <Notice tone="info">
                Editing a school needs the school management permission, which this account does not
                hold.
              </Notice>
            ) : (
              <FormSection
                title="Details"
                description="The school's own record. Its subscription, its people and its settings live elsewhere."
              >
                <form
                  className="space-y-4"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  {formError ? <Notice tone="error">{formError}</Notice> : null}

                  <FormGrid>
                    <Field
                      id="name"
                      label="Name"
                      required
                      value={values.name}
                      error={fieldErrors.name}
                      onChange={(event) => set('name', event.target.value)}
                    />
                    <Field
                      id="code"
                      label="Code"
                      required
                      value={values.code}
                      error={fieldErrors.code}
                      onChange={(event) => set('code', event.target.value)}
                      hint="Unique across the platform. Changing it does not change anything that already refers to this school by id."
                    />
                  </FormGrid>

                  <FormGrid>
                    <Field
                      id="email"
                      label="Email"
                      type="email"
                      value={values.email}
                      error={fieldErrors.email}
                      onChange={(event) => set('email', event.target.value)}
                    />
                    <Field
                      id="phone"
                      label="Phone"
                      value={values.phone}
                      error={fieldErrors.phone}
                      onChange={(event) => set('phone', event.target.value)}
                    />
                  </FormGrid>

                  <Field
                    id="address"
                    label="Address"
                    value={values.address}
                    error={fieldErrors.address}
                    onChange={(event) => set('address', event.target.value)}
                  />

                  <FormGrid>
                    <Field
                      id="city"
                      label="City"
                      value={values.city}
                      error={fieldErrors.city}
                      onChange={(event) => set('city', event.target.value)}
                    />
                    <Field
                      id="state"
                      label="State"
                      value={values.state}
                      error={fieldErrors.state}
                      onChange={(event) => set('state', event.target.value)}
                    />
                  </FormGrid>

                  <Field
                    id="country"
                    label="Country"
                    value={values.country}
                    error={fieldErrors.country}
                    onChange={(event) => set('country', event.target.value)}
                  />

                  <SubmitButton
                    busy={saving}
                    busyLabel="Saving…"
                    fullWidth={false}
                    disabled={nothingChanged}
                  >
                    Save changes
                  </SubmitButton>
                </form>
              </FormSection>
            )}

            {canArchive ? (
              <FormSection
                title="Delete this school"
                description="Separate from the lifecycle actions above, because it is a much larger thing than archiving."
              >
                <Notice tone="warn">
                  Deleting removes the school from every screen in the product — its students,
                  teachers, fees and results all become unreachable. The row itself is kept in the
                  database, so this is recoverable by someone with database access and by nobody
                  else. <strong>Archive instead</strong> if the school may come back.
                </Notice>
                <div className="mt-4">
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => {
                      setConfirmDelete(true);
                      setTypedCode('');
                      setDeleteError(null);
                    }}
                  >
                    Delete {record.name}
                  </button>
                </div>
              </FormSection>
            ) : null}
          </div>
        ) : (
          <FormSection
            title="Principal"
            description="FR-SADMIN-007. The Principal is a user of this school whose role is Principal — assigning one here does not create the account."
          >
            {!canAssign ? (
              <Notice tone="info">
                Assigning a Principal needs its own permission, which this account does not hold.
              </Notice>
            ) : (
              <form
                className="space-y-4"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void assignPrincipal();
                }}
              >
                {principalError ? <Notice tone="error">{principalError}</Notice> : null}

                {record.principal ? (
                  <Notice tone="info">
                    Currently <strong>{record.principal.name}</strong> ({record.principal.email}).
                    Choosing another replaces them; the previous Principal keeps their account.
                  </Notice>
                ) : null}

                {!principals.loading && principals.rows.length === 0 ? (
                  <Notice tone="warn">
                    This school has no Principal accounts to choose from. Create one on the{' '}
                    <Link
                      href="/super-admin/principals/new"
                      className="font-medium underline underline-offset-2"
                    >
                      Principals
                    </Link>{' '}
                    screen first — the API refuses a user whose role is anything else.
                  </Notice>
                ) : (
                  <SelectField
                    id="principal"
                    label="Principal"
                    required
                    value={principalId}
                    onChange={(event) => setPrincipalId(event.target.value)}
                    hint={
                      principals.loading
                        ? 'Loading this school’s Principal accounts…'
                        : 'Only users of this school whose role is Principal. The API refuses anything else.'
                    }
                  >
                    <option value="">Choose a Principal…</option>
                    {principals.rows.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name} ({option.email})
                      </option>
                    ))}
                  </SelectField>
                )}

                <SubmitButton
                  busy={principalBusy}
                  busyLabel="Assigning…"
                  fullWidth={false}
                  disabled={!principalId}
                >
                  Assign Principal
                </SubmitButton>
              </form>
            )}
          </FormSection>
        )}
      </TabPanel>

      <Modal
        open={pending !== null}
        onClose={() => {
          if (!actionBusy) setPending(null);
        }}
        title={copy ? copy.title(record.name) : ''}
        description={copy?.description}
        size="sm"
        busy={actionBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={actionBusy}
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
            <SubmitButton
              form="school-transition"
              busy={actionBusy}
              busyLabel={copy?.busy ?? 'Working…'}
              fullWidth={false}
            >
              {copy?.confirm ?? 'Apply'}
            </SubmitButton>
          </>
        }
      >
        <form
          id="school-transition"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void runTransition();
          }}
        >
          {actionError ? <Notice tone="error">{actionError}</Notice> : null}
          {copy?.reason ? (
            <TextAreaField
              id="transition-reason"
              label="Reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              hint="Recorded in the audit trail — SRS §29 gives the schools table no column for it, so this is the only record of why."
            />
          ) : (
            <p className="text-sm text-muted">
              Activation takes no reason: the API accepts an empty body and records the transition
              itself.
            </p>
          )}
        </form>
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => {
          if (!deleteBusy) setConfirmDelete(false);
        }}
        title={`Delete ${record.name}?`}
        description="This is not archiving. The school and everything belonging to it disappear from the product."
        size="sm"
        busy={deleteBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={deleteBusy}
              onClick={() => setConfirmDelete(false)}
            >
              Go back
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={deleteBusy || typedCode.trim() !== record.code}
              aria-busy={deleteBusy}
              onClick={() => void removeSchool()}
            >
              {deleteBusy ? 'Deleting…' : 'Delete school'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {deleteError ? <Notice tone="error">{deleteError}</Notice> : null}
          {/*
            * Typing the code, rather than a plain confirm button.
            *
            * Every other confirmation in this product is one click, and that is right for actions
            * that can be undone from the same screen. This one cannot: nothing in the product can
            * bring the school back. The friction is the point, and the code is used rather than the
            * name because it is short, unique and unambiguous to type.
            */}
          <Field
            id="confirm-code"
            label={`Type ${record.code} to confirm`}
            value={typedCode}
            onChange={(event) => setTypedCode(event.target.value)}
            hint="The school's code, exactly as it appears at the top of this screen."
          />
        </div>
      </Modal>
    </div>
  );
}
