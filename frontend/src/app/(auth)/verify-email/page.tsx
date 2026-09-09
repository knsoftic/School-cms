'use client';

/**
 * Confirm an email address from an emailed link — SRS §7 (FR-AUTH-006), row 4.2.
 *
 * ## Why this submits on load rather than showing a button
 *
 * The user already acted: they clicked the link in their mail. A "Confirm your email" button here
 * would be asking them to confirm that they meant to confirm.
 *
 * The cost of that choice is that a link preview or a mail scanner fetching the URL would consume
 * the token — but this page is a client component that POSTs, and neither of those executes
 * JavaScript. `POST /auth/verify-email` is a POST for exactly this reason: a GET would be spent by
 * anything that followed the link, including the security scanners that open every link in an
 * incoming message before the recipient sees it.
 *
 * The effect runs once. Strict mode double-invokes effects in development, and the second run would
 * present an already-consumed token and report failure on a verification that had just succeeded.
 */

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { ApiError, api } from '@/lib/apiClient';
import { AuthCard, Notice } from '@/components/form';

type State = 'working' | 'verified' | 'failed' | 'no-token';

function VerifyEmail() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [state, setState] = useState<State>(token ? 'working' : 'no-token');
  const [message, setMessage] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    (async () => {
      try {
        await api.post('/auth/verify-email', { token });
        setState('verified');
      } catch (caught) {
        setState('failed');
        setMessage(
          caught instanceof ApiError
            ? caught.message
            : 'Could not reach the server. Check your connection and try again.'
        );
      }
    })();
  }, [token]);

  if (state === 'no-token') {
    return (
      <AuthCard title="That link is incomplete">
        <div className="mt-8">
          <Notice tone="error">
            This verification link is missing its token. It may have been broken across two lines by
            an email client — try copying the whole link.
          </Notice>
        </div>
      </AuthCard>
    );
  }

  if (state === 'working') {
    return <AuthCard title="Confirming your email address" subtitle="One moment…" />;
  }

  if (state === 'verified') {
    return (
      <AuthCard title="Email confirmed">
        <div className="mt-8 space-y-4">
          <Notice tone="success">Your email address has been confirmed.</Notice>
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
    <AuthCard title="That link did not work">
      <div className="mt-8 space-y-4">
        {/*
          * One message covers an unknown token, a used one and an expired one — the service gives a
          * single code for all three, and inventing a more specific explanation here would be a
          * guess presented as fact. Requesting a new link is the action in every case.
          */}
        <Notice tone="error">{message}</Notice>
        {/*
          * This used to say "request a new link from your profile". There is no profile screen, and
          * `POST /auth/resend-verification` — which is a real protected route — had **no caller
          * anywhere in `frontend/src`**, so the instruction named a screen that does not exist and an
          * action nothing could reach. The control now lives in the account menu, which is where the
          * account's own actions already are, and this says where to find it.
          */}
        <p className="text-sm text-muted">
          Verification links expire, and each one can be used only once. Sign in, then choose
          <span className="font-medium text-ink"> Resend verification email</span> from the account
          menu at the top right.
        </p>
        <p className="text-sm">
          <a href="/login" className="font-medium text-teal underline underline-offset-4 hover:text-teal-deep">
            Go to sign in
          </a>
        </p>
      </div>
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<AuthCard title="Confirming your email address" subtitle="One moment…" />}>
      <VerifyEmail />
    </Suspense>
  );
}
