'use client';

/**
 * The school's login accounts — the owner's decisions D1 and D2, and FR-AUTH-007 on the school side.
 *
 * ## The School Admins panel
 *
 * A School Admin has no profile table (teachers, staff and students each do), so there is no list
 * where "Create login" could sit beside the person; this panel is that place. It lists the accounts
 * with the `school_admin` role through the ordinary Users read (`users.view`, scoped to this school by
 * the server) and adds one through `POST /users` (`users.manage`).
 *
 * Adding one is capped by the plan's Admin Limit (D2), which counts Principals and School Admins
 * together — the SRS hierarchy's "Principals/Admins" tier. A school at its limit is refused with the
 * limit's own message, inside the dialog, rather than having the button guess in advance.
 *
 * ## Account status, which a school could create and never take away
 *
 * FR-AUTH-007 names **School Admin** among the actors of account status management, and
 * `PATCH /users/:id` has been open to a school all along: it takes `users.manage` with no platform
 * guard, `users.validation.js` accepts `status`, and `tenantWhere()` confines the caller to their own
 * school's accounts. The only screen that called it was the Super Admin's. So a school that created a
 * login for somebody could not stop it working again — a teacher who left kept a sign-in that
 * `authenticate` would go on honouring until someone on the platform suspended it.
 *
 * `AccountStatusDialog` is that control. It is used by the School Admins table below and by the Login
 * section of a teacher's and a staff member's record, which import it — and the pieces those two
 * records share, `useLinkedAccount`, `LinkedLoginPanel` and `LinkedAccountField` — from this file.
 * Accounts are what this file is about; if a fourth caller appears, the set belongs in `components/`.
 *
 * Two refusals are knowable, and are handled rather than discovered:
 *
 *   - `users.service.assertNotSelf()` refuses a change to your **own** status with
 *     `SELF_MODIFICATION_DENIED`, so your own row offers no control. The Super Admin's account screen
 *     draws the same line for the same reason: nobody can lock themselves out.
 *   - Reactivating a School Admin reserves a place against the Admin Limit in the same transaction as
 *     the write (`users.service.update()`), because the limit counts **active** accounts and a
 *     suspend / create / reactivate sequence would otherwise land a school at limit + 1. A school at
 *     its limit is refused with `PLAN_LIMIT_EXCEEDED`, whose message names the limit and the count —
 *     shown inside the dialog, where the button was pressed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { splitApiErrors } from '@/lib/formErrors';
import { useCollection } from '@/lib/useCollection';
import { Notice, SearchField, SelectField, SubmitButton } from '@/components/form';
import { Modal } from '@/components/overlay';
import { useToast } from '@/components/toast';
import { CreateLoginDialog } from '@/components/createLogin';
import type { LoginTarget } from '@/components/createLogin';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

/**
 * An account as `users.service.present()` builds it — for `GET /users` and `GET /users/:id` alike.
 *
 * Only what these controls read is declared. `publicUser()` returns more, and the permission picture
 * `GET /users/:id` adds is the Super Admin screen's business, not a status control's.
 */
export interface LoginAccount {
  id: number;
  name: string;
  username: string;
  email: string | null;
  /** FR-AUTH-007 — `USER_STATUS`. */
  status: string;
  role?: { slug: string; name: string } | null;
}

/**
 * `USER_STATUS` in `config/constants.js`, which `users.validation.js` compiles into `Joi.valid(...)`.
 *
 * All four, as the Super Admin's account screen offers them. `LOGIN_ALLOWED_STATUSES` is `active`
 * alone, so the other three differ in what they record rather than in what they do — each is refused
 * at sign-in and on the account's very next request.
 */
const ACCOUNT_STATUSES = [
  { value: 'active', label: 'Active — can sign in' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'pending', label: 'Pending' },
];

/** The one input the status dialog renders; anything else a 422 names goes to its banner. */
const STATUS_FIELD = new Set(['status']);

/** `PAGINATION.MAX_LIMIT` — the most one page of the account picker can hold. */
const OPTION_LIMIT = 100;

const NETWORK_FAILURE = 'Could not reach the server. Check your connection and try again.';

/* ─────────────────────────────── the School Admins panel ─────────────────────────────── */

export function SchoolAdminsPanel() {
  const { can } = useAuth();
  if (!can('users.view')) {
    return (
      <Notice tone="info">
        Seeing the school&apos;s administrator accounts needs the permission to view users, which this
        account does not hold.
      </Notice>
    );
  }
  return <AdminsList canManage={can('users.manage')} />;
}

