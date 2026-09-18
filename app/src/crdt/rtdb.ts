// SPDX-License-Identifier: Apache-2.0
// The update log, carried on the presence database (SPEC §6b, §16).

import { onChildAdded, push, ref, remove, update } from "firebase/database";
import { rtdb } from "../firebase";
import type { UpdateLog } from "./log";

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
export function rtdbLog(docId: string): UpdateLog | null {
  if (!rtdb) return null;
  const logRef = ref(rtdb, `status/${docId}/y`);
  return {
    subscribe(onEntry) {
      // `onChildAdded` replays the children that already exist before it
      // reports new ones, so a late joiner catches up and then keeps up
      // through the same callback. That is the whole sync protocol.
      return onChildAdded(logRef, (snap) => {
        const value = snap.val();
        if (typeof value === "string" && snap.key) onEntry(snap.key, value);
      });
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

/** Drop the whole log. Used when a draft is discarded or committed. */
export async function clearLog(docId: string): Promise<void> {
  if (!rtdb) return;
  try {
    await remove(ref(rtdb, `status/${docId}/y`));
  } catch {
    /* best-effort: a stale log is re-seeded from the saved draft */
  }
}
