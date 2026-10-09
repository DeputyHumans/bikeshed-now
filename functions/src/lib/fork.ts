// SPDX-License-Identifier: Apache-2.0
// Forks: a copy the caller owns, and a lineage only its readers may follow (SPEC §21).

/**
 * Why the parent is not named on the fork's own record
 * ----------------------------------------------------
 * Every member of a fork reads `docs/{forkId}` directly, and a docId is the
 * slug of the title its document was first published under. A pointer there
 * would hand the original's address — and so, near enough, its first title —
 * to everybody the fork is later shared with, including people who hold no link
 * to an unlisted original. That is the leak SPEC §17 exists to prevent.
 *
 * So the pointer lives in `forks/{forkId}`, which no client can read or write,
 * and the record itself says only `forked: true`. Lineage is answered here,
 * one hop at a time, and each hop is told only to a caller who could open it.
 *
 * The pointer pins the parent's content hash as well as its version id,
 * because a withdrawn version's id is re-minted by the next commit (SPEC §4):
 * the id alone can come to name different bytes.
 */

import { addEvent } from "./events";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import {
  canManageSharing,
  canRead,
  expiredForReader,
  isMember,
  visibilityOf,
  type DocAclData,
  type Visibility,
} from "./acl";
import type { Actor } from "./actor";
import { emptyGrants } from "./access";
import { computeDocMembership, resolveFolderTarget, slugify } from "./folders";
import { safeSegment } from "./http";
import { linkProofFor } from "./linkgrant";
import { resolveMarking } from "./marking";
import { syncPresenceAccess } from "./presence";
import { CREATE_ONLY, placeNewDocument } from "./publish";

type Db = admin.firestore.Firestore;
type Caller = { uid: string; emailLower: string };
type Stored = DocAclData & Record<string, unknown>;

/** The server-only collection a fork's parent is recorded in. */
export const FORKS = "forks";

/**
 * How far up a lineage is walked. Nothing can make a cycle — a parent exists
 * before its fork, and a fork's record is written once — so this bounds the
 * cost of one request, not a loop.
 */
export const MAX_LINEAGE_HOPS = 20;

/** The same limit a rename has. */
const MAX_TITLE = 200;

/** The part of a Storage bucket a fork uses, so a test can stand in for it. */
export interface ForkBucket {
  getFiles(query: { prefix: string }): Promise<
    [Array<{ name: string; copy(destination: string, options: typeof CREATE_ONLY): Promise<unknown> }>, ...unknown[]]
  >;
}

export type Refusal = {
  ok: false;
  status: 400 | 403 | 404 | 409;
  error: string;
  /**
   * A refused READ. It must be answered exactly as an id that does not exist —
   * a bare 404 — so the caller cannot tell "not yours" from "not there"
   * (SPEC §1.4b). Every other refusal is about the request, and says why.
   */
  unreadable?: true;
};

const NOT_FOUND: Refusal = { ok: false, status: 404, error: "not found", unreadable: true };

function refuse(status: Refusal["status"], error: string): Refusal {
  return { ok: false, status, error };
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v ? v : fallback;
}

function millis(v: unknown): number | null {
  const toMillis = (v as { toMillis?: () => number } | null)?.toMillis;
  return typeof toMillis === "function" ? toMillis.call(v) : null;
}

/**
 * The document, if this caller may read it now; null otherwise, which every
 * caller answers exactly as for an id that does not exist (SPEC §1.4b).
 */
async function openReadable(
  db: Db,
  docId: string,
  caller: Caller,
  k: string | null,
): Promise<{ ref: admin.firestore.DocumentReference; data: Stored } | null> {
  if (!safeSegment(docId)) return null;
  const ref = db.collection("docs").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as Stored;
  const proof = await linkProofFor(ref, data, caller, k);
  if (!canRead(data, caller, proof)) return null;
  // Forking reads every byte, so it is a read path: without this, copying an
  // expired document would get its content back out from behind the date.
  if (expiredForReader(data, caller)) return null;
  return { ref, data };
}

// --- Forking -----------------------------------------------------------------

export interface ForkInput {
  db: Db;
  bucket: ForkBucket;
  caller: Caller;
  actor: Actor;
  sourceId: string;
  /** An unlisted source's key, for a caller who holds no link grant. */
  k?: string | null;
  /** Which version to copy. Absent means current. */
  versionId?: string | null;
  folderId?: unknown;
  /** Absent means the original's title. */
  title?: unknown;
}

export interface ForkResult {
  ok: true;
  docId: string;
  versionId: string;
  title: string;
}

/**
 * Copy one version of a document the caller can read into a new one they own.
 *
 * The fork is `trusted: false` even when its source was trusted: otherwise
 * forking a trusted deck, editing it and re-publishing would launder arbitrary
 * script into a document with somebody else's trust decision attached
 * (ADR 0002).
 *
 * Everything the fork is made of is committed in ONE batch — its record, its
 * v1, the server-only pointer and the original's fork count — so the count can
 * never disagree with the forks that exist.
 */
