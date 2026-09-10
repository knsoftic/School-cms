'use client';

/**
 * School settings and academic sessions — SRS §14.1 (FR-SCHOOL-001) and §14.2 (FR-SCHOOL-002).
 *
 * `PATCH /school-settings`, `POST /sessions`, `PATCH /sessions/:id`, `POST /sessions/:id/activate`
 * and `POST /sessions/:id/close` — five write routes, none of which had a caller.
 *
 * ## §33 does not name this screen, and the requirements do name the capability
 *
 * `docs/VERIFICATION.md` filed both clusters under *needs a decision*, because §33's School list of
 * seventeen names no Settings screen and no Sessions screen. That is true, and it is a statement
 * about the **screen list**, not about the requirements: FR-SCHOOL-001 enumerates ten settings a
 * school configures, and FR-SCHOOL-002 requires that an academic session be created, activated and
 * closed. Both are `Tested` in the checklist on the strength of an API nothing could reach.
 *
 * Building them is therefore implementing a stated requirement, not inventing one — which is the
 * opposite of the platform Settings screen, where §33 names the screen and nothing anywhere says
 * what it contains. That one still has no form, and its own header argues why.
 *
 * The two live together because they are the same job — configuring the school — and because
 * splitting them would put two entries in a nav §33 fixes at seventeen. This screen is reached from
 * the school dashboard.
 *
 * ## Settings has no create and no delete, and that is the design
 *
 * `GET /school-settings` is find-or-**virtuals**: it returns defaults for a school that has never
 * saved any, and deliberately does not insert. The first `PATCH` creates the row and the second
 * updates it, so this screen never distinguishes the two — there is nothing for a person to do
 * differently.
 *
 * ## `logo_path` and `favicon_path` are web addresses, not uploads
 *
 * This screen used to leave both off, on the reasoning that they were server paths with no upload
 * route to produce one. The second half is still true — `UPLOAD_RULES` defines no profile for a
 * school logo — but the first is not: `settings.validation.js` `brandingUrl()` accepts only an
 * **absolute http(s) URL**, parses it with `new URL()` and stores the normalised `href` (Known Issues
 * #26), so the column names say `path` and the value is a link. A logo already hosted somewhere is
 * therefore settable, and the two are ordinary `type="url"` fields. Both are `.empty('').allow(null)`,
 * so clearing one clears it.
 *
 * ## Nothing else reads these settings yet, and the hints say so
 *
 * `school_settings` is read by `settings.service.js` and by nothing else in the backend — no
 * document, report, fee or finance entry takes its name, currency or timezone from here, and every
 * money row carries its own `currency` column. FR-SCHOOL-001 expects them to be "applied within the
 * school's tenant scope", which is wiring this screen cannot do. So the hints describe what is true
 * today — the values are stored — rather than promise an effect nothing produces.
 *
 * ## Closing a session is final and activation is exclusive
 *
 * `activate` flips `is_current` for the school inside a transaction and does **not** auto-close the
 * others; `close` stamps `closed`, clears current, and a closed session refuses both edit and
 * re-activation. There is no delete — close is the operation §14.2 names, and its absence is
 * asserted by the backend suite. The dialogs say all three things.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { rowError, splitApiErrors } from '@/lib/formErrors';
import { EXPLAINED_CODES, useCollection } from '@/lib/useCollection';
import type { Refusal } from '@/lib/useCollection';
import { EditDialog } from '@/components/editDialog';
import {
  Field,
  FormActions,
  FormGrid,
  FormSection,
  Notice,
  SubmitButton,
  TextAreaField,
  focusFirstInvalidField,
} from '@/components/form';
import { Modal } from '@/components/overlay';
import { TabPanel, Tabs, useActiveTab } from '@/components/tabs';
import { SchoolAdminsPanel } from './admins';
import { useToast } from '@/components/toast';
import {
  Column,
  DataTable,
  EmptyNotice,
  ErrorNotice,
  LoadingBlock,
  PageHeader,
  RefusalNotice,
  StatusBadge,
} from '@/components/table';

const TABS = [
  { key: 'settings', label: 'School settings' },
  { key: 'sessions', label: 'Academic sessions' },
  /* The owner's decisions D1 and D2 — see `admins.tsx`. */
  { key: 'admins', label: 'School Admins' },
];

/** `GET /school-settings` — the ten §14.1 fields this screen edits. */
interface Settings {
  name: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  /** An absolute http(s) URL, stored normalised — the column name says `path`; see the header. */
  logo_path: string | null;
  favicon_path: string | null;
  theme: string | null;
  currency: string | null;
  timezone: string | null;
}

