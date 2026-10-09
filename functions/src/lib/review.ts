// SPDX-License-Identifier: Apache-2.0
// What must be decided before a document gets a new version (SPEC §6a).

import * as admin from "firebase-admin";

/**
 * Pending suggestions on a version.
 *
 * A suggestion is anchored to the version it was made on, and annotations do
 * not travel to the next one. Publishing past a pending suggestion would leave
 * it on a version nobody reads, undecided for good, which is a quieter way of
 * rejecting it without anybody having chosen to.
 *
 * So EVERY path that mints a version from an account asks this first: the
 * in-app commit, an upload, the CLI and MCP. The comment gate is narrower — it
 * applies to the in-app commit alone — because the agent loop revises a
 * document in answer to its open comments, and closing them is not what
 * publishing the answer waits for.
 * A suggestion is different: nobody but an approver can decide it, or its
 * author take it back, and an update that buried it would take that away from
 * them.
 */
export async function pendingSuggestions(
  docRef: admin.firestore.DocumentReference,
  versionId: string,
): Promise<number> {
  if (!versionId) return 0;
  const snap = await docRef
    .collection("versions")
    .doc(versionId)
    .collection("annotations")
    .where("suggestion.state", "==", "pending")
    .count()
    .get();
  return snap.data().count;
}

/** What a refused publish says, for a person and an agent alike. */
export function pendingSuggestionsMessage(count: number): string {
  const what = count === 1 ? "1 suggested edit is" : `${count} suggested edits are`;
  return (
    `${what} waiting for a decision. Only the owner or an approver can accept ` +
    `or reject ${count === 1 ? "it" : "them"}, and no new version can be published until then. ` +
    // An agent blocked by its own proposal can clear that one itself.
    (count === 1 ? "If it is yours, you may withdraw it." : "Any that are yours you may withdraw.")
  );
}

/** The refusal a version-minting path returns, rather than throws. */
export interface PendingRefusal {
  error: string;
  status: 409;
  pendingSuggestions: number;
}

export async function refuseIfPending(
  docRef: admin.firestore.DocumentReference,
  versionId: string,
): Promise<PendingRefusal | null> {
  const count = await pendingSuggestions(docRef, versionId);
  if (count === 0) return null;
  return { error: pendingSuggestionsMessage(count), status: 409, pendingSuggestions: count };
}

/**
 * Is anything still open on `versionId`, read INSIDE the transaction that is
 * about to make another version current? The counts above run before the
 * upload, and a thread opened during it would otherwise be left on a version
 * nobody reads any more. Read in the transaction, it either is seen here or
 * is written after the version moved, where its own check refuses it.
 *
 * `suggestions` asks only about pending suggestions, which hold back every
 * way of publishing; `threads` asks about any unresolved thread, which the
 * in-app commit also waits for.
 */
export async function anyOpenThread(
  tx: admin.firestore.Transaction,
  docRef: admin.firestore.DocumentReference,
  versionId: string,
  which: "suggestions" | "threads",
): Promise<boolean> {
  if (!versionId) return false;
  const anns = docRef.collection("versions").doc(versionId).collection("annotations");
  const open = which === "suggestions" ? anns.where("suggestion.state", "==", "pending") : anns.where("resolved", "==", false);
  return !(await tx.get(open.limit(1))).empty;
}
