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
import { get, post } from "./api";

/**
 * Two scopes, split by WHO BEARS THE RISK.
 *
 *   GLOBAL   docs/{docId}.trusted — the bundle's JavaScript then runs
 *            same-origin for EVERY reader. A decision made on other people's
 *            behalf, so it is a superadmin's, on a document they own, and
 *            server-mediated (ADR 0021).
 *
 *   PERSONAL docs/{docId}/trust/{uid} — un-sandboxes the document only in the
 *            granting user's own browser. The sole session exposed to that
 *            bundle's JavaScript is theirs, so any reader may grant it to
 *            themselves. Written directly under an own-uid rule.
 *
 * Effective trust in the viewer is `meta.trusted === true || personalTrusted`.
 * Personal trust never writes the global flag, so one reader's choice cannot
 * change what anybody else sees.
 */

export function setTrusted(docId: string, trusted = true): Promise<{ trusted: boolean }> {
  return post<{ trusted: boolean }>(
    "/trust",
    { docId, trusted },
    {
      forbidden:
        "Only this deployment's administrators can run a document's code for everyone. You can still run it for yourself.",
    },
  );
}

/**
 * Whether this account may trust the document for everyone: its owner, and a
 * superadmin of this deployment (ADR 0021). Who the superadmins are is never
 * sent; only the answer for the asker is.
 */
export async function mayTrustForEveryone(docId: string): Promise<boolean> {
  const answer = await get<{ canTrustForEveryone?: unknown }>("/trust", { docId });
  return answer.canTrustForEveryone === true;
}

/**
 * Live subscription to whether THIS account has personally trusted the document.
 *
 * An error resolves to `false` — stay sandboxed. Failing closed is the only
 * defensible default for a security toggle, and it is why this does not surface
 * the error: the safe state and the error state look identical on purpose.
 *
 * A grant counts only once the server has it. The frame that then loads asks
 * the server whether this reader consented (ADR 0021), and a grant still
 * pending here would load a frame the server answers locked. A withdrawal
 * counts at once: the safe direction never waits.
 */
export function watchPersonalTrust(
  docId: string,
  uid: string,
  onData: (trusted: boolean) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, "docs", docId, "trust", uid),
    { includeMetadataChanges: true },
    (snap) => {
      if (snap.exists() && snap.metadata.hasPendingWrites) return;
      onData(snap.exists());
    },
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
