// SPDX-License-Identifier: Apache-2.0
// Sign-in, provider linking, session-cookie sync, and following a Google rename (SPEC §3, §14).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  GithubAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail,
  getAdditionalUserInfo,
  linkWithCredential,
  onIdTokenChanged,
  reauthenticateWithPopup,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  type AuthCredential,
  type User,
  type UserCredential,
} from "firebase/auth";

import { auth, githubProvider, googleProvider } from "./firebase";
import { watchAccountMove } from "./firestore";
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

export interface AuthState {
  user: User | null;
  emailLower: string;
  gate: AuthGate;
  error: string | null;
  /** A deployment-authored sentence for someone the allowlist rejected. */
  notAllowedMessage: string;
  /** Set when a second provider carries an address another account owns. */
  linkPrompt: { email: string; existingProvider: Provider } | null;
  /**
   * While the account moves to the address Google renamed it to, that address
   * (SPEC §14). The gate reads `loading` meanwhile, so nothing that waits on
   * a sign-in needs to know about moves.
   */
  movingTo: string | null;
  /** What to tell the person about their address, until they dismiss it. */
  addressNotice: AddressNotice | null;
  /** Sign in with Google again, so the account can follow Google's new address. */
  moveToGoogleAddress: () => Promise<void>;
  dismissAddressNotice: () => void;
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

/**
 * `drift`: Google knows this account by another address, so it can move.
 * `moved`: it has. `blocked`: another account already uses that address.
 */
export interface AddressNotice {
  kind: "drift" | "moved" | "blocked";
  address: string;
}

/** Longer than the job's own budget, so a slow move is not abandoned early. */
const MOVE_WAIT_MS = 10 * 60 * 1000;

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

interface SessionOutcome {
  status: SessionStatus;
  message?: string;
  /** With `moving`: the job to wait on, and the address it moves to. */
  jobId?: string;
  to?: string;
}

/**
 * POST the fresh ID token to set `__session`, and report the typed outcome.
 * `googleIdToken` rides along only when Google calls the account something
 * else; the server decides whether to believe it (SPEC §14).
 */
async function postSession(user: User, googleIdToken?: string): Promise<SessionOutcome> {
  const idToken = await user.getIdToken();
  const res = await fetch("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(googleIdToken ? { idToken, googleIdToken } : { idToken }),
    credentials: "same-origin",
  });
  try {
    return (await res.json()) as SessionOutcome;
  } catch {
    return { status: res.ok ? "ok" : "session_failed" };
  }
}

/**
 * Google's ID token from a Google sign-in, when Google's address for the
 * account is not the account's own: Firebase matches a returning Google user
 * by Google's id and never rewrites the stored address, so a Workspace rename
 * shows up only here (SPEC §14). Undefined when the two agree, which is every
 * ordinary sign-in, so they cost nothing extra.
 */
function renamedGoogleToken(cred: UserCredential): string | undefined {
  const profile = getAdditionalUserInfo(cred)?.profile as { email?: unknown } | null | undefined;
  const google = typeof profile?.email === "string" ? profile.email.toLowerCase() : "";
  if (!google || google === (cred.user.email ?? "").toLowerCase()) return undefined;
  return GoogleAuthProvider.credentialFromResult(cred)?.idToken ?? undefined;
}

/** Google's address for a signed-in account, when it differs from the account's. */
function driftOf(user: User): string | null {
  const google = (user.providerData ?? []).find((p) => p.providerId === "google.com")?.email;
  const lower = typeof google === "string" ? google.toLowerCase() : "";
  return lower && lower !== (user.email ?? "").toLowerCase() ? lower : null;
}

