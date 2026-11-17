// SPDX-License-Identifier: Apache-2.0
// When a date passes: the hourly job that makes a document or folder private and clears its date (SPEC §17, ADR 0029).

import * as admin from "firebase-admin";
import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { expiryMs, isPurged, isTrashed, visibilityOf, type DocAclData } from "./acl";
import { eventRecord, SYSTEM } from "./events";
import { membershipOf, recomputeSubtree } from "./folders";
import { syncPresenceAccess } from "./presence";
import { syncPublicProjection } from "./publicdoc";

type Db = admin.firestore.Firestore;

/**
 * What a date does
 * ----------------
 * When a document's date passes it becomes private and the date is cleared:
 * its level goes to private, open editing goes off, its link token is
 * deleted so every copy of the link stops working, and the people it was
 * shared with by name, or through a folder's members, keep it. A folder does
 * the same for its own level and link. Nothing is deleted (SPEC §17).
 *
 * Nothing watches the clock, so this job makes the change, once an hour. In
 * the hour before it runs, every path still treats a passed date as it always
 * has: the document is its owner's alone and frozen, which is stricter than
 * private, so the wait can lock somebody out for up to an hour but can never
 * let anybody in (ADR 0029).
 *
 * Each item goes in two steps, and the date is cleared LAST. The first
 * transaction makes it private and records the change once, under an id
 * derived from the date, so a retry or an overlapping run finds the record
 * already there. The public mirror and, for a folder, the subtree's reach
 * follow. Only then does a second transaction delete the date, and only if it
 * is still the one this run saw. A run that stops between the two leaves the
 * item private with its date still set, still frozen, and still matched by
 * the next run's query, which finishes it.
 *
 * Something in the Trash is left alone. Restore gives back exactly what it
 * took (SPEC §4), and an item restored after its date is frozen as any passed
 * date is until the next run makes it private.
 */

export type ExpiryOutcome = "expired" | "trashed" | "skipped";

/** Make one document private because its date has passed, as of `now`. */
export async function expireDocument(db: Db, id: string, now = Date.now()): Promise<ExpiryOutcome> {
  const ref = db.collection("docs").doc(id);
  const first = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const raw = snap.data();
    if (!snap.exists || !raw || isPurged(raw)) return "skipped" as const;
    const data = raw as DocAclData;
    const due = expiryMs(data);
    // Cleared or moved since the query read it: the owner's choice stands.
    if (due === null || due > now) return "skipped" as const;
    if (isTrashed(data)) return "trashed" as const;
    const eventRef = ref.collection("events").doc(`expired-${due}`);
    const recorded = (await tx.get(eventRef)).exists;
    tx.set(ref, {
      visibility: "private",
      publicEdit: false,
      linkToken: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (!recorded) {
      tx.create(eventRef, eventRecord({
        type: "doc.expired",
        // As doc.visibility is: it says what level it had.
        audience: "editors",
        actor: SYSTEM,
        data: { expiresAt: due, from: visibilityOf(data), endedOpenEditing: data.publicEdit === true },
      }));
    }
    return due;
  });
  if (typeof first !== "number") return first;
  // Twice: once private, so the mirror goes before the date does, and once
  // the date is gone, so a mirror a shared folder keeps stops carrying it.
  await syncPublicProjection(db, id);
  await clearDate(db, ref, first);
  await syncPublicProjection(db, id);
  const m = membershipOf((await ref.get()).data());
  await syncPresenceAccess(id, m.members, m.editorMembers, false);
  return "expired";
}

/** Make one folder private because its date has passed: its reach beneath it ends, its members keep it. */
export async function expireFolder(db: Db, id: string, now = Date.now()): Promise<ExpiryOutcome> {
  const ref = db.collection("folders").doc(id);
  const first = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as DocAclData | undefined;
    if (!snap.exists || !data) return "skipped" as const;
    const due = expiryMs(data);
    if (due === null || due > now) return "skipped" as const;
    if (isTrashed(data)) return "trashed" as const;
    // The folder's own history, beside the entries a level or a grant change
    // writes, with the reason an account move's carries for the same purpose.
    const entryRef = ref.collection("acl").doc(`expired-${due}`);
    const recorded = (await tx.get(entryRef)).exists;
    tx.set(ref, { visibility: "private", linkToken: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (!recorded) {
      tx.create(entryRef, {
        at: FieldValue.serverTimestamp(),
        actor: SYSTEM,
        reason: "expired",
        visibility: { from: visibilityOf(data), to: "private" },
        expiresAt: { from: due, to: null },
        linkRotated: typeof (data as { linkToken?: unknown }).linkToken === "string",
      });
    }
    return due;
  });
  if (typeof first !== "number") return first;
  // Its own reach entry goes, and with it every descendant's inherited one and
  // the public mirror of every document beneath it, as a level change does.
  await recomputeSubtree(db, id);
  await clearDate(db, ref, first);
  return "expired";
}

/** Delete the date, but only the one this run acted on: a new one set meanwhile is the owner's. */
async function clearDate(db: Db, ref: admin.firestore.DocumentReference, due: number): Promise<void> {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || expiryMs(snap.data() as DocAclData) !== due) return;
    tx.update(ref, { expiresAt: FieldValue.delete() });
  });
}

export interface ExpiryReport {
  /** Documents made private by this run. */
  documents: number;
  /** Folders made private by this run. */
  folders: number;
  /** Past their date but in the Trash, so left for after a Restore. */
  trashed: number;
  /** Matched by the query, then cleared, moved or gone before the transaction. */
  skipped: number;
  /** Stopped at its deadline with more to do; the next run carries on. */
  more: boolean;
}

/** How many records a run reads at a time. */
const PAGE = 100;

/** How long a run works before it stops and leaves the rest: well inside its 540 s timeout. */
const RUN_BUDGET_MS = 8 * 60_000;

/**
 * The hourly job: every document, then every folder, whose date is at or
 * before `now`, until `deadline`. It walks each by a cursor rather than
 * re-reading the first page, because what it skips (the Trash) stays matched,
 * and a first page full of skipped items would otherwise hide every item
 * after it for good.
 */
export async function expireDue(db: Db, now = Date.now(), deadline = now + RUN_BUDGET_MS): Promise<ExpiryReport> {
  const report: ExpiryReport = { documents: 0, folders: 0, trashed: 0, skipped: 0, more: false };
  const cutoff = Timestamp.fromMillis(now);
  const kinds = [
    ["docs", "documents", (id: string) => expireDocument(db, id, now)],
    ["folders", "folders", (id: string) => expireFolder(db, id, now)],
  ] as const;
  for (const [collection, counter, expire] of kinds) {
    let after: [Timestamp, string] | null = null;
    for (;;) {
      let query = db.collection(collection)
        .where("expiresAt", "<=", cutoff)
        .orderBy("expiresAt")
        .orderBy(FieldPath.documentId())
        .limit(PAGE);
      if (after) query = query.startAfter(...after);
      const page = await query.get();
      for (const item of page.docs) {
        if (Date.now() > deadline) return { ...report, more: true };
        const outcome = await expire(item.id);
        if (outcome === "expired") report[counter] += 1;
        else report[outcome] += 1;
      }
      if (page.docs.length < PAGE) break;
      const last = page.docs[page.docs.length - 1];
      after = [last.get("expiresAt") as Timestamp, last.id];
    }
  }
  return report;
}
