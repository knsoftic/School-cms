'use client';

/**
 * Choose a new password from an emailed link — SRS §7 (FR-AUTH-005 step two), row 4.2.
 *
 * The token arrives in the query string, because the link is opened from a mail client that carries
 * no session. It is never displayed and never put in a form field: it is a credential, and an input
 * holding it would be autofilled, copied and screenshotted like any other.
 *
 * ## `useSearchParams` forces a Suspense boundary
 *
 * Next's App Router prerenders pages statically by default, and a hook that reads the URL cannot run
 * at build time. Without the boundary below, `next build` fails outright — which is the framework
 * being right: the page genuinely cannot be fully static, and the boundary is where it says so.
 */

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { AuthCard, Notice, SubmitButton, focusFirstInvalidField, PasswordField } from '@/components/form';

function ResetForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();

    if (password !== confirmation) {
      setFieldErrors({ confirmation: 'The two passwords do not match.' });
      focusFirstInvalidField();
      return;
    }

    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        focusFirstInvalidField();
        /*
         * The service gives one code for an unknown token, a used one and an expired one — so this
         * message is deliberately unspecific, and is shown as received rather than guessed at.
         *
         * `bannerFor` rather than `details.length ? null : message`: `resetPassword` validates
         * `{ token, password }`, and the token is never put in a field — it is a credential from an
         * emailed link. So a mangled link produced a 422 whose only error named `token`, the banner
         * was suppressed because `details.length` was 1, and nothing was rendered anywhere. The two
         * ids below are the inputs this page actually has.
         */
        setError(caught.bannerFor(['password', 'confirmation']));
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  /*
   * A link with no token is a broken link, and saying so beats a form that can only fail. The check
   * is on the token's presence, not its validity — only the server can judge that.
   */
  if (!token) {
    return (
      <AuthCard title="That link is incomplete">
        <div className="mt-8 space-y-4">
          <Notice tone="error">
            This password reset link is missing its token. It may have been broken across two lines
            by an email client — try copying the whole link, or request a new one.
          </Notice>
          <p className="text-sm">
            <a href="/forgot-password" className="font-medium text-teal underline underline-offset-4 hover:text-teal-deep">
              Request a new link
            </a>
          </p>
        </div>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard title="Password changed">
        <div className="mt-8 space-y-4">
          {/*
            * Every other session was ended by the reset — `password_changed_at` invalidates access
            * tokens minted earlier and the stored refresh hash is cleared. Saying so is not a
            * detail: a user resetting because a device was stolen needs to know it worked.
            */}
          <Notice tone="success">
            Your password has been changed, and every other signed-in device has been signed out.
          </Notice>
          <p className="text-sm">
            <a href="/login" className="font-medium text-teal underline underline-offset-4 hover:text-teal-deep">
              Sign in
            </a>
          </p>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
        <PasswordField
          id="password"
          label="New password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={fieldErrors.password}
        />
        <PasswordField
          id="confirmation"
          label="Confirm new password"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          error={fieldErrors.confirmation}
        />

        {error ? <Notice tone="error">{error}</Notice> : null}

        <SubmitButton busy={submitting} busyLabel="Saving…">
          Set new password
        </SubmitButton>
      </form>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthCard title="Choose a new password" subtitle="Loading…" />}>
      <ResetForm />
    </Suspense>
  );
}
