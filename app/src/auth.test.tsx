// SPDX-License-Identifier: Apache-2.0
// The gate says "signing in" until the session cookie is set, and only then (SPEC §14).

import { act, render } from "@testing-library/react";
import type { User } from "firebase/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listener, popup, move } = vi.hoisted(() => ({
  listener: { current: null as ((user: User | null) => Promise<void>) | null },
  popup: {
    signIn: vi.fn(),
    reauth: vi.fn(),
    withCredential: vi.fn(),
    profileEmail: "" as string | undefined,
  },
  move: { onState: null as ((state: string | null) => void) | null },
}));

vi.mock("firebase/auth", () => ({
  GithubAuthProvider: { credentialFromError: () => null },
  GoogleAuthProvider: {
    credentialFromError: () => null,
    credentialFromResult: () => ({ idToken: "google-id-token" }),
    credential: (idToken: string) => ({ idToken }),
  },
  createUserWithEmailAndPassword: vi.fn(),
  fetchSignInMethodsForEmail: vi.fn(),
  getAdditionalUserInfo: () => ({ profile: { email: popup.profileEmail } }),
  linkWithCredential: vi.fn(),
  onIdTokenChanged: (_auth: unknown, next: (user: User | null) => Promise<void>) => {
    listener.current = next;
    return () => {};
  },
  reauthenticateWithPopup: popup.reauth,
  sendPasswordResetEmail: vi.fn(),
  signInWithCredential: popup.withCredential,
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: popup.signIn,
  signOut: vi.fn(),
}));
vi.mock("./firebase", () => ({ auth: {}, githubProvider: {}, googleProvider: {} }));
vi.mock("./firestore", () => ({
  watchAccountMove: (_jobId: string, onState: (state: string | null) => void) => {
    move.onState = onState;
    return () => {
      move.onState = null;
    };
  },
}));
vi.mock("./analytics", () => ({ logEvent: vi.fn() }));

import { AuthProvider, useAuth, type AuthGate, type AuthState } from "./auth";
import { auth as mockedAuth } from "./firebase";

const USER = { email: "reader@example.com", getIdToken: async () => "id-token" } as User;

/** Every gate the app rendered, in order — a flash shows up here even when it does not last. */
function mount() {
  const gates: AuthGate[] = [];
  const state: { error: string | null; auth: AuthState | null } = { error: null, auth: null };
  function Probe() {
    const auth = useAuth();
    if (gates[gates.length - 1] !== auth.gate) gates.push(auth.gate);
    state.error = auth.error;
    state.auth = auth;
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
  move.onState = null;
  popup.signIn.mockReset();
  popup.reauth.mockReset();
  popup.withCredential.mockReset();
  popup.profileEmail = undefined;
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

// --- An address Google renamed (SPEC §14) -------------------------------------

const OLD = "victoria@old.example.com";
const NEW = "victoria@new.example.com";

function person(email: string, googleEmail?: string) {
  return {
    email,
    getIdToken: async () => `id-token-for-${email}`,
    metadata: {},
    providerData: googleEmail ? [{ providerId: "google.com", email: googleEmail }] : [],
  } as unknown as User;
}

const answers = (...statuses: object[]) => {
  for (const body of statuses) fetchMock.mockResolvedValueOnce({ ok: true, json: async () => body });
};
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));

/** A Google popup the way the SDK runs one: the listener hears first, then the promise resolves. */
function googlePopup(user: User, googleEmail: string) {
  popup.profileEmail = googleEmail;
  popup.signIn.mockImplementationOnce(async () => {
    await listener.current!(user);
    return { user };
  });
}

describe("a Google sign-in", () => {
  it("asks for one session, carrying nothing extra, when Google agrees on the address", async () => {
    const view = await signedOut();
    googlePopup(person(OLD), OLD);
    answers({ status: "ok" });
    await act(() => view.state.auth!.signIn("google"));
    expect(bodies()).toEqual([{ idToken: `id-token-for-${OLD}` }]);
    expect(view.gates.at(-1)).toBe("ready");
  });

  it("sends Google's token, once, when Google calls the account something else", async () => {
    const view = await signedOut();
    googlePopup(person(OLD), "Victoria@New.Example.com");
    answers({ status: "ok" });
    await act(() => view.state.auth!.signIn("google"));
    expect(bodies()).toEqual([{ idToken: `id-token-for-${OLD}`, googleIdToken: "google-id-token" }]);
  });
});

