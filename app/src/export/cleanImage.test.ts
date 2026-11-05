// SPDX-License-Identifier: Apache-2.0
// Image snapshots remove decoration before layout without changing the reader's document (SPEC §20).

import { afterEach, describe, expect, it, vi } from "vitest";
import { imageSnapshot, withCleanImageNode } from "./cleanImage";

it("keeps authored style and ancestors but removes reader marks before computing image styles", () => {
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><head>
    <style>.paper section { color: green; width: 420px } mark.bshd-hl { color: red }</style>
    </head><body><main class="paper"><section id="chosen"><p data-bshd="author">
    Before <mark class="bshd-hl" data-bshd-ann="private-thread"><b>the passage</b></mark> after
    </p><div data-bshd="peers">private peer</div><script>unsafe()</script><a onclick="unsafe()" href="javascript:unsafe()">safe text</a></section></main></body></html>`, "text/html");
  const before = doc.documentElement.outerHTML;
  const snapshot = imageSnapshot(doc.querySelector("section")!);
  const clean = new DOMParser().parseFromString(snapshot.html, "text/html");
  const selected = snapshot.path.reduce<Node>((node, index) => node.childNodes[index], clean.documentElement) as Element;
  expect(selected.id).toBe("chosen");
  expect(selected.parentElement?.className).toBe("paper");
  expect(clean.querySelector("style")?.textContent).toContain("width: 420px");
  expect(clean.querySelector(".bshd-hl")).toBeNull();
  expect(clean.querySelector("[data-bshd-ann]")).toBeNull();
  expect(clean.querySelector('[data-bshd="peers"]')).toBeNull();
  expect(clean.querySelector('[data-bshd="author"] b')?.textContent).toBe("the passage");
  expect(clean.querySelectorAll("script,[onclick],[href^='javascript:']")).toHaveLength(0);
  expect(doc.documentElement.outerHTML).toBe(before);
});

describe("the frame an image export renders in", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  function page(): HTMLElement {
    document.body.innerHTML = `<main class="paper"><section id="chosen"><p>Before
      <mark class="bshd-hl" data-bshd-ann="thread"><b>the passage</b></mark> after</p></section></main>`;
    return document.getElementById("chosen")!;
  }

  function onFrameAdded(then: (frame: HTMLIFrameElement) => void) {
    const append = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
      append(node);
      then(node as unknown as HTMLIFrameElement);
      return node;
    });
  }

  /** jsdom ignores `srcdoc` and leaves the frame empty, so this plays the browser's part. */
  function loadFrames(prepare?: (doc: Document) => void) {
    onFrameAdded((frame) => {
      const doc = frame.contentDocument!;
      doc.open();
      doc.write(frame.srcdoc);
      doc.close();
      prepare?.(doc);
      frame.onload?.(new Event("load"));
    });
  }

  const frameInPage = () => document.querySelector("iframe");

  it("renders a clean copy of the chosen node in an inert frame at the reader's viewport", async () => {
    vi.stubGlobal("innerWidth", 640);
    vi.stubGlobal("innerHeight", 480);
    const chosen = page();
    loadFrames();
    let frame!: HTMLIFrameElement;
    const out = await withCleanImageNode(chosen, async (clean) => {
      frame = frameInPage()!;
      expect(clean.ownerDocument).toBe(frame.contentDocument);
      expect(clean.id).toBe("chosen");
      expect(clean.parentElement?.className).toBe("paper");
      expect(clean.textContent).toContain("the passage");
      expect(clean.querySelector(".bshd-hl")).toBeNull();
      return "rendered";
    });
    expect(out).toBe("rendered");
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.tabIndex).toBe(-1);
    expect(frame.style.width).toBe("640px");
    expect(frame.style.height).toBe("480px");
    expect(frameInPage()).toBeNull();
    expect(chosen.querySelector(".bshd-hl")).not.toBeNull();
  });

  it("removes the frame when the render fails, and passes the failure on", async () => {
    const chosen = page();
    loadFrames();
    await expect(withCleanImageNode(chosen, async () => {
      throw new Error("the picture could not be drawn");
    })).rejects.toThrow("the picture could not be drawn");
    expect(frameInPage()).toBeNull();
  });

  it("gives up on a document that never loads after 15 seconds, and removes the frame", async () => {
    vi.useFakeTimers();
    const chosen = page();
    onFrameAdded((frame) => {
      frame.onload = null;
    });
    const render = vi.fn();
    const refused = expect(withCleanImageNode(chosen, render)).rejects.toThrow("could not load its document");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(frameInPage()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await refused;
    expect(render).not.toHaveBeenCalled();
    expect(frameInPage()).toBeNull();
  });

  it("refuses a frame whose document it cannot open, and removes the frame", async () => {
    const chosen = page();
    onFrameAdded((frame) => {
      Object.defineProperty(frame, "contentDocument", { value: null });
      frame.onload?.(new Event("load"));
    });
    const render = vi.fn();
    await expect(withCleanImageNode(chosen, render)).rejects.toThrow("could not open its document");
    expect(render).not.toHaveBeenCalled();
    expect(frameInPage()).toBeNull();
  });

  it("draws an authored canvas into the copy, and no canvas from an app overlay", async () => {
    const chosen = page();
    chosen.insertAdjacentHTML("beforeend", '<canvas id="drawing"></canvas>');
    document.body.insertAdjacentHTML("beforeend", '<div data-bshd="peers"><canvas id="overlay"></canvas></div>');
    const authored = document.getElementById("drawing");
    const drawn: { target: string; source: unknown }[] = [];
    loadFrames((doc) => {
      doc.querySelectorAll("canvas").forEach((canvas) => {
        canvas.getContext = (() => ({
          drawImage: (source: unknown) => drawn.push({ target: canvas.id, source }),
        })) as unknown as typeof canvas.getContext;
      });
    });
    await withCleanImageNode(chosen, async () => {});
    expect(drawn).toEqual([{ target: "drawing", source: authored }]);
  });

  it("waits for the frame's fonts, but no longer than four seconds", async () => {
    vi.useFakeTimers();
    const chosen = page();
    loadFrames((doc) => {
      Object.defineProperty(doc, "fonts", { value: { ready: new Promise(() => {}) } });
    });
    const render = vi.fn(async () => "rendered");
    const pending = withCleanImageNode(chosen, render);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(render).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("rendered");
    expect(frameInPage()).toBeNull();
  });

  it("does not wait at all once the frame's fonts are ready", async () => {
    vi.useFakeTimers();
    const chosen = page();
    loadFrames((doc) => {
      Object.defineProperty(doc, "fonts", { value: { ready: Promise.resolve() } });
    });
    await expect(withCleanImageNode(chosen, async () => "rendered")).resolves.toBe("rendered");
    expect(vi.getTimerCount()).toBe(0);
  });
});
