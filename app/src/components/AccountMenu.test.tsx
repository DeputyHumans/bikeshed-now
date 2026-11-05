// SPDX-License-Identifier: Apache-2.0
// What a phone's one header button holds, signed in and out (SPEC §7).

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";
import { Header } from "./Header";
import { ToastProvider } from "./Toast";

const auth = vi.hoisted(() => ({
  user: null as { uid: string } | null,
  emailLower: "",
  gate: "signed_out",
  signOut: vi.fn(async () => {}),
}));
vi.mock("../auth", () => ({ useAuth: () => auth }));

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{`${pathname}${search}`}</output>;
}

function open(at = "/d/doc-1/v2?k=key", ui = <AccountMenu />) {
  render(
    <MemoryRouter initialEntries={[at]}>
      <ToastProvider>
        {ui}
        <Where />
      </ToastProvider>
    </MemoryRouter>,
  );
  const trigger = screen.queryByRole("button", { name: "Menu" });
  if (trigger) fireEvent.click(trigger);
}

const items = () => screen.getAllByRole("menuitem").map((el) => el.textContent);

beforeEach(() => {
  auth.user = null;
  auth.emailLower = "";
  auth.gate = "signed_out";
  auth.signOut = vi.fn(async () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("AccountMenu", () => {
  it("signed in: the address as a heading, then Account, Docs and Sign out", () => {
    auth.user = { uid: "u" };
    auth.emailLower = "someone@example.com";
    auth.gate = "ready";
    open();
    expect(screen.getByText("someone@example.com").className).toBe("menu-label");
    expect(items()).toEqual(["Account", "Docs", "Sign out"]);
  });

  it("signed out: Sign in returns to this exact place, version and link key included", () => {
    open();
    expect(items()).toEqual(["Sign in", "Docs"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign in" }));
    expect(screen.getByTestId("where").textContent).toBe(`/signup?next=${encodeURIComponent("/d/doc-1/v2?k=key")}`);
  });

  it("offers no sign-in on the sign-in page, or while it does not yet know", () => {
    open("/signup");
    expect(items()).toEqual(["Docs"]);
  });

  it("says nothing of signing in until the gate has settled", () => {
    auth.gate = "loading";
    open();
    expect(items()).toEqual(["Docs"]);
  });

  it("calls an unfinished account what it is", () => {
    auth.user = { uid: "u" };
    auth.gate = "needs_verification";
    open();
    expect(items()).toEqual(["Finish signing in", "Docs"]);
  });

  it("goes to /docs by a full page load, because the router would land it on /", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Docs" }));
    expect(assign).toHaveBeenCalledWith("/docs");
  });

  it("shows that signing out is under way, because its button is gone", async () => {
    auth.user = { uid: "u" };
    auth.emailLower = "someone@example.com";
    auth.gate = "ready";
    let finish = () => {};
    auth.signOut = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(screen.getByText("Signing out…")).toBeTruthy();
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByText("Signing out…")).toBeNull());
  });

  it("says so when signing out fails", async () => {
    auth.user = { uid: "u" };
    auth.gate = "ready";
    auth.signOut = vi.fn(() => Promise.reject(new Error("offline")));
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await screen.findByRole("alert");
  });

  it("puts what its page adds first", () => {
    open("/d/doc-1", <AccountMenu extra={[{ id: "folder", label: "Back to the folder", onSelect: () => {} }]} />);
    expect(items()[0]).toBe("Back to the folder");
  });
});

describe("Header", () => {
  const widthIs = (phone: boolean) =>
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: phone && query.includes("600px"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));

  it("on a phone: the way home and one button, with nothing else to run off the screen", () => {
    widthIs(true);
    auth.user = { uid: "u" };
    auth.emailLower = "someone@example.com";
    auth.gate = "ready";
    open("/", <Header />);
    expect(screen.getByRole("link", { name: "Bikeshed home" }).textContent).toContain("bikeshed");
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.getAllByRole("menuitem").length).toBe(3);
  });

  it("beyond a phone: the actions in the row, and no menu", () => {
    widthIs(false);
    auth.user = { uid: "u" };
    auth.emailLower = "someone@example.com";
    auth.gate = "ready";
    open("/", <Header />);
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("/docs");
  });
});
