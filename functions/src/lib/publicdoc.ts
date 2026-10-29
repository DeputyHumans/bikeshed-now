// SPDX-License-Identifier: Apache-2.0
// The world-readable projection of a public document, and what a reader is told (SPEC §17).

import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { earlierEnd, expiryMs, folderAccess, visibilityOf, type DocAclData, type ReadAccess } from "./acl";
import { folderOfDoc } from "./reach";
import { resolveMarking, type Marking } from "./marking";

type Db = admin.firestore.Firestore;

/**
 * Why a projection and not a rules exception
 * ------------------------------------------
 * Firestore rules cannot project fields. "Allow an anonymous `get` when the
 * document is public" would therefore hand the world `members`, `viewers`,
 * `ownerEmail` and the full reading statistics — the entire ACL of a document
 * whose owner only meant to share the text.
 *
 * So a PUBLIC document is MIRRORED here, carrying only what a reader needs to
 * render it, and the `docs/{docId}` rule is left exactly as it was. One new
 * collection, and no exception carved into the rule that protects everything
 * else.
 *
 * An UNLISTED document is not mirrored. Anything here is readable by anyone who
 * knows an id, and an unlisted document's title — even the fact that it exists
 * — belongs to the holders of its link. They get the same reader shape from
 * POST /unlock, which checks the key (SPEC §17).
 *
 * The mirror is deleted the instant visibility stops being public. That is the
 * whole revocation path, and it is why this function is called from every place
 * that can change visibility or membership rather than from the one endpoint
 * that obviously changes it.
 *
 * A document filed under a PUBLIC FOLDER is public too, whatever its own level,
 * so it is mirrored the same way, marked `viaFolder` (SPEC §13, §17). The folder
 * cascade calls this for every document beneath a folder whose reach changed.
 */
export interface ReaderDoc {
  docId: string;
  title: string;
  slug: string;
  currentVersion: string;
  /** Generation for authorized live editors; no session identity is exposed. */
  liveEpoch: string;
  entry: string;
  format: "html" | "markdown";
  /** Download choices for this version, without exposing its private record. */
  sourceEntry: string | null;
  fileCount: number;
  visibility: "unlisted" | "public";
  publicEdit: boolean;
  /** Needed so an anonymous reader's iframe is sandboxed the same way (SPEC §6c). */
  trusted: boolean;
  /** The owner's export policy is the same for members and other readers (SPEC §20). */
  marking: Marking;
  /**
   * Epoch milliseconds, or null. Carried so an anonymous reader is TOLD the
   * document expired rather than shown an empty frame.
   *
   * Nothing deletes this projection when the moment arrives — there is no
   * scheduler here, by decision — so the projection describes an expiry rather
   * than disappearing at one, and `contentProxy` is what actually stops serving
   * the bytes. A title outliving its content is the honest cost of having no
   * cron, and it is stated in SPEC §17 rather than discovered.
   */
  expiresAt: number | null;
  /**
   * The reader's access comes from a folder's link or public level, not from
   * the document's own. Such a reader is read-only: no comments, no presence,
   * no editing, so the viewer offers none of them (ADR 0019). `expiresAt` is
   * then when THEIR access ends — the earlier of the document's own expiry and
   * the folder's — and `visibility` the level that reaches them.
   */
  viaFolder: boolean;
  /**
   * That this document was forked from another, and NOTHING about which one.
   * Enough for a reader's viewer to know a lineage is worth asking for; the
   * parent itself is answered per caller by `POST /fork`, never mirrored
   * (SPEC §21).
   */
  forked: boolean;
}

/** The mirror in `public/{docId}`: the reader shape plus when it was published. */
export interface PublicDoc extends ReaderDoc {
  visibility: "public";
  publishedAt: admin.firestore.Timestamp | FieldValue | null;
}

/** Fields a reader may be handed. Anything else is a leak. */
const READER_KEYS: readonly (keyof ReaderDoc)[] = [
  "docId",
  "title",
  "slug",
  "currentVersion",
  "liveEpoch",
  "entry",
  "format",
  "sourceEntry",
  "fileCount",
  "visibility",
  "publicEdit",
  "trusted",
  "marking",
  "expiresAt",
  "viaFolder",
  "forked",
];

/** Fields that may appear in the world-readable projection. */
const PROJECTED_KEYS: readonly (keyof PublicDoc)[] = [...READER_KEYS, "publishedAt"];

/**
 * Strip anything not on the list. The types say the object has only these keys,
 * but types are erased at runtime and these objects leave the server.
 */
function only<T extends object>(obj: T, keys: readonly (keyof T)[]): T {
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key as keyof T)) {
      delete (obj as Record<string, unknown>)[key];
    }
  }
  return obj;
}

/** A folder's reach, as the projection describes it: the level, and its end. */
export interface FolderReach {
  visibility: "unlisted" | "public";
  until: number | null;
}

/** The folder reach a read access stands for, or null for the document's own bases. */
export function reachOfAccess(access: ReadAccess | null): FolderReach | null {
  if (access?.basis === "folder-public") return { visibility: "public", until: access.until };
  if (access?.basis === "folder-link") return { visibility: "unlisted", until: access.until };
  return null;
}

