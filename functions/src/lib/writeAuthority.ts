// SPDX-License-Identifier: Apache-2.0
// Current expiry and edit authority are checked inside content-write transactions (SPEC §8, §17).

import type * as admin from "firebase-admin";
import { canEdit, isExpired, visibilityOf, type DocAclData, type LinkProof } from "./acl";
import { grantTokenOf, linkGrantRef } from "./linkgrant";

export class WriteAuthorityError extends Error {
  constructor(readonly status: 403 | 409, readonly detail: Record<string, unknown>) {
    super(String(detail.error));
    this.name = "WriteAuthorityError";
  }
}

/** Call after reading the current document and before the transaction writes. */
export async function assertWriteAuthority(
  tx: admin.firestore.Transaction,
  docRef: admin.firestore.DocumentReference,
  data: DocAclData,
  caller: { uid: string; emailLower: string },
): Promise<void> {
  if (isExpired(data, Date.now())) throw new WriteAuthorityError(409, {
    expired: true,
    error: "this document has expired — change or clear its expiry to edit it",
  });
  if (canEdit(data, caller)) return;
  let proof: LinkProof = {};
  if (caller.uid && visibilityOf(data) === "unlisted" && data.publicEdit === true) {
    // A remembered link is revocable. Reading it in this transaction prevents
    // a grant withdrawn during an upload from authorizing the eventual commit.
    proof = { grantToken: grantTokenOf(await tx.get(linkGrantRef(docRef, caller.uid))) };
  }
  if (!canEdit(data, caller, proof)) throw new WriteAuthorityError(403, {
    error: "You no longer have permission to edit this document.",
  });
}
