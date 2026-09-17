// SPDX-License-Identifier: Apache-2.0
// Sign in, or create an account, with an address and a password (SPEC §13).

import { useEffect, useState } from "react";
import { validatePassword } from "firebase/auth";
import { auth } from "../firebase";
import { useAuth } from "../auth";
import { allMet, requirementsFrom, type Requirement } from "../passwordPolicy";

/**
 * Why this is a separate credential form rather than a third provider button.
 *
 * Google and GitHub hand back an identity. An address and a password are a
 * claim, so this one has fields, a policy to satisfy, and a way back out when
 * the password is forgotten or has been outgrown by the policy.
 *
 * What it does NOT do is treat a password account as a lesser citizen. The gate
 * is `email_verified === true` for every method equally, and Firebase does not
 * set that for a password account — so creating one lands in exactly the
 * `needs_verification` state a GitHub user with an unvouched address reaches,
 * and the same Resend flow finishes the job. Adding this method changed no rule
 * anywhere, which is the whole argument for having one notion of verification.
 */
export function PasswordForm({ busy, setBusy }: { busy: boolean; setBusy: (b: boolean) => void }) {
  const { signInWithPassword, signUpWithPassword, resetPassword, error } = useAuth();

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [sentReset, setSentReset] = useState(false);

  /**
   * Ask Firebase, do not assume.
   *
   * `validatePassword` fetches the deployment's configured policy and caches it
   * on the Auth instance, so this is one network call per session and none per
   * keystroke. It is only run in signup mode: telling somebody signing IN that
   * their existing password is too short helps nobody.
   */
  useEffect(() => {
    if (mode !== "signup" || password.length === 0) {
      setRequirements([]);
      return;
    }
    let live = true;
    void validatePassword(auth, password)
      .then((status) => {
        if (live) setRequirements(requirementsFrom(status));
      })
      .catch(() => {
        // The policy could not be fetched. Say nothing rather than inventing
        // requirements; the server still enforces them on submit.
        if (live) setRequirements([]);
      });
    return () => {
      live = false;
    };
  }, [mode, password]);

  const ready =
    email.trim().length > 0 &&
    password.length > 0 &&
    (mode === "signin" || allMet(requirements));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      if (mode === "signup") await signUpWithPassword(email, password);
      else await signInWithPassword(email, password);
    } catch {
      // useAuth has already set a message a person can act on.
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="password-form" onSubmit={(e) => void submit(e)}>
      <div className="auth-divider" role="separator">
        <span>or</span>
      </div>

      <label className="field-label" htmlFor="auth-email">
        Email address
      </label>
      <input
        id="auth-email"
        className="input"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <label className="field-label" htmlFor="auth-password">
        Password
      </label>
      <input
        id="auth-password"
        className="input"
        type="password"
        /* Tells a password manager which of the two this is, so it offers to
           save a new one rather than autofilling an old one. */
        autoComplete={mode === "signup" ? "new-password" : "current-password"}
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-describedby={requirements.length > 0 ? "password-requirements" : undefined}
      />

      {requirements.length > 0 ? (
        <ul className="password-reqs" id="password-requirements">
          {requirements.map((r) => (
            <li key={r.key} className={r.met ? "is-met" : undefined}>
              {/* The tick is decorative: the state is already in the text for a
                  screen reader, and a bare ✓/• would be read aloud as noise. */}
              <span aria-hidden="true">{r.met ? "✓" : "•"}</span>
              <span>{r.label}</span>
              <span className="visually-hidden">{r.met ? " — met" : " — not yet met"}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p className="auth-notice" role="alert">
          {error}
        </p>
      ) : null}

      {sentReset ? (
        <p className="field-hint" role="status">
          If that address has an account, a reset link is on its way.
        </p>
      ) : null}

      <button type="submit" className="btn btn-primary provider-btn" disabled={!ready || busy}>
        {mode === "signup" ? "Create account" : "Sign in"}
      </button>

      <div className="password-form__alt">
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            setMode(mode === "signup" ? "signin" : "signup");
            setSentReset(false);
          }}
        >
          {mode === "signup" ? "I already have an account" : "Create an account"}
        </button>

        {mode === "signin" ? (
          <button
            type="button"
            className="link-btn"
            disabled={email.trim().length === 0 || busy}
            onClick={() => {
              void resetPassword(email).then(() => setSentReset(true));
            }}
          >
            Forgot password
          </button>
        ) : null}
      </div>
    </form>
  );
}
