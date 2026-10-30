// SPDX-License-Identifier: Apache-2.0
// What a folder's link or public level lets a stranger read beneath it (SPEC §13, §17).

/**
 * The decisions are pure and live in `lib/acl.ts`; this is the part that has
 * to read Firestore. A document's own basis is always tried first, and its
 * folder is read only when that fails, so a member's or a public document's
 * read costs nothing new.
 */

import * as admin from "firebase-admin";
import {
  folderAccess,
  isFrozen,
  isTrashed,
  latestEnd,
  openedReach,
  readAccess,
  readBasis,
  type DocAclData,
  type FolderAclData,
  type LinkProof,
  type ReadAccess,
} from "./acl";
import { safeSegment } from "./http";
import { readThumb } from "./thumbs";
import { summaryOf } from "./latest";

type Db = admin.firestore.Firestore;
type Caller = { uid: string; emailLower: string } | null;

/** The record of the folder a document is filed in, or null. */
export async function folderOfDoc(db: Db, doc: DocAclData, tx?: admin.firestore.Transaction): Promise<FolderAclData | null> {
  const id = typeof doc.folderId === "string" ? doc.folderId : "";
  if (!id || !safeSegment(id)) return null;
  const ref = db.collection("folders").doc(id);
  const snap = tx ? await tx.get(ref) : await ref.get();
  return snap.exists ? (snap.data() as FolderAclData) : null;
}

/**
 * `readAccess`, paying for the folder read only when the document's own basis
 * has already said no. For READ paths only (see `readAccess`).
 */
export async function loadReadAccess(
  db: Db,
  doc: DocAclData,
  caller: Caller,
  proof: LinkProof,
  nowMs: number = Date.now(),
): Promise<ReadAccess | null> {
  const own = readBasis(doc, caller, proof);
  if (own !== null) return { basis: own, until: null };
  return readAccess(doc, caller, proof, await folderOfDoc(db, doc), nowMs);
}

/** At most this many folders and this many documents per answer. */
export const REACH_LIST_CAP = 500;

export interface ReachedDocument {
  docId: string;
  title: string;
  currentVersion: string;
  /** When its current version was published (lib/latest.ts), else when the record last changed. */
  updatedAt: number | null;
  /** The current version's word count, for its reading time; null until counted. */
  words: number | null;
  /** The stored cover, when the document has one: `/thumb/~k/{docId}/{versionId}/{key}/cover.jpg`. */
  cover: { versionId: string; key: string } | null;
}

/** One level of a folder, as a stranger holding its link (or none, if public) sees it. */
export interface ReachedFolder {
  folderId: string;
  name: string;
  /** What opened it, and when that ends. */
  visibility: "unlisted" | "public";
  expiresAt: number | null;
  /** From the outermost folder this request opens down to this one, inclusive. */
  path: { folderId: string; name: string }[];
  folders: { folderId: string; name: string }[];
  documents: ReachedDocument[];
  /** More than `REACH_LIST_CAP` folders or documents, and some were left out. */
  truncated: boolean;
}

export type ReachListing =
  | { open: ReachedFolder }
  /** The key matched, or the folder was public, but its date has passed. */
  | { ended: { folderId: string; name: string; expiresAt: number | null } }
  | null;

const str = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);

function millis(v: unknown): number | null {
  const toMillis = (v as { toMillis?: () => number } | null)?.toMillis;
  return typeof toMillis === "function" ? toMillis.call(v) : null;
}

/**
 * What one folder holds, for a request whose only claim is the folder's reach.
 *
 * Null — one identical refusal — for an absent folder, a private one, a wrong
 * key and a rotated one. A key that matched, or a public level, whose date has
 * passed is told so, as a reader of an expired document is (SPEC §17).
 * Documents whose own expiry has passed, and anything in the Trash, are left
 * out: they are their owner's alone, and a stranger is not shown that they
 * exist.
 */
export async function listReach(
  db: Db,
  folderId: string,
  k: string | null,
  nowMs: number = Date.now(),
): Promise<ReachListing> {
  if (!folderId || !safeSegment(folderId)) return null;
  const ref = db.collection("folders").doc(folderId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const folder = snap.data() as FolderAclData & Record<string, unknown>;
  // A trashed folder has no reach once the cascade has rewritten it
  // (computeReach); this refuses it in the moment before that lands.
  if (isTrashed(folder)) return null;
  const name = str(folder.name, "Untitled folder");

  const access = folderAccess(folder, k, nowMs);
  if (!access) {
    const ended = openedReach(folder, k, nowMs, true);
    if (ended.length === 0) return null;
    return { ended: { folderId, name, expiresAt: latestEnd(ended) } };
  }

  const opened = openedReach(folder, k, nowMs);
  const chain = [
    ...(Array.isArray(folder.ancestors) ? (folder.ancestors as unknown[]).filter((a): a is string => typeof a === "string") : []),
    folderId,
  ];
  const rootAt = chain.indexOf(opened[0].folderId);
  const pathIds = rootAt < 0 ? [folderId] : chain.slice(rootAt);
  const above = pathIds.slice(0, -1);
  const names = new Map<string, string>([[folderId, name]]);
  if (above.length) {
    for (const s of await db.getAll(...above.map((id) => db.collection("folders").doc(id)))) {
      if (s.exists) names.set(s.id, str(s.data()?.name, "Untitled folder"));
    }
  }

  const [childSnaps, docSnaps] = await Promise.all([
    db.collection("folders").where("parentId", "==", folderId).limit(REACH_LIST_CAP + 1).get(),
    db.collection("docs").where("folderId", "==", folderId).limit(REACH_LIST_CAP + 1).get(),
  ]);
  const folders = childSnaps.docs.slice(0, REACH_LIST_CAP).filter((s) => !isTrashed(s.data())).map((s) => ({
    folderId: s.id,
    name: str(s.data()?.name, "Untitled folder"),
  }));
  const documents: ReachedDocument[] = [];
  for (const s of docSnaps.docs.slice(0, REACH_LIST_CAP)) {
    const d = s.data() || {};
    if (isFrozen(d as DocAclData, nowMs)) continue;
    const thumb = readThumb(d.thumb);
    const summary = summaryOf(d);
    documents.push({
      docId: s.id,
      title: str(d.title, "Untitled"),
      currentVersion: str(d.currentVersion, ""),
      updatedAt: millis(summary.at),
      words: summary.words,
      cover: thumb?.cover ? { versionId: thumb.versionId, key: thumb.cover } : null,
    });
  }

  return {
    open: {
      folderId,
      name,
      visibility: access.basis === "folder-public" ? "public" : "unlisted",
      expiresAt: access.until,
      path: pathIds.filter((id) => names.has(id)).map((id) => ({ folderId: id, name: names.get(id)! })),
      folders,
      documents,
      truncated: childSnaps.size > REACH_LIST_CAP || docSnaps.size > REACH_LIST_CAP,
    },
  };
}

