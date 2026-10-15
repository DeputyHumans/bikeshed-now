// SPDX-License-Identifier: Apache-2.0
// The update log, carried on the presence database (SPEC §6b, §16).

import { get, onChildAdded, onValue, push, ref, runTransaction, update } from "firebase/database";
import { rtdb } from "../firebase";
import { SEED_KEY, type UpdateLog } from "./log";

/**
 * Shared document state rides the node presence already uses.
 *
 * No WebSocket service, no second backend, and no new security boundary: the
 * rules already gate `status/{docId}`, and `status/{docId}/y` is gated on the
 * `editAccess` mirror rather than `presenceAccess`, so a read-only member
 * cannot push edits into an editor's browser.
 *
 * When a deployment has no Realtime Database this returns null and the editor
 * falls back to editing alone — the same way peer cursors already degrade.
 * Collaboration is optional; editing is not.
 */
export function rtdbLog(docId: string, liveEpoch = "initial"): UpdateLog | null {
  if (!rtdb) return null;
  const logRef = ref(rtdb, `status/${docId}/y/${liveEpoch}`);
  // RTDB delivers child_added for every existing child BEFORE the first value
  // event, so a value event is a reliable "you have seen everything that was
  // already here". That is the only ordering guarantee this needs.
  const ready = new Promise<void>((resolve, reject) => {
    const stop = onValue(
      logRef,
      () => {
        stop();
        resolve();
      },
      (error) => {
        stop();
        reject(error);
      },
    );
  });
  return {
    ready: async () => {
      await ready;
      if (liveEpoch === "initial") {
        const previous = (await get(ref(rtdb!, `status/${docId}/y`))).val();
        if (previous && Object.values(previous).some((value) => typeof value === "string")) {
          throw new Error("A legacy live editing log must be recovered before joining");
        }
      }
    },
    async initialize(payload) {
      // Every simultaneous empty-log join proposes a different Yjs identity.
      // Elect one atomically so all peers adopt the same authored structure.
      const result = await runTransaction(ref(rtdb!, `status/${docId}/y/${liveEpoch}/${SEED_KEY}`),
        (current) => current ?? payload, { applyLocally: false });
      const elected = result.snapshot.val();
      if (typeof elected !== "string") throw new Error("The shared document could not be initialized");
      return elected;
    },
    subscribe(onEntry, onError) {
      // `onChildAdded` replays the children that already exist before it
      // reports new ones, so a late joiner catches up and then keeps up
      // through the same callback. That is the whole sync protocol.
      return onChildAdded(logRef, (snap) => {
        const value = snap.val();
        if (typeof value === "string" && snap.key) onEntry(snap.key, value);
      }, onError);
    },
    async append(payload) {
      const entry = await push(logRef, payload);
      return entry.key;
    },
    async remove(keys) {
      if (keys.length === 0) return;
      // One multi-path update rather than N deletes: compaction removes a whole
      // run at once, and doing it in one round trip keeps the window where the
      // log is half-collapsed as short as possible.
      const patch: Record<string, null> = {};
      for (const key of keys) patch[key] = null;
      await update(logRef, patch);
    },
  };
}

/** Retire only the exact applied log captured before the publish snapshot. */
export async function clearLog(docId: string, consumed: Record<string, string>, liveEpoch: string): Promise<void> {
  if (!rtdb || Object.keys(consumed).length === 0) return;
  try {
    const logRef = ref(rtdb, `status/${docId}/y/${liveEpoch}`);
    await runTransaction(logRef, (current) => {
      // The SDK may start from an empty local cache after the editor unbinds.
      // Propose an empty-value CAS so it fetches/retries against the server;
      // undefined here would abort without ever inspecting the existing log.
      if (current === null) return null;
      if (typeof current !== "object") return undefined;
      const keys = Object.keys(current);
      // A new delta depends on the elected seed's Yjs identities. Retain the
      // WHOLE log if anything raced the save, never strand those dependencies.
      if (keys.length !== Object.keys(consumed).length || keys.some((key) => current[key] !== consumed[key])) return undefined;
      return null;
    }, { applyLocally: false });
  } catch {
    /* retirement is best-effort; a complete surviving log remains replayable */
  }
}
