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
import { ConflictError } from "../api";
import type { CausalStamp } from "../crdt/causal";
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
  ready?: boolean;
  causalStamp?: () => CausalStamp | null;
  authoredAssets: React.MutableRefObject<Map<string, number> | null>;
  onStale: (currentVersion?: string) => void;
}) {
  const { mode, doc, epoch, docId, authoredAssets, onStale, ready = true } = options;
  // There is no longer a state in which somebody may open the editor and not
  // type in it: edits merge (SPEC §6b), so the mode is the whole condition.
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const causalStampRef = useRef(options.causalStamp);
  causalStampRef.current = options.causalStamp;
  const changedRef = useRef<(() => void) | null>(null);
  const editing = mode.kind === "editing";
  const baseVersion = mode.kind === "editing" ? mode.baseVersion : null;

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);
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
  const session = useRef(0);
  const writeSession = useRef<{ liveEpoch: string; draftRevision?: string }>({ liveEpoch: "initial" });
  const inFlight = useRef<{ session: number; promise: Promise<boolean> } | null>(null);

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

  /** Save in order and wait until this session's latest edit is durable. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (!doc || mode.kind !== "editing" || !readyRef.current) return false;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const currentSession = session.current;
    if (inFlight.current?.session === currentSession) return inFlight.current.promise;
    const flight = { session: currentSession, promise: Promise.resolve(false) };
    const run = async (): Promise<boolean> => {
      do {
        if (session.current !== currentSession) return false;
        // An input may arm the debounce while the previous snapshot is saving.
        // This ordered drain owns that edit now; the timer must not save it again.
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        setSaveState("saving");
        unsaved.current = false;
        try {
          // Flush queued DOM mutations before taking both history and HTML in
          // the same synchronous turn: the stamp must describe these bytes.
          const causal = causalStampRef.current?.() ?? undefined;
          const html = serializeCleanHtml(doc, {
            authoredAssets: authoredAssets.current ?? undefined,
            authoredBodyAttributes: bodyAttributes.current,
          });
          const saved = await saveDraft(docId, mode.baseVersion, html, { ...writeSession.current, ...(causal ? { causal } : {}) });
          if (session.current !== currentSession) return false;
          if (saved.draftRevision) writeSession.current.draftRevision = saved.draftRevision;
          if (saved.liveEpoch) writeSession.current.liveEpoch = saved.liveEpoch;
          lastSaveFailed.current = false;
          setSaveError(null);
          setReloadRequired(false);
        } catch (e) {
          if (session.current !== currentSession) return false;
          unsaved.current = true;
          lastSaveFailed.current = true;
          setSaveState("error");
          if (e instanceof StaleVersionError) onStaleRef.current(e.currentVersion);
          setSaveError((e as Error).message);
          setReloadRequired(e instanceof StaleVersionError || (e instanceof ConflictError && (e.detail.reloadRequired === true || e.detail.liveReset === true)));
          return false;
        }
      } while (unsaved.current);
      setSaveState("saved");
      return true;
    };
    // Every caller (autosave, Done, publish) joins one ordered save. A later
    // snapshot cannot arrive before an older request and then be overwritten.
    flight.promise = run().finally(() => {
      if (inFlight.current === flight) inFlight.current = null;
    });
    inFlight.current = flight;
    return flight.promise;
  }, [doc, mode, docId, authoredAssets]);

  /** Held in a ref for the same reason, so the effect can close over it safely. */
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    if (!editing || !doc) return;
    session.current += 1;
    writeSession.current = mode.kind === "editing" ? { liveEpoch: mode.liveEpoch ?? "initial", ...(mode.draftRevision ? { draftRevision: mode.draftRevision } : {}) } : { liveEpoch: "initial" };
    unsaved.current = false;
    lastSaveFailed.current = false;
    setSaveState("idle");
    setSaveError(null);
    setReloadRequired(false);

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
    body.setAttribute("contenteditable", readyRef.current ? "true" : "false");
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
    // Descendants may carry their own authored contenteditable=true. A body
    // override alone cannot prevent their input while the shared host joins.
    const beforeInput = (event: Event) => { if (!readyRef.current) event.preventDefault(); };
    doc.addEventListener("beforeinput", beforeInput, true);
    doc.addEventListener("input", onInput);
    changedRef.current = onInput;

    return () => {
      session.current += 1;
      doc.removeEventListener("input", onInput);
      changedRef.current = null;
      doc.removeEventListener("beforeinput", beforeInput, true);
      if (timer.current) clearTimeout(timer.current);
      placeholders.disconnect();
      clearGeneratedContainers(doc);
      restoreEditingBodyAttributes(body, authored);
      bodyAttributes.current = undefined;
    };
    // NOT `flush`. Depending on it would reintroduce exactly the tear-down
    // described above the ref declaration, one indirection further away.
  }, [editing, doc, epoch, baseVersion]);

  useEffect(() => {
    if (editing && doc?.body) doc.body.setAttribute("contenteditable", ready ? "true" : "false");
  }, [editing, doc, epoch, ready]);

  return {
    saveState,
    saveError,
    reloadRequired,
    markChanged: useCallback(() => changedRef.current?.(), []),
    /**
     * Save now, changed or not: before a commit, which publishes the draft's
     * bytes. Resolves false when the save failed, which a commit must heed:
     * it would otherwise publish the PREVIOUS draft and call it done.
     */
    flushNow: flush,
    /** Save only an edit not yet saved: leaving the editor, which publishes nothing. */
    flushUnsaved: useCallback(async () => {
      if (unsaved.current || inFlight.current?.session === session.current) return flush();
      return true;
    }, [flush]),
    /** True when the last save failed: a commit must not proceed. */
    saveFailed: () => lastSaveFailed.current,
  };
}
