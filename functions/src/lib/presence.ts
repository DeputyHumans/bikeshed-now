// SPDX-License-Identifier: Apache-2.0
// The server-maintained presence access mirror in RTDB (SPEC §1.4a, §16).

import * as admin from "firebase-admin";
import { opensEditingToAnyAccount } from "./acl";

/**
 * Why this exists
 * ---------------
 * Presence lives in the Realtime Database, and RTDB rules cannot query
 * Firestore. With no domain gate, "any signed-in account may read
 * `status/{docId}`" would let anyone walk the slug space and learn who reads
 * what — and the presence payload now carries a live selection stream, which
 * reveals what a person is reading sentence by sentence.
 *
 * So the authorization data has to live IN RTDB. This module mirrors each
 * document's effective member list to `presenceAccess/{docId}`, and the rules
 * require an entry to exist before granting read or write on `status/{docId}`.
 *
 * It mirrors the EDITOR list separately, to `editAccess/{docId}`, and that
 * separation is load-bearing rather than tidy. Shared document state travels
 * over the same node (SPEC §6b), and `presenceAccess` names everyone who may
 * READ. Gating a CRDT write on it would let a read-only member inject content
 * into an editor's browser, which that editor would then autosave and publish —
 * read escalated to write, through a channel nobody would think to check.
 *
 * Keyed by EMAIL, not uid, because the server does not learn a grantee's uid
 * until their first sign-in and a share has to work the moment it is granted.
 *
 * Written as version-fenced whole-node transactions, so a revocation
 * propagates rather than leaving a stale key behind. It fails CLOSED: a missing
 * entry means presence goes dark for that document, never that a stranger can
 * read it.
 */

/**
 * RTDB keys may not contain `. $ # [ ] /`. Dots are replaced here; the other
 * five are rejected by the email validator in config/policy.mjs, so every
 * address the system stores is representable as a key. That is why the
 * validator rejects characters a looser reading of RFC 5322 would allow.
 */
export function emailKey(email: string): string {
  return email.toLowerCase().split(".").join(",");
}

/**
 * The RTDB handle, or null when the deployment has no Realtime Database.
 *
 * `admin.database()` throws without a configured databaseURL, and presence is
 * optional by design — the whole product works without it, minus the peer
 * cursors. Resolved once and cached, so a deployment without RTDB does not throw
 * on every membership change.
 */
let dbHandle: admin.database.Database | null | undefined;
function database(): admin.database.Database | null {
  if (dbHandle !== undefined) return dbHandle;
  try {
    dbHandle = admin.database();
  } catch {
    dbHandle = null;
  }
  return dbHandle;
}

/**
 * Replace the mirror for one document.
 *
 * Called from every place that recomputes `members`: createDoc, forkDocument,
 * setAccess, setVisibility, organize, recomputeSubtree, manageTeamMembers, and
 * the admin scripts. Never throws: presence is a non-essential subsystem, and a
 * subsystem that can fail a share is worse than one that can go dark.
 */
/**
 * The key that means "any verified account", for an open-editing document.
 *
 * `publicEdit` widens WHO may edit to any verified account (SPEC §17), and
 * those accounts are by definition not in `editorMembers`. Without this they
 * would be the one class of editor the shared document locks out — which is
 * how the withdrawn edit lock behaved, and it was a defect there too.
 *
 * `*` is safe as a key precisely because it is not a legal email: the validator
 * rejects it, so it can never collide with a person.
 */
export const OPEN_EDIT_KEY = "*";

