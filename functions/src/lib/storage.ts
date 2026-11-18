// SPDX-License-Identifier: Apache-2.0
// Where a version's bytes are: its own prefix (older versions) or the document's stored files (SPEC §2, §4, §6a).

import { randomUUID } from "node:crypto";
import { safeBundleRelPath } from "./bundle";
import { safeRelPath, safeSegment } from "./http";

/**
 * Two layouts, read for ever (SPEC §4, ADR 0036).
 *
 *   - **Prefix.** Versions minted before stored files each own a prefix,
 *     `docs/{id}/{versionId}`, `docs/{id}/v1` or `docs/{id}/bundles/{uuid}`,
 *     holding a full copy of every file at its path.
 *   - **Stored files.** Every later version names its files in its record,
 *     `files`, `hashes` and `sizes` in one order, and each file's bytes are
 *     stored ONCE for the whole document at `docs/{id}/blobs/{sha256}`. A file
 *     unchanged between versions is the same object; changing one file writes
 *     one object.
 *
 * Every reader of a version's bytes asks `versionObjectKey`, so none of them
 * knows which layout it is reading. `wiring.test.js` holds that.
 */

/** Every attempt owns its objects before Firestore chooses the winning version. */
export function newBundlePrefix(docId: string): string {
  if (!safeSegment(docId)) throw new Error("invalid document storage id");
  return `docs/${docId}/bundles/${randomUUID()}`;
}

/** Older records use the version path; newer records name their immutable upload. */
export function versionStoragePrefix(docId: string, versionId: string, record: { storagePrefix?: unknown }): string {
  if (!safeSegment(docId) || !safeSegment(versionId)) throw new Error("invalid version storage id");
  const prefix = record.storagePrefix ?? `docs/${docId}/${versionId}`;
  if (typeof prefix !== "string" || safeRelPath(prefix) !== prefix || !prefix.startsWith(`docs/${docId}/`)) {
    throw new Error("invalid version storage prefix");
  }
  return prefix;
}

/** Saves never share an object path, even when their base version is the same. */
export function newDraftPrefix(docId: string): string {
  if (!safeSegment(docId)) throw new Error("invalid document storage id");
  return `docs/${docId}/drafts/${randomUUID()}`;
}

/** Legacy drafts have a fixed prefix; new saves carry their own pointer. */
export function draftStoragePrefix(docId: string, draft: { storagePrefix?: unknown }): string {
  const prefix = draft.storagePrefix ?? `docs/${docId}/draft`;
  if (!safeSegment(docId) || typeof prefix !== "string" || safeRelPath(prefix) !== prefix ||
      !(prefix === `docs/${docId}/draft` || prefix.startsWith(`docs/${docId}/drafts/`))) {
    throw new Error("invalid draft storage prefix");
  }
  return prefix;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The one object holding these bytes for this document. */
export function blobKey(docId: string, sha256: string): string {
  if (!safeSegment(docId) || !SHA256_HEX.test(sha256)) throw new Error("invalid stored file");
  return `docs/${docId}/blobs/${sha256}`;
}

/** The fields a version record carries when its files are stored once per document. */
export interface StoredVersionFields {
  layout?: unknown;
  storagePrefix?: unknown;
  files?: unknown;
  hashes?: unknown;
  sizes?: unknown;
}

/** One file of a version, where its bytes are, and what they are when the record says. */
export interface VersionFile {
  rel: string;
  key: string;
  size?: number;
  sha256?: string;
}

/** True for a version whose files are stored once per document. */
export function isStoredLayout(record: StoredVersionFields): boolean {
  return record.layout === "blobs";
}

/**
 * The files a stored-layout record lists, checked: three arrays of one length,
 * safe paths, no path twice, real digests and sizes. A record that fails is
 * treated as having no files, so nothing outside its document can be named.
 */
export function storedFiles(docId: string, record: StoredVersionFields): VersionFile[] {
  const { files, hashes, sizes } = record;
  if (!Array.isArray(files) || !Array.isArray(hashes) || !Array.isArray(sizes)) return [];
  if (files.length !== hashes.length || files.length !== sizes.length) return [];
  const out: VersionFile[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < files.length; i += 1) {
    const rel = typeof files[i] === "string" ? safeBundleRelPath(files[i]) : null;
    const sha256 = hashes[i];
    const size = sizes[i];
    if (!rel || seen.has(rel) || typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) return [];
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return [];
    seen.add(rel);
    out.push({ rel, key: blobKey(docId, sha256), size, sha256 });
  }
  return out;
}

/**
 * The object holding `rel` in this version, or null when the version has no
 * such file. A prefix version answers a key whether or not the object exists,
 * as it always has; the caller's read finds out. A stored version answers
 * from its record, so a file it does not list costs no Storage call.
 */
export function versionObjectKey(
  docId: string,
  versionId: string,
  record: StoredVersionFields,
  rel: string,
): string | null {
  if (isStoredLayout(record)) {
    return storedFiles(docId, record).find((f) => f.rel === rel)?.key ?? null;
  }
  return `${versionStoragePrefix(docId, versionId, record)}/${rel}`;
}

/**
 * What names this version's bytes in Storage: its prefix, or, for a stored
 * version, the document's stored files. Part of a kept reading's name, beside
 * the content hash (ADR 0033).
 */
export function versionStorageIdentity(docId: string, versionId: string, record: StoredVersionFields): string {
  if (isStoredLayout(record)) {
    if (!safeSegment(docId)) throw new Error("invalid document storage id");
    return `docs/${docId}/blobs`;
  }
  return versionStoragePrefix(docId, versionId, record);
}

/** The subset of a bucket listing a version's files. */
export interface ListingBucket {
  getFiles(query: { prefix: string }): Promise<[Array<{ name: string; metadata?: { size?: unknown } }>, ...unknown[]]>;
}

/**
 * Every file of a version, with its key, without reading any bytes: from the
 * record for a stored version, from a listing of its prefix otherwise.
 */
export async function versionFiles(
  docId: string,
  versionId: string,
  record: StoredVersionFields,
  bucket: ListingBucket,
): Promise<VersionFile[]> {
  if (isStoredLayout(record)) return storedFiles(docId, record);
  const prefix = `${versionStoragePrefix(docId, versionId, record)}/`;
  const [objects] = await bucket.getFiles({ prefix });
  const out: VersionFile[] = [];
  for (const obj of objects) {
    const rel = obj.name.slice(prefix.length);
    if (rel.length === 0 || rel.endsWith("/")) continue;
    const size = Number(obj.metadata?.size);
    out.push({ rel, key: obj.name, ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}) });
  }
  return out;
}
