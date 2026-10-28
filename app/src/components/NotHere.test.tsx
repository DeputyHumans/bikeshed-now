// SPDX-License-Identifier: Apache-2.0
// "Not here" offers a way back in, and the way back in returns to the same URL (SPEC §1.4, §3).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthGate } from "../auth";
import { NotHere } from "./NotHere";

const auth = vi.hoisted(() => ({
  gate: "signed_out" as AuthGate,
  emailLower: "",
  signOut: vi.fn(() => Promise.resolve()),
}));

vi.mock("../auth", () => ({
  useAuth: () => ({ gate: auth.gate, emailLower: auth.emailLower, signOut: auth.signOut }),
}));

// What SignUp will read: `next`, decoded, exactly as `safeNext` receives it.
function SignUpMarker() {
  const { search } = useLocation();
  return <p>NEXT {new URLSearchParams(search).get("next")}</p>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/d/*" element={<NotHere />} />
        <Route path="/signup" element={<SignUpMarker />} />
      </Routes>
    </MemoryRouter>,
  );
}

// A version, an unlisted document's key and a hash: all three must survive.
const HERE = "/d/q3-plan/v2?k=KEY#c-1";

beforeEach(() => {
  auth.gate = "signed_out";
  auth.emailLower = "";
  auth.signOut = vi.fn(() => Promise.resolve());
});

describe("Not here, for a reader who is not signed in", () => {
  it("offers sign-in, and sign-in comes back to the same version, key and hash", () => {
    renderAt(HERE);
    expect(screen.getByRole("heading", { name: "Not here" })).toBeTruthy();
    expect(screen.getByText(/does not exist, or you do not have access/)).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Sign in" }));
    expect(screen.getByText(`NEXT ${HERE}`)).toBeTruthy();
  });

  it("says finish, not start, to somebody part-way through signing in", () => {
    auth.gate = "needs_verification";
    renderAt(HERE);
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Finish signing in" }));
    expect(screen.getByText(`NEXT ${HERE}`)).toBeTruthy();
  });

  it("offers nothing while the gate is still resolving", () => {
    auth.gate = "loading";
    renderAt(HERE);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("Not here, for a reader signed in with some other address", () => {
  it("names the address, and signs out before going to sign in", async () => {
    auth.gate = "ready";
    auth.emailLower = "reader@example.com";
    let signedOut = () => {};
    auth.signOut = vi.fn(() => new Promise<void>((resolve) => (signedOut = resolve)));
    renderAt(HERE);

    expect(screen.getByText("reader@example.com")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use a different account" }));
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    // Still signed in, /signup would hand them straight back here.
    expect(screen.queryByText(/^NEXT/)).toBeNull();

    await act(async () => signedOut());
    expect(screen.getByText(`NEXT ${HERE}`)).toBeTruthy();
  });
});
