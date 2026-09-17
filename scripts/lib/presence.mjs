// SPDX-License-Identifier: Apache-2.0
// The presence access mirror, for scripts (SPEC §16).

/**
 * ESM twin of the sync in functions/src/lib/presence.ts. Both exist because
 * presence reads are gated by a mirror of `members` that lives in RTDB, and
 * EVERY path that recomputes membership has to refresh it — including the admin
 * CLIs. Miss one and a revoked reader keeps seeing who else is in the document.
 */

import { getRtdb } from "./firebase.mjs";

/** RTDB keys may not contain a dot; the other illegal characters are rejected by the email validator. */
export function emailKey(email) {
  return String(email).toLowerCase().split(".").join(",");
}

/** Replace the mirror for one document. Best-effort; never fails the caller. */
export async function syncPresenceAccess(docId, members, projectOverride) {
  const rtdb = getRtdb(projectOverride);
  if (!rtdb) return;
  const payload = {};
  for (const m of members) {
    const key = emailKey(m);
    if (key) payload[key] = true;
  }
  try {
    await rtdb.ref(`presenceAccess/${docId}`).set(payload);
  } catch {
    /* presence is a non-essential subsystem */
  }
}
