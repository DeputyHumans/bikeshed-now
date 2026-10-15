// SPDX-License-Identifier: Apache-2.0
// Sole owner of the document iframe (SPEC §6a, §6c).

import { useCallback, useEffect, useRef, useState } from "react";
import { observeFrameFocus } from "./frameFocus";
import { captureAssetTags } from "../annotation/highlighter";
import { describeAnchorFromSelection, rangeFromAnchor } from "../annotation/anchor";
import type { Anchor } from "../types";
import {
  frameKey,
  frameSandbox,
  frameSrc,
  type FrameMode,
} from "./frameMode";

/**
 * Everything about the iframe lives HERE: the ref, the epoch, the scroll
 * restoration, the authored-asset inventory, and the src/key/sandbox/onLoad it
 * is rendered with.
 *
 * The design this replaces spread those across seventeen effects sharing twelve
 * mutable refs, three of which were written by one subsystem and read by
 * another. Giving the frame a single owner is what lets every other hook be a
 * pure consumer of "here is the document, and here is when it changed".
 *
 * `epoch` is the coordination primitive. It increments on every load, and every
 * dependent effect keys off it rather than off the ref — because a ref does not
 * trigger a re-render, so an effect that depended on `iframeRef.current` alone
 * would run against the PREVIOUS document.
 */

export interface DocFrame {
  ref: React.RefObject<HTMLIFrameElement>;
  /** The loaded document, or null before first load. */
  doc: Document | null;
  /** Increments on every load. Depend on this, never on the ref. */
  epoch: number;
  /**
   * True from the moment the frame is given a document to load until that
   * document's `load` fires: on first open, and again on every remount or
   * navigation. Not `doc === null`, which some remounts leave pointing at the
   * previous, detached document.
   */
  loading: boolean;
  /**
   * Props to spread onto the <iframe>, or null while it is held: render no
   * iframe at all then. One rendered without a src still loads about:blank and
   * fires `load`, and every consumer would decorate that document instead.
   */
  frameProps: {
    key: string;
    src: string;
    sandbox?: string;
    onLoad: () => void;
  } | null;
  /** Force a reload, even when the URL is unchanged. */
  reload: () => void;
  /** Remember the scroll position, so a reload does not lose the reader's place. */
  captureScroll: () => void;
  /** The author's asset inventory, taken before any injection. */
  authoredAssets: React.MutableRefObject<Map<string, number> | null>;
}

export function useDocFrame(options: {
  mode: FrameMode;
  docId: string;
  entry: string;
  trustToken: string;
  linkToken?: string;
  /**
   * Withhold the document until the sandbox decision is final (SPEC §6c).
   * Honoured only before the first load: once a reader has a document, taking
   * it away to wait would lose their place and their selection.
   */
  hold?: boolean;
}): DocFrame {
  const { mode, docId, entry, trustToken, linkToken, hold = false } = options;

  const ref = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);

  const key = frameKey(mode, trustToken, reloadToken);
  const src = frameSrc(mode, docId, entry, reloadToken, linkToken);

  /**
   * Which document has finished loading, named by everything that makes the
   * frame load a new one: its key (a remount) and its src (a navigation).
   * Loading is then derived — the frame is loading whenever what it shows is
   * not what it was last told to load — so no transition can forget to set it.
   */
  const identity = `${key} ${src}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const loadedIdentityRef = useRef<string | null>(null);

  /** Keep the last visible reading state until a replacement has restored it. */
  const restore = useRef<{ docId: string; scrollY: number; selection: Anchor | null } | null>(null);

  /**
   * The author's own asset tags, captured in onLoad BEFORE anything is injected.
   *
   * The serializer uses it to drop everything that appeared afterwards — our
   * injections, and nodes a browser extension added to the same-origin frame,
   * which would otherwise be published into the next version. Captured here
   * because this is the only place that knows when a document is freshly loaded
   * and still untouched.
   */
  const authoredAssets = useRef<Map<string, number> | null>(null);

  const captureScroll = useCallback(() => {
    // A second save can replace a frame that is still loading (or waiting for
    // layout). Its blank position must not overwrite the reader's checkpoint.
    if (restore.current || loadedIdentityRef.current !== identityRef.current) return;
    const view = ref.current?.contentWindow;
    const frameDoc = ref.current?.contentDocument;
    if (view && frameDoc) restore.current = { docId, scrollY: view.scrollY, selection: describeAnchorFromSelection(frameDoc) };
  }, [docId]);

  const reload = useCallback(() => {
    captureScroll();
    setReloadToken((n) => n + 1);
  }, [captureScroll]);

  const onLoad = useCallback(() => {
    if (identityRef.current !== identity) return;
    // Before anything that can return early: a load that yields no readable
    // document is still the end of the wait, and must not leave it showing.
    loadedIdentityRef.current = identity;
    setLoadedIdentity(identity);

    const frameDoc = ref.current?.contentDocument ?? null;
    if (!frameDoc) return;

    // ORDER IS LOAD-BEARING. The inventory is captured before the epoch bumps,
    // because bumping the epoch is what wakes every injecting effect — and an
    // inventory taken after they run would include our own nodes and therefore
    // treat them as authored.
    authoredAssets.current = captureAssetTags(frameDoc);

    if (restore.current?.docId !== docId) restore.current = null;
    const checkpoint = restore.current;
    if (checkpoint) {
      // After layout, or the document is not yet tall enough to scroll to it.
      frameDoc.defaultView?.requestAnimationFrame(() => {
        if (identityRef.current !== identity || ref.current?.contentDocument !== frameDoc) return;
        if (checkpoint.selection) {
          const range = rangeFromAnchor(frameDoc, checkpoint.selection);
          // A positional fallback may name different words after an edit.
          // Restore only the same passage; never silently select its neighbour.
          if (range?.toString() === checkpoint.selection.exact) {
            const selection = frameDoc.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
        }
        frameDoc.defaultView?.scrollTo({ top: checkpoint.scrollY, behavior: "auto" });
        if (restore.current === checkpoint) restore.current = null;
        frameDoc.dispatchEvent(new Event("selectionchange"));
      });
    }

    setDoc(frameDoc);
    setEpoch((n) => n + 1);
  }, [identity, docId]);

  // A mode change means a different document. Dropping the stale reference
  // immediately keeps a consumer from decorating a document that is unloading.
  useEffect(() => {
    setDoc(null);
    authoredAssets.current = null;
  }, [mode.kind, mode.kind === "editing" ? mode.baseVersion : mode.versionId, reloadToken]);

  const held = hold && loadedIdentity === null;

  useEffect(() => {
    if (ref.current) return observeFrameFocus(ref.current);
  }, [identity, epoch, held]);

  return {
    ref,
    doc,
    epoch,
    loading: loadedIdentity !== identity,
    frameProps: held
      ? null
      : {
          key,
          src,
          sandbox: frameSandbox(mode),
          onLoad,
        },
    reload,
    captureScroll,
    authoredAssets,
  };
}
