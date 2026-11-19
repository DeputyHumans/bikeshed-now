// SPDX-License-Identifier: Apache-2.0
// Large media go straight to Storage through a server-issued session, and are checked before a version names them (SPEC §2, §24, ADR 0038).

/**
 * Why sessions, and what keeps them honest
 * ----------------------------------------
 * A request body is capped at 25 MB here (Cloud Run allows 32 MiB, and Hosting
 * cuts a response at 60 s), and a film is 200. So a large file never passes
 * through a function. `POST /media` checks who is asking and what they mean to
 * send, then opens a resumable upload session on an object of the caller's
 * own, `staging/{uid}/{uuid}`, with its length and type declared and a
 * create-only precondition. The client sends the bytes straight to Storage;
 * Storage refuses more bytes than were declared and a second object at that
 * name. The session URL is a bearer secret, and is never logged.
 *
 * Nothing is trusted when the publish names the upload. Only the CALLER's own
 * staging objects can be named, its metadata must say this document, this
 * path and this size, it must be under a day old, its generation is pinned,
 * and its bytes are read once to hash them. Only then is it copied into the
 * document's stored files (SPEC §4) and named by the version.
 *
 * A staged object is never deleted when it is published: a lost
 * acknowledgement retries into `deduped`, and the bucket's lifecycle rule
 * removes staging objects a day after they were made. That rule, not a job,
 * is the cleanup, and the caps are what bound the missing rate limiter: one
 * session holds at most 200 MB, for at most a day, and writes nothing to
 * Firestore.
 */

import { createHash, randomUUID } from "node:crypto";
import * as mime from "mime-types";
import { MAX_MEDIA_FILE_BYTES, STAGING_TTL_MS } from "../config";
import { isLeftOut, MAX_PATH_BYTES, safeBundleRelPath } from "./bundle";
import { blobKey } from "./storage";
import type { ListedFile } from "./hash";

/** What may be staged: pictures, films and recordings. Never SVG, which is a document. */
export const STAGEABLE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif",
  "mp4", "m4v", "webm", "mov", "ogv",
  "mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac",
]);

export function isStageable(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && STAGEABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

const STAGING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function stagingKey(uid: string, stagingId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !STAGING_ID.test(stagingId)) throw new Error("invalid staging id");
  return `staging/${uid}/${stagingId}`;
}

/** The part of a Storage file staging uses, so a test can stand in for it. */
export interface StagingFile {
  createResumableUpload(options: Record<string, unknown>): Promise<[string, ...unknown[]]>;
  getMetadata(): Promise<[Record<string, unknown>, ...unknown[]]>;
  createReadStream(): NodeJS.ReadableStream;
  copy(destination: string, options: Record<string, unknown>): Promise<unknown>;
}
export interface StagingBucket {
  file(name: string, options?: { generation?: number | string }): StagingFile;
}

/** What a session request may ask for, checked; or why not, in words. */
export function checkSessionRequest(body: Record<string, unknown>): { path: string; size: number; sha256: string | null } | { error: string } {
  const path = typeof body.path === "string" ? safeBundleRelPath(body.path) : null;
  if (!path) return { error: "path must be a relative path, such as video/intro.mp4" };
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) return { error: `the path is longer than ${MAX_PATH_BYTES} bytes` };
  if (isLeftOut(path)) return { error: `${path} would be left out of the document; rename it` };
  if (!isStageable(path)) {
    return { error: `${path}: only pictures, films and recordings go up on their own (${[...STAGEABLE_EXTENSIONS].join(", ")}); send the rest with the page` };
  }
  const size = body.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_FILE_BYTES) {
    return { error: `size must be the file's size in bytes, at most ${MAX_MEDIA_FILE_BYTES / 1024 / 1024} MB` };
  }
  const sha256 = body.sha256 === undefined ? null : body.sha256;
  if (sha256 !== null && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))) return { error: "sha256 must be 64 lowercase hex digits" };
  return { path, size, sha256 };
}

/**
 * Open a resumable session for one file. `origin` is the deployment's own for
 * a browser, so Storage answers its CORS check, and null for a token; it is
 * never taken from the request.
 */
