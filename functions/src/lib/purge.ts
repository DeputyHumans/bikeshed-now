// SPDX-License-Identifier: Apache-2.0
// Deleting forever: what leaves the Trash for good, and the tombstone that keeps a document's id (SPEC §4, ADR 0025).

import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { TRASH_RETENTION_MS, bucketName } from "../config";
import { batchOf, isPurged, isTrashed, trashedAtMs } from "./acl";
import { FORKS } from "./fork";
import { persistDocMembership, persistFolderMembership, recomputeSubtree } from "./folders";
import { clearPresence } from "./presence";

type Db = admin.firestore.Firestore;
type Data = admin.firestore.DocumentData;
type Ref = admin.firestore.DocumentReference;

/**
 * What deleting forever is
 * ------------------------
 * Only something in the Trash is ever deleted, and only two ways: by the
 * daily job once it has been there for 30 days, or earlier by its owner in
 * the browser with a code emailed to them (`POST /purge`). No agent can do
 * either (ADR 0025).
 *
 * A document goes in two steps. First one transaction confirms it is still in
 * the Trash, and still the caller's or still old enough, and replaces its
 * record with a TOMBSTONE, `{ purgedAt, purgePending }`: no owner, no member,
 * no title, nothing any gate or query keys on. From that moment every read
 * refuses it as a document nobody may read, every write path refuses it, as
 * each refused it while it was in the Trash, and an upload that finished
 * early cannot land. Its fork record goes and its original's fork count drops
 * in the same transaction, so a rerun cannot count it twice. Then everything
 * else is deleted: every subcollection (versions with their threads and
 * comments, trust, viewers, views, acl, events, link grants), its public
 * mirror, every Storage object under `docs/{id}/` (the slash matters: without
 * it `docs/plan` is also `docs/plan-2`), and its live-editing state. Last,
 * `purgePending` goes, and a run that stopped before that is finished by the
 * next daily one.
 *
 * The tombstone stays for good, so the id is never given to another
 * document: a stale link, a fork's lineage or an agent's saved cursor that
 * names it finds nothing, never a stranger's document.
 *
 * A folder's record is deleted outright. Its id is random, never reused, and
 * nothing outside it is keyed by it. What it held is decided per item: what
 * went to the Trash with it and is the purger's goes too; what is someone
 * else's stays in their Trash, to come back at their root; and anything
 * still live inside, which only a race with the Trash itself can leave, goes
 * to its owner's root rather than be stranded under a folder that is gone.
 */

/** Which items a purge may take. */
export interface PurgeScope {
  /** Only this account's own: the browser's early purge. Absent for the daily job, which takes anyone's. */
  ownerUid?: string;
  /** Only what has been in the Trash since this moment or before, epoch ms. */
  trashedBefore?: number;
  /** Only what went to the Trash together, with one folder. */
  batch?: string;
}

function inScope(data: Data, scope: PurgeScope): boolean {
  if (!isTrashed(data)) return false;
  if (scope.ownerUid !== undefined && data.ownerUid !== scope.ownerUid) return false;
  if (scope.batch !== undefined && batchOf(data) !== scope.batch) return false;
  if (scope.trashedBefore !== undefined) {
    const at = trashedAtMs(data);
    if (at === null || at > scope.trashedBefore) return false;
  }
  return true;
}

export type DocumentOutcome = "purged" | "finished" | "skipped";

/**
 * Delete a document forever, when it is in the Trash and in scope. Returns
 * `purged` when this call made the tombstone, `finished` when it completed a
 * purge an earlier call began, and `skipped` when there was nothing to do.
 */
