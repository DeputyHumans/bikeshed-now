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
 * document in answer to its open comments, and a person resolves them after.
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
