'use client';

/**
 * Create an Organization Admin — the owner's decision D18.
 *
 * SRS:97 places the role between the platform and its schools and leaves its workflows "Not
 * Specified". It was seeded with read-only grants and nothing could create an account for it; D18 has
 * the Super Admin create them. `POST /users` with `role: 'organization_admin'` is that path:
 * `users.validation.js` requires `organization_id` and a `name` for the role and forbids `school_id`
 * and `profile_id`, and `users.service.createOrganizationAdmin()` refuses any caller that is not
 * platform-scoped, with `PLATFORM_SCOPE_REQUIRED`.
 *
 * ## Why it opens from an organization's row
 *
 * An Organization Admin belongs to an organization and to nothing else, and there is no organization
 * detail screen. Opened from the row, the one foreign key the account needs is already chosen — no
 * picker capped at a hundred rows, no chance of the wrong organization — which is the pattern the
 * other logins follow: D1's are created from the teacher, staff or student row they belong to, and a
 * Principal from the school it is for (`principals/new?school_id=`). A `users/new` screen with an
 * organization select would have been the one creation path in the product that asks for its owner
 * instead of starting from it.
 *
 * ## What it asks for
 *
 * The body `createOrganizationAdmin()` reads: `name`, `email`, `username`, an optional `phone`, and a
 * **temporary** password. The account is created active with `must_change_password`, as every login
 * D1 created is, so the password is generated here, can be replaced, and is shown once after the
 * account exists — the way `components/createLogin.tsx` hands over a school login. That dialog is not
 * reused because its targets are the seven school roles and it has no organization to send; this is
 * its organization-scoped counterpart, deliberately the same in what it shows.
 *
 * The role's grants are the seeded ones (`permissions.js` `ORGANIZATION_ADMIN`): read access across
 * the organization's schools and its billing. Nothing here widens them.
 */

import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { splitApiErrors } from '@/lib/formErrors';
import { Modal } from '@/components/overlay';
import { Field, Notice, SubmitButton } from '@/components/form';

/** The organization row the account is for — what the dialog reads off it. */
export interface AdminOrganization {
  id: number;
  name: string;
  code: string;
  status: string;
}

/** Every field this dialog has an input for; a 422 naming anything else goes to the banner. */
const FIELDS = new Set(['name', 'email', 'username', 'phone', 'password']);

/**
 * Sixteen characters from an alphabet with no look-alikes (no 0/O, 1/l/I), from the platform's
 * CSPRNG — `components/createLogin.tsx`'s generator, repeated because that file does not export it.
 */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('');
}

