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

/*
 * `malformed` is a token that is present but the wrong shape — wrapped, truncated or padded by a mail
 * client. See the catch below for why it cannot share `failed`.
 */
type State = 'working' | 'verified' | 'failed' | 'no-token' | 'malformed';

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
        /*
         * A token that fails the shape rule never reaches the service. `verifyEmail`'s schema is
         * `singleUseToken` — 20 to 200 base64url characters — so a link a mail client wrapped or cut
         * short is refused by `validate.js`, whose top-level message is the developer string
         * "Validation failed". Echoing that told the user nothing about the link. It is the same
         * situation as a missing token, so it gets the same explanation.
         */
        if (caught instanceof ApiError && caught.code === 'VALIDATION_ERROR') {
          setState('malformed');
          return;
        }
        setState('failed');
        setMessage(
          caught instanceof ApiError
            ? caught.message
            : 'Could not reach the server. Check your connection and try again.'
        );
      }
    })();
  }, [token]);

  if (state === 'no-token' || state === 'malformed') {
    return (
      <AuthCard title="That link is incomplete">
        <div className="mt-8">
          <Notice tone="error">
            {state === 'no-token'
              ? 'This verification link is missing its token.'
              : 'This verification link has been damaged on its way to you.'}{' '}
            It may have been broken across two lines by an email client — try copying the whole link.
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
          * guess presented as fact. Requesting a new link is the action in every case. A fourth
          * case — a token of the wrong shape — never reaches the service and is answered by
          * validation instead; it is caught above and shown as an incomplete link, not here.
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