export async function forkDocument(input: ForkInput): Promise<ForkResult | Refusal> {
  const { db, caller } = input;
  if (!input.sourceId || !safeSegment(input.sourceId)) {
    return refuse(400, "invalid or missing docId");
  }
  const wantedTitle = typeof input.title === "string" ? input.title.trim() : "";
  if (wantedTitle.length > MAX_TITLE) {
    return refuse(400, `title is up to ${MAX_TITLE} characters`);
  }

  const source = await openReadable(db, input.sourceId, caller, input.k ?? null);
  if (!source) return NOT_FOUND;
  const { ref: srcRef, data: src } = source;

  const asked = typeof input.versionId === "string" ? input.versionId.trim() : "";
  const versionId = asked || str(src.currentVersion, "");
  if (!versionId || !safeSegment(versionId)) {
    return refuse(409, "the source document has no published version");
  }
  const vSnap = await srcRef.collection("versions").doc(versionId).get();
  if (!vSnap.exists) return refuse(409, `the source has no version ${versionId}`);
  const v = vSnap.data() || {};

  const target = await resolveFolderTarget(db, input.folderId, caller);
  if (!target.ok) return refuse(target.status, target.error);

  const srcPrefix = `docs/${input.sourceId}/${versionId}/`;
  const [listed] = await input.bucket.getFiles({ prefix: srcPrefix });
  const objects = listed.filter((obj) => {
    const rel = obj.name.slice(srcPrefix.length);
    return rel.length > 0 && !rel.endsWith("/");
  });
  if (objects.length === 0) return refuse(409, "the source has no content to copy");

  const title = wantedTitle || str(src.title, "Untitled");
  const { docId, storagePrefix } = await placeNewDocument(db, slugify(title), async (prefix) => {
    for (const obj of objects) {
      await obj.copy(`${prefix}/${obj.name.slice(srcPrefix.length)}`, CREATE_ONLY);
    }
  });

  // The fork's export marking is its NEW owner's policy, seeded from their
  // account default as every new document's is (SPEC §20) — read here rather
  // than sent, so a one-click fork from any surface seeds it the same way.
  const account = await db.collection("users").doc(caller.uid).get();
  const marking = resolveMarking(account.exists ? account.get("defaultMarking") : null);

  const membership = computeDocMembership(caller.emailLower, emptyGrants(), target.membership);
  const now = () => FieldValue.serverTimestamp();
  const forkRef = db.collection("docs").doc(docId);
  const batch = db.batch();
  batch.create(forkRef, {
    docId,
    title,
    slug: slugify(title),
    ownerUid: caller.uid,
    ownerEmail: caller.emailLower,
    currentVersion: "v1",
    ...emptyGrants(),
    ...membership,
    folderId: target.id,
    visibility: "private",
    publicEdit: false,
    trusted: false,
    forked: true,
    marking,
    createdAt: now(),
    updatedAt: now(),
  });
  batch.create(forkRef.collection("versions").doc("v1"), {
    versionId: "v1",
    label: "v1",
    entry: str(v.entry, "index.html"),
    format: v.format === "markdown" ? "markdown" : "html",
    ...(typeof v.sourceEntry === "string" ? { sourceEntry: v.sourceEntry } : {}),
    ...(typeof v.rendererVersion === "string" ? { rendererVersion: v.rendererVersion } : {}),
    storagePrefix,
    fileCount: typeof v.fileCount === "number" ? v.fileCount : objects.length,
    bytes: typeof v.bytes === "number" ? v.bytes : 0,
    contentHash: str(v.contentHash, ""),
    ...(Array.isArray(v.files) ? { files: v.files } : {}),
    parentVersion: null,
    publishedVia: "fork",
    publishedByEmail: caller.emailLower,
    publishedBy: input.actor,
    publishedAt: now(),
  });
  batch.create(db.collection(FORKS).doc(docId), {
    parentId: input.sourceId,
    parentVersion: versionId,
    parentContentHash: str(v.contentHash, ""),
    forkedAt: now(),
  });
  // A nested map under merge, as every stats writer does, so this cannot
  // clobber the view counters; and no `updatedAt`, which means "published".
  batch.set(srcRef, { stats: { forks: FieldValue.increment(1) } }, { merge: true });
  // On the ORIGINAL's log, for its owner only, with no actor: who forked a
  // document is never told to its author (SPEC §21).
  addEvent(batch, srcRef, { type: "fork.created", audience: "owner" });
  await batch.commit();

  await syncPresenceAccess(docId, membership.members, membership.editorMembers);
  return { ok: true, docId, versionId: "v1", title };
}

// --- Lineage -----------------------------------------------------------------

export interface Ancestor {
  docId: string;
  title: string;
  /** The parent's version the fork was made from. */
  versionId: string;
  /** Only to a member of that ancestor, who could read it off its record anyway. */
  ownerEmail?: string;
  /** First hop only: the parent's current content is not what was forked. */
  changed?: boolean;
}

export interface ForkListing {
  docId: string;
  title: string;
  visibility: Visibility;
  forkedAt: number | null;
  ownerEmail?: string;
}