/* Split out so the list is only ever requested by an account that may read it. */
function AdminsList({ canManage }: { canManage: boolean }) {
  const { profile } = useAuth();
  const [loginFor, setLoginFor] = useState<LoginTarget | null>(null);
  const [statusFor, setStatusFor] = useState<LoginAccount | null>(null);

  const query = useMemo(() => ({ role: 'school_admin', limit: 50 }), []);
  const { rows, loading, error, refusal, reload } = useCollection<LoginAccount>('/users', query);

  /* `assertNotSelf()` compares ids, so this does too. */
  const selfId = profile?.user.id ?? null;

  const columns = useMemo<Column<LoginAccount>[]>(() => {
    const base: Column<LoginAccount>[] = [
      { key: 'name', header: 'Name', primary: true, cell: (row) => <span className="font-medium">{row.name}</span> },
      { key: 'username', header: 'Username', cell: (row) => <code className="text-xs text-muted">{row.username}</code> },
      { key: 'email', header: 'Email', cell: (row) => row.email },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
    ];

    /* `users.manage` is what `PATCH /users/:id` is mounted behind. Without it there is nothing to offer. */
    if (!canManage) return base;

    return [
      ...base,
      {
        key: 'actions',
        header: 'Actions',
        cell: (row) =>
          row.id === selfId ? (
            /* Said rather than hidden, so a missing button on one row does not read as a fault. */
            <span className="text-sm text-muted-soft">Your own login</span>
          ) : (
            <button type="button" onClick={() => setStatusFor(row)} className="btn btn-ghost btn-sm">
              Change status
            </button>
          ),
      },
    ];
  }, [canManage, selfId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-2xl text-sm leading-relaxed text-muted">
          School Admins run the school alongside the Principal. Each active one counts towards your
          plan&apos;s Admin Limit together with the Principal, so a school at its limit is told so when
          it adds another or sets a suspended one back to active. They sign in with a temporary password
          and choose their own at the first sign-in.
        </p>
        {canManage ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setLoginFor({ role: 'school_admin', person: 'a new School Admin' })}
          >
            Add a School Admin
          </button>
        ) : null}
      </div>

      {refusal ? (
        <RefusalNotice refusal={refusal} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyNotice>This school has no School Admin accounts yet.</EmptyNotice>
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="School Admins" busy={loading} />
      )}

      <CreateLoginDialog target={loginFor} onClose={() => setLoginFor(null)} onCreated={reload} />
      <AccountStatusDialog account={statusFor} onClose={() => setStatusFor(null)} onSaved={reload} />
    </div>
  );
}

/* ─────────────────────────────── FR-AUTH-007 — the status control ─────────────────────────────── */

/**
 * Set one account's status — `PATCH /users/:id` with `{ status }` and nothing else.
 *
 * Only the status, although the route accepts five other columns. The name, email and username of a
 * teacher's login are the Super Admin's account screen's business, and an email change there sends a
 * fresh verification (FR-AUTH-006); a school-side control that could also rewrite those would be a
 * second account editor with half the first one's care.
 *
 * The caller decides who may see the button — never on the caller's own account, and only with
 * `users.manage`. This dialog does not re-check either: the server does, and a refusal lands in the
 * banner like any other.
 */
