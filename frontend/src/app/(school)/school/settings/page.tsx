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
 * ## `logo_path` and `favicon_path` are not on the form
 *
 * Both are columns and both are accepted by the schema. Neither has an upload route: `UPLOAD_RULES`
 * defines no profile for a school logo, so there is nowhere for a file to go and the column expects
 * a path this product cannot produce. A text box asking an administrator to type a server path would
 * be asking them to guess at the filesystem. Recorded here rather than rendered.
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

/** `GET /school-settings` — the ten §14.1 fields, plus the two path columns this screen leaves alone. */
interface Settings {
  name: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
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
  'theme',
  'currency',
  'timezone',
];

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
  const [sessionError, setSessionError] = useState<string | null>(null);

  const canEditSettings = can('school.settings.manage');
  const canManageSessions = can('sessions.manage');

  function setValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function saveSettings() {
    if (busy || !settings) return;
    const base = seed(settings);
    const changed: Record<string, unknown> = {};
    for (const key of SETTING_KEYS) {
      if (values[key] === base[key]) continue;
      /* Every one of the eight is nullable, so clearing a field clears the column. */
      changed[key] = values[key].trim() === '' ? null : values[key].trim();
    }
    if (Object.keys(changed).length === 0) return;

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
        setFieldErrors(Array.isArray(caught.details) ? caught.fieldErrors() : {});
        setError(
          Array.isArray(caught.details) ? caught.bannerFor(SETTING_KEYS as string[]) : caught.message
        );
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function createSession() {
    if (sessionBusy) return;
    setSessionBusy(true);
    setSessionError(null);
    try {
      await api.post('/sessions', {
        name: newName.trim(),
        start_date: newStart,
        end_date: newEnd,
      });
      success('Session created', 'It starts as upcoming. Activate it to make it the current session.');
      setCreating(false);
      setNewName('');
      setNewStart('');
      setNewEnd('');
      sessions.reload();
    } catch (caught) {
      setSessionError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setSessionBusy(false);
    }
  }

  async function runSessionAction() {
    if (!pending || sessionBusy) return;
    setSessionBusy(true);
    setSessionError(null);
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
      setSessionError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.'
      );
    } finally {
      setSessionBusy(false);
    }
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
                          setSessionError(null);
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
                        setSessionError(null);
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
        description="What this school is called on its own documents, and the academic sessions its work is filed under."
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
                  value={values.name ?? ''}
                  error={fieldErrors.name}
                  onChange={(event) => setValue('name', event.target.value)}
                  hint="Used on documents and reports. Left blank, the school's registered name is used."
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
                <Field
                  id="website"
                  label="Website"
                  value={values.website ?? ''}
                  error={fieldErrors.website}
                  onChange={(event) => setValue('website', event.target.value)}
                  hint="Must carry http:// or https://."
                />
              </FormSection>

              <FormSection
                title="Presentation and locale"
                description="What the school's money and its dates are read as."
              >
                <FormGrid>
                  <Field
                    id="currency"
                    label="Currency"
                    value={values.currency ?? ''}
                    error={fieldErrors.currency}
                    onChange={(event) => setValue('currency', event.target.value)}
                    hint="Three-letter code. Fees and finance are recorded in it."
                  />
                  <Field
                    id="timezone"
                    label="Timezone"
                    value={values.timezone ?? ''}
                    error={fieldErrors.timezone}
                    onChange={(event) => setValue('timezone', event.target.value)}
                    hint="An IANA name such as Asia/Karachi."
                  />
                </FormGrid>
                <Field
                  id="theme"
                  label="Theme"
                  value={values.theme ?? ''}
                  error={fieldErrors.theme}
                  onChange={(event) => setValue('theme', event.target.value)}
                  hint="A named theme. There is no fixed vocabulary in the source, so this is free text."
                />
              </FormSection>

              <Notice tone="info">
                {/*
                  * Said rather than rendered as an input — see the header. Two of §14.1's ten fields
                  * are file paths with no upload route behind them anywhere in this API.
                  */}
                The logo and favicon are the two §14.1 fields this screen does not offer: they are
                stored as file paths and this product has no route that uploads one, so a box here
                would be asking you to type a path on the server.
              </Notice>

              <FormActions>
                <SubmitButton busy={busy} busyLabel="Saving…" fullWidth={false}>
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
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                Create a session
              </button>
            ) : null}
          </div>
        )}
      </TabPanel>

      <Modal
        open={creating}
        onClose={() => {
          if (!sessionBusy) setCreating(false);
        }}
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
              onClick={() => setCreating(false)}
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
          {sessionError ? <Notice tone="error">{sessionError}</Notice> : null}
          <Field
            id="session-name"
            label="Name"
            required
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            hint="What the school calls it — 2026–27, for instance."
          />
          <FormGrid>
            <Field
              id="session-start"
              label="Starts"
              type="date"
              required
              value={newStart}
              onChange={(event) => setNewStart(event.target.value)}
            />
            <Field
              id="session-end"
              label="Ends"
              type="date"
              required
              value={newEnd}
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
        onClose={() => {
          if (!sessionBusy) setPending(null);
        }}
        title={
          pending?.action === 'activate'
            ? `Make ${pending.session.name} the current session?`
            : `Close ${pending ? pending.session.name : 'this session'}?`
        }
        description={
          pending?.action === 'activate'
            ? 'New work is filed under the current session. Any other session that was current stops being so — but it is not closed, and can be made current again.'
            : 'Closing is final: a closed session cannot be edited and cannot be made current again. Its classes, exams and fees are untouched and stay readable. There is no delete — this is the operation §14.2 names.'
        }
        size="sm"
        busy={sessionBusy}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={sessionBusy}
              onClick={() => setPending(null)}
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
        {sessionError ? <Notice tone="error">{sessionError}</Notice> : null}
      </Modal>
    </div>
  );
}