export interface Lineage {
  forked: boolean;
  ancestors: Ancestor[];
  /** The walk stopped at a parent the caller cannot open. */
  hiddenAncestor: boolean;
  /** The owner's inventory. Absent for everyone else. */
  forks?: { total: number; hidden: number; visible: ForkListing[] };
}

/**
 * Where a document came from, as far as this caller may see, and — for its
 * owner — what has been made from it.
 *
 * The walk STOPS at the first parent the caller cannot open rather than
 * skipping it. Skipping would tell them which document an unreadable one came
 * from, which is a fact about a document they were never shown.
 *
 * A link key opens only the document it was presented for. A parent is
 * readable through membership, public visibility or a link grant the caller
 * already holds, never through the child's key.
 */
export async function lineageFor(input: {
  db: Db;
  caller: Caller;
  docId: string;
  k?: string | null;
}): Promise<{ ok: true; lineage: Lineage } | Refusal> {
  const { db, caller } = input;
  const doc = await openReadable(db, input.docId, caller, input.k ?? null);
  if (!doc) return NOT_FOUND;

  const ancestors: Ancestor[] = [];
  let hiddenAncestor = false;
  let childId = input.docId;
  for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop++) {
    const rec = await db.collection(FORKS).doc(childId).get();
    if (!rec.exists) break;
    const parentId = rec.get("parentId");
    const parent =
      typeof parentId === "string" ? await openReadable(db, parentId, caller, null) : null;
    if (!parent) {
      hiddenAncestor = true;
      break;
    }
    const entry: Ancestor = {
      docId: parent.ref.id,
      title: str(parent.data.title, "Untitled"),
      versionId: str(rec.get("parentVersion"), ""),
    };
    if (isMember(parent.data, caller.uid, caller.emailLower) && typeof parent.data.ownerEmail === "string") {
      entry.ownerEmail = parent.data.ownerEmail;
    }
    if (hop === 0) {
      const changed = await changedSince(parent.ref, parent.data, rec.get("parentContentHash"));
      if (changed !== null) entry.changed = changed;
    }
    ancestors.push(entry);
    childId = parent.ref.id;
  }

  const lineage: Lineage = { forked: doc.data.forked === true, ancestors, hiddenAncestor };
  if (canManageSharing(doc.data, caller.emailLower)) {
    lineage.forks = await forksOf(db, input.docId, caller);
  }
  return { ok: true, lineage };
}

/**
 * Has the parent moved on from what was forked? Null when either side has no
 * hash to compare — a version written before hashes were recorded — because
 * "unknown" must not be reported as either answer.
 */
async function changedSince(
  ref: admin.firestore.DocumentReference,
  data: Stored,
  recorded: unknown,
): Promise<boolean | null> {
  if (typeof recorded !== "string" || !recorded) return null;
  const current = str(data.currentVersion, "");
  if (!current || !safeSegment(current)) return null;
  const v = await ref.collection("versions").doc(current).get();
  const hash = v.exists ? v.get("contentHash") : null;
  if (typeof hash !== "string" || !hash) return null;
  return hash !== recorded;
}

/**
 * Every fork made from this document: all of them counted, the ones the owner
 * can open listed.
 *
 * "Can open" is the same `canRead` the content proxy uses, so an unlisted fork
 * appears only to an owner who holds its link grant, and an expired one not at
 * all. A fork's owner is named only where the original's owner is a member of
 * that fork and could read the name off its record anyway.
 *
 * Costs N+1 reads plus a grant read per unlisted fork, on demand, with no
 * write. Past a few hundred forks a paginated panel is the fix (SPEC §21).
 */
async function forksOf(
  db: Db,
  docId: string,
  caller: Caller,
): Promise<{ total: number; hidden: number; visible: ForkListing[] }> {
  const recs = (await db.collection(FORKS).where("parentId", "==", docId).get()).docs;
  const forkedAt = new Map(recs.map((r) => [r.id, millis(r.get("forkedAt"))]));
  const visible: ForkListing[] = [];
  for (let i = 0; i < recs.length; i += 100) {
    const refs = recs.slice(i, i + 100).map((r) => db.collection("docs").doc(r.id));
    for (const snap of await db.getAll(...refs)) {
      if (!snap.exists) continue;
      const data = snap.data() as Stored;
      const proof = await linkProofFor(snap.ref, data, caller, null);
      if (!canRead(data, caller, proof) || expiredForReader(data, caller)) continue;
      const listing: ForkListing = {
        docId: snap.id,
        title: str(data.title, "Untitled"),
        visibility: visibilityOf(data),
        forkedAt: forkedAt.get(snap.id) ?? null,
      };
      if (isMember(data, caller.uid, caller.emailLower) && typeof data.ownerEmail === "string") {
        listing.ownerEmail = data.ownerEmail;
      }
      visible.push(listing);
    }
  }
  visible.sort((a, b) => (b.forkedAt ?? 0) - (a.forkedAt ?? 0));
  return { total: recs.length, hidden: recs.length - visible.length, visible };
}
