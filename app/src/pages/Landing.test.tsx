// SPDX-License-Identifier: Apache-2.0
// Only a signed-out visitor gets the landing page, and only at / (SPEC §7).

import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App";
import { ToastProvider } from "../components/Toast";
import { Landing, agentInstructions } from "./Landing";
import type { AuthGate } from "../auth";
import appPackage from "../../package.json";

/**
 * The gate is the subject, so it is the thing driven directly. `vi.hoisted` is
 * required because vi.mock's factory runs above every other statement in the
 * file, and a plain const would still be in the temporal dead zone.
 */
const auth = vi.hoisted(() => ({ gate: "loading" as AuthGate, user: null as { uid: string } | null }));
const layout = vi.hoisted(() => ({ singleColumn: false, mediaBase: "" }));

vi.mock("../hooks/useMediaQuery", async (importOriginal) => ({
  ...await importOriginal<typeof import("../hooks/useMediaQuery")>(),
  useIsSingleColumn: () => layout.singleColumn,
}));

vi.mock("../config", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config")>(),
  get LANDING_MEDIA_BASE_URL() { return layout.mediaBase; },
}));

vi.mock("../auth", () => ({
  useAuth: () => ({
    gate: auth.gate,
    user: auth.user,
    emailLower: "",
    signOut: vi.fn(),
  }),
}));

/**
 * Vitest loads app/.env.local, so analytics would otherwise pick up whatever
 * measurement id happens to be configured and log from a unit test. Stub the
 * module rather than assert around the ambient value.
 */
vi.mock("../analytics", () => ({
  initAnalytics: () => {},
  logPageView: () => {},
  // False keeps the consent banner out of the tree: it only appears where
  // analytics is configured, and it is not the subject here.
  analyticsConfigured: () => false,
}));

/**
 * The routed destinations are reduced to markers on purpose. What changed is
 * WHICH of them a gate selects; their contents are covered by their own tests,
 * and rendering DocList for real would open Firestore subscriptions.
 */
vi.mock("./DocList", () => ({ DocList: () => <p>WORKSPACE</p> }));
vi.mock("./SignUp", () => ({ SignUp: () => <p>SIGN-IN SCREEN</p> }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </MemoryRouter>,
  );
}

const hero = () =>
  screen.queryByRole("heading", { name: /Everyone has an opinion/i });

beforeEach(() => {
  auth.gate = "loading";
  auth.user = null;
  layout.singleColumn = false;
  layout.mediaBase = "";
});

it("moves one agent card around the same video without losing its position across desktop, mobile, and desktop", () => {
  layout.mediaBase = "https://storage.googleapis.com/demo-bikeshed-media/landing/v1";
  const page = () => <MemoryRouter><ToastProvider><Landing /></ToastProvider></MemoryRouter>;
  const { container, rerender } = render(page());
  const video = container.querySelector("video")!;
  video.currentTime = 27;

  for (const singleColumn of [false, true, false]) {
    layout.singleColumn = singleColumn;
    rerender(page());
    expect(container.querySelector("video")).toBe(video);
    expect(video.currentTime).toBe(27);
    const cards = screen.getAllByRole("complementary", { name: "Put your agent to work" });
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(hero()!.closest("section")!.contains(card)).toBe(!singleColumn);
    expect(Boolean(card.compareDocumentPosition(video) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(!singleColumn);
  }
});

describe("who gets the landing page", () => {
  it("shows it to a signed-out visitor at /", () => {
    auth.gate = "signed_out";
    renderAt("/");
    expect(hero()).not.toBeNull();
    expect(screen.queryByText("SIGN-IN SCREEN")).toBeNull();
  });

  it("shows the workspace, not the landing page, once the gate is ready", () => {
    auth.gate = "ready";
    renderAt("/");
    expect(screen.getByText("WORKSPACE")).toBeDefined();
    expect(hero()).toBeNull();
  });

  /**
   * The regression that matters most.
   *
   * These three are signed-in-but-not-admitted: somebody mid-flow, waiting on a
   * verification code or reading why their address was refused. Marketing in
   * place of the form they need would strand them, and `not_allowed` carries a
   * message the deployment wrote for them.
   */
  it.each<AuthGate>(["needs_email", "needs_verification", "not_allowed"])(
    "sends %s to the sign-in screen at /, never the landing page",
    (gate) => {
      auth.gate = gate;
      renderAt("/");
      expect(screen.getByText("SIGN-IN SCREEN")).toBeDefined();
      expect(hero()).toBeNull();
    },
  );

  /** The landing page is opted into by `/` alone, not by being signed out. */
  it.each(["/folder/f1", "/account"])(
    "sends a signed-out visitor at %s to the sign-in screen",
    (path) => {
      auth.gate = "signed_out";
      renderAt(path);
      expect(screen.getByText("SIGN-IN SCREEN")).toBeDefined();
      expect(hero()).toBeNull();
    },
  );

  it("shows the spinner, not the landing page, while the gate is loading", () => {
    auth.gate = "loading";
    renderAt("/");
    expect(hero()).toBeNull();
    expect(screen.queryByText("SIGN-IN SCREEN")).toBeNull();
  });
});

/**
 * Checking each gate in isolation is what let the consent bug through: every
 * state passed alone, and the only sequence a real visitor performs was never
 * run. A visitor does not arrive in a state, they TRANSITION through them, so
 * these drive the change inside one mount.
 */
describe("the sequences a real visitor performs", () => {
  it("loading -> signed_out -> ready swaps the landing page for the workspace", () => {
    auth.gate = "loading";
    const { rerender } = renderAt("/");
    expect(hero()).toBeNull();

    auth.gate = "signed_out";
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(hero()).not.toBeNull();

    auth.gate = "ready";
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("WORKSPACE")).toBeDefined();
    expect(hero()).toBeNull();
  });

  it("signed_out -> needs_verification replaces the landing page with the form", () => {
    auth.gate = "signed_out";
    const { rerender } = renderAt("/");
    expect(hero()).not.toBeNull();

    auth.gate = "needs_verification";
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("SIGN-IN SCREEN")).toBeDefined();
    expect(hero()).toBeNull();
  });
});

