// SPDX-License-Identifier: Apache-2.0
// Sole owner of the document iframe (SPEC §6a, §6c).

import { useCallback, useEffect, useRef, useState } from "react";
import { captureAssetTags } from "../annotation/highlighter";
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
  /** Props to spread onto the <iframe>. */
  frameProps: {
    key: string;
    src: string;
    sandbox?: string;
    onLoad: () => void;
  };
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
}): DocFrame {
  const { mode, docId, entry, trustToken, linkToken } = options;

  const ref = useRef<HTMLIFrameElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);

  /** Scroll position to restore after the next load, if any. */
  const restoreScroll = useRef<number | null>(null);

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
    const view = ref.current?.contentWindow;
    if (view) restoreScroll.current = view.scrollY;
  }, []);

  const reload = useCallback(() => {
    captureScroll();
    setReloadToken((n) => n + 1);
  }, [captureScroll]);

  const onLoad = useCallback(() => {
    const frameDoc = ref.current?.contentDocument ?? null;
    if (!frameDoc) return;

    // ORDER IS LOAD-BEARING. The inventory is captured before the epoch bumps,
    // because bumping the epoch is what wakes every injecting effect — and an
    // inventory taken after they run would include our own nodes and therefore
    // treat them as authored.
    authoredAssets.current = captureAssetTags(frameDoc);

    if (restoreScroll.current != null) {
      const target = restoreScroll.current;
      restoreScroll.current = null;
      // After layout, or the document is not yet tall enough to scroll to it.
      frameDoc.defaultView?.requestAnimationFrame(() => {
        frameDoc.defaultView?.scrollTo({ top: target, behavior: "auto" });
      });
    }

    setDoc(frameDoc);
    setEpoch((n) => n + 1);
  }, []);

  // A mode change means a different document. Dropping the stale reference
  // immediately keeps a consumer from decorating a document that is unloading.
  useEffect(() => {
    setDoc(null);
    authoredAssets.current = null;
  }, [mode.kind, mode.kind === "editing" ? mode.baseVersion : mode.versionId, reloadToken]);

  return {
    ref,
    doc,
    epoch,
    frameProps: {
      key: frameKey(mode, trustToken, reloadToken),
      src: frameSrc(mode, docId, entry, reloadToken, linkToken),
      sandbox: frameSandbox(mode),
      onLoad,
    },
    reload,
    captureScroll,
    authoredAssets,
  };
}