/** One `academic_sessions` row. */
interface Session {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  is_current: boolean;
}

const SETTING_KEYS: (keyof Settings)[] = [
  'name',
  'address',
  'phone',
  'email',
  'website',
  'logo_path',
  'favicon_path',
  'theme',
  'currency',
  'timezone',
];

/**
 * The three the column cannot hold empty.
 *
 * `theme`, `currency` and `timezone` are `allowNull: false` on `school_settings`, and their schema
 * entries are bare `Joi.string().trim().max(n)` — no `.allow(null)`, no `.empty('')`. So a cleared box
 * is sent as `""`, which Joi answers "is not allowed to be empty" and the field shows as "is required".
 * Sending `null`, which this used to, was answered "must be a string" — true, and no help.
 */
const REQUIRED_SETTINGS = new Set<string>(['theme', 'currency', 'timezone']);

/**
 * `brandingUrl()`'s refusal, reworded for the person reading it.
 *
 * The server's sentence ends in a Known Issues number, which is the backend's bookkeeping rather than
 * anything an administrator can act on. Any other message — the length one — passes through.
 */
function brandingError(message: string | undefined): string | undefined {
  if (!message) return message;
  return /absolute http\(s\) URL/.test(message)
    ? 'Enter a full web address that starts with http:// or https://.'
    : message;
}

/** The create-session form's inputs, by the name the API keys its messages with. */
const SESSION_FIELDS = new Set(['name', 'start_date', 'end_date']);