export function AccountStatusDialog({
  account,
  onClose,
  onSaved,
}: {
  /** The account being changed, or null when nothing is open. */
  account: LoginAccount | null;
  onClose: () => void;
  /** Called with the account as the server stored it. */
  onSaved: (account: LoginAccount) => void;
}) {
  const { success } = useToast();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  /* Re-seeded per account, so the last dialog's choice never decides this one's status. */
  useEffect(() => {
    if (!account) return;
    setStatus(account.status);
    setBusy(false);
    setBanner(null);
    setFieldError(null);
  }, [account]);

  const unchanged = !account || status === account.status;

  async function submit() {
    if (!account || busy || unchanged) return;
    setBusy(true);
    setBanner(null);
    setFieldError(null);

    try {
      const result = await api.patch<{ user: LoginAccount }>(`/users/${account.id}`, { status });
      success(
        'Sign-in status saved',
        status === 'active'
          ? `${account.name} can sign in.`
          : `${account.name} cannot sign in while the account is ${status}.`
      );
      onSaved(result.user);
      onClose();
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        setBanner(NETWORK_FAILURE);
        return;
      }
      const { perField, banner: message } = splitApiErrors(caught, STATUS_FIELD);
      setFieldError(perField.status ?? null);
      /*
       * The limit's own sentence — "Admin Limit reached. Your plan allows 2 … and 2 are in use." —
       * says what ran out, and the second sentence says what frees it. See the file header.
       */
      setBanner(
        caught.code === 'PLAN_LIMIT_EXCEEDED'
          ? `${caught.message} The limit counts the Principal and every active School Admin, so another has to stop being active first, or the plan's limit be raised.`
          : message
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={account !== null}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={account ? `Sign-in status for ${account.name}` : 'Sign-in status'}
      description="Only an active account can sign in. Inactive, suspended and pending are all refused — at sign-in and on the account's very next request. Nothing is deleted, and the account can be set back to active here."
      size="sm"
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary">
            Cancel
          </button>
          <SubmitButton form="account-status" busy={busy} busyLabel="Saving…" disabled={unchanged}>
            Save status
          </SubmitButton>
        </>
      }
    >
      <form
        id="account-status"
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {banner ? <Notice tone="error">{banner}</Notice> : null}

        {account ? (
          <p className="text-sm text-muted">
            Signs in as <code className="text-xs text-ink">{account.username}</code>
            {account.role ? ` — ${account.role.name}` : ''}
          </p>
        ) : null}

        <SelectField
          id="account-status-select"
          label="Status"
          required
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          error={fieldError}
        >
          {ACCOUNT_STATUSES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </form>
    </Modal>
  );
}

/* ─────────────────────── the login linked to a teacher or staff record ─────────────────────── */

/** The linked login, as far as this caller can see it. */
export type LinkedAccount =
  /** No `user_id` on the record. */
  | { state: 'none' }
  /** A `user_id`, and no `users.view` to read the account behind it. */
  | { state: 'hidden' }
  | { state: 'loading' }
  | { state: 'ready'; account: LoginAccount }
  | { state: 'failed'; message: string };

/**
 * Read the account a profile's `user_id` names.
 *
 * ## Why this is a second request and not a column on the record
 *
 * `GET /teachers/:id` and `GET /staff/:id` `include` nothing, so the record carries the bare id and no
 * status. (The two *lists* now include the login's `id` and `status`, which is enough for a column
 * saying whether it can sign in; the record's Login section shows the account itself.) `GET /users/:id`
 * is the read that has it, behind `users.view` — which is a separate grant from the `teachers.view` or
 * `staff.view` that opened the record, so a Librarian reading a colleague gets `hidden` rather than a
 * refusal dressed as an error.
 *
 * The result is kept with the id it was read for, so a record whose link has just changed shows
 * "loading" rather than, for one render, the previous account under the new link.
 */
export function useLinkedAccount(userId: number | null): {
  linked: LinkedAccount;
  reload: () => void;
  replace: (account: LoginAccount) => void;
} {
  const { can } = useAuth();
  const canView = can('users.view');
  const [loaded, setLoaded] = useState<{ forId: number; result: LinkedAccount } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!userId || !canView) return;
    const controller = new AbortController();
    setLoaded(null);

    (async () => {
      try {
        const body = await api.get<{ user: LoginAccount }>(`/users/${userId}`, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setLoaded({ forId: userId, result: { state: 'ready', account: body.user } });
        }
      } catch (caught) {
        if (controller.signal.aborted || (caught as Error)?.name === 'AbortError') return;
        setLoaded({
          forId: userId,
          result: { state: 'failed', message: caught instanceof ApiError ? caught.message : NETWORK_FAILURE },
        });
      }
    })();

    return () => controller.abort();
  }, [userId, canView, nonce]);

  const linked: LinkedAccount = !userId
    ? { state: 'none' }
    : !canView
      ? { state: 'hidden' }
      : loaded && loaded.forId === userId
        ? loaded.result
        : { state: 'loading' };

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  /* After a status change: the server's own copy, without a second read. */
  const replace = useCallback(
    (account: LoginAccount) => setLoaded({ forId: account.id, result: { state: 'ready', account } }),
    []
  );

  return { linked, reload, replace };
}

