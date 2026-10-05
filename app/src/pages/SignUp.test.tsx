// SPDX-License-Identifier: Apache-2.0
// /signup is a URL, so it has to answer for every gate — including the finished one (SPEC §3, §14).

import { render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
import { ToastProvider } from "../components/Toast";
import type { AuthGate } from "../auth";

/**
 * The bug this file exists for
 * ----------------------------
 * Signing in with Google or GitHub left the person on /signup looking at an
 * empty "Almost there" card forever. Not a provider problem: every body block
 * in SignUp is conditioned on a NOT-ready gate, and the step indicator falls
 * back to 1, so `ready` rendered the shell with nothing in it — and nothing
 * routed them onward.
 *
 * It only became reachable when the landing page started linking to /signup as
 * a real URL. Before that, a signed-out visitor got SignUp rendered IN PLACE at
 * `/` by RequireAccount, so the moment the gate flipped to ready, `/` re-rendered
 * as the workspace and the URL never had to change.
 *
 * Landing.test.tsx cannot catch it: it mocks ./SignUp wholesale, so the subject
 * here is deliberately the real component.
 */
const auth = vi.hoisted(() => ({ gate: "loading" as AuthGate }));

vi.mock("../auth", () => ({
  useAuth: () => ({
    gate: auth.gate,
    user: null,
    emailLower: "",
    error: null,
    notAllowedMessage: "",
    linkPrompt: null,
    signIn: vi.fn(),
    completeLink: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
    clearError: vi.fn(),
  }),
}));

// SignUp reaches for the real SDK handle; initialising Firebase in a unit test
// would open a network client against whatever app/.env.local happens to hold.
vi.mock("../firebase", () => ({ auth: {}, db: {}, rtdb: null }));

vi.mock("../analytics", () => ({
  initAnalytics: () => {},
  logPageView: () => {},
  analyticsConfigured: () => false,
}));

// The destination is a marker: what is under test is WHICH screen a gate
// selects, and rendering DocList for real would open Firestore subscriptions.
vi.mock("./DocList", () => ({ DocList: () => <p>WORKSPACE</p> }));
vi.mock("./DocViewer", () => ({
  DocViewer: () => {
    const { pathname, search } = useLocation();
    return <p>VIEWER {pathname}{search}</p>;
  },
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </MemoryRouter>,
  );
}

const almostThere = () => screen.queryByRole("heading", { name: /Almost there/i });

beforeEach(() => {
  auth.gate = "loading";
});

describe("/signup once there is nothing left to sign up for", () => {
  it("sends a signed-in person to the workspace instead of an empty card", () => {
    auth.gate = "ready";
    renderAt("/signup");
    expect(screen.getByText("WORKSPACE")).toBeDefined();
    expect(almostThere()).toBeNull();
  });

  it("returns a reader to the document they were on, to finish what they started", () => {
    // Fork on a document, signed out: the sign-in that follows must come back
    // to it, or the fork the reader asked for never happens (SPEC §21).
    auth.gate = "ready";
    renderAt(`/signup?next=${encodeURIComponent("/d/q3-plan/v2?fork=1")}`);
    expect(screen.getByText("VIEWER /d/q3-plan/v2?fork=1")).toBeDefined();
  });

  it("will not send anyone off this site, whatever the link says", () => {
    auth.gate = "ready";
    renderAt(`/signup?next=${encodeURIComponent("//evil.example/d/x")}`);
    expect(screen.getByText("WORKSPACE")).toBeDefined();
  });

  it("shows a spinner while the gate is still resolving, not a dead step list", () => {
    // "Almost there" with no body under it is the same empty shell, and it is
    // what every visitor sees for the moment before the gate settles.
    auth.gate = "loading";
    renderAt("/signup");
    expect(almostThere()).toBeNull();
  });
});

describe("/signup still does its actual job", () => {
  it("offers the providers to somebody signed out", () => {
    auth.gate = "signed_out";
    renderAt("/signup");
    expect(screen.getByRole("heading", { name: /Sign in to Bikeshed/i })).toBeDefined();
    expect(screen.queryByText("WORKSPACE")).toBeNull();
  });

  it.each<AuthGate>(["needs_email", "needs_verification", "not_allowed"])(
    "keeps somebody mid-flow on the form (%s)",
    (gate) => {
      // The over-correction to guard against: redirecting on anything other
      // than `ready` would strand the person waiting on a verification code.
      auth.gate = gate;
      renderAt("/signup");
      expect(almostThere()).not.toBeNull();
      expect(screen.queryByText("WORKSPACE")).toBeNull();
    },
  );
});
