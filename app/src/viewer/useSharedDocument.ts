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
  liveEpoch?: string;
  onRemote?: () => void;
  expectedGeneration?: string;
}) {
  const { mode, doc, epoch, docId, enabled, liveEpoch = "initial", onRemote, expectedGeneration } = options;
  const editing = mode.kind === "editing";
  const [state, setState] = useState<ShareState>("off");
  // Whether the host is bound yet. "off" alone cannot say: it is also what
  // editing alone, bound, reports. Applying an edit before the bind is lost —
  // a non-empty shared document replaces the host's children when it binds.
  const [error, setError] = useState<string | null>(null);
  const [bound, setBound] = useState(false);
  const sync = useRef<Sync | null>(null);
  const connected = useRef<Connection | null>(null);
  const remote = useRef(onRemote);
  remote.current = onRemote;

  useEffect(() => {
    if (!editing || !doc?.body || !enabled) {
      setState("off");
      setError(null);
      return;
    }

    let cancelled = false;
    let connection: Connection | null = null;
    let bound: Sync | null = null;
    const ydoc = new Y.Doc();
    setState("joining");
    setError(null);

    void (async () => {
      const log = rtdbLog(docId, liveEpoch);
      let shared = false;
      try {
        if (log) {
          connection = connect(ydoc, log, () => bound?.flush(), (available) => {
            if (cancelled) return;
            setState(available ? "shared" : "off");
            setError(available ? null : "Live sharing is interrupted. Keep this tab open while your changes are retried.");
          });
          connected.current = connection;
          await log.ready();
          if (cancelled || !doc.body) return;
          if (ydoc.getXmlFragment("body").length === 0) {
            const proposal = new Y.Doc();
            try {
              seedFragment(proposal.getXmlFragment("body"), doc.body);
              await connection.initialize(Y.encodeStateAsUpdate(proposal));
            } finally { proposal.destroy(); }
          } else {
            // Existing logs need the same elected seed hash before save stamps
            // become synchronously available to the editor.
            await connection.initialize();
          }
          if (expectedGeneration && connection.causalStamp().generation !== expectedGeneration) {
            throw new Error("The shared document seed no longer matches the saved editing history");
          }
          shared = true;
        }
      } catch (cause) {
        if (cancelled) return;
        // Configured live state is authoritative. A read/seed failure cannot
        // become a solo autosave over a newer shared draft.
        setError(cause instanceof Error && cause.message.includes("legacy")
          ? "An older editing session must be saved first. Save or publish from its original tab, then reload this page."
          : "Live editing could not start. Reload to retry. Keep other editing tabs open until their changes are saved.");
        setState("off");
        setBound(false);
        connection?.destroy();
        connection = null;
        connected.current = null;
        return;
      }
      if (cancelled || !doc.body) return;
      bound = bindSync(ydoc.getXmlFragment("body"), doc.body, () => remote.current?.());
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
  }, [editing, doc, epoch, docId, enabled, liveEpoch]);

  return {
    state, bound, error,
    snapshot: () => { sync.current?.flush(); return connected.current?.snapshot() ?? {}; },
    causalStamp: () => { sync.current?.flush(); return bound ? connected.current?.causalStamp() ?? null : null; },
  };
}
