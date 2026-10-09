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

/**
 * Accepted suggestions whose change exists only in the draft.
 *
 * Accepting puts the change into the draft and records the decision on the
 * current version; the change reaches a version when the draft is published.
 * Every other way of minting a version — an update through a token, a
 * re-upload — replaces the draft with its own bytes and deletes it. Doing that
 * over such a draft would leave a suggestion reading "Accepted." on a version
 * whose next one does not contain it, so those paths ask this first, and again
 * inside the transaction that deletes the draft.
 */
export async function acceptedInDraft(
  docRef: admin.firestore.DocumentReference,
  versionId: string,
): Promise<number> {
  if (!versionId) return 0;
  const draft = (await docRef.get()).data()?.draft as { baseVersion?: unknown } | undefined;
  if (!draft || draft.baseVersion !== versionId) return 0;
  const snap = await docRef
    .collection("versions")
    .doc(versionId)
    .collection("annotations")
    .where("suggestion.state", "==", "accepted")
    .count()
    .get();
  return snap.data().count;
}

/** What a refused update says when the draft holds accepted changes. */
export function acceptedInDraftMessage(count: number): string {
  const what = count === 1 ? "1 accepted suggestion" : `${count} accepted suggestions`;
  return (
    `This document's unpublished draft holds ${what}, and publishing this would replace the draft ` +
    `and lose ${count === 1 ? "it" : "them"}. Publish the draft first, with commit_draft or "Save as new version" ` +
    "in the app, then read the document again and update it."
  );
}

/** The refusal an update returns while the draft holds accepted changes. */
export interface AcceptedRefusal {
  error: string;
  status: 409;
  acceptedInDraft: number;
}

export async function refuseIfAcceptedInDraft(
  docRef: admin.firestore.DocumentReference,
  versionId: string,
): Promise<AcceptedRefusal | null> {
  const count = await acceptedInDraft(docRef, versionId);
  if (count === 0) return null;
  return { error: acceptedInDraftMessage(count), status: 409, acceptedInDraft: count };
}

/** The same question inside a transaction, given the document as it read it. */
export async function anyAcceptedInDraft(
  tx: admin.firestore.Transaction,
  docRef: admin.firestore.DocumentReference,
  versionId: string,
  doc: admin.firestore.DocumentData | undefined,
): Promise<boolean> {
  const draft = doc?.draft as { baseVersion?: unknown } | undefined;
  if (!versionId || !draft || draft.baseVersion !== versionId) return false;
  const accepted = docRef
    .collection("versions")
    .doc(versionId)
    .collection("annotations")
    .where("suggestion.state", "==", "accepted");
  return !(await tx.get(accepted.limit(1))).empty;
}
