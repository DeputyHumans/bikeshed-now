// SPDX-License-Identifier: Apache-2.0
// How the viewer hears from a document whose engine delivers it no events (SPEC §6).

import { FRAME_PROBE_EVENT } from "../brand/dom";

/**
 * Why this exists
 * ---------------
 * The viewer drives the document from outside: every listener on a reading
 * frame is added by the parent. WebKit — Safari, and every browser on an
 * iPhone — never calls a listener the parent adds to a document whose frame
 * is sandboxed without `allow-scripts`, which is every untrusted document.
 * Not selectionchange, not click, not input, not a custom event. Chrome calls
 * them all, which is why nothing failed until somebody tried it on a phone.
 *
 * What WebKit still allows is reading: the parent can read the frame's
 * selection, scroll and focus whenever it likes, and a MutationObserver
 * created from the frame's own window is delivered. So where a document
 * refuses listeners, each watch here samples what it watches from the
 * parent's own timer instead, and calls back only on a change. Where
 * listeners work, it is an ordinary listener, so nothing else changes.
 */

/** How often a document that refuses listeners is sampled. Slow enough to cost nothing, quick enough to feel immediate. */
export const SAMPLE_MS = 150;

const delivers = new WeakMap<Document, boolean>();

/**
 * Whether a listener the parent adds to `doc` is ever called. Asked once per
 * document by dispatching a probe the parent itself listens for: synchronous,
 * so the answer is known before anything else attaches. Engine-agnostic: no
 * browser is named, only what this one does.
 */
export function deliversEvents(doc: Document): boolean {
  const known = delivers.get(doc);
  if (known !== undefined) return known;
  let heard = false;
  const probe = () => {
    heard = true;
  };
  try {
    doc.addEventListener(FRAME_PROBE_EVENT, probe);
    doc.dispatchEvent(new Event(FRAME_PROBE_EVENT));
  } catch {
    // A document that throws here delivers nothing either.
  } finally {
    doc.removeEventListener(FRAME_PROBE_EVENT, probe);
  }
  delivers.set(doc, heard);
  return heard;
}

/**
 * Sample `read` on the parent's timer and call `onChange` when it differs
 * from the last value by `same`. Not paused for a hidden page: browsers
 * already slow a hidden page's timers, and a page can be hidden while it is
 * shown, as in a web view that is not in a window.
 */
function sample<T>(read: () => T, same: (a: T, b: T) => boolean, onChange: () => void): () => void {
  let last = read();
  const tick = () => {
    let now: T;
    try {
      now = read();
    } catch {
      return;
    }
    if (same(last, now)) return;
    last = now;
    onChange();
  };
  const timer = window.setInterval(tick, SAMPLE_MS);
  return () => window.clearInterval(timer);
}

interface SelectionShape {
  anchor: Node | null;
  anchorOffset: number;
  focus: Node | null;
  focusOffset: number;
  ranges: number;
  /** Where it is drawn, so a selection that moves with the page is a change too. */
  rect: string;
}

function selectionShape(doc: Document): SelectionShape {
  const sel = doc.getSelection();
  let rect = "";
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    rect = `${r.left},${r.top},${r.width},${r.height}`;
  }
  return {
    anchor: sel?.anchorNode ?? null,
    anchorOffset: sel?.anchorOffset ?? 0,
    focus: sel?.focusNode ?? null,
    focusOffset: sel?.focusOffset ?? 0,
    ranges: sel?.rangeCount ?? 0,
    rect,
  };
}

const sameSelection = (a: SelectionShape, b: SelectionShape) =>
  a.anchor === b.anchor &&
  a.anchorOffset === b.anchorOffset &&
  a.focus === b.focus &&
  a.focusOffset === b.focusOffset &&
  a.ranges === b.ranges &&
  a.rect === b.rect;

/** Call `onChange` when the document's selection changes. Returns a cleanup. */
export function watchSelection(doc: Document, onChange: () => void): () => void {
  if (deliversEvents(doc)) {
    doc.addEventListener("selectionchange", onChange);
    return () => doc.removeEventListener("selectionchange", onChange);
  }
  return sample(() => selectionShape(doc), sameSelection, onChange);
}

/** Call `onChange` when the document's window scrolls. Returns a cleanup. */
export function watchScroll(doc: Document, onChange: () => void): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  if (deliversEvents(doc)) {
    view.addEventListener("scroll", onChange, { passive: true });
    return () => view.removeEventListener("scroll", onChange);
  }
  return sample(() => `${view.scrollX},${view.scrollY}`, (a, b) => a === b, onChange);
}

/** Call `onChange` when the document's viewport changes size. Returns a cleanup. */
export function watchResize(doc: Document, onChange: () => void): () => void {
  const view = doc.defaultView;
  if (!view) return () => {};
  if (deliversEvents(doc)) {
    view.addEventListener("resize", onChange);
    return () => view.removeEventListener("resize", onChange);
  }
  return sample(() => `${view.innerWidth}x${view.innerHeight}`, (a, b) => a === b, onChange);
}

/**
 * Call `onFocus` with the element that takes focus inside the document. Only
 * needed where clicks are not delivered: a tap on a focusable element still
 * focuses it, and focus can be read. Where listeners work it is `focusin`.
 */
export function watchFocus(doc: Document, onFocus: (el: Element) => void): () => void {
  if (deliversEvents(doc)) {
    const on = (e: Event) => {
      if (e.target instanceof doc.defaultView!.Element) onFocus(e.target);
    };
    doc.addEventListener("focusin", on);
    return () => doc.removeEventListener("focusin", on);
  }
  let last: Element | null = doc.activeElement;
  const timer = window.setInterval(() => {
    const now = doc.activeElement;
    if (now === last) return;
    last = now;
    if (now && now !== doc.body) onFocus(now);
  }, SAMPLE_MS);
  return () => window.clearInterval(timer);
}

/**
 * True when the parent hears nothing from this document, so a gesture-only
 * signal (a click, a key, a wheel) will never arrive and a hook must fall back
 * to what can be watched.
 */
export function refusesListeners(doc: Document | null): boolean {
  return doc !== null && !deliversEvents(doc);
}
