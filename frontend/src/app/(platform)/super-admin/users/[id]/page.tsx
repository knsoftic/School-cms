'use client';

/**
 * One user account — SRS §29's access model, and four write routes that had no caller.
 *
 * `PATCH /users/:id` and `PUT /users/:id/permissions` here; `PATCH /roles/:id` and
 * `PUT /roles/:id/permissions` on the Roles tab, which lives here rather than on a screen of its own
 * because §33 names Users and does not name Roles, and because a role is what a user's permissions
 * start from — the two questions are asked in the same sitting.
 *
 * ## A user's permissions are two overrides, not a list
 *
 * `extra_permissions` grants beyond the role and `denied_permissions` takes away from it, and
 * `permissionService` resolves role + extra − denied on every request. So the editor is not "tick
 * what this user may do"; it is "what does this user have that the role does not, and what has been
 * taken away". Rendering it as one flat list would misrepresent where a permission comes from and
 * would silently freeze a role change out of the account: a user whose role later gains a key would
 * still hold it, and a flat editor would have written it as an override.
 *
 * Each key therefore shows three states — from the role, granted extra, denied — and the two arrays
 * are sent whole. `setPermissions` says why in its own header: a partial write is how two
 * administrators overwrite each other without either seeing it.
 *
 * ## Role permissions are platform-scoped and global
 *
 * `PUT /roles/:id/permissions` carries `requirePlatformScope()` because `role_permissions` has no
 * `school_id` — one row governs every school on the platform. Changing what "Teacher" means changes
 * it everywhere, and the tab says so before the first checkbox.
 *
 * `roles.validation.js` `update` accepts **labels only** — name and description. The four structural
 * columns (`slug`, `is_platform_role`, `is_school_role`, `is_system`) are not in the schema, so
 * `stripUnknown` drops them, because §5's eleven roles are fixed and a renamed slug would orphan every
 * grant keyed to it. (This used to name `level` and `scope`, which are not columns of `roles` at all,
 * and to say the four were refused rather than dropped.)
 *
 * ## What the API will refuse, said before the click rather than after it
 *
 * Three refusals are properties of the target, not of the input, so they are knowable up front:
 *
 *  - `users.service.assertNotSelf()` refuses a change to your **own** status or overrides with
 *    `SELF_MODIFICATION_DENIED` — the only super_admin suspending themselves would lock the platform
 *    out. Your own status select and override editor are read-only here, and say why.
 *  - `roles.service.setPermissions()` refuses to edit the `super_admin` role's grants with
 *    `ROLE_NOT_EDITABLE` — the seeder hard-syncs that role to the whole catalogue on every run, so an
 *    accepted edit would be silently undone. The matrix is read-only for that one role. This mirrors
 *    the service's own check on the same slug; it decides nothing the server does not already decide.
 *
 * ## A missing account, and a missing half
 *
 * `GET /users/:id` answers 404 `USER_NOT_FOUND` for an id outside the caller's scope, and 422 for one
 * that is not a number. Both used to show "Something went wrong" and a retry that could only fail
 * again; they are a not-found state now. The catalogue and the role are separate reads with their own
 * guards, and a failure of either used to be swallowed and then explained as a missing permission —
 * true for a refusal, false for a network error, and with no way to try again in either case. Each
 * now says which of the two it was, and offers a retry.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { splitApiErrors } from '@/lib/formErrors';
import { EXPLAINED_CODES } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import {
  Field,
  FormActions,
  FormGrid,
  FormSection,
  Notice,
  SelectField,
  SubmitButton,
  TextAreaField,
  humaniseFieldError,
} from '@/components/form';
import { TabPanel, Tabs, useActiveTab } from '@/components/tabs';
import { useToast } from '@/components/toast';
import {
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

const TABS = [
  { key: 'account', label: 'Account' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'role', label: 'Role' },
];

/** A school or organization as `users.service.present()` attaches it — four fields, not the row. */
interface TenantRef {
  id: number;
  name: string;
  code: string;
  status: string;
}

