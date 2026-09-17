// SPDX-License-Identifier: Apache-2.0
// Sign-in, provider linking, and session-cookie sync (SPEC §3, §14).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  GithubAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail,
  linkWithCredential,
  onIdTokenChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  type AuthCredential,
  type User,
} from "firebase/auth";

import { auth, githubProvider, googleProvider } from "./firebase";
import { logEvent } from "./analytics";
import type { SessionStatus } from "./types";

export type Provider = "google" | "github" | "password";

/** The two that open a popup. `password` takes credentials instead. */
export type PopupProvider = Exclude<Provider, "password">;

/**
 * What the app is waiting for.
 *
 * `needs_email` and `needs_verification` are STATES, not errors, and the UI
 * treats them that way. GitHub is the provider that produces both: it may hand
 * back no address at all, and it generally does not assert `email_verified`.
 */
export type AuthGate =
  | "loading"
  | "signed_out"
  | "needs_email"
  | "needs_verification"
  | "not_allowed"
  | "ready";

interface AuthState {
  user: User | null;
  emailLower: string;
  gate: AuthGate;
  error: string | null;
  /** A deployment-authored sentence for someone the allowlist rejected. */
  notAllowedMessage: string;
  /** Set when a second provider carries an address another account owns. */
  linkPrompt: { email: string; existingProvider: Provider } | null;
  signIn: (provider: PopupProvider) => Promise<void>;
  /**
   * Create an account from an address and a password.
   *
   * The gate is `email_verified === true` and Firebase does NOT set that for a
   * password account, so this deliberately lands the caller in
   * `needs_verification` — the same state a GitHub user with an unvouched
   * address reaches, handled by the same flow. There is no second notion of
   * verification, which is why adding a third sign-in method changed no rule.
   */
  signUpWithPassword: (email: string, password: string) => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  /** Firebase sends this one; it is the only way out of a forced upgrade. */
  resetPassword: (email: string) => Promise<void>;
  completeLink: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

function providerOf(id: string): Provider | null {
  if (id.startsWith("google")) return "google";
  if (id.startsWith("github")) return "github";
  if (id === "password") return "password";
  return null;
}

/**
 * Turn a Firebase auth error into something a person can act on.
 *
 * The password-policy case is the one that must not be generic. This
 * deployment enforces length, case, digit and symbol requirements, and
 * `forceUpgradeOnSignin` means an account whose password predates the policy is
 * refused at SIGN-IN too — with the same error code as a bad sign-up. Telling
 * that person "sign-in failed" would strand them: the only way out is a reset,
 * so the message says so.
 */
function passwordErrorMessage(code: string, mode: "signup" | "signin"): string {
  switch (code) {
    case "auth/password-does-not-meet-requirements":
      return mode === "signup"
        ? "That password does not meet this deployment's requirements."
        : "Your password no longer meets this deployment's requirements. Reset it to continue.";
    case "auth/email-already-in-use":
      return "There is already an account with that address. Sign in instead.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      // Deliberately one message for all three: distinguishing them tells an
      // attacker which addresses have accounts.
      return "That address and password do not match.";
    case "auth/invalid-email":
      return "That does not look like an email address.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a few minutes and try again.";
    default:
      return mode === "signup"
        ? "Could not create the account. Please try again."
        : "Sign-in failed. Please try again.";
  }
}

/** POST the fresh ID token to set `__session`, and report the typed outcome. */
async function postSession(
  user: User,
): Promise<{ status: SessionStatus; message?: string }> {
  const idToken = await user.getIdToken();
  const res = await fetch("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
    credentials: "same-origin",
  });
  try {
    return (await res.json()) as { status: SessionStatus; message?: string };
  } catch {
    return { status: res.ok ? "ok" : "session_failed" };
  }
}

