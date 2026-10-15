// SPDX-License-Identifier: Apache-2.0
// The presence access mirror, for scripts (SPEC §16).

/**
 * ESM twin of the sync in functions/src/lib/presence.ts. Both exist because
 * presence reads are gated by a mirror of `members` that lives in RTDB, and
 * EVERY path that recomputes membership has to refresh it — including the admin
 * CLIs. Miss one and a revoked reader keeps seeing who else is in the document.
 *
 * `editAccess` is the second mirror, of `editorMembers`, and it gates writes to
 * the shared document state. Miss THAT one and a revoked editor keeps typing
 * into everyone else's copy.
 */

import { getDb, getRtdb } from "./firebase.mjs";

/** RTDB keys may not contain a dot; the other illegal characters are rejected by the email validator. */
export function emailKey(email) {
  return String(email).toLowerCase().split(".").join(",");
}

/** Replace the mirror for one document. Best-effort; never fails the caller. */
export async function syncPresenceAccess(
  docId,
  members,
  editorMembers = [],
  projectOverride,
) {
  const rtdb = getRtdb(projectOverride);
  if (!rtdb) return;
  void members; void editorMembers;
  try {
    const snap = await getDb(projectOverride).collection("docs").doc(docId).get();
    if (!snap.exists || !snap.updateTime) return;
    const data = snap.data() || {};
    const revision = `${String(snap.updateTime.seconds).padStart(12, "0")}:${String(snap.updateTime.nanoseconds).padStart(9, "0")}`;
    const value = typeof data.expiresAt === "number" ? data.expiresAt : data.expiresAt?.toMillis?.();
    const expiresAt = Number.isFinite(value) ? value : 0;
    const keyed = (list) => {
      const out = { __revision: revision, __expiresAt: expiresAt, __owner: String(data.ownerEmail ?? "").toLowerCase(), __liveEpoch: typeof data.liveEpoch === "string" ? data.liveEpoch : "initial" };
      for (const member of Array.isArray(list) ? list : []) {
        if (typeof member === "string" && member.length > 0) out[emailKey(member)] = true;
      }
      return out;
    };
    const edit = keyed(data.editorMembers);
    if (data.visibility === "public" && data.publicEdit === true) edit["*"] = true;
    const replace = async (path, next) => {
      await rtdb.ref(path).transaction((current) => {
        const prior = current?.__revision;
        if (typeof prior === "string" && /^\d{12}:\d{9}$/.test(prior) && prior > revision) return;
        return next;
      });
    };
    await replace(`editAccess/${docId}`, edit);
    await replace(`presenceAccess/${docId}`, keyed(data.members));
  } catch {
    /* presence is a non-essential subsystem */
  }
}