export async function syncPresenceAccess(
  docId: string,
  members: readonly string[],
  editorMembers: readonly string[] = [],
  publicEdit = false,
): Promise<void> {
  const db = database();
  if (!db) return;
  // The parameters retain the call-site contract; only the latest committed
  // Firestore snapshot is authoritative. A visibility request may have read
  // its member arrays before a concurrent revocation completed.
  void members; void editorMembers; void publicEdit;
  try {
    const snap = await admin.firestore().collection("docs").doc(docId).get();
    if (!snap.exists || !snap.updateTime) return;
    const data = snap.data() || {};
    const revision = `${String(snap.updateTime.seconds).padStart(12, "0")}:${String(snap.updateTime.nanoseconds).padStart(9, "0")}`;
    const keyed = (list: unknown): Record<string, true | string> => {
      const out: Record<string, true | string> = { __revision: revision };
      for (const member of Array.isArray(list) ? list : []) {
        if (typeof member === "string" && member.length > 0) out[emailKey(member)] = true;
      }
      return out;
    };
    const edit = keyed(data.editorMembers);
    if (opensEditingToAnyAccount(data)) edit[OPEN_EDIT_KEY] = true;
    const replace = async (path: string, next: Record<string, true | string>) => {
      await db.ref(path).transaction((current) => {
        const prior = current?.__revision;
        // Legacy nodes have no fence. Reject only a validated newer revision;
        // the server alone writes these maps, and arbitrary keys stay visible.
        if (typeof prior === "string" && /^\d{12}:\d{9}$/.test(prior) && prior > revision) return;
        return next;
      });
    };
    // Revoke writes before reads. Each node has its own ordering fence, so a
    // slow older request cannot reopen access after a newer one has returned.
    await replace(`editAccess/${docId}`, edit);
    await replace(`presenceAccess/${docId}`, keyed(data.members));
  } catch {
    /* presence is best-effort and must never fail the request it rode in on */
  }
}

/** Drop the mirror and any live presence for a document. */
export async function clearPresence(docId: string): Promise<void> {
  const db = database();
  if (!db) return;
  try {
    await Promise.all([
      db.ref(`presenceAccess/${docId}`).remove(),
      db.ref(`editAccess/${docId}`).remove(),
      db.ref(`status/${docId}`).remove(),
    ]);
  } catch {
    /* best-effort */
  }
}

/**
 * Who has a document open in the editor right now, and whether its live
 * editing log holds anything, for a write made outside the editor: an
 * agent's accept or publish (ADR 0015). Null when the deployment has no
 * Realtime Database, so nobody can be editing live.
 *
 * Resolved on every call rather than through the cached handle above: this
 * guards a write, so it must see the database as it is, and a read that fails
 * throws rather than reading as "nobody here".
 *
 * The log wins over the stored draft when an editor opens (SPEC §6b), which is
 * why a draft written under a log nobody is using must clear the log too. It
 * carries live collaboration and nothing durable, so it may be dropped.
 */
export async function liveEditing(docId: string): Promise<{ editors: number; log: boolean } | null> {
  let db: admin.database.Database;
  try {
    db = admin.database();
  } catch {
    return null;
  }
  const peers = (await db.ref(`status/${docId}/peers`).once("value")).val() as Record<string, { mode?: unknown }> | null;
  const editors = Object.values(peers ?? {}).filter((p) => p?.mode === "edit").length;
  const log = (await db.ref(`status/${docId}/y`).limitToFirst(1).once("value")).exists();
  return { editors, log };
}

/** Drop a document's live editing log, as the app does when a draft is published. */
export async function clearEditLog(docId: string): Promise<void> {
  let db: admin.database.Database;
  try {
    db = admin.database();
  } catch {
    return;
  }
  await db.ref(`status/${docId}/y`).remove();
}

/** A write refused because somebody is in the editor, or might be. */
export type EditingRefusal = { status: 409; error: string; editors?: number };

/**
 * Why nothing may be written to a draft now, or what is left to drop when it
 * may: whether a log nobody is using holds anything.
 *
 * Every write made outside the editor asks this first: an agent's accept,
 * `commit_draft`, and every update (SPEC §6a). A read that fails refuses,
 * because "nobody is here" is the answer that loses somebody's typing.
 */
export async function editorsRefusal(
  docId: string,
  doing: string,
): Promise<{ refusal: EditingRefusal } | { log: boolean }> {
  let live: Awaited<ReturnType<typeof liveEditing>>;
  try {
    live = await liveEditing(docId);
  } catch {
    return {
      refusal: { status: 409, error: `Could not tell whether anybody is editing this document, so it was not ${doing}. Try again.` },
    };
  }
  if (live && live.editors > 0) {
    const who = live.editors === 1 ? "Somebody has" : `${live.editors} people have`;
    return {
      refusal: {
        status: 409,
        error: `${who} this document open in the editor, where this would be lost, so it was not ${doing}. Try again once they have left it, or ask them to do it there.`,
        editors: live.editors,
      },
    };
  }
  return { log: Boolean(live?.log) };
}