/**
 * The Login section of a teacher's or staff member's record.
 *
 * It answers **can this person sign in?** in full. A list row carries the login's `status` and can say
 * yes or no; here the account itself is read — its name, username, email and role beside that status —
 * and, for a holder of `users.manage`, on anybody's account but their own, the status can be changed. A
 * record with no login is offered one, through the same D1 dialog the lists use.
 *
 * The status also moves without this panel: under the owner's decision D19, deactivating the teacher or
 * staff member takes an active login of their kind to `inactive`, and reactivating restores it (one an
 * administrator suspended stays suspended). The records re-read this panel after either action.
 *
 * Rendered outside the record's form on purpose: `Modal` is a `<dialog>` in place rather than a
 * portal, so a dialog with a form of its own inside the page's form would be a form nested in a form.
 */
export function LinkedLoginPanel({
  noun,
  linked,
  onRetry,
  onStatusSaved,
  createTarget,
  onCreated,
}: {
  /** "teacher" / "staff member" — used in the sentences below. */
  noun: string;
  linked: LinkedAccount;
  onRetry: () => void;
  onStatusSaved: (account: LoginAccount) => void;
  /**
   * Who a new login would be for, or null when one is not offered. The lists offer "Create login" on
   * an active record only, and the record screen follows them rather than disagreeing.
   */
  createTarget: LoginTarget | null;
  /** The record has a `user_id` now; re-read it. */
  onCreated: () => void;
}) {
  const { can, profile } = useAuth();
  const canManageUsers = can('users.manage');
  const [loginFor, setLoginFor] = useState<LoginTarget | null>(null);
  const [statusFor, setStatusFor] = useState<LoginAccount | null>(null);

  const isSelf = linked.state === 'ready' && profile?.user.id === linked.account.id;

  return (
    <section aria-labelledby="login-heading" className="mt-12 border-t border-border-soft pt-8">
      <div className="mb-4 max-w-2xl">
        <h2 id="login-heading" className="text-base font-semibold tracking-tight text-ink">
          Login
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          The account this {noun} signs in with, and whether it can. Which account is linked is part of
          the record above; whether it may sign in belongs to the account.
        </p>
      </div>

      {linked.state === 'none' ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">No login is linked to this {noun}, so they cannot sign in.</p>
          {canManageUsers && createTarget ? (
            <button type="button" onClick={() => setLoginFor(createTarget)} className="btn btn-secondary">
              Create login
            </button>
          ) : canManageUsers ? (
            <p className="text-sm text-muted">A login is offered only while the {noun} is active, as on the list.</p>
          ) : null}
        </div>
      ) : linked.state === 'hidden' ? (
        <p className="text-sm text-muted">
          A login is linked to this {noun}. Whether it can sign in is shown to accounts that can view
          users, which this one cannot.
        </p>
      ) : linked.state === 'loading' ? (
        <LoadingBlock rows={1} label="Loading the linked login…" />
      ) : linked.state === 'failed' ? (
        <Notice tone="error">
          The linked login could not be loaded: {linked.message}{' '}
          <button type="button" className="underline" onClick={onRetry}>
            Try again
          </button>
        </Notice>
      ) : (
        <div className="space-y-4">
          <dl className="grid max-w-xl grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted">Name</dt>
            <dd className="text-ink">{linked.account.name}</dd>
            <dt className="text-muted">Username</dt>
            <dd>
              <code className="text-xs text-ink">{linked.account.username}</code>
            </dd>
            <dt className="text-muted">Email</dt>
            <dd className="break-all text-ink">{linked.account.email ?? '—'}</dd>
            {linked.account.role ? (
              <>
                <dt className="text-muted">Role</dt>
                <dd className="text-ink">{linked.account.role.name}</dd>
              </>
            ) : null}
            <dt className="text-muted">Status</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <StatusBadge status={linked.account.status} />
              {/* `LOGIN_ALLOWED_STATUSES` is `active` alone — the one word that means yes. */}
              <span className="text-muted">
                {linked.account.status === 'active' ? 'Can sign in.' : 'Cannot sign in — only an active account can.'}
              </span>
            </dd>
          </dl>

          {canManageUsers && !isSelf ? (
            <button type="button" onClick={() => setStatusFor(linked.account)} className="btn btn-secondary">
              Change status
            </button>
          ) : isSelf ? (
            <p className="text-sm text-muted">
              This is your own login. Another administrator has to change its status, so nobody can lock
              themselves out.
            </p>
          ) : null}
        </div>
      )}

      <CreateLoginDialog target={loginFor} onClose={() => setLoginFor(null)} onCreated={onCreated} />
      <AccountStatusDialog account={statusFor} onClose={() => setStatusFor(null)} onSaved={onStatusSaved} />
    </section>
  );
}

