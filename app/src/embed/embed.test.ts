// SPDX-License-Identifier: Apache-2.0
// The embed page's script: the frame it reads, the clock it gates on the host's viewport, and its own consent (SPEC §2 "GET /embed/…", §4, §15).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The modules this script composes are tested where they live. Here they are
 * stubbed, so what is asserted is the wiring: which document gets the link
 * handling, when the clock is told the embed is in view, and that analytics
 * starts only on this embed's own Allow, in the same page that asked.
 */

const calls = vi.hoisted(() => ({
  attached: [] as unknown[],
  watched: [] as unknown[],
  inView: [] as boolean[],
  tracked: [] as unknown[][],
  optOut: [] as boolean[],
  pageViews: [] as string[],
  events: [] as unknown[],
  configured: true,
}));

vi.mock("../viewer/outboundLinks", () => ({
  attachOutboundLinks: (doc: unknown) => {
    calls.attached.push(doc);
    return () => {};
  },
  openBeside: () => {},
}));
vi.mock("../viewer/frameWatch", () => ({
  watchActivity: (doc: unknown) => {
    calls.watched.push(doc);
    return () => {};
  },
}));
vi.mock("../stats", () => ({
  trackView: (...args: unknown[]) => {
    calls.tracked.push(args);
    return { markActive: () => {}, setInView: (v: boolean) => calls.inView.push(v), stop: () => {} };
  },
}));
vi.mock("../analytics", () => ({
  analyticsConfigured: () => calls.configured,
  setAnalyticsOptOut: async (value: boolean) => {
    calls.optOut.push(value);
  },
  logPageView: (path: string) => calls.pageViews.push(path),
  logEvent: (event: unknown) => calls.events.push(event),
}));

import { readFrame, startEmbed } from "./embed";

/** What docShell writes, as far as the script reads it. */
function page(attrs: Record<string, string> = {}): { root: HTMLElement; frame: HTMLIFrameElement } {
  document.body.innerHTML = "";
  const root = document.createElement("main");
  root.id = "embed";
  const frame = document.createElement("iframe");
  frame.id = "embed-frame";
  const data = { doc: "memo", version: "v3", format: "html", ...attrs };
  for (const [key, value] of Object.entries(data)) frame.dataset[key] = value;
  root.append(frame);
  document.body.append(root);
  return { root, frame };
}

/** A frame whose document is the version's entry, loaded. */
function loaded(frame: HTMLIFrameElement, url = "https://bikeshed.example/content/memo/v3/index.html") {
  const doc = { URL: url, readyState: "complete" } as unknown as Document;
  Object.defineProperty(frame, "contentDocument", { value: doc, configurable: true });
  return doc;
}

/** An IntersectionObserver the test moves, as a reader scrolling the host page would. */
let observerCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
class FakeObserver {
  constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    observerCallback = cb;
  }
  observe() {}
  disconnect() {
    observerCallback = null;
  }
}
const scroll = (isIntersecting: boolean) => observerCallback?.([{ isIntersecting }]);

beforeEach(() => {
  for (const list of [calls.attached, calls.watched, calls.inView, calls.tracked, calls.optOut, calls.pageViews, calls.events]) {
    list.length = 0;
  }
  calls.configured = true;
  window.localStorage.clear();
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  observerCallback = null;
});

describe("readFrame", () => {
  it("reads what the server wrote, and the key only when there is one", () => {
    expect(readFrame(page().frame)).toEqual({ docId: "memo", versionId: "v3", format: "html" });
    expect(readFrame(page({ k: "tok", format: "markdown" }).frame)).toEqual({
      docId: "memo",
      versionId: "v3",
      k: "tok",
      format: "markdown",
    });
  });

  it("is null for a frame this page did not make", () => {
    const { frame } = page();
    delete frame.dataset.doc;
    expect(readFrame(frame)).toBeNull();
  });
});