/**
 * A router <Link> renders the same `href="/docs"` as a plain anchor, so the
 * attribute proves nothing. What differs is the click: a Link cancels it and
 * navigates inside the app, where /docs meets the catch-all route and lands on
 * /. Only a click the page lets through reaches Hosting's redirect to the
 * guide. A listener on window runs after React's, so it sees that decision,
 * then cancels the click itself because jsdom cannot navigate.
 */
function letsThrough(link: HTMLElement): boolean {
  let through = false;
  const look = (e: Event) => {
    through = !e.defaultPrevented;
    e.preventDefault();
  };
  window.addEventListener("click", look);
  try {
    fireEvent.click(link);
  } finally {
    window.removeEventListener("click", look);
  }
  return through;
}

describe("the Docs link", () => {
  it("is in the header and the landing footer for a signed-out visitor", () => {
    auth.gate = "signed_out";
    renderAt("/");
    const links = screen.getAllByRole("link", { name: "Docs" });
    expect(links).toHaveLength(2);
    expect(links[0].closest("header")).not.toBeNull();
    expect(links[1].closest("footer")).not.toBeNull();
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/docs");
      expect(letsThrough(link)).toBe(true);
    }
  });

  it("stays in the header once signed in, where there is no landing page", () => {
    auth.gate = "ready";
    auth.user = { uid: "u1" };
    renderAt("/");
    expect(screen.getByText("WORKSPACE")).toBeDefined();
    const links = screen.getAllByRole("link", { name: "Docs" });
    expect(links).toHaveLength(1);
    expect(links[0].closest("header")).not.toBeNull();
    expect(links[0].getAttribute("href")).toBe("/docs");
    expect(letsThrough(links[0])).toBe(true);
  });
});

describe("the agent instructions", () => {
  it("links to the guide at the live origin", () => {
    auth.gate = "signed_out";
    renderAt("/");
    // Asserted by suffix. jsdom supplies its own origin, and pinning a literal
    // one here would be asserting against ambient config.
    const link = screen.getByRole("link", { name: /llms\.txt$/ });
    expect(link.getAttribute("href")).toBe("/llms.txt");
  });

  it("copies instructions that name the guide and both formats", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    auth.gate = "signed_out";
    renderAt("/");
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("/llms.txt");
    expect(copied).toContain("HTML");
    expect(copied).toContain("Markdown");
    // The paste is the only always-on instruction a person gives their agent, so
    // it has to carry the two things the guide cannot make happen by itself:
    // installing the skills, and not publishing somewhere else instead.
    expect(copied).toContain("install the skills");
    expect(copied).toContain("built-in artifact tool");
    expect(screen.getByText("Instructions copied")).toBeDefined();
  });

  it("copies the address alone from the glyph, not the whole instructions", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    auth.gate = "signed_out";
    renderAt("/");
    fireEvent.click(screen.getByRole("button", { name: /copy the address/i }));

    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toMatch(/\/llms\.txt$/);
    // The distinction between the two buttons is the point of having both.
    expect(copied).not.toContain("Publish to Bikeshed");
    expect(screen.getByText("Address copied")).toBeDefined();
  });

  it("builds every reference from the origin it is given", () => {
    const text = agentInstructions("https://example.test");
    expect(text).toContain("https://example.test/llms.txt");
    expect(text).toContain("https://example.test/mcp");
    // The CLI defaults to another deployment, so the login names this one.
    expect(text).toContain("bikeshed-now login --origin https://example.test");
    expect(text).not.toContain("bikeshed.now");
  });

  /**
   * An agent told to ask for a token asks for one, and a person pastes a
   * credential into a chat. Connecting by address needs neither (SPEC §23).
   */
  it("asks for a connector or a browser login, never a minted token", () => {
    const text = agentInstructions("https://example.test");
    expect(text).toContain("as a connector");
    expect(text).not.toMatch(/mint/i);
    expect(text).not.toMatch(/access token/i);
  });
});

describe("the landing entry points", () => {
  it.each([0, 1])("Get started link %i reaches the sign-in flow", (index) => {
    auth.gate = "signed_out";
    renderAt("/");
    fireEvent.click(screen.getAllByRole("link", { name: "Get started" })[index]);
    expect(screen.getByText("SIGN-IN SCREEN")).toBeDefined();
  });

  it("identifies the app release actually built", () => {
    auth.gate = "signed_out";
    renderAt("/");
    expect(screen.getByText(`Self-hosted. Apache-2.0. v${appPackage.version}.`)).toBeDefined();
  });
});
