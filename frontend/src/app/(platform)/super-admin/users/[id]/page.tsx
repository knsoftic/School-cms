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
 * columns (`slug`, `level`, `is_system`, `scope`) are refused, because §5's eleven roles are fixed
 * and a renamed slug would orphan every grant keyed to it.
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
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
} from '@/components/form';
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
  { key: 'account', label: 'Account' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'role', label: 'Role' },
];

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
 */
interface UserDetail {
  id: number;
  name: string;
  email: string;
  username: string;
  phone: string | null;
  status: string;
  locale: string | null;
  role: { id: number; slug: string; name: string; description?: string | null };
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

export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : null;

  const { can } = useAuth();
  const { success } = useToast();
  const [tab, setTab] = useActiveTab(TABS);

  const [user, setUser] = useState<UserDetail | null>(null);
  const [groups, setGroups] = useState<PermissionGroup[]>([]);
  const [role, setRole] = useState<RoleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [nonce, setNonce] = useState(0);

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

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!id) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setRefusal(null);

    (async () => {
      try {
        const account = await api.get<{ user: UserDetail }>(`/users/${id}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setUser(account.user);
        setValues({
          name: account.user.name,
          email: account.user.email,
          username: account.user.username,
          phone: account.user.phone ?? '',
          status: account.user.status,
          locale: account.user.locale ?? '',
        });
        setExtra(account.user.permissions?.extra ?? []);
        setDenied(account.user.permissions?.denied ?? []);

        /*
         * The catalogue and the role are fetched after the account rather than beside it, because
         * both are gated on keys the account read is not: `GET /users/permissions` needs
         * `users.manage` or `roles.view`, and `GET /roles/:id` needs `roles.view`. A `Promise.all`
         * would fail the whole screen for a reader who is entitled to the account alone.
         */
        try {
          const catalogue = await api.get<{ groups: PermissionGroup[] }>('/users/permissions', {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setGroups(catalogue.groups);
        } catch {
          /* Leaves the permissions tab with nothing to render, which it explains. */
        }

        try {
          const loaded = await api.get<{ role: RoleDetail }>(`/roles/${account.user.role.id}`, {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setRole(loaded.role);
          setRoleName(loaded.role.name);
          setRoleDescription(loaded.role.description ?? '');
          setRoleKeys(loaded.role.permissions);
        } catch {
          /* Same: the role tab says it could not read the role rather than the screen failing. */
        }
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

  /* The server's own answer for this user's role — see the `UserDetail` note. */
  const roleGrants = useMemo(() => new Set(user?.permissions?.role ?? []), [user]);

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (loadError) return <ErrorNotice message={loadError} onRetry={reload} />;
  if (loading || !user) return <LoadingBlock />;

  const record = user;
  const canManageUsers = can('users.manage');
  const canManageRoles = can('roles.manage');

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

  async function saveAccount() {
    if (busy) return;
    const base: Record<string, string> = {
      name: record.name,
      email: record.email,
      username: record.username,
      phone: record.phone ?? '',
      status: record.status,
      locale: record.locale ?? '',
    };
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(base)) {
      if (values[key] === base[key]) continue;
      /* `phone` and `locale` are nullable; the other four are not, so a blank is left unsent. */
      const nullable = key === 'phone' || key === 'locale';
      const trimmed = values[key].trim();
      if (trimmed === '' && !nullable) continue;
      changed[key] = trimmed === '' ? null : trimmed;
    }
    if (Object.keys(changed).length === 0) return;

    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await api.patch<{ user: UserDetail }>(`/users/${record.id}`, changed);
      setUser(result.user);
      success(
        'Account updated',
        changed.email ? 'A verification email has been sent to the new address.' : undefined
      );
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(Array.isArray(caught.details) ? caught.fieldErrors() : {});
        setError(
          Array.isArray(caught.details)
            ? caught.bannerFor(Object.keys(base))
            : caught.message
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function savePermissions() {
    if (permBusy) return;
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

  async function saveRoleLabels() {
    if (!role || roleBusy) return;
    const changed: Record<string, unknown> = {};
    if (roleName !== role.name) changed.name = roleName.trim();
    if (roleDescription !== (role.description ?? '')) {
      changed.description = roleDescription.trim() === '' ? null : roleDescription.trim();
    }
    if (Object.keys(changed).length === 0) return;

    setRoleBusy(true);
    setRoleError(null);
    try {
      const result = await api.patch<{ role: RoleDetail }>(`/roles/${role.id}`, changed);
      setRole({ ...role, ...result.role });
      success('Role updated');
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

  async function saveRolePermissions() {
    if (!role || roleBusy) return;
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
      /* The user's own resolved set has changed with it. */
      reload();
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
        <span className="text-sm text-muted">
          {extra.length} granted beyond the role, {denied.length} taken away
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
                    onChange={(event) => setValues((v) => ({ ...v, status: event.target.value }))}
                    hint="A suspended account cannot sign in. Nothing is deleted."
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
                  {/* Both are refused by the schema by name; saying so beats a field that 422s. */}
                  The role and the password are not on this form. A role change is a different
                  operation, and a password is only ever changed through the account’s own reset
                  flow — the API refuses both here.
                </Notice>
              </FormSection>

              <FormActions>
                <SubmitButton busy={busy} busyLabel="Saving…" fullWidth={false}>
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
          ) : groups.length === 0 ? (
            <Notice tone="warn">
              The permission catalogue could not be read, so there is nothing to edit here. It needs
              the user management or role view permission.
            </Notice>
          ) : (
            <div className="space-y-6">
              {permError ? <Notice tone="error">{permError}</Notice> : null}

              <Notice tone="info">
                A permission comes from the <strong>role</strong> unless this user overrides it.
                Granting one adds it for this user alone; denying one takes it away even though the
                role has it. Leaving a key alone means it follows the role — including any later
                change to what the role grants.
              </Notice>

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
            </div>
          )
        ) : !role ? (
          <Notice tone="warn">
            This user’s role could not be read. Viewing or editing a role needs the role permissions.
          </Notice>
        ) : (
          <div className="max-w-2xl space-y-6">
            {roleError ? <Notice tone="error">{roleError}</Notice> : null}

            <Notice tone="warn">
              A role is <strong>global</strong>. `role_permissions` carries no school, so changing
              what <strong>{role.name}</strong> grants changes it for every user of that role on
              every school on the platform — not just for {record.name}.
            </Notice>

            <FormSection
              title="Labels"
              description="The two fields the API accepts. The slug, level and scope are fixed by §5's eleven roles and are refused."
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
                  value={roleName}
                  onChange={(event) => setRoleName(event.target.value)}
                  hint={`Slug: ${role.slug} — fixed, and what every grant is keyed to.`}
                />
                <TextAreaField
                  id="role-description"
                  label="Description"
                  rows={2}
                  value={roleDescription}
                  onChange={(event) => setRoleDescription(event.target.value)}
                />
                <FormActions>
                  <SubmitButton
                    busy={roleBusy}
                    busyLabel="Saving…"
                    fullWidth={false}
                    disabled={!canManageRoles}
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
                              disabled={!canManageRoles}
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

                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={roleBusy || !canManageRoles}
                    aria-busy={roleBusy}
                    onClick={() => void saveRolePermissions()}
                  >
                    {roleBusy ? 'Saving…' : 'Save role permissions'}
                  </button>
                </div>
              </FormSection>
            )}
          </div>
        )}
      </TabPanel>
    </div>
  );
}