export async function purgeDocument(db: Db, id: string, scope: PurgeScope = {}): Promise<DocumentOutcome> {
  const ref = db.collection("docs").doc(id);
  const step = await db.runTransaction(async (tx): Promise<"tombstoned" | "pending" | "skipped"> => {
    const data = (await tx.get(ref)).data();
    if (!data) return "skipped";
    if (isPurged(data)) return data.purgePending === true ? "pending" : "skipped";
    if (!inScope(data, scope)) return "skipped";
    const fork = await tx.get(db.collection(FORKS).doc(id));
    const parentId = fork.exists ? fork.get("parentId") : null;
    const parent = typeof parentId === "string" && parentId ? await tx.get(db.collection("docs").doc(parentId)) : null;
    // A full overwrite, not a merge: nothing of the record survives but this.
    tx.set(ref, { purgedAt: FieldValue.serverTimestamp(), purgePending: true });
    if (fork.exists) tx.delete(fork.ref);
    const forks = Number((parent?.data()?.stats as { forks?: unknown } | undefined)?.forks ?? 0);
    if (parent?.exists && forks > 0) {
      tx.update(parent.ref, { "stats.forks": FieldValue.increment(-1) });
    }
    return "tombstoned";
  });
  if (step === "skipped") return "skipped";
  await finishDocument(db, ref);
  return step === "tombstoned" ? "purged" : "finished";
}

/**
 * Everything but the tombstone, idempotently, and all at once: none of it
 * depends on the rest, and how fast this goes is how much the daily job
 * reaches before its deadline. `purgePending` goes only once all of it has.
 */
async function finishDocument(db: Db, ref: Ref): Promise<void> {
  const collections = await ref.listCollections();
  await Promise.all([
    ...collections.map((collection) => db.recursiveDelete(collection)),
    db.collection("public").doc(ref.id).delete(),
    admin.storage().bucket(bucketName()).deleteFiles({ prefix: `docs/${ref.id}/` }),
    clearPresence(ref.id),
  ]);
  await ref.update({ purgePending: FieldValue.delete() });
}

export interface FolderOutcome {
  /** Folders deleted, this one included. */
  folders: number;
  /** Documents deleted forever. */
  documents: number;
}

/** A folder's part of the Trash, as one purge of it would find it. */
interface Subtree {
  /** The folders it would delete, parents first: the root, then what went with it. */
  folders: Ref[];
  /** The documents it would delete forever. */
  documents: Ref[];
  /** Documents that went with it but are someone else's, which stay in their Trash. */
  theirs: number;
  /** Anything still out of the Trash inside it, which goes to its owner's root. */
  live: { documents: Ref[]; folders: Ref[] };
}

async function subtreeOf(db: Db, root: Ref, contents: PurgeScope): Promise<Subtree> {
  const tree: Subtree = { folders: [], documents: [], theirs: 0, live: { documents: [], folders: [] } };
  const queue: Ref[] = [root];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const folder = queue.shift() as Ref;
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    tree.folders.push(folder);
    const [docs, children] = await Promise.all([
      db.collection("docs").where("folderId", "==", folder.id).get(),
      db.collection("folders").where("parentId", "==", folder.id).get(),
    ]);
    for (const d of docs.docs) {
      const data = d.data();
      if (!isTrashed(data)) tree.live.documents.push(d.ref);
      else if (inScope(data, contents)) tree.documents.push(d.ref);
      else if (batchOf(data) === contents.batch) tree.theirs += 1;
    }
    for (const child of children.docs) {
      const data = child.data();
      if (!isTrashed(data)) tree.live.folders.push(child.ref);
      else if (inScope(data, contents)) queue.push(child.ref);
    }
  }
  return tree;
}

/** The folder in scope, and the scope of what went with it; null when it is not in scope. */
async function folderInScope(db: Db, id: string, scope: PurgeScope): Promise<{ root: Ref; data: Data; contents: PurgeScope } | null> {
  const root = db.collection("folders").doc(id);
  const data = (await root.get()).data();
  if (!data || !inScope(data, scope)) return null;
  // Everything in the batch went at the same moment, give or take the
  // seconds the walk took, so only the folder itself is held to the date.
  const contents: PurgeScope = { batch: batchOf(data) as string, ownerUid: scope.ownerUid };
  return { root, data, contents };
}