describe("startEmbed", () => {
  it("runs the clock as an embed, out of view until the host page shows it", () => {
    const { frame, root } = page({ k: "tok" });
    const stop = startEmbed(frame, root);
    expect(calls.tracked).toEqual([["memo", "v3", "tok", { surface: "embed", inView: false }]]);
    expect(calls.inView, "nothing is in view before the observer says so").toEqual([]);
    scroll(false);
    scroll(true);
    scroll(false);
    expect(calls.inView).toEqual([false, true, false]);
    stop();
  });

  it("hands the loaded document, not the empty one before it, to the link handling and the activity watch", () => {
    const { frame, root } = page();
    Object.defineProperty(frame, "contentDocument", {
      value: { URL: "about:blank", readyState: "complete" },
      configurable: true,
    });
    const stop = startEmbed(frame, root);
    expect(calls.attached, "the frame's first, empty document is not the document").toHaveLength(0);

    const doc = loaded(frame);
    frame.dispatchEvent(new Event("load"));
    expect(calls.attached).toEqual([doc]);
    expect(calls.watched).toEqual([doc]);

    // A bundle's own page navigates the frame: the new document gets them too.
    const next = loaded(frame, "https://bikeshed.example/content/memo/v3/two.html");
    frame.dispatchEvent(new Event("load"));
    expect(calls.attached).toEqual([doc, next]);
    stop();
  });

  it("attaches at once to a frame that loaded before the script ran", () => {
    const { frame, root } = page();
    const doc = loaded(frame);
    const stop = startEmbed(frame, root);
    expect(calls.attached).toEqual([doc]);
    stop();
  });

  it("asks for consent, and starts analytics on Allow in the same page", async () => {
    /**
     * unset → granted in one page is the only sequence a real visitor
     * performs. A test per state, each in a fresh module, would never see it.
     */
    const { frame, root } = page({ format: "markdown" });
    const stop = startEmbed(frame, root);
    const bar = root.querySelector(".embed-consent");
    expect(bar, "an unanswered visitor is asked").not.toBeNull();
    expect(calls.optOut, "nothing starts before the answer").toEqual([]);

    const allow = Array.from(bar!.querySelectorAll("button")).find((b) => b.textContent === "Allow")!;
    allow.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelector(".embed-consent"), "one answer ends the bar").toBeNull();
    expect(window.localStorage.getItem("bshd-consent")).toBe("granted");
    // No account inside an embed: consent is the only gate (SPEC §15).
    expect(calls.optOut).toEqual([false]);
    expect(calls.pageViews).toEqual([window.location.pathname]);
    expect(calls.events).toEqual([{ name: "doc_open", params: { format: "markdown", sandboxed: true, embedded: true } }]);
    stop();
  });

  it("starts nothing on No thanks, and asks nothing once answered", async () => {
    const first = page();
    startEmbed(first.frame, first.root);
    const decline = Array.from(first.root.querySelectorAll(".embed-consent button")).find((b) => b.textContent === "No thanks") as HTMLButtonElement;
    decline.click();
    await Promise.resolve();
    expect(window.localStorage.getItem("bshd-consent")).toBe("denied");
    expect(calls.optOut).toEqual([]);

    const again = page();
    startEmbed(again.frame, again.root);
    expect(again.root.querySelector(".embed-consent"), "a declined visitor is not asked again").toBeNull();
    expect(calls.optOut).toEqual([]);
  });

  it("starts analytics without asking when this embed was already allowed", async () => {
    window.localStorage.setItem("bshd-consent", "granted");
    const { frame, root } = page();
    startEmbed(frame, root);
    await Promise.resolve();
    expect(root.querySelector(".embed-consent")).toBeNull();
    expect(calls.optOut).toEqual([false]);
  });

  it("never asks on a deployment with no analytics", () => {
    calls.configured = false;
    const { frame, root } = page();
    startEmbed(frame, root);
    expect(root.querySelector(".embed-consent")).toBeNull();
    expect(calls.optOut).toEqual([]);
  });

  it("does nothing at all on the refusal page, which has no frame data", () => {
    const { frame, root } = page();
    delete frame.dataset.doc;
    startEmbed(frame, root);
    expect(calls.tracked).toEqual([]);
    expect(root.querySelector(".embed-consent")).toBeNull();
  });
});
