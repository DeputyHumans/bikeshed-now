// SPDX-License-Identifier: Apache-2.0
// Peers, the overlay, and follow mode (SPEC §16).

import { useCallback, useEffect, useRef, useState } from "react";
import { describeFocusFromSelection } from "../annotation/anchor";
import { refusesListeners, watchResize, watchScroll, watchSelection } from "./frameWatch";
import {
  createPeerOverlay,
  scrollFraction,
  scrollToFraction,
  type PeerOverlay,
} from "../annotation/peers";
import {
  joinPresence,
  watchPeers,
  type Peer,
  type PresenceHandle,
  type PresenceMode,
} from "../presence";

/** Ephemeral awareness is separate from the document state shared by the CRDT. */
export function usePeerPresence(options: {
  docId: string;
  uid: string | null;
  emailLower: string;
  displayName: string;
  doc: Document | null;
  epoch: number;
  mode: PresenceMode;
  enabled: boolean;
  liveEpoch?: string;
}) {
  const { docId, uid, emailLower, displayName, doc, epoch, mode, enabled, liveEpoch = "initial" } = options;

  const [peers, setPeers] = useState<Peer[]>([]);
  const [following, setFollowing] = useState<string | null>(null);
  const handle = useRef<PresenceHandle | null>(null);
  const overlay = useRef<PeerOverlay | null>(null);

  useEffect(() => {
    if (!enabled || !uid) return;
    handle.current = joinPresence(docId, uid, emailLower, displayName, mode, liveEpoch);
    return () => {
      handle.current?.leave();
      handle.current = null;
    };
  }, [enabled, docId, uid, emailLower, displayName, liveEpoch]);

  useEffect(() => {
    handle.current?.setMode(mode);
  }, [mode]);

  useEffect(() => {
    if (!enabled || !uid) return;
    return watchPeers(docId, uid, setPeers);
  }, [enabled, docId, uid]);

  /**
   * The overlay lives inside the document, so it is recreated on every load —
   * and it does NOT exist while this reader is editing.
   *
   * That second half is leg 1 of the decoration invariant applied to presence,
   * and it was missing. `mode` was not a dependency, so on the no-remount path
   * into edit mode — an editor already viewing the draft clicks Edit, the
   * iframe `src` is unchanged, `doc` and `epoch` are unchanged — the peer layer
   * stayed in the document the editor then attached to. In development the
   * assertion caught it; in production `serializeCleanHtml` would have been the
   * only thing between a peer caret and the next published version.
   *
   * An OBSERVER is not editing: their frame mode is "reading", so they keep
   * every peer cursor, which is the whole point of observe mode.
   */
  useEffect(() => {
    if (!enabled || !doc || mode === "edit") return;
    overlay.current = createPeerOverlay(doc);
    return () => {
      overlay.current?.destroy();
      overlay.current = null;
    };
  }, [enabled, doc, epoch, mode]);

  useEffect(() => {
    overlay.current?.render(peers);
  }, [peers]);

  /** Broadcast where this reader is looking, and reposition the overlay. */
  useEffect(() => {
    if (!enabled || !doc) return;

    const onSelectionChange = () => {
      const anchor = describeFocusFromSelection(doc);
      handle.current?.setFocus(anchor);
    };
    const onScroll = () => {
      handle.current?.setViewport(scrollFraction(doc));
      // Rectangles are in page coordinates, so scrolling does not move them —
      // but a scroll can reveal content whose layout has not been measured yet.
      overlay.current?.reflow();
    };
    const onResize = () => overlay.current?.reflow();

    const stops = [
      watchSelection(doc, onSelectionChange),
      watchScroll(doc, onScroll),
      watchResize(doc, onResize),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [enabled, doc, epoch]);

  /**
   * Follow mode: bind this reader's scroll to a peer's.
   *
   * About thirty lines on data already being broadcast, and it is what makes a
   * live walkthrough work at all. Any manual scroll releases it, because a
   * follow you cannot escape by scrolling is a trap.
   */
  useEffect(() => {
    if (!following || !doc) return;
    const peer = peers.find((p) => p.uid === following);
    if (peer?.viewport != null) scrollToFraction(doc, peer.viewport);
  }, [following, peers, doc]);

  useEffect(() => {
    if (!following || !doc) return;
    const release = (e: Event) => {
      // Only a deliberate gesture releases. A programmatic scroll from the
      // effect above must not cancel the thing that caused it.
      if (e.isTrusted) setFollowing(null);
    };
    // Where no gesture is delivered (viewer/frameWatch.ts), a selection the
    // reader makes is the gesture: following never moves the selection, so a
    // change to it is theirs. A scroll would not do: following scrolls.
    if (refusesListeners(doc)) return watchSelection(doc, () => setFollowing(null));
    doc.defaultView?.addEventListener("wheel", release, { passive: true });
    doc.addEventListener("keydown", release);
    doc.addEventListener("pointerdown", release);
    return () => {
      doc.defaultView?.removeEventListener("wheel", release);
      doc.removeEventListener("keydown", release);
      doc.removeEventListener("pointerdown", release);
    };
  }, [following, doc]);

  const setComposing = useCallback((threadId: string | null) => {
    handle.current?.setComposing(threadId);
  }, []);

  return {
    peers,
    following,
    toggleFollow: (uid: string) => setFollowing((cur) => (cur === uid ? null : uid)),
    setComposing,
  };
}