export function OrganizationAdminDialog({
  organization,
  onClose,
}: {
  /** The organization to create an admin for; null keeps the dialog closed. */
  organization: AdminOrganization | null;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /* After success: the credentials to hand over, shown once, and whether the verification mail went. */
  const [created, setCreated] = useState<{
    username: string;
    password: string;
    verificationEmailSent: boolean;
  } | null>(null);

  /*
   * A fresh form per organization, so the last dialog's values never decide this one's account.
   *
   * An effect runs after the render it follows, so on its own this left the first render of a
   * reopened dialog holding the last one's state — the success view, temporary password included.
   * `organizations/page.tsx` therefore keys the dialog on the organization, which makes every opening
   * a fresh mount; this is what generates that mount's password, and the reset for a caller that
   * does not key it.
   */
  useEffect(() => {
    if (!organization) return;
    setName('');
    setEmail('');
    setUsername('');
    setPhone('');
    setPassword(generatePassword());
    setBanner(null);
    setFieldErrors({});
    setCreated(null);
  }, [organization]);

  /*
   * Closing forgets the credentials. The success view is the one place a temporary password is shown,
   * and it stayed in this component's state after the dialog closed.
   */
  function close() {
    setCreated(null);
    setPassword('');
    onClose();
  }

  async function submit() {
    if (!organization || busy) return;
    setBusy(true);
    setBanner(null);
    setFieldErrors({});
    try {
      const body: Record<string, unknown> = {
        role: 'organization_admin',
        organization_id: organization.id,
        name: name.trim(),
        email: email.trim(),
        username: username.trim(),
        /* Verbatim: a trimmed credential is a different secret from the one handed over. */
        password,
      };
      /* `phone` is `.empty('')`, so a blank one is simply not sent. */
      if (phone.trim()) body.phone = phone.trim();
      const result = await api.post<{ verificationEmailSent?: boolean }>('/users', body);
      setCreated({
        username: username.trim().toLowerCase(),
        password,
        verificationEmailSent: result?.verificationEmailSent === true,
      });
    } catch (caught) {
      if (caught instanceof ApiError) {
        /*
         * `EMAIL_TAKEN` / `USERNAME_TAKEN` carry an object for `details`, which `ApiError` keeps out of
         * the field errors, so they reach the banner with a message that names the field in words.
         */
        const { perField, banner: message } = splitApiErrors(caught, FIELDS);
        setFieldErrors(perField);
        setBanner(message);
      } else {
        setBanner('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  /*
   * `resolveTenant` refuses every request from an account whose organization is suspended or archived
   * (`ORGANIZATION_SUSPENDED` / `ORGANIZATION_ARCHIVED`), so an admin created for one can do nothing
   * until it is active again. The API does not refuse the creation; the dialog says what it means.
   */
  const inactive = organization !== null && organization.status !== 'active';

  return (
    <Modal
      open={organization !== null}
      onClose={() => {
        if (!busy) close();
      }}
      title={created ? 'Organization Admin created' : `Add an admin for ${organization?.name ?? ''}`}
      description={
        created
          ? 'Give them these details. The password is temporary: they must choose their own the first time they sign in.'
          : 'An Organization Admin reads every school in this organization and its billing — the role’s seeded grants, which this does not change. The password below is temporary; they will be asked to change it the first time they sign in.'
      }
      size="md"
      busy={busy}
      footer={
        created ? (
          <button type="button" onClick={close} className="btn btn-primary">
            Done
          </button>
        ) : (
          <>
            <button type="button" onClick={close} disabled={busy} className="btn btn-secondary">
              Cancel
            </button>
            <SubmitButton form="organization-admin" busy={busy} busyLabel="Creating…" fullWidth={false}>
              Create admin
            </SubmitButton>
          </>
        )
      }
    >
      {created ? (
        <div className="space-y-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Username</dt>
            <dd className="font-mono text-ink">{created.username}</dd>
            <dt className="text-muted">Temporary password</dt>
            <dd className="font-mono text-ink break-all">{created.password}</dd>
          </dl>
          {/*
            * `verificationEmailSent` is the only signal that FR-AUTH-006's mail did not go out — the
            * service logs the failure and creates the account anyway.
            */}
          {created.verificationEmailSent ? null : (
            <Notice tone="warn">
              The verification email could not be sent. The account exists all the same; once signed
              in, they can ask for the email again.
            </Notice>
          )}
        </div>
      ) : (
        <form
          id="organization-admin"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {banner ? <Notice tone="error">{banner}</Notice> : null}

          {inactive ? (
            <Notice tone="warn">
              {organization?.name} is {organization?.status}. The account can be created, but every
              request it makes is refused until the organization is active again.
            </Notice>
          ) : null}

          <Field
            id="org-admin-name"
            label="Name"
            required
            maxLength={160}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={fieldErrors.name}
          />

          {/*
            * `noValidate` on the form is load-bearing here, as on the principal form: the API accepts
            * internal domains such as `@msms.local` and the browser's `type="email"` check does not.
            */}
          <Field
            id="org-admin-email"
            label="Email"
            type="email"
            required
            maxLength={180}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={fieldErrors.email}
            hint="Where the verification email goes. Unique across the platform, and stored in lower case."
          />

          <Field
            id="org-admin-username"
            label="Username"
            required
            maxLength={80}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            error={fieldErrors.username}
            hint="At least 3 characters, starting with a letter or digit; then letters, digits, dots, hyphens and underscores. They can sign in with this or with the email."
          />

          <Field
            id="org-admin-phone"
            label="Phone"
            maxLength={40}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            error={fieldErrors.phone}
          />

          <div className="space-y-2">
            <Field
              id="org-admin-password"
              label="Temporary password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={fieldErrors.password}
              hint="Generated for you; change it if you prefer. It works until their first sign-in, when they choose their own."
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPassword(generatePassword())}>
              Generate another
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
