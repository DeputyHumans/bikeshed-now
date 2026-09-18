// SPDX-License-Identifier: Apache-2.0
// Joining the editing host to the document everyone else is typing into (SPEC §6b).

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { connect, type Connection } from "../crdt/log";
import { rtdbLog } from "../crdt/rtdb";
import { bindSync, type Sync } from "../crdt/sync";
import type { FrameMode } from "./frameMode";

/**
 * DECLARATION ORDER MATTERS, and this hook is the reason the note at the top of
 * DocViewer exists.
 *
 * It must be declared AFTER `useAnnotationLayer` and BEFORE `useInlineEditor`.
 * Effect cleanups run in declaration order, so the annotation layer strips its
 * highlights before this one seeds — and anything still in the DOM at seed time
 * does not merely contaminate one save, it is replicated into every peer's copy
 * of the document, where it is indistinguishable from the author's own markup.
 * The binding refuses decoration at the boundary as well; this is the ordering
 * that means it never has to.
 *
 * Joining is three steps and the order of those matters too:
 *
 *   1. Connect to the log and WAIT for what is already in it. Skipping the wait
 *      is the seeding race: two people opening the editor in the same second
 *      both find an empty document and both publish the bytes they loaded, and
 *      everyone sees the document twice.
 *   2. Bind the host. Empty shared document means we are first and the authored
 *      DOM becomes the shared one, in place, with no re-render and no moved
 *      caret. Non-empty means somebody is ahead of us and their document wins
 *      over the bytes we loaded, because theirs includes edits ours does not.
 *   3. Report ready, so the editor knows typing will be shared rather than lost.
 */
export type ShareState = "off" | "joining" | "shared";

export function useSharedDocument(options: {
  mode: FrameMode;
  doc: Document | null;
  epoch: number;
  docId: string;
  enabled: boolean;
}) {
  const { mode, doc, epoch, docId, enabled } = options;
  const editing = mode.kind === "editing";
  const [state, setState] = useState<ShareState>("off");
  const sync = useRef<Sync | null>(null);

  useEffect(() => {
    if (!editing || !doc?.body || !enabled) {
      setState("off");
      return;
    }

    let cancelled = false;
    let connection: Connection | null = null;
    let bound: Sync | null = null;
    const ydoc = new Y.Doc();
    setState("joining");

    void (async () => {
      const log = rtdbLog(docId);
      if (log) {
        connection = connect(ydoc, log);
        await log.ready();
      }
      if (cancelled || !doc.body) return;
      bound = bindSync(ydoc.getXmlFragment("body"), doc.body);
      sync.current = bound;
      // Without a Realtime Database there are no peers to share with, and
      // editing alone is the documented fallback rather than a failure.
      setState(log ? "shared" : "off");
    })();

    return () => {
      cancelled = true;
      // Unbind BEFORE destroying the doc: the binding holds observers on it,
      // and tearing the doc out from under them throws inside a cleanup, where
      // React swallows it and the next mount inherits a half-attached observer.
      bound?.destroy();
      sync.current = null;
      connection?.destroy();
      ydoc.destroy();
      setState("off");
    };
    // `epoch` is here because a frame reload replaces the whole document, and
    // the binding is attached to a body that no longer exists after one.
  }, [editing, doc, epoch, docId, enabled]);

  return { state };
}
