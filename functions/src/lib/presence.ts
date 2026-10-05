// SPDX-License-Identifier: Apache-2.0
// The server-maintained presence access mirror in RTDB (SPEC §1.4a, §16).

import * as admin from "firebase-admin";

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
 * Written as a whole-node `set()` — an atomic replace — so a revocation
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
  const keyed = (list: readonly string[]): Record<string, true> => {
    const out: Record<string, true> = {};
    for (const m of list) {
      const key = emailKey(m);
      if (key.length > 0) out[key] = true;
    }
    return out;
  };
  const edit = keyed(editorMembers) as Record<string, true>;
  if (publicEdit) edit[OPEN_EDIT_KEY] = true;
  try {
    // ONE multi-path update, so the two mirrors can never disagree about a
    // person: a window where `editAccess` still names somebody `presenceAccess`
    // has dropped is a window where a revoked reader can still write.
    await db.ref().update({
      [`presenceAccess/${docId}`]: keyed(members),
      [`editAccess/${docId}`]: edit,
    });
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
