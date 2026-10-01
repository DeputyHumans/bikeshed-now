// SPDX-License-Identifier: Apache-2.0
// The gate says "signing in" until the session cookie is set, and only then (SPEC §14).

import { act, render } from "@testing-library/react";
import type { User } from "firebase/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listener } = vi.hoisted(() => ({
  listener: { current: null as ((user: User | null) => Promise<void>) | null },
}));

vi.mock("firebase/auth", () => ({
  GithubAuthProvider: { credentialFromError: () => null },
  GoogleAuthProvider: { credentialFromError: () => null },
  createUserWithEmailAndPassword: vi.fn(),
  fetchSignInMethodsForEmail: vi.fn(),
  linkWithCredential: vi.fn(),
  onIdTokenChanged: (_auth: unknown, next: (user: User | null) => Promise<void>) => {
    listener.current = next;
    return () => {};
  },
  sendPasswordResetEmail: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("./firebase", () => ({ auth: {}, githubProvider: {}, googleProvider: {} }));
vi.mock("./analytics", () => ({ logEvent: vi.fn() }));

import { AuthProvider, useAuth, type AuthGate } from "./auth";

const USER = { email: "reader@example.com", getIdToken: async () => "id-token" } as User;

/** Every gate the app rendered, in order — a flash shows up here even when it does not last. */
function mount() {
  const gates: AuthGate[] = [];
  const state: { error: string | null } = { error: null };
  function Probe() {
    const auth = useAuth();
    if (gates[gates.length - 1] !== auth.gate) gates.push(auth.gate);
    state.error = auth.error;
    return null;
  }
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  return { gates, state };
}

/** A /session call that answers only when told to. */
function sessionCall() {
  let answer!: (status: string) => void;
  let fail!: () => void;
  const pending = new Promise<Response>((resolve, reject) => {
    answer = (status) =>
      resolve({ ok: true, json: async () => ({ status }) } as Response);
    fail = () => reject(new TypeError("Failed to fetch"));
  });
  return { pending, answer, fail };
}

const fetchMock = vi.fn();

beforeEach(() => {
  listener.current = null;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Fire the SDK's listener without waiting on it: the wait is what is under test. */
function tokenChanged(user: User | null) {
  let done!: Promise<void>;
  act(() => {
    done = listener.current!(user);
  });
  return done;
}

async function signedOut() {
  const view = mount();
  await act(() => tokenChanged(null));
  return view;
}

describe("the auth gate while the session is set", () => {
  it("shows signing in from the moment a user arrives until /session answers", async () => {
    const { gates } = await signedOut();
    const session = sessionCall();
    fetchMock.mockReturnValueOnce(session.pending);

    const done = tokenChanged(USER);
    expect(gates[gates.length - 1]).toBe("loading");

    await act(async () => {
      session.answer("ok");
      await done;
    });
    expect(gates).toEqual(["loading", "signed_out", "loading", "ready"]);
  });

  it("does not drop a ready session to a waiting screen on a token refresh", async () => {
    const { gates } = await signedOut();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: "ok" }) });
    await act(() => tokenChanged(USER));
    expect(gates[gates.length - 1]).toBe("ready");
    const before = gates.length;

    // The refresh's /session is held open, so a "loading" in between would be
    // rendered and recorded rather than batched away.
    const refresh = sessionCall();
    fetchMock.mockReturnValueOnce(refresh.pending);
    const done = tokenChanged(USER);
    await act(async () => {
      refresh.answer("ok");
      await done;
    });

    expect(gates.slice(before - 1)).toEqual(["ready"]);
  });

  it("comes back to signed out with an error when /session cannot be reached", async () => {
    // Without this a network failure would leave "Signing in…" up for good.
    const { gates, state } = await signedOut();
    const session = sessionCall();
    fetchMock.mockReturnValueOnce(session.pending);

    const done = tokenChanged(USER);
    await act(async () => {
      session.fail();
      await done;
    });

    expect(gates[gates.length - 1]).toBe("signed_out");
    expect(state.error).toMatch(/secure session/);
  });
});