/**
 * What a reader of a non-private document is told about it: the render fields,
 * nothing about who shares or reads it. Null for a private document, unless a
 * folder's reach is what opened it. Exported so a test can assert the output
 * keys exactly, which is the check that actually prevents a leak: a future
 * field added to DocMeta must not silently ride along.
 */
export function projectReader(
  docId: string,
  data: Record<string, unknown>,
  reach: FolderReach | null = null,
): ReaderDoc | null {
  const visibility = reach ? reach.visibility : visibilityOf(data as DocAclData);
  if (visibility === "private") return null;
  const ownExpiry = expiryMs(data as DocAclData);
  return only<ReaderDoc>(
    {
      docId,
      title: typeof data.title === "string" ? data.title : "Untitled",
      slug: typeof data.slug === "string" ? data.slug : docId,
      currentVersion:
        typeof data.currentVersion === "string" ? data.currentVersion : "",
      liveEpoch: typeof data.liveEpoch === "string" ? data.liveEpoch : "initial",
      entry: typeof data.entry === "string" ? data.entry : "index.html",
      format: data.format === "markdown" ? "markdown" : "html",
      sourceEntry: typeof data.sourceEntry === "string" ? data.sourceEntry : null,
      fileCount: typeof data.fileCount === "number" && Number.isSafeInteger(data.fileCount) && data.fileCount > 0 ? data.fileCount : 1,
      visibility,
      // Open editing is the document's own setting for its own readers, and
      // never reaches anyone through a folder.
      publicEdit: !reach && data.publicEdit === true,
      // Only `true` is trust (ADR 0021); an absent flag fails closed.
      trusted: data.trusted === true,
      marking: resolveMarking(data.marking),
      expiresAt: reach ? earlierEnd(ownExpiry, reach.until) : ownExpiry,
      viaFolder: reach !== null,
      forked: data.forked === true,
    },
    READER_KEYS,
  );
}

/**
 * The world-readable mirror of a PUBLIC document — its own level, or a public
 * folder's reach — and null for any other.
 */
export function projectPublicDoc(
  docId: string,
  data: Record<string, unknown>,
  reach: FolderReach | null = null,
): PublicDoc | null {
  const own = visibilityOf(data as DocAclData) === "public";
  if (!own && reach?.visibility !== "public") return null;
  const reader = projectReader(docId, data, own ? null : reach);
  if (!reader) return null;
  return only<PublicDoc>(
    {
      ...reader,
      visibility: "public",
      publishedAt:
        (data.updatedAt as admin.firestore.Timestamp | undefined) ??
        (data.createdAt as admin.firestore.Timestamp | undefined) ??
        null,
    },
    PROJECTED_KEYS,
  );
}

/**
 * The stored document with its current version's `entry` and `format` folded
 * in. Those live on the version, not the document, so they are fetched here.
 */
async function withVersionFields(
  docRef: admin.firestore.DocumentReference,
  data: Record<string, unknown>,
  tx?: admin.firestore.Transaction,
): Promise<Record<string, unknown>> {
  const versionId =
    typeof data.currentVersion === "string" ? data.currentVersion : "";
  let entry = "index.html";
  let format: "html" | "markdown" = "html";
  let sourceEntry: string | null = null;
  let fileCount = 1;
  if (versionId) {
    const versionRef = docRef.collection("versions").doc(versionId);
    const vSnap = tx ? await tx.get(versionRef) : await versionRef.get();
    if (vSnap.exists) {
      const v = vSnap.data() || {};
      if (typeof v.entry === "string") entry = v.entry;
      if (v.format === "markdown") format = "markdown";
      if (typeof v.sourceEntry === "string") sourceEntry = v.sourceEntry;
      if (Number.isSafeInteger(v.fileCount) && v.fileCount > 0) fileCount = v.fileCount;
    }
  }
  return { ...data, entry, format, sourceEntry, fileCount };
}

/** The reader projection of a stored document, as POST /unlock returns it. */
export async function readerProjection(
  docRef: admin.firestore.DocumentReference,
  data: Record<string, unknown>,
  access: ReadAccess | null = null,
): Promise<ReaderDoc | null> {
  return projectReader(docRef.id, await withVersionFields(docRef, data), reachOfAccess(access));
}

/**
 * Bring `public/{docId}` into line with the document's current visibility and
 * its folder's reach: write the projection, or delete it. Idempotent, and safe
 * to call after any write to the document.
 */
export async function syncPublicProjection(db: Db, docId: string): Promise<void> {
  const docRef = db.collection("docs").doc(docId);
  const publicRef = db.collection("public").doc(docId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const data = snap.data() || {};
    const reach = visibilityOf(data as DocAclData) === "public" ? null
      : reachOfAccess(folderAccess(await folderOfDoc(db, data as DocAclData, tx), null, Date.now()));
    const projection = snap.exists && (visibilityOf(data as DocAclData) === "public" || reach?.visibility === "public")
      ? projectPublicDoc(docId, await withVersionFields(docRef, data, tx), reach)
      : null;
    if (projection) tx.set(publicRef, projection);
    else tx.delete(publicRef);
  });
}
