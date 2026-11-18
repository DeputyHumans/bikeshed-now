// SPDX-License-Identifier: Apache-2.0
// One upload's progress, and stopping it, for the dialogs that send one (SPEC §2).

import { useCallback, useEffect, useRef, useState } from "react";
import { UploadStopped, type SendControl } from "../upload";

export type UploadPhase =
  | { kind: "idle" }
  /** Bytes are on their way; closing the dialog stops them. */
  | { kind: "sending"; fraction: number }
  /** Every byte has arrived; the deployment is publishing, and finishes whatever happens here. */
  | { kind: "publishing" };

/**
 * Runs one upload at a time. While it is sending, `stop()` aborts it and
 * nothing is published, and leaving the page asks first; once every byte has
 * arrived it cannot be taken back, and the dialog says so. A result that
 * arrives after the dialog closed is dropped, never acted on.
 */
export function useUploadRun() {
  const [phase, setPhase] = useState<UploadPhase>({ kind: "idle" });
  const controller = useRef<AbortController | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (phase.kind !== "sending") return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase.kind]);

  /**
   * Start `send` with a control it passes on to the upload. Resolves with its
   * result, or with null when it was stopped or the dialog has gone; throws
   * the refusal otherwise.
   */
  const run = useCallback(async <T,>(send: (control: SendControl) => Promise<T>): Promise<T | null> => {
    const abort = new AbortController();
    controller.current = abort;
    setPhase({ kind: "sending", fraction: 0 });
    try {
      const result = await send({
        signal: abort.signal,
        onProgress: (fraction) => { if (live.current && !abort.signal.aborted) setPhase({ kind: "sending", fraction }); },
        onSent: () => { if (live.current) setPhase({ kind: "publishing" }); },
      });
      return live.current && !abort.signal.aborted ? result : null;
    } catch (e) {
      if (e instanceof UploadStopped || !live.current) return null;
      throw e;
    } finally {
      if (controller.current === abort) controller.current = null;
      if (live.current) setPhase({ kind: "idle" });
    }
  }, []);

  /** Stop the upload while it is still sending. */
  const stop = useCallback(() => controller.current?.abort(), []);

  return { phase, run, stop, busy: phase.kind !== "idle" };
}