/**
 * Delete a folder forever, when it is in the Trash and in scope, with what
 * went with it that the scope allows: for its owner's early purge, what is
 * theirs; for the daily job, everything in its batch. Null when the folder
 * was not in scope, so nothing was done.
 */
export async function purgeFolder(db: Db, id: string, scope: PurgeScope = {}): Promise<FolderOutcome | null> {
  const found = await folderInScope(db, id, scope);
  if (!found) return null;
  const tree = await subtreeOf(db, found.root, found.contents);
  const counts: FolderOutcome = { folders: 0, documents: 0 };
  for (const ref of tree.live.documents) await persistDocMembership(db, ref, () => ({ folderId: null }));
  for (const ref of tree.live.folders) {
    await persistFolderMembership(db, ref, () => ({ parentId: null }));
    await recomputeSubtree(db, ref.id);
  }
  for (const ref of tree.documents) {
    if ((await purgeDocument(db, ref.id, found.contents)) === "purged") counts.documents += 1;
  }
  // Deepest first, and each only while it is still what was decided on: a
  // folder restored in the meantime is left as its owner now has it.
  for (const folder of [...tree.folders].reverse()) {
    const held = folder.id === id ? scope : found.contents;
    const gone = await db.runTransaction(async (tx) => {
      const snap = await tx.get(folder);
      if (!snap.exists || !inScope(snap.data() as Data, held)) return false;
      tx.delete(folder);
      return true;
    });
    if (!gone) continue;
    for (const collection of await folder.listCollections()) await db.recursiveDelete(collection);
    counts.folders += 1;
  }
  return counts;
}

/** What a purge would take, said before anyone is asked for a code. */
export type PurgeSummary =
  | { kind: "document"; title: string; versions: number }
  | { kind: "folder"; title: string; documents: number; folders: number; theirs: number }
  | { kind: "all"; documents: number; folders: number };

/**
 * What an early purge of `target` would delete, or null when the target is
 * not in this account's Trash. Counted as the purge will find it, so the
 * dialog and the email say what will actually go.
 */
export async function describePurge(db: Db, ownerUid: string, target: PurgeTarget): Promise<PurgeSummary | null> {
  const scope = { ownerUid };
  if ("all" in target) {
    const { docs, folders } = await ownTrash(db, ownerUid);
    return docs.length + folders.length === 0 ? null : { kind: "all", documents: docs.length, folders: folders.length };
  }
  if (target.kind === "document") {
    const ref = db.collection("docs").doc(target.id);
    const data = (await ref.get()).data();
    if (!data || !inScope(data, scope)) return null;
    const versions = (await ref.collection("versions").count().get()).data().count;
    return { kind: "document", title: String(data.title ?? target.id), versions };
  }
  const found = await folderInScope(db, target.id, scope);
  if (!found) return null;
  const tree = await subtreeOf(db, found.root, found.contents);
  return {
    kind: "folder",
    title: String(found.data.name ?? "Untitled folder"),
    documents: tree.documents.length,
    folders: tree.folders.length - 1,
    theirs: tree.theirs,
  };
}

/** One item, or everything: what a code is asked for and confirms. */
export type PurgeTarget = { all: true } | { kind: "document" | "folder"; id: string };

type Snap = admin.firestore.QueryDocumentSnapshot;

/** What one account owns that is in the Trash, by owner uid, so it is right across a change of address. */
export async function ownTrash(db: Db, ownerUid: string): Promise<{ docs: Snap[]; folders: Snap[] }> {
  const [docs, folders] = await Promise.all([
    db.collection("docs").where("ownerUid", "==", ownerUid).get(),
    db.collection("folders").where("ownerUid", "==", ownerUid).get(),
  ]);
  const trashed = (s: Snap) => isTrashed(s.data());
  return { docs: docs.docs.filter(trashed), folders: folders.docs.filter(trashed) };
}

/**
 * Is `target` in this account's Trash? What `describePurge` decides, without
 * counting: a confirm needs only the answer, and the purge walks again anyway.
 */