async function deleteSession(): Promise<void> {
  try {
    await fetch("/session", { method: "DELETE", credentials: "same-origin" });
  } catch {
    // Best effort. Local sign-out proceeds regardless: leaving the user signed
    // in because a network call failed would be the worse failure.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [gate, setGate] = useState<AuthGate>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notAllowedMessage, setNotAllowedMessage] = useState("");
  const [linkPrompt, setLinkPrompt] = useState<AuthState["linkPrompt"]>(null);
  const [pendingCredential, setPendingCredential] = useState<AuthCredential | null>(
    null,
  );

  const syncSession = useCallback(async (next: User) => {
    const { status, message } = await postSession(next);
    switch (status) {
      case "ok":
        setUser(next);
        setError(null);
        setGate("ready");
        return;
      case "unverified":
        // Not an error: the account exists, and the next step is a code. The
        // ACL is keyed by email, so admitting an unverified address would hand
        // over whatever was shared with it (SPEC §14).
        setUser(next);
        setGate(next.email ? "needs_verification" : "needs_email");
        return;
      case "not_allowed":
        setNotAllowedMessage(message ?? "");
        setUser(next);
        setGate("not_allowed");
        return;
      default:
        setError("Could not establish a secure session. Try signing in again.");
        setGate("signed_out");
    }
  }, []);

  useEffect(
    () =>
      onIdTokenChanged(auth, async (next) => {
        if (!next) {
          setUser(null);
          setGate("signed_out");
          return;
        }
        await syncSession(next);
      }),
    [syncSession],
  );

  const signIn = useCallback(async (provider: PopupProvider) => {
    setError(null);
    setLinkPrompt(null);
    try {
      const cred = await signInWithPopup(
        auth,
        provider === "google" ? googleProvider : githubProvider,
      );
      const isNew =
        cred.user.metadata.creationTime === cred.user.metadata.lastSignInTime;
      logEvent({ name: isNew ? "sign_up" : "login", params: { method: provider } });
    } catch (e) {
      const err = e as { code?: string; customData?: { email?: string } };
      const code = err.code ?? "";

      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        return; // dismissed, not failed
      }

      /**
       * One account per email is the intended invariant, not a limitation: the
       * ACL is email-keyed, so two accounts sharing an address would be a
       * correctness bug. But it has to be HANDLED, or GitHub sign-in simply
       * appears broken — the popup closes and nothing happens (SPEC §14).
       */
      if (code === "auth/account-exists-with-different-credential") {
        const email = err.customData?.email ?? "";
        const credential =
          provider === "github"
            ? GithubAuthProvider.credentialFromError(e as never)
            : GoogleAuthProvider.credentialFromError(e as never);
        let existing: Provider = provider === "github" ? "google" : "github";
        try {
          const methods = await fetchSignInMethodsForEmail(auth, email);
          for (const method of methods) {
            const found = providerOf(method);
            if (found) {
              existing = found;
              break;
            }
          }
        } catch {
          // Fall back to the other provider: the prompt still names a real
          // choice, and the link step verifies it anyway.
        }
        setPendingCredential(credential);
        setLinkPrompt({ email, existingProvider: existing });
        return;
      }

      setError("Sign-in failed. Please try again.");
    }
  }, []);

  const signUpWithPassword = useCallback(
    async (email: string, password: string) => {
      setError(null);
      setLinkPrompt(null);
      try {
        await createUserWithEmailAndPassword(auth, email.trim(), password);
        logEvent({ name: "sign_up", params: { method: "password" } });
        // No verification email is sent from here: this deployment runs its own
        // flow through Resend and writes Firebase's canonical `emailVerified`
        // with the Admin SDK, so there is exactly one source of truth (§13).
      } catch (e) {
        const code = (e as { code?: string }).code ?? "";
        setError(passwordErrorMessage(code, "signup"));
        throw e;
      }
    },
    [],
  );

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      setError(null);
      setLinkPrompt(null);
      try {
        await signInWithEmailAndPassword(auth, email.trim(), password);
        logEvent({ name: "login", params: { method: "password" } });
      } catch (e) {
        const code = (e as { code?: string }).code ?? "";
        setError(passwordErrorMessage(code, "signin"));
        throw e;
      }
    },
    [],
  );

  const resetPassword = useCallback(async (email: string) => {
    setError(null);
    try {
      await sendPasswordResetEmail(auth, email.trim());
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      // A reset request must not reveal whether an address has an account, so
      // an unknown address is reported to the caller as success. Only a
      // malformed address is worth saying out loud.
      if (code === "auth/invalid-email") {
        setError("That does not look like an email address.");
        throw e;
      }
    }
  }, []);

  /** Sign in with the provider that owns the address, then attach the other. */
  const completeLink = useCallback(async () => {
    if (!linkPrompt) return;
    try {
      const cred = await signInWithPopup(
        auth,
        linkPrompt.existingProvider === "google" ? googleProvider : githubProvider,
      );
      if (pendingCredential) {
        await linkWithCredential(cred.user, pendingCredential);
      }
      setLinkPrompt(null);
      setPendingCredential(null);
    } catch {
      setError("Could not link the two sign-in methods. Try again.");
    }
  }, [linkPrompt, pendingCredential]);

  const signOut = useCallback(async () => {
    await deleteSession();
    await firebaseSignOut(auth);
    setLinkPrompt(null);
    setPendingCredential(null);
  }, []);

  /** Re-check the gate after verification completes, without a full reload. */
  const refresh = useCallback(async () => {
    const current = auth.currentUser;
    if (!current) return;
    await current.getIdToken(true);
    await syncSession(current);
  }, [syncSession]);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      emailLower: (user?.email ?? "").toLowerCase(),
      gate,
      error,
      notAllowedMessage,
      linkPrompt,
      signIn,
      signUpWithPassword,
      signInWithPassword,
      resetPassword,
      completeLink,
      signOut,
      refresh,
      clearError,
    }),
    [
      user,
      gate,
      error,
      notAllowedMessage,
      linkPrompt,
      signIn,
      signUpWithPassword,
      signInWithPassword,
      resetPassword,
      completeLink,
      signOut,
      refresh,
      clearError,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
