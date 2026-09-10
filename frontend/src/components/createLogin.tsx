'use client';

/**
 * Create a login for someone the school has on record — the owner's decision D1.
 *
 * FR-TEACHER-002's precondition is "Teacher account exists", and nothing in the product created one:
 * only a Principal (by the Super Admin) and a Parent (with their profile) had a creation path, so no
 * teacher, staff member or student could ever sign in. `POST /users` is that path now, on
 * `users.manage` — "Create / edit users", already the school leadership's. This dialog is its one form,
 * shared by the teacher, staff and student lists and by the School Admins panel on Settings.
 *
 * ## What it asks for, and what it does not
 *
 * An email, a username and a **temporary** password. The account is created with
 * `must_change_password`, so the first sign-in forces a new one — the same way a Parent's account
 * starts. The name is the profile's own unless this is a School Admin, who has no profile. The role is
 * never chosen here: it is the kind of record the login is for, and for staff it is their category,
 * which the server enforces rather than trusting this form.
 *
 * The password can be generated. It is shown once, after the account exists, so the administrator can
 * hand it over; nothing stores it anywhere else, and it stops working at the first sign-in.
 */

import { useEffect, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { splitApiErrors } from '@/lib/formErrors';
import { Modal } from '@/components/overlay';
import { Field, Notice, SubmitButton } from '@/components/form';

/** Who the login is for. `profileId` is absent only for a School Admin, who has no profile row. */
export interface LoginTarget {
  role: 'school_admin' | 'teacher' | 'accountant' | 'receptionist' | 'librarian' | 'staff' | 'student';
  /** Shown in the dialog's title. */
  person: string;
  profileId?: number;
  /** Pre-filled from the profile's own email when it has one. */
  email?: string | null;
}

/** The §15.4 staff categories, mapped onto the role a login for that person takes. */
export const ROLE_FOR_STAFF_CATEGORY: Record<string, LoginTarget['role']> = {
  receptionist: 'receptionist',
  accountant: 'accountant',
  librarian: 'librarian',
  other_staff: 'staff',
};

const ROLE_LABEL: Record<LoginTarget['role'], string> = {
  school_admin: 'School Admin',
  teacher: 'Teacher',
  accountant: 'Accountant',
  receptionist: 'Receptionist',
  librarian: 'Librarian',
  staff: 'Staff',
  student: 'Student',
};

const FIELDS = new Set(['name', 'email', 'username', 'password']);

/**
 * Sixteen characters from an alphabet with no look-alikes (no 0/O, 1/l/I), from the platform's CSPRNG —
 * a temporary password someone may have to read aloud or copy by hand.
 */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('');
}

/** A username suggestion from a name: lower-case letters and digits joined by dots. */
function suggestUsername(person: string): string {
  return person
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 60);
}

export function CreateLoginDialog({
  target,
  schoolId,
  onClose,
  onCreated,
}: {
  target: LoginTarget | null;
  /** Only for a platform caller acting on a school; a school user's own school is used regardless. */
  schoolId?: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /* After success: the credentials to hand over, shown once. */
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);

  /* A fresh form per person, so the last dialog's values never decide this one's login. */
  useEffect(() => {
    if (!target) return;
    setName(target.role === 'school_admin' ? '' : target.person);
    setEmail(target.email ?? '');
    setUsername(target.role === 'school_admin' ? '' : suggestUsername(target.person));
    setPassword(generatePassword());
    setBanner(null);
    setFieldErrors({});
    setCreated(null);
  }, [target]);

  const isAdmin = target?.role === 'school_admin';

  async function submit() {
    if (!target) return;
    setBusy(true);
    setBanner(null);
    setFieldErrors({});
    try {
      const body: Record<string, unknown> = {
        role: target.role,
        email: email.trim(),
        username: username.trim(),
        password,
      };
      if (target.profileId) body.profile_id = target.profileId;
      if (isAdmin) body.name = name.trim();
      if (schoolId) body.school_id = schoolId;
      await api.post('/users', body);
      setCreated({ username: username.trim().toLowerCase(), password });
      onCreated();
    } catch (caught) {
      if (caught instanceof ApiError) {
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

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title={
        created
          ? 'Login created'
          : isAdmin
            ? 'Add a School Admin login'
            : `Create a login for ${target?.person ?? ''}`
      }
      description={
        created
          ? 'Give them these details. The password is temporary: they must choose their own the first time they sign in.'
          : `The login's role is ${target ? ROLE_LABEL[target.role] : ''}. The password below is temporary — they will be asked to change it the first time they sign in.`
      }
      size="md"
      busy={busy}
      footer={
        created ? (
          <button type="button" onClick={onClose} className="btn btn-primary">
            Done
          </button>
        ) : (
          <>
            <button type="button" onClick={onClose} disabled={busy} className="btn btn-secondary">
              Cancel
            </button>
            <SubmitButton form="create-login" busy={busy} busyLabel="Creating…">
              Create login
            </SubmitButton>
          </>
        )
      }
    >
      {created ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">Username</dt>
          <dd className="font-mono text-ink">{created.username}</dd>
          <dt className="text-muted">Temporary password</dt>
          <dd className="font-mono text-ink break-all">{created.password}</dd>
        </dl>
      ) : (
        <form
          id="create-login"
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {banner ? <Notice tone="error">{banner}</Notice> : null}

          {isAdmin ? (
            <Field
              id="name"
              label="Name"
              required
              maxLength={160}
              value={name}
              onChange={(event) => setName(event.target.value)}
              error={fieldErrors.name}
            />
          ) : null}

          <Field
            id="email"
            label="Email"
            type="email"
            required
            maxLength={180}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={fieldErrors.email}
            hint="Where the verification email goes. Unique across the platform."
          />

          <Field
            id="username"
            label="Username"
            required
            maxLength={80}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            error={fieldErrors.username}
            hint="Lower-case letters, digits, dots, hyphens and underscores. They can sign in with this or with the email."
          />

          <div className="space-y-2">
            <Field
              id="password"
              label="Temporary password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={fieldErrors.password}
              hint="Generated for you; change it if you prefer. It works once — they choose their own at the first sign-in."
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
