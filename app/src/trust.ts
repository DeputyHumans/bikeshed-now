// SPDX-License-Identifier: Apache-2.0
// Global and personal trust (SPEC §6c).

import {
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "./firebase";
import { post } from "./api";

/**
 * Two scopes, split by WHO BEARS THE RISK.
 *
 *   GLOBAL   docs/{docId}.trusted — the bundle's JavaScript then runs
 *            same-origin for EVERY reader. A decision made on other people's
 *            behalf, so it stays owner-only and server-mediated.
 *
 *   PERSONAL docs/{docId}/trust/{uid} — un-sandboxes the document only in the
 *            granting user's own browser. The sole session exposed to that
 *            bundle's JavaScript is theirs, so any reader may grant it to
 *            themselves. Written directly under an own-uid rule.
 *
 * Effective trust in the viewer is `meta.trusted !== false || personalTrusted`.
 * Personal trust never writes the global flag, so one reader's choice cannot
 * change what anybody else sees.
 */

export function setTrusted(docId: string, trusted = true): Promise<{ trusted: boolean }> {
  return post<{ trusted: boolean }>(
    "/trust",
    { docId, trusted },
    { forbidden: "Only the document owner can trust this for everyone." },
  );
}

/**
 * Live subscription to whether THIS account has personally trusted the document.
 *
 * An error resolves to `false` — stay sandboxed. Failing closed is the only
 * defensible default for a security toggle, and it is why this does not surface
 * the error: the safe state and the error state look identical on purpose.
 */
export function watchPersonalTrust(
  docId: string,
  uid: string,
  onData: (trusted: boolean) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, "docs", docId, "trust", uid),
    (snap) => onData(snap.exists()),
    () => onData(false),
  );
}

export async function setPersonalTrust(
  docId: string,
  uid: string,
  emailLower: string,
  trusted: boolean,
): Promise<void> {
  const ref = doc(db, "docs", docId, "trust", uid);
  if (!trusted) {
    await deleteDoc(ref);
    return;
  }
  await setDoc(ref, {
    uid,
    email: emailLower.toLowerCase(),
    trustedAt: serverTimestamp(),
  });
}
