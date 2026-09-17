// SPDX-License-Identifier: Apache-2.0
// The world-readable projection of a non-private document (SPEC §17).

import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { visibilityOf, type DocAclData } from "./acl";

type Db = admin.firestore.Firestore;

/**
 * Why a projection and not a rules exception
 * ------------------------------------------
 * Firestore rules cannot project fields. "Allow an anonymous `get` when the
 * document is public" would therefore hand the world `members`, `viewers`,
 * `ownerEmail` and the full reading statistics — the entire ACL of a document
 * whose owner only meant to share the text.
 *
 * So a non-private document is MIRRORED here, carrying only what a reader needs
 * to render it, and the `docs/{docId}` rule is left exactly as it was. One new
 * collection, and no exception carved into the rule that protects everything
 * else.
 *
 * The mirror is deleted the instant visibility returns to private. That is the
 * whole revocation path, and it is why this function is called from every place
 * that can change visibility or membership rather than from the one endpoint
 * that obviously changes it.
 */
export interface PublicDoc {
  docId: string;
  title: string;
  slug: string;
  currentVersion: string;
  entry: string;
  format: "html" | "markdown";
  visibility: "unlisted" | "public";
  publicEdit: boolean;
  /** Needed so an anonymous reader's iframe is sandboxed the same way (SPEC §6c). */
  trusted: boolean;
  publishedAt: admin.firestore.Timestamp | FieldValue | null;
}

/** Fields that may appear in the projection. Anything else is a leak. */
const PROJECTED_KEYS: readonly (keyof PublicDoc)[] = [
  "docId",
  "title",
  "slug",
  "currentVersion",
  "entry",
  "format",
  "visibility",
  "publicEdit",
  "trusted",
  "publishedAt",
];

/**
 * Build the projection from a stored document. Exported so a test can assert
 * the output keys exactly, which is the check that actually prevents a leak: a
 * future field added to DocMeta must not silently ride along.
 */
export function projectPublicDoc(
  docId: string,
  data: Record<string, unknown>,
): PublicDoc | null {
  const visibility = visibilityOf(data as DocAclData);
  if (visibility === "private") return null;
  const projection: PublicDoc = {
    docId,
    title: typeof data.title === "string" ? data.title : "Untitled",
    slug: typeof data.slug === "string" ? data.slug : docId,
    currentVersion:
      typeof data.currentVersion === "string" ? data.currentVersion : "",
    entry: typeof data.entry === "string" ? data.entry : "index.html",
    format: data.format === "markdown" ? "markdown" : "html",
    visibility,
    publicEdit: data.publicEdit === true,
    trusted: data.trusted !== false,
    publishedAt:
      (data.updatedAt as admin.firestore.Timestamp | undefined) ??
      (data.createdAt as admin.firestore.Timestamp | undefined) ??
      null,
  };
  // Defensive: the type says these are the only keys, but the type is erased at
  // runtime and this object is world-readable.
  for (const key of Object.keys(projection)) {
    if (!PROJECTED_KEYS.includes(key as keyof PublicDoc)) {
      delete (projection as unknown as Record<string, unknown>)[key];
    }
  }
  return projection;
}

/**
 * Bring `public/{docId}` into line with the document's current visibility:
 * write the projection, or delete it. Idempotent, and safe to call after any
 * write to the document.
 */
export async function syncPublicProjection(db: Db, docId: string): Promise<void> {
  const docRef = db.collection("docs").doc(docId);
  const publicRef = db.collection("public").doc(docId);
  const snap = await docRef.get();
  if (!snap.exists) {
    await publicRef.delete();
    return;
  }
  const data = snap.data() || {};
  // `entry` lives on the version, not the document, so fetch it alongside.
  const versionId =
    typeof data.currentVersion === "string" ? data.currentVersion : "";
  let entry = "index.html";
  let format: "html" | "markdown" = "html";
  if (versionId) {
    const vSnap = await docRef.collection("versions").doc(versionId).get();
    if (vSnap.exists) {
      const v = vSnap.data() || {};
      if (typeof v.entry === "string") entry = v.entry;
      if (v.format === "markdown") format = "markdown";
    }
  }
  const projection = projectPublicDoc(docId, { ...data, entry, format });
  if (!projection) {
    await publicRef.delete();
    return;
  }
  await publicRef.set(projection);
}