/** Resolve with the job's state once it is final, or "pending" after `ms`. */
function waitForMove(jobId: string, ms: number): Promise<string> {
  return new Promise((resolve) => {
    let stop: () => void = () => {};
    let settled = false;
    const settle = (state: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve(state);
    };
    const timer = setTimeout(() => settle("pending"), ms);
    stop = watchAccountMove(jobId, (state) => {
      if (state === "done" || state === "blocked") settle(state);
    });
    if (settled) stop();
  });
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
  const [movingTo, setMovingTo] = useState<string | null>(null);
  const [addressNotice, setAddressNotice] = useState<AddressNotice | null>(null);

  /**
   * Three refs keep the syncs in order.
   * - `syncs` numbers each one, and only the newest may set the gate. Two can
   *   overlap: the listener's, and the one a sign-in makes with Google's token.
   * - `syncBySignIn` makes the listener leave a popup sign-in's sync to the
   *   sign-in, which knows whether Google renamed the account. Otherwise every
   *   sign-in would be two requests, and the first could land the person, as
   *   their old address, on a page shared with their new one.
   * - `moving` holds off everything else while a move runs. Its last step
   *   revokes this very session, and the SDK reacting to that must not sign
   *   the person out mid-move.
   */
  const syncs = useRef(0);
  const syncBySignIn = useRef(false);
  const moving = useRef(false);
  const syncRef = useRef<(next: User, googleIdToken?: string) => Promise<void>>(async () => {});

  /**
   * Wait out a move to the address Google renamed the account to, then sign in
   * as it (SPEC §14). The move revoked every session the account had, this one
   * included; the same Google token is a fresh sign-in past that.
   */
  const followMove = useCallback(
    async (next: User, jobId: string, to: string, googleIdToken: string) => {
      moving.current = true;
      setMovingTo(to);
      setGate("loading");
      const state = await waitForMove(jobId, MOVE_WAIT_MS);
      moving.current = false;
      try {
        if (state === "done") {
          await signInWithCredential(auth, GoogleAuthProvider.credential(googleIdToken));
          setAddressNotice({ kind: "moved", address: to });
          return;
        }
        if (state === "blocked") {
          setAddressNotice({ kind: "blocked", address: to });
          await syncRef.current(next);
          return;
        }
        await firebaseSignOut(auth);
        setError("Moving your account is taking longer than it should. Sign in with Google again in a few minutes.");
      } catch {
        // Most likely Google's token expired while the job ran. The move is
        // done or will be; signing in again picks it up.
        await firebaseSignOut(auth).catch(() => {});
        setError(`Your account now uses ${to}. Sign in with Google again to continue.`);
      } finally {
        setMovingTo(null);
      }
    },
    [],
  );

  const syncSession = useCallback(async (next: User, googleIdToken?: string) => {
    const generation = ++syncs.current;
    let outcome: SessionOutcome;
    try {
      outcome = await postSession(next, googleIdToken);
    } catch {
      // A network failure is a failed session, not a reason to stay "loading":
      // the gate below is what takes the waiting screen down again.
      outcome = { status: "session_failed" };
    }
    const { status, message } = outcome;
    if (status === "moving" && googleIdToken && outcome.jobId && outcome.to) {
      await followMove(next, outcome.jobId, outcome.to, googleIdToken);
      return;
    }
    // A newer sync has the last word, and a move in progress has every word.
    if (generation !== syncs.current || moving.current) return;
    switch (status) {
      case "ok": {
        setUser(next);
        setError(null);
        setGate("ready");
        const drift = driftOf(next);
        setAddressNotice((current) =>
          current ?? (drift ? { kind: "drift", address: drift } : null),
        );
        return;
      }
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
  }, [followMove]);
  syncRef.current = syncSession;

  useEffect(
    () =>
      onIdTokenChanged(auth, async (next) => {
        if (moving.current) return;
        if (!next) {
          setUser(null);
          setGate("signed_out");
          return;
        }
        // Signing in is not finished until the session cookie is set, and that
        // is a round trip to a function that may be cold. Without this the
        // sign-in card stays up, looking idle, after the popup has closed.
        // Only from signed_out: a token refresh on a ready session must not
        // take the app down to a waiting screen and back.
        setGate((current) => (current === "signed_out" ? "loading" : current));
        if (syncBySignIn.current) return;
        await syncSession(next);
      }),
    [syncSession],
  );

  const signIn = useCallback(async (provider: PopupProvider) => {
    setError(null);
    setLinkPrompt(null);
    try {
      let cred: UserCredential;
      syncBySignIn.current = true;
      try {
        cred = await signInWithPopup(
          auth,
          provider === "google" ? googleProvider : githubProvider,
        );
      } finally {
        syncBySignIn.current = false;
      }
      const isNew =
        cred.user.metadata.creationTime === cred.user.metadata.lastSignInTime;
      logEvent({ name: isNew ? "sign_up" : "login", params: { method: provider } });
      await syncSession(cred.user, provider === "google" ? renamedGoogleToken(cred) : undefined);
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
  }, [syncSession]);

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
      // The listener has already synced this sign-in; only a rename needs a second.
      const renamed = linkPrompt.existingProvider === "google" ? renamedGoogleToken(cred) : undefined;
      if (renamed) await syncSession(cred.user, renamed);
    } catch {
      setError("Could not link the two sign-in methods. Try again.");
    }
  }, [linkPrompt, pendingCredential, syncSession]);

  /**
   * For an account already signed in when Google renamed it, which learns of
   * the rename only from `providerData`: one more Google popup produces the
   * token the move needs (SPEC §14).
   */
  const moveToGoogleAddress = useCallback(async () => {
    const current = auth.currentUser;
    if (!current) return;
    setError(null);
    let cred: UserCredential;
    syncBySignIn.current = true;
    try {
      cred = await reauthenticateWithPopup(current, googleProvider);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return;
      setError(
        code === "auth/user-mismatch"
          ? "That is a different Google account. Choose the one you signed in with."
          : "Could not reach Google. Try again.",
      );
      return;
    } finally {
      syncBySignIn.current = false;
    }
    const renamed = renamedGoogleToken(cred);
    setAddressNotice(null);
    await syncSession(cred.user, renamed);
  }, [syncSession]);

  const dismissAddressNotice = useCallback(() => setAddressNotice(null), []);

  const signOut = useCallback(async () => {
    await deleteSession();
    await firebaseSignOut(auth);
    setLinkPrompt(null);
    setPendingCredential(null);
    setAddressNotice(null);
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
      movingTo,
      addressNotice,
      moveToGoogleAddress,
      dismissAddressNotice,
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
      movingTo,
      addressNotice,
      moveToGoogleAddress,
      dismissAddressNotice,
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
