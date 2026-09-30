// SPDX-License-Identifier: Apache-2.0
// Link grants: an account's proof of an unlisted document's key (SPEC §17)

/**
 * The security rules cannot see a URL, so they cannot check `?k=`. A signed-in
 * visitor who opens an unlisted document with its key gets a grant instead —
 * `docs/{docId}/linkGrants/{uid}` — which the rules and every endpoint accept in
 * place of the key, for as long as the token it names is still the document's.
 *
 * Rotating the link (private, then unlisted again) therefore revokes every grant
 * at once without touching one. Clients can neither read nor write a grant; only
 * `POST /unlock` mints them, and only on seeing the key.
 */

import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import {
  type DocAclData,
  type LinkProof,
  isMember,
  tokenMatches,
  visibilityOf,
} from "./acl";

export const LINK_GRANTS = "linkGrants";

type Caller = { uid: string; emailLower: string } | null;

export function linkGrantRef(
  docRef: admin.firestore.DocumentReference,
  uid: string,
): admin.firestore.DocumentReference {
  return docRef.collection(LINK_GRANTS).doc(uid);
}

/** The token a stored grant names, or null for no grant or a malformed one. */
export function grantTokenOf(
  snap: admin.firestore.DocumentSnapshot | null | undefined,
): string | null {
  if (!snap?.exists) return null;
  const token = snap.get("token");
  return typeof token === "string" ? token : null;
}

/**
 * Assemble one request's proof: the key it carries, plus the caller's grant
 * token when that could change the answer — a signed-in non-member, on an
 * unlisted document, whose key did not already match. That is the only path
 * that pays the extra read.
 */
export async function linkProofFor(
  docRef: admin.firestore.DocumentReference,
  doc: DocAclData,
  caller: Caller,
  k: string | null | undefined,
): Promise<LinkProof> {
  const proof: LinkProof = { k: k ?? null };
  if (!caller || visibilityOf(doc) !== "unlisted") return proof;
  if (isMember(doc, caller.uid, caller.emailLower)) return proof;
  if (tokenMatches(doc.linkToken, k)) return proof;
  const snap = await linkGrantRef(docRef, caller.uid).get();
  return { ...proof, grantToken: grantTokenOf(snap) };
}

/** Record that this account presented the key the document holds now. */
export async function recordLinkGrant(
  docRef: admin.firestore.DocumentReference,
  uid: string,
  token: string,
): Promise<void> {
  await linkGrantRef(docRef, uid).set({
    uid,
    token,
    grantedAt: FieldValue.serverTimestamp(),
  });
}
