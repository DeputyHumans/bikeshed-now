// SPDX-License-Identifier: Apache-2.0
// The frame says it is loading for every load it makes, not only the first (SPEC §6a).

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FrameMode } from "./frameMode";
import { useDocFrame } from "./useDocFrame";

const READING: FrameMode = { kind: "reading", versionId: "v1", draft: false, sandboxed: false };

interface Props {
  mode: FrameMode;
  entry: string;
  trustToken: string;
  hold?: boolean;
}

/**
 * The hook with a real, same-origin iframe behind its ref, so a load yields a
 * real `contentDocument`. That matters for the remount cases: the obvious
 * signal, `doc === null`, is only wrong when there IS a previous document.
 */
function harness(initial: Partial<Props> = {}) {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const view = renderHook((props: Props) => useDocFrame({ docId: "d1", ...props }), {
    initialProps: { mode: READING, entry: "index.html", trustToken: "t0", ...initial },
  });
  (view.result.current.ref as { current: HTMLIFrameElement | null }).current = iframe;
  const load = () =>
    act(() => {
      const props = view.result.current.frameProps;
      if (!props) throw new Error("the frame is held, so there is nothing to load");
      props.onLoad();
    });
  return { ...view, load };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useDocFrame loading", () => {
  it("is loading before the first load, and not after it", () => {
    const { result, load } = harness();
    expect(result.current.loading).toBe(true);

    load();

    expect(result.current.loading).toBe(false);
    expect(result.current.doc).not.toBeNull();
  });

  it("is loading again after a reload, until that load lands", () => {
    const { result, load } = harness();
    load();

    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);

    load();
    expect(result.current.loading).toBe(false);
  });

  it("is loading again when a trust grant remounts the frame", () => {
    // The case `doc === null` gets wrong: a trust remount does not clear
    // `doc`, so the previous, detached document would read as loaded.
    const { result, rerender, load } = harness();
    load();

    rerender({ mode: READING, entry: "index.html", trustToken: "t1" });

    expect(result.current.doc).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it("is loading again when the entry navigates the same frame", () => {
    const { result, rerender, load } = harness();
    load();

    rerender({ mode: READING, entry: "slides.html", trustToken: "t0" });

    expect(result.current.loading).toBe(true);
  });

  it("is loading again on entering the editor", () => {
    const { result, rerender, load } = harness();
    load();

    rerender({ mode: { kind: "editing", baseVersion: "v1" }, entry: "index.html", trustToken: "t0" });

    expect(result.current.loading).toBe(true);
  });

  it("ends the wait even when the load yields no readable document", () => {
    // A frame whose document cannot be read must not leave the overlay up
    // for good; the overlay would then be the only thing on screen.
    const { result, load } = harness();
    (result.current.ref as { current: HTMLIFrameElement | null }).current = null;

    load();

    expect(result.current.doc).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

describe("useDocFrame hold", () => {
  it("gives a frame that has never loaded nothing to load while it is held", () => {
    // An iframe rendered without a src still loads about:blank and fires
    // `load`, and everything downstream would decorate that document instead.
    const { result } = harness({ hold: true });

    expect(result.current.frameProps).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it("hands the frame its document once the hold lifts", () => {
    const { result, rerender } = harness({ hold: true });

    rerender({ mode: READING, entry: "index.html", trustToken: "t0", hold: false });

    expect(result.current.frameProps?.src).toBe("/content/d1/v1/index.html");
    expect(result.current.loading).toBe(true);
  });

  it("never takes back a frame that has loaded", () => {
    // A reader who signs in to comment must keep the frame and the selection
    // in it, so a hold that arrives after the first load changes nothing.
    const { result, rerender, load } = harness();
    load();
    const key = result.current.frameProps?.key;

    rerender({ mode: READING, entry: "index.html", trustToken: "t0", hold: true });

    expect(result.current.frameProps).not.toBeNull();
    expect(result.current.frameProps?.key).toBe(key);
    expect(result.current.loading).toBe(false);
  });
});

describe("useDocFrame reading checkpoints", () => {
  function frame(html = '<p id="passage">Keep this selected passage.</p>') {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = html;
    const callbacks: FrameRequestCallback[] = [];
    Object.defineProperty(doc.defaultView!, "scrollY", { value: 0, writable: true, configurable: true });
    doc.defaultView!.requestAnimationFrame = (fn) => { callbacks.push(fn); return callbacks.length; };
    doc.defaultView!.scrollTo = vi.fn((options: ScrollToOptions | number) => {
      if (typeof options === "object") Object.defineProperty(doc.defaultView!, "scrollY", { value: options.top ?? 0, writable: true, configurable: true });
    }) as typeof window.scrollTo;
    return { iframe, doc, paint: () => act(() => { callbacks.splice(0).forEach((fn) => fn(0)); }) };
  }
  function attach(result: ReturnType<typeof harness>["result"], next: ReturnType<typeof frame>) {
    (result.current.ref as { current: HTMLIFrameElement | null }).current = next.iframe;
  }

  it("keeps the visible position across overlapping loads and a reload before restoration paints", () => {
    const { result, load } = harness();
    const first = frame(); attach(result, first); load();
    Object.defineProperty(first.doc.defaultView!, "scrollY", { value: 420, writable: true, configurable: true });
    act(() => result.current.reload());
    const interrupted = frame(); attach(result, interrupted);
    const abandonedLoad = result.current.frameProps!.onLoad;
    act(() => result.current.reload());
    const second = frame(); attach(result, second);
    const epochBeforeStaleLoad = result.current.epoch;
    act(() => abandonedLoad());
    expect(result.current.loading).toBe(true);
    expect(result.current.epoch).toBe(epochBeforeStaleLoad);
    expect(result.current.doc).toBeNull();
    load();
    // The replacement has loaded but its animation frame has not restored yet.
    act(() => result.current.reload());
    const final = frame(); attach(result, final); load();
    second.paint();
    expect(second.doc.defaultView!.scrollTo).not.toHaveBeenCalled();
    final.paint();
    expect(final.doc.defaultView!.scrollY).toBe(420);
    expect(result.current.loading).toBe(false);
  });

  it("restores the same selected quote after text moves and notifies the selection toolbar", () => {
    const { result, load } = harness();
    const first = frame(); attach(result, first); load();
    const range = first.doc.createRange();
    range.setStart(first.doc.getElementById("passage")!.firstChild!, 5);
    range.setEnd(first.doc.getElementById("passage")!.firstChild!, 18);
    first.doc.getSelection()!.addRange(range);
    expect(first.doc.getSelection()!.toString()).toBe("this selected");
    act(() => result.current.reload());
    const next = frame('<p id="passage">New words above. Keep this selected passage.</p>'); attach(result, next);
    const changed = vi.fn(); next.doc.addEventListener("selectionchange", changed);
    load(); next.paint();
    expect(next.doc.getSelection()!.toString()).toBe("this selected");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("does not restore a positional fallback onto different words", () => {
    const { result, load } = harness();
    const first = frame(); attach(result, first); load();
    const range = first.doc.createRange();
    range.selectNodeContents(first.doc.getElementById("passage")!);
    first.doc.getSelection()!.addRange(range);
    act(() => result.current.reload());
    const next = frame('<p id="passage">Completely different text with enough characters.</p>'); attach(result, next);
    load(); next.paint();
    expect(next.doc.getSelection()!.rangeCount).toBe(0);
  });
});

it("never hands a refused JSON editor response to editing hooks, and clears it on a successful retry", () => {
  const { result, load } = harness({ mode: { kind: "editing", baseVersion: "v1", liveEpoch: "old", draftRevision: "a".repeat(64) } });
  const doc = result.current.ref.current!.contentDocument!;
  Object.defineProperty(doc, "contentType", { value: "application/json", configurable: true });
  doc.body.textContent = '{"error":"The draft changed"}';
  load();
  expect(result.current.loading).toBe(false);
  expect(result.current.doc).toBeNull();
  expect(result.current.loadError).toContain("Reload");
  Object.defineProperty(doc, "contentType", { value: "text/html", configurable: true });
  act(() => result.current.reload()); load();
  expect(result.current.doc).toBe(doc);
  expect(result.current.loadError).toBeNull();
});

it("withholds the previous document immediately when the same-version editor revision changes", () => {
  const { result, load, rerender } = harness({ mode: { kind: "editing", baseVersion: "v1", draftRevision: "a".repeat(64) } });
  load();
  expect(result.current.doc).not.toBeNull();
  rerender({ mode: { kind: "editing", baseVersion: "v1", draftRevision: "b".repeat(64) }, entry: "index.html", trustToken: "t0" });
  expect(result.current.doc).toBeNull();
  expect(result.current.loading).toBe(true);
});
