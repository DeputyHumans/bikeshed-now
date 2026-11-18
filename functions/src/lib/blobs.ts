// SPDX-License-Identifier: Apache-2.0
// A version's file list, and each file's bytes stored once per document (SPEC §4, §9.1, ADR 0036).

/**
 * Why a version is a list
 * -----------------------
 * A version used to be a prefix holding a full copy of every file, so changing
 * one picture in a deck read every file back, wrote every file again and kept
 * a second copy of each. Now each file's bytes are stored once for the whole
 * document, under their SHA-256, and a version records which file sits at
 * which path. A version that changes one file writes one object, and the
 * files it carries over are named, not read (SPEC §4).
 *
 * The content hash follows: v2 is computed from the list, so minting reads
 * nothing it does not write (SPEC §9.1). "Identical bytes mint no version"
 * still holds: identical bytes are an identical list.
 *
 * Writes are create-only. A 412 means those exact bytes are already stored,
 * which is the point, so it is success. Nothing here ever deletes: two
 * versions, or two concurrent publishes, may share any object.
 */

import * as admin from "firebase-admin";
import * as mime from "mime-types";
import { bucketName } from "../config";
import {
  byPath,
  hashBundleFiles,
  hashBundleListing,
  sha256Hex,
  type BundleHash,
  type ListedFile,
} from "./hash";
import { blobKey, isStoredLayout, storedFiles, versionStoragePrefix, type StoredVersionFields } from "./storage";

/** A file going into a new version: bytes in hand, or a stored file carried by its entry. */
export type NextFile = { rel: string; data: Buffer } | ListedFile;

export function inHand(f: NextFile): f is { rel: string; data: Buffer } {
  return "data" in f && Buffer.isBuffer(f.data);
}

/** A file's size, whether its bytes are in hand or it is carried. */
export function sizeOf(f: NextFile): number {
  return inHand(f) ? f.data.length : f.size;
}

/** The list a version records: each file's size and SHA-256, in hash order. */
export function listingOf(files: readonly NextFile[]): ListedFile[] {
  return files
    .map((f) => (inHand(f) ? { rel: f.rel, size: f.data.length, sha256: sha256Hex(f.data) } : { rel: f.rel, size: f.size, sha256: f.sha256 }))
    .sort(byPath);
}

/** What a stored-layout version record holds about its files. */
export interface StoredRecord extends BundleHash {
  layout: "blobs";
  files: string[];
  hashes: string[];
  sizes: number[];
  hashVersion: 2;
  /** This attempt's own id, so a retried transaction can recognise its own commit. */
  attempt: string;
}

export function storedRecord(listing: readonly ListedFile[], attempt: string): StoredRecord {
  return {
    layout: "blobs",
    files: listing.map((f) => f.rel),
    hashes: listing.map((f) => f.sha256),
    sizes: listing.map((f) => f.size),
    ...hashBundleListing(listing),
    hashVersion: 2,
    attempt,
  };
}

/** The part of a bucket that stores files, so a test or a fork can stand in for it. */
export interface StoreBucket {
  file(name: string): { save(data: Buffer, options: Record<string, unknown>): Promise<unknown> };
}

function defaultBucket(): StoreBucket {
  return admin.storage().bucket(bucketName()) as unknown as StoreBucket;
}

function isPreconditionFailure(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 412;
}

/**
 * Store the bytes of every file in hand, once each, create-only. Files carried
 * by their entry are already stored. Returns how many objects were written.
 */
export async function storeFiles(
  docId: string,
  files: readonly NextFile[],
  bucket: StoreBucket = defaultBucket(),
): Promise<number> {
  const seen = new Set<string>();
  let written = 0;
  for (const f of files) {
    if (!inHand(f)) continue;
    const sha256 = sha256Hex(f.data);
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    try {
      await bucket.file(blobKey(docId, sha256)).save(f.data, {
        // Serving reads the type from the path asked for, never from here;
        // this is for whoever browses the bucket.
        contentType: mime.lookup(f.rel) || "application/octet-stream",
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      });
      written += 1;
    } catch (e) {
      if (!isPreconditionFailure(e)) throw e;
    }
  }
  return written;
}

/** The bucket reads a prefix-layout base needs. */
export interface ReadBucket {
  getFiles(query: { prefix: string }): Promise<[Array<{ name: string; download(): Promise<[Buffer, ...unknown[]]> }>, ...unknown[]]>;
}

