// SPDX-License-Identifier: Apache-2.0
// contentEditable, autosave, and the unconditional strip on entry (SPEC §6a).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  assertNoDecoration,
  clearHighlights,
  removeHighlightStyles,
  serializeCleanHtml,
  restoreEditingBodyAttributes,
  type EditingBodyAttributes,
} from "../annotation/highlighter";
import {
  clearGeneratedContainers,
  markGeneratedContainers,
} from "../wysiwyg/placeholders";
import { rewriteLegacyFontTags } from "../wysiwyg/EditToolbar";
import { StaleVersionError, saveDraft } from "../edit";
import type { FrameMode } from "./frameMode";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const AUTOSAVE_MS = 1000;

/**
 * LEG 3 of the four: the UNCONDITIONAL strip on editor entry, plus an assertion.
 *
 * This is the leg that covers the case the other two miss. The iframe does NOT
 * always remount when edit mode starts: for a document that was already
 * sandboxed, the src and the sandbox attribute are both unchanged, so React
 * reuses the element and the editor attaches to the EXACT Document the
 * annotation layer just decorated.
 *
 * So this hook strips first, always, whether or not it believes anything is
 * there — and then asserts, in development, that nothing survived. That turns
 * the invariant from a comment into a crash while somebody is writing the code
 * rather than a corrupted document six months later.
 */
export function useInlineEditor(options: {
  mode: FrameMode;
  doc: Document | null;
  epoch: number;
  docId: string;
  authoredAssets: React.MutableRefObject<Map<string, number> | null>;
  onStale: (currentVersion?: string) => void;
}) {
  const { mode, doc, epoch, docId, authoredAssets, onStale } = options;
  // There is no longer a state in which somebody may open the editor and not
  // type in it: edits merge (SPEC §6b), so the mode is the whole condition.
  const editing = mode.kind === "editing";

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * A commit is REFUSED when the last draft save failed. Publishing anyway
   * would promote the PREVIOUS draft bytes as a new version while reporting
   * success — the worst outcome available, because it looks like it worked.
   */
  const lastSaveFailed = useRef(false);
  /**
   * An edit this browser made that no save has taken yet. Leaving the editor
   * saves only when this is set: a save with nothing in it still creates a
   * draft, and a draft is what every editor then reads instead of the
   * published version — so merely opening the editor and closing it again
   * used to put a document into that state with nothing changed.
   */
  const unsaved = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyAttributes = useRef<EditingBodyAttributes | undefined>(undefined);

  /**
   * `onStale` is held in a ref so it cannot destabilise `flush`.
   *
   * DocViewer passes an inline arrow, so it has a new identity on every render.
   * As a dependency it rebuilt `flush`, which rebuilt the setup effect below,
   * whose CLEANUP removes `contenteditable` — and in edit mode this component
   * re-renders constantly (presence, the lock, save state). The editing host
   * was therefore being torn down and recreated faster than anybody could
   * type: keydown fired, the browser never got to perform the insertion, and
   * `beforeinput` never fired at all. Typing silently did nothing.
   *
   * This is the SECOND time this exact shape has bitten here — `onSelect` did
   * it to useAnnotationLayer — so the rule is worth stating: in these hooks, a
   * callback prop is held in a ref and never becomes a dependency.
   */
  const onStaleRef = useRef(onStale);
  onStaleRef.current = onStale;

  /** Save the draft; true when it is saved. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (!doc || mode.kind !== "editing") return false;
    setSaveState("saving");
    // Cleared before the save rather than after it: an edit typed while this
    // save is in flight is not in these bytes, and must still count as unsaved.
    unsaved.current = false;
    try {
      const html = serializeCleanHtml(doc, {
        authoredAssets: authoredAssets.current ?? undefined,
        authoredBodyAttributes: bodyAttributes.current,
      });
      await saveDraft(docId, mode.baseVersion, html);
      lastSaveFailed.current = false;
      setSaveState("saved");
      setSaveError(null);
      return true;
    } catch (e) {
      unsaved.current = true;
      lastSaveFailed.current = true;
      setSaveState("error");
      if (e instanceof StaleVersionError) {
        onStaleRef.current(e.currentVersion);
        setSaveError(e.message);
      } else {
        setSaveError((e as Error).message);
      }
      return false;
    }
  }, [doc, mode, docId, authoredAssets]);

  /** Held in a ref for the same reason, so the effect can close over it safely. */
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    if (!editing || !doc) return;

    // Strip FIRST, unconditionally, before contentEditable is set. Anything
    // still here would be serialized into the next version.
    clearHighlights(doc);
    removeHighlightStyles(doc);
    assertNoDecoration(doc, "edit mode");

    const body = doc.body;
    if (!body) return;
    // Retain both absence and authored values outside the DOM: the editor's
    // temporary overrides must not become content or erase author intent.
    const authored: EditingBodyAttributes = {
      contenteditable: body.getAttribute("contenteditable"),
      spellcheck: body.getAttribute("spellcheck"),
    };
    bodyAttributes.current = authored;
    body.setAttribute("contenteditable", "true");
    body.setAttribute("spellcheck", "true");
    markGeneratedContainers(doc);
    // A shared-document join can adopt the body after this effect ran. Keep
    // local hints in step with those children; attribute-only decoration never
    // triggers this observer or enters the CRDT's wire representation.
    const MO = doc.defaultView?.MutationObserver ?? MutationObserver;
    const placeholders = new MO(() => markGeneratedContainers(doc));
    placeholders.observe(body, { subtree: true, childList: true, characterData: true });

    const onInput = () => {
      // execCommand still emits <font size> in every engine. Normalizing on
      // input rather than on save keeps what the author sees and what gets
      // stored the same thing.
      rewriteLegacyFontTags(doc);
      unsaved.current = true;
      setSaveState("dirty");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flushRef.current(), AUTOSAVE_MS);
    };
    doc.addEventListener("input", onInput);

    return () => {
      doc.removeEventListener("input", onInput);
      if (timer.current) clearTimeout(timer.current);
      placeholders.disconnect();
      clearGeneratedContainers(doc);
      restoreEditingBodyAttributes(body, authored);
      bodyAttributes.current = undefined;
    };
    // NOT `flush`. Depending on it would reintroduce exactly the tear-down
    // described above the ref declaration, one indirection further away.
  }, [editing, doc, epoch]);

  return {
    saveState,
    saveError,
    /**
     * Save now, changed or not: before a commit, which publishes the draft's
     * bytes. Resolves false when the save failed, which a commit must heed:
     * it would otherwise publish the PREVIOUS draft and call it done.
     */
    flushNow: flush,
    /** Save only an edit not yet saved: leaving the editor, which publishes nothing. */
    flushUnsaved: useCallback(async () => {
      if (unsaved.current) await flush();
    }, [flush]),
    /** True when the last save failed: a commit must not proceed. */
    saveFailed: () => lastSaveFailed.current,
  };
}