/**
 * The `user_id` picker for a teacher or staff record's edit form.
 *
 * The create screens' picker, with the same reasoning — `teachers/new` and `staff/new` argue it at
 * length, so only the summary is here: it is a search over `GET /users` because a school's accounts
 * include every student and parent and a page holds a hundred; it is not narrowed by role because
 * `loadUserInSchool()` checks the school and the one-record-per-account rule and nothing else; and it
 * needs `users.view`, a separate grant, so when the list cannot be read it says so in prose instead of
 * rendering an empty dropdown that reads "there are no accounts".
 *
 * The one thing an edit form adds is a value that was there before the list was. The account already
 * linked is passed in as `stored` and kept among the options; and when even that could not be read,
 * the current value is kept as an option of its own, so the select never shows "No linked account"
 * for a record that has one.
 */
export function LinkedAccountField({
  value,
  onChange,
  error,
  stored,
  noun,
}: {
  /** The form's `user_id`, as text; `''` for none. */
  value: string;
  onChange: (value: string) => void;
  error?: string;
  /** The account the record links now, when it could be read. */
  stored: LoginAccount | null;
  /** "teacher" / "staff record" — the thing a login may be linked to only once. */
  noun: string;
}) {
  const { can } = useAuth();
  const canList = can('users.view');

  const [users, setUsers] = useState<LoginAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  /* The row chosen from a page a later search may replace — the create screens' `pinnedUser`. */
  const [chosen, setChosen] = useState<LoginAccount | null>(null);

  /* The create screens' 300 ms: `apiLimiter` sits in front of every keystroke. */
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!canList) return;
    let live = true;

    (async () => {
      try {
        const page = await api.page<LoginAccount[]>('/users', {
          query: { limit: OPTION_LIMIT, sortBy: 'name', sortOrder: 'asc', q: query || undefined },
        });
        if (!live) return;
        setUsers(page.data);
        setTotal(page.meta?.total ?? page.data.length);
        setFailed(false);
      } catch {
        /* Which failure it was does not change the remedy: the link cannot be changed from here. */
        if (!live) return;
        setUsers([]);
        setTotal(0);
        setFailed(true);
      }
    })();

    return () => {
      live = false;
    };
  }, [canList, query]);

  if (!canList || failed) {
    /* No control to label, so the heading is a paragraph in the label's own style — see `teachers/new`. */
    return (
      <div>
        <p className="field-label mb-1.5">Linked account</p>
        <p className="field-hint">
          The account list could not be loaded, so the linked login cannot be changed here. Reading it
          needs the separate &ldquo;View users&rdquo; permission. Everything else on this form still saves,
          and the link is left as it is.
        </p>
        {error ? <p className="field-error mt-1.5">{error}</p> : null}
      </div>
    );
  }

  const extras = [stored, chosen].filter(
    (row, index, all): row is LoginAccount =>
      row !== null
      && !users.some((user) => user.id === row.id)
      && all.findIndex((other) => other?.id === row.id) === index
  );
  const options = [...extras, ...users];
  const valueShown = value === '' || options.some((row) => String(row.id) === value);

  const hint = `The login this ${noun} signs in with. It must belong to this school and may not already be linked to another ${noun}. Unlinking leaves the account itself as it is and still able to sign in — if it should not, change its status in the Login section below first.${
    total > users.length ? ` Showing ${users.length} of ${total} accounts — search to narrow the list.` : ''
  }`;

  return (
    <div className="space-y-2">
      <SearchField
        id="user_id_search"
        label="Search accounts"
        placeholder="Search accounts by name, email or username…"
        value={search}
        onChange={setSearch}
      />
      <SelectField
        id="user_id"
        label="Linked account"
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          setChosen(next ? (options.find((row) => String(row.id) === next) ?? chosen) : null);
        }}
        error={error}
        hint={hint}
      >
        <option value="">No linked account</option>
        {valueShown ? null : <option value={value}>The account already linked</option>}
        {options.map((row) => (
          <option key={row.id} value={row.id}>
            {row.name} ({row.username})
            {row.role ? ` — ${row.role.name}` : ''}
            {row.email ? ` · ${row.email}` : ''}
          </option>
        ))}
      </SelectField>
    </div>
  );
}
