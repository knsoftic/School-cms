'use client';

/**
 * Sign in — SRS §7, checklist row 4.2.
 *
 * The field is `identifier`, not `email`: `auth.validation.js:105` accepts either an email address
 * or a username, and the service lowercases it once for both lookups. Labelling it "Email" would
 * make the username half of the contract invisible to every user who has one.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { landingRouteFor } from '@/lib/nav';
import { AuthCard, Field, Notice, SubmitButton, focusFirstInvalidField, PasswordField } from '@/components/form';

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    /*
     * The two blank fields are caught here rather than by the round trip that used to catch them.
     *
     * The form is `noValidate`, so nothing stopped an empty submit reaching the API: measured in the
     * browser against the deployed site, pressing Sign in with both fields empty sent
     * `POST /auth/login → 422` and painted the messages from the response. It worked, but it spent a
     * request and the network's latency to say something the page already knew, and it put a failed
     * call in the console on a page a signed-out user is expected to be on.
     *
     * The strings are the backend's own, so the wording does not fork: `auth.validation.js` labels
     * the field `identifier` with `Email or username`, and a 422 for a blank pair renders exactly
     * these two sentences. Anything subtler than "blank" — an address that is not an address, an
     * unknown account, a wrong password — is still the server's to answer, and is left to it. This
     * guard only removes the case where no credential was supplied at all.
     */
    const blank: Record<string, string> = {};
    if (!identifier.trim()) blank.identifier = 'Email or username is required';
    if (!password) blank.password = 'Password is required';

    if (Object.keys(blank).length > 0) {
      setFieldErrors(blank);
      focusFirstInvalidField();
      return;
    }

    setSubmitting(true);

    try {
      const result = await login(identifier, password);

      /*
       * `must_change_password` is set by **three** writers, not one. A grep of the backend for
       * `must_change_password: true` returns exactly `database/seeders/04-super-admin.js`,
       * `modules/principals/principals.service.js` and `modules/parents/parents.service.js` — both
       * of the latter inside the `db.User.create` of their own `create()`.
       *
       * This comment twice claimed otherwise. It first said only the seeder set it; a correction
       * then added "and, despite what this comment used to say, on nobody else: no code path sets it
       * when an administrator types a user's initial password" — which is the same error restated
       * more confidently. Every principal and every parent a school creates is routed through here
       * on their first sign-in.
       *
       * The branch itself was always right. The backend refuses everything but the change until the
       * flag clears, so routing anywhere else lands the user on a dashboard where every request
       * 403s and nothing explains why.
       */
      if (result.status === 'must-change-password') {
        router.replace('/change-password');
        return;
      }

      router.replace(landingRouteFor(result.profile));
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        focusFirstInvalidField();
        /*
         * The backend deliberately gives one message for an unknown identifier and a wrong password
         * alike, so that this form cannot be used to discover which accounts exist. It is shown as
         * received rather than reworded.
         */
        setError(caught.bannerFor(['identifier', 'password']));
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard title="Sign in" subtitle="Multi-School Management System">
      <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
        <Field
          id="identifier"
          label="Email or username"
          type="text"
          autoComplete="username"
          required
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          error={fieldErrors.identifier}
        />
        <PasswordField
          id="password"
          label="Password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={fieldErrors.password}
        />

        {error ? <Notice tone="error">{error}</Notice> : null}

        <SubmitButton busy={submitting} busyLabel="Signing in…">
          Sign in
        </SubmitButton>
      </form>

      <p className="mt-6 text-sm">
        <a href="/forgot-password" className="font-medium text-teal underline underline-offset-4 hover:text-teal-deep">
          Forgot your password?
        </a>
      </p>
    </AuthCard>
  );
}
