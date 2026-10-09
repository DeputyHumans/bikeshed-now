// SPDX-License-Identifier: Apache-2.0
// The approver's review pass: one suggestion at a time, in the live draft (SPEC §22).

import { useEffect, useRef, useState } from "react";
import { exactRangeFromAnchor, resolveSuggestion, type ApplyResult, type Resolution } from "../annotation/exact";
import { TOKENS } from "../brand/tokens";
import type { Annotation } from "../types";
import type { FrameMode } from "./frameMode";

/**
 * DECLARED AFTER `useInlineEditor`, unlike every hook that decorates. This one
 * EDITS — accepting a suggestion is an edit in the session the editor owns — so
 * it needs the editing host up, not stripped. And it puts nothing in the
 * document to strip: the target is marked with the CSS Custom Highlight API and
 * an adopted stylesheet, neither of which is a node or an attribute, so neither
 * reaches the serializer or the CRDT's observer, which watches both (SPEC §6a,
 * §16). It is in `viewer/invariant.test.tsx` all the same, so that claim is
 * checked rather than trusted.
 */

const HIGHLIGHT = "bshd-review";

/**
 * Which pending suggestions Accept would refuse in the draft on screen. The
 * same resolver Accept runs, so the bar never offers an Accept that can only
 * fail, nor greys out one that would record a change already made.
 */
function staleIn(doc: Document, pending: Annotation[]): Set<string> {
  return new Set(
    pending
      .filter((a) => resolveSuggestion(doc, a.anchor, a.suggestion?.replacement ?? "").state === "stale")
      .map((a) => a.annId),
  );
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** What identifies the target to mark: its id and the words it anchors to, not the array it came in. */
function targetKey(a: Annotation | undefined): string | null {
  return a ? JSON.stringify([a.annId, a.anchor.elementId, a.anchor.prefix, a.anchor.exact, a.anchor.suffix]) : null;
}

interface HighlightWindow extends Window {
  Highlight?: new (...ranges: Range[]) => unknown;
  CSSStyleSheet: typeof CSSStyleSheet;
  CSS: typeof CSS & { highlights?: Map<string, unknown> };
}

/**
 * Mark one range in the frame without touching its DOM, and bring it into
 * view. Returns the undo. Without the highlight API (an older browser, or
 * jsdom) the range is selected instead, which is visible, if less so.
 */
function markTarget(doc: Document, range: Range, reduceMotion: boolean): () => void {
  const win = doc.defaultView as HighlightWindow | null;
  const target = range.startContainer.parentElement;
  target?.scrollIntoView?.({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  if (win?.Highlight && win.CSS?.highlights && "adoptedStyleSheets" in doc) {
    const sheet = new win.CSSStyleSheet();
    sheet.replaceSync(
      `::highlight(${HIGHLIGHT}) {
        background-color: color-mix(in srgb, ${TOKENS.annotation} 22%, transparent);
        text-decoration: underline 2px ${TOKENS.annotation};
      }`,
    );
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    win.CSS.highlights.set(HIGHLIGHT, new win.Highlight(range));
    return () => {
      win.CSS.highlights?.delete(HIGHLIGHT);
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet);
    };
  }
  const sel = doc.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return () => {};
}

export function useSuggestionReview(o: {
  mode: FrameMode;
  doc: Document | null;
  epoch: number;
  /** A review pass is open. */
  active: boolean;
  /** Pending suggestions, in the order they are reviewed. */
  pending: Annotation[];
  currentId: string | null;
  /**
   * The editing session is bound. Until it is, nothing is judged or marked:
   * binding to a shared document that already has content REPLACES the body,
   * and a mark made just before sits in nodes that are gone — its range
   * collapses to an empty point, and the first target shows nothing at all.
   */
  ready: boolean;
  reduceMotion?: boolean;
}): { stale: Set<string> } {
  const { mode, doc, epoch, active, pending, currentId, ready, reduceMotion = false } = o;
  // Judged whenever the editor is bound, for the comments panel as well as the
  // pass; marked only during the pass.
  const judging = ready && mode.kind === "editing" && Boolean(doc?.body);
  const on = active && judging;
  const [stale, setStale] = useState<Set<string>>(new Set());
  // The draft changes under the pass: this approver's own typing, a
  // co-editor's patch through the shared document, an Accept. Any of them may
  // change a verdict. Observed, never written: this hook still puts nothing
  // in the document.
  const [edits, setEdits] = useState(0);
  useEffect(() => {
    if (!judging || !doc?.body) return;
    // The frame's own constructor: a cross-realm observer observes nothing (see sync.ts).
    const MO = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (!MO) return;
    const observer = new MO(() => setEdits((n) => n + 1));
    observer.observe(doc.body, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [judging, doc, epoch]);

  // Judged against the DRAFT, the text an Accept would actually change. State
  // changes only when the answer does: a caller handing a fresh array every
  // render must not make this re-render forever.
  useEffect(() => {
    const next = judging && doc ? staleIn(doc, pending) : new Set<string>();
    setStale((prev) => (sameSet(prev, next) ? prev : next));
  }, [judging, doc, epoch, pending, edits]);

  // Keyed on WHICH target, not on the array it arrived in, so that a presence
  // heartbeat or a peer's comment re-rendering the viewer does not scroll the
  // approver back to it while they read around it.
  const current = currentId ? pending.find((a) => a.annId === currentId) : undefined;
  const key = targetKey(current);
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    const target = currentRef.current;
    if (!on || !doc || !target) return;
    const range = exactRangeFromAnchor(doc, target.anchor);
    if (!range) return;
    return markTarget(doc, range, reduceMotion);
  }, [on, doc, epoch, key, reduceMotion]);

  return { stale };
}

export type AcceptOutcome = ApplyResult | "unsaved";

/**
 * Accept one suggestion, in the only order that survives every interruption:
 *
 *   0. check   that there is something to apply, before keeping anyone off it;
 *   1. claim   other approvers are kept off it, so it is applied once;
 *   2. apply   the edit, in this session, reaching every peer;
 *   3. save    the draft, durably, before anything says it happened;
 *   4. record  the decision.
 *
 * Interrupted after 1, the claim lapses. After 2 or 3, the change is in the
 * draft (or the live log) and the suggestion still pending; accepting again
 * finds it already applied and only records it. Recording first would be the
 * one order with a lie in it: "accepted", over a draft that never got the text.
 */
export async function acceptInSession(steps: {
  check: () => Resolution["state"];
  claim: () => Promise<unknown>;
  apply: () => ApplyResult;
  flush: () => Promise<void>;
  saveFailed: () => boolean;
  record: () => Promise<unknown>;
}): Promise<AcceptOutcome> {
  if (steps.check() === "stale") return "stale";
  await steps.claim();
  const applied = steps.apply();
  if (applied === "stale" || applied === "failed" || applied === "unverified") return applied;
  await steps.flush();
  if (steps.saveFailed()) return "unsaved";
  await steps.record();
  return applied;
}
