// SPDX-License-Identifier: Apache-2.0
// Resolving and reopening a comment thread through a token (SPEC §6, §19).

import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import type { Actor } from "./actor";

/**
 * In the app a reader flips `resolved` on a thread with a client write the
 * rules allow, and nothing else is recorded. A token cannot write Firestore,
 * so an agent's resolve comes through here instead, under the same two rules:
 * whoever may read the document may do it, and never on a suggestion, which is
 * settled by accepting, rejecting or withdrawing it (SPEC §22).
 *
 * Unlike the app, every change leaves a note in the thread, stamped with the
 * actor. Resolving hides a point from the person who raised it; the note, and
 * the notice it sends, are how they hear that an agent closed it (ADR 0015).
 */

export type ThreadRefusal = { status: 404 | 409; error: string };

export async function setThreadResolved(args: {
  db: admin.firestore.Firestore;
  docRef: admin.firestore.DocumentReference;
  versionId: string;
  annId: string;
  resolved: boolean;
  caller: { uid: string; emailLower: string };
  actor: Actor;
}): Promise<{ resolved: boolean; changed: boolean } | ThreadRefusal> {
  const { db, docRef, versionId, annId, resolved, caller, actor } = args;
  const annRef = docRef.collection("versions").doc(versionId).collection("annotations").doc(annId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(annRef);
    const ann = snap.data();
    if (!snap.exists || !ann) return { status: 404, error: "no such thread" };
    if (ann.suggestion) {
      return {
        status: 409,
        error: "that thread is a suggested edit: it is settled by accepting, rejecting or withdrawing it, not by resolving",
      };
    }
    // Already so: nothing written and no second note, so a retry is harmless.
    if ((ann.resolved === true) === resolved) return { resolved, changed: false };

    // `resolvedBy` is who the change log says resolved or reopened it.
    tx.update(annRef, { resolved, resolvedBy: actor });
    const noteRef = annRef.collection("comments").doc();
    tx.create(noteRef, {
      commentId: noteRef.id,
      body: resolved ? "Resolved." : "Reopened.",
      authorUid: caller.uid,
      authorEmail: caller.emailLower,
      actor,
      createdAt: FieldValue.serverTimestamp(),
      generated: true,
    });
    return { resolved, changed: true };
  });
}