/**
 * `GET /users/:id`, as `presentWithPermissions()` builds it.
 *
 * The permission picture arrives as a **nested block**, not as the raw columns. `publicUser()`
 * excludes `extra_permissions` and `denied_permissions` deliberately, and this read adds them back
 * under `permissions` along with the role's own set and the resolved effective set. A first draft of
 * this file read `user.extra_permissions` — which is always `undefined` — and `verify-frontend.js`
 * caught it: that suite refuses any screen naming a column the API strips, and the reason it gives is
 * exactly this one.
 *
 * `permissions.role` is why no second request is made for the role's grants: the server has already
 * resolved them, and recomputing `role ∪ extra − denied` here would be a second implementation free
 * to disagree with the guard.
 *
 * `school` and `organization` are attached by `present()` when the account has them — a Super Admin
 * has neither, an Organization Admin only the second. They were on every response and never shown, so
 * the one screen about an account could not say where it lived.
 */
interface UserDetail {
  id: number;
  name: string;
  email: string;
  username: string;
  phone: string | null;
  status: string;
  locale: string | null;
  role: { id: number; slug: string; name: string };
  school?: TenantRef;
  organization?: TenantRef;
  permissions: {
    role: string[];
    extra: string[];
    denied: string[];
    effective: string[];
  };
}

/** `GET /users/permissions` — the 109 fixed keys, grouped as `config/permissions.js` groups them. */
interface PermissionGroup {
  group: string;
  permissions: { key: string; name: string; module: string | null }[];
}

interface RoleDetail {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  permissions: string[];
}

/** Where one key stands for one user. */
type Standing = 'role' | 'extra' | 'denied' | 'none';

const STATUSES = ['active', 'inactive', 'suspended', 'pending'];

/** The six columns `users.validation.js` `update` accepts, which are exactly this form's inputs. */
const ACCOUNT_FIELDS = ['name', 'email', 'username', 'phone', 'status', 'locale'] as const;

/** The two of them the column allows to be null; a cleared box clears these. */
const NULLABLE_FIELDS: ReadonlySet<string> = new Set(['phone', 'locale']);

/** The form's values, from a stored account — what the form shows after a load and after a save. */
function accountValues(user: UserDetail): Record<string, string> {
  return {
    name: user.name,
    email: user.email,
    username: user.username,
    phone: user.phone ?? '',
    status: user.status,
    locale: user.locale ?? '',
  };
}

/** A read that failed: a deliberate refusal, or anything else — the latter is worth retrying. */
interface ReadFailure {
  refused: boolean;
  message: string;
}

function failureOf(caught: unknown): ReadFailure | null {
  if (caught instanceof ApiError) {
    return { refused: EXPLAINED_CODES.has(caught.code), message: caught.message };
  }
  /* An abort is a replaced request, not a failure. */
  if ((caught as Error)?.name === 'AbortError') return null;
  return { refused: false, message: 'Could not reach the server. Check your connection and try again.' };
}

/**
 * A 404, or a 422 on the route parameter — the two ways `GET /users/:id` says there is no such
 * account. A 422 anywhere else is a real validation failure and stays an error.
 */
