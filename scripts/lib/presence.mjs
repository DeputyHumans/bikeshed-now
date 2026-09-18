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

import { getRtdb } from "./firebase.mjs";

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
  const keyed = (list) => {
    const out = {};
    for (const m of list) {
      const key = emailKey(m);
      if (key) out[key] = true;
    }
    return out;
  };
  try {
    // One multi-path update, matching the CJS twin: the two mirrors must never
    // disagree, or a revoked reader keeps write access to the shared document.
    await rtdb.ref().update({
      [`presenceAccess/${docId}`]: keyed(members),
      [`editAccess/${docId}`]: keyed(editorMembers),
    });
  } catch {
    /* presence is a non-essential subsystem */
  }
}
