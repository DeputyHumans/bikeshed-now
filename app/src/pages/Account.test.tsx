// SPDX-License-Identifier: Apache-2.0
// Connecting an app from the account page, and telling a connected app from a token (SPEC §19, §23)

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Timestamp } from "firebase/firestore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../components/Toast";
import { revokeToken } from "../tokens";
import type { TokenSummary } from "../types";
import { Account } from "./Account";

/** One user object, as the real provider gives: the page subscribes per user. */
const signedIn = vi.hoisted(() => ({ user: { uid: "u1" }, emailLower: "ana@example.com" }));
vi.mock("../auth", () => ({ useAuth: () => signedIn }));

/** Vitest loads app/.env.local; analytics must not pick up a real id. */
vi.mock("../analytics", () => ({ setAnalyticsOptOut: async () => {} }));

const store = vi.hoisted(() => ({ tokens: [] as unknown[] }));

/** No Firestore: the subscriptions answer once, from the store above. */
vi.mock("../firestore", () => ({
  watchUser: (_uid: string, cb: (r: null) => void) => {
    cb(null);
    return () => {};
  },
  watchMyTokens: (_uid: string, cb: (t: unknown[]) => void) => {
    cb(store.tokens);
    return () => {};
  },
  listMyTeams: (_email: string, cb: (t: unknown[]) => void) => {
    cb([]);
    return () => {};
  },
  saveUserProfile: async () => {},
  formatRelative: (ts: unknown) => (ts ? "2d ago" : "never"),
}));

vi.mock("../tokens", () => ({
  createToken: vi.fn(),
  revokeToken: vi.fn(async () => ({ revoked: true })),
  isUnused: (t: { lastUsedAt?: unknown; revokedAt?: unknown }) => !t.lastUsedAt && !t.revokedAt,
}));

vi.mock("../components/TeamsSection", () => ({ TeamsSection: () => null }));

const when = Timestamp.fromMillis(1_700_000_000_000);

const PAT: TokenSummary = {
  tokenId: "tok-pat",
  name: "laptop CLI",
  channel: "cli",
  createdAt: when,
  lastUsedAt: when,
  revokedAt: null,
};

const APP: TokenSummary = {
  tokenId: "tok-oauth",
  name: "Claude",
  channel: "mcp",
  createdAt: when,
  lastUsedAt: when,
  revokedAt: null,
  kind: "oauth",
  clientHost: "claude.ai",
  clientVerified: true,
  registration: "cimd",
};

const INDEX = {
  skills: [
    {
      name: "bikeshed-feedback",
      description: "Reading review comments.",
      path: "skills/bikeshed-feedback/SKILL.md",
      archive: "skills/bikeshed-feedback.zip",
    },
    {
      name: "bikeshed-publishing",
      description: "Publishing a write-up.",
      path: "skills/bikeshed-publishing/SKILL.md",
      archive: "skills/bikeshed-publishing.zip",
    },
    // A shape the page must not turn into a link.
    { name: "odd", description: "x", path: "skills/odd/SKILL.md", archive: "javascript:alert(1)" },
  ],
};

let skillsResponse: () => Promise<Response>;

beforeEach(() => {
  store.tokens = [PAT, APP];
  vi.mocked(revokeToken).mockClear();
  skillsResponse = async () =>
    new Response(JSON.stringify(INDEX), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/skills/index.json" ? skillsResponse() : new Response("", { status: 404 }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAccount() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Account />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** The token row whose name is exactly `name`. */
const row = (name: string) => {
  const rows = [...document.querySelectorAll<HTMLElement>(".token-row")];
  const found = rows.find((r) => r.querySelector("strong")?.textContent === name);
  if (!found) throw new Error(`no row named ${name}`);
  return found;
};

describe("connect an app", () => {
  it("gives the address at the live origin", () => {
    renderAccount();
    // jsdom's origin, read the same way the page reads it. A literal host here
    // would be asserting against ambient config.
    const url = `${window.location.origin}/mcp`;
    expect(screen.getByText(url, { selector: ".connect-url .token-value" })).toBeDefined();
    expect(screen.getByText(`claude mcp add --transport http bikeshed ${url}`)).toBeDefined();
  });

  it("copies the address", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderAccount();
    const box = document.querySelector<HTMLElement>(".connect-url");
    fireEvent.click(within(box as HTMLElement).getByRole("button", { name: /Copy/ }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/mcp`);
  });

  it("offers each skill zip the index lists, and nothing else", async () => {
    renderAccount();
    await screen.findByRole("heading", { name: "Skills for Claude" });
    const links = screen
      .getAllByRole("link")
      .filter((a) => a.hasAttribute("download"))
      .map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/skills/bikeshed-feedback.zip", "/skills/bikeshed-publishing.zip"]);
  });

  it("hides the skills when the index cannot be read", async () => {
    // A deployment without the zips answers a missing path with the SPA's HTML.
    skillsResponse = async () => new Response("<!doctype html>", { status: 200 });
    renderAccount();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/skills/index.json"));
    // Let the failed parse settle before asserting on what it left behind.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole("heading", { name: "Skills for Claude" })).toBeNull();
  });
});

describe("the access token list", () => {
  it("shows a connected app by where it lives, and a token by its channel", () => {
    renderAccount();
    const app = row("Claude");
    const pat = row("laptop CLI");

    expect(app.dataset.kind).toBe("app");
    expect(app.textContent).toContain("claude.ai");
    expect(app.textContent).toContain("connected 2d ago");
    expect(app.textContent).not.toContain("mcp ·");

    expect(pat.dataset.kind).toBe("token");
    expect(pat.textContent).toContain("cli · created 2d ago");
    expect(pat.textContent).not.toContain("connected");
  });

  it("quotes the name of an app whose host was not checked", () => {
    store.tokens = [{ ...APP, name: "Totally Claude", clientVerified: false, registration: "dcr" }];
    renderAccount();
    expect(screen.getByText("Totally Claude").tagName).toBe("Q");
  });

  it("says when an organisation connected the app, and what revoking it means (ADR 0026)", () => {
    store.tokens = [{ ...APP, managedBy: "identity.example" }];
    renderAccount();
    const app = row("Claude");
    expect(app.textContent).toContain("connected by your organisation 2d ago");
    expect(within(app).getByRole("button", { name: "Revoke" }).title).toMatch(/organisation won't be able to connect this or any other app/);
  });

  it("says a revoked organisation connection stays revoked, and leaves an ordinary one plain", () => {
    store.tokens = [
      { ...APP, managedBy: "identity.example", revokedAt: when },
      { ...APP, tokenId: "tok-own", name: "My Claude", revokedAt: when },
    ];
    renderAccount();
    expect(row("Claude").textContent).toContain("revoked · your organisation can't connect apps for you again");
    expect(row("My Claude").textContent).not.toContain("organisation");
  });

  it("revokes a connected app by its token id", async () => {
    renderAccount();
    fireEvent.click(within(row("Claude")).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeToken).toHaveBeenCalledTimes(1));
    expect(revokeToken).toHaveBeenCalledWith("tok-oauth");
  });
});
