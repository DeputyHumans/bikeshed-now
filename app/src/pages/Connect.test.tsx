// SPDX-License-Identifier: Apache-2.0
// Nothing is approved without a deliberate click, and nothing leaves except back to the app (SPEC §23)

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App, ConnectRoute } from "../App";
import { ToastProvider } from "../components/Toast";
import { clearAuthorizeRequest, leave, type AuthorizeRequest, type DescribeValid } from "../oauth";
import { ARM_DELAY_MS, Connect } from "./Connect";
import type { AuthGate } from "../auth";

/**
 * The gate is driven directly, because the sequences that matter are a gate
 * changing under a mounted route. `vi.hoisted` because vi.mock's factory runs
 * before every other statement in the file.
 */
const auth = vi.hoisted(() => ({
  gate: "ready" as AuthGate,
  user: null as null | { uid: string; getIdToken: () => Promise<string> },
  signOut: null as unknown as () => Promise<void>,
}));

vi.mock("../auth", () => ({
  useAuth: () => ({
    gate: auth.gate,
    user: auth.user,
    emailLower: auth.user ? "ana@example.com" : "",
    signOut: auth.signOut,
  }),
}));

/**
 * Records the address at the moment analytics starts and logs, which is what
 * gtag would read. Stubbed as well because Vitest loads app/.env.local, and a
 * configured measurement id would otherwise make this test log for real.
 */
const seen = vi.hoisted(() => ({ hrefs: [] as string[] }));
// Account preference restoration has its own sequence tests; routing stays hermetic.
vi.mock("../accountPreferences", () => ({ useAccountPreferences: () => true }));

vi.mock("../analytics", () => ({
  initAnalytics: () => seen.hrefs.push(window.location.href),
  logPageView: () => seen.hrefs.push(window.location.href),
  analyticsConfigured: () => false,
}));

vi.mock("../oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../oauth")>()),
  leave: vi.fn(),
}));

vi.mock("./DocList", () => ({ DocList: () => <p>WORKSPACE</p> }));
vi.mock("./SignUp", () => ({ SignUp: () => <p>SIGN-IN SCREEN</p> }));

const REQUEST: AuthorizeRequest = {
  response_type: "code",
  client_id: "https://claude.ai/oauth/client.json",
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  code_challenge: "abc",
  code_challenge_method: "S256",
  state: "s1",
  resource: "https://example.test/mcp",
};

const QUERY = `?${new URLSearchParams({ ...(REQUEST as Record<string, string>), utm_source: "x" })}`;

const CLAUDE: DescribeValid = {
  valid: true,
  client: { name: "Claude", host: "claude.ai", verified: true, registration: "cimd" },
  redirect: { host: "claude.ai", kind: "web", scheme: "https" },
  account: { email: "ana@example.com" },
  device: null,
};

const CLI: DescribeValid = {
  valid: true,
  client: { name: "Bikeshed CLI", host: null, verified: true, registration: "builtin" },
  redirect: { host: "127.0.0.1", kind: "loopback", scheme: "http" },
  account: { email: "ana@example.com" },
  device: "ana-laptop",
};

const DCR_WEB: DescribeValid = {
  valid: true,
  client: { name: "Totally Claude", host: null, verified: false, registration: "dcr" },
  redirect: { host: "claude.ai", kind: "web", scheme: "https" },
  account: { email: "ana@example.com" },
  device: null,
};

const APPROVED = `${REQUEST.redirect_uri}?code=c1&state=s1&iss=https%3A%2F%2Fexample.test`;
const DENIED = `${REQUEST.redirect_uri}?error=access_denied&state=s1&iss=https%3A%2F%2Fexample.test`;