function isMissing(caught: ApiError): boolean {
  return (
    caught.status === 404
    || (caught.status === 422 && caught.details.some((detail) => detail.location === 'params'))
  );
}

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : null;

  const { can, profile } = useAuth();
  const { success, toast } = useToast();
  const [tab, setTab] = useActiveTab(TABS);

  const [user, setUser] = useState<UserDetail | null>(null);
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [role, setRole] = useState<RoleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [missing, setMissing] = useState(false);
  const [nonce, setNonce] = useState(0);

  /* the two secondary reads, each with its own failure and its own retry */
  const [catalogueFailure, setCatalogueFailure] = useState<ReadFailure | null>(null);
  const [catalogueNonce, setCatalogueNonce] = useState(0);
  const [roleFailure, setRoleFailure] = useState<ReadFailure | null>(null);
  const [roleNonce, setRoleNonce] = useState(0);

  /* account form */
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /* permission overrides */
  const [extra, setExtra] = useState<string[]>([]);
  const [denied, setDenied] = useState<string[]>([]);
  const [permBusy, setPermBusy] = useState(false);
  const [permError, setPermError] = useState<string | null>(null);

  /* role */
  const [roleName, setRoleName] = useState('');
  const [roleDescription, setRoleDescription] = useState('');
  const [roleKeys, setRoleKeys] = useState<string[]>([]);
  const [roleBusy, setRoleBusy] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [roleFieldErrors, setRoleFieldErrors] = useState<Record<string, string>>({});

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!id) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setRefusal(null);
    setMissing(false);

    (async () => {
      try {
        const account = await api.get<{ user: UserDetail }>(`/users/${id}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setUser(account.user);
        setValues(accountValues(account.user));
        setExtra(account.user.permissions?.extra ?? []);
        setDenied(account.user.permissions?.denied ?? []);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && EXPLAINED_CODES.has(caught.code)) {
          setRefusal({ code: caught.code, message: caught.message });
        } else if (caught instanceof ApiError && isMissing(caught)) {
          setMissing(true);
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

  /*
   * The catalogue and the role are read after the account rather than beside it, because both are
   * gated on keys the account read is not: `GET /users/permissions` needs `users.manage` or
   * `roles.view`, and `GET /roles/:id` needs `users.view` or `roles.view`. A `Promise.all` would fail
   * the whole screen for a reader who is entitled to the account alone.
   *
   * Keyed on the ids rather than on the account object, so re-reading the account after a save does
   * not re-read — and re-seed — either of them.
   */
  const loadedUserId = user?.id ?? null;
  const roleId = user?.role.id ?? null;

  useEffect(() => {
    if (loadedUserId === null) return undefined;
    const controller = new AbortController();
    setCatalogueFailure(null);

    (async () => {
      try {
        const catalogue = await api.get<{ groups: PermissionGroup[] }>('/users/permissions', {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setGroups(catalogue.groups);
      } catch (caught) {
        if (controller.signal.aborted) return;
        const failure = failureOf(caught);
        if (failure) setCatalogueFailure(failure);
      }
    })();

    return () => controller.abort();
  }, [loadedUserId, catalogueNonce]);

  useEffect(() => {
    if (roleId === null) return undefined;
    const controller = new AbortController();
    setRoleFailure(null);

    (async () => {
      try {
        const loaded = await api.get<{ role: RoleDetail }>(`/roles/${roleId}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setRole(loaded.role);
        setRoleName(loaded.role.name);
        setRoleDescription(loaded.role.description ?? '');
        setRoleKeys(loaded.role.permissions);
      } catch (caught) {
        if (controller.signal.aborted) return;
        const failure = failureOf(caught);
        if (failure) setRoleFailure(failure);
      }
    })();

    return () => controller.abort();
  }, [roleId, roleNonce]);

  /* The server's own answer for this user's role — see the `UserDetail` note. */
  const roleGrants = useMemo(() => new Set(user?.permissions?.role ?? []), [user]);

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (missing) {
    return (
      <div>
        <PageHeader
          title="User not found"
          action={
            <Link href="/super-admin/users" className="btn btn-secondary">
              Back to users
            </Link>
          }
        />
        <EmptyNotice
          icon="search"
          title="There is no account at this address"
          action={
            <Link href="/super-admin/users" className="btn btn-secondary">
              Back to users
            </Link>
          }
        >
          The link may be mistyped, or the account is outside what this account can see. The Users
          list shows every account that is.
        </EmptyNotice>
      </div>
    );
  }
  if (loadError) return <ErrorNotice message={loadError} onRetry={reload} />;
  if (loading || !user) return <LoadingBlock />;

  const record = user;
  const canManageUsers = can('users.manage');
  const canManageRoles = can('roles.manage');

  /* `assertNotSelf()` — see the header. Compared by id, the thing the service compares. */
  const isSelf = profile?.user.id === record.id;

  function standingOf(key: string): Standing {
    if (denied.includes(key)) return 'denied';
    if (extra.includes(key)) return 'extra';
    return roleGrants.has(key) ? 'role' : 'none';
  }

  /** Move a key between the three states the two arrays can express. */
  function setStanding(key: string, next: Standing) {
    setExtra((current) => (next === 'extra' ? [...new Set([...current, key])] : current.filter((k) => k !== key)));
    setDenied((current) => (next === 'denied' ? [...new Set([...current, key])] : current.filter((k) => k !== key)));
  }

  /*
   * What the PATCH carries, computed on every render so the button knows whether there is anything
   * to save. A blank **required** field is sent as `''` rather than skipped: it used to be dropped
   * without a word, and a form with nothing else changed then returned without a request — the save
   * button did nothing at all. Sent, the schema's `string.empty` comes back on the field
   * ("Name is required"). `phone` and `locale` are nullable, so blank clears them.
   */
  const accountBase = accountValues(record);
  const accountChanges: Record<string, string | null> = {};
  for (const key of ACCOUNT_FIELDS) {
    const now = values[key] ?? '';
    if (now === accountBase[key]) continue;
    const trimmed = now.trim();
    accountChanges[key] = trimmed === '' ? (NULLABLE_FIELDS.has(key) ? null : '') : trimmed;
  }
  const accountUnchanged = Object.keys(accountChanges).length === 0;

  async function saveAccount() {
    if (busy || accountUnchanged) return;

    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await api.patch<{ user: UserDetail; verificationEmailSent?: boolean }>(
        `/users/${record.id}`,
        accountChanges
      );
      setUser(result.user);
      /*
       * Re-seeded from what was stored, not left as typed. The server lowercases the email and the
       * username, so "Ayesha@School.pk" stayed in the box while the record said "ayesha@school.pk" —
       * and the form then counted that difference as an unsaved change forever.
       */
      setValues(accountValues(result.user));
      /*
       * `verificationEmailSent` is only present when the email changed: `true` when the message went,
       * `false` when the change committed but the send failed (the service logs it rather than
       * throwing). This used to key the sentence on whether an email had been *submitted*, so a
       * failed send was reported as a sent one.
       */
      if (result.verificationEmailSent === false) {
        toast(
          'warn',
          'Account updated',
          'The address was changed, but the verification email could not be sent. The account can request another from its own account menu.'
        );
      } else {
        success(
          'Account updated',
          result.verificationEmailSent ? 'A verification email has been sent to the new address.' : undefined
        );
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        /*
         * No `Array.isArray` guard: `ApiError` already normalises an object-shaped `details` (a 409's
         * `{ email }`) into `context`, so `fieldErrors()` is always safe and such a refusal's own
         * sentence reaches the banner through `bannerFor`.
         */
        setFieldErrors(caught.fieldErrors());
        setError(caught.bannerFor([...ACCOUNT_FIELDS]));
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function savePermissions() {
    if (permBusy || isSelf) return;
    setPermBusy(true);
    setPermError(null);
    try {
      /* Both arrays whole, always — a partial write is how two administrators overwrite each other. */
      const result = await api.put<{ user: UserDetail }>(`/users/${record.id}/permissions`, {
        extra_permissions: extra,
        denied_permissions: denied,
      });
      setUser(result.user);
      setExtra(result.user.permissions?.extra ?? []);
      setDenied(result.user.permissions?.denied ?? []);
      success('Permissions saved');
    } catch (caught) {
      setPermError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setPermBusy(false);
    }
  }

  const labelsUnchanged = role
    ? roleName === role.name && roleDescription === (role.description ?? '')
    : true;

  async function saveRoleLabels() {
    if (!role || roleBusy || labelsUnchanged) return;
    const changed: Record<string, unknown> = {};
    if (roleName !== role.name) changed.name = roleName.trim();
    if (roleDescription !== (role.description ?? '')) {
      changed.description = roleDescription.trim() === '' ? null : roleDescription.trim();
    }

    setRoleBusy(true);
    setRoleError(null);
    setRoleFieldErrors({});
    try {
      const result = await api.patch<{ role: RoleDetail }>(`/roles/${role.id}`, changed);
      setRole({ ...role, ...result.role });
      setRoleName(result.role.name);
      setRoleDescription(result.role.description ?? '');
      /* The header reads the role's name off the account; keep the two in step. */
      setUser((current) =>
        current ? { ...current, role: { ...current.role, name: result.role.name } } : current
      );
      success('Role updated');
    } catch (caught) {
      if (caught instanceof ApiError) {
        /*
         * A name under two characters is a 422 keyed `name`, whose top-level message is "Validation
         * failed" — which is all this form used to show. The two fields carry their own messages now,
         * reworded against the labels on screen: the inputs' ids are `role-name` and
         * `role-description`, so the field wrapper cannot match the server's `name` key by itself.
         */
        const { perField, banner } = splitApiErrors(caught, new Set(['name', 'description']));
        setRoleFieldErrors({
          ...(perField.name ? { name: humaniseFieldError(perField.name, 'name', 'Name') } : {}),
          ...(perField.description
            ? { description: humaniseFieldError(perField.description, 'description', 'Description') }
            : {}),
        });
        setRoleError(banner);
      } else {
        setRoleError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setRoleBusy(false);
    }
  }

  /* See the header: the service refuses this one role's grants, keyed on the same slug. */
  const roleLocked = role?.slug === 'super_admin';

  async function saveRolePermissions() {
    if (!role || roleBusy || roleLocked) return;
    setRoleBusy(true);
    setRoleError(null);
    try {
      /* The complete set, including an empty array to revoke all — the schema's own message. */
      const result = await api.put<{ role: RoleDetail }>(`/roles/${role.id}/permissions`, {
        permissions: roleKeys,
      });
      setRole(result.role);
      setRoleKeys(result.role.permissions);
      success('Role permissions saved', 'This applies to every user of this role, on every school.');
      /*
       * The user's own resolved set has changed with it, so the account is read again — and only the
       * account. This used to call `reload()`, which re-ran the whole load: the screen went back to a
       * skeleton and the account form and the override editor were re-seeded from the server,
       * discarding whatever had been changed on those tabs and not yet saved.
       */
      try {
        const fresh = await api.get<{ user: UserDetail }>(`/users/${record.id}`);
        setUser(fresh.user);
      } catch {
        /* The role save stands; the "from the role" labels catch up on the next visit. */
      }
    } catch (caught) {
      setRoleError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setRoleBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={record.name}
        description={`${record.email} · ${record.role.name}`}
        action={
          <Link href="/super-admin/users" className="btn btn-secondary">
            Back to users
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusBadge status={record.status} />
        {/*
          * Where the account lives — the same rule the Users list's tenant column follows: the school
          * when there is one, the organization for an Organization Admin, and neither for a platform
          * account, which is what both columns being null means.
          */}
        <span className="text-sm text-muted">
          {record.school ? (
            <>
              School:{' '}
              {can('schools.view') ? (
                <Link
                  href={`/super-admin/schools/${record.school.id}`}
                  className="text-ink underline-offset-2 hover:underline focus-visible:underline"
                >
                  {record.school.name}
                </Link>
              ) : (
                <span className="text-ink">{record.school.name}</span>
              )}
            </>
          ) : record.organization ? (
            <>
              Organization: <span className="text-ink">{record.organization.name}</span>
            </>
          ) : (
            'Platform account'
          )}
        </span>
        {/*
          * From the stored record, not the editor. This counted the Permissions tab's unsaved picks,
          * so the header announced overrides the account did not have.
          */}
        <span className="text-sm text-muted">
          {record.permissions.extra.length} granted beyond the role, {record.permissions.denied.length}{' '}
          taken away
        </span>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} label="User sections" />

      <TabPanel tabKey={tab}>
        {tab === 'account' ? (
          !canManageUsers ? (
            <Notice tone="info">
              Editing an account needs the user management permission, which this account does not
              hold.
            </Notice>
          ) : (
            <form
              className="max-w-2xl space-y-6"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void saveAccount();
              }}
            >
              {error ? <Notice tone="error">{error}</Notice> : null}

              <FormSection title="Account">
                <FormGrid>
                  <Field
                    id="name"
                    label="Name"
                    required
                    value={values.name ?? ''}
                    error={fieldErrors.name}
                    onChange={(event) => setValues((v) => ({ ...v, name: event.target.value }))}
                  />
                  <Field
                    id="username"
                    label="Username"
                    required
                    value={values.username ?? ''}
                    error={fieldErrors.username}
                    onChange={(event) => setValues((v) => ({ ...v, username: event.target.value }))}
                  />
                </FormGrid>

                <Field
                  id="email"
                  label="Email"
                  type="email"
                  required
                  value={values.email ?? ''}
                  error={fieldErrors.email}
                  onChange={(event) => setValues((v) => ({ ...v, email: event.target.value }))}
                  hint="Changing it sends a verification message to the new address; the account keeps working meanwhile."
                />

                <FormGrid>
                  <Field
                    id="phone"
                    label="Phone"
                    type="tel"
                    value={values.phone ?? ''}
                    error={fieldErrors.phone}
                    onChange={(event) => setValues((v) => ({ ...v, phone: event.target.value }))}
                  />
                  <SelectField
                    id="status"
                    label="Status"
                    value={values.status ?? ''}
                    error={fieldErrors.status}
                    disabled={isSelf}
                    onChange={(event) => setValues((v) => ({ ...v, status: event.target.value }))}
                    /*
                     * `LOGIN_ALLOWED_STATUSES` is `active` alone, so "a suspended account cannot sign
                     * in" was true and incomplete: inactive and pending are refused just the same.
                     */
                    hint={
                      isSelf
                        ? 'You cannot change your own status — another administrator has to, so nobody can lock themselves out.'
                        : 'Only an active account can sign in; inactive, suspended and pending are all refused. Nothing is deleted.'
                    }
                  >
                    {STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </SelectField>
                </FormGrid>

                <Field
                  id="locale"
                  label="Locale"
                  value={values.locale ?? ''}
                  error={fieldErrors.locale}
                  onChange={(event) => setValues((v) => ({ ...v, locale: event.target.value }))}
                  hint="A language tag such as en or ur. Blank uses the platform default."
                />

                <Notice tone="info">
                  {/*
                    * Neither is in `update`'s schema, so `stripUnknown` would drop either one from the
                    * request — not refuse it, as this note used to say. The reasons are the ones
                    * `users.validation.js` gives for leaving them out.
                    */}
                  The role and the password are not on this form. An account&apos;s role is fixed
                  when it is created, and a password is only ever changed by the account&apos;s owner,
                  through sign-in or the reset flow — saving here never changes either.
                </Notice>
              </FormSection>

              <FormActions>
                <SubmitButton busy={busy} busyLabel="Saving…" fullWidth={false} disabled={accountUnchanged}>
                  Save account
                </SubmitButton>
              </FormActions>
            </form>
          )
        ) : tab === 'permissions' ? (
          !canManageUsers ? (
            <Notice tone="info">
              Changing a user’s permissions needs the user management permission.
            </Notice>
          ) : catalogueFailure?.refused ? (
            <Notice tone="warn">
              The permission catalogue is not readable by this account — reading it needs the user
              management or role view permission. {catalogueFailure.message}
            </Notice>
          ) : catalogueFailure ? (
            <Notice tone="error">
              The permission catalogue could not be loaded: {catalogueFailure.message}{' '}
              <button
                type="button"
                onClick={() => setCatalogueNonce((n) => n + 1)}
                className="font-medium underline underline-offset-2"
              >
                Try again
              </button>
            </Notice>
          ) : groups.length === 0 ? (
            <LoadingBlock label="Loading the permission catalogue…" rows={3} />
          ) : (
            <div className="space-y-6">
              {permError ? <Notice tone="error">{permError}</Notice> : null}

              {isSelf ? (
                <Notice tone="info">
                  These are your own overrides, shown for reference. Nobody can change their own
                  permissions — another administrator has to — so the choices below are read-only.
                </Notice>
              ) : (
                <Notice tone="info">
                  A permission comes from the <strong>role</strong> unless this user overrides it.
                  Granting one adds it for this user alone; denying one takes it away even though the
                  role has it. Leaving a key alone means it follows the role — including any later
                  change to what the role grants.
                </Notice>
              )}

              {groups.map((group) => (
                <FormSection key={group.group} title={group.group}>
                  <ul className="space-y-2">
                    {group.permissions.map((permission) => {
                      const standing = standingOf(permission.key);
                      return (
                        <li
                          key={permission.key}
                          className="flex flex-wrap items-center justify-between gap-3 border-b border-border-soft pb-2 text-sm"
                        >
                          <span>
                            {permission.name}
                            <code className="ml-2 text-xs text-muted-soft">{permission.key}</code>
                            {permission.module ? (
                              <span className="ml-2 text-xs text-muted-soft">
                                needs the {permission.module} module
                              </span>
                            ) : null}
                          </span>
                          {/*
                            * A raw select with an `sr-only` label rather than `SelectField`, which
                            * always renders its label: one visible label per row would repeat the
                            * permission name that is already the row's own text, and 109 of those
                            * is a wall. The association is explicit, which is what matters.
                            */}
                          <div>
                            <label className="sr-only" htmlFor={`perm-${permission.key}`}>
                              Standing for {permission.name}
                            </label>
                            <select
                              id={`perm-${permission.key}`}
                              className="field-select w-56"
                              disabled={isSelf}
                              value={standing === 'none' ? 'role' : standing}
                              onChange={(event) =>
                                setStanding(permission.key, event.target.value as Standing)
                              }
                            >
                              <option value="role">
                                {roleGrants.has(permission.key)
                                  ? 'From the role (granted)'
                                  : 'From the role (not granted)'}
                              </option>
                              <option value="extra">Granted to this user</option>
                              <option value="denied">Denied to this user</option>
                            </select>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </FormSection>
              ))}

              {isSelf ? null : (
                <div className="border-t border-border-soft pt-5">
                  {/*
                    * A plain button, not `SubmitButton`: there is no form here to submit. The
                    * 109 selects each write state directly, and wrapping them in a `<form>` only to
                    * give this button something to submit would be scaffolding for its own sake.
                    */}
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={permBusy}
                    aria-busy={permBusy}
                    onClick={() => void savePermissions()}
                  >
                    {permBusy ? 'Saving…' : 'Save permissions'}
                  </button>
                </div>
              )}
            </div>
          )
        ) : roleFailure?.refused ? (
          <Notice tone="warn">
            This user’s role is not readable by this account — reading a role needs the user view or
            role view permission. {roleFailure.message}
          </Notice>
        ) : roleFailure ? (
          <Notice tone="error">
            This user’s role could not be loaded: {roleFailure.message}{' '}
            <button
              type="button"
              onClick={() => setRoleNonce((n) => n + 1)}
              className="font-medium underline underline-offset-2"
            >
              Try again
            </button>
          </Notice>
        ) : !role ? (
          <LoadingBlock label="Loading the role…" rows={3} />
        ) : (
          <div className="max-w-2xl space-y-6">
            {roleError ? <Notice tone="error">{roleError}</Notice> : null}

            <Notice tone="warn">
              A role is <strong>global</strong>: its permissions are not stored per school, so
              changing what <strong>{role.name}</strong> grants changes it for every user of that
              role on every school on the platform — not just for {record.name}.
            </Notice>

            <FormSection
              title="Labels"
              description="The two things about a role that can be changed. Its slug and whether it is a platform or a school role are fixed — every grant is keyed to them."
            >
              <form
                className="space-y-4"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveRoleLabels();
                }}
              >
                <Field
                  id="role-name"
                  label="Name"
                  required
                  maxLength={120}
                  value={roleName}
                  error={roleFieldErrors.name}
                  onChange={(event) => setRoleName(event.target.value)}
                  hint={`Slug: ${role.slug} — fixed, and what every grant is keyed to.`}
                />
                <TextAreaField
                  id="role-description"
                  label="Description"
                  rows={2}
                  maxLength={255}
                  value={roleDescription}
                  error={roleFieldErrors.description}
                  onChange={(event) => setRoleDescription(event.target.value)}
                />
                <FormActions>
                  <SubmitButton
                    busy={roleBusy}
                    busyLabel="Saving…"
                    fullWidth={false}
                    disabled={!canManageRoles || labelsUnchanged}
                  >
                    Save labels
                  </SubmitButton>
                </FormActions>
              </form>
            </FormSection>

            {groups.length === 0 ? null : (
              <FormSection
                title="What this role grants"
                description="Sent as the complete set, so unticking everything revokes everything."
              >
                <div className="space-y-4">
                  {roleLocked ? (
                    <Notice tone="info">
                      This role always holds the complete permission catalogue, so its grants cannot
                      be edited here — the API refuses the change.
                    </Notice>
                  ) : null}

                  {groups.map((group) => (
                    <div key={group.group}>
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                        {group.group}
                      </h3>
                      <ul className="space-y-1">
                        {group.permissions.map((permission) => (
                          <li key={permission.key} className="flex items-center gap-2 text-sm">
                            <input
                              id={`role-${permission.key}`}
                              type="checkbox"
                              className="size-4"
                              disabled={!canManageRoles || roleLocked}
                              checked={roleKeys.includes(permission.key)}
                              onChange={(event) =>
                                setRoleKeys((current) =>
                                  event.target.checked
                                    ? [...new Set([...current, permission.key])]
                                    : current.filter((key) => key !== permission.key)
                                )
                              }
                            />
                            <label htmlFor={`role-${permission.key}`}>
                              {permission.name}
                              <code className="ml-2 text-xs text-muted-soft">{permission.key}</code>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}

                  {roleLocked ? null : (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={roleBusy || !canManageRoles}
                      aria-busy={roleBusy}
                      onClick={() => void saveRolePermissions()}
                    >
                      {roleBusy ? 'Saving…' : 'Save role permissions'}
                    </button>
                  )}
                </div>
              </FormSection>
            )}
          </div>
        )}
      </TabPanel>
    </div>
  );
}
