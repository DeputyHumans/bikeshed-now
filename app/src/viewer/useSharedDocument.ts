// SPDX-License-Identifier: Apache-2.0
// Joining the editing host to the document everyone else is typing into (SPEC §6b).

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { connect, type Connection } from "../crdt/log";
import { rtdbLog } from "../crdt/rtdb";
import { seedFragment } from "../crdt/binding";
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
 *   1. Replay the existing log, then atomically elect a single seed if empty.
 *      Waiting alone cannot distinguish simultaneous first joiners.
 *   2. Bind the host to that elected shared document, including earlier edits.
 *   3. Report ready, so input cannot be overwritten by the initial adoption.
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
  // Whether the host is bound yet. "off" alone cannot say: it is also what
  // editing alone, bound, reports. Applying an edit before the bind is lost —
  // a non-empty shared document replaces the host's children when it binds.
  const [bound, setBound] = useState(false);
  const sync = useRef<Sync | null>(null);
  const connected = useRef<Connection | null>(null);

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
      let shared = false;
      try {
        if (log) {
          connection = connect(ydoc, log, () => bound?.flush());
          connected.current = connection;
          await log.ready();
          if (cancelled || !doc.body) return;
          if (ydoc.getXmlFragment("body").length === 0) {
            const proposal = new Y.Doc();
            try {
              seedFragment(proposal.getXmlFragment("body"), doc.body);
              await connection.initialize(Y.encodeStateAsUpdate(proposal));
            } finally { proposal.destroy(); }
          }
          shared = true;
        }
      } catch {
        // A refused or unavailable transport must not claim collaboration.
        // Disconnect before the local fallback, which must not publish updates.
        connection?.destroy();
        connection = null;
        connected.current = null;
      }
      if (cancelled || !doc.body) return;
      bound = bindSync(ydoc.getXmlFragment("body"), doc.body);
      sync.current = bound;
      setBound(true);
      setState(shared ? "shared" : "off");
    })();

    return () => {
      cancelled = true;
      // Unbind BEFORE destroying the doc: the binding holds observers on it,
      // and tearing the doc out from under them throws inside a cleanup, where
      // React swallows it and the next mount inherits a half-attached observer.
      bound?.destroy();
      sync.current = null;
      connection?.destroy();
      connected.current = null;
      ydoc.destroy();
      setState("off");
      setBound(false);
    };
    // `epoch` is here because a frame reload replaces the whole document, and
    // the binding is attached to a body that no longer exists after one.
  }, [editing, doc, epoch, docId, enabled]);

  return { state, bound, snapshot: () => { sync.current?.flush(); return connected.current?.snapshot() ?? {}; } };
}