export async function inOwnTrash(db: Db, ownerUid: string, target: PurgeTarget): Promise<boolean> {
  if ("all" in target) {
    const { docs, folders } = await ownTrash(db, ownerUid);
    return docs.length + folders.length > 0;
  }
  if (target.kind === "folder") return (await folderInScope(db, target.id, { ownerUid })) !== null;
  const data = (await db.collection("docs").doc(target.id).get()).data();
  return !!data && inScope(data, { ownerUid });
}

/** Add what one purge took to a running count. */
function add(into: FolderOutcome, out: FolderOutcome | null): boolean {
  if (!out) return false;
  into.folders += out.folders;
  into.documents += out.documents;
  return true;
}

/** A document's purge as a count: one document, or nothing. */
const one = (outcome: DocumentOutcome): FolderOutcome | null => (outcome === "purged" ? { folders: 0, documents: 1 } : null);

/** An early purge of `target`, which must be in this account's Trash. */
export async function purgeOwn(db: Db, ownerUid: string, target: PurgeTarget): Promise<FolderOutcome> {
  if ("all" in target) return purgeAllOwn(db, ownerUid);
  if (target.kind === "document") return one(await purgeDocument(db, target.id, { ownerUid })) ?? { folders: 0, documents: 0 };
  return (await purgeFolder(db, target.id, { ownerUid })) ?? { folders: 0, documents: 0 };
}

/** Everything in one account's Trash, deleted forever: its folders with what of theirs went with them, then the rest. */
async function purgeAllOwn(db: Db, ownerUid: string): Promise<FolderOutcome> {
  const counts: FolderOutcome = { folders: 0, documents: 0 };
  const scope = { ownerUid };
  for (const f of (await ownTrash(db, ownerUid)).folders) add(counts, await purgeFolder(db, f.id, scope));
  // Read again: the folders took what of theirs went with them.
  for (const d of (await ownTrash(db, ownerUid)).docs) add(counts, one(await purgeDocument(db, d.id, scope)));
  return counts;
}

export interface DailyReport {
  /** Documents deleted forever by this run. */
  documents: number;
  /** Folders deleted by this run. */
  folders: number;
  /** Purges an earlier run began and this one finished. */
  finished: number;
  /** Stopped at its deadline with more to do; the next run carries on. */
  more: boolean;
}

/** How many records the daily job reads at a time. */
const PAGE = 100;

/**
 * The daily job: finish any purge a run left part way, then delete forever
 * everything that has been in the Trash for 30 days, until `deadline`. What
 * it does not reach today it reaches tomorrow; an item a day late is the
 * cost, and the report says so.
 */
/** How long a daily run works before it stops and leaves the rest: well inside its 540 s timeout. */
const DAILY_BUDGET_MS = 8 * 60_000;

export async function purgeExpired(db: Db, now = Date.now(), deadline = now + DAILY_BUDGET_MS): Promise<DailyReport> {
  const report: DailyReport = { documents: 0, folders: 0, finished: 0, more: false };
  const late = () => Date.now() > deadline;
  const pending = await db.collection("docs").where("purgePending", "==", true).limit(PAGE).get();
  for (const d of pending.docs) {
    if (late()) return { ...report, more: true };
    if ((await purgeDocument(db, d.id)) === "finished") report.finished += 1;
  }
  const scope = { trashedBefore: now - TRASH_RETENTION_MS };
  const cutoff = Timestamp.fromMillis(scope.trashedBefore);
  const purgers = [
    ["docs", async (id: string) => one(await purgeDocument(db, id, scope))],
    ["folders", (id: string) => purgeFolder(db, id, scope)],
  ] as const;
  for (const [kind, purge] of purgers) {
    for (;;) {
      const page = await db.collection(kind).where("trashed.at", "<=", cutoff).limit(PAGE).get();
      let progressed = false;
      for (const item of page.docs) {
        if (late()) return { ...report, more: true };
        if (add(report, await purge(item.id))) progressed = true;
      }
      // A page that took nothing would be read again forever.
      if (page.docs.length < PAGE || !progressed) break;
    }
  }
  return report;
}