/** What the server answers each action with, and every call it received. */
const server = {
  describe: CLAUDE as unknown,
  approve: { redirect: APPROVED } as unknown,
  deny: { redirect: DENIED } as unknown,
  calls: [] as { action: string; params: Record<string, string>; authorization: string | null }[],
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) !== "/oauth/consent") return new Response("{}", { status: 404 });
  const body = JSON.parse(String(init?.body)) as { action: "describe" | "approve" | "deny"; params: Record<string, string> };
  server.calls.push({
    action: body.action,
    params: body.params,
    authorization: new Headers(init?.headers).get("Authorization"),
  });
  return new Response(JSON.stringify(server[body.action]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

const actions = () => server.calls.map((c) => c.action);

function signedIn(uid = "u1") {
  auth.gate = "ready";
  auth.user = { uid, getIdToken: async () => `id-token-${uid}` };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("fetch", fetchMock);
  // jsdom reports an unfocused document. A real visitor's is focused.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  fetchMock.mockClear();
  vi.mocked(leave).mockClear();
  server.describe = CLAUDE;
  server.approve = { redirect: APPROVED };
  server.deny = { redirect: DENIED };
  server.calls = [];
  seen.hrefs = [];
  signedIn();
  auth.signOut = vi.fn(async () => {
    auth.gate = "signed_out";
    auth.user = null;
  });
  clearAuthorizeRequest();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAuthorizeRequest();
});

function renderConnect(request: AuthorizeRequest | null = REQUEST) {
  return render(
    <MemoryRouter>
      <Connect request={request} />
    </MemoryRouter>,
  );
}

/** A fresh element each time: rerendering the same one would be skipped. */
const routeTree = () => (
  <MemoryRouter initialEntries={["/connect"]}>
    <ConnectRoute />
  </MemoryRouter>
);

const heading = (name: RegExp) => screen.findByRole("heading", { level: 1, name });
const approveButton = () => screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;

/**
 * What a person does without meaning to approve anything: look, and move.
 *
 * The page listens on `window` from an effect, which runs a turn after the
 * render that shows the heading. On a loaded CI runner that turn came late, a
 * move made before it went unseen, and Approve never armed. So this keeps
 * looking and moving until the page has armed, as a person would.
 */
async function lookAndMove() {
  await act(async () => {
    vi.advanceTimersByTime(ARM_DELAY_MS);
  });
  await moveUntilArmed();
}

/**
 * Move the pointer until Approve arms. Never advances the clock itself, which
 * would also fire waitFor's own timeout; the clock follows real time here, so
 * an arming timer the late effect started still runs out within the wait.
 */
async function moveUntilArmed() {
  await waitFor(
    () => {
      act(() => {
        window.dispatchEvent(new Event("pointermove"));
      });
      expect(approveButton().disabled).toBe(false);
    },
    { timeout: 5 * ARM_DELAY_MS },
  );
}

describe("asking", () => {
  it("describes the params it captured, after the query is gone from the address", async () => {
    window.history.replaceState(null, "", `/connect${QUERY}`);
    render(routeTree());
    await heading(/Connect Claude to Bikeshed\?/);

    expect(window.location.search).toBe("");
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].action).toBe("describe");
    expect(server.calls[0].params).toEqual(REQUEST);
    // The ID token of the person on screen, not the session cookie.
    expect(server.calls[0].authorization).toBe("Bearer id-token-u1");
  });

  it("asks nothing when there is no request", async () => {
    renderConnect(null);
    await heading(/Nothing to connect/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  /**
   * Belt to the X-Frame-Options braces in firebase.json: inside a frame, the
   * page around it can cover everything but the button.
   */
  it("refuses to ask inside a frame", async () => {
    const self = window.self;
    Object.defineProperty(window, "self", { value: {}, configurable: true, writable: true });
    try {
      renderConnect();
      await heading(/Open this page in its own tab/);
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "self", { value: self, configurable: true, writable: true });
    }
  });
});

describe("approving", () => {
  it("approves nothing without a click", async () => {
    renderConnect();
    await heading(/Connect Claude to Bikeshed\?/);
    await lookAndMove();
    await act(async () => {
      vi.advanceTimersByTime(5 * ARM_DELAY_MS);
    });
    expect(approveButton().disabled).toBe(false);
    expect(actions()).toEqual(["describe"]);
    expect(leave).not.toHaveBeenCalled();
  });

  /** The double-clickjacking defence: seen, focused, and touched first. */
  it("keeps Approve disabled until the page has been seen for a second and touched", async () => {
    renderConnect();
    await heading(/Connect Claude to Bikeshed\?/);
    expect(approveButton().disabled).toBe(true);

    // Time alone is not enough.
    await act(async () => {
      vi.advanceTimersByTime(ARM_DELAY_MS * 3);
    });
    expect(approveButton().disabled).toBe(true);

    // A touch arms it, once the page's listeners are there to see it, which
    // on a slow runner is a turn after the heading (see lookAndMove).
    await moveUntilArmed();

    // A background window cannot settle its timer, even after a full second.
    vi.mocked(document.hasFocus).mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(approveButton().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(ARM_DELAY_MS * 2); });
    expect(approveButton().disabled).toBe(true);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(approveButton().disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(ARM_DELAY_MS);
    });
    expect(approveButton().disabled).toBe(false);
  });

  it("discloses every allowed and excluded capability before approval", async () => {
    renderConnect();
    await heading(/Connect Claude to Bikeshed\?/);
    const items = (selector: string) => Array.from(document.querySelectorAll(selector), (el) => el.textContent);
    expect(items(".connect-list:not(.connect-list-not) li")).toEqual([
      "Read what you can read",
      "Publish, revise and rename documents",
      "Comment, reply, suggest edits and resolve threads",
      "Accept or reject suggested edits where you can, and save them as a new version",
      "Create folders and file documents in them",
    ]);
    expect(items(".connect-list-not li")).toEqual([
      "Share anything, or change who can read it",
      "Delete anything, or rename a folder",
      "Set or clear an expiry",
    ]);
  });

  it("sends one approve for a double click", async () => {
    renderConnect();
    await heading(/Connect Claude to Bikeshed\?/);
    await lookAndMove();

    // Both clicks land before React re-renders, so the disabled attribute
    // cannot be what stops the second one.
    act(() => {
      approveButton().click();
      approveButton().click();
    });
    await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
    expect(actions()).toEqual(["describe", "approve"]);
  });

  it("disables both buttons while the decision is in flight", async () => {
    let release: (r: Response) => void = () => {};
    renderConnect();
    await heading(/Connect Claude to Bikeshed\?/);
    await lookAndMove();
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );

    fireEvent.click(approveButton());
    await waitFor(() => expect(approveButton().getAttribute("aria-busy")).toBe("true"));
    expect(approveButton().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      release(new Response(JSON.stringify({ redirect: APPROVED }), { status: 200 }));
    });
  });

  it("leaves for exactly the URL the server returned", async () => {
    renderConnect();
    await heading(/Connect Claude to Bikeshed\?/);
    await lookAndMove();
    fireEvent.click(approveButton());

    await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
    expect(leave).toHaveBeenCalledWith(APPROVED);
    await heading(/Going back to claude\.ai/);
    expect(screen.getByRole("link", { name: /continue to claude\.ai/ }).getAttribute("href")).toBe(
      APPROVED,
    );
  });

  it.each([
    ["a javascript: URL", "javascript:alert(document.cookie)//?code=c1"],
    ["another host", "https://claude.ai.evil.test/api/mcp/auth_callback?code=c1"],
  ])("refuses %s from the server", async (_label, url) => {
    server.approve = { redirect: url };
    renderConnect();
    await heading(/Connect Claude to Bikeshed\?/);
    await lookAndMove();
    fireEvent.click(approveButton());

    await heading(/That didn't work/);
    expect(leave).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /continue/ })).toBeNull();
  });

  it("follows the deny redirect on Cancel", async () => {
    renderConnect();
    await heading(/Connect Claude to Bikeshed\?/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(leave).toHaveBeenCalledWith(DENIED));
    expect(actions()).toEqual(["describe", "deny"]);
  });

  it("offers the way back for an error the app may hear, and leaves only when asked", async () => {
    const back = `${REQUEST.redirect_uri}?error=invalid_request&state=s1`;
    server.describe = { valid: false, error: "invalid_request", message: "PKCE is required.", back };
    renderConnect();
    await heading(/This request can't go ahead/);
    expect(screen.getByText("PKCE is required.")).toBeDefined();
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(leave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Go back to claude.ai" }));
    expect(leave).toHaveBeenCalledWith(back);
  });

  it("never offers a way back for an error that is not safe to send", async () => {
    server.describe = { valid: false, error: "invalid_client", message: "Unknown app." };
    renderConnect();
    await heading(/This request can't go ahead/);
    expect(screen.queryByRole("button", { name: /Go back/ })).toBeNull();
    expect(leave).not.toHaveBeenCalled();
  });
});

describe("who is asking", () => {
  const LOOPBACK = /a program on this computer\. Approve only if you just started it/i;
  const UNCHECKED = "chosen by the app, not checked";

  it("names a verified host, with no warning", async () => {
    renderConnect();
    await heading(/Connect Claude to Bikeshed\?/);
    expect(screen.getByText("claude.ai", { selector: ".connect-from strong" })).toBeDefined();
    expect(screen.queryByText(LOOPBACK)).toBeNull();
    expect(screen.queryByText(UNCHECKED)).toBeNull();
  });

  it("warns about a program on this computer for a loopback redirect", async () => {
    server.describe = CLI;
    renderConnect({ ...REQUEST, redirect_uri: "http://127.0.0.1:53682/callback" });
    await heading(/Connect Bikeshed CLI to Bikeshed\?/);
    expect(screen.getByText(LOOPBACK)).toBeDefined();
    expect(screen.getByText("ana-laptop")).toBeDefined();
    expect(screen.getByText("(as reported by the program)")).toBeDefined();
    expect(screen.queryByText(UNCHECKED)).toBeNull();
  });

  it("leads with the destination, and labels the name, for an app that named itself", async () => {
    server.describe = DCR_WEB;
    renderConnect();
    await heading(/Connect claude\.ai to Bikeshed\?/);
    expect(screen.getByText(UNCHECKED)).toBeDefined();
    expect(screen.getByText("Totally Claude").tagName).toBe("Q");
    expect(screen.getByText(/Anyone can register an app under any name/)).toBeDefined();
    expect(screen.queryByText(LOOPBACK)).toBeNull();
  });

  it("shows the destination as punycode, not as the characters it imitates", async () => {
    server.describe = DCR_WEB;
    renderConnect({ ...REQUEST, redirect_uri: "https://сlaude.ai/cb" });
    await heading(/Connect xn--laude-/);
    expect(screen.queryByText("сlaude.ai")).toBeNull();
  });
});

describe("the sequences a real visitor performs", () => {
  /**
   * The bug this exists for: a capture inside the page runs after App's
   * analytics effect, because the page is not mounted while the gate is still
   * loading, so gtag sees client_id, redirect_uri and state in the address.
   */
  it("keeps the authorize query out of analytics, and shows it after signing in", async () => {
    auth.gate = "loading";
    auth.user = null;
    window.history.replaceState(null, "", `/connect${QUERY}`);
    const tree = () => (
      <MemoryRouter initialEntries={[`/connect${QUERY}`]}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </MemoryRouter>
    );
    const { rerender } = render(tree());

    expect(seen.hrefs.length).toBeGreaterThan(0);
    for (const href of seen.hrefs) {
      expect(href).not.toContain("client_id");
      expect(href).not.toContain("state=");
    }

    auth.gate = "signed_out";
    rerender(tree());
    expect(screen.getByText("SIGN-IN SCREEN")).toBeDefined();

    signedIn();
    rerender(tree());
    await heading(/Connect Claude to Bikeshed\?/);
    expect(screen.queryByText("WORKSPACE")).toBeNull();
    expect(server.calls.map((c) => c.params)).toEqual([REQUEST]);
  });

  it("ready, Switch account, signed out, ready again: the same request is described", async () => {
    window.history.replaceState(null, "", `/connect${QUERY}`);
    const { rerender } = render(routeTree());
    await heading(/Connect Claude to Bikeshed\?/);

    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await waitFor(() => expect(auth.signOut).toHaveBeenCalledTimes(1));
    rerender(routeTree());
    expect(screen.getByText("SIGN-IN SCREEN")).toBeDefined();

    signedIn("u2");
    rerender(routeTree());
    await heading(/Connect Claude to Bikeshed\?/);

    expect(actions()).toEqual(["describe", "describe"]);
    expect(server.calls[1].params).toEqual(server.calls[0].params);
    expect(server.calls[1].authorization).toBe("Bearer id-token-u2");
  });
});