export async function openSession(args: {
  bucket: StagingBucket;
  uid: string;
  docId: string | null;
  path: string;
  size: number;
  origin: string | null;
  now?: number;
}): Promise<{ stagingId: string; uploadUrl: string; expiresAt: number }> {
  const stagingId = randomUUID();
  const issued = args.now ?? Date.now();
  const [uploadUrl] = await args.bucket.file(stagingKey(args.uid, stagingId)).createResumableUpload({
    metadata: {
      contentType: mime.lookup(args.path) || "application/octet-stream",
      // Declared, so Storage refuses a byte more than this.
      contentLength: args.size,
      metadata: { doc: args.docId ?? "", path: args.path, size: String(args.size), issued: String(issued) },
    },
    ...(args.origin ? { origin: args.origin } : {}),
    preconditionOpts: { ifGenerationMatch: 0 },
  });
  return { stagingId, uploadUrl, expiresAt: issued + STAGING_TTL_MS };
}

/** A staged upload, checked and hashed, ready to be stored and named. */
export interface StagedFile extends ListedFile {
  key: string;
  generation: string;
}

/**
 * Check and hash each named upload of the CALLER's own, for `docId` (null for
 * a document not made yet). Refuses, naming the upload, anything that is not
 * exactly what its session declared.
 */
export async function readStaged(args: {
  bucket: StagingBucket;
  uid: string;
  docId: string | null;
  stagingIds: readonly string[];
  now?: number;
}): Promise<{ files: StagedFile[] } | { error: string; staging: string }> {
  const now = args.now ?? Date.now();
  const files: StagedFile[] = [];
  for (const id of args.stagingIds) {
    if (!STAGING_ID.test(id)) return { error: "that is not a staging id", staging: id };
    const key = stagingKey(args.uid, id);
    let meta: Record<string, unknown>;
    try {
      [meta] = await args.bucket.file(key).getMetadata();
    } catch {
      return { error: "that upload is not there: it was never finished, or it is more than a day old", staging: id };
    }
    const own = (meta.metadata ?? {}) as Record<string, unknown>;
    const rel = typeof own.path === "string" ? safeBundleRelPath(own.path) : null;
    const size = Number(meta.size);
    const declared = Number(own.size);
    const made = Date.parse(String(meta.timeCreated ?? ""));
    if (own.doc !== (args.docId ?? "")) return { error: "that upload was made for another document", staging: id };
    if (!rel || !isStageable(rel)) return { error: "that upload has no usable path", staging: id };
    if (!Number.isSafeInteger(size) || size !== declared || size > MAX_MEDIA_FILE_BYTES) {
      return { error: `${rel} did not finish: ${size} of ${declared} bytes arrived`, staging: id };
    }
    if (!Number.isFinite(made) || now - made > STAGING_TTL_MS) return { error: `the upload of ${rel} is more than a day old; send it again`, staging: id };
    const generation = String(meta.generation ?? "");
    if (!generation) return { error: "that upload has no generation", staging: id };

    // Read once, at the generation checked above, so what is hashed is what
    // was checked, whatever happens at that name meanwhile.
    const hash = createHash("sha256");
    let seen = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = args.bucket.file(key, { generation }).createReadStream();
      stream.on("data", (chunk: Buffer) => { seen += chunk.length; hash.update(chunk); });
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    if (seen !== size) return { error: `${rel} changed while it was read`, staging: id };
    files.push({ rel, size, sha256: hash.digest("hex"), key, generation });
  }
  return { files };
}

/** Copy checked uploads into a document's stored files, once each, create-only. */
export async function storeStaged(bucket: StagingBucket, docId: string, files: readonly StagedFile[]): Promise<void> {
  const done = new Set<string>();
  for (const f of files) {
    if (done.has(f.sha256)) continue;
    done.add(f.sha256);
    try {
      await bucket.file(f.key, { generation: f.generation }).copy(blobKey(docId, f.sha256), {
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (e) {
      if ((e as { code?: unknown }).code !== 412) throw e;
    }
  }
}