export default function SchoolSettingsPage() {
  const { can } = useAuth();
  const { success } = useToast();
  const [tab, setTab] = useActiveTab(TABS);

  /* ── §14.1 ── */
  const [settings, setSettings] = useState<Settings | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const seed = useCallback((row: Settings) => {
    const next: Record<string, string> = {};
    for (const key of SETTING_KEYS) next[key] = row[key] ?? '';
    return next;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const result = await api.get<{ settings: Settings }>('/school-settings', {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSettings(result.settings);
        setValues(seed(result.settings));
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
  }, [seed]);

  /* ── §14.2 ── */
  const sessions = useCollection<Session>('/sessions', useMemo(() => ({ limit: 50 }), []));
  const [creating, setCreating] = useState(false);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [pending, setPending] = useState<{ action: 'activate' | 'close'; session: Session } | null>(
    null
  );
  const [newName, setNewName] = useState('');
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd] = useState('');
  const [sessionBusy, setSessionBusy] = useState(false);
  /*
   * One error per dialog. The create form and the activate/close confirmation used to share a single
   * `sessionError`, and opening Create never cleared it: a refused "Make current", cancelled, left its
   * message waiting at the top of the next Create dialog, describing something that form never did.
   * Each is now cleared as its dialog opens and as it is dismissed.
   */
  const [createError, setCreateError] = useState<string | null>(null);
  const [createFieldErrors, setCreateFieldErrors] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const canEditSettings = can('school.settings.manage');
  const canManageSessions = can('sessions.manage');

  function setValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  /*
   * What Save would send, worked out on every render so the button can say when there is nothing.
   * Save used to be enabled with nothing changed and return without a word, which reads as a dead
   * button; `SubmitButton`'s `disabled` is the set editors' "nothing has changed yet".
   */
  const changed: Record<string, unknown> = {};
  if (settings) {
    const base = seed(settings);
    for (const key of SETTING_KEYS) {
      const now = values[key] ?? '';
      if (now === base[key]) continue;
      const trimmed = now.trim();
      /*
       * Seven of the ten are nullable (`.empty('').allow(null)`), so clearing one clears the column.
       * The other three are NOT NULL and are sent blank, to be refused on the field — see
       * `REQUIRED_SETTINGS`.
       */
      changed[key] = trimmed === '' ? (REQUIRED_SETTINGS.has(key) ? '' : null) : trimmed;
    }
  }
  const nothingChanged = Object.keys(changed).length === 0;

  async function saveSettings() {
    if (busy || !settings || nothingChanged) return;

    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await api.patch<{ settings: Settings }>('/school-settings', changed);
      setSettings(result.settings);
      setValues(seed(result.settings));
      success('Settings saved');
    } catch (caught) {
      if (caught instanceof ApiError) {
        const perField = Array.isArray(caught.details) ? caught.fieldErrors() : {};
        setFieldErrors(perField);
        setError(
          Array.isArray(caught.details) ? caught.bannerFor(SETTING_KEYS as string[]) : caught.message
        );
        if (Object.keys(perField).length) focusFirstInvalidField();
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setCreateError(null);
    setCreateFieldErrors({});
    setCreating(true);
  }

  function closeCreate() {
    if (sessionBusy) return;
    setCreating(false);
    setCreateError(null);
    setCreateFieldErrors({});
  }

  async function createSession() {
    if (sessionBusy) return;
    setSessionBusy(true);
    setCreateError(null);
    setCreateFieldErrors({});
    try {
      /*
       * Blanks are left out rather than sent as `""`: an absent key is answered "is required", where
       * an empty date is answered "must be in ISO 8601 date format", which names the wrong problem.
       */
      await api.post('/sessions', {
        name: newName.trim() || undefined,
        start_date: newStart || undefined,
        end_date: newEnd || undefined,
      });
      success('Session created', 'It starts as upcoming. Activate it to make it the current session.');
      setCreating(false);
      setNewName('');
      setNewStart('');
      setNewEnd('');
      sessions.reload();
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        setCreateError('Could not reach the server. Check your connection and try again.');
        return;
      }
      /* A 409 whose `details` is `{ name }` — it is about the name, so it sits on the name. */
      if (caught.code === 'SESSION_NAME_TAKEN') {
        setCreateFieldErrors({ name: caught.message });
        focusFirstInvalidField();
        return;
      }
      /*
       * The one cross-column rule arrives keyed by its validator: `academic_sessions`' model-level
       * `endAfterStart()` becomes `field: "endAfterStart"` through `rethrow()`, a key no input has.
       * It is about the end date, so it is put there. Everything else the fields cannot carry goes
       * to the banner — which used to receive only "Validation failed" for all of it.
       */
      const { perField, banner } = splitApiErrors(caught, new Set([...SESSION_FIELDS, 'endAfterStart']));
      if (perField.endAfterStart) {
        if (!perField.end_date) perField.end_date = 'The session has to end after the day it starts.';
        delete perField.endAfterStart;
      }
      setCreateFieldErrors(perField);
      setCreateError(banner);
      if (Object.keys(perField).length) focusFirstInvalidField();
    } finally {
      setSessionBusy(false);
    }
  }

  async function runSessionAction() {
    if (!pending || sessionBusy) return;
    setSessionBusy(true);
    setActionError(null);
    try {
      /* Two calls, not one interpolated path — see the note in `subscriptions/[id]/lifecycle.tsx`. */
      if (pending.action === 'activate') {
        await api.post(`/sessions/${pending.session.id}/activate`, {});
      } else {
        await api.post(`/sessions/${pending.session.id}/close`, {});
      }
      success(
        pending.action === 'activate'
          ? `${pending.session.name} is now the current session`
          : `${pending.session.name} closed`
      );
      setPending(null);
      sessions.reload();
    } catch (caught) {
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setSessionBusy(false);
    }
  }

  function closeAction() {
    if (sessionBusy) return;
    setPending(null);
    setActionError(null);
  }

  const sessionColumns = useMemo<Column<Session>[]>(
    () => [
      {
        key: 'name',
        header: 'Session',
        cell: (row) => (
          <div>
            <span className="font-medium">{row.name}</span>
            {row.is_current ? (
              <span className="block text-xs text-success">current session</span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'dates',
        header: 'Runs',
        cell: (row) => (
          /* DATEONLY, printed as sent — giving a calendar date an instant shifts the day. */
          <span className="whitespace-nowrap text-muted">
            {row.start_date} – {row.end_date}
          </span>
        ),
      },
      { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
      ...(canManageSessions
        ? [
            {
              key: 'actions',
              header: 'Actions',
              cell: (row: Session) =>
                row.status === 'closed' ? (
                  /* A closed session refuses edit and re-activation; nothing here can move it. */
                  <span className="text-muted-soft">closed</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      onClick={() => setEditingSession(row)}
                    >
                      Edit
                    </button>
                    {!row.is_current ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => {
                          setPending({ action: 'activate', session: row });
                          setActionError(null);
                        }}
                      >
                        Make current
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-sm btn-danger-ghost"
                      onClick={() => {
                        setPending({ action: 'close', session: row });
                        setActionError(null);
                      }}
                    >
                      Close
                    </button>
                  </div>
                ),
            } as Column<Session>,
          ]
        : []),
    ],
    [canManageSessions]
  );

  if (refusal) return <RefusalNotice refusal={refusal} />;
  if (loadError) return <ErrorNotice message={loadError} onRetry={() => window.location.reload()} />;
  if (loading) return <LoadingBlock />;

  return (
    <div>
      <PageHeader
        title="School settings"
        description="The school's own details, and the academic sessions its work is filed under."
        action={
          <Link href="/school" className="btn btn-secondary">
            Back to dashboard
          </Link>
        }
      />

      <Tabs tabs={TABS} active={tab} onChange={setTab} label="Settings sections" />

      <TabPanel tabKey={tab}>
        {tab === 'settings' ? (
          !canEditSettings ? (
            <Notice tone="info">
              Changing the school’s settings needs its own permission, which this account does not
              hold.
            </Notice>
          ) : (
            <form
              className="max-w-2xl space-y-6"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void saveSettings();
              }}
            >
              {error ? <Notice tone="error">{error}</Notice> : null}

              <FormSection
                title="Identity"
                description="How the school names itself. This does not rename the school record itself, which only a Super Admin can change."
              >
                <Field
                  id="name"
                  label="Name"
                  maxLength={180}
                  value={values.name ?? ''}
                  error={fieldErrors.name}
                  onChange={(event) => setValue('name', event.target.value)}
                  hint="The name the school goes by, kept with these settings. No document or report prints it yet, so changing it does not change them."
                />
                <TextAreaField
                  id="address"
                  label="Address"
                  rows={3}
                  value={values.address ?? ''}
                  error={fieldErrors.address}
                  onChange={(event) => setValue('address', event.target.value)}
                />
                <FormGrid>
                  <Field
                    id="phone"
                    label="Phone"
                    type="tel"
                    value={values.phone ?? ''}
                    error={fieldErrors.phone}
                    onChange={(event) => setValue('phone', event.target.value)}
                  />
                  <Field
                    id="email"
                    label="Email"
                    type="email"
                    value={values.email ?? ''}
                    error={fieldErrors.email}
                    onChange={(event) => setValue('email', event.target.value)}
                  />
                </FormGrid>
                {/*
                  * `website` is a plain `Joi.string().max(180)` — unlike the two branding fields below
                  * it is not checked as a URL. So the hint asks for the scheme rather than claiming it
                  * is enforced, which it used to ("Must carry http:// or https://") and was not.
                  */}
                <Field
                  id="website"
                  label="Website"
                  type="url"
                  inputMode="url"
                  maxLength={180}
                  value={values.website ?? ''}
                  error={fieldErrors.website}
                  onChange={(event) => setValue('website', event.target.value)}
                  hint="The full address, including https://. It is stored exactly as typed and is not checked."
                />
              </FormSection>

              <FormSection
                title="Logo and favicon"
                description="Web addresses of images already hosted elsewhere. There is no upload here — the address itself is what is stored."
              >
                <Field
                  id="logo_path"
                  label="Logo URL"
                  type="url"
                  inputMode="url"
                  maxLength={255}
                  placeholder="https://"
                  value={values.logo_path ?? ''}
                  error={brandingError(fieldErrors.logo_path)}
                  onChange={(event) => setValue('logo_path', event.target.value)}
                  hint="Must start with http:// or https://. Leave it blank for no logo."
                />
                <Field
                  id="favicon_path"
                  label="Favicon URL"
                  type="url"
                  inputMode="url"
                  maxLength={255}
                  placeholder="https://"
                  value={values.favicon_path ?? ''}
                  error={brandingError(fieldErrors.favicon_path)}
                  onChange={(event) => setValue('favicon_path', event.target.value)}
                  hint="The small icon a browser shows in its tab. Must start with http:// or https://."
                />
              </FormSection>

              <FormSection
                title="Presentation and locale"
                description="Stored with the school's settings. Nothing else reads them yet, so changing one does not change how fees, dates or pages appear."
              >
                <FormGrid>
                  <Field
                    id="currency"
                    label="Currency"
                    required
                    maxLength={10}
                    value={values.currency ?? ''}
                    error={fieldErrors.currency}
                    onChange={(event) => setValue('currency', event.target.value)}
                    hint="A code such as PKR, stored in upper case. Fee and finance entries each carry their own currency and do not take it from here."
                  />
                  <Field
                    id="timezone"
                    label="Timezone"
                    required
                    maxLength={64}
                    value={values.timezone ?? ''}
                    error={fieldErrors.timezone}
                    onChange={(event) => setValue('timezone', event.target.value)}
                    hint="An IANA name such as Asia/Karachi."
                  />
                </FormGrid>
                <Field
                  id="theme"
                  label="Theme"
                  required
                  maxLength={40}
                  value={values.theme ?? ''}
                  error={fieldErrors.theme}
                  onChange={(event) => setValue('theme', event.target.value)}
                  hint="A theme name — “default” unless the school uses another. Any name up to 40 characters is accepted."
                />
              </FormSection>

              <FormActions>
                <SubmitButton
                  busy={busy}
                  busyLabel="Saving…"
                  fullWidth={false}
                  disabled={nothingChanged}
                >
                  Save settings
                </SubmitButton>
              </FormActions>
            </form>
          )
        ) : tab === 'admins' ? (
          <SchoolAdminsPanel />
        ) : (
          <div className="space-y-6">
            {sessions.error ? (
              <ErrorNotice message={sessions.error} onRetry={sessions.reload} />
            ) : sessions.loading && sessions.rows.length === 0 ? (
              <LoadingBlock />
            ) : sessions.rows.length === 0 ? (
              <EmptyNotice>
                No academic session exists yet. Classes, exams and fees are all filed under one, so
                creating the first is usually the first thing a new school does.
              </EmptyNotice>
            ) : (
              <DataTable
                columns={sessionColumns}
                rows={sessions.rows}
                rowKey={(row) => row.id}
                caption="Academic sessions"
                busy={sessions.loading}
              />
            )}

            {canManageSessions ? (
              <button type="button" className="btn btn-primary" onClick={openCreate}>
                Create a session
              </button>
            ) : null}
          </div>
        )}
      </TabPanel>

      <Modal
        open={creating}
        onClose={closeCreate}
        title="Create an academic session"
        description="It starts as upcoming. Making it current is a separate step, so a session can be set up in advance without disturbing the one running."
        size="sm"
        busy={sessionBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={sessionBusy}
              onClick={closeCreate}
            >
              Cancel
            </button>
            <SubmitButton
              form="create-session"
              busy={sessionBusy}
              busyLabel="Creating…"
              fullWidth={false}
            >
              Create session
            </SubmitButton>
          </>
        }
      >
        <form
          id="create-session"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void createSession();
          }}
        >
          {createError ? <Notice tone="error">{createError}</Notice> : null}
          {/*
            * The ids are prefixed, so `FieldMessage` cannot match a server message that begins with
            * `"name"` to its own id; `rowError` does that rewrite here, where the API's key is known.
            */}
          <Field
            id="session-name"
            label="Name"
            required
            maxLength={90}
            value={newName}
            error={rowError(createFieldErrors, 'name', 'Name')}
            onChange={(event) => setNewName(event.target.value)}
            hint="What the school calls it — 2026–27, for instance. Up to 90 characters, and unique within the school."
          />
          <FormGrid>
            <Field
              id="session-start"
              label="Starts"
              type="date"
              required
              value={newStart}
              error={rowError(createFieldErrors, 'start_date', 'Starts')}
              onChange={(event) => setNewStart(event.target.value)}
            />
            <Field
              id="session-end"
              label="Ends"
              type="date"
              required
              value={newEnd}
              error={rowError(createFieldErrors, 'end_date', 'Ends')}
              onChange={(event) => setNewEnd(event.target.value)}
            />
          </FormGrid>
        </form>
      </Modal>

      <EditDialog
        row={editingSession}
        title={editingSession ? `Edit ${editingSession.name}` : ''}
        description="A session's name and dates. Its status moves through the two actions on the row, not through this form."
        success="Session updated"
        onClose={() => setEditingSession(null)}
        onSaved={sessions.reload}
        save={(row, body) => api.patch(`/sessions/${row.id}`, body)}
        initial={(row) => ({
          name: row.name,
          start_date: row.start_date,
          end_date: row.end_date,
        })}
        fields={[
          { name: 'name', label: 'Name', required: true },
          { name: 'start_date', label: 'Starts', kind: 'date', required: true },
          { name: 'end_date', label: 'Ends', kind: 'date', required: true },
        ]}
      />

      <Modal
        open={pending !== null}
        onClose={closeAction}
        title={
          pending?.action === 'activate'
            ? `Make ${pending.session.name} the current session?`
            : `Close ${pending ? pending.session.name : 'this session'}?`
        }
        description={
          pending?.action === 'activate'
            ? 'New work is filed under the current session. Any other session that was current stops being so — but it is not closed, and can be made current again.'
            : 'Closing is final: a closed session cannot be edited and cannot be made current again. Its classes, exams and fees are untouched and stay readable. A session is never deleted — closing is how one ends.'
        }
        size="sm"
        busy={sessionBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={sessionBusy}
              onClick={closeAction}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`btn ${pending?.action === 'close' ? 'btn-danger' : 'btn-primary'}`}
              disabled={sessionBusy}
              aria-busy={sessionBusy}
              onClick={() => void runSessionAction()}
            >
              {sessionBusy
                ? 'Working…'
                : pending?.action === 'activate'
                  ? 'Make current'
                  : 'Close session'}
            </button>
          </>
        }
      >
        {actionError ? <Notice tone="error">{actionError}</Notice> : null}
      </Modal>
    </div>
  );
}
