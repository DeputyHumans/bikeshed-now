// SPDX-License-Identifier: Apache-2.0
// Signing in, signing up, and email verification (SPEC §3, §14).

import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useAuth, type PopupProvider } from "../auth";
import { signingInLabel } from "../components/AddressNotice";
import { PasswordForm } from "../components/PasswordForm";
import { auth } from "../firebase";
import { Icon } from "../components/Icon";
import { Loading } from "../components/Spinner";
import { isEmailShapeValid } from "../generated/policy";
import { safeNext } from "../next";

/**
 * Sign-in and sign-up are ONE screen, because the distinction is not one the
 * person makes: they pick a provider, and whether an account already exists is
 * something the system knows and they do not.
 *
 * The states that follow are the interesting part, and each is a STATE rather
 * than an error:
 *
 *   needs_email        GitHub returned no address, because the account keeps it
 *                      private. The ACL is keyed by email, so an account with
 *                      no address cannot be granted anything at all.
 *   needs_verification the address is not verified. Sign-up BLOCKS here,
 *                      because anything already shared with that address would
 *                      otherwise be handed to whoever claimed it.
 *   not_allowed        the deployment's allowlist does not include it. Nothing
 *                      went wrong; the next action is to ask an administrator.
 */

async function callVerify(path: string, body: unknown): Promise<Response> {
  const token = await auth.currentUser?.getIdToken();
  return fetch(`/verify/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
}

function ProviderButtons({
  onPick,
  busy,
}: {
  onPick: (provider: PopupProvider) => void;
  busy: boolean;
}) {
  return (
    <>
      <button
        type="button"
        className="btn btn-primary provider-btn"
        disabled={busy}
        onClick={() => onPick("google")}
      >
        Continue with Google
      </button>
      <button
        type="button"
        className="btn provider-btn"
        disabled={busy}
        onClick={() => onPick("github")}
      >
        Continue with GitHub
      </button>
    </>
  );
}

export function SignUp() {
  const {
    gate,
    error,
    notAllowedMessage,
    linkPrompt,
    movingTo,
    signIn,
    completeLink,
    signOut,
    refresh,
    clearError,
  } = useAuth();
  // Read before any early return: hook order must not change between renders.
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  // Which request is in flight. Confirm and "Send another code" share a screen,
  // and only the one that was pressed should say it is working.
  const [busyOn, setBusyOn] = useState<"code" | "confirm" | "password" | null>(null);
  const busy = busyOn !== null;
  const [sent, setSent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [signInHint, setSignInHint] = useState("");

  useEffect(() => {
    // A deployment-authored sentence, fetched only when it might be shown. It
    // never contains the allowlist itself — publishing that would tell every
    // anonymous visitor who is allowed in.
    if (gate !== "not_allowed") return;
    void fetch("/config")
      .then((r) => r.json())
      .then((c: { signInHint?: string }) => setSignInHint(c.signInHint ?? ""))
      .catch(() => setSignInHint(""));
  }, [gate]);

  /**
   * Nothing to sign up for.
   *
   * This screen answers FOUR gates — signed_out, needs_email,
   * needs_verification, not_allowed — and every body below is conditioned on
   * one of them. `ready` and `loading` are not among them, so they rendered the
   * title and the step list with nothing underneath, and nothing moved the
   * person on: an empty card, forever, for somebody who had just successfully
   * signed in.
   *
   * `RequireAccount` never hands those two gates here. But /signup is a URL,
   * and since the landing page started linking to it, the person who completes
   * a sign-in is standing on it when the gate flips to ready. Deciding this
   * here rather than in the route covers every call site, including the next
   * one somebody adds.
   *
   * Placed after every hook, because an early return before one changes the
   * hook order between renders.
   */
  if (gate === "loading") return <Loading label={signingInLabel(movingTo)} />;
  // Back to what they were doing, when that was somewhere on this site — a
  // reader who pressed Fork on a document comes back to it to finish (SPEC §21).
  if (gate === "ready") return <Navigate to={next} replace />;

  const start = async () => {
    setBusyOn("code");
    setNotice(null);
    try {
      const res = await callVerify("start", { email: email.trim() || undefined });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setNotice(body.error ?? "Could not send a code.");
        return;
      }
      setSent(true);
    } finally {
      setBusyOn(null);
    }
  };

  const complete = async () => {
    setBusyOn("confirm");
    setNotice(null);
    try {
      const res = await callVerify("complete", { code: code.trim() });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setNotice(body.error ?? "That code did not work.");
        return;
      }
      await refresh();
    } finally {
      setBusyOn(null);
    }
  };

  const step =
    gate === "needs_email" ? 2 : gate === "needs_verification" ? 3 : 1;

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-title">
          {gate === "signed_out" ? "Sign in to Bikeshed" : "Almost there"}
        </h1>

        <div className="auth-steps" aria-label="Progress">
          <span className="auth-step" aria-current={step === 1 ? "step" : undefined}>
            1. Provider
          </span>
          <span className="auth-step" aria-current={step === 2 ? "step" : undefined}>
            2. Address
          </span>
          <span className="auth-step" aria-current={step === 3 ? "step" : undefined}>
            3. Verify
          </span>
        </div>

        {error ? (
          <div className="banner banner-error" role="alert">
            {error}
            <button type="button" className="btn btn-quiet btn-sm" onClick={clearError}>
              Dismiss
            </button>
          </div>
        ) : null}

        {linkPrompt ? (
          <div className="auth-notice" role="status">
            <strong>{linkPrompt.email} already signs in with {linkPrompt.existingProvider}.</strong>
            <p className="field-hint">
              {/* One account per email is a correctness requirement, not a
                  convenience: the ACL is keyed by address, so two accounts
                  sharing one would be an access-control bug. */}
              One address is one account here. Sign in that way once, and both
              methods will work from then on.
            </p>
            <div className="auth-notice-row">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void completeLink()}
              >
                Continue with {linkPrompt.existingProvider}
              </button>
            </div>
          </div>
        ) : null}

        {gate === "signed_out" ? (
          <>
            <p className="auth-lead">
              Anything already shared with your address is waiting the moment you
              sign in — you do not need an invitation first.
            </p>
            <ProviderButtons onPick={(p) => void signIn(p)} busy={busy} />
            {/* Below the providers, because an address and a password is the
                method somebody falls back to, not the one they reach for. */}
            <PasswordForm busy={busy} setBusy={(b) => setBusyOn(b ? "password" : null)} />
          </>
        ) : null}

        {gate === "needs_email" ? (
          <>
            <p className="auth-lead">
              GitHub did not give us an address, because yours is private. Sharing
              here works by email, so an account without one cannot be granted
              anything.
            </p>
            <div className="field">
              <label className="field-label" htmlFor="signup-email">
                Your email address
              </label>
              <input
                id="signup-email"
                className="input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {email && !isEmailShapeValid(email) ? (
                <span className="field-error">That does not look like an address.</span>
              ) : null}
            </div>
            <button
              type="button"
              className="btn btn-primary provider-btn"
              disabled={busy || !isEmailShapeValid(email)}
              aria-busy={busyOn === "code"}
              onClick={() => void start()}
            >
              Send me a code
            </button>
          </>
        ) : null}

        {gate === "needs_verification" ? (
          <>
            <p className="auth-lead">
              {sent
                ? "Enter the six-digit code we sent you. It expires in fifteen minutes."
                : "Confirm your address before continuing."}
            </p>
            {/* This step is what makes GitHub sign-in safe here. Without it,
                signing in with an unverified address that matches a pending
                share would hand over somebody else's documents. */}
            {sent ? (
              <>
                <div className="field">
                  <label className="field-label" htmlFor="verify-code">
                    Code
                  </label>
                  <input
                    id="verify-code"
                    className="input verify-code-input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-primary provider-btn"
                  disabled={busy || code.length !== 6}
                  aria-busy={busyOn === "confirm"}
                  onClick={() => void complete()}
                >
                  Confirm
                </button>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  disabled={busy}
                  aria-busy={busyOn === "code"}
                  onClick={() => void start()}
                >
                  Send another code
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-primary provider-btn"
                disabled={busy}
                aria-busy={busyOn === "code"}
                onClick={() => void start()}
              >
                Send me a code
              </button>
            )}
          </>
        ) : null}

        {gate === "not_allowed" ? (
          <div className="auth-notice" role="status">
            {/* A rejected address is a STATE, not a failure: --color-danger is
                reserved for something that actually went wrong. Their job now is
                to ask an administrator, and what the administrator needs is the
                exact lowercased address the allowlist will match. */}
            <strong>This deployment does not accept your address yet.</strong>
            <p className="field-hint">
              {notAllowedMessage || signInHint || "Ask whoever runs this deployment to add you."}
            </p>
            <div className="auth-notice-row">
              <code>{auth.currentUser?.email?.toLowerCase()}</code>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(
                    auth.currentUser?.email?.toLowerCase() ?? "",
                  );
                  setNotice("Address copied.");
                }}
              >
                <Icon name="copy" size={14} /> Copy my address
              </button>
            </div>
            <div className="auth-notice-row">
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => void signOut()}>
                Use a different account
              </button>
            </div>
          </div>
        ) : null}

        {notice ? (
          <p className="field-hint" role="status">
            {notice}
          </p>
        ) : null}
      </div>
    </div>
  );
}