/**
 * The files of the version a new one is laid over. A stored version's are its
 * list, and nothing is read. A prefix version's are read whole, once: it was
 * published under the 25 MB cap, and the version minted over it stores them,
 * after which this document is never read this way again.
 */
export async function baseFilesOf(
  docId: string,
  versionId: string,
  record: StoredVersionFields,
  bucket: ReadBucket = admin.storage().bucket(bucketName()) as unknown as ReadBucket,
): Promise<NextFile[]> {
  if (isStoredLayout(record)) {
    return storedFiles(docId, record).map((f) => ({ rel: f.rel, size: f.size ?? 0, sha256: f.sha256 ?? "" }));
  }
  const prefix = `${versionStoragePrefix(docId, versionId, record)}/`;
  const [objects] = await bucket.getFiles({ prefix });
  const out: NextFile[] = [];
  for (const obj of objects) {
    const rel = obj.name.slice(prefix.length);
    if (rel.length === 0 || rel.endsWith("/")) continue;
    const [data] = await obj.download();
    out.push({ rel, data });
  }
  return out;
}

/**
 * True when a new version would hold exactly the bytes the head holds, so
 * none is minted. A v2 head compares list hashes. A v1 head is compared by
 * its own framing, over the bytes, which are all in hand whenever the head is
 * a prefix version: what the new version carries was read from it.
 */
export function sameAsHead(
  head: { contentHash?: unknown; hashVersion?: unknown } | undefined,
  files: readonly NextFile[],
  listing: readonly ListedFile[],
): boolean {
  if (!head || typeof head.contentHash !== "string" || !head.contentHash) return false;
  if (head.hashVersion === 2) return hashBundleListing(listing).contentHash === head.contentHash;
  if (!files.every(inHand)) return false;
  return hashBundleFiles(files as { rel: string; data: Buffer }[]).contentHash === head.contentHash;
}

/** How a new list differs from the one it replaces, for "1 file changed, 23 unchanged". */
export interface FileChanges {
  changed: number;
  unchanged: number;
  removed: number;
}

export function changesFrom(base: readonly ListedFile[] | null, next: readonly ListedFile[]): FileChanges | undefined {
  if (!base) return undefined;
  const before = new Map(base.map((f) => [f.rel, f.sha256]));
  let unchanged = 0;
  for (const f of next) if (before.get(f.rel) === f.sha256) unchanged += 1;
  const after = new Set(next.map((f) => f.rel));
  const removed = base.filter((f) => !after.has(f.rel)).length;
  return { changed: next.length - unchanged, unchanged, removed };
}

/** The list a head records, when it records one; a prefix head's is not known without reading. */
export function headListing(docId: string, record: StoredVersionFields | undefined): ListedFile[] | null {
  if (!record || !isStoredLayout(record)) return null;
  return storedFiles(docId, record).map((f) => ({ rel: f.rel, size: f.size ?? 0, sha256: f.sha256 ?? "" }));
}

/**
 * Refuse to mint a version that names a stored file an operator is deleting
 * right now (SPEC §4). The withdrawal script marks what it will delete, in the
 * transaction that reads every other version, before it deletes anything. A
 * version minted after the mark may not use those files; one minted before it
 * was read by that transaction, and keeps them.
 *
 * The mark lapses on its own (`until`, an hour), so a run that dies before
 * clearing it holds nothing back for long. A later run reads every version
 * again, so the lapse never lets it delete what a newer version names.
 */
export function assertNotWithdrawing(
  doc: Record<string, unknown> | undefined,
  listing: readonly ListedFile[],
  now: number = Date.now(),
): void {
  const mark = doc?.withdrawing as { hashes?: unknown; until?: unknown } | undefined;
  if (!mark || !Array.isArray(mark.hashes) || typeof mark.until !== "number" || mark.until <= now) return;
  const doomed = new Set(mark.hashes.filter((m): m is string => typeof m === "string"));
  if (listing.some((f) => doomed.has(f.sha256))) throw new Error("WITHDRAWING");
}

/** What a refused mint tells its caller while a withdrawal is running. */
export const WITHDRAWING_MESSAGE =
  "A version of this document is being withdrawn and one of its files is being deleted. Try again in a minute.";
