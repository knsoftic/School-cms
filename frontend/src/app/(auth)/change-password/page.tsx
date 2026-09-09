'use client';

/**
 * Change password — SRS §7 (FR-AUTH-004), checklist row 4.2.
 *
 * ## Why this page is on the critical path rather than a settings corner
 *
 * The seeded Super Admin ships with `must_change_password` set — and so does **every principal and
 * every parent the product creates**. This header used to say the seeder "is the only writer that
 * does"; a grep for `must_change_password: true` returns three, and the other two are
 * `principals.service.js` and `parents.service.js`, each inside the `db.User.create` of its own
 * `create()`. That matters here more than anywhere: this is not a first-deployment screen that a
 * Super Admin passes through once, it is on the critical path of **every account a school creates**,
 * which is also why the landing route it sends people to had to stop being a two-way guess.
 *
 * Until the flag clears, `enforcePasswordChange` refuses everything except this call and logout —
 * including `GET /auth/me`. So it is still the first screen those accounts see, reached before a
 * profile can be loaded.
 *
 * That has a concrete consequence: this page cannot read `useAuth().profile`, because there is no
 * profile to read. It has only the access token the login left in memory, which is exactly what
 * `POST /auth/change-password` needs.
 *
 * The two fields sent are `currentPassword` and `password` — `auth.validation.js:140-145`, which also
 * refuses a new password equal to the old one with a message worth showing verbatim.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { landingRouteFor } from '@/lib/nav';
import { AuthCard, Notice, SubmitButton, focusFirstInvalidField, PasswordField } from '@/components/form';

export default function ChangePasswordPage() {
  const router = useRouter();
  const { changePassword } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();

    /*
     * The confirmation is checked here and nowhere else, deliberately. The API has no
     * `passwordConfirmation` field — a repeated password guards against a typo, which is a property
     * of this form rather than of the request. Sending it would be refused as an unknown key.
     */
    if (password !== confirmation) {
      setFieldErrors({ confirmation: 'The two passwords do not match.' });
      focusFirstInvalidField();
      return;
    }

    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      const profile = await changePassword(currentPassword, password);
      router.replace(landingRouteFor(profile));
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        focusFirstInvalidField();
        setError(caught.bannerFor(['currentPassword', 'password', 'confirmation']));
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard
      title="Choose a new password"
      subtitle="Your account requires a password change before you can continue."
    >
      <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
        <PasswordField
          id="currentPassword"
          label="Current password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          error={fieldErrors.currentPassword}
        />
        {/*
          * The password policy is the server's, and its refusal is shown verbatim rather than
          * restated here. A second copy of the rules in this file would be the frontend half of the
          * drift §30 Rule 1 warns about, one layer up.
          */}
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
          Change password
        </SubmitButton>
      </form>
    </AuthCard>
  );
}
