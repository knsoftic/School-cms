'use client';

/**
 * Request a password reset — SRS §7 (FR-AUTH-005 step one), checklist row 4.2.
 *
 * ## This page always says the same thing
 *
 * `POST /auth/forgot-password` answers **202** whether or not the address is on file — the controller
 * sets it (`auth.controller.js`, "always answers 202"), and `auth.service.js`'s header explains why:
 * this is *"the endpoint an attacker would point a list of addresses at, so it is the one that
 * matters most."* This header used to say 200; nothing here reads the status, so the slip was only in
 * the prose, but it named the wrong contract.
 *
 * The UI has to hold that line or it gives away for free what the API refused to say. Two ways it
 * would leak without meaning to, both avoided here:
 *
 *   - showing a different message on success than on failure — there is only one message, and it is
 *     rendered on **any** resolved outcome;
 *   - leaving the form ready to resubmit, so a user could tell "accepted" from "rejected" by whether
 *     the page moved on. The form is replaced by the notice.
 *
 * The notice repeats the address that was typed and offers to go back and use a different one. Both
 * are shown on every resolved outcome alike, so neither says anything the single message does not:
 * the address is the user's own input, and the way back is there whether or not it matched. Without
 * them a typo in the address was invisible — the page said "check your email" about an address the
 * user could no longer see, and the only way to retry was to reload.
 *
 * A genuinely failed request — the network is down, the API returned 500 — is a different thing and
 * is shown as itself. That distinction is safe: it says nothing about the address.
 */

import { useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { AuthCard, Field, Notice, SubmitButton, focusFirstInvalidField } from '@/components/form';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (caught) {
      if (caught instanceof ApiError) {
        /*
         * A 422 here means the address was not a valid address at all — a shape complaint, not an
         * existence one, so showing it reveals nothing. Anything else is a server-side failure.
         */
        if (caught.details.length) {
          setFieldErrors(caught.fieldErrors());
          focusFirstInvalidField();
        } else {
          setError(caught.message);
        }
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <AuthCard title="Check your email">
        <div className="mt-8 space-y-4">
          <Notice tone="success">
            If <strong className="break-all font-semibold">{email.trim()}</strong> belongs to an
            account, a password reset link is on its way. The link expires shortly, so use it soon.
          </Notice>
          <p className="text-sm text-muted">
            Wrong address, or nothing arrived?{' '}
            <button
              type="button"
              /* Back to the form with the address still in it — a typo is the likeliest reason. */
              onClick={() => setSent(false)}
              className="font-medium text-teal underline underline-offset-4 hover:text-teal-deep"
            >
              Use a different address
            </button>
          </p>
          <p className="text-sm">
            <a href="/login" className="font-medium text-teal underline underline-offset-4 hover:text-teal-deep">
              Back to sign in
            </a>
          </p>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="We'll email you a link to choose a new one."
    >
      <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
        <Field
          id="email"
          label="Email address"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={fieldErrors.email}
        />

        {error ? <Notice tone="error">{error}</Notice> : null}

        <SubmitButton busy={submitting} busyLabel="Sending…">
          Send reset link
        </SubmitButton>
      </form>

      <p className="mt-6 text-sm">
        <a href="/login" className="font-medium text-teal underline underline-offset-4 hover:text-teal-deep">
          Back to sign in
        </a>
      </p>
    </AuthCard>
  );
}