describe("moving to the address Google renamed the account to", () => {
  async function startMove() {
    const view = await signedOut();
    googlePopup(person(OLD), NEW);
    answers({ status: "moving", jobId: "u-vic~abc", to: NEW });
    let signedIn!: Promise<void>;
    act(() => {
      signedIn = view.state.auth!.signIn("google");
    });
    await vi.waitFor(() => expect(move.onState).not.toBeNull());
    return { view, signedIn };
  }

  it("waits on the job, saying so, then signs in again as the new address", async () => {
    const { view, signedIn } = await startMove();
    const from = view.gates.length - 1;
    expect(view.gates.at(-1)).toBe("loading");
    expect(view.state.auth!.movingTo).toBe(NEW);

    // The job revokes this session, and the SDK notices: no sign-out flash.
    await act(() => tokenChanged(null));
    expect(view.gates.at(-1)).toBe("loading");

    popup.withCredential.mockImplementationOnce(async () => {
      await listener.current!(person(NEW, NEW));
      return { user: person(NEW, NEW) };
    });
    answers({ status: "ok" });
    await act(async () => {
      move.onState!("done");
      await signedIn;
    });

    expect(popup.withCredential).toHaveBeenCalledWith({}, { idToken: "google-id-token" });
    expect(view.gates.at(-1)).toBe("ready");
    expect(view.state.auth!.emailLower).toBe(NEW);
    expect(view.state.auth!.movingTo).toBeNull();
    expect(view.state.auth!.addressNotice).toEqual({ kind: "moved", address: NEW });
    expect(view.gates.slice(from)).toEqual(["loading", "ready"]);
  });

  it("explains a blocked move and carries on as the old address", async () => {
    const { view, signedIn } = await startMove();
    answers({ status: "ok" });
    await act(async () => {
      move.onState!("blocked");
      await signedIn;
    });
    expect(bodies().at(-1)).toEqual({ idToken: `id-token-for-${OLD}` });
    expect(view.gates.at(-1)).toBe("ready");
    expect(view.state.auth!.emailLower).toBe(OLD);
    expect(view.state.auth!.addressNotice).toEqual({ kind: "blocked", address: NEW });
    expect(popup.withCredential).not.toHaveBeenCalled();
  });
});

describe("the order of overlapping sessions", () => {
  it("lets the newest answer decide, however late an older one arrives", async () => {
    const { gates } = await signedOut();
    const first = sessionCall();
    const second = sessionCall();
    fetchMock.mockReturnValueOnce(first.pending).mockReturnValueOnce(second.pending);
    const a = tokenChanged(USER);
    const b = tokenChanged(USER);
    await act(async () => {
      second.answer("ok");
      await b;
    });
    await act(async () => {
      first.answer("session_failed");
      await a;
    });
    expect(gates.at(-1)).toBe("ready");
  });
});

describe("an account signed in before Google renamed it", () => {
  it("is told, and can move with one more Google popup", async () => {
    const view = await signedOut();
    answers({ status: "ok" });
    await act(() => tokenChanged(person(OLD, NEW)));
    expect(view.state.auth!.addressNotice).toEqual({ kind: "drift", address: NEW });

    popup.profileEmail = NEW;
    (mockedAuth as { currentUser?: User }).currentUser = person(OLD, NEW);
    popup.reauth.mockImplementationOnce(async () => ({ user: person(OLD, NEW) }));
    answers({ status: "moving", jobId: "u-vic~abc", to: NEW });
    act(() => {
      void view.state.auth!.moveToGoogleAddress();
    });
    await vi.waitFor(() => expect(move.onState).not.toBeNull());
    expect(bodies().at(-1)).toEqual({ idToken: `id-token-for-${OLD}`, googleIdToken: "google-id-token" });
    expect(view.state.auth!.movingTo).toBe(NEW);
  });

  it("is not told anything when Google and the account agree", async () => {
    const view = await signedOut();
    answers({ status: "ok" });
    await act(() => tokenChanged(person(OLD, OLD)));
    expect(view.state.auth!.addressNotice).toBeNull();
  });
});
